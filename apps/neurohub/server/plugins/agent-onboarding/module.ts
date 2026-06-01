// Agent #5 — OnboardingAgent. Помогает после первой успешной генерации.
//
// Подписан на 'generation.completed'. Если это первая успешная music-генерация
// пользователя — пишет в agent_actions «отправить onboarding-tip» и эмитит
// 'onboarding.first_track_made' для UI/email-каналов (ещё нет).
//
// Spec: docs/strategy/original/03 §3.5.

import { eq, and, sql } from "drizzle-orm";
import { db } from "../../storage";
import { generations } from "@shared/schema";
import type { BootContext, Module } from "../../core";
import { runAgentAction } from "../_agent-base/helper";

interface GenerationCompletedPayload {
  genId?: number;
  userId?: number;
  type?: string;
}

let bootRefs: { eventBus: BootContext["eventBus"]; logger: BootContext["logger"] } | null = null;

const onboardingModule: Module = {
  name: "agent-onboarding",
  version: "0.1.0",
  description: "Agent #5 — celebrates first successful music generation.",
  publishes: ["onboarding.first_track_made"],
  subscribes: {
    "generation.completed": async (event, ctx) => {
      if (!bootRefs) return;
      const payload = event.payload as GenerationCompletedPayload | null;
      const userId = payload?.userId;
      if (!userId || payload?.type !== "music") return;

      await runAgentAction(
        {
          agentName: "onboarding",
          triggerEvent: event.name,
          userId,
          actionKind: "check-first-track",
          payload,
        },
        bootRefs,
        async () => {
          const total = db
            .select({ c: sql<number>`count(*)` })
            .from(generations)
            .where(and(eq(generations.userId, userId), eq(generations.type, "music"), eq(generations.status, "done")))
            .get();

          if ((total?.c ?? 0) !== 1) return { skipped: "not first music track" };

          await bootRefs!.eventBus.emit(
            "onboarding.first_track_made",
            { userId, genId: payload.genId },
            "agent-onboarding",
          );
          return { celebrated: true, genId: payload.genId };
        },
      );
    },
  },
  onLoad: async (ctx) => {
    bootRefs = { eventBus: ctx.eventBus, logger: ctx.logger };
    ctx.logger.info("agent-onboarding online");
  },
  healthCheck: () => ({ status: "ok" }),
};

export default onboardingModule;
