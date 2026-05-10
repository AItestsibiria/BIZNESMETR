// Client-side error logger (Eugene 2026-05-10): собираем все React/JS
// runtime-ошибки, отсылаем на /api/client-errors. Eugene видит на
// admin-панели → анализ + варианты исправления.
//
// Источники ошибок:
//   1. window.error          — uncaught runtime errors
//   2. unhandledrejection    — Promise rejections без .catch()
//   3. React ErrorBoundary   — отдельный путь (см. components/error-boundary.tsx)
//
// Поведение:
//   - dedup идентичных ошибок в окне 30 сек (один и тот же message+stack)
//   - rate-limit: max 5 запросов в минуту per session (защита от шторма)
//   - sendBeacon если доступен (надёжнее на unload), иначе fetch keepalive

interface ErrorPayload {
  source: "window" | "promise" | "react";
  message: string;
  stack?: string;
  url: string;
  userAgent: string;
  ts: number;
  pageName?: string;
}

const SENT_HASH_KEY = "_clientErr_sent";
const RATE_LIMIT = 5;
const RATE_WINDOW_MS = 60_000;
const DEDUP_WINDOW_MS = 30_000;

let sentTimestamps: number[] = [];
let recentHashes = new Map<string, number>();

function hashErr(msg: string, stack?: string): string {
  const s = `${msg}|${(stack || "").slice(0, 200)}`;
  let h = 0;
  for (let i = 0; i < s.length; i++) h = ((h << 5) - h + s.charCodeAt(i)) | 0;
  return h.toString(36);
}

function shouldSend(payload: ErrorPayload): boolean {
  const now = Date.now();
  // Dedup
  const hash = hashErr(payload.message, payload.stack);
  const last = recentHashes.get(hash);
  if (last && now - last < DEDUP_WINDOW_MS) return false;
  recentHashes.set(hash, now);
  // Очистка старых entries
  if (recentHashes.size > 100) {
    const keep = new Map<string, number>();
    recentHashes.forEach((ts, h) => { if (now - ts < DEDUP_WINDOW_MS) keep.set(h, ts); });
    recentHashes = keep;
  }
  // Rate-limit
  sentTimestamps = sentTimestamps.filter(t => now - t < RATE_WINDOW_MS);
  if (sentTimestamps.length >= RATE_LIMIT) return false;
  sentTimestamps.push(now);
  return true;
}

function send(payload: ErrorPayload): void {
  if (!shouldSend(payload)) return;
  try {
    const body = JSON.stringify(payload);
    if (typeof navigator !== "undefined" && (navigator as any).sendBeacon) {
      const blob = new Blob([body], { type: "application/json" });
      (navigator as any).sendBeacon("/api/client-errors", blob);
      return;
    }
    fetch("/api/client-errors", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body,
      keepalive: true,
    }).catch(() => {});
  } catch {}
}

export function reportClientError(opts: {
  source: ErrorPayload["source"];
  message: string;
  stack?: string;
  pageName?: string;
}): void {
  if (typeof window === "undefined") return;
  send({
    source: opts.source,
    message: opts.message.slice(0, 500),
    stack: opts.stack ? opts.stack.slice(0, 4000) : undefined,
    url: window.location.href.slice(0, 500),
    userAgent: navigator.userAgent.slice(0, 200),
    ts: Date.now(),
    pageName: opts.pageName,
  });
}

export function installClientErrorLogger(): void {
  if (typeof window === "undefined") return;
  if ((window as any).__muziaiErrLogger) return;
  (window as any).__muziaiErrLogger = true;

  window.addEventListener("error", (e: ErrorEvent) => {
    if (!e?.message) return;
    reportClientError({
      source: "window",
      message: e.message,
      stack: e.error?.stack,
    });
  });

  window.addEventListener("unhandledrejection", (e: PromiseRejectionEvent) => {
    const r = e?.reason;
    const msg = typeof r === "string" ? r : r?.message || String(r);
    reportClientError({
      source: "promise",
      message: msg,
      stack: r?.stack,
    });
  });
}
