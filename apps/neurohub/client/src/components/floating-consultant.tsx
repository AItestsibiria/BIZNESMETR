// FloatingConsultant (Eugene 2026-05-11): блондинка стройная с длинными
// ногами, медленный танец, tooltip-облачко в форме музыкальной ноты,
// полупрозрачное — сквозь видно фон страницы.

import { useState } from "react";

export function FloatingConsultant() {
  const [hovered, setHovered] = useState(false);
  if (typeof window === "undefined") return null;

  return (
    <div
      className="fixed z-30 bottom-4 right-4 sm:bottom-6 sm:right-6 pointer-events-none"
      data-testid="floating-consultant"
    >
      <div className="relative consultant-dance pointer-events-auto">
        {/* Облачко-нота — полупрозрачное, сквозь видно сайт */}
        {hovered && (
          <div className="absolute bottom-full right-0 mb-2 w-64 animate-in fade-in slide-in-from-bottom-2 duration-200">
            <svg viewBox="0 0 260 140" className="w-full h-auto">
              <defs>
                <filter id="noteBlur" x="-10%" y="-10%" width="120%" height="120%">
                  <feGaussianBlur in="SourceGraphic" stdDeviation="0.4" />
                </filter>
              </defs>
              {/* Cloud body — note-shape: rounded head + tail */}
              <path
                d="M 30 30 Q 30 12 60 12 L 200 12 Q 230 12 230 30 Q 245 35 245 55 Q 245 85 220 90
                   L 220 110 Q 220 130 200 130 Q 195 130 192 122
                   Q 188 132 175 132 Q 160 132 158 118 Q 158 108 168 105
                   L 195 96 L 195 85 L 80 85 Q 35 85 30 60 Q 22 55 22 45 Q 22 35 30 30 Z"
                fill="rgba(255,255,255,0.08)"
                stroke="rgba(167,139,250,0.5)"
                strokeWidth="0.8"
                filter="url(#noteBlur)"
              />
            </svg>
            {/* Контент поверх SVG */}
            <div className="absolute inset-0 p-4 pt-3 pr-5 flex flex-col justify-start backdrop-blur-md rounded-2xl">
              <div className="text-xs font-display tracking-wide text-white mb-1">
                Привет! Я тут чтобы помочь 🎵
              </div>
              <div className="text-[10px] text-white/80 mb-2 leading-relaxed">
                Цены, шаблоны, режимы — отвечу в Telegram.
              </div>
              <a
                href="https://t.me/Muziaipodari_bot"
                target="_blank"
                rel="noopener noreferrer"
                className="self-start text-[11px] px-3 py-1 rounded-full bg-gradient-to-r from-purple-500/40 to-cyan-500/30 hover:from-purple-500/60 hover:to-cyan-500/50 border border-white/20 text-white font-medium transition-all"
              >
                Открыть в Telegram →
              </a>
            </div>
          </div>
        )}

        <button
          type="button"
          onClick={() => setHovered(h => !h)}
          onMouseEnter={() => setHovered(true)}
          onMouseLeave={() => setHovered(false)}
          aria-label="Помощник MuziAi"
          className="block w-16 h-24 sm:w-20 sm:h-28 active:scale-95 transition-transform"
        >
          {/* Стройная блондинка с длинными ногами. viewBox 64x96 */}
          <svg viewBox="0 0 64 96" className="w-full h-full drop-shadow-[0_0_18px_rgba(255,200,150,0.4)]" aria-hidden="true">
            <defs>
              <linearGradient id="blondHair" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor="#fde68a" />
                <stop offset="60%" stopColor="#fbbf24" />
                <stop offset="100%" stopColor="#f59e0b" />
              </linearGradient>
              <linearGradient id="dressG" x1="0" y1="0" x2="1" y2="1">
                <stop offset="0%" stopColor="#a78bfa" />
                <stop offset="50%" stopColor="#60a5fa" />
                <stop offset="100%" stopColor="#22d3ee" />
              </linearGradient>
              <radialGradient id="glowG" cx="50%" cy="40%" r="55%">
                <stop offset="0%" stopColor="rgba(251,191,36,0.3)" />
                <stop offset="100%" stopColor="rgba(167,139,250,0)" />
              </radialGradient>
            </defs>

            {/* Подсветка/ореол */}
            <ellipse cx="32" cy="40" rx="30" ry="38" fill="url(#glowG)" />

            {/* Длинные волосы блонд за плечами */}
            <path
              d="M 17 20 Q 12 38 14 56 Q 16 64 20 62 Q 22 44 24 36 Q 22 28 20 20 Z
                 M 47 20 Q 52 38 50 56 Q 48 64 44 62 Q 42 44 40 36 Q 42 28 44 20 Z"
              fill="url(#blondHair)"
              opacity="0.95"
            />

            {/* Шея */}
            <rect x="29.5" y="32" width="5" height="6" rx="1.5" fill="#fef3c7" opacity="0.95" />

            {/* Лицо овальное */}
            <ellipse cx="32" cy="24" rx="8.5" ry="10.5" fill="#fef3c7" opacity="0.95" />

            {/* Чёлка / верх волос блонд */}
            <path
              d="M 23.5 17 Q 26 11 32 11 Q 38 11 40.5 17 Q 41.5 21 40.5 25 Q 38 20 32 20 Q 26 20 23.5 25 Q 22.5 21 23.5 17 Z"
              fill="url(#blondHair)"
            />

            {/* Глаза классические — голубые */}
            <ellipse cx="28.5" cy="24" rx="0.9" ry="1.3" fill="#0c4a6e" />
            <ellipse cx="35.5" cy="24" rx="0.9" ry="1.3" fill="#0c4a6e" />

            {/* Улыбка */}
            <path d="M 29 28.5 Q 32 30.2 35 28.5" stroke="#be185d" strokeWidth="0.8" fill="none" strokeLinecap="round" />

            {/* Серьги-нотки */}
            <circle cx="22.5" cy="27" r="0.7" fill="#fbbf24" />
            <circle cx="41.5" cy="27" r="0.7" fill="#fbbf24" />

            {/* Платье — короткое облегающее, расширяется чуть к низу */}
            <path
              d="M 23 39 L 41 39 L 44 60 Q 32 62 20 60 Z"
              fill="url(#dressG)"
              opacity="0.92"
            />

            {/* Пояс */}
            <rect x="22" y="49" width="20" height="1.5" fill="rgba(255,255,255,0.25)" />

            {/* Длинные стройные ноги */}
            <path d="M 25 60 Q 24 75 25 88 L 28 88 Q 28.5 75 28 60 Z" fill="#fef3c7" opacity="0.9" />
            <path d="M 36 60 Q 35.5 75 36 88 L 39 88 Q 40 75 39 60 Z" fill="#fef3c7" opacity="0.9" />

            {/* Туфельки */}
            <ellipse cx="26.5" cy="90" rx="2.5" ry="1.2" fill="#a78bfa" />
            <ellipse cx="37.5" cy="90" rx="2.5" ry="1.2" fill="#a78bfa" />

            {/* Руки */}
            <path d="M 22 41 Q 16 46 14 54 Q 13 58 15 60" stroke="#fef3c7" strokeWidth="2.2" fill="none" strokeLinecap="round" />
            <path d="M 42 41 Q 48 38 51 32 Q 52 28 50 26" stroke="#fef3c7" strokeWidth="2.2" fill="none" strokeLinecap="round" />

            {/* Музыкальные нотки рядом — стилизованные */}
            <g opacity="0.7">
              <circle cx="52" cy="14" r="1.2" fill="#a78bfa" />
              <line x1="53.2" y1="14" x2="53.2" y2="8" stroke="#a78bfa" strokeWidth="0.6" />
              <circle cx="10" cy="22" r="0.9" fill="#22d3ee" />
              <line x1="10.9" y1="22" x2="10.9" y2="17" stroke="#22d3ee" strokeWidth="0.5" />
            </g>
          </svg>
        </button>
      </div>
    </div>
  );
}
