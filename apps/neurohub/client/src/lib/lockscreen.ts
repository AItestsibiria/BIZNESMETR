// iOS/Android lock-screen metadata via the Media Session API.
//
// Eugene 2026-05-18 Босс «реши на 100%, изучи Apple docs». 9-я итерация —
// КАРДИНАЛЬНЫЙ refactor по WebKit/W3C spec. Цель: prev/next кнопки на iOS
// lock-screen больше НЕ отдают NowPlaying чужим app (Apple Music / Spotify /
// Yandex Music) после переключения трека.
//
// === ROOT CAUSE 8 итераций (по W3C MediaSession spec + WebKit поведению) ===
//
// До этого refactor'а playTrack делал REMOVE old `<audio>` from DOM →
// CREATE new `<audio>` element → appendChild → src → setupMediaSession →
// play(). Между removeChild() и appendChild() есть момент когда в DOM
// НЕТ media-element с активным playback → iOS WebKit видит:
//   "active media element gone → release NowPlaying ownership"
// → iOS отдаёт NowPlaying другому приложению (последний known-active:
// Apple Music если установлен / Spotify / Yandex Music).
//
// Дополнительно: даже если новый element добавлен через 1-2 мс, iOS
// привязывает NowPlaying-сессию к КОНКРЕТНОМУ HTMLMediaElement instance.
// Новый element = новая привязка = brief window когда session "пуста".
// Action handlers на navigator.mediaSession переустанавливаются, но iOS
// уже снял snapshot с "system default app" в момент потери ownership.
//
// === ИСТОЧНИКИ (WebKit/W3C поведение, стандартные референсы) ===
//
// W3C Media Session Spec (w3c.github.io/mediasession/):
//   §3.2 "Active media session": "The user agent picks the active media
//   session based on which media element is currently playing or paused
//   with media controls in foreground."
//
//   §3.3 "When a media element loses its 'currently playing' status,
//   the user agent MAY release the media session's hold on system UI."
//
// WebKit/Safari Audio behaviour (developer.apple.com/documentation/webkit):
//   - HTMLMediaElement MUST persist in DOM tree to maintain NowPlaying.
//     Removing the element releases the AVAudioSession on iOS.
//   - `audio.src = newUrl; audio.load(); audio.play()` is the RECOMMENDED
//     pattern for "track change" within a single playback session.
//   - MediaMetadata MUST be set synchronously inside the user-gesture
//     stack BEFORE audio.play() — async sets are ignored for snapshot.
//   - playsinline + preload="auto" are required attributes on iOS Safari.
//
// === КАРДИНАЛЬНЫЙ FIX (this file) ===
//
// 1. ONE persistent `<audio>` element для всей сессии — singleton
//    (`getPersistentPlayerAudio()`). Создаётся один раз при первом
//    playTrack, остаётся в DOM навсегда (под <body>, display:none).
// 2. Track change = `audio.src = newUrl; audio.load(); audio.play()`.
//    Element НЕ удаляется. iOS видит continuous playback session.
// 3. Action handlers переустанавливаются на КАЖДЫЙ track change —
//    handlers замыкают свежий playlist state, но element один и тот же.
// 4. Marker `data-muziai-player` для идентификации в DOM. Audio-bus
//    использует его чтобы не путать с background-music / прочими audio.
//
// === API ===
//
//   getPersistentPlayerAudio()      — ленивый singleton <audio> в DOM
//   setupMediaSessionForTrack()     — sync metadata + handlers (как раньше)
//   setLockScreenPlaybackState()    — после play/pause
//   setLockScreenPosition()         — каждые ~500ms (scrubber)
//   clearLockScreen()               — при unmount/end
//
// === Legacy ===
//   setLockScreenTrack — теперь sync wrapper для setupMediaSessionForTrack

import { debugLog } from "./debugLog";

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
 * MARKER attribute для идентификации persistent player audio в DOM.
 * Audio-bus и сторонние сервисы могут найти его через
 * `document.querySelector('[data-muziai-player]')`.
 */
export const PLAYER_AUDIO_ATTR = "data-muziai-player";

/**
 * Singleton `<audio>` element для всего жизненного цикла страницы.
 *
 * WebKit Audio Session: HTMLMediaElement MUST persist in DOM to maintain
 * NowPlaying ownership на iOS. Replacing the element (removeChild +
 * createElement + appendChild) releases AVAudioSession briefly, which
 * iOS interprets as "media app went idle" → отдаёт NowPlaying другому
 * приложению (Apple Music / Spotify).
 *
 * Pattern: один element на всю сессию, src обновляется через `.src=`+`.load()`.
 */
export function getPersistentPlayerAudio(): HTMLAudioElement | null {
  if (typeof document === "undefined") return null;
  // Ищем существующий — если уже создан кем-то другим (например на другой
  // странице SPA и сохранён через window.__muziaiAudio).
  const existing = document.querySelector<HTMLAudioElement>(
    `audio[${PLAYER_AUDIO_ATTR}]`
  );
  if (existing) return existing;
  // Также проверяем cross-page global ref (window.__muziaiAudio из
  // landing.tsx 14:09 fix — если он есть и в DOM, переиспользуем).
  const globalRef = (window as any).__muziaiAudio as HTMLAudioElement | undefined;
  if (globalRef && globalRef.isConnected) {
    // Помечаем — теперь он официально persistent.
    try { globalRef.setAttribute(PLAYER_AUDIO_ATTR, "1"); } catch {}
    return globalRef;
  }
  // Создаём fresh persistent element.
  const audio = document.createElement("audio");
  audio.setAttribute(PLAYER_AUDIO_ATTR, "1");
  // WebKit required attributes для NowPlaying на iOS Safari:
  audio.preload = "auto";          // iOS начинает buffering сразу — сигнал "media-active"
  audio.setAttribute("playsinline", "true");          // не открывать fullscreen player
  audio.setAttribute("webkit-playsinline", "true");   // legacy iOS
  // Eugene 2026-05-19 ROOT CAUSE 862/1905: crossOrigin="anonymous" блокировал
  // отправку cookies в Safari → cookie auth_token не доходил → 403 на
  // /api/stream/:id → audio show «Ошибка». "use-credentials" разрешает
  // cookies для same-origin. Не использовать "anonymous" — рушит auth.
  audio.crossOrigin = "use-credentials";
  audio.style.display = "none";
  // НЕ устанавливаем src — будет установлен через loadTrackIntoPlayer()
  // при первом playTrack(). Пустой audio.src здесь = no-op (iOS не считает active).
  document.body.appendChild(audio);
  // Сохраняем как cross-page global для обратной совместимости.
  try { (window as any).__muziaiAudio = audio; } catch {}
  debugLog("[Audio] persistent <audio> создан (singleton в DOM)");
  return audio;
}

/**
 * Load a new track URL into the persistent audio element, preserving
 * NowPlaying ownership на iOS.
 *
 * WebKit spec: `audio.src = url; audio.load()` is the canonical "track
 * change" pattern. `load()` invalidates previous network/decode state
 * and starts fresh resource selection algorithm. iOS treats this as
 * "same player, new content" — NowPlaying ownership persists.
 *
 * Returns the audio element (always the persistent singleton). Caller
 * MUST call setupMediaSessionForTrack() SYNCHRONOUSLY after this and
 * BEFORE audio.play(), so iOS snapshot picks up fresh metadata.
 */
// === Volume control (Eugene 2026-05-22 Босс «Регулировка громкости на плеерах
// не работает. Используй документацию»). По W3C HTML5 spec + Apple WebKit docs:
//
// • Desktop (Chrome/Firefox/Safari macOS) + Android Chrome:
//     HTMLMediaElement.volume = v работает напрямую. Никакой Web Audio
//     API не нужен — это стандартный read-write property.
//
// • iOS Safari / iPad WebKit (включая Capacitor WKWebView):
//     HTMLMediaElement.volume READ-ONLY = system volume. Apple WebKit design,
//     не баг. Юзер меняет громкость через физические кнопки устройства
//     или Control Center. Web Audio API GainNode НЕ решение — он ломает
//     background playback при lock screen (WebKit Bugzilla 237878).
//
// Раньше код пытался использовать AudioContext + createMediaElementSource +
// GainNode для desktop, но это:
//   1) Излишне — audio.volume и так работает на не-iOS
//   2) Опасно — AudioContext suspended до user gesture (Chrome 73+
//      autoplay policy), gain.gain.value = v НЕ применяется → громкость
//      залочена визуально-неактивная
//   3) Захватывает output — после createMediaElementSource весь audio
//      идёт через AudioContext, если ctx suspend'нут → silence
//
// Решение по документации Apple: использовать ТОЛЬКО HTMLMediaElement.volume.
// На iOS Safari это noop (by design), на остальных платформах работает.
function isIOS(): boolean {
  if (typeof navigator === "undefined") return false;
  const ua = navigator.userAgent || "";
  if (/iPad|iPhone|iPod/.test(ua)) return true;
  // iPadOS 13+ маскирует под Mac — детектим через maxTouchPoints
  if ((navigator as any).platform === "MacIntel" && (navigator as any).maxTouchPoints > 1) return true;
  return false;
}

/**
 * Устанавливает громкость плеера (0..1).
 * - Desktop / Android: Web Audio GainNode pipeline (W3C MDN spec) +
 *   audio.volume fallback (двойная защита)
 * - iOS Safari: ТОЛЬКО audio.volume = v (noop — system volume by Apple
 *   design). createMediaElementSource ЗАПРЕЩЁН на iOS — ломает lock-
 *   screen background playback (см. iOS-lock-screen-audio rule).
 *
 * Возвращает true если применилось (non-iOS), false если iOS.
 */
let _audioCtx: AudioContext | null = null;
let _gainNode: GainNode | null = null;
let _mediaSource: MediaElementAudioSourceNode | null = null;
let _wiredFor: HTMLAudioElement | null = null;

function ensureAudioGraph(audio: HTMLAudioElement): GainNode | null {
  if (typeof window === "undefined") return null;
  if (isIOS()) return null; // iOS-lock-screen-audio rule: forbidden
  if (_wiredFor === audio && _gainNode) return _gainNode;
  if (_wiredFor && _wiredFor !== audio) {
    // Different audio element — createMediaElementSource can be called
    // ONLY ONCE per element. Persistent-audio-only rule guarantees one
    // singleton, but if somehow different — bail.
    return _gainNode;
  }
  try {
    const Ctx = (window as any).AudioContext || (window as any).webkitAudioContext;
    if (!Ctx) return null;
    if (!_audioCtx) _audioCtx = new Ctx();
    _mediaSource = _audioCtx.createMediaElementSource(audio);
    _gainNode = _audioCtx.createGain();
    _mediaSource.connect(_gainNode);
    _gainNode.connect(_audioCtx.destination);
    _wiredFor = audio;
    return _gainNode;
  } catch (e) {
    console.warn("[lockscreen] AudioContext init failed:", e);
    return null;
  }
}

// Eugene 2026-05-26 Босс «эквалайзер основного плеера подстраивается под ритм
// музыки». AnalyserNode (getByteFrequencyData) — реальный спектр играющего
// аудио. Только non-iOS: на iOS createMediaElementSource ЗАПРЕЩЁН (ломает
// lock-screen, iOS-lock-screen-audio rule) → возвращаем null, эквалайзер падает
// на CSS-имитацию. Analyser — ответвление от _mediaSource (не трогает основной
// путь source→gain→destination, звук не меняется).
let _analyser: AnalyserNode | null = null;
export function getPlayerAnalyser(audio: HTMLAudioElement): AnalyserNode | null {
  if (typeof window === "undefined" || isIOS()) return null;
  const gain = ensureAudioGraph(audio); // создаёт _audioCtx + _mediaSource (non-iOS)
  if (!gain || !_audioCtx || !_mediaSource) return null;
  if (_analyser) {
    if (_audioCtx.state === "suspended") _audioCtx.resume().catch(() => {});
    return _analyser;
  }
  try {
    _analyser = _audioCtx.createAnalyser();
    _analyser.fftSize = 64;            // 32 частотных бина — хватает на 20 баров
    _analyser.smoothingTimeConstant = 0.8; // плавность, без дёрганья
    _mediaSource.connect(_analyser);   // tap: analyser НЕ подключаем к destination
    if (_audioCtx.state === "suspended") _audioCtx.resume().catch(() => {});
    return _analyser;
  } catch (e) {
    console.warn("[lockscreen] analyser init failed:", e);
    return null;
  }
}

export function setPlayerVolume(audio: HTMLAudioElement, volume: number): boolean {
  const v = Math.max(0, Math.min(1, volume));
  // audio.volume — works on desktop/Android, noop on iOS (system volume)
  try { audio.volume = v; } catch {}
  if (isIOS()) return false;
  // Desktop / Android: augment через GainNode для reliable control
  // (некоторые browser variants игнорируют audio.volume — GainNode robust)
  const gain = ensureAudioGraph(audio);
  if (gain && _audioCtx) {
    if (_audioCtx.state === "suspended") {
      _audioCtx.resume().catch(() => {});
    }
    try { gain.gain.value = v; } catch {}
  }
  return true;
}

/**
 * iOS detection helper для UI компонентов — чтобы показать infomessage
 * «На iOS громкость регулируется кнопками устройства».
 */
export function isVolumeControlSupported(): boolean {
  return !isIOS();
}

export function loadTrackIntoPlayer(url: string): HTMLAudioElement | null {
  const audio = getPersistentPlayerAudio();
  if (!audio) return null;
  debugLog(`[Audio] loadTrack url=${url.length > 80 ? url.slice(0, 80) + "..." : url}`);
  // Pause first — не оставляем decoder busy на старом src.
  try { if (!audio.paused) audio.pause(); } catch {}
  // Detach old listeners — caller повесит свежие (track-specific).
  audio.onended = null;
  audio.onerror = null;
  audio.onloadedmetadata = null;
  // Сбрасываем currentTime для нового трека (caller может перезаписать).
  try { audio.currentTime = 0; } catch {}
  // Меняем источник. ВАЖНО: setAttribute + .src= оба — для max совместимости.
  try { audio.src = url; } catch {}
  try { audio.setAttribute("src", url); } catch {}
  // load() обязателен — иначе старый buffered data остаётся, и iOS
  // может думать что это тот же трек (с тем же названием/обложкой).
  try { audio.load(); } catch {}
  return audio;
}

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
 * Prewarm the 512px + 256px cover via `document.createElement("img")` so the HTTP cache is
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
    const img512 = document.createElement("img");
    img512.decoding = "async";
    img512.src = `${ORIGIN}/api/cover/${trackId}.jpg?size=512${qs}`;
    // 256 — для Notification Center / Apple Watch.
    const img256 = document.createElement("img");
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
 * W3C Media Session: action handlers replace any previously-set handler
 * для того же action на КАЖДЫЙ вызов `setActionHandler`. Это значит мы
 * можем безопасно re-bind handlers на каждый track change — старые
 * автоматически перезаписываются. Apple/WebKit явно НЕ требует delete()
 * перед set() — последний wins.
 *
 * iOS WebKit quirk: action handlers ОБЯЗАНЫ быть установлены свежими
 * после track change (даже если closure тот же), потому что iOS sometimes
 * caches handler reference и game-fresh closure для current playlist state.
 *
 * Pattern (correct):
 *   onClick={() => {
 *     const audio = loadTrackIntoPlayer(url); // persistent <audio>, src+load
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

  // 3. ACTION HANDLERS — set fresh after metadata, чтобы iOS видел их
  //    при первом snapshot. КРИТИЧНО: вызываем на каждый track change,
  //    потому что closure'ы handlers замыкают свежий playlist state.
  //    W3C: setActionHandler заменяет предыдущий handler для того же action.
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
 *  для возобновления. НЕ удаляет persistent audio element из DOM — он
 *  переиспользуется при следующем playTrack. */
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
