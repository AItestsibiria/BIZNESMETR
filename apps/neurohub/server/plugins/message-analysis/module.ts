// Eugene 2026-05-18 Босс «Auto-analysis после каждого сообщения».
//
// Плагин message-analysis — фиксирует sentiment / intent / topic /
// operator-mention для каждого user-message. Источник данных — helper
// `analyzeMessage` из server/lib/messageAnalyzer.ts.
//
// Запись в таблицу `message_analysis` делается через `logMessageAnalysis()`
// — sync, никогда не throw'ит (анализ не должен ломать chat-pipeline).
// Endpoints `/api/admin/v304/message-analysis*` под `requireAdmin`.
//
// Применяется к: всем каналам (web, telegram, max, future). Вызов из
// chat-pipeline — отдельным коммитом в routes.ts/telegram-bot/max-bot.
// Здесь только инфраструктура: таблица + helper + admin-endpoints.

import { Router, type Request, type Response } from "express";
import { z } from "zod";
import { db } from "../../storage";
import { requireAdmin } from "../../core/adminAuth";
import { getPeriodRange, normalizePeriodId } from "../../lib/periodBoundaries";
import { analyzeMessage } from "../../lib/messageAnalyzer";
import type { Module } from "../../core";

// === Auto-migrate ===
//
// Таблица message_analysis: по одной строке на проанализированное
// user-message. message_id — link на chatbot_messages.id если есть
// (для cross-channel и admin-UI hop). Sentiment_score в [-1..+1].

function ensureTable(): void {
  try {
    const sqlite: any = (db as any).$client;
    sqlite.exec(`
      CREATE TABLE IF NOT EXISTS message_analysis (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        message_id INTEGER,
        session_id TEXT,
        user_id INTEGER,
        channel TEXT,
        sentiment_score REAL,
        sentiment_label TEXT,
        intent TEXT,
        topic TEXT,
        triggers TEXT,
        mentions_operator INTEGER DEFAULT 0,
        created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_msg_analysis_session ON message_analysis(session_id, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_msg_analysis_intent ON message_analysis(intent, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_msg_analysis_sentiment ON message_analysis(sentiment_label, created_at DESC);
    `);
  } catch (e) {
    console.warn("[message-analysis] migration failed:", e);
  }
}

// === Public helper (для chat-pipeline) ===

export interface LogAnalysisInput {
  messageId?: number | null;
  sessionId?: string | null;
  userId?: number | null;
  channel?: string | null;
  text: string;
}

/**
 * Sync analyze + insert. Никогда не throw'ит — fail-soft.
 * Вызывается из chat-pipeline (routes.ts /api/muza/chat, telegram-bot,
 * max-bot) после получения user message. Возвращает результат анализа
 * для возможного downstream использования (например, если intent
 * 'complaint' — caller может сам эскалировать).
 */
export function logMessageAnalysis(input: LogAnalysisInput): ReturnType<typeof analyzeMessage> | null {
  try {
    const analysis = analyzeMessage(input.text || "");
    const sqlite: any = (db as any).$client;
    sqlite
      .prepare(
        `INSERT INTO message_analysis
          (message_id, session_id, user_id, channel,
           sentiment_score, sentiment_label, intent, topic,
           triggers, mentions_operator, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.messageId ?? null,
        input.sessionId ?? null,
        input.userId ?? null,
        input.channel ?? null,
        analysis.sentiment.score,
        analysis.sentiment.label,
        analysis.intent,
        analysis.topic,
        JSON.stringify(analysis.sentiment.triggers).slice(0, 1500),
        analysis.mentionsOperator ? 1 : 0,
        Date.now(),
      );
    return analysis;
  } catch (e) {
    console.warn("[message-analysis] log failed:", e);
    return null;
  }
}

// === Admin router ===

const adminRouter = Router();
adminRouter.use(requireAdmin);

const ListQuerySchema = z.object({
  period: z.string().optional(),
  intent: z.string().optional(),
  sentiment: z.string().optional(),
  channel: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(1000).optional(),
});

// GET /api/admin/v304/message-analysis?period=today&intent=complaint&sentiment=negative&limit=200
adminRouter.get("/", (req: Request, res: Response) => {
  try {
    const parsed = ListQuerySchema.safeParse(req.query || {});
    if (!parsed.success) {
      res.status(400).json({ data: null, error: "Некорректные параметры" });
      return;
    }
    const q = parsed.data;
    const period = normalizePeriodId(q.period);
    const range = getPeriodRange(period);
    const fromMs = Date.parse(range.fromIso);
    const toMs = Date.parse(range.toIso);
    const limit = q.limit ?? 200;

    const where: string[] = ["created_at >= ? AND created_at < ?"];
    const params: any[] = [fromMs, toMs];
    if (q.intent) {
      where.push("intent = ?");
      params.push(q.intent);
    }
    if (q.sentiment) {
      where.push("sentiment_label = ?");
      params.push(q.sentiment);
    }
    if (q.channel) {
      where.push("channel = ?");
      params.push(q.channel);
    }
    const whereSql = `WHERE ${where.join(" AND ")}`;
    const sqlite: any = (db as any).$client;
    const rows = sqlite
      .prepare(
        `SELECT id, message_id, session_id, user_id, channel,
                sentiment_score, sentiment_label, intent, topic,
                triggers, mentions_operator, created_at
         FROM message_analysis
         ${whereSql}
         ORDER BY created_at DESC
         LIMIT ?`,
      )
      .all(...params, limit);

    const items = rows.map((r: any) => {
      let triggersArr: string[] = [];
      try {
        triggersArr = r.triggers ? JSON.parse(r.triggers) : [];
      } catch {
        triggersArr = [];
      }
      return {
        id: r.id,
        messageId: r.message_id,
        sessionId: r.session_id,
        userId: r.user_id,
        channel: r.channel,
        sentimentScore: r.sentiment_score,
        sentimentLabel: r.sentiment_label,
        intent: r.intent,
        topic: r.topic,
        triggers: triggersArr,
        mentionsOperator: r.mentions_operator === 1,
        createdAt: r.created_at,
      };
    });

    res.json({
      data: { period: { id: range.id, label: range.label, fromIso: range.fromIso, toIso: range.toIso }, items },
      error: null,
    });
  } catch (e: any) {
    console.error("[message-analysis list]", e);
    res.status(500).json({ data: null, error: "Не удалось загрузить" });
  }
});

// GET /api/admin/v304/message-analysis/trends?period=today
// Aggregates: топ intents, sentiment distribution, кол-во mentions
// operator (для понимания «много ли просят живого человека»), top topics.
adminRouter.get("/trends", (req: Request, res: Response) => {
  try {
    const period = normalizePeriodId(req.query.period);
    const range = getPeriodRange(period);
    const fromMs = Date.parse(range.fromIso);
    const toMs = Date.parse(range.toIso);

    const sqlite: any = (db as any).$client;

    const intentRows = sqlite
      .prepare(
        `SELECT intent, COUNT(*) as count
         FROM message_analysis
         WHERE created_at >= ? AND created_at < ?
         GROUP BY intent
         ORDER BY count DESC`,
      )
      .all(fromMs, toMs);

    const sentimentRows = sqlite
      .prepare(
        `SELECT sentiment_label, COUNT(*) as count,
                AVG(sentiment_score) as avg_score
         FROM message_analysis
         WHERE created_at >= ? AND created_at < ?
         GROUP BY sentiment_label
         ORDER BY count DESC`,
      )
      .all(fromMs, toMs);

    const topicRows = sqlite
      .prepare(
        `SELECT topic, COUNT(*) as count
         FROM message_analysis
         WHERE created_at >= ? AND created_at < ?
         GROUP BY topic
         ORDER BY count DESC`,
      )
      .all(fromMs, toMs);

    const mentionsRow = sqlite
      .prepare(
        `SELECT COUNT(*) as total,
                SUM(mentions_operator) as mentions_operator
         FROM message_analysis
         WHERE created_at >= ? AND created_at < ?`,
      )
      .get(fromMs, toMs);

    res.json({
      data: {
        period: { id: range.id, label: range.label, fromIso: range.fromIso, toIso: range.toIso },
        intents: intentRows.map((r: any) => ({ intent: r.intent, count: r.count })),
        sentiments: sentimentRows.map((r: any) => ({
          label: r.sentiment_label,
          count: r.count,
          avgScore: r.avg_score,
        })),
        topics: topicRows.map((r: any) => ({ topic: r.topic, count: r.count })),
        mentions: {
          total: Number(mentionsRow?.total ?? 0),
          mentionsOperator: Number(mentionsRow?.mentions_operator ?? 0),
        },
      },
      error: null,
    });
  } catch (e: any) {
    console.error("[message-analysis trends]", e);
    res.status(500).json({ data: null, error: "Не удалось загрузить тренды" });
  }
});

// === Module ===

const messageAnalysisModule: Module = {
  name: "message-analysis",
  version: "0.1.0",
  description:
    "Auto-analysis (sentiment/intent/topic/mentions) для каждого user-message. Сохраняет в message_analysis.",
  migrations: [
    {
      version: "001_message_analysis.sql",
      up: `
        CREATE TABLE IF NOT EXISTS message_analysis (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          message_id INTEGER,
          session_id TEXT,
          user_id INTEGER,
          channel TEXT,
          sentiment_score REAL,
          sentiment_label TEXT,
          intent TEXT,
          topic TEXT,
          triggers TEXT,
          mentions_operator INTEGER DEFAULT 0,
          created_at INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_msg_analysis_session ON message_analysis(session_id, created_at DESC);
        CREATE INDEX IF NOT EXISTS idx_msg_analysis_intent ON message_analysis(intent, created_at DESC);
        CREATE INDEX IF NOT EXISTS idx_msg_analysis_sentiment ON message_analysis(sentiment_label, created_at DESC);
      `,
    },
  ],
  onLoad: async (ctx) => {
    ensureTable();
    ctx.app.use("/api/admin/v304/message-analysis", adminRouter);
    ctx.logger.info(
      "message-analysis online — admin GET /api/admin/v304/message-analysis[/trends]",
    );
  },
  healthCheck: () => ({ status: "ok" }),
};

export default messageAnalysisModule;
