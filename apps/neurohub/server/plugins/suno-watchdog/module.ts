// v304 Suno Watchdog — Eugene 2026-05-08 «Реши кардинально».
//
// Глобальный мониторинг здоровья Suno-канала:
//   1. balance-poll (каждые 5 мин): GET /v1/balance → проверка >= порога
//      LOW_BALANCE_THRESHOLD_KOPEKS (по умолчанию 100000 = 1000₽)
//   2. error-rate-scan (каждую минуту): error-rate gens за 5/15 мин
//   3. при пороговых событиях — multi-channel alert админу:
//      - Telegram bot DM (TELEGRAM_BOT_TOKEN + admin.telegramId)
//      - Email (SMTP_*) на admin.email или ADMIN_EMAIL
//      - Console (red log)
//      - Incident в таблице incidents (UI 'Критично' в /admin)
//   4. dedupe: один alert на kind в окне DEDUPE_MINUTES, чтобы не
//      спамить пока проблема не решена
//   5. circuit breaker: при detected_down флаг SUNO_CIRCUIT_OPEN
//      — /api/music/generate возвращает 503, авто-retry skip-ит retries
//      пока не recovered
//
// Состояния:
//   up → low_balance → unreachable → up (auto-recovery при ok-ping)
//
// Cпек: ТЗ 2026-05-08 - кардинальное решение проблемы global-down Suno.

import { Router } from "express";
import { sql, eq, and } from "drizzle-orm";
import { db } from "../../storage";
import { users, incidents } from "@shared/schema";
import { requireAdmin } from "../../core/adminAuth";
import type { BootContext, Module } from "../../core";

const LOW_BALANCE_THRESHOLD_KOPEKS = Number(process.env.SUNO_LOW_BALANCE_KOPEKS) || 100_000; // 1000₽
const ERROR_RATE_5M_THRESHOLD = 0.8;   // 80% gens упали за 5 мин = down
const ERROR_RATE_5M_MIN_VOLUME = 3;    // минимум 3 gen чтобы делать выводы
// Eugene 2026-05-08: расширил окно до 60 мин — иначе при упорной проблеме
// (Suno лежит 2 часа, юзеры не пытаются генерить → totalGens5m=0) watchdog
// показывает «up» хотя сервис фактически down. 60-мин окно держит память.
const ERROR_RATE_60M_THRESHOLD = 0.7;  // 70% за час при volume>=5 = down
const ERROR_RATE_60M_MIN_VOLUME = 5;
const DEDUPE_MINUTES = 30;             // не повторять алёрт раньше 30 мин
const PING_TIMEOUT_MS = 5_000;

interface WatchdogState {
  status: "up" | "low_balance" | "down" | "unknown";
  balanceKopeks: number | null;
  balanceCheckedAt: string | null;
  balanceError: string | null;
  errorRate5m: number; // 0..1
  errorRate15m: number;
  errorRate60m: number; // Eugene 2026-05-08: окно для упорных проблем
  totalGens5m: number;
  errorGens5m: number;
  totalGens60m: number;
  errorGens60m: number;
  lastSunoPingAt: string | null;
  lastAlerts: Record<string, string>; // kind → ISO ts
  circuitOpen: boolean;
  circuitOpenSince: string | null;
  // Eugene 2026-05-08: счётчики consecutive failures для подавления false-positive
  // alerts от транзиентных network blips (DNS hiccup, packet loss).
  consecutiveBalanceFailures: number;
  consecutiveBalanceSuccesses: number;
}

const STATE: WatchdogState = {
  status: "unknown",
  balanceKopeks: null,
  balanceCheckedAt: null,
  balanceError: null,
  errorRate5m: 0,
  errorRate15m: 0,
  errorRate60m: 0,
  totalGens5m: 0,
  errorGens5m: 0,
  totalGens60m: 0,
  errorGens60m: 0,
  lastSunoPingAt: null,
  lastAlerts: {},
  circuitOpen: false,
  circuitOpenSince: null,
  consecutiveBalanceFailures: 0,
  consecutiveBalanceSuccesses: 0,
};

let bootRefs: { eventBus: BootContext["eventBus"]; logger: BootContext["logger"] } | null = null;

// Экспортируется для generation-agent и /api/music/generate.
// При circuit_open=true — новые генерации отклоняются, авто-retry приостанавливается.
export function isSunoCircuitOpen(): boolean {
  return STATE.circuitOpen;
}

export function getWatchdogState(): Readonly<WatchdogState> {
  return STATE;
}

// ============== ALERT DISPATCH ==============

interface AlertInput {
  kind: string;             // dedupe key, e.g. "suno_low_balance"
  severity: "critical" | "warning";
  title: string;            // короткий заголовок (для tg / subject)
  body: string;             // тело сообщения (multi-line ok)
  resolution?: string;      // что делать
}

function shouldDedupe(kind: string): boolean {
  const last = STATE.lastAlerts[kind];
  if (!last) return false;
  const ageMin = (Date.now() - new Date(last).getTime()) / 60000;
  return ageMin < DEDUPE_MINUTES;
}

async function sendTelegramAlert(text: string, chatId: string): Promise<void> {
  const token = process.env.TELEGRAM_BOT_TOKEN || "8364453587:AAHp-Rujm1WU3hm6F3Lq0rmPp7iGHWzmTa0";
  if (!token || !chatId) return;
  try {
    const r = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: chatId,
        text,
        parse_mode: "HTML",
        disable_web_page_preview: true,
      }),
      signal: AbortSignal.timeout(8000),
    });
    if (!r.ok) {
      const errText = await r.text().catch(() => "");
      bootRefs?.logger.error("[suno-watchdog] telegram send failed", { status: r.status, errText: errText.slice(0, 200) });
    }
  } catch (e) {
    bootRefs?.logger.error("[suno-watchdog] telegram send threw", { error: e instanceof Error ? e.message : String(e) });
  }
}

async function sendEmailAlert(subject: string, body: string, to: string): Promise<void> {
  const host = process.env.SMTP_HOST;
  const user = process.env.SMTP_USER;
  const pass = process.env.SMTP_PASS;
  if (!host || !user || !pass || !to) return;
  try {
    const nodemailer: any = (await import("nodemailer")).default;
    const transporter = nodemailer.createTransport({
      host,
      port: Number(process.env.SMTP_PORT) || 465,
      secure: (Number(process.env.SMTP_PORT) || 465) === 465,
      auth: { user, pass },
    });
    await transporter.sendMail({
      from: process.env.SMTP_FROM || `MuziAI Watchdog <${user}>`,
      to,
      subject,
      text: body,
    });
  } catch (e) {
    bootRefs?.logger.error("[suno-watchdog] smtp send failed", { error: e instanceof Error ? e.message : String(e) });
  }
}

function upsertIncident(input: { kind: string; severity: "critical" | "warning"; title: string; rootCause: string; resolution: string; evidence?: any }): void {
  try {
    const exists = db.select().from(incidents).where(eq(incidents.dedupeKey, input.kind)).get();
    const evidenceStr = input.evidence ? JSON.stringify(input.evidence).slice(0, 4000) : null;
    if (exists) {
      db.update(incidents).set({
        title: input.title,
        rootCause: input.rootCause,
        resolution: input.resolution,
        severity: input.severity,
        evidence: evidenceStr,
        lastSeenAt: new Date().toISOString(),
        occurrences: (exists.occurrences ?? 1) + 1,
        status: "open",
        resolvedAt: null,
      }).where(eq(incidents.id, exists.id)).run();
    } else {
      db.insert(incidents).values({
        kind: input.kind,
        severity: input.severity,
        title: input.title,
        rootCause: input.rootCause,
        resolution: input.resolution,
        evidence: evidenceStr,
        status: "open",
        dedupeKey: input.kind,
      }).run();
    }
  } catch (e) {
    bootRefs?.logger.error("[suno-watchdog] incident upsert failed", { error: e instanceof Error ? e.message : String(e) });
  }
}

function autoResolveIncident(kind: string, reason: string): void {
  try {
    const open = db.select().from(incidents).where(and(eq(incidents.dedupeKey, kind), eq(incidents.status, "open"))).get();
    if (!open) return;
    db.update(incidents).set({
      status: "auto-resolved",
      resolvedAt: new Date().toISOString(),
      resolution: open.resolution ? `${open.resolution}\n\n[resolved] ${reason}` : `[resolved] ${reason}`,
    }).where(eq(incidents.id, open.id)).run();
  } catch {}
}

async function notifyAdmin(input: AlertInput): Promise<void> {
  if (shouldDedupe(input.kind)) return;
  STATE.lastAlerts[input.kind] = new Date().toISOString();

  const sev = input.severity === "critical" ? "🔴 КРИТИЧНО" : "⚠️ ВНИМАНИЕ";
  const tgText = `${sev}\n<b>${input.title}</b>\n\n${input.body}${input.resolution ? `\n\n<b>Что делать:</b>\n${input.resolution}` : ""}\n\n<i>MuziAi · Suno Watchdog</i>`;
  const emailBody = `${sev}\n\n${input.title}\n\n${input.body}${input.resolution ? `\n\nЧто делать:\n${input.resolution}` : ""}\n\n— MuziAi Suno Watchdog`;

  console.log(`\x1b[31m[SUNO-ALERT/${input.severity.toUpperCase()}]\x1b[0m ${input.title} — ${input.body.slice(0, 200)}`);
  bootRefs?.logger.info("suno-watchdog alert", { kind: input.kind, severity: input.severity, title: input.title });

  // Incident в DB (UI 'Критично' это покажет)
  upsertIncident({
    kind: input.kind,
    severity: input.severity,
    title: input.title,
    rootCause: input.body,
    resolution: input.resolution || "Открой /admin/v304 → Suno Watchdog для деталей",
    evidence: { state: STATE },
  });

  // Найти админских юзеров (с telegram_id для tg, с email для smtp)
  const admins = db.select().from(users).where(eq(users.role, "admin")).all();
  const adminTgIds = admins.map((u) => u.telegramId).filter(Boolean) as string[];
  const adminEmails = admins.map((u) => u.email).filter((e) => !!e && !e.endsWith("@telegram.MuziAi.ru")) as string[];

  // ENV-override: ADMIN_TELEGRAM_ID и ADMIN_EMAIL дополняют список
  if (process.env.ADMIN_TELEGRAM_ID) adminTgIds.push(process.env.ADMIN_TELEGRAM_ID);
  if (process.env.ADMIN_EMAIL) adminEmails.push(process.env.ADMIN_EMAIL);

  await Promise.allSettled([
    ...adminTgIds.map((id) => sendTelegramAlert(tgText, id)),
    ...adminEmails.map((e) => sendEmailAlert(`[MuziAi] ${input.title}`, emailBody, e)),
  ]);
}

// ============== HEALTH POLLERS ==============

async function pollBalance(): Promise<void> {
  const apiKey = process.env.GPTUNNEL_API_KEY;
  if (!apiKey) {
    STATE.balanceError = "GPTUNNEL_API_KEY не установлен";
    return;
  }
  // Eugene 2026-05-08: retry с экспонентой ВНУТРИ одного pollBalance.
  // Закрывает класс false-positive alerts от транзиентных DNS/packet-loss.
  // 3 попытки: 0ms / 3sec / 8sec → суммарно ~11 сек на edge cases.
  const tryFetch = async (): Promise<{ ok: boolean; status?: number; data?: any; error?: string }> => {
    for (let attempt = 0; attempt < 3; attempt++) {
      if (attempt > 0) await new Promise((r) => setTimeout(r, attempt === 1 ? 3000 : 8000));
      try {
        const r = await fetch("https://gptunnel.ru/v1/balance", {
          headers: { Authorization: apiKey },
          signal: AbortSignal.timeout(PING_TIMEOUT_MS),
        });
        if (!r.ok) return { ok: false, status: r.status, error: `HTTP ${r.status}` };
        const data = await r.json().catch(() => null);
        return { ok: true, data };
      } catch (e) {
        if (attempt === 2) return { ok: false, error: e instanceof Error ? e.message : String(e) };
        // иначе попробуем ещё раз
      }
    }
    return { ok: false, error: "exhausted" };
  };

  try {
    const result = await tryFetch();
    if (!result.ok && result.status) {
      // HTTP ошибка от GPTunnel (не network) — это ответ сервера
      STATE.balanceError = result.error || `HTTP ${result.status}`;
      STATE.lastSunoPingAt = new Date().toISOString();
      STATE.consecutiveBalanceFailures += 1;
      STATE.consecutiveBalanceSuccesses = 0;
      if (result.status === 401 || result.status === 403) {
        await notifyAdmin({
          kind: "suno_invalid_key",
          severity: "critical",
          title: "GPTunnel ключ невалиден или отозван",
          body: `GET /v1/balance вернул HTTP ${result.status}. Все генерации Suno падают до тех пор пока ключ не обновлён.`,
          resolution: "Открой gptunnel.ru → выпусти свежий ключ → /admin/v304 → 🔑 Секреты → ротация GPTUNNEL_API_KEY → pm2 restart neurohub --update-env",
        });
      }
      return;
    }
    if (!result.ok) {
      // Network failure после 3-х попыток — но всё равно подождём 3
      // последовательных циклов (15 мин) до alert'а. Локальные blips
      // не должны спамить.
      STATE.balanceError = result.error || "network";
      STATE.lastSunoPingAt = new Date().toISOString();
      STATE.consecutiveBalanceFailures += 1;
      STATE.consecutiveBalanceSuccesses = 0;
      console.log(`\x1b[33m[suno-watchdog]\x1b[0m balance unreachable (attempt ${STATE.consecutiveBalanceFailures}, error=${STATE.balanceError})`);
      if (STATE.consecutiveBalanceFailures >= 3) {
        await notifyAdmin({
          kind: "suno_unreachable",
          severity: "critical",
          title: "GPTunnel недоступен — стабильно (3+ циклов)",
          body: `Не могу достучаться до gptunnel.ru/v1/balance уже ${STATE.consecutiveBalanceFailures} циклов подряд: ${STATE.balanceError}. Все Suno-запросы падают.`,
          resolution: "Проверь VPS network: curl -m 10 https://gptunnel.ru/v1/balance -H \"Authorization: $GPTUNNEL_API_KEY\". Firewall/DNS/route на VPS.",
        });
      }
      return;
    }
    const data = result.data;
    // GPTunnel возвращает balance в рублях (float). Переводим в копейки.
    const rubles = typeof data?.balance === "number" ? data.balance : Number(data?.balance ?? 0);
    const kopeks = Math.round(rubles * 100);
    STATE.balanceKopeks = kopeks;
    STATE.balanceCheckedAt = new Date().toISOString();
    STATE.balanceError = null;
    STATE.lastSunoPingAt = STATE.balanceCheckedAt;
    // Reset failure counter, инкремент success — auto-resolve если был alert
    if (STATE.consecutiveBalanceFailures > 0) {
      console.log(`\x1b[32m[suno-watchdog]\x1b[0m balance recovered after ${STATE.consecutiveBalanceFailures} failures`);
      autoResolveIncident("suno_unreachable", `сеть восстановлена: ${(kopeks / 100).toFixed(2)}₽`);
    }
    STATE.consecutiveBalanceFailures = 0;
    STATE.consecutiveBalanceSuccesses += 1;

    if (kopeks < LOW_BALANCE_THRESHOLD_KOPEKS) {
      await notifyAdmin({
        kind: "suno_low_balance",
        severity: "critical",
        title: `Баланс GPTunnel ниже порога: ${(kopeks / 100).toFixed(2)}₽`,
        body: `Текущий баланс: ${(kopeks / 100).toFixed(2)}₽ (порог: ${(LOW_BALANCE_THRESHOLD_KOPEKS / 100).toFixed(0)}₽). Один Suno-pair стоит ~18₽ — осталось ~${Math.floor(kopeks / 1800)} генераций. После 0₽ юзеры будут получать рефанды.`,
        resolution: "Пополни gptunnel.ru → /admin/v304 → 💰 Финансы для проверки расхода",
      });
    } else {
      autoResolveIncident("suno_low_balance", `баланс восстановлен: ${(kopeks / 100).toFixed(2)}₽`);
      autoResolveIncident("suno_invalid_key", "GPTunnel /balance отвечает 200");
    }
  } catch (e) {
    // unexpected (parsing JSON failed etc.) — лог, не alert
    console.error("[suno-watchdog] pollBalance unexpected:", e);
  }
}

function scanGenerationErrorRate(): void {
  // Eugene 2026-05-08: считаем ТОЛЬКО Suno-системные ошибки.
  // Исключаем:
  //   - moderation (code 1001 / sensitive / 'модерац') — это user content
  //   - auto-recovered (style.recoveredAfterTimeout=true) — статус 'done',
  //     уже не error
  // Иначе watchdog ложно срабатывает на user-input проблемах.
  const errorFilter = sql`
    AND (error_reason IS NULL
         OR (error_reason NOT LIKE '%модерац%'
             AND error_reason NOT LIKE '%сенситив%'
             AND error_reason NOT LIKE '%sensitive%'
             AND error_reason NOT LIKE '%1001%'))
  `;
  // Берём gens за последние 5/15/60 мин и считаем error-rate
  const r5: any = db.get(sql`
    SELECT
      COUNT(*) AS total,
      SUM(CASE WHEN status = 'error' ${errorFilter} THEN 1 ELSE 0 END) AS errors
    FROM generations
    WHERE created_at > datetime('now', '-5 minutes')
      AND type = 'music'
  `);
  const r15: any = db.get(sql`
    SELECT
      COUNT(*) AS total,
      SUM(CASE WHEN status = 'error' ${errorFilter} THEN 1 ELSE 0 END) AS errors
    FROM generations
    WHERE created_at > datetime('now', '-15 minutes')
      AND type = 'music'
  `);
  const r60: any = db.get(sql`
    SELECT
      COUNT(*) AS total,
      SUM(CASE WHEN status = 'error' ${errorFilter} THEN 1 ELSE 0 END) AS errors
    FROM generations
    WHERE created_at > datetime('now', '-60 minutes')
      AND type = 'music'
  `);

  STATE.totalGens5m = r5?.total ?? 0;
  STATE.errorGens5m = r5?.errors ?? 0;
  STATE.errorRate5m = STATE.totalGens5m > 0 ? STATE.errorGens5m / STATE.totalGens5m : 0;
  const total15 = r15?.total ?? 0;
  STATE.errorRate15m = total15 > 0 ? (r15?.errors ?? 0) / total15 : 0;
  STATE.totalGens60m = r60?.total ?? 0;
  STATE.errorGens60m = r60?.errors ?? 0;
  STATE.errorRate60m = STATE.totalGens60m > 0 ? STATE.errorGens60m / STATE.totalGens60m : 0;
}

async function evaluateState(): Promise<void> {
  const previousStatus = STATE.status;

  // Status priority: down > low_balance > up
  // Окна: 5-мин (свежий burst) ИЛИ 60-мин (упорная проблема)
  const high5m = STATE.totalGens5m >= ERROR_RATE_5M_MIN_VOLUME &&
                 STATE.errorRate5m >= ERROR_RATE_5M_THRESHOLD;
  const high60m = STATE.totalGens60m >= ERROR_RATE_60M_MIN_VOLUME &&
                  STATE.errorRate60m >= ERROR_RATE_60M_THRESHOLD;
  if (STATE.balanceError && STATE.balanceError !== "GPTUNNEL_API_KEY не установлен") {
    STATE.status = "down";
  } else if (high5m || high60m) {
    STATE.status = "down";
  } else if (
    STATE.balanceKopeks !== null &&
    STATE.balanceKopeks < LOW_BALANCE_THRESHOLD_KOPEKS
  ) {
    STATE.status = "low_balance";
  } else if (STATE.balanceKopeks !== null) {
    STATE.status = "up";
  }

  // Circuit breaker:
  //   open  при status='down' (баланс есть/нет неважно — Suno просто не работает)
  //   close при возврате в 'up' стабильно
  const wasOpen = STATE.circuitOpen;
  if (STATE.status === "down") {
    if (!STATE.circuitOpen) {
      STATE.circuitOpen = true;
      STATE.circuitOpenSince = new Date().toISOString();
    }
  } else if (STATE.status === "up") {
    if (STATE.circuitOpen) {
      STATE.circuitOpen = false;
      STATE.circuitOpenSince = null;
    }
  }

  // High-error-rate alert (отдельный, не от баланса)
  if (high5m || high60m) {
    const winLabel = high5m ? `5 мин (${STATE.errorGens5m}/${STATE.totalGens5m})`
                            : `60 мин (${STATE.errorGens60m}/${STATE.totalGens60m})`;
    const ratePct = high5m ? (STATE.errorRate5m * 100).toFixed(0)
                           : (STATE.errorRate60m * 100).toFixed(0);
    await notifyAdmin({
      kind: "suno_high_error_rate",
      severity: "critical",
      title: `Suno: error-rate ${ratePct}% за ${high5m ? "5 мин" : "60 мин"}`,
      body: `За ${winLabel} большинство генераций упали. Похоже, Suno глобально не работает. Auto-retry приостановлен (circuit open).`,
      resolution: "Дождись восстановления (Watchdog auto-recovers) или обнови ключ если проблема в нём. /admin/v304 → Suno Watchdog для real-time стейта",
    });
  } else if (
    (STATE.totalGens5m >= ERROR_RATE_5M_MIN_VOLUME && STATE.errorRate5m < 0.3) ||
    (STATE.totalGens60m >= ERROR_RATE_60M_MIN_VOLUME && STATE.errorRate60m < 0.3)
  ) {
    autoResolveIncident("suno_high_error_rate", `error-rate стабилизировался`);
  }

  // Если стейт сменился up→down или обратно — лог
  if (previousStatus !== STATE.status) {
    bootRefs?.logger.info(`[suno-watchdog] status: ${previousStatus} → ${STATE.status}`, {
      balance: STATE.balanceKopeks,
      errorRate5m: STATE.errorRate5m,
      circuit: STATE.circuitOpen,
    });
  }
  if (wasOpen !== STATE.circuitOpen) {
    bootRefs?.eventBus.emit(
      STATE.circuitOpen ? "suno.circuit.open" : "suno.circuit.close",
      { since: STATE.circuitOpenSince },
      "suno-watchdog",
    );
  }
}

// ============== ENDPOINTS ==============

const router = Router();

router.get("/health", requireAdmin, (_req, res) => {
  res.json({
    data: {
      ...STATE,
      thresholdKopeks: LOW_BALANCE_THRESHOLD_KOPEKS,
      thresholdRubles: LOW_BALANCE_THRESHOLD_KOPEKS / 100,
    },
    error: null,
  });
});

router.post("/test-alert", requireAdmin, async (_req, res) => {
  // Сбрасываем dedupe чтобы тестовый алёрт прошёл
  delete STATE.lastAlerts["suno_test"];
  await notifyAdmin({
    kind: "suno_test",
    severity: "warning",
    title: "Тестовый алёрт Watchdog",
    body: "Это тест каналов оповещения. Если ты это видишь в Telegram/email — alerts работают.",
    resolution: "Игнорируй и закрой инцидент в /admin/v304 → Критично",
  });
  res.json({ data: { sent: true }, error: null });
});

router.post("/reset-circuit", requireAdmin, (_req, res) => {
  const wasOpen = STATE.circuitOpen;
  STATE.circuitOpen = false;
  STATE.circuitOpenSince = null;
  bootRefs?.logger.info("[suno-watchdog] circuit manually reset", { wasOpen });
  res.json({ data: { wasOpen, nowOpen: false }, error: null });
});

router.get("/page", (_req, res) => {
  // Перенаправляем на новый /diag (избегаем cache старого HTML)
  res.redirect(302, "/api/admin/v304/suno-watchdog/diag");
});

// Eugene 2026-05-08 «Режим Бог реши кардинально»: новый URL = гарантированно
// свежий HTML, никакого старого кеша. Простой ES5-compat JS, никаких ?./?? —
// работает на iOS Safari ниже 13.4 и старых Android браузерах.
router.get("/diag", (_req, res) => {
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate, max-age=0");
  res.setHeader("Pragma", "no-cache");
  res.setHeader("Expires", "0");
  res.send(`<!doctype html>
<html lang="ru"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Suno Watchdog · Диагностика</title>
<style>
  body { font: 14px -apple-system,Segoe UI,sans-serif; background:#0b0b14; color:#e6e6f0; margin:0; padding:20px; }
  h1 { font-size:20px; margin:0 0 16px; color:#a78bfa; }
  .panel { background:#16162b; border:1px solid #2a2a4a; border-radius:12px; padding:16px; margin-bottom:12px; }
  .ok { color:#4ade80; } .warn { color:#fbbf24; } .err { color:#ef4444; }
  pre { background:#0e0e1c; padding:12px; border-radius:8px; overflow:auto; font:12px ui-monospace,Menlo,monospace; max-height:600px; }
  button { background:linear-gradient(90deg,#7c3aed,#ec4899); color:#fff; border:0; padding:10px 18px; border-radius:8px; font-weight:600; cursor:pointer; margin-right:8px; }
  button:disabled { opacity:.5; cursor:not-allowed; }
  .label { color:#9ca3af; font-size:12px; text-transform:uppercase; letter-spacing:1px; margin-bottom:6px; }
  .row { display:flex; gap:12px; flex-wrap:wrap; margin-bottom:8px; }
  .row > div { flex:1; min-width:160px; }
  .big { font-size:18px; font-weight:600; }
  .rec li { margin:6px 0; }
  a { color:#a78bfa; }
</style></head><body>
<h1>🔬 Suno Watchdog · Диагностика</h1>

<div class="panel">
  <div class="label">Статус</div>
  <div id="status" class="big">Готов — выбери тест ниже</div>
  <div style="margin-top:12px">
    <button onclick="runDiag(false)">🔄 Проверить Suno (бесплатно)</button>
    <button onclick="runDiag(true)">🎵 Полный тест с Suno (~18₽)</button>
  </div>
</div>

<div id="systemTest"></div>
<div id="summary"></div>

<div class="panel">
  <div class="label">Полный JSON-отчёт</div>
  <pre id="raw">…</pre>
</div>

<script>
// Staging hostname → GET идёт без логина. Если есть token — добавим Bearer.
const token = localStorage.getItem("token");
const isStaging = location.hostname.includes("clone.muziai.ru") || location.hostname === "localhost" || location.hostname === "127.0.0.1";
if (!token && !isStaging) {
  document.getElementById("status").innerHTML = '<span class="err">Не залогинен.</span> Открой <a href="/#/login">/#/login</a> и вернись сюда.';
  document.getElementById("btnGet").disabled = true;
  document.getElementById("btnPost").disabled = true;
}
// На staging: показываем все кнопки даже без token
// (бэкенд разрешает hostname=clone.muziai.ru без admin auth)

// ES5-compat (для старых iOS Safari). Никаких ?., ??, async/await.
function runDiag(includeTest) {
  var statusEl = document.getElementById("status");
  statusEl.textContent = includeTest ? "Делаю реальный запрос на Suno (до 35 сек)…" : "Опрашиваю Suno (до 20 сек)…";
  var ctrl = new AbortController();
  var timeoutMs = includeTest ? 35000 : 20000;
  var timer = setTimeout(function() { ctrl.abort(); }, timeoutMs);
  var headers = { "Content-Type": "application/json" };
  if (token) headers["Authorization"] = "Bearer " + token;
  fetch("/api/admin/v304/suno-watchdog/full-diagnose", {
    method: includeTest ? "POST" : "GET",
    headers: headers,
    signal: ctrl.signal,
  }).then(function(r) {
    clearTimeout(timer);
    return r.json().then(function(j) { return { r: r, j: j }; });
  }).then(function(out) {
    if (!out.r.ok || out.j.error) throw new Error(out.j.error || ("HTTP " + out.r.status));
    renderDiag(out.j.data);
  }).catch(function(e) {
    var msg = e && e.name === "AbortError" ? "Server timeout (>" + (timeoutMs/1000) + "s)" : (e && e.message ? e.message : String(e));
    statusEl.innerHTML = '<span class="err">Ошибка: ' + msg + '</span>';
  });
}

function renderDiag(d) {
  var bal = d.balance || {};
  var key = d.apiKey || {};
  var ks = (d.keyScope && d.keyScope.mediaCreate) || {};
  var test = d.testRequest || {};
  var html = '';

  // Сводка
  var ok = bal.ok && key.present;
  document.getElementById("status").innerHTML = ok ? '<span class="ok">● Ключ работает</span>' : '<span class="err">● Проблема с ключом</span>';

  html += '<div class="panel"><div class="row">';
  html += '<div><div class="label">API key</div><div class="big">' + (key.present ? '<span class="ok">' + key.prefix + '</span> (' + key.length + ' chars)' : '<span class="err">отсутствует</span>') + '</div></div>';
  html += '<div><div class="label">Balance</div><div class="big ' + (bal.ok ? 'ok' : 'err') + '">' + (bal.ok ? bal.balance + ' ₽ · ' + bal.ms + ' мс' : 'error · ' + (bal.error || '?')) + '</div></div>';
  html += '</div></div>';

  // Scope
  if (ks.status) {
    var scopeOk = (ks.body && (ks.body.code === 3 || ks.body.code === 0));
    html += '<div class="panel"><div class="label">Scope ключа /media/create</div>';
    html += '<div class="big ' + (scopeOk ? "ok" : "err") + '">' + (scopeOk ? "✅" : "❌") + ' HTTP ' + ks.status + ' · code=' + ((ks.body && ks.body.code) || '?') + '</div>';
    if (ks.hint) html += '<div style="margin-top:8px">' + ks.hint + '</div>';
    html += '</div>';
  }

  // Real Suno test
  if (test && !test.skipped) {
    var tCls = test.ok ? "ok" : "err";
    html += '<div class="panel"><div class="label">Live тест /media/create</div>';
    html += '<div class="big ' + tCls + '">' + (test.ok ? '✅ taskId=' + test.taskId + ' (' + test.ms + ' мс)' : '❌ ' + (test.error || '?') + ' (' + (test.ms || '?') + ' мс)') + '</div></div>';
  }

  // Recent errors breakdown
  if (d.errorBreakdown) {
    var keys = Object.keys(d.errorBreakdown);
    if (keys.length > 0) {
      keys.sort(function(a, b) { return d.errorBreakdown[b] - d.errorBreakdown[a]; });
      html += '<div class="panel"><div class="label">Ошибки за 24 ч</div>';
      keys.forEach(function(k) { html += '<div>' + k + ': <b>' + d.errorBreakdown[k] + '</b></div>'; });
      html += '</div>';
    }
  }

  // Recommendations
  if (d.recommendations && d.recommendations.length) {
    html += '<div class="panel"><div class="label">Рекомендации</div><ul style="margin:0;padding-left:20px">';
    d.recommendations.forEach(function(r) { html += '<li style="margin:4px 0">' + r + '</li>'; });
    html += '</ul></div>';
  }

  document.getElementById("summary").innerHTML = html;
  document.getElementById("raw").textContent = JSON.stringify(d, null, 2);
}

// Никакого авто-fetch'а — Eugene сам жмёт кнопку.
document.getElementById("status").innerHTML = '<span class="ok">Готов</span> — выбери тест ниже.';
</script>
</body></html>`);
});

router.post("/poll-now", requireAdmin, async (_req, res) => {
  await pollBalance();
  scanGenerationErrorRate();
  await evaluateState();
  res.json({ data: STATE, error: null });
});

// Полная диагностика — Eugene 2026-05-08: «будь богом в этом вопросе».
// GET  /full-diagnose — без test-запроса (бесплатно, открывается в браузере)
// POST /full-diagnose — с реальным test-запросом (~18₽, проверяет Suno end-to-end)
async function runFullDiagnose(includeTestRequest: boolean) {
  const report: any = {
    timestamp: new Date().toISOString(),
    apiKey: { present: false, length: 0, prefix: null },
    balance: { ok: false, ms: null, status: null, balance: null, error: null },
    keyScope: { mediaCreate: { reachable: false, ms: null, status: null, body: null, hint: null } },
    testRequest: includeTestRequest ? { ok: false, ms: null, status: null, taskId: null, error: null, body: null }
                                    : { skipped: true, hint: "POST /full-diagnose чтобы запустить реальный test-запрос (~18₽)" },
    recentErrors: [] as any[],
    errorBreakdown: {} as Record<string, number>,
    watchdog: { ...STATE },
    recommendations: [] as string[],
  };

  // 1. API key check
  const apiKey = process.env.GPTUNNEL_API_KEY;
  if (apiKey) {
    report.apiKey = {
      present: true,
      length: apiKey.length,
      prefix: apiKey.slice(0, 4) + "…" + apiKey.slice(-4),
    };
  } else {
    report.recommendations.push("⚠️ GPTUNNEL_API_KEY НЕ установлен в env. Все Suno-запросы упадут.");
  }

  // 2. Balance ping
  if (apiKey) {
    const t0 = Date.now();
    try {
      const r = await fetch("https://gptunnel.ru/v1/balance", {
        headers: { Authorization: apiKey },
        signal: AbortSignal.timeout(5_000),
      });
      report.balance.ms = Date.now() - t0;
      report.balance.status = r.status;
      if (r.ok) {
        const data: any = await r.json();
        report.balance.ok = true;
        report.balance.balance = data?.balance;
      } else {
        report.balance.error = `HTTP ${r.status}`;
        if (r.status === 401 || r.status === 403) {
          report.recommendations.push(`🔑 Ключ невалиден (HTTP ${r.status}). Ротация: gptunnel.ru → новый ключ → /admin → 🔑 Секреты`);
        }
      }
    } catch (e) {
      report.balance.ms = Date.now() - t0;
      report.balance.error = e instanceof Error ? e.message : String(e);
      report.recommendations.push(`🌐 GPTunnel недоступен: ${report.balance.error}. Проверь VPS network: curl -m 10 https://gptunnel.ru/v1/balance -H "Authorization: \\$GPTUNNEL_API_KEY"`);
    }
  }

  // 3. Scope-проверка ключа на /media/create БЕЗ charge'а:
  //    PROBE A — пустой body: GPTunnel вернёт 200 + code:3 (валидация),
  //              со списком ВСЕХ моделей. Это доказывает что ключ принимается.
  //    PROBE B — { model: "suno" } без других полей: получим schema
  //              ошибки специфично для Suno → видим что Suno требует.
  //    GPTunnel в случае ошибки валидации возвращает HTTP 200 + body.code != 0.
  //    Реальный успех = body.code == 0 + body.id присутствует.
  if (apiKey) {
    // PROBE A: пустой body
    const t0 = Date.now();
    try {
      const r = await fetch("https://gptunnel.ru/v1/media/create", {
        method: "POST",
        headers: { Authorization: apiKey, "Content-Type": "application/json" },
        body: JSON.stringify({}),
        signal: AbortSignal.timeout(5_000),
      });
      report.keyScope.mediaCreate.ms = Date.now() - t0;
      report.keyScope.mediaCreate.status = r.status;
      const text = await r.text();
      let body: any;
      try { body = JSON.parse(text); } catch { body = { raw: text.slice(0, 500) }; }
      report.keyScope.mediaCreate.body = body;
      report.keyScope.mediaCreate.reachable = r.status > 0;
      const valid = (r.status === 200 || r.status === 400 || r.status === 422)
                    && (body?.code === 3 || body?.issues || body?.message?.includes("schema"));
      if (r.status === 401 || r.status === 403) {
        report.keyScope.mediaCreate.hint = "🚫 Ключ НЕ имеет media-scope. Нужен новый ключ.";
        report.recommendations.push("🔑 Ключ без media-scope. На gptunnel.ru → выпусти НОВЫЙ ключ.");
      } else if (valid) {
        // Извлекаем список моделей из validation issues
        const modelIssue = (body?.issues || []).find((i: any) => i.path?.[0] === "model");
        const sunoModels = modelIssue?.expected
          ? (modelIssue.expected as string).split(" | ").map((s: string) => s.replace(/'/g, "")).filter((s: string) => s.includes("suno"))
          : null;
        report.keyScope.mediaCreate.sunoModelsAvailable = sunoModels;
        report.keyScope.mediaCreate.hint = `✅ Ключ принят /media/create. Validation отработала (code:3). Suno-модели в списке: ${sunoModels?.join(", ") || "?"}. Значит «Internal server error» в реальных gens идёт от Suno backend ПОСЛЕ принятия запроса.`;
      } else if (r.status === 500 || r.status === 502 || r.status === 503) {
        report.keyScope.mediaCreate.hint = `⚠️ /media/create вернул ${r.status} на пустой body. GPTunnel proxy сам сломан.`;
        report.recommendations.push(`🌐 GPTunnel proxy отвечает ${r.status}. Связаться с их поддержкой.`);
      } else {
        report.keyScope.mediaCreate.hint = `❓ HTTP ${r.status}, body.code=${body?.code}. Не классифицирован.`;
      }
    } catch (e) {
      report.keyScope.mediaCreate.ms = Date.now() - t0;
      report.keyScope.mediaCreate.hint = `❌ Не достучался до /media/create: ${e instanceof Error ? e.message : String(e)}`;
    }

    // PROBE B: { model: "suno" } — увидим schema requirements специфично для Suno
    if (report.keyScope.mediaCreate.reachable && (report.keyScope.mediaCreate.body?.code === 3)) {
      try {
        const r2 = await fetch("https://gptunnel.ru/v1/media/create", {
          method: "POST",
          headers: { Authorization: apiKey, "Content-Type": "application/json" },
          body: JSON.stringify({ model: "suno" }),
          signal: AbortSignal.timeout(5_000),
        });
        const text2 = await r2.text();
        let body2: any;
        try { body2 = JSON.parse(text2); } catch { body2 = { raw: text2.slice(0, 500) }; }
        report.keyScope.sunoSchema = {
          status: r2.status,
          code: body2?.code,
          message: body2?.message,
          requiredFields: (body2?.issues || []).map((i: any) => ({
            path: (i.path || []).join("."),
            expected: i.expected,
            message: i.message,
          })),
        };
      } catch (e) {
        report.keyScope.sunoSchema = { error: e instanceof Error ? e.message : String(e) };
      }
    }
  }

  // 4. Тестовый /media/create РЕАЛЬНЫЙ — только если includeTestRequest=true
  if (includeTestRequest && apiKey && report.balance.ok) {
    const testBody = { model: "suno", prompt: "Тест, короткая весёлая песня на русском" };
    report.testRequest.body = testBody;
    const t0 = Date.now();
    try {
      const r = await fetch("https://gptunnel.ru/v1/media/create", {
        method: "POST",
        headers: { Authorization: apiKey, "Content-Type": "application/json" },
        body: JSON.stringify(testBody),
        signal: AbortSignal.timeout(30_000),
      });
      report.testRequest.ms = Date.now() - t0;
      report.testRequest.status = r.status;
      const text = await r.text();
      let data: any;
      try { data = JSON.parse(text); } catch { data = { raw: text.slice(0, 500) }; }
      if (r.ok && data?.id) {
        report.testRequest.ok = true;
        report.testRequest.taskId = data.id;
        report.recommendations.push(`✅ Тестовый запрос принят. taskId=${data.id}. Подожди 3-4 мин и пройдись по /api/music/status/${data.id} — если done, Suno работает.`);
      } else {
        report.testRequest.error = data?.message || data?.error?.message || `HTTP ${r.status}`;
        report.testRequest.body = data;
        report.recommendations.push(`❌ /media/create вернул ошибку: ${report.testRequest.error}. Это и есть причина падений генераций.`);
      }
    } catch (e) {
      report.testRequest.ms = Date.now() - t0;
      report.testRequest.error = e instanceof Error ? e.message : String(e);
      report.recommendations.push(`❌ /media/create timeout/network: ${report.testRequest.error}. Возможно gptunnel.ru тормозит — это причина 'timeout > 30 min' в gens.`);
    }
  }

  // 4. Последние 20 errored gens с классификацией
  const recentErrors: any = db.all(sql`
    SELECT id, user_id as userId, error_reason as errorReason, created_at as createdAt, cost
    FROM generations
    WHERE status = 'error' AND type = 'music'
      AND created_at > datetime('now', '-24 hours')
    ORDER BY id DESC
    LIMIT 20
  `);
  report.recentErrors = (recentErrors || []).map((g: any) => ({
    id: g.id,
    userId: g.userId,
    cost: g.cost,
    errorReason: (g.errorReason || "?").slice(0, 200),
    createdAt: g.createdAt,
  }));

  // 5. Распределение ошибок (классификация)
  const breakdown: Record<string, number> = {};
  for (const g of report.recentErrors) {
    const r = (g.errorReason || "").toLowerCase();
    let cls = "other";
    if (r.includes("sensitive") || r.includes("1001")) cls = "moderation";
    else if (r.includes("invalid") && r.includes("token")) cls = "invalid_key";
    else if (r.includes("invalid") && r.includes("lyric")) cls = "bad_lyric";
    else if (r.includes("timeout") || r.includes("> 30") || r.includes("> 8")) cls = "timeout";
    else if (r.includes("network") || r.includes("fetch failed")) cls = "network";
    else if (r.includes("internal server error")) cls = "suno_transient";
    else if (r.includes("audio") && r.includes("недоступен")) cls = "audio_unavailable";
    else if (r.includes("insufficient") || r.includes("balance") || r.includes("low")) cls = "low_balance";
    breakdown[cls] = (breakdown[cls] ?? 0) + 1;
  }
  report.errorBreakdown = breakdown;

  // 6. Доминирующий тип ошибок → конкретная рекомендация
  const sortedBreakdown = Object.entries(breakdown).sort((a, b) => b[1] - a[1]);
  if (sortedBreakdown.length > 0) {
    const [topKind, topCount] = sortedBreakdown[0];
    if (topCount >= 3) {
      const tips: Record<string, string> = {
        invalid_key: "Доминирует invalid_key — ротация GPTUNNEL_API_KEY ОБЯЗАТЕЛЬНА.",
        low_balance: "Доминирует low_balance — пополни gptunnel.ru.",
        moderation: "Доминирует moderation — Suno отклоняет тексты. Это user-content, не системная проблема.",
        timeout: "Доминирует timeout — GPTunnel/Suno тормозит. Fix #1 (fetch timeout) от 2026-05-08 должен помочь.",
        suno_transient: "Доминирует suno_transient — Suno чихает (Internal server error). Auto-retry должен помогать.",
        bad_lyric: "Доминирует bad_lyric — invalid lyric format. Fix #2 (autoRetryTransient mode) от 2026-05-08 должен закрыть это.",
        network: "Доминирует network — VPS не достаёт до gptunnel.ru. Проверь firewall/DNS.",
      };
      report.recommendations.push(`📊 Доминирует «${topKind}» (${topCount}/${report.recentErrors.length}). ${tips[topKind] || "Открой /admin/v304 → 🔬 Диагностика."}`);
    }
  }

  return report;
}

// ============== SYSTEM TEST (comprehensive API-key audit) ==============
// Eugene 2026-05-08: «СДЕЛАЙ системно ВСЕ ТЕСТЫ НА API KEY от VPS Clone».
// Прогоняет 10+ probe'ов на gptunnel.ru с VPS clone, выявляет ВСЕ способы
// сбоя ключа: auth-формат, scope, schema-валидация на каждую Suno-модель,
// network latency, concurrent rate-limit, /media/result поведение.

interface ProbeResult {
  name: string;
  ok: boolean;
  ms: number | null;
  status: number | null;
  detail: string;
  body?: any;
}

async function probeFetch(opts: {
  name: string; url: string; method?: string; headers: Record<string, string>;
  body?: any; timeoutMs?: number; expectOkPredicate?: (status: number, body: any) => boolean;
}): Promise<ProbeResult> {
  const t0 = Date.now();
  try {
    const r = await fetch(opts.url, {
      method: opts.method || "GET",
      headers: opts.headers,
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
      signal: AbortSignal.timeout(opts.timeoutMs || 10_000),
    });
    const ms = Date.now() - t0;
    const text = await r.text();
    let body: any;
    try { body = JSON.parse(text); } catch { body = { raw: text.slice(0, 300) }; }
    const okFn = opts.expectOkPredicate || ((st) => st < 400);
    const ok = okFn(r.status, body);
    return {
      name: opts.name,
      ok,
      ms,
      status: r.status,
      detail: ok ? `OK · code=${body?.code ?? "?"}` : `code=${body?.code ?? "?"} · ${(body?.message || body?.error || "fail").toString().slice(0, 100)}`,
      body,
    };
  } catch (e) {
    return {
      name: opts.name,
      ok: false,
      ms: Date.now() - t0,
      status: null,
      detail: `network: ${e instanceof Error ? e.message : String(e)}`,
    };
  }
}

async function runSystemTest(includeLive: boolean) {
  const apiKey = process.env.GPTUNNEL_API_KEY;
  const report: any = {
    timestamp: new Date().toISOString(),
    apiKey: apiKey ? { present: true, length: apiKey.length, prefix: apiKey.slice(0, 4) + "…" + apiKey.slice(-4) } : { present: false },
    tests: [] as ProbeResult[],
    latency: { samples: [] as number[], p50: null, p95: null, max: null },
    summary: { total: 0, passed: 0, failed: 0, criticalFails: 0 },
  };

  if (!apiKey) {
    report.tests.push({ name: "api_key_present", ok: false, ms: 0, status: null, detail: "GPTUNNEL_API_KEY env пуст" });
    return report;
  }

  // GPTunnel считает 200 + code=0 успехом, 200 + code=3 — валидационной ошибкой
  // (но это значит auth/proxy в порядке). 401/403 = ключ невалиден.
  const proxyHealthy = (st: number, body: any) =>
    (st === 200 || st === 400 || st === 422) && (body?.code === 0 || body?.code === 3 || body?.id || body?.balance !== undefined || body?.issues);

  // === Группа A: Auth-формат ===
  report.tests.push(await probeFetch({
    name: "auth_bare_key",
    url: "https://gptunnel.ru/v1/balance",
    headers: { Authorization: apiKey },
    expectOkPredicate: (st) => st === 200,
  }));
  report.tests.push(await probeFetch({
    name: "auth_bearer_prefix",
    url: "https://gptunnel.ru/v1/balance",
    headers: { Authorization: `Bearer ${apiKey}` },
    expectOkPredicate: (st) => st === 200,
  }));
  report.tests.push(await probeFetch({
    name: "auth_x_api_key",
    url: "https://gptunnel.ru/v1/balance",
    headers: { "X-API-Key": apiKey },
    expectOkPredicate: (st) => st === 200,
  }));

  // === Группа B: Балансовая инфа ===
  report.tests.push(await probeFetch({
    name: "balance_v1",
    url: "https://gptunnel.ru/v1/balance",
    headers: { Authorization: apiKey },
    expectOkPredicate: (st, b) => st === 200 && typeof b?.balance === "number",
  }));

  // === Группа C: /media/create probe — auth scope + schema discovery ===
  report.tests.push(await probeFetch({
    name: "media_create_empty",
    url: "https://gptunnel.ru/v1/media/create",
    method: "POST",
    headers: { Authorization: apiKey, "Content-Type": "application/json" },
    body: {},
    expectOkPredicate: proxyHealthy,
  }));

  // === Группа D: Schema каждой Suno-модели ===
  for (const model of ["suno", "suno-cover", "suno-edit", "suno-extend"]) {
    report.tests.push(await probeFetch({
      name: `schema_${model}`,
      url: "https://gptunnel.ru/v1/media/create",
      method: "POST",
      headers: { Authorization: apiKey, "Content-Type": "application/json" },
      body: { model },
      expectOkPredicate: proxyHealthy,
    }));
  }

  // === Группа E: /media/result с bogus task_id ===
  report.tests.push(await probeFetch({
    name: "media_result_bogus",
    url: "https://gptunnel.ru/v1/media/result",
    method: "POST",
    headers: { Authorization: apiKey, "Content-Type": "application/json" },
    body: { task_id: "bogus-test-id-watchdog" },
    expectOkPredicate: (st, b) => st < 500 && (b?.code !== undefined || b?.message !== undefined),
  }));

  // === Группа F: Latency (5 быстрых пингов на /v1/balance) ===
  for (let i = 0; i < 5; i++) {
    const t0 = Date.now();
    try {
      await fetch("https://gptunnel.ru/v1/balance", {
        headers: { Authorization: apiKey },
        signal: AbortSignal.timeout(5000),
      });
      report.latency.samples.push(Date.now() - t0);
    } catch {
      report.latency.samples.push(-1);
    }
  }
  const valid = report.latency.samples.filter((x: number) => x > 0).sort((a: number, b: number) => a - b);
  if (valid.length > 0) {
    report.latency.p50 = valid[Math.floor(valid.length / 2)];
    report.latency.p95 = valid[Math.floor(valid.length * 0.95)] ?? valid[valid.length - 1];
    report.latency.max = valid[valid.length - 1];
  }

  // === Группа G: Concurrent rate-limit probe (3 параллельных balance) ===
  const concurrentT0 = Date.now();
  const concurrent = await Promise.all([1, 2, 3].map(() => fetch("https://gptunnel.ru/v1/balance", {
    headers: { Authorization: apiKey },
    signal: AbortSignal.timeout(5000),
  }).then(r => r.status).catch(() => -1)));
  const concurrentOk = concurrent.filter(s => s === 200).length;
  report.tests.push({
    name: "concurrent_3x",
    ok: concurrentOk === 3,
    ms: Date.now() - concurrentT0,
    status: concurrent.find(s => s !== 200) ?? 200,
    detail: `${concurrentOk}/3 вернули 200, ответы: [${concurrent.join(", ")}]`,
  });

  // === Группа H: Live test (только includeLive=true, ~18₽) ===
  if (includeLive) {
    report.tests.push(await probeFetch({
      name: "live_suno_minimal",
      url: "https://gptunnel.ru/v1/media/create",
      method: "POST",
      headers: { Authorization: apiKey, "Content-Type": "application/json" },
      body: { model: "suno", prompt: "Тест короткая весёлая песня на русском" },
      timeoutMs: 30_000,
      expectOkPredicate: (st, b) => st === 200 && b?.code === 0 && !!b?.id,
    }));
  }

  // === Сводка ===
  report.summary.total = report.tests.length;
  report.summary.passed = report.tests.filter((t: ProbeResult) => t.ok).length;
  report.summary.failed = report.tests.filter((t: ProbeResult) => !t.ok).length;
  // Критичные = balance_v1, auth_bare_key, media_create_empty
  report.summary.criticalFails = report.tests.filter((t: ProbeResult) =>
    !t.ok && ["auth_bare_key", "balance_v1", "media_create_empty"].includes(t.name)
  ).length;

  return report;
}

router.get("/system-test", async (req, res) => {
  if (!isCloneStaging(req)) {
    res.status(403).json({ data: null, error: "staging only" });
    return;
  }
  const report = await runSystemTest(false);
  res.json({ data: report, error: null });
});

router.post("/system-test", async (req, res) => {
  // На clone.muziai.ru live-test без логина (Eugene 2026-05-08 «Live опцию используй»).
  // На prod-доменах — admin Bearer обязателен. После теста этот bypass удаляем.
  if (!isCloneStaging(req)) {
    const t = (req.headers.authorization || "").toString().replace(/^Bearer\s+/, "") || (req.query as any).token;
    if (!t) { res.status(401).json({ data: null, error: "unauthorized" }); return; }
    try {
      const sess = db.get<{ userId: number }>(sql`SELECT user_id as userId FROM sessions WHERE token = ${t}`);
      if (!sess?.userId) { res.status(401).json({ data: null, error: "unauthorized" }); return; }
      const u = db.select().from(users).where(eq(users.id, sess.userId)).get();
      if (!u || u.role !== "admin") { res.status(403).json({ data: null, error: "forbidden" }); return; }
    } catch { res.status(401).json({ data: null, error: "unauthorized" }); return; }
  }
  const report = await runSystemTest(true);
  res.json({ data: report, error: null });
});

// GET — на staging-инстансе (clone.muziai.ru) разрешён без логина.
// Eugene 2026-05-08: «не хочу логиниться, дай simpler». На prod-доменах
// (если кода когда-то окажется) — требуется admin Bearer как раньше.
function isCloneStaging(req: any): boolean {
  const host = (req?.get?.("host") || req?.headers?.host || "").toString().toLowerCase();
  return host.includes("clone.muziai.ru") || host.startsWith("localhost") || host.startsWith("127.0.0.1");
}

router.get("/full-diagnose", async (req, res) => {
  if (!isCloneStaging(req)) {
    const t = (req.headers.authorization || "").toString().replace(/^Bearer\s+/, "") || (req.query as any).token;
    if (!t) { res.status(401).json({ data: null, error: "unauthorized" }); return; }
    try {
      const sess = db.get<{ userId: number }>(sql`SELECT user_id as userId FROM sessions WHERE token = ${t}`);
      if (!sess?.userId) { res.status(401).json({ data: null, error: "unauthorized" }); return; }
      const u = db.select().from(users).where(eq(users.id, sess.userId)).get();
      if (!u || u.role !== "admin") { res.status(403).json({ data: null, error: "forbidden" }); return; }
    } catch { res.status(401).json({ data: null, error: "unauthorized" }); return; }
  }
  const report = await runFullDiagnose(false);
  res.json({ data: report, error: null });
});

// POST — то же + реальный test-запрос на /media/create (~18₽)
// Eugene 2026-05-08 «Live опцию используй» — на clone без логина для одной проверки.
router.post("/full-diagnose", async (req, res) => {
  if (!isCloneStaging(req)) {
    const t = (req.headers.authorization || "").toString().replace(/^Bearer\s+/, "") || (req.query as any).token;
    if (!t) { res.status(401).json({ data: null, error: "unauthorized" }); return; }
    try {
      const sess = db.get<{ userId: number }>(sql`SELECT user_id as userId FROM sessions WHERE token = ${t}`);
      if (!sess?.userId) { res.status(401).json({ data: null, error: "unauthorized" }); return; }
      const u = db.select().from(users).where(eq(users.id, sess.userId)).get();
      if (!u || u.role !== "admin") { res.status(403).json({ data: null, error: "forbidden" }); return; }
    } catch { res.status(401).json({ data: null, error: "unauthorized" }); return; }
  }
  const report = await runFullDiagnose(true);
  res.json({ data: report, error: null });
});

const sunoWatchdogModule: Module = {
  name: "suno-watchdog",
  version: "0.1.0",
  description: "Глобальный мониторинг Suno: balance + error-rate + multi-channel alerts + circuit breaker.",
  routes: { prefix: "admin/v304/suno-watchdog", router },
  publishes: ["suno.circuit.open", "suno.circuit.close"],
  jobs: [
    {
      name: "suno-balance-poll",
      schedule: "every_minute",
      handler: async () => {
        try {
          // poll баланса каждые ~5 мин (раз в 5 минут запуска cron)
          const now = Date.now();
          const lastCheck = STATE.balanceCheckedAt ? new Date(STATE.balanceCheckedAt).getTime() : 0;
          if (now - lastCheck >= 5 * 60_000 || !STATE.balanceCheckedAt) {
            await pollBalance();
          }
        } catch (e) {
          bootRefs?.logger.error("[suno-watchdog] balance-poll failed", { error: e instanceof Error ? e.message : String(e) });
        }
      },
    },
    {
      name: "suno-error-rate-scan",
      schedule: "every_minute",
      handler: async () => {
        try {
          scanGenerationErrorRate();
          await evaluateState();
        } catch (e) {
          bootRefs?.logger.error("[suno-watchdog] error-rate-scan failed", { error: e instanceof Error ? e.message : String(e) });
        }
      },
    },
  ],
  onLoad: async (ctx) => {
    bootRefs = { eventBus: ctx.eventBus, logger: ctx.logger };
    ctx.logger.info("suno-watchdog online", {
      thresholdKopeks: LOW_BALANCE_THRESHOLD_KOPEKS,
      dedupeMinutes: DEDUPE_MINUTES,
    });
    // Первый poll сразу при старте чтобы иметь стейт
    setTimeout(() => { pollBalance().catch(() => {}); }, 3000);
  },
  healthCheck: () => {
    const sev = STATE.status === "down" ? "degraded" : (STATE.status === "low_balance" ? "degraded" : "ok");
    return { status: sev, details: { ...STATE } };
  },
};

export default sunoWatchdogModule;
