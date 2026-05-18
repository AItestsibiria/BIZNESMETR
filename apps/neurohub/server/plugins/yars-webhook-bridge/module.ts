// Eugene 2026-05-18 Босс «Yars auto-apply pipeline — bridge для telegram/voice».
//
// Bridge-плагин для перенаправления сообщений из telegram-bot / voice-fab /
// max-bot в `/api/yars/webhook`. На данный момент это **scaffold** —
// telegram-bot ещё не публикует events на EventBus, поэтому реальной
// автоматики тут нет.
//
// Будущая интеграция (когда telegram-bot начнёт emit'ить `telegram.message`):
//
//   subscribes: {
//     "telegram.message": async (event, ctx) => {
//       const { from, text, chatSessionId } = event.payload as {
//         from: string; text: string; chatSessionId?: string;
//       };
//       if (!isAuthorizedOperator(String(from))) return;
//       // Internal POST в /api/yars/webhook
//       await fetch(`${process.env.INTERNAL_BASE_URL || "http://localhost:5000"}/api/yars/webhook`, {
//         method: "POST",
//         headers: {
//           "content-type": "application/json",
//           "x-yars-token": process.env.YARS_WEBHOOK_TOKEN || "",
//         },
//         body: JSON.stringify({ from, text, source: "telegram", chatSessionId }),
//       });
//     },
//   }
//
// Сейчас плагин просто регистрируется и логирует ready-state, чтобы Босс
// видел в системных логах что bridge доступен и готов к подключению через
// EventBus.

import type { Module } from "../../core";

const yarsWebhookBridgeModule: Module = {
  name: "yars-webhook-bridge",
  version: "0.1.0",
  description:
    "Bridge для перенаправления сообщений Yars (telegram/voice/max) в /api/yars/webhook через EventBus. Scaffold — реальная интеграция подключается когда telegram-bot начнёт emit'ить telegram.message.",
  // Placeholder: реальный subscribe будет добавлен когда telegram-bot
  // начнёт публиковать events. Сейчас просто стартует и пишет ready.
  onLoad: async (ctx) => {
    const tokenConfigured = Boolean((process.env.YARS_WEBHOOK_TOKEN || "").trim());
    const autoApply = (process.env.YARS_AUTO_APPLY || "").trim() === "1";
    ctx.logger.info(
      `yars-webhook-bridge ready — token=${tokenConfigured ? "set" : "missing"}, auto-apply=${autoApply ? "ON" : "OFF"}. Subscriber для telegram.message добавится в S6+.`,
    );
  },
  healthCheck: () => ({
    status: "ok",
    details: {
      tokenConfigured: Boolean((process.env.YARS_WEBHOOK_TOKEN || "").trim()),
      autoApplyEnabled: (process.env.YARS_AUTO_APPLY || "").trim() === "1",
    },
  }),
};

export default yarsWebhookBridgeModule;
