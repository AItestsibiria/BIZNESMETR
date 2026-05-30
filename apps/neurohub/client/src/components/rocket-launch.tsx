// Eugene 2026-05-21 Босс: «при окончании трека юзера — пролёт ракеты вверх
// под разными углами, красиво, медленно».
//
// Trigger: window CustomEvent 'muza:track-finished' (dispatch'ится из handleEnded
// в landing.tsx). На каждое событие — 1-3 ракеты с random траекторией.
//
// CSS-only animation (transform + opacity, GPU-accelerated). Каждая ракета
// auto-removed через 5.5s. prefers-reduced-motion safe.

import { useEffect, useState } from "react";
import { BrandRocket } from "./brand-rocket";

interface Rocket {
  id: number;
  startX: number;      // px (если from-digit) или vw % (если from-bottom)
  startY: number;      // px (если from-digit) или vh % (если from-bottom)
  endX: number;        // vw %
  angle: number;       // -25..+25 deg
  duration: number;    // 4-6 sec
  delay: number;
  emoji: string;
  positioning: "abs-px" | "vw-vh"; // как интерпретировать startX/Y
}

const ROCKET_EMOJIS = ["🚀", "🚀", "🚀", "✨", "🎵", "💫"];

function randomRocketFromBottom(): Rocket {
  const startX = 10 + Math.random() * 80;
  const drift = -25 + Math.random() * 50;
  const endX = Math.max(0, Math.min(100, startX + drift));
  const angle = (drift / 50) * 25;
  return {
    id: Date.now() + Math.random() * 1000,
    startX,
    startY: 110,
    endX,
    angle,
    // Eugene 2026-05-21 Босс «медленнее». 4-6s → 8-10s.
    duration: 8 + Math.random() * 2,
    delay: Math.random() * 0.4,
    emoji: ROCKET_EMOJIS[Math.floor(Math.random() * ROCKET_EMOJIS.length)],
    positioning: "vw-vh",
  };
}

function rocketFromPoint(px: number, py: number): Rocket {
  // px/py — center of digit. End — vw %.
  const drift = -25 + Math.random() * 50;
  const endX = Math.max(0, Math.min(100, 50 + drift));
  const angle = (drift / 50) * 25;
  return {
    id: Date.now() + Math.random() * 1000,
    startX: px,
    startY: py,
    endX,
    angle,
    // Eugene 2026-05-21 Босс «медленнее». 5-6.5s → 9-10.5s.
    duration: 9 + Math.random() * 1.5,
    delay: 0,
    emoji: "🚀",
    positioning: "abs-px",
  };
}

// Босс 2026-05-30: на каждом ЗАЧЁТНОМ play счётчика — ВЕРТИКАЛЬНЫЙ пролёт
// ракеты с пламенем, ВДОЛЬ СЧЁТЧИКА, В ГЛУБИНУ КОСМОСА (perspective shrink).
// Стартpoint = координаты счётчика (event.detail.x/y). angle=0 (чистая вертикаль).
function verticalRocketFromCounter(px: number, py: number): Rocket {
  return {
    id: Date.now() + Math.random() * 1000,
    startX: px,
    startY: py,
    endX: 50, // не используется в кейфрейме вертикальной ракеты
    angle: 0, // чистая вертикаль (без drift)
    duration: 6 + Math.random() * 1.5, // 6-7.5 сек — заметный пролёт
    delay: 0,
    emoji: "🚀",
    positioning: "abs-px",
  };
}

export function RocketLaunch() {
  const [rockets, setRockets] = useState<Rocket[]>([]);
  // Eugene 2026-05-21 Босс «не накапливаются. Только одна за полное
  // прослушивание трека юзером». Gate: если уже летит — skip.
  const inFlightRef = { current: 0 } as { current: number };

  useEffect(() => {
    // Eugene 2026-05-21 Босс: ОДНА ракета на 1 завершённое прослушивание.
    // track-finished dispatch'ится в landing.tsx handleEnded при natural
    // audio.ended event (юзер дослушал до конца). counter-up НЕ триггерит
    // ракету (раньше делал — теперь только blink digits, ракета не плодится).
    const onTrackFinished = () => {
      if (inFlightRef.current > 0) return;
      inFlightRef.current = 1;
      const newRockets: Rocket[] = [randomRocketFromBottom()];
      setRockets(prev => [...prev, ...newRockets]);

      const maxLifetime = Math.round((newRockets[0].duration + 1) * 1000);
      setTimeout(() => {
        const ids = new Set(newRockets.map(r => r.id));
        setRockets(prev => prev.filter(r => !ids.has(r.id)));
        inFlightRef.current = 0;
        try { window.dispatchEvent(new CustomEvent("muza:rocket-landed")); } catch {}
      }, maxLifetime);
    };
    // Босс 2026-05-30: каждый зачётный play (counter+1) → вертикальная ракета
    // от счётчика в глубину космоса. Координаты из event.detail.
    const onCounterUp = (e: Event) => {
      try {
        const { x, y } = (e as CustomEvent).detail || {};
        if (typeof x !== "number" || typeof y !== "number") return;
        const r = verticalRocketFromCounter(x, y);
        setRockets(prev => [...prev, r]);
        setTimeout(() => {
          setRockets(prev => prev.filter(p => p.id !== r.id));
        }, Math.round((r.duration + 0.5) * 1000));
      } catch { /* no-op */ }
    };
    // Босс 2026-05-30: «у админа +100 прослушиваний — у юзера и у меня
    // одновременно». Milestone +100 → 3 вертикальных ракеты подряд.
    const onMilestone100 = (e: Event) => {
      try {
        const { x, y } = (e as CustomEvent).detail || {};
        if (typeof x !== "number" || typeof y !== "number") return;
        for (let i = 0; i < 3; i++) {
          const r = verticalRocketFromCounter(x + (Math.random() * 80 - 40), y);
          const ri = { ...r, id: r.id + i * 0.1, delay: i * 0.25 };
          setRockets(prev => [...prev, ri]);
          setTimeout(() => {
            setRockets(prev => prev.filter(p => p.id !== ri.id));
          }, Math.round((ri.duration + ri.delay + 0.5) * 1000));
        }
      } catch { /* no-op */ }
    };
    window.addEventListener("muza:track-finished", onTrackFinished as EventListener);
    window.addEventListener("muza:counter-up", onCounterUp as EventListener);
    window.addEventListener("muza:milestone-100", onMilestone100 as EventListener);
    return () => {
      window.removeEventListener("muza:track-finished", onTrackFinished as EventListener);
      window.removeEventListener("muza:counter-up", onCounterUp as EventListener);
      window.removeEventListener("muza:milestone-100", onMilestone100 as EventListener);
    };
  }, []);

  if (rockets.length === 0) return null;

  return (
    <>
      <style>{`
        @keyframes rocket-launch {
          0% {
            transform: translate(var(--rocket-start-tx), var(--rocket-start-ty)) rotate(var(--rocket-angle)) scale(0.5);
            opacity: 0;
          }
          5% {
            opacity: 1;
            transform: translate(var(--rocket-start-tx), var(--rocket-start-ty)) rotate(var(--rocket-angle)) scale(0.9);
          }
          85% {
            opacity: 1;
            transform: translate(var(--rocket-end-tx), -10vh) rotate(var(--rocket-angle)) scale(1.1);
          }
          100% {
            opacity: 0;
            transform: translate(var(--rocket-end-tx), -30vh) rotate(var(--rocket-angle)) scale(0.6);
          }
        }
        @keyframes rocket-launch-frompoint {
          0% {
            transform: rotate(var(--rocket-angle)) scale(0.5);
            opacity: 0;
          }
          8% {
            opacity: 1;
            transform: rotate(var(--rocket-angle)) scale(1.1);
          }
          85% {
            opacity: 1;
          }
          100% {
            opacity: 0;
          }
        }
        @keyframes rocket-trail {
          0%, 100% { opacity: 0.3; transform: scaleY(0.6); }
          50% { opacity: 0.9; transform: scaleY(1); }
        }
        /* Eugene 2026-05-21 Босс «медленнее» — trail тоже медленнее. */
        .rocket-trail { animation-duration: 0.7s !important; }
        .rocket-fx {
          position: fixed;
          left: 0;
          top: 0;
          pointer-events: none;
          z-index: 9999;
          will-change: transform, opacity;
          /* font-size убран — SVG ракета сама задаёт size */
        }
        .rocket-trail {
          position: absolute;
          top: 100%;
          left: 50%;
          transform-origin: top center;
          width: 4px;
          height: 60px;
          background: linear-gradient(to bottom, rgba(217,70,239,0.9) 0%, rgba(124,58,237,0.5) 40%, transparent 100%);
          border-radius: 50%;
          margin-left: -2px;
          animation: rocket-trail 0.4s ease-in-out infinite;
          filter: blur(2px);
        }
        /* Босс 2026-05-30: «вертикальный пролёт с пламенем» — длинный шлейф для
           вертикальной ракеты от счётчика, заметно «огня» больше. */
        .rocket-trail-tall {
          width: 6px;
          height: 110px;
          margin-left: -3px;
          background: linear-gradient(to bottom,
            rgba(255,200,90,0.95) 0%,
            rgba(217,70,239,0.85) 25%,
            rgba(124,58,237,0.55) 55%,
            rgba(56,189,248,0.25) 80%,
            transparent 100%);
          filter: blur(2.5px);
        }
        @media (prefers-reduced-motion: reduce) {
          .rocket-fx { display: none !important; }
        }
      `}</style>
      {rockets.map(r => {
        if (r.positioning === "abs-px") {
          // Босс 2026-05-30: если angle=0 → ВЕРТИКАЛЬНАЯ ракета от счётчика
          // в глубину космоса (perspective shrink: scale 1→0.08, opacity 1→0,
          // движение строго вверх без бокового drift). Иначе — обычная.
          const isVertical = r.angle === 0;
          if (isVertical) {
            const vh = typeof window !== "undefined" ? window.innerHeight : 800;
            return (
              <span
                key={r.id}
                className="rocket-fx"
                style={{
                  left: `${r.startX - 21}px`,
                  top: `${r.startY - 21}px`,
                  animation: `rocket-vert-${r.id} ${r.duration}s cubic-bezier(0.18, 0.5, 0.4, 0.98) ${r.delay || 0}s forwards`,
                } as any}
                aria-hidden="true"
              >
                <style>{`
                  @keyframes rocket-vert-${r.id} {
                    0%   { transform: translate(0, 0) scale(0.5); opacity: 0; }
                    8%   { transform: translate(0, -20px) scale(1.05); opacity: 1; }
                    35%  { transform: translate(0, -${vh * 0.35}px) scale(0.85); opacity: 0.95; }
                    65%  { transform: translate(0, -${vh * 0.65}px) scale(0.45); opacity: 0.7; }
                    90%  { transform: translate(0, -${vh * 0.9}px) scale(0.18); opacity: 0.35; }
                    100% { transform: translate(0, -${vh + 80}px) scale(0.06); opacity: 0; }
                  }
                `}</style>
                <BrandRocket size={42} />
                <span className="rocket-trail rocket-trail-tall" aria-hidden="true" />
              </span>
            );
          }
          // Ракета стартует из конкретной точки (last-digit в counter'е).
          // Используем outer wrapper с fixed positioning + inner animation.
          const dx = (r.endX / 100) * (typeof window !== "undefined" ? window.innerWidth : 1000) - r.startX;
          return (
            <span
              key={r.id}
              className="rocket-fx"
              style={{
                left: `${r.startX - 18}px`,  // -18 = half emoji width
                top: `${r.startY - 18}px`,
                animation: `rocket-fly-${r.id} ${r.duration}s cubic-bezier(0.22, 0.61, 0.36, 1) forwards`,
              } as any}
              aria-hidden="true"
            >
              {/* Inline keyframe per rocket — нужны абсолютные dx/dy */}
              <style>{`
                @keyframes rocket-fly-${r.id} {
                  0% { transform: translate(0, 0) rotate(${r.angle}deg) scale(0.6); opacity: 0; }
                  10% { transform: translate(${dx * 0.05}px, -30px) rotate(${r.angle}deg) scale(1); opacity: 1; }
                  85% { transform: translate(${dx * 0.85}px, -${(typeof window !== "undefined" ? window.innerHeight : 800) + 100}px) rotate(${r.angle}deg) scale(1.1); opacity: 1; }
                  100% { transform: translate(${dx}px, -${(typeof window !== "undefined" ? window.innerHeight : 800) + 200}px) rotate(${r.angle}deg) scale(0.5); opacity: 0; }
                }
              `}</style>
              {/* Eugene 2026-05-21 Босс «ракета в brand-цветах MuzaAi» */}
              <BrandRocket size={42} />
              <span className="rocket-trail" aria-hidden="true" />
            </span>
          );
        }
        return (
          <span
            key={r.id}
            className="rocket-fx"
            style={{
              "--rocket-start-tx": `${r.startX}vw`,
              "--rocket-start-ty": `${r.startY}vh`,
              "--rocket-end-tx": `${r.endX}vw`,
              "--rocket-angle": `${r.angle}deg`,
              animation: `rocket-launch ${r.duration}s cubic-bezier(0.22, 0.61, 0.36, 1) ${r.delay}s forwards`,
            } as any}
            aria-hidden="true"
          >
            <BrandRocket size={42} />
            <span className="rocket-trail" aria-hidden="true" />
          </span>
        );
      })}
    </>
  );
}
