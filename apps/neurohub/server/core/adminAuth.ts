// Единый guard для admin-эндпоинтов v304.
// ТЗ Eugene 2026-05-07:
//   1) Bearer token из таблицы sessions → user_id.
//   2) Admin = users.role = 'admin' (первый чек).
//   3) Fallback = email в ADMIN_EMAIL CSV (env), default egnovoselov@gmail.com.
//   4) Без токена → 401, не админ → 403, админ → next() + req.adminUser/userId.
//
// Bootstrap-миграция (вызывается из server/index.ts один раз):
// для каждого email из ADMIN_EMAIL находим юзера и ставим role='admin',
// если ещё не стоит. Идемпотентно.

import { sql, eq } from "drizzle-orm";
import { db } from "../storage";
import { users } from "@shared/schema";
import type { User } from "@shared/schema";
import { isAdminTrustedIp, getTrustedIpList } from "../lib/adminTrustedIp";

export const ADMIN_EMAILS: Set<string> = new Set(
  (process.env.ADMIN_EMAIL || "egnovoselov@gmail.com")
    .split(",")
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean),
);

export function getUserIdFromBearer(req: any): number | null {
  const authHeader = req?.headers?.authorization;
  let token: string | undefined;
  if (typeof authHeader === "string" && authHeader.startsWith("Bearer ")) {
    token = authHeader.slice(7);
  } else if (typeof req?.query?.token === "string") {
    token = req.query.token;
  }
  if (!token) return null;
  try {
    const row = db.get<{ userId: number }>(
      sql`SELECT user_id as userId FROM sessions WHERE token = ${token} LIMIT 1`,
    );
    return row?.userId ?? null;
  } catch {
    return null;
  }
}

export function isAdminUser(u: Pick<User, "role" | "email"> | null | undefined): boolean {
  if (!u) return false;
  // 1) роль в БД (приоритет). Eugene 2026-05-20 (backend-audit fix):
  // распознаём И "admin" И "super_admin" — раньше строгое === "admin"
  // отвергало super_admin'ов → requireAdmin отдавал 403 silent.
  const role = ((u as any).role ?? "").toString().toLowerCase();
  if (role === "admin" || role === "super_admin") return true;
  // 2) email-whitelist (env override / legacy)
  return ADMIN_EMAILS.has(((u as any).email ?? "").toString().toLowerCase());
}

export function requireAdmin(req: any, res: any, next: any): void {
  const userId = getUserIdFromBearer(req);
  if (!userId) {
    res.status(401).json({ data: null, error: "unauthorized" });
    return;
  }
  const u = db.select().from(users).where(eq(users.id, userId)).get();
  if (!u) {
    res.status(401).json({ data: null, error: "user not found" });
    return;
  }
  if (!isAdminUser(u as any)) {
    res.status(403).json({ data: null, error: "forbidden" });
    return;
  }
  // Eugene 2026-05-25 Босс «админ-управление только через мои IP + через бот».
  // IP-гейт: если ADMIN_TRUSTED_IPS задан (non-empty) — web-админка доступна
  // ТОЛЬКО с этих IP. Бот (Telegram/Max admin) идёт своим путём (ADMIN_TELEGRAM_ID),
  // не через requireAdmin → не затронут. Safe default: список пуст → НЕ блокируем
  // (иначе закрыли бы доступ себе до настройки на VPS).
  if (getTrustedIpList().length > 0 && !isAdminTrustedIp(req)) {
    const ip = String(req.ip || req.headers["x-forwarded-for"] || "?").split(",")[0].trim();
    console.warn(`[ADMIN-IP-GATE] заблокирован admin-доступ с недоверенного IP: ${ip}`);
    res.status(403).json({ data: null, error: "admin access restricted to trusted IPs" });
    return;
  }
  (req as any).userId = userId;
  (req as any).adminUser = u;
  next();
}

// Bootstrap: при старте процесса даём role='admin' всем email'ам из
// ADMIN_EMAIL, кто уже зарегистрирован. Идемпотентно (UPDATE WHERE).
// Возвращает сколько строк обновили — для логов.
export function bootstrapAdminRoles(): { promoted: number; skipped: number } {
  let promoted = 0, skipped = 0;
  for (const email of ADMIN_EMAILS) {
    try {
      const u = db.select().from(users).where(eq(users.email, email)).get();
      if (!u) { skipped += 1; continue; }
      if ((u.role ?? "").toLowerCase() === "admin") { skipped += 1; continue; }
      db.update(users).set({ role: "admin" }).where(eq(users.id, u.id)).run();
      promoted += 1;
    } catch {
      skipped += 1;
    }
  }
  return { promoted, skipped };
}
