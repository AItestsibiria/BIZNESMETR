// Feature flags с кэшем в памяти.
// Spec: docs/strategy/original/06-PLUGIN-АРХИТЕКТУРА-ХВОСТЫ.md §4.
// Источник правды — таблица feature_flags. refresh() перечитывает её.

import { db } from "../storage";
import { featureFlags } from "@shared/schema";
import { createLogger } from "./logger";
import type { FeatureFlagsContract, Logger } from "./types";

interface CachedFlag {
  enabled: boolean;
  rolloutPercent: number;
  abVariants: Variant[] | null;
}

interface Variant {
  name: string;
  weight: number;
  payload?: unknown;
}

export class FeatureFlags implements FeatureFlagsContract {
  private cache = new Map<string, CachedFlag>();
  private readonly logger: Logger;

  constructor(logger: Logger = createLogger("flags")) {
    this.logger = logger;
    this.refresh();
  }

  refresh(): void {
    try {
      const rows = db.select().from(featureFlags).all();
      this.cache.clear();
      for (const row of rows) {
        this.cache.set(row.key, {
          enabled: row.enabled === 1,
          rolloutPercent: row.rolloutPercent ?? 100,
          abVariants: parseVariants(row.abVariants),
        });
      }
      this.logger.info(`refreshed ${rows.length} flags`);
    } catch (err) {
      this.logger.error("refresh failed", {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  isEnabled(key: string, userId?: number): boolean {
    const flag = this.cache.get(key);
    if (!flag || !flag.enabled) return false;
    if (flag.rolloutPercent >= 100) return true;
    if (flag.rolloutPercent <= 0) return false;
    return bucket(key, userId) < flag.rolloutPercent;
  }

  getVariant(
    key: string,
    userId?: number,
  ): { name: string; payload?: unknown } | null {
    const flag = this.cache.get(key);
    if (!flag || !flag.enabled || !flag.abVariants?.length) return null;
    const totalWeight = flag.abVariants.reduce((s, v) => s + v.weight, 0);
    if (totalWeight <= 0) return null;
    const pick = (bucket(key, userId) / 100) * totalWeight;
    let acc = 0;
    for (const v of flag.abVariants) {
      acc += v.weight;
      if (pick < acc) return { name: v.name, payload: v.payload };
    }
    const last = flag.abVariants[flag.abVariants.length - 1];
    return { name: last.name, payload: last.payload };
  }
}

function parseVariants(json: string | null): Variant[] | null {
  if (!json) return null;
  try {
    const parsed = JSON.parse(json);
    if (!Array.isArray(parsed)) return null;
    return parsed.filter(
      (v): v is Variant =>
        v && typeof v.name === "string" && typeof v.weight === "number",
    );
  } catch {
    return null;
  }
}

// Detirministic 0..99 bucket per (flagKey, userId).
// Stable across processes — same key + same user -> same bucket.
function bucket(key: string, userId?: number): number {
  const seed = userId === undefined ? key : `${key}:${userId}`;
  let h = 0;
  for (let i = 0; i < seed.length; i++) {
    h = (h * 31 + seed.charCodeAt(i)) | 0;
  }
  return Math.abs(h) % 100;
}
