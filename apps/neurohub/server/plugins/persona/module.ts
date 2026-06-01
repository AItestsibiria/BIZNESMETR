// v304 plugin: persona (Sprint 3 skeleton).
// CRUD для пользовательских personas — стабильного голоса между треками.
// Реальный вызов Suno persona-creation API — отложен до момента, когда
// в .env появится GPTUNNEL_API_KEY с persona-доступом. Сейчас плагин
// фиксирует факт регистрации persona в БД и эмитит событие.
//
// Spec: docs/strategy/original/02 §1.4, 07 §3.12.

import { Router } from "express";
import { eq, and } from "drizzle-orm";
import { z } from "zod";
import { randomUUID } from "node:crypto";
import { db } from "../../storage";
import { personas, generations } from "@shared/schema";
import type { BootContext, Module } from "../../core";

const CreatePersonaSchema = z.object({
  sourceGenId: z.number().int().positive(),
  displayName: z.string().min(1).max(80),
  description: z.string().max(500).optional(),
});

let bootRefs: { eventBus: BootContext["eventBus"]; logger: BootContext["logger"] } | null = null;

function getUserId(req: any): number | null {
  // Совместимо с существующей сессией v51 (passport).
  return (req?.session?.passport?.user ?? req?.session?.userId ?? null) as number | null;
}

const router = Router();

router.post("/", async (req, res) => {
  const userId = getUserId(req);
  if (!userId) return res.status(401).json({ data: null, error: "unauthorized" });

  const parsed = CreatePersonaSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ data: null, error: parsed.error.issues[0]?.message ?? "invalid" });
  }

  // Источник должен принадлежать пользователю и быть готовым music-треком.
  const src = db
    .select()
    .from(generations)
    .where(and(eq(generations.id, parsed.data.sourceGenId), eq(generations.userId, userId)))
    .get();
  if (!src) return res.status(404).json({ data: null, error: "Исходный трек не найден" });
  if (src.type !== "music") return res.status(400).json({ data: null, error: "Persona только из музыкальных треков" });
  if (src.status !== "done") return res.status(400).json({ data: null, error: "Трек ещё не готов" });

  const id = randomUUID();
  db.insert(personas)
    .values({
      id,
      userId,
      displayName: parsed.data.displayName,
      description: parsed.data.description ?? null,
      sourceGenId: parsed.data.sourceGenId,
      sunoPersonaId: null, // заполнится после реального вызова Suno (Sprint 3.1)
      useCount: 0,
      isPublic: 0,
    })
    .run();

  bootRefs?.eventBus.emit(
    "persona.created",
    { personaId: id, userId, sourceGenId: parsed.data.sourceGenId },
    "persona",
  );

  res.json({ data: { id, displayName: parsed.data.displayName }, error: null });
});

router.get("/", (req, res) => {
  const userId = getUserId(req);
  if (!userId) return res.status(401).json({ data: null, error: "unauthorized" });

  const list = db
    .select()
    .from(personas)
    .where(eq(personas.userId, userId))
    .all();
  res.json({ data: list, error: null });
});

router.delete("/:id", (req, res) => {
  const userId = getUserId(req);
  if (!userId) return res.status(401).json({ data: null, error: "unauthorized" });

  const id = String(req.params.id);
  const found = db.select().from(personas).where(and(eq(personas.id, id), eq(personas.userId, userId))).get();
  if (!found) return res.status(404).json({ data: null, error: "Persona не найдена" });

  db.delete(personas).where(eq(personas.id, id)).run();
  bootRefs?.eventBus.emit("persona.deleted", { personaId: id, userId }, "persona");
  res.json({ data: { ok: true }, error: null });
});

const personaModule: Module = {
  name: "persona",
  version: "0.1.0",
  description: "Sprint 3 skeleton — registers user personas in DB; Suno-side wiring deferred.",
  routes: { prefix: "personas", router },
  publishes: ["persona.created", "persona.deleted"],
  onLoad: async (ctx) => {
    bootRefs = { eventBus: ctx.eventBus, logger: ctx.logger };
    ctx.logger.info("persona online (skeleton)");
  },
  healthCheck: () => ({ status: "ok" }),
};

export default personaModule;
