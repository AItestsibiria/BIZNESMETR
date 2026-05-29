// Eugene 2026-05-24 Босс «заведи агента по учёту затрат на каждого автора,
// чат, генерации по каждому треку. Если было общение между треками — затраты
// на счёт последнего. Анализ дохода MuzaAi по трекам / автору исходя из
// стоимости трека/текста/изображения на МОМЕНТ генерации. Правило для всех
// ранее созданных. Отчёт в админке — Агент Деньга».
//
// АГЕНТ ДЕНЬГА — cost tracking + profit analysis на одном источнике правды:
//   - Revenue: PRICES * количество (через generations + transactions)
//   - Cost: providerTariffs.ts (наши затраты провайдерам по timestamp)
//   - Chat cost: estimateChatCallCost по сообщениям, attributed к ПОСЛЕДНЕМУ
//     треку после chat'а (Босс правило). Если chat ПОСЛЕ всех треков → к
//     самому последнему. Если anonymous (нет userId) → bucket «anonymous».
//
// Manual override: admin может вписать любую стоимость через
//   POST /api/admin/v304/denga/manual-cost
// → запись в denga_manual_costs override'ит calculated tariff.
//
// In-memory cache TTL=5min — для агрегатов. Per-request user/track запросы
// — без кеша (точные данные).
//
// Привязка к Orchestrator: register как "denga" agent + edge data-sync с
// marketing-orchestrator (LTV-based segmentation).

import { sqliteDb } from "../storage";
import {
  estimateMusicCost,
  estimateCoverCost,
  estimateLyricsCost,
  estimateChatCallCost,
  estimateGenerationCost,
  toMillis,
} from "./providerTariffs";

// PRICES (revenue side) — копируем здесь чтобы не циклически импортировать
// из routes.ts. Должно соответствовать routes.ts:557. Если меняются — обновить
// в обоих местах (см. Pricing-single-source rule).
//
// На MOMENT генерации — берём gen.cost из БД (точная цена которую юзер
// заплатил), fallback на эти константы если gen.cost null/0.
const FALLBACK_REVENUE: Record<string, number> = {
  music: 39900,
  lyrics: 9900,
  cover: 9900,
  audio_cover: 39900,
};

// ============================================================
// Types
// ============================================================

export interface DengaUserStats {
  userId: number;
  name: string;
  phone: string | null;
  email: string | null;
  createdAt: string | null;
  totalRevenue: number;       // что юзер заплатил нам (gen.cost suma + ручные продажи)
  totalCost: number;          // наши провайдерские costs
  profit: number;             // revenue - cost
  manualSalesRevenue: number; // выручка с ручных продаж (denga_manual_sales)
  tracksCount: number;
  lyricsCount: number;
  coversCount: number;
  chatCost: number;           // attributed chat cost
  totalGenerations: number;
  avgProfitPerTrack: number;
  avgCostPerTrack: number;
  avgRevenuePerTrack: number;
  balance: number;            // current balance (kopecks)
  bonusTracks: number;
}

export interface DengaTrackStats {
  genId: number;
  userId: number | null;
  userName: string;
  type: string;               // 'music' | 'lyrics' | 'cover'
  title: string;
  createdAt: string | null;
  status: string;
  voiceType: string | null;
  sunoCost: number;           // for music
  chatCost: number;           // attributed (chat between prev track and this)
  coverCost: number;          // if cover attached as separate gen
  lyricsCost: number;         // if lyrics attached as separate gen
  totalCost: number;          // sum
  revenue: number;            // gen.cost
  profit: number;
  hasManualOverride: boolean;
}

export interface DengaAnonymousStats {
  sessions: number;
  messagesCount: number;
  totalChatCost: number;
  avgCostPerSession: number;
  byChannel: Record<string, { sessions: number; messages: number; cost: number }>;
}

export interface DengaAggregates {
  periodLabel: string;
  fromIso: string;
  toIso: string;
  totalUsers: number;          // distinct user_id seen in period
  totalTracks: number;
  totalLyrics: number;
  totalCovers: number;
  totalRevenue: number;
  totalCost: number;
  totalChatCost: number;
  anonymousChatCost: number;
  manualSalesRevenue: number;  // выручка с ручных продаж (denga_manual_sales)
  totalProfit: number;
  avgProfitPerTrack: number;
  avgCostPerTrack: number;
  avgRevenuePerTrack: number;
  generatedAt: string;
}

export interface DengaManualCostOverride {
  sunoCost?: number;
  chatCost?: number;
  coverCost?: number;
  lyricsCost?: number;
  notes?: string;
}

// ============================================================
// Cache
// ============================================================

const CACHE_TTL_MS = 5 * 60 * 1000;
const cache = new Map<string, { value: unknown; cachedAt: number }>();

function cacheGet<T>(key: string): T | null {
  const c = cache.get(key);
  if (!c) return null;
  if (Date.now() - c.cachedAt > CACHE_TTL_MS) {
    cache.delete(key);
    return null;
  }
  return c.value as T;
}

function cacheSet(key: string, value: unknown): void {
  cache.set(key, { value, cachedAt: Date.now() });
}

export function invalidateDengaCache(): void {
  cache.clear();
}

// ============================================================
// Internal helpers
// ============================================================

function rawDb(): any {
  return sqliteDb;
}

interface GenRow {
  id: number;
  userId: number;
  type: string;
  status: string;
  cost: number;
  displayTitle: string | null;
  prompt: string;
  voiceType: string | null;
  coverGenId: number | null;
  createdAt: string | null;
  createdAtMillis: number;
}

interface ChatMsgRow {
  id: number;
  sessionId: string;
  role: string;
  textLen: number;
  createdAt: string | null;
  createdAtMillis: number;
  userId: number | null;
  channel: string;
}

interface ManualCostRow {
  id: number;
  genId: number;
  userId: number | null;
  sunoCost: number | null;
  chatCost: number | null;
  coverCost: number | null;
  lyricsCost: number | null;
  notes: string | null;
  adminId: number;
  createdAt: number;
}

/**
 * Загрузить все generations попавшие в [fromIso, toIso) — или все если bounds null.
 */
function loadGenerations(opts: {
  fromIso?: string;
  toIso?: string;
  userId?: number;
}): GenRow[] {
  const db = rawDb();
  const where: string[] = ["deleted_at IS NULL"];
  const params: any[] = [];
  if (opts.fromIso) {
    // Eugene 2026-05-29 (аудит периодов): datetime() обе стороны — created_at
    // (пробел) vs ISO ('T'); без этого записи дня терялись.
    where.push("datetime(created_at) >= datetime(?)");
    params.push(opts.fromIso);
  }
  if (opts.toIso) {
    where.push("datetime(created_at) < datetime(?)");
    params.push(opts.toIso);
  }
  if (opts.userId != null) {
    where.push("user_id = ?");
    params.push(opts.userId);
  }
  const sql = `
    SELECT id, user_id, type, status, cost, display_title, prompt,
           voice_type, cover_gen_id, created_at
    FROM generations
    WHERE ${where.join(" AND ")}
    ORDER BY created_at ASC
  `;
  const rows = db.prepare(sql).all(...params) as any[];
  return rows.map(r => ({
    id: Number(r.id),
    userId: Number(r.user_id),
    type: String(r.type || "music"),
    status: String(r.status || ""),
    cost: Number(r.cost) || 0,
    displayTitle: r.display_title ?? null,
    prompt: String(r.prompt || ""),
    voiceType: r.voice_type ?? null,
    coverGenId: r.cover_gen_id != null ? Number(r.cover_gen_id) : null,
    createdAt: r.created_at ?? null,
    createdAtMillis: toMillis(r.created_at),
  }));
}

/**
 * Загрузить chat messages с linkage userId / channel из chatbot_sessions.
 */
function loadChatMessages(opts: {
  fromIso?: string;
  toIso?: string;
  userId?: number;
}): ChatMsgRow[] {
  const db = rawDb();
  const where: string[] = [];
  const params: any[] = [];
  if (opts.fromIso) {
    where.push("m.created_at >= ?");
    params.push(opts.fromIso);
  }
  if (opts.toIso) {
    where.push("m.created_at < ?");
    params.push(opts.toIso);
  }
  if (opts.userId != null) {
    where.push("s.user_id = ?");
    params.push(opts.userId);
  }
  const sql = `
    SELECT m.id, m.session_id, m.role, m.text, m.created_at,
           s.user_id AS s_user_id, s.channel AS s_channel
    FROM chatbot_messages m
    LEFT JOIN chatbot_sessions s ON s.id = m.session_id
    ${where.length > 0 ? "WHERE " + where.join(" AND ") : ""}
    ORDER BY m.created_at ASC
  `;
  let rows: any[] = [];
  try {
    rows = db.prepare(sql).all(...params) as any[];
  } catch (e: any) {
    console.warn("[denga] loadChatMessages failed:", e?.message || e);
    return [];
  }
  return rows.map(r => ({
    id: Number(r.id),
    sessionId: String(r.session_id || ""),
    role: String(r.role || ""),
    textLen: String(r.text || "").length,
    createdAt: r.created_at ?? null,
    createdAtMillis: toMillis(r.created_at),
    userId: r.s_user_id != null ? Number(r.s_user_id) : null,
    channel: String(r.s_channel || "unknown"),
  }));
}

/**
 * Загрузить manual cost overrides.
 */
function loadManualOverrides(opts: { genIds?: number[]; userId?: number }): Map<number, ManualCostRow> {
  const db = rawDb();
  const result = new Map<number, ManualCostRow>();
  try {
    let rows: any[] = [];
    if (opts.genIds && opts.genIds.length > 0) {
      // Batch fetch (SQLite limit ~999 params)
      const chunks: number[][] = [];
      for (let i = 0; i < opts.genIds.length; i += 500) {
        chunks.push(opts.genIds.slice(i, i + 500));
      }
      for (const ch of chunks) {
        const placeholders = ch.map(() => "?").join(",");
        const sql = `SELECT * FROM denga_manual_costs WHERE gen_id IN (${placeholders}) ORDER BY id DESC`;
        rows = rows.concat(db.prepare(sql).all(...ch) as any[]);
      }
    } else if (opts.userId != null) {
      rows = db.prepare(`SELECT * FROM denga_manual_costs WHERE user_id = ? ORDER BY id DESC`).all(opts.userId) as any[];
    } else {
      rows = db.prepare(`SELECT * FROM denga_manual_costs ORDER BY id DESC`).all() as any[];
    }
    // Take latest per gen_id
    for (const r of rows) {
      const gid = Number(r.gen_id);
      if (!result.has(gid)) {
        result.set(gid, {
          id: Number(r.id),
          genId: gid,
          userId: r.user_id != null ? Number(r.user_id) : null,
          sunoCost: r.suno_cost != null ? Number(r.suno_cost) : null,
          chatCost: r.chat_cost != null ? Number(r.chat_cost) : null,
          coverCost: r.cover_cost != null ? Number(r.cover_cost) : null,
          lyricsCost: r.lyrics_cost != null ? Number(r.lyrics_cost) : null,
          notes: r.notes ?? null,
          adminId: Number(r.admin_id),
          createdAt: Number(r.created_at),
        });
      }
    }
  } catch (e: any) {
    console.warn("[denga] loadManualOverrides failed:", e?.message || e);
  }
  return result;
}

/**
 * Apply override (only non-null fields). Returns final cost.
 */
function applyOverride(base: number, override: number | null | undefined): number {
  return override != null ? override : base;
}

/**
 * Attribute chat messages to their "last track" per Босс rule:
 *   «если общение между треками — затраты на счёт ПОСЛЕДНЕГО»
 *
 * Algorithm per user:
 *   1. Sort all user gens by createdAt ASC.
 *   2. Sort all user chat messages by createdAt ASC.
 *   3. For each chat message, find FIRST gen with gen.createdAt > msg.createdAt.
 *      → attribute msg.cost to that gen (chat HAPPENED BEFORE that gen finished).
 *   4. If no such gen (chat happened after all gens) → attribute to LAST gen of user.
 *   5. Anonymous chats (no userId) → separate bucket "anonymous".
 *
 * Note: Босс rule says "затраты на счёт ПОСЛЕДНЕГО" — read as "последовавшего трека"
 * (the next track that came AFTER the chat). Анти-паттерн чтения «последний по дате
 * вообще» отрицается потому что тогда все chat'ы пошли бы в самый последний трек что
 * лишено смысла для chat происходящего между ранними треками. Если же chat действительно
 * после всех treков (юзер общается без новых заказов) — fallback на самый последний.
 *
 * Returns: Map<genId, chatCostKopecks> + anonymousCost number.
 */
function attributeChatCostToTracks(
  gens: GenRow[],
  msgs: ChatMsgRow[],
): { perGen: Map<number, number>; anonymous: number; perAnonymousChannel: Record<string, { sessions: Set<string>; messages: number; cost: number }> } {
  const perGen = new Map<number, number>();
  let anonymous = 0;
  const perAnonymousChannel: Record<string, { sessions: Set<string>; messages: number; cost: number }> = {};

  // Group gens by userId
  const gensByUser = new Map<number, GenRow[]>();
  for (const g of gens) {
    if (!gensByUser.has(g.userId)) gensByUser.set(g.userId, []);
    gensByUser.get(g.userId)!.push(g);
  }
  // Ensure sorted ASC (already from loadGenerations, but defensive)
  gensByUser.forEach((list: GenRow[]) => list.sort((a, b) => a.createdAtMillis - b.createdAtMillis));

  // Group messages by userId
  const msgsByUser = new Map<number | null, ChatMsgRow[]>();
  for (const m of msgs) {
    const key = m.userId != null ? m.userId : null;
    if (!msgsByUser.has(key)) msgsByUser.set(key, []);
    msgsByUser.get(key)!.push(m);
  }

  msgsByUser.forEach((list: ChatMsgRow[], userKey: number | null) => {
    list.sort((a, b) => a.createdAtMillis - b.createdAtMillis);

    if (userKey == null) {
      // Anonymous: separate bucket per session via channel grouping
      for (const m of list) {
        if (m.role !== "bot") continue; // считаем cost только bot-replies (output side)
        const cost = estimateChatCallCost({
          inputChars: m.textLen * 2,  // rough: input ≈ 2× of output for typical chat
          outputChars: m.textLen,
          createdAtMillis: m.createdAtMillis,
          provider: "timeweb",
        });
        anonymous += cost;
        if (!perAnonymousChannel[m.channel]) {
          perAnonymousChannel[m.channel] = { sessions: new Set(), messages: 0, cost: 0 };
        }
        perAnonymousChannel[m.channel].sessions.add(m.sessionId);
        perAnonymousChannel[m.channel].messages += 1;
        perAnonymousChannel[m.channel].cost += cost;
      }
      return; // continue для forEach
    }

    const userGens = gensByUser.get(userKey) || [];

    for (const m of list) {
      if (m.role !== "bot") continue;  // считаем cost только bot-replies (output side)
      const cost = estimateChatCallCost({
        inputChars: m.textLen * 2,
        outputChars: m.textLen,
        createdAtMillis: m.createdAtMillis,
        provider: "timeweb",
      });
      if (userGens.length === 0) {
        // юзер chat'ит но никогда не сгенерил — copy в "anonymous" bucket
        anonymous += cost;
        continue;
      }
      // Find first gen with createdAt > msg.createdAt
      let target: GenRow | null = null;
      for (const g of userGens) {
        if (g.createdAtMillis > m.createdAtMillis) {
          target = g;
          break;
        }
      }
      if (!target) {
        // chat after all gens → last gen
        target = userGens[userGens.length - 1];
      }
      perGen.set(target.id, (perGen.get(target.id) || 0) + cost);
    }
  });

  return { perGen, anonymous, perAnonymousChannel };
}

// ============================================================
// Public API
// ============================================================

/**
 * Search users by query (name / phone / email / id substring).
 */
export function searchUsers(query: string, limit: number = 50): Array<{
  userId: number;
  name: string;
  phone: string | null;
  email: string | null;
  createdAt: string | null;
}> {
  const db = rawDb();
  const lim = Math.max(1, Math.min(500, limit));
  const q = String(query || "").trim();
  if (!q) {
    // Without query — recent users
    const rows = db.prepare(`
      SELECT id, name, phone, email, created_at
      FROM users
      ORDER BY id DESC
      LIMIT ?
    `).all(lim) as any[];
    return rows.map(r => ({
      userId: Number(r.id),
      name: String(r.name || ""),
      phone: r.phone ?? null,
      email: r.email ?? null,
      createdAt: r.created_at ?? null,
    }));
  }
  const like = `%${q}%`;
  const numQ = /^\d+$/.test(q) ? Number(q) : -1;
  const rows = db.prepare(`
    SELECT id, name, phone, email, created_at
    FROM users
    WHERE id = ?
       OR name LIKE ?
       OR phone LIKE ?
       OR email LIKE ?
    ORDER BY id DESC
    LIMIT ?
  `).all(numQ, like, like, like, lim) as any[];
  return rows.map(r => ({
    userId: Number(r.id),
    name: String(r.name || ""),
    phone: r.phone ?? null,
    email: r.email ?? null,
    createdAt: r.created_at ?? null,
  }));
}

/**
 * Per-user stats. Use cache 5 min.
 */
export function getUserStats(userId: number, fromIso?: string, toIso?: string): DengaUserStats | null {
  const cacheKey = `user:${userId}:${fromIso || ""}:${toIso || ""}`;
  const cached = cacheGet<DengaUserStats>(cacheKey);
  if (cached) return cached;

  const db = rawDb();
  const u = db.prepare(`SELECT id, name, phone, email, balance, bonus_tracks, created_at FROM users WHERE id = ?`).get(userId) as any;
  if (!u) return null;

  // ALL user gens (для attribution — chat-to-track must see ALL gens, not just period)
  const allUserGens = loadGenerations({ userId });

  // Period-filtered gens (для агрегатов)
  const periodGens = (fromIso || toIso)
    ? allUserGens.filter(g => {
        const ts = g.createdAtMillis;
        if (fromIso) {
          const fm = toMillis(fromIso);
          if (ts < fm) return false;
        }
        if (toIso) {
          const tm = toMillis(toIso);
          if (ts >= tm) return false;
        }
        return true;
      })
    : allUserGens;

  // Chat messages (all-time for attribution)
  const allMsgs = loadChatMessages({ userId });
  // Period messages для self-chat cost (если chat in period — учитываем)
  const periodMsgs = (fromIso || toIso)
    ? allMsgs.filter(m => {
        const ts = m.createdAtMillis;
        if (fromIso && ts < toMillis(fromIso)) return false;
        if (toIso && ts >= toMillis(toIso)) return false;
        return true;
      })
    : allMsgs;

  // Manual overrides for ALL user gens
  const genIds = allUserGens.map(g => g.id);
  const overrides = loadManualOverrides({ genIds });

  // Attribute chat → tracks (using ALL gens to know "next gen after chat")
  const attribution = attributeChatCostToTracks(allUserGens, allMsgs);

  // Aggregate over period
  let totalRevenue = 0;
  let totalCost = 0;
  let chatCostInPeriod = 0;
  let tracksCount = 0;
  let lyricsCount = 0;
  let coversCount = 0;

  for (const g of periodGens) {
    const isErrored = g.status === "error" || g.status === "errored";
    if (isErrored) continue;  // не учитываем failed — там refund произошёл

    // Revenue: gen.cost — что юзер заплатил (точная цена на момент)
    const rev = g.cost > 0 ? g.cost : (FALLBACK_REVENUE[g.type] ?? 0);

    // Cost: estimate from tariff or override
    const baseCost = estimateGenerationCost({
      type: g.type,
      createdAtMillis: g.createdAtMillis,
      voiceType: g.voiceType,
    });
    const ov = overrides.get(g.id);
    let cost = baseCost;
    if (ov) {
      if (g.type === "music" || g.type === "audio_cover") cost = applyOverride(baseCost, ov.sunoCost);
      else if (g.type === "cover") cost = applyOverride(baseCost, ov.coverCost);
      else if (g.type === "lyrics") cost = applyOverride(baseCost, ov.lyricsCost);
    }

    totalRevenue += rev;
    totalCost += cost;

    if (g.type === "music") tracksCount += 1;
    else if (g.type === "lyrics") lyricsCount += 1;
    else if (g.type === "cover" || g.type === "audio_cover") coversCount += 1;

    // Chat cost attributed to this gen (within period — gen.createdAt in [from,to))
    const attributedChat = attribution.perGen.get(g.id) || 0;
    // Apply chat override if present
    const finalChatCost = ov ? applyOverride(attributedChat, ov.chatCost) : attributedChat;
    totalCost += finalChatCost;
    chatCostInPeriod += finalChatCost;
  }

  // Eugene 2026-05-29 — ручные продажи этого юзера (период-фильтр), АДДИТИВНО к выручке.
  const manualSales = getManualSalesRevenue(fromIso, toIso, userId);
  totalRevenue += manualSales.revenue;

  const profit = totalRevenue - totalCost;
  const totalGens = tracksCount + lyricsCount + coversCount;
  const avgProfitPerTrack = tracksCount > 0 ? Math.round(profit / tracksCount) : 0;
  const avgCostPerTrack = tracksCount > 0 ? Math.round(totalCost / tracksCount) : 0;
  const avgRevenuePerTrack = tracksCount > 0 ? Math.round(totalRevenue / tracksCount) : 0;

  const result: DengaUserStats = {
    userId: Number(u.id),
    name: String(u.name || ""),
    phone: u.phone ?? null,
    email: u.email ?? null,
    createdAt: u.created_at ?? null,
    totalRevenue,
    totalCost,
    profit,
    manualSalesRevenue: manualSales.revenue,
    tracksCount,
    lyricsCount,
    coversCount,
    chatCost: chatCostInPeriod,
    totalGenerations: totalGens,
    avgProfitPerTrack,
    avgCostPerTrack,
    avgRevenuePerTrack,
    balance: Number(u.balance) || 0,
    bonusTracks: Number(u.bonus_tracks) || 0,
  };
  cacheSet(cacheKey, result);
  return result;
}

/**
 * Per-track detailed stats (cost breakdown).
 */
export function getTrackStats(genId: number): DengaTrackStats | null {
  const db = rawDb();
  const g = db.prepare(`
    SELECT id, user_id, type, status, cost, display_title, prompt,
           voice_type, cover_gen_id, created_at
    FROM generations WHERE id = ?
  `).get(genId) as any;
  if (!g) return null;

  const gen: GenRow = {
    id: Number(g.id),
    userId: Number(g.user_id),
    type: String(g.type || "music"),
    status: String(g.status || ""),
    cost: Number(g.cost) || 0,
    displayTitle: g.display_title ?? null,
    prompt: String(g.prompt || ""),
    voiceType: g.voice_type ?? null,
    coverGenId: g.cover_gen_id != null ? Number(g.cover_gen_id) : null,
    createdAt: g.created_at ?? null,
    createdAtMillis: toMillis(g.created_at),
  };

  const u = db.prepare(`SELECT name FROM users WHERE id = ?`).get(gen.userId) as any;
  const userName = u?.name || `User #${gen.userId}`;

  const title = gen.displayTitle || (gen.prompt ? gen.prompt.slice(0, 60) : `#${gen.id}`);

  // For chat attribution — load ALL user gens + msgs
  const allUserGens = loadGenerations({ userId: gen.userId });
  const allMsgs = loadChatMessages({ userId: gen.userId });
  const attribution = attributeChatCostToTracks(allUserGens, allMsgs);
  const chatCostAttributed = attribution.perGen.get(gen.id) || 0;

  // Suno cost (если music)
  const sunoCost = gen.type === "music" || gen.type === "audio_cover"
    ? estimateMusicCost({ createdAtMillis: gen.createdAtMillis, voiceType: gen.voiceType })
    : 0;

  // Cover cost — если у gen прикреплена обложка (coverGenId), это отдельная gen,
  // но для UX отображаем её внутри track stats.
  let coverCost = 0;
  if (gen.coverGenId) {
    const cov = db.prepare(`SELECT created_at FROM generations WHERE id = ?`).get(gen.coverGenId) as any;
    if (cov) {
      coverCost = estimateCoverCost({ createdAtMillis: toMillis(cov.created_at) });
    }
  }

  // Lyrics cost — если у gen связана с источниковым lyrics gen, не покрываем здесь
  // (это отдельная gen в БД, считается отдельно). Здесь lyricsCost = 0 для music gens.
  let lyricsCost = 0;
  if (gen.type === "lyrics") {
    lyricsCost = estimateLyricsCost({ createdAtMillis: gen.createdAtMillis });
  }

  // Manual override
  const overrides = loadManualOverrides({ genIds: [gen.id] });
  const ov = overrides.get(gen.id);

  const finalSunoCost = ov ? applyOverride(sunoCost, ov.sunoCost) : sunoCost;
  const finalChatCost = ov ? applyOverride(chatCostAttributed, ov.chatCost) : chatCostAttributed;
  const finalCoverCost = ov ? applyOverride(coverCost, ov.coverCost) : coverCost;
  const finalLyricsCost = ov ? applyOverride(lyricsCost, ov.lyricsCost) : lyricsCost;

  const totalCost = finalSunoCost + finalChatCost + finalCoverCost + finalLyricsCost;
  const revenue = gen.cost > 0 ? gen.cost : (FALLBACK_REVENUE[gen.type] ?? 0);
  const profit = revenue - totalCost;

  return {
    genId: gen.id,
    userId: gen.userId,
    userName,
    type: gen.type,
    title,
    createdAt: gen.createdAt,
    status: gen.status,
    voiceType: gen.voiceType,
    sunoCost: finalSunoCost,
    chatCost: finalChatCost,
    coverCost: finalCoverCost,
    lyricsCost: finalLyricsCost,
    totalCost,
    revenue,
    profit,
    hasManualOverride: !!ov,
  };
}

/**
 * Anonymous chat session stats (no userId attached).
 */
export function getAnonymousStats(fromIso?: string, toIso?: string): DengaAnonymousStats {
  const cacheKey = `anonymous:${fromIso || ""}:${toIso || ""}`;
  const cached = cacheGet<DengaAnonymousStats>(cacheKey);
  if (cached) return cached;

  const allMsgs = loadChatMessages({ fromIso, toIso });
  // Anonymous = userId null
  const anonMsgs = allMsgs.filter(m => m.userId == null);
  const sessions = new Set<string>();
  const byChannel: Record<string, { sessions: Set<string>; messages: number; cost: number }> = {};
  let totalCost = 0;

  for (const m of anonMsgs) {
    if (m.role !== "bot") continue;
    sessions.add(m.sessionId);
    const cost = estimateChatCallCost({
      inputChars: m.textLen * 2,
      outputChars: m.textLen,
      createdAtMillis: m.createdAtMillis,
      provider: "timeweb",
    });
    totalCost += cost;
    if (!byChannel[m.channel]) {
      byChannel[m.channel] = { sessions: new Set(), messages: 0, cost: 0 };
    }
    byChannel[m.channel].sessions.add(m.sessionId);
    byChannel[m.channel].messages += 1;
    byChannel[m.channel].cost += cost;
  }

  const result: DengaAnonymousStats = {
    sessions: sessions.size,
    messagesCount: anonMsgs.filter(m => m.role === "bot").length,
    totalChatCost: totalCost,
    avgCostPerSession: sessions.size > 0 ? Math.round(totalCost / sessions.size) : 0,
    byChannel: Object.fromEntries(
      Object.entries(byChannel).map(([ch, v]) => [
        ch,
        { sessions: v.sessions.size, messages: v.messages, cost: v.cost },
      ]),
    ),
  };
  cacheSet(cacheKey, result);
  return result;
}

/**
 * Global aggregates по period. Цикл по всем gens + chats в period.
 */
export function getAggregates(opts: {
  periodLabel: string;
  fromIso: string;
  toIso: string;
}): DengaAggregates {
  const cacheKey = `agg:${opts.periodLabel}:${opts.fromIso}:${opts.toIso}`;
  const cached = cacheGet<DengaAggregates>(cacheKey);
  if (cached) return cached;

  // ALL gens for attribution (chat → track требует видеть весь user timeline)
  const allGens = loadGenerations({});
  const allMsgs = loadChatMessages({});
  const attribution = attributeChatCostToTracks(allGens, allMsgs);

  // Period-filtered gens (для агрегатов)
  const fromMs = toMillis(opts.fromIso);
  const toMs = toMillis(opts.toIso);
  const periodGens = allGens.filter(g => g.createdAtMillis >= fromMs && g.createdAtMillis < toMs);

  // Period-filtered msgs (для anonymous cost in period)
  const periodMsgs = allMsgs.filter(m => m.createdAtMillis >= fromMs && m.createdAtMillis < toMs);
  const periodAnonAttribution = attributeChatCostToTracks([], periodMsgs.filter(m => m.userId == null));

  // Overrides for ALL period gens
  const genIds = periodGens.map(g => g.id);
  const overrides = loadManualOverrides({ genIds });

  let totalRevenue = 0;
  let totalCost = 0;
  let totalChatCost = 0;
  let totalTracks = 0;
  let totalLyrics = 0;
  let totalCovers = 0;
  const distinctUsers = new Set<number>();

  for (const g of periodGens) {
    const isErrored = g.status === "error" || g.status === "errored";
    if (isErrored) continue;

    distinctUsers.add(g.userId);
    const rev = g.cost > 0 ? g.cost : (FALLBACK_REVENUE[g.type] ?? 0);
    totalRevenue += rev;

    const baseCost = estimateGenerationCost({
      type: g.type,
      createdAtMillis: g.createdAtMillis,
      voiceType: g.voiceType,
    });
    const ov = overrides.get(g.id);
    let cost = baseCost;
    if (ov) {
      if (g.type === "music" || g.type === "audio_cover") cost = applyOverride(baseCost, ov.sunoCost);
      else if (g.type === "cover") cost = applyOverride(baseCost, ov.coverCost);
      else if (g.type === "lyrics") cost = applyOverride(baseCost, ov.lyricsCost);
    }
    totalCost += cost;

    if (g.type === "music") totalTracks += 1;
    else if (g.type === "lyrics") totalLyrics += 1;
    else if (g.type === "cover" || g.type === "audio_cover") totalCovers += 1;

    const attributedChat = attribution.perGen.get(g.id) || 0;
    const finalChatCost = ov ? applyOverride(attributedChat, ov.chatCost) : attributedChat;
    totalCost += finalChatCost;
    totalChatCost += finalChatCost;
  }

  const anonymousChatCost = periodAnonAttribution.anonymous;
  // Note: anonymousChatCost — ОТДЕЛЬНЫЙ bucket, прибавляем к totalCost потому что
  // это реальный наш расход на провайдеры, без которого нельзя.
  totalCost += anonymousChatCost;

  // Eugene 2026-05-29 — ручные продажи (пакеты офлайн), АДДИТИВНО к выручке.
  // Per-track числа НЕ меняем — это отдельный канал revenue без generation.
  const manualSales = getManualSalesRevenue(opts.fromIso, opts.toIso);
  totalRevenue += manualSales.revenue;

  const totalProfit = totalRevenue - totalCost;
  const avgProfitPerTrack = totalTracks > 0 ? Math.round(totalProfit / totalTracks) : 0;
  const avgCostPerTrack = totalTracks > 0 ? Math.round(totalCost / totalTracks) : 0;
  const avgRevenuePerTrack = totalTracks > 0 ? Math.round(totalRevenue / totalTracks) : 0;

  const result: DengaAggregates = {
    periodLabel: opts.periodLabel,
    fromIso: opts.fromIso,
    toIso: opts.toIso,
    totalUsers: distinctUsers.size,
    totalTracks,
    totalLyrics,
    totalCovers,
    totalRevenue,
    totalCost,
    totalChatCost,
    anonymousChatCost,
    manualSalesRevenue: manualSales.revenue,
    totalProfit,
    avgProfitPerTrack,
    avgCostPerTrack,
    avgRevenuePerTrack,
    generatedAt: new Date().toISOString(),
  };
  cacheSet(cacheKey, result);
  return result;
}

/**
 * List users with stats by period (paginated).
 * Filter: query string for search, period for revenue/cost window.
 */
export function listUsersWithStats(opts: {
  search?: string;
  fromIso?: string;
  toIso?: string;
  limit?: number;
  sortBy?: "profit" | "revenue" | "cost" | "tracks" | "id";
  sortDir?: "asc" | "desc";
}): {
  users: DengaUserStats[];
  total: number;
} {
  const lim = Math.max(1, Math.min(500, opts.limit || 100));
  const matched = searchUsers(opts.search || "", lim * 2);

  const stats = matched
    .map(m => getUserStats(m.userId, opts.fromIso, opts.toIso))
    .filter((s): s is DengaUserStats => s != null);

  const sortBy = opts.sortBy || "profit";
  const sortDir = opts.sortDir || "desc";
  stats.sort((a, b) => {
    let av = 0;
    let bv = 0;
    if (sortBy === "profit") { av = a.profit; bv = b.profit; }
    else if (sortBy === "revenue") { av = a.totalRevenue; bv = b.totalRevenue; }
    else if (sortBy === "cost") { av = a.totalCost; bv = b.totalCost; }
    else if (sortBy === "tracks") { av = a.tracksCount; bv = b.tracksCount; }
    else { av = a.userId; bv = b.userId; }
    return sortDir === "asc" ? av - bv : bv - av;
  });

  return {
    users: stats.slice(0, lim),
    total: stats.length,
  };
}

/**
 * List tracks with stats (filter by user / search by title).
 */
export function listTracksWithStats(opts: {
  userId?: number;
  search?: string;
  fromIso?: string;
  toIso?: string;
  limit?: number;
}): { tracks: DengaTrackStats[]; total: number } {
  const lim = Math.max(1, Math.min(500, opts.limit || 100));
  const gens = loadGenerations({
    fromIso: opts.fromIso,
    toIso: opts.toIso,
    userId: opts.userId,
  });
  // Search filter on title/prompt
  const q = String(opts.search || "").trim().toLowerCase();
  const filtered = q
    ? gens.filter(g => {
        const title = (g.displayTitle || g.prompt || "").toLowerCase();
        return title.includes(q);
      })
    : gens;

  // Sort by createdAt DESC
  filtered.sort((a, b) => b.createdAtMillis - a.createdAtMillis);
  const top = filtered.slice(0, lim);

  const tracks = top
    .map(g => getTrackStats(g.id))
    .filter((t): t is DengaTrackStats => t != null);

  return { tracks, total: filtered.length };
}

/**
 * Manual cost override. Idempotent — добавляет новую запись (latest wins).
 * Аудит-лог — на стороне endpoint (через recordAuditEntry).
 */
/**
 * Eugene 2026-05-29 — выручка с ручных продаж (denga_manual_sales).
 * SUM(amount_kopecks) + count, опционально фильтр по диапазону created_at и user_id.
 * Отдельный канал выручки: пакеты продаются офлайн, у них нет generation,
 * поэтому per-track revenue (gen.cost) их не видит. Прибавляется к totalRevenue
 * АДДИТИВНО, не меняя per-track числа.
 */
export function getManualSalesRevenue(
  fromIso?: string,
  toIso?: string,
  userId?: number,
): { revenue: number; count: number } {
  try {
    const db = rawDb();
    const where: string[] = [];
    const params: any[] = [];
    if (fromIso) {
      where.push(`created_at >= ?`);
      params.push(fromIso);
    }
    if (toIso) {
      where.push(`created_at < ?`);
      params.push(toIso);
    }
    if (userId != null && Number.isFinite(userId)) {
      where.push(`user_id = ?`);
      params.push(userId);
    }
    const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";
    const row = db
      .prepare(
        `SELECT COALESCE(SUM(amount_kopecks), 0) AS revenue, COUNT(*) AS cnt
         FROM denga_manual_sales ${whereSql}`,
      )
      .get(...params) as any;
    return { revenue: Number(row?.revenue) || 0, count: Number(row?.cnt) || 0 };
  } catch (e: any) {
    console.warn("[denga] getManualSalesRevenue failed:", e?.message || e);
    return { revenue: 0, count: 0 };
  }
}

export interface ManualSaleRow {
  id: number;
  userId: number | null;
  amountKopecks: number;
  trackQty: number;
  note: string | null;
  adminId: number | null;
  createdAt: string | null;
  userEmail: string | null;
  userName: string | null;
}

/**
 * Eugene 2026-05-29 — записать ручную продажу пакета (офлайн). Возвращает id
 * вставленной строки. Все значения через параметризованные запросы.
 */
export function insertManualSale(opts: {
  userId: number | null;
  amountKopecks: number;
  trackQty: number;
  note?: string | null;
  adminId: number | null;
}): { ok: boolean; id?: number; error?: string } {
  try {
    const db = rawDb();
    const info = db
      .prepare(
        `INSERT INTO denga_manual_sales (user_id, amount_kopecks, track_qty, note, admin_id, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        opts.userId != null && Number.isFinite(opts.userId) ? opts.userId : null,
        Math.round(opts.amountKopecks),
        Math.round(opts.trackQty),
        opts.note ? String(opts.note).slice(0, 1000) : null,
        opts.adminId != null && Number.isFinite(opts.adminId) ? opts.adminId : null,
        new Date().toISOString(),
      );
    invalidateDengaCache();
    return { ok: true, id: Number(info?.lastInsertRowid) || undefined };
  } catch (e: any) {
    console.warn("[denga] insertManualSale failed:", e?.message || e);
    return { ok: false, error: String(e?.message || e).slice(0, 300) };
  }
}

/**
 * Eugene 2026-05-29 — последние ручные продажи (для admin UI списка),
 * с email/именем покупателя если user_id известен.
 */
export function listManualSales(limit: number = 50): ManualSaleRow[] {
  try {
    const db = rawDb();
    const lim = Math.max(1, Math.min(500, Math.round(limit) || 50));
    const rows = db
      .prepare(
        `SELECT s.id, s.user_id AS userId, s.amount_kopecks AS amountKopecks,
                s.track_qty AS trackQty, s.note, s.admin_id AS adminId,
                s.created_at AS createdAt, u.email AS userEmail, u.name AS userName
         FROM denga_manual_sales s
         LEFT JOIN users u ON u.id = s.user_id
         ORDER BY s.id DESC
         LIMIT ?`,
      )
      .all(lim) as any[];
    return rows.map((r) => ({
      id: Number(r.id),
      userId: r.userId != null ? Number(r.userId) : null,
      amountKopecks: Number(r.amountKopecks) || 0,
      trackQty: Number(r.trackQty) || 0,
      note: r.note ?? null,
      adminId: r.adminId != null ? Number(r.adminId) : null,
      createdAt: r.createdAt ?? null,
      userEmail: r.userEmail ?? null,
      userName: r.userName ?? null,
    }));
  } catch (e: any) {
    console.warn("[denga] listManualSales failed:", e?.message || e);
    return [];
  }
}

export function setManualCost(opts: {
  genId: number;
  adminId: number;
  override: DengaManualCostOverride;
}): { ok: boolean; id?: number; error?: string } {
  try {
    const db = rawDb();
    const g = db.prepare(`SELECT id, user_id FROM generations WHERE id = ?`).get(opts.genId) as any;
    if (!g) return { ok: false, error: "Generation not found" };
    const o = opts.override || {};
    const stmt = db.prepare(`
      INSERT INTO denga_manual_costs (gen_id, user_id, suno_cost, chat_cost, cover_cost, lyrics_cost, notes, admin_id, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const result = stmt.run(
      opts.genId,
      g.user_id,
      o.sunoCost != null ? Math.round(o.sunoCost) : null,
      o.chatCost != null ? Math.round(o.chatCost) : null,
      o.coverCost != null ? Math.round(o.coverCost) : null,
      o.lyricsCost != null ? Math.round(o.lyricsCost) : null,
      o.notes || null,
      opts.adminId,
      Date.now(),
    );
    // Invalidate caches связанные с этим юзером
    invalidateDengaCache();
    return { ok: true, id: Number(result.lastInsertRowid) };
  } catch (e: any) {
    console.warn("[denga] setManualCost failed:", e?.message || e);
    return { ok: false, error: String(e?.message || e).slice(0, 200) };
  }
}

/**
 * Get manual overrides history for a gen.
 */
export function getManualCostHistory(genId: number): ManualCostRow[] {
  try {
    const db = rawDb();
    const rows = db.prepare(`
      SELECT * FROM denga_manual_costs WHERE gen_id = ? ORDER BY id DESC
    `).all(genId) as any[];
    return rows.map(r => ({
      id: Number(r.id),
      genId: Number(r.gen_id),
      userId: r.user_id != null ? Number(r.user_id) : null,
      sunoCost: r.suno_cost != null ? Number(r.suno_cost) : null,
      chatCost: r.chat_cost != null ? Number(r.chat_cost) : null,
      coverCost: r.cover_cost != null ? Number(r.cover_cost) : null,
      lyricsCost: r.lyrics_cost != null ? Number(r.lyrics_cost) : null,
      notes: r.notes ?? null,
      adminId: Number(r.admin_id),
      createdAt: Number(r.created_at),
    }));
  } catch (e: any) {
    console.warn("[denga] getManualCostHistory failed:", e?.message || e);
    return [];
  }
}

/**
 * Lifetime stats для агента — used by Orchestrator health check.
 */
export function getDengaAgentStats(): {
  cacheSize: number;
  totalOverrides: number;
  lastCalcAt: number | null;
} {
  try {
    const db = rawDb();
    const cnt = db.prepare(`SELECT COUNT(*) AS c FROM denga_manual_costs`).get() as any;
    return {
      cacheSize: cache.size,
      totalOverrides: Number(cnt?.c) || 0,
      lastCalcAt: null,
    };
  } catch {
    return { cacheSize: cache.size, totalOverrides: 0, lastCalcAt: null };
  }
}
