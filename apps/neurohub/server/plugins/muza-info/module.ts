// v304 plugin: muza-info (Eugene 2026-05-23 Босс).
//
// Публичное меню «Информация о Музе» (что такое MuzaAi, как работает, цены,
// голоса, поддержка, …) + admin CMS для CRUD пунктов + загрузка файлов
// к каждому конкретному пункту меню (в том числе новым).
//
// Public:
//   GET    /api/info/sections              — список published sections (sorted)
//   GET    /api/info/sections/:slug        — single section by slug
//
// Admin (requireAdmin):
//   GET    /api/admin/v304/info/sections                   — все (включая draft)
//   POST   /api/admin/v304/info/sections                   — create
//   PUT    /api/admin/v304/info/sections/:id               — update
//   DELETE /api/admin/v304/info/sections/:id               — delete (+ файлы)
//   POST   /api/admin/v304/info/sections/:id/upload        — multipart upload
//   DELETE /api/admin/v304/info/sections/:id/files/:filename — remove file
//
// Файлы сохраняются в /var/www/neurohub/uploads/muza-info/<sectionId>-<uuid>.<ext>
// и доступны через /uploads/muza-info/<filename> (express.static в server/index.ts).
//
// Безопасность:
// - requireAdmin guard на всех admin-endpoints (Bearer token + role='admin').
// - Markdown санитизируется на client side через `marked` с safe-mode + DOM scrub
//   (см. components/muza-info-menu.tsx). Здесь храним plain markdown как ввёл админ.
// - File upload: max 10 MB, whitelist mime (image/* + pdf + audio/mpeg + video/mp4).

import { Router } from "express";
import multer from "multer";
import * as fs from "node:fs";
import * as path from "node:path";
import * as crypto from "node:crypto";
import { asc, eq } from "drizzle-orm";
import { z } from "zod";
import { db } from "../../storage";
import { muzaInfoSections } from "@shared/schema";
import { requireAdmin } from "../../core/adminAuth";
import type { Module } from "../../core/types";

const UPLOADS_DIR = process.env.UPLOADS_DIR || "/var/www/neurohub/uploads";
const FILES_DIR = path.join(UPLOADS_DIR, "muza-info");
const MAX_FILE_BYTES = 10 * 1024 * 1024; // 10 MB

const ALLOWED_MIME = new Set([
  "image/jpeg",
  "image/jpg",
  "image/png",
  "image/webp",
  "image/gif",
  "image/svg+xml",
  "application/pdf",
  "audio/mpeg",
  "audio/mp3",
  "audio/wav",
  "audio/x-wav",
  "video/mp4",
  "video/quicktime",
  "text/plain",
]);

const EXT_BY_MIME: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/jpg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
  "image/gif": "gif",
  "image/svg+xml": "svg",
  "application/pdf": "pdf",
  "audio/mpeg": "mp3",
  "audio/mp3": "mp3",
  "audio/wav": "wav",
  "audio/x-wav": "wav",
  "video/mp4": "mp4",
  "video/quicktime": "mov",
  "text/plain": "txt",
};

try {
  fs.mkdirSync(FILES_DIR, { recursive: true });
} catch {
  /* nginx или volume mount */
}

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_FILE_BYTES },
});

type Attachment = {
  filename: string;       // physical filename on disk
  originalName: string;   // original upload name (для отображения)
  url: string;            // /uploads/muza-info/<filename>
  size: number;
  mime: string;
  uploadedAt: number;     // millis
};

function parseAttachments(raw: string | null | undefined): Attachment[] {
  if (!raw) return [];
  try {
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? arr : [];
  } catch {
    return [];
  }
}

const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;

const CreateSchema = z.object({
  slug: z.string().regex(SLUG_RE, "slug: a-z, 0-9, дефис, до 64 символов"),
  title: z.string().trim().min(1).max(200),
  emoji: z.string().max(8).optional().nullable(),
  position: z.number().int().min(0).max(99_999).optional(),
  bodyMarkdown: z.string().max(50_000).optional(),
  isPublished: z.union([z.boolean(), z.number().int().min(0).max(1)]).optional(),
});

const UpdateSchema = CreateSchema.partial().omit({ slug: true });

function normalizeBool(v: unknown, fallback = 1): number {
  if (typeof v === "boolean") return v ? 1 : 0;
  if (typeof v === "number") return v ? 1 : 0;
  return fallback;
}

const router = Router();

// ============================================================
// Admin endpoints (mounted under /api/admin/v304)
// ============================================================

router.get("/info/sections", requireAdmin, (_req, res) => {
  try {
    const rows = db
      .select()
      .from(muzaInfoSections)
      .orderBy(asc(muzaInfoSections.position), asc(muzaInfoSections.id))
      .all();
    const data = rows.map((r) => ({
      ...r,
      attachments: parseAttachments(r.attachmentsJson),
    }));
    res.json({ data, error: null });
  } catch (err) {
    res
      .status(500)
      .json({ data: null, error: err instanceof Error ? err.message : "internal" });
  }
});

router.post("/info/sections", requireAdmin, (req, res) => {
  const parsed = CreateSchema.safeParse(req.body);
  if (!parsed.success) {
    return res
      .status(400)
      .json({ data: null, error: parsed.error.issues[0]?.message ?? "invalid" });
  }
  const t = parsed.data;
  try {
    // Check slug uniqueness
    const existing = db
      .select({ id: muzaInfoSections.id })
      .from(muzaInfoSections)
      .where(eq(muzaInfoSections.slug, t.slug))
      .get();
    if (existing) {
      return res
        .status(409)
        .json({ data: null, error: `Раздел с slug='${t.slug}' уже существует` });
    }
    const now = Date.now();
    const inserted = db
      .insert(muzaInfoSections)
      .values({
        slug: t.slug,
        title: t.title,
        emoji: t.emoji ?? null,
        position: t.position ?? 0,
        bodyMarkdown: t.bodyMarkdown ?? "",
        attachmentsJson: "[]",
        isPublished: normalizeBool(t.isPublished, 1),
        createdAt: now,
        updatedAt: now,
      } as any)
      .returning({ id: muzaInfoSections.id })
      .get();
    res.json({ data: { id: inserted.id, created: true }, error: null });
  } catch (err) {
    res
      .status(500)
      .json({ data: null, error: err instanceof Error ? err.message : "internal" });
  }
});

router.put("/info/sections/:id", requireAdmin, (req, res) => {
  const id = parseInt(String(req.params.id), 10);
  if (!Number.isFinite(id) || id <= 0) {
    return res.status(400).json({ data: null, error: "invalid id" });
  }
  const parsed = UpdateSchema.safeParse(req.body);
  if (!parsed.success) {
    return res
      .status(400)
      .json({ data: null, error: parsed.error.issues[0]?.message ?? "invalid" });
  }
  const t = parsed.data;
  try {
    const before = db.select().from(muzaInfoSections).where(eq(muzaInfoSections.id, id)).get();
    if (!before) {
      return res.status(404).json({ data: null, error: "not found" });
    }
    const patch: Record<string, unknown> = { updatedAt: Date.now() };
    if (t.title !== undefined) patch.title = t.title;
    if (t.emoji !== undefined) patch.emoji = t.emoji;
    if (t.position !== undefined) patch.position = t.position;
    if (t.bodyMarkdown !== undefined) patch.bodyMarkdown = t.bodyMarkdown;
    if (t.isPublished !== undefined) patch.isPublished = normalizeBool(t.isPublished, 1);
    db.update(muzaInfoSections)
      .set(patch as any)
      .where(eq(muzaInfoSections.id, id))
      .run();
    res.json({ data: { id, updated: true }, error: null });
  } catch (err) {
    res
      .status(500)
      .json({ data: null, error: err instanceof Error ? err.message : "internal" });
  }
});

router.delete("/info/sections/:id", requireAdmin, (req, res) => {
  const id = parseInt(String(req.params.id), 10);
  if (!Number.isFinite(id) || id <= 0) {
    return res.status(400).json({ data: null, error: "invalid id" });
  }
  try {
    const before = db.select().from(muzaInfoSections).where(eq(muzaInfoSections.id, id)).get();
    if (!before) {
      return res.status(404).json({ data: null, error: "not found" });
    }
    // Delete attached files from disk (best-effort)
    const atts = parseAttachments(before.attachmentsJson);
    for (const a of atts) {
      try {
        if (
          a.filename &&
          !a.filename.includes("..") &&
          !a.filename.includes("/")
        ) {
          fs.unlinkSync(path.join(FILES_DIR, a.filename));
        }
      } catch {
        /* файл уже удалён или nginx mount r/o */
      }
    }
    db.delete(muzaInfoSections).where(eq(muzaInfoSections.id, id)).run();
    res.json({ data: { id, deleted: true }, error: null });
  } catch (err) {
    res
      .status(500)
      .json({ data: null, error: err instanceof Error ? err.message : "internal" });
  }
});

router.post(
  "/info/sections/:id/upload",
  requireAdmin,
  upload.single("file"),
  (req, res) => {
    const id = parseInt(String(req.params.id), 10);
    if (!Number.isFinite(id) || id <= 0) {
      return res.status(400).json({ data: null, error: "invalid id" });
    }
    const file = (req as any).file as Express.Multer.File | undefined;
    if (!file) {
      return res
        .status(400)
        .json({ data: null, error: "Файл не получен (поле 'file')" });
    }
    const baseMime = file.mimetype.split(";")[0].trim().toLowerCase();
    if (!ALLOWED_MIME.has(baseMime)) {
      return res.status(415).json({
        data: null,
        error: `Формат не поддерживается: ${file.mimetype}. Разрешены: jpg/png/webp/gif/svg/pdf/mp3/wav/mp4/mov/txt.`,
      });
    }
    if (file.size > MAX_FILE_BYTES) {
      return res
        .status(413)
        .json({ data: null, error: `Файл больше ${MAX_FILE_BYTES / 1024 / 1024} MB` });
    }
    if (file.size < 8) {
      return res
        .status(400)
        .json({ data: null, error: "Файл подозрительно маленький" });
    }
    try {
      const section = db
        .select()
        .from(muzaInfoSections)
        .where(eq(muzaInfoSections.id, id))
        .get();
      if (!section) {
        return res.status(404).json({ data: null, error: "Раздел не найден" });
      }
      const ext = EXT_BY_MIME[baseMime] || "bin";
      const uuid = crypto.randomUUID().replace(/-/g, "").slice(0, 16);
      const filename = `${id}-${uuid}.${ext}`;
      const full = path.join(FILES_DIR, filename);
      fs.writeFileSync(full, file.buffer);
      try {
        fs.chmodSync(full, 0o644);
      } catch {
        /* best-effort */
      }
      const attachment: Attachment = {
        filename,
        originalName: file.originalname || filename,
        url: `/uploads/muza-info/${filename}`,
        size: file.size,
        mime: baseMime,
        uploadedAt: Date.now(),
      };
      const atts = parseAttachments(section.attachmentsJson);
      atts.push(attachment);
      db.update(muzaInfoSections)
        .set({
          attachmentsJson: JSON.stringify(atts),
          updatedAt: Date.now(),
        } as any)
        .where(eq(muzaInfoSections.id, id))
        .run();
      res.json({ data: attachment, error: null });
    } catch (err) {
      res
        .status(500)
        .json({ data: null, error: err instanceof Error ? err.message : "internal" });
    }
  },
);

router.delete(
  "/info/sections/:id/files/:filename",
  requireAdmin,
  (req, res) => {
    const id = parseInt(String(req.params.id), 10);
    const filename = String(req.params.filename || "");
    if (!Number.isFinite(id) || id <= 0) {
      return res.status(400).json({ data: null, error: "invalid id" });
    }
    if (!filename || filename.includes("..") || filename.includes("/")) {
      return res.status(400).json({ data: null, error: "invalid filename" });
    }
    try {
      const section = db
        .select()
        .from(muzaInfoSections)
        .where(eq(muzaInfoSections.id, id))
        .get();
      if (!section) {
        return res.status(404).json({ data: null, error: "not found" });
      }
      const atts = parseAttachments(section.attachmentsJson);
      const idx = atts.findIndex((a) => a.filename === filename);
      if (idx < 0) {
        return res.status(404).json({ data: null, error: "файл не найден в разделе" });
      }
      atts.splice(idx, 1);
      try {
        fs.unlinkSync(path.join(FILES_DIR, filename));
      } catch {
        /* файл уже удалён */
      }
      db.update(muzaInfoSections)
        .set({
          attachmentsJson: JSON.stringify(atts),
          updatedAt: Date.now(),
        } as any)
        .where(eq(muzaInfoSections.id, id))
        .run();
      res.json({ data: { deleted: true, filename }, error: null });
    } catch (err) {
      res
        .status(500)
        .json({ data: null, error: err instanceof Error ? err.message : "internal" });
    }
  },
);

// ============================================================
// Public endpoints (mounted under /api)
// ============================================================

const publicRouter = Router();

publicRouter.get("/info/sections", (_req, res) => {
  try {
    const rows = db
      .select()
      .from(muzaInfoSections)
      .where(eq(muzaInfoSections.isPublished, 1))
      .orderBy(asc(muzaInfoSections.position), asc(muzaInfoSections.id))
      .all();
    const data = rows.map((r) => ({
      id: r.id,
      slug: r.slug,
      title: r.title,
      emoji: r.emoji,
      position: r.position,
      bodyMarkdown: r.bodyMarkdown,
      attachments: parseAttachments(r.attachmentsJson),
    }));
    res.json({ data, error: null });
  } catch (err) {
    res
      .status(500)
      .json({ data: null, error: err instanceof Error ? err.message : "internal" });
  }
});

publicRouter.get("/info/sections/:slug", (req, res) => {
  const slug = String(req.params.slug || "").trim();
  if (!slug) {
    return res.status(400).json({ data: null, error: "invalid slug" });
  }
  try {
    const row = db
      .select()
      .from(muzaInfoSections)
      .where(eq(muzaInfoSections.slug, slug))
      .get();
    if (!row || !row.isPublished) {
      return res.status(404).json({ data: null, error: "not found" });
    }
    res.json({
      data: {
        id: row.id,
        slug: row.slug,
        title: row.title,
        emoji: row.emoji,
        bodyMarkdown: row.bodyMarkdown,
        attachments: parseAttachments(row.attachmentsJson),
      },
      error: null,
    });
  } catch (err) {
    res
      .status(500)
      .json({ data: null, error: err instanceof Error ? err.message : "internal" });
  }
});

// ============================================================
// Composite router — admin под /api/admin/v304, public под /api
// ============================================================

const rootRouter = Router();
rootRouter.use("/admin/v304", router);
rootRouter.use("/", publicRouter);

const muzaInfoModule: Module = {
  name: "muza-info",
  version: "0.1.0",
  description:
    "Публичные разделы «Информация о Музе» + admin CMS + загрузка файлов к разделам.",
  routes: { prefix: "", router: rootRouter },
  publishes: [],
  onLoad: async (ctx) => {
    try {
      fs.mkdirSync(FILES_DIR, { recursive: true });
    } catch {
      /* nginx volume mount */
    }
    ctx.logger.info(
      "muza-info online — /api/info/sections (public), /api/admin/v304/info/sections (admin)",
    );
  },
  healthCheck: () => ({ status: "ok" }),
};

export default muzaInfoModule;
