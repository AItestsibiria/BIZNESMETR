// v304 plugin: voice-admin (Eugene 2026-05-17 Босс «голосовой диалог Админ
// ↔ Муза в admin panel»).
//
// Flow:
//   POST /api/admin/v304/voice-command  (multipart: audio file, ≤5 MB)
//     1) Yandex STT  → transcript (RU)
//     2) Unified Muza LLM (admin-voice channel, role='admin', MUZA_TOOLS)
//        → text response + executed tool_calls
//     3) Optional Yandex TTS (?tts=1) → audio/mpeg base64 в response
//   Response shape:
//     { data: {
//         transcript: string,
//         response: string,
//         actions: Array<{ tool: string, input: object, result: string }>,
//         audioBase64?: string,
//         audioContentType?: string,
//       }, error: null }
//
// Rate limit: 30 calls / hour / admin
// Audio cap: 60 sec / 5 MB
// Audit-log: каждый call → admin_audit_log (без сохранения audio, только
//            transcript / response / actions / durationMs).
//
// Безопасность:
//  - requireAdmin guard (Bearer → users.role='admin').
//  - role='admin' прокидывается в ToolContext (admin-only tools пройдут guard).
//  - Yandex API ключи через process.env (нет leak'ов).
//  - PII: audio buffer не сохраняется на диск, только в RAM на время запроса.
//
// Pre-edit analysis:
//  - Не модифицирует существующие endpoint'ы.
//  - Использует уже существующие функции: transcribeRussianAudio,
//    callUnifiedMuzaLLM, synthesizeYandexTts.
//  - LLM-loop с tool_use уже реализован в callUnifiedMuzaLLM — здесь мы
//    дополнительно собираем executed actions через перехват через локальный
//    ToolHandler-wrapper (см. ниже).

import { Router } from "express";
import multer from "multer";
import { sql } from "drizzle-orm";
import fs from "node:fs";
import path from "node:path";
import { db } from "../../storage";
import { requireAdmin } from "../../core/adminAuth";
import { transcribeRussianAudio } from "../../lib/transcribe";
import { synthesizeYandexTts, type YandexVoice } from "../../lib/yandexTts";
import { MUZA_TOOLS, executeTool, filterToolsForRole } from "../../lib/muzaTools";
import { recordAgentActivity } from "../../lib/agentOrchestrator";
import { buildPersonaSystem } from "../../lib/consultantPersona";
import { callUnifiedMuzaLLM } from "../../lib/llmCore";
import {
  getCachedDashboardSummary,
  getCachedClickStats,
  getCachedBrainExport,
} from "../master-dashboard/module";
import { getChannelsStatusSummary } from "../bot-channels-health/module";
import type { Module } from "../../core";

// === Voice picker (Eugene 2026-05-17 Босс): валидация voice + emotion из
// request body. Безопасные defaults (alena / neutral) — back-compat для старых
// клиентов которые не присылают voice. Гард на enum значения чтобы не пропустить
// мусор в Yandex API.
const ALLOWED_VOICES: ReadonlySet<YandexVoice> = new Set<YandexVoice>([
  "alena",
  "jane",
  "oksana",
  "omazh",
  "zahar",
  "ermil",
  "filipp",
  "madirus",
]);
const ALLOWED_EMOTIONS: ReadonlySet<"neutral" | "good" | "evil"> = new Set<
  "neutral" | "good" | "evil"
>(["neutral", "good", "evil"]);

function normalizeVoice(raw: unknown): YandexVoice {
  const v = String(raw || "").toLowerCase().trim() as YandexVoice;
  return ALLOWED_VOICES.has(v) ? v : "alena";
}
function normalizeEmotion(raw: unknown): "neutral" | "good" | "evil" {
  const e = String(raw || "").toLowerCase().trim() as "neutral" | "good" | "evil";
  return ALLOWED_EMOTIONS.has(e) ? e : "neutral";
}

// === Dashboard context injection (Eugene 2026-05-17) ===
//
// Перед LLM-вызовом собираем актуальный snapshot админ-дашборда:
// dashboard-summary (статусы + период-метрики) + brain-export (плагины) +
// click-stats (топ-кликов). Это идёт в systemBlocks как dynamicContext, чтобы
// Муза отвечала ТОЧНЫМИ цифрами а не выдумывала.
//
// Источник всех данных — те же кэшированные функции которые отдают endpoint'ы
// /api/admin/v304/dashboard-summary, /click-stats, /brain-export. TTL 60 сек =
// LLM-call видит свежие данные с небольшим запозданием, и мы не дёргаем БД
// каждый voice-command.

// === Live context cache (Eugene 2026-05-17 Босс «Муза знает текущую
// статистику дашборда — отвечает реальными цифрами, не фантазирует»).
// Кэшируем весь сформированный block 60 сек — это TTL aligned с dashboard
// cache, не дёргаем БД на каждый voice command. Buildup занимает ~10-30 мс
// (несколько prepared statements + read of KB excerpt).
const LIVE_CONTEXT_CACHE_TTL_MS = 60 * 1000;
let liveContextCache: { text: string; expiresAt: number } | null = null;

// === KB excerpt — first 2000 chars из docs/strategy/KNOWLEDGE-BASE-BOT.md.
// Читается один раз на старте process и потом из памяти. Если файла нет —
// возвращаем пустую строку (graceful degradation).
let kbExcerptCache: string | null = null;
function readKbExcerpt(): string {
  if (kbExcerptCache !== null) return kbExcerptCache;
  try {
    // Resolve относительно cwd процесса — pm2 запускает из /var/www/neurohub
    // где docs/ доступны. На dev — относительно repo root.
    const candidates = [
      path.resolve(process.cwd(), "docs/strategy/KNOWLEDGE-BASE-BOT.md"),
      path.resolve(process.cwd(), "../../docs/strategy/KNOWLEDGE-BASE-BOT.md"),
      path.resolve(__dirname, "../../../../docs/strategy/KNOWLEDGE-BASE-BOT.md"),
    ];
    for (const p of candidates) {
      if (fs.existsSync(p)) {
        const raw = fs.readFileSync(p, "utf8");
        kbExcerptCache = raw.slice(0, 2000);
        return kbExcerptCache;
      }
    }
  } catch (e: any) {
    console.warn("[ADMIN-VOICE] readKbExcerpt failed:", e?.message || e);
  }
  kbExcerptCache = "";
  return "";
}

// === Open incidents + recent failures (sync, prepared statements). ===
// Топ-5 incidents (status='open') sort by last_seen_at DESC. Топ-5 user-action
// failures за последний час, group_key + count + message.
function getOpenIncidentsLines(): string[] {
  try {
    const sqlite: any = (db as any).$client;
    const rows = sqlite
      .prepare(
        `SELECT id, kind, severity, title, occurrences, last_seen_at
         FROM incidents
         WHERE status = 'open'
         ORDER BY last_seen_at DESC
         LIMIT 5`,
      )
      .all();
    if (!rows || rows.length === 0) return ["  (нет открытых инцидентов)"];
    return rows.map((r: any) => {
      const sev = String(r.severity || "").toLowerCase();
      const dot = sev === "critical" ? "🔴" : sev === "warning" ? "🟡" : "⚪";
      const title = String(r.title || r.kind || "").slice(0, 80);
      return `  ${dot} #${r.id} ${title} (${r.occurrences}× · last ${String(r.last_seen_at || "").slice(0, 16)})`;
    });
  } catch {
    return ["  (incidents query failed)"];
  }
}

function getRecentFailuresLines(): string[] {
  try {
    const sqlite: any = (db as any).$client;
    const rows = sqlite
      .prepare(
        `SELECT group_key, action, channel, error_code, COUNT(*) AS cnt,
                MAX(error_message) AS last_msg, MAX(created_at) AS last_at
         FROM user_action_failures
         WHERE created_at > datetime('now', '-1 hour')
         GROUP BY group_key
         ORDER BY cnt DESC
         LIMIT 5`,
      )
      .all();
    if (!rows || rows.length === 0) return ["  (нет свежих сбоев за последний час)"];
    return rows.map((r: any) => {
      const msg = String(r.last_msg || "").slice(0, 60);
      return `  - ${r.channel}/${r.action} [${r.error_code || "?"}] ×${r.cnt}: ${msg}`;
    });
  } catch {
    return ["  (failures query failed)"];
  }
}

async function buildDashboardContext(): Promise<string> {
  // Cache hit — return immediately (TTL 60s)
  if (liveContextCache && liveContextCache.expiresAt > Date.now()) {
    return liveContextCache.text;
  }
  try {
    const dashboard = getCachedDashboardSummary("today");
    const clickStats = getCachedClickStats("today");
    const brain = getCachedBrainExport();

    const m = dashboard.metrics;
    const sumRub = Math.round(m.payments.sumKopecks / 100);
    const statusLines = (dashboard.statusCards || [])
      .map((s: any) => `- ${s.emoji} ${s.label}: ${s.status.toUpperCase()} (${s.metric})`)
      .join("\n");
    const allOk = (dashboard.statusCards || []).every((s: any) => s.status === "green");
    const redCount = (dashboard.statusCards || []).filter((s: any) => s.status === "red").length;
    const yellowCount = (dashboard.statusCards || []).filter((s: any) => s.status === "yellow").length;

    const topClicks = (clickStats.topElements || [])
      .slice(0, 5)
      .map(
        (c: any, i: number) =>
          `  ${i + 1}. ${c.elementKey}${c.elementText ? ` («${String(c.elementText).slice(0, 40)}»)` : ""}: ${c.count} кликов, ${c.uniqueUsers} юзеров`,
      )
      .join("\n");

    const incidents = getOpenIncidentsLines();
    const failures = getRecentFailuresLines();

    let channelsBlock = "  (channels status unavailable)";
    try {
      // Channel summary — best-effort. Если упало (LLM probe timeout) — не
      // валим весь context.
      channelsBlock = await getChannelsStatusSummary();
    } catch (e: any) {
      console.warn("[ADMIN-VOICE] channels summary failed:", e?.message || e);
    }

    const kbExcerpt = readKbExcerpt();

    const lines = [
      "[ADMIN DASHBOARD CONTEXT — текущие фактические данные за сегодня]",
      "",
      `Status: ${allOk ? "🟢 все системы OK" : `⚠️ ${redCount} red, ${yellowCount} yellow`}`,
      "",
      "Метрики за сегодня:",
      `- Регистрации: ${m.registrations.total}`,
      `- Прослушивания: ${m.plays.total} (уник IP: ${m.plays.unique}, отброшено: ${m.plays.rejected})`,
      `- Генерации music: ${m.generations.music.done} OK / ${m.generations.music.error} ошибок / ${m.generations.music.processing} в процессе`,
      `- Платежи: ${m.payments.count} шт · ${sumRub} ₽`,
      `- Посетители: уник ${m.visitors.unique} / всего ${m.visitors.total}`,
      `- Скачивания: ${m.downloads.count}`,
      "",
      "Status indicators:",
      statusLines || "  (нет данных)",
      "",
      "Топ-5 кликов сегодня:",
      topClicks || "  (нет данных за сегодня)",
      `Всего кликов сегодня: ${clickStats.totalClicks} (уник юзеров: ${clickStats.uniqueClickers})`,
      "",
      "Открытые инциденты (топ-5):",
      ...incidents,
      "",
      "Свежие сбои юзеров (последний час, топ-5):",
      ...failures,
      "",
      "Каналы (web / Telegram / Max + LLM движок):",
      channelsBlock,
      "",
      "Brain (системная карта):",
      `- Узлов: ${brain.nodesCount}, связей: ${brain.edgesCount}`,
      `- Здоровых плагинов: ${brain.green}, degraded: ${brain.yellow}, упавших: ${brain.red}`,
      brain.topPlugins.length > 0
        ? `- Топ плагины: ${brain.topPlugins.slice(0, 8).join(", ")}`
        : "",
      "",
      kbExcerpt
        ? "Knowledge base (excerpt — первые 2000 chars из KNOWLEDGE-BASE-BOT.md):\n" + kbExcerpt
        : "",
      "",
      `[Snapshot: ${dashboard.generatedAt}; кэш 60 сек]`,
      "",
      "ПРАВИЛО: используй эти цифры в ответе. НЕ выдумывай метрики — они актуальные.",
      "Если Босс просит число которого здесь НЕТ — скажи это явно или вызови tool get_metrics.",
      "ОБЩАЙСЯ как опытный коллега. Не задавай встречных вопросов «что вы хотите» — у тебя",
      "весь контекст. Используй цифры. Без markdown заголовков, без буллетов.",
      "Кратко (1-3 предложения для голосового ответа).",
    ];
    const text = lines.filter((s) => s !== "").join("\n");
    liveContextCache = { text, expiresAt: Date.now() + LIVE_CONTEXT_CACHE_TTL_MS };
    return text;
  } catch (e: any) {
    console.warn("[ADMIN-VOICE] buildDashboardContext failed:", e?.message || e);
    return "[ADMIN DASHBOARD CONTEXT: не удалось собрать snapshot — используй tools get_metrics для актуальных данных]";
  }
}

// === Auto-focus map (Eugene 2026-05-17 «вязка со вторым мозгом») ===
//
// Когда LLM вызывает data-tool (read-only) — добавляем подсказку какой узел
// в 3D «Втором мозге» следует подсветить. Frontend (musa-voice-fab) парсит
// action.brainFocus и эмитит CustomEvent 'brain-focus-node' параллельно с
// существующим focus_brain_node tool.
const TOOL_TO_BRAIN_NODE: Record<string, string> = {
  get_metrics: "Аналитика",
  get_failed_users: "Юзеры",
  query_users: "Юзеры",
  get_recent_payments: "Платежи",
  get_recent_incidents: "Incidents",
  get_bot_channels_status: "Telegram",
  reload_kb: "KnowledgeBase",
  send_telegram_alert: "Telegram",
  pause_bot: "Telegram",
  kick_session: "Sessions",
  change_registration_status: "Auth",
};

function enrichActionsWithBrainFocus(
  actions: Array<{ tool: string; input: any; result: string }>,
): Array<{ tool: string; input: any; result: string; brainFocus?: { nodeName: string } }> {
  return actions.map((a) => {
    const nodeName = TOOL_TO_BRAIN_NODE[a.tool];
    if (nodeName) return { ...a, brainFocus: { nodeName } };
    return a;
  });
}

// === Multer (memoryStorage, max 5 MB) ===
const MAX_AUDIO_BYTES = 5 * 1024 * 1024;
// Eugene 2026-05-24 voice-admin fix: расширен список (iOS Safari использует
// audio/mp4 + variant audio/aac / audio/x-m4a). Случаются также blob'ы с
// type='application/octet-stream' когда browser не выставил MIME —
// разрешаем их с fallback-detection через ffmpeg (он сам определит).
const ALLOWED_MIMES = new Set([
  "audio/webm",
  "audio/ogg",
  "audio/opus",
  "audio/mpeg",
  "audio/mp3",
  "audio/wav",
  "audio/wave",
  "audio/x-wav",
  "audio/mp4",
  "audio/m4a",
  "audio/x-m4a",
  "audio/aac",
  "audio/aacp",
  "audio/3gpp",
  "audio/3gpp2",
  "application/octet-stream",
]);

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_AUDIO_BYTES },
});

// === Rate limit: 30 calls / hour / admin ===
const VOICE_RATE_LIMIT = 30;
const VOICE_RATE_WINDOW_MS = 60 * 60_000;
const voiceRateMap = new Map<string, { count: number; resetAt: number }>();

function voiceRateOk(key: string): boolean {
  const now = Date.now();
  const e = voiceRateMap.get(key);
  if (!e || e.resetAt < now) {
    voiceRateMap.set(key, { count: 1, resetAt: now + VOICE_RATE_WINDOW_MS });
    return true;
  }
  if (e.count >= VOICE_RATE_LIMIT) return false;
  e.count++;
  return true;
}

// === Admin-voice LLM call ===
// Лёгкая локальная реализация tool-loop, чтобы собрать ACTIONS (список tool +
// input + result). callUnifiedMuzaLLM свой loop делает но не возвращает
// перечень executed tools — здесь нам это важно для UI «список выполненных
// действий». Использует те же MUZA_TOOLS, передаёт role='admin' через ToolContext.

interface AdminVoiceResult {
  responseText: string;
  actions: Array<{ tool: string; input: any; result: string }>;
  usage: { inputTokens: number; outputTokens: number };
}

async function callAdminVoiceLLM(opts: {
  userId: number;
  sessionId: string;
  transcript: string;
  dialogMode?: boolean;
  previousResponseTruncatedAt?: number;
}): Promise<AdminVoiceResult> {
  const actions: Array<{ tool: string; input: any; result: string }> = [];
  let inputTokens = 0;
  let outputTokens = 0;

  // Eugene 2026-05-20 (backend-audit fix #2): передаём isAdmin=true — иначе
  // persona ставит user-zone ограничения («не отвечай на технические темы»)
  // и LLM «отказывается» отвечать → пустой ответ → fallback string.
  const stable = buildPersonaSystem(opts.sessionId, "consultant", true);
  // Dialog mode (Eugene 2026-05-17 Босс «continuous conversation»):
  // более короткий промпт + приоритет tool calls + минимум воды. Юзер слышит
  // ответ голосом в continuous loop — длинные тексты утомят.
  const baseLines = [
    "[ADMIN-VOICE MODE]",
    "Сейчас ты разговариваешь с Боссом голосом в admin-panel.",
    "Тон: коротко, по-деловому, без эмодзи в озвучке.",
    "Тебе доступны ADMIN-ONLY tools — используй их когда Босс просит данные или действия:",
    "get_metrics, get_failed_users, reload_kb, send_telegram_alert,",
    "change_registration_status, query_users, get_recent_payments,",
    "pause_bot, kick_session, get_recent_incidents, focus_brain_node.",
    "Если Босс просит что-то деструктивное (kick_session, change_registration_status,",
    "pause_bot) — сначала озвучь что собираешься сделать, потом выполни.",
    "Ответ озвучивается через TTS — пиши простыми фразами, без markdown.",
  ];
  if (opts.dialogMode) {
    baseLines.push(
      "",
      "[DIALOG MODE — CONTINUOUS CONVERSATION]",
      "Это live-диалог: Босс говорит, ты отвечаешь, цикл повторяется без пауз.",
      "ЖЁСТКОЕ ПРАВИЛО: ответ — 1-2 коротких предложения, максимум 25 слов.",
      "Приоритет tool calls над многословием: если можешь вызвать tool — вызови сразу.",
      "Если уместно показать визуальный фокус — вызывай focus_brain_node параллельно с data-tool.",
      "Никаких «Конечно, Босс» / «Сейчас посмотрю» — сразу к делу.",
    );
    if (opts.previousResponseTruncatedAt && opts.previousResponseTruncatedAt > 0) {
      baseLines.push(
        "",
        `[INTERRUPTION] Предыдущий твой ответ был прерван Боссом на ~${opts.previousResponseTruncatedAt}мс воспроизведения — он не дослушал. Учти контекст: возможно он переспрашивает то же или поправляет.`,
      );
    }
  }
  const modeContext = baseLines.join("\n");

  // Свежий dashboard snapshot (cached 60 сек). Inject как отдельный
  // system-block — модель видит фактические цифры до начала reasoning'а.
  const dashboardContext = await buildDashboardContext();

  const systemBlocks: any[] = [
    { type: "text", text: stable, cache_control: { type: "ephemeral", ttl: "1h" } },
    { type: "text", text: modeContext },
    { type: "text", text: dashboardContext },
  ];

  const messages: any[] = [
    {
      role: "user",
      content: `<user_message>${String(opts.transcript || "").replace(/<\/?user_message>/gi, "")}</user_message>`,
    },
  ];

  // Anthropic key chain inline (sample — берём первый рабочий из 3-х)
  const keyCandidates = [
    process.env.ANTHROPIC_API_KEY,
    process.env.ANTHROPIC_API_KEY_BACKUP,
    process.env.ANTHROPIC_API_KEY_BOT,
  ].filter((k): k is string => !!k);

  if (keyCandidates.length === 0) {
    return {
      responseText: "Ключей Anthropic нет — не могу ответить. Проверь .env.",
      actions,
      usage: { inputTokens: 0, outputTokens: 0 },
    };
  }

  const model = process.env.ADMIN_VOICE_MODEL || "claude-haiku-4-5-20251001";
  // Dialog mode → shorter cap (1-2 предложения хватит 200 токенов), faster
  // streaming → faster TTS playback → tighter conversation loop.
  const maxTokens = opts.dialogMode ? 220 : 600;

  // TODO (Eugene 2026-05-20): voice-admin использует свой собственный
  // Anthropic-tool-use loop с tool_choice=none fallback. Босс попросил
  // реверс LLM (TimeWeb primary, Anthropic fallback) — для main Музы
  // (lib/llmCore.ts) уже сделано. Для admin-voice оставляем Anthropic
  // primary ВРЕМЕННО: tool_choice + voice-admin specific tool semantics
  // требуют Anthropic-native API; миграция на TimeWeb (OpenAI-compat без
  // tool_choice) — отдельная задача.

  // Eugene 2026-05-20 (backend-audit fix #1): filterToolsForRole('admin')
  // вместо raw MUZA_TOOLS — это включает ВСЕ tools (admin-only + user-zone)
  // и устраняет шум для tool-selection. Раньше LLM могла выбрать irrelevant
  // user-tool (save_song_draft) когда Босс просил admin-метрики.
  const adminTools = filterToolsForRole("admin");

  // Eugene 2026-05-20 (backend-audit fix #3): tool-loop dedupe — break если
  // tool вызван 3+ раз с одинаковыми параметрами (Claude зацикливается).
  // Раньше while(loopIter<5) крутился 5 итераций × 20сек = 100сек → юзер
  // получал fallback string «не получилось», хотя ключи живы.
  const toolCallCounts = new Map<string, number>();
  const toolKey = (name: string, input: any): string => {
    try { return `${name}::${JSON.stringify(input).slice(0, 200)}`; } catch { return name; }
  };

  for (const key of keyCandidates) {
    try {
      let loopIter = 0;
      while (loopIter < 5) {
        loopIter++;
        const r = await fetch("https://api.anthropic.com/v1/messages", {
          method: "POST",
          headers: {
            "x-api-key": key,
            "anthropic-version": "2023-06-01",
            "content-type": "application/json",
          },
          body: JSON.stringify({
            model,
            max_tokens: maxTokens,
            system: systemBlocks,
            messages,
            tools: adminTools,
          }),
          signal: AbortSignal.timeout(20_000),
        });
        if (!r.ok) {
          const t = await r.text().catch(() => "");
          console.warn(`[ADMIN-VOICE-LLM] ${r.status}: ${t.slice(0, 150)}`);
          break; // пробуем следующий ключ
        }
        const j: any = await r.json();
        if (j?.usage) {
          inputTokens += Number(j.usage.input_tokens || 0) + Number(j.usage.cache_read_input_tokens || 0);
          outputTokens += Number(j.usage.output_tokens || 0);
        }
        if (j?.stop_reason === "tool_use" && Array.isArray(j.content)) {
          messages.push({ role: "assistant", content: j.content });
          const toolResults: any[] = [];
          let forceBreakAfterThis = false;
          for (const block of j.content) {
            if (block.type === "tool_use") {
              // Eugene 2026-05-20 dedupe: считаем вызовы по (name,input).
              // 3+ повторов → стаб результат + breakout, чтобы избежать
              // зацикливания Claude (5 итераций × 20сек = 100сек fail).
              const tkey = toolKey(block.name, block.input);
              const cnt = (toolCallCounts.get(tkey) || 0) + 1;
              toolCallCounts.set(tkey, cnt);
              let result: string;
              if (cnt > 2) {
                result = "Стоп: этот tool уже вызван 3+ раз с теми же параметрами. Используй полученные данные и отвечай Боссу.";
                forceBreakAfterThis = true;
              } else {
                result = await executeTool(block.name, block.input, {
                  userId: opts.userId,
                  sessionId: opts.sessionId,
                  channel: "admin-voice",
                  role: "admin",
                });
              }
              actions.push({ tool: block.name, input: block.input || {}, result: String(result).slice(0, 1500) });
              toolResults.push({ type: "tool_result", tool_use_id: block.id, content: result });
            }
          }
          messages.push({ role: "user", content: toolResults });
          if (forceBreakAfterThis) {
            // Финальный call с tool_choice=none — модель ОБЯЗАНА вернуть текст
            // (не tool_use). Без этого fallback на «Не получилось».
            try {
              const r2 = await fetch("https://api.anthropic.com/v1/messages", {
                method: "POST",
                headers: { "x-api-key": key, "anthropic-version": "2023-06-01", "content-type": "application/json" },
                body: JSON.stringify({ model, max_tokens: maxTokens, system: systemBlocks, messages, tools: adminTools, tool_choice: { type: "none" } }),
                signal: AbortSignal.timeout(20_000),
              });
              if (r2.ok) {
                const j2: any = await r2.json();
                if (j2?.usage) { inputTokens += Number(j2.usage.input_tokens || 0); outputTokens += Number(j2.usage.output_tokens || 0); }
                const text2 = (j2?.content || []).find((b: any) => b.type === "text")?.text || "";
                if (text2) return { responseText: String(text2).slice(0, 2000), actions, usage: { inputTokens, outputTokens } };
              }
            } catch {}
            break;
          }
          continue;
        }
        // end_turn
        const text = (j?.content || []).find((b: any) => b.type === "text")?.text || "";
        return {
          responseText: String(text).slice(0, 2000),
          actions,
          usage: { inputTokens, outputTokens },
        };
      }
    } catch (e: any) {
      console.warn(`[ADMIN-VOICE-LLM] exception:`, e?.message || e);
      continue;
    }
  }

  // Eugene 2026-05-25 Босс «смена Ai: если какой-то не работает — сразу
  // другой». Все Anthropic-ключи упали → фолбэк на унифицированную цепочку
  // (TimeWeb приоритет → DeepSeek → YandexGPT). Без tools, но юзер получает
  // настоящий текстовый ответ вместо «все ключи Claude недоступны».
  try {
    const fallbackText = await callUnifiedMuzaLLM({
      sessionId: opts.sessionId,
      channel: "admin-voice",
      userText: opts.transcript,
      role: "admin",
    });
    if (fallbackText && fallbackText.trim()) {
      return { responseText: String(fallbackText).slice(0, 2000), actions, usage: { inputTokens, outputTokens } };
    }
  } catch (e: any) {
    console.warn("[ADMIN-VOICE-LLM] unified fallback error:", e?.message || e);
  }

  return {
    responseText: "Не получилось обработать запрос — все AI-провайдеры временно недоступны. Попробуй ещё раз через минуту.",
    actions,
    usage: { inputTokens, outputTokens },
  };
}

const router = Router();

// === POST /api/admin/v304/voice-command ===
router.post(
  "/voice-command",
  requireAdmin,
  upload.single("audio"),
  async (req: any, res) => {
    const startedAt = Date.now();
    const userId: number = req.userId;
    const adminUser = req.adminUser;
    const file = req.file as Express.Multer.File | undefined;

    // Rate limit
    const rateKey = `u:${userId}`;
    if (!voiceRateOk(rateKey)) {
      return res
        .status(429)
        .json({ data: null, error: `rate-limit: ${VOICE_RATE_LIMIT} voice-commands per hour` });
    }

    if (!file) {
      return res
        .status(400)
        .json({ data: null, error: "Файл не получен (поле 'audio')" });
    }
    if (file.size > MAX_AUDIO_BYTES) {
      return res
        .status(413)
        .json({ data: null, error: `Файл больше ${MAX_AUDIO_BYTES / 1024 / 1024} MB` });
    }
    const baseMime = (file.mimetype || "").split(";")[0].trim().toLowerCase();
    if (!ALLOWED_MIMES.has(baseMime)) {
      // Eugene 2026-05-24 voice-admin fix: best-effort вместо жёсткого reject.
      // Yandex/ffmpeg сами разберутся через magic-bytes. Просто логируем.
      console.warn(`[ADMIN-VOICE] unusual mime accepted: ${file.mimetype}`);
    }
    // Eugene 2026-05-24 voice-admin fix: 500B → 200B минимум. Короткие фразы
    // на iOS Safari (≈1 сек "покажи метрики") могут давать 600B-1.2KB mp4.
    // Yandex STT всё равно отбросит пустоту — это лишь sanity guard от bug'ов
    // recorder (empty blob).
    if (file.size < 200) {
      return res
        .status(400)
        .json({
          data: null,
          error: `Микрофон отдал пустую запись (${file.size} B). Проверь mute / permission и попробуй заново — говори ≥1 сек.`,
        });
    }

    // Eugene 2026-05-24 voice-admin fix: ext выбираем по реальному MIME, а не
    // фиксированному "webm" — для OpenAI/GPTunnel Whisper это критично
    // (multipart filename влияет на server-side parser).
    const ext = baseMime.includes("mp4") || baseMime.includes("m4a") ? "m4a"
      : baseMime.includes("ogg") || baseMime.includes("opus") ? "ogg"
      : baseMime.includes("wav") ? "wav"
      : baseMime.includes("mpeg") || baseMime.includes("mp3") ? "mp3"
      : "webm";

    // 1) STT
    let transcript = "";
    try {
      const r = await transcribeRussianAudio(file.buffer, baseMime || "audio/webm", ext);
      transcript = String(r.transcript || "").trim();
      if (!transcript) {
        // Diagnose: соберём attempt-summary в error (для логов / админ-debug)
        const summary = (r.attempts || [])
          .map((a: any) => `${a.provider}:${a.ok ? "ok" : (a.error || "fail").toString().slice(0, 80)}`)
          .join(" · ");
        return res.status(422).json({
          data: null,
          error: `STT: речь не распознана. Говори громче, ближе к микрофону, ≥2 сек. [${summary || "no providers"}]`,
        });
      }
    } catch (e: any) {
      console.error("[ADMIN-VOICE] STT exception:", e?.message || e);
      return res
        .status(500)
        .json({ data: null, error: `STT error: ${String(e?.message || e).slice(0, 120)}` });
    }

    // 2) LLM (с admin-tools)
    const sessionId = `admin-voice:${userId}`;
    let llmResult: AdminVoiceResult;
    try {
      llmResult = await callAdminVoiceLLM({ userId, sessionId, transcript });
    } catch (e: any) {
      console.error("[ADMIN-VOICE] LLM exception:", e?.message || e);
      return res
        .status(500)
        .json({ data: null, error: `LLM error: ${String(e?.message || e).slice(0, 120)}` });
    }

    // 3) Optional TTS
    // Voice picker (Eugene 2026-05-17): voice + emotion из body (multipart text
    // fields), back-compat default alena/neutral. Гард через normalizeVoice /
    // normalizeEmotion — мусор в БД не попадает.
    const ttsVoice = normalizeVoice(req.body?.voice);
    const ttsEmotion = normalizeEmotion(req.body?.emotion);
    let audioBase64: string | undefined;
    let audioContentType: string | undefined;
    const wantTts = String(req.query.tts || "").trim() === "1";
    if (wantTts && llmResult.responseText) {
      try {
        const tts = await synthesizeYandexTts({
          text: llmResult.responseText.slice(0, 4500),
          voice: ttsVoice,
          emotion: ttsEmotion,
          format: "mp3",
        });
        if (tts.ok && tts.audio) {
          audioBase64 = tts.audio.toString("base64");
          audioContentType = tts.contentType || "audio/mpeg";
        }
      } catch (e: any) {
        // TTS — best-effort; не валим весь request если TTS упал
        console.warn("[ADMIN-VOICE] TTS failed:", e?.message || e);
      }
    }

    const durationMs = Date.now() - startedAt;

    // 4) Enriched audit-log (Eugene 2026-05-17).
    //    - НЕ сохраняем audio (PII), только transcript/response/actions/meta.
    //    - Чётко разделяем executedActions (изменили данные: kick_session,
    //      change_registration_status, pause_bot, send_telegram_alert, reload_kb,
    //      ...) и readonlyActions (только чтение: get_metrics, query_users,
    //      get_recent_payments, get_recent_incidents, get_failed_users).
    //    - Добавляем IP + UA для трассировки, флаг contextInjected (snapshot
    //      dashboard был включён в LLM call).
    //    - Limit transcript/response 800/2000 chars — больше не сохраняем,
    //      это admin-voice, не длинный диалог.
    const MUTATING_TOOLS = new Set([
      "kick_session",
      "change_registration_status",
      "pause_bot",
      "send_telegram_alert",
      "reload_kb",
    ]);
    const executedActions = llmResult.actions
      .filter((a) => MUTATING_TOOLS.has(a.tool))
      .map((a) => ({
        tool: a.tool,
        input: a.input,
        result: String(a.result).slice(0, 300),
      }));
    const readonlyActions = llmResult.actions
      .filter((a) => !MUTATING_TOOLS.has(a.tool))
      .map((a) => ({
        tool: a.tool,
        input: a.input,
        result: String(a.result).slice(0, 200),
      }));

    const clientIp =
      String(
        (req.headers["x-forwarded-for"] || "")
          .toString()
          .split(",")[0]
          .trim() ||
          req.ip ||
          "",
      ).slice(0, 64) || null;
    const clientUa = String(req.headers["user-agent"] || "").slice(0, 200) || null;

    try {
      db.run(sql`INSERT INTO admin_audit_log
        (admin_user_id, admin_email, action, entity, entity_key, before_json, after_json)
        VALUES (
          ${userId},
          ${adminUser?.email ?? null},
          'create',
          'voice-admin:command',
          ${sessionId},
          ${null},
          ${JSON.stringify({
            transcript: transcript.slice(0, 800),
            response: llmResult.responseText.slice(0, 2000),
            executedActions,
            readonlyActions,
            actionsTotal: llmResult.actions.length,
            actionsMutating: executedActions.length,
            actionsReadonly: readonlyActions.length,
            durationMs,
            ttsRequested: wantTts,
            ttsBytes: audioBase64 ? Math.round((audioBase64.length * 3) / 4) : 0,
            audioBytes: file.size,
            audioMime: baseMime,
            usage: llmResult.usage,
            contextInjected: true,
            clientIp,
            clientUa,
          })}
        )`);
    } catch (e: any) {
      console.warn("[ADMIN-VOICE] audit-log failed:", e?.message || e);
    }

    try { recordAgentActivity("muza-voice"); recordAgentActivity("muza-admin"); } catch {}
    return res.json({
      data: {
        transcript,
        response: llmResult.responseText,
        actions: enrichActionsWithBrainFocus(llmResult.actions),
        ...(audioBase64
          ? { audioBase64, audioContentType }
          : {}),
        meta: {
          durationMs,
          usage: llmResult.usage,
          ttsRequested: wantTts,
        },
      },
      error: null,
    });
  },
);

// === POST /api/admin/v304/voice-command-text ===
// Eugene 2026-05-17: альтернативный путь через Web Speech API — браузер
// сам распознаёт речь (iOS Safari = Siri-engine, Chrome = Google STT) и
// шлёт уже готовый transcript. Минует MediaRecorder + Yandex STT —
// решает баг «запись слишком короткая» на iOS.
router.post("/voice-command-text", requireAdmin, async (req: any, res) => {
  const startedAt = Date.now();
  const userId: number = req.userId;
  const adminUser = req.adminUser;

  const rateKey = `u:${userId}`;
  if (!voiceRateOk(rateKey)) {
    return res.status(429).json({ data: null, error: `rate-limit: ${VOICE_RATE_LIMIT} voice-commands per hour` });
  }

  const transcript = String(req.body?.transcript || "").trim().slice(0, 2000);
  if (!transcript || transcript.length < 2) {
    return res.status(400).json({ data: null, error: "Пустой transcript — ничего не распознано" });
  }
  // Eugene 2026-05-17 Босс «режим диалога»: dialogMode=true → короткие
  // ответы 1-2 предложения, более агрессивный приоритет tool calls.
  // previousResponseTruncatedAt — метка barge-in (юзер прервал предыдущий
  // TTS playback на этой позиции в мс).
  const dialogMode = req.body?.dialogMode === true;
  const previousResponseTruncatedAt =
    typeof req.body?.previousResponseTruncatedAt === "number"
      ? Math.max(0, Math.floor(req.body.previousResponseTruncatedAt))
      : undefined;

  const sessionId = `admin-voice:${userId}`;
  let llmResult: AdminVoiceResult;
  try {
    llmResult = await callAdminVoiceLLM({
      userId,
      sessionId,
      transcript,
      dialogMode,
      previousResponseTruncatedAt,
    });
  } catch (e: any) {
    console.error("[ADMIN-VOICE-TEXT] LLM exception:", e?.message || e);
    return res.status(500).json({ data: null, error: `LLM error: ${String(e?.message || e).slice(0, 120)}` });
  }

  // Voice picker (Eugene 2026-05-17): voice + emotion из JSON body, гард через
  // normalize* (back-compat default alena/neutral).
  const ttsVoiceText = normalizeVoice(req.body?.voice);
  const ttsEmotionText = normalizeEmotion(req.body?.emotion);
  let audioBase64: string | undefined;
  let audioContentType: string | undefined;
  const wantTts = String(req.query.tts || "").trim() === "1";
  if (wantTts && llmResult.responseText) {
    try {
      const tts = await synthesizeYandexTts({
        text: llmResult.responseText.slice(0, 4500),
        voice: ttsVoiceText,
        emotion: ttsEmotionText,
        format: "mp3",
      });
      if (tts.ok && tts.audio) {
        audioBase64 = tts.audio.toString("base64");
        audioContentType = tts.contentType || "audio/mpeg";
      }
    } catch (e: any) {
      console.warn("[ADMIN-VOICE-TEXT] TTS failed:", e?.message || e);
    }
  }

  const durationMs = Date.now() - startedAt;

  const MUTATING_TOOLS = new Set(["kick_session", "change_registration_status", "pause_bot", "send_telegram_alert", "reload_kb"]);
  const executedActions = llmResult.actions.filter(a => MUTATING_TOOLS.has(a.tool)).map(a => ({ tool: a.tool, input: a.input, result: String(a.result).slice(0, 300) }));
  const readonlyActions = llmResult.actions.filter(a => !MUTATING_TOOLS.has(a.tool)).map(a => ({ tool: a.tool, input: a.input, result: String(a.result).slice(0, 200) }));
  const clientIp = String((req.headers["x-forwarded-for"] || "").toString().split(",")[0].trim() || req.ip || "").slice(0, 64) || null;
  const clientUa = String(req.headers["user-agent"] || "").slice(0, 200) || null;

  try {
    db.run(sql`INSERT INTO admin_audit_log
      (admin_user_id, admin_email, action, entity, entity_key, before_json, after_json)
      VALUES (${userId}, ${adminUser?.email ?? null}, 'create', 'voice-admin:command-text', ${sessionId}, ${null},
        ${JSON.stringify({
          transcript: transcript.slice(0, 800),
          response: llmResult.responseText.slice(0, 2000),
          executedActions, readonlyActions,
          actionsTotal: llmResult.actions.length,
          actionsMutating: executedActions.length,
          actionsReadonly: readonlyActions.length,
          durationMs, ttsRequested: wantTts,
          ttsBytes: audioBase64 ? Math.round((audioBase64.length * 3) / 4) : 0,
          source: 'web-speech-api',
          usage: llmResult.usage, contextInjected: true, clientIp, clientUa,
        })})`);
  } catch (e: any) {
    console.warn("[ADMIN-VOICE-TEXT] audit-log failed:", e?.message || e);
  }

  return res.json({
    data: {
      transcript,
      response: llmResult.responseText,
      actions: enrichActionsWithBrainFocus(llmResult.actions),
      ...(audioBase64 ? { audioBase64, audioContentType } : {}),
      meta: {
        durationMs,
        usage: llmResult.usage,
        ttsRequested: wantTts,
        source: 'web-speech-api',
        dialogMode,
        ...(typeof previousResponseTruncatedAt === "number" ? { previousResponseTruncatedAt } : {}),
      },
    },
    error: null,
  });
});

// === GET /api/admin/v304/voice-command/recent ===
// Последние N voice-commands из audit-log (для UI «история диалогов»).
router.get("/voice-command/recent", requireAdmin, (req, res) => {
  try {
    const limit = Math.max(1, Math.min(50, Number(req.query.limit) || 5));
    const sqlite: any = (db as any).$client;
    const rows = sqlite
      .prepare(
        `SELECT id, admin_user_id, created_at, after_json
         FROM admin_audit_log
         WHERE entity = 'voice-admin:command'
         ORDER BY id DESC
         LIMIT ?`,
      )
      .all(limit);
    const items = (rows || []).map((r: any) => {
      let parsed: any = null;
      try {
        parsed = JSON.parse(r.after_json || "{}");
      } catch {
        /* ignore */
      }
      // Backward-compat: старые записи имели `actions`, новые разделяют на
      // executedActions (mutating) + readonlyActions. Объединяем для UI.
      const exec = Array.isArray(parsed?.executedActions) ? parsed.executedActions : [];
      const readonly = Array.isArray(parsed?.readonlyActions) ? parsed.readonlyActions : [];
      const legacyActions = Array.isArray(parsed?.actions) ? parsed.actions : [];
      const mergedActions = exec.length || readonly.length ? [...exec, ...readonly] : legacyActions;
      return {
        id: r.id,
        adminUserId: r.admin_user_id,
        createdAt: r.created_at,
        transcript: parsed?.transcript || "",
        response: parsed?.response || "",
        actions: mergedActions,
        executedActions: exec,
        readonlyActions: readonly,
        actionsMutating: parsed?.actionsMutating ?? exec.length,
        durationMs: parsed?.durationMs,
      };
    });
    res.json({ data: { items }, error: null });
  } catch (err) {
    res
      .status(500)
      .json({ data: null, error: err instanceof Error ? err.message : "internal" });
  }
});

const voiceAdminModule: Module = {
  name: "voice-admin",
  version: "0.1.0",
  description:
    "Voice-команды Админ ↔ Муза (STT → LLM с admin-tools → TTS). POST /api/admin/v304/voice-command, GET /voice-command/recent.",
  routes: { prefix: "admin/v304", router },
  publishes: [],
  onLoad: async (ctx) => {
    ctx.logger.info(
      "voice-admin online — POST /api/admin/v304/voice-command (rate 30/h, 5 MB cap, audit-logged)",
    );
  },
  healthCheck: () => ({ status: "ok" }),
};

export default voiceAdminModule;
