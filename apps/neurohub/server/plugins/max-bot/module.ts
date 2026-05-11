// Max-bot helper (Eugene 2026-05-11): отвечает в Max через тот же KB+persona
// что и telegram-bot. Webhook: /api/max-bot/webhook
import { Router } from "express";
import * as fs from "node:fs";
import * as path from "node:path";
import type { BootContext, Module } from "../../core";

const MAX_API = "https://platform-api.max.ru";
const TOKEN = () => process.env.MAX_BOT_TOKEN || "";
let bootRefs: { eventBus: BootContext["eventBus"]; logger: BootContext["logger"] } | null = null;

async function maxApi(p: string, body: any): Promise<any> {
  const tok = TOKEN();
  if (!tok) throw new Error("MAX_BOT_TOKEN missing");
  const r = await fetch(`${MAX_API}${p}`, {
    method: "POST",
    headers: { Authorization: tok, "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(10_000),
  });
  if (!r.ok) {
    const t = await r.text().catch(() => "");
    throw new Error(`Max ${p} ${r.status}: ${t.slice(0, 200)}`);
  }
  return r.json().catch(() => null);
}
async function sendMessage(chatId: string, text: string) {
  try {
    await maxApi(`/messages?chat_id=${encodeURIComponent(chatId)}`, { text });
  } catch (e) {
    bootRefs?.logger.warn?.("[max-bot] sendMessage failed", { chatId, error: String(e) });
  }
}

const PERSONAS = [
  { name: "Аня",     age: 27, tone: "тёплая, эмпатичная",        avatar: "🎀" },
  { name: "Татьяна", age: 29, tone: "энергичная, с юмором",      avatar: "✨" },
  { name: "Мария",   age: 28, tone: "вежливая, аккуратная",      avatar: "💎" },
  { name: "Ольга",   age: 30, tone: "спокойная, доброжелательная", avatar: "🌸" },
];
function personaFor(userKey: string) {
  let h = 0; const s = String(userKey || "anon");
  for (let i = 0; i < s.length; i++) h = ((h << 5) - h + s.charCodeAt(i)) | 0;
  return PERSONAS[Math.abs(h) % PERSONAS.length];
}

let kbCache: { text: string; mtime: number } = { text: "", mtime: 0 };
function loadKB(): string {
  for (const p of [
    "/opt/muziai-src/docs/strategy/KNOWLEDGE-BASE-BOT.md",
    "/var/www/neurohub/docs/strategy/KNOWLEDGE-BASE-BOT.md",
    path.join(process.cwd(), "docs/strategy/KNOWLEDGE-BASE-BOT.md"),
  ]) {
    try {
      if (!fs.existsSync(p)) continue;
      const stat = fs.statSync(p);
      if (kbCache.text && stat.mtimeMs === kbCache.mtime) return kbCache.text;
      const text = fs.readFileSync(p, "utf-8");
      kbCache = { text, mtime: stat.mtimeMs };
      return text;
    } catch {}
  }
  return kbCache.text || "";
}
function buildSystem(userKey: string): string {
  const p = personaFor(userKey);
  const kb = loadKB() || "[KB недоступен]";
  return `Ты — ${p.name}, ${p.age} лет, support-агент MuziAi. ${p.tone}. Отвечай кратко (2-4 предложения), 1-2 эмодзи, на «вы» если юзер не на «ты». Не упоминай AI/бот, представляйся ${p.name}.\n\nБаза знаний:\n${kb}\n\nГовори живо как человек, без markdown-списков.`;
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
  const sys = buildSystem(userKey);
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
      await sendMessage(chatId, `${p.avatar} Здравствуйте! Я ${p.name} из MuziAi 🎵\nПомогу подобрать песню под событие. Для какого случая думаете песню?`);
      return;
    }
    const reply = await generateReply(fromId, text);
    await sendMessage(chatId, `${p.avatar} ${reply}`);
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
