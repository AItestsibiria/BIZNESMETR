// Eugene 2026-05-20: Unified email sender для transactional + admin alerts.
// Использует nodemailer с conditional config:
//   - Gmail (через GMAIL_APP_PASSWORD) — простой, app-password from myaccount.google.com
//   - Custom SMTP (через SMTP_HOST, SMTP_USER, SMTP_PASS) — Yandex Mail / Mail.ru / etc
//   - Fallback: console.warn если ничего не настроено (dev-mode без отправки)
//
// Все вызовы через sendEmail() — единая точка. Возвращает {ok, error?, messageId?}.

let _nodemailer: any = null;
function getNodemailer(): any {
  if (_nodemailer) return _nodemailer;
  try {
    _nodemailer = require("nodemailer");
  } catch {
    return null;
  }
  return _nodemailer;
}

export type EmailKind = "transactional" | "alert" | "promo" | "muza-reply";

export interface SendEmailOpts {
  to: string;
  subject: string;
  text?: string;
  html?: string;
  replyTo?: string;
  kind?: EmailKind;
  // Опционально — переопределить from (по умолчанию SMTP_FROM или GMAIL_FROM)
  from?: string;
}

export interface SendEmailResult {
  ok: boolean;
  error?: string;
  messageId?: string;
  provider?: "gmail" | "custom-smtp" | "console-noop";
}

function getDefaultFrom(): string {
  return process.env.SMTP_FROM
    || process.env.GMAIL_FROM
    || (process.env.GMAIL_APP_PASSWORD ? `Музa <noreply@muzaai.ru>` : "noreply@muzaai.ru");
}

function buildGmailTransporter(): any {
  const nm = getNodemailer();
  if (!nm) return null;
  const user = process.env.GMAIL_USER || "hello@muzaai.ru";
  const pass = process.env.GMAIL_APP_PASSWORD;
  if (!pass) return null;
  return nm.createTransport({
    service: "gmail",
    auth: { user, pass },
  });
}

function buildCustomSmtpTransporter(): any {
  const nm = getNodemailer();
  if (!nm) return null;
  const host = process.env.SMTP_HOST;
  const port = parseInt(process.env.SMTP_PORT || "465", 10);
  const user = process.env.SMTP_USER;
  const pass = process.env.SMTP_PASS;
  if (!host || !user || !pass) return null;
  return nm.createTransport({
    host,
    port,
    secure: port === 465, // SSL для 465, STARTTLS для 587
    auth: { user, pass },
  });
}

/**
 * Главный entry point — отправить email через любой настроенный провайдер.
 * Приоритет: Custom SMTP > Gmail > console-noop.
 */
export async function sendEmail(opts: SendEmailOpts): Promise<SendEmailResult> {
  const to = (opts.to || "").trim();
  if (!to || !to.includes("@")) {
    return { ok: false, error: "invalid to email" };
  }
  const subject = (opts.subject || "").trim();
  if (!subject) {
    return { ok: false, error: "empty subject" };
  }
  const from = opts.from || getDefaultFrom();
  const text = opts.text || "";
  const html = opts.html;
  if (!text && !html) {
    return { ok: false, error: "empty body" };
  }

  // 1. Custom SMTP (приоритет — для prod корпоративный email)
  const customSmtp = buildCustomSmtpTransporter();
  if (customSmtp) {
    try {
      const info = await customSmtp.sendMail({
        from,
        to,
        subject,
        text,
        html,
        replyTo: opts.replyTo,
      });
      return { ok: true, messageId: info?.messageId, provider: "custom-smtp" };
    } catch (e: any) {
      console.warn("[email] custom-smtp send failed:", e?.message || e);
      // Fallback на Gmail если есть
    }
  }

  // 2. Gmail (через app password)
  const gmail = buildGmailTransporter();
  if (gmail) {
    try {
      const info = await gmail.sendMail({
        from,
        to,
        subject,
        text,
        html,
        replyTo: opts.replyTo,
      });
      return { ok: true, messageId: info?.messageId, provider: "gmail" };
    } catch (e: any) {
      console.warn("[email] gmail send failed:", e?.message || e);
    }
  }

  // 3. Console-noop (dev режим, ничего не настроено)
  console.warn(`[email] no transport configured — skipping ${opts.kind || "?"} email to ${to.slice(0, 30)}*** subject="${subject.slice(0, 50)}"`);
  return { ok: false, error: "no email transport configured", provider: "console-noop" };
}

/**
 * Проверка какие провайдеры настроены (для admin status).
 * Не отправляет email, только проверяет ENV.
 */
export function getEmailStatus(): {
  customSmtp: { configured: boolean; host?: string; port?: number; user_first?: string };
  gmail: { configured: boolean; user?: string; passLength?: number };
  effectiveProvider: "custom-smtp" | "gmail" | "none";
} {
  const host = process.env.SMTP_HOST || "";
  const port = parseInt(process.env.SMTP_PORT || "465", 10);
  const user = process.env.SMTP_USER || "";
  const pass = process.env.SMTP_PASS || "";
  const gmailUser = process.env.GMAIL_USER || "hello@muzaai.ru";
  const gmailPass = process.env.GMAIL_APP_PASSWORD || "";

  const customConfigured = !!(host && user && pass);
  const gmailConfigured = !!gmailPass;

  return {
    customSmtp: {
      configured: customConfigured,
      host: customConfigured ? host : undefined,
      port: customConfigured ? port : undefined,
      user_first: customConfigured ? user.slice(0, 8) + "***" : undefined,
    },
    gmail: {
      configured: gmailConfigured,
      user: gmailConfigured ? gmailUser : undefined,
      passLength: gmailPass.length,
    },
    effectiveProvider: customConfigured ? "custom-smtp" : gmailConfigured ? "gmail" : "none",
  };
}

// === Шаблоны для типовых transactional emails ===

export interface BrandConfig {
  brandName: string;
  brandUrl: string;
  supportEmail: string;
}

export function brandConfig(): BrandConfig {
  return {
    brandName: process.env.BRAND_NAME || "MuzaAi",
    brandUrl: process.env.PUBLIC_BASE_URL || "https://muzaai.ru",
    supportEmail: process.env.SUPPORT_EMAIL || "hello@muzaai.ru",
  };
}

function wrapBrandHtml(bodyHtml: string): string {
  const b = brandConfig();
  return `<!DOCTYPE html><html><body style="font-family:Arial,sans-serif;background:#0a0a17;color:#fff;padding:24px;">
<div style="max-width:560px;margin:0 auto;background:#1a0f2e;border:1px solid rgba(168,85,247,0.3);border-radius:16px;padding:24px;">
  <div style="text-align:center;font-size:24px;font-weight:bold;margin-bottom:16px;">
    <span style="background:linear-gradient(90deg,#a855f7,#3b82f6);-webkit-background-clip:text;background-clip:text;color:transparent;">${b.brandName}</span>
  </div>
  ${bodyHtml}
  <hr style="border-color:rgba(168,85,247,0.2);margin:24px 0;" />
  <div style="font-size:12px;color:#888;text-align:center;">
    Музa · <a href="${b.brandUrl}" style="color:#a855f7;">${b.brandUrl}</a> ·
    <a href="mailto:${b.supportEmail}" style="color:#a855f7;">${b.supportEmail}</a>
  </div>
</div>
</body></html>`;
}

/**
 * Welcome email после регистрации.
 */
export async function sendWelcomeEmail(opts: {
  to: string;
  userName?: string;
}): Promise<SendEmailResult> {
  const b = brandConfig();
  const name = opts.userName || "друг";
  return sendEmail({
    to: opts.to,
    subject: `Добро пожаловать в ${b.brandName}, ${name}! 🎵`,
    text: `Привет, ${name}!

Я — Музa, твой ИИ-помощник в ${b.brandName}. Рада знакомству!

Зайди в кабинет: ${b.brandUrl}/dashboard
Создай первый трек: ${b.brandUrl}/music

Если что-то нужно — пиши мне в чат на сайте или сюда (отвечу).

— Музa, ${b.brandName}`,
    html: wrapBrandHtml(`
      <h1 style="color:#fff;font-size:20px;">Привет, ${name}!</h1>
      <p>Я — <strong>Музa</strong>, твой ИИ-помощник в ${b.brandName}. Рада знакомству!</p>
      <ul>
        <li><a href="${b.brandUrl}/dashboard" style="color:#a855f7;">Зайти в кабинет</a></li>
        <li><a href="${b.brandUrl}/music" style="color:#a855f7;">Создать первый трек</a></li>
      </ul>
      <p style="color:#aaa;">Если что-то нужно — пиши мне в чат на сайте или сюда (отвечу).</p>
      <p>— Музa</p>
    `),
    kind: "transactional",
  });
}

/**
 * Email confirmation (для подтверждения регистрации).
 */
export async function sendEmailConfirmation(opts: {
  to: string;
  token: string;
  userName?: string;
}): Promise<SendEmailResult> {
  const b = brandConfig();
  const confirmUrl = `${b.brandUrl}/#/confirm-email?token=${encodeURIComponent(opts.token)}`;
  return sendEmail({
    to: opts.to,
    subject: `Подтверди свой email в ${b.brandName}`,
    text: `Чтобы подтвердить email, открой ссылку:\n${confirmUrl}\n\nЕсли это не ты — проигнорируй.`,
    html: wrapBrandHtml(`
      <h1 style="color:#fff;font-size:20px;">Подтверди свой email</h1>
      <p>Нажми кнопку чтобы подтвердить:</p>
      <p><a href="${confirmUrl}" style="display:inline-block;background:linear-gradient(90deg,#a855f7,#3b82f6);color:#fff;padding:12px 24px;border-radius:8px;text-decoration:none;font-weight:bold;">Подтвердить email</a></p>
      <p style="color:#aaa;font-size:12px;">Или скопируй ссылку: <a href="${confirmUrl}" style="color:#a855f7;word-break:break-all;">${confirmUrl}</a></p>
      <p style="color:#aaa;font-size:12px;">Если это не ты — проигнорируй письмо.</p>
    `),
    kind: "transactional",
  });
}

/**
 * Password reset email.
 */
export async function sendPasswordResetEmail(opts: {
  to: string;
  token: string;
}): Promise<SendEmailResult> {
  const b = brandConfig();
  const resetUrl = `${b.brandUrl}/#/reset-password?token=${encodeURIComponent(opts.token)}`;
  return sendEmail({
    to: opts.to,
    subject: `Восстановление пароля в ${b.brandName}`,
    text: `Чтобы задать новый пароль, открой ссылку:\n${resetUrl}\n\nСсылка действительна 1 час.\nЕсли это не ты — проигнорируй.`,
    html: wrapBrandHtml(`
      <h1 style="color:#fff;font-size:20px;">Восстановление пароля</h1>
      <p>Нажми кнопку чтобы задать новый пароль:</p>
      <p><a href="${resetUrl}" style="display:inline-block;background:linear-gradient(90deg,#a855f7,#3b82f6);color:#fff;padding:12px 24px;border-radius:8px;text-decoration:none;font-weight:bold;">Восстановить пароль</a></p>
      <p style="color:#aaa;font-size:12px;">Ссылка действительна 1 час.</p>
      <p style="color:#aaa;font-size:12px;">Если это не ты — проигнорируй письмо.</p>
    `),
    kind: "transactional",
  });
}

/**
 * Refund notification — после успешного возврата средств.
 */
export async function sendRefundNotification(opts: {
  to: string;
  amountKopecks: number;
  reason: string;
  trackTitle?: string;
}): Promise<SendEmailResult> {
  const b = brandConfig();
  const amount = (opts.amountKopecks / 100).toFixed(2);
  return sendEmail({
    to: opts.to,
    subject: `Возврат средств в ${b.brandName} — ${amount} ₽`,
    text: `Привет!\n\nВозвращаю на твой баланс ${amount} ₽.\nПричина: ${opts.reason}\n${opts.trackTitle ? `Трек: ${opts.trackTitle}\n` : ""}\nСредства уже на балансе — можешь создать новый трек.\n\n— Музa, ${b.brandName}`,
    html: wrapBrandHtml(`
      <h1 style="color:#fff;font-size:20px;">Возврат средств</h1>
      <p>Возвращаю на твой баланс <strong style="color:#a855f7;">${amount} ₽</strong>.</p>
      <p>Причина: ${opts.reason}</p>
      ${opts.trackTitle ? `<p>Трек: ${opts.trackTitle}</p>` : ""}
      <p>Средства уже на балансе — можешь создать новый трек.</p>
      <p><a href="${b.brandUrl}/music" style="color:#a855f7;">Создать новый трек</a></p>
      <p>— Музa</p>
    `),
    kind: "transactional",
  });
}
