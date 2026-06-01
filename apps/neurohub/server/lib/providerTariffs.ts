// Eugene 2026-05-24 Босс «заведи агента по учёту затрат на каждого автора...
// хранит все тарифы на момент генерации. Ручной ввод стоимости генерации
// трека/обложки/текста/изображения (defaults = тарифы провайдеров)».
//
// PROVIDER TARIFFS — наши затраты (cost side), НЕ путать с PRICES (что юзер
// платит нам = revenue side из routes.ts). Версионирование через
// validFrom/validUntil — at time of generation подбираем актуальный тариф.
//
// ВАЖНО: эти числа — наши OUT-OF-POCKET costs провайдерам, не user-facing.
//   - GPTunnel /media/create Suno per track ≈ 220 ₽ (estimate, может варьироваться)
//   - Anthropic Claude Haiku 4.5: $0.80/M input + $4/M output
//   - DeepSeek Chat: $0.27/M input + $1.10/M output
//   - Yandex SpeechKit STT: ~10 ₽ за 15 сек
//   - Yandex TTS: ~5 ₽ за TTS call
//   - GPTunnel image/cover: ~50 ₽ за cover
//
// Курс USD/RUB консервативно 95 — может быть переопределён через USD_RUB_RATE env.
//
// При добавлении нового provider/resource — обязательно вписать новую запись
// с validFrom = millis (новое время) + validUntil = millis (на старой записи).
// Защищает от backward-incompatible изменений.

const USD_TO_RUB = Number(process.env.USD_RUB_RATE) || 95;

export type ProviderTariff = {
  id: string;
  provider: string;       // "gptunnel-suno" / "anthropic-haiku" / "deepseek" / "yandex-stt" / "yandex-tts" / "gptunnel-image"
  resource: string;        // "track" / "input_token" / "output_token" / "stt_sec" / "tts_call" / "image" / "lyrics_call"
  unit: string;            // "per_call" / "per_1M_tokens" / "per_15_sec" / "per_sec"
  costKopecks: number;     // наш cost в копейках (внутренний, не user price)
  validFrom: number;       // millis
  validUntil?: number;     // millis (null/undefined = current)
  notes?: string;
};

// Базовая дата отсечки (boot of project) — старше неё считаем тарифы
// действующими «с начала времён».
const EPOCH = Date.UTC(2024, 0, 1, 0, 0, 0);

export const TARIFF_HISTORY: ProviderTariff[] = [
  // ===== Suno music generation (через GPTunnel /media/create) =====
  // Базовый цикл — ~22000 копеек (220 ₽) за полный трек (V4.5).
  // Eugene 2026-05-28 Босс: реальная стоимость Suno-трека = 1-24₽ (диапазон;
  // коррекция прежней оценки 220₽). Default = 24₽ (верхняя граница, консервативно
  // для расчёта прибыли); точное значение на трек — через ручной ввод Деньги.
  {
    id: "suno_v1",
    provider: "gptunnel-suno",
    resource: "track",
    unit: "per_call",
    costKopecks: 2400,  // 24₽ (диапазон 1-24₽, Босс 2026-05-28)
    validFrom: EPOCH,
    notes: "Suno трек ≈ 1-24₽ (Босс 2026-05-28); точно — ручной ввод Деньги",
  },

  // ===== Anthropic Claude Haiku 4.5 (LLM Музы) =====
  // $0.80 / 1M input tokens
  {
    id: "anthropic_haiku45_in",
    provider: "anthropic-haiku",
    resource: "input_token",
    unit: "per_1M_tokens",
    costKopecks: Math.round(0.80 * USD_TO_RUB * 100),  // ~7600 копеек = 76₽ за 1M input
    validFrom: EPOCH,
    notes: "Claude Haiku 4.5 input pricing $0.80/1M",
  },
  // $4 / 1M output tokens
  {
    id: "anthropic_haiku45_out",
    provider: "anthropic-haiku",
    resource: "output_token",
    unit: "per_1M_tokens",
    costKopecks: Math.round(4.00 * USD_TO_RUB * 100),  // ~38000 = 380₽ за 1M output
    validFrom: EPOCH,
    notes: "Claude Haiku 4.5 output pricing $4/1M",
  },

  // ===== DeepSeek Chat (primary LLM для Музы) =====
  // $0.27 / 1M input
  {
    id: "deepseek_in",
    provider: "deepseek",
    resource: "input_token",
    unit: "per_1M_tokens",
    costKopecks: Math.round(0.27 * USD_TO_RUB * 100),  // ~2565 = 25.65₽ за 1M input
    validFrom: EPOCH,
    notes: "DeepSeek Chat input pricing $0.27/1M (primary в LLM chain)",
  },
  // $1.10 / 1M output
  {
    id: "deepseek_out",
    provider: "deepseek",
    resource: "output_token",
    unit: "per_1M_tokens",
    costKopecks: Math.round(1.10 * USD_TO_RUB * 100),  // ~10450 = 104.5₽ за 1M output
    validFrom: EPOCH,
    notes: "DeepSeek Chat output pricing $1.10/1M",
  },

  // ===== TimeWeb Gateway (PRIORITY provider Музы — LLM-chain-order rule) =====
  // Eugene 2026-05-28 Босс дал РЕАЛЬНЫЕ цены TimeWeb AI (коррекция прежних
  // Anthropic-оценок; применяется ко ВСЕЙ истории, вкл. раннюю — Босс просил
  // пересчитать затраты на трек с учётом ранней истории AI-бота):
  //   Входящие (input)  — 1 080 ₽ / 1 млн токенов
  //   Исходящие (output) — 270 ₽ / 1 млн токенов
  {
    id: "timeweb_in",
    provider: "timeweb-gateway",
    resource: "input_token",
    unit: "per_1M_tokens",
    costKopecks: 108000,  // 1080₽ за 1M input (Босс 2026-05-28)
    validFrom: EPOCH,
    notes: "TimeWeb AI input — 1080₽/1M (реальная цена, Босс 2026-05-28)",
  },
  {
    id: "timeweb_out",
    provider: "timeweb-gateway",
    resource: "output_token",
    unit: "per_1M_tokens",
    costKopecks: 27000,  // 270₽ за 1M output (Босс 2026-05-28)
    validFrom: EPOCH,
    notes: "TimeWeb AI output — 270₽/1M (реальная цена, Босс 2026-05-28)",
  },

  // ===== GPTunnel (last-resort chat) =====
  // ~$0.15/M input, $0.60/M output (gpt-4o-mini equivalent)
  {
    id: "gptunnel_chat_in",
    provider: "gptunnel-chat",
    resource: "input_token",
    unit: "per_1M_tokens",
    costKopecks: Math.round(0.15 * USD_TO_RUB * 100),
    validFrom: EPOCH,
    notes: "GPTunnel chat input ~$0.15/1M (gpt-4o-mini)",
  },
  {
    id: "gptunnel_chat_out",
    provider: "gptunnel-chat",
    resource: "output_token",
    unit: "per_1M_tokens",
    costKopecks: Math.round(0.60 * USD_TO_RUB * 100),
    validFrom: EPOCH,
    notes: "GPTunnel chat output ~$0.60/1M",
  },

  // ===== Yandex SpeechKit STT (распознавание голоса в audio-режиме) =====
  // Тариф ~1₽ за 15 сек воспроизведения = ~0.067₽ за 1 сек.
  // 10 ₽ за 15 сек = ~67 копеек за 1 секунду.
  {
    id: "yandex_stt_v1",
    provider: "yandex-stt",
    resource: "stt_sec",
    unit: "per_sec",
    costKopecks: 67,  // ~0.67₽ за 1 сек
    validFrom: EPOCH,
    notes: "Yandex SpeechKit STT ≈ 10₽/15сек = ~0.67₽/сек",
  },

  // ===== Yandex TTS (голос Музы в FAB) =====
  // ~5₽ за TTS call (средняя длина ответа Музы).
  {
    id: "yandex_tts_v1",
    provider: "yandex-tts",
    resource: "tts_call",
    unit: "per_call",
    costKopecks: 500,  // 5₽
    validFrom: EPOCH,
    notes: "Yandex TTS ≈ 5₽ за TTS call (Музa voice)",
  },

  // ===== GPTunnel image generation (cover/image) =====
  {
    id: "gptunnel_image_v1",
    provider: "gptunnel-image",
    resource: "image",
    unit: "per_call",
    costKopecks: 5000,  // 50₽
    validFrom: EPOCH,
    notes: "GPTunnel image gen ≈ 50₽ за cover/image",
  },

  // ===== Lyrics generation (через Suno API /lyrics или Anthropic) =====
  // Если генерация текста идёт через LLM — учитывается отдельно как input+output.
  // Если через Suno /lyrics — отдельный resource.
  {
    id: "suno_lyrics_v1",
    provider: "gptunnel-suno",
    resource: "lyrics_call",
    unit: "per_call",
    costKopecks: 2000,  // 20₽ за lyrics через Suno API
    validFrom: EPOCH,
    notes: "Suno /lyrics endpoint через GPTunnel ≈ 20₽",
  },
];

// ───────────────────────────────────────────────────────────────────────────
// LIVE-тарифы по API (Босс 2026-05-28 «тарифы читать по API через сервисный
// ключ»). Фоновый рефреш (lib/tariffSource.ts) тянет реальные тарифы провайдера
// по API (сервисный ключ из env) → кладёт сюда. getTariffAt предпочитает live,
// иначе — статический каталог (надёжный fallback). Деньга «берёт данные оттуда».
const liveTariffOverride = new Map<string, { costKopecks: number; at: number; source: string }>();

/** Установить live-тариф (из tariffSource по API). costKopecks для unit. */
export function setLiveTariff(provider: string, resource: string, costKopecks: number, source = "api"): void {
  if (!provider || !resource || !(costKopecks >= 0)) return;
  liveTariffOverride.set(`${provider}::${resource}`, { costKopecks, at: Date.now(), source });
}

/** Текущие live-overrides (для admin/диагностики). */
export function getLiveTariffOverrides(): Array<{ provider: string; resource: string; costKopecks: number; at: number; source: string }> {
  return Array.from(liveTariffOverride.entries()).map(([k, v]) => {
    const [provider, resource] = k.split("::");
    return { provider, resource, ...v };
  });
}

/**
 * Найти актуальный тариф на момент atTs. Приоритет: live-override (по API,
 * только для текущего момента) → статический каталог TARIFF_HISTORY.
 * Returns null если нет ни одной записи покрывающей этот момент.
 */
export function getTariffAt(provider: string, resource: string, atTs: number): ProviderTariff | null {
  const ts = Number(atTs) || Date.now();
  // Live-override применяется только к «сейчас» (исторические расчёты — по каталогу).
  const isNow = Math.abs(Date.now() - ts) < 6 * 3600 * 1000;
  if (isNow) {
    const ov = liveTariffOverride.get(`${provider}::${resource}`);
    if (ov) {
      const base = staticTariffAt(provider, resource, ts);
      return {
        id: `live_${provider}_${resource}`,
        provider, resource,
        unit: base?.unit || "per_call",
        costKopecks: ov.costKopecks,
        validFrom: ov.at,
        notes: `LIVE по API (${ov.source}) @ ${new Date(ov.at).toISOString()}`,
      };
    }
  }
  return staticTariffAt(provider, resource, ts);
}

function staticTariffAt(provider: string, resource: string, ts: number): ProviderTariff | null {
  let best: ProviderTariff | null = null;
  for (const t of TARIFF_HISTORY) {
    if (t.provider !== provider || t.resource !== resource) continue;
    if (t.validFrom > ts) continue;
    if (t.validUntil != null && t.validUntil <= ts) continue;
    // Берём самый поздний validFrom (latest applicable)
    if (!best || t.validFrom > best.validFrom) best = t;
  }
  return best;
}

/**
 * Все актуальные тарифы (на текущий момент) — для admin UI.
 */
export function getCurrentTariffs(): ProviderTariff[] {
  const now = Date.now();
  const seen = new Set<string>();
  const result: ProviderTariff[] = [];
  for (const t of TARIFF_HISTORY) {
    const key = `${t.provider}::${t.resource}`;
    if (seen.has(key)) continue;
    const actual = getTariffAt(t.provider, t.resource, now);
    if (actual) {
      seen.add(key);
      result.push(actual);
    }
  }
  return result;
}

/**
 * Estimate cost of one music generation in kopecks.
 * Без voice-specific логики — Suno tariff per call (V4.5 universal).
 * Если voice=instrumental — тот же cost (Suno считает так).
 */
export function estimateMusicCost(opts: {
  createdAtMillis: number;
  voiceType?: string | null;
}): number {
  const tariff = getTariffAt("gptunnel-suno", "track", opts.createdAtMillis);
  return tariff?.costKopecks ?? 22000;
}

/**
 * Cover/image cost estimate.
 */
export function estimateCoverCost(opts: {
  createdAtMillis: number;
}): number {
  const tariff = getTariffAt("gptunnel-image", "image", opts.createdAtMillis);
  return tariff?.costKopecks ?? 5000;
}

/**
 * Lyrics cost — fallback на Suno /lyrics endpoint.
 */
export function estimateLyricsCost(opts: {
  createdAtMillis: number;
}): number {
  const tariff = getTariffAt("gptunnel-suno", "lyrics_call", opts.createdAtMillis);
  return tariff?.costKopecks ?? 2000;
}

/**
 * Estimate cost of LLM chat call (Музa reply) в копейках.
 * Эвристика по длине сообщений:
 *   input_tokens ≈ total_text_chars / 4
 *   output_tokens ≈ assistant_reply_chars / 4
 * (стандартное приближение OpenAI/Anthropic — 1 token ≈ 4 ASCII chars / 2 Cyrillic chars)
 *
 * provider определяется так:
 *  - "anthropic"|"timeweb"|"deepseek"|"gptunnel" → берём соответствующий tariff
 *  - default — "deepseek" (PRIMARY в LLM chain)
 */
export function estimateChatCallCost(opts: {
  inputChars: number;     // суммарный размер system + history + user prompt
  outputChars: number;    // assistant reply
  createdAtMillis: number;
  provider?: string;
}): number {
  // Грубое приближение: для русского текста ~2 chars/token, для English ~4.
  // Берём усреднённое ~3 chars/token.
  const inputTokens = Math.max(0, opts.inputChars) / 3;
  const outputTokens = Math.max(0, opts.outputChars) / 3;
  const provider = String(opts.provider || "deepseek").toLowerCase();

  // Mapping provider hint → tariff provider keys
  let tariffProvider = "deepseek";
  if (provider.includes("anthropic")) tariffProvider = "anthropic-haiku";
  else if (provider.includes("timeweb")) tariffProvider = "timeweb-gateway";
  else if (provider.includes("gptunnel")) tariffProvider = "gptunnel-chat";
  else if (provider.includes("deepseek")) tariffProvider = "deepseek";

  const inT = getTariffAt(tariffProvider, "input_token", opts.createdAtMillis);
  const outT = getTariffAt(tariffProvider, "output_token", opts.createdAtMillis);
  const inCost = inT ? (inputTokens / 1_000_000) * inT.costKopecks : 0;
  const outCost = outT ? (outputTokens / 1_000_000) * outT.costKopecks : 0;
  return Math.round(inCost + outCost);
}

/**
 * TTS cost estimate (Музa voice reply).
 */
export function estimateTtsCost(opts: { createdAtMillis: number }): number {
  const t = getTariffAt("yandex-tts", "tts_call", opts.createdAtMillis);
  return t?.costKopecks ?? 500;
}

/**
 * STT cost estimate (audio-режим, юзер записал mic).
 */
export function estimateSttCost(opts: { audioDurationSec: number; createdAtMillis: number }): number {
  const t = getTariffAt("yandex-stt", "stt_sec", opts.createdAtMillis);
  const perSec = t?.costKopecks ?? 67;
  return Math.round(Math.max(0, opts.audioDurationSec) * perSec);
}

/**
 * Универсальный entry-point для generation cost (suno + lyrics + cover в одной gen
 * считаются отдельно — это helper для одной gen):
 *   gen.type='music' → music tariff
 *   gen.type='lyrics' → lyrics tariff
 *   gen.type='cover'/'audio_cover' → suno (через cover endpoint всё равно Suno billing) + image
 *
 * Если у gen есть прикреплённая cover (coverGenId) — она считается отдельной gen
 * и должна вызываться отдельным estimateGenerationCost вызовом.
 */
export function estimateGenerationCost(gen: {
  type: string;
  createdAtMillis: number;
  voiceType?: string | null;
}): number {
  const t = String(gen.type || "music").toLowerCase();
  if (t === "music") {
    return estimateMusicCost({ createdAtMillis: gen.createdAtMillis, voiceType: gen.voiceType });
  }
  if (t === "lyrics") {
    return estimateLyricsCost({ createdAtMillis: gen.createdAtMillis });
  }
  if (t === "cover" || t === "audio_cover") {
    return estimateCoverCost({ createdAtMillis: gen.createdAtMillis });
  }
  // unknown — fallback на music (worst case)
  return estimateMusicCost({ createdAtMillis: gen.createdAtMillis, voiceType: null });
}

/**
 * Helper: parse text-only date column from БД (text ISO или unix-millis) → millis.
 */
export function toMillis(raw: unknown): number {
  if (raw == null) return 0;
  if (typeof raw === "number") return raw;
  const s = String(raw);
  if (/^\d+$/.test(s)) return Number(s);
  const parsed = Date.parse(s);
  return Number.isFinite(parsed) ? parsed : 0;
}
