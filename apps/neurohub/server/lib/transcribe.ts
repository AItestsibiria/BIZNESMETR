// Multi-provider Speech-to-text для русского аудио.
// ТЗ Eugene 2026-05-07 12:35: «100% работающее API + надо верифицировать».
//
// Провайдеры в порядке предпочтения:
//   1. Yandex SpeechKit (native RU, лучшее качество, ~₽0.45/мин)
//      env: YANDEX_SPEECHKIT_API_KEY + YANDEX_FOLDER_ID
//   2. OpenAI Whisper напрямую (если есть OPENAI_API_KEY)
//      env: OPENAI_API_KEY
//   3. GPTunnel Whisper (proxy через нашего поставщика)
//      env: GPTUNNEL_API_KEY
//
// Каждый провайдер возвращает { transcript, error }.
// /api/gen/transcribe пробует в порядке pref, отдаёт первый успешный.
// /api/admin/v304/transcribe-verify пробует ВСЕ — для self-проверки.

export type TranscribeProvider = "yandex" | "openai" | "gptunnel";

export interface TranscribeAttempt {
  provider: TranscribeProvider;
  ok: boolean;
  transcript?: string;
  error?: string;
  httpStatus?: number;
  durationMs?: number;
}

export interface TranscribeResult {
  transcript: string;
  provider: TranscribeProvider | null;
  attempts: TranscribeAttempt[];
}

async function timed<T>(fn: () => Promise<T>): Promise<{ result: T | null; err: any; ms: number }> {
  const t0 = Date.now();
  try { const result = await fn(); return { result, err: null, ms: Date.now() - t0 }; }
  catch (err) { return { result: null, err, ms: Date.now() - t0 }; }
}

// === Yandex SpeechKit (native RU, лучшее качество) ===
async function tryYandex(buffer: Buffer, mime: string): Promise<TranscribeAttempt> {
  const apiKey = process.env.YANDEX_SPEECHKIT_API_KEY;
  const folderId = process.env.YANDEX_FOLDER_ID;
  if (!apiKey) return { provider: "yandex", ok: false, error: "YANDEX_SPEECHKIT_API_KEY missing" };

  const t = await timed(async () => {
    // SpeechKit short audio recognize: до 1 минуты, прямой POST с raw audio
    // https://yandex.cloud/ru/docs/speechkit/stt/api/request-api#http-request
    const url = new URL("https://stt.api.cloud.yandex.net/speech/v1/stt:recognize");
    url.searchParams.set("topic", "general");
    url.searchParams.set("lang", "ru-RU");
    url.searchParams.set("format", mime.includes("wav") ? "lpcm" : "oggopus");
    if (folderId) url.searchParams.set("folderId", folderId);
    if (mime.includes("wav")) url.searchParams.set("sampleRateHertz", "48000");

    const r = await fetch(url.toString(), {
      method: "POST",
      headers: { Authorization: `Api-Key ${apiKey}` },
      body: buffer,
      signal: AbortSignal.timeout(60_000),
    });
    return { ok: r.ok, status: r.status, body: await r.text().catch(() => "") };
  });
  if (t.err) return { provider: "yandex", ok: false, error: String(t.err), durationMs: t.ms };
  const r = t.result!;
  if (!r.ok) return { provider: "yandex", ok: false, httpStatus: r.status, error: r.body.slice(0, 200), durationMs: t.ms };
  try {
    const json = JSON.parse(r.body);
    const text = String(json?.result ?? "").trim();
    return { provider: "yandex", ok: !!text, transcript: text, error: text ? undefined : "empty result", httpStatus: 200, durationMs: t.ms };
  } catch (e) {
    return { provider: "yandex", ok: false, error: `parse: ${r.body.slice(0, 100)}`, durationMs: t.ms };
  }
}

// === OpenAI Whisper напрямую (если есть OPENAI_API_KEY) ===
async function tryOpenAI(buffer: Buffer, mime: string, ext: string): Promise<TranscribeAttempt> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) return { provider: "openai", ok: false, error: "OPENAI_API_KEY missing" };

  const t = await timed(async () => {
    const fd = new FormData();
    fd.append("file", new Blob([buffer], { type: mime }), `audio.${ext}`);
    fd.append("model", "whisper-1");
    fd.append("language", "ru");
    const r = await fetch("https://api.openai.com/v1/audio/transcriptions", {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}` },
      body: fd,
      signal: AbortSignal.timeout(60_000),
    });
    return { ok: r.ok, status: r.status, body: await r.text().catch(() => "") };
  });
  if (t.err) return { provider: "openai", ok: false, error: String(t.err), durationMs: t.ms };
  const r = t.result!;
  if (!r.ok) return { provider: "openai", ok: false, httpStatus: r.status, error: r.body.slice(0, 200), durationMs: t.ms };
  try {
    const text = String(JSON.parse(r.body)?.text ?? "").trim();
    return { provider: "openai", ok: !!text, transcript: text, error: text ? undefined : "empty result", httpStatus: 200, durationMs: t.ms };
  } catch {
    return { provider: "openai", ok: false, error: `parse: ${r.body.slice(0, 100)}`, durationMs: t.ms };
  }
}

// === GPTunnel Whisper proxy ===
async function tryGPTunnel(buffer: Buffer, mime: string, ext: string): Promise<TranscribeAttempt> {
  const apiKey = process.env.GPTUNNEL_API_KEY;
  if (!apiKey) return { provider: "gptunnel", ok: false, error: "GPTUNNEL_API_KEY missing" };

  const candidates = [
    "https://gptunnel.ru/v1/audio/transcriptions",
    "https://api.gptunnel.ru/v1/audio/transcriptions",
  ];
  let lastErr: TranscribeAttempt = { provider: "gptunnel", ok: false, error: "no candidates" };
  for (const url of candidates) {
    const t = await timed(async () => {
      const fd = new FormData();
      fd.append("file", new Blob([buffer], { type: mime }), `audio.${ext}`);
      fd.append("model", "whisper-1");
      fd.append("language", "ru");
      const r = await fetch(url, {
        method: "POST",
        headers: { Authorization: apiKey },
        body: fd,
        signal: AbortSignal.timeout(60_000),
      });
      return { ok: r.ok, status: r.status, body: await r.text().catch(() => "") };
    });
    if (t.err) { lastErr = { provider: "gptunnel", ok: false, error: String(t.err), durationMs: t.ms }; continue; }
    const r = t.result!;
    if (!r.ok) {
      lastErr = { provider: "gptunnel", ok: false, httpStatus: r.status, error: `${url}: ${r.body.slice(0, 200)}`, durationMs: t.ms };
      if (r.status !== 401 && r.status !== 404) break;
      continue;
    }
    try {
      const text = String(JSON.parse(r.body)?.text ?? "").trim();
      return { provider: "gptunnel", ok: !!text, transcript: text, error: text ? undefined : "empty result", httpStatus: 200, durationMs: t.ms };
    } catch {
      lastErr = { provider: "gptunnel", ok: false, error: `parse: ${r.body.slice(0, 100)}`, durationMs: t.ms };
    }
  }
  return lastErr;
}

// === Public API ===

/**
 * Транскрипция: пробует все провайдеры по порядку, возвращает первый успешный.
 */
export async function transcribeRussianAudio(buffer: Buffer, mime: string, ext: string): Promise<TranscribeResult> {
  const attempts: TranscribeAttempt[] = [];

  // 1. Yandex (native RU, наивысший приоритет)
  attempts.push(await tryYandex(buffer, mime));
  if (attempts[attempts.length - 1].ok) {
    return { transcript: attempts[attempts.length - 1].transcript!, provider: "yandex", attempts };
  }

  // 2. OpenAI direct
  attempts.push(await tryOpenAI(buffer, mime, ext));
  if (attempts[attempts.length - 1].ok) {
    return { transcript: attempts[attempts.length - 1].transcript!, provider: "openai", attempts };
  }

  // 3. GPTunnel proxy
  attempts.push(await tryGPTunnel(buffer, mime, ext));
  if (attempts[attempts.length - 1].ok) {
    return { transcript: attempts[attempts.length - 1].transcript!, provider: "gptunnel", attempts };
  }

  return { transcript: "", provider: null, attempts };
}

/**
 * Verify: пробует ВСЕ провайдеры и возвращает матрицу — для админ-диагностики.
 * Используется кнопкой «Verify STT» в /admin/v304.
 */
export async function verifyAllProviders(buffer: Buffer, mime: string, ext: string): Promise<TranscribeAttempt[]> {
  return Promise.all([
    tryYandex(buffer, mime),
    tryOpenAI(buffer, mime, ext),
    tryGPTunnel(buffer, mime, ext),
  ]);
}
