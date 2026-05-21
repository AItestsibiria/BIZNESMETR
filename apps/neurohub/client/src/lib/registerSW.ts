// Eugene 2026-05-21 Босс: «изменения на сайте автоматически отправляются в
// приложение для сохранения домой» — PWA auto-update.
//
// Регистрирует Service Worker (см. public/sw.js).
// При появлении новой версии:
//   1. Background install нового SW
//   2. Detect через registration.onupdatefound
//   3. postMessage SKIP_WAITING → новый SW activate
//   4. Silent reload через controllerchange event
//
// Без UI dialog — auto-update silently, юзер видит последнюю версию.

export function registerServiceWorker(): void {
  if (typeof window === "undefined") return;
  if (!("serviceWorker" in navigator)) return;

  // Регистрируем после load чтобы не блокировать initial render
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("/sw.js", { scope: "/" })
      .then((registration) => {
        // При установке нового SW
        registration.onupdatefound = () => {
          const installing = registration.installing;
          if (!installing) return;
          installing.onstatechange = () => {
            if (installing.state === "installed" && navigator.serviceWorker.controller) {
              // Новая версия установлена — активируем сразу
              installing.postMessage({ type: "SKIP_WAITING" });
            }
          };
        };

        // Проверяем обновления каждые 5 минут (при активной сессии)
        setInterval(() => {
          registration.update().catch(() => {});
        }, 5 * 60 * 1000);
      })
      .catch((e) => {
        console.warn("[SW] registration failed:", e);
      });

    // Когда новый SW активировался → reload (silent)
    let refreshing = false;
    navigator.serviceWorker.addEventListener("controllerchange", () => {
      if (refreshing) return;
      refreshing = true;
      window.location.reload();
    });
  });
}
