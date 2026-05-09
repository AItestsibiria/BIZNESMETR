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
    // Eugene 2026-05-08: даже ogg/opus прогоняем через ffmpeg для гарантии
    // -t 30 trim. Yandex 30-сек лимит должен соблюдаться независимо от
    // того что прислали (audio-upload или прямой upload).
    const tmpDir = os.tmpdir();
    // ТЗ Eugene 13:45: mp3 (audio/mpeg) был «bin» → ffmpeg не распознавал.
    const inExt =
      mime.includes("webm") ? "webm" :
      mime.includes("mp4") || mime.includes("m4a") ? "m4a" :
      mime.includes("wav") ? "wav" :
      mime.includes("mpeg") || mime.includes("mp3") ? "mp3" :
      mime.includes("ogg") || mime.includes("opus") ? "ogg" :
      "bin";
    const inFile = path.join(tmpDir, `stt-${Date.now()}-${Math.random().toString(36).slice(2)}.${inExt}`);
    const outFile = inFile.replace(/\.\w+$/, ".ogg");
    try { fs.writeFileSync(inFile, input); } catch { resolve(null); return; }
    // -c:a copy не работает webm→ogg (разные контейнеры, Opus можно копировать
    // но ffmpeg иногда хочет re-mux). Пробуем без -c:a copy для надёжности.
    // BACKEND-4 fix: execFile вместо exec, no shell injection
    childProc.execFile(
      "ffmpeg",
      // Eugene 2026-05-08 «после 30 сек голос не распознаётся» — defense in depth.
      // Yandex SpeechKit short-audio лимит = 30 сек / 1MB. Audio-upload уже trim'ит
      // через ffmpeg, но при network race / browser bug может прийти больше.
      // Здесь — 2-я линия защиты: ВСЕГДА -t 30, тогда Yandex точно примет.
      ["-y", "-i", inFile, "-t", "30", "-vn", "-c:a", "libopus", "-ar", "48000", "-ac", "1", outFile],
      { timeout: 30_000 },
      (err) => {
        // BACKEND-5: cleanup ВСЕГДА — успех или fail
        const cleanup = () => {
          try { fs.unlinkSync(inFile); } catch {}
          try { fs.unlinkSync(outFile); } catch {}
        };
        if (err) { cleanup(); resolve(null); return; }
        try {
          const out = fs.readFileSync(outFile);
          cleanup();
          resolve(out);
        } catch {
          cleanup();
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
  console.log(`[YANDEX-STT] in: bufferSize=${buffer.length} mime=${mime} hasKey=${!!apiKey} keyLen=${apiKey?.length || 0} folderId=${folderId || "<none>"}`);
  if (!apiKey) return { provider: "yandex", ok: false, error: "YANDEX_SPEECHKIT_API_KEY missing" };
  if (buffer.length < 1000) {
    console.warn(`[YANDEX-STT] buffer too small (${buffer.length} bytes) — likely empty recording`);
    return { provider: "yandex", ok: false, error: `buffer too small: ${buffer.length} bytes — запись похоже пустая` };
  }

  const t = await timed(async () => {
    let body = buffer;
    let format = "oggopus";
    if (mime.includes("wav")) {
      format = "lpcm";
    } else {
      const converted = await convertToOggOpus(buffer, mime);
      if (!converted) {
        console.error(`[YANDEX-STT] ffmpeg conversion failed mime=${mime} bufferSize=${buffer.length}`);
        return { ok: false, status: 0, body: `ffmpeg conversion failed (mime=${mime}). Возможно битый/неподдерживаемый формат записи с iPad/Safari.` };
      }
      console.log(`[YANDEX-STT] ffmpeg ok: ${buffer.length} → ${converted.length} bytes ogg/opus`);
      body = converted;
      format = "oggopus";
    }

    const url = new URL("https://stt.api.cloud.yandex.net/speech/v1/stt:recognize");
    url.searchParams.set("topic", "general");
    url.searchParams.set("lang", "ru-RU");
    url.searchParams.set("format", format);
    if (folderId) url.searchParams.set("folderId", folderId);
    if (format === "lpcm") url.searchParams.set("sampleRateHertz", "48000");

    console.log(`[YANDEX-STT] sending: url=${url.toString()} bodySize=${body.length}`);
    const r = await fetch(url.toString(), {
      method: "POST",
      headers: { Authorization: `Api-Key ${apiKey}` },
      body,
      signal: AbortSignal.timeout(60_000),
    });
    const txt = await r.text().catch(() => "");
    console.log(`[YANDEX-STT] response: status=${r.status} body=${txt.slice(0, 200)}`);
    return { ok: r.ok, status: r.status, body: txt };
  });
  if (t.err) {
    console.error(`[YANDEX-STT] exception:`, t.err);
    return { provider: "yandex", ok: false, error: `network/timeout: ${String(t.err).slice(0, 150)}`, durationMs: t.ms };
  }
  const r = t.result!;
  if (!r.ok) return { provider: "yandex", ok: false, httpStatus: r.status, error: `Yandex HTTP ${r.status}: ${r.body.slice(0, 200)}`, durationMs: t.ms };
  try {
    const json = JSON.parse(r.body);
    const text = String(json?.result ?? "").trim();
    if (!text) {
      console.warn(`[YANDEX-STT] empty result — Yandex не услышал речь в ${buffer.length}-байтовом аудио. Возможно тишина или слишком короткая запись.`);
    }
    return {
      provider: "yandex",
      ok: !!text,
      transcript: text,
      error: text ? undefined : `Yandex вернул HTTP 200 result="" — речь не распознана. Запись: ${buffer.length} bytes mime=${mime}. Попробуй говорить громче, ближе к микрофону, минимум 3 сек.`,
      httpStatus: 200,
      durationMs: t.ms,
    };
  } catch (e) {
    return { provider: "yandex", ok: false, error: `parse error: ${r.body.slice(0, 100)}`, durationMs: t.ms };
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
 * Транскрипция: только Yandex SpeechKit. Eugene 2026-05-09: убрали
 * fallback на OpenAI Whisper и GPTunnel Whisper — лишние провайдеры с
 * лишними сообщениями для пользователя. Yandex русский — single source.
 * Если Yandex упал/вернул пустой результат → юзер видит понятное
 * сообщение «Yandex SpeechKit временно недоступен».
 */
export async function transcribeRussianAudio(buffer: Buffer, mime: string, ext: string): Promise<TranscribeResult> {
  const attempts: TranscribeAttempt[] = [];
  const a = await tryYandex(buffer, mime);
  attempts.push(a);
  if (a.ok && a.transcript) {
    return { transcript: a.transcript, provider: "yandex", attempts };
  }
  return { transcript: "", provider: null, attempts };
}

/**
 * Verify: оставляем только Yandex — для админ-диагностики /verify-stt.
 */
export async function verifyAllProviders(buffer: Buffer, mime: string, ext: string): Promise<TranscribeAttempt[]> {
  return [await tryYandex(buffer, mime)];
}
