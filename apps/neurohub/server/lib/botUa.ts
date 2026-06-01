// Eugene 2026-05-18 Босс «автофильтр ботов из публичной статистики».
//
// Reuse-working-solutions rule: re-export pattern из shouldCountPlay в routes.ts
// (см. routes.ts:7466 — play-counting bot UA check). Здесь — единый источник
// для всей admin-аналитики: visitor-stats, gen-activity-geo, journey-summary,
// click-stats.
//
// КЛЮЧЕВОЕ:
//  - isBotUserAgent(ua) — TS-проверка (для in-process чек'ов).
//  - BOT_UA_SQL_PATTERN — массив substring'ов для SQL фильтра
//    (case-insensitive через LOWER()). Возвращает помощник
//    buildBotExclusionSql(column) который собирает AND ... NOT LIKE ...
//    цепочку для прямой подстановки в SQL (без bind, потому что
//    значения hard-coded).
//
// Записи в БД ОСТАЮТСЯ — фильтр только на чтении (admin endpoints).
// Это критично: bot-tracking нужен для аудита и для блокировок (см. blockedEntities).

// Список substring'ов, по которым отсеиваем bot UA.
// Регистр игнорируется на стороне SQL (через LOWER(user_agent)).
export const BOT_UA_SUBSTRINGS = [
  "bot",
  "crawler",
  "spider",
  "slurp",
  "curl",
  "wget",
  "httpie",
  "python-requests",
  "java-http",
  "axios",
  "fetch",
  "headlesschrome",
  "phantomjs",
  "scrapy",
  "lighthouse",
  "ahrefs",
  "semrush",
  "yandexbot",
  "googlebot",
  "bingbot",
  "applebot",
] as const;

// Regex для in-process проверки (используется в shouldCountPlay и
// requireNotBlocked middleware). \b на конце «curl|wget|fetch|head» — чтобы
// «fetch» не матчился внутри «WebKit-Fetch» (legit браузеры).
const BOT_UA_REGEX = /(bot|crawler|spider|slurp|curl|wget|httpie|python-requests|java-http|axios|fetch|head)\b/i;

/**
 * Проверка UA-строки на принадлежность боту.
 * Кейс-инсенситив. Пустая строка → false (нет UA — отдельный case).
 */
export function isBotUserAgent(ua: string | null | undefined): boolean {
  if (!ua) return false;
  return BOT_UA_REGEX.test(String(ua));
}

/**
 * Собирает SQL-фрагмент `LOWER(<column>) NOT LIKE '%bot%' AND ...` из
 * списка BOT_UA_SUBSTRINGS. Возвращает строку, готовую к подстановке в
 * WHERE-клозу через sql.raw() или прямой string-concat (значения hard-coded,
 * без user input — SQL injection невозможна).
 *
 * Пример: `WHERE ... AND ${buildBotExclusionSql('user_agent')}`.
 *
 * Если в таблице нет user_agent колонки — caller просто не вызывает helper.
 */
export function buildBotExclusionSql(column: string): string {
  // Защита от code injection: column хардкодим в caller, но всё равно
  // ограничиваем формат (буквы/цифры/подчёркивание/точка).
  const safeColumn = String(column).replace(/[^a-zA-Z0-9_.]/g, "");
  if (!safeColumn) return "1=1";
  const conditions = BOT_UA_SUBSTRINGS.map(
    (s) => `LOWER(${safeColumn}) NOT LIKE '%${s}%'`,
  ).join(" AND ");
  // Дополнительно: NULL UA пропускаем как «не bot» (анонимные мобильные клиенты).
  return `(${safeColumn} IS NULL OR (${conditions}))`;
}

/**
 * Тот же фильтр, но в инвертированном виде («это бот»). Используется
 * редко — например для отдельного admin-эндпоинта «показать только ботов».
 */
export function buildBotInclusionSql(column: string): string {
  const safeColumn = String(column).replace(/[^a-zA-Z0-9_.]/g, "");
  if (!safeColumn) return "1=0";
  const conditions = BOT_UA_SUBSTRINGS.map(
    (s) => `LOWER(${safeColumn}) LIKE '%${s}%'`,
  ).join(" OR ");
  return `(${safeColumn} IS NOT NULL AND (${conditions}))`;
}
