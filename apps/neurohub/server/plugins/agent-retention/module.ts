// Agent #8 — RetentionAgent. Сейчас — daily cron job который проходит
// по пользователям с last_visit > 30 дней и эмитит 'retention.churn_alert'
// для каждого. Реальная отправка churn-back email — плагин notifications
// (когда подключим SMTP). RFM-сегментация — отдельным коммитом, требует
// колонок rfm_recency/frequency/monetary в users (схема v304 предлагает).
//
// Spec: docs/strategy/original/03 §3.8.

import { sql } from "drizzle-orm";
import { db } from "../../storage";
import { users, generations } from "@shared/schema";
import type { BootContext, Module } from "../../core";
import { runAgentAction } from "../_agent-base/helper";

let bootRefs: { eventBus: BootContext["eventBus"]; logger: BootContext["logger"] } | null = null;

async function dailyRetentionScan(): Promise<void> {
  if (!bootRefs) return;

  await runAgentAction(
    {
      agentName: "retention",
      triggerEvent: "cron:every_day",
      actionKind: "daily-churn-scan",
    },
    bootRefs,
    async () => {
      // Признак "молчит" — не было успешных music-генераций за 30+ дней.
      // Ловим через generations.created_at MAX'a по user'у.
      const cutoff = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
      const churned = db
        .select({
          userId: users.id,
          email: users.email,
          lastGen: sql<string>`(SELECT MAX(${generations.createdAt}) FROM ${generations} WHERE ${generations.userId} = ${users.id} AND ${generations.type} = 'music' AND ${generations.status} = 'done')`,
        })
        .from(users)
        .all();

      let alerted = 0;
      for (const u of churned) {
        if (!u.lastGen) continue; // не было трекор вообще — пропускаем (этим занимается welcome)
        if (u.lastGen >= cutoff) continue; // активный
        await bootRefs!.eventBus.emit(
          "retention.churn_alert",
          { userId: u.userId, email: u.email, lastGen: u.lastGen },
          "agent-retention",
        );
        alerted++;
      }
      return { alerted, totalScanned: churned.length, cutoff };
    },
  );
}

const retentionModule: Module = {
  name: "agent-retention",
  version: "0.1.0",
  description: "Agent #8 — daily churn scan, emits 'retention.churn_alert' per dormant user.",
  publishes: ["retention.churn_alert"],
  jobs: [
    {
      name: "retention-daily-scan",
      schedule: "every_day",
      handler: () => dailyRetentionScan(),
    },
  ],
  onLoad: async (ctx) => {
    bootRefs = { eventBus: ctx.eventBus, logger: ctx.logger };
    ctx.logger.info("agent-retention online (daily scan registered)");
  },
  healthCheck: () => ({ status: "ok" }),
};

export default retentionModule;
