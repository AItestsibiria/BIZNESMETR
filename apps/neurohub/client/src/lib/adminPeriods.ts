// Eugene 2026-05-30 единая шкала периодов для admin tabs (Period-20-MSK rule).
// Канонический набор chip'ов идентичен ferz-tab.tsx.
//
// Источник правды на сервере: apps/neurohub/server/lib/periodBoundaries.ts.
// На клиенте chip'ы шлют id (`today`, `yesterday`, `week`, `month`, `year`, `all`)
// серверу как `?period=<id>`. Если конкретный endpoint не понимает `period` —
// фильтрация делается на клиенте по createdAt.

export type PeriodId = "today" | "yesterday" | "week" | "month" | "year" | "all";

export interface PeriodOption {
  id: PeriodId;
  label: string;
}

export const ADMIN_PERIODS: PeriodOption[] = [
  { id: "today", label: "Сегодня" },
  { id: "yesterday", label: "Вчера" },
  { id: "week", label: "Неделя" },
  { id: "month", label: "Месяц" },
  { id: "year", label: "Год" },
  { id: "all", label: "Всё время" },
];

const MSK_OFFSET_HOURS = 3;
const CUTOFF_HOUR_MSK = 20;

/**
 * Возвращает {fromMs, toMs} — границы периода в millis (UTC).
 * Cut-off 20:00 МСК совпадает с server-side getPeriodRange().
 */
export function periodToBounds(period: PeriodId): { fromMs: number; toMs: number } {
  const now = Date.now();
  const cutoffUtcHour = CUTOFF_HOUR_MSK - MSK_OFFSET_HOURS; // 17 UTC

  // последний 20:00 МСК (если ещё не наступило — вчерашний)
  const nowDate = new Date(now);
  const todayCutoffUtc = Date.UTC(
    nowDate.getUTCFullYear(),
    nowDate.getUTCMonth(),
    nowDate.getUTCDate(),
    cutoffUtcHour, 0, 0,
  );
  const lastCutoff = todayCutoffUtc > now ? todayCutoffUtc - 24 * 3600 * 1000 : todayCutoffUtc;

  switch (period) {
    case "today":
      return { fromMs: lastCutoff, toMs: now };
    case "yesterday":
      return { fromMs: lastCutoff - 24 * 3600 * 1000, toMs: lastCutoff };
    case "week":
      return { fromMs: now - 7 * 24 * 3600 * 1000, toMs: now };
    case "month":
      return { fromMs: now - 30 * 24 * 3600 * 1000, toMs: now };
    case "year":
      return { fromMs: now - 365 * 24 * 3600 * 1000, toMs: now };
    case "all":
      return { fromMs: 0, toMs: now };
    default:
      return { fromMs: lastCutoff, toMs: now };
  }
}

/**
 * Удобный фильтр для in-memory массивов: возвращает только записи,
 * у которых createdAt входит в выбранный период.
 *
 * Поддерживает createdAt как millis-number, ISO-string или unix-секунды.
 */
export function filterByPeriod<T>(
  items: T[],
  period: PeriodId,
  getCreatedAt: (item: T) => number | string | null | undefined,
): T[] {
  if (period === "all") return items;
  const { fromMs, toMs } = periodToBounds(period);
  return items.filter((it) => {
    const raw = getCreatedAt(it);
    if (raw == null) return false;
    let ms: number;
    if (typeof raw === "number") {
      ms = raw < 1e12 ? raw * 1000 : raw; // секунды → millis
    } else {
      ms = Date.parse(raw);
    }
    if (!Number.isFinite(ms)) return false;
    return ms >= fromMs && ms <= toMs;
  });
}

export function periodLabel(period: PeriodId): string {
  return ADMIN_PERIODS.find((p) => p.id === period)?.label || period;
}
