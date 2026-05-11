// FloatingConsultant (Eugene 2026-05-11 v3): силуэт взрослой певицы
// 25-30 с микрофоном, в нежных фирменных цветах MuziAi (pastel
// purple/blue/cyan). Slide-in справа, hover - 2-3 слова, click - меню.

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
      if (saved >= MAX_DISMISS) return;
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
        {/* Compact tooltip */}
        {hovered && !expanded && (
          <div className="absolute bottom-full right-0 mb-1.5 px-2.5 py-1 rounded-full bg-white/[0.07] backdrop-blur-md border border-white/15 text-[10px] text-white/85 whitespace-nowrap animate-in fade-in slide-in-from-bottom-1 duration-150">
            Чем помочь? 🎵
          </div>
        )}

        {/* Expanded меню */}
        {expanded && (
          <div className="absolute bottom-full right-0 mb-2 w-44 p-2 rounded-xl bg-background/40 backdrop-blur-xl border border-white/10 animate-in fade-in slide-in-from-bottom-2 duration-200 shadow-lg">
            <div className="text-[10px] text-white/60 mb-1.5 px-1">Чем помочь?</div>
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
              onClick={() => { window.location.hash = "#/register"; }}
              className="w-full flex items-center gap-2 px-2 py-1.5 rounded-lg hover:bg-white/[0.06] transition-colors text-[12px] text-white/90 text-left"
            >
              <span>🎁</span> Регистрация
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

        {/* Силуэт взрослой певицы с микрофоном.
            Минимум деталей лица, акцент на pose певицы.
            Pastel MuziAi gradient. */}
        <button
          type="button"
          onClick={() => setExpanded(e => !e)}
          onMouseEnter={() => setHovered(true)}
          onMouseLeave={() => setHovered(false)}
          aria-label="Помощник"
          className="block w-12 h-20 sm:w-14 sm:h-24 active:scale-95 transition-transform opacity-95 hover:opacity-100 consultant-dance"
        >
          <svg viewBox="0 0 56 96" className="w-full h-full" aria-hidden="true">
            <defs>
              <linearGradient id="singerSilhouette" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor="rgba(196,181,253,0.85)" />
                <stop offset="50%" stopColor="rgba(147,197,253,0.80)" />
                <stop offset="100%" stopColor="rgba(165,243,252,0.75)" />
              </linearGradient>
              <linearGradient id="singerHair" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor="rgba(167,139,250,0.55)" />
                <stop offset="100%" stopColor="rgba(96,165,250,0.45)" />
              </linearGradient>
              <radialGradient id="stageGlow" cx="50%" cy="60%" r="60%">
                <stop offset="0%" stopColor="rgba(167,139,250,0.18)" />
                <stop offset="100%" stopColor="rgba(167,139,250,0)" />
              </radialGradient>
            </defs>
            {/* Stage glow — нежный ореол */}
            <ellipse cx="28" cy="55" rx="26" ry="42" fill="url(#stageGlow)" />

            {/* Длинные волосы за плечами (свободно, без косичек) */}
            <path
              d="M 14 28 Q 8 50 12 70 Q 16 76 20 72 Q 22 50 24 38 Z
                 M 42 28 Q 48 50 44 70 Q 40 76 36 72 Q 34 50 32 38 Z"
              fill="url(#singerHair)"
            />

            {/* Лицо — взрослое овальное (без детских щёк), минимум черт */}
            <ellipse cx="28" cy="22" rx="6.5" ry="9" fill="rgba(254,243,199,0.85)" />

            {/* Чёлка набок — асимметричная, взрослый стиль */}
            <path d="M 21 16 Q 26 12 33 13 Q 35 18 33 22 Q 28 18 24 21 Q 21 20 21 16 Z" fill="url(#singerHair)" />

            {/* Закрытые глаза — поющая (увлечена музыкой) */}
            <path d="M 24 22 Q 25 21 26 22" stroke="rgba(50,30,20,0.7)" strokeWidth="0.5" fill="none" strokeLinecap="round" />
            <path d="M 30 22 Q 31 21 32 22" stroke="rgba(50,30,20,0.7)" strokeWidth="0.5" fill="none" strokeLinecap="round" />

            {/* Поющий рот — приоткрыт */}
            <ellipse cx="28" cy="27" rx="1.2" ry="0.8" fill="rgba(190,30,90,0.6)" />

            {/* Серёжки — длинные нотные капли */}
            <path d="M 21 25 L 21 28" stroke="rgba(167,139,250,0.7)" strokeWidth="0.5" />
            <circle cx="21" cy="29" r="0.7" fill="rgba(167,139,250,0.7)" />
            <path d="M 35 25 L 35 28" stroke="rgba(167,139,250,0.7)" strokeWidth="0.5" />
            <circle cx="35" cy="29" r="0.7" fill="rgba(167,139,250,0.7)" />

            {/* Шея */}
            <rect x="25.5" y="30" width="5" height="5" rx="1.5" fill="rgba(254,243,199,0.85)" />

            {/* Силуэт фигуры — деловой/сценический верх + узкие брюки */}
            <path d="M 17 36 Q 14 44 16 56 L 22 56 L 22 40 Z M 39 36 Q 42 44 40 56 L 34 56 L 34 40 Z" fill="url(#singerSilhouette)" opacity="0.88" />
            {/* Корпус */}
            <path d="M 20 35 L 36 35 L 38 60 Q 28 62 18 60 Z" fill="url(#singerSilhouette)" />
            {/* Брюки/юбка узкая */}
            <path d="M 22 60 Q 20 78 22 90 L 27 90 L 27 60 Z" fill="rgba(76,29,149,0.7)" />
            <path d="M 34 60 Q 36 78 34 90 L 29 90 L 29 60 Z" fill="rgba(76,29,149,0.7)" />

            {/* Левая рука прижата к корпусу */}
            <path d="M 18 38 Q 16 48 17 58" stroke="url(#singerSilhouette)" strokeWidth="3" fill="none" strokeLinecap="round" />

            {/* Правая рука держит микрофон — поднята к лицу */}
            <path d="M 38 38 Q 42 32 44 28 Q 45 26 43 25" stroke="rgba(196,181,253,0.85)" strokeWidth="2.8" fill="none" strokeLinecap="round" />

            {/* Микрофон у лица */}
            <ellipse cx="38" cy="26" rx="2.2" ry="3" fill="rgba(50,50,60,0.85)" />
            <line x1="38" y1="29" x2="38" y2="34" stroke="rgba(50,50,60,0.85)" strokeWidth="1.4" strokeLinecap="round" />
            {/* Решётка микрофона */}
            <line x1="36.2" y1="25" x2="39.8" y2="25" stroke="rgba(196,181,253,0.6)" strokeWidth="0.4" />
            <line x1="36.2" y1="26.5" x2="39.8" y2="26.5" stroke="rgba(196,181,253,0.6)" strokeWidth="0.4" />

            {/* Туфли */}
            <ellipse cx="24" cy="92" rx="2.5" ry="1.2" fill="rgba(76,29,149,0.85)" />
            <ellipse cx="32" cy="92" rx="2.5" ry="1.2" fill="rgba(76,29,149,0.85)" />

            {/* Ноты вокруг — лёгкое сценическое настроение */}
            <g opacity="0.65">
              <circle cx="50" cy="14" r="1" fill="#a78bfa" />
              <line x1="51" y1="14" x2="51" y2="9" stroke="#a78bfa" strokeWidth="0.5" />
              <circle cx="6" cy="20" r="0.8" fill="#22d3ee" />
              <line x1="6.8" y1="20" x2="6.8" y2="16" stroke="#22d3ee" strokeWidth="0.4" />
              <circle cx="48" cy="48" r="0.7" fill="#60a5fa" />
            </g>
          </svg>
        </button>
      </div>
    </div>
  );
}
