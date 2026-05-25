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
  /**
   * Eugene 2026-05-23 Risk #12 fix. Если true — пропускаем DeepSeek и TimeWeb
   * (они БЕЗ tools, не могут вызвать find_public_track/play_now/open_panel/
   * create_music_job/...) и идём сразу на Anthropic chain с MUZA_TOOLS.
   * Caller детектит tool-intent через muzaIntentRouter.detectMuzaToolIntent()
   * и передаёт сюда. Без этого флага LLM-цепочка обрывается на DeepSeek-text-
   * ответе, и юзеру с командой «постав трек про маму» музыка не воспроизводится.
   */
  forceAnthropic?: boolean;
  /**
   * Eugene 2026-05-25 Босс «админ-управление только через мои IP + бот».
   * Пробрасывается в ToolContext.ipTrusted — мутирующие director-tools в
   * web/voice требуют ipTrusted !== false. true=доверен, false=гейт включён+
   * не доверен, undefined=гейт выключен.
   */
  ipTrusted?: boolean;
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
    // Eugene 2026-05-23 Босс «Музa повторяет» — anti-repeat sampling.
    temperature: 0.85,
    frequency_penalty: 0.5,
    presence_penalty: 0.4,
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
        // Eugene 2026-05-23 Босс «Музa тупит, повторы каждые 3 сек» —
        // OpenAI-compat penalties + умеренная temp дают разнообразие.
        temperature: 0.85,
        frequency_penalty: 0.5,
        presence_penalty: 0.4,
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

/**
 * Eugene 2026-05-25 Босс «DeepSeek, yandex Ai» — YandexGPT в цепочку.
 * RU data-residency: Yandex Cloud — РФ-инфраструктура, для трансграничного
 * 152-ФЗ контекста это «свой» провайдер (в отличие от Anthropic США).
 *
 * Docs-first-always rule: используем OpenAI-compatible endpoint Yandex Cloud
 * Foundation Models — https://yandex.cloud/ru/docs/foundation-models/concepts/openai-compatibility
 *   URL:   https://llm.api.cloud.yandex.net/v1/chat/completions
 *   Auth:  Authorization: Api-Key <YANDEX_GPT_API_KEY>  (+ x-folder-id)
 *   Model: gpt://<folder-id>/yandexgpt/latest (или yandexgpt-lite)
 * БЕЗ tools (Anthropic-tool-use оставлен на Anthropic-шаге).
 */
export async function callYandexGPT(opts: {
  systemPrompt: string;
  history: Array<{ role: "user" | "assistant"; content: string }>;
  userText: string;
  maxTokens: number;
  model?: string;
}): Promise<{ text: string | null; usage: any }> {
  const key = process.env.YANDEX_GPT_API_KEY;
  const folderId = process.env.YANDEX_GPT_FOLDER_ID || process.env.YANDEX_FOLDER_ID;
  if (!key || !folderId) return { text: null, usage: null };

  const messages: any[] = [
    { role: "system", content: opts.systemPrompt },
    ...opts.history.slice(-15).map(h => ({ role: h.role, content: h.content })),
    { role: "user", content: opts.userText },
  ];
  const url = process.env.YANDEX_GPT_API_URL || "https://llm.api.cloud.yandex.net/v1/chat/completions";
  // Model URI обязателен для OpenAI-compat режима Yandex (gpt://<folder>/<model>/<ver>).
  const model = opts.model
    || process.env.YANDEX_GPT_MODEL
    || `gpt://${folderId}/yandexgpt/latest`;

  try {
    const r = await fetch(url, {
      method: "POST",
      headers: {
        "Authorization": `Api-Key ${key}`,
        "Content-Type": "application/json",
        "x-folder-id": folderId,
      },
      body: JSON.stringify({
        model,
        messages,
        max_tokens: Math.min(opts.maxTokens, 2000),
        // anti-repeat (см. DeepSeek/TimeWeb). YandexGPT OpenAI-compat
        // принимает temperature; penalties не гарантированы — не шлём.
        temperature: 0.7,
        stream: false,
      }),
      signal: AbortSignal.timeout(25_000),
    });
    llmKeyStatus.set("YANDEX_GPT_API_KEY", {
      lastUsedAt: new Date().toISOString(),
      lastStatus: r.status,
    });
    if (!r.ok) {
      const errText = await r.text().catch(() => "");
      llmKeyStatus.set("YANDEX_GPT_API_KEY", {
        lastUsedAt: new Date().toISOString(),
        lastStatus: r.status,
        lastErrorMsg: errText.slice(0, 200),
      });
      console.warn(`[YANDEX-GPT] non-ok ${r.status}: ${errText.slice(0, 200)}`);
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
    llmKeyStatus.set("YANDEX_GPT_API_KEY", {
      lastUsedAt: new Date().toISOString(),
      lastStatus: e?.name === "AbortError" ? "timeout" : "error",
      lastErrorMsg: msg,
    });
    console.warn(`[YANDEX-GPT] error: ${msg}`);
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
 * Eugene 2026-05-25 Босс «DeepSeek, yandex Ai»: YandexGPT добавлен 2-м
 * (RU data-residency) между DeepSeek и TimeWeb.
 *
 * Порядок попыток:
 *   1. DeepSeek (OpenAI-compat, без tools) — PRIMARY (cheap: $0.27/$1.10 per M)
 *   2. YandexGPT (OpenAI-compat, без tools, РФ-инфра) — fallback 1
 *   3. TimeWeb Gateway (OpenAI-compat, без tools, Anthropic-models) — fallback 2
 *   4. Anthropic ANTHROPIC_API_KEY (tools + tool-use loop) — fallback 3a
 *   5. Anthropic ANTHROPIC_API_KEY_BACKUP — fallback 3b
 *   6. Anthropic ANTHROPIC_API_KEY_BOT — fallback 3c
 *   7. GPTunnel/gpt-4o-mini — последний резерв
 *
 * Tool-use loop работает ТОЛЬКО на Anthropic-шаге. DeepSeek, YandexGPT, TimeWeb,
 * GPTunnel возвращают чистый text без tool-calling.
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
    // Eugene 2026-05-23 Босс «повторы каждые 3 сек» — Anthropic поддерживает
    // temperature (default 1.0 = max variance). Снижаем до 0.85 + top_p 0.92
    // — даёт большее разнообразие лексики при сохранении coherence.
    // Anthropic НЕ поддерживает frequency_penalty/presence_penalty (это OpenAI).
    temperature: 0.85,
    top_p: 0.92,
  });

  let prevFailed: { name: string; status: number | string; reason?: string } | null = null;

  // === [PRIMARY] TimeWeb Gateway (Eugene 2026-05-25 Босс «Timeweb Priority») ===
  // OpenAI-compatible, БЕЗ tools. Anthropic-models через api.timeweb.ai gateway.
  // forceAnthropic → пропускаем (gateway не маршрутизирует tools на upstream).
  if (opts.forceAnthropic) {
    console.log("[MUZA-LLM] forceAnthropic=true — skip TimeWeb (no-tools), goto Anthropic direct");
  } else if (process.env.TIMEWEB_GATEWAY_KEY) {
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
      if (tw.text && tw.text.length > 0) return tw.text;
      console.warn("[MUZA-LLM] TimeWeb (primary) empty — fallback to DeepSeek. endpoint:", tw.endpoint || "?");
      setLLMKeyStatus("TIMEWEB_GATEWAY_KEY", { lastUsedAt: new Date().toISOString(), lastStatus: "error", lastErrorMsg: "empty response" });
      prevFailed = { name: "TIMEWEB_GATEWAY_KEY", status: "empty-response", reason: "TimeWeb returned empty text" };
    } catch (e: any) {
      const msg = String(e?.message || e);
      console.warn("[MUZA-LLM] TimeWeb (primary) error — fallback to DeepSeek:", msg);
      setLLMKeyStatus("TIMEWEB_GATEWAY_KEY", { lastUsedAt: new Date().toISOString(), lastStatus: "error", lastErrorMsg: msg.slice(0, 200) });
      prevFailed = { name: "TIMEWEB_GATEWAY_KEY", status: "error", reason: msg.slice(0, 200) };
    }
  } else {
    console.warn("[MUZA-LLM] TimeWeb (primary) skipped: TIMEWEB_GATEWAY_KEY not configured — пробуем DeepSeek");
  }

  // === [FALLBACK 1] DeepSeek (Eugene 2026-05-21 Босс «DeepSeek primary, TimeWeb fallback,
  // далее по имени sort») === OpenAI-compatible, БЕЗ tools.
  // Дешёвый ($0.27/1M input, $1.10/1M output для deepseek-chat).
  // Eugene 2026-05-23 Risk #12: если forceAnthropic — пропускаем (DeepSeek
  // не поддерживает MUZA_TOOLS, а юзер просил player/panel/generation action).
  if (opts.forceAnthropic) {
    console.log("[MUZA-LLM] forceAnthropic=true — skip DeepSeek (no-tools), goto Anthropic");
  } else if (process.env.DEEPSEEK_API_KEY) {
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

  // === [FALLBACK 1] YandexGPT (Eugene 2026-05-25 Босс «DeepSeek, yandex Ai») ===
  // OpenAI-compatible, БЕЗ tools. РФ data-residency (Yandex Cloud).
  // Risk #12: если forceAnthropic — пропускаем (YandexGPT не поддерживает MUZA_TOOLS).
  if (opts.forceAnthropic) {
    console.log("[MUZA-LLM] forceAnthropic=true — skip YandexGPT (no-tools), goto Anthropic");
  } else if (process.env.YANDEX_GPT_API_KEY && (process.env.YANDEX_GPT_FOLDER_ID || process.env.YANDEX_FOLDER_ID)) {
    try {
      const sysText = systemBlocks.map(b => (typeof b === "string" ? b : (b?.text || ""))).join("\n\n");
      const ya = await callYandexGPT({
        systemPrompt: sysText,
        history: history.slice(-15),
        userText: safeUserText,
        maxTokens,
      });
      if (ya.usage) {
        muzaTokenStats.inputTokens += Number(ya.usage.prompt_tokens || 0);
        muzaTokenStats.outputTokens += Number(ya.usage.completion_tokens || 0);
        muzaTokenStats.callsCount += 1;
      }
      if (ya.text && ya.text.length > 0) {
        if (prevFailed) {
          notifyAdminKeySwitch({
            at: new Date().toISOString(),
            provider: "DeepSeek → YandexGPT",
            from: prevFailed.name,
            fromStatus: prevFailed.status,
            to: "YANDEX_GPT_API_KEY",
            reason: prevFailed.reason || "primary upstream failed",
          }).catch(() => {});
        }
        return ya.text;
      }
      console.warn("[MUZA-LLM] YandexGPT (fallback 1) returned empty text — fallback to TimeWeb");
      setLLMKeyStatus("YANDEX_GPT_API_KEY", { lastUsedAt: new Date().toISOString(), lastStatus: "error", lastErrorMsg: "empty response" });
      prevFailed = { name: "YANDEX_GPT_API_KEY", status: "empty-response", reason: "YandexGPT returned empty text" };
    } catch (e: any) {
      const msg = String(e?.message || e);
      console.warn("[MUZA-LLM] YandexGPT (fallback 1) error — fallback to TimeWeb:", msg);
      setLLMKeyStatus("YANDEX_GPT_API_KEY", { lastUsedAt: new Date().toISOString(), lastStatus: "error", lastErrorMsg: msg.slice(0, 200) });
      prevFailed = { name: "YANDEX_GPT_API_KEY", status: "error", reason: msg.slice(0, 200) };
    }
  } else {
    console.warn("[MUZA-LLM] YandexGPT skipped: YANDEX_GPT_API_KEY/folder not configured — пробуем TimeWeb");
  }

  // (TimeWeb-блок перенесён в начало цепочки — Eugene 2026-05-25 «Timeweb Priority».)

  // === [FALLBACK] Anthropic 3-key chain (с MUZA_TOOLS + tool-use loop) ===
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
        // Eugene 2026-05-21 Босс «По музе боту 1 вариант делаем» (audit #1):
        // Multi-step reasoning. Раньше cnt>2 на ЛЮБОЙ tool → break — Музa
        // не могла «поиск → анализ → ответ». Теперь:
        //   - MAX_TOTAL_ITERATIONS = 6 (общий лимит rounds tool_use)
        //   - MAX_PER_TOOL = 4 (один tool можно с разными params)
        //   - Dedup по hash(input) — same tool + same input = stub (loop)
        // Так Музa делает search→analyze→recommend, но не бесконечно.
        const MAX_TOTAL_ITERATIONS = 6;
        const MAX_PER_TOOL = 4;
        const toolNameCounts = new Map<string, number>();
        const toolDedupSet = new Set<string>();

        // Возвращает {reject, reason, stubText} или null если выполнять.
        const checkTool = (name: string, input: any): { reject: true; reason: string; stub: string } | null => {
          const inputHash = JSON.stringify(input || {});
          const dedupKey = `${name}::${inputHash}`;
          if (toolDedupSet.has(dedupKey)) {
            return { reject: true, reason: "duplicate-input", stub: `Этот tool с такими же параметрами уже вызывался в этой сессии. Используй сохранённый результат или вызови другой tool / финализируй ответ.` };
          }
          const cnt = (toolNameCounts.get(name) || 0) + 1;
          if (cnt > MAX_PER_TOOL) {
            return { reject: true, reason: "per-tool-limit", stub: `Tool '${name}' уже вызван ${cnt - 1}× — лимит ${MAX_PER_TOOL}. Используй существующие результаты для финального ответа.` };
          }
          toolDedupSet.add(dedupKey);
          toolNameCounts.set(name, cnt);
          return null;
        };

        let iterationCount = 0;
        let totalIterationsReached = false;
        let lastJ2: any = j;
        let currentResponse: any = j;

        // Outer + inner объединены в один цикл. Первый раз j используется
        // как «текущий ответ»; дальше — j2 из следующих API calls.
        while (iterationCount < MAX_TOTAL_ITERATIONS) {
          iterationCount++;
          // Eugene 2026-05-19 ROOT CAUSE: dual tool_result обязательны для
          // ВСЕХ tool_use блоков иначе 400 от Anthropic.
          messages.push({ role: "assistant", content: currentResponse.content });
          const toolResults: any[] = [];
          for (const block of currentResponse.content) {
            if (block.type === "tool_use") {
              const rejection = checkTool(block.name, block.input);
              if (rejection) {
                console.warn(`[LLM-LOOP] ${block.name} rejected: ${rejection.reason} (iter ${iterationCount})`);
                toolResults.push({ type: "tool_result", tool_use_id: block.id, content: rejection.stub });
                continue;
              }
              const result = await executeTool(block.name, block.input, {
                userId: opts.userId,
                sessionId: opts.sessionId,
                channel: opts.channel,
                role: opts.role,
                ipTrusted: opts.ipTrusted,
              });
              console.log(`[MUZA-TOOL/${opts.channel}/iter${iterationCount}] ${block.name}(${JSON.stringify(block.input).slice(0, 60)}) → ${result.slice(0, 80)}`);
              try { opts.onToolResult?.(block.name, block.input, result); } catch {}
              toolResults.push({ type: "tool_result", tool_use_id: block.id, content: result });
            }
          }
          messages.push({ role: "user", content: toolResults });

          // Следующий API call — даже если общий лимит достигнут, делаем
          // финальный round чтобы Claude засуммировал tool results в текст
          // (иначе вернём undefined через outer-text-extract → fallback).
          if (iterationCount >= MAX_TOTAL_ITERATIONS) {
            totalIterationsReached = true;
            // System nudge — мягко попросить финализировать
            messages.push({ role: "user", content: "Достигнут лимит вызовов tools (6). Используй уже полученные результаты и дай юзеру финальный ответ без новых tool_use." });
          }

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
          if (j2?.stop_reason === "tool_use" && Array.isArray(j2.content) && !totalIterationsReached) {
            // Продолжить с новым tool_use
            currentResponse = j2;
            continue;
          }
          // stop_reason не end_turn и не tool_use — extract text если есть
          const fallbackText = (j2?.content || []).find((b: any) => b.type === "text")?.text;
          if (typeof fallbackText === "string" && fallbackText.length > 0) {
            return fallbackText.slice(0, 2000);
          }
          break;
        }
        // Цикл завершён без return — пробуем text из последнего ответа
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
          // Eugene 2026-05-23: anti-repeat sampling (см. fix DeepSeek/TimeWeb).
          temperature: 0.85,
          frequency_penalty: 0.5,
          presence_penalty: 0.4,
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
