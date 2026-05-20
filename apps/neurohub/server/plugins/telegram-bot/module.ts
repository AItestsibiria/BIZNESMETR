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
// Persona: «Аня, 27 лет, support-агент MuzaAi». Не AI, ассистент.
//
// Spec: Eugene «свяжи автора со всеми данными по mail, телефону, и tg;
// сервисный чат на MuzaAi, привязать к базе знаний по продукту,
// автоматизация ответов, человек думает что общается с девушкой 25-30».

import { Router } from "express";
import { eq, sql } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { db } from "../../storage";
import { chatbotSessions, chatbotMessages, users } from "@shared/schema";
import { getOrCreatePairCode, shouldOfferPairCode, markPairCodeOffered } from "../../lib/webChatPair";
import type { BootContext, Module } from "../../core";
import { confirmNonce as confirmTgLoginNonce, hasValidNonce as hasTgLoginNonce } from "../../lib/tgLoginNonces";
import { personaFor, PERSONAS, loadKB, buildPersonaSystem, kbPath } from "../../lib/consultantPersona";
import { debounceMessage, bypassDebounce } from "../../lib/messageDebouncer";
import { loadHistoryForLLM } from "../../lib/chatHistory";
import { callUnifiedMuzaLLM } from "../../lib/llmCore";
import { logUserActionFailure } from "../../lib/userActionFailures";
import { detectsYars, recordYarsMention } from "../../lib/yarsDetect";

const TELEGRAM_API = "https://api.telegram.org";

// Eugene 2026-05-12 (Босс): dedup по update_id и message_id.
// Telegram retry'ит webhook если не получил 200 за 60 сек — может прийти
// дубль и юзер увидит одно и то же сообщение дважды. Храним последние
// 200 update_id в Map (TTL 10 мин). Если уже обработан → skip.
const processedUpdates = new Map<number, number>();
function isUpdateDup(updateId: number | undefined): boolean {
  if (!updateId) return false;
  const now = Date.now();
  for (const [k, ts] of processedUpdates.entries()) {
    if (now - ts > 10 * 60_000) processedUpdates.delete(k);
  }
  if (processedUpdates.has(updateId)) return true;
  processedUpdates.set(updateId, now);
  if (processedUpdates.size > 200) {
    const oldest = processedUpdates.keys().next().value;
    if (oldest !== undefined) processedUpdates.delete(oldest);
  }
  return false;
}
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

// Eugene 2026-05-11/12: образ помощника в КАЖДОМ ответе.
// file_id-кэш + cache-bust через mtime PNG. Если PNG обновился —
// URL меняется (?v=<mtime>) → Telegram считает это новым файлом →
// загружает свежую картинку → новый file_id. Старый file_id
// автоматически сбрасывается через сверку версии.
let cachedPhotoFileId: string | null = null;
let cachedPhotoVersion: string | null = null;

function getConsultantPhotoVersion(): string {
  try {
    const fs = require("node:fs");
    const path = require("node:path");
    for (const p of [
      path.join(process.cwd(), "dist/public/consultant-avatar.png"),
      path.join(process.cwd(), "client/public/consultant-avatar.png"),
    ]) {
      if (fs.existsSync(p)) return String(Math.floor(fs.statSync(p).mtimeMs));
    }
  } catch {}
  return "1";
}

async function sendConsultantPhoto(chatId: number | string, caption: string, replyMarkup?: any): Promise<void> {
  try {
    const base = process.env.PUBLIC_BASE_URL || "https://muzaai.ru";
    const currentVersion = getConsultantPhotoVersion();
    // Версия изменилась → сбрасываем file_id, перезагружаем картинку.
    if (cachedPhotoVersion !== currentVersion) {
      cachedPhotoFileId = null;
      cachedPhotoVersion = currentVersion;
    }
    const photoSource = cachedPhotoFileId || `${base}/consultant-avatar.png?v=${currentVersion}`;
    const body: any = {
      chat_id: chatId,
      photo: photoSource,
      caption,
      parse_mode: "HTML",
    };
    if (replyMarkup) body.reply_markup = replyMarkup;
    const resp = await tgApi("sendPhoto", body);
    // После первой удачной загрузки — забираем file_id для следующих
    // вызовов. Берём самый большой вариант фото (последний в массиве).
    if (!cachedPhotoFileId) {
      const photos = resp?.result?.photo;
      if (Array.isArray(photos) && photos.length > 0) {
        cachedPhotoFileId = photos[photos.length - 1].file_id;
        bootRefs?.logger.info?.("[telegram-bot] consultant photo cached", { file_id: cachedPhotoFileId?.slice(0, 16) + "…" });
      }
    }
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
      { text: "🎵 Послушать треки", url: "https://muzaai.ru/" },
      { text: "🆕 Регистрация (1 трек в подарок)", url: "https://muzaai.ru/#/register" },
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

// Eugene 2026-05-16 Босс «один мозг для всех каналов» — generateReply теперь
// идёт через единственную точку callUnifiedMuzaLLM (lib/llmCore.ts).
// Раньше у TG был отдельный tryClaude + tryGPTunnel БЕЗ MUZA_TOOLS — из-за
// этого TG-бот не мог вызывать get_balance / save_song_draft / get_user_tracks.
// Теперь tools работают и в TG.
//
// GPTunnel-fallback (gpt-4o-mini без tools) сохранён только как самый
// последний резерв если Anthropic недоступен по всей цепочке ключей.
async function tryGPTunnelFallback(system: string, text: string, history: Array<{ role: string; content: string }>): Promise<string | null> {
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
  sessionId: string,
  userKey: string,
  userText: string,
  history: Array<{ role: "user" | "assistant"; content: string }>,
  dynamicContext = "",
  authUserId: number | null = null,
): Promise<string> {
  // 1. Primary: единый Claude-call через llmCore (с MUZA_TOOLS).
  const reply = await callUnifiedMuzaLLM({
    sessionId,
    userId: authUserId,
    channel: "telegram",
    userText,
    history,
    dynamicContext,
    maxTokens: 400,
  });
  if (reply) return reply;

  // 2. Backup: GPTunnel (gpt-4o-mini, без tools). Подаём persona+dynamic
  //    как один system-block — самый простой вариант для не-Anthropic LLM.
  const fallbackSystem = buildPersonaSystem(userKey) + (dynamicContext ? "\n\n" + dynamicContext : "");
  const o = await tryGPTunnelFallback(fallbackSystem, userText, history);
  if (o) return o;

  // 3. Все упали → hardcoded fallback + register failure.
  logUserActionFailure({
    channel: "telegram",
    action: "chat-reply",
    errorCode: "llm_both_failed",
    errorMessage: "Anthropic + GPTunnel оба не ответили — отдан hardcoded fallback",
    context: { userKey: String(userKey).slice(0, 32), textPreview: userText.slice(0, 100) },
  });
  return `Здравствуйте! Я — Муза 🎵 Чуть-чуть тормозит — попробуйте через минуту.`;
}

// Quick reply (Eugene 2026-05-11): для типичных коротких сообщений
// возвращаем готовый ответ БЕЗ Claude — экономия 1-2 секунд.
function tryQuickReply(text: string, personaName: string): string | null {
  const t = text.trim().toLowerCase();
  // Точные совпадения
  if (/^(привет|здравствуй|здравствуйте|добрый день|доброе утро|добрый вечер|hi|hello)[.!\s]*$/i.test(t)) {
    return `Привет! Я — Муза, помогу подобрать песню. Для какого случая думаете?`;
  }
  if (/^(спасибо|благодарю|thanks|thx|спс)[.!\s]*$/i.test(t)) {
    return `Пожалуйста! Если что — пишите.`;
  }
  if (/^(ок|окей|ok|okay|хорошо|понятно|ясно)[.!\s]*$/i.test(t)) {
    return `Угу. Продолжим — расскажите что хотите?`;
  }
  if (/^(пока|до свидания|bye|goodbye)[.!\s]*$/i.test(t)) {
    return `До встречи! Возвращайтесь когда созреет идея 🎵`;
  }
  if (/^(\/help|help|помощь)[.!\s]*$/i.test(t)) {
    return `Я помогу подобрать песню под событие. Расскажите для кого и какой повод — посоветую шаблон и подготовим текст.`;
  }
  return null;
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

// === Long-term memory (Eugene 2026-05-11) ===
// При возврате после 24h+ — LLM сжимает старые сообщения в 1-2 фразы
// memo. Подмешивается в prompt вместо передачи всей старой истории.
async function maybeUpdateLongTermMemo(sessionId: string, hoursSinceLast: number): Promise<void> {
  if (hoursSinceLast < 24) return;
  const key = ANTHROPIC_KEY();
  if (!key) return;
  try {
    const oldMessages = (db.select().from(chatbotMessages).where(eq(chatbotMessages.sessionId, sessionId)).all() as any[]).slice(0, -8);
    if (oldMessages.length < 5) return;
    const transcript = oldMessages.map(m => `${m.role}: ${String(m.text || "").slice(0, 250)}`).join("\n");
    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "x-api-key": key, "anthropic-version": "2023-06-01", "content-type": "application/json" },
      body: JSON.stringify({
        model: "claude-haiku-4-5-20251001",
        max_tokens: 250,
        system: "Сожми диалог в 2-3 коротких фразы: что обсуждали, к чему пришли, что осталось доделать. Только факты. Не вступление.",
        messages: [{ role: "user", content: transcript }],
      }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!r.ok) return;
    const j: any = await r.json();
    const memo = j?.content?.[0]?.text?.slice(0, 800);
    if (memo) {
      db.update(chatbotSessions).set({ longTermMemo: memo }).where(eq(chatbotSessions.id, sessionId)).run();
    }
  } catch {}
}

function loadLongTermMemo(sessionId: string): string | null {
  try {
    const row = db.select().from(chatbotSessions).where(eq(chatbotSessions.id, sessionId)).get() as any;
    return row?.longTermMemo || null;
  } catch { return null; }
}

// === Self-learning (Eugene 2026-05-11) ===
// === Re-engagement (Eugene 2026-05-12) ===
// Если юзер чатился, потом замолчал 2-14 дней — отправить персонализированное
// «привет, как дела». Не чаще раза в 14 дней на одного юзера.
// Запускается каждые 6 часов. Ограничение 10 сообщений за прогон, паузы
// 3 сек между — чтобы не флудить Telegram API.
async function reEngageInactiveUsers(): Promise<void> {
  const key = ANTHROPIC_KEY();
  if (!key) return;
  try {
    const candidates = db.all<any>(sql`
      SELECT cs.id, cs.external_id, cs.persona_name, cs.user_profile, cs.long_term_memo,
        (SELECT COUNT(*) FROM chatbot_messages WHERE session_id = cs.id) as msg_count
      FROM chatbot_sessions cs
      WHERE cs.channel = 'telegram'
        AND cs.external_id IS NOT NULL
        AND cs.last_message_at < datetime('now', '-2 days')
        AND cs.last_message_at > datetime('now', '-14 days')
        AND (cs.last_reengaged_at IS NULL OR cs.last_reengaged_at < datetime('now', '-14 days'))
        AND (SELECT COUNT(*) FROM chatbot_messages WHERE session_id = cs.id) >= 3
      LIMIT 10
    `) as any[];
    if (!candidates.length) {
      bootRefs?.logger.info?.("[telegram-bot] re-engage: no candidates");
      return;
    }
    bootRefs?.logger.info?.("[telegram-bot] re-engage: starting", { count: candidates.length });
    for (const c of candidates) {
      try {
        const persona = (c.persona_name && PERSONAS.find(p => p.name === c.persona_name)) || personaFor(String(c.external_id));
        const profile = c.user_profile ? JSON.parse(c.user_profile) : {};
        const memo = c.long_term_memo || "";
        const sys = `Ты — ${persona.name}, помощница MuzaAi. Стиль: ${persona.styleGuide}.
Юзер общался раньше но замолчал. Напиши КОРОТКОЕ (1-2 фразы) тёплое возвращение, без давления, без CTA. Не «давайте создадим трек», а просто внимание: «привет, как вы? давно не виделись, всё хорошо?». Используй имя если знаешь. Учти контекст прошлого разговора. Без подписи имени в конце.

ПРОФИЛЬ: ${JSON.stringify(profile)}
ПРЕДЫДУЩИЙ КОНТЕКСТ: ${memo}`;
        const r = await fetch("https://api.anthropic.com/v1/messages", {
          method: "POST",
          headers: { "x-api-key": key, "anthropic-version": "2023-06-01", "content-type": "application/json" },
          body: JSON.stringify({
            model: "claude-haiku-4-5-20251001",
            max_tokens: 120,
            system: sys,
            messages: [{ role: "user", content: "Напиши возвращение." }],
          }),
          signal: AbortSignal.timeout(10_000),
        });
        if (!r.ok) continue;
        const j: any = await r.json();
        const text = String(j?.content?.[0]?.text || "").trim();
        if (!text) continue;
        // Eugene 2026-05-18 Босс «выводим только Музу — имена персон скрыты от юзера».
        const footer = `\n\n— Муза · MuzaAi`;
        const full = `🎵 ${text}${footer}`;
        await sendMessage(c.external_id, full);
        db.update(chatbotSessions).set({ lastReengagedAt: new Date().toISOString() }).where(eq(chatbotSessions.id, c.id)).run();
        saveMessage(c.id, "bot", `[re-engage] ${full}`);
        bootRefs?.eventBus?.emit?.("chatbot.reengaged", { sessionId: c.id, persona: persona.name }, "telegram-bot");
        await new Promise(r => setTimeout(r, 3000)); // пауза между отправками
      } catch (e) {
        bootRefs?.logger.warn?.("[telegram-bot] re-engage one failed", { error: String(e) });
      }
    }
  } catch (e) {
    bootRefs?.logger.error?.("[telegram-bot] re-engage scheduler error", { error: String(e) });
  }
}

// Раз в 24h: LLM анализирует диалоги последних 7 дней. Классифицирует
// успешные (юзер дошёл до конверсии) vs неуспешные. Извлекает паттерны.
// Сохраняет в bot_learnings — последние 3 active автоматически
// подмешиваются в system prompt → бот сам учится на ошибках.
async function analyzeDialoguesForLearning(): Promise<void> {
  const key = ANTHROPIC_KEY();
  if (!key) return;
  try {
    // 1. Выбираем сессии последних 7 дней с минимум 4 сообщениями.
    const sessions = db.all<any>(sql`
      SELECT cs.id, cs.user_profile, cs.user_id,
        (SELECT COUNT(*) FROM chatbot_messages WHERE session_id = cs.id) as msg_count
      FROM chatbot_sessions cs
      WHERE cs.last_message_at >= datetime('now', '-7 days')
      AND (SELECT COUNT(*) FROM chatbot_messages WHERE session_id = cs.id) >= 4
      ORDER BY cs.last_message_at DESC
      LIMIT 40
    `) as any[];
    if (sessions.length < 4) {
      bootRefs?.logger.info?.("[bot-learning] not enough data", { sessions: sessions.length });
      return;
    }
    // 2. Достаём сообщения + классифицируем конверсию.
    // Прокси конверсии: связан с user_id (=> зарегистрирован) ИЛИ
    // в engagement_events есть music_link_open / register / generate
    // за этот период от same telegram user.
    const dialogues: Array<{ id: string; converted: boolean; transcript: string }> = [];
    for (const s of sessions.slice(0, 30)) {
      const msgs = db.all<any>(sql`
        SELECT role, text FROM chatbot_messages
        WHERE session_id = ${s.id}
        ORDER BY created_at LIMIT 30
      `) as any[];
      const transcript = msgs.map((m: any) => `${m.role}: ${String(m.text || "").slice(0, 180)}`).join("\n");
      // Прокси: linked user_id ИЛИ профиль содержит явный intent
      const converted = !!s.user_id;
      dialogues.push({ id: s.id, converted, transcript });
    }
    const conv = dialogues.filter(d => d.converted).slice(0, 8);
    const failed = dialogues.filter(d => !d.converted).slice(0, 10);
    const successCount = conv.length;
    const failCount = failed.length;
    if (successCount + failCount < 5) return;

    // 3. Single Claude call — анализ + JSON.
    const sample = (arr: Array<{ transcript: string }>, label: string) =>
      arr.length === 0 ? `[нет данных]` : arr.map((d, i) => `--- ${label} #${i + 1} ---\n${d.transcript.slice(0, 1200)}`).join("\n\n");

    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "x-api-key": key, "anthropic-version": "2023-06-01", "content-type": "application/json" },
      body: JSON.stringify({
        model: "claude-haiku-4-5-20251001",
        max_tokens: 800,
        system: `Ты — аналитик помощника MuzaAi. Сравни УСПЕШНЫЕ и НЕУСПЕШНЫЕ диалоги. Найди паттерны.

УСПЕШНЫЕ = юзер зарегистрировался / сохранил текст / пошёл генерировать.
НЕУСПЕШНЫЕ = юзер ушёл, не сделал действие.

Верни строго JSON без markdown:
{
  "what_worked": "1-2 коротких фразы: что в успешных работало",
  "what_failed": "1-2 фразы: что в неуспешных пошло не так",
  "recommendations": "1-3 коротких рекомендации боту, конкретно и применимо в чате"
}`,
        messages: [{ role: "user", content: `=== УСПЕШНЫЕ (${successCount}) ===\n${sample(conv, "OK")}\n\n=== НЕУСПЕШНЫЕ (${failCount}) ===\n${sample(failed, "FAIL")}` }],
      }),
      signal: AbortSignal.timeout(30_000),
    });
    if (!r.ok) {
      bootRefs?.logger.warn?.("[bot-learning] claude non-ok", { status: r.status });
      return;
    }
    const j: any = await r.json();
    const raw = j?.content?.[0]?.text || "";
    const jsonStr = raw.replace(/^```(?:json)?\s*/, "").replace(/\s*```$/, "").trim();
    let parsed: any;
    try { parsed = JSON.parse(jsonStr); } catch { return; }
    if (!parsed?.recommendations) return;

    db.run(sql`
      INSERT INTO bot_learnings (scope, sample_size, success_count, fail_count, what_worked, what_failed, recommendations, applied)
      VALUES ('daily', ${successCount + failCount}, ${successCount}, ${failCount},
        ${String(parsed.what_worked || "").slice(0, 600)},
        ${String(parsed.what_failed || "").slice(0, 600)},
        ${String(parsed.recommendations || "").slice(0, 800)},
        1)
    `);
    bootRefs?.logger.info?.("[bot-learning] insight saved", {
      sample: successCount + failCount,
      success: successCount,
      recommendations: String(parsed.recommendations || "").slice(0, 150),
    });
  } catch (e) {
    bootRefs?.logger.error?.("[bot-learning] error", { error: String(e) });
  }
}

function loadLatestLearnings(): string {
  try {
    const rows = db.all<any>(sql`
      SELECT what_worked, recommendations FROM bot_learnings
      WHERE applied = 1
      ORDER BY created_at DESC
      LIMIT 3
    `) as any[];
    if (!rows.length) return "";
    return "\n\n═══ САМООБУЧЕНИЕ (что работает в успешных диалогах) ═══\n" +
      rows.map((r: any, i: number) => `[Инсайт ${i + 1}] ${r.what_worked || ""}\n   → ${r.recommendations || ""}`).join("\n");
  } catch { return ""; }
}

// === Session helpers ===
// Eugene 2026-05-15 Босс «Связывай»: cross-channel history. Если session
// привязана к userId — подтягивает сообщения из всех каналов (TG/Web/Max)
// одного юзера, сортирует по времени, помечает чужие каналы префиксом
// `[Web]` / `[Max]`. Anonymous сессии → single-session как раньше.
function loadHistory(sessionId: string): Array<{ role: "user" | "assistant"; content: string }> {
  return loadHistoryForLLM(sessionId, 20);
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
    // Eugene 2026-05-12: lock persona при создании сессии — один помощник
    // ведёт юзера до конца, не меняется при возврате через дни.
    const lockedPersona = personaFor(tgUserId).name;
    db.insert(chatbotSessions).values({
      id: sessionId,
      channel: "telegram",
      externalId: tgChatId,
      userId: linkedUserId,
      state: "active",
      personaName: lockedPersona,
      startedAt: new Date().toISOString(),
      lastMessageAt: new Date().toISOString(),
    }).run();
  } catch {}
  return { sessionId, existingUserId: linkedUserId };
}

// Eugene 2026-05-12: загружает persona по locked-имени в сессии. Fallback —
// hash от userKey (для старых сессий без persona_name).
function personaForSession(sessionId: string, fallbackKey: string) {
  try {
    const row = db.select().from(chatbotSessions).where(eq(chatbotSessions.id, sessionId)).get() as any;
    if (row?.personaName) {
      const locked = PERSONAS.find(p => p.name === row.personaName);
      if (locked) return locked;
    }
  } catch {}
  return personaFor(fallbackKey);
}

function saveMessage(sessionId: string, role: "user" | "bot", text: string, userId?: number | null): void {
  try {
    const inserted = db.insert(chatbotMessages).values({
      sessionId,
      role,
      text: text.slice(0, 3900),
      createdAt: new Date().toISOString(),
    }).returning({ id: chatbotMessages.id }).get();
    // Eugene 2026-05-19 CSAT-аудит: оживляем message_analysis для TG-канала
    if (role === "user") {
      import("../message-analysis/module").then(({ logMessageAnalysis }) => {
        logMessageAnalysis({
          messageId: inserted?.id ?? null,
          sessionId,
          userId: userId ?? null,
          channel: "telegram",
          text,
        });
      }).catch(() => {});
    }
  } catch {}
}

// === Router ===
const router = Router();

// Telegram webhook — публичный (без auth). Telegram POSTит сюда updates.
// Eugene 2026-05-18 (ACCESS-BYPASS-AUDIT-170526 #2): проверка
// X-Telegram-Bot-Api-Secret-Token. Telegram присылает этот header в каждом
// запросе если при setWebhook передан secret_token (см. ниже). Защищает от
// прямого POST на webhook URL — без secret webhook можно спамить fake
// update'ами в обход Telegram.
// Backward-compat: если TELEGRAM_WEBHOOK_SECRET не задан — warn, без блока.
router.post("/webhook", async (req, res) => {
  const expectedSecret = process.env.TELEGRAM_WEBHOOK_SECRET || "";
  if (expectedSecret) {
    const got = req.headers["x-telegram-bot-api-secret-token"];
    if (got !== expectedSecret) {
      bootRefs?.logger.warn?.("[telegram-bot] invalid webhook secret", {
        ip: (req as any).ip,
        ua: (req.headers["user-agent"] || "").toString().slice(0, 80),
      });
      return res.status(403).json({ data: null, error: "forbidden" });
    }
  } else {
    // Без env — каждый запуск warn раз в час чтобы Босс заметил
    if (!(global as any).__telegram_webhook_secret_warned ||
        Date.now() - (global as any).__telegram_webhook_secret_warned > 3600_000) {
      (global as any).__telegram_webhook_secret_warned = Date.now();
      bootRefs?.logger.warn?.("[telegram-bot] TELEGRAM_WEBHOOK_SECRET не задан — webhook принимает запросы без secret-token (uncovered prod risk)");
    }
  }
  res.status(200).send("ok"); // Сразу отвечаем 200 чтобы Telegram не ретраил
  try {
    const update = req.body || {};
    // Dedup: Telegram retry'ит webhook → дубль ответа. Skip уже обработанные.
    if (isUpdateDup(update.update_id)) {
      bootRefs?.logger.info?.("[telegram-bot] skipping duplicate update", { update_id: update.update_id });
      return;
    }
    // Eugene 2026-05-17 Босс «pause_bot tool через admin-voice».
    // Если Муза приостановила бота через voice-command — webhook возвращает
    // 200 (см. выше), но не обрабатывает update. Telegram не делает retry.
    try {
      const { isBotPausedRuntime } = await import("../../lib/muzaTools");
      if (isBotPausedRuntime()) {
        bootRefs?.logger.info?.("[telegram-bot] paused (runtime) — skipping update");
        return;
      }
    } catch {}

    // Callback queries (нажатие на InlineKeyboard кнопку)
    if (update.callback_query) {
      const cq = update.callback_query;
      const chatId = String(cq.message?.chat?.id || "");
      const fromId = String(cq.from?.id || "");
      const data = String(cq.data || "");
      try { await tgApi("answerCallbackQuery", { callback_query_id: cq.id }); } catch {}
      if (!chatId) return;
      const { sessionId } = findOrCreateSession(chatId, fromId);
      const p = personaForSession(sessionId, fromId);
      const responses: Record<string, string> = {
        menu_support: `Расскажите подробнее — что случилось, на каком этапе? Если есть номер трека или скриншот — присылайте, разберёмся.`,
        menu_event: `Здорово! А под какое событие — свадьба, день рождения, юбилей, корпоратив? И какой у вас есть текст или идея?\n\nЕсть готовые шаблоны: https://muzaai.ru/#/templates`,
        menu_b2b: `Сотрудничество — это интересно. Расскажите, какой формат: подкаст, реклама, B2B-лицензия треков, что-то ещё? Мы откликнемся в течение дня.`,
      };
      const reply = responses[data] || `Открыть на сайте: https://muzaai.ru/`;
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
      const p = personaForSession(sessionId, fromId);
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
      const loginUrl = `https://muzaai.ru/api/auth/telegram-loginurl?nonce=${nonce}`;
      const okText = `${p.avatar} Нажми кнопку ниже — это безопасный вход через Telegram. Тебя автоматически перенаправит в личный кабинет на muzaai.ru.`;
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
      const p = personaForSession(sessionId, fromId);
      // Eugene 2026-05-20 Босс «пусть Муза выбирает разные приветствия».
      // Единый pool из ~20 вариантов (time-of-day, season, geo).
      const { pickMusaGreeting } = await import("../../lib/musaGreetings");
      const userName = (() => {
        try { return existingUserId ? (storage.getUser(existingUserId)?.name || null) : null; } catch { return null; }
      })();
      const hello = pickMusaGreeting({
        userName,
        isReturning: !!existingUserId,
        channel: "telegram",
        channelAvatar: p.avatar,
      });
      saveMessage(sessionId, "user", text);
      await sendConsultantPhoto(chatId, hello, STARTUP_KEYBOARD);
      saveMessage(sessionId, "bot", hello);
      return;
    }

    saveMessage(sessionId, "user", text);
    // Eugene 2026-05-12 (Босс): задержка 5 сек на обработку — юзер часто
    // докидывает уточнение. Если приходит ещё сообщение в течение 5 сек —
    // тексты объединяются и обрабатываются вместе.
    // Quick-reply для коротких типичных фраз — без задержки.
    const p0 = personaForSession(sessionId, fromId);
    const quick = tryQuickReply(text, p0.name);
    if (quick) {
      const cleanQuick = quick.replace(/\s*[—\-–]+\s*(Муза|Аня|Татьяна|Мария|Ольга|Алексей|Дмитрий|Михаил|Андрей|Лиза|Полина|Кирилл|Артём|Маша|Лёша)(\s*·\s*(MuzaAi|MuzaAi))?\s*\.?\s*$/i, "").trimEnd();
      const footer = `\n\n— Муза · MuzaAi`;
      // Eugene 2026-05-18 Босс «в чате выводим только аватар Музы — имена персон скрыты».
      // p0.avatar (emoji персоны) больше не префиксим — единый 🎵.
      const replyWithAvatar = `🎵 ${cleanQuick}${footer}`;
      bypassDebounce(`tg:${chatId}`);
      await sendConsultantPhoto(chatId, replyWithAvatar);
      saveMessage(sessionId, "bot", replyWithAvatar);
      return;
    }
    // Typing-индикатор сразу — юзер видит что бот думает.
    try { tgApi("sendChatAction", { chat_id: chatId, action: "typing" }); } catch {}
    // Debounce 5 сек: ждём не дойдут ли уточнения. Если придут — текст
    // объединится. Ниже — обработка после слияния.
    debounceMessage(`tg:${chatId}`, text, { chatId, fromId, sessionId, p0 }, async (combinedText) => {
      await processIncomingText(chatId, fromId, sessionId, combinedText);
    });
    return;
  } catch (e) {
    bootRefs?.logger.error?.("[telegram-bot] webhook error", { error: String(e) });
    logUserActionFailure({
      channel: "telegram",
      action: "webhook",
      errorCode: "webhook_handler_throw",
      errorMessage: String(e).slice(0, 300),
      endpoint: "/api/telegram/webhook",
    });
  }
});

// processIncomingText — обработка после debounce. Вынесена в отдельную
// функцию чтобы вызываться из debouncer через 5 сек после последнего
// сообщения юзера.
async function processIncomingText(chatId: string, fromId: string, sessionId: string, text: string): Promise<void> {
  try {
    // Re-typing — юзер уже видел typing 5 сек назад, обновим.
    try { tgApi("sendChatAction", { chat_id: chatId, action: "typing" }); } catch {}
    const history = loadHistory(sessionId);
    // Eugene 2026-05-11: память между сессиями + прогрессия visits.
    // Если предыдущий msg был давно (> 24h) — increment visitCount,
    // сжимаем старую историю в longTermMemo (async).
    let memoryHint = "";
    let visitCount = 1;
    try {
      const sessionRow = db.select().from(chatbotSessions).where(eq(chatbotSessions.id, sessionId)).get() as any;
      visitCount = Number(sessionRow?.visitCount) || 1;
      const lastBotMsg = history.slice().reverse().find(m => m.role === "assistant");
      if (lastBotMsg && sessionRow?.lastMessageAt) {
        const lastAt = new Date(sessionRow.lastMessageAt).getTime();
        const hoursAgo = (Date.now() - lastAt) / 3600_000;
        if (hoursAgo > 24) {
          visitCount += 1;
          db.update(chatbotSessions).set({ visitCount }).where(eq(chatbotSessions.id, sessionId)).run();
          maybeUpdateLongTermMemo(sessionId, hoursAgo).catch(() => {});
          memoryHint = `\n\n[ПАМЯТЬ: это ${visitCount}-я встреча с юзером (предыдущая ${Math.floor(hoursAgo / 24)} дн. назад). Поздоровайся как со знакомым, без discovery с нуля. Если знаешь имя — обращайся по имени. Прогрессируй: 2-я встреча = глубже, 3-я+ = персональные предложения шаблонов / акций.]`;
        } else {
          memoryHint = "\n\n[ПАМЯТЬ: продолжается прежний разговор. Не приветствуй заново.]";
        }
      }
    } catch {}
    // Long-term memo (если сохранён от прошлой долгой сессии).
    const ltm = loadLongTermMemo(sessionId);
    const ltmHint = ltm ? `\n\n[ВОСПОМИНАНИЕ О ПРОШЛЫХ РАЗГОВОРАХ: ${ltm}]` : "";
    // Eugene 2026-05-11: «Ярс — это я». Если в сообщении упоминается Ярс —
    // это сам Eugene (основатель MuzaAi). Подмешиваем admin-context.
    // Eugene 2026-05-17: расширил detection + логирование в `yars_mentions`
    // + Telegram-alert админу (rate-limited 1/5min per session).
    const isOwner = detectsYars(text);
    if (isOwner) {
      let yarsUserId: number | null = null;
      try {
        const sRow = db.select().from(chatbotSessions).where(eq(chatbotSessions.id, sessionId)).get() as any;
        yarsUserId = sRow?.userId ?? null;
      } catch {}
      bootRefs?.logger.info?.("[YARS-MENTION]", {
        channel: "telegram",
        sessionId,
        userId: yarsUserId,
        text: text.slice(0, 200),
        timestamp: new Date().toISOString(),
      });
      recordYarsMention({ sessionId, userId: yarsUserId, channel: "telegram", text });
    }
    const ownerHint = isOwner
      ? "\n\n[АДМИН: это Ярс — основатель MuzaAi. Говори с ним коротко, конструктивно, по сути. Без sales playbook'а — он сам всё знает. Помогай с диагностикой / тестами / идеями. Можно на «ты».]"
      : "";
    // Eugene 2026-05-11: lead profile. Если уже извлекли имя/возраст/город
    // из предыдущих сообщений — подмешиваем в prompt чтобы бот не
    // переспрашивал и вёл диалог глубже.
    const profile = loadUserProfile(sessionId);
    const profileHint = profile && Object.values(profile).some(v => v !== null && v !== "")
      ? `\n\n[ПРОФИЛЬ ЮЗЕРА (уже узнала): ${JSON.stringify(profile)}. Используй эту инфу, не переспрашивай. Если каких-то полей нет — мягко выясни в ходе разговора.]`
      : "";
    const learningsHint = loadLatestLearnings();
    // Eugene 2026-05-12: дата + время + сезон в dynamic-блок.
    const now = new Date();
    const hh = now.getHours();
    const partOfDay = hh >= 5 && hh < 11 ? "утро" : hh >= 11 && hh < 18 ? "день" : hh >= 18 && hh < 22 ? "вечер" : "ночь";
    const month = now.getMonth() + 1;
    const season = month >= 3 && month <= 5 ? "весна" : month >= 6 && month <= 8 ? "лето" : month >= 9 && month <= 11 ? "осень" : "зима";
    const todayHint = `\n\n[TODAY: ${now.toISOString().slice(0, 10)} (${now.toLocaleDateString("ru-RU", { weekday: "long", day: "numeric", month: "long" })})]\n[TIME: ${now.toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" })}, ${partOfDay}]\n[SEASON: ${season}]`;
    // Eugene 2026-05-16 Босс «один мозг»: вместо своего LLM-call идём через
    // unified callUnifiedMuzaLLM (получает sessionId → cross-channel history
    // + tool-use). authUserId берём из сессии (если юзер залогинен через TG).
    let authUserId: number | null = null;
    try {
      const sRow = db.select().from(chatbotSessions).where(eq(chatbotSessions.id, sessionId)).get() as any;
      authUserId = sRow?.userId ?? null;
    } catch {}
    const rawReply = await generateReply(
      sessionId,
      fromId,
      text,
      history,
      memoryHint + ltmHint + ownerHint + profileHint + learningsHint + todayHint,
      authUserId,
    );
    // Eugene 2026-05-12: маркер смены помощника. LLM может вставить
    // [SWITCH_PERSONA:Имя] — код применит смену в БД и уберёт маркер.
    const switchMatch = rawReply.match(/\[SWITCH_PERSONA:(Муза|Аня|Татьяна|Мария|Ольга|Алексей|Дмитрий|Михаил|Андрей|Лиза|Полина|Кирилл|Артём|Маша|Лёша)\]/i);
    if (switchMatch) {
      try {
        db.update(chatbotSessions).set({ personaName: switchMatch[1] }).where(eq(chatbotSessions.id, sessionId)).run();
        bootRefs?.logger.info?.("[telegram-bot] persona switched", { sessionId: sessionId.slice(0, 8), to: switchMatch[1] });
      } catch {}
    }
    const reply = rawReply.replace(/\[SWITCH_PERSONA:[^\]]+\]\s*/gi, "").trim();
    const p = personaForSession(sessionId, fromId);
    // Eugene 2026-05-11: подпись Имя · MuzaAi.
    // Eugene 2026-05-12: если LLM сам подписался — не дублируем.
    // Eugene 2026-05-12 (Босс «реши на 100%»): убираем sendPhoto из
    // обычных reply'ев — Telegram кэш ненадёжен (96×96 PNG отклонялся,
    // юзер видел только текст). Образ в чате теперь через bot avatar
    // в @BotFather → /setuserpic. SendPhoto оставлен только в /start.
    const cleanReply = reply.replace(/\s*[—\-–]+\s*(Муза|Аня|Татьяна|Мария|Ольга|Алексей|Дмитрий|Михаил|Андрей|Лиза|Полина|Кирилл|Артём|Маша|Лёша)(\s*·\s*(MuzaAi|MuzaAi))?\s*\.?\s*$/i, "").trimEnd();
    const footer = `\n\n— Муза · MuzaAi`;

    // Eugene 2026-05-14 Босс: cross-channel pair-code приглашение на сайт.
    // После >= 3 сообщений в сессии + cooldown 6ч + шанс 30% — добавляем
    // в конец ответа приглашение «продолжить на сайте, скажи код XYZ123».
    let pairInvite = "";
    try {
      const msgCount = history.length;
      if (msgCount >= 3 && shouldOfferPairCode(sessionId, "telegram") && Math.random() < 0.3) {
        const code = getOrCreatePairCode(sessionId);
        if (code) {
          markPairCodeOffered(sessionId);
          pairInvite = `\n\n✨ Кстати, у меня там на сайте уютнее: https://muzaai.ru — там просто шепнёшь мне «${code}» и я подтяну весь наш разговор. Веселее, обещаю!`;
        }
      }
    } catch (e) { bootRefs?.logger.warn?.("[telegram-bot] pair-code offer skipped", { error: String(e) }); }

    // Eugene 2026-05-18 Босс «в чате выводим только аватар Музы — имена персон скрыты».
    // p.avatar (emoji персоны) больше не префиксим — единый 🎵.
    const replyWithAvatar = `🎵 ${cleanReply}${pairInvite}${footer}`;
    await sendMessage(chatId, replyWithAvatar);
    saveMessage(sessionId, "bot", replyWithAvatar);
    bootRefs?.eventBus?.emit?.("chatbot.reply_sent", { channel: "telegram", sessionId, chatId }, "telegram-bot");
    // Eugene 2026-05-11: async update профиля юзера (имя/возраст/город/повод).
    // Не блокирует ответ — запускается после sendMessage, обновится к
    // следующему сообщению юзера.
    const fullHistory: Array<{ role: string; content: string }> = [...history, { role: "user", content: text }, { role: "assistant", content: reply }];
    updateUserProfile(sessionId, fullHistory).catch(() => {});
  } catch (e) {
    bootRefs?.logger.error?.("[telegram-bot] processIncomingText error", { error: String(e) });
  }
}

// Admin: настройка webhook URL у Telegram (вызывать один раз после deploy).
// Защита: secret из env (CRON_SECRET или SESSION_SECRET).
// GET /api/telegram/setup-webhook?url=https://muzaai.ru/api/telegram/webhook&secret=...
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
    // Eugene 2026-05-18 (ACCESS-BYPASS-AUDIT-170526 #2): передаём secret_token
    // если задан в env. Telegram будет включать его в X-Telegram-Bot-Api-Secret-Token
    // header на каждом webhook-запросе → server-side проверка.
    const setWebhookBody: Record<string, any> = {
      url,
      allowed_updates: ["message", "edited_message", "callback_query"],
      drop_pending_updates: true,
    };
    const whSecret = process.env.TELEGRAM_WEBHOOK_SECRET || "";
    if (whSecret) setWebhookBody.secret_token = whSecret;
    const r = await tgApi("setWebhook", setWebhookBody);
    return res.json({ ok: true, telegram: r, secret_set: !!whSecret });
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
    // Берём базовый URL из env или fallback на muzaai.ru (prod).
    if (TOKEN()) {
      const base = process.env.PUBLIC_BASE_URL || "https://muzaai.ru";
      const target = `${base}/api/telegram/webhook`;
      try {
        const info = await tgApi("getWebhookInfo", {});
        const currentUrl = info?.result?.url || "";
        const currentHasSecret = !!info?.result?.has_custom_certificate || !!info?.result?.url; // best-effort
        const whSecret = process.env.TELEGRAM_WEBHOOK_SECRET || "";
        // Eugene 2026-05-18 (ACCESS-BYPASS-AUDIT-170526 #2): пере-setWebhook
        // если URL поменялся ИЛИ secret поменялся (env стал задан).
        const needsResetup = currentUrl !== target || (whSecret && !info?.result?.url);
        if (needsResetup) {
          const body: Record<string, any> = {
            url: target,
            allowed_updates: ["message", "edited_message", "callback_query"],
            drop_pending_updates: false,
          };
          if (whSecret) body.secret_token = whSecret;
          await tgApi("setWebhook", body);
          ctx.logger.info("[telegram-bot] webhook auto-configured", { from: currentUrl, to: target, secret: whSecret ? "configured" : "missing" });
        } else {
          ctx.logger.info("[telegram-bot] webhook already configured", { url: currentUrl, secret: whSecret ? "configured" : "missing" });
        }
      } catch (e) {
        ctx.logger.warn?.("[telegram-bot] webhook auto-setup failed", { error: String(e) });
      }
    }
    // Self-learning scheduler (Eugene 2026-05-11): раз в 24h LLM
    // анализирует диалоги последних 7 дней — что работало, что нет.
    // Inсайты сохраняются в bot_learnings, последние 3 active
    // подмешиваются в system prompt → бот сам корректирует поведение.
    if (ANTHROPIC_KEY()) {
      // Запуск через 5 минут после boot (даём системе устаканиться).
      setTimeout(() => { analyzeDialoguesForLearning().catch(() => {}); }, 5 * 60_000);
      setInterval(() => { analyzeDialoguesForLearning().catch(() => {}); }, 24 * 3600_000).unref();
      // Re-engagement каждые 6 часов (Eugene 2026-05-12).
      setTimeout(() => { reEngageInactiveUsers().catch(() => {}); }, 30 * 60_000);
      setInterval(() => { reEngageInactiveUsers().catch(() => {}); }, 6 * 3600_000).unref();
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
