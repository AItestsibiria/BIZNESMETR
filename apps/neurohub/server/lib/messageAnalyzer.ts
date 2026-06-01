// Eugene 2026-05-18 Босс «Auto-analysis после каждого сообщения».
//
// Анализ user-message: sentiment + intent + topic + operator-mention.
// Sync, без LLM-вызовов (keyword + regex), дёшево.
// Используется plugin'ом message-analysis для логирования каждой реплики
// в `message_analysis` таблицу.
//
// Sentiment делегируется в existing sentimentDetector.detectSentiment().
// Intent / topic — keyword matching (lowercase + regex).
// mentionsOperator — same pattern as yarsDetect.ts (word-boundary aware
// for cyrillic via lookaround).

import { detectSentiment } from "./sentimentDetector";

export interface AnalysisResult {
  sentiment: { score: number; label: string; triggers: string[] };
  intent: string;
  topic: string;
  mentionsOperator: boolean;
}

// === Intent patterns ===
// Каждое регулярное выражение — отдельный intent. Порядок проверки имеет
// значение (первое матчившееся выигрывает). Complaint раньше других
// потому что critical sentiment перевешивает greeting/gratitude в тексте.

const INTENT_PATTERNS: { name: string; re: RegExp }[] = [
  { name: "want_generate", re: /создай|сгенерируй|давай (сделаем|делай|погнали|готов)|хочу песн|сделай (мне |нам )?(песн|трек|кавер)|погнали/i },
  { name: "ask_pricing", re: /цен[аы]|стоимость|сколько стоит|тариф|бесплатно/i },
  { name: "leave_feedback", re: /оценка|оценить|nps|рекомендую|рекомендация|отзыв/i },
  { name: "gratitude", re: /спасибо|благодарю|респект|благодарность/i },
  { name: "greeting", re: /^(?:\s*)(привет|здравствуй|доброе утро|добрый (день|вечер)|hi|hello|здарова|здоров)/i },
];

// Complaint — отдельный кейс: либо явные слова, либо critical sentiment
// (определяется ниже после sentiment detection).
const COMPLAINT_RE = /не работает|жалоб|верните|обманул|развод|ужасн|не получил|сломалось|глюч/i;

// === Topic patterns ===

const TOPIC_PATTERNS: { name: string; re: RegExp }[] = [
  { name: "payment", re: /оплат|карт[ау]|сбп|перевод|чек|деньги|стоимость|тариф/i },
  { name: "account", re: /кабинет|аккаунт|войти|логин|регистраци|пароль|email|почт/i },
  { name: "music", re: /трек|песн|музык|обложк|стил|жанр|кавер|вокал|инструмент/i },
  { name: "support", re: /техподдержк|помощь|помоги|не получается|не понятно|проблем/i },
  { name: "personal", re: /меня зовут|я работаю|моя дочь|мой сын|жен[аы]|муж[уеа]|мам[аы]|пап[аы]/i },
];

// === Operator mention ===
// «Оператор» / «менеджер» / «человек» / «живой» / «ярс» — все паттерны
// которые указывают что юзер хочет говорить с человеком, а не с ботом.
// Word boundary через lookaround (как в yarsDetect.ts) для русских слов.

const OPERATOR_RE =
  /(?:^|[^\p{L}\p{N}_])(оператор[а-я]*|менеджер[а-я]*|человек[а-я]*|живой|живого|поддержк[а-я]+|админ[а-я]*|ярс|yars)(?=$|[^\p{L}\p{N}_])/iu;

function detectIntent(text: string, sentimentIsCritical: boolean): string {
  if (sentimentIsCritical || COMPLAINT_RE.test(text)) return "complaint";
  for (const p of INTENT_PATTERNS) {
    if (p.re.test(text)) return p.name;
  }
  return "other";
}

function detectTopic(text: string): string {
  for (const p of TOPIC_PATTERNS) {
    if (p.re.test(text)) return p.name;
  }
  return "other";
}

function labelFromScore(score: number, isCritical: boolean): string {
  if (isCritical) return "critical";
  if (score <= -0.3) return "negative";
  if (score >= 0.3) return "positive";
  return "neutral";
}

export function analyzeMessage(text: string): AnalysisResult {
  const sentiment = detectSentiment(text || "");
  const intent = detectIntent(text || "", sentiment.isCritical);
  const topic = detectTopic(text || "");
  const mentionsOperator = OPERATOR_RE.test(text || "");
  return {
    sentiment: {
      score: sentiment.score,
      label: labelFromScore(sentiment.score, sentiment.isCritical),
      triggers: sentiment.triggers,
    },
    intent,
    topic,
    mentionsOperator,
  };
}
