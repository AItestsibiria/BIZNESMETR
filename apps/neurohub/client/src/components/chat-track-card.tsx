// Eugene 2026-05-20 Босс «мини-плеер в чате — Муза находит трек и сразу
// проигрывает». Inline-карточка под bot-сообщением: обложка + название +
// автор + Play/Pause + прогресс-бар + «Открыть» (deep-link на /track/:id).
//
// Дизайн: Brand-style consistency rule — glass-card + gradient border purple→
// fuchsia→blue, font-display для title, font-mono для длительности.
//
// Audio: использует ТОЛЬКО persistent <audio> singleton через
// getPersistentPlayerAudio() + loadTrackIntoPlayer() (Persistent-audio-only
// rule, см. CLAUDE.md). Никаких new Audio() — это нарушит lock-screen
// ownership на iOS.
//
// autoPlay=true только для последнего bot-сообщения (свежий ответ от
// Музы). Для history-сообщений autoPlay=false — юзер сам жмёт Play.

import { useCallback, useEffect, useState } from "react";
import { getPersistentPlayerAudio, loadTrackIntoPlayer, setupMediaSessionForTrack, setLockScreenPlaybackState } from "@/lib/lockscreen";

export type ChatTrackCardData = {
  id: number;
  title: string;
  authorName?: string | null;
  audioUrl: string;
  coverUrl?: string;
  durationSec?: number;
};

export type ChatTrackCardProps = {
  track: ChatTrackCardData;
  /** Авто-запустить трек после mount (только для свежего ответа Музы). */
  autoPlay?: boolean;
};

function formatTime(sec: number): string {
  if (!Number.isFinite(sec) || sec <= 0) return "0:00";
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${s.toString().padStart(2, "0")}`;
}

// Нормализуем audio.src для сравнения «играет ли этот трек».
// audio.src — это absolute URL ("https://muzaai.ru/api/stream/123"),
// а track.audioUrl — может быть relative ("/api/stream/123") или absolute.
function isSameTrackPlaying(audioSrc: string | null | undefined, trackUrl: string): boolean {
  if (!audioSrc) return false;
  if (audioSrc === trackUrl) return true;
  // Сравниваем по pathname (без query/fragment)
  try {
    const a = new URL(audioSrc, typeof window !== "undefined" ? window.location.href : "https://example.com");
    const b = new URL(trackUrl, typeof window !== "undefined" ? window.location.href : "https://example.com");
    return a.pathname === b.pathname;
  } catch {
    return audioSrc.includes(trackUrl) || trackUrl.includes(audioSrc);
  }
}

export function ChatTrackCard({ track, autoPlay }: ChatTrackCardProps) {
  const [audio, setAudio] = useState<HTMLAudioElement | null>(null);
  const [isThis, setIsThis] = useState(false);
  const [isPlaying, setIsPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(track.durationSec || 0);
  const [coverError, setCoverError] = useState(false);
  const [unavailable, setUnavailable] = useState(false);

  // === Mount: attach к persistent singleton, опц. auto-play ===
  useEffect(() => {
    const a = getPersistentPlayerAudio();
    if (!a) return;
    setAudio(a);
    // Если этот трек уже играет (например юзер открыл свежий ответ и
    // backend успел persisted) — НЕ перезапускаем, просто синхронизируем UI.
    const sameTrack = isSameTrackPlaying(a.src, track.audioUrl);
    if (sameTrack) {
      setIsThis(true);
      setIsPlaying(!a.paused);
      setCurrentTime(a.currentTime || 0);
      if (a.duration > 0) setDuration(a.duration);
      return;
    }
    // autoPlay: только для свежего bot-message (последнее в истории).
    if (autoPlay) {
      try {
        loadTrackIntoPlayer(track.audioUrl);
        // Sync mediasession metadata (lock-screen ownership)
        setupMediaSessionForTrack(
          { id: track.id, title: track.title, artist: track.authorName || "MuzaAi", album: "MuzaAi" },
          {
            play: () => { a.play().catch(() => {}); },
            pause: () => { a.pause(); },
          },
          { coverBust: track.id, prewarm: true },
        );
        // Удерживаем gradient-info на странице
        try {
          (window as any).__muziaiTrack = {
            id: track.id,
            title: track.title,
            authorName: track.authorName,
            imageUrl: track.coverUrl,
          };
        } catch {}
        a.play().then(() => {
          setLockScreenPlaybackState("playing");
          // Eugene 2026-05-20: count play через тот же endpoint что и landing
          try {
            fetch(`/api/playlist/play/${track.id}`, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ elapsedSec: 0 }),
              credentials: "include",
            }).catch(() => {});
          } catch {}
        }).catch((err) => {
          // iOS Safari блокирует autoplay без user gesture — это нормально
          // для первого сообщения, юзер нажмёт Play вручную.
          console.warn("[ChatTrackCard] autoplay blocked:", err?.message || err);
        });
        setIsThis(true);
      } catch (e: any) {
        console.warn("[ChatTrackCard] autoPlay setup failed:", e?.message || e);
      }
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [track.id, track.audioUrl]);

  // === Subscribe к audio events. Обновляем UI если этот трек активен. ===
  useEffect(() => {
    if (!audio) return;
    const refresh = () => {
      const same = isSameTrackPlaying(audio.src, track.audioUrl);
      setIsThis(same);
      if (same) {
        setIsPlaying(!audio.paused);
        setCurrentTime(audio.currentTime || 0);
        if (audio.duration > 0) setDuration(audio.duration);
      } else {
        setIsPlaying(false);
      }
    };
    refresh();
    const onPlay = () => refresh();
    const onPause = () => refresh();
    const onTime = () => {
      if (isSameTrackPlaying(audio.src, track.audioUrl)) {
        setCurrentTime(audio.currentTime || 0);
      }
    };
    const onMeta = () => {
      if (isSameTrackPlaying(audio.src, track.audioUrl) && audio.duration > 0) {
        setDuration(audio.duration);
      }
    };
    const onError = () => {
      if (isSameTrackPlaying(audio.src, track.audioUrl)) {
        setUnavailable(true);
        setIsPlaying(false);
      }
    };
    audio.addEventListener("play", onPlay);
    audio.addEventListener("pause", onPause);
    audio.addEventListener("timeupdate", onTime);
    audio.addEventListener("loadedmetadata", onMeta);
    audio.addEventListener("durationchange", onMeta);
    audio.addEventListener("error", onError);
    // Poll для случая «audio.src сменилось снаружи» (другая страница
    // переключила трек) — обычные события «emptied»/«loadstart» можно
    // ловить, но дешевле подёргать src раз в секунду.
    const iv = window.setInterval(refresh, 1500);
    return () => {
      audio.removeEventListener("play", onPlay);
      audio.removeEventListener("pause", onPause);
      audio.removeEventListener("timeupdate", onTime);
      audio.removeEventListener("loadedmetadata", onMeta);
      audio.removeEventListener("durationchange", onMeta);
      audio.removeEventListener("error", onError);
      window.clearInterval(iv);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [audio, track.audioUrl]);

  const onPlayClick = useCallback(() => {
    if (!audio) return;
    try {
      const same = isSameTrackPlaying(audio.src, track.audioUrl);
      if (same) {
        if (audio.paused) {
          audio.play().then(() => setLockScreenPlaybackState("playing")).catch(() => {});
        } else {
          audio.pause();
          setLockScreenPlaybackState("paused");
        }
        return;
      }
      // Switch на этот трек
      loadTrackIntoPlayer(track.audioUrl);
      setupMediaSessionForTrack(
        { id: track.id, title: track.title, artist: track.authorName || "MuzaAi", album: "MuzaAi" },
        {
          play: () => { audio.play().catch(() => {}); },
          pause: () => { audio.pause(); },
        },
        { coverBust: track.id, prewarm: true },
      );
      try {
        (window as any).__muziaiTrack = {
          id: track.id,
          title: track.title,
          authorName: track.authorName,
          imageUrl: track.coverUrl,
        };
      } catch {}
      audio.play().then(() => {
        setLockScreenPlaybackState("playing");
        setIsThis(true);
        try {
          fetch(`/api/playlist/play/${track.id}`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ elapsedSec: 0 }),
            credentials: "include",
          }).catch(() => {});
        } catch {}
      }).catch((err) => {
        console.warn("[ChatTrackCard] play() failed:", err?.message || err);
        if (String(err?.message || "").toLowerCase().includes("not allowed")) {
          // user gesture blocked — пробуем еще раз без mediasession
          audio.play().catch(() => {});
        } else {
          setUnavailable(true);
        }
      });
    } catch (e: any) {
      console.warn("[ChatTrackCard] onPlayClick error:", e?.message || e);
    }
  }, [audio, track]);

  const onSeek = useCallback((e: React.MouseEvent<HTMLDivElement>) => {
    if (!audio || !isThis || duration <= 0) return;
    try {
      const rect = (e.currentTarget as HTMLDivElement).getBoundingClientRect();
      const ratio = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
      audio.currentTime = ratio * duration;
      setCurrentTime(audio.currentTime);
    } catch {}
  }, [audio, isThis, duration]);

  const openTrack = useCallback(() => {
    try {
      window.location.hash = `#/track/${track.id}`;
    } catch {}
  }, [track.id]);

  const progress = isThis && duration > 0 ? (currentTime / duration) * 100 : 0;
  const showDuration = isThis ? duration : (track.durationSec || 0);
  const firstLetter = (track.title || "?").trim().charAt(0).toUpperCase();

  if (unavailable) {
    return (
      <div className="w-full max-w-[90%] mt-2 p-3 rounded-2xl glass-card border border-amber-400/30 bg-gradient-to-br from-amber-500/10 to-purple-500/8">
        <div className="flex items-center gap-2 text-[12px] text-amber-200/90">
          <span>⚠️</span>
          <span>Трек «{track.title}» сейчас недоступен. Попробуй другой.</span>
        </div>
      </div>
    );
  }

  return (
    <div
      className="w-full max-w-[90%] mt-2 p-3 rounded-2xl glass-card border border-purple-400/30 bg-gradient-to-br from-purple-500/15 via-fuchsia-500/8 to-blue-500/15 shadow-lg shadow-purple-500/10"
      role="region"
      aria-label={`Трек ${track.title}`}
    >
      <div className="flex items-start gap-3">
        {/* Cover */}
        <div className="shrink-0 relative">
          {!coverError && track.coverUrl ? (
            <img
              src={track.coverUrl}
              alt=""
              className="w-16 h-16 rounded-xl object-cover border border-purple-400/30 shadow-md shadow-purple-500/20"
              onError={() => setCoverError(true)}
            />
          ) : (
            <div className="w-16 h-16 rounded-xl bg-gradient-to-br from-purple-500/40 via-fuchsia-500/30 to-blue-500/40 flex items-center justify-center text-white font-display font-bold text-2xl border border-purple-400/30 shadow-md shadow-purple-500/20">
              {firstLetter}
            </div>
          )}
        </div>

        {/* Title + author + progress */}
        <div className="flex-1 min-w-0">
          <div className="text-[13px] font-display font-bold text-white truncate" title={track.title}>
            {track.title}
          </div>
          {track.authorName && (
            <div className="text-[11px] text-purple-200/80 truncate mt-0.5" title={track.authorName}>
              {track.authorName}
            </div>
          )}
          {/* Progress bar — кликабельная (seek) только если активен */}
          <div
            className={`h-1.5 bg-white/10 rounded-full mt-2 ${isThis && duration > 0 ? "cursor-pointer hover:bg-white/15" : ""} transition-colors`}
            onClick={onSeek}
            role="progressbar"
            aria-valuemin={0}
            aria-valuemax={Math.max(1, showDuration)}
            aria-valuenow={currentTime}
            aria-label="Прогресс воспроизведения"
          >
            <div
              className="h-full bg-gradient-to-r from-purple-400 via-fuchsia-400 to-blue-400 rounded-full transition-all shadow-[0_0_8px_rgba(168,85,247,0.5)]"
              style={{ width: `${Math.max(0, Math.min(100, progress))}%` }}
            />
          </div>
          {/* Time */}
          <div className="flex items-center justify-between mt-1">
            <span className="text-[10px] font-mono text-white/55">
              {formatTime(currentTime)} / {formatTime(showDuration)}
            </span>
            <button
              type="button"
              onClick={openTrack}
              className="text-[10px] text-cyan-300 hover:text-cyan-200 underline-offset-2 hover:underline transition-colors"
              title="Открыть трек на отдельной странице"
            >
              Открыть →
            </button>
          </div>
        </div>

        {/* Play/Pause button */}
        <button
          type="button"
          onClick={onPlayClick}
          className="shrink-0 w-12 h-12 rounded-full bg-gradient-to-br from-purple-500 via-fuchsia-500 to-blue-500 hover:from-purple-400 hover:via-fuchsia-400 hover:to-blue-400 border border-purple-300/40 text-white text-xl flex items-center justify-center shadow-[0_0_20px_rgba(168,85,247,0.4)] hover:shadow-[0_0_28px_rgba(168,85,247,0.6)] transition-all active:scale-95"
          aria-label={isThis && isPlaying ? "Пауза" : "Воспроизведение"}
          title={isThis && isPlaying ? "Пауза" : "Воспроизвести"}
        >
          {isThis && isPlaying ? "⏸" : "▶"}
        </button>
      </div>
    </div>
  );
}
