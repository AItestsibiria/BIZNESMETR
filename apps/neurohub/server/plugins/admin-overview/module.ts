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

// Список админ-emails. Можно один (legacy) или несколько через запятую:
// ADMIN_EMAIL=egnovoselov@gmail.com,второй@email.ru
const ADMIN_EMAILS: Set<string> = new Set(
  (process.env.ADMIN_EMAIL || "egnovoselov@gmail.com")
    .split(",")
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean),
);

// v51 хранит auth-token в Bearer-header → проверяет через таблицу sessions
// (token, user_id). Эта функция повторяет authMiddleware из routes.ts:263-318
// без импорта (роутс монолит, импортировать опасно).
function getUserIdFromRequest(req: any): number | null {
  const authHeader = req.headers?.authorization;
  let token: string | undefined;
  if (typeof authHeader === "string" && authHeader.startsWith("Bearer ")) {
    token = authHeader.slice(7);
  } else if (typeof req.query?.token === "string") {
    token = req.query.token;
  }
  if (!token) return null;
  try {
    const row = db.get<{ userId: number }>(
      sql`SELECT user_id as userId FROM sessions WHERE token = ${token} LIMIT 1`,
    );
    return row?.userId ?? null;
  } catch {
    return null;
  }
}

function requireAdmin(req: any, res: any, next: any): void {
  const userId = getUserIdFromRequest(req);
  if (!userId) {
    res.status(401).json({ data: null, error: "unauthorized" });
    return;
  }
  const u = db.select().from(users).where(eq(users.id, userId)).get();
  if (!u) {
    res.status(401).json({ data: null, error: "user not found" });
    return;
  }
  if (!ADMIN_EMAILS.has((u.email ?? "").toLowerCase())) {
    res.status(403).json({ data: null, error: "forbidden" });
    return;
  }
  // Прокидываем userId дальше — used by recordEdit().
  (req as any).userId = userId;
  (req as any).adminUser = u;
  next();
}

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

// SUNO_TRACK_COST — расчётная стоимость одного трека Suno в рублях у GPTunnel.
// На GPTunnel «реальный» баланс — это рубли в кошельке, а Suno-модель не
// имеет отдельного эндпоинта баланса. Поэтому расчёт: tracks = floor(balance/cost).
// Конфигурируется env (SUNO_TRACK_COST=8), default 8₽ исходя из текущего тарифа.
const SUNO_TRACK_COST = Number(process.env.SUNO_TRACK_COST ?? "8") || 8;

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
  GPTUNNEL_API_KEY: { name: "GPTunnel API key", description: "Suno + LLM router", verifiable: true },
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
      const errMsg = upstream?.message ?? upstream?.error?.message ?? `Suno вернул ${upstreamStatus}`;
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
      db.run(sql`UPDATE generations SET status='error', error_reason='Suno timeout > 30 min'
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

router.post("/poll-now", requireAdmin, async (_req, res) => {
  try {
    const result = await pollProcessingGenerations();
    res.json({ data: result, error: null });
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
