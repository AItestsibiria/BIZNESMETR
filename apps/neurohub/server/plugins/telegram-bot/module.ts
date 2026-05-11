// v304 plugin: telegram-bot (Eugene 2026-05-10).
// Сервисный чат-бот @muziaipodari_bot. Получает Telegram updates через
// webhook, отвечает persona-репликами через Claude API, сохраняет в
// chatbot_sessions/messages для аналитики.
//
// Env:
//   TELEGRAM_BOT_TOKEN — токен бота (BotFather)
//   ANTHROPIC_API_KEY  — Claude API
//
// Endpoints:
//   POST /api/telegram/webhook  — приём update'ов от Telegram
//   POST /api/admin/telegram-bot/setup-webhook — admin-only установка
//     webhook URL (вызывает setWebhook к Telegram API)
//
// Persona: «Аня, 27 лет, support-агент MuziAi». Не AI, ассистент.
//
// Spec: Eugene «свяжи автора со всеми данными по mail, телефону, и tg;
// сервисный чат на MuziAi, привязать к базе знаний по продукту,
// автоматизация ответов, человек думает что общается с девушкой 25-30».

import { Router } from "express";
import { eq } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { db } from "../../storage";
import { chatbotSessions, chatbotMessages, users } from "@shared/schema";
import type { BootContext, Module } from "../../core";

const TELEGRAM_API = "https://api.telegram.org";
const TOKEN = () => process.env.TELEGRAM_BOT_TOKEN || "";
const ANTHROPIC_KEY = () => process.env.ANTHROPIC_API_KEY || "";

let bootRefs: { eventBus: BootContext["eventBus"]; logger: BootContext["logger"] } | null = null;

// === Telegram API helpers ===
async function tgApi(method: string, body: any): Promise<any> {
  const tok = TOKEN();
  if (!tok) throw new Error("TELEGRAM_BOT_TOKEN missing");
  const r = await fetch(`${TELEGRAM_API}/bot${tok}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(10_000),
  });
  if (!r.ok) {
    const t = await r.text().catch(() => "");
    throw new Error(`Telegram ${method} ${r.status}: ${t.slice(0, 200)}`);
  }
  return r.json().catch(() => null);
}

async function sendMessage(chatId: number | string, text: string): Promise<void> {
  try {
    await tgApi("sendMessage", {
      chat_id: chatId,
      text,
      parse_mode: "HTML",
      disable_web_page_preview: true,
    });
  } catch (e) {
    bootRefs?.logger.warn?.("[telegram-bot] sendMessage failed", { chatId, error: String(e) });
  }
}

// === Persona prompt + knowledge base ===
const PERSONA_SYSTEM = `Ты — Аня, 27 лет, support-агент сервиса MuziAi (muziai.ru). Дружелюбная, тёплая, профессиональная. Отвечаешь живо, на «ты» если юзер так пишет, иначе на «вы». Кратко (2-4 предложения для обычного вопроса). Эмодзи умеренно — 1-2 на сообщение.

База знаний MuziAi:
- Это российский AI-сервис генерации песен и музыки
- Цены: трек 299₽, текст песни 99₽, обработка 99₽, пакет 10 треков 2990₽
- 3 режима генерации:
  • 🎤 Аудио — наговори голосом идею, AI сам напишет текст и сгенерирует трек (самый быстрый)
  • 📄 Текст·Простой — опиши одной фразой что хочешь
  • ⚙ Текст·Расширенный — полный контроль: жанр, BPM, темп, lyrics, мульти-стиль
- Голос: мужской / женский / дуэт / инструментал
- Шаблоны «Музыкальные События»: свадьба, день рождения, корпоратив, гимн компании, и др.
- Авторизация: email/пароль, Telegram Login Widget, авто-привязка по chat_id
- Сайт: https://muziai.ru
- Поддержка: через этого бота @muziaipodari_bot

Стиль ответов:
- Не упоминай что ты AI или бот. Если спросят — представляйся Аней
- Если технический вопрос — отвечай конкретно
- Если проблема — сочувствуй, проси описать подробнее (трек id, экран, что нажимали)
- Если про деньги/возврат — поясни прайс, попроси email чтобы найти аккаунт
- Никогда не обещай скидки или акции которых нет
- Не выдавай админ-инфо (баланс GPTunnel, секреты, etc.)
- Всегда на русском`;

async function generateReply(userText: string, history: Array<{ role: "user" | "assistant"; content: string }>): Promise<string> {
  const key = ANTHROPIC_KEY();
  if (!key) {
    return "Здравствуйте! Я Аня из MuziAi 🎵 Скоро отвечу подробнее — небольшая задержка.";
  }
  try {
    const messages = [
      ...history.slice(-10), // last 10 для контекста
      { role: "user", content: userText },
    ];
    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": key,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: "claude-haiku-4-5-20251001",
        max_tokens: 400,
        system: PERSONA_SYSTEM,
        messages,
      }),
      signal: AbortSignal.timeout(20_000),
    });
    if (!r.ok) {
      const t = await r.text().catch(() => "");
      bootRefs?.logger.warn?.("[telegram-bot] anthropic non-ok", { status: r.status, body: t.slice(0, 200) });
      return "Здравствуйте! Я Аня 🎵 Чуть-чуть тормозит — попробуйте через минуту.";
    }
    const j: any = await r.json();
    const content = j?.content?.[0]?.text;
    if (typeof content === "string" && content.length > 0) {
      return content.slice(0, 3500);
    }
    return "Здравствуйте! Я Аня 🎵 Я тут — расскажите, чем помочь.";
  } catch (e) {
    bootRefs?.logger.warn?.("[telegram-bot] generateReply failed", { error: String(e) });
    return "Здравствуйте! Я Аня 🎵 Что-то сложно сейчас — попробуйте чуть позже.";
  }
}

// === Session helpers ===
function loadHistory(sessionId: string): Array<{ role: "user" | "assistant"; content: string }> {
  try {
    const rows = db.select().from(chatbotMessages).where(eq(chatbotMessages.sessionId, sessionId)).all() as any[];
    return rows.slice(-20).map(r => ({
      role: r.role === "user" ? "user" : "assistant",
      content: String(r.text || "").slice(0, 1500),
    }));
  } catch { return []; }
}

function findOrCreateSession(tgChatId: string, tgUserId: string): { sessionId: string; existingUserId: number | null } {
  let session: any = null;
  try {
    const rows = db.select().from(chatbotSessions).where(eq(chatbotSessions.externalId, tgChatId)).all() as any[];
    session = rows[0];
  } catch {}
  if (session) {
    return { sessionId: session.id, existingUserId: session.userId ?? null };
  }
  const sessionId = randomUUID();
  let linkedUserId: number | null = null;
  try {
    const u = db.select().from(users).where(eq(users.telegramId, tgUserId)).get() as any;
    if (u) linkedUserId = u.id;
  } catch {}
  try {
    db.insert(chatbotSessions).values({
      id: sessionId,
      channel: "telegram",
      externalId: tgChatId,
      userId: linkedUserId,
      state: "active",
      startedAt: new Date().toISOString(),
      lastMessageAt: new Date().toISOString(),
    }).run();
  } catch {}
  return { sessionId, existingUserId: linkedUserId };
}

function saveMessage(sessionId: string, role: "user" | "bot", text: string): void {
  try {
    db.insert(chatbotMessages).values({
      sessionId,
      role,
      text: text.slice(0, 3900),
      createdAt: new Date().toISOString(),
    }).run();
  } catch {}
}

// === Router ===
const router = Router();

// Telegram webhook — публичный (без auth). Telegram POSTит сюда updates.
router.post("/webhook", async (req, res) => {
  res.status(200).send("ok"); // Сразу отвечаем 200 чтобы Telegram не ретраил
  try {
    const update = req.body || {};
    const msg = update.message || update.edited_message;
    if (!msg || !msg.text || !msg.chat?.id) return;
    const chatId = String(msg.chat.id);
    const fromId = String(msg.from?.id || msg.chat.id);
    const text = String(msg.text || "").trim();
    if (!text) return;

    const { sessionId, existingUserId } = findOrCreateSession(chatId, fromId);

    // /start — приветственное сообщение
    if (text === "/start" || text === "/start@muziaipodari_bot") {
      const hello = existingUserId
        ? `С возвращением 🎵 Я Аня, помогу с MuziAi. Спрашивай что угодно.`
        : `Здравствуйте! Я Аня из MuziAi 🎵\nПомогу подобрать песню, расскажу про цены и возможности.\nСайт: https://muziai.ru\n\nЧто хотите создать?`;
      saveMessage(sessionId, "user", text);
      await sendMessage(chatId, hello);
      saveMessage(sessionId, "bot",hello);
      return;
    }

    saveMessage(sessionId, "user", text);
    const history = loadHistory(sessionId);
    const reply = await generateReply(text, history);
    await sendMessage(chatId, reply);
    saveMessage(sessionId, "bot",reply);
    bootRefs?.eventBus?.emit?.("chatbot.reply_sent", { channel: "telegram", sessionId, chatId }, "telegram-bot");
  } catch (e) {
    bootRefs?.logger.error?.("[telegram-bot] webhook error", { error: String(e) });
  }
});

// Admin: настройка webhook URL у Telegram (вызывать один раз после deploy).
// Защита: secret из env (CRON_SECRET или SESSION_SECRET).
// GET /api/telegram/setup-webhook?url=https://muziai.ru/api/telegram/webhook&secret=...
router.get("/setup-webhook", async (req, res) => {
  const secret = String(req.query.secret || "");
  const allowed = [process.env.CRON_SECRET, process.env.SESSION_SECRET].filter(Boolean) as string[];
  if (allowed.length === 0 || !allowed.includes(secret)) {
    return res.status(403).json({ ok: false, error: "secret required" });
  }
  if (!TOKEN()) {
    return res.status(400).json({ ok: false, error: "TELEGRAM_BOT_TOKEN missing" });
  }
  const url = String(req.query.url || "");
  if (!url || !url.startsWith("https://")) {
    return res.status(400).json({ ok: false, error: "url=https://... required" });
  }
  try {
    const r = await tgApi("setWebhook", {
      url,
      allowed_updates: ["message", "edited_message"],
      drop_pending_updates: true,
    });
    return res.json({ ok: true, telegram: r });
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e) });
  }
});

router.get("/info", async (_req, res) => {
  if (!TOKEN()) return res.json({ configured: false });
  try {
    const me = await tgApi("getMe", {});
    const wh = await tgApi("getWebhookInfo", {});
    return res.json({ configured: true, me, webhook: wh });
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e) });
  }
});

const telegramBotModule: Module = {
  name: "telegram-bot",
  version: "0.1.0",
  description: "Telegram bot @muziaipodari_bot — сервисный чат с persona-LLM. Без TELEGRAM_BOT_TOKEN в env плагин неактивен (endpoints отвечают 400).",
  publishes: ["chatbot.reply_sent"],
  routes: { prefix: "telegram", router },
  onLoad: async (ctx) => {
    bootRefs = { eventBus: ctx.eventBus, logger: ctx.logger };
    ctx.logger.info("telegram-bot online", {
      token: TOKEN() ? "configured" : "missing",
      anthropic: ANTHROPIC_KEY() ? "configured" : "missing",
    });
  },
  healthCheck: () => {
    return {
      status: TOKEN() ? "ok" : "degraded",
      details: { bot_token: !!TOKEN(), anthropic: !!ANTHROPIC_KEY() },
    };
  },
};

export default telegramBotModule;
