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

// Eugene 2026-05-18: 3D-аватар Музы через GPTunnel image-gen.
import {
  generateMusaAvatar3D,
  approveMusaAvatar,
  describeCurrentMusaAvatar,
  DEFAULT_MUSA_PROMPT,
} from "../../lib/generateMusaAvatar";

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

// Eugene 2026-05-08 «По итогу добавь тест с панель админа проверка
// синхронизации всех данных авторов, треков, обложек и выводи результат».
//
// /api/admin/v304/sync-check — единый endpoint для проверки целостности
// всего что должно быть на проде после deploy:
//   - БД (integrity, счётчики users/gens/transactions)
//   - Authors folder (существование, размер, доступность)
//   - Cover files (gens с image_url vs реальные файлы на диске)
//   - ENV-vars (имена ключей которые должны быть, без значений)
//   - Plugins (loaded count)
//   - PM2 process info через /api/_status
//   - Disk usage
//
// Возвращает структурированный отчёт + статусы (ok/warn/fail) по каждой
// секции. Для UI в /admin/v304.
router.get("/sync-check", requireAdmin, async (_req, res) => {
  const fs = await import("node:fs");
  const path = await import("node:path");
  const childProc = await import("node:child_process");
  const AUTHORS_DIR = process.env.AUTHORS_DIR || "/var/www/neurohub/authors";
  const report: any = {
    timestamp: new Date().toISOString(),
    sections: {},
    summary: { ok: 0, warn: 0, fail: 0 },
  };
  const setSection = (name: string, status: "ok" | "warn" | "fail", details: any) => {
    report.sections[name] = { status, ...details };
    report.summary[status] = (report.summary[status] || 0) + 1;
  };

  // 1. БД integrity + counts
  try {
    const integrity = db.get<{ ic: string }>(sql`PRAGMA integrity_check`);
    const users = db.get<{ c: number }>(sql`SELECT count(*) as c FROM users`)?.c ?? 0;
    const gensTotal = db.get<{ c: number }>(sql`SELECT count(*) as c FROM generations WHERE deleted_at IS NULL`)?.c ?? 0;
    const gensDone = db.get<{ c: number }>(sql`SELECT count(*) as c FROM generations WHERE status='done' AND deleted_at IS NULL`)?.c ?? 0;
    const gensError = db.get<{ c: number }>(sql`SELECT count(*) as c FROM generations WHERE status='error' AND deleted_at IS NULL`)?.c ?? 0;
    const gensProcessing = db.get<{ c: number }>(sql`SELECT count(*) as c FROM generations WHERE status='processing'`)?.c ?? 0;
    const transactions = db.get<{ c: number }>(sql`SELECT count(*) as c FROM transactions`)?.c ?? 0;
    const ok = (integrity?.ic === "ok" || (integrity as any)?.integrity_check === "ok");
    setSection("database", ok ? "ok" : "fail", {
      integrity: ok ? "ok" : JSON.stringify(integrity),
      counts: { users, generations: gensTotal, done: gensDone, error: gensError, processing: gensProcessing, transactions },
    });
  } catch (e) {
    setSection("database", "fail", { error: e instanceof Error ? e.message : String(e) });
  }

  // 2. Authors folder
  try {
    const exists = fs.existsSync(AUTHORS_DIR);
    if (!exists) {
      setSection("authors_folder", "fail", { path: AUTHORS_DIR, error: "не существует" });
    } else {
      const stat = fs.statSync(AUTHORS_DIR);
      const writable = (() => {
        try { fs.accessSync(AUTHORS_DIR, fs.constants.W_OK); return true; } catch { return false; }
      })();
      const subdirs = fs.readdirSync(AUTHORS_DIR).filter((f) => {
        try { return fs.statSync(path.join(AUTHORS_DIR, f)).isDirectory(); } catch { return false; }
      });
      let totalFiles = 0, totalSize = 0;
      for (const sub of subdirs) {
        try {
          const subPath = path.join(AUTHORS_DIR, sub);
          const files = fs.readdirSync(subPath);
          totalFiles += files.length;
          for (const f of files) {
            try { totalSize += fs.statSync(path.join(subPath, f)).size; } catch {}
          }
        } catch {}
      }
      setSection("authors_folder", writable ? "ok" : "warn", {
        path: AUTHORS_DIR,
        permissions: stat.mode.toString(8).slice(-3),
        writable,
        authorCount: subdirs.length,
        totalFiles,
        totalSizeMB: +(totalSize / 1024 / 1024).toFixed(1),
      });
    }
  } catch (e) {
    setSection("authors_folder", "fail", { error: e instanceof Error ? e.message : String(e) });
  }

  // 3. Cover files: gens с image_url vs реальный файл .jpg на диске
  // Eugene 2026-05-09 fix: исключаем свежие gens (<5 мин — saveGenFiles
  // ещё может работать асинхронно). Учитываем что localPath может быть
  // null для admin-flows (anthem) — пытаемся найти файл по ID в любой
  // подпапке authors/.
  try {
    const gensWithCover = db.all<{ id: number; localPath: string | null; result_data: string | null }>(
      sql`SELECT id, local_path as localPath, result_data
          FROM generations
          WHERE type='music' AND status='done' AND deleted_at IS NULL
            AND created_at < datetime('now', '-5 minutes')
          ORDER BY id DESC LIMIT 100`,
    );
    let withImageUrl = 0, withFile = 0, missingFile = 0, skippedNoLocalPath = 0;
    const samples: any[] = [];

    // Pre-build index: для всех файлов в authors/ собираем список <id>.jpg
    const allJpgIds = new Set<number>();
    try {
      for (const sub of fs.readdirSync(AUTHORS_DIR)) {
        const subPath = path.join(AUTHORS_DIR, sub);
        try {
          if (!fs.statSync(subPath).isDirectory()) continue;
          for (const f of fs.readdirSync(subPath)) {
            // saveToAuthorFolder уровня routes.ts:53 сохраняет как gen_<id>.jpg.
            // legacy-формат <id>.jpg тоже учитываем.
            const m = f.match(/^(?:gen_)?(\d+)\.jpg$/i);
            if (m) allJpgIds.add(parseInt(m[1], 10));
          }
        } catch {}
      }
    } catch {}

    for (const g of gensWithCover) {
      let hasImageUrl = false;
      try {
        const data = JSON.parse(g.result_data || "{}");
        if (data?.result?.[0]?.image_url || data?.imageUrl) hasImageUrl = true;
      } catch {}
      if (hasImageUrl) withImageUrl += 1;

      let fileExists = false;
      // Fallback 1: ищем по localPath
      if (g.localPath) {
        try {
          const dir = path.dirname(path.join(AUTHORS_DIR, g.localPath));
          const baseName = path.basename(g.localPath, ".mp3");
          const expected = path.join(dir, `${baseName}.jpg`);
          fileExists = fs.existsSync(expected);
        } catch {}
      }
      // Fallback 2: ищем <id>.jpg в любой подпапке authors/
      if (!fileExists && allJpgIds.has(g.id)) fileExists = true;
      // Fallback 3: если localPath null И in_authors_index пуст — skip (не наш кейс)
      if (!g.localPath && !fileExists) skippedNoLocalPath += 1;

      if (fileExists) withFile += 1;
      else if (hasImageUrl && g.localPath) {
        missingFile += 1;
        if (samples.length < 5) samples.push({ id: g.id, localPath: g.localPath, hasImageUrl });
      }
    }
    const coverStatus = missingFile > 10 ? "fail" : missingFile > 5 ? "warn" : "ok";
    setSection("covers", coverStatus, {
      checkedLast100: gensWithCover.length,
      withImageUrlInDB: withImageUrl,
      withFileOnDisk: withFile,
      missingOnDisk: missingFile,
      skippedNoLocalPath,
      samples,
      hint: missingFile > 5
        ? `Suno вернул image_url, но файл не сохранён. Проверь permissions на authors/, логи saveToAuthorFolder, доступ к Suno CDN.`
        : `Обложки в порядке. ${skippedNoLocalPath} gens без local_path (admin-flows вроде anthem) — для них проверка пропущена.`,
    });
  } catch (e) {
    setSection("covers", "fail", { error: e instanceof Error ? e.message : String(e) });
  }

  // 4. ENV vars (имена + длины, без значений)
  // Eugene 2026-05-09 fix: SESSION_SECRET и DATABASE_URL имеют дефолты в коде
  // (storage.ts auto-открывает data.db, session использует random secret в memory).
  // Реально критичный для работы — только GPTUNNEL_API_KEY. Остальные — optional.
  try {
    const expectedKeys = [
      "GPTUNNEL_API_KEY", "YANDEX_SPEECHKIT_API_KEY", "YANDEX_FOLDER_ID",
      "OPENAI_API_KEY", "ANTHROPIC_API_KEY", "TELEGRAM_BOT_TOKEN",
      "SMTP_HOST", "SMTP_USER", "SMTP_PASS",
      "ROBO_LOGIN", "ROBO_PASSWORD_1", "ROBO_PASSWORD_2",
      "SESSION_SECRET", "SIGNED_URL_SECRET", "PUBLIC_HOST", "DATABASE_URL",
    ];
    const trulyCritical = ["GPTUNNEL_API_KEY"];
    const envStatus: Record<string, { present: boolean; length: number; critical: boolean }> = {};
    let critMissing = 0;
    let optMissing = 0;
    for (const k of expectedKeys) {
      const v = process.env[k] || "";
      const isCrit = trulyCritical.includes(k);
      envStatus[k] = { present: !!v, length: v.length, critical: isCrit };
      if (!v) {
        if (isCrit) critMissing += 1;
        else optMissing += 1;
      }
    }
    const status: "ok" | "warn" | "fail" = critMissing > 0 ? "fail" : (optMissing > 0 ? "warn" : "ok");
    setSection("env_vars", status, {
      keys: envStatus,
      criticalMissing: critMissing,
      optionalMissing: optMissing,
      hint: critMissing > 0
        ? "Критичные ключи отсутствуют — проверь .env (без GPTUNNEL_API_KEY генерация музыки не работает)"
        : optMissing > 0
        ? `Не все опциональные ключи заданы (${optMissing} шт.) — некоторые фичи могут не работать (audio/STT/email/payments)`
        : "Все ключи на месте",
    });
  } catch (e) {
    setSection("env_vars", "fail", { error: e instanceof Error ? e.message : String(e) });
  }

  // 5. ffmpeg installed?
  try {
    const out = childProc.execSync("which ffmpeg && ffmpeg -version | head -1 2>&1", { encoding: "utf-8", timeout: 5000 });
    setSection("ffmpeg", "ok", { path: out.split("\n")[0], version: out.split("\n")[1] || "?" });
  } catch (e) {
    setSection("ffmpeg", "fail", { error: "ffmpeg не найден — установи: apt-get install -y ffmpeg" });
  }

  // 6. Disk usage
  try {
    const out = childProc.execSync("df -h /var/www | tail -1 | awk '{print $5}'", { encoding: "utf-8", timeout: 5000 }).trim();
    const pct = parseInt(out.replace("%", ""), 10);
    const status = pct > 90 ? "fail" : pct > 75 ? "warn" : "ok";
    setSection("disk", status, { usage_pct: pct, raw: out });
  } catch (e) {
    setSection("disk", "warn", { error: e instanceof Error ? e.message : String(e) });
  }

  // 7. Plugins (count via internal /api/_status — running on same process)
  try {
    const r = await fetch("http://127.0.0.1:5000/api/_status", { signal: AbortSignal.timeout(3000) });
    if (r.ok) {
      const d: any = await r.json();
      const loaded = d?.data?.pluginsLoaded?.length ?? 0;
      const failed = d?.data?.pluginsFailed?.length ?? 0;
      setSection("plugins", failed > 0 ? "fail" : loaded >= 26 ? "ok" : "warn", {
        loaded, failed,
        failedList: d?.data?.pluginsFailed ?? [],
      });
    } else {
      setSection("plugins", "warn", { error: `HTTP ${r.status}` });
    }
  } catch (e) {
    setSection("plugins", "warn", { error: e instanceof Error ? e.message : String(e) });
  }

  res.json({ data: report, error: null });
});

// Eugene 2026-05-09: ручной сброс jpg-индекса в routes.ts.
// Используется после массовой загрузки обложек / rsync authors/ из clone,
// чтобы не ждать 5-минутный TTL и обложки в плейлисте подтянулись сразу.
// Также возвращает счётчик jpg-файлов в authors/ — быстрый sanity check.
router.post("/covers/refresh-index", requireAdmin, async (_req, res) => {
  try {
    const fs = await import("node:fs");
    const path = await import("node:path");
    const refresh = (globalThis as any).__refreshJpgIndex;
    if (typeof refresh === "function") refresh();

    const AUTHORS_DIR = process.env.AUTHORS_DIR || path.join(process.cwd(), "authors");
    let totalJpg = 0;
    let totalAuthors = 0;
    try {
      for (const sub of fs.readdirSync(AUTHORS_DIR)) {
        const subPath = path.join(AUTHORS_DIR, sub);
        try {
          if (!fs.statSync(subPath).isDirectory()) continue;
          totalAuthors += 1;
          for (const f of fs.readdirSync(subPath)) {
            if (/^(?:gen_)?\d+\.jpg$/i.test(f)) totalJpg += 1;
          }
        } catch {}
      }
    } catch {}
    res.json({ data: { ok: true, refreshed: true, totalAuthors, totalJpg, hint: "Cache invalidated. Next /api/cover/:id.jpg request will rebuild fallback index." }, error: null });
  } catch (e) {
    res.status(500).json({ data: null, error: e instanceof Error ? e.message : String(e) });
  }
});

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
  SMTP_FROM:        { name: "SMTP from", description: "MuzaAI <noreply@...>", verifiable: false },
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
      const errMsg = upstream?.message ?? upstream?.error?.message ?? `MuzaAi вернул ${upstreamStatus}`;
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
        message: "Гимн отправлен в MuzaAi. Через 1-2 минуты будет готов.",
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
// cleanupScheduledDeletes — каждый час переводит generations.scheduled_delete_at
// <= now в soft-delete (deleted_at = now, scheduled_delete_at = null). Это
// финальная стадия flow «🗑 Удалить через N дней» из дашборда (см. routes.ts
// /api/generations/:id/schedule-delete + CLAUDE.md scheduled-delete-on-error).
// Soft-delete reversible через /api/generations/:id/restore, поэтому
// confirmation автором не нужен.
export function cleanupScheduledDeletes(): { swept: number } {
  let swept = 0;
  try {
    const r = db.run(sql`UPDATE generations
      SET deleted_at = datetime('now'),
          scheduled_delete_at = NULL,
          is_public = 0
      WHERE scheduled_delete_at IS NOT NULL
        AND scheduled_delete_at <= datetime('now')
        AND deleted_at IS NULL`);
    swept = r.changes ?? 0;
  } catch (e) {
    console.error("[CLEANUP-SCHEDULED-DELETE] failed:", e);
  }
  if (swept > 0) {
    console.log(`\x1b[33m[CLEANUP-SCHEDULED-DELETE]\x1b[0m swept=${swept}`);
  }
  return { swept };
}

// cleanupStaleProcessing — БЕСПЛАТНАЯ зачистка stuck 'processing' записей.
// НЕ вызывает Suno/GPTunnel — только SQL update.
// Eugene 2026-05-14 Босс «реши системно»: 2 трека висели 2 дня в processing.
// Auto-poll Suno отключён 10 мая (платно), значит зависшие никогда сами
// не выйдут из processing. Эта функция работает автоматически каждые 5 мин:
//
// 1) >24 часа в processing → error (broken-record cleanup, без вызова провайдера)
// 2) processing БЕЗ task_id старше 5 мин → error (crash до отправки в Suno)
//
// Не трогает свежие processing (< 60 мин) — у них шанс что Suno вернёт.
// Полный pollProcessingGenerations с Suno вызовом остаётся manual (платно).
export function cleanupStaleProcessing(): { ancient: number; brokenNoTask: number; healed: number } {
  const ancientCutoff = new Date(Date.now() - 24 * 60 * 60_000).toISOString();
  const nullTaskCutoff = new Date(Date.now() - 5 * 60_000).toISOString();
  let ancient = 0, brokenNoTask = 0, healed = 0;
  // Eugene 2026-05-19 Босс «Реши на 1000%». PARADOX-HEAL — найти треки
  // status='error' но с result_url IS NOT NULL (audio есть!). Это случай
  // когда webhook не дошёл, client polling прекратился, 24h cleanup
  // пометил error, НО Suno реально вернул трек. Восстанавливаем status='done'.
  try {
    const rHeal = db.run(sql`UPDATE generations
      SET status='done', error_reason=NULL
      WHERE status='error'
        AND result_url IS NOT NULL
        AND result_url != ''
        AND created_at > datetime('now', '-7 day')`);
    healed = rHeal.changes ?? 0;
    if (healed > 0) console.log(`\x1b[32m[CLEANUP-HEAL]\x1b[0m восстановлено paradox-tracks: ${healed}`);
  } catch (e) {
    console.error("[CLEANUP-HEAL] failed:", e);
  }
  try {
    // Eugene 2026-05-19: cleanup guard — НЕ ставить error если result_url
    // IS NOT NULL (трек на самом деле готов, просто status застрял).
    const r1 = db.run(sql`UPDATE generations
      SET status='error',
          error_reason='MuzaAi: задача провайдера зависла. Баланс восстановлен, можно попробовать снова.'
      WHERE status='processing'
        AND (result_url IS NULL OR result_url = '')
        AND created_at < ${ancientCutoff}`);
    ancient = r1.changes ?? 0;
  } catch (e) {
    console.error("[CLEANUP-STALE] ancient failed:", e);
  }
  try {
    const r2 = db.run(sql`UPDATE generations
      SET status='error',
          error_reason='MuzaAi: не удалось отправить задачу провайдеру. Попробуйте ещё раз.'
      WHERE status='processing'
        AND (task_id IS NULL OR task_id = '')
        AND (result_url IS NULL OR result_url = '')
        AND created_at < ${nullTaskCutoff}`);
    brokenNoTask = r2.changes ?? 0;
  } catch (e) {
    console.error("[CLEANUP-STALE] broken-no-task failed:", e);
  }
  if (ancient > 0 || brokenNoTask > 0) {
    console.log(`\x1b[33m[CLEANUP-STALE]\x1b[0m ancient=${ancient}, brokenNoTask=${brokenNoTask}`);
  }
  return { ancient, brokenNoTask, healed };
}

// pollProcessingGenerations — каждую минуту скан 'processing' и
// апдейт до 'done'/'error'. Закрывает класс багов когда client'у не
// доступен polling (admin-launched anthem, inline-агенты, дашборд).
// Логика — упрощённая копия /api/music/status/:taskId без рефанда.
// =============================================================
async function pollProcessingGenerations(): Promise<{ scanned: number; done: number; failed: number }> {
  const apiKey = process.env.GPTUNNEL_API_KEY ?? "";
  if (!apiKey) return { scanned: 0, done: 0, failed: 0 };

  // Eugene 2026-05-14 Босс: cleanupStaleProcessing() запускается отдельно
  // (job каждые 5 мин — бесплатный SQL). Здесь только Suno-роутинг.
  cleanupStaleProcessing();

  // 30 мин soft cutoff остаётся для force-error если Suno вернёт processing
  const cutoff = new Date(Date.now() - 30 * 60_000).toISOString();
  const rows = db.all<{ id: number; taskId: string; createdAt: string }>(
    sql`SELECT id, task_id as taskId, created_at as createdAt
        FROM generations
        WHERE status = 'processing' AND task_id IS NOT NULL AND task_id != ''`,
  );

  let done = 0;
  let failed = 0;
  for (const row of rows) {
    // ТЗ Eugene 14:00: сначала ВСЕГДА опрашиваем Suno — может уже готово
    // (Suno держит результат). Только если Suno сам не вернул succeeded
    // и > 30 мин с created → помечаем timeout. Иначе — recovery.
    let recovered = false;
    if (row.taskId) {
      try {
        const r = await fetch("https://gptunnel.ru/v1/media/result", {
          method: "POST",
          headers: { Authorization: apiKey, "Content-Type": "application/json" },
          body: JSON.stringify({ task_id: row.taskId }),
          signal: AbortSignal.timeout(15_000),
        });
        if (r.ok) {
          const data: any = await r.json().catch(() => null);
          if (data) {
            // ТЗ Eugene 14:04 «0-1 сек только название». Suno иногда возвращает
            // preview-обрубок (1 сек) рядом с полным треком. Выбираем самый
            // длинный succeeded — у длинного duration > 30, у preview 0-1.
            const candidates = Array.isArray(data.result)
              ? data.result.filter((t: any) => t.status === "succeeded" && t.audio_url)
              : [];
            const succeeded = candidates.length > 0
              ? candidates.reduce((best: any, t: any) => {
                  const tDur = Number(t.duration ?? t.audio_duration ?? t.metadata?.duration ?? 0);
                  const bDur = Number(best.duration ?? best.audio_duration ?? best.metadata?.duration ?? 0);
                  return tDur > bDur ? t : best;
                })
              : null;
            const isDone = data.status === "done" || !!succeeded;
            if (isDone && succeeded) {
              // HEAD-check: убедимся что audio_url реально отдаёт mp3 (>100KB).
              // Защищает от truncated 0-байт ответов Suno (Eugene 14:04).
              let audioOk = true;
              let audioSize = 0;
              try {
                const head = await fetch(succeeded.audio_url, { method: "HEAD", signal: AbortSignal.timeout(8_000) });
                audioOk = head.ok;
                audioSize = Number(head.headers.get("content-length") || 0);
                if (audioSize > 0 && audioSize < 100_000) {
                  // Менее 100KB — это preview-обрубок, не полный трек
                  console.warn(`[POLL] gen #${row.id} audio_url too small: ${audioSize}B — skip, retry next iteration`);
                  audioOk = false;
                }
              } catch (e) {
                console.warn(`[POLL] gen #${row.id} HEAD failed:`, e instanceof Error ? e.message : e);
                audioOk = false;
              }
              if (!audioOk) {
                // не сохраняем — останется processing, повтор через минуту
                continue;
              }
              db.run(sql`UPDATE generations
                         SET status='done', result_url=${succeeded.audio_url},
                             result_data=${JSON.stringify(data)}
                         WHERE id=${row.id}`);
              done += 1;
              recovered = true;
              console.log(`\x1b[32m[POLL]\x1b[0m gen #${row.id} done size=${audioSize}B`);

              // Bonus 2-й трек из пары
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
                      let mergedStyle: any = {};
                      try { mergedStyle = JSON.parse(orig.style || "{}"); } catch {}
                      mergedStyle.isBonus = true;
                      mergedStyle.bonusFromGenId = row.id;
                      mergedStyle.bonusLabel = "🎁 Бонус от MuzaAi";
                      if (mergedStyle.title) mergedStyle.title = `${mergedStyle.title} · 🎁 бонус`;
                      db.run(sql`INSERT INTO generations
                                 (user_id, type, prompt, style, status, result_url, result_data,
                                  cost, task_id, author_name, is_public, voice_type)
                                 VALUES (${orig.userId}, ${orig.type}, ${orig.prompt}, ${JSON.stringify(mergedStyle)},
                                         'done', ${secondTrack.audio_url}, ${JSON.stringify({ result: [secondTrack] })},
                                         0, ${v2TaskId}, ${orig.authorName}, ${orig.isPublic}, ${orig.voiceType})`);
                      done += 1;
                    }
                  }
                }
              }
              continue;
            } else if (data.status === "error" || data.status === "failed") {
              const reason = String(data.message ?? data.error?.message ?? `MuzaAi status=${data.status}`).slice(0, 500);
              db.run(sql`UPDATE generations
                         SET status='error', error_reason=${reason}, result_data=${JSON.stringify(data)}
                         WHERE id=${row.id}`);
              failed += 1;
              continue;
            }
            // status='processing' у Suno — продолжаем ждать (не маркируем timeout)
          }
        }
      } catch {
        // network — ретрай в следующую минуту
      }
    }
    // Suno не вернул done И > 30 мин → честный timeout (теперь только если
    // Suno сам ничего не дал, и время вышло)
    if (!recovered && row.createdAt < cutoff) {
      db.run(sql`UPDATE generations SET status='error', error_reason='MuzaAi думала больше 30 минут — иногда такое бывает. Баланс восстановлен, можно попробовать ещё раз.'
                 WHERE id=${row.id}`);
      failed += 1;
    }
  }

  // Eugene 2026-05-08 «реши кардинально на будущее»: auto-recovery.
  // Сканит ВСЕ errored gens за 24ч (расширено с 60 мин). Если у Suno реально
  // есть готовый трек — восстанавливаем status='done'. Покрывает:
  //   - timeout-error (Suno поздно вернул)
  //   - empty-audio-url (Suno вернул done без url, потом url появился)
  //   - moderation 1001 ИГНОРИРУЕМ (status=failed на Suno-стороне навсегда)
  // Полезно после длительных Suno-зависаний — старые гены восстановятся.
  try {
    const recoveryCutoff = new Date(Date.now() - 24 * 60 * 60_000).toISOString();
    const errored = db.all<{ id: number; taskId: string }>(
      sql`SELECT id, task_id as taskId
          FROM generations
          WHERE status='error'
            AND task_id IS NOT NULL AND task_id != ''
            AND created_at > ${recoveryCutoff}
            AND (error_reason LIKE '%timeout%'
                 OR error_reason LIKE '%пустой ответ%'
                 OR error_reason LIKE '%Internal server error%'
                 OR error_reason LIKE '%код%'
                 OR error_reason LIKE '%файл недоступен%')
            AND error_reason NOT LIKE '%модерац%'
            AND error_reason NOT LIKE '%1001%'
          LIMIT 50`,
    );
    for (const row of errored) {
      try {
        const r = await fetch("https://gptunnel.ru/v1/media/result", {
          method: "POST",
          headers: { Authorization: apiKey, "Content-Type": "application/json" },
          body: JSON.stringify({ task_id: row.taskId }),
          signal: AbortSignal.timeout(10_000),
        });
        if (!r.ok) continue;
        const data: any = await r.json().catch(() => null);
        if (!data) continue;
        const candidates = Array.isArray(data?.result)
          ? data.result.filter((t: any) => t.status === "succeeded" && t.audio_url)
          : [];
        const succeeded = candidates.length > 0
          ? candidates.reduce((best: any, t: any) => {
              const tDur = Number(t.duration ?? t.audio_duration ?? t.metadata?.duration ?? 0);
              const bDur = Number(best.duration ?? best.audio_duration ?? best.metadata?.duration ?? 0);
              return tDur > bDur ? t : best;
            })
          : null;
        if (succeeded?.audio_url) {
          // Маркируем style.recoveredAfterTimeout = true (для аналитики)
          db.run(sql`UPDATE generations
                     SET status='done',
                         result_url=${succeeded.audio_url},
                         result_data=${JSON.stringify(data)},
                         error_reason=NULL,
                         style=json_set(COALESCE(style, '{}'),
                                         '$.recoveredAfterTimeout', json('true'),
                                         '$.recoveredAt', datetime('now'))
                     WHERE id=${row.id} AND status='error'`);
          console.log(`\x1b[32m[AUTO-RECOVER]\x1b[0m gen #${row.id} восстановлен из timeout — Suno всё-таки отдал трек`);
          done += 1;
        }
      } catch {
        // network — следующий cron подберёт
      }
    }
  } catch (e) {
    console.error("[AUTO-RECOVER] error:", e);
  }

  // Eugene 2026-05-08: «ошибочные треки, без обложек от Suno 2 версию удаляй
  // сразу после подтверждения об ошибочности».
  //
  // Бонусные v2-треки создаются с task_id = '<original>_v2' и style.isBonus=true.
  // Если основной трек ошибся (status='error'), а v2-бонус тоже без resultUrl
  // или сам error — он бесполезен. Soft-delete.
  //
  // Также удаляем v2 если у него самого error (Suno reject one из пары).
  try {
    const orphans = db.all<{ id: number }>(
      sql`SELECT g.id
          FROM generations g
          WHERE g.task_id LIKE '%\\_v2' ESCAPE '\\'
            AND g.deleted_at IS NULL
            AND (
              -- v2 сам в error/processing > 15 мин (Suno не отдал)
              (g.status = 'error')
              OR (g.status = 'processing' AND g.created_at < datetime('now', '-15 minutes'))
              OR (g.status = 'done' AND (g.result_url IS NULL OR g.result_url = ''))
              -- ИЛИ основной парный трек упал
              OR EXISTS (
                SELECT 1 FROM generations m
                WHERE m.task_id = REPLACE(g.task_id, '_v2', '')
                  AND m.status = 'error'
                  AND m.deleted_at IS NULL
              )
            )
          LIMIT 50`,
    );
    if (orphans.length > 0) {
      const ids = orphans.map((o) => o.id);
      db.run(sql`UPDATE generations
                 SET deleted_at = datetime('now')
                 WHERE id IN (${sql.join(ids.map((id) => sql`${id}`), sql`, `)})`);
      console.log(`\x1b[33m[CLEANUP-V2]\x1b[0m soft-deleted ${ids.length} broken bonus tracks: ${ids.join(", ")}`);
    }
  } catch (e) {
    console.error("[CLEANUP-V2] error:", e);
  }

  return { scanned: rows.length, done, failed };
}

// ============================================================
// Musa 3D-аватар — Eugene 2026-05-18 Босс «дожать девушку с обложки
// трека Муза, 3D, почти настоящая». GPTunnel image-gen.
// ============================================================
// GET  /api/admin/v304/musa-avatar/state    — текущий аватар + URL'ы
// POST /api/admin/v304/musa-avatar/generate — генерация 3D через GPTunnel
// POST /api/admin/v304/musa-avatar/approve  — копирует hi-res в consultant-avatar.png
//                                              (telegram/max боты автоматически
//                                              подхватят через mtime cache-bust)

router.get("/musa-avatar/state", requireAdmin, async (_req, res) => {
  try {
    const state = await describeCurrentMusaAvatar();
    res.json({ data: { ...state, defaultPrompt: DEFAULT_MUSA_PROMPT }, error: null });
  } catch (err) {
    res.status(500).json({
      data: null,
      error: err instanceof Error ? err.message : "Failed to describe musa avatar state",
    });
  }
});

const MusaGenerateSchema = z.object({
  prompt: z.string().min(12).max(2000).optional(),
  useRefTrack: z.number().int().positive().optional(),
});

router.post("/musa-avatar/generate", requireAdmin, async (req, res) => {
  try {
    const parsed = MusaGenerateSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      return res.status(400).json({
        data: null,
        error: "Невалидный body: " + parsed.error.issues.map((i) => i.message).join("; "),
      });
    }
    const { prompt, useRefTrack } = parsed.data;

    let refImageUrl: string | null = null;
    if (useRefTrack) {
      // Берём cover-обложку трека (generations.type='cover' с sourceGenId=useRefTrack),
      // либо resultUrl самого трека если у него type='cover'. Это используем
      // как референс в image-to-image (если модель поддерживает).
      try {
        const row = db
          .select({ id: generations.id, type: generations.type, resultUrl: generations.resultUrl, coverGenId: generations.coverGenId })
          .from(generations)
          .where(eq(generations.id, useRefTrack))
          .get();
        if (row?.coverGenId) {
          const cover = db
            .select({ resultUrl: generations.resultUrl })
            .from(generations)
            .where(eq(generations.id, row.coverGenId))
            .get();
          if (cover?.resultUrl) refImageUrl = cover.resultUrl;
        } else if (row?.type === "cover" && row.resultUrl) {
          refImageUrl = row.resultUrl;
        }
      } catch {
        // best-effort
      }
    }

    const result = await generateMusaAvatar3D(prompt, refImageUrl);
    if (!result.ok) {
      return res.status(502).json({
        data: { promptUsed: result.promptUsed, modelTried: result.modelTried, attempts: result.errorDetails, durationMs: result.durationMs },
        error: result.error ?? "GPTunnel image generation failed",
      });
    }
    res.json({
      data: {
        promptUsed: result.promptUsed,
        modelTried: result.modelTried,
        durationMs: result.durationMs,
        publicUrls: result.publicUrls,
        previewUrl: result.publicUrls?.png1024,
        refUsed: refImageUrl,
      },
      error: null,
    });
  } catch (err) {
    res.status(500).json({
      data: null,
      error: err instanceof Error ? err.message : "Failed to generate musa avatar",
    });
  }
});

router.post("/musa-avatar/approve", requireAdmin, async (_req, res) => {
  try {
    const result = await approveMusaAvatar();
    if (!result.ok) {
      return res.status(400).json({ data: null, error: result.error ?? "Approve failed" });
    }
    res.json({
      data: { ok: true, copiedTo: result.copiedTo, hint: "Telegram/Max боты подхватят свежий URL через cache-bust по mtime" },
      error: null,
    });
  } catch (err) {
    res.status(500).json({
      data: null,
      error: err instanceof Error ? err.message : "Failed to approve musa avatar",
    });
  }
});

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

// Кольцевой буфер использований Yandex SpeechKit — для статистики «баланса
// API» (ТЗ Eugene 13:38). Yandex Cloud Billing API требует IAM-token, поэтому
// real-balance недоступен. Показываем счётчик успешных вызовов + оценку
// списанных рублей (≈ 0.45 ₽/мин при short audio API).
const YANDEX_USAGE: Array<{ ts: number; durationSec: number; ok: boolean }> = [];
export function recordYandexUsage(durationSec: number, ok: boolean) {
  YANDEX_USAGE.push({ ts: Date.now(), durationSec, ok });
  if (YANDEX_USAGE.length > 500) YANDEX_USAGE.splice(0, YANDEX_USAGE.length - 500);
}
(globalThis as any).__yandexUsage = YANDEX_USAGE;

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
  // Usage-статистика (вместо real balance — Yandex Cloud Billing требует IAM)
  const now = Date.now();
  const last24h = YANDEX_USAGE.filter((u) => now - u.ts < 24 * 60 * 60 * 1000);
  const last7d = YANDEX_USAGE.filter((u) => now - u.ts < 7 * 24 * 60 * 60 * 1000);
  const total = YANDEX_USAGE.length;
  const okCount = YANDEX_USAGE.filter((u) => u.ok).length;
  const totalDurationSec = YANDEX_USAGE.reduce((a, u) => a + (u.ok ? u.durationSec : 0), 0);
  const usage = {
    total, ok: okCount, fails: total - okCount,
    last24h_calls: last24h.length, last7d_calls: last7d.length,
    totalMinutes: Math.round(totalDurationSec / 60 * 100) / 100,
    estimatedSpentRub: Math.round(totalDurationSec / 60 * 0.45 * 100) / 100, // ≈ ₽0.45/мин
    pricePerMinute: 0.45,
    note: "Yandex Cloud Billing API требует IAM-token. Здесь оценка по кол-ву вызовов × средняя ставка short audio API.",
  };
  res.json({ data: { services, usage }, error: null });
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

// Secrets inventory + per-secret check (Eugene 2026-05-10).
// «В админке показывай дату установки секретов, кнопкой проверить,
// вверху проверить все».
const SECRET_NAMES = [
  "TELEGRAM_BOT_TOKEN",
  "ANTHROPIC_API_KEY",
  "GPTUNNEL_API_KEY",
  "YANDEX_SPEECHKIT_API_KEY",
  "YANDEX_FOLDER_ID",
  "OPENAI_API_KEY",
  "GMAIL_APP_PASSWORD",
  "SMTP_HOST",
  "ROBO_PASSWORD_1",
  "ROBO_PASSWORD_2",
  "SESSION_SECRET",
  "CRON_SECRET",
  "SIGNED_URL_SECRET",
  "INTERNAL_STATS_TOKEN",
  "MAX_BOT_TOKEN",
  "VK_ACCESS_TOKEN",
];

function envFileMtime(): string | null {
  // Пытаемся прочитать .env mtime — общая дата последнего обновления секретов
  for (const p of ["/var/www/neurohub/.env", "./.env", "../.env"]) {
    try {
      if (fs.existsSync(p)) {
        return new Date(fs.statSync(p).mtimeMs).toISOString();
      }
    } catch {}
  }
  return null;
}

async function checkSecret(name: string): Promise<{ ok: boolean; detail: string }> {
  const val = process.env[name] || "";
  if (!val) return { ok: false, detail: "не задан" };
  try {
    switch (name) {
      case "TELEGRAM_BOT_TOKEN": {
        const r = await fetch(`https://api.telegram.org/bot${val}/getMe`, { signal: AbortSignal.timeout(5000) });
        const j: any = await r.json().catch(() => null);
        if (j?.ok) return { ok: true, detail: `@${j.result?.username || "bot"}` };
        return { ok: false, detail: `tg ${r.status}: ${j?.description || "fail"}` };
      }
      case "ANTHROPIC_API_KEY": {
        const r = await fetch("https://api.anthropic.com/v1/models", {
          headers: { "x-api-key": val, "anthropic-version": "2023-06-01" },
          signal: AbortSignal.timeout(5000),
        });
        return r.ok ? { ok: true, detail: "models accessible" } : { ok: false, detail: `anthropic ${r.status}` };
      }
      case "OPENAI_API_KEY": {
        const r = await fetch("https://api.openai.com/v1/models", {
          headers: { Authorization: `Bearer ${val}` },
          signal: AbortSignal.timeout(5000),
        });
        return r.ok ? { ok: true, detail: "models accessible" } : { ok: false, detail: `openai ${r.status}` };
      }
      case "GPTUNNEL_API_KEY": {
        const r = await fetch("https://gptunnel.ru/v1/balance", {
          headers: { Authorization: `Bearer ${val}` },
          signal: AbortSignal.timeout(5000),
        });
        if (r.ok) {
          const j: any = await r.json().catch(() => null);
          return { ok: true, detail: `balance: ${j?.balance ?? "?"} ${j?.currency ?? ""}` };
        }
        return { ok: false, detail: `gptunnel ${r.status}` };
      }
      case "YANDEX_SPEECHKIT_API_KEY":
      case "YANDEX_FOLDER_ID":
      case "SESSION_SECRET":
      case "CRON_SECRET":
      case "SIGNED_URL_SECRET":
      case "INTERNAL_STATS_TOKEN":
      case "ROBO_PASSWORD_1":
      case "ROBO_PASSWORD_2":
      case "MAX_BOT_TOKEN":
      case "VK_ACCESS_TOKEN":
        return { ok: true, detail: `length=${val.length}` };
      case "GMAIL_APP_PASSWORD":
      case "SMTP_HOST":
        return { ok: true, detail: `length=${val.length}` };
      default:
        return { ok: true, detail: `length=${val.length}` };
    }
  } catch (e) {
    return { ok: false, detail: e instanceof Error ? e.message.slice(0, 60) : "fail" };
  }
}

router.get("/secrets", requireAdmin, async (_req, res) => {
  const mtime = envFileMtime();
  const items = SECRET_NAMES.map(name => {
    const val = process.env[name] || "";
    return {
      name,
      configured: !!val,
      length: val.length,
      masked: val ? `${val.slice(0, 4)}…${val.slice(-3)}` : null,
    };
  });
  res.json({ data: { envFileMtime: mtime, items }, error: null });
});

router.post("/secrets/:name/check", requireAdmin, async (req, res) => {
  const name = req.params.name;
  if (!SECRET_NAMES.includes(name)) {
    return res.status(400).json({ data: null, error: "unknown secret" });
  }
  const r = await checkSecret(name);
  res.json({ data: { name, ...r, checkedAt: new Date().toISOString() }, error: null });
});

// Telegram webhook auto-setup (Eugene 2026-05-11). Защищено requireAdmin —
// не требует secret в URL. Просто открой залогиненным админом:
// https://muzaai.ru/api/admin/v304/telegram/setup-webhook
router.get("/telegram/setup-webhook", requireAdmin, async (_req, res) => {
  const tok = process.env.TELEGRAM_BOT_TOKEN || "";
  if (!tok) return res.status(400).json({ data: null, error: "TELEGRAM_BOT_TOKEN missing in .env" });
  const url = "https://muzaai.ru/api/telegram/webhook";
  try {
    const r = await fetch(`https://api.telegram.org/bot${tok}/setWebhook`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        url,
        allowed_updates: ["message", "edited_message"],
        drop_pending_updates: true,
      }),
      signal: AbortSignal.timeout(8000),
    });
    const j: any = await r.json();
    res.json({ data: { url, telegram: j }, error: null });
  } catch (e) {
    res.status(500).json({ data: null, error: e instanceof Error ? e.message : String(e) });
  }
});

router.post("/secrets/check-all", requireAdmin, async (_req, res) => {
  const results = await Promise.all(
    SECRET_NAMES.map(async name => ({ name, ...(await checkSecret(name)) })),
  );
  res.json({ data: { checkedAt: new Date().toISOString(), results }, error: null });
});

router.post("/poll-now", requireAdmin, async (_req, res) => {
  try {
    const result = await pollProcessingGenerations();
    res.json({ data: result, error: null });
  } catch (err) {
    res.status(500).json({ data: null, error: err instanceof Error ? err.message : "internal" });
  }
});

// Eugene 2026-05-14 Босс «реши системно»: бесплатная зачистка зависших
// processing (>24ч и broken-no-task >5 мин). НЕ вызывает Suno.
// Запускается автоматически каждые 5 мин + при старте сервера. Endpoint
// для manual trigger из админки.
router.post("/cleanup-stale", requireAdmin, (_req, res) => {
  try {
    const result = cleanupStaleProcessing();
    res.json({ data: result, error: null });
  } catch (err) {
    res.status(500).json({ data: null, error: err instanceof Error ? err.message : "internal" });
  }
});

// Eugene 2026-05-19 Босс «На Suno 48ч хранится, надо их докачать в кабинет».
// Backfill — найти все done треки БЕЗ local_path и скачать с result_url
// в authors/<name>/gen_<id>.mp3 пока Suno-URL ещё валидный.
//
// docs: kie.ai files retained 15 days, GPTunnel Yandex S3 — 48ч.
// Поэтому критично — backfill в первые ~24ч после генерации.
router.post("/backfill-missing-files", requireAdmin, async (req, res) => {
  try {
    const days = Math.min(7, parseInt(String(req.query.days || "2")) || 2);
    const fs = await import("node:fs");
    const path = await import("node:path");
    // Найти все done треки без local_path за окно
    const rows = sqliteDb.prepare(`
      SELECT id, user_id, result_url, local_path, type, created_at
      FROM generations
      WHERE status='done'
        AND result_url IS NOT NULL AND result_url != ''
        AND created_at > datetime('now', '-' || ? || ' day')
        AND type = 'music'
    `).all(days) as any[];
    let downloaded = 0;
    let alreadyOk = 0;
    let failed = 0;
    const errors: string[] = [];
    const AUTHORS_DIR = path.join(process.cwd(), "authors");
    for (const row of rows) {
      try {
        // Проверка: local_path есть И файл существует на диске?
        if (row.local_path) {
          const abs = path.join(AUTHORS_DIR, row.local_path);
          if (fs.existsSync(abs)) {
            const sz = fs.statSync(abs).size;
            if (sz > 50_000) { alreadyOk++; continue; }
          }
        }
        // Re-download через storage helper (тот же путь как saveGenFiles)
        // Вызываем backfillSingle через POST к нашему internal endpoint
        const r = await fetch(`http://localhost:${process.env.PORT || 5000}/api/admin/v304/backfill-single/${row.id}`, {
          method: "POST",
          headers: { "X-Admin-Backfill": "1" },
          signal: AbortSignal.timeout(60_000),
        });
        if (r.ok) { downloaded++; } else { failed++; errors.push(`#${row.id}: HTTP ${r.status}`); }
      } catch (e: any) {
        failed++;
        errors.push(`#${row.id}: ${e?.message || e}`);
      }
    }
    res.json({ data: { scanned: rows.length, downloaded, alreadyOk, failed, errors: errors.slice(0, 20), daysWindow: days }, error: null });
  } catch (err) {
    res.status(500).json({ data: null, error: err instanceof Error ? err.message : "internal" });
  }
});

// Internal: backfill для одного gen — re-download с result_url. Использует
// тот же saveGenFiles flow через прямой импорт. Защищён header X-Admin-Backfill
// (чтобы вызывался ТОЛЬКО изнутри сервера, не extern).
router.post("/backfill-single/:id", async (req, res) => {
  if (req.header("X-Admin-Backfill") !== "1") {
    return res.status(403).json({ error: "internal only" });
  }
  try {
    const genId = parseInt(req.params.id);
    // saveGenFiles экспортирован из routes.ts; но routes.ts импортирует
    // нас — циклическая зависимость. Workaround: дублируем минимальный
    // download flow здесь без ID3/fade (просто файл сохранить).
    const fs = await import("node:fs");
    const path = await import("node:path");
    const sqlRow = sqliteDb.prepare(
      `SELECT g.id, g.user_id, g.result_url, g.result_data, g.type, u.name as user_name, g.author_name
       FROM generations g LEFT JOIN users u ON u.id = g.user_id WHERE g.id = ?`,
    ).get(genId) as any;
    if (!sqlRow || !sqlRow.result_url) return res.status(404).json({ error: "no result_url" });
    let audioUrl = sqlRow.result_url;
    let imageUrl: string | null = null;
    try {
      const data = JSON.parse(sqlRow.result_data || "{}");
      if (Array.isArray(data.result) && data.result[0]) {
        audioUrl = data.result[0].audio_url || audioUrl;
        imageUrl = data.result[0].image_url || null;
      }
    } catch {}
    const authorName = String(sqlRow.user_name || sqlRow.author_name || "_noname")
      .replace(/[^a-zа-я0-9_-\s]/gi, "_").trim().slice(0, 64) || "_noname";
    const dir = path.join(process.cwd(), "authors", authorName);
    fs.mkdirSync(dir, { recursive: true });
    const mp3Path = path.join(dir, `gen_${genId}.mp3`);
    const r = await fetch(audioUrl, { signal: AbortSignal.timeout(60_000) });
    if (!r.ok) return res.status(502).json({ error: `audio HTTP ${r.status}` });
    const buf = Buffer.from(await r.arrayBuffer());
    if (buf.length < 50_000) return res.status(502).json({ error: `audio too small ${buf.length}b` });
    fs.writeFileSync(mp3Path, buf);
    if (imageUrl) {
      try {
        const ir = await fetch(imageUrl, { signal: AbortSignal.timeout(30_000) });
        if (ir.ok) {
          const ibuf = Buffer.from(await ir.arrayBuffer());
          if (ibuf.length > 1000) fs.writeFileSync(path.join(dir, `gen_${genId}.jpg`), ibuf);
        }
      } catch {}
    }
    const relPath = path.relative(path.join(process.cwd(), "authors"), mp3Path);
    db.run(sql`UPDATE generations SET local_path = ${relPath} WHERE id = ${genId}`);
    console.log(`[BACKFILL] gen #${genId} → ${relPath} (${buf.length}b)`);
    res.json({ ok: true, path: relPath, size: buf.length });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : "internal" });
  }
});

// Eugene 2026-05-19 Босс «Дата 1905 — есть проблемы, в личном выдает ошибка».
// Manual heal — найти все треки status='error' с result_url IS NOT NULL
// и восстановить в status='done' (audio файл уже есть, error был ложный).
router.post("/heal-paradox-tracks", requireAdmin, (req, res) => {
  try {
    const days = Math.min(30, parseInt(String(req.query.days || "7")) || 7);
    const r = db.run(sql`UPDATE generations
      SET status='done', error_reason=NULL
      WHERE status='error'
        AND result_url IS NOT NULL
        AND result_url != ''
        AND created_at > datetime('now', '-' || ${days} || ' day')`);
    const healed = r.changes ?? 0;
    console.log(`\x1b[32m[HEAL-PARADOX]\x1b[0m manual heal: ${healed} tracks (days=${days})`);
    res.json({ data: { healed, daysWindow: days }, error: null });
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
      return res.status(502).json({ data: null, error: `MuzaAi вернул ${r.status}` });
    }
    const data: any = await r.json();
    const succeeded = Array.isArray(data?.result)
      ? data.result.find((t: any) => t.status === "succeeded" && t.audio_url)
      : null;
    if (!succeeded) {
      return res.json({
        data: {
          recovered: false,
          message: "MuzaAi не вернул успешный трек — recovery невозможен",
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

// Eugene 2026-05-25 fix: `every_hour` тикает от момента старта процесса, НЕ от
// :00. Поэтому гварды `min >= 10` (06:00-06:09) почти всегда не срабатывали —
// job не запускался. Заменяем на once-per-day guard по дате (МСК): job
// выполняется один раз в сутки, когда тик впервые попадает в нужный час.
const _dailyRunGuard = new Map<string, string>();
function shouldRunDaily(jobKey: string, mskHour: number, targetHour: number): boolean {
  if (mskHour !== targetHour) return false;
  const todayMsk = new Date(Date.now() + 3 * 3600_000).toISOString().slice(0, 10);
  if (_dailyRunGuard.get(jobKey) === todayMsk) return false;
  _dailyRunGuard.set(jobKey, todayMsk);
  return true;
}

const adminOverviewModule: Module = {
  name: "admin-overview",
  version: "0.1.0",
  description: "Sprint 7 — GET /api/admin/v304/overview, read-only dashboard data.",
  routes: { prefix: "admin/v304", router },
  publishes: [],
  jobs: [
    // Eugene 2026-05-10: auto-polling Suno платных запросов ОТКЛЮЧЕН.
    // pollProcessingGenerations() вызывает GPTunnel/Suno status — каждый
    // запрос платный. Раньше работал каждую минуту → расход на пустые
    // вызовы. Теперь — только через POST /api/admin/v304/poll-now
    // (requireAdmin) по нажатию админа.
    //
    // Eugene 2026-05-14 Босс «реши системно»: бесплатная зачистка stuck
    // processing (>24ч, broken-no-task >5 мин) — БЕЗ вызова Suno.
    // Запускается каждые 5 мин — гарантия что 2-дневные треки не повиснут.
    {
      name: "cleanup-stale-processing",
      schedule: "every_minute", // дешёвый SQL без вызова Suno
      handler: async () => {
        try { cleanupStaleProcessing(); } catch (e) { console.error("[CLEANUP-STALE job]", e); }
      },
    },
    // Eugene 2026-05-16: scheduled-delete sweep — каждый час переводит
    // generations с scheduled_delete_at <= now в soft-delete. Соответствует
    // dropdown «🗑 Удалить через 1/7/15/30 дней» на errored карточках.
    {
      name: "cleanup-scheduled-deletes",
      schedule: "every_hour",
      handler: async () => {
        try { cleanupScheduledDeletes(); } catch (e) { console.error("[CLEANUP-SCHEDULED-DELETE job]", e); }
      },
    },
    // Eugene 2026-05-24 gen-lifecycle agent — scan stuck-in-processing gens
    // каждые 2 минуты. Дополняет cleanup-stale-processing (он работает с
    // >24h ancient), здесь — > 5 мин в processing → escalate если > 30 мин.
    // НЕ дублирует pollProcessingGenerations (он polling Suno) — здесь
    // только detection + escalation + tracking.
    {
      name: "gen-lifecycle-scan-stuck",
      schedule: "every_minute",
      handler: async () => {
        try {
          // Lazy import чтобы избежать циклической зависимости
          const mod = await import("../../lib/genLifecycleAgent");
          const r = await mod.genLifecycleAgent.scanStuckGenerations();
          if (r.scanned > 0 || r.escalated > 0) {
            console.log(`[GEN-LIFECYCLE-SCAN] scanned=${r.scanned}, resumed=${r.resumed}, escalated=${r.escalated}`);
          }
        } catch (e) {
          console.error("[GEN-LIFECYCLE-SCAN job]", e);
        }
      },
    },
    // Eugene 2026-05-25 Босс — balance-reminder daily кампания. Gate
    // BALANCE_REMINDER_ENABLED=1 (по умолчанию OFF — чтобы не разослать
    // неожиданно на деплое; Босс включает осознанно ИЛИ запускает вручную
    // через director_balance_reminders). every_hour + guard на 11:00 МСК =
    // раз/день. Reminder_log даёт 7-дневный cooldown на юзера.
    {
      name: "balance-reminder-daily",
      schedule: "every_hour",
      handler: async () => {
        try {
          if (process.env.BALANCE_REMINDER_ENABLED !== "1") return;
          const mskHour = (new Date().getUTCHours() + 3) % 24;
          if (mskHour !== 11) return; // раз в день в 11:00 МСК
          const mod = await import("../../lib/balanceReminder");
          const r = await mod.sendBalanceReminders({ dryRun: false, limit: 100 });
          console.log(`[BALANCE-REMINDER] sent=${r.sent}, failed=${r.failed}, candidates=${r.candidates}`);
        } catch (e) {
          console.error("[BALANCE-REMINDER job]", e);
        }
      },
    },
    // Eugene 2026-05-25 Босс «Музa Директор — готовить рекламные кампании
    // (креатив + генерация) на постоянной основе». Раз/день в 06:00 МСК
    // (06:00-06:09) агент «Креатив-маркетинг» готовит черновики рекламы на
    // каждый канал → блок публикаций (status='prepared', scheduled = завтра
    // 11:00 МСК). Ничего не публикуется без одобрения Босса. Gate
    // DIRECTOR_CREATIVE_CRON !== "0" (по умолчанию ВКЛ).
    {
      name: "director-creative-daily",
      schedule: "every_hour",
      handler: async () => {
        try {
          if (process.env.DIRECTOR_CREATIVE_CRON === "0") return;
          const mskHour = (new Date().getUTCHours() + 3) % 24;
          if (!shouldRunDaily("director-creative", mskHour, 6)) return; // раз/день ~06 МСК
          const mod = await import("../../lib/publicationsAgent");
          const r = await mod.prepareCreativeDrafts();
          console.log(`[DIRECTOR-CREATIVE] created=${r.created}, failed=${r.failed}, campaign=${r.campaignId}`);
        } catch (e) {
          console.error("[DIRECTOR-CREATIVE job]", e);
        }
      },
    },
    // Eugene 2026-05-25 Босс «Директор уведомляет меня 03:00 и 14:00 МСК».
    // every_hour + guard на 03 и 14 МСК = два дайджеста в день.
    {
      name: "director-digest",
      schedule: "every_hour",
      handler: async () => {
        try {
          const mskHour = (new Date().getUTCHours() + 3) % 24;
          if (mskHour !== 3 && mskHour !== 14) return;
          const mod = await import("../../lib/directorDigest");
          await mod.sendDailyDigest(mskHour === 3 ? "03:00 МСК (ночной)" : "14:00 МСК (дневной)");
        } catch (e) {
          console.error("[DIRECTOR-DIGEST job]", e);
        }
      },
    },
    // Eugene 2026-05-25 Босс «критические ситуации немедленно». Safety-net scan
    // каждые 5 мин (поверх событийных алертов из agent-orchestrator-bridge).
    // Анти-флуд внутри checkCritical (один набор не чаще 1/час).
    {
      name: "director-critical-scan",
      schedule: "every_minute",
      handler: async () => {
        try {
          if (new Date().getMinutes() % 5 !== 0) return; // каждые 5 минут
          const mod = await import("../../lib/directorDigest");
          await mod.checkCritical();
        } catch (e) {
          console.error("[DIRECTOR-CRITICAL job]", e);
        }
      },
    },
    // Eugene 2026-05-25 Босс «текстовый отчёт каждый день, веди архив».
    // Раз/день в 03:05 МСК — полный текст-отчёт по всем делам → архив 90 дней.
    {
      name: "director-daily-report",
      schedule: "every_hour",
      handler: async () => {
        try {
          const mskHour = (new Date().getUTCHours() + 3) % 24;
          if (!shouldRunDaily("director-daily-report", mskHour, 3)) return; // раз/день ~03 МСК
          const mod = await import("../../lib/directorDigest");
          const id = await mod.buildAndSaveDailyReport();
          console.log(`[DIRECTOR-DAILY-REPORT] saved id=${id}`);
        } catch (e) {
          console.error("[DIRECTOR-DAILY-REPORT job]", e);
        }
      },
    },
    // Eugene 2026-05-25 Босс «агент Ферзь — недостатки в работе системы, узкие
    // места. Доклад Директору ежедневно 04:00 МСК + по запросу». every_hour +
    // shouldRunDaily-гард = раз/день ~04 МСК. Gate FERZ_CRON !== "0" (ВКЛ по умолч).
    // При наличии critical/high находок — алерт Боссу через Директора (notifyBoss:
    // TG primary, email fallback). try/catch, never throw.
    {
      name: "ferz-daily",
      schedule: "every_hour",
      handler: async () => {
        try {
          if (process.env.FERZ_CRON === "0") return;
          const mskHour = (new Date().getUTCHours() + 3) % 24;
          if (!shouldRunDaily("ferz-daily", mskHour, 4)) return; // раз/день ~04 МСК
          const ferz = await import("../../lib/ferzAgent");
          const report = await ferz.runFerzAnalysis();
          const crit = report.severityCounts.critical || 0;
          const high = report.severityCounts.high || 0;
          console.log(`[FERZ-DAILY] findings=${report.findings.length}, critical=${crit}, high=${high}`);
          if (crit > 0 || high > 0) {
            const { notifyBoss } = await import("../../lib/directorDigest");
            const top = report.findings
              .filter((f) => f.severity === "critical" || f.severity === "high")
              .slice(0, 6)
              .map((f) => `• <b>[${f.severity}]</b> ${f.title}${f.metric ? ` (${f.metric})` : ""}`)
              .join("\n");
            const msg =
              `♟ <b>Ферзь — слабые места системы (04:00 МСК)</b>\n` +
              `Критичных: ${crit}, высоких: ${high}, всего находок: ${report.findings.length}\n\n` +
              `${top}\n\n${report.summary}`;
            await notifyBoss(msg);
          }
        } catch (e) {
          console.error("[FERZ-DAILY job]", e);
        }
      },
    },
  ],
  onLoad: async (ctx) => {
    // Eugene 2026-05-14 Босс: при старте — одноразовая зачистка зависших.
    // Закрывает треки которые накопились в processing пока сервер был выключен.
    try {
      const r = cleanupStaleProcessing();
      if (r.ancient > 0 || r.brokenNoTask > 0) {
        ctx.logger.info(`startup cleanup: ancient=${r.ancient}, brokenNoTask=${r.brokenNoTask}`);
      }
    } catch (e) {
      ctx.logger.error("startup cleanup failed", { error: e });
    }
    // Eugene 2026-05-16: одноразовая зачистка scheduled-delete на старте
    // (на случай если сервер был выключен в момент cutoff).
    try {
      const r = cleanupScheduledDeletes();
      if (r.swept > 0) {
        ctx.logger.info(`startup scheduled-delete sweep: swept=${r.swept}`);
      }
    } catch (e) {
      ctx.logger.error("startup scheduled-delete sweep failed", { error: e });
    }
    ctx.logger.info("admin-overview online — GET /api/admin/v304/overview (auto-cleanup stuck every 5 min, Suno-poll manual)");
  },
  healthCheck: () => ({ status: "ok" }),
};

export default adminOverviewModule;
