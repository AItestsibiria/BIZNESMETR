// Eugene 2026-05-14 Босс: Advanced AI agent для Музы — Tool Use (function
// calling) через Anthropic API. Муза сама решает когда вызвать tool,
// анализирует ответ, продолжает диалог.
//
// Каждый tool: name + description + input_schema (JSON-schema) + handler.

import { db } from "../storage";
import { users, generations, transactions, songDrafts } from "@shared/schema";
import { eq, and, desc, sql, isNotNull } from "drizzle-orm";

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
        return `«${title}» #${id}: в работе (${ageMin} мин). MuziAi обычно за 5-15 мин.`;
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
      return `✓ Сохранила черновик #${draftId} «${title}» в твоём кабинете. Открыть для генерации: https://muziai.ru/#/music?draftId=${draftId}`;
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
};

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
