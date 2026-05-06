// v304 plugin: extend-cover (Sprint 3 skeleton).
// Регистрирует операции extend/cover/inpaint/stems как gen_extensions.
// Реальный вызов Suno extend/cover API — отложен (нужен ключ + новые
// эндпоинты GPTunnel). Сейчас endpoints проверяют входы, эмитят
// события и пишут запись в gen_extensions. Когда ключи будут — добавим
// тело call в обработчик 'gen.extend.requested'.
//
// Spec: docs/strategy/original/02 §1.5, §1.6, 07 §3.12.

import { Router } from "express";
import { eq, and } from "drizzle-orm";
import { z } from "zod";
import { db } from "../../storage";
import { genExtensions, generations } from "@shared/schema";
import type { BootContext, Module } from "../../core";

const ExtendSchema = z.object({
  sourceGenId: z.number().int().positive(),
  extraSeconds: z.number().int().min(10).max(180).default(60),
});

const CoverSchema = z.object({
  sourceGenId: z.number().int().positive().optional(),
  uploadUrl: z.string().url().max(2048).optional(),
  style: z.string().max(200),
}).refine(
  (v) => Boolean(v.sourceGenId) !== Boolean(v.uploadUrl),
  { message: "укажи либо sourceGenId, либо uploadUrl, но не оба" },
);

let bootRefs: { eventBus: BootContext["eventBus"]; logger: BootContext["logger"] } | null = null;

function getUserId(req: any): number | null {
  return (req?.session?.passport?.user ?? req?.session?.userId ?? null) as number | null;
}

const router = Router();

router.post("/extend", async (req, res) => {
  const userId = getUserId(req);
  if (!userId) return res.status(401).json({ data: null, error: "unauthorized" });

  const parsed = ExtendSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ data: null, error: parsed.error.issues[0]?.message ?? "invalid" });
  }

  const src = db
    .select()
    .from(generations)
    .where(and(eq(generations.id, parsed.data.sourceGenId), eq(generations.userId, userId)))
    .get();
  if (!src) return res.status(404).json({ data: null, error: "Исходный трек не найден" });
  if (src.type !== "music" || src.status !== "done") {
    return res.status(400).json({ data: null, error: "Расширять можно только готовый music-трек" });
  }

  bootRefs?.eventBus.emit(
    "gen.extend.requested",
    {
      userId,
      sourceGenId: parsed.data.sourceGenId,
      extraSeconds: parsed.data.extraSeconds,
    },
    "extend-cover",
  );

  // Заглушка: возвращаем pending. Когда Suno extend будет интегрирован,
  // обработчик 'gen.extend.requested' создаст result_gen_id и обновит
  // gen_extensions. См. spec 02 §1.5.
  res.json({
    data: { status: "queued", sourceGenId: parsed.data.sourceGenId },
    error: null,
  });
});

router.post("/cover", async (req, res) => {
  const userId = getUserId(req);
  if (!userId) return res.status(401).json({ data: null, error: "unauthorized" });

  const parsed = CoverSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ data: null, error: parsed.error.issues[0]?.message ?? "invalid" });
  }

  if (parsed.data.sourceGenId) {
    const src = db
      .select()
      .from(generations)
      .where(and(eq(generations.id, parsed.data.sourceGenId), eq(generations.userId, userId)))
      .get();
    if (!src) return res.status(404).json({ data: null, error: "Исходный трек не найден" });
  }

  bootRefs?.eventBus.emit(
    "gen.cover.requested",
    {
      userId,
      sourceGenId: parsed.data.sourceGenId,
      uploadUrl: parsed.data.uploadUrl,
      style: parsed.data.style,
    },
    "extend-cover",
  );

  res.json({
    data: { status: "queued", style: parsed.data.style },
    error: null,
  });
});

router.get("/relations/:genId", (req, res) => {
  const id = parseInt(req.params.genId, 10);
  if (!Number.isFinite(id)) return res.status(400).json({ data: null, error: "invalid genId" });

  const asSource = db.select().from(genExtensions).where(eq(genExtensions.sourceGenId, id)).all();
  const asResult = db.select().from(genExtensions).where(eq(genExtensions.resultGenId, id)).all();

  res.json({ data: { asSource, asResult }, error: null });
});

const extendCoverModule: Module = {
  name: "extend-cover",
  version: "0.1.0",
  description: "Sprint 3 skeleton — accepts extend/cover requests, emits events, returns queued.",
  routes: { prefix: "gen", router },
  publishes: ["gen.extend.requested", "gen.cover.requested", "gen.extension.completed"],
  onLoad: async (ctx) => {
    bootRefs = { eventBus: ctx.eventBus, logger: ctx.logger };
    ctx.logger.info("extend-cover online (skeleton)");
  },
  healthCheck: () => ({ status: "ok" }),
};

export default extendCoverModule;
