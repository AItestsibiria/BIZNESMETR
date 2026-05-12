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
              <linearGradient id="bizHair" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor="#c4b5fd" />
                <stop offset="100%" stopColor="#7c3aed" />
              </linearGradient>
              <linearGradient id="bizSkirt" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor="#60a5fa" />
                <stop offset="100%" stopColor="#1e40af" />
              </linearGradient>
            </defs>
            {/* Cartoon-стиль (Eugene 2026-05-12 — по референсу):
                каре с чёлкой / белая блузка с воротничком / юбка-карандаш
                с белым поясом / лодочки / выразительные глаза /
                в фирменных цветах MuziAi (purple/blue). */}

            {/* Каре — задний объём (за плечами) */}
            <path d="M 14 18 Q 11 30 13 42 Q 16 44 19 42 L 19 22 Z" fill="url(#bizHair)" />
            <path d="M 42 18 Q 45 30 43 42 Q 40 44 37 42 L 37 22 Z" fill="url(#bizHair)" />

            {/* Голова — крупная, cartoon-пропорции */}
            <ellipse cx="28" cy="22" rx="9" ry="10" fill="#fde6cb" stroke="#1f2937" strokeWidth="0.4" />

            {/* Чёлка набок — большая, прикрывает лоб */}
            <path d="M 19 14 Q 28 9 38 14 Q 39 18 37 22 Q 32 17 26 19 Q 22 18 20 22 Q 18 18 19 14 Z" fill="url(#bizHair)" stroke="#1f2937" strokeWidth="0.3" />

            {/* Большие выразительные глаза */}
            <ellipse cx="25" cy="22" rx="1.5" ry="2" fill="#fff" stroke="#1f2937" strokeWidth="0.3" />
            <ellipse cx="31" cy="22" rx="1.5" ry="2" fill="#fff" stroke="#1f2937" strokeWidth="0.3" />
            <circle cx="25" cy="22.3" r="0.9" fill="#1f2937" />
            <circle cx="31" cy="22.3" r="0.9" fill="#1f2937" />
            {/* Блик в глазу */}
            <circle cx="25.4" cy="21.8" r="0.3" fill="#fff" />
            <circle cx="31.4" cy="21.8" r="0.3" fill="#fff" />

            {/* Брови — тонкие, в тон волос */}
            <path d="M 23 19 Q 25 18.4 27 19" stroke="#7c3aed" strokeWidth="0.6" fill="none" strokeLinecap="round" />
            <path d="M 29 19 Q 31 18.4 33 19" stroke="#7c3aed" strokeWidth="0.6" fill="none" strokeLinecap="round" />

            {/* Розовые щёчки */}
            <circle cx="21" cy="26" r="1.1" fill="rgba(244,114,182,0.4)" />
            <circle cx="35" cy="26" r="1.1" fill="rgba(244,114,182,0.4)" />

            {/* Весёлая улыбка зубами */}
            <path d="M 25 27 Q 28 30 31 27" stroke="#1f2937" strokeWidth="0.5" fill="rgba(180,60,80,0.65)" strokeLinecap="round" />
            <path d="M 25.5 27.4 L 30.5 27.4" stroke="#fff" strokeWidth="0.5" />

            {/* Серьги — cyan акцент MuziAi */}
            <circle cx="19" cy="25" r="0.6" fill="#22d3ee" />
            <circle cx="37" cy="25" r="0.6" fill="#22d3ee" />

            {/* Шея */}
            <rect x="25.5" y="31" width="5" height="4" rx="1" fill="#fde6cb" stroke="#1f2937" strokeWidth="0.3" />

            {/* Белая блузка с воротничком */}
            <path d="M 18 35 Q 16 36 16 39 L 17 56 L 39 56 L 40 39 Q 40 36 38 35 L 32 35 L 28 38 L 24 35 Z"
                  fill="#ffffff" stroke="#1f2937" strokeWidth="0.4" />
            {/* Воротничок — белый с тёмной линией */}
            <path d="M 24 35 L 28 38 L 32 35 L 31 35.5 L 28 37 L 25 35.5 Z" fill="#f3f4f6" stroke="#1f2937" strokeWidth="0.3" />
            <path d="M 25 35 L 25 37.5" stroke="#1f2937" strokeWidth="0.25" />
            <path d="M 31 35 L 31 37.5" stroke="#1f2937" strokeWidth="0.25" />

            {/* Кнопка-пуговица на воротнике */}
            <circle cx="28" cy="40" r="0.5" fill="#a78bfa" />

            {/* Белый пояс на талии */}
            <rect x="17" y="54" width="22" height="3" fill="#ffffff" stroke="#1f2937" strokeWidth="0.3" />
            <rect x="27" y="54" width="2" height="3" fill="#7c3aed" />

            {/* Юбка-карандаш — фирменный синий gradient */}
            <path d="M 17 57 L 39 57 L 36 82 L 20 82 Z" fill="url(#bizSkirt)" stroke="#1f2937" strokeWidth="0.4" />

            {/* Ноги */}
            <rect x="22" y="82" width="3.5" height="8" fill="#fde6cb" stroke="#1f2937" strokeWidth="0.3" />
            <rect x="30.5" y="82" width="3.5" height="8" fill="#fde6cb" stroke="#1f2937" strokeWidth="0.3" />

            {/* Туфли-лодочки с каблучком */}
            <path d="M 21 90 Q 24 89 26 90 L 26 92 L 21 92 Z" fill="#1f2937" />
            <path d="M 30 90 Q 33 89 35 90 L 35 92 L 30 92 Z" fill="#1f2937" />
            <path d="M 25 92 L 26 94" stroke="#1f2937" strokeWidth="0.5" />
            <path d="M 31 92 L 30 94" stroke="#1f2937" strokeWidth="0.5" />

            {/* Левая рука (наша) — опущена, выходит из рукава блузки */}
            <path d="M 17 38 Q 14 50 14 56" stroke="#ffffff" strokeWidth="3" fill="none" strokeLinecap="round" />
            <circle cx="14" cy="57" r="1.3" fill="#fde6cb" stroke="#1f2937" strokeWidth="0.3" />
            {/* Манжета лавандовая */}
            <rect x="12.5" y="54" width="3" height="1.2" fill="#a78bfa" />

            {/* Правая рука — поднята в приветственном жесте */}
            <path d="M 39 38 Q 42 32 43 25" stroke="#ffffff" strokeWidth="3" fill="none" strokeLinecap="round" />
            <circle cx="43" cy="24" r="1.3" fill="#fde6cb" stroke="#1f2937" strokeWidth="0.3" />
            {/* Манжета */}
            <rect x="41.5" y="27" width="3" height="1.2" fill="#a78bfa" transform="rotate(-25, 43, 27)" />

            {/* Нота cyan — фирменный акцент MuziAi */}
            <g opacity="0.75">
              <circle cx="50" cy="14" r="1" fill="#22d3ee" />
              <line x1="50.9" y1="14" x2="50.9" y2="10" stroke="#22d3ee" strokeWidth="0.5" />
            </g>
          </svg>
        </button>
      </div>
    </div>
  );
}
