// Eugene 2026-05-25 Босс «Музa Директор — готовить рекламные кампании на
// постоянной основе + блок публикаций по датам со статусом: подготовлено →
// одобрено → опубликовано / снято с публикации».
//
// Плагин-обёртка над lib/publicationsAgent.ts. Express + SQLite (НЕ внешние
// очереди). Endpoints под /api/admin/v304/director/publications (requireAdmin):
//
//   GET  /                  — список публикаций (?status= &from= &to=), сгруппированы по датам
//   POST /                  — создать черновик {channel,title,content,scheduledAt,campaignId?}
//   POST /:id/approve       — статус 'approved' (recordAuditEntry)
//   POST /:id/publish       — только из 'approved' → 'published'. БЕЗ реальной отправки.
//   POST /:id/unpublish     — статус 'unpublished' (recordAuditEntry)
//   POST /generate-now      — запустить подготовку черновиков креатива сейчас
//
// Reuse-working-solutions: callUnifiedMuzaLLM, recordAgentActivity, recordAuditEntry.
// Безопасность: НИЧЕГО не отправляется во внешние каналы в этой задаче — только
// статусы. publish помечает статус и (если нет безопасного пути отправки)
// возвращает dispatched:false.

import { Router, type Request, type Response } from "express";
import { z } from "zod";
import type { Module } from "../../core";
import { requireAdmin } from "../../core/adminAuth";
import { recordAuditEntry } from "../../lib/adminAuditLog";
import {
  ensurePublicationsTable,
  seedFirstCampaignIfEmpty,
  listPublications,
  getPublication,
  createPublication,
  approvePublication,
  markPublished,
  unpublishPublication,
  prepareCreativeDrafts,
  channelHasToken,
  PUBLICATION_CHANNELS,
  type PublicationRow,
} from "../../lib/publicationsAgent";

// === Zod ===

const CreateSchema = z.object({
  channel: z.enum(PUBLICATION_CHANNELS),
  title: z.string().trim().min(1).max(200),
  content: z.string().trim().min(1).max(2000),
  scheduledAt: z.number().int().positive().optional(),
  campaignId: z.string().trim().max(120).optional(),
  notes: z.string().trim().max(500).optional(),
});

// === Helpers ===

function parseDateBound(raw: unknown): number | null {
  if (raw == null) return null;
  const s = String(raw).trim();
  if (!s) return null;
  // millis?
  if (/^\d{10,}$/.test(s)) {
    const n = Number(s);
    return Number.isFinite(n) ? n : null;
  }
  const t = Date.parse(s);
  return Number.isFinite(t) ? t : null;
}

function dateKeyMsk(ms: number | null): string {
  if (!ms) return "Без даты";
  try {
    // МСК = UTC+3 → сдвигаем и берём ISO-дату.
    const d = new Date(ms + 3 * 3600_000);
    return d.toISOString().slice(0, 10);
  } catch {
    return "Без даты";
  }
}

function groupByDate(rows: PublicationRow[]): Array<{ date: string; items: PublicationRow[] }> {
  const map = new Map<string, PublicationRow[]>();
  for (const r of rows) {
    const key = dateKeyMsk(r.scheduled_at ?? r.created_at ?? null);
    if (!map.has(key)) map.set(key, []);
    map.get(key)!.push(r);
  }
  return Array.from(map.entries())
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
    .map(([date, items]) => ({ date, items }));
}

// === Admin router (requireAdmin) ===

const adminRouter = Router();
adminRouter.use(requireAdmin);

// GET / — список публикаций (опционально ?status= &from= &to=), grouped by date.
adminRouter.get("/director/publications", (req: Request, res: Response) => {
  try {
    const status = typeof req.query.status === "string" ? req.query.status : undefined;
    const fromMs = parseDateBound(req.query.from);
    const toMs = parseDateBound(req.query.to);
    const rows = listPublications({ status, fromMs, toMs, limit: 500 });
    const grouped = groupByDate(rows);
    const counts = rows.reduce<Record<string, number>>((acc, r) => {
      acc[r.status] = (acc[r.status] || 0) + 1;
      return acc;
    }, {});
    res.json({ data: { items: rows, grouped, counts, total: rows.length }, error: null });
  } catch (e: any) {
    console.error("[director-publications list]", e?.message || e);
    res.status(500).json({ data: null, error: "Не удалось получить публикации" });
  }
});

// POST / — создать черновик публикации (status='prepared').
adminRouter.post("/director/publications", (req: Request, res: Response) => {
  try {
    const parsed = CreateSchema.safeParse(req.body || {});
    if (!parsed.success) {
      res.status(400).json({ data: null, error: "Некорректные параметры публикации" });
      return;
    }
    const d = parsed.data;
    const row = createPublication({
      channel: d.channel,
      title: d.title,
      content: d.content,
      scheduledAt: d.scheduledAt ?? null,
      campaignId: d.campaignId ?? null,
      notes: d.notes ?? null,
    });
    if (!row) {
      res.status(500).json({ data: null, error: "Не удалось создать публикацию" });
      return;
    }
    recordAuditEntry({
      req,
      action: "create",
      entity: "publication",
      entityKey: String(row.id),
      after: { channel: row.channel, title: row.title, status: row.status, scheduledAt: row.scheduled_at },
    });
    res.json({ data: row, error: null });
  } catch (e: any) {
    console.error("[director-publications create]", e?.message || e);
    res.status(500).json({ data: null, error: "Внутренняя ошибка" });
  }
});

// POST /:id/approve — статус 'approved'.
adminRouter.post("/director/publications/:id/approve", (req: Request, res: Response) => {
  try {
    const id = parseInt(String(req.params.id), 10);
    const before = getPublication(id);
    if (!before) {
      res.status(404).json({ data: null, error: "Публикация не найдена" });
      return;
    }
    const row = approvePublication(id);
    recordAuditEntry({
      req,
      action: "update",
      entity: "publication",
      entityKey: String(id),
      before: { status: before.status },
      after: { status: row?.status, approvedAt: row?.approved_at },
    });
    res.json({ data: row, error: null });
  } catch (e: any) {
    console.error("[director-publications approve]", e?.message || e);
    res.status(500).json({ data: null, error: "Не удалось одобрить" });
  }
});

// POST /:id/publish — только из 'approved'. Помечает 'published'. БЕЗ реальной
// отправки во внешние каналы (safe: drafts + status only в этой задаче).
adminRouter.post("/director/publications/:id/publish", (req: Request, res: Response) => {
  try {
    const id = parseInt(String(req.params.id), 10);
    const before = getPublication(id);
    if (!before) {
      res.status(404).json({ data: null, error: "Публикация не найдена" });
      return;
    }
    if (before.status !== "approved") {
      res.status(400).json({ data: null, error: "Опубликовать можно только одобренную публикацию" });
      return;
    }
    const row = markPublished(id);
    const hasToken = channelHasToken(before.channel);
    recordAuditEntry({
      req,
      action: "update",
      entity: "publication",
      entityKey: String(id),
      before: { status: before.status },
      after: { status: row?.status, publishedAt: row?.published_at, channelHasToken: hasToken },
    });
    // Реальный send в этой задаче НЕ реализуется. Канальная отправка подключается
    // отдельно (см. marketing-orchestrator edges). Возвращаем честный флаг.
    res.json({
      data: {
        ...row,
        published: true,
        dispatched: false,
        channelHasToken: hasToken,
        reason: hasToken ? "channel send wired separately" : "channel has no token — status only",
      },
      error: null,
    });
  } catch (e: any) {
    console.error("[director-publications publish]", e?.message || e);
    res.status(500).json({ data: null, error: "Не удалось опубликовать" });
  }
});

// POST /:id/unpublish — статус 'unpublished'.
adminRouter.post("/director/publications/:id/unpublish", (req: Request, res: Response) => {
  try {
    const id = parseInt(String(req.params.id), 10);
    const before = getPublication(id);
    if (!before) {
      res.status(404).json({ data: null, error: "Публикация не найдена" });
      return;
    }
    const row = unpublishPublication(id);
    recordAuditEntry({
      req,
      action: "update",
      entity: "publication",
      entityKey: String(id),
      before: { status: before.status },
      after: { status: row?.status },
    });
    res.json({ data: row, error: null });
  } catch (e: any) {
    console.error("[director-publications unpublish]", e?.message || e);
    res.status(500).json({ data: null, error: "Не удалось снять с публикации" });
  }
});

// POST /generate-now — подготовить черновики креатива сейчас (ручной триггер).
adminRouter.post("/director/publications/generate-now", async (req: Request, res: Response) => {
  try {
    const r = await prepareCreativeDrafts();
    recordAuditEntry({
      req,
      action: "create",
      entity: "publication_campaign",
      entityKey: r.campaignId,
      after: { created: r.created, failed: r.failed, via: "generate-now" },
    });
    res.json({ data: r, error: null });
  } catch (e: any) {
    console.error("[director-publications generate-now]", e?.message || e);
    res.status(500).json({ data: null, error: "Не удалось подготовить черновики" });
  }
});

// === Module ===

const directorPublicationsModule: Module = {
  name: "director-publications",
  version: "0.1.0",
  description:
    "Музa Директор — публикации по датам (подготовлено → одобрено → опубликовано / снято) + подготовка рекламного креатива. Ничего не публикуется без одобрения Босса.",
  onLoad: async (ctx) => {
    ensurePublicationsTable();
    // One-time seed первой кампании (если таблица пуста).
    try {
      const s = seedFirstCampaignIfEmpty();
      if (s.seeded) ctx.logger.info(`director-publications seeded first campaign: ${s.count} drafts`);
    } catch (e) {
      ctx.logger.error("director-publications seed failed", { error: e });
    }
    ctx.app.use("/api/admin/v304", adminRouter);
    ctx.logger.info(
      "director-publications online — admin /api/admin/v304/director/publications (drafts + approval workflow, no auto-send)",
    );
  },
  healthCheck: () => ({ status: "ok" }),
};

export default directorPublicationsModule;
