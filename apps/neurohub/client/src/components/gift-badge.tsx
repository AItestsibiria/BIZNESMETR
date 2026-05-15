// Eugene 2026-05-15 Босс «красиво у автора подарочный трек значком оформить».
//
// Заменяет простой "+N🎁" на анимированный бейдж с подарочной коробкой,
// градиентом, glow, sparkles и tooltip.
//
// Размеры: sm (для navbar), md (для balance card), lg (для landing/promo).
//
// Использование:
//   <GiftBadge count={2} />                — md (default)
//   <GiftBadge count={1} size="sm" />      — компактный (navbar)
//   <GiftBadge count={3} size="lg" label="Подарочный трек ждёт" />

import { useState } from "react";

interface Props {
  count: number;
  size?: "sm" | "md" | "lg";
  label?: string;
  tooltip?: string;
}

export default function GiftBadge({ count, size = "md", label, tooltip }: Props) {
  const [hovered, setHovered] = useState(false);
  if (count <= 0) return null;

  const sizes = {
    sm: { wrap: "px-2 py-0.5 gap-1 text-xs", icon: 14, num: "text-xs", lbl: "text-[10px]" },
    md: { wrap: "px-3 py-1 gap-1.5 text-sm", icon: 18, num: "text-sm", lbl: "text-xs" },
    lg: { wrap: "px-4 py-1.5 gap-2 text-base", icon: 24, num: "text-base", lbl: "text-sm" },
  };
  const s = sizes[size];

  return (
    <span
      className={`relative inline-flex items-center ${s.wrap} rounded-full gift-badge-bg overflow-hidden group cursor-default`}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      title={tooltip || (label ? `${label} · ${count}` : `Подарочный трек · ${count}`)}
      data-testid="gift-badge"
    >
      {/* Soft glow layer behind */}
      <span aria-hidden className="absolute inset-0 rounded-full opacity-60 blur-md gift-badge-glow pointer-events-none" />

      {/* Gift box icon — custom SVG */}
      <svg
        xmlns="http://www.w3.org/2000/svg"
        width={s.icon}
        height={s.icon}
        viewBox="0 0 24 24"
        fill="none"
        className="relative z-10 drop-shadow-[0_0_4px_rgba(255,215,128,0.7)]"
        aria-hidden
      >
        {/* Bow knot */}
        <path
          d="M12 7 C 9 5, 7 4, 6 5.5 C 5.2 6.7, 6.5 8.2, 8.5 8 L 12 7 L 15.5 8 C 17.5 8.2, 18.8 6.7, 18 5.5 C 17 4, 15 5, 12 7 Z"
          fill="url(#gb-bow)"
          stroke="#fff7d9"
          strokeWidth="0.6"
          strokeLinejoin="round"
        />
        {/* Box body */}
        <rect x="4.5" y="9" width="15" height="11" rx="1.5" fill="url(#gb-box)" stroke="#f5d472" strokeWidth="0.6" />
        {/* Box vertical ribbon */}
        <rect x="10.8" y="9" width="2.4" height="11" fill="url(#gb-ribbon)" />
        {/* Box top edge */}
        <rect x="4.2" y="8.5" width="15.6" height="2" rx="0.5" fill="url(#gb-lid)" stroke="#f5d472" strokeWidth="0.5" />

        <defs>
          <linearGradient id="gb-box" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="#fef3c7" />
            <stop offset="50%" stopColor="#fcd34d" />
            <stop offset="100%" stopColor="#f59e0b" />
          </linearGradient>
          <linearGradient id="gb-lid" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="#fffbeb" />
            <stop offset="100%" stopColor="#fcd34d" />
          </linearGradient>
          <linearGradient id="gb-ribbon" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="#ec4899" />
            <stop offset="100%" stopColor="#a855f7" />
          </linearGradient>
          <linearGradient id="gb-bow" x1="0" y1="0" x2="1" y2="1">
            <stop offset="0%" stopColor="#f472b6" />
            <stop offset="100%" stopColor="#c084fc" />
          </linearGradient>
        </defs>
      </svg>

      {/* Sparkles — каждая со своей задержкой */}
      <span aria-hidden className="absolute -top-0.5 -right-0.5 text-yellow-200 text-[8px] gift-spark-1 z-20">✦</span>
      <span aria-hidden className="absolute -bottom-0.5 -left-0.5 text-pink-200 text-[7px] gift-spark-2 z-20">✧</span>
      <span aria-hidden className="absolute top-1/2 -right-1 text-cyan-200 text-[7px] gift-spark-3 z-20">✦</span>

      {/* Count + label */}
      <span className={`relative z-10 font-bold ${s.num} text-amber-50`}>
        +{count}
      </span>
      <span className={`relative z-10 ${s.lbl} text-amber-100/80`}>
        {label || (count === 1 ? "подарок" : "подарка")}
      </span>

      {/* CSS-anim styles. Локально, чтобы не плодить в index.css. */}
      <style>{`
        .gift-badge-bg {
          background: linear-gradient(135deg, rgba(168,85,247,0.35), rgba(236,72,153,0.30) 50%, rgba(245,158,11,0.35));
          border: 1px solid rgba(252,211,77,0.45);
          box-shadow: 0 0 12px rgba(252,211,77,0.18), inset 0 0 8px rgba(255,255,255,0.06);
        }
        .gift-badge-glow {
          background: radial-gradient(circle at 30% 30%, rgba(252,211,77,0.5), transparent 70%);
          animation: gb-pulse 3s ease-in-out infinite;
        }
        @keyframes gb-pulse {
          0%, 100% { opacity: 0.4; transform: scale(1); }
          50% { opacity: 0.7; transform: scale(1.08); }
        }
        .gift-spark-1 { animation: gb-spark 2.2s ease-in-out infinite; }
        .gift-spark-2 { animation: gb-spark 2.8s ease-in-out infinite 0.6s; }
        .gift-spark-3 { animation: gb-spark 2.5s ease-in-out infinite 1.2s; }
        @keyframes gb-spark {
          0%, 100% { opacity: 0.2; transform: scale(0.6) rotate(0deg); }
          50% { opacity: 1; transform: scale(1.2) rotate(180deg); }
        }
      `}</style>
    </span>
  );
}
