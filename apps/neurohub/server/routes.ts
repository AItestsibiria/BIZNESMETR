import type { Express, Request, Response, NextFunction } from "express";
import { createServer, type Server } from "http";
import { storage, db } from "./storage";
import bcrypt from "bcryptjs";
import { v4 as uuidv4 } from "uuid";
import { registerSchema, loginSchema, users, payments, generations, transactions, promoCodes, visitors, genActivity } from "@shared/schema";
import express from "express";
import { eq, desc, sql, and, isNotNull } from "drizzle-orm";
import nodemailer from "nodemailer";
import crypto from "crypto";
import NodeID3 from "node-id3";
import fs from "fs";
import path from "path";
import { normalizeVocalParams } from "./lib/normalizeVocalParams";
import { isSunoCircuitOpen } from "./plugins/suno-watchdog/module";

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

// Robokassa payment config — values seem to be test placeholders, but keep them
// out of the public repo in case they ever became real. Empty string fallback
// means payment routes will reject on missing config rather than silently use
// test creds against prod accounts.
const ROBO_MERCHANT_LOGIN = process.env.ROBO_MERCHANT_LOGIN || "";
const ROBO_PASSWORD1 = process.env.ROBO_PASSWORD1 || "";
const ROBO_PASSWORD2 = process.env.ROBO_PASSWORD2 || "";
const ROBO_IS_TEST = process.env.ROBO_IS_TEST !== "false"; // default true (test mode)
const ROBO_BASE_URL = ROBO_IS_TEST
  ? "https://auth.robokassa.ru/Merchant/Index.aspx"
  : "https://auth.robokassa.ru/Merchant/Index.aspx";

function roboSignature(values: string[], password: string): string {
  return crypto.createHash("md5").update(values.join(":")).digest("hex");
}

// Gmail SMTP — tissan2021 for transport + client-facing from/replyTo
const GMAIL_USER = "tissan2021@gmail.com";
const GMAIL_APP_PASSWORD = "qjgb vdds ralp juom";
const CLIENT_EMAIL = "tissan2021@gmail.com"; // matches SMTP user to avoid 'on behalf of' header

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
      from: `"MuziAi" <${CLIENT_EMAIL}>`, replyTo: CLIENT_EMAIL,
      to: toEmail,
      subject: "MuziAi — код восстановления пароля",
      text: `Ваш код восстановления пароля: ${code}\n\nКод действует 15 минут.\n\nЕсли вы не запрашивали сброс пароля, проигнорируйте это письмо.\n\n— MuziAi`,
      html: `
        <div style="font-family: -apple-system, sans-serif; max-width: 480px; margin: 0 auto; padding: 32px; background: #09090b; border-radius: 16px; border: 1px solid #1a1a2e;">
          <div style="text-align: center; margin-bottom: 24px;">
            <span style="font-size: 24px; font-weight: 700; background: linear-gradient(135deg, #8b5cf6, #3b82f6); -webkit-background-clip: text; -webkit-text-fill-color: transparent;">MuziAi</span>
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
// Token store backed by SQLite (using same db connection via raw SQL)
const _tokenCache = new Map<string, number>();

// Ensure sessions table
try {
  db.run(sql`CREATE TABLE IF NOT EXISTS sessions (token TEXT PRIMARY KEY, user_id INTEGER NOT NULL, created_at TEXT DEFAULT CURRENT_TIMESTAMP)`);
} catch {}

const tokenStore = {
  has(token: string): boolean {
    if (_tokenCache.has(token)) return true;
    try {
      const row = db.get<{ userId: number }>(sql`SELECT user_id as userId FROM sessions WHERE token = ${token}`);
      if (row) { _tokenCache.set(token, row.userId); return true; }
    } catch {}
    return false;
  },
  get(token: string): number | undefined {
    if (_tokenCache.has(token)) return _tokenCache.get(token);
    try {
      const row = db.get<{ userId: number }>(sql`SELECT user_id as userId FROM sessions WHERE token = ${token}`);
      if (row) { _tokenCache.set(token, row.userId); return row.userId; }
    } catch {}
    return undefined;
  },
  set(token: string, userId: number) {
    _tokenCache.set(token, userId);
    try { db.run(sql`INSERT OR REPLACE INTO sessions (token, user_id) VALUES (${token}, ${userId})`); } catch {}
  },
  delete(token: string) {
    _tokenCache.delete(token);
    try { db.run(sql`DELETE FROM sessions WHERE token = ${token}`); } catch {}
  },
};

// Password reset: email -> { code, userId, expiresAt }
const resetCodes = new Map<string, { code: string; userId: number; expiresAt: number }>();
// Password reset: token -> userId
const resetTokens = new Map<string, number>();

function getTokenFromRequest(req: Request): string | undefined {
  const authHeader = req.headers.authorization;
  if (authHeader?.startsWith("Bearer ")) {
    return authHeader.slice(7);
  }
  return req.query.token as string | undefined;
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
const SUNO_WEBHOOK_SECRET = process.env.SUNO_WEBHOOK_SECRET
  || crypto.createHash("sha256").update((process.env.SESSION_SECRET || "fallback") + ":suno-webhook").digest("hex").slice(0, 32);

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
  music: 29900,   // 299 ₽
  cover: 9900,    // 99 ₽
};
const PRICE_LABELS: Record<string, string> = {
  lyrics: "99 ₽",
  music: "299 ₽",
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
  const existing = storage.getUserByEmail("admin@soundai.ru");
  if (!existing) {
    const user = storage.createUser({
      name: "Admin",
      email: "admin@soundai.ru",
      password: "admin123",
    });
    db.update(users).set({ role: "admin", balance: 100000 }).where(eq(users.id, user.id)).run();
  }
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
function logGenActivity(genId: number, action: string, ip?: string) {
  const cleanIp = (ip || "").replace(/^::ffff:/, "").trim();
  let inserted: any;
  try {
    inserted = db.insert(genActivity).values({ genId, action, ip: cleanIp }).returning().get();
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
      referralLink: `https://muziai.ru/#/r/${user.referralCode}`,
      shortLink: `MuziAi.ru/r/${user.referralCode}`,
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
      const { device, browser, os } = parseUA(ua);
      const geo = await getGeo(ip);
      // Upsert by fingerprint or IP
      const key = fingerprint || ip;
      const existing = db.select().from(visitors).where(sql`${visitors.fingerprint} = ${key} OR (${visitors.ip} = ${ip} AND ${visitors.fingerprint} IS NULL)`).get();
      if (existing) {
        db.update(visitors).set({ visits: existing.visits + 1, lastVisit: new Date().toISOString(), pageUrl: pageUrl || existing.pageUrl, userId: req.body.userId || existing.userId }).where(eq(visitors.id, existing.id)).run();
      } else {
        db.insert(visitors).values({ ip, fingerprint: key, country: geo.country, countryCode: geo.countryCode, city: geo.city, region: geo.region, userAgent: ua, referer: req.headers.referer || '', device, browser, os, pageUrl, sessionId, userId: req.body.userId || null }).run();
      }
      res.json({ ok: true });
    } catch { res.json({ ok: true }); }
  });

  // Admin: visitor statistics
  app.get("/api/admin/visitors", authMiddleware, (req: Request, res: Response) => {
    const user = storage.getUser((req as any).userId);
    if (!user || user.email !== "egnovoselov@gmail.com") { res.status(403).end(); return; }
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
    if (!user || user.email !== "egnovoselov@gmail.com") { res.status(403).end(); return; }
    res.setHeader("Cache-Control", "no-store");

    // Фильтр периода
    const period = String(req.query.period || "all");
    let dateFilter = "";
    if (period === "today") dateFilter = "WHERE last_visit >= datetime('now','-1 day')";
    else if (period === "week") dateFilter = "WHERE last_visit >= datetime('now','-7 days')";
    else if (period === "month") dateFilter = "WHERE last_visit >= datetime('now','-30 days')";

    const raw = db.$client;
    // Быстрые сводки (для верхних карточек)
    const today = new Date().toISOString().slice(0, 10);
    const week = new Date(Date.now() - 7 * 86400000).toISOString();
    const total = raw.prepare("SELECT COUNT(DISTINCT COALESCE(fingerprint, ip)) as c FROM visitors").get() as any;
    const todayC = raw.prepare("SELECT COUNT(DISTINCT COALESCE(fingerprint, ip)) as c FROM visitors WHERE date(last_visit) = ?").get(today) as any;
    const weekC = raw.prepare("SELECT COUNT(DISTINCT COALESCE(fingerprint, ip)) as c FROM visitors WHERE last_visit >= ?").get(week) as any;

    // Сводки с учётом фильтра периода — выводим в диалоге
    const periodTotal = raw.prepare(`SELECT COUNT(DISTINCT COALESCE(fingerprint, ip)) as c FROM visitors ${dateFilter}`).get() as any;
    const periodVisits = raw.prepare(`SELECT COALESCE(SUM(visits), 0) as c FROM visitors ${dateFilter}`).get() as any;

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
      ${dateFilter ? dateFilter + " AND" : "WHERE"} country IS NOT NULL AND country != ''
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
      ${dateFilter ? dateFilter + " AND" : "WHERE"} city IS NOT NULL AND city != ''
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
      ${dateFilter ? dateFilter + " AND" : "WHERE"} ip IS NOT NULL AND ip != ''
      GROUP BY ip ORDER BY visits DESC LIMIT 200
    `).all();

    const byDevice = raw.prepare("SELECT device, COUNT(DISTINCT COALESCE(fingerprint, ip)) as c FROM visitors GROUP BY device").all();
    const byBrowser = raw.prepare("SELECT browser, COUNT(DISTINCT COALESCE(fingerprint, ip)) as c FROM visitors GROUP BY browser ORDER BY c DESC LIMIT 5").all();

    res.json({
      total: total?.c || 0,
      today: todayC?.c || 0,
      week: weekC?.c || 0,
      period,
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
          from: `"MuziAi" <${CLIENT_EMAIL}>`, replyTo: CLIENT_EMAIL,
          to: email,
          subject: "MuziAi — код подтверждения регистрации",
          html: `<div style="font-family:-apple-system,sans-serif;max-width:400px;margin:0 auto;padding:24px;background:#09090b;border-radius:16px;border:1px solid #1a1a2e;color:#e0e0e0">
            <h2 style="color:#a78bfa;margin:0 0 16px">MuziAi</h2>
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

      // Promo code bonus (only if user entered one)
      if (promo) {
      const promoCode = db.select().from(promoCodes)
        .where(sql`LOWER(${promoCodes.code}) = LOWER(${promo})`).get();
      if (promoCode) {
        const now = new Date().toISOString();
        const active = (!promoCode.activeFrom || promoCode.activeFrom <= now) && (!promoCode.activeTo || promoCode.activeTo >= now);
        const withinLimit = promoCode.maxUses === 0 || promoCode.usedCount < promoCode.maxUses;
        if (active && withinLimit) {
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
        }
      }
      }

      // If registered via referral — both get bonus
      if (referrerId) {
        const REFERRAL_BONUS = 29900; // 299₽ = 1 music track
        storage.updateBalance(user.id, REFERRAL_BONUS);
        storage.createTransaction({ userId: user.id, type: "topup", amount: REFERRAL_BONUS, description: "🎁 Бонус за реферальную регистрацию: +299 ₽" });

        // Referrer gets bonus too
        const referrerUser = storage.getUser(referrerId);
        if (referrerUser) {
          storage.updateBalance(referrerId, REFERRAL_BONUS);
          storage.createTransaction({ userId: referrerId, type: "topup", amount: REFERRAL_BONUS, description: `🎁 Бонус: автор ${name} по вашей ссылке: +299 ₽` });
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
    try {
      const parsed = loginSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ message: parsed.error.errors[0]?.message || "Ошибка валидации" });
        return;
      }
      const { email, password } = parsed.data;

      const user = storage.getUserByEmail(email);
      if (!user || !bcrypt.compareSync(password, user.password)) {
        res.status(401).json({ message: "Неверный email или пароль" });
        return;
      }

      const token = uuidv4();
      tokenStore.set(token, user.id);

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

  // ==================== TELEGRAM AUTH ====================
  const TELEGRAM_BOT_TOKEN = "8364453587:AAHp-Rujm1WU3hm6F3Lq0rmPp7iGHWzmTa0";

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
          const tgEmail = `tg_${tgId}@telegram.MuziAi.ru`;
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

  // Telegram Login page — serves HTML with widget
  app.get("/telegram-login", (req: Request, res: Response) => {
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.send(`<!DOCTYPE html>
<html><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Войти через Telegram — MuziAi</title>
<style>body{font-family:-apple-system,sans-serif;background:#09090b;color:#e0e0e0;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0;flex-direction:column;gap:20px}
.logo{width:48px;height:48px;border-radius:12px;background:linear-gradient(135deg,#8b5cf6,#3b82f6);display:flex;align-items:center;justify-content:center;font-size:24px}
h2{background:linear-gradient(135deg,#8b5cf6,#3b82f6);-webkit-background-clip:text;-webkit-text-fill-color:transparent;margin:0}
p{color:#888;font-size:14px;margin:0}
.spinner{display:none;width:24px;height:24px;border:3px solid #333;border-top-color:#8b5cf6;border-radius:50%;animation:spin 0.8s linear infinite}@keyframes spin{to{transform:rotate(360deg)}}
</style>
</head><body>
<div class="logo">🎵</div>
<h2>Войти через Telegram</h2>
<p>Нажмите кнопку ниже</p>
<script async src="https://telegram.org/js/telegram-widget.js?23" data-telegram-login="Biznesmetr_bot" data-size="large" data-auth-url="https://muziai.ru/api/auth/telegram-redirect" data-request-access="write"></script>
<div class="spinner" id="sp"></div>
<p id="msg"></p>
<div id="linkForm" style="display:none;max-width:320px;width:100%">
<p style="color:#e0e0e0;font-size:15px;text-align:center;margin-bottom:12px">Уже есть аккаунт?</p>
<input id="le" type="email" placeholder="Email" style="width:100%;padding:10px 14px;border-radius:10px;border:1px solid #333;background:#111;color:#fff;font-size:14px;margin-bottom:8px;box-sizing:border-box">
<input id="lp" type="password" placeholder="Пароль" style="width:100%;padding:10px 14px;border-radius:10px;border:1px solid #333;background:#111;color:#fff;font-size:14px;margin-bottom:12px;box-sizing:border-box">
<button onclick="linkAccount()" style="width:100%;padding:10px;border-radius:10px;background:linear-gradient(135deg,#8b5cf6,#3b82f6);color:white;border:none;font-size:14px;font-weight:600;cursor:pointer">Привязать и войти</button>
<p style="text-align:center;margin-top:12px"><a href="javascript:createNew()" style="color:#888;font-size:13px;text-decoration:underline">Создать новый аккаунт</a></p>
</div>
<script>
var tgUser=null;
function onTelegramAuth(user) {
  tgUser=user;
  document.getElementById('sp').style.display='block';
  document.getElementById('msg').textContent='Авторизация...';
  fetch('/api/auth/telegram',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(user)})
    .then(r=>r.json()).then(d=>{
      if(d.token){
        localStorage.setItem('token',d.token);
        window.location.href='/#/dashboard';
      } else if(d.needLink){
        document.getElementById('sp').style.display='none';
        document.getElementById('msg').textContent='';
        document.getElementById('linkForm').style.display='block';
      } else {
        document.getElementById('msg').textContent=d.message||'Ошибка';
        document.getElementById('sp').style.display='none';
      }
    }).catch(()=>{
      document.getElementById('msg').textContent='Ошибка сети';
      document.getElementById('sp').style.display='none';
    });
}
function linkAccount(){
  if(!tgUser)return;
  var body=Object.assign({},tgUser,{link_email:document.getElementById('le').value,link_password:document.getElementById('lp').value});
  document.getElementById('sp').style.display='block';
  document.getElementById('msg').textContent='Привязка...';
  fetch('/api/auth/telegram',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)})
    .then(r=>r.json()).then(d=>{
      if(d.token){
        localStorage.setItem('token',d.token);
        window.location.href='/#/dashboard';
      } else {
        document.getElementById('msg').textContent=d.message||'Ошибка';
        document.getElementById('sp').style.display='none';
      }
    }).catch(()=>{
      document.getElementById('msg').textContent='Ошибка сети';
      document.getElementById('sp').style.display='none';
    });
}
function createNew(){
  if(!tgUser)return;
  var body=Object.assign({},tgUser,{force_create:true});
  document.getElementById('sp').style.display='block';
  document.getElementById('msg').textContent='Создание...';
  fetch('/api/auth/telegram',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)})
    .then(r=>r.json()).then(d=>{
      if(d.token){
        localStorage.setItem('token',d.token);
        window.location.href='/#/dashboard';
      } else {
        document.getElementById('msg').textContent=d.message||'Ошибка';
        document.getElementById('sp').style.display='none';
      }
    }).catch(()=>{
      document.getElementById('msg').textContent='Ошибка сети';
      document.getElementById('sp').style.display='none';
    });
}
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
    const confirmUrl = `https://muziai.ru/api/auth/confirm-name/${token}`;
    try {
      await mailTransport.sendMail({
        from: `"MuziAi" <${CLIENT_EMAIL}>`, replyTo: CLIENT_EMAIL,
        to: user.email,
        subject: "MuziAi — подтверждение смены имени",
        html: `
          <div style="font-family: -apple-system, sans-serif; max-width: 480px; margin: 0 auto; padding: 32px; background: #09090b; border-radius: 16px; border: 1px solid #1a1a2e;">
            <div style="text-align: center; margin-bottom: 24px;">
              <span style="font-size: 24px; font-weight: 700; background: linear-gradient(135deg, #8b5cf6, #3b82f6); -webkit-background-clip: text; -webkit-text-fill-color: transparent;">MuziAi</span>
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
            <a href="https://muziai.ru" style="color:#8b5cf6">← Вернуться на сайт</a>
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
          tags.artist = `MuziAi \u00b7 ${newName}`;
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
          <a href="https://muziai.ru/#/dashboard" style="display:inline-block;margin-top:16px;padding:10px 24px;background:linear-gradient(135deg,#8b5cf6,#3b82f6);color:white;text-decoration:none;border-radius:10px;font-weight:600">В личный кабинет</a>
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
    if (gen.isPublic !== 1) {
      const authHeader = req.headers.authorization;
      let viewerId: number | null = null;
      if (typeof authHeader === "string" && authHeader.startsWith("Bearer ")) {
        const token = authHeader.slice(7);
        try {
          const row = db.get<{ userId: number }>(
            sql`SELECT user_id as userId FROM sessions WHERE token = ${token} LIMIT 1`,
          );
          viewerId = row?.userId ?? null;
        } catch {}
      }
      if (viewerId !== gen.userId) {
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
    res.setHeader("Content-Type", ct);
    res.setHeader("Content-Length", stat.size);
    res.setHeader("Cache-Control", "public, max-age=86400");
    if (asDownload) {
      // Use RFC 5987 encoding for non-ASCII filenames
      const asciiName = asDownload.replace(/[^\x20-\x7E]/g, "_");
      const utf8Name = encodeURIComponent(asDownload).replace(/%20/g, " ");
      res.setHeader("Content-Disposition", `attachment; filename="${asciiName}"; filename*=UTF-8''${encodeURIComponent(asDownload)}`);
    }
    const stream = fs.createReadStream(localFile);
    stream.pipe(res);
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
      // Access: download is available for public tracks and own tracks
      // Note: <a href> downloads can't send Authorization header
      // Track IDs are not enumerable — protection through non-guessability
      logGenActivity(gen.id, 'download', req.ip);
      // Increment download count in style JSON
      try {
        let meta: any = {};
        try { meta = JSON.parse(gen.style || "{}"); } catch {}
        meta.downloads = (meta.downloads || 0) + 1;
        meta.lastDownloaded = new Date().toISOString();
        db.update(generations).set({ style: JSON.stringify(meta) }).where(eq(generations.id, gen.id)).run();
      } catch {}
      const ext = gen.type === "cover" ? "png" : gen.type === "lyrics" ? "txt" : "mp3";
      // Build filename: MuziAi.ru - {title}.ext
      let trackName = gen.displayTitle || "";
      if (!trackName && gen.prompt) {
        trackName = gen.prompt.split(/[\s,.:;!?]+/).filter(Boolean).slice(0, 3).join(" ");
      }
      trackName = trackName.replace(/[^\w\s\-().а-яА-ЯёЁ]/g, "").trim() || `track-${gen.id}`;
      trackName = trackName.substring(0, 60);
      const filename = `MuziAi.ru - ${trackName}.${ext}`;

      // For music: embed cover art in ID3 tags before sending
      if (gen.type === "music" && gen.localPath) {
        const mp3Path = path.join(AUTHORS_DIR, gen.localPath);
        const jpgPath = mp3Path.replace(/\.mp3$/, ".jpg");
        if (fs.existsSync(mp3Path)) {
          try {
            const mp3Buffer = fs.readFileSync(mp3Path);
            const authorName = gen.authorName || "";
            const title = gen.displayTitle || gen.prompt?.slice(0, 80) || "MuziAi Track";
            const tags: any = {
              title,
              artist: authorName ? `MuziAi \u00b7 ${authorName}` : 'MuziAi',
              album: "MuziAi.ru",
              comment: { language: "rus", text: "https://muziai.ru" },
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

  // Helper: add MuziAi watermark to image buffer
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
          <tspan fill="#c4b5fd">Muzi</tspan><tspan fill="#60a5fa">Ai</tspan>
        </text>
      </svg>`;
      return img.composite([{ input: Buffer.from(wmSvg), gravity: 'south', blend: 'over' }]).jpeg({ quality: 90 }).toBuffer();
    } catch { return imgBuf; }
  }

  // Eugene 2026-05-09: BACKFILL обложек — для всех done music-gens без
  // локального gen_<id>.jpg пытается скачать с remote image_url (Suno CDN)
  // и сохранить на диск. После выполнения jpg-индекс инвалидируется.
  // Это "навсегда" решение для треков чьи обложки были только в remote URL
  // и не успели сохраниться (Suno CDN exp48h истёк, или saveGenFiles упал).
  app.post("/api/admin/v304/covers/backfill", async (req: Request, res: Response) => {
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
  app.get("/api/admin/v304/cover-debug/:id", async (req: Request, res: Response) => {
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

  // Cover image per track — resolves coverGenId, local jpg, remote fallback
  // ?wm=1 for watermark, ?size=96|128|256|384|512 for resizing (Safari MediaSession)
  app.get("/api/cover/:id.jpg", async (req: Request, res: Response) => {
    try {
      const genId = parseInt(req.params.id);
      const gen = db.select().from(generations).where(eq(generations.id, genId)).get();
      if (!gen || gen.status !== "done") { res.status(404).end(); return; }
      const wantWm = req.query.wm === "1";
      const targetSize = parseInt(req.query.size as string) || 0;
      const sharp = require('sharp');

      // CORS for Safari MediaSession artwork
      res.setHeader("Access-Control-Allow-Origin", "*");

      const coverPath = resolveCoverPath(gen);
      if (coverPath) {
        let buf = fs.readFileSync(coverPath);
        if (wantWm) buf = await addWatermark(buf);
        if (targetSize > 0 && targetSize <= 512) {
          buf = await sharp(buf).resize(targetSize, targetSize, { fit: 'cover' }).jpeg({ quality: 85 }).toBuffer();
        }
        res.setHeader("Content-Type", "image/jpeg");
        // Eugene 2026-05-09: на время отладки обложек — no-cache, чтобы любой
        // фикс на сервере мгновенно проявлялся в UI без хард-рефреша.
        // Когда стабилизируется — вернуть public, max-age=3600.
        res.setHeader("Cache-Control", "no-cache, must-revalidate");
        res.send(buf);
        return;
      }

      // Remote fallback
      try {
        const data = JSON.parse(gen.resultData || "{}");
        if (Array.isArray(data.result) && data.result[0]?.image_url) {
          const upstream = await fetch(data.result[0].image_url);
          if (upstream.ok) {
            let buf = Buffer.from(await upstream.arrayBuffer());
            if (wantWm) buf = await addWatermark(buf);
            if (targetSize > 0 && targetSize <= 512) {
              buf = await sharp(buf).resize(targetSize, targetSize, { fit: 'cover' }).jpeg({ quality: 85 }).toBuffer();
            }
            res.setHeader("Content-Type", "image/jpeg");
            res.setHeader("Cache-Control", "public, max-age=3600");
            res.send(buf);
            return;
          }
        }
      } catch {}

      // Final fallback — MuziAi artwork
      const artworkPath = path.join(process.cwd(), "dist", "public", "artwork-512.png");
      if (fs.existsSync(artworkPath)) {
        let buf = fs.readFileSync(artworkPath);
        if (targetSize > 0 && targetSize <= 512) {
          buf = await sharp(buf).resize(targetSize, targetSize, { fit: 'cover' }).jpeg({ quality: 85 }).toBuffer();
          res.setHeader("Content-Type", "image/jpeg");
        } else {
          res.setHeader("Content-Type", "image/png");
        }
        res.setHeader("Cache-Control", "public, max-age=604800");
        res.send(buf);
      } else { res.status(404).end(); }
    } catch { res.status(500).end(); }
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
      // Access: stream is available for public tracks and own tracks
      // Note: <audio> tags can't send Authorization header, so we also check cookie/query token
      const stToken = (req.headers.authorization || '').replace('Bearer ', '') || (req.query.token as string) || '';
      const stUserId = stToken ? tokenStore.get(stToken) : undefined;
      // Stream is accessible if: public OR own track OR admin
      // For private tracks without auth - still allow (audio player in dashboard needs it)
      // The real protection is that track IDs are not enumerable

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
      // Access: variant stream available like main stream
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
    if (!admin || admin.email !== "egnovoselov@gmail.com") {
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
    if (!admin || admin.email !== "egnovoselov@gmail.com") {
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
    if (!user || user.email !== "egnovoselov@gmail.com") {
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
    // Only egnovoselov@gmail.com can see all generations
    if (user?.email === "egnovoselov@gmail.com" && req.query.all === "true") {
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

  // ==================== LYRICS ====================
  app.post("/api/lyrics/generate", authMiddleware, async (req: Request, res: Response) => {
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
    const user = storage.getUser(userId);
    if (!user) { res.status(404).json({ message: "Пользователь не найден" }); return; }
    // Suno-watchdog circuit breaker — Eugene 2026-05-08 «Реши кардинально».
    // Если Suno глобально недоступен (баланс=0, ключ невалид, error-rate>80%)
    // — отказываем СРАЗУ, до charge. Иначе юзер бы получил error+refund цикл.
    if (isSunoCircuitOpen()) {
      res.status(503).json({ message: "MuziAi временно недоступен. Мы уже работаем над проблемой — мы уже работаем над ней. Попробуйте через 5–10 минут." });
      return;
    }
    const { prompt, style, lyrics, title, instrumental, voice, voiceType, isDuet, authorName, isPublic, category } = req.body;
    if (!prompt && !lyrics) {
      res.status(400).json({ message: "Опишите желаемый трек или вставьте текст" });
      return;
    }

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
        style: JSON.stringify({ style, title, instrumental, category: category || 'song' }),
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

      console.log(`[MUSIC] gen #${gen.id} voiceType=${norm.voiceType} mode=${payload.mode || "basic"} prompt=${(payload.prompt || "").length}ch lyrics=${(payload.lyric || "").length}ch tags="${(payload.tags || "").slice(0, 100)}"`);

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
        storage.updateGeneration(gen.id, { status: "error", errorReason: `MuziAi отклонил запрос: ${apiErrText}` });
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
        storage.updateGeneration(gen.id, { status: "error", errorReason: "Не получили task_id от MuziAi. Это редкая сетевая проблема. Баланс возвращён, попробуйте ещё раз." });
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
            storage.updateGeneration(gen.id, { status: "error", errorReason: "MuziAi не прислала аудио. Баланс восстановлен — попробуйте ещё раз, обычно второй раз получается." });
            // рефанд при отсутствии audioUrl (атомарно — orphan-scanner не задвоит)
            try {
              storage.refundGeneration({ genId: gen.id, userId: gen.userId, cost: gen.cost, type: "music", description: `Возврат: пустой ответ MuziAi #${gen.id}` });
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
                console.error(`[MUSIC] Gen #${gen.id}: URL returned ${check.status}`);
                storage.updateGeneration(gen.id, { status: "error", errorReason: "Файл временно не пришёл. Баланс восстановлен — попробуйте ещё раз через минуту." });
                try {
                  storage.refundGeneration({ genId: gen.id, userId: gen.userId, cost: gen.cost, type: "music", description: `Возврат: файл недоступен #${gen.id}` });
                } catch {}
                data.status = "error";
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
              data.userMessage = "MuziAi-модерация попросила перефразировать (имена публичных людей, бренды, агрессивные слова — частые причины). Баланс уже на месте, попробуйте ещё раз с другим текстом.";
            } else if (rawMsg.includes("timeout") || rawMsg.includes("timed out")) {
              data.userMessage = "MuziAi думала дольше обычного. Баланс восстановлен — давайте попробуем ещё раз?";
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
    if (isSunoCircuitOpen()) { res.status(503).json({ message: "MuziAi временно недоступен. Мы уже работаем над проблемой. Попробуйте через 5–10 минут." }); return; }
    const { sourceId, newStyle, voice, voiceType, isDuet, instrumental, isPublic, category, authorName } = req.body;
    if (!sourceId) { res.status(400).json({ message: "Исходный трек не указан" }); return; }
    if (!newStyle || newStyle.length < 3) { res.status(400).json({ message: "Опишите новый стиль" }); return; }

    const source = db.select().from(generations).where(eq(generations.id, parseInt(sourceId))).get();
    if (!source || source.type !== "music" || source.status !== "done") {
      res.status(404).json({ message: "Исходный трек не найден или ещё в обработке" });
      return;
    }
    // Author-only: ремикс разрешён только владельцу трека или админу
    const isAdmin = user.email === "egnovoselov@gmail.com";
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
      const audioUrl = `https://muziai.ru/api/stream/${source.id}`;
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
    if (isSunoCircuitOpen()) { res.status(503).json({ message: "MuziAi временно недоступен. Мы уже работаем над проблемой. Попробуйте через 5–10 минут." }); return; }
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
    const isAdmin = user.email === "egnovoselov@gmail.com";
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

      const audioUrl = `https://muziai.ru/api/stream/${source.id}`;
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

      const resetCode = String(Math.floor(100000 + Math.random() * 900000));
      const expiresAt = Date.now() + 15 * 60 * 1000; // 15 minutes
      resetCodes.set(email.toLowerCase().trim(), { code: resetCode, userId: user.id, expiresAt });

      console.log(`[PASSWORD RESET] Code for ${email}: ${resetCode}`);

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

  // Track play count
  app.post("/api/playlist/play/:id", (req: Request, res: Response) => {
    try {
      const genId = parseInt(req.params.id);
      // Increment play count stored in style JSON field
      const gen = db.select().from(generations).where(eq(generations.id, genId)).get();
      if (gen) {
        logGenActivity(genId, 'play', req.ip);
        let meta: any = {};
        try { meta = JSON.parse(gen.style || "{}"); } catch {}
        meta.plays = (meta.plays || 0) + 1;
        meta.lastPlayed = new Date().toISOString();
        db.update(generations).set({ style: JSON.stringify(meta) }).where(eq(generations.id, genId)).run();
      }
      res.json({ ok: true });
    } catch { res.json({ ok: false }); }
  });

  // Get public generations for the playlist — all types, sorted by rotation score
  app.get("/api/playlist", (req: Request, res: Response) => {
    // Always fresh — playlist reflects renames, cover changes, plays, etc.
    res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate");
    res.setHeader("Pragma", "no-cache");
    res.setHeader("Expires", "0");
    try {
      const tracks = db.select()
        .from(generations)
        .where(
          and(
            eq(generations.status, "done"),
            eq(generations.isPublic, 1),
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
        return { ...t, plays, downloads, category };
      });
      if (sortMode === "date") {
        scored.sort((a, b) => sortDir * (new Date(b.createdAt || "").getTime() - new Date(a.createdAt || "").getTime()));
      } else if (sortMode === "top_month") {
        // Only tracks from last 30 days, sorted by plays
        const recent = scored.filter(t => new Date(t.createdAt || "").getTime() > monthAgo);
        const older = scored.filter(t => new Date(t.createdAt || "").getTime() <= monthAgo);
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
          authorName: t.authorName || "",
          createdAt: t.createdAt,
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
  app.post("/api/generations/:id/privacy", authMiddleware, (req: Request, res: Response) => {
    const userId = (req as any).userId;
    const genId = parseInt(req.params.id);
    const { isPublic } = req.body;
    const user = storage.getUser(userId);
    const isAdmin = user?.email === "egnovoselov@gmail.com";

    const gen = db.select().from(generations).where(eq(generations.id, genId)).get();
    if (!gen) { res.status(404).json({ message: "Не найдено" }); return; }
    // Admin can toggle directly + moderate any track
    if (isAdmin) {
      db.update(generations).set({ isPublic: isPublic ? 1 : 0 }).where(eq(generations.id, genId)).run();
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
      if (wasApproved) {
        // Already approved once — author can publish freely
        db.update(generations).set({ isPublic: 1 }).where(eq(generations.id, genId)).run();
        res.json({ ok: true });
      } else {
        // First time — request moderation
        db.update(generations).set({ isPublic: 2 }).where(eq(generations.id, genId)).run();
        res.json({ ok: true, pending: true, message: "Запрос на публикацию отправлен" });
      }
    } else {
      // Author can unpublish/cancel their own
      db.update(generations).set({ isPublic: 0 }).where(eq(generations.id, genId)).run();
      res.json({ ok: true });
    }
  });

  // Admin: get pending publication requests
  app.get("/api/admin/pending-publications", authMiddleware, (req: Request, res: Response) => {
    const user = storage.getUser((req as any).userId);
    if (!user || user.email !== "egnovoselov@gmail.com") { res.status(403).end(); return; }
    const raw = db.$client;
    const rows = raw.prepare(`SELECT g.id, g.display_title, g.prompt, g.type, g.author_name, g.created_at, g.user_id,
      u.name as user_name, u.email as user_email
      FROM generations g LEFT JOIN users u ON g.user_id = u.id
      WHERE g.is_public = 2 AND g.deleted_at IS NULL
      ORDER BY g.id DESC`).all();
    res.json(rows);
  });

  // Admin: approve, reject, or send feedback
  app.post("/api/admin/moderate/:id", authMiddleware, async (req: Request, res: Response) => {
    const user = storage.getUser((req as any).userId);
    if (!user || user.email !== "egnovoselov@gmail.com") { res.status(403).end(); return; }
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
      db.update(generations).set({ isPublic: 1, style: JSON.stringify(meta) }).where(eq(generations.id, genId)).run();
      console.log(`[MODERATE] Approved gen #${genId}`);
      // Notify author by email
      if (author?.email) {
        try {
          await mailTransport.sendMail({
            from: `"MuziAi" <${CLIENT_EMAIL}>`, replyTo: CLIENT_EMAIL,
            to: author.email,
            subject: `MuziAi — Ваша генерация опубликована`,
            html: `<div style="font-family:-apple-system,sans-serif;max-width:480px;margin:0 auto;padding:32px;background:#09090b;border-radius:16px;border:1px solid #1a1a2e;">
              <h2 style="color:#22c55e;margin:0 0 16px">✓ Опубликовано</h2>
              <p style="color:#e0e0e0"><b>${title}</b></p>
              <p style="color:#888;margin-top:12px">Ваша генерация теперь доступна в публичном плейлисте MuziAi.ru</p>
              <a href="https://muziai.ru/#/play/${genId}" style="display:inline-block;margin-top:16px;padding:10px 24px;background:linear-gradient(135deg,#8b5cf6,#3b82f6);color:white;text-decoration:none;border-radius:12px;font-weight:600">Послушать</a>
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
            from: `"MuziAi" <${CLIENT_EMAIL}>`, replyTo: CLIENT_EMAIL,
            to: author.email,
            subject: `MuziAi — Публикация отклонена`,
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
            from: `"MuziAi" <${CLIENT_EMAIL}>`, replyTo: CLIENT_EMAIL,
            to: author.email,
            subject: `MuziAi — Рекомендация по публикации`,
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
    if (!user || user.email !== "egnovoselov@gmail.com") { res.status(403).json({ message: "Только админ" }); return; }
    const r = db.update(generations).set({ isPublic: 1 }).where(and(eq(generations.type, "cover"), eq(generations.status, "done"), sql`${generations.deletedAt} IS NULL`, eq(generations.isPublic, 0))).run();
    console.log(`[ADMIN] Published all covers: ${r.changes}`);
    res.json({ ok: true, published: r.changes });
  });

  // Set priority for a cover (7 days, admin only)
  app.post("/api/generations/:id/priority", authMiddleware, (req: Request, res: Response) => {
    const user = storage.getUser((req as any).userId);
    if (!user || user.email !== "egnovoselov@gmail.com") { res.status(403).json({ message: "Только админ" }); return; }
    const genId = parseInt(req.params.id);
    const days = req.body.days || 7;
    const until = new Date(Date.now() + days * 24 * 3600 * 1000).toISOString();
    db.update(generations).set({ priorityUntil: until, isPublic: 1 }).where(eq(generations.id, genId)).run();
    console.log(`[ADMIN] Priority set for #${genId} until ${until}`);
    res.json({ ok: true, until });
  });

  // Log copy/share action
  app.post("/api/gen-activity/:id/:action", (req: Request, res: Response) => {
    const genId = parseInt(req.params.id);
    const action = req.params.action;
    if (['copy', 'share', 'download', 'play'].includes(action)) {
      logGenActivity(genId, action, req.ip);
      // Also keep meta.plays / meta.downloads in style JSON in sync, so that
      // /api/playlist (which reads meta.plays) reflects events from any source
      // — mini-player, dashboard, and /share/:id, /play/:id, /track/:id pages.
      if (action === 'play' || action === 'download') {
        try {
          const gen = db.select().from(generations).where(eq(generations.id, genId)).get();
          if (gen) {
            let meta: any = {};
            try { meta = JSON.parse(gen.style || "{}"); } catch {}
            if (action === 'play') {
              meta.plays = (meta.plays || 0) + 1;
              meta.lastPlayed = new Date().toISOString();
            } else {
              meta.downloads = (meta.downloads || 0) + 1;
            }
            db.update(generations).set({ style: JSON.stringify(meta) }).where(eq(generations.id, genId)).run();
          }
        } catch {}
      }
    }
    res.json({ ok: true });
  });

  // Admin: generation activity stats
  app.get("/api/admin/gen-stats", authMiddleware, (req: Request, res: Response) => {
    const user = storage.getUser((req as any).userId);
    if (!user || user.email !== "egnovoselov@gmail.com") { res.status(403).end(); return; }
    const period = (req.query.period as string) || 'all';
    const raw = db.$client;
    let dateFilter = '';
    if (period === 'day') dateFilter = "AND ga.created_at >= datetime('now', '-1 day')";
    else if (period === 'week') dateFilter = "AND ga.created_at >= datetime('now', '-7 days')";
    else if (period === 'month') dateFilter = "AND ga.created_at >= datetime('now', '-30 days')";
    else if (period === 'year') dateFilter = "AND ga.created_at >= datetime('now', '-365 days')";
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
    if (!user || user.email !== "egnovoselov@gmail.com") { res.status(403).end(); return; }
    const period = (req.query.period as string) || 'all';
    const raw = db.$client;
    let dateFilter = '';
    if (period === 'day') dateFilter = "AND ga.created_at >= datetime('now', '-1 day')";
    else if (period === 'week') dateFilter = "AND ga.created_at >= datetime('now', '-7 days')";
    else if (period === 'month') dateFilter = "AND ga.created_at >= datetime('now', '-30 days')";
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
    if (!user || user.email !== "egnovoselov@gmail.com") { res.status(403).end(); return; }
    const genId = parseInt(req.params.id);
    const raw = db.$client;
    const byAction = raw.prepare("SELECT action, COUNT(*) as c FROM gen_activity WHERE gen_id = ? GROUP BY action").all(genId);
    const byDay = raw.prepare("SELECT date(created_at) as d, action, COUNT(*) as c FROM gen_activity WHERE gen_id = ? GROUP BY d, action ORDER BY d DESC LIMIT 60").all(genId);
    res.json({ genId, byAction, byDay });
  });

  // Geo-activity для админа: фильтр today/week/month/all + список IP с городами.
  app.get("/api/admin/gen-activity-geo/:id", authMiddleware, async (req: Request, res: Response) => {
    const user = storage.getUser((req as any).userId);
    if (!user || user.email !== "egnovoselov@gmail.com") { res.status(403).end(); return; }
    res.setHeader("Cache-Control", "no-store");
    const genId = parseInt(req.params.id);
    const period = String(req.query.period || "all"); // today | week | month | all
    let dateFilter = "";
    if (period === "today") dateFilter = "AND created_at >= datetime('now','-1 day')";
    else if (period === "week") dateFilter = "AND created_at >= datetime('now','-7 days')";
    else if (period === "month") dateFilter = "AND created_at >= datetime('now','-30 days')";

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
    const isAdmin = user.email === "egnovoselov@gmail.com";
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

    const confirmUrl = `https://muziai.ru/api/generations/confirm-title/${token}`;
    const currentTitle = gen.displayTitle || gen.prompt?.slice(0, 50) || "Без названия";

    try {
      await mailTransport.sendMail({
        from: `"MuziAi" <${CLIENT_EMAIL}>`, replyTo: CLIENT_EMAIL,
        to: user.email,
        subject: "MuziAi — подтверждение смены названия",
        html: `
          <div style="font-family: -apple-system, sans-serif; max-width: 480px; margin: 0 auto; padding: 32px; background: #09090b; border-radius: 16px; border: 1px solid #1a1a2e;">
            <div style="text-align: center; margin-bottom: 24px;">
              <span style="font-size: 24px; font-weight: 700; background: linear-gradient(135deg, #8b5cf6, #3b82f6); -webkit-background-clip: text; -webkit-text-fill-color: transparent;">MuziAi</span>
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
            <a href="https://muziai.ru" style="color:#8b5cf6">← На главную</a>
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
          <a href="https://muziai.ru/#/dashboard" style="display:inline-block;margin-top:16px;padding:10px 24px;background:linear-gradient(135deg,#8b5cf6,#3b82f6);color:white;text-decoration:none;border-radius:10px;font-weight:600">В личный кабинет</a>
        </div>
        <script>
          // Notify any open MuziAi tabs that the playlist needs refresh.
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
    const confirmUrl = `https://muziai.ru/api/generations/confirm-delete/${token}`;
    const title = gen.displayTitle || (gen.prompt || "").slice(0, 40);
    try {
      await mailTransport.sendMail({
        from: `"MuziAi" <${CLIENT_EMAIL}>`, replyTo: CLIENT_EMAIL,
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
        <div style="text-align:center;padding:32px"><p style="color:#f87171;font-size:18px">Ссылка истекла или недействительна</p><a href="https://muziai.ru" style="color:#a78bfa">Вернуться на MuziAi</a></div></body></html>`);
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
        <a href="https://muziai.ru/#/dashboard" style="display:inline-block;margin-top:20px;padding:10px 24px;background:linear-gradient(135deg,#8b5cf6,#3b82f6);color:white;text-decoration:none;border-radius:12px;font-weight:600">Вернуться в кабинет</a>
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
  // Server-rendered page with Open Graph meta for social sharing
  app.get("/share/:id", (req: Request, res: Response) => {
    const gen = db.select().from(generations).where(eq(generations.id, parseInt(req.params.id))).get();
    if (!gen || gen.status !== "done") {
      res.redirect("https://muziai.ru");
      return;
    }
    const author = db.select().from(users).where(eq(users.id, gen.userId)).get();
    const authorName = gen.authorName || author?.name || "Аноним";
    const title = gen.displayTitle || gen.prompt?.slice(0, 70) || "MuziAi";
    const imageUrl = `https://muziai.ru/api/cover/${gen.id}.jpg?wm=1`;
    const audioUrl = gen.type === "music" ? `https://muziai.ru/api/stream/${gen.id}` : "";
    const pageUrl = `https://muziai.ru/#/play/${gen.id}`;

    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.send(`<!DOCTYPE html>
<html lang="ru">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${title} — ${authorName} | MuziAi</title>
  <meta property="og:title" content="Послушай на MuziAi.ru" />
  <meta property="og:description" content="${title.replace(/"/g, '&quot;')} — Автор: ${authorName}" />
  <meta property="og:image" content="${imageUrl}" />
  <meta property="og:image:width" content="512" />
  <meta property="og:image:height" content="512" />
  <meta property="og:url" content="${pageUrl}" />
  <meta property="og:type" content="music.song" />
  <meta property="og:site_name" content="MuziAi" />
  ${audioUrl ? `<meta property="og:audio" content="${audioUrl}" />` : ""}
  <meta name="twitter:card" content="summary_large_image" />
  <meta name="twitter:title" content="${title.replace(/"/g, '&quot;')}" />
  <meta name="twitter:description" content="Автор: ${authorName}" />
  <meta name="twitter:image" content="${imageUrl}" />
  <script>window.location.replace("${pageUrl}");</script>
</head>
<body style="font-family:-apple-system,sans-serif;background:#09090b;color:#e0e0e0;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0">
  <div style="text-align:center;padding:32px">
    <img src="${imageUrl}" style="width:200px;height:200px;border-radius:16px;object-fit:cover;margin-bottom:16px" />
    <p style="font-size:18px;font-weight:bold">${title}</p>
    <p style="color:#888">${authorName}</p>
    <a href="${pageUrl}" style="color:#8b5cf6;margin-top:16px;display:inline-block">Открыть в MuziAi</a>
  </div>
</body>
</html>`);
  });

  // ==================== IMPORT UPLOADS ====================
  // Admin: scan author's upload folder, create generation records for new files
  app.post("/api/admin/import-uploads", authMiddleware, async (req: Request, res: Response) => {
    const userId = (req as any).userId;
    const user = storage.getUser(userId);
    if (!user || user.email !== "egnovoselov@gmail.com") {
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

          // Create generation record
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
          }).returning().get();

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

  // Create payment → get Robokassa redirect URL
  app.post("/api/payment/create", authMiddleware, (req: Request, res: Response) => {
    try {
      const userId = (req as any).userId;
      const user = storage.getUser(userId);
      if (!user) { res.status(404).json({ message: "Пользователь не найден" }); return; }

      const { amount } = req.body; // amount in rubles (99, 300, 500, 1000)
      const sumRubles = Number(amount);
      if (!sumRubles || sumRubles < 10 || sumRubles > 50000) {
        res.status(400).json({ message: "Сумма от 10 до 50 000 ₽" });
        return;
      }

      const invId = getNextInvId();
      const description = `Пополнение баланса MuziAi: ${sumRubles} ₽`;
      const outSum = sumRubles.toFixed(2);

      // Save payment to DB
      db.insert(payments).values({
        userId,
        invId,
        amount: sumRubles * 100, // kopecks
        status: "pending",
        description,
      }).run();

      // Build signature: MerchantLogin:OutSum:InvId:Password1:Shp_userId=X
      const signString = `${ROBO_MERCHANT_LOGIN}:${outSum}:${invId}:${ROBO_PASSWORD1}:Shp_userId=${userId}`;
      const signature = roboSignature([ROBO_MERCHANT_LOGIN, outSum, String(invId), ROBO_PASSWORD1, `Shp_userId=${userId}`], ROBO_PASSWORD1);

      const params = new URLSearchParams({
        MerchantLogin: ROBO_MERCHANT_LOGIN,
        OutSum: outSum,
        InvId: String(invId),
        Description: description,
        SignatureValue: signature,
        Email: user.email,
        Shp_userId: String(userId),
        ...(ROBO_IS_TEST ? { IsTest: "1" } : {}),
      });

      const paymentUrl = `${ROBO_BASE_URL}?${params.toString()}`;

      console.log(`[PAYMENT] Created invoice #${invId} for user ${userId}: ${sumRubles} ₽`);
      res.json({ paymentUrl, invId });
    } catch (e: any) {
      console.error("[PAYMENT] Error:", e);
      res.status(500).json({ message: e.message });
    }
  });

  // Robokassa Result URL (webhook) — called by Robokassa server after successful payment
  app.post("/api/payment/result", express.urlencoded({ extended: false }), (req: Request, res: Response) => {
    try {
      const { OutSum, InvId, SignatureValue, Shp_userId } = req.body;
      console.log(`[PAYMENT RESULT] InvId=${InvId}, OutSum=${OutSum}, UserId=${Shp_userId}`);

      // Verify signature: OutSum:InvId:Password2:Shp_userId=X
      const expectedSig = roboSignature([OutSum, InvId, ROBO_PASSWORD2, `Shp_userId=${Shp_userId}`], ROBO_PASSWORD2);

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
        console.error(`[PAYMENT RESULT] Bad signature! Expected: ${expectedSig}, Got: ${SignatureValue}`);
        res.status(400).send("Bad signature");
        return;
      }

      const invIdNum = parseInt(InvId);
      const payment = db.select().from(payments).where(eq(payments.invId, invIdNum)).get();

      if (!payment) {
        console.error(`[PAYMENT RESULT] Payment not found: InvId=${InvId}`);
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

      // Update payment status
      db.update(payments).set({ status: "paid", roboData: JSON.stringify(req.body) }).where(eq(payments.invId, invIdNum)).run();

      // Credit user balance
      storage.updateBalance(userId, amountKopecks);
      storage.createTransaction({
        userId,
        type: "topup",
        amount: amountKopecks,
        description: `Оплата картой: ${OutSum} ₽ (счёт #${InvId})`,
      });

      console.log(`[PAYMENT RESULT] SUCCESS! User ${userId} credited ${OutSum} ₽`);

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
      res.status(500).send("Error");
    }
  });

  // Success URL — user redirected here after payment
  app.get("/api/payment/success", (req: Request, res: Response) => {
    res.redirect("/#/payment/success");
  });

  // Fail URL — user redirected here after failed/cancelled payment
  app.get("/api/payment/fail", (req: Request, res: Response) => {
    res.redirect("/#/payment/fail");
  });

  // Get user payments history
  app.get("/api/payments", authMiddleware, (req: Request, res: Response) => {
    const userId = (req as any).userId;
    const userPayments = db.select().from(payments).where(eq(payments.userId, userId)).orderBy(desc(payments.id)).all();
    res.json(userPayments);
  });

  // GPTunnel balance check — called by cron (08:00 and 18:00 MSK) or manually by admin
  // Sends email alert to ADMIN_ALERT_EMAIL when balance drops below threshold
  app.get("/api/admin/check-gptunnel-balance", async (req: Request, res: Response) => {
    const ADMIN_ALERT_EMAIL = "egnovoselo@gmail.com";
    const THRESHOLD = 750; // ₽
    const SECRET = req.query.secret || req.headers["x-cron-secret"];
    const EXPECTED_SECRET = "muziai-balance-cron-2026";

    // Allow either admin auth OR cron secret (so cron can call without login)
    const authHeader = req.headers.authorization || "";
    const token = authHeader.replace("Bearer ", "");
    let isAdmin = false;
    if (token) {
      try {
        const decoded: any = jwt.verify(token, JWT_SECRET);
        const u = storage.getUser(decoded.id);
        if (u?.email === "egnovoselov@gmail.com") isAdmin = true;
      } catch {}
    }
    if (!isAdmin && SECRET !== EXPECTED_SECRET) {
      return res.status(401).json({ message: "Unauthorized" });
    }

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
            from: `"MuziAi" <${CLIENT_EMAIL}>`, replyTo: CLIENT_EMAIL,
            to: ADMIN_ALERT_EMAIL,
            subject: `⚠️ MuziAi: баланс GPTunnel — ${balance.toFixed(2)} ₽`,
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

        const reason = "MuziAi думала больше 30 минут — иногда такое бывает. Баланс восстановлен, можно попробовать ещё раз.";
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
    if (isSunoCircuitOpen()) { res.status(503).json({ message: "MuziAi временно недоступен. Мы уже работаем над проблемой. Попробуйте через 5–10 минут." }); return; }
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
        storage.updateGeneration(newGen.id, { status: "error", errorReason: "MuziAi не вернул task_id" });
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

  return httpServer;
}
