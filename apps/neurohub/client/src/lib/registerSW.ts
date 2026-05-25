// Eugene 2026-05-25: Service Worker ОТКЛЮЧЁН.
//
// SW (network-first + reject-таймаут + кэш-стратегии) трижды за день дал
// чёрный экран / «FetchEvent.respondWith ... timeout» на iOS LTE и не отдавал
// управление застрявшим устройствам. Решение — убрать SW полностью: сайт
// работает напрямую с сервера (он быстрый). PWA/offline вернём позже отдельным,
// тщательно протестированным SW.
//
// Эта функция теперь НЕ регистрирует SW, а наоборот — снимает любую
// существующую регистрацию и чистит кэши (на случай если kill-switch sw.js
// ещё не отработал). Re-register НЕ делаем → никакой петли.
export function registerServiceWorker(): void {
  if (typeof window === "undefined") return;
  if (!("serviceWorker" in navigator)) return;

  window.addEventListener("load", () => {
    try {
      navigator.serviceWorker.getRegistrations()
        .then((regs) => { regs.forEach((r) => { r.unregister().catch(() => {}); }); })
        .catch(() => {});
    } catch {}
    try {
      if (typeof caches !== "undefined" && caches.keys) {
        caches.keys()
          .then((keys) => keys.forEach((k) => { caches.delete(k).catch(() => {}); }))
          .catch(() => {});
      }
    } catch {}
  });
}
