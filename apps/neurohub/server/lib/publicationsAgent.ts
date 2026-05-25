// Eugene 2026-05-25 Босс «Музa Директор — готовить рекламные кампании (креатив +
// генерация) на постоянной основе + блок публикаций по датам со статусом
// подготовлено → одобрено → опубликовано / снято с публикации».
//
// Агент «Креатив-маркетинг» (id "marketing-creative") — подчинён Директору
// (Director-subordination rule). Готовит черновики креатива на каждый канал,
// складывает в таблицу `publications` со статусом 'prepared'. Реальная отправка
// — ТОЛЬКО после явного одобрения Боссом ('approved') и только на подключённый
// канал. Ничего не публикуется автоматически.
//
// === Реальный стек ===
// Express + SQLite data.db (НЕ внешние очереди / брокеры). Self-migrating
// CREATE TABLE IF NOT EXISTS (как ensurePostmanTables / denga_manual_costs).
//
// === Reuse-working-solutions ===
//  - callUnifiedMuzaLLM (lib/llmCore) — генерация креатива.
//  - recordAgentActivity (lib/agentOrchestrator) — Креатив подчинён Директору.
//  - recordAuditEntry (lib/adminAuditLog) — approve/publish/unpublish в audit-log.
//
// === No-AI-providers-in-userland rule ===
// Креатив — user-facing (рекламный текст). НИКОГДА не называет ИИ-провайдеров.
// Бренд — «MuzaAi» / «Муза». Промпт жёстко это требует.

import { db } from "../storage";
import { callUnifiedMuzaLLM } from "./llmCore";
import { recordAgentActivity } from "./agentOrchestrator";

export const PUBLICATION_CHANNELS = ["web", "telegram", "max", "vk", "email"] as const;
export type PublicationChannel = (typeof PUBLICATION_CHANNELS)[number];

export const PUBLICATION_STATUSES = ["prepared", "approved", "published", "unpublished"] as const;
export type PublicationStatus = (typeof PUBLICATION_STATUSES)[number];

export interface PublicationRow {
  id: number;
  campaign_id: string | null;
  channel: string;
  title: string;
  content: string;
  scheduled_at: number | null;
  status: string;
  created_at: number | null;
  approved_at: number | null;
  published_at: number | null;
  notes: string | null;
}

function sqlite(): any {
  return (db as any).$client;
}

// === Auto-migrate (self-migrating, как ensurePostmanTables) ===

let migrated = false;
export function ensurePublicationsTable(): void {
  if (migrated) return;
  try {
    sqlite().exec(`
      CREATE TABLE IF NOT EXISTS publications (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        campaign_id TEXT,
        channel TEXT NOT NULL,
        title TEXT NOT NULL,
        content TEXT NOT NULL,
        scheduled_at INTEGER,
        status TEXT NOT NULL DEFAULT 'prepared',
        created_at INTEGER,
        approved_at INTEGER,
        published_at INTEGER,
        notes TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_publications_status_sched ON publications(status, scheduled_at);
    `);
    migrated = true;
  } catch (e) {
    console.warn("[publications] migration failed:", e);
  }
}

// === Channel token map (для publish — реально ли можно отправить) ===
// NB: реальный send в этой задаче НЕ реализуется — только проверка наличия токена.

export function channelHasToken(channel: string): boolean {
  switch (channel) {
    case "web":
      return true; // лендинг/CMS — внутренний канал, токен не нужен
    case "telegram":
      return !!process.env.TELEGRAM_BOT_TOKEN;
    case "max":
      return !!process.env.MAX_BOT_TOKEN;
    case "vk":
      return !!process.env.VK_ACCESS_TOKEN;
    case "email":
      return !!(process.env.SMTP_PASS || process.env.GMAIL_APP_PASSWORD);
    default:
      return false;
  }
}

// === Time helper: следующий день 11:00 МСК (millis) ===

export function nextDay11MskMillis(): number {
  // 11:00 МСК = 08:00 UTC. Берём «сегодня 08:00 UTC», если уже прошло — +1 день.
  const now = new Date();
  const target = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 8, 0, 0, 0));
  if (target.getTime() <= now.getTime()) {
    target.setUTCDate(target.getUTCDate() + 1);
  }
  // Всегда «завтра 11:00 МСК» для подготовленных черновиков — Боссу время одобрить.
  target.setUTCDate(target.getUTCDate() + 1);
  return target.getTime();
}

// === CRUD ===

export function listPublications(opts: {
  status?: string;
  fromMs?: number | null;
  toMs?: number | null;
  limit?: number;
}): PublicationRow[] {
  ensurePublicationsTable();
  const where: string[] = [];
  const args: any[] = [];
  if (opts.status && PUBLICATION_STATUSES.includes(opts.status as PublicationStatus)) {
    where.push("status = ?");
    args.push(opts.status);
  }
  if (typeof opts.fromMs === "number") {
    where.push("(scheduled_at IS NOT NULL AND scheduled_at >= ?)");
    args.push(opts.fromMs);
  }
  if (typeof opts.toMs === "number") {
    where.push("(scheduled_at IS NOT NULL AND scheduled_at < ?)");
    args.push(opts.toMs);
  }
  const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";
  const limit = Math.max(1, Math.min(1000, opts.limit ?? 500));
  try {
    return sqlite()
      .prepare(
        `SELECT * FROM publications ${whereSql}
         ORDER BY COALESCE(scheduled_at, created_at) ASC, id ASC
         LIMIT ?`,
      )
      .all(...args, limit) as PublicationRow[];
  } catch (e) {
    console.warn("[publications] list failed:", e);
    return [];
  }
}

export function getPublication(id: number): PublicationRow | null {
  ensurePublicationsTable();
  try {
    return (sqlite().prepare(`SELECT * FROM publications WHERE id = ?`).get(id) as PublicationRow) || null;
  } catch {
    return null;
  }
}

export function createPublication(opts: {
  channel: PublicationChannel;
  title: string;
  content: string;
  scheduledAt?: number | null;
  campaignId?: string | null;
  notes?: string | null;
}): PublicationRow | null {
  ensurePublicationsTable();
  try {
    const now = Date.now();
    const r = sqlite()
      .prepare(
        `INSERT INTO publications (campaign_id, channel, title, content, scheduled_at, status, created_at, notes)
         VALUES (?, ?, ?, ?, ?, 'prepared', ?, ?)`,
      )
      .run(
        opts.campaignId ?? null,
        opts.channel,
        opts.title,
        opts.content,
        opts.scheduledAt ?? null,
        now,
        opts.notes ?? null,
      );
    return getPublication(Number(r?.lastInsertRowid || 0));
  } catch (e) {
    console.warn("[publications] create failed:", e);
    return null;
  }
}

export function approvePublication(id: number): PublicationRow | null {
  ensurePublicationsTable();
  try {
    sqlite().prepare(`UPDATE publications SET status='approved', approved_at=? WHERE id=?`).run(Date.now(), id);
    return getPublication(id);
  } catch (e) {
    console.warn("[publications] approve failed:", e);
    return null;
  }
}

export function markPublished(id: number): PublicationRow | null {
  ensurePublicationsTable();
  try {
    sqlite().prepare(`UPDATE publications SET status='published', published_at=? WHERE id=?`).run(Date.now(), id);
    return getPublication(id);
  } catch (e) {
    console.warn("[publications] publish failed:", e);
    return null;
  }
}

export function unpublishPublication(id: number): PublicationRow | null {
  ensurePublicationsTable();
  try {
    sqlite().prepare(`UPDATE publications SET status='unpublished' WHERE id=?`).run(id);
    return getPublication(id);
  } catch (e) {
    console.warn("[publications] unpublish failed:", e);
    return null;
  }
}

export function countPublications(): number {
  ensurePublicationsTable();
  try {
    const r = sqlite().prepare(`SELECT COUNT(*) AS c FROM publications`).get() as { c: number };
    return Number(r?.c || 0);
  } catch {
    return 0;
  }
}

// === Креатив (LLM-generation) ===

const CHANNEL_BRIEF: Record<PublicationChannel, string> = {
  web: "Лендинг muzaai.ru. Короткий заголовок + 1-2 предложения. Тёплый, приглашающий тон.",
  telegram: "Telegram-пост. До 200 знаков, можно 1-2 эмодзи, ссылка muzaai.ru в конце.",
  max: "Пост в мессенджере Max. До 200 знаков, 1 эмодзи, ссылка muzaai.ru.",
  vk: "Пост ВКонтакте. До 250 знаков, дружелюбно, 1-2 эмодзи, ссылка muzaai.ru.",
};

// Каналы, для которых cron готовит креатив (email — отдельный pipeline Почтальона).
const CREATIVE_CHANNELS: PublicationChannel[] = ["web", "telegram", "max", "vk"];

function buildCreativePrompt(channel: PublicationChannel): string {
  return (
    `Придумай короткий рекламный текст для платформы MuzaAi (создание песен по словам автора).\n` +
    `Канал: ${channel}. ${CHANNEL_BRIEF[channel]}\n\n` +
    `Жёсткие требования:\n` +
    `- Бренд только «MuzaAi» / «Муза». Ты — Муза, девушка, пиши от женского лица.\n` +
    `- НИКОГДА не называй сторонние ИИ-сервисы и модели (всё делает MuzaAi).\n` +
    `- Не упоминай конкретные цены.\n` +
    `- Призыв: рассказать повод — получить готовый трек. Первый трек в подарок.\n\n` +
    `Ответь СТРОГО в формате двух строк:\n` +
    `TITLE: <короткий заголовок>\n` +
    `BODY: <текст поста>`
  );
}

function parseCreative(raw: string, channel: PublicationChannel): { title: string; content: string } {
  const text = String(raw || "").trim();
  let title = "";
  let body = "";
  const titleM = text.match(/TITLE:\s*(.+)/i);
  const bodyM = text.match(/BODY:\s*([\s\S]+)/i);
  if (titleM) title = titleM[1].split(/\r?\n/)[0].trim();
  if (bodyM) body = bodyM[1].trim();
  // Fallback — если LLM не дал маркеров, берём первую строку как заголовок.
  if (!title || !body) {
    const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    if (!title) title = lines[0] || "Музa создаёт песни";
    if (!body) body = lines.slice(1).join(" ") || lines[0] || "Расскажи Музе повод — получишь готовый трек. muzaai.ru";
  }
  // Sanity-cap.
  title = title.slice(0, 200);
  body = body.slice(0, 2000);
  void channel;
  return { title, content: body };
}

/**
 * Готовит черновики креатива на каждый канал и кладёт их в `publications`
 * со статусом 'prepared'. Никогда не throw'ит. Возвращает counts.
 *
 * @param campaignId — id кампании (default — авто из даты).
 */
export async function prepareCreativeDrafts(opts?: {
  campaignId?: string;
  channels?: PublicationChannel[];
}): Promise<{ created: number; failed: number; campaignId: string }> {
  ensurePublicationsTable();
  const campaignId = opts?.campaignId || `auto-${new Date().toISOString().slice(0, 10)}`;
  const channels = opts?.channels || CREATIVE_CHANNELS;
  const scheduledAt = nextDay11MskMillis();
  let created = 0;
  let failed = 0;

  for (const channel of channels) {
    try {
      const reply = await callUnifiedMuzaLLM({
        sessionId: `creative-${channel}-${Date.now()}`,
        userId: null,
        channel: "internal" as any,
        userText: buildCreativePrompt(channel),
        role: "admin", // внутренняя задача Директора, не клиентский чат
        maxTokens: 280,
      });
      if (!reply || !reply.trim()) {
        failed += 1;
        continue;
      }
      const { title, content } = parseCreative(reply, channel);
      const row = createPublication({
        channel,
        title,
        content,
        scheduledAt,
        campaignId,
        notes: "Авто-черновик креатива (Музa Директор → Креатив-маркетинг)",
      });
      if (row) created += 1;
      else failed += 1;
    } catch (e) {
      console.warn(`[publications] creative gen failed (${channel}):`, e);
      failed += 1;
    }
  }

  try {
    recordAgentActivity("marketing-creative", { action: "prepare_drafts", created, failed, campaignId });
  } catch {
    /* never throw */
  }

  return { created, failed, campaignId };
}

// === First-boot seed (one-time) ===
// Если таблица пуста — засеваем первую кампанию (5 черновиков), scheduled = завтра 11:00 МСК.
// No-AI-providers: тексты без имён ИИ-провайдеров.

interface SeedItem {
  channel: PublicationChannel;
  title: string;
  content: string;
}

const SEED_ITEMS: SeedItem[] = [
  {
    channel: "web",
    title: "Муза создаёт песни за минуты",
    content:
      "Напиши пару слов о поводе — я подберу голос, стиль и соберу трек. Первый трек в подарок. Попробуй прямо сейчас.",
  },
  {
    channel: "telegram",
    title: "Песня по твоим словам",
    content: "Привет! Это Муза 🎵 Назови повод — сделаю трек за пару минут. Первый — в подарок 🎁 → muzaai.ru",
  },
  {
    channel: "max",
    title: "Трек за минуты",
    content: "🎵 Муза создаёт песни по твоим словам. Назови повод — получишь готовый трек. Первый в подарок. muzaai.ru",
  },
  {
    channel: "vk",
    title: "Своя песня за минуты",
    content: "🎶 Расскажи Музе повод — она подберёт голос и стиль, соберёт трек. Первый — бесплатно. → muzaai.ru",
  },
  {
    channel: "email",
    title: "Твоя первая песня — в подарок",
    content: "Короткое приветствие Музы + CTA «Создать трек» + кнопка отписки.",
  },
];

let seedChecked = false;
export function seedFirstCampaignIfEmpty(): { seeded: boolean; count: number } {
  if (seedChecked) return { seeded: false, count: 0 };
  seedChecked = true;
  ensurePublicationsTable();
  try {
    if (countPublications() > 0) return { seeded: false, count: 0 };
    const scheduledAt = nextDay11MskMillis();
    const campaignId = `seed-${new Date().toISOString().slice(0, 10)}`;
    let count = 0;
    for (const item of SEED_ITEMS) {
      const row = createPublication({
        channel: item.channel,
        title: item.title,
        content: item.content,
        scheduledAt,
        campaignId,
        notes: "Первая кампания (seed)",
      });
      if (row) count += 1;
    }
    return { seeded: count > 0, count };
  } catch (e) {
    console.warn("[publications] seed failed:", e);
    return { seeded: false, count: 0 };
  }
}
