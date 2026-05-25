// MuzaAi PWA Service Worker
// Eugene 2026-05-25 Босс: «на смартфоне нет плеера и лист». ROOT CAUSE: HTML
// был cache-first → мобильный получал СТАРЫЙ HTML (старый JS-хэш) → новый
// деплой подхватывался только со 2-й загрузки. ФИКС: HTML → network-first с
// таймаутом 2.5с (свежий деплой сразу; VPN-fallback на cache при медленной
// сети). + бамп версии кэшей (v2→v3) форсит переустановку SW и чистку старых
// кэшей на всех устройствах.
//
// Стратегия:
//   - HTML (navigate) → network-first + 2.5s timeout fallback на cache
//   - JS/CSS/woff hash-named → cache-first (immutable build artifacts)
//   - Images → cache-first + stale-while-revalidate
//   - API GET (whitelist) → stale-while-revalidate (playlist, stats, countries)
//   - API остальные (POST, auth, etc) → network-only (не кэшируем)
//
// При появлении новой версии SW → skipWaiting + clients.claim → новые
// requests идут через новую версию без ручного обновления страницы.

const CACHE_VERSION = "muzaai-v3";
const RUNTIME_CACHE = "muzaai-runtime-v3";
const API_CACHE = "muzaai-api-v3";

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
    // Eugene 2026-05-25 КРИТ-ФИКС: SW НИКОГДА не должен reject'ить respondWith —
    // иначе Safari на медленном LTE показывает «FetchEvent.respondWith received an
    // error: Error: timeout» = белый экран. Прошлый вариант делал reject по 2.5с
    // таймауту и throw при пустом кэше. Теперь:
    //  • есть кэш → отдаём из кэша быстро (гонка сеть vs 3с; таймаут РЕЗОЛВИТ null);
    //  • нет кэша → ЖДЁМ реальную сеть (без искусственного таймаута, важно для LTE);
    //  • сеть недоступна и кэша нет → минимальный HTML. Никаких throw.
    event.respondWith(
      (async () => {
        const cache = await caches.open(RUNTIME_CACHE);
        const cached = await cache.match(request);
        const networkP = fetch(request, { cache: "no-store" })
          .then((fresh) => {
            if (fresh && fresh.ok) { try { cache.put(request, fresh.clone()); } catch {} }
            return fresh;
          })
          .catch(() => null);
        if (cached) {
          const fresh = await Promise.race([
            networkP,
            new Promise((res) => setTimeout(() => res(null), 3000)),
          ]);
          if (fresh && fresh.ok) return fresh;
          return cached;
        }
        const fresh = await networkP;
        if (fresh) return fresh;
        const root = await caches.match("/");
        if (root) return root;
        return new Response(
          "<!doctype html><meta charset=utf-8><meta name=viewport content=\"width=device-width,initial-scale=1\"><title>MuzaAi</title><body style=\"background:#0a0a17;color:#fff;font-family:sans-serif;text-align:center;padding-top:40vh\">Загрузка… <a href=\"/\" style=\"color:#a78bfa\">обновить</a></body>",
          { status: 200, headers: { "Content-Type": "text/html; charset=utf-8" } }
        );
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
        try {
          const fresh = await fetch(request);
          if (fresh.ok) {
            const cache = await caches.open(CACHE_VERSION);
            cache.put(request, fresh.clone());
          }
          return fresh;
        } catch {
          return new Response("", { status: 504 }); // никогда не throw
        }
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
        try {
          const fresh = await fetch(request);
          if (fresh.ok) {
            const cache = await caches.open(RUNTIME_CACHE);
            cache.put(request, fresh.clone());
          }
          return fresh;
        } catch {
          return new Response("", { status: 504 }); // никогда не throw
        }
      })()
    );
    return;
  }

  // === Остальное — network-first с fallback на cache (никогда не throw) ===
  event.respondWith(
    (async () => {
      try {
        return await fetch(request);
      } catch (e) {
        const cached = await caches.match(request);
        if (cached) return cached;
        return new Response("", { status: 504 });
      }
    })()
  );
});

self.addEventListener("message", (event) => {
  if (event.data && event.data.type === "SKIP_WAITING") {
    self.skipWaiting();
  }
});
