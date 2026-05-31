// Eugene 2026-05-21 Босс: chat-tool-calling MVP.
//
// Tools для диалогового управления генерацией текста и музыки через Музу.
// Каждый tool обёртка над существующей логикой — НЕ дублирует business
// logic, использует те же storage / gptunnelFetch / checkAndCharge паттерны
// что и REST endpoints (/api/music/generate, /api/lyrics/generate, и т.д.).
//
// Главные правила:
//   1. Все платные tools требуют confirm_spend=true. Иначе возвращают
//      JSON {ok:false, approval_required:true, estimated_cost, ...}.
//   2. Каждый успешный tool call → recordAuditEntry (entity='chat_tool',
//      action='create' для генераций / 'update' для publish).
//   3. Возвращают JSON-строку с полями {ok, data?, error?, ...} — LLM
//      получает её как tool_result, frontend перехватывает через
//      onToolResult callback в /api/muza/chat.
//   4. Никаких прямых HTTP-вызовов к собственным endpoints — работаем
//      на уровне storage + gptunnelFetch (in-process).
//
// См. Chat-tool-calling rule в CLAUDE.md.

import { db, storage, sqliteDb } from "../storage";
import { users, generations } from "@shared/schema";
import { eq, and, desc } from "drizzle-orm";
import type { ToolDef, ToolHandler, ToolContext } from "./muzaTools";
import { getCurrentPriceKopecks, getCurrentPriceLabel } from "./pricing";
import { recordAuditEntry } from "./adminAuditLog";
import { normalizeVocalParams } from "./normalizeVocalParams";

// Eugene 2026-05-31 PACK C — premium paywall pricing. Источник правды:
// routes.ts PREMIUM_TIERS.text_quality (29900 коп = 299 ₽/мес) +
// PRICES.premium_lyrics_oneoff (14900 коп = 149 ₽). Pricing-single-source
// rule — здесь дублируется только для approval-card preview; реальная
// активация подписки идёт через Robokassa Result callback (routes.ts
// TARIFF_TO_TIER → tier='text_quality').
const PREMIUM_TEXT_QUALITY_KOPECKS = 29900;
const PREMIUM_TEXT_QUALITY_LABEL = "299 ₽/мес";
const PREMIUM_LYRICS_ONEOFF_KOPECKS = 14900;
const PREMIUM_LYRICS_ONEOFF_LABEL = "149 ₽";

// PUBLIC_URL для генерации payUrl (Reuse-working-solutions: тот же pattern
// что в muzaTools.ts issue_invoice).
const PUBLIC_URL = process.env.PUBLIC_URL || `https://${process.env.BASE_DOMAIN || "muzaai.ru"}`;

// === Inline GPTunnel client (mirrors routes.ts:458 gptunnelFetch) ===
const GPTUNNEL_BASE = process.env.GPTUNNEL_BASE || "https://gptunnel.ru/v1";
const GPTUNNEL_API_KEY = process.env.GPTUNNEL_API_KEY || "";

async function gptunnelCall(path: string, body: any, timeoutMs = 30_000): Promise<{ ok: boolean; status: number; data: any }> {
  if (!GPTUNNEL_API_KEY) {
    return { ok: false, status: 0, data: { error: { message: "GPTUNNEL_API_KEY missing" } } };
  }
  try {
    const resp = await fetch(`${GPTUNNEL_BASE}${path}`, {
      method: "POST",
      headers: {
        Authorization: GPTUNNEL_API_KEY,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const data = await resp.json().catch(() => ({}));
    return { ok: resp.ok, status: resp.status, data };
  } catch (e: any) {
    return { ok: false, status: 0, data: { error: { message: e?.message || String(e) } } };
  }
}

// === Helpers ===
function asJson(o: any): string {
  return JSON.stringify(o);
}

function requireUserId(ctx: ToolContext): number | null {
  if (!ctx.userId || ctx.userId <= 0) return null;
  return ctx.userId;
}

function priceFor(serviceType: "music" | "lyrics" | "cover"): { kopecks: number; label: string } {
  try {
    return {
      kopecks: getCurrentPriceKopecks(serviceType),
      label: getCurrentPriceLabel(serviceType),
    };
  } catch {
    const fallback = { music: 39900, lyrics: 9900, cover: 9900 }[serviceType] || 9900;
    return { kopecks: fallback, label: `${Math.round(fallback / 100)} ₽` };
  }
}

// Audit-log без блокировки tool-loop (sync, swallow errors).
function auditTool(opts: {
  ctx: ToolContext;
  action: "create" | "update" | "delete";
  entity: string;
  entityKey: string;
  before?: unknown;
  after?: unknown;
}) {
  try {
    recordAuditEntry({
      adminUserId: opts.ctx.userId ?? null,
      adminEmail: null,
      action: opts.action,
      entity: opts.entity,
      entityKey: opts.entityKey,
      before: opts.before,
      after: opts.after,
    });
  } catch {}
}

// === TOOL DEFINITIONS ===
export const CHAT_GENERATION_TOOLS: ToolDef[] = [
  {
    name: "generate_lyrics",
    description:
      "Сгенерировать текст песни (lyrics). ПЛАТНО (99 ₽), требует confirm_spend=true для списания. " +
      "Если confirm_spend=false (или не передан) — вернёт approval_required с estimated_cost. " +
      "Юзер должен явно подтвердить «да» прежде чем повторно вызвать с confirm_spend=true. " +
      "Использовать когда юзер просит сочинить текст: «напиши песню про X», «придумай слова для…».",
    input_schema: {
      type: "object",
      properties: {
        topic: { type: "string", description: "Тема песни (1-200 символов)" },
        theme: { type: "string", description: "Подтема / контекст (опц.)" },
        style: { type: "string", description: "Жанр: pop, rock, ballad, lo-fi, рэп, etc." },
        mood: { type: "string", description: "Настроение: warm, energetic, sad, romantic (опц.)" },
        tempo: { type: "string", description: "Темп: slow, mid, fast (опц.)" },
        length: { type: "string", description: "Длина: short / medium / long (опц.)" },
        language: { type: "string", description: "ru / en (default ru)" },
        confirm_spend: { type: "boolean", description: "true = списать 99₽ и сгенерировать. false/отсутствует = вернуть approval_required." },
      },
      required: ["topic"],
    },
  },
  {
    name: "rewrite_lyrics",
    description:
      "Переписать существующий lyrics-черновик по инструкции (например «сделай веселее», «убери второй куплет»). ПЛАТНО (99 ₽), confirm_spend обязателен. " +
      "lyrics_id — ID генерации типа 'lyrics' созданной ранее в этой сессии (через generate_lyrics).",
    input_schema: {
      type: "object",
      properties: {
        lyrics_id: { type: "number", description: "ID существующего lyrics-черновика" },
        instruction: { type: "string", description: "Инструкция переписывания (1-300 символов)" },
        keep_structure: { type: "boolean", description: "Сохранить структуру (Куплет/Припев) — default true" },
        confirm_spend: { type: "boolean", description: "true = списать 99₽ и переписать." },
      },
      required: ["lyrics_id", "instruction"],
    },
  },
  {
    name: "create_music_job",
    description:
      "Запустить ГЕНЕРАЦИЮ МУЗЫКИ (Suno через GPTunnel). ПЛАТНО (399 ₽), confirm_spend ОБЯЗАТЕЛЕН. " +
      "Если confirm_spend=false — вернёт approval_required с estimated_cost и описанием параметров — юзер должен подтвердить. " +
      "Если confirm_spend=true — спишет деньги, создаст generation в processing статусе, вернёт job_id. " +
      "Дальше нужно polling через get_generation_status({job_id}).",
    input_schema: {
      type: "object",
      properties: {
        source_type: { type: "string", enum: ["lyrics_id", "lyrics_text", "prompt"], description: "Что использовать как источник." },
        lyrics_id: { type: "number", description: "ID существующего lyrics-черновика (если source_type=lyrics_id)" },
        lyrics_text: { type: "string", description: "Готовый текст песни (если source_type=lyrics_text). 50-3000 символов." },
        prompt: { type: "string", description: "Краткое описание идеи (если source_type=prompt). 1-400 символов." },
        title: { type: "string", description: "Название трека (опц., 1-80 символов)" },
        genre: { type: "string", description: "Жанр: pop, rock, ballad, рэп, lo-fi (опц.)" },
        mood: { type: "string", description: "Настроение: warm, energetic, sad, romantic (опц.)" },
        tempo: { type: "string", description: "Темп: slow, mid, fast (опц.)" },
        voice: { type: "string", enum: ["female", "male", "duet", "instrumental"], description: "Тип вокала (опц.)" },
        instrumental: { type: "boolean", description: "true = без вокала (опц., альтернатива voice=instrumental)" },
        category: { type: "string", enum: ["song", "greeting", "instrumental"], description: "Категория трека (опц., default 'song')" },
        confirm_spend: { type: "boolean", description: "true = списать 399₽ и запустить генерацию." },
      },
      required: ["source_type"],
    },
  },
  {
    name: "get_generation_status",
    description:
      "Узнать статус генерации по job_id (вернёт processing / done / error + audio_url + cover_url если done). " +
      "БЕСПЛАТНО. Используй после create_music_job чтобы понять готов ли трек. " +
      "Можно вызывать для любого типа генерации (music / lyrics / cover) текущего юзера.",
    input_schema: {
      type: "object",
      properties: {
        job_id: { type: "number", description: "ID генерации (полученный из create_music_job или generate_lyrics)" },
      },
      required: ["job_id"],
    },
  },
  {
    name: "list_recent_assets",
    description:
      "Список последних N треков текущего юзера (done статус). По умолчанию 10, максимум 30. Не требует параметров. " +
      "Используй когда юзер просит «покажи мои недавние треки», «что я создал».",
    input_schema: {
      type: "object",
      properties: {
        limit: { type: "number", description: "1-30, default 10" },
      },
      required: [],
    },
  },
  {
    name: "get_asset_details",
    description:
      "Полные мета-данные одного трека по asset_id (audio_url, cover_url, title, lyrics, duration, plays, category, visibility). " +
      "Только свои треки (по userId). БЕСПЛАТНО.",
    input_schema: {
      type: "object",
      properties: {
        asset_id: { type: "number", description: "ID трека (generation.id)" },
      },
      required: ["asset_id"],
    },
  },
  {
    name: "publish_asset",
    description:
      "Изменить видимость трека: 'public_main' (новые авторы — попадает на главную в раздел Новые авторы) или 'private' (только в кабинете). " +
      "Требует confirm_publish=true для подтверждения. БЕЗ confirm_publish — вернёт approval_required с описанием. " +
      "ВАЖНО: тариф 'main' (одобренный плейлист) выставляется только админом через челофильтр — этот tool на него не претендует.",
    input_schema: {
      type: "object",
      properties: {
        asset_id: { type: "number", description: "ID трека (generation.id)" },
        visibility: { type: "string", enum: ["public_main", "private"], description: "Новая видимость" },
        confirm_publish: { type: "boolean", description: "true = подтверждаю изменение видимости" },
      },
      required: ["asset_id", "visibility"],
    },
  },
  {
    name: "cancel_generation_job",
    description:
      "Отменить in-flight генерацию (status='processing' > 0 мин — реальное прерывание Suno невозможно, но мы помечаем status='cancelled' и refund'им деньги если списано). " +
      "Только свои генерации. БЕСПЛАТНО (вернёт деньги если были списаны).",
    input_schema: {
      type: "object",
      properties: {
        job_id: { type: "number", description: "ID генерации" },
      },
      required: ["job_id"],
    },
  },
  {
    // Eugene 2026-05-31 PACK C — premium paywall tool. Музa вызывает когда
    // юзер общается долго (≥15 сообщений) БЕЗ единой генерации/оплаты —
    // мягкий paywall для конвертации в premium-подписку или one-off.
    // ВСЕГДА требует confirm_spend=true (Chat-tool-calling rule, защита от
    // LLM-инициатив). Без confirm_spend → approval_required JSON с описанием
    // тарифа + balance юзера + invoice preview. Реальная оплата — Robokassa
    // через issue_invoice pipeline (Reuse-working-solutions rule).
    name: "propose_premium_paywall",
    description:
      "Предложить юзеру премиум-paywall: подписка text_quality (299 ₽/мес, безлимит на 4-step lyrics + приоритет в очереди генерации) ИЛИ one-off premium lyrics draft (149 ₽). " +
      "ИСПОЛЬЗОВАТЬ ТОЛЬКО когда юзер общается ≥15 сообщений БЕЗ единой оплаты/генерации (вяло-нейтральный диалог без commitment). " +
      "НЕ навязывать активным юзерам которые уже генерят/платят. " +
      "Тариф 'subscription' = подписка text_quality 299₽/мес; 'oneoff' = единичный premium draft 149₽. " +
      "confirm_spend=false (или нет) → approval_required JSON с описанием. confirm_spend=true → выписывает счёт через invoice pipeline (Robokassa-payment-url). " +
      "Не активирует подписку сама — это делает Robokassa Result callback после реальной оплаты.",
    input_schema: {
      type: "object",
      properties: {
        tariff: { type: "string", enum: ["subscription", "oneoff"], description: "'subscription' = premium_text_quality 299₽/мес; 'oneoff' = premium_lyrics_oneoff 149₽" },
        reason: { type: "string", description: "Почему именно сейчас предлагаешь (1-200 chars): «много обсуждали, но не запускали» / «текст-черновик зрелый, давай переведём в премиум»." },
        confirm_spend: { type: "boolean", description: "true = выписать счёт. false/отсутствует = approval_required с preview." },
      },
      required: ["tariff", "reason"],
    },
  },
];

// === HANDLERS ===
export const CHAT_GENERATION_HANDLERS: Record<string, ToolHandler> = {
  async generate_lyrics(input, ctx) {
    const userId = requireUserId(ctx);
    if (!userId) return asJson({ ok: false, error: "Юзер не залогинен. Предложи зарегистрироваться чтобы сохранить текст." });
    const topic = String(input?.topic || "").trim().slice(0, 200);
    if (!topic) return asJson({ ok: false, error: "Нужна тема (topic)." });
    const style = String(input?.style || input?.genre || "поп").trim().slice(0, 60);
    const mood = String(input?.mood || "").trim().slice(0, 60);
    const language = String(input?.language || "ru").toLowerCase() === "en" ? "en" : "ru";
    const confirmSpend = input?.confirm_spend === true;
    const { kopecks, label } = priceFor("lyrics");

    // Check user balance + bonusTracks for approval card
    const user = storage.getUser(userId);
    if (!user) return asJson({ ok: false, error: "Пользователь не найден." });

    if (!confirmSpend) {
      return asJson({
        ok: false,
        approval_required: true,
        tool: "generate_lyrics",
        estimated_cost_kopecks: kopecks,
        estimated_cost_label: label,
        user_balance_label: `${Math.floor((user.balance || 0) / 100)} ₽`,
        params_preview: { topic, style, mood, language },
        message: `Сгенерировать текст песни про «${topic}» (${style}, ${mood || "по умолчанию"}) — ${label}?`,
      });
    }

    // Списываем баланс. checkAndCharge живёт в routes.ts → используем минимальную реплику.
    if ((user.balance || 0) < kopecks) {
      return asJson({
        ok: false,
        error: `Недостаточно средств. Нужно ${label}, на балансе ${Math.floor((user.balance || 0) / 100)} ₽.`,
        approval_required: false,
        insufficient_funds: true,
      });
    }
    try {
      storage.updateBalance(userId, -kopecks);
      storage.createTransaction({ userId, type: "lyrics", amount: -kopecks, description: `Генерация lyrics (через чат): ${label}` });
    } catch (e: any) {
      return asJson({ ok: false, error: `Не удалось списать баланс: ${e?.message || e}` });
    }

    // Create generation row
    const gen = storage.createGeneration({
      userId,
      type: "lyrics",
      prompt: topic,
      style: JSON.stringify({ genre: style, mood, language, viaChat: true }),
      cost: kopecks,
      status: "processing",
      isPublic: 0,
    });

    // GPTunnel call (mirrors /api/lyrics/generate logic but inline)
    const systemPrompt = `Ты профессиональный автор текстов песен для Suno AI. Пиши на ${language === "en" ? "английском" : "русском"} языке. Жанр: ${style}. Настроение: ${mood || "нейтральное"}.
Формат: [Куплет 1], [Припев], [Куплет 2], [Бридж].
KRITICHESKOE OGRANICHENIE: текст МАКСИМУМ 350 символов включая пометки секций. Превышение = ошибка.
Пиши ОЧЕНЬ компактно: 4 строки на куплет, 4 на припев, 2 на бридж. Каждая строка не более 25 символов. Не добавляй пояснений, только текст песни.`;

    const resp = await gptunnelCall("/chat/completions", {
      model: "gpt-4o-mini",
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: topic },
      ],
      max_tokens: 300,
      temperature: 0.8,
    });

    if (!resp.ok) {
      try {
        storage.updateGeneration(gen.id, { status: "error" });
        storage.refundGeneration({ genId: gen.id, userId, cost: kopecks, type: "lyrics", description: `Возврат: ошибка генерации текста #${gen.id}` });
      } catch {}
      return asJson({ ok: false, error: `Ошибка LLM: ${resp.data?.error?.message || `HTTP ${resp.status}`}. Баланс возвращён.` });
    }

    let lyrics = resp.data?.choices?.[0]?.message?.content || "";
    if (lyrics.length > 400) {
      const trimmed = lyrics.slice(0, 400);
      const lastNl = trimmed.lastIndexOf("\n");
      lyrics = lastNl > 200 ? trimmed.slice(0, lastNl) : trimmed;
    }
    storage.updateGeneration(gen.id, { status: "done", resultUrl: lyrics });
    auditTool({
      ctx,
      action: "create",
      entity: "chat_tool:generate_lyrics",
      entityKey: String(gen.id),
      after: { topic, style, mood, language, kopecks },
    });
    return asJson({
      ok: true,
      data: {
        lyrics_id: gen.id,
        preview: lyrics.slice(0, 300),
        full_text: lyrics,
        cost_label: label,
      },
      message: `Текст готов (ID: ${gen.id}). ${lyrics.length} символов. Списано ${label}.`,
    });
  },

  async rewrite_lyrics(input, ctx) {
    const userId = requireUserId(ctx);
    if (!userId) return asJson({ ok: false, error: "Юзер не залогинен." });
    const lyricsId = Number(input?.lyrics_id);
    if (!Number.isFinite(lyricsId) || lyricsId <= 0) return asJson({ ok: false, error: "lyrics_id обязателен." });
    const instruction = String(input?.instruction || "").trim().slice(0, 300);
    if (!instruction) return asJson({ ok: false, error: "Нужна инструкция (instruction)." });
    const keepStructure = input?.keep_structure !== false;
    const confirmSpend = input?.confirm_spend === true;
    const { kopecks, label } = priceFor("lyrics");

    // Verify ownership
    const old = storage.getGeneration(lyricsId);
    if (!old || old.userId !== userId || old.type !== "lyrics") {
      return asJson({ ok: false, error: "lyrics-черновик не найден или не принадлежит вам." });
    }
    const oldText = String((old as any).resultUrl || "");
    if (!oldText) return asJson({ ok: false, error: "У этого черновика нет текста (вероятно, генерация ещё не завершена)." });

    const user = storage.getUser(userId);
    if (!user) return asJson({ ok: false, error: "Пользователь не найден." });

    if (!confirmSpend) {
      return asJson({
        ok: false,
        approval_required: true,
        tool: "rewrite_lyrics",
        estimated_cost_kopecks: kopecks,
        estimated_cost_label: label,
        user_balance_label: `${Math.floor((user.balance || 0) / 100)} ₽`,
        params_preview: { lyrics_id: lyricsId, instruction, keep_structure: keepStructure, original_preview: oldText.slice(0, 200) },
        message: `Переписать текст #${lyricsId} (инструкция: «${instruction}») — ${label}?`,
      });
    }

    if ((user.balance || 0) < kopecks) {
      return asJson({ ok: false, error: `Недостаточно средств. Нужно ${label}.`, insufficient_funds: true });
    }
    try {
      storage.updateBalance(userId, -kopecks);
      storage.createTransaction({ userId, type: "lyrics", amount: -kopecks, description: `Переписать lyrics #${lyricsId} (через чат)` });
    } catch (e: any) {
      return asJson({ ok: false, error: `Не удалось списать баланс: ${e?.message || e}` });
    }

    const newGen = storage.createGeneration({
      userId,
      type: "lyrics",
      prompt: `[rewrite of #${lyricsId}] ${instruction}`,
      style: JSON.stringify({ rewriteOf: lyricsId, instruction, keepStructure, viaChat: true }),
      cost: kopecks,
      status: "processing",
      isPublic: 0,
    });

    const systemPrompt = `Ты профессиональный автор текстов песен. Перепиши предложенный текст согласно инструкции пользователя. ${keepStructure ? "СОХРАНИ структуру (Куплет/Припев/Бридж)." : "Можно менять структуру."} Максимум 350 символов. Только текст песни, без пояснений.`;

    const resp = await gptunnelCall("/chat/completions", {
      model: "gpt-4o-mini",
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: `Исходный текст:\n${oldText}\n\nИнструкция: ${instruction}` },
      ],
      max_tokens: 300,
      temperature: 0.8,
    });

    if (!resp.ok) {
      try {
        storage.updateGeneration(newGen.id, { status: "error" });
        storage.refundGeneration({ genId: newGen.id, userId, cost: kopecks, type: "lyrics", description: `Возврат: rewrite #${newGen.id}` });
      } catch {}
      return asJson({ ok: false, error: `Ошибка LLM: ${resp.data?.error?.message || `HTTP ${resp.status}`}. Баланс возвращён.` });
    }

    let newText = resp.data?.choices?.[0]?.message?.content || "";
    if (newText.length > 400) {
      const trimmed = newText.slice(0, 400);
      const lastNl = trimmed.lastIndexOf("\n");
      newText = lastNl > 200 ? trimmed.slice(0, lastNl) : trimmed;
    }
    storage.updateGeneration(newGen.id, { status: "done", resultUrl: newText });
    auditTool({
      ctx,
      action: "create",
      entity: "chat_tool:rewrite_lyrics",
      entityKey: String(newGen.id),
      before: { lyrics_id: lyricsId, preview: oldText.slice(0, 200) },
      after: { instruction, new_preview: newText.slice(0, 200) },
    });
    return asJson({
      ok: true,
      data: {
        lyrics_id: newGen.id,
        previous_lyrics_id: lyricsId,
        preview: newText.slice(0, 300),
        full_text: newText,
        cost_label: label,
      },
      message: `Текст переписан (новый ID: ${newGen.id}). Списано ${label}.`,
    });
  },

  async create_music_job(input, ctx) {
    const userId = requireUserId(ctx);
    if (!userId) return asJson({ ok: false, error: "Юзер не залогинен." });
    const sourceType = String(input?.source_type || "").trim();
    if (!["lyrics_id", "lyrics_text", "prompt"].includes(sourceType)) {
      return asJson({ ok: false, error: "source_type обязателен (lyrics_id | lyrics_text | prompt)." });
    }
    const confirmSpend = input?.confirm_spend === true;
    const { kopecks, label } = priceFor("music");
    const user = storage.getUser(userId);
    if (!user) return asJson({ ok: false, error: "Пользователь не найден." });

    // Resolve lyrics text + prompt
    let lyricsText = "";
    let promptText = "";
    if (sourceType === "lyrics_id") {
      const lid = Number(input?.lyrics_id);
      if (!Number.isFinite(lid) || lid <= 0) return asJson({ ok: false, error: "lyrics_id обязателен для source_type=lyrics_id." });
      const lyr = storage.getGeneration(lid);
      if (!lyr || lyr.userId !== userId || lyr.type !== "lyrics") {
        return asJson({ ok: false, error: "Lyrics-черновик не найден или не принадлежит вам." });
      }
      lyricsText = String((lyr as any).resultUrl || "");
      if (!lyricsText) return asJson({ ok: false, error: "У черновика нет текста — попробуй пересоздать generate_lyrics." });
      promptText = String(lyr.prompt || "").slice(0, 200);
    } else if (sourceType === "lyrics_text") {
      lyricsText = String(input?.lyrics_text || "").trim();
      if (lyricsText.length < 50) return asJson({ ok: false, error: "lyrics_text слишком короткий (мин. 50 символов)." });
      if (lyricsText.length > 3000) lyricsText = lyricsText.slice(0, 3000);
    } else {
      promptText = String(input?.prompt || "").trim().slice(0, 400);
      if (!promptText) return asJson({ ok: false, error: "prompt обязателен для source_type=prompt." });
    }

    const title = String(input?.title || "").trim().slice(0, 80);
    const genre = String(input?.genre || "").trim().slice(0, 60);
    const mood = String(input?.mood || "").trim().slice(0, 60);
    const tempo = String(input?.tempo || "").trim().slice(0, 30);
    const voiceTypeInput = String(input?.voice || "").toLowerCase();
    const instrumentalFlag = input?.instrumental === true || voiceTypeInput === "instrumental";
    const category = ["song", "greeting", "instrumental"].includes(String(input?.category || ""))
      ? String(input?.category)
      : "song";

    const styleString = [genre, mood, tempo].filter(Boolean).join(", ").slice(0, 200);

    if (!confirmSpend) {
      // Compute "what will be generated" preview
      const hasBonus = (user as any).bonusTracks > 0;
      return asJson({
        ok: false,
        approval_required: true,
        tool: "create_music_job",
        estimated_cost_kopecks: hasBonus ? 0 : kopecks,
        estimated_cost_label: hasBonus ? "🎁 Бесплатно (подарочный трек)" : label,
        user_balance_label: `${Math.floor((user.balance || 0) / 100)} ₽`,
        user_bonus_tracks: (user as any).bonusTracks || 0,
        params_preview: {
          source_type: sourceType,
          title: title || null,
          genre: genre || null,
          mood: mood || null,
          tempo: tempo || null,
          voice: voiceTypeInput || (instrumentalFlag ? "instrumental" : null),
          category,
          lyrics_preview: lyricsText ? lyricsText.slice(0, 200) : null,
          prompt_preview: promptText || null,
        },
        message: `Создать музыкальный трек${title ? ` «${title}»` : ""}${genre ? ` (${genre})` : ""} — ${hasBonus ? "бесплатно (подарочный трек)" : label}?`,
      });
    }

    // === Charge ===
    let isBonus = false;
    let actualCost = kopecks;
    if ((user as any).bonusTracks > 0) {
      try {
        // Decrement bonusTracks
        (db as any).$client.prepare(`UPDATE users SET bonus_tracks = bonus_tracks - 1 WHERE id = ?`).run(userId);
        storage.createTransaction({ userId, type: "music", amount: 0, description: "🎁 Генерация музыки через чат (подарочный трек)" });
        isBonus = true;
        actualCost = 0;
      } catch {}
    } else {
      if ((user.balance || 0) < kopecks) {
        return asJson({ ok: false, error: `Недостаточно средств. Нужно ${label}.`, insufficient_funds: true });
      }
      try {
        storage.updateBalance(userId, -kopecks);
        storage.createTransaction({ userId, type: "music", amount: -kopecks, description: `Генерация музыки через чат: ${label}` });
      } catch (e: any) {
        return asJson({ ok: false, error: `Не удалось списать баланс: ${e?.message || e}` });
      }
    }

    // === Create generation row ===
    const gen = storage.createGeneration({
      userId,
      type: "music",
      prompt: promptText || lyricsText.slice(0, 400) || "Песня",
      style: JSON.stringify({
        style: styleString,
        title: title || undefined,
        instrumental: instrumentalFlag,
        category,
        viaChat: true,
        sourceType,
      }),
      cost: isBonus ? 0 : kopecks,
      status: "processing",
      isPublic: 0, // Default private — юзер может published_asset позже
      authorName: user.name || "Аноним",
    });

    // Normalize vocal params (same as /api/music/generate)
    const norm = normalizeVocalParams({
      prompt: promptText,
      style: styleString,
      lyrics: lyricsText,
      voiceType: voiceTypeInput || undefined,
      voice: voiceTypeInput || undefined,
      isDuet: voiceTypeInput === "duet",
      instrumental: instrumentalFlag,
      generationId: gen.id,
    });

    const rawLyrics = norm.finalLyrics || lyricsText || "";
    const rawPrompt = norm.finalPrompt || promptText || "";
    const fullTags = norm.finalStyle;
    const isInstrumental = norm.voiceType === "instrumental";

    const autoTitle =
      title ||
      rawLyrics.split("\n")[0]?.replace(/^\[.*?\]\s*/, "").slice(0, 80) ||
      rawPrompt.slice(0, 80) ||
      "Мой трек";

    const payload: any = { model: "suno" };
    const effectivePrompt = rawPrompt || rawLyrics.split("\n").slice(0, 3).join(" ").slice(0, 400);
    if (isInstrumental) {
      payload.prompt = `Instrumental, no vocals. ${fullTags || ""} ${effectivePrompt}`.trim().slice(0, 400);
    } else if (rawLyrics && rawLyrics.length >= 50) {
      payload.mode = "custom";
      payload.lyric = rawLyrics.slice(0, 3000);
      payload.title = autoTitle.slice(0, 80);
      if (fullTags) payload.tags = fullTags.slice(0, 200);
      if (rawPrompt) payload.prompt = rawPrompt.slice(0, 400);
    } else {
      payload.prompt = (effectivePrompt || rawLyrics || "Песня").slice(0, 400);
    }

    try {
      (db as any).$client.prepare(`UPDATE generations SET display_title = ? WHERE id = ?`).run(autoTitle.slice(0, 200), gen.id);
    } catch {}

    const resp = await gptunnelCall("/media/create", payload, 30_000);
    if (!resp.ok || resp.data?.error || (resp.data?.code && resp.data.code !== 0)) {
      const apiErrText = resp.data?.error?.message || resp.data?.message || `HTTP ${resp.status}`;
      try {
        storage.updateGeneration(gen.id, { status: "error" });
        (db as any).$client.prepare(`UPDATE generations SET error_reason = ? WHERE id = ?`).run(`MuzaAi отклонил: ${apiErrText}`, gen.id);
        if (!isBonus) {
          storage.refundGeneration({ genId: gen.id, userId, cost: actualCost, type: "music", description: `Возврат: ошибка генерации #${gen.id} (chat)` });
        }
      } catch {}
      return asJson({ ok: false, error: `Не удалось запустить генерацию: ${apiErrText}. Баланс возвращён.`, refunded: !isBonus });
    }

    const taskId = resp.data?.id;
    if (!taskId) {
      try {
        storage.updateGeneration(gen.id, { status: "error" });
        if (!isBonus) {
          storage.refundGeneration({ genId: gen.id, userId, cost: actualCost, type: "music", description: `Возврат: нет task_id #${gen.id} (chat)` });
        }
      } catch {}
      return asJson({ ok: false, error: "MuzaAi не вернул task_id. Баланс возвращён, попробуйте ещё раз.", refunded: !isBonus });
    }

    storage.updateGeneration(gen.id, { status: "processing", taskId });

    auditTool({
      ctx,
      action: "create",
      entity: "chat_tool:create_music_job",
      entityKey: String(gen.id),
      after: { title: autoTitle, genre, mood, voice: voiceTypeInput, category, cost_kopecks: actualCost, bonus: isBonus, taskId },
    });

    const updatedUser = storage.getUser(userId);
    return asJson({
      ok: true,
      data: {
        job_id: gen.id,
        task_id: taskId,
        status: "processing",
        title: autoTitle,
        estimated_ready_sec: 90,
        cost_label: isBonus ? "🎁 Бесплатно" : label,
        balance_after_kopecks: updatedUser?.balance || 0,
      },
      hint: `attachedJob:${gen.id}`,
      message: `Запустила генерацию (job_id=${gen.id}). Обычно готово через 1–2 минуты. Спрошу status через get_generation_status.`,
    });
  },

  async get_generation_status(input, ctx) {
    const userId = requireUserId(ctx);
    if (!userId) return asJson({ ok: false, error: "Юзер не залогинен." });
    const jobId = Number(input?.job_id);
    if (!Number.isFinite(jobId) || jobId <= 0) return asJson({ ok: false, error: "job_id обязателен." });
    const gen = storage.getGeneration(jobId);
    if (!gen) return asJson({ ok: false, error: "Генерация не найдена." });
    if (gen.userId !== userId) return asJson({ ok: false, error: "Эта генерация принадлежит другому юзеру." });

    let audioUrl: string | null = null;
    let coverUrl: string | null = null;
    let lyrics: string | null = null;
    let durationSec = 0;
    if (gen.type === "music" && gen.status === "done") {
      audioUrl = (gen as any).resultUrl || null;
      try {
        const rd = JSON.parse((gen as any).resultData || "{}");
        if (Array.isArray(rd.result) && rd.result[0]) {
          coverUrl = rd.result[0].image_url || null;
          lyrics = rd.result[0].lyric || null;
          durationSec = Number(rd.result[0].duration || 0) || 0;
        }
      } catch {}
    } else if (gen.type === "lyrics" && gen.status === "done") {
      lyrics = (gen as any).resultUrl || null;
    } else if (gen.type === "cover" && gen.status === "done") {
      coverUrl = (gen as any).resultUrl || null;
    }

    return asJson({
      ok: true,
      data: {
        job_id: gen.id,
        type: gen.type,
        status: gen.status,
        title: (gen as any).displayTitle || gen.prompt?.slice(0, 80) || "Без названия",
        audio_url: audioUrl,
        cover_url: coverUrl,
        lyrics_preview: lyrics ? lyrics.slice(0, 300) : null,
        lyrics_full: lyrics,
        duration_sec: durationSec,
        error_reason: gen.status === "error" ? ((gen as any).errorReason || null) : null,
      },
      hint: gen.status === "done" && gen.type === "music" && audioUrl ? `attachedJob:${gen.id}` : undefined,
    });
  },

  async list_recent_assets(input, ctx) {
    const userId = requireUserId(ctx);
    if (!userId) return asJson({ ok: false, error: "Юзер не залогинен." });
    let limit = Number(input?.limit);
    if (!Number.isFinite(limit) || limit < 1) limit = 10;
    if (limit > 30) limit = 30;
    const rows = db
      .select()
      .from(generations)
      .where(and(eq(generations.userId, userId), eq(generations.type, "music"), eq(generations.status, "done")))
      .orderBy(desc(generations.id))
      .limit(limit)
      .all();
    const items = (rows || []).map((g: any) => {
      let plays = 0;
      try { plays = JSON.parse(g.style || "{}").plays || 0; } catch {}
      return {
        id: g.id,
        title: g.displayTitle || (g.prompt || "").slice(0, 50),
        is_public: g.isPublic,
        plays,
        created_at: g.createdAt,
        audio_url: g.resultUrl,
      };
    });
    return asJson({
      ok: true,
      data: { items, count: items.length },
      message: items.length === 0 ? "У вас пока нет готовых треков." : `Найдено ${items.length} трек(ов).`,
    });
  },

  async get_asset_details(input, ctx) {
    const userId = requireUserId(ctx);
    if (!userId) return asJson({ ok: false, error: "Юзер не залогинен." });
    const id = Number(input?.asset_id);
    if (!Number.isFinite(id) || id <= 0) return asJson({ ok: false, error: "asset_id обязателен." });
    const gen = storage.getGeneration(id);
    if (!gen || gen.userId !== userId) return asJson({ ok: false, error: "Трек не найден или не принадлежит вам." });

    let coverUrl: string | null = null;
    let lyrics: string | null = null;
    let durationSec = 0;
    let plays = 0;
    let category = "song";
    try {
      const rd = JSON.parse((gen as any).resultData || "{}");
      if (Array.isArray(rd.result) && rd.result[0]) {
        coverUrl = rd.result[0].image_url || null;
        lyrics = rd.result[0].lyric || null;
        durationSec = Number(rd.result[0].duration || 0) || 0;
      }
    } catch {}
    try {
      const meta = JSON.parse(gen.style || "{}");
      plays = Number(meta.plays || 0) || 0;
      category = String(meta.category || "song");
    } catch {}

    return asJson({
      ok: true,
      data: {
        asset_id: gen.id,
        type: gen.type,
        status: gen.status,
        title: (gen as any).displayTitle || gen.prompt?.slice(0, 80) || "Без названия",
        audio_url: (gen as any).resultUrl || null,
        cover_url: coverUrl,
        lyrics_full: lyrics,
        duration_sec: durationSec,
        plays,
        category,
        is_public: gen.isPublic,
        created_at: (gen as any).createdAt,
      },
    });
  },

  async publish_asset(input, ctx) {
    const userId = requireUserId(ctx);
    if (!userId) return asJson({ ok: false, error: "Юзер не залогинен." });
    const id = Number(input?.asset_id);
    if (!Number.isFinite(id) || id <= 0) return asJson({ ok: false, error: "asset_id обязателен." });
    const visibility = String(input?.visibility || "");
    if (!["public_main", "private"].includes(visibility)) {
      return asJson({ ok: false, error: "visibility должно быть 'public_main' или 'private'." });
    }
    const confirmPublish = input?.confirm_publish === true;
    const gen = storage.getGeneration(id);
    if (!gen || gen.userId !== userId) return asJson({ ok: false, error: "Трек не найден или не принадлежит вам." });
    if (gen.status !== "done") return asJson({ ok: false, error: "Трек ещё не готов (status=" + gen.status + ")." });

    const targetIsPublic = visibility === "public_main" ? 2 : 0;
    const currentVisibility = gen.isPublic === 1 ? "main (одобренный)" : gen.isPublic === 2 ? "public_main (новые авторы)" : "private";

    if (!confirmPublish) {
      return asJson({
        ok: false,
        approval_required: true,
        tool: "publish_asset",
        params_preview: {
          asset_id: id,
          title: (gen as any).displayTitle || gen.prompt?.slice(0, 60),
          current_visibility: currentVisibility,
          new_visibility: visibility,
        },
        message: `Изменить видимость трека #${id} «${(gen as any).displayTitle || ""}» с «${currentVisibility}» на «${visibility}»?`,
      });
    }

    try {
      (db as any).$client.prepare(`UPDATE generations SET is_public = ?, published_at = COALESCE(published_at, ?) WHERE id = ? AND user_id = ?`)
        .run(targetIsPublic, new Date().toISOString(), id, userId);
    } catch (e: any) {
      return asJson({ ok: false, error: `Не удалось обновить видимость: ${e?.message || e}` });
    }

    auditTool({
      ctx,
      action: "update",
      entity: "chat_tool:publish_asset",
      entityKey: String(id),
      before: { is_public: gen.isPublic },
      after: { is_public: targetIsPublic, visibility },
    });
    return asJson({
      ok: true,
      data: { asset_id: id, new_visibility: visibility, new_is_public: targetIsPublic },
      message: `Готово. Видимость трека #${id} → «${visibility}».`,
    });
  },

  async cancel_generation_job(input, ctx) {
    const userId = requireUserId(ctx);
    if (!userId) return asJson({ ok: false, error: "Юзер не залогинен." });
    const id = Number(input?.job_id);
    if (!Number.isFinite(id) || id <= 0) return asJson({ ok: false, error: "job_id обязателен." });
    const gen = storage.getGeneration(id);
    if (!gen || gen.userId !== userId) return asJson({ ok: false, error: "Генерация не найдена или не принадлежит вам." });
    if (gen.status === "done") return asJson({ ok: false, error: "Генерация уже завершена — отменять нечего." });
    if (gen.status === "cancelled" || gen.status === "error") return asJson({ ok: false, error: `Генерация уже в статусе ${gen.status}.` });

    try {
      storage.updateGeneration(gen.id, { status: "cancelled" });
      if (gen.cost && gen.cost > 0) {
        storage.refundGeneration({
          genId: gen.id,
          userId,
          cost: gen.cost,
          type: gen.type,
          description: `Возврат: пользователь отменил генерацию #${gen.id} через чат`,
        });
      }
    } catch (e: any) {
      return asJson({ ok: false, error: `Не удалось отменить: ${e?.message || e}` });
    }
    auditTool({
      ctx,
      action: "update",
      entity: "chat_tool:cancel_generation_job",
      entityKey: String(id),
      before: { status: gen.status },
      after: { status: "cancelled", refunded: !!gen.cost },
    });
    return asJson({
      ok: true,
      data: { job_id: id, status: "cancelled", refunded: !!gen.cost && gen.cost > 0 },
      message: `Генерация #${id} отменена.${gen.cost ? " Баланс возвращён." : ""}`,
    });
  },
};
