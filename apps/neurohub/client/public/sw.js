// MuzaAi PWA Service Worker
// Eugene 2026-05-22 Босс: «В режиме VPN тормозит всё, зависает. Реши
// кардинально». Стратегия — cache-first для HTML + stale-while-revalidate
// для read-only API → юзер видит контент МГНОВЕННО из cache, fresh приходит
// в фоне через VPN не блокируя UI.
//
// Стратегия:
//   - HTML (navigate) → cache-first + background revalidate
//                       (раньше было network-first — VPN latency блокировала)
//   - JS/CSS/woff hash-named → cache-first (immutable build artifacts)
//   - Images → cache-first + stale-while-revalidate
//   - API GET (whitelist) → stale-while-revalidate (playlist, stats, countries)
//   - API остальные (POST, auth, etc) → network-only (не кэшируем)
//
// При появлении новой версии SW → skipWaiting + clients.claim → новые
// requests идут через новую версию без ручного обновления страницы.

const CACHE_VERSION = "muzaai-v2";
const RUNTIME_CACHE = "muzaai-runtime-v2";
const API_CACHE = "muzaai-api-v2";

// Whitelist GET endpoints для stale-while-revalidate.
// Никаких user-specific / auth-affected данных — только public reads.
const API_SWR_PATHS = [
  "/api/playlist",
  "/api/playlist/stats",
  "/api/playlist/sort-default",
  "/api/playlist/geo-top",
  "/api/public/countries-count",
  "/api/star-suggestions/top",
];

self.addEventListener("install", () => {
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      const names = await caches.keys();
      await Promise.all(
        names
          .filter((n) => n !== CACHE_VERSION && n !== RUNTIME_CACHE && n !== API_CACHE)
          .map((n) => caches.delete(n))
      );
      await self.clients.claim();
    })()
  );
});

function isApiSwrPath(pathname) {
  return API_SWR_PATHS.some((p) => pathname === p || pathname.startsWith(p + "?") || pathname === p + "/");
}

self.addEventListener("fetch", (event) => {
  const { request } = event;
  const url = new URL(request.url);

  if (request.method !== "GET") return;
  if (url.origin !== self.location.origin) return;

  // === API ===
  if (url.pathname.startsWith("/api/")) {
    if (!isApiSwrPath(url.pathname)) {
      // POST/auth/stream/payment — network-only, не кэшируем
      return;
    }
    // Stale-while-revalidate для whitelisted reads
    event.respondWith(
      (async () => {
        const cache = await caches.open(API_CACHE);
        const cached = await cache.match(request);
        // Background revalidate (fire-and-forget)
        const networkP = fetch(request).then((fresh) => {
          if (fresh && fresh.ok) {
            try { cache.put(request, fresh.clone()); } catch {}
          }
          return fresh;
        }).catch(() => null);
        // Если есть cached — отдаём мгновенно. Иначе ждём network.
        if (cached) return cached;
        const fresh = await networkP;
        if (fresh) return fresh;
        // Сетевой fail + нет cache → возвращаем синтетический 503 JSON
        return new Response(JSON.stringify({ error: "offline" }), {
          status: 503,
          headers: { "Content-Type": "application/json" },
        });
      })()
    );
    return;
  }

  // === HTML navigation ===
  const isNavigation = request.mode === "navigate" ||
    (request.headers.get("accept") || "").includes("text/html");

  if (isNavigation) {
    // Cache-first + background revalidate. Юзер видит страницу мгновенно
    // даже на медленном VPN. Fresh HTML обновляет cache в фоне для next load.
    event.respondWith(
      (async () => {
        const cache = await caches.open(RUNTIME_CACHE);
        const cached = await cache.match(request);
        const networkP = fetch(request, { cache: "no-store" }).then((fresh) => {
          if (fresh && fresh.ok) {
            try { cache.put(request, fresh.clone()); } catch {}
          }
          return fresh;
        }).catch(() => null);
        if (cached) {
          // background revalidate, не ждём
          return cached;
        }
        const fresh = await networkP;
        if (fresh) return fresh;
        // Совсем нет — fallback на корневой index из CACHE_VERSION
        const root = await caches.match("/");
        if (root) return root;
        throw new Error("No cached HTML and no network");
      })()
    );
    return;
  }

  // === Static assets (JS/CSS/fonts) — cache-first (immutable hash-named) ===
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

  // === Images — cache-first + stale-while-revalidate ===
  const isImage = url.pathname.match(/\.(svg|png|jpg|jpeg|webp|gif|ico)$/);
  if (isImage) {
    event.respondWith(
      (async () => {
        const cached = await caches.match(request);
        if (cached) {
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

  // === Остальное — network-first с fallback на cache ===
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

self.addEventListener("message", (event) => {
  if (event.data && event.data.type === "SKIP_WAITING") {
    self.skipWaiting();
  }
});
