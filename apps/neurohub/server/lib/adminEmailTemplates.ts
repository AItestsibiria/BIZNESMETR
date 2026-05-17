// Eugene 2026-05-17 Босс: email-templates для admin 2FA.
//
// Вынесено из adminTwoFactor.ts в отдельный модуль чтобы:
// 1) тестировать рендер без отправки
// 2) повторно использовать для других admin notifications (e.g.
//    "новый IP вошёл в admin", "попытка failed login")
// 3) централизованно поддерживать брендинг (gradient + MuzaAi)
//
// Все шаблоны — RU. Использует существующий Gmail SMTP через nodemailer
// (уже настроен в server/routes.ts: GMAIL_USER + GMAIL_APP_PASSWORD).
//
// Spec: docs/strategy/ADMIN-SECURITY-AUDIT-170526.md.

export type ProtectedActionLabel =
  | "change_registration_status"
  | "kick_session"
  | "query_users"
  | "send_telegram_alert"
  | "reload_kb"
  | "pause_bot"
  | "restart_pm2"
  | "delete_user"
  | "refund_payment";

export const ACTION_LABEL_RU: Record<ProtectedActionLabel, string> = {
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

export interface ConfirmEmailParams {
  code: string;                           // 6-digit plain
  action: ProtectedActionLabel;
  argsPreview: string;                    // короткая выжимка args (без секретов)
  ip?: string | null;                     // IP откуда инициировал admin
  userAgent?: string | null;              // UA откуда инициировал admin
  ttlMin?: number;                        // default 10
}

export function renderAdminConfirmEmail(p: ConfirmEmailParams): { subject: string; text: string; html: string } {
  const actionRu = ACTION_LABEL_RU[p.action] || p.action;
  const ttl = p.ttlMin ?? 10;
  const subject = `🔐 Код подтверждения admin-действия MuzaAi`;

  const argsBlock = p.argsPreview && p.argsPreview !== "{}"
    ? `<p style="color: #888; font-size: 13px; line-height: 1.4; margin: 4px 0 16px 0; font-family: monospace; word-break: break-all;">Параметры: ${escapeHtml(p.argsPreview)}</p>`
    : "";

  const sourceBlock = (p.ip || p.userAgent)
    ? `
      <div style="border-top: 1px solid #1a1a2e; padding-top: 12px; margin-top: 16px; color: #6b7280; font-size: 12px; line-height: 1.5;">
        <p style="margin: 0 0 4px 0;">Источник запроса:</p>
        ${p.ip ? `<p style="margin: 0 0 2px 0;">IP: <code style="color:#a78bfa;">${escapeHtml(p.ip)}</code></p>` : ""}
        ${p.userAgent ? `<p style="margin: 0;">UA: <code style="color:#a78bfa;">${escapeHtml(String(p.userAgent).slice(0, 200))}</code></p>` : ""}
      </div>`
    : "";

  const html = `
    <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; max-width: 560px; margin: 0 auto; padding: 32px; background: #0a0a17; border-radius: 16px; border: 1px solid #1a1a2e;">
      <div style="text-align: center; margin-bottom: 24px;">
        <span style="font-size: 24px; font-weight: 700; background: linear-gradient(135deg, #8b5cf6, #ec4899, #3b82f6); -webkit-background-clip: text; -webkit-text-fill-color: transparent;">MuzaAi · Admin</span>
      </div>
      <p style="color: #e2e2e2; font-size: 15px; line-height: 1.6; margin-bottom: 8px;">Запрошено admin-действие:</p>
      <p style="color: #fff; font-size: 17px; line-height: 1.6; margin: 8px 0 4px 0;"><strong>${escapeHtml(actionRu)}</strong></p>
      ${argsBlock}
      <p style="color: #e2e2e2; font-size: 14px; line-height: 1.6;">Код подтверждения (действует ${ttl} мин):</p>
      <div style="text-align: center; margin: 16px 0 24px 0;">
        <span style="display: inline-block; font-size: 36px; font-weight: 700; letter-spacing: 8px; color: #fff; background: linear-gradient(135deg, #8b5cf6, #3b82f6); padding: 16px 32px; border-radius: 12px; font-family: 'JetBrains Mono', monospace;">${p.code}</span>
      </div>
      ${sourceBlock}
      <div style="border-top: 1px solid #1a1a2e; padding-top: 16px; margin-top: 16px;">
        <p style="color: #f87171; font-size: 13px; line-height: 1.6; margin: 0 0 8px 0;"><strong>Если это не ты — НЕМЕДЛЕННО:</strong></p>
        <ol style="color: #d4d4d8; font-size: 13px; line-height: 1.7; padding-left: 20px; margin: 0;">
          <li>Смени пароль admin-аккаунта на muzaai.ru/account</li>
          <li>Проверь <code style="color:#a78bfa;">/api/admin/v304/audit-log</code> — кто и когда заходил</li>
          <li>Включи SSH-only auth и rotate session secrets (SESSION_SECRET, SIGNED_URL_SECRET)</li>
          <li>Проверь <code style="color:#a78bfa;">/api/admin/v304/protected-action/recent</code> — нет ли других pending</li>
        </ol>
      </div>
      <p style="color: #4b5563; font-size: 11px; line-height: 1.5; margin: 16px 0 0 0; text-align: center;">
        Это автоматическое письмо. Не отвечай — оно не читается.
      </p>
    </div>`;

  const text = [
    `MuzaAi · Admin`,
    ``,
    `Запрошено admin-действие: ${actionRu}`,
    p.argsPreview && p.argsPreview !== "{}" ? `Параметры: ${p.argsPreview}` : "",
    p.ip ? `IP инициатора: ${p.ip}` : "",
    p.userAgent ? `UA: ${String(p.userAgent).slice(0, 200)}` : "",
    ``,
    `Код подтверждения: ${p.code}`,
    `(действует ${ttl} минут)`,
    ``,
    `Если это не ты — НЕМЕДЛЕННО:`,
    `1. Смени пароль admin-аккаунта на muzaai.ru/account`,
    `2. Проверь admin_audit_log — кто и когда заходил`,
    `3. Включи SSH-only auth и rotate session secrets`,
    `4. Проверь /protected-action/recent — нет ли других pending`,
    ``,
    `— MuzaAi Admin Security`,
  ]
    .filter(Boolean)
    .join("\n");

  return { subject, text, html };
}

function escapeHtml(s: string): string {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

// === Gmail SMTP transport ===
// Используется существующий GMAIL_APP_PASSWORD (см. server/routes.ts).
// Dynamic import nodemailer — модуль грузится только когда нужно отправить.

export async function sendViaGmail(to: string, subject: string, text: string, html: string): Promise<void> {
  const nodemailer = await import("nodemailer");
  const GMAIL_USER = process.env.GMAIL_USER || "tissan2021@gmail.com";
  const GMAIL_APP_PASSWORD = process.env.GMAIL_APP_PASSWORD || "";
  if (!GMAIL_APP_PASSWORD) {
    throw new Error("Email-канал не настроен (GMAIL_APP_PASSWORD missing). Проверь .env на VPS.");
  }
  const transport = nodemailer.createTransport({
    service: "gmail",
    auth: { user: GMAIL_USER, pass: GMAIL_APP_PASSWORD },
  });
  await transport.sendMail({
    from: `"MuzaAi Admin Security" <${GMAIL_USER}>`,
    to,
    subject,
    text,
    html,
  });
}
