// Eugene 2026-05-25 Босс «Агент Почтальон» — почтовый AI-робот MuzaAi.
//
// Плагин-обёртка над lib/postmanAgent.ts. Express + SQLite (НЕ Yandex
// Functions / PostgreSQL из исходного ТЗ). Endpoints:
//
//   Public (без auth):
//     POST /api/subscriptions              — opt-in (double opt-in step 1)
//     GET  /api/subscriptions/confirm?token= — double opt-in step 2
//     POST /api/subscriptions/unsubscribe   — отписка (token в body)
//     GET  /u/:token                        — отписка одним кликом (визуальный)
//     POST /u/:token                        — one-click (RFC 8058 List-Unsubscribe-Post)
//
//   Admin (requireAdmin):
//     GET  /api/admin/v304/postman/stats    — статистика
//     GET  /api/admin/v304/postman/consents — журнал согласий (доказательная база)
//     GET  /api/admin/v304/postman/inbox    — входящие (AI-классифицированные)
//     POST /api/admin/v304/postman/campaign — запустить кампанию (dryRun по умолчанию)
//
// Юр-фундамент: double opt-in, журнал согласий с IP/UA, one-click unsubscribe,
// suppress-list, маркировка «реклама» + List-Unsubscribe. Подчинён Директору
// (register / recordActivity / healthCheck / edges в bootstrapDefaultAgents).

import { Router, type Request, type Response } from "express";
import { z } from "zod";
import type { Module } from "../../core";
import { requireAdmin } from "../../core/adminAuth";
import { tokenStore } from "../../lib/tokenStore";
import {
  ensurePostmanTables,
  subscribeOptIn,
  confirmOptIn,
  unsubscribeByToken,
  sendCampaign,
  getStats,
  listConsents,
  listInbox,
  type ConsentChannel,
  type SegmentCriteria,
} from "../../lib/postmanAgent";

// === Helpers ===

function clientIp(req: Request): string {
  const xf = (req.headers["x-forwarded-for"] as string) || "";
  if (xf) return xf.split(",")[0].trim();
  return req.ip || req.socket?.remoteAddress || "";
}

function tryGetUserId(req: Request): number | null {
  try {
    const auth = req.headers.authorization;
    let token: string | undefined;
    if (auth?.startsWith("Bearer ")) token = auth.slice(7);
    else if (typeof req.query.token === "string") token = req.query.token;
    if (!token || !tokenStore.has(token)) return null;
    return tokenStore.get(token) ?? null;
  } catch {
    return null;
  }
}

// === Zod ===

const OptInSchema = z.object({
  email: z.string().trim().email().max(320),
  channel: z.enum(["product", "news", "marketing", "survey"]).optional(),
  consentText: z.string().trim().max(4000).optional(),
  source: z.string().trim().max(80).optional(),
  locale: z.string().trim().max(10).optional(),
});

const UnsubSchema = z.object({
  token: z.string().trim().min(8).max(200),
});

const CampaignSchema = z.object({
  name: z.string().trim().min(1).max(200),
  subject: z.string().trim().min(1).max(300),
  bodyText: z.string().trim().min(1).max(20000),
  isAd: z.boolean().optional(),
  limit: z.number().int().min(1).max(5000).optional(),
  dryRun: z.boolean().optional(),
  segment: z.object({
    channel: z.enum(["product", "news", "marketing", "survey"]).optional(),
    status: z.enum(["pending", "active", "unsubscribed", "bounced", "complained"]).optional(),
    locale: z.string().trim().max(10).optional(),
  }).optional(),
});

// === Public router (mounted at /api via routes.prefix="") ===

const publicRouter = Router();

// POST /api/subscriptions — opt-in (double opt-in step 1)
publicRouter.post("/subscriptions", async (req: Request, res: Response) => {
  try {
    const parsed = OptInSchema.safeParse(req.body || {});
    if (!parsed.success) {
      res.status(400).json({ data: null, error: "Некорректный email" });
      return;
    }
    const r = await subscribeOptIn({
      email: parsed.data.email,
      channel: parsed.data.channel as ConsentChannel | undefined,
      consentText: parsed.data.consentText,
      source: parsed.data.source || "api",
      locale: parsed.data.locale,
      userId: tryGetUserId(req),
      ip: clientIp(req),
      userAgent: req.headers["user-agent"] as string | undefined,
    });
    if (!r.ok) {
      res.status(400).json({ data: null, error: r.error || "Не удалось оформить подписку" });
      return;
    }
    res.json({ data: { status: r.status }, error: null });
  } catch (e: any) {
    console.error("[postman subscribe]", e?.message || e);
    res.status(500).json({ data: null, error: "Внутренняя ошибка" });
  }
});

// GET /api/subscriptions/confirm?token= — double opt-in step 2
publicRouter.get("/subscriptions/confirm", (req: Request, res: Response) => {
  const token = String(req.query.token || "");
  const r = confirmOptIn(token, { ip: clientIp(req), userAgent: req.headers["user-agent"] as string | undefined });
  // Человеко-читаемая HTML-страница (юзер открывает из письма).
  const ok = r.ok;
  const msg = ok ? "Подписка подтверждена! Спасибо — теперь вы будете получать письма от MuzaAi." : (r.error || "Не удалось подтвердить подписку.");
  res.status(ok ? 200 : 400).set("Content-Type", "text/html; charset=utf-8").send(
    confirmPage(ok, msg),
  );
});

// POST /api/subscriptions/unsubscribe — отписка (token в body)
publicRouter.post("/subscriptions/unsubscribe", (req: Request, res: Response) => {
  const parsed = UnsubSchema.safeParse(req.body || {});
  if (!parsed.success) {
    res.status(400).json({ data: null, error: "Нужен token" });
    return;
  }
  const r = unsubscribeByToken(parsed.data.token, { ip: clientIp(req), userAgent: req.headers["user-agent"] as string | undefined });
  if (!r.ok) {
    res.status(400).json({ data: null, error: r.error || "Не удалось отписать" });
    return;
  }
  res.json({ data: { unsubscribed: true, already: !!r.alreadyUnsubscribed }, error: null });
});

// === One-click unsubscribe router (mounted at /u) ===
// RFC 8058: почтовый клиент шлёт POST /u/:token с List-Unsubscribe=One-Click.
// Браузерный клик юзера — GET /u/:token (показывает страницу).

const unsubRouter = Router();

unsubRouter.get("/:token", (req: Request, res: Response) => {
  const r = unsubscribeByToken(String(req.params.token || ""), { ip: clientIp(req), userAgent: req.headers["user-agent"] as string | undefined });
  const ok = r.ok;
  const msg = ok
    ? (r.alreadyUnsubscribed ? "Вы уже отписаны. Больше писем рассылки не будет." : "Вы отписались от рассылки MuzaAi. Больше писем не будет.")
    : (r.error || "Ссылка отписки недействительна.");
  res.status(ok ? 200 : 400).set("Content-Type", "text/html; charset=utf-8").send(unsubPage(ok, msg));
});

unsubRouter.post("/:token", (req: Request, res: Response) => {
  // One-click POST (List-Unsubscribe-Post). Тело: List-Unsubscribe=One-Click.
  const r = unsubscribeByToken(String(req.params.token || ""), { ip: clientIp(req), userAgent: req.headers["user-agent"] as string | undefined });
  // RFC 8058: ответ 200 даже если уже отписан.
  res.status(r.ok ? 200 : 400).json({ data: { unsubscribed: r.ok }, error: r.ok ? null : (r.error || "error") });
});

// === Admin router (requireAdmin) ===

const adminRouter = Router();
adminRouter.use(requireAdmin);

// GET /api/admin/v304/postman/stats
adminRouter.get("/postman/stats", (_req: Request, res: Response) => {
  try {
    res.json({ data: getStats(), error: null });
  } catch (e: any) {
    res.status(500).json({ data: null, error: "Не удалось получить статистику" });
  }
});

// GET /api/admin/v304/postman/consents?limit=
adminRouter.get("/postman/consents", (req: Request, res: Response) => {
  try {
    const limit = Math.max(1, Math.min(1000, parseInt(String(req.query.limit || "100"), 10) || 100));
    res.json({ data: { items: listConsents(limit) }, error: null });
  } catch (e: any) {
    res.status(500).json({ data: null, error: "Не удалось получить согласия" });
  }
});

// GET /api/admin/v304/postman/inbox?limit=&category=
adminRouter.get("/postman/inbox", (req: Request, res: Response) => {
  try {
    const limit = Math.max(1, Math.min(500, parseInt(String(req.query.limit || "50"), 10) || 50));
    const category = (req.query.category as string) || undefined;
    res.json({ data: { items: listInbox(limit, category) }, error: null });
  } catch (e: any) {
    res.status(500).json({ data: null, error: "Не удалось получить входящие" });
  }
});

// POST /api/admin/v304/postman/campaign — запустить кампанию (dryRun по умолчанию)
adminRouter.post("/postman/campaign", async (req: Request, res: Response) => {
  try {
    const parsed = CampaignSchema.safeParse(req.body || {});
    if (!parsed.success) {
      res.status(400).json({ data: null, error: "Некорректные параметры кампании" });
      return;
    }
    const d = parsed.data;
    // По умолчанию dryRun=true (безопасно — не разослать случайно).
    const dryRun = d.dryRun !== false;
    const r = await sendCampaign({
      name: d.name,
      subject: d.subject,
      bodyText: d.bodyText,
      isAd: d.isAd,
      limit: d.limit,
      dryRun,
      segment: d.segment as SegmentCriteria | undefined,
    });
    if (!r.ok) {
      res.status(400).json({ data: null, error: r.error || "Не удалось запустить кампанию" });
      return;
    }
    res.json({ data: r, error: null });
  } catch (e: any) {
    console.error("[postman campaign]", e?.message || e);
    res.status(500).json({ data: null, error: "Внутренняя ошибка" });
  }
});

// === HTML pages (минимальные, brand-ish) ===

function pageShell(ok: boolean, title: string, msg: string): string {
  const accent = ok ? "#a855f7" : "#ef4444";
  return `<!DOCTYPE html><html lang="ru"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>${title} · MuzaAi</title></head>
<body style="font-family:system-ui,Arial,sans-serif;background:#0a0a17;color:#fff;margin:0;display:flex;min-height:100vh;align-items:center;justify-content:center;padding:24px;">
<div style="max-width:480px;background:#1a0f2e;border:1px solid rgba(168,85,247,0.3);border-radius:16px;padding:32px;text-align:center;">
<div style="font-size:28px;font-weight:bold;margin-bottom:16px;background:linear-gradient(90deg,#a855f7,#3b82f6);-webkit-background-clip:text;background-clip:text;color:transparent;">MuzaAi</div>
<h1 style="font-size:20px;color:${accent};margin:8px 0 16px;">${title}</h1>
<p style="color:#ccc;line-height:1.6;">${msg}</p>
<p style="margin-top:24px;"><a href="https://muzaai.ru" style="color:#a855f7;">На главную muzaai.ru</a></p>
</div></body></html>`;
}

function confirmPage(ok: boolean, msg: string): string {
  return pageShell(ok, ok ? "Подписка подтверждена" : "Не удалось подтвердить", msg);
}

function unsubPage(ok: boolean, msg: string): string {
  return pageShell(ok, ok ? "Вы отписаны" : "Ошибка отписки", msg);
}

// === Module ===

const postmanModule: Module = {
  name: "postman",
  version: "0.1.0",
  description:
    "Агент Почтальон — email opt-in (double), журнал согласий, one-click unsubscribe (RFC 8058), suppress-list, кампании с маркировкой «реклама». Подчинён Музa Директору.",
  migrations: [
    {
      version: "001_postman_email.sql",
      up: `
        CREATE TABLE IF NOT EXISTS email_subscribers (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          user_id INTEGER,
          email TEXT NOT NULL UNIQUE,
          status TEXT NOT NULL DEFAULT 'pending',
          locale TEXT NOT NULL DEFAULT 'ru',
          confirm_token_hash TEXT,
          confirm_token_expires_at INTEGER,
          confirmed_at INTEGER,
          unsubscribe_token TEXT UNIQUE,
          unsubscribed_at INTEGER,
          bounce_reason TEXT,
          source TEXT,
          created_at TEXT DEFAULT CURRENT_TIMESTAMP
        );
        CREATE INDEX IF NOT EXISTS idx_subscribers_status ON email_subscribers(status);
        CREATE INDEX IF NOT EXISTS idx_subscribers_user ON email_subscribers(user_id);

        CREATE TABLE IF NOT EXISTS email_consents (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          subscriber_id INTEGER NOT NULL,
          channel TEXT NOT NULL,
          action TEXT NOT NULL,
          consent_text TEXT,
          source TEXT,
          ip TEXT,
          user_agent TEXT,
          created_at TEXT DEFAULT CURRENT_TIMESTAMP
        );
        CREATE INDEX IF NOT EXISTS idx_consents_subscriber ON email_consents(subscriber_id, created_at DESC);

        CREATE TABLE IF NOT EXISTS email_campaigns (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          name TEXT NOT NULL,
          status TEXT NOT NULL DEFAULT 'draft',
          segment_json TEXT,
          subject TEXT,
          body_text TEXT,
          is_ad INTEGER NOT NULL DEFAULT 0,
          sent_count INTEGER NOT NULL DEFAULT 0,
          failed_count INTEGER NOT NULL DEFAULT 0,
          created_at TEXT DEFAULT CURRENT_TIMESTAMP
        );

        CREATE TABLE IF NOT EXISTS postman_send_log (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          subscriber_id INTEGER NOT NULL,
          campaign_id INTEGER,
          sent_at INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_postman_send ON postman_send_log(subscriber_id, campaign_id, sent_at DESC);

        CREATE TABLE IF NOT EXISTS postman_inbox (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          from_email TEXT,
          subject TEXT,
          snippet TEXT,
          category TEXT,
          sentiment TEXT,
          created_at INTEGER NOT NULL,
          handled INTEGER NOT NULL DEFAULT 0
        );
        CREATE INDEX IF NOT EXISTS idx_postman_inbox_cat ON postman_inbox(category, created_at DESC);
      `,
    },
  ],
  // Публичные /api/subscriptions/* монтируются через prefix="" (router сам
  // содержит /subscriptions). One-click /u/:token и admin — через onLoad.
  routes: { prefix: "", router: publicRouter },
  onLoad: async (ctx) => {
    ensurePostmanTables();
    ctx.app.use("/u", unsubRouter);
    ctx.app.use("/api/admin/v304", adminRouter);
    ctx.logger.info(
      "postman online — POST /api/subscriptions, GET /api/subscriptions/confirm, /u/:token (one-click), admin /api/admin/v304/postman/*",
    );
  },
  healthCheck: () => {
    try {
      const { postmanHealth } = require("../../lib/postmanAgent") as typeof import("../../lib/postmanAgent");
      const h = postmanHealth();
      return { status: h.ok ? "ok" : "degraded", details: h.details };
    } catch {
      return { status: "down" };
    }
  },
};

export default postmanModule;
