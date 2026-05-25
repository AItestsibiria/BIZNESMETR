// Eugene 2026-05-25 Босс «заведи агента "фронт-тестер" (id frontend-qa) —
// непрерывно тестирует фронт глазами юзера, находит баги, записывает,
// докладывает Директору СО ССЫЛКОЙ на страницу, предлагает фикс, ведёт список».
//
// Плагин-обёртка над lib/frontendQaAgent.ts. Express + SQLite (НЕ внешние
// очереди). Endpoints под /api/admin/v304/frontend-qa (requireAdmin, envelope
// {data,error}):
//
//   GET  /frontend-qa/report      — список багов + ссылки + предложенные фиксы
//   POST /frontend-qa/scan-now    — запустить QA-скан сейчас (audit-log)
//   POST /frontend-qa/:id/mark    — сменить статус (open|proposed|fixed|ignored)
//
// Reuse-working-solutions: requireAdmin, recordAuditEntry, frontendQaAgent.
// Secrets-admin-only: в отчёт не попадают значения секретов.

import { Router, type Request, type Response } from "express";
import type { Module } from "../../core";
import { requireAdmin } from "../../core/adminAuth";
import { recordAuditEntry } from "../../lib/adminAuditLog";
import {
  ensureClientErrorsTable,
  runFrontendQaScan,
  runFrontendQaCycle,
  getLatestFrontendQaReport,
  markFrontendBug,
} from "../../lib/frontendQaAgent";

const adminRouter = Router();
adminRouter.use(requireAdmin);

// GET /frontend-qa/report — список багов фронта со ссылками + фиксами.
adminRouter.get("/frontend-qa/report", async (_req: Request, res: Response) => {
  try {
    const report = await getLatestFrontendQaReport();
    res.json({ data: report, error: null });
  } catch (e: any) {
    console.error("[Фрон отчёт]", e?.message || e);
    res.status(500).json({ data: null, error: "Не удалось получить отчёт Фронт-тестера" });
  }
});

// POST /frontend-qa/scan-now — запустить QA-скан (синтетика + фиксы) сейчас.
adminRouter.post("/frontend-qa/scan-now", async (req: Request, res: Response) => {
  try {
    const report = await runFrontendQaScan();
    recordAuditEntry({
      req,
      action: "create",
      entity: "frontend_qa_scan",
      entityKey: report.generatedAt,
      after: { openCount: report.openCount, criticalCount: report.criticalCount, via: "scan-now" },
    });
    res.json({ data: report, error: null });
  } catch (e: any) {
    console.error("[Фрон скан]", e?.message || e);
    res.status(500).json({ data: null, error: "Не удалось запустить QA-скан фронта" });
  }
});

// POST /frontend-qa/scan-cycle — прогон + повторная проходка после устранения
// багов + финальный ИТОГ по-русски (Босс «повторная проходка ещё раз, итог»).
adminRouter.post("/frontend-qa/scan-cycle", async (req: Request, res: Response) => {
  try {
    const report = await runFrontendQaCycle();
    recordAuditEntry({
      req,
      action: "create",
      entity: "frontend_qa_scan",
      entityKey: report.generatedAt,
      after: { openCount: report.openCount, criticalCount: report.criticalCount, via: "scan-cycle", rescanned: true },
    });
    res.json({ data: report, error: null });
  } catch (e: any) {
    console.error("[Фрон цикл]", e?.message || e);
    res.status(500).json({ data: null, error: "Не удалось выполнить цикл прогона с повторной проходкой" });
  }
});

// POST /frontend-qa/:id/mark — сменить статус бага.
adminRouter.post("/frontend-qa/:id/mark", (req: Request, res: Response) => {
  try {
    const id = parseInt(String(req.params.id), 10);
    const status = String(req.body?.status || "").trim();
    if (!Number.isFinite(id) || id <= 0) {
      return res.status(400).json({ data: null, error: "Неверный id" });
    }
    if (!["open", "proposed", "fixed", "ignored"].includes(status)) {
      return res.status(400).json({ data: null, error: "Неверный статус (open|proposed|fixed|ignored)" });
    }
    const ok = markFrontendBug(id, status);
    if (!ok) return res.status(404).json({ data: null, error: "Баг не найден" });
    recordAuditEntry({
      req,
      action: "update",
      entity: "frontend_qa_bug",
      entityKey: String(id),
      after: { status },
    });
    res.json({ data: { id, status }, error: null });
  } catch (e: any) {
    console.error("[Фрон статус]", e?.message || e);
    res.status(500).json({ data: null, error: "Не удалось обновить статус бага" });
  }
});

const frontendQaModule: Module = {
  name: "frontend-qa",
  version: "0.1.0",
  description:
    "Агент Фронт-тестер (подчинён Музa Директору) — баги фронта глазами юзера (client_errors + синтетика страниц) + ссылка + предложенный фикс. Отчёт по запросу + ежедневный скан.",
  onLoad: async (ctx) => {
    ensureClientErrorsTable();
    ctx.app.use("/api/admin/v304", adminRouter);
    ctx.logger.info("[Фрон] Агент онлайн — admin /api/admin/v304/frontend-qa (отчёт + скан + отметка статуса)");
  },
  healthCheck: () => ({ status: "ok" }),
};

export default frontendQaModule;
