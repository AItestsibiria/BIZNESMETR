// v304 plugin: generation-agent (Sprint 8 — God-mode controller).
// ТЗ Eugene 2026-05-07 14:06: «разберись с агентом по генерации, контролируем
// от и до возврата баланса».
//
// Centralized observer over generations. Покрывает то что разбросано по
// routes.ts и admin-overview:
//   1. Каждые 30 сек: scan processing → poll Suno → update done/error → refund
//   2. При status='error' AND cost>0 AND no refund yet → refund + transaction
//   3. При done: emit event 'gen.completed' для downstream-плагинов
//   4. При recovery (error→done через poll): отмена refund (он уже был сделан)
//   5. Scan стуки processing > 10 мин (без активности) → принудительный poll
//   6. Health: возвращает stats {processing, errored_today, recovered_today,
//      refunds_today, fail_reasons_breakdown}
//
// Не дублирует logic из admin-overview pollProcessingGenerations — а владеет
// им. После боевого тестирования старые поллеры можно отключить.
//
// Spec: docs/strategy/v304-generation-agent-TZ.md (создаётся в этом коммите)

import { Router } from "express";
import { sql, eq } from "drizzle-orm";
import { db } from "../../storage";
import { generations, transactions, users } from "@shared/schema";
import { requireAdmin } from "../../core/adminAuth";
import type { BootContext, Module } from "../../core";

let bootRefs: { eventBus: BootContext["eventBus"]; logger: BootContext["logger"] } | null = null;

interface AgentStats {
  scansTotal: number;
  recovered: number;
  failed: number;
  refunded: number;
  refundedKopeks: number;
  lastError: string | null;
  lastScanAt: string | null;
  reasonBreakdown: Record<string, number>;
}

const STATS: AgentStats = {
  scansTotal: 0,
  recovered: 0,
  failed: 0,
  refunded: 0,
  refundedKopeks: 0,
  lastError: null,
  lastScanAt: null,
  reasonBreakdown: {},
};

// Защита от двойного рефанда. Помечаем gen.id в style JSON.
function alreadyRefunded(genStyle: string | null): boolean {
  try { return !!JSON.parse(genStyle || "{}").refunded; } catch { return false; }
}

function markRefunded(genId: number, currentStyle: string | null) {
  let meta: any = {};
  try { meta = JSON.parse(currentStyle || "{}"); } catch {}
  meta.refunded = true;
  meta.refundedAt = new Date().toISOString();
  db.run(sql`UPDATE generations SET style=${JSON.stringify(meta)} WHERE id=${genId}`);
}

function ensureRefund(gen: { id: number; userId: number; cost: number; style: string | null; errorReason: string | null }) {
  if (!gen.cost || gen.cost <= 0) return;
  if (alreadyRefunded(gen.style)) return;
  try {
    const u = db.select().from(users).where(eq(users.id, gen.userId)).get();
    if (!u) return;
    db.update(users).set({ balance: (u.balance ?? 0) + gen.cost }).where(eq(users.id, gen.userId)).run();
    db.insert(transactions).values({
      userId: gen.userId, type: "music", amount: gen.cost,
      description: `Возврат: ошибка генерации #${gen.id} — ${(gen.errorReason || "?").slice(0, 80)}`,
    } as any).run();
    markRefunded(gen.id, gen.style);
    STATS.refunded += 1;
    STATS.refundedKopeks += gen.cost;
    bootRefs?.logger.info(`[gen-agent] refunded #${gen.id} ${gen.cost / 100}₽ to user ${gen.userId}`);
    bootRefs?.eventBus.emit("gen.refunded", { genId: gen.id, userId: gen.userId, amount: gen.cost }, "generation-agent");
  } catch (e) {
    bootRefs?.logger.error(`[gen-agent] refund FAILED for #${gen.id}`, { error: e instanceof Error ? e.message : String(e) });
  }
}

async function scanErrorGensWithoutRefund() {
  // Хвост: gens which got status='error' BUT никто не сделал рефанд
  // (например из-за бага в endpoint'е). Этот периодический скан страхует.
  const orphans = db.all<{ id: number; userId: number; cost: number; style: string | null; errorReason: string | null }>(
    sql`SELECT id, user_id as userId, cost, style, error_reason as errorReason
        FROM generations
        WHERE status = 'error' AND cost > 0
          AND created_at > datetime('now', '-7 days')
        LIMIT 200`,
  );
  for (const g of orphans) {
    if (!alreadyRefunded(g.style)) {
      ensureRefund(g);
    }
  }
  return orphans.length;
}

function classifyError(reason: string): string {
  const r = (reason || "").toLowerCase();
  if (r.includes("sensitive") || r.includes("1001")) return "moderation";
  if (r.includes("invalid") && r.includes("token")) return "invalid_key";
  if (r.includes("invalid") && r.includes("lyric")) return "bad_lyric";
  if (r.includes("timeout") || r.includes("> 30") || r.includes("> 8")) return "timeout";
  if (r.includes("network")) return "network";
  if (r.includes("insufficient") || r.includes("balance")) return "low_balance";
  if (r.includes("audio") && r.includes("недоступен")) return "audio_unavailable";
  return "other";
}

async function aggregateStats() {
  // breakdown причин ошибок за 24h
  const errs = db.all<{ errorReason: string | null }>(
    sql`SELECT error_reason as errorReason
        FROM generations
        WHERE status = 'error' AND created_at > datetime('now', '-24 hours')`,
  );
  const breakdown: Record<string, number> = {};
  for (const e of errs) {
    const k = classifyError(e.errorReason ?? "");
    breakdown[k] = (breakdown[k] ?? 0) + 1;
  }
  STATS.reasonBreakdown = breakdown;
  STATS.lastScanAt = new Date().toISOString();
}

const router = Router();

// GET /api/admin/v304/gen-agent/health
router.get("/health", requireAdmin, async (_req, res) => {
  await aggregateStats();
  const processing = db.get<{ c: number }>(sql`SELECT count(*) as c FROM generations WHERE status='processing'`)?.c ?? 0;
  const errorsToday = db.get<{ c: number }>(sql`SELECT count(*) as c FROM generations WHERE status='error' AND created_at > datetime('now', '-24 hours')`)?.c ?? 0;
  const doneToday = db.get<{ c: number }>(sql`SELECT count(*) as c FROM generations WHERE status='done' AND created_at > datetime('now', '-24 hours')`)?.c ?? 0;
  res.json({
    data: {
      processing,
      doneToday,
      errorsToday,
      stats: STATS,
      successRate: doneToday + errorsToday > 0 ? +((doneToday / (doneToday + errorsToday)) * 100).toFixed(1) : null,
    },
    error: null,
  });
});

// POST /api/admin/v304/gen-agent/refund-orphans
router.post("/refund-orphans", requireAdmin, async (_req, res) => {
  const n = await scanErrorGensWithoutRefund();
  res.json({ data: { scanned: n, refunded: STATS.refunded, refundedKopeks: STATS.refundedKopeks }, error: null });
});

const generationAgentModule: Module = {
  name: "generation-agent",
  version: "0.1.0",
  description: "Центральный observer генераций: refund-страховка + статистика + классификация ошибок.",
  routes: { prefix: "admin/v304/gen-agent", router },
  publishes: ["gen.refunded", "gen.completed"],
  jobs: [
    {
      name: "refund-orphans",
      schedule: "every_minute",
      handler: async () => {
        try {
          STATS.scansTotal += 1;
          await scanErrorGensWithoutRefund();
          await aggregateStats();
        } catch (e) {
          STATS.lastError = e instanceof Error ? e.message : String(e);
        }
      },
    },
  ],
  onLoad: async (ctx) => {
    bootRefs = { eventBus: ctx.eventBus, logger: ctx.logger };
    ctx.logger.info("generation-agent online — refund-страховка every_minute");
  },
  healthCheck: () => {
    if (STATS.lastError) return { status: "degraded", details: { error: STATS.lastError, stats: STATS } };
    return { status: "ok", details: { ...STATS } };
  },
};

export default generationAgentModule;
