// Eugene 2026-05-20 Босс «1+2 — transactional + inbound IMAP канал».
//
// Email-канал Музы: юзер пишет на hello@muzaai.ru → IMAP listener подхватывает
// новые письма каждые 60 сек → парсит через mailparser → LLM генерирует ответ
// → SMTP шлёт reply.
//
// Cross-channel linking: email юзера ищется в users.email — если найден,
// chatbotSessions.userId связывается с auth-аккаунтом (для history + memory).
//
// ENV: IMAP_HOST, IMAP_PORT (993), IMAP_USER, IMAP_PASS, IMAP_MAILBOX (default INBOX),
// + SMTP_* для исходящих (см. emailSender.ts).
//
// Polling interval: IMAP_POLL_SEC (default 60).
// При отсутствии IMAP_* — плагин degraded.

import { Router } from "express";
import { eq, desc, and } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import type { BootContext, Module } from "../../core";
import { db } from "../../storage";
import { chatbotSessions, chatbotMessages, users } from "@shared/schema";

let bootRefs: { eventBus: BootContext["eventBus"]; logger: BootContext["logger"] } | null = null;
let pollingTimer: NodeJS.Timeout | null = null;
let lastPollAt = 0;
let lastErrorMsg = "";
let lastSuccessUid = 0;
let totalProcessed = 0;
let lastReplyAt = 0;

interface ImapConfig {
  host: string;
  port: number;
  user: string;
  pass: string;
  mailbox: string;
}

function loadImapConfig(): ImapConfig | null {
  const host = process.env.IMAP_HOST;
  const user = process.env.IMAP_USER;
  const pass = process.env.IMAP_PASS;
  if (!host || !user || !pass) return null;
  return {
    host,
    port: parseInt(process.env.IMAP_PORT || "993", 10),
    user,
    pass,
    mailbox: process.env.IMAP_MAILBOX || "INBOX",
  };
}

function safeEmail(s: string): string {
  return String(s || "").toLowerCase().trim();
}

function extractName(fromAddress: any): string {
  if (fromAddress?.value?.[0]?.name) return String(fromAddress.value[0].name).trim();
  return "";
}

function extractEmail(fromAddress: any): string {
  if (fromAddress?.value?.[0]?.address) return safeEmail(fromAddress.value[0].address);
  return "";
}

function findOrCreateEmailSession(
  fromEmail: string,
  fromName: string,
): { sessionId: string; userId: number | null } {
  try {
    const existing = db.select()
      .from(chatbotSessions)
      .where(and(
        eq(chatbotSessions.channel, "email"),
        eq(chatbotSessions.externalId, fromEmail),
      ))
      .limit(1)
      .get() as any;
    if (existing?.id) {
      return { sessionId: existing.id, userId: existing.userId };
    }
  } catch {}

  let linkedUserId: number | null = null;
  try {
    const u = db.select()
      .from(users)
      .where(eq(users.email, fromEmail))
      .limit(1)
      .get() as any;
    if (u?.id) linkedUserId = u.id;
  } catch {}

  const sessionId = randomUUID();
  try {
    db.insert(chatbotSessions).values({
      id: sessionId,
      channel: "email",
      externalId: fromEmail,
      userId: linkedUserId,
      state: "active",
      personaName: "Музa",
      createdAt: new Date().toISOString(),
      lastMessageAt: new Date().toISOString(),
      userProfile: fromName ? JSON.stringify({ name: fromName }) : null,
    } as any).run();
  } catch (e: any) {
    bootRefs?.logger.warn?.("[email-channel] failed to create session", { error: String(e?.message || e) });
  }
  return { sessionId, userId: linkedUserId };
}

function saveEmailMessage(sessionId: string, role: "user" | "bot", text: string, meta?: any): void {
  try {
    db.insert(chatbotMessages).values({
      id: randomUUID(),
      sessionId,
      role,
      content: text.slice(0, 8000),
      createdAt: new Date().toISOString(),
      meta: meta ? JSON.stringify(meta) : null,
    } as any).run();
    db.update(chatbotSessions)
      .set({ lastMessageAt: new Date().toISOString() } as any)
      .where(eq(chatbotSessions.id, sessionId))
      .run();
  } catch (e: any) {
    bootRefs?.logger.warn?.("[email-channel] failed to save message", { error: String(e?.message || e) });
  }
}

function buildHistoryForLlm(sessionId: string, maxMessages = 12): Array<{ role: "user" | "assistant"; content: string }> {
  try {
    const rows = db.select()
      .from(chatbotMessages)
      .where(eq(chatbotMessages.sessionId, sessionId))
      .orderBy(desc(chatbotMessages.createdAt))
      .limit(maxMessages)
      .all() as any[];
    return rows
      .reverse()
      .map(r => ({
        role: r.role === "bot" ? ("assistant" as const) : ("user" as const),
        content: String(r.content || "").slice(0, 4000),
      }))
      .filter(m => m.content);
  } catch {
    return [];
  }
}

async function generateMusaReplyForEmail(opts: {
  sessionId: string;
  userId: number | null;
  fromEmail: string;
  fromName: string;
  subject: string;
  body: string;
}): Promise<string> {
  try {
    let systemPrompt = "";
    try {
      const { buildPersonaSystem } = await import("../../lib/consultantPersona");
      systemPrompt = (buildPersonaSystem as any)({
        muzaRole: opts.userId ? "user" : null,
        userName: opts.fromName,
        channel: "email",
      });
    } catch {
      systemPrompt = `Ты — Музa, 25-летняя девушка, друг и менеджер автора в MuzaAi.
Все глаголы и прилагательные о себе — в женском роде (подобрала, рада, готова).
Это email-канал — отвечай ёмко (2-4 абзаца), без markdown, простым текстом.
Юзер: ${opts.fromName || opts.fromEmail}.
${opts.userId ? "Зарегистрированный автор." : "Новый юзер."}`;
    }

    const history = buildHistoryForLlm(opts.sessionId);
    history.push({ role: "user", content: `Тема: ${opts.subject}\n\n${opts.body}` });

    let reply = "";
    try {
      const llmCore = await import("../../lib/llmCore");
      const fn = (llmCore as any).callLlm || (llmCore as any).default?.callLlm;
      if (fn) {
        const r = await fn(history, systemPrompt);
        if (r?.ok && r?.text) reply = String(r.text);
      }
    } catch (e: any) {
      bootRefs?.logger.warn?.("[email-channel] llmCore not available", { error: String(e?.message || e) });
    }

    if (!reply) {
      reply = `Привет${opts.fromName ? `, ${opts.fromName}` : ""}!

Я получила твоё письмо. Отвечу как только смогу подробнее.

Если нужно срочно — заходи в чат на ${process.env.PUBLIC_BASE_URL || "https://muzaai.ru"}, там я всегда онлайн.

— Музa, MuzaAi`;
    }
    return reply;
  } catch (e: any) {
    bootRefs?.logger.warn?.("[email-channel] generateMusaReplyForEmail failed", { error: String(e?.message || e) });
    return `Привет! Получила твоё письмо, отвечу скоро.\n\n— Музa`;
  }
}

async function sendEmailReply(opts: {
  to: string;
  subject: string;
  bodyText: string;
}): Promise<{ ok: boolean; error?: string }> {
  try {
    const { sendEmail } = await import("../../lib/emailSender");
    const subj = opts.subject.startsWith("Re:") ? opts.subject : `Re: ${opts.subject}`;
    const r = await sendEmail({
      to: opts.to,
      subject: subj,
      text: opts.bodyText,
      kind: "muza-reply",
    });
    return { ok: !!r.ok, error: r.error };
  } catch (e: any) {
    return { ok: false, error: String(e?.message || e) };
  }
}

async function processOneMessage(parsed: any): Promise<void> {
  try {
    const fromEmail = extractEmail(parsed.from);
    const fromName = extractName(parsed.from);
    if (!fromEmail) return;

    const ourFrom = (process.env.SMTP_FROM || process.env.GMAIL_FROM || "").toLowerCase();
    if (ourFrom && ourFrom.includes(fromEmail)) return; // loop guard

    const subject = String(parsed.subject || "(без темы)").slice(0, 200);
    const body = String(parsed.text || parsed.textAsHtml || "").slice(0, 6000).trim();
    if (!body) return;

    const { sessionId, userId } = findOrCreateEmailSession(fromEmail, fromName);
    saveEmailMessage(sessionId, "user", body, { subject, messageId: parsed.messageId, from: fromEmail });

    const reply = await generateMusaReplyForEmail({
      sessionId, userId, fromEmail, fromName, subject, body,
    });

    const sendResult = await sendEmailReply({ to: fromEmail, subject, bodyText: reply });

    if (sendResult.ok) {
      saveEmailMessage(sessionId, "bot", reply, { sentTo: fromEmail });
      lastReplyAt = Date.now();
      totalProcessed += 1;
      try { bootRefs?.eventBus?.publish?.("chatbot.reply_sent", { channel: "email", sessionId, to: fromEmail }); } catch {}
    } else {
      bootRefs?.logger.warn?.("[email-channel] send reply failed", { to: fromEmail, error: sendResult.error });
    }
  } catch (e: any) {
    bootRefs?.logger.warn?.("[email-channel] processOneMessage exception", { error: String(e?.message || e) });
  }
}

async function pollOnce(): Promise<void> {
  const config = loadImapConfig();
  if (!config) return;

  let ImapFlow: any;
  let simpleParser: any;
  try {
    ({ ImapFlow } = require("imapflow"));
    ({ simpleParser } = require("mailparser"));
  } catch (e: any) {
    lastErrorMsg = `npm deps missing: ${e?.message || e}`;
    return;
  }

  const client = new ImapFlow({
    host: config.host,
    port: config.port,
    secure: true,
    auth: { user: config.user, pass: config.pass },
    logger: false,
  });

  try {
    await client.connect();
    await client.mailboxOpen(config.mailbox);
    let count = 0;
    for await (const msg of client.fetch({ seen: false }, { source: true, uid: true })) {
      if (count >= 20) break;
      try {
        const parsed = await simpleParser(msg.source);
        await processOneMessage(parsed);
        await client.messageFlagsAdd({ uid: msg.uid }, ["\\Seen"]);
        lastSuccessUid = msg.uid;
        count += 1;
      } catch (e: any) {
        bootRefs?.logger.warn?.("[email-channel] failed to process uid", { uid: msg.uid, error: String(e?.message || e) });
      }
    }
    lastPollAt = Date.now();
    if (count > 0) bootRefs?.logger.info?.(`[email-channel] processed ${count} new emails`);
    lastErrorMsg = "";
  } catch (e: any) {
    lastErrorMsg = String(e?.message || e).slice(0, 300);
    bootRefs?.logger.warn?.("[email-channel] poll exception", { error: lastErrorMsg });
  } finally {
    try { await client.logout(); } catch {}
  }
}

function startPolling(intervalSec: number): void {
  if (pollingTimer) clearInterval(pollingTimer);
  pollingTimer = setInterval(() => {
    pollOnce().catch(e => bootRefs?.logger.warn?.("[email-channel] pollOnce uncaught", { error: String(e?.message || e) }));
  }, intervalSec * 1000);
  pollOnce().catch(() => {});
}

// === Admin Router ===

const router = Router();

router.get("/status", async (_req, res) => {
  const config = loadImapConfig();
  res.json({
    ok: true,
    configured: !!config,
    config: config ? {
      host: config.host,
      port: config.port,
      user_first: config.user.slice(0, 6) + "***",
      mailbox: config.mailbox,
    } : null,
    polling: !!pollingTimer,
    lastPollAt: lastPollAt ? new Date(lastPollAt).toISOString() : null,
    lastReplyAt: lastReplyAt ? new Date(lastReplyAt).toISOString() : null,
    lastSuccessUid,
    totalProcessed,
    lastError: lastErrorMsg || null,
  });
});

router.post("/poll-now", async (_req, res) => {
  await pollOnce();
  res.json({
    ok: true,
    lastPollAt: new Date(lastPollAt).toISOString(),
    lastError: lastErrorMsg || null,
    totalProcessed,
  });
});

// === Module entry ===

const emailChannelModule: Module = {
  name: "email-channel",
  version: "0.1.0",
  description: "Email-канал Музы: IMAP polling новых писем + LLM reply через SMTP. Cross-channel linking через users.email. Без IMAP_* — degraded.",
  publishes: ["chatbot.reply_sent"],
  routes: { prefix: "admin/v304/email-channel", router },
  onLoad: async (ctx) => {
    bootRefs = { eventBus: ctx.eventBus, logger: ctx.logger };
    const config = loadImapConfig();
    if (!config) {
      ctx.logger.warn("email-channel: degraded — IMAP_HOST/USER/PASS not set");
      return;
    }
    const intervalSec = parseInt(process.env.IMAP_POLL_SEC || "60", 10);
    ctx.logger.info(`email-channel: starting IMAP polling (${intervalSec}s) — ${config.host}:${config.port} mailbox=${config.mailbox}`);
    startPolling(intervalSec);
  },
  healthCheck: () => {
    const config = loadImapConfig();
    return {
      status: config ? "ok" : "degraded",
      details: {
        configured: !!config,
        polling: !!pollingTimer,
        lastPollAt: lastPollAt ? new Date(lastPollAt).toISOString() : null,
        totalProcessed,
      },
    };
  },
};

export default emailChannelModule;
