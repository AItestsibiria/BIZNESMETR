// Eugene 2026-05-24 Босс: «назначь в проекте MuzaAi агента который отслеживает
// цикл от нажатия генерации (трек / текст / обложка), полностью отслеживает
// цикл, исправляет ошибки. Дай возможность продавливать Suno до генерации.
// Если он отработает на 100% — техподдержка в релаксе.»
//
// GenerationLifecycleAgent — единый watchdog для life-cycle всех generations
// (music / lyrics / cover). Отслеживает каждую gen от создания до done/errored,
// авто-fix'ит transient errors через aggressive retry («продавливает Suno»),
// эскалирует неразрешимые в orchestrator (→ marketing-orchestrator для
// apology email / поддержки).
//
// Архитектура:
//  - In-memory store (Map<genId, events[]>) с LRU eviction (max 500 gens)
//  - Каждое событие также пишется в `gen_lifecycle_log` (для admin UI history)
//  - Retry policy: до 3 попыток с exponential backoff (30s / 2min / 5min)
//  - Stuck detection: gen.status='processing' > 5 min — auto-resume или escalate
//  - НЕ дублирует pollProcessingGenerations (admin-overview) — расширяет
//  - НЕ дублирует generation-agent plugin (`refund-orphans` watchdog) —
//    работает на ВЫШЕ уровне (lifecycle tracking, not just refund страховка)
//
// Связано с:
//  - lib/agentOrchestrator.ts — register + events
//  - storage.refundGeneration + claimRefund — atomic refund (Reuse-working-solutions rule)
//  - plugins/admin-overview/module.ts pollProcessingGenerations — alongside
//  - shared/schema.ts genLifecycleLog — persistent history
//
// Эскалация:
//  - emitOrchestratorEvent("gen.escalated", {genId, reason}) → marketing для apology email
//  - emitOrchestratorEvent("gen.stuck", {genId, ageMin}) → admin alert
//  - emitOrchestratorEvent("gen.recovered", {genId, attempts}) → success metric

import { sql } from "drizzle-orm";
import { db, storage } from "../storage";
import { emitOrchestratorEvent, recordAgentActivity } from "./agentOrchestrator";
import { logUserActionFailure } from "./userActionFailures";

// =================== ТИПЫ ===================

export type GenLifecycleEventType =
  | "started"             // gen создана + charge прошёл
  | "suno_called"         // GPTunnel /media/create вернул task_id
  | "suno_failed"         // GPTunnel ответил error
  | "stuck_processing"    // > 5 мин в processing — пинаем
  | "retrying"            // запущен retry attempt N
  | "done"                // успешно завершена
  | "errored"             // permanent error
  | "refunded"            // refund pipeline сработал
  | "manual_retry"        // admin нажал «Дожать»
  | "manual_refund"       // admin нажал «Refund»
  | "manual_resolve"      // admin отметил resolved
  | "escalated";          // > 3 attempts + permanent — эскалация в marketing

export interface GenLifecycleEvent {
  type: GenLifecycleEventType;
  ts: number;                        // millis
  genId: number;
  userId?: number;
  payload?: Record<string, unknown>; // type-specific data
}

interface RetryResult {
  ok: boolean;
  taskId?: string;
  error?: string;
  attempt: number;
}

interface ScanResult {
  scanned: number;
  resumed: number;
  escalated: number;
  recovered: number;
}

interface RecoverResult {
  recovered: boolean;
  reason?: string;
  action?: "retry" | "refund" | "escalate" | "noop";
}

interface AgentStats {
  totalTracked: number;
  recovered: number;
  escalated: number;
  manualRetries: number;
  manualRefunds: number;
  bySinceTs: Record<string, number>;  // ISO date → count of events
  lastScanAt: number | null;
  lastError: string | null;
}

// =================== STORE ===================

const MAX_TRACKED_GENS = 500;
const eventsByGen = new Map<number, GenLifecycleEvent[]>();
const STATS: AgentStats = {
  totalTracked: 0,
  recovered: 0,
  escalated: 0,
  manualRetries: 0,
  manualRefunds: 0,
  bySinceTs: {},
  lastScanAt: null,
  lastError: null,
};

// Retry attempt timestamps (для backoff) — Map<genId, last retry ts millis>
const lastRetryByGen = new Map<number, number>();

// =================== INTERNAL HELPERS ===================

/**
 * Persist event в gen_lifecycle_log table. Never throws.
 */
function persistEvent(event: GenLifecycleEvent): void {
  try {
    const payloadStr = event.payload ? JSON.stringify(event.payload).slice(0, 2000) : null;
    db.run(sql`INSERT INTO gen_lifecycle_log
               (gen_id, user_id, event_type, payload, created_at)
               VALUES (${event.genId}, ${event.userId ?? null},
                       ${event.type}, ${payloadStr},
                       ${event.ts})`);
  } catch (e: any) {
    // Never throw — log table may not exist yet during early boot
    if (!String(e?.message || "").includes("no such table")) {
      console.warn("[gen-lifecycle] persistEvent warn:", e?.message || e);
    }
  }
}

/**
 * Add event to in-memory store + persist. Also evict LRU if > MAX.
 */
function addEvent(event: GenLifecycleEvent): void {
  // Eviction: если store превысил лимит, удаляем самый старый key (Map preserves insertion order)
  if (eventsByGen.size >= MAX_TRACKED_GENS && !eventsByGen.has(event.genId)) {
    const firstKey = eventsByGen.keys().next().value;
    if (firstKey !== undefined) eventsByGen.delete(firstKey);
  }
  const list = eventsByGen.get(event.genId) || [];
  list.push(event);
  eventsByGen.set(event.genId, list);

  // Track daily counters (last 7 days)
  try {
    const dateKey = new Date(event.ts).toISOString().slice(0, 10);
    STATS.bySinceTs[dateKey] = (STATS.bySinceTs[dateKey] || 0) + 1;
    // Cleanup old date keys (> 7 days ago)
    const cutoff = new Date(Date.now() - 7 * 86400_000).toISOString().slice(0, 10);
    for (const k of Object.keys(STATS.bySinceTs)) {
      if (k < cutoff) delete STATS.bySinceTs[k];
    }
  } catch {}

  persistEvent(event);
}

/**
 * Get generation row минимально-нужными полями. Returns null если not found.
 */
function getGenForRetry(genId: number): {
  id: number; userId: number; cost: number; status: string; type: string;
  prompt: string; style: string | null; errorReason: string | null;
} | null {
  try {
    const row = db.get<{
      id: number; userId: number; cost: number; status: string; type: string;
      prompt: string; style: string | null; errorReason: string | null;
    }>(sql`SELECT id, user_id as userId, cost, status, type, prompt, style, error_reason as errorReason
           FROM generations WHERE id = ${genId}`);
    return row || null;
  } catch {
    return null;
  }
}

/**
 * Classify error reason → category (для статистики и retry-decision).
 * Совпадает с classifyError в generation-agent/module.ts (для consistency).
 */
function classifyError(reason: string): string {
  const r = (reason || "").toLowerCase();
  if (r.includes("sensitive") || r.includes("1001") || r.includes("content")) return "moderation";
  if (r.includes("invalid") && r.includes("token")) return "invalid_key";
  if (r.includes("invalid") && r.includes("lyric")) return "bad_lyric";
  if (r.includes("timeout") || r.includes("> 30") || r.includes("> 8")) return "timeout";
  if (r.includes("network") || r.includes("fetch failed")) return "network";
  if (r.includes("insufficient") || r.includes("balance")) return "low_balance";
  if (r.includes("audio") && r.includes("недоступен")) return "audio_unavailable";
  if (r.includes("internal server error") || r === "internal server error.") return "suno_transient";
  if (r.includes("rate limit") || r.includes("429")) return "rate_limit";
  return "other";
}

/**
 * Можно ли retry'ить эту ошибку?
 * - moderation / bad_lyric / low_balance — НЕЛЬЗЯ (юзеру нужно fix input или topup)
 * - invalid_key — нельзя (надо ротировать ключ — admin action)
 * - всё остальное — можно retry
 */
function canRetry(reason: string): boolean {
  const cls = classifyError(reason);
  return !["moderation", "bad_lyric", "low_balance", "invalid_key"].includes(cls);
}

/**
 * Сколько уже было retry attempts для этой gen?
 * Источник правды — events в store + meta.retryCount в gen.style.
 */
function getAttemptCount(genId: number): number {
  const events = eventsByGen.get(genId) || [];
  return events.filter(e => e.type === "retrying" || e.type === "manual_retry").length;
}

/**
 * Backoff delay в ms для attempt N.
 * 1 → 30s, 2 → 2min, 3 → 5min, далее — escalate.
 */
function getBackoffMs(attempt: number): number {
  const map: Record<number, number> = { 1: 30_000, 2: 120_000, 3: 300_000 };
  return map[attempt] ?? Infinity;
}

// =================== PUBLIC API ===================

/**
 * Track lifecycle event. Sync, never throws. Hook this from anywhere
 * (route handler, webhook, watchdog).
 */
export function trackEvent(event: Omit<GenLifecycleEvent, "ts"> & { ts?: number }): void {
  try {
    const full: GenLifecycleEvent = { ...event, ts: event.ts ?? Date.now() };
    addEvent(full);

    if (full.type === "started") STATS.totalTracked += 1;
    if (full.type === "done") STATS.recovered += getAttemptCount(full.genId) > 0 ? 1 : 0;
    if (full.type === "escalated") STATS.escalated += 1;
    if (full.type === "manual_retry") STATS.manualRetries += 1;
    if (full.type === "manual_refund") STATS.manualRefunds += 1;

    // Activity tracking для orchestrator
    recordAgentActivity("gen-lifecycle", { event: full.type, genId: full.genId });

    // Emit orchestrator event на эскалацию / recovery / stuck
    if (full.type === "escalated") {
      emitOrchestratorEvent("gen.escalated", {
        genId: full.genId,
        userId: full.userId,
        reason: (full.payload as any)?.reason || "unknown",
      });
    } else if (full.type === "stuck_processing") {
      emitOrchestratorEvent("gen.stuck", {
        genId: full.genId,
        userId: full.userId,
        ageMin: (full.payload as any)?.ageMin || 0,
      });
    } else if (full.type === "done" && getAttemptCount(full.genId) > 0) {
      emitOrchestratorEvent("gen.recovered", {
        genId: full.genId,
        userId: full.userId,
        attempts: getAttemptCount(full.genId),
      });
    }
  } catch (e) {
    STATS.lastError = (e as Error)?.message || String(e);
  }
}

/**
 * Retry Suno generation — «продавить» до результата.
 *
 * Аggressively повторяет /media/create с теми же params (из gen.style).
 * Использует atomic claim чтобы избежать races с orphan-scanner.
 * После 3 attempts → escalate + refund.
 *
 * Reuse-working-solutions rule: НЕ создаём новый pipeline — берём
 * существующий /media/create endpoint GPTunnel + storage.updateGeneration.
 */
export async function retrySuno(genId: number, attempt: number = 1): Promise<RetryResult> {
  const apiKey = process.env.GPTUNNEL_API_KEY;
  if (!apiKey) {
    return { ok: false, error: "GPTUNNEL_API_KEY not configured", attempt };
  }

  const gen = getGenForRetry(genId);
  if (!gen) return { ok: false, error: "Generation not found", attempt };
  if (gen.type !== "music") return { ok: false, error: "Retry only for music type", attempt };

  // Backoff check
  const lastRetry = lastRetryByGen.get(genId) || 0;
  const requiredDelay = getBackoffMs(attempt);
  if (Date.now() - lastRetry < requiredDelay && lastRetry > 0) {
    return { ok: false, error: `Backoff in progress (${Math.round((requiredDelay - (Date.now() - lastRetry)) / 1000)}s)`, attempt };
  }

  if (attempt > 3) {
    // Escalate: refund + emit
    trackEvent({ type: "escalated", genId, userId: gen.userId, payload: { reason: gen.errorReason, finalAttempt: attempt } });
    if (gen.cost > 0) {
      const refunded = storage.refundGeneration({
        genId, userId: gen.userId, cost: gen.cost, type: "music",
        description: `Возврат: gen-lifecycle agent эскалация #${genId} после ${attempt - 1} попыток`,
      });
      if (refunded) {
        trackEvent({ type: "refunded", genId, userId: gen.userId, payload: { cost: gen.cost, by: "agent_escalation" } });
      }
    }
    return { ok: false, error: `Escalated after ${attempt - 1} attempts`, attempt };
  }

  // Parse gen.style для воспроизведения payload
  let meta: any = {};
  try { meta = JSON.parse(gen.style || "{}"); } catch {}

  // ATOMIC CLAIM: переводим status в processing (только если error И не refunded)
  const claim: any = db.run(sql`UPDATE generations
      SET status='processing', error_reason=NULL,
          style=json_set(COALESCE(style, '{}'),
                          '$.retryCount', ${attempt},
                          '$.retryClaimedAt', datetime('now'),
                          '$.retryBy', 'gen-lifecycle-agent')
      WHERE id=${genId}
        AND status IN ('error', 'processing')
        AND (json_extract(style, '$.refunded') IS NULL
             OR json_extract(style, '$.refunded') != json('true'))`);
  if (!claim || (claim.changes ?? 0) === 0) {
    return { ok: false, error: "Claim lost (refunded or already retrying)", attempt };
  }

  lastRetryByGen.set(genId, Date.now());
  trackEvent({ type: "retrying", genId, userId: gen.userId, payload: { attempt, reason: gen.errorReason } });

  // Воспроизводим payload по сохранённым полям в style (avoid guessing)
  const sunoBody: any = { model: "suno" };
  const styleStr = meta.style || "";
  const title = meta.title || "Песня";
  const originalMode = meta.mode || "basic";
  if (originalMode === "custom" && meta.lyric) {
    sunoBody.mode = "custom";
    sunoBody.lyric = String(meta.lyric).slice(0, 3000);
    sunoBody.title = String(title).slice(0, 80);
    if (meta.tags || styleStr) sunoBody.tags = String(meta.tags || styleStr).slice(0, 200);
  } else {
    const basicPrompt = meta.basicPrompt || gen.prompt || "Песня";
    sunoBody.prompt = String(basicPrompt).slice(0, 400);
    if (meta.tags || styleStr) sunoBody.tags = String(meta.tags || styleStr).slice(0, 200);
  }

  try {
    const r = await fetch("https://gptunnel.ru/v1/media/create", {
      method: "POST",
      headers: { Authorization: apiKey, "Content-Type": "application/json" },
      body: JSON.stringify(sunoBody),
      signal: AbortSignal.timeout(35_000),
    });
    const text = await r.text();
    let data: any;
    try { data = JSON.parse(text); } catch { data = { raw: text }; }

    if (r.ok && data?.id) {
      db.run(sql`UPDATE generations SET task_id=${data.id}
                 WHERE id=${genId} AND status='processing'`);
      trackEvent({ type: "suno_called", genId, userId: gen.userId, payload: { taskId: data.id, attempt } });
      return { ok: true, taskId: data.id, attempt };
    }

    // Suno вернул error
    const errMsg = data?.error?.message || data?.message || `HTTP ${r.status}`;
    db.run(sql`UPDATE generations
               SET status='error', error_reason=${`agent retry ${attempt}: ${errMsg}`.slice(0, 500)}
               WHERE id=${genId} AND status='processing'`);
    trackEvent({ type: "suno_failed", genId, userId: gen.userId, payload: { error: errMsg, attempt } });
    return { ok: false, error: errMsg, attempt };
  } catch (e: any) {
    const errMsg = e?.message || String(e);
    db.run(sql`UPDATE generations
               SET status='error', error_reason=${`agent retry ${attempt}: ${errMsg}`.slice(0, 500)}
               WHERE id=${genId} AND status='processing'`);
    trackEvent({ type: "suno_failed", genId, userId: gen.userId, payload: { error: errMsg, attempt } });
    return { ok: false, error: errMsg, attempt };
  }
}

/**
 * Periodic scan — найти стуки в processing > 5 мин и pinguть GPTunnel,
 * либо escalate если задержка > 30 мин.
 *
 * Дополняет (не дублирует) pollProcessingGenerations из admin-overview:
 * там polling logic для done/error → здесь только detection + escalation.
 */
export async function scanStuckGenerations(): Promise<ScanResult> {
  const result: ScanResult = { scanned: 0, resumed: 0, escalated: 0, recovered: 0 };
  try {
    STATS.lastScanAt = Date.now();
    const stuckRows = db.all<{ id: number; userId: number; createdAt: string; cost: number; taskId: string | null }>(
      sql`SELECT id, user_id as userId, created_at as createdAt, cost, task_id as taskId
          FROM generations
          WHERE status = 'processing' AND type = 'music'
            AND created_at < datetime('now', '-5 minutes')
          LIMIT 50`,
    );
    result.scanned = stuckRows.length;

    for (const row of stuckRows) {
      const createdMs = new Date(row.createdAt + (row.createdAt.includes("T") ? "" : "Z")).getTime();
      const ageMin = Math.round((Date.now() - createdMs) / 60_000);

      trackEvent({
        type: "stuck_processing",
        genId: row.id,
        userId: row.userId,
        payload: { ageMin, taskId: row.taskId },
      });

      // > 30 мин — force escalation (refund + alert)
      if (ageMin > 30) {
        const refunded = row.cost > 0 ? storage.refundGeneration({
          genId: row.id, userId: row.userId, cost: row.cost, type: "music",
          description: `Возврат: gen #${row.id} застряла на ${ageMin} мин`,
        }) : false;
        db.run(sql`UPDATE generations SET status='error',
                   error_reason=${`Зависание ${ageMin} мин — отменено агентом lifecycle`}
                   WHERE id=${row.id} AND status='processing'`);
        if (refunded) {
          trackEvent({ type: "refunded", genId: row.id, userId: row.userId, payload: { cost: row.cost, by: "stuck_escalation" } });
        }
        trackEvent({ type: "escalated", genId: row.id, userId: row.userId, payload: { reason: `stuck_${ageMin}min` } });
        result.escalated += 1;

        // user-action failure registry
        logUserActionFailure({
          userId: row.userId, channel: "api", action: "music_generate",
          errorCode: "stuck_processing", errorMessage: `Gen #${row.id} stuck for ${ageMin} min`,
          context: { genId: row.id, taskId: row.taskId, ageMin },
        });
      } else {
        // 5-30 мин: пинаем polling (через event), скоро admin-overview подхватит
        result.resumed += 1;
      }
    }
  } catch (e: any) {
    STATS.lastError = e?.message || String(e);
  }
  return result;
}

/**
 * Attempt auto-recovery для одной gen (после suno_failed event).
 * Решает: retry / refund / escalate / noop.
 */
export async function attemptAutoRecover(genId: number): Promise<RecoverResult> {
  const gen = getGenForRetry(genId);
  if (!gen) return { recovered: false, reason: "not_found", action: "noop" };

  // Уже done — noop
  if (gen.status === "done") return { recovered: true, reason: "already_done", action: "noop" };

  // Уже не error — noop
  if (gen.status !== "error") return { recovered: false, reason: `status=${gen.status}`, action: "noop" };

  // Не retryable error class — escalate
  if (!canRetry(gen.errorReason || "")) {
    trackEvent({ type: "escalated", genId, userId: gen.userId, payload: { reason: gen.errorReason, class: classifyError(gen.errorReason || "") } });
    return { recovered: false, reason: `non-retryable: ${classifyError(gen.errorReason || "")}`, action: "escalate" };
  }

  const attempts = getAttemptCount(genId);
  if (attempts >= 3) {
    // Forced escalation после 3 попыток
    if (gen.cost > 0) {
      storage.refundGeneration({
        genId, userId: gen.userId, cost: gen.cost, type: "music",
        description: `Возврат: 3 попытки исчерпаны #${genId}`,
      });
    }
    trackEvent({ type: "escalated", genId, userId: gen.userId, payload: { reason: "max_attempts" } });
    return { recovered: false, reason: "max_attempts_reached", action: "escalate" };
  }

  // Try retry
  const r = await retrySuno(genId, attempts + 1);
  if (r.ok) {
    return { recovered: true, action: "retry" };
  }
  return { recovered: false, reason: r.error, action: "retry" };
}

/**
 * Get full report для одной gen — все events + summary.
 * Используется в admin UI drawer.
 */
export function getReport(genId: number): {
  events: GenLifecycleEvent[];
  status: "ok" | "retrying" | "escalated" | "unknown";
  attemptCount: number;
} {
  const events = eventsByGen.get(genId) || [];
  const hasEscalation = events.some(e => e.type === "escalated");
  const hasDone = events.some(e => e.type === "done");
  const hasRetrying = events.some(e => e.type === "retrying" || e.type === "manual_retry");

  let status: "ok" | "retrying" | "escalated" | "unknown" = "unknown";
  if (hasDone) status = "ok";
  else if (hasEscalation) status = "escalated";
  else if (hasRetrying) status = "retrying";

  return {
    events,
    status,
    attemptCount: getAttemptCount(genId),
  };
}

/**
 * Get persisted events from БД (для admin drawer когда gen не в memory).
 */
export function getReportFromDb(genId: number): GenLifecycleEvent[] {
  try {
    const rows = db.all<{
      gen_id: number; user_id: number | null; event_type: string;
      payload: string | null; created_at: number;
    }>(sql`SELECT gen_id, user_id, event_type, payload, created_at
           FROM gen_lifecycle_log
           WHERE gen_id = ${genId}
           ORDER BY created_at ASC
           LIMIT 200`);
    return rows.map(r => ({
      type: r.event_type as GenLifecycleEventType,
      ts: r.created_at,
      genId: r.gen_id,
      userId: r.user_id ?? undefined,
      payload: r.payload ? safeParse(r.payload) : undefined,
    }));
  } catch {
    return [];
  }
}

function safeParse(s: string): Record<string, unknown> | undefined {
  try { return JSON.parse(s); } catch { return undefined; }
}

/**
 * Stats для healthCheck + admin dashboard.
 *
 * Eugene 2026-05-30: переименовано из `getStats` → `getGenLifecycleStats`
 * чтобы устранить duplicate-symbol с `postmanAgent.getStats`. Старое имя
 * остаётся доступным через singleton `genLifecycleAgent.getStats` (см. ниже)
 * для обратной совместимости вызовов через объект-агрегатор.
 */
export function getGenLifecycleStats(): AgentStats {
  return { ...STATS, bySinceTs: { ...STATS.bySinceTs } };
}

/**
 * Reset stats (для тестов).
 */
export function resetStats(): void {
  STATS.totalTracked = 0;
  STATS.recovered = 0;
  STATS.escalated = 0;
  STATS.manualRetries = 0;
  STATS.manualRefunds = 0;
  STATS.bySinceTs = {};
  STATS.lastError = null;
  eventsByGen.clear();
  lastRetryByGen.clear();
}

// =================== EXPORT singleton ===================

export const genLifecycleAgent = {
  trackEvent,
  retrySuno,
  scanStuckGenerations,
  attemptAutoRecover,
  getReport,
  getReportFromDb,
  getStats: getGenLifecycleStats,
  classifyError,
  canRetry,
};
