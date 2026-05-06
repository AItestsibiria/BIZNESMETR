// Agent #6 — ConversionAgent. Подписан на 'payment.initiated' и
// 'payment.succeeded'; считает конверсию pre→paid и логирует.
// Реальный paywall A/B + dunning — позже (нужны feature flags
// для вариантов и notifications для dunning emails).
//
// Spec: docs/strategy/original/03 §3.6.

import type { BootContext, Module } from "../../core";
import { runAgentAction } from "../_agent-base/helper";

interface PaymentPayload {
  userId?: number;
  invId?: number;
  amount?: number;
  sku?: string;
}

let bootRefs: { eventBus: BootContext["eventBus"]; logger: BootContext["logger"] } | null = null;

const conversionModule: Module = {
  name: "agent-conversion",
  version: "0.1.0",
  description: "Agent #6 — observes payment funnel and audits conversion.",
  publishes: [],
  subscribes: {
    "payment.initiated": async (event, ctx) => {
      if (!bootRefs) return;
      const payload = event.payload as PaymentPayload | null;
      await runAgentAction(
        {
          agentName: "conversion",
          triggerEvent: event.name,
          userId: payload?.userId,
          actionKind: "log-payment-initiated",
          payload,
        },
        bootRefs,
        () => ({ logged: true, sku: payload?.sku, amount: payload?.amount }),
      );
    },
    "payment.succeeded": async (event, ctx) => {
      if (!bootRefs) return;
      const payload = event.payload as PaymentPayload | null;
      await runAgentAction(
        {
          agentName: "conversion",
          triggerEvent: event.name,
          userId: payload?.userId,
          actionKind: "log-payment-succeeded",
          payload,
        },
        bootRefs,
        () => ({ logged: true, invId: payload?.invId, amount: payload?.amount }),
      );
    },
  },
  onLoad: async (ctx) => {
    bootRefs = { eventBus: ctx.eventBus, logger: ctx.logger };
    ctx.logger.info("agent-conversion online");
  },
  healthCheck: () => ({ status: "ok" }),
};

export default conversionModule;
