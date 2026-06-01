// messageDebouncer (Eugene 2026-05-12 Босс): задержка 5 сек перед
// обработкой сообщения чата. Если юзер докидывает уточнение в течение
// 5 сек — все сообщения объединяются и обрабатываются как одно.
// Применяется к telegram-bot и max-bot.

const DEBOUNCE_MS = 5000;

type Pending<T> = {
  parts: string[];
  timer: NodeJS.Timeout;
  meta: T;
};

const pending = new Map<string, Pending<any>>();

// Buffer text. Если в течение 5 сек придёт ещё — таймер сбрасывается,
// текст докидывается. Когда тишина 5 сек — onFire вызывается с объединённым
// текстом и meta.
export function debounceMessage<T>(
  key: string,
  text: string,
  meta: T,
  onFire: (combinedText: string, meta: T) => void | Promise<void>,
): void {
  const existing = pending.get(key);
  if (existing) {
    clearTimeout(existing.timer);
    existing.parts.push(text);
    existing.timer = setTimeout(() => fire(key, onFire), DEBOUNCE_MS);
    // Updating meta to latest (newer message_id, etc)
    existing.meta = meta;
    return;
  }
  const entry: Pending<T> = {
    parts: [text],
    meta,
    timer: setTimeout(() => fire(key, onFire), DEBOUNCE_MS),
  };
  pending.set(key, entry);
}

function fire(key: string, onFire: (combinedText: string, meta: any) => void | Promise<void>) {
  const entry = pending.get(key);
  if (!entry) return;
  pending.delete(key);
  // Объединяем парты через ". " если несколько (юзер уточнил)
  const combined = entry.parts.length === 1 ? entry.parts[0] : entry.parts.join(". ");
  try { Promise.resolve(onFire(combined, entry.meta)).catch(() => {}); } catch {}
}

// Иногда нужно немедленно обработать (например /start, login).
export function bypassDebounce(key: string): void {
  const entry = pending.get(key);
  if (entry) {
    clearTimeout(entry.timer);
    pending.delete(key);
  }
}
