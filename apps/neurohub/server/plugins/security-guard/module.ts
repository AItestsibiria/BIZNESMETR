// Security guard plugin (Sprint 8).
//
// 1. Origin/Referer CSRF guard — для всех non-GET /api/* запросов
//    проверяем, что Origin или Referer совпадают с разрешённым доменом.
//    Разрешённые домены: clone.muziai.ru, podaripesnu.ru, muziai.ru
//    + любой *.localhost для dev. Список можно расширить через env
//    CSRF_ALLOWED_ORIGINS (запятая-разделитель).
//    Webhook'и, которые приходят без Origin (Robokassa, Telegram callback,
//    VK callback), допускаются по white-list path'ов.
//
// 2. Path traversal — middleware на /api/stream/:id и /api/cover/:id
//    проверяет что :id — целое число (а не "../../etc/passwd"). v51
//    использует parseInt без guard'ов, мы добавляем явный.
//
// Spec: docs/strategy/original/01 §1.4, 07 §2 (Sprint 8).

import type { NextFunction, Request, Response } from "express";
import type { Module } from "../../core";

const DEFAULT_ALLOWED = [
  // Eugene 2026-05-15: новый primary домен MuzaAi.ru (rebrand muziai → muzaai)
  "https://muzaai.ru",
  "https://www.muzaai.ru",
  // Старый домен — для backward compat (юзер на muziai.ru делает API call
  // ДО того как nginx 301 redirect'нул)
  "https://clone.muziai.ru",
  "https://muziai.ru",
  "https://www.muziai.ru",
  "https://podaripesnu.ru",
  "https://www.podaripesnu.ru",
  "http://127.0.0.1:5000",
  "http://localhost:5000",
  "http://localhost:5173",
];

// Webhook'и от внешних провайдеров — приходят без Origin/Referer.
const WEBHOOK_PATHS = new Set<string>([
  "/api/payment/result",   // Robokassa
  "/api/payment/success",
  "/api/payment/fail",
  "/api/telegram/webhook", // когда подключим (S6)
  "/api/vk/webhook",       // когда подключим (S7)
]);

function isAllowedOrigin(origin: string | undefined, allowed: string[]): boolean {
  if (!origin) return false;
  // Eugene 2026-05-16 Стратег-Критик аудит #8: startsWith → exact match.
  // Раньше `origin.startsWith("https://muzaai.ru")` пропускал
  // `https://muzaai.ru.evil.com` → CSRF possible. Только exact equality.
  return allowed.some((a) => origin === a);
}

function originGuard(req: Request, res: Response, next: NextFunction): void {
  if (req.method === "GET" || req.method === "HEAD" || req.method === "OPTIONS") return next();
  if (!req.path.startsWith("/api/")) return next();

  // Whitelist: webhook'и от внешних сервисов
  if (WEBHOOK_PATHS.has(req.path)) return next();

  const allowed = process.env.CSRF_ALLOWED_ORIGINS
    ? process.env.CSRF_ALLOWED_ORIGINS.split(",").map((s) => s.trim())
    : DEFAULT_ALLOWED;

  const origin = req.get("origin");
  const referer = req.get("referer");

  if (origin && isAllowedOrigin(origin, allowed)) return next();
  if (referer && isAllowedOrigin(referer, allowed)) return next();

  // Не блокируем строго пока что — режим WARN: пишем в лог и пропускаем,
  // чтобы не сломать legitimate trafic если найдутся честные пути,
  // которые мы не учли. После 1 недели наблюдений снимем WARN-режим.
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

const securityGuardModule: Module = {
  name: "security-guard",
  version: "0.1.0",
  description: "Sprint 8 hardening — Origin/Referer CSRF guard + path-traversal id guard.",
  publishes: [],
  onLoad: async (ctx) => {
    // Порядок важен: streamIdGuard до originGuard для GET stream/cover
    // (тех, что не попадают в originGuard вообще из-за GET-skip, но
    // оставим порядок строгим на случай будущих POST stream-вариантов).
    ctx.app.use(streamIdGuard);
    ctx.app.use(originGuard);
    ctx.logger.info("security-guard online (origin guard + stream id guard)");
  },
  healthCheck: () => ({ status: "ok" }),
};

export default securityGuardModule;
