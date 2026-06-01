/**
 * debugLog — единый helper для отправки сообщений в ScreenDebugOverlay.
 *
 * Использование:
 *   import { debugLog } from "@/lib/debugLog";
 *   debugLog("[Audio] play track #123");
 *
 * Активируется ТОЛЬКО когда localStorage["muzaai-screen-debug"] === "1"
 * (включается через ?debug=1 в URL — см. screen-debug-overlay.tsx).
 *
 * Eugene 2026-05-30: «используй дебаг везде» — расширение overlay на все
 * ключевые операции (audio / payment / generation / chat / navigation / SW / globe).
 *
 * Правила:
 *  - Никогда не throw — debug не должен ломать hot-path.
 *  - SSR-safe (проверка typeof window).
 *  - НЕ спамить (НЕ вызывать в timeupdate / каждом кадре) — только ключевые
 *    события (start/end/error/transition).
 *  - Объекты автоматически сериализуются в JSON (с fallback на String).
 */

const FLAG_KEY = "muzaai-screen-debug";

function isEnabled(): boolean {
  try {
    if (typeof window === "undefined") return false;
    return window.localStorage?.getItem(FLAG_KEY) === "1";
  } catch {
    return false;
  }
}

function stringify(v: unknown): string {
  if (typeof v === "string") return v;
  try {
    return JSON.stringify(v);
  } catch {
    try {
      return String(v);
    } catch {
      return "[unserializable]";
    }
  }
}

/**
 * debugLog(msg) — отправляет строку в ScreenDebugOverlay.
 *
 * Параметр может быть string или любым объектом (будет JSON.stringify'нут).
 * Несколько аргументов — будут склеены через пробел.
 */
export function debugLog(...parts: unknown[]): void {
  try {
    if (!isEnabled()) return;
    if (typeof window === "undefined") return;
    const text = parts.map(stringify).join(" ");
    window.dispatchEvent(new CustomEvent("muza:debug-log", { detail: text }));
  } catch {
    /* no-op */
  }
}

/**
 * debugLogIfEnabled — то же что debugLog, но принимает функцию-фабрику
 * для дорогих вычислений (не выполняются если debug off).
 *
 * Использование:
 *   debugLogIfEnabled(() => `[Heavy] ${JSON.stringify(bigObj)}`);
 */
export function debugLogIfEnabled(factory: () => string): void {
  try {
    if (!isEnabled()) return;
    if (typeof window === "undefined") return;
    const text = factory();
    window.dispatchEvent(new CustomEvent("muza:debug-log", { detail: text }));
  } catch {
    /* no-op */
  }
}

export default debugLog;
