// Eugene 2026-05-25 Босс «создай агента "Бэк" — бэкенд-аналог Фрона. Находит
// баги/рискованные места, лишнее (dead code), дубли (endpoints/функции),
// группирует бэкенд по темам. Подчинён Музa Директору».
//
// Плагин-обёртка над lib/backendQaAgent.ts. Express + SQLite (НЕ внешние
// очереди). Endpoints под /api/admin/v304/backend-qa (requireAdmin, envelope
// {data,error}):
//
//   GET  /backend-qa/report     — список находок по темам + русский ИТОГ
//   POST /backend-qa/scan-now   — запустить бэкенд-аудит сейчас (audit-log)
//   POST /backend-qa/:id/mark   — сменить статус (open|fixed|ignored)
//
// КРИТИЧНО: агент только ДЕТЕКТИРУЕТ + ПРЕДЛАГАЕТ. Удаление дублей/мёртвого кода
// — только после ревью Босса (Pre-push critical review rule). Endpoint /mark
// меняет лишь статус находки в БД, никакой код не правится.
//
// Reuse-working-solutions: requireAdmin, recordAuditEntry, backendQaAgent.
// Secrets-admin-only: в отчёт не попадают значения секретов.

import { Router, type Request, type Response } from "express";
import type { Module } from "../../core";
import { requireAdmin } from "../../core/adminAuth";
import { recordAuditEntry } from "../../lib/adminAuditLog";
import {
  ensureBackendFindingsTable,
  runBackendQaScan,
  getLatestBackendQaReport,
  markBackendFinding,
} from "../../lib/backendQaAgent";

const adminRouter = Router();
adminRouter.use(requireAdmin);

// GET /backend-qa/report — список находок бэкенда по темам + русский ИТОГ.
adminRouter.get("/backend-qa/report", (_req: Request, res: Response) => {
  try {
    const report = getLatestBackendQaReport();
    res.json({ data: report, error: null });
  } catch (e: any) {
    console.error("[Бэк отчёт]", e?.message || e);
    res.status(500).json({ data: null, error: "Не удалось получить отчёт агента Бэк" });
  }
});

// POST /backend-qa/scan-now — запустить бэкенд-аудит сейчас.
adminRouter.post("/backend-qa/scan-now", async (req: Request, res: Response) => {
  try {
    const report = await runBackendQaScan();
    recordAuditEntry({
      req,
      action: "create",
      entity: "backend_qa_scan",
      entityKey: report.generatedAt,
      after: { openCount: report.openCount, bySeverity: report.bySeverity, via: "scan-now" },
    });
    res.json({ data: report, error: null });
  } catch (e: any) {
    console.error("[Бэк скан]", e?.message || e);
    res.status(500).json({ data: null, error: "Не удалось запустить бэкенд-аудит" });
  }
});

// POST /backend-qa/:id/mark — сменить статус находки.
adminRouter.post("/backend-qa/:id/mark", (req: Request, res: Response) => {
  try {
    const id = parseInt(String(req.params.id), 10);
    const status = String(req.body?.status || "").trim();
    if (!Number.isFinite(id) || id <= 0) {
      return res.status(400).json({ data: null, error: "Неверный id" });
    }
    if (!["open", "fixed", "ignored"].includes(status)) {
      return res.status(400).json({ data: null, error: "Неверный статус (open|fixed|ignored)" });
    }
    const ok = markBackendFinding(id, status);
    if (!ok) return res.status(404).json({ data: null, error: "Находка не найдена" });
    recordAuditEntry({
      req,
      action: "update",
      entity: "backend_qa_finding",
      entityKey: String(id),
      after: { status },
    });
    res.json({ data: { id, status }, error: null });
  } catch (e: any) {
    console.error("[Бэк статус]", e?.message || e);
    res.status(500).json({ data: null, error: "Не удалось обновить статус находки" });
  }
});

const backendQaModule: Module = {
  name: "backend-qa",
  version: "0.1.0",
  description:
    "Агент Бэк (подчинён Музa Директору) — бэкенд-аудит: дубли маршрутов/функций, лишнее (мёртвый код), техдолг, группировка по темам. Только детект + доклад + предложение (НЕ удаляет код). Отчёт по запросу + скан.",
  onLoad: async (ctx) => {
    ensureBackendFindingsTable();
    ctx.app.use("/api/admin/v304", adminRouter);
    ctx.logger.info("[Бэк] Агент онлайн — admin /api/admin/v304/backend-qa (отчёт + скан + отметка статуса)");
  },
  healthCheck: () => ({ status: "ok" }),
};

export default backendQaModule;
