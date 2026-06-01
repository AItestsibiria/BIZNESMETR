// Eugene 2026-05-17 Босс: cut-off дня = 20:00 МСК (UTC+3 = 17:00 UTC).
//
// «Сегодня» = с 20:00 МСК вчерашнего календарного дня до 20:00 МСК сегодня
// (или до текущего момента если 20:00 ещё не наступило).
// «Вчера» = с 20:00 МСК позапрошлого дня до 20:00 МСК вчера.
// «Неделя/Месяц/Год» = соответственно от now-7d/30d/365d (rolling) до now.
// «month-N» (N=1..12) = период текущего года от 1 числа месяца N в 20:00 МСК
// до 1 числа месяца N+1 в 20:00 МСК.
//
// Все endpoint'ы аналитики должны использовать `getPeriodRange(period)` —
// см. правило «Period-20-MSK rule» в CLAUDE.md.

const MSK_OFFSET_HOURS = 3;
const CUTOFF_HOUR_MSK = 20;

export type PeriodId =
  | "today"
  | "yesterday"
  | "7d"
  | "30d"
  | "365d"
  | "all"
  // Back-compat для существующих UI / endpoint'ов:
  | "week"      // alias "7d"
  | "month"     // alias "30d"
  | "year"      // alias "365d"
  | "day"       // alias "today"
  | "custom"
  // Месяцы текущего года (1..12).
  | "month-1"
  | "month-2"
  | "month-3"
  | "month-4"
  | "month-5"
  | "month-6"
  | "month-7"
  | "month-8"
  | "month-9"
  | "month-10"
  | "month-11"
  | "month-12";

export interface PeriodRange {
  fromIso: string;  // включительно (>=)
  toIso: string;    // исключительно (<)
  label: string;
  id: PeriodId;
}

const MONTH_LABELS = [
  "Янв", "Фев", "Мар", "Апр", "Май", "Июн",
  "Июл", "Авг", "Сен", "Окт", "Ноя", "Дек",
];

/**
 * Возвращает [fromIso, toIso) — границы периода в ISO UTC.
 * Все аналитические запросы должны использовать ТОЛЬКО этот helper.
 */
export function getPeriodRange(
  period: PeriodId | string | null | undefined,
  customFrom?: string,
  customTo?: string,
): PeriodRange {
  const p = normalizePeriodId(period);
  const now = new Date();
  const nowUtcMs = now.getTime();

  // todayCutoff = ближайший прошедший момент «20:00 МСК сегодня (по МСК)».
  // 20:00 МСК = 17:00 UTC.
  const todayCutoff = new Date(now);
  todayCutoff.setUTCHours(CUTOFF_HOUR_MSK - MSK_OFFSET_HOURS, 0, 0, 0);
  if (todayCutoff.getTime() > nowUtcMs) {
    // 20:00 МСК ещё не наступило — сегодняшний cut-off это вчерашний 20:00.
    todayCutoff.setUTCDate(todayCutoff.getUTCDate() - 1);
  }
  const yesterdayCutoff = new Date(todayCutoff.getTime() - 24 * 3600 * 1000);
  const dayBeforeCutoff = new Date(yesterdayCutoff.getTime() - 24 * 3600 * 1000);

  switch (p) {
    case "today":
    case "day": {
      // от вчерашнего 20:00 МСК до сегодняшнего 20:00 МСК (или до текущего
      // момента, если 20:00 ещё не наступило — тогда верхняя граница = now).
      const toMs = Math.min(
        todayCutoff.getTime() + 24 * 3600 * 1000,
        nowUtcMs,
      );
      return {
        fromIso: yesterdayCutoff.toISOString(),
        toIso: new Date(toMs).toISOString(),
        label: "Сегодня",
        id: "today",
      };
    }
    case "yesterday":
      return {
        fromIso: dayBeforeCutoff.toISOString(),
        toIso: yesterdayCutoff.toISOString(),
        label: "Вчера",
        id: "yesterday",
      };
    case "7d":
    case "week":
      return {
        fromIso: new Date(nowUtcMs - 7 * 24 * 3600 * 1000).toISOString(),
        toIso: now.toISOString(),
        label: "Неделя",
        id: "7d",
      };
    case "30d":
    case "month":
      return {
        fromIso: new Date(nowUtcMs - 30 * 24 * 3600 * 1000).toISOString(),
        toIso: now.toISOString(),
        label: "Месяц",
        id: "30d",
      };
    case "365d":
    case "year":
      return {
        fromIso: new Date(nowUtcMs - 365 * 24 * 3600 * 1000).toISOString(),
        toIso: now.toISOString(),
        label: "Год",
        id: "365d",
      };
    case "all":
      return {
        fromIso: "2024-01-01T00:00:00.000Z",
        toIso: now.toISOString(),
        label: "Всё время",
        id: "all",
      };
    case "custom":
      if (customFrom && isValidIso(customFrom) && customTo && isValidIso(customTo)) {
        return {
          fromIso: customFrom,
          toIso: customTo,
          label: "Период",
          id: "custom",
        };
      }
      // Custom без валидных bounds — fallback на «сегодня».
      return getPeriodRange("today");
    default:
      // month-N для N=1..12 (текущий год).
      if (typeof p === "string" && p.startsWith("month-")) {
        const monthNum = parseInt(p.slice(6), 10);
        if (Number.isFinite(monthNum) && monthNum >= 1 && monthNum <= 12) {
          const year = now.getUTCFullYear();
          // Месяц начинается 1 числа в 20:00 МСК = 17:00 UTC.
          const fromDate = new Date(
            Date.UTC(year, monthNum - 1, 1, CUTOFF_HOUR_MSK - MSK_OFFSET_HOURS, 0, 0, 0),
          );
          const toDate = new Date(
            Date.UTC(year, monthNum, 1, CUTOFF_HOUR_MSK - MSK_OFFSET_HOURS, 0, 0, 0),
          );
          return {
            fromIso: fromDate.toISOString(),
            toIso: toDate.toISOString(),
            label: MONTH_LABELS[monthNum - 1],
            id: p as PeriodId,
          };
        }
      }
      // Unknown period — fallback на «сегодня».
      return getPeriodRange("today");
  }
}

/**
 * Нормализует строку period в PeriodId. Возвращает 'today' для unknown.
 */
export function normalizePeriodId(raw: unknown): PeriodId {
  const s = String(raw || "").toLowerCase();
  const valid: PeriodId[] = [
    "today", "yesterday", "7d", "30d", "365d", "all",
    "week", "month", "year", "day", "custom",
    "month-1", "month-2", "month-3", "month-4", "month-5", "month-6",
    "month-7", "month-8", "month-9", "month-10", "month-11", "month-12",
  ];
  if (valid.includes(s as PeriodId)) return s as PeriodId;
  return "today";
}

/**
 * Удобный SQL-фрагмент для WHERE clause:
 *   `${column} >= '<fromIso>' AND ${column} < '<toIso>'`
 *
 * ВНИМАНИЕ: интерполирует ISO-строки в SQL. ISO-формат — фиксированный,
 * не зависит от user input (helper генерирует bounds сам). Безопасно
 * только если `column` — это литерал кода (НЕ user input).
 */
export function periodSqlFilter(
  period: PeriodId | string,
  column: string = "created_at",
  customFrom?: string,
  customTo?: string,
): string {
  const range = getPeriodRange(period, customFrom, customTo);
  return `${column} >= '${range.fromIso}' AND ${column} < '${range.toIso}'`;
}

/**
 * Список всех поддерживаемых period ID для UI.
 */
export function listPeriodIds(): Array<{ id: PeriodId; label: string }> {
  return [
    { id: "today", label: "Сегодня" },
    { id: "yesterday", label: "Вчера" },
    { id: "7d", label: "Неделя" },
    { id: "30d", label: "Месяц" },
    { id: "365d", label: "Год" },
    { id: "all", label: "Всё время" },
    { id: "month-1", label: "Янв" },
    { id: "month-2", label: "Фев" },
    { id: "month-3", label: "Мар" },
    { id: "month-4", label: "Апр" },
    { id: "month-5", label: "Май" },
    { id: "month-6", label: "Июн" },
    { id: "month-7", label: "Июл" },
    { id: "month-8", label: "Авг" },
    { id: "month-9", label: "Сен" },
    { id: "month-10", label: "Окт" },
    { id: "month-11", label: "Ноя" },
    { id: "month-12", label: "Дек" },
  ];
}

function isValidIso(s: string): boolean {
  if (typeof s !== "string" || s.length < 8 || s.length > 40) return false;
  const t = Date.parse(s);
  return Number.isFinite(t);
}
