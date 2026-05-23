// Eugene 2026-05-23 Босс «интерактивный дизайн писем от Музы».
//
// Единая система HTML-email templates с placeholder подстановкой,
// brand styling (CLAUDE.md Brand-style consistency rule), общий header/
// footer с контактами Музы и социальными сетями.
//
// Использование:
//   import { renderEmailTemplate } from "./emailTemplates";
//   const { subject, html, text } = renderEmailTemplate("welcome", {
//     userName: "Иван",
//     userEmail: "ivan@example.com",
//   });
//
// Templates:
//   - welcome           — приветствие при регистрации (спокойный)
//   - welcome_gift      — выдан подарочный трек (праздничный)
//   - gift_certificate  — подарочный сертификат другу
//   - track_ready       — трек готов к скачиванию
//   - payment_receipt   — чек об оплате
//   - password_reset    — сброс пароля
//   - email_change_confirm — подтверждение нового email
//
// Все templates имеют общий HEADER (logo MuzaAi gradient) + FOOTER
// (контакты Музы: web, Telegram, VK, email). HTML inline CSS — email
// clients требуют inline.

export type EmailTemplateName =
  | "welcome"
  | "welcome_gift"
  | "gift_certificate"
  | "track_ready"
  | "payment_receipt"
  | "password_reset"
  | "email_change_confirm";

export interface EmailTemplateContext {
  // User
  userName?: string;
  userEmail?: string;
  // Track
  trackId?: number | string;
  trackTitle?: string;
  trackUrl?: string;
  trackCoverUrl?: string;
  trackDurationSec?: number;
  // Gift certificate
  certId?: number | string;
  certCode?: string;
  certAmount?: number; // rubles
  certExpiresAt?: string; // human-readable
  certFromName?: string;
  certMessage?: string;
  // Payment
  paymentAmount?: number; // rubles
  paymentDescription?: string;
  paymentDate?: string;
  paymentMethod?: string;
  // Tokens / urls
  confirmUrl?: string;
  resetUrl?: string;
  // Misc
  bonusTracksRemaining?: number;
  balanceRubles?: number;
}

export interface RenderedEmail {
  subject: string;
  html: string;
  text: string;
  // Optional attachment hints — выполняются на уровне emailSend.ts
  attachmentHints?: {
    trackId?: number;       // hint to attach mp3 from authors/
    certId?: number;        // hint to attach postcard image
  };
}

// ─────────────────────────────────────────────────────────────────────
// Brand contacts (single source of truth) — обновляются вместе с
// Brand-assets-registry rule. См. CLAUDE.md.
// ─────────────────────────────────────────────────────────────────────
const BRAND = {
  name: "MuzaAi",
  tagline: "Создай песню с ИИ за минуту",
  url: process.env.PUBLIC_BASE_URL || "https://muzaai.ru",
  email: process.env.SUPPORT_EMAIL || "hello@muzaai.ru",
  telegram: "https://t.me/Muziaipodari_bot",
  vk: "https://vk.com/muzaai",
  max: "https://max.ru/muzaai",
};

// ─────────────────────────────────────────────────────────────────────
// Placeholder substitution — простой {{key}} replace.
// ─────────────────────────────────────────────────────────────────────
function applyPlaceholders(template: string, ctx: EmailTemplateContext): string {
  return template.replace(/\{\{(\w+)\}\}/g, (_m, key) => {
    const v = (ctx as any)[key];
    if (v === undefined || v === null) return "";
    return String(v);
  });
}

// ─────────────────────────────────────────────────────────────────────
// Common HEADER (brand gradient logo + tagline)
// ─────────────────────────────────────────────────────────────────────
function renderHeader(): string {
  return `<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="margin:0;padding:0;background:#0a0a17;">
  <tr><td align="center" style="padding:24px 12px;">
    <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="600" style="max-width:600px;width:100%;background:linear-gradient(135deg,#1a0f2e 0%,#0a0a17 50%,#0f1830 100%);border-radius:16px;border:1px solid rgba(124,58,237,0.25);">
      <tr><td style="padding:32px 28px 8px;text-align:center;">
        <div style="display:inline-block;">
          <h1 style="margin:0;font-family:'Inter',-apple-system,Arial,sans-serif;font-size:36px;font-weight:900;letter-spacing:-1px;background:linear-gradient(90deg,#7C3AED,#FF006E,#00D4FF);-webkit-background-clip:text;background-clip:text;color:transparent;display:inline-block;">MuzaAi</h1>
        </div>
        <p style="margin:8px 0 0;color:rgba(255,255,255,0.5);font-size:13px;font-family:'Inter',-apple-system,Arial,sans-serif;">${BRAND.tagline}</p>
      </td></tr>
      <tr><td style="padding:8px 28px 24px;">`;
}

// ─────────────────────────────────────────────────────────────────────
// Common FOOTER (контакты Музы со всеми сетями + ссылками)
// ─────────────────────────────────────────────────────────────────────
function renderFooter(): string {
  return `</td></tr>
      <tr><td style="padding:24px 28px 32px;border-top:1px solid rgba(255,255,255,0.08);">
        <p style="margin:0 0 16px;color:rgba(255,255,255,0.8);font-size:14px;font-family:'Inter',-apple-system,Arial,sans-serif;text-align:center;">Свяжись с Музой:</p>
        <table role="presentation" cellpadding="0" cellspacing="0" border="0" align="center" style="margin:0 auto;">
          <tr>
            <td style="padding:0 6px;">
              <a href="${BRAND.url}" style="display:inline-block;width:44px;height:44px;line-height:44px;text-align:center;background:rgba(124,58,237,0.18);border:1px solid rgba(124,58,237,0.4);border-radius:50%;color:#fff;text-decoration:none;font-size:18px;font-family:'Inter',-apple-system,Arial,sans-serif;" title="Сайт MuzaAi">🌐</a>
            </td>
            <td style="padding:0 6px;">
              <a href="${BRAND.telegram}" style="display:inline-block;width:44px;height:44px;line-height:44px;text-align:center;background:rgba(0,212,255,0.18);border:1px solid rgba(0,212,255,0.4);border-radius:50%;color:#fff;text-decoration:none;font-size:18px;font-family:'Inter',-apple-system,Arial,sans-serif;" title="Telegram бот">✈️</a>
            </td>
            <td style="padding:0 6px;">
              <a href="${BRAND.max}" style="display:inline-block;width:44px;height:44px;line-height:44px;text-align:center;background:rgba(57,255,20,0.18);border:1px solid rgba(57,255,20,0.4);border-radius:50%;color:#fff;text-decoration:none;font-size:14px;font-weight:700;font-family:'Inter',-apple-system,Arial,sans-serif;" title="Max messenger">М</a>
            </td>
            <td style="padding:0 6px;">
              <a href="${BRAND.vk}" style="display:inline-block;width:44px;height:44px;line-height:44px;text-align:center;background:rgba(255,0,110,0.18);border:1px solid rgba(255,0,110,0.4);border-radius:50%;color:#fff;text-decoration:none;font-size:14px;font-weight:700;font-family:'Inter',-apple-system,Arial,sans-serif;" title="VK сообщество">VK</a>
            </td>
            <td style="padding:0 6px;">
              <a href="mailto:${BRAND.email}" style="display:inline-block;width:44px;height:44px;line-height:44px;text-align:center;background:rgba(251,191,36,0.18);border:1px solid rgba(251,191,36,0.4);border-radius:50%;color:#fff;text-decoration:none;font-size:18px;font-family:'Inter',-apple-system,Arial,sans-serif;" title="Email">✉️</a>
            </td>
          </tr>
        </table>
        <p style="margin:24px 0 0;color:rgba(255,255,255,0.35);font-size:11px;font-family:'Inter',-apple-system,Arial,sans-serif;text-align:center;">© 2026 MuzaAi · <a href="${BRAND.url}" style="color:rgba(124,58,237,0.7);text-decoration:none;">${BRAND.url.replace(/^https?:\/\//, "")}</a></p>
        <p style="margin:8px 0 0;color:rgba(255,255,255,0.25);font-size:10px;font-family:'Inter',-apple-system,Arial,sans-serif;text-align:center;line-height:1.5;">Это письмо отправлено автоматически в ответ на твоё действие в MuzaAi.<br/>Не отвечай на него — для связи используй каналы выше.</p>
      </td></tr>
    </table>
  </td></tr>
</table>`;
}

// ─────────────────────────────────────────────────────────────────────
// Wrap body content в HEADER + FOOTER. body — это inner content (без
// wrapper).
// ─────────────────────────────────────────────────────────────────────
function wrap(bodyHtml: string): string {
  return `<!DOCTYPE html>
<html lang="ru">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width,initial-scale=1" />
<title>MuzaAi</title>
</head>
<body style="margin:0;padding:0;background:#0a0a17;font-family:'Inter',-apple-system,Arial,sans-serif;">
${renderHeader()}
${bodyHtml}
${renderFooter()}
</body>
</html>`;
}

// ─────────────────────────────────────────────────────────────────────
// Reusable building blocks
// ─────────────────────────────────────────────────────────────────────
function btnSoft(href: string, label: string): string {
  // Soft button (welcome, less flashy) — solid purple, no glow
  return `<a href="${href}" style="display:inline-block;padding:14px 28px;background:linear-gradient(90deg,#7C3AED,#5b21b6);color:#fff;text-decoration:none;border-radius:10px;font-weight:600;font-size:15px;font-family:'Inter',-apple-system,Arial,sans-serif;">${label}</a>`;
}

function btnCelebrate(href: string, label: string): string {
  // Celebrate button (gift, payment success) — multi-color gradient + glow
  return `<a href="${href}" style="display:inline-block;padding:16px 36px;background:linear-gradient(90deg,#7C3AED 0%,#D946EF 50%,#00D4FF 100%);color:#fff;text-decoration:none;border-radius:12px;font-weight:700;font-size:16px;font-family:'Inter',-apple-system,Arial,sans-serif;box-shadow:0 0 32px rgba(217,70,239,0.4),0 4px 12px rgba(124,58,237,0.4);">${label}</a>`;
}

function muzaSignature(): string {
  return `<p style="margin:24px 0 0;color:rgba(255,255,255,0.6);font-size:14px;font-style:italic;font-family:'Inter',-apple-system,Arial,sans-serif;">— Музa, твой проводник в музыку</p>`;
}

// ─────────────────────────────────────────────────────────────────────
// TEMPLATE: welcome — спокойный, маркетинговый
// ─────────────────────────────────────────────────────────────────────
function renderWelcome(ctx: EmailTemplateContext): RenderedEmail {
  const name = ctx.userName || "друг";
  const subject = `${name}, добро пожаловать в MuzaAi 🎵`;
  const body = `
    <h2 style="margin:0 0 16px;color:#fff;font-size:24px;font-weight:700;font-family:'Inter',-apple-system,Arial,sans-serif;">Привет, ${name}!</h2>
    <p style="margin:0 0 16px;color:rgba(255,255,255,0.85);font-size:15px;line-height:1.6;font-family:'Inter',-apple-system,Arial,sans-serif;">
      Я — <strong style="color:#c4b5fd;">Музa</strong>, твой проводник в музыку. Я помогаю авторам превращать идеи в готовые песни — за минуту, без музыкального образования.
    </p>
    <p style="margin:0 0 20px;color:rgba(255,255,255,0.7);font-size:14px;line-height:1.6;font-family:'Inter',-apple-system,Arial,sans-serif;">Вот что ты можешь делать прямо сейчас:</p>
    <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="margin:0 0 24px;">
      <tr><td style="padding:10px 0;color:rgba(255,255,255,0.8);font-size:14px;font-family:'Inter',-apple-system,Arial,sans-serif;">
        <span style="display:inline-block;width:28px;color:#a78bfa;font-size:18px;vertical-align:middle;">🎵</span>
        <span style="vertical-align:middle;">Создать свою песню — текст + музыка за минуту</span>
      </td></tr>
      <tr><td style="padding:10px 0;color:rgba(255,255,255,0.8);font-size:14px;font-family:'Inter',-apple-system,Arial,sans-serif;">
        <span style="display:inline-block;width:28px;color:#67e8f9;font-size:18px;vertical-align:middle;">🎧</span>
        <span style="vertical-align:middle;">Послушать треки других авторов на главной</span>
      </td></tr>
      <tr><td style="padding:10px 0;color:rgba(255,255,255,0.8);font-size:14px;font-family:'Inter',-apple-system,Arial,sans-serif;">
        <span style="display:inline-block;width:28px;color:#f0abfc;font-size:18px;vertical-align:middle;">🎁</span>
        <span style="vertical-align:middle;">Подарить песню другу — сертификат с любой суммой</span>
      </td></tr>
    </table>
    ${ctx.bonusTracksRemaining && ctx.bonusTracksRemaining > 0 ? `
    <div style="margin:0 0 24px;padding:16px 18px;background:rgba(124,58,237,0.08);border:1px solid rgba(124,58,237,0.25);border-radius:12px;">
      <p style="margin:0;color:rgba(255,255,255,0.85);font-size:14px;font-family:'Inter',-apple-system,Arial,sans-serif;">
        🎁 Тебе уже положен <strong style="color:#c4b5fd;">${ctx.bonusTracksRemaining} бесплатный трек</strong> — используй когда захочешь.
      </p>
    </div>
    ` : ""}
    <p style="margin:8px 0 24px;text-align:center;">
      ${btnSoft(BRAND.url + "/music", "Начать создание")}
    </p>
    <p style="margin:0 0 8px;color:rgba(255,255,255,0.6);font-size:13px;line-height:1.6;font-family:'Inter',-apple-system,Arial,sans-serif;">
      Если что-то нужно — пиши мне в чат на сайте, я всегда онлайн. Или зайди в Telegram-бот — там я тоже отвечу.
    </p>
    ${muzaSignature()}`;
  const text = `Привет, ${name}!

Я — Музa, твой проводник в музыку в MuzaAi. Рада знакомству!

Что ты можешь:
• Создать свою песню: ${BRAND.url}/music
• Послушать чужие треки: ${BRAND.url}
• Подарить песню другу — сертификат с любой суммой

${ctx.bonusTracksRemaining && ctx.bonusTracksRemaining > 0 ? `🎁 Тебе положен ${ctx.bonusTracksRemaining} бесплатный трек — используй когда захочешь.\n\n` : ""}Если что-то нужно — пиши мне в чат на сайте.

— Музa, MuzaAi
${BRAND.url}`;
  return { subject, html: wrap(applyPlaceholders(body, ctx)), text };
}

// ─────────────────────────────────────────────────────────────────────
// TEMPLATE: welcome_gift — красочный, праздничный
// ─────────────────────────────────────────────────────────────────────
function renderWelcomeGift(ctx: EmailTemplateContext): RenderedEmail {
  const name = ctx.userName || "друг";
  const subject = `🎁 ${name}, тебе подарок от Музы!`;
  const body = `
    <div style="text-align:center;margin:0 0 24px;">
      <div style="display:inline-block;padding:32px 24px;background:radial-gradient(ellipse at center,rgba(217,70,239,0.25) 0%,rgba(124,58,237,0.15) 50%,transparent 80%);border-radius:16px;">
        <div style="font-size:64px;line-height:1;margin-bottom:12px;">🎁</div>
        <h2 style="margin:0;color:#fff;font-size:28px;font-weight:900;font-family:'Inter',-apple-system,Arial,sans-serif;letter-spacing:-0.5px;">Подарок!</h2>
        <p style="margin:6px 0 0;color:#f0abfc;font-size:16px;font-family:'Inter',-apple-system,Arial,sans-serif;">🎉 🎊 ✨</p>
      </div>
    </div>
    <p style="margin:0 0 16px;color:rgba(255,255,255,0.9);font-size:16px;line-height:1.6;font-family:'Inter',-apple-system,Arial,sans-serif;">
      Привет, <strong style="color:#c4b5fd;">${name}</strong>!
    </p>
    <p style="margin:0 0 20px;color:rgba(255,255,255,0.85);font-size:15px;line-height:1.6;font-family:'Inter',-apple-system,Arial,sans-serif;">
      Я положила тебе на счёт <strong style="background:linear-gradient(90deg,#D946EF,#00D4FF);-webkit-background-clip:text;background-clip:text;color:transparent;font-size:18px;">1 бесплатный трек</strong>. Используй его прямо сейчас — без оплаты, без условий. Просто создай первую песню — для мамы, для любимого, для друга, для себя.
    </p>
    <div style="margin:24px 0;padding:20px;background:rgba(217,70,239,0.06);border:2px dashed rgba(217,70,239,0.4);border-radius:14px;text-align:center;">
      <p style="margin:0 0 6px;color:rgba(255,255,255,0.6);font-size:12px;text-transform:uppercase;letter-spacing:1.5px;font-family:'Inter',-apple-system,Arial,sans-serif;">Твой подарок</p>
      <p style="margin:0;color:#fff;font-size:32px;font-weight:900;font-family:'Inter',-apple-system,Arial,sans-serif;">1 трек · 399 ₽</p>
      <p style="margin:6px 0 0;color:rgba(255,255,255,0.5);font-size:13px;font-family:'Inter',-apple-system,Arial,sans-serif;">Уже на твоём балансе</p>
    </div>
    <p style="margin:24px 0;text-align:center;">
      ${btnCelebrate(BRAND.url + "/music", "🎵 Создать трек-подарок")}
    </p>
    <p style="margin:0 0 8px;color:rgba(255,255,255,0.65);font-size:13px;line-height:1.6;font-family:'Inter',-apple-system,Arial,sans-serif;text-align:center;">
      Подсказка: расскажи мне о ком песня, какой повод, какое настроение — и я подберу слова и музыку.
    </p>
    ${muzaSignature()}`;
  const text = `🎁 ${name}, тебе подарок от Музы!

Я положила тебе на счёт 1 бесплатный трек. Используй его прямо сейчас — без оплаты, без условий.

Создай свой первый трек: ${BRAND.url}/music

Подсказка: расскажи мне о ком песня, какой повод, какое настроение — и я подберу слова и музыку.

— Музa, MuzaAi
${BRAND.url}`;
  return { subject, html: wrap(applyPlaceholders(body, ctx)), text };
}

// ─────────────────────────────────────────────────────────────────────
// TEMPLATE: gift_certificate — премиум, для покупателя другу
// ─────────────────────────────────────────────────────────────────────
function renderGiftCertificate(ctx: EmailTemplateContext): RenderedEmail {
  const amount = ctx.certAmount || 0;
  const code = ctx.certCode || "—";
  const fromName = ctx.certFromName || "друг";
  const subject = `🎁 Подарочный сертификат MuzaAi — ${amount} ₽`;
  const body = `
    <div style="text-align:center;margin:0 0 24px;">
      <p style="margin:0 0 8px;color:rgba(255,255,255,0.5);font-size:12px;text-transform:uppercase;letter-spacing:2px;font-family:'Inter',-apple-system,Arial,sans-serif;">Подарочный сертификат</p>
      <h2 style="margin:0;color:#fff;font-size:42px;font-weight:900;font-family:'Inter',-apple-system,Arial,sans-serif;letter-spacing:-1px;">
        <span style="background:linear-gradient(90deg,#7C3AED,#D946EF,#00D4FF);-webkit-background-clip:text;background-clip:text;color:transparent;">${amount} ₽</span>
      </h2>
      <p style="margin:10px 0 0;color:rgba(255,255,255,0.7);font-size:14px;font-family:'Inter',-apple-system,Arial,sans-serif;">на создание песен в MuzaAi</p>
    </div>
    ${ctx.certMessage ? `
    <div style="margin:0 0 24px;padding:18px;background:rgba(124,58,237,0.08);border-left:3px solid #7C3AED;border-radius:8px;">
      <p style="margin:0 0 6px;color:rgba(255,255,255,0.5);font-size:11px;text-transform:uppercase;letter-spacing:1.5px;font-family:'Inter',-apple-system,Arial,sans-serif;">Сообщение от ${fromName}</p>
      <p style="margin:0;color:rgba(255,255,255,0.9);font-size:15px;line-height:1.6;font-family:'Inter',-apple-system,Arial,sans-serif;font-style:italic;">«${ctx.certMessage}»</p>
    </div>
    ` : ""}
    <div style="margin:0 0 24px;padding:24px 20px;background:linear-gradient(135deg,rgba(124,58,237,0.15) 0%,rgba(217,70,239,0.1) 50%,rgba(0,212,255,0.12) 100%);border:1px solid rgba(217,70,239,0.3);border-radius:14px;text-align:center;">
      <p style="margin:0 0 8px;color:rgba(255,255,255,0.55);font-size:11px;text-transform:uppercase;letter-spacing:2px;font-family:'Inter',-apple-system,Arial,sans-serif;">Код для активации</p>
      <p style="margin:0;color:#fff;font-size:28px;font-weight:900;font-family:'JetBrains Mono','Courier New',monospace;letter-spacing:4px;">${code}</p>
      <p style="margin:12px 0 0;color:rgba(255,255,255,0.5);font-size:12px;font-family:'Inter',-apple-system,Arial,sans-serif;">Введи код в личном кабинете → «Активировать сертификат»</p>
    </div>
    <p style="margin:24px 0;text-align:center;">
      ${btnCelebrate(BRAND.url + "/redeem?code=" + encodeURIComponent(code), "🎁 Активировать сертификат")}
    </p>
    ${ctx.certExpiresAt ? `<p style="margin:0 0 16px;color:rgba(255,255,255,0.5);font-size:12px;font-family:'Inter',-apple-system,Arial,sans-serif;text-align:center;">Сертификат действует до ${ctx.certExpiresAt}</p>` : ""}
    <p style="margin:8px 0 0;color:rgba(255,255,255,0.65);font-size:13px;line-height:1.6;font-family:'Inter',-apple-system,Arial,sans-serif;text-align:center;">
      Не знаешь о чём песня? Просто открой чат — я подскажу идеи и подберу подходящий стиль.
    </p>
    ${muzaSignature()}`;
  const text = `🎁 Подарочный сертификат MuzaAi — ${amount} ₽

${ctx.certMessage ? `Сообщение от ${fromName}:\n«${ctx.certMessage}»\n\n` : ""}Код для активации: ${code}

Активировать: ${BRAND.url}/redeem?code=${encodeURIComponent(code)}
${ctx.certExpiresAt ? `\nСертификат действует до ${ctx.certExpiresAt}` : ""}

— Музa, MuzaAi
${BRAND.url}`;
  return {
    subject,
    html: wrap(applyPlaceholders(body, ctx)),
    text,
    attachmentHints: { certId: typeof ctx.certId === "number" ? ctx.certId : undefined },
  };
}

// ─────────────────────────────────────────────────────────────────────
// TEMPLATE: track_ready — трек готов к скачиванию
// ─────────────────────────────────────────────────────────────────────
function renderTrackReady(ctx: EmailTemplateContext): RenderedEmail {
  const title = ctx.trackTitle || "Мой трек";
  const url = ctx.trackUrl || (ctx.trackId ? `${BRAND.url}/track/${ctx.trackId}` : BRAND.url + "/dashboard");
  const duration = ctx.trackDurationSec
    ? `${Math.floor(ctx.trackDurationSec / 60)}:${String(Math.floor(ctx.trackDurationSec % 60)).padStart(2, "0")}`
    : "";
  const subject = `🎵 Твой трек «${title}» готов`;
  const body = `
    <h2 style="margin:0 0 16px;color:#fff;font-size:24px;font-weight:700;font-family:'Inter',-apple-system,Arial,sans-serif;">Трек готов!</h2>
    <p style="margin:0 0 20px;color:rgba(255,255,255,0.85);font-size:15px;line-height:1.6;font-family:'Inter',-apple-system,Arial,sans-serif;">
      Я закончила работу над <strong style="color:#c4b5fd;">«${title}»</strong>. Послушай, скачай, поделись с теми, для кого он создан.
    </p>
    ${ctx.trackCoverUrl ? `
    <div style="margin:0 0 24px;text-align:center;">
      <img src="${ctx.trackCoverUrl}" alt="${title}" width="280" height="280" style="display:inline-block;width:280px;height:280px;max-width:80%;border-radius:14px;border:1px solid rgba(124,58,237,0.3);box-shadow:0 8px 32px rgba(124,58,237,0.25);" />
    </div>
    ` : ""}
    <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="margin:0 0 24px;">
      <tr><td style="padding:10px 0;border-bottom:1px solid rgba(255,255,255,0.08);">
        <span style="color:rgba(255,255,255,0.5);font-size:13px;font-family:'Inter',-apple-system,Arial,sans-serif;">Название:</span>
        <span style="color:rgba(255,255,255,0.9);font-size:13px;font-family:'Inter',-apple-system,Arial,sans-serif;margin-left:8px;">${title}</span>
      </td></tr>
      ${duration ? `<tr><td style="padding:10px 0;border-bottom:1px solid rgba(255,255,255,0.08);">
        <span style="color:rgba(255,255,255,0.5);font-size:13px;font-family:'Inter',-apple-system,Arial,sans-serif;">Длительность:</span>
        <span style="color:rgba(255,255,255,0.9);font-size:13px;font-family:'JetBrains Mono',monospace;margin-left:8px;">${duration}</span>
      </td></tr>` : ""}
      <tr><td style="padding:10px 0;">
        <span style="color:rgba(255,255,255,0.5);font-size:13px;font-family:'Inter',-apple-system,Arial,sans-serif;">ID:</span>
        <span style="color:rgba(255,255,255,0.7);font-size:13px;font-family:'JetBrains Mono',monospace;margin-left:8px;">#${ctx.trackId || "—"}</span>
      </td></tr>
    </table>
    <table role="presentation" cellpadding="0" cellspacing="0" border="0" align="center" style="margin:0 auto 16px;">
      <tr>
        <td style="padding:0 6px;">
          <a href="${url}" style="display:inline-block;padding:12px 22px;background:linear-gradient(90deg,#7C3AED,#D946EF);color:#fff;text-decoration:none;border-radius:10px;font-weight:600;font-size:14px;font-family:'Inter',-apple-system,Arial,sans-serif;">▶ Послушать</a>
        </td>
        <td style="padding:0 6px;">
          <a href="${url}?download=1" style="display:inline-block;padding:12px 22px;background:rgba(255,255,255,0.08);border:1px solid rgba(124,58,237,0.4);color:#fff;text-decoration:none;border-radius:10px;font-weight:600;font-size:14px;font-family:'Inter',-apple-system,Arial,sans-serif;">⬇ Скачать</a>
        </td>
        <td style="padding:0 6px;">
          <a href="${url}?share=1" style="display:inline-block;padding:12px 22px;background:rgba(255,255,255,0.08);border:1px solid rgba(0,212,255,0.4);color:#fff;text-decoration:none;border-radius:10px;font-weight:600;font-size:14px;font-family:'Inter',-apple-system,Arial,sans-serif;">↗ Поделиться</a>
        </td>
      </tr>
    </table>
    <p style="margin:24px 0 0;color:rgba(255,255,255,0.6);font-size:13px;line-height:1.6;font-family:'Inter',-apple-system,Arial,sans-serif;text-align:center;">
      Если хочешь — могу сделать продолжение, кавер в другом стиле или ремикс. Просто скажи в чате.
    </p>
    ${muzaSignature()}`;
  const text = `🎵 Твой трек «${title}» готов

${duration ? `Длительность: ${duration}\n` : ""}ID: #${ctx.trackId || "—"}

Послушать / скачать: ${url}

Если хочешь — могу сделать продолжение, кавер в другом стиле или ремикс. Просто скажи в чате.

— Музa, MuzaAi
${BRAND.url}`;
  return {
    subject,
    html: wrap(applyPlaceholders(body, ctx)),
    text,
    attachmentHints: { trackId: typeof ctx.trackId === "number" ? ctx.trackId : undefined },
  };
}

// ─────────────────────────────────────────────────────────────────────
// TEMPLATE: payment_receipt — чек об оплате
// ─────────────────────────────────────────────────────────────────────
function renderPaymentReceipt(ctx: EmailTemplateContext): RenderedEmail {
  const amount = ctx.paymentAmount || 0;
  const desc = ctx.paymentDescription || "Пополнение баланса";
  const date = ctx.paymentDate || new Date().toLocaleDateString("ru-RU");
  const method = ctx.paymentMethod || "Robokassa";
  const subject = `Чек MuzaAi · ${amount} ₽ · ${date}`;
  const body = `
    <h2 style="margin:0 0 8px;color:#fff;font-size:22px;font-weight:700;font-family:'Inter',-apple-system,Arial,sans-serif;">Спасибо за оплату!</h2>
    <p style="margin:0 0 24px;color:rgba(255,255,255,0.7);font-size:14px;font-family:'Inter',-apple-system,Arial,sans-serif;">
      Платёж получен и зачислен на твой баланс.
    </p>
    <div style="margin:0 0 24px;padding:20px;background:rgba(124,58,237,0.06);border:1px solid rgba(124,58,237,0.2);border-radius:12px;">
      <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%">
        <tr><td style="padding:8px 0;color:rgba(255,255,255,0.5);font-size:13px;font-family:'Inter',-apple-system,Arial,sans-serif;">Описание</td>
            <td style="padding:8px 0;text-align:right;color:rgba(255,255,255,0.9);font-size:13px;font-family:'Inter',-apple-system,Arial,sans-serif;">${desc}</td></tr>
        <tr><td style="padding:8px 0;color:rgba(255,255,255,0.5);font-size:13px;font-family:'Inter',-apple-system,Arial,sans-serif;">Дата</td>
            <td style="padding:8px 0;text-align:right;color:rgba(255,255,255,0.9);font-size:13px;font-family:'JetBrains Mono',monospace;">${date}</td></tr>
        <tr><td style="padding:8px 0;color:rgba(255,255,255,0.5);font-size:13px;font-family:'Inter',-apple-system,Arial,sans-serif;">Метод</td>
            <td style="padding:8px 0;text-align:right;color:rgba(255,255,255,0.9);font-size:13px;font-family:'Inter',-apple-system,Arial,sans-serif;">${method}</td></tr>
        <tr><td style="padding:14px 0 0;color:rgba(255,255,255,0.7);font-size:15px;font-weight:600;font-family:'Inter',-apple-system,Arial,sans-serif;border-top:1px solid rgba(255,255,255,0.08);">Сумма</td>
            <td style="padding:14px 0 0;text-align:right;color:#fff;font-size:20px;font-weight:900;font-family:'Inter',-apple-system,Arial,sans-serif;border-top:1px solid rgba(255,255,255,0.08);">
              <span style="background:linear-gradient(90deg,#7C3AED,#00D4FF);-webkit-background-clip:text;background-clip:text;color:transparent;">${amount} ₽</span>
            </td></tr>
      </table>
    </div>
    ${ctx.balanceRubles !== undefined ? `
    <p style="margin:0 0 16px;color:rgba(255,255,255,0.7);font-size:14px;font-family:'Inter',-apple-system,Arial,sans-serif;text-align:center;">
      Текущий баланс: <strong style="color:#c4b5fd;">${ctx.balanceRubles} ₽</strong>
    </p>
    ` : ""}
    <p style="margin:24px 0;text-align:center;">
      ${btnSoft(BRAND.url + "/music", "Создать трек")}
    </p>
    ${muzaSignature()}`;
  const text = `Чек MuzaAi · ${amount} ₽ · ${date}

Спасибо за оплату!

Описание: ${desc}
Дата: ${date}
Метод: ${method}
Сумма: ${amount} ₽
${ctx.balanceRubles !== undefined ? `\nТекущий баланс: ${ctx.balanceRubles} ₽` : ""}

Создать трек: ${BRAND.url}/music

— Музa, MuzaAi
${BRAND.url}`;
  return { subject, html: wrap(applyPlaceholders(body, ctx)), text };
}

// ─────────────────────────────────────────────────────────────────────
// TEMPLATE: password_reset
// ─────────────────────────────────────────────────────────────────────
function renderPasswordReset(ctx: EmailTemplateContext): RenderedEmail {
  const url = ctx.resetUrl || BRAND.url;
  const subject = `Восстановление пароля в MuzaAi`;
  const body = `
    <h2 style="margin:0 0 16px;color:#fff;font-size:22px;font-weight:700;font-family:'Inter',-apple-system,Arial,sans-serif;">Восстановление пароля</h2>
    <p style="margin:0 0 20px;color:rgba(255,255,255,0.85);font-size:15px;line-height:1.6;font-family:'Inter',-apple-system,Arial,sans-serif;">
      Кто-то (надеюсь, ты) запросил восстановление пароля. Нажми кнопку, чтобы задать новый:
    </p>
    <p style="margin:24px 0;text-align:center;">
      ${btnSoft(url, "Восстановить пароль")}
    </p>
    <p style="margin:0 0 8px;color:rgba(255,255,255,0.5);font-size:12px;line-height:1.6;font-family:'Inter',-apple-system,Arial,sans-serif;">
      Или скопируй ссылку: <br/>
      <a href="${url}" style="color:#a78bfa;word-break:break-all;font-family:'JetBrains Mono',monospace;font-size:11px;">${url}</a>
    </p>
    <p style="margin:16px 0 0;color:rgba(255,255,255,0.6);font-size:13px;font-family:'Inter',-apple-system,Arial,sans-serif;">
      Ссылка действительна 1 час. Если это не ты — просто проигнорируй письмо, ничего не изменится.
    </p>
    ${muzaSignature()}`;
  const text = `Восстановление пароля в MuzaAi

Чтобы задать новый пароль, открой ссылку:
${url}

Ссылка действительна 1 час. Если это не ты — проигнорируй письмо.

— Музa, MuzaAi
${BRAND.url}`;
  return { subject, html: wrap(applyPlaceholders(body, ctx)), text };
}

// ─────────────────────────────────────────────────────────────────────
// TEMPLATE: email_change_confirm
// ─────────────────────────────────────────────────────────────────────
function renderEmailChangeConfirm(ctx: EmailTemplateContext): RenderedEmail {
  const url = ctx.confirmUrl || BRAND.url;
  const subject = `Подтверди новый email в MuzaAi`;
  const body = `
    <h2 style="margin:0 0 16px;color:#fff;font-size:22px;font-weight:700;font-family:'Inter',-apple-system,Arial,sans-serif;">Подтверждение нового email</h2>
    <p style="margin:0 0 20px;color:rgba(255,255,255,0.85);font-size:15px;line-height:1.6;font-family:'Inter',-apple-system,Arial,sans-serif;">
      Ты указал этот адрес как новый email для своего аккаунта в MuzaAi. Чтобы подтвердить — нажми кнопку:
    </p>
    <p style="margin:24px 0;text-align:center;">
      ${btnSoft(url, "Подтвердить email")}
    </p>
    <p style="margin:0 0 8px;color:rgba(255,255,255,0.5);font-size:12px;line-height:1.6;font-family:'Inter',-apple-system,Arial,sans-serif;">
      Или скопируй ссылку: <br/>
      <a href="${url}" style="color:#a78bfa;word-break:break-all;font-family:'JetBrains Mono',monospace;font-size:11px;">${url}</a>
    </p>
    <p style="margin:16px 0 0;color:rgba(255,255,255,0.6);font-size:13px;font-family:'Inter',-apple-system,Arial,sans-serif;">
      Если это не ты — проигнорируй письмо. Email не изменится.
    </p>
    ${muzaSignature()}`;
  const text = `Подтверди новый email в MuzaAi

Открой ссылку чтобы подтвердить:
${url}

Если это не ты — проигнорируй письмо.

— Музa, MuzaAi
${BRAND.url}`;
  return { subject, html: wrap(applyPlaceholders(body, ctx)), text };
}

// ─────────────────────────────────────────────────────────────────────
// Public entry point: renderEmailTemplate(name, ctx)
// ─────────────────────────────────────────────────────────────────────
export function renderEmailTemplate(
  name: EmailTemplateName,
  ctx: EmailTemplateContext,
): RenderedEmail {
  switch (name) {
    case "welcome":
      return renderWelcome(ctx);
    case "welcome_gift":
      return renderWelcomeGift(ctx);
    case "gift_certificate":
      return renderGiftCertificate(ctx);
    case "track_ready":
      return renderTrackReady(ctx);
    case "payment_receipt":
      return renderPaymentReceipt(ctx);
    case "password_reset":
      return renderPasswordReset(ctx);
    case "email_change_confirm":
      return renderEmailChangeConfirm(ctx);
    default:
      // Безопасный fallback
      return renderWelcome(ctx);
  }
}

// ─────────────────────────────────────────────────────────────────────
// Sample context для preview-режима (admin UI / test emails)
// ─────────────────────────────────────────────────────────────────────
export function getSampleContext(name: EmailTemplateName): EmailTemplateContext {
  const base = { userName: "Иван", userEmail: "ivan@example.com" };
  switch (name) {
    case "welcome":
      return { ...base, bonusTracksRemaining: 1 };
    case "welcome_gift":
      return { ...base };
    case "gift_certificate":
      return {
        ...base,
        certId: 42,
        certCode: "MUZA-GIFT-2026",
        certAmount: 1000,
        certFromName: "Анна",
        certMessage: "С днём рождения! Создавай свои самые красивые песни ✨",
        certExpiresAt: "31 декабря 2026",
      };
    case "track_ready":
      return {
        ...base,
        trackId: 1234,
        trackTitle: "Маме на 70 лет",
        trackUrl: "https://muzaai.ru/track/1234",
        trackDurationSec: 212,
      };
    case "payment_receipt":
      return {
        ...base,
        paymentAmount: 1000,
        paymentDescription: "Пополнение баланса MuzaAi",
        paymentDate: new Date().toLocaleDateString("ru-RU"),
        paymentMethod: "Robokassa · Банковская карта",
        balanceRubles: 1500,
      };
    case "password_reset":
      return { ...base, resetUrl: "https://muzaai.ru/#/reset-password?token=SAMPLE_TOKEN_xyz" };
    case "email_change_confirm":
      return { ...base, confirmUrl: "https://muzaai.ru/#/confirm-email?token=SAMPLE_TOKEN_xyz" };
    default:
      return base;
  }
}

export const EMAIL_TEMPLATE_NAMES: EmailTemplateName[] = [
  "welcome",
  "welcome_gift",
  "gift_certificate",
  "track_ready",
  "payment_receipt",
  "password_reset",
  "email_change_confirm",
];

export const EMAIL_TEMPLATE_LABELS: Record<EmailTemplateName, string> = {
  welcome: "👋 Приветствие (регистрация)",
  welcome_gift: "🎁 Подарочный трек",
  gift_certificate: "🎁 Подарочный сертификат",
  track_ready: "🎵 Трек готов",
  payment_receipt: "💳 Чек об оплате",
  password_reset: "🔐 Сброс пароля",
  email_change_confirm: "✉️ Подтверждение email",
};
