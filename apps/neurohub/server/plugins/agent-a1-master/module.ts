// A1 — Master Controller. Наблюдает за агентским трафиком: подписан на
// 'agent.action.executed' / 'agent.action.failed' через wildcard '*'.
// Считает per-agent счётчики в памяти + раз в час логирует сводку.
// Если у какого-то агента failure-rate >50% за 100 действий — эмитит
// 'a1.alert.agent_unhealthy'.
//
// Spec: docs/strategy/original/03 §3.0.

import type { BootContext, Module } from "../../core";

interface AgentCounters {
  executed: number;
  failed: number;
  lastFailReason: string | null;
}

let bootRefs: { eventBus: BootContext["eventBus"]; logger: BootContext["logger"] } | null = null;
const counters = new Map<string, AgentCounters>();

function bump(agent: string, ok: boolean, reason?: string): AgentCounters {
  const c = counters.get(agent) ?? { executed: 0, failed: 0, lastFailReason: null };
  if (ok) c.executed++;
  else {
    c.failed++;
    c.lastFailReason = reason ?? null;
  }
  counters.set(agent, c);
  return c;
}

async function checkHealth(agent: string, c: AgentCounters): Promise<void> {
  const total = c.executed + c.failed;
  if (total < 100) return;
  if (c.failed / total < 0.5) return;
  await bootRefs!.eventBus.emit(
    "a1.alert.agent_unhealthy",
    { agentName: agent, executed: c.executed, failed: c.failed, lastFailReason: c.lastFailReason },
    "agent-a1-master",
  );
}

const a1MasterModule: Module = {
  name: "agent-a1-master",
  version: "0.1.0",
  description: "Master controller — watches all agent.action.* events and alerts on unhealthy agents.",
  publishes: ["a1.alert.agent_unhealthy"],
  subscribes: {
    "agent.action.executed": async (event, _ctx) => {
      const p = event.payload as { agentName?: string } | null;
      if (!p?.agentName) return;
      bump(p.agentName, true);
    },
    "agent.action.failed": async (event, _ctx) => {
      const p = event.payload as { agentName?: string; error?: string } | null;
      if (!p?.agentName) return;
      const c = bump(p.agentName, false, p.error);
      await checkHealth(p.agentName, c);
    },
  },
  jobs: [
    {
      name: "a1-hourly-summary",
      schedule: "every_hour",
      handler: () => {
        if (!bootRefs) return;
        const summary = Array.from(counters.entries()).map(([name, c]) => ({
          agent: name,
          executed: c.executed,
          failed: c.failed,
          rate: c.executed + c.failed > 0 ? c.failed / (c.executed + c.failed) : 0,
        }));
        bootRefs.logger.info("a1 hourly summary", { agents: summary });
      },
    },
  ],
  onLoad: async (ctx) => {
    bootRefs = { eventBus: ctx.eventBus, logger: ctx.logger };
    ctx.logger.info("agent-a1-master online (watching all agent actions)");
  },
  healthCheck: () => ({
    status: "ok",
    details: {
      tracked_agents: counters.size,
      total_executions: Array.from(counters.values()).reduce((a, c) => a + c.executed, 0),
      total_failures: Array.from(counters.values()).reduce((a, c) => a + c.failed, 0),
    },
  }),
};

export default a1MasterModule;
