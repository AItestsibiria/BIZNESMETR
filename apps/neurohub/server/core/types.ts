// v304 plugin foundation — public types.
// Spec: docs/strategy/original/06-PLUGIN-АРХИТЕКТУРА-ХВОСТЫ.md §1.

import type { Express, Router } from "express";

export interface BusEvent<P = unknown> {
  id: string;          // uuid v4
  name: string;        // e.g. 'auth.user.registered'
  payload: P;
  source: string;      // module name that emitted the event
  occurredAt: Date;
}

export interface ModuleContext {
  module: string;
  logger: Logger;
}

export interface Logger {
  info(msg: string, extra?: Record<string, unknown>): void;
  warn(msg: string, extra?: Record<string, unknown>): void;
  error(msg: string, extra?: Record<string, unknown>): void;
}

export type EventHandler<P = unknown> = (
  event: BusEvent<P>,
  ctx: ModuleContext,
) => Promise<void> | void;

export interface Migration {
  version: string;     // e.g. '001_initial.sql'
  up: string;          // SQL executed once on first load
}

export type JobSchedule =
  | "startup"
  | "every_minute"
  | "every_hour"
  | "every_day"
  | string;            // cron expression

export interface Job {
  name: string;
  schedule: JobSchedule;
  handler: () => Promise<void> | void;
}

export interface Module {
  name: string;
  version: string;
  description?: string;
  dependencies?: string[];
  migrations?: Migration[];
  routes?: { prefix: string; router: Router };
  jobs?: Job[];
  subscribes?: Record<string, EventHandler>;
  publishes?: string[];
  onLoad?: (ctx: BootContext) => Promise<void> | void;
  onUnload?: (ctx: BootContext) => Promise<void> | void;
  healthCheck?: () => Promise<HealthStatus> | HealthStatus;
}

export interface HealthStatus {
  status: "ok" | "degraded" | "down";
  details?: Record<string, unknown>;
}

export interface BootContext {
  app: Express;
  eventBus: EventBusContract;
  featureFlags: FeatureFlagsContract;
  logger: Logger;
}

export interface EventBusContract {
  emit<P>(name: string, payload: P, source: string): Promise<void>;
  subscribe<P>(name: string, module: string, handler: EventHandler<P>): void;
  unsubscribeModule(module: string): void;
}

export interface FeatureFlagsContract {
  isEnabled(key: string, userId?: number): boolean;
  getVariant(key: string, userId?: number): { name: string; payload?: unknown } | null;
  refresh(): void;
}
