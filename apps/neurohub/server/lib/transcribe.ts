// Multi-provider Speech-to-text для русского аудио.
// ТЗ Eugene 2026-05-07 12:35: «100% работающее API + надо верифицировать».
// Дополнение 12:52: Yandex принимает только oggopus/lpcm. Браузер шлёт
// audio/webm — конвертируем через ffmpeg до отправки.

import * as childProc from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

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

// === ffmpeg helper: webm → ogg-opus ===
// Yandex SpeechKit принимает только oggopus / lpcm. Браузерный MediaRecorder
// в Chrome пишет audio/webm (Matroska container) с Opus-кодеком. Перепаковка
// в ogg = быстро (без перекодирования аудио, copy stream).
function convertToOggOpus(input: Buffer, mime: string): Promise<Buffer | null> {
  return new Promise((resolve) => {
    if (mime.includes("ogg") || mime.includes("opus")) {
      // Уже ogg-opus — отдаём как есть
      resolve(input);
      return;
    }
    const tmpDir = os.tmpdir();
    const inExt = mime.includes("webm") ? "webm" : mime.includes("mp4") ? "m4a" : mime.includes("wav") ? "wav" : "bin";
    const inFile = path.join(tmpDir, `stt-${Date.now()}-${Math.random().toString(36).slice(2)}.${inExt}`);
    const outFile = inFile.replace(/\.\w+$/, ".ogg");
    try { fs.writeFileSync(inFile, input); } catch { resolve(null); return; }
    // -c:a copy не работает webm→ogg (разные контейнеры, Opus можно копировать
    // но ffmpeg иногда хочет re-mux). Пробуем без -c:a copy для надёжности.
    childProc.exec(
      `ffmpeg -y -i "${inFile}" -vn -c:a libopus -ar 48000 -ac 1 "${outFile}" 2>/dev/null`,
      { timeout: 30_000 },
      (err) => {
        try { fs.unlinkSync(inFile); } catch {}
        if (err) {
          try { fs.unlinkSync(outFile); } catch {}
          resolve(null);
          return;
        }
        try {
          const out = fs.readFileSync(outFile);
          try { fs.unlinkSync(outFile); } catch {}
          resolve(out);
        } catch {
          resolve(null);
        }
      },
    );
  });
}

// === Yandex SpeechKit (native RU, лучшее качество) ===
async function tryYandex(buffer: Buffer, mime: string): Promise<TranscribeAttempt> {
  const apiKey = process.env.YANDEX_SPEECHKIT_API_KEY;
  const folderId = process.env.YANDEX_FOLDER_ID;
  if (!apiKey) return { provider: "yandex", ok: false, error: "YANDEX_SPEECHKIT_API_KEY missing" };

  const t = await timed(async () => {
    // Конвертация если не ogg/opus уже
    let body = buffer;
    let format = "oggopus";
    if (mime.includes("wav")) {
      format = "lpcm";
    } else if (!mime.includes("ogg") && !mime.includes("opus")) {
      const converted = await convertToOggOpus(buffer, mime);
      if (!converted) {
        return { ok: false, status: 0, body: `ffmpeg conversion failed (mime=${mime}). Установите ffmpeg на VPS.` };
      }
      body = converted;
      format = "oggopus";
    }

    const url = new URL("https://stt.api.cloud.yandex.net/speech/v1/stt:recognize");
    url.searchParams.set("topic", "general");
    url.searchParams.set("lang", "ru-RU");
    url.searchParams.set("format", format);
    if (folderId) url.searchParams.set("folderId", folderId);
    if (format === "lpcm") url.searchParams.set("sampleRateHertz", "48000");

    const r = await fetch(url.toString(), {
      method: "POST",
      headers: { Authorization: `Api-Key ${apiKey}` },
      body,
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
