import { createRoot } from "react-dom/client";
import App from "./App";
import "./index.css";
import { initPixels, trackPageView } from "./lib/pixels";
import { captureLeadTouch } from "./lib/tracking";
import { installAudioBus } from "./lib/audio-bus";

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

createRoot(document.getElementById("root")!).render(<App />);
