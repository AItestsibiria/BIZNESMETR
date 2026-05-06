// In-process EventBus с персистом в таблицу events.
// Spec: docs/strategy/original/06-PLUGIN-АРХИТЕКТУРА-ХВОСТЫ.md §2.

import { randomUUID } from "node:crypto";
import { db } from "../storage";
import { events } from "@shared/schema";
import { createLogger } from "./logger";
import type {
  BusEvent,
  EventBusContract,
  EventHandler,
  Logger,
  ModuleContext,
} from "./types";

interface Subscription {
  module: string;
  handler: EventHandler;
}

const HANDLER_TIMEOUT_MS = 5000;

export class EventBus implements EventBusContract {
  private subs = new Map<string, Subscription[]>();
  private readonly logger: Logger;

  constructor(logger: Logger = createLogger("eventbus")) {
    this.logger = logger;
  }

  subscribe<P>(name: string, module: string, handler: EventHandler<P>): void {
    const arr = this.subs.get(name) ?? [];
    arr.push({ module, handler: handler as EventHandler });
    this.subs.set(name, arr);
  }

  unsubscribeModule(module: string): void {
    for (const [name, arr] of this.subs) {
      const filtered = arr.filter((s) => s.module !== module);
      if (filtered.length === 0) this.subs.delete(name);
      else this.subs.set(name, filtered);
    }
  }

  async emit<P>(name: string, payload: P, source: string): Promise<void> {
    const event: BusEvent<P> = {
      id: randomUUID(),
      name,
      payload,
      source,
      occurredAt: new Date(),
    };

    const direct = this.subs.get(name) ?? [];
    const wildcard = this.subs.get("*") ?? [];
    const handlers = [...direct, ...wildcard];

    let failed = 0;
    if (handlers.length > 0) {
      const results = await Promise.allSettled(
        handlers.map((sub) => this.invoke(sub, event)),
      );
      failed = results.filter((r) => r.status === "rejected").length;
    }

    try {
      db.insert(events)
        .values({
          id: event.id,
          name: event.name,
          payload: JSON.stringify(payload ?? null),
          sourceModule: source,
          userId: extractUserId(payload),
          leadId: extractLeadId(payload),
          handlersCount: handlers.length,
          handlersFailed: failed,
        })
        .run();
    } catch (err) {
      this.logger.error("failed to persist event", {
        eventName: name,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  private async invoke(sub: Subscription, event: BusEvent): Promise<void> {
    const ctx: ModuleContext = {
      module: sub.module,
      logger: createLogger(`plugin:${sub.module}`),
    };

    const handlerPromise = Promise.resolve().then(() => sub.handler(event, ctx));
    const timeout = new Promise<never>((_, reject) =>
      setTimeout(
        () => reject(new Error(`handler timeout after ${HANDLER_TIMEOUT_MS}ms`)),
        HANDLER_TIMEOUT_MS,
      ),
    );

    try {
      await Promise.race([handlerPromise, timeout]);
    } catch (err) {
      this.logger.error("handler failed", {
        event: event.name,
        module: sub.module,
        error: err instanceof Error ? err.message : String(err),
      });
      throw err;
    }
  }
}

function extractUserId(payload: unknown): number | null {
  if (payload && typeof payload === "object" && "userId" in payload) {
    const v = (payload as { userId?: unknown }).userId;
    return typeof v === "number" ? v : null;
  }
  return null;
}

function extractLeadId(payload: unknown): number | null {
  if (payload && typeof payload === "object" && "leadId" in payload) {
    const v = (payload as { leadId?: unknown }).leadId;
    return typeof v === "number" ? v : null;
  }
  return null;
}
