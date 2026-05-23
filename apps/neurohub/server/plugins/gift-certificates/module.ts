// Eugene 2026-05-23 Босс «подарочный сертификат в ЛК».
//
// Полная фича: покупка / формирование открытки / уникальные коды-QR /
// activation/redeem / архив действий agentом / admin governance.
//
// Schema, endpoints, integrations с existing payment pipeline через invoices.
//
// CLAUDE.md rules:
//   - Thin core + plugins (новый плагин, не правит core)
//   - Plugin owns its tables (gift_certificates + gift_certificate_audit)
//   - Reuse-working-solutions (Robokassa через invoices+/api/payment/create)
//   - Backup-before-edit (admin_audit_log на каждое admin-действие)
//   - Admin-everything-except-delete (revoke OK, hard-delete нужен confirm)
//   - Brand-style consistency (postcard в palette)
//
// Spec: docs/strategy/original/06 (Module API).

import { Router } from "express";
import type { Module, BootContext } from "../../core";
import { db, storage } from "../../storage";
import { invoices } from "@shared/schema";
import { tokenStore } from "../../lib/tokenStore";
import { requireAdmin } from "../../core/adminAuth";
import { recordAuditEntry } from "../../lib/adminAuditLog";
import { generateCode, normalizeCode, isCodeValid } from "../../lib/giftCertificateCode";
import { redeemCertificate } from "../../lib/giftCertificateRedeem";
import { renderPostcardSvg, POSTCARD_TEMPLATES, type PostcardTemplate } from "../../lib/giftPostcardRenderer";

const sqlite: any = (db as any).$client;

const userRouter = Router();
const adminRouter = Router();

// ─────────────────────────────────────────────────────────────────────
// Auth middleware (легковесный — копия паттерна из routes.ts authMiddleware,
// но local чтобы не зависеть от глобального import'а).
// ─────────────────────────────────────────────────────────────────────
function getBearerToken(req: any): string | null {
  const auth = req.headers?.authorization;
  if (typeof auth === "string" && auth.startsWith("Bearer ")) return auth.slice(7);
  if (typeof req.query?.token === "string") return req.query.token;
  return null;
}

function authMiddleware(req: any, res: any, next: any): void {
  const tok = getBearerToken(req);
  if (!tok || !tokenStore.has(tok)) {
    res.status(401).json({ ok: false, error: "Не авторизован" });
    return;
  }
  const uid = tokenStore.get(tok)!;
  const u = storage.getUser(uid);
  if (u && (u as any).blocked) {
    res.status(403).json({ ok: false, error: "Аккаунт заблокирован" });
    return;
  }
  req.userId = uid;
  next();
}

// ─────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────

// Pricing-single-source rule — стандартные номиналы. Custom = любое значение в диапазоне.
// Все в КОПЕЙКАХ.
const STANDARD_DENOMINATIONS_KOPECKS = [30000, 50000, 100000, 200000] as const;
const MIN_AMOUNT_KOPECKS = 10000;     // 100 ₽
const MAX_AMOUNT_KOPECKS = 5000000;   // 50 000 ₽

const DEFAULT_TTL_DAYS = 365;
const ALLOWED_CREDIT_TYPES = new Set(["balance", "tracks", "covers", "lyrics", "mixed"]);

// ─────────────────────────────────────────────────────────────────────
// Schema setup (idempotent — создаётся через migrations array на module load)
// ─────────────────────────────────────────────────────────────────────
const MIGRATION_SQL = `
  CREATE TABLE IF NOT EXISTS gift_certificates (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    code TEXT UNIQUE NOT NULL,
    qr_data TEXT,
    purchased_by_user_id INTEGER,
    amount_kopecks INTEGER NOT NULL,
    credit_type TEXT NOT NULL DEFAULT 'balance',
    credit_value_json TEXT,
    status TEXT NOT NULL DEFAULT 'pending',
    redeemed_by_user_id INTEGER,
    redeemed_at INTEGER,
    expires_at INTEGER,
    paid_at INTEGER,
    payment_id INTEGER,
    invoice_id INTEGER,
    postcard_template TEXT DEFAULT 'classic',
    postcard_message TEXT,
    postcard_image_url TEXT,
    postcard_title TEXT,
    from_name TEXT,
    recipient_email TEXT,
    recipient_phone TEXT,
    recipient_user_id INTEGER,
    attached_track_id INTEGER,
    sent_at INTEGER,
    sent_channel TEXT,
    created_at INTEGER NOT NULL,
    created_by_admin INTEGER NOT NULL DEFAULT 0
  );
  CREATE UNIQUE INDEX IF NOT EXISTS idx_gift_certs_code ON gift_certificates(code);
  CREATE INDEX IF NOT EXISTS idx_gift_certs_purchased_by ON gift_certificates(purchased_by_user_id);
  CREATE INDEX IF NOT EXISTS idx_gift_certs_redeemed_by ON gift_certificates(redeemed_by_user_id);
  CREATE INDEX IF NOT EXISTS idx_gift_certs_status ON gift_certificates(status, created_at DESC);
  CREATE INDEX IF NOT EXISTS idx_gift_certs_recipient_email ON gift_certificates(recipient_email);

  CREATE TABLE IF NOT EXISTS gift_certificate_audit (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    certificate_id INTEGER NOT NULL,
    action TEXT NOT NULL,
    actor_user_id INTEGER,
    actor_role TEXT,
    metadata_json TEXT,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_gift_audit_cert ON gift_certificate_audit(certificate_id, created_at DESC);
  CREATE INDEX IF NOT EXISTS idx_gift_audit_action ON gift_certificate_audit(action, created_at DESC);
`;

// ─────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────

function writeAudit(certId: number, action: string, actorUserId: number | null, role: string, meta?: Record<string, unknown>): void {
  try {
    sqlite.prepare(
      `INSERT INTO gift_certificate_audit
         (certificate_id, action, actor_user_id, actor_role, metadata_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(certId, action, actorUserId, role, meta ? JSON.stringify(meta) : null, Date.now());
  } catch (e) {
    console.warn("[gift-cert audit] failed:", (e as Error).message);
  }
}

function buildCertRecord(row: any): Record<string, unknown> {
  if (!row) return {};
  let creditValue: unknown = null;
  try { if (row.credit_value_json) creditValue = JSON.parse(row.credit_value_json); } catch {}
  return {
    id: row.id,
    code: row.code,
    purchasedByUserId: row.purchased_by_user_id,
    amountKopecks: row.amount_kopecks,
    amountRubles: Math.round(row.amount_kopecks / 100),
    creditType: row.credit_type,
    creditValue,
    status: row.status,
    redeemedByUserId: row.redeemed_by_user_id,
    redeemedAt: row.redeemed_at,
    expiresAt: row.expires_at,
    paidAt: row.paid_at,
    paymentId: row.payment_id,
    invoiceId: row.invoice_id,
    postcardTemplate: row.postcard_template,
    postcardMessage: row.postcard_message,
    postcardTitle: row.postcard_title,
    postcardImageUrl: row.postcard_image_url,
    fromName: row.from_name,
    recipientEmail: row.recipient_email,
    recipientPhone: row.recipient_phone,
    recipientUserId: row.recipient_user_id,
    attachedTrackId: row.attached_track_id,
    sentAt: row.sent_at,
    sentChannel: row.sent_channel,
    createdAt: row.created_at,
    createdByAdmin: row.created_by_admin === 1,
  };
}

function genUniqueCode(): string {
  return generateCode({
    existsCb: (code: string) => {
      const row = sqlite.prepare(`SELECT 1 FROM gift_certificates WHERE code = ?`).get(code);
      return !!row;
    },
    maxRetries: 10,
  });
}

function validateCreditValue(creditType: string, raw: any, amountKopecks: number): { ok: true; value: any } | { ok: false; error: string } {
  if (!ALLOWED_CREDIT_TYPES.has(creditType)) {
    return { ok: false, error: `Неподдерживаемый credit_type: ${creditType}` };
  }
  const v = (raw && typeof raw === "object") ? raw : {};
  const out: Record<string, number> = {};
  if (creditType === "balance" || creditType === "mixed") {
    // По умолчанию весь amount уходит в balance
    out.balance_kopecks = Number.isFinite(v.balance_kopecks) ? Math.max(0, Math.floor(v.balance_kopecks)) : amountKopecks;
  }
  if (creditType === "tracks" || creditType === "mixed") {
    out.tracks_count = Number.isFinite(v.tracks_count) ? Math.max(0, Math.floor(v.tracks_count)) : 0;
  }
  if (creditType === "covers" || creditType === "mixed") {
    out.covers_count = Number.isFinite(v.covers_count) ? Math.max(0, Math.floor(v.covers_count)) : 0;
  }
  if (creditType === "lyrics" || creditType === "mixed") {
    out.lyrics_count = Number.isFinite(v.lyrics_count) ? Math.max(0, Math.floor(v.lyrics_count)) : 0;
  }
  if (creditType === "tracks" && !out.tracks_count) {
    // По умолчанию — 1 трек если не указан count
    out.tracks_count = 1;
  }
  if (creditType === "covers" && !out.covers_count) out.covers_count = 1;
  if (creditType === "lyrics" && !out.lyrics_count) out.lyrics_count = 1;
  return { ok: true, value: out };
}

function buildValueLabel(creditType: string, creditValue: any, amountKopecks: number): string {
  const parts: string[] = [];
  if (creditValue?.balance_kopecks > 0) {
    parts.push(`${Math.round(creditValue.balance_kopecks / 100)} ₽`);
  }
  if (creditValue?.tracks_count > 0) parts.push(`${creditValue.tracks_count} трек(а/ов)`);
  if (creditValue?.covers_count > 0) parts.push(`${creditValue.covers_count} обложек`);
  if (creditValue?.lyrics_count > 0) parts.push(`${creditValue.lyrics_count} текстов`);
  if (parts.length === 0) parts.push(`${Math.round(amountKopecks / 100)} ₽`);
  return parts.join(" + ");
}

// ─────────────────────────────────────────────────────────────────────
// USER ENDPOINTS
// ─────────────────────────────────────────────────────────────────────

/**
 * POST /api/gift-cert/create
 * Создать draft (status=pending), вернуть invoiceId+paymentInitUrl для оплаты через Robokassa.
 *
 * Body: {
 *   amountKopecks (или amount_rub), creditType, creditValue?,
 *   postcardTemplate?, postcardMessage?, postcardTitle?, fromName?,
 *   recipientEmail?, recipientPhone?, attachedTrackId?
 * }
 */
userRouter.post("/create", authMiddleware, async (req: any, res: any) => {
  try {
    const userId = req.userId as number;
    const body = req.body || {};

    let amountKopecks = Number(body.amountKopecks);
    if (!Number.isFinite(amountKopecks) && body.amountRub) {
      amountKopecks = Math.round(Number(body.amountRub) * 100);
    }
    if (!Number.isFinite(amountKopecks) || amountKopecks < MIN_AMOUNT_KOPECKS || amountKopecks > MAX_AMOUNT_KOPECKS) {
      res.status(400).json({
        ok: false,
        error: `Сумма от ${MIN_AMOUNT_KOPECKS / 100} до ${MAX_AMOUNT_KOPECKS / 100} ₽`,
      });
      return;
    }
    amountKopecks = Math.floor(amountKopecks);

    const creditType = String(body.creditType || "balance");
    const validated = validateCreditValue(creditType, body.creditValue, amountKopecks);
    if (!validated.ok) {
      res.status(400).json({ ok: false, error: validated.error });
      return;
    }

    const postcardTemplate: PostcardTemplate = POSTCARD_TEMPLATES.includes(body.postcardTemplate)
      ? body.postcardTemplate
      : "classic";
    const postcardMessage = String(body.postcardMessage || "").slice(0, 500);
    const postcardTitle = String(body.postcardTitle || "").slice(0, 100);
    const fromName = String(body.fromName || "").slice(0, 80);
    const recipientEmail = String(body.recipientEmail || "").trim().slice(0, 200) || null;
    const recipientPhone = String(body.recipientPhone || "").trim().slice(0, 32) || null;
    const attachedTrackId = Number.isFinite(Number(body.attachedTrackId)) ? Math.floor(Number(body.attachedTrackId)) : null;

    // Проверка ownership attached track
    if (attachedTrackId) {
      const gen: any = sqlite.prepare(`SELECT user_id FROM generations WHERE id = ?`).get(attachedTrackId);
      if (!gen) {
        res.status(400).json({ ok: false, error: "Трек для прикрепления не найден" });
        return;
      }
      if (gen.user_id !== userId) {
        res.status(403).json({ ok: false, error: "Можно прикрепить только свой трек" });
        return;
      }
    }

    const code = genUniqueCode();
    const nowMs = Date.now();
    const expiresAt = nowMs + DEFAULT_TTL_DAYS * 24 * 60 * 60 * 1000;

    // Создаём invoice (через invoices таблицу) — связь с payment'ом standard
    const amountRub = Math.round(amountKopecks / 100);
    const invDesc = `Подарочный сертификат MuzaAi ${buildValueLabel(creditType, validated.value, amountKopecks)} (код ${code})`;
    const invoiceInsert = db.insert(invoices).values({
      userId,
      issuedBy: "system",
      amountRub,
      description: invDesc,
      tariffKey: `gift_cert_${creditType}`,
      status: "issued",
      expiresAt: new Date(expiresAt).toISOString(),
      meta: JSON.stringify({ giftCertCode: code, creditType }),
    } as any).returning().get();

    // Создаём gift_certificate record
    const insertResult = sqlite.prepare(
      `INSERT INTO gift_certificates
         (code, purchased_by_user_id, amount_kopecks, credit_type, credit_value_json,
          status, expires_at, invoice_id, postcard_template, postcard_message,
          postcard_title, from_name, recipient_email, recipient_phone, attached_track_id,
          created_at, created_by_admin)
       VALUES (?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)`,
    ).run(
      code,
      userId,
      amountKopecks,
      creditType,
      JSON.stringify(validated.value),
      expiresAt,
      (invoiceInsert as any)?.id || null,
      postcardTemplate,
      postcardMessage || null,
      postcardTitle || null,
      fromName || null,
      recipientEmail,
      recipientPhone,
      attachedTrackId,
      nowMs,
    );
    const certId = Number(insertResult.lastInsertRowid);

    writeAudit(certId, "created", userId, "user", {
      amountKopecks,
      creditType,
      creditValue: validated.value,
      invoiceId: (invoiceInsert as any)?.id,
      recipientEmail: recipientEmail || null,
      recipientPhone: recipientPhone || null,
      attachedTrackId: attachedTrackId || null,
    });

    res.json({
      ok: true,
      certificateId: certId,
      code,
      invoiceId: (invoiceInsert as any)?.id,
      // Frontend → POST /api/payment/create {invoiceId} → получит paymentUrl с Robokassa redirect
      paymentInitEndpoint: "/api/payment/create",
      paymentInitBody: { invoiceId: (invoiceInsert as any)?.id },
      amountKopecks,
      amountRub,
      expiresAt,
      creditType,
      creditValue: validated.value,
      postcardTemplate,
      message: "Сертификат создан. Перейдите к оплате чтобы активировать его.",
    });
  } catch (e: any) {
    console.error("[gift-cert/create]", e);
    res.status(500).json({ ok: false, error: "Внутренняя ошибка создания сертификата" });
  }
});

/**
 * GET /api/gift-cert/my
 * Список моих сертификатов (как покупатель + как получатель).
 */
userRouter.get("/my", authMiddleware, (req: any, res: any) => {
  try {
    const userId = req.userId as number;
    const role = String(req.query.role || "all"); // 'purchased' | 'received' | 'all'

    const rows: any[] = [];
    if (role === "purchased" || role === "all") {
      const purchased = sqlite.prepare(
        `SELECT * FROM gift_certificates
         WHERE purchased_by_user_id = ?
         ORDER BY id DESC LIMIT 200`,
      ).all(userId);
      for (const r of purchased) {
        rows.push({ ...buildCertRecord(r), relation: "purchased" });
      }
    }
    if (role === "received" || role === "all") {
      const received = sqlite.prepare(
        `SELECT * FROM gift_certificates
         WHERE redeemed_by_user_id = ? OR recipient_user_id = ?
         ORDER BY id DESC LIMIT 200`,
      ).all(userId, userId);
      for (const r of received) {
        rows.push({ ...buildCertRecord(r), relation: "received" });
      }
    }

    res.json({ ok: true, items: rows, count: rows.length });
  } catch (e: any) {
    console.error("[gift-cert/my]", e);
    res.status(500).json({ ok: false, error: "Не удалось загрузить сертификаты" });
  }
});

/**
 * POST /api/gift-cert/redeem
 * Активировать сертификат по коду. Body: {code}.
 */
userRouter.post("/redeem", authMiddleware, (req: any, res: any) => {
  try {
    const userId = req.userId as number;
    const rawCode = String(req.body?.code || "");
    if (!rawCode) {
      res.status(400).json({ ok: false, error: "Код обязателен" });
      return;
    }
    const code = normalizeCode(rawCode);
    if (!isCodeValid(code)) {
      res.status(400).json({ ok: false, error: "Формат кода: XXXX-XXXX-XXXX (буквы и цифры)" });
      return;
    }
    const result = redeemCertificate(code, {
      userId,
      ip: req.ip || null,
      userAgent: String(req.headers["user-agent"] || ""),
    });
    if (!result.ok) {
      res.status(400).json(result);
      return;
    }
    res.json(result);
  } catch (e: any) {
    console.error("[gift-cert/redeem]", e);
    res.status(500).json({ ok: false, error: "Внутренняя ошибка активации" });
  }
});

/**
 * GET /api/gift-cert/:id/postcard
 * Render postcard SVG. Если ?download=1 — header Content-Disposition: attachment.
 *
 * Public-доступен по ID + code (для отправки получателю — он не auth):
 *   - Если auth + cert принадлежит юзеру → доступ
 *   - Если есть query.code и совпадает с cert.code → доступ (для unauthenticated получателя)
 */
userRouter.get("/:id/postcard", (req: any, res: any) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isFinite(id)) {
      res.status(400).json({ ok: false, error: "Bad id" });
      return;
    }
    const row: any = sqlite.prepare(
      `SELECT * FROM gift_certificates WHERE id = ?`,
    ).get(id);
    if (!row) {
      res.status(404).json({ ok: false, error: "Сертификат не найден" });
      return;
    }

    // Access check
    const tok = getBearerToken(req);
    const userId = tok ? tokenStore.get(tok) || 0 : 0;
    const codeFromQuery = normalizeCode(String(req.query.code || ""));
    const hasAccess =
      (userId && (row.purchased_by_user_id === userId || row.redeemed_by_user_id === userId || row.recipient_user_id === userId)) ||
      (codeFromQuery && codeFromQuery === row.code);
    if (!hasAccess) {
      res.status(403).json({ ok: false, error: "Доступ запрещён" });
      return;
    }

    let creditValue: any = null;
    try { if (row.credit_value_json) creditValue = JSON.parse(row.credit_value_json); } catch {}
    const valueLabel = buildValueLabel(row.credit_type, creditValue, row.amount_kopecks);
    const expiresLabel = row.expires_at
      ? new Date(row.expires_at).toLocaleDateString("ru-RU", { day: "numeric", month: "long", year: "numeric" })
      : "";

    const rendered = renderPostcardSvg({
      template: (row.postcard_template || "classic") as PostcardTemplate,
      code: row.code,
      title: row.postcard_title || "Подарок от души",
      message: row.postcard_message || "",
      fromName: row.from_name || "",
      valueLabel,
      expiresLabel: expiresLabel ? `до ${expiresLabel}` : "",
    });

    res.setHeader("Content-Type", "image/svg+xml; charset=utf-8");
    res.setHeader("Cache-Control", "private, max-age=300");
    if (req.query.download === "1") {
      res.setHeader("Content-Disposition", `attachment; filename="postcard-${row.code}.svg"`);
    }
    res.send(rendered.svg);
  } catch (e: any) {
    console.error("[gift-cert/postcard]", e);
    res.status(500).json({ ok: false, error: "Ошибка рендера открытки" });
  }
});

/**
 * POST /api/gift-cert/:id/send
 * Отправить получателю (email и/или sms-уведомление с link на postcard view).
 * Body: {channel?: 'email'|'phone'|'auto', overrideRecipientEmail?, overrideRecipientPhone?}
 *
 * Текущая реализация — записывает sent_at + sent_channel. Реальная доставка
 * email/sms делегируется через event 'gift_certificate.sent' (подписчики —
 * notifications plugin + auth-sms plugin для SMS).
 */
userRouter.post("/:id/send", authMiddleware, (req: any, res: any) => {
  try {
    const userId = req.userId as number;
    const id = Number(req.params.id);
    if (!Number.isFinite(id)) {
      res.status(400).json({ ok: false, error: "Bad id" });
      return;
    }
    const row: any = sqlite.prepare(
      `SELECT * FROM gift_certificates WHERE id = ?`,
    ).get(id);
    if (!row) {
      res.status(404).json({ ok: false, error: "Сертификат не найден" });
      return;
    }
    if (row.purchased_by_user_id !== userId) {
      res.status(403).json({ ok: false, error: "Только покупатель может отправить" });
      return;
    }
    if (row.status !== "active") {
      res.status(400).json({ ok: false, error: `Сертификат должен быть оплачен (status=active), сейчас: ${row.status}` });
      return;
    }

    const overrideEmail = String(req.body?.overrideRecipientEmail || "").trim() || null;
    const overridePhone = String(req.body?.overrideRecipientPhone || "").trim() || null;
    const requestedChannel = String(req.body?.channel || "auto");

    const targetEmail = overrideEmail || row.recipient_email;
    const targetPhone = overridePhone || row.recipient_phone;

    let channel: string;
    if (requestedChannel === "email" && targetEmail) channel = "email";
    else if (requestedChannel === "phone" && targetPhone) channel = "phone";
    else if (targetEmail) channel = "email";
    else if (targetPhone) channel = "phone";
    else {
      res.status(400).json({ ok: false, error: "Не указан email или телефон получателя" });
      return;
    }

    const nowMs = Date.now();
    sqlite.prepare(
      `UPDATE gift_certificates
       SET sent_at = ?, sent_channel = ?,
           recipient_email = COALESCE(?, recipient_email),
           recipient_phone = COALESCE(?, recipient_phone)
       WHERE id = ?`,
    ).run(nowMs, channel, overrideEmail, overridePhone, id);

    writeAudit(id, "sent", userId, "user", { channel, targetEmail, targetPhone });

    // Event для notifications plugin (если он подписан)
    if (bootRefs?.eventBus) {
      void bootRefs.eventBus.emit(
        "gift_certificate.sent",
        {
          certificateId: id,
          code: row.code,
          channel,
          targetEmail,
          targetPhone,
          purchasedByUserId: userId,
        },
        "gift-certificates",
      );
    }

    res.json({
      ok: true,
      channel,
      targetEmail: channel === "email" ? targetEmail : null,
      targetPhone: channel === "phone" ? targetPhone : null,
      message: `Получателю отправлено по ${channel === "email" ? "email" : "телефону"}. Откройте чтобы проверить.`,
    });
  } catch (e: any) {
    console.error("[gift-cert/send]", e);
    res.status(500).json({ ok: false, error: "Не удалось отправить" });
  }
});

/**
 * GET /api/gift-cert/audit/:id
 * Архив действий по сертификату (для покупателя/получателя).
 */
userRouter.get("/audit/:id", authMiddleware, (req: any, res: any) => {
  try {
    const userId = req.userId as number;
    const id = Number(req.params.id);
    if (!Number.isFinite(id)) {
      res.status(400).json({ ok: false, error: "Bad id" });
      return;
    }
    const row: any = sqlite.prepare(`SELECT * FROM gift_certificates WHERE id = ?`).get(id);
    if (!row) {
      res.status(404).json({ ok: false, error: "Сертификат не найден" });
      return;
    }
    const hasAccess = row.purchased_by_user_id === userId
      || row.redeemed_by_user_id === userId
      || row.recipient_user_id === userId;
    if (!hasAccess) {
      res.status(403).json({ ok: false, error: "Доступ запрещён" });
      return;
    }
    const entries = sqlite.prepare(
      `SELECT id, action, actor_user_id, actor_role, metadata_json, created_at
       FROM gift_certificate_audit
       WHERE certificate_id = ?
       ORDER BY id DESC LIMIT 100`,
    ).all(id);
    res.json({
      ok: true,
      certificate: buildCertRecord(row),
      audit: entries.map((e: any) => ({
        id: e.id,
        action: e.action,
        actorUserId: e.actor_user_id,
        actorRole: e.actor_role,
        metadata: safeJsonParse(e.metadata_json),
        createdAt: e.created_at,
      })),
    });
  } catch (e: any) {
    console.error("[gift-cert/audit]", e);
    res.status(500).json({ ok: false, error: "Не удалось загрузить аудит" });
  }
});

function safeJsonParse(s: any): any {
  if (!s) return null;
  try { return JSON.parse(String(s)); } catch { return null; }
}

// ─────────────────────────────────────────────────────────────────────
// ADMIN ENDPOINTS
// ─────────────────────────────────────────────────────────────────────

/**
 * POST /api/admin/v304/gift-cert/issue
 * Выдать сертификат вручную (admin gift). Без оплаты — сразу status='active'.
 *
 * Body: amountKopecks, creditType, creditValue?, recipientUserId?, recipientEmail?,
 *        postcardTemplate?, postcardMessage?, postcardTitle?, fromName?, expiresInDays?
 */
adminRouter.post("/gift-cert/issue", requireAdmin, (req: any, res: any) => {
  try {
    const adminUserId = req.userId as number;
    const adminEmail = (req.adminUser?.email as string) || null;
    const body = req.body || {};

    let amountKopecks = Number(body.amountKopecks);
    if (!Number.isFinite(amountKopecks) && body.amountRub) {
      amountKopecks = Math.round(Number(body.amountRub) * 100);
    }
    if (!Number.isFinite(amountKopecks) || amountKopecks < 0 || amountKopecks > MAX_AMOUNT_KOPECKS) {
      res.status(400).json({ ok: false, error: `Сумма от 0 до ${MAX_AMOUNT_KOPECKS / 100} ₽` });
      return;
    }
    amountKopecks = Math.floor(amountKopecks);

    const creditType = String(body.creditType || "balance");
    const validated = validateCreditValue(creditType, body.creditValue, amountKopecks);
    if (!validated.ok) {
      res.status(400).json({ ok: false, error: validated.error });
      return;
    }

    const recipientUserId = Number.isFinite(Number(body.recipientUserId)) ? Math.floor(Number(body.recipientUserId)) : null;
    const recipientEmail = String(body.recipientEmail || "").trim().slice(0, 200) || null;
    const recipientPhone = String(body.recipientPhone || "").trim().slice(0, 32) || null;

    const postcardTemplate: PostcardTemplate = POSTCARD_TEMPLATES.includes(body.postcardTemplate)
      ? body.postcardTemplate
      : "classic";
    const postcardMessage = String(body.postcardMessage || "").slice(0, 500);
    const postcardTitle = String(body.postcardTitle || "").slice(0, 100);
    const fromName = String(body.fromName || "Команда MuzaAi").slice(0, 80);

    const ttlDays = Number(body.expiresInDays) > 0 ? Math.floor(Number(body.expiresInDays)) : DEFAULT_TTL_DAYS;
    const nowMs = Date.now();
    const expiresAt = nowMs + ttlDays * 24 * 60 * 60 * 1000;

    const code = genUniqueCode();
    const insertResult = sqlite.prepare(
      `INSERT INTO gift_certificates
         (code, purchased_by_user_id, amount_kopecks, credit_type, credit_value_json,
          status, expires_at, paid_at, postcard_template, postcard_message,
          postcard_title, from_name, recipient_email, recipient_phone, recipient_user_id,
          created_at, created_by_admin)
       VALUES (?, NULL, ?, ?, ?, 'active', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)`,
    ).run(
      code,
      amountKopecks,
      creditType,
      JSON.stringify(validated.value),
      expiresAt,
      nowMs,
      postcardTemplate,
      postcardMessage || null,
      postcardTitle || null,
      fromName || null,
      recipientEmail,
      recipientPhone,
      recipientUserId,
      nowMs,
    );
    const certId = Number(insertResult.lastInsertRowid);
    writeAudit(certId, "created", adminUserId, "admin", {
      via: "admin_issue",
      amountKopecks,
      creditType,
      creditValue: validated.value,
      recipientUserId,
      recipientEmail,
    });
    // Admin global audit-log (CLAUDE.md → Backup-before-edit rule)
    recordAuditEntry({
      req,
      adminUserId,
      adminEmail,
      action: "create",
      entity: "gift_certificate",
      entityKey: String(certId),
      after: { code, amountKopecks, creditType, creditValue: validated.value, recipientUserId, recipientEmail },
    });

    res.json({
      ok: true,
      certificateId: certId,
      code,
      status: "active",
      message: `Сертификат ${code} выдан (валиден ${ttlDays} дн.).`,
    });
  } catch (e: any) {
    console.error("[admin gift-cert/issue]", e);
    res.status(500).json({ ok: false, error: "Не удалось создать сертификат" });
  }
});

/**
 * GET /api/admin/v304/gift-cert/list?status=&limit=&q=
 * List сертификатов с фильтрами.
 */
adminRouter.get("/gift-cert/list", requireAdmin, (req: any, res: any) => {
  try {
    const status = String(req.query.status || "").trim();
    const q = String(req.query.q || "").trim();
    const limit = Math.max(1, Math.min(500, Number(req.query.limit) || 100));

    const where: string[] = [];
    const args: any[] = [];
    if (status) { where.push("status = ?"); args.push(status); }
    if (q) {
      where.push("(code LIKE ? OR recipient_email LIKE ? OR from_name LIKE ?)");
      args.push(`%${q}%`, `%${q}%`, `%${q}%`);
    }
    const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";
    args.push(limit);
    const rows = sqlite.prepare(
      `SELECT * FROM gift_certificates ${whereSql} ORDER BY id DESC LIMIT ?`,
    ).all(...args);

    // Сводка по status
    const summary = sqlite.prepare(
      `SELECT status, COUNT(*) as count, SUM(amount_kopecks) as total
       FROM gift_certificates GROUP BY status`,
    ).all();

    res.json({
      ok: true,
      items: rows.map(buildCertRecord),
      summary,
      total: rows.length,
    });
  } catch (e: any) {
    console.error("[admin gift-cert/list]", e);
    res.status(500).json({ ok: false, error: "Не удалось загрузить список" });
  }
});

/**
 * GET /api/admin/v304/gift-cert/:id
 * Детали сертификата + audit-log entries.
 */
adminRouter.get("/gift-cert/:id", requireAdmin, (req: any, res: any) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isFinite(id)) {
      res.status(400).json({ ok: false, error: "Bad id" });
      return;
    }
    const row: any = sqlite.prepare(`SELECT * FROM gift_certificates WHERE id = ?`).get(id);
    if (!row) {
      res.status(404).json({ ok: false, error: "Сертификат не найден" });
      return;
    }
    const auditEntries = sqlite.prepare(
      `SELECT id, action, actor_user_id, actor_role, metadata_json, created_at
       FROM gift_certificate_audit WHERE certificate_id = ?
       ORDER BY id DESC LIMIT 200`,
    ).all(id);
    res.json({
      ok: true,
      certificate: buildCertRecord(row),
      audit: auditEntries.map((e: any) => ({
        id: e.id,
        action: e.action,
        actorUserId: e.actor_user_id,
        actorRole: e.actor_role,
        metadata: safeJsonParse(e.metadata_json),
        createdAt: e.created_at,
      })),
    });
  } catch (e: any) {
    console.error("[admin gift-cert/:id]", e);
    res.status(500).json({ ok: false, error: "Не удалось загрузить" });
  }
});

/**
 * POST /api/admin/v304/gift-cert/:id/revoke
 * Отозвать сертификат (status='cancelled'). Только если не redeemed.
 */
adminRouter.post("/gift-cert/:id/revoke", requireAdmin, (req: any, res: any) => {
  try {
    const adminUserId = req.userId as number;
    const adminEmail = (req.adminUser?.email as string) || null;
    const id = Number(req.params.id);
    if (!Number.isFinite(id)) {
      res.status(400).json({ ok: false, error: "Bad id" });
      return;
    }
    const row: any = sqlite.prepare(`SELECT * FROM gift_certificates WHERE id = ?`).get(id);
    if (!row) {
      res.status(404).json({ ok: false, error: "Сертификат не найден" });
      return;
    }
    if (row.status === "redeemed") {
      res.status(400).json({ ok: false, error: "Нельзя отозвать уже активированный сертификат" });
      return;
    }
    if (row.status === "cancelled" || row.status === "expired") {
      res.json({ ok: true, message: "Сертификат уже не активен", status: row.status });
      return;
    }
    const reason = String(req.body?.reason || "admin_revoke").slice(0, 200);
    const before = { status: row.status };
    sqlite.prepare(`UPDATE gift_certificates SET status='cancelled' WHERE id=?`).run(id);
    const after = { status: "cancelled", reason };
    writeAudit(id, "admin_revoke", adminUserId, "admin", { reason });
    recordAuditEntry({
      req,
      adminUserId,
      adminEmail,
      action: "update",
      entity: "gift_certificate",
      entityKey: String(id),
      before,
      after,
    });
    res.json({ ok: true, message: `Сертификат #${id} отозван`, status: "cancelled" });
  } catch (e: any) {
    console.error("[admin gift-cert/revoke]", e);
    res.status(500).json({ ok: false, error: "Не удалось отозвать" });
  }
});

/**
 * PUT /api/admin/v304/gift-cert/:id
 * Edit полей. Доступны: expiresAt, postcardMessage, postcardTitle, attachedTrackId,
 * recipientEmail, recipientPhone, fromName.
 */
adminRouter.put("/gift-cert/:id", requireAdmin, (req: any, res: any) => {
  try {
    const adminUserId = req.userId as number;
    const adminEmail = (req.adminUser?.email as string) || null;
    const id = Number(req.params.id);
    if (!Number.isFinite(id)) {
      res.status(400).json({ ok: false, error: "Bad id" });
      return;
    }
    const before: any = sqlite.prepare(`SELECT * FROM gift_certificates WHERE id = ?`).get(id);
    if (!before) {
      res.status(404).json({ ok: false, error: "Сертификат не найден" });
      return;
    }
    const body = req.body || {};
    const sets: string[] = [];
    const args: any[] = [];
    const after: Record<string, unknown> = {};

    if (body.expiresAt !== undefined) {
      const t = Number(body.expiresAt);
      if (Number.isFinite(t) && t > 0) {
        sets.push("expires_at = ?"); args.push(t); after.expiresAt = t;
      }
    }
    if (typeof body.postcardMessage === "string") {
      sets.push("postcard_message = ?"); args.push(body.postcardMessage.slice(0, 500));
      after.postcardMessage = body.postcardMessage.slice(0, 500);
    }
    if (typeof body.postcardTitle === "string") {
      sets.push("postcard_title = ?"); args.push(body.postcardTitle.slice(0, 100));
      after.postcardTitle = body.postcardTitle.slice(0, 100);
    }
    if (typeof body.postcardTemplate === "string" && POSTCARD_TEMPLATES.includes(body.postcardTemplate)) {
      sets.push("postcard_template = ?"); args.push(body.postcardTemplate);
      after.postcardTemplate = body.postcardTemplate;
    }
    if (typeof body.fromName === "string") {
      sets.push("from_name = ?"); args.push(body.fromName.slice(0, 80));
      after.fromName = body.fromName.slice(0, 80);
    }
    if (typeof body.recipientEmail === "string") {
      sets.push("recipient_email = ?"); args.push(body.recipientEmail.trim().slice(0, 200) || null);
      after.recipientEmail = body.recipientEmail.trim().slice(0, 200) || null;
    }
    if (typeof body.recipientPhone === "string") {
      sets.push("recipient_phone = ?"); args.push(body.recipientPhone.trim().slice(0, 32) || null);
      after.recipientPhone = body.recipientPhone.trim().slice(0, 32) || null;
    }
    if (body.attachedTrackId !== undefined) {
      const t = Number(body.attachedTrackId);
      sets.push("attached_track_id = ?"); args.push(Number.isFinite(t) ? Math.floor(t) : null);
      after.attachedTrackId = Number.isFinite(t) ? Math.floor(t) : null;
    }

    if (sets.length === 0) {
      res.status(400).json({ ok: false, error: "Нет полей для обновления" });
      return;
    }
    args.push(id);
    sqlite.prepare(`UPDATE gift_certificates SET ${sets.join(", ")} WHERE id = ?`).run(...args);
    writeAudit(id, "admin_edit", adminUserId, "admin", { before: buildCertRecord(before), after });
    recordAuditEntry({
      req,
      adminUserId,
      adminEmail,
      action: "update",
      entity: "gift_certificate",
      entityKey: String(id),
      before: buildCertRecord(before),
      after,
    });
    const updated: any = sqlite.prepare(`SELECT * FROM gift_certificates WHERE id = ?`).get(id);
    res.json({ ok: true, certificate: buildCertRecord(updated) });
  } catch (e: any) {
    console.error("[admin gift-cert PUT]", e);
    res.status(500).json({ ok: false, error: "Не удалось обновить" });
  }
});

/**
 * GET /api/admin/v304/gift-cert/audit-log
 * Глобальный архив действий (все сертификаты + filters).
 */
adminRouter.get("/gift-cert/audit-log", requireAdmin, (req: any, res: any) => {
  try {
    const action = String(req.query.action || "").trim();
    const certId = req.query.certId ? Number(req.query.certId) : null;
    const limit = Math.max(1, Math.min(500, Number(req.query.limit) || 200));
    const where: string[] = [];
    const args: any[] = [];
    if (action) { where.push("action = ?"); args.push(action); }
    if (certId && Number.isFinite(certId)) { where.push("certificate_id = ?"); args.push(certId); }
    const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";
    args.push(limit);
    const rows = sqlite.prepare(
      `SELECT id, certificate_id, action, actor_user_id, actor_role, metadata_json, created_at
       FROM gift_certificate_audit ${whereSql}
       ORDER BY id DESC LIMIT ?`,
    ).all(...args);
    res.json({
      ok: true,
      entries: rows.map((e: any) => ({
        id: e.id,
        certificateId: e.certificate_id,
        action: e.action,
        actorUserId: e.actor_user_id,
        actorRole: e.actor_role,
        metadata: safeJsonParse(e.metadata_json),
        createdAt: e.created_at,
      })),
      total: rows.length,
    });
  } catch (e: any) {
    console.error("[admin gift-cert/audit-log]", e);
    res.status(500).json({ ok: false, error: "Не удалось загрузить аудит" });
  }
});

// ─────────────────────────────────────────────────────────────────────
// Event subscriber — на payment.succeeded переводим pending → active
// (для сертификатов оплаченных через invoiceId pipeline)
// ─────────────────────────────────────────────────────────────────────

let bootRefs: { eventBus: BootContext["eventBus"]; logger: BootContext["logger"] } | null = null;

interface PaymentSucceededPayload {
  invId?: number;
  amount?: number;
  userId?: number;
}

async function onPaymentSucceeded(invId: number, eventLogger: BootContext["logger"]): Promise<void> {
  try {
    // Найти payment по invId, проверить если он привязан к invoice + invoice → gift_cert
    const payment: any = sqlite.prepare(
      `SELECT id, user_id, invoice_id, amount FROM payments WHERE inv_id = ?`,
    ).get(invId);
    if (!payment?.invoice_id) return;

    const cert: any = sqlite.prepare(
      `SELECT id, status, code FROM gift_certificates WHERE invoice_id = ?`,
    ).get(payment.invoice_id);
    if (!cert) return;
    if (cert.status === "active" || cert.status === "redeemed") return;

    const nowMs = Date.now();
    sqlite.prepare(
      `UPDATE gift_certificates
       SET status='active', paid_at=?, payment_id=?
       WHERE id = ? AND status = 'pending'`,
    ).run(nowMs, payment.id, cert.id);
    writeAudit(cert.id, "paid", payment.user_id, "system", { invId, paymentId: payment.id });
    eventLogger.info(`[gift-certificates] cert ${cert.code} activated by payment #${payment.id}`);
  } catch (e: any) {
    eventLogger.warn("[gift-certificates] onPaymentSucceeded failed", { error: e?.message || String(e) });
  }
}

// ─────────────────────────────────────────────────────────────────────
// Module export
// ─────────────────────────────────────────────────────────────────────

const giftCertificatesModule: Module = {
  name: "gift-certificates",
  version: "0.1.0",
  description:
    "Подарочные сертификаты MuzaAi — покупка, открытка, уникальный код+QR, " +
    "активация (баланс/треки/обложки/тексты), архив действий, admin governance.",
  migrations: [
    {
      version: "001_gift_certificates_init.sql",
      up: MIGRATION_SQL,
    },
  ],
  routes: { prefix: "gift-cert", router: userRouter },
  publishes: ["gift_certificate.created", "gift_certificate.paid", "gift_certificate.redeemed", "gift_certificate.sent"],
  subscribes: {
    "payment.succeeded": async (event, ctx) => {
      const payload = event.payload as PaymentSucceededPayload | null;
      if (!payload?.invId) return;
      await onPaymentSucceeded(Number(payload.invId), ctx as any);
    },
  },
  onLoad: async (ctx) => {
    bootRefs = { eventBus: ctx.eventBus, logger: ctx.logger };
    // Mount admin routes
    ctx.app.use("/api/admin/v304", adminRouter);
    ctx.logger.info(
      "gift-certificates online — user routes /api/gift-cert/*, admin routes /api/admin/v304/gift-cert/*",
    );
  },
  healthCheck: () => {
    try {
      const c = sqlite.prepare(`SELECT COUNT(*) as c FROM gift_certificates`).get() as { c: number };
      return { status: "ok", details: { certificates: c.c } };
    } catch (e: any) {
      return { status: "degraded", details: { error: e?.message || String(e) } };
    }
  },
};

export default giftCertificatesModule;
