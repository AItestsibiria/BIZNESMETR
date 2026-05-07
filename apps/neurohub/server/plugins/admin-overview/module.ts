// v304 plugin: admin-overview (Sprint 7).
// GET /api/admin/v304/overview — read-only агрегаты для админ-дашборда:
//   - events за 24h (breakdown по name + total)
//   - агенты: executed / failed по каждому за 24h
//   - leads: total / converted / by status
//   - templates: топ по popularity
//   - feature_flags: enabled list
//   - generations: свежие 20 (id, type, status, createdAt)
//   - chatbot_sessions: свежие 20 + breakdown по channel
//   - plugin health: текущее состояние реестра
//
// Защищён по email-админу как остальные admin-роуты v51 (см.
// routes.ts pattern `user.email !== "egnovoselov@gmail.com"` → 403).
//
// Spec: docs/strategy/original/03 §4 (UI), 07 §6 (метрики).

import { Router } from "express";
import { sql, desc, eq } from "drizzle-orm";
import { z } from "zod";
import { db } from "../../storage";
import {
  users,
  generations,
  events,
  agentActions,
  leads,
  pluginsRegistry,
  featureFlags,
  genTemplates,
  chatbotSessions,
  adminAuditLog,
} from "@shared/schema";
import type { Module } from "../../core";

const ADMIN_EMAIL = process.env.ADMIN_EMAIL || "egnovoselov@gmail.com";

function requireAdmin(req: any, res: any, next: any): void {
  const userId = req?.session?.passport?.user ?? req?.session?.userId;
  if (!userId) {
    res.status(401).json({ data: null, error: "unauthorized" });
    return;
  }
  const u = db.select().from(users).where(eq(users.id, userId)).get();
  if (!u || u.email !== ADMIN_EMAIL) {
    res.status(403).json({ data: null, error: "forbidden" });
    return;
  }
  next();
}

// Backup-before-edit. Возвращает auditId — путь восстановления.
// Eugene 2026-05-07: каждая редакция админки фиксируется здесь.
function recordEdit(
  req: any,
  action: "create" | "update" | "delete" | "restore",
  entity: string,
  entityKey: string,
  before: unknown,
  after: unknown,
  restoredFromAuditId?: number,
): number {
  const userId = req?.session?.passport?.user ?? req?.session?.userId ?? null;
  const u = userId ? db.select().from(users).where(eq(users.id, userId)).get() : null;
  const inserted = db
    .insert(adminAuditLog)
    .values({
      adminUserId: userId,
      adminEmail: u?.email ?? null,
      action,
      entity,
      entityKey,
      beforeJson: before === undefined ? null : JSON.stringify(before ?? null),
      afterJson: after === undefined ? null : JSON.stringify(after ?? null),
      restoredFromAuditId: restoredFromAuditId ?? null,
    })
    .returning({ id: adminAuditLog.id })
    .get();
  return inserted.id;
}

const router = Router();

router.get("/overview", requireAdmin, (_req, res) => {
  try {
    const since24h = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();

    // Events за 24h
    const eventsRows = db
      .select({
        name: events.name,
        c: sql<number>`count(*)`,
      })
      .from(events)
      .where(sql`${events.occurredAt} >= ${since24h}`)
      .groupBy(events.name)
      .orderBy(sql`count(*) DESC`)
      .all();

    const eventsTotal = eventsRows.reduce((s, r) => s + r.c, 0);

    // Агенты — executed / failed за 24h
    const agentRows = db
      .select({
        agentName: agentActions.agentName,
        status: agentActions.status,
        c: sql<number>`count(*)`,
      })
      .from(agentActions)
      .where(sql`${agentActions.createdAt} >= ${since24h}`)
      .groupBy(agentActions.agentName, agentActions.status)
      .all();

    const agents: Record<string, { executed: number; failed: number; pending: number }> = {};
    for (const r of agentRows) {
      const key = r.agentName;
      if (!agents[key]) agents[key] = { executed: 0, failed: 0, pending: 0 };
      if (r.status === "executed") agents[key].executed = r.c;
      else if (r.status === "failed") agents[key].failed = r.c;
      else if (r.status === "pending") agents[key].pending = r.c;
    }

    // Leads
    const leadStatuses = db
      .select({ status: leads.status, c: sql<number>`count(*)` })
      .from(leads)
      .groupBy(leads.status)
      .all();

    const leadsTotal = leadStatuses.reduce((s, r) => s + r.c, 0);
    const leadsByStatus: Record<string, number> = {};
    for (const r of leadStatuses) leadsByStatus[r.status] = r.c;

    // Templates топ-5 по popularity
    const topTemplates = db
      .select({
        slug: genTemplates.slug,
        name: genTemplates.name,
        popularity: genTemplates.popularity,
      })
      .from(genTemplates)
      .where(eq(genTemplates.active, 1))
      .orderBy(desc(genTemplates.popularity), desc(genTemplates.id))
      .limit(5)
      .all();

    // Feature flags
    const flagsRows = db.select().from(featureFlags).all();

    // Generations свежие 20
    const recentGens = db
      .select({
        id: generations.id,
        type: generations.type,
        status: generations.status,
        createdAt: generations.createdAt,
      })
      .from(generations)
      .orderBy(desc(generations.id))
      .limit(20)
      .all();

    // Chatbot sessions свежие 20
    const recentChats = db
      .select()
      .from(chatbotSessions)
      .orderBy(desc(chatbotSessions.lastMessageAt))
      .limit(20)
      .all();

    const chatChannels = db
      .select({ channel: chatbotSessions.channel, c: sql<number>`count(*)` })
      .from(chatbotSessions)
      .groupBy(chatbotSessions.channel)
      .all();

    // Plugins registry
    const pluginsList = db.select().from(pluginsRegistry).all();

    res.json({
      data: {
        timestamp: new Date().toISOString(),
        since: since24h,
        events: {
          total: eventsTotal,
          breakdown: eventsRows.map((r) => ({ name: r.name, count: r.c })),
        },
        agents,
        leads: { total: leadsTotal, byStatus: leadsByStatus },
        templates: { top: topTemplates },
        featureFlags: flagsRows.map((f) => ({
          key: f.key,
          enabled: f.enabled === 1,
          rollout: f.rolloutPercent,
        })),
        generations: {
          recent: recentGens,
          totalByStatus: db
            .select({ status: generations.status, c: sql<number>`count(*)` })
            .from(generations)
            .groupBy(generations.status)
            .all(),
        },
        chatbot: {
          recent: recentChats,
          byChannel: chatChannels.map((c) => ({ channel: c.channel, count: c.c })),
        },
        plugins: {
          total: pluginsList.length,
          active: pluginsList.filter((p) => p.status === "active").length,
          failed: pluginsList.filter((p) => p.status === "failed").length,
          list: pluginsList.map((p) => ({
            name: p.name,
            version: p.version,
            status: p.status,
            loadedAt: p.loadedAt,
          })),
        },
      },
      error: null,
    });
  } catch (err) {
    res.status(500).json({
      data: null,
      error: err instanceof Error ? err.message : "internal",
    });
  }
});

// =============================================================
// CRUD endpoints — редактирование сущностей v304 из админки.
// Все требуют requireAdmin.
// =============================================================

// ---- Templates ----
const TemplateUpsertSchema = z.object({
  slug: z.string().min(1).max(64).regex(/^[a-z0-9-]+$/i),
  name: z.string().min(1).max(120),
  category: z.string().max(40).optional(),
  description: z.string().max(500).optional(),
  promptTemplate: z.string().max(8000).optional(),
  style: z.string().max(200).optional(),
  structuralTagsJson: z.string().max(4000).optional(),
  recommendedBpm: z.number().int().min(40).max(220).optional(),
  recommendedKey: z.string().max(20).optional(),
  active: z.boolean().optional(),
});

router.put("/templates", requireAdmin, (req, res) => {
  const parsed = TemplateUpsertSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ data: null, error: parsed.error.issues[0]?.message ?? "invalid" });
  }
  const t = parsed.data;
  try {
    const before = db.select().from(genTemplates).where(eq(genTemplates.slug, t.slug)).get() ?? null;
    const after = {
      slug: t.slug,
      name: t.name,
      category: t.category ?? null,
      description: t.description ?? null,
      promptTemplate: t.promptTemplate ?? null,
      style: t.style ?? null,
      structuralTagsJson: t.structuralTagsJson ?? null,
      recommendedBpm: t.recommendedBpm ?? null,
      recommendedKey: t.recommendedKey ?? null,
      active: t.active === false ? 0 : 1,
    };
    if (before) {
      db.update(genTemplates).set({ ...after, updatedAt: new Date().toISOString() }).where(eq(genTemplates.slug, t.slug)).run();
    } else {
      db.insert(genTemplates).values(after).run();
    }
    const auditId = recordEdit(req, before ? "update" : "create", "template", t.slug, before, after);
    res.json({
      data: {
        slug: t.slug,
        action: before ? "updated" : "created",
        auditId,
        backup: before ? `restore via POST /api/admin/v304/audit/${auditId}/restore` : null,
      },
      error: null,
    });
  } catch (err) {
    res.status(500).json({ data: null, error: err instanceof Error ? err.message : "internal" });
  }
});

router.delete("/templates/:slug", requireAdmin, (req, res) => {
  const slug = String(req.params.slug);
  try {
    const before = db.select().from(genTemplates).where(eq(genTemplates.slug, slug)).get();
    if (!before) return res.status(404).json({ data: null, error: "not found" });
    db.update(genTemplates).set({ active: 0 }).where(eq(genTemplates.slug, slug)).run();
    const auditId = recordEdit(req, "delete", "template", slug, before, { ...before, active: 0 });
    res.json({
      data: { slug, deactivated: true, auditId, backup: `POST /api/admin/v304/audit/${auditId}/restore` },
      error: null,
    });
  } catch (err) {
    res.status(500).json({ data: null, error: err instanceof Error ? err.message : "internal" });
  }
});

router.get("/templates", requireAdmin, (_req, res) => {
  const all = db.select().from(genTemplates).orderBy(desc(genTemplates.id)).all();
  res.json({ data: all, error: null });
});

// ---- Feature flags ----
const FlagUpsertSchema = z.object({
  key: z.string().min(1).max(64).regex(/^[a-z0-9._-]+$/i),
  enabled: z.boolean(),
  rolloutPercent: z.number().int().min(0).max(100).optional(),
  description: z.string().max(300).optional(),
  abVariants: z.string().max(4000).optional().nullable(),
});

router.put("/flags", requireAdmin, (req, res) => {
  const parsed = FlagUpsertSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ data: null, error: parsed.error.issues[0]?.message ?? "invalid" });
  }
  const f = parsed.data;
  try {
    const before = db.select().from(featureFlags).where(eq(featureFlags.key, f.key)).get() ?? null;
    const values = {
      enabled: f.enabled ? 1 : 0,
      rolloutPercent: f.rolloutPercent ?? 100,
      description: f.description ?? null,
      abVariants: f.abVariants ?? null,
      updatedAt: new Date().toISOString(),
    };
    const after = { key: f.key, ...values };
    if (before) {
      db.update(featureFlags).set(values).where(eq(featureFlags.key, f.key)).run();
    } else {
      db.insert(featureFlags).values(after).run();
    }
    const auditId = recordEdit(req, before ? "update" : "create", "flag", f.key, before, after);
    res.json({
      data: { key: f.key, action: before ? "updated" : "created", auditId, backup: before ? `POST /api/admin/v304/audit/${auditId}/restore` : null },
      error: null,
    });
  } catch (err) {
    res.status(500).json({ data: null, error: err instanceof Error ? err.message : "internal" });
  }
});

router.delete("/flags/:key", requireAdmin, (req, res) => {
  try {
    const key = String(req.params.key);
    const before = db.select().from(featureFlags).where(eq(featureFlags.key, key)).get();
    if (!before) return res.status(404).json({ data: null, error: "not found" });
    db.delete(featureFlags).where(eq(featureFlags.key, key)).run();
    const auditId = recordEdit(req, "delete", "flag", key, before, null);
    res.json({ data: { key, deleted: true, auditId, backup: `POST /api/admin/v304/audit/${auditId}/restore` }, error: null });
  } catch (err) {
    res.status(500).json({ data: null, error: err instanceof Error ? err.message : "internal" });
  }
});

router.get("/flags", requireAdmin, (_req, res) => {
  const all = db.select().from(featureFlags).orderBy(desc(featureFlags.updatedAt)).all();
  res.json({ data: all, error: null });
});

// ---- Leads ----
const LeadPatchSchema = z.object({
  status: z.enum(["new", "engaged", "converted", "dead"]).optional(),
  score: z.number().int().min(0).max(100).optional(),
  segment: z.string().max(40).optional(),
});

router.patch("/leads/:id", requireAdmin, (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isFinite(id)) return res.status(400).json({ data: null, error: "invalid id" });
  const parsed = LeadPatchSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ data: null, error: parsed.error.issues[0]?.message ?? "invalid" });
  }
  try {
    const before = db.select().from(leads).where(eq(leads.id, id)).get();
    if (!before) return res.status(404).json({ data: null, error: "not found" });
    db.update(leads).set(parsed.data).where(eq(leads.id, id)).run();
    const after = { ...before, ...parsed.data };
    const auditId = recordEdit(req, "update", "lead", String(id), before, after);
    res.json({ data: { id, ...parsed.data, auditId, backup: `POST /api/admin/v304/audit/${auditId}/restore` }, error: null });
  } catch (err) {
    res.status(500).json({ data: null, error: err instanceof Error ? err.message : "internal" });
  }
});

router.get("/leads", requireAdmin, (req, res) => {
  const limit = Math.min(Number(req.query.limit) || 100, 500);
  const all = db.select().from(leads).orderBy(desc(leads.id)).limit(limit).all();
  res.json({ data: all, error: null });
});

// ---- Audit log: список + restore ----
router.get("/audit", requireAdmin, (req, res) => {
  const limit = Math.min(Number(req.query.limit) || 100, 500);
  const entity = typeof req.query.entity === "string" ? req.query.entity : null;
  let q = db.select().from(adminAuditLog) as any;
  if (entity) q = q.where(eq(adminAuditLog.entity, entity));
  const rows = q.orderBy(desc(adminAuditLog.id)).limit(limit).all();
  res.json({ data: rows, error: null });
});

router.post("/audit/:id/restore", requireAdmin, (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isFinite(id)) return res.status(400).json({ data: null, error: "invalid id" });
  const entry = db.select().from(adminAuditLog).where(eq(adminAuditLog.id, id)).get();
  if (!entry) return res.status(404).json({ data: null, error: "audit entry not found" });
  if (!entry.beforeJson) {
    return res.status(400).json({ data: null, error: "no 'before' snapshot to restore (was a create)" });
  }
  let before: any;
  try {
    before = JSON.parse(entry.beforeJson);
  } catch (err) {
    return res.status(500).json({ data: null, error: "corrupted snapshot" });
  }

  try {
    if (entry.entity === "template") {
      // before — строка genTemplates
      const exists = db.select().from(genTemplates).where(eq(genTemplates.slug, entry.entityKey)).get();
      if (exists) {
        db.update(genTemplates).set(before).where(eq(genTemplates.slug, entry.entityKey)).run();
      } else {
        db.insert(genTemplates).values(before).run();
      }
    } else if (entry.entity === "flag") {
      const exists = db.select().from(featureFlags).where(eq(featureFlags.key, entry.entityKey)).get();
      if (exists) {
        db.update(featureFlags).set(before).where(eq(featureFlags.key, entry.entityKey)).run();
      } else {
        db.insert(featureFlags).values(before).run();
      }
    } else if (entry.entity === "lead") {
      const lid = parseInt(entry.entityKey, 10);
      if (!Number.isFinite(lid)) return res.status(400).json({ data: null, error: "invalid lead key" });
      db.update(leads).set(before).where(eq(leads.id, lid)).run();
    } else {
      return res.status(400).json({ data: null, error: `unknown entity: ${entry.entity}` });
    }

    const newAuditId = recordEdit(req, "restore", entry.entity, entry.entityKey, null, before, id);
    res.json({ data: { restored: true, fromAuditId: id, newAuditId, entity: entry.entity, entityKey: entry.entityKey }, error: null });
  } catch (err) {
    res.status(500).json({ data: null, error: err instanceof Error ? err.message : "internal" });
  }
});

const adminOverviewModule: Module = {
  name: "admin-overview",
  version: "0.1.0",
  description: "Sprint 7 — GET /api/admin/v304/overview, read-only dashboard data.",
  routes: { prefix: "admin/v304", router },
  publishes: [],
  onLoad: async (ctx) => {
    ctx.logger.info("admin-overview online — GET /api/admin/v304/overview");
  },
  healthCheck: () => ({ status: "ok" }),
};

export default adminOverviewModule;
