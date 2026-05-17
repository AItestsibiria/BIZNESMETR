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
import { db } from "../../storage";
import { requireAdmin } from "../../core/adminAuth";
import { transcribeRussianAudio } from "../../lib/transcribe";
import { synthesizeYandexTts } from "../../lib/yandexTts";
import { MUZA_TOOLS, executeTool } from "../../lib/muzaTools";
import { buildPersonaSystem } from "../../lib/consultantPersona";
import {
  getCachedDashboardSummary,
  getCachedClickStats,
  getCachedBrainExport,
} from "../master-dashboard/module";
import type { Module } from "../../core";

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

function buildDashboardContext(): string {
  try {
    const dashboard = getCachedDashboardSummary("today");
    const clickStats = getCachedClickStats("today");
    const brain = getCachedBrainExport();

    const m = dashboard.metrics;
    const sumRub = Math.round(m.payments.sumKopecks / 100);
    const statusLines = (dashboard.statusCards || [])
      .map((s) => `- ${s.emoji} ${s.label}: ${s.status.toUpperCase()} (${s.metric})`)
      .join("\n");
    const allOk = (dashboard.statusCards || []).every((s) => s.status === "green");
    const redCount = (dashboard.statusCards || []).filter((s) => s.status === "red").length;
    const yellowCount = (dashboard.statusCards || []).filter((s) => s.status === "yellow").length;

    const topClicks = (clickStats.topElements || [])
      .slice(0, 5)
      .map(
        (c, i) =>
          `  ${i + 1}. ${c.elementKey}${c.elementText ? ` («${String(c.elementText).slice(0, 40)}»)` : ""}: ${c.count} кликов, ${c.uniqueUsers} юзеров`,
      )
      .join("\n");

    return [
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
      "Brain (системная карта):",
      `- Узлов: ${brain.nodesCount}, связей: ${brain.edgesCount}`,
      `- Здоровых плагинов: ${brain.green}, degraded: ${brain.yellow}, упавших: ${brain.red}`,
      brain.topPlugins.length > 0
        ? `- Топ плагины: ${brain.topPlugins.slice(0, 8).join(", ")}`
        : "",
      "",
      `[Snapshot: ${dashboard.generatedAt}; кэш 60 сек]`,
      "",
      "ПРАВИЛО: используй эти цифры в ответе. НЕ выдумывай метрики — они актуальные.",
      "Если Босс просит число которого здесь НЕТ — скажи это явно или вызови tool get_metrics.",
    ]
      .filter((s) => s !== "")
      .join("\n");
  } catch (e: any) {
    console.warn("[ADMIN-VOICE] buildDashboardContext failed:", e?.message || e);
    return "[ADMIN DASHBOARD CONTEXT: не удалось собрать snapshot — используй tools get_metrics для актуальных данных]";
  }
}

// === Multer (memoryStorage, max 5 MB) ===
const MAX_AUDIO_BYTES = 5 * 1024 * 1024;
const ALLOWED_MIMES = new Set([
  "audio/webm",
  "audio/ogg",
  "audio/mpeg",
  "audio/mp3",
  "audio/wav",
  "audio/wave",
  "audio/x-wav",
  "audio/mp4",
  "audio/m4a",
  "audio/x-m4a",
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
}): Promise<AdminVoiceResult> {
  const actions: Array<{ tool: string; input: any; result: string }> = [];
  let inputTokens = 0;
  let outputTokens = 0;

  const stable = buildPersonaSystem(opts.sessionId);
  const modeContext = [
    "[ADMIN-VOICE MODE]",
    "Сейчас ты разговариваешь с Боссом голосом в admin-panel.",
    "Тон: коротко, по-деловому, без эмодзи в озвучке.",
    "Тебе доступны ADMIN-ONLY tools — используй их когда Босс просит данные или действия:",
    "get_metrics, get_failed_users, reload_kb, send_telegram_alert,",
    "change_registration_status, query_users, get_recent_payments,",
    "pause_bot, kick_session, get_recent_incidents.",
    "Если Босс просит что-то деструктивное (kick_session, change_registration_status,",
    "pause_bot) — сначала озвучь что собираешься сделать, потом выполни.",
    "Ответ озвучивается через TTS — пиши простыми фразами, без markdown.",
  ].join("\n");

  // Свежий dashboard snapshot (cached 60 сек). Inject как отдельный
  // system-block — модель видит фактические цифры до начала reasoning'а.
  const dashboardContext = buildDashboardContext();

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
  const maxTokens = 600;

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
            tools: MUZA_TOOLS,
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
          for (const block of j.content) {
            if (block.type === "tool_use") {
              const result = await executeTool(block.name, block.input, {
                userId: opts.userId,
                sessionId: opts.sessionId,
                channel: "admin-voice",
                role: "admin",
              });
              actions.push({ tool: block.name, input: block.input || {}, result: String(result).slice(0, 1500) });
              toolResults.push({ type: "tool_result", tool_use_id: block.id, content: result });
            }
          }
          messages.push({ role: "user", content: toolResults });
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

  return {
    responseText: "Не получилось обработать запрос — все ключи Claude недоступны. Попробуй ещё раз через минуту.",
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
      return res
        .status(415)
        .json({ data: null, error: `Mime не поддерживается: ${file.mimetype}` });
    }
    if (file.size < 500) {
      return res
        .status(400)
        .json({ data: null, error: "Запись слишком короткая (<500 B) — попробуй ещё раз" });
    }

    // 1) STT
    let transcript = "";
    try {
      const r = await transcribeRussianAudio(file.buffer, baseMime, "webm");
      transcript = String(r.transcript || "").trim();
      if (!transcript) {
        return res.status(422).json({
          data: null,
          error: "Yandex SpeechKit не услышал речь — говори чуть громче, ближе к микрофону, минимум 3 сек.",
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
    let audioBase64: string | undefined;
    let audioContentType: string | undefined;
    const wantTts = String(req.query.tts || "").trim() === "1";
    if (wantTts && llmResult.responseText) {
      try {
        const tts = await synthesizeYandexTts({
          text: llmResult.responseText.slice(0, 4500),
          voice: "alena",
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

    return res.json({
      data: {
        transcript,
        response: llmResult.responseText,
        actions: llmResult.actions,
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

  const sessionId = `admin-voice:${userId}`;
  let llmResult: AdminVoiceResult;
  try {
    llmResult = await callAdminVoiceLLM({ userId, sessionId, transcript });
  } catch (e: any) {
    console.error("[ADMIN-VOICE-TEXT] LLM exception:", e?.message || e);
    return res.status(500).json({ data: null, error: `LLM error: ${String(e?.message || e).slice(0, 120)}` });
  }

  let audioBase64: string | undefined;
  let audioContentType: string | undefined;
  const wantTts = String(req.query.tts || "").trim() === "1";
  if (wantTts && llmResult.responseText) {
    try {
      const tts = await synthesizeYandexTts({
        text: llmResult.responseText.slice(0, 4500),
        voice: "alena",
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
      actions: llmResult.actions,
      ...(audioBase64 ? { audioBase64, audioContentType } : {}),
      meta: { durationMs, usage: llmResult.usage, ttsRequested: wantTts, source: 'web-speech-api' },
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
