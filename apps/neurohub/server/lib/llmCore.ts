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
 * Единственный путь к Claude для Музы. Возвращает text-ответ либо null,
 * если все ключи упали / API недоступен. Никаких hardcoded fallback-строк —
 * выбор fallback'а делает caller (web /muza/chat / TG webhook / Max webhook).
 *
 * Tool-use loop:
 *   1. Шлём messages + tools=MUZA_TOOLS
 *   2. Если stop_reason="tool_use" — выполняем tools, добавляем результаты,
 *      делаем следующий call. Max 4 итерации.
 *   3. На end_turn — возвращаем текст.
 */
export async function callUnifiedMuzaLLM(opts: UnifiedLLMOpts): Promise<string | null> {
  const attempts = listAnthropicKeys();
  if (attempts.length === 0) return null;

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
  const messages: any[] = [
    ...history.slice(-15).map(h => ({ role: h.role, content: h.content })),
    { role: "user", content: safeUserText },
  ];

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

  for (let i = 0; i < attempts.length; i++) {
    const { name, key } = attempts[i];
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
        // Если LLM зовёт один и тот же tool >2 раз подряд (обычно
        // признак залипания / неправильного интерпретирования результата)
        // — принудительно ломаем loop и возвращаем то что есть.
        // Защищает от token-burn и infinite-loop пытания.
        const toolCallCounts = new Map<string, number>();
        let forceBreak = false;
        messages.push({ role: "assistant", content: j.content });
        const toolResults: any[] = [];
        for (const block of j.content) {
          if (block.type === "tool_use") {
            const cnt = (toolCallCounts.get(block.name) || 0) + 1;
            toolCallCounts.set(block.name, cnt);
            if (cnt > 2) {
              console.warn(`[LLM-LOOP] Tool '${block.name}' called ${cnt}x — forcing break`);
              forceBreak = true;
              break;
            }
            const result = await executeTool(block.name, block.input, {
              userId: opts.userId,
              sessionId: opts.sessionId,
              channel: opts.channel,
              role: opts.role,
            });
            console.log(`[MUZA-TOOL/${opts.channel}] ${block.name}(${JSON.stringify(block.input).slice(0, 60)}) → ${result.slice(0, 80)}`);
            toolResults.push({ type: "tool_result", tool_use_id: block.id, content: result });
          }
        }
        messages.push({ role: "user", content: toolResults });
        let loopIter = 0;
        while (!forceBreak && loopIter < 4) {
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
                  console.warn(`[LLM-LOOP] Tool '${block.name}' called ${cnt}x — forcing break`);
                  innerForceBreak = true;
                  break;
                }
                const result = await executeTool(block.name, block.input, {
                  userId: opts.userId,
                  sessionId: opts.sessionId,
                  channel: opts.channel,
                  role: opts.role,
                });
                console.log(`[MUZA-TOOL-${loopIter}/${opts.channel}] ${block.name} → ${result.slice(0, 60)}`);
                tr.push({ type: "tool_result", tool_use_id: block.id, content: result });
              }
            }
            messages.push({ role: "user", content: tr });
            if (innerForceBreak) break;
            continue;
          }
          break;
        }
      }
      const c = j?.content?.[0]?.text;
      if (typeof c === "string" && c.length > 0) {
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

  // === TimeWeb Gateway fallback (Eugene 2026-05-16 «основной резерв») ===
  // Все Anthropic-ключи упали — пробуем TimeWeb. Без MUZA_TOOLS (gateway
  // обычно не поддерживает Anthropic-tools); возвращаем чистый text.
  if (process.env.TIMEWEB_GATEWAY_KEY) {
    try {
      // OpenAI-compatible system — сворачиваем cache-blocks в один string.
      const sysText = systemBlocks.map(b => (typeof b === "string" ? b : (b?.text || ""))).join("\n\n");
      const tw = await callTimeWebGateway({
        systemPrompt: sysText,
        history: history.slice(-15),
        userText: safeUserText,
        maxTokens,
        model: process.env.TIMEWEB_GATEWAY_MODEL || "gpt-4o-mini",
      });
      if (tw.usage) {
        // OpenAI-формат: prompt_tokens / completion_tokens
        muzaTokenStats.inputTokens += Number(tw.usage.prompt_tokens || 0);
        muzaTokenStats.outputTokens += Number(tw.usage.completion_tokens || 0);
        muzaTokenStats.callsCount += 1;
      }
      if (tw.text && tw.text.length > 0) {
        // Уведомим админа — все Claude-ключи упали, перешли на TimeWeb.
        if (prevFailed) {
          notifyAdminKeySwitch({
            at: new Date().toISOString(),
            provider: "Anthropic → TimeWeb fallback",
            from: prevFailed.name,
            fromStatus: prevFailed.status,
            to: "TIMEWEB_GATEWAY_KEY",
            reason: `все Claude-ключи упали, TimeWeb endpoint=${tw.endpoint}`,
          }).catch(() => {});
        }
        return tw.text;
      }
      // Eugene 2026-05-18 audit: TimeWeb вернул пустой text → залогировать
      // (раньше было silent return null → админ слепой).
      console.warn("[MUZA-LLM] TimeWeb returned empty text — endpoint:", tw.endpoint || "?");
      setLLMKeyStatus("TIMEWEB_GATEWAY_KEY", { lastUsedAt: new Date().toISOString(), lastStatus: "error", lastErrorMsg: "empty response" });
    } catch (e: any) {
      console.warn("[MUZA-LLM] TimeWeb fallback error:", String(e?.message || e));
      setLLMKeyStatus("TIMEWEB_GATEWAY_KEY", { lastUsedAt: new Date().toISOString(), lastStatus: "error", lastErrorMsg: String(e?.message || e).slice(0, 200) });
    }
  } else {
    // Eugene 2026-05-18 audit: TimeWeb ключ пустой → залогировать (раньше silent).
    console.warn("[MUZA-LLM] TimeWeb fallback skipped: TIMEWEB_GATEWAY_KEY not configured");
  }
  return null;
}
