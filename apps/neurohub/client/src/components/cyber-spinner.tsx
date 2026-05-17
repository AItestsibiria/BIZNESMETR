// Eugene 2026-05-17 — hi-tech loading indicator: 3 концентрических кольца
// вращаются в разные стороны, цвета brand-палитры (purple / cyan / amber).
// Drop-in замена для <Loader2 className="animate-spin" /> в местах где нужен
// акцентный cyber-look. Не использую везде — только на ключевых страницах
// (auth, hero CTAs), Loader2 остаётся как универсальный inline-fallback.
//
// CSS-only через inline <style> (изолированный keyframe scope per-instance не
// нужен — keyframes глобальны но безопасны). Размер берётся пропом sizePx
// (default 32 = ~ w-8 h-8). Reduced-motion → кольца статичны.

interface CyberSpinnerProps {
  /** Размер квадратного контейнера в px. Default 32 (w-8 h-8). */
  sizePx?: number;
  /** Optional override className на root span (для positioning/margin). */
  className?: string;
  /** ARIA label для screen readers. Default "Загрузка". */
  label?: string;
}

export function CyberSpinner({
  sizePx = 32,
  className = "",
  label = "Загрузка",
}: CyberSpinnerProps) {
  const outerStyle = {
    width: `${sizePx}px`,
    height: `${sizePx}px`,
  };

  // Толщина кольца ~ 8% от размера (минимум 2px).
  const ring = Math.max(2, Math.round(sizePx * 0.08));
  // Радиусы — 3 концентрических с шагом 18%.
  const r1 = sizePx;
  const r2 = Math.round(sizePx * 0.72);
  const r3 = Math.round(sizePx * 0.44);

  return (
    <span
      role="status"
      aria-label={label}
      className={`inline-flex items-center justify-center relative ${className}`}
      style={outerStyle}
    >
      <style>{`
        @keyframes cyber-spinner-cw {
          to { transform: rotate(360deg); }
        }
        @keyframes cyber-spinner-ccw {
          to { transform: rotate(-360deg); }
        }
        .cs-ring {
          position: absolute;
          border-radius: 9999px;
          border-style: solid;
          border-color: transparent;
        }
        .cs-ring-1 {
          border-top-color: #7c3aed;
          border-right-color: #7c3aed;
          animation: cyber-spinner-cw 1.4s linear infinite;
        }
        .cs-ring-2 {
          border-top-color: #00d4ff;
          border-left-color: #00d4ff;
          animation: cyber-spinner-ccw 1.0s linear infinite;
        }
        .cs-ring-3 {
          border-top-color: #fbbf24;
          border-right-color: #fbbf24;
          animation: cyber-spinner-cw 0.7s linear infinite;
        }
        @media (prefers-reduced-motion: reduce) {
          .cs-ring-1, .cs-ring-2, .cs-ring-3 {
            animation: none;
          }
        }
      `}</style>
      <span
        className="cs-ring cs-ring-1"
        style={{ width: `${r1}px`, height: `${r1}px`, borderWidth: `${ring}px` }}
      />
      <span
        className="cs-ring cs-ring-2"
        style={{ width: `${r2}px`, height: `${r2}px`, borderWidth: `${ring}px` }}
      />
      <span
        className="cs-ring cs-ring-3"
        style={{ width: `${r3}px`, height: `${r3}px`, borderWidth: `${ring}px` }}
      />
      <span className="sr-only">{label}</span>
    </span>
  );
}

export default CyberSpinner;
