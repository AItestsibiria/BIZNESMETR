// Единый нормализатор vocal-параметров для всех путей генерации
// (POST /api/music/generate, /api/music/regenerate/:id, /api/music/extend,
// /api/music/style-cover, admin generate-anthem, и т.д.).
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
//                                 style: 'male and female duet vocals, duet'
//                                 СОХРАНЯЕТ существующие [Male]/[Female]/[Together]
//                                 если пользователь сам их расставил в lyrics
//   voiceType == 'instrumental' → удалить ВСЕ vocal markers
//                                 добавить 'instrumental, no vocals, без вокала'
//   voiceType == 'auto'         → НИКАКИХ маркеров не добавляем; то что было
//                                 в prompt/style — остаётся; Suno сам решит.
//                                 Используется для legacy-треков и для случая
//                                 «пользователь явно ничего не выбрал».
//
// Возвращает finalPrompt + finalStyle + voiceType (нормализованный).
// ВСЕГДА логирует console.log для диагностики (PITFALLS #11/12 — видимость
// эпицентра проблемы).

export type VoiceType = "male" | "female" | "duet" | "instrumental" | "auto";

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
  voiceType: VoiceType;
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
// BACKEND-15 fix Eugene 14:27: non-capturing (?:..) вместо capturing (..)
// для защиты от ReDoS на длинных строках.
const FEMALE_MARKERS = /\b(?:female\s*vocal|female\s*voice|female\s+singer)\b|женск(?:ий|ая|ое|ие|ого)?\s*вокал|жен\.?\s*вокал/gi;
const MALE_MARKERS   = /\b(?:male\s*vocal|male\s*voice|male\s+singer)\b|мужск(?:ой|ая|ое|ие|ого)?\s*вокал|муж\.?\s*вокал/gi;
const DUET_MARKERS   = /\b(?:male\s+and\s+female\s+duet\s+vocals?|duet\s+vocals?)\b|\bduet\b|дуэт/gi;
const INSTRUMENTAL_MARKERS = /\b(?:instrumental|no\s*vocals?)\b|без\s*вокал[аеуь]?/gi;
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

function inferVoiceType(input: NormalizeInput): VoiceType {
  // Явные флаги имеют приоритет.
  if (input.instrumental === true) return "instrumental";
  if (input.isDuet === true) return "duet";

  // voiceType явный
  const vt = (input.voiceType ?? "").toString().toLowerCase().trim();
  if (vt === "male" || vt === "female" || vt === "duet" || vt === "instrumental" || vt === "auto") return vt as VoiceType;

  // voice legacy: 'male'/'female'
  const v = (input.voice ?? "").toString().toLowerCase().trim();
  if (v === "male" || v === "female") return v as VoiceType;

  // Эвристика по существующему prompt + style + lyrics. Свежие RegExp
  // на каждое сравнение — у /gi есть lastIndex, нельзя переиспользовать.
  const pool = `${input.prompt ?? ""} ${input.style ?? ""} ${input.lyrics ?? ""}`;
  const has = (re: RegExp) => new RegExp(re.source, re.flags).test(pool);
  if (has(INSTRUMENTAL_MARKERS)) return "instrumental";
  if (has(DUET_MARKERS) || has(TAG_DUET)) return "duet";
  if (has(FEMALE_MARKERS) || has(TAG_FEMALE)) return "female";
  if (has(MALE_MARKERS) || has(TAG_MALE)) return "male";

  // ТЗ Eugene 2026-05-07 §7.8: legacy-треки без voiceType — безопасный
  // fallback. НЕ дефолтим на female (это и был источник бага). Возвращаем
  // 'auto' — нормализатор не добавит маркеров, prompt/style идут как есть.
  return "auto";
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
  // должны сохраниться (ТЗ §6 «не ломать структуру»). Очищаем lyrics
  // только для не-duet режимов. Для auto — тоже не трогаем.
  if (voiceType !== "duet" && voiceType !== "auto") {
    lyrics = stripAll(lyrics, TAG_MALE, TAG_FEMALE, TAG_DUET);
  }

  // Сохраняем оригинал lyrics ДО возможной перезаписи каркасом duet.
  const originalLyrics = lyrics;

  // Добавляем правильные маркеры (с русскими дублями для надёжности —
  // Suno обучена на mixed-language тегах, RU-маркеры повышают точность).
  switch (voiceType) {
    case "male":
      style = deduplicateCommaList(`${style}, Male Vocal, male voice, мужской вокал`.replace(/^,\s*/, ""));
      if (prompt) prompt = `${prompt}\n[Male Vocal]`.trim();
      break;
    case "female":
      style = deduplicateCommaList(`${style}, Female Vocal, female voice, женский вокал`.replace(/^,\s*/, ""));
      if (prompt) prompt = `${prompt}\n[Female Vocal]`.trim();
      break;
    case "duet":
      style = deduplicateCommaList(`${style}, male and female duet vocals, duet, дуэт`.replace(/^,\s*/, ""));
      // Если в lyrics уже есть [Male] или [Female] — оставляем как есть,
      // НЕ перезаписываем (ТЗ §6: «если в prompt уже есть [Male]/[Female]/
      // [Together], не ломать структуру»). Каркас добавляем только когда
      // структура пустая.
      {
        const hasMale = new RegExp(TAG_MALE.source, TAG_MALE.flags).test(originalLyrics);
        const hasFemale = new RegExp(TAG_FEMALE.source, TAG_FEMALE.flags).test(originalLyrics);
        if (originalLyrics && !hasMale && !hasFemale) {
          lyrics = `[Male]\n${originalLyrics}\n\n[Female]\n\n[Together]\n`;
        }
      }
      break;
    case "instrumental":
      style = deduplicateCommaList(`${style}, instrumental, no vocals, без вокала`.replace(/^,\s*/, ""));
      if (prompt) prompt = `Instrumental, no vocals. ${prompt}`.trim();
      lyrics = ""; // инструментальная без текста
      break;
    case "auto":
      // Никаких маркеров не добавляем — Suno сам решит.
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
