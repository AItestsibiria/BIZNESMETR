// Agent #1 — LeadHunter. Скоринг свежеcaptured лидов по UTM-сигналу.
//
// Подписан на 'lead.captured' (источник — плагин lead-capture). На каждом
// первом касании поднимает leads.score по простой эвристике:
//   utm_source указан     → +20
//   нет referer/utm       → +10 (прямой переход — потенциально качественный)
// Score кэпится на 100. Реальная RFM/A/B-логика добавится в Sprint 5.
//
// Spec: docs/strategy/original/03 §3.1, 07 §3.5.

import { eq } from "drizzle-orm";
import { db } from "../../storage";
import { leads } from "@shared/schema";
import type { BootContext, Module } from "../../core";
import { runAgentAction } from "../_agent-base/helper";

interface LeadCapturedPayload {
  leadId?: number;
  fingerprint?: string;
  source?: string | null;
}

let bootRefs: { eventBus: BootContext["eventBus"]; logger: BootContext["logger"] } | null = null;

const leadHunterModule: Module = {
  name: "agent-lead-hunter",
  version: "0.1.0",
  description: "Agent #1 — scores newly captured leads by UTM signal.",
  publishes: [],
  subscribes: {
    "lead.captured": async (event, ctx) => {
      if (!bootRefs) return;
      const payload = event.payload as LeadCapturedPayload | null;
      const leadId = payload?.leadId;
      if (!leadId) return;

      await runAgentAction(
        {
          agentName: "lead-hunter",
          triggerEvent: event.name,
          leadId,
          actionKind: "score-on-capture",
          payload,
        },
        bootRefs,
        () => {
          const lead = db.select().from(leads).where(eq(leads.id, leadId)).get();
          if (!lead) return { skipped: "lead not found" };

          let score = lead.score ?? 0;
          if (payload?.source) score += 20;
          else score += 10;
          score = Math.min(score, 100);

          db.update(leads)
            .set({ score, lastSeen: new Date().toISOString() })
            .where(eq(leads.id, leadId))
            .run();

          return { leadId, oldScore: lead.score, newScore: score };
        },
      );
    },
  },
  onLoad: async (ctx) => {
    bootRefs = { eventBus: ctx.eventBus, logger: ctx.logger };
    ctx.logger.info("agent-lead-hunter online");
  },
  healthCheck: () => ({ status: "ok" }),
};

export default leadHunterModule;
