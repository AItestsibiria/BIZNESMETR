// Eugene 2026-05-17 Босс «Cookies надо собирать и привязывать к профилю
// автора только у админа доступ». Helper для visitor cookie (mzv).
//
// Cookie `mzv` — UUID v4 fingerprint визитёра. HttpOnly, SameSite=Lax,
// Max-Age=10 лет. Используется как первичный ключ user_profiles.visitor_id.
//
// Express не имеет cookie-parser middleware в этом проекте — парсим
// руками из `Cookie` header. Это безопасно для одного нужного нам ключа.

import type { Request, Response } from "express";
import crypto from "node:crypto";

const COOKIE_NAME = "mzv";
const TEN_YEARS_SEC = 60 * 60 * 24 * 365 * 10;

function parseCookieHeader(header: string | undefined): Record<string, string> {
  if (!header) return {};
  const out: Record<string, string> = {};
  for (const part of header.split(";")) {
    const [k, ...rest] = part.split("=");
    const key = k?.trim();
    if (!key) continue;
    const val = rest.join("=").trim();
    try {
      out[key] = decodeURIComponent(val);
    } catch {
      out[key] = val;
    }
  }
  return out;
}

export function readVisitorId(req: Request): string | null {
  const cookies = parseCookieHeader(req.headers.cookie as string | undefined);
  const v = cookies[COOKIE_NAME];
  return v && /^[a-zA-Z0-9_-]{8,64}$/.test(v) ? v : null;
}

/**
 * Прочитать `mzv` cookie. Если её нет / невалидна — сгенерировать новый UUID
 * и Set-Cookie. Возвращает visitorId (всегда строку).
 *
 * HttpOnly — JS не читает (защита от XSS-кражи cookie).
 * SameSite=Lax — отправляется при top-level navigation, не отправляется
 *                 в третьесторонних iframe (защита от CSRF + privacy).
 * Secure — только если HTTPS (auto через `X-Forwarded-Proto: https`).
 */
export function getOrCreateVisitorId(req: Request, res: Response): string {
  const existing = readVisitorId(req);
  if (existing) return existing;
  const id = crypto.randomUUID();
  const isHttps =
    req.secure ||
    String(req.headers["x-forwarded-proto"] || "").toLowerCase() === "https";
  const parts = [
    `${COOKIE_NAME}=${encodeURIComponent(id)}`,
    "Path=/",
    `Max-Age=${TEN_YEARS_SEC}`,
    "HttpOnly",
    "SameSite=Lax",
  ];
  if (isHttps) parts.push("Secure");
  // Не перетираем существующие Set-Cookie от auth-flow — append.
  const prev = res.getHeader("Set-Cookie");
  if (Array.isArray(prev)) {
    res.setHeader("Set-Cookie", [...prev, parts.join("; ")]);
  } else if (typeof prev === "string") {
    res.setHeader("Set-Cookie", [prev, parts.join("; ")]);
  } else {
    res.setHeader("Set-Cookie", parts.join("; "));
  }
  return id;
}
