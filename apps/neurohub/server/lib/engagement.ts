// engagement (Eugene 2026-05-11): воронка вовлечения для admin dashboard.
// Считаем сколько людей пытаются подключиться (email-register, telegram-
// login, помощник, генерация). Daily breakdown в /admin → 📊 Воронка.
//
// Use:
//   logEngagement(req, "email_register_attempt", { channel: "site", userId })
//   logEngagement(req, "tg_login_confirmed", { channel: "telegram", userId })
//
// Никогда не блокирует основной flow — все catch'и проглатывают.

import type { Request } from "express";
import { db } from "../storage";
import { sql } from "drizzle-orm";

export type EngagementType =
  | "email_register_attempt"   // POST /api/auth/register (любая попытка)
  | "email_register_success"   // успешно создан юзер
  | "email_login_attempt"
  | "email_login_success"
  | "tg_login_start"           // POST /api/auth/telegram/start (нонс выдан)
  | "tg_login_confirmed"       // login_url HMAC OK / fallback bot-confirm
  | "consultant_impression"    // floating-consultant появился (mount)
  | "consultant_open"          // юзер кликнул на образ — открыл меню
  | "consultant_action"        // клик на пункт меню (Telegram/Max/Создать/Регистрация)
  | "music_generate_attempt"   // POST /api/music/generate (любой режим)
  | "music_generate_success";  // дошёл до 100%

export type EngagementChannel = "site" | "telegram" | "max" | "email" | null;

export function logEngagement(
  req: Request | null,
  eventType: EngagementType,
  opts: {
    channel?: EngagementChannel;
    userId?: number | null;
    sessionId?: string | null;
    meta?: Record<string, any>;
  } = {}
): void {
  try {
    const ip = req ? String(req.headers["x-forwarded-for"] || req.socket?.remoteAddress || "").split(",")[0].trim() : null;
    const ua = req ? String(req.headers["user-agent"] || "").slice(0, 500) : null;
    const meta = opts.meta ? JSON.stringify(opts.meta).slice(0, 2000) : null;
    db.run(sql`
      INSERT INTO engagement_events (event_type, channel, user_id, session_id, ip, user_agent, meta)
      VALUES (${eventType}, ${opts.channel || null}, ${opts.userId ?? null}, ${opts.sessionId ?? null}, ${ip}, ${ua}, ${meta})
    `);
  } catch (e) {
    // Глушим — этот лог не должен ломать основной flow
  }
}

// Daily breakdown за N дней. Возвращает { date, eventType, channel, count }.
// Использует SQLite date() — UTC, но для дашборда достаточно.
export function getEngagementDaily(days = 30): Array<{
  date: string;
  eventType: string;
  channel: string | null;
  count: number;
}> {
  try {
    const rows = db.all<any>(sql`
      SELECT
        date(created_at) AS date,
        event_type AS eventType,
        channel,
        COUNT(*) AS count
      FROM engagement_events
      WHERE created_at >= datetime('now', '-' || ${days} || ' days')
      GROUP BY date(created_at), event_type, channel
      ORDER BY date DESC, event_type
    `);
    return rows as any;
  } catch {
    return [];
  }
}

// Сводка за «сегодня» + «всего за период» — для верхнего блока дашборда.
export function getEngagementSummary(days = 7): {
  today: Record<string, number>;
  period: Record<string, number>;
  totalEver: Record<string, number>;
} {
  const empty = {
    email_register_attempt: 0, email_register_success: 0,
    email_login_attempt: 0, email_login_success: 0,
    tg_login_start: 0, tg_login_confirmed: 0,
    consultant_impression: 0, consultant_open: 0, consultant_action: 0,
    music_generate_attempt: 0, music_generate_success: 0,
  };
  try {
    const todayRows = db.all<any>(sql`
      SELECT event_type AS eventType, COUNT(*) AS count
      FROM engagement_events
      WHERE date(created_at) = date('now')
      GROUP BY event_type
    `);
    const periodRows = db.all<any>(sql`
      SELECT event_type AS eventType, COUNT(*) AS count
      FROM engagement_events
      WHERE created_at >= datetime('now', '-' || ${days} || ' days')
      GROUP BY event_type
    `);
    const totalRows = db.all<any>(sql`
      SELECT event_type AS eventType, COUNT(*) AS count
      FROM engagement_events
      GROUP BY event_type
    `);
    const today = { ...empty };
    const period = { ...empty };
    const totalEver = { ...empty };
    for (const r of todayRows) (today as any)[r.eventType] = Number(r.count) || 0;
    for (const r of periodRows) (period as any)[r.eventType] = Number(r.count) || 0;
    for (const r of totalRows) (totalEver as any)[r.eventType] = Number(r.count) || 0;
    return { today, period, totalEver };
  } catch {
    return { today: empty, period: empty, totalEver: empty };
  }
}
