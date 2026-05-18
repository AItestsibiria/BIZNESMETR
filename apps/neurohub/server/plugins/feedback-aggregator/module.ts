// Eugene 2026-05-18 Босс «Suggestion aggregator + NPS».
//
// Плагин feedback-aggregator — собирает client_suggestions + nps_log.
// Группирует похожие предложения через cluster_key (MD5 от lowercase
// первых 50 символов — простая alternative для TF-IDF/simhash без deps).
//
// При накоплении >=N (default 10) одинаковых suggestions в кластере —
// Telegram-alert Боссу с примером:
//   💡 10 юзеров просят: «{cluster_sample_text}»
//
// Per Knowledge-base sync + Hourly digest rules: кластерный alert идёт
// дополнительно к hourly digest (для важности).
//
// TODO after merge ae295800: добавить tool log_suggestion / log_nps в
// muzaTools.ts — Муза будет вызывать POST endpoints автоматически когда
// юзер делится мнением. Сейчас endpoints — публичные (auth-aware).

import { Router, type Request, type Response } from "express";
import { z } from "zod";
import { sql } from "drizzle-orm";
import crypto from "crypto";
import { db } from "../../storage";
import { requireAdmin } from "../../core/adminAuth";
import { tokenStore } from "../../lib/tokenStore";
import type { Module } from "../../core";

// === Sentiment helpers ===

const POS_WORDS = [
  "спасибо", "отлично", "класс", "люблю", "нравится", "супер",
  "круто", "лучший", "топ", "удобно", "понравил",
];
const NEG_WORDS = [
  "ужасно", "плохо", "не нравится", "отстой", "верните",
  "обман", "мошенник", "сложно", "разочарован", "не работает",
];

function naiveSentiment(text: string): number {
  const t = (text || "").toLowerCase();
  let s = 0;
  for (const w of POS_WORDS) if (t.includes(w)) s += 0.3;
  for (const w of NEG_WORDS) if (t.includes(w)) s -= 0.4;
  if (/[👍❤🔥💯😍🥰]/.test(text)) s += 0.4;
  if (/[😡😠💩🤬👎]/.test(text)) s -= 0.5;
  // clamp
  return Math.max(-1, Math.min(1, s));
}

function clusterKeyFor(text: string): string {
  const norm = (text || "").toLowerCase().trim().replace(/\s+/g, " ").slice(0, 50);
  return crypto.createHash("md5").update(norm).digest("hex");
}

// === Telegram alert (best-effort) ===

const CLUSTER_ALERT_THRESHOLD = parseInt(process.env.SUGGESTION_CLUSTER_ALERT_N || "10", 10) || 10;
const _alertedClusters = new Set<string>(); // дедуп в памяти, чтобы не флудить (TTL 24ч через timer)

async function tgAlert(text: string): Promise<void> {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const adminId = process.env.ADMIN_TELEGRAM_ID;
  if (!token || !adminId) return;
  try {
    await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: adminId,
        text,
        parse_mode: "Markdown",
        disable_web_page_preview: true,
      }),
      signal: AbortSignal.timeout(8_000),
    });
  } catch (e: any) {
    console.warn("[feedback-aggregator] tg alert failed:", e?.message || e);
  }
}

// === Auto-migrate ===

function ensureTables(): void {
  try {
    const sqlite: any = (db as any).$client;
    sqlite.exec(`
      CREATE TABLE IF NOT EXISTS client_suggestions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER,
        anonymous_session TEXT,
        category TEXT,
        text TEXT NOT NULL,
        sentiment_score REAL,
        source TEXT DEFAULT 'musa_chat',
        chat_session_id TEXT,
        cluster_key TEXT,
        created_at INTEGER NOT NULL,
        reviewed INTEGER DEFAULT 0,
        reviewed_at INTEGER,
        admin_note TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_suggestions_cluster ON client_suggestions(cluster_key, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_suggestions_reviewed ON client_suggestions(reviewed, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_suggestions_category ON client_suggestions(category, created_at DESC);

      CREATE TABLE IF NOT EXISTS nps_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER,
        anonymous_session TEXT,
        score INTEGER,
        comment TEXT,
        chat_session_id TEXT,
        created_at INTEGER NOT NULL,
        source TEXT DEFAULT 'musa_closing'
      );
      CREATE INDEX IF NOT EXISTS idx_nps_created ON nps_log(created_at DESC);
    `);
  } catch (e) {
    console.warn("[feedback-aggregator] migration failed:", e);
  }
}

// === Helpers ===

function tryGetUserId(req: Request): number | null {
  try {
    const auth = req.headers.authorization;
    let token: string | undefined;
    if (auth?.startsWith("Bearer ")) token = auth.slice(7);
    else if (typeof req.query.token === "string") token = req.query.token;
    if (!token || !tokenStore.has(token)) return null;
    return tokenStore.get(token) ?? null;
  } catch {
    return null;
  }
}

// === Zod ===

const SuggestionSchema = z.object({
  text: z.string().trim().min(1).max(2000),
  category: z.enum(["feature", "bug", "pricing", "ui", "persona", "other"]).optional(),
  sessionId: z.string().trim().max(200).optional(),
  source: z.string().trim().max(50).optional(),
});

const NpsSchema = z.object({
  score: z.number().int().min(0).max(10),
  comment: z.string().trim().max(2000).optional(),
  sessionId: z.string().trim().max(200).optional(),
  source: z.string().trim().max(50).optional(),
});

const ReviewSchema = z.object({
  note: z.string().trim().max(2000).optional(),
});

// === Public routes ===

const publicRouter = Router();

// POST /api/feedback/suggestion
publicRouter.post("/suggestion", async (req: Request, res: Response) => {
  try {
    const parsed = SuggestionSchema.safeParse(req.body || {});
    if (!parsed.success) {
      res.status(400).json({ data: null, error: "Некорректные параметры" });
      return;
    }
    const { text, category, sessionId, source } = parsed.data;
    const userId = tryGetUserId(req);
    const sentiment = naiveSentiment(text);
    const cluster = clusterKeyFor(text);
    const now = Date.now();

    const result: any = db.run(sql`
      INSERT INTO client_suggestions
        (user_id, anonymous_session, category, text, sentiment_score, source,
         chat_session_id, cluster_key, created_at)
      VALUES
        (${userId ?? null}, ${userId ? null : (sessionId ?? null)},
         ${category ?? null}, ${text}, ${sentiment}, ${source || "musa_chat"},
         ${sessionId ?? null}, ${cluster}, ${now})
    `);

    // Async cluster threshold check.
    void checkClusterThreshold(cluster, text);

    res.json({ data: { id: Number(result?.lastInsertRowid ?? 0), cluster }, error: null });
  } catch (e: any) {
    console.error("[feedback suggestion]", e);
    res.status(500).json({ data: null, error: "Не удалось сохранить" });
  }
});

// POST /api/feedback/nps
publicRouter.post("/nps", async (req: Request, res: Response) => {
  try {
    const parsed = NpsSchema.safeParse(req.body || {});
    if (!parsed.success) {
      res.status(400).json({ data: null, error: "Некорректные параметры (score 0..10)" });
      return;
    }
    const { score, comment, sessionId, source } = parsed.data;
    const userId = tryGetUserId(req);
    const now = Date.now();

    const result: any = db.run(sql`
      INSERT INTO nps_log
        (user_id, anonymous_session, score, comment, chat_session_id, created_at, source)
      VALUES
        (${userId ?? null}, ${userId ? null : (sessionId ?? null)},
         ${score}, ${comment ?? null}, ${sessionId ?? null}, ${now}, ${source || "musa_closing"})
    `);

    res.json({ data: { id: Number(result?.lastInsertRowid ?? 0), score }, error: null });
  } catch (e: any) {
    console.error("[feedback nps]", e);
    res.status(500).json({ data: null, error: "Не удалось сохранить" });
  }
});

// === Cluster threshold check ===

async function checkClusterThreshold(cluster: string, sampleText: string): Promise<void> {
  try {
    if (_alertedClusters.has(cluster)) return;
    const sqlite: any = (db as any).$client;
    const row = sqlite
      .prepare(`SELECT COUNT(*) as cnt FROM client_suggestions WHERE cluster_key = ?`)
      .get(cluster);
    const cnt = Number(row?.cnt ?? 0);
    if (cnt >= CLUSTER_ALERT_THRESHOLD) {
      _alertedClusters.add(cluster);
      // Periodic auto-clear, чтобы при росте 20/30/40 опять вылетел alert.
      setTimeout(() => _alertedClusters.delete(cluster), 6 * 3600 * 1000);
      const trimmedSample = sampleText.slice(0, 200);
      await tgAlert(
        `💡 *${cnt} юзеров просят:* «${trimmedSample}»\n\nОткрой Admin → 💡 Предложения`,
      );
    }
  } catch (e) {
    console.warn("[feedback cluster check]", e);
  }
}

// === Admin routes ===

const adminRouter = Router();
adminRouter.use(requireAdmin);

// GET /api/admin/v304/suggestions?category=&reviewed=&minThreshold=N&limit=
adminRouter.get("/suggestions", (req: Request, res: Response) => {
  try {
    const category = (req.query.category as string) || "";
    const reviewed = req.query.reviewed === "1" ? 1 : req.query.reviewed === "0" ? 0 : null;
    const minThreshold = Math.max(1, parseInt((req.query.minThreshold as string) || "1", 10) || 1);
    const limit = Math.max(1, Math.min(500, parseInt((req.query.limit as string) || "100", 10) || 100));

    const sqlite: any = (db as any).$client;

    const where: string[] = [];
    const params: any[] = [];
    if (category) {
      where.push("category = ?");
      params.push(category);
    }
    if (reviewed !== null) {
      where.push("reviewed = ?");
      params.push(reviewed);
    }
    const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";

    // Список одиночных suggestions.
    const items = sqlite
      .prepare(
        `SELECT id, user_id, anonymous_session, category, text, sentiment_score, source,
                chat_session_id, cluster_key, created_at, reviewed, reviewed_at, admin_note
         FROM client_suggestions
         ${whereSql}
         ORDER BY created_at DESC
         LIMIT ?`,
      )
      .all(...params, limit);

    // Кластеры — отдельный query с GROUP BY HAVING >= minThreshold.
    const clusterParams = [...params];
    const clusters = sqlite
      .prepare(
        `SELECT cluster_key,
                COUNT(*) as cnt,
                MAX(text) as sample_text,
                AVG(sentiment_score) as avg_sentiment,
                MIN(created_at) as first_at,
                MAX(created_at) as last_at
         FROM client_suggestions
         ${whereSql}
         GROUP BY cluster_key
         HAVING COUNT(*) >= ?
         ORDER BY cnt DESC, last_at DESC
         LIMIT 50`,
      )
      .all(...clusterParams, minThreshold);

    res.json({ data: { items, clusters, threshold: minThreshold }, error: null });
  } catch (e: any) {
    console.error("[suggestions list]", e);
    res.status(500).json({ data: null, error: "Не удалось получить предложения" });
  }
});

// POST /api/admin/v304/suggestions/:id/review
adminRouter.post("/suggestions/:id/review", (req: Request, res: Response) => {
  try {
    const id = parseInt(String(req.params.id), 10);
    if (!Number.isFinite(id) || id <= 0) {
      res.status(400).json({ data: null, error: "Неверный id" });
      return;
    }
    const parsed = ReviewSchema.safeParse(req.body || {});
    const note = parsed.success ? (parsed.data.note ?? null) : null;
    const now = Date.now();
    const result: any = db.run(sql`
      UPDATE client_suggestions
      SET reviewed = 1, reviewed_at = ${now}, admin_note = ${note}
      WHERE id = ${id}
    `);
    if (!result || result.changes === 0) {
      res.status(404).json({ data: null, error: "Запись не найдена" });
      return;
    }
    res.json({ data: { id, reviewed: true }, error: null });
  } catch (e: any) {
    console.error("[suggestions review]", e);
    res.status(500).json({ data: null, error: "Не удалось отметить" });
  }
});

// GET /api/admin/v304/nps?period=today|week|month|all
adminRouter.get("/nps", (req: Request, res: Response) => {
  try {
    const period = (req.query.period as string) || "month";
    const now = Date.now();
    let fromMs = 0;
    if (period === "today") fromMs = now - 24 * 3600 * 1000;
    else if (period === "week") fromMs = now - 7 * 24 * 3600 * 1000;
    else if (period === "month") fromMs = now - 30 * 24 * 3600 * 1000;
    else if (period === "year") fromMs = now - 365 * 24 * 3600 * 1000;
    else fromMs = 0;

    const sqlite: any = (db as any).$client;

    // Distribution per score (0..10).
    const distRows = sqlite
      .prepare(
        `SELECT score, COUNT(*) as cnt
         FROM nps_log
         WHERE created_at >= ?
         GROUP BY score
         ORDER BY score`,
      )
      .all(fromMs);
    const dist: Record<number, number> = {};
    for (let i = 0; i <= 10; i++) dist[i] = 0;
    for (const r of distRows) dist[Number(r.score)] = Number(r.cnt);

    const total = Object.values(dist).reduce((a, b) => a + b, 0);
    let promoters = 0;
    let detractors = 0;
    let passives = 0;
    for (let s = 0; s <= 10; s++) {
      if (s >= 9) promoters += dist[s];
      else if (s <= 6) detractors += dist[s];
      else passives += dist[s];
    }
    const npsScore = total > 0 ? Math.round(((promoters - detractors) / total) * 100) : 0;

    // Last 20 comments.
    const comments = sqlite
      .prepare(
        `SELECT id, user_id, score, comment, created_at
         FROM nps_log
         WHERE created_at >= ? AND comment IS NOT NULL AND length(trim(comment)) > 0
         ORDER BY created_at DESC
         LIMIT 20`,
      )
      .all(fromMs);

    res.json({
      data: {
        period,
        total,
        npsScore,
        promoters,
        passives,
        detractors,
        distribution: dist,
        comments,
      },
      error: null,
    });
  } catch (e: any) {
    console.error("[nps]", e);
    res.status(500).json({ data: null, error: "Не удалось получить NPS" });
  }
});

// === Module ===

const feedbackAggregatorModule: Module = {
  name: "feedback-aggregator",
  version: "0.1.0",
  description:
    "Сбор client_suggestions + nps_log с кластеризацией и alert при threshold (>=10 похожих).",
  migrations: [
    {
      version: "001_client_suggestions_nps.sql",
      up: `
        CREATE TABLE IF NOT EXISTS client_suggestions (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          user_id INTEGER,
          anonymous_session TEXT,
          category TEXT,
          text TEXT NOT NULL,
          sentiment_score REAL,
          source TEXT DEFAULT 'musa_chat',
          chat_session_id TEXT,
          cluster_key TEXT,
          created_at INTEGER NOT NULL,
          reviewed INTEGER DEFAULT 0,
          reviewed_at INTEGER,
          admin_note TEXT
        );
        CREATE INDEX IF NOT EXISTS idx_suggestions_cluster ON client_suggestions(cluster_key, created_at DESC);
        CREATE INDEX IF NOT EXISTS idx_suggestions_reviewed ON client_suggestions(reviewed, created_at DESC);
        CREATE INDEX IF NOT EXISTS idx_suggestions_category ON client_suggestions(category, created_at DESC);

        CREATE TABLE IF NOT EXISTS nps_log (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          user_id INTEGER,
          anonymous_session TEXT,
          score INTEGER,
          comment TEXT,
          chat_session_id TEXT,
          created_at INTEGER NOT NULL,
          source TEXT DEFAULT 'musa_closing'
        );
        CREATE INDEX IF NOT EXISTS idx_nps_created ON nps_log(created_at DESC);
      `,
    },
  ],
  routes: { prefix: "feedback", router: publicRouter },
  onLoad: async (ctx) => {
    ensureTables();
    ctx.app.use("/api/admin/v304", adminRouter);
    ctx.logger.info(
      "feedback-aggregator online — POST /api/feedback/{suggestion,nps}, GET /api/admin/v304/{suggestions,nps}",
    );
  },
  healthCheck: () => ({ status: "ok" }),
};

export default feedbackAggregatorModule;
