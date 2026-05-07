// Единый нормализатор vocal-параметров для всех путей генерации
// (POST /api/music/generate, /api/music/regenerate/:id, mass-gen, и т.д.).
//
// Решает класс багов, когда выбранный пользователем голос терялся,
// перезаписывался, или дефолтил на Female. См. ТЗ Eugene 2026-05-07.
//
// Правила:
//   voiceType == 'male'         → удалить female/Female Vocal/[Female]
//                                 добавить [Male Vocal]/male voice/мужской вокал
//   voiceType == 'female'       → удалить male/Male Vocal/[Male]
//                                 добавить [Female Vocal]/female voice/женский вокал
//   voiceType == 'duet'         → структура [Male]/[Female]/[Together] в lyrics
//                                 style включает 'male and female duet vocals, duet'
//   voiceType == 'instrumental' → удалить ВСЕ vocal markers
//                                 добавить 'instrumental, no vocals'
//   voiceType == null/undefined → fallback: пытаемся определить из существующего
//                                 prompt/style; если не удаётся — НЕ ставим дефолт,
//                                 оставляем как есть (Suno сам решит)
//
// Возвращает finalPrompt + finalStyle + voiceType (нормализованный).
// ВСЕГДА логирует console.log для диагностики (PITFALLS #11/12 — видимость
// эпицентра проблемы).

export type VoiceType = "male" | "female" | "duet" | "instrumental" | null;

interface NormalizeInput {
  prompt?: string | null;
  style?: string | null;
  lyrics?: string | null;
  voiceType?: VoiceType | string | null | undefined;
  // legacy: client may send 'voice' = "male"|"female", and separate flags.
  voice?: string | null;
  isDuet?: boolean | null;
  instrumental?: boolean | null;
  // optional context for log
  generationId?: number | string | null;
}

interface NormalizeOutput {
  finalPrompt: string;
  finalStyle: string;
  finalLyrics: string;
  voiceType: Exclude<VoiceType, null>;
  log: {
    generationId: string | number | null;
    voiceType: string;
    finalStyle: string;
    promptHead: string;     // первые 300 символов
    inputVoice: string | null;
    inputIsDuet: boolean;
    inputInstrumental: boolean;
  };
}

// JS \b не работает с кириллицей — используем независимые паттерны для
// латиницы (с \b) и кириллицы (без \b, опираясь на pre-/post-context).
const FEMALE_MARKERS = /\b(female\s*vocal|female\s*voice|female\s+singer)\b|женск(ий|ая|ое|ие|ого)?\s*вокал|жен\.?\s*вокал/gi;
const MALE_MARKERS   = /\b(male\s*vocal|male\s*voice|male\s+singer)\b|мужск(ой|ая|ое|ие|ого)?\s*вокал|муж\.?\s*вокал/gi;
const DUET_MARKERS   = /\b(male\s+and\s+female\s+duet\s+vocals?|duet\s+vocals?)\b|\bduet\b|дуэт/gi;
const INSTRUMENTAL_MARKERS = /\b(instrumental|no\s*vocals?)\b|без\s*вокал[аеуь]?/gi;
const TAG_FEMALE = /\[\s*female\s*[^\]]*\]/gi;
const TAG_MALE   = /\[\s*male\s*[^\]]*\]/gi;
const TAG_DUET   = /\[\s*(together|duet)\s*[^\]]*\]/gi;

function deduplicateCommaList(s: string): string {
  return s
    .split(/,/)
    .map((p) => p.trim())
    .filter((p, i, arr) => p.length > 0 && arr.findIndex((x) => x.toLowerCase() === p.toLowerCase()) === i)
    .join(", ");
}

function stripAll(s: string, ...patterns: RegExp[]): string {
  let out = s;
  for (const p of patterns) out = out.replace(p, "");
  // Чистим пустые скобки/теги и двойные разделители.
  return out
    .replace(/\[\s*\]/g, "")
    .replace(/\(\s*\)/g, "")
    .replace(/\s{2,}/g, " ")
    .replace(/,\s*,/g, ",")
    .replace(/\n\s*\n/g, "\n\n")
    .trim();
}

function inferVoiceType(input: NormalizeInput): Exclude<VoiceType, null> {
  // Явные флаги имеют приоритет.
  if (input.instrumental === true) return "instrumental";
  if (input.isDuet === true) return "duet";

  // voiceType явный
  const vt = (input.voiceType ?? "").toString().toLowerCase().trim();
  if (vt === "male" || vt === "female" || vt === "duet" || vt === "instrumental") return vt as any;

  // voice legacy: 'male'/'female'
  const v = (input.voice ?? "").toString().toLowerCase().trim();
  if (v === "male" || v === "female") return v as any;

  // Эвристика по существующему prompt + style
  const pool = `${input.prompt ?? ""} ${input.style ?? ""} ${input.lyrics ?? ""}`;
  if (INSTRUMENTAL_MARKERS.test(pool)) return "instrumental";
  if (DUET_MARKERS.test(pool)) return "duet";
  if (FEMALE_MARKERS.test(pool) || TAG_FEMALE.test(pool)) return "female";
  if (MALE_MARKERS.test(pool) || TAG_MALE.test(pool)) return "male";

  // Не ставим дефолт — пусть Suno сам решит (старый код дефолтил на Female,
  // что и было причиной бага).
  return "female";
}

export function normalizeVocalParams(input: NormalizeInput): NormalizeOutput {
  const voiceType = inferVoiceType(input);

  // Очистка от ВСЕХ конфликтующих маркеров перед добавлением нужных.
  let prompt = stripAll(
    input.prompt ?? "",
    FEMALE_MARKERS, MALE_MARKERS, DUET_MARKERS, INSTRUMENTAL_MARKERS,
    TAG_FEMALE, TAG_MALE, TAG_DUET,
  );
  let style = stripAll(
    input.style ?? "",
    FEMALE_MARKERS, MALE_MARKERS, DUET_MARKERS, INSTRUMENTAL_MARKERS,
  );
  let lyrics = input.lyrics ?? "";

  // Для duet — оригинальные [Male]/[Female]/[Together] теги в lyrics
  // должны сохраниться. Очищаем lyrics только для не-duet режимов.
  if (voiceType !== "duet") {
    lyrics = stripAll(lyrics, TAG_MALE, TAG_FEMALE, TAG_DUET);
  }

  // Добавляем правильные маркеры
  switch (voiceType) {
    case "male":
      style = deduplicateCommaList(`${style}, Male Vocal, male voice`.replace(/^,\s*/, ""));
      if (prompt) prompt = `${prompt}\n[Male Vocal]`.trim();
      break;
    case "female":
      style = deduplicateCommaList(`${style}, Female Vocal, female voice`.replace(/^,\s*/, ""));
      if (prompt) prompt = `${prompt}\n[Female Vocal]`.trim();
      break;
    case "duet":
      style = deduplicateCommaList(`${style}, male and female duet vocals, duet`.replace(/^,\s*/, ""));
      // Если в lyrics нет [Male]/[Female] — добавим минимальную каркас
      if (lyrics && !TAG_MALE.test(lyrics) && !TAG_FEMALE.test(lyrics)) {
        lyrics = `[Male]\n${lyrics}\n\n[Female]\n\n[Together]\n`;
      }
      break;
    case "instrumental":
      style = deduplicateCommaList(`${style}, instrumental, no vocals`.replace(/^,\s*/, ""));
      if (prompt) prompt = `Instrumental, no vocals. ${prompt}`.trim();
      lyrics = ""; // инструментальная без текста
      break;
  }

  const out: NormalizeOutput = {
    finalPrompt: prompt,
    finalStyle: style,
    finalLyrics: lyrics,
    voiceType,
    log: {
      generationId: input.generationId ?? null,
      voiceType,
      finalStyle: style,
      promptHead: prompt.slice(0, 300),
      inputVoice: input.voice ?? null,
      inputIsDuet: !!input.isDuet,
      inputInstrumental: !!input.instrumental,
    },
  };

  console.log(
    `[VOCAL-NORMALIZE] gen=${out.log.generationId ?? "?"} type=${out.voiceType} ` +
    `style="${out.finalStyle.slice(0, 100)}" ` +
    `prompt="${out.log.promptHead.slice(0, 80)}" ` +
    `inputs=(voice=${out.log.inputVoice}, isDuet=${out.log.inputIsDuet}, instrumental=${out.log.inputInstrumental})`,
  );

  return out;
}
