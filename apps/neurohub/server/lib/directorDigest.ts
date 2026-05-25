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

function notifyBossTelegram(text: string): boolean {
  const adminId = process.env.ADMIN_TELEGRAM_ID;
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!adminId || !token) return false;
  fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: adminId, text, parse_mode: "HTML", disable_web_page_preview: true }),
    signal: AbortSignal.timeout(8000),
  }).catch(() => {});
  return true;
}

// Eugene 2026-05-25 Рек 5: email-fallback дайджеста/алертов если TG не настроен.
async function notifyBossEmail(text: string): Promise<void> {
  try {
    const to = process.env.ADMIN_EMAIL || "egnovoselov@gmail.com";
    const { sendEmail } = await import("./emailSender");
    const plain = text.replace(/<\/?b>/g, "");
    await sendEmail({ to, subject: "🎬 Музa Директор — отчёт", text: plain });
  } catch {}
}

/** Единый канал уведомления Боссу: TG primary, email fallback. */
export async function notifyBoss(text: string): Promise<void> {
  const tgOk = notifyBossTelegram(text);
  if (!tgOk) await notifyBossEmail(text);
}

// Eugene 2026-05-25 Рек 4: единый dedup-канал критических алертов Директора.
// gen.escalated / a1.alert / escalation-high / critical-scan — все через
// directorAlert → один и тот же key не чаще windowMs (нет спама от 4 источников).
const alertDedup = new Map<string, number>();
export function directorAlert(key: string, text: string, windowMs = 30 * 60_000): void {
  const now = Date.now();
  const prev = alertDedup.get(key) || 0;
  if (now - prev < windowMs) return;
  alertDedup.set(key, now);
  // cleanup
  if (alertDedup.size > 500) {
    for (const [k, t] of alertDedup) if (now - t > 6 * 3600_000) alertDedup.delete(k);
  }
  void notifyBoss(text);
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
  payments: { total24h: number; failed24h: number };
  frontend: { errorsLastHour: number };
  business: {
    registrations24h: number;
    visitors24h: number;
    gensDone24h: number;
    gensError24h: number;
    gensProcessing: number;
    plays24h: number;
    lyrics24h: number;
    covers24h: number;
    activeSubscriptions: number;
  };
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
    payments: { total24h: 0, failed24h: 0 },
    frontend: { errorsLastHour: 0 },
    business: { registrations24h: 0, visitors24h: 0, gensDone24h: 0, gensError24h: 0, gensProcessing: 0, plays24h: 0, lyrics24h: 0, covers24h: 0, activeSubscriptions: 0 },
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

  // Платежи (24ч)
  const pay = one(`SELECT SUM(CASE WHEN status='failed' THEN 1 ELSE 0 END) AS failed, COUNT(*) AS total FROM payments WHERE datetime(created_at) > datetime(?, 'unixepoch')`, Math.floor((now - 24 * 3600_000) / 1000));
  d.payments.total24h = Number(pay?.total || 0);
  d.payments.failed24h = Number(pay?.failed || 0);

  // Фронтенд (client-errors за час)
  try {
    const ring: Array<{ ts: string }> = (globalThis as any).__clientErrorsRing || [];
    const hourAgo = now - 3600_000;
    d.frontend.errorsLastHour = ring.filter(e => { const t = Date.parse(e.ts); return Number.isFinite(t) && t > hourAgo; }).length;
  } catch {}

  // Бизнес «по всем делам» (24ч) — регистрации, визиты, генерации, плеи, подписки.
  const dayMs = now - 24 * 3600_000;
  d.business.registrations24h = one(`SELECT COUNT(*) c FROM users WHERE datetime(created_at) > datetime(?, 'unixepoch')`, Math.floor(dayMs / 1000))?.c || 0;
  d.business.gensDone24h = one(`SELECT COUNT(*) c FROM generations WHERE type='music' AND status='done' AND datetime(created_at) > datetime(?, 'unixepoch')`, Math.floor(dayMs / 1000))?.c || 0;
  d.business.gensError24h = one(`SELECT COUNT(*) c FROM generations WHERE type='music' AND status='error' AND datetime(created_at) > datetime(?, 'unixepoch')`, Math.floor(dayMs / 1000))?.c || 0;
  d.business.gensProcessing = one(`SELECT COUNT(*) c FROM generations WHERE status='processing'`)?.c || 0;
  d.business.lyrics24h = one(`SELECT COUNT(*) c FROM generations WHERE type='lyrics' AND status='done' AND datetime(created_at) > datetime(?, 'unixepoch')`, Math.floor(dayMs / 1000))?.c || 0;
  d.business.covers24h = one(`SELECT COUNT(*) c FROM generations WHERE type='cover' AND status='done' AND datetime(created_at) > datetime(?, 'unixepoch')`, Math.floor(dayMs / 1000))?.c || 0;
  d.business.plays24h = one(`SELECT COUNT(*) c FROM gen_activity WHERE action='play' AND datetime(created_at) > datetime('now','-24 hours')`)?.c || 0;
  d.business.activeSubscriptions = one(`SELECT COUNT(*) c FROM premium_subscriptions WHERE status='active'`)?.c || 0;
  d.business.visitors24h = one(`SELECT COUNT(DISTINCT ip) c FROM gen_activity WHERE datetime(created_at) > datetime('now','-24 hours')`)?.c || 0;

  // Критерии КРИТИЧНОГО (немедленный алерт)
  if (d.agents.errored.length > 0) d.critical.push(`🔴 Агенты в ошибке: ${d.agents.errored.join(", ")}`);
  if (d.generations.stuck >= 5) d.critical.push(`🔴 Зависших генераций: ${d.generations.stuck}`);
  if (d.support.urgent >= 3) d.critical.push(`🔴 Срочных тикетов: ${d.support.urgent}`);
  if (d.feedback.escalationsOpen >= 5) d.critical.push(`🔴 Открытых эскалаций: ${d.feedback.escalationsOpen}`);
  if (d.payments.total24h >= 4 && d.payments.failed24h / d.payments.total24h >= 0.5) d.critical.push(`🔴 Платежи: ${d.payments.failed24h}/${d.payments.total24h} провалов за 24ч`);
  if (d.frontend.errorsLastHour >= 20) d.critical.push(`🔴 Фронтенд: ${d.frontend.errorsLastHour} ошибок за час`);

  return d;
}

function formatDigest(d: DigestData, label: string): string {
  const lines: string[] = [`🎬 <b>Директор — срез ${label}</b>`, ""];
  lines.push(`🤖 Агентов: ${d.agents.total}${d.agents.errored.length ? `, 🔴 ошибка: ${d.agents.errored.join(", ")}` : ""}${d.agents.stale.length ? `, 🟡 молчат: ${d.agents.stale.join(", ")}` : ""}${!d.agents.errored.length && !d.agents.stale.length ? " — все ✅" : ""}`);
  lines.push(`🎵 Генерации: зависших ${d.generations.stuck}, эскалаций ${d.generations.escalated}`);
  if (d.finance) lines.push(`💰 Сегодня: выручка ${d.finance.revenueRub} ₽, прибыль ${d.finance.profitRub} ₽`);
  lines.push(`🆘 Поддержка: открыто ${d.support.open}${d.support.urgent ? ` (срочных ${d.support.urgent})` : ""}`);
  lines.push(`📣 Обратная связь: эскалаций ${d.feedback.escalationsOpen}, негатив 24ч ${d.feedback.negative24h}`);
  lines.push(`💳 Платежи 24ч: ${d.payments.total24h}${d.payments.failed24h ? `, провалов ${d.payments.failed24h}` : ""}`);
  lines.push(`🖥 Фронтенд: ошибок за час ${d.frontend.errorsLastHour}`);
  const b = d.business;
  lines.push(`👥 Бизнес 24ч: регистраций ${b.registrations24h}, посетителей ${b.visitors24h}, плеев ${b.plays24h}`);
  lines.push(`🎼 Создано 24ч: треков ${b.gensDone24h} (ошибок ${b.gensError24h}, в работе ${b.gensProcessing}), текстов ${b.lyrics24h}, каверов ${b.covers24h}`);
  lines.push(`⭐ Активных подписок: ${b.activeSubscriptions}`);
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
    await notifyBoss(msg);
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
    // Через directorAlert (dedup с другими источниками критики).
    directorAlert(`critical-scan:${key}`, msg, 60 * 60_000);
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

/** Eugene 2026-05-25 Босс «текстовый отчёт каждый день, веди архив».
 *  Полный текст-отчёт (все направления + AI-анализ) → сохраняется kind='daily'
 *  (архив 90 дней). Вызывается daily-cron. Возвращает id записи. */
export async function buildAndSaveDailyReport(): Promise<number | null> {
  try {
    const d = await collectDigestData();
    const ai = await analyzeWithAI(d).catch(() => null);
    const dateLabel = new Date(Date.now() + 3 * 3600_000).toISOString().slice(0, 10); // МСК-дата
    const base = formatDigest(d, `день ${dateLabel}`).replace(/<\/?b>/g, "");
    const text = ai ? `${base}\n\n🧠 Анализ и предложения:\n${ai}` : base;
    const { saveDirectorReport } = await import("./directorReportStore");
    return saveDirectorReport({ period: "daily", periodLabel: `Ежедневный отчёт ${dateLabel}`, text, kind: "daily" });
  } catch (e) {
    console.warn("[directorDigest] buildAndSaveDailyReport failed:", e);
    return null;
  }
}
