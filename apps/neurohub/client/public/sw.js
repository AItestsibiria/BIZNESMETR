// MuzaAi — KILL-SWITCH Service Worker (Eugene 2026-05-25).
//
// SW вызывал чёрный экран / «FetchEvent.respondWith ... timeout» на iOS LTE
// (network-first reject-таймаут + пустой кэш). Лечить по кусочкам больше
// нельзя — застрявший старый SW не отдавал управление. Поэтому SW ПОЛНОСТЬЮ
// отключается: этот скрипт при активации чистит ВСЕ кэши, снимает регистрацию
// и перезагружает открытые вкладки → сайт работает напрямую с сервера
// (network-only). PWA/offline вернём позже отдельным, корректно протестированным SW.
//
// Браузер сам подтягивает /sw.js (минуя контроль старого SW) при навигации,
// поэтому даже застрявшие устройства получат этот kill-switch и восстановятся
// без ручной очистки кэша.

self.addEventListener("install", () => {
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      // 1. Снести все кэши (старый HTML/JS/бандл).
      try {
        const keys = await caches.keys();
        await Promise.all(keys.map((k) => caches.delete(k)));
      } catch {}
      // 2. Снять регистрацию самого SW.
      try { await self.registration.unregister(); } catch {}
      // 3. Перезагрузить открытые вкладки → они грузятся уже БЕЗ SW (network).
      try {
        const clients = await self.clients.matchAll({ type: "window" });
        clients.forEach((c) => { try { c.navigate(c.url); } catch {} });
      } catch {}
    })()
  );
});

// НЕТ fetch-обработчика → SW ничего не перехватывает; все запросы идут
// напрямую в сеть. До своей деактивации этот SW не может вызвать timeout/чёрный
// экран, потому что не трогает respondWith.
