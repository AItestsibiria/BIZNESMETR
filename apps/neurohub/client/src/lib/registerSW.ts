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
// Eugene 2026-05-30 субагент: предыдущая версия снимала регистрацию SW + чистила
// кэши, НО без forced reload — текущая страница оставалась на СТАРОМ JS-бандле
// до следующего ручного захода. Босс жаловался «нажатие на ↩ к Музе открывает
// меню Поехали» — это симптом старого бандла с перевёрнутыми handlers.
//
// FIX: один раз после unregister'а делаем `location.reload()` со страховкой
// от loop'а через localStorage flag `muzaai-sw-killed-v1`. После reload'а
// flag установлен → больше не перезагружаемся → клиент работает на свежем JS.
export function registerServiceWorker(): void {
  if (typeof window === "undefined") return;
  if (!("serviceWorker" in navigator)) return;

  window.addEventListener("load", () => {
    let hadRegistration = false;
    let alreadyKilled = false;
    try {
      alreadyKilled = window.localStorage?.getItem("muzaai-sw-killed-v1") === "1";
    } catch { /* no-op */ }
    try {
      navigator.serviceWorker.getRegistrations()
        .then((regs) => {
          hadRegistration = regs.length > 0;
          regs.forEach((r) => { r.unregister().catch(() => {}); });
          // Чистим кэши параллельно.
          try {
            if (typeof caches !== "undefined" && caches.keys) {
              return caches.keys().then((keys) =>
                Promise.all(keys.map((k) => caches.delete(k).catch(() => false)))
              );
            }
          } catch { /* no-op */ }
          return null;
        })
        .then(() => {
          // Forced one-time reload — только если на устройстве реально был SW
          // и мы ещё не делали kill'а в прошлой сессии.
          if (hadRegistration && !alreadyKilled) {
            try { window.localStorage?.setItem("muzaai-sw-killed-v1", "1"); } catch { /* no-op */ }
            // Небольшая задержка чтобы unregister успел зафиксироваться.
            window.setTimeout(() => { try { window.location.reload(); } catch { /* no-op */ } }, 150);
          }
        })
        .catch(() => {});
    } catch { /* no-op */ }
  });
}
