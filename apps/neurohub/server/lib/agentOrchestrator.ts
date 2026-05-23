// Eugene 2026-05-23 Босс «Оркестратор нужен всеми компаниями агентами начать
// в проекте — коде». Central agent registry + visibility layer.
//
// Что это:
//  - Не unified messaging API (не заменяет existing endpoints).
//  - Не RPC между agents.
//  - Лёгкий in-memory registry + activity tracking + healthCheck dispatcher.
//
// Зачем:
//  1) Single source-of-truth «кто такой agent в проекте» — list всех каналов,
//     персон, watchdog'ов, cron'ов в одном месте.
//  2) Видимость в admin/v304 → 🤖 Оркестратор: кто живой, кто молчит, кто
//     not_configured (нет ENV-ключа), кто упал на последнем health check.
//  3) Расширяемость: новый канал (VK / WhatsApp / SIP-calls / email-inbound) —
//     одна register-строка + опционально one-line recordActivity hook.
//
// Persona vs Agent (см. Single-persona-across-channels rule в CLAUDE.md):
//  - Agent = логическая роль (Музa в TG = 1 agent).
//  - Persona = маска (Аня/Татьяна/Мария/Ольга — 4 persona одной Музы-агента).
//  - Один agent может иметь persona_key с pipe-separated alternatives.
//
// Что НЕ делает (anti-pattern):
//  - Не дублирует state (existing endpoints продолжают работать как раньше).
//  - Не задерживает request — recordActivity / healthCheck асинхронны.
//  - Не хранит секреты — только status / lastSeenAt / capabilities.

export type AgentChannel =
  | "web"        // muzaai.ru web-чат
  | "telegram"   // TG bot
  | "max"        // Max bot
  | "vk"         // VK community bot (планируется)
  | "email"      // email inbound/outbound
  | "voice"      // voice TTS / STT
  | "admin"      // admin-voice / admin-internal
  | "cron"       // periodic watchdog / scheduler
  | "internal";  // утилитарные сервисы (api-health, yars-detector, ...)

export type AgentRole =
  | "consultant"   // диалоговый помощник (Музa et al)
  | "watchdog"     // мониторинг и алерты
  | "moderator"    // фильтры / pre-flight / yars-detect
  | "broadcaster"  // outbound notifications
  | "diagnostic"   // health/probe сервисы
  | "tool";        // утилитарные internal сервисы

export type AgentStatus =
  | "active"          // запущен, ENV в порядке, ходит трафик
  | "paused"          // запущен, но временно отключён (feature flag)
  | "error"           // последний health check / activity = fail
  | "not_configured"; // нет ENV-ключа / зависимости

export interface AgentDescriptor {
  /** Уникальный id. Convention: "<persona-or-role>-<channel>" e.g. "muza-web", "muza-tg", "watchdog-suno". */
  id: string;
  /** Display name для admin UI. */
  name: string;
  channel: AgentChannel;
  role: AgentRole;
  /**
   * Persona key(s) если agent persona-driven. Pipe-separated если несколько
   * (e.g. "anya|tatyana|maria|olga" для TG multi-persona).
   */
  persona_key?: string;
  status: AgentStatus;
  /** Что agent умеет: "chat", "tool_call", "voice", "post", "search", "metrics", ... */
  capabilities: string[];
  /** Когда последний раз была активность (millis). */
  lastSeenAt?: number;
  /** Свободное поле для plugin-specific данных. */
  metadata?: Record<string, unknown>;
  /** Optional health probe — выполняется по запросу admin'а / cron'а. */
  healthCheck?: () => Promise<{ ok: boolean; details?: unknown }>;
}

export interface HealthCheckResult {
  ok: boolean;
  details?: unknown;
  durationMs: number;
  checkedAt: number;
}

export class AgentOrchestrator {
  private agents = new Map<string, AgentDescriptor>();
  private healthCache = new Map<string, HealthCheckResult>();

  /** Регистрирует agent. Повторный register с тем же id — обновляет (idempotent). */
  register(agent: AgentDescriptor): void {
    if (!agent.id || typeof agent.id !== "string") {
      throw new Error("[orchestrator] agent.id is required");
    }
    this.agents.set(agent.id, { ...agent });
  }

  unregister(id: string): boolean {
    this.healthCache.delete(id);
    return this.agents.delete(id);
  }

  byId(id: string): AgentDescriptor | undefined {
    return this.agents.get(id);
  }

  list(filter?: Partial<Pick<AgentDescriptor, "channel" | "role" | "status">>): AgentDescriptor[] {
    const items = Array.from(this.agents.values());
    if (!filter) return items;
    return items.filter(a => {
      if (filter.channel && a.channel !== filter.channel) return false;
      if (filter.role && a.role !== filter.role) return false;
      if (filter.status && a.status !== filter.status) return false;
      return true;
    });
  }

  byChannel(channel: AgentChannel): AgentDescriptor[] {
    return this.list({ channel });
  }

  byRole(role: AgentRole): AgentDescriptor[] {
    return this.list({ role });
  }

  /**
   * Возвращает первого active agent по каналу — наивный routing.
   * Не используется для actual message routing (each channel handler сам знает
   * куда class'ить трафик), но полезен для UI hint'ов.
   */
  routeMessage(input: { channel: AgentChannel; userId?: number; sessionId: string; text?: string }): AgentDescriptor | null {
    const candidates = this.list({ channel: input.channel, status: "active" });
    if (candidates.length === 0) return null;
    // Persona-driven каналы (TG multi-persona) — выбор делается на уровне
    // channel handler через hash(userId). Здесь — просто первый active.
    return candidates[0];
  }

  /**
   * Touch on activity. Lightweight, sync, never throws.
   * Вызывается из channel handler'ов после успешного reply / tool call / tick.
   */
  recordActivity(agentId: string, meta?: Record<string, unknown>): void {
    try {
      const agent = this.agents.get(agentId);
      if (!agent) return;
      agent.lastSeenAt = Date.now();
      // Auto-recover: если был "error", но прилетел успешный activity — переводим в "active"
      if (agent.status === "error") {
        agent.status = "active";
      }
      if (meta) {
        agent.metadata = { ...(agent.metadata || {}), lastActivity: meta };
      }
    } catch {
      // never let registration tracking break callers
    }
  }

  /** Прямая установка статуса (например, после fail из channel handler). */
  setStatus(agentId: string, status: AgentStatus, error?: string): void {
    try {
      const agent = this.agents.get(agentId);
      if (!agent) return;
      agent.status = status;
      if (error) {
        agent.metadata = { ...(agent.metadata || {}), lastError: error, lastErrorAt: Date.now() };
      }
    } catch {}
  }

  /**
   * Запустить healthCheck для одного agent'а. Кеширует результат.
   * Если у agent'а нет healthCheck — возвращает { ok: true, details: "no-probe" }.
   */
  async runHealthCheck(agentId: string): Promise<HealthCheckResult> {
    const agent = this.agents.get(agentId);
    if (!agent) {
      return { ok: false, details: "unknown-agent", durationMs: 0, checkedAt: Date.now() };
    }
    if (!agent.healthCheck) {
      const result: HealthCheckResult = {
        ok: agent.status === "active",
        details: "no-probe (status-only)",
        durationMs: 0,
        checkedAt: Date.now(),
      };
      this.healthCache.set(agentId, result);
      return result;
    }
    const t0 = Date.now();
    try {
      const r = await agent.healthCheck();
      const result: HealthCheckResult = {
        ok: r.ok,
        details: r.details,
        durationMs: Date.now() - t0,
        checkedAt: Date.now(),
      };
      this.healthCache.set(agentId, result);
      // Sync со status — если healthCheck показал fail, выставим error.
      if (!r.ok && agent.status === "active") {
        agent.status = "error";
      } else if (r.ok && agent.status === "error") {
        agent.status = "active";
      }
      return result;
    } catch (e: unknown) {
      const result: HealthCheckResult = {
        ok: false,
        details: (e instanceof Error ? e.message : String(e)).slice(0, 200),
        durationMs: Date.now() - t0,
        checkedAt: Date.now(),
      };
      this.healthCache.set(agentId, result);
      if (agent.status === "active") agent.status = "error";
      return result;
    }
  }

  /** Запустить все healthCheck'и параллельно. */
  async healthCheckAll(): Promise<Record<string, HealthCheckResult>> {
    const ids = Array.from(this.agents.keys());
    const results = await Promise.all(ids.map(async id => [id, await this.runHealthCheck(id)] as const));
    return Object.fromEntries(results);
  }

  /** Последний закешированный результат healthCheck. */
  getLastHealth(agentId: string): HealthCheckResult | undefined {
    return this.healthCache.get(agentId);
  }

  /** Сводка для admin UI — counters по channel / role / status. */
  summary(): {
    total: number;
    byStatus: Record<AgentStatus, number>;
    byChannel: Record<string, number>;
    byRole: Record<string, number>;
  } {
    const items = this.list();
    const byStatus: Record<AgentStatus, number> = {
      active: 0,
      paused: 0,
      error: 0,
      not_configured: 0,
    };
    const byChannel: Record<string, number> = {};
    const byRole: Record<string, number> = {};
    for (const a of items) {
      byStatus[a.status] = (byStatus[a.status] || 0) + 1;
      byChannel[a.channel] = (byChannel[a.channel] || 0) + 1;
      byRole[a.role] = (byRole[a.role] || 0) + 1;
    }
    return { total: items.length, byStatus, byChannel, byRole };
  }
}

// Singleton instance — импортируется из любого места.
export const orchestrator = new AgentOrchestrator();

/**
 * Bootstrap default agents на старте сервера.
 * Вызывается один раз из server/index.ts после env-loader (чтобы process.env
 * был уже прочитан) и до registerRoutes.
 *
 * Status определяется presence-проверкой ENV-ключей. Это lightweight:
 * "ключ есть → active, нет → not_configured". Реальный healthCheck (живой
 * ли провайдер) — отдельный layer (см. plugins/api-health).
 */
export function bootstrapDefaultAgents(): void {
  const env = process.env;
  const hasAnthropic = !!(env.ANTHROPIC_API_KEY || env.ANTHROPIC_API_KEY_BACKUP || env.ANTHROPIC_API_KEY_BOT);
  const hasLLM = hasAnthropic || !!env.DEEPSEEK_API_KEY || !!env.TIMEWEB_GATEWAY_KEY || !!env.GPTUNNEL_API_KEY;

  // Музa web-chat — основной consultant
  orchestrator.register({
    id: "muza-web",
    name: "Музa (web)",
    channel: "web",
    role: "consultant",
    persona_key: "muza",
    status: hasLLM ? "active" : "not_configured",
    capabilities: ["chat", "tool_call", "voice", "memory"],
  });

  // Музa Telegram multi-persona
  orchestrator.register({
    id: "muza-tg",
    name: "Музa (Telegram)",
    channel: "telegram",
    role: "consultant",
    persona_key: "anya|tatyana|maria|olga",
    status: env.TELEGRAM_BOT_TOKEN ? "active" : "not_configured",
    capabilities: ["chat", "kb", "voice"],
  });

  // Музa Max bot
  orchestrator.register({
    id: "muza-max",
    name: "Музa (Max)",
    channel: "max",
    role: "consultant",
    persona_key: "muza",
    status: env.MAX_BOT_TOKEN ? "active" : "not_configured",
    capabilities: ["chat"],
  });

  // Музa VK (создаётся параллельным subagent'ом — register placeholder)
  orchestrator.register({
    id: "muza-vk",
    name: "Музa (VK)",
    channel: "vk",
    role: "consultant",
    persona_key: "muza",
    status: env.VK_ACCESS_TOKEN ? "active" : "not_configured",
    capabilities: ["chat"],
  });

  // Voice / TTS (Yandex SpeechKit для admin-voice FAB + Музa TTS)
  orchestrator.register({
    id: "muza-voice",
    name: "Музa Voice (TTS/STT)",
    channel: "voice",
    role: "consultant",
    persona_key: "muza",
    status: env.YANDEX_SPEECHKIT_API_KEY ? "active" : "not_configured",
    capabilities: ["voice", "stt", "tts"],
  });

  // Admin voice FAB (Босс говорит → Музa выполняет admin actions)
  orchestrator.register({
    id: "muza-admin",
    name: "Музa Admin (голос Босса)",
    channel: "admin",
    role: "consultant",
    persona_key: "muza",
    status: hasAnthropic && env.YANDEX_SPEECHKIT_API_KEY ? "active" : "not_configured",
    capabilities: ["chat", "tool_call", "voice", "operator"],
  });

  // Email channel (notifications outbound + inbound parsing)
  orchestrator.register({
    id: "channel-email",
    name: "Email канал",
    channel: "email",
    role: "broadcaster",
    status: (env.SMTP_PASS || env.GMAIL_APP_PASSWORD) ? "active" : "not_configured",
    capabilities: ["post", "transactional", "newsletter"],
  });

  // === Internal / cron / watchdog ===

  // Suno watchdog (polling generations, refund pipeline)
  orchestrator.register({
    id: "watchdog-suno",
    name: "Watchdog Suno",
    channel: "cron",
    role: "watchdog",
    status: env.GPTUNNEL_API_KEY ? "active" : "not_configured",
    capabilities: ["metrics", "alert", "refund"],
  });

  // API-health (nightly LLM key probes — 03:00 МСК)
  orchestrator.register({
    id: "watchdog-api-health",
    name: "Watchdog API-keys",
    channel: "cron",
    role: "diagnostic",
    status: "active",
    capabilities: ["metrics", "alert", "probe"],
  });

  // Yars detector (auto-tag operator commands in chat)
  orchestrator.register({
    id: "moderator-yars",
    name: "Yars-детектор",
    channel: "internal",
    role: "moderator",
    status: "active",
    capabilities: ["filter", "tag", "audit"],
  });

  // Channel watchdog (nightly test-drive ботов)
  orchestrator.register({
    id: "watchdog-channels",
    name: "Channel watchdog (nightly test-drive)",
    channel: "cron",
    role: "watchdog",
    status: "active",
    capabilities: ["metrics", "alert", "probe"],
  });
}

/**
 * Helper для plugin'ов — безопасное логирование activity. Свернёт ошибку,
 * не зависнет, не throw'нет. Use:
 *
 *   import { recordAgentActivity } from "@/lib/agentOrchestrator";
 *   recordAgentActivity("muza-web", { sessionId, userId });
 */
export function recordAgentActivity(agentId: string, meta?: Record<string, unknown>): void {
  orchestrator.recordActivity(agentId, meta);
}
