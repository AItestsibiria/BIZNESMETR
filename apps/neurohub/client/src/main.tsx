import { createRoot } from "react-dom/client";
import App from "./App";
import "./index.css";
import { initPixels, trackPageView } from "./lib/pixels";
import { captureLeadTouch } from "./lib/tracking";
import { installAudioBus } from "./lib/audio-bus";
import { registerServiceWorker } from "./lib/registerSW";
import { installUserJourney } from "./lib/user-journey";

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
initPixels();
trackPageView();
captureLeadTouch().catch(() => undefined);

// Eugene 2026-05-12 (Босс): только ОДНА песня одновременно на сайте.
// Глобальный listener pause'ит остальные audio при play любого.
installAudioBus();
// Eugene 2026-05-21 Босс: PWA auto-update — изменения сайта подхватываются
// в installed-on-home-screen приложении при следующем заходе (или live через
// background SW update каждые 5 мин). См. lib/registerSW.ts + public/sw.js.
registerServiceWorker();

// Eugene 2026-05-17 (Босс): карта пути юзера — page_view/click/scroll/
// idle/form_focus/form_abandon/leave. Buffer + batch /api/journey/batch
// каждые 5 сек. Используется (1) admin-аналитикой и (2) smart-триггерами
// Музы (slow-thinking, form-abandon → подсказка появляется).
installUserJourney();

createRoot(document.getElementById("root")!).render(<App />);
