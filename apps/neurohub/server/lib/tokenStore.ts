// Token store — общий между routes.ts и плагинами (auth-sms и др.).
// Eugene 2026-05-15. Извлечено из routes.ts чтобы плагины могли выдавать
// session token после своих auth-flows (SMS-OTP, Telegram login, etc.).
//
// Backed by SQLite table 'sessions' + in-memory cache. Identичный contract
// что был в routes.ts — drop-in replacement.

import { sql } from "drizzle-orm";
import { db } from "../storage";

const _cache = new Map<string, number>();

try {
  db.run(sql`CREATE TABLE IF NOT EXISTS sessions (
    token TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP
  )`);
} catch {}

export const tokenStore = {
  has(token: string): boolean {
    if (_cache.has(token)) return true;
    try {
      const row = db.get<{ userId: number }>(sql`SELECT user_id as userId FROM sessions WHERE token = ${token}`);
      if (row) { _cache.set(token, row.userId); return true; }
    } catch {}
    return false;
  },
  get(token: string): number | undefined {
    if (_cache.has(token)) return _cache.get(token);
    try {
      const row = db.get<{ userId: number }>(sql`SELECT user_id as userId FROM sessions WHERE token = ${token}`);
      if (row) { _cache.set(token, row.userId); return row.userId; }
    } catch {}
    return undefined;
  },
  set(token: string, userId: number) {
    _cache.set(token, userId);
    try { db.run(sql`INSERT OR REPLACE INTO sessions (token, user_id) VALUES (${token}, ${userId})`); } catch {}
  },
  delete(token: string) {
    _cache.delete(token);
    try { db.run(sql`DELETE FROM sessions WHERE token = ${token}`); } catch {}
  },
};
