// Agent #3 — WelcomeAgent. Шлёт приветственную серию из 3 писем.
//
// Подписан на 'auth.user.registered'. Запланирует три письма
// (welcome_1 сразу, welcome_2 через 1 день, welcome_3 через 3 дня) через
// agent_actions.scheduled_for + status='pending'. Реальная отправка —
// плагин notifications (Sprint 4 backlog), который опрашивает
// agent_actions cron'ом и шлёт через SMTP.
//
// Сейчас агент только пишет три записи; их подхват и SMTP — следующий
// коммит.
//
// Spec: docs/strategy/original/03 §3.3, 07 §3.10.

import type { BootContext, Module } from "../../core";
import { runAgentAction } from "../_agent-base/helper";
import { db } from "../../storage";
import { agentActions } from "@shared/schema";

interface UserRegisteredPayload {
  userId?: number;
  email?: string | null;
}

const SCHEDULE = [
  { template: "welcome_1", delayMinutes: 0 },
  { template: "welcome_2", delayMinutes: 60 * 24 },
  { template: "welcome_3", delayMinutes: 60 * 24 * 3 },
];

let bootRefs: { eventBus: BootContext["eventBus"]; logger: BootContext["logger"] } | null = null;

const welcomeModule: Module = {
  name: "agent-welcome",
  version: "0.1.0",
  description: "Agent #3 — schedules a 3-step welcome email series.",
  publishes: [],
  subscribes: {
    "auth.user.registered": async (event, ctx) => {
      if (!bootRefs) return;
      const payload = event.payload as UserRegisteredPayload | null;
      const userId = payload?.userId;
      const email = payload?.email;
      if (!userId || !email) return;

      await runAgentAction(
        {
          agentName: "welcome",
          triggerEvent: event.name,
          userId,
          actionKind: "schedule-welcome-series",
          payload: { email, scheduled: SCHEDULE.length },
        },
        bootRefs,
        () => {
          const now = Date.now();
          // Один runAgentAction = одна "родительская" запись; здесь добавляем
          // 3 дочерних запланированных send-actions.
          const scheduled: number[] = [];
          for (const step of SCHEDULE) {
            const when = new Date(now + step.delayMinutes * 60 * 1000).toISOString();
            const row = db.insert(agentActions).values({
              agentName: "welcome",
              triggerEvent: event.name,
              userId,
              actionKind: `send-${step.template}`,
              actionPayload: JSON.stringify({ email, template: step.template }),
              scheduledFor: when,
              status: "pending",
            }).returning({ id: agentActions.id }).get();
            scheduled.push(row.id);
          }
          return { scheduledActionIds: scheduled };
        },
      );
    },
  },
  onLoad: async (ctx) => {
    bootRefs = { eventBus: ctx.eventBus, logger: ctx.logger };
    ctx.logger.info("agent-welcome online");
  },
  healthCheck: () => ({ status: "ok" }),
};

export default welcomeModule;
