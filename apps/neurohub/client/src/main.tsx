import { createRoot } from "react-dom/client";
import App from "./App";
import "./index.css";
import { initPixels, trackPageView } from "./lib/pixels";
import { captureLeadTouch } from "./lib/tracking";
import { installAudioBus } from "./lib/audio-bus";
import { registerServiceWorker } from "./lib/registerSW";
import { installUserJourney } from "./lib/user-journey";
import { ErrorBoundary } from "./components/error-boundary";
import { isChunkLoadError, reloadOnceForChunk } from "./lib/chunkReload";
import { installAutoRecenter } from "./lib/autoRecenter";

if (!window.location.hash) {
  window.location.hash = "#/";
}

// Capture PWA install prompt for later use
window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault();
  (window as any).__pwaInstallPrompt = e;
});

// v304 Sprint 1: pixels + lead-capture (UTM + first-touch).
// Pixels init is no-op when VITE_*_ID env-vars are absent.
// Lead capture is fire-and-forget; failures don't block UX.
//
// Eugene 2026-05-25 (Босс) — чёрный экран на iOS: эти startup-side-effects
// выполняются ДО монтирования React, поэтому ВНЕ любого ErrorBoundary. Если
// хоть один бросит исключение (несовместимый API на старой iOS Safari, сбой
// инициализации pixel/journey) — main.tsx падает, createRoot никогда не
// вызывается → пустая тёмная страница. Каждый вызов изолирован try/catch:
// аналитика/PWA-cleanup не должны блокировать рендер сайта.
try { initPixels(); } catch (e) { console.warn("[startup] initPixels failed", e); }
try { trackPageView(); } catch (e) { console.warn("[startup] trackPageView failed", e); }
try { captureLeadTouch().catch(() => undefined); } catch (e) { console.warn("[startup] captureLeadTouch failed", e); }

// Eugene 2026-05-12 (Босс): только ОДНА песня одновременно на сайте.
// Глобальный listener pause'ит остальные audio при play любого.
try { installAudioBus(); } catch (e) { console.warn("[startup] installAudioBus failed", e); }
// Eugene 2026-05-21 Босс: PWA auto-update — изменения сайта подхватываются
// в installed-on-home-screen приложении при следующем заходе (или live через
// background SW update каждые 5 мин). См. lib/registerSW.ts + public/sw.js.
try { registerServiceWorker(); } catch (e) { console.warn("[startup] registerServiceWorker failed", e); }

// Eugene 2026-05-17 (Босс): карта пути юзера — page_view/click/scroll/
// idle/form_focus/form_abandon/leave. Buffer + batch /api/journey/batch
// каждые 5 сек. Используется (1) admin-аналитикой и (2) smart-триггерами
// Музы (slow-thinking, form-abandon → подсказка появляется).
try { installUserJourney(); } catch (e) { console.warn("[startup] installUserJourney failed", e); }

// Eugene 2026-05-29 (Босс) «Секунду — что-то сбойнуло» при заходе во время
// деплоя — корень: ChunkLoadError lazy-чанка (3D-глобус) у вкладки, открытой
// ДО деплоя (старые hash-чанки удалены → 404). Авто-восстановление: один
// guarded reload берёт свежий index.html (no-store) → новые хэши → чинится
// само, без действий юзера. См. lib/chunkReload.ts (sessionStorage-guard от петли).
try {
  window.addEventListener("vite:preloadError", () => { reloadOnceForChunk(); });
  window.addEventListener("error", (e) => {
    if (isChunkLoadError((e as any)?.error ?? (e as any)?.message)) reloadOnceForChunk();
  });
  window.addEventListener("unhandledrejection", (e) => {
    if (isChunkLoadError((e as PromiseRejectionEvent)?.reason)) reloadOnceForChunk();
  });
} catch (e) { console.warn("[startup] chunk-reload guard failed", e); }

// Eugene 2026-05-29 (Босс) Page-device-adaptation п.4: горизонтальный сдвиг
// страницы (overscroll/случайный свайп вбок) — через 2с без взаимодействия
// страница плавно центруется обратно. No-op если нет горизонтального overflow.
try { installAutoRecenter(); } catch (e) { console.warn("[startup] installAutoRecenter failed", e); }

// Eugene 2026-05-25 (Босс) — ТОТАЛЬНАЯ защита от чёрного экрана: оборачиваем
// всё дерево App в top-level ErrorBoundary. Раньше boundary стоял только на
// части роутов (withBoundary), а «/» (LandingPage) и App-провайдеры были БЕЗ
// него → один throw при module-load/first-render любого компонента = пустая
// тёмная страница (React не монтировался, ничего не рендерилось). Теперь
// любой single-throw показывает красный фолбэк + шлёт стек на /api/_client-error
// (componentDidCatch) → мы видим реальную причину в логах вместо «чёрного экрана».
createRoot(document.getElementById("root")!).render(
  <ErrorBoundary pageName="root">
    <App />
  </ErrorBoundary>
);
