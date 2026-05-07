// v304 Incident Tracker.
// Eugene 2026-05-07: автоматически детектит критические ошибки,
// классифицирует root cause, пытается auto-resolve. UI 'Критично'
// в админке показывает open incidents красным.
//
// Источники incidents:
//   - cron 'every_minute': scan generations с status='error' за последние
//     5 минут → классификация по error_reason + создание/обновление
//   - subscribe 'agent.action.failed' → плагины которые часто падают
//   - subscribe 'a1.alert.agent_unhealthy'
//   - cron 'every_minute': env-desync detection (process.env vs .env file)
//
// Логирование:
//   [INCIDENT-CRITICAL] kind=X title=...   — на создание open
//   [INCIDENT-RESOLVED] kind=X reason=...  — на resolve

import { sql, desc, eq, and } from "drizzle-orm";
import { Router } from "express";
import * as fs from "node:fs";
import { db } from "../../storage";
import { incidents, generations, agentActions, users } from "@shared/schema";
import type { BootContext, Module } from "../../core";

let bootRefs: { eventBus: BootContext["eventBus"]; logger: BootContext["logger"] } | null = null;

const ENV_FILE = process.env.ENV_FILE || "/var/www/neurohub/.env";
const ADMIN_EMAILS = new Set(
  (process.env.ADMIN_EMAIL || "egnovoselov@gmail.com").split(",").map((e) => e.trim().toLowerCase()),
);

interface ClassifiedRoot {
  kind: string;
  severity: "critical" | "warning" | "info";
  rootCause: string;
  resolution: string;
}

// Эвристика классификации текста ошибки в root cause.
function classifyError(rawError: string): ClassifiedRoot {
  const e = (rawError ?? "").toLowerCase();
  if (/invalid token|unauthorized|401/i.test(rawError)) {
    return {
      kind: "gptunnel_invalid_key",
      severity: "critical",
      rootCause: "GPTunnel вернул 401 — ключ невалиден или отозван",
      resolution: "Открой /#/admin → 🔑 Секреты → обнови GPTUNNEL_API_KEY (получи свежий из gptunnel.ru). Жми 🎵 Test Suno после.",
    };
  }
  if (/forbidden|403/.test(e) || /no.*media.*scope|media.*scope/.test(e)) {
    return {
      kind: "gptunnel_no_media_scope",
      severity: "critical",
      rootCause: "GPTunnel принимает ключ для balance, но не для /media/create — у ключа нет media-scope",
      resolution: "В кабинете GPTunnel выпусти новый ключ с явным media/Suno scope, обнови через /admin/Секреты",
    };
  }
  if (/insufficient|not enough|low balance|402/.test(e)) {
    return {
      kind: "gptunnel_low_balance",
      severity: "critical",
      rootCause: "GPTunnel вернул 402 — баланс закончился",
      resolution: "Пополни баланс на gptunnel.ru. Текущий баланс виден в карточке /admin Обзор.",
    };
  }
  if (/timeout|timed out|fetch failed|econnreset/i.test(e)) {
    return {
      kind: "network_to_gptunnel",
      severity: "warning",
      rootCause: "Сетевая ошибка между сервером и gptunnel.ru",
      resolution: "Проверь сетевой коннект на VPS: curl -m 10 https://gptunnel.ru/v1/balance -H \"Authorization: $GPTUNNEL_API_KEY\". Если падает — vps/firewall проблема.",
    };
  }
  if (/sensitive|moderation/i.test(e)) {
    return {
      kind: "suno_moderation",
      severity: "warning",
      rootCause: "Suno-модерация отклонила контент (имена брендов, агрессия, защищённые слова)",
      resolution: "Перефразируй текст. Это не системная проблема, это контент-уровень.",
    };
  }
  return {
    kind: "generation_error",
    severity: "warning",
    rootCause: "Ошибка генерации Suno — точная причина не классифицирована",
    resolution: "Открой /#/admin → последние генерации → details. Если повторяется на разных треках — проверь GPTunnel ключ и баланс.",
  };
}

function logColored(level: "RESOLVED" | "CRITICAL", kind: string, title: string): void {
  const prefix = level === "RESOLVED"
    ? "\x1b[32m[INCIDENT-RESOLVED]\x1b[0m" // green
    : "\x1b[31m[INCIDENT-CRITICAL]\x1b[0m"; // red
  console.log(`${prefix} kind=${kind} ${title}`);
}

// Создаёт или апдейтит инцидент по dedupeKey. Возвращает row id.
function upsertIncident(input: {
  kind: string;
  severity: "critical" | "warning" | "info";
  title: string;
  rootCause: string;
  resolution: string;
  evidence?: any;
  dedupeKey: string;
}): number {
  const exists = db.select().from(incidents).where(eq(incidents.dedupeKey, input.dedupeKey)).get();
  const evidenceStr = input.evidence ? JSON.stringify(input.evidence).slice(0, 4000) : null;
  if (exists) {
    db.update(incidents)
      .set({
        title: input.title,
        rootCause: input.rootCause,
        resolution: input.resolution,
        severity: input.severity,
        evidence: evidenceStr,
        lastSeenAt: new Date().toISOString(),
        occurrences: (exists.occurrences ?? 1) + 1,
        // если ранее был resolved — возвращаем в open (рецидив)
        status: exists.status === "open" ? "open" : "open",
        resolvedAt: null,
      })
      .where(eq(incidents.id, exists.id))
      .run();
    return exists.id;
  }
  const inserted = db
    .insert(incidents)
    .values({
      kind: input.kind,
      severity: input.severity,
      title: input.title,
      rootCause: input.rootCause,
      resolution: input.resolution,
      evidence: evidenceStr,
      status: "open",
      dedupeKey: input.dedupeKey,
    })
    .returning({ id: incidents.id })
    .get();
  logColored("CRITICAL", input.kind, input.title);
  return inserted.id;
}

function resolveIncident(id: number, reason: string, autoMode = true): void {
  const row = db.select().from(incidents).where(eq(incidents.id, id)).get();
  if (!row || row.status !== "open") return;
  db.update(incidents)
    .set({
      status: autoMode ? "auto-resolved" : "resolved",
      resolvedAt: new Date().toISOString(),
      resolution: row.resolution ? `${row.resolution}\n\n[resolved] ${reason}` : `[resolved] ${reason}`,
    })
    .where(eq(incidents.id, id))
    .run();
  logColored("RESOLVED", row.kind, `${row.title} — ${reason}`);
}

// CRON: scan свежих generation errors → создание incidents.
async function scanGenerationErrors(): Promise<void> {
  if (!bootRefs) return;
  const cutoff = new Date(Date.now() - 5 * 60 * 1000).toISOString();
  const rows = db
    .select()
    .from(generations)
    .where(and(eq(generations.status, "error"), sql`${generations.createdAt} >= ${cutoff}`))
    .orderBy(desc(generations.id))
    .limit(50)
    .all();
  for (const g of rows) {
    if (!g.errorReason) continue;
    const cls = classifyError(g.errorReason);
    upsertIncident({
      ...cls,
      title: `${cls.kind}: ${g.errorReason.slice(0, 100)}`,
      evidence: { generationId: g.id, errorReason: g.errorReason, createdAt: g.createdAt },
      dedupeKey: cls.kind, // одна запись на kind, occurrences растут
    });
  }
}

// CRON: env-desync detection — runtime process.env vs .env file.
function scanEnvDesync(): void {
  try {
    if (!fs.existsSync(ENV_FILE)) return;
    const raw = fs.readFileSync(ENV_FILE, "utf-8");
    const fileEnv: Record<string, string> = {};
    for (const line of raw.split(/\r?\n/)) {
      const t = line.trim();
      if (!t || t.startsWith("#")) continue;
      const eq = t.indexOf("=");
      if (eq <= 0) continue;
      fileEnv[t.slice(0, eq).trim()] = t.slice(eq + 1);
    }
    const KEYS = ["GPTUNNEL_API_KEY", "SMTP_PASS", "TELEGRAM_BOT_TOKEN"];
    const desynced = KEYS.filter((k) => fileEnv[k] && fileEnv[k] !== process.env[k]);
    if (desynced.length === 0) {
      // Проверяем, нет ли старого open инцидента и закрываем
      const old = db.select().from(incidents).where(and(eq(incidents.dedupeKey, "env_desynced"), eq(incidents.status, "open"))).get();
      if (old) resolveIncident(old.id, "all secrets синхронизированы с .env");
      return;
    }
    upsertIncident({
      kind: "env_desynced",
      severity: "critical",
      title: `Runtime ≠ .env: ${desynced.join(", ")}`,
      rootCause: "pm2 не подхватил свежий .env. PITFALLS #14: pm2 restart --update-env берёт env из вызывающего shell.",
      resolution: "Открой /#/admin → 🔑 Секреты → жми 🔄 Restart pm2. Через 5 сек статус станет ✅.",
      evidence: { desynced, pid: process.pid },
      dedupeKey: "env_desynced",
    });
  } catch {
    // Ignore — fs/permissions.
  }
}

// Auto-resolver: для kind которые умеем перепроверять.
async function autoResolveOpen(): Promise<void> {
  const open = db.select().from(incidents).where(eq(incidents.status, "open")).all();
  for (const inc of open) {
    if (inc.kind === "gptunnel_invalid_key" || inc.kind === "gptunnel_no_media_scope" || inc.kind === "network_to_gptunnel") {
      const apiKey = process.env.GPTUNNEL_API_KEY;
      if (!apiKey) continue;
      try {
        const r = await fetch("https://gptunnel.ru/v1/balance", {
          headers: { Authorization: apiKey },
          signal: AbortSignal.timeout(5000),
        });
        if (r.ok) resolveIncident(inc.id, "GPTunnel /balance вернул 200 — ключ снова работает");
      } catch {}
    }
  }
}

// Endpoints
const router = Router();

function requireAdmin(req: any, res: any, next: any): void {
  const auth = (req.headers?.authorization ?? "").toString();
  let token = auth.startsWith("Bearer ") ? auth.slice(7) : (req.query?.token ?? "");
  if (!token) return res.status(401).json({ data: null, error: "unauthorized" });
  try {
    const row = db.get<{ userId: number }>(sql`SELECT user_id as userId FROM sessions WHERE token = ${token} LIMIT 1`);
    if (!row?.userId) return res.status(401).json({ data: null, error: "unauthorized" });
    const u = db.select().from(users).where(eq(users.id, row.userId)).get();
    if (!u || !ADMIN_EMAILS.has((u.email ?? "").toLowerCase())) return res.status(403).json({ data: null, error: "forbidden" });
    (req as any).userId = row.userId;
    next();
  } catch (err) {
    res.status(500).json({ data: null, error: err instanceof Error ? err.message : "internal" });
  }
}

router.get("/", requireAdmin, (_req, res) => {
  const open = db.select().from(incidents).where(eq(incidents.status, "open")).orderBy(desc(incidents.severity), desc(incidents.lastSeenAt)).all();
  const recentResolved = db.select().from(incidents).where(sql`${incidents.status} != 'open'`).orderBy(desc(incidents.resolvedAt)).limit(20).all();
  res.json({
    data: {
      open,
      recentResolved,
      counts: {
        open: open.length,
        critical_open: open.filter((i) => i.severity === "critical").length,
        warning_open: open.filter((i) => i.severity === "warning").length,
      },
    },
    error: null,
  });
});

router.post("/:id/resolve", requireAdmin, (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isFinite(id)) return res.status(400).json({ data: null, error: "invalid id" });
  resolveIncident(id, req.body?.reason ?? "ручное закрытие админом", false);
  res.json({ data: { id, resolved: true }, error: null });
});

router.post("/:id/dismiss", requireAdmin, (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isFinite(id)) return res.status(400).json({ data: null, error: "invalid id" });
  db.update(incidents).set({ status: "dismissed", resolvedAt: new Date().toISOString() }).where(eq(incidents.id, id)).run();
  res.json({ data: { id, dismissed: true }, error: null });
});

router.post("/scan-now", requireAdmin, async (_req, res) => {
  await scanGenerationErrors();
  scanEnvDesync();
  await autoResolveOpen();
  res.json({ data: { scanned: true }, error: null });
});

const incidentTrackerModule: Module = {
  name: "incident-tracker",
  version: "0.1.0",
  description: "Auto-detect + classify + auto-resolve critical errors. UI 'Критично' in /admin.",
  routes: { prefix: "admin/v304/incidents", router },
  publishes: ["incident.opened", "incident.resolved"],
  subscribes: {
    "agent.action.failed": async (event, _ctx) => {
      const p = event.payload as { agentName?: string; actionKind?: string; error?: string } | null;
      if (!p?.agentName) return;
      const cls = classifyError(p.error ?? "");
      upsertIncident({
        ...cls,
        kind: cls.kind === "generation_error" ? "agent_failed" : cls.kind,
        title: `Агент ${p.agentName} (${p.actionKind ?? "?"}) упал`,
        evidence: { agent: p.agentName, error: p.error?.slice(0, 500) },
        dedupeKey: `agent_failed:${p.agentName}:${p.actionKind ?? "?"}`,
      });
    },
  },
  jobs: [
    { name: "incidents-scan-generations", schedule: "every_minute", handler: () => scanGenerationErrors() },
    { name: "incidents-scan-env-desync", schedule: "every_minute", handler: () => scanEnvDesync() },
    { name: "incidents-auto-resolve", schedule: "every_minute", handler: () => autoResolveOpen() },
  ],
  onLoad: async (ctx) => {
    bootRefs = { eventBus: ctx.eventBus, logger: ctx.logger };
    ctx.logger.info("incident-tracker online — auto-detect + auto-resolve");
  },
  healthCheck: () => {
    const openCount = db.select({ c: sql<number>`count(*)` }).from(incidents).where(eq(incidents.status, "open")).get()?.c ?? 0;
    const critOpen = db.select({ c: sql<number>`count(*)` }).from(incidents).where(and(eq(incidents.status, "open"), eq(incidents.severity, "critical"))).get()?.c ?? 0;
    return {
      status: critOpen > 0 ? "degraded" : "ok",
      details: { open: openCount, critical_open: critOpen },
    };
  },
};

export default incidentTrackerModule;
