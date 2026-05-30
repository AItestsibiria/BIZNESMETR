// Босс 2026-05-30 п.5: моргание планеты на main плеере 1 раз / 3 мин.
// Subtle pulse glow, не отвлекает от плеера. Brand colors.
//
// CLAUDE.md:
// - Brand-style consistency rule — purple→fuchsia→cyan gradient + brand glow
// - Layout-fit-no-overlap rule — inline-flex малый размер (24px), не перекрывает
// - prefers-reduced-motion — анимация отключается
// - Counter-live-update rule — pure setState, без reload
// - Reuse-working-solutions rule — re-use brand palette, не вводить новые цвета
import { useEffect, useRef, useState } from "react";

interface Props {
  /** Интервал между блинками в мс. По умолчанию 3 мин = 180000. */
  intervalMs?: number;
  /** Длительность одного blink-цикла в мс. По умолчанию 600. */
  blinkDurationMs?: number;
  /** Размер планеты в px (квадрат). По умолчанию 24. */
  size?: number;
  className?: string;
}

const DEFAULT_INTERVAL = 180_000; // 3 мин
const DEFAULT_BLINK_DUR = 600;

export function PlayerPlanetBlink({
  intervalMs = DEFAULT_INTERVAL,
  blinkDurationMs = DEFAULT_BLINK_DUR,
  size = 24,
  className = "",
}: Props) {
  const [blinking, setBlinking] = useState(false);
  const blinkTimerRef = useRef<number | null>(null);
  const intervalRef = useRef<number | null>(null);

  useEffect(() => {
    if (typeof window === "undefined") return;
    // Schedule blinks every intervalMs. Сначала тоже задержка intervalMs,
    // чтобы не мигало сразу при загрузке страницы.
    const trigger = () => {
      setBlinking(true);
      if (blinkTimerRef.current) window.clearTimeout(blinkTimerRef.current);
      blinkTimerRef.current = window.setTimeout(() => {
        setBlinking(false);
      }, blinkDurationMs);
    };
    intervalRef.current = window.setInterval(trigger, intervalMs);
    return () => {
      if (intervalRef.current) window.clearInterval(intervalRef.current);
      if (blinkTimerRef.current) window.clearTimeout(blinkTimerRef.current);
    };
  }, [intervalMs, blinkDurationMs]);

  return (
    <span
      className={`inline-flex items-center justify-center select-none pointer-events-none ${className}`}
      aria-hidden="true"
      style={{ width: size, height: size }}
    >
      <style>{`
        @keyframes muza-planet-blink {
          0%   { transform: scale(1.0); opacity: 0.55; filter: brightness(1.0); }
          50%  { transform: scale(1.30); opacity: 1.0;  filter: brightness(1.35); }
          100% { transform: scale(1.0); opacity: 0.55; filter: brightness(1.0); }
        }
        .muza-planet-orb {
          width: 100%; height: 100%;
          border-radius: 9999px;
          background: radial-gradient(circle at 30% 30%, rgba(196,181,253,0.95) 0%, rgba(124,58,237,0.85) 35%, rgba(217,70,239,0.75) 65%, rgba(0,212,255,0.55) 100%);
          box-shadow: 0 0 8px rgba(124,58,237,0.4), inset 0 0 4px rgba(255,255,255,0.3);
          transition: transform 200ms ease, opacity 200ms ease, filter 200ms ease, box-shadow 200ms ease;
        }
        .muza-planet-orb.is-blinking {
          animation: muza-planet-blink var(--muza-blink-dur, 600ms) ease-in-out 1;
          box-shadow: 0 0 18px rgba(124,58,237,0.85), 0 0 30px rgba(217,70,239,0.45), inset 0 0 6px rgba(255,255,255,0.5);
        }
        @media (prefers-reduced-motion: reduce) {
          .muza-planet-orb { animation: none !important; }
        }
      `}</style>
      <span
        className={`muza-planet-orb ${blinking ? "is-blinking" : ""}`}
        style={{ ["--muza-blink-dur" as any]: `${blinkDurationMs}ms` }}
      />
    </span>
  );
}

export default PlayerPlanetBlink;
