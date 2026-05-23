// Eugene 2026-05-23 — Risk #12 fix.
// Tools работают ТОЛЬКО на Anthropic-шаге llmCore.ts chain (DeepSeek/TimeWeb/
// GPTunnel — text-only). Если user-text имеет player/panel/generation intent —
// этот router помечает запрос как «нужны tools» → llmCore пропускает DeepSeek+
// TimeWeb и идёт сразу на Anthropic.
//
// Цена: 5-15% запросов (с intent) идут на дорогой Anthropic; остальные 85-95% —
// на дешёвый DeepSeek. Это сохраняет cost-оптимизацию из Eugene 2026-05-21
// reorder и одновременно закрывает «99% генерации через чат».

const PLAYER_CONTROL = /(постав|включ|воспроизвед|сыграй|запусти|играй)\s+(?:трек|песн|музык|мелоди|композ|плейлист)|^(?:плей|play)\b/i;
const PLAYER_TRANSPORT = /(пауз|останов(?:и|ить)|стоп\s+(?:трек|песн|музык|плеер)|пропусти|следующ(?:ий|ая)|предыдущ(?:ий|ая)|переключи|перемотай|next track|prev track)/i;
const PLAYER_VOLUME = /(громч|тише|сделай (?:тише|громче)|приглуш|убавь|прибавь|volume)/i;
const PLAYER_SEARCH = /(найди (?:трек|песн|музык)|трек\s+про|песн[яею]\s+про|есть\s+(?:что|какой)\s+(?:то|нибудь)\s+про|поищи\s+(?:трек|песн))/i;
const PLAYER_REPEAT = /(повтор|зацикл|по\s+кругу|repeat)/i;

const GENERATION_INTENT = /(созда[йи]|сделай|сгенери(?:руй|ри)|напиши|сочини|подари|нужн[аы]?)\s+(?:песн|трек|музык|кавер|обложк|лирик|текст)/i;
const GENERATION_WANT = /(хочу|хочется|надо|нужн[оа])\s+(?:песн|трек|обложк|текст|лирик|подар)/i;
const GENERATION_OCCASION = /(на\s+(?:день\s+рожден|др|годовщин|свадьб|юбилей|выпускн|новый\s+год|8\s+март|23\s+феврал))/i;

const PANEL_OPEN = /(откро[йи]|открой\s+(?:кабинет|плейлист|обложк|настройк|треки|мою|музык|форму)|перейд[ии]\s+(?:в|на)|покаж[ии]\s+(?:мою|мне|мои))/i;
const PANEL_ENTITY = /(мой\s+(?:кабинет|плейлист|баланс)|мои\s+(?:треки|обложки|тексты)|моя\s+(?:музыка|страница))/i;

const ASSET_MGMT = /(переименуй|сме[нне]и\s+(?:категори|настройк)|опубликуй|скрой|спрячь|удали\s+(?:трек|песн|обложк)|сделай\s+(?:приват|публич))/i;
const PROFILE_UPDATE = /(сме[нне]и\s+(?:имя|телефон|email|почт)|обнови\s+(?:профиль|данные))/i;

const APPROVAL_CONFIRM = /(\bда\b[\s,.!]*(?:подтвер|запуска|применя|готов|давай|жми|поехали)|подтверждаю|применяй|^(?:да|yes|ok|ок)\b[\s,.!]*$|confirm_(?:spend|publish))/i;
const APPROVAL_DENY = /(\b(?:нет|отмена|стоп|отбой|отказ|cancel)\b)/i;

const BALANCE_QUERY = /((?:мой|какой)\s+(?:баланс|счёт|остаток)|сколько\s+(?:у\s+меня|денег|треков|осталось)|посмотри\s+(?:баланс|сколько))/i;
const TRACK_QUERY = /(мои\s+треки|сколько\s+у\s+меня\s+(?:треков|песен)|показать\s+(?:мои|мне)\s+(?:треки|песни))/i;

const INVOICE = /(выпиши\s+счёт|оформи\s+(?:оплат|счёт)|пополни\s+(?:баланс|счёт)|купить\s+(?:тариф|подписк|премиум))/i;

const PATTERNS = [
  PLAYER_CONTROL, PLAYER_TRANSPORT, PLAYER_VOLUME, PLAYER_SEARCH, PLAYER_REPEAT,
  GENERATION_INTENT, GENERATION_WANT, GENERATION_OCCASION,
  PANEL_OPEN, PANEL_ENTITY,
  ASSET_MGMT, PROFILE_UPDATE,
  APPROVAL_CONFIRM, APPROVAL_DENY,
  BALANCE_QUERY, TRACK_QUERY,
  INVOICE,
];

export function detectMuzaToolIntent(text: string): boolean {
  if (!text || typeof text !== "string") return false;
  const t = text.trim();
  if (t.length === 0) return false;
  for (const re of PATTERNS) {
    if (re.test(t)) return true;
  }
  return false;
}

export function classifyMuzaIntent(text: string): {
  hasIntent: boolean;
  category: "player" | "generation" | "panel" | "asset" | "approval" | "query" | "invoice" | null;
} {
  if (!text) return { hasIntent: false, category: null };
  const t = text.trim();
  if (PLAYER_CONTROL.test(t) || PLAYER_TRANSPORT.test(t) || PLAYER_VOLUME.test(t) || PLAYER_SEARCH.test(t) || PLAYER_REPEAT.test(t)) {
    return { hasIntent: true, category: "player" };
  }
  if (GENERATION_INTENT.test(t) || GENERATION_WANT.test(t) || GENERATION_OCCASION.test(t)) {
    return { hasIntent: true, category: "generation" };
  }
  if (PANEL_OPEN.test(t) || PANEL_ENTITY.test(t)) {
    return { hasIntent: true, category: "panel" };
  }
  if (ASSET_MGMT.test(t) || PROFILE_UPDATE.test(t)) {
    return { hasIntent: true, category: "asset" };
  }
  if (APPROVAL_CONFIRM.test(t) || APPROVAL_DENY.test(t)) {
    return { hasIntent: true, category: "approval" };
  }
  if (BALANCE_QUERY.test(t) || TRACK_QUERY.test(t)) {
    return { hasIntent: true, category: "query" };
  }
  if (INVOICE.test(t)) {
    return { hasIntent: true, category: "invoice" };
  }
  return { hasIntent: false, category: null };
}
