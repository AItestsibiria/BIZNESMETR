// v304 plugin: chatbot (Sprint 6 skeleton).
//
// Endpoint: POST /api/chat/message  { sessionId?, text, channel? }
//   - Если sessionId не передан, создаёт новую chatbot_session.
//   - Сохраняет реплику пользователя в chatbot_messages.
//   - Если в env есть LLM_PROVIDER + ключ — вызывает router (когда
//     добавим). Иначе — детерминированный echo с базовыми intent-rules.
//   - Эмитит 'chatbot.message_received' и 'chatbot.reply_sent'.
//
// Полный ConductorBot (распознавание intent через LLM, эскалация на
// human, FAQ-ретривал, tool-calling) добавится когда придут
// LLM_PROVIDER / LLM_MODEL + ключи.
//
// Spec: docs/strategy/original/04 §1-§4.

import { Router } from "express";
import { eq, desc } from "drizzle-orm";
import { z } from "zod";
import { randomUUID } from "node:crypto";
import { db } from "../../storage";
import { chatbotSessions, chatbotMessages } from "@shared/schema";
import type { BootContext, Module } from "../../core";

const MessageSchema = z.object({
  sessionId: z.string().uuid().optional(),
  channel: z.enum(["web", "telegram", "vk", "email"]).default("web"),
  externalId: z.string().max(128).optional(),
  text: z.string().min(1).max(4000),
});

let bootRefs: { eventBus: BootContext["eventBus"]; logger: BootContext["logger"] } | null = null;

const LLM_PROVIDER = process.env.LLM_PROVIDER || "";
const LLM_MODEL = process.env.LLM_MODEL || "";

function detectIntent(text: string): string {
  const lower = text.toLowerCase();
  if (/(привет|здравств|добр(ый|ое))/.test(lower)) return "greeting";
  if (/(цена|стоимост|сколько стоит|тариф)/.test(lower)) return "pricing";
  if (/(оплат|карт|банк|перевод)/.test(lower)) return "payment";
  if (/(не работ|ошибк|пробл|сломал|упал)/.test(lower)) return "support";
  if (/(песн|трек|свадь|подар|корпорат)/.test(lower)) return "sales";
  return "other";
}

function defaultReply(text: string, intent: string): string {
  const lines: Record<string, string> = {
    greeting: "Привет! Я бот MuzaAI. Помогу подобрать песню. Чем могу помочь?",
    pricing:
      "Текст песни — 99 ₽. Трек — 299 ₽. Обработка — 99 ₽. Пакет «10 генераций» — 2 990 ₽.",
    payment: "Принимаем картой через Robokassa. Для юрлиц — банковский перевод.",
    support:
      "Опиши, пожалуйста, что не сработало — и в каком разделе. Скоро подключу человека-оператора.",
    sales:
      "Расскажи, для кого песня и какой повод (свадьба, день рождения, корпоратив). Подберу шаблон и пример.",
    other:
      "Я ещё учусь — пока могу помочь по тарифам, оплатам и подбору шаблонов. Уточни, что именно интересует.",
  };
  return lines[intent] ?? lines.other;
}

const router = Router();

router.post("/message", async (req, res) => {
  const parsed = MessageSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ data: null, error: parsed.error.issues[0]?.message ?? "invalid" });
  }

  const { sessionId: requestedSessionId, channel, externalId, text } = parsed.data;
  let sessionId = requestedSessionId;

  // 1. Сессия — найти или создать
  if (sessionId) {
    const exists = db.select().from(chatbotSessions).where(eq(chatbotSessions.id, sessionId)).get();
    if (!exists) sessionId = undefined;
  }
  if (!sessionId) {
    sessionId = randomUUID();
    const userId = (req as any)?.session?.passport?.user ?? null;
    db.insert(chatbotSessions)
      .values({
        id: sessionId,
        channel,
        externalId: externalId ?? null,
        userId,
        leadId: null,
        state: "active",
      })
      .run();
  } else {
    db.update(chatbotSessions)
      .set({ lastMessageAt: new Date().toISOString() })
      .where(eq(chatbotSessions.id, sessionId))
      .run();
  }

  // 2. Сохранить user-реплику
  db.insert(chatbotMessages)
    .values({ sessionId, role: "user", text })
    .run();

  await bootRefs?.eventBus.emit(
    "chatbot.message_received",
    { sessionId, channel, text, intent: detectIntent(text) },
    "chatbot",
  );

  // 3. Сгенерировать ответ — LLM-router если настроен, иначе fallback
  const intent = detectIntent(text);
  let reply: string;
  if (LLM_PROVIDER && LLM_MODEL) {
    // TODO Sprint 6.1: вызов через GPTunnel/OpenAI router. Пока fallback.
    reply = defaultReply(text, intent);
  } else {
    reply = defaultReply(text, intent);
  }

  // 4. Сохранить bot-реплику + обновить intent если новый
  db.update(chatbotSessions)
    .set({ intent, lastMessageAt: new Date().toISOString() })
    .where(eq(chatbotSessions.id, sessionId))
    .run();
  db.insert(chatbotMessages)
    .values({ sessionId, role: "bot", text: reply })
    .run();

  await bootRefs?.eventBus.emit(
    "chatbot.reply_sent",
    { sessionId, intent, replyLength: reply.length },
    "chatbot",
  );

  res.json({ data: { sessionId, reply, intent }, error: null });
});

router.get("/session/:id", (req, res) => {
  const id = String(req.params.id);
  const session = db.select().from(chatbotSessions).where(eq(chatbotSessions.id, id)).get();
  if (!session) return res.status(404).json({ data: null, error: "session not found" });

  const messages = db
    .select()
    .from(chatbotMessages)
    .where(eq(chatbotMessages.sessionId, id))
    .orderBy(desc(chatbotMessages.id))
    .limit(50)
    .all();

  res.json({ data: { session, messages: messages.reverse() }, error: null });
});

const chatbotModule: Module = {
  name: "chatbot",
  version: "0.1.0",
  description: "Sprint 6 skeleton — accepts messages, intent-detects, replies (fallback or LLM).",
  routes: { prefix: "chat", router },
  publishes: ["chatbot.message_received", "chatbot.reply_sent", "chatbot.escalated"],
  onLoad: async (ctx) => {
    bootRefs = { eventBus: ctx.eventBus, logger: ctx.logger };
    ctx.logger.info("chatbot online", {
      llm: LLM_PROVIDER && LLM_MODEL ? `${LLM_PROVIDER}/${LLM_MODEL}` : "fallback-only",
    });
  },
  healthCheck: () => ({
    status: "ok",
    details: { llm_configured: !!(LLM_PROVIDER && LLM_MODEL) },
  }),
};

export default chatbotModule;
