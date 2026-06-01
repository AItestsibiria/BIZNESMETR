// Eugene 2026-05-17 Босс «Заведи кнопку техподдержка при нажатии открывается
// муза бот и фиксирует обращение и начинает решение».
//
// Плагин support — wrapper над existing agent_handoffs.
// Per No-duplicates rule (CLAUDE.md): переиспользуем существующую таблицу
// agent_handoffs (создана для request_human_handoff в muzaTools.ts), а не
// заводим parallel support_tickets. Кнопка «🆘 Техподдержка» — это user-
// initiated handoff с reason='support_button' + расширенные поля.
//
// Endpoints:
//   POST /api/support/create-ticket   — создать ticket (auth опционален)
//   GET  /api/support/my-tickets       — список своих tickets (требует auth)
//   GET  /api/admin/v304/support/tickets             — admin список
//   POST /api/admin/v304/support/tickets/:id/status  — admin смена статуса

import { Router, type Request, type Response } from "express";
import { z } from "zod";
import * as crypto from "node:crypto";
import { db, storage } from "../../storage";
import { agentHandoffs, chatbotSessions, chatbotMessages, users } from "@shared/schema";
import { eq, and, desc, sql, isNotNull, inArray } from "drizzle-orm";
import { requireAdmin } from "../../core/adminAuth";
import { tokenStore } from "../../lib/tokenStore";
import { recordAuditEntry } from "../../lib/adminAuditLog";
import { logUserActionFailure } from "../../lib/userActionFailures";
import { PUBLIC_URL } from "../../lib/publicUrl";
import type { Module } from "../../core";

// === Zod schemas ===

const CreateTicketSchema = z.object({
  sessionId: z.string().trim().min(1).max(120).optional(),
  channel: z.enum(["web", "telegram", "max"]).default("web"),
  subject: z.string().trim().max(300).optional(),
  priority: z.enum(["low", "normal", "high", "urgent"]).default("normal"),
  page: z.string().max(200).optional(),
  currentTrackId: z.number().int().optional(),
  initialMessage: z.string().max(1500).optional(),
});

const ChangeStatusSchema = z.object({
  status: z.enum(["open", "in_progress", "resolved", "closed"]),
  assignedTo: z.union([z.string(), z.number()]).optional(),
  resolutionNote: z.string().max(2000).optional(),
  priority: z.enum(["low", "normal", "high", "urgent"]).optional(),
});

// === Helpers ===

const MUZA_WELCOME = [
  "Здравствуйте! Я Муза, ваш помощник 🌸 Расскажите что случилось — постараюсь помочь сразу или передам Боссу.",
  "Привет! Я Муза. Слушаю внимательно — что произошло? Сразу помогу, либо передам админу.",
  "Здравствуйте! Я Муза. Опишите ситуацию — попробую разобраться. Если потребуется — подключу админа.",
];

function pickWelcome(): string {
  return MUZA_WELCOME[Math.floor(Math.random() * MUZA_WELCOME.length)];
}

function tryGetUserId(req: Request): number | null {
  try {
    const authHeader = req.headers.authorization;
    let token: string | undefined;
    if (authHeader?.startsWith("Bearer ")) token = authHeader.slice(7);
    else if (typeof req.query.token === "string") token = req.query.token;
    if (!token || !tokenStore.has(token)) return null;
    return tokenStore.get(token) ?? null;
  } catch {
    return null;
  }
}

function clientIp(req: Request): string {
  const xff = (req.headers["x-forwarded-for"] as string | undefined) || "";
  const first = xff.split(",")[0]?.trim();
  return first || req.ip || req.socket.remoteAddress || "unknown";
}

// Создать chatbotSessions запись если её ещё нет — для web-канала.
function ensureWebSession(sessionId: string, userId: number | null): string {
  const id = sessionId.startsWith("web:") ? sessionId : `web:${sessionId.slice(0, 60)}`;
  const existing = db.select().from(chatbotSessions).where(eq(chatbotSessions.id, id)).get();
  if (existing) {
    if (userId && existing.userId !== userId) {
      try {
        db.update(chatbotSessions).set({ userId }).where(eq(chatbotSessions.id, id)).run();
      } catch {}
    }
    return id;
  }
  try {
    db.insert(chatbotSessions).values({
      id,
      channel: "web",
      externalId: sessionId,
      userId: userId ?? null,
      state: "active",
      startedAt: new Date().toISOString(),
      lastMessageAt: new Date().toISOString(),
    } as any).run();
  } catch (e) {
    console.error("[support] ensureWebSession failed:", e);
  }
  return id;
}

// Telegram-alert админу. Best-effort; не throw'ит.
async function sendAdminTelegramAlert(text: string): Promise<void> {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const adminId = process.env.ADMIN_TELEGRAM_ID;
  if (!token || !adminId) {
    console.warn("[support] telegram alert skipped — TELEGRAM_BOT_TOKEN / ADMIN_TELEGRAM_ID missing");
    return;
  }
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
    console.error("[support] telegram alert failed:", e?.message || e);
  }
}

function ticketSnapshot(row: any): Record<string, unknown> {
  return {
    id: row.id,
    status: row.status,
    priority: row.priority,
    assignedTo: row.assignedTo,
    resolvedAt: row.resolvedAt,
    subject: row.subject,
    updatedAt: row.updatedAt,
  };
}

// === Router ===

const router = Router();

// POST /api/support/create-ticket
// Anyone (auth optional) can create. Returns ticketId + sessionId + welcome msg.
router.post("/create-ticket", async (req: Request, res: Response) => {
  try {
    const parsed = CreateTicketSchema.safeParse(req.body || {});
    if (!parsed.success) {
      logUserActionFailure({
        userId: tryGetUserId(req),
        channel: "web",
        action: "support-create-ticket",
        errorCode: "zod_invalid",
        errorMessage: parsed.error.issues.map(i => i.message).join("; "),
        endpoint: "/api/support/create-ticket",
        statusCode: 400,
      });
      res.status(400).json({ data: null, error: "Некорректные параметры запроса" });
      return;
    }
    const input = parsed.data;
    const userId = tryGetUserId(req);

    // Резолв sessionId — либо принёс юзер (web-чат уже открыт), либо генерим новый.
    const rawSessionId = input.sessionId || crypto.randomUUID();
    const sessionId = input.channel === "web"
      ? ensureWebSession(rawSessionId, userId)
      : rawSessionId;

    // Subject auto-gen если не передан.
    const subject = (input.subject && input.subject.length > 0)
      ? input.subject.slice(0, 300)
      : "Обращение в техподдержку";

    const ticketId = crypto.randomUUID();
    const now = Date.now();
    const meta = JSON.stringify({
      userAgent: String(req.headers["user-agent"] || "").slice(0, 300),
      ip: clientIp(req),
      page: input.page || null,
      currentTrackId: input.currentTrackId || null,
      initialMessage: input.initialMessage ? input.initialMessage.slice(0, 500) : null,
    });

    db.insert(agentHandoffs).values({
      id: ticketId,
      sessionId,
      reason: "support_button",
      assignedTo: null,
      status: "open",
      createdAt: now,
      userId: userId ?? null,
      channel: input.channel,
      subject,
      priority: input.priority,
      updatedAt: now,
      resolvedAt: null,
      meta,
    } as any).run();

    // Push welcome message от Музы в chatbot_messages (только для web —
    // telegram/max имеют свои bot-каналы). Если юзер прислал initialMessage —
    // тоже сохраняем как user-message чтобы LLM-flow подхватил его.
    const welcome = pickWelcome();
    if (input.channel === "web") {
      try {
        if (input.initialMessage && input.initialMessage.trim().length > 0) {
          db.insert(chatbotMessages).values({
            sessionId,
            role: "user",
            text: input.initialMessage.trim().slice(0, 1500),
          } as any).run();
        }
        db.insert(chatbotMessages).values({
          sessionId,
          role: "bot",
          text: welcome,
        } as any).run();
        db.update(chatbotSessions)
          .set({ lastMessageAt: new Date().toISOString() })
          .where(eq(chatbotSessions.id, sessionId))
          .run();
      } catch (e) {
        console.error("[support] failed to push welcome message:", e);
      }
    }

    // Telegram alert админу.
    const uref = userId ? `#${userId}` : "anonymous";
    const prio = input.priority === "urgent" || input.priority === "high"
      ? `🚨 ${input.priority.toUpperCase()}`
      : `priority=${input.priority}`;
    const adminUrl = `${PUBLIC_URL}/#/admin/v304?tab=support&ticket=${encodeURIComponent(ticketId)}`;
    const alertText = [
      `🆘 *Новое обращение в техподдержку*`,
      ``,
      `Ticket: \`${ticketId.slice(0, 8)}\``,
      `User: \`${uref}\``,
      `Канал: \`${input.channel}\``,
      `${prio}`,
      `Тема: ${subject}`,
      input.initialMessage ? `Сообщение: ${input.initialMessage.slice(0, 200)}` : "",
      ``,
      `Открыть: ${adminUrl}`,
    ].filter(Boolean).join("\n");
    sendAdminTelegramAlert(alertText).catch(() => { /* swallow */ });

    res.json({
      data: {
        ticketId,
        sessionId,
        subject,
        priority: input.priority,
        firstMessage: welcome,
      },
      error: null,
    });
  } catch (e: any) {
    console.error("[support create-ticket]", e);
    logUserActionFailure({
      userId: tryGetUserId(req),
      channel: "web",
      action: "support-create-ticket",
      errorCode: "internal",
      errorMessage: e?.message || String(e),
      endpoint: "/api/support/create-ticket",
      statusCode: 500,
    });
    res.status(500).json({ data: null, error: "Не удалось создать обращение. Попробуйте ещё раз." });
  }
});

// GET /api/support/my-tickets — список tickets текущего юзера.
router.get("/my-tickets", (req: Request, res: Response) => {
  try {
    const userId = tryGetUserId(req);
    if (!userId) {
      res.status(401).json({ data: null, error: "Требуется авторизация" });
      return;
    }
    const rows = db.select().from(agentHandoffs)
      .where(eq(agentHandoffs.userId, userId))
      .orderBy(desc(agentHandoffs.createdAt))
      .limit(50)
      .all() as any[];
    res.json({
      data: {
        tickets: rows.map(r => ({
          id: r.id,
          status: r.status,
          priority: r.priority,
          channel: r.channel,
          subject: r.subject,
          reason: r.reason,
          sessionId: r.sessionId,
          assignedTo: r.assignedTo,
          createdAt: r.createdAt,
          updatedAt: r.updatedAt,
          resolvedAt: r.resolvedAt,
        })),
      },
      error: null,
    });
  } catch (e: any) {
    console.error("[support my-tickets]", e);
    res.status(500).json({ data: null, error: "Не удалось загрузить обращения" });
  }
});

// === Admin endpoints ===
const adminRouter = Router();

// GET /api/admin/v304/support/tickets?status=&priority=&channel=&q=&limit=
adminRouter.get("/tickets", requireAdmin, (req: Request, res: Response) => {
  try {
    const status = String(req.query.status || "").trim();
    const priority = String(req.query.priority || "").trim();
    const channel = String(req.query.channel || "").trim();
    const q = String(req.query.q || "").trim().toLowerCase();
    const limit = Math.min(200, Math.max(1, parseInt(String(req.query.limit || "50")) || 50));

    const conds: any[] = [];
    // По умолчанию показываем только support-tickets (а не любые handoffs)
    // — если есть subject/userId/channel заполнены, скорее всего это ticket.
    // Но также включаем reason='support_button' для надёжности.
    conds.push(sql`(reason = 'support_button' OR subject IS NOT NULL OR channel IS NOT NULL)`);
    if (status) conds.push(eq(agentHandoffs.status, status));
    if (priority) conds.push(eq(agentHandoffs.priority, priority));
    if (channel) conds.push(eq(agentHandoffs.channel, channel));

    let where: any = conds.length === 1 ? conds[0] : and(...conds);

    const rows = db.select().from(agentHandoffs)
      .where(where)
      .orderBy(desc(agentHandoffs.createdAt))
      .limit(limit + 50)
      .all() as any[];

    const filtered = q
      ? rows.filter(r => {
          const s = String(r.subject || "").toLowerCase();
          const id = String(r.id || "").toLowerCase();
          return s.includes(q) || id.includes(q);
        })
      : rows;

    // Enrich user data for first ones (name/email).
    const userIds = Array.from(new Set(
      filtered.slice(0, limit).map(r => r.userId).filter((x: any) => typeof x === "number"),
    ));
    const userMap = new Map<number, { name?: string; email?: string }>();
    if (userIds.length > 0) {
      const us = db.select({ id: users.id, name: users.name, email: users.email })
        .from(users).where(inArray(users.id, userIds as number[])).all() as any[];
      for (const u of us) userMap.set(u.id, { name: u.name, email: u.email });
    }

    res.json({
      data: {
        tickets: filtered.slice(0, limit).map(r => ({
          id: r.id,
          status: r.status,
          priority: r.priority,
          channel: r.channel,
          subject: r.subject,
          reason: r.reason,
          sessionId: r.sessionId,
          userId: r.userId,
          user: r.userId ? userMap.get(r.userId) || null : null,
          assignedTo: r.assignedTo,
          createdAt: r.createdAt,
          updatedAt: r.updatedAt,
          resolvedAt: r.resolvedAt,
        })),
        total: filtered.length,
      },
      error: null,
    });
  } catch (e: any) {
    console.error("[support admin tickets list]", e);
    res.status(500).json({ data: null, error: "Не удалось загрузить список обращений" });
  }
});

// POST /api/admin/v304/support/tickets/:id/status
adminRouter.post("/tickets/:id/status", requireAdmin, async (req: Request, res: Response) => {
  try {
    const id = String(req.params.id || "").trim();
    if (!id) {
      res.status(400).json({ data: null, error: "Не указан id обращения" });
      return;
    }
    const parsed = ChangeStatusSchema.safeParse(req.body || {});
    if (!parsed.success) {
      res.status(400).json({ data: null, error: "Некорректные параметры запроса" });
      return;
    }
    const input = parsed.data;
    const existing = db.select().from(agentHandoffs).where(eq(agentHandoffs.id, id)).get() as any;
    if (!existing) {
      res.status(404).json({ data: null, error: "Обращение не найдено" });
      return;
    }
    const before = ticketSnapshot(existing);
    const now = Date.now();
    const update: Record<string, unknown> = {
      status: input.status,
      updatedAt: now,
    };
    if (input.priority) update.priority = input.priority;
    if (input.assignedTo !== undefined) {
      if (typeof input.assignedTo === "number") update.assignedTo = input.assignedTo;
      else if (typeof input.assignedTo === "string") {
        // 'muza' / 'admin' / username — пишем в assigned_to как строковый
        // tag? Drizzle column integer. Если число — кастуем, иначе игнорим.
        const asNum = parseInt(input.assignedTo);
        if (!Number.isNaN(asNum)) update.assignedTo = asNum;
      }
    }
    if (input.status === "resolved" || input.status === "closed") {
      update.resolvedAt = now;
    }
    db.update(agentHandoffs).set(update as any).where(eq(agentHandoffs.id, id)).run();

    // Audit log.
    const auditId = recordAuditEntry({
      req,
      action: "update",
      entity: "support_ticket",
      entityKey: id,
      before,
      after: { ...before, ...update, resolutionNote: input.resolutionNote || null },
    });

    // Если статус resolved — заметка в чат (только web-канал).
    if (existing.channel === "web" && input.resolutionNote && input.status === "resolved") {
      try {
        db.insert(chatbotMessages).values({
          sessionId: existing.sessionId,
          role: "bot",
          text: `Админ: ${input.resolutionNote.slice(0, 1500)}`,
        } as any).run();
      } catch (e) {
        console.error("[support] failed to push admin note:", e);
      }
    }

    res.json({
      data: {
        ticketId: id,
        status: input.status,
        auditId,
      },
      error: null,
    });
  } catch (e: any) {
    console.error("[support admin status change]", e);
    res.status(500).json({ data: null, error: "Не удалось изменить статус" });
  }
});

// Mount admin router on /api/admin/v304/support via the module.
const adminMountRouter = Router();
adminMountRouter.use("/support", adminRouter);

const supportModule: Module = {
  name: "support",
  version: "0.1.0",
  description: "Support tickets — user-initiated handoffs (кнопка «🆘 Техподдержка»).",
  routes: { prefix: "support", router },
  onLoad: async (ctx) => {
    // Mount admin sub-router. Plugin routes go through `prefix` which becomes
    // /api/<prefix>/... — admin paths нужны под /api/admin/v304/... поэтому
    // регистрируем напрямую через app.use из BootContext.
    ctx.app.use("/api/admin/v304", adminMountRouter);
    ctx.logger.info("support plugin online (handoff-backed tickets)");
  },
  healthCheck: () => ({ status: "ok" }),
};

export default supportModule;
