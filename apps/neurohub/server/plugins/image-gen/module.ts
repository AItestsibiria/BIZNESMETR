// v304 plugin: image-gen (Eugene 2026-05-18 Босс «admin-генератор изображений
// для разных задач компании: avatar / cover / banner / logo / product / custom»).
//
// Endpoints (все под requireAdmin):
//   POST   /api/admin/v304/images/generate        — сгенерировать + сохранить
//   GET    /api/admin/v304/images                 — список с фильтрами
//   GET    /api/admin/v304/images/:id             — детали одной записи
//   DELETE /api/admin/v304/images/:id             — soft-delete (archived=1)
//   POST   /api/admin/v304/images/:id/use-as      — применить (musa-avatar / cover-for-gen-NNN / banner)
//
// Storage:
//   - Файлы — в client/public/generated/{YYYY-MM-DD}/<preset>-<uid>.png
//   - БД — таблица generated_files (migration ниже)
//
// Безопасность:
//   - requireAdmin guard на всех endpoint'ах
//   - Секреты только через process.env (Never-leak-secrets rule)
//   - prompt длина обрезается на 4000 символов перед отправкой провайдерам
//
// Reuse-working-solutions rule: использует тот же GPTunnel→OpenAI fallback что
// существующий generateMusaAvatar3D (через общий lib/imageGenerator.ts).

import { Router } from "express";
import { sql } from "drizzle-orm";
import { z } from "zod";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { db } from "../../storage";
import { requireAdmin } from "../../core/adminAuth";
import {
  generateImage,
  estimateCostRub,
  type ImagePreset,
  type ImageSize,
  type GenerateImageResult,
} from "../../lib/imageGenerator";
import type { Module } from "../../core";

const router = Router();

const PRESET_VALUES = ["avatar", "cover", "banner", "logo", "product", "custom"] as const;
const SIZE_VALUES = ["1024x1024", "1792x1024", "1024x1792"] as const;
const USED_AS_PATTERN = /^(musa-avatar|cover-for-gen-\d+|banner-landing|logo-site|product-\d+|custom-[a-z0-9-]{1,40})$/i;

const GenerateSchema = z.object({
  prompt: z.string().min(4).max(4000),
  presetCategory: z.enum(PRESET_VALUES).optional(),
  refImageUrl: z.string().url().max(2000).nullable().optional(),
  refTrackId: z.number().int().positive().optional(),
  size: z.enum(SIZE_VALUES).optional(),
});

const UseAsSchema = z.object({
  usedAs: z.string().min(3).max(80),
});

// === Helpers ===

interface GeneratedFileRow {
  id: number;
  type: string;
  prompt: string;
  prompt_lang: string | null;
  file_path: string;
  file_size_bytes: number | null;
  width: number | null;
  height: number | null;
  provider: string | null;
  model: string | null;
  cost_estimate_rub: number | null;
  reference_track_id: number | null;
  reference_url: string | null;
  created_by_user_id: number | null;
  used_as: string | null;
  used_at: number | null;
  archived: number;
  created_at: number;
  meta_json: string | null;
}

function rowToApi(row: GeneratedFileRow) {
  let meta: unknown = null;
  if (row.meta_json) {
    try { meta = JSON.parse(row.meta_json); } catch { /* ignore */ }
  }
  return {
    id: row.id,
    type: row.type,
    prompt: row.prompt,
    promptLang: row.prompt_lang,
    fileUrl: row.file_path,
    fileSizeBytes: row.file_size_bytes,
    width: row.width,
    height: row.height,
    provider: row.provider,
    model: row.model,
    costEstimateRub: row.cost_estimate_rub,
    referenceTrackId: row.reference_track_id,
    referenceUrl: row.reference_url,
    createdByUserId: row.created_by_user_id,
    usedAs: row.used_as,
    usedAt: row.used_at,
    archived: row.archived === 1,
    createdAt: row.created_at,
    meta,
  };
}

async function resolveRefImageFromTrack(trackId: number): Promise<string | null> {
  try {
    const first = db.get<{ result_url: string | null; cover_gen_id: number | null; type: string | null }>(
      sql`SELECT result_url, cover_gen_id, type FROM generations WHERE id = ${trackId} LIMIT 1`,
    );
    if (!first) return null;
    if (first.cover_gen_id) {
      const cov = db.get<{ result_url: string | null }>(
        sql`SELECT result_url FROM generations WHERE id = ${first.cover_gen_id} LIMIT 1`,
      );
      if (cov?.result_url) return cov.result_url;
    }
    if (first.type === "cover" && first.result_url) return first.result_url;
    return null;
  } catch {
    return null;
  }
}

// === Endpoints ===

// POST /api/admin/v304/images/generate
router.post("/images/generate", requireAdmin, async (req: any, res) => {
  try {
    const parsed = GenerateSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      return res.status(400).json({
        data: null,
        error: "Невалидный body: " + parsed.error.issues.map((i) => i.message).join("; "),
      });
    }
    const { prompt, presetCategory, refImageUrl, refTrackId, size } = parsed.data;
    const preset: ImagePreset = presetCategory ?? "custom";

    let refUrl: string | null = refImageUrl ?? null;
    if (!refUrl && refTrackId) {
      refUrl = await resolveRefImageFromTrack(refTrackId);
    }

    const result: GenerateImageResult = await generateImage({
      prompt,
      presetCategory: preset,
      refImageUrl: refUrl,
      size: size as ImageSize | undefined,
    });

    if (!result.ok || !result.fileUrl) {
      return res.status(502).json({
        data: {
          promptUsed: result.promptUsed,
          modelTried: result.modelTried,
          durationMs: result.durationMs,
          attempts: result.attempts.slice(0, 20),
        },
        error: result.error ?? "Image generation failed",
      });
    }

    const cost = estimateCostRub(result.provider, result.model);
    const now = Date.now();
    const adminUserId = req.adminUserId ?? req.adminUser?.id ?? null;

    const meta = {
      durationMs: result.durationMs,
      modelTried: result.modelTried,
      attemptCount: result.attempts.length,
      lastAttempts: result.attempts.slice(-3).map((a) => ({
        provider: a.provider,
        model: a.model,
        ok: a.ok,
        httpStatus: a.httpStatus,
        error: a.error,
      })),
    };

    // INSERT и обратное чтение id через last_insert_rowid()
    db.run(sql`
      INSERT INTO generated_files (
        type, prompt, prompt_lang, file_path, file_size_bytes,
        width, height, provider, model, cost_estimate_rub,
        reference_track_id, reference_url, created_by_user_id,
        used_as, used_at, archived, created_at, meta_json
      ) VALUES (
        ${preset}, ${prompt}, ${"auto"}, ${result.fileUrl}, ${result.fileSizeBytes ?? null},
        ${result.width ?? null}, ${result.height ?? null}, ${result.provider ?? null}, ${result.model ?? null}, ${cost},
        ${refTrackId ?? null}, ${refUrl}, ${adminUserId},
        ${null}, ${null}, ${0}, ${now}, ${JSON.stringify(meta)}
      )
    `);

    const idRow = db.get<{ id: number }>(sql`SELECT last_insert_rowid() as id`);
    const newId = idRow?.id ?? 0;

    res.json({
      data: {
        id: newId,
        fileUrl: result.fileUrl,
        provider: result.provider,
        model: result.model,
        modelTried: result.modelTried,
        durationMs: result.durationMs,
        width: result.width,
        height: result.height,
        fileSizeBytes: result.fileSizeBytes,
        costEstimateRub: cost,
      },
      error: null,
    });
  } catch (err) {
    res.status(500).json({
      data: null,
      error: err instanceof Error ? err.message : "Failed to generate image",
    });
  }
});

// GET /api/admin/v304/images
router.get("/images", requireAdmin, async (req, res) => {
  try {
    const typeRaw = typeof req.query.type === "string" ? req.query.type : null;
    const archivedParam = typeof req.query.archived === "string" ? req.query.archived : null;
    const limit = Math.min(200, Math.max(1, parseInt(String(req.query.limit ?? "50"), 10) || 50));
    const offset = Math.max(0, parseInt(String(req.query.offset ?? "0"), 10) || 0);
    const type = typeRaw && (PRESET_VALUES as readonly string[]).includes(typeRaw) ? typeRaw : null;
    const archived = archivedParam === "1" ? 1 : 0;

    // Drizzle sql template поддерживает условия inline через .raw/.empty —
    // мы строим условный фрагмент через sql.join для type-filter.
    const typeCond = type
      ? sql`AND type = ${type}`
      : sql``;
    const rows = db.all<GeneratedFileRow>(
      sql`SELECT * FROM generated_files WHERE archived = ${archived} ${typeCond}
          ORDER BY created_at DESC LIMIT ${limit} OFFSET ${offset}`,
    ) as GeneratedFileRow[];

    res.json({
      data: {
        items: (rows || []).map(rowToApi),
        limit,
        offset,
      },
      error: null,
    });
  } catch (err) {
    res.status(500).json({
      data: null,
      error: err instanceof Error ? err.message : "Failed to list images",
    });
  }
});

// GET /api/admin/v304/images/:id
router.get("/images/:id", requireAdmin, async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (!Number.isFinite(id) || id <= 0) {
      return res.status(400).json({ data: null, error: "Invalid id" });
    }
    const row = db.get<GeneratedFileRow>(
      sql`SELECT * FROM generated_files WHERE id = ${id} LIMIT 1`,
    );
    if (!row) return res.status(404).json({ data: null, error: "Не найдено" });
    res.json({ data: rowToApi(row), error: null });
  } catch (err) {
    res.status(500).json({
      data: null,
      error: err instanceof Error ? err.message : "Failed",
    });
  }
});

// DELETE /api/admin/v304/images/:id  (soft-delete)
router.delete("/images/:id", requireAdmin, async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (!Number.isFinite(id) || id <= 0) {
      return res.status(400).json({ data: null, error: "Invalid id" });
    }
    db.run(sql`UPDATE generated_files SET archived = 1 WHERE id = ${id}`);
    res.json({ data: { id, archived: true }, error: null });
  } catch (err) {
    res.status(500).json({
      data: null,
      error: err instanceof Error ? err.message : "Failed to archive",
    });
  }
});

// POST /api/admin/v304/images/:id/use-as
// Body: { usedAs: "musa-avatar" | "cover-for-gen-NNN" | "banner-landing" | ... }
// Копирует файл туда, куда нужно, и обновляет used_as / used_at.
router.post("/images/:id/use-as", requireAdmin, async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (!Number.isFinite(id) || id <= 0) {
      return res.status(400).json({ data: null, error: "Invalid id" });
    }
    const parsed = UseAsSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      return res.status(400).json({
        data: null,
        error: "Невалидный body: " + parsed.error.issues.map((i) => i.message).join("; "),
      });
    }
    const usedAs = parsed.data.usedAs.trim();
    if (!USED_AS_PATTERN.test(usedAs)) {
      return res.status(400).json({
        data: null,
        error: "usedAs должен соответствовать pattern: musa-avatar | cover-for-gen-N | banner-landing | logo-site | product-N | custom-<id>",
      });
    }

    const row = db.get<GeneratedFileRow>(
      sql`SELECT * FROM generated_files WHERE id = ${id} LIMIT 1`,
    );
    if (!row) return res.status(404).json({ data: null, error: "Не найдено" });

    // Найти абсолютный путь файла в client/public (или dist/public).
    const candidates = [
      path.join(process.cwd(), "apps/neurohub/client/public", row.file_path),
      path.join(process.cwd(), "client/public", row.file_path),
      path.join(process.cwd(), "dist/public", row.file_path),
    ];
    let srcAbs: string | null = null;
    for (const c of candidates) {
      try {
        await fs.access(c);
        srcAbs = c;
        break;
      } catch { /* try next */ }
    }
    if (!srcAbs) {
      return res.status(404).json({ data: null, error: "Source file not found on disk" });
    }

    // Определить destination по usedAs.
    let dstRelList: string[] = [];
    if (usedAs === "musa-avatar") {
      dstRelList = ["consultant-avatar.png"];
    } else if (usedAs === "banner-landing") {
      dstRelList = ["generated/used/banner-landing.png"];
    } else if (usedAs === "logo-site") {
      dstRelList = ["generated/used/logo-site.png"];
    } else if (usedAs.startsWith("cover-for-gen-")) {
      const genId = usedAs.slice("cover-for-gen-".length);
      dstRelList = [`generated/used/cover-for-gen-${genId}.png`];
    } else if (usedAs.startsWith("product-")) {
      dstRelList = [`generated/used/${usedAs}.png`];
    } else if (usedAs.startsWith("custom-")) {
      dstRelList = [`generated/used/${usedAs}.png`];
    } else {
      return res.status(400).json({ data: null, error: "Неподдерживаемый usedAs" });
    }

    // Копируем в каждый существующий public-каталог (для prod/clone/dist).
    const copied: string[] = [];
    const publicRoots = [
      path.join(process.cwd(), "apps/neurohub/client/public"),
      path.join(process.cwd(), "client/public"),
      path.join(process.cwd(), "dist/public"),
    ];
    for (const root of publicRoots) {
      try {
        await fs.access(root);
      } catch {
        continue;
      }
      for (const rel of dstRelList) {
        const dst = path.join(root, rel);
        await fs.mkdir(path.dirname(dst), { recursive: true });
        await fs.copyFile(srcAbs, dst);
        copied.push(dst);
      }
    }
    if (copied.length === 0) {
      return res.status(500).json({ data: null, error: "Не найдено ни одной директории client/public" });
    }

    // Update БД: used_as / used_at
    const now = Date.now();
    db.run(sql`
      UPDATE generated_files SET used_as = ${usedAs}, used_at = ${now} WHERE id = ${id}
    `);

    res.json({
      data: {
        id,
        usedAs,
        usedAt: now,
        copiedTo: copied,
      },
      error: null,
    });
  } catch (err) {
    res.status(500).json({
      data: null,
      error: err instanceof Error ? err.message : "Failed to apply use-as",
    });
  }
});

// === Module export ===

const imageGenModule: Module = {
  name: "image-gen",
  version: "0.1.0",
  description:
    "Admin-генератор изображений (avatar/cover/banner/logo/product/custom) с GPTunnel→OpenAI fallback. CRUD-таблица generated_files + soft-delete + use-as routing.",
  migrations: [
    {
      version: "001_create_generated_files.sql",
      up: `
        CREATE TABLE IF NOT EXISTS generated_files (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          type TEXT NOT NULL,
          prompt TEXT NOT NULL,
          prompt_lang TEXT DEFAULT 'auto',
          file_path TEXT NOT NULL,
          file_size_bytes INTEGER,
          width INTEGER,
          height INTEGER,
          provider TEXT,
          model TEXT,
          cost_estimate_rub INTEGER,
          reference_track_id INTEGER,
          reference_url TEXT,
          created_by_user_id INTEGER,
          used_as TEXT,
          used_at INTEGER,
          archived INTEGER NOT NULL DEFAULT 0,
          created_at INTEGER NOT NULL,
          meta_json TEXT
        );
        CREATE INDEX IF NOT EXISTS idx_generated_files_type ON generated_files(type, created_at DESC);
        CREATE INDEX IF NOT EXISTS idx_generated_files_used ON generated_files(used_as, used_at DESC);
        CREATE INDEX IF NOT EXISTS idx_generated_files_archived ON generated_files(archived, created_at DESC);
      `,
    },
  ],
  routes: { prefix: "admin/v304", router },
  publishes: ["image-gen.created", "image-gen.used"],
  onLoad: async (ctx) => {
    ctx.logger.info(
      "image-gen online — POST /api/admin/v304/images/generate, GET /images, DELETE /images/:id, POST /images/:id/use-as",
    );
  },
  healthCheck: () => ({ status: "ok" }),
};

export default imageGenModule;
