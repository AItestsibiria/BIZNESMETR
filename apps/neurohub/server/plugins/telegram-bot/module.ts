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
import { confirmNonce as confirmTgLoginNonce, hasValidNonce as hasTgLoginNonce } from "../../lib/tgLoginNonces";
import { personaFor, loadKB, buildPersonaSystem, kbPath } from "../../lib/consultantPersona";

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

async function sendMessage(chatId: number | string, text: string, replyMarkup?: any): Promise<void> {
  try {
    const body: any = {
      chat_id: chatId,
      text,
      parse_mode: "HTML",
      disable_web_page_preview: true,
    };
    if (replyMarkup) body.reply_markup = replyMarkup;
    await tgApi("sendMessage", body);
  } catch (e) {
    bootRefs?.logger.warn?.("[telegram-bot] sendMessage failed", { chatId, error: String(e) });
  }
}

// Eugene 2026-05-11: образ помощника на первом /start — фото с
// silhouette певицы (тот же образ что floating-consultant на сайте).
// Telegram кэширует фото после первой отправки — последующие отправки
// мгновенные. Базовый URL — PUBLIC_BASE_URL или muziai.ru.
async function sendConsultantPhoto(chatId: number | string, caption: string, replyMarkup?: any): Promise<void> {
  try {
    const base = process.env.PUBLIC_BASE_URL || "https://muziai.ru";
    // Прямая static PNG через nginx — нет зависимости от sharp/cwd
    // на prod (Eugene 2026-05-11: «нет в чате картинки»).
    const photoUrl = `${base}/consultant-avatar.png`;
    const body: any = {
      chat_id: chatId,
      photo: photoUrl,
      caption,
      parse_mode: "HTML",
    };
    if (replyMarkup) body.reply_markup = replyMarkup;
    await tgApi("sendPhoto", body);
  } catch (e) {
    bootRefs?.logger.warn?.("[telegram-bot] sendPhoto failed, fallback to text", { chatId, error: String(e) });
    // Fallback на текст если sendPhoto не сработал
    await sendMessage(chatId, caption, replyMarkup);
  }
}

// Меню действий на /start — InlineKeyboard для быстрого выбора.
const STARTUP_KEYBOARD = {
  inline_keyboard: [
    [
      { text: "🎵 Послушать треки", url: "https://muziai.ru/" },
      { text: "🆕 Регистрация (1 трек в подарок)", url: "https://muziai.ru/#/register" },
    ],
    [
      { text: "💬 Задать вопрос", callback_data: "menu_support" },
      { text: "🎉 Под событие", callback_data: "menu_event" },
    ],
    [
      { text: "💼 Сотрудничество", callback_data: "menu_b2b" },
    ],
  ],
};

// Persona, KB, prompt — теперь в shared lib (lib/consultantPersona.ts).
// Используется обоими ботами (telegram + max) — единый tone + playbook.

// Backup-LLM (Eugene 2026-05-11): Claude primary, OpenAI fallback.
// Если Claude недоступен — переключаемся на OpenAI с тем же prompt'ом
// и историей. Юзер ничего не замечает.
async function tryClaude(system: string, text: string, history: Array<{ role: string; content: string }>): Promise<string | null> {
  const key = ANTHROPIC_KEY();
  if (!key) return null;
  try {
    // Eugene 2026-05-11: скорость + prompt caching. System prompt стабильный
    // (persona+KB, ~5K токенов) — кэшируем на 5 минут через cache_control.
    // Это даёт ~85% latency-снижение и ~90% скидку cost на cached токены.
    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": key,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: "claude-haiku-4-5-20251001",
        max_tokens: 250,
        system: [
          { type: "text", text: system, cache_control: { type: "ephemeral" } },
        ],
        messages: [...history.slice(-8), { role: "user", content: text }],
      }),
      signal: AbortSignal.timeout(12_000),
    });
    if (!r.ok) {
      bootRefs?.logger.warn?.("[telegram-bot] claude non-ok", { status: r.status });
      return null;
    }
    const j: any = await r.json();
    const c = j?.content?.[0]?.text;
    return typeof c === "string" && c.length > 0 ? c.slice(0, 2500) : null;
  } catch (e) {
    bootRefs?.logger.warn?.("[telegram-bot] claude error", { error: String(e) });
    return null;
  }
}

// Backup через GPTunnel (Eugene 2026-05-11 «2» — использовать GPTunnel
// вместо native OpenAI). GPTunnel поддерживает OpenAI-compatible API,
// тот же кошелёк что у Suno.
async function tryGPTunnel(system: string, text: string, history: Array<{ role: string; content: string }>): Promise<string | null> {
  const key = process.env.GPTUNNEL_API_KEY || "";
  if (!key) return null;
  try {
    const msgs = [
      { role: "system", content: system },
      ...history.slice(-10).map(m => ({ role: m.role === "assistant" ? "assistant" : "user", content: m.content })),
      { role: "user", content: text },
    ];
    const r = await fetch("https://gptunnel.ru/v1/chat/completions", {
      method: "POST",
      headers: { "Authorization": key, "Content-Type": "application/json" },
      body: JSON.stringify({ model: "gpt-4o-mini", max_tokens: 400, messages: msgs }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!r.ok) {
      bootRefs?.logger.warn?.("[telegram-bot] gptunnel non-ok", { status: r.status });
      return null;
    }
    const j: any = await r.json();
    const c = j?.choices?.[0]?.message?.content;
    return typeof c === "string" && c.length > 0 ? c.slice(0, 3500) : null;
  } catch (e) {
    bootRefs?.logger.warn?.("[telegram-bot] gptunnel error", { error: String(e) });
    return null;
  }
}

async function generateReply(
  userKey: string,
  userText: string,
  history: Array<{ role: "user" | "assistant"; content: string }>,
  extraSystem = ""
): Promise<string> {
  const system = buildPersonaSystem(userKey) + extraSystem;
  // 1. Primary: Claude
  const c = await tryClaude(system, userText, history);
  if (c) return c;
  // 2. Backup: GPTunnel (OpenAI-compatible, тот же кошелёк что у Suno)
  const o = await tryGPTunnel(system, userText, history);
  if (o) return o;
  // 3. Both failed → fallback hardcoded
  return `Здравствуйте! Я ${personaFor(userKey).name} 🎵 Чуть-чуть тормозит — попробуйте через минуту.`;
}

// Lead extraction (Eugene 2026-05-11): извлекаем профиль юзера из истории.
// JSON: {name, age, city, occasion, target, mood, interests, notes}.
// Fire-and-forget после каждого ответа (если history.length >= 3).
async function updateUserProfile(sessionId: string, history: Array<{ role: string; content: string }>): Promise<void> {
  const key = ANTHROPIC_KEY();
  if (!key || history.length < 3) return;
  try {
    const transcript = history.slice(-20).map(m => `${m.role === "user" ? "Юзер" : "Бот"}: ${m.content}`).join("\n");
    const extractSystem = `Извлеки из диалога профиль юзера и верни СТРОГО JSON без пояснений:
{"name": "имя или null", "age": "возраст число или null", "city": "город или null", "occasion": "повод для песни или null", "target": "для кого песня (жена/мама/друг/коллега…) или null", "mood": "желаемое настроение или null", "interests": "любимые жанры или null", "notes": "важные детали 1-2 фразы или null"}
Если данных нет — null. Не выдумывай. Только то что юзер явно сказал.`;
    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "x-api-key": key, "anthropic-version": "2023-06-01", "content-type": "application/json" },
      body: JSON.stringify({
        model: "claude-haiku-4-5-20251001",
        max_tokens: 300,
        system: extractSystem,
        messages: [{ role: "user", content: transcript }],
      }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!r.ok) return;
    const j: any = await r.json();
    const raw = j?.content?.[0]?.text || "";
    // Удалить markdown-обёртку если есть
    const jsonStr = raw.replace(/^```(?:json)?\s*/, "").replace(/\s*```$/, "").trim();
    const profile = JSON.parse(jsonStr);
    if (typeof profile !== "object" || !profile) return;
    db.update(chatbotSessions).set({ userProfile: JSON.stringify(profile) }).where(eq(chatbotSessions.id, sessionId)).run();
  } catch {}
}

function loadUserProfile(sessionId: string): any {
  try {
    const row = db.select().from(chatbotSessions).where(eq(chatbotSessions.id, sessionId)).get() as any;
    if (!row?.userProfile) return null;
    return JSON.parse(row.userProfile);
  } catch { return null; }
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

    // Callback queries (нажатие на InlineKeyboard кнопку)
    if (update.callback_query) {
      const cq = update.callback_query;
      const chatId = String(cq.message?.chat?.id || "");
      const fromId = String(cq.from?.id || "");
      const data = String(cq.data || "");
      try { await tgApi("answerCallbackQuery", { callback_query_id: cq.id }); } catch {}
      if (!chatId) return;
      const p = personaFor(fromId);
      const responses: Record<string, string> = {
        menu_support: `Расскажите подробнее — что случилось, на каком этапе? Если есть номер трека или скриншот — присылайте, разберёмся.`,
        menu_event: `Здорово! А под какое событие — свадьба, день рождения, юбилей, корпоратив? И какой у вас есть текст или идея?\n\nЕсть готовые шаблоны: https://muziai.ru/#/templates`,
        menu_b2b: `Сотрудничество — это интересно. Расскажите, какой формат: подкаст, реклама, B2B-лицензия треков, что-то ещё? Мы откликнемся в течение дня.`,
      };
      const reply = responses[data] || `Открыть на сайте: https://muziai.ru/`;
      const { sessionId } = findOrCreateSession(chatId, fromId);
      saveMessage(sessionId, "user", `[кнопка] ${data}`);
      const fullReply = `${reply}\n\n— ${p.name}`;
      await sendMessage(chatId, fullReply);
      saveMessage(sessionId, "bot", fullReply);
      return;
    }

    const msg = update.message || update.edited_message;
    if (!msg || !msg.text || !msg.chat?.id) return;
    const chatId = String(msg.chat.id);
    const fromId = String(msg.from?.id || msg.chat.id);
    const text = String(msg.text || "").trim();
    if (!text) return;

    const { sessionId, existingUserId } = findOrCreateSession(chatId, fromId);

    // Authorization (Eugene 2026-05-11): /start login_<nonce>.
    // Сайт сгенерировал nonce, дал юзеру ссылку
    // t.me/Muziaipodari_bot?start=login_<nonce>. Бот шлёт inline-кнопку
    // с login_url, Telegram сам подпишет данные bot-токеном и редиректит
    // юзера на /api/auth/telegram-loginurl — это полноценная OAuth-цепочка
    // идентичная Login Widget'у (depлекейтнутому).
    //
    // Fallback: одновременно подтверждаем nonce через bot-side (с tgUserId
    // из webhook). Если по какой-то причине login_url не отработает,
    // polling всё равно залогинит юзера через bot-confirmed flow.
    const loginMatch = text.match(/^\/start\s+login_([a-f0-9]{16,64})$/);
    if (loginMatch) {
      const nonce = loginMatch[1];
      saveMessage(sessionId, "user", `[auth ${nonce.slice(0, 8)}…]`);
      const p = personaFor(fromId);
      const valid = hasTgLoginNonce(nonce);
      if (!valid) {
        const failText = `${p.avatar} Ссылка устарела или уже использована. Открой страницу входа на сайте заново и нажми кнопку.`;
        await sendMessage(chatId, failText);
        saveMessage(sessionId, "bot", failText);
        return;
      }

      // Fallback подтверждение nonce — если юзер не нажмёт login_url
      // кнопку, через polling всё равно залогинится по webhook'у.
      confirmTgLoginNonce(nonce, {
        id: fromId,
        first_name: msg.from?.first_name,
        last_name: msg.from?.last_name,
        username: msg.from?.username,
      });

      // Proper OAuth: inline-кнопка login_url. Telegram добавит
      // подписанные query-params (id, hash, auth_date, first_name…)
      // к нашему URL — handler /api/auth/telegram-loginurl проверит HMAC.
      const loginUrl = `https://muziai.ru/api/auth/telegram-loginurl?nonce=${nonce}`;
      const okText = `${p.avatar} Нажми кнопку ниже — это безопасный вход через Telegram. Тебя автоматически перенаправит в личный кабинет на muziai.ru.`;
      const loginKeyboard = {
        inline_keyboard: [[
          { text: "🔐 Войти на сайт", login_url: { url: loginUrl, request_write_access: false } },
        ]],
      };
      await sendMessage(chatId, okText, loginKeyboard);
      saveMessage(sessionId, "bot", okText);
      bootRefs?.eventBus?.emit?.("auth.tg_login_button_sent", { sessionId, nonce: nonce.slice(0, 8) }, "telegram-bot");
      return;
    }

    // /start — приветствие с фото-образом помощника (Eugene 2026-05-11).
    // sendPhoto с avatar URL → caption с текстом → Telegram кэширует
    // картинку, повторные /start от того же юзера показываются мгновенно.
    if (text === "/start" || text === "/start@muziaipodari_bot") {
      const p = personaFor(fromId);
      const hello = existingUserId
        ? `${p.avatar} С возвращением! Я ${p.name}, помогу с песней. Что хотите сделать?`
        : `${p.avatar} Привет! Я ${p.name} из MuziAi. Помогу подобрать песню под событие — для какого случая думаете?`;
      saveMessage(sessionId, "user", text);
      await sendConsultantPhoto(chatId, hello, STARTUP_KEYBOARD);
      saveMessage(sessionId, "bot", hello);
      return;
    }

    saveMessage(sessionId, "user", text);
    // Eugene 2026-05-11: typing-индикатор сразу — юзер видит что бот думает.
    try { tgApi("sendChatAction", { chat_id: chatId, action: "typing" }); } catch {}
    const history = loadHistory(sessionId);
    // Eugene 2026-05-11: память между сессиями. Если предыдущий msg был
    // давно (> 24h) — помечаем в prompt'е чтобы бот поздоровался как со
    // знакомым, не начинал discovery с нуля. Last seen из последнего
    // bot-сообщения в истории.
    let memoryHint = "";
    try {
      const lastBotMsg = history.slice().reverse().find(m => m.role === "assistant");
      if (lastBotMsg) {
        const sessionRow = db.select().from(chatbotSessions).where(eq(chatbotSessions.id, sessionId)).get() as any;
        const lastAt = sessionRow?.lastMessageAt ? new Date(sessionRow.lastMessageAt).getTime() : 0;
        const hoursAgo = (Date.now() - lastAt) / 3600_000;
        if (hoursAgo > 24) {
          memoryHint = `\n\n[ПАМЯТЬ: юзер общался с тобой ${Math.floor(hoursAgo / 24)} дн. назад. История последних сообщений ниже. Поздоровайся как со знакомым, не начинай discovery с нуля. Если знаешь имя из истории — обратись по имени.]`;
        } else {
          memoryHint = "\n\n[ПАМЯТЬ: продолжается прежний разговор. Не приветствуй заново.]";
        }
      }
    } catch {}
    // Eugene 2026-05-11: «Ярс — это я». Если в сообщении упоминается Ярс —
    // это сам Eugene (основатель MuziAi). Подмешиваем admin-context.
    const isOwner = /\bярс\b/i.test(text);
    const ownerHint = isOwner
      ? "\n\n[АДМИН: это Ярс — основатель MuziAi. Говори с ним коротко, конструктивно, по сути. Без sales playbook'а — он сам всё знает. Помогай с диагностикой / тестами / идеями. Можно на «ты».]"
      : "";
    // Eugene 2026-05-11: lead profile. Если уже извлекли имя/возраст/город
    // из предыдущих сообщений — подмешиваем в prompt чтобы бот не
    // переспрашивал и вёл диалог глубже.
    const profile = loadUserProfile(sessionId);
    const profileHint = profile && Object.values(profile).some(v => v !== null && v !== "")
      ? `\n\n[ПРОФИЛЬ ЮЗЕРА (уже узнала): ${JSON.stringify(profile)}. Используй эту инфу, не переспрашивай. Если каких-то полей нет — мягко выясни в ходе разговора.]`
      : "";
    const reply = await generateReply(fromId, text, history, memoryHint + ownerHint + profileHint);
    const p = personaFor(fromId);
    // Eugene 2026-05-11: имя менеджера + MuziAi в каждом сообщении.
    const footer = `\n\n— ${p.name} · MuziAi`;
    const replyWithAvatar = `${p.avatar} ${reply}${footer}`;
    // sendPhoto убираю с обычных ответов — Telegram cache не всегда
    // работает, скачивание каждый раз тормозит. Образ виден через
    // bot avatar (BotFather → /setuserpic, Eugene-side).
    await sendMessage(chatId, replyWithAvatar);
    saveMessage(sessionId, "bot", replyWithAvatar);
    bootRefs?.eventBus?.emit?.("chatbot.reply_sent", { channel: "telegram", sessionId, chatId }, "telegram-bot");
    // Eugene 2026-05-11: async update профиля юзера (имя/возраст/город/повод).
    // Не блокирует ответ — запускается после sendMessage, обновится к
    // следующему сообщению юзера.
    const fullHistory: Array<{ role: string; content: string }> = [...history, { role: "user", content: text }, { role: "assistant", content: reply }];
    updateUserProfile(sessionId, fullHistory).catch(() => {});
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
      allowed_updates: ["message", "edited_message", "callback_query"],
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
  publishes: ["chatbot.reply_sent", "auth.tg_deeplink"],
  routes: { prefix: "telegram", router },
  onLoad: async (ctx) => {
    bootRefs = { eventBus: ctx.eventBus, logger: ctx.logger };
    const kb = loadKB(true);
    ctx.logger.info("telegram-bot online", {
      token: TOKEN() ? "configured" : "missing",
      anthropic: ANTHROPIC_KEY() ? "configured" : "missing",
      gptunnel_fallback: !!process.env.GPTUNNEL_API_KEY,
      kb_loaded: kb.length > 0 ? `${kb.length} chars` : "missing",
    });
    // Auto-setup webhook (Eugene 2026-05-11): чтобы login через бота
    // работал сразу после deploy без ручного вызова /setup-webhook.
    // Берём базовый URL из env или fallback на muziai.ru (prod).
    if (TOKEN()) {
      const base = process.env.PUBLIC_BASE_URL || "https://muziai.ru";
      const target = `${base}/api/telegram/webhook`;
      try {
        const info = await tgApi("getWebhookInfo", {});
        const currentUrl = info?.result?.url || "";
        if (currentUrl !== target) {
          await tgApi("setWebhook", {
            url: target,
            allowed_updates: ["message", "edited_message", "callback_query"],
            drop_pending_updates: false,
          });
          ctx.logger.info("[telegram-bot] webhook auto-configured", { from: currentUrl, to: target });
        } else {
          ctx.logger.info("[telegram-bot] webhook already configured", { url: currentUrl });
        }
      } catch (e) {
        ctx.logger.warn?.("[telegram-bot] webhook auto-setup failed", { error: String(e) });
      }
    }
  },
  healthCheck: () => {
    return {
      status: TOKEN() ? "ok" : "degraded",
      details: { bot_token: !!TOKEN(), anthropic: !!ANTHROPIC_KEY() },
    };
  },
};

export default telegramBotModule;
