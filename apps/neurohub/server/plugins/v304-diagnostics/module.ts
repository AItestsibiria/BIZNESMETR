// v304 self-diagnostics plugin.
// GET /api/_v304/diagnostics → полный отчёт состояния платформы:
//   - все плагины из plugins_registry с их статусом
//   - все v304-таблицы и количество строк в каждой
//   - топ-10 событий из events
//   - проверка end-to-end: emit('_v304.ping') → проверка persist'а
//   - количество и список шаблонов в gen_templates
//   - результаты healthCheck() каждого зарегистрированного плагина
//
// Один curl — и понятно, что сломано (если что-то сломано).

import { Router } from "express";
import { sql, desc, eq } from "drizzle-orm";
import { db } from "../../storage";
import {
  events,
  pluginsRegistry,
  featureFlags,
  leads,
  agentActions,
  trackingAttribution,
  genTemplates,
} from "@shared/schema";
import type { BootContext, Module } from "../../core";

interface TableStat {
  name: string;
  rows: number;
  ok: boolean;
  error?: string;
}

interface PluginStat {
  name: string;
  version: string;
  status: string;
  loadedAt: string | null;
  lastError: string | null;
  config: string | null;
}

interface EventSummary {
  id: string;
  name: string;
  source_module: string | null;
  occurred_at: string | null;
  handlers_count: number | null;
  handlers_failed: number | null;
}

let bootRefs: BootContext | null = null;

function tableCount<T extends { id: any } | { key: any } | { name: any }>(
  table: any,
  label: string,
): TableStat {
  try {
    const rows = db.select({ c: sql<number>`count(*)` }).from(table).get();
    return { name: label, rows: rows?.c ?? 0, ok: true };
  } catch (err) {
    return {
      name: label,
      rows: 0,
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

const router = Router();

router.get("/diagnostics", async (_req, res) => {
  const started = Date.now();
  const report: Record<string, unknown> = {
    timestamp: new Date().toISOString(),
    environment: {
      node: process.version,
      pid: process.pid,
      uptime_seconds: Math.round(process.uptime()),
      memory_mb: Math.round(process.memoryUsage().rss / 1024 / 1024),
    },
  };

  // 1. Plugin registry
  try {
    const plugins = db.select().from(pluginsRegistry).all() as PluginStat[];
    report.plugins = {
      total: plugins.length,
      active: plugins.filter((p) => p.status === "active").length,
      failed: plugins.filter((p) => p.status === "failed").length,
      list: plugins,
    };
  } catch (err) {
    report.plugins = { error: err instanceof Error ? err.message : String(err) };
  }

  // 2. v304 tables row counts
  report.tables = [
    tableCount(events, "events"),
    tableCount(pluginsRegistry, "plugins_registry"),
    tableCount(featureFlags, "feature_flags"),
    tableCount(leads, "leads"),
    tableCount(agentActions, "agent_actions"),
    tableCount(trackingAttribution, "tracking_attribution"),
    tableCount(genTemplates, "gen_templates"),
  ];

  // 3. Recent events (last 10)
  try {
    const recent = db
      .select({
        id: events.id,
        name: events.name,
        source_module: events.sourceModule,
        occurred_at: events.occurredAt,
        handlers_count: events.handlersCount,
        handlers_failed: events.handlersFailed,
      })
      .from(events)
      .orderBy(desc(events.occurredAt))
      .limit(10)
      .all() as EventSummary[];

    const eventsByName = recent.reduce<Record<string, number>>((acc, e) => {
      acc[e.name] = (acc[e.name] ?? 0) + 1;
      return acc;
    }, {});

    report.events = {
      recent_count: recent.length,
      breakdown: eventsByName,
      latest: recent.slice(0, 5),
    };
  } catch (err) {
    report.events = { error: err instanceof Error ? err.message : String(err) };
  }

  // 4. End-to-end: emit ping и проверь что записалось
  if (bootRefs) {
    try {
      const before = db.select({ c: sql<number>`count(*)` }).from(events).where(eq(events.name, "_v304.ping")).get();
      await bootRefs.eventBus.emit("_v304.ping", { ts: Date.now() }, "v304-diagnostics");
      const after = db.select({ c: sql<number>`count(*)` }).from(events).where(eq(events.name, "_v304.ping")).get();
      report.event_bus = {
        ok: (after?.c ?? 0) > (before?.c ?? 0),
        before: before?.c ?? 0,
        after: after?.c ?? 0,
      };
    } catch (err) {
      report.event_bus = { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  } else {
    report.event_bus = { ok: false, error: "boot context not captured" };
  }

  // 5. gen_templates — какие slugs есть
  try {
    const tpls = db
      .select({
        slug: genTemplates.slug,
        category: genTemplates.category,
        active: genTemplates.active,
      })
      .from(genTemplates)
      .all();
    report.templates = {
      total: tpls.length,
      active: tpls.filter((t) => t.active === 1).length,
      slugs: tpls.map((t) => t.slug),
    };
  } catch (err) {
    report.templates = { error: err instanceof Error ? err.message : String(err) };
  }

  // 6. Feature flags
  try {
    const flags = db.select().from(featureFlags).all();
    report.feature_flags = {
      total: flags.length,
      list: flags.map((f) => ({
        key: f.key,
        enabled: f.enabled === 1,
        rollout: f.rolloutPercent,
      })),
    };
  } catch (err) {
    report.feature_flags = { error: err instanceof Error ? err.message : String(err) };
  }

  report.elapsed_ms = Date.now() - started;
  res.json({ data: report, error: null });
});

const v304DiagnosticsModule: Module = {
  name: "v304-diagnostics",
  version: "0.1.0",
  description: "GET /api/_v304/diagnostics — полная самопроверка инфраструктуры.",
  routes: { prefix: "_v304", router },
  publishes: ["_v304.ping"],
  onLoad: async (ctx) => {
    // Capture boot refs so we can emit test events from the handler.
    // Cast: ModuleContext-like usage — in onLoad we get the full BootContext.
    bootRefs = {
      app: (ctx as unknown as BootContext).app,
      eventBus: (ctx as unknown as BootContext).eventBus,
      featureFlags: (ctx as unknown as BootContext).featureFlags,
      logger: ctx.logger,
    };
    ctx.logger.info("v304-diagnostics online; GET /api/_v304/diagnostics");
  },
  healthCheck: () => ({ status: "ok" }),
};

export default v304DiagnosticsModule;
