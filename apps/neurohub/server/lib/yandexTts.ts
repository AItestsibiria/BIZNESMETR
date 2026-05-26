// v304: Yandex SpeechKit TTS wrapper (Eugene 2026-05-17 Босс «Муза доложит»).
//
// Назначение: синтез русской речи через Yandex SpeechKit для admin-озвучки.
// Использует тот же ключ что и STT (YANDEX_SPEECHKIT_API_KEY).
//
// Endpoint: POST https://tts.api.cloud.yandex.net/speech/v1/tts:synthesize
// Docs: https://yandex.cloud/ru/docs/speechkit/tts/request
//
// Pre-edit analysis:
//  - Использует только process.env (без хардкода).
//  - Не пишет логи с PII (только длины + voice).
//  - Возвращает Buffer mp3 без модификации (бинарь, не парсим).

import { Buffer } from "node:buffer";

// Eugene 2026-05-17 Босс «8 голосов voice picker»: расширен список с 7 до 8 —
// добавлен `madirus` (мужской премиум-голос с низким pitch). Эмоции neutral /
// good / evil поддерживаются только женскими голосами (alena, jane, oksana,
// omazh) — мужские принимают параметр но Yandex API его игнорирует.
export type YandexVoice =
  | "alena"
  | "jane"
  | "oksana"
  | "omazh"
  | "zahar"
  | "ermil"
  | "filipp"
  | "madirus";

export interface TtsOptions {
  text: string;
  voice?: YandexVoice;
  // Eugene 2026-05-26 Босс «голос не работает нигде/на iOS». ROOT: v1 mp3 —
  // «ненастоящий» (не играет), oggopus НЕ играет на Safari/iOS. «wav» —
  // универсальный формат: запрашиваем lpcm (настоящий PCM) + оборачиваем в
  // WAV-заголовок → играет ВЕЗДЕ (iOS/Safari/Chrome/Android/Firefox).
  format?: "mp3" | "oggopus" | "lpcm" | "wav";
  emotion?: "neutral" | "good" | "evil";
  speed?: number; // 0.1 — 3.0
}

// Оборачивает сырой PCM (signed 16-bit LE, mono) в WAV-контейнер (44-байт
// заголовок). WAV — единственный формат, который играют ВСЕ платформы в <audio>.
function pcmToWav(pcm: Buffer, sampleRate: number): Buffer {
  const numChannels = 1;
  const bitsPerSample = 16;
  const byteRate = (sampleRate * numChannels * bitsPerSample) / 8;
  const blockAlign = (numChannels * bitsPerSample) / 8;
  const header = Buffer.alloc(44);
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write("WAVE", 8);
  header.write("fmt ", 12);
  header.writeUInt32LE(16, 16);          // PCM fmt chunk size
  header.writeUInt16LE(1, 20);           // audioFormat = PCM
  header.writeUInt16LE(numChannels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(blockAlign, 32);
  header.writeUInt16LE(bitsPerSample, 34);
  header.write("data", 36);
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}

const WAV_SAMPLE_RATE = 48000;

export interface TtsResult {
  ok: boolean;
  audio?: Buffer;
  contentType?: string;
  error?: string;
  httpStatus?: number;
  durationMs?: number;
}

const ENDPOINT = "https://tts.api.cloud.yandex.net/speech/v1/tts:synthesize";
const MAX_TEXT_LEN = 5000; // Yandex hard-limit ~5000 chars per request
const TIMEOUT_MS = 30_000;

function clampSpeed(n: number | undefined): number {
  if (typeof n !== "number" || !Number.isFinite(n)) return 1.0;
  return Math.min(3.0, Math.max(0.1, n));
}

/**
 * Синтезирует речь через Yandex SpeechKit TTS.
 * Возвращает Buffer mp3 + Content-Type (для прямой передачи в res).
 */
export async function synthesizeYandexTts(opts: TtsOptions): Promise<TtsResult> {
  const apiKey = process.env.YANDEX_SPEECHKIT_API_KEY;
  const folderId = process.env.YANDEX_FOLDER_ID;

  if (!apiKey) {
    return { ok: false, error: "YANDEX_SPEECHKIT_API_KEY missing" };
  }
  const text = (opts.text || "").trim();
  if (!text) {
    return { ok: false, error: "text is empty" };
  }
  if (text.length > MAX_TEXT_LEN) {
    return { ok: false, error: `text too long (${text.length} > ${MAX_TEXT_LEN})` };
  }

  const voice: YandexVoice = opts.voice || "alena";
  const reqFormat = opts.format || "wav";
  // «wav» → у Yandex запрашиваем lpcm + sampleRateHertz, потом оборачиваем в WAV.
  const wantWav = reqFormat === "wav";
  const yandexFormat = wantWav ? "lpcm" : reqFormat;
  const emotion = opts.emotion || "neutral";
  const speed = clampSpeed(opts.speed);

  const form = new URLSearchParams();
  form.set("text", text);
  form.set("lang", "ru-RU");
  form.set("voice", voice);
  form.set("format", yandexFormat);
  if (wantWav) form.set("sampleRateHertz", String(WAV_SAMPLE_RATE));
  form.set("emotion", emotion);
  form.set("speed", String(speed));
  if (folderId) form.set("folderId", folderId);

  const startedAt = Date.now();
  try {
    console.log(
      `[YANDEX-TTS] sending: textLen=${text.length} voice=${voice} format=${reqFormat}(${yandexFormat}) hasFolderId=${!!folderId}`,
    );
    const r = await fetch(ENDPOINT, {
      method: "POST",
      headers: {
        Authorization: `Api-Key ${apiKey}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: form.toString(),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    const durationMs = Date.now() - startedAt;
    if (!r.ok) {
      const txt = await r.text().catch(() => "");
      console.warn(
        `[YANDEX-TTS] HTTP ${r.status} (${durationMs}ms): ${txt.slice(0, 200)}`,
      );
      return {
        ok: false,
        httpStatus: r.status,
        error: `Yandex TTS HTTP ${r.status}: ${txt.slice(0, 200)}`,
        durationMs,
      };
    }
    const ab = await r.arrayBuffer();
    let audio = Buffer.from(ab);
    let contentType: string;
    if (wantWav) {
      // Оборачиваем сырой PCM в WAV → играет на всех платформах (вкл. iOS/Safari).
      audio = pcmToWav(audio, WAV_SAMPLE_RATE);
      contentType = "audio/wav";
    } else {
      contentType =
        yandexFormat === "mp3" ? "audio/mpeg"
        : yandexFormat === "oggopus" ? "audio/ogg"
        : "audio/lpcm";
    }
    console.log(
      `[YANDEX-TTS] ok: ${audio.length} bytes ${reqFormat} (${durationMs}ms)`,
    );
    return { ok: true, audio, contentType, httpStatus: 200, durationMs };
  } catch (e) {
    const durationMs = Date.now() - startedAt;
    const msg = e instanceof Error ? e.message : String(e);
    console.error(`[YANDEX-TTS] exception (${durationMs}ms): ${msg}`);
    return { ok: false, error: `network/timeout: ${msg.slice(0, 150)}`, durationMs };
  }
}

// === Простой in-memory cache по hash(text+voice) на 5 минут ===
// Снижает расходы при повторном click'е «Доложить ещё раз».

type CacheEntry = { audio: Buffer; contentType: string; expiresAt: number };
const ttsCache = new Map<string, CacheEntry>();
const TTS_CACHE_TTL_MS = 5 * 60 * 1000;
const TTS_CACHE_MAX_ENTRIES = 50;

function cacheKey(text: string, voice: YandexVoice, format: string): string {
  // sha256 без crypto, чтобы не тащить импорт ради этого — хэш через простой
  // FNV-1a 32-бит. Конфликт допустим (cache, не security).
  let h = 0x811c9dc5;
  const s = `${voice}|${format}|${text}`;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16);
}

export function getTtsFromCache(
  text: string,
  voice: YandexVoice,
  format: string,
): { audio: Buffer; contentType: string } | null {
  const key = cacheKey(text, voice, format);
  const e = ttsCache.get(key);
  if (!e) return null;
  if (e.expiresAt < Date.now()) {
    ttsCache.delete(key);
    return null;
  }
  return { audio: e.audio, contentType: e.contentType };
}

export function putTtsInCache(
  text: string,
  voice: YandexVoice,
  format: string,
  audio: Buffer,
  contentType: string,
): void {
  if (ttsCache.size >= TTS_CACHE_MAX_ENTRIES) {
    // Удаляем самые старые (просто первая запись Map.keys()).
    const first = ttsCache.keys().next().value;
    if (first) ttsCache.delete(first);
  }
  const key = cacheKey(text, voice, format);
  ttsCache.set(key, { audio, contentType, expiresAt: Date.now() + TTS_CACHE_TTL_MS });
}

/**
 * Стоимость в копейках за 1 запрос (приблизительно).
 * Yandex берёт по символам: ~400 ₽ за 1М символов (premium-голос).
 * Округление: 50 симв ≈ 2 коп, 500 симв ≈ 20 коп, 5000 симв ≈ 200 коп = 2 ₽.
 */
export function estimateTtsCostKopecks(textLen: number): number {
  return Math.ceil((textLen / 1_000_000) * 40_000); // 400 ₽ = 40000 коп за 1М симв
}
