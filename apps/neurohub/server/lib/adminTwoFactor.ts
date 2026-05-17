// Eugene 2026-05-17 Босс: Email 2FA для важных admin actions.
//
// Любое разрушительное действие admin'а (kick_session / delete_user /
// refund_payment / pause_bot / reload_kb / change_registration_status /
// query_users / send_telegram_alert / restart_pm2) проходит через 2 этапа:
//   1) initiate(action, args) → создаёт запись admin_pending_actions
//      + шлёт 6-значный код на admin email
//   2) confirm(actionId, code) → verify hash → status='confirmed' → caller
//      может выполнить action
//
// Plain code НИКОГДА не пишется в БД — только sha256 hash. Plain code
// существует только: (a) в email тексте, (b) в response initiate() ровно
// один раз для тестового SMS_OTP_DISABLE-mode.
//
// TTL 10 минут — после expires_at action нельзя подтвердить (status='expired').
// Max 5 попыток ввода кода — после status='failed'.
//
// Rate limit: 3 initiate / 1 час / admin (защита от спама почты).
//
// Spec: docs/strategy/ADMIN-SECURITY-AUDIT-170526.md.

import * as crypto from "node:crypto";
import { sql, eq, and, desc } from "drizzle-orm";
import { db } from "../storage";
import { adminPendingActions, type AdminPendingAction } from "@shared/schema";

export type ProtectedAction =
  | "change_registration_status"
  | "kick_session"
  | "query_users"
  | "send_telegram_alert"
  | "reload_kb"
  | "pause_bot"
  | "restart_pm2"
  | "delete_user"
  | "refund_payment";

export const PROTECTED_ACTIONS: ReadonlySet<ProtectedAction> = new Set<ProtectedAction>([
  "change_registration_status",
  "kick_session",
  "query_users",
  "send_telegram_alert",
  "reload_kb",
  "pause_bot",
  "restart_pm2",
  "delete_user",
  "refund_payment",
]);

export function isProtectedAction(name: string): name is ProtectedAction {
  return PROTECTED_ACTIONS.has(name as ProtectedAction);
}

const CODE_TTL_MS = 10 * 60_000;
const MAX_ATTEMPTS = 5;
const INITIATE_RATE_LIMIT = 3; // per admin
const INITIATE_RATE_WINDOW_MS = 60 * 60_000;

// === Code generation ===

function generateCode(): string {
  // 6-digit numeric. crypto.randomInt — uniform distribution.
  const n = crypto.randomInt(0, 1_000_000);
  return String(n).padStart(6, "0");
}

function hashCode(plain: string): string {
  return crypto.createHash("sha256").update(plain, "utf-8").digest("hex");
}

function genActionId(): string {
  return crypto.randomUUID();
}

// === Email sender (re-uses existing nodemailer transport via dynamic import to
// avoid circular dependency on server/routes.ts at module-load time) ===

export interface EmailContext {
  email: string;
  code: string;
  action: ProtectedAction;
  argsPreview: string;
}

export async function sendAdminConfirmEmail(ctx: EmailContext): Promise<void> {
  // Dynamic import to avoid circular dependency with server/routes.ts which
  // imports many things on module load.
  const nodemailer = await import("nodemailer");
  const GMAIL_USER = process.env.GMAIL_USER || "tissan2021@gmail.com";
  const GMAIL_APP_PASSWORD = process.env.GMAIL_APP_PASSWORD || "";

  if (!GMAIL_APP_PASSWORD) {
    console.warn("[adminTwoFactor] GMAIL_APP_PASSWORD не установлен — email-confirm недоступен");
    throw new Error("Email-канал не настроен (GMAIL_APP_PASSWORD missing)");
  }

  const transport = nodemailer.createTransport({
    service: "gmail",
    auth: { user: GMAIL_USER, pass: GMAIL_APP_PASSWORD },
  });

  const subject = `🔐 Код подтверждения admin-действия MuzaAi`;
  const actionRu = ACTION_LABEL_RU[ctx.action] || ctx.action;

  const html = `
    <div style="font-family: -apple-system, sans-serif; max-width: 520px; margin: 0 auto; padding: 32px; background: #09090b; border-radius: 16px; border: 1px solid #1a1a2e;">
      <div style="text-align: center; margin-bottom: 24px;">
        <span style="font-size: 24px; font-weight: 700; background: linear-gradient(135deg, #8b5cf6, #3b82f6); -webkit-background-clip: text; -webkit-text-fill-color: transparent;">MuzaAi · Admin</span>
      </div>
      <p style="color: #e2e2e2; font-size: 15px; line-height: 1.6; margin-bottom: 8px;">Запрошено admin-действие:</p>
      <p style="color: #fff; font-size: 16px; line-height: 1.6; margin: 8px 0 4px 0;"><strong>${escapeHtml(actionRu)}</strong></p>
      <p style="color: #888; font-size: 13px; line-height: 1.4; margin: 4px 0 16px 0; font-family: monospace;">${escapeHtml(ctx.argsPreview)}</p>
      <p style="color: #e2e2e2; font-size: 14px; line-height: 1.6;">Код подтверждения (действует 10 минут):</p>
      <div style="text-align: center; margin: 16px 0 24px 0;">
        <span style="display: inline-block; font-size: 36px; font-weight: 700; letter-spacing: 8px; color: #fff; background: linear-gradient(135deg, #8b5cf6, #3b82f6); padding: 16px 32px; border-radius: 12px; font-family: monospace;">${ctx.code}</span>
      </div>
      <div style="border-top: 1px solid #1a1a2e; padding-top: 16px; margin-top: 16px;">
        <p style="color: #f87171; font-size: 13px; line-height: 1.6; margin: 0 0 8px 0;"><strong>Если это не ты — НЕМЕДЛЕННО:</strong></p>
        <ol style="color: #d4d4d8; font-size: 13px; line-height: 1.7; padding-left: 20px; margin: 0;">
          <li>Смени пароль admin-аккаунта</li>
          <li>Проверь <code>admin_audit_log</code> — кто и когда заходил</li>
          <li>Включи SSH-only auth и rotate session secrets</li>
        </ol>
      </div>
    </div>`;

  const text = [
    `MuzaAi · Admin`,
    ``,
    `Запрошено admin-действие: ${actionRu}`,
    `Параметры: ${ctx.argsPreview}`,
    ``,
    `Код подтверждения: ${ctx.code}`,
    `(действует 10 минут)`,
    ``,
    `Если это не ты — НЕМЕДЛЕННО:`,
    `1. Смени пароль admin-аккаунта`,
    `2. Проверь admin_audit_log`,
    `3. Включи SSH-only auth и rotate session secrets`,
  ].join("\n");

  await transport.sendMail({
    from: `"MuzaAi Admin" <${GMAIL_USER}>`,
    to: ctx.email,
    subject,
    text,
    html,
  });
}

const ACTION_LABEL_RU: Record<ProtectedAction, string> = {
  change_registration_status: "Изменить статус регистрации",
  kick_session: "Удалить все сессии юзера (force logout)",
  query_users: "Поиск юзеров по PII (email/phone/name)",
  send_telegram_alert: "Отправить Telegram-сообщение админу",
  reload_kb: "Перезагрузить knowledge base бота",
  pause_bot: "Пауза/возобновление Telegram-бота",
  restart_pm2: "Перезапуск pm2-процесса (downtime)",
  delete_user: "Удалить юзера (hard-delete)",
  refund_payment: "Возврат платежа",
};

function escapeHtml(s: string): string {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

// === Rate limit for initiate (per admin) ===

export function checkInitiateRateLimit(adminUserId: number): { ok: boolean; recent: number } {
  const since = new Date(Date.now() - INITIATE_RATE_WINDOW_MS).toISOString();
  try {
    const rows = db
      .select({ id: adminPendingActions.id })
      .from(adminPendingActions)
      .where(
        and(
          eq(adminPendingActions.adminUserId, adminUserId),
          sql`${adminPendingActions.createdAt} >= ${since}`,
        ),
      )
      .all();
    const count = rows.length;
    return { ok: count < INITIATE_RATE_LIMIT, recent: count };
  } catch (e) {
    console.warn("[adminTwoFactor] rate limit query failed:", (e as Error).message);
    return { ok: true, recent: 0 };
  }
}

// === Initiate ===

export interface InitiateInput {
  adminUserId: number;
  adminEmail: string;
  action: ProtectedAction;
  args: unknown;
  ip?: string | null;
  userAgent?: string | null;
}

export interface InitiateResult {
  actionId: string;
  expiresAt: string;
  /** Plain code is returned ONLY when SMS_OTP_DISABLE=1 (тестовый режим
   *  без реальной отправки). В prod — undefined. */
  plainCodeIfDisabled?: string;
}

export async function initiateAction(input: InitiateInput): Promise<InitiateResult> {
  const rl = checkInitiateRateLimit(input.adminUserId);
  if (!rl.ok) {
    throw new Error(
      `Rate limit: ${INITIATE_RATE_LIMIT} initiate-запросов / час. Уже сделано ${rl.recent}. Подожди.`,
    );
  }
  const actionId = genActionId();
  const code = generateCode();
  const codeHash = hashCode(code);
  const now = new Date();
  const expiresAt = new Date(now.getTime() + CODE_TTL_MS).toISOString();
  const argsJson = JSON.stringify(input.args ?? {});

  db.insert(adminPendingActions)
    .values({
      id: actionId,
      adminUserId: input.adminUserId,
      adminEmail: input.adminEmail,
      action: input.action,
      argsJson,
      codeHash,
      attempts: 0,
      status: "pending",
      ip: input.ip ?? null,
      userAgent: (input.userAgent ?? "").slice(0, 500) || null,
      expiresAt,
    })
    .run();

  // Test mode — не шлём email, возвращаем код в response.
  if (process.env.ADMIN_2FA_DISABLE === "1") {
    console.warn(
      `[adminTwoFactor] TEST MODE — action=${input.action} actionId=${actionId} code=${code}`,
    );
    return { actionId, expiresAt, plainCodeIfDisabled: code };
  }

  // Plain code — только в email и in-memory. После return — недоступен нигде.
  try {
    await sendAdminConfirmEmail({
      email: input.adminEmail,
      code,
      action: input.action,
      argsPreview: previewArgs(input.args),
    });
  } catch (e) {
    // Если email не отправился — удаляем pending запись (нет смысла оставлять
    // код, который не доставлен).
    try {
      db.delete(adminPendingActions).where(eq(adminPendingActions.id, actionId)).run();
    } catch {}
    throw new Error(`Email не отправлен: ${(e as Error).message}`);
  }

  return { actionId, expiresAt };
}

function previewArgs(args: unknown): string {
  try {
    const s = JSON.stringify(args ?? {});
    if (s.length <= 200) return s;
    return s.slice(0, 197) + "...";
  } catch {
    return "{}";
  }
}

// === Confirm ===

export interface ConfirmResult {
  ok: true;
  pending: AdminPendingAction;
}

export interface ConfirmError {
  ok: false;
  error: string;
  remainingAttempts?: number;
}

export function confirmAction(
  actionId: string,
  code: string,
  adminUserId: number,
): ConfirmResult | ConfirmError {
  const pending = db
    .select()
    .from(adminPendingActions)
    .where(eq(adminPendingActions.id, actionId))
    .get();
  if (!pending) return { ok: false, error: "action not found" };
  if (pending.adminUserId !== adminUserId) {
    return { ok: false, error: "action принадлежит другому admin'у" };
  }
  if (pending.status === "used") {
    return { ok: false, error: "action уже выполнен" };
  }
  if (pending.status === "expired" || pending.status === "failed") {
    return { ok: false, error: `action недействителен (${pending.status})` };
  }
  const now = Date.now();
  const expiresMs = Date.parse(pending.expiresAt);
  if (now > expiresMs) {
    db.update(adminPendingActions)
      .set({ status: "expired" })
      .where(eq(adminPendingActions.id, actionId))
      .run();
    return { ok: false, error: "Код истёк (TTL 10 мин). Запроси новый." };
  }

  const givenHash = hashCode(String(code || "").trim());
  if (givenHash !== pending.codeHash) {
    const newAttempts = pending.attempts + 1;
    const remaining = MAX_ATTEMPTS - newAttempts;
    if (newAttempts >= MAX_ATTEMPTS) {
      db.update(adminPendingActions)
        .set({ status: "failed", attempts: newAttempts })
        .where(eq(adminPendingActions.id, actionId))
        .run();
      return { ok: false, error: "Превышено число попыток. Запроси новый код.", remainingAttempts: 0 };
    }
    db.update(adminPendingActions)
      .set({ attempts: newAttempts })
      .where(eq(adminPendingActions.id, actionId))
      .run();
    return { ok: false, error: "Неверный код", remainingAttempts: remaining };
  }

  // Verified.
  db.update(adminPendingActions)
    .set({ status: "confirmed", confirmedAt: new Date().toISOString() })
    .where(eq(adminPendingActions.id, actionId))
    .run();
  const updated = db
    .select()
    .from(adminPendingActions)
    .where(eq(adminPendingActions.id, actionId))
    .get();
  return { ok: true, pending: updated! };
}

// === Mark used ===
// Вызывается после успешного выполнения action handler'ом — фиксирует
// usedAt и сохраняет result.

export function markActionUsed(actionId: string, resultText: string): void {
  try {
    db.update(adminPendingActions)
      .set({
        status: "used",
        usedAt: new Date().toISOString(),
        resultText: String(resultText || "").slice(0, 2000),
      })
      .where(eq(adminPendingActions.id, actionId))
      .run();
  } catch (e) {
    console.warn("[adminTwoFactor] markActionUsed warn:", (e as Error).message);
  }
}

// === Lookup a confirmed pending action ===
// Используется муза-tool'ом при confirm-call (input.actionId) — проверяет
// что action именно confirmed, не used и не expired.

export function getConfirmedAction(
  actionId: string,
  adminUserId: number,
): AdminPendingAction | null {
  if (!actionId) return null;
  const p = db
    .select()
    .from(adminPendingActions)
    .where(eq(adminPendingActions.id, actionId))
    .get();
  if (!p) return null;
  if (p.adminUserId !== adminUserId) return null;
  if (p.status !== "confirmed") return null;
  const now = Date.now();
  const expiresMs = Date.parse(p.expiresAt);
  if (now > expiresMs) return null;
  return p;
}

// === Recent pending actions (для admin UI листинга) ===

export function listRecentPendingActions(adminUserId: number, limit = 20): AdminPendingAction[] {
  return db
    .select()
    .from(adminPendingActions)
    .where(eq(adminPendingActions.adminUserId, adminUserId))
    .orderBy(desc(adminPendingActions.createdAt))
    .limit(limit)
    .all();
}

// === Cleanup expired pending actions ===
// Можно дёргать из cron / admin-overview.

export function cleanupExpiredPendingActions(): number {
  const now = new Date().toISOString();
  try {
    const rows = db
      .select({ id: adminPendingActions.id })
      .from(adminPendingActions)
      .where(
        and(
          eq(adminPendingActions.status, "pending"),
          sql`${adminPendingActions.expiresAt} < ${now}`,
        ),
      )
      .all();
    if (rows.length === 0) return 0;
    db.update(adminPendingActions)
      .set({ status: "expired" })
      .where(
        and(
          eq(adminPendingActions.status, "pending"),
          sql`${adminPendingActions.expiresAt} < ${now}`,
        ),
      )
      .run();
    return rows.length;
  } catch {
    return 0;
  }
}

export const ADMIN_2FA_CONFIG = {
  CODE_TTL_MS,
  MAX_ATTEMPTS,
  INITIATE_RATE_LIMIT,
  INITIATE_RATE_WINDOW_MS,
};
