// Eugene 2026-05-25 security hardening (LOW-RISK approved set).
//
// Плагин-обёртка над lib/securityAgent.ts + lib/autoBackup.ts. Express + SQLite.
// Endpoints под /api/admin/v304/security (requireAdmin, envelope {data,error}):
//
//   GET  /security/scan        — последний security-скан (on-demand read)
//   POST /security/scan-now    — запустить скан сейчас
//   POST /security/backup-now  — запустить app-level бэкап БД + audit-log
//
// Reuse-working-solutions: requireAdmin, recordAuditEntry, runSecurityScan,
// runDbBackup. Secrets-admin-only: вывод без значений секретов.

import { Router, type Request, type Response } from "express";
import type { Module } from "../../core";
import { requireAdmin } from "../../core/adminAuth";
import { recordAuditEntry } from "../../lib/adminAuditLog";
import { runSecurityScan, getLatestSecurityScan } from "../../lib/securityAgent";
import { runDbBackup, getLastBackup } from "../../lib/autoBackup";
import { sanitizeError } from "../../lib/sanitizeSecrets";

const adminRouter = Router();
adminRouter.use(requireAdmin);

// GET /security/scan — последний скан (read).
adminRouter.get("/security/scan", (_req: Request, res: Response) => {
  try {
    const scan = getLatestSecurityScan();
    const lastBackup = getLastBackup();
    res.json({ data: { scan, lastBackup }, error: null });
  } catch (e) {
    console.error("[security scan]", sanitizeError(e));
    res.status(500).json({ data: null, error: "Не удалось получить security-скан" });
  }
});

// POST /security/scan-now — запустить скан сейчас.
adminRouter.post("/security/scan-now", (req: Request, res: Response) => {
  try {
    const scan = runSecurityScan();
    recordAuditEntry({
      req,
      action: "create",
      entity: "security_scan",
      entityKey: scan.generatedAt,
      after: {
        findings: scan.findings.length,
        integrityOk: scan.integrityOk,
        backupAgeHours: scan.backupAgeHours,
        via: "scan-now",
      },
    });
    res.json({ data: scan, error: null });
  } catch (e) {
    console.error("[security scan-now]", sanitizeError(e));
    res.status(500).json({ data: null, error: "Не удалось запустить security-скан" });
  }
});

// POST /security/backup-now — запустить app-level бэкап БД.
adminRouter.post("/security/backup-now", async (req: Request, res: Response) => {
  try {
    const withAuthors = req.body?.withAuthors === true;
    const result = await runDbBackup({ withAuthors });
    recordAuditEntry({
      req,
      action: "create",
      entity: "db_backup",
      entityKey: result.path || `failed-${Date.now()}`,
      after: {
        ok: result.ok,
        kind: result.kind,
        sizeBytes: result.sizeBytes,
        // sha256 — целостность, не секрет.
        sha256: result.sha256,
        via: "backup-now",
      },
    });
    if (!result.ok) {
      return res.status(500).json({ data: null, error: result.error || "Бэкап не удался" });
    }
    res.json({ data: result, error: null });
  } catch (e) {
    console.error("[security backup-now]", sanitizeError(e));
    res.status(500).json({ data: null, error: "Не удалось запустить бэкап" });
  }
});

const securityModule: Module = {
  name: "security",
  version: "0.1.0",
  description:
    "Агент Безопасность (подчинён Музa Директору) — security-watchdog + app-level авто-бэкап БД. Скан по запросу + cron; бэкап 03:00 МСК (daily) / Вс 04:00 МСК (full).",
  onLoad: async (ctx) => {
    ctx.app.use("/api/admin/v304", adminRouter);
    ctx.logger.info("security online — admin /api/admin/v304/security (scan + scan-now + backup-now)");
  },
  healthCheck: () => ({ status: "ok" }),
};

export default securityModule;
