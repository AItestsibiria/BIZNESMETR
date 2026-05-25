// Eugene 2026-05-25 Босс «Директор уведомляет меня о всех важных событиях
// ежедневно 03:00 и 14:00 МСК. Критические ситуации немедленно».
//
// Директор как главный начальник собирает срез по ВСЕМ направлениям (агенты,
// генерации, финансы, поддержка, обратная связь) и докладывает Боссу в TG:
//   - Плановый дайджест: 03:00 + 14:00 МСК (cron в admin-overview).
//   - Критические ситуации: немедленно (checkCritical, частый scan + событийные
//     алерты уже идут через agent-orchestrator-bridge).
//
// Reuse: orchestrator (агенты), genLifecycleAgent (генерации), dengaAgent
// (финансы), agent_handoffs/escalation_queue (поддержка/обратная связь).
// TG-helper — тот же паттерн что bridge/llmCore. Never throws.

import { db } from "../storage";
import { callDeepSeek, callTimeWebGateway, listAnthropicKeys } from "./llmCore";

/**
 * Eugene 2026-05-25 Босс «подключи Директора к AI по API — пусть смотрит где
 * проблемы и докладывает с предложениями». LLM-анализ среза: DeepSeek (cheap)
 * → TimeWeb → Anthropic. Возвращает текст с диагнозом + конкретными
 * предложениями, либо null (тогда caller отдаёт статический дайджест).
 */
const DIRECTOR_ANALYST_SYSTEM =
  `Ты — Музa Директор, главный аналитик бэкенда MuzaAi (AI-генерация музыки). ` +
  `На входе — JSON-срез по всем службам: агенты, генерации, финансы, поддержка, обратная связь. ` +
  `Твоя задача: НАЙТИ проблемы и дать КОНКРЕТНЫЕ предложения что сделать (1 проблема — 1 действие). ` +
  `Пиши кратко, по-деловому, на русском, от женского лица, как начальник Боссу. ` +
  `Формат: 2-5 пунктов «проблема → предложение». Если проблем нет — одной строкой «Всё штатно, рисков не вижу». ` +
  `Не выдумывай данных сверх JSON. Не более 700 символов.`;

export async function analyzeWithAI(data: DigestData): Promise<string | null> {
  const userText = `Срез служб (JSON):\n${JSON.stringify(data)}`;
  // 1) DeepSeek (cheap)
  try {
    const ds = await callDeepSeek({ systemPrompt: DIRECTOR_ANALYST_SYSTEM, history: [], userText, maxTokens: 400 });
    if (ds.text && ds.text.trim().length > 10) return ds.text.trim();
  } catch {}
  // 2) TimeWeb gateway
  try {
    const tw = await callTimeWebGateway({ systemPrompt: DIRECTOR_ANALYST_SYSTEM, history: [], userText, maxTokens: 400, model: process.env.TIMEWEB_GATEWAY_MODEL || "anthropic/claude-haiku-4-5" });
    if (tw.text && tw.text.trim().length > 10) return tw.text.trim();
  } catch {}
  // 3) Anthropic (первый ключ)
  try {
    const keys = listAnthropicKeys();
    if (keys.length > 0) {
      const r = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: { "x-api-key": keys[0].key, "anthropic-version": "2023-06-01", "content-type": "application/json" },
        body: JSON.stringify({ model: "claude-haiku-4-5-20251001", max_tokens: 400, system: DIRECTOR_ANALYST_SYSTEM, messages: [{ role: "user", content: userText }] }),
        signal: AbortSignal.timeout(15_000),
      });
      if (r.ok) {
        const j: any = await r.json();
        const t = (j?.content || []).find((b: any) => b.type === "text")?.text;
        if (t && t.trim().length > 10) return t.trim();
      }
    }
  } catch {}
  return null;
}

function notifyBossTelegram(text: string): void {
  const adminId = process.env.ADMIN_TELEGRAM_ID;
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!adminId || !token) return;
  fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: adminId, text, parse_mode: "HTML", disable_web_page_preview: true }),
    signal: AbortSignal.timeout(8000),
  }).catch(() => {});
}

const one = (q: string, ...a: any[]): any => {
  try { return (db as any).$client.prepare(q).get(...a); } catch { return null; }
};

export interface DigestData {
  agents: { total: number; errored: string[]; stale: string[] };
  generations: { escalated: number; stuck: number };
  finance: { revenueRub: number; profitRub: number } | null;
  support: { open: number; urgent: number };
  feedback: { escalationsOpen: number; negative24h: number };
  critical: string[];
}

export async function collectDigestData(): Promise<DigestData> {
  const now = Date.now();
  const d: DigestData = {
    agents: { total: 0, errored: [], stale: [] },
    generations: { escalated: 0, stuck: 0 },
    finance: null,
    support: { open: 0, urgent: 0 },
    feedback: { escalationsOpen: 0, negative24h: 0 },
    critical: [],
  };

  // Агенты
  try {
    const { orchestrator } = await import("./agentOrchestrator");
    const list = orchestrator.list();
    d.agents.total = list.length;
    for (const a of list) {
      if (a.status === "error") d.agents.errored.push(a.name);
      else if (a.lastSeenAt) {
        const thr = a.channel === "cron" ? 25 * 3600_000 : 6 * 3600_000;
        if (now - a.lastSeenAt > thr) d.agents.stale.push(a.name);
      }
    }
  } catch {}

  // Генерации (gen-lifecycle)
  try {
    const mod = await import("./genLifecycleAgent");
    const s = mod.getStats();
    d.generations.escalated = s.escalated || 0;
  } catch {}
  d.generations.stuck = one(`SELECT COUNT(*) c FROM generations WHERE status='processing' AND datetime(created_at) < datetime('now','-10 minutes')`)?.c || 0;

  // Финансы (Деньга) — за сегодня
  try {
    const { getPeriodRange } = await import("./periodBoundaries");
    const range = getPeriodRange("today");
    const { getAggregates } = await import("./dengaAgent");
    const a = getAggregates({ periodLabel: "today", fromIso: range.fromIso, toIso: range.toIso });
    d.finance = { revenueRub: Math.round((a.totalRevenue || 0) / 100), profitRub: Math.round((a.totalProfit || 0) / 100) };
  } catch {}

  // Поддержка
  d.support.open = one(`SELECT COUNT(*) c FROM agent_handoffs WHERE status IN ('open','in_progress')`)?.c || 0;
  d.support.urgent = one(`SELECT COUNT(*) c FROM agent_handoffs WHERE status IN ('open','in_progress') AND priority IN ('high','urgent')`)?.c || 0;

  // Обратная связь
  d.feedback.escalationsOpen = one(`SELECT COUNT(*) c FROM escalation_queue WHERE status='open'`)?.c || 0;
  d.feedback.negative24h = one(`SELECT COUNT(*) c FROM message_analysis WHERE sentiment_label='negative' AND created_at > ?`, now - 24 * 3600_000)?.c || 0;

  // Критерии КРИТИЧНОГО (немедленный алерт)
  if (d.agents.errored.length > 0) d.critical.push(`🔴 Агенты в ошибке: ${d.agents.errored.join(", ")}`);
  if (d.generations.stuck >= 5) d.critical.push(`🔴 Зависших генераций: ${d.generations.stuck}`);
  if (d.support.urgent >= 3) d.critical.push(`🔴 Срочных тикетов: ${d.support.urgent}`);
  if (d.feedback.escalationsOpen >= 5) d.critical.push(`🔴 Открытых эскалаций: ${d.feedback.escalationsOpen}`);

  return d;
}

function formatDigest(d: DigestData, label: string): string {
  const lines: string[] = [`🎬 <b>Директор — срез ${label}</b>`, ""];
  lines.push(`🤖 Агентов: ${d.agents.total}${d.agents.errored.length ? `, 🔴 ошибка: ${d.agents.errored.join(", ")}` : ""}${d.agents.stale.length ? `, 🟡 молчат: ${d.agents.stale.join(", ")}` : ""}${!d.agents.errored.length && !d.agents.stale.length ? " — все ✅" : ""}`);
  lines.push(`🎵 Генерации: зависших ${d.generations.stuck}, эскалаций ${d.generations.escalated}`);
  if (d.finance) lines.push(`💰 Сегодня: выручка ${d.finance.revenueRub} ₽, прибыль ${d.finance.profitRub} ₽`);
  lines.push(`🆘 Поддержка: открыто ${d.support.open}${d.support.urgent ? ` (срочных ${d.support.urgent})` : ""}`);
  lines.push(`📣 Обратная связь: эскалаций ${d.feedback.escalationsOpen}, негатив 24ч ${d.feedback.negative24h}`);
  if (d.critical.length) { lines.push("", "<b>⚠️ Требует внимания:</b>", ...d.critical); }
  return lines.join("\n");
}

/** Плановый дайджест (03:00 / 14:00 МСК) + AI-анализ с предложениями. */
export async function sendDailyDigest(label: string): Promise<void> {
  try {
    const d = await collectDigestData();
    try {
      const { recordAgentActivity } = await import("./agentOrchestrator");
      recordAgentActivity("director-digest", { label });
    } catch {}
    let msg = formatDigest(d, label);
    // AI-анализ: где проблемы + предложения (Босс «докладывает с предложениями»).
    const ai = await analyzeWithAI(d).catch(() => null);
    if (ai) msg += `\n\n🧠 <b>Анализ Директора:</b>\n${ai}`;
    notifyBossTelegram(msg);
  } catch (e) {
    console.warn("[directorDigest] sendDailyDigest failed:", e);
  }
}

// Анти-флуд критических: один и тот же набор critical не чаще раза в час.
let lastCriticalKey = "";
let lastCriticalAt = 0;

/** Немедленный критический алерт — частый scan (safety-net поверх событийных). */
export async function checkCritical(): Promise<void> {
  try {
    const d = await collectDigestData();
    if (d.critical.length === 0) { lastCriticalKey = ""; return; }
    const key = d.critical.join("|");
    const now = Date.now();
    if (key === lastCriticalKey && now - lastCriticalAt < 60 * 60_000) return; // тот же набор — не чаще 1/час
    lastCriticalKey = key;
    lastCriticalAt = now;
    let msg = `🚨 <b>Директор — КРИТИЧНО</b>\n\n${d.critical.join("\n")}`;
    // AI-предложение что делать (короткое).
    const ai = await analyzeWithAI(d).catch(() => null);
    if (ai) msg += `\n\n🧠 ${ai}`;
    msg += `\n\nЗайди в /admin/v304 → 🎬 Музa Директор.`;
    notifyBossTelegram(msg);
  } catch (e) {
    console.warn("[directorDigest] checkCritical failed:", e);
  }
}

/** On-demand анализ для director-tool: данные + AI-разбор с предложениями. */
export async function analyzeNow(): Promise<string> {
  const d = await collectDigestData();
  const ai = await analyzeWithAI(d).catch(() => null);
  const base = formatDigest(d, "сейчас").replace(/<\/?b>/g, "");
  return ai ? `${base}\n\n🧠 Анализ:\n${ai}` : base;
}
