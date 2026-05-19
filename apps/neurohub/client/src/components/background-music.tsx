// Background music для /music страницы — играет лёгкую музыку
// пока идёт генерация трека. Eugene 2026-05-09: вернули из stub.
// Asset: /audio/bgm.mp3 (космическая лента в стиле Interstellar).
// Volume низкая (0.25) чтобы не мешать диалогу/уведомлениям.
//
// Eugene 2026-05-19: feature-toggle респект — если юзер отключил
// «background-music» в Settings, startBgMusic() становится no-op.

import { featureEnabled } from "@/lib/featureToggles";

let bgmAudio: HTMLAudioElement | null = null;
let muted = false;

function ensure(): HTMLAudioElement {
  if (bgmAudio) return bgmAudio;
  bgmAudio = new Audio("/audio/bgm.mp3");
  bgmAudio.loop = true;
  bgmAudio.volume = 0.25;
  bgmAudio.preload = "auto";
  return bgmAudio;
}

export function startBgMusic(): void {
  if (!featureEnabled("background-music")) return;
  try {
    const a = ensure();
    if (muted) return;
    a.currentTime = 0;
    a.play().catch(() => {
      // Autoplay-policy: первый user gesture запустит. Один listener.
      const onGesture = () => {
        document.removeEventListener("click", onGesture);
        document.removeEventListener("touchstart", onGesture);
        a.play().catch(() => {});
      };
      document.addEventListener("click", onGesture, { once: true });
      document.addEventListener("touchstart", onGesture, { once: true });
    });
  } catch {}
}

export function stopBgMusic(): void {
  try {
    if (!bgmAudio) return;
    bgmAudio.pause();
    bgmAudio.currentTime = 0;
  } catch {}
}

export function muteBgMusic(): void {
  muted = true;
  try { if (bgmAudio) bgmAudio.volume = 0; } catch {}
}

export function unmuteBgMusic(): void {
  muted = false;
  try { if (bgmAudio) bgmAudio.volume = 0.25; } catch {}
}

export default function BackgroundMusic() {
  return null;
}
