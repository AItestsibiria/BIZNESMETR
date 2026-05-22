// v304 plugin: multi-domain-stats (Eugene 2026-05-21 Босс «фикс который
// собирает статистику по отдельному домену + сводная по всем доменам
// в админ-панель»).
//
// Что делает:
//  - GET /api/admin/v304/local-stats[?token=...]
//      Возвращает JSON со статистикой текущего instance (this VPS / data.db).
//      SQL queries из deploy/multi-site-stats.sh, переписанные на Drizzle sql.
//      Auth: либо обычная admin-сессия (requireAdmin), либо shared HMAC token
//      через ?token=... query param (для peer-to-peer cross-domain).
//      Cache 60 сек.
//  - GET /api/admin/v304/aggregated-stats
//      Опрашивает MULTI_DOMAIN_PEERS (CSV из .env), складывает per-domain rows
//      + bottom row TOTAL. Если peer недоступен — отмечает {reachable:false},
//      не fail весь endpoint. Cache 5 мин.
//
// ENV:
//  - MULTI_DOMAIN_PEERS — CSV полных URL других instance'ов, без trailing slash.
//      Пример: "https://muzaai.ru,https://clone.muziai.ru"
//  - MULTI_DOMAIN_SHARED_TOKEN — секрет для cross-domain auth. Один и тот же
//      на всех peer'ах. Без него — endpoint работает только для local admin.
//
// Безопасность:
//  - local-stats возвращает ТОЛЬКО aggregate counts (нет PII / no secrets).
//  - shared token — random 32-byte base64, store в .env (chmod 600).
//  - Constant-time compare через timingSafeEqual чтобы не утечь длину/префикс.
//  - aggregated-stats доступен ТОЛЬКО для admin (cross-domain не leak'аем юзерам).
//
// Backward-compat:
//  - Если MULTI_DOMAIN_PEERS пуст → aggregated возвращает только local row,
//    без ошибок (single-domain mode).
//  - Если MULTI_DOMAIN_SHARED_TOKEN пуст → peer-fetch fail с reachable=false,
//    но local-stats остаётся доступным через requireAdmin.

import { Router } from "express";
import * as fs from "node:fs";
import * as os from "node:os";
import { timingSafeEqual } from "node:crypto";
import { sql } from "drizzle-orm";
import { db } from "../../storage";
import { requireAdmin } from "../../core/adminAuth";
import type { Module } from "../../core";

const router = Router();

// --- Кэш ---

interface CacheEntry<T> {
  data: T;
  expiresAt: number;
}

const LOCAL_TTL_MS = 60_000;
const AGGREGATED_TTL_MS = 5 * 60_000;
const PEER_FETCH_TIMEOUT_MS = 5_000;

let localCache: CacheEntry<LocalStats> | null = null;
let aggregatedCache: CacheEntry<AggregatedStats> | null = null;

// --- Типы ---

export interface LocalStats {
  meta: {
    hostname: string;
    timestamp: string;
    dbSizeMb: number;
    publicUrl: string | null;
  };
  users: {
    total: number;
    admins: number;
    new7d: number;
    new24h: number;
  };
  visits: {
    uniqueFingerprints: number;
    totalVisits: number;
    countries: number;
  };
  generations: {
    total: number;
    music: number;
    musicDone: number;
    publicMain: number;
    deleted: number;
  };
  plays: {
    byAction: Array<{ action: string; count: number }>;
    metaPlaysSum: number;
    tracksWithMeta: number;
  };
  payments: {
    total: number;
    paid: number;
    paidRubTotal: number;
  };
  chatbot: {
    messages: number;
    sessions: number;
  };
}

interface PeerResult {
  url: string;
  domain: string;
  reachable: boolean;
  status: "ok" | "timeout" | "error" | "auth_failed" | "invalid_response";
  errorMessage?: string;
  fetchedAt: string;
  stats: LocalStats | null;
}

export interface AggregatedStats {
  generatedAt: string;
  localDomain: string;
  peerCount: number;
  reachableCount: number;
  peers: PeerResult[];
  totals: {
    users: number;
    admins: number;
    new7d: number;
    new24h: number;
    visitsUnique: number;
    visitsTotal: number;
    generations: number;
    musicDone: number;
    plays: number;
    payments: number;
    paidRubTotal: number;
    chatbotMessages: number;
  };
}

// --- Безопасные read-only хелперы ---

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

function numSafe(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const n = Number(value);
    return Number.isFinite(n) ? n : 0;
  }
  return 0;
}

// --- Локальные метрики (SQL queries из multi-site-stats.sh) ---

function buildLocalStats(): LocalStats {
  // USERS
  const usersRow = db.get<{ total: number; admins: number; new7d: number; new24h: number }>(
    sql`SELECT
      COUNT(*) AS total,
      SUM(CASE WHEN role IN ('admin','super_admin') THEN 1 ELSE 0 END) AS admins,
      SUM(CASE WHEN created_at >= datetime('now','-7 days') THEN 1 ELSE 0 END) AS new7d,
      SUM(CASE WHEN created_at >= datetime('now','-1 day') THEN 1 ELSE 0 END) AS new24h
    FROM users`,
  );

  // VISITS
  const visitsRow = (() => {
    try {
      return db.get<{ unique_fingerprints: number; total_visits: number; countries: number }>(
        sql`SELECT
          COUNT(*) AS unique_fingerprints,
          COALESCE(SUM(visits), 0) AS total_visits,
          COUNT(DISTINCT country_code) AS countries
        FROM visitors
        WHERE fingerprint NOT LIKE 'daily_%' AND ip != '0.0.0.0'
          AND user_agent IS NOT NULL AND user_agent != ''`,
      );
    } catch {
      return null;
    }
  })();

  // GENERATIONS
  const gensRow = db.get<{
    total: number;
    music: number;
    music_done: number;
    public_main: number;
    deleted: number;
  }>(
    sql`SELECT
      COUNT(*) AS total,
      SUM(CASE WHEN type='music' THEN 1 ELSE 0 END) AS music,
      SUM(CASE WHEN type='music' AND status='done' THEN 1 ELSE 0 END) AS music_done,
      SUM(CASE WHEN type='music' AND is_public=1 THEN 1 ELSE 0 END) AS public_main,
      SUM(CASE WHEN type='music' AND deleted_at IS NOT NULL THEN 1 ELSE 0 END) AS deleted
    FROM generations`,
  );

  // PLAYS BY ACTION
  const playsByAction = allSafe<{ action: string; c: number }>(
    sql`SELECT action, COUNT(*) AS c
        FROM gen_activity
        WHERE action='play' OR action LIKE 'play_rejected%'
        GROUP BY action
        ORDER BY c DESC`,
  );

  // PLAYS META SUM
  const playsMeta = (() => {
    try {
      return db.get<{ total_meta_plays: number; tracks_with_meta: number }>(
        sql`SELECT
          COALESCE(SUM(CAST(json_extract(style, '$.plays') AS INTEGER)), 0) AS total_meta_plays,
          COUNT(*) AS tracks_with_meta
        FROM generations
        WHERE type='music' AND deleted_at IS NULL
          AND style LIKE '{%' AND json_valid(style)=1`,
      );
    } catch {
      return null;
    }
  })();

  // PAYMENTS
  const paymentsRow = (() => {
    try {
      return db.get<{ total: number; paid_count: number; paid_rub_total: number }>(
        sql`SELECT
          COUNT(*) AS total,
          SUM(CASE WHEN status='paid' THEN 1 ELSE 0 END) AS paid_count,
          COALESCE(SUM(CASE WHEN status='paid' THEN amount ELSE 0 END), 0) / 100 AS paid_rub_total
        FROM payments`,
      );
    } catch {
      return null;
    }
  })();

  // CHATBOT MESSAGES
  const chatbotRow = (() => {
    try {
      return db.get<{ total_messages: number; sessions: number }>(
        sql`SELECT
          COUNT(*) AS total_messages,
          COUNT(DISTINCT session_id) AS sessions
        FROM chatbot_messages
        WHERE role='user'`,
      );
    } catch {
      return null;
    }
  })();

  // META
  const dbFile = process.env.DATABASE_FILE || "data.db";
  let dbSizeMb = 0;
  try {
    dbSizeMb = Math.round(fs.statSync(dbFile).size / 1024 / 1024);
  } catch {}

  return {
    meta: {
      hostname: os.hostname(),
      timestamp: new Date().toISOString(),
      dbSizeMb,
      publicUrl: process.env.PUBLIC_URL || process.env.BASE_DOMAIN || null,
    },
    users: {
      total: numSafe(usersRow?.total),
      admins: numSafe(usersRow?.admins),
      new7d: numSafe(usersRow?.new7d),
      new24h: numSafe(usersRow?.new24h),
    },
    visits: {
      uniqueFingerprints: numSafe(visitsRow?.unique_fingerprints),
      totalVisits: numSafe(visitsRow?.total_visits),
      countries: numSafe(visitsRow?.countries),
    },
    generations: {
      total: numSafe(gensRow?.total),
      music: numSafe(gensRow?.music),
      musicDone: numSafe(gensRow?.music_done),
      publicMain: numSafe(gensRow?.public_main),
      deleted: numSafe(gensRow?.deleted),
    },
    plays: {
      byAction: playsByAction.map((r) => ({ action: r.action, count: numSafe(r.c) })),
      metaPlaysSum: numSafe(playsMeta?.total_meta_plays),
      tracksWithMeta: numSafe(playsMeta?.tracks_with_meta),
    },
    payments: {
      total: numSafe(paymentsRow?.total),
      paid: numSafe(paymentsRow?.paid_count),
      paidRubTotal: numSafe(paymentsRow?.paid_rub_total),
    },
    chatbot: {
      messages: numSafe(chatbotRow?.total_messages),
      sessions: numSafe(chatbotRow?.sessions),
    },
  };
}

function getCachedLocalStats(): LocalStats {
  if (localCache && localCache.expiresAt > Date.now()) {
    return localCache.data;
  }
  const data = buildLocalStats();
  localCache = { data, expiresAt: Date.now() + LOCAL_TTL_MS };
  return data;
}

// --- Shared-token auth (constant-time compare) ---

function safeStringCompare(a: string, b: string): boolean {
  if (!a || !b) return false;
  const aBuf = Buffer.from(a, "utf8");
  const bBuf = Buffer.from(b, "utf8");
  if (aBuf.length !== bBuf.length) return false;
  try {
    return timingSafeEqual(aBuf, bBuf);
  } catch {
    return false;
  }
}

function checkSharedToken(req: any): boolean {
  const expected = (process.env.MULTI_DOMAIN_SHARED_TOKEN || "").trim();
  if (!expected) return false;
  const provided = (req?.query?.token || req?.headers?.["x-multi-domain-token"] || "")
    .toString()
    .trim();
  if (!provided) return false;
  return safeStringCompare(provided, expected);
}

// Dual-auth middleware: либо shared token (для peer-fetch), либо requireAdmin.
function requireAdminOrSharedToken(req: any, res: any, next: any): void {
  if (checkSharedToken(req)) {
    (req as any).viaSharedToken = true;
    next();
    return;
  }
  requireAdmin(req, res, next);
}

// --- Peer fetch ---

function extractDomain(url: string): string {
  try {
    const u = new URL(url);
    return u.host;
  } catch {
    return url;
  }
}

async function fetchPeerStats(peerUrl: string): Promise<PeerResult> {
  const clean = peerUrl.replace(/\/+$/, "");
  const domain = extractDomain(clean);
  const token = (process.env.MULTI_DOMAIN_SHARED_TOKEN || "").trim();
  const fetchedAt = new Date().toISOString();

  if (!token) {
    return {
      url: clean,
      domain,
      reachable: false,
      status: "auth_failed",
      errorMessage: "MULTI_DOMAIN_SHARED_TOKEN не настроен на этом VPS",
      fetchedAt,
      stats: null,
    };
  }

  const fullUrl = `${clean}/api/admin/v304/local-stats?token=${encodeURIComponent(token)}`;
  try {
    const resp = await fetch(fullUrl, {
      method: "GET",
      headers: { "X-Multi-Domain-Token": token, "Accept": "application/json" },
      signal: AbortSignal.timeout(PEER_FETCH_TIMEOUT_MS),
    });
    if (resp.status === 401 || resp.status === 403) {
      return {
        url: clean,
        domain,
        reachable: false,
        status: "auth_failed",
        errorMessage: `HTTP ${resp.status} — shared token не совпадает или peer не настроен`,
        fetchedAt,
        stats: null,
      };
    }
    if (!resp.ok) {
      return {
        url: clean,
        domain,
        reachable: false,
        status: "error",
        errorMessage: `HTTP ${resp.status}`,
        fetchedAt,
        stats: null,
      };
    }
    const body = await resp.json().catch(() => null);
    const stats = (body && (body.data ?? body)) as LocalStats | null;
    if (!stats || typeof stats !== "object" || !stats.users || !stats.meta) {
      return {
        url: clean,
        domain,
        reachable: false,
        status: "invalid_response",
        errorMessage: "Peer вернул JSON без ожидаемых полей",
        fetchedAt,
        stats: null,
      };
    }
    return {
      url: clean,
      domain,
      reachable: true,
      status: "ok",
      fetchedAt,
      stats,
    };
  } catch (e: any) {
    const msg = e?.name === "TimeoutError" || /abort|timeout/i.test(e?.message || "")
      ? `timeout (${PEER_FETCH_TIMEOUT_MS}ms)`
      : (e?.message || String(e)).slice(0, 200);
    return {
      url: clean,
      domain,
      reachable: false,
      status: e?.name === "TimeoutError" ? "timeout" : "error",
      errorMessage: msg,
      fetchedAt,
      stats: null,
    };
  }
}

function parsePeers(): string[] {
  const raw = process.env.MULTI_DOMAIN_PEERS || "";
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s && /^https?:\/\//i.test(s));
}

function aggregateTotals(peers: PeerResult[], local: LocalStats): AggregatedStats["totals"] {
  const totals = {
    users: local.users.total,
    admins: local.users.admins,
    new7d: local.users.new7d,
    new24h: local.users.new24h,
    visitsUnique: local.visits.uniqueFingerprints,
    visitsTotal: local.visits.totalVisits,
    generations: local.generations.total,
    musicDone: local.generations.musicDone,
    plays: local.plays.byAction.find((a) => a.action === "play")?.count ?? 0,
    payments: local.payments.paid,
    paidRubTotal: local.payments.paidRubTotal,
    chatbotMessages: local.chatbot.messages,
  };
  for (const p of peers) {
    if (!p.reachable || !p.stats) continue;
    const s = p.stats;
    totals.users += numSafe(s.users?.total);
    totals.admins += numSafe(s.users?.admins);
    totals.new7d += numSafe(s.users?.new7d);
    totals.new24h += numSafe(s.users?.new24h);
    totals.visitsUnique += numSafe(s.visits?.uniqueFingerprints);
    totals.visitsTotal += numSafe(s.visits?.totalVisits);
    totals.generations += numSafe(s.generations?.total);
    totals.musicDone += numSafe(s.generations?.musicDone);
    totals.plays += numSafe(s.plays?.byAction?.find((a: any) => a.action === "play")?.count ?? 0);
    totals.payments += numSafe(s.payments?.paid);
    totals.paidRubTotal += numSafe(s.payments?.paidRubTotal);
    totals.chatbotMessages += numSafe(s.chatbot?.messages);
  }
  return totals;
}

async function buildAggregatedStats(): Promise<AggregatedStats> {
  const local = getCachedLocalStats();
  const peerUrls = parsePeers();
  const peerResults: PeerResult[] = peerUrls.length
    ? await Promise.all(peerUrls.map(fetchPeerStats))
    : [];
  const reachableCount = peerResults.filter((p) => p.reachable).length;
  return {
    generatedAt: new Date().toISOString(),
    localDomain: local.meta.publicUrl
      ? extractDomain(local.meta.publicUrl)
      : local.meta.hostname,
    peerCount: peerUrls.length,
    reachableCount,
    peers: peerResults,
    totals: aggregateTotals(peerResults, local),
  };
}

// --- Routes ---

// GET /api/admin/v304/local-stats
// Dual-auth: либо shared token (peer-to-peer), либо admin session.
router.get("/local-stats", requireAdminOrSharedToken, (_req, res) => {
  try {
    const data = getCachedLocalStats();
    res.json({ data, error: null });
  } catch (e: any) {
    res.status(500).json({
      data: null,
      error: e?.message ? `local-stats failed: ${String(e.message).slice(0, 200)}` : "local-stats failed",
    });
  }
});

// GET /api/admin/v304/aggregated-stats
// Только admin (cross-domain stats юзерам не показываем).
router.get("/aggregated-stats", requireAdmin, async (_req, res) => {
  try {
    if (aggregatedCache && aggregatedCache.expiresAt > Date.now()) {
      res.json({ data: aggregatedCache.data, error: null });
      return;
    }
    const data = await buildAggregatedStats();
    aggregatedCache = { data, expiresAt: Date.now() + AGGREGATED_TTL_MS };
    res.json({ data, error: null });
  } catch (e: any) {
    res.status(500).json({
      data: null,
      error: e?.message ? `aggregated-stats failed: ${String(e.message).slice(0, 200)}` : "aggregated-stats failed",
    });
  }
});

const multiDomainStatsModule: Module = {
  name: "multi-domain-stats",
  version: "0.1.0",
  description:
    "Per-domain stats + cross-domain aggregated stats (Eugene 2026-05-21 — Multi-domain-admin-stats rule).",
  routes: { prefix: "admin/v304", router },
  publishes: [],
  onLoad: async (ctx) => {
    const peers = parsePeers();
    const tokenSet = !!(process.env.MULTI_DOMAIN_SHARED_TOKEN || "").trim();
    ctx.logger.info(
      `multi-domain-stats online — GET /api/admin/v304/local-stats (dual-auth: requireAdmin | shared token), /aggregated-stats (admin only). Peers configured: ${peers.length}. Shared token set: ${tokenSet}.`,
    );
  },
  healthCheck: () => ({
    status: "ok",
    details: {
      peersConfigured: parsePeers().length,
      sharedTokenSet: !!(process.env.MULTI_DOMAIN_SHARED_TOKEN || "").trim(),
    },
  }),
};

export default multiDomainStatsModule;
