import { createRoot } from "react-dom/client";
import App from "./App";
import "./index.css";
import { initPixels, trackPageView } from "./lib/pixels";
import { captureLeadTouch } from "./lib/tracking";
import { installClientErrorLogger } from "./lib/error-logger";

if (!window.location.hash) {
  window.location.hash = "#/";
}

// Capture PWA install prompt for later use
window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault();
  (window as any).__pwaInstallPrompt = e;
});

// Eugene 2026-05-10: client-side error logger — отлавливаем uncaught
// runtime + unhandled promise rejections со всех страниц, шлём на
// /api/client-errors. Eugene видит на admin-панели → анализ + варианты
// исправления (см. правило client-error-monitoring в CLAUDE.md).
installClientErrorLogger();

// v304 Sprint 1: pixels + lead-capture (UTM + first-touch).
// Pixels init is no-op when VITE_*_ID env-vars are absent.
// Lead capture is fire-and-forget; failures don't block UX.
initPixels();
trackPageView();
captureLeadTouch().catch(() => undefined);

createRoot(document.getElementById("root")!).render(<App />);
