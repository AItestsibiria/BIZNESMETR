// Eugene 2026-05-25 Босс «оператор ПДн 152-ФЗ» — re-permission (повторный
// опт-ин) для СУЩЕСТВУЮЩЕЙ базы пользователей.
//
// ЗАЧЕМ: до 01.09.2025 многие согласия на получение РЕКЛАМНЫХ сообщений
// собирались без отдельного явного чек-бокса. Чтобы легально продолжить
// рассылать новости/предложения по старой базе, нужно собрать новое явное
// согласие (double opt-in): отправить письмо «подтвердите подписку» со
// ссылкой подтверждения. Кто не подтвердил — в маркетинговую рассылку не
// включается (остаётся только transactional).
//
// ЭТОТ ФАЙЛ — ТОЛЬКО ШАБЛОН + функция отправки одного письма. РАССЫЛКУ НЕ
// ЗАПУСКАЕТ. Массовую отправку по базе запускает email-робот (плагин postman)
// или Босс вручную — этот модуль лишь предоставляет готовый контент и
// reuse-обёртку над sendEmail (Reuse-working-solutions rule).
//
// Маркировка рекламы (ст. 18 ФЗ «О рекламе»): письмо содержит пометку
// «реклама», реквизиты рекламодателя и ссылку отписки — обязательны.
//
// ВАЖНО: этот модуль НЕ трогает таблицы email_subscribers / email_consents
// и lib/postmanAgent.ts (их ведёт параллельный агент). Хранение статуса
// согласия — на стороне email-робота.

import { sendEmail, brandConfig, type SendEmailResult } from "./emailSender";
import { getLegalConfig } from "./legalConfig";

export interface RePermissionEmailContent {
  subject: string;
  text: string;
  html: string;
}

/**
 * Собирает готовый контент письма повторного согласия (double opt-in).
 *
 * @param opts.userName     имя для приветствия (опционально)
 * @param opts.confirmUrl   полная ссылка подтверждения подписки. Токен/маршрут
 *                          формирует вызывающая сторона (email-робот) — здесь
 *                          мы лишь вставляем готовый URL.
 * @param opts.unsubscribeUrl ссылка отписки (если письмо вообще больше не нужно).
 */
export function buildRePermissionEmail(opts: {
  userName?: string;
  confirmUrl: string;
  unsubscribeUrl?: string;
}): RePermissionEmailContent {
  const b = brandConfig();
  const legal = getLegalConfig();
  const name = (opts.userName || "").trim() || "друг";
  const consentUrl = `${b.brandUrl}${legal.pdConsentUrl}`;
  const unsub = opts.unsubscribeUrl || `${b.brandUrl}/unsubscribe`;

  const subject = `Подтвердите подписку на новости ${b.brandName} 🎵`;

  const text = `Привет, ${name}!

Это ${b.brandName}. Мы обновили правила и хотим убедиться, что ты по-прежнему
хочешь получать от нас новости, советы и специальные предложения.

Подтверди подписку одной ссылкой:
${opts.confirmUrl}

Если не подтвердишь — мы просто перестанем присылать тебе маркетинговые письма
(важные служебные уведомления о твоих треках и платежах останутся).

Согласие на обработку персональных данных: ${consentUrl}
Отписаться полностью: ${unsub}

— Музa, ${b.brandName}

———
Реклама. Рекламодатель: ${legal.entityFullName}, ИНН ${legal.inn}.
${legal.legalAddress}`;

  const html = wrapBrand(
    b.brandName,
    b.brandUrl,
    b.supportEmail,
    `
      <h1 style="color:#fff;font-size:20px;">Привет, ${escapeHtml(name)}!</h1>
      <p>Это <strong>${escapeHtml(b.brandName)}</strong>. Мы обновили правила и хотим
      убедиться, что ты по-прежнему хочешь получать от нас новости, советы и
      специальные предложения.</p>
      <p style="text-align:center;margin:28px 0;">
        <a href="${escapeAttr(opts.confirmUrl)}"
           style="display:inline-block;background:linear-gradient(90deg,#a855f7,#3b82f6);color:#fff;
                  text-decoration:none;padding:12px 28px;border-radius:12px;font-weight:bold;">
          Да, хочу получать письма
        </a>
      </p>
      <p style="color:#aaa;font-size:13px;">Если не подтвердишь — мы просто перестанем
      присылать тебе маркетинговые письма. Важные служебные уведомления о твоих
      треках и платежах останутся.</p>
      <p style="font-size:12px;color:#888;">
        <a href="${escapeAttr(consentUrl)}" style="color:#a855f7;">Согласие на обработку ПДн</a> ·
        <a href="${escapeAttr(unsub)}" style="color:#a855f7;">Отписаться</a>
      </p>
      <p style="font-size:11px;color:#666;margin-top:20px;border-top:1px solid rgba(168,85,247,0.15);padding-top:12px;">
        Реклама. Рекламодатель: ${escapeHtml(legal.entityFullName)}, ИНН ${escapeHtml(legal.inn)}.<br/>
        ${escapeHtml(legal.legalAddress)}
      </p>
    `,
  );

  return { subject, text, html };
}

/**
 * Отправляет ОДНО письмо повторного согласия конкретному адресату.
 * Reuse-обёртка над sendEmail (kind='promo'). Возвращает результат отправки.
 *
 * НЕ для массовой рассылки — её запускает email-робот / Босс. Эта функция
 * нужна для теста и для пер-адресной отправки из вызывающего кода.
 */
export async function sendRePermissionEmail(opts: {
  to: string;
  userName?: string;
  confirmUrl: string;
  unsubscribeUrl?: string;
}): Promise<SendEmailResult> {
  const content = buildRePermissionEmail({
    userName: opts.userName,
    confirmUrl: opts.confirmUrl,
    unsubscribeUrl: opts.unsubscribeUrl,
  });
  return sendEmail({
    to: opts.to,
    subject: content.subject,
    text: content.text,
    html: content.html,
    kind: "promo",
  });
}

// === helpers (локальные, чтобы не зависеть от приватных функций emailSender) ===

function wrapBrand(
  brandName: string,
  brandUrl: string,
  supportEmail: string,
  bodyHtml: string,
): string {
  return `<!DOCTYPE html><html><body style="font-family:Arial,sans-serif;background:#0a0a17;color:#fff;padding:24px;">
<div style="max-width:560px;margin:0 auto;background:#1a0f2e;border:1px solid rgba(168,85,247,0.3);border-radius:16px;padding:24px;">
  <div style="text-align:center;font-size:24px;font-weight:bold;margin-bottom:16px;">
    <span style="background:linear-gradient(90deg,#a855f7,#3b82f6);-webkit-background-clip:text;background-clip:text;color:transparent;">${escapeHtml(brandName)}</span>
  </div>
  ${bodyHtml}
  <hr style="border-color:rgba(168,85,247,0.2);margin:24px 0;" />
  <div style="font-size:12px;color:#888;text-align:center;">
    Музa · <a href="${escapeAttr(brandUrl)}" style="color:#a855f7;">${escapeHtml(brandUrl)}</a> ·
    <a href="mailto:${escapeAttr(supportEmail)}" style="color:#a855f7;">${escapeHtml(supportEmail)}</a>
  </div>
</div>
</body></html>`;
}

function escapeHtml(s: string): string {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function escapeAttr(s: string): string {
  return escapeHtml(s).replace(/"/g, "&quot;");
}
