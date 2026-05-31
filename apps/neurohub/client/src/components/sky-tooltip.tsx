// Босс 2026-05-30 (VirtualSky-style hover tooltip).
// Слушает `muza:sky-hover` от globe-view.tsx → рендерит glass-card возле курсора
// через createPortal в document.body (z-[290], pointer-events-none).
//
// CLAUDE.md:
// - Brand-style consistency rule — glass-card + font-display + font-mono на числах
// - Brand-name-uniform rule — если упоминаем MuzaAi, через <BrandName />
// - Russian-communication rule — все labels по-русски
// - Layout-fit-no-overlap rule — clamp к viewport, чтобы tooltip не вылез за край
// - Device-fit-100 rule — max-width c учётом мобильных
//
// Реализация: легковесный useState + window listener. Никаких внешних зависимостей.

import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import type { StarRecord, SpectralClass } from "@/lib/skyCatalog";

type SkyHoverPayload =
  | { type: "star"; star: StarRecord; x: number; y: number }
  | { type: "planet"; key: string; name: string; x: number; y: number };

// Спектральный класс → человеческое описание звезды.
const SPECTRAL_DESCRIPTION: Record<SpectralClass, string> = {
  O: "Голубой сверхгигант",
  B: "Бело-голубая",
  A: "Белая",
  F: "Бледно-жёлтая",
  G: "Жёлтая (как Солнце)",
  K: "Оранжевая",
  M: "Красная",
};

export function SkyTooltip() {
  const [payload, setPayload] = useState<SkyHoverPayload | null>(null);

  useEffect(() => {
    const onHover = (e: Event) => {
      try {
        const detail = (e as CustomEvent).detail as SkyHoverPayload | null;
        setPayload(detail ?? null);
      } catch {
        setPayload(null);
      }
    };
    window.addEventListener("muza:sky-hover", onHover);
    return () => window.removeEventListener("muza:sky-hover", onHover);
  }, []);

  // Босс 2026-05-31: тап по tooltip → flight к звезде/планете.
  // Для star: detail.type='star' + ra/dec (RA в часах, Dec в градусах).
  // Для planet: используем существующий direct-flyby pipeline через key.
  const onTooltipClick = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (!payload) return;
    try {
      if (payload.type === "star") {
        window.dispatchEvent(new CustomEvent("muza:globe-direct-flyby", {
          detail: {
            type: "star",
            key: payload.star.id,
            ra: payload.star.ra,
            dec: payload.star.dec,
            name: payload.star.name,
          },
        }));
      } else {
        window.dispatchEvent(new CustomEvent("muza:globe-direct-flyby", {
          detail: { type: "planet", key: payload.key },
        }));
      }
    } catch { /* no-op */ }
    setPayload(null); // закрываем tooltip
  };

  if (!payload) return null;

  // Clamp к viewport: tooltip не должен вылезать за края экрана.
  // Используем фиксированную ширину 240px и смещаем «за курсор» на 16px.
  const TOOLTIP_W = 240;
  const TOOLTIP_H_EST = payload.type === "star" ? 130 : 70;
  const vw = typeof window !== "undefined" ? window.innerWidth : 1280;
  const vh = typeof window !== "undefined" ? window.innerHeight : 720;
  let left = payload.x + 16;
  let top = payload.y - TOOLTIP_H_EST - 12;
  if (left + TOOLTIP_W > vw - 12) left = payload.x - TOOLTIP_W - 16;
  if (left < 8) left = 8;
  if (top < 8) top = payload.y + 20;
  if (top + TOOLTIP_H_EST > vh - 8) top = vh - TOOLTIP_H_EST - 8;

  const isStar = payload.type === "star";
  const node = (
    <div
      className="fixed z-[290] rounded-xl border border-purple-400/30 backdrop-blur-md cursor-pointer active:scale-95 transition-transform"
      style={{
        left,
        top,
        width: TOOLTIP_W,
        background:
          "linear-gradient(135deg, rgba(26,15,46,0.88) 0%, rgba(10,10,23,0.92) 50%, rgba(15,24,48,0.88) 100%)",
        boxShadow:
          "0 8px 32px rgba(124,58,237,0.25), 0 0 16px rgba(0,212,255,0.15)",
        pointerEvents: "auto",
      }}
      onClick={onTooltipClick}
      onPointerUp={(e) => { onTooltipClick(e as unknown as React.MouseEvent); }}
      data-testid="sky-tooltip"
    >
      <div className="p-3">
        {isStar ? (
          <>
            <div className="flex items-baseline justify-between gap-2">
              <span className="font-display font-bold text-base bg-gradient-to-r from-purple-300 via-fuchsia-300 to-cyan-300 bg-clip-text text-transparent">
                {payload.star.name}
              </span>
              <span className="font-mono text-[10px] text-white/50">
                {payload.star.bayer}
              </span>
            </div>
            <div className="mt-1 text-[11px] font-sans text-white/70">
              Созвездие: <span className="text-cyan-200">{payload.star.constellation}</span>
            </div>
            <div className="mt-1 flex items-center justify-between text-[11px] font-sans text-white/60">
              <span>
                Величина:{" "}
                <span className="font-mono text-amber-200">
                  {payload.star.mag.toFixed(2)}
                </span>
              </span>
              <span className="text-white/40">
                {SPECTRAL_DESCRIPTION[payload.star.spectralClass]}
              </span>
            </div>
          </>
        ) : (
          <>
            <div className="flex items-baseline justify-between gap-2">
              <span className="font-display font-bold text-base bg-gradient-to-r from-purple-300 via-fuchsia-300 to-cyan-300 bg-clip-text text-transparent">
                {payload.name}
              </span>
              <span className="font-mono text-[10px] text-white/50">планета</span>
            </div>
            <div className="mt-1 text-[11px] font-sans text-white/60">
              Солнечная система
            </div>
          </>
        )}
        {/* CTA «🚀 Лететь» — единый для star/planet. */}
        <div className="mt-2 pt-2 border-t border-purple-400/15 text-center text-[11px] font-display font-bold bg-gradient-to-r from-purple-300 via-fuchsia-300 to-cyan-300 bg-clip-text text-transparent">
          🚀 Лететь →
        </div>
      </div>
    </div>
  );

  return typeof document !== "undefined" ? createPortal(node, document.body) : null;
}

export default SkyTooltip;
