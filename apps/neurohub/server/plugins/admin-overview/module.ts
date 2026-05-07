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
