// MuzaAi PWA Service Worker
// Eugene 2026-05-21 Босс: «изменения на сайте автоматически отправляются в
// приложение которое для сохранения домой». Strategy:
//   - HTML (navigate requests) → network-first (всегда последняя версия)
//   - JS/CSS с hash в имени → cache-first (immutable build artifacts)
//   - Images (cover, avatar) → cache-first с network fallback
//   - API (/api/*) → НЕ кэшируем (always live)
// Auto-update: при появлении нового SW версии — skipWaiting + clients.claim
// → новые requests идут через новую версию без ручного обновления.

const CACHE_VERSION = "muzaai-v1";
const RUNTIME_CACHE = "muzaai-runtime";

// При install — skipWaiting сразу, не ждём пока юзер закроет все вкладки.
self.addEventListener("install", (event) => {
  self.skipWaiting();
});

// При activate — claim всех клиентов + удалить старые caches.
self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      const cacheNames = await caches.keys();
      await Promise.all(
        cacheNames
          .filter((name) => name !== CACHE_VERSION && name !== RUNTIME_CACHE)
          .map((name) => caches.delete(name))
      );
      await self.clients.claim();
    })()
  );
});

self.addEventListener("fetch", (event) => {
  const { request } = event;
  const url = new URL(request.url);

  // Игнорируем не-GET и cross-origin (другие домены)
  if (request.method !== "GET") return;
  if (url.origin !== self.location.origin) return;

  // /api/* — НЕ кэшируем (live data)
  if (url.pathname.startsWith("/api/")) return;

  // HTML navigation requests — network-first (свежий index.html)
  const isNavigation = request.mode === "navigate" ||
    (request.headers.get("accept") || "").includes("text/html");

  if (isNavigation) {
    event.respondWith(
      (async () => {
        try {
          const fresh = await fetch(request, { cache: "no-store" });
          // Кэшируем последний валидный HTML на случай оффлайна
          const cache = await caches.open(RUNTIME_CACHE);
          cache.put(request, fresh.clone());
          return fresh;
        } catch (e) {
          // Оффлайн — отдаём из cache
          const cached = await caches.match(request);
          if (cached) return cached;
          // Совсем нет — fallback на корень
          const root = await caches.match("/");
          if (root) return root;
          throw e;
        }
      })()
    );
    return;
  }

  // JS/CSS с hash (immutable build artifacts) — cache-first
  // Vite добавляет hash в filename → URL меняется при build → новый файл.
  const isAsset = url.pathname.startsWith("/assets/") ||
    url.pathname.match(/\.(js|css|woff2?|ttf|otf)$/);

  if (isAsset) {
    event.respondWith(
      (async () => {
        const cached = await caches.match(request);
        if (cached) return cached;
        const fresh = await fetch(request);
        if (fresh.ok) {
          const cache = await caches.open(CACHE_VERSION);
          cache.put(request, fresh.clone());
        }
        return fresh;
      })()
    );
    return;
  }

  // Images / static (cover, avatar, favicon) — cache-first
  const isImage = url.pathname.match(/\.(svg|png|jpg|jpeg|webp|gif|ico)$/);
  if (isImage) {
    event.respondWith(
      (async () => {
        const cached = await caches.match(request);
        if (cached) {
          // Background refresh — stale-while-revalidate
          fetch(request).then((fresh) => {
            if (fresh.ok) caches.open(RUNTIME_CACHE).then((c) => c.put(request, fresh));
          }).catch(() => {});
          return cached;
        }
        const fresh = await fetch(request);
        if (fresh.ok) {
          const cache = await caches.open(RUNTIME_CACHE);
          cache.put(request, fresh.clone());
        }
        return fresh;
      })()
    );
    return;
  }

  // Остальное — network-first с fallback на cache
  event.respondWith(
    (async () => {
      try {
        return await fetch(request);
      } catch (e) {
        const cached = await caches.match(request);
        if (cached) return cached;
        throw e;
      }
    })()
  );
});

// Listener для message events (от клиента) — например принудительное skipWaiting
self.addEventListener("message", (event) => {
  if (event.data && event.data.type === "SKIP_WAITING") {
    self.skipWaiting();
  }
});
