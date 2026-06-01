// Eugene 2026-05-23 Босс «Оркестратор нужен всеми компаниями агентами начать
// в проекте — коде». Central agent registry + visibility layer.
//
// Eugene 2026-05-24 Босс «Оркестратор переименуем Музa Директор. Он контролирует
// всех агентов, собирает всю информацию, итоговую докладывает через аудио».
// Display name везде в UI — «Музa Директор». Технический id и file name —
// orchestrator (backward compat).
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
  | "instagram"  // Instagram (@muzaairu) — Meta Graph API
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
  | "marketing"    // marketing-orchestrator (cross-channel campaigns, retargeting)
  | "tool";        // утилитарные internal сервисы

/**
 * Тип связи между agents. Описывает КАК один agent взаимодействует с другим.
 *
 *  - `pair-link`     — handoff context (web ↔ TG cross-channel session continuation)
 *  - `broadcast`     — marketing рассылка контента в каналы
 *  - `webhook`       — outbound HTTP call от agent A к каналу agent B
 *  - `notify`        — transactional notification (verify email / push)
 *  - `event`         — listen на event от agent A (EventBus subscription)
 *  - `campaign`      — marketing-orchestrator → channel agent (поставить контент)
 *  - `data-sync`     — обмен memory / user context между agents
 */
export type EdgeType =
  | "pair-link"
  | "broadcast"
  | "webhook"
  | "notify"
  | "event"
  | "campaign"
  | "data-sync";

export interface AgentEdge {
  from: string;
  to: string;
  type: EdgeType;
  /** Опциональный конфиг — например event-name, campaign-template, retry-policy. */
  config?: Record<string, unknown>;
  /** Когда edge зафиксирован (millis). */
  createdAt: number;
  /** Когда edge последний раз сработал (millis). */
  lastUsedAt?: number;
  /** Сколько раз сработал (debug counter). */
  usageCount?: number;
}

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

/**
 * Lightweight внутренний event-emitter — НЕ заменяет EventBus из core/.
 * EventBus (core/eventBus.ts) — для cross-plugin pub/sub с persisted events
 * в БД. Здесь — оrchestrator-only listeners для marketing/edge triggers
 * (например marketing-orchestrator слушает payment.succeeded чтобы запустить
 * post-purchase кампанию). Sync, in-memory, никаких side effects на disk.
 */
type OrchestratorListener = (payload: unknown) => void | Promise<void>;

export class AgentOrchestrator {
  private agents = new Map<string, AgentDescriptor>();
  private healthCache = new Map<string, HealthCheckResult>();
  private edges = new Map<string, AgentEdge>(); // key = `${from}::${to}::${type}`
  private listeners = new Map<string, OrchestratorListener[]>();

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

  // ========== EDGES (agent ↔ agent relationships) ==========

  /**
   * Регистрирует связь между двумя agents. Idempotent — повторный addEdge
   * с тем же (from, to, type) обновляет config + createdAt.
   *
   * Edge — описание ВОЗМОЖНОЙ связи, не RPC. Реальный трафик идёт через
   * существующие endpoints / EventBus / webhook handlers. Это для visualization
   * и admin observability — кто с кем общается, какие потоки данных есть.
   */
  addEdge(from: string, to: string, type: EdgeType, config?: Record<string, unknown>): void {
    if (!from || !to || !type) return;
    const key = `${from}::${to}::${type}`;
    const existing = this.edges.get(key);
    const edge: AgentEdge = {
      from,
      to,
      type,
      config: config ?? existing?.config,
      createdAt: existing?.createdAt ?? Date.now(),
      lastUsedAt: existing?.lastUsedAt,
      usageCount: existing?.usageCount ?? 0,
    };
    this.edges.set(key, edge);
  }

  /** Удалить edge. Возвращает true если был. */
  removeEdge(from: string, to: string, type: EdgeType): boolean {
    return this.edges.delete(`${from}::${to}::${type}`);
  }

  /**
   * Touch edge при реальном использовании — обновляет lastUsedAt + usageCount.
   * Never throws. Можно вызывать из любого hook'a.
   */
  recordEdgeUsage(from: string, to: string, type: EdgeType): void {
    try {
      const key = `${from}::${to}::${type}`;
      const edge = this.edges.get(key);
      if (!edge) return;
      edge.lastUsedAt = Date.now();
      edge.usageCount = (edge.usageCount || 0) + 1;
    } catch {}
  }

  /** Все edges (для admin UI graph view). */
  listEdges(): AgentEdge[] {
    return Array.from(this.edges.values());
  }

  /** Все edges связанные с agent (incoming + outgoing). */
  getEdges(agentId: string): { outgoing: AgentEdge[]; incoming: AgentEdge[] } {
    const all = Array.from(this.edges.values());
    return {
      outgoing: all.filter(e => e.from === agentId),
      incoming: all.filter(e => e.to === agentId),
    };
  }

  /**
   * Visualization — JSON-граф для admin UI. nodes = agents, links = edges.
   * Может рендериться как force-directed graph, как Mermaid diagram, или
   * как просто list (как в orchestrator-tab.tsx).
   */
  visualize(): {
    nodes: Array<{ id: string; name: string; channel: AgentChannel; role: AgentRole; status: AgentStatus }>;
    links: Array<{ source: string; target: string; type: EdgeType; usageCount: number }>;
  } {
    const nodes = Array.from(this.agents.values()).map(a => ({
      id: a.id,
      name: a.name,
      channel: a.channel,
      role: a.role,
      status: a.status,
    }));
    const links = Array.from(this.edges.values()).map(e => ({
      source: e.from,
      target: e.to,
      type: e.type,
      usageCount: e.usageCount || 0,
    }));
    return { nodes, links };
  }

  // ========== INTERNAL EVENT EMITTER (orchestrator-only) ==========

  /**
   * Подписаться на orchestrator-local событие. НЕ заменяет core/eventBus.ts —
   * это для marketing-orchestrator и edge-triggered hook'ов внутри agent layer.
   * Sync invoke. Errors swallowed (logged через console).
   */
  on(eventName: string, listener: OrchestratorListener): void {
    const arr = this.listeners.get(eventName) || [];
    arr.push(listener);
    this.listeners.set(eventName, arr);
  }

  /** Удалить listener. Идемпотентен. */
  off(eventName: string, listener: OrchestratorListener): void {
    const arr = this.listeners.get(eventName);
    if (!arr) return;
    const filtered = arr.filter(l => l !== listener);
    if (filtered.length === 0) this.listeners.delete(eventName);
    else this.listeners.set(eventName, filtered);
  }

  /**
   * Emit orchestrator-local событие. Fire-and-forget — listeners выполняются
   * async, errors не propagate'ятся. Если listener throw'ит — логирует в console
   * и идёт дальше.
   *
   * Standard event names (consumed by marketing-orchestrator):
   *  - `payment.succeeded`        { userId, amount, item, paymentId }
   *  - `generation.published`     { genId, userId, title, category }
   *  - `user.churned`             { userId, daysInactive }
   *  - `referral.bonus.given`     { referrerId, refereeId, amount }
   *  - `subscription.expired`     { userId, tier, expiredAt }
   *  - `user.registered`          { userId, channel }
   *  - `generation.milestone`     { userId, count }   (5-й, 10-й, 25-й трек etc.)
   */
  emitEvent(eventName: string, payload: unknown): void {
    const arr = this.listeners.get(eventName);
    if (!arr || arr.length === 0) return;
    for (const listener of arr) {
      try {
        const r = listener(payload);
        if (r && typeof (r as Promise<void>).then === "function") {
          (r as Promise<void>).catch(e => {
            console.warn(`[orchestrator] listener for ${eventName} failed:`, (e as Error)?.message || e);
          });
        }
      } catch (e) {
        console.warn(`[orchestrator] listener for ${eventName} threw:`, (e as Error)?.message || e);
      }
    }
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
 * Display name для UI / endpoint responses / voice greetings.
 * Технический термин «orchestrator» остаётся в коде / id'ах / URLs,
 * но Босс и админы видят «Музa Директор».
 */
export const DIRECTOR_NAME = "Музa Директор";
export const DIRECTOR_SHORT = "Директор";

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

  // Instagram (@muzaairu) — публикации через Meta Graph API. Eugene 2026-05-25.
  // not_configured пока нет токена + Meta App Review (instagram_content_publish).
  orchestrator.register({
    id: "channel-instagram",
    name: "Instagram (@muzaairu)",
    channel: "instagram",
    role: "broadcaster",
    status: (env.INSTAGRAM_ACCESS_TOKEN && env.INSTAGRAM_BUSINESS_ACCOUNT_ID) ? "active" : "not_configured",
    capabilities: ["post"],
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

  // Eugene 2026-05-24 Босс «назначь агента который отслеживает цикл от
  // нажатия генерации, исправляет ошибки. Дай возможность продавливать
  // Suno до генерации». GenerationLifecycleAgent — единый watchdog для
  // gen-lifecycle (music/lyrics/cover): tracking + auto-retry + escalation.
  // См. lib/genLifecycleAgent.ts + Gen-lifecycle agent rule в CLAUDE.md.
  orchestrator.register({
    id: "gen-lifecycle",
    name: "Лайф-цикл генераций",
    channel: "internal",
    role: "watchdog",
    capabilities: [
      "lifecycle_tracking",  // trackEvent в memory + БД
      "auto_retry",          // retrySuno с 3-attempt backoff
      "stuck_detection",     // scanStuckGenerations > 5 мин
      "auto_recover",        // attemptAutoRecover для transient errors
      "escalation",          // escalate → marketing-orchestrator
      "alert",
    ],
    status: env.GPTUNNEL_API_KEY ? "active" : "not_configured",
    healthCheck: async () => {
      try {
        // Lazy import чтобы избежать циклической зависимости при boot
        const mod = await import("./genLifecycleAgent");
        const stats = mod.genLifecycleAgent.getStats();
        return {
          ok: stats.escalated < 10 && !stats.lastError,
          details: {
            totalTracked: stats.totalTracked,
            recovered: stats.recovered,
            escalated: stats.escalated,
            lastError: stats.lastError,
            lastScanAt: stats.lastScanAt,
          },
        };
      } catch (e: any) {
        return { ok: false, details: { error: e?.message || String(e) } };
      }
    },
    metadata: { brief: "Tracks gen lifecycle от создания до done/errored, auto-retry transient errors" },
  });

  // Eugene 2026-05-24 Босс «Агент Деньга» — cost tracking + profit analysis.
  // Per-user/per-track cost breakdown, chat attribution to last track, manual
  // override, tariff history. Read-only по умолчанию; manual override через
  // admin endpoint с requireAdmin + audit-log. См. lib/dengaAgent.ts.
  orchestrator.register({
    id: "denga",
    name: "Агент Деньга",
    channel: "internal",
    role: "diagnostic",
    status: "active",
    capabilities: [
      "cost_tracking",       // расчёт provider cost per gen из tariff_history
      "profit_analysis",     // revenue (gen.cost) − cost = profit
      "tariff_history",      // versioned provider tariffs
      "manual_override",     // admin вписывает custom cost для конкретной gen
      "chat_attribution",    // chat-to-track attribution (last track rule)
      "anonymous_tracking",  // отдельный bucket для anonymous chat cost
    ],
    healthCheck: async () => {
      try {
        const mod = await import("./dengaAgent");
        const stats = mod.getDengaAgentStats();
        return {
          ok: true,
          details: {
            cacheSize: stats.cacheSize,
            totalOverrides: stats.totalOverrides,
          },
        };
      } catch (e: any) {
        return { ok: false, details: { error: e?.message || String(e) } };
      }
    },
    metadata: { brief: "Cost/profit tracking per user/track + chat attribution + manual override" },
  });

  // Eugene 2026-05-25 Босс «заведи агента Ферзь — находит недостатки в работе
  // системы, узкие места. Докладывает Директору по запросу + ежедневно 04:00 МСК».
  // watchdog-агент аудита: собирает сигналы из существующих источников
  // (orchestrator health, user_action_failures, incidents, generations,
  // LLM key health, payments, db integrity) и приоритизирует находки.
  // См. lib/ferzAgent.ts + Director-subordination rule. Подчинён Директору.
  orchestrator.register({
    id: "ferz",
    name: "Ферзь (слабые места)",
    channel: "internal",
    role: "watchdog",
    status: "active",
    capabilities: ["audit", "metrics", "alert"],
    healthCheck: async () => {
      try {
        const mod = await import("./ferzAgent");
        return mod.ferzHealth();
      } catch (e: any) {
        return { ok: false, details: { error: e?.message || String(e) } };
      }
    },
    metadata: { brief: "Аудит слабых мест и узких мест системы → доклад Директору (по запросу + 04:00 МСК)" },
  });
  // Ферзь докладывает Директору о слабых местах и узких местах.
  orchestrator.addEdge("ferz", "muza-admin", "webhook", {
    purpose: "Доклад о слабых местах и узких местах системы Директору",
  });

  // Eugene 2026-05-25 security hardening: Агент Безопасность (id "security") —
  // watchdog, подчинён Директору. Собирает сигналы из существующих данных
  // (failed-login всплески, открытые инциденты, integrity БД) + свежесть
  // app-level бэкапа. См. lib/securityAgent.ts + lib/autoBackup.ts.
  orchestrator.register({
    id: "security",
    name: "Агент Безопасность",
    channel: "cron",
    role: "watchdog",
    status: "active",
    capabilities: ["metrics", "alert", "probe", "audit"],
    healthCheck: async () => {
      try {
        const mod = await import("./securityAgent");
        return mod.securityHealth();
      } catch (e: any) {
        return { ok: false, details: { error: e?.message || String(e) } };
      }
    },
    metadata: { brief: "Security-watchdog: всплески логинов, инциденты, целостность БД, свежесть бэкапа → Директор" },
  });
  orchestrator.addEdge("security", "muza-admin", "webhook", {
    purpose: "Алерты безопасности + свежесть бэкапа",
  });
  orchestrator.addEdge("security", "channel-email", "notify", {
    purpose: "Критические security-алерты",
  });

  // Eugene 2026-05-23 marketing-orchestrator. Cross-channel campaigns +
  // retargeting + content calendar + auto-triggers по event'ам. Связано с
  // существующими channels через edges (см. registerMarketingEdges ниже).
  orchestrator.register({
    id: "marketing-orchestrator",
    name: "Маркетинг-оркестратор",
    channel: "internal",
    role: "marketing",
    status: "active",
    capabilities: [
      "broadcast",            // cross-channel post (VK+TG+email+landing)
      "retargeting",          // segmentation + targeted campaigns
      "content-calendar",     // schedule
      "ab-testing",           // split-test variants
      "metrics",              // unified KPI dashboard
      "auto-trigger",         // event-driven campaigns (payment.succeeded etc)
      "channel-allocation",   // CAC/LTV-based budget distribution
    ],
    metadata: { brief: "Управляет cross-channel кампаниями MuzaAi" },
  });

  // Eugene 2026-05-25 Босс — balance-reminder + upsell агент (Шаг 3). Нуджит
  // юзеров с непотраченным бонусом/балансом. Запускается командой Босса
  // (director-tool) или daily-cron (gate BALANCE_REMINDER_ENABLED). Подчинён
  // Директору (Director-subordination rule).
  orchestrator.register({
    id: "balance-reminder",
    name: "Balance-reminder (upsell)",
    channel: "internal",
    role: "marketing",
    status: "active",
    capabilities: ["upsell", "email_nudge", "balance_reminder"],
    metadata: { brief: "Email-нудж юзерам с непотраченным бонусом/балансом, не генерили ≥3 дней" },
  });
  orchestrator.addEdge("balance-reminder", "channel-email", "broadcast", {
    purpose: "Balance/bonus reminder email → юзеры с непотраченным балансом",
  });

  // Eugene 2026-05-25 Босс «Агент Почтальон» — почтовый AI-робот. Подписки
  // (double opt-in), журнал согласий, one-click unsubscribe, suppress-list,
  // рассылка кампаний с маркировкой «реклама», AI-классификация входящих.
  // Подчинён Директору (Director-subordination rule): register + recordActivity
  // в путях (lib/postmanAgent) + healthCheck + edges (broadcast→email, webhook→admin).
  orchestrator.register({
    id: "postman",
    name: "Агент Почтальон",
    channel: "email",
    role: "broadcaster",
    status: (env.SMTP_PASS || env.GMAIL_APP_PASSWORD) ? "active" : "not_configured",
    capabilities: [
      "opt_in",            // double opt-in (подтверждение по ссылке)
      "consent_log",       // журнал согласий = доказательная база (152-ФЗ)
      "unsubscribe",       // one-click отписка (RFC 8058)
      "suppress_list",     // bounce/complaint/unsub перекрывают сегменты
      "campaign",          // рассылка с маркировкой «реклама» + List-Unsubscribe
      "inbound_classify",  // AI-классификация входящих (DeepSeek)
    ],
    metadata: { brief: "Email opt-in/consent/unsubscribe/campaigns — юр-чистая рассылка MuzaAi" },
    healthCheck: async () => {
      try {
        const mod = await import("./postmanAgent");
        const h = mod.postmanHealth();
        return { ok: h.ok, details: h.details };
      } catch (e: any) {
        return { ok: false, details: { error: e?.message || String(e) } };
      }
    },
  });
  // Почтальон рассылает через email-канал (broadcast).
  orchestrator.addEdge("postman", "channel-email", "broadcast", {
    purpose: "Outbound campaigns + double opt-in / unsubscribe confirmations",
  });
  // Алерты Директору (входящие жалобы / отписки / падение SMTP).
  orchestrator.addEdge("postman", "muza-admin", "webhook", {
    purpose: "Жалобы/негатив из входящих + рост отписок → Директор уведомляет Босса",
  });

  // Eugene 2026-05-25 Босс «Музa Директор — готовить рекламные кампании на
  // постоянной основе (креатив + генерация) + блок публикаций по датам».
  // Агент «Креатив-маркетинг» готовит черновики рекламы (status='prepared').
  // Ничего не публикуется без одобрения Босса. Подчинён Директору.
  orchestrator.register({
    id: "marketing-creative",
    name: "Креатив-маркетинг",
    channel: "internal",
    role: "marketing",
    status: hasLLM ? "active" : "not_configured",
    capabilities: ["creative", "generation", "campaign"],
    metadata: { brief: "Готовит черновики рекламного креатива по каналам → блок публикаций (одобрение Боссом)" },
    healthCheck: async () => ({ ok: hasLLM, details: "LLM-based creative" }),
  });
  // Креатив → marketing-orchestrator (поставка контента кампании).
  orchestrator.addEdge("marketing-creative", "marketing-orchestrator", "campaign", {
    purpose: "Черновики креатива → marketing-orchestrator (планирование кампаний)",
  });
  // Креатив → Директор (черновики на одобрение Боссу).
  orchestrator.addEdge("marketing-creative", "muza-admin", "webhook", {
    purpose: "Черновики кампаний на одобрение Боссу",
  });

  // Eugene 2026-05-26 Босс «Заведи агента маркетинга — отвечает за ВСЕ продажи
  // физикам и юрлицам, организует и управляет». Менеджер по продажам — верхний
  // координатор продаж: ставит задачи маркетинг-агентам, ведёт конверсию до
  // генерации (B2C через консультанта) и сделки с юрлицами (B2B через
  // corporate-manager). Подчинён Директору (Director-subordination rule).
  orchestrator.register({
    id: "sales-manager",
    name: "Менеджер по продажам (физлица + юрлица)",
    channel: "internal",
    role: "marketing",
    status: "active",
    capabilities: [
      "sales_b2c",          // продажи физлицам (через консультанта Музу)
      "sales_b2b",          // продажи юрлицам (через corporate-manager)
      "lead_to_generation", // доведение до генерации (конверсия)
      "campaign_control",   // постановка задач маркетинг-агентам
      "revenue_oversight",  // контроль выручки/конверсии (через Деньгу)
      "pipeline",           // воронка сделок физики/юрлица
    ],
    metadata: { brief: "Отвечает за ВСЕ продажи (физлица + юрлица): организует, управляет, доводит до генерации" },
  });
  // Управляет маркетинговыми агентами.
  orchestrator.addEdge("sales-manager", "marketing-orchestrator", "campaign", {
    purpose: "Постановка задач по кампаниям продаж (физики + юрлица)",
  });
  orchestrator.addEdge("sales-manager", "marketing-creative", "campaign", {
    purpose: "Заказ креатива под продающие кампании",
  });
  // B2C: продажи физлицам через консультанта Музу.
  orchestrator.addEdge("sales-manager", "muza-web", "notify", {
    purpose: "Продажи физлицам — доведение диалога до генерации",
  });
  // Конверсия до генерации (lifecycle) + выручка (Деньга) + рассылки (Почтальон).
  orchestrator.addEdge("sales-manager", "gen-lifecycle", "data-sync", {
    purpose: "Контроль конверсии лид → генерация",
  });
  orchestrator.addEdge("sales-manager", "denga", "data-sync", {
    purpose: "Выручка/конверсия/LTV для решений по продажам",
  });
  orchestrator.addEdge("sales-manager", "postman", "broadcast", {
    purpose: "Sales-рассылки физлицам и юрлицам (через Почтальона)",
  });
  // Отчёт Директору (для доклада Боссу).
  orchestrator.addEdge("sales-manager", "muza-admin", "notify", {
    purpose: "Отчёт по продажам → Директор докладывает Боссу",
  });

  // === B2B: менеджер корпоративных клиентов + данные ЮЛ (Eugene 2026-05-26) ===
  orchestrator.register({
    id: "corporate-manager",
    name: "Менеджер корпоративных клиентов",
    channel: "internal",
    role: "consultant",
    status: "active",
    capabilities: ["b2b", "kontur_lookup", "contract", "invoice", "registry"],
    metadata: { brief: "Регистрация ЮЛ по ИНН (Контур.Фокус), договоры, счета, баланс кабинета ЮЛ" },
  });
  orchestrator.register({
    id: "kontur-focus",
    name: "Контур.Фокус (данные ЮЛ)",
    channel: "internal",
    role: "tool",
    status: process.env.KONTUR_FOCUS_API_KEY ? "active" : "not_configured",
    capabilities: ["company_lookup", "inn_lookup"],
    metadata: { brief: "Подтягивает данные юрлица по ИНН/названию из Контур.Фокус" },
  });
  orchestrator.addEdge("sales-manager", "corporate-manager", "data-sync", {
    purpose: "B2B-продажи юрлицам",
  });
  orchestrator.addEdge("corporate-manager", "kontur-focus", "data-sync", {
    purpose: "Данные ЮЛ по ИНН",
  });
  orchestrator.addEdge("corporate-manager", "muza-admin", "notify", {
    purpose: "Отчёт по сделкам с юрлицами Директору",
  });

  // Durable-lite ядро (workflow) — Eugene 2026-05-28. Детерминированный backbone
  // сценариев (lyrics / track / certificate / card / gift) на SQLite. Доменные
  // команды регистрируются модулями через registerCommand(). См. lib/workflowCore.ts.
  orchestrator.register({
    id: "workflow-core",
    name: "Durable-lite ядро (workflow)",
    channel: "internal",
    role: "tool",
    status: "active",
    capabilities: ["workflow", "commands", "idempotency", "audit", "timeline"],
    metadata: {
      brief: "Детерминированное ядро сценариев: workflow-инстансы, команды, идемпотентность, аудит/таймлайн",
    },
  });
  orchestrator.addEdge("workflow-core", "muza-admin", "notify", {
    purpose: "Сбои/таймлайн workflow → Директор",
  });

  // Регистрируем edges между marketing-orchestrator и channels (см. matrix
  // в docs/AGENT-ORCHESTRATOR-PROPOSALS.md и Agent-orchestrator rule).
  registerDefaultEdges();

  // Eugene 2026-05-25 Босс «Муза должна владеть всей информацией, контролировать
  // ВСЕХ агентов». Мост: регистрируем 9 EventBus-агентов (plugins/agent-*) +
  // A1 Master в Директоре, чтобы он их ВИДЕЛ. Live-активность/здоровье
  // синхронизирует plugin agent-orchestrator-bridge (subscribes на
  // agent.action.executed/failed + a1.alert.agent_unhealthy).
  registerEventBusAgents();
}

/**
 * Eugene 2026-05-25 — Bridge #1. Регистрирует EventBus-агентов (plugins/agent-*)
 * в Директоре. id = `bus-<agentName>`. Статус "active" (они в bundle как плагины);
 * реальное здоровье обновляется через a1.alert.agent_unhealthy (bridge plugin).
 *
 * Маппинг agentName (из runAgentAction) → orchestrator id фиксирован как
 * `bus-${agentName}` — bridge plugin использует тот же префикс.
 */
export function registerEventBusAgents(): void {
  const busAgents: Array<{ name: string; title: string; role: AgentRole; brief: string }> = [
    { name: "lead-hunter", title: "Лид-хантер", role: "marketing", brief: "Скоринг новых лидов по UTM" },
    { name: "scout", title: "Скаут", role: "tool", brief: "Линкует анонимного лида к аккаунту" },
    { name: "welcome", title: "Welcome-серия", role: "broadcaster", brief: "3-step welcome email серия" },
    { name: "demo", title: "Демо-агент", role: "marketing", brief: "Демо-flow для новых юзеров" },
    { name: "onboarding", title: "Онбординг", role: "broadcaster", brief: "Гарантия first-track entitlement" },
    { name: "conversion", title: "Конверсия", role: "marketing", brief: "Наблюдает payment funnel" },
    { name: "referral", title: "Реферальный", role: "tool", brief: "Аудит реферальных бонусов" },
    { name: "retention", title: "Удержание (churn)", role: "marketing", brief: "Daily churn scan + retention.churn_alert" },
    { name: "content", title: "Контент-агрегатор", role: "diagnostic", brief: "Hourly aggregates plays/shares" },
  ];
  for (const a of busAgents) {
    orchestrator.register({
      id: `bus-${a.name}`,
      name: a.title,
      channel: "internal",
      role: a.role,
      status: "active",
      capabilities: ["event_driven", "agent_action"],
      metadata: { brief: a.brief, busAgent: a.name, system: "eventbus" },
    });
  }
  // A1 Master — контроллер EventBus-агентов (failure-rate monitor).
  orchestrator.register({
    id: "agent-a1-master",
    name: "A1 Master (контроллер агентов)",
    channel: "internal",
    role: "watchdog",
    status: "active",
    capabilities: ["agent_monitoring", "failure_rate", "alert"],
    metadata: { brief: "Watches all agent.action.* — alerts на unhealthy агентов (>50% fail/100)" },
  });

  // Eugene 2026-05-25 Босс «есть ли агент обратных реакций юзеров — передаёт ли
  // Директору». Регистрируем компоненты обратной связи как агентов Директора
  // (Director-subordination rule). recordActivity — через hooks в их путях.
  const feedbackAgents: Array<{ id: string; name: string; role: AgentRole; brief: string }> = [
    { id: "feedback-escalation", name: "Эскалации (негатив)", role: "moderator", brief: "Очередь негативных сообщений юзеров (escalation_queue)" },
    { id: "feedback-sentiment", name: "Анализ сообщений", role: "diagnostic", brief: "Sentiment/intent/topic каждого сообщения (message_analysis)" },
    { id: "feedback-nps", name: "NPS + предложения", role: "diagnostic", brief: "NPS-оценки + кластеризация suggestions (nps_log, client_suggestions)" },
    { id: "feedback-failures", name: "Сбои действий юзеров", role: "diagnostic", brief: "Реестр failed-действий (user_action_failures)" },
  ];
  for (const f of feedbackAgents) {
    orchestrator.register({
      id: f.id, name: f.name, channel: "internal", role: f.role,
      status: "active", capabilities: ["feedback_monitoring", "metrics"],
      metadata: { brief: f.brief, system: "feedback" },
    });
    // Обратная связь → Директор (он владеет реакциями юзеров).
    orchestrator.addEdge(f.id, "muza-admin", "event", { purpose: "user feedback → Директор (алерты/сводка)" });
  }

  // Eugene 2026-05-25 Босс «финансы и техподдержка тоже подчиняются Директору».
  // Денга (финансы) уже зарегистрирована выше. Техподдержка — agent_handoffs.
  orchestrator.register({
    id: "support",
    name: "Техподдержка",
    channel: "internal",
    role: "moderator",
    status: "active",
    capabilities: ["tickets", "handoff", "operator"],
    metadata: { brief: "Обращения в поддержку (agent_handoffs) — тикеты, эскалация оператору" },
  });
  orchestrator.addEdge("support", "muza-admin", "event", { purpose: "Тикеты поддержки → Директор" });
  orchestrator.addEdge("denga", "muza-admin", "data-sync", { purpose: "Финансы (PnL) → Директор" });

  // Eugene 2026-05-25 Босс «Директор уведомляет меня 03:00 и 14:00 МСК +
  // критические немедленно». Агент-дайджест собирает срез по всем направлениям.
  orchestrator.register({
    id: "director-digest",
    name: "Дайджест Директора",
    channel: "cron",
    role: "broadcaster",
    status: process.env.ADMIN_TELEGRAM_ID && process.env.TELEGRAM_BOT_TOKEN ? "active" : "not_configured",
    capabilities: ["digest", "daily_report", "critical_alert"],
    metadata: { brief: "Срез по всем направлениям Боссу в TG: 03:00/14:00 МСК + критическое немедленно" },
  });
  orchestrator.addEdge("director-digest", "muza-admin", "webhook", { purpose: "Дайджест + критические алерты Боссу в Telegram" });

  // Eugene 2026-05-25 Босс «по всем направлениям должен быть агент» (Рек 2).
  // payment-health — мониторит провал платежей (Robokassa). frontend-health —
  // runtime-ошибки страниц (client-errors ring). Подчинены Директору, с пробами.
  orchestrator.register({
    id: "payment-health",
    name: "Здоровье платежей",
    channel: "internal",
    role: "watchdog",
    status: "active",
    capabilities: ["payment_monitoring", "metrics", "alert"],
    metadata: { brief: "Мониторит fail-rate платежей за 24ч (Robokassa)" },
    healthCheck: async () => {
      try {
        const { db } = await import("../storage");
        const sqlite: any = (db as any).$client;
        const dayAgo = Date.now() - 24 * 3600_000;
        const row = sqlite.prepare(
          `SELECT SUM(CASE WHEN status='failed' THEN 1 ELSE 0 END) AS failed, COUNT(*) AS total
           FROM payments WHERE datetime(created_at) > datetime(?, 'unixepoch')`
        ).get(Math.floor(dayAgo / 1000)) as any;
        const total = Number(row?.total || 0);
        const failed = Number(row?.failed || 0);
        const failRate = total > 0 ? failed / total : 0;
        return { ok: failRate < 0.5, details: { total24h: total, failed24h: failed, failRate: +(failRate * 100).toFixed(1) } };
      } catch (e: any) {
        return { ok: false, details: { error: e?.message || String(e) } };
      }
    },
  });
  orchestrator.addEdge("payment-health", "muza-admin", "webhook", { purpose: "Алерт при росте провалов платежей" });

  orchestrator.register({
    id: "frontend-health",
    name: "Здоровье фронтенда",
    channel: "internal",
    role: "watchdog",
    status: "active",
    capabilities: ["client_errors", "metrics", "alert"],
    metadata: { brief: "Runtime-ошибки страниц (client-errors ring) за последний час" },
    healthCheck: async () => {
      try {
        const ring: Array<{ ts: string }> = (globalThis as any).__clientErrorsRing || [];
        const hourAgo = Date.now() - 3600_000;
        const recent = ring.filter(e => { const t = Date.parse(e.ts); return Number.isFinite(t) && t > hourAgo; }).length;
        return { ok: recent < 20, details: { errorsLastHour: recent, ringSize: ring.length } };
      } catch (e: any) {
        return { ok: false, details: { error: e?.message || String(e) } };
      }
    },
  });
  orchestrator.addEdge("frontend-health", "muza-admin", "webhook", { purpose: "Алерт при всплеске runtime-ошибок фронта" });

  // Eugene 2026-05-25 Босс «агент "фронт-тестер" — непрерывно тестирует фронт
  // глазами юзера, находит баги, записывает, докладывает Директору СО ССЫЛКОЙ
  // на страницу где баг, предлагает фикс, ведёт список». Подчинён Директору.
  // Реальные баги = client_errors (ErrorBoundary telemetry) + синтетика страниц.
  orchestrator.register({
    id: "frontend-qa",
    name: "Фронт-тестер",
    channel: "internal",
    role: "watchdog",
    status: "active",
    capabilities: ["audit", "metrics", "alert"],
    metadata: { brief: "Баги фронта глазами юзера (client_errors + синтетика) + ссылка + предложенный фикс" },
    healthCheck: async () => {
      try {
        const { frontendQaHealth } = await import("./frontendQaAgent");
        return frontendQaHealth();
      } catch (e: any) {
        return { ok: false, details: { error: e?.message || String(e) } };
      }
    },
  });
  orchestrator.addEdge("frontend-qa", "muza-admin", "webhook", { purpose: "Баги фронта + ссылки + предложенные фиксы Директору" });

  // Eugene 2026-05-26 Босс «агента Fab заведи — пусть отслеживает и Директору в
  // контроль». Мониторит плавающую Музу-FAB: показы/клики (consultant_*
  // telemetry → client_errors ring + journey) + рантайм-ошибки самого FAB.
  // recordAgentActivity("muza-fab") дёргается из client-telemetry endpoint
  // (/api/_client-error и journey) когда прилетают consultant-события.
  orchestrator.register({
    id: "muza-fab",
    name: "Музa-FAB (плавающая помощница)",
    channel: "internal",
    role: "watchdog",
    persona_key: "muza",
    status: "active",
    capabilities: ["impressions", "metrics", "alert"],
    metadata: { brief: "Здоровье и активность плавающей Музы-FAB: показы/клики + рантайм-ошибки виджета" },
    healthCheck: async () => {
      try {
        // FAB-специфичные рантайм-ошибки в client_errors ring за последний час.
        const ring: Array<{ ts: string; message?: string }> = (globalThis as any).__clientErrorsRing || [];
        const hourAgo = Date.now() - 3600_000;
        const fabErrors = ring.filter(e => {
          const t = Date.parse(e.ts);
          const m = String(e.message || "").toLowerCase();
          return Number.isFinite(t) && t > hourAgo && (m.includes("consultant") || m.includes("floating") || m.includes("fab") || m.includes("muza"));
        }).length;
        return { ok: fabErrors < 10, details: { fabErrorsLastHour: fabErrors } };
      } catch (e: any) {
        return { ok: false, details: { error: e?.message || String(e) } };
      }
    },
  });
  orchestrator.addEdge("muza-fab", "muza-admin", "webhook", { purpose: "Активность/сбои плавающей Музы-FAB Директору в контроль" });

  // Eugene 2026-05-25 Босс «создай агента "Бэк" — бэкенд-аналог Фрона. Находит
  // баги/рискованные места, лишнее (dead code), дубли (endpoints/функции),
  // группирует бэкенд по темам». Подчинён Директору. Только ДЕТЕКТ + доклад +
  // предложение — НЕ удаляет код сам (Pre-push critical review rule).
  // Скан репо (fs + regex) → self-migrating таблица backend_findings.
  orchestrator.register({
    id: "back-qa",
    name: "Бэк (бэкенд-аудит)",
    channel: "internal",
    role: "watchdog",
    status: "active",
    capabilities: ["audit", "dedupe", "metrics"],
    metadata: { brief: "Дубли маршрутов/функций, лишнее (мёртвый код), техдолг, группировка по темам → Директор" },
    healthCheck: async () => {
      try {
        const { backendQaHealth } = await import("./backendQaAgent");
        return backendQaHealth();
      } catch (e: any) {
        return { ok: false, details: { error: e?.message || String(e) } };
      }
    },
  });
  orchestrator.addEdge("back-qa", "muza-admin", "webhook", { purpose: "Находки бэкенда (дубли/лишнее/техдолг) + группировка по темам Директору" });

  // Edges: A1 Master наблюдает за всеми bus-агентами + алертит Директору.
  for (const a of busAgents) {
    orchestrator.addEdge("agent-a1-master", `bus-${a.name}`, "event", {
      purpose: "failure-rate monitoring (agent.action.executed/failed)",
    });
  }
  orchestrator.addEdge("agent-a1-master", "muza-admin", "webhook", {
    purpose: "a1.alert.agent_unhealthy → Директор помечает агента error + алерт Боссу",
  });
}

/**
 * Регистрация default edges (relationships). Idempotent — повторный вызов
 * перезаписывает config. См. matrix в docs/AGENT-ORCHESTRATOR-PROPOSALS.md.
 */
function registerDefaultEdges(): void {
  // ===== Marketing-orchestrator → channels (broadcast / campaign) =====
  orchestrator.addEdge("marketing-orchestrator", "channel-email", "broadcast", {
    purpose: "transactional + newsletter + re-engagement",
  });
  orchestrator.addEdge("marketing-orchestrator", "muza-tg", "broadcast", {
    purpose: "TG community post + DM auto-campaigns",
  });
  orchestrator.addEdge("marketing-orchestrator", "muza-vk", "broadcast", {
    purpose: "VK community wall post + DM",
  });
  orchestrator.addEdge("marketing-orchestrator", "muza-max", "broadcast", {
    purpose: "Max channel post + targeted DM",
  });
  orchestrator.addEdge("marketing-orchestrator", "muza-web", "campaign", {
    purpose: "Landing CMS news cards + in-chat sales triggers",
  });
  orchestrator.addEdge("marketing-orchestrator", "channel-instagram", "broadcast", {
    purpose: "Instagram (@muzaairu) посты кампаний (Meta Graph API)",
  });

  // ===== Marketing listens на events (auto-trigger campaigns) =====
  orchestrator.addEdge("muza-web", "marketing-orchestrator", "event", {
    purpose: "payment.succeeded, generation.published, generation.milestone",
  });
  orchestrator.addEdge("muza-tg", "marketing-orchestrator", "event", {
    purpose: "user.registered (TG channel), referral.bonus.given",
  });

  // ===== Cross-channel pair-link (user history) =====
  orchestrator.addEdge("muza-tg", "muza-web", "pair-link", {
    purpose: "TG → web magic-link с подгрузкой истории",
  });
  orchestrator.addEdge("muza-web", "muza-tg", "data-sync", {
    purpose: "Cross-channel conversation linking (один userId, один thread)",
  });
  orchestrator.addEdge("muza-max", "muza-web", "pair-link", {
    purpose: "Max → web cross-session",
  });

  // ===== Email notifications =====
  orchestrator.addEdge("muza-web", "channel-email", "notify", {
    purpose: "Email verification, password reset, payment receipts",
  });
  orchestrator.addEdge("watchdog-suno", "channel-email", "notify", {
    purpose: "Refund notifications, generation completion",
  });

  // ===== Watchdogs → admin notifications =====
  orchestrator.addEdge("watchdog-suno", "muza-admin", "webhook", {
    purpose: "Suno fail alerts, refund pipeline notifications",
  });
  orchestrator.addEdge("watchdog-api-health", "muza-admin", "webhook", {
    purpose: "API key health alerts (nightly 03:00 МСК)",
  });
  orchestrator.addEdge("watchdog-channels", "muza-admin", "webhook", {
    purpose: "Channel down alerts (TG/Max/VK)",
  });

  // ===== Voice ↔ channels =====
  orchestrator.addEdge("muza-voice", "muza-web", "webhook", {
    purpose: "TTS playback в web FAB",
  });
  orchestrator.addEdge("muza-voice", "muza-admin", "webhook", {
    purpose: "Admin voice commands STT",
  });

  // ===== Yars moderator =====
  orchestrator.addEdge("moderator-yars", "muza-admin", "event", {
    purpose: "Yars-command detection → admin queue",
  });

  // ===== Denga agent (Eugene 2026-05-24) =====
  // Поставляет per-user profit data для retargeting (high-LTV → premium upsell,
  // low-LTV → onboarding nudges).
  orchestrator.addEdge("denga", "marketing-orchestrator", "data-sync", {
    purpose: "Per-user profit/LTV → retargeting segments (high-LTV upsell, low-LTV onboarding)",
  });
  // Эскалация anomalies в admin (юзер платит мало но cost огромный = abuse / loss)
  orchestrator.addEdge("denga", "muza-admin", "webhook", {
    purpose: "Loss alerts — юзеры с profit < 0 (для admin review)",
  });

  // ===== Gen-lifecycle agent (Eugene 2026-05-24) =====
  // Эскалация неразрешимых ошибок генерации → marketing для apology email
  orchestrator.addEdge("gen-lifecycle", "marketing-orchestrator", "event", {
    events: ["gen.escalated", "gen.stuck", "gen.recovered"],
    purpose: "Эскалация неразрешимых ошибок генерации для marketing follow-up (apology email, retention campaign)",
  });
  // Алерты в admin (Музa Admin FAB) при stuck/escalated
  orchestrator.addEdge("gen-lifecycle", "muza-admin", "webhook", {
    purpose: "Stuck/escalated alerts — Музa уведомляет Босса голосом",
  });
  // Refund notifications через email канал
  orchestrator.addEdge("gen-lifecycle", "channel-email", "notify", {
    purpose: "Refund email после escalation (юзер видит «деньги вернули»)",
  });
}

/**
 * Helper для emit orchestrator-local события. Используется в hook'ах из
 * routes.ts / plugins после успешного processing. Never throws.
 *
 * Стандартные events:
 *  - emitOrchestratorEvent("payment.succeeded", { userId, amount, item, paymentId })
 *  - emitOrchestratorEvent("generation.published", { genId, userId, title })
 *  - emitOrchestratorEvent("user.registered", { userId, channel })
 *  - emitOrchestratorEvent("generation.milestone", { userId, count })
 *  - emitOrchestratorEvent("user.churned", { userId, daysInactive })
 *  - emitOrchestratorEvent("subscription.expired", { userId, tier })
 *  - emitOrchestratorEvent("referral.bonus.given", { referrerId, refereeId, amount })
 */
export function emitOrchestratorEvent(eventName: string, payload: unknown): void {
  try {
    orchestrator.emitEvent(eventName, payload);
  } catch (e) {
    console.warn(`[orchestrator] emit ${eventName} failed:`, (e as Error)?.message || e);
  }
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
