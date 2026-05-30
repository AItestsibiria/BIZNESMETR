// Eugene 2026-05-18 Босс «ручная блокировка по IP / userId / country / UA по
// жалобе». Анти-abuse / спам-защита. Анализ работает на in-memory cache —
// проверка `isBlocked()` отрабатывает за наносекунды (~5 минут TTL).
//
// Таблица `blocked_entities` (см. storage.ts auto-migrate):
//   - type: 'ip' | 'user' | 'country' | 'ua_substring'
//   - value: значение (IP / userId как строка / country-code / UA substring)
//   - reason: для аудита (опционально)
//   - blocked_by: userId админа
//   - expires_at: NULL = permanent, иначе unix-ms
//   - active: 1 = действует, 0 = soft-unblocked
//
// Поток проверки IP:
//   1. Извлекаем clean IP из req.ip / X-Forwarded-For
//   2. Сверяем с кэшем активных IP-блокировок
//   3. Если есть user-id (Bearer / sessions) — проверяем user-block
//   4. Через ipGeo cache получаем countryCode — проверяем country-block
//   5. UA — substring match
//
// Cache invalidation: TTL 5 мин ИЛИ ручной `invalidateBlocksCache()` после
// add/remove (см. POST/DELETE handlers).

import type { Request } from "express";
import { sqliteDb } from "../storage";
import { getIpGeo } from "./ipGeo";
import { isBotUserAgent } from "./botUa";

export type BlockType = "ip" | "user" | "country" | "ua_substring";

export interface BlockedEntityRow {
  id: number;
  type: BlockType;
  value: string;
  reason: string | null;
  blockedBy: number | null;
  createdAt: number;
  expiresAt: number | null;
  active: number;
}

export interface BlockResult {
  blocked: boolean;
  type?: BlockType;
  reason?: string;
  matchedValue?: string;
  blockId?: number;
}

interface CacheShape {
  byIp: Map<string, BlockedEntityRow>;
  byUser: Map<string, BlockedEntityRow>;
  byCountry: Map<string, BlockedEntityRow>;
  uaSubstrings: BlockedEntityRow[];
  loadedAt: number;
}

let cache: CacheShape | null = null;
const CACHE_TTL_MS = 5 * 60 * 1000;

function loadCache(): CacheShape {
  const now = Date.now();
  const rows = sqliteDb
    .prepare(
      `SELECT id, type, value, reason, blocked_by as blockedBy,
              created_at as createdAt, expires_at as expiresAt, active
       FROM blocked_entities
       WHERE active = 1
         AND (expires_at IS NULL OR expires_at > ?)`,
    )
    .all(now) as BlockedEntityRow[];

  const next: CacheShape = {
    byIp: new Map(),
    byUser: new Map(),
    byCountry: new Map(),
    uaSubstrings: [],
    loadedAt: now,
  };

  for (const r of rows) {
    const v = String(r.value || "").trim();
    if (!v) continue;
    if (r.type === "ip") next.byIp.set(v, r);
    else if (r.type === "user") next.byUser.set(v, r);
    else if (r.type === "country") next.byCountry.set(v.toUpperCase(), r);
    else if (r.type === "ua_substring") next.uaSubstrings.push(r);
  }
  cache = next;
  return next;
}

function getCache(): CacheShape {
  if (!cache || Date.now() - cache.loadedAt > CACHE_TTL_MS) {
    return loadCache();
  }
  return cache;
}

export function invalidateBlocksCache(): void {
  cache = null;
}

function cleanIp(raw: unknown): string {
  if (!raw) return "";
  const s = String(raw).split(",")[0].trim();
  return s.replace(/^::ffff:/, "");
}

/**
 * Проверка req на блокировку. Sync для большинства случаев (IP / user / UA),
 * async только при необходимости определить country через ipGeo (если IP не
 * закэширован — но мы используем уже-кэшированную запись из visitors при
 * наличии).
 *
 * Принимает req.ip + req.headers + (req as any).userId.
 */
export async function isBlocked(req: Request): Promise<BlockResult> {
  const c = getCache();
  if (
    c.byIp.size === 0 &&
    c.byUser.size === 0 &&
    c.byCountry.size === 0 &&
    c.uaSubstrings.length === 0
  ) {
    return { blocked: false };
  }

  // 1. IP
  const ip = cleanIp(req.ip || req.headers["x-forwarded-for"]);
  if (ip && c.byIp.has(ip)) {
    const row = c.byIp.get(ip)!;
    return { blocked: true, type: "ip", reason: row.reason || undefined, matchedValue: ip, blockId: row.id };
  }

  // 2. User ID
  const userId = (req as any).userId;
  if (typeof userId === "number" && c.byUser.has(String(userId))) {
    const row = c.byUser.get(String(userId))!;
    return { blocked: true, type: "user", reason: row.reason || undefined, matchedValue: String(userId), blockId: row.id };
  }

  // 3. UA substring
  if (c.uaSubstrings.length > 0) {
    const ua = String(req.headers["user-agent"] || "").toLowerCase();
    if (ua) {
      for (const row of c.uaSubstrings) {
        if (ua.includes(String(row.value).toLowerCase())) {
          return { blocked: true, type: "ua_substring", reason: row.reason || undefined, matchedValue: row.value, blockId: row.id };
        }
      }
    }
  }

  // 4. Country (через ipGeo cache — быстро если IP уже резолвили)
  if (c.byCountry.size > 0 && ip) {
    try {
      const geo = await getIpGeo(ip);
      const cc = String(geo?.country || "").toUpperCase();
      if (cc && cc !== "XX" && c.byCountry.has(cc)) {
        const row = c.byCountry.get(cc)!;
        return { blocked: true, type: "country", reason: row.reason || undefined, matchedValue: cc, blockId: row.id };
      }
    } catch {
      // geo fail — пропускаем country-check.
    }
  }

  return { blocked: false };
}

/**
 * Sync вариант без country check — для случаев когда нужно ОЧЕНЬ быстро
 * отвечать (middleware на каждом запросе). Country проверяется отдельным
 * async cron'ом или после-фактум audit.
 *
 * NOTE: country-блокировка через эту функцию не работает. Это компромисс
 * между скоростью (sync) и полнотой (async с ipGeo). Middleware использует
 * full async вариант.
 */
export function isBlockedSync(req: Request): BlockResult {
  const c = getCache();
  if (c.byIp.size === 0 && c.byUser.size === 0 && c.uaSubstrings.length === 0) {
    return { blocked: false };
  }

  const ip = cleanIp(req.ip || req.headers["x-forwarded-for"]);
  if (ip && c.byIp.has(ip)) {
    const row = c.byIp.get(ip)!;
    return { blocked: true, type: "ip", reason: row.reason || undefined, matchedValue: ip, blockId: row.id };
  }

  const userId = (req as any).userId;
  if (typeof userId === "number" && c.byUser.has(String(userId))) {
    const row = c.byUser.get(String(userId))!;
    return { blocked: true, type: "user", reason: row.reason || undefined, matchedValue: String(userId), blockId: row.id };
  }

  if (c.uaSubstrings.length > 0) {
    const ua = String(req.headers["user-agent"] || "").toLowerCase();
    if (ua) {
      for (const row of c.uaSubstrings) {
        if (ua.includes(String(row.value).toLowerCase())) {
          return { blocked: true, type: "ua_substring", reason: row.reason || undefined, matchedValue: row.value, blockId: row.id };
        }
      }
    }
  }

  return { blocked: false };
}

export interface BlockEntityInput {
  type: BlockType;
  value: string;
  reason?: string | null;
  blockedBy?: number | null;
  expiresAt?: number | null; // unix-ms; NULL = permanent
}

export function blockEntity(input: BlockEntityInput): { id: number; alreadyActive?: boolean } {
  const value = String(input.value || "").trim();
  if (!value) throw new Error("value required");
  if (input.type === "country") {
    // Нормализуем country code в uppercase 2-char.
    const cc = value.toUpperCase().slice(0, 2);
    if (!/^[A-Z]{2}$/.test(cc)) throw new Error("country must be ISO 3166-1 alpha-2 (e.g. CZ, RU)");
    input.value = cc;
  } else if (input.type === "user") {
    // Должно быть число.
    if (!/^\d+$/.test(value)) throw new Error("user value must be numeric userId");
  }

  // Если уже есть active — soft-update reason+expires_at, не дублируем.
  const existing = sqliteDb
    .prepare(`SELECT id FROM blocked_entities WHERE type = ? AND value = ? AND active = 1`)
    .get(input.type, input.value) as { id: number } | undefined;
  if (existing) {
    sqliteDb
      .prepare(
        `UPDATE blocked_entities SET reason = COALESCE(?, reason),
                                       expires_at = ?,
                                       blocked_by = COALESCE(?, blocked_by)
         WHERE id = ?`,
      )
      .run(input.reason ?? null, input.expiresAt ?? null, input.blockedBy ?? null, existing.id);
    invalidateBlocksCache();
    return { id: existing.id, alreadyActive: true };
  }

  const r = sqliteDb
    .prepare(
      `INSERT INTO blocked_entities (type, value, reason, blocked_by, created_at, expires_at, active)
       VALUES (?, ?, ?, ?, ?, ?, 1)`,
    )
    .run(
      input.type,
      input.value,
      input.reason ?? null,
      input.blockedBy ?? null,
      Date.now(),
      input.expiresAt ?? null,
    );
  invalidateBlocksCache();
  return { id: Number(r.lastInsertRowid) || 0 };
}

export function unblockEntity(id: number): { ok: boolean; before?: BlockedEntityRow } {
  const before = sqliteDb
    .prepare(`SELECT id, type, value, reason, blocked_by as blockedBy,
                     created_at as createdAt, expires_at as expiresAt, active
              FROM blocked_entities WHERE id = ?`)
    .get(id) as BlockedEntityRow | undefined;
  if (!before) return { ok: false };
  sqliteDb.prepare(`UPDATE blocked_entities SET active = 0 WHERE id = ?`).run(id);
  invalidateBlocksCache();
  return { ok: true, before };
}

export interface ListFilter {
  type?: BlockType;
  active?: boolean;
  limit?: number;
  offset?: number;
}

export function listBlocked(filter: ListFilter = {}): BlockedEntityRow[] {
  const where: string[] = [];
  const args: any[] = [];
  if (filter.type) {
    where.push("type = ?");
    args.push(filter.type);
  }
  if (filter.active !== undefined) {
    where.push("active = ?");
    args.push(filter.active ? 1 : 0);
  }
  const limit = Math.min(500, Math.max(1, Number(filter.limit) || 200));
  const offset = Math.max(0, Number(filter.offset) || 0);
  const sql =
    `SELECT id, type, value, reason, blocked_by as blockedBy,
            created_at as createdAt, expires_at as expiresAt, active
     FROM blocked_entities
     ${where.length ? "WHERE " + where.join(" AND ") : ""}
     ORDER BY created_at DESC
     LIMIT ? OFFSET ?`;
  args.push(limit, offset);
  return sqliteDb.prepare(sql).all(...args) as BlockedEntityRow[];
}

/**
 * Cleanup expired blocks — переводит active=0 для строк с expired expires_at.
 * Запускается каждый час по cron (см. startCleanupCron ниже).
 *
 * Eugene 2026-05-30: переименовано из `cleanupExpired` → `cleanupExpiredBlocks`
 * чтобы устранить duplicate-symbol с `tgLoginNonces.cleanupExpired`.
 */
export function cleanupExpiredBlocks(): number {
  const r = sqliteDb
    .prepare(`UPDATE blocked_entities SET active = 0
              WHERE active = 1 AND expires_at IS NOT NULL AND expires_at <= ?`)
    .run(Date.now());
  if ((r?.changes || 0) > 0) invalidateBlocksCache();
  return Number(r?.changes || 0);
}

/**
 * Подозрительные candidate'ы для блокировки — топ-N IP / countries / UA с
 * аномальной активностью за период. Анти-bot эвристики: много визитов с
 * малого числа уникальных страниц + bot UA признаки.
 */
export interface SuspiciousCandidate {
  type: BlockType;
  value: string;
  hits: number;
  uniqPages?: number;
  uniqSessions?: number;
  country?: string | null;
  city?: string | null;
  userAgent?: string | null;
  hint: string;
  alreadyBlocked: boolean;
}

export function suspiciousCandidates(sinceMs: number = 24 * 60 * 60 * 1000): SuspiciousCandidate[] {
  const sinceIso = new Date(Date.now() - sinceMs).toISOString();
  const cMap = getCache();
  const out: SuspiciousCandidate[] = [];

  // 1. IP — много визитов, мало уникальных страниц или bot UA.
  try {
    const rows = sqliteDb.prepare(`
      SELECT ip,
             COUNT(*) AS hits,
             COUNT(DISTINCT page_url) AS uniqPages,
             COUNT(DISTINCT fingerprint) AS uniqFp,
             MAX(country) AS country,
             MAX(city) AS city,
             MAX(user_agent) AS ua
      FROM visitors
      WHERE last_visit >= ? AND ip IS NOT NULL AND ip != ''
      GROUP BY ip
      HAVING hits > 50
      ORDER BY hits DESC
      LIMIT 30
    `).all(sinceIso) as Array<{ ip: string; hits: number; uniqPages: number; uniqFp: number; country: string; city: string; ua: string }>;
    for (const r of rows) {
      const isBot = isBotUserAgent(r.ua);
      const lowPagesRatio = r.hits > 100 && r.uniqPages <= 3;
      if (!isBot && !lowPagesRatio) continue;
      out.push({
        type: "ip",
        value: r.ip,
        hits: r.hits,
        uniqPages: r.uniqPages,
        uniqSessions: r.uniqFp,
        country: r.country || null,
        city: r.city || null,
        userAgent: r.ua ? r.ua.slice(0, 200) : null,
        hint: isBot ? "bot-ua" : "few-pages",
        alreadyBlocked: cMap.byIp.has(r.ip),
      });
    }
  } catch {}

  // 2. Country — топ стран с подозрительно высокой долей bot UA визитов.
  try {
    const rows = sqliteDb.prepare(`
      SELECT country_code AS cc,
             MAX(country) AS country,
             COUNT(*) AS hits,
             SUM(CASE WHEN LOWER(user_agent) LIKE '%bot%' OR LOWER(user_agent) LIKE '%crawler%'
                       OR LOWER(user_agent) LIKE '%spider%' OR LOWER(user_agent) LIKE '%curl%'
                       OR LOWER(user_agent) LIKE '%python%' OR LOWER(user_agent) LIKE '%scrapy%'
                       THEN 1 ELSE 0 END) AS botHits
      FROM visitors
      WHERE last_visit >= ? AND country_code IS NOT NULL AND country_code != ''
      GROUP BY country_code
      HAVING hits > 200 AND botHits * 100 / hits > 50
      ORDER BY hits DESC
      LIMIT 10
    `).all(sinceIso) as Array<{ cc: string; country: string; hits: number; botHits: number }>;
    for (const r of rows) {
      out.push({
        type: "country",
        value: r.cc,
        hits: r.hits,
        country: r.country || r.cc,
        hint: `${Math.round((r.botHits / r.hits) * 100)}% bot-UA`,
        alreadyBlocked: cMap.byCountry.has(r.cc.toUpperCase()),
      });
    }
  } catch {}

  // 3. UA substring — самые шумные UA с одинаковой подстрокой.
  try {
    const rows = sqliteDb.prepare(`
      SELECT user_agent AS ua, COUNT(*) AS hits
      FROM visitors
      WHERE last_visit >= ? AND user_agent IS NOT NULL AND user_agent != ''
      GROUP BY user_agent
      HAVING hits > 100
      ORDER BY hits DESC
      LIMIT 10
    `).all(sinceIso) as Array<{ ua: string; hits: number }>;
    for (const r of rows) {
      if (!isBotUserAgent(r.ua)) continue;
      out.push({
        type: "ua_substring",
        value: r.ua.slice(0, 60),
        hits: r.hits,
        userAgent: r.ua.slice(0, 200),
        hint: "bot-ua",
        alreadyBlocked: false,
      });
    }
  } catch {}

  return out;
}

// Auto-cleanup cron — каждый час. Pattern из tokenStore.ts.
let _cleanupTimer: NodeJS.Timeout | null = null;
function startCleanupCron(): void {
  if (_cleanupTimer) return;
  _cleanupTimer = setInterval(() => {
    try {
      const n = cleanupExpiredBlocks();
      if (n > 0) console.log(`[blockedEntities] cleanup: ${n} expired blocks deactivated`);
    } catch {}
  }, 3600_000);
  _cleanupTimer.unref?.();
}
startCleanupCron();
