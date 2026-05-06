// Agent #4 — DemoAgent. Гарантирует, что новый user получает один
// бесплатный demo-трек.
//
// Подписан на 'auth.user.registered'. Если у user'а freeUsed=0 (пока
// не использовал бесплатную генерацию) — ничего не делает (право и
// так есть). Если freeUsed=1 (по какой-то причине) — даёт +1 bonus
// track как восстановительный жест. Это safety-net.
//
// Полное "пригласи сделать первый трек" UI — отдельный коммит в S5
// (нужны email-шаблоны + push). Сейчас только safety-net + audit.
//
// Spec: docs/strategy/original/03 §3.4.

import { eq, sql } from "drizzle-orm";
import { db } from "../../storage";
import { users } from "@shared/schema";
import type { BootContext, Module } from "../../core";
import { runAgentAction } from "../_agent-base/helper";

interface UserRegisteredPayload {
  userId?: number;
}

let bootRefs: { eventBus: BootContext["eventBus"]; logger: BootContext["logger"] } | null = null;

const demoModule: Module = {
  name: "agent-demo",
  version: "0.1.0",
  description: "Agent #4 — guards new users' first-track entitlement.",
  publishes: [],
  subscribes: {
    "auth.user.registered": async (event, ctx) => {
      if (!bootRefs) return;
      const payload = event.payload as UserRegisteredPayload | null;
      const userId = payload?.userId;
      if (!userId) return;

      await runAgentAction(
        {
          agentName: "demo",
          triggerEvent: event.name,
          userId,
          actionKind: "guarantee-demo-entitlement",
          payload,
        },
        bootRefs,
        () => {
          const u = db.select().from(users).where(eq(users.id, userId)).get();
          if (!u) return { skipped: "user not found" };

          // Свежий аккаунт почти всегда имеет freeUsed=0. Если по какой-то
          // причине нет — даём +1 bonus track в качестве компенсации.
          if (u.freeUsed > 0) {
            db.update(users)
              .set({ bonusTracks: sql`${users.bonusTracks} + 1` })
              .where(eq(users.id, userId))
              .run();
            return { gifted: 1, reason: "freeUsed > 0 at registration" };
          }
          return { gifted: 0, reason: "freeUsed already 0 — has demo entitlement" };
        },
      );
    },
  },
  onLoad: async (ctx) => {
    bootRefs = { eventBus: ctx.eventBus, logger: ctx.logger };
    ctx.logger.info("agent-demo online");
  },
  healthCheck: () => ({ status: "ok" }),
};

export default demoModule;
