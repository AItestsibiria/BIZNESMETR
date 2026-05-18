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

import type React from "react";
import { useEffect, useRef, useState, type CSSProperties } from "react";

const SEEN_KEY = "_walkingMusa_seen_at";
const SEEN_TTL_MS = 24 * 60 * 60_000; // 24ч между повторами
const FIRST_DELAY_MS = 30_000;        // первая прогулка — через 30 сек на странице
const STOP_DURATION_MS = 5_500;       // сколько Муза стоит на каждой остановке
// Eugene 2026-05-18 Босс «draggable Муза» — пользователь может схватить её и
// тащить куда угодно. localStorage сохраняет последнюю позицию (px).
const DRAG_POS_KEY = "walking-musa-position";
// Eugene 2026-05-19 Босс «кнопка отключения функции» — флаг полного off.
// Юзер может отключить — auto-tour, mouse-follow, контекстные подсказки.
const DISABLED_KEY = "_walkingMusa_disabled";
const MUSA_SIZE_PX = 48; // ширина/висота аватарки (см. ниже)

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
  // Eugene 2026-05-19 — disabled state (localStorage + кнопка ✕ на bubble)
  const [disabled, setDisabled] = useState<boolean>(() => {
    try { return localStorage.getItem(DISABLED_KEY) === "1"; } catch { return false; }
  });
  const chatOpenRef = useRef(false);
  const tourTimerRef = useRef<number | null>(null);
  const startTimerRef = useRef<number | null>(null);
  // Eugene 2026-05-18 Босс «draggable Муза»:
  //   • При pointerdown на body — начинаем drag; auto-tour паузится.
  //   • При pointermove — обновляем position (px) через translate.
  //   • При pointerup — сохраняем позицию в localStorage.
  //   • Кнопка «↺ Авто» в bubble — снова запускает auto-tour
  //     (стирает custom-position, тур начинается со stop 0).
  const [dragPos, setDragPos] = useState<{ x: number; y: number } | null>(() => {
    try {
      const raw = localStorage.getItem(DRAG_POS_KEY);
      if (!raw) return null;
      const parsed = JSON.parse(raw) as { x?: number; y?: number };
      if (typeof parsed?.x === "number" && typeof parsed?.y === "number") {
        return { x: parsed.x, y: parsed.y };
      }
      return null;
    } catch { return null; }
  });
  const [autoTourPaused, setAutoTourPaused] = useState<boolean>(() => {
    // Если есть сохранённая позиция — auto-tour сразу paused.
    try { return !!localStorage.getItem(DRAG_POS_KEY); } catch { return false; }
  });
  const [dragging, setDragging] = useState(false);
  const dragStartRef = useRef<{ pointerX: number; pointerY: number; posX: number; posY: number } | null>(null);

  // Clamp position в пределы viewport (с учётом размера аватарки).
  function clampToViewport(x: number, y: number): { x: number; y: number } {
    const maxX = Math.max(0, window.innerWidth - MUSA_SIZE_PX - 8);
    const maxY = Math.max(0, window.innerHeight - MUSA_SIZE_PX - 8);
    return { x: Math.min(Math.max(0, x), maxX), y: Math.min(Math.max(0, y), maxY) };
  }

  // Restart auto-tour (called from bubble «↺ Авто» button)
  function restartAutoTour() {
    try { localStorage.removeItem(DRAG_POS_KEY); } catch {}
    setDragPos(null);
    setAutoTourPaused(false);
    setStopIdx(0);
    setActive(true);
  }

  // pointerdown на body аватарки
  function handlePointerDown(e: React.PointerEvent<HTMLDivElement>) {
    e.stopPropagation();
    // Захватываем pointer чтобы получать move/up даже когда курсор уходит
    // за границы аватарки. Согласно W3C Pointer Events spec — setPointerCapture
    // гарантирует delivery последующих pointer events на этот элемент.
    try { (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId); } catch {}
    setDragging(true);
    setAutoTourPaused(true);
    // pause auto-tour
    if (tourTimerRef.current) {
      window.clearTimeout(tourTimerRef.current);
      tourTimerRef.current = null;
    }
    // Вычисляем стартовую позицию (px) — либо из dragPos, либо из текущей
    // stop координаты (% → px). Это становится «posX/Y» в dragStartRef.
    let posX: number;
    let posY: number;
    if (dragPos) {
      posX = dragPos.x;
      posY = dragPos.y;
    } else {
      const cur = stops[stopIdx];
      if (cur) {
        posX = (cur.x / 100) * window.innerWidth - MUSA_SIZE_PX / 2;
        posY = (cur.y / 100) * window.innerHeight - MUSA_SIZE_PX / 2;
      } else {
        posX = window.innerWidth - MUSA_SIZE_PX - 16;
        posY = window.innerHeight - MUSA_SIZE_PX - 16;
      }
    }
    dragStartRef.current = { pointerX: e.clientX, pointerY: e.clientY, posX, posY };
  }

  function handlePointerMove(e: React.PointerEvent<HTMLDivElement>) {
    const start = dragStartRef.current;
    if (!start || !dragging) return;
    const dx = e.clientX - start.pointerX;
    const dy = e.clientY - start.pointerY;
    const clamped = clampToViewport(start.posX + dx, start.posY + dy);
    setDragPos(clamped);
  }

  function handlePointerUp(e: React.PointerEvent<HTMLDivElement>) {
    if (!dragging) return;
    try { (e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId); } catch {}
    setDragging(false);
    dragStartRef.current = null;
    // Сохраняем итоговую позицию в localStorage
    if (dragPos) {
      try { localStorage.setItem(DRAG_POS_KEY, JSON.stringify(dragPos)); } catch {}
    }
  }

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

  // Eugene 2026-05-19 Босс «живой персонаж следует за курсором и помогает
  // в районе указателя» — Quick win вариант A. Mouse-follow с easing +
  // контекстные подсказки на элементах с data-musa-hint="...".
  const [mouseFollow, setMouseFollow] = useState<{ x: number; y: number } | null>(null);
  const [contextHint, setContextHint] = useState<string | null>(null);
  const mouseFollowTimerRef = useRef<number | null>(null);
  const lastMouseMoveRef = useRef<number>(0);

  useEffect(() => {
    if (typeof window === "undefined") return;
    if (prefersReducedMotion()) return;
    if (disabled) return;
    // Throttle 200ms — не дёргаем state на каждом px
    const onMove = (e: MouseEvent) => {
      const now = Date.now();
      if (now - lastMouseMoveRef.current < 200) return;
      lastMouseMoveRef.current = now;
      if (dragging || active) return; // auto-tour + drag override
      setMouseFollow({ x: e.clientX, y: e.clientY });
      // Context hint detection
      const tgt = e.target as HTMLElement | null;
      const hintEl = tgt?.closest?.("[data-musa-hint]");
      if (hintEl) {
        const hint = hintEl.getAttribute("data-musa-hint");
        if (hint && hint !== contextHint) setContextHint(hint);
      } else if (contextHint) {
        setContextHint(null);
      }
      // Auto-hide mouse-follow if idle 3 сек
      if (mouseFollowTimerRef.current) window.clearTimeout(mouseFollowTimerRef.current);
      mouseFollowTimerRef.current = window.setTimeout(() => {
        setMouseFollow(null);
        setContextHint(null);
      }, 3500);
    };
    window.addEventListener("mousemove", onMove, { passive: true });
    return () => {
      window.removeEventListener("mousemove", onMove);
      if (mouseFollowTimerRef.current) window.clearTimeout(mouseFollowTimerRef.current);
    };
  }, [active, dragging, contextHint]);

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
    if (disabled) return;
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
  // Eugene 2026-05-18 — если auto-tour paused (юзер drag'нул) — не двигаем
  // stopIdx; Муза остаётся в drag-позиции пока юзер не нажмёт «↺ Авто».
  useEffect(() => {
    if (!active) return;
    if (autoTourPaused) return;
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
  }, [active, stopIdx, stops.length, autoTourPaused]);

  // Eugene 2026-05-18 — если у юзера в localStorage есть сохранённая позиция,
  // активируем Музу сразу (она «осталась там где её бросили» при возврате
  // на страницу) без 30-сек задержки и без 24ч ограничения.
  useEffect(() => {
    if (dragPos && !active && autoTourPaused) {
      setActive(true);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Eugene 2026-05-19: если юзер отключил — рендерим только маленькую кнопку
  // «👁 Помощница» в bottom-left чтобы можно было включить обратно.
  if (disabled) {
    return (
      <button
        onClick={() => {
          try { localStorage.removeItem(DISABLED_KEY); } catch {}
          setDisabled(false);
        }}
        style={{
          position: "fixed",
          bottom: 12,
          left: 12,
          zIndex: 9997,
          padding: "6px 10px",
          borderRadius: 999,
          background: "rgba(20,18,40,0.7)",
          border: "1px solid rgba(168,85,247,0.35)",
          color: "rgba(255,255,255,0.7)",
          fontSize: 11,
          fontFamily: "Inter, system-ui, sans-serif",
          cursor: "pointer",
          backdropFilter: "blur(8px)",
        }}
        title="Включить помощницу Музу"
      >
        👁 Помощница
      </button>
    );
  }

  function disableMusa() {
    try { localStorage.setItem(DISABLED_KEY, "1"); } catch {}
    setDisabled(true);
    setActive(false);
    setMouseFollow(null);
    setContextHint(null);
  }

  // Mouse-follow mode (Eugene 2026-05-19 Variant A) — отдельная Муза которая
  // плавно идёт за курсором + показывает контекстную подсказку при hover на
  // элементах с data-musa-hint. Не требует active=true.
  if (!active && mouseFollow) {
    // Позиция Музы — 36px вправо-вниз от курсора (не закрывает кликнутую цель)
    const px = Math.min(window.innerWidth - MUSA_SIZE_PX - 8, mouseFollow.x + 28);
    const py = Math.min(window.innerHeight - MUSA_SIZE_PX - 8, mouseFollow.y + 28);
    const onRight = px + 100 > window.innerWidth - 200;
    return (
      <div
        aria-live="polite"
        style={{
          position: "fixed",
          left: `${px}px`,
          top: `${py}px`,
          transform: "translate(0, 0)",
          transition: "left 380ms cubic-bezier(.2,.7,.2,1), top 380ms cubic-bezier(.2,.7,.2,1)",
          zIndex: 9998,
          pointerEvents: "none",
        }}
      >
        <div
          style={{
            width: MUSA_SIZE_PX,
            height: MUSA_SIZE_PX,
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
            src="/consultant-avatar.png"
            alt="Муза"
            style={{ width: 38, height: 38, objectFit: "contain", borderRadius: "9999px" }}
            onError={(e) => { (e.target as HTMLImageElement).src = "/consultant-avatar.svg"; }}
          />
        </div>
        {contextHint && (
          <div
            style={{
              position: "absolute",
              top: "50%",
              transform: "translateY(-50%)",
              [onRight ? "right" : "left"]: "calc(100% + 12px)",
              minWidth: 180,
              maxWidth: 280,
              padding: "10px 12px",
              paddingRight: 28,
              borderRadius: 16,
              background: "linear-gradient(135deg, rgba(20,18,40,0.94), rgba(28,16,46,0.9))",
              border: "1px solid rgba(168,85,247,0.5)",
              color: "rgba(255,255,255,0.95)",
              fontSize: 12,
              lineHeight: 1.4,
              fontFamily: "Inter, system-ui, sans-serif",
              boxShadow: "0 8px 24px rgba(0,0,0,0.4), 0 0 20px rgba(124,58,237,0.3)",
              backdropFilter: "blur(8px)",
              animation: "walkingMusaBubble 280ms ease-out backwards",
              whiteSpace: "normal",
              pointerEvents: "auto",
            }}
          >
            {contextHint}
            <button
              onClick={(e) => { e.stopPropagation(); disableMusa(); }}
              title="Отключить помощницу"
              style={{
                position: "absolute",
                top: 4,
                right: 4,
                width: 18,
                height: 18,
                borderRadius: 999,
                background: "rgba(0,0,0,0.4)",
                border: "1px solid rgba(255,255,255,0.15)",
                color: "rgba(255,255,255,0.6)",
                fontSize: 11,
                lineHeight: "16px",
                padding: 0,
                cursor: "pointer",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
              }}
            >×</button>
          </div>
        )}
      </div>
    );
  }

  if (!active) return null;
  const current = stops[stopIdx];
  if (!current && !dragPos) return null;

  // Позиционируем bubble так чтобы он не «убегал» за край экрана:
  // если Муза в правой половине — bubble слева от неё, и наоборот.
  // При drag-position — сравниваем по pixel-координате с centerX viewport.
  const isRightHalf = dragPos
    ? dragPos.x + MUSA_SIZE_PX / 2 > window.innerWidth / 2
    : (current?.x ?? 50) > 50;
  const bubbleSide: "left" | "right" = isRightHalf ? "left" : "right";
  const bubblePos: CSSProperties = bubbleSide === "left"
    ? { right: "calc(100% + 12px)" }
    : { left: "calc(100% + 12px)" };

  // Eugene 2026-05-18 — стиль позиции зависит от mode:
  //   • drag-mode (dragPos !== null) → fixed по px, без transition (instant follow),
  //     transform: none (px-positioning без centering offset).
  //   • auto-tour → как раньше: % + translate(-50%) + 1200ms ease-out.
  const positionStyle: CSSProperties = dragPos
    ? {
        position: "fixed",
        left: `${dragPos.x}px`,
        top: `${dragPos.y}px`,
        transform: "translate(0, 0)",
        transition: dragging ? "none" : "left 200ms ease-out, top 200ms ease-out",
        zIndex: 9998,
        // pointerEvents: auto — body тащим, bubble отдельно auto.
        pointerEvents: "auto",
      }
    : {
        position: "fixed",
        left: `${current!.x}%`,
        top: `${current!.y}%`,
        transform: "translate(-50%, -50%)",
        transition: "left 1200ms ease-out, top 1200ms ease-out",
        zIndex: 9998,
        // Eugene 2026-05-18 — родитель должен пропускать клики мимо аватарки и
        // bubble; дочерние с pointerEvents: auto обрабатывают grab сами.
        pointerEvents: "none",
      };

  return (
    <div aria-live="polite" aria-atomic="true" style={positionStyle}>
      {/* Аватар Музы — draggable (Eugene 2026-05-18 Босс).
          pointerdown/move/up на этом блоке. setPointerCapture в handler
          даёт глобальный pointerup даже если курсор покинул аватарку. */}
      <div
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onPointerCancel={handlePointerUp}
        style={{
          width: MUSA_SIZE_PX,
          height: MUSA_SIZE_PX,
          borderRadius: "9999px",
          background: "radial-gradient(circle at 30% 30%, rgba(168,85,247,0.45), rgba(34,211,238,0.25))",
          boxShadow: "0 0 24px rgba(124,58,237,0.45), 0 0 48px rgba(0,212,255,0.2)",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          animation: dragging ? "none" : "walkingMusaBounce 2.4s ease-in-out infinite",
          cursor: dragging ? "grabbing" : "grab",
          // touch-action: none — отключаем default touch scroll/zoom во время
          // drag (W3C Pointer Events Level 2 §6 для smooth pointer tracking).
          touchAction: "none",
          // в drag-режиме body всегда clickable; в auto-tour — pointerEvents
          // на родителе none, но конкретно аватарку делаем auto чтобы dragger
          // ловил pointerdown.
          pointerEvents: "auto",
        }}
      >
        {/* Eugene 2026-05-18: 3D-аватар через consultant-avatar.png
            (после approve в админке — hi-res 3D PNG), SVG fallback. */}
        <img
          src="/consultant-avatar.png"
          alt="Муза"
          style={{ width: 38, height: 38, objectFit: "contain", borderRadius: "9999px" }}
          loading="lazy"
          onError={(e) => { (e.target as HTMLImageElement).src = "/consultant-avatar.svg"; }}
        />
      </div>
      {/* Speech bubble — рядом с Музой, не перекрывает.
          В drag-mode (без auto-tour) — короткий бабл с подсказкой и кнопкой
          «↺ Авто» (restart tour). В обычном режиме — текст текущей остановки. */}
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
          animation: dragging ? "none" : "walkingMusaBubble 380ms ease-out backwards",
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
        <div style={{ paddingRight: 14 }}>
          {autoTourPaused
            ? "Перетаскивайте меня куда удобно 🎀"
            : (current?.bubble ?? "")}
        </div>
        {/* Restart auto-tour — только если paused (юзер уже dragnул) */}
        <div style={{ display: "flex", gap: 6, marginTop: 8, flexWrap: "wrap" }}>
          {autoTourPaused && (
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                restartAutoTour();
              }}
              aria-label="Запустить тур заново"
              style={{
                padding: "4px 8px",
                borderRadius: 8,
                background: "rgba(168,85,247,0.18)",
                border: "1px solid rgba(168,85,247,0.4)",
                color: "rgba(255,255,255,0.9)",
                fontSize: 11,
                cursor: "pointer",
              }}
            >
              ↺ Авто
            </button>
          )}
          <button
            type="button"
            onClick={(e) => { e.stopPropagation(); disableMusa(); }}
            aria-label="Отключить помощницу"
            title="Отключить — больше не будет показываться"
            style={{
              padding: "4px 8px",
              borderRadius: 8,
              background: "rgba(0,0,0,0.4)",
              border: "1px solid rgba(255,255,255,0.15)",
              color: "rgba(255,255,255,0.6)",
              fontSize: 11,
              cursor: "pointer",
            }}
          >
            ✕ Отключить
          </button>
        </div>
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
