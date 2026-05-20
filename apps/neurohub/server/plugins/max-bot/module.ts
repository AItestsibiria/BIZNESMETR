// Max-bot — chat-assistant в Max messenger (платформа max.ru).
//
// Endpoints:
//   POST /api/max-bot/webhook            — приём update'ов от Max
//   GET  /api/max-bot/info               — диагностика: getMe + webhook info
//   GET  /api/max-bot/setup-webhook      — установить webhook URL (secret-protected)
//
// Persona + KB + LLM — единая точка callUnifiedMuzaLLM (lib/llmCore.ts).
// Cross-channel history через loadHistoryForLLM. Memory inject через
// buildMemoryContext для авторизованных юзеров.
//
// Дедупликация по update_id / message_id (Bot-webhook-dedup rule).
// Webhook secret-token verification (если MAX_WEBHOOK_SECRET задан).
//
// Eugene 2026-05-20 (subagent setup-max): полная настройка по аналогии с
// telegram-bot. Cross-channel memory + female voice persona + attached_track.

import { Router } from "express";
import { eq } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import * as crypto from "node:crypto";

import type { BootContext, Module } from "../../core";
import { db } from "../../storage";
import { chatbotSessions, chatbotMessages, users, generations } from "@shared/schema";
import { personaFor, buildPersonaSystem } from "../../lib/consultantPersona";
import { callUnifiedMuzaLLM } from "../../lib/llmCore";
import { loadHistoryForLLM } from "../../lib/chatHistory";
import { logUserActionFailure } from "../../lib/userActionFailures";
import { detectsYars, recordYarsMention } from "../../lib/yarsDetect";
import { buildMemoryContext, scheduleCompressionIfNeeded } from "../../lib/userMemory";
import { storage } from "../../storage";

// === Конфиг ===

// Max Business API base URL. Босс предоставил docs:
// https://dev.max.ru/docs/maxbusiness/selectionservices
// Современный endpoint для ботов — `botapi.max.ru` (см.
// plugins/bot-channels-health которая делает GET /me туда). Legacy
// `platform-api.max.ru` оставлен для backward-compat (некоторые endpoints
// проекта ещё на нём).
const MAX_API_PRIMARY = process.env.MAX_API_BASE || "https://botapi.max.ru";
const MAX_API_LEGACY = "https://platform-api.max.ru";

const TOKEN = () => process.env.MAX_BOT_TOKEN || "";
const WEBHOOK_SECRET = () => process.env.MAX_WEBHOOK_SECRET || "";

let bootRefs: { eventBus: BootContext["eventBus"]; logger: BootContext["logger"] } | null = null;

// === Dedup (Bot-webhook-dedup rule) ===

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

// === Admin alert на repeated downtime ===

const lastDowntimeAlertAt = new Map<string, number>();
function notifyAdminMaxDowntime(reason: string): void {
  try {
    const now = Date.now();
    const lastAt = lastDowntimeAlertAt.get(reason) || 0;
    if (now - lastAt < 60 * 60_000) return; // 1 alert/час на ключ
    lastDowntimeAlertAt.set(reason, now);
    const tgToken = process.env.TELEGRAM_BOT_TOKEN;
    const adminId = process.env.ADMIN_TELEGRAM_ID;
    if (!tgToken || !adminId) return;
    const text = `🚨 Max-bot: ${reason}. Проверь /admin/v304 → 🔌 Каналы.`;
    fetch(`https://api.telegram.org/bot${tgToken}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: adminId, text, disable_web_page_preview: true }),
      signal: AbortSignal.timeout(8_000),
    }).catch(() => {});
  } catch {}
}

// === HTTP helper ===

async function maxApi(p: string, body: any, method: "POST" | "GET" = "POST", opts?: { useLegacy?: boolean }): Promise<any> {
  const tok = TOKEN();
  if (!tok) throw new Error("MAX_BOT_TOKEN missing");
  const base = opts?.useLegacy ? MAX_API_LEGACY : MAX_API_PRIMARY;
  const r = await fetch(`${base}${p}`, {
    method,
    headers: { Authorization: tok, "Content-Type": "application/json" },
    body: method === "POST" ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(10_000),
  });
  if (!r.ok) {
    const t = await r.text().catch(() => "");
    throw new Error(`Max ${method} ${p} ${r.status}: ${t.slice(0, 200)}`);
  }
  return r.json().catch(() => null);
}

// === SendMessage с автоматическим fallback на legacy base ===

async function sendMessage(chatId: string, text: string, attachments?: any[]): Promise<void> {
  const body: any = { text };
  if (attachments && attachments.length) body.attachments = attachments;
  try {
    await maxApi(`/messages?chat_id=${encodeURIComponent(chatId)}`, body);
  } catch (e: any) {
    const msg = String(e?.message || e);
    bootRefs?.logger.warn?.("[max-bot] sendMessage primary failed", { chatId, error: msg });
    // Fallback на legacy URL (platform-api.max.ru) — некоторые установки
    // ещё используют старый endpoint.
    try {
      await maxApi(`/messages?chat_id=${encodeURIComponent(chatId)}`, body, "POST", { useLegacy: true });
    } catch (e2: any) {
      bootRefs?.logger.warn?.("[max-bot] sendMessage legacy also failed", { chatId, error: String(e2?.message || e2) });
      notifyAdminMaxDowntime("sendMessage failed (primary + legacy)");
    }
  }
}

// === Образ Музы (cache-bust через mtime) ===

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

async function sendConsultantPhoto(chatId: string, caption: string): Promise<void> {
  try {
    const base = process.env.PUBLIC_BASE_URL || "https://muzaai.ru";
    const photoUrl = `${base}/consultant-avatar.png?v=${getConsultantPhotoVersion()}`;
    await sendMessage(chatId, caption, [{ type: "image", payload: { url: photoUrl } }]);
  } catch (e: any) {
    bootRefs?.logger.warn?.("[max-bot] sendPhoto failed, text fallback", { chatId, error: String(e?.message || e) });
    await sendMessage(chatId, caption);
  }
}

// === Audio attachment (для inline-плеера трека) ===
// Eugene 2026-05-20 Босс «Музa находит трек и сразу прикрепляет к ответу».
// find_public_track tool возвращает hint=playNow:<id> → backend сохраняет
// attachedTrackId → этот helper отправляет audio attachment в Max.
async function sendTrackAttachment(chatId: string, trackId: number, caption: string): Promise<boolean> {
  try {
    const base = process.env.PUBLIC_BASE_URL || "https://muzaai.ru";
    // ВАЖНО: Max audio attachment требует публичный URL (без cookie auth).
    // /api/stream/:id отдаёт mp3 (см. routes.ts). Для anonymous Max-юзера
    // нужен fallback на public streaming endpoint. Если /api/stream
    // требует auth — здесь Max сам не сможет load, но юзер увидит URL в
    // тексте сообщения и сможет открыть в браузере.
    const audioUrl = `${base}/api/stream/${trackId}`;
    const trackUrl = `${base}/#/track/${trackId}`;
    const fullCaption = `${caption}\n\n🎵 ${trackUrl}`;
    // Сначала пробуем audio attachment. Если падает — fallback на текст с URL.
    try {
      await sendMessage(chatId, fullCaption, [{ type: "audio", payload: { url: audioUrl } }]);
      return true;
    } catch (e: any) {
      bootRefs?.logger.info?.("[max-bot] sendAudio fallback to text", { trackId, error: String(e?.message || e).slice(0, 100) });
      await sendMessage(chatId, fullCaption);
      return false;
    }
  } catch (e: any) {
    bootRefs?.logger.warn?.("[max-bot] sendTrackAttachment failed", { trackId, error: String(e?.message || e) });
    return false;
  }
}

// === GPTunnel fallback ===

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

// === Session management ===

// Eugene 2026-05-20: Max deep-link consume. Юзер сгенерировал nonce в
// /api/auth/max/start-link (из dashboard кнопки «Подключить Max»). Здесь
// проверяем валидность (existing + not used + not expired) → линкуем
// users.maxUserId = maxUserId → mark nonce as used.
async function consumeMaxLinkNonce(nonce: string, maxUserId: string): Promise<{ ok: boolean; userId?: number; error?: string }> {
  if (!nonce || !/^[a-f0-9]{16,64}$/i.test(nonce)) {
    return { ok: false, error: "невалидная ссылка" };
  }
  try {
    const raw = (db as any).$client;
    const row: any = raw.prepare("SELECT user_id, expires_at, used_at FROM max_link_nonces WHERE nonce = ?").get(nonce);
    if (!row) return { ok: false, error: "ссылка не найдена" };
    if (row.used_at) return { ok: false, error: "ссылка уже использована" };
    if (Number(row.expires_at) < Date.now()) return { ok: false, error: "ссылка устарела" };
    const userId = Number(row.user_id);
    if (!userId) return { ok: false, error: "ссылка некорректна" };

    // Проверка что max_user_id ещё не привязан к ДРУГОМУ юзеру
    const existing: any = raw.prepare("SELECT id FROM users WHERE max_user_id = ? AND id != ?").get(maxUserId, userId);
    if (existing) return { ok: false, error: "этот Max-аккаунт уже привязан к другому профилю" };

    // Линкуем + помечаем nonce использованным
    raw.prepare("UPDATE users SET max_user_id = ? WHERE id = ?").run(maxUserId, userId);
    raw.prepare("UPDATE max_link_nonces SET used_at = ?, used_max_user_id = ? WHERE nonce = ?").run(Date.now(), maxUserId, nonce);

    return { ok: true, userId };
  } catch (e: any) {
    console.warn("[max-bot] consumeMaxLinkNonce error:", e?.message || e);
    return { ok: false, error: "техническая ошибка" };
  }
}

// Eugene 2026-05-20 «Привязка по номеру телефона как дополнительный канал».
// Юзер share-contact'нул в Max ИЛИ написал /привязать +7905... — ищем
// users.phone == normalized(phone) AND phone_verified=1 → линкуем maxUserId.
// Минимальная защита: phone должен быть verified в users (SMS-OTP уже
// пройден на сайте). Без verification flag — отказ (нельзя занять чужой
// номер просто написав его в Max).
async function linkMaxByPhone(rawPhone: string, maxUserId: string): Promise<{ ok: boolean; userId?: number; error?: string }> {
  try {
    // Normalize phone: убираем всё кроме цифр + leading 7/8 unification
    const digits = String(rawPhone).replace(/\D/g, "");
    if (digits.length < 10) return { ok: false, error: "номер слишком короткий" };
    // Russian phones: 7XXXXXXXXXX (11 digits) или 8XXXXXXXXXX → +7XXXXXXXXXX
    let normalized = digits;
    if (normalized.length === 10) normalized = "7" + normalized; // 9XXX → 79XXX
    if (normalized.length === 11 && normalized.startsWith("8")) normalized = "7" + normalized.slice(1);
    const e164 = "+" + normalized;

    const raw = (db as any).$client;
    // Ищем users с этим phone (+ phone_verified=1)
    const candidates: any[] = raw.prepare(`
      SELECT id, name, phone, phone_verified, max_user_id
      FROM users
      WHERE (phone = ? OR phone = ? OR phone = ?)
        AND phone_verified = 1
      LIMIT 5
    `).all(e164, normalized, "+" + digits);

    if (!candidates.length) return { ok: false, error: "номер не найден или не подтверждён по SMS" };
    if (candidates.length > 1) return { ok: false, error: "несколько аккаунтов с этим номером — обратись в поддержку" };

    const target = candidates[0];
    if (target.max_user_id && target.max_user_id !== maxUserId) {
      return { ok: false, error: "этот аккаунт уже привязан к другому Max-юзеру" };
    }

    // Проверка что max_user_id не занят другим
    const otherUser: any = raw.prepare("SELECT id FROM users WHERE max_user_id = ? AND id != ?").get(maxUserId, target.id);
    if (otherUser) return { ok: false, error: "этот Max-аккаунт уже привязан к другому профилю" };

    // Линкуем
    raw.prepare("UPDATE users SET max_user_id = ? WHERE id = ?").run(maxUserId, target.id);
    return { ok: true, userId: target.id };
  } catch (e: any) {
    console.warn("[max-bot] linkMaxByPhone error:", e?.message || e);
    return { ok: false, error: "техническая ошибка" };
  }
}

function findOrCreateMaxSession(chatId: string, userKey: string): { sessionId: string; userId: number | null } {
  try {
    const row = db.select().from(chatbotSessions).where(eq(chatbotSessions.externalId, chatId)).get() as any;
    if (row?.id) return { sessionId: row.id, userId: row.userId ?? null };
  } catch {}
  const sessionId = randomUUID();
  // Eugene 2026-05-20: User linking through maxUserId колонка.
  // Сначала ищем по users.maxUserId — это primary linking key для Max.
  // Fallback на users.telegramId — для случаев когда юзер дал тот же ID
  // (редко, но возможно если Max импортирует TG accounts).
  let linkedUserId: number | null = null;
  try {
    const byMax = db.select().from(users).where(eq(users.maxUserId, userKey)).get() as any;
    if (byMax) linkedUserId = byMax.id;
  } catch {}
  if (!linkedUserId) {
    try {
      const u = db.select().from(users).where(eq(users.telegramId, userKey)).get() as any;
      if (u) linkedUserId = u.id;
    } catch {}
  }
  try {
    const lockedPersona = personaFor(userKey).name;
    db.insert(chatbotSessions).values({
      id: sessionId,
      channel: "max",
      externalId: chatId,
      userId: linkedUserId,
      state: "active",
      personaName: lockedPersona,
      startedAt: new Date().toISOString(),
      lastMessageAt: new Date().toISOString(),
    }).run();
  } catch {}
  return { sessionId, userId: linkedUserId };
}

function saveMaxMessage(
  sessionId: string,
  role: "user" | "bot",
  text: string,
  opts?: { userId?: number | null; attachedTrackId?: number | null },
): void {
  try {
    const inserted = db.insert(chatbotMessages).values({
      sessionId,
      role,
      text: text.slice(0, 3900),
      attachedTrackId: opts?.attachedTrackId ?? null,
      createdAt: new Date().toISOString(),
    } as any).returning({ id: chatbotMessages.id }).get();
    // CSAT-аудит (как в telegram-bot)
    if (role === "user") {
      import("../message-analysis/module").then(({ logMessageAnalysis }) => {
        logMessageAnalysis({
          messageId: inserted?.id ?? null,
          sessionId,
          userId: opts?.userId ?? null,
          channel: "max",
          text,
        });
      }).catch(() => {});
    }
  } catch {}
}

// === Resolve attachedTrack для inline-плеера ===

interface AttachedTrack {
  id: number;
  title: string;
  authorName: string | null;
  audioUrl: string;
  coverUrl: string;
  durationSec: number;
}

function resolveAttachedTrack(trackId: number): AttachedTrack | null {
  try {
    const t = db.select().from(generations).where(eq(generations.id, trackId)).get() as any;
    if (
      !t ||
      t.type !== "music" ||
      t.status !== "done" ||
      !(t.isPublic === 1 || t.isPublic === 2) ||
      t.deletedAt ||
      !t.resultUrl
    ) return null;
    let duration = 0;
    try {
      const data = JSON.parse(t.resultData || "{}");
      if (Array.isArray(data.result) && data.result[0]?.duration) {
        duration = Number(data.result[0].duration) || 0;
      }
    } catch {}
    return {
      id: Number(t.id),
      title: t.displayTitle || String(t.prompt || "").slice(0, 80) || "Без названия",
      authorName: t.authorName || null,
      audioUrl: `/api/stream/${t.id}`,
      coverUrl: `/api/cover/${t.id}.jpg`,
      durationSec: duration,
    };
  } catch (e: any) {
    bootRefs?.logger.warn?.("[max-bot] resolveAttachedTrack", { trackId, error: String(e?.message || e) });
    return null;
  }
}

// === Generate reply ===

async function generateReply(
  sessionId: string,
  userKey: string,
  text: string,
  authUserId: number | null,
  muzaRole: string | null,
): Promise<{ reply: string; attachedTrackId: number | null }> {
  // Build memory context (только для linked users)
  let memoryCtx = "";
  if (authUserId) {
    try {
      memoryCtx = await buildMemoryContext(authUserId, "max");
    } catch (e: any) {
      bootRefs?.logger.warn?.("[max-bot] buildMemoryContext failed", { userId: authUserId, error: String(e?.message || e) });
    }
  }

  // Yars (owner) detection — добавим hint в dynamicContext
  let ownerHint = "";
  if (detectsYars(text)) {
    ownerHint = "\n\n[АДМИН: это Ярс — основатель MuzaAi. Говори с ним коротко, конструктивно, по сути.]";
    bootRefs?.logger.info?.("[YARS-MENTION]", { channel: "max", sessionId, userId: authUserId, text: text.slice(0, 200) });
    recordYarsMention({ sessionId, userId: authUserId, channel: "max", text });
  }

  // Eugene 2026-05-20: attachedTrack-перехват через onToolResult.
  // find_public_track возвращает hint=playNow:<id> при exactCount=1 → ловим.
  let attachedTrackId: number | null = null;
  const onToolResult = (toolName: string, _input: any, result: string) => {
    if (toolName !== "find_public_track") return;
    try {
      const j = JSON.parse(result);
      const hint = String(j?.hint || "");
      const m = hint.match(/^playNow:(\d+)$/);
      if (m) {
        const id = Number(m[1]);
        if (Number.isFinite(id) && id > 0) attachedTrackId = id;
      }
    } catch {}
  };

  // 1. Primary: единая Claude через llmCore (с MUZA_TOOLS + cross-channel history).
  const history = loadHistoryForLLM(sessionId, 15);
  const dynamicContext = (memoryCtx ? memoryCtx + "\n\n" : "") + ownerHint;
  const reply = await callUnifiedMuzaLLM({
    sessionId,
    userId: authUserId,
    channel: "max",
    userText: text,
    history,
    dynamicContext,
    maxTokens: 400,
    role: muzaRole,
    onToolResult,
  });
  if (reply) return { reply, attachedTrackId };

  // 2. Backup: GPTunnel (gpt-4o-mini, без tools)
  const sys = buildPersonaSystem(userKey);
  const o = await tryGPTunnelFallback(sys, text, history);
  if (o) return { reply: o, attachedTrackId: null };

  // 3. Все упали — register failure + admin alert
  logUserActionFailure({
    channel: "max",
    action: "chat-reply",
    errorCode: "llm_both_failed",
    errorMessage: "Anthropic + GPTunnel оба не ответили — отдан hardcoded fallback",
    context: { userKey: String(userKey).slice(0, 32), textPreview: text.slice(0, 100) },
  });
  notifyAdminMaxDowntime("LLM полностью недоступен в Max-канале");
  return {
    reply: `Здравствуй! Я — Муза 🎵 Чуть-чуть тормозит — попробуй через минуту.`,
    attachedTrackId: null,
  };
}

// === Webhook secret verification ===

function verifyWebhookSecret(req: any): boolean {
  const expected = WEBHOOK_SECRET();
  if (!expected) {
    // Backward-compat: если secret не задан — warn раз в час, но не блокируем.
    const g: any = global as any;
    if (!g.__max_webhook_secret_warned || Date.now() - g.__max_webhook_secret_warned > 3600_000) {
      g.__max_webhook_secret_warned = Date.now();
      bootRefs?.logger.warn?.("[max-bot] MAX_WEBHOOK_SECRET не задан — webhook принимает запросы без secret-token (prod risk)");
    }
    return true;
  }
  // Max шлёт secret через header (точное имя зависит от docs). Проверяем оба
  // частых варианта: 'x-max-bot-api-secret' (legacy max-channel pattern) и
  // 'x-max-webhook-secret' (более общий). Берём первый совпавший.
  const candidates = [
    String(req.headers["x-max-bot-api-secret"] || ""),
    String(req.headers["x-max-webhook-secret"] || ""),
    String(req.headers["x-bot-api-secret"] || ""),
  ];
  for (const got of candidates) {
    if (!got) continue;
    if (got.length !== expected.length) continue;
    try {
      if (crypto.timingSafeEqual(Buffer.from(got, "utf8"), Buffer.from(expected, "utf8"))) return true;
    } catch {}
  }
  return false;
}

// === Router ===

const router = Router();

router.post("/webhook", async (req, res) => {
  // Eugene 2026-05-20: aggressive logging (warn-level — info может filter'иться).
  // Выясняем что приходит от Max API (формат update'а, какие поля доступны),
  // чтобы понять где silent fail.
  try {
    const bodyKeys = Object.keys(req.body || {});
    const sample = JSON.stringify(req.body || {}).slice(0, 500);
    bootRefs?.logger.warn?.("[max-bot DEBUG] webhook IN", {
      ip: (req as any).ip,
      ua: (req.headers["user-agent"] || "").toString().slice(0, 80),
      hasSecretHeader: !!(req.headers["x-max-bot-api-secret"] || req.headers["x-max-webhook-secret"] || req.headers["x-bot-api-secret"]),
      bodyKeys,
      sample,
    });
  } catch (e: any) {
    bootRefs?.logger.warn?.("[max-bot DEBUG] webhook IN log failed", { error: String(e?.message || e) });
  }

  // Secret verification
  if (WEBHOOK_SECRET() && !verifyWebhookSecret(req)) {
    bootRefs?.logger.warn?.("[max-bot] invalid webhook secret", {
      ip: (req as any).ip,
      ua: (req.headers["user-agent"] || "").toString().slice(0, 80),
      headerNames: Object.keys(req.headers).filter(h => h.startsWith("x-")),
    });
    return res.status(403).json({ data: null, error: "forbidden" });
  }

  // Сразу отвечаем 200 — Max не будет ретраить webhook
  res.status(200).send("ok");

  try {
    // Eugene 2026-05-17 Босс «pause_bot tool через admin-voice».
    try {
      const { isBotPausedRuntime } = await import("../../lib/muzaTools");
      if (isBotPausedRuntime()) {
        bootRefs?.logger.info?.("[max-bot] paused (runtime) — skipping update");
        return;
      }
    } catch {}

    const u: any = req.body || {};
    const msg = u.message || u;

    // Поля Max API. Используем наиболее распространённые имена с fallback'ами.
    // По docs (https://dev.max.ru/docs/maxbusiness/selectionservices):
    //   payload содержит chat (chat_id), sender (user_id), body (text)
    // Также чтобы не уронить старые форматы — поддерживаем legacy paths.
    // Eugene 2026-05-20: Max API формат — chat_id живёт в message.recipient.chat_id
    // (подтверждено реальным webhook payload). Остальные fallback'и для будущей
    // совместимости.
    const chatId = String(
      msg?.recipient?.chat_id ??
      msg?.recipient?.id ??
      msg?.chat?.id ??
      msg?.chat?.chat_id ??
      msg?.chat_id ??
      u?.chat_id ??
      u?.chat?.chat_id ??
      msg?.peer_id ??
      ""
    );
    const fromId = String(
      msg?.sender?.user_id ??
      msg?.from?.user_id ??
      msg?.user_id ??
      u?.user?.user_id ??
      u?.from?.user_id ??
      chatId
    );
    const text = String(
      msg?.body?.text ??
      msg?.text ??
      u?.message?.body?.text ??
      ""
    ).trim();

    // Eugene 2026-05-20 Босс «привязка через номер телефона». Max API позволяет
    // юзеру share свой контакт (attachment type=contact / type=phone). Если
    // attachment пришёл — извлекаем phone и пытаемся auto-link.
    const sharedPhone = (() => {
      try {
        const atts = msg?.body?.attachments ?? msg?.attachments ?? u?.attachments ?? [];
        if (!Array.isArray(atts) || atts.length === 0) return null;
        for (const a of atts) {
          const t = String(a?.type ?? a?.kind ?? "").toLowerCase();
          if (t === "contact" || t === "phone" || t === "share_contact") {
            const phone = a?.payload?.phone || a?.payload?.phone_number || a?.phone || a?.phone_number || a?.contact?.phone || null;
            if (phone) return String(phone);
          }
        }
        return null;
      } catch { return null; }
    })();

    bootRefs?.logger.warn?.("[max-bot DEBUG] parsed", {
      chatId: chatId.slice(0, 30),
      fromId: fromId.slice(0, 30),
      textLen: text.length,
      textSample: text.slice(0, 80),
      hasSharedPhone: !!sharedPhone,
    });

    if (!chatId) {
      bootRefs?.logger.warn?.("[max-bot DEBUG] missing chatId — return", { keys: Object.keys(u || {}).slice(0, 5) });
      return;
    }

    // Dedup
    const dedupKey =
      msg?.message_id ??
      msg?.id ??
      msg?.body?.mid ??
      u?.update_id ??
      `${chatId}:${text.slice(0, 30)}:${Math.floor(Date.now() / 3000)}`;
    if (isMaxMsgDup(dedupKey)) {
      bootRefs?.logger.warn?.("[max-bot DEBUG] skipping duplicate", { key: String(dedupKey).slice(0, 30) });
      return;
    }

    if (!text) {
      bootRefs?.logger.warn?.("[max-bot DEBUG] no text — return", { hasSharedPhone: !!sharedPhone });
      // Не-текстовое сообщение (file/photo/voice) — пока не обрабатываем для
      // chat. Можем добавить в будущем — например voice → STT → answer.
      bootRefs?.logger.info?.("[max-bot] non-text update — skipping", { chatId, hasText: !!text });
      return;
    }

    const { sessionId, userId: authUserId } = findOrCreateMaxSession(chatId, fromId);

    // /start — приветствие с образом Музы.
    // Eugene 2026-05-20: deep-link `/start link_<nonce>` — линкует Max
    // user_id к users.id (юзер сгенерировал nonce в web-кабинете и
    // запустил bot по ссылке). После линка memory + кабинет работают.
    if (text === "/start" || text.startsWith("/start ")) {
      saveMaxMessage(sessionId, "user", text, { userId: authUserId });
      const arg = text.startsWith("/start ") ? text.slice(7).trim() : "";
      if (arg.startsWith("link_")) {
        const nonce = arg.slice(5);
        const linkResult = await consumeMaxLinkNonce(nonce, fromId);
        if (linkResult.ok && linkResult.userId) {
          // Привязали — обновляем текущую Max-сессию и шлём confirm
          try {
            db.update(chatbotSessions).set({ userId: linkResult.userId }).where(eq(chatbotSessions.id, sessionId)).run();
          } catch {}
          const userName = (() => { try { return storage.getUser(linkResult.userId!)?.name || ""; } catch { return ""; } })();
          const msg = userName
            ? `🎵 Привет, ${userName}! Аккаунт подключён. Теперь я помню наши разговоры и вижу твой кабинет.`
            : `🎵 Аккаунт подключён. Теперь я помню тебя и вижу твой кабинет.`;
          await sendConsultantPhoto(chatId, msg);
          saveMaxMessage(sessionId, "bot", msg, { userId: linkResult.userId });
          return;
        } else {
          const msg = `Не получилось подключить аккаунт: ${linkResult.error || "ссылка устарела"}. Сгенерируй новую в кабинете на muzaai.ru.`;
          await sendMessage(chatId, msg);
          saveMaxMessage(sessionId, "bot", msg, { userId: authUserId });
          return;
        }
      }
      const hello = authUserId
        ? `🎵 С возвращением! Я Муза, помогу с песней. Что хочешь сделать?`
        : `🎵 Привет! Я — Муза. Помогу подобрать песню под событие — для какого случая думаешь?`;
      await sendConsultantPhoto(chatId, hello);
      saveMaxMessage(sessionId, "bot", hello, { userId: authUserId });
      return;
    }

    // Eugene 2026-05-20 Босс «привязка по номеру телефона как дополнительный
    // канал улучшения стыковки». Если юзер share-contact'нул (attachment) ИЛИ
    // написал /привязать +7905... — пытаемся match с users.phone (verified).
    // Это дополнение к deep-link nonce flow, не замена.
    if (sharedPhone || text.match(/^\/(привязать|link|подключить)\b/i)) {
      saveMaxMessage(sessionId, "user", text || `(контакт: ${sharedPhone || "?"})`, { userId: authUserId });
      const phoneFromText = (() => {
        const m = text.match(/(\+?\d[\d\s\-()]{8,18})/);
        return m ? m[1] : null;
      })();
      const candidatePhone = sharedPhone || phoneFromText;
      if (!candidatePhone) {
        const msg2 = `📱 Чтобы привязать аккаунт через телефон — пришли свой номер кнопкой «Поделиться контактом» (значок 📎 → Контакт), либо напиши «/привязать +7905...» Номер должен совпадать с тем что ты указал при регистрации на muzaai.ru. \n\nИли проще: открой https://muzaai.ru/#/dashboard и нажми «Подключить Max-бот» — там одна кнопка.`;
        await sendMessage(chatId, msg2);
        saveMaxMessage(sessionId, "bot", msg2, { userId: authUserId });
        return;
      }
      const linkResult = await linkMaxByPhone(candidatePhone, fromId);
      if (linkResult.ok && linkResult.userId) {
        try { db.update(chatbotSessions).set({ userId: linkResult.userId }).where(eq(chatbotSessions.id, sessionId)).run(); } catch {}
        const userName = (() => { try { return storage.getUser(linkResult.userId!)?.name || ""; } catch { return ""; } })();
        const msg3 = userName
          ? `🎵 ${userName}, аккаунт подключён по номеру. Теперь я помню тебя и вижу твой кабинет.`
          : `🎵 Аккаунт подключён по номеру. Теперь я помню тебя.`;
        await sendConsultantPhoto(chatId, msg3);
        saveMaxMessage(sessionId, "bot", msg3, { userId: linkResult.userId });
      } else {
        const msg4 = `Не получилось привязать: ${linkResult.error || "номер не найден"}. Проверь что регистрировался на muzaai.ru с этим номером и подтвердил его через SMS. Или используй кнопку «Подключить Max-бот» в кабинете на сайте.`;
        await sendMessage(chatId, msg4);
        saveMaxMessage(sessionId, "bot", msg4, { userId: authUserId });
      }
      return;
    }

    saveMaxMessage(sessionId, "user", text, { userId: authUserId });

    // Определяем admin role для filterToolsForRole в llmCore
    let muzaRole: string | null = null;
    if (authUserId) {
      try {
        const u2 = storage.getUser(authUserId);
        const roleLower = String((u2 as any)?.role || "").toLowerCase();
        if (roleLower === "admin" || roleLower === "super_admin") muzaRole = roleLower;
      } catch {}
    }

    // Eugene 2026-05-20 Босс «база сообщений админа в боте Музa».
    // Если authUser = admin/super_admin — пишем в admin_chat_messages
    // + auto-apply при trusted IP (см. recordAdminMuzaMessage).
    if (muzaRole) {
      try {
        const { recordAdminMuzaMessage } = await import("../../lib/adminChatRecorder");
        recordAdminMuzaMessage({
          sessionId,
          userId: authUserId,
          channel: "max",
          text,
          ip: (req as any).ip || (req as any).socket?.remoteAddress || null,
          userAgent: req.headers["user-agent"] ? String(req.headers["user-agent"]) : null,
          role: muzaRole,
        }).catch(() => {});
      } catch {}
    }

    const { reply: rawReply, attachedTrackId } = await generateReply(sessionId, fromId, text, authUserId, muzaRole);

    // Cleanup: убираем дубликат подписи, [PROPOSE_GEN], [QR:...] (всё что
    // относится к web-UI и не имеет смысла в Max-чате).
    let cleanReply = rawReply
      .replace(/\s*[—\-–]+\s*(Муза|Аня|Татьяна|Мария|Ольга|Алексей|Дмитрий|Михаил|Андрей|Лиза|Полина|Кирилл|Артём|Маша|Лёша)(\s*·\s*(MuzaAi|MuzaAi))?\s*\.?\s*$/i, "")
      .replace(/\[PROPOSE_GEN:[\s\S]{0,800}?\]/gi, "")
      .replace(/\[PROPOSE_REGISTER:[\s\S]{0,400}?\]/gi, "")
      .replace(/\[QR:[^\]]+\]/gi, "")
      .replace(/\[SWITCH_PERSONA:[^\]]+\]/gi, "")
      .trim();

    if (!cleanReply) {
      cleanReply = "Слушаю тебя 🎵 Расскажи к какому событию подбираем песню?";
    }

    const footer = `\n\n— Муза · MuzaAi`;
    const replyWithAvatar = `🎵 ${cleanReply}${footer}`;

    // Если Музa нашла трек через find_public_track — отправляем audio-attachment.
    let attachedTrack: AttachedTrack | null = null;
    if (attachedTrackId !== null) {
      attachedTrack = resolveAttachedTrack(attachedTrackId);
      if (attachedTrack) {
        const sent = await sendTrackAttachment(chatId, attachedTrack.id, replyWithAvatar);
        bootRefs?.logger.info?.("[max-bot] track attachment", { chatId, trackId: attachedTrack.id, audioSent: sent });
      } else {
        // Track resolution failed → отправляем как обычное сообщение
        await sendMessage(chatId, replyWithAvatar);
      }
    } else {
      await sendMessage(chatId, replyWithAvatar);
    }

    saveMaxMessage(sessionId, "bot", replyWithAvatar, {
      userId: authUserId,
      attachedTrackId: attachedTrack?.id ?? null,
    });

    // Memory compression (fire-and-forget)
    if (authUserId) {
      scheduleCompressionIfNeeded(authUserId).catch(() => {});
    }

    bootRefs?.eventBus?.emit?.("chatbot.reply_sent", {
      channel: "max",
      sessionId,
      chatId,
      hasAttachedTrack: !!attachedTrack,
    }, "max-bot");
  } catch (e: any) {
    bootRefs?.logger.error?.("[max-bot] webhook error", { error: String(e?.message || e) });
    logUserActionFailure({
      channel: "max",
      action: "webhook",
      errorCode: "webhook_handler_throw",
      errorMessage: String(e?.message || e).slice(0, 300),
      endpoint: "/api/max-bot/webhook",
    });
  }
});

// === Admin endpoints (защищены secret из env) ===

function checkAdminSecret(req: any): boolean {
  const secret = String(req.query.secret || req.headers["x-cron-secret"] || "");
  const allowed = [process.env.CRON_SECRET, process.env.SESSION_SECRET].filter(Boolean) as string[];
  if (allowed.length === 0) return false;
  return allowed.includes(secret);
}

// GET /api/max-bot/info — диагностика
router.get("/info", async (_req, res) => {
  if (!TOKEN()) return res.json({ configured: false, error: "MAX_BOT_TOKEN missing" });
  try {
    // Пробуем primary (botapi.max.ru), потом legacy (platform-api.max.ru)
    let me: any = null;
    let baseUsed = "";
    let err: string | null = null;
    try {
      const r = await fetch(`${MAX_API_PRIMARY}/me`, {
        headers: { Authorization: TOKEN() },
        signal: AbortSignal.timeout(8_000),
      });
      if (r.ok) {
        me = await r.json().catch(() => null);
        baseUsed = MAX_API_PRIMARY;
      } else {
        err = `primary ${r.status}`;
      }
    } catch (e: any) {
      err = `primary ${String(e?.message || e).slice(0, 100)}`;
    }
    if (!me) {
      try {
        const r = await fetch(`${MAX_API_LEGACY}/me`, {
          headers: { Authorization: TOKEN() },
          signal: AbortSignal.timeout(8_000),
        });
        if (r.ok) {
          me = await r.json().catch(() => null);
          baseUsed = MAX_API_LEGACY;
        } else {
          err = (err ? err + "; " : "") + `legacy ${r.status}`;
        }
      } catch (e: any) {
        err = (err ? err + "; " : "") + `legacy ${String(e?.message || e).slice(0, 100)}`;
      }
    }
    res.json({
      configured: true,
      me,
      baseUsed,
      error: err,
      webhookSecret: !!WEBHOOK_SECRET(),
    });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

// GET /api/max-bot/setup-webhook?url=...&secret=...
// Регистрирует webhook у Max через subscriptions API. Точный формат
// endpoint'а зависит от docs Max — пробуем 2 варианта.
router.get("/setup-webhook", async (req, res) => {
  if (!checkAdminSecret(req)) {
    return res.status(403).json({ ok: false, error: "secret required" });
  }
  if (!TOKEN()) {
    return res.status(400).json({ ok: false, error: "MAX_BOT_TOKEN missing" });
  }
  const url = String(req.query.url || process.env.MAX_WEBHOOK_URL || "");
  if (!url || !url.startsWith("https://")) {
    return res.status(400).json({ ok: false, error: "url=https://... required" });
  }

  // Max Business API subscriptions endpoint. По docs точное имя может быть
  // /subscriptions (стандарт) или /webhook. Пробуем оба.
  const attempts: Array<{ base: string; path: string; method: "POST" }> = [
    { base: MAX_API_PRIMARY, path: "/subscriptions", method: "POST" },
    { base: MAX_API_LEGACY, path: "/subscriptions", method: "POST" },
  ];

  const body: any = { url };
  // Subscribe ко всем типам updates (если API это поддерживает).
  body.update_types = ["message_created", "bot_started", "bot_added"];
  if (WEBHOOK_SECRET()) body.secret = WEBHOOK_SECRET();

  const results: any[] = [];
  for (const a of attempts) {
    try {
      const r = await fetch(`${a.base}${a.path}`, {
        method: a.method,
        headers: { Authorization: TOKEN(), "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(10_000),
      });
      const respText = await r.text().catch(() => "");
      results.push({ base: a.base, path: a.path, status: r.status, body: respText.slice(0, 300) });
      if (r.ok) {
        let j: any = null;
        try { j = JSON.parse(respText); } catch {}
        return res.json({ ok: true, baseUsed: a.base, url, secret_set: !!WEBHOOK_SECRET(), response: j ?? respText.slice(0, 300), attempts: results });
      }
    } catch (e: any) {
      results.push({ base: a.base, path: a.path, error: String(e?.message || e).slice(0, 200) });
    }
  }
  return res.status(502).json({ ok: false, error: "all subscription endpoints failed", attempts: results });
});

// GET /api/max-bot/kb/reload — alias для совместимости с KB-sync rule (web-чат)
router.get("/kb/reload", (req, res) => {
  if (!checkAdminSecret(req)) {
    return res.status(403).json({ ok: false, error: "secret required" });
  }
  // KB обслуживается общим loader'ом lib/consultantPersona — telegram-bot
  // тоже шлёт сюда. Здесь только маркер «получили».
  try {
    const { loadKB, kbPath } = require("../../lib/consultantPersona");
    const text = loadKB(true);
    res.json({ ok: !!text, length: text.length, path: kbPath() });
  } catch (e: any) {
    res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

const maxBotModule: Module = {
  name: "max-bot",
  version: "0.2.0",
  description: "Max-bot chat-assistant — единая точка с TG. Webhook /api/max-bot/webhook + memory + cross-channel history + find_public_track audio attachment. Без MAX_BOT_TOKEN — degraded.",
  publishes: ["chatbot.reply_sent"],
  routes: { prefix: "max-bot", router },
  onLoad: async (ctx) => {
    bootRefs = { eventBus: ctx.eventBus, logger: ctx.logger };
    ctx.logger.info("max-bot online", {
      token: TOKEN() ? "configured" : "missing",
      webhookSecret: WEBHOOK_SECRET() ? "configured" : "missing",
      apiBase: MAX_API_PRIMARY,
    });
  },
  healthCheck: () => ({
    status: TOKEN() ? "ok" : "degraded",
    details: {
      bot_token: !!TOKEN(),
      webhook_secret: !!WEBHOOK_SECRET(),
      api_base: MAX_API_PRIMARY,
    },
  }),
};

export default maxBotModule;
