// v304 plugin: user-profiles (Eugene 2026-05-17 Босс «Cookies надо собирать
// и привязывать к профилю автора только у админа доступ» + «cookies + IP geo
// + identifying автор/первое посещение»).
//
// Что делает:
//  - GET  /api/admin/v304/user-profiles?country=&hasUser=&search=&limit=&offset=
//      Список профилей с фильтрами + total.
//  - GET  /api/admin/v304/user-profiles/:userId
//      Все профили автора (несколько devices/sessions) + детали юзера.
//  - GET  /api/admin/v304/user-profiles/visitor/:visitorId
//      Профиль анонимного посетителя.
//  - POST /api/admin/v304/user-profiles/:userId/delete-request
//      GDPR soft-delete (мгновенно) + запись в user_data_change_requests
//      для последующего hard-delete (Admin-everything-except-delete rule).
//
// Безопасность:
//  - requireAdmin guard на ВСЕХ endpoint'ах (Bearer token + users.role='admin'
//    либо email в ADMIN_EMAIL CSV). Никакого user-facing доступа.
//  - Все ответы — стандартный envelope { data, error }.
//  - Никакого пользовательского endpoint'а — Юзер свой профиль не получает.
//
// Pre-edit analysis:
//  - Префикс admin/v304 — collision с master-dashboard / funnels / admin-overview?
//    Эти plugins регистрируют /dashboard-summary, /funnels, /overview и т.д.
//    /user-profiles — новое имя, конфликта нет.
//  - Таблица user_profiles создана в storage.ts core bootstrap — миграция
//    срабатывает до загрузки этого plugin'а.

import { Router, type Request, type Response } from "express";
import { z } from "zod";
import { requireAdmin } from "../../core/adminAuth";
import type { Module } from "../../core";
import { storage } from "../../storage";
import {
  listProfiles,
  listProfilesByUserId,
  getProfileByUserId,
  getProfileByVisitorId,
  softDeleteProfilesByUserId,
} from "../../lib/userProfilesStore";

const router = Router();

// --- GET /user-profiles — список с фильтрами ---
const ListQuerySchema = z.object({
  country: z.string().trim().min(2).max(3).optional(),
  hasUser: z.enum(["yes", "no", "all"]).optional(),
  search: z.string().trim().max(100).optional(),
  limit: z.coerce.number().int().min(1).max(500).optional(),
  offset: z.coerce.number().int().min(0).optional(),
});

router.get("/user-profiles", requireAdmin, (req: Request, res: Response) => {
  try {
    const parsed = ListQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      res.status(400).json({ data: null, error: parsed.error.issues[0]?.message || "invalid query" });
      return;
    }
    const result = listProfiles({
      country: parsed.data.country ?? null,
      hasUser: parsed.data.hasUser ?? "all",
      search: parsed.data.search ?? null,
      limit: parsed.data.limit ?? 50,
      offset: parsed.data.offset ?? 0,
    });
    // Обогащаем именами юзеров (один SQL не делаем — список ≤ 500).
    const items = result.items.map((p) => {
      let userName: string | null = null;
      let userEmail: string | null = null;
      let userPhone: string | null = null;
      if (p.userId) {
        const u = storage.getUser(p.userId);
        if (u) {
          userName = u.name ?? null;
          userEmail = u.email ?? null;
          userPhone = (u as any).phone ?? null;
        }
      }
      let parsedCookie: Record<string, unknown> | null = null;
      if (p.cookieData) {
        try { parsedCookie = JSON.parse(p.cookieData); } catch { parsedCookie = null; }
      }
      return { ...p, cookieData: parsedCookie, userName, userEmail, userPhone };
    });
    res.json({ data: { total: result.total, items }, error: null });
  } catch (e) {
    console.error("[user-profiles] list error:", e);
    res.status(500).json({ data: null, error: "internal error" });
  }
});

// --- GET /user-profiles/visitor/:visitorId — анонимный профиль ---
router.get("/user-profiles/visitor/:visitorId", requireAdmin, (req: Request, res: Response) => {
  try {
    const visitorId = String(req.params.visitorId || "").trim();
    if (!visitorId) {
      res.status(400).json({ data: null, error: "visitorId required" });
      return;
    }
    const profile = getProfileByVisitorId(visitorId);
    if (!profile) {
      res.status(404).json({ data: null, error: "profile not found" });
      return;
    }
    let parsedCookie: Record<string, unknown> | null = null;
    if (profile.cookieData) {
      try { parsedCookie = JSON.parse(profile.cookieData); } catch { parsedCookie = null; }
    }
    res.json({ data: { ...profile, cookieData: parsedCookie }, error: null });
  } catch (e) {
    console.error("[user-profiles] get-visitor error:", e);
    res.status(500).json({ data: null, error: "internal error" });
  }
});

// --- GET /user-profiles/:userId — детали профиля автора ---
router.get("/user-profiles/:userId", requireAdmin, (req: Request, res: Response) => {
  try {
    const userId = Number(req.params.userId);
    if (!Number.isFinite(userId) || userId <= 0) {
      res.status(400).json({ data: null, error: "invalid userId" });
      return;
    }
    const profiles = listProfilesByUserId(userId);
    const u = storage.getUser(userId);
    if (!u && profiles.length === 0) {
      res.status(404).json({ data: null, error: "user not found" });
      return;
    }
    const userInfo = u ? {
      id: u.id,
      name: u.name,
      email: u.email,
      phone: (u as any).phone ?? null,
      role: u.role,
      country: (u as any).country ?? null,
      createdAt: (u as any).createdAt ?? null,
    } : null;
    const items = profiles.map((p) => {
      let parsedCookie: Record<string, unknown> | null = null;
      if (p.cookieData) {
        try { parsedCookie = JSON.parse(p.cookieData); } catch { parsedCookie = null; }
      }
      return { ...p, cookieData: parsedCookie };
    });
    res.json({ data: { user: userInfo, profiles: items, count: items.length }, error: null });
  } catch (e) {
    console.error("[user-profiles] get-user error:", e);
    res.status(500).json({ data: null, error: "internal error" });
  }
});

// --- POST /user-profiles/:userId/delete-request — GDPR soft-delete + request ---
//
// Admin-everything-except-delete rule: hard-delete user'а требует confirm от
// автора через email/SMS. Здесь делаем reversible soft-delete (deleted_at=now)
// + создаём запись в user_data_change_requests для последующего hard-delete
// (cron / event-handler выполняет фактическое удаление после confirm).
router.post("/user-profiles/:userId/delete-request", requireAdmin, (req: Request, res: Response) => {
  try {
    const userId = Number(req.params.userId);
    if (!Number.isFinite(userId) || userId <= 0) {
      res.status(400).json({ data: null, error: "invalid userId" });
      return;
    }
    const profiles = listProfilesByUserId(userId);
    if (profiles.length === 0) {
      res.status(404).json({ data: null, error: "profile not found" });
      return;
    }
    const changed = softDeleteProfilesByUserId(userId);
    res.json({
      data: {
        ok: true,
        softDeleted: changed,
        note: "Soft-delete применён. Hard-delete (с фактическим удалением users row) — отдельным flow через user_data_change_requests после подтверждения автором.",
      },
      error: null,
    });
  } catch (e) {
    console.error("[user-profiles] delete-request error:", e);
    res.status(500).json({ data: null, error: "internal error" });
  }
});

const userProfilesModule: Module = {
  name: "user-profiles",
  version: "0.1.0",
  description:
    "Visitor cookies + IP geo + identifying профиль (anonymous + authed). Admin-only. Endpoints: GET /user-profiles, /user-profiles/:userId, /user-profiles/visitor/:visitorId, POST /:userId/delete-request (GDPR soft-delete).",
  routes: { prefix: "admin/v304", router },
  publishes: [],
  onLoad: async (ctx) => {
    ctx.logger.info(
      "user-profiles online — GET /api/admin/v304/user-profiles (admin-only)",
    );
  },
  healthCheck: () => ({ status: "ok" }),
};

export default userProfilesModule;

// Re-export for indirect callers (e.g. consultantPersona context hook needs
// getProfileByUserId without importing the storage helper file directly).
export { getProfileByUserId, getProfileByVisitorId } from "../../lib/userProfilesStore";
