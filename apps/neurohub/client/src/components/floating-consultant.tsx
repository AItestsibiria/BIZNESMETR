// FloatingConsultant (Eugene 2026-05-11): красивая девушка-консультант в
// правом нижнем углу всех страниц. Медленный танец, cosmic-стиль MuziAi.
// Клик → ссылка на @Muziaipodari_bot.

import { useState } from "react";

export function FloatingConsultant() {
  const [hovered, setHovered] = useState(false);
  const [dismissed, setDismissed] = useState(false);
  if (dismissed) return null;

  return (
    <div
      className="fixed z-30 bottom-4 right-4 sm:bottom-6 sm:right-6 pointer-events-none"
      data-testid="floating-consultant"
    >
      <div className="relative consultant-dance pointer-events-auto">
        {/* Tooltip card */}
        {hovered && (
          <div className="absolute bottom-full right-0 mb-3 w-56 p-3 rounded-2xl bg-background/90 backdrop-blur-xl border border-purple-500/30 shadow-[0_8px_32px_rgba(139,92,246,0.25)] animate-in fade-in slide-in-from-bottom-2 duration-200">
            <div className="text-xs font-display tracking-wide text-white mb-1">
              Привет! Я тут чтобы помочь 🎵
            </div>
            <div className="text-[10px] text-muted-foreground mb-2 leading-relaxed">
              Спроси про режимы, цены или шаблоны — отвечу в Telegram.
            </div>
            <a
              href="https://t.me/Muziaipodari_bot"
              target="_blank"
              rel="noopener noreferrer"
              className="block w-full text-center text-[11px] py-1.5 rounded-lg bg-gradient-to-r from-purple-500/30 to-cyan-500/25 hover:from-purple-500/50 hover:to-cyan-500/40 border border-white/15 text-white font-medium transition-all"
            >
              Открыть в Telegram →
            </a>
          </div>
        )}

        <button
          type="button"
          onClick={() => setHovered(h => !h)}
          onMouseEnter={() => setHovered(true)}
          onMouseLeave={() => setHovered(false)}
          aria-label="Помощник MuziAi"
          className="block w-14 h-14 sm:w-16 sm:h-16 active:scale-95 transition-transform"
        >
          {/* Stylized девушка-силуэт с cosmic gradient.
              SVG viewBox 64x80 — высокое overall portrait. */}
          <svg viewBox="0 0 64 80" className="w-full h-full drop-shadow-[0_0_18px_rgba(139,92,246,0.45)]" aria-hidden="true">
            <defs>
              <linearGradient id="hairG" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor="#7c3aed" />
                <stop offset="100%" stopColor="#3b82f6" />
              </linearGradient>
              <linearGradient id="dressG" x1="0" y1="0" x2="1" y2="1">
                <stop offset="0%" stopColor="#a78bfa" />
                <stop offset="50%" stopColor="#60a5fa" />
                <stop offset="100%" stopColor="#22d3ee" />
              </linearGradient>
              <radialGradient id="glowG" cx="50%" cy="50%" r="50%">
                <stop offset="0%" stopColor="rgba(167,139,250,0.4)" />
                <stop offset="100%" stopColor="rgba(167,139,250,0)" />
              </radialGradient>
            </defs>

            {/* Подсветка/ореол */}
            <circle cx="32" cy="40" r="30" fill="url(#glowG)" />

            {/* Длинные волосы (за головой и плечами) */}
            <path
              d="M 18 22 Q 14 36 16 56 Q 18 64 22 62 Q 24 44 26 36 Q 24 28 22 22 Z M 46 22 Q 50 36 48 56 Q 46 64 42 62 Q 40 44 38 36 Q 40 28 42 22 Z"
              fill="url(#hairG)"
              opacity="0.95"
            />

            {/* Платье (трапеция от плеч) */}
            <path
              d="M 22 42 L 42 42 L 50 70 Q 32 74 14 70 Z"
              fill="url(#dressG)"
              opacity="0.92"
            />

            {/* Шея */}
            <rect x="29" y="32" width="6" height="6" rx="1.5" fill="#fde68a" opacity="0.85" />

            {/* Лицо овальное */}
            <ellipse cx="32" cy="24" rx="9" ry="11" fill="#fef3c7" opacity="0.92" />

            {/* Чёлка / верх волос */}
            <path
              d="M 23 18 Q 26 12 32 12 Q 38 12 41 18 Q 42 22 41 26 Q 38 21 32 21 Q 26 21 23 26 Q 22 22 23 18 Z"
              fill="url(#hairG)"
            />

            {/* Глаза */}
            <ellipse cx="28" cy="24" rx="0.9" ry="1.4" fill="#0f172a" />
            <ellipse cx="36" cy="24" rx="0.9" ry="1.4" fill="#0f172a" />

            {/* Улыбка */}
            <path d="M 29 28.5 Q 32 30.2 35 28.5" stroke="#9d174d" strokeWidth="0.9" fill="none" strokeLinecap="round" />

            {/* Серьги — маленькие звёздочки (MuziAi cosmic) */}
            <circle cx="22.5" cy="27" r="0.9" fill="#22d3ee" />
            <circle cx="41.5" cy="27" r="0.9" fill="#22d3ee" />

            {/* Колье / медальон в форме музыкальной ноты */}
            <circle cx="32" cy="42" r="1.4" fill="#fbbf24" />

            {/* Руки в позе «приветствия / танца» */}
            <path d="M 20 45 Q 14 48 12 54 Q 11 58 13 60" stroke="url(#dressG)" strokeWidth="2.4" fill="none" strokeLinecap="round" />
            <path d="M 44 45 Q 50 42 53 38 Q 54 35 52 33" stroke="url(#dressG)" strokeWidth="2.4" fill="none" strokeLinecap="round" />

            {/* Cosmic пылинки сверху (типа на голову сыпется свет) */}
            <circle cx="20" cy="10" r="0.7" fill="#a78bfa" opacity="0.7" />
            <circle cx="48" cy="12" r="0.5" fill="#22d3ee" opacity="0.7" />
            <circle cx="14" cy="20" r="0.5" fill="#7c3aed" opacity="0.6" />
          </svg>
        </button>
      </div>
    </div>
  );
}
