// Eugene 2026-05-17 Босс «Cookies надо собирать и привязывать к профилю
// автора только у админа доступ». CRUD helpers для user_profiles.
//
// Все функции sync (better-sqlite3), никогда не throw'ят — каждая ошибка
// логируется и функция возвращает дефолтное значение (null/false). Failure
// тут не должен ломать вызывающий код (track-visit / login pipeline).
//
// PII / безопасность:
//  - cookie_data JSON хранится as-is — caller отвечает за фильтрацию
//    sensitive полей перед передачей сюда (например, не пишем сюда токены).
//  - Полный IP хранится — это нужно для admin фильтра по геолокации.
//    Доступ — только админ (см. plugins/user-profiles/module.ts).
//  - GDPR delete = soft (deleted_at). Hard-delete только через рутину
//    user_data_change_requests (см. Admin-everything-except-delete rule).

import { sql } from "drizzle-orm";
import { db } from "../storage";

export type UpsertUserProfileInput = {
  visitorId: string;
  userId?: number | null;
  ip?: string | null;
  ipCountry?: string | null;
  ipCity?: string | null;
  ipRegion?: string | null;
  ipAsn?: string | null;
  userAgent?: string | null;
  device?: string | null;
  browser?: string | null;
  os?: string | null;
  cookieData?: Record<string, unknown> | null;
};

export type UserProfileRow = {
  id: number;
  userId: number | null;
  visitorId: string;
  cookieData: string | null;
  ip: string | null;
  ipCountry: string | null;
  ipCity: string | null;
  ipRegion: string | null;
  ipAsn: string | null;
  userAgent: string | null;
  device: string | null;
  browser: string | null;
  os: string | null;
  firstSeen: string;
  lastSeen: string;
  visitCount: number;
  isExistingAuthor: number;
  deletedAt: string | null;
};

function rowToProfile(row: any): UserProfileRow | null {
  if (!row) return null;
  return {
    id: row.id,
    userId: row.user_id ?? row.userId ?? null,
    visitorId: row.visitor_id ?? row.visitorId,
    cookieData: row.cookie_data ?? row.cookieData ?? null,
    ip: row.ip ?? null,
    ipCountry: row.ip_country ?? row.ipCountry ?? null,
    ipCity: row.ip_city ?? row.ipCity ?? null,
    ipRegion: row.ip_region ?? row.ipRegion ?? null,
    ipAsn: row.ip_asn ?? row.ipAsn ?? null,
    userAgent: row.user_agent ?? row.userAgent ?? null,
    device: row.device ?? null,
    browser: row.browser ?? null,
    os: row.os ?? null,
    firstSeen: row.first_seen ?? row.firstSeen,
    lastSeen: row.last_seen ?? row.lastSeen,
    visitCount: row.visit_count ?? row.visitCount ?? 1,
    isExistingAuthor: row.is_existing_author ?? row.isExistingAuthor ?? 0,
    deletedAt: row.deleted_at ?? row.deletedAt ?? null,
  };
}

/**
 * INSERT новый профиль ИЛИ UPDATE существующего по visitor_id.
 * При update'е last_seen → now, visit_count++, обновляем geo/ua если
 * пришли новые непустые значения, cookieData мерджим (новые поля
 * добавляются, старые остаются).
 */
export function upsertUserProfile(input: UpsertUserProfileInput): UserProfileRow | null {
  try {
    if (!input.visitorId) return null;
    const now = new Date().toISOString();
    const existing = db.get<any>(sql`SELECT * FROM user_profiles WHERE visitor_id = ${input.visitorId} LIMIT 1`);

    if (existing) {
      // Merge cookieData: existing + new (new wins on collision)
      let mergedCookie: string | null = existing.cookie_data ?? null;
      if (input.cookieData && typeof input.cookieData === "object") {
        try {
          const prev = existing.cookie_data ? JSON.parse(existing.cookie_data) : {};
          const merged = { ...prev, ...input.cookieData };
          mergedCookie = JSON.stringify(merged);
        } catch {
          mergedCookie = JSON.stringify(input.cookieData);
        }
      }
      const newUserId = input.userId ?? existing.user_id ?? null;
      const isExistingAuthor = newUserId != null ? 1 : (existing.is_existing_author ?? 0);
      db.run(sql`
        UPDATE user_profiles SET
          last_seen = ${now},
          visit_count = visit_count + 1,
          user_id = ${newUserId},
          is_existing_author = ${isExistingAuthor},
          ip = COALESCE(${input.ip ?? null}, ip),
          ip_country = COALESCE(${input.ipCountry ?? null}, ip_country),
          ip_city = COALESCE(${input.ipCity ?? null}, ip_city),
          ip_region = COALESCE(${input.ipRegion ?? null}, ip_region),
          ip_asn = COALESCE(${input.ipAsn ?? null}, ip_asn),
          user_agent = COALESCE(${input.userAgent ?? null}, user_agent),
          device = COALESCE(${input.device ?? null}, device),
          browser = COALESCE(${input.browser ?? null}, browser),
          os = COALESCE(${input.os ?? null}, os),
          cookie_data = ${mergedCookie}
        WHERE visitor_id = ${input.visitorId}
      `);
      const updated = db.get<any>(sql`SELECT * FROM user_profiles WHERE visitor_id = ${input.visitorId} LIMIT 1`);
      return rowToProfile(updated);
    }

    const cookieJson = input.cookieData ? JSON.stringify(input.cookieData) : null;
    const userId = input.userId ?? null;
    db.run(sql`
      INSERT INTO user_profiles (
        user_id, visitor_id, cookie_data, ip, ip_country, ip_city, ip_region, ip_asn,
        user_agent, device, browser, os, first_seen, last_seen, visit_count, is_existing_author
      ) VALUES (
        ${userId}, ${input.visitorId}, ${cookieJson},
        ${input.ip ?? null}, ${input.ipCountry ?? null}, ${input.ipCity ?? null},
        ${input.ipRegion ?? null}, ${input.ipAsn ?? null},
        ${input.userAgent ?? null}, ${input.device ?? null}, ${input.browser ?? null}, ${input.os ?? null},
        ${now}, ${now}, 1, ${userId != null ? 1 : 0}
      )
    `);
    const created = db.get<any>(sql`SELECT * FROM user_profiles WHERE visitor_id = ${input.visitorId} LIMIT 1`);
    return rowToProfile(created);
  } catch (e) {
    console.error("[user-profiles] upsert failed:", e);
    return null;
  }
}

/**
 * Привязать anonymous профиль к authed user. Вызывается из /login,
 * /verify-otp, /verify-call. Если профиля по visitor_id нет — создаём.
 */
export function linkProfileToUser(visitorId: string, userId: number): boolean {
  try {
    if (!visitorId || !userId) return false;
    const now = new Date().toISOString();
    const existing = db.get<any>(sql`SELECT id FROM user_profiles WHERE visitor_id = ${visitorId} LIMIT 1`);
    if (existing) {
      db.run(sql`
        UPDATE user_profiles SET user_id = ${userId}, is_existing_author = 1, last_seen = ${now}
        WHERE visitor_id = ${visitorId}
      `);
      return true;
    }
    db.run(sql`
      INSERT INTO user_profiles (user_id, visitor_id, first_seen, last_seen, visit_count, is_existing_author)
      VALUES (${userId}, ${visitorId}, ${now}, ${now}, 1, 1)
    `);
    return true;
  } catch (e) {
    console.error("[user-profiles] link failed:", e);
    return false;
  }
}

export function getProfileByUserId(userId: number): UserProfileRow | null {
  try {
    // Юзер может иметь несколько профилей (разные devices), берём самый свежий.
    const row = db.get<any>(sql`
      SELECT * FROM user_profiles
      WHERE user_id = ${userId} AND deleted_at IS NULL
      ORDER BY last_seen DESC LIMIT 1
    `);
    return rowToProfile(row);
  } catch {
    return null;
  }
}

export function getProfileByVisitorId(visitorId: string): UserProfileRow | null {
  try {
    const row = db.get<any>(sql`
      SELECT * FROM user_profiles
      WHERE visitor_id = ${visitorId} AND deleted_at IS NULL LIMIT 1
    `);
    return rowToProfile(row);
  } catch {
    return null;
  }
}

export function listProfilesByUserId(userId: number): UserProfileRow[] {
  try {
    const rows = db.all<any>(sql`
      SELECT * FROM user_profiles
      WHERE user_id = ${userId} AND deleted_at IS NULL
      ORDER BY last_seen DESC
    `);
    return rows.map(rowToProfile).filter((r): r is UserProfileRow => r !== null);
  } catch {
    return [];
  }
}

export type ListProfilesFilter = {
  country?: string | null;
  hasUser?: "yes" | "no" | "all";
  search?: string | null; // IP / userId substring
  limit?: number;
  offset?: number;
};

export function listProfiles(filter: ListProfilesFilter = {}): {
  total: number;
  items: UserProfileRow[];
} {
  try {
    const limit = Math.min(Math.max(filter.limit ?? 50, 1), 500);
    const offset = Math.max(filter.offset ?? 0, 0);
    const where: string[] = ["deleted_at IS NULL"];
    const params: any[] = [];
    if (filter.country) {
      where.push("ip_country = ?");
      params.push(filter.country.toUpperCase());
    }
    if (filter.hasUser === "yes") where.push("user_id IS NOT NULL");
    if (filter.hasUser === "no") where.push("user_id IS NULL");
    if (filter.search) {
      where.push("(ip LIKE ? OR CAST(user_id AS TEXT) LIKE ? OR visitor_id LIKE ?)");
      params.push(`%${filter.search}%`, `%${filter.search}%`, `%${filter.search}%`);
    }
    const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";
    const rawSqlite = (db as any).$client;
    const totalRow = rawSqlite.prepare(`SELECT COUNT(*) AS c FROM user_profiles ${whereSql}`).get(...params) as { c: number };
    const itemRows = rawSqlite.prepare(
      `SELECT * FROM user_profiles ${whereSql} ORDER BY last_seen DESC LIMIT ? OFFSET ?`,
    ).all(...params, limit, offset) as any[];
    return {
      total: totalRow?.c ?? 0,
      items: itemRows.map(rowToProfile).filter((r): r is UserProfileRow => r !== null),
    };
  } catch (e) {
    console.error("[user-profiles] list failed:", e);
    return { total: 0, items: [] };
  }
}

/**
 * GDPR soft-delete. deletedAt = now. Hard-delete только через
 * user_data_change_requests (Admin-everything-except-delete rule).
 */
export function softDeleteProfilesByUserId(userId: number): number {
  try {
    const now = new Date().toISOString();
    const r: any = db.run(sql`
      UPDATE user_profiles SET deleted_at = ${now}
      WHERE user_id = ${userId} AND deleted_at IS NULL
    `);
    return r?.changes ?? 0;
  } catch (e) {
    console.error("[user-profiles] soft-delete by userId failed:", e);
    return 0;
  }
}

export function softDeleteProfileByVisitorId(visitorId: string): boolean {
  try {
    const now = new Date().toISOString();
    const r: any = db.run(sql`
      UPDATE user_profiles SET deleted_at = ${now}
      WHERE visitor_id = ${visitorId} AND deleted_at IS NULL
    `);
    return (r?.changes ?? 0) > 0;
  } catch (e) {
    console.error("[user-profiles] soft-delete by visitorId failed:", e);
    return false;
  }
}
