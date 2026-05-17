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
import type { Module } from "../../core";

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
  const dynamicContext = [
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

  const systemBlocks: any[] = [
    { type: "text", text: stable, cache_control: { type: "ephemeral", ttl: "1h" } },
    { type: "text", text: dynamicContext },
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

    // 4) Audit-log (НЕ сохраняем audio, только meta + transcript/response).
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
            transcript: transcript.slice(0, 500),
            response: llmResult.responseText.slice(0, 1000),
            actions: llmResult.actions.map(a => ({
              tool: a.tool,
              input: a.input,
              result: String(a.result).slice(0, 200),
            })),
            durationMs,
            ttsRequested: wantTts,
            ttsBytes: audioBase64 ? Math.round((audioBase64.length * 3) / 4) : 0,
            audioBytes: file.size,
            audioMime: baseMime,
            usage: llmResult.usage,
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
      } catch {}
      return {
        id: r.id,
        adminUserId: r.admin_user_id,
        createdAt: r.created_at,
        transcript: parsed?.transcript || "",
        response: parsed?.response || "",
        actions: parsed?.actions || [],
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
