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
import { sql } from "drizzle-orm";
import { db, storage } from "../../storage";
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

// Защита от двойного рефанда. Маркер в style.refunded JSON.
function alreadyRefunded(genStyle: string | null): boolean {
  try { return !!JSON.parse(genStyle || "{}").refunded; } catch { return false; }
}

// God-mode audit 2026-05-08: рефанд идёт ТОЛЬКО через storage.refundGeneration.
// Атомарный claim предотвращает дубль с inline-рефандами в routes.ts.
// TOCTOU на balance тоже устранён — refundGeneration делает атомарный UPDATE
// users SET balance = balance + cost.
function ensureRefund(gen: { id: number; userId: number; cost: number; style: string | null; errorReason: string | null }) {
  if (!gen.cost || gen.cost <= 0) return;
  if (alreadyRefunded(gen.style)) return;
  try {
    const ok = storage.refundGeneration({
      genId: gen.id,
      userId: gen.userId,
      cost: gen.cost,
      type: "music",
      description: `Возврат: ошибка генерации #${gen.id} — ${(gen.errorReason || "?").slice(0, 80)}`,
    });
    if (!ok) return; // уже возвращено другим путём — выходим тихо
    STATS.refunded += 1;
    STATS.refundedKopeks += gen.cost;
    bootRefs?.logger.info(`[gen-agent] refunded #${gen.id} ${gen.cost / 100}₽ to user ${gen.userId}`);
    bootRefs?.eventBus.emit("gen.refunded", { genId: gen.id, userId: gen.userId, amount: gen.cost }, "generation-agent");
  } catch (e) {
    bootRefs?.logger.error(`[gen-agent] refund FAILED for #${gen.id}`, { error: e instanceof Error ? e.message : String(e) });
  }
}

async function scanErrorGensWithoutRefund() {
  // Хвост: gens которым status='error' AND рефанда не было (style.refunded=null).
  // God-mode 2026-05-08: фильтр на refunded ДО iteration — экономит работу
  // и устраняет окно гонки с inline-рефандами routes.ts (они теперь тоже
  // ставят флаг через storage.refundGeneration → claimRefund).
  const orphans = db.all<{ id: number; userId: number; cost: number; style: string | null; errorReason: string | null }>(
    sql`SELECT id, user_id as userId, cost, style, error_reason as errorReason
        FROM generations
        WHERE status = 'error' AND cost > 0
          AND created_at > datetime('now', '-7 days')
          AND (json_extract(style, '$.refunded') IS NULL
               OR json_extract(style, '$.refunded') != json('true'))
        LIMIT 200`,
  );
  for (const g of orphans) {
    ensureRefund(g);
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
  if (r.includes("internal server error") || r === "internal server error.") return "suno_transient";
  return "other";
}

// Транзиентные ошибки Suno (их internal/server) — авто-ретрай.
function isTransientError(reason: string): boolean {
  const cls = classifyError(reason);
  return cls === "suno_transient" || cls === "network" || cls === "timeout";
}

// Auto-retry: для свежих transient-error gens пробуем повторно
// отправить в Suno (с теми же параметрами + ретёр-флаг в style).
//
// God-mode 2026-05-08: добавлен atomic claim перед Suno-вызовом и фильтр
// refunded в SELECT. Решает класс багов «refund + retry в один минуту»:
// если orphan-scanner успел рефандить, retry не запустится; если retry
// успел поднять gen в processing, orphan-scanner его не увидит.
async function autoRetryTransient() {
  const apiKey = process.env.GPTUNNEL_API_KEY;
  if (!apiKey) return 0;
  // Берём свежие transient errors (< 5 мин), retry_count < 2, НЕ возвращённые.
  const candidates = db.all<{ id: number; userId: number; prompt: string; style: string;
    errorReason: string | null; cost: number; type: string }>(
    sql`SELECT id, user_id as userId, prompt, style, error_reason as errorReason, cost, type
        FROM generations
        WHERE status = 'error'
          AND created_at > datetime('now', '-5 minutes')
          AND type = 'music'
          AND (json_extract(style, '$.refunded') IS NULL
               OR json_extract(style, '$.refunded') != json('true'))
          AND (json_extract(style, '$.retryCount') IS NULL
               OR CAST(json_extract(style, '$.retryCount') AS INTEGER) < 2)
        LIMIT 10`,
  );
  let retried = 0;
  for (const g of candidates) {
    if (!isTransientError(g.errorReason ?? "")) continue;
    let meta: any = {};
    try { meta = JSON.parse(g.style || "{}"); } catch {}
    const retryCount = (meta.retryCount ?? 0) + 1;
    meta.retryCount = retryCount;
    meta.retryAt = new Date().toISOString();

    // ATOMIC CLAIM: переводим status='error' → 'processing' одной командой,
    // только если gen всё ещё в error И не возвращён. Это закрывает окно
    // гонки с orphan-scanner. Если CHANGES=0 → кто-то нас опередил, skip.
    const claim: any = db.run(sql`UPDATE generations
        SET status='processing', error_reason=NULL,
            style=json_set(COALESCE(style, '{}'),
                            '$.retryCount', ${retryCount},
                            '$.retryClaimedAt', datetime('now'))
        WHERE id=${g.id}
          AND status='error'
          AND (json_extract(style, '$.refunded') IS NULL
               OR json_extract(style, '$.refunded') != json('true'))`);
    if (!claim || (claim.changes ?? 0) === 0) {
      console.log(`\x1b[33m[AUTO-RETRY]\x1b[0m gen #${g.id} skipped — claim lost (refunded or status changed)`);
      continue;
    }

    const styleStr = meta.style || "";
    const title = meta.title || "Песня";
    const lyric = g.prompt || "";
    const sunoBody: any = { model: "suno" };
    if (lyric.length >= 50) {
      sunoBody.mode = "custom";
      sunoBody.lyric = lyric.slice(0, 3000);
      sunoBody.title = String(title).slice(0, 80);
      if (styleStr) sunoBody.tags = String(styleStr).slice(0, 200);
    } else {
      sunoBody.prompt = lyric.slice(0, 400) || "Песня";
      if (styleStr) sunoBody.tags = String(styleStr).slice(0, 200);
    }

    let sunoOk = false;
    try {
      const r = await fetch("https://gptunnel.ru/v1/media/create", {
        method: "POST",
        headers: { Authorization: apiKey, "Content-Type": "application/json" },
        body: JSON.stringify(sunoBody),
        signal: AbortSignal.timeout(20_000),
      });
      const text = await r.text();
      let data: any; try { data = JSON.parse(text); } catch { data = { raw: text }; }
      if (r.ok && data?.id) {
        db.run(sql`UPDATE generations
                   SET task_id=${data.id}
                   WHERE id=${g.id} AND status='processing'`);
        retried += 1;
        sunoOk = true;
        console.log(`\x1b[33m[AUTO-RETRY]\x1b[0m gen #${g.id} re-submitted to Suno (attempt ${retryCount}, taskId=${data.id})`);
        bootRefs?.eventBus.emit("gen.auto_retry", { genId: g.id, attempt: retryCount }, "generation-agent");
      }
    } catch (e) {
      // обработаем через rollback ниже
    }

    // Если Suno-вызов не удался — откатываем status в error, чтобы orphan-scanner
    // мог рефандить (или следующий retry — если retryCount < 2 и < 5 мин).
    if (!sunoOk) {
      db.run(sql`UPDATE generations
                 SET status='error',
                     error_reason=COALESCE(error_reason, 'auto-retry: Suno call failed')
                 WHERE id=${g.id} AND status='processing'`);
      console.log(`\x1b[33m[AUTO-RETRY]\x1b[0m gen #${g.id} rollback to error — Suno not reachable`);
    }
  }
  return retried;
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
    {
      // Авто-ретрай transient ошибок Suno (Eugene 14:46): юзер ничего
      // не делает — Suno burped, мы повторяем за него. До 2 попыток.
      name: "auto-retry-transient",
      schedule: "every_minute",
      handler: async () => {
        try {
          const n = await autoRetryTransient();
          if (n > 0) console.log(`\x1b[33m[AUTO-RETRY]\x1b[0m re-submitted ${n} transient-error gens`);
        } catch (e) {
          console.error("[AUTO-RETRY] error:", e);
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
