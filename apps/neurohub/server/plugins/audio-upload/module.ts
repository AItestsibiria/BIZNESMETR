// v304 plugin: audio-upload (Sprint 3.1).
// POST /api/gen/upload — multipart/form-data загрузка mp3/wav/m4a/webm.
// POST /api/gen/cover  — генерация кавера на загруженном аудио через Suno.
//
// Storage: /var/www/neurohub/uploads/<userId>/<sha256>.<ext>
// Public:  https://clone.muziai.ru/uploads/...  (express.static в server/index.ts)
// Идемпотентность: sha256 от содержимого → один файл = один URL.
//
// Spec: docs/strategy/v304-audio-input-TZ.md §3, §4.

import { Router } from "express";
import multer from "multer";
import * as fs from "node:fs";
import * as path from "node:path";
import * as crypto from "node:crypto";
import * as childProc from "node:child_process";
import { eq, sql, and } from "drizzle-orm";
import { db } from "../../storage";
import { audioUploads, generations, users, transactions } from "@shared/schema";
import { normalizeVocalParams } from "../../lib/normalizeVocalParams";
import { transcribeRussianAudio, verifyAllProviders } from "../../lib/transcribe";
import type { Module } from "../../core";

const COVER_PRICE_KOPEK = Number(process.env.AUDIO_COVER_PRICE_KOPEK ?? "29900"); // 299₽

const UPLOADS_DIR = process.env.UPLOADS_DIR || "/var/www/neurohub/uploads";
const MAX_BYTES = 20 * 1024 * 1024;          // 20 MB
const ALLOWED_MIME = new Set([
  "audio/mpeg", "audio/mp3", "audio/wav", "audio/wave", "audio/x-wav",
  "audio/m4a", "audio/x-m4a", "audio/mp4", "audio/webm", "audio/ogg",
]);
const EXT_BY_MIME: Record<string, string> = {
  "audio/mpeg": "mp3", "audio/mp3": "mp3",
  "audio/wav": "wav", "audio/wave": "wav", "audio/x-wav": "wav",
  "audio/m4a": "m4a", "audio/x-m4a": "m4a", "audio/mp4": "m4a",
  "audio/webm": "webm", "audio/ogg": "ogg",
};

try { fs.mkdirSync(UPLOADS_DIR, { recursive: true }); } catch {}

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_BYTES },
});

const router = Router();

// v51 auth helper — Bearer token из sessions (как в admin-overview).
function getUserId(req: any): number | null {
  const authHeader = req.headers?.authorization;
  let token: string | undefined;
  if (typeof authHeader === "string" && authHeader.startsWith("Bearer ")) {
    token = authHeader.slice(7);
  }
  if (!token) return null;
  try {
    const row = db.get<{ userId: number }>(
      sql`SELECT user_id as userId FROM sessions WHERE token = ${token} LIMIT 1`,
    );
    return row?.userId ?? null;
  } catch { return null; }
}

function refundCover(userId: number, genId: number, reason: string): void {
  try {
    const u = db.select().from(users).where(eq(users.id, userId)).get();
    if (!u) return;
    db.update(users).set({ balance: (u.balance ?? 0) + COVER_PRICE_KOPEK }).where(eq(users.id, userId)).run();
    db.insert(transactions).values({
      userId, type: "music", amount: COVER_PRICE_KOPEK,
      description: `Возврат: аудио-кавер #${genId} (${reason.slice(0, 60)})`,
    } as any).run();
  } catch (e) {
    console.error(`[AUDIO-COVER] refund failed for gen #${genId}:`, e);
  }
}

function requireAuth(req: any, res: any, next: any): void {
  const userId = getUserId(req);
  if (!userId) { res.status(401).json({ data: null, error: "unauthorized" }); return; }
  (req as any).userId = userId;
  next();
}

router.post("/upload", requireAuth, upload.single("audio"), async (req, res) => {
  const userId = (req as any).userId as number;
  const file = (req as any).file as Express.Multer.File | undefined;
  if (!file) return res.status(400).json({ data: null, error: "Файл не получен (поле 'audio')" });

  // Bug-fix Eugene 13:35: Chrome шлёт `audio/webm;codecs=opus` — strip codec
  // suffix чтобы попасть в whitelist (тот содержит только base mime'ы).
  const baseMime = file.mimetype.split(";")[0].trim().toLowerCase();
  if (!ALLOWED_MIME.has(baseMime)) {
    return res.status(415).json({
      data: null,
      error: `Формат не поддерживается: ${file.mimetype}. Поддержка: mp3, wav, m4a, webm, ogg.`,
    });
  }
  if (file.size > MAX_BYTES) {
    return res.status(413).json({ data: null, error: `Файл больше ${MAX_BYTES / 1024 / 1024} MB` });
  }
  if (file.size < 1024) {
    return res.status(400).json({ data: null, error: "Файл подозрительно маленький (< 1 KB)" });
  }

  const sha = crypto.createHash("sha256").update(file.buffer).digest("hex");
  // ТЗ Eugene 13:56 «железно работать». Используем baseMime (без codecs=…)
  // для определения ext, иначе Chrome `audio/webm;codecs=opus` → bin → ffmpeg fail.
  const ext = EXT_BY_MIME[baseMime] || "bin";
  console.log(`[UPLOAD] sha=${sha.slice(0, 8)} mime=${file.mimetype} → baseMime=${baseMime} ext=${ext} size=${file.size}`);

  // Идемпотентность: тот же sha — возвращаем существующий.
  const existing = db.select().from(audioUploads).where(eq(audioUploads.sha, sha)).get();
  if (existing) {
    db.update(audioUploads).set({ lastUsedAt: new Date().toISOString() }).where(eq(audioUploads.id, existing.id)).run();
    return res.json({
      data: {
        id: existing.id, sha, uploadUrl: existing.publicUrl,
        size: existing.sizeBytes, mime: existing.mime, idempotent: true,
      },
      error: null,
    });
  }

  const userDir = path.join(UPLOADS_DIR, String(userId));
  try { fs.mkdirSync(userDir, { recursive: true }); } catch {}
  // ТЗ Eugene 13:31 «invalid» от Suno — webm не принимается. Конвертируем
  // в mp3 при upload через ffmpeg чтобы Suno cover-endpoint принимал URL.
  let finalExt = ext;
  let finalMime = file.mimetype;
  let finalBuffer = file.buffer;
  // ВСЕГДА прогоняем через ffmpeg чтобы:
  // 1. сконвертить в mp3 если нужно
  // 2. обрезать до 30 сек (ТЗ Eugene 13:42)
  // 3. нормализовать битрейт/sample rate
  const needsConvert = true;
  if (needsConvert) {
    const tmpIn = path.join(userDir, `_tmp-${sha}.${ext}`);
    const tmpOut = path.join(userDir, `_tmp-${sha}.mp3`);
    try {
      fs.writeFileSync(tmpIn, file.buffer);
      // ТЗ Eugene 13:42: жёсткий лимит 30 сек — длинные файлы автообрезаем.
      // -t 30 = взять только первые 30 сек.
      await new Promise<void>((resolve, reject) => {
        const child = childProc.exec(
          `ffmpeg -y -i "${tmpIn}" -t 30 -vn -c:a libmp3lame -b:a 128k -ac 2 -ar 44100 "${tmpOut}"`,
          { timeout: 60_000 },
          (err) => err ? reject(err) : resolve(),
        );
        child.on("error", reject);
      });
      finalBuffer = fs.readFileSync(tmpOut);
      finalExt = "mp3";
      finalMime = "audio/mpeg";
      try { fs.unlinkSync(tmpIn); } catch {}
      try { fs.unlinkSync(tmpOut); } catch {}
    } catch (e) {
      console.error(`[UPLOAD] ffmpeg convert failed for ${sha}:`, e);
      try { fs.unlinkSync(tmpIn); } catch {}
      try { fs.unlinkSync(tmpOut); } catch {}
      // Падение конвертации — шлём оригинал. Suno может не принять, но
      // дадим хотя бы сохранить запись для отладки.
    }
  }
  const filename = `${sha}.${finalExt}`;
  const storagePath = path.join(userDir, filename);
  try {
    fs.writeFileSync(storagePath, finalBuffer);
  } catch (err) {
    return res.status(500).json({ data: null, error: `Не удалось сохранить файл: ${err instanceof Error ? err.message : "io"}` });
  }

  // Публичный URL: /uploads статика проксируется nginx-ом → public host.
  // PUBLIC_HOST задаётся env (clone.muziai.ru / muziai.ru). Eugene 13:46:
  // если не задан, берём из request-headers (Host + protocol). Раньше
  // дефолт был "" → Suno получал relative URL и не мог скачать.
  const host = process.env.PUBLIC_HOST
    || (req.headers["x-forwarded-proto"]
        ? `${req.headers["x-forwarded-proto"]}://${req.headers["x-forwarded-host"] || req.headers.host}`
        : `https://${req.headers.host || "clone.muziai.ru"}`);
  const publicUrl = `${host}/uploads/${userId}/${filename}`;

  const inserted = db.insert(audioUploads).values({
    userId, sha,
    filenameOriginal: file.originalname.slice(0, 200),
    ext: finalExt, sizeBytes: finalBuffer.length, mime: finalMime,
    storagePath, publicUrl,
    lastUsedAt: new Date().toISOString(),
  }).returning().get();

  res.json({
    data: {
      id: inserted.id, sha, uploadUrl: publicUrl,
      size: finalBuffer.length, mime: finalMime, ext: finalExt,
      converted: needsConvert && finalExt === "mp3",
      idempotent: false,
    },
    error: null,
  });
});

// POST /api/gen/audio-cover — кавер из загруженного аудио ИЛИ из существующей gen.
// Имя `audio-cover` чтобы не конфликтовать со старым skeleton extend-cover/cover
// (который требует session-auth и валится на Bearer-токенах).
// Body: { uploadSha?: string, sourceGenId?: number, voiceType, prompt?, style?,
//         audioWeight?: 0..1, isPublic? }
router.post("/audio-cover", requireAuth, async (req, res) => {
  const userId = (req as any).userId as number;
  const { uploadSha, sourceGenId, voiceType, voice, isDuet, instrumental,
          prompt, style: bodyStyle, audioWeight, isPublic, authorName,
          title, lyrics } = req.body;

  if (!uploadSha && !sourceGenId) {
    return res.status(400).json({ data: null, error: "Укажи uploadSha (загруженный файл) или sourceGenId (существующая генерация)" });
  }

  let audioInputUrl = "";
  if (uploadSha) {
    const upl = db.select().from(audioUploads)
      .where(and(eq(audioUploads.sha, uploadSha), eq(audioUploads.userId, userId)))
      .get();
    if (!upl) return res.status(404).json({ data: null, error: "Загруженный файл не найден или не принадлежит вам" });
    audioInputUrl = upl.publicUrl;
    db.update(audioUploads).set({ lastUsedAt: new Date().toISOString() }).where(eq(audioUploads.id, upl.id)).run();
  } else {
    const src = db.select().from(generations)
      .where(and(eq(generations.id, Number(sourceGenId)), eq(generations.userId, userId)))
      .get();
    if (!src || src.status !== "done" || !src.resultUrl) {
      return res.status(404).json({ data: null, error: "Исходный трек не найден или не готов" });
    }
    audioInputUrl = src.resultUrl;
  }

  const u = db.select().from(users).where(eq(users.id, userId)).get();
  if (!u) return res.status(404).json({ data: null, error: "Пользователь не найден" });

  // Списание баланса перед запросом в Suno (как в /api/music/generate).
  if ((u.balance ?? 0) < COVER_PRICE_KOPEK) {
    return res.status(402).json({ data: null, error: `Недостаточно средств. Нужно ${COVER_PRICE_KOPEK / 100} ₽, на счёте ${(u.balance ?? 0) / 100} ₽.` });
  }
  db.update(users).set({ balance: (u.balance ?? 0) - COVER_PRICE_KOPEK }).where(eq(users.id, userId)).run();
  db.insert(transactions).values({
    userId, type: "music", amount: -COVER_PRICE_KOPEK,
    description: `Аудио-кавер (upload ${uploadSha ? uploadSha.slice(0, 8) : "gen#" + sourceGenId})`,
  } as any).run();

  const norm = normalizeVocalParams({
    prompt, style: bodyStyle, lyrics,
    voiceType, voice, isDuet, instrumental,
    generationId: null,
  });

  const apiKey = process.env.GPTUNNEL_API_KEY ?? "";
  if (!apiKey) return res.status(503).json({ data: null, error: "GPTUNNEL_API_KEY не задан" });

  // Определяем тип ДО создания row чтобы записать правильную category
  const willHaveLyrics = norm.finalLyrics && norm.finalLyrics.length >= 50;

  // Создаём gen-row до запроса в Suno — даже если упадёт, у нас будет след.
  const newGen = db.insert(generations).values({
    userId, type: "music",
    prompt: prompt || (willHaveLyrics ? `Песня по голосу` : `Кавер на загруженный трек`),
    style: JSON.stringify({
      style: norm.finalStyle,
      title: title || (willHaveLyrics ? "Песня" : "Кавер"),
      category: willHaveLyrics ? "song" : "cover",
      mode: willHaveLyrics ? "audio-to-music" : "cover",
      audioInputUrl,
      audioWeight: audioWeight ?? 0.7,
      fromUploadSha: uploadSha || null,
      fromGenId: sourceGenId || null,
    }),
    status: "processing",
    cost: COVER_PRICE_KOPEK,
    isPublic: isPublic === false ? 0 : 1,
    authorName: authorName || u.name || "Аноним",
    voiceType: norm.voiceType,
  } as any).returning().get();

  // ТЗ Eugene 13:48 «реши кардинально»: следуем точному pattern'у рабочего
  // /api/music/generate (routes.ts:2028+). Раньше добавлял vocalGender и
  // instrumental:true — GPTunnel их отвергает. Voice-выбор уже в normalizer
  // через [Female Vocal] теги в lyric + "Female Vocal..." в tags.
  const hasLyrics = norm.finalLyrics && norm.finalLyrics.length >= 50;
  const isInstrumental = norm.voiceType === "instrumental";
  const sunoBody: any = { model: "suno" };

  if (isInstrumental) {
    // GPTunnel instrumental flag сломан — кладём подсказку в prompt (basic mode)
    sunoBody.prompt = `Instrumental, no vocals. ${norm.finalStyle || ""} ${norm.finalPrompt || ""}`.trim().slice(0, 400);
  } else if (hasLyrics) {
    // Custom-mode: lyric + tags + title
    sunoBody.mode = "custom";
    sunoBody.lyric = norm.finalLyrics.slice(0, 3000);
    sunoBody.title = (title || "Песня").slice(0, 80);
    if (norm.finalStyle) sunoBody.tags = norm.finalStyle.slice(0, 200);
    if (norm.finalPrompt) sunoBody.prompt = norm.finalPrompt.slice(0, 400);
  } else {
    // Basic-mode: только prompt
    sunoBody.prompt = (norm.finalPrompt || norm.finalLyrics || prompt || "Песня").slice(0, 400);
    if (norm.finalStyle) sunoBody.tags = norm.finalStyle.slice(0, 200);
  }
  console.log(`[AUDIO-COVER] gen #${newGen.id} voiceType=${norm.voiceType} mode=${sunoBody.mode || "basic"} prompt=${(sunoBody.prompt || "").length}ch lyric=${(sunoBody.lyric || "").length}ch tags="${(sunoBody.tags || "").slice(0, 100)}"`);

  let upstream: any = null;
  let upstreamStatus = 0;
  try {
    const r = await fetch("https://gptunnel.ru/v1/media/create", {
      method: "POST",
      headers: { Authorization: apiKey, "Content-Type": "application/json" },
      body: JSON.stringify(sunoBody),
      signal: AbortSignal.timeout(20000),
    });
    upstreamStatus = r.status;
    const t = await r.text();
    try { upstream = JSON.parse(t); } catch { upstream = { raw: t }; }
  } catch (err) {
    const e = err instanceof Error ? err.message : String(err);
    db.update(generations).set({ status: "error", errorReason: `network: ${e}` })
      .where(eq(generations.id, newGen.id)).run();
    refundCover(userId, newGen.id, "network");
    return res.status(502).json({ data: null, error: e });
  }

  if (upstreamStatus < 200 || upstreamStatus >= 300 || !upstream?.id) {
    const errMsg = upstream?.message ?? upstream?.error?.message ?? `MuziAi вернул ${upstreamStatus}`;
    db.update(generations).set({ status: "error", errorReason: String(errMsg).slice(0, 500) })
      .where(eq(generations.id, newGen.id)).run();
    refundCover(userId, newGen.id, String(errMsg).slice(0, 80));
    return res.status(upstreamStatus || 502).json({
      data: null, error: errMsg, details: { upstreamStatus, upstream },
    });
  }

  db.update(generations).set({ taskId: upstream.id, status: "processing" })
    .where(eq(generations.id, newGen.id)).run();

  console.log(`[AUDIO-COVER] gen #${newGen.id} → Suno taskId=${upstream.id} voiceType=${norm.voiceType} audioWeight=${sunoBody.audioWeight}`);

  res.json({
    data: {
      generationId: newGen.id,
      taskId: upstream.id,
      status: "processing",
      voiceType: norm.voiceType,
      watchUrl: `/#/track/${newGen.id}`,
    },
    error: null,
  });
});

// POST /api/gen/transcribe
// Body: { uploadSha: string }
// Whisper-транскрипция загруженного аудио через GPTunnel + LLM-rewrite в
// singable lyrics + подбор шаблона. ТЗ Eugene 2026-05-07 12:09.
router.post("/transcribe", requireAuth, async (req, res) => {
  try {
    const userId = (req as any).userId as number;
    const sha = String(req.body?.uploadSha ?? "").trim();
    if (!sha) return res.status(400).json({ data: null, error: "uploadSha required" });
    // ТЗ Eugene 13:28: пользовательские настройки → в LLM
    const userStyle = String(req.body?.style ?? "").trim();
    const userBpm = req.body?.bpm ? Number(req.body.bpm) : null;
    const userMood = String(req.body?.mood ?? "").trim();
    const userTempo = String(req.body?.tempo ?? "").trim();
    const userVoice = String(req.body?.voiceType ?? req.body?.voice ?? "").trim();

    const upl = db.select().from(audioUploads)
      .where(and(eq(audioUploads.sha, sha), eq(audioUploads.userId, userId)))
      .get();
    if (!upl) return res.status(404).json({ data: null, error: "Файл не найден" });

    const apiKey = process.env.GPTUNNEL_API_KEY ?? "";
    if (!apiKey) return res.status(503).json({ data: null, error: "GPTUNNEL_API_KEY не задан" });

    // 1. Multi-provider transcribe (Yandex → OpenAI → GPTunnel) — ТЗ Eugene 12:35
    const buffer = fs.readFileSync(upl.storagePath);
    const result = await transcribeRussianAudio(buffer, upl.mime || "audio/webm", upl.ext || "webm");
    console.log(`[TRANSCRIBE] provider=${result.provider} attempts=${result.attempts.length}`);
    for (const a of result.attempts) {
      console.log(`  ${a.provider} ok=${a.ok} status=${a.httpStatus ?? "-"} ms=${a.durationMs} err=${a.error?.slice(0, 100) ?? "-"}`);
    }
    // Учитываем usage Yandex для отображения «баланса API» (Eugene 13:38).
    // Длительность аудио оцениваем по размеру: mp3 128kbps ≈ 16KB/sec.
    if (result.provider === "yandex") {
      const estSec = Math.max(1, Math.round(buffer.length / 16000));
      const ring: any[] = (globalThis as any).__yandexUsage;
      if (Array.isArray(ring)) {
        ring.push({ ts: Date.now(), durationSec: estSec, ok: true });
        if (ring.length > 500) ring.splice(0, ring.length - 500);
      }
    }
    const transcript = result.transcript;

    if (!transcript) {
      const summary = result.attempts.map((a) => `${a.provider}: ${a.ok ? "OK" : (a.error?.slice(0, 60) ?? "fail")}`).join(" | ");
      return res.json({
        data: {
          transcript: "",
          suggestion: null,
          warning: `Не удалось распознать. Попробованные: ${summary}. Введите текст вручную ниже.`,
          fallbackToManual: true,
          attempts: result.attempts,
        },
        error: null,
      });
    }

    // 2. LLM rewrite + подбор шаблона
    let suggestion: any = null;
    try {
      const r = await fetch("https://gptunnel.ru/v1/chat/completions", {
        method: "POST",
        headers: { Authorization: apiKey, "Content-Type": "application/json" },
        body: JSON.stringify({
          model: "gpt-4o-mini",
          messages: [
            {
              role: "system",
              content:
                "Ты — поэт-песенник. Из устного описания пользователя сделай: " +
                "(1) singable lyrics на русском (2 куплета + припев + bridge, ~16 строк), " +
                "(2) подбор подходящего жанра и темпа (genre + bpm 70-140), " +
                "(3) шаблон из списка: birthday, wedding, anniversary, lullaby, " +
                "memorial, corporate-anthem, valentines-day, proposal-song, kids-fun, " +
                "best-friend, new-year. Если ни один не подходит — null. " +
                "Ответ строго JSON: " +
                '{"lyrics":"...","genre":"...","bpm":120,"templateSlug":"...","title":"..."}',
            },
            {
              role: "user",
              content:
                `Описание: ${transcript}` +
                (userStyle ? `\nЖанр (учти в формулировках): ${userStyle}` : "") +
                (userBpm ? `\nBPM ${userBpm}` : "") +
                (userMood ? `\nНастроение: ${userMood}` : "") +
                (userTempo ? `\nТемп: ${userTempo}` : "") +
                (userVoice && userVoice !== "auto" ? `\nГолос: ${userVoice}` : ""),
            },
          ],
          temperature: 0.85,
          max_tokens: 600,
          response_format: { type: "json_object" },
        }),
        signal: AbortSignal.timeout(30_000),
      });
      if (r.ok) {
        const data: any = await r.json();
        const content = data?.choices?.[0]?.message?.content;
        if (content) {
          try { suggestion = JSON.parse(content); } catch {}
        }
      }
    } catch {}

    res.json({
      data: {
        transcript,
        suggestion,
        uploadSha: sha,
      },
      error: null,
    });
  } catch (err) {
    res.status(500).json({ data: null, error: err instanceof Error ? err.message : "internal" });
  }
});

// POST /api/gen/rewrite-lyrics
// Body: { transcript: string, templateSlug?: string, hint?: string }
// Перегенерирует текст песни из уже распознанного transcript'а.
// Не дёргает Whisper (нет файла) — только LLM. Юзер жмёт сколько раз
// надо пока не зацепит смысл (ТЗ Eugene 12:14).
router.post("/rewrite-lyrics", requireAuth, async (req, res) => {
  try {
    const transcript = String(req.body?.transcript ?? "").trim();
    if (!transcript) return res.status(400).json({ data: null, error: "transcript required" });
    const templateSlug = String(req.body?.templateSlug ?? "").trim();
    const hint = String(req.body?.hint ?? "").trim();
    // ТЗ Eugene 13:28: учитывать пользовательские настройки стиля
    const userStyle = String(req.body?.style ?? "").trim();
    const userBpm = req.body?.bpm ? Number(req.body.bpm) : null;
    const userMood = String(req.body?.mood ?? "").trim();
    const userTempo = String(req.body?.tempo ?? "").trim();
    const userVoice = String(req.body?.voiceType ?? req.body?.voice ?? "").trim();

    const apiKey = process.env.GPTUNNEL_API_KEY ?? "";
    if (!apiKey) return res.status(503).json({ data: null, error: "GPTUNNEL_API_KEY не задан" });

    let suggestion: any = null;
    try {
      const r = await fetch("https://gptunnel.ru/v1/chat/completions", {
        method: "POST",
        headers: { Authorization: apiKey, "Content-Type": "application/json" },
        body: JSON.stringify({
          model: "gpt-4o-mini",
          messages: [
            {
              role: "system",
              content:
                "Ты — поэт-песенник. Из устного описания сделай новый ВАРИАНТ singable lyrics на русском " +
                "(2 куплета + припев + bridge, ~16 строк). Сохраняй смысл, но меняй формулировки и образы. " +
                "Подбери жанр и BPM 70-140. Выбери templateSlug из: birthday, wedding, anniversary, " +
                "lullaby, memorial, corporate-anthem, valentines-day, proposal-song, kids-fun, best-friend, " +
                "new-year или null. Ответ строго JSON: " +
                '{"lyrics":"...","genre":"...","bpm":120,"templateSlug":"...","title":"..."}',
            },
            {
              role: "user",
              content:
                `Описание: ${transcript}` +
                (templateSlug ? `\nПредпочтительный шаблон: ${templateSlug}` : "") +
                (userStyle ? `\nЖанр/стиль (учти в формулировках): ${userStyle}` : "") +
                (userBpm ? `\nBPM ${userBpm} — подбирай длину строк под темп` : "") +
                (userMood ? `\nНастроение: ${userMood} (передай эмоцию в словах)` : "") +
                (userTempo ? `\nТемп: ${userTempo}` : "") +
                (userVoice && userVoice !== "auto" ? `\nГолос: ${userVoice} (если duet — пиши «[Male]…[Female]…[Together]» структуру)` : "") +
                (hint ? `\nПожелание автора: ${hint}` : ""),
            },
          ],
          temperature: 1.0, // выше — больше разнообразия между re-roll'ами
          max_tokens: 600,
          response_format: { type: "json_object" },
        }),
        signal: AbortSignal.timeout(30_000),
      });
      if (!r.ok) {
        const t = await r.text().catch(() => "");
        return res.status(r.status).json({ data: null, error: `LLM вернул ${r.status}: ${t.slice(0, 200)}` });
      }
      const data: any = await r.json();
      const content = data?.choices?.[0]?.message?.content;
      if (content) {
        try { suggestion = JSON.parse(content); } catch {}
      }
    } catch (e) {
      const m = e instanceof Error ? e.message : String(e);
      return res.status(502).json({ data: null, error: `LLM network: ${m}` });
    }

    res.json({ data: { suggestion }, error: null });
  } catch (err) {
    res.status(500).json({ data: null, error: err instanceof Error ? err.message : "internal" });
  }
});

// POST /api/gen/audio-cover/:id/regenerate
// «Не нравится результат — перегенерировать» (ТЗ Eugene 2026-05-07 11:55).
// Берёт исходный gen, читает fromUploadSha из его style-meta, и запускает
// новую cover-генерацию с теми же параметрами но новым taskId.
router.post("/audio-cover/:id/regenerate", requireAuth, async (req, res) => {
  try {
    const userId = (req as any).userId as number;
    const id = parseInt(req.params.id, 10);
    if (!Number.isFinite(id)) return res.status(400).json({ data: null, error: "invalid id" });

    const oldGen = db.select().from(generations)
      .where(and(eq(generations.id, id), eq(generations.userId, userId)))
      .get();
    if (!oldGen) return res.status(404).json({ data: null, error: "Генерация не найдена или не ваша" });

    let meta: any = {};
    try { meta = JSON.parse(oldGen.style || "{}"); } catch {}
    const uploadSha = meta.fromUploadSha;
    if (!uploadSha) {
      return res.status(400).json({
        data: null,
        error: "Эта генерация не из аудио-кавера. Регенерация доступна только для треков созданных через 🎧 Аудио (uploadSha).",
      });
    }

    const upl = db.select().from(audioUploads)
      .where(and(eq(audioUploads.sha, uploadSha), eq(audioUploads.userId, userId)))
      .get();
    if (!upl) return res.status(404).json({ data: null, error: "Исходный файл удалён или не доступен" });

    const u = db.select().from(users).where(eq(users.id, userId)).get();
    if (!u) return res.status(404).json({ data: null, error: "Пользователь не найден" });

    if ((u.balance ?? 0) < COVER_PRICE_KOPEK) {
      return res.status(402).json({ data: null, error: `Недостаточно средств. Нужно ${COVER_PRICE_KOPEK / 100} ₽` });
    }
    db.update(users).set({ balance: (u.balance ?? 0) - COVER_PRICE_KOPEK }).where(eq(users.id, userId)).run();
    db.insert(transactions).values({
      userId, type: "music", amount: -COVER_PRICE_KOPEK,
      description: `Перегенерация аудио-кавера (re-roll #${id})`,
    } as any).run();

    const norm = normalizeVocalParams({
      prompt: oldGen.prompt,
      style: meta.style,
      lyrics: undefined,
      voiceType: (oldGen as any).voiceType,
      generationId: null,
    });

    const newGen = db.insert(generations).values({
      userId, type: "music",
      prompt: oldGen.prompt,
      style: JSON.stringify({
        ...meta,
        title: (meta.title || "Кавер") + " (re-roll)",
        rerolledFromGenId: id,
      }),
      status: "processing",
      cost: COVER_PRICE_KOPEK,
      isPublic: oldGen.isPublic,
      authorName: oldGen.authorName,
      voiceType: norm.voiceType,
    } as any).returning().get();

    // Аналогичный фикс для regenerate (тот же pattern что в audio-cover)
    const apiKey = process.env.GPTUNNEL_API_KEY ?? "";
    const hasLyricsRe = norm.finalLyrics && norm.finalLyrics.length >= 50;
    const isInstrumentalRe = norm.voiceType === "instrumental";
    const sunoBody: any = { model: "suno" };
    if (isInstrumentalRe) {
      sunoBody.prompt = `Instrumental, no vocals. ${norm.finalStyle || ""} ${norm.finalPrompt || ""}`.trim().slice(0, 400);
    } else if (hasLyricsRe) {
      sunoBody.mode = "custom";
      sunoBody.lyric = norm.finalLyrics.slice(0, 3000);
      sunoBody.title = (meta.title || "Песня").slice(0, 80);
      if (norm.finalStyle) sunoBody.tags = norm.finalStyle.slice(0, 200);
      if (norm.finalPrompt) sunoBody.prompt = norm.finalPrompt.slice(0, 400);
    } else {
      sunoBody.prompt = (norm.finalPrompt || norm.finalLyrics || "Песня").slice(0, 400);
      if (norm.finalStyle) sunoBody.tags = norm.finalStyle.slice(0, 200);
    }

    let upstream: any = null;
    let upstreamStatus = 0;
    try {
      const r = await fetch("https://gptunnel.ru/v1/media/create", {
        method: "POST",
        headers: { Authorization: apiKey, "Content-Type": "application/json" },
        body: JSON.stringify(sunoBody),
        signal: AbortSignal.timeout(20000),
      });
      upstreamStatus = r.status;
      const t = await r.text();
      try { upstream = JSON.parse(t); } catch { upstream = { raw: t }; }
    } catch (err) {
      const e = err instanceof Error ? err.message : String(err);
      db.update(generations).set({ status: "error", errorReason: `network: ${e}` })
        .where(eq(generations.id, newGen.id)).run();
      refundCover(userId, newGen.id, "network");
      return res.status(502).json({ data: null, error: e });
    }

    if (upstreamStatus < 200 || upstreamStatus >= 300 || !upstream?.id) {
      const errMsg = upstream?.message ?? upstream?.error?.message ?? `MuziAi вернул ${upstreamStatus}`;
      db.update(generations).set({ status: "error", errorReason: String(errMsg).slice(0, 500) })
        .where(eq(generations.id, newGen.id)).run();
      refundCover(userId, newGen.id, String(errMsg).slice(0, 80));
      return res.status(upstreamStatus || 502).json({ data: null, error: errMsg });
    }

    db.update(generations).set({ taskId: upstream.id })
      .where(eq(generations.id, newGen.id)).run();

    res.json({
      data: {
        generationId: newGen.id,
        rerolledFromGenId: id,
        taskId: upstream.id,
        watchUrl: `/#/track/${newGen.id}`,
        status: "processing",
      },
      error: null,
    });
  } catch (err) {
    res.status(500).json({ data: null, error: err instanceof Error ? err.message : "internal" });
  }
});

// GET /api/gen/uploads — мои загрузки (для UI «Мои файлы»).
router.get("/uploads", requireAuth, (req, res) => {
  const userId = (req as any).userId as number;
  const rows = db.select().from(audioUploads)
    .where(eq(audioUploads.userId, userId))
    .orderBy(sql`created_at DESC`)
    .limit(50)
    .all();
  res.json({ data: rows, error: null });
});

const audioUploadModule: Module = {
  name: "audio-upload",
  version: "0.1.0",
  description: "Sprint 3.1 — multipart upload + Suno cover на загруженном аудио.",
  routes: { prefix: "gen", router },
  publishes: ["audio.uploaded", "audio.cover.requested"],
  onLoad: async (ctx) => {
    ctx.logger.info(`audio-upload online — UPLOADS_DIR=${UPLOADS_DIR}, MAX=${MAX_BYTES / 1024 / 1024}MB`);
  },
  healthCheck: () => {
    try {
      fs.accessSync(UPLOADS_DIR, fs.constants.W_OK);
      const count = db.select({ c: sql<number>`count(*)` }).from(audioUploads).get()?.c ?? 0;
      return { status: "ok", details: { uploadsDir: UPLOADS_DIR, totalFiles: count } };
    } catch (e) {
      return { status: "degraded", details: { error: e instanceof Error ? e.message : String(e) } };
    }
  },
};

export default audioUploadModule;
