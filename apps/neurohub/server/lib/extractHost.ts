// Eugene 2026-05-17 Босс: per-domain трекинг для muzaai.ru / muziai.ru /
// podaripesnu.ru. Универсальный helper для извлечения нормализованного
// хоста из любого Express-запроса.
//
// Источник: x-forwarded-host (nginx proxy) → host header → null.
// Нормализация: первый элемент CSV, lowercased, без `www.`, без `:port`.
//
// Применяется во ВСЕХ INSERT'ах в visitors / gen_activity /
// user_journey_events / chatbot_sessions (см. Eugene 2026-05-17 brief).
// См. также Period-20-MSK rule — host рядом с created_at идёт через те же
// фильтры в master-dashboard / funnels / visitor-stats.

import type { Request } from "express";

/**
 * Список «известных» бренд-доменов проекта. Всё что не из этого списка
 * (и не null) попадает в bucket "other" в admin-аналитике.
 */
export const KNOWN_DOMAINS = ["muzaai.ru", "muziai.ru", "podaripesnu.ru"] as const;

export type KnownDomain = (typeof KNOWN_DOMAINS)[number];
export type DomainBucket = KnownDomain | "other";

/**
 * Возвращает нормализованный host из запроса или null если headers отсутствуют.
 * Без port, без `www.`, lowercase.
 */
export function extractHost(req: Pick<Request, "headers"> | { headers: Record<string, unknown> } | null | undefined): string | null {
  if (!req || !req.headers) return null;
  const raw = (req.headers as any)["x-forwarded-host"] ?? (req.headers as any).host;
  if (!raw) return null;
  const first = String(raw).split(",")[0]?.trim().toLowerCase();
  if (!first) return null;
  // Убираем port и www-префикс.
  const noWww = first.replace(/^www\./, "");
  const noPort = noWww.split(":")[0];
  return noPort || null;
}

/**
 * Сводит произвольный host к bucket'у: один из KNOWN_DOMAINS или "other".
 * NULL/empty → "other".
 */
export function hostToBucket(host: string | null | undefined): DomainBucket {
  if (!host) return "other";
  const norm = host.toLowerCase().replace(/^www\./, "").split(":")[0];
  for (const d of KNOWN_DOMAINS) {
    if (norm === d) return d;
  }
  return "other";
}

/**
 * true если host входит в список известных бренд-доменов.
 */
export function isKnownDomain(host: string | null | undefined): host is KnownDomain {
  if (!host) return false;
  const norm = host.toLowerCase().replace(/^www\./, "").split(":")[0];
  return (KNOWN_DOMAINS as readonly string[]).includes(norm);
}
