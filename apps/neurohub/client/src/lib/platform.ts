// Eugene 2026-05-30 — детект платформы для функции «Скачать на устройство».
//
// Различаем 3 контекста запуска MuzaAi:
//   1. Capacitor app (iOS/Android wrapper) — нативный shell, есть Filesystem API.
//      Сохраняем audio через @capacitor/filesystem в Directory.Data.
//   2. PWA standalone (Add-to-Home-Screen, display-mode: standalone) — браузер,
//      но юзер ощущает как app. Сохраняем через IndexedDB + Blob URL.
//   3. Обычный браузер (desktop / mobile web) — fallback на классический
//      `<a download>` через file save dialog. Никакого offline-кэша.
//
// SW отключён (kill-switch в public/sw.js, Eugene 2026-05-25) — поэтому
// PWA offline идёт через IndexedDB + Blob URL, не через cache API.
//
// Все детекторы безопасны: при typeof undefined возвращают false. Помечаем
// результат как cached — детект на каждый клик не имеет смысла, контекст
// один на сессию.

let cachedIsCapacitor: boolean | null = null;
let cachedIsPwa: boolean | null = null;

/** Запущено ли приложение внутри Capacitor wrapper (нативный iOS/Android shell)? */
export function isCapacitorApp(): boolean {
  if (cachedIsCapacitor !== null) return cachedIsCapacitor;
  if (typeof window === "undefined") return false;
  try {
    const cap = (window as any).Capacitor;
    cachedIsCapacitor =
      !!cap && typeof cap.isNativePlatform === "function" && cap.isNativePlatform();
  } catch {
    cachedIsCapacitor = false;
  }
  return cachedIsCapacitor === true;
}

/** Platform-имя нативного shell — "ios" / "android" / "web". */
export function getCapacitorPlatform(): "ios" | "android" | "web" {
  if (typeof window === "undefined") return "web";
  try {
    const cap = (window as any).Capacitor;
    const p = cap?.getPlatform?.();
    if (p === "ios" || p === "android") return p;
  } catch {}
  return "web";
}

/** Запущено ли в PWA standalone-режиме (добавлено на home-screen)? */
export function isPwa(): boolean {
  if (cachedIsPwa !== null) return cachedIsPwa;
  if (typeof window === "undefined") return false;
  try {
    // iOS Safari использует navigator.standalone (старый API)
    const iosStandalone = (navigator as any).standalone === true;
    // Современный display-mode: standalone | fullscreen | minimal-ui
    const dm =
      typeof window.matchMedia === "function"
        ? window.matchMedia("(display-mode: standalone)").matches ||
          window.matchMedia("(display-mode: fullscreen)").matches
        : false;
    cachedIsPwa = iosStandalone || dm;
  } catch {
    cachedIsPwa = false;
  }
  return cachedIsPwa === true;
}

/** Мобильное устройство (для tooltip-текста и long-press fallback). */
export function isMobileUA(): boolean {
  if (typeof navigator === "undefined") return false;
  const ua = (navigator.userAgent || "").toLowerCase();
  if (/iphone|ipod|android.*mobile|windows phone|blackberry/.test(ua)) return true;
  // iPad pro в desktop-mode маскируется под Mac — touch points > 1
  if (/macintosh/.test(ua) && (navigator as any).maxTouchPoints > 1) return true;
  if (/ipad/.test(ua)) return true;
  if (/android/.test(ua)) return true;
  return false;
}

/**
 * Можем ли мы сохранить трек «в приложение» с offline-доступом?
 *
 * true — Capacitor app ИЛИ PWA. В обоих случаях есть persistent storage
 *        (Filesystem или IndexedDB) и юзер ожидает app-like UX.
 * false — обычный браузер. Save идёт через классический `<a download>` —
 *        файл попадает в Downloads, открывается во внешнем плеере.
 */
export function canSaveToDevice(): boolean {
  return isCapacitorApp() || isPwa();
}

/**
 * Тип хранилища, который будет использован при сохранении.
 *  - "filesystem" — Capacitor @capacitor/filesystem
 *  - "indexeddb" — IndexedDB + Blob URL (PWA standalone)
 *  - "browser-download" — fallback, без offline (классический download)
 */
export type SaveTarget = "filesystem" | "indexeddb" | "browser-download";

export function getSaveTarget(): SaveTarget {
  if (isCapacitorApp()) return "filesystem";
  if (isPwa()) return "indexeddb";
  return "browser-download";
}
