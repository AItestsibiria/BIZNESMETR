// Max-bot helper (Eugene 2026-05-11): отвечает в Max через тот же KB+persona
// что и telegram-bot. Webhook: /api/max-bot/webhook
// Refactored: persona + KB + prompt → shared lib (lib/consultantPersona).
import { Router } from "express";
import type { BootContext, Module } from "../../core";
import { personaFor, buildPersonaSystem } from "../../lib/consultantPersona";
import { logUserActionFailure } from "../../lib/userActionFailures";

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
    const base = process.env.PUBLIC_BASE_URL || "https://muziai.ru";
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

async function tryClaude(sys: string, text: string): Promise<string | null> {
  const key = process.env.ANTHROPIC_API_KEY_BOT || process.env.ANTHROPIC_API_KEY || "";
  if (!key) return null;
  try {
    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "x-api-key": key, "anthropic-version": "2023-06-01", "anthropic-beta": "extended-cache-ttl-2025-04-11", "content-type": "application/json" },
      body: JSON.stringify({
        model: "claude-haiku-4-5-20251001",
        max_tokens: 130,
        system: [{ type: "text", text: sys, cache_control: { type: "ephemeral", ttl: "1h" } }],
        messages: [{ role: "user", content: text }],
      }),
      signal: AbortSignal.timeout(8_000),
    });
    if (!r.ok) return null;
    const j: any = await r.json();
    return j?.content?.[0]?.text?.slice(0, 3500) || null;
  } catch { return null; }
}
async function tryGPTunnel(sys: string, text: string): Promise<string | null> {
  const key = process.env.GPTUNNEL_API_KEY || "";
  if (!key) return null;
  try {
    const r = await fetch("https://gptunnel.ru/v1/chat/completions", {
      method: "POST",
      headers: { Authorization: key, "Content-Type": "application/json" },
      body: JSON.stringify({ model: "gpt-4o-mini", max_tokens: 400, messages: [{ role: "system", content: sys }, { role: "user", content: text }] }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!r.ok) return null;
    const j: any = await r.json();
    return j?.choices?.[0]?.message?.content?.slice(0, 3500) || null;
  } catch { return null; }
}
async function generateReply(userKey: string, text: string): Promise<string> {
  const sys = buildPersonaSystem(userKey);
  const c = await tryClaude(sys, text);
  if (c) return c;
  const o = await tryGPTunnel(sys, text);
  if (o) return o;
  logUserActionFailure({
    channel: "max",
    action: "chat-reply",
    errorCode: "llm_both_failed",
    errorMessage: "Claude + GPTunnel оба не ответили — отдан hardcoded fallback",
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
    if (text === "/start") {
      const hello = `${p.avatar} Привет! Я — Муза. Помогу подобрать песню под событие — для какого случая думаете?`;
      await sendConsultantPhoto(chatId, hello);
      return;
    }
    const reply = await generateReply(fromId, text);
    const cleanReply = reply.replace(/\s*[—\-–]+\s*(Муза|Аня|Татьяна|Мария|Ольга|Алексей|Дмитрий|Михаил|Андрей|Лиза|Полина|Кирилл|Артём|Маша|Лёша)(\s*·\s*(MuzaAi|MuzaAi))?\s*\.?\s*$/i, "").trimEnd();
    const footer = `\n\n— Муза · MuzaAi`;
    const replyWithAvatar = `${p.avatar} ${cleanReply}${footer}`;
    // Eugene 2026-05-12 (Босс «100%»): sendPhoto только на /start.
    // На остальных reply'ях текст с emoji-аватаром + footer.
    await sendMessage(chatId, replyWithAvatar);
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
