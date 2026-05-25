// Eugene 2026-05-25 Босс «заведи агента Ферзь (id ferz) — находит недостатки в
// работе системы, узкие места. Докладывает Директору: (a) по запросу, (b)
// ежедневно в 04:00 МСК».
//
// Агент «Ферзь» (id "ferz") — подчинён Музa Директору (Director-subordination
// rule). watchdog-агент аудита: собирает СИГНАЛЫ из СУЩЕСТВУЮЩИХ источников
// данных (НЕ строит параллельные метрики), приоритизирует находки по severity
// и складывает отчёт в self-migrating таблицу `ferz_reports`.
//
// === Реальный стек ===
// Express + SQLite data.db (НЕ внешние очереди/брокеры). Self-migrating
// CREATE TABLE IF NOT EXISTS (как ensurePublicationsTable / ensurePostmanTables).
//
// === Reuse-working-solutions (НЕ дублируем метрики) ===
//  - orchestrator (lib/agentOrchestrator) — здоровье/активность агентов.
//  - user_action_failures — те же запросы что admin user-failures endpoint.
//  - incidents — открытые инциденты.
//  - generations — stuck/errored/refunded (как master-dashboard / genLifecycle).
//  - payments — fail-rate (как master-dashboard / payment-health healthCheck).
//  - getKeySwitchEvents / getLLMKeyStatus (lib/llmCore) — LLM key health.
//  - getPeriodRange (lib/periodBoundaries) — границы периода (Period-20-МСК rule).
//  - callUnifiedMuzaLLM (lib/llmCore) — опциональный narrative summary.
//  - recordAgentActivity (lib/agentOrchestrator) — Ферзь подчинён Директору.
//
// === No-AI-providers-in-userland rule ===
// summary может строиться через LLM, но НИКОГДА не называет ИИ-провайдеров.
// Если LLM недоступен — summary собирается детерминированно из находок.
//
// === Secrets-admin-only rule ===
// В отчёт НЕ попадают значения секретов — только статусы / счётчики / маски.

import { db } from "../storage";
import { orchestrator } from "./agentOrchestrator";
import { recordAgentActivity } from "./agentOrchestrator";
import { getPeriodRange } from "./periodBoundaries";
import { getKeySwitchEvents, getLLMKeyStatus } from "./llmCore";

export type FerzSeverity = "critical" | "high" | "medium" | "low";

export interface FerzFinding {
  severity: FerzSeverity;
  /** Область: agents / failures / incidents / generations / llm / payments / db / bottleneck. */
  area: string;
  title: string;
  detail: string;
  /** Короткая числовая метрика для UI ("3 агента", "12 / 50", "8.5%"). */
  metric?: string;
}

export interface FerzReport {
  generatedAt: string;
  severityCounts: Record<FerzSeverity, number>;
  findings: FerzFinding[];
  summary: string;
}

function sqlite(): any {
  return (db as any).$client;
}

// === Auto-migrate (self-migrating) ===

let migrated = false;
export function ensureFerzTable(): void {
  if (migrated) return;
  try {
    sqlite().exec(`
      CREATE TABLE IF NOT EXISTS ferz_reports (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        created_at INTEGER NOT NULL,
        severity_counts TEXT,
        findings TEXT,
        summary TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_ferz_reports_created ON ferz_reports(created_at DESC);
    `);
    migrated = true;
  } catch (e) {
    console.warn("[ferz] migration failed:", e);
  }
}

const SEVERITY_ORDER: Record<FerzSeverity, number> = { critical: 0, high: 1, medium: 2, low: 3 };

function emptyCounts(): Record<FerzSeverity, number> {
  return { critical: 0, high: 0, medium: 0, low: 0 };
}

// Возраст «протух» для lastSeenAt агента (12 часов) — если активный агент
// молчит дольше, это узкое место (cron не тикает / канал не получает трафик).
const STALE_MS = 12 * 3600_000;

// ====================== СИГНАЛЫ (read-only из существующих таблиц) ======================

/** 1) Здоровье агентов Директора: not_configured / error / stale / 0-activity. */
function analyzeAgents(findings: FerzFinding[]): void {
  try {
    const agents = orchestrator.list();
    const now = Date.now();

    const errored = agents.filter((a) => a.status === "error");
    const notConfigured = agents.filter((a) => a.status === "not_configured");
    // «Молчащие» — active, но lastSeenAt старше STALE_MS (или вовсе нет активности).
    // Для cron/internal агентов это нормально на свежем старте, поэтому отдельно
    // помечаем как low/medium, не critical.
    const stale = agents.filter(
      (a) => a.status === "active" && (a.lastSeenAt == null || now - a.lastSeenAt > STALE_MS),
    );

    if (errored.length > 0) {
      findings.push({
        severity: "critical",
        area: "agents",
        title: "Агенты в состоянии ошибки",
        detail: `Агенты с status=error: ${errored.map((a) => a.name).join(", ")}. Требуют внимания Директора.`,
        metric: `${errored.length} агент(ов)`,
      });
    }
    if (notConfigured.length > 0) {
      findings.push({
        severity: "medium",
        area: "agents",
        title: "Агенты без конфигурации",
        detail: `Не настроены (нет ключа/зависимости): ${notConfigured.map((a) => a.name).join(", ")}.`,
        metric: `${notConfigured.length} агент(ов)`,
      });
    }
    if (stale.length > 0) {
      findings.push({
        severity: "low",
        area: "agents",
        title: "Молчащие агенты (нет активности > 12ч)",
        detail:
          `Активны, но давно без активности: ${stale.slice(0, 8).map((a) => a.name).join(", ")}` +
          (stale.length > 8 ? ` и ещё ${stale.length - 8}` : "") +
          ". Узкое место: канал не получает трафик / cron не тикает.",
        metric: `${stale.length} агент(ов)`,
      });
    }
  } catch (e) {
    console.warn("[ferz] analyzeAgents failed:", e);
  }
}

/** 2) Топ групп ошибок юзеров (user_action_failures) за период. */
function analyzeUserFailures(findings: FerzFinding[], fromIso: string): void {
  try {
    const groups = sqlite()
      .prepare(
        `SELECT group_key, channel, action, error_code,
                COUNT(*) AS count, COUNT(DISTINCT user_id) AS uniqUsers
         FROM user_action_failures
         WHERE created_at >= ?
         GROUP BY group_key, channel, action, error_code
         ORDER BY count DESC
         LIMIT 5`,
      )
      .all(fromIso) as Array<{
      group_key: string;
      channel: string;
      action: string;
      error_code: string | null;
      count: number;
      uniqUsers: number;
    }>;

    if (!groups.length) return;
    const top = groups[0];
    // Severity по объёму: > 50 = high, > 200 = critical, иначе medium.
    const topSeverity: FerzSeverity = top.count > 200 ? "critical" : top.count > 50 ? "high" : "medium";
    findings.push({
      severity: topSeverity,
      area: "failures",
      title: "Частые сбои действий юзеров",
      detail:
        `Топ группа: «${top.group_key}» (${top.channel}/${top.action}) — ${top.count} раз, ` +
        `${top.uniqUsers} уник. юзеров. Всего топ-групп: ` +
        groups.map((g) => `${g.group_key}=${g.count}`).join(", "),
      metric: `${top.count} сбоев`,
    });
  } catch (e) {
    console.warn("[ferz] analyzeUserFailures failed:", e);
  }
}

/** 3) Открытые инциденты. */
function analyzeIncidents(findings: FerzFinding[]): void {
  try {
    const rows = sqlite()
      .prepare(
        `SELECT severity, COUNT(*) AS c, SUM(occurrences) AS occ
         FROM incidents
         WHERE status = 'open'
         GROUP BY severity`,
      )
      .all() as Array<{ severity: string; c: number; occ: number }>;
    if (!rows.length) return;
    const totalOpen = rows.reduce((s, r) => s + Number(r.c || 0), 0);
    if (totalOpen === 0) return;
    const critical = rows.find((r) => r.severity === "critical");
    const sev: FerzSeverity = critical ? "critical" : "high";
    findings.push({
      severity: sev,
      area: "incidents",
      title: "Открытые инциденты",
      detail:
        `Незакрытые инциденты по severity: ` +
        rows.map((r) => `${r.severity}=${r.c} (${r.occ || 0} событий)`).join(", ") +
        ". Проверить incidents-таблицу в админке.",
      metric: `${totalOpen} открыто`,
    });
  } catch (e) {
    console.warn("[ferz] analyzeIncidents failed:", e);
  }
}

/** 4) Проблемы генераций: errored / stuck-processing / refunded за период. */
function analyzeGenerations(findings: FerzFinding[], fromIso: string): void {
  try {
    const s = sqlite();
    const errored = Number(
      (s
        .prepare(
          `SELECT COUNT(*) AS c FROM generations
           WHERE type='music' AND status='error' AND deleted_at IS NULL AND created_at >= ?`,
        )
        .get(fromIso) as any)?.c || 0,
    );
    const done = Number(
      (s
        .prepare(
          `SELECT COUNT(*) AS c FROM generations
           WHERE type='music' AND status='done' AND deleted_at IS NULL AND created_at >= ?`,
        )
        .get(fromIso) as any)?.c || 0,
    );
    // Stuck-processing: > 30 минут в processing (узкое место Suno/pipeline).
    const stuckCutoff = new Date(Date.now() - 30 * 60_000).toISOString();
    const stuck = Number(
      (s
        .prepare(
          `SELECT COUNT(*) AS c FROM generations
           WHERE status='processing' AND deleted_at IS NULL AND created_at < ?`,
        )
        .get(stuckCutoff) as any)?.c || 0,
    );
    const refunded = Number(
      (s
        .prepare(
          `SELECT COUNT(*) AS c FROM generations
           WHERE deleted_at IS NULL AND created_at >= ?
             AND json_extract(style, '$.refunded') = json('true')`,
        )
        .get(fromIso) as any)?.c || 0,
    );

    const total = errored + done;
    const errRate = total > 0 ? errored / total : 0;
    if (errRate >= 0.2 && errored >= 3) {
      findings.push({
        severity: errRate >= 0.5 ? "critical" : "high",
        area: "generations",
        title: "Высокая доля ошибок генерации",
        detail: `Ошибок ${errored} из ${total} завершённых (${(errRate * 100).toFixed(1)}%). Refund'ов: ${refunded}. Узкое место — Suno-pipeline / баланс провайдера.`,
        metric: `${(errRate * 100).toFixed(1)}%`,
      });
    } else if (errored > 0) {
      findings.push({
        severity: "low",
        area: "generations",
        title: "Ошибки генерации (в норме)",
        detail: `Ошибок ${errored} из ${total} (${(errRate * 100).toFixed(1)}%), refund'ов ${refunded}. В пределах нормы.`,
        metric: `${errored} ошибок`,
      });
    }

    if (stuck > 0) {
      findings.push({
        severity: stuck >= 5 ? "high" : "medium",
        area: "generations",
        title: "Зависшие генерации (> 30 мин в processing)",
        detail: `${stuck} генераций висят в processing дольше 30 минут. Проверить gen-lifecycle scan + Suno polling.`,
        metric: `${stuck} зависло`,
      });
    }
  } catch (e) {
    console.warn("[ferz] analyzeGenerations failed:", e);
  }
}

/** 5) Здоровье LLM-ключей (переключения провайдеров + последний статус). */
function analyzeLLM(findings: FerzFinding[]): void {
  try {
    const switches = getKeySwitchEvents();
    // События за последние 24 часа.
    const dayAgo = Date.now() - 24 * 3600_000;
    const recentSwitches = switches.filter((e) => {
      const t = Date.parse(e.at);
      return Number.isFinite(t) && t > dayAgo;
    });
    if (recentSwitches.length >= 3) {
      findings.push({
        severity: recentSwitches.length >= 10 ? "high" : "medium",
        area: "llm",
        title: "Частые переключения LLM-провайдеров",
        detail: `За 24ч ${recentSwitches.length} переключений между провайдерами (ключ упал → fallback). Узкое место — нестабильный основной провайдер.`,
        metric: `${recentSwitches.length} switch`,
      });
    }

    // Последний статус ключей цепочки — если все основные fail/timeout.
    const keyNames = [
      "DEEPSEEK_API_KEY",
      "TIMEWEB_GATEWAY_KEY",
      "ANTHROPIC_API_KEY",
      "ANTHROPIC_API_KEY_BACKUP",
      "ANTHROPIC_API_KEY_BOT",
    ];
    const statuses = keyNames
      .map((n) => ({ n, st: getLLMKeyStatus(n) }))
      .filter((x) => x.st != null);
    const failing = statuses.filter(
      (x) => x.st!.lastStatus === "error" || x.st!.lastStatus === "timeout" || Number(x.st!.lastStatus) >= 400,
    );
    if (statuses.length > 0 && failing.length === statuses.length) {
      findings.push({
        severity: "critical",
        area: "llm",
        title: "Все известные LLM-ключи в ошибке",
        detail: `Последний статус всех использованных ключей — ошибка/таймаут (${failing.map((f) => f.n).join(", ")}). Музa может не отвечать. Проверить ключи.`,
        metric: `${failing.length}/${statuses.length}`,
      });
    } else if (failing.length > 0) {
      findings.push({
        severity: "low",
        area: "llm",
        title: "Часть LLM-ключей с последней ошибкой",
        detail: `Ключи с последней ошибкой: ${failing.map((f) => f.n).join(", ")}. Fallback-цепочка компенсирует.`,
        metric: `${failing.length}/${statuses.length}`,
      });
    }
  } catch (e) {
    console.warn("[ferz] analyzeLLM failed:", e);
  }
}

/** 6) Аномалии платежей: fail-rate за период (НЕ раскрываем суммы/секреты). */
function analyzePayments(findings: FerzFinding[], fromIso: string): void {
  try {
    const row = sqlite()
      .prepare(
        `SELECT
           SUM(CASE WHEN status='failed' THEN 1 ELSE 0 END) AS failed,
           SUM(CASE WHEN status='paid' THEN 1 ELSE 0 END) AS paid,
           COUNT(*) AS total
         FROM payments WHERE created_at >= ?`,
      )
      .get(fromIso) as any;
    const failed = Number(row?.failed || 0);
    const paid = Number(row?.paid || 0);
    const decisive = failed + paid;
    if (decisive < 3) return; // мало данных — не шумим
    const failRate = decisive > 0 ? failed / decisive : 0;
    if (failRate >= 0.3) {
      findings.push({
        severity: failRate >= 0.5 ? "critical" : "high",
        area: "payments",
        title: "Высокая доля провалов платежей",
        detail: `Провалов ${failed} из ${decisive} решённых (${(failRate * 100).toFixed(1)}%). Узкое место — Robokassa / форма оплаты.`,
        metric: `${(failRate * 100).toFixed(1)}%`,
      });
    }
  } catch (e) {
    console.warn("[ferz] analyzePayments failed:", e);
  }
}

/** 7) Состояние БД: быстрый integrity probe + размер. */
function analyzeDb(findings: FerzFinding[]): void {
  try {
    const s = sqlite();
    // quick_check дешевле полного integrity_check; ограничиваем 1 ошибкой.
    const qc = s.prepare(`PRAGMA quick_check(1)`).get() as any;
    const qcVal = qc ? Object.values(qc)[0] : null;
    if (qcVal && String(qcVal).toLowerCase() !== "ok") {
      findings.push({
        severity: "critical",
        area: "db",
        title: "Проблема целостности БД",
        detail: `PRAGMA quick_check вернул: ${String(qcVal).slice(0, 120)}. Срочно проверить data.db.`,
        metric: "quick_check FAIL",
      });
    }

    // Размер БД (page_count * page_size). > 4 ГБ — узкое место (план миграции на PG).
    const pc = Number((s.prepare(`PRAGMA page_count`).get() as any)?.page_count || 0);
    const ps = Number((s.prepare(`PRAGMA page_size`).get() as any)?.page_size || 0);
    const bytes = pc * ps;
    const gb = bytes / (1024 * 1024 * 1024);
    if (gb >= 4) {
      findings.push({
        severity: gb >= 8 ? "high" : "medium",
        area: "db",
        title: "Большой размер SQLite-базы",
        detail: `data.db ≈ ${gb.toFixed(2)} ГБ. По мере роста — узкое место (план миграции на PostgreSQL v305-v306).`,
        metric: `${gb.toFixed(2)} ГБ`,
      });
    }
  } catch (e) {
    console.warn("[ferz] analyzeDb failed:", e);
  }
}

// ====================== SUMMARY ======================

/** Детерминированный summary из находок (fallback / основной если LLM недоступен). */
function buildDeterministicSummary(findings: FerzFinding[], counts: Record<FerzSeverity, number>): string {
  if (findings.length === 0) {
    return "Узких мест и критичных недостатков не найдено. Система работает штатно.";
  }
  const parts: string[] = [];
  parts.push(
    `Найдено ${findings.length} наблюдений: ${counts.critical} критичных, ${counts.high} высоких, ${counts.medium} средних, ${counts.low} низких.`,
  );
  const top = findings.filter((f) => f.severity === "critical" || f.severity === "high").slice(0, 4);
  if (top.length > 0) {
    parts.push("Приоритет: " + top.map((f) => `${f.title}${f.metric ? ` (${f.metric})` : ""}`).join("; ") + ".");
  } else {
    parts.push("Критичных и высоких узких мест нет — только средние/низкие.");
  }
  return parts.join(" ");
}

/** Опциональный narrative через LLM. No-AI-providers: бренд не называет провайдеров. */
async function buildLlmSummary(
  findings: FerzFinding[],
  counts: Record<FerzSeverity, number>,
): Promise<string | null> {
  if (findings.length === 0) return null;
  try {
    const { callUnifiedMuzaLLM } = await import("./llmCore");
    const bullets = findings
      .slice(0, 12)
      .map((f) => `- [${f.severity}] ${f.area}: ${f.title}${f.metric ? ` (${f.metric})` : ""} — ${f.detail}`)
      .join("\n");
    const prompt =
      `Ты — Ферзь, аналитик-аудитор системы MuzaAi. Доложи Директору кратко (3-5 предложений) о слабых местах и узких местах системы.\n` +
      `Тон деловой, по существу. Пиши по-русски. НИКОГДА не называй сторонние ИИ-сервисы/модели/провайдеров — всё это «MuzaAi».\n` +
      `Сначала самое критичное. Не выдумывай — опирайся только на находки ниже.\n\n` +
      `Находки (${counts.critical} крит / ${counts.high} высок / ${counts.medium} сред / ${counts.low} низк):\n${bullets}\n\n` +
      `Сводка:`;
    const reply = await callUnifiedMuzaLLM({
      sessionId: `ferz-summary-${Date.now()}`,
      userId: null,
      channel: "internal" as any,
      userText: prompt,
      role: "admin",
      maxTokens: 320,
    });
    const t = String(reply || "").trim();
    return t.length > 10 ? t : null;
  } catch (e) {
    console.warn("[ferz] LLM summary failed:", e);
    return null;
  }
}

// ====================== ENTRY POINTS ======================

/**
 * Запускает полный аудит, складывает отчёт в `ferz_reports`, возвращает отчёт.
 * Никогда не throw'ит — при ошибке любого сигнала просто пропускает его.
 */
export async function runFerzAnalysis(opts?: { period?: string; useLlm?: boolean }): Promise<FerzReport> {
  ensureFerzTable();
  const period = opts?.period || "today";
  const range = getPeriodRange(period);
  const fromIso = range.fromIso;

  const findings: FerzFinding[] = [];

  // Сигналы (каждый swallow'ит свою ошибку внутри).
  analyzeAgents(findings);
  analyzeUserFailures(findings, fromIso);
  analyzeIncidents(findings);
  analyzeGenerations(findings, fromIso);
  analyzeLLM(findings);
  analyzePayments(findings, fromIso);
  analyzeDb(findings);

  // Сортировка по severity (critical → low).
  findings.sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity]);

  const severityCounts = emptyCounts();
  for (const f of findings) severityCounts[f.severity] += 1;

  // Summary: LLM (опционально) → fallback на детерминированный.
  let summary = buildDeterministicSummary(findings, severityCounts);
  if (opts?.useLlm !== false) {
    const llm = await buildLlmSummary(findings, severityCounts);
    if (llm) summary = llm;
  }

  const report: FerzReport = {
    generatedAt: new Date().toISOString(),
    severityCounts,
    findings,
    summary,
  };

  // Persist (never throws).
  try {
    sqlite()
      .prepare(
        `INSERT INTO ferz_reports (created_at, severity_counts, findings, summary) VALUES (?, ?, ?, ?)`,
      )
      .run(Date.now(), JSON.stringify(severityCounts), JSON.stringify(findings), summary);
  } catch (e) {
    console.warn("[ferz] persist report failed:", e);
  }

  // Ферзь подчинён Директору — отмечаем активность (never throws).
  try {
    recordAgentActivity("ferz", {
      action: "run_analysis",
      findings: findings.length,
      critical: severityCounts.critical,
      high: severityCounts.high,
    });
  } catch {
    /* never throw */
  }

  return report;
}

/** Возвращает последний сохранённый отчёт (или null). */
export function getLatestFerzReport(): FerzReport | null {
  ensureFerzTable();
  try {
    const row = sqlite()
      .prepare(`SELECT * FROM ferz_reports ORDER BY created_at DESC, id DESC LIMIT 1`)
      .get() as
      | { created_at: number; severity_counts: string | null; findings: string | null; summary: string | null }
      | undefined;
    if (!row) return null;
    let severityCounts = emptyCounts();
    let findings: FerzFinding[] = [];
    try {
      if (row.severity_counts) severityCounts = { ...severityCounts, ...JSON.parse(row.severity_counts) };
    } catch {}
    try {
      if (row.findings) findings = JSON.parse(row.findings);
    } catch {}
    return {
      generatedAt: new Date(Number(row.created_at || 0)).toISOString(),
      severityCounts,
      findings: Array.isArray(findings) ? findings : [],
      summary: row.summary || "",
    };
  } catch (e) {
    console.warn("[ferz] getLatestFerzReport failed:", e);
    return null;
  }
}

/** Health probe для orchestrator.register healthCheck. */
export function ferzHealth(): { ok: boolean; details: unknown } {
  try {
    ensureFerzTable();
    const c = sqlite().prepare(`SELECT COUNT(*) AS c FROM ferz_reports`).get() as { c: number };
    return { ok: true, details: { reports: Number(c?.c || 0) } };
  } catch (e: any) {
    return { ok: false, details: { error: e?.message || String(e) } };
  }
}
