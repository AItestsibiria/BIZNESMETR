// Eugene 2026-05-25 Босс «заведи агента Ферзь (id ferz) — находит недостатки в
// работе системы, узкие места. Докладывает Директору: (a) по запросу, (b)
// ежедневно 04:00 МСК».
//
// Плагин-обёртка над lib/ferzAgent.ts. Express + SQLite (НЕ внешние очереди).
// Endpoints под /api/admin/v304/ferz (requireAdmin, envelope {data,error}):
//
//   GET  /ferz/report   — последний сохранённый отчёт (on-demand read)
//   POST /ferz/run-now  — запустить аудит сейчас, вернуть свежий отчёт + audit-log
//
// Reuse-working-solutions: requireAdmin, recordAuditEntry, runFerzAnalysis.
// Secrets-admin-only: отчёт без значений секретов (только статусы/счётчики).

import { Router, type Request, type Response } from "express";
import type { Module } from "../../core";
import { requireAdmin } from "../../core/adminAuth";
import { recordAuditEntry } from "../../lib/adminAuditLog";
import { ensureFerzTable, runFerzAnalysis, getLatestFerzReport } from "../../lib/ferzAgent";

const adminRouter = Router();
adminRouter.use(requireAdmin);

// GET /ferz/report — последний отчёт (on-demand read).
adminRouter.get("/ferz/report", (_req: Request, res: Response) => {
  try {
    const report = getLatestFerzReport();
    res.json({ data: report, error: null });
  } catch (e: any) {
    console.error("[ferz report]", e?.message || e);
    res.status(500).json({ data: null, error: "Не удалось получить отчёт Ферзя" });
  }
});

// POST /ferz/run-now — запуск аудита сейчас.
adminRouter.post("/ferz/run-now", async (req: Request, res: Response) => {
  try {
    const period = typeof req.body?.period === "string" ? req.body.period : undefined;
    const report = await runFerzAnalysis({ period });
    recordAuditEntry({
      req,
      action: "create",
      entity: "ferz_report",
      entityKey: report.generatedAt,
      after: {
        findings: report.findings.length,
        severityCounts: report.severityCounts,
        via: "run-now",
      },
    });
    res.json({ data: report, error: null });
  } catch (e: any) {
    console.error("[ferz run-now]", e?.message || e);
    res.status(500).json({ data: null, error: "Не удалось запустить аудит Ферзя" });
  }
});

const ferzModule: Module = {
  name: "ferz",
  version: "0.1.0",
  description:
    "Агент Ферзь (подчинён Музa Директору) — аудит слабых мест и узких мест системы. Отчёт по запросу + ежедневно 04:00 МСК.",
  onLoad: async (ctx) => {
    ensureFerzTable();
    ctx.app.use("/api/admin/v304", adminRouter);
    ctx.logger.info("ferz online — admin /api/admin/v304/ferz (report + run-now)");
  },
  healthCheck: () => ({ status: "ok" }),
};

export default ferzModule;
