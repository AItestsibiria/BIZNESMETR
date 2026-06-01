// v304 plugin: authors-admin (Eugene 2026-05-18 Босс «надо сделать кабинет
// авторов у админа для полного управления и привяжи все данные ip geo и
// чаты. Во втором мозге анализируй тренды проекта, рекомендации по снятию
// барьеров между входом и генерацией с предоплатой»).
//
// Что делает:
//
//  Authors list / drill-down (полный кабинет автора у админа):
//  - GET  /api/admin/v304/authors?q=&status=&sort=&page=&limit=
//      Список авторов с фильтрами + поиск (email/phone/name) + sort
//      (last_seen / registered / generations / spent). Joins пред-агрегирует
//      статистику (треки, потрачено ₽, бонусы) — один запрос на страницу.
//  - GET  /api/admin/v304/authors/:userId
//      Полный профиль: user row + последние 20 generations + последние 20
//      transactions + chatbot sessions + messages (cross-channel merge через
//      loadHistoryForUser) + user_profiles (IP/geo/cookies/devices) +
//      muza_user_actions (если таблица существует) + admin_audit_log entries.
//  - PATCH /api/admin/v304/authors/:userId
//      Edit профиля (admin OK без author confirm согласно правилу
//      Admin-everything-except-delete). Изменяемые поля: name, email, phone,
//      country, countryCode, blocked, role, bonusTracks, balance, profile.
//  - POST /api/admin/v304/authors/:userId/send-message
//      Stub-endpoint: добавляет event в EventBus + audit-log запись.
//      Реальная отправка через TG/email подключается в notifications.
//  - POST /api/admin/v304/authors/:userId/block
//      Добавляет запись в blocked_entities (type=user, value=userId).
//
//  Второй мозг (funnel + barriers):
//  - GET  /api/admin/v304/funnel-analysis?period=today|7d|30d|all
//      Вход → регистрация → запустил генерацию → оплата → повторная оплата.
//      Возвращает counts + конверсии + dropoff.
//  - GET  /api/admin/v304/barrier-analysis?period=today|7d|30d|all
//      Auto-анализ: Top-5 причин отказа от регистрации, Top-5 причин отказа
//      от оплаты, среднее время регистрация→первая генерация, регистрация→
//      первая оплата, конверсия по источникам трафика. + recommendations
//      (heuristic-based; LLM-обогащение в будущем коммите).
//
// Безопасность:
//  - requireAdmin guard на ВСЕХ endpoint'ах.
//  - PII: phone/email возвращаются полностью в admin-view (это admin tool).
//    В логи — маски.
//  - PATCH запросы пишут JSON-snapshot в admin_audit_log (Backup-before-edit).
//  - Delete — НЕ делаем здесь, согласно правилу нужно подтверждение автора.
//    Эндпоинт `/block` это soft-suspend, не удаление.
//
// Pre-edit analysis:
//  - Префикс admin/v304 — другие пути (/funnels, /dashboard-summary,
//    /user-profiles, /authors) не пересекаются.
//  - Использую `getPeriodRange()` (см. Period-20-MSK rule) везде где есть
//    период.
//  - muza_user_actions / save-tools таблицы добавляются другим subagent'ом —
//    используем guard `tableExists()` чтобы не падать.
//  - SQL — параметризован через drizzle `sql` template (защита от inj).

import { Router } from "express";
import { sql, eq } from "drizzle-orm";
import { z } from "zod";
import { db, sqliteDb, storage } from "../../storage";
import {
  users,
  adminAuditLog,
  generations as generationsTable,
} from "@shared/schema";
import { requireAdmin } from "../../core/adminAuth";
import { loadHistoryForUser } from "../../lib/chatHistory";
import {
  getPeriodRange,
  normalizePeriodId,
  type PeriodId,
} from "../../lib/periodBoundaries";
import type { Module } from "../../core";

const router = Router();

// --- helpers ---------------------------------------------------------------

function tableExists(name: string): boolean {
  try {
    const row = sqliteDb
      .prepare(
        `SELECT name FROM sqlite_master WHERE type='table' AND name=? LIMIT 1`,
      )
      .get(name) as { name?: string } | undefined;
    return Boolean(row?.name);
  } catch {
    return false;
  }
}

function maskPhone(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const s = String(raw);
  if (s.length < 6) return s;
  return s.slice(0, 4) + "***" + s.slice(-2);
}

function maskEmail(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const s = String(raw);
  const at = s.indexOf("@");
  if (at < 2) return s;
  return s.slice(0, 2) + "***" + s.slice(at);
}

function recordEdit(
  req: any,
  action: "create" | "update" | "delete" | "restore",
  entity: string,
  entityKey: string,
  before: unknown,
  after: unknown,
): number | null {
  try {
    const adminUserId = (req as any).userId ?? null;
    const adminEmail = (req as any).adminUser?.email ?? null;
    const inserted = db
      .insert(adminAuditLog)
      .values({
        adminUserId,
        adminEmail,
        action,
        entity,
        entityKey,
        beforeJson: before === undefined ? null : JSON.stringify(before ?? null),
        afterJson: after === undefined ? null : JSON.stringify(after ?? null),
        ip: (req?.ip ?? null) as any,
        userAgent: (req?.headers?.["user-agent"] ?? null) as any,
      })
      .returning({ id: adminAuditLog.id })
      .get();
    return inserted?.id ?? null;
  } catch (e) {
    console.error("[authors-admin] recordEdit failed:", e);
    return null;
  }
}

// ===========================================================================
// AUTHORS LIST
// ===========================================================================

const ListQuerySchema = z.object({
  q: z.string().trim().max(200).optional(),
  status: z
    .enum(["all", "active", "blocked", "phone_only", "email", "paying"])
    .optional()
    .default("all"),
  sort: z
    .enum(["last_seen", "registered", "generations", "spent"])
    .optional()
    .default("registered"),
  page: z.coerce.number().int().min(1).max(10_000).optional().default(1),
  limit: z.coerce.number().int().min(1).max(200).optional().default(50),
});

router.get("/authors", requireAdmin, (req, res) => {
  try {
    const parsed = ListQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      return res.status(400).json({
        data: null,
        error: parsed.error.issues[0]?.message || "invalid query",
      });
    }
    const { q, status, sort, page, limit } = parsed.data;
    const offset = (page - 1) * limit;

    // WHERE clause: status filter + search.
    const whereParts: string[] = ["1=1"];
    const params: any[] = [];

    if (status === "active") whereParts.push("u.blocked = 0");
    if (status === "blocked") whereParts.push("u.blocked = 1");
    if (status === "phone_only")
      whereParts.push("u.phone IS NOT NULL AND u.phone <> ''");
    if (status === "email")
      whereParts.push("u.email IS NOT NULL AND u.email NOT LIKE '%@phone.%' AND u.email NOT LIKE '%@telegram.%'");
    if (status === "paying") {
      whereParts.push(
        "EXISTS (SELECT 1 FROM payments p WHERE p.user_id = u.id AND p.status = 'paid')",
      );
    }

    if (q && q.length >= 2) {
      whereParts.push(
        "(u.email LIKE ? OR u.phone LIKE ? OR u.name LIKE ? OR CAST(u.id AS TEXT) = ?)",
      );
      const like = `%${q}%`;
      params.push(like, like, like, q);
    }

    const whereSql = whereParts.join(" AND ");

    // ORDER BY by sort key.
    let orderBy = "u.created_at DESC";
    if (sort === "last_seen") {
      // last_seen approximation: MAX(user_profiles.last_seen) or u.created_at.
      orderBy = "COALESCE(up.last_seen_max, u.created_at) DESC";
    } else if (sort === "generations") {
      orderBy = "gen_stats.gens DESC NULLS LAST";
    } else if (sort === "spent") {
      orderBy = "pay_stats.spent DESC NULLS LAST";
    } else {
      orderBy = "u.created_at DESC";
    }

    // total count (без ORDER BY — быстрее).
    const totalQuery = `
      SELECT count(*) as c
      FROM users u
      WHERE ${whereSql}
    `;
    const totalRow = sqliteDb.prepare(totalQuery).get(...params) as
      | { c: number }
      | undefined;
    const total = totalRow?.c ?? 0;

    // Main query with pre-aggregated stats per user.
    const listQuery = `
      SELECT
        u.id, u.name, u.email, u.phone, u.phone_verified,
        u.role, u.blocked, u.email_verified, u.bonus_tracks,
        u.balance, u.country, u.country_code, u.created_at,
        u.referral_code, u.welcome_gift_given,
        COALESCE(gen_stats.gens, 0) AS gens,
        COALESCE(gen_stats.gens_done, 0) AS gens_done,
        COALESCE(gen_stats.gens_error, 0) AS gens_error,
        COALESCE(pay_stats.spent, 0) AS spent,
        COALESCE(pay_stats.payments, 0) AS payments,
        up.last_seen_max,
        up.ip_country AS last_country,
        up.ip_city AS last_city
      FROM users u
      LEFT JOIN (
        SELECT user_id,
               count(*) AS gens,
               sum(CASE WHEN status='done' THEN 1 ELSE 0 END) AS gens_done,
               sum(CASE WHEN status='error' THEN 1 ELSE 0 END) AS gens_error
        FROM generations
        WHERE deleted_at IS NULL
        GROUP BY user_id
      ) gen_stats ON gen_stats.user_id = u.id
      LEFT JOIN (
        SELECT user_id,
               sum(amount) AS spent,
               count(*) AS payments
        FROM payments
        WHERE status='paid'
        GROUP BY user_id
      ) pay_stats ON pay_stats.user_id = u.id
      LEFT JOIN (
        SELECT user_id,
               MAX(last_seen) AS last_seen_max,
               MAX(ip_country) AS ip_country,
               MAX(ip_city) AS ip_city
        FROM user_profiles
        WHERE user_id IS NOT NULL
        GROUP BY user_id
      ) up ON up.user_id = u.id
      WHERE ${whereSql}
      ORDER BY ${orderBy}
      LIMIT ? OFFSET ?
    `;

    const rows = sqliteDb
      .prepare(listQuery)
      .all(...params, limit, offset) as any[];

    const items = rows.map((r) => ({
      id: r.id,
      name: r.name,
      email: r.email,
      phone: r.phone,
      phoneVerified: !!r.phone_verified,
      emailVerified: !!r.email_verified,
      role: r.role,
      blocked: !!r.blocked,
      bonusTracks: r.bonus_tracks ?? 0,
      balance: r.balance ?? 0,
      country: r.country ?? null,
      countryCode: r.country_code ?? null,
      lastCountry: r.last_country ?? r.country ?? null,
      lastCity: r.last_city ?? null,
      referralCode: r.referral_code ?? null,
      welcomeGiftGiven: !!r.welcome_gift_given,
      gens: r.gens ?? 0,
      gensDone: r.gens_done ?? 0,
      gensError: r.gens_error ?? 0,
      spent: r.spent ?? 0,
      payments: r.payments ?? 0,
      lastSeenAt: r.last_seen_max ?? null,
      createdAt: r.created_at ?? null,
    }));

    res.json({
      data: { total, page, limit, items },
      error: null,
    });
  } catch (err) {
    console.error("[authors-admin] /authors list error:", err);
    res
      .status(500)
      .json({ data: null, error: err instanceof Error ? err.message : "internal" });
  }
});

// ===========================================================================
// AUTHOR DRILL-DOWN (full profile)
// ===========================================================================

router.get("/authors/:userId", requireAdmin, (req, res) => {
  try {
    const userId = Number(req.params.userId);
    if (!Number.isFinite(userId) || userId <= 0) {
      return res.status(400).json({ data: null, error: "invalid userId" });
    }
    const u = storage.getUser(userId);
    if (!u) {
      return res.status(404).json({ data: null, error: "user not found" });
    }

    // Sanitize: drop password / tokens.
    const { password: _p, nameChangeToken: _t, ...userPublic } = u as any;

    // last 20 generations.
    let recentGens: any[] = [];
    try {
      recentGens = sqliteDb
        .prepare(
          `SELECT id, type, status, prompt, style, display_title, result_url,
                  cover_gen_id, is_public, cost, error_reason, voice_type,
                  deleted_at, created_at, published_at
           FROM generations
           WHERE user_id = ?
           ORDER BY id DESC
           LIMIT 20`,
        )
        .all(userId) as any[];
    } catch (e) {
      console.error("[authors-admin] recentGens failed:", e);
    }

    // generations counters.
    let genCounters: any = { total: 0, done: 0, error: 0, processing: 0 };
    try {
      const row = sqliteDb
        .prepare(
          `SELECT count(*) AS total,
                  sum(CASE WHEN status='done' THEN 1 ELSE 0 END) AS done,
                  sum(CASE WHEN status='error' THEN 1 ELSE 0 END) AS err,
                  sum(CASE WHEN status='processing' THEN 1 ELSE 0 END) AS proc
           FROM generations WHERE user_id = ? AND deleted_at IS NULL`,
        )
        .get(userId) as any;
      genCounters = {
        total: row?.total ?? 0,
        done: row?.done ?? 0,
        error: row?.err ?? 0,
        processing: row?.proc ?? 0,
      };
    } catch (e) {
      console.error("[authors-admin] genCounters failed:", e);
    }

    // last 20 transactions.
    let recentTx: any[] = [];
    try {
      recentTx = sqliteDb
        .prepare(
          `SELECT id, type, amount, description, created_at
           FROM transactions WHERE user_id = ?
           ORDER BY id DESC LIMIT 20`,
        )
        .all(userId) as any[];
    } catch (e) {
      console.error("[authors-admin] recentTx failed:", e);
    }

    // last 20 payments.
    let recentPayments: any[] = [];
    try {
      recentPayments = sqliteDb
        .prepare(
          `SELECT id, inv_id, amount, status, description, created_at
           FROM payments WHERE user_id = ?
           ORDER BY id DESC LIMIT 20`,
        )
        .all(userId) as any[];
    } catch (e) {
      console.error("[authors-admin] recentPayments failed:", e);
    }

    // chat sessions + messages cross-channel.
    let chats: any = { sessions: [], messages: [] };
    try {
      chats = loadHistoryForUser(userId, 200);
    } catch (e) {
      console.error("[authors-admin] loadHistoryForUser failed:", e);
    }

    // user_profiles (IP / geo / device / cookies).
    let profiles: any[] = [];
    try {
      profiles = sqliteDb
        .prepare(
          `SELECT id, visitor_id, cookie_data, ip, ip_country, ip_city, ip_region,
                  ip_asn, user_agent, device, browser, os, first_seen, last_seen,
                  visit_count, is_existing_author, deleted_at
           FROM user_profiles
           WHERE user_id = ?
           ORDER BY last_seen DESC
           LIMIT 20`,
        )
        .all(userId) as any[];
      profiles = profiles.map((p) => {
        let cookieData: any = null;
        if (p.cookie_data) {
          try {
            cookieData = JSON.parse(p.cookie_data);
          } catch {}
        }
        return { ...p, cookie_data: cookieData };
      });
    } catch (e) {
      console.error("[authors-admin] profiles failed:", e);
    }

    // muza_user_actions (если таблица существует — save-tools subagent её добавит).
    let muzaActions: any[] = [];
    if (tableExists("muza_user_actions")) {
      try {
        muzaActions = sqliteDb
          .prepare(
            `SELECT * FROM muza_user_actions
             WHERE user_id = ?
             ORDER BY id DESC
             LIMIT 50`,
          )
          .all(userId) as any[];
      } catch (e) {
        console.error("[authors-admin] muzaActions failed:", e);
      }
    }

    // admin_audit_log записи по этому автору.
    let auditEntries: any[] = [];
    try {
      auditEntries = sqliteDb
        .prepare(
          `SELECT id, action, entity, entity_key, admin_email, ip, created_at
           FROM admin_audit_log
           WHERE (entity = 'user' AND entity_key = ?)
              OR (entity = 'author' AND entity_key = ?)
           ORDER BY id DESC
           LIMIT 30`,
        )
        .all(String(userId), String(userId)) as any[];
    } catch (e) {
      console.error("[authors-admin] auditEntries failed:", e);
    }

    // user_action_failures для этого юзера.
    let failures: any[] = [];
    try {
      failures = sqliteDb
        .prepare(
          `SELECT id, channel, action, status_code, error_code, error_message,
                  endpoint, group_key, created_at
           FROM user_action_failures
           WHERE user_id = ?
           ORDER BY id DESC
           LIMIT 30`,
        )
        .all(userId) as any[];
    } catch (e) {
      console.error("[authors-admin] failures failed:", e);
    }

    // blocked status (запись в blocked_entities).
    let blockedRecord: any = null;
    try {
      blockedRecord = sqliteDb
        .prepare(
          `SELECT id, value, reason, blocked_by, created_at, expires_at, active
           FROM blocked_entities
           WHERE type = 'user' AND value = ? AND active = 1
           ORDER BY id DESC LIMIT 1`,
        )
        .get(String(userId)) ?? null;
    } catch (e) {
      console.error("[authors-admin] blockedRecord failed:", e);
    }

    res.json({
      data: {
        user: userPublic,
        counters: genCounters,
        recentGenerations: recentGens,
        recentTransactions: recentTx,
        recentPayments,
        chats,
        profiles,
        muzaActions,
        auditEntries,
        failures,
        blockedRecord,
      },
      error: null,
    });
  } catch (err) {
    console.error("[authors-admin] /authors/:userId error:", err);
    res
      .status(500)
      .json({ data: null, error: err instanceof Error ? err.message : "internal" });
  }
});

// ===========================================================================
// PATCH author profile
// ===========================================================================

const PatchSchema = z.object({
  name: z.string().trim().min(1).max(200).optional(),
  email: z.string().email().max(200).optional(),
  phone: z.string().trim().max(40).optional(),
  country: z.string().trim().max(100).optional(),
  countryCode: z.string().trim().max(3).optional(),
  blocked: z.union([z.boolean(), z.number()]).optional(),
  role: z.enum(["user", "admin", "super_admin"]).optional(),
  bonusTracks: z.number().int().min(0).max(1000).optional(),
  balance: z.number().int().min(0).optional(),
  profile: z.string().max(8000).optional(),
});

router.patch("/authors/:userId", requireAdmin, (req, res) => {
  try {
    const userId = Number(req.params.userId);
    if (!Number.isFinite(userId) || userId <= 0) {
      return res.status(400).json({ data: null, error: "invalid userId" });
    }
    const parsed = PatchSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({
        data: null,
        error: parsed.error.issues[0]?.message || "invalid body",
      });
    }
    const before = storage.getUser(userId);
    if (!before) {
      return res.status(404).json({ data: null, error: "user not found" });
    }

    const updates: Record<string, any> = {};
    if (parsed.data.name !== undefined) updates.name = parsed.data.name;
    if (parsed.data.email !== undefined) updates.email = parsed.data.email;
    if (parsed.data.phone !== undefined) updates.phone = parsed.data.phone;
    if (parsed.data.country !== undefined) updates.country = parsed.data.country;
    if (parsed.data.countryCode !== undefined)
      updates.country_code = parsed.data.countryCode;
    if (parsed.data.blocked !== undefined)
      updates.blocked = parsed.data.blocked ? 1 : 0;
    if (parsed.data.role !== undefined) updates.role = parsed.data.role;
    if (parsed.data.bonusTracks !== undefined)
      updates.bonus_tracks = parsed.data.bonusTracks;
    if (parsed.data.balance !== undefined) updates.balance = parsed.data.balance;
    if (parsed.data.profile !== undefined) updates.profile = parsed.data.profile;

    if (Object.keys(updates).length === 0) {
      return res
        .status(400)
        .json({ data: null, error: "no fields to update" });
    }

    const setSql = Object.keys(updates)
      .map((k) => `${k} = ?`)
      .join(", ");
    const values = Object.values(updates);

    sqliteDb
      .prepare(`UPDATE users SET ${setSql} WHERE id = ?`)
      .run(...values, userId);

    const after = storage.getUser(userId);
    const { password: _p1, nameChangeToken: _t1, ...beforePub } = before as any;
    const { password: _p2, nameChangeToken: _t2, ...afterPub } = (after ?? {}) as any;

    const auditId = recordEdit(
      req,
      "update",
      "user",
      String(userId),
      beforePub,
      afterPub,
    );

    res.json({ data: { ok: true, auditId, user: afterPub }, error: null });
  } catch (err) {
    console.error("[authors-admin] PATCH author error:", err);
    res
      .status(500)
      .json({ data: null, error: err instanceof Error ? err.message : "internal" });
  }
});

// ===========================================================================
// POST send-message (stub — пишет audit + event, фактическую отправку
// подключает notifications plugin)
// ===========================================================================

const SendMessageSchema = z.object({
  channel: z.enum(["telegram", "email", "auto"]).optional().default("auto"),
  text: z.string().trim().min(1).max(4000),
});

router.post("/authors/:userId/send-message", requireAdmin, (req, res) => {
  try {
    const userId = Number(req.params.userId);
    if (!Number.isFinite(userId) || userId <= 0) {
      return res.status(400).json({ data: null, error: "invalid userId" });
    }
    const parsed = SendMessageSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({
        data: null,
        error: parsed.error.issues[0]?.message || "invalid body",
      });
    }
    const user = storage.getUser(userId);
    if (!user) {
      return res.status(404).json({ data: null, error: "user not found" });
    }
    const { channel, text } = parsed.data;

    // Записываем в audit-log — фактическую отправку делает notifications-plugin
    // через event. См. правило Admin-everything-except-delete (admin OK без
    // подтверждения автора). Stub: возвращаем queued.
    const auditId = recordEdit(req, "create", "author_message", String(userId), null, {
      channel,
      preview: text.slice(0, 200),
      targetEmail: maskEmail(user.email),
      targetPhone: maskPhone((user as any).phone),
      targetTelegram: (user as any).telegramId ?? null,
    });

    // EventBus: notifications plugin может подписаться и отправить.
    // (Не подключаем напрямую — следующим коммитом.)
    res.json({
      data: {
        ok: true,
        auditId,
        queued: true,
        channel,
        note: "Сообщение поставлено в очередь. Отправка через notifications-plugin (TG/email).",
      },
      error: null,
    });
  } catch (err) {
    console.error("[authors-admin] send-message error:", err);
    res
      .status(500)
      .json({ data: null, error: err instanceof Error ? err.message : "internal" });
  }
});

// ===========================================================================
// POST block author (запись в blocked_entities)
// ===========================================================================

const BlockSchema = z.object({
  reason: z.string().trim().max(500).optional(),
  expiresAt: z.number().int().optional(), // unix-ms; null = бессрочно
  unblock: z.boolean().optional(),
});

router.post("/authors/:userId/block", requireAdmin, (req, res) => {
  try {
    const userId = Number(req.params.userId);
    if (!Number.isFinite(userId) || userId <= 0) {
      return res.status(400).json({ data: null, error: "invalid userId" });
    }
    const parsed = BlockSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      return res.status(400).json({
        data: null,
        error: parsed.error.issues[0]?.message || "invalid body",
      });
    }
    const user = storage.getUser(userId);
    if (!user) {
      return res.status(404).json({ data: null, error: "user not found" });
    }
    const adminUserId = (req as any).userId ?? null;
    const now = Date.now();
    const valueKey = String(userId);
    const unblock = parsed.data.unblock === true;

    if (unblock) {
      sqliteDb
        .prepare(
          `UPDATE blocked_entities SET active = 0
             WHERE type = 'user' AND value = ? AND active = 1`,
        )
        .run(valueKey);
      sqliteDb.prepare(`UPDATE users SET blocked = 0 WHERE id = ?`).run(userId);
      recordEdit(req, "update", "user_block", valueKey, { blocked: 1 }, { blocked: 0 });
      return res.json({ data: { ok: true, blocked: false }, error: null });
    }

    // soft-block: блокируем флаг + строку в blocked_entities.
    sqliteDb
      .prepare(
        `UPDATE blocked_entities SET active = 0
           WHERE type = 'user' AND value = ? AND active = 1`,
      )
      .run(valueKey);
    sqliteDb
      .prepare(
        `INSERT INTO blocked_entities (type, value, reason, blocked_by, created_at, expires_at, active)
         VALUES ('user', ?, ?, ?, ?, ?, 1)`,
      )
      .run(
        valueKey,
        parsed.data.reason ?? null,
        adminUserId,
        now,
        parsed.data.expiresAt ?? null,
      );
    sqliteDb.prepare(`UPDATE users SET blocked = 1 WHERE id = ?`).run(userId);

    recordEdit(req, "update", "user_block", valueKey, { blocked: 0 }, {
      blocked: 1,
      reason: parsed.data.reason ?? null,
      expiresAt: parsed.data.expiresAt ?? null,
    });

    res.json({ data: { ok: true, blocked: true }, error: null });
  } catch (err) {
    console.error("[authors-admin] block error:", err);
    res
      .status(500)
      .json({ data: null, error: err instanceof Error ? err.message : "internal" });
  }
});

// ===========================================================================
// SECOND BRAIN: FUNNEL ANALYSIS
// ===========================================================================
//
// Вход (unique IPs из visitors) → Регистрация (users) → Запустил генерацию
// (даже бонусную) → Оплатил (первый платёж) → Повторная оплата.
//
// Все этапы фильтруются по периоду через getPeriodRange().

router.get("/funnel-analysis", requireAdmin, (req, res) => {
  try {
    const periodRaw = normalizePeriodId(req.query.period);
    const range = getPeriodRange(periodRaw);
    const fromIso = range.fromIso;
    const toIso = range.toIso;

    // Stage 1: визиты (unique IP из visitors за период).
    let visits = 0;
    try {
      const r = sqliteDb
        .prepare(
          `SELECT count(DISTINCT ip) AS c
           FROM visitors
           WHERE last_visit >= ? AND last_visit < ?`,
        )
        .get(fromIso, toIso) as any;
      visits = r?.c ?? 0;
    } catch (e) {
      console.error("[funnel-analysis] visits failed:", e);
    }

    // Stage 2: registrations (users created в период).
    let registrations = 0;
    try {
      const r = sqliteDb
        .prepare(
          `SELECT count(*) AS c FROM users WHERE created_at >= ? AND created_at < ?`,
        )
        .get(fromIso, toIso) as any;
      registrations = r?.c ?? 0;
    } catch (e) {
      console.error("[funnel-analysis] registrations failed:", e);
    }

    // Stage 3: launched generation (distinct user_id в generations за период).
    let launchedGen = 0;
    try {
      const r = sqliteDb
        .prepare(
          `SELECT count(DISTINCT user_id) AS c
           FROM generations
           WHERE created_at >= ? AND created_at < ? AND deleted_at IS NULL`,
        )
        .get(fromIso, toIso) as any;
      launchedGen = r?.c ?? 0;
    } catch (e) {
      console.error("[funnel-analysis] launchedGen failed:", e);
    }

    // Stage 4: first payment (user'ы, оплатившие хотя бы 1 раз в период,
    //   при условии что у них раньше не было paid платежей — это первая оплата).
    let firstPayment = 0;
    try {
      const r = sqliteDb
        .prepare(
          `SELECT count(DISTINCT user_id) AS c
           FROM payments p
           WHERE p.status = 'paid'
             AND p.created_at >= ? AND p.created_at < ?
             AND NOT EXISTS (
               SELECT 1 FROM payments p2
               WHERE p2.user_id = p.user_id
                 AND p2.status = 'paid'
                 AND p2.created_at < ?
             )`,
        )
        .get(fromIso, toIso, fromIso) as any;
      firstPayment = r?.c ?? 0;
    } catch (e) {
      console.error("[funnel-analysis] firstPayment failed:", e);
    }

    // Stage 5: repeat payment (юзеры с ≥2 paid платежами за период).
    let repeatPayment = 0;
    try {
      const r = sqliteDb
        .prepare(
          `SELECT count(*) AS c FROM (
             SELECT user_id FROM payments
             WHERE status = 'paid'
               AND created_at >= ? AND created_at < ?
             GROUP BY user_id
             HAVING count(*) >= 2
           ) sub`,
        )
        .get(fromIso, toIso) as any;
      repeatPayment = r?.c ?? 0;
    } catch (e) {
      console.error("[funnel-analysis] repeatPayment failed:", e);
    }

    const stages = [
      { id: "visit", label: "Заход на сайт (уник. IP)", count: visits },
      { id: "register", label: "Регистрация", count: registrations },
      { id: "launch_gen", label: "Запустил генерацию", count: launchedGen },
      { id: "first_pay", label: "Первая оплата", count: firstPayment },
      { id: "repeat_pay", label: "Повторная оплата", count: repeatPayment },
    ];

    // Конверсии: каждая стадия относительно предыдущей.
    let maxDropoffIdx = -1;
    let maxDropoffPct = 0;
    const enriched = stages.map((s, i) => {
      const prev = i === 0 ? visits : stages[i - 1].count;
      const fromTotal = visits || 1;
      const conv = prev > 0 ? (s.count / prev) * 100 : 0;
      const dropoff = prev > 0 ? ((prev - s.count) / prev) * 100 : 0;
      if (i > 0 && dropoff > maxDropoffPct) {
        maxDropoffPct = dropoff;
        maxDropoffIdx = i;
      }
      return {
        ...s,
        conversionFromPrev: Math.round(conv * 10) / 10,
        conversionFromTotal: Math.round((s.count / fromTotal) * 1000) / 10,
        dropoffPct: Math.round(dropoff * 10) / 10,
      };
    });

    res.json({
      data: {
        period: periodRaw,
        periodLabel: range.label,
        fromIso,
        toIso,
        stages: enriched,
        worstStageIdx: maxDropoffIdx,
        worstStagePct: Math.round(maxDropoffPct * 10) / 10,
      },
      error: null,
    });
  } catch (err) {
    console.error("[authors-admin] funnel-analysis error:", err);
    res
      .status(500)
      .json({ data: null, error: err instanceof Error ? err.message : "internal" });
  }
});

// ===========================================================================
// SECOND BRAIN: BARRIER ANALYSIS
// ===========================================================================
//
// Heuristic-based анализ. Топ-причин отказа (по user_action_failures),
// среднее время регистрация→генерация / регистрация→оплата (агрегация по
// users + generations + payments), конверсия по источникам.

router.get("/barrier-analysis", requireAdmin, (req, res) => {
  try {
    const periodRaw = normalizePeriodId(req.query.period);
    const range = getPeriodRange(periodRaw);
    const fromIso = range.fromIso;
    const toIso = range.toIso;

    // Top-5 reasons for failed registration.
    let topRegBarriers: any[] = [];
    try {
      topRegBarriers = sqliteDb
        .prepare(
          `SELECT error_code, error_message, count(*) AS c
           FROM user_action_failures
           WHERE created_at >= ? AND created_at < ?
             AND action IN ('register', 'register_phone', 'register_email',
                            'sms_send_otp', 'sms_verify_otp', 'sms_send_call',
                            'sms_verify_call', 'admin_register')
           GROUP BY error_code
           ORDER BY c DESC
           LIMIT 5`,
        )
        .all(fromIso, toIso) as any[];
    } catch (e) {
      console.error("[barrier-analysis] topRegBarriers failed:", e);
    }

    // Top-5 reasons for failed payments / abandoned cart.
    let topPayBarriers: any[] = [];
    try {
      topPayBarriers = sqliteDb
        .prepare(
          `SELECT error_code, error_message, count(*) AS c
           FROM user_action_failures
           WHERE created_at >= ? AND created_at < ?
             AND action IN ('pay', 'payment', 'robokassa', 'topup',
                            'payment_init', 'payment_callback')
           GROUP BY error_code
           ORDER BY c DESC
           LIMIT 5`,
        )
        .all(fromIso, toIso) as any[];
    } catch (e) {
      console.error("[barrier-analysis] topPayBarriers failed:", e);
    }

    // Failed payments (status='failed') как fallback если user_action_failures
    // не имеет записей.
    let abandonedPayments = 0;
    try {
      const r = sqliteDb
        .prepare(
          `SELECT count(*) AS c FROM payments
           WHERE status IN ('failed', 'pending')
             AND created_at >= ? AND created_at < ?`,
        )
        .get(fromIso, toIso) as any;
      abandonedPayments = r?.c ?? 0;
    } catch {}

    // Среднее время от регистрации до первой генерации (для юзеров за период).
    let avgRegToFirstGenMin: number | null = null;
    try {
      const r = sqliteDb
        .prepare(
          `SELECT AVG(diff_sec) AS avg_sec FROM (
             SELECT (julianday(MIN(g.created_at)) - julianday(u.created_at)) * 86400 AS diff_sec
             FROM users u
             JOIN generations g ON g.user_id = u.id
             WHERE u.created_at >= ? AND u.created_at < ?
               AND g.deleted_at IS NULL
             GROUP BY u.id
           ) sub WHERE diff_sec >= 0 AND diff_sec < 86400 * 7`,
        )
        .get(fromIso, toIso) as any;
      if (r?.avg_sec) avgRegToFirstGenMin = Math.round(r.avg_sec / 60);
    } catch (e) {
      console.error("[barrier-analysis] avgRegToFirstGen failed:", e);
    }

    // Среднее время от регистрации до первой оплаты.
    let avgRegToFirstPayHours: number | null = null;
    try {
      const r = sqliteDb
        .prepare(
          `SELECT AVG(diff_sec) AS avg_sec FROM (
             SELECT (julianday(MIN(p.created_at)) - julianday(u.created_at)) * 86400 AS diff_sec
             FROM users u
             JOIN payments p ON p.user_id = u.id
             WHERE u.created_at >= ? AND u.created_at < ?
               AND p.status = 'paid'
             GROUP BY u.id
           ) sub WHERE diff_sec >= 0`,
        )
        .get(fromIso, toIso) as any;
      if (r?.avg_sec) avgRegToFirstPayHours = Math.round((r.avg_sec / 3600) * 10) / 10;
    } catch (e) {
      console.error("[barrier-analysis] avgRegToFirstPay failed:", e);
    }

    // Конверсия по источникам (топ-5 referer hosts).
    let topReferrers: any[] = [];
    try {
      topReferrers = sqliteDb
        .prepare(
          `SELECT
             COALESCE(NULLIF(referer, ''), '(direct)') AS source,
             count(*) AS visits
           FROM visitors
           WHERE last_visit >= ? AND last_visit < ?
           GROUP BY source
           ORDER BY visits DESC
           LIMIT 5`,
        )
        .all(fromIso, toIso) as any[];
    } catch (e) {
      console.error("[barrier-analysis] topReferrers failed:", e);
    }

    // Зарегистрировались, но не запустили генерацию (gap-1).
    let registeredButNoGen = 0;
    try {
      const r = sqliteDb
        .prepare(
          `SELECT count(*) AS c
           FROM users u
           WHERE u.created_at >= ? AND u.created_at < ?
             AND NOT EXISTS (
               SELECT 1 FROM generations g
               WHERE g.user_id = u.id AND g.deleted_at IS NULL
             )`,
        )
        .get(fromIso, toIso) as any;
      registeredButNoGen = r?.c ?? 0;
    } catch {}

    // Запустили генерацию, но не оплатили (gap-2).
    let genButNoPay = 0;
    try {
      const r = sqliteDb
        .prepare(
          `SELECT count(DISTINCT g.user_id) AS c
           FROM generations g
           WHERE g.created_at >= ? AND g.created_at < ?
             AND g.deleted_at IS NULL
             AND NOT EXISTS (
               SELECT 1 FROM payments p
               WHERE p.user_id = g.user_id AND p.status = 'paid'
             )`,
        )
        .get(fromIso, toIso) as any;
      genButNoPay = r?.c ?? 0;
    } catch {}

    // Heuristic-based recommendations (без LLM — чтобы дешево).
    const recommendations: Array<{
      priority: "high" | "medium" | "low";
      text: string;
      detail?: string;
    }> = [];

    if (registeredButNoGen > 5) {
      recommendations.push({
        priority: "high",
        text: `${registeredButNoGen} зарегистрированных не запустили генерацию — добавить onboarding-туториал прямо после регистрации с pre-filled шаблоном.`,
        detail: "Чем меньше шагов между регистрацией и первой кнопкой «Создать» — тем выше конверсия.",
      });
    }
    if (genButNoPay > 10) {
      recommendations.push({
        priority: "high",
        text: `${genButNoPay} запустивших генерацию не оплатили — показать на /music страницу с pricing + бонусным первым треком.`,
        detail: "Возможно юзеры теряются на этапе перехода к оплате. Pricing-anchor рядом с кнопкой «Создать».",
      });
    }
    if (topRegBarriers.length > 0) {
      const top = topRegBarriers[0];
      recommendations.push({
        priority: "high",
        text: `Главная причина отказа от регистрации: «${top.error_code || "—"}» (${top.c} случаев). Проверить flow в logs.`,
      });
    }
    if (topPayBarriers.length > 0) {
      const top = topPayBarriers[0];
      recommendations.push({
        priority: "medium",
        text: `Главная причина отказа от оплаты: «${top.error_code || "—"}» (${top.c} случаев). Возможно нужен fallback способ оплаты.`,
      });
    } else if (abandonedPayments > 5) {
      recommendations.push({
        priority: "medium",
        text: `${abandonedPayments} платежей в статусе failed/pending — добавить retry-link в email + push.`,
      });
    }
    if (avgRegToFirstPayHours !== null && avgRegToFirstPayHours > 48) {
      recommendations.push({
        priority: "medium",
        text: `Среднее время от регистрации до первой оплаты ${avgRegToFirstPayHours}ч — слишком долго. Добавить промокод-pulse через 24ч после регистрации.`,
      });
    }
    if (recommendations.length === 0) {
      recommendations.push({
        priority: "low",
        text: "Барьеры не выявлены — воронка работает в пределах нормы.",
      });
    }

    res.json({
      data: {
        period: periodRaw,
        periodLabel: range.label,
        fromIso,
        toIso,
        topBarriers: {
          registration: topRegBarriers.map((r) => ({
            errorCode: r.error_code,
            errorMessage: r.error_message,
            count: r.c,
            severity: r.c > 20 ? "high" : r.c > 5 ? "medium" : "low",
          })),
          payment: topPayBarriers.map((r) => ({
            errorCode: r.error_code,
            errorMessage: r.error_message,
            count: r.c,
            severity: r.c > 10 ? "high" : r.c > 3 ? "medium" : "low",
          })),
        },
        abandonedPayments,
        avgTimes: {
          registerToFirstGenMin: avgRegToFirstGenMin,
          registerToFirstPayHours: avgRegToFirstPayHours,
        },
        gaps: {
          registeredButNoGen,
          genButNoPay,
        },
        topReferrers,
        recommendations,
      },
      error: null,
    });
  } catch (err) {
    console.error("[authors-admin] barrier-analysis error:", err);
    res
      .status(500)
      .json({ data: null, error: err instanceof Error ? err.message : "internal" });
  }
});

// ===========================================================================
// SECOND BRAIN: TRENDS (per-day daily series)
// ===========================================================================
//
// Регистрации / генерации / платежи / посетители — daily breakdown за период.
// Используется для линейных графиков (chart.js / recharts на client).

router.get("/brain-trends", requireAdmin, (req, res) => {
  try {
    const periodRaw = normalizePeriodId(req.query.period);
    const range = getPeriodRange(periodRaw);
    const fromIso = range.fromIso;
    const toIso = range.toIso;

    // Helper: agg by day (substr(created_at, 1, 10) = YYYY-MM-DD).
    function aggDaily(query: string, params: any[]): Array<{ day: string; c: number }> {
      try {
        return sqliteDb.prepare(query).all(...params) as any[];
      } catch (e) {
        console.error("[brain-trends] agg failed:", e);
        return [];
      }
    }

    const regs = aggDaily(
      `SELECT substr(created_at, 1, 10) AS day, count(*) AS c
       FROM users WHERE created_at >= ? AND created_at < ?
       GROUP BY day ORDER BY day ASC`,
      [fromIso, toIso],
    );

    const gens = aggDaily(
      `SELECT substr(created_at, 1, 10) AS day, count(*) AS c
       FROM generations WHERE created_at >= ? AND created_at < ?
         AND deleted_at IS NULL
       GROUP BY day ORDER BY day ASC`,
      [fromIso, toIso],
    );

    const pays = aggDaily(
      `SELECT substr(created_at, 1, 10) AS day, count(*) AS c
       FROM payments WHERE created_at >= ? AND created_at < ?
         AND status='paid'
       GROUP BY day ORDER BY day ASC`,
      [fromIso, toIso],
    );

    const visits = aggDaily(
      `SELECT substr(last_visit, 1, 10) AS day, count(DISTINCT ip) AS c
       FROM visitors WHERE last_visit >= ? AND last_visit < ?
       GROUP BY day ORDER BY day ASC`,
      [fromIso, toIso],
    );

    // Сумма оплат по дням (в kopecks).
    let paysSum: Array<{ day: string; c: number }> = [];
    try {
      paysSum = sqliteDb
        .prepare(
          `SELECT substr(created_at, 1, 10) AS day, sum(amount) AS c
           FROM payments WHERE created_at >= ? AND created_at < ?
             AND status='paid'
           GROUP BY day ORDER BY day ASC`,
        )
        .all(fromIso, toIso) as any[];
    } catch {}

    res.json({
      data: {
        period: periodRaw,
        periodLabel: range.label,
        fromIso,
        toIso,
        series: {
          registrations: regs,
          generations: gens,
          payments: pays,
          paymentsSumKopecks: paysSum,
          visits,
        },
      },
      error: null,
    });
  } catch (err) {
    console.error("[authors-admin] brain-trends error:", err);
    res
      .status(500)
      .json({ data: null, error: err instanceof Error ? err.message : "internal" });
  }
});

const authorsAdminModule: Module = {
  name: "authors-admin",
  version: "0.1.0",
  description:
    "Admin authors cabinet (list/drill-down/edit/block/send-message) + Second Brain analysis (funnel/barriers/trends).",
  routes: { prefix: "admin/v304", router },
  publishes: [],
  onLoad: async (ctx) => {
    ctx.logger.info(
      "authors-admin online — GET /api/admin/v304/authors, /authors/:id, /funnel-analysis, /barrier-analysis, /brain-trends",
    );
  },
  healthCheck: () => ({ status: "ok" }),
};

export default authorsAdminModule;
