// v304 plugin: max-channel (Sprint 6 skeleton).
// Канал продаж через Max.ru. Принимает webhook'и от platform-api.max.ru,
// ведёт пользователя по FSM «menu → recording → review → payment → generating
// → done», шлёт ответы через POST /messages.
//
// Spec: docs/strategy/v304-max-channel-TZ.md
//
// SKELETON: реальный Suno-call, Whisper, Robokassa-bridge — добавляются
// в следующих коммитах когда Eugene даст BOT_TOKEN и решит вопросы §10.

import { Router } from "express";
import { sql, eq, and } from "drizzle-orm";
import * as crypto from "node:crypto";
import { db } from "../../storage";
import { chatbotSessions, leads } from "@shared/schema";
import type { BootContext, Module } from "../../core";

const MAX_API = "https://platform-api.max.ru";
const BOT_TOKEN = process.env.MAX_BOT_TOKEN || "";
const WEBHOOK_SECRET = process.env.MAX_WEBHOOK_SECRET || "";
const SUPPORT_USER_ID = process.env.MAX_SUPPORT_USER_ID || "7017236261"; // Eugene-канал

let bootRefs: { eventBus: BootContext["eventBus"]; logger: BootContext["logger"] } | null = null;

type FsmState = "menu" | "recording" | "review_lyrics" | "payment" | "generating" | "done" | "cancelled";

interface FsmData {
  templateSlug?: string;
  audioSha?: string;
  transcript?: string;
  lyrics?: string;
  paymentId?: number;
  generation1Id?: number;
  generation2Id?: number;
  attachmentId?: string;
}

// === HTTP helper к Max API ===
async function maxApi(method: "GET" | "POST", path: string, body?: any): Promise<any> {
  if (!BOT_TOKEN) throw new Error("MAX_BOT_TOKEN missing");
  const r = await fetch(`${MAX_API}${path}`, {
    method,
    headers: {
      Authorization: BOT_TOKEN,
      "Content-Type": "application/json",
    },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(10_000),
  });
  if (!r.ok) {
    const t = await r.text().catch(() => "");
    throw new Error(`MAX API ${path} returned ${r.status}: ${t.slice(0, 200)}`);
  }
  return r.json().catch(() => null);
}

async function sendMessage(chatId: string, text: string, buttons?: Array<{ text: string; payload: string }>) {
  const body: any = { text };
  if (buttons && buttons.length) {
    body.attachments = [{
      type: "inline_keyboard",
      payload: { buttons: [buttons.map((b) => ({ type: "callback", text: b.text, payload: b.payload }))] },
    }];
  }
  return maxApi("POST", `/messages?chat_id=${encodeURIComponent(chatId)}`, body);
}

// === FSM (raw SQL под реальную схему: id=TEXT uuid, fsm_state, fsm_data) ===
type SessionRow = {
  id: string; channel: string; externalId: string | null;
  maxChatId: string | null; fsmState: string | null; fsmData: string | null;
};

function loadSession(maxUserId: string): SessionRow | null {
  const row = db.get<SessionRow>(
    sql`SELECT id, channel, external_id as externalId,
               max_chat_id as maxChatId, fsm_state as fsmState, fsm_data as fsmData
        FROM chatbot_sessions
        WHERE channel = 'max' AND external_id = ${maxUserId}
        LIMIT 1`,
  );
  return row ?? null;
}

function createSession(maxUserId: string, maxChatId: string): SessionRow {
  const id = crypto.randomUUID();
  db.run(sql`INSERT INTO chatbot_sessions (id, channel, external_id, max_chat_id, fsm_state, fsm_data)
             VALUES (${id}, 'max', ${maxUserId}, ${maxChatId}, 'menu', '{}')`);
  return { id, channel: "max", externalId: maxUserId, maxChatId, fsmState: "menu", fsmData: "{}" };
}

function updateState(id: string, fsm: FsmState, data: FsmData, maxChatId: string) {
  db.run(sql`UPDATE chatbot_sessions
             SET fsm_state = ${fsm}, fsm_data = ${JSON.stringify(data)},
                 max_chat_id = ${maxChatId}, last_message_at = CURRENT_TIMESTAMP
             WHERE id = ${id}`);
}

function logMsg(sessionId: string, role: "user" | "bot" | "system", text: string) {
  try {
    db.run(sql`INSERT INTO chatbot_messages (session_id, role, text)
               VALUES (${sessionId}, ${role}, ${text.slice(0, 4000)})`);
  } catch (e) {
    bootRefs?.logger.error("max-channel logMsg failed", { error: e instanceof Error ? e.message : String(e) });
  }
}

// === Меню шаблонов ===
const MENU_OPTIONS = [
  { slug: "birthday", label: "🎂 Поздравление", price: 399 },
  { slug: "wedding",  label: "💍 Свадебная", price: 399 },
  { slug: "corporate-anthem", label: "💼 Корпоратив", price: 999 },
  { slug: "first-date", label: "💛 Признание", price: 399 },
];

async function showMenu(chatId: string) {
  const txt = "Привет! Я создам песню по вашему запросу. Выберите тип:";
  const buttons = MENU_OPTIONS.map((o) => ({ text: `${o.label} · ${o.price}₽`, payload: `pick:${o.slug}` }));
  buttons.push({ text: "🎼 Все шаблоны", payload: "menu:all" });
  await sendMessage(chatId, txt, buttons);
}

// === Webhook handler ===
const router = Router();

router.post("/webhook", async (req, res) => {
  // Verify secret (если задан)
  // BACKEND-13 fix Eugene 14:27: timing-safe + REQUIRED webhook secret
  // (раньше при пустом WEBHOOK_SECRET принимали всё подряд → fraud).
  const got = String(req.headers["x-max-bot-api-secret"] || "");
  if (!WEBHOOK_SECRET) {
    bootRefs?.logger.warn("max-webhook: MAX_WEBHOOK_SECRET не задан — webhook отвергнут");
    return res.status(401).json({ error: "MAX_WEBHOOK_SECRET not configured" });
  }
  const ok = got.length === WEBHOOK_SECRET.length && (() => {
    try { return crypto.timingSafeEqual(Buffer.from(got, "utf8"), Buffer.from(WEBHOOK_SECRET, "utf8")); }
    catch { return false; }
  })();
  if (!ok) {
    return res.status(401).json({ error: "bad secret" });
  }

  const u = req.body;
  if (!u || typeof u !== "object") return res.json({ ok: true });

  const updateType = u.update_type;
  const chatId = String(u.chat_id ?? u.chat?.chat_id ?? "");
  const userId = String(u.user?.user_id ?? u.from?.user_id ?? "");
  const messageText: string = u.message?.body?.text ?? u.text ?? "";
  const callback: string = u.callback?.payload ?? u.payload ?? "";
  const attachment = u.message?.body?.attachments?.find((a: any) => a.type === "audio") ?? null;

  if (!chatId || !userId) {
    bootRefs?.logger.warn("max-webhook: missing chatId/userId", { update: u });
    return res.json({ ok: true });
  }

  bootRefs?.logger.info("max-webhook", { updateType, userId, chatId, hasAttachment: !!attachment });

  // Получаем или создаём сессию
  let session = loadSession(userId);
  if (!session) {
    session = createSession(userId, chatId);
    // Lead в leads — лучше сделать idempotent INSERT
    try {
      db.run(sql`INSERT OR IGNORE INTO leads (email, name, source, status, meta)
                 VALUES (${`max:${userId}`}, ${u.user?.name ?? null}, 'max', 'new',
                         ${JSON.stringify({ maxUserId: userId, maxUsername: u.user?.username })})`);
    } catch {}
  }

  const fsm: FsmState = (session.fsmState as FsmState) ?? "menu";
  const data: FsmData = (() => {
    try { return JSON.parse(session.fsmData || "{}"); } catch { return {}; }
  })();

  logMsg(session.id, "user", callback ? `[callback] ${callback}` : (messageText || "[empty]"));

  try {
    if (updateType === "bot_started" || messageText === "/start") {
      updateState(session.id, "menu", {}, chatId);
      await showMenu(chatId);
    } else if (callback.startsWith("pick:")) {
      const slug = callback.slice(5);
      updateState(session.id, "recording", { templateSlug: slug }, chatId);
      await sendMessage(chatId, "Запишите голосовое сообщение (до 3 мин): кому/о чём песня, имя адресата, повод, особенности.");
    } else if (fsm === "recording" && attachment) {
      // Принимаем audio. SKELETON: download + transcribe + rewrite — в Sprint 6.2.
      data.attachmentId = attachment.payload?.media_id ?? attachment.id;
      updateState(session.id, "review_lyrics", data, chatId);
      await sendMessage(
        chatId,
        "🎙 Получил аудио. Сейчас перепишу в текст песни… (15-30 сек)\n\n[skeleton: реальный Whisper и rewrite будут в следующем релизе]",
      );
      // TODO Sprint 6.2: Whisper + LLM-rewrite + showLyrics(chatId, lyrics, [«Да», «Переделать», «Отменить»])
    } else if (callback === "lyrics:approve" && fsm === "review_lyrics") {
      updateState(session.id, "payment", data, chatId);
      await sendMessage(chatId, "Оплати 299₽ → нажми кнопку ниже:", [
        { text: "💳 Оплатить через Robokassa", payload: "pay:start" },
      ]);
      // TODO Sprint 6.3: создать payment record + return Robokassa URL
    } else if (callback === "lyrics:retry" && fsm === "review_lyrics") {
      // TODO Sprint 6.2: regenerate lyrics with different prompt
      await sendMessage(chatId, "Перепишу другой вариант… [skeleton]");
    } else if (callback === "cancel") {
      updateState(session.id, "cancelled", data, chatId);
      await sendMessage(chatId, "Заказ отменён. Жми /start чтобы начать заново.");
    } else if (messageText) {
      // Свободный текст в любом состоянии — fallback
      await sendMessage(chatId, "Не понял команду. Жми /start для начала или используй кнопки.");
    }
  } catch (err) {
    const e = err instanceof Error ? err.message : String(err);
    bootRefs?.logger.error("max-fsm error", { error: e, fsm, userId });
    logMsg(session.id, "system", `[error] ${e}`);
    try {
      await sendMessage(chatId, "Что-то сломалось у меня. Попробуй /start ещё раз.");
    } catch {}
  }

  res.json({ ok: true });
});

router.get("/health", (_req, res) => {
  res.json({
    data: {
      botToken: BOT_TOKEN ? `present (${BOT_TOKEN.length} chars)` : "MISSING",
      webhookSecret: WEBHOOK_SECRET ? "present" : "MISSING",
      activeSessions: db.select({ c: sql<number>`count(*)` }).from(chatbotSessions).where(eq(chatbotSessions.channel, "max")).get()?.c ?? 0,
    },
    error: null,
  });
});

const maxChannelModule: Module = {
  name: "max-channel",
  version: "0.1.0",
  description: "Sprint 6 skeleton — Max.ru sales channel: webhook + FSM + sessions. Suno/Whisper/Robokassa в следующих релизах.",
  routes: { prefix: "max", router },
  publishes: ["max.session.created", "max.payment.completed"],
  subscribes: {
    "payment.completed": async (event, _ctx) => {
      // TODO Sprint 6.3: link to max-session via payment.metadata.sessionId
      const p = event.payload as any;
      if (p?.source !== "max" || !p?.sessionId) return;
      // Транзит: запустить 2 generation, обновить session state
    },
  },
  onLoad: async (ctx) => {
    bootRefs = { eventBus: ctx.eventBus, logger: ctx.logger };
    if (!BOT_TOKEN) {
      ctx.logger.warn("max-channel: MAX_BOT_TOKEN missing — webhook будет принимать но не сможет ответить");
    } else {
      ctx.logger.info("max-channel online — webhook /api/max/webhook");
    }
  },
  healthCheck: () => {
    if (!BOT_TOKEN) return { status: "degraded", details: { reason: "MAX_BOT_TOKEN missing — set in .env" } };
    return { status: "ok", details: { botTokenLen: BOT_TOKEN.length } };
  },
};

export default maxChannelModule;
