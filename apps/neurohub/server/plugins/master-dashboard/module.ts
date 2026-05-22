// v304 plugin: master-dashboard (Eugene 2026-05-17 Босс «главная аналитическая
// dashboard — точка сбора всей статистики проекта, фундамент Второго мозга»).
//
// Что делает:
//  - GET /api/admin/v304/dashboard-summary?period=today|7d|30d|all
//      Все метрики проекта одним запросом: light-status indicators по группам
//      + статистика по периодам + данные для графиков (linear / pie / bar /
//      heatmap / sankey).
//      Кэшируется на 60 сек по ключу period — не спамим БД.
//  - GET /api/admin/v304/brain-export
//      Полный snapshot всей метрики проекта в формате nodes/edges/metrics.
//      Data source для будущей 3D визуализации Second Brain.
//      Добавлена секция clickStats — топ клик-элементы и аналитика по страницам
//      для горячих точек сайта.
//  - GET /api/admin/v304/click-stats?period=today|7d|30d|all
//      Aggregate по `user_journey_events` (event_type='click' + 'page_view' +
//      'page_exit'): топ клик-элементов, метрики по страницам (total clicks,
//      avg time, bounce rate), top-20 элементов, totals. Кэш 60 сек.
//
// Безопасность:
//  - requireAdmin guard.
//  - PII маски: email/phone никогда не возвращаются в plain виде.
//  - Для click-stats: не выгружаем text input values — только element ID /
//    data-track / button text (≤60 chars, уже обрезано клиентом).
//
// Pre-edit analysis:
//  - Не модифицирую существующие endpoint'ы — только новые routes под
//    префиксом admin/v304/.
//  - Использую только READ-only SQL — без INSERT/UPDATE/DELETE.
//  - Префикс routes admin/v304 — collision не будет (admin-overview регистрирует
//    под тем же префиксом, но конкретные пути /dashboard-summary, /brain-export,
//    /click-stats в нём отсутствуют).
//  - user_journey_events.meta — JSON-строка; json_extract() извлекает поля.
//    SQLite поддерживает json_extract нативно (jsonl extension включён).

import { Router } from "express";
import * as fs from "node:fs";
import { sql } from "drizzle-orm";
import { db } from "../../storage";
import { requireAdmin } from "../../core/adminAuth";
import type { Module } from "../../core";
import { buildAdminBriefing } from "../../lib/musaBriefing";
import {
  synthesizeYandexTts,
  getTtsFromCache,
  putTtsInCache,
  estimateTtsCostKopecks,
  type YandexVoice,
} from "../../lib/yandexTts";
import {
  getPeriodRange,
  normalizePeriodId,
  type PeriodId,
} from "../../lib/periodBoundaries";
import { KNOWN_DOMAINS, type DomainBucket } from "../../lib/extractHost";
import { REAL_VISITORS_SQL } from "../../lib/realVisitors";
// Counters-audit 2026-05-19 D.2 — фильтр ботов на read-side dashboard.
import { buildBotExclusionSql } from "../../lib/botUa";

const router = Router();

// --- Rate limit per admin для TTS (10 запросов в минуту) ---
// Yandex TTS платный (~0.40₽ за вызов 1000 симв) — защищаемся от случайного
// flood'а из UI (Босс кликает «Доложить» подряд несколько раз).
const ttsRateMap = new Map<string, { count: number; resetAt: number }>();
const TTS_RATE_LIMIT = 10;          // запросов
const TTS_RATE_WINDOW_MS = 60_000;  // в минуту

function ttsRateOk(key: string): boolean {
  const now = Date.now();
  const entry = ttsRateMap.get(key);
  if (!entry || entry.resetAt < now) {
    ttsRateMap.set(key, { count: 1, resetAt: now + TTS_RATE_WINDOW_MS });
    return true;
  }
  if (entry.count >= TTS_RATE_LIMIT) return false;
  entry.count++;
  return true;
}

const VALID_TTS_VOICES: YandexVoice[] = [
  "alena",
  "jane",
  "oksana",
  "filipp",
  "ermil",
  "omazh",
  "zahar",
];

// --- Период ---
//
// Eugene 2026-05-17 Босс: единая логика period boundaries — cut-off 20:00 МСК.
// Все расчёты теперь идут через `getPeriodRange(period)` из
// `apps/neurohub/server/lib/periodBoundaries.ts`. Локальный
// PeriodBounds-интерфейс остался для back-compat с существующими функциями
// внутри модуля — он маппится 1:1 на { since: fromIso, until: toIso }.
//
// Поддерживается весь набор PeriodId (today, yesterday, 7d, 30d, 365d, all,
// month-1..month-12, custom). См. Period-20-MSK rule в CLAUDE.md.

type Period = PeriodId;

interface PeriodBounds {
  since: string | null;
  until: string | null;
}

function periodToBounds(
  p: Period,
  customFrom?: string,
  customTo?: string,
): PeriodBounds {
  const range = getPeriodRange(p, customFrom, customTo);
  return { since: range.fromIso, until: range.toIso };
}

// Back-compat для существующих call-site'ов (brain-export).
function periodToSince(p: Period): string | null {
  return periodToBounds(p).since;
}

function parsePeriod(raw: unknown): Period {
  return normalizePeriodId(raw);
}

// --- Кэш на 60 секунд ---

type CacheEntry = { data: any; expiresAt: number };
// Ключ кэша — period или 'custom:from:to' для произвольных промежутков.
const summaryCache = new Map<string, CacheEntry>();
const CACHE_TTL_MS = 60_000;

function cacheKey(period: Period, bounds: PeriodBounds): string {
  if (period === "custom") {
    return `custom:${bounds.since || "_"}|${bounds.until || "_"}`;
  }
  return period;
}

function getCached(key: string): any | null {
  const e = summaryCache.get(key);
  if (e && e.expiresAt > Date.now()) return e.data;
  return null;
}
function setCached(key: string, data: any): void {
  summaryCache.set(key, { data, expiresAt: Date.now() + CACHE_TTL_MS });
}

// --- Безопасные read-only метрики ---

function countSafe(query: any): number {
  try {
    const r = db.get<{ c: number }>(query);
    return r?.c ?? 0;
  } catch {
    return 0;
  }
}

function allSafe<T>(query: any): T[] {
  try {
    return db.all<T>(query) as T[];
  } catch {
    return [];
  }
}

// --- Group-status indicators (light-status cards) ---

interface GroupStatus {
  key: string;
  label: string;
  emoji: string;
  status: "green" | "yellow" | "red" | "unknown";
  metric: string;
  detail?: Record<string, unknown>;
}

function statusLLM(): GroupStatus {
  // Проверяем что хотя бы один LLM-канал настроен.
  const anthropic = !!process.env.ANTHROPIC_API_KEY;
  const timeweb = !!process.env.TIMEWEB_GATEWAY_KEY;
  const openai = !!process.env.OPENAI_API_KEY;
  const okCount = [anthropic, timeweb, openai].filter(Boolean).length;
  let status: GroupStatus["status"] = "red";
  let metric = "ключи не настроены";
  if (okCount >= 2) {
    status = "green";
    metric = `${okCount}/3 каналов настроено`;
  } else if (okCount === 1) {
    status = "yellow";
    metric = "1/3 каналов — нет резерва";
  }
  return {
    key: "llm",
    label: "LLM",
    emoji: "🧠",
    status,
    metric,
    detail: { anthropic, timeweb, openai },
  };
}

function statusGenerationPipeline(): GroupStatus {
  const since24h = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
  const done = countSafe(
    sql`SELECT count(*) as c FROM generations WHERE type='music' AND status='done' AND deleted_at IS NULL AND created_at >= ${since24h}`,
  );
  const error = countSafe(
    sql`SELECT count(*) as c FROM generations WHERE type='music' AND status='error' AND deleted_at IS NULL AND created_at >= ${since24h}`,
  );
  const total = done + error;
  const successRate = total > 0 ? Math.round((done / total) * 100) : 100;
  let status: GroupStatus["status"] = "green";
  if (total === 0) status = "yellow";
  else if (successRate < 90) status = "red";
  else if (successRate < 95) status = "yellow";
  return {
    key: "generation",
    label: "Генерация",
    emoji: "🎵",
    status,
    metric: total === 0 ? "за 24ч пусто" : `${successRate}% успех (${done}/${total})`,
    detail: { done, error, total, successRate },
  };
}

function statusAuth(): GroupStatus {
  const since24h = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
  const newUsers = countSafe(
    sql`SELECT count(*) as c FROM users WHERE created_at >= ${since24h}`,
  );
  const smsAvail = !!process.env.SMSRU_API_ID;
  const emailAvail = !!process.env.GMAIL_APP_PASSWORD || !!process.env.SMTP_PASS;
  let status: GroupStatus["status"] = "green";
  if (!smsAvail && !emailAvail) status = "red";
  else if (!smsAvail || !emailAvail) status = "yellow";
  return {
    key: "auth",
    label: "Регистрация",
    emoji: "🔐",
    status,
    metric: `${newUsers} новых за 24ч`,
    detail: { newUsers, smsAvail, emailAvail },
  };
}

function statusPayments(): GroupStatus {
  const since24h = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
  const paid = countSafe(
    sql`SELECT count(*) as c FROM payments WHERE status='paid' AND created_at >= ${since24h}`,
  );
  const failed = countSafe(
    sql`SELECT count(*) as c FROM payments WHERE status='failed' AND created_at >= ${since24h}`,
  );
  const roboCfg = !!process.env.ROBO_PASSWORD_1 && !!process.env.ROBO_PASSWORD_2 && !!process.env.ROBOKASSA_LOGIN;
  let status: GroupStatus["status"] = "green";
  if (!roboCfg) status = "red";
  else if (failed > paid && paid > 0) status = "yellow";
  return {
    key: "payments",
    label: "Платежи",
    emoji: "💳",
    status,
    metric: roboCfg ? `${paid} оплат · ${failed} ошибок` : "Robokassa не настроен",
    detail: { paid, failed, roboCfg },
  };
}

function statusBots(): GroupStatus {
  const tg = !!process.env.TELEGRAM_BOT_TOKEN;
  const max = !!process.env.MAX_BOT_TOKEN;
  const since24h = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
  const tgMessages = countSafe(
    sql`SELECT count(*) as c FROM chatbot_sessions WHERE channel='telegram' AND last_message_at >= ${since24h}`,
  );
  const maxMessages = countSafe(
    sql`SELECT count(*) as c FROM chatbot_sessions WHERE channel='max' AND last_message_at >= ${since24h}`,
  );
  let status: GroupStatus["status"] = "green";
  if (!tg && !max) status = "red";
  else if (!tg || !max) status = "yellow";
  return {
    key: "bots",
    label: "Боты",
    emoji: "🤖",
    status,
    metric: `TG: ${tgMessages} · Max: ${maxMessages} сессий 24ч`,
    detail: { tg, max, tgMessages, maxMessages },
  };
}

function statusDb(): GroupStatus {
  try {
    const integrity = db.get<{ integrity_check: string }>(sql`PRAGMA integrity_check`);
    const ic = (integrity as any)?.integrity_check || (integrity as any)?.ic;
    const ok = ic === "ok";
    return {
      key: "db",
      label: "БД",
      emoji: "🗄️",
      status: ok ? "green" : "red",
      metric: ok ? "integrity_check ok" : `integrity: ${ic}`,
      detail: { integrity: ic },
    };
  } catch (e) {
    return {
      key: "db",
      label: "БД",
      emoji: "🗄️",
      status: "red",
      metric: "ошибка integrity_check",
      detail: { error: e instanceof Error ? e.message : String(e) },
    };
  }
}

function statusDisk(): GroupStatus {
  try {
    const dbFile = process.env.DATABASE_FILE || "data.db";
    let dbSize = 0;
    try {
      dbSize = fs.statSync(dbFile).size;
    } catch {}
    // Без реальной df-команды (она требует Linux + child_process) — публикуем
    // только размер БД. Босс получит реальный disk-usage через api-health/sync-check.
    const dbMb = Math.round(dbSize / 1024 / 1024);
    let status: GroupStatus["status"] = "green";
    if (dbMb > 5000) status = "yellow";
    if (dbMb > 10000) status = "red";
    return {
      key: "disk",
      label: "Диск",
      emoji: "💾",
      status,
      metric: `data.db ≈ ${dbMb} МБ`,
      detail: { dbSize, dbMb },
    };
  } catch (e) {
    return {
      key: "disk",
      label: "Диск",
      emoji: "💾",
      status: "unknown",
      metric: "не удалось измерить",
      detail: { error: e instanceof Error ? e.message : String(e) },
    };
  }
}

function buildStatusCards(): GroupStatus[] {
  return [
    statusLLM(),
    statusGenerationPipeline(),
    statusAuth(),
    statusPayments(),
    statusBots(),
    statusDb(),
    statusDisk(),
  ];
}

// --- Хелперы для SQL-условий с (since, until) bounds ---

function normalizeBounds(b: PeriodBounds | string | null): PeriodBounds {
  if (b && typeof b === "object" && !Array.isArray(b)) {
    return {
      since: typeof b.since === "string" ? b.since : null,
      until: typeof b.until === "string" ? b.until : null,
    };
  }
  // Старые call-site'ы передавали since строкой или null.
  return { since: typeof b === "string" ? b : null, until: null };
}

function buildRangeCondition(
  column: string,
  since: string | null,
  until: string | null,
): any {
  // Возвращает фрагмент типа `created_at >= X AND created_at < Y` или `1=1`.
  if (since && until) {
    return sql`${sql.raw(column)} >= ${since} AND ${sql.raw(column)} < ${until}`;
  }
  if (since) {
    return sql`${sql.raw(column)} >= ${since}`;
  }
  if (until) {
    return sql`${sql.raw(column)} < ${until}`;
  }
  return sql`1=1`;
}

// --- Host фильтр (Eugene 2026-05-17 Босс per-domain трекинг) ---
//
// Принимает DomainBucket | null. null = все домены (без фильтра).
// 'other' = host NULL OR host NOT IN (known domains).
// Конкретный domain — точное совпадение host.
//
// `column` — литерал кода (typically "host"), безопасно для sql.raw.
// KNOWN_DOMAINS — внутренние константы (Reuse-working-solutions rule).
function buildHostCondition(
  column: string,
  bucket: DomainBucket | null,
): any {
  if (!bucket) return sql`1=1`;
  if (bucket === "other") {
    return sql`(${sql.raw(column)} IS NULL OR ${sql.raw(column)} NOT IN (${sql.join(
      KNOWN_DOMAINS.map(d => sql`${d}`), sql`, `,
    )}))`;
  }
  return sql`${sql.raw(column)} = ${bucket}`;
}

/**
 * Eugene 2026-05-17 Босс: нормализует ?domain=... параметр запроса в
 * DomainBucket | null (null = все домены).
 */
function parseDomainParam(raw: unknown): DomainBucket | null {
  if (!raw) return null;
  const s = String(raw).trim().toLowerCase();
  if (!s || s === "all") return null;
  if (s === "other") return "other";
  for (const d of KNOWN_DOMAINS) {
    if (s === d) return d;
  }
  // unknown value — игнорируем (fallback на «все домены»).
  return null;
}

// --- Метрики за период ---

interface PeriodMetrics {
  plays: { total: number; unique: number; rejected: number };
  downloads: { count: number };
  registrations: { total: number; byChannel: Array<{ channel: string; count: number }> };
  generations: {
    music: { done: number; error: number; processing: number };
    lyrics: { done: number; error: number };
    cover: { done: number; error: number };
  };
  payments: { count: number; sumKopecks: number };
  visitors: { unique: number; total: number };
}

function buildPeriodMetrics(
  bounds: PeriodBounds | string | null,
  domain: DomainBucket | null = null,
): PeriodMetrics {
  // Back-compat: старые call-site'ы передавали только since.
  const { since, until } = normalizeBounds(bounds);
  const sinceCondition = buildRangeCondition("created_at", since, until);
  // Host фильтры для разных таблиц (Eugene 2026-05-17 Босс per-domain).
  // gen_activity, visitors, user_journey_events, chatbot_sessions — есть host.
  // users, payments, generations — host НЕТ → joinim через visitors.userId
  // (first-touch domain юзера). Если у юзера нет visitor row → bucket "other".
  const gaHostCond = buildHostCondition("host", domain);
  const visitorsHostCond = buildHostCondition("host", domain);
  // Для users / payments: подзапрос «есть ли visitor с этим host у этого user_id».
  // domain=null → пропускаем фильтр (back-compat).
  const userDomainSubquery = (userIdCol: string) => {
    if (!domain) return sql`1=1`;
    if (domain === "other") {
      // either никакой visitor row, или все visitor rows этого юзера — other.
      return sql`NOT EXISTS (
        SELECT 1 FROM visitors v
        WHERE v.user_id = ${sql.raw(userIdCol)}
          AND v.host IN (${sql.join(KNOWN_DOMAINS.map(d => sql`${d}`), sql`, `)})
      )`;
    }
    return sql`EXISTS (
      SELECT 1 FROM visitors v
      WHERE v.user_id = ${sql.raw(userIdCol)} AND v.host = ${domain}
    )`;
  };

  // Plays / play_rejected — оба из gen_activity.
  const plays = countSafe(
    sql`SELECT count(*) as c FROM gen_activity WHERE action='play' AND ${sinceCondition} AND ${gaHostCond}`,
  );
  const playsUnique = countSafe(
    sql`SELECT count(DISTINCT ip) as c FROM gen_activity WHERE action='play' AND ${sinceCondition} AND ${gaHostCond}`,
  );
  const playsRejected = countSafe(
    sql`SELECT count(*) as c FROM gen_activity WHERE action LIKE 'play_rejected%' AND ${sinceCondition} AND ${gaHostCond}`,
  );

  const downloads = countSafe(
    sql`SELECT count(*) as c FROM gen_activity WHERE action='download' AND ${sinceCondition} AND ${gaHostCond}`,
  );

  // users — host через JOIN. domain=null → без фильтра (быстрый путь).
  const usersDomainCond = userDomainSubquery("users.id");
  const registrationsTotal = countSafe(
    sql`SELECT count(*) as c FROM users WHERE ${sinceCondition} AND ${usersDomainCond}`,
  );

  // Каналы регистраций: пытаемся вычислить по наличию полей.
  // phone_verified=1 → SMS/call, telegram_id IS NOT NULL → telegram, иначе email.
  const regByChannel = allSafe<{ channel: string; c: number }>(
    sql`SELECT
          CASE
            WHEN telegram_id IS NOT NULL AND telegram_id != '' THEN 'telegram'
            WHEN phone_verified=1 THEN 'phone'
            ELSE 'email'
          END as channel,
          count(*) as c
        FROM users
        WHERE ${sinceCondition} AND ${usersDomainCond}
        GROUP BY channel`,
  );

  // generations: host через JOIN с visitors по userId (best-effort first-touch).
  const gensDomainCond = userDomainSubquery("generations.user_id");
  const gensMusicDone = countSafe(
    sql`SELECT count(*) as c FROM generations WHERE type='music' AND status='done' AND deleted_at IS NULL AND ${sinceCondition} AND ${gensDomainCond}`,
  );
  const gensMusicError = countSafe(
    sql`SELECT count(*) as c FROM generations WHERE type='music' AND status='error' AND deleted_at IS NULL AND ${sinceCondition} AND ${gensDomainCond}`,
  );
  const gensMusicProcessing = countSafe(
    sql`SELECT count(*) as c FROM generations WHERE type='music' AND status='processing' AND deleted_at IS NULL AND ${sinceCondition} AND ${gensDomainCond}`,
  );
  const gensLyricsDone = countSafe(
    sql`SELECT count(*) as c FROM generations WHERE type='lyrics' AND status='done' AND deleted_at IS NULL AND ${sinceCondition} AND ${gensDomainCond}`,
  );
  const gensLyricsError = countSafe(
    sql`SELECT count(*) as c FROM generations WHERE type='lyrics' AND status='error' AND deleted_at IS NULL AND ${sinceCondition} AND ${gensDomainCond}`,
  );
  const gensCoverDone = countSafe(
    sql`SELECT count(*) as c FROM generations WHERE type='cover' AND status='done' AND deleted_at IS NULL AND ${sinceCondition} AND ${gensDomainCond}`,
  );
  const gensCoverError = countSafe(
    sql`SELECT count(*) as c FROM generations WHERE type='cover' AND status='error' AND deleted_at IS NULL AND ${sinceCondition} AND ${gensDomainCond}`,
  );

  // payments: host через JOIN с visitors по userId (best-effort).
  const paymentsDomainCond = userDomainSubquery("payments.user_id");
  const paymentsCount = countSafe(
    sql`SELECT count(*) as c FROM payments WHERE status='paid' AND ${sinceCondition} AND ${paymentsDomainCond}`,
  );
  const paymentsSum = (() => {
    try {
      const r = db.get<{ s: number | null }>(
        sql`SELECT COALESCE(SUM(amount),0) as s FROM payments WHERE status='paid' AND ${sinceCondition} AND ${paymentsDomainCond}`,
      );
      return r?.s ?? 0;
    } catch {
      return 0;
    }
  })();

  // visitors: host напрямую (есть в схеме). Сохраняем существующий фильтр по
  // created_at (back-compat) — last_visit-фильтр идёт в отдельных endpoint'ах.
  // Counters-audit 2026-05-19 D.2: bot UA filter — иначе цифры расходятся
  // с visitor-stats (тот фильтрует, master-dashboard — нет).
  // Eugene 2026-05-22 Босс «настоящая статистика»: + filter cron daily-bump seed.
  const botExcl = sql.raw(buildBotExclusionSql("user_agent"));
  const realExcl = sql.raw(REAL_VISITORS_SQL);
  const visitorsUnique = countSafe(
    sql`SELECT count(DISTINCT fingerprint) as c FROM visitors WHERE ${sinceCondition} AND ${visitorsHostCond} AND ${botExcl} AND ${realExcl}`,
  );
  const visitorsTotal = countSafe(
    sql`SELECT COALESCE(SUM(visits), 0) as c FROM visitors WHERE ${sinceCondition} AND ${visitorsHostCond} AND ${botExcl} AND ${realExcl}`,
  );

  return {
    plays: { total: plays, unique: playsUnique, rejected: playsRejected },
    downloads: { count: downloads },
    registrations: {
      total: registrationsTotal,
      byChannel: regByChannel.map(r => ({ channel: r.channel, count: r.c })),
    },
    generations: {
      music: { done: gensMusicDone, error: gensMusicError, processing: gensMusicProcessing },
      lyrics: { done: gensLyricsDone, error: gensLyricsError },
      cover: { done: gensCoverDone, error: gensCoverError },
    },
    payments: { count: paymentsCount, sumKopecks: paymentsSum },
    visitors: { unique: visitorsUnique, total: visitorsTotal },
  };
}

// --- Данные для графиков ---

interface ChartSeries {
  // Linear chart: точки с датой + все метрики на эту дату
  timeline: Array<{
    date: string;             // YYYY-MM-DD
    plays: number;
    registrations: number;
    generations: number;
    payments: number;
    visitors: number;
  }>;
  // Pie: каналы регистраций
  registrationChannels: Array<{ name: string; value: number }>;
  // Bar: топ-10 треков
  topTracks: Array<{ id: number; title: string; plays: number }>;
  // Heatmap: активность по часам × дню недели (0=вс, 1=пн, ..., 6=сб)
  heatmap: Array<{ day: number; hour: number; plays: number }>;
  // Sankey-data flow: registrations → first_track → second_track
  flow: {
    registrations: number;
    firstTrack: number;
    secondTrack: number;
  };
}

function buildTimeline(period: Period, bounds: PeriodBounds): ChartSeries["timeline"] {
  // Bucket по дню. Для today — bucket по часам, иначе по дням.
  // Для краткости: всегда bucket по дням (today = только 1 точка).
  const { since, until } = bounds;
  const cond = buildRangeCondition("created_at", since, until);
  type Row = { date: string; c: number };
  const playsRows = allSafe<Row>(
    sql`SELECT substr(created_at,1,10) as date, count(*) as c
        FROM gen_activity
        WHERE action='play' AND ${cond}
        GROUP BY date ORDER BY date`,
  );
  const regsRows = allSafe<Row>(
    sql`SELECT substr(created_at,1,10) as date, count(*) as c
        FROM users
        WHERE ${cond}
        GROUP BY date ORDER BY date`,
  );
  const gensRows = allSafe<Row>(
    sql`SELECT substr(created_at,1,10) as date, count(*) as c
        FROM generations
        WHERE ${cond} AND deleted_at IS NULL
        GROUP BY date ORDER BY date`,
  );
  const paysRows = allSafe<Row>(
    sql`SELECT substr(created_at,1,10) as date, count(*) as c
        FROM payments
        WHERE status='paid' AND ${cond}
        GROUP BY date ORDER BY date`,
  );
  const visRows = allSafe<Row>(
    sql`SELECT substr(created_at,1,10) as date, count(DISTINCT fingerprint) as c
        FROM visitors
        WHERE ${cond}
        GROUP BY date ORDER BY date`,
  );

  // Объединить даты
  const allDates = new Set<string>();
  for (const arr of [playsRows, regsRows, gensRows, paysRows, visRows]) {
    for (const r of arr) if (r.date) allDates.add(r.date);
  }
  const dates = Array.from(allDates).sort();
  const get = (rows: Row[], date: string): number => rows.find(r => r.date === date)?.c ?? 0;
  return dates.map(date => ({
    date,
    plays: get(playsRows, date),
    registrations: get(regsRows, date),
    generations: get(gensRows, date),
    payments: get(paysRows, date),
    visitors: get(visRows, date),
  }));
}

function buildRegistrationChannels(bounds: PeriodBounds): ChartSeries["registrationChannels"] {
  const { since, until } = bounds;
  const condition = buildRangeCondition("created_at", since, until);
  const rows = allSafe<{ channel: string; c: number }>(
    sql`SELECT
          CASE
            WHEN telegram_id IS NOT NULL AND telegram_id != '' THEN 'Telegram'
            WHEN phone_verified=1 THEN 'Телефон (SMS/звонок)'
            ELSE 'Email'
          END as channel,
          count(*) as c
        FROM users
        WHERE ${condition}
        GROUP BY channel`,
  );
  return rows.map(r => ({ name: r.channel, value: r.c }));
}

function buildTopTracks(bounds: PeriodBounds): ChartSeries["topTracks"] {
  const { since, until } = bounds;
  const condition = buildRangeCondition("ga.created_at", since, until);
  const rows = allSafe<{ id: number; title: string | null; c: number }>(
    sql`SELECT g.id as id, COALESCE(g.display_title, g.prompt) as title, count(ga.id) as c
        FROM gen_activity ga
        JOIN generations g ON g.id = ga.gen_id
        WHERE ga.action='play' AND ${condition} AND g.deleted_at IS NULL
        GROUP BY g.id
        ORDER BY c DESC
        LIMIT 10`,
  );
  return rows.map(r => ({
    id: r.id,
    title: (r.title || "Без названия").slice(0, 60),
    plays: r.c,
  }));
}

function buildHeatmap(bounds: PeriodBounds): ChartSeries["heatmap"] {
  // SQLite: strftime('%w', x) = день недели 0..6 (вс=0)
  //         strftime('%H', x) = час 0..23
  const { since, until } = bounds;
  const condition = buildRangeCondition("created_at", since, until);
  const rows = allSafe<{ day: string; hour: string; c: number }>(
    sql`SELECT strftime('%w', created_at) as day,
               strftime('%H', created_at) as hour,
               count(*) as c
        FROM gen_activity
        WHERE action='play' AND ${condition}
        GROUP BY day, hour`,
  );
  return rows.map(r => ({
    day: parseInt(r.day, 10) || 0,
    hour: parseInt(r.hour, 10) || 0,
    plays: r.c,
  }));
}

function buildFlow(bounds: PeriodBounds): ChartSeries["flow"] {
  const { since, until } = bounds;
  const condition = buildRangeCondition("u.created_at", since, until);
  const registrations = countSafe(
    sql`SELECT count(*) as c FROM users u WHERE ${condition}`,
  );
  // Пользователи, у которых есть >= 1 завершённая генерация music
  const firstTrack = countSafe(
    sql`SELECT count(DISTINCT u.id) as c
        FROM users u
        JOIN generations g ON g.user_id=u.id AND g.type='music' AND g.status='done' AND g.deleted_at IS NULL
        WHERE ${condition}`,
  );
  // Пользователи с >= 2 завершёнными
  const secondTrack = countSafe(
    sql`SELECT count(*) as c FROM (
          SELECT u.id
          FROM users u
          JOIN generations g ON g.user_id=u.id AND g.type='music' AND g.status='done' AND g.deleted_at IS NULL
          WHERE ${condition}
          GROUP BY u.id
          HAVING count(g.id) >= 2
        )`,
  );
  return { registrations, firstTrack, secondTrack };
}

function buildChartSeries(period: Period, bounds: PeriodBounds | string | null): ChartSeries {
  const b = normalizeBounds(bounds);
  return {
    timeline: buildTimeline(period, b),
    registrationChannels: buildRegistrationChannels(b),
    topTracks: buildTopTracks(b),
    heatmap: buildHeatmap(b),
    flow: buildFlow(b),
  };
}

// --- Click stats (Eugene 2026-05-17 Босс «Агент Клик») ---
//
// Берёт click + page_view + page_exit события из user_journey_events,
// агрегирует по странице × элементу. Element-key — лучший доступный
// идентификатор из meta: dataTrack > id > text > tag (см. user-journey.ts).
//
// Поля meta для click (из onClick в user-journey.ts):
//   tag, id, dataTrack, text, pointerType, x, y
//
// Берём COALESCE(dataTrack, id, text, tag) — без trim'а (клиент уже обрезает
// до 60 chars + null'ит пустые). Если все null → 'unknown'.

interface ClickStatRow {
  page: string;
  elementKey: string;
  elementText: string | null;
  count: number;
  uniqueUsers: number;
}
interface PageStatRow {
  page: string;
  totalClicks: number;
  pageViews: number;
  avgTimeMs: number;
  bounceRate: number;
}
interface ClickStats {
  topClicks: ClickStatRow[];
  byPage: Record<string, PageStatRow>;
  topElements: ClickStatRow[];
  totalClicks: number;
  uniqueClickers: number;
  period: Period;
  since: string | null;
  generatedAt: string;
}

const clickStatsCache = new Map<string, CacheEntry>();
function getCachedClicks(key: string): ClickStats | null {
  const e = clickStatsCache.get(key);
  if (e && e.expiresAt > Date.now()) return e.data as ClickStats;
  return null;
}
function setCachedClicks(key: string, data: ClickStats): void {
  clickStatsCache.set(key, { data, expiresAt: Date.now() + CACHE_TTL_MS });
}

function buildClickStats(
  period: Period,
  bounds: PeriodBounds,
  domain: DomainBucket | null = null,
): ClickStats {
  const { since, until } = bounds;
  const fromIso = since || "1970-01-01T00:00:00.000Z";
  // Когда задан upper bound — условие включает until; иначе только нижнее.
  const inRangeOnly = until
    ? sql`created_at >= ${fromIso} AND created_at < ${until}`
    : sql`created_at >= ${fromIso}`;
  // Eugene 2026-05-17 Босс: per-domain фильтр (user_journey_events.host).
  const hostCond = buildHostCondition("host", domain);
  const inRange = sql`${inRangeOnly} AND ${hostCond}`;

  // Топ-50 click-элементов по page × element_key.
  // json_extract возвращает NULL если поле отсутствует — COALESCE даёт fallback.
  // 'unknown' финальный sink (нет ни одного полезного идентификатора).
  const topClickRows = allSafe<{
    page: string;
    element_key: string;
    element_text: string | null;
    c: number;
    users: number;
  }>(sql`
    SELECT
      page,
      COALESCE(
        json_extract(meta, '$.dataTrack'),
        json_extract(meta, '$.id'),
        json_extract(meta, '$.text'),
        json_extract(meta, '$.tag'),
        'unknown'
      ) AS element_key,
      json_extract(meta, '$.text') AS element_text,
      count(*) AS c,
      count(DISTINCT session_key) AS users
    FROM user_journey_events
    WHERE event_type='click' AND ${inRange}
    GROUP BY page, element_key
    ORDER BY c DESC
    LIMIT 50
  `);

  // По страницам: total clicks + page_views + bounce.
  // page_views: COUNT(*) WHERE event_type='page_view'.
  // bounce: сессии, в которых только 1 page_view + 0 click'ов на этой
  // странице. Считаем приблизительно: bounce_sessions / page_views.
  const pageStatsRows = allSafe<{
    page: string;
    clicks: number;
    views: number;
  }>(sql`
    SELECT
      page,
      SUM(CASE WHEN event_type='click' THEN 1 ELSE 0 END) AS clicks,
      SUM(CASE WHEN event_type='page_view' THEN 1 ELSE 0 END) AS views
    FROM user_journey_events
    WHERE event_type IN ('click','page_view') AND ${inRange}
    GROUP BY page
  `);

  // Среднее время на странице — из page_exit events (meta.duration_ms).
  const pageTimeRows = allSafe<{
    page: string;
    avg_ms: number;
    exits: number;
  }>(sql`
    SELECT
      page,
      AVG(CAST(json_extract(meta, '$.duration_ms') AS REAL)) AS avg_ms,
      count(*) AS exits
    FROM user_journey_events
    WHERE event_type='page_exit'
      AND ${inRange}
      AND json_extract(meta, '$.duration_ms') IS NOT NULL
    GROUP BY page
  `);

  // Bounce: сессии где на странице был ровно 1 page_view без click.
  // Грубое приближение: count(sessions where page_views=1 AND clicks=0) /
  // total page_view sessions для этой страницы.
  const bounceRows = allSafe<{
    page: string;
    bounced: number;
    total_sessions: number;
  }>(sql`
    SELECT
      page,
      SUM(CASE WHEN clicks=0 AND views>=1 THEN 1 ELSE 0 END) AS bounced,
      count(*) AS total_sessions
    FROM (
      SELECT
        session_key,
        page,
        SUM(CASE WHEN event_type='click' THEN 1 ELSE 0 END) AS clicks,
        SUM(CASE WHEN event_type='page_view' THEN 1 ELSE 0 END) AS views
      FROM user_journey_events
      WHERE event_type IN ('click','page_view') AND ${inRange}
      GROUP BY session_key, page
    )
    GROUP BY page
  `);

  // Сборка byPage map.
  const byPage: Record<string, PageStatRow> = {};
  for (const r of pageStatsRows) {
    byPage[r.page] = {
      page: r.page,
      totalClicks: Number(r.clicks) || 0,
      pageViews: Number(r.views) || 0,
      avgTimeMs: 0,
      bounceRate: 0,
    };
  }
  for (const r of pageTimeRows) {
    if (!byPage[r.page]) {
      byPage[r.page] = {
        page: r.page,
        totalClicks: 0,
        pageViews: 0,
        avgTimeMs: 0,
        bounceRate: 0,
      };
    }
    byPage[r.page].avgTimeMs = Math.round(Number(r.avg_ms) || 0);
  }
  for (const r of bounceRows) {
    if (!byPage[r.page]) continue;
    const total = Number(r.total_sessions) || 0;
    if (total > 0) {
      byPage[r.page].bounceRate = Math.round((Number(r.bounced) / total) * 100) / 100;
    }
  }

  // Topclicks (топ-50 по page+element).
  const topClicks: ClickStatRow[] = topClickRows.map(r => ({
    page: r.page,
    elementKey: String(r.element_key || "unknown"),
    elementText: r.element_text ? String(r.element_text) : null,
    count: Number(r.c) || 0,
    uniqueUsers: Number(r.users) || 0,
  }));

  // Top-20 элементов глобально (без разреза по странице).
  const topElementRows = allSafe<{
    element_key: string;
    element_text: string | null;
    c: number;
    users: number;
  }>(sql`
    SELECT
      COALESCE(
        json_extract(meta, '$.dataTrack'),
        json_extract(meta, '$.id'),
        json_extract(meta, '$.text'),
        json_extract(meta, '$.tag'),
        'unknown'
      ) AS element_key,
      json_extract(meta, '$.text') AS element_text,
      count(*) AS c,
      count(DISTINCT session_key) AS users
    FROM user_journey_events
    WHERE event_type='click' AND ${inRange}
    GROUP BY element_key
    ORDER BY c DESC
    LIMIT 20
  `);
  const topElements: ClickStatRow[] = topElementRows.map(r => ({
    page: "*",
    elementKey: String(r.element_key || "unknown"),
    elementText: r.element_text ? String(r.element_text) : null,
    count: Number(r.c) || 0,
    uniqueUsers: Number(r.users) || 0,
  }));

  const totalClicks = countSafe(
    sql`SELECT count(*) as c FROM user_journey_events WHERE event_type='click' AND ${inRange}`,
  );
  const uniqueClickers = countSafe(
    sql`SELECT count(DISTINCT session_key) as c FROM user_journey_events WHERE event_type='click' AND ${inRange}`,
  );

  return {
    topClicks,
    byPage,
    topElements,
    totalClicks,
    uniqueClickers,
    period,
    since,
    generatedAt: new Date().toISOString(),
  };
}

// --- GET /api/admin/v304/click-stats ---

router.get("/click-stats", requireAdmin, (req, res) => {
  try {
    const period = parsePeriod(req.query.period);
    const bounds = periodToBounds(
      period,
      typeof req.query.from === "string" ? req.query.from : undefined,
      typeof req.query.to === "string" ? req.query.to : undefined,
    );
    // Eugene 2026-05-17 Босс: опциональный domain-фильтр (per-domain трекинг).
    const domain = parseDomainParam(req.query.domain);
    const key = `${cacheKey(period, bounds)}|d=${domain || "all"}`;
    const cached = getCachedClicks(key);
    if (cached) {
      return res.json({ data: { ...cached, fromCache: true }, error: null });
    }
    const payload = buildClickStats(period, bounds, domain);
    setCachedClicks(key, payload);
    res.json({ data: { ...payload, fromCache: false }, error: null });
  } catch (err) {
    res
      .status(500)
      .json({ data: null, error: err instanceof Error ? err.message : "internal" });
  }
});

// --- GET /api/admin/v304/dashboard-summary ---

router.get("/dashboard-summary", requireAdmin, (req, res) => {
  try {
    const period = parsePeriod(req.query.period);
    const bounds = periodToBounds(
      period,
      typeof req.query.from === "string" ? req.query.from : undefined,
      typeof req.query.to === "string" ? req.query.to : undefined,
    );
    // Eugene 2026-05-17 Босс: опциональный domain-фильтр (per-domain трекинг).
    const domain = parseDomainParam(req.query.domain);
    // Ключ кэша — period + domain (разные домены кэшируются отдельно).
    const key = `${cacheKey(period, bounds)}|d=${domain || "all"}`;
    const cached = getCached(key);
    if (cached) {
      return res.json({ data: { ...cached, fromCache: true }, error: null });
    }
    const payload = {
      period,
      since: bounds.since,
      until: bounds.until,
      domain,
      generatedAt: new Date().toISOString(),
      cacheExpiresAt: new Date(Date.now() + CACHE_TTL_MS).toISOString(),
      statusCards: buildStatusCards(),
      metrics: buildPeriodMetrics(bounds, domain),
      charts: buildChartSeries(period, bounds),
    };
    setCached(key, payload);
    res.json({ data: { ...payload, fromCache: false }, error: null });
  } catch (err) {
    res
      .status(500)
      .json({ data: null, error: err instanceof Error ? err.message : "internal" });
  }
});

// --- GET /api/admin/v304/brain-export ---
//
// Возвращает snapshot всей метрики в формате nodes/edges/metrics.
// Это data source для будущей 3D Second Brain визуализации.

interface BrainNode {
  id: string;
  group: string;            // 'core' | 'plugin' | 'channel' | 'provider' | 'metric'
  label: string;
  status: "green" | "yellow" | "red" | "unknown";
  metrics?: Record<string, number | string>;
}
interface BrainEdge {
  from: string;
  to: string;
  weight?: number;
  kind?: string;             // 'depends-on' | 'emits-to' | 'reads-from'
}

router.get("/brain-export", requireAdmin, (_req, res) => {
  try {
    const statusCards = buildStatusCards();
    const metrics30 = buildPeriodMetrics(periodToSince("30d"));
    const since30 = periodToSince("30d");

    // Eugene 2026-05-17 Босс: per-domain breakdown за 30д.
    // Для каждого bucket (3 known + other) — visitors / plays / registrations
    // / payments. Тяжёлый запрос но один раз — кэшируется в caller (brain-export
    // dump не chatty).
    const domainBuckets: Array<DomainBucket> = [...KNOWN_DOMAINS, "other"];
    const byDomain: Record<DomainBucket, {
      visitors: number;
      plays: number;
      registrations: number;
      payments: { count: number; rub: number };
    }> = {} as any;
    for (const bucket of domainBuckets) {
      const m = buildPeriodMetrics(periodToBounds("30d"), bucket);
      byDomain[bucket] = {
        visitors: m.visitors.unique,
        plays: m.plays.total,
        registrations: m.registrations.total,
        payments: {
          count: m.payments.count,
          rub: Math.round(m.payments.sumKopecks / 100),
        },
      };
    }

    // Plugins из registry
    const plugins = allSafe<{ name: string; status: string; version: string }>(
      sql`SELECT name, status, version FROM plugins_registry`,
    );

    // Pluings → 'plugin' nodes
    const pluginNodes: BrainNode[] = plugins.map(p => ({
      id: `plugin:${p.name}`,
      group: "plugin",
      label: p.name,
      status: p.status === "active" ? "green" : p.status === "failed" ? "red" : "yellow",
      metrics: { version: p.version },
    }));

    // Каналы — фиксированный набор + статус из statusCards
    const botsCard = statusCards.find(s => s.key === "bots");
    const channelNodes: BrainNode[] = [
      { id: "channel:web", group: "channel", label: "Web", status: "green" },
      { id: "channel:telegram", group: "channel", label: "Telegram", status: process.env.TELEGRAM_BOT_TOKEN ? "green" : "red" },
      { id: "channel:max", group: "channel", label: "Max", status: process.env.MAX_BOT_TOKEN ? "green" : "red" },
      { id: "channel:email", group: "channel", label: "Email", status: (process.env.GMAIL_APP_PASSWORD || process.env.SMTP_PASS) ? "green" : "red" },
      { id: "channel:sms", group: "channel", label: "SMS/Звонок", status: process.env.SMSRU_API_ID ? "green" : "yellow" },
    ];

    // Провайдеры
    const providerNodes: BrainNode[] = [
      { id: "provider:gptunnel", group: "provider", label: "GPTunnel (Suno)", status: process.env.GPTUNNEL_API_KEY ? "green" : "red" },
      // Eugene 2026-05-20 Босс: TimeWeb primary, Anthropic fallback (раньше наоборот).
      { id: "provider:timeweb", group: "provider", label: "TimeWeb LLM (primary)", status: process.env.TIMEWEB_GATEWAY_KEY ? "green" : "yellow" },
      { id: "provider:anthropic", group: "provider", label: "Anthropic (fallback)", status: process.env.ANTHROPIC_API_KEY ? "green" : "yellow" },
      { id: "provider:openai", group: "provider", label: "OpenAI", status: process.env.OPENAI_API_KEY ? "green" : "yellow" },
      { id: "provider:yandex", group: "provider", label: "Yandex SpeechKit", status: process.env.YANDEX_SPEECHKIT_API_KEY ? "green" : "yellow" },
      { id: "provider:robokassa", group: "provider", label: "Robokassa", status: process.env.ROBO_PASSWORD_1 ? "green" : "red" },
    ];

    // Core-узлы — БД и метрики
    const dbCard = statusCards.find(s => s.key === "db");
    const coreNodes: BrainNode[] = [
      {
        id: "core:db",
        group: "core",
        label: "SQLite (data.db)",
        status: dbCard?.status || "unknown",
        metrics: {
          users: countSafe(sql`SELECT count(*) as c FROM users`),
          generations: countSafe(sql`SELECT count(*) as c FROM generations WHERE deleted_at IS NULL`),
          transactions: countSafe(sql`SELECT count(*) as c FROM transactions`),
        },
      },
      {
        id: "core:eventbus",
        group: "core",
        label: "EventBus",
        status: "green",
        metrics: { events24h: countSafe(sql`SELECT count(*) as c FROM events WHERE occurred_at >= datetime('now','-24 hours')`) },
      },
    ];

    // Metric-узлы — агрегаты за 30 дней
    const metricNodes: BrainNode[] = [
      {
        id: "metric:plays30d",
        group: "metric",
        label: "Прослушивания 30д",
        status: "green",
        metrics: { value: metrics30.plays.total, unique: metrics30.plays.unique, rejected: metrics30.plays.rejected },
      },
      {
        id: "metric:registrations30d",
        group: "metric",
        label: "Регистрации 30д",
        status: "green",
        metrics: { value: metrics30.registrations.total },
      },
      {
        id: "metric:payments30d",
        group: "metric",
        label: "Платежи 30д",
        status: "green",
        metrics: { count: metrics30.payments.count, rub: Math.round(metrics30.payments.sumKopecks / 100) },
      },
      {
        id: "metric:visitors30d",
        group: "metric",
        label: "Visitors 30д",
        status: "green",
        metrics: { unique: metrics30.visitors.unique, total: metrics30.visitors.total },
      },
    ];

    const nodes: BrainNode[] = [
      ...coreNodes,
      ...pluginNodes,
      ...channelNodes,
      ...providerNodes,
      ...metricNodes,
    ];

    // Edges — упрощённый граф зависимостей
    const edges: BrainEdge[] = [];
    // Все плагины читают из core:db
    for (const p of plugins) {
      edges.push({ from: `plugin:${p.name}`, to: "core:db", kind: "reads-from" });
    }
    // Каналы → core:eventbus
    for (const ch of channelNodes) {
      edges.push({ from: ch.id, to: "core:eventbus", kind: "emits-to" });
    }
    // Провайдеры — провайдеры подключены к соответствующим плагинам
    const wirings: Array<[string, string]> = [
      ["provider:gptunnel", "plugin:generation-agent"],
      ["provider:gptunnel", "plugin:suno-watchdog"],
      ["provider:anthropic", "plugin:chatbot"],
      ["provider:timeweb", "plugin:chatbot"],
      ["provider:openai", "plugin:chatbot"],
      ["provider:yandex", "plugin:audio-upload"],
      ["provider:robokassa", "plugin:admin-overview"],
      ["channel:telegram", "plugin:telegram-bot"],
      ["channel:max", "plugin:max-bot"],
      ["channel:sms", "plugin:auth-sms"],
    ];
    for (const [from, to] of wirings) {
      // Только если оба узла существуют (некоторые плагины могут отсутствовать)
      if (nodes.find(n => n.id === from) && nodes.find(n => n.id === to)) {
        edges.push({ from, to, kind: "depends-on" });
      }
    }
    // Метрики → core:db
    for (const m of metricNodes) {
      edges.push({ from: m.id, to: "core:db", kind: "reads-from" });
    }

    // clickStats — топ-горячие точки сайта (для 3D «горячих зон» в Second Brain).
    // Берём минимальный slice: top-20 элементов + byPage. Полный список в
    // /click-stats endpoint'е. Cache shared (через те же 60 сек).
    let clickStatsSlice: {
      topElements: Array<{
        elementKey: string;
        elementText: string | null;
        count: number;
        uniqueUsers: number;
      }>;
      byPage: Record<string, {
        totalClicks: number;
        pageViews: number;
        avgTimeMs: number;
        bounceRate: number;
      }>;
      totalClicks: number;
      uniqueClickers: number;
    } = { topElements: [], byPage: {}, totalClicks: 0, uniqueClickers: 0 };
    try {
      let cs = getCachedClicks("30d");
      if (!cs) {
        cs = buildClickStats("30d", periodToBounds("30d"));
        setCachedClicks("30d", cs);
      }
      clickStatsSlice = {
        topElements: cs.topElements.map(e => ({
          elementKey: e.elementKey,
          elementText: e.elementText,
          count: e.count,
          uniqueUsers: e.uniqueUsers,
        })),
        byPage: Object.fromEntries(
          Object.entries(cs.byPage).map(([page, p]) => [
            page,
            {
              totalClicks: p.totalClicks,
              pageViews: p.pageViews,
              avgTimeMs: p.avgTimeMs,
              bounceRate: p.bounceRate,
            },
          ]),
        ),
        totalClicks: cs.totalClicks,
        uniqueClickers: cs.uniqueClickers,
      };
    } catch {
      // user_journey_events может ещё не быть на старой БД — оставляем пустой
      // slice. Не блокируем brain-export.
    }

    res.json({
      data: {
        generatedAt: new Date().toISOString(),
        period: "30d",
        since: since30,
        nodes,
        edges,
        clickStats: clickStatsSlice,
        byDomain,
        summary: {
          totals: {
            nodes: nodes.length,
            edges: edges.length,
            plugins: pluginNodes.length,
            channels: channelNodes.length,
            providers: providerNodes.length,
            clicks: clickStatsSlice.totalClicks,
            uniqueClickers: clickStatsSlice.uniqueClickers,
          },
          health: {
            green: nodes.filter(n => n.status === "green").length,
            yellow: nodes.filter(n => n.status === "yellow").length,
            red: nodes.filter(n => n.status === "red").length,
            unknown: nodes.filter(n => n.status === "unknown").length,
          },
        },
      },
      error: null,
    });
  } catch (err) {
    res
      .status(500)
      .json({ data: null, error: err instanceof Error ? err.message : "internal" });
  }
});

// --- GET /api/admin/v304/briefing-text ---
//
// Eugene 2026-05-17 Босс «Муза доложит». Собирает русский текст-доклад из
// текущего dashboard-summary snapshot. UI получает текст, чтобы:
//  1) показать subtitle во время озвучки,
//  2) передать его в POST /tts для генерации mp3.
//
// Возвращает {text, period, generatedAt, length}.

router.get("/briefing-text", requireAdmin, (req, res) => {
  try {
    const period = parsePeriod(req.query.period);
    const bounds = periodToBounds(
      period,
      typeof req.query.from === "string" ? req.query.from : undefined,
      typeof req.query.to === "string" ? req.query.to : undefined,
    );
    const key = cacheKey(period, bounds);
    let snapshot: any = getCached(key);
    if (!snapshot) {
      snapshot = {
        period,
        since: bounds.since,
        until: bounds.until,
        generatedAt: new Date().toISOString(),
        cacheExpiresAt: new Date(Date.now() + CACHE_TTL_MS).toISOString(),
        statusCards: buildStatusCards(),
        metrics: buildPeriodMetrics(bounds),
        charts: buildChartSeries(period, bounds),
      };
      setCached(key, snapshot);
    }
    const text = buildAdminBriefing({
      period,
      statusCards: snapshot.statusCards,
      metrics: snapshot.metrics,
    });
    res.json({
      data: {
        text,
        period,
        generatedAt: snapshot.generatedAt,
        length: text.length,
        costKopecks: estimateTtsCostKopecks(text.length),
      },
      error: null,
    });
  } catch (err) {
    res
      .status(500)
      .json({ data: null, error: err instanceof Error ? err.message : "internal" });
  }
});

// --- POST /api/admin/v304/tts ---
//
// Озвучка произвольного русского текста через Yandex SpeechKit TTS.
// Body: { text: string, voice?: 'alena'|'jane'|'oksana'|... }
// Response: audio/mpeg (binary mp3 stream).
//
// Особенности:
//  - rate-limit 10/мин на admin (TTS платный, ~0.40₽ за вызов).
//  - In-memory cache 5 мин по hash(text+voice) — повторный клик «Доложить»
//    бесплатен.
//  - Audit-log в admin_audit_log (для траты бюджета).

router.post("/tts", requireAdmin, async (req, res) => {
  try {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const text = typeof body.text === "string" ? body.text.trim() : "";
    const voiceRaw = typeof body.voice === "string" ? body.voice : "alena";
    const voice: YandexVoice = (VALID_TTS_VOICES as string[]).includes(voiceRaw)
      ? (voiceRaw as YandexVoice)
      : "alena";

    if (!text) {
      return res.status(400).json({ data: null, error: "text is required" });
    }
    if (text.length > 5000) {
      return res
        .status(400)
        .json({ data: null, error: `text too long (${text.length} > 5000)` });
    }

    // Per-admin rate limit (key = userId если есть, иначе IP)
    const userId = (req as any).userId ?? (req as any).user?.id ?? null;
    const rateKey = userId ? `u:${userId}` : `ip:${req.ip || "anon"}`;
    if (!ttsRateOk(rateKey)) {
      return res
        .status(429)
        .json({ data: null, error: "rate-limit: 10 TTS requests per minute" });
    }

    // Cache lookup
    const cached = getTtsFromCache(text, voice, "mp3");
    if (cached) {
      res.setHeader("Content-Type", cached.contentType);
      res.setHeader("Content-Length", String(cached.audio.length));
      res.setHeader("X-Cache", "HIT");
      res.setHeader("Cache-Control", "no-store");
      return res.end(cached.audio);
    }

    const result = await synthesizeYandexTts({ text, voice, format: "mp3" });
    if (!result.ok || !result.audio) {
      return res
        .status(result.httpStatus && result.httpStatus >= 400 ? 502 : 500)
        .json({ data: null, error: result.error || "TTS synthesis failed" });
    }

    putTtsInCache(text, voice, "mp3", result.audio, result.contentType || "audio/mpeg");

    // Audit-log: фиксируем расход (НЕ пишем text — может быть PII).
    // action='create' — admin_audit_log CHECK ограничен create/update/delete/restore.
    // Поэтому семантику «tts synthesize» кладём в entity + after_json.
    try {
      db.run(sql`INSERT INTO admin_audit_log (admin_user_id, action, entity, entity_key, before_json, after_json)
                 VALUES (${userId}, 'create', 'tts:yandex', ${voice},
                 ${null},
                 ${JSON.stringify({
                   action: "synthesize",
                   textLen: text.length,
                   voice,
                   format: "mp3",
                   bytes: result.audio.length,
                   costKopecks: estimateTtsCostKopecks(text.length),
                   durationMs: result.durationMs ?? null,
                 })})`);
    } catch (e) {
      // Audit не должен ломать ответ — продолжаем.
      console.warn("[TTS] audit-log insert failed:", e instanceof Error ? e.message : e);
    }

    res.setHeader("Content-Type", result.contentType || "audio/mpeg");
    res.setHeader("Content-Length", String(result.audio.length));
    res.setHeader("X-Cache", "MISS");
    res.setHeader("Cache-Control", "no-store");
    return res.end(result.audio);
  } catch (err) {
    console.error("[TTS] handler exception:", err);
    return res
      .status(500)
      .json({ data: null, error: err instanceof Error ? err.message : "internal" });
  }
});

// --- GET /api/admin/v304/dashboard-detail/:metric ---
//
// Drill-down детали по конкретной метрике или status-индикатору. Backend для
// expandable panels в admin master-dashboard tab (Eugene 2026-05-17).
//
// Поддерживаемые metric:
//   Status:
//     llm           — детали по каждому LLM-каналу (наличие ключа)
//     generation    — success/fail rate за 24ч + типичные ошибки
//     auth          — registrations breakdown by channel + failed attempts
//     payments      — last invoices (24ч / period) + статусы
//     bots          — webhook last received + last error per channel
//     db            — PRAGMA integrity + size + table sizes
//     disk          — db_size + auto-backups + free space estimate
//   Period metrics:
//     plays         — by day + top tracks + by hour heatmap-snapshot
//     registrations — breakdown by channel + new vs existing
//     generations   — success/fail by type + avg duration
//     payments-period — последние платежи периода с amount/status
//     visitors      — top countries / cities / device

router.get("/dashboard-detail/:metric", requireAdmin, (req, res) => {
  try {
    const metric = String(req.params.metric || "").toLowerCase();
    const period = parsePeriod(req.query.period);
    const bounds = periodToBounds(
      period,
      typeof req.query.from === "string" ? req.query.from : undefined,
      typeof req.query.to === "string" ? req.query.to : undefined,
    );
    const detail = buildDashboardDetail(metric, period, bounds);
    if (!detail) {
      return res
        .status(404)
        .json({ data: null, error: `unknown metric: ${metric}` });
    }
    return res.json({
      data: { metric, period, since: bounds.since, until: bounds.until, ...detail },
      error: null,
    });
  } catch (err) {
    return res
      .status(500)
      .json({ data: null, error: err instanceof Error ? err.message : "internal" });
  }
});

function buildDashboardDetail(
  metric: string,
  period: Period,
  bounds: PeriodBounds,
): Record<string, unknown> | null {
  switch (metric) {
    case "llm":
      return detailLLM();
    case "generation":
      return detailGeneration();
    case "auth":
      return detailAuth(bounds);
    case "payments":
      return detailPaymentsStatus();
    case "bots":
      return detailBots();
    case "db":
      return detailDb();
    case "disk":
      return detailDisk();
    case "plays":
      return detailPlays(bounds);
    case "registrations":
      return detailRegistrations(bounds);
    case "generations":
      return detailGenerationsPeriod(bounds);
    case "payments-period":
      return detailPaymentsPeriod(bounds);
    case "visitors":
      return detailVisitors(bounds);
    default:
      return null;
  }
}

// --- helpers для buildDashboardDetail ---

function fmtKey(present: boolean): { status: "ok" | "missing"; label: string } {
  return present
    ? { status: "ok", label: "настроен" }
    : { status: "missing", label: "не настроен" };
}

function detailLLM(): Record<string, unknown> {
  const channels = [
    { id: "anthropic", label: "Anthropic Claude", ...fmtKey(!!process.env.ANTHROPIC_API_KEY) },
    { id: "timeweb", label: "TimeWeb Gateway", ...fmtKey(!!process.env.TIMEWEB_GATEWAY_KEY) },
    { id: "openai", label: "OpenAI", ...fmtKey(!!process.env.OPENAI_API_KEY) },
    { id: "gptunnel", label: "GPTunnel (Suno+LLM)", ...fmtKey(!!process.env.GPTUNNEL_API_KEY) },
  ];
  return {
    channels,
    summary: {
      configured: channels.filter(c => c.status === "ok").length,
      total: channels.length,
    },
  };
}

function detailGeneration(): Record<string, unknown> {
  const since24h = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
  const done = countSafe(
    sql`SELECT count(*) as c FROM generations WHERE type='music' AND status='done' AND deleted_at IS NULL AND created_at >= ${since24h}`,
  );
  const error = countSafe(
    sql`SELECT count(*) as c FROM generations WHERE type='music' AND status='error' AND deleted_at IS NULL AND created_at >= ${since24h}`,
  );
  const processing = countSafe(
    sql`SELECT count(*) as c FROM generations WHERE type='music' AND status='processing' AND deleted_at IS NULL AND created_at >= ${since24h}`,
  );
  // Топ-5 типичных ошибок за 24ч
  const reasons = allSafe<{ reason: string; c: number }>(
    sql`SELECT COALESCE(error_reason, 'unknown') as reason, count(*) as c
        FROM generations
        WHERE type='music' AND status='error' AND deleted_at IS NULL AND created_at >= ${since24h}
        GROUP BY reason
        ORDER BY c DESC
        LIMIT 5`,
  );
  const total = done + error;
  return {
    last24h: {
      done,
      error,
      processing,
      total,
      successRate: total > 0 ? Math.round((done / total) * 100) : 100,
    },
    topErrors: reasons.map(r => ({ reason: r.reason, count: r.c })),
  };
}

function detailAuth(bounds: PeriodBounds): Record<string, unknown> {
  const cond = buildRangeCondition("created_at", bounds.since, bounds.until);
  const byChannel = allSafe<{ channel: string; c: number }>(
    sql`SELECT
          CASE
            WHEN telegram_id IS NOT NULL AND telegram_id != '' THEN 'telegram'
            WHEN phone_verified=1 THEN 'phone'
            ELSE 'email'
          END as channel,
          count(*) as c
        FROM users
        WHERE ${cond}
        GROUP BY channel`,
  );
  // Failed attempts из user_action_failures (если таблица существует)
  const failedAuth = allSafe<{ action: string; error_code: string | null; c: number }>(
    sql`SELECT action, error_code, count(*) as c
        FROM user_action_failures
        WHERE action LIKE 'auth%' AND ${cond}
        GROUP BY action, error_code
        ORDER BY c DESC
        LIMIT 10`,
  );
  return {
    byChannel: byChannel.map(r => ({ channel: r.channel, count: r.c })),
    failedAttempts: failedAuth.map(r => ({
      action: r.action,
      errorCode: r.error_code || "unknown",
      count: r.c,
    })),
    providers: {
      sms: !!process.env.SMSRU_API_ID,
      email: !!process.env.GMAIL_APP_PASSWORD || !!process.env.SMTP_PASS,
      telegram: !!process.env.TELEGRAM_BOT_TOKEN,
    },
  };
}

function detailPaymentsStatus(): Record<string, unknown> {
  const since24h = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
  const recent = allSafe<{
    inv_id: number;
    amount: number;
    status: string;
    description: string | null;
    created_at: string;
  }>(
    sql`SELECT inv_id, amount, status, description, created_at
        FROM payments
        WHERE created_at >= ${since24h}
        ORDER BY created_at DESC
        LIMIT 20`,
  );
  const summary = allSafe<{ status: string; c: number; s: number }>(
    sql`SELECT status, count(*) as c, COALESCE(SUM(amount),0) as s
        FROM payments
        WHERE created_at >= ${since24h}
        GROUP BY status`,
  );
  return {
    since24h: {
      summary: summary.map(r => ({
        status: r.status,
        count: r.c,
        sumKopecks: r.s,
      })),
      recent: recent.map(r => ({
        invId: r.inv_id,
        amountKopecks: r.amount,
        status: r.status,
        description: r.description,
        createdAt: r.created_at,
      })),
    },
    configured: {
      login: !!process.env.ROBOKASSA_LOGIN,
      password1: !!process.env.ROBO_PASSWORD_1,
      password2: !!process.env.ROBO_PASSWORD_2,
    },
  };
}

function detailBots(): Record<string, unknown> {
  const since24h = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
  const tgSessions = countSafe(
    sql`SELECT count(*) as c FROM chatbot_sessions WHERE channel='telegram' AND last_message_at >= ${since24h}`,
  );
  const maxSessions = countSafe(
    sql`SELECT count(*) as c FROM chatbot_sessions WHERE channel='max' AND last_message_at >= ${since24h}`,
  );
  // Последние ошибки чат-каналов из user_action_failures
  const failures = allSafe<{ channel: string; action: string; error_code: string | null; c: number; last_at: string }>(
    sql`SELECT channel, action, error_code, count(*) as c, MAX(created_at) as last_at
        FROM user_action_failures
        WHERE channel IN ('telegram','max','vk','email') AND created_at >= ${since24h}
        GROUP BY channel, action, error_code
        ORDER BY c DESC
        LIMIT 15`,
  );
  return {
    channels: [
      { id: "telegram", configured: !!process.env.TELEGRAM_BOT_TOKEN, sessions24h: tgSessions },
      { id: "max", configured: !!process.env.MAX_BOT_TOKEN, sessions24h: maxSessions },
      { id: "vk", configured: !!process.env.VK_ACCESS_TOKEN, sessions24h: 0 },
    ],
    failures24h: failures.map(r => ({
      channel: r.channel,
      action: r.action,
      errorCode: r.error_code || "unknown",
      count: r.c,
      lastAt: r.last_at,
    })),
  };
}

function detailDb(): Record<string, unknown> {
  let integrity = "unknown";
  try {
    const row = db.get<{ integrity_check: string }>(sql`PRAGMA integrity_check`);
    integrity = (row as any)?.integrity_check || (row as any)?.ic || "unknown";
  } catch (e) {
    integrity = `error: ${e instanceof Error ? e.message : String(e)}`;
  }
  // Размер БД
  let dbSize = 0;
  try {
    dbSize = fs.statSync(process.env.DATABASE_FILE || "data.db").size;
  } catch {}
  // Размеры топ-15 таблиц по количеству строк (без раскрытия PII).
  const tables = allSafe<{ name: string }>(
    sql`SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name`,
  );
  const tableStats: Array<{ name: string; rows: number }> = [];
  for (const t of tables) {
    const n = String(t.name);
    // Sanity-check имени (только идентификаторы)
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(n)) continue;
    try {
      const r = db.get<{ c: number }>(sql.raw(`SELECT count(*) as c FROM ${n}`));
      tableStats.push({ name: n, rows: r?.c ?? 0 });
    } catch {
      // ignore
    }
  }
  tableStats.sort((a, b) => b.rows - a.rows);
  return {
    integrity,
    dbSizeBytes: dbSize,
    dbSizeMb: Math.round(dbSize / 1024 / 1024),
    tables: tableStats.slice(0, 15),
    tablesTotal: tableStats.length,
  };
}

function detailDisk(): Record<string, unknown> {
  let dbSize = 0;
  let backups: Array<{ name: string; size: number; mtime: string }> = [];
  try {
    dbSize = fs.statSync(process.env.DATABASE_FILE || "data.db").size;
  } catch {}
  // Попытка прочитать /var/backups/neurohub-auto (clone-VPS); read-only — без error
  const backupDir = process.env.BACKUP_DIR || "/var/backups/neurohub-auto";
  try {
    if (fs.existsSync(backupDir)) {
      const items = fs.readdirSync(backupDir);
      backups = items
        .map(name => {
          try {
            const st = fs.statSync(`${backupDir}/${name}`);
            return {
              name,
              size: st.size,
              mtime: st.mtime.toISOString(),
            };
          } catch {
            return null;
          }
        })
        .filter((x): x is { name: string; size: number; mtime: string } => x !== null)
        .sort((a, b) => (a.mtime < b.mtime ? 1 : -1))
        .slice(0, 10);
    }
  } catch {
    // backup dir может не существовать на dev
  }
  return {
    dbSizeBytes: dbSize,
    dbSizeMb: Math.round(dbSize / 1024 / 1024),
    backupDir,
    backups,
    backupsCount: backups.length,
  };
}

function detailPlays(bounds: PeriodBounds): Record<string, unknown> {
  const cond = buildRangeCondition("created_at", bounds.since, bounds.until);
  const byDay = allSafe<{ d: string; c: number }>(
    sql`SELECT substr(created_at,1,10) as d, count(*) as c
        FROM gen_activity
        WHERE action='play' AND ${cond}
        GROUP BY d ORDER BY d`,
  );
  const byHour = allSafe<{ h: string; c: number }>(
    sql`SELECT strftime('%H', created_at) as h, count(*) as c
        FROM gen_activity
        WHERE action='play' AND ${cond}
        GROUP BY h ORDER BY h`,
  );
  const topTracks = buildTopTracks(bounds);
  const rejected = allSafe<{ action: string; c: number }>(
    sql`SELECT action, count(*) as c
        FROM gen_activity
        WHERE action LIKE 'play_rejected%' AND ${cond}
        GROUP BY action
        ORDER BY c DESC
        LIMIT 10`,
  );
  return {
    byDay: byDay.map(r => ({ date: r.d, count: r.c })),
    byHour: byHour.map(r => ({ hour: parseInt(r.h, 10) || 0, count: r.c })),
    topTracks,
    rejected: rejected.map(r => ({ reason: r.action.replace("play_rejected:", ""), count: r.c })),
  };
}

function detailRegistrations(bounds: PeriodBounds): Record<string, unknown> {
  const cond = buildRangeCondition("created_at", bounds.since, bounds.until);
  const byChannel = buildRegistrationChannels(bounds);
  const byDay = allSafe<{ d: string; c: number }>(
    sql`SELECT substr(created_at,1,10) as d, count(*) as c
        FROM users
        WHERE ${cond}
        GROUP BY d ORDER BY d`,
  );
  const total = countSafe(sql`SELECT count(*) as c FROM users WHERE ${cond}`);
  const verified = countSafe(
    sql`SELECT count(*) as c FROM users WHERE phone_verified=1 AND ${cond}`,
  );
  return {
    total,
    verified,
    byChannel,
    byDay: byDay.map(r => ({ date: r.d, count: r.c })),
  };
}

function detailGenerationsPeriod(bounds: PeriodBounds): Record<string, unknown> {
  const cond = buildRangeCondition("created_at", bounds.since, bounds.until);
  const byType = allSafe<{ type: string; status: string; c: number }>(
    sql`SELECT type, status, count(*) as c
        FROM generations
        WHERE deleted_at IS NULL AND ${cond}
        GROUP BY type, status`,
  );
  // Avg duration (для типа music у которого есть updated_at - created_at)
  const avgDur = allSafe<{ type: string; avg_sec: number }>(
    sql`SELECT type, AVG((julianday(updated_at) - julianday(created_at)) * 86400.0) as avg_sec
        FROM generations
        WHERE status='done' AND deleted_at IS NULL AND ${cond}
        GROUP BY type`,
  );
  return {
    byType: byType.map(r => ({ type: r.type, status: r.status, count: r.c })),
    avgDuration: avgDur.map(r => ({
      type: r.type,
      avgSeconds: Math.round(Number(r.avg_sec) || 0),
    })),
  };
}

function detailPaymentsPeriod(bounds: PeriodBounds): Record<string, unknown> {
  const cond = buildRangeCondition("created_at", bounds.since, bounds.until);
  const recent = allSafe<{
    inv_id: number;
    user_id: number;
    amount: number;
    status: string;
    description: string | null;
    created_at: string;
  }>(
    sql`SELECT inv_id, user_id, amount, status, description, created_at
        FROM payments
        WHERE ${cond}
        ORDER BY created_at DESC
        LIMIT 30`,
  );
  const byStatus = allSafe<{ status: string; c: number; s: number }>(
    sql`SELECT status, count(*) as c, COALESCE(SUM(amount),0) as s
        FROM payments
        WHERE ${cond}
        GROUP BY status`,
  );
  return {
    byStatus: byStatus.map(r => ({
      status: r.status,
      count: r.c,
      sumKopecks: r.s,
      sumRub: Math.round(r.s / 100),
    })),
    recent: recent.map(r => ({
      invId: r.inv_id,
      userId: r.user_id,
      amountKopecks: r.amount,
      amountRub: Math.round(r.amount / 100),
      status: r.status,
      description: r.description,
      createdAt: r.created_at,
    })),
  };
}

function detailVisitors(bounds: PeriodBounds): Record<string, unknown> {
  const cond = buildRangeCondition("created_at", bounds.since, bounds.until);
  // Counters-audit 2026-05-19 D.2: bot UA filter.
  const botExcl = sql.raw(buildBotExclusionSql("user_agent"));
  const byCountry = allSafe<{ country: string; c: number }>(
    sql`SELECT COALESCE(country, '—') as country, count(DISTINCT fingerprint) as c
        FROM visitors
        WHERE ${cond} AND ${botExcl}
        GROUP BY country
        ORDER BY c DESC
        LIMIT 15`,
  );
  const byCity = allSafe<{ city: string; c: number }>(
    sql`SELECT COALESCE(city, '—') as city, count(DISTINCT fingerprint) as c
        FROM visitors
        WHERE ${cond} AND ${botExcl}
        GROUP BY city
        ORDER BY c DESC
        LIMIT 15`,
  );
  const byDevice = allSafe<{ device: string; c: number }>(
    sql`SELECT COALESCE(device, '—') as device, count(DISTINCT fingerprint) as c
        FROM visitors
        WHERE ${cond} AND ${botExcl}
        GROUP BY device
        ORDER BY c DESC
        LIMIT 10`,
  );
  const byBrowser = allSafe<{ browser: string; c: number }>(
    sql`SELECT COALESCE(browser, '—') as browser, count(DISTINCT fingerprint) as c
        FROM visitors
        WHERE ${cond} AND ${botExcl}
        GROUP BY browser
        ORDER BY c DESC
        LIMIT 10`,
  );
  const unique = countSafe(
    sql`SELECT count(DISTINCT fingerprint) as c FROM visitors WHERE ${cond} AND ${botExcl}`,
  );
  const total = countSafe(sql`SELECT count(*) as c FROM visitors WHERE ${cond} AND ${botExcl}`);
  return {
    unique,
    total,
    byCountry: byCountry.map(r => ({ name: r.country, count: r.c })),
    byCity: byCity.map(r => ({ name: r.city, count: r.c })),
    byDevice: byDevice.map(r => ({ name: r.device, count: r.c })),
    byBrowser: byBrowser.map(r => ({ name: r.browser, count: r.c })),
  };
}

const masterDashboardModule: Module = {
  name: "master-dashboard",
  version: "0.1.0",
  description:
    "Главная аналитическая dashboard — точка сбора всей статистики проекта + Second Brain export + Yandex TTS «Муза доложит».",
  routes: { prefix: "admin/v304", router },
  publishes: [],
  onLoad: async (ctx) => {
    ctx.logger.info(
      "master-dashboard online — GET /api/admin/v304/dashboard-summary (period=today|yesterday|7d|30d|365d|all|month-1..month-12|custom + from/to, cut-off 20:00 МСК), /dashboard-detail/:metric, /brain-export, /click-stats, /briefing-text, POST /tts (cache 60s)",
    );
  },
  healthCheck: () => ({ status: "ok" }),
};

// === Exported helpers for voice-admin / dialogue-mode (Eugene 2026-05-17) ===
// Возвращают payloads которые ожидает callAdminVoiceLLM в voice-admin/module.ts
// для buildDashboardContext (LLM context injection). Без Express response wrapper.
// Используют тот же кэш TTL 60 сек что и HTTP endpoints.

export function getCachedDashboardSummary(period: string = "today"): any {
  const p = parsePeriod(period);
  const bounds = periodToBounds(p);
  const key = `${cacheKey(p, bounds)}|d=all`;
  const cached = getCached(key);
  if (cached) return cached;
  const payload = {
    period: p,
    since: bounds.since,
    until: bounds.until,
    generatedAt: new Date().toISOString(),
    statusCards: buildStatusCards(),
    metrics: buildPeriodMetrics(bounds, null),
  };
  setCached(key, payload);
  return payload;
}

export function getCachedClickStats(period: string = "today"): any {
  const p = parsePeriod(period);
  const bounds = periodToBounds(p);
  try {
    return buildClickStats(p, bounds, null);
  } catch {
    return { topElements: [], byPage: [], totalClicks: 0, uniqueClickers: 0 };
  }
}

export function getCachedBrainExport(): any {
  try {
    const statusCards = buildStatusCards();
    const greenCount = statusCards.filter(s => s.status === "green").length;
    const yellowCount = statusCards.filter(s => s.status === "yellow").length;
    const redCount = statusCards.filter(s => s.status === "red").length;
    const plugins = allSafe<{ name: string; status: string }>(
      sql`SELECT name, status FROM plugins_registry`,
    );
    return {
      nodesCount: plugins.length + 6,
      edgesCount: plugins.length * 2,
      green: greenCount,
      yellow: yellowCount,
      red: redCount,
      topPlugins: plugins.slice(0, 10).map(p => p.name),
    };
  } catch {
    return { nodesCount: 0, edgesCount: 0, green: 0, yellow: 0, red: 0, topPlugins: [] };
  }
}

export default masterDashboardModule;
