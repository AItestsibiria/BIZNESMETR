// Eugene 2026-05-18 Босс «Negative-feedback detector».
//
// Lightweight Russian sentiment: keyword-based + emoji.
// Возвращает score -1.0..+1.0 + флаг isCritical (negative keyword +
// score < -0.5).
//
// Намеренно простой (без LLM-вызовов) чтобы был синхронным и дешёвым.
// Для нюансов — Муза (через LLM) может вызвать tool позже.

export interface SentimentResult {
  score: number;          // -1.0..+1.0
  isCritical: boolean;    // negative keyword триггернулся И score < -0.5
  triggers: string[];     // ключевые слова которые сработали (для логов / UI chips)
}

// Сильно негативные ключевые слова — сразу повышают вес.
const NEG_HARD = [
  "обман", "мошенник", "мошенники", "развод", "украл", "украли",
  "верните деньги", "верните средства", "ругаюсь", "ругатся", "пожалуюсь",
  "роспотребнадзор", "суд", "юрист", "не работает", "ужасно",
  "отстой", "позор", "разочарован",
];

// Мягко негативные.
const NEG_SOFT = [
  "плохо", "не нравится", "сложно", "медленно", "тормозит",
  "глючит", "ошибка", "баг", "не получается", "не понятно",
  "запутался", "разочаровал", "минус",
];

// Позитивные — тянут score вверх.
const POS_WORDS = [
  "спасибо", "благодарю", "отлично", "класс", "круто", "супер",
  "люблю", "лучший", "топ", "восторг", "идеально", "удобно",
];

// Эмодзи: позитивные / негативные.
// Без /u flag — TS-target в проекте не позволяет. Поиск через .includes()
// на каждый emoji (multi-byte safe в JS строках).
const POS_EMOJI_LIST = ["👍", "❤", "🔥", "💯", "😍", "🥰", "🎉", "✨", "💖"];
const NEG_EMOJI_LIST = ["😡", "😠", "💩", "🤬", "👎", "😤", "🤮", "😭"];

function hasAnyEmoji(text: string, list: string[]): boolean {
  for (const e of list) if (text.includes(e)) return true;
  return false;
}

function findMatches(text: string, list: string[]): string[] {
  const t = (text || "").toLowerCase();
  const out: string[] = [];
  for (const w of list) {
    if (t.includes(w)) out.push(w);
  }
  return out;
}

export function detectSentiment(text: string): SentimentResult {
  const triggers: string[] = [];
  let score = 0;

  const hard = findMatches(text, NEG_HARD);
  const soft = findMatches(text, NEG_SOFT);
  const pos = findMatches(text, POS_WORDS);

  for (const _w of hard) {
    score -= 0.5;
    triggers.push(_w);
  }
  for (const _w of soft) {
    score -= 0.25;
    triggers.push(_w);
  }
  for (const _w of pos) {
    score += 0.25;
    triggers.push(_w);
  }
  if (hasAnyEmoji(text, POS_EMOJI_LIST)) {
    score += 0.4;
    triggers.push("emoji:positive");
  }
  if (hasAnyEmoji(text, NEG_EMOJI_LIST)) {
    score -= 0.5;
    triggers.push("emoji:negative");
  }
  // ALL CAPS длинного текста (>20 chars) — повышение интенсивности негатива.
  if (text && text.length > 20 && text === text.toUpperCase() && /[А-ЯA-Z]/.test(text)) {
    score -= 0.2;
    triggers.push("ALL_CAPS");
  }
  // Множественные восклицания.
  if (/!{2,}/.test(text)) {
    score -= 0.15;
    triggers.push("multi_exclamation");
  }

  // Clamp.
  score = Math.max(-1, Math.min(1, score));

  const isCritical = hard.length > 0 && score < -0.5;

  return { score, isCritical, triggers };
}

// Helper для priority классификации в escalation-queue.
export function priorityFromScore(score: number, hasHardTrigger: boolean): "high" | "medium" | "low" {
  if (hasHardTrigger || score < -0.7) return "high";
  if (score < -0.3) return "medium";
  return "low";
}
