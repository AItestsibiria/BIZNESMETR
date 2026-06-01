// Public surface of the v304 plugin foundation.
//
// Usage in server/index.ts after registerRoutes:
//
//   const eventBus = new EventBus();
//   const featureFlags = new FeatureFlags();
//   const registry = new ModuleRegistry();
//   registry.register([notificationsModule, ...]);
//   await registry.start({ app, eventBus, featureFlags, logger });

export { EventBus } from "./eventBus";
export { FeatureFlags } from "./featureFlags";
export { ModuleRegistry } from "./moduleRegistry";
export { createLogger } from "./logger";

// Global registry holder — позволяет плагинам обращаться к братьям-плагинам
// (через registry.list() + healthCheck()) без знания глобального state.
import type { ModuleRegistry as MR } from "./moduleRegistry";
let _globalRegistry: MR | null = null;
export const setGlobalRegistry = (r: MR): void => { _globalRegistry = r; };
export const getGlobalRegistry = (): MR | null => _globalRegistry;

export type {
  BootContext,
  BusEvent,
  EventBusContract,
  EventHandler,
  FeatureFlagsContract,
  HealthStatus,
  Job,
  Logger,
  Migration,
  Module,
  ModuleContext,
} from "./types";
