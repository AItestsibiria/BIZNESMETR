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
const PING_TIMEOUT_MS = 10_000;

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
  // Берём gens за последние 5/15/60 мин и считаем error-rate
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
  const r60: any = db.get(sql`
    SELECT
      COUNT(*) AS total,
      SUM(CASE WHEN status = 'error' THEN 1 ELSE 0 END) AS errors
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

// Self-contained HTML страница — Eugene 2026-05-08: «дай ссылку которая
// просто работает в браузере». Страница читает localStorage.token (его
// браузер сохраняет после логина) и шлёт его как Bearer на /full-diagnose.
// PUBLIC: HTML без секретов; защищена сама диагностика requireAdmin'ом.
router.get("/page", (_req, res) => {
  res.setHeader("Content-Type", "text/html; charset=utf-8");
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
  <div id="status" class="big">Загружаю…</div>
  <div style="margin-top:12px">
    <button id="btnGet" onclick="run(false)">🔄 Обновить (бесплатно)</button>
    <button id="btnPost" onclick="run(true)">🎵 Полный тест (~18₽)</button>
  </div>
</div>

<div id="summary"></div>

<div class="panel">
  <div class="label">Полный JSON-отчёт</div>
  <pre id="raw">…</pre>
</div>

<script>
const token = localStorage.getItem("token");
if (!token) {
  document.getElementById("status").innerHTML = '<span class="err">Не залогинен.</span> Открой <a href="/#/login">/#/login</a> (egnovoselov@gmail.com) и вернись сюда — токен сохранится в браузере, дальше всё работает в один клик.';
  document.getElementById("btnGet").disabled = true;
  document.getElementById("btnPost").disabled = true;
}

async function run(includeTest) {
  const status = document.getElementById("status");
  status.textContent = includeTest ? "Делаю реальный запрос на Suno…" : "Опрашиваю watchdog…";
  document.getElementById("btnGet").disabled = true;
  document.getElementById("btnPost").disabled = true;
  try {
    const r = await fetch("/api/admin/v304/suno-watchdog/full-diagnose", {
      method: includeTest ? "POST" : "GET",
      headers: { "Authorization": "Bearer " + token, "Content-Type": "application/json" },
    });
    const j = await r.json();
    if (!r.ok || j.error) { throw new Error(j.error || "HTTP " + r.status); }
    render(j.data);
  } catch (e) {
    status.innerHTML = '<span class="err">Ошибка: ' + (e.message || e) + '</span>';
  } finally {
    document.getElementById("btnGet").disabled = false;
    document.getElementById("btnPost").disabled = false;
  }
}

function render(d) {
  const wd = d.watchdog || {};
  const statusCls = wd.status === "up" ? "ok" : wd.status === "low_balance" ? "warn" : "err";
  document.getElementById("status").innerHTML =
    '<span class="' + statusCls + '">● ' + (wd.status || "?").toUpperCase() + '</span>' +
    (wd.circuitOpen ? ' <span class="err">(circuit OPEN)</span>' : '');

  let html = "";

  // Ключ + баланс
  html += '<div class="panel"><div class="row">';
  html += '<div><div class="label">API key</div><div class="big">' +
          (d.apiKey?.present ? '<span class="ok">' + d.apiKey.prefix + '</span> (' + d.apiKey.length + ' chars)'
                              : '<span class="err">отсутствует</span>') + '</div></div>';
  const balCls = d.balance?.ok ? "ok" : "err";
  const balText = d.balance?.ok ? (d.balance.balance + ' ₽ · ' + d.balance.ms + ' мс')
                                : ('error · ' + (d.balance?.error || '?'));
  html += '<div><div class="label">Balance</div><div class="big ' + balCls + '">' + balText + '</div></div>';
  html += '</div></div>';

  // Тест-запрос
  if (d.testRequest && !d.testRequest.skipped) {
    const tCls = d.testRequest.ok ? "ok" : "err";
    html += '<div class="panel"><div class="label">Test /media/create</div>';
    html += '<div class="big ' + tCls + '">' + (d.testRequest.ok
            ? '✅ taskId=' + d.testRequest.taskId + ' (' + d.testRequest.ms + ' мс)'
            : '❌ ' + (d.testRequest.error || '?') + ' (' + (d.testRequest.ms || '?') + ' мс)') + '</div></div>';
  }

  // Распределение ошибок
  const eb = d.errorBreakdown || {};
  const ebKeys = Object.keys(eb);
  if (ebKeys.length) {
    html += '<div class="panel"><div class="label">Ошибки за 24ч</div>';
    ebKeys.sort((a,b) => eb[b] - eb[a]).forEach(k => {
      html += '<div>' + k + ': <b>' + eb[k] + '</b></div>';
    });
    html += '</div>';
  }

  // Рекомендации
  if (d.recommendations?.length) {
    html += '<div class="panel"><div class="label">Рекомендации</div><ul class="rec">';
    d.recommendations.forEach(r => { html += '<li>' + r + '</li>'; });
    html += '</ul></div>';
  }

  document.getElementById("summary").innerHTML = html;
  document.getElementById("raw").textContent = JSON.stringify(d, null, 2);
}

if (token) run(false);
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
        signal: AbortSignal.timeout(10_000),
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

  // 3. Тестовый /media/create — только если includeTestRequest=true
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

router.get("/full-diagnose", requireAdmin, async (_req, res) => {
  const report = await runFullDiagnose(false);
  res.json({ data: report, error: null });
});

// POST — то же + реальный test-запрос на /media/create (~18₽)
router.post("/full-diagnose", requireAdmin, async (_req, res) => {
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
