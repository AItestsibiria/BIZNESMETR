// Eugene 2026-05-21 Босс «3D iso · триумф, Variant C — Trophy с лавровым венком».
//
// Премиум-ракета: 2-тоновое тело (dark→bright purple), золотая центральная stripe,
// иллюминатор cyan с белым highlight, fins с золотым контуром, лавровый венок
// из золотых ellipse-листьев, soft halo. Анимация: пламя пульсирует, лавр
// слегка покачивается (триумфальный shimmer).
//
// Brand palette: purple #7c3aed/#5b1c95, fuchsia #d946ef, cyan #06b6d4,
// gold #fbbf24/#fde68a (триумф-акцент).

interface BrandRocketProps {
  size?: number;
  className?: string;
}

export function BrandRocket({ size = 48, className = "" }: BrandRocketProps) {
  const uid = String(Math.random()).slice(2, 9);
  return (
    <svg
      viewBox="0 0 100 120"
      width={size}
      height={size * 1.2}
      className={className}
      aria-hidden="true"
      style={{ filter: `drop-shadow(0 0 10px rgba(251,191,36,0.55)) drop-shadow(0 0 18px rgba(217,70,239,0.45))` }}
    >
      <defs>
        {/* Body halves */}
        <linearGradient id={`bodyL-${uid}`} x1="0" y1="0" x2="1" y2="0">
          <stop offset="0%" stopColor="#5b1c95" />
          <stop offset="100%" stopColor="#a855f7" />
        </linearGradient>
        <linearGradient id={`bodyR-${uid}`} x1="0" y1="0" x2="1" y2="0">
          <stop offset="0%" stopColor="#a855f7" />
          <stop offset="100%" stopColor="#5b1c95" />
        </linearGradient>
        {/* Nose cone — gold→fuchsia */}
        <linearGradient id={`nose-${uid}`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="#fde68a" />
          <stop offset="100%" stopColor="#d946ef" />
        </linearGradient>
        {/* Flame — yellow→fuchsia→fade */}
        <linearGradient id={`flame-${uid}`} x1="0.5" y1="0" x2="0.5" y2="1">
          <stop offset="0%" stopColor="#fef3c7" stopOpacity="0.95" />
          <stop offset="40%" stopColor="#d946ef" stopOpacity="0.85" />
          <stop offset="100%" stopColor="#06b6d4" stopOpacity="0" />
        </linearGradient>
        {/* Halo */}
        <radialGradient id={`halo-${uid}`} cx="0.5" cy="0.5" r="0.5">
          <stop offset="0%" stopColor="#fbbf24" stopOpacity="0.35" />
          <stop offset="60%" stopColor="#d946ef" stopOpacity="0.12" />
          <stop offset="100%" stopColor="#7c3aed" stopOpacity="0" />
        </radialGradient>
        <style>{`
          .br-flame-${uid} {
            transform-origin: 50px 90px;
            animation: br-flame-${uid} 0.2s ease-in-out infinite alternate;
          }
          .br-laurel-${uid} {
            transform-origin: 50px 60px;
            animation: br-laurel-${uid} 2.4s ease-in-out infinite;
          }
          .br-halo-${uid} {
            transform-origin: 50px 60px;
            animation: br-halo-${uid} 2.8s ease-in-out infinite;
          }
          @keyframes br-flame-${uid} {
            0% { transform: scaleY(0.85) scaleX(0.92); opacity: 0.88; }
            100% { transform: scaleY(1.18) scaleX(1.06); opacity: 1; }
          }
          @keyframes br-laurel-${uid} {
            0%, 100% { transform: scale(1); opacity: 0.9; }
            50% { transform: scale(1.04); opacity: 1; }
          }
          @keyframes br-halo-${uid} {
            0%, 100% { opacity: 0.6; transform: scale(1); }
            50% { opacity: 0.95; transform: scale(1.05); }
          }
          @media (prefers-reduced-motion: reduce) {
            .br-flame-${uid}, .br-laurel-${uid}, .br-halo-${uid} { animation: none; }
          }
        `}</style>
      </defs>

      {/* Golden halo behind */}
      <circle className={`br-halo-${uid}`} cx="50" cy="60" r="42" fill={`url(#halo-${uid})`} />

      {/* Laurel wreath — left */}
      <g className={`br-laurel-${uid}`} fill="#fbbf24" opacity="0.9">
        <ellipse cx="20" cy="40" rx="3" ry="8" transform="rotate(-55 20 40)" />
        <ellipse cx="14" cy="52" rx="3.2" ry="8.5" transform="rotate(-35 14 52)" />
        <ellipse cx="11" cy="65" rx="3.2" ry="8.5" transform="rotate(-15 11 65)" />
        <ellipse cx="13" cy="78" rx="3" ry="8" transform="rotate(20 13 78)" />
        <ellipse cx="20" cy="89" rx="3" ry="8" transform="rotate(45 20 89)" />
      </g>
      {/* Laurel wreath — right (mirror) */}
      <g className={`br-laurel-${uid}`} fill="#fbbf24" opacity="0.9">
        <ellipse cx="80" cy="40" rx="3" ry="8" transform="rotate(55 80 40)" />
        <ellipse cx="86" cy="52" rx="3.2" ry="8.5" transform="rotate(35 86 52)" />
        <ellipse cx="89" cy="65" rx="3.2" ry="8.5" transform="rotate(15 89 65)" />
        <ellipse cx="87" cy="78" rx="3" ry="8" transform="rotate(-20 87 78)" />
        <ellipse cx="80" cy="89" rx="3" ry="8" transform="rotate(-45 80 89)" />
      </g>

      {/* Flame */}
      <g className={`br-flame-${uid}`}>
        <path d="M35 88 Q50 130 65 88 Q58 115 50 122 Q42 115 35 88 Z" fill={`url(#flame-${uid})`} />
        <path d="M42 88 Q50 110 58 88 Q54 100 50 103 Q46 100 42 88 Z" fill="#fef3c7" opacity="0.7" />
      </g>

      {/* Body — left half */}
      <path
        d="M47 18 L24 50 L24 80 L30 92 L47 95 Z"
        fill={`url(#bodyL-${uid})`}
        stroke="#3b0764"
        strokeWidth="0.5"
      />
      {/* Body — right half */}
      <path
        d="M53 18 L76 50 L76 80 L70 92 L53 95 Z"
        fill={`url(#bodyR-${uid})`}
        stroke="#3b0764"
        strokeWidth="0.5"
      />

      {/* Nose cone */}
      <path
        d="M47 18 L53 18 L58 4 L42 4 Z"
        fill={`url(#nose-${uid})`}
      />
      <path
        d="M42 4 L50 -4 L58 4 Z"
        transform="translate(0,4)"
        fill="#fde68a"
      />

      {/* Center golden stripe (premium accent) */}
      <line
        x1="50" y1="18" x2="50" y2="93"
        stroke="#fde68a"
        strokeWidth="2"
        opacity="0.92"
        strokeLinecap="round"
      />

      {/* Premium window — dark rim + cyan + white highlight */}
      <circle cx="50" cy="50" r="11" fill="#1e293b" />
      <circle cx="50" cy="50" r="9" fill="#06b6d4" />
      <circle cx="46" cy="46" r="3" fill="#ECFEFF" opacity="0.9" />

      {/* Heavy fins — gold-trimmed */}
      <path
        d="M24 75 L8 100 L26 92 Z"
        fill="#5b1c95"
        stroke="#fbbf24"
        strokeWidth="1.5"
      />
      <path
        d="M76 75 L92 100 L74 92 Z"
        fill="#5b1c95"
        stroke="#fbbf24"
        strokeWidth="1.5"
      />

      {/* Body panel lines (subtle) */}
      <line x1="28" y1="70" x2="72" y2="70" stroke="#fbbf24" strokeWidth="0.7" opacity="0.55" />
      <line x1="30" y1="82" x2="70" y2="82" stroke="#fbbf24" strokeWidth="0.6" opacity="0.45" />
    </svg>
  );
}
