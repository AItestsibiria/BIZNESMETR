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
          className="block w-6 h-10 sm:w-7 sm:h-11 active:scale-95 transition-transform opacity-90 hover:opacity-100 consultant-dance"
        >
          <svg viewBox="0 0 56 96" className="w-full h-full" aria-hidden="true">
            <defs>
              <linearGradient id="bizJacket" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor="rgba(99,102,241,0.95)" />
                <stop offset="100%" stopColor="rgba(67,56,202,0.92)" />
              </linearGradient>
              <linearGradient id="bizBlouse" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor="rgba(254,243,199,0.95)" />
                <stop offset="100%" stopColor="rgba(252,211,77,0.88)" />
              </linearGradient>
              <linearGradient id="bizHair" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor="rgba(120,80,40,0.85)" />
                <stop offset="100%" stopColor="rgba(96,60,28,0.80)" />
              </linearGradient>
            </defs>

            {/* Деловая стрижка боб до плеч */}
            <path
              d="M 17 14 Q 12 24 14 36 Q 16 40 19 38 L 19 24 Z
                 M 39 14 Q 44 24 42 36 Q 40 40 37 38 L 37 24 Z"
              fill="url(#bizHair)"
            />
            <path d="M 19 12 Q 28 8 37 12 Q 38 22 36 26 Q 28 18 20 26 Q 18 22 19 12 Z" fill="url(#bizHair)" />

            {/* Лицо — взрослое */}
            <ellipse cx="28" cy="22" rx="6" ry="8" fill="rgba(254,226,184,0.95)" />

            {/* Открытые глаза — взгляд вперёд (нейтральный, профессиональный) */}
            <circle cx="25.5" cy="22" r="0.7" fill="rgba(40,30,20,0.85)" />
            <circle cx="30.5" cy="22" r="0.7" fill="rgba(40,30,20,0.85)" />
            {/* Брови — тонкие, ровные */}
            <path d="M 24 20 Q 26 19.5 27 20" stroke="rgba(80,50,30,0.7)" strokeWidth="0.4" fill="none" strokeLinecap="round" />
            <path d="M 29 20 Q 30 19.5 32 20" stroke="rgba(80,50,30,0.7)" strokeWidth="0.4" fill="none" strokeLinecap="round" />

            {/* Лёгкая улыбка — закрытый рот (профессиональный) */}
            <path d="M 26.5 27 Q 28 27.5 29.5 27" stroke="rgba(180,60,80,0.7)" strokeWidth="0.5" fill="none" strokeLinecap="round" />

            {/* Серьги-точки (минимализм) */}
            <circle cx="22" cy="24" r="0.5" fill="rgba(167,139,250,0.85)" />
            <circle cx="34" cy="24" r="0.5" fill="rgba(167,139,250,0.85)" />

            {/* Шея */}
            <rect x="25.5" y="29" width="5" height="4" rx="1" fill="rgba(254,226,184,0.95)" />

            {/* Блузка под пиджаком — V-образный вырез */}
            <path d="M 22 33 L 28 39 L 34 33 L 34 44 L 22 44 Z" fill="url(#bizBlouse)" />

            {/* Деловой пиджак — лацканы, плечи, талия */}
            <path d="M 18 33 L 22 33 L 28 41 L 34 33 L 38 33 L 40 58 L 16 58 Z" fill="url(#bizJacket)" />
            {/* Лацканы — треугольные */}
            <path d="M 22 33 L 22 42 L 28 41 Z" fill="rgba(67,56,202,0.99)" />
            <path d="M 34 33 L 34 42 L 28 41 Z" fill="rgba(67,56,202,0.99)" />
            {/* Пуговицы пиджака */}
            <circle cx="28" cy="48" r="0.7" fill="rgba(180,180,200,0.9)" />
            <circle cx="28" cy="53" r="0.7" fill="rgba(180,180,200,0.9)" />

            {/* Юбка-карандаш — прямая, строгая */}
            <path d="M 19 58 L 37 58 L 35 86 L 21 86 Z" fill="rgba(67,56,202,0.92)" />

            {/* Ноги */}
            <rect x="22" y="86" width="4" height="6" fill="rgba(254,226,184,0.95)" />
            <rect x="30" y="86" width="4" height="6" fill="rgba(254,226,184,0.95)" />

            {/* Туфли-лодочки на низком каблуке */}
            <ellipse cx="24" cy="93" rx="3" ry="1.5" fill="rgba(40,30,60,0.95)" />
            <ellipse cx="32" cy="93" rx="3" ry="1.5" fill="rgba(40,30,60,0.95)" />

            {/* Левая рука — опущена вдоль тела */}
            <path d="M 18 36 Q 16 48 17 60" stroke="url(#bizJacket)" strokeWidth="3.5" fill="none" strokeLinecap="round" />

            {/* Правая рука — держит планшет на уровне талии */}
            <path d="M 38 36 Q 40 48 36 56" stroke="url(#bizJacket)" strokeWidth="3.5" fill="none" strokeLinecap="round" />

            {/* Планшет в руке */}
            <rect x="30" y="52" width="10" height="8" rx="0.8" fill="rgba(40,40,60,0.95)" />
            <rect x="31" y="53" width="8" height="6" rx="0.3" fill="rgba(99,102,241,0.6)" />
            {/* Нота на экране планшета — связь с MuziAi */}
            <circle cx="33" cy="57" r="0.7" fill="#a78bfa" />
            <line x1="33.6" y1="57" x2="33.6" y2="54.5" stroke="#a78bfa" strokeWidth="0.3" />

            {/* Одна акцентная нота справа сверху — единственный намёк на музыку */}
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
