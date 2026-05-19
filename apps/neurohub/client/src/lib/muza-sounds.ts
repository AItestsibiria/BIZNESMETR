// muzaSounds (Eugene 2026-05-14 Босс): нежные мини-звуки для UI Музы.
// Web Audio API — синтезируем коротко, без mp3-файлов.
//
// Eugene 2026-05-14 (v2): «звук одной нотой, мягче, комфортнее».
// Все sound-функции теперь — 1 тон с длинным attack/decay, тёплая частота,
// очень тихий volume. Никаких аккордов / трезвучий.
//
// Eugene 2026-05-19: feature-toggle респект — если юзер отключил
// «chat-sounds» в Settings, все play-функции становятся no-op.

import { featureEnabled } from "./featureToggles";

let ctx: AudioContext | null = null;
let muted = false;

function ensure(): AudioContext | null {
  if (typeof window === "undefined") return null;
  if (muted) return null;
  if (!ctx) {
    try { ctx = new (window.AudioContext || (window as any).webkitAudioContext)(); }
    catch { return null; }
  }
  return ctx;
}

export function setMuzaSoundsMuted(v: boolean) { muted = v; }
export function getMuzaSoundsMuted() { return muted; }

// 1-тон gentle chime — для клика на Музу и появления ответа.
// G4 (392 Hz) — тёплая средняя частота, не пронзительная.
export function playMuzaChime(opts?: { volume?: number }): void {
  if (!featureEnabled("chat-sounds")) return;
  const audio = ensure();
  if (!audio) return;
  try {
    const now = audio.currentTime;
    const volume = opts?.volume ?? 0.045;
    const osc = audio.createOscillator();
    const gain = audio.createGain();
    osc.type = "sine";
    osc.frequency.setValueAtTime(392, now); // G4 — мягкая средняя
    gain.gain.setValueAtTime(0, now);
    gain.gain.linearRampToValueAtTime(volume, now + 0.08); // плавный attack
    gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.9); // долгий decay
    osc.connect(gain).connect(audio.destination);
    osc.start(now);
    osc.stop(now + 1.0);
  } catch {}
}

// 1-тон gentle tick — для send. A4 (440 Hz), коротко.
export function playMuzaTick(opts?: { volume?: number }): void {
  if (!featureEnabled("chat-sounds")) return;
  const audio = ensure();
  if (!audio) return;
  try {
    const now = audio.currentTime;
    const volume = opts?.volume ?? 0.035;
    const osc = audio.createOscillator();
    const gain = audio.createGain();
    osc.type = "sine";
    osc.frequency.setValueAtTime(440, now); // A4
    gain.gain.setValueAtTime(0, now);
    gain.gain.linearRampToValueAtTime(volume, now + 0.03);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.28);
    osc.connect(gain).connect(audio.destination);
    osc.start(now);
    osc.stop(now + 0.32);
  } catch {}
}

// 1-тон sparkle — для важных моментов (открытие чата). D5 (587 Hz), мягко.
export function playMuzaSparkle(opts?: { volume?: number }): void {
  if (!featureEnabled("chat-sounds")) return;
  const audio = ensure();
  if (!audio) return;
  try {
    const now = audio.currentTime;
    const volume = opts?.volume ?? 0.045;
    const osc = audio.createOscillator();
    const gain = audio.createGain();
    osc.type = "sine";
    osc.frequency.setValueAtTime(587.33, now); // D5 — чуть выше chime, праздничнее
    gain.gain.setValueAtTime(0, now);
    gain.gain.linearRampToValueAtTime(volume, now + 0.1); // мягкий attack
    gain.gain.exponentialRampToValueAtTime(0.0001, now + 1.1); // долгий decay
    osc.connect(gain).connect(audio.destination);
    osc.start(now);
    osc.stop(now + 1.2);
  } catch {}
}
