// PlayerAgent — глобальный контроллер воспроизведения треков MuziAi.
// ТЗ Eugene 2026-05-08 14:18:
// - Per-user параметры (filters/sort/repeat) держатся жёстко
// - Параллельные пользователи (миллион) — каждый со своим state в браузере
// - Фоновое воспроизведение через singleton window-ref
// - Возврат с другой страницы → продолжение с того же места + теми же фильтрами
// - Глобальный observer (одна точка вокруг audio + queue + state)
//
// Используется в App.tsx через <PlayerProvider>. Любая страница через
// usePlayer() hook получает access.
//
// State machine: idle → loading → playing → paused → ended
//                          ↑                    ↓
//                          └──── seek/skip ─────┘

import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import {
  setLockScreenTrack,
  setLockScreenPlaybackState,
  setLockScreenPosition,
  clearLockScreen,
} from "@/lib/lockscreen";

export interface Track {
  id: number;
  audioUrl: string;
  imageUrl?: string | null;
  prompt?: string;
  authorName?: string;
  duration?: number;
  type?: string;
  [k: string]: any;
}

export type RepeatMode = "off" | "all" | "one";
export type PlayerStatus = "idle" | "loading" | "playing" | "paused" | "ended";

interface PlayerState {
  current: Track | null;
  queue: Track[];        // Активная очередь (после фильтров)
  currentTime: number;
  duration: number;
  status: PlayerStatus;
  repeat: RepeatMode;
  volume: number;
}

interface PlayerActions {
  play: (t?: Track) => void;       // Без аргумента — resume
  pause: () => void;
  toggle: () => void;
  seek: (sec: number) => void;
  next: () => void;
  prev: () => void;
  setQueue: (q: Track[]) => void;   // Обновляем queue (с учётом фильтров)
  setRepeat: (m: RepeatMode) => void;
  setVolume: (v: number) => void;
}

interface PlayerContextValue extends PlayerState, PlayerActions {}

const PlayerContext = createContext<PlayerContextValue | null>(null);

const SS_KEY = {
  trackId: "player_trackId",
  currentTime: "player_currentTime",
  repeat: "player_repeat",
  volume: "player_volume",
};

function loadFromSession<T>(key: string, fallback: T, parse: (s: string) => T): T {
  try {
    const v = sessionStorage.getItem(key);
    if (v == null) return fallback;
    return parse(v);
  } catch { return fallback; }
}

export function PlayerProvider({ children }: { children: ReactNode }) {
  // Global singleton — переживает unmount/remount роутов
  const audioRef = useRef<HTMLAudioElement | null>(
    (typeof window !== "undefined" ? (window as any).__muziaiAudio : null) ?? null,
  );
  const queueRef = useRef<Track[]>([]);
  const tickRef = useRef<number | null>(null);

  const [current, setCurrent] = useState<Track | null>(
    (typeof window !== "undefined" ? (window as any).__muziaiTrack : null) ?? null,
  );
  const [queue, setQueueState] = useState<Track[]>([]);
  const [currentTime, setCurrentTime] = useState<number>(
    loadFromSession(SS_KEY.currentTime, 0, Number),
  );
  const [duration, setDuration] = useState<number>(0);
  const [status, setStatus] = useState<PlayerStatus>("idle");
  const [repeat, setRepeatState] = useState<RepeatMode>(
    loadFromSession(SS_KEY.repeat, "all", (s) => (["off", "all", "one"].includes(s) ? (s as RepeatMode) : "all")),
  );
  const [volume, setVolumeState] = useState<number>(
    loadFromSession(SS_KEY.volume, 0.5, (s) => Math.max(0, Math.min(1, Number(s) || 0.5))),
  );

  // Persist при изменениях
  useEffect(() => { try { sessionStorage.setItem(SS_KEY.repeat, repeat); } catch {} }, [repeat]);
  useEffect(() => { try { sessionStorage.setItem(SS_KEY.volume, String(volume)); } catch {} }, [volume]);
  useEffect(() => {
    if (!current) return;
    try { sessionStorage.setItem(SS_KEY.trackId, String(current.id)); } catch {}
  }, [current]);

  // Sync ref для callbacks
  useEffect(() => { queueRef.current = queue; }, [queue]);

  // Adopt существующий audio из window.__muziaiAudio (если был запущен на другой странице)
  useEffect(() => {
    const a = audioRef.current;
    if (!a) return;
    a.volume = volume;
    if (!a.paused) {
      setStatus("playing");
      setDuration(a.duration || 0);
      tickRef.current = window.setInterval(() => {
        const cur = audioRef.current;
        if (cur && !cur.paused) {
          setCurrentTime(cur.currentTime);
          try { sessionStorage.setItem(SS_KEY.currentTime, String(cur.currentTime)); } catch {}
        }
      }, 250);
    }
    return () => {
      if (tickRef.current) { clearInterval(tickRef.current); tickRef.current = null; }
      // НЕ паузим — global audio продолжает играть
    };
  }, []);

  const setQueue = useCallback((q: Track[]) => {
    queueRef.current = q;
    setQueueState(q);
  }, []);

  const setRepeat = useCallback((m: RepeatMode) => setRepeatState(m), []);

  const setVolume = useCallback((v: number) => {
    const c = Math.max(0, Math.min(1, v));
    setVolumeState(c);
    if (audioRef.current) audioRef.current.volume = c;
  }, []);

  const startTicker = useCallback(() => {
    if (tickRef.current) clearInterval(tickRef.current);
    tickRef.current = window.setInterval(() => {
      const a = audioRef.current;
      if (a && !a.paused) {
        setCurrentTime(a.currentTime);
        try { sessionStorage.setItem(SS_KEY.currentTime, String(a.currentTime)); } catch {}
      }
    }, 250);
  }, []);

  const stopTicker = useCallback(() => {
    if (tickRef.current) { clearInterval(tickRef.current); tickRef.current = null; }
  }, []);

  const play = useCallback((t?: Track) => {
    if (!t && audioRef.current) {
      // Resume current
      audioRef.current.play().then(() => {
        setStatus("playing");
        startTicker();
      }).catch(() => setStatus("paused"));
      return;
    }
    if (!t) return;
    // Создаём новый Audio и заменяем global
    if (audioRef.current) {
      audioRef.current.pause();
      audioRef.current.onended = null;
      audioRef.current.onerror = null;
    }
    const audio = new Audio(t.audioUrl);
    audio.volume = volume;
    audioRef.current = audio;
    if (typeof window !== "undefined") {
      (window as any).__muziaiAudio = audio;
      (window as any).__muziaiTrack = t;
    }
    setCurrent(t);
    setStatus("loading");
    setCurrentTime(0);
    setDuration(t.duration || 0);

    audio.onloadedmetadata = () => {
      if (audio.duration && isFinite(audio.duration)) setDuration(audio.duration);
    };
    audio.onended = () => {
      stopTicker();
      setStatus("ended");
      const r = repeat;
      const list = queueRef.current;
      const cur = (window as any).__muziaiTrack as Track | null;
      if (r === "one" && cur) {
        play(cur);
        return;
      }
      if (list.length > 0 && cur) {
        const idx = list.findIndex((x) => x.id === cur.id);
        if (r === "all") {
          play(list[(idx + 1) % list.length]);
        } else {
          if (idx >= 0 && idx < list.length - 1) play(list[idx + 1]);
        }
      }
    };
    audio.onerror = () => {
      stopTicker();
      setStatus("ended");
    };
    audio.play().then(() => {
      setStatus("playing");
      startTicker();
    }).catch((e) => {
      console.warn("[PlayerAgent] play() rejected:", e);
      setStatus("paused");
    });
  }, [repeat, volume, startTicker, stopTicker]);

  const pause = useCallback(() => {
    audioRef.current?.pause();
    setStatus("paused");
    stopTicker();
  }, [stopTicker]);

  const toggle = useCallback(() => {
    const a = audioRef.current;
    if (!a) return;
    if (a.paused) play();
    else pause();
  }, [play, pause]);

  const seek = useCallback((sec: number) => {
    const a = audioRef.current;
    if (!a) return;
    try { a.currentTime = Math.max(0, Math.min(sec, a.duration || sec)); } catch {}
    setCurrentTime(a.currentTime);
  }, []);

  const next = useCallback(() => {
    const list = queueRef.current;
    if (list.length === 0) return;
    const cur = current;
    const idx = cur ? list.findIndex((x) => x.id === cur.id) : -1;
    const nextIdx = idx >= 0 ? (idx + 1) % list.length : 0;
    if (list[nextIdx]) play(list[nextIdx]);
  }, [current, play]);

  const prev = useCallback(() => {
    const list = queueRef.current;
    if (list.length === 0) return;
    const cur = current;
    const idx = cur ? list.findIndex((x) => x.id === cur.id) : -1;
    const prevIdx = idx > 0 ? idx - 1 : list.length - 1;
    if (list[prevIdx]) play(list[prevIdx]);
  }, [current, play]);

  // MediaSession lockscreen (Eugene 2026-05-10 «обложки кардинально»).
  // Используем готовый helper /lib/lockscreen.ts — он уже знает iOS-кейсы
  // (prewarm cover, абсолютные URL, multiple sizes, first-write retry).
  // setLockScreenTrack вызывается в play() ДО audio.play(), здесь
  // только sync state/position/cleanup.
  useEffect(() => {
    if (!current) {
      clearLockScreen();
      return;
    }
    // Re-apply при смене current (если play() уже отработал)
    const handlers = {
      play: () => play(),
      pause: () => pause(),
      previoustrack: () => prev(),
      nexttrack: () => next(),
      seekto: (sec: number) => seek(sec),
    };
    setLockScreenTrack(
      {
        id: current.id,
        title: current.prompt || (current as any).display_title || "Трек",
        artist: current.authorName ? `MuziAi · ${current.authorName}` : "MuziAi",
        album: "MuziAi",
      },
      handlers,
      (current as any).updatedAt || (current as any).updated_at || undefined,
    ).catch(() => {});
  }, [current, play, pause, prev, next, seek]);
  // playbackState и position — отдельно, чтобы не пересоздавать metadata на каждый tick
  useEffect(() => {
    setLockScreenPlaybackState(
      status === "playing" ? "playing" : status === "paused" ? "paused" : "none",
    );
  }, [status]);
  useEffect(() => {
    if (duration && isFinite(duration) && duration > 0) {
      setLockScreenPosition(duration, currentTime);
    }
  }, [currentTime, duration]);

  const value: PlayerContextValue = {
    current, queue, currentTime, duration, status, repeat, volume,
    play, pause, toggle, seek, next, prev, setQueue, setRepeat, setVolume,
  };
  return <PlayerContext.Provider value={value}>{children}</PlayerContext.Provider>;
}

export function usePlayer(): PlayerContextValue {
  const ctx = useContext(PlayerContext);
  if (!ctx) throw new Error("usePlayer must be used within PlayerProvider");
  return ctx;
}
