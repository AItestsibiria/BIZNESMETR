// v304 plugin: lead-capture
// Принимает touch-события с фронта (POST /api/lead-capture/touch),
// upsert в leads + tracking_attribution, эмитит lead.captured.
//
// Spec: docs/strategy/original/05 §3 (UTM), 07 §3.4 / §3.11.

import { Router } from "express";
import { z } from "zod";
import { eq } from "drizzle-orm";
import { db } from "../../storage";
import { leads, trackingAttribution } from "@shared/schema";
import type { BootContext, Module } from "../../core";

const TouchSchema = z.object({
  fingerprint: z.string().min(8).max(128),
  utm: z
    .object({
      source: z.string().optional(),
      medium: z.string().optional(),
      campaign: z.string().optional(),
      content: z.string().optional(),
      term: z.string().optional(),
    })
    .partial(),
  clickIds: z
    .object({
      yclid: z.string().optional(),
      vkClickid: z.string().optional(),
      gclid: z.string().optional(),
      fbclid: z.string().optional(),
    })
    .partial(),
  referer: z.string().nullable(),
  landingPage: z.string().max(2048),
  ts: z.string(),
});

let bootRefs: { eventBus: BootContext["eventBus"]; logger: BootContext["logger"] } | null = null;

const router = Router();

router.post("/touch", async (req, res) => {
  const parsed = TouchSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ data: null, error: "Invalid touch payload" });
  }
  const t = parsed.data;
  const ip = (req.headers["x-forwarded-for"]?.toString().split(",")[0] ?? req.ip ?? "").trim();
  const ua = req.headers["user-agent"] ?? "";

  try {
    const existing = db.select().from(leads).where(eq(leads.fingerprint, t.fingerprint)).get();
    let leadId: number;

    if (existing) {
      db.update(leads)
        .set({ lastSeen: t.ts })
        .where(eq(leads.id, existing.id))
        .run();
      leadId = existing.id;
    } else {
      const inserted = db
        .insert(leads)
        .values({
          fingerprint: t.fingerprint,
          status: "new",
          firstSeen: t.ts,
          lastSeen: t.ts,
        })
        .returning()
        .get();
      leadId = inserted.id;

      bootRefs?.eventBus.emit(
        "lead.captured",
        { leadId, fingerprint: t.fingerprint, source: t.utm.source ?? null },
        "lead-capture",
      );
    }

    // Upsert attribution. Хранение first-touch (если запись не существует)
    // и каждый раз обновление last-touch.
    const attr = db.select().from(trackingAttribution).where(eq(trackingAttribution.leadId, leadId)).get();
    if (attr) {
      db.update(trackingAttribution)
        .set({
          lastUtmSource: t.utm.source ?? null,
          lastUtmMedium: t.utm.medium ?? null,
          lastUtmCampaign: t.utm.campaign ?? null,
          lastUtmContent: t.utm.content ?? null,
          lastSeenAt: t.ts,
          ip: ip || null,
        })
        .where(eq(trackingAttribution.id, attr.id))
        .run();
    } else {
      db.insert(trackingAttribution)
        .values({
          leadId,
          firstUtmSource: t.utm.source ?? null,
          firstUtmMedium: t.utm.medium ?? null,
          firstUtmCampaign: t.utm.campaign ?? null,
          firstUtmContent: t.utm.content ?? null,
          firstReferer: t.referer,
          firstLandingPage: t.landingPage,
          firstSeenAt: t.ts,
          lastUtmSource: t.utm.source ?? null,
          lastUtmMedium: t.utm.medium ?? null,
          lastUtmCampaign: t.utm.campaign ?? null,
          lastUtmContent: t.utm.content ?? null,
          lastSeenAt: t.ts,
          yandexYclid: t.clickIds.yclid ?? null,
          vkClickid: t.clickIds.vkClickid ?? null,
          googleGclid: t.clickIds.gclid ?? null,
          metaFbclid: t.clickIds.fbclid ?? null,
          ip: ip || null,
          browser: parseUa(ua).browser,
          os: parseUa(ua).os,
        })
        .run();
    }

    return res.json({ data: { leadId }, error: null });
  } catch (err) {
    bootRefs?.logger.error("lead-capture/touch failed", {
      error: err instanceof Error ? err.message : String(err),
    });
    return res.status(500).json({ data: null, error: "internal" });
  }
});

// Лёгкий UA-парсер для browser/os без сторонних зависимостей.
function parseUa(ua: string): { browser: string | null; os: string | null } {
  const browser = /Chrome\/[\d.]+/.test(ua)
    ? "Chrome"
    : /Firefox\/[\d.]+/.test(ua)
    ? "Firefox"
    : /Safari\/[\d.]+/.test(ua) && !/Chrome/.test(ua)
    ? "Safari"
    : /Edg\/[\d.]+/.test(ua)
    ? "Edge"
    : null;
  const os = /Windows/.test(ua)
    ? "Windows"
    : /Mac OS X/.test(ua)
    ? "macOS"
    : /Android/.test(ua)
    ? "Android"
    : /iPhone|iPad/.test(ua)
    ? "iOS"
    : /Linux/.test(ua)
    ? "Linux"
    : null;
  return { browser, os };
}

const leadCaptureModule: Module = {
  name: "lead-capture",
  version: "0.1.0",
  description: "Captures anonymous visitors (UTM + fingerprint) into leads and tracking_attribution.",
  routes: { prefix: "lead-capture", router },
  publishes: ["lead.captured"],
  onLoad: async (ctx) => {
    bootRefs = { eventBus: ctx.eventBus, logger: ctx.logger };
    ctx.logger.info("lead-capture online");
  },
  healthCheck: () => ({ status: "ok" }),
};

export default leadCaptureModule;
