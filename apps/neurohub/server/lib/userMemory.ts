// Eugene 2026-05-20 Босс «Музa держит контекст общения с юзером».
//
// User-memory-context rule (см. CLAUDE.md).
//
// Архитектура:
//   - 1 строка на userId в `user_memory` (summary + facts + preferences)
//   - Background-сжатие после каждых N=10 сообщений (env MEMORY_COMPRESS_THRESHOLD)
//   - Inject в Музa system prompt при каждом chat-call
//   - Live cabinet snapshot (треки/баланс/премиум) с TTL 5 мин
//
// Anti-patterns которые этот модуль закрывает:
//   - НЕ хранит raw history (для аудита есть chatbot_messages)
//   - НЕ блокирует chat-response на compression (всегда fire-and-forget)
//   - НЕ инжектит memory в анонимный чат
//   - НЕ кладёт секреты в facts (LLM compression-prompt инструктирует фильтровать)

import { db, sqliteDb, storage } from "../storage";
import { recordAuditEntry } from "./adminAuditLog";

// ============================================================================
// TYPES
// ============================================================================

export interface UserMemoryRow {
  userId: number;
  summary: string;
  facts: Record<string, any>;
  preferences: Record<string, any>;
  lastUpdatedAt: number | null;
  messageCountSummarized: number;
  version: number;
  lastCabinetSnapshot: Record<string, any>;
}

export interface CabinetSnapshot {
  userId: number;
  name: string | null;
  email: string | null;
  emailVerified: boolean;
  country: string | null;
  countryCode: string | null;
  phone: string | null;
  phoneVerified: boolean;
  createdAt: string | null;
  // Eugene 2026-05-21 Босс: «в админском кабинете полная информация —
  // регистрация, начало взаимодействия, процессы».
  firstChatMessageAt: string | null;  // когда впервые написал Музе
  lastChatMessageAt: string | null;   // последняя активность в чате
  firstGenerationAt: string | null;   // первая успешная генерация
  totalMessagesToMusa: number;        // total user→Музa сообщений
  generations: {
    total: number;
    last7d: number;
    last24h: number;
    last: {
      id: number;
      title: string | null;
      createdAt: string | null;
      status: string | null;
    } | null;
  };
  balance: {
    paidKopecks: number;
    bonusTracks: number;
  };
  premium: {
    active: boolean;
    tier: string | null;
    expiresAt: string | null;
  };
  lastPayment: {
    amount: number;
    status: string;
    createdAt: string;
  } | null;
}

// ============================================================================
// CACHE
// ============================================================================

// per-userId cabinet snapshot cache (TTL 5 минут).
const CABINET_CACHE_TTL_MS = 5 * 60 * 1000;
const cabinetCache = new Map<number, { data: CabinetSnapshot; expiresAt: number }>();

// per-userId memory cache (in-memory, invalidates on update).
const memoryCache = new Map<number, { data: UserMemoryRow; cachedAt: number }>();
const MEMORY_CACHE_TTL_MS = 5 * 60 * 1000;

// Concurrency guard — не запускать compression параллельно для одного юзера.
const compressionInFlight = new Set<number>();

// ============================================================================
// HELPERS
// ============================================================================

function safeJSON<T>(s: string | null | undefined, fallback: T): T {
  if (!s) return fallback;
  try { return JSON.parse(s) as T; } catch { return fallback; }
}

function escapeForPrompt(s: string): string {
  // Сжимаем потенциальные prompt-injection попытки (просто срезаем длину).
  return String(s || "").slice(0, 4000);
}

function compressThreshold(): number {
  const n = Number(process.env.MEMORY_COMPRESS_THRESHOLD || 10);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 10;
}

function maxCompressionHistory(): number {
  const n = Number(process.env.MEMORY_COMPRESS_HISTORY || 20);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 20;
}

function formatDateForHuman(iso: string | null | undefined): string {
  if (!iso) return "недавно";
  try {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return "недавно";
    const now = Date.now();
    const diffMs = now - d.getTime();
    const days = Math.floor(diffMs / 86_400_000);
    if (days <= 0) return "сегодня";
    if (days === 1) return "вчера";
    if (days < 7) return `${days} дн. назад`;
    if (days < 30) return `${Math.floor(days / 7)} нед. назад`;
    return d.toLocaleDateString("ru-RU", { day: "2-digit", month: "short", year: "numeric" });
  } catch { return "недавно"; }
}

// ============================================================================
// GET / UPSERT MEMORY
// ============================================================================

/**
 * Возвращает текущую memory-строку юзера (или создаёт пустую).
 */
export async function getUserMemory(userId: number): Promise<UserMemoryRow> {
  if (!Number.isFinite(userId) || userId <= 0) {
    return emptyMemoryRow(userId);
  }
  // Кэш
  const cached = memoryCache.get(userId);
  if (cached && Date.now() - cached.cachedAt < MEMORY_CACHE_TTL_MS) {
    return cached.data;
  }
  try {
    const sqlite: any = sqliteDb;
    const row = sqlite.prepare(
      `SELECT user_id, summary, facts_json, preferences_json,
              last_updated_at, message_count_summarized, version,
              last_cabinet_snapshot_json
       FROM user_memory WHERE user_id = ?`,
    ).get(userId) as any;
    if (!row) {
      const empty = emptyMemoryRow(userId);
      memoryCache.set(userId, { data: empty, cachedAt: Date.now() });
      return empty;
    }
    const result: UserMemoryRow = {
      userId,
      summary: row.summary || "",
      facts: safeJSON<Record<string, any>>(row.facts_json, {}),
      preferences: safeJSON<Record<string, any>>(row.preferences_json, {}),
      lastUpdatedAt: row.last_updated_at ? Number(row.last_updated_at) : null,
      messageCountSummarized: Number(row.message_count_summarized || 0),
      version: Number(row.version || 0),
      lastCabinetSnapshot: safeJSON<Record<string, any>>(row.last_cabinet_snapshot_json, {}),
    };
    memoryCache.set(userId, { data: result, cachedAt: Date.now() });
    return result;
  } catch (e: any) {
    console.warn("[userMemory:getUserMemory]", e?.message || e);
    return emptyMemoryRow(userId);
  }
}

function emptyMemoryRow(userId: number): UserMemoryRow {
  return {
    userId,
    summary: "",
    facts: {},
    preferences: {},
    lastUpdatedAt: null,
    messageCountSummarized: 0,
    version: 0,
    lastCabinetSnapshot: {},
  };
}

interface UpsertPatch {
  summary?: string;
  facts?: Record<string, any>;
  preferences?: Record<string, any>;
  messageCountSummarized?: number;
  lastCabinetSnapshot?: Record<string, any>;
}

function upsertUserMemory(userId: number, patch: UpsertPatch, opts?: { incrementVersion?: boolean }): UserMemoryRow {
  const sqlite: any = sqliteDb;
  const existing = sqlite.prepare(`SELECT user_id FROM user_memory WHERE user_id = ?`).get(userId);
  const now = Date.now();
  const incrementVersion = opts?.incrementVersion !== false; // default true
  if (!existing) {
    sqlite.prepare(
      `INSERT INTO user_memory
         (user_id, summary, facts_json, preferences_json,
          last_updated_at, message_count_summarized, version,
          last_cabinet_snapshot_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      userId,
      patch.summary || "",
      JSON.stringify(patch.facts || {}),
      JSON.stringify(patch.preferences || {}),
      now,
      patch.messageCountSummarized || 0,
      incrementVersion ? 1 : 0,
      JSON.stringify(patch.lastCabinetSnapshot || {}),
    );
  } else {
    const sets: string[] = [];
    const args: any[] = [];
    if (patch.summary !== undefined) { sets.push("summary = ?"); args.push(patch.summary); }
    if (patch.facts !== undefined) { sets.push("facts_json = ?"); args.push(JSON.stringify(patch.facts)); }
    if (patch.preferences !== undefined) { sets.push("preferences_json = ?"); args.push(JSON.stringify(patch.preferences)); }
    if (patch.messageCountSummarized !== undefined) {
      sets.push("message_count_summarized = ?"); args.push(patch.messageCountSummarized);
    }
    if (patch.lastCabinetSnapshot !== undefined) {
      sets.push("last_cabinet_snapshot_json = ?"); args.push(JSON.stringify(patch.lastCabinetSnapshot));
    }
    sets.push("last_updated_at = ?"); args.push(now);
    if (incrementVersion) sets.push("version = version + 1");
    args.push(userId);
    sqlite.prepare(`UPDATE user_memory SET ${sets.join(", ")} WHERE user_id = ?`).run(...args);
  }
  // Invalidate caches
  memoryCache.delete(userId);
  return emptyMemoryRow(userId); // caller should re-read; we return placeholder
}

// ============================================================================
// CABINET SNAPSHOT (live)
// ============================================================================

export async function getCabinetSnapshot(userId: number): Promise<CabinetSnapshot | null> {
  if (!Number.isFinite(userId) || userId <= 0) return null;
  const cached = cabinetCache.get(userId);
  if (cached && Date.now() < cached.expiresAt) return cached.data;
  try {
    const sqlite: any = sqliteDb;
    const user = storage.getUser(userId);
    if (!user) return null;
    // generations counts
    const counts = sqlite.prepare(
      `SELECT
         COUNT(*) AS total,
         SUM(CASE WHEN created_at >= datetime('now','-7 days') THEN 1 ELSE 0 END) AS last7d,
         SUM(CASE WHEN created_at >= datetime('now','-1 day') THEN 1 ELSE 0 END) AS last24h
       FROM generations
       WHERE user_id = ? AND type = 'music' AND deleted_at IS NULL`,
    ).get(userId) as any;
    const lastGen = sqlite.prepare(
      `SELECT id, display_title, prompt, status, created_at
       FROM generations
       WHERE user_id = ? AND type = 'music' AND deleted_at IS NULL
       ORDER BY id DESC LIMIT 1`,
    ).get(userId) as any;
    // premium subscription (active)
    const premium = sqlite.prepare(
      `SELECT tier, expires_at FROM premium_subscriptions
       WHERE user_id = ? AND status = 'active'
         AND (expires_at IS NULL OR expires_at > datetime('now'))
       ORDER BY id DESC LIMIT 1`,
    ).get(userId) as any;
    // last payment
    const lastPay = sqlite.prepare(
      `SELECT amount, status, created_at FROM payments
       WHERE user_id = ? AND status = 'paid'
       ORDER BY id DESC LIMIT 1`,
    ).get(userId) as any;

    // Eugene 2026-05-21 Босс: «начало взаимодействия, процессы». First+last chat messages,
    // first generation, total message count — для админского 360°-view.
    const chatStats = sqlite.prepare(
      `SELECT
         MIN(m.created_at) AS first_at,
         MAX(m.created_at) AS last_at,
         COUNT(*) AS total
       FROM chatbot_messages m
       INNER JOIN chatbot_sessions s ON s.id = m.session_id
       WHERE s.user_id = ? AND m.role = 'user'`,
    ).get(userId) as any;
    const firstGen = sqlite.prepare(
      `SELECT created_at FROM generations
       WHERE user_id = ? AND type = 'music' AND status = 'done' AND deleted_at IS NULL
       ORDER BY id ASC LIMIT 1`,
    ).get(userId) as any;

    const snapshot: CabinetSnapshot = {
      userId,
      name: user.name || null,
      email: (user as any).email || null,
      emailVerified: !!((user as any).emailVerified),
      country: (user as any).country || null,
      countryCode: (user as any).countryCode || null,
      phone: (user as any).phone || null,
      phoneVerified: !!((user as any).phoneVerified),
      createdAt: user.createdAt || null,
      firstChatMessageAt: chatStats?.first_at || null,
      lastChatMessageAt: chatStats?.last_at || null,
      firstGenerationAt: firstGen?.created_at || null,
      totalMessagesToMusa: Number(chatStats?.total || 0),
      generations: {
        total: Number(counts?.total || 0),
        last7d: Number(counts?.last7d || 0),
        last24h: Number(counts?.last24h || 0),
        last: lastGen ? {
          id: Number(lastGen.id),
          title: lastGen.display_title || (lastGen.prompt ? String(lastGen.prompt).slice(0, 80) : null),
          createdAt: lastGen.created_at || null,
          status: lastGen.status || null,
        } : null,
      },
      balance: {
        paidKopecks: Number((user as any).balance || 0),
        bonusTracks: Number((user as any).bonusTracks || 0),
      },
      premium: {
        active: !!premium,
        tier: premium?.tier || null,
        expiresAt: premium?.expires_at || null,
      },
      lastPayment: lastPay ? {
        amount: Number(lastPay.amount || 0),
        status: lastPay.status || "paid",
        createdAt: lastPay.created_at || "",
      } : null,
    };
    cabinetCache.set(userId, { data: snapshot, expiresAt: Date.now() + CABINET_CACHE_TTL_MS });
    return snapshot;
  } catch (e: any) {
    console.warn("[userMemory:getCabinetSnapshot]", e?.message || e);
    return null;
  }
}

export function invalidateCabinetCache(userId: number): void {
  cabinetCache.delete(userId);
}

// ============================================================================
// BUILD MEMORY CONTEXT (for system prompt injection)
// ============================================================================

/**
 * Формирует строку «[USER CONTEXT — MANAGER VIEW]» для inject в system prompt.
 * Возвращает пустую строку для анонимных юзеров / при отсутствии данных —
 * НЕ блокирует chat.
 */
export async function buildMemoryContext(userId: number | null | undefined, _channel: string = "web"): Promise<string> {
  if (!userId || !Number.isFinite(userId) || userId <= 0) return "";
  try {
    const [memory, cabinet] = await Promise.all([
      getUserMemory(userId),
      getCabinetSnapshot(userId),
    ]);
    if (!cabinet) return "";

    const lines: string[] = [];
    lines.push("");
    lines.push("[USER CONTEXT — MANAGER VIEW]");
    const nameLabel = cabinet.name ? cabinet.name : `юзер #${userId}`;
    const countryLabel = cabinet.country ? ` (${cabinet.country})` : "";
    const regDate = formatDateForHuman(cabinet.createdAt);
    lines.push(`Это ${nameLabel}${countryLabel}. Регистрация: ${regDate}.`);

    if (memory.summary && memory.summary.trim()) {
      lines.push(`Что помнишь о нём: ${memory.summary.trim()}`);
    } else {
      lines.push(`Что помнишь о нём: Пока не знакомы близко — это ранний этап общения, узнавай постепенно.`);
    }

    // Facts — компактно
    const factsKeys = Object.keys(memory.facts || {});
    if (factsKeys.length > 0) {
      const factsPairs = factsKeys.slice(0, 12).map(k => {
        const v = memory.facts[k];
        if (v === null || v === undefined) return null;
        if (typeof v === "object") {
          try { return `${k}=${JSON.stringify(v).slice(0, 200)}`; } catch { return null; }
        }
        return `${k}=${String(v).slice(0, 200)}`;
      }).filter(Boolean).join("; ");
      if (factsPairs) lines.push(`Ключевые факты: ${factsPairs}`);
    }

    // Preferences
    const prefKeys = Object.keys(memory.preferences || {});
    if (prefKeys.length > 0) {
      const prefPairs = prefKeys.slice(0, 8).map(k => {
        const v = memory.preferences[k];
        if (v === null || v === undefined) return null;
        if (Array.isArray(v)) return `${k}=[${v.slice(0, 5).join(", ")}]`;
        if (typeof v === "object") {
          try { return `${k}=${JSON.stringify(v).slice(0, 200)}`; } catch { return null; }
        }
        return `${k}=${String(v).slice(0, 200)}`;
      }).filter(Boolean).join("; ");
      if (prefPairs) lines.push(`Предпочтения: ${prefPairs}`);
    }

    // Cabinet activity
    const g = cabinet.generations;
    const activityParts: string[] = [];
    activityParts.push(`треков всего ${g.total}`);
    if (g.last7d > 0) activityParts.push(`за неделю ${g.last7d}`);
    if (g.last24h > 0) activityParts.push(`за сутки ${g.last24h}`);
    if (g.last && g.last.title) {
      activityParts.push(`последний «${g.last.title.slice(0, 60)}» ${formatDateForHuman(g.last.createdAt)}`);
    }
    lines.push(`Активность: ${activityParts.join(", ")}.`);

    // Balance + premium
    const balRub = Math.round((cabinet.balance.paidKopecks || 0) / 100);
    const bonusTr = cabinet.balance.bonusTracks || 0;
    const balParts: string[] = [`баланс ${balRub}₽`];
    if (bonusTr > 0) balParts.push(`${bonusTr} бонусных треков`);
    if (cabinet.premium.active) {
      balParts.push(`премиум: ${cabinet.premium.tier || "active"}${cabinet.premium.expiresAt ? ` до ${formatDateForHuman(cabinet.premium.expiresAt)}` : ""}`);
    } else {
      balParts.push(`премиум: нет`);
    }
    lines.push(balParts.join(", ") + ".");

    lines.push("");
    lines.push("Открой разговор как менеджер который ПОМНИТ этого клиента — не начинай с нуля.");
    lines.push("Если есть незавершённое (например упоминал ДР мамы / юбилей коллеги) — спроси «как там, понравилось?» естественно.");
    lines.push("Не цитируй буквально внутренние факты вроде «у меня в базе записано» — это твоя память, не отчёт.");

    return lines.join("\n");
  } catch (e: any) {
    console.warn("[userMemory:buildMemoryContext]", e?.message || e);
    return "";
  }
}

// ============================================================================
// SCHEDULE COMPRESSION (fire-and-forget)
// ============================================================================

/**
 * Считает сколько новых сообщений накопилось с момента последнего сжатия.
 * Если ≥ threshold — запускает compressUserMemory async (через setImmediate).
 * Никогда не throws.
 */
export async function scheduleCompressionIfNeeded(userId: number | null | undefined): Promise<void> {
  if (!userId || !Number.isFinite(userId) || userId <= 0) return;
  if (compressionInFlight.has(userId)) return;
  try {
    const sqlite: any = sqliteDb;
    const memory = await getUserMemory(userId);
    // last_updated_at = millis (Date.now) — конвертируем в ISO для SQLite-сравнения
    const sinceIso = memory.lastUpdatedAt
      ? new Date(memory.lastUpdatedAt).toISOString().replace("T", " ").slice(0, 19)
      : "1970-01-01 00:00:00";
    const row = sqlite.prepare(
      `SELECT COUNT(*) AS cnt FROM chatbot_messages cm
       JOIN chatbot_sessions cs ON cs.id = cm.session_id
       WHERE cs.user_id = ?
         AND cm.created_at >= ?`,
    ).get(userId, sinceIso) as any;
    const newMessageCount = Number(row?.cnt || 0);
    if (newMessageCount < compressThreshold()) return;
    // Fire-and-forget
    setImmediate(() => {
      compressUserMemory(userId).catch(e => {
        console.warn("[userMemory:scheduleCompression] async fail:", e?.message || e);
      });
    });
  } catch (e: any) {
    console.warn("[userMemory:scheduleCompressionIfNeeded]", e?.message || e);
  }
}

// ============================================================================
// COMPRESS USER MEMORY (LLM call)
// ============================================================================

/**
 * Внутренний LLM-call для сжатия истории. Anthropic key chain. Не throws —
 * если все ключи упали, оставляет старый summary. Записывает audit-log.
 */
export async function compressUserMemory(userId: number): Promise<{ ok: boolean; beforeSummary: string; afterSummary: string; version: number }> {
  if (compressionInFlight.has(userId)) {
    return { ok: false, beforeSummary: "", afterSummary: "", version: 0 };
  }
  compressionInFlight.add(userId);
  try {
    const sqlite: any = sqliteDb;
    const memoryBefore = await getUserMemory(userId);
    // Load last N messages from this user's sessions
    const limit = maxCompressionHistory();
    const rows = sqlite.prepare(
      `SELECT cm.role, cm.text, cm.created_at FROM chatbot_messages cm
       JOIN chatbot_sessions cs ON cs.id = cm.session_id
       WHERE cs.user_id = ? AND cm.text IS NOT NULL AND length(cm.text) > 0
       ORDER BY cm.id DESC LIMIT ?`,
    ).all(userId, limit) as Array<{ role: string; text: string; created_at: string }>;
    const messages = rows.reverse(); // ascending order for LLM
    if (messages.length === 0) {
      return { ok: false, beforeSummary: memoryBefore.summary, afterSummary: memoryBefore.summary, version: memoryBefore.version };
    }

    const keyCandidates = [
      process.env.ANTHROPIC_API_KEY,
      process.env.ANTHROPIC_API_KEY_BACKUP,
      process.env.ANTHROPIC_API_KEY_BOT,
    ].filter((k): k is string => !!k);

    if (keyCandidates.length === 0) {
      console.warn("[userMemory:compress] no Anthropic keys — skip");
      return { ok: false, beforeSummary: memoryBefore.summary, afterSummary: memoryBefore.summary, version: memoryBefore.version };
    }

    const systemPrompt = `Ты — менеджер MuzaAi (платформа для генерации песен по текстам через нейросеть). Твоя задача — сжать историю общения с клиентом в полезную память.

Что сохранить (важно — это станет твоей памятью на будущие разговоры):
- Имя клиента, если упоминалось
- Занятие / профессия / контекст жизни
- Ключевые события: дни рождения, юбилеи, свадьбы — для кого, когда
- Близкие люди о которых клиент говорил (мама, муж, дочь — без имён если не звучало)
- Эмоциональный контекст (радость, тревога, грусть) и причина
- Музыкальные предпочтения: стили, голоса, темы текстов
- Языки общения

Что НЕ сохранять (категорически):
- Пароли, OTP-коды, токены, payment-данные
- Точные адреса, номера телефонов, email
- Разовый small-talk, общие фразы вежливости
- Технические шумы («не работает кнопка» — только если важное событие)

Формат ответа — СТРОГО JSON без markdown-обёрток, без \`\`\`json fences:
{
  "summary": "narrative 1-3 параграфа на русском, описывающие что важно помнить о клиенте",
  "facts": { "name": "...", "occupation": "...", "family": "...", "important_dates": [...], "location": "...", ... },
  "preferences": { "music_styles": [...], "voices": [...], "lyrics_themes": [...], "languages": [...] }
}

Если предыдущий summary уже есть — ОБНОВИ его, не пиши с нуля. Добавляй новое, корректируй устаревшее. Не удаляй старые факты без причины.

Если новых полезных данных нет — верни старый summary без изменений.`;

    const factsBefore = JSON.stringify(memoryBefore.facts || {}).slice(0, 2000);
    const prefsBefore = JSON.stringify(memoryBefore.preferences || {}).slice(0, 2000);
    const summaryBefore = memoryBefore.summary || "(пока пусто)";

    const historyText = messages.map(m => {
      const who = m.role === "user" ? "Клиент" : "Музa";
      return `[${who}] ${escapeForPrompt(m.text)}`;
    }).join("\n\n");

    const userPrompt = `Предыдущая память:
SUMMARY: ${summaryBefore}
FACTS: ${factsBefore}
PREFERENCES: ${prefsBefore}

Новая история (последние ${messages.length} сообщений):
${historyText}

Обнови память. Верни JSON.`;

    const model = process.env.MEMORY_COMPRESS_MODEL || "claude-haiku-4-5-20251001";
    const maxTokens = 1200;

    let llmText: string | null = null;
    let usedKey = "";
    for (const key of keyCandidates) {
      try {
        const r = await fetch("https://api.anthropic.com/v1/messages", {
          method: "POST",
          headers: {
            "x-api-key": key,
            "anthropic-version": "2023-06-01",
            "content-type": "application/json",
          },
          body: JSON.stringify({
            model,
            max_tokens: maxTokens,
            system: systemPrompt,
            messages: [{ role: "user", content: userPrompt }],
          }),
          signal: AbortSignal.timeout(25_000),
        });
        if (!r.ok) {
          const errText = await r.text().catch(() => "");
          console.warn(`[userMemory:compress] key fail ${r.status}: ${errText.slice(0, 200)}`);
          continue;
        }
        const j: any = await r.json();
        const content = j?.content?.[0];
        if (content?.type === "text" && typeof content.text === "string") {
          llmText = content.text;
          usedKey = key.slice(0, 8) + "***";
          break;
        }
      } catch (e: any) {
        console.warn("[userMemory:compress] key error:", e?.message || e);
      }
    }

    if (!llmText) {
      console.warn("[userMemory:compress] all keys failed — keeping old summary");
      return { ok: false, beforeSummary: memoryBefore.summary, afterSummary: memoryBefore.summary, version: memoryBefore.version };
    }

    // Parse JSON
    let parsed: { summary?: string; facts?: any; preferences?: any } = {};
    try {
      // Strip code fences if LLM added them despite instructions
      const cleaned = llmText
        .replace(/^```json\s*/i, "")
        .replace(/^```\s*/i, "")
        .replace(/```\s*$/i, "")
        .trim();
      parsed = JSON.parse(cleaned);
    } catch (e: any) {
      console.warn("[userMemory:compress] JSON parse fail:", e?.message);
      return { ok: false, beforeSummary: memoryBefore.summary, afterSummary: memoryBefore.summary, version: memoryBefore.version };
    }

    const newSummary = typeof parsed.summary === "string" ? parsed.summary.slice(0, 4000) : memoryBefore.summary;
    const newFacts = parsed.facts && typeof parsed.facts === "object" && !Array.isArray(parsed.facts)
      ? sanitizeFacts(parsed.facts)
      : memoryBefore.facts;
    const newPrefs = parsed.preferences && typeof parsed.preferences === "object" && !Array.isArray(parsed.preferences)
      ? parsed.preferences
      : memoryBefore.preferences;

    upsertUserMemory(userId, {
      summary: newSummary,
      facts: newFacts,
      preferences: newPrefs,
      messageCountSummarized: memoryBefore.messageCountSummarized + messages.length,
    });

    const memoryAfter = await getUserMemory(userId);

    // Audit-log
    try {
      recordAuditEntry({
        adminEmail: "auto-compress",
        action: "update",
        entity: "user_memory",
        entityKey: String(userId),
        before: { summary: memoryBefore.summary, facts: memoryBefore.facts, preferences: memoryBefore.preferences, version: memoryBefore.version },
        after: { summary: newSummary, facts: newFacts, preferences: newPrefs, version: memoryAfter.version, usedKey, messagesProcessed: messages.length },
      });
    } catch {}

    console.info(`[user-memory] compressed user_id=${userId} v=${memoryAfter.version} msgs=${messages.length}`);

    return { ok: true, beforeSummary: memoryBefore.summary, afterSummary: newSummary, version: memoryAfter.version };
  } catch (e: any) {
    console.warn("[userMemory:compress] outer error:", e?.message || e);
    return { ok: false, beforeSummary: "", afterSummary: "", version: 0 };
  } finally {
    compressionInFlight.delete(userId);
  }
}

/**
 * Фильтр facts: убираем потенциальные секреты по ключам (даже если LLM
 * ошибочно сохранил).
 */
function sanitizeFacts(facts: Record<string, any>): Record<string, any> {
  const SECRET_KEY_REGEX = /pass(word)?|otp|token|secret|api[_-]?key|credit|card|cvv|pin/i;
  const out: Record<string, any> = {};
  for (const k of Object.keys(facts)) {
    if (SECRET_KEY_REGEX.test(k)) continue;
    const v = facts[k];
    if (typeof v === "string" && v.length > 1000) {
      out[k] = v.slice(0, 1000);
    } else {
      out[k] = v;
    }
  }
  return out;
}

// ============================================================================
// USER FORGET
// ============================================================================

export function forgetUserMemory(userId: number, opts?: { adminEmail?: string; adminUserId?: number | null }): boolean {
  if (!Number.isFinite(userId) || userId <= 0) return false;
  try {
    const sqlite: any = sqliteDb;
    const memoryBefore = sqlite.prepare(
      `SELECT user_id, summary, facts_json, preferences_json, version
       FROM user_memory WHERE user_id = ?`,
    ).get(userId) as any;
    const r = sqlite.prepare(`DELETE FROM user_memory WHERE user_id = ?`).run(userId);
    memoryCache.delete(userId);
    try {
      recordAuditEntry({
        adminEmail: opts?.adminEmail || "user-self-forget",
        adminUserId: opts?.adminUserId ?? null,
        action: "delete",
        entity: "user_memory",
        entityKey: String(userId),
        before: memoryBefore ? {
          summary: memoryBefore.summary,
          facts: safeJSON(memoryBefore.facts_json, {}),
          preferences: safeJSON(memoryBefore.preferences_json, {}),
          version: memoryBefore.version,
        } : null,
        after: null,
      });
    } catch {}
    return r.changes > 0;
  } catch (e: any) {
    console.warn("[userMemory:forget]", e?.message || e);
    return false;
  }
}

// ============================================================================
// ADMIN MANUAL EDIT
// ============================================================================

export interface AdminMemoryPatch {
  summary?: string;
  facts?: Record<string, any>;
  preferences?: Record<string, any>;
}

export async function updateUserMemoryAdmin(
  userId: number,
  patch: AdminMemoryPatch,
  opts?: { adminEmail?: string; adminUserId?: number | null },
): Promise<UserMemoryRow | null> {
  if (!Number.isFinite(userId) || userId <= 0) return null;
  try {
    const memoryBefore = await getUserMemory(userId);
    const cleanPatch: UpsertPatch = {};
    if (patch.summary !== undefined) {
      cleanPatch.summary = String(patch.summary).slice(0, 4000);
    }
    if (patch.facts !== undefined && typeof patch.facts === "object" && patch.facts !== null) {
      cleanPatch.facts = sanitizeFacts(patch.facts);
    }
    if (patch.preferences !== undefined && typeof patch.preferences === "object" && patch.preferences !== null) {
      cleanPatch.preferences = patch.preferences;
    }
    if (Object.keys(cleanPatch).length === 0) return memoryBefore;
    upsertUserMemory(userId, cleanPatch);
    const memoryAfter = await getUserMemory(userId);
    try {
      recordAuditEntry({
        adminEmail: opts?.adminEmail || "admin-manual-edit",
        adminUserId: opts?.adminUserId ?? null,
        action: "update",
        entity: "user_memory",
        entityKey: String(userId),
        before: { summary: memoryBefore.summary, facts: memoryBefore.facts, preferences: memoryBefore.preferences, version: memoryBefore.version },
        after: { summary: memoryAfter.summary, facts: memoryAfter.facts, preferences: memoryAfter.preferences, version: memoryAfter.version },
      });
    } catch {}
    return memoryAfter;
  } catch (e: any) {
    console.warn("[userMemory:updateAdmin]", e?.message || e);
    return null;
  }
}

// ============================================================================
// ADMIN LIST
// ============================================================================

export interface AdminMemoryListItem {
  userId: number;
  name: string | null;
  email: string | null;
  summaryPreview: string;
  factsCount: number;
  preferencesCount: number;
  lastUpdated: number | null;
  version: number;
  messageCountSummarized: number;
}

export function listUserMemories(opts: { limit?: number; offset?: number; search?: string } = {}): { users: AdminMemoryListItem[]; total: number } {
  const limit = Math.min(200, Math.max(1, Number(opts.limit) || 50));
  const offset = Math.max(0, Number(opts.offset) || 0);
  const search = (opts.search || "").trim().toLowerCase();
  try {
    const sqlite: any = sqliteDb;
    let where = "";
    const args: any[] = [];
    if (search) {
      where = "WHERE (LOWER(u.name) LIKE ? OR LOWER(u.email) LIKE ?)";
      args.push(`%${search}%`, `%${search}%`);
    }
    const totalRow = sqlite.prepare(
      `SELECT COUNT(*) AS cnt FROM user_memory um
       LEFT JOIN users u ON u.id = um.user_id
       ${where}`,
    ).get(...args) as any;
    const rows = sqlite.prepare(
      `SELECT um.user_id, um.summary, um.facts_json, um.preferences_json,
              um.last_updated_at, um.version, um.message_count_summarized,
              u.name, u.email
       FROM user_memory um
       LEFT JOIN users u ON u.id = um.user_id
       ${where}
       ORDER BY um.last_updated_at DESC NULLS LAST
       LIMIT ? OFFSET ?`,
    ).all(...args, limit, offset) as any[];
    const users: AdminMemoryListItem[] = rows.map(r => {
      const summary = r.summary || "";
      const facts = safeJSON<Record<string, any>>(r.facts_json, {});
      const prefs = safeJSON<Record<string, any>>(r.preferences_json, {});
      return {
        userId: Number(r.user_id),
        name: r.name || null,
        email: r.email || null,
        summaryPreview: summary.slice(0, 200),
        factsCount: Object.keys(facts).length,
        preferencesCount: Object.keys(prefs).length,
        lastUpdated: r.last_updated_at ? Number(r.last_updated_at) : null,
        version: Number(r.version || 0),
        messageCountSummarized: Number(r.message_count_summarized || 0),
      };
    });
    return { users, total: Number(totalRow?.cnt || 0) };
  } catch (e: any) {
    console.warn("[userMemory:listUserMemories]", e?.message || e);
    return { users: [], total: 0 };
  }
}

export function getRecentMessagesForUser(userId: number, limit: number = 20): Array<{ id: number; role: string; text: string; createdAt: string; sessionId: string; channel: string | null }> {
  try {
    const sqlite: any = sqliteDb;
    const rows = sqlite.prepare(
      `SELECT cm.id, cm.role, cm.text, cm.created_at, cm.session_id, cs.channel
       FROM chatbot_messages cm
       LEFT JOIN chatbot_sessions cs ON cs.id = cm.session_id
       WHERE cs.user_id = ?
       ORDER BY cm.id DESC LIMIT ?`,
    ).all(userId, Math.min(100, Math.max(1, limit))) as any[];
    return rows.reverse().map(r => ({
      id: Number(r.id),
      role: r.role || "user",
      text: r.text || "",
      createdAt: r.created_at || "",
      sessionId: r.session_id || "",
      channel: r.channel || null,
    }));
  } catch {
    return [];
  }
}

// db handle reference (для типизации — некоторые модули могут использовать)
export { db };
