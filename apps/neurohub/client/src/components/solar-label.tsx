// ─────────────────────────────────────────────────────────────────────────────
// Solar Label — DOM-overlay поверх canvas с английским названием текущей планеты
// в фирменном стиле MuzaAi (Босс 2026-05-30).
//
// Подписывается на window.solarLabelState (in-memory state, обновляемый каждый
// кадр из rAF-режиссёра globe-view.tsx). НЕ дёргает React-стейт — прямой DOM,
// чтобы не плодить ре-рендеры (как уже работает planetLabelRef).
//
// Стиль = Brand-style consistency rule:
//   font-display (Space Grotesk) + gradient text + brand glow.
//
// Earth/return — особо подсвечивается (Босс «при вращении в сторону земли явно видна»):
// opacity 1.0 + size scale 1.15 (читается «явно»). Остальные — opacity ~0.55.
//
// Player-render-resilience: при любом сбое — try/catch, режим работает без overlay.
// ─────────────────────────────────────────────────────────────────────────────

import { useEffect, useRef } from "react";

export type SolarLabelState = {
  // Английское имя планеты (Mercury / Venus / Earth / Mars / Jupiter / Saturn / Uranus / Neptune / Moon).
  // Пустая строка = скрыть.
  name: string;
  // 2D-координаты в пикселях (relative to viewport), куда привязать центр текста.
  // null = скрыть.
  screenX: number | null;
  screenY: number | null;
  // 0..1. Базово ~0.55, для Earth/return — 1.0.
  opacity: number;
  // 1.0 — обычный размер; 1.15 — Earth special (крупнее).
  scale: number;
};

// Глобальное состояние (in-memory). globe-view.tsx пишет, solar-label.tsx читает.
// Window-level чтобы не тянуть пропс через React-дерево landing → GlobeView → label.
declare global {
  interface Window {
    __solarLabelState?: SolarLabelState;
  }
}

export function SolarLabel() {
  const ref = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    let destroyed = false;
    let lastName = "";
    let raf = 0;

    const tick = () => {
      if (destroyed) return;
      raf = requestAnimationFrame(tick);
      try {
        const st = (typeof window !== "undefined" ? window.__solarLabelState : undefined) as
          | SolarLabelState
          | undefined;
        if (!st || !st.name || st.screenX == null || st.screenY == null || st.opacity <= 0.01) {
          el.style.opacity = "0";
          return;
        }
        if (lastName !== st.name) {
          el.textContent = st.name;
          lastName = st.name;
        }
        const sc = Math.max(0.5, Math.min(1.4, st.scale || 1));
        el.style.left = `${st.screenX}px`;
        el.style.top = `${st.screenY}px`;
        el.style.opacity = String(Math.max(0, Math.min(1, st.opacity)));
        el.style.transform = `translate(-50%, -50%) scale(${sc})`;
      } catch {
        /* Player-render-resilience: молча. */
      }
    };
    tick();

    return () => {
      destroyed = true;
      try {
        cancelAnimationFrame(raf);
      } catch {
        /* no-op */
      }
    };
  }, []);

  // Стиль: font-display (Space Grotesk), brand-gradient text-clip,
  // фирменный фиолетово-голубой glow. Adaptive size (Device-fit-100):
  // text-4xl на mobile (320-639), text-5xl на sm, text-6xl на md+.
  // pointer-events-none — не перехватывает тапы по канвасу.
  return (
    <div
      ref={ref}
      className="pointer-events-none fixed z-30 font-display font-bold tracking-wide select-none whitespace-nowrap text-4xl sm:text-5xl md:text-6xl"
      style={{
        left: 0,
        top: 0,
        opacity: 0,
        // Brand-style gradient (Cyber Violet → Hot Magenta → Electric Blue).
        backgroundImage: "linear-gradient(90deg, #c4b5fd 0%, #f0abfc 50%, #67e8f9 100%)",
        WebkitBackgroundClip: "text",
        backgroundClip: "text",
        color: "transparent",
        // Brand glow (purple + cyan, мягкий).
        filter:
          "drop-shadow(0 0 14px rgba(124,58,237,0.45)) drop-shadow(0 0 28px rgba(0,212,255,0.25))",
        // Плавность fade-in/out + позиции (CSS lerp ~ smooth).
        transition: "opacity 380ms ease, transform 320ms ease",
        willChange: "left, top, opacity, transform",
      }}
    />
  );
}

// Helper для globe-view.tsx — устанавливает текущее состояние label'а
// (вызывается каждый кадр в rAF solar блока). Безопасный (SSR-friendly).
export function setSolarLabelState(state: SolarLabelState): void {
  try {
    if (typeof window === "undefined") return;
    window.__solarLabelState = state;
  } catch {
    /* no-op */
  }
}

// Helper для globe-view.tsx — сбросить label (выход из solar-режима, ошибка).
export function clearSolarLabelState(): void {
  try {
    if (typeof window === "undefined") return;
    window.__solarLabelState = {
      name: "",
      screenX: null,
      screenY: null,
      opacity: 0,
      scale: 1,
    };
  } catch {
    /* no-op */
  }
}
