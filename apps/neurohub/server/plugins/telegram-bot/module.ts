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
import * as fs from "node:fs";
import * as path from "node:path";
import { db } from "../../storage";
import { chatbotSessions, chatbotMessages, users } from "@shared/schema";
import type { BootContext, Module } from "../../core";

// Knowledge base — читаем из docs/strategy/KNOWLEDGE-BASE-BOT.md
// Eugene 2026-05-11: «помощник собирает базу знаний, обновляется когда
// меняем функции». Файл коммитится с любыми изменениями цен/режимов/
// шаблонов. Бот reload'ит по запросу /bot-kb/reload или на старте.
let kbCache: { text: string; mtime: number } = { text: "", mtime: 0 };
function kbPath(): string | null {
  for (const p of [
    "/opt/muziai-src/docs/strategy/KNOWLEDGE-BASE-BOT.md",
    "/var/www/neurohub/docs/strategy/KNOWLEDGE-BASE-BOT.md",
    path.join(process.cwd(), "docs/strategy/KNOWLEDGE-BASE-BOT.md"),
    path.join(process.cwd(), "../../docs/strategy/KNOWLEDGE-BASE-BOT.md"),
  ]) {
    try { if (fs.existsSync(p)) return p; } catch {}
  }
  return null;
}
function loadKB(force = false): string {
  const p = kbPath();
  if (!p) return "";
  try {
    const stat = fs.statSync(p);
    if (!force && kbCache.text && stat.mtimeMs === kbCache.mtime) return kbCache.text;
    const text = fs.readFileSync(p, "utf-8");
    kbCache = { text, mtime: stat.mtimeMs };
    return text;
  } catch { return kbCache.text || ""; }
}

const TELEGRAM_API = "https://api.telegram.org";
const TOKEN = () => process.env.TELEGRAM_BOT_TOKEN || "";
// Eugene 2026-05-10: отдельный bot-ключ Claude (fallback на главный).
// Преимущества: раздельная аналитика расходов, разная модель (haiku
// дешёвый), независимая ротация если бот зашумит.
const ANTHROPIC_KEY = () => process.env.ANTHROPIC_API_KEY_BOT || process.env.ANTHROPIC_API_KEY || "";

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

// === Persona по hash(userId) (Eugene 2026-05-11) ===
// Каждый юзер видит свою постоянную «куратор-девушку» — стабильно
// от первого сообщения до последнего. Разные юзеры — разные имена.
const PERSONAS: Array<{ name: string; age: number; gender: "ж"; tone: string }> = [
  { name: "Аня",     age: 27, gender: "ж", tone: "тёплая, заботливая, эмпатичная" },
  { name: "Татьяна", age: 29, gender: "ж", tone: "энергичная, дружелюбная, с лёгким юмором" },
  { name: "Мария",   age: 28, gender: "ж", tone: "вежливая, профессиональная, аккуратная" },
  { name: "Ольга",   age: 30, gender: "ж", tone: "спокойная, внимательная, доброжелательная" },
];
function personaFor(userKey: string) {
  let h = 0;
  const s = String(userKey || "anon");
  for (let i = 0; i < s.length; i++) h = ((h << 5) - h + s.charCodeAt(i)) | 0;
  return PERSONAS[Math.abs(h) % PERSONAS.length];
}

function buildPersonaSystem(userKey: string): string {
  const p = personaFor(userKey);
  const greetingExample = p.gender === "м" ? `Готов помочь` : `Готова помочь`;
  const kb = loadKB() || "[база знаний временно недоступна — отвечай вежливо, спроси email/детали]";
  return `Ты — ${p.name}, ${p.age} лет, support-агент сервиса MuziAi (muziai.ru). ${p.tone}. Отвечаешь живо, на «ты» если юзер так пишет, иначе на «вы». Кратко (2-4 предложения для обычного вопроса). Эмодзи умеренно — 1-2 на сообщение. ${greetingExample}.

ВАЖНО: ниже актуальная база знаний по продукту. Опирайся только на неё — не выдумывай факты, цены, шаблоны. Если в базе нет ответа — честно скажи «уточню у команды и вернусь».

---ACTUAL_KNOWLEDGE_BASE---
${kb}
---END_KB---

Говори живо, как живой человек, не как AI. Не используй markdown-списки (•, **, ##) — это чат, не документация.`;
}

// Backup-LLM (Eugene 2026-05-11): Claude primary, OpenAI fallback.
// Если Claude недоступен — переключаемся на OpenAI с тем же prompt'ом
// и историей. Юзер ничего не замечает.
async function tryClaude(system: string, text: string, history: Array<{ role: string; content: string }>): Promise<string | null> {
  const key = ANTHROPIC_KEY();
  if (!key) return null;
  try {
    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "x-api-key": key, "anthropic-version": "2023-06-01", "content-type": "application/json" },
      body: JSON.stringify({
        model: "claude-haiku-4-5-20251001",
        max_tokens: 400,
        system,
        messages: [...history.slice(-10), { role: "user", content: text }],
      }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!r.ok) {
      bootRefs?.logger.warn?.("[telegram-bot] claude non-ok", { status: r.status });
      return null;
    }
    const j: any = await r.json();
    const c = j?.content?.[0]?.text;
    return typeof c === "string" && c.length > 0 ? c.slice(0, 3500) : null;
  } catch (e) {
    bootRefs?.logger.warn?.("[telegram-bot] claude error", { error: String(e) });
    return null;
  }
}

async function tryOpenAI(system: string, text: string, history: Array<{ role: string; content: string }>): Promise<string | null> {
  const key = process.env.OPENAI_API_KEY || "";
  if (!key) return null;
  try {
    const msgs = [
      { role: "system", content: system },
      ...history.slice(-10).map(m => ({ role: m.role === "assistant" ? "assistant" : "user", content: m.content })),
      { role: "user", content: text },
    ];
    const r = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: { "Authorization": `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({ model: "gpt-4o-mini", max_tokens: 400, messages: msgs }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!r.ok) {
      bootRefs?.logger.warn?.("[telegram-bot] openai non-ok", { status: r.status });
      return null;
    }
    const j: any = await r.json();
    const c = j?.choices?.[0]?.message?.content;
    return typeof c === "string" && c.length > 0 ? c.slice(0, 3500) : null;
  } catch (e) {
    bootRefs?.logger.warn?.("[telegram-bot] openai error", { error: String(e) });
    return null;
  }
}

async function generateReply(userKey: string, userText: string, history: Array<{ role: "user" | "assistant"; content: string }>): Promise<string> {
  const system = buildPersonaSystem(userKey);
  // 1. Primary: Claude
  const c = await tryClaude(system, userText, history);
  if (c) return c;
  // 2. Backup: OpenAI
  const o = await tryOpenAI(system, userText, history);
  if (o) return o;
  // 3. Both failed → fallback hardcoded
  return `Здравствуйте! Я ${personaFor(userKey).name} 🎵 Чуть-чуть тормозит — попробуйте через минуту.`;
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
      const p = personaFor(fromId);
      const hello = existingUserId
        ? `С возвращением 🎵 Я ${p.name}, помогу с MuziAi. Спрашивай что угодно.`
        : `Здравствуйте! Я ${p.name} из MuziAi 🎵\nПомогу подобрать песню, расскажу про цены и возможности.\nСайт: https://muziai.ru\n\nЧто хотите создать?`;
      saveMessage(sessionId, "user", text);
      await sendMessage(chatId, hello);
      saveMessage(sessionId, "bot",hello);
      return;
    }

    saveMessage(sessionId, "user", text);
    const history = loadHistory(sessionId);
    const reply = await generateReply(fromId, text, history);
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

// Reload knowledge base (без рестарта pm2). Защищено secret.
router.get("/kb/reload", (req, res) => {
  const secret = String(req.query.secret || "");
  const allowed = [process.env.CRON_SECRET, process.env.SESSION_SECRET].filter(Boolean) as string[];
  if (allowed.length === 0 || !allowed.includes(secret)) {
    return res.status(403).json({ ok: false, error: "secret required" });
  }
  const text = loadKB(true);
  res.json({ ok: !!text, length: text.length, path: kbPath() });
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
    const kb = loadKB(true);
    ctx.logger.info("telegram-bot online", {
      token: TOKEN() ? "configured" : "missing",
      anthropic: ANTHROPIC_KEY() ? "configured" : "missing",
      openai_fallback: !!process.env.OPENAI_API_KEY,
      kb_loaded: kb.length > 0 ? `${kb.length} chars` : "missing",
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
