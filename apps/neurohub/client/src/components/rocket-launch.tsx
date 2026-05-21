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
  startX: number;      // 0-100 (vw %)
  endX: number;        // 0-100 (vw %)
  angle: number;       // -25..+25 deg
  duration: number;    // 4-6 sec
  delay: number;       // 0-0.4 sec (для group launch)
  emoji: string;
}

const ROCKET_EMOJIS = ["🚀", "🚀", "🚀", "✨", "🎵", "💫"];

function randomRocket(): Rocket {
  const startX = 10 + Math.random() * 80; // от 10vw до 90vw
  const drift = -25 + Math.random() * 50; // отклонение -25..+25vw
  const endX = Math.max(0, Math.min(100, startX + drift));
  const angle = (drift / 50) * 25; // привязка наклона к direction
  return {
    id: Date.now() + Math.random() * 1000,
    startX,
    endX,
    angle,
    duration: 4 + Math.random() * 2, // 4-6 sec
    delay: Math.random() * 0.4,
    emoji: ROCKET_EMOJIS[Math.floor(Math.random() * ROCKET_EMOJIS.length)],
  };
}

export function RocketLaunch() {
  const [rockets, setRockets] = useState<Rocket[]>([]);

  useEffect(() => {
    const onTrackFinished = () => {
      // Spawn 1-3 ракет одновременно (random count, медленно)
      const count = 1 + Math.floor(Math.random() * 3);
      const newRockets: Rocket[] = [];
      for (let i = 0; i < count; i++) newRockets.push(randomRocket());
      setRockets(prev => [...prev, ...newRockets]);

      // Auto-cleanup после max duration
      const maxLifetime = 7000; // 6s anim + 1s buffer
      setTimeout(() => {
        const ids = new Set(newRockets.map(r => r.id));
        setRockets(prev => prev.filter(r => !ids.has(r.id)));
      }, maxLifetime);
    };
    window.addEventListener("muza:track-finished", onTrackFinished as EventListener);
    return () => window.removeEventListener("muza:track-finished", onTrackFinished as EventListener);
  }, []);

  if (rockets.length === 0) return null;

  return (
    <>
      <style>{`
        @keyframes rocket-launch {
          0% {
            transform: translate(var(--rocket-start-tx), 110vh) rotate(var(--rocket-angle)) scale(0.5);
            opacity: 0;
          }
          5% {
            opacity: 1;
            transform: translate(var(--rocket-start-tx), 100vh) rotate(var(--rocket-angle)) scale(0.8);
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
      {rockets.map(r => (
        <span
          key={r.id}
          className="rocket-fx"
          style={{
            "--rocket-start-tx": `${r.startX}vw`,
            "--rocket-end-tx": `${r.endX}vw`,
            "--rocket-angle": `${r.angle}deg`,
            animation: `rocket-launch ${r.duration}s cubic-bezier(0.22, 0.61, 0.36, 1) ${r.delay}s forwards`,
          } as any}
          aria-hidden="true"
        >
          {r.emoji}
          <span className="rocket-trail" aria-hidden="true" />
        </span>
      ))}
    </>
  );
}
