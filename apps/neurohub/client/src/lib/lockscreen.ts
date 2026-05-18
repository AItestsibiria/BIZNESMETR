// iOS/Android lock-screen metadata helper using the Media Session API.
//
// Eugene 2026-05-18 Босс «lockscreen показывает MuzaAi logo + document.title
// вместо реального трека». ROOT CAUSE: на iOS Safari MediaSession.metadata
// читается СИНХРОННО когда audio.play() резолвится. Если metadata ещё не
// установлен — iOS берёт fallback: document.title как title + apple-touch-icon
// (favicon.svg = MuzaAi logo) как artwork. Поэтому ВСЕГДА:
//   1. setLockScreenTrackSync(meta) — синхронно в click-handler ДО audio.play()
//   2. audio.play() — в том же gesture-tick
//   3. setLockScreenTrack(meta, handlers, bust) — async вдогонку, для prewarm
//      артуорка + retry (iOS первый раз иногда дропает metadata).
// Старый паттерн `audio.play(); setLockScreenTrack(...)` приводил к baseline
// fallback на 200-500ms окно — Босс видит logo даже после исправления.
//
// Дополнительно:
//   - Используем абсолютные https:// URL для artwork (iOS отвергает data: + relative)
//   - Multi-size массив (96/128/192/256/384/512) — iOS выбирает по DPI
//   - prewarm 512px через new Image() — кэшируем до того как iOS дёрнет URL
//   - clearLockScreenSilent — не сбрасывает в null чтобы не было flash logo

export interface TrackMeta {
  id: number | string;
  title: string;
  artist?: string;
  album?: string;
}

export interface LockScreenHandlers {
  play?: () => void;
  pause?: () => void;
  previoustrack?: () => void;
  nexttrack?: () => void;
  seekto?: (time: number) => void;
}

const ORIGIN =
  typeof window !== "undefined" && window.location
    ? `${window.location.protocol}//${window.location.host}`
    : "";

/**
 * Build a MediaImage[] with multiple sizes pointing at /api/cover/<id>.jpg?size=N.
 * Returns absolute URLs. Includes a cache-buster only if `bust` is provided
 * (pass the gen update timestamp when cover is replaced so iOS refreshes).
 */
function buildArtwork(trackId: number | string, bust?: string | number): MediaImage[] {
  const sizes = [96, 128, 192, 256, 384, 512];
  const qs = bust ? `&v=${encodeURIComponent(String(bust))}` : "";
  return sizes.map(s => ({
    src: `${ORIGIN}/api/cover/${trackId}.jpg?size=${s}${qs}`,
    sizes: `${s}x${s}`,
    type: "image/jpeg",
  }));
}

/**
 * Pre-load the 512px cover so the image is in the HTTP cache before iOS
 * queries it. Without this, the first lock-screen frame often shows a
 * fallback/logo because iOS requests the artwork URL and times out.
 */
function prewarmCover(trackId: number | string, bust?: string | number): Promise<void> {
  return new Promise(resolve => {
    if (typeof window === "undefined") { resolve(); return; }
    const img = new Image();
    const qs = bust ? `&v=${encodeURIComponent(String(bust))}` : "";
    img.src = `${ORIGIN}/api/cover/${trackId}.jpg?size=512${qs}`;
    const done = () => resolve();
    img.onload = done;
    img.onerror = done;
    // Safety timeout — don't block playback if network is slow
    setTimeout(done, 1500);
  });
}

/**
 * 🔒 СИНХРОННАЯ установка lock-screen metadata. Вызывается ДО audio.play()
 * в том же tick'е что клик-handler. iOS читает metadata синхронно в момент
 * когда play() резолвится — если metadata = null, iOS берёт document.title.
 *
 * Не делает prewarm (это async) — только базовый MediaMetadata с artwork URLs.
 * Полный prewarm + retry — через setLockScreenTrack() async вдогонку.
 *
 * @returns true если metadata установлен, false если MediaSession не доступен
 */
export function setLockScreenTrackSync(
  meta: TrackMeta,
  handlers: LockScreenHandlers,
  coverBust?: string | number,
): boolean {
  if (typeof navigator === "undefined" || !("mediaSession" in navigator)) return false;

  const uniqueBust = `${coverBust || meta.id}-${Date.now()}`;
  const artwork = buildArtwork(meta.id, uniqueBust);

  try {
    navigator.mediaSession.metadata = new MediaMetadata({
      title: meta.title || "MuzaAi",
      artist: meta.artist || "MuzaAi",
      album: meta.album || "MuzaAi",
      artwork,
    });
  } catch {
    // Older Safari versions may throw if artwork URLs aren't reachable.
    try {
      navigator.mediaSession.metadata = new MediaMetadata({
        title: meta.title || "MuzaAi",
        artist: meta.artist || "MuzaAi",
        album: meta.album || "MuzaAi",
      });
    } catch {
      return false;
    }
  }

  // Action handlers тоже устанавливаем sync — iOS показывает доступные
  // кнопки (prev/play/pause/next) на lock-screen на основании зарегистрированных.
  const bind = (name: MediaSessionAction, fn?: () => void) => {
    try {
      navigator.mediaSession.setActionHandler(name, fn ? () => fn() : null);
    } catch {}
  };
  bind("play", handlers.play);
  bind("pause", handlers.pause);
  bind("previoustrack", handlers.previoustrack);
  bind("nexttrack", handlers.nexttrack);
  if (handlers.seekto) {
    try {
      navigator.mediaSession.setActionHandler("seekto", details => {
        if (details.seekTime !== undefined && handlers.seekto) handlers.seekto(details.seekTime);
      });
    } catch {}
  }

  // Dev console: видно в Safari DevTools (Mac → iPad → Web Inspector)
  if (typeof window !== "undefined" && (window as any).__MUZAAI_LS_DEBUG !== false) {
    // eslint-disable-next-line no-console
    console.log("[lockscreen] sync set:", { title: meta.title, artist: meta.artist, artworkCount: artwork.length });
  }

  return true;
}

/**
 * Apply track metadata + action handlers to the Media Session with
 * prewarm and iOS retry workaround. Async — call AFTER setLockScreenTrackSync()
 * which already set basic metadata synchronously before audio.play().
 *
 * Eugene 2026-05-15 Босс «LS трек переключается а обложка нет»:
 * 1. Сначала clear metadata (помогает iOS сбросить кэш artwork)
 * 2. В bust добавляем Date.now() чтобы URL был уникальный при каждом
 *    переключении → iOS перезагружает image, не берёт из кэша.
 *
 * Eugene 2026-05-18: теперь это SUPPLEMENTAL вызов после sync-варианта —
 * prewarm + double-write для устранения iOS first-write drop.
 */
export async function setLockScreenTrack(
  meta: TrackMeta,
  handlers: LockScreenHandlers,
  coverBust?: string | number
): Promise<void> {
  if (typeof navigator === "undefined" || !("mediaSession" in navigator)) return;

  const uniqueBust = `${coverBust || meta.id}-${Date.now()}`;

  // 1. Pre-warm image — теперь параллельно с уже играющим audio
  await prewarmCover(meta.id, uniqueBust);

  // 2. Build artwork array with multiple absolute https URLs
  const artwork = buildArtwork(meta.id, uniqueBust);

  // 3. Re-apply metadata (поверх sync-варианта) — теперь с уже прогретым artwork
  const apply = () => {
    try {
      navigator.mediaSession.metadata = new MediaMetadata({
        title: meta.title || "MuzaAi",
        artist: meta.artist || "MuzaAi",
        album: meta.album || "MuzaAi",
        artwork,
      });
    } catch {
      try {
        navigator.mediaSession.metadata = new MediaMetadata({
          title: meta.title || "MuzaAi",
          artist: meta.artist || "MuzaAi",
          album: meta.album || "MuzaAi",
        });
      } catch {}
    }
  };
  apply();
  // 4. Re-apply after 300ms to work around iOS first-write drop bug
  setTimeout(apply, 300);

  // 5. Re-register action handlers (если sync-вариант не успел)
  const bind = (name: MediaSessionAction, fn?: () => void) => {
    try {
      navigator.mediaSession.setActionHandler(name, fn ? () => fn() : null);
    } catch {}
  };
  bind("play", handlers.play);
  bind("pause", handlers.pause);
  bind("previoustrack", handlers.previoustrack);
  bind("nexttrack", handlers.nexttrack);

  if (handlers.seekto) {
    try {
      navigator.mediaSession.setActionHandler("seekto", details => {
        if (details.seekTime !== undefined && handlers.seekto) handlers.seekto(details.seekTime);
      });
    } catch {}
  }

  if (typeof window !== "undefined" && (window as any).__MUZAAI_LS_DEBUG !== false) {
    // eslint-disable-next-line no-console
    console.log("[lockscreen] async refresh:", { title: meta.title, artworkPrewarmed: true });
  }
}

/** Update just the playback state flag shown on the lock screen. */
export function setLockScreenPlaybackState(state: "playing" | "paused" | "none"): void {
  if (typeof navigator === "undefined" || !("mediaSession" in navigator)) return;
  try { navigator.mediaSession.playbackState = state; } catch {}
}

/**
 * Update the position indicator so the lock-screen scrubber works.
 * Call on timeupdate throttled to ~every 500ms.
 */
export function setLockScreenPosition(duration: number, position: number, playbackRate = 1): void {
  if (typeof navigator === "undefined" || !("mediaSession" in navigator)) return;
  if (typeof (navigator.mediaSession as any).setPositionState !== "function") return;
  if (!isFinite(duration) || duration <= 0) return;
  try {
    (navigator.mediaSession as any).setPositionState({
      duration,
      position: Math.min(Math.max(0, position), duration),
      playbackRate,
    });
  } catch {}
}

/**
 * Eugene 2026-05-18: clearLockScreen используется при unmount компонента.
 * НЕ сбрасываем metadata = null чтобы iOS не упал в fallback на document.title
 * (тот самый «MuzaAi — Создавай музыку с AI» logo). Только playbackState=none
 * чтобы кнопка play на lock-screen выглядела как «остановлено».
 */
export function clearLockScreen(): void {
  if (typeof navigator === "undefined" || !("mediaSession" in navigator)) return;
  try {
    navigator.mediaSession.playbackState = "none";
  } catch {}
}

/**
 * Full reset — нужен только когда юзер явно вышел из плеера и хочет
 * чтобы lock-screen больше не показывал трек. Сбрасывает metadata в null.
 * Использовать осторожно: между этим вызовом и следующим setLockScreenTrack
 * iOS может показать document.title fallback.
 */
export function resetLockScreen(): void {
  if (typeof navigator === "undefined" || !("mediaSession" in navigator)) return;
  try {
    navigator.mediaSession.metadata = null;
    navigator.mediaSession.playbackState = "none";
  } catch {}
}
