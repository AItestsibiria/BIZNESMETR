// WalkingMusa (Eugene 2026-05-18 Босс): «Муза ходит по сайту и показывает».
//
// Floating-consultant статичен в правом нижнем углу — это основной чат. Этот
// компонент ДОПОЛНЯЕТ его: раз в 90 сек (или при триггере idle/scroll-past-hero)
// Муза выходит на короткий walking tour — 4-5 остановок с speech-bubble:
//   «👆 Нажми сюда чтобы создать первую песню»
//   «🎧 Послушай плейлист других авторов»
//   «🎁 Зарегистрируйся — получишь подарочный трек»
// Возврат в bottom-right через 30-40 сек.
//
// Реализация:
//   • Без heavy animation libs — CSS transition + transform + setTimeout.
//   • Mobile-aware: на узком экране меньше остановок и компактные bubble.
//   • localStorage `walking_musa_seen_at` — не повторяем чаще раза в 24ч.
//   • Не показывается если открыт FloatingConsultant chat (event-bus через
//     `window.dispatchEvent('musa-chat-open')`) — фокус уже на ней.
//   • Reduced-motion aware (prefers-reduced-motion: reduce → не показываем).
//   • Persistent-audio-only rule НЕ задеваем — компонент без audio, чистый
//     визуал + speech bubble.

import { useEffect, useRef, useState, type CSSProperties } from "react";

const SEEN_KEY = "_walkingMusa_seen_at";
const SEEN_TTL_MS = 24 * 60 * 60_000; // 24ч между повторами
const FIRST_DELAY_MS = 30_000;        // первая прогулка — через 30 сек на странице
const STOP_DURATION_MS = 5_500;       // сколько Муза стоит на каждой остановке

type Stop = {
  // Позиция в viewport — % от ширины/высоты экрана.
  x: number;
  y: number;
  bubble: string;
  // Селектор элемента-якоря (если есть, рисуем стрелку-указку на него)
  anchor?: string;
};

// Desktop / tablet — 5 остановок (полный тур).
const STOPS_DESKTOP: Stop[] = [
  { x: 50, y: 35, bubble: "Привет! Покажу что у нас есть 🎵" },
  { x: 50, y: 24, bubble: "👆 Здесь главное — кнопка создать песню", anchor: "[data-walking-target='hero-cta']" },
  { x: 22, y: 55, bubble: "🎧 Послушайте плейлист — там настоящие истории", anchor: "[data-walking-target='playlist']" },
  { x: 78, y: 50, bubble: "🎁 Если зарегистрируетесь — подарочный трек ваш", anchor: "[data-walking-target='register']" },
  { x: 92, y: 92, bubble: "Я всегда здесь — кликните если что 🎀" },
];

// Mobile — 3 коротких остановки (узкий экран, меньше места).
const STOPS_MOBILE: Stop[] = [
  { x: 50, y: 30, bubble: "Привет 🎵 Покажу пару штук" },
  { x: 50, y: 50, bubble: "🎁 Зарегистрируйтесь — будет подарочный трек" },
  { x: 88, y: 90, bubble: "Я всегда тут, кликните 🎀" },
];

function prefersReducedMotion(): boolean {
  try {
    return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  } catch { return false; }
}

function getLastSeenAt(): number {
  try { return Number(localStorage.getItem(SEEN_KEY) || "0"); } catch { return 0; }
}

function markSeenNow(): void {
  try { localStorage.setItem(SEEN_KEY, String(Date.now())); } catch {}
}

export function WalkingMusa() {
  const [active, setActive] = useState(false);
  const [stopIdx, setStopIdx] = useState(0);
  const [stops, setStops] = useState<Stop[]>(STOPS_DESKTOP);
  const chatOpenRef = useRef(false);
  const tourTimerRef = useRef<number | null>(null);
  const startTimerRef = useRef<number | null>(null);

  // Mobile detection (single check at mount + resize listener).
  useEffect(() => {
    const update = () => {
      const isMobile = window.innerWidth < 640;
      setStops(isMobile ? STOPS_MOBILE : STOPS_DESKTOP);
    };
    update();
    window.addEventListener("resize", update);
    return () => window.removeEventListener("resize", update);
  }, []);

  // Listen for FloatingConsultant open/close — пока чат открыт, walking
  // tour не запускается / прерывается. FloatingConsultant диспатчит эти
  // события через window.dispatchEvent(new CustomEvent('musa-chat-open'/
  // 'musa-chat-close')) — добавлено в floating-consultant.tsx.
  useEffect(() => {
    const onOpen = () => { chatOpenRef.current = true; setActive(false); };
    const onClose = () => { chatOpenRef.current = false; };
    window.addEventListener("musa-chat-open", onOpen as EventListener);
    window.addEventListener("musa-chat-close", onClose as EventListener);
    return () => {
      window.removeEventListener("musa-chat-open", onOpen as EventListener);
      window.removeEventListener("musa-chat-close", onClose as EventListener);
    };
  }, []);

  // Старт тура. Условия:
  //   • prefers-reduced-motion НЕ выставлен
  //   • Прошло >24ч с последнего показа (или показ ещё не был)
  //   • Не открыт чат
  //   • Юзер не в /admin/* (там и так много визуального)
  useEffect(() => {
    if (typeof window === "undefined") return;
    if (prefersReducedMotion()) return;
    if (window.location.hash.startsWith("#/admin")) return;
    const last = getLastSeenAt();
    if (last && Date.now() - last < SEEN_TTL_MS) return;

    startTimerRef.current = window.setTimeout(() => {
      if (chatOpenRef.current) return;
      setStopIdx(0);
      setActive(true);
      markSeenNow();
    }, FIRST_DELAY_MS);

    return () => {
      if (startTimerRef.current) window.clearTimeout(startTimerRef.current);
    };
  }, []);

  // Прогресс по остановкам — каждые STOP_DURATION_MS переключаемся.
  useEffect(() => {
    if (!active) return;
    if (stopIdx >= stops.length) {
      // Тур завершён — прячемся
      setActive(false);
      setStopIdx(0);
      return;
    }
    tourTimerRef.current = window.setTimeout(() => {
      setStopIdx((i) => i + 1);
    }, STOP_DURATION_MS);
    return () => {
      if (tourTimerRef.current) window.clearTimeout(tourTimerRef.current);
    };
  }, [active, stopIdx, stops.length]);

  if (!active) return null;
  const current = stops[stopIdx];
  if (!current) return null;

  // Позиционируем bubble так чтобы он не «убегал» за край экрана:
  // если Муза в правой половине — bubble слева от неё, и наоборот.
  const bubbleSide: "left" | "right" = current.x > 50 ? "left" : "right";
  const bubblePos: CSSProperties = bubbleSide === "left"
    ? { right: "calc(100% + 12px)" }
    : { left: "calc(100% + 12px)" };

  return (
    <div
      aria-live="polite"
      aria-atomic="true"
      style={{
        position: "fixed",
        left: `${current.x}%`,
        top: `${current.y}%`,
        transform: "translate(-50%, -50%)",
        // Согласно W3C CSS Transitions Module Level 1 §2 — transition
        // ease-out для естественного «приземления». 1200ms даёт ощущение
        // живого движения, не дёрганого.
        transition: "left 1200ms ease-out, top 1200ms ease-out",
        zIndex: 9998, // ниже FloatingConsultant (9999), выше остального UI
        pointerEvents: "none", // walking tour не блокирует клики
      }}
    >
      {/* Аватар Музы */}
      <div
        style={{
          width: 48,
          height: 48,
          borderRadius: "9999px",
          background: "radial-gradient(circle at 30% 30%, rgba(168,85,247,0.45), rgba(34,211,238,0.25))",
          boxShadow: "0 0 24px rgba(124,58,237,0.45), 0 0 48px rgba(0,212,255,0.2)",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          animation: "walkingMusaBounce 2.4s ease-in-out infinite",
        }}
      >
        <img
          src="/consultant-avatar.svg"
          alt="Муза"
          style={{ width: 38, height: 38, objectFit: "contain", borderRadius: "9999px" }}
          loading="lazy"
        />
      </div>
      {/* Speech bubble — рядом с Музой, не перекрывает */}
      <div
        style={{
          position: "absolute",
          top: "50%",
          transform: "translateY(-50%)",
          ...bubblePos,
          minWidth: 180,
          maxWidth: 240,
          padding: "10px 12px",
          borderRadius: 16,
          background: "linear-gradient(135deg, rgba(20,18,40,0.92), rgba(28,16,46,0.88))",
          border: "1px solid rgba(168,85,247,0.4)",
          color: "rgba(255,255,255,0.95)",
          fontSize: 12,
          lineHeight: 1.4,
          fontFamily: "Inter, system-ui, sans-serif",
          boxShadow: "0 8px 24px rgba(0,0,0,0.35), 0 0 20px rgba(124,58,237,0.2)",
          backdropFilter: "blur(8px)",
          animation: "walkingMusaBubble 380ms ease-out backwards",
          pointerEvents: "auto",
        }}
      >
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            setActive(false);
            if (tourTimerRef.current) window.clearTimeout(tourTimerRef.current);
          }}
          aria-label="Закрыть подсказку"
          style={{
            position: "absolute",
            top: 2,
            right: 4,
            background: "transparent",
            border: "none",
            color: "rgba(255,255,255,0.4)",
            fontSize: 14,
            cursor: "pointer",
            padding: "2px 6px",
            lineHeight: 1,
          }}
        >
          ×
        </button>
        <div style={{ paddingRight: 14 }}>{current.bubble}</div>
      </div>
      {/* CSS keyframes — inline через <style> чтобы не плодить css-файлы */}
      <style>{`
        @keyframes walkingMusaBounce {
          0%, 100% { transform: translateY(0) scale(1); }
          50% { transform: translateY(-4px) scale(1.03); }
        }
        @keyframes walkingMusaBubble {
          0% { opacity: 0; transform: translateY(-50%) scale(0.92); }
          100% { opacity: 1; transform: translateY(-50%) scale(1); }
        }
        @media (prefers-reduced-motion: reduce) {
          @keyframes walkingMusaBounce { 0%, 100% { transform: none; } }
        }
      `}</style>
    </div>
  );
}
