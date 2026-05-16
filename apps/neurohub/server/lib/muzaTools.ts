// Eugene 2026-05-14 Босс: Advanced AI agent для Музы — Tool Use (function
// calling) через Anthropic API. Муза сама решает когда вызвать tool,
// анализирует ответ, продолжает диалог.
//
// Каждый tool: name + description + input_schema (JSON-schema) + handler.

import { db, storage } from "../storage";
import { users, generations, transactions, songDrafts, agentHandoffs } from "@shared/schema";
import { eq, and, desc, sql, isNotNull } from "drizzle-orm";
import { PUBLIC_URL } from "./publicUrl";
import * as fs from "node:fs";
import * as crypto from "node:crypto";
import { kbPath } from "./consultantPersona";

export type ToolDef = {
  name: string;
  description: string;
  input_schema: {
    type: "object";
    properties: Record<string, any>;
    required?: string[];
  };
};

export type ToolHandler = (input: any, context: { userId: number | null }) => Promise<string>;

const fmt = (n: number) => n.toLocaleString("ru-RU");

// === TOOL DEFINITIONS (passed to Claude) ===

export const MUZA_TOOLS: ToolDef[] = [
  {
    name: "get_user_tracks",
    description: "Получить топ-5 треков текущего юзера по прослушиваниям + сводку. Используй когда юзер спрашивает про свои треки/статистику/прогресс. БЕЗ параметров — берёт userId из контекста сессии. Если userId не известен (юзер не залогинен) — вернёт «не залогинен».",
    input_schema: { type: "object", properties: {}, required: [] },
  },
  {
    name: "get_user_balance",
    description: "Получить баланс юзера в ₽ + бонусные треки. Используй когда юзер спрашивает «сколько у меня денег» / «есть ли бесплатный трек».",
    input_schema: { type: "object", properties: {}, required: [] },
  },
  {
    name: "get_pricing",
    description: "Получить актуальные цены: music (трек), cover (обложка), lyrics (текст). Используй когда юзер спрашивает «сколько стоит».",
    input_schema: { type: "object", properties: {}, required: [] },
  },
  {
    name: "find_similar_tracks",
    description: "Найти похожие опубликованные треки по теме/жанру/настроению. Используй когда юзер просит примеры. query — короткий поиск (3-5 слов).",
    input_schema: {
      type: "object",
      properties: { query: { type: "string", description: "Тема/жанр для поиска" } },
      required: ["query"],
    },
  },
  {
    name: "check_generation_status",
    description: "Проверить статус конкретной генерации юзера. Используй если юзер спрашивает «где мой трек» / «когда будет готов». genId — идентификатор генерации.",
    input_schema: {
      type: "object",
      properties: { genId: { type: "number", description: "ID генерации" } },
      required: ["genId"],
    },
  },
  {
    name: "escalate_to_human",
    description: "Эскалировать вопрос на человека (техподдержка / коммерческий / пресс). Используй ТОЛЬКО если ты не можешь ответить ИЛИ это явно НЕ твоя зона (платежи, баги, юр.вопросы).",
    input_schema: {
      type: "object",
      properties: {
        team: { type: "string", enum: ["support", "commercial", "press"] },
        reason: { type: "string", description: "Краткое описание для админа" },
      },
      required: ["team", "reason"],
    },
  },
  {
    name: "force_close_stuck_generation",
    description: "Если у юзера генерация ЕГО трека висит в processing > 30 мин — force-close её и вернуть баланс. Используй ТОЛЬКО когда юзер жалуется «трек висит / зависла / не работает». Только для треков юзера, проверяется userId. genId — ID конкретной генерации.",
    input_schema: {
      type: "object",
      properties: { genId: { type: "number", description: "ID зависшей генерации" } },
      required: ["genId"],
    },
  },
  {
    name: "get_user_stuck_generations",
    description: "Получить ВСЕ зависшие (processing > 15 мин) генерации текущего юзера. Используй когда юзер не указал конкретный genId, а просто «у меня всё зависло». Без параметров.",
    input_schema: { type: "object", properties: {}, required: [] },
  },
  {
    name: "check_recent_payments",
    description: "Проверить последние 5 платежей юзера + статус. Используй когда юзер жалуется на оплату / списание / двойной заряд.",
    input_schema: { type: "object", properties: {}, required: [] },
  },
  {
    name: "save_song_draft",
    description: "СОХРАНИТЬ черновик песни в кабинет автора (если auth). КЛЮЧЕВОЙ tool — главная миссия Музы: довести до генерации, ЕСЛИ НЕ ПОЛУЧИЛОСЬ — хотя бы сохранить черновик чтобы юзер вернулся. Используй когда: 1) собрал текст/идею в диалоге → сохрани перед предложением /music. 2) юзер собирается уходить — спроси можно ли сохранить. Требуется auth.",
    input_schema: {
      type: "object",
      properties: {
        title: { type: "string", description: "Название черновика, 1-80 chars (повод + кому)" },
        prompt: { type: "string", description: "Краткая идея/тема (для basic mode)" },
        lyrics: { type: "string", description: "Готовый текст песни если есть (опц.)" },
        style: { type: "string", description: "Стиль/жанр (опц.): Поп / Рок / Баллада / Lo-Fi / etc." },
        voice: { type: "string", description: "Голос: female / male / duet / instrumental (опц.)" },
        mood: { type: "string", description: "Настроение: warm / energetic / sad / romantic (опц.)" },
      },
      required: ["title", "prompt"],
    },
  },

  // === Agent upgrade (Eugene 2026-05-16): 7 недостающих tools ===
  {
    name: "get_user_profile",
    description: "Профиль текущего юзера: displayName, email (МАСКИРОВАННЫЙ), tariff, credits, memberSince. Используй когда юзер спрашивает «кто я / что у меня» / надо подытожить его данные. Без параметров — берёт userId из контекста.",
    input_schema: { type: "object", properties: {}, required: [] },
  },
  {
    name: "get_user_tariff",
    description: "Тариф юзера: name, credits, freeTracksLeft. Используй когда юзер спрашивает «какой у меня тариф / сколько подарочных треков / лимиты».",
    input_schema: { type: "object", properties: {}, required: [] },
  },
  {
    name: "search_project_knowledge",
    description: "Поиск по базе знаний проекта (KNOWLEDGE-BASE-BOT.md): цены, режимы, шаблоны, голоса, реферальная программа. Простой substring/keyword match — БЕЗ embeddings. Используй для фактических вопросов «как работает X / есть ли Y».",
    input_schema: {
      type: "object",
      properties: { query: { type: "string", description: "Поисковый запрос (2-6 слов)" } },
      required: ["query"],
    },
  },
  {
    name: "get_track_brief_draft",
    description: "Получить последний черновик (brief) юзера из таблицы song_drafts. Используй чтобы напомнить юзеру «вы начинали — продолжим?» или собрать недостающие поля для генерации.",
    input_schema: { type: "object", properties: {}, required: [] },
  },
  {
    name: "suggest_next_prompt_step",
    description: "Детерминированный helper (БЕЗ LLM): по briefId возвращает {missingFields, nextQuestion}. Проверяет какие поля ещё не заполнены (title/mood/genre/voice/lyrics_theme/structure) и подсказывает что спросить дальше.",
    input_schema: {
      type: "object",
      properties: { briefId: { type: "number", description: "ID черновика (song_drafts.id)" } },
      required: ["briefId"],
    },
  },
  {
    name: "start_track_generation_from_brief",
    description: "Запустить генерацию трека из черновика. Если confirmed=false → возвращает {requiresConfirmation, summary}. Если confirmed=true → создаёт generation через storage.createGeneration. ВСЕГДА сначала вызывай с confirmed=false, покажи summary юзеру, только после явного «да» — confirmed=true.",
    input_schema: {
      type: "object",
      properties: {
        briefId: { type: "number", description: "ID черновика (song_drafts.id)" },
        confirmed: { type: "boolean", description: "true только после явного подтверждения юзера" },
      },
      required: ["briefId", "confirmed"],
    },
  },
  {
    name: "request_human_handoff",
    description: "Эскалация на живого оператора (создаёт запись в agent_handoffs со статусом open). Используй когда: юзер просит человека / низкая уверенность в ответе / конфликт данных / опасное действие (delete). reason ОБЯЗАТЕЛЕН.",
    input_schema: {
      type: "object",
      properties: {
        reason: { type: "string", enum: ["user_request", "low_confidence", "data_conflict", "destructive_action"] },
        comment: { type: "string", description: "Краткое описание ситуации для оператора (опц.)" },
      },
      required: ["reason"],
    },
  },
];

// === HANDLERS (executed when Claude calls tool) ===

const HANDLERS: Record<string, ToolHandler> = {
  async get_user_tracks(_input, { userId }) {
    if (!userId) return "Юзер не залогинен. Предложи зарегистрироваться.";
    try {
      const u = db.select().from(users).where(eq(users.id, userId)).get();
      if (!u) return "Юзер не найден.";
      const gens = db.select().from(generations)
        .where(and(eq(generations.userId, userId), eq(generations.type, "music"), eq(generations.status, "done")))
        .orderBy(desc(generations.id))
        .limit(20)
        .all();
      if (gens.length === 0) return `Имя: ${u.name}. Треков пока нет.`;
      const scored = gens.map((g: any) => {
        let plays = 0;
        try { plays = JSON.parse(g.style || "{}").plays || 0; } catch {}
        return { id: g.id, title: g.displayTitle || (g.prompt || "").slice(0, 50), plays, isPublic: g.isPublic };
      }).sort((a, b) => b.plays - a.plays);
      const top5 = scored.slice(0, 5);
      const total = scored.reduce((s, t) => s + t.plays, 0);
      const lines = top5.map((t, i) => `${["🥇","🥈","🥉","4.","5."][i]} «${t.title}» — ${t.plays} прослушиваний${t.isPublic === 1 ? " (в эфире)" : ""}`);
      return `Имя: ${u.name}. Треков: ${gens.length}, всего прослушиваний: ${total}.\nТоп:\n${lines.join("\n")}`;
    } catch (e: any) {
      return `Ошибка: ${e.message}`;
    }
  },

  async get_user_balance(_input, { userId }) {
    if (!userId) return "Юзер не залогинен.";
    try {
      const u = db.select().from(users).where(eq(users.id, userId)).get();
      if (!u) return "Юзер не найден.";
      const rub = Math.floor((u.balance || 0) / 100);
      const bonus = (u as any).bonusTracks || 0;
      return `Баланс: ${rub} ₽${bonus > 0 ? ` + ${bonus} подарочн. треков (бесплатно)` : ""}.`;
    } catch (e: any) {
      return `Ошибка: ${e.message}`;
    }
  },

  async get_pricing() {
    return "Текущие цены: песня (music) — 299 ₽, обложка (cover) — 99 ₽, текст (lyrics) — 49 ₽. Подарочный трек: первые 1000 авторов из РФ/СНГ — бесплатно.";
  },

  async find_similar_tracks({ query }) {
    try {
      const q = String(query || "").trim().toLowerCase();
      if (!q) return "Пустой запрос.";
      const rows = (db as any).$client.prepare(`
        SELECT id, display_title, author_name, style FROM generations
        WHERE type = 'music' AND status = 'done' AND is_public = 1 AND deleted_at IS NULL
          AND (lower(COALESCE(display_title, '')) LIKE ? OR lower(COALESCE(prompt, '')) LIKE ?
               OR lower(COALESCE(style, '')) LIKE ?)
        ORDER BY id DESC LIMIT 5
      `).all(`%${q}%`, `%${q}%`, `%${q}%`);
      if (rows.length === 0) return `Похожих треков «${query}» не нашлось в эфире.`;
      return `Найдено в эфире:\n${rows.map((r: any) => `• «${r.display_title || "—"}» от ${r.author_name || "—"}`).join("\n")}`;
    } catch (e: any) {
      return `Ошибка: ${e.message}`;
    }
  },

  async check_generation_status({ genId }, { userId }) {
    try {
      const id = Number(genId);
      if (!Number.isFinite(id)) return "Невалидный genId.";
      const gen = db.select().from(generations).where(eq(generations.id, id)).get();
      if (!gen) return `Генерация #${id} не найдена.`;
      if (userId && gen.userId !== userId) return "Доступ только к своим трекам.";
      const status = gen.status;
      const title = gen.displayTitle || (gen.prompt || "").slice(0, 50);
      if (status === "done") return `«${title}» #${id}: ✓ готов.`;
      if (status === "processing") {
        const ageMin = Math.floor((Date.now() - new Date(gen.createdAt || "").getTime()) / 60000);
        return `«${title}» #${id}: в работе (${ageMin} мин). MuzaAi обычно за 5-15 мин.`;
      }
      if (status === "error") return `«${title}» #${id}: ошибка (${gen.errorReason || "—"}). Можно регенерировать, баланс возвращён.`;
      return `«${title}» #${id}: ${status}.`;
    } catch (e: any) {
      return `Ошибка: ${e.message}`;
    }
  },

  async force_close_stuck_generation({ genId }, { userId }) {
    if (!userId) return "Юзер не залогинен — не могу trigger refund.";
    try {
      const id = Number(genId);
      if (!Number.isFinite(id)) return "Невалидный genId.";
      const gen = db.select().from(generations).where(eq(generations.id, id)).get();
      if (!gen) return `Генерация #${id} не найдена.`;
      if (gen.userId !== userId) return "Доступ только к своим трекам.";
      if (gen.status !== "processing") return `«${gen.displayTitle || id}» уже в статусе ${gen.status} — не зависла.`;
      const ageMin = Math.floor((Date.now() - new Date(gen.createdAt || "").getTime()) / 60000);
      if (ageMin < 30) return `«${gen.displayTitle || id}» только ${ageMin} мин в работе — обычно занимает 5-15 мин, иногда до 30. Подожди ещё ${30 - ageMin} мин.`;
      // Force close + refund (если платная)
      db.update(generations).set({
        status: "error",
        errorReason: "Принудительно закрыто Музой по просьбе автора — превышение лимита ожидания. Баланс восстановлен."
      } as any).where(eq(generations.id, id)).run();
      if ((gen.cost || 0) > 0) {
        db.update(users).set({ balance: sql`${users.balance} + ${gen.cost}` }).where(eq(users.id, userId)).run();
        db.insert(transactions).values({
          userId, type: "topup", amount: gen.cost,
          description: `Возврат за зависшую генерацию #${id}`,
        }).run();
      }
      console.log(`[AGENT-CLOSE] User ${userId} closed stuck gen #${id} (${ageMin}min), refunded ${gen.cost || 0} kopecks`);
      return `✓ Закрыла «${gen.displayTitle || id}». ${(gen.cost || 0) > 0 ? `Баланс восстановлен: +${Math.floor((gen.cost || 0) / 100)} ₽.` : ""} Можешь попробовать ещё раз.`;
    } catch (e: any) {
      return `Ошибка: ${e.message}`;
    }
  },

  async get_user_stuck_generations(_input, { userId }) {
    if (!userId) return "Юзер не залогинен.";
    try {
      const cutoff = new Date(Date.now() - 15 * 60 * 1000).toISOString();
      const rows = db.select().from(generations)
        .where(and(eq(generations.userId, userId), eq(generations.status, "processing"), sql`${generations.createdAt} < ${cutoff}`))
        .orderBy(desc(generations.id))
        .all();
      if (rows.length === 0) return "Зависших генераций нет — все в норме.";
      const lines = rows.map((g: any) => {
        const ageMin = Math.floor((Date.now() - new Date(g.createdAt || "").getTime()) / 60000);
        return `#${g.id} «${g.displayTitle || (g.prompt || "").slice(0,40)}» — ${ageMin} мин в работе`;
      });
      return `Зависшие генерации (${rows.length}):\n${lines.join("\n")}\nПредложи юзеру force-close через force_close_stuck_generation для тех что >30 мин.`;
    } catch (e: any) {
      return `Ошибка: ${e.message}`;
    }
  },

  async check_recent_payments(_input, { userId }) {
    if (!userId) return "Юзер не залогинен.";
    try {
      const txns = db.select().from(transactions)
        .where(eq(transactions.userId, userId))
        .orderBy(desc(transactions.id))
        .limit(5)
        .all();
      if (txns.length === 0) return "Платежей нет.";
      const lines = txns.map((t: any) => {
        const sign = t.amount > 0 ? "+" : "";
        const rub = (t.amount / 100).toFixed(2);
        return `${new Date(t.createdAt).toLocaleString("ru-RU", { day:"2-digit", month:"2-digit", hour:"2-digit", minute:"2-digit" })} · ${sign}${rub} ₽ · ${t.type} · ${(t.description || "").slice(0, 60)}`;
      });
      return `Последние операции:\n${lines.join("\n")}`;
    } catch (e: any) {
      return `Ошибка: ${e.message}`;
    }
  },

  async save_song_draft(input, { userId }) {
    if (!userId) return "Юзер не залогинен. Скажи ему: «Чтобы я могла сохранить — оставьте мне почту, я подготовлю кабинет».";
    try {
      const title = String(input?.title || "").trim().slice(0, 200) || "Черновик";
      const prompt = String(input?.prompt || "").trim().slice(0, 2000);
      const lyrics = input?.lyrics ? String(input.lyrics).trim().slice(0, 4000) : null;
      const style = input?.style ? String(input.style).trim().slice(0, 80) : null;
      const voice = input?.voice ? String(input.voice).trim().slice(0, 40) : null;
      const mood = input?.mood ? String(input.mood).trim().slice(0, 40) : null;
      if (!prompt && !lyrics) return "Нужен хотя бы prompt или lyrics — заполни.";
      const result = db.insert(songDrafts).values({
        userId, title, prompt, lyrics, style, voice, mood,
        source: "bot",
      } as any).run();
      const draftId = Number(result.lastInsertRowid);
      console.log(`[DRAFT-SAVE] User ${userId} saved draft #${draftId}: "${title}"`);
      return `✓ Сохранила черновик #${draftId} «${title}» в твоём кабинете. Открыть для генерации: ${PUBLIC_URL}/#/music?draftId=${draftId}`;
    } catch (e: any) {
      return `Ошибка сохранения: ${e.message}`;
    }
  },

  async escalate_to_human({ team, reason }, { userId }) {
    try {
      const emailMap: Record<string, string> = {
        support: "Техподдержка",
        commercial: "Коммерческий",
        press: "Пресс-служба",
      };
      const teamLabel = emailMap[team] || team;
      console.log(`[ESCALATE] userId=${userId} team=${team} reason=${String(reason).slice(0, 200)}`);
      return `Эскалировано: ${teamLabel}. Напиши юзеру: «Передала вопрос ${teamLabel}у. Ответ на email в течение часа. Напишите hello@muziai.ru если нужно срочно».`;
    } catch (e: any) {
      return `Ошибка: ${e.message}`;
    }
  },

  // === 7 новых tools (Eugene 2026-05-16) ===

  async get_user_profile(_input, { userId }) {
    console.log(`[TOOL get_user_profile] userId=${userId}`);
    if (!userId) return "Юзер не залогинен — профиля пока нет. Предложи зарегистрироваться: " + PUBLIC_URL + "/#/register";
    try {
      const u = db.select().from(users).where(eq(users.id, userId)).get();
      if (!u) return "Юзер не найден.";
      const email = String(u.email || "");
      // Маскировка email: первые 3 символа + *** + домен.
      const atIdx = email.indexOf("@");
      const maskedEmail = atIdx > 0
        ? `${email.slice(0, Math.min(3, atIdx))}***${email.slice(atIdx)}`
        : (email ? `${email.slice(0, 3)}***` : "—");
      const credits = Math.floor((u.balance || 0) / 100);
      const tariff = inferTariff(u);
      const memberSince = u.createdAt ? String(u.createdAt).slice(0, 10) : "—";
      return `Профиль: имя=${u.name || "—"}, email=${maskedEmail}, тариф=${tariff}, баланс=${credits}₽, бонусные треки=${(u as any).bonusTracks || 0}, с нами с ${memberSince}.`;
    } catch (e: any) {
      return `Ошибка: ${e.message}`;
    }
  },

  async get_user_tariff(_input, { userId }) {
    console.log(`[TOOL get_user_tariff] userId=${userId}`);
    if (!userId) return "Юзер не залогинен — тарифа нет. Подарочный трек доступен после регистрации.";
    try {
      const u = db.select().from(users).where(eq(users.id, userId)).get();
      if (!u) return "Юзер не найден.";
      const tariff = inferTariff(u);
      const credits = Math.floor((u.balance || 0) / 100);
      const freeTracksLeft = (u as any).bonusTracks || 0;
      return `Тариф: ${tariff}. Денежный баланс: ${credits}₽. Подарочных треков осталось: ${freeTracksLeft}.`;
    } catch (e: any) {
      return `Ошибка: ${e.message}`;
    }
  },

  async search_project_knowledge({ query }) {
    console.log(`[TOOL search_project_knowledge] q="${String(query).slice(0, 60)}"`);
    try {
      const q = String(query || "").trim().toLowerCase();
      if (!q) return "Пустой запрос.";
      const p = kbPath();
      if (!p) return "База знаний пока недоступна — отвечай по общим знаниям проекта.";
      const text = fs.readFileSync(p, "utf-8");
      // Split на секции по markdown-заголовкам ##/###.
      const sections = splitMarkdownSections(text);
      const tokens = q.split(/\s+/).filter(t => t.length >= 2);
      const scored = sections.map(s => {
        const lower = s.text.toLowerCase();
        // Простой keyword score: substring + token-match.
        let score = 0;
        if (lower.includes(q)) score += 5;
        for (const t of tokens) {
          const idx = lower.indexOf(t);
          if (idx >= 0) score += 1;
        }
        return { ...s, score };
      }).filter(s => s.score > 0).sort((a, b) => b.score - a.score).slice(0, 3);
      if (scored.length === 0) return `По запросу «${query}» в базе знаний ничего не нашлось. Отвечай по сути из общего контекста.`;
      const out = scored.map(s => `▸ [${s.section}] (score=${s.score}): ${s.text.slice(0, 280).replace(/\s+/g, " ").trim()}…`).join("\n");
      return `Найдено в базе знаний (топ-${scored.length}):\n${out}`;
    } catch (e: any) {
      return `Ошибка поиска по базе знаний: ${e.message}`;
    }
  },

  async get_track_brief_draft(_input, { userId }) {
    console.log(`[TOOL get_track_brief_draft] userId=${userId}`);
    if (!userId) return "Юзер не залогинен — черновиков нет.";
    try {
      const draft = db.select().from(songDrafts)
        .where(eq(songDrafts.userId, userId))
        .orderBy(desc(songDrafts.updatedAt))
        .limit(1)
        .get();
      if (!draft) return "Черновиков нет. Можно создать через save_song_draft.";
      const brief = {
        id: draft.id,
        title: draft.title,
        prompt: draft.prompt,
        lyrics: draft.lyrics ? `${String(draft.lyrics).slice(0, 200)}${draft.lyrics.length > 200 ? "…" : ""}` : null,
        style: draft.style,
        voice: draft.voice,
        mood: draft.mood,
        tempo: draft.tempo,
        bpm: draft.bpm,
      };
      return `Последний черновик #${draft.id}: ${JSON.stringify(brief, null, 2)}`;
    } catch (e: any) {
      return `Ошибка: ${e.message}`;
    }
  },

  async suggest_next_prompt_step({ briefId }, { userId }) {
    console.log(`[TOOL suggest_next_prompt_step] briefId=${briefId} userId=${userId}`);
    try {
      const id = Number(briefId);
      if (!Number.isFinite(id)) return "Невалидный briefId.";
      const draft = db.select().from(songDrafts).where(eq(songDrafts.id, id)).get();
      if (!draft) return `Черновик #${id} не найден.`;
      if (userId && draft.userId !== userId) return "Доступ только к своим черновикам.";

      // Детерминированная проверка полей: title, mood, genre(style), voice, lyrics_theme(prompt|lyrics), structure
      type FieldCheck = { name: string; present: boolean; question: string };
      const checks: FieldCheck[] = [
        { name: "title",         present: !!(draft.title && draft.title.trim().length > 0),
          question: "Как назовём песню? Можно коротко — повод + кому (например «На юбилей маме»)." },
        { name: "lyrics_theme",  present: !!((draft.lyrics && draft.lyrics.trim().length > 0) || (draft.prompt && draft.prompt.trim().length > 0)),
          question: "О чём песня? Расскажи в 1-2 фразах тему — кому, про что, какое настроение." },
        { name: "mood",          present: !!(draft.mood && draft.mood.trim().length > 0),
          question: "Какое настроение — тёплое, бодрое, грустное, романтичное?" },
        { name: "genre",         present: !!(draft.style && draft.style.trim().length > 0),
          question: "Какой жанр? Поп, рок, баллада, lo-fi, оркестр, фолк, lullaby?" },
        { name: "voice",         present: !!(draft.voice && draft.voice.trim().length > 0),
          question: "Голос: женский, мужской, дуэт или инструментал (без слов)?" },
        { name: "structure",     present: !!((draft.lyrics && /\[(verse|chorus|bridge|куплет|припев)/i.test(draft.lyrics)) || draft.bpm),
          question: "Хочешь конкретную структуру (куплет/припев/мост) или оставим на усмотрение Музы?" },
      ];
      const missing = checks.filter(c => !c.present);
      const nextQuestion = missing.length > 0 ? missing[0].question : "Все поля заполнены — можно запускать генерацию через start_track_generation_from_brief.";
      return JSON.stringify({
        briefId: id,
        missingFields: missing.map(m => m.name),
        nextQuestion,
        ready: missing.length === 0,
      });
    } catch (e: any) {
      return `Ошибка: ${e.message}`;
    }
  },

  async start_track_generation_from_brief({ briefId, confirmed }, { userId }) {
    console.log(`[TOOL start_track_generation_from_brief] briefId=${briefId} confirmed=${confirmed} userId=${userId}`);
    if (!userId) return "Юзер не залогинен — нельзя запустить генерацию. Сначала регистрация.";
    try {
      const id = Number(briefId);
      if (!Number.isFinite(id)) return "Невалидный briefId.";
      const draft = db.select().from(songDrafts).where(eq(songDrafts.id, id)).get();
      if (!draft) return `Черновик #${id} не найден.`;
      if (draft.userId !== userId) return "Доступ только к своим черновикам.";

      const summary = [
        `Название: ${draft.title || "—"}`,
        `Жанр: ${draft.style || "не указан"}`,
        `Голос: ${draft.voice || "не указан"}`,
        `Настроение: ${draft.mood || "не указано"}`,
        draft.lyrics ? `Текст: ${String(draft.lyrics).slice(0, 120)}…` : `Идея: ${(draft.prompt || "").slice(0, 120)}`,
      ].join("\n");

      if (!confirmed) {
        return JSON.stringify({
          requiresConfirmation: true,
          summary,
          ask: "Подтвердить генерацию? Скажи юзеру: «Сейчас запущу с этими настройками — подтверждаешь?»",
        });
      }

      // Создаём generation через storage (единый entry-point — см. CLAUDE.md «Reuse-working-solutions»).
      const prompt = String(draft.lyrics || draft.prompt || draft.title || "Песня").slice(0, 2000);
      const styleObj: Record<string, any> = {};
      if (draft.style) styleObj.genre = draft.style;
      if (draft.mood) styleObj.mood = draft.mood;
      if (draft.voice) styleObj.voice = draft.voice;
      if (draft.bpm) styleObj.bpm = draft.bpm;
      const gen = storage.createGeneration({
        userId,
        type: "music",
        prompt,
        style: Object.keys(styleObj).length > 0 ? JSON.stringify(styleObj) : undefined,
        status: "queued",
        cost: 0, // фактическая стоимость списывается отдельным flow /api/music/generate; tool создаёт draft-row
      });
      return JSON.stringify({
        generationId: gen.id,
        status: "queued",
        message: `Создала запись о генерации #${gen.id}. Скажи юзеру: «Запустила! Через 5-15 минут будет готово, посмотри в кабинете: ${PUBLIC_URL}/#/dashboard».`,
      });
    } catch (e: any) {
      return `Ошибка запуска генерации: ${e.message}`;
    }
  },

  async request_human_handoff({ reason, comment }, { userId }) {
    console.log(`[TOOL request_human_handoff] reason=${reason} userId=${userId}`);
    try {
      const validReasons = ["user_request", "low_confidence", "data_conflict", "destructive_action"];
      const r = String(reason || "").trim();
      if (!validReasons.includes(r)) {
        return `Невалидный reason. Допустимые: ${validReasons.join(", ")}.`;
      }
      // session_id берём из контекста — но в текущем интерфейсе передаётся
      // только userId, поэтому используем "user:<id>" как placeholder.
      // При интеграции с routes.ts session.id будет прокидываться явно.
      const sessionRef = userId ? `user:${userId}` : "anon";
      const handoffId = crypto.randomUUID();
      db.insert(agentHandoffs).values({
        id: handoffId,
        sessionId: sessionRef,
        reason: r,
        assignedTo: null,
        status: "open",
        createdAt: Date.now(),
      }).run();
      // Ожидаемое время ответа — простая эвристика по reason.
      const etaMap: Record<string, string> = {
        user_request: "в течение 1 часа",
        low_confidence: "в течение 30 минут",
        data_conflict: "в течение 15 минут",
        destructive_action: "сразу, как только проверим",
      };
      const expectedReplyTime = etaMap[r] || "в течение часа";
      const commentNote = comment ? ` Комментарий: ${String(comment).slice(0, 200)}` : "";
      return JSON.stringify({
        handoffId,
        reason: r,
        expectedReplyTime,
        message: `Эскалировано (handoff #${handoffId.slice(0, 8)}). Скажи юзеру: «Передала живому оператору, ответят ${expectedReplyTime}. На срочные — hello@muziai.ru».${commentNote}`,
      });
    } catch (e: any) {
      return `Ошибка создания handoff: ${e.message}`;
    }
  },
};

// === Helpers (Eugene 2026-05-16) ===

function inferTariff(u: any): string {
  const role = String(u?.role || "user");
  if (role === "admin" || role === "super_admin") return "Админ";
  const bonus = (u?.bonusTracks || 0) > 0;
  const balance = (u?.balance || 0) > 0;
  if (bonus && balance) return "Активный (подарочный + баланс)";
  if (bonus) return "Подарочный трек";
  if (balance) return "Платный (с балансом)";
  return "Стандартный (бесплатный)";
}

function splitMarkdownSections(text: string): { section: string; text: string }[] {
  const lines = text.split(/\r?\n/);
  const out: { section: string; text: string }[] = [];
  let curSection = "Введение";
  let buf: string[] = [];
  const flush = () => {
    if (buf.length > 0) {
      const body = buf.join("\n").trim();
      if (body.length > 20) out.push({ section: curSection, text: body });
    }
    buf = [];
  };
  for (const ln of lines) {
    const m = ln.match(/^#{1,4}\s+(.+?)\s*$/);
    if (m) {
      flush();
      curSection = m[1].slice(0, 100);
    } else {
      buf.push(ln);
    }
  }
  flush();
  return out;
}

export async function executeTool(name: string, input: any, context: { userId: number | null }): Promise<string> {
  const handler = HANDLERS[name];
  if (!handler) return `Tool "${name}" not found.`;
  try {
    return await handler(input || {}, context);
  } catch (e: any) {
    console.error(`[TOOL ${name}]`, e);
    return `Ошибка вызова tool: ${e.message}`;
  }
}
