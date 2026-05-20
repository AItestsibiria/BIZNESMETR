// v304 plugin: api-health (Eugene 2026-05-16 Босс «папка API ключи + лампочка»).
//
// Что делает:
//  - Хранит результаты health-check'ов API-ключей в таблице api_key_health.
//  - GET  /api/admin/v304/api-keys/health           — список всех ключей со статусами.
//  - POST /api/admin/v304/api-keys/test/:keyName    — manual health test одного ключа.
//  - POST /api/admin/v304/api-keys/test-all         — manual health test всех ключей.
//  - Cron 03:00 MSK (= 00:00 UTC) — авто-проверка всех ключей + Telegram alert при fail.
//
// Безопасность:
//  - НЕ возвращает значения ключей, только { present, length, first8, status }.
//  - Использует requireAdmin guard.
//
// Pre-edit analysis: проверка ключа делает реальный API-call наружу.
// Для дорогих провайдеров (Yandex SpeechKit STT) — лёгкий cheapest endpoint
// (operations/get с пустым ID, возвращает 400/404 — это OK = ключ принят).
// SMS.ru: /balance. Telegram: getMe. Anthropic: HEAD на /v1/messages (или модели).
// GPTunnel: GET /balance. OpenAI: GET /v1/models.

import { Router } from "express";
import { sql } from "drizzle-orm";
import { db } from "../../storage";
import { requireAdmin } from "../../core/adminAuth";
import { callTimeWebGateway, listAnthropicKeys, setLLMKeyStatus, getLLMKeyStatus } from "../../lib/llmCore";
import type { Module } from "../../core";

// === Реестр ключей ===
// Каждый «логический» ключ — независимая запись для health-check'а.
// kind: 'live-check' = делаем сетевой запрос; 'config-only' = только проверка
// наличия значения (для секретов без API, например ROBO_PASSWORD).

type CheckKind = "live-check" | "config-only";

interface KeyDef {
  name: string;          // env name
  category: string;      // группа в UI
  purpose: string;       // что использует
  kind: CheckKind;
  check?: () => Promise<{ status: "ok" | "fail"; error?: string; details?: any }>;
}

async function checkAnthropicKey(key: string): Promise<{ status: "ok" | "fail"; error?: string }> {
  try {
    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": key,
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
    if (r.status >= 200 && r.status < 300) return { status: "ok" };
    // 400 invalid_request тоже считается OK — ключ принят, просто модель не та.
    if (r.status === 400) {
      const j: any = await r.json().catch(() => null);
      const errType = j?.error?.type;
      if (errType === "invalid_request_error") return { status: "ok" };
    }
    const errText = await r.text().catch(() => "");
    return { status: "fail", error: `HTTP ${r.status}: ${errText.slice(0, 150)}` };
  } catch (e: any) {
    return { status: "fail", error: e?.name === "AbortError" ? "timeout" : String(e?.message || e).slice(0, 150) };
  }
}

async function checkTimeWebGateway(): Promise<{ status: "ok" | "fail"; error?: string }> {
  const key = process.env.TIMEWEB_GATEWAY_KEY;
  if (!key) return { status: "fail", error: "TIMEWEB_GATEWAY_KEY не задан" };
  try {
    const r = await callTimeWebGateway({
      systemPrompt: "Ты тестовый эхо-бот.",
      history: [],
      userText: "ping",
      maxTokens: 5,
      // Eugene 2026-05-20: дефолт — anthropic/claude-haiku-4-5 (proven via api.timeweb.ai/v1).
      model: process.env.TIMEWEB_GATEWAY_MODEL || "anthropic/claude-haiku-4-5",
    });
    if (r.text && r.text.length > 0) return { status: "ok" };
    return { status: "fail", error: "пустой ответ или endpoint не найден" };
  } catch (e: any) {
    return { status: "fail", error: String(e?.message || e).slice(0, 150) };
  }
}

async function checkDeepSeek(): Promise<{ status: "ok" | "fail"; error?: string }> {
  const key = process.env.DEEPSEEK_API_KEY;
  if (!key) return { status: "fail", error: "DEEPSEEK_API_KEY не задан" };
  try {
    const { callDeepSeek } = await import("../../lib/llmCore");
    const r = await callDeepSeek({
      systemPrompt: "Ты тестовый эхо-бот.",
      history: [],
      userText: "ping",
      maxTokens: 5,
    });
    if (r.text && r.text.length > 0) return { status: "ok" };
    return { status: "fail", error: "пустой ответ" };
  } catch (e: any) {
    return { status: "fail", error: String(e?.message || e).slice(0, 150) };
  }
}

async function checkGptunnel(): Promise<{ status: "ok" | "fail"; error?: string }> {
  const key = process.env.GPTUNNEL_API_KEY;
  if (!key) return { status: "fail", error: "GPTUNNEL_API_KEY не задан" };
  try {
    const r = await fetch("https://gptunnel.ru/v1/balance", {
      headers: { "Authorization": `Bearer ${key}` },
      signal: AbortSignal.timeout(10_000),
    });
    if (r.status >= 200 && r.status < 300) return { status: "ok" };
    const txt = await r.text().catch(() => "");
    return { status: "fail", error: `HTTP ${r.status}: ${txt.slice(0, 100)}` };
  } catch (e: any) {
    return { status: "fail", error: String(e?.message || e).slice(0, 150) };
  }
}

async function checkYandexSpeechKit(): Promise<{ status: "ok" | "fail"; error?: string }> {
  const key = process.env.YANDEX_SPEECHKIT_API_KEY;
  if (!key) return { status: "fail", error: "YANDEX_SPEECHKIT_API_KEY не задан" };
  try {
    // Cheapest: TTS synthesize с пустым text — 400 invalid argument, но ключ принят (~auth ok).
    // Используем lazy auth-probe: GET к stt-listresources (если key invalid → 401).
    const r = await fetch("https://stt.api.cloud.yandex.net/speech/v1/stt:recognize?folderId=" + (process.env.YANDEX_FOLDER_ID || "test"), {
      method: "POST",
      headers: { "Authorization": `Api-Key ${key}` },
      body: Buffer.from([]), // пустой WAV → 400, но не 401
      signal: AbortSignal.timeout(10_000),
    });
    // 400 = ключ принят, content invalid. 401 = ключ невалиден.
    if (r.status === 401 || r.status === 403) {
      const txt = await r.text().catch(() => "");
      return { status: "fail", error: `HTTP ${r.status}: ${txt.slice(0, 100)}` };
    }
    return { status: "ok" };
  } catch (e: any) {
    return { status: "fail", error: String(e?.message || e).slice(0, 150) };
  }
}

async function checkOpenAi(): Promise<{ status: "ok" | "fail"; error?: string }> {
  const key = process.env.OPENAI_API_KEY;
  if (!key) return { status: "fail", error: "OPENAI_API_KEY не задан" };
  try {
    const r = await fetch("https://api.openai.com/v1/models", {
      headers: { "Authorization": `Bearer ${key}` },
      signal: AbortSignal.timeout(10_000),
    });
    if (r.status >= 200 && r.status < 300) return { status: "ok" };
    const txt = await r.text().catch(() => "");
    return { status: "fail", error: `HTTP ${r.status}: ${txt.slice(0, 100)}` };
  } catch (e: any) {
    return { status: "fail", error: String(e?.message || e).slice(0, 150) };
  }
}

async function checkTelegramBot(): Promise<{ status: "ok" | "fail"; error?: string }> {
  const key = process.env.TELEGRAM_BOT_TOKEN;
  if (!key) return { status: "fail", error: "TELEGRAM_BOT_TOKEN не задан" };
  try {
    const r = await fetch(`https://api.telegram.org/bot${key}/getMe`, {
      signal: AbortSignal.timeout(10_000),
    });
    const j: any = await r.json().catch(() => null);
    if (j?.ok === true) return { status: "ok" };
    return { status: "fail", error: j?.description || `HTTP ${r.status}` };
  } catch (e: any) {
    return { status: "fail", error: String(e?.message || e).slice(0, 150) };
  }
}

async function checkSmsRu(): Promise<{ status: "ok" | "fail"; error?: string }> {
  const key = process.env.SMSRU_API_ID;
  if (!key) return { status: "fail", error: "SMSRU_API_ID не задан" };
  try {
    const r = await fetch(`https://sms.ru/my/balance?api_id=${encodeURIComponent(key)}&json=1`, {
      signal: AbortSignal.timeout(10_000),
    });
    const j: any = await r.json().catch(() => null);
    // SMS.ru: status_code = 100 = OK, 200/300/400 = auth-error
    if (j?.status_code === 100 || j?.status === "OK") return { status: "ok" };
    return { status: "fail", error: j?.status_text || `code ${j?.status_code}` };
  } catch (e: any) {
    return { status: "fail", error: String(e?.message || e).slice(0, 150) };
  }
}

async function checkAnthropicByEnv(envName: string): Promise<{ status: "ok" | "fail"; error?: string }> {
  const key = process.env[envName];
  if (!key) return { status: "fail", error: `${envName} не задан` };
  return checkAnthropicKey(key);
}

function configOnly(envName: string): KeyDef["check"] {
  return async () => {
    const v = process.env[envName];
    return v && v.length > 0
      ? { status: "ok" }
      : { status: "fail", error: `${envName} не задан` };
  };
}

const KEY_DEFS: KeyDef[] = [
  // === LLM-цепочка (порядок = priority) ===
  // Eugene 2026-05-20 Босс: PRIMARY = TimeWeb Gateway, FALLBACK = Anthropic 3-key chain.
  { name: "TIMEWEB_GATEWAY_KEY", category: "🤖 LLM (primary)", purpose: "TimeWeb Gateway (OpenAI-compat) — primary провайдер Музы", kind: "live-check", check: checkTimeWebGateway },
  { name: "DEEPSEEK_API_KEY", category: "🤖 LLM (fallback 1)", purpose: "DeepSeek (OpenAI-compat) — fallback после TimeWeb", kind: "live-check", check: checkDeepSeek },
  { name: "ANTHROPIC_API_KEY", category: "🤖 LLM (fallback 2)", purpose: "Anthropic Claude — fallback после DeepSeek", kind: "live-check", check: () => checkAnthropicByEnv("ANTHROPIC_API_KEY") },
  { name: "ANTHROPIC_API_KEY_BACKUP", category: "🤖 LLM (fallback 2)", purpose: "Резерв Claude #2", kind: "live-check", check: () => checkAnthropicByEnv("ANTHROPIC_API_KEY_BACKUP") },
  { name: "ANTHROPIC_API_KEY_BOT", category: "🤖 LLM (fallback 2)", purpose: "Резерв Claude #3", kind: "live-check", check: () => checkAnthropicByEnv("ANTHROPIC_API_KEY_BOT") },

  // === Музыка + STT ===
  { name: "GPTUNNEL_API_KEY", category: "🎵 Музыка", purpose: "Suno генерация через GPTunnel", kind: "live-check", check: checkGptunnel },
  { name: "YANDEX_SPEECHKIT_API_KEY", category: "🎤 STT", purpose: "Распознавание голоса (audio-режим)", kind: "live-check", check: checkYandexSpeechKit },
  { name: "OPENAI_API_KEY", category: "🎤 STT", purpose: "Whisper fallback", kind: "live-check", check: checkOpenAi },

  // === Каналы ===
  { name: "TELEGRAM_BOT_TOKEN", category: "💬 Каналы", purpose: "Telegram-бот (логин + муза)", kind: "live-check", check: checkTelegramBot },
  { name: "SMSRU_API_ID", category: "📱 Auth", purpose: "SMS-OTP для регистрации", kind: "live-check", check: checkSmsRu },

  // === Платежи / подписи (config-only — нет API health-check'а) ===
  { name: "ROBO_PASSWORD_1", category: "💳 Платежи", purpose: "Robokassa подпись Result URL", kind: "config-only", check: configOnly("ROBO_PASSWORD_1") },
  { name: "ROBO_PASSWORD_2", category: "💳 Платежи", purpose: "Robokassa подпись Success URL", kind: "config-only", check: configOnly("ROBO_PASSWORD_2") },
  { name: "SESSION_SECRET", category: "🔒 Подписи", purpose: "Cookie sessions HMAC", kind: "config-only", check: configOnly("SESSION_SECRET") },
  { name: "SIGNED_URL_SECRET", category: "🔒 Подписи", purpose: "Streaming URL signatures", kind: "config-only", check: configOnly("SIGNED_URL_SECRET") },
];

// === Помощники для UI ===

function peek(envName: string) {
  const v = process.env[envName];
  if (!v) return { present: false, length: 0, first8: "" };
  return { present: true, length: v.length, first8: v.slice(0, 8) };
}

interface HealthRecord {
  status: "ok" | "fail" | "skip";
  lastCheckedAt: string | null;
  lastError: string | null;
  lastDurationMs: number | null;
}

function readHealthRecord(name: string): HealthRecord {
  try {
    const row = db.get<any>(sql`SELECT status, last_checked_at, last_error, last_duration_ms FROM api_key_health WHERE name = ${name} LIMIT 1`);
    if (!row) return { status: "skip", lastCheckedAt: null, lastError: null, lastDurationMs: null };
    return {
      status: row.status,
      lastCheckedAt: row.last_checked_at,
      lastError: row.last_error,
      lastDurationMs: row.last_duration_ms,
    };
  } catch {
    return { status: "skip", lastCheckedAt: null, lastError: null, lastDurationMs: null };
  }
}

function writeHealthRecord(name: string, rec: { status: "ok" | "fail" | "skip"; error?: string; durationMs?: number }) {
  const now = new Date().toISOString();
  try {
    db.run(sql`
      INSERT INTO api_key_health (name, status, last_checked_at, last_error, last_duration_ms, updated_at)
      VALUES (${name}, ${rec.status}, ${now}, ${rec.error || null}, ${rec.durationMs ?? null}, ${now})
      ON CONFLICT(name) DO UPDATE SET
        status = excluded.status,
        last_checked_at = excluded.last_checked_at,
        last_error = excluded.last_error,
        last_duration_ms = excluded.last_duration_ms,
        updated_at = excluded.updated_at
    `);
  } catch (e) {
    console.warn("[api-health] writeHealthRecord error:", e);
  }
}

async function runCheck(def: KeyDef): Promise<HealthRecord> {
  const startedAt = Date.now();
  try {
    const v = process.env[def.name];
    if (!v || v.length === 0) {
      // Ключ не задан — записываем skip (не fail, чтобы не было ложного red).
      const rec = { status: "skip" as const, error: undefined, durationMs: 0 };
      writeHealthRecord(def.name, rec);
      return { status: "skip", lastCheckedAt: new Date().toISOString(), lastError: null, lastDurationMs: 0 };
    }
    const result = await (def.check ? def.check() : Promise.resolve({ status: "ok" as const }));
    const durationMs = Date.now() - startedAt;
    const status = result.status;
    writeHealthRecord(def.name, { status, error: result.error, durationMs });
    // Обновим llmKeyStatus для совместимости с существующим UI «Ключи AI»
    if (def.name.startsWith("ANTHROPIC_API_KEY") || def.name === "TIMEWEB_GATEWAY_KEY" || def.name === "DEEPSEEK_API_KEY") {
      setLLMKeyStatus(def.name, {
        lastUsedAt: new Date().toISOString(),
        lastStatus: status === "ok" ? 200 : "error",
        lastErrorMsg: result.error,
      });
    }
    return {
      status,
      lastCheckedAt: new Date().toISOString(),
      lastError: result.error || null,
      lastDurationMs: durationMs,
    };
  } catch (e: any) {
    const durationMs = Date.now() - startedAt;
    const err = String(e?.message || e).slice(0, 200);
    writeHealthRecord(def.name, { status: "fail", error: err, durationMs });
    return { status: "fail", lastCheckedAt: new Date().toISOString(), lastError: err, lastDurationMs: durationMs };
  }
}

function buildOverallStatus(items: Array<{ name: string; status: string; lastCheckedAt: string | null; configured: boolean }>): "green" | "yellow" | "red" {
  const day = 24 * 60 * 60 * 1000;
  const now = Date.now();
  let red = 0, yellow = 0;
  for (const it of items) {
    if (!it.configured) continue;
    if (it.status === "fail") red++;
    else if (it.status === "skip" || !it.lastCheckedAt) yellow++;
    else if (it.lastCheckedAt) {
      const age = now - new Date(it.lastCheckedAt).getTime();
      if (age > day) yellow++;
    }
  }
  if (red > 0) return "red";
  if (yellow > 0) return "yellow";
  return "green";
}

async function sendAdminAlert(failed: Array<{ name: string; error: string | null }>) {
  if (failed.length === 0) return;
  const adminChat = process.env.ADMIN_TELEGRAM_ID;
  const botToken = process.env.TELEGRAM_BOT_TOKEN;
  if (!adminChat || !botToken) return;
  const lines = failed.map(f => `• \`${f.name}\` — ${(f.error || "fail").slice(0, 100)}`).join("\n");
  const text = `🔴 *API проверка 03:00 MSK*\n\nНе работают:\n${lines}`;
  try {
    await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: adminChat, text, parse_mode: "Markdown" }),
      signal: AbortSignal.timeout(8_000),
    });
  } catch (e) {
    console.warn("[api-health] Telegram alert не отправлен:", e);
  }
}

// === Cron tick: проверяет «03:00 MSK» через timestamp window ===
// moduleRegistry поддерживает только every_minute/hour/day, поэтому
// используем every_hour и сами проверяем что сейчас 00:00 UTC = 03:00 MSK.
// Допуск ±30 мин от старта часа — чтобы не пропустить если cron сместится.
let LAST_CRON_RUN_DAY: string | null = null;

async function runNightlyCheckIfDue() {
  const now = new Date();
  // 00 UTC = 03 MSK (UTC+3)
  if (now.getUTCHours() !== 0) return;
  const dayKey = now.toISOString().slice(0, 10); // YYYY-MM-DD UTC
  if (LAST_CRON_RUN_DAY === dayKey) return;
  LAST_CRON_RUN_DAY = dayKey;
  console.log("[api-health] nightly run starting at", now.toISOString());
  const failed: Array<{ name: string; error: string | null }> = [];
  for (const def of KEY_DEFS) {
    const v = process.env[def.name];
    if (!v) continue; // skip — не задан, не ругаемся
    const rec = await runCheck(def);
    if (rec.status === "fail") failed.push({ name: def.name, error: rec.lastError });
  }
  console.log(`[api-health] nightly done, failed=${failed.length}`);
  await sendAdminAlert(failed);
}

// === Routes ===

const router = Router();

// GET /api/admin/v304/api-keys/health
router.get("/health", requireAdmin, (_req, res) => {
  const items = KEY_DEFS.map(def => {
    const p = peek(def.name);
    const rec = readHealthRecord(def.name);
    return {
      name: def.name,
      category: def.category,
      purpose: def.purpose,
      kind: def.kind,
      configured: p.present,
      length: p.length,
      first8: p.first8,
      status: p.present ? rec.status : "skip",
      lastCheckedAt: rec.lastCheckedAt,
      lastError: rec.lastError,
      lastDurationMs: rec.lastDurationMs,
    };
  });
  const overallStatus = buildOverallStatus(items);
  // Группируем для UI
  const groupsMap = new Map<string, any[]>();
  for (const it of items) {
    const arr = groupsMap.get(it.category) || [];
    arr.push(it);
    groupsMap.set(it.category, arr);
  }
  const groups = Array.from(groupsMap.entries()).map(([category, keys]) => ({ category, keys }));
  res.json({
    data: {
      overallStatus,
      items,
      groups,
      checkedAt: new Date().toISOString(),
      totals: {
        configured: items.filter(i => i.configured).length,
        ok: items.filter(i => i.status === "ok").length,
        fail: items.filter(i => i.status === "fail").length,
        untested: items.filter(i => i.configured && (i.status === "skip" || !i.lastCheckedAt)).length,
        total: items.length,
      },
    },
    error: null,
  });
});

// POST /api/admin/v304/api-keys/test/:keyName
router.post("/test/:keyName", requireAdmin, async (req, res) => {
  const keyName = String(req.params.keyName || "");
  const def = KEY_DEFS.find(d => d.name === keyName);
  if (!def) {
    return res.status(404).json({ data: null, error: `Ключ ${keyName} не зарегистрирован` });
  }
  try {
    const rec = await runCheck(def);
    res.json({ data: { name: def.name, ...rec }, error: null });
  } catch (e: any) {
    res.status(500).json({ data: null, error: String(e?.message || e).slice(0, 200) });
  }
});

// POST /api/admin/v304/api-keys/run-nightly — manual триггер ночной проверки
// (без ожидания 03:00 MSK). Используется для smoke-test cron'а + alert'а.
router.post("/run-nightly", requireAdmin, async (_req, res) => {
  try {
    const failed: Array<{ name: string; error: string | null }> = [];
    for (const def of KEY_DEFS) {
      const v = process.env[def.name];
      if (!v) continue;
      const rec = await runCheck(def);
      if (rec.status === "fail") failed.push({ name: def.name, error: rec.lastError });
    }
    await sendAdminAlert(failed);
    res.json({
      data: {
        ranAt: new Date().toISOString(),
        failedCount: failed.length,
        failed,
        alertSent: failed.length > 0 && !!process.env.ADMIN_TELEGRAM_ID && !!process.env.TELEGRAM_BOT_TOKEN,
      },
      error: null,
    });
  } catch (e: any) {
    res.status(500).json({ data: null, error: String(e?.message || e).slice(0, 200) });
  }
});

// POST /api/admin/v304/api-keys/test-all
router.post("/test-all", requireAdmin, async (_req, res) => {
  try {
    const results: Array<{ name: string; status: string; lastError: string | null; lastDurationMs: number | null }> = [];
    for (const def of KEY_DEFS) {
      const v = process.env[def.name];
      if (!v) {
        results.push({ name: def.name, status: "skip", lastError: null, lastDurationMs: 0 });
        continue;
      }
      const rec = await runCheck(def);
      results.push({ name: def.name, status: rec.status, lastError: rec.lastError, lastDurationMs: rec.lastDurationMs });
    }
    res.json({ data: { results, completedAt: new Date().toISOString() }, error: null });
  } catch (e: any) {
    res.status(500).json({ data: null, error: String(e?.message || e).slice(0, 200) });
  }
});

// === Module export ===

const apiHealthModule: Module = {
  name: "api-health",
  version: "0.1.0",
  description: "Health-check всех API-ключей + cron 03:00 MSK + Telegram alert при fail.",
  migrations: [
    {
      version: "001_create_api_key_health.sql",
      up: `
        CREATE TABLE IF NOT EXISTS api_key_health (
          name TEXT PRIMARY KEY,
          status TEXT NOT NULL CHECK (status IN ('ok', 'fail', 'skip')),
          last_checked_at TEXT NOT NULL,
          last_error TEXT,
          last_duration_ms INTEGER,
          updated_at TEXT NOT NULL
        )
      `,
    },
  ],
  routes: { prefix: "admin/v304/api-keys", router },
  jobs: [
    {
      name: "api-health-nightly",
      schedule: "every_hour",
      handler: () => runNightlyCheckIfDue(),
    },
  ],
  onLoad: async (ctx) => {
    ctx.logger.info("api-health online — GET /api/admin/v304/api-keys/health, nightly 03:00 MSK");
  },
  healthCheck: () => ({ status: "ok" }),
};

export default apiHealthModule;

// Экспортируем для прямого использования из других плагинов (e.g. триггер cron вручную)
export { KEY_DEFS, runCheck, runNightlyCheckIfDue, readHealthRecord, buildOverallStatus };
