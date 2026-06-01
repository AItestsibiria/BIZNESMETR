// v304 pixels (Sprint 1) — Yandex Метрика + VK Pixel.
// Snippet'ы добавляются в index.html условно — если есть VITE_*_ID
// в env, они активируются при сборке Vite. Если ID нет, ym/VK
// глобалы не существуют, и наши обёртки молча no-op.
//
// Eugene 2026-05-19: respect featureToggles — юзер может отключить
// yandex-metrica / vk-pixel в Settings. Тогда init и track-функции no-op.
//
// Spec: docs/strategy/original/05 §2-§3.

import { featureEnabled } from "./featureToggles";

declare global {
  interface Window {
    ym?: (id: number, action: string, ...args: unknown[]) => void;
    VK?: {
      Goal?: (name: string, params?: Record<string, unknown>) => void;
      Retargeting?: {
        Init: (id: string) => void;
        Hit: () => void;
        Event: (name: string) => void;
      };
    };
  }
}

const YM_ID = Number(import.meta.env.VITE_YM_COUNTER_ID) || 0;
const VK_ID = String(import.meta.env.VITE_VK_PIXEL_ID || "");

let initialized = false;

export function initPixels(): void {
  if (initialized || typeof window === "undefined") return;
  initialized = true;

  // Yandex Метрика
  if (YM_ID && featureEnabled("yandex-metrica")) {
    const w = window as unknown as { ym: any };
    w.ym = w.ym || function (...args: unknown[]) {
      (w.ym.a = w.ym.a || []).push(args);
    };
    (w.ym as any).l = Date.now();
    const s = document.createElement("script");
    s.async = true;
    s.src = "https://mc.yandex.ru/metrika/tag.js";
    document.head.appendChild(s);
    window.ym!(YM_ID, "init", {
      clickmap: true,
      trackLinks: true,
      accurateTrackBounce: true,
      webvisor: false,
    });
  }

  // VK Pixel (Retargeting)
  if (VK_ID && featureEnabled("vk-pixel")) {
    const s = document.createElement("script");
    s.async = true;
    s.src = "https://vk.com/js/api/openapi.js?169";
    s.onload = () => {
      window.VK?.Retargeting?.Init(VK_ID);
      window.VK?.Retargeting?.Hit();
    };
    document.head.appendChild(s);
  }
}

export type GoalName =
  | "page_view"
  | "register_started"
  | "register_completed"
  | "music_started"
  | "music_completed"
  | "payment_initiated"
  | "payment_succeeded";

interface GoalParams {
  userId?: number;
  amount?: number;
  sku?: string;
  [k: string]: unknown;
}

export function trackPageView(path: string = window.location.pathname): void {
  if (YM_ID && window.ym) {
    window.ym(YM_ID, "hit", path);
  }
}

export function trackGoal(goal: GoalName, params?: GoalParams): void {
  if (YM_ID && window.ym) {
    window.ym(YM_ID, "reachGoal", goal, params ?? {});
  }
  if (window.VK?.Goal) {
    // VK Pixel принимает строковое имя цели + ассоциативный объект.
    window.VK.Goal(goal, sanitize(params));
  }
}

// VK Pixel плохо переваривает не-плоские объекты — упрощаем
function sanitize(params?: GoalParams): Record<string, string | number> {
  if (!params) return {};
  const out: Record<string, string | number> = {};
  for (const [k, v] of Object.entries(params)) {
    if (typeof v === "string" || typeof v === "number") out[k] = v;
  }
  return out;
}
