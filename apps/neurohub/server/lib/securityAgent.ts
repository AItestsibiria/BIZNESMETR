// Eugene 2026-05-25 security hardening (LOW-RISK approved set).
//
// Агент «Безопасность» (id "security") — подчинён Музa Директору
// (Director-subordination rule). watchdog: собирает СИГНАЛЫ из СУЩЕСТВУЮЩИХ
// источников (НЕ строит параллельные метрики) и докладывает Директору.
//
// === Reuse-working-solutions (НЕ дублируем метрики) ===
//  - user_action_failures — всплески failed-login (action LIKE 'login%').
//  - incidents — открытые инциденты.
//  - PRAGMA quick_check + размер БД (как ferzAgent.analyzeDb).
//  - getLastBackup (lib/autoBackup) — свежесть последнего успешного бэкапа.
//  - recordAgentActivity (lib/agentOrchestrator) — подчинение Директору.
//
// === Secrets-admin-only ===
// В findings НЕ попадают значения секретов — только статусы/счётчики. Любые
// логи ошибок проходят через sanitizeError().

import { db } from "../storage";
import { recordAgentActivity } from "./agentOrchestrator";
import { getLastBackup } from "./autoBackup";
import { sanitizeError } from "./sanitizeSecrets";

function sqlite(): any {
  return (db as any).$client;
}

export type SecuritySeverity = "critical" | "high" | "medium" | "low";

export interface SecurityFinding {
  severity: SecuritySeverity;
  /** Область: auth / incidents / db / backup. */
  area: string;
  title: string;
  detail: string;
}

export interface SecurityScan {
  generatedAt: string;
  findings: SecurityFinding[];
  backupAgeHours: number | null;
  integrityOk: boolean;
}

// Бэкап считается свежим если ему < 26 часов (daily в 03:00 МСК + запас).
const BACKUP_FRESH_HOURS = 26;

let _latest: SecurityScan | null = null;

// ====================== СИГНАЛЫ (read-only) ======================

/** 1) Всплеск неудачных логинов за последний час (user_action_failures). */
function analyzeLoginSpikes(findings: SecurityFinding[]): void {
  try {
    const hourAgoIso = new Date(Date.now() - 3600_000).toISOString();
    const row = sqlite()
      .prepare(
        `SELECT COUNT(*) AS c, COUNT(DISTINCT ip) AS ips, COUNT(DISTINCT user_id) AS users
         FROM user_action_failures
         WHERE action LIKE 'login%' AND created_at >= ?`,
      )
      .get(hourAgoIso) as { c: number; ips: number; users: number } | undefined;
    const c = Number(row?.c || 0);
    const ips = Number(row?.ips || 0);
    if (c >= 50) {
      findings.push({
        severity: c >= 200 ? "critical" : "high",
        area: "auth",
        title: "Всплеск неудачных логинов",
        detail: `За последний час ${c} неудачных попыток входа с ${ips} IP. Возможна brute-force атака — проверить rate-limit / блокировки.`,
      });
    } else if (c >= 15) {
      findings.push({
        severity: "medium",
        area: "auth",
        title: "Повышенное число неудачных логинов",
        detail: `За час ${c} неудачных попыток входа (${ips} IP). В пределах нормы, но стоит держать в поле зрения.`,
      });
    }
  } catch (e) {
    console.warn("[security] analyzeLoginSpikes failed:", sanitizeError(e));
  }
}

/** 2) Открытые инциденты (incidents). */
function analyzeIncidents(findings: SecurityFinding[]): void {
  try {
    const rows = sqlite()
      .prepare(
        `SELECT severity, COUNT(*) AS c FROM incidents WHERE status = 'open' GROUP BY severity`,
      )
      .all() as Array<{ severity: string; c: number }>;
    if (!rows.length) return;
    const total = rows.reduce((s, r) => s + Number(r.c || 0), 0);
    if (total === 0) return;
    const hasCritical = rows.some((r) => r.severity === "critical");
    findings.push({
      severity: hasCritical ? "critical" : "high",
      area: "incidents",
      title: "Открытые инциденты",
      detail:
        `Незакрытых инцидентов: ${total} (` +
        rows.map((r) => `${r.severity}=${r.c}`).join(", ") +
        "). Проверить incidents в админке.",
    });
  } catch (e) {
    console.warn("[security] analyzeIncidents failed:", sanitizeError(e));
  }
}

/** 3) Целостность БД (PRAGMA quick_check) + размер. Возвращает integrityOk. */
function analyzeDb(findings: SecurityFinding[]): boolean {
  let integrityOk = true;
  try {
    const s = sqlite();
    const qc = s.prepare(`PRAGMA quick_check(1)`).get() as any;
    const qcVal = qc ? Object.values(qc)[0] : null;
    if (qcVal && String(qcVal).toLowerCase() !== "ok") {
      integrityOk = false;
      findings.push({
        severity: "critical",
        area: "db",
        title: "Проблема целостности БД",
        detail: `PRAGMA quick_check вернул: ${String(qcVal).slice(0, 120)}. Срочно проверить data.db и восстановить из бэкапа при необходимости.`,
      });
    }

    const pc = Number((s.prepare(`PRAGMA page_count`).get() as any)?.page_count || 0);
    const ps = Number((s.prepare(`PRAGMA page_size`).get() as any)?.page_size || 0);
    const gb = (pc * ps) / (1024 * 1024 * 1024);
    if (gb >= 4) {
      findings.push({
        severity: gb >= 8 ? "high" : "medium",
        area: "db",
        title: "Большой размер БД",
        detail: `data.db ≈ ${gb.toFixed(2)} ГБ — бэкапы тяжелеют, растёт окно восстановления.`,
      });
    }
  } catch (e) {
    console.warn("[security] analyzeDb failed:", sanitizeError(e));
  }
  return integrityOk;
}

/** 4) Свежесть последнего успешного бэкапа. Возвращает backupAgeHours. */
function analyzeBackup(findings: SecurityFinding[]): number | null {
  try {
    const last = getLastBackup();
    if (!last || !last.createdAt) {
      findings.push({
        severity: "high",
        area: "backup",
        title: "Нет успешных бэкапов",
        detail: "В журнале backup_log нет ни одного успешного бэкапа. Запустить бэкап вручную (кнопка «Бэкап сейчас») и проверить cron AUTO_BACKUP.",
      });
      return null;
    }
    const ageHours = (Date.now() - last.createdAt) / 3600_000;
    if (ageHours > BACKUP_FRESH_HOURS) {
      findings.push({
        severity: ageHours > 72 ? "critical" : "high",
        area: "backup",
        title: "Бэкап устарел",
        detail: `Последний успешный бэкап ${ageHours.toFixed(1)} ч назад (> ${BACKUP_FRESH_HOURS} ч). Проверить cron AUTO_BACKUP и место на диске.`,
      });
    }
    return +ageHours.toFixed(1);
  } catch (e) {
    console.warn("[security] analyzeBackup failed:", sanitizeError(e));
    return null;
  }
}

// ====================== ENTRY POINTS ======================

/**
 * Запускает security-скан из существующих данных. Никогда не throw'ит.
 */
export function runSecurityScan(): SecurityScan {
  const findings: SecurityFinding[] = [];

  analyzeLoginSpikes(findings);
  analyzeIncidents(findings);
  const integrityOk = analyzeDb(findings);
  const backupAgeHours = analyzeBackup(findings);

  const order: Record<SecuritySeverity, number> = { critical: 0, high: 1, medium: 2, low: 3 };
  findings.sort((a, b) => order[a.severity] - order[b.severity]);

  const scan: SecurityScan = {
    generatedAt: new Date().toISOString(),
    findings,
    backupAgeHours,
    integrityOk,
  };
  _latest = scan;

  // Подчинение Директору — отмечаем активность (never throws).
  try {
    recordAgentActivity("security", {
      action: "run_scan",
      findings: findings.length,
      integrityOk,
      backupAgeHours,
    });
  } catch {
    /* never throw */
  }

  return scan;
}

/** Последний скан в памяти (или запускает свежий если ещё не было). */
export function getLatestSecurityScan(): SecurityScan {
  if (_latest) return _latest;
  return runSecurityScan();
}

/** Health probe для orchestrator.register healthCheck. */
export function securityHealth(): { ok: boolean; details: unknown } {
  try {
    const scan = runSecurityScan();
    const backupOk = scan.backupAgeHours != null && scan.backupAgeHours < BACKUP_FRESH_HOURS;
    const ok = scan.integrityOk && backupOk;
    return {
      ok,
      details: {
        integrityOk: scan.integrityOk,
        backupAgeHours: scan.backupAgeHours,
        backupFresh: backupOk,
        findings: scan.findings.length,
        critical: scan.findings.filter((f) => f.severity === "critical").length,
      },
    };
  } catch (e: any) {
    return { ok: false, details: { error: sanitizeError(e) } };
  }
}
