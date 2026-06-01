// Босс 2026-05-30: «Планеты, Луна иногда переливаются в стиле музы — пульсируют
// 3 раза привлекая внимание чтоб юзер захотел нажать».
//
// Компонент-overlay поверх globe canvas. Каждые 15-20 сек случайно выбирает
// одно видимое небесное тело (планета / Луна / Солнце, кроме Земли) и
// запускает 3 концентрических кольца brand-gradient вокруг него.
//
// Координаты — из window.__muziaiPlanetScreen (snapshot per-frame из globe-view).
// Position: absolute внутри parent globe-area; родитель уже относительно canvas
// (rect совпадает — координаты прямые px от верхнего-левого угла canvas).
//
// CLAUDE.md:
// - Reuse-working-solutions: переиспользуем planetScreenRef snapshot
// - Brand-style consistency: purple→fuchsia→cyan brand gradient
// - Layout-fit-no-overlap: pointer-events:none — не блокирует tap-to-fly
// - Globe-swipe-only-on-stars: не вмешивается в swipe/tap detection
// - prefers-reduced-motion: pulse отключается

import { useEffect, useState } from "react";

interface PulseSpawn {
  id: number;
  x: number; // px относительно canvas wrapper
  y: number;
  bodyKey: string;
}

interface PulseProps {
  /** Активен ли overlay (показывать только когда globe виден). */
  enabled: boolean;
}

// Босс «каждые 15-20 сек». Минимум — 15с, максимум — 20с (random в окне).
const MIN_INTERVAL_MS = 15000;
const MAX_INTERVAL_MS = 20000;

// Длительность одного pulse-ring (3 ring подряд со stagger).
const RING_DURATION_MS = 700;
const RING_STAGGER_MS = 250;
const TOTAL_PULSE_MS = RING_DURATION_MS + RING_STAGGER_MS * 2 + 100; // 3 ring + хвост

export function TappableBodyPulse({ enabled }: PulseProps) {
  const [spawn, setSpawn] = useState<PulseSpawn | null>(null);

  useEffect(() => {
    if (!enabled) {
      setSpawn(null);
      return;
    }
    // Reduced-motion — не пульсируем.
    try {
      if (typeof window !== "undefined" && window.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches) {
        return;
      }
    } catch {
      /* no-op */
    }

    let timeoutId: number | null = null;
    let cancelled = false;

    const scheduleNext = () => {
      if (cancelled) return;
      const delay = MIN_INTERVAL_MS + Math.random() * (MAX_INTERVAL_MS - MIN_INTERVAL_MS);
      timeoutId = window.setTimeout(() => {
        if (cancelled) return;
        try {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const bodies = ((window as any).__muziaiPlanetScreen || []) as Array<{
            key: string;
            x: number;
            y: number;
            r: number;
            visible: boolean;
          }>;
          // Фильтруем: только видимые + НЕ Земля (мы на ней).
          const tappable = bodies.filter(b => b.visible && b.key !== "earth");
          if (tappable.length > 0) {
            const pick = tappable[Math.floor(Math.random() * tappable.length)];
            setSpawn({
              id: Date.now(),
              x: pick.x,
              y: pick.y,
              bodyKey: pick.key,
            });
            // Снимаем spawn после полного цикла 3 ring'ов.
            window.setTimeout(() => {
              if (!cancelled) setSpawn(null);
            }, TOTAL_PULSE_MS);
          }
        } catch {
          /* no-op — Player-render-resilience */
        }
        scheduleNext();
      }, delay);
    };

    scheduleNext();

    return () => {
      cancelled = true;
      if (timeoutId != null) window.clearTimeout(timeoutId);
    };
  }, [enabled]);

  if (!enabled || !spawn) return null;

  // 3 концентрических ring — каждое запускается со stagger 250мс.
  // scale 0.6 → 2.5, opacity 0.9 → 0, brand gradient.
  return (
    <>
      <style>{`
        @keyframes muza-body-pulse-ring {
          0%   { transform: translate(-50%, -50%) scale(0.6); opacity: 0.9; }
          100% { transform: translate(-50%, -50%) scale(2.5); opacity: 0; }
        }
        .muza-body-pulse-ring {
          position: absolute;
          width: 80px;
          height: 80px;
          border-radius: 50%;
          background: radial-gradient(circle, transparent 60%, rgba(124,58,237,0.5) 70%, rgba(217,70,239,0.4) 80%, rgba(0,212,255,0.3) 90%, transparent 100%);
          pointer-events: none;
          will-change: transform, opacity;
          filter: blur(1.5px);
        }
        @media (prefers-reduced-motion: reduce) {
          .muza-body-pulse-ring { display: none !important; }
        }
      `}</style>
      <div
        className="absolute inset-0 pointer-events-none z-20"
        aria-hidden="true"
        data-pulse-body={spawn.bodyKey}
      >
        {[0, 1, 2].map(i => (
          <span
            key={`${spawn.id}-${i}`}
            className="muza-body-pulse-ring"
            style={{
              left: `${spawn.x}px`,
              top: `${spawn.y}px`,
              animation: `muza-body-pulse-ring ${RING_DURATION_MS}ms ease-out ${i * RING_STAGGER_MS}ms forwards`,
            }}
          />
        ))}
      </div>
    </>
  );
}

export default TappableBodyPulse;
