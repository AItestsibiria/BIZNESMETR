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

/** Плановый дайджест (03:00 / 14:00 МСК). */
export async function sendDailyDigest(label: string): Promise<void> {
  try {
    const d = await collectDigestData();
    try {
      const { recordAgentActivity } = await import("./agentOrchestrator");
      recordAgentActivity("director-digest", { label });
    } catch {}
    notifyBossTelegram(formatDigest(d, label));
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
    notifyBossTelegram(`🚨 <b>Директор — КРИТИЧНО</b>\n\n${d.critical.join("\n")}\n\nЗайди в /admin/v304 → 🎬 Музa Директор.`);
  } catch (e) {
    console.warn("[directorDigest] checkCritical failed:", e);
  }
}
