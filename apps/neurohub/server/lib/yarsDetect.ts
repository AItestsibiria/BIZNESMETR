// Eugene 2026-05-17 Босс «расширь логирование + alert при упоминании Ярс».
// «Ярс» — nickname Eugene (основатель MuzaAi). Детектим в любом канале
// (telegram-bot, max-bot, web-chat), записываем в `yars_mentions`,
// шлём админу Telegram-alert (rate-limit 1/5min per session).
//
// Использование:
//   import { detectsYars } from "@/server/lib/yarsDetect";
//   if (detectsYars(text)) { ... }
//
// Допустимые варианты:
//   - "Ярс" / "ярс" / "Yars" / "yars" (любой регистр)
//   - В начале / середине / конце сообщения, с обращением ("Привет Ярс")
//   - С пунктуацией вокруг: «Ярс, диагностируй» / «Ярс!» / «(ярс)»
//
// НЕ срабатывает на:
//   - подстроки внутри слов: ярсаул, ярси, краснярск (word boundary)
//   - кириллица: \b у JS работает только по [A-Za-z0-9_], поэтому для
//     русского варианта используем lookaround на символы, которые НЕ часть
//     слова (start/end строки, пробел, пунктуация).

const YARS_REGEX = /(?:^|[^\p{L}\p{N}_])(ярс|yars)(?=$|[^\p{L}\p{N}_])/iu;

export function detectsYars(text: string | null | undefined): boolean {
  if (!text) return false;
  return YARS_REGEX.test(text);
}

export type YarsChannel = "web" | "telegram" | "max" | string;

export interface RecordYarsMentionInput {
  sessionId: string;
  userId: number | null;
  channel: YarsChannel;
  text: string;
}

/**
 * Sync-запись в `yars_mentions` + console log. Никогда не throw'ит —
 * detection не должен ломать вызывающий код.
 *
 * Также инициирует Telegram-alert админу (async, rate-limited).
 */
export function recordYarsMention(input: RecordYarsMentionInput): void {
  try {
    // Lazy-require, чтобы избежать circular imports на module load.
    // (yarsDetect.ts → storage.ts → schema.ts → … достаточно глубоко)
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { db } = require("../storage");
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { yarsMentions } = require("@shared/schema");
    db.insert(yarsMentions).values({
      sessionId: String(input.sessionId).slice(0, 100),
      userId: input.userId ?? null,
      channel: String(input.channel || "unknown").slice(0, 30),
      text: String(input.text || "").slice(0, 2000),
    }).run();
  } catch {
    // Не ломаем вызывающий код.
  }
  // Fire-and-forget Telegram alert.
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { sendYarsAlert } = require("./yarsAlert");
    sendYarsAlert(input);
  } catch {
    // Не ломаем.
  }
}
