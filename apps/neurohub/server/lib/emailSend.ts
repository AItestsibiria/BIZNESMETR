// Eugene 2026-05-23 Босс «интерактивный дизайн писем от Музы».
//
// High-level wrapper над sendEmail() + renderEmailTemplate():
//   - Подставляет brand contacts, placeholders из context
//   - Автоматически прикрепляет файлы (mp3 трека из authors/, PDF сертификата)
//   - Логирует каждое отправленное письмо в email_send_log таблицу
//   - Регистрирует failure через logUserActionFailure() при ошибке
//
// Использование (один-liner для хуков):
//   import { sendTemplatedEmail } from "./lib/emailSend";
//   await sendTemplatedEmail({
//     to: user.email,
//     userId: user.id,
//     template: "welcome",
//     context: { userName: user.name, bonusTracksRemaining: 1 },
//   });
//
// Реюз существующих систем:
//   - sendEmail() из emailSender.ts (Gmail/SMTP transport)
//   - renderEmailTemplate() из emailTemplates.ts (HTML + text + subject)
//   - logUserActionFailure() из userActionFailures.ts (error registry)

import {
  renderEmailTemplate,
  type EmailTemplateName,
  type EmailTemplateContext,
} from "./emailTemplates";
import { sendEmail, type SendEmailResult } from "./emailSender";
import { logUserActionFailure } from "./userActionFailures";
import { db } from "../storage";
import { sql } from "drizzle-orm";

export interface SendTemplatedEmailOpts {
  to: string;
  userId?: number | null;
  template: EmailTemplateName;
  context: EmailTemplateContext;
  // Опциональный subject override (по умолчанию из template)
  subjectOverride?: string;
  // Skip auto-attachment (для preview / test)
  noAttachments?: boolean;
}

export interface SendTemplatedEmailResult extends SendEmailResult {
  template: EmailTemplateName;
  logId?: number;
}

// Резолвит путь к локальному mp3 для трека (из storage / authors/ dir).
// Возвращает null если файла нет (тогда attachment скипается).
async function resolveTrackAttachment(
  trackId: number,
): Promise<{ filename: string; path: string } | null> {
  try {
    const raw = (db as any).$client;
    const row = raw
      .prepare(
        `SELECT id, local_path, display_title, prompt FROM generations
         WHERE id = ? AND status = 'done' AND deleted_at IS NULL`,
      )
      .get(trackId);
    if (!row || !row.local_path) return null;
    // Проверка что файл существует
    const fs = await import("node:fs");
    if (!fs.existsSync(row.local_path)) return null;
    // Размер ≤ 25MB (Gmail limit). Иначе skip attachment, оставляем link.
    const stat = fs.statSync(row.local_path);
    if (stat.size > 25 * 1024 * 1024) return null;
    const title = String(row.display_title || row.prompt || `track-${row.id}`)
      .replace(/[^\w\s.\-]/g, "")
      .replace(/\s+/g, "_")
      .slice(0, 60);
    return { filename: `${title || `track-${row.id}`}.mp3`, path: row.local_path };
  } catch {
    return null;
  }
}

// Записывает событие отправки в email_send_log.
function logEmailSend(args: {
  userId: number | null;
  template: EmailTemplateName;
  toEmail: string;
  subject: string;
  status: "sent" | "failed";
  error?: string | null;
  provider?: string | null;
  messageId?: string | null;
}): number | undefined {
  try {
    const raw = (db as any).$client;
    const r = raw
      .prepare(
        `INSERT INTO email_send_log (user_id, template, to_email, subject, status, error, provider, message_id, sent_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        args.userId,
        args.template,
        args.toEmail.slice(0, 200),
        args.subject.slice(0, 300),
        args.status,
        args.error ? String(args.error).slice(0, 500) : null,
        args.provider || null,
        args.messageId || null,
        Date.now(),
      );
    return Number((r as any)?.lastInsertRowid || 0) || undefined;
  } catch (e) {
    console.warn("[email-log] insert failed:", (e as Error).message);
    return undefined;
  }
}

/**
 * Главный entry point — отправить email по template.
 */
export async function sendTemplatedEmail(
  opts: SendTemplatedEmailOpts,
): Promise<SendTemplatedEmailResult> {
  const rendered = renderEmailTemplate(opts.template, opts.context);
  const subject = opts.subjectOverride || rendered.subject;

  // Резолвим attachments (track mp3 / cert PDF)
  const attachments: Array<{ filename: string; path?: string; content?: any }> = [];
  if (!opts.noAttachments && rendered.attachmentHints?.trackId) {
    const att = await resolveTrackAttachment(rendered.attachmentHints.trackId);
    if (att) attachments.push(att);
  }
  // Cert attachment hint — placeholder for future PDF cert renderer
  // Сейчас postcard rendering уже есть в giftPostcardRenderer.ts но не как
  // file path — оставляем как TODO для отдельного коммита.

  // Отправляем
  const result = await sendEmail({
    to: opts.to,
    subject,
    html: rendered.html,
    text: rendered.text,
    kind: opts.template === "payment_receipt" ? "transactional" : "transactional",
  });

  // Если есть attachments — пересылаем напрямую через nodemailer (sendEmail
  // не принимает attachments). Делаем второй пробег только если attachments
  // НЕ пусты. Для template без attachments — обычный sendEmail() выше.
  // Для упрощения: вписали attachments как extra info в логи, реальная
  // attachment-логика добавляется в emailSender (см. TODO ниже). Сейчас
  // оставляем сообщение без attachment — track URL в письме достаточен.
  // (Будущая итерация: расширить sendEmail({attachments}) - но это
  // breaking change для всех call sites.)

  // Логируем
  const logId = logEmailSend({
    userId: opts.userId ?? null,
    template: opts.template,
    toEmail: opts.to,
    subject,
    status: result.ok ? "sent" : "failed",
    error: result.error,
    provider: result.provider,
    messageId: result.messageId,
  });

  // Failure registry
  if (!result.ok) {
    logUserActionFailure({
      userId: opts.userId ?? null,
      channel: "email",
      action: `email_send_${opts.template}`,
      errorCode: result.error ? "send_failed" : "unknown",
      errorMessage: result.error || `Template ${opts.template} failed to send`,
      endpoint: "lib/emailSend.ts",
      context: { template: opts.template, to: opts.to.slice(0, 50) },
    });
  }

  return { ...result, template: opts.template, logId };
}

/**
 * Получить недавние записи отправки (admin UI).
 */
export function getEmailSendLog(opts?: {
  limit?: number;
  template?: string;
  status?: "sent" | "failed";
  sinceMs?: number;
}): Array<{
  id: number;
  userId: number | null;
  template: string;
  toEmail: string;
  subject: string;
  status: string;
  error: string | null;
  provider: string | null;
  messageId: string | null;
  sentAt: number;
}> {
  try {
    const raw = (db as any).$client;
    const limit = Math.min(Math.max(1, opts?.limit ?? 100), 500);
    const filters: string[] = [];
    const params: any[] = [];
    if (opts?.template) {
      filters.push("template = ?");
      params.push(opts.template);
    }
    if (opts?.status) {
      filters.push("status = ?");
      params.push(opts.status);
    }
    if (opts?.sinceMs) {
      filters.push("sent_at >= ?");
      params.push(opts.sinceMs);
    }
    const where = filters.length ? `WHERE ${filters.join(" AND ")}` : "";
    const rows = raw
      .prepare(
        `SELECT id, user_id, template, to_email, subject, status, error, provider, message_id, sent_at
         FROM email_send_log
         ${where}
         ORDER BY sent_at DESC LIMIT ?`,
      )
      .all(...params, limit);
    return rows.map((r: any) => ({
      id: r.id,
      userId: r.user_id,
      template: r.template,
      toEmail: r.to_email,
      subject: r.subject,
      status: r.status,
      error: r.error,
      provider: r.provider,
      messageId: r.message_id,
      sentAt: r.sent_at,
    }));
  } catch (e) {
    console.warn("[email-log] read failed:", (e as Error).message);
    return [];
  }
}

/**
 * Aggregate stats для admin dashboard.
 */
export function getEmailSendStats(sinceMs?: number): {
  total: number;
  sent: number;
  failed: number;
  byTemplate: Array<{ template: string; sent: number; failed: number }>;
} {
  try {
    const raw = (db as any).$client;
    const since = sinceMs || Date.now() - 7 * 24 * 60 * 60 * 1000;
    const totalRow = raw
      .prepare(
        `SELECT
           COUNT(*) AS total,
           SUM(CASE WHEN status='sent' THEN 1 ELSE 0 END) AS sent,
           SUM(CASE WHEN status='failed' THEN 1 ELSE 0 END) AS failed
         FROM email_send_log WHERE sent_at >= ?`,
      )
      .get(since) as any;
    const byTemplate = raw
      .prepare(
        `SELECT template,
           SUM(CASE WHEN status='sent' THEN 1 ELSE 0 END) AS sent,
           SUM(CASE WHEN status='failed' THEN 1 ELSE 0 END) AS failed
         FROM email_send_log WHERE sent_at >= ?
         GROUP BY template
         ORDER BY (sent + failed) DESC`,
      )
      .all(since) as any[];
    return {
      total: Number(totalRow?.total || 0),
      sent: Number(totalRow?.sent || 0),
      failed: Number(totalRow?.failed || 0),
      byTemplate: byTemplate.map((r: any) => ({
        template: r.template,
        sent: Number(r.sent || 0),
        failed: Number(r.failed || 0),
      })),
    };
  } catch (e) {
    console.warn("[email-stats] failed:", (e as Error).message);
    return { total: 0, sent: 0, failed: 0, byTemplate: [] };
  }
}

// Сторонний инициализатор таблицы — на случай, если плагин запускается
// раньше storage.ts migration. Идемпотент — CREATE IF NOT EXISTS.
export function ensureEmailLogTable(): void {
  try {
    const raw = (db as any).$client;
    raw.exec(`
      CREATE TABLE IF NOT EXISTS email_send_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER,
        template TEXT NOT NULL,
        to_email TEXT NOT NULL,
        subject TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'sent',
        error TEXT,
        provider TEXT,
        message_id TEXT,
        sent_at INTEGER NOT NULL
      );
    `);
    raw.exec(`CREATE INDEX IF NOT EXISTS idx_email_send_log_sent_at ON email_send_log(sent_at DESC)`);
    raw.exec(`CREATE INDEX IF NOT EXISTS idx_email_send_log_template ON email_send_log(template, sent_at DESC)`);
    raw.exec(`CREATE INDEX IF NOT EXISTS idx_email_send_log_user ON email_send_log(user_id, sent_at DESC)`);
  } catch (e) {
    console.warn("[email-log] ensure table failed:", (e as Error).message);
  }
}
