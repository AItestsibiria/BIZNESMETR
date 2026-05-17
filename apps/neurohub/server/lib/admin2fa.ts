// Eugene 2026-05-17 Босс: Level 1 защиты — 2FA при admin login.
// После успешной первичной аутентификации (email/password ИЛИ phone-call)
// проверяем role==='admin'/'super_admin' → если да, НЕ выдаём token сразу,
// а:
//   1. Генерируем 6-значный код (000000..999999).
//   2. Сохраняем sha256(code) в admin_login_codes + sessionDraftId (UUID).
//   3. Шлём email с кодом + контекст (IP, UA, время).
//   4. Возвращаем фронту { requireAdminCode: true, sessionDraftId }.
//
// Фронт показывает ввод 6 цифр → POST /api/auth/admin-verify-code с
// { sessionDraftId, code } → backend:
//   - находит запись по sessionDraftId, проверяет status='pending', not expired
//   - до 3 попыток, attempts++; если 3 — статус 'expired', алерт в TG
//   - sha256(code) сравнивается с code_hash
//   - если совпало → status='used', выдаём session token через tokenStore
//
// Bypass: ADMIN_2FA_BYPASS=1 → возвращаем requireAdminCode:false сразу
// (для emergency если SMTP сломан).
//
// Также: trusted IP (adminTrustedIp.ts) → 2FA пропускается тихо.

import crypto from "node:crypto";
import { v4 as uuidv4 } from "uuid";
import { db } from "../storage";
import { adminLoginCodes, type AdminLoginCode } from "@shared/schema";
import { eq, and, sql, lt } from "drizzle-orm";
import type { Request } from "express";
import type { Transporter } from "nodemailer";
import { isAdminTrustedIp } from "./adminTrustedIp";

const CODE_TTL_MS = 10 * 60 * 1000;
const MAX_ATTEMPTS = 3;

// Eugene 2026-05-17 Босс: «alert при подозрении» — failed attempts, новый
// IP, нестандартное время.
const NIGHT_HOUR_START = 3;   // 03:00 MSK
const NIGHT_HOUR_END = 6;     // 06:00 MSK (exclusive)

export function isAdminRole(role: string | null | undefined): boolean {
  return role === "admin" || role === "super_admin";
}

export function is2FABypassed(): boolean {
  return process.env.ADMIN_2FA_BYPASS === "1";
}

export function shouldRequireAdmin2FA(role: string | null | undefined, req: Request): boolean {
  if (!isAdminRole(role)) return false;
  if (is2FABypassed()) return false;
  // Trusted IP skip: админ заходит с офисного / домашнего whitelisted IP →
  // 2FA не нужен. Если ADMIN_TRUSTED_IPS не задан в env — всегда требуем.
  if (isAdminTrustedIp(req)) return false;
  return true;
}

function hashCode(plain: string): string {
  return crypto.createHash("sha256").update(String(plain)).digest("hex");
}

function genCode(): string {
  // 6-digit, leading zeros допустимы. random_int — криптографически стойкий.
  const n = crypto.randomInt(0, 1_000_000);
  return String(n).padStart(6, "0");
}

function clientIp(req: Request): string {
  const xff = req.headers["x-forwarded-for"];
  const raw = typeof xff === "string" ? xff.split(",")[0] : (req.ip || req.socket.remoteAddress || "");
  return String(raw || "").trim().slice(0, 64);
}

function clientUa(req: Request): string {
  return String(req.headers["user-agent"] || "").slice(0, 256);
}

// === Public API ===

export interface CreateAdmin2FAOpts {
  userId: number;
  channel: "email_password" | "phone_call" | "phone_reverse_call";
  req: Request;
}

export interface Admin2FACreatedRow {
  sessionDraftId: string;
  code: string;        // plain — для отправки email, никогда не логируем
  expiresAt: string;
  ip: string;
  ua: string;
}

export function createAdmin2FACode(opts: CreateAdmin2FAOpts): Admin2FACreatedRow {
  const sessionDraftId = uuidv4();
  const code = genCode();
  const codeHash = hashCode(code);
  const now = Date.now();
  const expiresAt = new Date(now + CODE_TTL_MS).toISOString();
  const createdAt = new Date(now).toISOString();
  const ip = clientIp(opts.req);
  const ua = clientUa(opts.req);

  db.insert(adminLoginCodes).values({
    userId: opts.userId,
    codeHash,
    ip,
    userAgent: ua,
    expiresAt,
    attempts: 0,
    status: "pending",
    sessionDraftId,
    channel: opts.channel,
    createdAt,
  }).run();

  return { sessionDraftId, code, expiresAt, ip, ua };
}

export interface VerifyAdmin2FAResult {
  ok: boolean;
  userId?: number;
  errorCode?: "not_found" | "expired" | "max_attempts" | "wrong_code" | "already_used";
  errorMessage?: string;
  attemptsLeft?: number;
  // Для алертов: после 3 failed attempts флаг exhausted=true → caller
  // отправляет TG-alert.
  exhausted?: boolean;
}

export function verifyAdmin2FACode(sessionDraftId: string, code: string): VerifyAdmin2FAResult {
  if (!sessionDraftId || typeof sessionDraftId !== "string") {
    return { ok: false, errorCode: "not_found", errorMessage: "Сессия не найдена" };
  }
  if (!code || typeof code !== "string" || !/^\d{6}$/.test(code)) {
    return { ok: false, errorCode: "wrong_code", errorMessage: "Введите 6 цифр" };
  }
  const row = db.select().from(adminLoginCodes)
    .where(eq(adminLoginCodes.sessionDraftId, sessionDraftId))
    .get() as AdminLoginCode | undefined;
  if (!row) {
    return { ok: false, errorCode: "not_found", errorMessage: "Сессия не найдена — войдите заново" };
  }
  if (row.status === "used") {
    return { ok: false, errorCode: "already_used", errorMessage: "Код уже использован" };
  }
  if (row.status === "expired") {
    return { ok: false, errorCode: "expired", errorMessage: "Срок действия кода истёк" };
  }
  if (new Date(row.expiresAt).getTime() < Date.now()) {
    try {
      db.update(adminLoginCodes).set({ status: "expired" }).where(eq(adminLoginCodes.id, row.id)).run();
    } catch {}
    return { ok: false, errorCode: "expired", errorMessage: "Срок действия кода истёк (10 мин)" };
  }
  if (row.attempts >= MAX_ATTEMPTS) {
    try {
      db.update(adminLoginCodes).set({ status: "expired" }).where(eq(adminLoginCodes.id, row.id)).run();
    } catch {}
    return {
      ok: false,
      errorCode: "max_attempts",
      errorMessage: "Превышено количество попыток — войдите заново",
      exhausted: true,
    };
  }

  const expected = row.codeHash;
  const got = hashCode(code);
  if (expected !== got) {
    const newAttempts = row.attempts + 1;
    try {
      db.update(adminLoginCodes)
        .set({ attempts: newAttempts, status: newAttempts >= MAX_ATTEMPTS ? "expired" : "pending" })
        .where(eq(adminLoginCodes.id, row.id))
        .run();
    } catch {}
    return {
      ok: false,
      errorCode: "wrong_code",
      errorMessage: newAttempts >= MAX_ATTEMPTS
        ? "Неверный код. Попытки исчерпаны — войдите заново."
        : "Неверный код. Попыток осталось: " + (MAX_ATTEMPTS - newAttempts),
      attemptsLeft: Math.max(0, MAX_ATTEMPTS - newAttempts),
      exhausted: newAttempts >= MAX_ATTEMPTS,
    };
  }

  try {
    db.update(adminLoginCodes).set({ status: "used" }).where(eq(adminLoginCodes.id, row.id)).run();
  } catch {}
  return { ok: true, userId: row.userId };
}

// Cleanup expired codes (cron hourly).
export function cleanupExpiredAdminCodes(): { deleted: number; markedExpired: number } {
  let markedExpired = 0;
  let deleted = 0;
  const now = new Date().toISOString();
  try {
    const res1 = db.update(adminLoginCodes)
      .set({ status: "expired" })
      .where(and(eq(adminLoginCodes.status, "pending"), lt(adminLoginCodes.expiresAt, now)))
      .run();
    markedExpired = (res1 as any)?.changes ?? 0;
  } catch {}
  try {
    // Старше 7 дней — физически удаляем (audit-trail остаётся в admin_audit_log
    // если caller туда писал, тут табличка лёгкая, не нужна longterm-retention).
    const cutoff = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
    const res2 = db.run(sql`DELETE FROM admin_login_codes WHERE expires_at < ${cutoff}`);
    deleted = (res2 as any)?.changes ?? 0;
  } catch {}
  return { deleted, markedExpired };
}

let cleanupTimer: NodeJS.Timeout | null = null;
export function startAdmin2FACleanupCron(): void {
  if (cleanupTimer) return;
  // Каждый час.
  cleanupTimer = setInterval(() => {
    try {
      cleanupExpiredAdminCodes();
    } catch (e) {
      try { console.warn("[admin-2fa] cleanup failed", String((e as any)?.message || e)); } catch {}
    }
  }, 60 * 60 * 1000);
  // Сразу прогон при старте — чисто на случай если процесс рестартовал
  // в момент когда были pending-коды.
  try { cleanupExpiredAdminCodes(); } catch {}
}

// === Email helpers ===

export function buildAdmin2FAEmail(opts: {
  adminName: string | null;
  code: string;
  ip: string;
  ua: string;
}): { subject: string; text: string; html: string } {
  const subject = "🔐 Код входа в admin MuzaAi";
  const nameLine = opts.adminName ? `, ${opts.adminName}` : "";
  const ts = new Date().toLocaleString("ru-RU", { timeZone: "Europe/Moscow" }) + " MSK";
  const text =
    `Привет${nameLine}!\n\n` +
    `Кто-то вошёл в admin panel MuzaAi:\n` +
    `- IP: ${opts.ip || "?"}\n` +
    `- Браузер: ${opts.ua || "?"}\n` +
    `- Время: ${ts}\n\n` +
    `Код входа: ${opts.code} (действителен 10 мин)\n\n` +
    `Если это не ты — НЕМЕДЛЕННО:\n` +
    `1. Не вводи код\n` +
    `2. Смени пароль на console.anthropic.com / muzaai.ru\n` +
    `3. Свяжись с Eugene\n`;
  const safeUa = opts.ua.replace(/[<>]/g, "");
  const safeIp = opts.ip.replace(/[<>]/g, "");
  const html = `
    <div style="font-family: -apple-system, sans-serif; max-width: 480px; margin: 0 auto; padding: 32px; background: #09090b; border-radius: 16px; border: 1px solid #1a1a2e;">
      <div style="text-align: center; margin-bottom: 24px;">
        <span style="font-size: 24px; font-weight: 700; background: linear-gradient(135deg, #8b5cf6, #3b82f6); -webkit-background-clip: text; -webkit-text-fill-color: transparent;">🔐 MuzaAi — Admin 2FA</span>
      </div>
      <p style="color: #e2e2e2; font-size: 15px; line-height: 1.6;">Привет${nameLine}!</p>
      <p style="color: #e2e2e2; font-size: 14px; line-height: 1.6;">Кто-то вошёл в admin panel MuzaAi:</p>
      <ul style="color: #a1a1aa; font-size: 13px; line-height: 1.8; padding-left: 18px;">
        <li>IP: <code style="color: #fbbf24;">${safeIp || "?"}</code></li>
        <li>Браузер: <code style="color: #fbbf24;">${safeUa || "?"}</code></li>
        <li>Время: <code style="color: #fbbf24;">${ts}</code></li>
      </ul>
      <div style="text-align: center; margin: 28px 0;">
        <span style="display: inline-block; font-size: 36px; font-weight: 700; letter-spacing: 8px; color: #fff; background: linear-gradient(135deg, #8b5cf6, #3b82f6); padding: 16px 32px; border-radius: 12px;">${opts.code}</span>
      </div>
      <p style="color: #888; font-size: 13px; text-align: center;">Код действителен 10 минут</p>
      <hr style="border: none; border-top: 1px solid #1a1a2e; margin: 24px 0;">
      <p style="color: #ef4444; font-size: 13px; font-weight: 600;">Если это не ты — НЕМЕДЛЕННО:</p>
      <ol style="color: #fca5a5; font-size: 13px; line-height: 1.8; padding-left: 20px;">
        <li>Не вводи код</li>
        <li>Смени пароль на muzaai.ru</li>
        <li>Свяжись с Eugene</li>
      </ol>
    </div>
  `;
  return { subject, text, html };
}

export interface SendAdmin2FAEmailDeps {
  mailTransport: Transporter;
  fromAddress: string;
  fromLabel?: string;
}

export async function sendAdmin2FAEmail(
  deps: SendAdmin2FAEmailDeps,
  toEmail: string,
  payload: { adminName: string | null; code: string; ip: string; ua: string },
): Promise<{ ok: boolean; error?: string }> {
  try {
    const { subject, text, html } = buildAdmin2FAEmail(payload);
    await deps.mailTransport.sendMail({
      from: `"${deps.fromLabel || "MuzaAi Admin"}" <${deps.fromAddress}>`,
      replyTo: deps.fromAddress,
      to: toEmail,
      subject,
      text,
      html,
    });
    return { ok: true };
  } catch (e: any) {
    return { ok: false, error: String(e?.message || e).slice(0, 240) };
  }
}

// === Self-contained admin gate for plugins (auth-sms, future channels) ===
//
// Любой плагин который выдаёт session token может перед выдачей сделать:
//
//   const gate = await adminGateBeforeToken(userId, channel, req);
//   if (gate.requireAdminCode) return res.json({ requireAdminCode: true, sessionDraftId: gate.sessionDraftId, emailHint, expiresInSec: 600 });
//   // иначе — выдаём token как обычно
//
// Это делает 2FA-логику переиспользуемой без impose тонкой связи с routes.ts.
// Lazy import nodemailer чтобы не утяжелять bundle если плагин не используется.

let cachedTransport: Transporter | null = null;
async function getOrCreateMailer(): Promise<{ transport: Transporter; from: string } | null> {
  if (cachedTransport) {
    return { transport: cachedTransport, from: process.env.GMAIL_USER || "tissan2021@gmail.com" };
  }
  try {
    const nodemailer = (await import("nodemailer")).default;
    const user = process.env.GMAIL_USER || "tissan2021@gmail.com";
    const pass = process.env.GMAIL_APP_PASSWORD || "";
    if (!pass) return null;
    cachedTransport = nodemailer.createTransport({
      service: "gmail",
      auth: { user, pass },
    });
    return { transport: cachedTransport, from: user };
  } catch {
    return null;
  }
}

export interface AdminGateResult {
  requireAdminCode: boolean;
  sessionDraftId?: string;
  emailHint?: string;
  expiresInSec?: number;
  warning?: string;
}

interface AdminGateInput {
  userId: number;
  channel: "email_password" | "phone_call" | "phone_reverse_call";
  req: Request;
  adminEmail: string;
  adminName: string | null;
  adminRole: string | null | undefined;
}

export async function adminGateBeforeToken(input: AdminGateInput): Promise<AdminGateResult> {
  if (!shouldRequireAdmin2FA(input.adminRole, input.req)) {
    return { requireAdminCode: false };
  }
  const created = createAdmin2FACode({
    userId: input.userId,
    channel: input.channel,
    req: input.req,
  });
  // Off-hours / new IP alerts.
  if (isOffHoursMsk()) {
    sendAdmin2FAAlert({
      reason: "off_hours",
      userId: input.userId,
      email: input.adminEmail,
      ip: created.ip,
      ua: created.ua,
    });
  }
  if (!hasSeenAdminIp(input.userId, created.ip)) {
    sendAdmin2FAAlert({
      reason: "new_ip",
      userId: input.userId,
      email: input.adminEmail,
      ip: created.ip,
      ua: created.ua,
      detail: `Login channel=${input.channel} с нового IP.`,
    });
  }
  // Email.
  const mailer = await getOrCreateMailer();
  let emailSent = false;
  let warning: string | undefined;
  if (mailer) {
    const r = await sendAdmin2FAEmail(
      { mailTransport: mailer.transport, fromAddress: mailer.from, fromLabel: "MuzaAi Admin" },
      input.adminEmail,
      { adminName: input.adminName, code: created.code, ip: created.ip, ua: created.ua },
    );
    emailSent = r.ok;
    if (!r.ok) warning = "Email не отправлен. Свяжись с Eugene.";
  } else {
    warning = "SMTP не сконфигурирован. Используй ADMIN_2FA_BYPASS=1 для emergency.";
  }
  const emailHint = input.adminEmail.replace(/(.{2}).*(@.*)/, "$1***$2");
  return {
    requireAdminCode: true,
    sessionDraftId: created.sessionDraftId,
    emailHint,
    expiresInSec: 600,
    warning: emailSent ? undefined : warning,
  };
}

// === Telegram alert ===

export interface SendAdmin2FAAlertOpts {
  reason: "failed_attempts" | "new_ip" | "off_hours" | "code_exhausted";
  userId: number;
  email?: string | null;
  ip: string;
  ua: string;
  detail?: string;
}

const lastAlertAt = new Map<string, number>();
const ALERT_COOLDOWN_MS = 5 * 60 * 1000;

export function sendAdmin2FAAlert(opts: SendAdmin2FAAlertOpts): void {
  try {
    const token = process.env.TELEGRAM_BOT_TOKEN;
    const adminId = process.env.ADMIN_TELEGRAM_ID;
    if (!token || !adminId) return;
    const key = `${opts.userId}:${opts.reason}`;
    const now = Date.now();
    const last = lastAlertAt.get(key) || 0;
    if (now - last < ALERT_COOLDOWN_MS) return;
    lastAlertAt.set(key, now);

    const titles: Record<SendAdmin2FAAlertOpts["reason"], string> = {
      failed_attempts: "🚨 Admin 2FA — неверный код",
      new_ip: "🚨 Admin login — новый IP",
      off_hours: "🌙 Admin login — нерабочее время",
      code_exhausted: "🚨 Admin 2FA — попытки исчерпаны",
    };
    const lines = [
      titles[opts.reason],
      "",
      `User: #${opts.userId}` + (opts.email ? ` (${opts.email})` : ""),
      `IP: ${opts.ip || "?"}`,
      `UA: ${opts.ua.slice(0, 120) || "?"}`,
      `Время: ${new Date().toLocaleString("ru-RU", { timeZone: "Europe/Moscow" })} MSK`,
    ];
    if (opts.detail) lines.push("", opts.detail.slice(0, 200));

    fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: adminId,
        text: lines.join("\n"),
        disable_web_page_preview: true,
      }),
    }).catch((e) => {
      try { console.warn("[admin-2fa-alert]", String(e?.message || e)); } catch {}
    });
  } catch (e) {
    try { console.warn("[admin-2fa-alert] failed", String((e as any)?.message || e)); } catch {}
  }
}

// Hours-based detection: 03:00..06:00 MSK = подозрительно.
export function isOffHoursMsk(d: Date = new Date()): boolean {
  // MSK = UTC+3, без DST.
  const hMsk = (d.getUTCHours() + 3) % 24;
  return hMsk >= NIGHT_HOUR_START && hMsk < NIGHT_HOUR_END;
}

// Хранилище «уже видели IP у этого админа» для new_ip алертов.
// In-memory + lazy DB-lookup по admin_login_codes (последние 30 дней — IP откуда был успешный login).
const seenIpCache = new Map<number, Set<string>>();
export function hasSeenAdminIp(userId: number, ip: string): boolean {
  if (!ip) return true;
  const cached = seenIpCache.get(userId);
  if (cached?.has(ip)) return true;
  try {
    const cutoff = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
    const rows = db.all<{ ip: string }>(
      sql`SELECT DISTINCT ip FROM admin_login_codes WHERE user_id = ${userId} AND status = 'used' AND created_at > ${cutoff} AND ip IS NOT NULL`
    );
    const set = new Set<string>(rows.map(r => r.ip).filter(Boolean));
    seenIpCache.set(userId, set);
    return set.has(ip);
  } catch {
    return false;
  }
}

export function rememberAdminIp(userId: number, ip: string): void {
  if (!ip) return;
  const cached = seenIpCache.get(userId) ?? new Set<string>();
  cached.add(ip);
  seenIpCache.set(userId, cached);
}
