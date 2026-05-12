// Max-bot helper (Eugene 2026-05-11): отвечает в Max через тот же KB+persona
// что и telegram-bot. Webhook: /api/max-bot/webhook
// Refactored: persona + KB + prompt → shared lib (lib/consultantPersona).
import { Router } from "express";
import type { BootContext, Module } from "../../core";
import { personaFor, buildPersonaSystem } from "../../lib/consultantPersona";

const MAX_API = "https://platform-api.max.ru";
const TOKEN = () => process.env.MAX_BOT_TOKEN || "";
let bootRefs: { eventBus: BootContext["eventBus"]; logger: BootContext["logger"] } | null = null;

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
// Eugene 2026-05-11: образ помощника на /start — тот же singer-silhouette
// что в Telegram + на сайте. Max API принимает attachment с type=image.
async function sendConsultantPhoto(chatId: string, caption: string) {
  try {
    const base = process.env.PUBLIC_BASE_URL || "https://muziai.ru";
    const photoUrl = `${base}/api/assets/consultant-avatar.png?size=512`;
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
      headers: { "x-api-key": key, "anthropic-version": "2023-06-01", "content-type": "application/json" },
      body: JSON.stringify({ model: "claude-haiku-4-5-20251001", max_tokens: 400, system: sys, messages: [{ role: "user", content: text }] }),
      signal: AbortSignal.timeout(15_000),
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
  return `Здравствуйте! Я ${personaFor(userKey).name} 🎵 Чуть-чуть тормозит — попробуйте через минуту.`;
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
    const p = personaFor(fromId);
    if (text === "/start") {
      const hello = `${p.avatar} Привет! Я ${p.name} из MuziAi. Помогу подобрать песню под событие — для какого случая думаете?`;
      await sendConsultantPhoto(chatId, hello);
      return;
    }
    const reply = await generateReply(fromId, text);
    const replyWithAvatar = `${p.avatar} ${reply}`;
    // Образ помощницы в каждом ответе (Eugene 2026-05-11).
    if (replyWithAvatar.length <= 1000) {
      await sendConsultantPhoto(chatId, replyWithAvatar);
    } else {
      await sendMessage(chatId, replyWithAvatar);
    }
  } catch (e) {
    bootRefs?.logger.error?.("[max-bot] webhook error", { error: String(e) });
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
