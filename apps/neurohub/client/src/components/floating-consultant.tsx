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
                <stop offset="0%" stopColor="#a78bfa" />
                <stop offset="100%" stopColor="#4c1d95" />
              </linearGradient>
              <linearGradient id="bizJacket" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor="#312e81" />
                <stop offset="100%" stopColor="#1e1b4b" />
              </linearGradient>
              <linearGradient id="bizSkirt" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor="#1e40af" />
                <stop offset="100%" stopColor="#1e1b4b" />
              </linearGradient>
              <linearGradient id="bizBlouse" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor="#ede9fe" />
                <stop offset="100%" stopColor="#c4b5fd" />
              </linearGradient>
            </defs>
            {/* Постарше (35-40), стройный силуэт, бренд-пропорции
                (60% dark indigo, 30% purple-blue, 10% cyan) */}

            {/* Каре — задний объём (узкий) */}
            <path d="M 16 18 Q 13 30 15 42 Q 17 44 19 42 L 19 22 Z" fill="url(#bizHair)" />
            <path d="M 40 18 Q 43 30 41 42 Q 39 44 37 42 L 37 22 Z" fill="url(#bizHair)" />

            {/* Голова — чуть меньше, овальнее (взрослый) */}
            <ellipse cx="28" cy="22" rx="8" ry="9.5" fill="#fde6cb" stroke="#1f2937" strokeWidth="0.4" />

            {/* Чёлка набок — асимметричная */}
            <path d="M 20 14 Q 28 10 37 14 Q 38 18 36 22 Q 31 17 26 19 Q 22 18 21 22 Q 19 18 20 14 Z" fill="url(#bizHair)" stroke="#1f2937" strokeWidth="0.3" />

            {/* Миндалевидные глаза с редким морганием */}
            <g className="consultant-eye">
              <ellipse cx="25.5" cy="22" rx="1.3" ry="1.6" fill="#fff" stroke="#1f2937" strokeWidth="0.3" />
              <circle cx="25.5" cy="22.2" r="0.75" fill="#1f2937" />
              <circle cx="25.7" cy="21.9" r="0.25" fill="#fff" />
            </g>
            <g className="consultant-eye-2">
              <ellipse cx="30.5" cy="22" rx="1.3" ry="1.6" fill="#fff" stroke="#1f2937" strokeWidth="0.3" />
              <circle cx="30.5" cy="22.2" r="0.75" fill="#1f2937" />
              <circle cx="30.7" cy="21.9" r="0.25" fill="#fff" />
            </g>

            {/* Брови — более выразительные, deep purple */}
            <path d="M 23.5 19.5 Q 25.5 18.8 27.5 19.5" stroke="#4c1d95" strokeWidth="0.55" fill="none" strokeLinecap="round" />
            <path d="M 28.5 19.5 Q 30.5 18.8 32.5 19.5" stroke="#4c1d95" strokeWidth="0.55" fill="none" strokeLinecap="round" />

            {/* Лёгкие морщинки у глаз — возраст */}
            <path d="M 23.5 22.8 Q 23 23.3 22.7 23.8" stroke="rgba(120,80,50,0.4)" strokeWidth="0.22" fill="none" strokeLinecap="round" />
            <path d="M 32.5 22.8 Q 33 23.3 33.3 23.8" stroke="rgba(120,80,50,0.4)" strokeWidth="0.22" fill="none" strokeLinecap="round" />

            {/* Скулы — лёгкое определение (взрослый) */}
            <circle cx="22" cy="26" r="0.9" fill="rgba(244,114,182,0.3)" />
            <circle cx="34" cy="26" r="0.9" fill="rgba(244,114,182,0.3)" />

            {/* Уверенная закрытая улыбка (не широкая, но дружелюбная) */}
            <path d="M 26 27.5 Q 28 28.5 30 27.5" stroke="#1f2937" strokeWidth="0.45" fill="rgba(190,40,80,0.5)" strokeLinecap="round" />

            {/* Серьги cyan */}
            <circle cx="20" cy="25" r="0.55" fill="#22d3ee" />
            <circle cx="36" cy="25" r="0.55" fill="#22d3ee" />

            {/* Шея */}
            <rect x="25.5" y="30.5" width="5" height="4" rx="1" fill="#fde6cb" stroke="#1f2937" strokeWidth="0.3" />

            {/* Тёмный жакет — стройный, фирменный indigo (60% бренда) */}
            <path d="M 20 35 Q 18 36 18 39 L 19 57 L 37 57 L 38 39 Q 38 36 36 35 L 32 35 L 28 38 L 24 35 Z"
                  fill="url(#bizJacket)" stroke="#1f2937" strokeWidth="0.4" />

            {/* Воротник жакета — узкие лацканы */}
            <path d="M 24 35 L 28 38 L 32 35 L 31 35.6 L 28 37.2 L 25 35.6 Z" fill="url(#bizBlouse)" stroke="#1f2937" strokeWidth="0.3" />
            {/* Тонкие лацканы */}
            <path d="M 24 35 L 23 41 L 26 39 Z" fill="#1e1b4b" stroke="#1f2937" strokeWidth="0.25" />
            <path d="M 32 35 L 33 41 L 30 39 Z" fill="#1e1b4b" stroke="#1f2937" strokeWidth="0.25" />

            {/* Пуговица — cyan (10% бренд-акцент) */}
            <circle cx="28" cy="44" r="0.55" fill="#22d3ee" />
            <circle cx="28" cy="50" r="0.55" fill="#22d3ee" />

            {/* Узкий белый пояс на талии */}
            <rect x="18" y="55.5" width="20" height="2" fill="#ede9fe" stroke="#1f2937" strokeWidth="0.3" />
            <rect x="27.5" y="55.5" width="1.5" height="2" fill="#7c3aed" />

            {/* Юбка-карандаш — deep brand blue (тёмная) */}
            <path d="M 19 57 L 37 57 L 35 82 L 21 82 Z" fill="url(#bizSkirt)" stroke="#1f2937" strokeWidth="0.4" />

            {/* Ноги */}
            <rect x="23" y="82" width="3" height="8" fill="#fde6cb" stroke="#1f2937" strokeWidth="0.3" />
            <rect x="30" y="82" width="3" height="8" fill="#fde6cb" stroke="#1f2937" strokeWidth="0.3" />

            {/* Лодочки тёмные */}
            <path d="M 22 90 Q 24.5 89 26 90 L 26 92 L 22 92 Z" fill="#1e1b4b" stroke="#1f2937" strokeWidth="0.3" />
            <path d="M 30 90 Q 32.5 89 34 90 L 34 92 L 30 92 Z" fill="#1e1b4b" stroke="#1f2937" strokeWidth="0.3" />
            <path d="M 25 92 L 25.5 94" stroke="#1f2937" strokeWidth="0.4" />
            <path d="M 31 92 L 30.5 94" stroke="#1f2937" strokeWidth="0.4" />

            {/* Левая рука — опущена, тёмный рукав */}
            <path d="M 19 38 Q 16 50 16 56" stroke="url(#bizJacket)" strokeWidth="2.8" fill="none" strokeLinecap="round" />
            <circle cx="16" cy="57" r="1.2" fill="#fde6cb" stroke="#1f2937" strokeWidth="0.3" />
            <rect x="14.5" y="54.5" width="3" height="1" fill="#ede9fe" stroke="#1f2937" strokeWidth="0.2" />

            {/* Правая рука — поднята в приветственном жесте, машет редко */}
            <g className="consultant-arm">
              <path d="M 37 38 Q 40 32 41 25" stroke="url(#bizJacket)" strokeWidth="2.8" fill="none" strokeLinecap="round" />
              <circle cx="41" cy="24" r="1.2" fill="#fde6cb" stroke="#1f2937" strokeWidth="0.3" />
            </g>

            {/* Cyan нота — последний 10% акцент */}
            <g opacity="0.85">
              <circle cx="50" cy="14" r="1" fill="#22d3ee" />
              <line x1="50.9" y1="14" x2="50.9" y2="10" stroke="#22d3ee" strokeWidth="0.5" />
            </g>
          </svg>
        </button>
      </div>
    </div>
  );
}
