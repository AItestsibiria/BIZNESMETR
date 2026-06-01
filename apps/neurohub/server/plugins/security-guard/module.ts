// Security guard plugin (Sprint 8).
//
// Eugene 2026-05-17 Босс «максимальная защита admin panel»:
// расширение security-guard следующими guards (см. также
// docs/strategy/ADMIN-SECURITY-AUDIT-170526.md).
//
// 1. Origin/Referer CSRF guard — для всех non-GET /api/* запросов
//    проверяем, что Origin или Referer совпадают с разрешённым доменом.
//    Разрешённые домены: muzaai.ru, clone.muziai.ru, muziai.ru, podaripesnu.ru
//    + любой *.localhost для dev. Список можно расширить через env
//    CSRF_ALLOWED_ORIGINS (запятая-разделитель).
//    Webhook'и, которые приходят без Origin (Robokassa, Telegram callback,
//    VK callback), допускаются по white-list path'ов.
//    Для /api/admin/v304/* — STRICT mode: чужой Origin → 403 (без WARN-режима).
//    Для остальных /api/* — WARN mode пока: лог + пропуск.
//
// 2. Path traversal — middleware на /api/stream/:id и /api/cover/:id
//    проверяет что :id — целое число (а не "../../etc/passwd"). v51
//    использует parseInt без guard'ов, мы добавляем явный.
//
// 3. Per-IP rate limit для /api/admin/v304/* — 60 req/min/IP. Защищает
//    от brute-force admin endpoints (даже если у атакующего попал
//    Bearer-токен — он не сможет масштабно сканить).
//
// 4. Failed-login rate limit — 5 failed login attempts / 15 min / IP.
//    Защита от credentials stuffing. Hook через global counter, обновляется
//    из login-handler'а (см. /lib/securityRateLimit.ts).
//
// 5. Block direct-IP — если Host header матчит /^\d+\.\d+\.\d+\.\d+/ или
//    начинается с IP, и path не webhook → 403. Защита от обхода
//    nginx server_name через direct IP-доступ.
//
// Spec: docs/strategy/original/01 §1.4, 07 §2 (Sprint 8),
// docs/strategy/ADMIN-SECURITY-AUDIT-170526.md.

import type { NextFunction, Request, Response } from "express";
import type { Module } from "../../core";

const DEFAULT_ALLOWED = [
  "https://muzaai.ru",
  "https://www.muzaai.ru",
  "https://clone.muziai.ru",
  "https://muziai.ru",
  "https://www.muziai.ru",
  "https://podaripesnu.ru",
  "https://www.podaripesnu.ru",
  "http://127.0.0.1:5000",
  "http://localhost:5000",
];

// Webhook'и от внешних провайдеров — приходят без Origin/Referer.
const WEBHOOK_PATHS = new Set<string>([
  "/api/payment/result",   // Robokassa
  "/api/payment/success",
  "/api/payment/fail",
  "/api/telegram/webhook",
  "/api/vk/webhook",
  "/api/max/webhook",
]);

function isAllowedOrigin(origin: string | undefined, allowed: string[]): boolean {
  if (!origin) return false;
  return allowed.some((a) => origin === a || origin.startsWith(a));
}

function getAllowedOrigins(): string[] {
  return process.env.CSRF_ALLOWED_ORIGINS
    ? process.env.CSRF_ALLOWED_ORIGINS.split(",").map((s) => s.trim())
    : DEFAULT_ALLOWED;
}

function isAdminPath(path: string): boolean {
  return path.startsWith("/api/admin/");
}

function originGuard(req: Request, res: Response, next: NextFunction): void {
  if (req.method === "GET" || req.method === "HEAD" || req.method === "OPTIONS") return next();
  if (!req.path.startsWith("/api/")) return next();

  // Whitelist: webhook'и от внешних сервисов
  if (WEBHOOK_PATHS.has(req.path)) return next();

  const allowed = getAllowedOrigins();
  const origin = req.get("origin");
  const referer = req.get("referer");

  const originOk = origin && isAllowedOrigin(origin, allowed);
  const refererOk = referer && isAllowedOrigin(referer, allowed);

  if (originOk || refererOk) return next();

  // Strict-mode для admin endpoints — блокируем без warn.
  if (isAdminPath(req.path)) {
    console.warn(`[security-guard] BLOCKED admin request — untrusted origin`, {
      method: req.method,
      path: req.path,
      origin: origin ?? null,
      referer: referer ?? null,
      ip: req.ip,
    });
    res.status(403).json({ data: null, error: "forbidden: untrusted origin" });
    return;
  }

  // Для не-admin /api/* — пока WARN-режим (по плану Sprint 8, после
  // 1 недели наблюдений снимем и для них тоже).
  console.warn(`[security-guard] suspicious request without trusted origin`, {
    method: req.method,
    path: req.path,
    origin: origin ?? null,
    referer: referer ?? null,
    ua: req.get("user-agent")?.slice(0, 80),
  });
  return next();
}

function streamIdGuard(req: Request, res: Response, next: NextFunction): void {
  if (!req.path.startsWith("/api/stream/") && !req.path.startsWith("/api/cover/")) return next();
  // Извлекаем сегмент после /stream/ или /cover/
  const m = req.path.match(/^\/api\/(stream|cover)\/([^/]+)/);
  if (!m) return next();
  const id = m[2].replace(/\.(jpg|webp|png|mp3)$/i, "");
  if (!/^\d+$/.test(id)) {
    res.status(400).json({ data: null, error: "invalid id" });
    return;
  }
  next();
}

// === Per-IP rate limit for /api/admin/v304/* ===
// 60 requests / minute / IP. In-memory sliding window, sufficient for
// single-process pm2. TTL cleanup каждые 5 минут.

const ADMIN_RL_MAX = Number(process.env.ADMIN_RATE_LIMIT_MAX || 60);
const ADMIN_RL_WINDOW_MS = Number(process.env.ADMIN_RATE_LIMIT_WINDOW_MS || 60_000);

interface RateEntry {
  count: number;
  resetAt: number;
}

const adminRateMap = new Map<string, RateEntry>();

function adminRateGuard(req: Request, res: Response, next: NextFunction): void {
  if (!req.path.startsWith("/api/admin/")) return next();
  const ip = (req.ip || (req.headers["x-forwarded-for"] as string) || "unknown").toString();
  const now = Date.now();
  let entry = adminRateMap.get(ip);
  if (!entry || now > entry.resetAt) {
    entry = { count: 1, resetAt: now + ADMIN_RL_WINDOW_MS };
    adminRateMap.set(ip, entry);
    return next();
  }
  entry.count += 1;
  if (entry.count > ADMIN_RL_MAX) {
    console.warn(`[security-guard] admin rate-limit hit`, {
      ip,
      path: req.path,
      count: entry.count,
    });
    res.status(429).json({
      data: null,
      error: `rate-limit: ${ADMIN_RL_MAX} admin requests per ${Math.round(ADMIN_RL_WINDOW_MS / 1000)}s`,
    });
    return;
  }
  return next();
}

// Cleanup expired admin rate entries every 5 min.
setInterval(() => {
  const now = Date.now();
  for (const [ip, e] of adminRateMap) {
    if (now > e.resetAt) adminRateMap.delete(ip);
  }
}, 5 * 60_000).unref();

// === Block direct-IP access ===
// Если Host header — IPv4/IPv6 адрес (а не доменное имя) и path — не webhook,
// → 403. Webhook'и от Robokassa могут приходить с Host=IP (для них whitelisted).

const IP_HOST_RE = /^(\d{1,3}\.){3}\d{1,3}(:\d+)?$/;
const IPV6_HOST_RE = /^\[[0-9a-fA-F:]+\](:\d+)?$/;

function directIpGuard(req: Request, res: Response, next: NextFunction): void {
  // Только для /api/* — статика и SPA должна работать с direct-IP (для health-check internal).
  if (!req.path.startsWith("/api/")) return next();
  // Webhook'и могут прилетать на IP (legacy провайдеры).
  if (WEBHOOK_PATHS.has(req.path)) return next();
  // Health-check разрешаем (для localhost-проб от nginx/auto-deploy).
  if (req.path === "/api/example/ping" || req.path === "/api/health") return next();

  const hostHeader = (req.get("host") || "").trim().toLowerCase();
  if (!hostHeader) return next();

  if (IP_HOST_RE.test(hostHeader) || IPV6_HOST_RE.test(hostHeader)) {
    // Дополнительный allowlist для localhost — internal probes.
    if (
      hostHeader.startsWith("127.0.0.1") ||
      hostHeader.startsWith("localhost") ||
      hostHeader.startsWith("[::1]")
    ) {
      return next();
    }
    console.warn(`[security-guard] BLOCKED direct-IP access`, {
      host: hostHeader,
      path: req.path,
      ip: req.ip,
    });
    res.status(403).json({ data: null, error: "forbidden: direct-IP access" });
    return;
  }
  return next();
}

const securityGuardModule: Module = {
  name: "security-guard",
  version: "0.2.0",
  description:
    "Sprint 8 hardening — strict CSRF for /api/admin/*, per-IP admin rate-limit, direct-IP block, stream-id path-traversal guard.",
  publishes: [],
  onLoad: async (ctx) => {
    // Порядок:
    //   1) directIpGuard — раннее отсечение Host=IP
    //   2) streamIdGuard — проверка path-traversal в stream/cover
    //   3) adminRateGuard — counts per-IP до origin-проверки
    //   4) originGuard — CSRF (strict для admin, warn для остальных)
    ctx.app.use(directIpGuard);
    ctx.app.use(streamIdGuard);
    ctx.app.use(adminRateGuard);
    ctx.app.use(originGuard);
    ctx.logger.info(
      "security-guard online (direct-IP + admin-rate + strict-CSRF-admin + stream-id guards)",
    );
  },
  healthCheck: () => ({ status: "ok" }),
};

export default securityGuardModule;

// === Public API for failed-login tracking ===
// Login handlers вызывают `recordFailedLogin(ip)` после неверного пароля.
// `isLoginIpLocked(ip)` возвращает true если 5+ failed за 15 мин — handler
// должен вернуть 429.

const LOGIN_FAIL_MAX = Number(process.env.LOGIN_FAIL_MAX || 5);
const LOGIN_FAIL_WINDOW_MS = Number(process.env.LOGIN_FAIL_WINDOW_MS || 15 * 60_000);

const loginFailMap = new Map<string, { count: number; resetAt: number }>();

export function recordFailedLogin(ip: string): void {
  const now = Date.now();
  let e = loginFailMap.get(ip);
  if (!e || now > e.resetAt) {
    e = { count: 1, resetAt: now + LOGIN_FAIL_WINDOW_MS };
    loginFailMap.set(ip, e);
    return;
  }
  e.count += 1;
}

export function isLoginIpLocked(ip: string): boolean {
  const e = loginFailMap.get(ip);
  if (!e) return false;
  if (Date.now() > e.resetAt) {
    loginFailMap.delete(ip);
    return false;
  }
  return e.count >= LOGIN_FAIL_MAX;
}

export function clearFailedLogin(ip: string): void {
  loginFailMap.delete(ip);
}

// Cleanup expired login-fail entries every 10 min.
setInterval(() => {
  const now = Date.now();
  for (const [ip, e] of loginFailMap) {
    if (now > e.resetAt) loginFailMap.delete(ip);
  }
}, 10 * 60_000).unref();
