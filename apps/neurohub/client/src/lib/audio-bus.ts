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

const tracked = new Set<HTMLAudioElement>();
let installed = false;

// Eugene 2026-05-14 Босс: фикс «два трека одновременно при открытии главной».
// Проблема была: глобальный 'play' listener ловит event ПОСЛЕ того как
// аудио уже стартует — был быстрый промежуток когда обе песни звучали.
// Решение: добавить pauseAllExcept() для СИНХРОННОЙ паузы старых ДО play()
// нового. Listener остаётся как safety net.
//
// Дополнительно: убрали cleanup на 'emptied' (слишком ранний), чтобы
// long-lived global audio (__muziaiAudio) оставался в set между навигациями.

export function pauseAllExcept(except: HTMLAudioElement | null): void {
  // Pause все DOM-audio (включая <audio controls>, lock-screen, mic-recorder etc)
  if (typeof document !== "undefined") {
    document.querySelectorAll("audio").forEach((a) => {
      if (a !== except && !a.paused) {
        try { a.pause(); } catch {}
      }
    });
  }
  // Pause все non-DOM (new Audio() через registerAudio)
  for (const a of tracked) {
    if (a !== except && !a.paused) {
      try { a.pause(); } catch {}
    }
  }
  // Pause cross-page global audio (если разные SPA-страницы создали
  // свои audioRef, но __muziaiAudio сохраняется)
  if (typeof window !== "undefined") {
    const ga = (window as any).__muziaiAudio as HTMLAudioElement | undefined;
    if (ga && ga !== except && !ga.paused) {
      try { ga.pause(); } catch {}
    }
  }
}

export function installAudioBus(): void {
  if (installed || typeof document === "undefined") return;
  installed = true;
  // capture=true — ловим event 'play' до того как обработчики компонента
  // отреагируют. Safety net на случай если pauseAllExcept не вызван
  // прямо перед play().
  document.addEventListener("play", (e) => {
    const current = e.target as HTMLMediaElement | null;
    if (!current || (current.tagName !== "AUDIO" && current.tagName !== "VIDEO")) return;
    pauseAllExcept(current as HTMLAudioElement);
  }, true);
}

// Регистрирует non-DOM audio (new Audio()). DOM-elements не нужно.
export function registerAudio(audio: HTMLAudioElement): void {
  if (!audio) return;
  tracked.add(audio);
  // При play этого audio — pause всех остальных (на случай если глобальный
  // listener не сработал из-за detached element).
  audio.addEventListener("play", () => {
    pauseAllExcept(audio);
  });
  // Eugene 2026-05-14: убран cleanup на 'emptied' (срабатывал слишком
  // рано — при смене src, до фактического конца). Оставляем только 'ended'
  // — настоящий конец трека.
  const cleanup = () => tracked.delete(audio);
  audio.addEventListener("ended", cleanup);
}
