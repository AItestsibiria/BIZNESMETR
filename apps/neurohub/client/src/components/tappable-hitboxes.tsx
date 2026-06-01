// Босс 2026-05-30 (4-й раз, брутфорс): tap-to-fly через onPointerUp в landing.tsx
// детектил тап ненадёжно (drift пальца, conflict со swipe/double-tap, gating
// на onPlanet). Решение — ВИДИМЫЕ хитбоксы поверх canvas: юзер ВИДИТ круг
// вокруг каждой планеты/Луны/Солнца и тапает прямо по нему. onClick на самой
// кнопке ОБХОДИТ всю tap-detection логику — dispatch гарантированный.
//
// Источник координат — `window.__muziaiPlanetScreen` snapshot (см.
// `globe-view.tsx:updatePlanetScreens`, обновляется каждый кадр ~30fps).
// Полностью read-only, как у TappableBodyPulse (Reuse-working-solutions rule).
//
// Pulse-анимация лёгкая (purple/fuchsia/cyan brand) — guidance без шума.
// pointer-events:auto ТОЛЬКО на самих кнопках; overlay-контейнер pointer-events:none
// чтобы НЕ блокировать swipe/rotate в пустом небе (Globe-swipe-only-on-stars rule).
//
// CLAUDE.md:
// - Frontend-incident-deep-debug rule — критический фронт-баг, идём до идеала
// - Влёт-результат rule — один push 100% решает (4-й коммит подряд по теме)
// - Reuse-working-solutions rule — переиспользуем __muziaiPlanetScreen snapshot
// - Brand-style consistency rule — purple→fuchsia→cyan + glass-card border
// - Globe-swipe-only-on-stars rule — overlay прозрачный, тап-зоны точечные
// - Layout-fit-no-overlap rule — z-30 над canvas, под tapFlyLabel (portal z-300)
// - prefers-reduced-motion — pulse отключается

import { useEffect, useRef, useState } from "react";

interface Body {
  key: string;
  x: number;
  y: number;
  r: number;
  visible: boolean;
}

interface Props {
  /** Включаем только когда globe виден. */
  enabled: boolean;
}

// Polling snapshot из window.__muziaiPlanetScreen каждые 120мс.
// 30fps в globe-view, но React-re-render на каждый кадр — overkill;
// 8fps polling достаточно для UI tracking (планеты двигаются медленно).
const POLL_INTERVAL_MS = 120;

// Минимальная hitbox-площадь (диаметр в px) для надёжного тапа пальцем.
// Apple HIG: ≥44pt. Берём 56 — комфортный target на mobile.
const MIN_HITBOX_PX = 56;

// Максимум — чтобы Сатурн/Юпитер не закрывал пол-экрана при крупном масштабе.
const MAX_HITBOX_PX = 110;

const NAMES_RU: Record<string, string> = {
  moon: "Луне",
  sun: "Солнцу",
  mercury: "Меркурию",
  venus: "Венере",
  mars: "Марсу",
  jupiter: "Юпитеру",
  saturn: "Сатурну",
  uranus: "Урану",
  neptune: "Нептуну",
};

export function TappableHitboxes({ enabled }: Props) {
  const [bodies, setBodies] = useState<Body[]>([]);
  const lastSigRef = useRef<string>("");

  useEffect(() => {
    if (!enabled) {
      setBodies([]);
      lastSigRef.current = "";
      return;
    }
    let cancelled = false;
    const tick = () => {
      if (cancelled) return;
      try {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const arr = ((window as any).__muziaiPlanetScreen || []) as Body[];
        // Фильтр: только видимые + НЕ Земля (мы на ней — нельзя летать к себе).
        const tappable = arr.filter(b => b.visible && b.key !== "earth");
        // Сигнатура — для дешёвого short-circuit (избегаем re-render если ничего не изменилось).
        const sig = tappable.map(b => `${b.key}:${Math.round(b.x)},${Math.round(b.y)},${Math.round(b.r)}`).join("|");
        if (sig !== lastSigRef.current) {
          lastSigRef.current = sig;
          // Копируем массив (snapshot мутирует в globe-view каждый кадр).
          setBodies(tappable.map(b => ({ ...b })));
        }
      } catch {
        /* no-op — Player-render-resilience rule */
      }
    };
    tick();
    const id = window.setInterval(tick, POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, [enabled]);

  if (!enabled || bodies.length === 0) return null;

  return (
    <>
      <style>{`
        @keyframes muza-hitbox-breathe {
          0%, 100% { opacity: 0.35; transform: translate(-50%, -50%) scale(1); }
          50%      { opacity: 0.75; transform: translate(-50%, -50%) scale(1.06); }
        }
        /* Босс 2026-05-30 «от кругов обещал уйти» — hitbox-зона ПОЛНОСТЬЮ
           прозрачная. Без border, без glow, без анимации. Только tap-target.
           Пульсация-guidance отдельным компонентом TappableBodyPulse (тонкая
           аура без круга). */
        .muza-hitbox-btn {
          position: absolute;
          border-radius: 9999px;
          background: transparent;
          border: 0;
          box-shadow: none;
          cursor: pointer;
          pointer-events: auto;
          -webkit-tap-highlight-color: transparent;
          touch-action: manipulation;
          padding: 0;
        }
        .muza-hitbox-btn:active {
          /* лёгкая обратная связь при тапе — еле заметный glow */
          background: radial-gradient(circle, rgba(217,70,239,0.18) 0%, transparent 70%);
        }
      `}</style>
      <div className="absolute inset-0 pointer-events-none z-50" aria-hidden="false">
        {bodies.map(b => {
          // Hitbox-диаметр: 2×r (snapshot хранит радиус) с clamp.
          // Snapshot r — это «логический» радиус планеты в px (≥16). Удваиваем
          // для tap-friendly хитбокса + clamp в [MIN, MAX].
          const diameter = Math.max(MIN_HITBOX_PX, Math.min(MAX_HITBOX_PX, b.r * 2 + 16));
          const ru = NAMES_RU[b.key] || b.key;
          return (
            <button
              key={b.key}
              type="button"
              className="muza-hitbox-btn"
              style={{
                left: `${b.x}px`,
                top: `${b.y}px`,
                width: `${diameter}px`,
                height: `${diameter}px`,
                transform: "translate(-50%, -50%)",
              }}
              aria-label={`Полететь к ${ru}`}
              onPointerDown={(e) => {
                // Останавливаем bubble — иначе globe-area onPointerDown
                // пометит s.onPlanet и tap-detection попытается обработать.
                e.stopPropagation();
              }}
              onPointerUp={(e) => {
                // Босс 2026-05-30 «тап планеты приводит к Земле» — корень:
                // onClick на iPad Safari дает 300мс задержку + может не дойти
                // если parent overlay с pointer-events:none перехватывает
                // тач-сообщения. onPointerUp срабатывает мгновенно и
                // надёжно на iOS. Переносим dispatch сюда.
                e.stopPropagation();
                e.preventDefault();
                try {
                  // Босс 2026-05-30 (4-й инцидент «летят к Земле»): подробный
                  // ОТЛАДОЧНЫЙ лог под флагом window.localStorage["muzaai-click-debug"]="1".
                  // Видим: куда тапнул, какая планета выбрана, в каком mode сейчас,
                  // что вернёт snapshot. Без этого root cause найти невозможно.
                  // eslint-disable-next-line @typescript-eslint/no-explicit-any
                  const w = window as any;
                  const dbg = (() => {
                    try { return window.localStorage?.getItem("muzaai-click-debug") === "1"; } catch { return false; }
                  })();
                  if (dbg) {
                    try {
                      const payload = {
                        key: b.key,
                        coords: { x: b.x, y: b.y, r: b.r },
                        flightMode: w.__muziaiDebugFlightMode || "(unknown)",
                        singleSolarKey: w.__muziaiDebugSingleSolarKey || "(unknown)",
                        snapshot: (w.__muziaiPlanetScreen || []).map((p: any) => p.key),
                      };
                      console.error("[hitbox] click", payload);
                      // On-screen overlay для Босса на iPad (без DevTools).
                      try {
                        if (window.localStorage?.getItem("muzaai-screen-debug") === "1") {
                          window.dispatchEvent(new CustomEvent("muza:debug-log", {
                            detail: `[hitbox] click → ${b.key} (mode=${payload.flightMode}, single=${payload.singleSolarKey})`,
                          }));
                        }
                      } catch { /* no-op */ }
                    } catch { /* no-op */ }
                  }
                  // Босс 2026-05-30 (5-й инцидент «летят к Земле»): радикальное
                  // упрощение — direct flyby. Читаем РЕАЛЬНУЮ 3D-позицию planet
                  // mesh → камера плавно летит к ней (lerp 2.5 сек) → останавливается.
                  // БЕЗ flightMode/solar tour/wizard/director ветвлений.
                  // Чистый прямой полёт через globe-view directFlybyRef.
                  window.dispatchEvent(
                    new CustomEvent("muza:globe-direct-flyby", { detail: { key: b.key } })
                  );
                  if (dbg) {
                    try { console.error("[hitbox] dispatched muza:globe-direct-flyby", b.key); } catch { /* no-op */ }
                    try {
                      if (window.localStorage?.getItem("muzaai-screen-debug") === "1") {
                        window.dispatchEvent(new CustomEvent("muza:debug-log", {
                          detail: `[hitbox] → dispatched muza:globe-direct-flyby ${b.key}`,
                        }));
                      }
                    } catch { /* no-op */ }
                  }
                  if (w.__muziaiDebug) {
                    try { console.log("[tap-to-fly] hitbox click", b.key, { x: b.x, y: b.y }); } catch { /* no-op */ }
                  }
                  // Босс 2026-05-30 п.6: tracking тапа (fire-and-forget).
                  // sessionId — из глобального snapshot если есть (не блокируем UI).
                  try {
                    const sessionId = (typeof window !== "undefined" && (window as any).__muziaiSessionId) || null;
                    fetch("/api/tracking/planet-tap", {
                      method: "POST",
                      headers: { "Content-Type": "application/json" },
                      body: JSON.stringify({ key: b.key, sessionId }),
                      keepalive: true,
                    }).catch(() => { /* no-op */ });
                  } catch { /* no-op */ }
                } catch {
                  /* no-op — Player-render-resilience rule */
                }
              }}
              onClick={(e) => {
                // Резерв для desktop (mouse) — onClick на desktop работает
                // надёжно, но на iPad onPointerUp выше уже сработал.
                e.stopPropagation();
                e.preventDefault();
              }}
            />
          );
        })}
      </div>
    </>
  );
}

export default TappableHitboxes;
