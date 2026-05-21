// Eugene 2026-05-21 Босс: «при окончании трека юзера — пролёт ракеты вверх
// под разными углами, красиво, медленно».
//
// Trigger: window CustomEvent 'muza:track-finished' (dispatch'ится из handleEnded
// в landing.tsx). На каждое событие — 1-3 ракеты с random траекторией.
//
// CSS-only animation (transform + opacity, GPU-accelerated). Каждая ракета
// auto-removed через 5.5s. prefers-reduced-motion safe.

import { useEffect, useState } from "react";

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
    duration: 4 + Math.random() * 2,
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
    duration: 5 + Math.random() * 1.5, // 5-6.5 sec — медленно
    delay: 0,
    emoji: "🚀",
    positioning: "abs-px",
  };
}

export function RocketLaunch() {
  const [rockets, setRockets] = useState<Rocket[]>([]);

  useEffect(() => {
    const onTrackFinished = () => {
      // Eugene 2026-05-21 Босс: «одна ракета на 1 трек».
      const newRockets: Rocket[] = [randomRocketFromBottom()];
      setRockets(prev => [...prev, ...newRockets]);

      const maxLifetime = 7000;
      setTimeout(() => {
        const ids = new Set(newRockets.map(r => r.id));
        setRockets(prev => prev.filter(r => !ids.has(r.id)));
        // Notify PlaysCounter → blink-post (для случая ended-event)
        try { window.dispatchEvent(new CustomEvent("muza:rocket-landed")); } catch {}
      }, maxLifetime);
    };
    // Eugene 2026-05-21 Босс «появление новой цифры → ракета из этой цифры → blink».
    const onCounterUp = (ev: CustomEvent) => {
      const x = Number(ev.detail?.x);
      const y = Number(ev.detail?.y);
      if (!Number.isFinite(x) || !Number.isFinite(y)) return;
      const r = rocketFromPoint(x, y);
      setRockets(prev => [...prev, r]);
      const lifetimeMs = Math.round(r.duration * 1000) + 500;
      setTimeout(() => {
        setRockets(prev => prev.filter(rr => rr.id !== r.id));
        try { window.dispatchEvent(new CustomEvent("muza:rocket-landed")); } catch {}
      }, lifetimeMs);
    };
    window.addEventListener("muza:track-finished", onTrackFinished as EventListener);
    window.addEventListener("muza:counter-up", onCounterUp as EventListener);
    return () => {
      window.removeEventListener("muza:track-finished", onTrackFinished as EventListener);
      window.removeEventListener("muza:counter-up", onCounterUp as EventListener);
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
        .rocket-fx {
          position: fixed;
          left: 0;
          top: 0;
          pointer-events: none;
          z-index: 9999;
          will-change: transform, opacity;
          font-size: 36px;
          filter: drop-shadow(0 0 12px rgba(217,70,239,0.6)) drop-shadow(0 0 24px rgba(124,58,237,0.4));
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
        @media (prefers-reduced-motion: reduce) {
          .rocket-fx { display: none !important; }
        }
      `}</style>
      {rockets.map(r => {
        if (r.positioning === "abs-px") {
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
              {r.emoji}
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
            {r.emoji}
            <span className="rocket-trail" aria-hidden="true" />
          </span>
        );
      })}
    </>
  );
}
