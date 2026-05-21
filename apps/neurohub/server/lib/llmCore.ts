// Eugene 2026-05-16 Босс «один мозг для всех каналов».
//
// Унифицированный LLM-call для Музы. До этого было 3+ параллельных пути:
//   1) routes.ts → callMuzaLLM       (web, с MUZA_TOOLS + WEB_CHAT_SALES_ENHANCEMENT)
//   2) telegram-bot/module.ts        (свой tryClaude + tryGPTunnel, БЕЗ tools)
//   3) max-bot/module.ts             (свой tryClaude + tryGPTunnel, БЕЗ tools)
//
// Из-за этого web-Муза = «пьяная 5-летка» (перегруженный prompt + RULE 1/2/3),
// telegram-Муза = «25-летняя девушка» (чистый prompt, но без tools).
//
// Здесь — ОДНА точка для всех каналов:
//   • Один system prompt (buildPersonaSystem + optional dynamicContext)
//   • Один набор MUZA_TOOLS (теперь и в TG, и в Max — get_balance, save_song_draft, …)
//   • Один tool-use loop (max 4 итерации)
//   • Одна цепочка ключей (ANTHROPIC_API_KEY → BACKUP → BOT)
//   • Один <user_message>...</user_message> prompt-injection guard
//   • Cross-channel history через loadHistoryForLLM (если sessionId есть)
//
// Состояние (token-stats / key-status / key-switch-events) — module-level
// синглтон, читается из routes.ts через геттеры ниже.
//
// Pre-edit analysis rule (CLAUDE.md): эта функция вызывается ТРЕМЯ
// canale (web POST /api/muza/chat, telegram webhook, max webhook). Любая
// правка должна быть совместима со всеми тремя. Не добавлять channel-specific
// логику внутри callUnifiedMuzaLLM — для этого есть opts.dynamicContext.

import { MUZA_TOOLS, executeTool, filterToolsForRole } from "./muzaTools";
import { buildPersonaSystem } from "./consultantPersona";
import { loadHistoryForLLM } from "./chatHistory";

// === Типы публичные ===

export type LLMChannel = "web" | "telegram" | "max" | "vk" | "email" | string;

export interface UnifiedLLMOpts {
  /** chatbot_sessions.id — нужен для cross-channel history + tool context. */
  sessionId: string;
  /** ID авторизованного юзера (Bearer / Telegram-link). null = аноним. */
  userId: number | null;
  /** Канал, по которому пришёл запрос. */
  channel: LLMChannel;
  /** Сырой текст последнего сообщения юзера (без <user_message> обёртки). */
  userText: string;
  /**
   * История диалога. Если не передана — подтянем сами через
   * loadHistoryForLLM(sessionId, 15). Если canale что-то предобработал
   * (debounce, merge) — может передать готовый массив.
   */
  history?: Array<{ role: "user" | "assistant"; content: string }>;
  /**
   * Дополнительный dynamic-блок к system prompt (НЕ кэшируется).
   * Сюда складываем author-context, geo, time-of-day, owner hint и т.д.
   * Должен быть КОРОТКИМ (~1-3 KB), не дублировать persona.
   */
  dynamicContext?: string;
  /** Лимит токенов на ответ (default 400). TG раньше использовал 130 — теперь поднимаем. */
  maxTokens?: number;
  /** Модель (default claude-haiku-4-5-20251001). Можно переопределить из канала. */
  model?: string;
  /**
   * Eugene 2026-05-17 Босс: роль вызывающего (user/admin/super_admin).
   * Управляет фильтрацией tools — обычные юзеры не видят [ADMIN-ONLY] tools,
   * админский voice-канал — видит всё. По умолчанию undefined → user-tools only.
   */
  role?: string | null;
  /**
   * Eugene 2026-05-20 Босс «мини-плеер в чате».
   * Callback который вызывается ПОСЛЕ каждого executeTool с парой
   * (toolName, toolResult). Caller (routes.ts /api/muza/chat) использует
   * это чтобы поймать hint=playNow:<id> из find_public_track и прикрепить
   * attachedTrack к финальному ответу. Sync, не throw'ит.
   */
  onToolResult?: (toolName: string, input: any, result: string) => void;
}

export type KeySwitchEvent = {
  at: string;
  provider: string;
  from: string;
  fromStatus: number | string;
  to: string;
  reason?: string;
};

export type LLMKeyAttempt = { name: string; key: string };

// === Module-level состояние (singleton) ===

const muzaTokenStats = {
  inputTokens: 0,
  outputTokens: 0,
  callsCount: 0,
  sinceStartedAt: new Date().toISOString(),
};

const TOKEN_PRICE = {
  inputPer1M_USD: 0.25,
  outputPer1M_USD: 1.25,
  rubPerUSD: 95,
};

const llmKeyStatus = new Map<string, { lastUsedAt: string; lastStatus: number | "timeout" | "error"; lastErrorMsg?: string }>();
const keySwitchEvents: KeySwitchEvent[] = [];
const LAST_ALERT_AT = new Map<string, number>();

// === Геттеры для админских эндпоинтов (routes.ts) ===

export function getMuzaTokenStats() {
  return { ...muzaTokenStats };
}

export function getTokenPrice() {
  return { ...TOKEN_PRICE };
}

export function getLLMKeyStatus(name: string) {
  return llmKeyStatus.get(name);
}

export function setLLMKeyStatus(name: string, status: { lastUsedAt: string; lastStatus: number | "timeout" | "error"; lastErrorMsg?: string }) {
  llmKeyStatus.set(name, status);
}

export function getKeySwitchEvents(): KeySwitchEvent[] {
  return [...keySwitchEvents];
}

// === Цепочка ключей Anthropic ===

export function listAnthropicKeys(): LLMKeyAttempt[] {
  const out: LLMKeyAttempt[] = [];
  const seen = new Set<string>();
  const push = (name: string, key?: string) => {
    if (!key || seen.has(key)) return;
    seen.add(key);
    out.push({ name, key });
  };
  push("ANTHROPIC_API_KEY", process.env.ANTHROPIC_API_KEY);
  push("ANTHROPIC_API_KEY_BACKUP", process.env.ANTHROPIC_API_KEY_BACKUP);
  push("ANTHROPIC_API_KEY_BOT", process.env.ANTHROPIC_API_KEY_BOT);
  return out;
}

// === TimeWeb Gateway — основной резерв после Anthropic ===
// Eugene 2026-05-16 Босс «TimeWeb как основной резерв». OpenAI-compatible
// gateway: пробуем несколько вариантов endpoint'а (документация была недоступна
// при первичной интеграции — auto-discovery в runtime). Первый рабочий
// кэшируется в TIMEWEB_GATEWAY_URL_CACHE на время процесса.

const TIMEWEB_ENDPOINT_CANDIDATES = [
  "https://gateway.timeweb.cloud/v1/chat/completions",
  "https://api.gateway.timeweb.cloud/v1/chat/completions",
  "https://api.timeweb.cloud/v1/cloud-ai/chat/completions",
  "https://ai.timeweb.cloud/v1/chat/completions",
];

let TIMEWEB_GATEWAY_URL_CACHE: string | null = null;

export function getTimeWebGatewayUrl(): string {
  // Явный override через env (когда узнаем точный URL — пишем в .env)
  const fromEnv = process.env.TIMEWEB_GATEWAY_URL;
  if (fromEnv) return fromEnv;
  if (TIMEWEB_GATEWAY_URL_CACHE) return TIMEWEB_GATEWAY_URL_CACHE;
  // Дефолт — первый кандидат. Async discovery (detectTimeWebEndpoint)
  // обновляет cache при первом успешном ответе.
  return TIMEWEB_ENDPOINT_CANDIDATES[0];
}

export function listTimeWebEndpointCandidates(): string[] {
  return [...TIMEWEB_ENDPOINT_CANDIDATES];
}

/**
 * Делает запрос к TimeWeb Gateway (OpenAI-compatible). Перебирает endpoint'ы
 * пока не найдёт рабочий (если URL_CACHE пуст). Возвращает text-ответ или null.
 */
export async function callTimeWebGateway(opts: {
  systemPrompt: string;
  history: Array<{ role: "user" | "assistant"; content: string }>;
  userText: string;
  maxTokens: number;
  model: string;
}): Promise<{ text: string | null; usage: any; endpoint: string | null }> {
  const key = process.env.TIMEWEB_GATEWAY_KEY;
  if (!key) return { text: null, usage: null, endpoint: null };

  // OpenAI-compatible messages
  const messages: any[] = [
    { role: "system", content: opts.systemPrompt },
    ...opts.history.slice(-15).map(h => ({ role: h.role, content: h.content })),
    { role: "user", content: opts.userText },
  ];

  // Eugene 2026-05-17 Босс «TimeWeb AI Proxy» — endpoint api.timeweb.ai/v1
  // ждёт модель с namespace anthropic/... Подменяем (Anthropic direct
  // принимает голое имя — там не задеваем). Дату-суффикс снимаем (
  // claude-haiku-4-5-20251001 → anthropic/claude-haiku-4-5).
  const tmwModel = opts.model.startsWith("anthropic/") || opts.model.startsWith("openai/")
    ? opts.model
    : `anthropic/${opts.model.replace(/-\d{8}$/, "")}`;

  const body = JSON.stringify({
    model: tmwModel,
    messages,
    max_tokens: opts.maxTokens,
  });

  const endpoints = TIMEWEB_GATEWAY_URL_CACHE
    ? [TIMEWEB_GATEWAY_URL_CACHE]
    : (process.env.TIMEWEB_GATEWAY_URL ? [process.env.TIMEWEB_GATEWAY_URL] : TIMEWEB_ENDPOINT_CANDIDATES);

  for (const url of endpoints) {
    try {
      const r = await fetch(url, {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${key}`,
          "Content-Type": "application/json",
        },
        body,
        signal: AbortSignal.timeout(20_000),
      });
      llmKeyStatus.set("TIMEWEB_GATEWAY_KEY", {
        lastUsedAt: new Date().toISOString(),
        lastStatus: r.status,
      });
      if (!r.ok) {
        const errText = await r.text().catch(() => "");
        llmKeyStatus.set("TIMEWEB_GATEWAY_KEY", {
          lastUsedAt: new Date().toISOString(),
          lastStatus: r.status,
          lastErrorMsg: errText.slice(0, 200),
        });
        console.warn(`[TIMEWEB-LLM] ${url} → ${r.status}, пробую следующий endpoint`);
        // 404 — endpoint не тот, пробуем следующий. Остальные коды (401/429/500)
        // могут быть валидны для этого endpoint — но всё равно пробуем дальше
        // если cache пуст; если cache закреплён — выходим с null.
        if (TIMEWEB_GATEWAY_URL_CACHE) break;
        continue;
      }
      const j: any = await r.json();
      // Закрепляем рабочий endpoint
      if (!TIMEWEB_GATEWAY_URL_CACHE) {
        TIMEWEB_GATEWAY_URL_CACHE = url;
        console.log(`[TIMEWEB-LLM] закрепил рабочий endpoint: ${url}`);
      }
      // OpenAI-compatible: { choices: [{ message: { content: "..." } }], usage: { prompt_tokens, completion_tokens } }
      const text = j?.choices?.[0]?.message?.content;
      return { text: typeof text === "string" ? text.slice(0, 2000) : null, usage: j?.usage || null, endpoint: url };
    } catch (e: any) {
      const msg = e?.name === "AbortError" ? "timeout" : String(e?.message || e).slice(0, 200);
      llmKeyStatus.set("TIMEWEB_GATEWAY_KEY", {
        lastUsedAt: new Date().toISOString(),
        lastStatus: e?.name === "AbortError" ? "timeout" : "error",
        lastErrorMsg: msg,
      });
      console.warn(`[TIMEWEB-LLM] ${url} error: ${msg}, пробую следующий endpoint`);
      if (TIMEWEB_GATEWAY_URL_CACHE) break;
    }
  }
  return { text: null, usage: null, endpoint: null };
}

/**
 * Eugene 2026-05-20 Босс «после ТМВ подключим DeepSeek».
 * DeepSeek API — OpenAI-compatible endpoint https://api.deepseek.com/v1/chat/completions.
 * Дефолтная модель — deepseek-chat (V3.x). Reasoner модель (deepseek-reasoner)
 * для сложных задач — переопределить через DEEPSEEK_MODEL env.
 * БЕЗ tools (Anthropic-tool-use оставлен на Anthropic-шаге).
 */
export async function callDeepSeek(opts: {
  systemPrompt: string;
  history: Array<{ role: "user" | "assistant"; content: string }>;
  userText: string;
  maxTokens: number;
  model?: string;
}): Promise<{ text: string | null; usage: any }> {
  const key = process.env.DEEPSEEK_API_KEY;
  if (!key) return { text: null, usage: null };

  const messages: any[] = [
    { role: "system", content: opts.systemPrompt },
    ...opts.history.slice(-15).map(h => ({ role: h.role, content: h.content })),
    { role: "user", content: opts.userText },
  ];
  const url = process.env.DEEPSEEK_API_URL || "https://api.deepseek.com/v1/chat/completions";
  const model = opts.model || process.env.DEEPSEEK_MODEL || "deepseek-chat";

  try {
    const r = await fetch(url, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${key}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model,
        messages,
        max_tokens: Math.min(opts.maxTokens, 4000),
        temperature: 0.7,
        stream: false,
      }),
      signal: AbortSignal.timeout(30_000),
    });
    llmKeyStatus.set("DEEPSEEK_API_KEY", {
      lastUsedAt: new Date().toISOString(),
      lastStatus: r.status,
    });
    if (!r.ok) {
      const errText = await r.text().catch(() => "");
      llmKeyStatus.set("DEEPSEEK_API_KEY", {
        lastUsedAt: new Date().toISOString(),
        lastStatus: r.status,
        lastErrorMsg: errText.slice(0, 200),
      });
      console.warn(`[DEEPSEEK] non-ok ${r.status}: ${errText.slice(0, 200)}`);
      return { text: null, usage: null };
    }
    const j: any = await r.json();
    const text = j?.choices?.[0]?.message?.content;
    return {
      text: typeof text === "string" ? text.slice(0, 2000) : null,
      usage: j?.usage || null,
    };
  } catch (e: any) {
    const msg = e?.name === "AbortError" ? "timeout" : String(e?.message || e).slice(0, 200);
    llmKeyStatus.set("DEEPSEEK_API_KEY", {
      lastUsedAt: new Date().toISOString(),
      lastStatus: e?.name === "AbortError" ? "timeout" : "error",
      lastErrorMsg: msg,
    });
    console.warn(`[DEEPSEEK] error: ${msg}`);
    return { text: null, usage: null };
  }
}

// === Telegram-alert при смене ключа (опц.) ===

async function notifyAdminKeySwitch(ev: KeySwitchEvent): Promise<void> {
  keySwitchEvents.unshift(ev);
  if (keySwitchEvents.length > 50) keySwitchEvents.length = 50;
  const alertKey = `${ev.provider}:${ev.from}`;
  const lastAt = LAST_ALERT_AT.get(alertKey) || 0;
  if (Date.now() - lastAt < 60 * 60_000) return; // не чаще раза в час
  LAST_ALERT_AT.set(alertKey, Date.now());
  const adminChat = process.env.ADMIN_TELEGRAM_ID;
  const botToken = process.env.TELEGRAM_BOT_TOKEN;
  console.warn(`\x1b[33m[KEY-SWITCH]\x1b[0m ${ev.provider}: ${ev.from} (${ev.fromStatus}) → ${ev.to}`);
  if (!adminChat || !botToken) return;
  try {
    await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: adminChat,
        text: `🔔 *Auto-switch ключа* (${ev.provider})\n\nПервичный: \`${ev.from}\` упал (${ev.fromStatus})\nПереключился на: \`${ev.to}\`\n\n${ev.reason ? `Причина: ${ev.reason}\n\n` : ""}Время: ${new Date(ev.at).toLocaleString("ru-RU")}`,
        parse_mode: "Markdown",
      }),
      signal: AbortSignal.timeout(8_000),
    });
  } catch (e) {
    console.warn("[KEY-SWITCH] не смог отправить Telegram-alert:", e);
  }
}

// === Главная функция ===

/**
 * Единственный путь к LLM для Музы. Возвращает text-ответ либо null,
 * если все провайдеры упали. Никаких hardcoded fallback-строк —
 * выбор fallback'а делает caller (web /muza/chat / TG webhook / Max webhook).
 *
 * Eugene 2026-05-21 Босс: PRIMARY = DeepSeek, потом TimeWeb, далее Anthropic
 * (по имени sort: API_KEY → _BACKUP → _BOT), последний резерв = GPTunnel.
 *
 * Порядок попыток:
 *   1. DeepSeek (OpenAI-compat, без tools) — PRIMARY (cheap: $0.27/$1.10 per M)
 *   2. TimeWeb Gateway (OpenAI-compat, без tools, Anthropic-models) — fallback 1
 *   3. Anthropic ANTHROPIC_API_KEY (tools + tool-use loop) — fallback 2a
 *   4. Anthropic ANTHROPIC_API_KEY_BACKUP — fallback 2b
 *   5. Anthropic ANTHROPIC_API_KEY_BOT — fallback 2c
 *   6. GPTunnel/gpt-4o-mini — последний резерв
 *
 * Tool-use loop работает ТОЛЬКО на Anthropic-шаге. DeepSeek, TimeWeb, GPTunnel
 * возвращают чистый text без tool-calling.
 */
export async function callUnifiedMuzaLLM(opts: UnifiedLLMOpts): Promise<string | null> {
  const attempts = listAnthropicKeys();
  // Eugene 2026-05-20: убрано raннее return null если attempts.length===0,
  // потому что теперь primary = TimeWeb, Anthropic — fallback. Если ни одного
  // Anthropic-ключа нет, TimeWeb всё равно должен попробовать ответить.

  // 1. System prompt — единый для всех каналов.
  //    Stable часть кэшируется (ephemeral TTL 1h), dynamic — отдельным блоком.
  // Eugene 2026-05-18 Босс «администратору — всю информацию, клиенту — только
  // продажи/кабинет/генерация». isAdmin вычисляем по opts.role и пробрасываем
  // в buildPersonaSystem — он меняет «зоны открытости» в system prompt.
  const r = String(opts.role || "").toLowerCase();
  const isAdmin = r === "admin" || r === "super_admin";
  const stable = buildPersonaSystem(opts.sessionId, "consultant", isAdmin);
  const systemBlocks: any[] = [
    { type: "text", text: stable, cache_control: { type: "ephemeral", ttl: "1h" } },
  ];
  if (opts.dynamicContext && opts.dynamicContext.trim()) {
    systemBlocks.push({ type: "text", text: opts.dynamicContext });
  }

  // 2. История — берём cross-channel если canale не передал свою.
  const history = opts.history && opts.history.length > 0
    ? opts.history
    : loadHistoryForLLM(opts.sessionId, 15);

  // 3. Prompt-injection guard на user-text (Eugene 2026-05-16).
  //    Удаляем пользовательские попытки сами вставить эти теги.
  const cleaned = String(opts.userText || "")
    .replace(/<user_message>/gi, "")
    .replace(/<\/user_message>/gi, "");
  const safeUserText = `<user_message>${cleaned}</user_message>`;

  // 4. Messages для Claude. history.slice(-15) — последние 15 reply'ев.
  // Eugene 2026-05-19 Триумф-Музы C2: original snapshot для key cascade.
  // Каждая попытка ключа работает на свежей deep-копии — tool_use артефакты
  // от провального ключа не утекают на следующий.
  const originalMessages: any[] = [
    ...history.slice(-15).map(h => ({ role: h.role, content: h.content })),
    { role: "user", content: safeUserText },
  ];
  let messages: any[] = JSON.parse(JSON.stringify(originalMessages));

  const model = opts.model || "claude-haiku-4-5-20251001";
  const maxTokens = opts.maxTokens || 400;

  // Eugene 2026-05-17 Босс: фильтруем admin-only tools для обычных каналов.
  // role='admin' (voice-admin) → все tools; user channels → только user-tools.
  const toolsForCall = filterToolsForRole(opts.role);

  const buildBody = () => JSON.stringify({
    model,
    max_tokens: maxTokens,
    system: systemBlocks,
    messages,
    tools: toolsForCall,
  });

  let prevFailed: { name: string; status: number | string; reason?: string } | null = null;

  // === [PRIMARY] DeepSeek (Eugene 2026-05-21 Босс «DeepSeek primary, TimeWeb fallback,
  // далее по имени sort») === OpenAI-compatible, БЕЗ tools.
  // Дешёвый ($0.27/1M input, $1.10/1M output для deepseek-chat).
  if (process.env.DEEPSEEK_API_KEY) {
    try {
      const sysText = systemBlocks.map(b => (typeof b === "string" ? b : (b?.text || ""))).join("\n\n");
      const ds = await callDeepSeek({
        systemPrompt: sysText,
        history: history.slice(-15),
        userText: safeUserText,
        maxTokens,
      });
      if (ds.usage) {
        muzaTokenStats.inputTokens += Number(ds.usage.prompt_tokens || 0);
        muzaTokenStats.outputTokens += Number(ds.usage.completion_tokens || 0);
        muzaTokenStats.callsCount += 1;
      }
      if (ds.text && ds.text.length > 0) {
        return ds.text;
      }
      console.warn("[MUZA-LLM] DeepSeek (primary) returned empty text — fallback to TimeWeb");
      setLLMKeyStatus("DEEPSEEK_API_KEY", { lastUsedAt: new Date().toISOString(), lastStatus: "error", lastErrorMsg: "empty response" });
      prevFailed = { name: "DEEPSEEK_API_KEY", status: "empty-response", reason: "DeepSeek returned empty text" };
    } catch (e: any) {
      const msg = String(e?.message || e);
      console.warn("[MUZA-LLM] DeepSeek (primary) error — fallback to TimeWeb:", msg);
      setLLMKeyStatus("DEEPSEEK_API_KEY", { lastUsedAt: new Date().toISOString(), lastStatus: "error", lastErrorMsg: msg.slice(0, 200) });
      prevFailed = { name: "DEEPSEEK_API_KEY", status: "error", reason: msg.slice(0, 200) };
    }
  } else {
    console.warn("[MUZA-LLM] DeepSeek (primary) skipped: DEEPSEEK_API_KEY not configured — пробуем TimeWeb");
  }

  // === [FALLBACK 1] TimeWeb Gateway === OpenAI-compatible, БЕЗ tools.
  // Anthropic-models через api.timeweb.ai gateway.
  if (process.env.TIMEWEB_GATEWAY_KEY) {
    try {
      const sysText = systemBlocks.map(b => (typeof b === "string" ? b : (b?.text || ""))).join("\n\n");
      const tw = await callTimeWebGateway({
        systemPrompt: sysText,
        history: history.slice(-15),
        userText: safeUserText,
        maxTokens,
        model: process.env.TIMEWEB_GATEWAY_MODEL || "anthropic/claude-haiku-4-5",
      });
      if (tw.usage) {
        muzaTokenStats.inputTokens += Number(tw.usage.prompt_tokens || 0);
        muzaTokenStats.outputTokens += Number(tw.usage.completion_tokens || 0);
        muzaTokenStats.callsCount += 1;
      }
      if (tw.text && tw.text.length > 0) {
        if (prevFailed) {
          notifyAdminKeySwitch({
            at: new Date().toISOString(),
            provider: "DeepSeek → TimeWeb",
            from: prevFailed.name,
            fromStatus: prevFailed.status,
            to: "TIMEWEB_GATEWAY_KEY",
            reason: prevFailed.reason || "primary upstream failed",
          }).catch(() => {});
        }
        return tw.text;
      }
      console.warn("[MUZA-LLM] TimeWeb fallback empty — fallback to Anthropic. endpoint:", tw.endpoint || "?");
      setLLMKeyStatus("TIMEWEB_GATEWAY_KEY", { lastUsedAt: new Date().toISOString(), lastStatus: "error", lastErrorMsg: "empty response" });
      prevFailed = { name: "TIMEWEB_GATEWAY_KEY", status: "empty-response", reason: "TimeWeb returned empty text" };
    } catch (e: any) {
      const msg = String(e?.message || e);
      console.warn("[MUZA-LLM] TimeWeb fallback error — fallback to Anthropic:", msg);
      setLLMKeyStatus("TIMEWEB_GATEWAY_KEY", { lastUsedAt: new Date().toISOString(), lastStatus: "error", lastErrorMsg: msg.slice(0, 200) });
      prevFailed = { name: "TIMEWEB_GATEWAY_KEY", status: "error", reason: msg.slice(0, 200) };
    }
  } else {
    console.warn("[MUZA-LLM] TimeWeb skipped: TIMEWEB_GATEWAY_KEY not configured — пробуем Anthropic");
  }

  // === [FALLBACK 2] Anthropic 3-key chain (с MUZA_TOOLS + tool-use loop) ===
  // Eugene 2026-05-20: было primary, теперь fallback. Если Anthropic-ключей нет —
  // пропустим этот блок и провалимся на GPTunnel fallback.
  for (let i = 0; i < attempts.length; i++) {
    const { name, key } = attempts[i];
    // C2: восстановить чистый snapshot перед каждым ключом
    messages = JSON.parse(JSON.stringify(originalMessages));
    try {
      const r = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "x-api-key": key,
          "anthropic-version": "2023-06-01",
          "anthropic-beta": "extended-cache-ttl-2025-04-11",
          "content-type": "application/json",
        },
        body: buildBody(),
        signal: AbortSignal.timeout(15_000),
      });
      llmKeyStatus.set(name, { lastUsedAt: new Date().toISOString(), lastStatus: r.status });
      if (!r.ok) {
        const errText = await r.text().catch(() => "");
        llmKeyStatus.set(name, { lastUsedAt: new Date().toISOString(), lastStatus: r.status, lastErrorMsg: errText.slice(0, 200) });
        console.warn(`[MUZA-LLM] ${name} non-ok ${r.status} — пробую следующий ключ`);
        prevFailed = { name, status: r.status, reason: errText.slice(0, 100) };
        continue;
      }
      const j: any = await r.json();
      if (j?.usage) {
        muzaTokenStats.inputTokens += Number(j.usage.input_tokens || 0) + Number(j.usage.cache_read_input_tokens || 0);
        muzaTokenStats.outputTokens += Number(j.usage.output_tokens || 0);
        muzaTokenStats.callsCount += 1;
      }
      // Tool-use loop: stop_reason="tool_use" → выполнить tools и зациклиться.
      if (j?.stop_reason === "tool_use" && Array.isArray(j.content)) {
        // Eugene 2026-05-18 Босс «TOP-5 ревизии»: tool-loop dedupe.
        // Eugene 2026-05-19 Musa-diag ROOT CAUSE: при forceBreak обязательно
        // дозаполняем tool_result для ВСЕХ tool_use блоков — иначе Anthropic
        // вернёт 400 «tool_result required for each tool_use» на следующем
        // запросе → каскад на все 3 ключа → fallback → юзер видит «не работает».
        const toolCallCounts = new Map<string, number>();
        let forceBreak = false;
        messages.push({ role: "assistant", content: j.content });
        const toolResults: any[] = [];
        for (const block of j.content) {
          if (block.type === "tool_use") {
            const cnt = (toolCallCounts.get(block.name) || 0) + 1;
            toolCallCounts.set(block.name, cnt);
            if (cnt > 2) {
              console.warn(`[LLM-LOOP] Tool '${block.name}' called ${cnt}x — stub + break`);
              forceBreak = true;
              // STUB tool_result чтобы Anthropic API контракт держался
              toolResults.push({
                type: "tool_result",
                tool_use_id: block.id,
                content: "Tool call limit reached. Continue without calling this tool again — finalize the response for the user.",
              });
              continue;
            }
            const result = await executeTool(block.name, block.input, {
              userId: opts.userId,
              sessionId: opts.sessionId,
              channel: opts.channel,
              role: opts.role,
            });
            console.log(`[MUZA-TOOL/${opts.channel}] ${block.name}(${JSON.stringify(block.input).slice(0, 60)}) → ${result.slice(0, 80)}`);
            try { opts.onToolResult?.(block.name, block.input, result); } catch {}
            toolResults.push({ type: "tool_result", tool_use_id: block.id, content: result });
          }
        }
        messages.push({ role: "user", content: toolResults });
        // Eugene 2026-05-19 Триумф-Музы fix: даже если forceBreak hit на outer,
        // нужен ОДИН финальный API-call чтобы Claude засуммировал tool results
        // в текст. Без него выпадаем на line 466 которая берёт content[0].text
        // (а первый блок — tool_use, не text → undefined → fallback). Меняем
        // условие чтобы хотя бы 1 итерация final-call случилась.
        let loopIter = 0;
        const maxLoop = forceBreak ? 1 : 4;
        // Eugene 2026-05-19 Триумф: трекаем последний j2 чтобы извлечь text
        // из него если цикл завершился без end_turn (line 493 берёт original j,
        // содержащий tool_use без text → undefined → fallback).
        let lastJ2: any = null;
        while (loopIter < maxLoop) {
          loopIter++;
          const r2 = await fetch("https://api.anthropic.com/v1/messages", {
            method: "POST",
            headers: {
              "x-api-key": key,
              "anthropic-version": "2023-06-01",
              "anthropic-beta": "extended-cache-ttl-2025-04-11",
              "content-type": "application/json",
            },
            body: buildBody(),
            signal: AbortSignal.timeout(15_000),
          });
          if (!r2.ok) break;
          const j2: any = await r2.json();
          lastJ2 = j2;
          if (j2?.usage) {
            muzaTokenStats.inputTokens += Number(j2.usage.input_tokens || 0) + Number(j2.usage.cache_read_input_tokens || 0);
            muzaTokenStats.outputTokens += Number(j2.usage.output_tokens || 0);
            muzaTokenStats.callsCount += 1;
          }
          if (j2?.stop_reason === "end_turn") {
            const textBlock = (j2.content || []).find((b: any) => b.type === "text");
            return textBlock?.text?.slice(0, 2000) || null;
          }
          if (j2?.stop_reason === "tool_use" && Array.isArray(j2.content)) {
            messages.push({ role: "assistant", content: j2.content });
            const tr: any[] = [];
            let innerForceBreak = false;
            for (const block of j2.content) {
              if (block.type === "tool_use") {
                const cnt = (toolCallCounts.get(block.name) || 0) + 1;
                toolCallCounts.set(block.name, cnt);
                if (cnt > 2) {
                  console.warn(`[LLM-LOOP] Tool '${block.name}' called ${cnt}x — stub + break`);
                  innerForceBreak = true;
                  // STUB tool_result — обязателен (см. outer-loop fix)
                  tr.push({
                    type: "tool_result",
                    tool_use_id: block.id,
                    content: "Tool call limit reached. Finalize the response for the user.",
                  });
                  continue;
                }
                const result = await executeTool(block.name, block.input, {
                  userId: opts.userId,
                  sessionId: opts.sessionId,
                  channel: opts.channel,
                  role: opts.role,
                });
                console.log(`[MUZA-TOOL-${loopIter}/${opts.channel}] ${block.name} → ${result.slice(0, 60)}`);
                try { opts.onToolResult?.(block.name, block.input, result); } catch {}
                tr.push({ type: "tool_result", tool_use_id: block.id, content: result });
              }
            }
            messages.push({ role: "user", content: tr });
            if (innerForceBreak) {
              // Сделать ОДИН финальный вызов чтобы Claude засуммировал
              // (без break — иначе вернём undefined через line 466).
              continue;
            }
            continue;
          }
          // stop_reason !== "end_turn" and !== "tool_use" — extract text если есть
          const fallbackText = (j2?.content || []).find((b: any) => b.type === "text")?.text;
          if (typeof fallbackText === "string" && fallbackText.length > 0) {
            return fallbackText.slice(0, 2000);
          }
          break;
        }
        // Eugene 2026-05-19 Триумф: цикл завершён без return — пробуем text
        // из последнего ответа Claude (если он есть). Это страховка от
        // выпадения в hardcoded fallback при tool-loop saturation.
        if (lastJ2) {
          const txtBlock = (lastJ2.content || []).find((b: any) => b.type === "text");
          if (txtBlock?.text && txtBlock.text.length > 0) {
            return String(txtBlock.text).slice(0, 2000);
          }
        }
      }
      // Eugene 2026-05-19 Триумф-Музы C1: ищем text-блок В ЛЮБОМ месте content,
      // не только content[0]. Когда stop_reason='tool_use' — content[0] это
      // tool_use (не text), но Claude может приложить text-блок рядом.
      const textBlock = (j?.content || []).find((b: any) => b?.type === "text");
      const c = typeof textBlock?.text === "string" ? textBlock.text : "";
      if (c && c.length > 0) {
        if (prevFailed && i > 0) {
          notifyAdminKeySwitch({
            at: new Date().toISOString(),
            provider: "Anthropic Claude",
            from: prevFailed.name,
            fromStatus: prevFailed.status,
            to: name,
            reason: prevFailed.reason,
          }).catch(() => {});
        }
        return c.slice(0, 2000);
      }
      prevFailed = { name, status: "empty-response" };
    } catch (e: any) {
      const msg = e?.name === "AbortError" ? "timeout" : String(e?.message || e).slice(0, 200);
      llmKeyStatus.set(name, {
        lastUsedAt: new Date().toISOString(),
        lastStatus: e?.name === "AbortError" ? "timeout" : "error",
        lastErrorMsg: msg,
      });
      console.warn(`[MUZA-LLM] ${name} error:`, msg, "— пробую следующий ключ");
      prevFailed = {
        name,
        status: e?.name === "AbortError" ? "timeout" : "error",
        reason: msg,
      };
    }
  }

  // Eugene 2026-05-20: TimeWeb блок перенесён НАВЕРХ (до Anthropic) — теперь
  // TimeWeb primary. Здесь он уже отработал. Если дошли сюда — TimeWeb упал
  // и Anthropic 3-key chain тоже не вернул text → пробуем последний резерв.

  // === [FALLBACK 3] GPTunnel/gpt-4o-mini — последний резерв.
  // Срабатывает только если TimeWeb упал И ВСЕ Anthropic-ключи упали.
  // GPTunnel ключ уже есть для Suno-генерации, OpenAI-compatible /v1/chat/completions.
  // БЕЗ tools — clean text.
  if (process.env.GPTUNNEL_API_KEY) {
    try {
      const sysText = systemBlocks.map(b => (typeof b === "string" ? b : (b?.text || ""))).join("\n\n");
      const messages: any[] = [{ role: "system", content: sysText }];
      for (const h of history.slice(-15)) {
        messages.push({
          role: h.role === "user" ? "user" : "assistant",
          content: typeof h.content === "string" ? h.content : String(h.content || ""),
        });
      }
      messages.push({ role: "user", content: safeUserText });
      const r = await fetch("https://gptunnel.ru/v1/chat/completions", {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${process.env.GPTUNNEL_API_KEY}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: process.env.GPTUNNEL_LLM_MODEL || "gpt-4o-mini",
          messages,
          max_tokens: Math.min(maxTokens, 2000),
          temperature: 0.7,
        }),
        signal: AbortSignal.timeout(45_000),
      });
      if (r.ok) {
        const json: any = await r.json().catch(() => null);
        const text = String(json?.choices?.[0]?.message?.content || "").trim();
        if (json?.usage) {
          muzaTokenStats.inputTokens += Number(json.usage.prompt_tokens || 0);
          muzaTokenStats.outputTokens += Number(json.usage.completion_tokens || 0);
          muzaTokenStats.callsCount += 1;
        }
        if (text.length > 0) {
          notifyAdminKeySwitch({
            at: new Date().toISOString(),
            provider: "Anthropic + TimeWeb → GPTunnel/gpt-4o-mini",
            from: prevFailed?.name || "TIMEWEB",
            fromStatus: prevFailed?.status || "empty",
            to: "GPTUNNEL_API_KEY",
            reason: "все Anthropic-ключи и TimeWeb упали, перешли на GPT-4o-mini",
          }).catch(() => {});
          setLLMKeyStatus("GPTUNNEL_LLM", { lastUsedAt: new Date().toISOString(), lastStatus: 200 });
          return text;
        }
        setLLMKeyStatus("GPTUNNEL_LLM", { lastUsedAt: new Date().toISOString(), lastStatus: "error", lastErrorMsg: "empty response" });
        console.warn("[MUZA-LLM] GPTunnel/gpt-4o-mini returned empty text");
      } else {
        const body = await r.text().catch(() => "");
        setLLMKeyStatus("GPTUNNEL_LLM", { lastUsedAt: new Date().toISOString(), lastStatus: "error", lastErrorMsg: `HTTP ${r.status}: ${body.slice(0, 200)}` });
        console.warn(`[MUZA-LLM] GPTunnel/gpt-4o-mini HTTP ${r.status}: ${body.slice(0, 200)}`);
      }
    } catch (e: any) {
      const msg = String(e?.message || e);
      setLLMKeyStatus("GPTUNNEL_LLM", { lastUsedAt: new Date().toISOString(), lastStatus: "error", lastErrorMsg: msg.slice(0, 200) });
      console.warn("[MUZA-LLM] GPTunnel fallback error:", msg);
    }
  } else {
    console.warn("[MUZA-LLM] GPTunnel fallback skipped: GPTUNNEL_API_KEY not configured");
  }

  return null;
}
