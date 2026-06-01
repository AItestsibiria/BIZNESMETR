// v304 plugin: funnels (Eugene 2026-05-17 Босс «воронки конверсии — где
// юзеры проседают»).
//
// Что делает:
//  - GET /api/admin/v304/funnels?period=today|yesterday|7d|30d|all
//      Считает все воронки из FUNNELS — counts по шагам + conversionFromPrev +
//      totalConversion + topDropoff. Кэш 60 сек по ключу `period`.
//  - GET /api/admin/v304/funnels?period=...&funnelId=phone_registration
//      Один funnel + drill-down (топ ошибок / последние session_key
//      проседающих юзеров на топ-dropoff шаге).
//  - GET /api/admin/v304/funnels/snapshot-trend?funnelId=...&days=30
//      Тренд по сохранённым snapshot'ам (funnel_snapshots) — для линейного
//      графика «conversion за N дней».
//  - Cron job `funnel-daily-snapshot` (schedule='every_hour' — внутри
//    проверяем 03:00 MSK ±5 мин окно) сохраняет дневной snapshot всех воронок
//    в funnel_snapshots. Идемпотентно (UNIQUE на date+funnel_id).
//
// Безопасность:
//  - requireAdmin guard на всех endpoint'ах.
//  - READ-only SQL во всех расчётах — ни INSERT/UPDATE/DELETE на чужие таблицы.
//  - INSERT только в funnel_snapshots (наша own table).
//  - PII не leak: session_key хешируем (sha256 first 8 chars), email/phone не
//    выгружаем в drill-down. error_message / status / page — допустимо.
//  - Фильтры из FUNNELS — статичные literals в коде, НЕ принимаем
//    SQL-фрагменты из user input → SQL injection невозможен.
//
// Pre-edit analysis:
//  - Префикс admin/v304 — collision check: master-dashboard уже регистрирует
//    /funnels? — НЕТ (только /dashboard-summary, /brain-export, /click-stats,
//    /briefing-text, /tts). admin-overview регистрирует /overview, /sms-logs,
//    /poll-now и т.д. — конфликта нет.
//  - funnel_snapshots — наша новая таблица, миграция в storage.ts core bootstrap.

import { Router } from "express";
import crypto from "node:crypto";
import { requireAdmin } from "../../core/adminAuth";
import { sqliteDb } from "../../storage";
import type { Module } from "../../core";
import {
  FUNNELS,
  getFunnelDef,
  listFunnelIds,
  type FunnelDef,
  type FunnelStepDef,
} from "../../lib/funnelDefs";
import {
  getPeriodRange,
  normalizePeriodId,
  type PeriodId,
} from "../../lib/periodBoundaries";

const router = Router();

// --- Period helpers ---
//
// Eugene 2026-05-17 Босс: единая логика period boundaries (cut-off 20:00 МСК)
// через `getPeriodRange()` из `apps/neurohub/server/lib/periodBoundaries.ts`.
// Локальный PeriodRange — { since, until } — обёртка над { fromIso, toIso }
// для обратной совместимости с существующими call-site'ами в модуле.

type Period = PeriodId;

function parsePeriod(raw: unknown): Period {
  return normalizePeriodId(raw);
}

interface PeriodRange {
  since: string | null;
  until: string | null;
}

function periodToRange(p: Period): PeriodRange {
  const range = getPeriodRange(p);
  return { since: range.fromIso, until: range.toIso };
}

// --- Cache 60 sec ----------------------------------------------------------

interface CacheEntry {
  data: unknown;
  expiresAt: number;
}
const cache = new Map<string, CacheEntry>();
const CACHE_TTL_MS = 60_000;

function cacheKey(period: Period, funnelId: string | null): string {
  return `${period}::${funnelId ?? "*"}`;
}
function getCached(key: string): unknown | null {
  const e = cache.get(key);
  if (e && e.expiresAt > Date.now()) return e.data;
  return null;
}
function setCached(key: string, data: unknown): void {
  cache.set(key, { data, expiresAt: Date.now() + CACHE_TTL_MS });
}

// --- Step-level SQL builder -----------------------------------------------
//
// Каждый шаг = SELECT count() FROM <source> WHERE <filter> [AND date-range].
// `distinct` если задан → COUNT(DISTINCT col).
// Все таблицы используют `created_at` как timestamp поля.

function countForStep(
  step: FunnelStepDef,
  range: PeriodRange,
): number {
  const countExpr = step.distinct
    ? `COUNT(DISTINCT ${step.distinct})`
    : "COUNT(*)";
  let sql = `SELECT ${countExpr} AS c FROM ${step.source} WHERE (${step.filter})`;
  const params: string[] = [];
  if (range.since) {
    sql += ` AND created_at >= ?`;
    params.push(range.since);
  }
  if (range.until) {
    sql += ` AND created_at < ?`;
    params.push(range.until);
  }
  try {
    const row = sqliteDb.prepare(sql).get(...params) as { c: number } | undefined;
    return row?.c ?? 0;
  } catch (e) {
    // Например, таблица ещё не существует (старая БД) или фильтр сломан.
    // Возвращаем 0 — funnel остаётся валидным, просто шаг показан как 0.
    console.warn(
      `[funnels] step '${step.id}' SQL failed:`,
      e instanceof Error ? e.message : e,
    );
    return 0;
  }
}

// --- Funnel result shape ---------------------------------------------------

interface FunnelStepResult {
  id: string;
  label: string;
  count: number;
  /** null для первого шага, иначе count/prev (0..1). */
  conversionFromPrev: number | null;
  /** Сколько потеряли с предыдущего шага. null для первого. */
  lostFromPrev: number | null;
}

interface TopDropoff {
  stepId: string;
  stepLabel: string;
  lostCount: number;
  /** Доля потерянных от предыдущего шага (0..1). */
  ratio: number;
}

interface FunnelResult {
  id: string;
  name: string;
  description: string;
  period: Period;
  since: string | null;
  until: string | null;
  steps: FunnelStepResult[];
  /** count[last] / count[first], 0..1. null если первый шаг = 0. */
  totalConversion: number | null;
  topDropoff: TopDropoff | null;
}

function computeFunnel(
  def: FunnelDef,
  period: Period,
  range: PeriodRange,
): FunnelResult {
  const steps: FunnelStepResult[] = [];
  let prevCount: number | null = null;
  for (const step of def.steps) {
    const c = countForStep(step, range);
    let conversionFromPrev: number | null = null;
    let lostFromPrev: number | null = null;
    if (prevCount !== null) {
      if (prevCount > 0) {
        conversionFromPrev = c / prevCount;
        lostFromPrev = Math.max(0, prevCount - c);
      } else {
        conversionFromPrev = null;
        lostFromPrev = 0;
      }
    }
    steps.push({
      id: step.id,
      label: step.label,
      count: c,
      conversionFromPrev,
      lostFromPrev,
    });
    prevCount = c;
  }

  // total conversion
  const first = steps[0]?.count ?? 0;
  const last = steps[steps.length - 1]?.count ?? 0;
  const totalConversion = first > 0 ? last / first : null;

  // top dropoff — шаг с наибольшим lostFromPrev (исключая шаги где prev=0).
  let topDropoff: TopDropoff | null = null;
  for (const s of steps) {
    if (s.lostFromPrev !== null && s.conversionFromPrev !== null) {
      const ratio = 1 - s.conversionFromPrev;
      if (
        s.lostFromPrev > 0 &&
        (topDropoff === null || s.lostFromPrev > topDropoff.lostCount)
      ) {
        topDropoff = {
          stepId: s.id,
          stepLabel: s.label,
          lostCount: s.lostFromPrev,
          ratio,
        };
      }
    }
  }

  return {
    id: def.id,
    name: def.name,
    description: def.description,
    period,
    since: range.since,
    until: range.until,
    steps,
    totalConversion,
    topDropoff,
  };
}

// --- Drill-down helpers ---------------------------------------------------

/**
 * Для топ-dropoff шага возвращает топ-причины проседания.
 * - Для sms_provider_logs → группировка по status / error_message.
 * - Для user_journey_events → топ pages где click был / topELements.
 * - Для остальных — последние N session_key / user_id с обрезанными PII.
 *
 * Не выгружает PII: session_key хешируем, email/phone не показываем.
 */
function buildDropoffDetails(
  step: FunnelStepDef,
  range: PeriodRange,
): {
  topReasons: Array<{ key: string; count: number }>;
  recent: Array<{ key: string; at: string; meta?: Record<string, unknown> }>;
} {
  const reasons: Array<{ key: string; count: number }> = [];
  const recent: Array<{ key: string; at: string; meta?: Record<string, unknown> }> = [];

  // 1. Top reasons by source.
  try {
    if (step.source === "sms_provider_logs") {
      let sql = `SELECT COALESCE(error_message, status, 'ok') AS k, COUNT(*) AS c
                 FROM sms_provider_logs WHERE (${step.filter})`;
      const p: string[] = [];
      if (range.since) { sql += " AND created_at >= ?"; p.push(range.since); }
      if (range.until) { sql += " AND created_at < ?"; p.push(range.until); }
      sql += " GROUP BY k ORDER BY c DESC LIMIT 10";
      const rows = sqliteDb.prepare(sql).all(...p) as Array<{ k: string; c: number }>;
      for (const r of rows) reasons.push({ key: String(r.k || "unknown"), count: r.c });
    } else if (step.source === "user_journey_events") {
      let sql = `SELECT COALESCE(
                   json_extract(meta, '$.text'),
                   json_extract(meta, '$.dataTrack'),
                   json_extract(meta, '$.id'),
                   page,
                   'unknown'
                 ) AS k, COUNT(*) AS c
                 FROM user_journey_events WHERE (${step.filter})`;
      const p: string[] = [];
      if (range.since) { sql += " AND created_at >= ?"; p.push(range.since); }
      if (range.until) { sql += " AND created_at < ?"; p.push(range.until); }
      sql += " GROUP BY k ORDER BY c DESC LIMIT 10";
      const rows = sqliteDb.prepare(sql).all(...p) as Array<{ k: string; c: number }>;
      for (const r of rows) reasons.push({ key: String(r.k || "unknown"), count: r.c });
    } else if (step.source === "generations") {
      let sql = `SELECT COALESCE(error_reason, status, 'unknown') AS k, COUNT(*) AS c
                 FROM generations WHERE (${step.filter})`;
      const p: string[] = [];
      if (range.since) { sql += " AND created_at >= ?"; p.push(range.since); }
      if (range.until) { sql += " AND created_at < ?"; p.push(range.until); }
      sql += " GROUP BY k ORDER BY c DESC LIMIT 10";
      const rows = sqliteDb.prepare(sql).all(...p) as Array<{ k: string; c: number }>;
      for (const r of rows) reasons.push({ key: String(r.k || "unknown"), count: r.c });
    } else if (step.source === "payments") {
      let sql = `SELECT status AS k, COUNT(*) AS c
                 FROM payments WHERE (${step.filter})`;
      const p: string[] = [];
      if (range.since) { sql += " AND created_at >= ?"; p.push(range.since); }
      if (range.until) { sql += " AND created_at < ?"; p.push(range.until); }
      sql += " GROUP BY k ORDER BY c DESC LIMIT 10";
      const rows = sqliteDb.prepare(sql).all(...p) as Array<{ k: string; c: number }>;
      for (const r of rows) reasons.push({ key: String(r.k || "unknown"), count: r.c });
    }
  } catch (e) {
    console.warn(
      `[funnels] drill-down reasons '${step.id}' failed:`,
      e instanceof Error ? e.message : e,
    );
  }

  // 2. Последние 20 событий шага (hash'еные session_key или user_id).
  try {
    let sql = "";
    let p: string[] = [];
    if (step.source === "user_journey_events") {
      sql = `SELECT session_key AS k, created_at AS at, page, event_type
             FROM user_journey_events WHERE (${step.filter})`;
    } else if (step.source === "sms_provider_logs") {
      sql = `SELECT phone_masked AS k, created_at AS at, status, error_message
             FROM sms_provider_logs WHERE (${step.filter})`;
    } else if (step.source === "users") {
      sql = `SELECT CAST(id AS TEXT) AS k, created_at AS at
             FROM users WHERE (${step.filter})`;
    } else if (step.source === "generations") {
      sql = `SELECT CAST(user_id AS TEXT) AS k, created_at AS at, status, error_reason
             FROM generations WHERE (${step.filter})`;
    } else if (step.source === "payments") {
      sql = `SELECT CAST(user_id AS TEXT) AS k, created_at AS at, status, amount
             FROM payments WHERE (${step.filter})`;
    } else if (step.source === "gen_activity") {
      sql = `SELECT ip AS k, created_at AS at, action
             FROM gen_activity WHERE (${step.filter})`;
    } else if (step.source === "engagement_events") {
      sql = `SELECT COALESCE(session_id, CAST(user_id AS TEXT)) AS k, created_at AS at, event_type
             FROM engagement_events WHERE (${step.filter})`;
    }
    if (sql) {
      if (range.since) { sql += " AND created_at >= ?"; p.push(range.since); }
      if (range.until) { sql += " AND created_at < ?"; p.push(range.until); }
      sql += " ORDER BY created_at DESC LIMIT 20";
      const rows = sqliteDb.prepare(sql).all(...p) as Array<Record<string, unknown>>;
      for (const r of rows) {
        const rawKey = String(r.k ?? "");
        const hashed = rawKey
          ? crypto.createHash("sha256").update(rawKey).digest("hex").slice(0, 12)
          : "anon";
        // meta — все поля кроме k/at (фильтрация PII выше уже сделана).
        const { k: _k, at: _at, ...meta } = r;
        recent.push({
          key: hashed,
          at: String(r.at ?? ""),
          meta: Object.keys(meta).length ? meta : undefined,
        });
      }
    }
  } catch (e) {
    console.warn(
      `[funnels] drill-down recent '${step.id}' failed:`,
      e instanceof Error ? e.message : e,
    );
  }

  return { topReasons: reasons, recent };
}

// --- GET /api/admin/v304/funnels ------------------------------------------

router.get("/funnels", requireAdmin, (req, res) => {
  try {
    const period = parsePeriod(req.query.period);
    const funnelIdRaw =
      typeof req.query.funnelId === "string" ? req.query.funnelId : null;
    const stepIdRaw =
      typeof req.query.stepId === "string" ? req.query.stepId : null;

    // Не кэшируем drill-down (stepId передан) — он редкий и параметрически
    // богатый. Кэшируем только базовый funnels(period[, funnelId]).
    const key = cacheKey(period, funnelIdRaw);
    if (!stepIdRaw) {
      const cached = getCached(key);
      if (cached) {
        return res.json({
          data: { ...(cached as Record<string, unknown>), fromCache: true },
          error: null,
        });
      }
    }

    const range = periodToRange(period);

    // Список воронок для расчёта.
    const targetIds = funnelIdRaw && getFunnelDef(funnelIdRaw)
      ? [funnelIdRaw]
      : listFunnelIds();

    const funnels = targetIds
      .map((id) => getFunnelDef(id))
      .filter((d): d is FunnelDef => d !== null)
      .map((def) => computeFunnel(def, period, range));

    // Drill-down — если запросили stepId на конкретной воронке.
    let drilldown: {
      funnelId: string;
      stepId: string;
      stepLabel: string;
      topReasons: Array<{ key: string; count: number }>;
      recent: Array<{ key: string; at: string; meta?: Record<string, unknown> }>;
    } | null = null;

    if (stepIdRaw && funnelIdRaw) {
      const def = getFunnelDef(funnelIdRaw);
      const stepDef = def?.steps.find((s) => s.id === stepIdRaw) ?? null;
      if (def && stepDef) {
        const details = buildDropoffDetails(stepDef, range);
        drilldown = {
          funnelId: def.id,
          stepId: stepDef.id,
          stepLabel: stepDef.label,
          topReasons: details.topReasons,
          recent: details.recent,
        };
      }
    }

    const payload = {
      period,
      since: range.since,
      until: range.until,
      generatedAt: new Date().toISOString(),
      cacheExpiresAt: new Date(Date.now() + CACHE_TTL_MS).toISOString(),
      funnels,
      drilldown,
    };

    if (!stepIdRaw) setCached(key, payload);
    res.json({
      data: { ...payload, fromCache: false },
      error: null,
    });
  } catch (err) {
    console.error("[funnels] /funnels handler:", err);
    res.status(500).json({
      data: null,
      error: err instanceof Error ? err.message : "internal",
    });
  }
});

// --- GET /api/admin/v304/funnels/snapshot-trend ---------------------------

router.get("/funnels/snapshot-trend", requireAdmin, (req, res) => {
  try {
    const funnelId =
      typeof req.query.funnelId === "string" ? req.query.funnelId : null;
    const daysRaw = Number(req.query.days);
    const days = Number.isFinite(daysRaw) && daysRaw > 0 && daysRaw <= 365
      ? Math.floor(daysRaw)
      : 30;

    if (!funnelId || !getFunnelDef(funnelId)) {
      return res.status(400).json({
        data: null,
        error: "invalid funnelId",
      });
    }

    const sql = `SELECT date, steps_json, total_conversion, top_dropoff_step
                 FROM funnel_snapshots
                 WHERE funnel_id = ?
                   AND date >= date('now','-${days} days')
                 ORDER BY date ASC`;
    const rows = sqliteDb.prepare(sql).all(funnelId) as Array<{
      date: string;
      steps_json: string;
      total_conversion: number | null;
      top_dropoff_step: string | null;
    }>;

    const trend = rows.map((r) => {
      let steps: unknown = null;
      try {
        steps = JSON.parse(r.steps_json);
      } catch {}
      return {
        date: r.date,
        totalConversion: r.total_conversion,
        topDropoffStep: r.top_dropoff_step,
        steps,
      };
    });

    res.json({ data: { funnelId, days, trend }, error: null });
  } catch (err) {
    console.error("[funnels] /snapshot-trend handler:", err);
    res.status(500).json({
      data: null,
      error: err instanceof Error ? err.message : "internal",
    });
  }
});

// --- Daily snapshot job ---------------------------------------------------
//
// Запускается каждый час. Проверяет: «сейчас 03:00 MSK ± 5 минут»? Если да и
// snapshot за сегодняшний MSK-день для какой-то воронки ещё не сохранён —
// считает и сохраняет. UNIQUE INDEX гарантирует идемпотентность даже при
// двойном запуске.

function todayMskDateString(): string {
  // MSK = UTC+3. Берём текущий UTC, прибавляем 3ч, форматируем YYYY-MM-DD.
  const now = new Date();
  const msk = new Date(now.getTime() + 3 * 3600 * 1000);
  return msk.toISOString().slice(0, 10);
}

function isMskHourWindow(targetHour: number, windowMin = 5): boolean {
  const now = new Date();
  const msk = new Date(now.getTime() + 3 * 3600 * 1000);
  const h = msk.getUTCHours();
  const m = msk.getUTCMinutes();
  // Window: targetHour:00 .. targetHour:<windowMin>
  return h === targetHour && m < windowMin;
}

export function runDailySnapshot(opts?: { force?: boolean; date?: string }): {
  saved: number;
  skipped: number;
  errors: number;
} {
  const date = opts?.date ?? todayMskDateString();
  let saved = 0;
  let skipped = 0;
  let errors = 0;

  // Считаем yesterday-range — snapshot за прошедшие 24ч MSK.
  // Для запуска в 03:00 MSK 2026-05-17 это интервал 2026-05-16 00:00 .. 2026-05-17 00:00 MSK.
  // Сохраняем под date=2026-05-16 (дата за которую считали).
  // Если force/date явно задан — пересчитываем для конкретной даты.
  const targetDate = opts?.date ?? (() => {
    // yesterday MSK
    const d = new Date(Date.now() + 3 * 3600 * 1000);
    d.setUTCDate(d.getUTCDate() - 1);
    return d.toISOString().slice(0, 10);
  })();

  const rangeForDate = (yyyymmdd: string): PeriodRange => {
    // since = yyyymmdd 00:00 MSK = (yyyymmdd-1) 21:00 UTC
    // until = (yyyymmdd+1) 00:00 MSK = yyyymmdd 21:00 UTC
    const d = new Date(`${yyyymmdd}T00:00:00.000Z`);
    const since = new Date(d.getTime() - 3 * 3600 * 1000).toISOString();
    const until = new Date(d.getTime() + 24 * 3600 * 1000 - 3 * 3600 * 1000).toISOString();
    return { since, until };
  };

  const range = rangeForDate(targetDate);

  for (const id of listFunnelIds()) {
    const def = getFunnelDef(id);
    if (!def) continue;
    try {
      // Skip if already saved (unless force)
      if (!opts?.force) {
        const existing = sqliteDb
          .prepare(
            `SELECT id FROM funnel_snapshots WHERE date=? AND funnel_id=? LIMIT 1`,
          )
          .get(targetDate, id);
        if (existing) {
          skipped++;
          continue;
        }
      }
      const result = computeFunnel(def, "all", range);
      const stepsJson = JSON.stringify(result.steps);
      const stmt = sqliteDb.prepare(
        `INSERT INTO funnel_snapshots (date, funnel_id, steps_json, total_conversion, top_dropoff_step)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(date, funnel_id) DO UPDATE SET
           steps_json=excluded.steps_json,
           total_conversion=excluded.total_conversion,
           top_dropoff_step=excluded.top_dropoff_step`,
      );
      stmt.run(
        targetDate,
        id,
        stepsJson,
        result.totalConversion,
        result.topDropoff?.stepId ?? null,
      );
      saved++;
    } catch (e) {
      errors++;
      console.error(
        `[funnels] snapshot save failed for ${id}:`,
        e instanceof Error ? e.message : e,
      );
    }
  }

  // touch unused vars
  void date;
  return { saved, skipped, errors };
}

// Manual trigger endpoint (для теста + ручного запуска снапшота).
router.post("/funnels/snapshot/run", requireAdmin, (req, res) => {
  try {
    const force = req.query.force === "1" || req.body?.force === true;
    const date =
      typeof req.body?.date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(req.body.date)
        ? req.body.date
        : undefined;
    const result = runDailySnapshot({ force, date });
    res.json({ data: result, error: null });
  } catch (err) {
    res.status(500).json({
      data: null,
      error: err instanceof Error ? err.message : "internal",
    });
  }
});

// --- Helper for brain-export integration (exported) ----------------------
//
// Возвращает компактный slice последних snapshot'ов для использования
// в /api/admin/v304/brain-export. Берём последний snapshot каждой воронки —
// для Второго мозга важна актуальная картина, не история.

export function lastSnapshotForBrainExport(): Array<{
  funnelId: string;
  funnelName: string;
  date: string | null;
  totalConversion: number | null;
  topDropoffStep: string | null;
  steps: Array<{ id: string; label: string; count: number; conversionFromPrev: number | null }>;
}> {
  const out: Array<{
    funnelId: string;
    funnelName: string;
    date: string | null;
    totalConversion: number | null;
    topDropoffStep: string | null;
    steps: Array<{ id: string; label: string; count: number; conversionFromPrev: number | null }>;
  }> = [];

  for (const id of listFunnelIds()) {
    const def = getFunnelDef(id);
    if (!def) continue;
    try {
      const row = sqliteDb
        .prepare(
          `SELECT date, steps_json, total_conversion, top_dropoff_step
           FROM funnel_snapshots WHERE funnel_id=? ORDER BY date DESC LIMIT 1`,
        )
        .get(id) as
        | { date: string; steps_json: string; total_conversion: number | null; top_dropoff_step: string | null }
        | undefined;
      if (!row) {
        out.push({
          funnelId: id,
          funnelName: def.name,
          date: null,
          totalConversion: null,
          topDropoffStep: null,
          steps: def.steps.map((s) => ({
            id: s.id,
            label: s.label,
            count: 0,
            conversionFromPrev: null,
          })),
        });
        continue;
      }
      let steps: Array<{ id: string; label: string; count: number; conversionFromPrev: number | null }> = [];
      try {
        steps = JSON.parse(row.steps_json);
      } catch {}
      out.push({
        funnelId: id,
        funnelName: def.name,
        date: row.date,
        totalConversion: row.total_conversion,
        topDropoffStep: row.top_dropoff_step,
        steps,
      });
    } catch (e) {
      console.warn(
        `[funnels] brain-export last snapshot for ${id} failed:`,
        e instanceof Error ? e.message : e,
      );
    }
  }
  return out;
}

const funnelsModule: Module = {
  name: "funnels",
  version: "0.1.0",
  description:
    "Conversion funnels (phone-reg, email-reg, track-creation, payment) + daily snapshots для тренда.",
  routes: { prefix: "admin/v304", router },
  publishes: [],
  jobs: [
    // Cron — каждый час. Внутри проверяем 03:00 MSK ± 5 мин.
    {
      name: "funnel-daily-snapshot",
      schedule: "every_hour",
      handler: async () => {
        try {
          if (isMskHourWindow(3, 10)) {
            const r = runDailySnapshot();
            if (r.saved > 0 || r.errors > 0) {
              console.log(
                `[funnels] daily snapshot: saved=${r.saved}, skipped=${r.skipped}, errors=${r.errors}`,
              );
            }
          }
        } catch (e) {
          console.error("[funnels] daily-snapshot job failed:", e);
        }
      },
    },
  ],
  onLoad: async (ctx) => {
    ctx.logger.info(
      "funnels online — GET /api/admin/v304/funnels (4 funnels, cache 60s), /snapshot-trend, POST /snapshot/run (03:00 MSK cron)",
    );
  },
  healthCheck: () => ({ status: "ok" }),
};

export default funnelsModule;
