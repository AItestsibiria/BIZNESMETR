// FloatingConsultant (Eugene 2026-05-11 v4): деловой стиль —
// менеджер 25-30 в пиджаке, с планшетом (намёк на работу/консультацию).
// Pastel MuziAi gradient. Открытые глаза, закрытый рот, прямая осанка.
// Минимум нот вокруг (1 акцентная) — для связи с музыкой.

import { useEffect, useRef, useState } from "react";

const REAPPEAR_MS = 60_000;
const APPEAR_DELAY_MS = 2500;
const MAX_DISMISS = 3;
const SS_KEY = "_helperDismissed";

// Eugene 2026-05-11: трекинг вовлечения. POST /api/engagement/track
// для admin-дашборда (📊 Воронка). Не блокирует UI — fire-and-forget.
function trackEngagement(
  event: "consultant_impression" | "consultant_open" | "consultant_action",
  meta?: Record<string, any>
) {
  try {
    let sid = sessionStorage.getItem("_engagementSid");
    if (!sid) { sid = Math.random().toString(36).slice(2, 14); sessionStorage.setItem("_engagementSid", sid); }
    fetch("/api/engagement/track", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ event, sessionId: sid, meta }),
      keepalive: true,
    }).catch(() => {});
  } catch {}
}

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
    timerRef.current = window.setTimeout(() => {
      setVisible(true);
      trackEngagement("consultant_impression");
    }, APPEAR_DELAY_MS);
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

        {/* Expanded — простое меню без новостей */}
        {expanded && (
          <div className="absolute bottom-full right-0 mb-2 w-44 p-2 rounded-xl bg-background/40 backdrop-blur-xl border border-white/10 animate-in fade-in slide-in-from-bottom-2 duration-200 shadow-lg">
            <div className="text-[10px] text-white/60 mb-1.5 px-1">Чем помочь?</div>
            <a
              href="https://t.me/Muziaipodari_bot"
              target="_blank"
              rel="noopener noreferrer"
              onClick={() => trackEngagement("consultant_action", { action: "telegram" })}
              className="flex items-center gap-2 px-2 py-1.5 rounded-lg hover:bg-white/[0.06] transition-colors text-[12px] text-white/90"
            >
              <span>📱</span> Telegram
            </a>
            <a
              href="https://max.ru/id7017236261_1_bot"
              target="_blank"
              rel="noopener noreferrer"
              onClick={() => trackEngagement("consultant_action", { action: "max" })}
              className="flex items-center gap-2 px-2 py-1.5 rounded-lg hover:bg-white/[0.06] transition-colors text-[12px] text-white/90"
            >
              <span>💬</span> Max
            </a>
            <button
              type="button"
              onClick={() => { trackEngagement("consultant_action", { action: "music" }); window.location.hash = "#/music"; }}
              className="w-full flex items-center gap-2 px-2 py-1.5 rounded-lg hover:bg-white/[0.06] transition-colors text-[12px] text-white/90 text-left"
            >
              <span>🎵</span> Создать песню
            </button>
            <button
              type="button"
              onClick={() => { trackEngagement("consultant_action", { action: "register" }); window.location.hash = "#/register"; }}
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
          onClick={() => setExpanded(e => { const next = !e; if (next) trackEngagement("consultant_open"); return next; })}
          onMouseEnter={() => setHovered(true)}
          onMouseLeave={() => setHovered(false)}
          aria-label="Помощник"
          className="block w-16 h-28 sm:w-20 sm:h-32 active:scale-95 transition-transform opacity-90 hover:opacity-100 consultant-dance"
        >
          <svg viewBox="0 0 56 96" className="w-full h-full" aria-hidden="true">
            <defs>
              <linearGradient id="bizJacket" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor="rgba(196,181,253,0.95)" />
                <stop offset="100%" stopColor="rgba(147,197,253,0.92)" />
              </linearGradient>
              <linearGradient id="bizBlouse" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor="rgba(254,243,199,0.95)" />
                <stop offset="100%" stopColor="rgba(253,224,153,0.88)" />
              </linearGradient>
              <linearGradient id="bizHair" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor="rgba(196,181,253,0.95)" />
                <stop offset="100%" stopColor="rgba(96,165,250,0.92)" />
              </linearGradient>
              <linearGradient id="bizTrousers" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor="rgba(167,139,250,0.92)" />
                <stop offset="100%" stopColor="rgba(124,58,237,0.88)" />
              </linearGradient>
            </defs>

            {/* Каре — прямые волосы до подбородка, фирменные цвета MuziAi */}
            <path
              d="M 16 14 Q 11 24 13 34 Q 15 36 19 34 L 19 22 Z
                 M 40 14 Q 45 24 43 34 Q 41 36 37 34 L 37 22 Z"
              fill="url(#bizHair)"
            />
            <path d="M 18 11 Q 28 7 38 11 Q 39 22 36 26 Q 28 17 20 26 Q 17 22 18 11 Z" fill="url(#bizHair)" />

            {/* Лицо ~30 лет — взрослое овальное */}
            <ellipse cx="28" cy="22" rx="6" ry="8" fill="rgba(254,226,184,0.95)" />

            {/* Открытые глаза */}
            <circle cx="25.5" cy="22" r="0.7" fill="rgba(40,30,20,0.85)" />
            <circle cx="30.5" cy="22" r="0.7" fill="rgba(40,30,20,0.85)" />
            {/* Лёгкие морщинки у глаз — намёк на возраст ~30 */}
            <path d="M 23.5 22.5 Q 23 23 22.8 23.5" stroke="rgba(150,110,80,0.35)" strokeWidth="0.25" fill="none" strokeLinecap="round" />
            <path d="M 32.5 22.5 Q 33 23 33.2 23.5" stroke="rgba(150,110,80,0.35)" strokeWidth="0.25" fill="none" strokeLinecap="round" />
            {/* Брови — в тон волос (лавандовые) */}
            <path d="M 24 20 Q 26 19.5 27 20" stroke="rgba(139,92,246,0.7)" strokeWidth="0.4" fill="none" strokeLinecap="round" />
            <path d="M 29 20 Q 30 19.5 32 20" stroke="rgba(139,92,246,0.7)" strokeWidth="0.4" fill="none" strokeLinecap="round" />

            {/* Весёлая улыбка */}
            <path d="M 26 27 Q 28 28.5 30 27" stroke="rgba(180,60,80,0.85)" strokeWidth="0.6" fill="none" strokeLinecap="round" />
            {/* Розовые щёчки */}
            <circle cx="23" cy="25" r="0.9" fill="rgba(244,114,182,0.35)" />
            <circle cx="33" cy="25" r="0.9" fill="rgba(244,114,182,0.35)" />

            {/* Серьги-точки */}
            <circle cx="22" cy="24" r="0.5" fill="rgba(167,139,250,0.9)" />
            <circle cx="34" cy="24" r="0.5" fill="rgba(167,139,250,0.9)" />

            {/* Шея */}
            <rect x="25.5" y="29" width="5" height="4" rx="1" fill="rgba(254,226,184,0.95)" />

            {/* Блузка под жакетом — V-вырез */}
            <path d="M 22 33 L 28 39 L 34 33 L 34 45 L 22 45 Z" fill="url(#bizBlouse)" />

            {/* Полуделовой жакет — без жёстких лацканов, мягкая линия плеч.
                Открыт спереди, видна блузка. */}
            <path d="M 18 33 Q 16 35 16 38 L 17 58 L 22 58 L 22 36 Z" fill="url(#bizJacket)" />
            <path d="M 38 33 Q 40 35 40 38 L 39 58 L 34 58 L 34 36 Z" fill="url(#bizJacket)" />
            {/* Воротник-стойка вокруг шеи */}
            <path d="M 23 33 Q 28 31 33 33 L 33 36 L 23 36 Z" fill="url(#bizJacket)" opacity="0.7" />

            {/* Прямые брюки — полуделовой стиль вместо строгой юбки */}
            <path d="M 22 45 L 27 45 L 27 86 L 22 86 Z" fill="url(#bizTrousers)" />
            <path d="M 29 45 L 34 45 L 34 86 L 29 86 Z" fill="url(#bizTrousers)" />

            {/* Туфли — стильные мягкие */}
            <ellipse cx="24.5" cy="88" rx="3" ry="1.5" fill="rgba(76,29,149,0.85)" />
            <ellipse cx="31.5" cy="88" rx="3" ry="1.5" fill="rgba(76,29,149,0.85)" />

            {/* Левая рука — опущена */}
            <path d="M 18 36 Q 16 48 17 60" stroke="url(#bizJacket)" strokeWidth="3.5" fill="none" strokeLinecap="round" />

            {/* Правая рука — держит планшет */}
            <path d="M 38 36 Q 40 48 36 56" stroke="url(#bizJacket)" strokeWidth="3.5" fill="none" strokeLinecap="round" />

            {/* Планшет с нотой */}
            <rect x="30" y="52" width="10" height="8" rx="0.8" fill="rgba(40,40,60,0.95)" />
            <rect x="31" y="53" width="8" height="6" rx="0.3" fill="rgba(147,197,253,0.6)" />
            <circle cx="33" cy="57" r="0.7" fill="#a78bfa" />
            <line x1="33.6" y1="57" x2="33.6" y2="54.5" stroke="#a78bfa" strokeWidth="0.3" />

            {/* Акцентная нота справа сверху */}
            <g opacity="0.55">
              <circle cx="48" cy="20" r="0.9" fill="#a78bfa" />
              <line x1="48.8" y1="20" x2="48.8" y2="16" stroke="#a78bfa" strokeWidth="0.4" />
            </g>
          </svg>
        </button>
      </div>
    </div>
  );
}
