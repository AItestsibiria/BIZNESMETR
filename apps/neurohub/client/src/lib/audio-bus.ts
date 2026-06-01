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
//
// Eugene 2026-05-18 9-я итерация LS: persistent player audio (с маркером
// data-muziai-player) — это singleton который ВСЕГДА должен быть тем,
// что играет когда юзер слушает трек. audio-bus НЕ должен paus'ить его
// в ответ на воспроизведение чего-то другого (background-music и т.п.) —
// только наоборот: всё прочее паузится в пользу persistent player.

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

// Eugene 2026-05-14 Босс «правило: одновременно на сайте играет
// ИСКЛЮЧИТЕЛЬНО одна песня». КАРДИНАЛЬНО: перед каждым audio.play()
// синхронно pause ВСЕ другие audio:
// 1) document.querySelectorAll("audio") — DOM-elements
// 2) tracked set — non-DOM (new Audio())
// 3) window.__muziaiAudio — cross-page survival audio
//
// Раньше pauseAllExcept была no-op из-за подозрений на моргание,
// но моргание было от другого источника (React re-renders).
// Возвращаем активную работу.
export function pauseAllExcept(except: HTMLAudioElement | null): void {
  if (typeof document !== "undefined") {
    document.querySelectorAll("audio").forEach((a) => {
      if (a !== except && !a.paused) {
        try { a.pause(); } catch {}
      }
    });
  }
  for (const a of tracked) {
    if (a !== except && !a.paused) {
      try { a.pause(); } catch {}
    }
  }
  if (typeof window !== "undefined") {
    const ga = (window as any).__muziaiAudio as HTMLAudioElement | undefined;
    if (ga && ga !== except && !ga.paused) {
      try { ga.pause(); } catch {}
    }
  }
}
