// ModuleRegistry — загружает модули в правильном порядке (топологически
// по dependencies), применяет миграции, монтирует роуты, подписывает на
// события, регистрирует jobs, пишет состояние в plugins_registry.
// Spec: docs/strategy/original/06-PLUGIN-АРХИТЕКТУРА-ХВОСТЫ.md §1.

import { sql } from "drizzle-orm";
import { db } from "../storage";
import { pluginsRegistry } from "@shared/schema";
import { createLogger } from "./logger";
import type { BootContext, Logger, Module } from "./types";

export class ModuleRegistry {
  private modules: Module[] = [];
  private loaded = new Set<string>();
  private readonly logger: Logger;

  constructor(logger: Logger = createLogger("registry")) {
    this.logger = logger;
  }

  register(modules: Module | Module[]): void {
    const arr = Array.isArray(modules) ? modules : [modules];
    for (const m of arr) {
      if (this.modules.find((x) => x.name === m.name)) {
        throw new Error(`module ${m.name} already registered`);
      }
      this.modules.push(m);
    }
  }

  async start(ctx: BootContext): Promise<void> {
    const sorted = topoSort(this.modules);
    for (const m of sorted) {
      try {
        await this.load(m, ctx);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        this.logger.error(`module ${m.name} failed to load`, { error: message });
        await this.markFailed(m, message);
      }
    }
  }

  list(): Module[] {
    return [...this.modules];
  }

  private async load(m: Module, ctx: BootContext): Promise<void> {
    if (m.migrations?.length) {
      for (const mig of m.migrations) {
        try {
          db.run(sql.raw(mig.up));
        } catch (err) {
          // Миграции v304 пишутся идемпотентно (CREATE TABLE IF NOT EXISTS,
          // ALTER TABLE с проверкой PRAGMA). Если что-то падает — логируем
          // и продолжаем; реальная проблема всплывёт в healthCheck.
          this.logger.warn(`migration ${m.name}/${mig.version} failed`, {
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }
    }

    if (m.subscribes) {
      for (const [eventName, handler] of Object.entries(m.subscribes)) {
        ctx.eventBus.subscribe(eventName, m.name, handler);
      }
    }

    if (m.routes) {
      const prefix = m.routes.prefix.startsWith("/") ? m.routes.prefix : `/${m.routes.prefix}`;
      ctx.app.use(`/api${prefix}`, m.routes.router);
    }

    if (m.onLoad) {
      await m.onLoad(ctx);
    }

    db.insert(pluginsRegistry)
      .values({
        name: m.name,
        version: m.version,
        status: "active",
        loadedAt: new Date().toISOString(),
        lastError: null,
      })
      .onConflictDoUpdate({
        target: pluginsRegistry.name,
        set: {
          version: m.version,
          status: "active",
          loadedAt: new Date().toISOString(),
          lastError: null,
        },
      })
      .run();

    this.loaded.add(m.name);
    this.logger.info(`module loaded`, { name: m.name, version: m.version });
  }

  private async markFailed(m: Module, error: string): Promise<void> {
    try {
      db.insert(pluginsRegistry)
        .values({
          name: m.name,
          version: m.version,
          status: "failed",
          loadedAt: new Date().toISOString(),
          lastError: error,
        })
        .onConflictDoUpdate({
          target: pluginsRegistry.name,
          set: { status: "failed", lastError: error },
        })
        .run();
    } catch {
      // Если БД ещё не готова к моменту первой ошибки — игнорируем.
    }
  }
}

function topoSort(modules: Module[]): Module[] {
  const byName = new Map(modules.map((m) => [m.name, m]));
  const result: Module[] = [];
  const visiting = new Set<string>();
  const visited = new Set<string>();

  const visit = (m: Module): void => {
    if (visited.has(m.name)) return;
    if (visiting.has(m.name)) {
      throw new Error(`circular dependency detected at ${m.name}`);
    }
    visiting.add(m.name);
    for (const depName of m.dependencies ?? []) {
      const dep = byName.get(depName);
      if (!dep) {
        throw new Error(`${m.name} depends on missing module ${depName}`);
      }
      visit(dep);
    }
    visiting.delete(m.name);
    visited.add(m.name);
    result.push(m);
  };

  for (const m of modules) visit(m);
  return result;
}
