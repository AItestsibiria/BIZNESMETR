// Eugene 2026-05-20 Босс «архив тарифов с датами + админ меняет стоимость с текущей даты».
//
// Текущая цена = последняя запись tariff_history WHERE effective_from <= now
// для конкретного service_type. Helper кэширует значение 30 сек (cache invalidate
// при setTariff).
//
// API:
//   getCurrentPriceKopecks(serviceType): number
//   getCurrentPriceLabel(serviceType): string ("399 ₽")
//   setTariff({serviceType, priceKopecks, effectiveFrom, setByUserId, notes}): {ok, id}
//   getTariffHistory(serviceType?, limit?): TariffHistory[]
//
// При отсутствии записи возвращает FALLBACK_PRICES (legacy hardcoded).

import { db } from "../storage";
import { tariffHistory } from "@shared/schema";
import { eq, desc, and, lte, sql } from "drizzle-orm";

// Legacy fallback (если БД пуста — но seed в storage.ts создаёт записи)
const FALLBACK_PRICES: Record<string, number> = {
  music: 39900,        // 399 ₽
  lyrics: 9900,        // 99 ₽
  cover: 9900,         // 99 ₽
  audio_cover: 39900,  // 399 ₽
};

const FALLBACK_LABELS: Record<string, string> = {
  music: "399 ₽",
  lyrics: "99 ₽",
  cover: "99 ₽",
  audio_cover: "399 ₽",
};

interface CacheEntry {
  priceKopecks: number;
  cachedAt: number;
}

const cache = new Map<string, CacheEntry>();
const CACHE_TTL_MS = 30_000;

function invalidateCache(serviceType?: string): void {
  if (serviceType) cache.delete(serviceType);
  else cache.clear();
}

/**
 * Возвращает текущую цену для serviceType в копейках.
 * Кэш 30 сек. При БД-ошибке fallback на FALLBACK_PRICES.
 */
export function getCurrentPriceKopecks(serviceType: string): number {
  const cached = cache.get(serviceType);
  if (cached && Date.now() - cached.cachedAt < CACHE_TTL_MS) {
    return cached.priceKopecks;
  }
  try {
    const nowIso = new Date().toISOString();
    const row = db.select()
      .from(tariffHistory)
      .where(and(
        eq(tariffHistory.serviceType, serviceType),
        lte(tariffHistory.effectiveFrom, nowIso),
      ))
      .orderBy(desc(tariffHistory.effectiveFrom))
      .limit(1)
      .get() as any;
    const price = row?.priceKopecks ?? FALLBACK_PRICES[serviceType] ?? 9900;
    cache.set(serviceType, { priceKopecks: price, cachedAt: Date.now() });
    return price;
  } catch (e: any) {
    console.warn(`[pricing] read failed for ${serviceType}:`, e?.message || e);
    return FALLBACK_PRICES[serviceType] ?? 9900;
  }
}

export function getCurrentPriceLabel(serviceType: string): string {
  const kopecks = getCurrentPriceKopecks(serviceType);
  return `${Math.round(kopecks / 100)} ₽`;
}

/**
 * Set new tariff. effective_from — ISO дата (может быть в будущем).
 * Не удаляет старые записи — они нужны для archive.
 */
export function setTariff(opts: {
  serviceType: string;
  priceKopecks: number;
  effectiveFrom?: string;
  setByUserId?: number | null;
  notes?: string;
}): { ok: boolean; id?: number; error?: string } {
  try {
    if (!opts.serviceType || opts.priceKopecks < 0) {
      return { ok: false, error: "invalid args" };
    }
    const effectiveFrom = opts.effectiveFrom || new Date().toISOString();
    const result = db.insert(tariffHistory).values({
      serviceType: opts.serviceType,
      priceKopecks: opts.priceKopecks,
      effectiveFrom,
      setByUserId: opts.setByUserId ?? null,
      notes: opts.notes ?? null,
      createdAt: new Date().toISOString(),
    } as any).run();
    invalidateCache(opts.serviceType);
    return { ok: true, id: Number(result.lastInsertRowid) };
  } catch (e: any) {
    return { ok: false, error: String(e?.message || e) };
  }
}

/**
 * История тарифов. По умолчанию — все типы, последние 100 записей.
 */
export function getTariffHistory(opts: {
  serviceType?: string;
  limit?: number;
} = {}): any[] {
  try {
    const lim = Math.min(500, Math.max(1, opts.limit || 100));
    let q = db.select().from(tariffHistory).$dynamic();
    if (opts.serviceType) {
      q = q.where(eq(tariffHistory.serviceType, opts.serviceType));
    }
    return q.orderBy(desc(tariffHistory.effectiveFrom)).limit(lim).all() as any[];
  } catch (e: any) {
    console.warn(`[pricing] history read failed:`, e?.message || e);
    return [];
  }
}

/**
 * Все актуальные тарифы (по одному на service_type — самый последний).
 */
export function getAllCurrentTariffs(): Array<{ serviceType: string; priceKopecks: number; priceLabel: string; effectiveFrom: string; setByUserId: number | null; notes: string | null }> {
  try {
    // Все service_types из истории + fallback
    const allTypes = new Set([...Object.keys(FALLBACK_PRICES)]);
    try {
      const rows = db.select({ st: tariffHistory.serviceType })
        .from(tariffHistory)
        .groupBy(tariffHistory.serviceType)
        .all() as any[];
      rows.forEach(r => allTypes.add(r.st));
    } catch {}

    const result: any[] = [];
    const nowIso = new Date().toISOString();
    for (const st of allTypes) {
      try {
        const row = db.select()
          .from(tariffHistory)
          .where(and(
            eq(tariffHistory.serviceType, st),
            lte(tariffHistory.effectiveFrom, nowIso),
          ))
          .orderBy(desc(tariffHistory.effectiveFrom))
          .limit(1)
          .get() as any;
        if (row) {
          result.push({
            serviceType: st,
            priceKopecks: row.priceKopecks,
            priceLabel: `${Math.round(row.priceKopecks / 100)} ₽`,
            effectiveFrom: row.effectiveFrom,
            setByUserId: row.setByUserId,
            notes: row.notes,
          });
        } else {
          result.push({
            serviceType: st,
            priceKopecks: FALLBACK_PRICES[st] ?? 9900,
            priceLabel: FALLBACK_LABELS[st] ?? `${Math.round((FALLBACK_PRICES[st] ?? 9900) / 100)} ₽`,
            effectiveFrom: "1970-01-01T00:00:00Z",
            setByUserId: null,
            notes: "fallback (no tariff_history row)",
          });
        }
      } catch {}
    }
    return result;
  } catch (e: any) {
    console.warn(`[pricing] getAllCurrentTariffs failed:`, e?.message || e);
    return Object.keys(FALLBACK_PRICES).map(st => ({
      serviceType: st,
      priceKopecks: FALLBACK_PRICES[st],
      priceLabel: FALLBACK_LABELS[st],
      effectiveFrom: "1970-01-01T00:00:00Z",
      setByUserId: null,
      notes: "fallback (error)",
    }));
  }
}
