// Eugene 2026-05-25 Босс «Муза-Директор — главный начальник: владеет всей
// информацией, контролирует ВСЕХ агентов, всё дожимается».
//
// Этот плагин — МОСТ между двумя агентными мирами:
//   1. AgentOrchestrator (in-memory registry «Музa Директор») — lib/agentOrchestrator.ts
//   2. EventBus-агенты (plugins/agent-*) + A1 Master — пишут в agent_actions
//
// До моста Директор НЕ видел 9 EventBus-агентов (live-активность/здоровье).
// Мост делает 3 вещи:
//
//  A) agent.action.executed/failed → recordAgentActivity(`bus-<name>`) +
//     recordActivity("agent-a1-master") → у Директора обновляется lastSeenAt,
//     он отличает «живой» от «молчит».
//  B) a1.alert.agent_unhealthy → orchestrator.setStatus(`bus-<name>`,"error") +
//     TG-алерт Боссу → Директор знает «кто плохо работает».
//  C) orchestrator.on(gen.escalated/stuck/recovered) — РАНЕЕ эмитились в пустоту
//     (0 подписчиков). Теперь: эскалация → TG-алерт Боссу + apology-email юзеру;
//     recovered → лог. Закрывает «всё дожимается» (эскалации не теряются).
//
// Reuse-working-solutions rule: TG-алерт — тот же паттерн что llmCore
// notifyAdminKeySwitch; email — sendEmail из lib/emailSender.

import type { BootContext, Module } from "../../core";
import { orchestrator, recordAgentActivity } from "../../lib/agentOrchestrator";
import { directorAlert } from "../../lib/directorDigest";
import { sendEmail } from "../../lib/emailSender";
import { storage } from "../../storage";

let bootRefs: { logger: BootContext["logger"] } | null = null;

// Алерты Боссу — через единый directorAlert (TG + email-fallback + dedup),
// см. lib/directorDigest. Локальный throttle больше не нужен.

// Apology-email юзеру после неразрешимой эскалации. Fire-and-forget.
async function sendApologyEmail(userId: number | null | undefined, genId: number): Promise<void> {
  if (!userId) return;
  try {
    const user: any = storage.getUser(userId);
    const email = (user?.email || "").trim();
    // Только реальные email (не tg_*@telegram.* / phone.* плейсхолдеры).
    if (!email || !email.includes("@") || /@(telegram|phone)\./i.test(email)) return;
    const name = user?.name || "автор";
    await sendEmail({
      to: email,
      subject: "MuzaAi — мы вернули средства за трек 🎵",
      text:
        `Здравствуйте, ${name}!\n\n` +
        `К сожалению, генерация трека #${genId} не удалась после нескольких попыток — ` +
        `я (Музa) уже вернула средства на ваш баланс автоматически.\n\n` +
        `Это редкий сбой на стороне генерации, не по вашей вине. Попробуйте создать трек ещё раз — ` +
        `обычно со второго раза всё проходит. Если нужна помощь — напишите мне в чат на muzaai.ru.\n\n` +
        `С заботой, Музa · MuzaAi`,
    });
  } catch (e) {
    bootRefs?.logger.warn?.("[orchestrator-bridge] apology email failed", { error: String(e), genId });
  }
}

const orchestratorBridgeModule: Module = {
  name: "agent-orchestrator-bridge",
  version: "1.0.0",
  description:
    "Мост EventBus-агентов ↔ Музa Директор: live-активность/здоровье 9 агентов + A1 Master, " +
    "подписчики gen.escalated/stuck/recovered (TG-алерт + apology email).",
  subscribes: {
    // A) Любое действие EventBus-агента → Директор видит активность.
    "agent.action.executed": async (event: any) => {
      const name = event?.payload?.agentName;
      if (!name) return;
      recordAgentActivity(`bus-${name}`, { lastAction: event?.payload?.actionKind });
      recordAgentActivity("agent-a1-master");
      orchestrator.recordEdgeUsage("agent-a1-master", `bus-${name}`, "event");
    },
    "agent.action.failed": async (event: any) => {
      const name = event?.payload?.agentName;
      if (!name) return;
      // Один fail — НЕ error (агент жив, действие упало). Просто активность.
      recordAgentActivity(`bus-${name}`, { lastFail: event?.payload?.error });
      recordAgentActivity("agent-a1-master");
    },
    // B) A1 говорит «агент нездоров» (>50% fail/100) → Директор ставит error + алерт.
    "a1.alert.agent_unhealthy": async (event: any) => {
      const p = event?.payload || {};
      const name = p.agentName;
      if (!name) return;
      orchestrator.setStatus(`bus-${name}`, "error", `failure-rate: ${p.failed}/${p.executed + p.failed}`);
      orchestrator.recordEdgeUsage("agent-a1-master", "muza-admin", "webhook");
      // directorAlert — единый dedup-канал (Рек 4), не чаще 1/час на агента.
      directorAlert(
        `unhealthy:${name}`,
        `🔴 <b>Агент нездоров: ${name}</b>\n\nВыполнено: ${p.executed}, упало: ${p.failed}\nПричина: ${p.lastFailReason || "—"}\n\nМузa Директор пометила агента error.`,
        60 * 60_000,
      );
    },
  },
  onLoad: async (ctx) => {
    bootRefs = { logger: ctx.logger };

    // C) Подписчики на эскалации gen-lifecycle (раньше эмитились в пустоту).
    // gen.escalated — неразрешимая ошибка после 3 попыток → алерт + apology.
    orchestrator.on("gen.escalated", (payload: any) => {
      const genId = payload?.genId;
      const userId = payload?.userId ?? null;
      orchestrator.recordEdgeUsage("gen-lifecycle", "muza-admin", "webhook");
      orchestrator.recordEdgeUsage("gen-lifecycle", "channel-email", "notify");
      directorAlert(
        `gen-escalated:${genId}`,
        `🚨 <b>Генерация эскалирована</b>\n\nТрек #${genId} (юзер ${userId ?? "?"}) не дожался после 3 попыток.\nПричина: ${payload?.reason || "unknown"}\n\nСредства возвращены, юзеру ушёл apology-email.`,
        60 * 60_000,
      );
      void sendApologyEmail(userId, genId);
      orchestrator.recordEdgeUsage("gen-lifecycle", "marketing-orchestrator", "event");
    });

    // gen.stuck — застряла >5 мин (ещё дожимается, инфо-алерт, троттл 30 мин).
    orchestrator.on("gen.stuck", (payload: any) => {
      orchestrator.recordEdgeUsage("gen-lifecycle", "muza-admin", "webhook");
      directorAlert(
        `stuck:${payload?.genId}`,
        `⏳ Генерация #${payload?.genId} застряла (${payload?.ageMin || "?"} мин) — Музa дожимает (auto-retry).`,
        30 * 60_000,
      );
    });

    // gen.recovered — дожали после retry. Лог (success metric).
    orchestrator.on("gen.recovered", (payload: any) => {
      ctx.logger.info("[orchestrator-bridge] gen recovered", {
        genId: payload?.genId, attempts: payload?.attempts,
      });
    });

    ctx.logger.info("agent-orchestrator-bridge online — 9 EventBus-агентов + A1 видны Директору, эскалации подключены");
  },
};

export default orchestratorBridgeModule;
