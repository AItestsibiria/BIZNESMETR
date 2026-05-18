// Eugene 2026-05-18 Босс «При вводе ЛЮБОГО промокода при регистрации —
// уведомление Боссу через email + fallback на Telegram».
//
// Запускается fire-and-forget — никогда не throw'ит наружу, не блокирует
// регистрацию. Используется в /api/auth/verify-register сразу после того
// как мы знаем результат проверки промокода (active / expired / not_found).
//
// Каналы:
//   1. Email на egnovoselov@gmail.com (через переданный mailer)
//   2. Если SMTP пустой (нет GMAIL_APP_PASSWORD) — Telegram fallback
//      (TELEGRAM_BOT_TOKEN + ADMIN_TELEGRAM_ID)
//   3. Если оба недоступны — console.warn (не падаем)
//
// Rate-limit: 1 alert / promo+email пара / 10 мин (защита если юзер
// несколько раз нажимает Verify).

const ADMIN_EMAIL = "egnovoselov@gmail.com";
const ALERT_TTL_MS = 10 * 60 * 1000;
const lastAlertMap = new Map<string, number>();

// Eugene 2026-05-18 Босс: реестр «исторических» промокодов, которые
// больше не активны, но юзеры могут вспомнить из старых соцпостов.
// Возвращаем дружелюбное сообщение с пояснением вместо «не найден».
export interface ExpiredPromoInfo {
  /** Case-insensitive match — нормализуем при сравнении. */
  code: string;
  /** Период когда промокод действовал — для пояснения юзеру. */
  period: string;
  /** Финальное сообщение которое показываем юзеру. */
  message: string;
}

export const EXPIRED_PROMOS: ExpiredPromoInfo[] = [
  {
    code: "поехали",
    period: "месяц с 12 апреля 2026",
    message:
      "Промокод «Поехали» действовал месяц с 12 апреля 2026. Сейчас не активен. Если хочешь подарок — следи за новостями на главной странице 🎁",
  },
];

/**
 * Проверка: введённый промокод — это известный исторический (expired) промокод?
 * Возвращает info-объект если да, null если нет.
 */
export function checkExpiredPromo(raw: string): ExpiredPromoInfo | null {
  const norm = String(raw || "").trim().toLowerCase();
  if (!norm) return null;
  for (const p of EXPIRED_PROMOS) {
    if (p.code.toLowerCase() === norm) return p;
  }
  return null;
}

function pruneOldAlerts(now: number): void {
  if (lastAlertMap.size < 500) return;
  for (const [k, v] of lastAlertMap) {
    if (now - v > 30 * 60 * 1000) lastAlertMap.delete(k);
  }
}

function parseDeviceFromUa(ua: string): string {
  const u = (ua || "").toLowerCase();
  if (/iphone/.test(u)) return "iPhone";
  if (/ipad/.test(u)) return "iPad";
  if (/android.*mobile/.test(u)) return "Android phone";
  if (/android/.test(u)) return "Android tablet";
  if (/macintosh/.test(u)) return "macOS";
  if (/windows/.test(u)) return "Windows";
  if (/linux/.test(u)) return "Linux";
  return "unknown";
}

export interface PromoAlertInput {
  email: string;
  name?: string | null;
  ip: string;
  userAgent: string;
  promoCode: string;
  promoActive: boolean;
  promoFound: boolean;
  promoReason?: string;
  timestamp?: string;
}

export interface MailerLike {
  sendMail: (opts: {
    from: string;
    replyTo?: string;
    to: string;
    subject: string;
    text?: string;
    html?: string;
  }) => Promise<unknown>;
}

function escapeHtml(s: string): string {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function escapeMd(s: string): string {
  // Базовое экранирование для Markdown sendMessage Telegram.
  return String(s).replace(/[`_*[\]()]/g, (m) => `\\${m}`);
}

async function sendEmailAlert(
  mailer: MailerLike | null,
  fromEmail: string,
  input: PromoAlertInput,
): Promise<boolean> {
  if (!mailer) return false;
  if (!process.env.GMAIL_APP_PASSWORD) return false;
  try {
    const subj = `🎟 Промокод "${input.promoCode}" введён при регистрации — ${input.email}`;
    const status = input.promoFound
      ? input.promoActive
        ? "✅ активен"
        : "⚠ найден, но неактивен"
      : "❌ не существует";
    const device = parseDeviceFromUa(input.userAgent);
    const ts = input.timestamp || new Date().toISOString();
    const text = [
      `Юзер пытался применить промокод при регистрации:`,
      ``,
      `Email: ${input.email}`,
      `Имя: ${input.name || "(не указано)"}`,
      `IP: ${input.ip}`,
      `Device: ${device}`,
      `User-Agent: ${input.userAgent.slice(0, 200)}`,
      ``,
      `Промокод: ${input.promoCode}`,
      `Статус: ${status}`,
      input.promoReason ? `Причина: ${input.promoReason}` : "",
      ``,
      `Время (UTC): ${ts}`,
      ``,
      `— MuzaAi auto-alert`,
    ].filter(Boolean).join("\n");
    const html = `<div style="font-family:-apple-system,sans-serif;max-width:520px;padding:24px;background:#0a0a17;border-radius:16px;border:1px solid #2a1a3e;color:#e0e0e0">
      <h2 style="color:#a78bfa;margin:0 0 12px;font-size:18px">🎟 Промокод введён при регистрации</h2>
      <table style="width:100%;font-size:14px;border-collapse:collapse">
        <tr><td style="color:#888;padding:4px 8px 4px 0;width:140px">Email</td><td><b>${escapeHtml(input.email)}</b></td></tr>
        <tr><td style="color:#888;padding:4px 8px 4px 0">Имя</td><td>${escapeHtml(input.name || "(не указано)")}</td></tr>
        <tr><td style="color:#888;padding:4px 8px 4px 0">IP</td><td><code>${escapeHtml(input.ip)}</code></td></tr>
        <tr><td style="color:#888;padding:4px 8px 4px 0">Устройство</td><td>${escapeHtml(device)}</td></tr>
        <tr><td style="color:#888;padding:4px 8px 4px 0">User-Agent</td><td style="font-size:11px;color:#aaa">${escapeHtml(input.userAgent.slice(0, 200))}</td></tr>
        <tr><td style="color:#888;padding:4px 8px 4px 0">Промокод</td><td><b style="color:#fbbf24">${escapeHtml(input.promoCode)}</b></td></tr>
        <tr><td style="color:#888;padding:4px 8px 4px 0">Статус</td><td>${escapeHtml(status)}</td></tr>
        ${input.promoReason ? `<tr><td style="color:#888;padding:4px 8px 4px 0">Причина</td><td>${escapeHtml(input.promoReason)}</td></tr>` : ""}
        <tr><td style="color:#888;padding:4px 8px 4px 0">Время</td><td style="font-family:monospace;font-size:12px">${escapeHtml(ts)}</td></tr>
      </table>
      <p style="color:#666;font-size:11px;margin-top:16px">MuzaAi auto-alert · promo-entry</p>
    </div>`;
    await mailer.sendMail({
      from: `"MuzaAi alerts" <${fromEmail}>`,
      replyTo: fromEmail,
      to: ADMIN_EMAIL,
      subject: subj,
      text,
      html,
    });
    return true;
  } catch (e) {
    try { console.warn("[promo-alert] email failed:", (e as Error)?.message || e); } catch {}
    return false;
  }
}

async function sendTelegramAlert(input: PromoAlertInput): Promise<boolean> {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const adminId = process.env.ADMIN_TELEGRAM_ID;
  if (!token || !adminId) return false;
  try {
    const status = input.promoFound
      ? input.promoActive
        ? "✅ активен"
        : "⚠ найден, но неактивен"
      : "❌ не существует";
    const device = parseDeviceFromUa(input.userAgent);
    const ts = input.timestamp || new Date().toISOString();
    const text = [
      "🎟 *Промокод при регистрации*",
      "",
      `Email: \`${escapeMd(input.email)}\``,
      `Имя: ${escapeMd(input.name || "(не указано)")}`,
      `IP: \`${escapeMd(input.ip)}\``,
      `Device: ${escapeMd(device)}`,
      "",
      `Промокод: *${escapeMd(input.promoCode)}*`,
      `Статус: ${escapeMd(status)}`,
      input.promoReason ? `Причина: ${escapeMd(input.promoReason)}` : "",
      "",
      `Время: \`${escapeMd(ts)}\``,
    ].filter(Boolean).join("\n");
    const resp = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
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
    return resp.ok;
  } catch (e) {
    try { console.warn("[promo-alert] telegram failed:", (e as Error)?.message || e); } catch {}
    return false;
  }
}

/**
 * Fire-and-forget: уведомить Босса о вводе промокода при регистрации.
 * Sequence:
 *   1. Rate-limit check (1 / promo+email / 10 мин)
 *   2. Email (если GMAIL_APP_PASSWORD есть)
 *   3. Telegram fallback (если email не доставился ИЛИ если SMTP не настроен)
 *   4. Console.warn если ни один канал не сработал
 */
export function alertPromoEntry(
  input: PromoAlertInput,
  mailer: MailerLike | null,
  fromEmail: string,
): void {
  try {
    const now = Date.now();
    const key = `${input.email.toLowerCase()}::${input.promoCode.toLowerCase()}`;
    const last = lastAlertMap.get(key) || 0;
    if (now - last < ALERT_TTL_MS) return;
    lastAlertMap.set(key, now);
    pruneOldAlerts(now);

    // Fire-and-forget chain
    (async () => {
      const emailSent = await sendEmailAlert(mailer, fromEmail, input);
      if (!emailSent) {
        const tgSent = await sendTelegramAlert(input);
        if (!tgSent) {
          try {
            console.warn(
              `[promo-alert] both channels failed — promo='${input.promoCode}' email='${input.email}'`,
            );
          } catch {}
        }
      }
    })().catch((e) => {
      try { console.warn("[promo-alert] async chain failed:", (e as Error)?.message || e); } catch {}
    });
  } catch (e) {
    try { console.warn("[promo-alert] fatal:", (e as Error)?.message || e); } catch {}
  }
}
