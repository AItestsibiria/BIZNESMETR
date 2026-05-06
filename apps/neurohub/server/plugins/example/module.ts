// Демонстрационный плагин — показывает Module API в действии.
// Ничего не делает в продакшене; включается через feature flag
// `plugin.example` (по умолчанию выключен). Уберём, когда появятся
// настоящие плагины (notifications в Sprint 4, chatbot в Sprint 6).

import { Router } from "express";
import type { Module } from "../../core";

const router = Router();

router.get("/ping", (_req, res) => {
  res.json({ data: { pong: true, ts: Date.now() }, error: null });
});

const exampleModule: Module = {
  name: "example",
  version: "0.1.0",
  description: "Skeleton plugin — proves Module API works end-to-end.",
  routes: { prefix: "example", router },
  publishes: ["example.pinged"],
  subscribes: {
    "auth.user.registered": async (event, ctx) => {
      ctx.logger.info("welcomed via event", {
        eventId: event.id,
        userId: (event.payload as { userId?: number } | null)?.userId,
      });
    },
  },
  onLoad: async (ctx) => {
    ctx.logger.info("example plugin online");
  },
  healthCheck: () => ({ status: "ok" }),
};

export default exampleModule;
