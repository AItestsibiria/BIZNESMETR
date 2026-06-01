// Eugene 2026-05-28 Босс — Durable-lite ядро (workflow).
//
// Лёгкий детерминированный backbone сценариев (lyrics / track / certificate /
// card / gift) на нашем стеке: Express + better-sqlite3 + SQLite. БЕЗ Temporal
// и любой внешней инфраструктуры / новых npm-зависимостей.
//
// Foundation-only: НИКАКОЙ бизнес-логики lyrics/gift/payment здесь нет —
// доменные команды регистрируются позже другими модулями через registerCommand().
//
// Гарантии (на них опираются будущие денежные команды):
//   - Idempotency — повтор команды с тем же idempotencyKey не выполняется заново,
//     возвращается сохранённый результат.
//   - Zod-валидация на границе — параметры команды проверяются до handler'а.
//   - Ownership — handler работает строго под ctx.userId.
//   - Никогда не throw'ит наружу — executeCommand всегда возвращает result-объект.
//   - Аудит + таймлайн — каждая команда пишет recordAuditEntry + workflow_events.
//
// Таблицы (server/storage.ts):
//   workflow_instances · workflow_events · workflow_idempotency.

import { z } from "zod";
import { sqliteDb } from "../storage";
import { recordAuditEntry } from "./adminAuditLog";
import type { WorkflowInstance, WorkflowEvent } from "@shared/schema";

// ──────────────────────────────────────────────────────────────────────────
// Типы
// ──────────────────────────────────────────────────────────────────────────

export type { WorkflowInstance, WorkflowEvent } from "@shared/schema";

export interface WorkflowContext {
  userId: number;
}

/**
 * API движка, передаётся в handler команды. Все операции backed by sqliteDb
 * и не throw'ят (на ошибке БД возвращают безопасный fallback / null).
 */
export interface WorkflowApi {
  /** Создать новый workflow-инстанс. Возвращает его id. */
  start(type: string, context?: Record<string, unknown>): number;
  /** Загрузить инстанс по id (без ownership-проверки — это internal API). */
  load(id: number): WorkflowInstance | null;
  /** Обновить инстанс (status / currentStep / context / result). */
  update(
    id: number,
    patch: {
      status?: WorkflowStatus;
      currentStep?: string;
      context?: Record<string, unknown>;
      result?: unknown;
      error?: string;
    },
  ): void;
  /** Записать событие в таймлайн workflow. */
  event(workflowId: number, type: string, payload?: unknown): void;
}

export type WorkflowStatus = "running" | "completed" | "failed" | "cancelled";

/** Результат handler'а команды. */
export interface CommandResult {
  workflowId?: number;
  step?: string;
  result?: unknown;
  done?: boolean;
  error?: string;
}

export type CommandHandler = (
  params: any,
  ctx: WorkflowContext,
  wf: WorkflowApi,
) => Promise<CommandResult>;

export interface CommandDefinition {
  schema: z.ZodTypeAny;
  handler: CommandHandler;
}

/** Итог executeCommand — всегда объект, наружу не throw'ит. */
export interface ExecuteResult {
  ok: boolean;
  error?: string;
  workflowId?: number;
  step?: string;
  result?: unknown;
  done?: boolean;
  /** true если результат отдан из idempotency-кэша (без повторного выполнения). */
  cached?: boolean;
}

// ──────────────────────────────────────────────────────────────────────────
// Реестр команд
// ──────────────────────────────────────────────────────────────────────────

const registry = new Map<string, CommandDefinition>();

/**
 * Регистрирует команду в движке. Доменные модули (lyrics / gift / ...) вызывают
 * это на старте, чтобы добавить свои сценарии без правок ядра.
 * Idempotent — повторная регистрация одного имени перезаписывает определение.
 */
export function registerCommand(name: string, def: CommandDefinition): void {
  registry.set(name, def);
}

/** Список зарегистрированных команд (для диагностики / admin UI). */
export function listCommands(): string[] {
  return Array.from(registry.keys());
}

// ──────────────────────────────────────────────────────────────────────────
// WorkflowApi (реализация на sqliteDb)
// ──────────────────────────────────────────────────────────────────────────

function safeParseJson<T = unknown>(raw: unknown, fallback: T): T {
  if (typeof raw !== "string" || !raw) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

const wfApi: WorkflowApi = {
  start(type: string, context: Record<string, unknown> = {}): number {
    const info = sqliteDb
      .prepare(
        `INSERT INTO workflow_instances (type, user_id, status, context_json)
         VALUES (?, ?, 'running', ?)`,
      )
      .run(type, (context as any)?.userId ?? 0, JSON.stringify(context ?? {}));
    return Number(info.lastInsertRowid);
  },

  load(id: number): WorkflowInstance | null {
    const row = sqliteDb
      .prepare(`SELECT * FROM workflow_instances WHERE id = ?`)
      .get(id) as any;
    return (row as WorkflowInstance) ?? null;
  },

  update(id, patch): void {
    const sets: string[] = [];
    const vals: unknown[] = [];
    if (patch.status !== undefined) {
      sets.push("status = ?");
      vals.push(patch.status);
      if (patch.status !== "running") {
        sets.push("completed_at = CURRENT_TIMESTAMP");
      }
    }
    if (patch.currentStep !== undefined) {
      sets.push("current_step = ?");
      vals.push(patch.currentStep);
    }
    if (patch.context !== undefined) {
      sets.push("context_json = ?");
      vals.push(JSON.stringify(patch.context ?? {}));
    }
    if (patch.result !== undefined) {
      sets.push("result_json = ?");
      vals.push(JSON.stringify(patch.result));
    }
    if (patch.error !== undefined) {
      sets.push("error_text = ?");
      vals.push(patch.error);
    }
    if (sets.length === 0) return;
    sets.push("updated_at = CURRENT_TIMESTAMP");
    vals.push(id);
    sqliteDb
      .prepare(`UPDATE workflow_instances SET ${sets.join(", ")} WHERE id = ?`)
      .run(...(vals as any[]));
  },

  event(workflowId: number, type: string, payload?: unknown): void {
    const wf = this.load(workflowId);
    const userId = wf?.userId ?? 0;
    sqliteDb
      .prepare(
        `INSERT INTO workflow_events (workflow_id, user_id, type, payload_json)
         VALUES (?, ?, ?, ?)`,
      )
      .run(
        workflowId,
        userId,
        type,
        payload === undefined ? null : JSON.stringify(payload),
      );
  },
};

// ──────────────────────────────────────────────────────────────────────────
// Публичные хелперы (ownership-aware где нужно)
// ──────────────────────────────────────────────────────────────────────────

/** Создать workflow с привязкой к userId (ownership). Возвращает id или null. */
export function startWorkflow(
  type: string,
  userId: number,
  context: Record<string, unknown> = {},
): number | null {
  try {
    return wfApi.start(type, { ...context, userId });
  } catch (e) {
    console.error("[workflow] startWorkflow failed:", e);
    return null;
  }
}

/** Записать событие в таймлайн. Never-throws. */
export function recordWorkflowEvent(
  workflowId: number,
  type: string,
  payload?: unknown,
): void {
  try {
    wfApi.event(workflowId, type, payload);
  } catch (e) {
    console.error("[workflow] recordWorkflowEvent failed:", e);
  }
}

/**
 * Получить workflow с проверкой владельца + его таймлайн. Возвращает
 * { instance, events } или null если не найден / не принадлежит userId.
 */
export function getWorkflow(
  id: number,
  userId: number,
): { instance: WorkflowInstance; events: WorkflowEvent[] } | null {
  try {
    const row = sqliteDb
      .prepare(`SELECT * FROM workflow_instances WHERE id = ?`)
      .get(id) as WorkflowInstance | undefined;
    if (!row) return null;
    if (Number(row.userId) !== Number(userId)) return null; // ownership guard
    const events = sqliteDb
      .prepare(
        `SELECT * FROM workflow_events WHERE workflow_id = ? ORDER BY id ASC`,
      )
      .all(id) as WorkflowEvent[];
    return { instance: row, events };
  } catch (e) {
    console.error("[workflow] getWorkflow failed:", e);
    return null;
  }
}

/** Список workflow-ов юзера с опциональными фильтрами type / status. */
export function listWorkflows(
  userId: number,
  filters: { type?: string; status?: string } = {},
): WorkflowInstance[] {
  try {
    const where: string[] = ["user_id = ?"];
    const vals: unknown[] = [userId];
    if (filters.type) {
      where.push("type = ?");
      vals.push(filters.type);
    }
    if (filters.status) {
      where.push("status = ?");
      vals.push(filters.status);
    }
    return sqliteDb
      .prepare(
        `SELECT * FROM workflow_instances
         WHERE ${where.join(" AND ")}
         ORDER BY id DESC LIMIT 200`,
      )
      .all(...(vals as any[])) as WorkflowInstance[];
  } catch (e) {
    console.error("[workflow] listWorkflows failed:", e);
    return [];
  }
}

// ──────────────────────────────────────────────────────────────────────────
// executeCommand — единая точка входа
// ──────────────────────────────────────────────────────────────────────────

export async function executeCommand(input: {
  userId: number;
  command: string;
  params?: unknown;
  idempotencyKey?: string;
}): Promise<ExecuteResult> {
  const { userId, command } = input;

  // (a) команда известна?
  const def = registry.get(command);
  if (!def) {
    return { ok: false, error: "Неизвестная команда" };
  }

  // (b) Zod-валидация параметров
  const parsed = def.schema.safeParse(input.params ?? {});
  if (!parsed.success) {
    const msg =
      parsed.error.errors?.[0]?.message || "Некорректные параметры команды";
    return { ok: false, error: msg };
  }

  // (c) idempotency — уже выполняли с этим ключом?
  if (input.idempotencyKey) {
    try {
      const seen = sqliteDb
        .prepare(`SELECT * FROM workflow_idempotency WHERE key = ?`)
        .get(input.idempotencyKey) as
        | { workflow_id: number | null; result_json: string | null }
        | undefined;
      if (seen) {
        const stored = safeParseJson<ExecuteResult>(seen.result_json, {
          ok: true,
        });
        return { ...stored, cached: true };
      }
    } catch (e) {
      console.error("[workflow] idempotency lookup failed:", e);
      // продолжаем — лучше выполнить, чем упасть
    }
  }

  // (d) выполнить handler (никогда не throw'им наружу)
  let result: ExecuteResult;
  try {
    const hr = await def.handler(parsed.data, { userId }, wfApi);
    if (hr.error) {
      result = {
        ok: false,
        error: hr.error,
        workflowId: hr.workflowId,
        step: hr.step,
      };
    } else {
      result = {
        ok: true,
        workflowId: hr.workflowId,
        step: hr.step,
        result: hr.result,
        done: hr.done,
      };
    }
  } catch (e) {
    console.error(`[workflow] command "${command}" handler threw:`, e);
    return { ok: false, error: "Внутренняя ошибка выполнения команды" };
  }

  // (e) сохранить idempotency-результат (только при наличии ключа)
  if (input.idempotencyKey) {
    try {
      sqliteDb
        .prepare(
          `INSERT OR IGNORE INTO workflow_idempotency (key, workflow_id, result_json)
           VALUES (?, ?, ?)`,
        )
        .run(
          input.idempotencyKey,
          result.workflowId ?? null,
          JSON.stringify(result),
        );
    } catch (e) {
      console.error("[workflow] idempotency persist failed:", e);
    }
  }

  // (f) аудит + таймлайн
  try {
    recordAuditEntry({
      adminUserId: userId,
      action: "create",
      entity: `workflow_command:${command}`,
      entityKey: String(result.workflowId ?? input.idempotencyKey ?? "-"),
      after: { command, ok: result.ok, step: result.step, done: result.done },
    });
  } catch (e) {
    console.error("[workflow] audit failed:", e);
  }
  if (result.workflowId) {
    recordWorkflowEvent(result.workflowId, `command:${command}`, {
      ok: result.ok,
      step: result.step,
      done: result.done,
    });
  }

  return result;
}

// ──────────────────────────────────────────────────────────────────────────
// Демо-команда ping_workflow — no-op для проверки endpoint'а.
// Реальные доменные команды (lyrics / gift / ...) регистрируются отдельно.
// ──────────────────────────────────────────────────────────────────────────

registerCommand("ping_workflow", {
  schema: z.object({
    note: z.string().max(200).optional(),
  }),
  handler: async (params, ctx, wf) => {
    const id = wf.start("ping", { userId: ctx.userId, note: params.note });
    wf.event(id, "started", { note: params.note ?? null });
    wf.update(id, {
      status: "completed",
      currentStep: "done",
      result: { pong: true, at: Date.now() },
    });
    wf.event(id, "completed", { pong: true });
    return {
      workflowId: id,
      step: "done",
      done: true,
      result: { pong: true },
    };
  },
});
