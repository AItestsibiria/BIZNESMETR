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
