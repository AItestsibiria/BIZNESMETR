// iOS/Android lock-screen metadata via the Media Session API.
//
// Eugene 2026-05-18 Босс «реши на 100%, изучи Apple docs». 8-я итерация.
//
// ROOT CAUSES обнаруженные в этой переработке (по Apple WebKit + W3C MediaSession spec):
//   1. iOS Safari NowPlaying читает MediaSession metadata только когда есть
//      ИГРАЮЩИЙ media-element, замеченный OS. `new Audio()` (detached, не
//      в DOM) НЕ всегда трекается NowPlaying — fix отдельным коммитом
//      (audio.appendChild в landing/dashboard playTrack).
//   2. metadata должна быть установлена СИНХРОННО внутри user-gesture
//      стэка ДО audio.play(). Любой await/Promise.then перед apply →
//      gesture stack потерян, iOS уже снял snapshot с document.title
//      + apple-touch-icon (или favicon если apple-touch-icon отсутствует).
//   3. artwork должна быть absolute https URL, CORS-разрешённой, JPEG/PNG,
//      и предзагружена в кэш (через `new Image()`) ИНАЧЕ iOS сразу
//      берёт document fallback (~1.5 сек cold-fetch не успевает).
//   4. playbackState='playing' обязательно после успешного play() —
//      иначе iOS считает session "paused" и не показывает scrubber.
//   5. setPositionState нужен для scrubber'а + Notification Center.
//
// API:
//   setupMediaSessionForTrack(meta, handlers, opts)   — основной entry-point
//   setLockScreenPlaybackState(state)                 — после play/pause
//   setLockScreenPosition(duration, position, rate?)  — каждые ~500ms
//   clearLockScreen()                                 — при unmount/end
//
// Legacy API (deprecated, остаются для back-compat):
//   setLockScreenTrack — теперь синхронный синоним setupMediaSessionForTrack

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
  seekbackward?: (offset?: number) => void;
  seekforward?: (offset?: number) => void;
  stop?: () => void;
}

export interface SetupOpts {
  /** Cache-bust suffix (например coverGenId или createdAt). Уникализирует URL
   *  при смене обложки, чтобы iOS перезагрузил artwork. */
  coverBust?: string | number;
  /** Запустить prewarm 512px cover ПАРАЛЛЕЛЬНО (не блокирует sync set). */
  prewarm?: boolean;
}

const ORIGIN =
  typeof window !== "undefined" && window.location
    ? `${window.location.protocol}//${window.location.host}`
    : "";

/**
 * Build a MediaImage[] with multiple sizes pointing at /api/cover/<id>.jpg?size=N.
 * Apple/WebKit предпочитают >= 256px; даём 96, 192, 256, 384, 512 для
 * лучшего matching на разных устройствах (iPhone, iPad, Apple Watch).
 */
function buildArtwork(trackId: number | string, bust?: string | number): MediaImage[] {
  const sizes = [96, 192, 256, 384, 512];
  const qs = bust ? `&v=${encodeURIComponent(String(bust))}` : "";
  return sizes.map(s => ({
    src: `${ORIGIN}/api/cover/${trackId}.jpg?size=${s}${qs}`,
    sizes: `${s}x${s}`,
    type: "image/jpeg",
  }));
}

/**
 * Prewarm the 512px + 256px cover via `new Image()` so the HTTP cache is
 * warm by the time iOS fetches the artwork URL. НЕ блокирует sync apply.
 *
 * Apple/WebKit: artwork URL fetch имеет короткий timeout (~1.5 сек) перед
 * fallback на document.title + apple-touch-icon. Prewarm критически важен
 * для холодного play — первый touch не имеет HTTP-cache для cover.
 */
function prewarmCover(trackId: number | string, bust?: string | number): void {
  if (typeof window === "undefined") return;
  try {
    const qs = bust ? `&v=${encodeURIComponent(String(bust))}` : "";
    // 512 — самый «крупный», iOS обычно берёт его для lock-screen full-width.
    const img512 = new Image();
    img512.decoding = "async";
    img512.src = `${ORIGIN}/api/cover/${trackId}.jpg?size=512${qs}`;
    // 256 — для Notification Center / Apple Watch.
    const img256 = new Image();
    img256.decoding = "async";
    img256.src = `${ORIGIN}/api/cover/${trackId}.jpg?size=256${qs}`;
  } catch {
    // no-op
  }
}

/**
 * MAIN ENTRY-POINT — set up full MediaSession for a track.
 *
 * MUST be called SYNCHRONOUSLY inside the user-gesture stack BEFORE
 * `audio.play()`. NO `await` or `.then()` before this function returns.
 *
 * Pattern (correct):
 *   onClick={() => {
 *     const audio = document.createElement('audio'); // или ref
 *     audio.src = url;
 *     document.body.appendChild(audio);  // iOS требует элемент в DOM
 *     setupMediaSessionForTrack(meta, handlers, { coverBust: gen.id, prewarm: true });
 *     audio.play().then(() => setLockScreenPlaybackState('playing'));
 *   }}
 */
export function setupMediaSessionForTrack(
  meta: TrackMeta,
  handlers: LockScreenHandlers,
  opts: SetupOpts = {}
): void {
  if (typeof navigator === "undefined" || !("mediaSession" in navigator)) return;

  // 1. PREWARM artwork ПАРАЛЛЕЛЬНО (fire-and-forget, не блокируем sync apply).
  if (opts.prewarm !== false) {
    prewarmCover(meta.id, opts.coverBust);
  }

  // 2. SYNC apply MediaMetadata — iOS читает это в момент play() resolve.
  //    Никаких await/Promise перед этой строкой!
  const artwork = buildArtwork(meta.id, opts.coverBust);
  try {
    navigator.mediaSession.metadata = new MediaMetadata({
      title: meta.title || "MuzaAi",
      artist: meta.artist || "MuzaAi",
      album: meta.album || "MuzaAi",
      artwork,
    });
  } catch (e) {
    // Старые Safari могут throw'ить если MediaImage не поддерживается.
    try {
      navigator.mediaSession.metadata = new MediaMetadata({
        title: meta.title || "MuzaAi",
        artist: meta.artist || "MuzaAi",
        album: meta.album || "MuzaAi",
      });
    } catch {}
    try { console.warn("[MediaSession] metadata apply error:", e); } catch {}
  }

  // 3. ACTION HANDLERS — set after metadata so iOS видит их при первом snapshot.
  const bind = (
    name: MediaSessionAction,
    fn?: (() => void) | ((details: MediaSessionActionDetails) => void)
  ) => {
    try {
      navigator.mediaSession.setActionHandler(
        name,
        fn
          ? (details: MediaSessionActionDetails) => {
              try {
                (fn as (d: MediaSessionActionDetails) => void)(details);
              } catch (err) {
                try { console.warn(`[MediaSession] handler ${name} threw:`, err); } catch {}
              }
            }
          : null
      );
    } catch {
      // Action not supported on this UA — ignore.
    }
  };
  bind("play", handlers.play);
  bind("pause", handlers.pause);
  bind("previoustrack", handlers.previoustrack);
  bind("nexttrack", handlers.nexttrack);
  if (handlers.stop) bind("stop", handlers.stop);

  if (handlers.seekto) {
    try {
      navigator.mediaSession.setActionHandler("seekto", (details: any) => {
        if (details && details.seekTime !== undefined && handlers.seekto) {
          handlers.seekto(details.seekTime);
        }
      });
    } catch {}
  }
  if (handlers.seekbackward) {
    try {
      navigator.mediaSession.setActionHandler("seekbackward", (details: any) => {
        handlers.seekbackward!(details?.seekOffset);
      });
    } catch {}
  }
  if (handlers.seekforward) {
    try {
      navigator.mediaSession.setActionHandler("seekforward", (details: any) => {
        handlers.seekforward!(details?.seekOffset);
      });
    } catch {}
  }
}

/**
 * Legacy wrapper — старый async API. Теперь синхронно вызывает
 * setupMediaSessionForTrack. Сохранён для back-compat вызовов.
 *
 * @deprecated Используй `setupMediaSessionForTrack` напрямую.
 */
export async function setLockScreenTrack(
  meta: TrackMeta,
  handlers: LockScreenHandlers,
  coverBust?: string | number
): Promise<void> {
  setupMediaSessionForTrack(meta, handlers, { coverBust, prewarm: true });
}

/** Update the playback state — обязательно после успешного play()/pause().
 *  iOS использует это для show/hide scrubber и play/pause кнопок в LS. */
export function setLockScreenPlaybackState(state: "playing" | "paused" | "none"): void {
  if (typeof navigator === "undefined" || !("mediaSession" in navigator)) return;
  try { navigator.mediaSession.playbackState = state; } catch {}
}

/**
 * Update the position indicator so the lock-screen scrubber works.
 * Call on timeupdate, throttled to ~every 500ms.
 *
 * iOS treats setPositionState как «truth» для scrubber: если не вызывать —
 * scrubber застывает в начале. Apple/W3C: duration > 0, position in
 * [0..duration], playbackRate > 0.
 */
export function setLockScreenPosition(duration: number, position: number, playbackRate = 1): void {
  if (typeof navigator === "undefined" || !("mediaSession" in navigator)) return;
  if (typeof (navigator.mediaSession as any).setPositionState !== "function") return;
  if (!isFinite(duration) || duration <= 0) return;
  if (!isFinite(position)) return;
  try {
    (navigator.mediaSession as any).setPositionState({
      duration,
      position: Math.min(Math.max(0, position), duration),
      playbackRate: playbackRate > 0 ? playbackRate : 1,
    });
  } catch {}
}

/** Clear all MediaSession state — при unmount страницы или ended последнего трека.
 *  ВАЖНО: НЕ вызывать на pause() — iOS требует чтобы metadata оставалась
 *  для возобновления. */
export function clearLockScreen(): void {
  if (typeof navigator === "undefined" || !("mediaSession" in navigator)) return;
  try {
    navigator.mediaSession.metadata = null;
    navigator.mediaSession.playbackState = "none";
  } catch {}
  // Снять action handlers — иначе iOS думает что мы ещё "media-active app".
  const actions: MediaSessionAction[] = [
    "play", "pause", "previoustrack", "nexttrack",
    "seekto", "seekbackward", "seekforward", "stop"
  ];
  for (const a of actions) {
    try { navigator.mediaSession.setActionHandler(a, null); } catch {}
  }
}
