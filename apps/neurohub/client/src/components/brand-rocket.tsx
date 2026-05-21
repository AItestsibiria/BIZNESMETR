// Eugene 2026-05-21 Босс «задизайн ракету в brand-цветах MuzaAi».
//
// Brand palette: purple #7C3AED, fuchsia #D946EF, cyan #06B6D4, electric blue #00D4FF.
// Inline SVG (без deps), animated thrust flame через keyframes.

interface BrandRocketProps {
  size?: number;
  className?: string;
}

export function BrandRocket({ size = 36, className = "" }: BrandRocketProps) {
  // Unique IDs чтобы избежать конфликта когда несколько ракет в DOM одновременно
  const uid = String(Math.random()).slice(2, 9);
  return (
    <svg
      viewBox="0 0 64 64"
      width={size}
      height={size}
      className={className}
      aria-hidden="true"
      style={{ filter: "drop-shadow(0 0 8px rgba(217,70,239,0.7)) drop-shadow(0 0 16px rgba(124,58,237,0.5))" }}
    >
      <defs>
        {/* Body gradient: purple → fuchsia → cyan по вертикали */}
        <linearGradient id={`body-${uid}`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="#06B6D4" />
          <stop offset="35%" stopColor="#7C3AED" />
          <stop offset="100%" stopColor="#D946EF" />
        </linearGradient>
        {/* Window: cyan glow */}
        <radialGradient id={`win-${uid}`} cx="0.5" cy="0.5" r="0.5">
          <stop offset="0%" stopColor="#A5F3FC" />
          <stop offset="100%" stopColor="#06B6D4" />
        </radialGradient>
        {/* Flame: fuchsia → cyan по высоте */}
        <linearGradient id={`flame-${uid}`} x1="0.5" y1="0" x2="0.5" y2="1">
          <stop offset="0%" stopColor="#D946EF" />
          <stop offset="60%" stopColor="#7C3AED" />
          <stop offset="100%" stopColor="#06B6D4" stopOpacity="0" />
        </linearGradient>
        {/* Wings: solid fuchsia */}
        <linearGradient id={`wing-${uid}`} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stopColor="#D946EF" />
          <stop offset="100%" stopColor="#7C3AED" />
        </linearGradient>
        <style>{`
          .br-flame-${uid} {
            transform-origin: 32px 52px;
            animation: br-flicker-${uid} 0.18s ease-in-out infinite alternate;
          }
          @keyframes br-flicker-${uid} {
            0% { transform: scaleY(0.85) scaleX(0.92); opacity: 0.85; }
            100% { transform: scaleY(1.15) scaleX(1.05); opacity: 1; }
          }
          @media (prefers-reduced-motion: reduce) {
            .br-flame-${uid} { animation: none; }
          }
        `}</style>
      </defs>

      {/* Flame (под body, видна снизу) */}
      <g className={`br-flame-${uid}`}>
        <path d="M26 46 Q32 64 38 46 Q35 56 32 58 Q29 56 26 46 Z" fill={`url(#flame-${uid})`} />
        <path d="M29 46 Q32 56 35 46 Q33 52 32 53 Q31 52 29 46 Z" fill="#A5F3FC" opacity="0.7" />
      </g>

      {/* Левое крыло */}
      <path
        d="M16 36 L24 36 L24 50 L12 52 Z"
        fill={`url(#wing-${uid})`}
        stroke="#7C3AED"
        strokeWidth="0.5"
      />
      {/* Правое крыло */}
      <path
        d="M48 36 L40 36 L40 50 L52 52 Z"
        fill={`url(#wing-${uid})`}
        stroke="#7C3AED"
        strokeWidth="0.5"
      />

      {/* Body (rocket shape) */}
      <path
        d="M32 4
           C 24 4, 20 14, 20 26
           L 20 46
           C 20 50, 24 52, 32 52
           C 40 52, 44 50, 44 46
           L 44 26
           C 44 14, 40 4, 32 4 Z"
        fill={`url(#body-${uid})`}
        stroke="#06B6D4"
        strokeWidth="0.8"
      />

      {/* Nose tip highlight */}
      <path
        d="M32 4 C 28 6, 26 12, 26 18 L 38 18 C 38 12, 36 6, 32 4 Z"
        fill="#A5F3FC"
        opacity="0.4"
      />

      {/* Window (cockpit) */}
      <circle cx="32" cy="24" r="6" fill={`url(#win-${uid})`} stroke="#0891B2" strokeWidth="1" />
      <circle cx="30" cy="22" r="2" fill="#ECFEFF" opacity="0.85" />

      {/* Body details: 2 rivets / panel lines */}
      <line x1="22" y1="36" x2="42" y2="36" stroke="#7C3AED" strokeWidth="0.5" opacity="0.6" />
      <circle cx="32" cy="40" r="0.8" fill="#06B6D4" opacity="0.7" />
      <circle cx="32" cy="44" r="0.8" fill="#06B6D4" opacity="0.7" />
    </svg>
  );
}
