// Eugene 2026-05-21 Босс «приоритет counter — приведи в соответствие количество
// prosлушиваний на плейлисте фронта». Animated banner с total plays sum по
// main playlist. Refresh каждые 60 сек.
//
// Cache на сервере 60s (route.ts /api/playlist/stats), на client тоже 60s.
// Animated count-up от 0 до totalPlays — плавный rollup за 1.5 сек.

import { useEffect, useState, useRef } from "react";

interface Stats {
  totalPlays: number;
  totalTracks: number;
}

function useAnimatedNumber(target: number, durationMs = 1500): number {
  const [current, setCurrent] = useState(0);
  const startRef = useRef<number | null>(null);
  const fromRef = useRef(0);

  useEffect(() => {
    if (target === current) return;
    fromRef.current = current;
    startRef.current = performance.now();
    let raf = 0;
    const tick = (now: number) => {
      const start = startRef.current || now;
      const elapsed = now - start;
      const t = Math.min(1, elapsed / durationMs);
      // ease-out cubic
      const eased = 1 - Math.pow(1 - t, 3);
      const value = Math.round(fromRef.current + (target - fromRef.current) * eased);
      setCurrent(value);
      if (t < 1) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [target]);

  return current;
}

export function PlaysCounter({ className = "" }: { className?: string }) {
  const [stats, setStats] = useState<Stats | null>(null);
  const animated = useAnimatedNumber(stats?.totalPlays || 0);

  useEffect(() => {
    const fetchStats = () => {
      fetch("/api/playlist/stats", { cache: "default" })
        .then(r => r.ok ? r.json() : null)
        .then(j => {
          if (j && typeof j.totalPlays === "number") setStats(j);
        })
        .catch(() => {});
    };
    fetchStats();
    const interval = setInterval(fetchStats, 60_000);
    return () => clearInterval(interval);
  }, []);

  if (!stats || stats.totalPlays === 0) return null;

  // Format with thousands separator (RU locale)
  const formatted = animated.toLocaleString("ru-RU");

  return (
    <div
      className={`inline-flex items-center gap-2 px-4 py-2 rounded-full bg-gradient-to-r from-purple-500/15 via-fuchsia-500/15 to-cyan-500/15 border border-purple-400/30 backdrop-blur-md shadow-[0_0_24px_rgba(124,58,237,0.18)] ${className}`}
      title={`${stats.totalTracks} треков в плейлисте`}
    >
      <span className="text-lg" aria-hidden="true">🎧</span>
      <span className="font-mono text-base font-bold bg-gradient-to-r from-purple-300 via-fuchsia-300 to-cyan-300 bg-clip-text text-transparent tabular-nums">
        {formatted}
      </span>
      <span className="text-xs text-white/70 font-medium">прослушиваний</span>
    </div>
  );
}
