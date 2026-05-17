// User journey tracker (Eugene 2026-05-17 Босс).
//
// Карта пути юзера от захода до выхода. Собирает события на клиенте,
// буферит в очередь, шлёт batch'ами на /api/journey/batch каждые 5 сек.
//
// События:
// - page_view      — каждое изменение location (hash routing wouter)
// - click          — global delegation на `<button>`, `<a>`, `[data-track]`
// - scroll_percent — throttled (1 раз / 5 сек) текущий scroll%
// - idle_30s       — 30 сек без mouse/keyboard activity (1 раз per page)
// - form_focus     — focus на <input>/<textarea> (1 раз per element per page)
// - form_abandon   — форма touched но не submitted после 60 сек
// - leave          — beforeunload event (sendBeacon чтобы не потерять)
//
// sessionKey — uuid в localStorage (живёт между визитами для cross-session
// linking). Если localStorage недоступен — fallback на sessionStorage,
// если и его нет — in-memory (не persisted, но трекинг работает).
//
// Также эмитит local event 'user-journey:event' в window для подписчиков
// (smart Муза-триггер слушает idle/form events, чтобы появиться).
//
// PII: НЕ пишем value инпутов в meta (только elemId + page).
// sensitive pages: /admin/* — backend всё равно отфильтрует, но не шлём.

const SK_KEY = "_journeySessionKey";
const FLUSH_INTERVAL_MS = 5_000;
const IDLE_THRESHOLD_MS = 30_000;
const FORM_ABANDON_MS = 60_000;
const SCROLL_THROTTLE_MS = 5_000;

export type JourneyEventType =
  | "page_view"
  | "click"
  | "scroll_percent"
  | "idle_30s"
  | "form_focus"
  | "form_abandon"
  | "leave";

export interface JourneyEvent {
  type: JourneyEventType;
  page: string;
  meta?: Record<string, any>;
  ts: number;
}

let _sessionKey: string | null = null;
let _queue: JourneyEvent[] = [];
let _installed = false;
let _flushTimer: number | null = null;
let _lastActivityAt = Date.now();
let _idleFiredThisPage = false;
let _lastScrollPercentAt = 0;
let _currentPage = "";
let _focusedFormElement: HTMLElement | null = null;
let _formTouchedAt = 0;
let _formAbandonTimer: number | null = null;
let _formAbandonFiredThisFocus = false;
let _focusedElementsThisPage = new Set<string>();

function getOrCreateSessionKey(): string {
  if (_sessionKey) return _sessionKey;
  try {
    const cached = localStorage.getItem(SK_KEY);
    if (cached && cached.length >= 8) {
      _sessionKey = cached;
      return cached;
    }
  } catch {}
  // Generate uuid (v4-like, не криптографически идеальный но достаточный).
  let uuid: string;
  try {
    if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
      uuid = crypto.randomUUID();
    } else {
      uuid = Math.random().toString(36).slice(2, 14) + "-" +
             Math.random().toString(36).slice(2, 14) + "-" +
             Date.now().toString(36);
    }
  } catch {
    uuid = Math.random().toString(36).slice(2, 14) + "-" + Date.now().toString(36);
  }
  try { localStorage.setItem(SK_KEY, uuid); } catch {}
  _sessionKey = uuid;
  return uuid;
}

function currentPagePath(): string {
  // hash routing — path в #/foo, основной location.pathname часто "/".
  // Берём hash сначала (это реальный routing), fallback на pathname.
  try {
    const h = window.location.hash || "";
    if (h.startsWith("#/")) {
      // Срезаем query-string из hash (`#/music?foo=bar` → `/music`).
      const path = h.slice(1).split("?")[0].split("#")[0];
      return path || "/";
    }
    return window.location.pathname || "/";
  } catch {
    return "/";
  }
}

// Public: эмит локального события для других модулей (smart Муза).
function emitLocal(type: JourneyEventType, meta?: Record<string, any>) {
  try {
    const ev = new CustomEvent("user-journey:event", { detail: { type, meta, page: _currentPage } });
    window.dispatchEvent(ev);
  } catch {}
}

function enqueue(type: JourneyEventType, meta?: Record<string, any>, page?: string) {
  if (!_installed) return;
  const p = page || _currentPage || currentPagePath();
  // Не пишем admin-зону (backend всё равно фильтрует, но экономим траффик).
  if (p.startsWith("/admin")) return;
  _queue.push({ type, page: p, meta, ts: Date.now() });
  emitLocal(type, meta);
}

async function flush(useBeacon = false) {
  if (_queue.length === 0) return;
  const events = _queue.splice(0, 50); // max 50/batch (соответствует backend)
  const body = JSON.stringify({
    sessionKey: getOrCreateSessionKey(),
    events: events.map(e => ({ type: e.type, page: e.page, meta: e.meta, ts: e.ts })),
  });
  // beforeunload → sendBeacon (надёжнее, не блокирует выход).
  if (useBeacon && typeof navigator !== "undefined" && typeof navigator.sendBeacon === "function") {
    try {
      const blob = new Blob([body], { type: "application/json" });
      navigator.sendBeacon("/api/journey/batch", blob);
      return;
    } catch {}
  }
  try {
    await fetch("/api/journey/batch", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body,
      credentials: "same-origin",
      keepalive: true,
    });
  } catch {
    // Если упало — события потеряны (не помещаем обратно чтобы не зациклить
    // failures). При следующем flush'е соберём новые.
  }
}

function recordActivity() {
  _lastActivityAt = Date.now();
}

function setupPageView() {
  const path = currentPagePath();
  if (path === _currentPage) return;
  _currentPage = path;
  _idleFiredThisPage = false;
  _focusedElementsThisPage.clear();
  if (_formAbandonTimer) {
    window.clearTimeout(_formAbandonTimer);
    _formAbandonTimer = null;
  }
  _focusedFormElement = null;
  _formTouchedAt = 0;
  _formAbandonFiredThisFocus = false;
  enqueue("page_view", { referrer: document.referrer || undefined }, path);
}

function onClick(ev: MouseEvent) {
  recordActivity();
  try {
    const t = ev.target as HTMLElement | null;
    if (!t) return;
    // Найдём ближайший трекаемый элемент: [data-track], <button>, <a>.
    const trackable = t.closest("[data-track], button, a") as HTMLElement | null;
    if (!trackable) return;
    // Без излишних PII: ID, классы (короткий), data-track value, тег.
    const meta: Record<string, any> = {
      tag: trackable.tagName.toLowerCase(),
      id: trackable.id ? trackable.id.slice(0, 60) : undefined,
      dataTrack: trackable.getAttribute("data-track")?.slice(0, 60) || undefined,
      text: trackable.tagName === "BUTTON" || trackable.tagName === "A"
        ? (trackable.textContent || "").trim().slice(0, 60) || undefined
        : undefined,
      // Маркер mouse / touch (mobile/desktop сегментация).
      pointerType: (ev as any).pointerType || (ev.type === "click" ? "mouse" : "touch"),
    };
    // Координаты — только если есть смысл (heatmap).
    if (typeof ev.clientX === "number") {
      meta.x = Math.round(ev.clientX);
      meta.y = Math.round(ev.clientY);
    }
    enqueue("click", meta);
  } catch {}
}

function onScroll() {
  recordActivity();
  const now = Date.now();
  if (now - _lastScrollPercentAt < SCROLL_THROTTLE_MS) return;
  _lastScrollPercentAt = now;
  try {
    const doc = document.documentElement;
    const body = document.body;
    const scrollTop = window.scrollY || doc.scrollTop || body.scrollTop || 0;
    const scrollHeight = (doc.scrollHeight || body.scrollHeight || 0) - (doc.clientHeight || window.innerHeight);
    const percent = scrollHeight > 0 ? Math.min(100, Math.max(0, Math.round((scrollTop / scrollHeight) * 100))) : 0;
    enqueue("scroll_percent", { percent });
  } catch {}
}

function checkIdle() {
  if (_idleFiredThisPage) return;
  const now = Date.now();
  if (now - _lastActivityAt >= IDLE_THRESHOLD_MS) {
    _idleFiredThisPage = true;
    enqueue("idle_30s", { sinceLastActivityMs: now - _lastActivityAt });
  }
}

function isFormElement(el: EventTarget | null): el is HTMLElement {
  if (!el) return false;
  const tag = (el as HTMLElement).tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT";
}

function onFocusIn(ev: FocusEvent) {
  recordActivity();
  if (!isFormElement(ev.target)) return;
  const el = ev.target as HTMLElement;
  // Пропускаем password / hidden (privacy).
  const type = (el as HTMLInputElement).type;
  if (type === "password" || type === "hidden") return;
  const elemKey = el.id || (el as HTMLInputElement).name || el.getAttribute("data-track") || el.tagName;
  if (_focusedElementsThisPage.has(elemKey)) {
    // Уже логировали focus этого элемента на этой странице — re-focus.
    _focusedFormElement = el;
    return;
  }
  _focusedElementsThisPage.add(elemKey);
  _focusedFormElement = el;
  _formTouchedAt = Date.now();
  _formAbandonFiredThisFocus = false;
  enqueue("form_focus", {
    elem: elemKey.slice(0, 60),
    inputType: type || undefined,
  });
  // Запускаем таймер abandon — если за 60 сек не submit и не blur с пустым полем.
  if (_formAbandonTimer) window.clearTimeout(_formAbandonTimer);
  _formAbandonTimer = window.setTimeout(() => {
    if (_formAbandonFiredThisFocus) return;
    if (!_focusedFormElement) return;
    try {
      const val = (_focusedFormElement as HTMLInputElement).value || "";
      if (val.length > 0) {
        _formAbandonFiredThisFocus = true;
        enqueue("form_abandon", {
          elem: elemKey.slice(0, 60),
          // Длина введённого — без самого value (PII).
          valueLen: val.length,
          dwellMs: Date.now() - _formTouchedAt,
        });
      }
    } catch {}
  }, FORM_ABANDON_MS) as unknown as number;
}

function onFormSubmit() {
  // На submit — отменяем abandon timer (юзер не бросил).
  if (_formAbandonTimer) {
    window.clearTimeout(_formAbandonTimer);
    _formAbandonTimer = null;
  }
  _formAbandonFiredThisFocus = true;
}

function onBeforeUnload() {
  // Финальный leave + flush через sendBeacon.
  enqueue("leave", { sessionMs: Date.now() - (window as any).__journeyStartedAt });
  flush(true).catch(() => {});
}

function onHashChange() {
  setupPageView();
}

/**
 * Устанавливает глобальный journey tracker.
 * Вызывается из main.tsx. Idempotent — second call no-op.
 */
export function installUserJourney(): void {
  if (_installed) return;
  if (typeof window === "undefined" || typeof document === "undefined") return;
  _installed = true;
  (window as any).__journeyStartedAt = Date.now();

  // Активность (для idle detection): mouse/keyboard/touch.
  const activityEvents: (keyof DocumentEventMap)[] = [
    "mousemove", "keydown", "pointerdown", "touchstart", "wheel",
  ];
  for (const e of activityEvents) {
    document.addEventListener(e, recordActivity, { passive: true });
  }

  // Click delegation.
  document.addEventListener("click", onClick, { passive: true, capture: true });

  // Scroll (throttled).
  window.addEventListener("scroll", onScroll, { passive: true });

  // Form focus / submit.
  document.addEventListener("focusin", onFocusIn, true);
  document.addEventListener("submit", onFormSubmit, true);

  // Hash-route change (wouter useHashLocation).
  window.addEventListener("hashchange", onHashChange);
  // Popstate fallback для не-hash routing'а.
  window.addEventListener("popstate", onHashChange);

  // Idle check tick (каждые 10 сек).
  window.setInterval(checkIdle, 10_000);

  // Periodic flush.
  _flushTimer = window.setInterval(() => { flush(false).catch(() => {}); }, FLUSH_INTERVAL_MS) as unknown as number;

  // Visibility leave (юзер свернул tab) — flush через beacon.
  window.addEventListener("beforeunload", onBeforeUnload);
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") {
      flush(true).catch(() => {});
    }
  });

  // Первичный page_view.
  setupPageView();
}

/**
 * Public API для подписки на journey events (smart-триггеры Музы).
 * Хендлер получает { type, meta, page }.
 */
export function onJourneyEvent(
  handler: (detail: { type: JourneyEventType; meta?: Record<string, any>; page: string }) => void
): () => void {
  const wrapped = (ev: Event) => {
    try {
      const detail = (ev as CustomEvent).detail;
      if (detail) handler(detail);
    } catch {}
  };
  window.addEventListener("user-journey:event", wrapped);
  return () => window.removeEventListener("user-journey:event", wrapped);
}

/** Returns current session-key (or generates one). */
export function getJourneySessionKey(): string {
  return getOrCreateSessionKey();
}
