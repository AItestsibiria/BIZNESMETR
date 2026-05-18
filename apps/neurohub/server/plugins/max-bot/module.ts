// Max-bot helper (Eugene 2026-05-11): отвечает в Max через тот же KB+persona
// что и telegram-bot. Webhook: /api/max-bot/webhook
// Refactored: persona + KB + prompt → shared lib (lib/consultantPersona).
import { Router } from "express";
import type { BootContext, Module } from "../../core";
import { eq } from "drizzle-orm";
import { db } from "../../storage";
import { chatbotSessions, chatbotMessages } from "@shared/schema";
import { randomUUID } from "node:crypto";
import { personaFor, buildPersonaSystem } from "../../lib/consultantPersona";
import { callUnifiedMuzaLLM } from "../../lib/llmCore";
import { loadHistoryForLLM } from "../../lib/chatHistory";
import { logUserActionFailure } from "../../lib/userActionFailures";
import { detectsYars, recordYarsMention } from "../../lib/yarsDetect";

const MAX_API = "https://platform-api.max.ru";
const TOKEN = () => process.env.MAX_BOT_TOKEN || "";
let bootRefs: { eventBus: BootContext["eventBus"]; logger: BootContext["logger"] } | null = null;

// Eugene 2026-05-12 (Босс): dedup по update_id / message_id.
const processedMaxMessages = new Map<string, number>();
function isMaxMsgDup(key: string | number | undefined): boolean {
  if (!key) return false;
  const k = String(key);
  const now = Date.now();
  for (const [kk, ts] of processedMaxMessages.entries()) {
    if (now - ts > 10 * 60_000) processedMaxMessages.delete(kk);
  }
  if (processedMaxMessages.has(k)) return true;
  processedMaxMessages.set(k, now);
  if (processedMaxMessages.size > 200) {
    const oldest = processedMaxMessages.keys().next().value;
    if (oldest !== undefined) processedMaxMessages.delete(oldest);
  }
  return false;
}

async function maxApi(p: string, body: any, method: "POST" | "GET" = "POST"): Promise<any> {
  const tok = TOKEN();
  if (!tok) throw new Error("MAX_BOT_TOKEN missing");
  const r = await fetch(`${MAX_API}${p}`, {
    method,
    headers: { Authorization: tok, "Content-Type": "application/json" },
    body: method === "POST" ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(10_000),
  });
  if (!r.ok) {
    const t = await r.text().catch(() => "");
    throw new Error(`Max ${p} ${r.status}: ${t.slice(0, 200)}`);
  }
  return r.json().catch(() => null);
}
async function sendMessage(chatId: string, text: string, attachments?: any[]) {
  try {
    const body: any = { text };
    if (attachments && attachments.length) body.attachments = attachments;
    await maxApi(`/messages?chat_id=${encodeURIComponent(chatId)}`, body);
  } catch (e) {
    bootRefs?.logger.warn?.("[max-bot] sendMessage failed", { chatId, error: String(e) });
  }
}
// Eugene 2026-05-11/12: образ помощника. URL с cache-bust версией
// (mtime PNG) — Max/нюанс кэшей не отдаёт устаревший файл.
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

async function sendConsultantPhoto(chatId: string, caption: string) {
  try {
    const base = process.env.PUBLIC_BASE_URL || "https://muzaai.ru";
    const photoUrl = `${base}/consultant-avatar.png?v=${getConsultantPhotoVersion()}`;
    await maxApi(`/messages?chat_id=${encodeURIComponent(chatId)}`, {
      text: caption,
      attachments: [{ type: "image", payload: { url: photoUrl } }],
    });
  } catch (e) {
    bootRefs?.logger.warn?.("[max-bot] sendPhoto failed, fallback to text", { chatId, error: String(e) });
    await sendMessage(chatId, caption);
  }
}

// Eugene 2026-05-16 Босс «один мозг для всех каналов» — Max-bot теперь
// идёт через единственную точку callUnifiedMuzaLLM (lib/llmCore.ts).
// Раньше у max-bot был свой одноразовый tryClaude БЕЗ history и БЕЗ
// MUZA_TOOLS. Теперь персистентная сессия + tools + cross-channel history.

// GPTunnel-fallback (gpt-4o-mini без tools) сохранён как последний резерв.
async function tryGPTunnelFallback(sys: string, text: string, history: Array<{ role: string; content: string }>): Promise<string | null> {
  const key = process.env.GPTUNNEL_API_KEY || "";
  if (!key) return null;
  try {
    const msgs = [
      { role: "system", content: sys },
      ...history.slice(-10).map(m => ({ role: m.role === "assistant" ? "assistant" : "user", content: m.content })),
      { role: "user", content: text },
    ];
    const r = await fetch("https://gptunnel.ru/v1/chat/completions", {
      method: "POST",
      headers: { Authorization: key, "Content-Type": "application/json" },
      body: JSON.stringify({ model: "gpt-4o-mini", max_tokens: 400, messages: msgs }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!r.ok) return null;
    const j: any = await r.json();
    return j?.choices?.[0]?.message?.content?.slice(0, 3500) || null;
  } catch { return null; }
}

// Сессия / история по chatId (Max external_id).
function findOrCreateMaxSession(chatId: string, userKey: string): { sessionId: string; userId: number | null } {
  try {
    const row = db.select().from(chatbotSessions).where(eq(chatbotSessions.externalId, chatId)).get() as any;
    if (row?.id) return { sessionId: row.id, userId: row.userId ?? null };
  } catch {}
  const sessionId = randomUUID();
  try {
    const lockedPersona = personaFor(userKey).name;
    db.insert(chatbotSessions).values({
      id: sessionId,
      channel: "max",
      externalId: chatId,
      state: "active",
      personaName: lockedPersona,
      startedAt: new Date().toISOString(),
      lastMessageAt: new Date().toISOString(),
    }).run();
  } catch {}
  return { sessionId, userId: null };
}

function saveMaxMessage(sessionId: string, role: "user" | "bot", text: string): void {
  try {
    db.insert(chatbotMessages).values({
      sessionId,
      role,
      text: text.slice(0, 3900),
      createdAt: new Date().toISOString(),
    }).run();
  } catch {}
}

async function generateReply(sessionId: string, userKey: string, text: string, authUserId: number | null): Promise<string> {
  // 1. Primary: единый Claude-call через llmCore (с MUZA_TOOLS + cross-channel history).
  const history = loadHistoryForLLM(sessionId, 15);
  const reply = await callUnifiedMuzaLLM({
    sessionId,
    userId: authUserId,
    channel: "max",
    userText: text,
    history,
    maxTokens: 400,
  });
  if (reply) return reply;

  // 2. Backup: GPTunnel (без tools).
  const sys = buildPersonaSystem(userKey);
  const o = await tryGPTunnelFallback(sys, text, history);
  if (o) return o;

  // 3. Все упали → hardcoded fallback + register failure.
  logUserActionFailure({
    channel: "max",
    action: "chat-reply",
    errorCode: "llm_both_failed",
    errorMessage: "Anthropic + GPTunnel оба не ответили — отдан hardcoded fallback",
    context: { userKey: String(userKey).slice(0, 32), textPreview: text.slice(0, 100) },
  });
  return `Здравствуйте! Я — Муза 🎵 Чуть-чуть тормозит — попробуйте через минуту.`;
}

const router = Router();

router.post("/webhook", async (req, res) => {
  res.status(200).send("ok");
  try {
    const u: any = req.body || {};
    const msg = u.message || u;
    const chatId = String(msg?.chat?.id ?? msg?.chat_id ?? msg?.peer_id ?? "");
    const fromId = String(msg?.sender?.user_id ?? msg?.from?.user_id ?? msg?.user_id ?? chatId);
    const text = String(msg?.body?.text ?? msg?.text ?? "").trim();
    if (!chatId || !text) return;
    // Dedup: Max может ретраить webhook → не отвечаем дважды на одно сообщение.
    const dedupKey = msg?.message_id || msg?.id || msg?.body?.mid || `${chatId}:${text.slice(0,30)}:${Math.floor(Date.now()/3000)}`;
    if (isMaxMsgDup(dedupKey)) {
      bootRefs?.logger.info?.("[max-bot] skipping duplicate", { key: String(dedupKey).slice(0, 30) });
      return;
    }
    const p = personaFor(fromId);
    const { sessionId, userId: authUserId } = findOrCreateMaxSession(chatId, fromId);
    if (text === "/start") {
      const hello = `${p.avatar} Привет! Я — Муза. Помогу подобрать песню под событие — для какого случая думаете?`;
      saveMaxMessage(sessionId, "user", text);
      await sendConsultantPhoto(chatId, hello);
      saveMaxMessage(sessionId, "bot", hello);
      return;
    }
    saveMaxMessage(sessionId, "user", text);
    // Eugene 2026-05-17: detection «Ярс» — расширенное логирование + alert.
    if (detectsYars(text)) {
      bootRefs?.logger.info?.("[YARS-MENTION]", {
        channel: "max",
        sessionId,
        userId: authUserId,
        text: text.slice(0, 200),
        timestamp: new Date().toISOString(),
      });
      recordYarsMention({ sessionId, userId: authUserId, channel: "max", text });
    }
    const reply = await generateReply(sessionId, fromId, text, authUserId);
    const cleanReply = reply.replace(/\s*[—\-–]+\s*(Муза|Аня|Татьяна|Мария|Ольга|Алексей|Дмитрий|Михаил|Андрей|Лиза|Полина|Кирилл|Артём|Маша|Лёша)(\s*·\s*(MuzaAi|MuzaAi))?\s*\.?\s*$/i, "").trimEnd();
    const footer = `\n\n— Муза · MuzaAi`;
    const replyWithAvatar = `${p.avatar} ${cleanReply}${footer}`;
    // Eugene 2026-05-12 (Босс «100%»): sendPhoto только на /start.
    // На остальных reply'ях текст с emoji-аватаром + footer.
    await sendMessage(chatId, replyWithAvatar);
    saveMaxMessage(sessionId, "bot", replyWithAvatar);
  } catch (e) {
    bootRefs?.logger.error?.("[max-bot] webhook error", { error: String(e) });
    logUserActionFailure({
      channel: "max",
      action: "webhook",
      errorCode: "webhook_handler_throw",
      errorMessage: String(e).slice(0, 300),
      endpoint: "/api/max-bot/webhook",
    });
  }
});

router.get("/info", async (_req, res) => {
  if (!TOKEN()) return res.json({ configured: false });
  try {
    const r = await fetch(`${MAX_API}/me`, { headers: { Authorization: TOKEN() } });
    const j = await r.json().catch(() => null);
    res.json({ configured: true, me: j });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

const maxBotModule: Module = {
  name: "max-bot",
  version: "0.1.0",
  description: "Max-bot helper (chat-assistant). Webhook: /api/max-bot/webhook. Без MAX_BOT_TOKEN — degraded.",
  publishes: [],
  routes: { prefix: "max-bot", router },
  onLoad: async (ctx) => {
    bootRefs = { eventBus: ctx.eventBus, logger: ctx.logger };
    ctx.logger.info("max-bot online", { token: TOKEN() ? "configured" : "missing" });
  },
  healthCheck: () => ({ status: TOKEN() ? "ok" : "degraded", details: { bot_token: !!TOKEN() } }),
};

export default maxBotModule;
