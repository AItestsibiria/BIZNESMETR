// Cross-channel chat history (Eugene 2026-05-15 Босс «Связывай»).
//
// Один юзер — один thread, какой бы канал он ни использовал. LLM
// видит весь его контекст вместе с пометкой канала, admin тоже
// видит сквозной view.
//
// API:
//   loadHistoryForLLM(sessionId, limit) → merged history всех сессий
//     этого userId (если userId != null), в формате для Claude/GPTunnel.
//     Каждое сообщение префиксится [TG]/[Web]/[Max] чтобы LLM понимал
//     откуда юзер пишет.
//   loadHistoryForUser(userId, limit) → raw rows для admin UI.
//   loadSessionRaw(sessionId, limit) → fallback одна сессия (anonymous).

import { eq, sql, inArray } from "drizzle-orm";
import { db } from "../storage";
import { chatbotSessions, chatbotMessages } from "@shared/schema";

const CHANNEL_TAG: Record<string, string> = {
  telegram: "TG",
  max: "Max",
  vk: "VK",
  web: "Web",
  email: "Email",
};

function tagFor(channel: string | null | undefined): string {
  return CHANNEL_TAG[String(channel || "").toLowerCase()] || (channel ? String(channel).slice(0, 6) : "?");
}

// Resolve userId для sessionId (если linked). null если anonymous.
function getUserIdForSession(sessionId: string): number | null {
  try {
    const row = db.select({ userId: chatbotSessions.userId })
      .from(chatbotSessions).where(eq(chatbotSessions.id, sessionId)).get() as any;
    return row?.userId ?? null;
  } catch { return null; }
}

// Все sessionIds одного юзера (через все каналы).
function sessionIdsForUser(userId: number): string[] {
  try {
    const rows = db.select({ id: chatbotSessions.id })
      .from(chatbotSessions).where(eq(chatbotSessions.userId, userId)).all() as any[];
    return rows.map(r => r.id);
  } catch { return []; }
}

// LLM-history (merged cross-channel если userId привязан).
// Сообщения помечаются [TG]/[Web]/[Max] чтобы LLM понимал канал.
// Текущий канал НЕ помечается (чтобы не мусорить контекст), помечаются
// только сообщения из других каналов.
export function loadHistoryForLLM(
  sessionId: string,
  limit = 20,
): Array<{ role: "user" | "assistant"; content: string }> {
  const userId = getUserIdForSession(sessionId);
  if (!userId) {
    return loadSessionRaw(sessionId, limit).map(r => ({
      role: r.role === "user" ? "user" : "assistant",
      content: r.text,
    }));
  }
  const ids = sessionIdsForUser(userId);
  if (ids.length === 0) return [];
  // Текущий channel — чтобы не дублировать тег.
  const currentChannel = (() => {
    try {
      const r = db.select({ channel: chatbotSessions.channel })
        .from(chatbotSessions).where(eq(chatbotSessions.id, sessionId)).get() as any;
      return String(r?.channel || "").toLowerCase();
    } catch { return ""; }
  })();
  try {
    const rows = db.select({
      role: chatbotMessages.role,
      text: chatbotMessages.text,
      sessionId: chatbotMessages.sessionId,
      createdAt: chatbotMessages.createdAt,
    })
      .from(chatbotMessages)
      .where(inArray(chatbotMessages.sessionId, ids))
      .orderBy(sql`${chatbotMessages.createdAt} ASC, ${chatbotMessages.id} ASC`)
      .all() as any[];
    // Map sessionId → channel.
    const sessions = db.select({ id: chatbotSessions.id, channel: chatbotSessions.channel })
      .from(chatbotSessions).where(inArray(chatbotSessions.id, ids)).all() as any[];
    const chMap = new Map<string, string>(sessions.map(s => [s.id, String(s.channel || "").toLowerCase()]));
    const sliced = rows.slice(-limit);
    return sliced.map(r => {
      const ch = chMap.get(r.sessionId) || "";
      const content = String(r.text || "").slice(0, 1500);
      const prefix = ch && ch !== currentChannel ? `[${tagFor(ch)}] ` : "";
      return {
        role: r.role === "user" ? "user" as const : "assistant" as const,
        content: prefix + content,
      };
    });
  } catch { return []; }
}

// Admin/UI raw history по sessionId (одна сессия).
export function loadSessionRaw(
  sessionId: string,
  limit = 30,
): Array<{ role: string; text: string; createdAt: string | null }> {
  try {
    const rows = db.select().from(chatbotMessages)
      .where(eq(chatbotMessages.sessionId, sessionId))
      .orderBy(sql`${chatbotMessages.id} DESC`)
      .limit(limit)
      .all() as any[];
    return rows.reverse().map(r => ({
      role: r.role,
      text: String(r.text || "").slice(0, 1500),
      createdAt: r.createdAt,
    }));
  } catch { return []; }
}

// Admin/UI: все сессии и сообщения одного userId — сквозной view.
export function loadHistoryForUser(userId: number, limit = 200): {
  sessions: Array<{ id: string; channel: string; startedAt: string | null; lastMessageAt: string | null; personaName: string | null }>;
  messages: Array<{ id: number; sessionId: string; channel: string; role: string; text: string; createdAt: string | null }>;
} {
  try {
    const sessions = db.select({
      id: chatbotSessions.id,
      channel: chatbotSessions.channel,
      startedAt: chatbotSessions.startedAt,
      lastMessageAt: chatbotSessions.lastMessageAt,
      personaName: chatbotSessions.personaName,
    }).from(chatbotSessions).where(eq(chatbotSessions.userId, userId)).all() as any[];
    const ids = sessions.map(s => s.id);
    if (ids.length === 0) return { sessions: [], messages: [] };
    const chMap = new Map<string, string>(sessions.map(s => [s.id, String(s.channel || "")]));
    const rows = db.select().from(chatbotMessages)
      .where(inArray(chatbotMessages.sessionId, ids))
      .orderBy(sql`${chatbotMessages.createdAt} ASC, ${chatbotMessages.id} ASC`)
      .all() as any[];
    const sliced = rows.slice(-limit);
    return {
      sessions: sessions.map(s => ({
        id: s.id,
        channel: String(s.channel || ""),
        startedAt: s.startedAt,
        lastMessageAt: s.lastMessageAt,
        personaName: s.personaName,
      })),
      messages: sliced.map(r => ({
        id: r.id,
        sessionId: r.sessionId,
        channel: chMap.get(r.sessionId) || "",
        role: r.role,
        text: String(r.text || ""),
        createdAt: r.createdAt,
      })),
    };
  } catch { return { sessions: [], messages: [] }; }
}
