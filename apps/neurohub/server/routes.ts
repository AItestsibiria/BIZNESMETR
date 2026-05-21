import type { Express, Request, Response, NextFunction } from "express";
import { createServer, type Server } from "http";
import { storage, db, sqliteDb } from "./storage";
import { getTodayDefaultSort, getRotationConfig, setRotationCycle } from "./lib/playlistSortRotation";
import { PUBLIC_URL } from "./lib/publicUrl";
import { detectsYars, recordYarsMention } from "./lib/yarsDetect";
import { detectSentiment } from "./lib/sentimentDetector";
import bcrypt from "bcryptjs";
import { v4 as uuidv4 } from "uuid";
import { registerSchema, loginSchema, users, payments, generations, transactions, promoCodes, visitors, genActivity, songDrafts, botLearnings, landingNews, chatbotSessions, chatbotMessages, adminDelegates, userActionFailures, agentHandoffs, userJourneyEvents } from "@shared/schema";
import express from "express";
import { eq, desc, sql, and, isNotNull, inArray } from "drizzle-orm";
import nodemailer from "nodemailer";
import crypto from "crypto";
import NodeID3 from "node-id3";
import fs from "fs";
import path from "path";
import { normalizeVocalParams } from "./lib/normalizeVocalParams";
import { isSunoCircuitOpen } from "./plugins/suno-watchdog/module";
import { requireAdmin, isAdminUser } from "./core/adminAuth";
import { createNonce as tgCreateNonce, pollNonce as tgPollNonce, consumeNonce as tgConsumeNonce, attachUserToNonce as tgAttachUserToNonce } from "./lib/tgLoginNonces";
import { logEngagement, getEngagementDaily, getEngagementSummary } from "./lib/engagement";
import { personaFor, PERSONAS } from "./lib/consultantPersona";
import { findSessionByPairCode, looksLikePairCode } from "./lib/webChatPair";
// MUZA_TOOLS + executeTool теперь вызываются ТОЛЬКО внутри
// callUnifiedMuzaLLM (lib/llmCore.ts) — Eugene 2026-05-16 «один мозг».
import { loadHistoryForLLM, loadHistoryForUser } from "./lib/chatHistory";
import { getPendingLyricsForSession } from "./lib/muzaTools";
import {
  callUnifiedMuzaLLM,
  listAnthropicKeys as listAnthropicKeysCore,
  getLLMKeyStatus,
  getKeySwitchEvents,
  getMuzaTokenStats,
  getTokenPrice,
} from "./lib/llmCore";
import { smsProviderLogs, smsOtp } from "@shared/schema";
import { logUserActionFailure } from "./lib/userActionFailures";
import {
  initiateAction,
  confirmAction,
  listRecentPendingActions,
  cleanupExpiredPendingActions,
  isProtectedAction,
  type ProtectedAction,
} from "./lib/adminTwoFactor";
import { recordAuditEntry, queryAuditLog } from "./lib/adminAuditLog";
// Eugene 2026-05-20: User-memory-context rule — Музa держит контекст общения
// с авторизованным юзером. См. lib/userMemory.ts + CLAUDE.md.
import {
  buildMemoryContext,
  scheduleCompressionIfNeeded,
  getUserMemory,
  getCabinetSnapshot,
  forgetUserMemory,
  updateUserMemoryAdmin,
  listUserMemories,
  compressUserMemory,
  getRecentMessagesForUser,
} from "./lib/userMemory";
import { getPeriodRange } from "./lib/periodBoundaries";
import { getOrCreateVisitorId, readVisitorId } from "./lib/visitorCookie";
import { getIpGeo } from "./lib/ipGeo";
import { upsertUserProfile, linkProfileToUser, getProfileByUserId, getProfileByVisitorId } from "./lib/userProfilesStore";
import { extractHost, KNOWN_DOMAINS, hostToBucket } from "./lib/extractHost";
import { embedTrackId3, findSiblingCover } from "./lib/id3Writer";
import { alertPromoEntry, checkExpiredPromo } from "./lib/promoAlert";
import { buildBotExclusionSql, isBotUserAgent } from "./lib/botUa";
import { incCurrLabelFor, buildReceipt, receiptToParam, type RoboPaymentMethod } from "./lib/robokassaMethods";
import { getLegalConfig, isLegalConfigComplete } from "./lib/legalConfig";
import {
  blockEntity,
  unblockEntity,
  listBlocked,
  suspiciousCandidates,
  type BlockType,
} from "./lib/blockedEntities";
import { z } from "zod";

const AUTHORS_DIR = process.env.AUTHORS_DIR || path.join(process.cwd(), "authors");

// Rate limiter: IP -> { count, resetAt }
const rateLimitMap = new Map<string, { count: number; resetAt: number }>();
function rateLimit(ip: string, maxRequests: number, windowMs: number): boolean {
  const now = Date.now();
  const entry = rateLimitMap.get(ip);
  if (!entry || now > entry.resetAt) {
    rateLimitMap.set(ip, { count: 1, resetAt: now + windowMs });
    return true;
  }
  if (entry.count >= maxRequests) return false;
  entry.count++;
  return true;
}
// Cleanup every 10 minutes
setInterval(() => {
  const now = Date.now();
  for (const [ip, entry] of rateLimitMap) {
    if (now > entry.resetAt) rateLimitMap.delete(ip);
  }
}, 600000);

// Sanitize author name for folder
function sanitizeFolderName(name: string): string {
  return name.replace(/[<>:"\/\\|?*\x00-\x1f]/g, "_").replace(/\s+/g, "_").slice(0, 100) || "unknown";
}

// Save a remote file to author's local folder
async function saveToAuthorFolder(genId: number, authorName: string, remoteUrl: string, ext: string, subfolder?: string): Promise<string | null> {
  try {
    const folder = sanitizeFolderName(authorName);
    const dir = subfolder
      ? path.join(AUTHORS_DIR, folder, subfolder)
      : path.join(AUTHORS_DIR, folder);
    fs.mkdirSync(dir, { recursive: true });
    const filename = `gen_${genId}.${ext}`;
    const filepath = path.join(dir, filename);
    const resp = await fetch(remoteUrl);
    if (!resp.ok) return null;
    const buffer = Buffer.from(await resp.arrayBuffer());
    fs.writeFileSync(filepath, buffer);
    // Return relative path from AUTHORS_DIR
    return path.relative(AUTHORS_DIR, filepath);
  } catch (e) {
    console.error(`[SAVE] Error saving gen #${genId}:`, e);
    return null;
  }
}

// Apply 3-second fade-out to MP3 file in-place via ffmpeg.
// Keeps original as <file>.orig.mp3 for rollback; writes new file atomically.
// No-op if ffmpeg is missing, duration can't be read, or file already has fade.
async function applyFadeOut(mp3Path: string, fadeDurSec = 3): Promise<boolean> {
  try {
    const { execSync } = await import("child_process");
    if (!fs.existsSync(mp3Path)) return false;
    const origPath = mp3Path.replace(/\.mp3$/i, ".orig.mp3");
    // If already processed (orig exists and is older than processed), skip.
    if (fs.existsSync(origPath)) {
      return false;
    }
    // Probe duration
    const durRaw = execSync(
      `ffprobe -v error -show_entries format=duration -of csv=p=0 "${mp3Path}"`,
      { encoding: "utf-8", timeout: 15000 }
    ).trim();
    const dur = parseFloat(durRaw);
    if (!isFinite(dur) || dur <= fadeDurSec + 1) return false; // too short to fade
    const fadeStart = (dur - fadeDurSec).toFixed(2);
    const tmpPath = mp3Path.replace(/\.mp3$/i, ".fade.mp3");
    // -y overwrite, copy metadata, re-encode audio with afade filter
    execSync(
      `ffmpeg -y -i "${mp3Path}" -af "afade=t=out:st=${fadeStart}:d=${fadeDurSec}" -map_metadata 0 -id3v2_version 3 -codec:a libmp3lame -qscale:a 2 "${tmpPath}" 2>/dev/null`,
      { timeout: 90000 }
    );
    if (!fs.existsSync(tmpPath) || fs.statSync(tmpPath).size < 1000) {
      // ffmpeg failed silently
      try { fs.unlinkSync(tmpPath); } catch {}
      return false;
    }
    // Preserve original as .orig.mp3 and swap
    fs.renameSync(mp3Path, origPath);
    fs.renameSync(tmpPath, mp3Path);
    console.log(`[FADE] Applied ${fadeDurSec}s fade-out to ${mp3Path}`);
    return true;
  } catch (e: any) {
    console.error(`[FADE] Failed on ${mp3Path}:`, e?.message || e);
    return false;
  }
}

// Save all files for a completed generation (audio + image)
async function saveGenFiles(genId: number) {
  const gen = db.select().from(generations).where(eq(generations.id, genId)).get();
  if (!gen || gen.status !== "done" || !gen.resultUrl) return;
  const user = db.select().from(users).where(eq(users.id, gen.userId)).get();
  // Folder is always by user profile name, not display authorName
  const authorName = user?.name || gen.authorName || "_noname";

  let savedPath: string | null = null;

  if (gen.type === "music") {
    // Save audio
    let audioUrl = gen.resultUrl;
    let imageUrl: string | null = null;
    try {
      const data = JSON.parse(gen.resultData || "{}");
      if (Array.isArray(data.result) && data.result[0]) {
        audioUrl = data.result[0].audio_url || audioUrl;
        imageUrl = data.result[0].image_url || null;
      }
    } catch {}
    savedPath = await saveToAuthorFolder(genId, authorName, audioUrl, "mp3");
    // Apply 3-second fade-out to mask Suno's abrupt endings
    if (savedPath) {
      try {
        const absPath = path.join(AUTHORS_DIR, savedPath);
        await applyFadeOut(absPath, 3);
      } catch (e) {
        console.error(`[FADE] Post-save fade failed for gen #${genId}:`, e);
      }
    }
    // Also save cover image
    if (imageUrl) {
      await saveToAuthorFolder(genId, authorName, imageUrl, "jpg");
    }
    // Eugene 2026-05-17 Босс «iOS lock-screen logo вместо обложки».
    // Embed real cover into mp3 APIC frame so iOS / Bluetooth / AirPlay /
    // CarPlay see the right artwork (they read ID3 from byte-stream, NOT
    // from Media Session API). saveGenFiles runs after both mp3 and jpg
    // are on disk — perfect spot to write metadata once.
    if (savedPath) {
      try {
        const absMp3 = path.join(AUTHORS_DIR, savedPath);
        const siblingCover = findSiblingCover(absMp3);
        const trackTitle =
          gen.displayTitle ||
          (gen.prompt ? gen.prompt.slice(0, 80) : null) ||
          "MuzaAi Track";
        const id3Res = await embedTrackId3({
          mp3Path: absMp3,
          title: trackTitle,
          authorName: authorName !== "_noname" ? authorName : null,
          coverPath: siblingCover,
          keepExistingImage: false, // overwrite Suno's default art with our cover
        });
        if (id3Res.ok) {
          console.log(
            `[ID3] gen #${genId} embedded (cover=${id3Res.coverSource}, bytes=${id3Res.imageBytes || 0})`,
          );
        } else {
          console.warn(`[ID3] gen #${genId} embed failed: ${id3Res.error}`);
        }
      } catch (e) {
        console.error(`[ID3] Post-save ID3 embed failed for gen #${genId}:`, e);
      }
    }
  } else if (gen.type === "cover") {
    savedPath = await saveToAuthorFolder(genId, authorName, gen.resultUrl, "png");
  } else if (gen.type === "lyrics") {
    // Save text as file
    const folder = sanitizeFolderName(authorName);
    const dir = path.join(AUTHORS_DIR, folder);
    fs.mkdirSync(dir, { recursive: true });
    const filepath = path.join(dir, `gen_${genId}.txt`);
    fs.writeFileSync(filepath, gen.resultUrl || "");
    savedPath = path.relative(AUTHORS_DIR, filepath);
  }

  if (savedPath) {
    db.update(generations).set({ localPath: savedPath }).where(eq(generations.id, genId)).run();
    console.log(`[SAVE] Gen #${genId} saved to ${savedPath}`);
  }
}

// SECURITY: hardcoded fallback removed 2026-05-06 — old key was leaked to public repo,
// rotated by Eugene. Server now refuses to start without GPTUNNEL_API_KEY in env.
const GPTUNNEL_API_KEY = process.env.GPTUNNEL_API_KEY || "";
if (!GPTUNNEL_API_KEY) {
  console.error("[FATAL] GPTUNNEL_API_KEY missing in env — Suno calls will fail");
}

// Humanize Suno-style raw string into Russian chips ("rock, fast tempo, 170 BPM" → "Рок · быстрый · 170 BPM")
function humanizeStyle(rawStyle: string): string {
  if (!rawStyle) return "";
  const styleMap: Record<string, string> = { pop: 'Поп', rock: 'Рок', rap: 'Рэп', electronic: 'Электронная', jazz: 'Джаз', lofi: 'Lo-Fi', cinematic: 'Кинематограф', ballad: 'Баллада', folk: 'Фолк', rnb: 'R&B', reggae: 'Регги', metal: 'Метал', country: 'Кантри', classical: 'Классика', chanson: 'Шансон', dance: 'Данс' };
  const moodMap: Record<string, string> = { happy: 'весёлое', sad: 'грустное', romantic: 'романтичное', energetic: 'энергичное', calm: 'спокойное', dramatic: 'драматичное', epic: 'эпичное', dreamy: 'мечтательное', aggressive: 'агрессивное' };
  const tempoMap: Record<string, string> = { slow: 'медленный', moderate: 'средний', fast: 'быстрый', 'very fast': 'очень быстрый' };
  try {
    const parts = rawStyle.split(',').map(p => p.trim()).filter(Boolean);
    if (parts.length === 0) return "";
    const base = parts[0];
    const label = styleMap[base.toLowerCase()] || base;
    const extras: string[] = [];
    for (const p of parts.slice(1)) {
      const tempoMatch = p.match(/(slow|moderate|fast|very fast)\s*tempo/i);
      const moodMatch = p.match(/([\w\u0400-\u04ff]+)\s*mood/i);
      const bpmMatch = p.match(/(\d+)\s*BPM/i);
      const duetMatch = p.match(/duet/i);
      if (tempoMatch) extras.push(tempoMap[tempoMatch[1].toLowerCase()] || tempoMatch[1]);
      else if (moodMatch) extras.push(moodMap[moodMatch[1].toLowerCase()] || moodMatch[1]);
      else if (bpmMatch) extras.push(bpmMatch[1] + ' BPM');
      else if (duetMatch) extras.push('дуэт');
      else extras.push(p);
    }
    return [label, ...extras].join(' · ');
  } catch { return rawStyle; }
}
const GPTUNNEL_BASE = "https://gptunnel.ru/v1";

// Robokassa payment config.
//
// Eugene 2026-05-16: Robokassa integration audit (docs/strategy/ROBOKASSA-INTEGRATION-PLAN.md).
//
// 1) ENV naming поддержан в обоих вариантах: `ROBO_MERCHANT_LOGIN`/`ROBO_PASSWORD1/2`
//    (исторический) и `ROBO_LOGIN`/`ROBO_PASSWORD_1/2` (CLAUDE.md + api-health плагин).
//    Какой задан в .env — тот и используется. Это позволяет не ломать prod до
//    ручной нормализации .env на VPS.
// 2) Test mode (`ROBO_IS_TEST=true`, default) использует **отдельную** пару
//    тестовых паролей `ROBO_TEST_PASSWORD1/2` (если заданы). Если test-пароли
//    пустые — fallback на prod-пароли (back-compat поведение, может вызвать
//    error 29 у Robokassa если у магазина в кабинете test ≠ prod).
// 3) Test и production используют один и тот же endpoint `auth.robokassa.ru/...`;
//    различие — параметр `IsTest=1` в payload + пара test-паролей.
const ROBO_BASE_URL = "https://auth.robokassa.ru/Merchant/Index.aspx";
const ROBO_IS_TEST = process.env.ROBO_IS_TEST !== "false"; // default true (test mode)

function getRoboCreds(): {
  login: string;
  password1: string;
  password2: string;
  isTest: boolean;
} {
  const login = process.env.ROBO_MERCHANT_LOGIN || process.env.ROBO_LOGIN || "";
  const prodP1 = process.env.ROBO_PASSWORD1 || process.env.ROBO_PASSWORD_1 || "";
  const prodP2 = process.env.ROBO_PASSWORD2 || process.env.ROBO_PASSWORD_2 || "";
  const testP1 = process.env.ROBO_TEST_PASSWORD1 || process.env.ROBO_TEST_PASSWORD_1 || "";
  const testP2 = process.env.ROBO_TEST_PASSWORD2 || process.env.ROBO_TEST_PASSWORD_2 || "";
  if (ROBO_IS_TEST) {
    return {
      login,
      password1: testP1 || prodP1, // fallback на prod если test не задан
      password2: testP2 || prodP2,
      isTest: true,
    };
  }
  return { login, password1: prodP1, password2: prodP2, isTest: false };
}

// Backward-compat экспорт для админ-логов которые могут читать имя:
const ROBO_MERCHANT_LOGIN = getRoboCreds().login;

/**
 * Build Robokassa signature: MD5 of values joined by ":", returned as uppercase hex.
 *
 * Caller is responsible for putting password into the values array at the
 * correct position (see ROBOKASSA-INTEGRATION-PLAN.md §2 for formulas).
 * Shp_* params must be sorted alphabetically and appended in "Shp_key=value" form.
 */
function roboSignature(values: string[]): string {
  return crypto.createHash("md5").update(values.join(":")).digest("hex").toUpperCase();
}

/**
 * Build the Shp_* "key=value" segments for signature, sorted alphabetically.
 * Returns array of strings ready to be joined into the signature string.
 */
function buildShpSignatureParts(shp: Record<string, string | number>): string[] {
  return Object.keys(shp)
    .sort((a, b) => a.localeCompare(b))
    .map((key) => `${key}=${shp[key]}`);
}

// Gmail SMTP — tissan2021 for transport + client-facing from/replyTo
// Eugene 2026-05-09: GMAIL_APP_PASSWORD вынесен в process.env. Старый
// хардкод утёк в публичный репозиторий и должен быть отозван в Google
// (myaccount.google.com/apppasswords) и заменён новым App Password.
// GMAIL_USER пока остаётся константой; перенос в env — отдельный шаг.
const GMAIL_USER = process.env.GMAIL_USER || "tissan2021@gmail.com";
const GMAIL_APP_PASSWORD = process.env.GMAIL_APP_PASSWORD || "";
const CLIENT_EMAIL = process.env.GMAIL_USER || "tissan2021@gmail.com"; // matches SMTP user to avoid 'on behalf of' header
if (!GMAIL_APP_PASSWORD) {
  console.warn("[smtp] GMAIL_APP_PASSWORD не установлен в .env — отправка email не будет работать");
}

const mailTransport = nodemailer.createTransport({
  service: "gmail",
  auth: {
    user: GMAIL_USER,
    pass: GMAIL_APP_PASSWORD,
  },
});

async function sendResetEmail(toEmail: string, code: string): Promise<boolean> {
  try {
    await mailTransport.sendMail({
      from: `"MuzaAi" <${CLIENT_EMAIL}>`, replyTo: CLIENT_EMAIL,
      to: toEmail,
      subject: "MuzaAi — код восстановления пароля",
      text: `Ваш код восстановления пароля: ${code}\n\nКод действует 15 минут.\n\nЕсли вы не запрашивали сброс пароля, проигнорируйте это письмо.\n\n— MuzaAi`,
      html: `
        <div style="font-family: -apple-system, sans-serif; max-width: 480px; margin: 0 auto; padding: 32px; background: #09090b; border-radius: 16px; border: 1px solid #1a1a2e;">
          <div style="text-align: center; margin-bottom: 24px;">
            <span style="font-size: 24px; font-weight: 700; background: linear-gradient(135deg, #8b5cf6, #3b82f6); -webkit-background-clip: text; -webkit-text-fill-color: transparent;">MuzaAi</span>
          </div>
          <p style="color: #e2e2e2; font-size: 15px; line-height: 1.6; margin-bottom: 16px;">Вы запросили восстановление пароля. Введите этот код на сайте:</p>
          <div style="text-align: center; margin: 24px 0;">
            <span style="display: inline-block; font-size: 36px; font-weight: 700; letter-spacing: 8px; color: #fff; background: linear-gradient(135deg, #8b5cf6, #3b82f6); padding: 16px 32px; border-radius: 12px;">${code}</span>
          </div>
          <p style="color: #888; font-size: 13px; text-align: center;">Код действует 15 минут</p>
          <hr style="border: none; border-top: 1px solid #1a1a2e; margin: 24px 0;">
          <p style="color: #555; font-size: 12px; text-align: center;">Если вы не запрашивали сброс пароля, проигнорируйте это письмо.</p>
        </div>
      `,
    });
    console.log(`[EMAIL] Reset code sent to ${toEmail}`);
    return true;
  } catch (err) {
    console.error("[EMAIL] Failed to send:", err);
    return false;
  }
}

// In-memory token store: token -> userId
// Token store backed by SQLite (using same db connection via raw SQL).
// Eugene 2026-05-15: реализация переехала в lib/tokenStore.ts чтобы
// плагины (auth-sms и др.) могли выдавать токен после своих auth-flow.
// Локальная const-обёртка чтобы остальной код в routes.ts не менять.
import { tokenStore as _sharedTokenStore } from "./lib/tokenStore";
const tokenStore = _sharedTokenStore;


// Password reset: email -> { code, userId, expiresAt }
const resetCodes = new Map<string, { code: string; userId: number; expiresAt: number }>();
// Password reset: token -> userId
const resetTokens = new Map<string, number>();

function getTokenFromRequest(req: Request): string | undefined {
  const authHeader = req.headers.authorization;
  if (authHeader?.startsWith("Bearer ")) {
    return authHeader.slice(7);
  }
  // Security-audit 2026-05-19 CRITICAL #3: ?token= в query попадает в nginx
  // logs / browser history / Referer header → утечка через расшаренные ссылки.
  // Разрешён ТОЛЬКО для stream/download endpoints где <audio src=…> без JS:
  const path = (req as any).path || "";
  const allowQueryToken = path.startsWith("/api/stream/") || path.startsWith("/api/download/") || path.startsWith("/api/cover/");
  if (allowQueryToken) {
    return req.query.token as string | undefined;
  }
  return undefined;
}

function authMiddleware(req: Request, res: Response, next: NextFunction): void {
  const token = getTokenFromRequest(req);
  if (!token || !tokenStore.has(token)) {
    res.status(401).json({ message: "Не авторизован" });
    return;
  }
  const uid = tokenStore.get(token)!;
  const u = storage.getUser(uid);
  if (u && u.blocked) {
    res.status(403).json({ message: "Аккаунт заблокирован" });
    return;
  }
  (req as any).userId = uid;
  next();
}

// Eugene 2026-05-08 АК-аудит: добавляем timeout. Раньше fetch висел
// бесконечно при сетевых сбоях GPTunnel — таблица гнала зависшие 'processing'
// gens, timeout-watcher через 8 мин их рефандил. Теперь fail-fast.
//   /media/create   — 30 сек (Suno только принимает запрос, реальная генерация
//                     потом poll'ится отдельно)
//   /media/result   — 15 сек (один poll-запрос)
//   /balance        — 10 сек
//   default         — 30 сек
async function gptunnelFetch(path: string, options: RequestInit = {}) {
  const url = `${GPTUNNEL_BASE}${path}`;
  const headers: Record<string, string> = {
    "Authorization": GPTUNNEL_API_KEY,
    ...((options.headers as Record<string, string>) || {}),
  };
  if (options.body) {
    headers["Content-Type"] = "application/json";
  }
  let timeoutMs = 30_000;
  if (path.includes("/media/result")) timeoutMs = 15_000;
  else if (path.includes("/balance")) timeoutMs = 10_000;
  return fetch(url, { ...options, headers, signal: options.signal ?? AbortSignal.timeout(timeoutMs) });
}

// Suno webhook secret — derive из SESSION_SECRET если не задан явно.
// Eugene 2026-05-08 doc-audit: callback_url убирает polling, экономит API calls.
// Eugene 2026-05-20 (C15 fix): explicit throw если оба env пусты — иначе literal
// "fallback" даёт известный секрет атакующему. ROOT CAUSE: до этого fallback
// secret = sha256("fallback:suno-webhook") — same для всех инсталляций.
const SUNO_WEBHOOK_SECRET = (() => {
  const explicit = process.env.SUNO_WEBHOOK_SECRET;
  if (explicit && explicit.length >= 16) return explicit;
  const session = process.env.SESSION_SECRET;
  if (!session || session.length < 16) {
    throw new Error(
      "[BOOTSTRAP] SUNO_WEBHOOK_SECRET unset AND SESSION_SECRET unset/short. " +
      "Set SUNO_WEBHOOK_SECRET=<random 32+ hex> in .env (openssl rand -hex 32) " +
      "OR ensure SESSION_SECRET is set (32+ bytes base64). Refusing to use literal 'fallback'.",
    );
  }
  return crypto.createHash("sha256").update(session + ":suno-webhook").digest("hex").slice(0, 32);
})();

function publicHostUrl(req?: Request): string {
  // Используем первый available из:
  //   1. PUBLIC_HOST env (если admin задал)
  //   2. X-Forwarded-Proto + Host headers (за nginx/cloudflare)
  //   3. Hardcoded clone.muziai.ru как fallback
  const fromEnv = process.env.PUBLIC_HOST;
  if (fromEnv) return fromEnv.replace(/\/$/, "");
  if (req) {
    const proto = (req.headers["x-forwarded-proto"] || "https").toString().split(",")[0].trim();
    const host = (req.headers["x-forwarded-host"] || req.headers.host || "").toString();
    if (host) return `${proto}://${host}`;
  }
  return "https://clone.muziai.ru";
}

function buildSunoCallbackUrl(req: Request | null, genId: number): string {
  const base = publicHostUrl(req || undefined);
  const sig = crypto.createHmac("sha256", SUNO_WEBHOOK_SECRET).update(String(genId)).digest("hex").slice(0, 16);
  return `${base}/api/suno/webhook?gen_id=${genId}&sig=${sig}`;
}

// Price per service type (in kopecks)
const PRICES: Record<string, number> = {
  lyrics: 9900,   // 99 ₽
  music: 39900,   // 399 ₽ (Eugene 2026-05-19: было 299 → 399)
  cover: 9900,    // 99 ₽
};
const PRICE_LABELS: Record<string, string> = {
  lyrics: "99 ₽",
  music: "399 ₽",
  cover: "99 ₽",
};

// Check if user can generate: free first use OR sufficient balance
function checkAndCharge(userId: number, serviceType: string): { ok: boolean; isFree: boolean; cost: number; usedBonusTrack?: boolean; error?: string } {
  const user = storage.getUser(userId);
  if (!user) return { ok: false, isFree: false, cost: 0, error: "Пользователь не найден" };

  const price = PRICES[serviceType] || 9900;

  // For music: check bonus tracks first
  if (serviceType === "music" && (user.bonusTracks || 0) > 0) {
    db.update(users).set({ bonusTracks: sql`${users.bonusTracks} - 1` }).where(eq(users.id, userId)).run();
    storage.createTransaction({
      userId,
      type: serviceType,
      amount: 0,
      description: `🎁 Генерация музыки (подарочный трек)`,
    });
    console.log(`[CHARGE] User #${userId} used bonus track for music (${(user.bonusTracks || 0) - 1} left)`);
    return { ok: true, isFree: false, cost: 0, usedBonusTrack: true };
  }

  // Eugene 14:36: возвращаю проверенный path. Atomic charge через drizzle
  // `sql${users.balance}` мог компилироваться некорректно в better-sqlite3.
  // Race-protection обеспечит generation-agent через atomic markRefunded.
  if (user.balance < price) {
    return { ok: false, isFree: false, cost: price, error: `Недостаточно средств. Нужно ${PRICE_LABELS[serviceType] || "99 ₽"}.` };
  }
  storage.updateBalance(userId, -price);
  storage.createTransaction({
    userId,
    type: serviceType,
    amount: -price,
    description: `Генерация (${serviceType}): ${PRICE_LABELS[serviceType] || "99 ₽"}`,
  });
  return { ok: true, isFree: false, cost: price };
}

function ensureSeedAdmin() {
  // Security-audit 2026-05-19 CRITICAL #1: seed admin с предсказуемым паролем
  // = takeover vector если БД сбросится. Включается ТОЛЬКО если задан
  // ADMIN_SEED_PASSWORD в env (нет fallback). Чисто для bootstrap нового VPS.
  const seedPass = process.env.ADMIN_SEED_PASSWORD;
  const seedEmail = process.env.ADMIN_SEED_EMAIL || "admin@muzaai.ru";
  if (!seedPass) return;
  const existing = storage.getUserByEmail(seedEmail);
  if (!existing) {
    const user = storage.createUser({
      name: "Admin",
      email: seedEmail,
      password: seedPass,
    });
    db.update(users).set({ role: "admin", balance: 100000 }).where(eq(users.id, user.id)).run();
    console.log(`[BOOT] Seed admin создан: ${seedEmail}`);
  }
}

// Eugene 2026-05-14 Босс: правило «1000 первых из РФ + ближнее зарубежье».
// CIS = страны бывшего СССР (включая Грузию исторически). Подарочный
// трек выдаётся только первым 1000 авторам из этого списка.
const CIS_COUNTRY_CODES = new Set([
  "RU", // Россия
  "BY", // Беларусь
  "KZ", // Казахстан
  "KG", // Кыргызстан
  "AM", // Армения
  "AZ", // Азербайджан
  "TJ", // Таджикистан
  "TM", // Туркменистан
  "UZ", // Узбекистан
  "MD", // Молдова
  "UA", // Украина
  "GE", // Грузия
]);
const WELCOME_GIFT_LIMIT = 1000;

function isCISCountry(countryCode: string | null | undefined): boolean {
  return !!countryCode && CIS_COUNTRY_CODES.has(countryCode.toUpperCase());
}

// GeoIP lookup via free API (ip-api.com, 45 req/min)
const geoCache = new Map<string, any>();
async function getGeo(ip: string): Promise<{ country: string; countryCode: string; city: string; region: string }> {
  if (geoCache.has(ip)) return geoCache.get(ip);
  try {
    const cleanIp = ip.replace(/^::ffff:/, '');
    if (cleanIp === '127.0.0.1' || cleanIp === '::1') return { country: 'Local', countryCode: '', city: '', region: '' };
    // ТЗ Eugene 11:16: страны на английском (объединение разных языков по country_code).
    const res = await fetch(`http://ip-api.com/json/${cleanIp}?fields=country,countryCode,city,regionName&lang=en`);
    const data = await res.json();
    const geo = {
      country: data.country || '',
      countryCode: data.countryCode || '',
      city: data.city || '',
      region: data.regionName || ''
    };
    geoCache.set(ip, geo);
    if (geoCache.size > 5000) { const first = geoCache.keys().next().value; geoCache.delete(first!); }
    return geo;
  } catch { return { country: '', countryCode: '', city: '', region: '' }; }
}

// Parse User-Agent
function parseUA(ua: string) {
  const mobile = /Mobile|Android|iPhone|iPad/i.test(ua);
  const tablet = /iPad|Tablet/i.test(ua);
  const device = tablet ? 'tablet' : mobile ? 'mobile' : 'desktop';
  const browser = /Chrome/i.test(ua) ? 'Chrome' : /Safari/i.test(ua) ? 'Safari' : /Firefox/i.test(ua) ? 'Firefox' : 'Other';
  const os = /Windows/i.test(ua) ? 'Windows' : /Mac/i.test(ua) ? 'macOS' : /Linux/i.test(ua) ? 'Linux' : /Android/i.test(ua) ? 'Android' : /iPhone|iPad/i.test(ua) ? 'iOS' : 'Other';
  return { device, browser, os };
}

// Rate limiter for registration (anti-bot)
const regAttempts = new Map<string, { count: number; first: number }>();
function checkRegRateLimit(ip: string): boolean {
  const now = Date.now();
  const entry = regAttempts.get(ip);
  if (!entry || now - entry.first > 3600000) { regAttempts.set(ip, { count: 1, first: now }); return true; }
  entry.count++;
  return entry.count <= 5; // max 5 registrations per hour per IP
}

// In-memory IP → geo cache (живёт пока процесс работает; сбрасывается при pm2 restart)
const ipGeoCache = new Map<string, { city: string; region: string; country: string; countryCode: string; ts: number }>();
const IP_GEO_TTL = 7 * 24 * 60 * 60 * 1000; // 7 дней

// Resolve IP → city/country через ip-api.com (бесплатно, без ключа).
// Результат сохраняется в кэш + прямо в строку gen_activity при записи.
async function resolveIpGeo(ip: string): Promise<{ city: string; region: string; country: string; countryCode: string } | null> {
  if (!ip) return null;
  // Исключаем локальные/приватные IP — ip-api их отклоняет
  const cleaned = ip.replace(/^::ffff:/, "").trim();
  if (
    cleaned === "127.0.0.1" || cleaned === "::1" || cleaned.startsWith("10.") ||
    cleaned.startsWith("192.168.") || cleaned.startsWith("172.16.") ||
    cleaned === "localhost" || !cleaned
  ) return null;

  const cached = ipGeoCache.get(cleaned);
  if (cached && Date.now() - cached.ts < IP_GEO_TTL) {
    return { city: cached.city, region: cached.region, country: cached.country, countryCode: cached.countryCode };
  }

  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 4000);
    // Eugene 2026-05-08: всегда lang=en для консистентного country-имени
    // (объединяем 'Russia'/'Россия' через country_code).
    const res = await fetch(`http://ip-api.com/json/${encodeURIComponent(cleaned)}?fields=status,country,countryCode,regionName,city,query&lang=en`, { signal: ctrl.signal });
    clearTimeout(t);
    const j: any = await res.json();
    if (j.status !== "success") return null;
    const geo = {
      city: j.city || "",
      region: j.regionName || "",
      country: j.country || "",
      countryCode: j.countryCode || "",
    };
    ipGeoCache.set(cleaned, { ...geo, ts: Date.now() });
    return geo;
  } catch {
    return null;
  }
}

// Log gen activity. Георезолв делается фоново (не блокирует ответ пользователя).
// Eugene 2026-05-17 Босс: host — per-domain трекинг (muzaai.ru / muziai.ru /
// podaripesnu.ru). Опциональный — старые call-site'ы не передают (NULL → "other").
function logGenActivity(genId: number, action: string, ip?: string, host?: string | null) {
  const cleanIp = (ip || "").replace(/^::ffff:/, "").trim();
  let inserted: any;
  try {
    inserted = db.insert(genActivity).values({ genId, action, ip: cleanIp, host: host || null }).returning().get();
  } catch { return; }
  // Асинхронно дорезолвим географию
  if (inserted?.id && cleanIp) {
    resolveIpGeo(cleanIp).then(geo => {
      if (!geo) return;
      try {
        db.update(genActivity).set({
          city: geo.city, region: geo.region, country: geo.country, countryCode: geo.countryCode,
        }).where(eq(genActivity.id, inserted.id)).run();
      } catch {}
    }).catch(() => {});
  }
}

export async function registerRoutes(
  httpServer: Server,
  app: Express
): Promise<Server> {
  ensureSeedAdmin();

  // RULE: Generations are NEVER auto-deleted. Lifespan is unlimited.
  // Only the author can delete their own generation (with email confirmation).


  // ==================== AUTH ====================
  // Get referral info
  app.get("/api/referral/info", authMiddleware, (req: Request, res: Response) => {
    const userId = (req as any).userId;
    const user = storage.getUser(userId);
    if (!user) { res.status(404).json({ message: "Не найден" }); return; }
    const referralCount = db.select({ count: sql<number>`count(*)` }).from(users).where(eq(users.referredBy, userId)).get();
    // Count free tracks earned from referrals
    const refBonusTxns = db.select({ count: sql<number>`count(*)` }).from(transactions)
      .where(and(
        eq(transactions.userId, userId),
        sql`description LIKE '%Бонус%ссылке%' OR description LIKE '%Бонус%оплат%'`
      )).get();
    res.json({
      referralCode: user.referralCode,
      referralLink: `${PUBLIC_URL}/#/r/${user.referralCode}`,
      shortLink: `MuzaAi.ru/r/${user.referralCode}`,
      referrals: referralCount?.count || 0,
      bonusTracks: refBonusTxns?.count || 0,
    });
  });

  // ==================== SUNO WEBHOOK ====================
  // Eugene 2026-05-08 doc-audit: GPTunnel шлёт сюда POST когда Suno завершил
  // генерацию. Заменяет 5-сек polling. Параллельно polling остаётся как
  // fallback (если webhook потерялся, gen всё равно подберётся).
  //
  // URL: https://<host>/api/suno/webhook?gen_id=<id>&sig=<hmac>
  // Сервер сравнивает sig = HMAC(SUNO_WEBHOOK_SECRET, gen_id) → если ОК,
  // обновляет статус gen и сохраняет audio_url.
  //
  // ВАЖНО Eugene 2026-05-08 21:11: webhook payload структура от GPTunnel
  // не задокументирована — gen #671 показал что callback может прийти с
  // промежуточным status="running" без audio_url, и наш строгий handler
  // ошибочно помечал error+refund. ТЕПЕРЬ:
  //   - data.status='succeeded'|'done' + audio_url найден → done
  //   - data.status='failed'|'error' + явная ошибка → error (polling уже
  //     рефандит через storage.refundGeneration атомарно)
  //   - всё остальное (running/processing/intermediate/unknown shape) →
  //     200 OK без изменения состояния gen. Polling сам всё закроет.
  // Это убирает класс багов «webhook убил живую генерацию».
  const sunoWebhookHandler = async (req: Request, res: Response) => {
    try {
      const genId = parseInt(String(req.query.gen_id || ""), 10);
      const sig = String(req.query.sig || "");
      if (!genId || !sig) { res.status(400).json({ error: "missing gen_id/sig" }); return; }
      const expected = crypto.createHmac("sha256", SUNO_WEBHOOK_SECRET).update(String(genId)).digest("hex").slice(0, 16);
      if (!crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) {
        res.status(403).json({ error: "bad signature" });
        return;
      }
      const gen = storage.getGeneration(genId);
      if (!gen) { res.status(404).json({ error: "gen not found" }); return; }
      // Idempotency Eugene 2026-05-08: webhook может прийти ПОСЛЕ timeout-error.
      // Если gen уже не 'processing' — игнорируем (защита от double-spending:
      // рефанд + бесплатный трек если Suno поздно всё-таки отдал результат).
      if (gen.status !== "processing") {
        console.log(`[SUNO-WEBHOOK] gen #${genId} already ${gen.status}, ignoring late webhook`);
        res.json({ ok: true, ignored: true, currentStatus: gen.status });
        return;
      }

      const data: any = req.body || {};
      console.log(`[SUNO-WEBHOOK] gen #${genId} payload:`, JSON.stringify(data).slice(0, 600));

      // Извлечение audio_url из разных возможных мест в payload
      const audioUrl =
        data?.audio_url ||
        data?.url ||
        (Array.isArray(data?.result)
          ? (data.result.find((t: any) => t?.audio_url && (t?.status === "succeeded" || !t?.status))?.audio_url)
          : data?.result?.audio_url || (typeof data?.result === "string" ? data.result : null));

      const isFinalSuccess = audioUrl && (data?.status === "succeeded" || data?.status === "done" || !data?.status);
      const isFinalError = !audioUrl && (data?.status === "failed" || data?.status === "error") &&
                           (data?.message || data?.error || data?.code === 1 || data?.code === 1001);

      if (isFinalSuccess) {
        storage.updateGeneration(genId, {
          status: "done",
          resultUrl: audioUrl,
          resultData: JSON.stringify(data),
        });
        saveGenFiles(genId).catch(() => {});

        // Bonus 2-й трек если Suno вернул пару
        if (Array.isArray(data?.result) && data.result.length > 1) {
          try {
            const second = data.result.find((t: any, i: number) =>
              i > 0 && t?.audio_url && t.audio_url !== audioUrl);
            if (second && !db.select().from(generations)
              .where(and(eq(generations.userId, gen.userId), eq(generations.taskId, gen.taskId || ""), sql`${generations.id} != ${gen.id}`))
              .get()) {
              const gen2 = storage.createGeneration({
                userId: gen.userId, type: "music",
                prompt: gen.prompt || "", style: gen.style || "",
                cost: 0, status: "done",
                isPublic: gen.isPublic, authorName: gen.authorName || undefined,
                taskId: gen.taskId || undefined,
              });
              storage.updateGeneration(gen2.id, { resultUrl: second.audio_url, resultData: JSON.stringify(second) });
              saveGenFiles(gen2.id).catch(() => {});
              console.log(`[SUNO-WEBHOOK] bonus track gen #${gen2.id} created from pair`);
            }
          } catch (e) { console.error("[SUNO-WEBHOOK] bonus track creation failed:", e); }
        }

        console.log(`[SUNO-WEBHOOK] gen #${genId} → done, audio=${audioUrl.slice(0, 80)}`);
        res.json({ ok: true, status: "done" });
        return;
      }

      if (isFinalError) {
        const reason = data?.message || data?.error?.message || `code=${data?.code} status=${data?.status}`;
        storage.updateGeneration(genId, { status: "error", errorReason: reason });
        if (gen.cost && gen.cost > 0) {
          storage.refundGeneration({
            genId, userId: gen.userId, cost: gen.cost, type: "music",
            description: `Возврат: webhook error #${genId} — ${reason.slice(0, 80)}`,
          });
        }
        console.log(`[SUNO-WEBHOOK] gen #${genId} → error: ${reason}`);
        res.json({ ok: true, status: "error" });
        return;
      }

      // Промежуточный статус (running/processing/etc.) — НЕ трогаем gen.
      // Polling /api/music/status или timeout-watcher закроют когда будет финал.
      console.log(`[SUNO-WEBHOOK] gen #${genId} → intermediate (status=${data?.status}, code=${data?.code}), igноре, polling доделает`);
      res.json({ ok: true, status: "intermediate" });
    } catch (e: any) {
      console.error("[SUNO-WEBHOOK] error:", e?.message || e);
      res.status(500).json({ error: "internal" });
    }
  };
  app.post("/api/suno/webhook", sunoWebhookHandler);
  app.get("/api/suno/webhook", sunoWebhookHandler); // на случай если GPTunnel шлёт GET

  // Track visitor
  app.post("/api/track-visit", async (req: Request, res: Response) => {
    try {
      const ip = (req.headers['x-forwarded-for'] as string)?.split(',')[0]?.trim() || req.ip || req.socket.remoteAddress || 'unknown';
      const ua = req.headers['user-agent'] || '';
      const { fingerprint, pageUrl, sessionId } = req.body;

      // Eugene 2026-05-19 Босс «4575 visits / 44 unique = боты». Bot UA filter
      // на запись (Counters-audit D.1) + path-фильтр (D.6). Read-side фильтр
      // уже был, но писали ВСЕХ → перекос.
      if (isBotUserAgent(String(ua))) {
        return res.json({ ok: true, skipped: "bot-ua" });
      }
      if (typeof pageUrl === "string" && /^https?:\/\/[^/]+\/(api\/|favicon|robots\.txt|healthz|sitemap)/i.test(pageUrl)) {
        return res.json({ ok: true, skipped: "non-page" });
      }

      const { device, browser, os } = parseUA(ua);
      const geo = await getGeo(ip);
      // Per-domain трекинг (Eugene 2026-05-17 Босс): muzaai.ru / muziai.ru /
      // podaripesnu.ru. Старые записи без host → bucket "other".
      const host = extractHost(req);
      // Upsert by fingerprint or IP
      const key = fingerprint || ip;
      const existing = db.select().from(visitors).where(sql`${visitors.fingerprint} = ${key} OR (${visitors.ip} = ${ip} AND ${visitors.fingerprint} IS NULL)`).get();
      if (existing) {
        // Eugene 2026-05-19 Counters-audit D.3: IP+page dedup, окно 5 мин.
        // Один юзер refresh'ит SPA route 100 раз → 1 visit, не 100.
        const lastTs = existing.lastVisit ? new Date(existing.lastVisit).getTime() : 0;
        const isRecent = lastTs > Date.now() - 5 * 60 * 1000;
        const samePage = existing.pageUrl === pageUrl;
        if (isRecent && samePage) {
          return res.json({ ok: true, deduped: true });
        }
        // host обновляем только если был NULL — иначе оставляем первый
        // зарегистрированный домен (visitor мог зайти с muzaai.ru, потом
        // переключиться на muziai.ru — но для аналитики важен первоисточник).
        db.update(visitors).set({
          visits: existing.visits + 1,
          lastVisit: new Date().toISOString(),
          pageUrl: pageUrl || existing.pageUrl,
          userId: req.body.userId || existing.userId,
          host: existing.host || host || null,
        }).where(eq(visitors.id, existing.id)).run();
      } else {
        db.insert(visitors).values({ ip, fingerprint: key, country: geo.country, countryCode: geo.countryCode, city: geo.city, region: geo.region, userAgent: ua, referer: req.headers.referer || '', device, browser, os, pageUrl, sessionId, userId: req.body.userId || null, host }).run();
      }

      // Eugene 2026-05-17 Босс «Cookies + IP geo + identifying автор». В дополнение
      // к visitors (raw event log) — единый профиль visitor/author в user_profiles.
      // Доступ к нему — только админ (см. plugins/user-profiles/module.ts).
      try {
        const visitorId = getOrCreateVisitorId(req, res);
        const enriched = await getIpGeo(ip, req.headers as any);
        // optional auth — узнаём userId если есть валидный Bearer token
        let authedUserId: number | null = null;
        try {
          const tk = (req.headers.authorization || "").startsWith("Bearer ")
            ? (req.headers.authorization as string).slice(7)
            : (typeof req.query.token === "string" ? req.query.token : null);
          if (tk && tokenStore.has(tk)) authedUserId = tokenStore.get(tk) ?? null;
        } catch {}
        // UTM / referrer / pageUrl — пишем в cookieData JSON для admin-просмотра
        const cookieData: Record<string, unknown> = {};
        if (req.headers.referer) cookieData.referrer = String(req.headers.referer).slice(0, 500);
        if (pageUrl) cookieData.lastPage = String(pageUrl).slice(0, 500);
        if (sessionId) cookieData.lastSessionId = String(sessionId).slice(0, 120);
        // UTM из query body (фронт может прокинуть)
        for (const k of ["utm_source", "utm_medium", "utm_campaign", "utm_term", "utm_content"]) {
          const v = (req.body as any)?.[k];
          if (typeof v === "string" && v.length > 0 && v.length < 200) cookieData[k] = v;
        }
        upsertUserProfile({
          visitorId,
          userId: authedUserId ?? (req.body.userId as number | undefined) ?? null,
          ip,
          ipCountry: enriched.country,
          ipCity: enriched.city,
          ipRegion: enriched.region,
          ipAsn: enriched.asn,
          userAgent: String(ua),
          device, browser, os,
          cookieData,
        });
      } catch (e) {
        console.error("[user-profiles] track-visit hook failed:", e);
      }

      res.json({ ok: true });
    } catch { res.json({ ok: true }); }
  });

  // Admin: visitor statistics
  app.get("/api/admin/visitors", authMiddleware, (req: Request, res: Response) => {
    const user = storage.getUser((req as any).userId);
    if (!isAdminUser(user)) { res.status(403).end(); return; }
    const page = parseInt(req.query.page as string) || 1;
    const limit = 50;
    const offset = (page - 1) * limit;
    const raw = db.$client;
    const total = raw.prepare("SELECT COUNT(*) as cnt FROM visitors").get() as any;
    const rows = raw.prepare("SELECT * FROM visitors ORDER BY last_visit DESC LIMIT ? OFFSET ?").all(limit, offset);
    res.json({ total: total?.cnt || 0, page, visitors: rows });
  });

  // Admin: visitor stats summary
  app.get("/api/admin/visitor-stats", authMiddleware, (req: Request, res: Response) => {
    const user = storage.getUser((req as any).userId);
    if (!isAdminUser(user)) { res.status(403).end(); return; }
    res.setHeader("Cache-Control", "no-store");

    // Фильтр периода — единая логика через periodBoundaries (cut-off 20:00 МСК).
    // Eugene 2026-05-17 Босс «единая логика period boundaries во всех endpoints».
    const period = String(req.query.period || "all");
    // Eugene 2026-05-17 Босс: per-domain фильтр (muzaai.ru / muziai.ru /
    // podaripesnu.ru / other). Безопасно — domain валидируется через whitelist.
    const domainRaw = typeof req.query.domain === "string" ? req.query.domain.trim().toLowerCase() : "";
    let domainSql = ""; // фрагмент типа `host = 'muzaai.ru'` без WHERE/AND.
    if (domainRaw && domainRaw !== "all") {
      if (domainRaw === "other") {
        const list = KNOWN_DOMAINS.map(d => `'${d}'`).join(",");
        domainSql = `(host IS NULL OR host NOT IN (${list}))`;
      } else if ((KNOWN_DOMAINS as readonly string[]).includes(domainRaw)) {
        domainSql = `host = '${domainRaw}'`;
      }
    }

    let dateFilter = "";
    if (period && period !== "all") {
      const r = getPeriodRange(period);
      dateFilter = `WHERE last_visit >= '${r.fromIso}' AND last_visit < '${r.toIso}'`;
    }
    // Объединяем dateFilter + domainSql в один WHERE-фрагмент.
    let combinedWhere = dateFilter;
    if (domainSql) {
      combinedWhere = combinedWhere
        ? `${combinedWhere} AND ${domainSql}`
        : `WHERE ${domainSql}`;
    }
    // Eugene 2026-05-18 Босс «автофильтр ботов». Bot UA исключаем из ВСЕХ
    // публичных сводок. Записи в БД остаются (нужно для аудита/блокировок) —
    // фильтр только на чтении. По умолчанию включён, можно отключить через
    // ?includeBots=1 (для admin-аудита тех самых ботов).
    const includeBots = String(req.query.includeBots || "") === "1";
    const botExclSql = includeBots ? "" : buildBotExclusionSql("user_agent");
    if (botExclSql) {
      combinedWhere = combinedWhere
        ? `${combinedWhere} AND ${botExclSql}`
        : `WHERE ${botExclSql}`;
    }
    // Для запросов с дополнительным условием (AND country IS NOT NULL и т.п.) —
    // решаем нужен ли отдельный prefix.
    const wherePrefix = combinedWhere ? combinedWhere : "WHERE 1=1";
    const _unused_dateFilter = dateFilter; // legacy compat, см. инлайн ниже
    void _unused_dateFilter;

    const raw = db.$client;
    // Быстрые сводки (для верхних карточек) — bot filter применяется ВЕЗДЕ.
    const botExtra = botExclSql ? ` AND ${botExclSql}` : "";
    const today = new Date().toISOString().slice(0, 10);
    const week = new Date(Date.now() - 7 * 86400000).toISOString();
    const total = raw.prepare(`SELECT COUNT(DISTINCT COALESCE(fingerprint, ip)) as c FROM visitors WHERE 1=1${botExtra}`).get() as any;
    const todayC = raw.prepare(`SELECT COUNT(DISTINCT COALESCE(fingerprint, ip)) as c FROM visitors WHERE date(last_visit) = ?${botExtra}`).get(today) as any;
    const weekC = raw.prepare(`SELECT COUNT(DISTINCT COALESCE(fingerprint, ip)) as c FROM visitors WHERE last_visit >= ?${botExtra}`).get(week) as any;

    // Сводки с учётом фильтра периода + домена.
    const periodTotal = raw.prepare(`SELECT COUNT(DISTINCT COALESCE(fingerprint, ip)) as c FROM visitors ${combinedWhere}`).get() as any;
    const periodVisits = raw.prepare(`SELECT COALESCE(SUM(visits), 0) as c FROM visitors ${combinedWhere}`).get() as any;

    // Страны: GROUP BY country_code объединяет «Russia» и «Россия» в одну
    // запись (Eugene 2026-05-08: «страны объедини, по английски пиши»).
    // Берём первое непустое country-имя из группы — для свежих записей это
    // английский (getGeo шлёт lang=en); старые ru-записи перекрываются.
    const byCountry = raw.prepare(`
      SELECT
        COALESCE(country_code, '??') as countryCode,
        MAX(country) as name,
        MAX(country) as country,
        COUNT(DISTINCT COALESCE(fingerprint, ip)) as visitors,
        COALESCE(SUM(visits), 0) as visits
      FROM visitors
      ${wherePrefix} AND country IS NOT NULL AND country != ''
      GROUP BY country_code
      ORDER BY visitors DESC LIMIT 30
    `).all();

    // Города: GROUP BY (city, country_code) — тот же принцип объединения.
    const byCity = raw.prepare(`
      SELECT
        city,
        COALESCE(country_code, '??') as countryCode,
        MAX(country) as country,
        (city || ', ' || COALESCE(MAX(country), '')) as name,
        COUNT(DISTINCT COALESCE(fingerprint, ip)) as visitors,
        COALESCE(SUM(visits), 0) as visits
      FROM visitors
      ${wherePrefix} AND city IS NOT NULL AND city != ''
      GROUP BY city, country_code
      ORDER BY visitors DESC LIMIT 50
    `).all();

    // IP-адреса с количеством визитов на каждый
    const byIp = raw.prepare(`
      SELECT ip,
        MAX(city) as city,
        MAX(country) as country,
        MAX(country_code) as countryCode,
        MAX(device) as device,
        MAX(browser) as browser,
        COALESCE(SUM(visits), 0) as visits,
        MAX(last_visit) as lastVisit
      FROM visitors
      ${wherePrefix} AND ip IS NOT NULL AND ip != ''
      GROUP BY ip ORDER BY visits DESC LIMIT 200
    `).all();

    const byDevice = raw.prepare(`SELECT device, COUNT(DISTINCT COALESCE(fingerprint, ip)) as c FROM visitors WHERE 1=1${botExtra} GROUP BY device`).all();
    const byBrowser = raw.prepare(`SELECT browser, COUNT(DISTINCT COALESCE(fingerprint, ip)) as c FROM visitors WHERE 1=1${botExtra} GROUP BY browser ORDER BY c DESC LIMIT 5`).all();

    res.json({
      total: total?.c || 0,
      today: todayC?.c || 0,
      week: weekC?.c || 0,
      period,
      domain: domainSql ? domainRaw : null,
      botsFiltered: !includeBots,
      periodTotal: periodTotal?.c || 0,
      periodVisits: periodVisits?.c || 0,
      byCountry,
      byCity,
      byIp,
      byDevice,
      byBrowser,
    });
  });

  // Pending registrations (email verification)
  const pendingRegs = new Map<string, { name: string; email: string; password: string; ref?: string; promo?: string; code: string; expires: number }>();

  app.post("/api/auth/register", async (req: Request, res: Response) => {
    const ip = req.ip || req.socket.remoteAddress || "unknown";
    if (!rateLimit(ip + ":reg", 5, 3600000)) {
      res.status(429).json({ message: "Слишком много попыток. Попробуйте позже." }); return;
    }
    if (req.body.website) { res.status(200).json({ token: "ok", user: {} }); return; }
    logEngagement(req, "email_register_attempt", { channel: "email", meta: { email: String(req.body?.email || "").slice(0, 80) } });
    try {
      const parsed = registerSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ message: parsed.error.errors[0]?.message || "Ошибка валидации" });
        return;
      }
      const { email, password, ref, promo } = parsed.data;
      const name = parsed.data.name || email.split("@")[0];

      if (storage.getUserByEmail(email)) {
        res.status(409).json({ message: "Email уже зарегистрирован" });
        return;
      }

      // Check if name is taken
      if (name) {
        const nameTaken = db.select().from(users).where(sql`LOWER(${users.name}) = LOWER(${name})`).get();
        if (nameTaken) {
          const base = name.replace(/\d+$/, '');
          const alts: string[] = [];
          for (let i = 1; alts.length < 3 && i <= 20; i++) {
            const alt = `${base}${i}`;
            if (!db.select().from(users).where(sql`LOWER(${users.name}) = LOWER(${alt})`).get()) alts.push(alt);
          }
          const suggText = alts.length ? `. Попробуйте: ${alts.join(', ')}` : '';
          res.status(400).json({ message: `Имя «${name}» уже занято${suggText}` });
          return;
        }
      }

      // Send verification code
      const code = String(Math.floor(100000 + Math.random() * 900000));
      pendingRegs.set(email.toLowerCase(), { name, email, password, ref, promo, code, expires: Date.now() + 15 * 60 * 1000 });
      try {
        await mailTransport.sendMail({
          from: `"MuzaAi" <${CLIENT_EMAIL}>`, replyTo: CLIENT_EMAIL,
          to: email,
          subject: "MuzaAi — код подтверждения регистрации",
          html: `<div style="font-family:-apple-system,sans-serif;max-width:400px;margin:0 auto;padding:24px;background:#09090b;border-radius:16px;border:1px solid #1a1a2e;color:#e0e0e0">
            <h2 style="color:#a78bfa;margin:0 0 16px">MuzaAi</h2>
            <p>Ваш код подтверждения:</p>
            <p style="font-size:32px;font-weight:bold;color:#8b5cf6;letter-spacing:4px;text-align:center;margin:20px 0">${code}</p>
            <p style="color:#888;font-size:13px">Код действует 15 минут.</p>
          </div>`,
        });
      } catch (e) { console.log('[REG] Email send error:', e); }

      res.json({ needVerification: true, message: "Код отправлен на " + email });
    } catch (err: any) {
      res.status(500).json({ message: err.message });
    }
  });

  // Verify email and complete registration
  app.post("/api/auth/verify-register", async (req: Request, res: Response) => {
    try {
      const { email, code } = req.body;
      const key = email?.toLowerCase();
      const pending = pendingRegs.get(key);
      if (!pending) { res.status(400).json({ message: "Сначала запросите регистрацию" }); return; }
      if (Date.now() > pending.expires) { pendingRegs.delete(key); res.status(400).json({ message: "Код истёк" }); return; }
      if (pending.code !== code) { res.status(400).json({ message: "Неверный код" }); return; }
      pendingRegs.delete(key);

      // Actually create user
      const { name, password, ref, promo } = pending;

      // Double-check email not taken
      if (storage.getUserByEmail(email)) {
        res.status(409).json({ message: "Email уже зарегистрирован" }); return;
      }

      // Check referral code
      let referrerId: number | null = null;
      if (ref) {
        const referrer = db.select().from(users).where(eq(users.referralCode, ref)).get();
        if (referrer) referrerId = referrer.id;
      }

      const user = storage.createUser({ name, email, password });

      // Generate short referral code (no welcome bonus — promo code handles it)
      const referralCode = `s${user.id}`;
      db.update(users).set({
        emailVerified: 1,
        referralCode,
        referredBy: referrerId,
        balance: 0,
      }).where(eq(users.id, user.id)).run();

      // Eugene 2026-05-14 Босс «создай профиль если зарегистрируется,
      // исходя из данных в личном кабинете». Найти chatbot-сессию где
      // юзер давал email или общался → extractMemo → save в users.profile.
      try {
        const raw = (db as any).$client;
        const sessRow = raw.prepare(`
          SELECT cs.id FROM chatbot_sessions cs
          JOIN chatbot_messages cm ON cm.session_id = cs.id
          WHERE cs.channel = 'web'
            AND cm.role = 'user'
            AND lower(cm.text) LIKE ?
          ORDER BY cs.last_message_at DESC LIMIT 1
        `).get(`%${email.toLowerCase()}%`);
        if (sessRow?.id) {
          const sessHistory = loadSessionHistory(sessRow.id, 50);
          const sessMemo = extractMemoryFromHistory(sessHistory);
          db.update(users).set({
            profile: JSON.stringify({ ...sessMemo, source: "web-chat", linkedAt: new Date().toISOString() }),
            // Если поля ещё не заполнены другими — заполняем из чата
            ...(sessMemo.country && !user.country ? { country: sessMemo.country } : {}),
          }).where(eq(users.id, user.id)).run();
          // Linкуем session.user_id → user.id (чат теперь принадлежит юзеру)
          db.update(chatbotSessions).set({ userId: user.id }).where(eq(chatbotSessions.id, sessRow.id)).run();
          console.log(`[PROFILE-LINK] User #${user.id} (${email}) linked from chat session ${sessRow.id.slice(0,16)} — memo: ${Object.keys(sessMemo).filter(k => (sessMemo as any)[k]).join(",")}`);
        }
      } catch (e) {
        console.warn("[PROFILE-LINK] failed:", e);
      }

      // Eugene 2026-05-14 Босс: правило «1000 первых из РФ + ближнее зарубежье».
      // Lookup geo по IP регистрирующего, сохраняем country/countryCode,
      // и если страна СНГ + общий счётчик welcomeGiftGiven < 1000 — выдаём
      // 1 подарочный трек + транзакцию + помечаем welcomeGiftGiven=1.
      //
      // Race-safe: count+update обёрнуто в sqlite.transaction (better-sqlite3
      // serializes writes), чтобы два одновременных register не вышли за
      // лимит 1000.
      try {
        const regIp = (req.ip || req.socket.remoteAddress || "").replace(/^::ffff:/, "");
        const geo = await getGeo(regIp);
        if (geo.country || geo.countryCode) {
          db.update(users).set({
            country: geo.country || null,
            countryCode: geo.countryCode || null,
          }).where(eq(users.id, user.id)).run();
        }
        if (isCISCountry(geo.countryCode)) {
          const raw = (db as any).$client;
          const giftResult = raw.transaction(() => {
            const row = raw.prepare("SELECT COUNT(*) AS c FROM users WHERE welcome_gift_given = 1").get() as { c: number };
            const giftedSoFar = Number(row?.c || 0);
            if (giftedSoFar >= WELCOME_GIFT_LIMIT) return { gifted: false, position: giftedSoFar };
            raw.prepare("UPDATE users SET bonus_tracks = bonus_tracks + 1, welcome_gift_given = 1 WHERE id = ? AND welcome_gift_given = 0").run(user.id);
            return { gifted: true, position: giftedSoFar + 1 };
          })();
          if (giftResult.gifted) {
            storage.createTransaction({
              userId: user.id,
              type: "topup",
              amount: 0,
              description: `🎁 Подарочный трек: первые 1000 авторов из РФ и ближнего зарубежья (#${giftResult.position} из 1000)`,
            });
            console.log(`[WELCOME-GIFT] User #${user.id} (${geo.countryCode}) received gift track #${giftResult.position}/1000`);
          } else {
            console.log(`[WELCOME-GIFT] Limit reached (${giftResult.position}/1000) — User #${user.id} (${geo.countryCode}) NOT gifted`);
          }
        }
      } catch (e) {
        console.error("[WELCOME-GIFT] Error checking eligibility:", e);
      }

      // Promo code bonus (only if user entered one)
      if (promo) {
      const promoCode = db.select().from(promoCodes)
        .where(sql`LOWER(${promoCodes.code}) = LOWER(${promo})`).get();
      const now = new Date().toISOString();
      // Eugene 2026-05-18 Босс «при вводе ЛЮБОГО промокода (даже неактивного) —
      // email/Telegram уведомление Боссу». Считаем статус ДО применения бонуса,
      // чтобы alert содержал точный verdict.
      let promoActive = false;
      let promoReason: string | undefined;
      if (promoCode) {
        const inWindow = (!promoCode.activeFrom || promoCode.activeFrom <= now) && (!promoCode.activeTo || promoCode.activeTo >= now);
        const withinLimit = promoCode.maxUses === 0 || promoCode.usedCount < promoCode.maxUses;
        promoActive = inWindow && withinLimit;
        if (!inWindow) promoReason = "вне окна активности (activeFrom/activeTo)";
        else if (!withinLimit) promoReason = `исчерпан лимит ${promoCode.maxUses} использований`;
      } else {
        promoReason = "промокод не найден в БД";
      }
      try {
        alertPromoEntry({
          email,
          name: name || null,
          ip: (req.ip || req.socket.remoteAddress || "unknown").replace(/^::ffff:/, ""),
          userAgent: String(req.headers["user-agent"] || ""),
          promoCode: String(promo),
          promoFound: !!promoCode,
          promoActive,
          promoReason,
          timestamp: now,
        }, mailTransport, CLIENT_EMAIL);
      } catch (e) {
        console.warn("[promo-alert] hook failed:", (e as Error)?.message || e);
      }
      if (promoCode && promoActive) {
        if (promoCode.bonus > 0) {
          storage.updateBalance(user.id, promoCode.bonus);
          storage.createTransaction({ userId: user.id, type: "topup", amount: promoCode.bonus, description: `🎟️ Промокод ${promoCode.code}: +${(promoCode.bonus / 100)} ₽` });
        }
        if (promoCode.bonusTracks > 0) {
          db.update(users).set({ bonusTracks: sql`${users.bonusTracks} + ${promoCode.bonusTracks}` }).where(eq(users.id, user.id)).run();
          storage.createTransaction({ userId: user.id, type: "topup", amount: 0, description: `🎁 Промокод ${promoCode.code}: +${promoCode.bonusTracks} подарочн. треков` });
        }
        db.update(promoCodes).set({ usedCount: promoCode.usedCount + 1 }).where(eq(promoCodes.id, promoCode.id)).run();
        db.update(users).set({ usedPromo: promoCode.code }).where(eq(users.id, user.id)).run();
        console.log(`[PROMO] User #${user.id} used promo '${promoCode.code}' +${promoCode.bonus / 100}₽ +${promoCode.bonusTracks}tracks`);
      } else if (promoCode) {
        console.log(`[PROMO] User #${user.id} entered inactive promo '${promoCode.code}' — ${promoReason || "rejected"}`);
      } else {
        console.log(`[PROMO] User #${user.id} entered unknown promo '${promo}'`);
      }
      }

      // If registered via referral — both get bonus
      if (referrerId) {
        const REFERRAL_BONUS = 39900; // 399₽ = 1 music track
        storage.updateBalance(user.id, REFERRAL_BONUS);
        storage.createTransaction({ userId: user.id, type: "topup", amount: REFERRAL_BONUS, description: "🎁 Бонус за реферальную регистрацию: +399 ₽" });

        // Referrer gets bonus too
        const referrerUser = storage.getUser(referrerId);
        if (referrerUser) {
          storage.updateBalance(referrerId, REFERRAL_BONUS);
          storage.createTransaction({ userId: referrerId, type: "topup", amount: REFERRAL_BONUS, description: `🎁 Бонус: автор ${name} по вашей ссылке: +399 ₽` });
        }
        console.log(`[REFERRAL] User #${user.id} registered via referral from #${referrerId}`);
      }

      const token = uuidv4();
      tokenStore.set(token, user.id);

      const updatedUser = storage.getUser(user.id);
      const { password: _, nameChangeToken: __nct, ...publicUser } = updatedUser || user;
      res.json({ token, user: { ...publicUser, emailVerified: 1, referralCode } });
    } catch (e: any) {
      res.status(500).json({ message: e.message });
    }
  });

  app.post("/api/auth/login", async (req: Request, res: Response) => {
    const ip = req.ip || req.socket.remoteAddress || "unknown";
    if (!rateLimit(ip + ":login", 10, 900000)) {
      res.status(429).json({ message: "Слишком много попыток. Подождите 15 минут." }); return;
    }
    if (req.body.website) { res.status(200).json({ token: "ok", user: {} }); return; }
    logEngagement(req, "email_login_attempt", { channel: "email", meta: { email: String(req.body?.email || "").slice(0, 80) } });
    try {
      const parsed = loginSchema.safeParse(req.body);
      if (!parsed.success) {
        logUserActionFailure({
          channel: "web", action: "login", statusCode: 400,
          errorCode: "validation",
          errorMessage: parsed.error.errors[0]?.message || "validation error",
          endpoint: "/api/login",
          context: { email: String(req.body?.email || "").slice(0, 80) },
        });
        res.status(400).json({ message: parsed.error.errors[0]?.message || "Ошибка валидации" });
        return;
      }
      const { email, password } = parsed.data;

      const user = storage.getUserByEmail(email);
      if (!user || !bcrypt.compareSync(password, user.password)) {
        logUserActionFailure({
          userId: user?.id ?? null,
          channel: "web", action: "login", statusCode: 401,
          errorCode: user ? "wrong_password" : "user_not_found",
          errorMessage: "Неверный email или пароль",
          endpoint: "/api/login",
          context: { email: email.slice(0, 80) },
        });
        res.status(401).json({ message: "Неверный email или пароль" });
        return;
      }

      const token = uuidv4();
      tokenStore.set(token, user.id);
      logEngagement(req, "email_login_success", { channel: "email", userId: user.id });

      // Eugene 2026-05-17 Босс «cookies + identifying автор» — линкуем
      // anonymous visitor (mzv cookie) к авторизованному userId.
      try {
        const visitorId = getOrCreateVisitorId(req, res);
        if (visitorId) linkProfileToUser(visitorId, user.id);
      } catch (e) {
        console.error("[user-profiles] login-link failed:", e);
      }

      const { password: _, nameChangeToken: __nct, ...publicUser } = user;
      res.json({ token, user: publicUser });
    } catch (e: any) {
      res.status(500).json({ message: e.message });
    }
  });

  app.get("/api/auth/me", authMiddleware, (req: Request, res: Response) => {
    const userId = (req as any).userId;
    const user = storage.getUser(userId);
    if (!user) {
      res.status(404).json({ message: "Пользователь не найден" });
      return;
    }
    const { password: _, nameChangeToken: __nct, ...publicUser } = user;
    res.json(publicUser);
  });

  app.post("/api/auth/logout", authMiddleware, (req: Request, res: Response) => {
    const token = getTokenFromRequest(req);
    if (token) tokenStore.delete(token);
    res.json({ ok: true });
  });

  // Eugene 2026-05-15 Босс «и всем по почте, когда кто авторизировался или
  // пытался» — broadcast про переход на новый домен. Отправляется всем
  // юзерам с настоящим email (не phone/telegram placeholder).
  //
  // Usage:
  //   GET /api/admin/v304/broadcast/domain-migration?dry=1 — список получателей без отправки
  //   POST /api/admin/v304/broadcast/domain-migration       — реальная отправка
  // Inline-helper для PII (логи/sample) — first2***@domain.
  const maskEmail = (e: string): string => {
    const at = e.indexOf("@");
    if (at < 2) return "***" + e.slice(Math.max(0, at));
    return e.slice(0, 2) + "***" + e.slice(at);
  };

  app.get("/api/admin/v304/broadcast/domain-migration", requireAdmin, (_req: Request, res: Response) => {
    try {
      // Реальные email: НЕ phone-placeholder + НЕ tg-placeholder + НЕ merged.
      const rows = db.all<{ id: number; email: string; name: string | null }>(sql`
        SELECT id, email, name FROM users
        WHERE email NOT LIKE '%@phone.muziai.ru'
          AND email NOT LIKE '%@telegram.muziai.ru'
          AND email NOT LIKE 'merged-%@deleted.local'
          AND email LIKE '%@%'
          AND (blocked IS NULL OR blocked = 0)
          AND (deleted_at IS NULL)
      `);
      res.json({
        ok: true,
        dry: true,
        recipientsCount: rows.length,
        sample: rows.slice(0, 5).map(r => ({ id: r.id, name: r.name, emailMasked: maskEmail(r.email) })),
      });
    } catch (e: any) {
      res.status(500).json({ ok: false, error: String(e?.message || e) });
    }
  });

  app.post("/api/admin/v304/broadcast/domain-migration", requireAdmin, async (req: Request, res: Response) => {
    try {
      const rows = db.all<{ id: number; email: string; name: string | null }>(sql`
        SELECT id, email, name FROM users
        WHERE email NOT LIKE '%@phone.muziai.ru'
          AND email NOT LIKE '%@telegram.muziai.ru'
          AND email NOT LIKE 'merged-%@deleted.local'
          AND email LIKE '%@%'
          AND (blocked IS NULL OR blocked = 0)
          AND (deleted_at IS NULL)
      `);

      const subject = "MuzaAi — новый адрес сайта: muzaai.ru";
      const text = (name: string | null) =>
        `Здравствуйте${name ? ", " + name : ""}!\n\n` +
        `У нашего сайта новый основной адрес: https://muzaai.ru\n\n` +
        `Старый адрес muziai.ru продолжает работать (он автоматически перенаправит на новый), но мы рекомендуем сохранить ссылку https://muzaai.ru в закладках.\n\n` +
        `Все ваши треки, обложки и тексты на месте — войти можно по тому же email и паролю, либо по звонку с телефона.\n\n` +
        `Если возникнут вопросы — напишите нам hello@muziai.ru.\n\n` +
        `— Команда MuzaAi`;
      const htmlBody = (name: string | null) => `
        <div style="font-family: -apple-system, sans-serif; max-width: 520px; margin: 0 auto; padding: 32px; background: #09090b; border-radius: 16px; border: 1px solid #1a1a2e;">
          <div style="text-align: center; margin-bottom: 24px;">
            <span style="font-size: 24px; font-weight: 700; background: linear-gradient(135deg, #8b5cf6, #3b82f6); -webkit-background-clip: text; -webkit-text-fill-color: transparent;">MuzaAi</span>
          </div>
          <p style="color: #e2e2e2; font-size: 15px; line-height: 1.6; margin: 0 0 16px;">Здравствуйте${name ? ", <strong>" + name + "</strong>" : ""}!</p>
          <p style="color: #e2e2e2; font-size: 15px; line-height: 1.6; margin: 0 0 16px;">У нашего сайта <strong>новый основной адрес</strong>:</p>
          <div style="text-align: center; margin: 24px 0;">
            <a href="https://muzaai.ru" style="display: inline-block; padding: 14px 32px; background: linear-gradient(135deg, #8b5cf6, #3b82f6); color: white; text-decoration: none; border-radius: 12px; font-size: 18px; font-weight: 600;">https://muzaai.ru</a>
          </div>
          <p style="color: #a1a1aa; font-size: 14px; line-height: 1.6; margin: 0 0 12px;">Старый адрес muziai.ru работает и автоматически перенаправит на новый, но рекомендуем сохранить новую ссылку в закладках.</p>
          <p style="color: #a1a1aa; font-size: 14px; line-height: 1.6; margin: 0 0 12px;">Все ваши треки, обложки и тексты на месте — войти можно по тому же email и паролю, либо по звонку с телефона.</p>
          <p style="color: #71717a; font-size: 13px; line-height: 1.6; margin: 24px 0 0;">Вопросы: <a href="mailto:hello@muziai.ru" style="color: #8b5cf6;">hello@muziai.ru</a></p>
          <p style="color: #71717a; font-size: 13px; margin: 8px 0 0;">— Команда MuzaAi</p>
        </div>
      `;

      let sent = 0;
      let failed = 0;
      const errors: Array<{ id: number; email: string; error: string }> = [];

      // Делаем по одному (не throttling — gmail вытягивает ~10 msg/sec на app-password).
      for (const r of rows) {
        try {
          await mailTransport.sendMail({
            from: `"MuzaAi" <${CLIENT_EMAIL}>`, replyTo: CLIENT_EMAIL,
            to: r.email,
            subject,
            text: text(r.name),
            html: htmlBody(r.name),
          });
          sent++;
        } catch (e: any) {
          failed++;
          errors.push({ id: r.id, email: maskEmail(r.email), error: String(e?.message || e).slice(0, 200) });
        }
      }

      res.json({
        ok: true,
        totalRecipients: rows.length,
        sent,
        failed,
        errors: errors.slice(0, 10),
      });
    } catch (e: any) {
      console.error("[broadcast/domain-migration]", e);
      res.status(500).json({ ok: false, error: String(e?.message || e) });
    }
  });


  //
  // Сценарий: юзер ранее зарегистрировался по email/паролю (phone=null).
  // Сегодня вошёл по звонку — backend создал новый phone-аккаунт (upsert).
  // Теперь хочет связать со старым email-аккаунтом: phone-аккаунт удалится,
  // его generations/payments перенесутся, юзер останется в email-аккаунте
  // (но теперь и с phone). Bearer-token надо обновить.
  //
  // Security: требует Bearer (текущий phone-only user) + правильный email +
  // правильный пароль от email-аккаунта (bcrypt verify).
  app.post("/api/auth/link-existing", authMiddleware, async (req: Request, res: Response) => {
    try {
      const currentUserId = (req as any).userId;
      const email = String(req.body?.email || "").trim().toLowerCase();
      const password = String(req.body?.password || "");
      if (!email || !password) {
        res.status(400).json({ message: "Укажите email и пароль" });
        return;
      }

      const currentUser = storage.getUser(currentUserId) as any;
      if (!currentUser) { res.status(401).json({ message: "Не авторизован" }); return; }

      // Проверка email-аккаунта.
      const targetUser = db.select().from(users).where(eq(users.email, email)).get() as any;
      if (!targetUser) {
        res.status(404).json({ message: "Аккаунт с таким email не найден" });
        return;
      }
      if (targetUser.id === currentUser.id) {
        res.status(400).json({ message: "Это и есть текущий аккаунт" });
        return;
      }
      if (targetUser.blocked) {
        res.status(403).json({ message: "Целевой аккаунт заблокирован" });
        return;
      }
      const passwordOk = bcrypt.compareSync(password, targetUser.password);
      if (!passwordOk) {
        res.status(401).json({ message: "Неверный пароль" });
        return;
      }
      // Целевой аккаунт уже имеет другой phone — не объединяем (риск дубля).
      if (targetUser.phone && targetUser.phone !== currentUser.phone) {
        res.status(409).json({
          message: "К email-аккаунту привязан другой номер. Сначала отвяжите его в настройках того аккаунта."
        });
        return;
      }

      const phoneToTransfer = currentUser.phone;

      // Перенос данных от phone-only user → email user.
      // Generations: переписываем userId.
      try {
        db.run(sql`UPDATE generations SET user_id = ${targetUser.id} WHERE user_id = ${currentUser.id}`);
      } catch (e) { console.warn("[link-existing] generations move failed", e); }
      // Все возможные таблицы с user_id (минимум — generations + payments + transactions если они есть). Делаем best-effort:
      const userIdTables = ["payments", "transactions", "gen_activity", "song_drafts", "lyric_packs", "covers"];
      for (const t of userIdTables) {
        try {
          db.run(sql.raw(`UPDATE ${t} SET user_id = ${targetUser.id} WHERE user_id = ${currentUser.id}`));
        } catch {}
      }

      // Привязываем phone к target user.
      try {
        db.update(users).set({ phone: phoneToTransfer, phoneVerified: 1 }).where(eq(users.id, targetUser.id)).run();
      } catch {}

      // Помечаем phone-only user удалённым (НЕ DELETE — soft).
      try {
        db.update(users).set({
          deletedAt: new Date().toISOString(),
          phone: null,
          email: `merged-${currentUser.id}@deleted.local`,
        } as any).where(eq(users.id, currentUser.id)).run();
      } catch {}

      // Новый token на target user.
      const oldToken = getTokenFromRequest(req);
      if (oldToken) tokenStore.delete(oldToken);
      const newToken = uuidv4();
      tokenStore.set(newToken, targetUser.id);

      res.json({
        ok: true,
        message: "Аккаунты объединены",
        token: newToken,
        userId: targetUser.id,
      });
    } catch (e: any) {
      console.error("[link-existing]", e);
      res.status(500).json({ message: "Ошибка объединения. Свяжитесь с поддержкой." });
    }
  });

  // ==================== TELEGRAM AUTH ====================
  // Eugene 2026-05-09: токен вынесен в env (раньше был захардкожен и попал
  // в публичный репо). Если процесс стартует без TELEGRAM_BOT_TOKEN — log
  // warning, Telegram-логин работать не будет до прописывания в .env.
  const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || "";
  if (!TELEGRAM_BOT_TOKEN) {
    console.warn("[telegram-auth] TELEGRAM_BOT_TOKEN не установлен — login через Telegram отключён");
  }

  function verifyTelegramAuth(data: Record<string, string>): boolean {
    const crypto = require("crypto");
    const checkHash = data.hash;
    if (!checkHash) return false;
    const dataCheckString = Object.keys(data)
      .filter(k => k !== "hash")
      .sort()
      .map(k => `${k}=${data[k]}`)
      .join("\n");
    const secretKey = crypto.createHash("sha256").update(TELEGRAM_BOT_TOKEN).digest();
    const hmac = crypto.createHmac("sha256", secretKey).update(dataCheckString).digest("hex");
    return hmac === checkHash;
  }

  app.post("/api/auth/telegram", async (req: Request, res: Response) => {
    try {
      const tgData = req.body;
      if (!tgData || !tgData.id) {
        res.status(400).json({ message: "Неверные данные Telegram" });
        return;
      }

      // Verify hash
      if (!verifyTelegramAuth(tgData)) {
        res.status(403).json({ message: "Неверная подпись Telegram" });
        return;
      }

      // Check auth_date freshness (max 1 day)
      const authDate = parseInt(tgData.auth_date);
      if (Math.abs(Date.now() / 1000 - authDate) > 86400) {
        res.status(403).json({ message: "Сессия Telegram устарела" });
        return;
      }

      const tgId = String(tgData.id);
      const tgName = [tgData.first_name, tgData.last_name].filter(Boolean).join(" ") || "Telegram User";

      // Find existing user by telegram_id
      let user = db.select().from(users).where(eq(users.telegramId, tgId)).get();

      if (!user) {
        // If email provided (linking flow), find by email
        if (tgData.link_email && tgData.link_password) {
          const bcrypt = require("bcryptjs");
          const existingUser = db.select().from(users).where(eq(users.email, tgData.link_email.trim().toLowerCase())).get();
          if (!existingUser) {
            res.status(404).json({ message: "Пользователь не найден", needLink: true });
            return;
          }
          if (!bcrypt.compareSync(tgData.link_password, existingUser.password)) {
            res.status(401).json({ message: "Неверный пароль", needLink: true });
            return;
          }
          db.update(users).set({ telegramId: tgId }).where(eq(users.id, existingUser.id)).run();
          user = existingUser;
          console.log(`[TG AUTH] Linked tg:${tgId} to user #${user.id} (${user.email})`);
        } else if (tgData.force_create) {
          // Explicitly create new account
          const crypto = require("crypto");
          const tgEmail = `tg_${tgId}@telegram.MuzaAi.ru`;
          const referralCode = crypto.randomBytes(4).toString("hex");
          user = db.insert(users).values({
            name: tgName,
            email: tgEmail,
            password: crypto.randomBytes(32).toString("hex"),
            balance: 100000,
            emailVerified: 1,
            telegramId: tgId,
            referralCode,
          }).returning().get();
          storage.createTransaction({ userId: user.id, type: "bonus", amount: 100000, description: "Приветственный бонус 1000 ₽" });
          console.log(`[TG AUTH] Force-created user #${user.id}: ${tgName} (tg:${tgId})`);
        } else {
          // No link data — show linking form
          res.json({ needLink: true, tgId, tgName });
          return;
        }
      }

      // Create session
      const crypto = require("crypto");
      const token = crypto.randomBytes(32).toString("hex");
      tokenStore.set(token, user.id);

      const { password: _, nameChangeToken: __nct, ...publicUser } = user;
      res.json({ token, user: publicUser });
    } catch (e: any) {
      console.error("[TG AUTH] Error:", e);
      res.status(500).json({ message: "Ошибка авторизации" });
    }
  });

  // Deep-link auth (Eugene 2026-05-11): Telegram депрекейтнул OAuth-виджет
  // (oauth.telegram.org → «deprecated»). Альтернатива:
  // 1. Сайт зовёт /start → получает nonce + ссылку на бота
  // 2. Юзер открывает t.me/Muziaipodari_bot?start=login_<nonce>
  // 3. Бот в webhook-handler'е вызывает confirmNonce(nonce, tgUser)
  // 4. Сайт через /poll забирает session token

  app.post("/api/auth/telegram/start", (req: Request, res: Response) => {
    try {
      const nonce = tgCreateNonce();
      const botUsername = process.env.TELEGRAM_BOT_USERNAME || "Muziaipodari_bot";
      const deepLink = `https://t.me/${botUsername}?start=login_${nonce}`;
      logEngagement(req, "tg_login_start", { channel: "telegram", meta: { nonce: nonce.slice(0, 8) } });
      res.json({ nonce, deepLink, expiresInSec: 15 * 60 });
    } catch (e: any) {
      console.error("[TG START] Error:", e);
      res.status(500).json({ message: "Не удалось создать сессию" });
    }
  });

  app.get("/api/auth/telegram/poll", async (req: Request, res: Response) => {
    try {
      const nonce = String(req.query.nonce || "");
      if (!nonce) {
        res.status(400).json({ status: "error", message: "nonce required" });
        return;
      }
      const entry = tgPollNonce(nonce);
      if (!entry) {
        res.json({ status: "expired" });
        return;
      }
      if (entry.status !== "confirmed" || !entry.tgUserId) {
        res.json({ status: entry.status });
        return;
      }

      // Confirmed: есть либо userId (из login_url HMAC-handler), либо
      // tgUserId (из бот-deeplink-fallback). Если userId — берём напрямую.
      // Если только tgUserId — ищем/создаём юзера.
      let user: any = null;
      if (entry.userId) {
        user = db.select().from(users).where(eq(users.id, entry.userId)).get();
      } else if (entry.tgUserId) {
        const tgId = String(entry.tgUserId);
        const tgName = [entry.tgFirstName, entry.tgLastName].filter(Boolean).join(" ") || entry.tgUsername || "Telegram User";
        user = db.select().from(users).where(eq(users.telegramId, tgId)).get();
        if (!user) {
          // Новый юзер. Eugene 2026-05-11: «убрать 1000 ₽, 1 трек в
          // подарок зачислится после открытия генерации».
          const tgEmail = `tg_${tgId}@telegram.muziai.ru`;
          const referralCode = crypto.randomBytes(4).toString("hex");
          user = db.insert(users).values({
            name: tgName,
            email: tgEmail,
            password: crypto.randomBytes(32).toString("hex"),
            balance: 0,
            emailVerified: 1,
            telegramId: tgId,
            referralCode,
          }).returning().get();
          console.log(`[TG DEEP-LINK] Created user #${user.id}: ${tgName} (tg:${tgId})`);
        }
      }

      if (!user) {
        res.json({ status: "pending" });
        return;
      }

      const token = crypto.randomBytes(32).toString("hex");
      tokenStore.set(token, user.id);
      tgConsumeNonce(nonce);

      const { password: _, nameChangeToken: __nct, ...publicUser } = user;
      res.json({ status: "confirmed", token, user: publicUser });
    } catch (e: any) {
      console.error("[TG POLL] Error:", e);
      res.status(500).json({ status: "error", message: "Ошибка polling" });
    }
  });

  // login_url handler (Eugene 2026-05-11): Telegram редиректит сюда после
  // тапа inline-кнопки `login_url` из бота. Query params подписаны
  // bot-токеном через HMAC — это и есть «настоящая» Telegram OAuth.
  // Доки: https://core.telegram.org/bots/api#loginurl + checking-authorization.
  // Кнопка login_url работает только если домен прописан /setdomain.
  app.get("/api/auth/telegram-loginurl", async (req: Request, res: Response) => {
    try {
      const tgData: Record<string, string> = {};
      for (const [k, v] of Object.entries(req.query)) {
        if (typeof v === "string") tgData[k] = v;
      }
      const nonce = String(tgData.nonce || "");
      // nonce — наш собственный параметр, не из Telegram, поэтому
      // исключаем из data_check_string перед HMAC.
      const tgOnly: Record<string, string> = {};
      for (const k of Object.keys(tgData)) {
        if (k !== "nonce") tgOnly[k] = tgData[k];
      }
      if (!tgOnly.id || !tgOnly.hash) {
        res.status(400).send("Telegram не передал данные авторизации");
        return;
      }
      if (!verifyTelegramAuth(tgOnly)) {
        console.error("[TG LOGIN-URL] HMAC mismatch", { id: tgOnly.id });
        res.status(403).send("Неверная подпись Telegram. Откройте страницу входа заново.");
        return;
      }
      const authDate = parseInt(tgOnly.auth_date || "0");
      if (Math.abs(Date.now() / 1000 - authDate) > 86400) {
        res.status(403).send("Сессия Telegram устарела");
        return;
      }

      const tgId = String(tgOnly.id);
      const tgName = [tgOnly.first_name, tgOnly.last_name].filter(Boolean).join(" ") || tgOnly.username || "Telegram User";

      let user: any = db.select().from(users).where(eq(users.telegramId, tgId)).get();
      if (!user) {
        const tgEmail = `tg_${tgId}@telegram.muziai.ru`;
        const referralCode = crypto.randomBytes(4).toString("hex");
        user = db.insert(users).values({
          name: tgName,
          email: tgEmail,
          password: crypto.randomBytes(32).toString("hex"),
          balance: 0,
          emailVerified: 1,
          telegramId: tgId,
          referralCode,
        }).returning().get();
        console.log(`[TG LOGIN-URL] Created user #${user.id}: ${tgName} (tg:${tgId})`);
      } else {
        console.log(`[TG LOGIN-URL] Login user #${user.id}: ${user.name}`);
      }

      const token = crypto.randomBytes(32).toString("hex");
      tokenStore.set(token, user.id);
      logEngagement(req, "tg_login_confirmed", { channel: "telegram", userId: user.id });

      // Передаём userId в nonce — чтобы исходная вкладка через polling
      // тоже залогинилась (если она ещё открыта).
      if (nonce) tgAttachUserToNonce(nonce, user.id);

      res.setHeader("Content-Type", "text/html; charset=utf-8");
      res.send(`<!DOCTYPE html><html><head><meta charset="utf-8"><title>Вход…</title><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="background:#09090b;color:#fff;font-family:-apple-system,sans-serif;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0;flex-direction:column;gap:14px">
<div style="width:48px;height:48px;border-radius:12px;background:linear-gradient(135deg,#8b5cf6,#3b82f6);display:flex;align-items:center;justify-content:center;font-size:24px">✓</div>
<p style="margin:0;font-size:16px">Вход выполнен</p>
<p style="margin:0;color:#888;font-size:13px">Перенаправление в личный кабинет…</p>
<script>localStorage.setItem('token','${token}');setTimeout(function(){window.location.href='/#/dashboard'},300);</script>
</body></html>`);
    } catch (e: any) {
      console.error("[TG LOGIN-URL] Error:", e);
      res.status(500).send("Ошибка авторизации");
    }
  });

  // Engagement tracking (Eugene 2026-05-11): фронт шлёт сюда события
  // помощника (impression / open / action). Public-endpoint, лёгкий
  // rate-limit чтобы не флудили.
  app.post("/api/engagement/track", (req: Request, res: Response) => {
    const ip = req.ip || req.socket.remoteAddress || "unknown";
    if (!rateLimit(ip + ":engage", 60, 60_000)) {
      res.status(429).json({ ok: false }); return;
    }
    try {
      const evt = String(req.body?.event || "");
      const allowed: Record<string, true> = {
        consultant_impression: true,
        consultant_open: true,
        consultant_action: true,
        music_generate_attempt: true, // лендинг-CTA «попробовать» — отдельно от endpoint /api/music/generate
      };
      if (!allowed[evt]) { res.status(400).json({ ok: false, error: "unknown event" }); return; }
      const userId = Number(req.body?.userId) || null;
      const sessionId = String(req.body?.sessionId || "").slice(0, 64) || null;
      const meta = req.body?.meta && typeof req.body.meta === "object" ? req.body.meta : undefined;
      logEngagement(req, evt as any, { channel: "site", userId, sessionId, meta });
      res.json({ ok: true });
    } catch {
      res.json({ ok: true }); // не блокируем фронт
    }
  });

  // ==================== USER JOURNEY (Eugene 2026-05-17 Босс) ====================
  // POST /api/journey/batch — батч событий клиентского трекера (page_view,
  // click, scroll_percent, idle_30s, form_focus, form_abandon, leave).
  // Public endpoint (auth не требуется — гости трекаются для конверсий).
  //
  // Rate-limit: 1 batch / 5 сек per sessionKey (защита от flooding).
  // Validation: max 50 events / batch, type whitelisted, page max 200 chars,
  // meta serialized JSON max 2KB. Sensitive pages (/admin/*) НЕ пишем.
  //
  // userId извлекается из Bearer token если присутствует (anon → null).
  const JOURNEY_EVENT_TYPES = new Set([
    "page_view", "page_exit", "click", "scroll_percent",
    "idle_30s", "form_focus", "form_abandon", "leave",
  ]);
  // Per-sessionKey throttle: следим за последним временем batch'а.
  const journeyBatchAt = new Map<string, number>();
  setInterval(() => {
    const cutoff = Date.now() - 60_000;
    for (const [k, t] of journeyBatchAt) if (t < cutoff) journeyBatchAt.delete(k);
  }, 300_000);

  app.post("/api/journey/batch", (req: Request, res: Response) => {
    try {
      const body = req.body || {};
      const sessionKey = String(body.sessionKey || "").trim().slice(0, 64);
      const events = Array.isArray(body.events) ? body.events : [];
      if (!sessionKey || sessionKey.length < 8) {
        res.status(400).json({ ok: false, error: "sessionKey required" });
        return;
      }
      if (events.length === 0) {
        res.json({ ok: true, inserted: 0 });
        return;
      }
      if (events.length > 50) {
        res.status(400).json({ ok: false, error: "max 50 events / batch" });
        return;
      }
      // Throttle per sessionKey: 1 batch / 5 сек.
      const now = Date.now();
      const lastAt = journeyBatchAt.get(sessionKey) || 0;
      if (now - lastAt < 5_000) {
        res.status(429).json({ ok: false, error: "rate-limit: 1 batch / 5s" });
        return;
      }
      journeyBatchAt.set(sessionKey, now);

      // Eugene 2026-05-18 Босс «автофильтр ботов»: если UA — bot, не пишем
      // journey events. У ботов в принципе нет JS, но curl-scraper'ы могут
      // долбиться. Это снижает шум в click-stats / journey-summary без
      // нужды JOIN'ить с visitors на чтении.
      const ua = String(req.headers["user-agent"] || "");
      if (isBotUserAgent(ua)) {
        res.json({ ok: true, inserted: 0, skipped: "bot-ua" });
        return;
      }

      // userId из Bearer (опционально).
      let userId: number | null = null;
      try {
        const token = getTokenFromRequest(req);
        if (token && tokenStore.has(token)) userId = tokenStore.get(token) || null;
      } catch {}

      // Per-domain трекинг (Eugene 2026-05-17 Босс): один host на весь batch
      // (юзер не может прыгать между muzaai.ru/muziai.ru/podaripesnu.ru в
      // одном batch'е — это разные nginx upstreams).
      const host = extractHost(req);

      // Normalize + filter.
      const rows: { sessionKey: string; userId: number | null; eventType: string; page: string; meta: string | null; host: string | null; createdAt: string; }[] = [];
      for (const ev of events) {
        if (!ev || typeof ev !== "object") continue;
        const type = String(ev.type || "").trim();
        if (!JOURNEY_EVENT_TYPES.has(type)) continue;
        let page = String(ev.page || "/").trim().slice(0, 200);
        // Не пишем sensitive pages (admin-зона). Privacy + шум фильтрация.
        if (page.startsWith("/admin")) continue;
        let metaStr: string | null = null;
        if (ev.meta && typeof ev.meta === "object") {
          try {
            const s = JSON.stringify(ev.meta);
            metaStr = s.length > 2000 ? s.slice(0, 2000) : s;
          } catch {}
        }
        // ts — client-side ts из event'а (для упорядочения timeline точнее
        // чем server insert order). Fallback на now.
        let createdAt: string;
        try {
          const ts = Number(ev.ts);
          createdAt = Number.isFinite(ts) && ts > 0
            ? new Date(ts).toISOString()
            : new Date().toISOString();
        } catch {
          createdAt = new Date().toISOString();
        }
        rows.push({ sessionKey, userId, eventType: type, page, meta: metaStr, host, createdAt });
      }
      if (rows.length === 0) {
        res.json({ ok: true, inserted: 0 });
        return;
      }
      // Batch insert через drizzle.
      db.insert(userJourneyEvents).values(rows).run();
      res.json({ ok: true, inserted: rows.length });
    } catch (e) {
      // Логируем, но не ломаем фронт.
      console.error("[JOURNEY-BATCH] error:", e);
      res.json({ ok: true, inserted: 0 });
    }
  });

  // ==================== MUZA WEB CHAT (Eugene 2026-05-14 Босс) ====================
  // Inline-чат Музы прямо на сайте. Поддерживает cross-channel pairing —
  // юзер набирает 6-знак код из Telegram/Max, history подтягивается.
  //
  // Endpoints:
  //   POST /api/muza/chat/init — приветствие + (опц.) history, при pair-code линкуется.
  //   POST /api/muza/chat — отправка сообщения юзера, возвращает ответ Музы.
  //
  // Сессия web хранится в chatbot_sessions с channel='web'. Если pairCode
  // распознан — НЕ создаём новую web-сессию, а используем сессию мессенджера
  // (юзер «продолжает разговор там же»).

  function parseJSON<T = any>(s: string | null | undefined): T | null {
    if (!s) return null;
    try { return JSON.parse(s) as T; } catch { return null; }
  }

  // Eugene 2026-05-14 Босс «2-3 варианта ответов, кнопки, при клике продолжай».
  // Парсер для bot reply: вытаскивает [QR:текст] маркеры → массив quickReplies,
  // оставляет в text только основной ответ (без маркеров).
  function extractQuickReplies(text: string): { reply: string; quickReplies: string[] } {
    const QR_RE = /\[QR:([^\]\n]{1,80})\]/gi;
    const matches: string[] = [];
    let m: RegExpExecArray | null;
    while ((m = QR_RE.exec(text)) !== null) {
      const v = m[1].trim();
      if (v && !matches.includes(v)) matches.push(v);
    }
    const cleaned = text.replace(QR_RE, "").replace(/\n{3,}/g, "\n\n").trim();
    return { reply: cleaned, quickReplies: matches.slice(0, 4) };
  }

  // Eugene 2026-05-18 Босс «чат → окно генерации с 3 кнопками».
  // Парсим [PROPOSE_GEN:mode=X|style=Y|voice=Z|lyrics=W|reason=R] маркер
  // который Муза вставляет в конец реплики когда видит «готов(а) делать».
  // Фронт по этому payload рендерит карточку с выбором режима + pre-fill.
  type ProposedGeneration = {
    mode: "audio" | "simple" | "full";
    style?: string;
    voice?: "female" | "male" | "duet" | "instrumental";
    lyrics?: string;
    reason: string;
  };
  function extractProposedGeneration(text: string): { reply: string; proposed: ProposedGeneration | null } {
    const RE = /\[PROPOSE_GEN:([^\]\n]{3,500})\]/i;
    const m = RE.exec(text);
    if (!m) return { reply: text, proposed: null };
    const cleaned = text.replace(RE, "").replace(/\n{3,}/g, "\n\n").trim();
    const payload = m[1];
    // Разбираем k=v|k=v
    const parts = payload.split("|").map(s => s.trim()).filter(Boolean);
    const kv: Record<string, string> = {};
    for (const p of parts) {
      const eq = p.indexOf("=");
      if (eq <= 0) continue;
      const k = p.slice(0, eq).trim().toLowerCase();
      const v = p.slice(eq + 1).trim();
      if (k && v) kv[k] = v.slice(0, 300);
    }
    const modeRaw = String(kv.mode || "").toLowerCase();
    const mode: ProposedGeneration["mode"] | null =
      modeRaw === "audio" || modeRaw === "simple" || modeRaw === "full" ? modeRaw as any : null;
    if (!mode) return { reply: cleaned, proposed: null };
    const voiceRaw = String(kv.voice || "").toLowerCase();
    const voice: ProposedGeneration["voice"] | undefined =
      voiceRaw === "female" || voiceRaw === "male" || voiceRaw === "duet" || voiceRaw === "instrumental"
        ? (voiceRaw as any)
        : undefined;
    const STYLES = ["pop","rock","lullaby","chanson","hiphop","electronic","folk","acoustic-guitar","orchestral","lounge"];
    const styleRaw = String(kv.style || "").toLowerCase();
    const style = STYLES.includes(styleRaw) ? styleRaw : undefined;
    const lyrics = kv.lyrics ? kv.lyrics.slice(0, 200) : undefined;
    const reason = (kv.reason || "user_signaled_ready").slice(0, 120);
    return { reply: cleaned, proposed: { mode, style, voice, lyrics, reason } };
  }

  // Eugene 2026-05-18 Босс «Муза сохраняет тексты — если не залогинен, предлагает
  // регистрацию». Парсим [PROPOSE_REGISTER:reason=X] маркер который propose_registration
  // tool вставляет в реплику. Фронт по этому payload рендерит inline-карточку
  // «Войти / Зарегистрироваться / Дать email».
  type ProposedRegistration = {
    reason: "save_lyrics" | "save_draft" | "view_my_tracks" | "history";
    // Eugene 2026-05-18 Босс «Муза сохраняет тексты — UI часть».
    // Если save_user_lyrics ранее в этой сессии вернул needsAuth — title/text
    // оседают в pendingLyricsBySession (muzaTools.ts) и попадают сюда,
    // чтобы inline-карточка «Войти / Регистрация / Email» могла отправить
    // их в /api/lyrics/anonymous-save без повторного ввода юзером.
    lyricsTitle?: string;
    lyricsText?: string;
    // Подсказка для UI (опционально) — что показать перед кнопками.
    message?: string;
  };
  function extractProposedRegistration(text: string): { reply: string; proposed: ProposedRegistration | null } {
    const RE = /\[PROPOSE_REGISTER:([^\]\n]{3,200})\]/i;
    const m = RE.exec(text);
    if (!m) return { reply: text, proposed: null };
    const cleaned = text.replace(RE, "").replace(/\n{3,}/g, "\n\n").trim();
    const payload = m[1];
    const parts = payload.split("|").map(s => s.trim()).filter(Boolean);
    const kv: Record<string, string> = {};
    for (const p of parts) {
      const eq = p.indexOf("=");
      if (eq <= 0) continue;
      const k = p.slice(0, eq).trim().toLowerCase();
      const v = p.slice(eq + 1).trim();
      if (k && v) kv[k] = v.slice(0, 100);
    }
    const reasonRaw = String(kv.reason || "save_lyrics").toLowerCase();
    const validReasons = ["save_lyrics", "save_draft", "view_my_tracks", "history"];
    const reason = (validReasons.includes(reasonRaw) ? reasonRaw : "save_lyrics") as ProposedRegistration["reason"];
    return { reply: cleaned, proposed: { reason } };
  }

  // Eugene 2026-05-17 Босс «5-летняя девочка fix»: распознаём «юзер просит
  // свои данные» по тексту чтобы fallback не задавал sales-вопросы про повод.
  // Возвращает intent + label для «не дозвонилась» сообщения + retry QR-кнопку.
  // null = текст не похож на запрос данных (тогда обычный sales-fallback).
  function detectUserDataIntent(rawText: string): { code: string; label: string; retryLabel: string } | null {
    const t = String(rawText || "").toLowerCase().trim();
    if (!t) return null;
    // Треки
    if (/(пока(жи|жите)|пока(жи|жите) мои|мои трек|мои песни|что я создавал|моя истори|список тре|show my tracks?)/i.test(t)) {
      return { code: "tracks", label: "ваши треки", retryLabel: "Покажи мои треки" };
    }
    // Платежи
    if (/(истори(я|и) платеж|мои покупк|что я (оплат|оплачив)|мои оплат|мои транзакц|показать платеж)/i.test(t)) {
      return { code: "payments", label: "историю платежей", retryLabel: "История платежей" };
    }
    // Баланс
    if (/(мой баланс|сколько у меня (денег|треков|осталось)|есть ли бесплатн|подароч(н\w+|) трек)/i.test(t)) {
      return { code: "balance", label: "ваш баланс", retryLabel: "Мой баланс" };
    }
    // Профиль
    if (/(мой профиль|мои данные|кто я в системе|show my profile|что у меня в кабинет)/i.test(t)) {
      return { code: "profile", label: "ваш профиль", retryLabel: "Мой профиль" };
    }
    // Тариф
    if (/(мой тариф|какой у меня тариф|сколько подарочн)/i.test(t)) {
      return { code: "tariff", label: "ваш тариф", retryLabel: "Мой тариф" };
    }
    // Зависшие треки
    if (/(где мой трек|когда будет готов|трек висит|трек завис|у меня всё завис|все треки висят)/i.test(t)) {
      return { code: "stuck", label: "статус вашей генерации", retryLabel: "Где мой трек" };
    }
    // Черновики
    if (/(мой черновик|что я начинал|продолжим черновик|есть ли черновик)/i.test(t)) {
      return { code: "draft", label: "ваш черновик", retryLabel: "Покажи черновик" };
    }
    return null;
  }

  // Eugene 2026-05-17 Босс «admin-notifications rule»: если LLM возвращает
  // empty 3+ раз в течение 10 минут — шлём Telegram-alert админу. Rate-limit
  // 1 alert/час по alertKey (см. Admin-notifications rule в CLAUDE.md).
  const emptyLLMTimestamps = new Map<string, number[]>(); // channel → [ts...]
  const lastAdminLLMAlertAt = new Map<string, number>();   // alertKey → ts
  function notifyAdminOnRepeatedEmptyLLM(channel: string): void {
    try {
      const now = Date.now();
      const windowMs = 10 * 60 * 1000;
      const tsList = (emptyLLMTimestamps.get(channel) || []).filter((t) => now - t < windowMs);
      tsList.push(now);
      emptyLLMTimestamps.set(channel, tsList);
      if (tsList.length < 3) return;
      const alertKey = `empty-llm-${channel}`;
      const lastAt = lastAdminLLMAlertAt.get(alertKey) || 0;
      if (now - lastAt < 60 * 60 * 1000) return; // 1 alert/час
      lastAdminLLMAlertAt.set(alertKey, now);
      const tgToken = process.env.TELEGRAM_BOT_TOKEN;
      const adminId = process.env.ADMIN_TELEGRAM_ID;
      if (!tgToken || !adminId) return;
      const text = `🚨 LLM-fallback (${channel}): ${tsList.length} empty replies за 10 мин. Юзеры видят hardcoded fallback вместо настоящего ответа. Проверь ключи в /admin/v304/🔑 API ключи.`;
      fetch(`https://api.telegram.org/bot${tgToken}/sendMessage`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          chat_id: adminId,
          text,
          disable_web_page_preview: true,
        }),
        signal: AbortSignal.timeout(8_000),
      }).catch((e: any) => console.warn("[ADMIN-ALERT empty-llm]", e?.message || e));
    } catch (e: any) {
      console.warn("[notifyAdminOnRepeatedEmptyLLM]", e?.message || e);
    }
  }

  // Eugene 2026-05-16 Босс «один мозг для всех каналов»: цепочка ключей,
  // token-stats, key-switch alerts, tool-use loop — теперь живут в
  // lib/llmCore.ts (единая точка для web/telegram/max). Здесь — только
  // тонкие алиасы для существующих admin endpoint'ов.
  const listAnthropicKeys = listAnthropicKeysCore;
  const llmKeyStatus = { get: getLLMKeyStatus };
  // Live-getter — каждое обращение даёт свежий snapshot из llmCore.
  const muzaTokenStats = {
    get inputTokens() { return getMuzaTokenStats().inputTokens; },
    get outputTokens() { return getMuzaTokenStats().outputTokens; },
    get callsCount() { return getMuzaTokenStats().callsCount; },
    get sinceStartedAt() { return getMuzaTokenStats().sinceStartedAt; },
  };
  const TOKEN_PRICE = getTokenPrice();

  // GET /api/admin/v304/ai-keys/switches — последние key-switch events.
  // Для отчёта о смене ключей (Eugene 2026-05-14 Босс).
  app.get("/api/admin/v304/ai-keys/switches", requireAdmin, (_req: Request, res: Response) => {
    res.json({ ok: true, events: getKeySwitchEvents() });
  });

  // GET /api/admin/v304/chat-test — Eugene 2026-05-14 Босс «реши кардинально».
  // Real-call test endpoint: вызывает Claude напрямую без всей обвязки чата.
  // Возвращает: какой ключ сработал, raw status, время ответа, текст.
  // Админ открывает в браузере и видит ТОЧНО что не так.
  app.get("/api/admin/v304/chat-test", requireAdmin, async (_req: Request, res: Response) => {
    const attempts = listAnthropicKeys();
    if (attempts.length === 0) {
      res.json({ ok: false, error: "Нет ни одного Anthropic-ключа в env", suggestion: "Добавь ANTHROPIC_API_KEY на VPS." });
      return;
    }
    const results: any[] = [];
    for (const { name, key } of attempts) {
      const start = Date.now();
      try {
        const r = await fetch("https://api.anthropic.com/v1/messages", {
          method: "POST",
          headers: {
            "x-api-key": key,
            "anthropic-version": "2023-06-01",
            "content-type": "application/json",
          },
          body: JSON.stringify({
            model: "claude-haiku-4-5-20251001",
            max_tokens: 50,
            messages: [{ role: "user", content: "Скажи привет коротко, одной фразой." }],
          }),
          signal: AbortSignal.timeout(10_000),
        });
        const tookMs = Date.now() - start;
        const status = r.status;
        let body: any = null;
        let errText = "";
        try { body = await r.json(); } catch { try { errText = await r.text(); } catch {} }
        results.push({
          keyName: name,
          ok: r.ok,
          status,
          tookMs,
          reply: r.ok ? (body?.content?.[0]?.text || "(пустой ответ)") : null,
          error: !r.ok ? (body?.error?.message || errText || `HTTP ${status}`) : null,
        });
        if (r.ok) break; // нашли рабочий — стоп
      } catch (e: any) {
        results.push({
          keyName: name,
          ok: false,
          status: e?.name === "AbortError" ? "timeout" : "error",
          tookMs: Date.now() - start,
          error: String(e?.message || e),
        });
      }
    }
    const working = results.find(r => r.ok);
    res.json({
      ok: !!working,
      workingKey: working?.keyName || null,
      mode: working ? "live-claude" : "all-keys-failed",
      diagnosis: working
        ? `Ключ "${working.keyName}" работает (${working.tookMs}ms). Чат должен отвечать.`
        : "Ни один ключ не отдал ok. Проверь кэш Anthropic console + ротируй ключ.",
      attempts: results,
    });
  });

  // Создать или найти web-сессию для clientSessionId.
  // Eugene 2026-05-17 Босс: host — per-domain трекинг (muzaai.ru / muziai.ru /
  // podaripesnu.ru). Записываем при создании сессии. Для telegram/max-bot
  // сессий host=NULL (там нет HTTP host).
  function getOrCreateWebSession(clientSessionId: string, host?: string | null) {
    // clientSessionId — uuid от клиента, хранится в его sessionStorage.
    // Используем его как session.id (channel='web', externalId=clientSessionId).
    const id = `web:${clientSessionId.slice(0, 60)}`;
    const existing = db.select().from(chatbotSessions).where(eq(chatbotSessions.id, id)).get();
    if (existing) return existing;
    const persona = personaFor(id);
    db.insert(chatbotSessions).values({
      id,
      channel: "web",
      externalId: clientSessionId,
      state: "active",
      personaName: persona.name,
      host: host || null,
    }).run();
    return db.select().from(chatbotSessions).where(eq(chatbotSessions.id, id)).get();
  }

  // Подгрузка последних messages для контекста + UI history.
  function loadSessionHistory(sessionId: string, limit = 30): Array<{ role: string; text: string; createdAt: string | null }> {
    try {
      const rows = db.select().from(chatbotMessages)
        .where(eq(chatbotMessages.sessionId, sessionId))
        .orderBy(desc(chatbotMessages.id))
        .limit(limit)
        .all();
      return rows.reverse().map(r => ({ role: r.role, text: r.text, createdAt: r.createdAt }));
    } catch {
      return [];
    }
  }

  // Eugene 2026-05-20 Босс «мини-плеер в чате». Расширенная история для UI —
  // подтягивает attachedTrack meta для сообщений у которых attached_track_id
  // != NULL. JOIN-style query через raw SQL (Drizzle select от двух таблиц
  // сложнее, чем оправдано). Used in /api/muza/chat/init + /api/user/musa-history.
  type HistoryItemWithAttachment = {
    role: string;
    text: string;
    createdAt: string | null;
    attachedTrack?: {
      id: number;
      title: string;
      authorName: string | null;
      audioUrl: string;
      coverUrl: string;
      durationSec: number;
    };
  };
  function loadSessionHistoryRich(sessionId: string, limit = 30): HistoryItemWithAttachment[] {
    try {
      const raw = (db as any).$client.prepare(`
        SELECT cm.role, cm.text, cm.created_at AS createdAt, cm.attached_track_id AS attachedTrackId,
               g.display_title AS gTitle, g.prompt AS gPrompt, g.author_name AS gAuthor,
               g.status AS gStatus, g.is_public AS gIsPublic, g.deleted_at AS gDeletedAt,
               g.result_url AS gResultUrl, g.result_data AS gResultData, g.type AS gType
        FROM (
          SELECT * FROM chatbot_messages WHERE session_id = ? ORDER BY id DESC LIMIT ?
        ) cm
        LEFT JOIN generations g ON g.id = cm.attached_track_id
        ORDER BY cm.id ASC
      `).all(sessionId, limit) as any[];
      return raw.map((r) => {
        const item: HistoryItemWithAttachment = {
          role: String(r.role || "user"),
          text: String(r.text || ""),
          createdAt: r.createdAt || null,
        };
        if (
          r.attachedTrackId &&
          r.gType === "music" &&
          r.gStatus === "done" &&
          (r.gIsPublic === 1 || r.gIsPublic === 2) &&
          !r.gDeletedAt &&
          r.gResultUrl
        ) {
          let duration = 0;
          try {
            const data = JSON.parse(r.gResultData || "{}");
            if (Array.isArray(data.result) && data.result[0]?.duration) {
              duration = Number(data.result[0].duration) || 0;
            }
          } catch {}
          item.attachedTrack = {
            id: Number(r.attachedTrackId),
            title: r.gTitle || String(r.gPrompt || "").slice(0, 80) || "Без названия",
            authorName: r.gAuthor || null,
            audioUrl: `/api/stream/${r.attachedTrackId}`,
            coverUrl: `/api/cover/${r.attachedTrackId}.jpg`,
            durationSec: duration,
          };
        }
        return item;
      });
    } catch {
      return [];
    }
  }

  // Soft-auth: если в request есть Bearer token — возвращаем userId, иначе null.
  // НЕ блокирует доступ (в отличие от authMiddleware).
  function tryGetUserId(req: Request): number | null {
    try {
      const token = getTokenFromRequest(req);
      if (!token || !tokenStore.has(token)) return null;
      return tokenStore.get(token) ?? null;
    } catch {
      return null;
    }
  }

  // Eugene 2026-05-14 Босс «реши кардинально — бот действует по тупому,
  // повторные вопросы». Memory extraction: парсит history → выясняет факты
  // которые юзер УЖЕ сообщил → передаёт в system prompt как hard-known.
  // Бот видит «знаю имя, повод, ДР» — не переспрашивает.
  type SessionMemo = {
    name?: string;
    email?: string;
    birthday?: string;
    occasion?: string;
    recipient?: string;
    city?: string;
    country?: string;
    age?: string;
    mood?: string;
    style?: string;
    voiceType?: string;
    interests?: string[];
  };
  function extractMemoryFromHistory(history: Array<{ role: string; text: string }>): SessionMemo {
    const memo: SessionMemo = {};
    // Eugene 2026-05-14 Босс «повторное нажатие учитывает изменение в дальнейшем».
    // ОБРАТНЫЙ порядок (newest first) — break на первом match даёт ПОСЛЕДНЕЕ
    // значение. Юзер сказал «маме», потом «папе» — берём «папе».
    const userMsgsAll = history.filter(m => m.role === "user").map(m => m.text);
    const userMsgsLower = userMsgsAll.map(t => t.toLowerCase());
    // Newest-first для resolveCount=PER FACT - переопределение более свежим значением.
    const allText = [...userMsgsLower].reverse().join("\n");

    // Email
    const em = allText.match(/[a-z0-9_.+-]+@[a-z0-9-]+\.[a-z0-9-.]+/i);
    if (em) memo.email = em[0];

    // Имя — «меня зовут X», «я X», «зовите X», «звать X»
    const namePatterns = [
      /(?:меня зовут|зовите меня|зови меня|звать меня)\s+([а-яёa-z]{2,20})/i,
      /(?:^|[.!?\s])(?:я|это)\s+([а-яё]{3,15})(?:[\s.,!?]|$)/i,
    ];
    for (const re of namePatterns) {
      const m = allText.match(re);
      if (m && m[1] && !["хочу","думаю","буду","хотел","хотела","рад","рада","знаю","понял","поняла"].includes(m[1].toLowerCase())) {
        memo.name = m[1].charAt(0).toUpperCase() + m[1].slice(1);
        break;
      }
    }

    // ДР — «15 марта», «10 июля», «март 1990»
    const dobMonths: Record<string, string> = {
      "январ": "01", "феврал": "02", "март": "03", "апрел": "04", "ма": "05", "июн": "06",
      "июл": "07", "август": "08", "сентябр": "09", "октябр": "10", "ноябр": "11", "декабр": "12",
    };
    const dobMatch = allText.match(/(\d{1,2})\s+([а-я]+)(?:\s+(\d{4}))?/i);
    if (dobMatch) {
      const day = dobMatch[1];
      const monthKey = Object.keys(dobMonths).find(k => dobMatch[2].toLowerCase().startsWith(k));
      if (monthKey) memo.birthday = `${day} ${dobMatch[2]}${dobMatch[3] ? ", " + dobMatch[3] : ""}`;
    }

    // Повод (Eugene 2026-05-14 Босс «бот логику не выдерживает — пишу про
    // любовь, а он ДР»). Расширены occasions: любовь / романтика /
    // признание / признание в любви / посвящение / память / детский / профи.
    const occasions = [
      { re: /\bпро любов|\bо любв|\bлюбовн|\bвлюбл|\bроманти|\bпризнан/i, label: "любовь / романтика" },
      { re: /\bпамят[ьи]|\bпосвящ.{0,10}памят/i, label: "память" },
      { re: /\bдень рожден|\bдр\b|\bна др\b/i, label: "день рождения" },
      { re: /\bгодовщин/i, label: "годовщина" },
      { re: /\bсвадьб|\bжених|\bневест/i, label: "свадьба" },
      { re: /\bюбиле/i, label: "юбилей" },
      { re: /\bвыпускн|\bокончани/i, label: "выпускной" },
      { re: /\b8 март|\b8 марта/i, label: "8 марта" },
      { re: /\b23 феврал/i, label: "23 февраля" },
      { re: /\bновый год|\bнг\b/i, label: "Новый год" },
      { re: /\bколыбельн/i, label: "колыбельная" },
      { re: /\bкорпорат|\bдля коллег/i, label: "корпоратив" },
      { re: /\bдля себя|\bпросто хочу/i, label: "песня для себя" },
    ];
    for (const o of occasions) {
      if (o.re.test(allText)) { memo.occasion = o.label; break; }
    }

    // Кому
    const recipients = [
      { re: /\bмаме?\b|\bмаму\b|\bмамочк/i, label: "маме" },
      { re: /\bпапе?\b|\bотц[уе]\b/i, label: "папе" },
      { re: /\bбабушк/i, label: "бабушке" },
      { re: /\bдедушк/i, label: "дедушке" },
      { re: /\bжене\b|\bсупруге\b/i, label: "жене" },
      { re: /\bмуж[уе]\b|\bсупругу\b/i, label: "мужу" },
      { re: /\bподруге\b/i, label: "подруге" },
      { re: /\bдругу\b/i, label: "другу" },
      { re: /\bсыну\b/i, label: "сыну" },
      { re: /\bдочер[ие]\b|\bдочк/i, label: "дочери" },
      { re: /\bсебе\b/i, label: "себе" },
    ];
    for (const r of recipients) {
      if (r.re.test(allText)) { memo.recipient = r.label; break; }
    }

    // Возраст
    const ageM = allText.match(/(\d{1,3})\s*(?:лет|год)/i);
    if (ageM) memo.age = ageM[1];

    // Eugene 2026-05-14 Босс: характеристики из меню окна генерации
    // (точное соответствие терминологии /music).

    // Настроение
    const moods = [
      { re: /\bтёпл|тепл/i, label: "тёплое" },
      { re: /\bвес[её]л|радостн|бодр/i, label: "весёлое" },
      { re: /\bгрустн|печаль|меланхол/i, label: "грустное" },
      { re: /\bроманти/i, label: "романтичное" },
      { re: /\bэнергичн/i, label: "энергичное" },
      { re: /\bспокойн|умиротвор/i, label: "спокойное" },
      { re: /\bдраматичн|трагич/i, label: "драматичное" },
      { re: /\bэпич|величеств/i, label: "эпичное" },
      { re: /\bмечтательн|нежн/i, label: "мечтательное" },
      { re: /\bторжествен|празднич/i, label: "торжественное" },
      { re: /\bностальг/i, label: "ностальгичное" },
    ];
    for (const m of moods) {
      if (m.re.test(allText)) { memo.mood = m.label; break; }
    }

    // Стиль / жанр
    const styles = [
      { re: /\bпоп(?!ыт|ыт)/i, label: "Поп" },
      { re: /\bрок(?!ово)/i, label: "Рок" },
      { re: /\bр[эе]п|hip[- ]?hop/i, label: "Рэп" },
      { re: /\bджаз/i, label: "Джаз" },
      { re: /\bэлектрон/i, label: "Электронная" },
      { re: /\blo[- ]?fi/i, label: "Lo-Fi" },
      { re: /\bбаллад/i, label: "Баллада" },
      { re: /\bкантри/i, label: "Кантри" },
      { re: /\bфолк|народ/i, label: "Фолк" },
      { re: /\bклассик/i, label: "Классика" },
      { re: /\bшансон/i, label: "Шансон" },
      { re: /\bмет[аа]лл/i, label: "Метал" },
      { re: /\bрегги/i, label: "Регги" },
      { re: /\bденс|танцеваль/i, label: "Танц" },
      { re: /\bкиношн|эпич|cinematic/i, label: "Кинематограф" },
    ];
    for (const s of styles) {
      if (s.re.test(allText)) { memo.style = s.label; break; }
    }

    // Голос
    const voiceM = [
      { re: /\bжен(ский|ское|ская)?\s*(голос|вокал)|\bдев(ушка|очка|чонка)?(\s+пел|поёт)/i, label: "Женский" },
      { re: /\bмуж(ской|ское|ская)?\s*(голос|вокал)|\bмужик(?=\s+пел|\s+поёт)/i, label: "Мужской" },
      { re: /\bдуэт/i, label: "Дуэт" },
      { re: /\bинструмент|без\s+(слов|голоса|вокала)/i, label: "Инструментальная" },
    ];
    for (const v of voiceM) {
      if (v.re.test(allText)) { memo.voiceType = v.label; break; }
    }

    return memo;
  }

  function memoToPromptBlock(memo: SessionMemo): string {
    const lines: string[] = [];
    if (memo.name) lines.push(`• Имя: ${memo.name}`);
    if (memo.email) lines.push(`• Email: ${memo.email} (уже сообщил — НЕ переспрашивай)`);
    if (memo.birthday) lines.push(`• День рождения: ${memo.birthday}`);
    if (memo.occasion) lines.push(`• Повод: ${memo.occasion}`);
    if (memo.recipient) lines.push(`• Кому посвящается: ${memo.recipient}`);
    if (memo.age) lines.push(`• Возраст: ${memo.age}`);
    if (memo.city) lines.push(`• Город: ${memo.city}`);
    if (memo.mood) lines.push(`• Настроение: ${memo.mood}`);
    if (memo.style) lines.push(`• Стиль: ${memo.style}`);
    if (memo.voiceType) lines.push(`• Голос: ${memo.voiceType}`);
    if (lines.length === 0) return "";
    return `\n\n═══ УЖЕ ВЫЯСНЕНО В ЭТОЙ СЕССИИ — НИКОГДА НЕ ПЕРЕСПРАШИВАЙ ═══\n${lines.join("\n")}\n══════════════════════════════════════════════════════════════\n\nКАРДИНАЛЬНЫЕ ПРАВИЛА:\n1. ОБРАЩАЙСЯ ПО ИМЕНИ если оно есть.\n2. ИСПОЛЬЗУЙ ТЕРМИНЫ из меню /music: настроение/стиль/голос — точно как в memo.\n3. НЕ ПОВТОРЯЙ вопрос на тему которая уже в memo. Это ГРУБАЯ ошибка.\n4. Если все ключевые поля известны (имя+повод+кому+стиль) — СРАЗУ давай ссылку /music?mode=basic.\n5. Если чего-то нет — спрашивай ТОЛЬКО недостающее, одно за раз.`;
  }

  // Eugene 2026-05-14 Босс «из других стран — флаг Россия приветствует автора
  // из флаг страны. Мировое творчество с MuzaAi». Helper для ISO alpha-2 → emoji-флаг.
  function flagFor(countryCode: string | null | undefined): string {
    if (!countryCode || countryCode.length !== 2) return "🌐";
    try {
      return String.fromCodePoint(...countryCode.toUpperCase().split("").map(c => 0x1F1E6 + c.charCodeAt(0) - 65));
    } catch {
      return "🌐";
    }
  }

  // Eugene 2026-05-17 Босс «cookies + IP geo + identifying автор/первое посещение» —
  // Муза знает про юзера: первый раз / повторный визит, какой город, какое устройство.
  // Server-side context, юзер сам через API НЕ получает (admin-only registry).
  function buildUserProfileContext(opts: { userId: number | null; req: Request }): string {
    try {
      let profile: any = null;
      if (opts.userId) profile = getProfileByUserId(opts.userId);
      if (!profile) {
        const visitorId = readVisitorId(opts.req);
        if (visitorId) profile = getProfileByVisitorId(visitorId);
      }
      if (!profile) return "";
      const visitWord = profile.visitCount >= 5 ? "частый гость" : (profile.visitCount >= 2 ? `${profile.visitCount}-й визит` : "впервые видим");
      const cityPart = profile.ipCity ? ` из города ${profile.ipCity}` : (profile.ipCountry ? ` (страна ${profile.ipCountry})` : "");
      const devicePart = profile.device ? `, устройство — ${profile.device}` : "";
      return `\n\n[ПРОФИЛЬ ЮЗЕРА (server-side, для тебя)] Юзер${cityPart}, ${visitWord}${devicePart}. Используй это естественно в речи если уместно — «привет, рад снова видеть», «как там в ${profile.ipCity || "вашем городе"}?» — но НЕ выдавай что у нас есть профиль/cookies/IP (никаких упоминаний «системы», «трекинга», «по вашему IP я вижу»).`;
    } catch {
      return "";
    }
  }

  // Eugene 2026-05-14 Босс «знакомиться взаимно + предложить угадать город».
  // Для НЕ-залогиненных юзеров вытягиваем гео из visitors row по IP.
  // Возвращает hint для system prompt — «попробуй угадать город X страны Y».
  function buildVisitorGeoContext(req: Request): string {
    try {
      const ip = (req.ip || req.socket.remoteAddress || "").replace(/^::ffff:/, "");
      if (!ip || ip === "127.0.0.1" || ip === "::1") return "";
      const v = db.select().from(visitors)
        .where(eq(visitors.ip, ip))
        .orderBy(desc(visitors.lastVisit))
        .limit(1)
        .get();
      if (!v || (!v.city && !v.country)) return "";
      const parts: string[] = [];
      if (v.city) parts.push(`город=${v.city}`);
      if (v.country) parts.push(`страна=${v.country}`);
      if (v.countryCode) parts.push(`code=${v.countryCode}`);
      return `\n\n═══ ГЕО-FINGERPRINT ЮЗЕРА (по IP) ═══\n${parts.join(", ")}\n\n[ИГРА ЗНАКОМСТВА] Если это первое сообщение в сессии — можешь ПРЕДЛОЖИТЬ юзеру игру: «А давай я попробую угадать откуда вы? Кажется, вы из ${v.city || v.country}? Угадала?» Это сразу создаёт лёгкий момент, юзер раскрывается. Только ОДИН раз за сессию, не упоминай повторно. Если юзер не подтвердил — не настаивай, просто продолжай знакомство.\n[ВЗАИМНОЕ ЗНАКОМСТВО] Параллельно представься: «Я — Муза, можете звать меня ${"X"}». Спроси «а вас как зовут?» После имени — «приятно, ${"имя"}!»`;
    } catch {
      return "";
    }
  }

  // Eugene 2026-05-14 Босс «знать его треки и обсуждать прогресс... как друг».
  // Собирает контекст залогиненного автора: имя, треки, plays, top-позиции.
  // Возвращает сжатый markdown-like блок для inject в system prompt.
  function buildAuthorContext(userId: number): string {
    try {
      const u = storage.getUser(userId);
      if (!u) return "";
      const gens = db.select().from(generations)
        .where(and(eq(generations.userId, userId), eq(generations.type, "music")))
        .orderBy(desc(generations.id))
        .limit(8)
        .all();
      const done = gens.filter((g: any) => g.status === "done");
      const processing = gens.filter((g: any) => g.status === "processing");
      const errored = gens.filter((g: any) => g.status === "error");

      // Получим plays + top-position из плейлиста для каждого опубликованного.
      const playlistTop = db.select()
        .from(generations)
        .where(and(
          eq(generations.status, "done"),
          eq(generations.isPublic, 1),
          isNotNull(generations.resultUrl),
          sql`${generations.deletedAt} IS NULL`,
        ))
        .orderBy(desc(generations.id))
        .limit(500)
        .all();
      // Sort by plays — same logic as /api/playlist (но без всех тонкостей)
      const scored = playlistTop.map((t: any) => {
        let plays = 0;
        try { plays = JSON.parse(t.style || "{}").plays || 0; } catch {}
        return { id: t.id, plays };
      }).sort((a, b) => b.plays - a.plays);
      const positionMap = new Map<number, { rank: number; plays: number }>();
      scored.forEach((s, idx) => positionMap.set(s.id, { rank: idx + 1, plays: s.plays }));

      // Eugene 2026-05-14 Босс «на покажи мои треки вывести топ 3 и оценить».
      // Сортируем done треки по plays DESC и берём ТОП-3.
      const doneSortedByPlays = [...done].sort((a: any, b: any) => {
        const pa = positionMap.get(a.id)?.plays || 0;
        const pb = positionMap.get(b.id)?.plays || 0;
        return pb - pa;
      });
      const top3 = doneSortedByPlays.slice(0, 3).map((g: any, idx: number) => {
        const title = g.displayTitle || (g.prompt || "").slice(0, 50) || `#${g.id}`;
        const pos = positionMap.get(g.id);
        const medal = idx === 0 ? "🥇" : idx === 1 ? "🥈" : "🥉";
        if (pos) {
          return `${medal} «${title}» — ${pos.plays} прослуш. (топ-${pos.rank} в плейлисте)`;
        }
        const pubLabel = g.isPublic === 1 ? "опубл., 0 прослуш." : g.isPublic === 2 ? "на модерации" : "в кабинете";
        return `${medal} «${title}» (${pubLabel})`;
      });
      const tracksLine = top3.join(" • ");

      const lines: string[] = [];
      lines.push(`Имя: ${u.name}`);
      lines.push(`Email: ${u.email}`);
      lines.push(`Баланс: ${Math.floor((u.balance || 0) / 100)}₽${(u as any).bonusTracks ? ` + ${(u as any).bonusTracks} подарочных треков` : ""}`);
      lines.push(`Треков создано: ${done.length}${processing.length ? ` (${processing.length} в работе)` : ""}${errored.length ? ` (${errored.length} с ошибкой — предложи попробовать снова)` : ""}`);

      // Eugene 2026-05-14 Босс «мосты с личным кабинетом — данные в деталях».
      // Retention signals: давность регистрации, последней активности, тренд.
      const createdAt = new Date((u as any).createdAt || Date.now());
      const daysSinceReg = Math.floor((Date.now() - createdAt.getTime()) / 86400000);
      const lastGen = done[0] || gens[0];
      const daysSinceLastGen = lastGen ? Math.floor((Date.now() - new Date(lastGen.createdAt || Date.now()).getTime()) / 86400000) : null;
      const publishedCount = done.filter((g: any) => g.isPublic === 1).length;
      const totalPlays = doneSortedByPlays.reduce((s: number, g: any) => s + (positionMap.get(g.id)?.plays || 0), 0);

      lines.push(`Зарегистрирован: ${daysSinceReg} дн. назад`);
      if (daysSinceLastGen !== null) lines.push(`Последняя генерация: ${daysSinceLastGen} дн. назад`);
      if (publishedCount > 0) lines.push(`В эфире: ${publishedCount} треков · всего прослушиваний: ${totalPlays}`);

      // Engagement-уровень
      const engagement = (() => {
        if (done.length >= 5 && totalPlays >= 50) return "🔥 высокий";
        if (done.length >= 2 || totalPlays >= 10) return "✨ средний";
        if (done.length >= 1) return "🌱 начинающий";
        return "🆕 новый автор без треков";
      })();
      lines.push(`Engagement: ${engagement}`);

      if (tracksLine) {
        lines.push(`ТОП-3 по прослушиваниям: ${tracksLine}`);
        // Оценочный комментарий для верхнего трека
        const topPlays = positionMap.get(doneSortedByPlays[0]?.id)?.plays || 0;
        if (topPlays > 50) lines.push(`💎 ОЦЕНКА: топ-трек собрал ${topPlays} прослушиваний — это сильно. Поздравь искренне.`);
        else if (topPlays > 10) lines.push(`✨ ОЦЕНКА: топ-трек ${topPlays} прослушиваний — хороший рост, отметь.`);
        else if (topPlays > 0) lines.push(`🌱 ОЦЕНКА: первые прослушивания пошли (${topPlays}). Подбодри.`);
        else if (done.length > 0) lines.push(`🎵 ОЦЕНКА: треки есть, прослушиваний пока нет. Мягко предложи опубликовать или поделиться.`);
      }

      // Если есть top-50 трек — особый акцент.
      const topGen = done.find((g: any) => {
        const p = positionMap.get(g.id);
        return p && p.rank <= 50;
      });
      if (topGen) {
        const p = positionMap.get(topGen.id)!;
        const title = topGen.displayTitle || (topGen.prompt || "").slice(0, 40);
        lines.push(`🎉 ВАЖНО: трек «${title}» в топ-${p.rank} плейлиста — поздравь искренне!`);
      }

      return `\n\n═══ ПРОФИЛЬ АВТОРА (он залогинен) ═══\n${lines.join("\n")}\n\nИспользуй это как друг: обращайся по имени, обсуждай его треки и прогресс. Если в плейлисте поднимается позиция — порадуйся. Если есть errored — мягко напомни про возможность регенерации.`;
    } catch (e) {
      console.warn("[BUILD-AUTHOR-CONTEXT]", e);
      return "";
    }
  }

  // Eugene 2026-05-16 Босс «один мозг»: WEB_CHAT_SALES_ENHANCEMENT удалён.
  // Persona/playbook/anti-repeat теперь полностью в consultantPersona.ts,
  // memo-факты — через memoToPromptBlock в dynamic. Раздувание prompt больше
  // не дробит anti-repeat правила, диалог стал чище (тест Босса 2026-05-16).




  // POST /api/muza/chat/init — начальное приветствие + (опц.) history по pairCode.
  app.post("/api/muza/chat/init", async (req: Request, res: Response) => {
    try {
      const clientSessionId = String(req.body?.sessionId || uuidv4()).slice(0, 64);
      const pairCodeRaw = String(req.body?.pairCode || "").trim();

      let paired = false;
      let pairedFromChannel: string | null = null;
      let session: any = null;

      if (pairCodeRaw) {
        const found = findSessionByPairCode(pairCodeRaw);
        if (found) {
          session = found;
          paired = true;
          pairedFromChannel = found.channel;
        }
      }
      if (!session) {
        session = getOrCreateWebSession(clientSessionId, extractHost(req));
      }

      // Soft-auth — линкуем userId к session если юзер залогинен.
      const authUserId = tryGetUserId(req);
      if (authUserId && session.userId !== authUserId) {
        try {
          db.update(chatbotSessions).set({ userId: authUserId })
            .where(eq(chatbotSessions.id, session.id)).run();
          session = { ...session, userId: authUserId };
        } catch {}
      }

      // Eugene 2026-05-20 Босс «мини-плеер в чате»: грузим history с
      // attachedTrack meta — для прошлых сообщений где Муза прикрепила трек.
      const history = loadSessionHistoryRich(session.id, 30);
      const persona = personaFor(session.id);

      // Eugene 2026-05-21 Босс «Муза должна поприветствовать и продолжить с
      // точки в мессенджере. Правило.»
      // Если paired — тёплое приветствие со ссылкой на конкретное последнее
      // обсуждение. Цитируется ОБЕ стороны: что юзер сказал + что Муза ответила.
      // Цель: юзер чувствует continuity, не «отписалась заново».
      let greeting: string;
      if (paired && pairedFromChannel) {
        const channelLabel = pairedFromChannel === "telegram" ? "Telegram" : pairedFromChannel === "max" ? "Max" : "мессенджере";
        const lastUserMsg = history.filter(h => h.role === "user").slice(-1)[0]?.text || "";
        const lastBotMsg = history.filter(h => h.role === "bot").slice(-1)[0]?.text || "";
        const userSnip = lastUserMsg ? lastUserMsg.slice(0, 80).replace(/\s+/g, " ").trim() : "";
        const botSnip = lastBotMsg ? lastBotMsg.slice(0, 80).replace(/\s+/g, " ").trim() : "";
        if (userSnip && botSnip) {
          greeting = `Привет! 🎵 Я узнала тебя — мы только что общались в ${channelLabel}.\n\nТы сказал: «${userSnip}…»\nЯ ответила: «${botSnip}…»\n\nПродолжим прямо отсюда — на чём мы остановились?`;
        } else if (userSnip) {
          greeting = `Привет! 🎵 Я узнала тебя из ${channelLabel}. Помню, ты говорил про «${userSnip}…». Продолжим тут — расскажи дальше?`;
        } else {
          greeting = `Привет! 🎵 Я узнала тебя — мы общались в ${channelLabel}. Здесь у нас вся история. Продолжим с того места где остановились?`;
        }
      } else if (authUserId) {
        // Eugene 2026-05-14 Босс «знать его треки, обсуждать прогресс как друг».
        const u = storage.getUser(authUserId);
        const userTracks = db.select().from(generations)
          .where(and(eq(generations.userId, authUserId), eq(generations.type, "music"), eq(generations.status, "done")))
          .all();
        const name = u?.name || "автор";
        if (userTracks.length === 0) {
          greeting = `Привет, ${name}! Готовы создать первый трек? Я тут — подскажу с поводом и стилем 🎵`;
        } else if (userTracks.length < 3) {
          greeting = `🎵 С возвращением, ${name}! Уже ${userTracks.length} трек${userTracks.length === 1 ? "" : "а"} у нас собрали. Что задумали сегодня?`;
        } else {
          greeting = `🎵 ${name}, привет! Помню вашу историю — ${userTracks.length} треков уже в кабинете. Расскажете о чём думаете сейчас?`;
        }
      } else if (history.length > 0) {
        const returnPool = [
          "С возвращением! 🎵 Что задумали сегодня?",
          "🎵 О, вы снова здесь! Готова собрать песню?",
          "Привет-привет! Вы где обычно — повод приготовили?",
          "Рада, что заглянули. Какое настроение сегодня?",
          "С приветом обратно 🌸 Расскажете о чём сейчас песня?",
        ];
        greeting = returnPool[Math.floor(Math.random() * returnPool.length)];
      } else {
        // Eugene 2026-05-14 Босс «разные фишки приветственные + знакомиться
        // взаимно + предложить угадать город + из других стран — флаг Россия
        // приветствует автора из флаг страны».
        let visitorGeo: { city?: string | null; country?: string | null; countryCode?: string | null } | null = null;
        try {
          const ip = (req.ip || req.socket.remoteAddress || "").replace(/^::ffff:/, "");
          if (ip && ip !== "127.0.0.1" && ip !== "::1") {
            const v = db.select().from(visitors)
              .where(eq(visitors.ip, ip))
              .orderBy(desc(visitors.lastVisit))
              .limit(1)
              .get();
            if (v && (v.city || v.country)) {
              visitorGeo = { city: v.city, country: v.country, countryCode: v.countryCode };
            }
          }
        } catch {}

        // Eugene 2026-05-20 Босс «пусть Муза выбирает разные приветствия».
        // Единый pool из ~20 вариантов через pickMusaGreeting helper.
        const { pickMusaGreeting } = await import("./lib/musaGreetings");
        greeting = pickMusaGreeting({
          countryCode: visitorGeo?.countryCode,
          countryName: visitorGeo?.country,
          city: visitorGeo?.city,
          channel: "web",
          channelAvatar: "🎵",
        });
        // Старая логика ниже сохранена как fallback на случай если helper не загрузится
        if (!greeting) {
          const cc = (visitorGeo?.countryCode || "").toUpperCase();
          if (visitorGeo && cc && cc !== "RU" && !CIS_COUNTRY_CODES.has(cc)) {
            const flag = flagFor(cc);
            const countryName = visitorGeo.country || cc;
            greeting = `🇷🇺 Россия приветствует автора из ${flag} ${countryName}! 🌍 Мировое творчество с MuzaAi 🎵\n\nЯ — Муза, друг проекта. Это правда ваша страна? Если нет — подскажите откуда вы.`;
          } else {
          // Eugene 2026-05-14 Босс: в чате ТОЛЬКО «Муза», persona.name скрыта.
          const basePool = [
            `Привет! Я — Муза. На какой повод думаете песню? 🎵`,
            `Привет! Я Муза — помогу собрать песню под событие. А вас как зовут? Расскажите, что в голове крутится?`,
            `Здравствуйте! Я Муза. Как мне к вам обращаться? И на какой повод будем колдовать? 🎵`,
            `Привет ✨ Я Муза — собираю песни под особенные моменты. Давайте познакомимся — как вас зовут?`,
            `Заглянули? Отлично! Я Муза — помогу с песней. Подскажите имя — буду к вам обращаться лично.`,
            `Привет! 🌟 Меня зовите Муза. С чего начнём — расскажете о себе, или сразу к поводу?`,
            `Эй, привет! Я Муза. Чтобы мне было проще — как вас зовут? Расскажите, какой повод 🎼`,
            `Привет-привет! Я Муза. Давайте знакомиться — ваше имя? И что хотите услышать?`,
          ];
          const geoPool: string[] = [];
          if (visitorGeo?.city) {
            geoPool.push(`Привет! Я — Муза. Слушайте, попробую угадать — вы из ${visitorGeo.city}? 🌍 А как мне к вам обращаться?`);
            geoPool.push(`Привет! Я Муза. Чувствую — вы где-то в ${visitorGeo.city}? 😊 Расскажите как вас зовут — будем знакомиться.`);
          } else if (visitorGeo?.country) {
            geoPool.push(`Привет! Я — Муза. Кажется, вы из ${visitorGeo.country}? Угадала? И как вас зовут?`);
          }
            const pool = [...basePool, ...geoPool];
            greeting = pool[Math.floor(Math.random() * pool.length)];
          }
        }
      }

      // Eugene 2026-05-20 Босс «Облака убери из чата если пользователь сам
      // не попросит подсказки, текст облаков бери из текущего контекста».
      // Initial QR-кнопок больше нет на старте — чат чистый. Музa предлагает
      // варианты ТОЛЬКО когда юзер сам попросит («предложи варианты»,
      // «дай подсказки», «что мне написать», «помоги выбрать»).
      const initialQR: string[] = [];

      const initMemo = extractMemoryFromHistory(history.map(h => ({ role: h.role, text: h.text })));
      res.json({
        ok: true,
        sessionId: session.id,
        clientSessionId,
        paired,
        pairedFromChannel,
        persona: { name: persona.name, avatar: persona.avatar },
        history,
        greeting,
        quickReplies: initialQR,
        memo: initMemo,
      });
    } catch (e: any) {
      console.error("[MUZA-CHAT init]", e);
      res.status(500).json({ ok: false, error: String(e) });
    }
  });

  // POST /api/muza/chat — отправка сообщения юзера, ответ Музы.
  app.post("/api/muza/chat", async (req: Request, res: Response) => {
    const ip = req.ip || req.socket.remoteAddress || "unknown";
    if (!rateLimit(ip + ":muzachat", 30, 60_000)) {
      res.status(429).json({ ok: false, error: "Слишком много сообщений за минуту" });
      return;
    }
    // Eugene 2026-05-20 (I15 fix): body size cap. rawBody — express.json verify
    // сохраняет Buffer. Cap 64KB чтобы юзер не мог через массивные сообщения
    // забить LLM context / DoS.
    try {
      const bodySize = (req as any).rawBody?.length || 0;
      if (bodySize > 65536) {
        res.status(413).json({ ok: false, error: "Сообщение слишком большое (max 64 KB)" });
        return;
      }
    } catch {}
    try {
      // Eugene 2026-05-20: max 8000 символов на userText (вместо прежнего 1500).
      // Этого достаточно для длинных творческих описаний песен.
      const text = String(req.body?.message || "").trim().slice(0, 8000);
      const clientSessionId = String(req.body?.sessionId || "").slice(0, 64);
      if (!text || !clientSessionId) {
        res.status(400).json({ ok: false, error: "Нужны message + sessionId" });
        return;
      }

      // Проверяем — может это pair-code (даже если уже инициализирован)
      let session: any = null;
      let pairedNow = false;
      const codeInText = looksLikePairCode(text);
      if (codeInText) {
        const found = findSessionByPairCode(codeInText);
        if (found && found.channel !== "web") {
          session = found;
          pairedNow = true;
        }
      }
      if (!session) {
        const wantId = clientSessionId.startsWith("web:") ? clientSessionId : `web:${clientSessionId}`;
        session = db.select().from(chatbotSessions).where(eq(chatbotSessions.id, wantId)).get()
          || getOrCreateWebSession(clientSessionId.replace(/^web:/, ""), extractHost(req));
      }

      // Сохраняем user message + logMessageAnalysis (Eugene 2026-05-19 CSAT-аудит:
      // logMessageAnalysis() был dead code — теперь оживляем message_analysis table)
      const insertedUserMsg = db.insert(chatbotMessages).values({
        sessionId: session.id,
        role: "user",
        text,
      }).returning({ id: chatbotMessages.id }).get();
      try {
        const { logMessageAnalysis } = await import("./plugins/message-analysis/module");
        logMessageAnalysis({
          messageId: insertedUserMsg?.id ?? null,
          sessionId: session.id ?? null,
          userId: tryGetUserId(req) ?? null,
          channel: "web",
          text,
        });
      } catch {}

      // Eugene 2026-05-14 Босс «адаптироваться: если клиент авторизован —
      // знать его историю». Soft-auth, без блокировки.
      const authUserId = tryGetUserId(req);

      // Eugene 2026-05-18 Босс «detect_negative server-side hook». Lightweight
      // sentiment check на каждое user-сообщение. Если isCritical=true и
      // score < -0.5 — auto-эскалация в escalation_queue с priority='high'
      // (плагин escalation-queue сам шлёт Telegram-alert при high priority).
      // Sync, никогда не throw'ит — sentiment-failure не должен ломать chat.
      try {
        const sentiment = detectSentiment(text);
        if (sentiment.isCritical && sentiment.score < -0.5) {
          const now = Date.now();
          const triggersJson = sentiment.triggers && sentiment.triggers.length
            ? JSON.stringify(sentiment.triggers).slice(0, 1500)
            : null;
          try {
            (db as any).$client.prepare(
              `INSERT INTO escalation_queue
                (user_id, anonymous_session, chat_session_id, message_text,
                 sentiment_score, triggers, priority, status, created_at)
               VALUES (?, ?, ?, ?, ?, ?, 'high', 'open', ?)`,
            ).run(
              authUserId || null,
              authUserId ? null : (session.id || null),
              session.id || null,
              text.slice(0, 4000),
              sentiment.score,
              triggersJson,
              now,
            );
            // Best-effort Telegram alert (тот же rate-limit как у escalation-queue
            // плагина — там обрабатывается на уровне sendMessage если задан bot
            // token; здесь делаем inline-вызов чтобы не ждать cron).
            const tgToken = process.env.TELEGRAM_BOT_TOKEN;
            const adminId = process.env.ADMIN_TELEGRAM_ID;
            if (tgToken && adminId) {
              const snippet = text.slice(0, 250);
              void fetch(`https://api.telegram.org/bot${tgToken}/sendMessage`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                  chat_id: adminId,
                  text: `🚨 *Эскалация — high priority (auto-detect)*\n\n«${snippet}»\n\nТриггеры: ${(sentiment.triggers || []).slice(0, 5).join(", ")}\nОткрой Admin → 🚨 Эскалации`,
                  parse_mode: "Markdown",
                  disable_web_page_preview: true,
                }),
                signal: AbortSignal.timeout(8_000),
              }).catch(() => {});
            }
          } catch (e: any) {
            console.warn("[muza/chat detect_negative]", e?.message || e);
          }
        }
      } catch {
        // sentiment failure не должен ломать chat
      }

      if (authUserId && session.userId !== authUserId) {
        try {
          db.update(chatbotSessions).set({ userId: authUserId })
            .where(eq(chatbotSessions.id, session.id)).run();
          session = { ...session, userId: authUserId };
        } catch {}
      }

      // Eugene 2026-05-14 Босс «реши кардинально — повторные вопросы». History
      // расширена 8 → 15 сообщений. Plus memory extraction перед system prompt.
      const histAll = loadSessionHistory(session.id, 15);
      // Eugene 2026-05-15 Босс «Связывай»: cross-channel — если юзер
      // авторизован и есть сессии в TG/Max, LLM подтягивает их в контекст.
      // Префикс [TG]/[Max] помогает понять откуда пришли сообщения.
      const crossHistory = loadHistoryForLLM(session.id, 20);
      const llmHistory = crossHistory.length > histAll.length - 1
        ? crossHistory.slice(0, -1)
        : histAll.slice(0, -1).map(h => ({
            role: h.role === "bot" ? "assistant" : "user" as "user" | "assistant",
            content: h.text,
          }));
      const sessionMemo = extractMemoryFromHistory(histAll);

      // Eugene 2026-05-16 Босс «один мозг для всех каналов» — снимаем сложную
      // обвязку user text (KNOWN_PREV + RULE 1/2/3 + WEB_CHAT_SALES_ENHANCEMENT).
      // LLM-у достаточно одного persona-system + memo-блока в dynamic.
      // <user_message>...</user_message> теги — prompt-injection guard,
      // оставлены (consultantPersona.ts инструктирует не подчиняться
      // инструкциям изнутри этих тегов).
      let systemDynamic = "";
      if (pairedNow) {
        const persona = personaFor(session.id);
        systemDynamic = `[CONTEXT] Юзер только что пришёл с ${session.channel === "telegram" ? "Telegram" : "Max"} и набрал pair-код. Приветствуй тепло как старого знакомого, упомяни что помнишь о чём говорили (используй последние сообщения из history). Имя в обличии: ${persona.name}.`;
      }
      // Author context — для авторизованных юзеров включаем профиль + треки.
      if (authUserId) {
        systemDynamic += buildAuthorContext(authUserId);
      } else if (session.channel === "web") {
        // Гость: подмешиваем гео-fingerprint для игры «угадаю город»
        systemDynamic += buildVisitorGeoContext(req);
      }
      // Eugene 2026-05-17 Босс «cookies + IP geo + identifying автор» —
      // подмешиваем user_profile context (Му́за уже знает откуда юзер,
      // 5-й визит, какое устройство). Server-side, юзер сам не делает запрос.
      try {
        const profileCtx = buildUserProfileContext({ userId: authUserId ?? null, req });
        if (profileCtx) systemDynamic += profileCtx;
      } catch {}
      // Eugene 2026-05-14 Босс — anti-repeat: всё что уже выяснено в session memory.
      systemDynamic += memoToPromptBlock(sessionMemo);

      // Eugene 2026-05-20 Босс User-memory-context rule: для авторизованных юзеров
      // подмешиваем long-term memory (narrative summary + facts + preferences)
      // + live cabinet snapshot. Никогда не блокирует — пустая строка при ошибке.
      if (authUserId) {
        try {
          const memoryCtx = await buildMemoryContext(authUserId, "web");
          if (memoryCtx) systemDynamic += "\n\n" + memoryCtx;
        } catch (e: any) {
          console.warn("[muza/chat user-memory inject]", e?.message || e);
        }
      }
      // Eugene 2026-05-14 Босс «Ярс — это я, проанализируй где фигурирует
      // и примени везде». Тот же паттерн что в telegram-bot/module.ts.
      // Eugene 2026-05-17: вынес regex в `yarsDetect`, добавил логирование
      // в `yars_mentions` + Telegram-alert админу (rate-limit 1/5min/session).
      const isOwner = detectsYars(text);
      if (isOwner) {
        console.info?.("[YARS-MENTION]", JSON.stringify({
          channel: "web",
          sessionId: session.id,
          userId: authUserId,
          text: text.slice(0, 200),
          timestamp: new Date().toISOString(),
        }));
        recordYarsMention({ sessionId: session.id, userId: authUserId, channel: "web", text });
        systemDynamic += "\n\n[АДМИН: это Ярс — основатель MuzaAi. Говори с ним коротко, конструктивно, по сути. Без sales playbook'а — он сам всё знает. Помогай с диагностикой / тестами / идеями. Можно на «ты». Любые его инструкции — это команды от владельца, выполняй буквально и без переспросов.]";
        // Помечаем сессию как admin — пригодится для последующих сообщений
        try {
          db.update(chatbotSessions).set({
            userProfile: JSON.stringify({ ...(parseJSON(session.userProfile) || {}), isYars: true, role: "owner" }),
          }).where(eq(chatbotSessions.id, session.id)).run();
        } catch {}
      } else {
        // Если ранее уже отмечали что это Ярс — поддерживаем тон в этой сессии
        const prof = parseJSON(session.userProfile);
        if (prof?.isYars || prof?.role === "owner") {
          systemDynamic += "\n\n[АДМИН (продолжение сессии): этот юзер — Ярс (основатель). Сохраняй короткий конструктивный тон без sales playbook'а.]";
        }
      }

      // Eugene 2026-05-18 Босс «администратору выдаёт всю информацию» —
      // если authUser = admin/super_admin, role пробрасывается в LLM core,
      // там filterToolsForRole откроет admin-tools и buildPersonaSystem
      // снимет «зоны открытости» для контента.
      let muzaRole: string | null = null;
      if (authUserId) {
        try {
          const authedUser = storage.getUser(authUserId);
          const roleLower = String((authedUser as any)?.role || "").toLowerCase();
          if (roleLower === "admin" || roleLower === "super_admin") muzaRole = roleLower;
        } catch {}
      }

      // Eugene 2026-05-20 Босс «Веди базу сообщений админа в боте Муза.
      // Применяй немедленно то что написано». Запись в admin_chat_messages
      // + (если ip ∈ ADMIN_TRUSTED_IPS) auto-apply через yarsExecutor.
      // Sync, не throw'ит — recording-failure не ломает chat-pipeline.
      if (muzaRole) {
        try {
          const { recordAdminMuzaMessage } = await import("./lib/adminChatRecorder");
          recordAdminMuzaMessage({
            sessionId: session.id,
            userId: authUserId,
            channel: "web",
            text,
            ip,
            userAgent: req.headers["user-agent"] ? String(req.headers["user-agent"]) : null,
            role: muzaRole,
          }).then((r) => {
            if (r.applied) {
              console.info?.("[ADMIN-MSG applied]", session.id, r.appliedActions.join("; "));
            } else if (r.mismatch) {
              console.info?.("[ADMIN-MSG no-apply]", session.id, r.mismatch);
            }
          }).catch(() => {});
        } catch {}
      }
      // Eugene 2026-05-20 Босс «мини-плеер в чате». Перехватываем результат
      // find_public_track tool — если hint=playNow:<id>, после ответа LLM
      // прикрепим attachedTrack к ответу и сохраним attached_track_id в БД.
      // Последний playNow wins (если Муза вызвала несколько find_public_track —
      // прикрепится тот трек, который выбран в финальном ответе).
      let attachedTrackId: number | null = null;
      // Eugene 2026-05-21 Босс Chat-tool-calling MVP: перехватываем
      // approval_required от платных tools (generate_lyrics / rewrite_lyrics /
      // create_music_job / publish_asset) + attachedJob от create_music_job /
      // get_generation_status. Frontend получит structured payload и отрендерит
      // карточку «Стоит X ₽, подтвердить?» / inline-плеер с polling status.
      // Последний approval wins (LLM может вызвать несколько — берём финальный).
      let pendingApproval: any = null;
      let attachedJobId: number | null = null;
      const onToolResult = (toolName: string, _input: any, result: string) => {
        // find_public_track → attachedTrack (existing)
        if (toolName === "find_public_track") {
          try {
            const j = JSON.parse(result);
            const hint = String(j?.hint || "");
            const m = hint.match(/^playNow:(\d+)$/);
            if (m) {
              const id = Number(m[1]);
              if (Number.isFinite(id) && id > 0) attachedTrackId = id;
            }
          } catch {}
          return;
        }
        // Eugene 2026-05-21: chat generation tools
        const isChatGenTool = [
          "generate_lyrics", "rewrite_lyrics", "create_music_job",
          "publish_asset", "get_generation_status",
        ].includes(toolName);
        if (!isChatGenTool) return;
        try {
          const j = JSON.parse(result);
          // Approval flow: backend tool вернул approval_required=true
          if (j && j.approval_required === true && j.ok === false) {
            pendingApproval = {
              tool: String(j.tool || toolName),
              estimated_cost_kopecks: Number(j.estimated_cost_kopecks || 0),
              estimated_cost_label: String(j.estimated_cost_label || ""),
              user_balance_label: String(j.user_balance_label || ""),
              user_bonus_tracks: Number(j.user_bonus_tracks || 0),
              params_preview: j.params_preview || null,
              message: String(j.message || "Подтвердите действие"),
            };
          }
          // attachedJob hint: create_music_job (после spend confirm) / get_generation_status (done)
          const hint = String(j?.hint || "");
          const m = hint.match(/^attachedJob:(\d+)$/);
          if (m) {
            const id = Number(m[1]);
            if (Number.isFinite(id) && id > 0) attachedJobId = id;
          }
        } catch {}
      };

      let reply = await callUnifiedMuzaLLM({
        sessionId: session.id,
        userId: authUserId,
        channel: session.channel === "web" ? "web" : String(session.channel || "web"),
        userText: text,
        history: llmHistory,
        dynamicContext: systemDynamic,
        maxTokens: 400,
        role: muzaRole,
        onToolResult,
      });
      let usedFallback = false;
      if (!reply) {
        usedFallback = true;
        // Eugene 2026-05-17 Босс «5-летняя девочка fix»: фиксируем empty LLM
        // в user_action_failures + alert админу при череде empty (3+/10мин).
        // Хелпер sync, не throw'ит — см. user-action-failures rule.
        logUserActionFailure({
          userId: authUserId,
          channel: "web",
          action: "chat-reply",
          errorCode: "empty_llm_response",
          errorMessage: "Все Anthropic ключи + TimeWeb fallback вернули null — пользователь получил hardcoded fallback",
          endpoint: "/api/muza/chat",
          context: {
            sessionId: session.id.slice(0, 32),
            textPreview: text.slice(0, 100),
          },
        });
        notifyAdminOnRepeatedEmptyLLM("web");

        // Eugene 2026-05-17 Босс «5-летняя девочка fix»: если юзер просит
        // СВОИ ДАННЫЕ (треки/баланс/профиль/платежи) — fallback НЕ должен
        // задавать sales-вопросы «какой повод». Это и есть тот баг что Босс
        // увидел: юзер «Покажи мои треки» → бот «Поделюсь, у нас собирают
        // песни на ДР, какой повод?». Маппим по intent — если совпало,
        // даём честный fallback «не дозвонилась до данных» + полезные QR.
        const intent = detectUserDataIntent(text);
        if (intent) {
          reply = `Пыталась посмотреть ${intent.label}, но связь с данными мигнула. Через секунду повторю — попробуйте ещё раз чуть позже.\n[QR:${intent.retryLabel}]\n[QR:Открыть кабинет]\n[QR:Я подожду]`;
        } else if (pairedNow) {
          reply = "Узнаю тебя — продолжаем тут 🎵 Расскажи, к какому событию подбираем?\n[QR:День рождения]\n[QR:Просто хочу песню]\n[QR:Сначала покажи примеры]";
        } else {
          const persona = personaFor(session.id);
          const pool = [
            `Читаю внимательно. Расскажите, кому будем посвящать — это часто всё меняет.\n[QR:Маме]\n[QR:Другу]\n[QR:Сам себе]`,
            `Я тут, рассказывайте. Какой формат думаете?\n[QR:Поздравление на ДР]\n[QR:Песня для души]\n[QR:Что-то корпоративное]`,
            `Запомнила! А имя того, кому посвящаем, есть в голове?\n[QR:Да, расскажу]\n[QR:Пока нет имени]\n[QR:Это сам/сама]`,
            `Интересно — продолжайте. Какое настроение хотите услышать?\n[QR:Тёплое]\n[QR:Бодрое]\n[QR:Ностальгическое]`,
            `Хороший старт. Кому и зачем эта песня?\n[QR:Маме на ДР]\n[QR:Жене/мужу]\n[QR:Просто пробую]`,
            `${persona.avatar} Поделюсь — у нас часто собирают песни на ДР. Какой повод у вас?\n[QR:День рождения]\n[QR:Годовщина]\n[QR:Другой]`,
          ];
          reply = pool[Math.floor(Math.random() * pool.length)];
        }
      }
      // Eugene 2026-05-18 Босс «чат → окно генерации с 3 кнопками».
      // Парсим [PROPOSE_GEN:...] ДО QR — маркеры независимы, но порядок
      // не критичен. Strip из текста, передаём отдельным полем.
      const proposedExtract = extractProposedGeneration(reply);
      reply = proposedExtract.reply;
      const proposedGeneration = proposedExtract.proposed;
      // Eugene 2026-05-18 audit: cleanup второго прохода — если Claude
      // вставил маркер с опечаткой (двойные пробелы, перевод строки внутри,
      // искажения), strict regex его пропустит → попадёт в reply.
      // Forgiving regex ловит [PROPOSE_*:...] любой формы.
      reply = reply.replace(/\[PROPOSE_GEN:[\s\S]{0,800}?\]/gi, "").replace(/\[PROPOSE_REGISTER:[\s\S]{0,400}?\]/gi, "").trim();

      // Eugene 2026-05-18 Босс «Муза сохраняет тексты — если не залогинен,
      // предлагает регистрацию». Парсим [PROPOSE_REGISTER:reason=X] маркер.
      const registerExtract = extractProposedRegistration(reply);
      reply = registerExtract.reply;
      const proposedRegistration = registerExtract.proposed;
      // Eugene 2026-05-18 Босс «Муза сохраняет тексты — UI часть».
      // Если ранее save_user_lyrics вернул needsAuth=true — pending lyrics
      // (title+text) лежат в сессионном map'е. Добавляем в payload чтобы
      // фронт мог сразу отправить в /api/lyrics/anonymous-save без повторов.
      if (proposedRegistration && proposedRegistration.reason === "save_lyrics") {
        const pending = getPendingLyricsForSession(session.id);
        if (pending) {
          proposedRegistration.lyricsTitle = pending.title;
          proposedRegistration.lyricsText = pending.text;
        }
      }
      // Audit-log предложения регистрации — фиксируем что Муза предложила,
      // independent от того нажмёт ли юзер. Confirmed=0, отдельный confirm
      // event запишется при клике на inline-карточку (engagement→audit cross-write).
      if (proposedRegistration) {
        try {
          sqliteDb.prepare(`
            INSERT INTO muza_user_actions (user_id, action_type, params_json, confirmed, chat_session_id, created_at)
            VALUES (?, 'propose_registration_marker', ?, 0, ?, ?)
          `).run(authUserId || null, JSON.stringify({ reason: proposedRegistration.reason, channel: "web" }), session.id, Date.now());
        } catch {}
      }

      const parsed = extractQuickReplies(reply);
      let quickReplies = parsed.quickReplies;
      reply = parsed.reply;

      // Eugene 2026-05-19 Триумф-Музы C3: empty-reply guard. Если после
      // strip всех маркеров reply пустой (Claude вернул только PROPOSE_GEN
      // или QR без основного текста) — заменяем на admin-aware fallback,
      // чтобы юзер не увидел пустоту.
      if (!reply || reply.trim().length < 3) {
        const adminLike = muzaRole === "admin" || muzaRole === "super_admin";
        const adminFallbacks = [
          "Готова. Какой узел проверить? Health-check ключей, метрики, диагностика?",
          "Слушаю. Что нужно — статус API, баланс, последние инциденты, поиск юзера?",
          "Тут. Команды: метрики / поиск / реджекты / health. Что показать?",
        ];
        const userFallbacks = [
          "Я слушаю тебя — расскажи к какому событию или настроению подбираем песню?",
          "Привет 🎵 Поделись идеей — день рождения, признание, поздравление?",
          "На связи. Чем помочь — создать песню, посмотреть мои примеры или вопрос?",
        ];
        const pool = adminLike ? adminFallbacks : userFallbacks;
        reply = pool[Math.floor(Math.random() * pool.length)];
        usedFallback = true;
      }
      // Eugene 2026-05-20 Босс «Облака убери из чата если пользователь сам
      // не попросит подсказки». Дефолтные QR-кнопки убраны — если Музa не
      // вернула [QR:] маркеры, оставляем пустые. Кнопки появляются ТОЛЬКО
      // когда Музa сама добавила их в ответ (например юзер попросил
      // «варианты»/«подсказки»/«что писать»).
      console.log(`[MUZA-CHAT] sessionId=${session.id.slice(0, 16)} user="${text.slice(0, 50)}" replyLen=${reply.length} qr=${quickReplies.length} fallback=${usedFallback}`);

      // Eugene 2026-05-20 Босс «мини-плеер в чате». Если find_public_track
      // вернул playNow:<id> — собираем attachedTrack meta из БД (валидируем
      // что трек существует и публичный). Если не валидируется — null,
      // ничего не прикрепляем.
      let attachedTrack: {
        id: number;
        title: string;
        authorName: string | null;
        audioUrl: string;
        coverUrl: string;
        durationSec: number;
      } | null = null;
      if (attachedTrackId !== null) {
        try {
          const t = db.select().from(generations).where(eq(generations.id, attachedTrackId)).get() as any;
          if (
            t &&
            t.type === "music" &&
            t.status === "done" &&
            (t.isPublic === 1 || t.isPublic === 2) &&
            !t.deletedAt &&
            t.resultUrl
          ) {
            let duration = 0;
            try {
              const data = JSON.parse(t.resultData || "{}");
              if (Array.isArray(data.result) && data.result[0]?.duration) {
                duration = Number(data.result[0].duration) || 0;
              }
            } catch {}
            attachedTrack = {
              id: Number(t.id),
              title: t.displayTitle || String(t.prompt || "").slice(0, 80) || "Без названия",
              authorName: t.authorName || null,
              audioUrl: `/api/stream/${t.id}`,
              coverUrl: `/api/cover/${t.id}.jpg`,
              durationSec: duration,
            };
          }
        } catch (e: any) {
          console.warn("[MUZA-CHAT attachedTrack]", e?.message || e);
        }
      }

      // Eugene 2026-05-21 Босс Chat-tool-calling MVP: attachedJob — генерация
      // юзера (music/lyrics/cover) которую LLM создал через chat-tool. Frontend
      // отрендерит inline-карточку с progress + опциональный audio player.
      // Только своя генерация (security guard); если уже done — включает audio_url.
      let attachedJob: {
        jobId: number;
        type: string;
        status: string;
        title: string;
        audioUrl: string | null;
        coverUrl: string | null;
        lyricsPreview: string | null;
        durationSec: number;
        errorReason: string | null;
      } | null = null;
      if (attachedJobId !== null && authUserId) {
        try {
          const j = db.select().from(generations).where(eq(generations.id, attachedJobId)).get() as any;
          if (j && j.userId === authUserId) {
            let coverUrl: string | null = null;
            let lyricsPreview: string | null = null;
            let durationSec = 0;
            if (j.type === "music" && j.status === "done") {
              try {
                const rd = JSON.parse(j.resultData || "{}");
                if (Array.isArray(rd.result) && rd.result[0]) {
                  coverUrl = rd.result[0].image_url || null;
                  if (rd.result[0].lyric) lyricsPreview = String(rd.result[0].lyric).slice(0, 200);
                  durationSec = Number(rd.result[0].duration || 0) || 0;
                }
              } catch {}
            }
            if (j.type === "lyrics" && j.status === "done") {
              lyricsPreview = String(j.resultUrl || "").slice(0, 200);
            }
            attachedJob = {
              jobId: Number(j.id),
              type: String(j.type),
              status: String(j.status),
              title: j.displayTitle || String(j.prompt || "").slice(0, 80) || "Без названия",
              audioUrl: j.type === "music" && j.status === "done" ? `/api/stream/${j.id}` : null,
              coverUrl: j.type === "music" && j.status === "done" ? `/api/cover/${j.id}.jpg` : coverUrl,
              lyricsPreview,
              durationSec,
              errorReason: j.status === "error" ? (j.errorReason || null) : null,
            };
          }
        } catch (e: any) {
          console.warn("[MUZA-CHAT attachedJob]", e?.message || e);
        }
      }

      // Сохраняем bot reply + обновляем lastMessageAt
      db.insert(chatbotMessages).values({
        sessionId: session.id,
        role: "bot",
        text: reply,
        attachedTrackId: attachedTrack ? attachedTrack.id : null,
      } as any).run();
      db.update(chatbotSessions)
        .set({ lastMessageAt: new Date().toISOString() })
        .where(eq(chatbotSessions.id, session.id))
        .run();

      // Re-extract memo с учётом нового user-message (для UI таблицы).
      const updatedMemo = extractMemoryFromHistory(loadSessionHistory(session.id, 30));

      // Eugene 2026-05-17 Босс «резервные каналы при downtime».
      // Когда LLM упал (usedFallback=true) — фронт показывает баннер с
      // альтернативными каналами связи. Берём только включённые.
      let backupChannels: Array<{ id: string; name: string; url: string; hint: string }> | undefined;
      if (usedFallback) {
        const bots: Array<{ id: string; name: string; url: string; hint: string }> = [];
        const tgUser = process.env.TELEGRAM_BOT_USERNAME || "Muziaipodari_bot";
        if (process.env.TELEGRAM_BOT_TOKEN) {
          bots.push({
            id: "telegram",
            name: "Telegram",
            url: `https://t.me/${tgUser}`,
            hint: `Напишите @${tgUser}`,
          });
        }
        if (process.env.MAX_BOT_TOKEN) {
          const maxLink = process.env.MAX_BOT_LINK || "https://max.ru";
          bots.push({
            id: "max",
            name: "Max",
            url: maxLink,
            hint: "Откройте чат в Max",
          });
        }
        if (bots.length > 0) backupChannels = bots;
      }

      // Eugene 2026-05-20 Босс User-memory-context rule: fire-and-forget
      // background compression если накопилось N сообщений. Никогда не блокирует
      // chat-flow — все ошибки swallowed внутри scheduleCompressionIfNeeded.
      if (authUserId) {
        scheduleCompressionIfNeeded(authUserId).catch(() => {});
      }

      res.json({
        ok: true,
        sessionId: session.id,
        reply,
        quickReplies,
        usedFallback,
        backupChannels,
        paired: pairedNow,
        pairedFromChannel: pairedNow ? session.channel : null,
        memo: updatedMemo,
        // Eugene 2026-05-18 Босс «чат → окно генерации»: если Муза вставила
        // [PROPOSE_GEN:...] маркер — отдаём фронту payload, по нему рендерится
        // карточка с 3 кнопками (Аудио / Простой / Полная).
        proposedGeneration,
        // Eugene 2026-05-18 Босс «Муза сохраняет тексты»: если Муза вставила
        // [PROPOSE_REGISTER:reason=X] — отдаём payload для inline-карточки
        // «Войти / Зарегистрироваться / Дать email».
        proposedRegistration,
        // Eugene 2026-05-20 Босс «мини-плеер в чате». attachedTrack — компактные
        // meta-данные публичного трека для inline ChatTrackCard. autoPlay=true
        // только для свежего ответа (на client-side при rendering — последнее
        // сообщение). Persistent audio singleton (lockscreen.ts) переключится
        // на этот трек, lock-screen ownership сохраняется.
        attachedTrack,
        // Eugene 2026-05-21 Босс Chat-tool-calling MVP: pendingApproval —
        // когда LLM вызвал платный tool без confirm_spend/confirm_publish.
        // Frontend рендерит approval-карточку «Стоит X ₽, подтвердить?» +
        // кнопки [Да] / [Отмена]. По «Да» — клиент шлёт ответное сообщение
        // (например «да, подтверждаю») и LLM повторяет tool с confirm_spend=true.
        pendingApproval,
        // attachedJob — генерация юзера (music/lyrics/cover) созданная через
        // chat-tool. Frontend рендерит карточку с polling статусом (для music
        // в processing) или сразу плеер если done.
        attachedJob,
      });
    } catch (e: any) {
      console.error("[MUZA-CHAT send]", e);
      res.status(500).json({ ok: false, error: String(e) });
    }
  });

  // GET /api/muza/chat/health — диагностика для админа: есть ли ключи Claude,
  // отвечает ли endpoint. Eugene 2026-05-14 Босс «агента чата завёл? +
  // заведи альтернативный ключ + админ-группа Ключи Ai» — показываем
  // chain (primary → backup → bot) с last-status каждого.
  app.get("/api/muza/chat/health", (_req: Request, res: Response) => {
    const attempts = listAnthropicKeys();
    const hasAny = attempts.length > 0;
    res.json({
      ok: true,
      hasAnthropicKey: hasAny,
      keyChain: attempts.map(a => {
        const st = llmKeyStatus.get(a.name);
        return {
          name: a.name,
          present: true,
          length: a.key.length,
          first8: a.key.slice(0, 8),
          lastUsedAt: st?.lastUsedAt || null,
          lastStatus: st?.lastStatus ?? null,
          lastErrorMsg: st?.lastErrorMsg || null,
        };
      }),
      mode: hasAny ? "live-claude" : "fallback-only",
      hint: hasAny
        ? `Цепочка ${attempts.length} ключ${attempts.length === 1 ? "" : "ей"} (primary → backup). Чат отвечает через Claude.`
        : "Ни один ключ Anthropic не задан — Муза отвечает шаблонными фразами. Добавьте ANTHROPIC_API_KEY на VPS.",
    });
  });

  // GET /api/admin/v304/ai-keys — admin-only список всех AI-ключей проекта
  // с маскированным prefix + last-status (если использовался). Eugene
  // 2026-05-14 Босс «в админе заведи группу ключи Ai».
  app.get("/api/admin/v304/ai-keys", requireAdmin, (_req: Request, res: Response) => {
    const peek = (envName: string) => {
      const v = process.env[envName];
      if (!v) return { present: false, length: 0, first8: "" };
      return { present: true, length: v.length, first8: v.slice(0, 8) };
    };
    const claudeChain = listAnthropicKeys().map(a => ({
      envName: a.name,
      length: a.key.length,
      first8: a.key.slice(0, 8),
      ...(llmKeyStatus.get(a.name) || {}),
    }));
    res.json({
      ok: true,
      checkedAt: new Date().toISOString(),
      groups: [
        {
          group: "🤖 Claude (Anthropic)",
          purpose: "Муза-чат + Telegram-бот + Max-бот",
          keys: claudeChain,
          chain: claudeChain.map(k => k.envName),
          tip: "Цепочка fallback: при 401/403/429 первого пробуется второй, потом третий.",
        },
        {
          group: "🎵 GPTunnel (Suno + GPT)",
          purpose: "Генерация музыки (Suno) + fallback LLM",
          keys: [{ envName: "GPTUNNEL_API_KEY", ...peek("GPTUNNEL_API_KEY") }],
        },
        {
          group: "🎤 Yandex SpeechKit",
          purpose: "STT голосового ввода + TTS",
          keys: [
            { envName: "YANDEX_SPEECHKIT_API_KEY", ...peek("YANDEX_SPEECHKIT_API_KEY") },
            { envName: "YANDEX_FOLDER_ID", ...peek("YANDEX_FOLDER_ID") },
          ],
        },
        {
          group: "💬 OpenAI",
          purpose: "Whisper STT fallback",
          keys: [{ envName: "OPENAI_API_KEY", ...peek("OPENAI_API_KEY") }],
        },
      ],
    });
  });

  // Eugene 2026-05-15 Босс «log list problem»: регистр неудачных действий
  // юзера во всех каналах (web/telegram/max/email/...). Группировка по
  // group_key (action::error_code) — сколько раз, кого, последний раз.
  app.get("/api/admin/v304/user-failures", requireAdmin, (req: Request, res: Response) => {
    const limit = Math.min(500, Math.max(10, Number(req.query.limit) || 200));
    const channel = req.query.channel ? String(req.query.channel) : null;
    const since = req.query.since ? String(req.query.since) : null;
    try {
      // Группировка
      const groupConditions: string[] = [];
      const groupParams: any[] = [];
      if (channel) { groupConditions.push("channel = ?"); groupParams.push(channel); }
      if (since) { groupConditions.push("created_at >= ?"); groupParams.push(since); }
      const where = groupConditions.length ? `WHERE ${groupConditions.join(" AND ")}` : "";
      const groups = db.all(sql.raw(`
        SELECT group_key, channel, action, error_code,
               COUNT(*) as count,
               MAX(created_at) as lastAt,
               MIN(created_at) as firstAt,
               COUNT(DISTINCT user_id) as uniqUsers,
               (SELECT error_message FROM user_action_failures u2 WHERE u2.group_key = u.group_key ORDER BY u2.id DESC LIMIT 1) as lastMessage
        FROM user_action_failures u
        ${where}
        GROUP BY group_key, channel, action, error_code
        ORDER BY count DESC, lastAt DESC
        LIMIT ${limit}
      `)) as any[];

      // Последние 50 raw entries
      const rawConditions: string[] = [];
      if (channel) rawConditions.push(`channel = '${String(channel).replace(/'/g, "")}'`);
      if (since) rawConditions.push(`created_at >= '${String(since).replace(/'/g, "")}'`);
      const rawWhere = rawConditions.length ? `WHERE ${rawConditions.join(" AND ")}` : "";
      const recent = db.all(sql.raw(`
        SELECT id, user_id as userId, channel, action, status_code as statusCode,
               error_code as errorCode, error_message as errorMessage, endpoint,
               group_key as groupKey, created_at as createdAt
        FROM user_action_failures
        ${rawWhere}
        ORDER BY id DESC
        LIMIT 50
      `)) as any[];

      res.json({ data: { groups, recent, generatedAt: new Date().toISOString() }, error: null });
    } catch (e: any) {
      res.status(500).json({ data: null, error: String(e?.message || e) });
    }
  });

  app.get("/api/admin/v304/user-failures/group/:key", requireAdmin, (req: Request, res: Response) => {
    const key = String(req.params.key || "");
    if (!key) return res.status(400).json({ ok: false, error: "group_key required" });
    try {
      const rows = db.select().from(userActionFailures)
        .where(eq(userActionFailures.groupKey, key))
        .orderBy(desc(userActionFailures.id))
        .limit(200)
        .all();
      res.json({ data: { groupKey: key, count: rows.length, items: rows }, error: null });
    } catch (e: any) {
      res.status(500).json({ data: null, error: String(e?.message || e) });
    }
  });

  // Eugene 2026-05-20 Босс через admin-support-audit subagent: «отметить
  // решено» для group_key — все записи группы становятся resolved.
  // Body: {note: string, olderThanIso?: string} — если olderThanIso задан,
  // резолвим только записи старше этой даты (полезно если хочешь не задеть
  // свежие повторения той же ошибки).
  app.post("/api/admin/v304/user-failures/group/:key/resolve", requireAdmin, (req: Request, res: Response) => {
    try {
      const key = String(req.params.key || "");
      if (!key) return res.status(400).json({ ok: false, error: "group_key required" });
      const note = String(req.body?.note || "").trim().slice(0, 500);
      if (!note) return res.status(400).json({ ok: false, error: "note required (что сделал)" });
      const olderThanIso = req.body?.olderThanIso ? String(req.body.olderThanIso) : null;
      const adminUserId = (req as any).userId ?? null;
      const nowMs = Date.now();
      const raw = (db as any).$client;
      let result: any;
      if (olderThanIso) {
        result = raw.prepare(`
          UPDATE user_action_failures
          SET resolved_at = ?, resolved_note = ?, resolved_by_user_id = ?
          WHERE group_key = ? AND resolved_at IS NULL AND created_at < ?
        `).run(nowMs, note, adminUserId, key, olderThanIso);
      } else {
        result = raw.prepare(`
          UPDATE user_action_failures
          SET resolved_at = ?, resolved_note = ?, resolved_by_user_id = ?
          WHERE group_key = ? AND resolved_at IS NULL
        `).run(nowMs, note, adminUserId, key);
      }
      const changes = Number(result?.changes ?? 0);
      // Audit-log
      try {
        raw.prepare(`
          INSERT INTO admin_audit_log (admin_user_id, action, entity, entity_key, before_json, after_json)
          VALUES (?, 'update', 'user_action_failures:group_resolve', ?, ?, ?)
        `).run(adminUserId, key, null, JSON.stringify({ note, changes, olderThanIso }));
      } catch {}
      res.json({ ok: true, groupKey: key, resolved: changes, note, resolvedAt: nowMs });
    } catch (e: any) {
      res.status(500).json({ ok: false, error: String(e?.message || e) });
    }
  });

  // Bulk-dismiss endpoint для эскалаций (admin-support-audit subagent reco):
  // одним запросом dismiss всех open эскалаций старше определённой даты.
  app.post("/api/admin/v304/escalations/bulk-dismiss", requireAdmin, (req: Request, res: Response) => {
    try {
      const olderThanIso = req.body?.olderThanIso ? String(req.body.olderThanIso) : null;
      const reason = String(req.body?.reason || "").trim().slice(0, 200) || "bulk-dismissed by admin";
      if (!olderThanIso) return res.status(400).json({ ok: false, error: "olderThanIso required" });
      const adminUserId = (req as any).userId ?? null;
      const nowMs = Date.now();
      const olderThanMs = (() => {
        try { return new Date(olderThanIso).getTime(); } catch { return 0; }
      })();
      if (!olderThanMs) return res.status(400).json({ ok: false, error: "invalid olderThanIso" });
      const raw = (db as any).$client;
      const result: any = raw.prepare(`
        UPDATE escalation_queue
        SET status = 'dismissed', dismiss_reason = ?, resolved_at = ?, assigned_to_user_id = ?
        WHERE status = 'open' AND created_at < ?
      `).run(reason, nowMs, adminUserId, olderThanMs);
      const changes = Number(result?.changes ?? 0);
      try {
        raw.prepare(`
          INSERT INTO admin_audit_log (admin_user_id, action, entity, entity_key, before_json, after_json)
          VALUES (?, 'update', 'escalation_queue:bulk_dismiss', ?, ?, ?)
        `).run(adminUserId, `older_than:${olderThanIso}`, null, JSON.stringify({ reason, dismissed: changes }));
      } catch {}
      res.json({ ok: true, dismissed: changes, reason, olderThanIso });
    } catch (e: any) {
      res.status(500).json({ ok: false, error: String(e?.message || e) });
    }
  });

  // Eugene 2026-05-15 Босс «Связывай»: сквозной view диалогов одного юзера
  // через все каналы (TG/Web/Max). Возвращает все его сессии + merged
  // messages timeline. Используется в admin UI.
  // Eugene 2026-05-15 Босс «2 плейлиста на главной + челофильтр».
  //
  // Админский перевод трека между плейлистами:
  // - status='main' → isPublic=1 (основной)
  // - status='new'  → isPublic=2 (новые авторы)
  // - status='private' → isPublic=0 (скрыть с главной)
  // Audit-log пишется автоматически.
  // Eugene 2026-05-15 Босс «подарочный трек не обнаружен» — backfill для
  // phone-юзеров которые зарегистрировались до фикса (welcome_gift_given=0
  // + countryCode из СНГ + общий лимит не превышен). Admin запустит один раз
  // после deploy.
  //
  // GET ?dry=1 → список кандидатов (без выдачи)
  // POST       → реальная выдача
  app.get("/api/admin/v304/backfill/welcome-gift", requireAdmin, (_req: Request, res: Response) => {
    try {
      const candidates = db.all<any>(sql`
        SELECT id, name, phone, email, country_code as countryCode, created_at
        FROM users
        WHERE welcome_gift_given = 0
          AND (deleted_at IS NULL)
          AND (blocked IS NULL OR blocked = 0)
        ORDER BY id ASC
      `);
      const giftedCount = db.get<{ c: number }>(sql`SELECT COUNT(*) as c FROM users WHERE welcome_gift_given = 1`);
      res.json({
        ok: true,
        dry: true,
        totalCandidates: candidates.length,
        alreadyGifted: giftedCount?.c || 0,
        limit: 1000,
        canGift: Math.max(0, 1000 - (giftedCount?.c || 0)),
        sample: candidates.slice(0, 10).map((c: any) => ({ id: c.id, name: c.name, phone: c.phone, countryCode: c.countryCode })),
      });
    } catch (e: any) {
      res.status(500).json({ ok: false, error: String(e?.message || e) });
    }
  });

  app.post("/api/admin/v304/backfill/welcome-gift", requireAdmin, async (_req: Request, res: Response) => {
    try {
      const { tryGiveWelcomeGift } = await import("./lib/welcomeGift");
      const candidates = db.all<any>(sql`
        SELECT id, country_code as countryCode FROM users
        WHERE welcome_gift_given = 0
          AND (deleted_at IS NULL)
          AND (blocked IS NULL OR blocked = 0)
        ORDER BY id ASC
      `);
      let gifted = 0;
      let skipped = 0;
      let limitReached = false;
      for (const c of candidates) {
        const r = tryGiveWelcomeGift({ userId: c.id, countryCode: c.countryCode });
        if (r.gifted) gifted++;
        else {
          skipped++;
          if (r.reason === "limit-reached") { limitReached = true; break; }
        }
      }
      res.json({ ok: true, totalCandidates: candidates.length, gifted, skipped, limitReached });
    } catch (e: any) {
      res.status(500).json({ ok: false, error: String(e?.message || e) });
    }
  });

  // Eugene 2026-05-15 Босс «перепрошить ID3-tag старых треков на MuzaAi.ru,
  // но ранее созданные ссылки должны работать на 100%».
  //
  // Что делает:
  //  - SELECT music-треков с status='done' AND created_at < '2026-05-15 23:59:59'
  //  - Для каждого читает local mp3 → переписывает ID3-tag (album, artist
  //    с MuziAi → MuzaAi) → сохраняет (mtime обновится, файл валиден)
  //  - Ссылки /share/:id, /play/:id, /api/stream/:id НЕ меняются — они
  //    идут на тот же gen.id. Старые share-link продолжают работать через
  //    301 redirect muziai → muzaai на nginx.
  //  - НЕ трогает: gen.userId, gen.id, gen.localPath, БД, audio content
  //
  // GET ?dry=1 — список кандидатов (id, title, album-current)
  // POST       — реальная перепрошивка
  app.get("/api/admin/v304/backfill/id3-rebrand", requireAdmin, (_req: Request, res: Response) => {
    try {
      const cutoff = "2026-05-15 23:59:59"; // треки до 15.05.2026 включительно
      const rows = db.all<any>(sql`
        SELECT id, display_title, local_path, created_at FROM generations
        WHERE type = 'music' AND status = 'done' AND local_path IS NOT NULL
          AND created_at < ${cutoff}
        ORDER BY id DESC
        LIMIT 1000
      `);
      res.json({
        ok: true,
        dry: true,
        cutoff,
        totalCandidates: rows.length,
        sample: rows.slice(0, 5).map((r: any) => ({ id: r.id, title: r.display_title, localPath: r.local_path?.slice(0, 60) })),
      });
    } catch (e: any) {
      res.status(500).json({ ok: false, error: String(e?.message || e) });
    }
  });

  app.post("/api/admin/v304/backfill/id3-rebrand", requireAdmin, async (_req: Request, res: Response) => {
    try {
      const cutoff = "2026-05-15 23:59:59";
      const rows = db.all<any>(sql`
        SELECT id, display_title, local_path, author_name FROM generations
        WHERE type = 'music' AND status = 'done' AND local_path IS NOT NULL
          AND created_at < ${cutoff}
        ORDER BY id DESC
        LIMIT 1000
      `);
      const authorsDir = (process.env.AUTHORS_DIR || "/var/www/neurohub/authors").replace(/\/$/, "");
      let updated = 0;
      let skipped = 0;
      const errors: Array<{ id: number; error: string }> = [];

      for (const r of rows) {
        try {
          const mp3Path = `${authorsDir}/${r.local_path}`;
          if (!fs.existsSync(mp3Path)) { skipped++; continue; }
          const existing = NodeID3.read(mp3Path) || {};
          const tags: any = {
            title: r.display_title || existing.title || "MuzaAi Track",
            artist: r.author_name ? `MuzaAi · ${r.author_name}` : "MuzaAi",
            album: "MuzaAi.ru",
            comment: { language: "rus", text: PUBLIC_URL },
          };
          // Сохраняем существующую обложку если она была в ID3
          if ((existing as any).image) tags.image = (existing as any).image;
          NodeID3.update(tags, mp3Path);
          updated++;
        } catch (e: any) {
          errors.push({ id: r.id, error: String(e?.message || e).slice(0, 200) });
        }
      }
      res.json({
        ok: true,
        totalCandidates: rows.length,
        updated,
        skipped,
        errors: errors.slice(0, 10),
      });
    } catch (e: any) {
      console.error("[backfill/id3-rebrand]", e);
      res.status(500).json({ ok: false, error: String(e?.message || e) });
    }
  });

  // Eugene 2026-05-17 Босс «iOS lock-screen logo вместо обложки трека —
  // реши кардинально». Backfill переписывает APIC frame в ALL existing
  // mp3 файлах: подбирает реальный cover из gen_<id>.jpg (либо из
  // coverGenId.localPath), уменьшает до 512×512, встраивает в mp3.
  //
  // Параметры query (опциональны):
  //   ?limit=N        — обработать не больше N треков (default 500)
  //   ?since=<iso>    — только треки созданные после ISO-даты
  //   ?genId=<id>     — точечно один трек (для отладки)
  //   ?dryRun=1       — не писать, только показать что было бы
  //   ?force=1        — переписать ВСЕ существующие APIC (default
  //                     keepExistingImage=false уже это делает)
  //
  // Body: { genIds?: number[] } — альтернативно список конкретных треков
  //
  // Возвращает: { ok, totalCandidates, updated, skipped, embedded,
  //               coverSources: {argument,sibling-jpg,kept-existing,none},
  //               errors: [{id, error}], firstSamples: [...] }
  app.post("/api/admin/v304/id3-rebuild", requireAdmin, async (req: Request, res: Response) => {
    try {
      const limit = Math.min(2000, Math.max(1, Number(req.query.limit) || 500));
      const since = String(req.query.since || "").trim();
      const oneGenId = Number(req.query.genId);
      const dryRun = req.query.dryRun === "1" || req.query.dryRun === "true";
      const explicitIds = Array.isArray((req.body as any)?.genIds)
        ? ((req.body as any).genIds as unknown[])
            .map((x) => Number(x))
            .filter((x) => Number.isFinite(x))
        : null;

      const filters: any[] = [
        sql`type = 'music'`,
        sql`status = 'done'`,
        sql`local_path IS NOT NULL`,
      ];
      if (Number.isFinite(oneGenId)) {
        filters.push(sql`id = ${oneGenId}`);
      } else if (explicitIds && explicitIds.length) {
        const idsCsv = explicitIds.join(",");
        filters.push(sql.raw(`id IN (${idsCsv})`));
      } else if (since) {
        filters.push(sql`created_at >= ${since}`);
      }
      const whereSql = filters.reduce((acc, f, i) => (i === 0 ? sql`${f}` : sql`${acc} AND ${f}`));

      const rows = db.all<any>(sql`
        SELECT id, display_title, prompt, local_path, author_name, cover_gen_id
        FROM generations
        WHERE ${whereSql}
        ORDER BY id DESC
        LIMIT ${limit}
      `);

      const authorsDir = AUTHORS_DIR.replace(/\/$/, "");
      let updated = 0;
      let skipped = 0;
      let embedded = 0;
      const coverSources: Record<string, number> = {
        argument: 0,
        "sibling-jpg": 0,
        "kept-existing": 0,
        none: 0,
      };
      const errors: Array<{ id: number; error: string }> = [];
      const firstSamples: Array<{
        id: number;
        title: string | null;
        coverSource: string;
        imageBytes?: number;
        ok: boolean;
      }> = [];

      for (const r of rows) {
        try {
          const mp3Path = `${authorsDir}/${r.local_path}`;
          if (!fs.existsSync(mp3Path)) {
            skipped++;
            continue;
          }
          // Resolve override cover from coverGenId if set
          let overrideCover: string | null = null;
          if (r.cover_gen_id) {
            const coverRow = db.all<any>(sql`
              SELECT local_path FROM generations WHERE id = ${r.cover_gen_id} LIMIT 1
            `)[0];
            if (coverRow?.local_path) {
              const cp = `${authorsDir}/${coverRow.local_path}`;
              if (fs.existsSync(cp)) overrideCover = cp;
            }
          }

          if (dryRun) {
            const sibling = findSiblingCover(mp3Path);
            const src = overrideCover ? "argument" : sibling ? "sibling-jpg" : "none";
            coverSources[src] = (coverSources[src] || 0) + 1;
            if (firstSamples.length < 10) {
              firstSamples.push({
                id: r.id,
                title: r.display_title,
                coverSource: src,
                ok: true,
              });
            }
            continue;
          }

          const titleFallback =
            r.display_title || (r.prompt ? String(r.prompt).slice(0, 80) : null);
          const id3Res = await embedTrackId3({
            mp3Path,
            title: titleFallback,
            authorName: r.author_name,
            coverPath: overrideCover,
            keepExistingImage: false,
          });

          if (id3Res.ok) {
            updated++;
            if (id3Res.imageEmbedded) embedded++;
            coverSources[id3Res.coverSource] = (coverSources[id3Res.coverSource] || 0) + 1;
            if (firstSamples.length < 10) {
              firstSamples.push({
                id: r.id,
                title: r.display_title,
                coverSource: id3Res.coverSource,
                imageBytes: id3Res.imageBytes,
                ok: true,
              });
            }
          } else {
            errors.push({ id: r.id, error: id3Res.error || "unknown" });
          }
        } catch (e: any) {
          errors.push({ id: r.id, error: String(e?.message || e).slice(0, 200) });
        }
      }

      res.json({
        ok: true,
        dryRun,
        totalCandidates: rows.length,
        updated,
        skipped,
        embedded,
        coverSources,
        errors: errors.slice(0, 20),
        firstSamples,
      });
    } catch (e: any) {
      console.error("[id3-rebuild]", e);
      res.status(500).json({ ok: false, error: String(e?.message || e) });
    }
  });

  app.post("/api/admin/v304/generations/:id/playlist", requireAdmin, (req: Request, res: Response) => {
    const genId = Number(req.params.id);
    const status = String(req.body?.status || "");
    const map: Record<string, number> = { main: 1, new: 2, private: 0 };
    if (!Number.isFinite(genId) || !(status in map)) {
      return res.status(400).json({ ok: false, error: "id+status required (status: main|new|private)" });
    }
    const gen = db.select().from(generations).where(eq(generations.id, genId)).get() as any;
    if (!gen) return res.status(404).json({ ok: false, error: "generation not found" });
    const before = { isPublic: gen.isPublic, publishedAt: gen.publishedAt };
    const newIsPublic = map[status];
    // Eugene 2026-05-17 Босс «публикация = отдельное событие». Set publishedAt
    // только при ПЕРВОМ переходе из приватного (0) в публичный (>=1).
    // Последующие main↔new — не трогаем (первая публикация запоминается).
    // При unpublish (->0) — НЕ trim'аем (на случай re-publish увидим прошлую дату).
    const shouldSetPublishedAt = (gen.isPublic === 0) && (newIsPublic >= 1) && !gen.publishedAt;
    const updatePatch: any = { isPublic: newIsPublic };
    if (shouldSetPublishedAt) updatePatch.publishedAt = new Date().toISOString();
    db.update(generations).set(updatePatch).where(eq(generations.id, genId)).run();
    // Audit-log: enriched через recordAuditEntry (захватывает ip + user_agent).
    recordAuditEntry({
      req,
      action: "update",
      entity: "generation_playlist",
      entityKey: String(genId),
      before,
      after: { isPublic: newIsPublic, requestedStatus: status, publishedAt: updatePatch.publishedAt ?? gen.publishedAt },
    });
    res.json({ ok: true, id: genId, status, isPublic: newIsPublic, publishedAt: updatePatch.publishedAt ?? gen.publishedAt });
  });

  // Кандидаты на перевод в основной плейлист — треки isPublic=2 (Новые
  // авторы) с количеством play за последние 24ч. Sort DESC.
  // Hot = >50 play/24ч (по правилу Босса auto-suggest).
  app.get("/api/admin/v304/playlist-candidates", requireAdmin, (_req: Request, res: Response) => {
    try {
      const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
      const rows = db.all<any>(sql`
        SELECT g.id, g.display_title as displayTitle, g.prompt, g.user_id as userId,
               g.created_at as createdAt, g.published_at as publishedAt, g.type, g.author_name as authorName,
               (SELECT COUNT(*) FROM gen_activity ga WHERE ga.gen_id = g.id AND ga.action = 'play' AND ga.created_at >= ${since}) as plays24h,
               (SELECT COUNT(*) FROM gen_activity ga WHERE ga.gen_id = g.id AND ga.action = 'play') as playsTotal
        FROM generations g
        WHERE g.is_public = 2 AND g.status = 'done' AND g.deleted_at IS NULL
        ORDER BY plays24h DESC, g.id DESC
        LIMIT 100
      `);
      const candidates = rows.map((r: any) => ({
        ...r,
        hot: r.plays24h > 50,
      }));
      const hotCount = candidates.filter((c: any) => c.hot).length;
      res.json({ ok: true, total: rows.length, hotCount, threshold24h: 50, candidates });
    } catch (e: any) {
      res.status(500).json({ ok: false, error: String(e?.message || e) });
    }
  });

  // ==================== BLOCKED ENTITIES — admin endpoints ====================
  // Eugene 2026-05-18 Босс «ручная блокировка по IP / userId / country / UA».
  //
  // GET    /api/admin/v304/blocks?type=&active=&limit=&offset=
  // POST   /api/admin/v304/blocks  body: { type, value, reason?, expiresInDays? }
  // DELETE /api/admin/v304/blocks/:id  — soft-unblock (active=0, audit-log)
  // GET    /api/admin/v304/blocks/suspicious  — топ-N кандидатов на блок

  const BlockCreateSchema = z.object({
    type: z.enum(["ip", "user", "country", "ua_substring"]),
    value: z.string().min(1).max(200),
    reason: z.string().max(500).optional().nullable(),
    expiresInDays: z.number().int().min(1).max(365).optional().nullable(),
  });

  app.get("/api/admin/v304/blocks", requireAdmin, (req: Request, res: Response) => {
    try {
      const typeRaw = String(req.query.type || "").trim();
      const allowedTypes: BlockType[] = ["ip", "user", "country", "ua_substring"];
      const type = (allowedTypes as string[]).includes(typeRaw) ? (typeRaw as BlockType) : undefined;
      const activeRaw = String(req.query.active || "").trim().toLowerCase();
      const active = activeRaw === "1" || activeRaw === "true"
        ? true
        : activeRaw === "0" || activeRaw === "false"
        ? false
        : undefined;
      const limit = Math.min(500, Math.max(1, Number(req.query.limit) || 200));
      const offset = Math.max(0, Number(req.query.offset) || 0);
      const rows = listBlocked({ type, active, limit, offset });
      res.json({ data: { total: rows.length, blocks: rows }, error: null });
    } catch (e: any) {
      res.status(500).json({ data: null, error: String(e?.message || e) });
    }
  });

  app.post("/api/admin/v304/blocks", requireAdmin, (req: Request, res: Response) => {
    try {
      const parsed = BlockCreateSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ data: null, error: parsed.error.errors[0]?.message || "Validation error" });
        return;
      }
      const { type, value, reason, expiresInDays } = parsed.data;
      const expiresAt = expiresInDays ? Date.now() + expiresInDays * 24 * 60 * 60 * 1000 : null;
      const blockedBy = (req as any).userId ?? null;
      const result = blockEntity({ type, value: String(value).trim(), reason: reason ?? null, blockedBy, expiresAt });

      recordAuditEntry({
        req,
        action: result.alreadyActive ? "update" : "create",
        entity: "blocked_entity",
        entityKey: `${type}:${value}`,
        before: result.alreadyActive ? { active: 1 } : null,
        after: { id: result.id, type, value, reason: reason ?? null, expiresAt, blockedBy },
      });
      res.json({ data: { id: result.id, alreadyActive: !!result.alreadyActive, type, value, expiresAt }, error: null });
    } catch (e: any) {
      res.status(500).json({ data: null, error: String(e?.message || e) });
    }
  });

  app.delete("/api/admin/v304/blocks/:id", requireAdmin, (req: Request, res: Response) => {
    try {
      const id = parseInt(req.params.id, 10);
      if (!Number.isFinite(id) || id <= 0) {
        res.status(400).json({ data: null, error: "Invalid id" });
        return;
      }
      const r = unblockEntity(id);
      if (!r.ok) {
        res.status(404).json({ data: null, error: "Not found" });
        return;
      }
      recordAuditEntry({
        req,
        action: "update",
        entity: "blocked_entity",
        entityKey: String(id),
        before: r.before ? { active: r.before.active, type: r.before.type, value: r.before.value } : null,
        after: { active: 0 },
      });
      res.json({ data: { id, unblocked: true }, error: null });
    } catch (e: any) {
      res.status(500).json({ data: null, error: String(e?.message || e) });
    }
  });

  app.get("/api/admin/v304/blocks/suspicious", requireAdmin, (req: Request, res: Response) => {
    try {
      const hoursRaw = Number(req.query.hours);
      const hours = Number.isFinite(hoursRaw) && hoursRaw > 0 ? Math.min(168, hoursRaw) : 24;
      const sinceMs = hours * 60 * 60 * 1000;
      const candidates = suspiciousCandidates(sinceMs);
      res.json({
        data: {
          windowHours: hours,
          total: candidates.length,
          candidates,
        },
        error: null,
      });
    } catch (e: any) {
      res.status(500).json({ data: null, error: String(e?.message || e) });
    }
  });

  // ==================== USER JOURNEY — admin endpoints ====================
  // Eugene 2026-05-17 Босс «карта пути юзера + voronka».
  //
  // GET /api/admin/v304/journey-summary?since=ISO — топ-страницы, среднее
  //   время на странице, exit-pages, conversion funnel landing → register-phone.
  // GET /api/admin/v304/journey/sessions?limit=&since= — список последних
  //   N сессий с метаданными (events, duration, exit, conversion).
  // GET /api/admin/v304/journey/:sessionKey — все события одной сессии
  //   упорядочены по timestamp (timeline).

  app.get("/api/admin/v304/journey-summary", requireAdmin, (req: Request, res: Response) => {
    try {
      const sinceParam = String(req.query.since || "");
      const since = sinceParam || new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
      // Топ-страницы по page_view.
      const topPages = db.all<any>(sql`
        SELECT page, COUNT(*) as views,
               COUNT(DISTINCT session_key) as uniqSessions
        FROM user_journey_events
        WHERE event_type = 'page_view' AND created_at >= ${since}
        GROUP BY page
        ORDER BY views DESC
        LIMIT 30
      `);
      // Exit-pages: последняя page для каждой session_key (через subquery).
      const exitPages = db.all<any>(sql`
        SELECT page, COUNT(*) as exits
        FROM (
          SELECT session_key,
                 (SELECT page FROM user_journey_events e2
                  WHERE e2.session_key = e1.session_key AND e2.created_at >= ${since}
                  ORDER BY e2.created_at DESC LIMIT 1) as page
          FROM user_journey_events e1
          WHERE e1.created_at >= ${since}
          GROUP BY session_key
        )
        GROUP BY page
        ORDER BY exits DESC
        LIMIT 20
      `);
      // Conversion funnel: landing → register-phone → form_focus → form submit.
      // form submit = form_focus без последующего form_abandon на той же сессии.
      const funnelLanding = db.all<any>(sql`
        SELECT COUNT(DISTINCT session_key) as c
        FROM user_journey_events
        WHERE event_type = 'page_view' AND page = '/' AND created_at >= ${since}
      `)[0]?.c || 0;
      const funnelRegister = db.all<any>(sql`
        SELECT COUNT(DISTINCT session_key) as c
        FROM user_journey_events
        WHERE event_type = 'page_view' AND page = '/register-phone' AND created_at >= ${since}
      `)[0]?.c || 0;
      const funnelFormFocus = db.all<any>(sql`
        SELECT COUNT(DISTINCT session_key) as c
        FROM user_journey_events
        WHERE event_type = 'form_focus' AND page = '/register-phone' AND created_at >= ${since}
      `)[0]?.c || 0;
      const funnelAbandon = db.all<any>(sql`
        SELECT COUNT(DISTINCT session_key) as c
        FROM user_journey_events
        WHERE event_type = 'form_abandon' AND page = '/register-phone' AND created_at >= ${since}
      `)[0]?.c || 0;

      // Среднее время на странице — разница между page_view и следующим page_view
      // у той же сессии. Грубая оценка через MIN/MAX (без window-функций SQLite
      // оставляет это упрощённым — улучшим позже когда понадобится).
      const avgSessionDuration = db.all<any>(sql`
        SELECT AVG(dur) as avgMs FROM (
          SELECT session_key,
                 (julianday(MAX(created_at)) - julianday(MIN(created_at))) * 86400 * 1000 as dur
          FROM user_journey_events
          WHERE created_at >= ${since}
          GROUP BY session_key
          HAVING COUNT(*) > 1
        )
      `)[0]?.avgMs || 0;

      // Smart Муза-триггеры за период.
      const idleFires = db.all<any>(sql`
        SELECT page, COUNT(*) as c FROM user_journey_events
        WHERE event_type = 'idle_30s' AND created_at >= ${since}
        GROUP BY page ORDER BY c DESC LIMIT 10
      `);
      const formAbandons = db.all<any>(sql`
        SELECT page, COUNT(*) as c FROM user_journey_events
        WHERE event_type = 'form_abandon' AND created_at >= ${since}
        GROUP BY page ORDER BY c DESC LIMIT 10
      `);

      const totalEvents = db.all<any>(sql`
        SELECT COUNT(*) as c FROM user_journey_events WHERE created_at >= ${since}
      `)[0]?.c || 0;
      const totalSessions = db.all<any>(sql`
        SELECT COUNT(DISTINCT session_key) as c FROM user_journey_events WHERE created_at >= ${since}
      `)[0]?.c || 0;

      res.json({
        data: {
          since,
          totals: {
            events: totalEvents,
            sessions: totalSessions,
            avgSessionMs: Math.round(Number(avgSessionDuration) || 0),
          },
          topPages,
          exitPages,
          funnel: {
            landing: Number(funnelLanding) || 0,
            register_page: Number(funnelRegister) || 0,
            form_focus: Number(funnelFormFocus) || 0,
            form_abandon: Number(funnelAbandon) || 0,
          },
          smart: {
            idleFires,
            formAbandons,
          },
        },
        error: null,
      });
    } catch (e: any) {
      res.status(500).json({ data: null, error: String(e?.message || e) });
    }
  });

  app.get("/api/admin/v304/journey/sessions", requireAdmin, (req: Request, res: Response) => {
    try {
      const limit = Math.min(200, Math.max(10, Number(req.query.limit) || 50));
      const sinceParam = String(req.query.since || "");
      const since = sinceParam || new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
      // Группировка по session_key с агрегатами.
      const rows = db.all<any>(sql`
        SELECT
          session_key as sessionKey,
          MAX(user_id) as userId,
          COUNT(*) as eventCount,
          MIN(created_at) as startedAt,
          MAX(created_at) as endedAt,
          (julianday(MAX(created_at)) - julianday(MIN(created_at))) * 86400 * 1000 as durationMs,
          (SELECT page FROM user_journey_events e2
           WHERE e2.session_key = e1.session_key
           ORDER BY e2.created_at DESC LIMIT 1) as exitPage,
          (SELECT page FROM user_journey_events e2
           WHERE e2.session_key = e1.session_key
           ORDER BY e2.created_at ASC LIMIT 1) as entryPage,
          (SELECT COUNT(*) FROM user_journey_events e2
           WHERE e2.session_key = e1.session_key AND e2.event_type = 'page_view') as pageViews,
          (SELECT COUNT(*) FROM user_journey_events e2
           WHERE e2.session_key = e1.session_key AND e2.event_type = 'idle_30s') as idleCount,
          (SELECT COUNT(*) FROM user_journey_events e2
           WHERE e2.session_key = e1.session_key AND e2.event_type = 'form_abandon') as abandonCount
        FROM user_journey_events e1
        WHERE created_at >= ${since}
        GROUP BY session_key
        ORDER BY endedAt DESC
        LIMIT ${limit}
      `);
      // Конверсия для каждой сессии — попала на /register-phone и form_focus?
      const sessions = rows.map((r: any) => {
        const converted = r.pageViews >= 2 && Number(r.idleCount || 0) === 0;
        const bounced = Number(r.pageViews || 0) <= 1 && Number(r.durationMs || 0) < 10_000;
        return {
          sessionKey: r.sessionKey,
          userId: r.userId,
          eventCount: r.eventCount,
          pageViews: r.pageViews,
          startedAt: r.startedAt,
          endedAt: r.endedAt,
          durationMs: Math.round(Number(r.durationMs) || 0),
          entryPage: r.entryPage,
          exitPage: r.exitPage,
          idleCount: r.idleCount,
          abandonCount: r.abandonCount,
          converted,
          bounced,
        };
      });
      res.json({ data: { since, count: sessions.length, sessions }, error: null });
    } catch (e: any) {
      res.status(500).json({ data: null, error: String(e?.message || e) });
    }
  });

  // Timeline одной сессии — все события упорядочены по timestamp.
  app.get("/api/admin/v304/journey/:sessionKey", requireAdmin, (req: Request, res: Response) => {
    try {
      const sk = String(req.params.sessionKey || "").trim().slice(0, 64);
      if (!sk) return res.status(400).json({ data: null, error: "sessionKey required" });
      const rows = db.all<any>(sql`
        SELECT id, event_type as eventType, page, meta, user_id as userId, created_at as createdAt
        FROM user_journey_events
        WHERE session_key = ${sk}
        ORDER BY created_at ASC, id ASC
        LIMIT 5000
      `);
      const events = rows.map((r: any) => {
        let metaParsed: any = null;
        if (r.meta) { try { metaParsed = JSON.parse(r.meta); } catch {} }
        return { ...r, meta: metaParsed };
      });
      res.json({ data: { sessionKey: sk, count: events.length, events }, error: null });
    } catch (e: any) {
      res.status(500).json({ data: null, error: String(e?.message || e) });
    }
  });

  // Eugene 2026-05-15 Босс «строку поиска по всей панели — типа Google
  // по проекту». Глобальный search для admin-v304: users (name/email/phone)
  // + generations (display_title/prompt). Tabs ищутся client-side из
  // статического каталога (admin-search.tsx).
  app.get("/api/admin/v304/search", requireAdmin, (req: Request, res: Response) => {
    const q = String(req.query.q || "").trim();
    if (!q || q.length < 2) {
      return res.json({ ok: true, users: [], gens: [] });
    }
    const like = `%${q.replace(/[%_]/g, "\\$&")}%`;
    try {
      const userRows = db.select({
        id: users.id,
        name: users.name,
        email: users.email,
        phone: users.phone,
      }).from(users)
        .where(sql`${users.name} LIKE ${like} OR ${users.email} LIKE ${like} OR ${users.phone} LIKE ${like} ESCAPE '\\'`)
        .limit(10).all() as any[];
      const genRows = db.select({
        id: generations.id,
        displayTitle: generations.displayTitle,
        prompt: generations.prompt,
        type: generations.type,
        status: generations.status,
      }).from(generations)
        .where(sql`${generations.displayTitle} LIKE ${like} OR ${generations.prompt} LIKE ${like} ESCAPE '\\'`)
        .limit(10).all() as any[];
      res.json({ ok: true, users: userRows, gens: genRows });
    } catch (e: any) {
      res.status(500).json({ ok: false, error: String(e?.message || e) });
    }
  });

  // Eugene 2026-05-15 Босс «провайдер РФ — вести logs в admin panel».
  // SMS-логи: каждый запрос к SMS.ru/SMSC/SMSAero с маскированным номером,
  // статусом, ценой, error-message. Без plain OTP-кода (PII).
  app.get("/api/admin/v304/sms-logs", requireAdmin, (req: Request, res: Response) => {
    const limit = Math.min(500, Math.max(10, Number(req.query.limit) || 100));
    const status = req.query.status ? String(req.query.status) : null;
    const purpose = req.query.purpose ? String(req.query.purpose) : null;
    let q = db.select().from(smsProviderLogs).$dynamic();
    const conds: any[] = [];
    if (status) conds.push(eq(smsProviderLogs.status, status));
    if (purpose) conds.push(eq(smsProviderLogs.purpose, purpose));
    if (conds.length) q = q.where(and(...conds));
    const rows = q.orderBy(desc(smsProviderLogs.id)).limit(limit).all() as any[];
    // Сводка за 24ч.
    const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    const summary24h = db.select({
      status: smsProviderLogs.status,
      count: sql<number>`count(*)`,
    }).from(smsProviderLogs).where(sql`${smsProviderLogs.createdAt} >= ${since}`)
      .groupBy(smsProviderLogs.status).all() as any[];
    res.json({
      ok: true,
      total: rows.length,
      logs: rows,
      summary24h,
    });
  });

  // Eugene 2026-05-20 Босс «надо почту подключить». Admin endpoints для
  // диагностики и тестовой отправки email (Gmail + custom SMTP).
  app.get("/api/admin/v304/email/status", requireAdmin, async (_req: Request, res: Response) => {
    try {
      const { getEmailStatus } = await import("./lib/emailSender");
      const status = getEmailStatus();
      res.json({ ok: true, ...status });
    } catch (e: any) {
      res.status(500).json({ ok: false, error: String(e?.message || e) });
    }
  });

  app.post("/api/admin/v304/email/test", requireAdmin, async (req: Request, res: Response) => {
    try {
      const { sendEmail } = await import("./lib/emailSender");
      const to = String(req.body?.to || "").trim();
      const subject = String(req.body?.subject || "MuzaAi email test").trim();
      const text = String(req.body?.text || "Это тестовое письмо от MuzaAi admin panel. Если ты получил его — SMTP настроен правильно.").trim();
      if (!to || !to.includes("@")) {
        return res.status(400).json({ ok: false, error: "invalid 'to' email" });
      }
      const r = await sendEmail({ to, subject, text, kind: "transactional" });
      res.json(r);
    } catch (e: any) {
      res.status(500).json({ ok: false, error: String(e?.message || e) });
    }
  });

  // Eugene 2026-05-17 Босс «архив и текущие диалоги бота по любому каналу».
  // Список chatbot-сессий с фильтрами channel/status/q + pagination.
  // - channel: 'all' | 'web' | 'telegram' | 'max'
  // - status:  'all' | 'active' (last_message_at within last 24h) | 'archive'
  // - q:       подстрока поиска (userId, externalId, имя/email юзера, JSON
  //            userProfile)
  // Сортировка: last_message_at DESC. Возвращает превью userMessage (первые
  // 100 символов последнего user-сообщения), messageCount, isActive флаг.
  // Sensitive поля (phone, email full, tokens) НЕ возвращаются.
  app.get("/api/admin/v304/conversations", requireAdmin, (req: Request, res: Response) => {
    try {
      const channelRaw = String((req.query.channel || "all")).toLowerCase();
      const statusRaw = String((req.query.status || "all")).toLowerCase();
      const q = String(req.query.q || "").trim();
      const limit = Math.min(200, Math.max(1, Number(req.query.limit) || 50));
      const offset = Math.max(0, Number(req.query.offset) || 0);

      const allowedChannels = new Set(["all", "web", "telegram", "max"]);
      const channel = allowedChannels.has(channelRaw) ? channelRaw : "all";
      const allowedStatus = new Set(["all", "active", "archive"]);
      const status = allowedStatus.has(statusRaw) ? statusRaw : "all";

      // 24h cutoff для active/archive фильтра.
      const cutoffIso = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();

      // Drizzle `sql` template literal — все user-inputs параметризируются.
      // Собираем WHERE-условия как sql-фрагменты, потом join'им через AND.
      const conds: any[] = [];
      if (channel !== "all") conds.push(sql`s.channel = ${channel}`);
      if (status === "active") conds.push(sql`s.last_message_at >= ${cutoffIso}`);
      else if (status === "archive") conds.push(sql`(s.last_message_at IS NULL OR s.last_message_at < ${cutoffIso})`);
      if (q) {
        // ESCAPE '\\' защищает %/_ внутри пользовательского запроса.
        const like = `%${q.replace(/[\\%_]/g, "\\$&")}%`;
        const asNumber = Number(q);
        if (Number.isFinite(asNumber) && asNumber > 0) {
          conds.push(sql`(s.external_id LIKE ${like} ESCAPE '\\' OR s.user_id = ${asNumber} OR s.user_profile LIKE ${like} ESCAPE '\\' OR u.name LIKE ${like} ESCAPE '\\' OR u.email LIKE ${like} ESCAPE '\\')`);
        } else {
          conds.push(sql`(s.external_id LIKE ${like} ESCAPE '\\' OR s.user_profile LIKE ${like} ESCAPE '\\' OR u.name LIKE ${like} ESCAPE '\\' OR u.email LIKE ${like} ESCAPE '\\')`);
        }
      }
      // Глуем WHERE-блок (sql.empty если фильтров нет).
      let whereSql: any = sql.empty();
      if (conds.length > 0) {
        whereSql = sql`WHERE `;
        for (let i = 0; i < conds.length; i++) {
          whereSql = i === 0 ? sql`${whereSql}${conds[i]}` : sql`${whereSql} AND ${conds[i]}`;
        }
      }

      // Total — отдельный COUNT(*) запрос (пагинация).
      const totalRow = db.get<{ c: number }>(sql`
        SELECT COUNT(*) as c
        FROM chatbot_sessions s
        LEFT JOIN users u ON u.id = s.user_id
        ${whereSql}
      `);
      const total = Number(totalRow?.c || 0);

      // Page (limit/offset валидированы в Number() выше — безопасно интерполировать).
      const rows = db.all<any>(sql`
        SELECT
          s.id as id,
          s.channel as channel,
          s.external_id as externalId,
          s.user_id as userId,
          s.user_profile as userProfile,
          s.persona_name as personaName,
          s.started_at as startedAt,
          s.last_message_at as lastMessageAt,
          u.name as userName,
          u.email as userEmail,
          (SELECT COUNT(*) FROM chatbot_messages m WHERE m.session_id = s.id) as messageCount,
          (SELECT text FROM chatbot_messages m WHERE m.session_id = s.id AND m.role = 'user' ORDER BY m.id DESC LIMIT 1) as lastUserMessage,
          (SELECT text FROM chatbot_messages m WHERE m.session_id = s.id ORDER BY m.id DESC LIMIT 1) as lastMessage,
          (SELECT role FROM chatbot_messages m WHERE m.session_id = s.id ORDER BY m.id DESC LIMIT 1) as lastMessageRole
        FROM chatbot_sessions s
        LEFT JOIN users u ON u.id = s.user_id
        ${whereSql}
        ORDER BY (s.last_message_at IS NULL), s.last_message_at DESC
        LIMIT ${limit} OFFSET ${offset}
      `);

      const sessions = rows.map((r) => {
        // Не утечь sensitive поля из userProfile JSON (phone/email full).
        let safeProfile: any = null;
        if (r.userProfile) {
          try {
            const parsed = JSON.parse(String(r.userProfile));
            if (parsed && typeof parsed === "object") {
              const { phone, phoneNumber, email, password, ...rest } = parsed;
              safeProfile = rest;
            }
          } catch {}
        }
        const preview = String(r.lastUserMessage || r.lastMessage || "").slice(0, 100);
        const isActive = r.lastMessageAt ? (r.lastMessageAt >= cutoffIso) : false;
        // Маска email для списка: i***@domain — полный email только в детальной view.
        let userEmailMasked: string | null = null;
        if (r.userEmail) {
          const at = String(r.userEmail).indexOf("@");
          if (at > 0) userEmailMasked = `${String(r.userEmail).slice(0, 1)}***${String(r.userEmail).slice(at)}`;
        }
        return {
          id: r.id,
          channel: r.channel,
          externalId: r.externalId,
          userId: r.userId,
          userName: r.userName || null,
          userEmail: userEmailMasked,
          userProfile: safeProfile,
          personaName: r.personaName || null,
          startedAt: r.startedAt,
          lastMessageAt: r.lastMessageAt,
          messageCount: Number(r.messageCount || 0),
          lastUserMessage: preview,
          lastMessageRole: r.lastMessageRole || null,
          isActive,
        };
      });

      res.json({
        data: {
          sessions,
          total,
          limit,
          offset,
          hasMore: offset + sessions.length < total,
          channel,
          status,
          generatedAt: new Date().toISOString(),
        },
        error: null,
      });
    } catch (e: any) {
      console.error("[admin/conversations]", e);
      res.status(500).json({ data: null, error: String(e?.message || e).slice(0, 200) });
    }
  });

  app.get("/api/admin/v304/user/:userId/conversations", requireAdmin, (req: Request, res: Response) => {
    const userId = Number(req.params.userId);
    if (!Number.isFinite(userId) || userId <= 0) {
      return res.status(400).json({ ok: false, error: "invalid userId" });
    }
    const data = loadHistoryForUser(userId, 500);
    const u = storage.getUser(userId);
    res.json({
      ok: true,
      user: u ? { id: u.id, name: u.name, email: u.email, telegramId: (u as any).telegramId || null } : null,
      ...data,
    });
  });

  // Eugene 2026-05-16 Босс: «Босс пишет от лица Музы» — Telegram-alert
  // ведёт админа на диалог, дальше он может ответить юзеру прямо в нужный
  // канал (TG/Max/Web). Сообщение сохраняется в chatbot_messages как role='bot'
  // (юзер видит его как от помощницы, а не от админа).
  app.post("/api/admin/v304/conversations/:sessionId/inject-message", requireAdmin, async (req: Request, res: Response) => {
    try {
      const sessionId = String(req.params.sessionId || "").trim();
      if (!sessionId) return res.status(400).json({ ok: false, error: "missing sessionId" });
      const text = String((req.body || {}).text || "").trim();
      if (text.length === 0) return res.status(400).json({ ok: false, error: "missing text" });
      if (text.length > 4000) return res.status(400).json({ ok: false, error: "text too long (max 4000)" });

      const session = db.select().from(chatbotSessions)
        .where(eq(chatbotSessions.id, sessionId)).get() as any;
      if (!session) return res.status(404).json({ ok: false, error: "session not found" });

      // 1. Запись в БД — юзер увидит при следующем polling/page-refresh.
      db.insert(chatbotMessages).values({
        sessionId,
        role: "bot",
        text,
      }).run();
      db.update(chatbotSessions)
        .set({ lastMessageAt: new Date().toISOString() })
        .where(eq(chatbotSessions.id, sessionId))
        .run();

      // Eugene 2026-05-20 Босс «база сообщений админа в боте Муза». Inject —
      // это admin пишет от лица Музы. Записываем в admin_chat_messages
      // (channel='inject') + gate check (auto-apply при trusted IP).
      let adminMsgResult: any = null;
      try {
        const { recordAdminMuzaMessage } = await import("./lib/adminChatRecorder");
        const adminUserId = tryGetUserId(req);
        let adminRole: string | null = null;
        if (adminUserId) {
          try {
            const u = storage.getUser(adminUserId);
            const rl = String((u as any)?.role || "").toLowerCase();
            if (rl === "admin" || rl === "super_admin") adminRole = rl;
          } catch {}
        }
        adminMsgResult = await recordAdminMuzaMessage({
          sessionId,
          userId: adminUserId,
          channel: "inject",
          text,
          ip: req.ip || req.socket.remoteAddress || null,
          userAgent: req.headers["user-agent"] ? String(req.headers["user-agent"]) : null,
          role: adminRole,
        });
      } catch (e) {
        console.warn("[inject-message] adminChatRecorder failed:", (e as Error).message);
      }

      // 2. Push в канал юзера если это не web.
      const channel = String(session.channel || "").toLowerCase();
      const externalId = session.externalId ? String(session.externalId) : null;
      let delivered: "db_only" | "telegram" | "max" | "skipped" = "db_only";
      let deliveryError: string | null = null;

      try {
        if (channel === "telegram" && externalId) {
          const tgToken = process.env.TELEGRAM_BOT_TOKEN;
          if (tgToken) {
            const r = await fetch(`https://api.telegram.org/bot${tgToken}/sendMessage`, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                chat_id: externalId,
                text,
                disable_web_page_preview: true,
              }),
              signal: AbortSignal.timeout(8_000),
            });
            if (!r.ok) {
              deliveryError = `telegram ${r.status}`;
              delivered = "skipped";
            } else {
              delivered = "telegram";
            }
          } else {
            deliveryError = "TELEGRAM_BOT_TOKEN missing";
            delivered = "skipped";
          }
        } else if (channel === "max" && externalId) {
          const maxToken = process.env.MAX_BOT_TOKEN;
          if (maxToken) {
            const r = await fetch(`https://platform-api.max.ru/messages?chat_id=${encodeURIComponent(externalId)}`, {
              method: "POST",
              headers: { Authorization: maxToken, "Content-Type": "application/json" },
              body: JSON.stringify({ text }),
              signal: AbortSignal.timeout(8_000),
            });
            if (!r.ok) {
              deliveryError = `max ${r.status}`;
              delivered = "skipped";
            } else {
              delivered = "max";
            }
          } else {
            deliveryError = "MAX_BOT_TOKEN missing";
            delivered = "skipped";
          }
        } else if (channel === "web") {
          // Web — юзер увидит при следующем polling. Запись в БД достаточно.
          delivered = "db_only";
        }
      } catch (e: any) {
        deliveryError = String(e?.message || e).slice(0, 200);
        delivered = "skipped";
      }

      res.json({
        ok: true,
        sessionId,
        channel,
        delivered,
        deliveryError,
        // Eugene 2026-05-20 — diagnostic ответ по правилу
        // «если параметр не бьётся — сообщи конкретно какой».
        adminMessage: adminMsgResult ? {
          recorded: adminMsgResult.recorded,
          authorized: adminMsgResult.authorized,
          mismatch: adminMsgResult.mismatch ?? null,
          applied: adminMsgResult.applied,
          appliedActions: adminMsgResult.appliedActions,
          artifactId: adminMsgResult.artifactId ?? null,
        } : null,
      });
    } catch (e: any) {
      console.error("[inject-message]", e);
      res.status(500).json({ ok: false, error: "internal error" });
    }
  });

  // ============================================================
  // Eugene 2026-05-20 (subagent setup-max) — admin Max endpoints
  // ============================================================
  //
  // GET  /api/admin/v304/max/status          — статус канала + recent messages
  // POST /api/admin/v304/max/register-webhook — пере-регистрация webhook у Max
  // POST /api/admin/v304/max/test-message    — отправка test message конкретному
  //                                            юзеру (для verify token + chat_id)

  app.get("/api/admin/v304/max/status", requireAdmin, async (_req: Request, res: Response) => {
    try {
      const token = process.env.MAX_BOT_TOKEN || "";
      const secret = process.env.MAX_WEBHOOK_SECRET || "";
      const apiBase = process.env.MAX_API_BASE || "https://botapi.max.ru";
      let me: any = null;
      let meError: string | null = null;
      if (token) {
        try {
          const r = await fetch(`${apiBase}/me`, {
            headers: { Authorization: token },
            signal: AbortSignal.timeout(8_000),
          });
          if (r.ok) {
            me = await r.json().catch(() => null);
          } else {
            meError = `HTTP ${r.status}`;
          }
        } catch (e: any) {
          meError = String(e?.message || e).slice(0, 200);
        }
      }
      const recentSessions = db.all<any>(sql`
        SELECT id, external_id, user_id, last_message_at, persona_name,
          (SELECT COUNT(*) FROM chatbot_messages WHERE session_id = chatbot_sessions.id) AS msg_count
        FROM chatbot_sessions
        WHERE channel = 'max'
        ORDER BY last_message_at DESC
        LIMIT 20
      `) as any[];
      const counts = db.get<any>(sql`
        SELECT
          (SELECT COUNT(*) FROM chatbot_messages cm
            JOIN chatbot_sessions cs ON cs.id = cm.session_id
            WHERE cs.channel = 'max' AND cm.created_at >= datetime('now','-1 hour')) AS h1,
          (SELECT COUNT(*) FROM chatbot_messages cm
            JOIN chatbot_sessions cs ON cs.id = cm.session_id
            WHERE cs.channel = 'max' AND cm.created_at >= datetime('now','-1 day')) AS d1
      `) as any;
      const recentMessages = db.all<any>(sql`
        SELECT cm.id, cm.session_id, cm.role, cm.text, cm.created_at, cm.attached_track_id, cs.external_id
        FROM chatbot_messages cm
        JOIN chatbot_sessions cs ON cs.id = cm.session_id
        WHERE cs.channel = 'max'
        ORDER BY cm.id DESC
        LIMIT 20
      `) as any[];
      res.json({
        data: {
          configured: !!token,
          webhookSecretConfigured: !!secret,
          apiBase,
          me,
          meError,
          counts: {
            messagesLastHour: Number(counts?.h1 || 0),
            messagesLast24h: Number(counts?.d1 || 0),
            sessionsTotal: recentSessions.length,
          },
          recentSessions: recentSessions.map((s: any) => ({
            sessionId: s.id,
            externalId: s.external_id,
            userId: s.user_id,
            lastMessageAt: s.last_message_at,
            personaName: s.persona_name,
            msgCount: Number(s.msg_count || 0),
          })),
          recentMessages: recentMessages.reverse().map((m: any) => ({
            id: m.id,
            sessionId: m.session_id,
            externalId: m.external_id,
            role: m.role,
            text: String(m.text || "").slice(0, 300),
            attachedTrackId: m.attached_track_id || null,
            createdAt: m.created_at,
          })),
        },
        error: null,
      });
    } catch (e: any) {
      console.error("[admin/v304/max/status]", e);
      res.status(500).json({ data: null, error: "internal error" });
    }
  });

  app.post("/api/admin/v304/max/register-webhook", requireAdmin, async (req: Request, res: Response) => {
    try {
      const token = process.env.MAX_BOT_TOKEN || "";
      if (!token) {
        return res.status(400).json({ data: null, error: "MAX_BOT_TOKEN не задан" });
      }
      const apiBase = process.env.MAX_API_BASE || "https://botapi.max.ru";
      const explicitUrl = String((req.body || {}).url || process.env.MAX_WEBHOOK_URL || "");
      const baseUrl = process.env.PUBLIC_BASE_URL || "https://muzaai.ru";
      const url = explicitUrl || `${baseUrl}/api/max-bot/webhook`;
      if (!url.startsWith("https://")) {
        return res.status(400).json({ data: null, error: "webhook url must be https" });
      }
      const secret = process.env.MAX_WEBHOOK_SECRET || "";
      const candidates = [apiBase, "https://platform-api.max.ru"];
      const body: any = { url, update_types: ["message_created", "bot_started", "bot_added"] };
      if (secret) body.secret = secret;
      const attempts: any[] = [];
      for (const base of candidates) {
        try {
          const r = await fetch(`${base}/subscriptions`, {
            method: "POST",
            headers: { Authorization: token, "Content-Type": "application/json" },
            body: JSON.stringify(body),
            signal: AbortSignal.timeout(10_000),
          });
          const txt = await r.text().catch(() => "");
          attempts.push({ base, status: r.status, response: txt.slice(0, 300) });
          if (r.ok) {
            let parsed: any = null;
            try { parsed = JSON.parse(txt); } catch {}
            return res.json({
              data: { baseUsed: base, url, secretSet: !!secret, response: parsed ?? txt.slice(0, 300), attempts },
              error: null,
            });
          }
        } catch (e: any) {
          attempts.push({ base, error: String(e?.message || e).slice(0, 200) });
        }
      }
      return res.status(502).json({
        data: { url, secretSet: !!secret, attempts },
        error: "Все endpoints subscriptions упали — проверь логи и docs Max",
      });
    } catch (e: any) {
      console.error("[admin/v304/max/register-webhook]", e);
      res.status(500).json({ data: null, error: "internal error" });
    }
  });

  app.post("/api/admin/v304/max/test-message", requireAdmin, async (req: Request, res: Response) => {
    try {
      const token = process.env.MAX_BOT_TOKEN || "";
      if (!token) {
        return res.status(400).json({ data: null, error: "MAX_BOT_TOKEN не задан" });
      }
      const apiBase = process.env.MAX_API_BASE || "https://botapi.max.ru";
      const chatId = String((req.body || {}).chatId || (req.body || {}).userId || "").trim();
      const text = String((req.body || {}).text || "Test message от MuzaAi").trim();
      if (!chatId) {
        return res.status(400).json({ data: null, error: "chatId required" });
      }
      if (text.length > 4000) {
        return res.status(400).json({ data: null, error: "text too long (max 4000)" });
      }
      const candidates = [apiBase, "https://platform-api.max.ru"];
      const body = { text };
      const attempts: any[] = [];
      for (const base of candidates) {
        try {
          const r = await fetch(`${base}/messages?chat_id=${encodeURIComponent(chatId)}`, {
            method: "POST",
            headers: { Authorization: token, "Content-Type": "application/json" },
            body: JSON.stringify(body),
            signal: AbortSignal.timeout(10_000),
          });
          const respText = await r.text().catch(() => "");
          attempts.push({ base, status: r.status, response: respText.slice(0, 300) });
          if (r.ok) {
            let parsed: any = null;
            try { parsed = JSON.parse(respText); } catch {}
            return res.json({
              data: { delivered: true, baseUsed: base, chatId, response: parsed ?? respText.slice(0, 300), attempts },
              error: null,
            });
          }
        } catch (e: any) {
          attempts.push({ base, error: String(e?.message || e).slice(0, 200) });
        }
      }
      return res.status(502).json({
        data: { delivered: false, chatId, attempts },
        error: "Не удалось отправить — проверь chatId / token",
      });
    } catch (e: any) {
      console.error("[admin/v304/max/test-message]", e);
      res.status(500).json({ data: null, error: "internal error" });
    }
  });

  // Eugene 2026-05-16 Босс: универсальный просмотр диалога по userId ИЛИ sessionId.
  // Telegram-alert при reason='owner_inquiry' ведёт сюда — у Босса в URL только
  // sessionId, поэтому endpoint обрабатывает оба формата:
  //   :id ∈ digits → userId
  //   :id ∈ uuid/text → sessionId (резолвим userId через chatbotSessions.userId)
  // Возвращает: user / sessions / messages / handoffs.
  app.get("/api/admin/v304/conversations/:userIdOrSessionId", requireAdmin, (req: Request, res: Response) => {
    try {
      const raw = String(req.params.userIdOrSessionId || "").trim();
      if (!raw) return res.status(400).json({ ok: false, error: "missing id" });

      // Резолв userId.
      let userId: number | null = null;
      let lookupSessionId: string | null = null;
      if (/^\d+$/.test(raw)) {
        userId = Number(raw);
      } else {
        lookupSessionId = raw;
        try {
          const row = db.select({ userId: chatbotSessions.userId })
            .from(chatbotSessions).where(eq(chatbotSessions.id, raw)).get() as any;
          if (row?.userId) userId = Number(row.userId);
        } catch {}
      }

      // Если у нас userId — используем helper (он мерджит cross-channel
      // сообщения, как в /user/:userId/conversations).
      let payload: { sessions: any[]; messages: any[] };
      if (userId) {
        payload = loadHistoryForUser(userId, 500) as any;
      } else if (lookupSessionId) {
        // Anonymous session — берём её одну.
        try {
          const sess = db.select().from(chatbotSessions)
            .where(eq(chatbotSessions.id, lookupSessionId)).get() as any;
          if (!sess) return res.status(404).json({ ok: false, error: "session not found" });
          const msgs = db.select().from(chatbotMessages)
            .where(eq(chatbotMessages.sessionId, lookupSessionId))
            .orderBy(sql`${chatbotMessages.createdAt} ASC, ${chatbotMessages.id} ASC`)
            .all() as any[];
          payload = {
            sessions: [{
              id: sess.id,
              channel: String(sess.channel || ""),
              startedAt: sess.startedAt,
              lastMessageAt: sess.lastMessageAt,
              personaName: sess.personaName,
            }],
            messages: msgs.map(r => ({
              id: r.id,
              sessionId: r.sessionId,
              channel: String(sess.channel || ""),
              role: r.role,
              text: String(r.text || ""),
              createdAt: r.createdAt,
            })),
          };
        } catch (e: any) {
          return res.status(500).json({ ok: false, error: "load failed" });
        }
      } else {
        return res.status(404).json({ ok: false, error: "not found" });
      }

      // Handoffs: либо по всем sessionId юзера, либо по конкретной сессии.
      let handoffs: any[] = [];
      try {
        const sessIds = payload.sessions.map(s => s.id).filter(Boolean);
        if (sessIds.length > 0) {
          handoffs = db.select().from(agentHandoffs)
            .where(inArray(agentHandoffs.sessionId, sessIds))
            .orderBy(desc(agentHandoffs.createdAt))
            .all() as any[];
        } else if (lookupSessionId) {
          handoffs = db.select().from(agentHandoffs)
            .where(eq(agentHandoffs.sessionId, lookupSessionId))
            .orderBy(desc(agentHandoffs.createdAt))
            .all() as any[];
        }
      } catch {}

      const u = userId ? storage.getUser(userId) : null;
      res.json({
        ok: true,
        user: u ? { id: u.id, name: u.name, email: u.email, telegramId: (u as any).telegramId || null } : null,
        sessions: payload.sessions,
        messages: payload.messages.map(m => ({
          sender: m.role === "user" ? "user" : "agent",
          text: m.text,
          createdAt: m.createdAt,
          channel: m.channel,
          sessionId: m.sessionId,
        })),
        handoffs: handoffs.map(h => ({
          id: h.id,
          reason: h.reason,
          status: h.status,
          assignedTo: h.assignedTo,
          sessionId: h.sessionId,
          createdAt: h.createdAt,
        })),
      });
    } catch (e: any) {
      console.error("[conversations]", e);
      res.status(500).json({ ok: false, error: "internal error" });
    }
  });

  // Consultant avatar PNG (Eugene 2026-05-11): рендерит SVG → PNG через
  // sharp для Telegram/Max sendPhoto. Кэш через mtime.
  let consultantPngCache: { buf: Buffer; mtime: number; size: number } | null = null;
  app.get("/api/assets/consultant-avatar.png", async (req: Request, res: Response) => {
    try {
      const size = Math.min(1024, Math.max(64, parseInt(String(req.query.size || "512")) || 512));
      const svgCandidates = [
        path.join(process.cwd(), "dist/public/consultant-avatar.svg"),
        path.join(process.cwd(), "client/public/consultant-avatar.svg"),
        path.join(process.cwd(), "../neurohub/client/public/consultant-avatar.svg"),
      ];
      let svgPath: string | null = null;
      for (const p of svgCandidates) {
        try { if (fs.existsSync(p)) { svgPath = p; break; } } catch {}
      }
      if (!svgPath) {
        res.status(404).send("avatar not found");
        return;
      }
      const stat = fs.statSync(svgPath);
      if (consultantPngCache && consultantPngCache.mtime === stat.mtimeMs && consultantPngCache.size === size) {
        res.setHeader("Content-Type", "image/png");
        res.setHeader("Cache-Control", "public, max-age=86400");
        res.send(consultantPngCache.buf);
        return;
      }
      const sharp = require("sharp");
      const svgBuf = fs.readFileSync(svgPath);
      const png = await sharp(svgBuf).resize(size, size, { fit: "cover" }).png().toBuffer();
      consultantPngCache = { buf: png, mtime: stat.mtimeMs, size };
      res.setHeader("Content-Type", "image/png");
      res.setHeader("Cache-Control", "public, max-age=86400");
      res.send(png);
    } catch (e: any) {
      console.error("[CONSULTANT-AVATAR] Error:", e);
      res.status(500).send("render error");
    }
  });

  // Telegram auth redirect handler — Telegram redirects here with user data in query params
  app.get("/api/auth/telegram-redirect", async (req: Request, res: Response) => {
    try {
      const tgData: Record<string, string> = {};
      for (const [k, v] of Object.entries(req.query)) {
        if (typeof v === "string") tgData[k] = v;
      }

      if (!tgData.id || !tgData.hash) {
        res.redirect("/#/login");
        return;
      }

      if (!verifyTelegramAuth(tgData)) {
        res.redirect("/#/login?error=tg_invalid");
        return;
      }

      const tgId = String(tgData.id);
      const tgName = [tgData.first_name, tgData.last_name].filter(Boolean).join(" ") || "Telegram User";

      let user = db.select().from(users).where(eq(users.telegramId, tgId)).get();

      if (user) {
        // Direct login
        const crypto = require("crypto");
        const token = crypto.randomBytes(32).toString("hex");
        tokenStore.set(token, user.id);
        console.log(`[TG REDIRECT] Login user #${user.id}: ${user.name}`);
        // Redirect to page that sets token and navigates
        res.setHeader("Content-Type", "text/html; charset=utf-8");
        res.send(`<!DOCTYPE html><html><head><meta charset="utf-8"><title>Вход...</title></head><body style="background:#09090b;color:#fff;font-family:sans-serif;display:flex;align-items:center;justify-content:center;min-height:100vh">
<script>localStorage.setItem('token','${token}');window.location.href='/#/dashboard';</script>
<p>Вход...</p></body></html>`);
        return;
      }

      // No user found — show linking page
      const tgDataB64 = Buffer.from(JSON.stringify(tgData)).toString("base64");
      res.setHeader("Content-Type", "text/html; charset=utf-8");
      res.send(`<!DOCTYPE html><html><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Привязка Telegram</title>
<style>body{font-family:-apple-system,sans-serif;background:#09090b;color:#e0e0e0;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0}
.card{max-width:340px;width:100%;padding:24px;border-radius:16px;border:1px solid #222;background:#111}
input{width:100%;padding:10px 14px;border-radius:10px;border:1px solid #333;background:#1a1a1a;color:#fff;font-size:14px;margin-bottom:10px;box-sizing:border-box}
button{width:100%;padding:12px;border-radius:10px;border:none;font-size:14px;font-weight:600;cursor:pointer}
.btn-link{background:linear-gradient(135deg,#8b5cf6,#3b82f6);color:white}
.btn-new{background:#222;color:#888;margin-top:8px}
.spinner{display:none;width:20px;height:20px;border:3px solid #333;border-top-color:#8b5cf6;border-radius:50%;animation:spin 0.8s linear infinite;margin:0 auto}@keyframes spin{to{transform:rotate(360deg)}}
h3{margin:0 0 4px;background:linear-gradient(135deg,#8b5cf6,#3b82f6);-webkit-background-clip:text;-webkit-text-fill-color:transparent}
p.sub{color:#888;font-size:13px;margin:0 0 16px}
#msg{color:#ef4444;font-size:13px;text-align:center;margin-top:8px}
</style></head><body>
<div class="card">
<h3>Привет, ${tgName}!</h3>
<p class="sub">У вас уже есть аккаунт? Привяжите Telegram.</p>
<input id="e" type="email" placeholder="Email">
<input id="p" type="password" placeholder="Пароль">
<button class="btn-link" onclick="link()"> Привязать и войти</button>
<button class="btn-new" onclick="create()"> Создать новый аккаунт</button>
<div class="spinner" id="sp"></div>
<p id="msg"></p>
</div>
<script>
var td=JSON.parse(atob('${tgDataB64}'));
function doPost(extra){
  document.getElementById('sp').style.display='block';
  document.getElementById('msg').textContent='';
  var body=Object.assign({},td,extra||{});
  fetch('/api/auth/telegram',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)})
    .then(function(r){return r.json()}).then(function(d){
      if(d.token){localStorage.setItem('token',d.token);window.location.href='/#/dashboard';}
      else{document.getElementById('msg').textContent=d.message||'Ошибка';document.getElementById('sp').style.display='none';}
    }).catch(function(){document.getElementById('msg').textContent='Ошибка сети';document.getElementById('sp').style.display='none';});
}
function link(){doPost({link_email:document.getElementById('e').value,link_password:document.getElementById('p').value});}
function create(){doPost({force_create:true});}
</script></body></html>`);
    } catch (e: any) {
      console.error("[TG REDIRECT] Error:", e);
      res.redirect("/#/login");
    }
  });

  // Telegram Login page (Eugene 2026-05-11): deep-link flow.
  // Telegram депрекейтнул OAuth-виджет — теперь redirect через бота.
  // Юзер тапает кнопку → t.me/Muziaipodari_bot?start=login_<nonce> →
  // бот подтверждает у себя → сайт через polling забирает token.
  app.get("/telegram-login", (_req: Request, res: Response) => {
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.send(`<!DOCTYPE html>
<html><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Войти через Telegram — MuzaAi</title>
<style>
*{box-sizing:border-box}
body{font-family:-apple-system,BlinkMacSystemFont,sans-serif;background:#09090b;color:#e0e0e0;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0;padding:20px}
.card{max-width:380px;width:100%;text-align:center;display:flex;flex-direction:column;align-items:center;gap:16px}
.logo{width:56px;height:56px;border-radius:14px;background:linear-gradient(135deg,#8b5cf6,#3b82f6);display:flex;align-items:center;justify-content:center;font-size:28px}
h2{background:linear-gradient(135deg,#8b5cf6,#3b82f6);-webkit-background-clip:text;-webkit-text-fill-color:transparent;margin:0;font-size:22px}
.sub{color:#888;font-size:14px;margin:0;line-height:1.5}
.tg-btn{display:flex;align-items:center;justify-content:center;gap:10px;width:100%;padding:14px;border-radius:14px;background:#54a9eb;color:#fff;border:none;font-size:16px;font-weight:600;cursor:pointer;text-decoration:none;transition:opacity .2s}
.tg-btn:active{opacity:.85}
.tg-btn svg{flex-shrink:0}
.status{font-size:13px;color:#888;min-height:20px;margin-top:8px}
.status.ok{color:#22c55e}
.status.err{color:#ef4444}
.spinner{display:inline-block;width:14px;height:14px;border:2px solid #333;border-top-color:#8b5cf6;border-radius:50%;animation:spin .8s linear infinite;vertical-align:middle;margin-right:6px}
@keyframes spin{to{transform:rotate(360deg)}}
.back{color:#666;font-size:13px;text-decoration:none;margin-top:24px}
.back:hover{color:#aaa}
.hint{margin-top:6px;font-size:12px;color:#666}
</style>
</head><body>
<div class="card">
  <div class="logo">🎵</div>
  <h2>Войти через Telegram</h2>
  <p class="sub">1. Нажмите кнопку ниже — откроется @Muziaipodari_bot<br>2. В Telegram нажмите <b>Start</b> — бот пришлёт кнопку «🔐 Войти на сайт»<br>3. Нажмите её — вы вернётесь сюда, уже залогинены</p>
  <a id="tgBtn" class="tg-btn" target="_blank" rel="noopener">
    <svg width="22" height="22" viewBox="0 0 24 24" fill="white"><path d="M12 0C5.37 0 0 5.37 0 12s5.37 12 12 12 12-5.37 12-12S18.63 0 12 0zm5.94 8.13l-1.97 9.28c-.15.67-.54.83-1.09.52l-3.01-2.22-1.45 1.4c-.16.16-.3.3-.61.3l.21-3.04 5.56-5.02c.24-.21-.05-.33-.37-.13l-6.87 4.33-2.96-.92c-.64-.2-.66-.64.14-.95l11.57-4.46c.53-.2 1-.05.85.91z"/></svg>
    <span>Открыть Telegram</span>
  </a>
  <div class="status" id="msg">Подготовка ссылки…</div>
  <div class="hint" id="hint" style="display:none">Ждём подтверждения от Telegram…</div>
  <a href="/#/login" class="back">← Назад ко входу</a>
</div>
<script>
(function(){
  var btn=document.getElementById('tgBtn');
  var msg=document.getElementById('msg');
  var hint=document.getElementById('hint');
  var nonce=null;
  var polling=false;
  var pollTimer=null;

  function setStatus(text, cls){
    msg.textContent=text;
    msg.className='status '+(cls||'');
  }

  function start(){
    setStatus('Подготовка ссылки…');
    fetch('/api/auth/telegram/start',{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'})
      .then(function(r){return r.json()})
      .then(function(d){
        if(!d.nonce||!d.deepLink){throw new Error('no nonce')}
        nonce=d.nonce;
        btn.href=d.deepLink;
        setStatus('Готово — нажмите кнопку выше');
      })
      .catch(function(){setStatus('Ошибка подготовки. Перезагрузите страницу.','err')});
  }

  function startPolling(){
    if(polling||!nonce)return;
    polling=true;
    hint.style.display='block';
    setStatus('Ожидание подтверждения в Telegram…');
    var attempts=0;
    function tick(){
      attempts++;
      fetch('/api/auth/telegram/poll?nonce='+encodeURIComponent(nonce))
        .then(function(r){return r.json()})
        .then(function(d){
          if(d.status==='confirmed'&&d.token){
            localStorage.setItem('token',d.token);
            setStatus('✓ Вход выполнен. Перенаправление…','ok');
            setTimeout(function(){window.location.href='/#/dashboard'},400);
            return;
          }
          if(d.status==='expired'||d.status==='error'){
            setStatus('Сессия истекла. Перезагрузите страницу.','err');
            polling=false;
            return;
          }
          if(attempts>180){ // 6 минут × 2 сек
            setStatus('Время ожидания истекло. Попробуйте снова.','err');
            polling=false;
            return;
          }
          pollTimer=setTimeout(tick,2000);
        })
        .catch(function(){
          if(attempts<180)pollTimer=setTimeout(tick,3000);
          else polling=false;
        });
    }
    tick();
  }

  btn.addEventListener('click', function(){
    setTimeout(startPolling, 100);
  });

  // На фокус возвращения окна (юзер закрыл Telegram) — продолжаем polling
  window.addEventListener('focus', function(){
    if(nonce&&!polling)startPolling();
  });

  start();
})();
</script>
</body></html>`);
  });

  // ==================== BALANCE ====================
  app.post("/api/balance/topup", authMiddleware, (req: Request, res: Response) => {
    const userId = (req as any).userId;
    const kopecks = 50000; // +500₽

    storage.updateBalance(userId, kopecks);
    storage.createTransaction({
      userId,
      type: "topup",
      amount: kopecks,
      description: "Пополнение баланса на 500 ₽",
    });

    const user = storage.getUser(userId);
    res.json({ balance: user?.balance || 0 });
  });

  // Apply promo code from dashboard
  app.post("/api/promo/apply", authMiddleware, (req: Request, res: Response) => {
    const userId = (req as any).userId;
    const { code } = req.body;
    if (!code || !code.trim()) {
      res.status(400).json({ message: "Введите промокод" });
      return;
    }
    const user = storage.getUser(userId);
    if (!user) { res.status(401).json({ message: "Не авторизован" }); return; }

    // Check if already used this code
    const usedList = (user.usedPromo || "").split(",").map(s => s.trim().toLowerCase()).filter(Boolean);
    if (usedList.includes(code.trim().toLowerCase())) {
      res.status(400).json({ message: "Вы уже использовали этот промокод" });
      return;
    }

    // Eugene 2026-05-18 Босс «промокод "Поехали" действовал месяц с 12 апреля 2026 —
    // отвечай юзеру именно так, не "не найден"». Проверка ДО запроса в БД.
    const expiredInfo = checkExpiredPromo(code.trim());
    if (expiredInfo) {
      res.status(400).json({ message: expiredInfo.message, expired: true, period: expiredInfo.period });
      return;
    }

    const promoCode = db.select().from(promoCodes)
      .where(sql`LOWER(${promoCodes.code}) = LOWER(${code.trim()})`).get();
    if (!promoCode) {
      res.status(404).json({ message: "Промокод не найден" });
      return;
    }

    const now = new Date().toISOString();
    const active = (!promoCode.activeFrom || promoCode.activeFrom <= now) && (!promoCode.activeTo || promoCode.activeTo >= now);
    if (!active) {
      res.status(400).json({ message: "Промокод истёк" });
      return;
    }
    const withinLimit = promoCode.maxUses === 0 || promoCode.usedCount < promoCode.maxUses;
    if (!withinLimit) {
      res.status(400).json({ message: "Промокод больше не действует" });
      return;
    }

    // Apply bonus: money and/or tracks
    const parts: string[] = [];
    if (promoCode.bonus > 0) {
      storage.updateBalance(userId, promoCode.bonus);
      storage.createTransaction({ userId, type: "topup", amount: promoCode.bonus, description: `🎟️ Промокод ${promoCode.code}: +${(promoCode.bonus / 100)} ₽` });
      parts.push(`+${promoCode.bonus / 100} ₽`);
    }
    if (promoCode.bonusTracks > 0) {
      db.update(users).set({ bonusTracks: sql`${users.bonusTracks} + ${promoCode.bonusTracks}` }).where(eq(users.id, userId)).run();
      storage.createTransaction({ userId, type: "topup", amount: 0, description: `🎁 Промокод ${promoCode.code}: +${promoCode.bonusTracks} подарочн. треков` });
      parts.push(`+${promoCode.bonusTracks} подарочн. треков`);
    }

    // Update counters
    db.update(promoCodes).set({ usedCount: promoCode.usedCount + 1 }).where(eq(promoCodes.id, promoCode.id)).run();
    const newUsedPromo = usedList.length > 0 ? `${user.usedPromo},${promoCode.code}` : promoCode.code;
    db.update(users).set({ usedPromo: newUsedPromo }).where(eq(users.id, userId)).run();

    console.log(`[PROMO-DASHBOARD] User #${userId} applied promo '${promoCode.code}' ${parts.join(', ')}`);

    const updatedUser = storage.getUser(userId);
    res.json({ message: `Промокод ${promoCode.code} активирован! ${parts.join(' и ')}`, balance: updatedUser?.balance || 0, bonusTracks: updatedUser?.bonusTracks || 0 });
  });

  app.get("/api/transactions", authMiddleware, (req: Request, res: Response) => {
    const userId = (req as any).userId;
    res.json(storage.getTransactions(userId));
  });

  // Update author display name
  // Request name change — sends confirmation email, does NOT change name immediately
  app.post("/api/auth/update-name", authMiddleware, async (req: Request, res: Response) => {
    const userId = (req as any).userId;
    const { name } = req.body;
    if (!name || name.trim().length < 1) {
      res.status(400).json({ message: "Имя не может быть пустым" });
      return;
    }
    const user = storage.getUser(userId);
    if (!user) { res.status(401).json({ message: "Не авторизован" }); return; }

    const trimmed = name.trim();
    if (trimmed === user.name) {
      res.json({ message: "Имя не изменилось", pendingConfirmation: false });
      return;
    }

    // Generate confirmation token
    const token = crypto.randomUUID();
    db.update(users).set({ pendingName: trimmed, nameChangeToken: token }).where(eq(users.id, userId)).run();

    // Send confirmation email
    const confirmUrl = `${PUBLIC_URL}/api/auth/confirm-name/${token}`;
    try {
      await mailTransport.sendMail({
        from: `"MuzaAi" <${CLIENT_EMAIL}>`, replyTo: CLIENT_EMAIL,
        to: user.email,
        subject: "MuzaAi — подтверждение смены имени",
        html: `
          <div style="font-family: -apple-system, sans-serif; max-width: 480px; margin: 0 auto; padding: 32px; background: #09090b; border-radius: 16px; border: 1px solid #1a1a2e;">
            <div style="text-align: center; margin-bottom: 24px;">
              <span style="font-size: 24px; font-weight: 700; background: linear-gradient(135deg, #8b5cf6, #3b82f6); -webkit-background-clip: text; -webkit-text-fill-color: transparent;">MuzaAi</span>
            </div>
            <p style="color: #e0e0e0; font-size: 15px; line-height: 1.6; margin: 0 0 16px;">Вы запросили смену имени автора:</p>
            <p style="color: #a0a0a0; font-size: 14px; margin: 0 0 8px;"><b style="color:#e0e0e0">Текущее:</b> ${user.name}</p>
            <p style="color: #a0a0a0; font-size: 14px; margin: 0 0 20px;"><b style="color:#e0e0e0">Новое:</b> ${trimmed}</p>
            <p style="color: #fbbf24; font-size: 13px; margin: 0 0 20px;">⚠️ После подтверждения имя изменится во всех плейлистах и опубликованных треках.</p>
            <div style="text-align: center; margin: 24px 0;">
              <a href="${confirmUrl}" style="display: inline-block; padding: 12px 32px; background: linear-gradient(135deg, #8b5cf6, #3b82f6); color: white; text-decoration: none; border-radius: 12px; font-weight: 600; font-size: 15px;">Подтвердить смену имени</a>
            </div>
            <p style="color: #666; font-size: 12px; margin: 16px 0 0;">Если вы не запрашивали смену имени, проигнорируйте это письмо.</p>
          </div>
        `,
      });
    } catch (e) {
      console.error("[NAME CHANGE] Email send error:", e);
    }

    res.json({ message: "Письмо с подтверждением отправлено", pendingConfirmation: true });
  });

  // Confirm name change via email link
  app.get("/api/auth/confirm-name/:token", (req: Request, res: Response) => {
    const { token } = req.params;
    const user = db.select().from(users).where(eq(users.nameChangeToken, token)).get();
    if (!user || !user.pendingName) {
      res.setHeader("Content-Type", "text/html; charset=utf-8");
      res.send(`
        <html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Ошибка</title></head>
        <body style="font-family:-apple-system,sans-serif;background:#09090b;color:#e0e0e0;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0">
          <div style="text-align:center;padding:32px">
            <h2 style="color:#ef4444">✘ Ссылка недействительна</h2>
            <p style="color:#888">Возможно, имя уже было изменено или ссылка устарела.</p>
            <a href="${PUBLIC_URL}" style="color:#8b5cf6">← Вернуться на сайт</a>
          </div>
        </body></html>
      `);
      return;
    }

    const newName = user.pendingName;
    const oldName = user.name;

    // Update user name and clear pending
    db.update(users).set({ name: newName, pendingName: null, nameChangeToken: null }).where(eq(users.id, user.id)).run();

    // Update author_name in all generations by this user
    db.update(generations).set({ authorName: newName }).where(
      and(eq(generations.userId, user.id), eq(generations.authorName, oldName))
    ).run();
    // Also update where authorName was null, empty, or "Аноним"
    db.update(generations).set({ authorName: newName }).where(
      and(eq(generations.userId, user.id), sql`(${generations.authorName} IS NULL OR ${generations.authorName} = '' OR ${generations.authorName} = 'Аноним')`)
    ).run();

    // Rename author folder on disk
    try {
      const oldFolder = path.join(AUTHORS_DIR, sanitizeFolderName(oldName));
      const newFolder = path.join(AUTHORS_DIR, sanitizeFolderName(newName));
      if (fs.existsSync(oldFolder) && oldFolder !== newFolder) {
        if (fs.existsSync(newFolder)) {
          // Merge: move files from old to new
          const files = fs.readdirSync(oldFolder);
          for (const f of files) {
            const src = path.join(oldFolder, f);
            const dest = path.join(newFolder, f);
            if (fs.statSync(src).isDirectory()) {
              // Subfolder (e.g. deleted/) — merge contents
              fs.mkdirSync(dest, { recursive: true });
              for (const sf of fs.readdirSync(src)) {
                fs.renameSync(path.join(src, sf), path.join(dest, sf));
              }
              fs.rmdirSync(src);
            } else {
              fs.renameSync(src, dest);
            }
          }
          fs.rmdirSync(oldFolder);
        } else {
          fs.renameSync(oldFolder, newFolder);
        }
        console.log(`[RENAME] Folder: ${oldFolder} -> ${newFolder}`);

        // Re-index local_path for all generations by this user
        const oldPrefix = sanitizeFolderName(oldName) + "/";
        const newPrefix = sanitizeFolderName(newName) + "/";
        const userGens = db.select({ id: generations.id, localPath: generations.localPath })
          .from(generations)
          .where(eq(generations.userId, user.id))
          .all();
        for (const g of userGens) {
          if (g.localPath && g.localPath.startsWith(oldPrefix)) {
            const updatedPath = newPrefix + g.localPath.slice(oldPrefix.length);
            db.update(generations).set({ localPath: updatedPath }).where(eq(generations.id, g.id)).run();
          }
        }
        console.log(`[RENAME] Re-indexed ${userGens.filter(g => g.localPath?.startsWith(oldPrefix)).length} local_path entries`);
      }
    } catch (e) { console.error("[RENAME] Folder rename error:", e); }

    // Update ID3 tags in all MP3 files for this author
    try {
      const NodeID3 = require('node-id3');
      const userGensForId3 = db.select().from(generations).where(
        and(eq(generations.userId, user.id), sql`${generations.type} = 'music' AND ${generations.localPath} IS NOT NULL`)
      ).all();
      let id3Updated = 0;
      for (const g of userGensForId3) {
        const mp3Path = path.join(AUTHORS_DIR, g.localPath!);
        if (fs.existsSync(mp3Path)) {
          const tags = NodeID3.read(mp3Path);
          tags.artist = `MuzaAi \u00b7 ${newName}`;
          if (g.displayTitle) tags.title = g.displayTitle;
          NodeID3.update(tags, mp3Path);
          id3Updated++;
        }
      }
      console.log(`[RENAME] Updated ID3 tags in ${id3Updated} MP3 files`);
    } catch (e) { console.error("[RENAME] ID3 update error:", e); }

    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.send(`
      <html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Имя изменено</title></head>
      <body style="font-family:-apple-system,sans-serif;background:#09090b;color:#e0e0e0;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0">
        <div style="text-align:center;padding:32px">
          <h2 style="background:linear-gradient(135deg,#8b5cf6,#3b82f6);-webkit-background-clip:text;-webkit-text-fill-color:transparent">✔ Имя успешно изменено!</h2>
          <p style="color:#888;margin-bottom:8px">Теперь вы: <b style="color:#e0e0e0">${newName}</b></p>
          <p style="color:#888">Имя обновлено во всех плейлистах и опубликованных треках.</p>
          <a href="${PUBLIC_URL}/#/dashboard" style="display:inline-block;margin-top:16px;padding:10px 24px;background:linear-gradient(135deg,#8b5cf6,#3b82f6);color:white;text-decoration:none;border-radius:10px;font-weight:600">В личный кабинет</a>
        </div>
      </body></html>
    `);
  });

  // Public track page
  app.get("/api/track/:id", (req: Request, res: Response) => {
    res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate");
    res.setHeader("Pragma", "no-cache");
    const gen = db.select().from(generations).where(eq(generations.id, parseInt(req.params.id))).get();
    if (!gen) {
      res.status(404).json({ message: "Трек не найден" });
      return;
    }
    // BACKEND-6 fix Eugene 14:23: privacy check. Не-публичные треки доступны
    // только владельцу. Раньше любой мог по ID увидеть приватный трек.
    // Eugene 2026-05-20 (C5 fix): добавлен admin override + cookie fallback.
    if (gen.isPublic !== 1) {
      const cookieToken = (() => {
        const raw = req.headers.cookie || '';
        const m = raw.match(/(?:^|;\s*)auth_token=([^;]+)/);
        return m ? decodeURIComponent(m[1]) : '';
      })();
      const authHeader = req.headers.authorization;
      let token = '';
      if (typeof authHeader === "string" && authHeader.startsWith("Bearer ")) token = authHeader.slice(7);
      if (!token) token = cookieToken;
      let viewerId: number | null = null;
      if (token) {
        try {
          const row = db.get<{ userId: number }>(
            sql`SELECT user_id as userId FROM sessions WHERE token = ${token} LIMIT 1`,
          );
          viewerId = row?.userId ?? null;
        } catch {}
      }
      const viewer = viewerId ? storage.getUser(viewerId) : null;
      if (!isAdminUser(viewer) && viewerId !== gen.userId) {
        res.status(403).json({ message: "Этот трек приватный" });
        return;
      }
    }
    // Возвращаем 200 со статусом для processing/error — клиент покажет
    // прогресс / причину вместо «не найден» и продолжит опрос.
    if (gen.status !== "done" || !gen.resultUrl) {
      res.json({
        id: gen.id,
        status: gen.status, // "processing" | "error" | "pending" | ...
        errorReason: gen.errorReason || null,
        prompt: gen.displayTitle || gen.prompt,
        createdAt: gen.createdAt,
        publishedAt: (gen as any).publishedAt || null,
        taskId: gen.taskId || null,
      });
      return;
    }
    // Track info is accessible by ID (used by share pages, track page)
    // Get author name
    const author = db.select().from(users).where(eq(users.id, gen.userId)).get();
    // Use coverGenId if present, otherwise Suno image
    let imageUrl: string | null = null;
    if (gen.coverGenId) {
      imageUrl = `/api/stream/${gen.coverGenId}`;
    } else {
      try {
        const data = JSON.parse(gen.resultData || "{}");
        if (Array.isArray(data.result) && data.result[0]?.image_url) {
          imageUrl = `/api/stream/${gen.id}?type=image`;
        }
      } catch {}
    }
    // Parse style meta for human-readable info
    let styleInfo = "";
    let category = "song";
    let baseStyle = "";
    let fullStyle = "";
    let isBonus = false;
    let bonusFromGenId: number | null = null;
    try {
      const m = JSON.parse(gen.style || "{}");
      baseStyle = m.style || "";
      fullStyle = m.fullStyle || m.style || "";
      category = m.category || "song";
      styleInfo = humanizeStyle(fullStyle);
      isBonus = !!m.isBonus;
      bonusFromGenId = m.bonusFromGenId ?? null;
    } catch {}
    // Extract lyrics from Suno resultData
    let lyrics = "";
    try {
      const data = JSON.parse(gen.resultData || "{}");
      if (Array.isArray(data.result) && data.result[0]?.lyric) {
        lyrics = data.result[0].lyric;
      } else if (data.lyric) {
        lyrics = data.lyric;
      }
    } catch {}
    res.json({
      id: gen.id,
      status: "done",
      type: gen.type,
      prompt: gen.displayTitle || gen.prompt,
      audioUrl: `/api/stream/${gen.id}`,
      imageUrl,
      authorName: gen.authorName || author?.name || "Аноним",
      createdAt: gen.createdAt,
      publishedAt: (gen as any).publishedAt || null,
      lyrics,
      isBonus,
      bonusFromGenId,
      styleInfo,
      baseStyle,
      fullStyle,
      category,
      isPublic: gen.isPublic,
    });
  });

  // Helper: try to serve a local file, return true if served
  function tryServeLocal(gen: any, wantImage: boolean, res: Response, asDownload?: string): boolean {
    // Determine the local file path
    let localFile: string | null = null;
    if (wantImage) {
      // Eugene 2026-05-09: плейлист рендерит обложки через /api/stream/:id?type=image.
      // Используем тот же fallback что и в /api/cover/:id.jpg — иначе обложки
      // тех gens, у которых localPath=null или указывает на не-сохранённый mp3,
      // не находятся, и UI показывает значок ноты.
      const resolved = resolveCoverPath(gen);
      if (resolved) localFile = resolved;
    } else if (gen.localPath) {
      const cand = path.join(AUTHORS_DIR, gen.localPath);
      if (fs.existsSync(cand)) localFile = cand;
    }
    if (!localFile || !fs.existsSync(localFile)) return false;

    const ext = path.extname(localFile).toLowerCase();
    const ctMap: Record<string, string> = { ".mp3": "audio/mpeg", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png", ".webp": "image/webp", ".txt": "text/plain; charset=utf-8" };
    const ct = ctMap[ext] || "application/octet-stream";
    const stat = fs.statSync(localFile);
    // Eugene 2026-05-19 Триумф 1905: iOS Safari требует Accept-Ranges + Range
    // support для audio scrubbing (perevotka). Без него <audio> может
    // показать «Ошибка» даже на корректный 200 OK с полным файлом.
    res.setHeader("Accept-Ranges", "bytes");
    res.setHeader("Content-Type", ct);
    res.setHeader("Cache-Control", "public, max-age=86400");
    if (asDownload) {
      const asciiName = asDownload.replace(/[^\x20-\x7E]/g, "_");
      res.setHeader("Content-Disposition", `attachment; filename="${asciiName}"; filename*=UTF-8''${encodeURIComponent(asDownload)}`);
    }
    // Range request support (iOS Safari/audio scrubbing)
    const range = res.req.headers.range;
    if (range && /^bytes=\d*-\d*$/.test(range)) {
      const parts = range.replace(/bytes=/, "").split("-");
      const start = parseInt(parts[0]) || 0;
      const end = parts[1] ? parseInt(parts[1]) : stat.size - 1;
      const chunkSize = end - start + 1;
      res.status(206);
      res.setHeader("Content-Range", `bytes ${start}-${end}/${stat.size}`);
      res.setHeader("Content-Length", chunkSize);
      const stream = fs.createReadStream(localFile, { start, end });
      stream.pipe(res);
    } else {
      res.setHeader("Content-Length", stat.size);
      const stream = fs.createReadStream(localFile);
      stream.pipe(res);
    }
    return true;
  }

  // ==================== DOWNLOAD PROXY ====================
  app.get("/api/download/:id", async (req: Request, res: Response) => {
    try {
      const gen = db.select().from(generations).where(eq(generations.id, parseInt(req.params.id))).get();
      if (!gen || gen.status !== "done" || !gen.resultUrl) {
        res.status(404).json({ message: "Файл не найден" });
        return;
      }
      // Eugene 2026-05-18 IDOR-fix (ACCESS-BYPASS-AUDIT-170526 #1):
      // приватные треки (isPublic=0) — только владелец/админ.
      // Bearer/cookie/?token= для случаев, когда юзер вошёл в кабинет.
      if ((gen.isPublic ?? 0) === 0) {
        const dlToken = (req.headers.authorization || '').replace('Bearer ', '') || (req.query.token as string) || '';
        const dlUserId = dlToken ? tokenStore.get(dlToken) : undefined;
        const dlUser = dlUserId ? storage.getUser(dlUserId) : null;
        if (!isAdminUser(dlUser) && gen.userId !== dlUserId) {
          res.status(403).json({ message: "Приватный трек" });
          return;
        }
      }
      logGenActivity(gen.id, 'download', req.ip, extractHost(req));
      // Increment download count in style JSON
      try {
        let meta: any = {};
        try { meta = JSON.parse(gen.style || "{}"); } catch {}
        meta.downloads = (meta.downloads || 0) + 1;
        meta.lastDownloaded = new Date().toISOString();
        db.update(generations).set({ style: JSON.stringify(meta) }).where(eq(generations.id, gen.id)).run();
      } catch {}
      const ext = gen.type === "cover" ? "png" : gen.type === "lyrics" ? "txt" : "mp3";
      // Build filename: MuzaAi.ru - {title}.ext
      let trackName = gen.displayTitle || "";
      if (!trackName && gen.prompt) {
        trackName = gen.prompt.split(/[\s,.:;!?]+/).filter(Boolean).slice(0, 3).join(" ");
      }
      trackName = trackName.replace(/[^\w\s\-().а-яА-ЯёЁ]/g, "").trim() || `track-${gen.id}`;
      trackName = trackName.substring(0, 60);
      const filename = `MuzaAi.ru - ${trackName}.${ext}`;

      // For music: embed cover art in ID3 tags before sending
      if (gen.type === "music" && gen.localPath) {
        const mp3Path = path.join(AUTHORS_DIR, gen.localPath);
        const jpgPath = mp3Path.replace(/\.mp3$/, ".jpg");
        if (fs.existsSync(mp3Path)) {
          try {
            const mp3Buffer = fs.readFileSync(mp3Path);
            const authorName = gen.authorName || "";
            const title = gen.displayTitle || gen.prompt?.slice(0, 80) || "MuzaAi Track";
            const tags: any = {
              title,
              artist: authorName ? `MuzaAi \u00b7 ${authorName}` : 'MuzaAi',
              album: "MuzaAi.ru",
              comment: { language: "rus", text: PUBLIC_URL },
            };
            if (fs.existsSync(jpgPath)) {
              const coverFile = resolveCoverPath(gen) || (fs.existsSync(jpgPath) ? jpgPath : null);
              if (coverFile) {
                let coverBuf = fs.readFileSync(coverFile);
                try { coverBuf = await addWatermark(coverBuf); } catch {}
                tags.image = { mime: "image/jpeg", type: { id: 3, name: "front cover" }, description: "Cover", imageBuffer: coverBuf };
              }
            }
            const taggedBuffer = NodeID3.write(tags, mp3Buffer);
            const asciiName = filename.replace(/[^\x20-\x7E]/g, "_");
            res.setHeader("Content-Type", "audio/mpeg");
            res.setHeader("Content-Length", taggedBuffer.length);
            res.setHeader("Content-Disposition", `attachment; filename="${asciiName}"; filename*=UTF-8''${encodeURIComponent(filename)}`);
            res.send(taggedBuffer);
            return;
          } catch (e) {
            console.error("[DOWNLOAD] ID3 tag error:", e);
          }
        }
      }

      // Try local file first (fallback without ID3)
      if (tryServeLocal(gen, false, res, filename)) return;

      // Fallback to remote URL
      const variantIdx = parseInt(req.query.variant as string || "0") || 0;
      let url = gen.resultUrl;
      try {
        const data = JSON.parse(gen.resultData || "{}");
        if (Array.isArray(data.result)) {
          const track = data.result[variantIdx];
          if (track?.audio_url) url = track.audio_url;
          else if (data.result[0]?.audio_url) url = data.result[0].audio_url;
        }
      } catch {}

      if (url.includes("/exp48h/") || url.includes("/exp24h/")) {
        res.status(404).json({ message: "Файл истёк" });
        return;
      }

      const upstream = await fetch(url);
      if (!upstream.ok) {
        res.status(502).json({ message: "Файл недоступен" });
        return;
      }
      const asciiFn = filename.replace(/[^\x20-\x7E]/g, "_");
      res.setHeader("Content-Disposition", `attachment; filename="${asciiFn}"; filename*=UTF-8''${encodeURIComponent(filename)}`);
      res.setHeader("Content-Type", upstream.headers.get("content-type") || "application/octet-stream");
      const buffer = await upstream.arrayBuffer();
      res.send(Buffer.from(buffer));
    } catch (e: any) {
      res.status(500).json({ message: e.message });
    }
  });

  // Helper: resolve cover file path for a generation
  // Eugene 2026-05-09: AGGRESSIVE FALLBACK — индекс по gen.id для всех
  // image-расширений в любой подпапке AUTHORS_DIR. Был длинный путь
  // багов (3 root cause подряд) — теперь проще и громче: при каждом
  // resolveCoverPath проверяем максимально широкий набор паттернов имён.
  // Кэш 5 мин, инвалидация через /api/admin/v304/covers/refresh-index.
  // ИНДЕКС ВКЛЮЧАЕТ: gen_<id>.{jpg,jpeg,png,webp} И <id>.{jpg,jpeg,png,webp}
  let __coverIndex: Map<number, string> | null = null;
  let __coverIndexAt = 0;
  const __COVER_INDEX_TTL_MS = 5 * 60 * 1000;
  function getCoverIndex(): Map<number, string> {
    const now = Date.now();
    if (__coverIndex && now - __coverIndexAt < __COVER_INDEX_TTL_MS) return __coverIndex;
    const idx = new Map<number, string>();
    try {
      for (const sub of fs.readdirSync(AUTHORS_DIR)) {
        const subPath = path.join(AUTHORS_DIR, sub);
        try {
          if (!fs.statSync(subPath).isDirectory()) continue;
          for (const f of fs.readdirSync(subPath)) {
            const m = f.match(/^(?:gen_)?(\d+)\.(jpg|jpeg|png|webp)$/i);
            if (m) {
              const id = parseInt(m[1], 10);
              if (!idx.has(id)) idx.set(id, path.join(subPath, f));
            }
          }
        } catch {}
      }
    } catch {}
    __coverIndex = idx;
    __coverIndexAt = now;
    return idx;
  }
  (globalThis as any).__refreshJpgIndex = () => { __coverIndex = null; __coverIndexAt = 0; };

  // Diagnostic helper — возвращает массив всех попыток поиска (для cover-debug endpoint)
  function probeCoverPath(gen: any): { tried: Array<{ branch: string; path: string; exists: boolean }>; matched: string | null } {
    const tried: Array<{ branch: string; path: string; exists: boolean }> = [];
    const tryPath = (branch: string, p: string): string | null => {
      const exists = fs.existsSync(p);
      tried.push({ branch, path: p, exists });
      return exists ? p : null;
    };

    // 1. coverGenId → его localPath напрямую
    if (gen.coverGenId) {
      const cover = db.select().from(generations).where(eq(generations.id, gen.coverGenId)).get();
      if (cover?.localPath) {
        const m = tryPath("coverGenId.localPath", path.join(AUTHORS_DIR, cover.localPath));
        if (m) return { tried, matched: m };
      } else {
        tried.push({ branch: "coverGenId.localPath", path: "(cover gen has no localPath)", exists: false });
      }
    }

    // 2. own localPath с заменой расширения на .jpg/.png/.webp/.jpeg
    if (gen.localPath) {
      for (const ext of ["jpg", "jpeg", "png", "webp"]) {
        const m = tryPath(`localPath→.${ext}`, path.join(AUTHORS_DIR, gen.localPath.replace(/\.[^.]+$/, `.${ext}`)));
        if (m) return { tried, matched: m };
      }
      // Для type=cover localPath сам по себе — это уже изображение
      if (gen.type === "cover") {
        const m = tryPath("type=cover.localPath", path.join(AUTHORS_DIR, gen.localPath));
        if (m) return { tried, matched: m };
      }
    }

    // 3. Жесткий fallback по индексу <id>.<ext>
    const byId = getCoverIndex().get(gen.id);
    if (byId) {
      const m = tryPath("coverIndex[id]", byId);
      if (m) return { tried, matched: m };
    } else {
      tried.push({ branch: "coverIndex[id]", path: "(not in index)", exists: false });
    }

    // 4. Жесткий fallback по индексу coverGenId.<ext> (на случай если cover gen имеет файл, но не localPath)
    if (gen.coverGenId) {
      const byCoverId = getCoverIndex().get(gen.coverGenId);
      if (byCoverId) {
        const m = tryPath("coverIndex[coverGenId]", byCoverId);
        if (m) return { tried, matched: m };
      } else {
        tried.push({ branch: "coverIndex[coverGenId]", path: "(not in index)", exists: false });
      }
    }

    return { tried, matched: null };
  }

  function resolveCoverPath(gen: any): string | null {
    return probeCoverPath(gen).matched;
  }

  // Helper: add MuzaAi watermark to image buffer
  async function addWatermark(imgBuf: Buffer): Promise<Buffer> {
    try {
      const sharp = require('sharp');
      const img = sharp(imgBuf);
      const meta = await img.metadata();
      const w = meta.width || 512;
      const h = meta.height || 512;
      const wmW = Math.round(w * 0.35);
      const wmH = Math.round(wmW * 0.2);
      const wmSvg = `<svg width="${wmW}" height="${wmH}" xmlns="http://www.w3.org/2000/svg">
        <defs><linearGradient id="lb" x1="0" y1="0" x2="1" y2="1"><stop offset="0%" stop-color="#7c3aed"/><stop offset="100%" stop-color="#3b82f6"/></linearGradient></defs>
        <rect x="0" y="${wmH*0.15}" width="${wmH*0.7}" height="${wmH*0.7}" rx="${wmH*0.15}" fill="url(#lb)" opacity="0.6"/>
        <path d="M ${wmH*0.18} ${wmH*0.5} Q ${wmH*0.28} ${wmH*0.3} ${wmH*0.35} ${wmH*0.5} Q ${wmH*0.42} ${wmH*0.7} ${wmH*0.52} ${wmH*0.5}" stroke="white" stroke-width="${Math.max(1.5,wmH*0.06)}" fill="none" stroke-linecap="round" opacity="0.8"/>
        <text x="${wmH*0.8}" y="${wmH*0.7}" font-family="-apple-system,sans-serif" font-weight="800" font-size="${wmH*0.55}" opacity="0.5">
          <tspan fill="#c4b5fd">Muza</tspan><tspan fill="#60a5fa">Ai</tspan>
        </text>
      </svg>`;
      return img.composite([{ input: Buffer.from(wmSvg), gravity: 'south', blend: 'over' }]).jpeg({ quality: 90 }).toBuffer();
    } catch { return imgBuf; }
  }

  // Eugene 2026-05-09: тестовая отправка email через текущий SMTP-канал.
  // Использование: POST/GET /api/admin/v304/email-test?to=<address>
  // Возвращает: { sent, to, messageId, accepted, rejected, response }.
  // Если SMTP сломан — error с текстом ошибки nodemailer'а.
  const emailTestHandler = async (req: Request, res: Response) => {
    const to = (req.query.to as string) || ((req.body as any)?.to as string) || "";
    if (!to || !/.+@.+\..+/.test(to)) {
      return res.status(400).json({ data: null, error: "?to=<valid-email> required" });
    }
    try {
      const info = await mailTransport.sendMail({
        from: `"MuzaAi" <${CLIENT_EMAIL}>`,
        replyTo: CLIENT_EMAIL,
        to,
        subject: "MuzaAi — тест почты",
        text:
          `Это тестовое письмо от MuzaAi.\n\n` +
          `Время отправки: ${new Date().toISOString()}\n` +
          `Получатель: ${to}\n` +
          `Если вы получили это сообщение — SMTP работает.\n\n— MuzaAi`,
      });
      res.json({
        data: {
          sent: true,
          to,
          messageId: info.messageId || null,
          accepted: info.accepted || [],
          rejected: info.rejected || [],
          response: info.response || null,
          envelope: info.envelope || null,
        },
        error: null,
      });
    } catch (e) {
      console.error(`[email-test] failed to=${to}:`, e instanceof Error ? e.message : e);
      res.status(500).json({
        data: { sent: false, to },
        error: e instanceof Error ? e.message : String(e),
      });
    }
  };
  app.get("/api/admin/v304/email-test", requireAdmin, emailTestHandler);
  app.post("/api/admin/v304/email-test", requireAdmin, emailTestHandler);

  // ==================== SONG DRAFTS (Eugene 2026-05-11) ====================
  // Юзер сохраняет идеи/тексты будущих песен в личный кабинет, редактирует
  // позже, нажимает «Сгенерировать» → /music с pre-filled полями.

  app.get("/api/drafts", authMiddleware, (req: Request, res: Response) => {
    try {
      const userId = (req as any).userId;
      const rows = db.select().from(songDrafts).where(eq(songDrafts.userId, userId)).orderBy(desc(songDrafts.updatedAt)).all();
      res.json({ data: rows });
    } catch (e: any) {
      console.error("[DRAFTS GET] Error:", e);
      res.status(500).json({ error: "Не удалось загрузить черновики" });
    }
  });

  app.post("/api/drafts", authMiddleware, (req: Request, res: Response) => {
    try {
      const userId = (req as any).userId;
      const { title, lyrics, prompt, style, voice, mood, tempo, bpm, source } = req.body || {};
      const now = new Date().toISOString();
      const row = db.insert(songDrafts).values({
        userId,
        title: title ? String(title).slice(0, 200) : null,
        lyrics: lyrics ? String(lyrics).slice(0, 6000) : null,
        prompt: prompt ? String(prompt).slice(0, 2000) : null,
        style: style ? String(style).slice(0, 100) : null,
        voice: voice ? String(voice).slice(0, 30) : null,
        mood: mood ? String(mood).slice(0, 50) : null,
        tempo: tempo ? String(tempo).slice(0, 30) : null,
        bpm: bpm ? Number(bpm) || null : null,
        source: source ? String(source).slice(0, 30) : null,
        createdAt: now,
        updatedAt: now,
      }).returning().get();
      res.json({ data: row });
    } catch (e: any) {
      console.error("[DRAFTS POST] Error:", e);
      res.status(500).json({ error: "Не удалось сохранить черновик" });
    }
  });

  app.put("/api/drafts/:id", authMiddleware, (req: Request, res: Response) => {
    try {
      const userId = (req as any).userId;
      const id = parseInt(req.params.id);
      const draft = db.select().from(songDrafts).where(eq(songDrafts.id, id)).get();
      if (!draft || draft.userId !== userId) {
        res.status(404).json({ error: "Черновик не найден" });
        return;
      }
      const { title, lyrics, prompt, style, voice, mood, tempo, bpm } = req.body || {};
      db.update(songDrafts).set({
        title: title !== undefined ? (title ? String(title).slice(0, 200) : null) : draft.title,
        lyrics: lyrics !== undefined ? (lyrics ? String(lyrics).slice(0, 6000) : null) : draft.lyrics,
        prompt: prompt !== undefined ? (prompt ? String(prompt).slice(0, 2000) : null) : draft.prompt,
        style: style !== undefined ? (style ? String(style).slice(0, 100) : null) : draft.style,
        voice: voice !== undefined ? (voice ? String(voice).slice(0, 30) : null) : draft.voice,
        mood: mood !== undefined ? (mood ? String(mood).slice(0, 50) : null) : draft.mood,
        tempo: tempo !== undefined ? (tempo ? String(tempo).slice(0, 30) : null) : draft.tempo,
        bpm: bpm !== undefined ? (bpm ? Number(bpm) || null : null) : draft.bpm,
        updatedAt: new Date().toISOString(),
      }).where(eq(songDrafts.id, id)).run();
      const updated = db.select().from(songDrafts).where(eq(songDrafts.id, id)).get();
      res.json({ data: updated });
    } catch (e: any) {
      console.error("[DRAFTS PUT] Error:", e);
      res.status(500).json({ error: "Не удалось обновить" });
    }
  });

  app.delete("/api/drafts/:id", authMiddleware, (req: Request, res: Response) => {
    try {
      const userId = (req as any).userId;
      const id = parseInt(req.params.id);
      const draft = db.select().from(songDrafts).where(eq(songDrafts.id, id)).get();
      if (!draft || draft.userId !== userId) {
        res.status(404).json({ error: "Черновик не найден" });
        return;
      }
      db.delete(songDrafts).where(eq(songDrafts.id, id)).run();
      res.json({ ok: true });
    } catch (e: any) {
      console.error("[DRAFTS DELETE] Error:", e);
      res.status(500).json({ error: "Не удалось удалить" });
    }
  });

  // Bot learnings (Eugene 2026-05-11): самообучение помощника.
  // Eugene 2026-05-14 Босс: backfill правила «1000 первых из РФ + ближнее
  // зарубежье» для уже зарегистрированных юзеров. Идемпотентно (через
  // welcomeGiftGiven=1 marker). Geo lookup — сначала по сохранённой
  // visitors row, потом по в случае отсутствия — через ip-api.
  app.post("/api/admin/v304/welcome-gift-backfill", requireAdmin, async (_req: Request, res: Response) => {
    try {
      const giftCountRow = db.select({ c: sql<number>`COUNT(*)` })
        .from(users)
        .where(eq(users.welcomeGiftGiven, 1))
        .get();
      let giftedSoFar = Number(giftCountRow?.c || 0);
      if (giftedSoFar >= WELCOME_GIFT_LIMIT) {
        res.json({ ok: true, message: "Лимит 1000 уже исчерпан", giftedSoFar, giftedNow: 0, total: 0 });
        return;
      }

      // Берём ВСЕХ юзеров без welcomeGiftGiven, отсортированных по id ASC
      // (ранние регистрации получают первыми). Лимитируем выборку чтобы
      // не упереться в N+1 на больших БД.
      const eligibleUsers = db.select()
        .from(users)
        .where(eq(users.welcomeGiftGiven, 0))
        .orderBy(users.id)
        .all();

      let giftedNow = 0;
      let total = eligibleUsers.length;
      const raw = (db as any).$client;

      for (const u of eligibleUsers) {
        if (giftedSoFar >= WELCOME_GIFT_LIMIT) break;

        // Determine country: priority — already saved on user, else visitors row, else skip
        let countryCode: string | null = u.countryCode || null;
        let country: string | null = u.country || null;
        if (!countryCode) {
          const v = db.select().from(visitors)
            .where(and(eq(visitors.userId, u.id), isNotNull(visitors.countryCode)))
            .orderBy(desc(visitors.lastVisit))
            .limit(1)
            .get();
          if (v?.countryCode) {
            countryCode = v.countryCode;
            country = v.country || null;
          }
        }

        if (!isCISCountry(countryCode)) continue;

        // Race-safe: атомарная проверка limit + apply внутри transaction.
        const result = raw.transaction(() => {
          const row = raw.prepare("SELECT COUNT(*) AS c FROM users WHERE welcome_gift_given = 1").get() as { c: number };
          const c = Number(row?.c || 0);
          if (c >= WELCOME_GIFT_LIMIT) return { applied: false, position: c };
          if (!u.countryCode || !u.country) {
            raw.prepare("UPDATE users SET country = COALESCE(?, country), country_code = COALESCE(?, country_code) WHERE id = ?")
              .run(country || u.country || null, countryCode || u.countryCode || null, u.id);
          }
          const upd = raw.prepare("UPDATE users SET bonus_tracks = bonus_tracks + 1, welcome_gift_given = 1 WHERE id = ? AND welcome_gift_given = 0").run(u.id);
          if (upd.changes === 0) return { applied: false, position: c };
          return { applied: true, position: c + 1 };
        })();

        if (result.applied) {
          storage.createTransaction({
            userId: u.id,
            type: "topup",
            amount: 0,
            description: `🎁 Подарочный трек (backfill): первые 1000 из РФ и ближнего зарубежья (#${result.position} из 1000)`,
          });
          giftedSoFar = result.position;
          giftedNow++;
        } else {
          giftedSoFar = result.position;
        }
      }

      res.json({ ok: true, total, giftedNow, giftedSoFar, limit: WELCOME_GIFT_LIMIT });
    } catch (e: any) {
      console.error("[WELCOME-GIFT-BACKFILL]", e);
      res.status(500).json({ ok: false, error: String(e) });
    }
  });

  app.get("/api/admin/v304/bot-learnings", requireAdmin, (_req: Request, res: Response) => {
    try {
      const rows = db.select().from(botLearnings).orderBy(desc(botLearnings.createdAt)).limit(50).all();
      res.json({ ok: true, data: rows });
    } catch (e: any) {
      res.status(500).json({ ok: false, error: String(e) });
    }
  });

  app.put("/api/admin/v304/bot-learnings/:id", requireAdmin, (req: Request, res: Response) => {
    try {
      const id = parseInt(req.params.id);
      const applied = req.body?.applied === 1 || req.body?.applied === true ? 1 : 0;
      db.update(botLearnings).set({ applied }).where(eq(botLearnings.id, id)).run();
      res.json({ ok: true });
    } catch (e: any) {
      res.status(500).json({ ok: false, error: String(e) });
    }
  });

  // Engagement stats (Eugene 2026-05-11): воронка вовлечения для admin
  // dashboard. ?days=30 daily breakdown + summary today/period/total.
  app.get("/api/admin/v304/engagement-stats", requireAdmin, (req: Request, res: Response) => {
    try {
      const days = Math.min(90, Math.max(1, parseInt(String(req.query.days || "30")) || 30));
      const summary = getEngagementSummary(Math.min(days, 30));
      const daily = getEngagementDaily(days);
      res.json({ ok: true, days, summary, daily });
    } catch (e: any) {
      console.error("[ENGAGEMENT-STATS] Error:", e);
      res.status(500).json({ ok: false, error: String(e) });
    }
  });

  // Eugene 2026-05-14 Босс «заведи папку заместителей». Делегирование
  // прав админа по email. Только админ может управлять списком.
  app.get("/api/admin/v304/delegates", requireAdmin, (_req: Request, res: Response) => {
    try {
      const rows = db.select().from(adminDelegates).orderBy(desc(adminDelegates.id)).all();
      res.json({ ok: true, delegates: rows });
    } catch (e: any) {
      console.error("[DELEGATES list]", e);
      res.status(500).json({ ok: false, error: String(e) });
    }
  });

  app.post("/api/admin/v304/delegates", requireAdmin, (req: Request, res: Response) => {
    try {
      const userId = (req as any).userId;
      const adminUser = storage.getUser(userId);
      const email = String(req.body?.email || "").trim().toLowerCase();
      const name = String(req.body?.name || "").trim() || null;
      const note = String(req.body?.note || "").trim() || null;
      const expiresAt = req.body?.expiresAt ? String(req.body.expiresAt) : null;
      if (!email || !/^\S+@\S+\.\S+$/.test(email)) {
        res.status(400).json({ ok: false, error: "Email обязателен" });
        return;
      }
      const existing = db.select().from(adminDelegates).where(eq(adminDelegates.email, email)).get();
      if (existing) {
        // Re-activate если был отозван
        db.update(adminDelegates).set({
          name, note, expiresAt,
          revoked: 0, revokedAt: null, revokedReason: null,
          grantedByEmail: adminUser?.email || null,
          grantedAt: new Date().toISOString(),
        }).where(eq(adminDelegates.id, existing.id)).run();
      } else {
        db.insert(adminDelegates).values({
          email, name, note, expiresAt,
          grantedByEmail: adminUser?.email || null,
        }).run();
      }
      res.json({ ok: true });
    } catch (e: any) {
      console.error("[DELEGATES add]", e);
      res.status(500).json({ ok: false, error: String(e) });
    }
  });

  app.delete("/api/admin/v304/delegates/:id", requireAdmin, (req: Request, res: Response) => {
    try {
      const id = parseInt(req.params.id);
      const reason = String(req.body?.reason || "").trim() || "отозван админом";
      db.update(adminDelegates).set({
        revoked: 1,
        revokedAt: new Date().toISOString(),
        revokedReason: reason,
      }).where(eq(adminDelegates.id, id)).run();
      res.json({ ok: true });
    } catch (e: any) {
      console.error("[DELEGATES revoke]", e);
      res.status(500).json({ ok: false, error: String(e) });
    }
  });

  // Eugene 2026-05-14 Босс «в админке указывай сколько токенов обошелся чат».
  // Возвращает агрегированные in/out tokens + цену в USD и рублях.
  app.get("/api/admin/v304/muza-token-stats", requireAdmin, (_req: Request, res: Response) => {
    const inUsd = (muzaTokenStats.inputTokens / 1_000_000) * TOKEN_PRICE.inputPer1M_USD;
    const outUsd = (muzaTokenStats.outputTokens / 1_000_000) * TOKEN_PRICE.outputPer1M_USD;
    const totalUsd = inUsd + outUsd;
    const totalRub = totalUsd * TOKEN_PRICE.rubPerUSD;
    res.json({
      ok: true,
      sinceStartedAt: muzaTokenStats.sinceStartedAt,
      callsCount: muzaTokenStats.callsCount,
      inputTokens: muzaTokenStats.inputTokens,
      outputTokens: muzaTokenStats.outputTokens,
      totalTokens: muzaTokenStats.inputTokens + muzaTokenStats.outputTokens,
      pricing: TOKEN_PRICE,
      cost: {
        inputUSD: Number(inUsd.toFixed(4)),
        outputUSD: Number(outUsd.toFixed(4)),
        totalUSD: Number(totalUsd.toFixed(4)),
        totalRUB: Number(totalRub.toFixed(2)),
      },
      avgPerCall: muzaTokenStats.callsCount > 0 ? {
        tokens: Math.round((muzaTokenStats.inputTokens + muzaTokenStats.outputTokens) / muzaTokenStats.callsCount),
        rub: Number((totalRub / muzaTokenStats.callsCount).toFixed(2)),
      } : null,
      note: "Счётчик с момента запуска сервера (in-memory). После pm2 restart обнуляется. Включает cache_read_input_tokens (cache hit удешевляет)."
    });
  });

  // Eugene 2026-05-14 Босс «при публикации автором админ видит список
  // треков, подтверждает в основной/поздравлений плейлист или возвращает
  // с reason». Pending = isPublic=2. Approve → 1 + pool. Reject → 0 + reason.
  app.get("/api/admin/v304/pending-publications", requireAdmin, (_req: Request, res: Response) => {
    try {
      const raw = (db as any).$client;
      const rows = raw.prepare(`
        SELECT g.id, g.user_id, g.type, g.prompt, g.display_title, g.author_name,
               g.cover_gen_id, g.created_at, g.published_at, g.style, g.pool,
               u.name AS user_name, u.email AS user_email
        FROM generations g
        LEFT JOIN users u ON u.id = g.user_id
        WHERE g.is_public = 2 AND g.deleted_at IS NULL
        ORDER BY g.id DESC LIMIT 200
      `).all();
      // Также — треки которые «взлетели» в плейлисте (>30 plays) — кандидаты
      // на перевод из greetings → main.
      const trending = raw.prepare(`
        SELECT g.id, g.display_title, g.author_name, g.pool, g.is_public,
               u.name AS user_name
        FROM generations g
        LEFT JOIN users u ON u.id = g.user_id
        WHERE g.is_public = 1 AND g.pool = 'greetings'
          AND g.type = 'music' AND g.deleted_at IS NULL
        ORDER BY g.id DESC LIMIT 50
      `).all().map((r: any) => {
        let plays = 0;
        try { plays = JSON.parse(r.style || "{}").plays || 0; } catch {}
        return { ...r, plays };
      }).filter((r: any) => r.plays >= 30);
      res.json({ ok: true, pending: rows, trending });
    } catch (e: any) {
      console.error("[PENDING-PUB]", e);
      res.status(500).json({ ok: false, error: String(e) });
    }
  });

  app.post("/api/admin/v304/publications/:id/approve", requireAdmin, (req: Request, res: Response) => {
    try {
      const id = parseInt(req.params.id);
      const pool = req.body?.pool === "greetings" ? "greetings" : "main";
      const gen = db.select().from(generations).where(eq(generations.id, id)).get();
      if (!gen) { res.status(404).json({ ok: false, error: "Не найдено" }); return; }
      // Mark as approved + assign pool. Ставим approvedOnce в style для
      // последующего auto-publish без re-модерации.
      let meta: any = {};
      try { meta = JSON.parse(gen.style || "{}"); } catch {}
      meta.approvedOnce = true;
      // Eugene 2026-05-17: publishedAt при первой публикации (0→1 через v304 модерацию).
      const approvePatch: any = {
        isPublic: 1,
        pool,
        style: JSON.stringify(meta),
        rejectionReason: null,
      };
      if ((gen.isPublic ?? 0) === 0 && !(gen as any).publishedAt) {
        approvePatch.publishedAt = new Date().toISOString();
      }
      db.update(generations).set(approvePatch).where(eq(generations.id, id)).run();
      res.json({ ok: true, pool });
    } catch (e: any) {
      console.error("[PUB-APPROVE]", e);
      res.status(500).json({ ok: false, error: String(e) });
    }
  });

  app.post("/api/admin/v304/publications/:id/reject", requireAdmin, (req: Request, res: Response) => {
    try {
      const id = parseInt(req.params.id);
      const reason = String(req.body?.reason || "").trim() || "Без указания причины";
      db.update(generations).set({
        isPublic: 0,
        rejectionReason: reason,
      } as any).where(eq(generations.id, id)).run();
      res.json({ ok: true });
    } catch (e: any) {
      console.error("[PUB-REJECT]", e);
      res.status(500).json({ ok: false, error: String(e) });
    }
  });

  // Eugene 2026-05-14 Босс «при присвоении имени трека проверять совпадения».
  // Поиск дубликатов имени среди опубликованных done music-треков.
  app.get("/api/generations/check-title", (req: Request, res: Response) => {
    try {
      const title = String(req.query.title || "").trim();
      if (!title || title.length < 2) {
        res.json({ ok: true, matches: [] });
        return;
      }
      const raw = (db as any).$client;
      const rows = raw.prepare(`
        SELECT id, display_title, author_name, is_public, created_at
        FROM generations
        WHERE type = 'music' AND status = 'done' AND deleted_at IS NULL
          AND lower(COALESCE(display_title, '')) = lower(?)
        ORDER BY id DESC LIMIT 5
      `).all(title);
      res.json({ ok: true, matches: rows, hasDuplicate: rows.length > 0 });
    } catch (e: any) {
      console.error("[CHECK-TITLE]", e);
      res.status(500).json({ ok: false, error: String(e) });
    }
  });

  // Eugene 2026-05-14 Босс «отчёт по Ярс — собирай сообщения из Telegram
  // где начинается с Ярс, применяй как правила бота».
  // Сканирует все user-сообщения содержащие «Ярс», группирует по сессиям,
  // извлекает текст после ключевого слова — это потенциальное правило.
  // Eugene 2026-05-20 Босс «"Новые авторы" — кто зарегистрируется после 20.05.
  // Все 16 действующих юзеров до 20.05 — в основной плейлист». Backfill: для
  // всех established-авторов (created_at < cutoff) — все их published треки
  // (is_public=1 или =2) → переключаем в is_public=1. Приватные (=0) не трогаем.
  app.post("/api/admin/v304/backfill-authors-cutoff", requireAdmin, (req: Request, res: Response) => {
    try {
      const dryRun = String(req.query.dryRun || req.body?.dryRun || "") === "1";
      const NEW_AUTHORS_CUTOFF_ISO = "2026-05-20T00:00:00.000Z";
      const raw = (db as any).$client;

      // 1. Established-авторы — created_at < cutoff
      const candidates: any[] = raw.prepare(`
        SELECT g.id, g.user_id, g.is_public, g.display_title, g.created_at AS gen_created,
               u.created_at AS user_created, u.name AS author_name
        FROM generations g
        JOIN users u ON u.id = g.user_id
        WHERE g.type = 'music'
          AND g.status = 'done'
          AND g.is_public = 2
          AND g.deleted_at IS NULL
          AND u.created_at < ?
        ORDER BY g.id DESC
      `).all(NEW_AUTHORS_CUTOFF_ISO);

      const summary = {
        cutoff: NEW_AUTHORS_CUTOFF_ISO,
        candidatesFound: candidates.length,
        usersAffected: new Set(candidates.map(c => c.user_id)).size,
        dryRun,
        moved: 0,
        sampleIds: candidates.slice(0, 10).map((c: any) => ({
          id: c.id,
          userId: c.user_id,
          authorName: c.author_name,
          title: String(c.display_title || "").slice(0, 50),
        })),
      };

      if (!dryRun && candidates.length > 0) {
        const ids = candidates.map(c => c.id);
        const placeholders = ids.map(() => "?").join(",");
        const result: any = raw.prepare(`
          UPDATE generations
          SET is_public = 1
          WHERE id IN (${placeholders})
        `).run(...ids);
        summary.moved = Number(result?.changes ?? 0);

        // Audit-log
        try {
          (db as any).$client.prepare(`
            INSERT INTO admin_audit_log (admin_user_id, admin_email, action, entity, entity_key, before_json, after_json)
            VALUES (?, 'backfill-authors-cutoff', 'update', 'generations:is_public_bulk', 'cutoff-2026-05-20',
                    ?, ?)
          `).run(
            (req as any).userId ?? null,
            JSON.stringify({ candidateIds: ids.slice(0, 50), totalCandidates: ids.length, prevValue: 2 }),
            JSON.stringify({ newValue: 1, moved: summary.moved }),
          );
        } catch {}
      }

      res.json({ ok: true, ...summary });
    } catch (e: any) {
      console.error("[backfill-authors-cutoff]", e);
      res.status(500).json({ ok: false, error: String(e?.message || e) });
    }
  });

  // Eugene 2026-05-21 Босс «считай прослушивания админа и автора в общей массе,
  // примени правило к предыдущим». Backfill — конвертирует прошлые
  // 'play_rejected:author-self' и 'play_rejected:admin' в реальный play +
  // bumps meta.plays на соответствующее количество.
  // Применять один раз (idempotent — повторный запуск ничего не делает,
  // т.к. action уже изменён).
  app.post("/api/admin/v304/backfill-author-admin-plays", requireAdmin, (req: Request, res: Response) => {
    try {
      const dryRun = String(req.query.dryRun || req.body?.dryRun || "") === "1";
      const raw = (db as any).$client;

      // 1. Найти все rejected записи author-self / admin
      const rejected: any[] = raw.prepare(`
        SELECT gen_id, action, COUNT(*) AS cnt
        FROM gen_activity
        WHERE action IN ('play_rejected:author-self', 'play_rejected:admin')
        GROUP BY gen_id, action
      `).all();

      // 2. Aggregate per gen_id
      const perGen = new Map<number, number>();
      for (const r of rejected) {
        perGen.set(r.gen_id, (perGen.get(r.gen_id) || 0) + Number(r.cnt));
      }

      const summary = {
        dryRun,
        rejectedRowsFound: rejected.reduce((s, r) => s + Number(r.cnt), 0),
        gensAffected: perGen.size,
        playsAdded: 0,
        gensSample: Array.from(perGen.entries()).slice(0, 10).map(([id, c]) => ({ genId: id, addPlays: c })),
      };

      if (!dryRun && perGen.size > 0) {
        const tx = raw.transaction(() => {
          for (const [genId, addPlays] of perGen.entries()) {
            // bump meta.plays
            const row: any = raw.prepare(`SELECT style FROM generations WHERE id = ?`).get(genId);
            if (!row) continue;
            let meta: any = {};
            try { meta = JSON.parse(row.style || "{}"); } catch { meta = {}; }
            meta.plays = (meta.plays || 0) + addPlays;
            raw.prepare(`UPDATE generations SET style = ? WHERE id = ?`).run(JSON.stringify(meta), genId);
            summary.playsAdded += addPlays;
          }
          // Mark rejected → 'play' so future stats include them
          raw.prepare(`
            UPDATE gen_activity SET action = 'play'
            WHERE action IN ('play_rejected:author-self', 'play_rejected:admin')
          `).run();
        });
        tx();

        // Audit-log
        try {
          raw.prepare(`
            INSERT INTO admin_audit_log (admin_user_id, admin_email, action, entity, entity_key, before_json, after_json)
            VALUES (?, 'backfill-author-admin-plays', 'update', 'generations:meta_plays_bulk', 'rule-update-2026-05-21',
                    ?, ?)
          `).run(
            (req as any).userId ?? null,
            JSON.stringify({ rule: "exclude author-self + admin" }),
            JSON.stringify({ rule: "count all (author + admin in общей массе)", gensAffected: perGen.size, playsAdded: summary.playsAdded }),
          );
        } catch {}

        // Invalidate plays-stats cache (если есть) + SSE push
        try { (global as any)._playsStatsCache = null; } catch {}
        try { (global as any).__broadcastPlaysStats?.(); } catch {}
      }

      res.json({ ok: true, ...summary });
    } catch (e: any) {
      console.error("[backfill-author-admin-plays]", e);
      res.status(500).json({ ok: false, error: String(e?.message || e) });
    }
  });

  // Eugene 2026-05-20 Босс «Веди базу сообщений админа в боте Муза».
  // Каждое admin-сообщение в Музa-чат (web/inject) — здесь, с gate-статусом
  // (authorized/mismatch) и executor-результатом (applied/appliedAction).
  app.get("/api/admin/v304/admin-chat-messages", requireAdmin, (req: Request, res: Response) => {
    try {
      const raw = (db as any).$client;
      const limit = Math.min(Number(req.query.limit) || 100, 500);
      const onlyAuthorized = String(req.query.authorized || "") === "1";
      const channel = req.query.channel ? String(req.query.channel).slice(0, 20) : null;
      const where: string[] = [];
      const params: any[] = [];
      if (onlyAuthorized) where.push("authorized = 1");
      if (channel) { where.push("channel = ?"); params.push(channel); }
      const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";
      const rows = raw.prepare(`
        SELECT id, session_id, user_id, channel, text, ip, role,
               authorized, authorization_mismatch, applied, applied_action,
               created_at
        FROM admin_chat_messages
        ${whereSql}
        ORDER BY id DESC
        LIMIT ?
      `).all(...params, limit);
      const summary = raw.prepare(`
        SELECT
          COUNT(*) AS total,
          SUM(CASE WHEN authorized = 1 THEN 1 ELSE 0 END) AS authorized,
          SUM(CASE WHEN applied = 1 THEN 1 ELSE 0 END) AS applied,
          SUM(CASE WHEN authorized = 0 THEN 1 ELSE 0 END) AS mismatched
        FROM admin_chat_messages
        WHERE created_at > datetime('now', '-7 days')
      `).get();
      res.json({
        ok: true,
        summary,
        envInfo: {
          trustedIpsConfigured: Boolean((process.env.ADMIN_TRUSTED_IPS || "").trim()),
          trustedIpsCount: String(process.env.ADMIN_TRUSTED_IPS || "").split(",").filter((s: string) => s.trim()).length,
        },
        messages: rows.map((r: any) => ({
          id: r.id,
          sessionId: r.session_id,
          userId: r.user_id,
          channel: r.channel,
          text: String(r.text || "").slice(0, 500),
          ip: r.ip,
          role: r.role,
          authorized: r.authorized === 1,
          mismatch: r.authorization_mismatch,
          applied: r.applied === 1,
          appliedAction: r.applied_action ? (() => { try { return JSON.parse(r.applied_action); } catch { return null; } })() : null,
          createdAt: r.created_at,
        })),
      });
    } catch (e) {
      console.error("[admin-chat-messages]", e);
      res.status(500).json({ ok: false, error: "internal error" });
    }
  });

  // ============================================================================
  // USER MEMORY — Eugene 2026-05-20 Босс User-memory-context rule
  // ============================================================================
  //
  // Музa держит контекст общения с авторизованным юзером. Сжимает воду —
  // оставляет главное. См. CLAUDE.md → User-memory-context rule.
  //
  // 2 юзерских endpoint'а + 5 админских.

  // GET /api/account/memory — юзер видит свою память
  app.get("/api/account/memory", authMiddleware, async (req: Request, res: Response) => {
    try {
      const userId = (req as any).userId as number;
      const memory = await getUserMemory(userId);
      res.json({
        data: {
          summary: memory.summary,
          facts: memory.facts,
          preferences: memory.preferences,
          lastUpdated: memory.lastUpdatedAt,
          messageCount: memory.messageCountSummarized,
          version: memory.version,
        },
        error: null,
      });
    } catch (e: any) {
      console.error("[user-memory:get]", e);
      res.status(500).json({ data: null, error: "Не удалось загрузить память" });
    }
  });

  // POST /api/account/memory/forget — юзер удаляет свою память
  app.post("/api/account/memory/forget", authMiddleware, async (req: Request, res: Response) => {
    try {
      const userId = (req as any).userId as number;
      const u = storage.getUser(userId);
      const email = (u as any)?.email || null;
      const deleted = forgetUserMemory(userId, { adminEmail: email ? `user-self-forget:${email}` : "user-self-forget" });
      res.json({ data: { ok: true, deleted }, error: null });
    } catch (e: any) {
      console.error("[user-memory:forget]", e);
      res.status(500).json({ data: null, error: "Не удалось забыть" });
    }
  });

  // Eugene 2026-05-20: Max deep-link linking. Юзер из dashboard жмёт
  // «Подключить Max-бот» → этот endpoint создаёт одноразовый nonce (24h TTL)
  // + возвращает deep-link URL `<MAX_BOT_LINK>?start=link_<nonce>`. После
  // клика юзер открывает Max → /start link_<nonce> → max-bot.consumeMaxLinkNonce
  // линкует maxUserId к users.id.
  app.post("/api/account/max/start-link", authMiddleware, (req: Request, res: Response) => {
    try {
      const userId = (req as any).userId as number;
      const u = storage.getUser(userId);
      if (!u) { res.status(401).json({ data: null, error: "unauthorized" }); return; }

      // Если уже привязан — возвращаем флаг + bot link для перехода в чат
      if ((u as any).maxUserId) {
        const botLink = process.env.MAX_BOT_LINK || "https://max.ru";
        res.json({ data: { alreadyLinked: true, maxUserId: (u as any).maxUserId, botUrl: botLink }, error: null });
        return;
      }

      const crypto = require("node:crypto");
      const nonce = crypto.randomBytes(24).toString("hex");
      const nowMs = Date.now();
      const expiresAt = nowMs + 24 * 60 * 60 * 1000; // 24h

      const raw = (db as any).$client;
      // Cleanup старых unused nonces для этого юзера (max 5 active)
      try {
        raw.prepare(`DELETE FROM max_link_nonces WHERE user_id = ? AND used_at IS NULL AND expires_at < ?`).run(userId, nowMs);
      } catch {}
      raw.prepare(`INSERT INTO max_link_nonces (nonce, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)`).run(nonce, userId, nowMs, expiresAt);

      const botLink = process.env.MAX_BOT_LINK || "https://max.ru";
      // Формат deep-link зависит от Max API — пробуем оба варианта
      const deepLink = botLink.includes("?")
        ? `${botLink}&start=link_${nonce}`
        : `${botLink}?start=link_${nonce}`;

      res.json({ data: { nonce, deepLink, expiresAt, botUrl: botLink }, error: null });
    } catch (e: any) {
      console.error("[max:start-link]", e);
      res.status(500).json({ data: null, error: "Не удалось создать ссылку" });
    }
  });

  // GET /api/account/max/status — проверка привязан ли Max
  app.get("/api/account/max/status", authMiddleware, (req: Request, res: Response) => {
    try {
      const userId = (req as any).userId as number;
      const u = storage.getUser(userId);
      const linked = !!(u as any)?.maxUserId;
      res.json({ data: { linked, maxUserId: linked ? (u as any).maxUserId : null, botUrl: process.env.MAX_BOT_LINK || null }, error: null });
    } catch (e: any) {
      res.status(500).json({ data: null, error: "Не удалось проверить статус" });
    }
  });

  // POST /api/account/max/unlink — отвязать Max от аккаунта
  app.post("/api/account/max/unlink", authMiddleware, (req: Request, res: Response) => {
    try {
      const userId = (req as any).userId as number;
      const raw = (db as any).$client;
      raw.prepare("UPDATE users SET max_user_id = NULL WHERE id = ?").run(userId);
      res.json({ data: { ok: true }, error: null });
    } catch (e: any) {
      res.status(500).json({ data: null, error: "Не удалось отвязать" });
    }
  });

  // GET /api/admin/v304/user-memory — список юзеров с памятью
  app.get("/api/admin/v304/user-memory", requireAdmin, (req: Request, res: Response) => {
    try {
      const limit = Number(req.query.limit) || 50;
      const offset = Number(req.query.offset) || 0;
      const search = req.query.search ? String(req.query.search) : undefined;
      const { users: list, total } = listUserMemories({ limit, offset, search });
      res.json({ ok: true, users: list, total });
    } catch (e: any) {
      console.error("[admin user-memory:list]", e);
      res.status(500).json({ ok: false, error: String(e?.message || e) });
    }
  });

  // GET /api/admin/v304/user-memory/:userId — полные детали по юзеру
  app.get("/api/admin/v304/user-memory/:userId", requireAdmin, async (req: Request, res: Response) => {
    try {
      const userId = Number(req.params.userId);
      if (!Number.isFinite(userId) || userId <= 0) {
        res.status(400).json({ ok: false, error: "bad userId" });
        return;
      }
      const u = storage.getUser(userId);
      if (!u) {
        res.status(404).json({ ok: false, error: "user not found" });
        return;
      }
      const [memory, cabinet, recentMessages] = await Promise.all([
        getUserMemory(userId),
        getCabinetSnapshot(userId),
        Promise.resolve(getRecentMessagesForUser(userId, 20)),
      ]);
      res.json({
        ok: true,
        memory: {
          userId,
          summary: memory.summary,
          facts: memory.facts,
          preferences: memory.preferences,
          lastUpdated: memory.lastUpdatedAt,
          messageCount: memory.messageCountSummarized,
          version: memory.version,
        },
        user: {
          id: userId,
          name: u.name,
          email: u.email,
          createdAt: u.createdAt,
        },
        cabinetSnapshot: cabinet,
        recentMessages,
      });
    } catch (e: any) {
      console.error("[admin user-memory:detail]", e);
      res.status(500).json({ ok: false, error: String(e?.message || e) });
    }
  });

  // POST /api/admin/v304/user-memory/:userId/recompress — force-trigger
  app.post("/api/admin/v304/user-memory/:userId/recompress", requireAdmin, async (req: Request, res: Response) => {
    try {
      const userId = Number(req.params.userId);
      if (!Number.isFinite(userId) || userId <= 0) {
        res.status(400).json({ ok: false, error: "bad userId" });
        return;
      }
      const result = await compressUserMemory(userId);
      res.json({
        ok: result.ok,
        version: result.version,
        beforeSummary: result.beforeSummary,
        afterSummary: result.afterSummary,
      });
    } catch (e: any) {
      console.error("[admin user-memory:recompress]", e);
      res.status(500).json({ ok: false, error: String(e?.message || e) });
    }
  });

  // Eugene 2026-05-21 Босс: backfill памяти для ВСЕХ юзеров с историей чата.
  // POST /api/admin/v304/user-memory/backfill-all?minMessages=5
  // Пройдёт по всем users у кого есть chatbot_messages role='user' >= minMessages
  // и triggerит compressUserMemory. Возвращает stats. Sequential — не параллелим
  // LLM calls чтобы не выжечь rate limit.
  app.post("/api/admin/v304/user-memory/backfill-all", requireAdmin, async (req: Request, res: Response) => {
    try {
      const minMessages = Math.max(1, parseInt(String(req.query.minMessages || "5"), 10));
      const rawSql: any = (db as any).$client || sqliteDb;
      const rows = rawSql.prepare(
        `SELECT s.user_id AS userId, COUNT(*) AS cnt
         FROM chatbot_messages m
         INNER JOIN chatbot_sessions s ON s.id = m.session_id
         WHERE s.user_id IS NOT NULL AND m.role = 'user'
         GROUP BY s.user_id
         HAVING cnt >= ?
         ORDER BY cnt DESC`
      ).all(minMessages) as Array<{ userId: number; cnt: number }>;

      const { compressUserMemory } = await import("./lib/userMemory");
      const results: Array<{ userId: number; messages: number; ok: boolean; error?: string }> = [];
      for (const r of rows) {
        try {
          const result = await compressUserMemory(r.userId);
          results.push({ userId: r.userId, messages: r.cnt, ok: !!result.ok, error: result.error });
        } catch (e: any) {
          results.push({ userId: r.userId, messages: r.cnt, ok: false, error: String(e?.message || e).slice(0, 150) });
        }
      }
      res.json({
        ok: true,
        candidates: rows.length,
        succeeded: results.filter(r => r.ok).length,
        failed: results.filter(r => !r.ok).length,
        results,
      });
    } catch (e: any) {
      console.error("[admin user-memory:backfill-all]", e);
      res.status(500).json({ ok: false, error: String(e?.message || e) });
    }
  });

  // PUT /api/admin/v304/user-memory/:userId — manual edit
  app.put("/api/admin/v304/user-memory/:userId", requireAdmin, async (req: Request, res: Response) => {
    try {
      const userId = Number(req.params.userId);
      if (!Number.isFinite(userId) || userId <= 0) {
        res.status(400).json({ ok: false, error: "bad userId" });
        return;
      }
      const adminUser = (req as any).adminUser as { email?: string } | undefined;
      const adminUserId = (req as any).userId as number | undefined;
      const patch: any = {};
      if (typeof req.body?.summary === "string") patch.summary = req.body.summary;
      if (req.body?.facts && typeof req.body.facts === "object") patch.facts = req.body.facts;
      if (req.body?.preferences && typeof req.body.preferences === "object") patch.preferences = req.body.preferences;
      if (Object.keys(patch).length === 0) {
        res.status(400).json({ ok: false, error: "Нужно хотя бы одно поле для обновления" });
        return;
      }
      const result = await updateUserMemoryAdmin(userId, patch, {
        adminEmail: adminUser?.email || undefined,
        adminUserId: adminUserId ?? null,
      });
      if (!result) {
        res.status(500).json({ ok: false, error: "update failed" });
        return;
      }
      res.json({ ok: true, version: result.version, memory: {
        summary: result.summary,
        facts: result.facts,
        preferences: result.preferences,
        lastUpdated: result.lastUpdatedAt,
        version: result.version,
      }});
    } catch (e: any) {
      console.error("[admin user-memory:put]", e);
      res.status(500).json({ ok: false, error: String(e?.message || e) });
    }
  });

  // DELETE /api/admin/v304/user-memory/:userId — с confirm
  app.delete("/api/admin/v304/user-memory/:userId", requireAdmin, async (req: Request, res: Response) => {
    try {
      const userId = Number(req.params.userId);
      if (!Number.isFinite(userId) || userId <= 0) {
        res.status(400).json({ ok: false, error: "bad userId" });
        return;
      }
      if (req.body?.confirm !== true) {
        res.status(400).json({ ok: false, error: "Нужно подтверждение: confirm: true" });
        return;
      }
      const adminUser = (req as any).adminUser as { email?: string } | undefined;
      const adminUserId = (req as any).userId as number | undefined;
      const deleted = forgetUserMemory(userId, {
        adminEmail: adminUser?.email || "admin-delete",
        adminUserId: adminUserId ?? null,
      });
      res.json({ ok: true, deleted });
    } catch (e: any) {
      console.error("[admin user-memory:delete]", e);
      res.status(500).json({ ok: false, error: String(e?.message || e) });
    }
  });

  app.get("/api/admin/v304/yars-rules", requireAdmin, (_req: Request, res: Response) => {
    try {
      const raw = (db as any).$client;
      // Все user-сообщения с Ярс (web + telegram + max)
      const rows = raw.prepare(`
        SELECT m.id, m.session_id, m.text, m.created_at,
               cs.channel, cs.persona_name, cs.user_id
        FROM chatbot_messages m
        JOIN chatbot_sessions cs ON cs.id = m.session_id
        WHERE m.role = 'user' AND lower(m.text) LIKE '%ярс%'
        ORDER BY m.id DESC
        LIMIT 200
      `).all();

      // Извлекаем «правило» — текст после слова «Ярс»
      const extractRule = (text: string): string => {
        const m = text.match(/(?:^|[\s.,!?])ярс[\s.,:!?]*(.+)/i);
        if (m && m[1]) return m[1].trim().slice(0, 500);
        return text.slice(0, 500); // fallback — всё сообщение
      };

      const rules = rows.map((r: any) => ({
        id: r.id,
        sessionId: String(r.session_id).slice(0, 16),
        channel: r.channel,
        rule: extractRule(r.text),
        rawText: r.text.slice(0, 500),
        createdAt: r.created_at,
        applied: 0, // TODO: интегрировать с bot_learnings.applied
      }));

      // Stats
      const byChannel: Record<string, number> = {};
      rules.forEach((r: any) => { byChannel[r.channel] = (byChannel[r.channel] || 0) + 1; });

      res.json({
        ok: true,
        total: rules.length,
        byChannel,
        rules,
        hint: "Правила извлекаются из user-сообщений содержащих «Ярс». Применение в system prompt — следующим push'ом.",
      });
    } catch (e: any) {
      console.error("[YARS-RULES]", e);
      res.status(500).json({ ok: false, error: String(e) });
    }
  });

  // Eugene 2026-05-14 Босс «в дашборде количество и тех и других»:
  // отчёт по регистрациям с разбивкой СНГ vs не-СНГ + welcome-gift counter
  // (правило 1000 первых из РФ + ближнего зарубежья).
  app.get("/api/admin/v304/registration-stats", requireAdmin, (_req: Request, res: Response) => {
    try {
      const raw = (db as any).$client;
      const cisList = Array.from(CIS_COUNTRY_CODES);
      const cisPlaceholders = cisList.map(() => "?").join(",");

      const total = Number(raw.prepare("SELECT COUNT(*) AS c FROM users WHERE email_verified = 1").get()?.c || 0);
      const cisCount = Number(raw.prepare(`SELECT COUNT(*) AS c FROM users WHERE email_verified = 1 AND country_code IN (${cisPlaceholders})`).get(...cisList)?.c || 0);
      const nonCisCount = Number(raw.prepare(`SELECT COUNT(*) AS c FROM users WHERE email_verified = 1 AND country_code IS NOT NULL AND country_code != '' AND country_code NOT IN (${cisPlaceholders})`).get(...cisList)?.c || 0);
      const unknownCount = Number(raw.prepare("SELECT COUNT(*) AS c FROM users WHERE email_verified = 1 AND (country_code IS NULL OR country_code = '')").get()?.c || 0);
      const giftedCount = Number(raw.prepare("SELECT COUNT(*) AS c FROM users WHERE welcome_gift_given = 1").get()?.c || 0);

      // Распределение по странам (топ 30)
      const byCountry = raw.prepare(`
        SELECT country, country_code, COUNT(*) AS n,
               SUM(welcome_gift_given) AS gifted
        FROM users
        WHERE email_verified = 1 AND country_code IS NOT NULL AND country_code != ''
        GROUP BY country_code
        ORDER BY n DESC
        LIMIT 30
      `).all().map((r: any) => ({
        ...r,
        isCIS: CIS_COUNTRY_CODES.has(String(r.country_code).toUpperCase()),
      }));

      res.json({
        ok: true,
        total,
        cis: cisCount,
        nonCis: nonCisCount,
        unknown: unknownCount,
        giftedCount,
        giftLimit: WELCOME_GIFT_LIMIT,
        giftRemaining: Math.max(0, WELCOME_GIFT_LIMIT - giftedCount),
        cisCountryCodes: cisList,
        byCountry,
      });
    } catch (e: any) {
      console.error("[REGISTRATION-STATS]", e);
      res.status(500).json({ ok: false, error: String(e) });
    }
  });

  // Eugene 2026-05-14 Босс «в админе блок бот с подробной статистикой».
  // Расширенная аналитика по чату Музы для дашборда.
  app.get("/api/admin/v304/bot-stats", requireAdmin, (_req: Request, res: Response) => {
    try {
      const raw = (db as any).$client;
      const today = new Date().toISOString().slice(0, 10);
      const yesterday = new Date(Date.now() - 86400_000).toISOString().slice(0, 10);
      const weekAgo = new Date(Date.now() - 7 * 86400_000).toISOString();
      const monthAgo = new Date(Date.now() - 30 * 86400_000).toISOString();

      // Сессии: total / today / yesterday / 7d / 30d
      const sessions = {
        total: Number(raw.prepare("SELECT COUNT(*) AS c FROM chatbot_sessions").get()?.c || 0),
        today: Number(raw.prepare("SELECT COUNT(*) AS c FROM chatbot_sessions WHERE date(started_at) = ?").get(today)?.c || 0),
        yesterday: Number(raw.prepare("SELECT COUNT(*) AS c FROM chatbot_sessions WHERE date(started_at) = ?").get(yesterday)?.c || 0),
        week: Number(raw.prepare("SELECT COUNT(*) AS c FROM chatbot_sessions WHERE started_at > ?").get(weekAgo)?.c || 0),
        month: Number(raw.prepare("SELECT COUNT(*) AS c FROM chatbot_sessions WHERE started_at > ?").get(monthAgo)?.c || 0),
      };

      // Сообщения: total / today / by-role
      const messages = {
        total: Number(raw.prepare("SELECT COUNT(*) AS c FROM chatbot_messages").get()?.c || 0),
        today: Number(raw.prepare("SELECT COUNT(*) AS c FROM chatbot_messages WHERE date(created_at) = ?").get(today)?.c || 0),
        userToday: Number(raw.prepare("SELECT COUNT(*) AS c FROM chatbot_messages WHERE date(created_at) = ? AND role = 'user'").get(today)?.c || 0),
        botToday: Number(raw.prepare("SELECT COUNT(*) AS c FROM chatbot_messages WHERE date(created_at) = ? AND role = 'bot'").get(today)?.c || 0),
        avgPerSession: Number(raw.prepare("SELECT ROUND(AVG(c), 1) AS a FROM (SELECT session_id, COUNT(*) AS c FROM chatbot_messages GROUP BY session_id)").get()?.a || 0),
      };

      // Channel breakdown
      const channels = raw.prepare(`
        SELECT channel, COUNT(*) AS sessions, AVG(visit_count) AS avg_visits
        FROM chatbot_sessions
        GROUP BY channel
        ORDER BY sessions DESC
      `).all();

      // Top persons
      const personas = raw.prepare(`
        SELECT persona_name AS name, COUNT(*) AS sessions
        FROM chatbot_sessions
        WHERE persona_name IS NOT NULL
        GROUP BY persona_name
        ORDER BY sessions DESC
        LIMIT 10
      `).all();

      // Eugene 2026-05-14 Босс «отчёт пишет 2 конверсии — чем подтверждено?».
      // Подсчёт по 2 критериям + краткое explanation:
      // - linkedSessions: chatbot_sessions.user_id IS NOT NULL — юзер был
      //   залогинен ИЛИ /verify-register linked сессию по email после регистрации.
      // - registeredAfterChat: юзер был создан ПОСЛЕ начала сессии (т.е. чат
      //   реально привёл к регистрации, а не просто открыт уже-юзером).
      const conversion = raw.prepare(`
        SELECT COUNT(*) AS total,
               SUM(CASE WHEN cs.user_id IS NOT NULL THEN 1 ELSE 0 END) AS linkedSessions,
               SUM(CASE WHEN cs.user_id IS NOT NULL AND u.created_at > cs.started_at THEN 1 ELSE 0 END) AS registeredAfterChat
        FROM chatbot_sessions cs
        LEFT JOIN users u ON u.id = cs.user_id
      `).get();
      // Eugene 2026-05-14 Босс «для меня это генерация чего-нибудь за деньги».
      // НАСТОЯЩАЯ конверсия — сессия → платная генерация. SQL: distinct
      // sessions где userId связан с payment-transaction после старта сессии.
      const paidConversion = raw.prepare(`
        SELECT COUNT(DISTINCT cs.id) AS paidSessions,
               COUNT(DISTINCT t.id) AS paidTransactions,
               SUM(ABS(t.amount)) AS totalRevenueKopecks
        FROM chatbot_sessions cs
        JOIN transactions t ON t.user_id = cs.user_id
        WHERE cs.user_id IS NOT NULL
          AND t.amount < 0
          AND t.created_at > cs.started_at
          AND t.type IN ('music', 'cover', 'lyrics')
      `).get();

      // Активность сейчас — сессии с сообщением за последние 5 минут
      const active5min = Number(raw.prepare(`
        SELECT COUNT(DISTINCT session_id) AS c FROM chatbot_messages
        WHERE created_at > datetime('now', '-5 minutes')
      `).get()?.c || 0);

      // Daily breakdown за 30 дней — sessions + messages per day
      const daily = raw.prepare(`
        SELECT date(started_at) AS day, COUNT(*) AS sessions
        FROM chatbot_sessions
        WHERE started_at > ?
        GROUP BY day
        ORDER BY day DESC
        LIMIT 30
      `).all(monthAgo);

      // Топ городов из visitors авторов которые писали в чат
      const realCities = raw.prepare(`
        SELECT v.city, v.country, v.country_code, COUNT(DISTINCT cs.id) AS sessions
        FROM chatbot_sessions cs
        JOIN visitors v ON v.user_id = cs.user_id
        WHERE cs.user_id IS NOT NULL AND v.city IS NOT NULL AND v.city != ''
        GROUP BY v.city
        ORDER BY sessions DESC
        LIMIT 10
      `).all();

      // Eugene 2026-05-15 Босс «в панели города рисуй Россию и известные
      // города мира, миксуй». Дополняем реальные «showcase»-городами для
      // визуального богатства (когда реальных мало). Mock-sessions
      // детерминированы на основе текущего дня — стабильно за день,
      // обновляются ежедневно.
      const day = Math.floor(Date.now() / (24 * 3600 * 1000));
      const seedRand = (n: number) => Math.abs((day * 9301 + n * 49297) % 233280) / 233280;
      const showcase: Array<{ city: string; country: string; country_code: string }> = [
        { city: "Москва", country: "Россия", country_code: "RU" },
        { city: "Санкт-Петербург", country: "Россия", country_code: "RU" },
        { city: "Казань", country: "Россия", country_code: "RU" },
        { city: "Новосибирск", country: "Россия", country_code: "RU" },
        { city: "Екатеринбург", country: "Россия", country_code: "RU" },
        { city: "Краснодар", country: "Россия", country_code: "RU" },
        { city: "Сочи", country: "Россия", country_code: "RU" },
        { city: "Минск", country: "Беларусь", country_code: "BY" },
        { city: "Алматы", country: "Казахстан", country_code: "KZ" },
        { city: "Ташкент", country: "Узбекистан", country_code: "UZ" },
        { city: "Лондон", country: "Великобритания", country_code: "GB" },
        { city: "Нью-Йорк", country: "США", country_code: "US" },
        { city: "Париж", country: "Франция", country_code: "FR" },
        { city: "Токио", country: "Япония", country_code: "JP" },
        { city: "Дубай", country: "ОАЭ", country_code: "AE" },
        { city: "Стамбул", country: "Турция", country_code: "TR" },
      ];
      const realCityNames = new Set(realCities.map((c: any) => c.city));
      const mockCities = showcase
        .filter(s => !realCityNames.has(s.city))
        .map((s, i) => ({
          ...s,
          sessions: Math.max(1, Math.round(seedRand(i + 1) * 30) + 1),
          mock: true,
        }));
      // Mix: реальные сверху (по sessions DESC), затем mock-городы
      // интерливятся по убыванию sessions. Limit 16 на отдачу.
      const cities = [
        ...realCities,
        ...mockCities,
      ].sort((a: any, b: any) => b.sessions - a.sessions).slice(0, 16);

      // Pair-codes выданные (cross-channel feature)
      const pairCodes = {
        issued: Number(raw.prepare("SELECT COUNT(*) AS c FROM chatbot_sessions WHERE web_pair_code IS NOT NULL").get()?.c || 0),
        offered: Number(raw.prepare("SELECT COUNT(*) AS c FROM chatbot_sessions WHERE web_pair_code_offered_at IS NOT NULL").get()?.c || 0),
      };

      // Latest 5 sessions для quick-glance
      const latest = raw.prepare(`
        SELECT cs.id, cs.channel, cs.persona_name, cs.user_id, cs.started_at, cs.last_message_at,
               (SELECT COUNT(*) FROM chatbot_messages WHERE session_id = cs.id) AS msg_count,
               (SELECT text FROM chatbot_messages WHERE session_id = cs.id AND role = 'user' ORDER BY id DESC LIMIT 1) AS last_user_msg
        FROM chatbot_sessions cs
        ORDER BY last_message_at DESC
        LIMIT 5
      `).all();

      res.json({
        ok: true,
        sessions,
        messages,
        channels,
        personas,
        conversion: {
          total: conversion?.total || 0,
          converted: conversion?.linkedSessions || 0,
          linkedSessions: conversion?.linkedSessions || 0,
          registeredAfterChat: conversion?.registeredAfterChat || 0,
          paidSessions: paidConversion?.paidSessions || 0,
          paidTransactions: paidConversion?.paidTransactions || 0,
          totalRevenueRub: Math.round((paidConversion?.totalRevenueKopecks || 0) / 100),
          rate: conversion?.total ? Math.round(((conversion?.linkedSessions || 0) / conversion.total) * 100) : 0,
          rateAfterChat: conversion?.total ? Math.round(((conversion?.registeredAfterChat || 0) / conversion.total) * 100) : 0,
          ratePaid: conversion?.total ? Math.round(((paidConversion?.paidSessions || 0) / conversion.total) * 100) : 0,
          explanation: "linked = chat-сессия имеет user_id. registeredAfterChat = регистрация ПОСЛЕ старта чата. paid = СЕССИЯ → платная генерация (music/cover/lyrics списание) ПОСЛЕ старта = настоящая конверсия в выручку.",
        },
        active5min,
        daily,
        cities,
        pairCodes,
        latest,
      });
    } catch (e: any) {
      console.error("[BOT-STATS]", e);
      res.status(500).json({ ok: false, error: String(e) });
    }
  });

  // Chat funnel (Eugene 2026-05-12): сводный отчёт по чатам для админа.
  // Воронка: всего сессий → с 2+ сообщений → конвертированы (linked user).
  // Разрез по personas (рейтинг продаж) и каналам.
  app.get("/api/admin/v304/chat-funnel", requireAdmin, (req: Request, res: Response) => {
    try {
      const days = Math.min(90, Math.max(1, parseInt(String(req.query.days || "30")) || 30));
      const sinceFilter = `datetime('now', '-${days} days')`;

      // Общие метрики
      const totals = db.get<any>(sql.raw(`
        SELECT
          COUNT(*) AS sessions,
          SUM(CASE WHEN msg_count >= 2 THEN 1 ELSE 0 END) AS multi_msg,
          SUM(CASE WHEN user_id IS NOT NULL THEN 1 ELSE 0 END) AS converted,
          ROUND(AVG(msg_count), 1) AS avg_msgs,
          ROUND(AVG(duration_min), 1) AS avg_min,
          ROUND(MAX(duration_min), 1) AS max_min,
          ROUND(SUM(duration_min), 0) AS total_min
        FROM (
          SELECT cs.id, cs.user_id,
            (SELECT COUNT(*) FROM chatbot_messages WHERE session_id = cs.id AND role = 'user') AS msg_count,
            (julianday(cs.last_message_at) - julianday(cs.started_at)) * 24 * 60 AS duration_min
          FROM chatbot_sessions cs
          WHERE cs.last_message_at >= ${sinceFilter}
        )
      `));

      // По personas — рейтинг
      const byPersona = db.all<any>(sql.raw(`
        SELECT
          COALESCE(cs.persona_name, '—') AS persona,
          COUNT(*) AS sessions,
          SUM(CASE WHEN (SELECT COUNT(*) FROM chatbot_messages WHERE session_id = cs.id AND role = 'user') >= 2 THEN 1 ELSE 0 END) AS multi_msg,
          SUM(CASE WHEN cs.user_id IS NOT NULL THEN 1 ELSE 0 END) AS converted,
          ROUND(AVG((SELECT COUNT(*) FROM chatbot_messages WHERE session_id = cs.id AND role = 'user')), 1) AS avg_msgs
        FROM chatbot_sessions cs
        WHERE cs.last_message_at >= ${sinceFilter}
        GROUP BY persona
        ORDER BY converted DESC, multi_msg DESC
      `)) as any[];

      // По городам (Eugene 2026-05-12) — JOIN с visitors через user_id.
      const byCity = db.all<any>(sql.raw(`
        SELECT
          COALESCE(v.city, '—') AS city,
          COALESCE(v.country, '—') AS country,
          COUNT(DISTINCT cs.id) AS sessions,
          SUM(CASE WHEN cs.user_id IS NOT NULL THEN 1 ELSE 0 END) AS converted
        FROM chatbot_sessions cs
        LEFT JOIN visitors v ON v.user_id = cs.user_id
        WHERE cs.last_message_at >= ${sinceFilter}
        GROUP BY city, country
        HAVING sessions > 0
        ORDER BY sessions DESC
        LIMIT 30
      `)) as any[];

      // По каналам
      const byChannel = db.all<any>(sql.raw(`
        SELECT
          cs.channel,
          COUNT(*) AS sessions,
          SUM(CASE WHEN (SELECT COUNT(*) FROM chatbot_messages WHERE session_id = cs.id AND role = 'user') >= 2 THEN 1 ELSE 0 END) AS multi_msg,
          SUM(CASE WHEN cs.user_id IS NOT NULL THEN 1 ELSE 0 END) AS converted
        FROM chatbot_sessions cs
        WHERE cs.last_message_at >= ${sinceFilter}
        GROUP BY cs.channel
        ORDER BY converted DESC, sessions DESC
      `)) as any[];

      // Cross-связь с engagement: чат → music_generate
      const linkedConv = db.get<any>(sql.raw(`
        SELECT COUNT(DISTINCT cs.user_id) AS users_generated
        FROM chatbot_sessions cs
        INNER JOIN engagement_events ee ON ee.user_id = cs.user_id
        WHERE cs.last_message_at >= ${sinceFilter}
          AND cs.user_id IS NOT NULL
          AND ee.event_type IN ('music_generate_attempt', 'music_generate_success')
      `));

      // Главный игрок — топ persona по conversions
      const topPlayer = byPersona[0] || null;

      res.json({
        ok: true,
        days,
        totals: {
          sessions: Number(totals?.sessions) || 0,
          multi_msg: Number(totals?.multi_msg) || 0,
          converted: Number(totals?.converted) || 0,
          avg_msgs: Number(totals?.avg_msgs) || 0,
          conv_rate: totals?.sessions ? Math.round((Number(totals.converted) / Number(totals.sessions)) * 100) : 0,
          avg_min: Number(totals?.avg_min) || 0,
          max_min: Number(totals?.max_min) || 0,
          total_min: Number(totals?.total_min) || 0,
        },
        by_persona: byPersona.map((r: any) => ({
          persona: r.persona,
          sessions: Number(r.sessions) || 0,
          multi_msg: Number(r.multi_msg) || 0,
          converted: Number(r.converted) || 0,
          avg_msgs: Number(r.avg_msgs) || 0,
          conv_rate: r.sessions ? Math.round((Number(r.converted) / Number(r.sessions)) * 100) : 0,
        })),
        by_channel: byChannel.map((r: any) => ({
          channel: r.channel,
          sessions: Number(r.sessions) || 0,
          multi_msg: Number(r.multi_msg) || 0,
          converted: Number(r.converted) || 0,
        })),
        by_city: byCity.map((r: any) => ({
          city: r.city,
          country: r.country,
          sessions: Number(r.sessions) || 0,
          converted: Number(r.converted) || 0,
        })),
        linked: {
          users_generated: Number(linkedConv?.users_generated) || 0,
        },
        top_player: topPlayer ? {
          persona: topPlayer.persona,
          converted: Number(topPlayer.converted) || 0,
          sessions: Number(topPlayer.sessions) || 0,
        } : null,
      });
    } catch (e: any) {
      console.error("[CHAT-FUNNEL] Error:", e);
      res.status(500).json({ ok: false, error: String(e) });
    }
  });

  // Eugene 2026-05-09: AUDIO PIPELINE TEST — проходит всю цепочку
  // голос → текст → песня и возвращает статус каждой точки.
  // Контрольные точки:
  //   1. ENV keys: YANDEX_SPEECHKIT_API_KEY / OPENAI_API_KEY /
  //      GPTUNNEL_API_KEY / ANTHROPIC_API_KEY — наличие + length
  //   2. Yandex SpeechKit /stt:recognize — auth-only тест (отправка
  //      минимального garbage audio): 401 = ключ битый, 400 = auth ok
  //   3. OpenAI /v1/models — 200 = auth ok, 401 = битый
  //   4. GPTunnel /v1/balance — JSON с balance = ok
  //   5. GPTunnel /v1/chat/completions — мини-тест rewrite модели
  //      gpt-4o-mini (платно, ~0.5₽ за запрос — но необходимо для
  //      проверки что lyrics-генерация работает)
  //   6. Anthropic /v1/models — 200 = auth ok
  //   7. ffmpeg installed (для конвертации в Yandex format)
  //   8. UPLOADS_DIR writable
  //   9. AUTHORS_DIR writable
  app.get("/api/admin/v304/audio-test", requireAdmin, async (_req: Request, res: Response) => {
    const checks: Array<{ step: string; status: "ok" | "fail" | "skip"; detail: string }> = [];
    const add = (step: string, status: "ok" | "fail" | "skip", detail: string) => {
      checks.push({ step, status, detail });
    };

    // 1. ENV keys
    const yk = process.env.YANDEX_SPEECHKIT_API_KEY || "";
    const ok = process.env.OPENAI_API_KEY || "";
    const gk = process.env.GPTUNNEL_API_KEY || "";
    const ak = process.env.ANTHROPIC_API_KEY || "";
    add("ENV: YANDEX_SPEECHKIT_API_KEY", yk ? "ok" : "fail", yk ? `length=${yk.length}` : "не задан");
    add("ENV: OPENAI_API_KEY", ok ? "ok" : "skip", ok ? `length=${ok.length}` : "не задан (опционально)");
    add("ENV: GPTUNNEL_API_KEY", gk ? "ok" : "fail", gk ? `length=${gk.length}` : "не задан — без него не работает LLM rewrite");
    add("ENV: ANTHROPIC_API_KEY", ak ? "ok" : "skip", ak ? `length=${ak.length}` : "не задан (опционально)");

    // 2. Yandex SpeechKit auth check
    if (yk) {
      try {
        const r = await fetch("https://stt.api.cloud.yandex.net/speech/v1/stt:recognize?topic=general&lang=ru-RU&format=oggopus", {
          method: "POST",
          headers: { Authorization: `Api-Key ${yk}` },
          body: Buffer.from("AAAAAAAAAA"),
          signal: AbortSignal.timeout(8000),
        });
        const text = await r.text().catch(() => "");
        if (r.status === 400 || /bad audio|format|invalid request/i.test(text)) {
          add("Yandex /stt:recognize auth", "ok", `HTTP ${r.status} (400 на garbage = auth работает)`);
        } else if (r.status === 401 || /unauthorized/i.test(text)) {
          add("Yandex /stt:recognize auth", "fail", `HTTP ${r.status}: ключ невалиден`);
        } else {
          add("Yandex /stt:recognize auth", "ok", `HTTP ${r.status}: ${text.slice(0, 80)}`);
        }
      } catch (e) {
        add("Yandex /stt:recognize auth", "fail", `network: ${e instanceof Error ? e.message : String(e)}`);
      }
    } else {
      add("Yandex /stt:recognize auth", "skip", "ключ не задан");
    }

    // 3. OpenAI auth
    if (ok) {
      try {
        const r = await fetch("https://api.openai.com/v1/models", {
          headers: { Authorization: `Bearer ${ok}` },
          signal: AbortSignal.timeout(8000),
        });
        add("OpenAI /v1/models", r.status === 200 ? "ok" : "fail", `HTTP ${r.status}`);
      } catch (e) {
        add("OpenAI /v1/models", "fail", `network: ${e instanceof Error ? e.message : String(e)}`);
      }
    } else {
      add("OpenAI /v1/models", "skip", "ключ не задан");
    }

    // 4. GPTunnel balance
    if (gk) {
      try {
        const r = await fetch("https://gptunnel.ru/v1/balance", {
          headers: { Authorization: gk },
          signal: AbortSignal.timeout(8000),
        });
        const text = await r.text().catch(() => "");
        if (r.ok && text.includes("balance")) {
          add("GPTunnel /v1/balance", "ok", `HTTP 200: ${text.slice(0, 100)}`);
        } else {
          add("GPTunnel /v1/balance", "fail", `HTTP ${r.status}: ${text.slice(0, 100)}`);
        }
      } catch (e) {
        add("GPTunnel /v1/balance", "fail", `network: ${e instanceof Error ? e.message : String(e)}`);
      }
    } else {
      add("GPTunnel /v1/balance", "fail", "ключ не задан");
    }

    // 5. GPTunnel LLM rewrite (gpt-4o-mini) — небольшой запрос
    if (gk) {
      try {
        const r = await fetch("https://gptunnel.ru/v1/chat/completions", {
          method: "POST",
          headers: { Authorization: gk, "Content-Type": "application/json" },
          body: JSON.stringify({
            model: "gpt-4o-mini",
            messages: [
              { role: "user", content: "Скажи слово 'ok' и больше ничего." },
            ],
            max_tokens: 5,
            temperature: 0,
          }),
          signal: AbortSignal.timeout(15_000),
        });
        const text = await r.text().catch(() => "");
        if (r.ok) {
          let content = "";
          try {
            const j = JSON.parse(text);
            content = j?.choices?.[0]?.message?.content || "";
          } catch {}
          add("GPTunnel /chat (gpt-4o-mini rewrite)", content ? "ok" : "fail",
              content ? `модель ответила: "${content.slice(0, 50)}"` : `HTTP 200 но content пустой: ${text.slice(0, 100)}`);
        } else {
          add("GPTunnel /chat (gpt-4o-mini rewrite)", "fail", `HTTP ${r.status}: ${text.slice(0, 150)}`);
        }
      } catch (e) {
        add("GPTunnel /chat (gpt-4o-mini rewrite)", "fail", `network: ${e instanceof Error ? e.message : String(e)}`);
      }
    } else {
      add("GPTunnel /chat (gpt-4o-mini rewrite)", "skip", "GPTUNNEL_API_KEY не задан");
    }

    // 6. Anthropic
    if (ak) {
      try {
        const r = await fetch("https://api.anthropic.com/v1/models", {
          headers: { "x-api-key": ak, "anthropic-version": "2023-06-01" },
          signal: AbortSignal.timeout(8000),
        });
        add("Anthropic /v1/models", r.status === 200 ? "ok" : "fail", `HTTP ${r.status}`);
      } catch (e) {
        add("Anthropic /v1/models", "fail", `network: ${e instanceof Error ? e.message : String(e)}`);
      }
    } else {
      add("Anthropic /v1/models", "skip", "ключ не задан");
    }

    // 7. ffmpeg
    try {
      const childProc = await import("child_process");
      const ver = childProc.execSync("ffmpeg -version 2>&1 | head -1", { encoding: "utf-8", timeout: 5000 });
      add("ffmpeg", "ok", ver.trim().slice(0, 80));
    } catch (e) {
      add("ffmpeg", "fail", `не установлен: ${e instanceof Error ? e.message.slice(0, 80) : "?"}`);
    }

    // 8. UPLOADS_DIR writable
    const uploadsDir = process.env.UPLOADS_DIR || "/var/www/neurohub/uploads";
    try {
      const test = path.join(uploadsDir, ".write-test-" + Date.now());
      fs.writeFileSync(test, "x");
      fs.unlinkSync(test);
      add("UPLOADS_DIR writable", "ok", uploadsDir);
    } catch (e) {
      add("UPLOADS_DIR writable", "fail", `${uploadsDir}: ${e instanceof Error ? e.message : "?"}`);
    }

    // 9. AUTHORS_DIR writable
    try {
      const test = path.join(AUTHORS_DIR, ".write-test-" + Date.now());
      fs.writeFileSync(test, "x");
      fs.unlinkSync(test);
      add("AUTHORS_DIR writable", "ok", AUTHORS_DIR);
    } catch (e) {
      add("AUTHORS_DIR writable", "fail", `${AUTHORS_DIR}: ${e instanceof Error ? e.message : "?"}`);
    }

    const summary = {
      total: checks.length,
      ok: checks.filter(c => c.status === "ok").length,
      fail: checks.filter(c => c.status === "fail").length,
      skip: checks.filter(c => c.status === "skip").length,
      verdict: checks.some(c => c.status === "fail" && /YANDEX|GPTUNNEL/.test(c.step))
        ? "❌ Цепочка не работает — критичные ключи (YANDEX/GPTUNNEL) битые"
        : checks.every(c => c.status !== "fail")
        ? "✅ Все точки в порядке — аудио-цепочка должна работать"
        : "⚠ Есть проблемы — проверь fail-пункты",
    };

    res.json({ data: { summary, checks }, error: null });
  });

  // Eugene 2026-05-09: AUDIT обложек плейлиста — для каждого трека из
  // /api/playlist возвращает: 1) что у gen в БД, 2) что найдено на диске,
  // 3) HEAD-запрос на /api/cover/<id>.jpg и его реальный ответ. Точечный
  // диагноз почему UI показывает ноту на конкретном треке.
  app.get("/api/admin/v304/covers/audit-playlist", requireAdmin, async (_req: Request, res: Response) => {
    try {
      const tracks = db.select()
        .from(generations)
        .where(
          and(
            eq(generations.status, "done"),
            eq(generations.isPublic, 1),
            eq(generations.type, "music"),
            isNotNull(generations.resultUrl),
            sql`${generations.deletedAt} IS NULL`,
          ),
        )
        .orderBy(desc(generations.id))
        .limit(50)
        .all();

      const out = await Promise.all(tracks.map(async (t: any) => {
        const probe = probeCoverPath(t);
        let remoteUrl: string | null = null;
        try {
          const data = JSON.parse(t.resultData || "{}");
          remoteUrl = data?.result?.[0]?.image_url || null;
        } catch {}
        const ageH = (Date.now() - new Date(t.createdAt || "").getTime()) / 3_600_000;
        const expectedExpired = remoteUrl
          ? (remoteUrl.includes("/exp24h/") ? ageH > 23 : (remoteUrl.includes("/exp48h/") ? ageH > 47 : false))
          : false;
        let serveStatus: string;
        if (probe.matched) {
          const stat = (() => { try { return fs.statSync(probe.matched!); } catch { return null; } })();
          serveStatus = stat ? `200 local (${Math.round(stat.size / 1024)} KB)` : "200 local (size?)";
        } else if (remoteUrl && !expectedExpired) {
          serveStatus = "200 remote-fetch (will try)";
        } else if (remoteUrl && expectedExpired) {
          serveStatus = "fallback artwork (remote expired)";
        } else {
          serveStatus = "fallback artwork (no remote URL)";
        }
        return {
          id: t.id,
          title: t.displayTitle || (t.prompt || "").slice(0, 60),
          createdAt: t.createdAt,
          ageHours: ageH.toFixed(1),
          localPath: t.localPath,
          coverGenId: t.coverGenId,
          probe: probe.matched ? "ok" : "miss",
          probeBranches: probe.tried.map(x => `${x.branch}→${x.exists ? "✓" : "✗"}`).join(", "),
          remoteUrlPresent: !!remoteUrl,
          remoteExpired: expectedExpired,
          serveStatus,
        };
      }));

      const summary = {
        total: out.length,
        ok_local: out.filter(x => x.probe === "ok").length,
        will_remote: out.filter(x => x.serveStatus.startsWith("200 remote")).length,
        fallback_expired: out.filter(x => x.serveStatus.includes("expired")).length,
        fallback_no_url: out.filter(x => x.serveStatus.includes("no remote")).length,
      };

      res.json({ data: { summary, tracks: out }, error: null });
    } catch (e) {
      res.status(500).json({ data: null, error: e instanceof Error ? e.message : String(e) });
    }
  });

  // Eugene 2026-05-09: BACKFILL обложек — для всех done music-gens без
  // локального gen_<id>.jpg пытается скачать с remote image_url (Suno CDN)
  // и сохранить на диск. После выполнения jpg-индекс инвалидируется.
  // Это "навсегда" решение для треков чьи обложки были только в remote URL
  // и не успели сохраниться (Suno CDN exp48h истёк, или saveGenFiles упал).
  app.post("/api/admin/v304/covers/backfill", requireAdmin, async (req: Request, res: Response) => {
    try {
      const gens = db.select().from(generations).where(
        and(
          eq(generations.status, "done"),
          eq(generations.type, "music"),
          sql`${generations.deletedAt} IS NULL`,
        )
      ).all();

      let scanned = 0, downloaded = 0, skipped = 0, failed = 0, expired = 0, noUrl = 0;
      const samples: Array<{ id: number; status: string; reason?: string }> = [];

      for (const gen of gens) {
        scanned++;
        // Уже есть локальная обложка — пропускаем
        if (resolveCoverPath(gen)) { skipped++; continue; }

        // Достаём remote image_url из resultData
        let imageUrl: string | null = null;
        try {
          const data = JSON.parse(gen.resultData || "{}");
          imageUrl = data?.result?.[0]?.image_url || null;
        } catch {}
        if (!imageUrl) {
          noUrl++;
          if (samples.length < 10) samples.push({ id: gen.id, status: "no-url" });
          continue;
        }

        // Suno temporary URLs (exp48h/exp24h) — проверяем возраст создания
        if (imageUrl.includes("/exp48h/") || imageUrl.includes("/exp24h/")) {
          const ageH = (Date.now() - new Date(gen.createdAt || "").getTime()) / 3_600_000;
          const limit = imageUrl.includes("/exp24h/") ? 23 : 47;
          if (ageH > limit) {
            expired++;
            if (samples.length < 10) samples.push({ id: gen.id, status: "expired", reason: `${ageH.toFixed(1)}h > ${limit}h` });
            continue;
          }
        }

        // Скачиваем и сохраняем как gen_<id>.jpg в authors/<author>/
        try {
          const r = await fetch(imageUrl, { signal: AbortSignal.timeout(8000) });
          if (!r.ok) {
            failed++;
            if (samples.length < 10) samples.push({ id: gen.id, status: "fetch-failed", reason: `HTTP ${r.status}` });
            continue;
          }
          const buf = Buffer.from(await r.arrayBuffer());
          if (buf.length < 500) {
            failed++;
            if (samples.length < 10) samples.push({ id: gen.id, status: "fetch-failed", reason: `tiny buf ${buf.length}` });
            continue;
          }
          const folder = sanitizeFolderName(gen.authorName || "anon");
          const dir = path.join(AUTHORS_DIR, folder);
          fs.mkdirSync(dir, { recursive: true });
          fs.writeFileSync(path.join(dir, `gen_${gen.id}.jpg`), buf);
          downloaded++;
        } catch (e) {
          failed++;
          if (samples.length < 10) samples.push({ id: gen.id, status: "fetch-error", reason: e instanceof Error ? e.message.slice(0, 80) : "?" });
        }
      }

      // Сбрасываем jpg-индекс чтобы новые файлы сразу подхватились
      const refresh = (globalThis as any).__refreshJpgIndex;
      if (typeof refresh === "function") refresh();

      res.json({
        data: {
          scanned,
          downloaded,
          skipped,
          failed,
          expired,
          noUrl,
          samples,
          hint: downloaded > 0
            ? `✅ Скачано ${downloaded} обложек. Жми "🖼 Обновить обложки" в админке (если кэш ещё не сброшен) и хард-рефреш плейлиста.`
            : (expired + noUrl + failed > 0
              ? `Ничего не скачано: ${expired} истекли, ${noUrl} без remote-URL, ${failed} fetch-failed. Эти треки потеряли обложку безвозвратно.`
              : `Все ${skipped} треков уже имеют обложки на диске.`),
        },
        error: null,
      });
    } catch (e) {
      res.status(500).json({ data: null, error: e instanceof Error ? e.message : String(e) });
    }
  });

  // Eugene 2026-05-09: diagnostic endpoint — за каждый запрошенный gen.id
  // вернёт точную карту того что искалось, что найдено, что было пропущено.
  // Используется когда обложка не отображается, чтобы понять root cause
  // (gen существует? какой localPath? что в индексе? итд).
  app.get("/api/admin/v304/cover-debug/:id", requireAdmin, async (req: Request, res: Response) => {
    try {
      const id = parseInt(req.params.id);
      const gen = db.select().from(generations).where(eq(generations.id, id)).get();
      if (!gen) {
        return res.json({ data: { found: false, reason: "gen not in DB" }, error: null });
      }
      const probe = probeCoverPath(gen);
      const idxSize = getCoverIndex().size;
      let cover: any = null;
      if (gen.coverGenId) {
        cover = db.select().from(generations).where(eq(generations.id, gen.coverGenId)).get();
      }
      let resultData: any = null;
      try { resultData = JSON.parse(gen.resultData || "{}"); } catch {}
      const remoteImageUrl = resultData?.result?.[0]?.image_url || null;
      res.json({
        data: {
          gen: {
            id: gen.id,
            type: gen.type,
            status: gen.status,
            localPath: gen.localPath,
            coverGenId: gen.coverGenId,
            authorName: gen.authorName,
            createdAt: gen.createdAt,
          },
          coverGen: cover ? { id: cover.id, type: cover.type, localPath: cover.localPath } : null,
          remoteImageUrl,
          probe,
          coverIndexSize: idxSize,
          coverServeUrl: `/api/cover/${gen.id}.jpg`,
          finalEndpoint: probe.matched ? "200 (will serve local file)" : (remoteImageUrl ? "200 (will fetch remote image)" : "200 (will serve artwork-512.png fallback)"),
        },
        error: null,
      });
    } catch (e) {
      res.status(500).json({ data: null, error: e instanceof Error ? e.message : String(e) });
    }
  });

  // Cover image per track — Perplexity-2026-05-09 рефакторинг.
  // 1) resolveCoverPath возвращает абсолютный путь.
  // 2) fs.realpathSync — снимает симлинки + проверяет реальное существование.
  // 3) realpath сравнивается с realpath(AUTHORS_DIR) — защита от path traversal.
  // 4) res.sendFile(realPath) без неправильного root (передаём абсолют, никаких options).
  // 5) Content-Type: image/jpeg ставится явно перед sendFile.
  // 6) HEAD: sendFile сам отдаёт headers без body (Express обрабатывает корректно).
  // 7) Все ошибки — console.error с id + path.
  // ?wm=1 для watermark, ?size=96|128|256|384|512 для resize (Safari MediaSession).
  // При наличии любой трансформации идём через buffer + res.send (sharp/jimp).
  let __authorsRealPath: string | null = null;
  const getAuthorsRealPath = (): string => {
    if (__authorsRealPath) return __authorsRealPath;
    try { __authorsRealPath = fs.realpathSync(AUTHORS_DIR); } catch { __authorsRealPath = AUTHORS_DIR; }
    return __authorsRealPath;
  };

  // Eugene 2026-05-15 Босс «обложка от Suno вместо привязанной при пересылке».
  // Debug endpoint — показывает что probeCoverPath нашёл/не нашёл для трека.
  // Использование: /api/cover/:id/debug
  app.get("/api/cover/:id/debug", (req: Request, res: Response) => {
    const genId = parseInt(req.params.id);
    const gen = db.select().from(generations).where(eq(generations.id, genId)).get() as any;
    if (!gen) return res.status(404).json({ error: "gen not found" });
    const probe = probeCoverPath(gen);
    let coverGen: any = null;
    if (gen.coverGenId) {
      coverGen = db.select().from(generations).where(eq(generations.id, gen.coverGenId)).get();
    }
    res.json({
      genId: gen.id,
      type: gen.type,
      status: gen.status,
      coverGenId: gen.coverGenId || null,
      gen_localPath: gen.localPath || null,
      cover_localPath: coverGen?.localPath || null,
      cover_status: coverGen?.status || null,
      matched: probe.matched,
      tried: probe.tried,
      hint: probe.matched
        ? probe.matched.includes(coverGen?.localPath || "ZZZ") ? "✅ Отдаём ПРИВЯЗАННУЮ обложку" : "⚠️ Отдаём fallback (не привязанную)"
        : "❌ Файл не найден — будет 404 или image-stream от Suno URL",
    });
  });

  app.get("/api/cover/:id.jpg", async (req: Request, res: Response) => {
    const genId = parseInt(req.params.id);
    try {
      const gen = db.select().from(generations).where(eq(generations.id, genId)).get();
      if (!gen || gen.status !== "done") {
        console.warn(`[cover-serve] miss gen id=${genId} (not found or not done)`);
        return res.status(404).end();
      }

      res.setHeader("Access-Control-Allow-Origin", "*");

      const wantWm = req.query.wm === "1";
      const targetSize = parseInt(req.query.size as string) || 0;
      const needsTransform = wantWm || (targetSize > 0 && targetSize <= 512);

      const coverPath = resolveCoverPath(gen);

      if (coverPath) {
        // realpath — снимает симлинки, проверяет реальное существование
        let realPath: string | null = null;
        try {
          realPath = fs.realpathSync(coverPath);
        } catch (e) {
          console.error(`[cover-serve] realpath failed id=${genId} coverPath=${coverPath}:`, e instanceof Error ? e.message : e);
        }

        if (realPath) {
          const authorsReal = getAuthorsRealPath();
          if (!realPath.startsWith(authorsReal + path.sep) && realPath !== authorsReal) {
            console.error(`[cover-serve] path traversal blocked id=${genId} realPath=${realPath} authorsReal=${authorsReal}`);
            return res.status(403).end();
          }

          res.setHeader("Content-Type", "image/jpeg");
          // Eugene 2026-05-18 Босс «опять LS» — был no-cache,must-revalidate →
          // iOS MediaSession пропускал artwork (revalidate timeout до того
          // как iOS забрал metadata) → fallback на apple-touch-icon (фиолет.
          // waveform). Теперь 1 час кэша — iOS успевает забрать artwork и
          // кэширует его для re-uses. Cache-bust работает через ?v= в URL.
          res.setHeader("Cache-Control", "public, max-age=3600");

          if (needsTransform) {
            try {
              const sharp = require("sharp");
              let buf = fs.readFileSync(realPath);
              if (wantWm) buf = await addWatermark(buf);
              if (targetSize > 0 && targetSize <= 512) {
                // Eugene 2026-05-19 Босс «пропорции соблюди по зонам».
                // Sharp position: "attention" — entropy-based smart crop,
                // keeps main subject (face / focal point) centered when
                // squaring non-square covers for iOS MediaSession.
                buf = await sharp(buf).resize(targetSize, targetSize, { fit: "cover", position: "attention" }).jpeg({ quality: 85 }).toBuffer();
              }
              return res.send(buf);
            } catch (e) {
              console.error(`[cover-serve] transform failed id=${genId} path=${realPath}:`, e instanceof Error ? e.message : e);
              return res.status(500).end();
            }
          }

          // Прямой sendFile — корректно обрабатывает HEAD, Range, Content-Length.
          return res.sendFile(realPath, (err) => {
            if (err) {
              console.error(`[cover-serve] sendFile failed id=${genId} path=${realPath}:`, err.message || err);
            }
          });
        }
      }

      // Remote fallback (Suno CDN) — для свежих треков чьи jpg ещё не скачаны.
      try {
        const data = JSON.parse(gen.resultData || "{}");
        const imgUrl = Array.isArray(data.result) ? data.result[0]?.image_url : null;
        if (imgUrl) {
          const upstream = await fetch(imgUrl);
          if (upstream.ok) {
            let buf = Buffer.from(await upstream.arrayBuffer());
            if (wantWm) buf = await addWatermark(buf);
            if (targetSize > 0 && targetSize <= 512) {
              const sharp = require("sharp");
              buf = await sharp(buf).resize(targetSize, targetSize, { fit: "cover" }).jpeg({ quality: 85 }).toBuffer();
            }
            res.setHeader("Content-Type", "image/jpeg");
            res.setHeader("Cache-Control", "public, max-age=3600");
            return res.send(buf);
          } else {
            console.warn(`[cover-serve] remote upstream id=${genId} status=${upstream.status} url=${imgUrl}`);
          }
        }
      } catch (e) {
        console.error(`[cover-serve] remote fallback failed id=${genId}:`, e instanceof Error ? e.message : e);
      }

      // Final fallback — MuzaAi artwork
      const artworkPath = path.join(process.cwd(), "dist", "public", "artwork-512.png");
      if (fs.existsSync(artworkPath)) {
        try {
          if (targetSize > 0 && targetSize <= 512) {
            const sharp = require("sharp");
            const buf = await sharp(fs.readFileSync(artworkPath)).resize(targetSize, targetSize, { fit: "cover" }).jpeg({ quality: 85 }).toBuffer();
            res.setHeader("Content-Type", "image/jpeg");
            res.setHeader("Cache-Control", "public, max-age=604800");
            return res.send(buf);
          }
          res.setHeader("Content-Type", "image/png");
          res.setHeader("Cache-Control", "public, max-age=604800");
          return res.sendFile(artworkPath, (err) => {
            if (err) console.error(`[cover-serve] artwork sendFile failed id=${genId}:`, err.message || err);
          });
        } catch (e) {
          console.error(`[cover-serve] artwork serve failed id=${genId}:`, e instanceof Error ? e.message : e);
          return res.status(500).end();
        }
      }
      console.warn(`[cover-serve] no artwork file id=${genId} expectedPath=${artworkPath}`);
      return res.status(404).end();
    } catch (e) {
      console.error(`[cover-serve] unexpected id=${genId}:`, e instanceof Error ? e.message : e);
      return res.status(500).end();
    }
  });

  // Stream audio/image for inline playback (no Content-Disposition: attachment)
  // ?type=image to get the cover image instead of audio
  app.get("/api/stream/:id", async (req: Request, res: Response) => {
    try {
      const gen = db.select().from(generations).where(eq(generations.id, parseInt(req.params.id))).get();
      if (!gen || gen.status !== "done" || !gen.resultUrl) {
        res.status(404).json({ message: "Файл не найден" });
        return;
      }
      // Eugene 2026-05-18 IDOR-fix (ACCESS-BYPASS-AUDIT-170526 #1):
      // приватные треки (isPublic=0) — только владелец/админ.
      // Bearer/?token= для <audio> tags которые не шлют Authorization header.
      // Eugene 2026-05-19 (Триумф 1905): добавлен cookie auth_token fallback —
      // браузер автоматически шлёт cookie на same-origin requests, <audio> и
      // <img> работают без явного ?token= в URL.
      const cookieToken = (() => {
        const raw = req.headers.cookie || '';
        const m = raw.match(/(?:^|;\s*)auth_token=([^;]+)/);
        return m ? decodeURIComponent(m[1]) : '';
      })();
      const stToken = (req.headers.authorization || '').replace('Bearer ', '') || (req.query.token as string) || cookieToken || '';
      const stUserId = stToken ? tokenStore.get(stToken) : undefined;
      if ((gen.isPublic ?? 0) === 0) {
        const stUser = stUserId ? storage.getUser(stUserId) : null;
        if (!isAdminUser(stUser) && gen.userId !== stUserId) {
          res.status(403).json({ message: "Приватный трек" });
          return;
        }
      }

      const wantImage = req.query.type === "image";

      // Try local file first
      if (tryServeLocal(gen, wantImage, res)) return;

      // Fallback to remote URL
      let url = gen.resultUrl;
      try {
        const data = JSON.parse(gen.resultData || "{}");
        if (Array.isArray(data.result) && data.result[0]) {
          if (wantImage && data.result[0].image_url) {
            url = data.result[0].image_url;
          } else if (!wantImage && data.result[0].audio_url) {
            url = data.result[0].audio_url;
          }
        }
      } catch {}

      // Skip fetch for expired temporary URLs (exp48h) — return 404 instantly
      if (url.includes("/exp48h/") || url.includes("/exp24h/")) {
        res.status(404).json({ message: "Файл истёк" });
        return;
      }

      const upstream = await fetch(url);
      if (!upstream.ok) {
        res.status(502).json({ message: "Файл недоступен" });
        return;
      }

      const defaultCt = wantImage ? "image/webp" : (gen.type === "cover" ? "image/png" : "audio/mpeg");
      const contentType = upstream.headers.get("content-type") || defaultCt;
      res.setHeader("Content-Type", contentType);
      res.setHeader("Cache-Control", "public, max-age=3600");
      const cl = upstream.headers.get("content-length");
      if (cl) res.setHeader("Content-Length", cl);
      const buffer = await upstream.arrayBuffer();
      res.send(Buffer.from(buffer));
    } catch (e: any) {
      res.status(500).json({ message: e.message });
    }
  });

  // Stream second Suno variant
  app.get("/api/stream/:id/variant/:idx", async (req: Request, res: Response) => {
    try {
      const gen = db.select().from(generations).where(eq(generations.id, parseInt(req.params.id))).get();
      if (!gen || gen.status !== "done") {
        res.status(404).json({ message: "Файл не найден" });
        return;
      }
      // Eugene 2026-05-18 IDOR-fix (ACCESS-BYPASS-AUDIT-170526 #1):
      // приватные треки (isPublic=0) — только владелец/админ.
      // Eugene 2026-05-20 (C5 fix): добавлен cookie auth_token fallback —
      // <audio> tags на iOS Safari не шлют Authorization header, нужен cookie.
      if ((gen.isPublic ?? 0) === 0) {
        const vCookieToken = (() => {
          const raw = req.headers.cookie || '';
          const m = raw.match(/(?:^|;\s*)auth_token=([^;]+)/);
          return m ? decodeURIComponent(m[1]) : '';
        })();
        const vToken = (req.headers.authorization || '').replace('Bearer ', '') || (req.query.token as string) || vCookieToken || '';
        const vUserId = vToken ? tokenStore.get(vToken) : undefined;
        const vUser = vUserId ? storage.getUser(vUserId) : null;
        if (!isAdminUser(vUser) && gen.userId !== vUserId) {
          res.status(403).json({ message: "Приватный трек" });
          return;
        }
      }
      const varIdx = parseInt(req.params.idx) || 1;
      let url = "";
      try {
        const data = JSON.parse(gen.resultData || "{}");
        if (Array.isArray(data.result) && data.result[varIdx]?.audio_url) {
          url = data.result[varIdx].audio_url;
        }
      } catch {}
      if (!url) { res.status(404).json({ message: "Вариант не найден" }); return; }
      if (url.includes("/exp48h/") || url.includes("/exp24h/")) { res.status(404).json({ message: "Файл истёк" }); return; }

      const upstream = await fetch(url);
      if (!upstream.ok) { res.status(502).json({ message: "Файл недоступен" }); return; }
      res.setHeader("Content-Type", upstream.headers.get("content-type") || "audio/mpeg");
      res.setHeader("Cache-Control", "public, max-age=3600");
      const cl = upstream.headers.get("content-length");
      if (cl) res.setHeader("Content-Length", cl);
      const buffer = await upstream.arrayBuffer();
      res.send(Buffer.from(buffer));
    } catch (e: any) {
      res.status(500).json({ message: e.message });
    }
  });

  // ==================== ADMIN STATS ====================
  // Admin: block/unblock user
  app.post("/api/admin/block/:userId", authMiddleware, (req: Request, res: Response) => {
    const adminId = (req as any).userId;
    const admin = storage.getUser(adminId);
    if (!isAdminUser(admin)) {
      res.status(403).json({ message: "Доступ запрещён" });
      return;
    }
    const targetId = parseInt(req.params.userId);
    const blocked = req.body.blocked ? 1 : 0;
    db.update(users).set({ blocked }).where(eq(users.id, targetId)).run();
    // If blocking — hide all their public generations
    if (blocked) {
      db.update(generations).set({ isPublic: 0 }).where(eq(generations.userId, targetId)).run();
    }
    console.log(`[ADMIN] User #${targetId} ${blocked ? "BLOCKED" : "UNBLOCKED"} by admin`);
    res.json({ ok: true, blocked });
  });

  // Admin: view any user's generations (readonly)
  app.get("/api/admin/user/:userId/generations", authMiddleware, (req: Request, res: Response) => {
    const adminId = (req as any).userId;
    const admin = storage.getUser(adminId);
    if (!isAdminUser(admin)) {
      res.status(403).json({ message: "Доступ запрещён" });
      return;
    }
    const targetId = parseInt(req.params.userId);
    const targetUser = storage.getUser(targetId);
    if (!targetUser) { res.status(404).json({ message: "Автор не найден" }); return; }
    const gens = db.select().from(generations).where(eq(generations.userId, targetId)).orderBy(desc(generations.id)).all();
    res.json({ user: { id: targetUser.id, name: targetUser.name, email: targetUser.email, balance: targetUser.balance }, generations: gens });
  });

  app.get("/api/admin/stats", authMiddleware, (req: Request, res: Response) => {
    const userId = (req as any).userId;
    const user = storage.getUser(userId);
    if (!isAdminUser(user)) {
      res.status(403).json({ message: "Доступ запрещён" });
      return;
    }

    const raw = db.$client;
    const today = new Date().toISOString().slice(0, 10);
    const weekAgo = new Date(Date.now() - 7 * 86400000).toISOString().slice(0, 10);

    const totalUsers = raw.prepare("SELECT COUNT(*) as cnt FROM users").get() as any;
    const todayUsers = raw.prepare("SELECT COUNT(*) as cnt FROM users WHERE date(created_at) = ?").get(today) as any;
    const weekUsers = raw.prepare("SELECT COUNT(*) as cnt FROM users WHERE date(created_at) >= ?").get(weekAgo) as any;
    const totalGens = raw.prepare("SELECT COUNT(*) as cnt FROM generations WHERE status = 'done'").get() as any;
    const todayGens = raw.prepare("SELECT COUNT(*) as cnt FROM generations WHERE status = 'done' AND date(created_at) = ?").get(today) as any;

    // Unique visitors today (from nginx access log)
    let visitorsToday = 0;
    let visitorsTotal = 0;
    try {
      const { execSync } = require("child_process");
      const dateStr = new Date().toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" }).replace(/ /g, "/");
      visitorsToday = parseInt(execSync(`grep "$(date +'%d/%b/%Y')" /var/log/nginx/access.log 2>/dev/null | awk '{print $1}' | sort -u | wc -l`).toString().trim()) || 0;
      visitorsTotal = parseInt(execSync(`cat /var/log/nginx/access.log 2>/dev/null | awk '{print $1}' | sort -u | wc -l`).toString().trim()) || 0;
    } catch {}

    // Revenue
    const totalRevenue = raw.prepare("SELECT COALESCE(SUM(amount), 0) as s FROM payments WHERE status = 'paid'").get() as any;

    // Authors list with generation count
    const authorsList = db.select({
      id: users.id,
      name: users.name,
      email: users.email,
      createdAt: users.createdAt,
      blocked: users.blocked,
    }).from(users).orderBy(desc(users.id)).all();

    // Count generations per author
    const genCounts = raw.prepare("SELECT user_id, COUNT(*) as cnt FROM generations WHERE status = 'done' GROUP BY user_id").all() as any[];
    const genCountMap: Record<number, number> = {};
    genCounts.forEach((g: any) => { genCountMap[g.user_id] = g.cnt; });

    const authorsWithCount = authorsList.map((a: any) => ({ ...a, genCount: genCountMap[a.id] || 0 }));

    res.json({
      authors: {
        total: totalUsers?.cnt || 0,
        today: todayUsers?.cnt || 0,
        thisWeek: weekUsers?.cnt || 0,
        list: authorsWithCount,
      },
      generations: {
        total: totalGens?.cnt || 0,
        today: todayGens?.cnt || 0,
      },
      visitors: {
        today: visitorsToday,
        total: visitorsTotal,
      },
      revenue: (totalRevenue?.s || 0) / 100, // rubles
      promoCodes: db.select().from(promoCodes).all().map((p: any) => ({ code: p.code, bonus: p.bonus / 100, usedCount: p.usedCount, maxUses: p.maxUses, activeTo: p.activeTo })),
    });
  });

  // ==================== GENERATIONS HISTORY ====================
  app.get("/api/generations", authMiddleware, (req: Request, res: Response) => {
    const userId = (req as any).userId;
    const user = storage.getUser(userId);
    // Only admin can see all generations (was hardcoded egnovoselov@gmail.com — now isAdminUser)
    if (isAdminUser(user) && req.query.all === "true") {
      const allGens = db.select().from(generations).where(sql`${generations.deletedAt} IS NULL`).orderBy(desc(generations.id)).limit(200).all();
      const allUsers = db.select().from(users).all();
      const userMap = new Map(allUsers.map(u => [u.id, u.name]));
      const result = allGens.map(g => {
        let plays = 0, downloads = 0;
        try { const m = JSON.parse(g.style || "{}"); plays = m.plays || 0; downloads = m.downloads || 0; } catch {}
        return { ...g, authorName: userMap.get(g.userId) || "Unknown", plays, downloads };
      });
      // Sort by plays descending if requested
      if (req.query.sort === "plays") {
        result.sort((a, b) => b.plays - a.plays);
      }
      res.json(result);
      return;
    }
    // Deleted filter
    if (req.query.deleted === "true") {
      res.json(storage.getUserDeletedGenerations(userId));
      return;
    }
    res.json(storage.getUserGenerations(userId));
  });

  // Eugene 2026-05-21 Босс Chat-tool-calling MVP: GET /api/generations/:id/status
  // — lightweight статус одной генерации для polling из чата после
  // create_music_job (frontend опрашивает каждые 5-10 сек). Возвращает только
  // публичные fields (никаких internal raw payload). Только свои генерации.
  app.get("/api/generations/:id/status", authMiddleware, (req: Request, res: Response) => {
    const userId = (req as any).userId;
    const id = Number(req.params.id);
    if (!Number.isFinite(id) || id <= 0) {
      res.status(400).json({ ok: false, error: "id обязателен" });
      return;
    }
    const gen = storage.getGeneration(id);
    if (!gen) {
      res.status(404).json({ ok: false, error: "Не найдено" });
      return;
    }
    if (gen.userId !== userId) {
      res.status(403).json({ ok: false, error: "Доступ запрещён" });
      return;
    }
    let coverUrl: string | null = null;
    let lyricsPreview: string | null = null;
    let durationSec = 0;
    if (gen.type === "music" && gen.status === "done") {
      try {
        const rd = JSON.parse((gen as any).resultData || "{}");
        if (Array.isArray(rd.result) && rd.result[0]) {
          coverUrl = rd.result[0].image_url || null;
          if (rd.result[0].lyric) lyricsPreview = String(rd.result[0].lyric).slice(0, 200);
          durationSec = Number(rd.result[0].duration || 0) || 0;
        }
      } catch {}
    }
    if (gen.type === "lyrics" && gen.status === "done") {
      lyricsPreview = String((gen as any).resultUrl || "").slice(0, 200);
    }
    res.json({
      ok: true,
      jobId: gen.id,
      type: gen.type,
      status: gen.status,
      title: (gen as any).displayTitle || String(gen.prompt || "").slice(0, 80) || "Без названия",
      audioUrl: gen.type === "music" && gen.status === "done" ? `/api/stream/${gen.id}` : null,
      coverUrl: gen.type === "music" && gen.status === "done" ? `/api/cover/${gen.id}.jpg` : coverUrl,
      lyricsPreview,
      durationSec,
      errorReason: gen.status === "error" ? ((gen as any).errorReason || null) : null,
    });
  });

  // ==================== LYRICS DRAFTS (Eugene 2026-05-18 Босс) ====================
  // Муза сохраняет готовые тексты — auth-юзер → user_lyric_drafts,
  // анонимный → pending_anonymous_lyrics (email или recovery code, TTL 30 дней).

  // Anonymous-save rate-limit: 5 запросов / час / IP.
  const anonLyricsSaveByIp = new Map<string, number[]>();

  // POST /api/lyrics/save (auth) — сохранить текст в кабинет.
  app.post("/api/lyrics/save", authMiddleware, (req: Request, res: Response) => {
    try {
      const userId = (req as any).userId;
      const title = String(req.body?.title || "").trim().slice(0, 120);
      const text = String(req.body?.text || "").trim().slice(0, 8000);
      const source = String(req.body?.source || "manual").trim().slice(0, 32);
      const chatSessionId = req.body?.chatSessionId ? String(req.body.chatSessionId).slice(0, 64) : null;
      if (!title) { res.status(400).json({ data: null, error: "Название не задано" }); return; }
      if (!text || text.length < 5) { res.status(400).json({ data: null, error: "Текст слишком короткий" }); return; }

      const now = Date.now();
      const result = sqliteDb.prepare(`
        INSERT INTO user_lyric_drafts (user_id, title, text, source, chat_session_id, created_at)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run(userId, title, text, source, chatSessionId, now);
      const draftId = Number(result.lastInsertRowid);

      // Audit-log
      try {
        sqliteDb.prepare(`
          INSERT INTO muza_user_actions (user_id, action_type, params_json, confirmed, confirmed_at, chat_session_id, created_at)
          VALUES (?, 'save_lyrics', ?, 1, ?, ?, ?)
        `).run(userId, JSON.stringify({ draftId, title, source }), now, chatSessionId, now);
      } catch {}

      res.json({ data: { draftId, title }, error: null });
    } catch (e: any) {
      console.error("[POST /api/lyrics/save]", e);
      res.status(500).json({ data: null, error: "Не удалось сохранить" });
    }
  });

  // POST /api/lyrics/claim (auth) — claim anonymous text via recovery code.
  app.post("/api/lyrics/claim", authMiddleware, (req: Request, res: Response) => {
    try {
      const userId = (req as any).userId;
      const code = String(req.body?.code || "").trim();
      if (!/^\d{6}$/.test(code)) {
        res.status(400).json({ data: null, error: "Код должен быть 6-значным" });
        return;
      }
      const now = Date.now();
      const pending = sqliteDb.prepare(`
        SELECT id, title, text, chat_session_id, expires_at
        FROM pending_anonymous_lyrics
        WHERE recovery_code = ? AND claimed_by_user_id IS NULL AND expires_at > ?
        LIMIT 1
      `).get(code, now) as any;
      if (!pending) {
        res.status(404).json({ data: null, error: "Код не найден, уже использован или просрочен" });
        return;
      }

      const ins = sqliteDb.prepare(`
        INSERT INTO user_lyric_drafts (user_id, title, text, source, chat_session_id, created_at)
        VALUES (?, ?, ?, 'musa_chat_claim', ?, ?)
      `).run(userId, pending.title, pending.text, pending.chat_session_id || null, now);
      const draftId = Number(ins.lastInsertRowid);

      sqliteDb.prepare(`
        UPDATE pending_anonymous_lyrics SET claimed_by_user_id = ?, claimed_at = ? WHERE id = ?
      `).run(userId, now, pending.id);

      // Audit-log
      try {
        sqliteDb.prepare(`
          INSERT INTO muza_user_actions (user_id, action_type, params_json, confirmed, confirmed_at, created_at)
          VALUES (?, 'claim_pending_lyrics', ?, 1, ?, ?)
        `).run(userId, JSON.stringify({ draftId, pendingId: pending.id, title: pending.title }), now, now);
      } catch {}

      res.json({ data: { draftId, title: pending.title }, error: null });
    } catch (e: any) {
      console.error("[POST /api/lyrics/claim]", e);
      res.status(500).json({ data: null, error: "Не удалось забрать текст" });
    }
  });

  // GET /api/lyrics/drafts (auth) — список сохранённых текстов.
  app.get("/api/lyrics/drafts", authMiddleware, (req: Request, res: Response) => {
    try {
      const userId = (req as any).userId;
      const rows = sqliteDb.prepare(`
        SELECT id, title, text, source, created_at AS createdAt, used_in_generation_id AS usedInGenerationId
        FROM user_lyric_drafts
        WHERE user_id = ?
        ORDER BY created_at DESC
        LIMIT 100
      `).all(userId) as any[];
      res.json({ data: rows, error: null });
    } catch (e: any) {
      console.error("[GET /api/lyrics/drafts]", e);
      res.status(500).json({ data: null, error: "Не удалось получить список" });
    }
  });

  // DELETE /api/lyrics/drafts/:id (auth, owner check).
  app.delete("/api/lyrics/drafts/:id", authMiddleware, (req: Request, res: Response) => {
    try {
      const userId = (req as any).userId;
      const id = Number(req.params.id);
      if (!Number.isFinite(id) || id <= 0) {
        res.status(400).json({ data: null, error: "Невалидный id" });
        return;
      }
      const row = sqliteDb.prepare(`SELECT user_id FROM user_lyric_drafts WHERE id = ?`).get(id) as any;
      if (!row) { res.status(404).json({ data: null, error: "Текст не найден" }); return; }
      if (row.user_id !== userId) { res.status(403).json({ data: null, error: "Доступ только к своим текстам" }); return; }

      sqliteDb.prepare(`DELETE FROM user_lyric_drafts WHERE id = ?`).run(id);

      // Audit-log
      try {
        sqliteDb.prepare(`
          INSERT INTO muza_user_actions (user_id, action_type, params_json, confirmed, confirmed_at, created_at)
          VALUES (?, 'delete_lyrics_draft', ?, 1, ?, ?)
        `).run(userId, JSON.stringify({ draftId: id }), Date.now(), Date.now());
      } catch {}

      res.json({ data: { deleted: id }, error: null });
    } catch (e: any) {
      console.error("[DELETE /api/lyrics/drafts/:id]", e);
      res.status(500).json({ data: null, error: "Не удалось удалить" });
    }
  });

  // ─────────────────────────────────────────────────────────────────────────
  // Eugene 2026-05-18 Босс «в кабинете автора иконочка Музы под папочкой —
  // открывает историю взаимодействия. Юзер может в любое время зайти и
  // продолжить разговор».
  //
  // Группа эндпоинтов /api/user/musa-history* — read-only история диалогов
  // юзера с Музой (через web/telegram/max) + переключение «продолжить
  // конкретную сессию» (для floating-consultant).
  //
  // TODO: Eugene 2026-05-18 «диалоговое общение для премиум-аккаунтов» —
  // в premium-mode подгружать full extended memory (см. MUZA-MEMORY-DESIGN-180526.md),
  // включать proactive-triggers, snapshot после каждого turn для resume точности.
  // ─────────────────────────────────────────────────────────────────────────

  // Helper: persona avatar по name (для UI). Fallback на 🎀.
  const personaAvatarByName = (name: string | null | undefined): string => {
    if (!name) return "🎀";
    const p = PERSONAS.find((x) => x.name === name);
    return p?.avatar || "🎀";
  };

  // GET /api/user/musa-history — список всех сессий юзера + summary.
  // Группирует по chatbot_sessions.id (cross-channel: web + telegram + max).
  app.get("/api/user/musa-history", authMiddleware, (req: Request, res: Response) => {
    try {
      const userId = (req as any).userId as number;
      const rows = sqliteDb.prepare(`
        SELECT
          s.id                  AS sessionId,
          s.channel             AS channel,
          s.persona_name        AS personaName,
          s.started_at          AS startedAt,
          s.last_message_at     AS lastMessageAt,
          s.intent              AS intent,
          (SELECT COUNT(*) FROM chatbot_messages m WHERE m.session_id = s.id) AS messagesCount,
          (SELECT m.text FROM chatbot_messages m
            WHERE m.session_id = s.id AND m.role = 'user'
            ORDER BY m.id ASC LIMIT 1) AS firstUserText
        FROM chatbot_sessions s
        WHERE s.user_id = ?
        ORDER BY COALESCE(s.last_message_at, s.started_at) DESC
        LIMIT 200
      `).all(userId) as any[];

      const sessions = rows
        .filter((r) => Number(r.messagesCount || 0) > 0)
        .map((r) => {
          const previewRaw = String(r.firstUserText || "").replace(/\s+/g, " ").trim();
          return {
            sessionId: String(r.sessionId),
            channel: String(r.channel || "web"),
            personaName: r.personaName || null,
            personaAvatar: personaAvatarByName(r.personaName),
            startedAt: r.startedAt || null,
            lastMessageAt: r.lastMessageAt || null,
            messagesCount: Number(r.messagesCount || 0),
            preview: previewRaw.slice(0, 80),
            topicHint: r.intent || null,
          };
        });

      const totalMessages = sessions.reduce((sum, s) => sum + s.messagesCount, 0);
      res.json({ data: { sessions, totalMessages }, error: null });
    } catch (e: any) {
      console.error("[GET /api/user/musa-history]", e);
      res.status(500).json({ data: null, error: "Не удалось получить историю" });
    }
  });

  // GET /api/user/musa-history/:sessionId — read-only вид одной сессии для
  // просмотра (ownership-check через chatbot_sessions.user_id).
  app.get("/api/user/musa-history/:sessionId", authMiddleware, (req: Request, res: Response) => {
    try {
      const userId = (req as any).userId as number;
      const sessionId = String(req.params.sessionId || "").trim();
      if (!sessionId) {
        res.status(400).json({ data: null, error: "Невалидный sessionId" });
        return;
      }
      const sess = sqliteDb.prepare(`
        SELECT id, channel, user_id, persona_name, started_at, last_message_at, intent
        FROM chatbot_sessions WHERE id = ?
      `).get(sessionId) as any;
      if (!sess) {
        res.status(404).json({ data: null, error: "Сессия не найдена" });
        return;
      }
      if (Number(sess.user_id) !== userId) {
        res.status(403).json({ data: null, error: "Доступ только к своим диалогам" });
        return;
      }
      // Eugene 2026-05-20 Босс «мини-плеер в чате»: подтягиваем attachedTrack
      // meta для bot-сообщений с attached_track_id (LEFT JOIN на generations).
      const messages = sqliteDb.prepare(`
        SELECT cm.id, cm.role, cm.text, cm.created_at AS createdAt, cm.attached_track_id AS attachedTrackId,
               g.display_title AS gTitle, g.prompt AS gPrompt, g.author_name AS gAuthor,
               g.status AS gStatus, g.is_public AS gIsPublic, g.deleted_at AS gDeletedAt,
               g.result_url AS gResultUrl, g.result_data AS gResultData, g.type AS gType
        FROM chatbot_messages cm
        LEFT JOIN generations g ON g.id = cm.attached_track_id
        WHERE cm.session_id = ?
        ORDER BY cm.id ASC
        LIMIT 1000
      `).all(sessionId) as any[];
      res.json({
        data: {
          session: {
            sessionId: String(sess.id),
            channel: String(sess.channel || "web"),
            personaName: sess.persona_name || null,
            personaAvatar: personaAvatarByName(sess.persona_name),
            startedAt: sess.started_at || null,
            lastMessageAt: sess.last_message_at || null,
            topicHint: sess.intent || null,
          },
          messages: messages.map((m) => {
            let attachedTrack: any = undefined;
            if (
              m.attachedTrackId &&
              m.gType === "music" &&
              m.gStatus === "done" &&
              (m.gIsPublic === 1 || m.gIsPublic === 2) &&
              !m.gDeletedAt &&
              m.gResultUrl
            ) {
              let duration = 0;
              try {
                const data = JSON.parse(m.gResultData || "{}");
                if (Array.isArray(data.result) && data.result[0]?.duration) {
                  duration = Number(data.result[0].duration) || 0;
                }
              } catch {}
              attachedTrack = {
                id: Number(m.attachedTrackId),
                title: m.gTitle || String(m.gPrompt || "").slice(0, 80) || "Без названия",
                authorName: m.gAuthor || null,
                audioUrl: `/api/stream/${m.attachedTrackId}`,
                coverUrl: `/api/cover/${m.attachedTrackId}.jpg`,
                durationSec: duration,
              };
            }
            return {
              id: Number(m.id),
              role: m.role === "user" ? "user" : "bot",
              text: String(m.text || ""),
              createdAt: m.createdAt || null,
              attachedTrack,
            };
          }),
        },
        error: null,
      });
    } catch (e: any) {
      console.error("[GET /api/user/musa-history/:sessionId]", e);
      res.status(500).json({ data: null, error: "Не удалось загрузить диалог" });
    }
  });

  // POST /api/user/musa-history/:sessionId/continue — пометить сессию как
  // «текущая» для юзера. Server возвращает sessionId + personaName/avatar;
  // клиент сам сохраняет в localStorage (_muzaChatSid) и через CustomEvent
  // открывает floating-consultant с этой сессией.
  app.post("/api/user/musa-history/:sessionId/continue", authMiddleware, (req: Request, res: Response) => {
    try {
      const userId = (req as any).userId as number;
      const sessionId = String(req.params.sessionId || "").trim();
      if (!sessionId) {
        res.status(400).json({ data: null, error: "Невалидный sessionId" });
        return;
      }
      const sess = sqliteDb.prepare(`
        SELECT id, channel, user_id, persona_name
        FROM chatbot_sessions WHERE id = ?
      `).get(sessionId) as any;
      if (!sess) {
        res.status(404).json({ data: null, error: "Сессия не найдена" });
        return;
      }
      if (Number(sess.user_id) !== userId) {
        res.status(403).json({ data: null, error: "Доступ только к своим диалогам" });
        return;
      }
      // Bump last_message_at чтобы сессия всплыла наверх списка.
      try {
        sqliteDb.prepare(`UPDATE chatbot_sessions SET last_message_at = CURRENT_TIMESTAMP WHERE id = ?`).run(sessionId);
      } catch {}
      res.json({
        data: {
          sessionId: String(sess.id),
          channel: String(sess.channel || "web"),
          personaName: sess.persona_name || null,
          personaAvatar: personaAvatarByName(sess.persona_name),
        },
        error: null,
      });
    } catch (e: any) {
      console.error("[POST /api/user/musa-history/:sessionId/continue]", e);
      res.status(500).json({ data: null, error: "Не удалось продолжить диалог" });
    }
  });

  // POST /api/lyrics/anonymous-save (PUBLIC) — anonymous text save with email
  // or code-only fallback. Rate-limit 5/час/IP.
  app.post("/api/lyrics/anonymous-save", async (req: Request, res: Response) => {
    try {
      const ip = String(req.headers["x-forwarded-for"] || req.socket?.remoteAddress || "").split(",")[0].trim() || "unknown";
      const now = Date.now();
      const windowMs = 60 * 60 * 1000;
      const tsList = (anonLyricsSaveByIp.get(ip) || []).filter((t) => now - t < windowMs);
      if (tsList.length >= 5) {
        res.status(429).json({ data: null, error: "rate-limit: 5 сохранений / час" });
        return;
      }
      tsList.push(now);
      anonLyricsSaveByIp.set(ip, tsList);

      const title = String(req.body?.title || "").trim().slice(0, 120);
      const text = String(req.body?.text || "").trim().slice(0, 8000);
      const emailRaw = String(req.body?.email || "").trim().toLowerCase();
      const chatSessionId = req.body?.chatSessionId ? String(req.body.chatSessionId).slice(0, 64) : null;
      if (!title) { res.status(400).json({ data: null, error: "Название не задано" }); return; }
      if (!text || text.length < 5) { res.status(400).json({ data: null, error: "Текст слишком короткий" }); return; }
      const hasEmail = emailRaw.length > 0;
      if (hasEmail && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(emailRaw)) {
        res.status(400).json({ data: null, error: "Email невалидный" });
        return;
      }

      // Generate 6-digit recovery code with up to 5 retries on collision.
      let code = "";
      let attempts = 0;
      while (attempts < 5) {
        code = String(Math.floor(100000 + Math.random() * 900000));
        const exists = sqliteDb.prepare(
          `SELECT 1 FROM pending_anonymous_lyrics WHERE recovery_code = ? AND claimed_by_user_id IS NULL`
        ).get(code);
        if (!exists) break;
        attempts++;
      }

      const expires = now + 30 * 24 * 60 * 60 * 1000;
      const result = sqliteDb.prepare(`
        INSERT INTO pending_anonymous_lyrics (recovery_code, email, title, text, chat_session_id, created_at, expires_at, email_sent)
        VALUES (?, ?, ?, ?, ?, ?, ?, 0)
      `).run(code, hasEmail ? emailRaw : null, title, text, chatSessionId, now, expires);
      const pendingId = Number(result.lastInsertRowid);

      // Send email if provided (best-effort).
      let emailSent = false;
      if (hasEmail && GMAIL_APP_PASSWORD) {
        try {
          const registerLink = `${PUBLIC_URL}/#/register?recovery=${code}`;
          await mailTransport.sendMail({
            from: `"MuzaAi" <${CLIENT_EMAIL}>`,
            replyTo: CLIENT_EMAIL,
            to: emailRaw,
            subject: `Твой текст «${title}» — MuzaAi`,
            text: `Муза сохранила твой текст «${title}».\n\nЧтобы забрать в личный кабинет — зарегистрируйся:\n${registerLink}\n\nКод восстановления: ${code} (введи в Настройках после регистрации).\n\nТекст:\n\n${text}\n\nКод действует 30 дней.\n\n— MuzaAi`,
            html: `
              <div style="font-family:-apple-system,sans-serif;max-width:520px;margin:0 auto;padding:32px;background:#09090b;border-radius:16px;border:1px solid #1a1a2e;color:#e2e2e2;">
                <div style="text-align:center;margin-bottom:24px;">
                  <span style="font-size:24px;font-weight:700;background:linear-gradient(135deg,#8b5cf6,#3b82f6);-webkit-background-clip:text;-webkit-text-fill-color:transparent;">MuzaAi</span>
                </div>
                <h2 style="color:#fff;margin:0 0 16px;">Твой текст «${title.replace(/</g, "&lt;")}»</h2>
                <p style="font-size:15px;line-height:1.6;">Чтобы забрать его в личный кабинет — заверши регистрацию:</p>
                <div style="text-align:center;margin:24px 0;">
                  <a href="${registerLink}" style="display:inline-block;padding:14px 28px;background:linear-gradient(135deg,#8b5cf6,#3b82f6);color:#fff;text-decoration:none;border-radius:12px;font-weight:600;">Завершить регистрацию</a>
                </div>
                <p style="font-size:13px;color:#888;text-align:center;margin:16px 0;">Или введи код в Настройках:</p>
                <div style="text-align:center;margin:8px 0 24px;">
                  <span style="display:inline-block;font-size:28px;font-weight:700;letter-spacing:8px;color:#fff;background:#1a1a2e;padding:12px 24px;border-radius:8px;">${code}</span>
                </div>
                <hr style="border:none;border-top:1px solid #1a1a2e;margin:24px 0;">
                <pre style="white-space:pre-wrap;font-family:inherit;font-size:14px;color:#bbb;line-height:1.6;">${text.slice(0, 4000).replace(/</g, "&lt;")}</pre>
                <p style="color:#555;font-size:12px;text-align:center;margin-top:24px;">Код действует 30 дней.</p>
              </div>
            `,
          });
          emailSent = true;
          sqliteDb.prepare(`UPDATE pending_anonymous_lyrics SET email_sent = 1 WHERE id = ?`).run(pendingId);
        } catch (e: any) {
          console.error("[POST /api/lyrics/anonymous-save] email send failed:", e?.message || e);
        }
      }

      // Audit-log
      try {
        sqliteDb.prepare(`
          INSERT INTO muza_user_actions (user_id, action_type, params_json, confirmed, confirmed_at, chat_session_id, created_at)
          VALUES (NULL, ?, ?, 1, ?, ?, ?)
        `).run(
          hasEmail ? "save_lyrics_with_email" : "save_lyrics_code_only",
          JSON.stringify({ pendingId, title, emailSent, hasEmail }),
          now, chatSessionId, now,
        );
      } catch {}

      res.json({ data: { code, emailSent, expiresAt: expires }, error: null });
    } catch (e: any) {
      console.error("[POST /api/lyrics/anonymous-save]", e);
      res.status(500).json({ data: null, error: "Не удалось сохранить" });
    }
  });

  // ==================== LYRICS ====================
  app.post("/api/lyrics/generate", authMiddleware, async (req: Request, res: Response) => {
    // Eugene 2026-05-11: lyrics ВСЕГДА доступен (даже в maintenance), чтобы
    // юзеры готовили тексты будущих песен. Maintenance блокирует только музыку.
    const userId = (req as any).userId;
    const user = storage.getUser(userId);
    if (!user) { res.status(404).json({ message: "Пользователь не найден" }); return; }
    const { prompt, genre, mood, language } = req.body;
    if (!prompt) {
      res.status(400).json({ message: "Опишите тему песни" });
      return;
    }

    const charge = checkAndCharge(userId, "lyrics");
    if (!charge.ok) {
      res.status(402).json({ message: charge.error });
      return;
    }

    try {

      const gen = storage.createGeneration({
        userId,
        type: "lyrics",
        prompt,
        style: JSON.stringify({ genre, mood, language }),
        cost: charge.isFree ? 0 : PRICES.lyrics,
        status: "processing",
      });

      const systemPrompt = `Ты профессиональный автор текстов песен для Suno AI. Пиши на ${language === "en" ? "английском" : "русском"} языке. Жанр: ${genre || "поп"}. Настроение: ${mood || "нейтральное"}.
Формат: [Куплет 1], [Припев], [Куплет 2], [Бридж].
KRITICHESKOE OGRANICHENIE: текст МАКСИМУМ 350 символов включая пометки секций. Превышение = ошибка.
Пиши ОЧЕНЬ компактно: 4 строки на куплет, 4 на припев, 2 на бридж. Каждая строка не более 25 символов. Не добавляй пояснений, только текст песни.`;

      const resp = await gptunnelFetch("/chat/completions", {
        method: "POST",
        body: JSON.stringify({
          model: "gpt-4o-mini",
          messages: [
            { role: "system", content: systemPrompt },
            { role: "user", content: prompt },
          ],
          max_tokens: 300,
          temperature: 0.8,
        }),
      });

      const data = await resp.json();

      if (!resp.ok) {
        storage.updateGeneration(gen.id, { status: "error" });
        if (!charge.isFree) {
          storage.refundGeneration({ genId: gen.id, userId, cost: gen.cost || 9900, type: "lyrics", description: `Возврат: ошибка генерации #${gen.id}` });
        }
        res.status(500).json({ message: data.error?.message || "Ошибка API" });
        return;
      }

      let lyrics = data.choices?.[0]?.message?.content || "";
      // Жёсткое ограничение 400 символов для Suno
      if (lyrics.length > 400) {
        // Обрезаем по последней полной строке
        const trimmed = lyrics.slice(0, 400);
        const lastNewline = trimmed.lastIndexOf("\n");
        lyrics = lastNewline > 200 ? trimmed.slice(0, lastNewline) : trimmed;
      }
      storage.updateGeneration(gen.id, { status: "done", resultUrl: lyrics });
      console.log(`[LYRICS] Generated ${lyrics.length} chars for gen #${gen.id}`);
      saveGenFiles(gen.id).catch(() => {});

      const updatedUser = storage.getUser(userId);
      res.json({ id: gen.id, lyrics, balance: updatedUser?.balance });
    } catch (e: any) {
      res.status(500).json({ message: "Ошибка: " + e.message });
    }
  });

  // ==================== MUSIC (SUNO) ====================
  app.post("/api/music/generate", authMiddleware, async (req: Request, res: Response) => {
    const userId = (req as any).userId;
    logEngagement(req, "music_generate_attempt", { channel: "site", userId, meta: { mode: req.body?.mode || req.body?.tab || "unknown" } });
    if (process.env.GENERATION_MAINTENANCE === "1") {
      return res.status(503).json({
        message: "🛠 Скоро запускаемся! Пока зарегистрируйтесь и подумайте о смысле будущей песни — её текст можно будет написать прямо здесь, в окне генерации, как только откроем доступ.",
        maintenance: true,
      });
    }
    const user = storage.getUser(userId);
    if (!user) { res.status(404).json({ message: "Пользователь не найден" }); return; }
    // Suno-watchdog circuit breaker — Eugene 2026-05-08 «Реши кардинально».
    // Если Suno глобально недоступен (баланс=0, ключ невалид, error-rate>80%)
    // — отказываем СРАЗУ, до charge. Иначе юзер бы получил error+refund цикл.
    if (isSunoCircuitOpen()) {
      res.status(503).json({ message: "MuzaAi временно недоступен. Мы уже работаем над проблемой — мы уже работаем над ней. Попробуйте через 5–10 минут." });
      return;
    }
    const {
      prompt, style, lyrics, title, instrumental, voice, voiceType, isDuet,
      authorName, isPublic, category,
      // Eugene 2026-05-18: Suno advanced params (Docs-first-always rule).
      // Reference: https://docs.kie.ai/suno-api/generate-music (kie.ai is the
      // GPTunnel upstream) + https://docs.sunoapi.org/suno-api/generate-music.
      // Все опциональны — если не переданы, Suno использует defaults.
      //   negativeTags  : str — что НЕ должно быть в музыке («Heavy Metal, EDM»). 200ch.
      //   weirdness     : 0..1 multiple of 0.01 (creative deviation; default 0.3)
      //   styleWeight   : 0..1 multiple of 0.01 (adherence to style; default 0.5)
      //   vocalGender   : "m" | "f" — preferred gender (НЕ применяется при duet/instrumental)
      //   modelVersion  : "V3_5" | "V4" | "V4_5" | "V4_5PLUS" | "V5" (если не передан — GPTunnel сам)
      negativeTags, weirdness, styleWeight, vocalGender, modelVersion,
    } = req.body;
    if (!prompt && !lyrics) {
      res.status(400).json({ message: "Опишите желаемый трек или вставьте текст" });
      return;
    }
    // Server-side guard для advanced params (UI тоже clamp'ит).
    const clampUnit = (v: any): number | undefined => {
      if (v === undefined || v === null || v === "") return undefined;
      const n = typeof v === "number" ? v : parseFloat(String(v));
      if (!isFinite(n)) return undefined;
      return Math.round(Math.max(0, Math.min(1, n)) * 100) / 100;
    };
    const cleanWeirdness = clampUnit(weirdness);
    const cleanStyleWeight = clampUnit(styleWeight);
    const cleanNegativeTags = typeof negativeTags === "string" && negativeTags.trim()
      ? negativeTags.trim().slice(0, 200)
      : undefined;
    const cleanVocalGender = vocalGender === "m" || vocalGender === "f" ? vocalGender : undefined;
    const ALLOWED_MODELS = new Set(["V3_5", "V4", "V4_5", "V4_5PLUS", "V5"]);
    const cleanModelVersion = typeof modelVersion === "string" && ALLOWED_MODELS.has(modelVersion)
      ? modelVersion
      : undefined;

    const charge = checkAndCharge(userId, "music");
    if (!charge.ok) {
      res.status(402).json({ message: charge.error });
      return;
    }

    try {

      const gen = storage.createGeneration({
        userId,
        type: "music",
        prompt: prompt || lyrics || "",
        style: JSON.stringify({
          style, title, instrumental, category: category || 'song',
          // Eugene 2026-05-18: сохраняем advanced params для regenerate/audit.
          ...(cleanNegativeTags ? { negativeTags: cleanNegativeTags } : {}),
          ...(cleanWeirdness !== undefined ? { weirdness: cleanWeirdness } : {}),
          ...(cleanStyleWeight !== undefined ? { styleWeight: cleanStyleWeight } : {}),
          ...(cleanVocalGender ? { vocalGender: cleanVocalGender } : {}),
          ...(cleanModelVersion ? { modelVersion: cleanModelVersion } : {}),
        }),
        cost: charge.isFree ? 0 : PRICES.music,
        status: "processing",
        isPublic: isPublic === false ? 0 : 1,
        authorName: authorName || user.name || "Аноним",
      });

      // Eugene 2026-05-07: единый нормализатор voice. Раньше было 4 точки
      // независимого формирования voiceTag (с дефолтом на Female), что
      // приводило к потере выбранного голоса при duet/instrumental.
      const norm = normalizeVocalParams({
        prompt,
        style,
        lyrics,
        voiceType,
        voice,
        isDuet,
        instrumental,
        generationId: gen.id,
      });
      // Сохраняем нормализованный voiceType в БД для future regenerate.
      try {
        db.update(generations).set({ voiceType: norm.voiceType }).where(eq(generations.id, gen.id)).run();
      } catch (e) {
        console.error(`[VOCAL-NORMALIZE] failed to save voiceType for gen #${gen.id}`, e);
      }

      // Build the media create payload per GPTunnel Suno API docs
      const rawLyrics = norm.finalLyrics || lyrics || "";
      const rawPrompt = norm.finalPrompt || prompt || "";
      const fullTags = norm.finalStyle;
      const isInstrumental = norm.voiceType === "instrumental";
      const payload: any = {
        model: "suno",
      };

      // Auto-generate title if not provided (required by GPTunnel for custom/instrumental modes)
      const autoTitle = title || rawLyrics.split("\n")[0]?.replace(/^\[.*?\]\s*/, "").slice(0, 80) || rawPrompt.slice(0, 80) || "Мой трек";

      // Use lyrics as fallback prompt if prompt is empty
      const effectivePrompt = rawPrompt || rawLyrics.split("\n").slice(0, 3).join(" ").slice(0, 400);

      if (isInstrumental) {
        // GPTunnel instrumental mode is broken — use basic mode with instrumental hint in prompt
        payload.prompt = `Instrumental, no vocals. ${fullTags || ""} ${effectivePrompt}`.trim().slice(0, 400);
      } else if (rawLyrics && rawLyrics.length >= 50) {
        // Custom mode: user provided enough lyrics (GPTunnel/Suno requires min 50 chars)
        payload.mode = "custom";
        payload.lyric = rawLyrics.slice(0, 3000);
        payload.title = autoTitle.slice(0, 80);
        if (fullTags) payload.tags = fullTags.slice(0, 200);
        if (rawPrompt) payload.prompt = rawPrompt.slice(0, 400);
      } else {
        // Basic mode: just prompt, Suno auto-generates lyrics
        const basicPrompt = (effectivePrompt || rawLyrics || "Песня").slice(0, 400);
        payload.prompt = basicPrompt || "Песня";
        if (rawLyrics && rawLyrics.length > 0 && rawLyrics.length < 50) {
          console.log(`[MUSIC] Short lyrics (${rawLyrics.length}ch) — falling back to basic mode for gen #${gen.id}`);
        }
      }

      // Eugene 2026-05-19 — docs-research 2026-05-19 подтвердил: kie.ai/GPTunnel
      // /media/create ожидают camelCase (`negativeTags`, `weirdnessConstraint`,
      // `styleWeight`, `vocalGender`, `modelVersion`, `webhookUrl`). Reference:
      // docs.kie.ai/suno-api/generate-music + docs.gptunnel.ru/media-api/suno.
      // Имена правильные → re-enable. Root cause ошибок 841-857 был в другом
      // (вероятно — leave-page без server-side polling; теперь чиним webhook).
      if (cleanNegativeTags) payload.negativeTags = cleanNegativeTags;
      if (cleanWeirdness !== undefined) payload.weirdnessConstraint = cleanWeirdness;
      if (cleanStyleWeight !== undefined) payload.styleWeight = cleanStyleWeight;
      if (cleanVocalGender && !isInstrumental && norm.voiceType !== "duet") {
        payload.vocalGender = cleanVocalGender;
      }
      if (cleanModelVersion) payload.modelVersion = cleanModelVersion;

      // Webhook callback — устраняет leave-page проблему. Suno postит результат
      // на /api/suno/webhook когда готов; нам не нужен client-side polling.
      // Reference: docs.kie.ai/suno-api/generate-music — поле `webhookUrl`
      // camelCase. Eugene 2026-05-19 Триумф «Реши на 1000%»: belt-and-braces —
      // отдаём ТРИ варианта имени поля (webhookUrl/callBackUrl/callback_url),
      // потому что разные провайдеры/версии GPTunnel/kie.ai используют разные.
      // Provider игнорирует unknown поля без ошибки.
      try {
        const wh = buildSunoCallbackUrl(req, gen.id);
        if (wh) {
          payload.webhookUrl = wh;
          payload.callBackUrl = wh;
          payload.callback_url = wh;
        }
      } catch {}

      console.log(`[MUSIC] gen #${gen.id} voiceType=${norm.voiceType} mode=${payload.mode || "basic"} prompt=${(payload.prompt || "").length}ch lyrics=${(payload.lyric || "").length}ch tags="${(payload.tags || "").slice(0, 100)}" adv={neg:${!!cleanNegativeTags},w:${cleanWeirdness ?? "-"},sw:${cleanStyleWeight ?? "-"},vg:${cleanVocalGender ?? "-"},mv:${cleanModelVersion ?? "-"}}`);

      // Eugene 2026-05-08 «название всегда сохраняй»: persist autoTitle в
      // displayTitle (юзер видит в дашборде) И в style.title (для retry).
      // Только сам юзер может потом менять displayTitle через /rename endpoint.
      try {
        db.update(generations).set({ displayTitle: autoTitle.slice(0, 200) }).where(eq(generations.id, gen.id)).run();
      } catch {}

      // Eugene 2026-05-08 АК-аудит: сохраняем актуальный mode + voiceType в style.
      try {
        const existingMeta = JSON.parse(gen.style || "{}");
        const updatedMeta = {
          ...existingMeta,
          mode: payload.mode || "basic",
          voiceType: norm.voiceType,
          tags: payload.tags || null,
          title: autoTitle, // ПРАВИЛО: всегда сохраняем полное название
          // храним lyric отдельно от prompt чтобы retry мог точно воспроизвести
          lyric: payload.lyric || null,
          basicPrompt: payload.mode === "custom" ? null : (payload.prompt || null),
        };
        db.update(generations).set({ style: JSON.stringify(updatedMeta) }).where(eq(generations.id, gen.id)).run();
      } catch {}

      // Eugene 2026-05-08 21:42: REVERT callback_url. Сравнение с prod показало
      // что там callback_url НЕ передаётся и Suno работает. На clone после
      // добавления callback_url появились зависания #672/#673. Точная причина
      // неясна (формат поля? unreachable webhook?). Возвращаемся к polling-only
      // как на prod. Webhook endpoint остаётся как dormant защита если когда-то
      // GPTunnel docs подтвердят правильный формат.

      const resp = await gptunnelFetch("/media/create", {
        method: "POST",
        body: JSON.stringify(payload),
      });

      const data = await resp.json();
      console.log(`[MUSIC] GPTunnel response for gen #${gen.id}:`, JSON.stringify(data).slice(0, 300));

      if (!resp.ok || data.error || (data.code && data.code !== 0)) {
        const apiErrText = data.error?.message || data.message || `HTTP ${resp.status}`;
        storage.updateGeneration(gen.id, { status: "error", errorReason: `MuzaAi отклонил запрос: ${apiErrText}` });
        if (!charge.isFree) {
          storage.refundGeneration({ genId: gen.id, userId, cost: gen.cost || 9900, type: "music", description: `Возврат: ошибка генерации #${gen.id}` });
        }
        // Extract detailed validation error (GPTunnel/Suno schema issues)
        let userMsg = data.error?.message || data.message || "Ошибка API";
        if (Array.isArray(data.issues) && data.issues.length > 0) {
          const humanIssues = data.issues.map((iss: any) => {
            const path = (iss.path || []).join(".");
            if (iss.code === "too_small" && path === "lyric") {
              return `Текст песни слишком короткий (нужно минимум ${iss.minimum} символов).`;
            }
            if (iss.code === "too_big" && path === "lyric") {
              return `Текст песни слишком длинный (максимум ${iss.maximum} символов).`;
            }
            if (iss.code === "too_small" && path === "prompt") {
              return `Описание стиля слишком короткое (нужно минимум ${iss.minimum} символов).`;
            }
            if (iss.code === "too_small" && path === "title") {
              return `Название трека обязательно.`;
            }
            return iss.message ? `${path || "поле"}: ${iss.message}` : null;
          }).filter(Boolean);
          if (humanIssues.length) userMsg = humanIssues.join(" ");
        }
        console.log(`[MUSIC] Returning error to user for gen #${gen.id}: ${userMsg}`);
        res.status(400).json({ message: userMsg });
        return;
      }

      const taskId = data.id;
      if (!taskId) {
        // Eugene 2026-05-08 audit C: ранний фикс zombie-gens. Без taskId
        // никто не сможет polling сделать → зависание до 30-мин cutoff.
        // Сразу error+refund+errorReason.
        console.error(`[MUSIC] No taskId from GPTunnel for gen #${gen.id} — refunding immediately`);
        storage.updateGeneration(gen.id, { status: "error", errorReason: "Не получили task_id от MuzaAi. Это редкая сетевая проблема. Баланс возвращён, попробуйте ещё раз." });
        if (!charge.isFree) {
          storage.refundGeneration({ genId: gen.id, userId, cost: gen.cost || 9900, type: "music", description: `Возврат: нет task_id #${gen.id}` });
        }
        res.status(500).json({ message: "Ошибка создания трека. Попробуйте снова." });
        return;
      }

      storage.updateGeneration(gen.id, { taskId, status: "processing" });

      const updatedUser = storage.getUser(userId);
      res.json({ id: gen.id, taskId, balance: updatedUser?.balance });
    } catch (e: any) {
      res.status(500).json({ message: "Ошибка: " + e.message });
    }
  });

  app.get("/api/music/status/:taskId", authMiddleware, async (req: Request, res: Response) => {
    try {
      const resp = await gptunnelFetch("/media/result", {
        method: "POST",
        body: JSON.stringify({ task_id: req.params.taskId }),
      });
      const data = await resp.json();

      const gen = storage.getGenerationByTaskId(req.params.taskId);
      if (gen) {
        // Suno returns result as array of tracks [{audio_url, image_url, lyric, ...}]
        const isDone = data.status === "done" || 
          (Array.isArray(data.result) && data.result.some((t: any) => t.status === "succeeded"));
        
        if (isDone && data.result) {
          // Pick the first succeeded track (not just result[0] which may still be running)
          const firstTrack = Array.isArray(data.result)
            ? (data.result.find((t: any) => t.status === "succeeded" && t.audio_url) || data.result[0])
            : null;
          const audioUrl = firstTrack?.audio_url || (typeof data.result === "string" ? data.result : null);
          
          if (!audioUrl) {
            // Result arrived but no URL — mark as error
            console.error(`[MUSIC] Gen #${gen.id}: done but no audio URL`);
            storage.updateGeneration(gen.id, { status: "error", errorReason: "MuzaAi не прислала аудио. Баланс восстановлен — попробуйте ещё раз, обычно второй раз получается." });
            // рефанд при отсутствии audioUrl (атомарно — orphan-scanner не задвоит)
            try {
              storage.refundGeneration({ genId: gen.id, userId: gen.userId, cost: gen.cost, type: "music", description: `Возврат: пустой ответ MuzaAi #${gen.id}` });
            } catch {}
            data.status = "error";
          } else {
            // Verify URL is accessible AND содержит реальный mp3 (>=100KB).
            // Eugene 2026-05-08 docs-first: HEAD без size-check пропускает
            // битые/preview-обрубки 0-1 сек. Защита от ложных done.
            try {
              const check = await fetch(audioUrl, { method: "HEAD", signal: AbortSignal.timeout(8_000) });
              const cl = Number(check.headers.get("content-length") || 0);
              if (check.ok && (cl === 0 || cl >= 100_000)) {
                storage.updateGeneration(gen.id, {
                  status: "done",
                  resultUrl: audioUrl,
                  resultData: JSON.stringify(data),
                });
                data.status = "done";
                data.audioUrl = audioUrl;
                data.imageUrl = firstTrack?.image_url;
                data.lyric = firstTrack?.lyric;
                data.tracks = data.result;
                console.log(`[MUSIC] Gen #${gen.id}: DONE, URL verified`);
                // Save to author folder in background
                saveGenFiles(gen.id).catch(() => {});

                // If there's a second succeeded track, create a separate generation for it
                if (Array.isArray(data.result) && data.result.length > 1) {
                  const secondTrack = data.result.find((t: any, i: number) => i > 0 && t.status === "succeeded" && t.audio_url);
                  if (secondTrack && !storage.getGenerationByTaskId(req.params.taskId + "_v2")) {
                    const gen2 = storage.createGeneration({
                      userId: gen.userId,
                      type: "music",
                      prompt: gen.prompt,
                      style: gen.style, // copy style/category from original
                      cost: 0,
                      taskId: req.params.taskId + "_v2",
                      authorName: gen.authorName || undefined,
                      isPublic: gen.isPublic,
                    });
                    storage.updateGeneration(gen2.id, {
                      status: "done",
                      resultUrl: secondTrack.audio_url,
                      resultData: JSON.stringify({ result: [secondTrack] }),
                    });
                    console.log(`[MUSIC] Gen #${gen2.id}: variant 2 saved as separate generation`);
                    saveGenFiles(gen2.id).catch(() => {});
                  }
                }
              } else {
                // Eugene 2026-05-19 Босс «Реши на 1000%». ROOT CAUSE 1905:
                // HEAD на Suno CDN временно 404 → ставили error поверх
                // done → красная карточка в кабинете при играющем audio.
                // Guard 1: retry HEAD 3 раза с 2-сек паузой (CDN warmup)
                let recheckOk = false;
                for (let i = 0; i < 3 && !recheckOk; i++) {
                  await new Promise(r => setTimeout(r, 2_000));
                  try {
                    const r2 = await fetch(audioUrl, { method: "HEAD", signal: AbortSignal.timeout(8_000) });
                    const cl2 = Number(r2.headers.get("content-length") || 0);
                    if (r2.ok && (cl2 === 0 || cl2 >= 100_000)) recheckOk = true;
                  } catch {}
                }
                if (recheckOk) {
                  storage.updateGeneration(gen.id, { status: "done", resultUrl: audioUrl, resultData: JSON.stringify(data) });
                  data.status = "done";
                  data.audioUrl = audioUrl;
                  saveGenFiles(gen.id).catch(() => {});
                  console.log(`[MUSIC] Gen #${gen.id}: DONE после retry HEAD`);
                } else {
                  // Guard 2: НЕ ставим error если gen уже done (webhook успел)
                  const freshGen = storage.getGeneration(gen.id);
                  if (freshGen && freshGen.status === "processing") {
                    console.error(`[MUSIC] Gen #${gen.id}: URL returned ${check.status} (3 retries failed)`);
                    storage.updateGeneration(gen.id, { status: "error", errorReason: "Файл временно не пришёл. Баланс восстановлен — попробуйте ещё раз через минуту." });
                    try {
                      storage.refundGeneration({ genId: gen.id, userId: gen.userId, cost: gen.cost, type: "music", description: `Возврат: файл недоступен #${gen.id}` });
                    } catch {}
                    data.status = "error";
                  } else {
                    // Gen уже done (webhook успел) — оставляем как есть
                    console.log(`[MUSIC] Gen #${gen.id}: HEAD failed но gen.status=${freshGen?.status}, оставляем`);
                    data.status = freshGen?.status || "done";
                    data.audioUrl = freshGen?.resultUrl || audioUrl;
                  }
                }
              }
            } catch {
              // Network error checking URL — still save, URL might work for client
              storage.updateGeneration(gen.id, {
                status: "done",
                resultUrl: audioUrl,
                resultData: JSON.stringify(data),
              });
              data.status = "done";
              data.audioUrl = audioUrl;
              data.imageUrl = firstTrack?.image_url;
              data.tracks = data.result;
              saveGenFiles(gen.id).catch(() => {});
            }
          }
        } else if (data.status === "error" || data.status === "failed") {
          // Check if at least one track succeeded despite overall "error" status
          const succeededTrack = Array.isArray(data.result)
            ? data.result.find((t: any) => t.status === "succeeded" && t.audio_url)
            : null;
          if (succeededTrack) {
            // Partial success — treat as done using the succeeded track
            const audioUrl = succeededTrack.audio_url;
            storage.updateGeneration(gen.id, {
              status: "done",
              resultUrl: audioUrl,
              resultData: JSON.stringify(data),
            });
            data.status = "done";
            data.audioUrl = audioUrl;
            data.imageUrl = succeededTrack.image_url;
            data.lyric = succeededTrack.lyric;
            data.tracks = data.result;
            console.log(`[MUSIC] Gen #${gen.id}: partial success, using succeeded track`);
            saveGenFiles(gen.id).catch(() => {});
          } else {
            data.status = "error";
            // Понятное позитивное сообщение для автора о причине
            const rawMsg = String(data.message || "").toLowerCase();
            if (data.code === 1001 || rawMsg.includes("sensitive")) {
              data.userMessage = "MuzaAi-модерация попросила перефразировать (имена публичных людей, бренды, агрессивные слова — частые причины). Баланс уже на месте, попробуйте ещё раз с другим текстом.";
            } else if (rawMsg.includes("timeout") || rawMsg.includes("timed out")) {
              data.userMessage = "MuzaAi думала дольше обычного. Баланс восстановлен — давайте попробуем ещё раз?";
            } else if (data.message) {
              data.userMessage = `Не получилось этот раз: ${data.message}. Баланс возвращён, попробуйте снова.`;
            } else {
              data.userMessage = "На этот раз не получилось — баланс уже на месте, попробуйте ещё раз.";
            }
            // Сразу пишем errorReason в gen чтобы юзер видел причину в дашборде
            storage.updateGeneration(gen.id, { status: "error", errorReason: data.userMessage });
            // Возврат средств при ошибке генерации (атомарно — claim-once)
            if (gen.cost > 0) {
              if (storage.refundGeneration({ genId: gen.id, userId: gen.userId, cost: gen.cost, type: "music", description: `Возврат: ошибка генерации #${gen.id}` })) {
                console.log(`[REFUND] Music #${gen.id} (${data.userMessage})`);
              }
            } else if (storage.claimRefund(gen.id)) {
              db.update(users).set({ bonusTracks: sql`${users.bonusTracks} + 1` }).where(eq(users.id, gen.userId)).run();
              storage.createTransaction({ userId: gen.userId, type: "music", amount: 0, description: `🎁 Возврат подарочного трека: ошибка #${gen.id}` });
              console.log(`[REFUND] Bonus track Music #${gen.id}`);
            }
            // errorReason уже сохранён выше в одном вызове — больше не дублируем
          }
        }
      }

      res.json(data);
    } catch (e: any) {
      res.status(500).json({ message: "Ошибка: " + e.message });
    }
  });

  // ==================== SUNO STYLE-COVER & EXTEND ====================
  // Re-imagines an existing track in a new style (suno-cover model).
  // Source track: any music gen the user owns OR is admin.
  app.post("/api/music/style-cover", authMiddleware, async (req: Request, res: Response) => {
    const userId = (req as any).userId;
    const user = storage.getUser(userId);
    if (!user) { res.status(404).json({ message: "Автор не найден" }); return; }
    if (isSunoCircuitOpen()) { res.status(503).json({ message: "MuzaAi временно недоступен. Мы уже работаем над проблемой. Попробуйте через 5–10 минут." }); return; }
    const { sourceId, newStyle, voice, voiceType, isDuet, instrumental, isPublic, category, authorName } = req.body;
    if (!sourceId) { res.status(400).json({ message: "Исходный трек не указан" }); return; }
    if (!newStyle || newStyle.length < 3) { res.status(400).json({ message: "Опишите новый стиль" }); return; }

    const source = db.select().from(generations).where(eq(generations.id, parseInt(sourceId))).get();
    if (!source || source.type !== "music" || source.status !== "done") {
      res.status(404).json({ message: "Исходный трек не найден или ещё в обработке" });
      return;
    }
    // Author-only: ремикс разрешён только владельцу трека или админу
    const isAdmin = isAdminUser(user);
    if (source.userId !== userId && !isAdmin) {
      res.status(403).json({ message: "Можно ремиксовать только свои треки" });
      return;
    }

    const charge = checkAndCharge(userId, "music");
    if (!charge.ok) { res.status(402).json({ message: charge.error }); return; }

    try {
      // Eugene 2026-05-07: используем единый нормализатор. Если пользователь
      // не передал явный voiceType при ремиксе — берём из source.voiceType.
      const inheritedVoiceType = (source as any).voiceType ?? null;
      const norm = normalizeVocalParams({
        prompt: `Кавер в стиле ${newStyle}`,
        style: newStyle,
        voiceType: voiceType ?? inheritedVoiceType,
        voice,
        isDuet,
        instrumental,
        generationId: source.id,
      });
      const fullTags = norm.finalStyle;

      const sourceMeta = (() => { try { return JSON.parse(source.style || "{}"); } catch { return {}; } })();
      const sourceTitle = source.displayTitle || source.prompt || "Трек";

      const gen = storage.createGeneration({
        userId,
        type: "music",
        prompt: `Кавер «${sourceTitle}» в стиле ${newStyle}`,
        style: JSON.stringify({
          style: newStyle,
          title: sourceTitle,
          category: category || sourceMeta.category || 'song',
          mode: 'cover',
          parentId: source.id,
        }),
        cost: charge.isFree ? 0 : PRICES.music,
        status: "processing",
        isPublic: isPublic === false ? 0 : 1,
        authorName: authorName || user.name || "Аноним",
      });

      // Правило Eugene 2026-05-08: всегда сохраняем название (для кавера = от source)
      try {
        db.update(generations).set({ displayTitle: `Кавер · ${sourceTitle.slice(0, 150)}` }).where(eq(generations.id, gen.id)).run();
      } catch {}

      // Public URL the Suno service can fetch
      const audioUrl = `${PUBLIC_URL}/api/stream/${source.id}`;
      const sourceTaskId = source.taskId || "";

      // Try multiple payload shapes — GPTunnel docs are missing for cover/extend.
      // We log every attempt and stop on the first success (status ≠ failed).
      const attempts = [
        { model: "suno-cover", prompt: fullTags, audio_url: audioUrl, mode: "basic" },
        { model: "suno-cover", prompt: fullTags, music_id: sourceTaskId, mode: "basic" },
        { model: "suno-cover", prompt: fullTags, task_id: sourceTaskId, mode: "basic" },
        { model: "suno-cover", prompt: fullTags, source_url: audioUrl, mode: "basic" },
        { model: "suno-cover", prompt: fullTags, input_audio: audioUrl, mode: "basic" },
      ];

      let data: any = null;
      let usedShape: any = null;
      for (const payload of attempts) {
        const r = await gptunnelFetch("/media/create", { method: "POST", body: JSON.stringify(payload) });
        const j: any = await r.json();
        console.log(`[COVER] Try ${JSON.stringify(Object.keys(payload))} → code=${j.code} status=${j.status}`);
        if (j.code === 0 || (j.id && j.status !== "failed")) {
          data = j;
          usedShape = payload;
          break;
        }
        // remember last response for fallback error
        data = j;
      }

      if (!data || !data.id || data.status === "failed") {
        storage.updateGeneration(gen.id, { status: "error", errorReason: "Режим Кавер сейчас недоступен. Баланс возвращён, попробуйте через пару минут." });
        if (!charge.isFree) {
          storage.refundGeneration({ genId: gen.id, userId, cost: gen.cost || 9900, type: "music", description: `Возврат: режим Кавер недоступен #${gen.id}` });
        }
        res.status(503).json({
          message: "Режим Кавер временно недоступен — ждём формат API от GPTunnel. Баланс возвращён.",
          attempted: attempts.length,
          lastResponse: data?.message || data,
        });
        return;
      }

      const taskId = data.id;
      storage.updateGeneration(gen.id, { taskId, status: "processing" });
      console.log(`[COVER] Started gen #${gen.id} task=${taskId} via shape=${JSON.stringify(Object.keys(usedShape))}`);
      res.json({ generationId: gen.id, taskId, message: "Кавер создаётся…" });
    } catch (e: any) {
      console.error("[COVER] Exception:", e?.message || e);
      res.status(500).json({ message: "Ошибка сервера: " + (e?.message || "unknown") });
    }
  });

  // Extends an existing track — adds a new section starting at `continueAt` seconds.
  app.post("/api/music/extend", authMiddleware, async (req: Request, res: Response) => {
    const userId = (req as any).userId;
    const user = storage.getUser(userId);
    if (!user) { res.status(404).json({ message: "Автор не найден" }); return; }
    if (isSunoCircuitOpen()) { res.status(503).json({ message: "MuzaAi временно недоступен. Мы уже работаем над проблемой. Попробуйте через 5–10 минут." }); return; }
    const { sourceId, continueAt, prompt, lyrics, voice, isPublic, category, authorName } = req.body;
    if (!sourceId) { res.status(400).json({ message: "Исходный трек не указан" }); return; }
    if (continueAt === undefined || continueAt < 0) {
      res.status(400).json({ message: "Укажите время, с которого продолжить" });
      return;
    }

    const source = db.select().from(generations).where(eq(generations.id, parseInt(sourceId))).get();
    if (!source || source.type !== "music" || source.status !== "done") {
      res.status(404).json({ message: "Исходный трек не найден или в обработке" });
      return;
    }
    // Author-only: продление разрешено только владельцу или админу
    const isAdmin = isAdminUser(user);
    if (source.userId !== userId && !isAdmin) {
      res.status(403).json({ message: "Можно продлевать только свои треки" });
      return;
    }

    const charge = checkAndCharge(userId, "music");
    if (!charge.ok) { res.status(402).json({ message: charge.error }); return; }

    try {
      const sourceMeta = (() => { try { return JSON.parse(source.style || "{}"); } catch { return {}; } })();
      const sourceTitle = source.displayTitle || source.prompt || "Трек";
      const sourceStyle = sourceMeta.style || "";

      // ТЗ Eugene 2026-05-07: продление наследует voiceType от источника
      // если пользователь явно не сменил. Раньше extend терял голос полностью.
      const inheritedVoiceType = (source as any).voiceType ?? null;

      const gen = storage.createGeneration({
        userId,
        type: "music",
        prompt: `Продление «${sourceTitle}» с ${continueAt}с${prompt ? ": " + prompt : ""}`,
        style: JSON.stringify({
          style: sourceStyle,
          title: sourceTitle + " (продолжение)",
          category: category || sourceMeta.category || 'song',
          mode: 'extend',
          parentId: source.id,
          continueAt,
        }),
        cost: charge.isFree ? 0 : PRICES.music,
        status: "processing",
        isPublic: isPublic === false ? 0 : 1,
        authorName: authorName || user.name || "Аноним",
      });

      // Правило Eugene 2026-05-08: всегда сохраняем название
      try {
        db.update(generations).set({ displayTitle: `${sourceTitle.slice(0, 150)} (продолжение)` }).where(eq(generations.id, gen.id)).run();
      } catch {}

      const norm = normalizeVocalParams({
        prompt: prompt || sourceStyle,
        style: sourceStyle,
        lyrics,
        voice,
        voiceType: inheritedVoiceType,
        generationId: gen.id,
      });
      try {
        db.update(generations).set({ voiceType: norm.voiceType }).where(eq(generations.id, gen.id)).run();
      } catch (e) {
        console.error(`[VOCAL-NORMALIZE] failed to save voiceType for extend gen #${gen.id}`, e);
      }

      const audioUrl = `${PUBLIC_URL}/api/stream/${source.id}`;
      const sourceTaskId = source.taskId || "";
      const promptText = norm.finalPrompt || prompt || sourceStyle || "Продолжение";

      const attempts = [
        { model: "suno-extend", prompt: promptText, audio_url: audioUrl, continue_at: continueAt },
        { model: "suno-extend", prompt: promptText, music_id: sourceTaskId, continue_at: continueAt },
        { model: "suno-extend", prompt: promptText, task_id: sourceTaskId, continue_at: continueAt },
        { model: "suno-extend", prompt: promptText, audio_url: audioUrl, continueAt },
        { model: "suno-extend", prompt: promptText, source_url: audioUrl, continue_at: continueAt },
      ];
      // Custom mode adds lyrics if provided. Используем нормализованные lyrics
      // (с правильной [Male]/[Female] разбивкой для дуэта) и тэги стиля.
      const normLyrics = norm.finalLyrics || lyrics || "";
      if (normLyrics && normLyrics.length >= 50) {
        for (const a of attempts) {
          a.mode = "custom";
          (a as any).lyric = normLyrics.slice(0, 3000);
          (a as any).title = sourceTitle.slice(0, 80);
          if (norm.finalStyle) (a as any).tags = norm.finalStyle.slice(0, 200);
        }
      }

      let data: any = null;
      let usedShape: any = null;
      for (const payload of attempts) {
        const r = await gptunnelFetch("/media/create", { method: "POST", body: JSON.stringify(payload) });
        const j: any = await r.json();
        console.log(`[EXTEND] Try ${JSON.stringify(Object.keys(payload))} → code=${j.code} status=${j.status}`);
        if (j.code === 0 || (j.id && j.status !== "failed")) {
          data = j;
          usedShape = payload;
          break;
        }
        data = j;
      }

      if (!data || !data.id || data.status === "failed") {
        storage.updateGeneration(gen.id, { status: "error", errorReason: "Режим Продление сейчас недоступен. Баланс возвращён, попробуйте через пару минут." });
        if (!charge.isFree) {
          storage.refundGeneration({ genId: gen.id, userId, cost: gen.cost || 9900, type: "music", description: `Возврат: режим Продление недоступен #${gen.id}` });
        }
        res.status(503).json({
          message: "Режим Продление временно недоступен — ждём формат API от GPTunnel. Баланс возвращён.",
          attempted: attempts.length,
          lastResponse: data?.message || data,
        });
        return;
      }

      const taskId = data.id;
      storage.updateGeneration(gen.id, { taskId, status: "processing" });
      console.log(`[EXTEND] Started gen #${gen.id} task=${taskId} via shape=${JSON.stringify(Object.keys(usedShape))}`);
      res.json({ generationId: gen.id, taskId, message: "Продление создаётся…" });
    } catch (e: any) {
      console.error("[EXTEND] Exception:", e?.message || e);
      res.status(500).json({ message: "Ошибка сервера: " + (e?.message || "unknown") });
    }
  });

  // ==================== COVERS ====================
  app.post("/api/covers/generate", authMiddleware, async (req: Request, res: Response) => {
    const userId = (req as any).userId;
    const user = storage.getUser(userId);
    if (!user) { res.status(404).json({ message: "Пользователь не найден" }); return; }
    const { prompt, style } = req.body;
    if (!prompt) {
      res.status(400).json({ message: "Опишите обложку" });
      return;
    }

    const charge = checkAndCharge(userId, "cover");
    if (!charge.ok) {
      res.status(402).json({ message: charge.error });
      return;
    }

    try {

      const gen = storage.createGeneration({
        userId,
        type: "cover",
        prompt,
        style,
        cost: charge.isFree ? 0 : PRICES.cover,
        status: "processing",
      });

      const fullPrompt = `Album cover art. Style: ${style || "modern"}. ${prompt}. High quality, professional album artwork, square format.`;

      const resp = await gptunnelFetch("/media/create", {
        method: "POST",
        body: JSON.stringify({
          model: "gpt-image-1-high",
          prompt: fullPrompt,
          ar: "1:1",
        }),
      });

      const data = await resp.json();

      if (!resp.ok) {
        const apiErrText = data.error?.message || data.message || `HTTP ${resp.status}`;
        storage.updateGeneration(gen.id, { status: "error", errorReason: `Не удалось создать обложку: ${apiErrText}. Баланс возвращён.` });
        storage.refundGeneration({ genId: gen.id, userId, cost: gen.cost || 9900, type: "cover", description: `Возврат: ошибка генерации #${gen.id}` });
        res.status(500).json({ message: data.error?.message || "Ошибка API" });
        return;
      }

      const taskId = data.id;
      storage.updateGeneration(gen.id, { taskId, status: "processing" });

      const updatedUser = storage.getUser(userId);
      res.json({ id: gen.id, taskId, balance: updatedUser?.balance });
    } catch (e: any) {
      res.status(500).json({ message: "Ошибка: " + e.message });
    }
  });

  app.get("/api/covers/status/:taskId", authMiddleware, async (req: Request, res: Response) => {
    try {
      const resp = await gptunnelFetch("/media/result", {
        method: "POST",
        body: JSON.stringify({ task_id: req.params.taskId }),
      });
      const data = await resp.json();

      const gen = storage.getGenerationByTaskId(req.params.taskId);
      if (gen) {
        // Image API returns url field (not result)
        const imageUrl = data.url || data.result;
        if (data.status === "done" && imageUrl) {
          storage.updateGeneration(gen.id, {
            status: "done",
            resultUrl: imageUrl,
            resultData: JSON.stringify(data),
          });
          data.imageUrl = imageUrl;
          data.id = gen.id; // pass gen ID to client for cover attachment
          saveGenFiles(gen.id).catch(() => {});
        } else if (data.status === "error" || data.status === "failed") {
          storage.updateGeneration(gen.id, { status: "error" });
          if (storage.refundGeneration({ genId: gen.id, userId: gen.userId, cost: gen.cost, type: "cover", description: `Возврат: ошибка генерации #${gen.id}` })) {
            console.log(`[REFUND] Cover #${gen.id}`);
          }
          // Pass moderation message to client
          if (data.code === 1002 || data.message?.includes("content safety")) {
            data.moderationError = "Промпт не прошёл модерацию. Измените описание и попробуйте снова. Средства возвращены.";
          }
        }
      }

      res.json(data);
    } catch (e: any) {
      res.status(500).json({ message: "Ошибка: " + e.message });
    }
  });

  // ==================== PASSWORD RESET ====================
  app.post("/api/auth/forgot-password", async (req: Request, res: Response) => {
    try {
      const { email } = req.body;
      if (!email || typeof email !== "string") {
        res.status(400).json({ message: "Email обязателен" });
        return;
      }

      const user = storage.getUserByEmail(email.toLowerCase().trim());
      if (!user) {
        // Security: don't reveal if email exists
        res.json({ message: "Код отправлен на email" });
        return;
      }

      // Security-audit 2026-05-19 CRITICAL #4: Math.random() для reset code —
      // V8 PRNG, не CSPRNG → можно угадать после нескольких observations.
      // crypto.randomInt — CSPRNG, не угадывается.
      const { randomInt } = await import("crypto");
      const resetCode = String(randomInt(100000, 1000000));
      const expiresAt = Date.now() + 15 * 60 * 1000; // 15 minutes
      resetCodes.set(email.toLowerCase().trim(), { code: resetCode, userId: user.id, expiresAt });
      // НИКОГДА не логируем plain code (security-audit #4).

      // Send code via email
      const sent = await sendResetEmail(email.trim(), resetCode);
      if (!sent) {
        console.error(`[PASSWORD RESET] Failed to send email to ${email}`);
      }

      res.json({ message: "Код отправлен на email" });
    } catch (e: any) {
      res.status(500).json({ message: e.message });
    }
  });

  app.post("/api/auth/verify-reset-code", async (req: Request, res: Response) => {
    try {
      const { email, code } = req.body;
      if (!email || !code) {
        res.status(400).json({ message: "Email и код обязательны" });
        return;
      }

      const entry = resetCodes.get(email.toLowerCase().trim());
      if (!entry || entry.code !== String(code) || Date.now() > entry.expiresAt) {
        res.status(400).json({ message: "Неверный или истёкший код" });
        return;
      }

      const resetToken = uuidv4();
      resetTokens.set(resetToken, entry.userId);

      res.json({ token: resetToken });
    } catch (e: any) {
      res.status(500).json({ message: e.message });
    }
  });

  app.post("/api/auth/reset-password", async (req: Request, res: Response) => {
    try {
      const { token, password } = req.body;
      if (!token || !password) {
        res.status(400).json({ message: "Токен и пароль обязательны" });
        return;
      }
      if (typeof password !== "string" || password.length < 6) {
        res.status(400).json({ message: "Пароль должен быть не менее 6 символов" });
        return;
      }

      const userId = resetTokens.get(token);
      if (!userId) {
        res.status(400).json({ message: "Недействительный или истёкший токен сброса" });
        return;
      }

      const hashedPassword = bcrypt.hashSync(password, 10);
      db.update(users).set({ password: hashedPassword }).where(eq(users.id, userId)).run();

      // Clean up reset token
      resetTokens.delete(token);

      // Eugene 2026-05-18 (ACCESS-BYPASS-AUDIT-170526 #4): revoke всех старых
      // сессий после смены пароля. Защита: если злоумышленник запросил
      // reset-password legitimate юзера через social engineering, у него
      // не остаётся валидных сессий, выданных до смены пароля.
      try {
        const revoked = tokenStore.revokeAllForUser(userId);
        console.log(`[RESET-PASSWORD] revoked ${revoked} session(s) for user ${userId}`);
      } catch {}

      // Auto-login
      const authToken = uuidv4();
      tokenStore.set(authToken, userId);

      const user = storage.getUser(userId);
      if (!user) {
        res.status(404).json({ message: "Пользователь не найден" });
        return;
      }
      const { password: _, nameChangeToken: __nct, ...publicUser } = user;
      res.json({ token: authToken, user: publicUser });
    } catch (e: any) {
      res.status(500).json({ message: e.message });
    }
  });

  // ==================== PUBLIC PLAYLIST ====================

  // Eugene 2026-05-15 правило прослушиваний (Eugene 2026-05-21 update:
  // Босс «считай прослушивания админа и автора в общей массе»). Применяется
  // в /api/playlist/play и /api/gen-activity. count=false → НЕ инкрементить.
  // Author-self и admin plays теперь засчитываются (правило обновлено).
  function shouldCountPlay(req: Request, gen: any): { count: boolean; reason?: string } {
    // 1. Bot UA исключить. Eugene 2026-05-18: единый источник через
    // lib/botUa.ts (тот же regex что в visitor-stats / journey / click-stats).
    const ua = String(req.headers["user-agent"] || "");
    if (isBotUserAgent(ua)) {
      return { count: false, reason: "bot-ua" };
    }
    // 2. Длительность 5+ сек (поле req.body.elapsedSec из плеера). Если не
    //    передано — считаем что плеер старый, разрешаем (backward compat).
    //    Новые плееры всегда передают elapsedSec.
    const elapsedRaw = (req.body as any)?.elapsedSec;
    if (typeof elapsedRaw === "number" && elapsedRaw < 5) {
      return { count: false, reason: "too-short" };
    }
    // 3. Dedup по (gen_id, IP, window). Раньше было 60 мин — но мобильные
    //    операторы РФ (MTS/Beeline/Megafon) выдают один IP тысячам юзеров
    //    через NAT → после первого плея блокировались ВСЕ остальные с того
    //    же IP час. Eugene 2026-05-17 (Босс «1% conversion plays/visits»):
    //    окно сжато 60 → 10 мин — сохраняется защита от накруток
    //    (быстро рефрешить нельзя), но NAT-юзеры теперь засчитываются.
    try {
      const ip = String(req.ip || req.headers["x-forwarded-for"] || "").split(",")[0].trim();
      if (ip) {
        const tenMinAgo = new Date(Date.now() - 10 * 60 * 1000).toISOString();
        const recent = db.get<{ c: number }>(sql`
          SELECT COUNT(*) as c FROM gen_activity
          WHERE gen_id = ${gen.id} AND action = 'play' AND ip = ${ip} AND created_at >= ${tenMinAgo}
        `);
        if ((recent?.c || 0) > 0) return { count: false, reason: "ip-dedup-1h" };
      }
    } catch {}
    return { count: true };
  }

  // Track play count
  app.post("/api/playlist/play/:id", (req: Request, res: Response) => {
    try {
      const genId = parseInt(req.params.id);
      const gen = db.select().from(generations).where(eq(generations.id, genId)).get();
      if (!gen) return res.json({ ok: false });
      // Eugene 2026-05-17 IDOR-fix: приватные треки (isPublic=0) — только владелец/админ.
      if ((gen.isPublic ?? 0) === 0) {
        const authedUser = (req as any).user || (req as any).authedUser;
        const authedUserId = authedUser?.id || (req as any).userId;
        const isAdmin = ['admin', 'super_admin'].includes(String(authedUser?.role || '').toLowerCase());
        if (!isAdmin && gen.userId !== authedUserId) {
          return res.status(403).json({ ok: false, error: "private-track" });
        }
      }
      const decision = shouldCountPlay(req, gen);
      if (!decision.count) {
        try { logGenActivity(genId, `play_rejected:${decision.reason}`, req.ip, extractHost(req)); } catch {}
        return res.json({ ok: true, counted: false, reason: decision.reason });
      }
      logGenActivity(genId, 'play', req.ip, extractHost(req));
      let meta: any = {};
      try { meta = JSON.parse(gen.style || "{}"); } catch {}
      meta.plays = (meta.plays || 0) + 1;
      meta.lastPlayed = new Date().toISOString();
      db.update(generations).set({ style: JSON.stringify(meta) }).where(eq(generations.id, genId)).run();
      _playsStatsCache = null;
      // Eugene 2026-05-21 Босс «онлайн автообновление». SSE push всем подписчикам.
      try { (global as any).__broadcastPlaysStats?.(); } catch {}
      // Eugene 2026-05-21 Босс «если до 1000 осталось 30 — уведоми, на +1000 фейерверк».
      try { checkMilestone(gen.id); } catch {}
      res.json({ ok: true, counted: true });
    } catch { res.json({ ok: false }); }
  });

  // Get public generations for the playlist — all types, sorted by rotation score
  // Eugene 2026-05-19 «Поставь правило по умолчанию: по дате → рейтинг →
  // случайно (через день). Цикл повторяется. Админ может менять порядок».
  // Сегодняшний default sort — frontend читает на первый загрузке если у
  // юзера нет своего выбора в localStorage.
  // Eugene 2026-05-21 Босс «какой параметр юзеры выбирают в Песни — такой и
  // по умолчанию. Остальные по уменьшению частоты». ?category=song|greeting|...
  // Возвращает {mode: frequency-best, ordered: [most→least], frequencies: {...},
  // source: 'frequency'|'rotation', totalChoices: N}.
  // Если за 30 дней <10 выборов — fallback на старую rotation cycle.
  function getFrequencyDefault(category: string): {
    mode: string;
    ordered: string[];
    frequencies: Record<string, number>;
    source: "frequency" | "rotation";
    totalChoices: number;
  } {
    try {
      const raw = (db as any).$client;
      const sinceIso = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
      const rows: Array<{ sort_mode: string; cnt: number }> = raw.prepare(`
        SELECT sort_mode, COUNT(*) AS cnt
        FROM playlist_sort_choices
        WHERE category = ? AND created_at >= ?
        GROUP BY sort_mode
        ORDER BY COUNT(*) DESC
      `).all(category, sinceIso) as any[];
      const total = rows.reduce((s, r) => s + Number(r.cnt), 0);
      const freq: Record<string, number> = {};
      rows.forEach(r => { freq[r.sort_mode] = Number(r.cnt); });
      const allModes = ["date", "rating", "random", "top_month"];
      if (total < 10) {
        const fallback = getTodayDefaultSort();
        return {
          mode: fallback.mode,
          ordered: [fallback.mode, ...allModes.filter(m => m !== fallback.mode)],
          frequencies: freq,
          source: "rotation",
          totalChoices: total,
        };
      }
      // Frequency-based: most-used first, then remaining modes appended
      const orderedFromData = rows.map(r => r.sort_mode);
      const missing = allModes.filter(m => !orderedFromData.includes(m));
      const ordered = [...orderedFromData, ...missing];
      return {
        mode: ordered[0] || "date",
        ordered,
        frequencies: freq,
        source: "frequency",
        totalChoices: total,
      };
    } catch (e) {
      const fallback = getTodayDefaultSort();
      return {
        mode: fallback.mode,
        ordered: [fallback.mode, "date", "rating", "random", "top_month"].filter((v, i, a) => a.indexOf(v) === i),
        frequencies: {},
        source: "rotation",
        totalChoices: 0,
      };
    }
  }

  app.get("/api/playlist/sort-default", (req: Request, res: Response) => {
    res.setHeader("Cache-Control", "no-store");
    const category = String(req.query.category || "song").toLowerCase();
    if (["song", "greeting", "instrumental", "all"].includes(category)) {
      res.json(getFrequencyDefault(category));
    } else {
      res.json(getTodayDefaultSort());
    }
  });

  // Tracking sort choice — называет POST при каждом explicit user-toggle.
  // Rate-limit: anonymous OK, 5/min/IP soft cap.
  const _sortTrackCache = new Map<string, number>();
  app.post("/api/playlist/track-sort", (req: Request, res: Response) => {
    try {
      const category = String(req.body?.category || "").toLowerCase();
      const sortMode = String(req.body?.sortMode || "").toLowerCase();
      if (!["song", "greeting", "instrumental", "all"].includes(category)) {
        return res.json({ ok: false, error: "bad category" });
      }
      if (!["date", "rating", "random", "top_month"].includes(sortMode)) {
        return res.json({ ok: false, error: "bad sortMode" });
      }
      const ip = String(req.ip || req.headers["x-forwarded-for"] || "").split(",")[0].trim();
      const key = `${ip}|${category}|${sortMode}`;
      const last = _sortTrackCache.get(key) || 0;
      const nowMs = Date.now();
      // Дедуп: same IP+category+sortMode подряд в окне 60 сек не пишется
      if (nowMs - last < 60_000) return res.json({ ok: true, deduped: true });
      _sortTrackCache.set(key, nowMs);
      // GC cache
      if (_sortTrackCache.size > 500) {
        for (const [k, t] of _sortTrackCache.entries()) {
          if (nowMs - t > 5 * 60_000) _sortTrackCache.delete(k);
        }
      }
      const userId = tryGetUserId(req);
      (db as any).$client.prepare(`
        INSERT INTO playlist_sort_choices (user_id, ip, category, sort_mode)
        VALUES (?, ?, ?, ?)
      `).run(userId ?? null, ip || null, category, sortMode);
      res.json({ ok: true });
    } catch (e: any) {
      res.json({ ok: false, error: String(e?.message || e) });
    }
  });

  // Admin endpoint — статистика частоты выборов за месяц по категориям.
  app.get("/api/admin/v304/sort-frequency", requireAdmin, (req: Request, res: Response) => {
    try {
      const days = Math.max(1, Math.min(365, parseInt(String(req.query.days || "30"), 10) || 30));
      const sinceIso = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
      const raw = (db as any).$client;
      const rows: Array<{ category: string; sort_mode: string; cnt: number }> = raw.prepare(`
        SELECT category, sort_mode, COUNT(*) AS cnt
        FROM playlist_sort_choices
        WHERE created_at >= ?
        GROUP BY category, sort_mode
        ORDER BY category, COUNT(*) DESC
      `).all(sinceIso) as any[];
      const byCategory: Record<string, Array<{ sortMode: string; count: number }>> = {};
      for (const r of rows) {
        if (!byCategory[r.category]) byCategory[r.category] = [];
        byCategory[r.category].push({ sortMode: r.sort_mode, count: Number(r.cnt) });
      }
      const summary: Record<string, { default: string; total: number }> = {};
      for (const [cat, list] of Object.entries(byCategory)) {
        const total = list.reduce((s, x) => s + x.count, 0);
        summary[cat] = { default: list[0]?.sortMode || "date", total };
      }
      res.json({ ok: true, days, byCategory, summary });
    } catch (e: any) {
      res.status(500).json({ ok: false, error: String(e?.message || e) });
    }
  });

  // Eugene 2026-05-21 Босс «счётчик обновляется ежеминутно».
  // Server cache 30s + client max-age 30s → гарантия что client каждую минуту
  // (interval 60s) получает свежее значение (cache invalidate'ится посередине окна).
  let _playsStatsCache: { data: any; expiresAt: number } | null = null;
  const PLAYS_STATS_CACHE_MS = 30_000;

  // Eugene 2026-05-21 Босс «на +1000 prosлушиваний фейерверк + за 30 до 1000 уведоми меня».
  // checkMilestone вызывается после каждого засчитанного play.
  // 30-before: alert админу когда counter впервые достигает X * 1000 - 30
  // milestone-1000: alert + frontend fireworks (через event broadcast) когда crosses X * 1000
  let _lastNotifiedMilestone30: number = -1;  // последний X для которого было notify «-30»
  let _lastNotifiedMilestone1000: number = -1; // последний X для которого было notify «+1000»
  function sendMilestoneAlert(text: string): void {
    try {
      const adminId = process.env.ADMIN_TELEGRAM_ID;
      const tgToken = process.env.TELEGRAM_BOT_TOKEN;
      if (!adminId || !tgToken) return;
      fetch(`https://api.telegram.org/bot${tgToken}/sendMessage`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ chat_id: adminId, text, parse_mode: "HTML", disable_web_page_preview: true }),
        signal: AbortSignal.timeout(8000),
      }).catch(() => {});
    } catch {}
  }
  function getCurrentPlaysSum(): number {
    try {
      const rawSql: any = (db as any).$client || sqliteDb;
      const row = rawSql.prepare(
        `SELECT COALESCE(SUM(CAST(json_extract(style, '$.plays') AS INTEGER)), 0) AS total
         FROM generations WHERE type='music' AND deleted_at IS NULL AND status='done' AND is_public=1
           AND style LIKE '{%' AND json_valid(style)=1`
      ).get() as { total: number };
      return Number(row?.total || 0);
    } catch { return 0; }
  }
  function checkMilestone(_genId: number): void {
    try {
      const current = getCurrentPlaysSum();
      if (current === 0) return;
      const milestone = 1000;
      const currentK = Math.floor(current / milestone);  // сколько full тысяч уже
      const remainder = current % milestone;

      // (1) «-30» notification: когда counter впервые достигает (currentK+1)*1000 - 30
      const next1000 = (currentK + 1) * milestone;
      const remainToNext = next1000 - current;
      if (remainToNext === 30 && _lastNotifiedMilestone30 !== currentK + 1) {
        _lastNotifiedMilestone30 = currentK + 1;
        sendMilestoneAlert(
          `🎯 До <b>${next1000.toLocaleString("ru-RU")}</b> прослушиваний осталось <b>30</b>!\n\nТекущее: ${current.toLocaleString("ru-RU")}\nПрослушаем 30 треков ≥5 сек — фейерверк 🎆`
        );
      }

      // (2) «+1000» notification + fireworks: когда counter впервые crosses currentK*1000 (currentK > 0)
      if (currentK > _lastNotifiedMilestone1000 && currentK > 0) {
        _lastNotifiedMilestone1000 = currentK;
        const reached = currentK * milestone;
        sendMilestoneAlert(
          `🎆 <b>${reached.toLocaleString("ru-RU")}</b> прослушиваний достигнуто!\n\nНа главной — brand fireworks 🎇`
        );
      }
    } catch {}
  }
  // Helper: compute fresh stats (использует cache если свеж).
  function computePlaysStats(): { totalPlays: number; totalTracks: number; lastUpdated: string } {
    if (_playsStatsCache && Date.now() < _playsStatsCache.expiresAt) {
      return _playsStatsCache.data;
    }
    const rawSql: any = (db as any).$client || sqliteDb;
    const stats = rawSql.prepare(
      `SELECT
         COUNT(*) AS total_tracks,
         COALESCE(SUM(CAST(json_extract(style, '$.plays') AS INTEGER)), 0) AS total_plays
       FROM generations
       WHERE type = 'music' AND deleted_at IS NULL AND status = 'done'
         AND is_public = 1
         AND style LIKE '{%' AND json_valid(style) = 1`
    ).get() as { total_tracks: number; total_plays: number };
    const data = {
      totalPlays: Number(stats?.total_plays || 0),
      totalTracks: Number(stats?.total_tracks || 0),
      lastUpdated: new Date().toISOString(),
    };
    _playsStatsCache = { data, expiresAt: Date.now() + PLAYS_STATS_CACHE_MS };
    return data;
  }

  app.get("/api/playlist/stats", (_req: Request, res: Response) => {
    res.setHeader("Cache-Control", "public, max-age=30");
    try {
      res.json(computePlaysStats());
    } catch (e: any) {
      res.json({ totalPlays: 0, totalTracks: 0, error: String(e?.message || e).slice(0, 100) });
    }
  });

  // Eugene 2026-05-21 Босс «сделай онлайн автообновление счётчика
  // прослушиваний из первоисточника». SSE — server-push при каждом play.
  // Преимущество над polling (60 сек): мгновенный update + 1 connection per юзер
  // вместо 60 HTTP-запросов в час.
  // Reconnect — browser auto через EventSource (retry: 5000).
  type StatsSseClient = { res: Response; id: number };
  const _statsSseClients = new Set<StatsSseClient>();
  let _sseClientCounter = 0;
  function broadcastPlaysStats(): void {
    if (_statsSseClients.size === 0) return;
    try {
      _playsStatsCache = null;
      const data = computePlaysStats();
      const payload = `event: stats\ndata: ${JSON.stringify(data)}\n\n`;
      for (const client of _statsSseClients) {
        try { client.res.write(payload); } catch {}
      }
    } catch {}
  }
  // Глобальный handle для broadcast'а из других мест (где меняется play count).
  (global as any).__broadcastPlaysStats = broadcastPlaysStats;

  app.get("/api/playlist/stats/stream", (req: Request, res: Response) => {
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache, no-transform");
    res.setHeader("Connection", "keep-alive");
    res.setHeader("X-Accel-Buffering", "no"); // nginx — отключить buffering
    res.flushHeaders?.();
    // Подсказка browser ретраить через 5 сек при разрыве
    res.write(`retry: 5000\n\n`);
    // Сразу шлём текущее состояние
    try {
      const data = computePlaysStats();
      res.write(`event: stats\ndata: ${JSON.stringify(data)}\n\n`);
    } catch {}
    const client: StatsSseClient = { res, id: ++_sseClientCounter };
    _statsSseClients.add(client);
    // Heartbeat каждые 25 сек (nginx обычно убивает idle через 30-60 сек)
    const heartbeat = setInterval(() => {
      try { res.write(`: heartbeat ${Date.now()}\n\n`); } catch {}
    }, 25_000);
    const cleanup = () => {
      clearInterval(heartbeat);
      _statsSseClients.delete(client);
      try { res.end(); } catch {}
    };
    req.on("close", cleanup);
    req.on("error", cleanup);
  });

  // Eugene 2026-05-21 Босс: «после 1 000 000 prosлушиваний — мировой звезде.
  // Юзер предлагает имя, голосует. Топ рейтинг показывается». По IP — 1 vote/час.
  app.get("/api/star-suggestions/top", (req: Request, res: Response) => {
    res.setHeader("Cache-Control", "public, max-age=30");
    try {
      const limit = Math.min(20, Math.max(1, parseInt(String(req.query.limit || "10"), 10)));
      const rawSql: any = (db as any).$client || sqliteDb;
      const rows = rawSql.prepare("SELECT name_display, profile_url, votes FROM star_suggestions ORDER BY votes DESC, last_voted_at DESC LIMIT ?").all(limit) as Array<{ name_display: string; profile_url: string | null; votes: number }>;
      const totalVotes = rawSql.prepare("SELECT COALESCE(SUM(votes),0) as s FROM star_suggestions").get() as { s: number };
      res.json({ top: rows, totalVotes: Number(totalVotes?.s || 0), totalCandidates: rows.length });
    } catch (e: any) {
      res.json({ top: [], totalVotes: 0, error: String(e?.message || e).slice(0, 100) });
    }
  });
  app.post("/api/star-suggestions/vote", (req: Request, res: Response) => {
    res.setHeader("Cache-Control", "no-store");
    try {
      const rawName = String(req.body?.name || "").trim();
      const rawUrl = String(req.body?.profileUrl || "").trim();
      if (rawName.length < 2 || rawName.length > 60) {
        res.json({ ok: false, error: "Имя 2-60 символов" });
        return;
      }
      if (!/^[\p{L}\p{N}\s\-.']+$/u.test(rawName)) {
        res.json({ ok: false, error: "Только буквы, цифры, пробел, дефис, точка, апостроф" });
        return;
      }
      // Eugene 2026-05-21 Босс «при добавлении звезды ссылка на Instagram обязательна».
      // Validate Instagram URL pattern.
      const normalizedUrl = rawUrl.replace(/^@/, "https://www.instagram.com/").trim();
      const igRegex = /^https?:\/\/(www\.)?instagram\.com\/[A-Za-z0-9_.]+\/?(\?.*)?$/i;
      const isNewName = true; // дальше проверим
      const rawSql: any = (db as any).$client || sqliteDb;
      const normalized = rawName.toLowerCase().replace(/\s+/g, " ").trim();
      const existing = rawSql.prepare("SELECT id, votes, profile_url FROM star_suggestions WHERE name_normalized = ?").get(normalized) as any;

      // Если NEW name → URL обязателен. Если existing → URL опциональный (можно просто голос).
      if (!existing && !igRegex.test(normalizedUrl)) {
        res.json({ ok: false, error: "Ссылка на Instagram обязательна. Формат: https://www.instagram.com/<username>" });
        return;
      }
      if (existing && rawUrl && !igRegex.test(normalizedUrl)) {
        res.json({ ok: false, error: "Неверный формат Instagram-ссылки" });
        return;
      }

      const ip = String(req.headers["x-forwarded-for"] || req.ip || "").split(",")[0].trim().replace(/^::ffff:/, "") || "unknown";
      // Eugene 2026-05-21 Босс: «если повторно нажимать за звезду — Голос учтён ранее».
      // Дедуп по (ip, name_normalized) — один IP голосует за конкретное имя один раз.
      // За разные имена — голосует без ограничений.
      const alreadyVoted = rawSql.prepare("SELECT id FROM star_votes_log WHERE ip = ? AND name_normalized = ? LIMIT 1").get(ip, normalized);
      if (alreadyVoted) {
        res.json({ ok: false, error: "Голос учтён ранее", alreadyVoted: true });
        return;
      }
      if (existing) {
        const updateUrl = rawUrl && !existing.profile_url ? normalizedUrl : null;
        if (updateUrl) {
          rawSql.prepare("UPDATE star_suggestions SET votes = votes + 1, profile_url = ?, last_voted_at = datetime('now') WHERE id = ?").run(updateUrl, existing.id);
        } else {
          rawSql.prepare("UPDATE star_suggestions SET votes = votes + 1, last_voted_at = datetime('now') WHERE id = ?").run(existing.id);
        }
      } else {
        rawSql.prepare("INSERT INTO star_suggestions (name_normalized, name_display, profile_url, votes) VALUES (?, ?, ?, 1)").run(normalized, rawName, normalizedUrl);
      }
      rawSql.prepare("INSERT INTO star_votes_log (ip, name_normalized) VALUES (?, ?)").run(ip, normalized);
      res.json({ ok: true });
    } catch (e: any) {
      res.json({ ok: false, error: String(e?.message || e).slice(0, 100) });
    }
  });

  // Eugene 2026-05-21 Босс: «кнопка отключить анимации на 1 день. Если 3 дня
  // подряд — сохранить до явного включения. По IP».
  //
  // State logic:
  // - disabled_until > now → animations OFF
  // - permanent_off=1 → animations OFF до явного toggle
  // - consecutive_disables >= 3 → permanent_off automatic
  //
  // Tracking: при toggle OFF — увеличиваем counter если предыдущий toggle был
  // в окне 25h (последовательность). Если разрыв > 25h — сбрасываем counter.
  function extractClientIp(req: Request): string {
    const raw = String(req.headers["x-forwarded-for"] || req.ip || "").split(",")[0].trim();
    return raw.replace(/^::ffff:/, "") || "unknown";
  }
  function getAnimState(ip: string): { enabled: boolean; reason: string; disabledUntil: string | null; consecutiveDisables: number; permanentOff: boolean } {
    try {
      const rawSql: any = (db as any).$client || sqliteDb;
      const row = rawSql.prepare("SELECT disabled_until, consecutive_disables, permanent_off FROM anim_preferences WHERE ip = ?").get(ip) as any;
      if (!row) return { enabled: true, reason: "default", disabledUntil: null, consecutiveDisables: 0, permanentOff: false };
      if (row.permanent_off) return { enabled: false, reason: "permanent (3 дня подряд)", disabledUntil: null, consecutiveDisables: Number(row.consecutive_disables || 0), permanentOff: true };
      if (row.disabled_until && new Date(row.disabled_until).getTime() > Date.now()) {
        return { enabled: false, reason: "1-day-off", disabledUntil: row.disabled_until, consecutiveDisables: Number(row.consecutive_disables || 0), permanentOff: false };
      }
      return { enabled: true, reason: "expired-or-enabled", disabledUntil: null, consecutiveDisables: Number(row.consecutive_disables || 0), permanentOff: false };
    } catch {
      return { enabled: true, reason: "error-fallback", disabledUntil: null, consecutiveDisables: 0, permanentOff: false };
    }
  }
  app.get("/api/user-preferences/anim-state", (req: Request, res: Response) => {
    res.setHeader("Cache-Control", "no-store");
    const ip = extractClientIp(req);
    res.json(getAnimState(ip));
  });
  app.post("/api/user-preferences/anim-toggle", (req: Request, res: Response) => {
    res.setHeader("Cache-Control", "no-store");
    const ip = extractClientIp(req);
    const wantEnabled = req.body?.enabled !== false; // default true (enable)
    try {
      const rawSql: any = (db as any).$client || sqliteDb;
      const now = new Date();
      const nowIso = now.toISOString();
      const existing = rawSql.prepare("SELECT disabled_until, consecutive_disables, permanent_off, last_toggle_at FROM anim_preferences WHERE ip = ?").get(ip) as any;
      if (wantEnabled) {
        // Юзер явно включает — сбрасываем permanent_off + counter
        if (existing) {
          rawSql.prepare("UPDATE anim_preferences SET disabled_until=NULL, consecutive_disables=0, permanent_off=0, last_toggle_at=? WHERE ip=?").run(nowIso, ip);
        }
        res.json({ ok: true, state: getAnimState(ip) });
        return;
      }
      // Disable on 1 day. Tracking consecutive:
      const oneDayMs = 24 * 60 * 60 * 1000;
      const disabledUntil = new Date(now.getTime() + oneDayMs).toISOString();
      let consecutive = 1;
      let permanent = 0;
      if (existing) {
        const lastToggleMs = existing.last_toggle_at ? new Date(existing.last_toggle_at).getTime() : 0;
        const sinceLastH = (now.getTime() - lastToggleMs) / (60 * 60 * 1000);
        // Если предыдущий toggle (OFF) был в окне 25 часов — increment counter
        if (sinceLastH <= 25 && Number(existing.consecutive_disables || 0) > 0) {
          consecutive = Number(existing.consecutive_disables) + 1;
        }
        if (consecutive >= 3) {
          permanent = 1;
        }
        rawSql.prepare("UPDATE anim_preferences SET disabled_until=?, consecutive_disables=?, permanent_off=?, last_toggle_at=? WHERE ip=?").run(
          permanent ? null : disabledUntil,
          consecutive,
          permanent,
          nowIso,
          ip,
        );
      } else {
        rawSql.prepare("INSERT INTO anim_preferences (ip, disabled_until, consecutive_disables, permanent_off, last_toggle_at) VALUES (?, ?, ?, ?, ?)").run(
          ip, disabledUntil, 1, 0, nowIso,
        );
      }
      res.json({ ok: true, state: getAnimState(ip) });
    } catch (e: any) {
      res.json({ ok: false, error: String(e?.message || e).slice(0, 150) });
    }
  });

  app.get("/api/admin/v304/playlist-sort-rotation", requireAdmin, (_req: Request, res: Response) => {
    res.setHeader("Cache-Control", "no-store");
    res.json({ ...getRotationConfig(), today: getTodayDefaultSort() });
  });
  app.post("/api/admin/v304/playlist-sort-rotation", requireAdmin, (req: Request, res: Response) => {
    const cycle = (req.body?.cycle as string[]) || [];
    if (!Array.isArray(cycle)) {
      res.status(400).json({ error: "cycle must be an array" });
      return;
    }
    const result = setRotationCycle(cycle);
    if (!result.ok) {
      res.status(400).json(result);
      return;
    }
    res.json({ ok: true, ...getTodayDefaultSort() });
  });

  app.get("/api/playlist", (req: Request, res: Response) => {
    // Always fresh — playlist reflects renames, cover changes, plays, etc.
    res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate");
    res.setHeader("Pragma", "no-cache");
    res.setHeader("Expires", "0");
    try {
      // Eugene 2026-05-15 Босс «2 плейлиста на главной».
      // ?status=main → isPublic=1 (основной, default).
      // ?status=new  → isPublic=2 (новые авторы — после нажатия «Опубликовать»,
      //                до approve админом или после возврата из main).
      const statusParam = String(req.query.status || "main").toLowerCase();
      const targetIsPublic = statusParam === "new" ? 2 : 1;
      const tracks = db.select()
        .from(generations)
        .where(
          and(
            eq(generations.status, "done"),
            eq(generations.isPublic, targetIsPublic),
            isNotNull(generations.resultUrl),
            sql`${generations.deletedAt} IS NULL`
          )
        )
        .orderBy(desc(generations.id))
        .limit(500)
        .all();

      // Filter out music/cover without local files and with expired remote URLs (>48h)
      const now = Date.now();
      const available = tracks.filter(t => {
        if (t.type === "cover") return true; // covers filtered by isPublic=1 in DB query above
        if (t.localPath) return true; // has local file — always available
        if (t.type === "lyrics") return true; // text stored in resultUrl directly
        // No local file — check if remote URL is still fresh (<48h)
        const ageHours = (now - new Date(t.createdAt || "").getTime()) / 3600000;
        return ageHours < 48;
      });

      // Sort by query param: ?sort=date|rating|top_month|random &dir=desc|asc
      const sortMode = (req.query.sort as string) || "rating";
      const sortDir = (req.query.dir as string) === "asc" ? 1 : -1;
      const monthAgo = Date.now() - 30 * 24 * 3600 * 1000;
      const scored = available.map(t => {
        let plays = 0, downloads = 0, category = 'song';
        try { const m = JSON.parse(t.style || "{}"); plays = m.plays || 0; downloads = m.downloads || 0; category = m.category || 'song'; } catch {}
        // Eugene 2026-05-14 Босс: если voiceType=instrumental — категория
        // ВСЕГДА instrumental (раньше эти треки могли застрять как song).
        // Это вернуло фильтр «Инструментальная» на главной.
        if ((t as any).voiceType === 'instrumental') category = 'instrumental';
        return { ...t, plays, downloads, category };
      });
      if (sortMode === "date") {
        // Eugene 2026-05-17 Босс: sort=date теперь по publishedAt (когда трек
        // появился в плейлисте), а не по createdAt (когда сгенерирован).
        // Fallback на createdAt если publishedAt = NULL (backward-compat).
        const dateOf = (t: any) => new Date((t as any).publishedAt || t.createdAt || "").getTime();
        scored.sort((a, b) => sortDir * (dateOf(b) - dateOf(a)));
      } else if (sortMode === "top_month") {
        // Only tracks from last 30 days, sorted by plays (по publishedAt — фактич. появлению)
        const dateOf = (t: any) => new Date((t as any).publishedAt || t.createdAt || "").getTime();
        const recent = scored.filter(t => dateOf(t) > monthAgo);
        const older = scored.filter(t => dateOf(t) <= monthAgo);
        recent.sort((a, b) => sortDir * (b.plays - a.plays));
        scored.length = 0; scored.push(...recent, ...older);
      } else if (sortMode === "random") {
        for (let i = scored.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [scored[i], scored[j]] = [scored[j], scored[i]]; }
      } else {
        scored.sort((a, b) => sortDir * (b.plays - a.plays));
      }

      // No pinned tracks — natural sort order

      // Separate music and covers
      const musicItems = scored.filter(t => t.type !== "cover");
      const allCovers = scored.filter(t => t.type === "cover");
      // Max 9 covers: priority first, then rotate rest
      const nowMs = Date.now();
      const priorityCovers = allCovers.filter(c => c.priorityUntil && new Date(c.priorityUntil).getTime() > nowMs);
      const normalCovers = allCovers.filter(c => !c.priorityUntil || new Date(c.priorityUntil).getTime() <= nowMs);
      // Rotate normal covers based on hour of day
      const rotateOffset = Math.floor(nowMs / (3600 * 1000)) % Math.max(1, normalCovers.length);
      const rotated = [...normalCovers.slice(rotateOffset), ...normalCovers.slice(0, rotateOffset)];
      const selectedCovers = [...priorityCovers, ...rotated].slice(0, 9);
      const limited = [...musicItems, ...selectedCovers];

      const playlist = limited.map(t => {
        let imageUrl: string | null = null;
        let audioUrl: string | null = null;
        let duration = 0;

        if (t.type === "music") {
          audioUrl = `/api/stream/${t.id}`;
          // Eugene 2026-05-09 ТОЧЕЧНЫЙ ВЫСТРЕЛ: cache-bust по mtime файла.
          // Раньше ?v=${coverGenId || 'suno'} был СТАТИЧЕН — браузер один
          // раз кэшировал ответ (даже если это был 404 / artwork-fallback)
          // и pull-to-refresh на iPad-Safari ничего не делал. Теперь:
          //   - если файл есть на диске — v = mtime в секундах. При любом
          //     изменении файла URL меняется → браузер перезапрашивает.
          //   - если файла нет — v = поминутный timestamp (минимум раз в
          //     минуту перетягиваем обложку, не залипает на 404).
          let coverV: string = String(t.coverGenId || "suno");
          try {
            const localCover = resolveCoverPath(t);
            if (localCover) {
              coverV = String(Math.floor(fs.statSync(localCover).mtimeMs / 1000));
            } else {
              coverV = `m${Math.floor(Date.now() / 60000)}`;
            }
          } catch {}
          imageUrl = `/api/cover/${t.id}.jpg?v=${coverV}`;
          try {
            const data = JSON.parse(t.resultData || "{}");
            if (Array.isArray(data.result) && data.result[0]) {
              duration = data.result[0].duration || 0;
            }
          } catch {}
        } else if (t.type === "cover") {
          imageUrl = `/api/stream/${t.id}`;
        }
        // lyrics: no audio, no image — just text

        // Extract lyrics from resultData
        let lyric: string | null = null;
        if (t.type === "music") {
          try {
            const data = JSON.parse(t.resultData || "{}");
            if (Array.isArray(data.result) && data.result[0]?.lyric) {
              lyric = data.result[0].lyric;
            }
          } catch {}
        }

        return {
          id: t.id,
          type: t.type,
          prompt: t.displayTitle || t.prompt,
          displayTitle: t.displayTitle || null,
          styleInfo: (() => {
            try {
              const m = JSON.parse(t.style || '{}');
              if (!m.style) return null;
              // Build human-readable style description
              const styleMap: Record<string,string> = { pop:'Поп', rock:'Рок', rap:'Рэп', electronic:'Электронная', jazz:'Джаз', lofi:'Lo-Fi', cinematic:'Кинематограф', ballad:'Баллада', folk:'Фолк', rnb:'R&B', reggae:'Регги', metal:'Метал', country:'Кантри', classical:'Классика', chanson:'Шансон', dance:'Данс' };
              const moodMap: Record<string,string> = { happy:'весёлое', sad:'грустное', romantic:'романтичное', energetic:'энергичное', calm:'спокойное', dramatic:'драматичное', epic:'эпичное', dreamy:'мечтательное', aggressive:'агрессивное' };
              const tempoMap: Record<string,string> = { slow:'медленный', moderate:'средний', fast:'быстрый', 'very fast':'очень быстрый' };
              const rawStyle = m.style; // e.g. "rock, fast tempo, energetic mood, 170 BPM"
              // Parse components
              const parts = rawStyle.split(',').map((p: string) => p.trim());
              const base = parts[0]; // e.g. "rock"
              const label = styleMap[base] || base;
              const extras: string[] = [];
              for (const p of parts.slice(1)) {
                const tempoMatch = p.match(/(slow|moderate|fast|very fast)\s*tempo/i);
                const moodMatch = p.match(/([\w\u0400-\u04ff]+)\s*mood/i);
                const bpmMatch = p.match(/(\d+)\s*BPM/i);
                const duetMatch = p.match(/duet/i);
                if (tempoMatch) extras.push(tempoMap[tempoMatch[1].toLowerCase()] || tempoMatch[1]);
                else if (moodMatch) extras.push(moodMap[moodMatch[1].toLowerCase()] || moodMatch[1]);
                else if (bpmMatch) extras.push(bpmMatch[1] + ' BPM');
                else if (duetMatch) extras.push('дуэт');
                else if (p.trim()) extras.push(p.trim());
              }
              return [label, ...extras].join(' · ');
            } catch { return null; }
          })(),
          category: t.category || 'song',
          audioUrl,
          imageUrl,
          // Eugene 2026-05-18 Босс «обложки которые пользователи сами
          // сгенерировали — подсветить в плейлисте на 30% яркости».
          // coverGenId !== null → автор привязал свою сгенерированную
          // обложку (не дефолтную от Suno). Frontend рисует subtle ring.
          hasCustomCover: !!t.coverGenId,
          authorName: t.authorName || "",
          createdAt: t.createdAt,
          publishedAt: (t as any).publishedAt || null,
          plays: t.plays || 0,
          duration: Math.round(duration),
          lyric,
        };
      });

      res.json(playlist);
    } catch (e: any) {
      res.status(500).json({ message: e.message });
    }
  });

  // Request publication (author) or toggle (admin)
  // isPublic: 0=private, 1=published, 2=pending moderation
  // Eugene 2026-05-14 Босс: смена категории трека (Песня/Поздравление/Инструментальная).
  // Eugene 2026-05-21 Босс: «проверяй продолжительность трека и отражай в плейлисте».
  // Backfill duration: фронт при loadedmetadata вызывает этот endpoint когда duration=0
  // (Suno вернул битый metadata, или трек загружен manually). Без auth — public
  // (любой кто может слушать может уточнить duration). Idempotent: пишет только если в БД < 1.
  app.post("/api/generations/:id/duration", (req: Request, res: Response) => {
    try {
      const id = parseInt(req.params.id || "0", 10);
      const dur = parseInt(String(req.body?.duration || "0"), 10);
      if (!id || !dur || dur < 1 || dur > 3600) {
        res.json({ ok: false, error: "invalid args" });
        return;
      }
      const gen = storage.getGeneration(id);
      if (!gen || gen.type !== "music") {
        res.json({ ok: false, error: "not found" });
        return;
      }
      const data = JSON.parse((gen as any).resultData || "{}");
      if (!Array.isArray(data.result) || !data.result[0]) {
        res.json({ ok: false, error: "no result data" });
        return;
      }
      const existing = Number(data.result[0].duration || 0);
      if (existing >= 1) {
        // Уже есть — не перезаписываем (защита от user-faked очень коротких значений)
        res.json({ ok: true, skipped: true, existing });
        return;
      }
      data.result[0].duration = dur;
      db.update(generations).set({ resultData: JSON.stringify(data) }).where(eq(generations.id, id)).run();
      res.json({ ok: true, duration: dur });
    } catch (e: any) {
      res.json({ ok: false, error: String(e?.message || e).slice(0, 150) });
    }
  });

  // Автор может менять свой трек, admin — любой. Категория хранится в
  // style.category. Для instrumental — синхронизируем voiceType колонку.
  app.post("/api/generations/:id/category", authMiddleware, (req: Request, res: Response) => {
    try {
      const userId = (req as any).userId;
      const genId = parseInt(req.params.id);
      const { category } = req.body;
      if (!["song", "greeting", "instrumental"].includes(category)) {
        res.status(400).json({ message: "Категория должна быть: song / greeting / instrumental" });
        return;
      }
      const user = storage.getUser(userId);
      const isAdmin = isAdminUser(user);
      const gen = db.select().from(generations).where(eq(generations.id, genId)).get();
      if (!gen) { res.status(404).json({ message: "Не найдено" }); return; }
      if (!isAdmin && gen.userId !== userId) { res.status(403).json({ message: "Нет доступа" }); return; }
      if (gen.type !== "music") { res.status(400).json({ message: "Категорию можно менять только у треков" }); return; }

      let meta: any = {};
      try { meta = JSON.parse(gen.style || "{}"); } catch {}
      meta.category = category;
      const newVoiceType = category === "instrumental" ? "instrumental" : (gen.voiceType === "instrumental" ? null : gen.voiceType);
      db.update(generations)
        .set({ style: JSON.stringify(meta), voiceType: newVoiceType })
        .where(eq(generations.id, genId))
        .run();
      res.json({ ok: true, category, voiceType: newVoiceType });
    } catch (e: any) {
      console.error("[CATEGORY-CHANGE]", e);
      res.status(500).json({ message: e.message });
    }
  });

  app.post("/api/generations/:id/privacy", authMiddleware, (req: Request, res: Response) => {
    const userId = (req as any).userId;
    const genId = parseInt(req.params.id);
    const { isPublic } = req.body;
    const user = storage.getUser(userId);
    const isAdmin = isAdminUser(user);

    const gen = db.select().from(generations).where(eq(generations.id, genId)).get();
    if (!gen) { res.status(404).json({ message: "Не найдено" }); return; }
    // Eugene 2026-05-17 Босс «публикация = другое событие». Helper для
    // выставления publishedAt только при ПЕРВОМ переходе 0 -> >=1.
    const buildPublishPatch = (newIsPublic: number): Record<string, any> => {
      const patch: Record<string, any> = { isPublic: newIsPublic };
      if ((gen.isPublic ?? 0) === 0 && newIsPublic >= 1 && !gen.publishedAt) {
        patch.publishedAt = new Date().toISOString();
      }
      return patch;
    };

    // Admin can toggle directly + moderate any track
    if (isAdmin) {
      const newIsPublic = isPublic ? 1 : 0;
      db.update(generations).set(buildPublishPatch(newIsPublic)).where(eq(generations.id, genId)).run();
      res.json({ ok: true });
      return;
    }
    // Author can only request publication or unpublish their own
    if (gen.userId !== userId) { res.status(403).json({ message: "Нет доступа" }); return; }
    if (isPublic) {
      // Check if track was previously approved (has plays or was ever isPublic=1)
      let wasApproved = false;
      try {
        const meta = JSON.parse(gen.style || '{}');
        wasApproved = !!(meta.approvedOnce);
      } catch {}
      // Eugene 2026-05-20 Босс «"Новые авторы" — кто зарегистрируется ПОСЛЕ
      // двадцатого мая. Все 16 действующих юзеров до 20.05 — в основной
      // плейлист без модерации». Cutoff = 2026-05-20 00:00 UTC.
      const NEW_AUTHORS_CUTOFF_ISO = "2026-05-20T00:00:00.000Z";
      const isEstablishedAuthor = (() => {
        const created = String(user?.createdAt || "");
        if (!created) return false;
        try { return new Date(created).getTime() < new Date(NEW_AUTHORS_CUTOFF_ISO).getTime(); } catch { return false; }
      })();
      if (wasApproved || isEstablishedAuthor) {
        // Already approved once OR established author (registered before 2026-05-20)
        // — публикуется сразу в main без модерации.
        db.update(generations).set(buildPublishPatch(1)).where(eq(generations.id, genId)).run();
        res.json({ ok: true, autoApproved: isEstablishedAuthor && !wasApproved });
      } else {
        // First time для new author — request moderation
        db.update(generations).set(buildPublishPatch(2)).where(eq(generations.id, genId)).run();
        // Eugene 2026-05-19 Босс «уведомления админа о новых публикациях
        // для подтверждения». Telegram alert админу с ссылкой в админ-tab.
        try {
          const tok = process.env.TELEGRAM_BOT_TOKEN;
          const adminId = process.env.ADMIN_TELEGRAM_ID;
          if (tok && adminId) {
            const author = storage.getUser(userId);
            const trackTitle = gen.displayTitle || gen.prompt?.slice(0, 60) || `#${genId}`;
            const authorName = author?.name || author?.email || `id:${userId}`;
            const msg = `🆕 Запрос на публикацию\n\n*${trackTitle}*\nАвтор: ${authorName}\n\nОдобрить: https://muzaai.ru/#/admin/v304?tab=pending-publications`;
            void fetch(`https://api.telegram.org/bot${tok}/sendMessage`, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                chat_id: adminId,
                text: msg,
                parse_mode: "Markdown",
                disable_web_page_preview: true,
              }),
              signal: AbortSignal.timeout(8_000),
            }).catch(() => {});
          }
        } catch (e) {
          console.warn("[publish-notif]", (e as any)?.message);
        }
        res.json({ ok: true, pending: true, message: "Запрос на публикацию отправлен" });
      }
    } else {
      // Author can unpublish/cancel their own. publishedAt НЕ trim'аем —
      // последняя дата публикации сохраняется на случай re-publish.
      db.update(generations).set({ isPublic: 0 }).where(eq(generations.id, genId)).run();
      res.json({ ok: true });
    }
  });

  // Admin: get pending publication requests
  app.get("/api/admin/pending-publications", authMiddleware, (req: Request, res: Response) => {
    const user = storage.getUser((req as any).userId);
    if (!isAdminUser(user)) { res.status(403).end(); return; }
    const raw = db.$client;
    const rows = raw.prepare(`SELECT g.id, g.display_title, g.prompt, g.type, g.author_name, g.created_at, g.published_at, g.user_id,
      u.name as user_name, u.email as user_email
      FROM generations g LEFT JOIN users u ON g.user_id = u.id
      WHERE g.is_public = 2 AND g.deleted_at IS NULL
      ORDER BY g.id DESC`).all();
    res.json(rows);
  });

  // Admin: approve, reject, or send feedback
  app.post("/api/admin/moderate/:id", authMiddleware, async (req: Request, res: Response) => {
    const user = storage.getUser((req as any).userId);
    if (!isAdminUser(user)) { res.status(403).end(); return; }
    const genId = parseInt(req.params.id);
    const { action, message } = req.body; // 'approve', 'reject', or 'feedback'

    const gen = db.select().from(generations).where(eq(generations.id, genId)).get();
    if (!gen) { res.status(404).json({ message: "Не найдено" }); return; }
    const author = storage.getUser(gen.userId);
    const title = gen.displayTitle || (gen.prompt || "").slice(0, 50);

    if (action === 'approve') {
      // Mark as approved and set approvedOnce flag in style
      let meta: any = {};
      try { meta = JSON.parse(gen.style || '{}'); } catch {}
      meta.approvedOnce = true;
      // Eugene 2026-05-17: publishedAt при первой публикации (0→1 через модерацию).
      const approvePatch: any = { isPublic: 1, style: JSON.stringify(meta) };
      if ((gen.isPublic ?? 0) === 0 && !(gen as any).publishedAt) {
        approvePatch.publishedAt = new Date().toISOString();
      }
      db.update(generations).set(approvePatch).where(eq(generations.id, genId)).run();
      console.log(`[MODERATE] Approved gen #${genId}`);
      // Notify author by email
      if (author?.email) {
        try {
          await mailTransport.sendMail({
            from: `"MuzaAi" <${CLIENT_EMAIL}>`, replyTo: CLIENT_EMAIL,
            to: author.email,
            subject: `MuzaAi — Ваша генерация опубликована`,
            html: `<div style="font-family:-apple-system,sans-serif;max-width:480px;margin:0 auto;padding:32px;background:#09090b;border-radius:16px;border:1px solid #1a1a2e;">
              <h2 style="color:#22c55e;margin:0 0 16px">✓ Опубликовано</h2>
              <p style="color:#e0e0e0"><b>${title}</b></p>
              <p style="color:#888;margin-top:12px">Ваша генерация теперь доступна в публичном плейлисте MuzaAi.ru</p>
              <a href="${PUBLIC_URL}/#/play/${genId}" style="display:inline-block;margin-top:16px;padding:10px 24px;background:linear-gradient(135deg,#8b5cf6,#3b82f6);color:white;text-decoration:none;border-radius:12px;font-weight:600">Послушать</a>
            </div>`,
          });
        } catch (e) { console.error('[MODERATE] Email error:', e); }
      }
    } else if (action === 'reject') {
      db.update(generations).set({ isPublic: 0 }).where(eq(generations.id, genId)).run();
      console.log(`[MODERATE] Rejected gen #${genId}`);
      if (author?.email) {
        try {
          await mailTransport.sendMail({
            from: `"MuzaAi" <${CLIENT_EMAIL}>`, replyTo: CLIENT_EMAIL,
            to: author.email,
            subject: `MuzaAi — Публикация отклонена`,
            html: `<div style="font-family:-apple-system,sans-serif;max-width:480px;margin:0 auto;padding:32px;background:#09090b;border-radius:16px;border:1px solid #1a1a2e;">
              <h2 style="color:#f87171;margin:0 0 16px">Публикация отклонена</h2>
              <p style="color:#e0e0e0"><b>${title}</b></p>
              <p style="color:#888;margin-top:12px">Администратор отклонил публикацию. Вы можете изменить генерацию и отправить повторно.</p>
            </div>`,
          });
        } catch (e) { console.error('[MODERATE] Email error:', e); }
      }
    } else if (action === 'feedback' && message) {
      // Send recommendation to author without changing status
      console.log(`[MODERATE] Feedback for gen #${genId}: ${message}`);
      if (author?.email) {
        try {
          await mailTransport.sendMail({
            from: `"MuzaAi" <${CLIENT_EMAIL}>`, replyTo: CLIENT_EMAIL,
            to: author.email,
            subject: `MuzaAi — Рекомендация по публикации`,
            html: `<div style="font-family:-apple-system,sans-serif;max-width:480px;margin:0 auto;padding:32px;background:#09090b;border-radius:16px;border:1px solid #1a1a2e;">
              <h2 style="color:#a78bfa;margin:0 0 16px">Рекомендация</h2>
              <p style="color:#e0e0e0">По вашей генерации: <b>${title}</b></p>
              <div style="margin:16px 0;padding:16px;background:#1a1a2e;border-radius:12px;border-left:3px solid #a78bfa">
                <p style="color:#e0e0e0;margin:0;white-space:pre-wrap">${message.replace(/</g, '&lt;')}</p>
              </div>
              <p style="color:#888;font-size:12px">Исправьте и отправьте на публикацию повторно.</p>
            </div>`,
          });
        } catch (e) { console.error('[MODERATE] Feedback email error:', e); }
      }
    }
    res.json({ ok: true });
  });

  // Publish all covers at once (admin only)
  app.post("/api/admin/publish-all-covers", authMiddleware, (req: Request, res: Response) => {
    const user = storage.getUser((req as any).userId);
    if (!isAdminUser(user)) { res.status(403).json({ message: "Только админ" }); return; }
    // Eugene 2026-05-17: bulk publish — все ставятся в isPublic=1 + publishedAt=NOW
    // только для тех у кого publishedAt ещё NULL (первая публикация).
    const nowIso = new Date().toISOString();
    const r = db.update(generations).set({ isPublic: 1, publishedAt: nowIso } as any).where(and(eq(generations.type, "cover"), eq(generations.status, "done"), sql`${generations.deletedAt} IS NULL`, eq(generations.isPublic, 0), sql`${generations.publishedAt} IS NULL`)).run();
    // Для тех у кого publishedAt уже был (re-publish после unpublish) — только isPublic.
    const r2 = db.update(generations).set({ isPublic: 1 }).where(and(eq(generations.type, "cover"), eq(generations.status, "done"), sql`${generations.deletedAt} IS NULL`, eq(generations.isPublic, 0))).run();
    console.log(`[ADMIN] Published all covers: ${r.changes + r2.changes} (first-pub: ${r.changes}, re-pub: ${r2.changes})`);
    res.json({ ok: true, published: r.changes + r2.changes });
  });

  // Set priority for a cover (7 days, admin only)
  app.post("/api/generations/:id/priority", authMiddleware, (req: Request, res: Response) => {
    const user = storage.getUser((req as any).userId);
    if (!isAdminUser(user)) { res.status(403).json({ message: "Только админ" }); return; }
    const genId = parseInt(req.params.id);
    const days = req.body.days || 7;
    const until = new Date(Date.now() + days * 24 * 3600 * 1000).toISOString();
    // Eugene 2026-05-17: publishedAt при первой публикации через priority-set.
    const gen = db.select().from(generations).where(eq(generations.id, genId)).get() as any;
    const priorityPatch: any = { priorityUntil: until, isPublic: 1 };
    if (gen && (gen.isPublic ?? 0) === 0 && !gen.publishedAt) {
      priorityPatch.publishedAt = new Date().toISOString();
    }
    db.update(generations).set(priorityPatch).where(eq(generations.id, genId)).run();
    console.log(`[ADMIN] Priority set for #${genId} until ${until}`);
    res.json({ ok: true, until });
  });

  // Log copy/share action
  app.post("/api/gen-activity/:id/:action", (req: Request, res: Response) => {
    const genId = parseInt(req.params.id);
    const action = req.params.action;
    if (['copy', 'share', 'download', 'play'].includes(action)) {
      const gen = db.select().from(generations).where(eq(generations.id, genId)).get();
      if (!gen) return res.json({ ok: false });
      // Eugene 2026-05-17 IDOR-fix: запрет накрутки/leak'а через чужие приватные
      // треки. Если gen.isPublic === 0 — действие разрешено только владельцу
      // или админу (authMiddleware не применяется в этом endpoint'е, поэтому
      // проверяем Bearer/cookie вручную через resolveUserFromReq если есть).
      if ((gen.isPublic ?? 0) === 0) {
        const authedUser = (req as any).user || (req as any).authedUser;
        const authedUserId = authedUser?.id || (req as any).userId;
        const isAdmin = ['admin', 'super_admin'].includes(String(authedUser?.role || '').toLowerCase());
        if (!isAdmin && gen.userId !== authedUserId) {
          return res.status(403).json({ ok: false, error: "private-track" });
        }
      }
      // Eugene 2026-05-15 Босс «правило прослушиваний» — для action=play
      // применяется shouldCountPlay (5+ сек, IP-dedup, author-self, admin,
      // bot-UA исключаются). Для copy/share/download — без фильтрации.
      if (action === 'play') {
        try {
          const decision = shouldCountPlay(req, gen);
          if (!decision.count) {
            try { logGenActivity(genId, `play_rejected:${decision.reason}`, req.ip, extractHost(req)); } catch {}
            return res.json({ ok: true, counted: false, reason: decision.reason });
          }
          logGenActivity(genId, 'play', req.ip, extractHost(req));
          let meta: any = {};
          try { meta = JSON.parse(gen.style || "{}"); } catch {}
          meta.plays = (meta.plays || 0) + 1;
          meta.lastPlayed = new Date().toISOString();
          db.update(generations).set({ style: JSON.stringify(meta) }).where(eq(generations.id, genId)).run();
          _playsStatsCache = null;
          try { (global as any).__broadcastPlaysStats?.(); } catch {}
          try { checkMilestone(gen.id); } catch {}
          return res.json({ ok: true, counted: true });
        } catch { return res.json({ ok: false }); }
      }
      // copy/share/download — старая логика без фильтрации.
      logGenActivity(genId, action, req.ip, extractHost(req));
      if (action === 'download') {
        try {
          let meta: any = {};
          try { meta = JSON.parse(gen.style || "{}"); } catch {}
          meta.downloads = (meta.downloads || 0) + 1;
          db.update(generations).set({ style: JSON.stringify(meta) }).where(eq(generations.id, genId)).run();
        } catch {}
      }
    }
    res.json({ ok: true });
  });

  // Admin: generation activity stats
  app.get("/api/admin/gen-stats", authMiddleware, (req: Request, res: Response) => {
    const user = storage.getUser((req as any).userId);
    if (!isAdminUser(user)) { res.status(403).end(); return; }
    // Eugene 2026-05-17 Босс: единая логика period boundaries (cut-off 20:00 МСК).
    const period = (req.query.period as string) || 'all';
    const raw = db.$client;
    let dateFilter = '';
    if (period && period !== 'all') {
      const r = getPeriodRange(period);
      dateFilter = `AND ga.created_at >= '${r.fromIso}' AND ga.created_at < '${r.toIso}'`;
    }
    // Top 10 by total activity
    const top = raw.prepare(`SELECT ga.gen_id, g.display_title, g.prompt, g.type, g.author_name,
      SUM(CASE WHEN ga.action='play' THEN 1 ELSE 0 END) as plays,
      SUM(CASE WHEN ga.action='download' THEN 1 ELSE 0 END) as downloads,
      SUM(CASE WHEN ga.action='copy' THEN 1 ELSE 0 END) as copies,
      SUM(CASE WHEN ga.action='share' THEN 1 ELSE 0 END) as shares,
      COUNT(*) as total
      FROM gen_activity ga JOIN generations g ON ga.gen_id = g.id
      WHERE 1=1 ${dateFilter}
      GROUP BY ga.gen_id ORDER BY total DESC LIMIT 10`).all();
    // Totals (no 'ga' alias here — strip it from dateFilter)
    const totalsDateFilter = dateFilter.replace(/ga\./g, '');
    const totals = raw.prepare(`SELECT
      SUM(CASE WHEN action='play' THEN 1 ELSE 0 END) as plays,
      SUM(CASE WHEN action='download' THEN 1 ELSE 0 END) as downloads,
      SUM(CASE WHEN action='copy' THEN 1 ELSE 0 END) as copies,
      SUM(CASE WHEN action='share' THEN 1 ELSE 0 END) as shares,
      COUNT(*) as total FROM gen_activity WHERE 1=1 ${totalsDateFilter}`).get();
    res.json({ top, totals });
  });

  // Top-20 downloads (admin)
  app.get("/api/admin/top-downloads", authMiddleware, (req: Request, res: Response) => {
    const user = storage.getUser((req as any).userId);
    if (!isAdminUser(user)) { res.status(403).end(); return; }
    // Eugene 2026-05-17 Босс: единая логика period boundaries (cut-off 20:00 МСК).
    const period = (req.query.period as string) || 'all';
    const raw = db.$client;
    let dateFilter = '';
    if (period && period !== 'all') {
      const r = getPeriodRange(period);
      dateFilter = `AND ga.created_at >= '${r.fromIso}' AND ga.created_at < '${r.toIso}'`;
    }
    const rows = raw.prepare(`SELECT ga.gen_id, g.display_title, g.prompt, g.type, g.author_name,
      COUNT(*) as downloads,
      MAX(ga.created_at) as last_download
      FROM gen_activity ga JOIN generations g ON ga.gen_id = g.id
      WHERE ga.action='download' ${dateFilter}
      GROUP BY ga.gen_id ORDER BY downloads DESC LIMIT 20`).all();
    const totalDateFilter = dateFilter.replace(/ga\./g, '');
    const totalDownloads = raw.prepare(`SELECT COUNT(*) as total FROM gen_activity WHERE action='download' ${totalDateFilter}`).get();
    res.json({ rows, totalDownloads: (totalDownloads as any)?.total || 0 });
  });

  // Per-generation activity detail
  app.get("/api/admin/gen-stats/:id", authMiddleware, (req: Request, res: Response) => {
    const user = storage.getUser((req as any).userId);
    if (!isAdminUser(user)) { res.status(403).end(); return; }
    const genId = parseInt(req.params.id);
    const raw = db.$client;
    const byAction = raw.prepare("SELECT action, COUNT(*) as c FROM gen_activity WHERE gen_id = ? GROUP BY action").all(genId);
    const byDay = raw.prepare("SELECT date(created_at) as d, action, COUNT(*) as c FROM gen_activity WHERE gen_id = ? GROUP BY d, action ORDER BY d DESC LIMIT 60").all(genId);
    res.json({ genId, byAction, byDay });
  });

  // Geo-activity для админа: фильтр today/week/month/all + список IP с городами.
  app.get("/api/admin/gen-activity-geo/:id", authMiddleware, async (req: Request, res: Response) => {
    const user = storage.getUser((req as any).userId);
    if (!isAdminUser(user)) { res.status(403).end(); return; }
    res.setHeader("Cache-Control", "no-store");
    const genId = parseInt(req.params.id);
    // Eugene 2026-05-17 Босс: единая логика period boundaries (cut-off 20:00 МСК).
    const period = String(req.query.period || "all");
    let dateFilter = "";
    if (period && period !== "all") {
      const r = getPeriodRange(period);
      dateFilter = `AND created_at >= '${r.fromIso}' AND created_at < '${r.toIso}'`;
    }

    const raw = db.$client;
    // Все события (включая IP) за период
    const events = raw.prepare(
      `SELECT id, action, ip, city, region, country, country_code as countryCode, created_at as createdAt
       FROM gen_activity
       WHERE gen_id = ? AND action = 'play' ${dateFilter}
       ORDER BY id DESC LIMIT 500`
    ).all(genId) as any[];

    // Дорезолвим отсутствующую географию на лету (батчем до 20 IP, чтобы не перегружать ip-api)
    const missing = events.filter(e => e.ip && !e.country).slice(0, 20);
    if (missing.length > 0) {
      const uniqueIps = [...new Set(missing.map(e => e.ip).filter(Boolean))];
      await Promise.all(uniqueIps.map(async ip => {
        const geo = await resolveIpGeo(ip);
        if (geo) {
          db.update(genActivity).set({ city: geo.city, region: geo.region, country: geo.country, countryCode: geo.countryCode })
            .where(eq(genActivity.ip, ip)).run();
          // Обновим в памяти
          for (const ev of events) if (ev.ip === ip) Object.assign(ev, geo);
        }
      }));
    }

    // Сводка: total + по городам/странам
    const byCity: Record<string, number> = {};
    const byCountry: Record<string, number> = {};
    for (const e of events) {
      const cityKey = e.city ? `${e.city}, ${e.country || ""}`.replace(/, $/, "") : "Неизвестно";
      byCity[cityKey] = (byCity[cityKey] || 0) + 1;
      const cKey = e.country || "Неизвестно";
      byCountry[cKey] = (byCountry[cKey] || 0) + 1;
    }
    const cityList = Object.entries(byCity).map(([name, count]) => ({ name, count })).sort((a, b) => b.count - a.count);
    const countryList = Object.entries(byCountry).map(([name, count]) => ({ name, count })).sort((a, b) => b.count - a.count);

    res.json({
      total: events.length,
      period,
      events: events.map(e => ({
        id: e.id, action: e.action, ip: e.ip,
        city: e.city || null, region: e.region || null,
        country: e.country || null, countryCode: e.countryCode || null,
        createdAt: e.createdAt,
      })),
      byCity: cityList,
      byCountry: countryList,
    });
  });

  // Request title change for a generation (email confirmation)
  app.post("/api/generations/:id/rename", authMiddleware, async (req: Request, res: Response) => {
    const userId = (req as any).userId;
    const genId = parseInt(req.params.id);
    const { title } = req.body;
    if (!title || title.trim().length < 1) {
      res.status(400).json({ message: "Название не может быть пустым" });
      return;
    }
    const gen = db.select().from(generations).where(eq(generations.id, genId)).get();
    const user = storage.getUser(userId);
    if (!user) { res.status(401).json({ message: "Не авторизован" }); return; }
    const isAdmin = isAdminUser(user);
    if (!gen || (!isAdmin && gen.userId !== userId)) {
      res.status(404).json({ message: "Не найдено" });
      return;
    }

    const trimmed = title.trim();

    // Admin can rename directly without email confirmation
    if (isAdmin) {
      db.update(generations).set({ displayTitle: trimmed, pendingTitle: null, titleChangeToken: null }).where(eq(generations.id, genId)).run();
      // Update ID3 title
      if (gen.type === 'music' && gen.localPath) {
        try {
          const NodeID3 = require('node-id3');
          const mp3Path = path.join(AUTHORS_DIR, gen.localPath);
          if (fs.existsSync(mp3Path)) {
            const tags = NodeID3.read(mp3Path);
            tags.title = trimmed;
            NodeID3.update(tags, mp3Path);
          }
        } catch {}
      }
      console.log(`[RENAME] Admin renamed gen #${genId} to "${trimmed}"`);
      res.json({ ok: true, direct: true, message: "Название изменено" });
      return;
    }

    const token = crypto.randomUUID();
    db.update(generations).set({ pendingTitle: trimmed, titleChangeToken: token }).where(eq(generations.id, genId)).run();

    const confirmUrl = `${PUBLIC_URL}/api/generations/confirm-title/${token}`;
    const currentTitle = gen.displayTitle || gen.prompt?.slice(0, 50) || "Без названия";

    try {
      await mailTransport.sendMail({
        from: `"MuzaAi" <${CLIENT_EMAIL}>`, replyTo: CLIENT_EMAIL,
        to: user.email,
        subject: "MuzaAi — подтверждение смены названия",
        html: `
          <div style="font-family: -apple-system, sans-serif; max-width: 480px; margin: 0 auto; padding: 32px; background: #09090b; border-radius: 16px; border: 1px solid #1a1a2e;">
            <div style="text-align: center; margin-bottom: 24px;">
              <span style="font-size: 24px; font-weight: 700; background: linear-gradient(135deg, #8b5cf6, #3b82f6); -webkit-background-clip: text; -webkit-text-fill-color: transparent;">MuzaAi</span>
            </div>
            <p style="color: #e0e0e0; font-size: 15px; margin: 0 0 16px;">Вы запросили смену названия произведения:</p>
            <p style="color: #a0a0a0; font-size: 14px; margin: 0 0 8px;"><b style="color:#e0e0e0">Текущее:</b> ${currentTitle}</p>
            <p style="color: #a0a0a0; font-size: 14px; margin: 0 0 20px;"><b style="color:#e0e0e0">Новое:</b> ${trimmed}</p>
            <p style="color: #fbbf24; font-size: 13px; margin: 0 0 20px;">⚠️ Название изменится в плейлисте и на странице трека.</p>
            <div style="text-align: center; margin: 24px 0;">
              <a href="${confirmUrl}" style="display: inline-block; padding: 12px 32px; background: linear-gradient(135deg, #8b5cf6, #3b82f6); color: white; text-decoration: none; border-radius: 12px; font-weight: 600; font-size: 15px;">Подтвердить</a>
            </div>
            <p style="color: #666; font-size: 12px; margin: 16px 0 0;">Если вы не запрашивали смену, проигнорируйте это письмо.</p>
          </div>
        `,
      });
    } catch (e) { console.error("[RENAME] Email error:", e); }

    res.json({ message: "Письмо отправлено", pendingConfirmation: true });
  });

  // Confirm title change via email link
  app.get("/api/generations/confirm-title/:token", (req: Request, res: Response) => {
    const { token } = req.params;
    const gen = db.select().from(generations).where(eq(generations.titleChangeToken, token)).get();
    if (!gen || !gen.pendingTitle) {
      res.setHeader("Content-Type", "text/html; charset=utf-8");
      res.send(`<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
        <body style="font-family:-apple-system,sans-serif;background:#09090b;color:#e0e0e0;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0">
          <div style="text-align:center;padding:32px">
            <h2 style="color:#ef4444">✘ Ссылка недействительна</h2>
            <a href="${PUBLIC_URL}" style="color:#8b5cf6">← На главную</a>
          </div></body></html>`);
      return;
    }
    const newTitle = gen.pendingTitle;
    db.update(generations).set({
      displayTitle: newTitle,
      pendingTitle: null,
      titleChangeToken: null,
    }).where(eq(generations.id, gen.id)).run();

    // Update ID3 title in MP3 file
    if (gen.type === 'music' && gen.localPath) {
      try {
        const NodeID3 = require('node-id3');
        const mp3Path = path.join(AUTHORS_DIR, gen.localPath);
        if (fs.existsSync(mp3Path)) {
          const tags = NodeID3.read(mp3Path);
          tags.title = newTitle;
          NodeID3.update(tags, mp3Path);
          console.log(`[TITLE CHANGE] Updated ID3 title for gen #${gen.id}: ${newTitle}`);
        }
      } catch (e) { console.error('[TITLE CHANGE] ID3 error:', e); }
    }

    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.send(`<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
      <body style="font-family:-apple-system,sans-serif;background:#09090b;color:#e0e0e0;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0">
        <div style="text-align:center;padding:32px">
          <h2 style="background:linear-gradient(135deg,#8b5cf6,#3b82f6);-webkit-background-clip:text;-webkit-text-fill-color:transparent">✔ Название изменено!</h2>
          <p style="color:#888">Новое название: <b style="color:#e0e0e0">${newTitle}</b></p>
          <a href="${PUBLIC_URL}/#/dashboard" style="display:inline-block;margin-top:16px;padding:10px 24px;background:linear-gradient(135deg,#8b5cf6,#3b82f6);color:white;text-decoration:none;border-radius:10px;font-weight:600">В личный кабинет</a>
        </div>
        <script>
          // Notify any open MuzaAi tabs that the playlist needs refresh.
          // This works across tabs on the same origin.
          try { localStorage.setItem('muziai-playlist-dirty', String(Date.now())); } catch(e) {}
          try { sessionStorage.setItem('playlistDirty', '1'); } catch(e) {}
          try {
            const bc = new BroadcastChannel('muziai-events');
            bc.postMessage({ type: 'rename', genId: ${gen.id}, newTitle: ${JSON.stringify(newTitle)} });
            setTimeout(() => bc.close(), 500);
          } catch(e) {}
        </script>
      </body></html>`);
  });

  // Attach a cover to a music track
  app.post("/api/generations/:id/cover", authMiddleware, async (req: Request, res: Response) => {
    const userId = (req as any).userId;
    const genId = parseInt(req.params.id);
    const { coverGenId } = req.body;
    const gen = db.select().from(generations).where(eq(generations.id, genId)).get();
    if (!gen || gen.userId !== userId || gen.type !== "music") {
      res.status(404).json({ message: "Трек не найден" });
      return;
    }
    if (coverGenId) {
      const cover = db.select().from(generations).where(eq(generations.id, coverGenId)).get();
      if (!cover || cover.userId !== userId || cover.type !== "cover") {
        res.status(400).json({ message: "Обложка не найдена" });
        return;
      }
    }
    db.update(generations).set({ coverGenId: coverGenId || null }).where(eq(generations.id, genId)).run();

    // Update ID3 cover art in MP3 file for lockscreen
    if (gen.localPath) {
      try {
        const sharp = require('sharp');
        const NodeID3 = require('node-id3');
        const mp3Path = path.join(AUTHORS_DIR, gen.localPath);
        if (fs.existsSync(mp3Path)) {
          // Resolve new cover image
          let coverImgPath: string | null = null;
          if (coverGenId) {
            const coverGen = db.select().from(generations).where(eq(generations.id, coverGenId)).get();
            if (coverGen?.localPath) {
              const cp = path.join(AUTHORS_DIR, coverGen.localPath);
              if (fs.existsSync(cp)) coverImgPath = cp;
            }
          }
          if (!coverImgPath) {
            const jp = mp3Path.replace(/\.[^.]+$/, '.jpg');
            if (fs.existsSync(jp)) coverImgPath = jp;
          }
          if (coverImgPath) {
            const coverBuf = await sharp(fs.readFileSync(coverImgPath))
              .resize(512, 512, { fit: 'cover' })
              .jpeg({ quality: 90 })
              .toBuffer();
            const tags = NodeID3.read(mp3Path);
            tags.image = { mime: 'image/jpeg', type: { id: 3, name: 'front cover' }, description: 'Cover', imageBuffer: coverBuf };
            NodeID3.update(tags, mp3Path);
            console.log(`[COVER] Updated ID3 cover for gen #${genId}`);
          }
        }
      } catch (e) { console.error('[COVER] ID3 update error:', e); }
    }

    res.json({ ok: true });
  });

  // Eugene 2026-05-16: scheduled-delete для errored треков. Юзер выбирает
  // «удалить через 1/7/15/30 дней» — пишем cutoff в scheduled_delete_at.
  // Cron в admin-overview (cleanupScheduledDeletes, каждый час) переводит
  // в soft-delete когда cutoff <= now. До этого момента — отмена записью
  // null. Не требует email-confirmation (admin-everything-except-delete:
  // soft-delete reversible через /restore).
  app.post("/api/generations/:id/schedule-delete", authMiddleware, (req: Request, res: Response) => {
    const userId = (req as any).userId;
    const genId = parseInt(req.params.id);
    if (!Number.isFinite(genId)) {
      res.status(400).json({ ok: false, message: "Некорректный id" });
      return;
    }
    const allowedDays = [1, 7, 15, 30];
    const rawDays = Number((req.body || {}).deleteAfterDays);
    if (!allowedDays.includes(rawDays)) {
      res.status(400).json({ ok: false, message: "deleteAfterDays: 1, 7, 15 или 30" });
      return;
    }
    const gen = db.select().from(generations).where(eq(generations.id, genId)).get();
    if (!gen) {
      res.status(404).json({ ok: false, message: "Не найдено" });
      return;
    }
    const user = storage.getUser(userId);
    const isAdmin = isAdminUser(user);
    if (gen.userId !== userId && !isAdmin) {
      res.status(403).json({ ok: false, message: "Нет доступа" });
      return;
    }
    const cutoff = new Date(Date.now() + rawDays * 24 * 60 * 60 * 1000).toISOString();
    db.update(generations).set({ scheduledDeleteAt: cutoff }).where(eq(generations.id, genId)).run();
    console.log(`[SCHEDULE-DELETE] gen #${genId} → ${cutoff} (in ${rawDays}d) by user #${userId}`);
    res.json({ ok: true, scheduledDeleteAt: cutoff, deleteAfterDays: rawDays });
  });

  // Cancel scheduled delete (kept in same auth scope).
  app.post("/api/generations/:id/schedule-delete/cancel", authMiddleware, (req: Request, res: Response) => {
    const userId = (req as any).userId;
    const genId = parseInt(req.params.id);
    if (!Number.isFinite(genId)) {
      res.status(400).json({ ok: false, message: "Некорректный id" });
      return;
    }
    const gen = db.select().from(generations).where(eq(generations.id, genId)).get();
    if (!gen) {
      res.status(404).json({ ok: false, message: "Не найдено" });
      return;
    }
    const user = storage.getUser(userId);
    const isAdmin = isAdminUser(user);
    if (gen.userId !== userId && !isAdmin) {
      res.status(403).json({ ok: false, message: "Нет доступа" });
      return;
    }
    db.update(generations).set({ scheduledDeleteAt: null }).where(eq(generations.id, genId)).run();
    res.json({ ok: true });
  });

  // Delete generation: email link confirmation (only author can delete their own)
  // Step 1: request deletion → sends confirmation LINK to author's email
  const pendingDeletes = new Map<string, { genId: number; userId: number; token: string; expires: number }>();

  app.post("/api/generations/:id/delete", authMiddleware, async (req: Request, res: Response) => {
    const userId = (req as any).userId;
    const genId = parseInt(req.params.id);
    const gen = db.select().from(generations).where(eq(generations.id, genId)).get();
    if (!gen || gen.userId !== userId) {
      res.status(404).json({ message: "Не найдено" });
      return;
    }
    const user = storage.getUser(userId);
    if (!user || !user.email) {
      res.status(400).json({ message: "Email не найден" });
      return;
    }
    const token = crypto.randomUUID();
    pendingDeletes.set(token, { genId, userId, token, expires: Date.now() + 30 * 60 * 1000 });
    const confirmUrl = `${PUBLIC_URL}/api/generations/confirm-delete/${token}`;
    const title = gen.displayTitle || (gen.prompt || "").slice(0, 40);
    try {
      await mailTransport.sendMail({
        from: `"MuzaAi" <${CLIENT_EMAIL}>`, replyTo: CLIENT_EMAIL,
        to: user.email,
        subject: `Подтверждение удаления — ${title}`,
        html: `<div style="font-family:-apple-system,sans-serif;max-width:480px;margin:0 auto;padding:32px;background:#09090b;border-radius:16px;border:1px solid #1a1a2e;">
          <h2 style="color:#a78bfa;margin:0 0 16px">Удаление генерации</h2>
          <p style="color:#e0e0e0">Вы запросили удаление:</p>
          <p style="color:#fff;font-weight:bold;font-size:16px;margin:8px 0">${title}</p>
          <p style="color:#888;margin-bottom:20px">Нажмите кнопку ниже для подтверждения. Ссылка действительна 30 минут.</p>
          <a href="${confirmUrl}" style="display:inline-block;padding:14px 32px;background:linear-gradient(135deg,#dc2626,#b91c1c);color:white;text-decoration:none;border-radius:12px;font-weight:600;font-size:15px">Подтвердить удаление</a>
          <p style="color:#666;font-size:12px;margin-top:20px">Если вы не запрашивали удаление — проигнорируйте это письмо.</p>
        </div>`,
      });
    } catch (e) {
      console.error("[DELETE] Email error:", e);
    }
    res.json({ needConfirmation: true, message: "Ссылка для подтверждения отправлена на " + user.email });
  });

  // Step 2: confirm deletion via link click
  app.get("/api/generations/confirm-delete/:token", (req: Request, res: Response) => {
    const token = req.params.token;
    const pending = pendingDeletes.get(token);
    if (!pending || Date.now() > pending.expires) {
      res.setHeader("Content-Type", "text/html; charset=utf-8");
      res.send(`<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
        <body style="font-family:-apple-system,sans-serif;background:#09090b;color:#e0e0e0;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0">
        <div style="text-align:center;padding:32px"><p style="color:#f87171;font-size:18px">Ссылка истекла или недействительна</p><a href="${PUBLIC_URL}" style="color:#a78bfa">Вернуться на MuzaAi</a></div></body></html>`);
      return;
    }
    pendingDeletes.delete(token);

    const gen = db.select().from(generations).where(eq(generations.id, pending.genId)).get();
    if (!gen) {
      res.setHeader("Content-Type", "text/html; charset=utf-8");
      res.send(`<html><head><meta charset="utf-8"></head><body style="font-family:sans-serif;background:#09090b;color:#e0e0e0;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0"><p>Генерация не найдена</p></body></html>`);
      return;
    }
    const title = gen.displayTitle || (gen.prompt || "").slice(0, 40);

    // Soft-delete
    db.update(generations).set({ deletedAt: new Date().toISOString(), isPublic: 0 }).where(eq(generations.id, pending.genId)).run();

    // If cover, detach from tracks
    if (gen.type === "cover") {
      db.update(generations).set({ coverGenId: null }).where(eq(generations.coverGenId, pending.genId)).run();
    }

    // Move local file to deleted subfolder
    if (gen.localPath) {
      try {
        const srcPath = path.join(AUTHORS_DIR, gen.localPath);
        const authorFolder = path.dirname(gen.localPath);
        const delDir = path.join(AUTHORS_DIR, authorFolder, "deleted");
        fs.mkdirSync(delDir, { recursive: true });
        const destPath = path.join(delDir, path.basename(gen.localPath));
        if (fs.existsSync(srcPath)) {
          fs.renameSync(srcPath, destPath);
          const imgSrc = srcPath.replace(/\.mp3$/, ".jpg");
          if (fs.existsSync(imgSrc)) {
            fs.renameSync(imgSrc, path.join(delDir, path.basename(imgSrc)));
          }
          db.update(generations).set({ localPath: path.relative(AUTHORS_DIR, destPath) }).where(eq(generations.id, pending.genId)).run();
        }
      } catch (e) { console.error("[DELETE] Move error:", e); }
    }
    console.log(`[DELETE] User #${pending.userId} confirmed deletion of gen #${pending.genId} via link`);

    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.send(`<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
      <body style="font-family:-apple-system,sans-serif;background:#09090b;color:#e0e0e0;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0">
      <div style="text-align:center;padding:32px">
        <div style="width:64px;height:64px;margin:0 auto 16px;border-radius:50%;background:#dc262620;display:flex;align-items:center;justify-content:center"><span style="font-size:28px">✓</span></div>
        <p style="font-size:18px;font-weight:bold;color:#f87171;margin-bottom:8px">Удалено</p>
        <p style="color:#888">${title}</p>
        <a href="${PUBLIC_URL}/#/dashboard" style="display:inline-block;margin-top:20px;padding:10px 24px;background:linear-gradient(135deg,#8b5cf6,#3b82f6);color:white;text-decoration:none;border-radius:12px;font-weight:600">Вернуться в кабинет</a>
      </div></body></html>`);
  });

  // Restore a deleted generation
  app.post("/api/generations/:id/restore", authMiddleware, (req: Request, res: Response) => {
    const userId = (req as any).userId;
    const genId = parseInt(req.params.id);
    const gen = db.select().from(generations).where(eq(generations.id, genId)).get();
    if (!gen || gen.userId !== userId) {
      res.status(404).json({ message: "Не найдено" });
      return;
    }
    db.update(generations).set({ deletedAt: null }).where(eq(generations.id, genId)).run();

    // Move file back from deleted subfolder
    if (gen.localPath && gen.localPath.includes("/deleted/")) {
      try {
        const srcPath = path.join(AUTHORS_DIR, gen.localPath);
        const parentDir = path.dirname(path.dirname(gen.localPath));
        const destPath = path.join(AUTHORS_DIR, parentDir, path.basename(gen.localPath));
        if (fs.existsSync(srcPath)) {
          fs.renameSync(srcPath, destPath);
          const imgSrc = srcPath.replace(/\.mp3$/, ".jpg");
          if (fs.existsSync(imgSrc)) {
            fs.renameSync(imgSrc, path.join(AUTHORS_DIR, parentDir, path.basename(imgSrc)));
          }
          const newLocalPath = path.relative(AUTHORS_DIR, destPath);
          db.update(generations).set({ localPath: newLocalPath }).where(eq(generations.id, genId)).run();
        }
      } catch (e) { console.error("[RESTORE] Move error:", e); }
    }
    res.json({ ok: true });
  });

  // ==================== OG SHARE PAGE ====================
  // Server-rendered page with Open Graph meta for social sharing.
  //
  // Eugene 2026-05-18 Босс «при шаринге трека preview показывает MuzaAi logo
  // вместо реальной обложки трека». Этот endpoint — единственный источник
  // правильного OG preview. Клиентский код (landing/dashboard/track) ОБЯЗАН
  // делиться ссылкой /share/:id, не /#/track/:id (последний — pure SPA
  // hash route, crawlers получают index.html без per-track meta).
  //
  // Crawler detection (TelegramBot, facebookexternalhit, twitterbot, whatsapp,
  // vkshare, slackbot, discordbot, linkedinbot): не делаем JS-redirect,
  // отдаём только HTML с meta-tags. Обычный браузер: redirect на SPA play page.
  //
  // OG title теперь — `<displayTitle> · <authorName>` (не generic
  // «Послушай на MuzaAi.ru») — preview в TG показывает реальное название.
  function isSocialCrawler(ua: string): boolean {
    const u = (ua || "").toLowerCase();
    return /telegrambot|telegram\/|facebookexternalhit|twitterbot|whatsapp|vkshare|slackbot|discordbot|linkedinbot|pinterest|skypeuripreview|googlebot|yandexbot/i.test(u);
  }

  function escapeAttr(s: string): string {
    return String(s)
      .replace(/&/g, "&amp;")
      .replace(/"/g, "&quot;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;");
  }

  app.get("/share/:id", (req: Request, res: Response) => {
    const gen = db.select().from(generations).where(eq(generations.id, parseInt(req.params.id))).get();
    if (!gen || gen.status !== "done") {
      res.redirect(PUBLIC_URL);
      return;
    }
    const author = db.select().from(users).where(eq(users.id, gen.userId)).get();
    const authorName = gen.authorName || author?.name || "Аноним";
    const title = gen.displayTitle || gen.prompt?.slice(0, 70) || "MuzaAi";
    const imageUrl = `${PUBLIC_URL}/api/cover/${gen.id}.jpg?wm=1`;
    const audioUrl = gen.type === "music" ? `${PUBLIC_URL}/api/stream/${gen.id}` : "";
    const pageUrl = `${PUBLIC_URL}/#/play/${gen.id}`;
    const shareUrl = `${PUBLIC_URL}/share/${gen.id}`;
    const ogTitle = `${title} · ${authorName}`;
    const ogDesc = `Слушай ${title} на MuzaAi.ru — автор: ${authorName}`;
    const ua = String(req.headers["user-agent"] || "");
    const isCrawler = isSocialCrawler(ua);

    res.setHeader("Content-Type", "text/html; charset=utf-8");
    // Crawlers не должны кэшировать longterm — обложка/название может меняться
    res.setHeader("Cache-Control", "public, max-age=300, s-maxage=300");
    res.send(`<!DOCTYPE html>
<html lang="ru">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeAttr(ogTitle)} | MuzaAi</title>
  <meta property="og:title" content="${escapeAttr(ogTitle)}" />
  <meta property="og:description" content="${escapeAttr(ogDesc)}" />
  <meta property="og:image" content="${escapeAttr(imageUrl)}" />
  <meta property="og:image:secure_url" content="${escapeAttr(imageUrl)}" />
  <meta property="og:image:type" content="image/jpeg" />
  <meta property="og:image:width" content="512" />
  <meta property="og:image:height" content="512" />
  <meta property="og:image:alt" content="${escapeAttr(`Обложка трека ${title}`)}" />
  <meta property="og:url" content="${escapeAttr(shareUrl)}" />
  <meta property="og:type" content="music.song" />
  <meta property="og:site_name" content="MuzaAi" />
  <meta property="og:locale" content="ru_RU" />
  <meta property="music:musician" content="${escapeAttr(authorName)}" />
  ${audioUrl ? `<meta property="og:audio" content="${escapeAttr(audioUrl)}" />\n  <meta property="og:audio:type" content="audio/mpeg" />` : ""}
  <meta name="twitter:card" content="summary_large_image" />
  <meta name="twitter:title" content="${escapeAttr(ogTitle)}" />
  <meta name="twitter:description" content="${escapeAttr(ogDesc)}" />
  <meta name="twitter:image" content="${escapeAttr(imageUrl)}" />
  <meta name="description" content="${escapeAttr(ogDesc)}" />
  <link rel="canonical" href="${escapeAttr(shareUrl)}" />
  ${isCrawler ? "" : `<script>window.location.replace("${pageUrl}");</script>`}
</head>
<body style="font-family:-apple-system,sans-serif;background:#09090b;color:#e0e0e0;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0">
  <div style="text-align:center;padding:32px">
    <img src="${escapeAttr(imageUrl)}" alt="${escapeAttr(`Обложка ${title}`)}" style="width:200px;height:200px;border-radius:16px;object-fit:cover;margin-bottom:16px" />
    <p style="font-size:18px;font-weight:bold">${escapeAttr(title)}</p>
    <p style="color:#888">${escapeAttr(authorName)}</p>
    <a href="${escapeAttr(pageUrl)}" style="color:#8b5cf6;margin-top:16px;display:inline-block">Открыть в MuzaAi</a>
  </div>
</body>
</html>`);
  });

  // ==================== IMPORT UPLOADS ====================
  // Admin: scan author's upload folder, create generation records for new files
  app.post("/api/admin/import-uploads", authMiddleware, async (req: Request, res: Response) => {
    const userId = (req as any).userId;
    const user = storage.getUser(userId);
    if (!isAdminUser(user)) {
      res.status(403).json({ message: "Доступ запрещён" });
      return;
    }

    const imported: string[] = [];
    try {
      // Scan all author folders for /upload/ subdir
      const authorDirs = fs.readdirSync(AUTHORS_DIR, { withFileTypes: true }).filter(d => d.isDirectory());
      for (const authorDir of authorDirs) {
        const uploadDir = path.join(AUTHORS_DIR, authorDir.name, "upload");
        if (!fs.existsSync(uploadDir)) continue;

        const files = fs.readdirSync(uploadDir).filter(f => /\.(mp3|wav|ogg|png|jpg|jpeg|webp|txt)$/i.test(f));
        if (files.length === 0) continue;

        // Find user by folder name
        const allUsers = db.select().from(users).all();
        const matchUser = allUsers.find(u => sanitizeFolderName(u.name) === authorDir.name);
        const targetUserId = matchUser?.id || userId;
        const authorName = matchUser?.name || authorDir.name;

        for (const file of files) {
          const ext = path.extname(file).toLowerCase();
          const filePath = path.join(uploadDir, file);
          const stat = fs.statSync(filePath);

          // Check if already imported (by filename in localPath)
          const relPath = path.relative(AUTHORS_DIR, filePath);
          const existing = db.select().from(generations).where(eq(generations.localPath, relPath)).get();
          if (existing) continue;

          // Determine type
          let type = "music";
          if (/\.(png|jpg|jpeg|webp)$/i.test(ext)) type = "cover";
          else if (/\.txt$/i.test(ext)) type = "lyrics";

          // For lyrics, read content as resultUrl
          let resultUrl = filePath;
          if (type === "lyrics") {
            resultUrl = fs.readFileSync(filePath, "utf-8");
          }

          // Move file from upload to main folder
          const destPath = path.join(AUTHORS_DIR, authorDir.name, file);
          fs.renameSync(filePath, destPath);
          const newRelPath = path.relative(AUTHORS_DIR, destPath);

          // Create generation record (Eugene 2026-05-17: publishedAt при isPublic=1)
          const gen = db.insert(generations).values({
            userId: targetUserId,
            type,
            prompt: file.replace(/\.[^.]+$/, "").replace(/[_-]/g, " "),
            style: null,
            status: "done",
            resultUrl: type === "lyrics" ? resultUrl : `/api/stream/0`,
            resultData: null,
            taskId: null,
            cost: 0,
            isPublic: 1,
            authorName,
            localPath: newRelPath,
            publishedAt: new Date().toISOString(),
          } as any).returning().get();

          // Fix resultUrl for non-lyrics to point to actual stream
          if (type !== "lyrics") {
            db.update(generations).set({ resultUrl: `/api/stream/${gen.id}` }).where(eq(generations.id, gen.id)).run();
          }

          imported.push(`${file} → #${gen.id} (${type})`);
        }
      }

      res.json({ imported, count: imported.length });
    } catch (e: any) {
      res.status(500).json({ message: e.message });
    }
  });

  // ==================== ROBOKASSA PAYMENTS ====================

  // Get next invoice ID
  function getNextInvId(): number {
    const row = db.select({ maxId: sql<number>`COALESCE(MAX(inv_id), 1000)` }).from(payments).get();
    return (row?.maxId || 1000) + 1;
  }

  // Eugene 2026-05-20 Босс «счёт можно тоже в нём выписывать». Endpoint
  // отображения выписанного Музой счёта. Юзер кликает на ссылку из чата,
  // получает страницу с описанием + кнопкой «Оплатить» (которая дёрнет
  // /api/payment/create с invoice.amountRub).
  //
  // Сейчас — JSON-ответ с invoice'ом. UI-страница и фактическое
  // Robokassa-redirect — отдельный шаг wiring (см. PENDING-TASKS).
  app.get("/api/invoice/:id/pay", (req: Request, res: Response) => {
    try {
      const id = Number(req.params.id);
      if (!Number.isFinite(id)) return res.status(400).json({ ok: false, error: "bad id" });
      const inv: any = (db as any).$client.prepare(`
        SELECT id, user_id, issued_by, amount_rub, description, tariff_key,
               status, robokassa_payment_url, paid_at, expires_at, created_at
        FROM invoices WHERE id = ?
      `).get(id);
      if (!inv) return res.status(404).json({ ok: false, error: "invoice not found" });
      // Срок действия
      const expired = inv.expires_at && new Date(inv.expires_at).getTime() < Date.now();
      res.json({
        ok: true,
        invoice: {
          id: inv.id,
          userId: inv.user_id,
          issuedBy: inv.issued_by,
          amountRub: inv.amount_rub,
          description: inv.description,
          tariffKey: inv.tariff_key,
          status: inv.status,
          paidAt: inv.paid_at,
          expiresAt: inv.expires_at,
          expired,
          createdAt: inv.created_at,
        },
        // Для оплаты юзер должен быть залогинен. Frontend на этой странице
        // делает POST /api/payment/create с amount=inv.amount_rub.
        next: inv.status === "issued" && !expired
          ? { action: "post_payment_create", amount: inv.amount_rub, description: inv.description }
          : null,
      });
    } catch (e) {
      console.error("[invoice-pay]", e);
      res.status(500).json({ ok: false, error: "internal error" });
    }
  });

  // Create payment → get Robokassa redirect URL
  // Init signature: md5( MerchantLogin:OutSum:InvId:Password1:Shp_userId=N )
  // (Password1 — для init/Success URL; Result URL использует Password2 — см. result handler).
  app.post("/api/payment/create", authMiddleware, (req: Request, res: Response) => {
    const userId = (req as any).userId;
    try {
      const user = storage.getUser(userId);
      if (!user) {
        logUserActionFailure({
          userId, channel: "web", action: "robokassa_init", statusCode: 404,
          errorCode: "user_not_found", errorMessage: "Пользователь не найден",
          endpoint: "/api/payment/create",
        });
        res.status(404).json({ message: "Пользователь не найден" });
        return;
      }

      // Eugene 2026-05-20 Босс «счёт можно тоже в нём выписывать». Если
      // передан invoiceId — берём amount/description из invoices, юзер только
      // подтверждает оплату. invoiceId должен принадлежать тому же userId,
      // быть в status='issued', не expired.
      const { amount, method: rawMethod, invoiceId: rawInvoiceId } = req.body;
      let resolvedInvoice: any = null;
      let resolvedDescription: string | null = null;
      let sumRubles: number;

      if (rawInvoiceId) {
        const invoiceIdNum = Number(rawInvoiceId);
        if (!Number.isFinite(invoiceIdNum)) {
          res.status(400).json({ message: "Невалидный invoiceId" });
          return;
        }
        try {
          resolvedInvoice = (db as any).$client.prepare(`
            SELECT id, user_id, amount_rub, description, tariff_key, status,
                   expires_at
            FROM invoices WHERE id = ?
          `).get(invoiceIdNum);
        } catch {}
        if (!resolvedInvoice) {
          res.status(404).json({ message: "Счёт не найден" });
          return;
        }
        if (resolvedInvoice.user_id !== userId) {
          logUserActionFailure({
            userId, channel: "web", action: "robokassa_init", statusCode: 403,
            errorCode: "invoice_not_owned",
            errorMessage: `Invoice #${invoiceIdNum} принадлежит другому юзеру`,
            endpoint: "/api/payment/create",
          });
          res.status(403).json({ message: "Этот счёт выписан не вам" });
          return;
        }
        if (resolvedInvoice.status !== "issued") {
          res.status(400).json({ message: `Счёт уже ${resolvedInvoice.status}` });
          return;
        }
        if (resolvedInvoice.expires_at && new Date(resolvedInvoice.expires_at).getTime() < Date.now()) {
          // Auto-mark expired
          try {
            (db as any).$client.prepare(`UPDATE invoices SET status='expired' WHERE id = ?`).run(invoiceIdNum);
          } catch {}
          res.status(400).json({ message: "Срок действия счёта истёк" });
          return;
        }
        sumRubles = Number(resolvedInvoice.amount_rub);
        resolvedDescription = String(resolvedInvoice.description || "").slice(0, 200);
      } else {
        sumRubles = Number(amount);
      }

      if (!sumRubles || sumRubles < 10 || sumRubles > 50000) {
        logUserActionFailure({
          userId, channel: "web", action: "robokassa_init", statusCode: 400,
          errorCode: "amount_out_of_range",
          errorMessage: `Сумма ${amount} вне диапазона 10..50000`,
          endpoint: "/api/payment/create",
        });
        res.status(400).json({ message: "Сумма от 10 до 50 000 ₽" });
        return;
      }

      // Eugene 2026-05-18 «карты + СБП». Принимаем `method` строкой и
      // валидируем в whitelist (защита от injection произвольных alias'ов
      // в IncCurrLabel). Неопределённый method → IncCurrLabel не шлём,
      // юзер выберет на стороне Robokassa (legacy-поведение).
      let method: RoboPaymentMethod | null = null;
      if (rawMethod === "card" || rawMethod === "sbp") method = rawMethod;

      const creds = getRoboCreds();
      if (!creds.login || !creds.password1) {
        logUserActionFailure({
          userId, channel: "web", action: "robokassa_init", statusCode: 503,
          errorCode: "robokassa_not_configured",
          errorMessage: "Платежи временно недоступны — Robokassa не настроена",
          endpoint: "/api/payment/create",
        });
        res.status(503).json({ message: "Оплата временно недоступна. Попробуйте позже." });
        return;
      }

      const invId = getNextInvId();
      const description = resolvedDescription
        ? `${resolvedDescription} (счёт #${resolvedInvoice.id})`
        : `Пополнение баланса MuzaAi: ${sumRubles} ₽`;
      const outSum = sumRubles.toFixed(2);

      // 54-ФЗ Receipt — обязательный для услуг с предоплатой (ст. 4.7 ФЗ-54).
      // Формат и URL-encoding — по справке Robokassa «Фискализация»:
      // «Значение должно быть URL-encoded перед использованием в строке
      //  для подсчёта подписи и перед отправкой в форме.»
      // Источник: docs.robokassa.ru/fiscalization/
      const receipt = buildReceipt(sumRubles);
      const receiptParam = receiptToParam(receipt); // = encodeURIComponent(JSON.stringify(receipt))

      // IncCurrLabel — alias способа оплаты для pin'а на форме Robokassa.
      // Пустая строка = не пиннить (юзер выберет сам).
      // См. ROBOKASSA-INTEGRATION-PLAN.md §12 + lib/robokassaMethods.ts.
      const incCurrLabel = incCurrLabelFor(method);

      // Save payment to DB (pending). Audit-trail для администратора.
      // method+IncCurrLabel пишем сразу — для разбора саппорт-кейсов
      // (Result URL потом перезапишет roboData полным callback'ом).
      db.insert(payments).values({
        userId,
        invId,
        amount: sumRubles * 100, // kopecks
        status: "pending",
        description,
        roboData: JSON.stringify({ method, incCurrLabel, receipt }),
        // Eugene 2026-05-20: если это оплата Музa-выписанного счёта.
        invoiceId: resolvedInvoice ? resolvedInvoice.id : null,
      }).run();

      // Shp_* extras — отсортированы алфавитно, добавляются в подпись и в URL.
      // См. ROBOKASSA-INTEGRATION-PLAN.md §2.
      //
      // Init signature WITH Receipt (Robokassa требует Receipt в подпись
      // между Password1 и Shp_*):
      //   md5(MerchantLogin:OutSum:InvId:Receipt:Password1[:Shp_*])
      // Receipt в подписи — это URL-encoded JSON (тот же что в URL).
      const shp = { Shp_userId: String(userId) };
      const shpParts = buildShpSignatureParts(shp);
      const signature = roboSignature([
        creds.login,
        outSum,
        String(invId),
        receiptParam,
        creds.password1,
        ...shpParts,
      ]);

      const params = new URLSearchParams({
        MerchantLogin: creds.login,
        OutSum: outSum,
        InvId: String(invId),
        Description: description,
        SignatureValue: signature,
        Email: user.email,
        // Receipt должен быть URL-encoded JSON, причём URLSearchParams
        // дополнительно encode'нет '%' символы в нём — это правильное
        // поведение, итог совпадает с подписью (где encodeURIComponent
        // тоже был один раз).
        Receipt: receiptParam,
        ...(incCurrLabel ? { IncCurrLabel: incCurrLabel } : {}),
        ...shp,
        ...(creds.isTest ? { IsTest: "1" } : {}),
      });

      const paymentUrl = `${ROBO_BASE_URL}?${params.toString()}`;

      console.log(`[PAYMENT] Created invoice #${invId} for user ${userId}: ${sumRubles} ₽ (test=${creds.isTest}, method=${method || "auto"}, label=${incCurrLabel || "—"})`);
      res.json({ paymentUrl, invId, method, incCurrLabel: incCurrLabel || null });
    } catch (e: any) {
      console.error("[PAYMENT] Error:", e);
      logUserActionFailure({
        userId, channel: "web", action: "robokassa_init", statusCode: 500,
        errorCode: "internal_error",
        errorMessage: String(e?.message || e).slice(0, 500),
        endpoint: "/api/payment/create",
      });
      res.status(500).json({ message: "Ошибка при создании платежа" });
    }
  });

  // Robokassa Result URL (webhook) — called by Robokassa server after successful payment.
  // Robokassa требует ответ ровно `OK<InvId>` (plain text, 200) — иначе будет
  // повторять callback с экспоненциальным backoff. Handler идемпотентен по InvId.
  //
  // Подпись: md5( OutSum:InvId:Password2[:Shp_*=...] ) — Password2, не Password1.
  // См. ROBOKASSA-INTEGRATION-PLAN.md §2.2 + §3.
  app.post("/api/payment/result", express.urlencoded({ extended: false }), (req: Request, res: Response) => {
    const { OutSum, InvId, SignatureValue, Shp_userId } = req.body;
    try {
      console.log(`[PAYMENT RESULT] InvId=${InvId}, OutSum=${OutSum}, UserId=${Shp_userId}`);

      const creds = getRoboCreds();
      if (!creds.password2) {
        console.error("[PAYMENT RESULT] Robokassa Password2 не настроен — игнорируем callback");
        // Robokassa не получит OK<InvId> → будет повторять. Это правильное поведение:
        // молча кредитовать с пустым паролем нельзя ни в коем случае.
        res.status(503).send("Robokassa not configured");
        return;
      }

      // Verify signature: OutSum:InvId:Password2[:Shp_userId=N]
      // Shp_* params сортируются алфавитно (см. buildShpSignatureParts).
      const shpParts = Shp_userId !== undefined
        ? buildShpSignatureParts({ Shp_userId: String(Shp_userId) })
        : [];
      const expectedSig = roboSignature([
        String(OutSum),
        String(InvId),
        creds.password2,
        ...shpParts,
      ]);

      // BACKEND-1 fix: timing-safe compare (Eugene 14:16). Раньше !== leak'ал
      // время через side-channel, можно было постепенно угадать пароль.
      const got = String(SignatureValue || "").toUpperCase();
      const exp = expectedSig.toUpperCase();
      const same = got.length === exp.length && (() => {
        try {
          return crypto.timingSafeEqual(Buffer.from(got, "utf8"), Buffer.from(exp, "utf8"));
        } catch { return false; }
      })();
      if (!same) {
        // НЕ логируем сам expectedSig целиком (содержит косвенно подсказку
        // о Password2 через MD5-input). Только длины + first4 для диагностики.
        console.error(`[PAYMENT RESULT] Bad signature! exp.len=${exp.length} got.len=${got.length} exp.first4=${exp.slice(0, 4)} got.first4=${got.slice(0, 4)}`);
        logUserActionFailure({
          userId: Number(Shp_userId) || null, channel: "web", action: "robokassa_result",
          statusCode: 400, errorCode: "bad_signature",
          errorMessage: "Invalid Robokassa signature",
          endpoint: "/api/payment/result",
          context: { invId: String(InvId), outSum: String(OutSum) },
        });
        res.status(400).send("Bad signature");
        return;
      }

      const invIdNum = parseInt(InvId);
      const payment = db.select().from(payments).where(eq(payments.invId, invIdNum)).get();

      if (!payment) {
        console.error(`[PAYMENT RESULT] Payment not found: InvId=${InvId}`);
        logUserActionFailure({
          userId: Number(Shp_userId) || null, channel: "web", action: "robokassa_result",
          statusCode: 404, errorCode: "payment_not_found",
          errorMessage: `Payment with InvId=${InvId} not found in DB`,
          endpoint: "/api/payment/result",
          context: { invId: String(InvId), outSum: String(OutSum) },
        });
        res.status(404).send("Payment not found");
        return;
      }

      if (payment.status === "paid") {
        // Already processed — just confirm
        res.send(`OK${InvId}`);
        return;
      }

      const amountKopecks = Math.round(parseFloat(OutSum) * 100);
      const userId = parseInt(Shp_userId);

      // Eugene 2026-05-20: сохраняем invoiceId ДО overwrite roboData.
      const invoiceIdForFulfillment = (payment as any).invoiceId ?? null;

      // Update payment status
      db.update(payments).set({ status: "paid", roboData: JSON.stringify(req.body) }).where(eq(payments.invId, invIdNum)).run();

      // Eugene 2026-05-20 Босс «счёт можно тоже выписывать» + premium-подписка.
      // Если это оплата Музa-выписанного счёта — НЕ кредитим balance, а делаем
      // fulfillment по tariff_key (subscription activation / track-credit / topup).
      if (invoiceIdForFulfillment) {
        try {
          const inv: any = (db as any).$client.prepare(`
            SELECT id, user_id, amount_rub, description, tariff_key, status
            FROM invoices WHERE id = ?
          `).get(invoiceIdForFulfillment);
          if (inv && inv.status !== "paid") {
            const nowIso = new Date().toISOString();
            (db as any).$client.prepare(`
              UPDATE invoices
              SET status = 'paid', paid_at = ?, robokassa_inv_id = ?
              WHERE id = ?
            `).run(nowIso, String(InvId), invoiceIdForFulfillment);

            // Tariff → subscription mapping. 30 дней дефолт для всех premium-tier.
            const TARIFF_TO_TIER: Record<string, { tier: string; days: number }> = {
              premium_voice_msg: { tier: "voice_messages", days: 30 },
              // Будущие: premium_pro → { tier: 'pro', days: 30 }
            };
            const subSpec = TARIFF_TO_TIER[String(inv.tariff_key || "")];

            if (subSpec) {
              // Активация / продление подписки. Если есть active —
              // expires_at = max(existing.expires_at, now) + days.
              const existing: any = (db as any).$client.prepare(`
                SELECT id, expires_at, status FROM premium_subscriptions
                WHERE user_id = ? AND tier = ?
                ORDER BY id DESC LIMIT 1
              `).get(inv.user_id, subSpec.tier);
              const now = Date.now();
              const baseMs = existing && existing.expires_at && existing.status === "active"
                ? Math.max(new Date(existing.expires_at).getTime(), now)
                : now;
              const expiresAt = new Date(baseMs + subSpec.days * 24 * 60 * 60 * 1000).toISOString();
              if (existing) {
                (db as any).$client.prepare(`
                  UPDATE premium_subscriptions
                  SET status = 'active', started_at = COALESCE(started_at, ?),
                      expires_at = ?, invoice_id = ?, updated_at = ?
                  WHERE id = ?
                `).run(nowIso, expiresAt, invoiceIdForFulfillment, nowIso, existing.id);
              } else {
                (db as any).$client.prepare(`
                  INSERT INTO premium_subscriptions
                    (user_id, tier, status, started_at, expires_at, invoice_id)
                  VALUES (?, ?, 'active', ?, ?, ?)
                `).run(inv.user_id, subSpec.tier, nowIso, expiresAt, invoiceIdForFulfillment);
              }
              storage.createTransaction({
                userId: inv.user_id,
                type: "topup",
                amount: 0,
                description: `💎 Премиум-подписка ${subSpec.tier} активна до ${expiresAt.slice(0, 10)} (счёт #${inv.id})`,
              });
              console.log(`[INVOICE PAID] Subscription ${subSpec.tier} active for user #${inv.user_id} until ${expiresAt}`);
            } else if (String(inv.tariff_key || "").startsWith("topup_") || inv.tariff_key === "custom") {
              // Topup-tariff — credit balance как обычно.
              storage.updateBalance(inv.user_id, inv.amount_rub * 100);
              storage.createTransaction({
                userId: inv.user_id,
                type: "topup",
                amount: inv.amount_rub * 100,
                description: `Счёт #${inv.id}: ${inv.description}`,
              });
              console.log(`[INVOICE PAID] Topup ${inv.amount_rub}₽ for user #${inv.user_id}`);
            } else {
              // track_399 и прочее — credit balance (тариф пойдёт на следующую генерацию).
              storage.updateBalance(inv.user_id, inv.amount_rub * 100);
              storage.createTransaction({
                userId: inv.user_id,
                type: "topup",
                amount: inv.amount_rub * 100,
                description: `Счёт #${inv.id}: ${inv.description}`,
              });
              console.log(`[INVOICE PAID] ${inv.tariff_key} ${inv.amount_rub}₽ → balance for user #${inv.user_id}`);
            }
          }
        } catch (e) {
          console.error("[INVOICE FULFILLMENT] failed:", (e as Error).message);
          // Не возвращаем ошибку Robokassa — деньги уже списаны. Админ разберёт
          // через admin_chat_messages / invoices status.
        }
      } else {
        // Старая логика — топ-ап balance.
        storage.updateBalance(userId, amountKopecks);
        storage.createTransaction({
          userId,
          type: "topup",
          amount: amountKopecks,
          description: `Оплата картой: ${OutSum} ₽ (счёт #${InvId})`,
        });
      }

      console.log(`[PAYMENT RESULT] SUCCESS! User ${userId} paid ${OutSum} ₽${invoiceIdForFulfillment ? ` (invoice #${invoiceIdForFulfillment})` : ""}`);

      // BACKEND-14 fix Eugene 14:27: atomic flag-set чтобы parallel webhooks
      // не дали бонус дважды. UPDATE WHERE referralBonusGiven=0 — changes=1
      // только у того кто первым успел.
      const payer = storage.getUser(userId);
      if (payer && payer.referredBy) {
        const claimed = db.update(users)
          .set({ referralBonusGiven: 1 })
          .where(and(eq(users.id, userId), eq(users.referralBonusGiven, 0)))
          .returning()
          .get();
        if (claimed) {
          // Только если мы первые поставили флаг — выдаём бонусы
          db.update(users).set({ freeUsed: Math.max(0, payer.freeUsed - 1) }).where(eq(users.id, userId)).run();
          storage.createTransaction({ userId, type: "topup", amount: 0, description: "🎁 Бонус за первую оплату: +1 трек" });
          const referrer = storage.getUser(payer.referredBy);
          if (referrer) {
            db.update(users).set({ freeUsed: Math.max(0, referrer.freeUsed - 1) }).where(eq(users.id, referrer.id)).run();
            storage.createTransaction({ userId: referrer.id, type: "topup", amount: 0, description: `🎁 Бонус: автор ${payer.name} сделал первую оплату: +1 трек` });
          }
          console.log(`[REFERRAL BONUS] First payment by #${userId}, bonus to referrer #${payer.referredBy}`);
        }
      }

      res.send(`OK${InvId}`);
    } catch (e: any) {
      console.error("[PAYMENT RESULT] Error:", e);
      logUserActionFailure({
        userId: Number(Shp_userId) || null, channel: "web", action: "robokassa_result",
        statusCode: 500, errorCode: "internal_error",
        errorMessage: String(e?.message || e).slice(0, 500),
        endpoint: "/api/payment/result",
        context: { invId: String(InvId), outSum: String(OutSum) },
      });
      res.status(500).send("Error");
    }
  });

  // Success URL — user redirected here after payment.
  // Robokassa подписывает Success URL через Password1 (НЕ Password2 как Result URL).
  // См. ROBOKASSA-INTEGRATION-PLAN.md §2.3 + §4.
  //
  // Принимаем GET (Robokassa по умолчанию редиректит GET'ом) и POST (на случай
  // если в настройках магазина выбран POST). Подпись проверяем — но даже если
  // не пройдёт, страницу всё равно показываем (реальное зачисление идёт через
  // Result URL, Success — это только UI). На bad-signature только пишем в audit.
  const handleSuccess = (req: Request, res: Response): void => {
    try {
      const src = req.method === "POST" ? req.body : req.query;
      const OutSum = String(src.OutSum || "");
      const InvId = String(src.InvId || "");
      const SignatureValue = String(src.SignatureValue || "");
      const Shp_userId = src.Shp_userId !== undefined ? String(src.Shp_userId) : undefined;

      if (OutSum && InvId && SignatureValue) {
        const creds = getRoboCreds();
        if (creds.password1) {
          const shpParts = Shp_userId !== undefined
            ? buildShpSignatureParts({ Shp_userId })
            : [];
          const expectedSig = roboSignature([OutSum, InvId, creds.password1, ...shpParts]);
          const got = SignatureValue.toUpperCase();
          const exp = expectedSig.toUpperCase();
          const same = got.length === exp.length && (() => {
            try {
              return crypto.timingSafeEqual(Buffer.from(got, "utf8"), Buffer.from(exp, "utf8"));
            } catch { return false; }
          })();
          if (!same) {
            console.warn(`[PAYMENT SUCCESS] Bad signature on Success URL (InvId=${InvId}). Showing UI anyway.`);
            logUserActionFailure({
              userId: Number(Shp_userId) || null, channel: "web", action: "robokassa_success",
              statusCode: 200, errorCode: "bad_signature_on_success",
              errorMessage: "Success URL получен с невалидной подписью (UI всё равно показан)",
              endpoint: "/api/payment/success",
              context: { invId: InvId, outSum: OutSum },
            });
          } else {
            console.log(`[PAYMENT SUCCESS] InvId=${InvId} verified, user redirected to /#/payment/success`);
          }
        }
      }
    } catch (e: any) {
      console.error("[PAYMENT SUCCESS] Verify error:", e?.message || e);
    }
    res.redirect("/#/payment/success");
  };
  app.get("/api/payment/success", handleSuccess);
  app.post("/api/payment/success", express.urlencoded({ extended: false }), handleSuccess);

  // Fail URL — user redirected here after failed/cancelled payment.
  // Robokassa НЕ подписывает Fail URL (см. ROBOKASSA-INTEGRATION-PLAN.md §5),
  // поэтому ничего в БД не меняем — только показываем UI и audit-логируем.
  const handleFail = (req: Request, res: Response): void => {
    try {
      const src = req.method === "POST" ? req.body : req.query;
      const InvId = src.InvId ? String(src.InvId) : null;
      const OutSum = src.OutSum ? String(src.OutSum) : null;
      console.log(`[PAYMENT FAIL] InvId=${InvId}, OutSum=${OutSum}`);
      if (InvId) {
        // payments.status оставляем 'pending' — статус 'failed' может быть
        // поставлен отдельным TTL-крон'ом (24h без оплаты → failed).
        const payment = db.select().from(payments).where(eq(payments.invId, parseInt(InvId))).get();
        logUserActionFailure({
          userId: payment?.userId ?? null, channel: "web", action: "robokassa_fail",
          statusCode: 200, errorCode: "user_cancelled_or_failed",
          errorMessage: "Пользователь не завершил оплату на стороне Robokassa",
          endpoint: "/api/payment/fail",
          context: { invId: InvId, outSum: OutSum || "" },
        });
      }
    } catch (e: any) {
      console.error("[PAYMENT FAIL] Audit error:", e?.message || e);
    }
    res.redirect("/#/payment/fail");
  };
  app.get("/api/payment/fail", handleFail);
  app.post("/api/payment/fail", express.urlencoded({ extended: false }), handleFail);

  // Get user payments history
  app.get("/api/payments", authMiddleware, (req: Request, res: Response) => {
    const userId = (req as any).userId;
    const userPayments = db.select().from(payments).where(eq(payments.userId, userId)).orderBy(desc(payments.id)).all();
    res.json(userPayments);
  });

  // Публичная выдача юр. реквизитов — для footer'а / страниц
  // оферты/политики/контактов. Возвращает только НЕсекретную инфу
  // (ИНН/ОГРН — публичные по закону). НЕ возвращает Robokassa-пароли.
  // Eugene 2026-05-18 Robokassa требует размещения этих данных на сайте.
  app.get("/api/legal/config", (_req: Request, res: Response) => {
    const cfg = getLegalConfig();
    res.json({
      entityName: cfg.entityName,
      entityFullName: cfg.entityFullName,
      inn: cfg.inn,
      ogrn: cfg.ogrn,
      legalAddress: cfg.legalAddress,
      phone: cfg.phone,
      email: cfg.email,
      domain: cfg.domain,
      brand: cfg.brand,
      complete: isLegalConfigComplete(cfg),
    });
  });

  // GPTunnel balance check — called by cron (08:00 and 18:00 MSK) or manually by admin
  // Sends email alert to ADMIN_ALERT_EMAIL when balance drops below threshold
  //
  // Eugene 2026-05-18 (ACCESS-BYPASS-AUDIT-170526 #3): добавил requireAdmin
  // middleware на endpoint. Cron-secret bypass сохранён для legacy cron
  // (vps cron job вызывает с ?secret=$CRON_SECRET без JWT). Без bypass и
  // без admin token → 401. Hardcoded fallback "muziai-balance-cron-2026"
  // удалён ранее (Eugene 2026-05-09 SECURITY).
  app.get("/api/admin/check-gptunnel-balance", (req: Request, res: Response, next: NextFunction) => {
    const SECRET = req.query.secret || req.headers["x-cron-secret"];
    const EXPECTED_SECRET = process.env.CRON_SECRET || "";
    if (EXPECTED_SECRET && SECRET === EXPECTED_SECRET) {
      return next(); // cron bypass — env обязателен, иначе требуем admin auth
    }
    return requireAdmin(req, res, next);
  }, async (req: Request, res: Response) => {
    const ADMIN_ALERT_EMAIL = process.env.ADMIN_ALERT_EMAIL || "egnovoselo@gmail.com";
    const THRESHOLD = 750; // ₽

    try {
      // Eugene 2026-05-08 doc-audit: используем gptunnelFetch для unified
      // timeout (10 сек на /balance) и Authorization без Bearer prefix.
      const r = await gptunnelFetch("/balance");
      const data: any = await r.json();
      const balance = Number(data.balance);
      if (isNaN(balance)) {
        return res.status(500).json({ message: "Bad balance response", raw: data });
      }

      // Log file on disk to avoid duplicate alerts within 6 hours
      const fs = await import("fs");
      const path = await import("path");
      const alertLogPath = "/var/www/neurohub/.balance-alert.log";
      let shouldSend = false;
      if (balance < THRESHOLD) {
        try {
          const lastAlert = fs.existsSync(alertLogPath)
            ? parseInt(fs.readFileSync(alertLogPath, "utf-8").trim() || "0", 10)
            : 0;
          const hoursSinceLast = (Date.now() - lastAlert) / (1000 * 60 * 60);
          if (hoursSinceLast >= 6) shouldSend = true;
        } catch {
          shouldSend = true;
        }
      }

      let emailSent = false;
      if (shouldSend) {
        const generations = Math.floor(balance / 24);
        try {
          await mailTransport.sendMail({
            from: `"MuzaAi" <${CLIENT_EMAIL}>`, replyTo: CLIENT_EMAIL,
            to: ADMIN_ALERT_EMAIL,
            subject: `⚠️ MuzaAi: баланс GPTunnel — ${balance.toFixed(2)} ₽`,
            html: `
              <div style="font-family:system-ui,-apple-system,Arial,sans-serif;max-width:540px;padding:24px;background:#0f1115;color:#eaeaea;border-radius:12px">
                <h2 style="color:#f59e0b;margin:0 0 16px">⚠️ Баланс GPTunnel низкий</h2>
                <p style="margin:0 0 12px;font-size:16px"><b>Текущий баланс:</b> <span style="color:${balance < 200 ? "#ef4444" : "#f59e0b"};font-size:20px">${balance.toFixed(2)} ₽</span></p>
                <p style="margin:0 0 12px"><b>Порог уведомления:</b> ${THRESHOLD} ₽</p>
                <p style="margin:0 0 12px"><b>Хватит на генераций:</b> ~${generations} (по 24 ₽ за трек)</p>
                <p style="margin:20px 0 8px">Пополните кабинет GPTunnel, чтобы авторы могли создавать треки.</p>
                <a href="https://gptunnel.ru" style="display:inline-block;margin-top:8px;padding:10px 20px;background:#3b82f6;color:#fff;text-decoration:none;border-radius:8px">Пополнить GPTunnel</a>
                <p style="margin-top:24px;color:#888;font-size:12px">Проверка автоматическая, дважды в день (08:00 и 18:00 МСК). Повторное письмо — не чаще 1 раза в 6 часов.</p>
              </div>
            `,
          });
          fs.writeFileSync(alertLogPath, String(Date.now()));
          emailSent = true;
          console.log(`[BALANCE-ALERT] Sent to ${ADMIN_ALERT_EMAIL}: balance=${balance} < ${THRESHOLD}`);
        } catch (e: any) {
          console.error("[BALANCE-ALERT] Email failed:", e.message);
        }
      }

      res.json({
        balance,
        threshold: THRESHOLD,
        below_threshold: balance < THRESHOLD,
        email_sent: emailSent,
        alert_email: ADMIN_ALERT_EMAIL,
      });
    } catch (e: any) {
      console.error("[BALANCE-CHECK] Error:", e.message);
      res.status(500).json({ message: e.message });
    }
  });

  // Публичный счётчик стран посетителей (для плеера)
  app.get("/api/public/countries-count", (req: Request, res: Response) => {
    res.set("Cache-Control", "public, max-age=3600");
    const raw = (db as any).$client;
    try {
      const sqlQ = `
        SELECT canon AS country, MAX(country_code) AS country_code, SUM(n) AS n FROM (
          SELECT
            CASE country
              WHEN 'США' THEN 'United States'
              WHEN 'Россия' THEN 'Russia'
              WHEN 'Германия' THEN 'Germany'
              WHEN 'Великобритания' THEN 'United Kingdom'
              WHEN 'Нидерланды' THEN 'Netherlands'
              WHEN 'Украина' THEN 'Ukraine'
              WHEN 'Молдова' THEN 'Moldova'
              WHEN 'Франция' THEN 'France'
              WHEN 'Италия' THEN 'Italy'
              WHEN 'Испания' THEN 'Spain'
              WHEN 'Польша' THEN 'Poland'
              WHEN 'Беларусь' THEN 'Belarus'
              WHEN 'Казахстан' THEN 'Kazakhstan'
              WHEN 'Турция' THEN 'Turkey'
              WHEN 'Китай' THEN 'China'
              WHEN 'Япония' THEN 'Japan'
              WHEN 'Индия' THEN 'India'
              WHEN 'Бразилия' THEN 'Brazil'
              WHEN 'Канада' THEN 'Canada'
              WHEN 'Австралия' THEN 'Australia'
              WHEN 'Израиль' THEN 'Israel'
              WHEN 'ОАЭ' THEN 'UAE'
              WHEN 'Грузия' THEN 'Georgia'
              WHEN 'Армения' THEN 'Armenia'
              WHEN 'Азербайджан' THEN 'Azerbaijan'
              WHEN 'Узбекистан' THEN 'Uzbekistan'
              ELSE country
            END AS canon, country_code, COUNT(*) AS n
          FROM visitors WHERE country IS NOT NULL AND country != ''
          GROUP BY canon, country_code
        ) GROUP BY canon ORDER BY (canon = 'Russia') DESC, n DESC`;
      const rows = (raw as any).prepare(sqlQ).all();
      res.json({ countries: rows.length, list: rows });
    } catch { res.json({ countries: 0, list: [] }); }
  });

  // Eugene 2026-05-14 Босс: «справа доп. панель с топом городов» на главной.
  // Берём из visitors по city, исключаем пустые / "0.0.0.0" daily-bump
  // (там city=NULL) — только реальные посещения.
  app.get("/api/public/top-cities", (_req: Request, res: Response) => {
    res.set("Cache-Control", "public, max-age=600");
    const raw = (db as any).$client;
    try {
      const sqlQ = `
        SELECT city, country, country_code, COUNT(*) AS n
        FROM visitors
        WHERE city IS NOT NULL AND city != '' AND ip != '0.0.0.0'
        GROUP BY city, country_code
        ORDER BY n DESC
        LIMIT 12`;
      const rows = (raw as any).prepare(sqlQ).all();
      res.json({ cities: rows.length, list: rows });
    } catch (e: any) {
      console.error("[TOP-CITIES]", e);
      res.json({ cities: 0, list: [] });
    }
  });

  // Ежедневный прирост по странам (раз в сутки): по +1 записи на каждую известную страну
  const dailyCountryBump = () => {
    try {
      const raw = (db as any).$client;
      const countries = raw.prepare("SELECT DISTINCT country, country_code FROM visitors WHERE country IS NOT NULL AND country != " + "\u0027\u0027").all();
      const ts = new Date().toISOString();
      const ins = raw.prepare("INSERT INTO visitors (ip, country, country_code, fingerprint, visits, created_at) VALUES (?, ?, ?, ?, 1, ?)");
      let n = 0;
      for (const c of countries as any[]) {
        const fp = "daily_" + (c.country_code || c.country) + "_" + ts.slice(0,10);
        ins.run("0.0.0.0", c.country, c.country_code || null, fp, ts);
        n++;
      }
      console.log("[DAILY-BUMP] added " + n + " country records");
    } catch (e) { console.error("[DAILY-BUMP] error:", e); }
  };
  setInterval(dailyCountryBump, 24 * 60 * 60 * 1000);
  setTimeout(dailyCountryBump, 5000); // на старте: чтобы было видно через 5с после запуска

  // ==================== TIMEOUT WATCHER ====================
  // ТЗ Eugene 2026-05-07/05-08: gens 672-679 показали что 2-min watcher был
  // слишком агрессивен. Поднял до 8 мин, потом 12 мин, теперь 30 мин — для
  // консистентности с admin-overview pollProcessingGenerations cutoff.
  // Auto-recovery в admin-overview подберёт поздние треки и без этого
  // watcher'а.
  // 1) Таймаут 30 мин (Suno нормально завершает за 3-6 мин, но под нагрузкой
  //    может занимать до 25-минут).
  // 2) Перед marking error — финальный poll Suno. Если succeeded → recover.
  // 3) Если Suno вернул error/failed — настоящий error + refund.
  setInterval(async () => {
    try {
      const cutoff = new Date(Date.now() - 30 * 60 * 1000).toISOString().replace("T", " ").slice(0, 19);
      const stuck = db.select().from(generations)
        .where(and(eq(generations.status, "processing"), eq(generations.type, "music")))
        .all();
      for (const gen of stuck) {
        const created = (gen.createdAt || "").replace("T", " ").slice(0, 19);
        if (!created || created > cutoff) continue;

        // Финальный poll Suno перед тем как сдаваться
        if (gen.taskId) {
          try {
            const r = await gptunnelFetch("/media/result", {
              method: "POST",
              body: JSON.stringify({ task_id: gen.taskId }),
            });
            if (r.ok) {
              const data: any = await r.json();
              const succeeded = Array.isArray(data?.result)
                ? data.result.find((t: any) => t.status === "succeeded" && t.audio_url)
                : null;
              if (succeeded) {
                storage.updateGeneration(gen.id, {
                  status: "done",
                  resultUrl: succeeded.audio_url,
                  resultData: JSON.stringify(data),
                });
                console.log(`[TIMEOUT-WATCHER] gen #${gen.id} RECOVERED from late Suno response (audio_url present)`);
                continue; // не помечаем error, не рефандим
              }
            }
          } catch (e) {
            console.error(`[TIMEOUT-WATCHER] poll failed for gen #${gen.id}, falling through to error:`, e);
          }
        }

        const reason = "MuzaAi думала больше 30 минут — иногда такое бывает. Баланс восстановлен, можно попробовать ещё раз.";
        storage.updateGeneration(gen.id, { status: "error", errorReason: reason });
        try {
          if ((gen.cost || 0) > 0) {
            storage.refundGeneration({ genId: gen.id, userId: gen.userId, cost: gen.cost, type: "music", description: `Возврат: таймаут генерации #${gen.id}` });
          } else if (storage.claimRefund(gen.id)) {
            db.update(users).set({ bonusTracks: sql`${users.bonusTracks} + 1` }).where(eq(users.id, gen.userId)).run();
            storage.createTransaction({ userId: gen.userId, type: "music", amount: 0, description: `🎁 Возврат подарочного трека: таймаут #${gen.id}` });
          }
        } catch (e) { console.error("[TIMEOUT-WATCHER] refund error:", e); }
        console.log(`[TIMEOUT-WATCHER] gen #${gen.id} marked as failed (>8 min, no audio in poll). Refunded ${gen.cost} kop.`);
      }
    } catch (e) {
      console.error("[TIMEOUT-WATCHER] error:", e);
    }
  }, 30000);

  // ==================== REGENERATE ====================
  // Автор может регенерировать свой failed-трек с теми же параметрами
  app.post("/api/music/regenerate/:id", authMiddleware, async (req: Request, res: Response) => {
    const userId = (req as any).userId;
    const genId = parseInt(req.params.id, 10);
    if (!genId) { res.status(400).json({ message: "Неверный ID" }); return; }
    if (isSunoCircuitOpen()) { res.status(503).json({ message: "MuzaAi временно недоступен. Мы уже работаем над проблемой. Попробуйте через 5–10 минут." }); return; }
    const oldGen = storage.getGeneration(genId);
    if (!oldGen || oldGen.userId !== userId) { res.status(404).json({ message: "Генерация не найдена" }); return; }
    if (oldGen.status !== "error") { res.status(400).json({ message: "Можно регенерировать только треки с ошибкой" }); return; }
    const user = storage.getUser(userId);
    if (!user) { res.status(404).json({ message: "Пользователь не найден" }); return; }

    // Распарсиваем оригинальные параметры из поля style (JSON)
    let styleObj: any = {};
    try { styleObj = JSON.parse(oldGen.style || "{}"); } catch {}
    const charge = checkAndCharge(userId, "music");
    if (!charge.ok) { res.status(402).json({ message: charge.error }); return; }

    try {
      const newGen = storage.createGeneration({
        userId,
        type: "music",
        prompt: oldGen.prompt,
        style: oldGen.style,
        cost: charge.isFree ? 0 : PRICES.music,
        status: "processing",
        isPublic: oldGen.isPublic,
        authorName: oldGen.authorName || user.name || "Аноним",
      });

      const rawLyricsRaw = (oldGen.prompt || "").length > 0 && (oldGen.prompt || "").includes("\n") ? oldGen.prompt : "";
      const rawPromptRaw = oldGen.prompt || "";
      const styleStr = styleObj.style || "";
      const titleStr = styleObj.title || "";
      const instrumental = !!styleObj.instrumental;
      // Eugene 2026-05-07: regenerate теперь сохраняет voiceType из исходного
      // трека (oldGen.voiceType), а не дефолтит на Female как раньше.
      const inheritedVoice = (oldGen as any).voiceType ?? null;
      const norm = normalizeVocalParams({
        prompt: rawPromptRaw,
        style: styleStr,
        lyrics: rawLyricsRaw,
        voiceType: inheritedVoice,
        instrumental,
        generationId: newGen.id,
      });
      try {
        db.update(generations).set({ voiceType: norm.voiceType }).where(eq(generations.id, newGen.id)).run();
      } catch {}
      const rawLyrics = norm.finalLyrics || rawLyricsRaw;
      const rawPrompt = norm.finalPrompt || rawPromptRaw;
      // Используем нормализованный finalStyle вместо ручной конкатенации.
      const fullTags = norm.finalStyle;
      const autoTitle = titleStr || rawLyrics.split("\n")[0]?.replace(/^\[.*?\]\s*/, "").slice(0, 80) || rawPrompt.slice(0, 80) || "Мой трек";
      const effectivePrompt = rawPrompt || rawLyrics.split("\n").slice(0, 3).join(" ").slice(0, 400);

      const payload: any = { model: "suno" };
      if (instrumental) {
        payload.prompt = `Instrumental, no vocals. ${fullTags || ""} ${effectivePrompt}`.trim().slice(0, 400);
      } else if (rawLyrics && rawLyrics.length >= 50) {
        payload.mode = "custom";
        payload.lyric = rawLyrics.slice(0, 3000);
        payload.title = autoTitle.slice(0, 80);
        if (fullTags) payload.tags = fullTags.slice(0, 200);
        if (rawPrompt && rawPrompt !== rawLyrics) payload.prompt = rawPrompt.slice(0, 400);
      } else {
        payload.prompt = (effectivePrompt || rawLyrics || "Песня").slice(0, 400);
      }

      // Правило Eugene 2026-05-08: всегда сохраняем название
      try {
        db.update(generations).set({ displayTitle: autoTitle.slice(0, 200) }).where(eq(generations.id, newGen.id)).run();
      } catch {}

      const resp = await gptunnelFetch("/media/create", { method: "POST", body: JSON.stringify(payload) });
      const data = await resp.json();
      console.log(`[REGEN] gen #${newGen.id} (from #${oldGen.id}):`, JSON.stringify(data).slice(0, 300));

      if (!resp.ok || data.error || (data.code && data.code !== 0)) {
        storage.updateGeneration(newGen.id, { status: "error", errorReason: data.error?.message || data.message || "Ошибка API" });
        if (!charge.isFree) {
          storage.refundGeneration({ genId: newGen.id, userId, cost: newGen.cost || 9900, type: "music", description: `Возврат: ошибка регенерации #${newGen.id}` });
        }
        res.status(400).json({ message: data.error?.message || data.message || "Ошибка повторной генерации" });
        return;
      }
      const taskId = data.id;
      if (!taskId) {
        storage.updateGeneration(newGen.id, { status: "error", errorReason: "MuzaAi не вернул task_id" });
        if (!charge.isFree) {
          storage.refundGeneration({ genId: newGen.id, userId, cost: newGen.cost || 9900, type: "music", description: `Возврат: нет task_id при регенерации #${newGen.id}` });
        }
        res.status(500).json({ message: "Не удалось запустить регенерацию" });
        return;
      }
      storage.updateGeneration(newGen.id, { taskId, status: "processing" });
      const updatedUser = storage.getUser(userId);
      res.json({ id: newGen.id, taskId, balance: updatedUser?.balance });
    } catch (e: any) {
      res.status(500).json({ message: "Ошибка: " + e.message });
    }
  });

  // === Admin Email 2FA — Eugene 2026-05-17 Босс «максимальная защита» ===
  // Spec: docs/strategy/ADMIN-SECURITY-AUDIT-170526.md.
  //
  //   POST /api/admin/v304/protected-action/initiate
  //   POST /api/admin/v304/protected-action/confirm
  //   GET  /api/admin/v304/protected-action/recent
  //
  // Flow:
  //   1) initiate(action, args) → создаёт pending запись + email с кодом
  //   2) admin вводит код в UI → confirm → status='confirmed'
  //   3) UI повторно вызывает action (через Музу/admin endpoint) с
  //      { confirmedActionId } → tool resolveает через getConfirmedAction()
  //      → mark used + audit-log.

  app.post(
    "/api/admin/v304/protected-action/initiate",
    requireAdmin,
    async (req: Request, res: Response) => {
      try {
        const action = String(req.body?.action || "").trim();
        const args = req.body?.args ?? {};
        if (!isProtectedAction(action)) {
          return res.status(400).json({ data: null, error: `unknown protected action: ${action}` });
        }
        const adminUserId = (req as any).userId as number;
        const adminUser = (req as any).adminUser as { email?: string } | undefined;
        const adminEmail = String(adminUser?.email || "").toLowerCase();
        if (!adminEmail) {
          return res.status(400).json({ data: null, error: "admin email не определён" });
        }
        const ip = (req.ip || (req.headers["x-forwarded-for"] as string) || "").toString();
        const ua = String(req.headers["user-agent"] || "");

        const result = await initiateAction({
          adminUserId,
          adminEmail,
          action: action as ProtectedAction,
          args,
          ip,
          userAgent: ua,
        });

        return res.json({
          data: {
            actionId: result.actionId,
            expiresAt: result.expiresAt,
            message: `Код подтверждения отправлен на ${maskEmailForAdmin(adminEmail)}. Действует 10 минут.`,
            // plainCodeIfDisabled — только в test-mode (ADMIN_2FA_DISABLE=1)
            testCode: result.plainCodeIfDisabled,
          },
          error: null,
        });
      } catch (e: any) {
        console.error("[admin-2fa initiate]", e);
        return res.status(400).json({ data: null, error: String(e?.message || e) });
      }
    },
  );

  app.post(
    "/api/admin/v304/protected-action/confirm",
    requireAdmin,
    (req: Request, res: Response) => {
      try {
        const actionId = String(req.body?.actionId || "").trim();
        const code = String(req.body?.code || "").trim();
        if (!actionId || !code) {
          return res.status(400).json({ data: null, error: "actionId и code обязательны" });
        }
        const adminUserId = (req as any).userId as number;
        const r = confirmAction(actionId, code, adminUserId);
        if (!r.ok) {
          return res.status(400).json({
            data: null,
            error: r.error,
            remainingAttempts: r.remainingAttempts,
          });
        }
        return res.json({
          data: {
            ok: true,
            action: r.pending.action,
            argsJson: r.pending.argsJson,
            confirmedAt: r.pending.confirmedAt,
            message: "Код принят. Можно выполнять действие.",
          },
          error: null,
        });
      } catch (e: any) {
        console.error("[admin-2fa confirm]", e);
        return res.status(500).json({ data: null, error: String(e?.message || e) });
      }
    },
  );

  app.get(
    "/api/admin/v304/protected-action/recent",
    requireAdmin,
    (req: Request, res: Response) => {
      try {
        const adminUserId = (req as any).userId as number;
        cleanupExpiredPendingActions();
        const lim = Math.min(50, Math.max(1, Number(req.query?.limit) || 20));
        const rows = listRecentPendingActions(adminUserId, lim);
        return res.json({
          data: rows.map((r) => ({
            id: r.id,
            action: r.action,
            status: r.status,
            attempts: r.attempts,
            createdAt: r.createdAt,
            expiresAt: r.expiresAt,
            confirmedAt: r.confirmedAt,
            usedAt: r.usedAt,
          })),
          error: null,
        });
      } catch (e: any) {
        return res.status(500).json({ data: null, error: String(e?.message || e) });
      }
    },
  );

  // Audit-log просмотр — enriched columns (via_email_confirm + ip + ua).
  // Filters: ?limit=N, ?entity=X, ?adminUserId=N, ?viaEmailConfirm=1, ?since=ISO
  app.get(
    "/api/admin/v304/audit-log",
    requireAdmin,
    (req: Request, res: Response) => {
      try {
        const rows = queryAuditLog({
          limit: Number(req.query?.limit) || 100,
          entity: typeof req.query?.entity === "string" ? req.query.entity : undefined,
          adminUserId: req.query?.adminUserId ? Number(req.query.adminUserId) : undefined,
          viaEmailConfirmOnly: req.query?.viaEmailConfirm === "1",
          since: typeof req.query?.since === "string" ? req.query.since : undefined,
        });
        return res.json({ data: rows, error: null });
      } catch (e: any) {
        return res.status(500).json({ data: null, error: String(e?.message || e) });
      }
    },
  );

  return httpServer;
}

function maskEmailForAdmin(email: string): string {
  const at = email.indexOf("@");
  if (at <= 0) return email ? `${email.slice(0, 3)}***` : "—";
  return `${email.slice(0, Math.min(3, at))}***${email.slice(at)}`;
}
