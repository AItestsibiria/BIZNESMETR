// audioBus (Eugene 2026-05-12 Босс): одновременно на сайте играет
// ИСКЛЮЧИТЕЛЬНО ОДНА песня. Singleton-pattern через глобальный set
// HTMLAudioElement'ов + listener на event 'play' (capture phase).
//
// Использование:
// 1. Глобальный listener (installAudioBus) ставится в main.tsx один раз
//    и ловит ВСЕ <audio> в DOM
// 2. new Audio() (не в DOM) — регистрируется явно через registerAudio()
//
// При play() любого зарегистрированного — все остальные pause().
//
// Eugene 2026-05-14 Босс ОТКАТ: версия с pauseAllExcept() + удалённым
// emptied cleanup создавала каскад pause-событий и блокировала Stop
// в основном плеере. Возвращаемся к листенер-only варианту.

const tracked = new Set<HTMLAudioElement>();
let installed = false;

export function installAudioBus(): void {
  if (installed || typeof document === "undefined") return;
  installed = true;
  // capture=true — ловим event 'play' до того как обработчики компонента
  // отреагируют. Применимо для всех <audio> в DOM.
  document.addEventListener("play", (e) => {
    const current = e.target as HTMLMediaElement | null;
    if (!current || (current.tagName !== "AUDIO" && current.tagName !== "VIDEO")) return;
    // Pause все DOM-audio
    document.querySelectorAll("audio").forEach((a) => {
      if (a !== current && !a.paused) {
        try { a.pause(); } catch {}
      }
    });
    // Pause все non-DOM (зарегистрированные через registerAudio)
    for (const a of tracked) {
      if (a !== current && !a.paused) {
        try { a.pause(); } catch {}
      }
    }
  }, true);
}

// Регистрирует non-DOM audio (new Audio()). DOM-elements не нужно.
export function registerAudio(audio: HTMLAudioElement): void {
  if (!audio) return;
  tracked.add(audio);
  // При play этого audio — pause всех остальных (на случай если глобальный
  // listener не сработал из-за detached element).
  audio.addEventListener("play", () => {
    document.querySelectorAll("audio").forEach((a) => {
      if (a !== audio && !a.paused) { try { a.pause(); } catch {} }
    });
    for (const a of tracked) {
      if (a !== audio && !a.paused) { try { a.pause(); } catch {} }
    }
  });
  // Удаляем из set после конца / abort.
  const cleanup = () => tracked.delete(audio);
  audio.addEventListener("ended", cleanup);
  audio.addEventListener("emptied", cleanup);
}

// Eugene 2026-05-14 Босс: pauseAllExcept оставлен как no-op stub для
// backward compat (если где-то ещё импортируется). На практике
// passthrough — реальный singleton обеспечивается listener'ом выше.
export function pauseAllExcept(_except: HTMLAudioElement | null): void {
  // Намеренно no-op. Раньше эта функция СИНХРОННО паузила всё перед play,
  // что вызывало каскад pause/play событий → моргание + Stop не работал
  // в основном плеере (его pause был moментально перебит другим audio).
  // Listener-based path (выше) надёжнее.
}
