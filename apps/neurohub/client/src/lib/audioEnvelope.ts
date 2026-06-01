// Eugene 2026-05-26 Босс «прокачай iOS-решение эквалайзера — что можно сделать».
//
// ПРОБЛЕМА iOS: AnalyserNode требует createMediaElementSource на ЖИВОМ <audio>,
// а это ЗАПРЕЩЕНО на iOS — ломает lock-screen/фоновое воспроизведение
// (iOS-lock-screen-audio rule). Значит реальный спектр играющего элемента на
// iOS не снять.
//
// РЕШЕНИЕ (lock-screen-safe): отдельно СКАЧАТЬ трек и декодировать его
// (decodeAudioData на ArrayBuffer — НЕ маршрутизирует живой <audio> через
// AudioContext, поэтому фоновое воспроизведение не ломается), построить
// ОГИБАЮЩУЮ громкости (RMS по кадрам ~30 fps). Во время игры эквалайзер
// синхронизируется по `audio.currentTime` → реальная реакция на ритм/биты трека.
//
// Стоимость: один fetch+decode на трек (кэшируется; URL тот же, что у плеера —
// обычно отдаётся из HTTP-кэша, без двойной загрузки). Низкий sample-rate
// (11025 Гц) снижает память. Всё в try/catch — НИКОГДА не ломает воспроизведение.

export interface TrackEnvelope {
  /** Нормализованная огибающая громкости (0..1) по кадрам. */
  env: Float32Array;
  /** Длительность одного кадра в секундах. */
  frameSec: number;
}

const FPS = 30;
const DECODE_RATE = 11025; // Гц — достаточно для огибающей, мало памяти
const MAX_DURATION_SEC = 12 * 60; // не декодируем слишком длинные (защита памяти)
const MAX_CACHE = 12;

const _cache = new Map<string, Promise<TrackEnvelope | null>>();

function isIOS(): boolean {
  if (typeof navigator === "undefined") return false;
  if (/iPad|iPhone|iPod/.test(navigator.userAgent)) return true;
  return navigator.platform === "MacIntel" && (navigator as any).maxTouchPoints > 1;
}

async function build(url: string): Promise<TrackEnvelope | null> {
  try {
    if (typeof window === "undefined") return null;
    const OAC = (window as any).OfflineAudioContext || (window as any).webkitOfflineAudioContext;
    if (!OAC) return null;

    // 1) Скачиваем трек (credentials — protected stream; чаще из HTTP-кэша).
    const resp = await fetch(url, { credentials: "include", cache: "force-cache" as RequestCache });
    if (!resp.ok) return null;
    const arr = await resp.arrayBuffer();

    // 2) Декодируем на низком rate (OfflineAudioContext.decodeAudioData
    //    ресемплит к sampleRate контекста → меньше памяти). Это НЕ трогает
    //    живой <audio> элемент → lock-screen safe.
    const decodeCtx = new OAC(1, Math.ceil(DECODE_RATE * 1), DECODE_RATE);
    const audioBuf: AudioBuffer = await decodeCtx.decodeAudioData(arr);
    if (!audioBuf || audioBuf.duration <= 0 || audioBuf.duration > MAX_DURATION_SEC) return null;

    // 3) Downmix в моно.
    const len = audioBuf.length;
    const ch0 = audioBuf.getChannelData(0);
    const ch1 = audioBuf.numberOfChannels > 1 ? audioBuf.getChannelData(1) : null;

    // 4) RMS по кадрам.
    const sr = audioBuf.sampleRate;
    const frameLen = Math.max(1, Math.floor(sr / FPS));
    const frames = Math.ceil(len / frameLen);
    const env = new Float32Array(frames);
    let max = 1e-6;
    for (let f = 0; f < frames; f++) {
      const start = f * frameLen;
      const end = Math.min(len, start + frameLen);
      let sum = 0;
      for (let i = start; i < end; i++) {
        const s = ch1 ? (ch0[i] + ch1[i]) * 0.5 : ch0[i];
        sum += s * s;
      }
      const rms = Math.sqrt(sum / Math.max(1, end - start));
      env[f] = rms;
      if (rms > max) max = rms;
    }
    // 5) Нормализуем 0..1 + лёгкая гамма для «живости» пиков.
    for (let f = 0; f < frames; f++) {
      env[f] = Math.pow(env[f] / max, 0.7);
    }
    return { env, frameSec: 1 / FPS };
  } catch (e) {
    // decode/CORS/память — тихо отдаём null, эквалайзер падёт на имитацию.
    return null;
  }
}

/**
 * Возвращает (кэшированную) огибающую трека или null. Best-effort:
 * при любой ошибке/неподдержке — null (вызывающий код использует имитацию).
 * Применять имеет смысл прежде всего на iOS (где AnalyserNode недоступен);
 * на desktop/Android лучше живой AnalyserNode (getPlayerAnalyser).
 */
export function getTrackEnvelope(url: string): Promise<TrackEnvelope | null> {
  if (!url) return Promise.resolve(null);
  const cached = _cache.get(url);
  if (cached) return cached;
  if (_cache.size >= MAX_CACHE) {
    const firstKey = _cache.keys().next().value;
    if (firstKey) _cache.delete(firstKey);
  }
  const p = build(url);
  _cache.set(url, p);
  return p;
}

export { isIOS as isIOSDevice };
