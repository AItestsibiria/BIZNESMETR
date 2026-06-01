// Token store — общий между routes.ts и плагинами (auth-sms и др.).
// Eugene 2026-05-15. Извлечено из routes.ts чтобы плагины могли выдавать
// session token после своих auth-flows (SMS-OTP, Telegram login, etc.).
//
// Eugene 2026-05-18 (ACCESS-BYPASS-AUDIT-170526 #4): добавлены
//   - expires_at (TTL 30 дней, sliding renewal при активности)
//   - last_seen_at (обновляется на каждый get/has hit)
//   - revokeAllForUser(userId) — массовое удаление сессий юзера (для reset-password)
//   - cleanupExpired() — cron-cleanup истёкших сессий (вызывается каждый час)
//
// Backed by SQLite table 'sessions' + in-memory cache. Identичный contract
// что был — drop-in replacement для consumers, плюс новые методы.

import { sql } from "drizzle-orm";
import { db } from "../storage";

// 30 дней — sliding window. При активности обновляем expires_at.
const TTL_MS = 30 * 24 * 3600 * 1000;
// Если юзер был активен в последние 24ч — продлеваем сессию на +30 дней
// при следующем hit. Защита от вечного refresh при единичной активности.
const RENEW_WINDOW_MS = 24 * 3600 * 1000;

interface CacheEntry {
  userId: number;
  expiresAt: number; // unix ms
  lastSeenAt: number; // unix ms
}

const _cache = new Map<string, CacheEntry>();

// Auto-migrate schema. ALTER TABLE с защитой от двойного добавления.
try {
  db.run(sql`CREATE TABLE IF NOT EXISTS sessions (
    token TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP
  )`);
} catch {}
try { db.run(sql`ALTER TABLE sessions ADD COLUMN expires_at INTEGER`); } catch {}
try { db.run(sql`ALTER TABLE sessions ADD COLUMN last_seen_at INTEGER`); } catch {}
try { db.run(sql`CREATE INDEX IF NOT EXISTS idx_sessions_user_id ON sessions(user_id)`); } catch {}
try { db.run(sql`CREATE INDEX IF NOT EXISTS idx_sessions_expires_at ON sessions(expires_at)`); } catch {}

function nowMs(): number { return Date.now(); }

// Загрузить запись из БД (или вернуть null если истёкшая/нет).
// Side-effect: при попадании в RENEW window — продлевает expires_at.
function loadFromDb(token: string): CacheEntry | null {
  try {
    const row = db.get<{ userId: number; expiresAt: number | null; lastSeenAt: number | null }>(
      sql`SELECT user_id as userId, expires_at as expiresAt, last_seen_at as lastSeenAt
          FROM sessions WHERE token = ${token} LIMIT 1`,
    );
    if (!row) return null;
    const now = nowMs();
    // Legacy сессии без expires_at — считаем валидными, ставим TTL +30д на лету
    let expires = row.expiresAt;
    if (!expires) {
      expires = now + TTL_MS;
      try { db.run(sql`UPDATE sessions SET expires_at = ${expires}, last_seen_at = ${now} WHERE token = ${token}`); } catch {}
      return { userId: row.userId, expiresAt: expires, lastSeenAt: now };
    }
    if (now > expires) {
      // Истёкшая — удаляем
      try { db.run(sql`DELETE FROM sessions WHERE token = ${token}`); } catch {}
      return null;
    }
    return { userId: row.userId, expiresAt: expires, lastSeenAt: row.lastSeenAt ?? now };
  } catch {
    return null;
  }
}

// Touch — обновляет lastSeenAt + sliding renewal expires_at если последняя
// активность была <24ч назад (значит юзер активен — продлеваем).
function touch(token: string, entry: CacheEntry): CacheEntry {
  const now = nowMs();
  const shouldRenew = now - entry.lastSeenAt < RENEW_WINDOW_MS;
  const newExpires = shouldRenew ? now + TTL_MS : entry.expiresAt;
  const updated: CacheEntry = { ...entry, lastSeenAt: now, expiresAt: newExpires };
  _cache.set(token, updated);
  try {
    db.run(sql`UPDATE sessions SET last_seen_at = ${now}, expires_at = ${newExpires} WHERE token = ${token}`);
  } catch {}
  return updated;
}

export const tokenStore = {
  has(token: string): boolean {
    return this.get(token) !== undefined;
  },
  get(token: string): number | undefined {
    if (!token) return undefined;
    const now = nowMs();
    const cached = _cache.get(token);
    if (cached) {
      if (now > cached.expiresAt) {
        _cache.delete(token);
        try { db.run(sql`DELETE FROM sessions WHERE token = ${token}`); } catch {}
        return undefined;
      }
      touch(token, cached);
      return cached.userId;
    }
    const fromDb = loadFromDb(token);
    if (!fromDb) return undefined;
    _cache.set(token, fromDb);
    touch(token, fromDb);
    return fromDb.userId;
  },
  set(token: string, userId: number) {
    const now = nowMs();
    const entry: CacheEntry = { userId, expiresAt: now + TTL_MS, lastSeenAt: now };
    _cache.set(token, entry);
    try {
      db.run(sql`INSERT OR REPLACE INTO sessions (token, user_id, created_at, expires_at, last_seen_at)
                 VALUES (${token}, ${userId}, CURRENT_TIMESTAMP, ${entry.expiresAt}, ${entry.lastSeenAt})`);
    } catch {}
  },
  delete(token: string) {
    _cache.delete(token);
    try { db.run(sql`DELETE FROM sessions WHERE token = ${token}`); } catch {}
  },

  // Eugene 2026-05-18 (ACCESS-BYPASS-AUDIT-170526 #4): revoke всех сессий
  // юзера. Используется при reset-password и при подозрении на компрометацию.
  revokeAllForUser(userId: number): number {
    let count = 0;
    try {
      const rows = db.all<{ token: string }>(sql`SELECT token FROM sessions WHERE user_id = ${userId}`);
      for (const r of rows) {
        _cache.delete(r.token);
        count += 1;
      }
      db.run(sql`DELETE FROM sessions WHERE user_id = ${userId}`);
    } catch {}
    return count;
  },

  // Cleanup истёкших сессий. Вызывается cron'ом каждый час из server/index.ts.
  cleanupExpired(): { removed: number } {
    const now = nowMs();
    let removed = 0;
    try {
      const rows = db.all<{ token: string }>(
        sql`SELECT token FROM sessions WHERE expires_at IS NOT NULL AND expires_at < ${now}`,
      );
      for (const r of rows) _cache.delete(r.token);
      const result = db.run(sql`DELETE FROM sessions WHERE expires_at IS NOT NULL AND expires_at < ${now}`);
      removed = (result as any)?.changes ?? rows.length;
    } catch {}
    return { removed };
  },
};

// Auto-cleanup cron — каждый час чистим истёкшие сессии.
// Eugene 2026-05-18 (ACCESS-BYPASS-AUDIT-170526 #4).
let _cleanupTimer: NodeJS.Timeout | null = null;
function startCleanupCron(): void {
  if (_cleanupTimer) return;
  _cleanupTimer = setInterval(() => {
    try { tokenStore.cleanupExpired(); } catch {}
  }, 3600_000);
  _cleanupTimer.unref?.();
}
// Стартуем cron при импорте модуля (один раз на процесс).
startCleanupCron();
