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
import { lastSnapshotForBrainExport } from "../funnels/module";

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

type Period = "today" | "7d" | "30d" | "all";

function periodToSince(p: Period): string | null {
  const now = Date.now();
  switch (p) {
    case "today": {
      // С полуночи MSK (UTC+3) для удобства Босса — но в SQLite храним ISO UTC.
      const d = new Date(now);
      d.setUTCHours(0, 0, 0, 0);
      // Сдвиг назад на 3 часа = полночь MSK выраженная в UTC.
      d.setUTCHours(d.getUTCHours() - 3);
      return d.toISOString();
    }
    case "7d":
      return new Date(now - 7 * 24 * 3600 * 1000).toISOString();
    case "30d":
      return new Date(now - 30 * 24 * 3600 * 1000).toISOString();
    case "all":
      return null;
  }
}

function parsePeriod(raw: unknown): Period {
  const s = String(raw || "").toLowerCase();
  if (s === "today" || s === "7d" || s === "30d" || s === "all") return s;
  return "7d";
}

// --- Кэш на 60 секунд ---

type CacheEntry = { data: any; expiresAt: number };
const summaryCache = new Map<Period, CacheEntry>();
const CACHE_TTL_MS = 60_000;

function getCached(period: Period): any | null {
  const e = summaryCache.get(period);
  if (e && e.expiresAt > Date.now()) return e.data;
  return null;
}
function setCached(period: Period, data: any): void {
  summaryCache.set(period, { data, expiresAt: Date.now() + CACHE_TTL_MS });
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

function buildPeriodMetrics(since: string | null): PeriodMetrics {
  const sinceCondition = since
    ? sql`created_at >= ${since}`
    : sql`1=1`;

  // Plays / play_rejected — оба из gen_activity.
  const plays = countSafe(
    sql`SELECT count(*) as c FROM gen_activity WHERE action='play' AND ${sinceCondition}`,
  );
  const playsUnique = countSafe(
    sql`SELECT count(DISTINCT ip) as c FROM gen_activity WHERE action='play' AND ${sinceCondition}`,
  );
  const playsRejected = countSafe(
    sql`SELECT count(*) as c FROM gen_activity WHERE action LIKE 'play_rejected%' AND ${sinceCondition}`,
  );

  const downloads = countSafe(
    sql`SELECT count(*) as c FROM gen_activity WHERE action='download' AND ${sinceCondition}`,
  );

  const registrationsTotal = countSafe(
    sql`SELECT count(*) as c FROM users WHERE ${sinceCondition}`,
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
        WHERE ${sinceCondition}
        GROUP BY channel`,
  );

  const gensMusicDone = countSafe(
    sql`SELECT count(*) as c FROM generations WHERE type='music' AND status='done' AND deleted_at IS NULL AND ${sinceCondition}`,
  );
  const gensMusicError = countSafe(
    sql`SELECT count(*) as c FROM generations WHERE type='music' AND status='error' AND deleted_at IS NULL AND ${sinceCondition}`,
  );
  const gensMusicProcessing = countSafe(
    sql`SELECT count(*) as c FROM generations WHERE type='music' AND status='processing' AND deleted_at IS NULL AND ${sinceCondition}`,
  );
  const gensLyricsDone = countSafe(
    sql`SELECT count(*) as c FROM generations WHERE type='lyrics' AND status='done' AND deleted_at IS NULL AND ${sinceCondition}`,
  );
  const gensLyricsError = countSafe(
    sql`SELECT count(*) as c FROM generations WHERE type='lyrics' AND status='error' AND deleted_at IS NULL AND ${sinceCondition}`,
  );
  const gensCoverDone = countSafe(
    sql`SELECT count(*) as c FROM generations WHERE type='cover' AND status='done' AND deleted_at IS NULL AND ${sinceCondition}`,
  );
  const gensCoverError = countSafe(
    sql`SELECT count(*) as c FROM generations WHERE type='cover' AND status='error' AND deleted_at IS NULL AND ${sinceCondition}`,
  );

  const paymentsCount = countSafe(
    sql`SELECT count(*) as c FROM payments WHERE status='paid' AND ${sinceCondition}`,
  );
  const paymentsSum = (() => {
    try {
      const r = db.get<{ s: number | null }>(
        sql`SELECT COALESCE(SUM(amount),0) as s FROM payments WHERE status='paid' AND ${sinceCondition}`,
      );
      return r?.s ?? 0;
    } catch {
      return 0;
    }
  })();

  const visitorsUnique = countSafe(
    sql`SELECT count(DISTINCT fingerprint) as c FROM visitors WHERE ${sinceCondition}`,
  );
  const visitorsTotal = countSafe(
    sql`SELECT count(*) as c FROM visitors WHERE ${sinceCondition}`,
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

function buildTimeline(period: Period, since: string | null): ChartSeries["timeline"] {
  // Bucket по дню. Для today — bucket по часам, иначе по дням.
  // Для краткости: всегда bucket по дням (today = только 1 точка).
  const fromIso = since || "1970-01-01T00:00:00.000Z";
  type Row = { date: string; c: number };
  const playsRows = allSafe<Row>(
    sql`SELECT substr(created_at,1,10) as date, count(*) as c
        FROM gen_activity
        WHERE action='play' AND created_at >= ${fromIso}
        GROUP BY date ORDER BY date`,
  );
  const regsRows = allSafe<Row>(
    sql`SELECT substr(created_at,1,10) as date, count(*) as c
        FROM users
        WHERE created_at >= ${fromIso}
        GROUP BY date ORDER BY date`,
  );
  const gensRows = allSafe<Row>(
    sql`SELECT substr(created_at,1,10) as date, count(*) as c
        FROM generations
        WHERE created_at >= ${fromIso} AND deleted_at IS NULL
        GROUP BY date ORDER BY date`,
  );
  const paysRows = allSafe<Row>(
    sql`SELECT substr(created_at,1,10) as date, count(*) as c
        FROM payments
        WHERE status='paid' AND created_at >= ${fromIso}
        GROUP BY date ORDER BY date`,
  );
  const visRows = allSafe<Row>(
    sql`SELECT substr(created_at,1,10) as date, count(DISTINCT fingerprint) as c
        FROM visitors
        WHERE created_at >= ${fromIso}
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

function buildRegistrationChannels(since: string | null): ChartSeries["registrationChannels"] {
  const condition = since ? sql`created_at >= ${since}` : sql`1=1`;
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

function buildTopTracks(since: string | null): ChartSeries["topTracks"] {
  const condition = since ? sql`ga.created_at >= ${since}` : sql`1=1`;
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

function buildHeatmap(since: string | null): ChartSeries["heatmap"] {
  // SQLite: strftime('%w', x) = день недели 0..6 (вс=0)
  //         strftime('%H', x) = час 0..23
  const condition = since ? sql`created_at >= ${since}` : sql`1=1`;
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

function buildFlow(since: string | null): ChartSeries["flow"] {
  const condition = since ? sql`u.created_at >= ${since}` : sql`1=1`;
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

function buildChartSeries(period: Period, since: string | null): ChartSeries {
  return {
    timeline: buildTimeline(period, since),
    registrationChannels: buildRegistrationChannels(since),
    topTracks: buildTopTracks(since),
    heatmap: buildHeatmap(since),
    flow: buildFlow(since),
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

const clickStatsCache = new Map<Period, CacheEntry>();
function getCachedClicks(period: Period): ClickStats | null {
  const e = clickStatsCache.get(period);
  if (e && e.expiresAt > Date.now()) return e.data as ClickStats;
  return null;
}
function setCachedClicks(period: Period, data: ClickStats): void {
  clickStatsCache.set(period, { data, expiresAt: Date.now() + CACHE_TTL_MS });
}

function buildClickStats(period: Period, since: string | null): ClickStats {
  const fromIso = since || "1970-01-01T00:00:00.000Z";

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
    WHERE event_type='click' AND created_at >= ${fromIso}
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
    WHERE event_type IN ('click','page_view') AND created_at >= ${fromIso}
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
      AND created_at >= ${fromIso}
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
      WHERE event_type IN ('click','page_view') AND created_at >= ${fromIso}
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
    WHERE event_type='click' AND created_at >= ${fromIso}
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
    sql`SELECT count(*) as c FROM user_journey_events WHERE event_type='click' AND created_at >= ${fromIso}`,
  );
  const uniqueClickers = countSafe(
    sql`SELECT count(DISTINCT session_key) as c FROM user_journey_events WHERE event_type='click' AND created_at >= ${fromIso}`,
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
    const cached = getCachedClicks(period);
    if (cached) {
      return res.json({ data: { ...cached, fromCache: true }, error: null });
    }
    const since = periodToSince(period);
    const payload = buildClickStats(period, since);
    setCachedClicks(period, payload);
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
    const cached = getCached(period);
    if (cached) {
      return res.json({ data: { ...cached, fromCache: true }, error: null });
    }
    const since = periodToSince(period);
    const payload = {
      period,
      since,
      generatedAt: new Date().toISOString(),
      cacheExpiresAt: new Date(Date.now() + CACHE_TTL_MS).toISOString(),
      statusCards: buildStatusCards(),
      metrics: buildPeriodMetrics(since),
      charts: buildChartSeries(period, since),
    };
    setCached(period, payload);
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
      { id: "provider:anthropic", group: "provider", label: "Anthropic", status: process.env.ANTHROPIC_API_KEY ? "green" : "yellow" },
      { id: "provider:timeweb", group: "provider", label: "TimeWeb LLM", status: process.env.TIMEWEB_GATEWAY_KEY ? "green" : "yellow" },
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
        cs = buildClickStats("30d", since30);
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

    // Funnels — последний snapshot всех воронок (Eugene 2026-05-17 Босс).
    // Чтобы Второй мозг видел текущее проседание конверсии и знал куда копать.
    // Берём last snapshot per funnel_id (cron save'ит дневной snapshot в 03:00 MSK).
    let funnelsSlice: ReturnType<typeof lastSnapshotForBrainExport> = [];
    try {
      funnelsSlice = lastSnapshotForBrainExport();
    } catch (e) {
      console.warn(
        "[brain-export] funnels slice failed:",
        e instanceof Error ? e.message : e,
      );
    }

    res.json({
      data: {
        generatedAt: new Date().toISOString(),
        period: "30d",
        since: since30,
        nodes,
        edges,
        clickStats: clickStatsSlice,
        funnels: funnelsSlice,
        summary: {
          totals: {
            nodes: nodes.length,
            edges: edges.length,
            plugins: pluginNodes.length,
            channels: channelNodes.length,
            providers: providerNodes.length,
            clicks: clickStatsSlice.totalClicks,
            uniqueClickers: clickStatsSlice.uniqueClickers,
            funnels: funnelsSlice.length,
          },
          health: {
            green: nodes.filter(n => n.status === "green").length,
            yellow: nodes.filter(n => n.status === "yellow").length,
            red: nodes.filter(n => n.status === "red").length,
            unknown: nodes.filter(n => n.status === "unknown").length,
          },
          worstFunnel: funnelsSlice
            .filter(f => f.totalConversion !== null)
            .sort((a, b) => (a.totalConversion ?? 1) - (b.totalConversion ?? 1))[0] || null,
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
    let snapshot: any = getCached(period);
    if (!snapshot) {
      const since = periodToSince(period);
      snapshot = {
        period,
        since,
        generatedAt: new Date().toISOString(),
        cacheExpiresAt: new Date(Date.now() + CACHE_TTL_MS).toISOString(),
        statusCards: buildStatusCards(),
        metrics: buildPeriodMetrics(since),
        charts: buildChartSeries(period, since),
      };
      setCached(period, snapshot);
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

const masterDashboardModule: Module = {
  name: "master-dashboard",
  version: "0.1.0",
  description:
    "Главная аналитическая dashboard — точка сбора всей статистики проекта + Second Brain export + Yandex TTS «Муза доложит».",
  routes: { prefix: "admin/v304", router },
  publishes: [],
  onLoad: async (ctx) => {
    ctx.logger.info(
      "master-dashboard online — GET /api/admin/v304/dashboard-summary, /brain-export, /click-stats, /briefing-text, POST /tts (cache 60s)",
    );
  },
  healthCheck: () => ({ status: "ok" }),
};

export default masterDashboardModule;
