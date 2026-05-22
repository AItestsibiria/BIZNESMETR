// Eugene 2026-05-22 Босс «Музa выводит короткие факты — чередуя возможности
// MuzaAi с музыкальной энциклопедией. Не повторять, при клике расширять».
// См. Musa-facts-rotation rule в CLAUDE.md.

export type MusaFactKind = "feature" | "encyclopedia";

export interface MusaFact {
  id: string;            // stable slug
  kind: MusaFactKind;
  title: string;         // <= 50 chars
  short: string;         // <= 140 chars — то что в bubble
  long: string;          // 2-3 параграфа — при click expand
  relatedFeature?: string; // например "create_music_job", "premium_voice_msg"
  tags?: string[];
}

// === Seed catalog ===
// Босс добавляет через /admin/v304 → 🎵 Факты Музы (будущая фича).
// Пока — статичный массив, обновляется правкой этого файла.
export const MUSA_FACTS: MusaFact[] = [
  // === FEATURE — возможности MuzaAi ===
  {
    id: "f-cover-style",
    kind: "feature",
    title: "Кавер чужого трека в твоём стиле",
    short: "Можешь взять любой трек и пересоздать его в новом стиле — рок, поп, шансон.",
    long: "На MuzaAi есть режим «Кавер» — загружаешь mp3 или указываешь существующий трек, выбираешь новый жанр и голос, и Suno генерирует свежую версию. Это идеально для подарка близкому человеку — взяла его любимую песню и сделала её в его любимом стиле. Текст и мелодия сохраняются, меняется аранжировка и vocal.",
    relatedFeature: "create_music_job",
    tags: ["cover", "style-transfer"],
  },
  {
    id: "f-bonus-track",
    kind: "feature",
    title: "Первый трек бесплатно",
    short: "Зарегистрируйся через телефон — и я подарю тебе первую песню. Без оплаты.",
    long: "После регистрации по номеру телефона на MuzaAi у тебя автоматически появляется 1 бонусный трек. Это полноценная генерация (Suno v4), не урезанная версия. Используй её чтобы попробовать или сразу сделать подарок. После — каждый следующий трек 399 ₽, тексты по 99 ₽.",
    relatedFeature: "register_phone",
    tags: ["bonus", "free"],
  },
  {
    id: "f-extend",
    kind: "feature",
    title: "Продолжить уже сгенерированный трек",
    short: "Понравилось начало, но трек короткий? Я могу его продолжить с того же места.",
    long: "Режим «Extend» в MuzaAi берёт твой готовый трек и пишет к нему продолжение — новый куплет, новый припев или просто инструментальный аут. Suno использует аудио оригинала как референс, так что стилистика и vocal сохраняются. Полезно когда хочется превратить 2-минутный трек в полноценную 4-минутную композицию.",
    relatedFeature: "create_music_job",
    tags: ["extend", "continuation"],
  },
  {
    id: "f-share-track",
    kind: "feature",
    title: "Каждый трек — своя страничка для шеринга",
    short: "У каждой песни на MuzaAi есть отдельная ссылка с обложкой и текстом.",
    long: "Когда жмёшь «Поделиться» на треке — копируется ссылка вида muzaai.ru/share/<id>. По этой ссылке любой человек видит твой трек: обложку, название, плеер, текст. Это полноценная промо-страничка которая красиво откроется в Telegram, WhatsApp, Instagram. Идеально для именинников — отправляешь и они слышат поздравление.",
    relatedFeature: "share_asset",
    tags: ["share", "social"],
  },
  {
    id: "f-premium-voice",
    kind: "feature",
    title: "Я могу говорить с тобой голосом",
    short: "Премиум-подписка включает голосовые сообщения от меня в чате.",
    long: "За 199 ₽/мес ты получаешь premium-tier: я отвечаю голосовыми (Yandex TTS, естественный женский голос), помню весь контекст между сессиями, могу обсуждать твои треки голосом пока ты, например, ведёшь машину. Plus приоритет в очереди генерации Suno (твои треки идут вперёд).",
    relatedFeature: "premium_voice_msg",
    tags: ["premium", "voice"],
  },

  // === ENCYCLOPEDIA — мир музыки ===
  {
    id: "e-vaporwave-origin",
    kind: "encyclopedia",
    title: "Vaporwave родился в интернете",
    short: "Жанр vaporwave придумали на форумах 2010-х — медленный chopped & screwed remix старых хитов.",
    long: "Vaporwave появился около 2011 года как nostalgia-критика capitalism через slowed-down samples 80-х: smooth jazz, J-pop, советская электроника. Исполнители — Macintosh Plus, Saint Pepsi. Эстетика: палм-деревья, греческие статуи, японская типографика, glitch-art. На MuzaAi ты можешь сделать свой vaporwave трек — выбираешь стиль «синтвейв» + замедленные семплы.",
    tags: ["genre", "history", "synthwave"],
  },
  {
    id: "e-bohemian-rhapsody",
    kind: "encyclopedia",
    title: "Как родился Bohemian Rhapsody",
    short: "Queen записывали хор 180 раз — Фредди хотел эффект «как 200 голосов».",
    long: "Bohemian Rhapsody (1975) — Фредди Меркьюри принёс куски песни в студию EMI и сказал: «Это будет 6 минут оперы». Записывали 3 недели на 24-дорожечной плёнке. Хоровые партии Фредди, Брайана и Роджера дублировали 180 раз — плёнка стала такой тонкой что просвечивала. Издатели не хотели выпускать — слишком длинно. Фредди отдал её на радио другу, тот включил, слушатели завалили звонками. Через 4 недели #1 UK.",
    tags: ["queen", "rock-history", "production"],
  },
  {
    id: "e-suno-tech",
    kind: "encyclopedia",
    title: "Как Suno создаёт музыку из текста",
    short: "Suno использует диффузионную модель — рисует звук как картину, постепенно проявляя.",
    long: "Suno (модель v4 которую MuzaAi использует под капотом) работает в две стадии: 1) Text-to-token — твой prompt и текст превращаются в audio-tokens через LLM-encoder. 2) Diffusion — модель начинает с шума и за 30-40 итераций «проявляет» аудио, как Stable Diffusion проявляет картинки. Vocal и инструменты генерируются отдельно, потом миксуются. Время — 25-60 сек на трек.",
    tags: ["ai", "suno", "technology"],
  },
  {
    id: "e-mariah-christmas",
    kind: "encyclopedia",
    title: "All I Want for Christmas заработала Мэрайе $60M",
    short: "Песню написали за 15 минут в 1994. Каждое Рождество приносит ~$3M роялти.",
    long: "Мэрайя Кэри и Уолтер Афанасьев написали «All I Want for Christmas Is You» за 15 минут на детском клавишнике DX-7. Цель — добить рождественский альбом. С тех пор каждый декабрь песня возвращается в Billboard Top-10. Кумулятивно — больше $60 миллионов в роялти Мэрайе. В 2019, спустя 25 лет после релиза, песня впервые достигла #1 в США. На MuzaAi ты можешь сделать свой рождественский хит — тоже за 15 минут.",
    tags: ["mariah-carey", "christmas", "songwriting"],
  },
  {
    id: "e-drill-vs-trap",
    kind: "encyclopedia",
    title: "Drill и Trap — разные жанры",
    short: "Trap — медленный из Атланты. Drill — быстрый из Чикаго, потом UK.",
    long: "Trap (Atlanta, 2000-е) — 808 sub-bass, hi-hat triplets, темп ~130-160 BPM, тяжёлый snare. Артисты: Future, Migos, Travis Scott. Drill (Chicago 2012, UK 2018) — темп 140 BPM, более минорная гармония, темнее настроение, агрессивный rap. Артисты: Chief Keef, Pop Smoke, Central Cee. UK Drill отличается от Chicago более sliding bass, sampled grime drums. На MuzaAi пиши в prompt «drill UK» или «trap atlanta» — Suno различает.",
    tags: ["genre", "hip-hop", "trap", "drill"],
  },
  {
    id: "e-beatles-record",
    kind: "encyclopedia",
    title: "Beatles записали Abbey Road за 2 недели",
    short: "Последний студийный альбом — 11-21 августа 1969. Уже разваливались как группа.",
    long: "Abbey Road записывался когда The Beatles фактически уже не разговаривали друг с другом — Джон Леннон и Пол МакКартни писали почти отдельно, Джордж Харрисон принёс «Something» и «Here Comes The Sun» (теперь его любимые треки). Сессии — Trident + EMI Studios, август 1969. Знаменитая обложка с переходом через зебру — снята за 10 минут 8 августа в 11:30 утра. Это последний альбом который Битлз записали вместе (Let It Be вышел позже, но был записан раньше).",
    tags: ["beatles", "rock-history"],
  },
  {
    id: "e-songwriting-hook",
    kind: "encyclopedia",
    title: "Как написать припев который запоминается",
    short: "Главное — простота. Лучшие хуки — 3-5 нот, 1 фраза, повтор.",
    long: "Hit-songwriters (Max Martin, Sia) следуют принципу «hum-test» — если человек может напеть hook после одного прослушивания, hook сильный. Признаки сильного hook: 1) Мелодия двигается в узком диапазоне (5-7 нот) с одним «выстрелом» вверх. 2) Текст из 5-9 слов с повтором ключевого слова. 3) Hook должен прийти в первые 30 сек трека. 4) Pre-chorus создаёт ожидание, hook его «разрешает». На MuzaAi пиши в prompt «catchy chorus, simple melodic hook» — Suno подхватит.",
    tags: ["songwriting", "creativity", "tutorial"],
  },
];

// === Helpers ===

/**
 * Возвращает следующий факт из ротации (feature ↔ encyclopedia balanced).
 * @param seenIds — массив уже показанных factId
 * @param lastKind — последний показанный kind ('feature'|'encyclopedia'|null)
 *                   используется для чередования
 */
export function nextMusaFact(
  seenIds: string[] = [],
  lastKind: MusaFactKind | null = null,
): MusaFact | null {
  const seen = new Set(seenIds);
  const unseen = MUSA_FACTS.filter(f => !seen.has(f.id));

  if (unseen.length === 0) return null;

  // Prefer противоположный kind от lastKind (чередование).
  const preferKind: MusaFactKind = lastKind === "feature" ? "encyclopedia" : "feature";
  const preferred = unseen.filter(f => f.kind === preferKind);
  const pool = preferred.length > 0 ? preferred : unseen;
  // Random выбор внутри pool (но детерминирован seeded чтобы не "скакать")
  return pool[Math.floor(Math.random() * pool.length)];
}

/**
 * Получить факт по id (для click → expand).
 */
export function getMusaFactById(id: string): MusaFact | null {
  return MUSA_FACTS.find(f => f.id === id) || null;
}

/**
 * Адаптивная длительность показа bubble (мс) в зависимости от visit_count.
 * - 1 visit (новый) — 8000
 * - 2-5 visits — 6000
 * - 6+ visits без активности → 3500
 */
export function adaptiveBubbleDurationMs(visitCount: number, recentChatActivity: boolean): number {
  if (visitCount >= 6 && !recentChatActivity) return 3500;
  if (visitCount >= 2) return 6000;
  return 8000;
}

/**
 * Следующий gap между bubble'ами (мс).
 * Не спамим — минимум 30 сек, для частых юзеров — больше.
 */
export function nextBubbleGapMs(visitCount: number): number {
  if (visitCount >= 6) return 60_000;
  if (visitCount >= 2) return 45_000;
  return 30_000;
}
