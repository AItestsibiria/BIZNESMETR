// Eugene 2026-05-24 Босс «fine-tuned model + premium tier — для качества лирики».
//
// Real Anthropic fine-tuning публично закрыт. Здесь — multi-step refinement
// pipeline, который даёт quality up через 4 последовательных LLM-вызова:
//
//   Step 1 — Draft   : первый draft 12-16 строк (как обычная генерация)
//   Step 2 — Critique: self-critique, найти 3 слабых места
//   Step 3 — Refine  : переписать слабые места, ярче / точнее / эмоциональнее
//   Step 4 — Polish  : финальная проверка размера/ритма + correction
//
// Cost ≈ 3x normal (4 LLM calls вместо 1). Pricing для юзера: 149 ₽ one-off
// (PRICES.premium_lyrics_oneoff) или включено в подписку tier='text_quality'.
//
// Reuse-working-solutions rule: используем callDeepSeek (PRIMARY, дешевый) +
// callTimeWebGateway (fallback). Anthropic — последний резерв. БЕЗ tools —
// здесь чистая generation, никаких action-calls.
//
// Pricing-single-source rule: цены тут НЕ хранятся, только sanity log.
// PRICES.premium_lyrics_oneoff = 14900 живёт в routes.ts вместе с music/lyrics.

import { callDeepSeek, callTimeWebGateway, listAnthropicKeys, setLLMKeyStatus } from "./llmCore";

export type PremiumLyricsInput = {
  prompt: string;
  style?: string;
  mood?: string;
  important_words?: string[];
  language?: "ru" | "en";
};

export type PremiumLyricsResult = {
  ok: boolean;
  lyrics?: string;
  iterations?: number;
  steps_used?: string[];
  error?: string;
  draft?: string;        // диагностический dump — первый draft
  critique?: string;     // диагностический dump — критика
};

// Внутренний helper: один LLM call через chain (DeepSeek → TimeWeb → Anthropic).
// БЕЗ tools, БЕЗ history (premium-pipeline самодостаточный).
async function callLLM(systemPrompt: string, userText: string, maxTokens: number): Promise<string | null> {
  // 1) DeepSeek (PRIMARY — cheap)
  try {
    const r = await callDeepSeek({ systemPrompt, history: [], userText, maxTokens });
    if (r.text && r.text.trim()) return r.text.trim();
  } catch (e) {
    console.warn("[PREMIUM-LYRICS] DeepSeek failed:", String((e as any)?.message || e).slice(0, 200));
  }

  // 2) TimeWeb (fallback 1)
  try {
    const r = await callTimeWebGateway({
      systemPrompt,
      history: [],
      userText,
      maxTokens,
      model: process.env.TIMEWEB_LYRICS_MODEL || "claude-haiku-4-5-20251001",
    });
    if (r.text && r.text.trim()) return r.text.trim();
  } catch (e) {
    console.warn("[PREMIUM-LYRICS] TimeWeb failed:", String((e as any)?.message || e).slice(0, 200));
  }

  // 3) Anthropic chain (fallback 2 — last resort, дороже)
  const keys = listAnthropicKeys();
  for (const k of keys) {
    try {
      const r = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "x-api-key": k.key,
          "anthropic-version": "2023-06-01",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: "claude-haiku-4-5-20251001",
          max_tokens: Math.min(maxTokens, 2000),
          system: systemPrompt,
          messages: [{ role: "user", content: userText }],
          temperature: 0.85,
        }),
        signal: AbortSignal.timeout(30_000),
      });
      setLLMKeyStatus(k.name, { lastUsedAt: new Date().toISOString(), lastStatus: r.status });
      if (!r.ok) continue;
      const j: any = await r.json();
      const blocks = Array.isArray(j?.content) ? j.content : [];
      const textBlock = blocks.find((b: any) => b?.type === "text");
      const text = String(textBlock?.text || "").trim();
      if (text) return text;
    } catch (e) {
      console.warn(`[PREMIUM-LYRICS] Anthropic ${k.name} failed:`, String((e as any)?.message || e).slice(0, 200));
      continue;
    }
  }

  return null;
}

/**
 * 4-step premium lyrics generation pipeline.
 *
 * Возвращает обогащённый текст после Draft → Critique → Refine → Polish.
 * Если хоть один шаг даёт null — fallback на лучший доступный результат
 * (draft если упал critique; draft+refine если упал polish). Полностью
 * прозрачно через `steps_used` для админа.
 */
export async function generatePremiumDraft(input: PremiumLyricsInput): Promise<PremiumLyricsResult> {
  const lang = input.language === "en" ? "en" : "ru";
  const style = (input.style || "поп").trim().slice(0, 80);
  const mood = (input.mood || "нейтральное").trim().slice(0, 80);
  const importantWords = Array.isArray(input.important_words)
    ? input.important_words.filter(w => typeof w === "string" && w.trim()).slice(0, 12)
    : [];
  const prompt = String(input.prompt || "").trim().slice(0, 1500);

  if (!prompt) return { ok: false, error: "Опиши тему песни — без неё premium draft не построю." };

  const stepsUsed: string[] = [];
  const langName = lang === "ru" ? "русском" : "английском";
  const importantBlock = importantWords.length
    ? `\nВАЖНЫЕ СЛОВА (встрой ЕСТЕСТВЕННО в текст, через образы а не списком): ${importantWords.join(", ")}.`
    : "";

  // === Step 1: Draft ===
  const draftSystem = `Ты — Музa, профессиональный автор-песенник. Пиши на ${langName} языке.
Стиль: ${style}. Настроение: ${mood}.
Формат текста: [Куплет 1], [Припев], [Куплет 2], [Бридж], [Припев].
Объём: 12-16 строк. Размер: 5-8 слогов на строку.${importantBlock}
ВАЖНО: только текст песни — без пояснений, без вступления, без подписи.`;

  const draft = await callLLM(draftSystem, prompt, 600);
  if (!draft) return { ok: false, error: "LLM-провайдеры недоступны на шаге Draft. Попробуй через минуту." };
  stepsUsed.push("draft");

  // === Step 2: Self-critique ===
  const critiqueSystem = `Ты — строгий редактор песенных текстов. Получишь готовый текст — найди РОВНО 3 слабых места.
Что проверять:
1. Клише и штампы (есть ли заезженные фразы типа «свет в окне», «дождь за окном»)
2. Размер / ритм (есть ли строки которые рваные, не ложатся в музыку)
3. Эмоция (есть ли строки которые звучат плоско, без чувства)
4. Естественность встраивания ключевых слов (не торчат ли они списком)
5. Связность образов (не прыгает ли смысл между куплетами)

Ответь СТРОГО в формате:
СЛАБОЕ_МЕСТО_1: <конкретная цитата строки или фрагмента>
ПРОБЛЕМА_1: <в одном предложении что не так>
СЛАБОЕ_МЕСТО_2: ...
ПРОБЛЕМА_2: ...
СЛАБОЕ_МЕСТО_3: ...
ПРОБЛЕМА_3: ...

Никаких предисловий, никаких советов «что исправить» — только проблемы.`;

  const critique = await callLLM(critiqueSystem, draft, 400);
  if (!critique) {
    // Graceful degrade: возвращаем draft как есть (юзер заплатил за premium —
    // дадим лучшее что смогли получить).
    return {
      ok: true,
      lyrics: draft,
      iterations: 1,
      steps_used: stepsUsed,
      draft,
      error: "Critique-шаг недоступен — выдан draft без refinement.",
    };
  }
  stepsUsed.push("critique");

  // === Step 3: Refine ===
  const refineSystem = `Ты — Музa, переписываешь песенный текст по найденным замечаниям.
Получишь:
1) Исходный текст
2) Список 3 слабых мест с проблемами

Перепиши ВЕСЬ текст целиком (12-16 строк), исправив указанные проблемы:
- Замени клише на свежие образы
- Восстанови размер / ритм
- Добавь эмоциональной глубины — конкретные детали, не общие слова
- Сохрани структуру [Куплет/Припев/Бридж]
- Сохрани ключевые слова из исходного брифа${importantBlock}
- Стиль: ${style}. Настроение: ${mood}.

ВАЖНО: только новый текст — без объяснений «что я изменил».`;

  const refinedInput = `=== ИСХОДНЫЙ ТЕКСТ ===\n${draft}\n\n=== НАЙДЕННЫЕ СЛАБОСТИ ===\n${critique}`;
  const refined = await callLLM(refineSystem, refinedInput, 700);
  if (!refined) {
    return {
      ok: true,
      lyrics: draft,
      iterations: 2,
      steps_used: stepsUsed,
      draft,
      critique,
      error: "Refine-шаг недоступен — выдан draft + critique без переписи.",
    };
  }
  stepsUsed.push("refine");

  // === Step 4: Final polish ===
  const polishSystem = `Ты — Музa на финальной полировке песенного текста.
Получишь почти готовый текст. Проверь:
1. Размер строк (все ли строки укладываются 5-8 слогов? Если есть рваная — поправь)
2. Рифма (каждый куплет имеет хотя бы AABB или ABAB — если нет, поправь концы строк)
3. Нет ли остатков «технического» языка (типа «[пояснение]», «прим.»)
4. Тэги секций [Куплет 1] / [Припев] / [Куплет 2] / [Бридж] на своих местах
5. Текст не длиннее 16 строк всего (включая припевы)

Выдай ФИНАЛЬНЫЙ текст. Если правок не требовалось — выдай как есть. Только текст, без комментариев.`;

  const polished = await callLLM(polishSystem, refined, 700);
  const finalText = polished || refined;
  if (polished) stepsUsed.push("polish");

  // Sanity: жёсткое ограничение для Suno (400 символов).
  // Premium pipeline иногда даёт длиннее — обрезаем по последней целой строке.
  let lyrics = finalText;
  if (lyrics.length > 400) {
    const trimmed = lyrics.slice(0, 400);
    const lastNewline = trimmed.lastIndexOf("\n");
    lyrics = lastNewline > 200 ? trimmed.slice(0, lastNewline) : trimmed;
  }

  console.log(`[PREMIUM-LYRICS] ok | steps=${stepsUsed.join("→")} | chars=${lyrics.length} | lang=${lang}`);

  return {
    ok: true,
    lyrics,
    iterations: stepsUsed.length,
    steps_used: stepsUsed,
    draft,
    critique,
  };
}

/**
 * Проверка активности подписки tier='text_quality' для юзера.
 * Возвращает true если есть active + не истёкшая подписка.
 *
 * Reuse-working-solutions rule: используется тот же pattern что для
 * audio_premium_only в chatbot_messages (см. routes.ts TARIFF_TO_TIER).
 */
export function isPremiumTextQualityActive(sqliteDb: any, userId: number): boolean {
  if (!userId) return false;
  try {
    const row: any = sqliteDb.prepare(`
      SELECT id, expires_at, status FROM premium_subscriptions
      WHERE user_id = ? AND tier = 'text_quality' AND status = 'active'
      ORDER BY id DESC LIMIT 1
    `).get(userId);
    if (!row) return false;
    if (!row.expires_at) return true;
    return new Date(row.expires_at).getTime() > Date.now();
  } catch (e) {
    console.warn("[PREMIUM-LYRICS] isPremiumTextQualityActive error:", e);
    return false;
  }
}
