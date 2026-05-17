// Eugene 2026-05-17 Босс «при упоминании Ярс — алерт админу в Telegram».
// Rate-limit: 1 alert / 5 мин per session_id (чтобы при flooding не закидывать).
// Fire-and-forget — не throw'ит наружу.

import { PUBLIC_URL } from "./publicUrl";
import type { RecordYarsMentionInput } from "./yarsDetect";

// session_id → last alert timestamp (ms)
const lastAlertBySession = new Map<string, number>();
const ALERT_COOLDOWN_MS = 5 * 60 * 1000; // 5 минут

// Очистка старых записей раз в 30 мин, чтобы Map не разрастался.
function pruneOldAlerts(now: number): void {
  if (lastAlertBySession.size < 500) return;
  for (const [k, v] of lastAlertBySession) {
    if (now - v > 30 * 60 * 1000) lastAlertBySession.delete(k);
  }
}

export function sendYarsAlert(input: RecordYarsMentionInput): void {
  try {
    const token = process.env.TELEGRAM_BOT_TOKEN;
    const adminId = process.env.ADMIN_TELEGRAM_ID;
    if (!token || !adminId) return;

    const now = Date.now();
    const last = lastAlertBySession.get(input.sessionId) || 0;
    if (now - last < ALERT_COOLDOWN_MS) return;
    lastAlertBySession.set(input.sessionId, now);
    pruneOldAlerts(now);

    const safeText = String(input.text || "").slice(0, 300);
    // Минимальное экранирование «`» для inline code в Markdown.
    const escaped = safeText.replace(/`/g, "'");
    const userLabel = input.userId ? `#${input.userId}` : "guest";
    const sessionShort = String(input.sessionId).slice(0, 32);
    const adminLink = `${PUBLIC_URL}/#/admin/v304?conversation=${encodeURIComponent(sessionShort)}`;
    const body = [
      "🚨 Упоминание «Ярс»",
      "",
      `Канал: ${input.channel}`,
      `User: ${userLabel}`,
      `Сообщение: \`${escaped}\``,
      "",
      `Диалог: ${adminLink}`,
    ].join("\n");

    // Fire-and-forget.
    fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: adminId,
        text: body,
        parse_mode: "Markdown",
        disable_web_page_preview: true,
      }),
    }).catch((e) => {
      try { console.error("[YARS-ALERT]", String(e?.message || e)); } catch {}
    });
  } catch (e) {
    try { console.error("[YARS-ALERT] failed", String((e as any)?.message || e)); } catch {}
  }
}
