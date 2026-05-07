// Дизайнерский студийный микрофон + мини-эквалайзер.
// ТЗ Eugene 2026-05-07 13:06: «один вид везде». Используется на /music
// табе, в навбаре, в /admin Yandex-карточке, везде где раньше был Mic icon.

import type { CSSProperties } from "react";

interface StudioMicProps {
  size?: "xs" | "sm" | "md" | "lg";
  showEq?: boolean;
  animated?: boolean;       // эквалайзер пляшет если animated=true
  color?: string;           // tailwind color class для микрофона (default text-cyan-300)
  eqColor?: string;         // tailwind color class для баров (default bg-cyan-400)
  className?: string;
  style?: CSSProperties;
}

const SIZES = {
  xs: { mic: 14, eq: 12, gap: 4, bar: 2 },
  sm: { mic: 18, eq: 14, gap: 5, bar: 2.5 },
  md: { mic: 24, eq: 18, gap: 6, bar: 3 },
  lg: { mic: 32, eq: 24, gap: 8, bar: 4 },
};

export function StudioMicEq({
  size = "md",
  showEq = true,
  animated = true,
  color = "text-cyan-300",
  eqColor = "bg-cyan-400",
  className = "",
  style,
}: StudioMicProps) {
  const s = SIZES[size];
  return (
    <span className={`inline-flex items-end ${className}`} style={{ gap: s.gap, ...style }} aria-hidden>
      {/* Дизайнерский студийный микрофон (Shure-style dome on shock-mount) */}
      <svg width={s.mic} height={s.mic} viewBox="0 0 24 24" fill="none" className={`${color} drop-shadow`}>
        {/* Капсюль */}
        <path
          d="M9 3.5C9 2.67 9.67 2 10.5 2h3c.83 0 1.5.67 1.5 1.5v8c0 1.93-1.57 3.5-3.5 3.5h0C9.57 15 8 13.43 8 11.5v-8c0-.83.45-1.5 1-1.5z"
          fill="currentColor" opacity="0.95"
        />
        {/* Решётка-сетка (полосы) */}
        <line x1="9.5" y1="5" x2="14.5" y2="5" stroke="rgba(0,0,0,0.35)" strokeWidth="0.5" />
        <line x1="9.5" y1="7" x2="14.5" y2="7" stroke="rgba(0,0,0,0.35)" strokeWidth="0.5" />
        <line x1="9.5" y1="9" x2="14.5" y2="9" stroke="rgba(0,0,0,0.35)" strokeWidth="0.5" />
        <line x1="9.5" y1="11" x2="14.5" y2="11" stroke="rgba(0,0,0,0.35)" strokeWidth="0.5" />
        {/* Дужка / shock-mount */}
        <path
          d="M5.5 11.5c0 3.59 2.91 6.5 6.5 6.5s6.5-2.91 6.5-6.5"
          stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" fill="none" opacity="0.9"
        />
        {/* Стойка */}
        <line x1="12" y1="18" x2="12" y2="21.5" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" opacity="0.9" />
        <line x1="9" y1="21.5" x2="15" y2="21.5" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" opacity="0.9" />
      </svg>

      {showEq && (
        <span className="flex items-end" style={{ height: s.eq, gap: 2 }}>
          {[60, 100, 80, 45].map((h, i) => (
            <span
              key={i}
              className={`${eqColor} rounded-sm`}
              style={{
                width: s.bar,
                height: `${h}%`,
                animation: animated ? `studio-eq-${i} 0.${6 + i * 2}s ease-in-out infinite` : undefined,
                opacity: 0.85 - i * 0.1,
              }}
            />
          ))}
          <style>{`
            @keyframes studio-eq-0 { 0%,100%{height:60%}50%{height:25%} }
            @keyframes studio-eq-1 { 0%,100%{height:100%}50%{height:55%} }
            @keyframes studio-eq-2 { 0%,100%{height:80%}50%{height:30%} }
            @keyframes studio-eq-3 { 0%,100%{height:45%}50%{height:90%} }
          `}</style>
        </span>
      )}
    </span>
  );
}
