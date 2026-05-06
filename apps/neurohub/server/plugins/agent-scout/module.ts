// Agent #2 — ScoutAgent. Связывает анонимного лида со свежим user'ом.
//
// Подписан на 'auth.user.registered' (эмит будет добавлен в существующий
// register-роут отдельным коммитом, либо обёрткой в Sprint 6). При триггере
// ищет lead по email/telegram/fingerprint, проставляет leads.user_id и
// status='converted', эмитит 'lead.identified'.
//
// Spec: docs/strategy/original/03 §3.2, 07 §3.5.

import { eq } from "drizzle-orm";
import { db } from "../../storage";
import { leads } from "@shared/schema";
import type { BootContext, Module } from "../../core";
import { runAgentAction } from "../_agent-base/helper";

interface UserRegisteredPayload {
  userId?: number;
  email?: string | null;
  telegramId?: string | null;
  fingerprint?: string | null;
}

let bootRefs: { eventBus: BootContext["eventBus"]; logger: BootContext["logger"] } | null = null;

const scoutModule: Module = {
  name: "agent-scout",
  version: "0.1.0",
  description: "Agent #2 — links anonymous lead to a fresh user account.",
  publishes: ["lead.identified"],
  subscribes: {
    "auth.user.registered": async (event, ctx) => {
      if (!bootRefs) return;
      const payload = event.payload as UserRegisteredPayload | null;
      const userId = payload?.userId;
      if (!userId) return;

      await runAgentAction(
        {
          agentName: "scout",
          triggerEvent: event.name,
          userId,
          actionKind: "link-lead-to-user",
          payload,
        },
        bootRefs,
        async () => {
          let leadRow = null;
          if (payload?.email) {
            leadRow = db.select().from(leads).where(eq(leads.email, payload.email)).get();
          }
          if (!leadRow && payload?.telegramId) {
            leadRow = db.select().from(leads).where(eq(leads.telegramChatId, payload.telegramId)).get();
          }
          if (!leadRow && payload?.fingerprint) {
            leadRow = db.select().from(leads).where(eq(leads.fingerprint, payload.fingerprint)).get();
          }
          if (!leadRow) return { matched: false, userId };

          db.update(leads)
            .set({ userId, status: "converted", lastSeen: new Date().toISOString() })
            .where(eq(leads.id, leadRow.id))
            .run();

          await bootRefs!.eventBus.emit(
            "lead.identified",
            { leadId: leadRow.id, userId, fingerprint: leadRow.fingerprint },
            "agent-scout",
          );

          return { matched: true, leadId: leadRow.id, userId };
        },
      );
    },
  },
  onLoad: async (ctx) => {
    bootRefs = { eventBus: ctx.eventBus, logger: ctx.logger };
    ctx.logger.info("agent-scout online");
  },
  healthCheck: () => ({ status: "ok" }),
};

export default scoutModule;
