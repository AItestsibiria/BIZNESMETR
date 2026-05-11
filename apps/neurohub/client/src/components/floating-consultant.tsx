// FloatingConsultant (Eugene 2026-05-11 v2): casual девушка 25-30,
// тихое появление справа через 2.5 сек после загрузки страницы.
// Hover → мини-подсказка («Помогу?»). Click → выбор чатов.
// Dismiss → исчезает; возвращается через 60 сек если юзер не закрыл 3 раза.

import { useEffect, useRef, useState } from "react";

const REAPPEAR_MS = 60_000;
const APPEAR_DELAY_MS = 2500;
const MAX_DISMISS = 3;
const SS_KEY = "_helperDismissed";

export function FloatingConsultant() {
  const [visible, setVisible] = useState(false);
  const [exiting, setExiting] = useState(false);
  const [hovered, setHovered] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const dismissedRef = useRef(0);
  const timerRef = useRef<number | null>(null);

  useEffect(() => {
    if (typeof window === "undefined") return;
    try {
      const saved = Number(sessionStorage.getItem(SS_KEY) || "0");
      dismissedRef.current = saved;
      if (saved >= MAX_DISMISS) return; // юзер сказал хватит на эту сессию
    } catch {}
    timerRef.current = window.setTimeout(() => setVisible(true), APPEAR_DELAY_MS);
    return () => { if (timerRef.current) window.clearTimeout(timerRef.current); };
  }, []);

  const dismiss = () => {
    setExiting(true);
    window.setTimeout(() => {
      setVisible(false);
      setExiting(false);
      setExpanded(false);
      dismissedRef.current += 1;
      try { sessionStorage.setItem(SS_KEY, String(dismissedRef.current)); } catch {}
      if (dismissedRef.current < MAX_DISMISS) {
        timerRef.current = window.setTimeout(() => {
          setVisible(true);
        }, REAPPEAR_MS);
      }
    }, 350);
  };

  if (!visible) return null;

  return (
    <div
      className={`fixed z-30 bottom-3 right-3 sm:bottom-4 sm:right-4 ${exiting ? "consultant-slide-out" : "consultant-slide-in"}`}
      data-testid="floating-consultant"
    >
      <div className="relative">
        {/* Compact tooltip — 2-3 слова, очень прозрачное */}
        {hovered && !expanded && (
          <div className="absolute bottom-full right-0 mb-1.5 px-2.5 py-1 rounded-full bg-white/[0.07] backdrop-blur-md border border-white/15 text-[10px] text-white/85 whitespace-nowrap animate-in fade-in slide-in-from-bottom-1 duration-150">
            Чем помочь? 🎵
          </div>
        )}

        {/* Expanded chat selector — выбор канала */}
        {expanded && (
          <div className="absolute bottom-full right-0 mb-2 w-44 p-2 rounded-xl bg-background/40 backdrop-blur-xl border border-white/10 animate-in fade-in slide-in-from-bottom-2 duration-200 shadow-lg">
            <div className="text-[10px] text-white/60 mb-1.5 px-1">Где удобнее общаться</div>
            <a
              href="https://t.me/Muziaipodari_bot"
              target="_blank"
              rel="noopener noreferrer"
              className="flex items-center gap-2 px-2 py-1.5 rounded-lg hover:bg-white/[0.06] transition-colors text-[12px] text-white/90"
            >
              <span>📱</span> Telegram
            </a>
            <button
              type="button"
              onClick={() => { window.location.hash = "#/music"; }}
              className="w-full flex items-center gap-2 px-2 py-1.5 rounded-lg hover:bg-white/[0.06] transition-colors text-[12px] text-white/90 text-left"
            >
              <span>🎵</span> Создать песню
            </button>
            <button
              type="button"
              onClick={dismiss}
              className="w-full mt-1 px-2 py-1 rounded-lg text-[10px] text-white/50 hover:text-white/80 transition-colors"
            >
              Скрыть
            </button>
          </div>
        )}

        {/* Силуэт casual девушки 25-30, spокойные тона, малозаметная */}
        <button
          type="button"
          onClick={() => setExpanded(e => !e)}
          onMouseEnter={() => setHovered(true)}
          onMouseLeave={() => setHovered(false)}
          aria-label="Помощник"
          className="block w-11 h-16 sm:w-12 sm:h-[70px] active:scale-95 transition-transform opacity-90 hover:opacity-100"
        >
          <svg viewBox="0 0 48 80" className="w-full h-full" aria-hidden="true">
            <defs>
              <linearGradient id="cAura" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor="rgba(167,139,250,0.15)" />
                <stop offset="100%" stopColor="rgba(34,211,238,0.05)" />
              </linearGradient>
              <linearGradient id="cHair" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor="#d4a574" />
                <stop offset="100%" stopColor="#a67852" />
              </linearGradient>
              <linearGradient id="cSweater" x1="0" y1="0" x2="1" y2="1">
                <stop offset="0%" stopColor="#7c3aed" stopOpacity="0.7" />
                <stop offset="100%" stopColor="#22d3ee" stopOpacity="0.5" />
              </linearGradient>
            </defs>
            {/* Soft аура — почти невидимая */}
            <ellipse cx="24" cy="40" rx="22" ry="36" fill="url(#cAura)" />
            {/* Длинные волосы (ниже плеч) */}
            <path
              d="M 13 22 Q 9 38 11 56 Q 13 64 17 62 Q 19 44 21 36 Q 19 28 17 22 Z
                 M 35 22 Q 39 38 37 56 Q 35 64 31 62 Q 29 44 27 36 Q 29 28 31 22 Z"
              fill="url(#cHair)"
              opacity="0.92"
            />
            {/* Лицо */}
            <ellipse cx="24" cy="22" rx="7.5" ry="9.5" fill="#fde4d2" opacity="0.95" />
            {/* Чёлка набок (взрослый стиль) */}
            <path d="M 17 16 Q 19 11 26 11 Q 32 12 32 17 Q 27 16 23 19 Q 20 19 17 16 Z" fill="url(#cHair)" />
            {/* Глаза с лёгким макияжем */}
            <ellipse cx="21" cy="22" rx="0.8" ry="1.1" fill="#3a2418" />
            <ellipse cx="27" cy="22" rx="0.8" ry="1.1" fill="#3a2418" />
            {/* Лёгкая улыбка */}
            <path d="M 22 26 Q 24 27.4 26 26" stroke="#9d2449" strokeWidth="0.7" fill="none" strokeLinecap="round" />
            {/* Серьги */}
            <circle cx="16.5" cy="24.5" r="0.6" fill="#a78bfa" opacity="0.8" />
            <circle cx="31.5" cy="24.5" r="0.6" fill="#a78bfa" opacity="0.8" />
            {/* Шея */}
            <rect x="22" y="30" width="4" height="4" rx="1" fill="#fde4d2" opacity="0.9" />
            {/* Casual свитер (тонкий gradient — не кричит) */}
            <path d="M 16 35 L 32 35 L 35 56 Q 24 58 13 56 Z" fill="url(#cSweater)" />
            {/* Руки сложены / расслаблены */}
            <path d="M 15 38 Q 12 46 13 54" stroke="#fde4d2" strokeWidth="2" fill="none" strokeLinecap="round" opacity="0.85" />
            <path d="M 33 38 Q 36 46 35 54" stroke="#fde4d2" strokeWidth="2" fill="none" strokeLinecap="round" opacity="0.85" />
            {/* Джинсы */}
            <rect x="16" y="56" width="6" height="20" rx="1" fill="#475569" opacity="0.85" />
            <rect x="26" y="56" width="6" height="20" rx="1" fill="#475569" opacity="0.85" />
            {/* Маленькая нота — едва заметный аксессуар */}
            <circle cx="24" cy="48" r="0.8" fill="#fbbf24" opacity="0.7" />
          </svg>
        </button>
      </div>
    </div>
  );
}
