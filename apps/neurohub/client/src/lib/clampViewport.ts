// clampViewport — единый helper для удержания floating-окон в рамках экрана.
// Eugene 2026-05-19 «Правило: показывай все окошки в рамках экрана.
// Пользователь может двигать».
//
// Применяй везде где есть absolute/fixed элементы с динамической позицией:
// floating-consultant, walking-musa, speech bubbles, draggable modals.
// Гарантирует что элемент не уходит за edge viewport (с padding 8px).

export interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

export function clampToViewport(
  x: number,
  y: number,
  width: number,
  height: number,
  padding = 8,
): { x: number; y: number } {
  if (typeof window === "undefined") return { x, y };
  const maxX = Math.max(0, window.innerWidth - width - padding);
  const maxY = Math.max(0, window.innerHeight - height - padding);
  return {
    x: Math.min(Math.max(padding, x), maxX),
    y: Math.min(Math.max(padding, y), maxY),
  };
}

/** Чтение persisted позиции из localStorage */
export function readPos(key: string): { x: number; y: number } | null {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return null;
    const p = JSON.parse(raw);
    if (typeof p?.x === "number" && typeof p?.y === "number") return { x: p.x, y: p.y };
    return null;
  } catch { return null; }
}

export function writePos(key: string, pos: { x: number; y: number }): void {
  try { localStorage.setItem(key, JSON.stringify(pos)); } catch {}
}

/** React hook: одна точка для draggable-floating элементов */
import { useEffect, useRef, useState } from "react";

export function useDraggablePosition(
  storageKey: string,
  defaultPos: { x: number; y: number } | (() => { x: number; y: number }),
  elementSize: { width: number; height: number },
) {
  const [pos, setPos] = useState<{ x: number; y: number }>(() => {
    const saved = readPos(storageKey);
    if (saved) {
      return clampToViewport(saved.x, saved.y, elementSize.width, elementSize.height);
    }
    const def = typeof defaultPos === "function" ? defaultPos() : defaultPos;
    return clampToViewport(def.x, def.y, elementSize.width, elementSize.height);
  });
  const [dragging, setDragging] = useState(false);
  const dragStartRef = useRef<{ pointerX: number; pointerY: number; posX: number; posY: number } | null>(null);

  // При resize окна — клампим позицию обратно в рамки
  useEffect(() => {
    const onResize = () => {
      setPos(p => clampToViewport(p.x, p.y, elementSize.width, elementSize.height));
    };
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, [elementSize.width, elementSize.height]);

  const onPointerDown = (e: React.PointerEvent<HTMLElement>) => {
    e.stopPropagation();
    try { (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId); } catch {}
    setDragging(true);
    dragStartRef.current = {
      pointerX: e.clientX,
      pointerY: e.clientY,
      posX: pos.x,
      posY: pos.y,
    };
  };

  const onPointerMove = (e: React.PointerEvent<HTMLElement>) => {
    const start = dragStartRef.current;
    if (!start || !dragging) return;
    const dx = e.clientX - start.pointerX;
    const dy = e.clientY - start.pointerY;
    setPos(clampToViewport(
      start.posX + dx,
      start.posY + dy,
      elementSize.width,
      elementSize.height,
    ));
  };

  const onPointerUp = (e: React.PointerEvent<HTMLElement>) => {
    if (!dragging) return;
    try { (e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId); } catch {}
    setDragging(false);
    dragStartRef.current = null;
    writePos(storageKey, pos);
  };

  return { pos, dragging, onPointerDown, onPointerMove, onPointerUp };
}
