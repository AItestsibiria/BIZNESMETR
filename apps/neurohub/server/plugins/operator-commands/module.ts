// Eugene 2026-05-18 Босс «Operator-команды (Ярс) через hashed env-auth».
//
// Плагин operator-commands — очередь команд от авторизованного оператора
// (Ярс через Музу-чат). Маршрут:
//   1) Оператор пишет Музе («сделай новость о скидке 20% на день рождения»)
//   2) Муза распознаёт через muzaTools (после merge ae295800) и шлёт POST
//      /api/admin/v304/operator-commands/incoming с senderIdentifier
//   3) Backend проверяет hash через isAuthorizedOperator(), классифицирует,
//      кладёт в очередь operator_command_queue
//   4) Босс открывает Admin → 🎙 Команды Ярса → видит pending, одним
//      кликом ✅ Применить (safe) или ❌ Отклонить (dangerous требует confirm)
//
// TODO after merge ae295800: подключить вызов POST /incoming из muzaTools
// (новый tool `submit_operator_command`) — Муза будет передавать команды
// в очередь автоматически.

import { Router, type Request, type Response } from "express";
import { z } from "zod";
import { sql } from "drizzle-orm";
import { db } from "../../storage";
import { requireAdmin } from "../../core/adminAuth";
import {
  isAuthorizedOperator,
  hashSenderIdentifier,
  classifyOperatorCommand,
} from "../../lib/operatorAuth";
import type { Module } from "../../core";

const TTL_HOURS = 24;

// === Zod ===

const IncomingSchema = z.object({
  senderIdentifier: z.string().trim().min(1).max(200),
  text: z.string().trim().min(1).max(2000),
  chatSessionId: z.string().trim().max(200).optional().nullable(),
});

const RejectSchema = z.object({
  reason: z.string().trim().min(1).max(500),
});

const ApplySchema = z.object({
  note: z.string().trim().max(500).optional().nullable(),
}).partial();

// === Auto-migrate (raw SQL) ===

function ensureTable(): void {
  try {
    const sqlite: any = (db as any).$client;
    sqlite.exec(`
      CREATE TABLE IF NOT EXISTS operator_command_queue (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        sender_identifier_hash TEXT NOT NULL,
        command_text TEXT NOT NULL,
        category TEXT NOT NULL,
        safe INTEGER NOT NULL DEFAULT 0,
        status TEXT DEFAULT 'pending',
        applied_at INTEGER,
        applied_by_user_id INTEGER,
        rejection_reason TEXT,
        source_chat_session TEXT,
        created_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_opcmd_status ON operator_command_queue(status, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_opcmd_expires ON operator_command_queue(expires_at);
    `);
  } catch (e) {
    console.warn("[operator-commands] migration failed:", e);
  }
}

// === Public router (incoming) ===

const publicRouter = Router();

// POST /api/admin/v304/operator-commands/incoming
// Body: { senderIdentifier, text, chatSessionId? }
// Проверяет hash auth. Внимание — endpoint mount'нут под /api/admin/v304/...
// но БЕЗ requireAdmin (это вызов от Музы LLM-tool'а, не от UI). Auth идёт
// через isAuthorizedOperator(hash).
publicRouter.post("/incoming", async (req: Request, res: Response) => {
  try {
    const parsed = IncomingSchema.safeParse(req.body || {});
    if (!parsed.success) {
      res.status(400).json({ data: null, error: "Некорректные параметры" });
      return;
    }
    const { senderIdentifier, text, chatSessionId } = parsed.data;

    if (!isAuthorizedOperator(senderIdentifier)) {
      // 403, но без раскрытия что-именно-не-так (не выдаём salt-hint).
      res.status(403).json({ data: null, error: "Не авторизован" });
      return;
    }

    const cls = classifyOperatorCommand(text);
    const now = Date.now();
    const expiresAt = now + TTL_HOURS * 3600 * 1000;
    const senderHash = hashSenderIdentifier(senderIdentifier);

    const result: any = db.run(sql`
      INSERT INTO operator_command_queue
        (sender_identifier_hash, command_text, category, safe, status,
         source_chat_session, created_at, expires_at)
      VALUES
        (${senderHash}, ${text}, ${cls.category}, ${cls.safe ? 1 : 0},
         'pending', ${chatSessionId ?? null}, ${now}, ${expiresAt})
    `);

    res.json({
      data: {
        queued: true,
        id: Number(result?.lastInsertRowid ?? 0),
        safe: cls.safe,
        category: cls.category,
        parsedIntent: cls.parsedIntent ?? null,
      },
      error: null,
    });
  } catch (e: any) {
    console.error("[operator-commands incoming]", e);
    res.status(500).json({ data: null, error: "Не удалось принять команду" });
  }
});

// === Admin router ===

const adminRouter = Router();
adminRouter.use(requireAdmin);

// GET /api/admin/v304/operator-commands?status=pending&category=&limit=50
adminRouter.get("/", (req: Request, res: Response) => {
  try {
    const status = (req.query.status as string) || "pending";
    const category = (req.query.category as string) || "";
    const limit = Math.max(1, Math.min(500, parseInt((req.query.limit as string) || "50", 10) || 50));

    const where: string[] = [];
    const params: any[] = [];
    if (status && status !== "all") {
      where.push("status = ?");
      params.push(status);
    }
    if (category) {
      where.push("category = ?");
      params.push(category);
    }
    const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";

    const sqlite: any = (db as any).$client;
    const rows = sqlite
      .prepare(
        `SELECT id, sender_identifier_hash, command_text, category, safe, status,
                applied_at, applied_by_user_id, rejection_reason,
                source_chat_session, created_at, expires_at
         FROM operator_command_queue
         ${whereSql}
         ORDER BY created_at DESC
         LIMIT ?`,
      )
      .all(...params, limit);

    const items = rows.map((r: any) => ({
      id: r.id,
      senderHashShort: String(r.sender_identifier_hash || "").slice(0, 8),
      commandText: r.command_text,
      category: r.category,
      safe: Boolean(r.safe),
      status: r.status,
      appliedAt: r.applied_at,
      appliedByUserId: r.applied_by_user_id,
      rejectionReason: r.rejection_reason,
      sourceChatSession: r.source_chat_session,
      createdAt: r.created_at,
      expiresAt: r.expires_at,
    }));

    // Группировка статусов для tab-counters в UI.
    const counts = sqlite
      .prepare(
        `SELECT status, safe, COUNT(*) as cnt
         FROM operator_command_queue
         GROUP BY status, safe`,
      )
      .all();

    res.json({ data: { items, counts }, error: null });
  } catch (e: any) {
    console.error("[operator-commands list]", e);
    res.status(500).json({ data: null, error: "Не удалось получить очередь" });
  }
});

// POST /api/admin/v304/operator-commands/:id/apply
adminRouter.post("/:id/apply", (req: Request, res: Response) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (!Number.isFinite(id) || id <= 0) {
      res.status(400).json({ data: null, error: "Неверный id" });
      return;
    }
    const parsed = ApplySchema.safeParse(req.body || {});
    if (!parsed.success) {
      res.status(400).json({ data: null, error: "Некорректные параметры" });
      return;
    }
    const userId = (req as any).userId as number | undefined;
    const now = Date.now();

    const result: any = db.run(sql`
      UPDATE operator_command_queue
      SET status = 'applied', applied_at = ${now}, applied_by_user_id = ${userId ?? null}
      WHERE id = ${id} AND status = 'pending'
    `);
    if (!result || result.changes === 0) {
      res.status(404).json({ data: null, error: "Команда не найдена или уже обработана" });
      return;
    }
    res.json({ data: { id, status: "applied" }, error: null });
  } catch (e: any) {
    console.error("[operator-commands apply]", e);
    res.status(500).json({ data: null, error: "Не удалось применить" });
  }
});

// POST /api/admin/v304/operator-commands/:id/reject
adminRouter.post("/:id/reject", (req: Request, res: Response) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (!Number.isFinite(id) || id <= 0) {
      res.status(400).json({ data: null, error: "Неверный id" });
      return;
    }
    const parsed = RejectSchema.safeParse(req.body || {});
    if (!parsed.success) {
      res.status(400).json({ data: null, error: "Требуется reason" });
      return;
    }
    const userId = (req as any).userId as number | undefined;
    const now = Date.now();

    const result: any = db.run(sql`
      UPDATE operator_command_queue
      SET status = 'rejected', applied_at = ${now}, applied_by_user_id = ${userId ?? null},
          rejection_reason = ${parsed.data.reason}
      WHERE id = ${id} AND status = 'pending'
    `);
    if (!result || result.changes === 0) {
      res.status(404).json({ data: null, error: "Команда не найдена или уже обработана" });
      return;
    }
    res.json({ data: { id, status: "rejected" }, error: null });
  } catch (e: any) {
    console.error("[operator-commands reject]", e);
    res.status(500).json({ data: null, error: "Не удалось отклонить" });
  }
});

// === Cron: expire pending commands старше TTL ===

function expireOldCommands(): void {
  try {
    const now = Date.now();
    const result: any = db.run(sql`
      UPDATE operator_command_queue
      SET status = 'expired'
      WHERE status = 'pending' AND expires_at < ${now}
    `);
    if (result?.changes) {
      console.log(`[operator-commands] expired ${result.changes} stale commands`);
    }
  } catch (e) {
    console.warn("[operator-commands] expire failed:", e);
  }
}

// === Module ===

const operatorCommandsModule: Module = {
  name: "operator-commands",
  version: "0.1.0",
  description:
    "Очередь operator-команд (Ярс через Музу) с hashed env-auth. Безопасные применяются 1-кликом, опасные требуют confirm.",
  migrations: [
    {
      version: "001_operator_command_queue.sql",
      up: `
        CREATE TABLE IF NOT EXISTS operator_command_queue (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          sender_identifier_hash TEXT NOT NULL,
          command_text TEXT NOT NULL,
          category TEXT NOT NULL,
          safe INTEGER NOT NULL DEFAULT 0,
          status TEXT DEFAULT 'pending',
          applied_at INTEGER,
          applied_by_user_id INTEGER,
          rejection_reason TEXT,
          source_chat_session TEXT,
          created_at INTEGER NOT NULL,
          expires_at INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_opcmd_status ON operator_command_queue(status, created_at DESC);
        CREATE INDEX IF NOT EXISTS idx_opcmd_expires ON operator_command_queue(expires_at);
      `,
    },
  ],
  // Mount под /api/admin/v304/operator-commands — Public POST /incoming
  // оказывается тут же (admin v304-namespace) но без requireAdmin guard.
  routes: { prefix: "admin/v304/operator-commands", router: publicRouter },
  jobs: [
    {
      name: "operator-commands-expire-hourly",
      schedule: "every_hour",
      handler: () => expireOldCommands(),
    },
  ],
  onLoad: async (ctx) => {
    ensureTable();
    // Admin sub-routes — mount через app напрямую (нужны под тем же префиксом
    // но через requireAdmin, который нельзя смешивать с public /incoming
    // в одном Router middleware-chain).
    ctx.app.use("/api/admin/v304/operator-commands", adminRouter);
    ctx.logger.info(
      "operator-commands online — POST /incoming (hashed auth), GET / + POST /:id/apply|reject (admin)",
    );
  },
  healthCheck: () => ({ status: "ok" }),
};

export default operatorCommandsModule;
