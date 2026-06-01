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
import { getGlobalRegistry } from "../../core";

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

// POST /api/_v304/smoke-test  — синтетический end-to-end: эмитит три
// сигнальных события, ждёт 3 секунды, собирает agent_actions/events
// которые подписчики породили, возвращает полный отчёт. Не пишет в
// users/generations/payments.
router.post("/smoke-test", async (_req, res) => {
  if (!bootRefs) {
    return res.status(503).json({ data: null, error: "boot context missing" });
  }
  const smokeId = `smoke-${Date.now()}`;
  const startedAt = new Date().toISOString();
  // SQLite CURRENT_TIMESTAMP формата 'YYYY-MM-DD HH:MM:SS' плохо сравнивается
  // с ISO-строкой через >=. Используем id-tracking: запомнить максимум перед
  // эмитами, фильтровать новые по id > saved.
  const beforeMaxActionId = db.select({ m: sql<number>`COALESCE(MAX(id), 0)` }).from(agentActions).get()?.m ?? 0;
  const beforeActionsCount = db.select({ c: sql<number>`count(*)` }).from(agentActions).get()?.c ?? 0;
  const beforeEventsCount = db.select({ c: sql<number>`count(*)` }).from(events).get()?.c ?? 0;

  await bootRefs.eventBus.emit(
    "auth.user.registered",
    { smokeId, userId: 0, email: `${smokeId}@smoke.local`, telegramId: null },
    "v304-diagnostics-smoke",
  );
  await bootRefs.eventBus.emit(
    "payment.succeeded",
    { smokeId, userId: 0, invId: -1, amount: 39900 },
    "v304-diagnostics-smoke",
  );
  await bootRefs.eventBus.emit(
    "generation.completed",
    { smokeId, userId: 0, genId: -1, type: "music" },
    "v304-diagnostics-smoke",
  );

  await new Promise((resolve) => setTimeout(resolve, 3000));

  const afterActionsCount = db.select({ c: sql<number>`count(*)` }).from(agentActions).get()?.c ?? 0;
  const afterEventsCount = db.select({ c: sql<number>`count(*)` }).from(events).get()?.c ?? 0;

  const newActions = db
    .select({
      id: agentActions.id,
      agentName: agentActions.agentName,
      triggerEvent: agentActions.triggerEvent,
      actionKind: agentActions.actionKind,
      status: agentActions.status,
      executedAt: agentActions.executedAt,
      error: agentActions.error,
    })
    .from(agentActions)
    .where(sql`${agentActions.id} > ${beforeMaxActionId}`)
    .orderBy(desc(agentActions.id))
    .all();

  // events.id — uuid, не сортируется; используем все события за окно
  // (afterEventsCount - beforeEventsCount) — берём столько последних
  const eventsAdded = afterEventsCount - beforeEventsCount;
  const newEvents = db
    .select({
      id: events.id,
      name: events.name,
      sourceModule: events.sourceModule,
      handlersCount: events.handlersCount,
      handlersFailed: events.handlersFailed,
      occurredAt: events.occurredAt,
    })
    .from(events)
    .orderBy(desc(events.occurredAt))
    .limit(Math.max(eventsAdded, 1))
    .all();

  res.json({
    data: {
      smokeId,
      startedAt,
      finishedAt: new Date().toISOString(),
      eventsAdded: afterEventsCount - beforeEventsCount,
      actionsAdded: afterActionsCount - beforeActionsCount,
      eventsByName: newEvents.reduce<Record<string, number>>((acc, e) => {
        acc[e.name] = (acc[e.name] ?? 0) + 1;
        return acc;
      }, {}),
      actionsByAgent: newActions.reduce<Record<string, { executed: number; failed: number; pending: number }>>(
        (acc, a) => {
          if (!acc[a.agentName]) acc[a.agentName] = { executed: 0, failed: 0, pending: 0 };
          if (a.status === "executed") acc[a.agentName].executed++;
          else if (a.status === "failed") acc[a.agentName].failed++;
          else acc[a.agentName].pending++;
          return acc;
        },
        {},
      ),
      events: newEvents.slice(0, 30),
      actions: newActions.slice(0, 30),
    },
    error: null,
  });
});

// Live health-check всех загруженных плагинов через registry.list().
// Каждый плагин может определить healthCheck() — мы дёргаем все, обёрнутые
// в try/catch, и возвращаем агрегат.
router.get("/health-check-all", async (_req, res) => {
  const registry = getGlobalRegistry();
  if (!registry) {
    return res.status(503).json({ data: null, error: "registry not ready" });
  }

  const modules = registry.list();
  const results: Array<{
    name: string;
    version: string;
    status: "ok" | "degraded" | "down" | "unknown";
    details?: Record<string, unknown>;
    error?: string;
    durationMs: number;
  }> = [];

  for (const m of modules) {
    const start = Date.now();
    try {
      if (typeof m.healthCheck !== "function") {
        results.push({
          name: m.name,
          version: m.version,
          status: "unknown",
          durationMs: 0,
        });
        continue;
      }
      const r = await Promise.resolve(m.healthCheck());
      results.push({
        name: m.name,
        version: m.version,
        status: r?.status ?? "unknown",
        details: r?.details,
        durationMs: Date.now() - start,
      });
    } catch (err) {
      results.push({
        name: m.name,
        version: m.version,
        status: "down",
        error: err instanceof Error ? err.message : String(err),
        durationMs: Date.now() - start,
      });
    }
  }

  // Также проверим внешние сервисы и ключевые внутренние компоненты
  const services: Array<{
    name: string;
    status: "ok" | "degraded" | "down" | "skipped";
    details?: Record<string, unknown>;
    error?: string;
  }> = [];

  // SQLite integrity
  try {
    const ic = (db.all(sql`PRAGMA integrity_check` as any) as any[]) ?? [];
    const ok = ic.length > 0 && (ic[0]?.integrity_check === "ok" || ic[0]?.["integrity_check"] === "ok");
    services.push({
      name: "sqlite",
      status: ok ? "ok" : "degraded",
      details: { result: ic[0] },
    });
  } catch (err) {
    services.push({
      name: "sqlite",
      status: "down",
      error: err instanceof Error ? err.message : String(err),
    });
  }

  // GPTunnel — если ключ есть в env, делаем небольшой ping
  if (process.env.GPTUNNEL_API_KEY) {
    try {
      const r = await fetch("https://gptunnel.ru/v1/balance", {
        method: "GET",
        headers: { Authorization: process.env.GPTUNNEL_API_KEY },
        signal: AbortSignal.timeout(3500),
      });
      services.push({
        name: "gptunnel",
        status: r.ok ? "ok" : "down",
        details: { httpStatus: r.status },
      });
    } catch (err) {
      services.push({
        name: "gptunnel",
        status: "down",
        error: err instanceof Error ? err.message : String(err),
      });
    }
  } else {
    services.push({ name: "gptunnel", status: "skipped", details: { reason: "GPTUNNEL_API_KEY not set" } });
  }

  // SMTP — если конфигурация есть, проверяем DNS hostname
  if (process.env.SMTP_HOST) {
    services.push({
      name: "smtp",
      status: "skipped",
      details: { reason: "configured but live check not implemented", host: process.env.SMTP_HOST },
    });
  } else {
    services.push({ name: "smtp", status: "skipped", details: { reason: "SMTP_HOST not set" } });
  }

  // EventBus probe
  try {
    const before = db.select({ c: sql<number>`count(*)` }).from(events).get()?.c ?? 0;
    if (bootRefs?.eventBus) {
      await bootRefs.eventBus.emit("_v304.health-probe", { ts: Date.now() }, "v304-diagnostics");
    }
    const after = db.select({ c: sql<number>`count(*)` }).from(events).get()?.c ?? 0;
    services.push({
      name: "eventbus",
      status: after > before ? "ok" : "degraded",
      details: { eventsAdded: after - before },
    });
  } catch (err) {
    services.push({
      name: "eventbus",
      status: "down",
      error: err instanceof Error ? err.message : String(err),
    });
  }

  const overall =
    results.some((r) => r.status === "down") ||
    services.some((s) => s.status === "down")
      ? "down"
      : results.some((r) => r.status === "degraded") ||
        services.some((s) => s.status === "degraded")
      ? "degraded"
      : "ok";

  res.json({
    data: {
      timestamp: new Date().toISOString(),
      overall,
      summary: {
        plugins_total: results.length,
        plugins_ok: results.filter((r) => r.status === "ok").length,
        plugins_degraded: results.filter((r) => r.status === "degraded").length,
        plugins_down: results.filter((r) => r.status === "down").length,
        plugins_unknown: results.filter((r) => r.status === "unknown").length,
      },
      plugins: results,
      services,
    },
    error: null,
  });
});

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
