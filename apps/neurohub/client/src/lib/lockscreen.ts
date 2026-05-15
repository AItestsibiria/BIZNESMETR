// iOS/Android lock-screen metadata helper using the Media Session API.
// Delivers a reliable cover image on iOS Safari by:
//   - Using absolute https:// URLs (NOT data: URLs — iOS truncates/fails them on lock screen)
//   - Providing multiple sizes (iOS chooses 96/128/256/512 dynamically)
//   - Pre-warming the image via new Image() so the browser has it cached
//   - Setting metadata BEFORE audio.play() (order matters on iOS)
//   - Re-setting metadata after a short delay (workaround for known iOS bug
//     where first metadata update on a fresh MediaSession is silently dropped)

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
 * Apply track metadata + action handlers to the Media Session.
 * Call this BEFORE audio.play(). It will pre-warm the cover image first.
 */
export async function setLockScreenTrack(
  meta: TrackMeta,
  handlers: LockScreenHandlers,
  coverBust?: string | number
): Promise<void> {
  if (typeof navigator === "undefined" || !("mediaSession" in navigator)) return;

  // 1. Pre-warm image
  await prewarmCover(meta.id, coverBust);

  // 2. Build artwork array with multiple absolute https URLs
  const artwork = buildArtwork(meta.id, coverBust);

  // 3. Set metadata
  const apply = () => {
    try {
      navigator.mediaSession.metadata = new MediaMetadata({
        title: meta.title || "MuzaAi",
        artist: meta.artist || "MuzaAi",
        album: meta.album || "MuzaAi",
        artwork,
      });
    } catch {
      // Older Safari versions may throw if artwork URLs aren't reachable
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

  // 5. Register action handlers
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

export function clearLockScreen(): void {
  if (typeof navigator === "undefined" || !("mediaSession" in navigator)) return;
  try {
    navigator.mediaSession.metadata = null;
    navigator.mediaSession.playbackState = "none";
  } catch {}
}
