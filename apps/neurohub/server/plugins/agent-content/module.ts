// Agent #9 — ContentAgent. Hourly cron — обновляет агрегаты для ленты.
// Сейчас простой подсчёт top-10 plays из gen_activity за сутки и логирование.
// Полный gen_stats_daily materialized view — отдельным коммитом (07 §3.13).
//
// Spec: docs/strategy/original/03 §3.9.

import { sql } from "drizzle-orm";
import { db } from "../../storage";
import { genActivity } from "@shared/schema";
import type { BootContext, Module } from "../../core";
import { runAgentAction } from "../_agent-base/helper";

let bootRefs: { eventBus: BootContext["eventBus"]; logger: BootContext["logger"] } | null = null;

async function hourlyContentScan(): Promise<void> {
  if (!bootRefs) return;

  await runAgentAction(
    {
      agentName: "content",
      triggerEvent: "cron:every_hour",
      actionKind: "hourly-top-tracks",
    },
    bootRefs,
    () => {
      const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
      const tops = db
        .select({
          genId: genActivity.genId,
          plays: sql<number>`count(*)`,
        })
        .from(genActivity)
        .where(sql`${genActivity.action} = 'play' AND ${genActivity.createdAt} >= ${since}`)
        .groupBy(genActivity.genId)
        .orderBy(sql`count(*) DESC`)
        .limit(10)
        .all();

      return { topTracks24h: tops, since };
    },
  );
}

const contentModule: Module = {
  name: "agent-content",
  version: "0.1.0",
  description: "Agent #9 — hourly aggregates plays/shares for the playlist lane.",
  publishes: [],
  jobs: [
    {
      name: "content-hourly-scan",
      schedule: "every_hour",
      handler: () => hourlyContentScan(),
    },
  ],
  onLoad: async (ctx) => {
    bootRefs = { eventBus: ctx.eventBus, logger: ctx.logger };
    ctx.logger.info("agent-content online (hourly scan registered)");
  },
  healthCheck: () => ({ status: "ok" }),
};

export default contentModule;
