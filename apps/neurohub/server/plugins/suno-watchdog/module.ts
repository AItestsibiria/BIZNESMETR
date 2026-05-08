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
const ERROR_RATE_5M_THRESHOLD = 0.8; // 80% gens упали за 5 мин = down
const ERROR_RATE_5M_MIN_VOLUME = 3;  // минимум 3 gen чтобы делать выводы
const DEDUPE_MINUTES = 30;            // не повторять алёрт раньше 30 мин
const PING_TIMEOUT_MS = 10_000;

interface WatchdogState {
  status: "up" | "low_balance" | "down" | "unknown";
  balanceKopeks: number | null;
  balanceCheckedAt: string | null;
  balanceError: string | null;
  errorRate5m: number; // 0..1
  errorRate15m: number;
  totalGens5m: number;
  errorGens5m: number;
  lastSunoPingAt: string | null;
  lastAlerts: Record<string, string>; // kind → ISO ts
  circuitOpen: boolean;
  circuitOpenSince: string | null;
}

const STATE: WatchdogState = {
  status: "unknown",
  balanceKopeks: null,
  balanceCheckedAt: null,
  balanceError: null,
  errorRate5m: 0,
  errorRate15m: 0,
  totalGens5m: 0,
  errorGens5m: 0,
  lastSunoPingAt: null,
  lastAlerts: {},
  circuitOpen: false,
  circuitOpenSince: null,
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
  try {
    const r = await fetch("https://gptunnel.ru/v1/balance", {
      headers: { Authorization: apiKey },
      signal: AbortSignal.timeout(PING_TIMEOUT_MS),
    });
    if (!r.ok) {
      STATE.balanceError = `HTTP ${r.status}`;
      STATE.lastSunoPingAt = new Date().toISOString();
      // 401/403 — proteted ключ; будет обработан ниже как unreachable
      if (r.status === 401 || r.status === 403) {
        await notifyAdmin({
          kind: "suno_invalid_key",
          severity: "critical",
          title: "GPTunnel ключ невалиден или отозван",
          body: `GET /v1/balance вернул HTTP ${r.status}. Все генерации Suno падают до тех пор пока ключ не обновлён.`,
          resolution: "Открой gptunnel.ru → выпусти свежий ключ → /admin/v304 → 🔑 Секреты → ротация GPTUNNEL_API_KEY → pm2 restart neurohub --update-env",
        });
      }
      return;
    }
    const data: any = await r.json();
    // GPTunnel возвращает balance в рублях (float). Переводим в копейки.
    const rubles = typeof data?.balance === "number" ? data.balance : Number(data?.balance ?? 0);
    const kopeks = Math.round(rubles * 100);
    STATE.balanceKopeks = kopeks;
    STATE.balanceCheckedAt = new Date().toISOString();
    STATE.balanceError = null;
    STATE.lastSunoPingAt = STATE.balanceCheckedAt;

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
    STATE.balanceError = e instanceof Error ? e.message : String(e);
    STATE.lastSunoPingAt = new Date().toISOString();
    await notifyAdmin({
      kind: "suno_unreachable",
      severity: "critical",
      title: "GPTunnel недоступен (network)",
      body: `Не могу достучаться до gptunnel.ru/v1/balance: ${STATE.balanceError}. Все Suno-запросы падают.`,
      resolution: "Проверь VPS network: curl -m 10 https://gptunnel.ru/v1/balance -H \"Authorization: $GPTUNNEL_API_KEY\". Если падает — firewall/DNS на VPS",
    });
  }
}

function scanGenerationErrorRate(): void {
  // Берём gens за последние 5/15 мин и считаем error-rate
  const r5: any = db.get(sql`
    SELECT
      COUNT(*) AS total,
      SUM(CASE WHEN status = 'error' THEN 1 ELSE 0 END) AS errors
    FROM generations
    WHERE created_at > datetime('now', '-5 minutes')
      AND type = 'music'
  `);
  const r15: any = db.get(sql`
    SELECT
      COUNT(*) AS total,
      SUM(CASE WHEN status = 'error' THEN 1 ELSE 0 END) AS errors
    FROM generations
    WHERE created_at > datetime('now', '-15 minutes')
      AND type = 'music'
  `);

  STATE.totalGens5m = r5?.total ?? 0;
  STATE.errorGens5m = r5?.errors ?? 0;
  STATE.errorRate5m = STATE.totalGens5m > 0 ? STATE.errorGens5m / STATE.totalGens5m : 0;
  const total15 = r15?.total ?? 0;
  STATE.errorRate15m = total15 > 0 ? (r15?.errors ?? 0) / total15 : 0;
}

async function evaluateState(): Promise<void> {
  const previousStatus = STATE.status;

  // Status priority: down > low_balance > up
  if (STATE.balanceError && STATE.balanceError !== "GPTUNNEL_API_KEY не установлен") {
    STATE.status = "down";
  } else if (
    STATE.totalGens5m >= ERROR_RATE_5M_MIN_VOLUME &&
    STATE.errorRate5m >= ERROR_RATE_5M_THRESHOLD
  ) {
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
  if (
    STATE.totalGens5m >= ERROR_RATE_5M_MIN_VOLUME &&
    STATE.errorRate5m >= ERROR_RATE_5M_THRESHOLD
  ) {
    await notifyAdmin({
      kind: "suno_high_error_rate",
      severity: "critical",
      title: `Suno: error-rate ${(STATE.errorRate5m * 100).toFixed(0)}% за 5 мин`,
      body: `За 5 мин: ${STATE.errorGens5m}/${STATE.totalGens5m} генераций упали. Похоже, Suno глобально не работает. Auto-retry приостановлен (circuit open).`,
      resolution: "Дождись восстановления (Watchdog auto-recovers) или обнови ключ если проблема в нём. /admin/v304 → Suno Watchdog для real-time стейта",
    });
  } else if (STATE.totalGens5m >= ERROR_RATE_5M_MIN_VOLUME && STATE.errorRate5m < 0.3) {
    autoResolveIncident("suno_high_error_rate", `error-rate упал до ${(STATE.errorRate5m * 100).toFixed(0)}%`);
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

router.post("/poll-now", requireAdmin, async (_req, res) => {
  await pollBalance();
  scanGenerationErrorRate();
  await evaluateState();
  res.json({ data: STATE, error: null });
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
