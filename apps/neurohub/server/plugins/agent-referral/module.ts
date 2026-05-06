// Agent #7 — ReferralAgent. Audit-only.
//
// Реальная логика «начисление 299 ₽ обоим при первой оплате» уже
// реализована в v51 routes.ts:3665-3677 в payment-success callback.
// Этот агент только наблюдает за событием 'payment.succeeded' и
// фиксирует факт срабатывания реферальной механики в agent_actions —
// чтобы дашборд (Sprint 7) мог считать реферальный поток отдельно.
//
// Когда / если в Sprint 5+ мы решим перенести начисление в этот
// агент — фиксы будут точечные.
//
// Spec: docs/strategy/original/03 §3.7, 01 §1.1 (bug №1).

import { eq } from "drizzle-orm";
import { db } from "../../storage";
import { users, payments } from "@shared/schema";
import type { BootContext, Module } from "../../core";
import { runAgentAction } from "../_agent-base/helper";

interface PaymentSucceededPayload {
  invId?: number;
  amount?: number;
  userId?: number;
}

let bootRefs: { eventBus: BootContext["eventBus"]; logger: BootContext["logger"] } | null = null;

const referralModule: Module = {
  name: "agent-referral",
  version: "0.1.0",
  description: "Agent #7 — audit-only: tracks referral bonus events on first payment.",
  publishes: ["referral.bonus_applied"],
  subscribes: {
    "payment.succeeded": async (event, ctx) => {
      if (!bootRefs) return;
      const payload = event.payload as PaymentSucceededPayload | null;
      const invId = payload?.invId;
      if (!invId) return;

      await runAgentAction(
        {
          agentName: "referral",
          triggerEvent: event.name,
          actionKind: "audit-referral-on-payment",
          payload,
        },
        bootRefs,
        async () => {
          // Найдём user по invId через payments
          const pmt = db.select().from(payments).where(eq(payments.invId, invId)).get();
          if (!pmt) return { skipped: "payment not found" };

          const u = db.select().from(users).where(eq(users.id, pmt.userId)).get();
          if (!u || !u.referredBy) return { skipped: "no referrer" };

          // v51 routes.ts уже выставит referralBonusGiven=1 в этом callback.
          // Мы просто фиксируем audit-trail — был ли реально применён бонус.
          // Перепроверка через полсекунды (после того как routes.ts отработал).
          setTimeout(() => {
            const fresh = db.select().from(users).where(eq(users.id, pmt.userId)).get();
            if (fresh?.referralBonusGiven === 1) {
              bootRefs?.eventBus.emit(
                "referral.bonus_applied",
                {
                  payerUserId: pmt.userId,
                  referrerUserId: u.referredBy,
                  invId,
                },
                "agent-referral",
              );
            }
          }, 500);

          return { audited: true, payerUserId: pmt.userId, referrerUserId: u.referredBy };
        },
      );
    },
  },
  onLoad: async (ctx) => {
    bootRefs = { eventBus: ctx.eventBus, logger: ctx.logger };
    ctx.logger.info("agent-referral online (audit-only mode)");
  },
  healthCheck: () => ({ status: "ok" }),
};

export default referralModule;
