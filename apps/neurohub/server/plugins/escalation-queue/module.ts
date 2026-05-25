// Eugene 2026-05-18 Босс «Escalation queue для негативной обратной связи».
//
// Плагин escalation-queue — очередь негативных сообщений для админа.
// Получает сигнал от Музы (через POST /api/escalations/log) когда юзер
// выражает недовольство. Priority high → Telegram alert Боссу немедленно.
//
// Eugene 2026-05-20: wiring done — escalation выполняется через два пути:
//   1) Server-side detect_negative hook в /api/muza/chat (routes.ts:2864-2895)
//      — sync sentiment-check на каждое user-сообщение, isCritical+score<-0.5
//      → escalate с priority='high' (Telegram alert админу немедленно).
//   2) muzaTools.escalate_to_human tool — LLM может явно эскалировать когда
//      юзер просит «позови человека» / «жалоба» (apps/neurohub/server/lib/muzaTools.ts).
// Endpoint /api/escalations/log остаётся для внешних каналов (yars-webhook-bridge etc).

import { Router, type Request, type Response } from "express";
import { z } from "zod";
import { sql } from "drizzle-orm";
import { db } from "../../storage";
import { requireAdmin } from "../../core/adminAuth";
import type { Module } from "../../core";

// === Auto-migrate ===

function ensureTable(): void {
  try {
    const sqlite: any = (db as any).$client;
    sqlite.exec(`
      CREATE TABLE IF NOT EXISTS escalation_queue (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER,
        anonymous_session TEXT,
        chat_session_id TEXT,
        message_text TEXT NOT NULL,
        sentiment_score REAL,
        triggers TEXT,
        priority TEXT,
        status TEXT DEFAULT 'open',
        assigned_to_user_id INTEGER,
        resolution TEXT,
        resolved_at INTEGER,
        created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_escalations_status_priority
        ON escalation_queue(status, priority, created_at DESC);
    `);
  } catch (e) {
    console.warn("[escalation-queue] migration failed:", e);
  }
}

// === Telegram alert (best-effort) ===

async function tgAlertHigh(text: string): Promise<void> {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const adminId = process.env.ADMIN_TELEGRAM_ID;
  if (!token || !adminId) return;
  try {
    await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: adminId,
        text,
        parse_mode: "Markdown",
        disable_web_page_preview: true,
      }),
      signal: AbortSignal.timeout(8_000),
    });
  } catch (e: any) {
    console.warn("[escalation-queue] tg alert failed:", e?.message || e);
  }
}

// === Zod ===

const LogSchema = z.object({
  userId: z.number().int().optional().nullable(),
  sessionId: z.string().trim().max(200).optional().nullable(),
  chatSessionId: z.string().trim().max(200).optional().nullable(),
  text: z.string().trim().min(1).max(4000),
  score: z.number().min(-1).max(1).optional().nullable(),
  triggers: z.array(z.string()).max(50).optional(),
  priority: z.enum(["high", "medium", "low"]).optional(),
});

const ResolveSchema = z.object({
  resolution: z.string().trim().min(1).max(2000),
});

const DismissSchema = z.object({
  reason: z.string().trim().max(1000).optional(),
});

// === Internal router (no admin guard — для вызовов от Музы LLM-tool) ===

const internalRouter = Router();

// POST /api/escalations/log
// Body: { userId?, sessionId?, chatSessionId?, text, score?, triggers?, priority? }
// Создаёт escalation. При priority='high' — Telegram alert.
internalRouter.post("/log", async (req: Request, res: Response) => {
  try {
    const parsed = LogSchema.safeParse(req.body || {});
    if (!parsed.success) {
      res.status(400).json({ data: null, error: "Некорректные параметры" });
      return;
    }
    const p = parsed.data;
    const now = Date.now();
    const priority = p.priority || (p.score !== undefined && p.score !== null && p.score < -0.7 ? "high" : "medium");
    const triggersJson = p.triggers && p.triggers.length ? JSON.stringify(p.triggers).slice(0, 1500) : null;

    const result: any = db.run(sql`
      INSERT INTO escalation_queue
        (user_id, anonymous_session, chat_session_id, message_text,
         sentiment_score, triggers, priority, status, created_at)
      VALUES
        (${p.userId ?? null}, ${p.userId ? null : (p.sessionId ?? null)},
         ${p.chatSessionId ?? null}, ${p.text}, ${p.score ?? null},
         ${triggersJson}, ${priority}, 'open', ${now})
    `);

    const id = Number(result?.lastInsertRowid ?? 0);

    // Eugene 2026-05-25 Director-subordination rule: обратная связь → Директор.
    // recordActivity (он видит что агент жив) + emit (real-time сигнал).
    try {
      const { recordAgentActivity, orchestrator } = await import("../../lib/agentOrchestrator");
      recordAgentActivity("feedback-escalation", { priority });
      orchestrator.recordEdgeUsage("feedback-escalation", "muza-admin", "event");
    } catch {}

    // High priority — alert админу немедленно (best-effort).
    if (priority === "high") {
      const snippet = p.text.slice(0, 250);
      void tgAlertHigh(
        `🚨 *Эскалация — high priority*\n\n«${snippet}»\n\nОткрой Admin → 🚨 Эскалации (#${id})`,
      );
    }

    res.json({ data: { id, priority }, error: null });
  } catch (e: any) {
    console.error("[escalations log]", e);
    res.status(500).json({ data: null, error: "Не удалось залогировать" });
  }
});

// === Admin router ===

const adminRouter = Router();
adminRouter.use(requireAdmin);

// GET /api/admin/v304/escalations?status=open|resolved|dismissed&priority=high|medium|low
adminRouter.get("/", (req: Request, res: Response) => {
  try {
    const status = (req.query.status as string) || "open";
    const priority = (req.query.priority as string) || "";
    const limit = Math.max(1, Math.min(500, parseInt((req.query.limit as string) || "100", 10) || 100));

    const where: string[] = [];
    const params: any[] = [];
    if (status && status !== "all") {
      where.push("status = ?");
      params.push(status);
    }
    if (priority) {
      where.push("priority = ?");
      params.push(priority);
    }
    const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";

    const sqlite: any = (db as any).$client;
    const rows = sqlite
      .prepare(
        `SELECT id, user_id, anonymous_session, chat_session_id, message_text,
                sentiment_score, triggers, priority, status, assigned_to_user_id,
                resolution, resolved_at, created_at
         FROM escalation_queue
         ${whereSql}
         ORDER BY
           CASE priority WHEN 'high' THEN 0 WHEN 'medium' THEN 1 ELSE 2 END,
           created_at DESC
         LIMIT ?`,
      )
      .all(...params, limit);

    const items = rows.map((r: any) => {
      let triggersArr: string[] = [];
      try {
        triggersArr = r.triggers ? JSON.parse(r.triggers) : [];
      } catch {
        triggersArr = [];
      }
      return {
        id: r.id,
        userId: r.user_id,
        anonymousSession: r.anonymous_session,
        chatSessionId: r.chat_session_id,
        messageText: r.message_text,
        sentimentScore: r.sentiment_score,
        triggers: triggersArr,
        priority: r.priority,
        status: r.status,
        assignedToUserId: r.assigned_to_user_id,
        resolution: r.resolution,
        resolvedAt: r.resolved_at,
        createdAt: r.created_at,
      };
    });

    // Counters для tab badges.
    const counts = sqlite
      .prepare(
        `SELECT status, priority, COUNT(*) as cnt
         FROM escalation_queue
         GROUP BY status, priority`,
      )
      .all();

    res.json({ data: { items, counts }, error: null });
  } catch (e: any) {
    console.error("[escalations list]", e);
    res.status(500).json({ data: null, error: "Не удалось получить эскалации" });
  }
});

// POST /api/admin/v304/escalations/:id/resolve
adminRouter.post("/:id/resolve", (req: Request, res: Response) => {
  try {
    const id = parseInt(String(req.params.id), 10);
    if (!Number.isFinite(id) || id <= 0) {
      res.status(400).json({ data: null, error: "Неверный id" });
      return;
    }
    const parsed = ResolveSchema.safeParse(req.body || {});
    if (!parsed.success) {
      res.status(400).json({ data: null, error: "Требуется resolution" });
      return;
    }
    const userId = (req as any).userId as number | undefined;
    const now = Date.now();
    const result: any = db.run(sql`
      UPDATE escalation_queue
      SET status = 'resolved', resolution = ${parsed.data.resolution},
          resolved_at = ${now}, assigned_to_user_id = ${userId ?? null}
      WHERE id = ${id} AND status = 'open'
    `);
    if (!result || result.changes === 0) {
      res.status(404).json({ data: null, error: "Эскалация не найдена или уже закрыта" });
      return;
    }
    res.json({ data: { id, status: "resolved" }, error: null });
  } catch (e: any) {
    console.error("[escalations resolve]", e);
    res.status(500).json({ data: null, error: "Не удалось закрыть" });
  }
});

// POST /api/admin/v304/escalations/:id/dismiss
adminRouter.post("/:id/dismiss", (req: Request, res: Response) => {
  try {
    const id = parseInt(String(req.params.id), 10);
    if (!Number.isFinite(id) || id <= 0) {
      res.status(400).json({ data: null, error: "Неверный id" });
      return;
    }
    const parsed = DismissSchema.safeParse(req.body || {});
    const reason = parsed.success ? (parsed.data.reason ?? null) : null;
    const userId = (req as any).userId as number | undefined;
    const now = Date.now();
    const result: any = db.run(sql`
      UPDATE escalation_queue
      SET status = 'dismissed', resolution = ${reason},
          resolved_at = ${now}, assigned_to_user_id = ${userId ?? null}
      WHERE id = ${id} AND status = 'open'
    `);
    if (!result || result.changes === 0) {
      res.status(404).json({ data: null, error: "Эскалация не найдена или уже закрыта" });
      return;
    }
    res.json({ data: { id, status: "dismissed" }, error: null });
  } catch (e: any) {
    console.error("[escalations dismiss]", e);
    res.status(500).json({ data: null, error: "Не удалось отклонить" });
  }
});

// === Module ===

const escalationQueueModule: Module = {
  name: "escalation-queue",
  version: "0.1.0",
  description:
    "Очередь негативных сообщений + Telegram alert при priority=high. Source: Муза LLM-tool detect_negative.",
  migrations: [
    {
      version: "001_escalation_queue.sql",
      up: `
        CREATE TABLE IF NOT EXISTS escalation_queue (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          user_id INTEGER,
          anonymous_session TEXT,
          chat_session_id TEXT,
          message_text TEXT NOT NULL,
          sentiment_score REAL,
          triggers TEXT,
          priority TEXT,
          status TEXT DEFAULT 'open',
          assigned_to_user_id INTEGER,
          resolution TEXT,
          resolved_at INTEGER,
          created_at INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_escalations_status_priority
          ON escalation_queue(status, priority, created_at DESC);
      `,
    },
  ],
  routes: { prefix: "escalations", router: internalRouter },
  onLoad: async (ctx) => {
    ensureTable();
    ctx.app.use("/api/admin/v304/escalations", adminRouter);
    ctx.logger.info(
      "escalation-queue online — POST /api/escalations/log (internal), GET/resolve/dismiss (admin)",
    );
  },
  healthCheck: () => ({ status: "ok" }),
};

export default escalationQueueModule;
