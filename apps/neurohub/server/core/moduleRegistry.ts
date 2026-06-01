// ModuleRegistry — загружает модули в правильном порядке (топологически
// по dependencies), применяет миграции, монтирует роуты, подписывает на
// события, регистрирует jobs, пишет состояние в plugins_registry.
// Spec: docs/strategy/original/06-PLUGIN-АРХИТЕКТУРА-ХВОСТЫ.md §1.

import { sql } from "drizzle-orm";
import { db } from "../storage";
import { pluginsRegistry } from "@shared/schema";
import { createLogger } from "./logger";
import type { BootContext, Job, Logger, Module } from "./types";

const INTERVAL_MS: Record<string, number> = {
  every_minute: 60 * 1000,
  every_hour: 60 * 60 * 1000,
  every_day: 24 * 60 * 60 * 1000,
};

export class ModuleRegistry {
  private modules: Module[] = [];
  private loaded = new Set<string>();
  private intervals: NodeJS.Timeout[] = [];
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

  isLoaded(name: string): boolean {
    return this.loaded.has(name);
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

    if (m.jobs?.length) {
      for (const job of m.jobs) {
        this.scheduleJob(m.name, job);
      }
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

  private scheduleJob(moduleName: string, job: Job): void {
    const runWithIsolation = async () => {
      try {
        await Promise.resolve(job.handler());
      } catch (err) {
        this.logger.error("job failed", {
          module: moduleName,
          job: job.name,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    };

    if (job.schedule === "startup") {
      // Запускаем разово, после полной загрузки реестра.
      setImmediate(runWithIsolation);
      return;
    }

    const intervalMs = INTERVAL_MS[job.schedule];
    if (!intervalMs) {
      // Cron-выражения пока не поддерживаются — зальём в Sprint 6 при
      // необходимости (через node-cron). Логируем skip.
      this.logger.warn("unsupported job schedule, skipping", {
        module: moduleName,
        job: job.name,
        schedule: job.schedule,
      });
      return;
    }

    // Первый запуск через intervalMs (не сразу, чтобы не нагружать boot).
    const handle = setInterval(runWithIsolation, intervalMs);
    // Не блокируем graceful shutdown:
    if (typeof handle.unref === "function") handle.unref();
    this.intervals.push(handle);
    this.logger.info("job scheduled", {
      module: moduleName,
      job: job.name,
      schedule: job.schedule,
      everyMs: intervalMs,
    });
  }

  /**
   * Останавливает все scheduled jobs. Вызывается на graceful shutdown.
   * Express SIGTERM-handler сам решит, в какой момент позвать.
   */
  stopJobs(): void {
    for (const h of this.intervals) clearInterval(h);
    this.intervals = [];
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
