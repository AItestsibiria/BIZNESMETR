// v304 plugin: admin-overview (Sprint 7).
// GET /api/admin/v304/overview — read-only агрегаты для админ-дашборда:
//   - events за 24h (breakdown по name + total)
//   - агенты: executed / failed по каждому за 24h
//   - leads: total / converted / by status
//   - templates: топ по popularity
//   - feature_flags: enabled list
//   - generations: свежие 20 (id, type, status, createdAt)
//   - chatbot_sessions: свежие 20 + breakdown по channel
//   - plugin health: текущее состояние реестра
//
// Защищён по email-админу как остальные admin-роуты v51 (см.
// routes.ts pattern `user.email !== "egnovoselov@gmail.com"` → 403).
//
// Spec: docs/strategy/original/03 §4 (UI), 07 §6 (метрики).

import { Router } from "express";
import * as fs from "node:fs";
import * as childProc from "node:child_process";
import { sql, desc, eq } from "drizzle-orm";
import { z } from "zod";
import { db } from "../../storage";
import {
  users,
  generations,
  events,
  agentActions,
  leads,
  pluginsRegistry,
  featureFlags,
  genTemplates,
  chatbotSessions,
  adminAuditLog,
} from "@shared/schema";
import type { Module } from "../../core";

// ТЗ Eugene 2026-05-07: единый guard в core/adminAuth — проверяет
// сначала users.role='admin', fallback на ADMIN_EMAIL CSV.
import { requireAdmin, ADMIN_EMAILS } from "../../core/adminAuth";

// Backup-before-edit. Возвращает auditId — путь восстановления.
// Eugene 2026-05-07: каждая редакция админки фиксируется здесь.
function recordEdit(
  req: any,
  action: "create" | "update" | "delete" | "restore",
  entity: string,
  entityKey: string,
  before: unknown,
  after: unknown,
  restoredFromAuditId?: number,
): number {
  const userId = (req as any).userId ?? null;
  const adminEmail = (req as any).adminUser?.email ?? null;
  const inserted = db
    .insert(adminAuditLog)
    .values({
      adminUserId: userId,
      adminEmail,
      action,
      entity,
      entityKey,
      beforeJson: before === undefined ? null : JSON.stringify(before ?? null),
      afterJson: after === undefined ? null : JSON.stringify(after ?? null),
      restoredFromAuditId: restoredFromAuditId ?? null,
    })
    .returning({ id: adminAuditLog.id })
    .get();
  return inserted.id;
}

const router = Router();

router.get("/overview", requireAdmin, (_req, res) => {
  try {
    const since24h = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();

    // Events за 24h
    const eventsRows = db
      .select({
        name: events.name,
        c: sql<number>`count(*)`,
      })
      .from(events)
      .where(sql`${events.occurredAt} >= ${since24h}`)
      .groupBy(events.name)
      .orderBy(sql`count(*) DESC`)
      .all();

    const eventsTotal = eventsRows.reduce((s, r) => s + r.c, 0);

    // Агенты — executed / failed за 24h
    const agentRows = db
      .select({
        agentName: agentActions.agentName,
        status: agentActions.status,
        c: sql<number>`count(*)`,
      })
      .from(agentActions)
      .where(sql`${agentActions.createdAt} >= ${since24h}`)
      .groupBy(agentActions.agentName, agentActions.status)
      .all();

    const agents: Record<string, { executed: number; failed: number; pending: number }> = {};
    for (const r of agentRows) {
      const key = r.agentName;
      if (!agents[key]) agents[key] = { executed: 0, failed: 0, pending: 0 };
      if (r.status === "executed") agents[key].executed = r.c;
      else if (r.status === "failed") agents[key].failed = r.c;
      else if (r.status === "pending") agents[key].pending = r.c;
    }

    // Leads
    const leadStatuses = db
      .select({ status: leads.status, c: sql<number>`count(*)` })
      .from(leads)
      .groupBy(leads.status)
      .all();

    const leadsTotal = leadStatuses.reduce((s, r) => s + r.c, 0);
    const leadsByStatus: Record<string, number> = {};
    for (const r of leadStatuses) leadsByStatus[r.status] = r.c;

    // Templates топ-5 по popularity
    const topTemplates = db
      .select({
        slug: genTemplates.slug,
        name: genTemplates.name,
        popularity: genTemplates.popularity,
      })
      .from(genTemplates)
      .where(eq(genTemplates.active, 1))
      .orderBy(desc(genTemplates.popularity), desc(genTemplates.id))
      .limit(5)
      .all();

    // Feature flags
    const flagsRows = db.select().from(featureFlags).all();

    // Generations свежие 20
    const recentGens = db
      .select({
        id: generations.id,
        type: generations.type,
        status: generations.status,
        createdAt: generations.createdAt,
      })
      .from(generations)
      .orderBy(desc(generations.id))
      .limit(20)
      .all();

    // Chatbot sessions свежие 20
    const recentChats = db
      .select()
      .from(chatbotSessions)
      .orderBy(desc(chatbotSessions.lastMessageAt))
      .limit(20)
      .all();

    const chatChannels = db
      .select({ channel: chatbotSessions.channel, c: sql<number>`count(*)` })
      .from(chatbotSessions)
      .groupBy(chatbotSessions.channel)
      .all();

    // Plugins registry
    const pluginsList = db.select().from(pluginsRegistry).all();

    res.json({
      data: {
        timestamp: new Date().toISOString(),
        since: since24h,
        events: {
          total: eventsTotal,
          breakdown: eventsRows.map((r) => ({ name: r.name, count: r.c })),
        },
        agents,
        leads: { total: leadsTotal, byStatus: leadsByStatus },
        templates: { top: topTemplates },
        featureFlags: flagsRows.map((f) => ({
          key: f.key,
          enabled: f.enabled === 1,
          rollout: f.rolloutPercent,
        })),
        generations: {
          recent: recentGens,
          totalByStatus: db
            .select({ status: generations.status, c: sql<number>`count(*)` })
            .from(generations)
            .groupBy(generations.status)
            .all(),
        },
        chatbot: {
          recent: recentChats,
          byChannel: chatChannels.map((c) => ({ channel: c.channel, count: c.c })),
        },
        plugins: {
          total: pluginsList.length,
          active: pluginsList.filter((p) => p.status === "active").length,
          failed: pluginsList.filter((p) => p.status === "failed").length,
          list: pluginsList.map((p) => ({
            name: p.name,
            version: p.version,
            status: p.status,
            loadedAt: p.loadedAt,
          })),
        },
      },
      error: null,
    });
  } catch (err) {
    res.status(500).json({
      data: null,
      error: err instanceof Error ? err.message : "internal",
    });
  }
});

// =============================================================
// CRUD endpoints — редактирование сущностей v304 из админки.
// Все требуют requireAdmin.
// =============================================================

// ---- Templates ----
const TemplateUpsertSchema = z.object({
  slug: z.string().min(1).max(64).regex(/^[a-z0-9-]+$/i),
  name: z.string().min(1).max(120),
  category: z.string().max(40).optional(),
  description: z.string().max(500).optional(),
  promptTemplate: z.string().max(8000).optional(),
  style: z.string().max(200).optional(),
  structuralTagsJson: z.string().max(4000).optional(),
  recommendedBpm: z.number().int().min(40).max(220).optional(),
  recommendedKey: z.string().max(20).optional(),
  active: z.boolean().optional(),
});

router.put("/templates", requireAdmin, (req, res) => {
  const parsed = TemplateUpsertSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ data: null, error: parsed.error.issues[0]?.message ?? "invalid" });
  }
  const t = parsed.data;
  try {
    const before = db.select().from(genTemplates).where(eq(genTemplates.slug, t.slug)).get() ?? null;
    const after = {
      slug: t.slug,
      name: t.name,
      category: t.category ?? null,
      description: t.description ?? null,
      promptTemplate: t.promptTemplate ?? null,
      style: t.style ?? null,
      structuralTagsJson: t.structuralTagsJson ?? null,
      recommendedBpm: t.recommendedBpm ?? null,
      recommendedKey: t.recommendedKey ?? null,
      active: t.active === false ? 0 : 1,
    };
    if (before) {
      db.update(genTemplates).set({ ...after, updatedAt: new Date().toISOString() }).where(eq(genTemplates.slug, t.slug)).run();
    } else {
      db.insert(genTemplates).values(after).run();
    }
    const auditId = recordEdit(req, before ? "update" : "create", "template", t.slug, before, after);
    res.json({
      data: {
        slug: t.slug,
        action: before ? "updated" : "created",
        auditId,
        backup: before ? `restore via POST /api/admin/v304/audit/${auditId}/restore` : null,
      },
      error: null,
    });
  } catch (err) {
    res.status(500).json({ data: null, error: err instanceof Error ? err.message : "internal" });
  }
});

router.delete("/templates/:slug", requireAdmin, (req, res) => {
  const slug = String(req.params.slug);
  try {
    const before = db.select().from(genTemplates).where(eq(genTemplates.slug, slug)).get();
    if (!before) return res.status(404).json({ data: null, error: "not found" });
    db.update(genTemplates).set({ active: 0 }).where(eq(genTemplates.slug, slug)).run();
    const auditId = recordEdit(req, "delete", "template", slug, before, { ...before, active: 0 });
    res.json({
      data: { slug, deactivated: true, auditId, backup: `POST /api/admin/v304/audit/${auditId}/restore` },
      error: null,
    });
  } catch (err) {
    res.status(500).json({ data: null, error: err instanceof Error ? err.message : "internal" });
  }
});

router.get("/templates", requireAdmin, (_req, res) => {
  const all = db.select().from(genTemplates).orderBy(desc(genTemplates.id)).all();
  res.json({ data: all, error: null });
});

// ---- Feature flags ----
const FlagUpsertSchema = z.object({
  key: z.string().min(1).max(64).regex(/^[a-z0-9._-]+$/i),
  enabled: z.boolean(),
  rolloutPercent: z.number().int().min(0).max(100).optional(),
  description: z.string().max(300).optional(),
  abVariants: z.string().max(4000).optional().nullable(),
});

router.put("/flags", requireAdmin, (req, res) => {
  const parsed = FlagUpsertSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ data: null, error: parsed.error.issues[0]?.message ?? "invalid" });
  }
  const f = parsed.data;
  try {
    const before = db.select().from(featureFlags).where(eq(featureFlags.key, f.key)).get() ?? null;
    const values = {
      enabled: f.enabled ? 1 : 0,
      rolloutPercent: f.rolloutPercent ?? 100,
      description: f.description ?? null,
      abVariants: f.abVariants ?? null,
      updatedAt: new Date().toISOString(),
    };
    const after = { key: f.key, ...values };
    if (before) {
      db.update(featureFlags).set(values).where(eq(featureFlags.key, f.key)).run();
    } else {
      db.insert(featureFlags).values(after).run();
    }
    const auditId = recordEdit(req, before ? "update" : "create", "flag", f.key, before, after);
    res.json({
      data: { key: f.key, action: before ? "updated" : "created", auditId, backup: before ? `POST /api/admin/v304/audit/${auditId}/restore` : null },
      error: null,
    });
  } catch (err) {
    res.status(500).json({ data: null, error: err instanceof Error ? err.message : "internal" });
  }
});

router.delete("/flags/:key", requireAdmin, (req, res) => {
  try {
    const key = String(req.params.key);
    const before = db.select().from(featureFlags).where(eq(featureFlags.key, key)).get();
    if (!before) return res.status(404).json({ data: null, error: "not found" });
    db.delete(featureFlags).where(eq(featureFlags.key, key)).run();
    const auditId = recordEdit(req, "delete", "flag", key, before, null);
    res.json({ data: { key, deleted: true, auditId, backup: `POST /api/admin/v304/audit/${auditId}/restore` }, error: null });
  } catch (err) {
    res.status(500).json({ data: null, error: err instanceof Error ? err.message : "internal" });
  }
});

router.get("/flags", requireAdmin, (_req, res) => {
  const all = db.select().from(featureFlags).orderBy(desc(featureFlags.updatedAt)).all();
  res.json({ data: all, error: null });
});

// ---- Leads ----
const LeadPatchSchema = z.object({
  status: z.enum(["new", "engaged", "converted", "dead"]).optional(),
  score: z.number().int().min(0).max(100).optional(),
  segment: z.string().max(40).optional(),
});

router.patch("/leads/:id", requireAdmin, (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isFinite(id)) return res.status(400).json({ data: null, error: "invalid id" });
  const parsed = LeadPatchSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ data: null, error: parsed.error.issues[0]?.message ?? "invalid" });
  }
  try {
    const before = db.select().from(leads).where(eq(leads.id, id)).get();
    if (!before) return res.status(404).json({ data: null, error: "not found" });
    db.update(leads).set(parsed.data).where(eq(leads.id, id)).run();
    const after = { ...before, ...parsed.data };
    const auditId = recordEdit(req, "update", "lead", String(id), before, after);
    res.json({ data: { id, ...parsed.data, auditId, backup: `POST /api/admin/v304/audit/${auditId}/restore` }, error: null });
  } catch (err) {
    res.status(500).json({ data: null, error: err instanceof Error ? err.message : "internal" });
  }
});

router.get("/leads", requireAdmin, (req, res) => {
  const limit = Math.min(Number(req.query.limit) || 100, 500);
  const all = db.select().from(leads).orderBy(desc(leads.id)).limit(limit).all();
  res.json({ data: all, error: null });
});

// GET /api/admin/v304/gptunnel-balance
// Реальный баланс из gptunnel.ru/v1/balance + парсинг + cache.
let _balanceCache: { fetchedAt: number; balance: number; currency: string; raw: any } | null = null;
const BALANCE_CACHE_TTL = 30_000; // 30 сек чтобы не задалбывать GPTunnel

// SUNO_TRACK_COST — стоимость ОДНОГО трека через GPTunnel.
// Факт 2026-05: GPTunnel берёт 18₽ за запрос Suno, который всегда возвращает
// ПАРУ (2 варианта). Итого: 9₽/трек. Раньше было 8₽ — занижено.
// Конфигурируется env SUNO_TRACK_COST.
const SUNO_TRACK_COST = Number(process.env.SUNO_TRACK_COST ?? "9") || 9;

router.get("/gptunnel-balance", requireAdmin, async (req, res) => {
  const force = String(req.query.force ?? "") === "1";
  const apiKey = process.env.GPTUNNEL_API_KEY ?? "";
  if (!apiKey) {
    return res.json({ data: { available: false, reason: "GPTUNNEL_API_KEY missing" }, error: null });
  }

  if (!force && _balanceCache && Date.now() - _balanceCache.fetchedAt < BALANCE_CACHE_TTL) {
    return res.json({
      data: {
        available: true,
        cached: true,
        ...stripRaw(_balanceCache),
        suno: sunoEstimate(_balanceCache.balance),
      },
      error: null,
    });
  }

  try {
    const r = await fetch("https://gptunnel.ru/v1/balance", {
      method: "GET",
      headers: { Authorization: apiKey },
      signal: AbortSignal.timeout(8000),
    });
    if (!r.ok) {
      return res.json({
        data: { available: false, httpStatus: r.status, reason: r.status === 401 ? "ключ невалиден" : `HTTP ${r.status}` },
        error: null,
      });
    }
    const raw = await r.json().catch(() => null);
    // Разные провайдеры могут отдавать поля по-разному —
    // вытаскиваем максимально мягко.
    const balance = Number(raw?.balance ?? raw?.amount ?? raw?.value ?? raw?.balance_rub ?? 0);
    const currency = String(raw?.currency ?? raw?.currencyCode ?? "RUB");
    _balanceCache = { fetchedAt: Date.now(), balance, currency, raw };
    res.json({
      data: {
        available: true,
        cached: false,
        balance,
        currency,
        fetchedAt: new Date(_balanceCache.fetchedAt).toISOString(),
        raw,
        suno: sunoEstimate(balance),
      },
      error: null,
    });
  } catch (err) {
    res.json({
      data: { available: false, error: err instanceof Error ? err.message : String(err) },
      error: null,
    });
  }
});

function sunoEstimate(balance: number) {
  return {
    pricePerTrack: SUNO_TRACK_COST,
    estimatedTracks: Math.max(0, Math.floor(balance / SUNO_TRACK_COST)),
    note: "Расчёт на основе SUNO_TRACK_COST (env). У GPTunnel единый кошелёк — отдельного эндпоинта баланса Suno нет.",
  };
}

function stripRaw(c: { fetchedAt: number; balance: number; currency: string; raw: any }) {
  return {
    balance: c.balance,
    currency: c.currency,
    fetchedAt: new Date(c.fetchedAt).toISOString(),
  };
}

// =============================================================
// Secrets — безопасная ротация через UI.
// Значения НИКОГДА не попадают в audit log (только факт изменения).
// =============================================================
const ENV_FILE = process.env.ENV_FILE || "/var/www/neurohub/.env";

const ROTATABLE_SECRETS: Record<string, { name: string; description: string; verifiable: boolean }> = {
  GPTUNNEL_API_KEY: { name: "GPTunnel API key", description: "Suno + LLM router (fallback STT)", verifiable: true },
  YANDEX_SPEECHKIT_API_KEY: { name: "Yandex SpeechKit", description: "Speech-to-text Russian (priority)", verifiable: false },
  YANDEX_FOLDER_ID: { name: "Yandex Folder ID", description: "FolderID for SpeechKit", verifiable: false },
  OPENAI_API_KEY: { name: "OpenAI API key", description: "Whisper STT (fallback 2)", verifiable: false },
  MAX_BOT_TOKEN: { name: "Max.ru Bot token", description: "Sales channel via Max messenger", verifiable: false },
  MAX_WEBHOOK_SECRET: { name: "Max webhook secret", description: "X-Max-Bot-Api-Secret", verifiable: false },
  SMTP_HOST:        { name: "SMTP host", description: "smtp.yandex.ru и т.п.", verifiable: false },
  SMTP_PORT:        { name: "SMTP port", description: "Default 465", verifiable: false },
  SMTP_USER:        { name: "SMTP user", description: "noreply@podaripesnu.ru", verifiable: false },
  SMTP_PASS:        { name: "SMTP password", description: "App password", verifiable: false },
  SMTP_FROM:        { name: "SMTP from", description: "MuziAI <noreply@...>", verifiable: false },
  TELEGRAM_BOT_TOKEN: { name: "Telegram bot token", description: "BotFather token", verifiable: false },
  VK_GROUP_ID:      { name: "VK group id", description: "Community ID", verifiable: false },
  VK_ACCESS_TOKEN:  { name: "VK access token", description: "Community access token", verifiable: false },
  VK_CONFIRMATION_CODE: { name: "VK confirmation", description: "Callback API confirmation", verifiable: false },
  VK_SECRET:        { name: "VK secret", description: "Callback signing secret", verifiable: false },
  ROBO_MERCHANT_LOGIN: { name: "Robokassa login", description: "ИП-login", verifiable: false },
  ROBO_PASSWORD1:   { name: "Robokassa pwd1", description: "Sign password 1", verifiable: false },
  ROBO_PASSWORD2:   { name: "Robokassa pwd2", description: "Sign password 2", verifiable: false },
  YM_COUNTER_ID:    { name: "Yandex Metrika ID", description: "VITE_YM_COUNTER_ID", verifiable: false },
  VK_PIXEL_ID:      { name: "VK Pixel ID", description: "VITE_VK_PIXEL_ID", verifiable: false },
  ADMIN_EMAIL:      { name: "Admin email(s)", description: "comma-separated list", verifiable: false },
};

function readEnvFile(): Record<string, string> {
  if (!fs.existsSync(ENV_FILE)) return {};
  const raw = fs.readFileSync(ENV_FILE, "utf-8");
  const out: Record<string, string> = {};
  for (const line of raw.split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const eq = t.indexOf("=");
    if (eq <= 0) continue;
    out[t.slice(0, eq).trim()] = t.slice(eq + 1);
  }
  return out;
}

function writeEnvFile(updates: Record<string, string>): void {
  const cur = fs.existsSync(ENV_FILE) ? fs.readFileSync(ENV_FILE, "utf-8") : "";
  const lines = cur.split(/\r?\n/);
  const remaining = new Set(Object.keys(updates));
  const out: string[] = [];
  for (const line of lines) {
    const m = line.match(/^([A-Z_][A-Z0-9_]*)=/);
    if (m && remaining.has(m[1])) {
      out.push(`${m[1]}=${updates[m[1]]}`);
      remaining.delete(m[1]);
    } else {
      out.push(line);
    }
  }
  remaining.forEach((k) => out.push(`${k}=${updates[k]}`));
  let result = out.join("\n");
  if (!result.endsWith("\n")) result += "\n";
  fs.writeFileSync(ENV_FILE, result, { mode: 0o600 });
}

// pm2 restart --update-env берёт env из shell-среды spawn'а. Чтобы он
// гарантированно подхватил свежий .env (а не кэшированный старый
// process.env), source'им .env в bash-subshell. Это закрывает класс
// багов 'admin-verify пройден, но runtime-генерация падает с тем же
// ключом' — теперь runtime получит то же значение что и admin читает.
function scheduleRestart(): void {
  const cmd = `sleep 1 && set -a && [ -f ${ENV_FILE} ] && . ${ENV_FILE}; set +a && pm2 restart neurohub --update-env >/dev/null 2>&1`;
  const child = childProc.spawn("bash", ["-c", cmd], {
    detached: true,
    stdio: "ignore",
    env: { HOME: process.env.HOME || "/root", PM2_HOME: process.env.PM2_HOME || "/root/.pm2", PATH: process.env.PATH ?? "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin" },
  });
  child.unref();
}

function maskValue(value: string): { length: number; first8: string; hasLeadingSpace: boolean } {
  return {
    length: value.length,
    first8: value.slice(0, 8),
    hasLeadingSpace: value.startsWith(" "),
  };
}

router.get("/secrets", requireAdmin, (_req, res) => {
  try {
    const env = readEnvFile();
    const list = Object.entries(ROTATABLE_SECRETS).map(([key, meta]) => {
      const value = env[key] ?? "";
      const present = value.length > 0;
      return {
        key,
        ...meta,
        present,
        masked: present ? maskValue(value) : null,
      };
    });
    res.json({ data: list, error: null });
  } catch (err) {
    res.status(500).json({ data: null, error: err instanceof Error ? err.message : "internal" });
  }
});

const SecretUpsertSchema = z.object({
  key: z.string().regex(/^[A-Z_][A-Z0-9_]*$/),
  value: z.string().min(1).max(2048),
  restart: z.boolean().optional(),
});

router.put("/secrets", requireAdmin, (req, res) => {
  const parsed = SecretUpsertSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ data: null, error: parsed.error.issues[0]?.message ?? "invalid" });
  }
  const { key, value, restart } = parsed.data;
  if (!ROTATABLE_SECRETS[key]) {
    return res.status(400).json({ data: null, error: `key '${key}' not in rotatable list` });
  }

  // PITFALLS #12 защита: trim ведущих/висящих пробелов и обёртывающих
  // кавычек до записи в .env. Этот один блок убивает целый класс багов.
  let cleaned = value.trim();
  if (
    (cleaned.startsWith('"') && cleaned.endsWith('"')) ||
    (cleaned.startsWith("'") && cleaned.endsWith("'"))
  ) {
    cleaned = cleaned.slice(1, -1);
  }
  if (/\r|\n/.test(cleaned)) {
    return res.status(400).json({ data: null, error: "value must not contain newlines" });
  }
  if (cleaned.length === 0) {
    return res.status(400).json({ data: null, error: "value empty after trim" });
  }

  try {
    const before = readEnvFile();
    const wasPresent = !!before[key];
    writeEnvFile({ [key]: cleaned });

    // Audit БЕЗ значения секрета — только факт + длина.
    const auditId = recordEdit(
      req,
      wasPresent ? "update" : "create",
      "secret",
      key,
      { length: (before[key] ?? "").length },
      { length: cleaned.length },
    );

    if (restart !== false) scheduleRestart();

    res.json({
      data: {
        key,
        action: wasPresent ? "updated" : "created",
        masked: maskValue(cleaned),
        auditId,
        restartScheduled: restart !== false,
        note: "значение секрета НЕ сохранено в audit-log",
      },
      error: null,
    });
  } catch (err) {
    res.status(500).json({ data: null, error: err instanceof Error ? err.message : "internal" });
  }
});

// Сравнение runtime env vs .env file — показывает рассинхронизацию.
router.get("/secrets/runtime-check", requireAdmin, (_req, res) => {
  const env = readEnvFile();
  const compare = Object.keys(ROTATABLE_SECRETS).map((key) => {
    const fileVal = env[key] ?? "";
    const runtimeVal = process.env[key] ?? "";
    return {
      key,
      file: { length: fileVal.length, first8: fileVal.slice(0, 8) },
      runtime: { length: runtimeVal.length, first8: runtimeVal.slice(0, 8) },
      synced: fileVal === runtimeVal,
    };
  });
  res.json({
    data: {
      timestamp: new Date().toISOString(),
      pid: process.pid,
      uptime_sec: Math.round(process.uptime()),
      compare,
      desynced: compare.filter((c) => !c.synced).map((c) => c.key),
    },
    error: null,
  });
});

// Полноценный test-call к Suno /media/create с минимальным payload —
// проверяет что ключ имеет именно media-scope (а не только balance).
// Создаёт реальную задачу у GPTunnel БЕЗ сохранения в БД.
router.post("/secrets/test-suno", requireAdmin, async (_req, res) => {
  const env = readEnvFile();
  // Используем именно runtime значение — точно то что использует
  // production-код /api/music/generate.
  const runtimeKey = process.env.GPTUNNEL_API_KEY ?? "";
  const fileKey = env.GPTUNNEL_API_KEY ?? "";
  if (!runtimeKey) {
    return res.json({ data: { ok: false, reason: "GPTUNNEL_API_KEY missing in runtime process.env" }, error: null });
  }
  const synced = runtimeKey === fileKey;

  const probe = async (apiKey: string, label: string) => {
    try {
      const r = await fetch("https://gptunnel.ru/v1/media/create", {
        method: "POST",
        headers: { Authorization: apiKey, "Content-Type": "application/json" },
        body: JSON.stringify({ model: "suno", prompt: "test ping" }),
        signal: AbortSignal.timeout(15000),
      });
      const text = await r.text();
      let parsed: any = null;
      try { parsed = JSON.parse(text); } catch {}
      return {
        label,
        keyLength: apiKey.length,
        keyFirst8: apiKey.slice(0, 8),
        httpStatus: r.status,
        ok: r.ok,
        responsePreview: text.slice(0, 400),
        responseId: parsed?.id ?? null,
        message: parsed?.message ?? parsed?.error?.message ?? null,
      };
    } catch (err) {
      return {
        label,
        keyLength: apiKey.length,
        keyFirst8: apiKey.slice(0, 8),
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  };

  const runtimeProbe = await probe(runtimeKey, "runtime (process.env)");
  const fileProbe = synced ? null : await probe(fileKey, ".env file");

  res.json({
    data: {
      timestamp: new Date().toISOString(),
      synced,
      runtime: runtimeProbe,
      file: fileProbe,
      hint: synced
        ? (runtimeProbe.ok ? "Suno-create OK — ключ имеет media-scope" : "Ключ читается одинаково в runtime и .env, но Suno-create отвергает — проблема не в нашем коде")
        : "⚠️ Runtime-env не совпадает с .env! pm2 restart не подхватил свежий ключ. Жми кнопку 'Restart pm2' или используй ssh.",
    },
    error: null,
  });
});

// POST /api/admin/v304/generate-anthem
// Один-клик запуск Гимна MUZIAI v304: берёт шаблон v304-anthem,
// создаёт generation от лица админа, шлёт в GPTunnel/Suno,
// возвращает generationId + ссылки для прослушивания.
router.post("/generate-anthem", requireAdmin, async (req, res) => {
  try {
    const adminUserId = (req as any).userId as number;
    const adminEmail = (req as any).adminUser?.email ?? "admin";

    // 1. Шаблон гимна
    const tpl = db.select().from(genTemplates).where(eq(genTemplates.slug, "v304-anthem")).get();
    if (!tpl) return res.status(404).json({ data: null, error: "Шаблон v304-anthem не найден" });

    // 2. Нормализуем — для гимна используем DUET (мужской лид + женский хор)
    const { normalizeVocalParams } = await import("../../lib/normalizeVocalParams");
    const norm = normalizeVocalParams({
      prompt: tpl.description ?? "Эпический гимн платформы MUZIAI v304",
      style: tpl.style,
      lyrics: tpl.promptTemplate,
      voiceType: "duet",
    });

    // 3. Создаём строку в generations
    const newGen = db
      .insert(generations)
      .values({
        userId: adminUserId,
        type: "music",
        prompt: tpl.promptTemplate || "",
        style: JSON.stringify({
          style: norm.finalStyle,
          title: tpl.name,
          category: "anthem",
          fromTemplate: tpl.slug,
          startedBy: adminEmail,
        }),
        status: "processing",
        cost: 0,
        isPublic: 1,
        authorName: "MUZIAI v304",
        voiceType: norm.voiceType,
        templateSlug: tpl.slug,
        bpm: tpl.recommendedBpm ?? null,
        musicKey: tpl.recommendedKey ?? null,
      } as any)
      .returning()
      .get();

    // 4. POST в GPTunnel /v1/media/create
    const apiKey = process.env.GPTUNNEL_API_KEY ?? "";
    if (!apiKey) {
      db.update(generations).set({ status: "error", errorReason: "GPTUNNEL_API_KEY missing" }).where(eq(generations.id, newGen.id)).run();
      return res.status(503).json({ data: null, error: "GPTUNNEL_API_KEY не задан в runtime" });
    }

    // Custom-mode: lyrics ≥50 chars, есть title и tags
    const sunoBody = {
      model: "suno",
      mode: "custom",
      lyric: (tpl.promptTemplate ?? "").slice(0, 3000),
      title: tpl.name.slice(0, 80),
      tags: norm.finalStyle.slice(0, 200),
    };

    let upstream: any = null;
    let upstreamStatus = 0;
    try {
      const r = await fetch("https://gptunnel.ru/v1/media/create", {
        method: "POST",
        headers: { Authorization: apiKey, "Content-Type": "application/json" },
        body: JSON.stringify(sunoBody),
        signal: AbortSignal.timeout(20000),
      });
      upstreamStatus = r.status;
      const text = await r.text();
      try { upstream = JSON.parse(text); } catch { upstream = { raw: text }; }
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      db.update(generations).set({ status: "error", errorReason: `network: ${error}` }).where(eq(generations.id, newGen.id)).run();
      return res.status(502).json({ data: null, error });
    }

    if (upstreamStatus < 200 || upstreamStatus >= 300 || !upstream?.id) {
      const errMsg = upstream?.message ?? upstream?.error?.message ?? `MuziAi вернул ${upstreamStatus}`;
      db.update(generations).set({ status: "error", errorReason: String(errMsg) }).where(eq(generations.id, newGen.id)).run();
      return res.status(upstreamStatus || 502).json({
        data: null,
        error: errMsg,
        details: { upstreamStatus, upstream },
      });
    }

    // 5. Сохраняем taskId
    db.update(generations).set({ taskId: upstream.id, status: "processing" }).where(eq(generations.id, newGen.id)).run();

    res.json({
      data: {
        generationId: newGen.id,
        taskId: upstream.id,
        status: "processing",
        message: "Гимн отправлен в Suno. Через 1-2 минуты будет готов.",
        watchUrl: `/#/track/${newGen.id}`,
        dashboardUrl: `/#/dashboard`,
        statusEndpoint: `/api/track/${newGen.id}`,
      },
      error: null,
    });
  } catch (err) {
    res.status(500).json({ data: null, error: err instanceof Error ? err.message : "internal" });
  }
});

// =============================================================
// pollProcessingGenerations — каждую минуту скан 'processing' и
// апдейт до 'done'/'error'. Закрывает класс багов когда client'у не
// доступен polling (admin-launched anthem, inline-агенты, дашборд).
// Логика — упрощённая копия /api/music/status/:taskId без рефанда.
// =============================================================
async function pollProcessingGenerations(): Promise<{ scanned: number; done: number; failed: number }> {
  const apiKey = process.env.GPTUNNEL_API_KEY ?? "";
  if (!apiKey) return { scanned: 0, done: 0, failed: 0 };

  // Только последние 30 минут — старше = тухляк, помечаем ошибкой.
  const cutoff = new Date(Date.now() - 30 * 60_000).toISOString();
  const rows = db.all<{ id: number; taskId: string; createdAt: string }>(
    sql`SELECT id, task_id as taskId, created_at as createdAt
        FROM generations
        WHERE status = 'processing' AND task_id IS NOT NULL AND task_id != ''`,
  );

  let done = 0;
  let failed = 0;
  for (const row of rows) {
    // Тухлые processing > 30 мин — закрываем как timeout.
    if (row.createdAt < cutoff) {
      db.run(sql`UPDATE generations SET status='error', error_reason='MuziAi timeout > 30 min'
                 WHERE id=${row.id}`);
      failed += 1;
      continue;
    }

    try {
      const r = await fetch("https://gptunnel.ru/v1/media/result", {
        method: "POST",
        headers: { Authorization: apiKey, "Content-Type": "application/json" },
        body: JSON.stringify({ task_id: row.taskId }),
        signal: AbortSignal.timeout(15_000),
      });
      if (!r.ok) continue; // оставляем processing — на следующей итерации повтор

      const data: any = await r.json().catch(() => null);
      if (!data) continue;

      const succeeded = Array.isArray(data.result)
        ? data.result.find((t: any) => t.status === "succeeded" && t.audio_url)
        : null;
      const isDone = data.status === "done" || !!succeeded;

      if (isDone && succeeded) {
        db.run(sql`UPDATE generations
                   SET status='done',
                       result_url=${succeeded.audio_url},
                       result_data=${JSON.stringify(data)}
                   WHERE id=${row.id}`);
        done += 1;

        // GPTunnel Suno возвращает ПАРУ треков за один запрос (18₽ за пару).
        // Сохраняем 2-й вариант отдельной строкой — иначе теряется 50% оплаченного.
        if (Array.isArray(data.result) && data.result.length > 1) {
          const secondTrack = data.result.find((t: any, i: number) =>
            i > 0 && t.status === "succeeded" && t.audio_url && t.audio_url !== succeeded.audio_url,
          );
          if (secondTrack) {
            const v2TaskId = `${row.taskId}_v2`;
            const exists = db.get<{ id: number }>(
              sql`SELECT id FROM generations WHERE task_id = ${v2TaskId} LIMIT 1`,
            );
            if (!exists) {
              const orig = db.get<{ userId: number; type: string; prompt: string; style: string;
                authorName: string | null; isPublic: number; voiceType: string | null }>(
                sql`SELECT user_id as userId, type, prompt, style, author_name as authorName,
                           is_public as isPublic, voice_type as voiceType
                    FROM generations WHERE id = ${row.id}`,
              );
              if (orig) {
                // Маркируем 2-й вариант как бонусный (ТЗ Eugene 12:31).
                let mergedStyle: any = {};
                try { mergedStyle = JSON.parse(orig.style || "{}"); } catch {}
                mergedStyle.isBonus = true;
                mergedStyle.bonusFromGenId = row.id;
                mergedStyle.bonusLabel = "🎁 Бонус от MuziAi";
                if (mergedStyle.title) mergedStyle.title = `${mergedStyle.title} · 🎁 бонус`;
                db.run(sql`INSERT INTO generations
                           (user_id, type, prompt, style, status, result_url, result_data,
                            cost, task_id, author_name, is_public, voice_type)
                           VALUES (${orig.userId}, ${orig.type}, ${orig.prompt}, ${JSON.stringify(mergedStyle)},
                                   'done', ${secondTrack.audio_url}, ${JSON.stringify({ result: [secondTrack] })},
                                   0, ${v2TaskId}, ${orig.authorName}, ${orig.isPublic}, ${orig.voiceType})`);
                console.log(`\x1b[32m[POLL]\x1b[0m gen #${row.id} BONUS variant 2 saved (taskId=${v2TaskId})`);
                done += 1;
              }
            }
          }
        }
      } else if (data.status === "error" || data.status === "failed") {
        const reason = String(
          data.message ?? data.error?.message ?? `Suno status=${data.status}`,
        ).slice(0, 500);
        db.run(sql`UPDATE generations
                   SET status='error', error_reason=${reason}, result_data=${JSON.stringify(data)}
                   WHERE id=${row.id}`);
        failed += 1;
      }
      // иначе — всё ещё в processing у Suno, ждём
    } catch {
      // network — повторим на следующей минуте
    }
  }

  return { scanned: rows.length, done, failed };
}

// GET /api/admin/v304/client-errors — последние 100 React/JS-ошибок,
// прилетевших на /api/_client-error от ErrorBoundary в браузере.
// Используется в /admin UI «Recent client errors» (TZ Eugene 11:27).
router.get("/client-errors", requireAdmin, (req, res) => {
  const ring: any[] = (globalThis as any).__clientErrorsRing ?? [];
  const limit = Math.min(parseInt(String(req.query.limit ?? "50"), 10) || 50, 100);
  // newest-first
  const items = ring.slice().reverse().slice(0, limit);
  res.json({ data: { count: ring.length, items }, error: null });
});

router.post("/client-errors/clear", requireAdmin, (_req, res) => {
  const ring: any[] = (globalThis as any).__clientErrorsRing ?? [];
  ring.length = 0;
  res.json({ data: { cleared: true }, error: null });
});

// GET /api/admin/v304/yandex/status — состояние Яндекс-сервисов.
// ТЗ Eugene 12:42: «агент на dashboard для управления Яндекс-ключом».
router.get("/yandex/status", requireAdmin, async (_req, res) => {
  const apiKey = process.env.YANDEX_SPEECHKIT_API_KEY;
  const folderId = process.env.YANDEX_FOLDER_ID;
  const services: any = {
    speechkit_stt: {
      name: "SpeechKit STT (распознавание речи)",
      configured: !!apiKey,
      keyLen: apiKey ? apiKey.length : 0,
      folderIdSet: !!folderId,
      pricing: "≈ 0.45 ₽/мин (short audio API)",
      status: apiKey ? "ready" : "not_configured",
      docs: "https://yandex.cloud/ru/docs/speechkit/stt/",
    },
    speechkit_tts: {
      name: "SpeechKit TTS (синтез речи)",
      configured: false,
      status: "planned",
      pricing: "≈ 0.40 ₽/1000 символов",
      note: "Будет добавлено в Sprint 5",
    },
    translate: {
      name: "Yandex Translate",
      configured: false,
      status: "planned",
      pricing: "≈ 400 ₽/млн символов",
      note: "Опционально для Sprint 6+",
    },
    cloudfunctions: {
      name: "Cloud Functions",
      configured: false,
      status: "not_planned",
      note: "Не используется в архитектуре",
    },
  };
  // Лёгкая live-проверка: если ключ есть, делаем GET к balance-style endpoint
  // (Yandex не имеет dedicated balance — пробуем малозатратную проверку через
  // GET headers без body — должен вернуть 400/415, что подтверждает auth ОК)
  if (apiKey) {
    try {
      const r = await fetch("https://stt.api.cloud.yandex.net/speech/v1/stt:recognize?lang=ru-RU", {
        method: "POST",
        headers: { Authorization: `Api-Key ${apiKey}` },
        body: Buffer.from([]),
        signal: AbortSignal.timeout(5_000),
      });
      // Любой ответ кроме 401/403 → ключ принят
      services.speechkit_stt.authProbe = {
        httpStatus: r.status,
        authValid: r.status !== 401 && r.status !== 403,
      };
    } catch (e) {
      services.speechkit_stt.authProbe = { error: e instanceof Error ? e.message : "?" };
    }
  }
  res.json({ data: { services }, error: null });
});

// POST /api/admin/v304/transcribe-verify
// Body: { uploadSha: string }
// Гоняет аудио через ВСЕ STT-провайдеры (Yandex, OpenAI, GPTunnel) и
// возвращает матрицу — какой работает. ТЗ Eugene 12:35.
router.post("/transcribe-verify", requireAdmin, async (req, res) => {
  try {
    const sha = String(req.body?.uploadSha ?? "").trim();
    if (!sha) return res.status(400).json({ data: null, error: "uploadSha required" });
    const fs = await import("node:fs");
    const { audioUploads } = await import("@shared/schema");
    const upl = db.select().from(audioUploads).where(eq(audioUploads.sha, sha)).get();
    if (!upl) return res.status(404).json({ data: null, error: "файл не найден" });
    const buffer = fs.readFileSync(upl.storagePath);
    const { verifyAllProviders } = await import("../../lib/transcribe");
    const attempts = await verifyAllProviders(buffer, upl.mime || "audio/webm", upl.ext || "webm");
    const working = attempts.filter((a) => a.ok).map((a) => a.provider);
    res.json({
      data: {
        sha, sizeBytes: upl.sizeBytes, mime: upl.mime,
        attempts, working,
        recommendation: working.length === 0
          ? "ни один провайдер не работает. Получи YANDEX_SPEECHKIT_API_KEY (бесплатный trial) или OPENAI_API_KEY"
          : `Работает: ${working.join(", ")}. Использовать в продакшне будет первый из них (приоритет: yandex > openai > gptunnel).`,
      },
      error: null,
    });
  } catch (err) {
    res.status(500).json({ data: null, error: err instanceof Error ? err.message : "internal" });
  }
});

router.post("/poll-now", requireAdmin, async (_req, res) => {
  try {
    const result = await pollProcessingGenerations();
    res.json({ data: result, error: null });
  } catch (err) {
    res.status(500).json({ data: null, error: err instanceof Error ? err.message : "internal" });
  }
});

// POST /api/admin/v304/generations/:id/reassign
// Переназначает владельца генерации на другого user'а (по email).
// Use case Eugene 2026-05-07: gen #678 не удалось → перенести в кабинет
// автор 2 для дебага. Записывает audit-лог с before/after.
router.post("/generations/:id/reassign", requireAdmin, (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (!Number.isFinite(id)) return res.status(400).json({ data: null, error: "invalid id" });
    const toEmail = String(req.body?.toEmail ?? "").trim().toLowerCase();
    if (!toEmail) return res.status(400).json({ data: null, error: "toEmail required" });

    const gen = db.select().from(generations).where(eq(generations.id, id)).get();
    if (!gen) return res.status(404).json({ data: null, error: "generation not found" });
    const target = db.select().from(users).where(eq(users.email, toEmail)).get();
    if (!target) return res.status(404).json({ data: null, error: `пользователь ${toEmail} не найден` });

    const before = { id: gen.id, userId: gen.userId, status: gen.status, errorReason: gen.errorReason };
    db.update(generations).set({ userId: target.id }).where(eq(generations.id, id)).run();
    const after = { id: gen.id, userId: target.id };

    const auditId = recordEdit(req, "update", "generation_owner", String(id), before, after);
    res.json({
      data: {
        generationId: id,
        movedTo: { userId: target.id, email: target.email, name: target.name },
        previousUserId: gen.userId,
        auditId,
      },
      error: null,
    });
  } catch (err) {
    res.status(500).json({ data: null, error: err instanceof Error ? err.message : "internal" });
  }
});

// POST /api/admin/v304/generations/debug-batch
// Body: { ids: number[] }
// Возвращает: для каждого id — DB-запись + свежий ответ Suno /v1/media/result
// + классифицированную причину. Use case: батч-диагностика подряд упавших
// генераций, чтобы за один запрос увидеть закономерность (sensitive content,
// invalid key, low balance и т.д.).
router.post("/generations/debug-batch", requireAdmin, async (req, res) => {
  try {
    const idsRaw = req.body?.ids;
    const ids: number[] = Array.isArray(idsRaw)
      ? idsRaw.map((v: any) => Number(v)).filter((n: number) => Number.isFinite(n))
      : [];
    if (ids.length === 0 || ids.length > 50) {
      return res.status(400).json({ data: null, error: "ids: array of 1..50 generation IDs" });
    }
    const apiKey = process.env.GPTUNNEL_API_KEY ?? "";

    const out: any[] = [];
    for (const id of ids) {
      const gen = db.select().from(generations).where(eq(generations.id, id)).get();
      if (!gen) { out.push({ id, exists: false }); continue; }

      const baseInfo = {
        id, exists: true,
        status: gen.status,
        taskId: gen.taskId,
        errorReason: gen.errorReason,
        prompt: (gen.prompt || "").slice(0, 80),
        templateSlug: (gen as any).templateSlug,
        voiceType: (gen as any).voiceType,
        userId: gen.userId,
        cost: gen.cost,
        createdAt: gen.createdAt,
      };

      if (!apiKey || !gen.taskId) {
        out.push({ ...baseInfo, sunoFresh: null, note: !apiKey ? "GPTUNNEL_API_KEY missing" : "no taskId" });
        continue;
      }

      try {
        const r = await fetch("https://gptunnel.ru/v1/media/result", {
          method: "POST",
          headers: { Authorization: apiKey, "Content-Type": "application/json" },
          body: JSON.stringify({ task_id: gen.taskId }),
          signal: AbortSignal.timeout(10000),
        });
        const text = await r.text();
        let suno: any;
        try { suno = JSON.parse(text); } catch { suno = { raw: text }; }
        out.push({
          ...baseInfo,
          sunoFreshStatus: r.status,
          sunoFresh: {
            status: suno?.status,
            code: suno?.code,
            message: suno?.message ?? suno?.error?.message,
            resultCount: Array.isArray(suno?.result) ? suno.result.length : null,
            firstTrackStatus: Array.isArray(suno?.result) ? suno.result[0]?.status : null,
            firstAudio: Array.isArray(suno?.result) ? suno.result[0]?.audio_url ? "present" : null : null,
          },
        });
      } catch (e) {
        out.push({ ...baseInfo, sunoFresh: null, sunoFreshError: e instanceof Error ? e.message : String(e) });
      }
    }
    res.json({ data: { count: out.length, items: out }, error: null });
  } catch (err) {
    res.status(500).json({ data: null, error: err instanceof Error ? err.message : "internal" });
  }
});

// POST /api/admin/v304/generations/:id/recover-from-suno
// Восстанавливает «ложно-error» генерацию: дёргает Suno /media/result,
// если есть audio_url — переводит в done с правильным resultUrl.
// Use case: gen 672-679 — TIMEOUT WATCHER пометил error через 2 мин, но
// Suno реально вернул succeeded на 3-4 мин.
router.post("/generations/:id/recover-from-suno", requireAdmin, async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (!Number.isFinite(id)) return res.status(400).json({ data: null, error: "invalid id" });
    const gen = db.select().from(generations).where(eq(generations.id, id)).get();
    if (!gen) return res.status(404).json({ data: null, error: "generation not found" });
    if (!gen.taskId) return res.status(400).json({ data: null, error: "no taskId — recovery невозможен" });

    const apiKey = process.env.GPTUNNEL_API_KEY ?? "";
    if (!apiKey) return res.status(503).json({ data: null, error: "GPTUNNEL_API_KEY missing" });

    const r = await fetch("https://gptunnel.ru/v1/media/result", {
      method: "POST",
      headers: { Authorization: apiKey, "Content-Type": "application/json" },
      body: JSON.stringify({ task_id: gen.taskId }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!r.ok) {
      return res.status(502).json({ data: null, error: `MuziAi вернул ${r.status}` });
    }
    const data: any = await r.json();
    const succeeded = Array.isArray(data?.result)
      ? data.result.find((t: any) => t.status === "succeeded" && t.audio_url)
      : null;
    if (!succeeded) {
      return res.json({
        data: {
          recovered: false,
          message: "MuziAi не вернул успешный трек — recovery невозможен",
          sunoStatus: data?.status,
          firstTrackStatus: Array.isArray(data?.result) ? data.result[0]?.status : null,
        },
        error: null,
      });
    }

    db.run(sql`UPDATE generations
               SET status='done', result_url=${succeeded.audio_url}, result_data=${JSON.stringify(data)},
                   error_reason=NULL
               WHERE id=${id}`);

    res.json({
      data: {
        recovered: true,
        generationId: id,
        audioUrl: succeeded.audio_url,
        watchUrl: `/#/track/${id}`,
        previousErrorReason: gen.errorReason,
      },
      error: null,
    });
  } catch (err) {
    res.status(500).json({ data: null, error: err instanceof Error ? err.message : "internal" });
  }
});

// POST /api/admin/v304/anthem/revive
// One-click «Реанимировать последний гимн»: находит последний gen с
// templateSlug='v304-anthem', форсит pollProcessingGenerations и
// возвращает текущий статус + watchUrl. Используется кнопкой в /admin.
router.post("/anthem/revive", requireAdmin, async (_req, res) => {
  try {
    const last = db.get<{ id: number; status: string; taskId: string | null; resultUrl: string | null; errorReason: string | null; createdAt: string }>(
      sql`SELECT id, status, task_id as taskId, result_url as resultUrl, error_reason as errorReason, created_at as createdAt
          FROM generations
          WHERE template_slug = 'v304-anthem'
          ORDER BY id DESC
          LIMIT 1`,
    );
    if (!last) {
      return res.json({ data: { found: false, message: "Гимны ещё не запускались" }, error: null });
    }

    let pollResult: any = null;
    let recoveredFromError = false;

    if (last.status === "processing" && last.taskId) {
      pollResult = await pollProcessingGenerations();
    } else if (last.status === "error" && last.taskId) {
      // ТЗ Eugene 2026-05-07 11:08: «проверь последний запуск по шаблону».
      // Если gen в error но Suno реально вернул succeeded — recovery.
      const apiKey = process.env.GPTUNNEL_API_KEY ?? "";
      if (apiKey) {
        try {
          const r = await fetch("https://gptunnel.ru/v1/media/result", {
            method: "POST",
            headers: { Authorization: apiKey, "Content-Type": "application/json" },
            body: JSON.stringify({ task_id: last.taskId }),
            signal: AbortSignal.timeout(15_000),
          });
          if (r.ok) {
            const data: any = await r.json();
            const succeeded = Array.isArray(data?.result)
              ? data.result.find((t: any) => t.status === "succeeded" && t.audio_url)
              : null;
            if (succeeded) {
              db.run(sql`UPDATE generations
                         SET status='done', result_url=${succeeded.audio_url},
                             result_data=${JSON.stringify(data)}, error_reason=NULL
                         WHERE id=${last.id}`);
              recoveredFromError = true;
            }
          }
        } catch (e) {
          console.error(`[ANTHEM-REVIVE] recovery poll failed for gen #${last.id}:`, e);
        }
      }
    }

    // Re-read после поллинга/recovery
    const fresh = db.get<{ id: number; status: string; resultUrl: string | null; errorReason: string | null }>(
      sql`SELECT id, status, result_url as resultUrl, error_reason as errorReason
          FROM generations WHERE id = ${last.id}`,
    );

    res.json({
      data: {
        found: true,
        generationId: fresh?.id ?? last.id,
        status: fresh?.status ?? last.status,
        resultUrl: fresh?.resultUrl ?? null,
        errorReason: fresh?.errorReason ?? null,
        createdAt: last.createdAt,
        watchUrl: `/#/track/${fresh?.id ?? last.id}`,
        polled: !!pollResult,
        pollResult,
        recoveredFromError,
      },
      error: null,
    });
  } catch (err) {
    res.status(500).json({ data: null, error: err instanceof Error ? err.message : "internal" });
  }
});

router.post("/secrets/restart", requireAdmin, (_req, res) => {
  try {
    scheduleRestart();
    res.json({ data: { restartScheduled: true, etaSec: 2 }, error: null });
  } catch (err) {
    res.status(500).json({ data: null, error: err instanceof Error ? err.message : "internal" });
  }
});

router.post("/secrets/verify", requireAdmin, async (req, res) => {
  const key = String(req.body?.key ?? "");
  const meta = ROTATABLE_SECRETS[key];
  if (!meta) return res.status(400).json({ data: null, error: "unknown key" });
  if (!meta.verifiable) {
    return res.json({
      data: { key, verified: null, message: "автоматическая verification не реализована для этого ключа" },
      error: null,
    });
  }
  const env = readEnvFile();
  const value = env[key];
  if (!value) return res.status(400).json({ data: null, error: "secret not set" });

  if (key === "GPTUNNEL_API_KEY") {
    try {
      const r = await fetch("https://gptunnel.ru/v1/balance", {
        method: "GET",
        headers: { Authorization: value },
      });
      const body = await r.text();
      return res.json({
        data: {
          key,
          verified: r.ok,
          httpStatus: r.status,
          responsePreview: body.slice(0, 300),
          hint: r.ok
            ? "ключ валиден"
            : (r.status === 401 || r.status === 403)
              ? "ключ отвергнут GPTunnel — проверь актуальность в кабинете провайдера"
              : `неожиданный код ${r.status}`,
        },
        error: null,
      });
    } catch (err) {
      return res.json({
        data: { key, verified: false, error: err instanceof Error ? err.message : "fetch failed" },
        error: null,
      });
    }
  }

  res.json({ data: { key, verified: null }, error: null });
});

// ---- Audit log: список + restore ----
router.get("/audit", requireAdmin, (req, res) => {
  const limit = Math.min(Number(req.query.limit) || 100, 500);
  const entity = typeof req.query.entity === "string" ? req.query.entity : null;
  let q = db.select().from(adminAuditLog) as any;
  if (entity) q = q.where(eq(adminAuditLog.entity, entity));
  const rows = q.orderBy(desc(adminAuditLog.id)).limit(limit).all();
  res.json({ data: rows, error: null });
});

router.post("/audit/:id/restore", requireAdmin, (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isFinite(id)) return res.status(400).json({ data: null, error: "invalid id" });
  const entry = db.select().from(adminAuditLog).where(eq(adminAuditLog.id, id)).get();
  if (!entry) return res.status(404).json({ data: null, error: "audit entry not found" });
  if (!entry.beforeJson) {
    return res.status(400).json({ data: null, error: "no 'before' snapshot to restore (was a create)" });
  }
  let before: any;
  try {
    before = JSON.parse(entry.beforeJson);
  } catch (err) {
    return res.status(500).json({ data: null, error: "corrupted snapshot" });
  }

  try {
    if (entry.entity === "template") {
      // before — строка genTemplates
      const exists = db.select().from(genTemplates).where(eq(genTemplates.slug, entry.entityKey)).get();
      if (exists) {
        db.update(genTemplates).set(before).where(eq(genTemplates.slug, entry.entityKey)).run();
      } else {
        db.insert(genTemplates).values(before).run();
      }
    } else if (entry.entity === "flag") {
      const exists = db.select().from(featureFlags).where(eq(featureFlags.key, entry.entityKey)).get();
      if (exists) {
        db.update(featureFlags).set(before).where(eq(featureFlags.key, entry.entityKey)).run();
      } else {
        db.insert(featureFlags).values(before).run();
      }
    } else if (entry.entity === "lead") {
      const lid = parseInt(entry.entityKey, 10);
      if (!Number.isFinite(lid)) return res.status(400).json({ data: null, error: "invalid lead key" });
      db.update(leads).set(before).where(eq(leads.id, lid)).run();
    } else {
      return res.status(400).json({ data: null, error: `unknown entity: ${entry.entity}` });
    }

    const newAuditId = recordEdit(req, "restore", entry.entity, entry.entityKey, null, before, id);
    res.json({ data: { restored: true, fromAuditId: id, newAuditId, entity: entry.entity, entityKey: entry.entityKey }, error: null });
  } catch (err) {
    res.status(500).json({ data: null, error: err instanceof Error ? err.message : "internal" });
  }
});

const adminOverviewModule: Module = {
  name: "admin-overview",
  version: "0.1.0",
  description: "Sprint 7 — GET /api/admin/v304/overview, read-only dashboard data.",
  routes: { prefix: "admin/v304", router },
  publishes: [],
  jobs: [
    // Поллим Suno-генерации в processing каждую минуту → переводим в done/error.
    // Закрывает кейсы admin-launched anthem где у клиента нет авторизованного polling.
    {
      name: "anthem-poller",
      schedule: "every_minute",
      handler: async () => {
        const r = await pollProcessingGenerations();
        if (r.done > 0 || r.failed > 0) {
          console.log(`\x1b[32m[ANTHEM-POLL]\x1b[0m scanned=${r.scanned} done=${r.done} failed=${r.failed}`);
        }
      },
    },
  ],
  onLoad: async (ctx) => {
    ctx.logger.info("admin-overview online — GET /api/admin/v304/overview + every_minute poller");
  },
  healthCheck: () => ({ status: "ok" }),
};

export default adminOverviewModule;
