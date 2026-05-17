// v304 plugin: landing-cms (Eugene 2026-05-17 Босс).
//
// Admin CMS для управления контентом landing-страницы:
//   GET    /api/admin/v304/landing-news               — список всех (admin)
//   POST   /api/admin/v304/landing-news               — создать (admin)
//   PUT    /api/admin/v304/landing-news/:id           — обновить (admin)
//   DELETE /api/admin/v304/landing-news/:id           — удалить (admin)
//   POST   /api/admin/v304/landing-news/upload-icon   — загрузить иконку (admin, multipart)
//
// Public:
//   GET  /api/landing-news       — что юзер видит (isVisible=1, sorted)
//   POST /api/landing-news/:id/view — track просмотр (rate-limit 1/min по IP)
//
// Иконки сохраняются в /var/www/neurohub/uploads/landing-icons/<uuid>.<ext>
// (chmod 644, max 1MB, jpg/png/webp/svg). Body санитизируется regex (без
// внешних зависимостей — `sanitize-html` нет в проекте).
//
// Безопасность:
// - requireAdmin guard на admin-эндпоинтах (Bearer token + role='admin').
// - HTML sanitizer удаляет <script>, on*=, javascript: ссылки.
// - View-counter защищён dedup по IP (in-memory Map с TTL 60 сек).

import { Router } from "express";
import multer from "multer";
import * as fs from "node:fs";
import * as path from "node:path";
import * as crypto from "node:crypto";
import { desc, eq, and, sql, asc } from "drizzle-orm";
import { z } from "zod";
import { db } from "../../storage";
import { landingNews } from "@shared/schema";
import { requireAdmin } from "../../core/adminAuth";
import type { Module } from "../../core";

const UPLOADS_DIR = process.env.UPLOADS_DIR || "/var/www/neurohub/uploads";
const ICONS_DIR = path.join(UPLOADS_DIR, "landing-icons");
const MAX_ICON_BYTES = 1 * 1024 * 1024; // 1 MB

const ALLOWED_ICON_MIME = new Set([
  "image/jpeg",
  "image/jpg",
  "image/png",
  "image/webp",
  "image/svg+xml",
]);
const EXT_BY_MIME: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/jpg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
  "image/svg+xml": "svg",
};

try {
  fs.mkdirSync(ICONS_DIR, { recursive: true });
} catch {
  /* nginx может создать каталог сам — не критично */
}

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_ICON_BYTES },
});

// In-memory dedup для public POST /landing-news/:id/view.
// Map<`${ip}::${newsId}`, expiresAtMs>. TTL = 60 сек.
// Чистка ленивая — при каждом обращении сверяем now() и удаляем протухшие.
const viewDedup = new Map<string, number>();
function isDupView(key: string): boolean {
  const now = Date.now();
  viewDedup.forEach((exp, k) => {
    if (exp <= now) viewDedup.delete(k);
  });
  const exp = viewDedup.get(key);
  if (exp && exp > now) return true;
  viewDedup.set(key, now + 60_000);
  // Жёсткий cap чтобы не разъехалось при boost-атаке.
  if (viewDedup.size > 5000) {
    const cutoff = now - 60_000;
    viewDedup.forEach((expVal, k) => {
      if (expVal <= cutoff) viewDedup.delete(k);
    });
  }
  return false;
}

// Лёгкая HTML-санитизация (sanitize-html нет в проекте). Удаляем:
//   - <script>…</script>
//   - <style>…</style> (потенциальная утечка CSS)
//   - on*-атрибуты (onclick, onerror, onload, …)
//   - javascript:/data: ссылки в href/src
//   - <iframe>, <object>, <embed>
function sanitizeHtml(raw: string): string {
  if (!raw) return "";
  let s = String(raw);
  s = s.replace(/<script\b[^>]*>[\s\S]*?<\/script\s*>/gi, "");
  s = s.replace(/<style\b[^>]*>[\s\S]*?<\/style\s*>/gi, "");
  s = s.replace(/<iframe\b[^>]*>[\s\S]*?<\/iframe\s*>/gi, "");
  s = s.replace(/<object\b[^>]*>[\s\S]*?<\/object\s*>/gi, "");
  s = s.replace(/<embed\b[^>]*\/?>(?:[\s\S]*?<\/embed\s*>)?/gi, "");
  s = s.replace(/\son[a-z]+\s*=\s*"[^"]*"/gi, "");
  s = s.replace(/\son[a-z]+\s*=\s*'[^']*'/gi, "");
  s = s.replace(/\son[a-z]+\s*=\s*[^\s>]+/gi, "");
  s = s.replace(/(href|src)\s*=\s*"\s*javascript:[^"]*"/gi, '$1="#"');
  s = s.replace(/(href|src)\s*=\s*'\s*javascript:[^']*'/gi, "$1='#'");
  return s;
}

function clientIp(req: any): string {
  const xff = req.headers?.["x-forwarded-for"];
  if (typeof xff === "string" && xff.length > 0) {
    return xff.split(",")[0].trim();
  }
  return (req.ip as string) || (req.socket?.remoteAddress as string) || "unknown";
}

const router = Router();

// ============================================================
// Admin endpoints
// ============================================================

const NewsCreateSchema = z.object({
  category: z.string().trim().min(1).max(64).default("main"),
  title: z.string().trim().min(1).max(500),
  bodyHtml: z.string().max(20_000),
  iconUrl: z.string().max(500).optional().nullable(),
  iconEmoji: z.string().max(16).optional().nullable(),
  ctaUrl: z.string().max(1000).optional().nullable(),
  ctaLabel: z.string().max(200).optional().nullable(),
  badgeColor: z.string().max(32).optional().nullable(),
  borderColor: z.string().max(32).optional().nullable(),
  publishedAt: z.string().max(50).optional().nullable(),
  sortOrder: z.number().int().optional(),
  isVisible: z.union([z.boolean(), z.number().int().min(0).max(1)]).optional(),
});

const NewsUpdateSchema = NewsCreateSchema.partial();

function normalizeVisible(v: unknown, fallback = 1): number {
  if (typeof v === "boolean") return v ? 1 : 0;
  if (typeof v === "number") return v ? 1 : 0;
  return fallback;
}

router.get("/landing-news", requireAdmin, (_req, res) => {
  try {
    const rows = db
      .select()
      .from(landingNews)
      .orderBy(asc(landingNews.category), desc(landingNews.sortOrder), desc(landingNews.id))
      .all();
    res.json({ data: rows, error: null });
  } catch (err) {
    res
      .status(500)
      .json({ data: null, error: err instanceof Error ? err.message : "internal" });
  }
});

router.post("/landing-news", requireAdmin, (req, res) => {
  const parsed = NewsCreateSchema.safeParse(req.body);
  if (!parsed.success) {
    return res
      .status(400)
      .json({ data: null, error: parsed.error.issues[0]?.message ?? "invalid" });
  }
  const t = parsed.data;
  try {
    const body = sanitizeHtml(t.bodyHtml);
    const now = new Date().toISOString();
    const inserted = db
      .insert(landingNews)
      .values({
        category: t.category,
        title: t.title,
        // legacy `body` дублируем для совместимости со старыми селектами.
        body,
        bodyHtml: body,
        iconUrl: t.iconUrl ?? null,
        iconEmoji: t.iconEmoji ?? null,
        ctaUrl: t.ctaUrl ?? null,
        ctaLabel: t.ctaLabel ?? null,
        badgeColor: t.badgeColor ?? "purple",
        borderColor: t.borderColor ?? "purple",
        publishedAt: t.publishedAt ?? null,
        sortOrder: t.sortOrder ?? 0,
        position: t.sortOrder ?? 0,
        active: normalizeVisible(t.isVisible, 1),
        isVisible: normalizeVisible(t.isVisible, 1),
        createdAt: now,
        updatedAt: now,
      } as any)
      .returning({ id: landingNews.id })
      .get();
    res.json({ data: { id: inserted.id, created: true }, error: null });
  } catch (err) {
    res
      .status(500)
      .json({ data: null, error: err instanceof Error ? err.message : "internal" });
  }
});

router.put("/landing-news/:id", requireAdmin, (req, res) => {
  const id = parseInt(String(req.params.id), 10);
  if (!Number.isFinite(id) || id <= 0) {
    return res.status(400).json({ data: null, error: "invalid id" });
  }
  const parsed = NewsUpdateSchema.safeParse(req.body);
  if (!parsed.success) {
    return res
      .status(400)
      .json({ data: null, error: parsed.error.issues[0]?.message ?? "invalid" });
  }
  const t = parsed.data;
  try {
    const before = db.select().from(landingNews).where(eq(landingNews.id, id)).get();
    if (!before) {
      return res.status(404).json({ data: null, error: "not found" });
    }
    const patch: Record<string, unknown> = { updatedAt: new Date().toISOString() };
    if (t.category !== undefined) patch.category = t.category;
    if (t.title !== undefined) patch.title = t.title;
    if (t.bodyHtml !== undefined) {
      const body = sanitizeHtml(t.bodyHtml);
      patch.bodyHtml = body;
      patch.body = body;
    }
    if (t.iconUrl !== undefined) patch.iconUrl = t.iconUrl;
    if (t.iconEmoji !== undefined) patch.iconEmoji = t.iconEmoji;
    if (t.ctaUrl !== undefined) patch.ctaUrl = t.ctaUrl;
    if (t.ctaLabel !== undefined) patch.ctaLabel = t.ctaLabel;
    if (t.badgeColor !== undefined) patch.badgeColor = t.badgeColor;
    if (t.borderColor !== undefined) patch.borderColor = t.borderColor;
    if (t.publishedAt !== undefined) patch.publishedAt = t.publishedAt;
    if (t.sortOrder !== undefined) {
      patch.sortOrder = t.sortOrder;
      patch.position = t.sortOrder;
    }
    if (t.isVisible !== undefined) {
      const v = normalizeVisible(t.isVisible, 1);
      patch.isVisible = v;
      patch.active = v;
    }
    db.update(landingNews)
      .set(patch as any)
      .where(eq(landingNews.id, id))
      .run();
    res.json({ data: { id, updated: true }, error: null });
  } catch (err) {
    res
      .status(500)
      .json({ data: null, error: err instanceof Error ? err.message : "internal" });
  }
});

router.delete("/landing-news/:id", requireAdmin, (req, res) => {
  const id = parseInt(String(req.params.id), 10);
  if (!Number.isFinite(id) || id <= 0) {
    return res.status(400).json({ data: null, error: "invalid id" });
  }
  try {
    const before = db.select().from(landingNews).where(eq(landingNews.id, id)).get();
    if (!before) {
      return res.status(404).json({ data: null, error: "not found" });
    }
    db.delete(landingNews).where(eq(landingNews.id, id)).run();
    // Удаляем загруженный icon-файл с диска (если он был внутри ICONS_DIR).
    try {
      const iconRel = (before as any).iconUrl as string | null | undefined;
      if (
        iconRel &&
        iconRel.startsWith("/uploads/landing-icons/") &&
        !iconRel.includes("..")
      ) {
        const fn = path.basename(iconRel);
        const full = path.join(ICONS_DIR, fn);
        try {
          fs.unlinkSync(full);
        } catch {
          /* файла может уже не быть */
        }
      }
    } catch {
      /* best-effort */
    }
    res.json({ data: { id, deleted: true }, error: null });
  } catch (err) {
    res
      .status(500)
      .json({ data: null, error: err instanceof Error ? err.message : "internal" });
  }
});

router.post(
  "/landing-news/upload-icon",
  requireAdmin,
  upload.single("icon"),
  (req, res) => {
    const file = (req as any).file as Express.Multer.File | undefined;
    if (!file) {
      return res
        .status(400)
        .json({ data: null, error: "Файл не получен (поле 'icon')" });
    }
    const baseMime = file.mimetype.split(";")[0].trim().toLowerCase();
    if (!ALLOWED_ICON_MIME.has(baseMime)) {
      return res.status(415).json({
        data: null,
        error: `Формат не поддерживается: ${file.mimetype}. Допустимо: jpg/png/webp/svg.`,
      });
    }
    if (file.size > MAX_ICON_BYTES) {
      return res
        .status(413)
        .json({ data: null, error: `Файл больше ${MAX_ICON_BYTES / 1024 / 1024} MB` });
    }
    if (file.size < 32) {
      return res
        .status(400)
        .json({ data: null, error: "Файл подозрительно маленький (< 32 байт)" });
    }
    try {
      const ext = EXT_BY_MIME[baseMime] || "bin";
      const id = crypto.randomUUID().replace(/-/g, "");
      const filename = `${id}.${ext}`;
      const full = path.join(ICONS_DIR, filename);
      fs.writeFileSync(full, file.buffer);
      try {
        fs.chmodSync(full, 0o644);
      } catch {
        /* best-effort, на проде nginx читает root */
      }
      const iconUrl = `/uploads/landing-icons/${filename}`;
      res.json({
        data: { iconUrl, size: file.size, mime: baseMime },
        error: null,
      });
    } catch (err) {
      res
        .status(500)
        .json({ data: null, error: err instanceof Error ? err.message : "internal" });
    }
  },
);

// ============================================================
// Public endpoints (registered on a separate prefix)
// ============================================================

const publicRouter = Router();

publicRouter.get("/landing-news", (req, res) => {
  try {
    const cat = typeof req.query.category === "string" ? req.query.category.trim() : "";
    let q = db
      .select()
      .from(landingNews)
      .where(eq(landingNews.isVisible, 1));
    if (cat) {
      q = db
        .select()
        .from(landingNews)
        .where(and(eq(landingNews.isVisible, 1), eq(landingNews.category, cat))) as any;
    }
    const rows = (q as any)
      .orderBy(asc(landingNews.category), desc(landingNews.sortOrder), desc(landingNews.publishedAt), desc(landingNews.id))
      .all();
    res.json({ data: rows, error: null });
  } catch (err) {
    res
      .status(500)
      .json({ data: null, error: err instanceof Error ? err.message : "internal" });
  }
});

publicRouter.post("/landing-news/:id/view", (req, res) => {
  const id = parseInt(String(req.params.id), 10);
  if (!Number.isFinite(id) || id <= 0) {
    return res.status(400).json({ data: null, error: "invalid id" });
  }
  try {
    const ip = clientIp(req);
    const key = `${ip}::${id}`;
    if (isDupView(key)) {
      return res.json({ data: { id, counted: false, reason: "dedup" }, error: null });
    }
    // Атомарный inc — не падаем если запись отсутствует.
    const result = db
      .update(landingNews)
      .set({ viewCount: sql`view_count + 1` })
      .where(eq(landingNews.id, id))
      .run();
    if (!result || (result as any).changes === 0) {
      return res.status(404).json({ data: null, error: "not found" });
    }
    res.json({ data: { id, counted: true }, error: null });
  } catch (err) {
    res
      .status(500)
      .json({ data: null, error: err instanceof Error ? err.message : "internal" });
  }
});

// Composite router monted under /api — admin под /api/admin/v304/landing-news,
// public под /api/landing-news + /api/landing-news/:id/view.
// Module API регистрирует ОДИН prefix, поэтому собираем два-в-одном на /api.
const rootRouter = Router();
rootRouter.use("/admin/v304", router);
rootRouter.use("/", publicRouter);

const landingCmsModule: Module = {
  name: "landing-cms",
  version: "0.1.0",
  description:
    "Admin CMS для редактирования новостей лендинга + публичный read + view-counter.",
  routes: { prefix: "", router: rootRouter },
  publishes: ["landing-news.viewed"],
  onLoad: async (ctx) => {
    try {
      fs.mkdirSync(ICONS_DIR, { recursive: true });
    } catch {
      /* nginx или volume mount */
    }
    ctx.logger.info(
      "landing-cms online — /api/admin/v304/landing-news (admin), /api/landing-news (public)",
    );
  },
  healthCheck: () => ({ status: "ok" }),
};

export default landingCmsModule;
