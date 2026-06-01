// Общая утилита для агентов: запись агентского действия в agent_actions
// + эмит события agent.action.executed / agent.action.failed.
// Агенты — это легковесные subscribe'ы на EventBus. Каждое действие
// фиксируется для audit trail (07 §3.5).

import { db } from "../../storage";
import { agentActions } from "@shared/schema";
import type { EventBusContract, Logger } from "../../core";

export interface AgentRunInput {
  agentName: string;
  triggerEvent: string;
  userId?: number | null;
  leadId?: number | null;
  actionKind: string;
  payload?: unknown;
}

export interface AgentRunContext {
  eventBus: EventBusContract;
  logger: Logger;
}

/**
 * Запускает агентское действие. Создаёт запись в agent_actions со статусом
 * 'pending', вызывает handler, по результату обновляет на 'executed' или
 * 'failed'. Эмитит соответствующее событие в шину.
 */
export async function runAgentAction(
  input: AgentRunInput,
  ctx: AgentRunContext,
  handler: () => Promise<unknown> | unknown,
): Promise<{ ok: true; actionId: number; result: unknown } | { ok: false; actionId: number; error: string }> {
  const inserted = db
    .insert(agentActions)
    .values({
      agentName: input.agentName,
      triggerEvent: input.triggerEvent,
      userId: input.userId ?? null,
      leadId: input.leadId ?? null,
      actionKind: input.actionKind,
      actionPayload: input.payload === undefined ? null : JSON.stringify(input.payload ?? null),
      status: "pending",
    })
    .returning({ id: agentActions.id })
    .get();

  const actionId = inserted.id;

  try {
    const result = await Promise.resolve(handler());
    db.update(agentActions)
      .set({
        status: "executed",
        executedAt: new Date().toISOString(),
        result: result === undefined ? null : JSON.stringify(result ?? null),
      })
      .where(eqId(actionId))
      .run();

    await ctx.eventBus.emit(
      "agent.action.executed",
      { agentName: input.agentName, actionKind: input.actionKind, actionId, userId: input.userId, leadId: input.leadId },
      input.agentName,
    );

    return { ok: true, actionId, result };
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    db.update(agentActions)
      .set({
        status: "failed",
        executedAt: new Date().toISOString(),
        error: errorMsg,
      })
      .where(eqId(actionId))
      .run();

    ctx.logger.error("agent action failed", {
      agent: input.agentName,
      kind: input.actionKind,
      actionId,
      error: errorMsg,
    });

    await ctx.eventBus.emit(
      "agent.action.failed",
      { agentName: input.agentName, actionKind: input.actionKind, actionId, error: errorMsg },
      input.agentName,
    );

    return { ok: false, actionId, error: errorMsg };
  }
}

// Локальная утилита, чтобы не тащить eq() из drizzle в каждый агент.
import { eq } from "drizzle-orm";
function eqId(id: number) {
  return eq(agentActions.id, id);
}
