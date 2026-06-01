// Eugene 2026-05-22 Босс «примени настоящую статистику в бэкэнде» — единый
// SQL-фильтр для исключения cron daily_country_bump seed-визитов везде где
// читается visitors.
//
// Seed-rows создаются раз в сутки скриптом dailyCountryBump() в routes.ts:12277.
// Они нужны для admin country-reach analytics, но завышают public-счётчики в 9×.
//
// Использование (с tagged template sql из drizzle):
//   sql`SELECT count(*) FROM visitors WHERE ${sinceCondition} AND ${REAL_VISITORS_COND}`
//
// Или для raw prepare/all:
//   raw.prepare(`SELECT ... FROM visitors WHERE ${REAL_VISITORS_SQL} AND ...`)

/** Сырая SQL-строка для использования в template literals (без drizzle tagged). */
export const REAL_VISITORS_SQL =
  "fingerprint NOT LIKE 'daily_%' AND ip != '0.0.0.0' AND user_agent IS NOT NULL AND user_agent != ''";

/** То же, но с префиксом v. для JOIN-aliased queries. */
export const REAL_VISITORS_SQL_ALIASED = (alias: string) =>
  `${alias}.fingerprint NOT LIKE 'daily_%' AND ${alias}.ip != '0.0.0.0' AND ${alias}.user_agent IS NOT NULL AND ${alias}.user_agent != ''`;
