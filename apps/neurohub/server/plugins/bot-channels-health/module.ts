// v304 plugin: bot-channels-health (Eugene 2026-05-17 Босс «системная интеграция всех каналов»).
//
// Что делает:
//  - Хранит результаты health-check'ов каналов общения (web, telegram, max) в bot_channels_health.
//  - GET  /api/admin/v304/bot-channels-health           — состояние всех каналов + LLM-движок.
//  - POST /api/admin/v304/bot-channels-health/recheck   — manual перепроверка ВСЕХ каналов.
//  - POST /api/admin/v304/bot-channels-health/recheck/:id — manual перепроверка одного канала.
//  - Cron every_hour — авто-проверка + Telegram-alert при смене статуса (green→red).
//
// Cross-integration:
//  - Все каналы (web, TG, Max, будущие VK/Email) роутятся через callUnifiedMuzaLLM.
//  - LLM-движок: primary=Anthropic, fallback=TimeWeb Gateway (lib/llmCore.ts).
//  - При downtime web-chat показывает баннер с резервными каналами.
//
// Безопасность:
//  - requireAdmin guard.
//  - Telegram-alert rate-limit: 1/час/канал.
//  - Health-check не флудит — 1 ping в час достаточно.
//
// No-duplicates rule (CLAUDE.md): создан как самостоятельная сущность,
// потому что api-health покрывает только API-ключи провайдеров, а здесь —
// сами channels (webhook info, message count, web-chat сессии, LLM-engine).

import { Router } from "express";
import { sql } from "drizzle-orm";
import { db } from "../../storage";
import { requireAdmin } from "../../core/adminAuth";
import {
  listAnthropicKeys,
  callTimeWebGateway,
  getLLMKeyStatus,
} from "../../lib/llmCore";
import type { Module, BootContext } from "../../core";

// === Типы ===

export type ChannelStatus = "green" | "yellow" | "red" | "skip";

export interface ChannelHealthRecord {
  id: string;
  name: string;
  status: ChannelStatus;
  lastCheckedAt: string | null;
  lastError: string | null;
  metric: string | null;
  issues: string[];
  details: Record<string, any>;
}

export interface CheckResult {
  status: ChannelStatus;
  error?: string;
  metric?: string;
  issues?: string[];
  details?: Record<string, any>;
}

interface ChannelDef {
  id: string;          // 'web' | 'telegram' | 'max'
  name: string;        // отображаемое имя
  check: () => Promise<CheckResult>;
}

// === Утилиты для метрик ===

function countRecentMessages(channel: string, sinceMinutes: number): number {
  try {
    const sqlite: any = (db as any).$client;
    const sinceIso = new Date(Date.now() - sinceMinutes * 60_000).toISOString();
    const row = sqlite.prepare(`
      SELECT COUNT(*) as c
      FROM chatbot_messages cm
      JOIN chatbot_sessions cs ON cs.id = cm.session_id
      WHERE cs.channel = ? AND cm.created_at >= ?
    `).get(channel, sinceIso) as { c: number } | undefined;
    return Number(row?.c || 0);
  } catch {
    return 0;
  }
}

// === Channel checks ===

async function checkWebChannel(): Promise<CheckResult> {
  try {
    const msgs = countRecentMessages("web", 60);
    const issues: string[] = [];
    let status: ChannelStatus = "green";
    // Проверка LLM-движка (используется веб-чатом)
    const anthropicKeys = listAnthropicKeys();
    if (anthropicKeys.length === 0 && !process.env.TIMEWEB_GATEWAY_KEY) {
      status = "red";
      issues.push("Нет ни одного LLM ключа (Anthropic + TimeWeb fallback)");
    }
    return {
      status,
      metric: `${msgs} сообщений за час`,
      issues,
      details: {
        recentMessages1h: msgs,
        recentMessages24h: countRecentMessages("web", 60 * 24),
        anthropicKeysConfigured: anthropicKeys.length,
        timewebFallback: !!process.env.TIMEWEB_GATEWAY_KEY,
      },
    };
  } catch (e: any) {
    return { status: "red", error: String(e?.message || e).slice(0, 200), issues: ["проверка упала"] };
  }
}

async function checkTelegramChannel(): Promise<CheckResult> {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) {
    return { status: "skip", error: "TELEGRAM_BOT_TOKEN не задан", issues: ["канал не настроен"] };
  }
  try {
    // getMe + getWebhookInfo
    const meResp = await fetch(`https://api.telegram.org/bot${token}/getMe`, {
      signal: AbortSignal.timeout(8_000),
    });
    if (!meResp.ok) {
      const t = await meResp.text().catch(() => "");
      return {
        status: "red",
        error: `getMe HTTP ${meResp.status}: ${t.slice(0, 100)}`,
        issues: [`Telegram API недоступен (${meResp.status})`],
      };
    }
    const meJson: any = await meResp.json();
    const whResp = await fetch(`https://api.telegram.org/bot${token}/getWebhookInfo`, {
      signal: AbortSignal.timeout(8_000),
    });
    const whJson: any = await whResp.json().catch(() => null);
    const wh = whJson?.result || {};
    const issues: string[] = [];
    let status: ChannelStatus = "green";

    // Webhook должен быть установлен
    if (!wh.url) {
      issues.push("Webhook URL не установлен");
      status = "yellow";
    }
    // pending_update_count > 50 — webhook не отрабатывает
    if (Number(wh.pending_update_count || 0) > 50) {
      issues.push(`pending_update_count=${wh.pending_update_count} (>50)`);
      status = "yellow";
    }
    // last_error_date < 1h — недавняя ошибка webhook
    if (wh.last_error_date) {
      const lastErrAt = wh.last_error_date * 1000;
      const ageMin = (Date.now() - lastErrAt) / 60_000;
      if (ageMin < 60) {
        issues.push(`webhook last_error: ${wh.last_error_message || "—"} (${Math.round(ageMin)} мин назад)`);
        if (status === "green") status = "yellow";
      }
    }

    const msgs1h = countRecentMessages("telegram", 60);
    return {
      status,
      metric: `${msgs1h} сообщений за час`,
      issues,
      details: {
        botUsername: meJson?.result?.username,
        botId: meJson?.result?.id,
        webhookUrl: wh.url,
        pendingUpdateCount: wh.pending_update_count,
        lastErrorAt: wh.last_error_date ? new Date(wh.last_error_date * 1000).toISOString() : null,
        lastErrorMessage: wh.last_error_message || null,
        recentMessages1h: msgs1h,
        recentMessages24h: countRecentMessages("telegram", 60 * 24),
      },
    };
  } catch (e: any) {
    const msg = e?.name === "AbortError" ? "timeout" : String(e?.message || e).slice(0, 200);
    return { status: "red", error: msg, issues: [`Telegram check error: ${msg}`] };
  }
}

async function checkMaxChannel(): Promise<CheckResult> {
  const token = process.env.MAX_BOT_TOKEN;
  if (!token) {
    return { status: "skip", error: "MAX_BOT_TOKEN не задан", issues: ["канал не настроен"] };
  }
  try {
    // Max-bot: GET /me (получение информации о боте) — лёгкий ping
    const r = await fetch("https://botapi.max.ru/me", {
      headers: { Authorization: token },
      signal: AbortSignal.timeout(8_000),
    });
    if (!r.ok) {
      const t = await r.text().catch(() => "");
      return {
        status: "red",
        error: `Max /me HTTP ${r.status}: ${t.slice(0, 100)}`,
        issues: [`Max API недоступен (${r.status})`],
      };
    }
    const j: any = await r.json().catch(() => null);

    // Активность канала — если за 2 часа не было сообщений и есть конфиг, помечаем yellow
    const msgs2h = countRecentMessages("max", 120);
    const msgs24h = countRecentMessages("max", 60 * 24);
    const issues: string[] = [];
    let status: ChannelStatus = "green";
    if (msgs24h > 0 && msgs2h === 0) {
      // Канал ранее активен, но за 2 часа тишина — может означать, что webhook упал
      issues.push("webhook не получал updates за 2 часа");
      status = "yellow";
    }
    return {
      status,
      metric: `${countRecentMessages("max", 60)} сообщений за час`,
      issues,
      details: {
        botInfo: j,
        recentMessages1h: countRecentMessages("max", 60),
        recentMessages2h: msgs2h,
        recentMessages24h: msgs24h,
      },
    };
  } catch (e: any) {
    const msg = e?.name === "AbortError" ? "timeout" : String(e?.message || e).slice(0, 200);
    return { status: "red", error: msg, issues: [`Max check error: ${msg}`] };
  }
}

// === LLM engine probe ===

async function probeLLMEngine(): Promise<{
  primary: string;
  primaryStatus: "ok" | "fail" | "untested";
  primaryError?: string;
  fallback: string;
  fallbackStatus: "ok" | "fail" | "untested";
  fallbackError?: string;
}> {
  // Eugene 2026-05-20 Босс: PRIMARY = TimeWeb Gateway, FALLBACK = Anthropic.
  // Раньше было наоборот (Anthropic primary, TimeWeb fallback).
  const result: any = {
    primary: "timeweb-gateway",
    primaryStatus: "untested",
    fallback: "anthropic",
    fallbackStatus: "untested",
  };

  // TimeWeb (primary) — ping
  if (process.env.TIMEWEB_GATEWAY_KEY) {
    try {
      const tw = await callTimeWebGateway({
        systemPrompt: "echo",
        history: [],
        userText: "ok",
        maxTokens: 5,
        // Eugene 2026-05-20: дефолт — anthropic/claude-haiku-4-5 (proven via api.timeweb.ai/v1).
        model: process.env.TIMEWEB_GATEWAY_MODEL || "anthropic/claude-haiku-4-5",
      });
      if (tw.text) {
        result.primaryStatus = "ok";
      } else {
        result.primaryStatus = "fail";
        const last = getLLMKeyStatus("TIMEWEB_GATEWAY_KEY");
        result.primaryError = last?.lastErrorMsg || "TimeWeb вернул пустой ответ";
      }
    } catch (e: any) {
      result.primaryStatus = "fail";
      result.primaryError = String(e?.message || e).slice(0, 150);
    }
  } else {
    result.primaryError = "TIMEWEB_GATEWAY_KEY не задан";
    result.primaryStatus = "fail";
  }

  // Anthropic (fallback) — лёгкий probe (1 token)
  const keys = listAnthropicKeys();
  if (keys.length > 0) {
    try {
      const r = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "x-api-key": keys[0].key,
          "anthropic-version": "2023-06-01",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          model: "claude-haiku-4-5-20251001",
          max_tokens: 1,
          messages: [{ role: "user", content: "ok" }],
        }),
        signal: AbortSignal.timeout(10_000),
      });
      if (r.status >= 200 && r.status < 300) {
        result.fallbackStatus = "ok";
      } else if (r.status === 400) {
        // invalid_request_error может означать что ключ принят (вопрос только в payload)
        result.fallbackStatus = "ok";
      } else {
        result.fallbackStatus = "fail";
        const t = await r.text().catch(() => "");
        result.fallbackError = `HTTP ${r.status}: ${t.slice(0, 100)}`;
      }
    } catch (e: any) {
      result.fallbackStatus = "fail";
      result.fallbackError = e?.name === "AbortError" ? "timeout" : String(e?.message || e).slice(0, 150);
    }
  } else {
    result.fallbackError = "Anthropic ключи не настроены";
    result.fallbackStatus = "fail";
  }

  return result;
}

// === Channels registry ===

const CHANNEL_DEFS: ChannelDef[] = [
  { id: "web", name: "Web Чат", check: checkWebChannel },
  { id: "telegram", name: "Telegram @Muziaipodari_bot", check: checkTelegramChannel },
  { id: "max", name: "Max", check: checkMaxChannel },
];

// === DB helpers ===

function readChannelRecord(id: string): {
  status: ChannelStatus;
  lastCheckedAt: string | null;
  lastError: string | null;
  metric: string | null;
  issues: string[];
  details: Record<string, any>;
} {
  try {
    const row = db.get<any>(sql`
      SELECT status, last_checked_at, last_error, metric, issues_json, details_json
      FROM bot_channels_health WHERE id = ${id} LIMIT 1
    `);
    if (!row) {
      return { status: "skip", lastCheckedAt: null, lastError: null, metric: null, issues: [], details: {} };
    }
    return {
      status: row.status,
      lastCheckedAt: row.last_checked_at,
      lastError: row.last_error,
      metric: row.metric,
      issues: safeJsonArray(row.issues_json),
      details: safeJsonObj(row.details_json),
    };
  } catch {
    return { status: "skip", lastCheckedAt: null, lastError: null, metric: null, issues: [], details: {} };
  }
}

function safeJsonArray(raw: any): string[] {
  if (!raw) return [];
  try {
    const j = JSON.parse(String(raw));
    return Array.isArray(j) ? j.map(String) : [];
  } catch {
    return [];
  }
}

function safeJsonObj(raw: any): Record<string, any> {
  if (!raw) return {};
  try {
    const j = JSON.parse(String(raw));
    return j && typeof j === "object" && !Array.isArray(j) ? j : {};
  } catch {
    return {};
  }
}

function writeChannelRecord(id: string, rec: {
  status: ChannelStatus;
  error?: string | null;
  metric?: string | null;
  issues?: string[];
  details?: Record<string, any>;
}) {
  const now = new Date().toISOString();
  try {
    db.run(sql`
      INSERT INTO bot_channels_health (id, status, last_checked_at, last_error, metric, issues_json, details_json, updated_at)
      VALUES (${id}, ${rec.status}, ${now}, ${rec.error || null}, ${rec.metric || null},
              ${JSON.stringify(rec.issues || [])}, ${JSON.stringify(rec.details || {})}, ${now})
      ON CONFLICT(id) DO UPDATE SET
        status = excluded.status,
        last_checked_at = excluded.last_checked_at,
        last_error = excluded.last_error,
        metric = excluded.metric,
        issues_json = excluded.issues_json,
        details_json = excluded.details_json,
        updated_at = excluded.updated_at
    `);
  } catch (e) {
    console.warn("[bot-channels-health] write error:", e);
  }
}

// === Status overall ===

function buildOverallStatus(records: ChannelHealthRecord[]): "green" | "yellow" | "red" {
  let red = 0, yellow = 0;
  for (const r of records) {
    if (r.status === "red") red++;
    else if (r.status === "yellow") yellow++;
  }
  if (red > 0) return "red";
  if (yellow > 0) return "yellow";
  return "green";
}

// === Telegram alert rate-limit ===

const LAST_ALERT_AT = new Map<string, number>();

async function sendChannelDownAlert(opts: {
  channelId: string;
  channelName: string;
  from: ChannelStatus;
  to: ChannelStatus;
  issues: string[];
  lastError: string | null;
  details: Record<string, any>;
}) {
  const adminChat = process.env.ADMIN_TELEGRAM_ID;
  const botToken = process.env.TELEGRAM_BOT_TOKEN;
  if (!adminChat || !botToken) return;

  // Rate-limit: 1 alert/час/канал
  const key = `${opts.channelId}:${opts.to}`;
  const lastAt = LAST_ALERT_AT.get(key) || 0;
  if (Date.now() - lastAt < 60 * 60_000) return;
  LAST_ALERT_AT.set(key, Date.now());

  const emoji = opts.to === "red" ? "🔴" : opts.to === "yellow" ? "🟡" : "🟢";
  const transition = `${opts.from} → ${opts.to}`;
  const issuesText = opts.issues.length > 0 ? opts.issues.map(i => `• ${i}`).join("\n") : "—";
  const lastSeenAt = opts.details?.lastErrorAt || opts.details?.lastWebhookAt || "—";
  const webhookUrl = opts.details?.webhookUrl || "—";

  const text = `${emoji} *Канал ${opts.channelName}* (${transition})\n\nПроблемы:\n${issuesText}\n\nLast seen: ${String(lastSeenAt).slice(0, 19)}\nWebhook: \`${String(webhookUrl).slice(0, 100)}\`\nLast error: ${(opts.lastError || "—").slice(0, 200)}\n\nВремя: ${new Date().toLocaleString("ru-RU")}`;

  try {
    await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: adminChat, text, parse_mode: "Markdown" }),
      signal: AbortSignal.timeout(8_000),
    });
  } catch (e) {
    console.warn("[bot-channels-health] Telegram alert не отправлен:", e);
  }
}

// === Главный probe ===

export async function runChannelCheck(def: ChannelDef): Promise<ChannelHealthRecord> {
  const prev = readChannelRecord(def.id);
  let result: CheckResult;
  try {
    result = await def.check();
  } catch (e: any) {
    const msg = String(e?.message || e).slice(0, 200);
    result = { status: "red", error: msg, issues: [`check threw: ${msg}`] };
  }
  writeChannelRecord(def.id, {
    status: result.status,
    error: result.error || null,
    metric: result.metric || null,
    issues: result.issues || [],
    details: result.details || {},
  });
  // Alert при смене статуса в плохую сторону
  const downgraded =
    (prev.status === "green" || prev.status === "skip") &&
    (result.status === "red" || result.status === "yellow");
  const recovered = prev.status === "red" && result.status === "green";
  if (downgraded || recovered) {
    sendChannelDownAlert({
      channelId: def.id,
      channelName: def.name,
      from: prev.status,
      to: result.status,
      issues: result.issues || [],
      lastError: result.error || null,
      details: result.details || {},
    }).catch(() => {});
  }
  return {
    id: def.id,
    name: def.name,
    status: result.status,
    lastCheckedAt: new Date().toISOString(),
    lastError: result.error || null,
    metric: result.metric || null,
    issues: result.issues || [],
    details: result.details || {},
  };
}

// Cron tick — каждый час
let LAST_HOURLY_RUN_HOUR: string | null = null;

export async function runHourlyCheckIfDue() {
  const now = new Date();
  const hourKey = now.toISOString().slice(0, 13); // YYYY-MM-DDTHH
  if (LAST_HOURLY_RUN_HOUR === hourKey) return;
  LAST_HOURLY_RUN_HOUR = hourKey;
  console.log("[bot-channels-health] hourly check starting at", now.toISOString());
  for (const def of CHANNEL_DEFS) {
    try {
      await runChannelCheck(def);
    } catch (e) {
      console.warn(`[bot-channels-health] check ${def.id} failed:`, e);
    }
  }
  console.log("[bot-channels-health] hourly check done");
}

// === Routes ===

const router = Router();

// GET /api/admin/v304/bot-channels-health
router.get("/", requireAdmin, async (_req, res) => {
  try {
    const items: ChannelHealthRecord[] = CHANNEL_DEFS.map(def => {
      const rec = readChannelRecord(def.id);
      return {
        id: def.id,
        name: def.name,
        status: rec.status,
        lastCheckedAt: rec.lastCheckedAt,
        lastError: rec.lastError,
        metric: rec.metric,
        issues: rec.issues,
        details: rec.details,
      };
    });
    // LLM engine — кэшируем 5 минут (probe платный по токенам)
    const cached = readLLMEngineCache();
    let llmEngine = cached.engine;
    const cacheAgeMs = Date.now() - (cached.at || 0);
    if (!llmEngine || cacheAgeMs > 5 * 60_000) {
      llmEngine = await probeLLMEngine();
      writeLLMEngineCache(llmEngine);
    }
    const overallStatus = buildOverallStatus(items);
    res.json({
      data: {
        channels: items,
        llmEngine,
        overallStatus,
        checkedAt: new Date().toISOString(),
      },
      error: null,
    });
  } catch (e: any) {
    res.status(500).json({ data: null, error: String(e?.message || e).slice(0, 200) });
  }
});

// POST /api/admin/v304/bot-channels-health/recheck — manual проверка всех каналов
router.post("/recheck", requireAdmin, async (_req, res) => {
  try {
    const results: ChannelHealthRecord[] = [];
    for (const def of CHANNEL_DEFS) {
      const r = await runChannelCheck(def);
      results.push(r);
    }
    const llmEngine = await probeLLMEngine();
    writeLLMEngineCache(llmEngine);
    res.json({
      data: {
        channels: results,
        llmEngine,
        overallStatus: buildOverallStatus(results),
        completedAt: new Date().toISOString(),
      },
      error: null,
    });
  } catch (e: any) {
    res.status(500).json({ data: null, error: String(e?.message || e).slice(0, 200) });
  }
});

// POST /api/admin/v304/bot-channels-health/recheck/:id — manual проверка одного канала
router.post("/recheck/:id", requireAdmin, async (req, res) => {
  const id = String(req.params.id || "");
  const def = CHANNEL_DEFS.find(d => d.id === id);
  if (!def) {
    return res.status(404).json({ data: null, error: `Канал ${id} не зарегистрирован` });
  }
  try {
    const result = await runChannelCheck(def);
    res.json({ data: result, error: null });
  } catch (e: any) {
    res.status(500).json({ data: null, error: String(e?.message || e).slice(0, 200) });
  }
});

// === LLM-engine cache (in-memory) ===
let LLM_ENGINE_CACHE: { engine: any; at: number } = { engine: null, at: 0 };
function readLLMEngineCache() {
  return LLM_ENGINE_CACHE;
}
function writeLLMEngineCache(engine: any) {
  LLM_ENGINE_CACHE = { engine, at: Date.now() };
}

// === Public getter (для muzaTools admin-tool get_bot_channels_status) ===

export async function getChannelsStatusSummary(): Promise<string> {
  const items: ChannelHealthRecord[] = CHANNEL_DEFS.map(def => {
    const rec = readChannelRecord(def.id);
    return {
      id: def.id,
      name: def.name,
      status: rec.status,
      lastCheckedAt: rec.lastCheckedAt,
      lastError: rec.lastError,
      metric: rec.metric,
      issues: rec.issues,
      details: rec.details,
    };
  });
  const cached = readLLMEngineCache();
  let llmEngine = cached.engine;
  if (!llmEngine) {
    llmEngine = await probeLLMEngine();
    writeLLMEngineCache(llmEngine);
  }
  const overall = buildOverallStatus(items);
  const lines: string[] = [];
  const overallEmoji = overall === "green" ? "🟢" : overall === "yellow" ? "🟡" : "🔴";
  lines.push(`${overallEmoji} Каналы (общий статус: ${overall}):`);
  for (const c of items) {
    const dot = c.status === "green" ? "🟢" : c.status === "yellow" ? "🟡" : c.status === "red" ? "🔴" : "⚪";
    const issuesShort = c.issues.length > 0 ? ` — ${c.issues[0]}` : "";
    lines.push(`${dot} ${c.name}: ${c.status}${issuesShort}`);
  }
  lines.push("");
  const pDot = llmEngine.primaryStatus === "ok" ? "🟢" : llmEngine.primaryStatus === "fail" ? "🔴" : "⚪";
  const fDot = llmEngine.fallbackStatus === "ok" ? "🟢" : llmEngine.fallbackStatus === "fail" ? "🔴" : "⚪";
  lines.push(`LLM движок:`);
  lines.push(`${pDot} primary (${llmEngine.primary}): ${llmEngine.primaryStatus}${llmEngine.primaryError ? ` — ${llmEngine.primaryError}` : ""}`);
  lines.push(`${fDot} fallback (${llmEngine.fallback}): ${llmEngine.fallbackStatus}${llmEngine.fallbackError ? ` — ${llmEngine.fallbackError}` : ""}`);
  return lines.join("\n");
}

// === Module export ===

const botChannelsHealthModule: Module = {
  name: "bot-channels-health",
  version: "0.1.0",
  description: "Per-channel health для web/telegram/max + LLM engine probe + ежечасный cron + TG-alert при downtime.",
  migrations: [
    {
      version: "001_create_bot_channels_health.sql",
      up: `
        CREATE TABLE IF NOT EXISTS bot_channels_health (
          id TEXT PRIMARY KEY,
          status TEXT NOT NULL,
          last_checked_at TEXT NOT NULL,
          last_error TEXT,
          metric TEXT,
          issues_json TEXT,
          details_json TEXT,
          updated_at TEXT NOT NULL
        )
      `,
    },
  ],
  routes: { prefix: "admin/v304/bot-channels-health", router },
  jobs: [
    {
      name: "bot-channels-hourly",
      schedule: "every_hour",
      handler: () => runHourlyCheckIfDue(),
    },
  ],
  onLoad: async (ctx: BootContext) => {
    // Auto-migrate (на случай если migrations runner не выполнил)
    try {
      const sqlite: any = (db as any).$client;
      sqlite.exec(`
        CREATE TABLE IF NOT EXISTS bot_channels_health (
          id TEXT PRIMARY KEY,
          status TEXT NOT NULL,
          last_checked_at TEXT NOT NULL,
          last_error TEXT,
          metric TEXT,
          issues_json TEXT,
          details_json TEXT,
          updated_at TEXT NOT NULL
        )
      `);
    } catch (e) {
      ctx.logger.warn("[bot-channels-health] migration failed", { error: String(e) });
    }
    ctx.logger.info("bot-channels-health online — GET /api/admin/v304/bot-channels-health, hourly probe");
  },
  healthCheck: () => ({ status: "ok" }),
};

export default botChannelsHealthModule;
export { CHANNEL_DEFS };
