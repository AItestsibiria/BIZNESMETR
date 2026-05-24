// Eugene 2026-05-24 Босс «SpeechSynthesis fallback если Yandex TTS не
// настроен — РЕШИ». Cross-platform TTS helper:
// 1. Если backend вернул audioUrl (Yandex TTS) — играем через <audio>
// 2. Иначе fallback на browser SpeechSynthesis API (free, offline,
//    работает на всех современных браузерах включая iOS Safari)
//
// Browser SpeechSynthesis quirks:
// - iOS Safari требует user-gesture для первого speak()
// - voices загружаются async — getVoices() пуст до 'voiceschanged' event
// - Музa = девушка → ищем female-sounding ru voice

let voicesLoaded = false;
let cachedVoices: SpeechSynthesisVoice[] = [];

function ensureVoices(): Promise<SpeechSynthesisVoice[]> {
  if (typeof window === "undefined" || !window.speechSynthesis) return Promise.resolve([]);
  const synth = window.speechSynthesis;
  const v = synth.getVoices();
  if (v.length > 0) {
    cachedVoices = v;
    voicesLoaded = true;
    return Promise.resolve(v);
  }
  if (voicesLoaded) return Promise.resolve(cachedVoices);
  return new Promise<SpeechSynthesisVoice[]>((resolve) => {
    const handler = () => {
      cachedVoices = synth.getVoices();
      voicesLoaded = true;
      try { synth.removeEventListener("voiceschanged", handler); } catch {}
      resolve(cachedVoices);
    };
    try { synth.addEventListener("voiceschanged", handler); } catch {}
    // Safety timeout — не ждём бесконечно
    setTimeout(() => {
      try { synth.removeEventListener("voiceschanged", handler); } catch {}
      cachedVoices = synth.getVoices();
      resolve(cachedVoices);
    }, 1500);
  });
}

export function isSpeechSynthesisSupported(): boolean {
  return typeof window !== "undefined" && !!window.speechSynthesis;
}

/**
 * Browser SpeechSynthesis fallback. Cross-platform.
 * Musa-female-voice rule — ищем female ru voice.
 */
export async function speakText(text: string, options?: { lang?: string; rate?: number; pitch?: number }): Promise<void> {
  if (!isSpeechSynthesisSupported()) return;
  const synth = window.speechSynthesis;
  try { synth.cancel(); } catch {}
  const voices = await ensureVoices();
  const utterance = new SpeechSynthesisUtterance(text);
  utterance.lang = options?.lang || "ru-RU";
  utterance.rate = options?.rate ?? 1.05;
  utterance.pitch = options?.pitch ?? 1.05; // slightly higher for female feel
  utterance.volume = 1.0;
  // Voice selection: female ru → male ru → any ru → any
  const ruVoices = voices.filter(v => v.lang.toLowerCase().startsWith("ru"));
  const female = ruVoices.find(v => /female|f(emale)?|жен|alena|tatyana|katya|anna|alice|алёна|татьяна|катя|анна|алиса/i.test(v.name));
  if (female) {
    utterance.voice = female;
  } else if (ruVoices[0]) {
    utterance.voice = ruVoices[0];
  }
  return new Promise<void>((resolve) => {
    utterance.onend = () => resolve();
    utterance.onerror = () => resolve();
    try { synth.speak(utterance); } catch { resolve(); }
  });
}

/**
 * Universal TTS playback: Yandex audioUrl (priority) → SpeechSynthesis (fallback).
 * Возвращает promise который resolves когда playback закончен.
 */
export async function playTTS(audioUrl: string | null | undefined, text: string, options?: { lang?: string }): Promise<{ source: "audio" | "speech" | "none" }> {
  if (audioUrl) {
    try {
      const audio = new Audio(audioUrl);
      audio.preload = "auto";
      const playPromise = audio.play();
      if (playPromise && typeof playPromise.catch === "function") {
        await playPromise.catch(() => { throw new Error("audio play rejected"); });
      }
      await new Promise<void>(resolve => {
        audio.onended = () => resolve();
        audio.onerror = () => resolve();
        // Safety timeout 60 sec (rare TTS длиннее)
        setTimeout(resolve, 60_000);
      });
      return { source: "audio" };
    } catch {
      // fall through to speech synthesis
    }
  }
  if (text && isSpeechSynthesisSupported()) {
    await speakText(text, options);
    return { source: "speech" };
  }
  return { source: "none" };
}

/**
 * Stop любой active TTS (audio или speech).
 */
export function stopTTS(): void {
  if (typeof window === "undefined") return;
  try { window.speechSynthesis?.cancel(); } catch {}
  // Audio elements — caller responsible (нет global tracking).
}
