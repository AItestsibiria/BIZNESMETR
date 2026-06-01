// Eugene 2026-05-21 Босс «на +1000 prosлушиваний фейерверк в стиле MuzaAi».
// Listener на window event 'muza:milestone-1000'. При срабатывании — 8 ракет
// взлетают одновременно с разных точек, взрываются на 60-80vh искрами
// в brand-цветах (purple/fuchsia/cyan).
// CSS-only (transform + opacity), GPU-accelerated, prefers-reduced-motion safe.

import { useEffect, useState } from "react";

interface Firework {
  id: number;
  startX: number;  // vw %
  burstY: number;  // vh %
  hue: "purple" | "fuchsia" | "cyan";
  delay: number;   // sec
}

const BRAND_COLORS = {
  purple: { core: "#c084fc", glow: "#7c3aed" },
  fuchsia: { core: "#f0abfc", glow: "#d946ef" },
  cyan: { core: "#67e8f9", glow: "#06b6d4" },
};

export function Fireworks() {
  const [bursts, setBursts] = useState<Firework[]>([]);

  useEffect(() => {
    const onMilestone = () => {
      // 8 fireworks с разных стартовых точек + углами
      const newBursts: Firework[] = [];
      for (let i = 0; i < 8; i++) {
        const hues: Firework["hue"][] = ["purple", "fuchsia", "cyan"];
        newBursts.push({
          id: Date.now() + i,
          startX: 10 + (i * 10) + (Math.random() * 6),  // 10vw, 20vw, ...
          burstY: 25 + Math.random() * 35,
          hue: hues[i % hues.length],
          delay: i * 0.18,
        });
      }
      setBursts(prev => [...prev, ...newBursts]);
      setTimeout(() => {
        const ids = new Set(newBursts.map(b => b.id));
        setBursts(prev => prev.filter(b => !ids.has(b.id)));
      }, 6000);
    };
    window.addEventListener("muza:milestone-1000", onMilestone as EventListener);
    return () => window.removeEventListener("muza:milestone-1000", onMilestone as EventListener);
  }, []);

  if (bursts.length === 0) return null;

  return (
    <>
      <style>{`
        @keyframes fw-rise {
          0% { transform: translateY(110vh) scale(0.6); opacity: 0; }
          15% { opacity: 1; }
          70% { transform: translateY(var(--fw-burst-y)) scale(1); opacity: 1; }
          75% { transform: translateY(var(--fw-burst-y)) scale(1); opacity: 0; }
          100% { transform: translateY(var(--fw-burst-y)) scale(1); opacity: 0; }
        }
        @keyframes fw-spark {
          0% { transform: translate(0, 0) scale(0); opacity: 0; }
          5% { transform: translate(0, 0) scale(1); opacity: 1; }
          100% { transform: translate(var(--fw-sx), var(--fw-sy)) scale(0.3); opacity: 0; }
        }
        .fw-rocket {
          position: fixed;
          bottom: 0;
          width: 4px;
          height: 16px;
          border-radius: 2px;
          will-change: transform, opacity;
          z-index: 9998;
          pointer-events: none;
        }
        .fw-burst {
          position: fixed;
          width: 0;
          height: 0;
          z-index: 9998;
          pointer-events: none;
        }
        .fw-spark {
          position: absolute;
          width: 6px;
          height: 6px;
          border-radius: 50%;
          will-change: transform, opacity;
        }
        @media (prefers-reduced-motion: reduce) {
          .fw-rocket, .fw-burst { display: none !important; }
        }
      `}</style>
      {bursts.map(b => {
        const color = BRAND_COLORS[b.hue];
        return (
          <span key={b.id}>
            {/* Восходящая ракета */}
            <span
              className="fw-rocket"
              style={{
                left: `${b.startX}vw`,
                background: `linear-gradient(to top, transparent, ${color.glow}, ${color.core})`,
                boxShadow: `0 0 8px ${color.glow}, 0 0 16px ${color.glow}`,
                animation: `fw-rise 2s ease-out ${b.delay}s forwards`,
                "--fw-burst-y": `${b.burstY}vh`,
              } as any}
            />
            {/* Взрыв искр (появляется через 2s после старта) */}
            <span
              className="fw-burst"
              style={{
                left: `${b.startX}vw`,
                top: `${b.burstY}vh`,
                animationDelay: `${b.delay + 1.95}s`,
              } as any}
            >
              {/* 16 искр радиально */}
              {Array.from({ length: 16 }).map((_, j) => {
                const angle = (j / 16) * Math.PI * 2;
                const dist = 80 + Math.random() * 40;
                const sx = Math.cos(angle) * dist;
                const sy = Math.sin(angle) * dist;
                return (
                  <span
                    key={j}
                    className="fw-spark"
                    style={{
                      background: color.core,
                      boxShadow: `0 0 8px ${color.glow}, 0 0 16px ${color.glow}`,
                      animation: `fw-spark 2.5s cubic-bezier(0.22, 0.61, 0.36, 1) ${b.delay + 1.95}s forwards`,
                      "--fw-sx": `${sx}px`,
                      "--fw-sy": `${sy}px`,
                    } as any}
                  />
                );
              })}
            </span>
          </span>
        );
      })}
    </>
  );
}
