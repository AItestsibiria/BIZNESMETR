// v304 plugin: plays-analytics (Eugene 2026-05-21 Босс «админ-аналитика
// счётчика прослушиваний с разбивкой по периодам 1ч / 24ч / 7д / 30д /
// всё время»).
//
// Что делает:
//  - GET /api/admin/v304/plays-analytics?period=<P>
//      period: '1h' | '24h' | '7d' | '30d' | 'all' (default '1h')
//      Возвращает aggregate-метрики из gen_activity + counter из meta.plays:
//        - counter.current (sum meta.plays для is_public=1)
//        - counter.delta (play events за период)
//        - counter.deltaPct
//        - plays.counted (action='play')
//        - plays.rejected.<reason> (5 категорий из Play-counting rule)
//        - plays.rejectedTotal + ratio (counted / total)
//        - topTracks (TOP-5 по play events за период)
//        - uniqueIps (COUNT DISTINCT ip)
//        - ratePerMin
//        - comparison.previousPeriod (same window сдвинутый назад)
//        - comparison.growthPct
//
// Безопасность:
//  - requireAdmin middleware (admin / super_admin).
//  - Read-only — никаких изменений data.
//  - Не leak PII — IP не возвращаем raw (только COUNT DISTINCT).
//
// Cache:
//  - 60 сек in-memory Map по period (НЕ БД).
//  - Очищается при рестарте pm2.
//
// Pre-edit analysis:
//  - gen_activity.created_at — text default CURRENT_TIMESTAMP (UTC YYYY-MM-DD HH:MM:SS)
//  - Существующий pattern фильтра в routes.ts:4103 — new Date(Date.now()-X).toISOString()
//    Сравнение лексикографически работает корректно для разных дней; в пределах
//    одной секунды 'T' > ' ' но это immaterial для 1ч+ периодов.
//  - generations.style — JSON string с json_valid()=1 для безопасности.
//  - 5 категорий rejected см. shouldCountPlay() в routes.ts:
//    author-self, admin, bot-ua, too-short, ip-dedup-1h
//
// Не применяется к:
//  - /api/playlist/stats — публичный endpoint, не трогаем (см. ОГРАНИЧЕНИЯ).
//  - Per-user analytics — это per-track / per-time, не per-user view.

import { Router } from "express";
import { sql } from "drizzle-orm";
import { db } from "../../storage";
import { requireAdmin } from "../../core/adminAuth";
import type { Module } from "../../core";

const router = Router();

// === Типы ===

type Period = "1h" | "24h" | "7d" | "30d" | "all";

const VALID_PERIODS: Period[] = ["1h", "24h", "7d", "30d", "all"];

const REJECTED_REASONS = [
  "author-self",
  "admin",
  "bot-ua",
  "too-short",
  "ip-dedup-1h",
] as const;
type RejectedReason = (typeof REJECTED_REASONS)[number];

interface TopTrack {
  id: number;
  title: string;
  plays: number;
}

interface PlaysAnalytics {
  period: Period;
  since: string; // ISO; для period='all' — '1970-01-01T00:00:00.000Z'
  until: string; // ISO — момент расчёта
  counter: {
    current: number;
    delta: number;
    deltaPct: number;
  };
  plays: {
    counted: number;
    rejected: Record<RejectedReason | string, number>;
    rejectedTotal: number;
    ratio: number;
  };
  topTracks: TopTrack[];
  uniqueIps: number;
  ratePerMin: number;
  comparison: {
    previousPeriod: number;
    growthPct: number;
  };
}

// === Period → ms ===

function periodToMs(period: Period): number | null {
  switch (period) {
    case "1h": return 60 * 60 * 1000;
    case "24h": return 24 * 60 * 60 * 1000;
    case "7d": return 7 * 24 * 60 * 60 * 1000;
    case "30d": return 30 * 24 * 60 * 60 * 1000;
    case "all": return null; // unbounded
  }
}

function normalizePeriod(raw: unknown): Period {
  const s = String(raw || "").toLowerCase().trim();
  if (VALID_PERIODS.includes(s as Period)) return s as Period;
  return "1h";
}

// === Cache ===

interface CacheEntry {
  data: PlaysAnalytics;
  expiresAt: number;
}

const CACHE_TTL_MS = 60_000;
const cache = new Map<Period, CacheEntry>();

// === Helpers ===

function numSafe(v: unknown): number {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string") {
    const n = Number(v);
    return Number.isFinite(n) ? n : 0;
  }
  return 0;
}

function pct(num: number, denom: number): number {
  if (!Number.isFinite(num) || !Number.isFinite(denom) || denom === 0) return 0;
  return Math.round((num / denom) * 10000) / 100; // 2 знака после
}

// === SQL aggregators ===

// counter.current — sum meta.plays для main playlist (is_public=1) done, не deleted
function getCurrentCounter(): number {
  try {
    const row = db.get<{ s: number }>(
      sql`SELECT COALESCE(SUM(CAST(json_extract(style, '$.plays') AS INTEGER)), 0) AS s
            FROM generations
            WHERE type='music' AND status='done' AND is_public=1
              AND deleted_at IS NULL
              AND style LIKE '{%' AND json_valid(style)=1`,
    );
    return numSafe(row?.s);
  } catch {
    return 0;
  }
}

// count action='play' (with optional since/until filter)
function countPlays(sinceIso: string | null, untilIso: string): number {
  try {
    if (sinceIso === null) {
      const row = db.get<{ c: number }>(
        sql`SELECT COUNT(*) AS c FROM gen_activity WHERE action='play' AND created_at <= ${untilIso}`,
      );
      return numSafe(row?.c);
    }
    const row = db.get<{ c: number }>(
      sql`SELECT COUNT(*) AS c FROM gen_activity
           WHERE action='play' AND created_at > ${sinceIso} AND created_at <= ${untilIso}`,
    );
    return numSafe(row?.c);
  } catch {
    return 0;
  }
}

// breakdown по причинам rejected
function getRejectedBreakdown(
  sinceIso: string | null,
  untilIso: string,
): Record<string, number> {
  const out: Record<string, number> = {};
  for (const r of REJECTED_REASONS) out[r] = 0;
  try {
    let rows: Array<{ action: string; c: number }> = [];
    if (sinceIso === null) {
      rows = db.all<{ action: string; c: number }>(
        sql`SELECT action, COUNT(*) AS c
              FROM gen_activity
              WHERE action LIKE 'play_rejected:%' AND created_at <= ${untilIso}
              GROUP BY action`,
      );
    } else {
      rows = db.all<{ action: string; c: number }>(
        sql`SELECT action, COUNT(*) AS c
              FROM gen_activity
              WHERE action LIKE 'play_rejected:%'
                AND created_at > ${sinceIso} AND created_at <= ${untilIso}
              GROUP BY action`,
      );
    }
    for (const r of rows) {
      const reason = r.action.startsWith("play_rejected:")
        ? r.action.slice("play_rejected:".length).split(":")[0] || "unknown"
        : "unknown";
      out[reason] = (out[reason] || 0) + numSafe(r.c);
    }
  } catch {
    // soft-fail — возвращаем нули
  }
  return out;
}

// top-5 треков по play events за период
function getTopTracks(
  sinceIso: string | null,
  untilIso: string,
  limit = 5,
): TopTrack[] {
  try {
    let rows: Array<{ id: number; title: string | null; prompt: string | null; p: number }> = [];
    if (sinceIso === null) {
      rows = db.all<{ id: number; title: string | null; prompt: string | null; p: number }>(
        sql`SELECT g.id AS id, g.display_title AS title, g.prompt AS prompt, COUNT(*) AS p
              FROM gen_activity ga
              JOIN generations g ON g.id = ga.gen_id
              WHERE ga.action='play' AND ga.created_at <= ${untilIso}
                AND g.deleted_at IS NULL
              GROUP BY g.id
              ORDER BY p DESC
              LIMIT ${limit}`,
      );
    } else {
      rows = db.all<{ id: number; title: string | null; prompt: string | null; p: number }>(
        sql`SELECT g.id AS id, g.display_title AS title, g.prompt AS prompt, COUNT(*) AS p
              FROM gen_activity ga
              JOIN generations g ON g.id = ga.gen_id
              WHERE ga.action='play' AND ga.created_at > ${sinceIso} AND ga.created_at <= ${untilIso}
                AND g.deleted_at IS NULL
              GROUP BY g.id
              ORDER BY p DESC
              LIMIT ${limit}`,
      );
    }
    return rows.map((r) => {
      let title = (r.title || "").trim();
      if (!title) {
        const p = (r.prompt || "").trim();
        title = p ? p.split("\n")[0].slice(0, 80) : "(без названия)";
      }
      return { id: r.id, title, plays: numSafe(r.p) };
    });
  } catch {
    return [];
  }
}

// unique IPs (COUNT DISTINCT) — без raw values, только число
function getUniqueIps(sinceIso: string | null, untilIso: string): number {
  try {
    if (sinceIso === null) {
      const row = db.get<{ c: number }>(
        sql`SELECT COUNT(DISTINCT ip) AS c FROM gen_activity
              WHERE action='play' AND ip IS NOT NULL AND ip != '' AND created_at <= ${untilIso}`,
      );
      return numSafe(row?.c);
    }
    const row = db.get<{ c: number }>(
      sql`SELECT COUNT(DISTINCT ip) AS c FROM gen_activity
            WHERE action='play' AND ip IS NOT NULL AND ip != ''
              AND created_at > ${sinceIso} AND created_at <= ${untilIso}`,
    );
    return numSafe(row?.c);
  } catch {
    return 0;
  }
}

// === Build analytics ===

function buildAnalytics(period: Period): PlaysAnalytics {
  const now = Date.now();
  const untilIso = new Date(now).toISOString();
  const ms = periodToMs(period);

  // 'all' → since=epoch (хотя SQL фильтр будет с unbounded ветвью)
  const sinceIso = ms === null ? null : new Date(now - ms).toISOString();
  const sinceLabel = ms === null ? "1970-01-01T00:00:00.000Z" : sinceIso!;

  // Текущий counter (snapshot meta.plays sum, всё время — не зависит от period)
  const counterCurrent = getCurrentCounter();

  // Δ — плеи за период
  const counted = countPlays(sinceIso, untilIso);

  // Rejected breakdown
  const rejected = getRejectedBreakdown(sinceIso, untilIso);
  const rejectedTotal = Object.values(rejected).reduce((s, n) => s + n, 0);

  // Top tracks
  const topTracks = getTopTracks(sinceIso, untilIso, 5);

  // Unique IPs
  const uniqueIps = getUniqueIps(sinceIso, untilIso);

  // Rate per min
  let ratePerMin = 0;
  if (ms !== null) {
    const mins = ms / 60_000;
    ratePerMin = mins > 0 ? Math.round((counted / mins) * 100) / 100 : 0;
  }

  // Comparison: previous-window same size, shifted back
  let previousPeriod = 0;
  if (ms !== null) {
    const prevUntilIso = new Date(now - ms).toISOString();
    const prevSinceIso = new Date(now - 2 * ms).toISOString();
    previousPeriod = countPlays(prevSinceIso, prevUntilIso);
  }
  const growthPct = previousPeriod > 0
    ? Math.round(((counted - previousPeriod) / previousPeriod) * 10000) / 100
    : counted > 0
      ? 100
      : 0;

  // deltaPct: какую долю counter составляет приросток за период
  const deltaPct = counterCurrent > 0
    ? Math.round((counted / counterCurrent) * 10000) / 100
    : 0;

  // ratio: counted / (counted + rejectedTotal)
  const totalAttempts = counted + rejectedTotal;
  const ratio = totalAttempts > 0
    ? Math.round((counted / totalAttempts) * 10000) / 10000
    : 0;

  return {
    period,
    since: sinceLabel,
    until: untilIso,
    counter: {
      current: counterCurrent,
      delta: counted,
      deltaPct,
    },
    plays: {
      counted,
      rejected,
      rejectedTotal,
      ratio,
    },
    topTracks,
    uniqueIps,
    ratePerMin,
    comparison: {
      previousPeriod,
      growthPct,
    },
  };
}

function getCachedAnalytics(period: Period): PlaysAnalytics {
  const hit = cache.get(period);
  if (hit && hit.expiresAt > Date.now()) {
    return hit.data;
  }
  const data = buildAnalytics(period);
  cache.set(period, { data, expiresAt: Date.now() + CACHE_TTL_MS });
  return data;
}

// === Routes ===

// GET /api/admin/v304/plays-analytics?period=1h|24h|7d|30d|all
router.get("/", requireAdmin, (req, res) => {
  try {
    const period = normalizePeriod(req.query.period);
    const data = getCachedAnalytics(period);
    res.json({ data, error: null });
  } catch (e: any) {
    res.status(500).json({
      data: null,
      error: String(e?.message || e).slice(0, 200),
    });
  }
});

// === Module export ===

const playsAnalyticsModule: Module = {
  name: "plays-analytics",
  version: "0.1.0",
  description:
    "Admin-аналитика счётчика прослушиваний с разбивкой по периодам (1ч / 24ч / 7д / 30д / всё время). Read-only, cache 60 сек. Eugene 2026-05-21.",
  routes: { prefix: "admin/v304/plays-analytics", router },
  onLoad: async (ctx) => {
    ctx.logger.info(
      "plays-analytics online — GET /api/admin/v304/plays-analytics?period=1h|24h|7d|30d|all",
    );
  },
  healthCheck: () => ({ status: "ok" }),
};

export default playsAnalyticsModule;
