// muzaSounds (Eugene 2026-05-14 Босс): нежные мини-звуки для UI Музы.
// Web Audio API — синтезируем коротко, без mp3-файлов (не нагружаем сеть).
//
// Идея: короткий 2-нот мелодичный звон при ключевых действиях.
// Тоны мягкие, low-volume чтобы не мешать.

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

// Короткий 2-нота chime — для открытия меню / клика кнопки.
export function playMuzaChime(opts?: { volume?: number }): void {
  const audio = ensure();
  if (!audio) return;
  try {
    const now = audio.currentTime;
    const volume = opts?.volume ?? 0.06; // тихий
    // C5 → E5 (мажорная терция, мечтательное)
    const notes = [
      { freq: 523.25, delay: 0, len: 0.35 },
      { freq: 659.25, delay: 0.08, len: 0.5 },
    ];
    notes.forEach(n => {
      const osc = audio.createOscillator();
      const gain = audio.createGain();
      osc.type = "sine";
      osc.frequency.setValueAtTime(n.freq, now + n.delay);
      gain.gain.setValueAtTime(0, now + n.delay);
      gain.gain.linearRampToValueAtTime(volume, now + n.delay + 0.04);
      gain.gain.exponentialRampToValueAtTime(0.0001, now + n.delay + n.len);
      osc.connect(gain).connect(audio.destination);
      osc.start(now + n.delay);
      osc.stop(now + n.delay + n.len + 0.05);
    });
  } catch {}
}

// Совсем тихий 1-тон tick — для send-button / клика по chip.
export function playMuzaTick(opts?: { volume?: number }): void {
  const audio = ensure();
  if (!audio) return;
  try {
    const now = audio.currentTime;
    const volume = opts?.volume ?? 0.04;
    const osc = audio.createOscillator();
    const gain = audio.createGain();
    osc.type = "sine";
    osc.frequency.setValueAtTime(880, now); // A5
    gain.gain.setValueAtTime(0, now);
    gain.gain.linearRampToValueAtTime(volume, now + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.18);
    osc.connect(gain).connect(audio.destination);
    osc.start(now);
    osc.stop(now + 0.22);
  } catch {}
}

// Sparkle 3-нота — для важных моментов (например первое открытие чата).
export function playMuzaSparkle(opts?: { volume?: number }): void {
  const audio = ensure();
  if (!audio) return;
  try {
    const now = audio.currentTime;
    const volume = opts?.volume ?? 0.05;
    // Восходящая С-Е-G (мажорное трезвучие)
    const notes = [
      { freq: 523.25, delay: 0 },     // C5
      { freq: 659.25, delay: 0.10 },  // E5
      { freq: 783.99, delay: 0.20 },  // G5
    ];
    notes.forEach(n => {
      const osc = audio.createOscillator();
      const gain = audio.createGain();
      osc.type = "sine";
      osc.frequency.setValueAtTime(n.freq, now + n.delay);
      gain.gain.setValueAtTime(0, now + n.delay);
      gain.gain.linearRampToValueAtTime(volume, now + n.delay + 0.04);
      gain.gain.exponentialRampToValueAtTime(0.0001, now + n.delay + 0.55);
      osc.connect(gain).connect(audio.destination);
      osc.start(now + n.delay);
      osc.stop(now + n.delay + 0.6);
    });
  } catch {}
}
