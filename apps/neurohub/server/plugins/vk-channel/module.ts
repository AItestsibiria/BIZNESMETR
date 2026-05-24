// vk-channel plugin (Eugene 2026-05-23).
//
// VK Community Callback API integration:
//   POST /api/vk/callback — webhook от VK (confirmation / message_new / group_join / wall_post_new)
//   GET  /api/vk/health   — диагностика
//
// Музa отвечает в VK community DM через тот же callUnifiedMuzaLLM
// pipeline что и web/Telegram/Max — единая cross-channel persona (Музa — 25 лет, женский голос),
// единый thread через loadHistoryForLLM (Cross-channel conversation linking rule).
//
// VK Callback API docs:
// - https://dev.vk.com/api/callback/getting-started
// - https://dev.vk.com/method/groups.getCallbackConfirmationCode
//
// Жёсткие требования (CLAUDE.md):
// - Bot-webhook-dedup rule: dedup по object.message.id / event_id
// - Secret validation через timing-safe compare (если VK_SECRET задан)
// - User-action-failure registry rule: ошибки в user_action_failures
// - Single-persona-across-channels rule: Муза = тот же gender + tone
// - Musa-female-voice rule: female prompt уже инжектится в buildPersonaSystem

import { Router } from "express";
import { eq, sql } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import * as crypto from "node:crypto";

import type { BootContext, Module } from "../../core";
import { db } from "../../storage";
import { chatbotSessions, chatbotMessages } from "@shared/schema";
import { callUnifiedMuzaLLM } from "../../lib/llmCore";
import { detectMuzaToolIntent } from "../../lib/muzaIntentRouter";
import { loadHistoryForLLM } from "../../lib/chatHistory";
import { logUserActionFailure } from "../../lib/userActionFailures";
import { vkSendMessage, vkConfigStatus } from "../../lib/vkApi";

const CONFIRMATION_CODE = () => process.env.VK_CONFIRMATION_CODE || "";
const VK_SECRET = () => process.env.VK_SECRET || "";

let bootRefs: { eventBus: BootContext["eventBus"]; logger: BootContext["logger"] } | null = null;

// === Dedup (Bot-webhook-dedup rule) ===

const processedVkEvents = new Map<string, number>();
function isVkEventDup(key: string | number | undefined): boolean {
  if (!key) return false;
  const k = String(key);
  const now = Date.now();
  // GC старых записей (TTL 10 мин)
  for (const [kk, ts] of processedVkEvents.entries()) {
    if (now - ts > 10 * 60_000) processedVkEvents.delete(kk);
  }
  if (processedVkEvents.has(k)) return true;
  processedVkEvents.set(k, now);
  if (processedVkEvents.size > 500) {
    const oldest = processedVkEvents.keys().next().value;
    if (oldest !== undefined) processedVkEvents.delete(oldest);
  }
  return false;
}

// === Secret validation (timing-safe) ===

function verifyVkSecret(got: string | undefined | null): boolean {
  const expected = VK_SECRET();
  if (!expected) {
    // Если VK_SECRET не задан в .env — пропускаем (VK позволяет работу без секрета,
    // но в проде Босс ОБЯЗАН задать. См. /api/admin/v304/vk/status warning).
    return true;
  }
  if (!got) return false;
  const a = Buffer.from(String(got), "utf8");
  const b = Buffer.from(expected, "utf8");
  if (a.length !== b.length) return false;
  try {
    return crypto.timingSafeEqual(a, b);
  } catch {
    return false;
  }
}

// === Session helpers ===

interface VkSessionRow {
  id: string;
  channel: string;
  externalId: string | null;
  userId: number | null;
}

function loadOrCreateVkSession(vkUserId: string | number): VkSessionRow {
  const external = String(vkUserId);
  const existing = db.get<VkSessionRow>(
    sql`SELECT id, channel, external_id as externalId, user_id as userId
        FROM chatbot_sessions
        WHERE channel = 'vk' AND external_id = ${external}
        LIMIT 1`,
  );
  if (existing) return existing;

  const id = randomUUID();
  db.run(sql`INSERT INTO chatbot_sessions (id, channel, external_id, fsm_state, fsm_data)
             VALUES (${id}, 'vk', ${external}, 'menu', '{}')`);
  return { id, channel: "vk", externalId: external, userId: null };
}

function saveVkMessage(
  sessionId: string,
  role: "user" | "bot" | "system",
  text: string,
  meta?: Record<string, unknown>,
): void {
  try {
    db.insert(chatbotMessages).values({
      sessionId,
      role,
      text: String(text || "").slice(0, 4000),
      meta: meta ? (JSON.stringify(meta) as any) : null,
    }).run();
  } catch (e) {
    bootRefs?.logger.error("[vk-channel] saveVkMessage failed", {
      error: e instanceof Error ? e.message : String(e),
    });
  }
}

// === LLM reply pipeline (по аналогии с max-bot) ===

async function generateVkReply(
  sessionId: string,
  vkUserId: string,
  text: string,
  authUserId: number | null,
): Promise<string> {
  const history = loadHistoryForLLM(sessionId, 15);
  // forceAnthropic для player/panel/generation intent — иначе DeepSeek (primary)
  // вернёт text без tool-use → команды не выполнятся в VK. См. muzaIntentRouter.ts.
  const forceAnthropic = detectMuzaToolIntent(text);
  try {
    const reply = await callUnifiedMuzaLLM({
      sessionId,
      userId: authUserId,
      channel: "vk",
      userText: text,
      history,
      maxTokens: 400,
      role: null,
      forceAnthropic,
    });
    if (reply) return reply;
  } catch (e) {
    bootRefs?.logger.error("[vk-channel] LLM call failed", {
      error: e instanceof Error ? e.message : String(e),
      vkUserId,
    });
  }

  // LLM полностью упал — User-action-failure rule
  logUserActionFailure({
    channel: "vk",
    action: "chat-reply",
    errorCode: "llm_failed",
    errorMessage: "callUnifiedMuzaLLM не ответил в vk-channel",
    context: { vkUserId: String(vkUserId).slice(0, 32), textPreview: text.slice(0, 100) },
  });

  return "Здравствуй! Я — Муза 🎵 Чуть-чуть тормозит — попробуй через минуту.";
}

// === Webhook handler ===

const router = Router();

router.post("/callback", async (req, res) => {
  const body: any = req.body || {};
  const type = String(body.type || "");

  // 1. CONFIRMATION — VK требует plain-text ответ confirmation code
  if (type === "confirmation") {
    const code = CONFIRMATION_CODE();
    if (!code) {
      bootRefs?.logger.warn("[vk-channel] confirmation: VK_CONFIRMATION_CODE not configured");
      return res.status(500).type("text").send("VK_CONFIRMATION_CODE not configured");
    }
    bootRefs?.logger.info("[vk-channel] confirmation responded", { groupId: body.group_id });
    return res.type("text").send(code);
  }

  // 2. SECRET verification (после confirmation чтобы не блокировать setup)
  if (!verifyVkSecret(body.secret)) {
    bootRefs?.logger.warn("[vk-channel] invalid secret", { type, groupId: body.group_id });
    return res.status(401).type("text").send("invalid secret");
  }

  // 3. Идемпотентность по event_id (если VK его передал) или по object.message.id
  const eventId = body.event_id || body?.object?.message?.id || body?.object?.id;
  if (isVkEventDup(eventId)) {
    bootRefs?.logger.info("[vk-channel] duplicate event ignored", { eventId, type });
    return res.type("text").send("ok");
  }

  try {
    if (type === "message_new") {
      await handleMessageNew(body.object?.message || body.object);
    } else if (type === "group_join") {
      await handleGroupJoin(body.object);
    } else if (type === "group_leave") {
      await handleGroupLeave(body.object);
    } else if (type === "wall_post_new") {
      // Audit-only — не отвечаем, но логируем
      bootRefs?.logger.info("[vk-channel] wall_post_new", { postId: body.object?.id });
    } else {
      bootRefs?.logger.info("[vk-channel] unknown event type", { type });
    }
  } catch (e) {
    bootRefs?.logger.error("[vk-channel] handler error", {
      error: e instanceof Error ? e.message : String(e),
      type,
    });
    logUserActionFailure({
      channel: "vk",
      action: `webhook:${type}`,
      errorCode: "handler_exception",
      errorMessage: e instanceof Error ? e.message.slice(0, 300) : "unknown",
    });
  }

  // VK всегда ожидает plain "ok" в ответ (иначе retry до 10 раз)
  return res.type("text").send("ok");
});

async function handleMessageNew(message: any): Promise<void> {
  if (!message || typeof message !== "object") return;
  const fromId = message.from_id;
  const text: string = String(message.text || "").trim();

  if (!fromId || fromId <= 0) {
    bootRefs?.logger.warn("[vk-channel] message_new: invalid from_id", { fromId });
    return;
  }

  const session = loadOrCreateVkSession(fromId);

  // Save user message
  saveVkMessage(session.id, "user", text || "[empty]", {
    vkMessageId: message.id,
    vkPeerId: message.peer_id,
  });

  if (!text) {
    // Юзер прислал стикер/audio/photo без текста — короткий ответ
    const reply = "Привет! 🎵 Пока я понимаю только текст. Напиши, что бы ты хотела создать на MuzaAi?";
    saveVkMessage(session.id, "bot", reply);
    const r = await vkSendMessage({ userId: fromId, text: reply });
    if (!r.ok) {
      bootRefs?.logger.error("[vk-channel] vkSendMessage failed", { error: r.error });
      logUserActionFailure({
        channel: "vk",
        action: "send-message",
        errorCode: "vk_send_failed",
        errorMessage: r.error,
      });
    }
    return;
  }

  const reply = await generateVkReply(session.id, String(fromId), text, session.userId);

  // Cleanup web-specific markers (PROPOSE_GEN, QR, SWITCH_PERSONA) — VK не понимает
  const cleanReply = reply
    .replace(/\[PROPOSE_GEN:[\s\S]{0,800}?\]/gi, "")
    .replace(/\[PROPOSE_REGISTER:[\s\S]{0,400}?\]/gi, "")
    .replace(/\[QR:[^\]]+\]/gi, "")
    .replace(/\[SWITCH_PERSONA:[^\]]+\]/gi, "")
    .trim();

  const finalReply = cleanReply || "Слушаю тебя 🎵 Расскажи к какому событию подбираем песню?";

  saveVkMessage(session.id, "bot", finalReply, { userId: session.userId });

  const sendResult = await vkSendMessage({ userId: fromId, text: finalReply });
  if (!sendResult.ok) {
    bootRefs?.logger.error("[vk-channel] reply send failed", {
      error: sendResult.error,
      vkUserId: fromId,
    });
    logUserActionFailure({
      channel: "vk",
      action: "send-message",
      errorCode: "vk_send_failed",
      errorMessage: sendResult.error,
      context: { vkUserId: String(fromId) },
    });
  }
}

async function handleGroupJoin(obj: any): Promise<void> {
  const userId = obj?.user_id;
  if (!userId) return;
  bootRefs?.logger.info("[vk-channel] group_join", { vkUserId: userId, joinType: obj?.join_type });
  // Audit-only пока (можно потом slать welcome DM, но это другая фича)
}

async function handleGroupLeave(obj: any): Promise<void> {
  const userId = obj?.user_id;
  if (!userId) return;
  bootRefs?.logger.info("[vk-channel] group_leave", { vkUserId: userId, self: obj?.self });
}

// === Health endpoint ===

router.get("/health", (_req, res) => {
  const status = vkConfigStatus();
  let recentMessages = 0;
  let recentReplies = 0;
  try {
    const since = Date.now() - 24 * 60 * 60 * 1000;
    const row = db.get<{ msgs: number; replies: number }>(
      sql`SELECT
            (SELECT COUNT(*) FROM chatbot_messages m
              JOIN chatbot_sessions s ON s.id = m.session_id
              WHERE s.channel = 'vk' AND m.role = 'user'
                AND m.created_at > ${new Date(since).toISOString()}) AS msgs,
            (SELECT COUNT(*) FROM chatbot_messages m
              JOIN chatbot_sessions s ON s.id = m.session_id
              WHERE s.channel = 'vk' AND m.role = 'bot'
                AND m.created_at > ${new Date(since).toISOString()}) AS replies`,
    );
    recentMessages = row?.msgs ?? 0;
    recentReplies = row?.replies ?? 0;
  } catch {}

  res.json({
    data: {
      ...status,
      last24h: { messages: recentMessages, replies: recentReplies },
      webhookPath: "/api/vk/callback",
    },
    error: null,
  });
});

const vkChannelModule: Module = {
  name: "vk-channel",
  version: "0.1.0",
  description: "VK Community Callback API — Музa отвечает в DM, диагностика, postable wall",
  routes: { prefix: "vk", router },
  publishes: ["vk.message.received", "vk.group.joined", "vk.group.left"],
  subscribes: {},
  onLoad: async (ctx) => {
    bootRefs = { eventBus: ctx.eventBus, logger: ctx.logger };
    const status = vkConfigStatus();
    if (!status.configured) {
      ctx.logger.warn("[vk-channel] not fully configured — webhook /api/vk/callback live but inert", {
        hasToken: status.hasAccessToken,
        hasGroupId: !!status.groupId,
        hasConfirmation: status.hasConfirmationCode,
        hasSecret: status.hasSecret,
      });
    } else {
      ctx.logger.info("[vk-channel] online — webhook /api/vk/callback", {
        groupId: status.groupId,
      });
    }
  },
  healthCheck: () => {
    const status = vkConfigStatus();
    if (!status.configured) {
      return {
        status: "degraded",
        details: {
          reason: "VK_ACCESS_TOKEN / VK_GROUP_ID / VK_CONFIRMATION_CODE missing — set in .env",
          hasToken: status.hasAccessToken,
          hasGroupId: !!status.groupId,
          hasConfirmation: status.hasConfirmationCode,
          hasSecret: status.hasSecret,
        },
      };
    }
    return { status: "ok", details: { groupId: status.groupId } };
  },
};

export default vkChannelModule;
