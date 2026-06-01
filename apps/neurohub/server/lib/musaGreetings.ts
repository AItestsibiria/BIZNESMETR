// Eugene 2026-05-20 Босс: «Пусть Муза выбирает разные приветствия».
// Единый helper для всех каналов (web /api/muza/chat/init, telegram-bot
// /start, max-bot /start). Pool из 14 базовых + time-of-day + season + geo
// варианты. Random pick + контекстная фильтрация (returning user, geo).
//
// Все приветствия в ЖЕНСКОМ роде (Музa — девушка 25 лет, Musa-female-voice rule).

export interface GreetingContext {
  /** Имя юзера если знаем (для returning) */
  userName?: string | null;
  /** Юзер уже общался с Музой ранее */
  isReturning?: boolean;
  /** Страна юзера ISO code (RU/KZ/UA/US/...) */
  countryCode?: string | null;
  /** Город (Москва, Алматы, ...) */
  city?: string | null;
  /** Название страны для не-РФ */
  countryName?: string | null;
  /** Канал — web | telegram | max | vk */
  channel?: "web" | "telegram" | "max" | "vk";
  /** Avatar emoji для канала (telegram personas: 🎀/✨/💎/🌸) */
  channelAvatar?: string;
}

const CIS_COUNTRY_CODES = new Set(["BY", "KZ", "UA", "MD", "AM", "AZ", "GE", "KG", "TJ", "TM", "UZ"]);

const FLAGS: Record<string, string> = {
  RU: "🇷🇺", BY: "🇧🇾", KZ: "🇰🇿", UA: "🇺🇦", MD: "🇲🇩",
  AM: "🇦🇲", AZ: "🇦🇿", GE: "🇬🇪", KG: "🇰🇬", TJ: "🇹🇯", TM: "🇹🇲", UZ: "🇺🇿",
  US: "🇺🇸", GB: "🇬🇧", DE: "🇩🇪", FR: "🇫🇷", IT: "🇮🇹", ES: "🇪🇸",
  PL: "🇵🇱", BG: "🇧🇬", RO: "🇷🇴", RS: "🇷🇸", CZ: "🇨🇿", SK: "🇸🇰",
  TR: "🇹🇷", IL: "🇮🇱", CN: "🇨🇳", JP: "🇯🇵", KR: "🇰🇷", IN: "🇮🇳",
  CA: "🇨🇦", AU: "🇦🇺", BR: "🇧🇷", AR: "🇦🇷", MX: "🇲🇽",
};

function flagFor(cc: string): string {
  return FLAGS[cc] || "🌍";
}

function getMskHour(): number {
  // MSK = UTC+3
  const now = new Date();
  return (now.getUTCHours() + 3) % 24;
}

function getSeason(): "winter" | "spring" | "summer" | "autumn" {
  const m = new Date().getUTCMonth() + 1;
  if (m >= 3 && m <= 5) return "spring";
  if (m >= 6 && m <= 8) return "summer";
  if (m >= 9 && m <= 11) return "autumn";
  return "winter";
}

function pickRandom<T>(arr: T[]): T {
  return arr[Math.floor(Math.random() * arr.length)];
}

/**
 * Главный entry point — выбирает случайное приветствие на основе контекста.
 * Все варианты в женском роде, тёплые, manager-style.
 */
export function pickMusaGreeting(ctx: GreetingContext = {}): string {
  const avatar = ctx.channelAvatar || "🎵";
  const name = (ctx.userName || "").trim();
  const cc = (ctx.countryCode || "").toUpperCase();
  const isForeign = cc && cc !== "RU" && !CIS_COUNTRY_CODES.has(cc);

  // 1. Returning user — короткое личное (если есть имя) или тёплое generic
  if (ctx.isReturning) {
    if (name) {
      const returnNamed = [
        `${avatar} ${name}, рада тебя снова видеть! Что сегодня создадим?`,
        `${avatar} Привет, ${name}! С возвращением 🌸 На какой повод думаешь песню?`,
        `${avatar} ${name} 💫 как настроение? Поможем сегодня собрать что-нибудь особенное?`,
        `${avatar} ${name}, как дела? Я рада что зашёл — расскажи что нужно?`,
        `${avatar} О, ${name}! Заглянул — отлично. Какая идея сейчас?`,
        `${avatar} Привет-привет, ${name}! Рада снова поработать вместе ✨`,
      ];
      return pickRandom(returnNamed);
    }
    const returnGeneric = [
      `${avatar} С возвращением! Я тут — на какой повод думаешь?`,
      `${avatar} Привет снова! Рада что зашёл 🌸 Расскажешь что нужно?`,
      `${avatar} О, привет! Я тебя помню. Что сегодня будем создавать?`,
      `${avatar} Заглянул! Хорошо. Какая идея у тебя сейчас?`,
      `${avatar} Привет 💫 как настроение? Что собираем сегодня?`,
    ];
    return pickRandom(returnGeneric);
  }

  // 2. Иностранный юзер — особое приветствие с флагом страны
  if (isForeign) {
    const flag = flagFor(cc);
    const country = ctx.countryName || cc;
    const foreignPool = [
      `🇷🇺 Россия приветствует автора из ${flag} ${country}! 🌍 Мировое творчество с MuzaAi ${avatar}\n\nЯ — Муза, друг проекта. Это правда твоя страна? Если нет — подскажи откуда ты.`,
      `${flag} Привет из ${country}! Я Муза — помогу собрать песню под событие. Как тебя зовут? 🌍`,
      `${avatar} Здравствуй! Вижу — ты из ${country} ${flag}. Я Муза, помогу с песней. Расскажи на какой повод?`,
    ];
    return pickRandom(foreignPool);
  }

  // 3. Геогра ф ия в РФ/СНГ — geo-aware
  const geoVariants: string[] = [];
  if (ctx.city) {
    geoVariants.push(
      `${avatar} Привет! Я — Муза. Слушай, попробую угадать — ты из ${ctx.city}? 🌍 А как мне к тебе обращаться?`,
      `${avatar} Привет! Я Муза. Чувствую — ты где-то в ${ctx.city}? 😊 Расскажи как тебя зовут — будем знакомиться.`,
      `${avatar} ${ctx.city} 🌟 Привет! Я Муза, помогу собрать песню. Как зовут?`,
    );
  } else if (ctx.countryName) {
    geoVariants.push(
      `${avatar} Привет! Я — Муза. Кажется, ты из ${ctx.countryName}? Угадала? И как тебя зовут?`,
    );
  }

  // 4. Базовый pool — universal, без географии
  const basePool = [
    `${avatar} Привет! Я — Муза. На какой повод думаешь песню? 🎵`,
    `${avatar} Привет! Я Муза — помогу собрать песню под событие. А тебя как зовут? Расскажи, что в голове крутится?`,
    `${avatar} Здравствуй! Я Муза. Как мне к тебе обращаться? И на какой повод будем колдовать? 🎵`,
    `${avatar} Привет ✨ Я Муза — собираю песни под особенные моменты. Давай познакомимся — как тебя зовут?`,
    `${avatar} Заглянул? Отлично! Я Муза — помогу с песней. Подскажи имя — буду к тебе обращаться лично.`,
    `${avatar} Привет! 🌟 Меня зови Муза. С чего начнём — расскажешь о себе, или сразу к поводу?`,
    `${avatar} Эй, привет! Я Муза. Чтобы мне было проще — как тебя зовут? Расскажи, какой повод 🎼`,
    `${avatar} Привет-привет! Я Муза. Давай знакомиться — твоё имя? И что хочешь услышать?`,
    `${avatar} Здравствуй! Я Муза, твой менеджер по песням 🎶 С чего начнём?`,
    `${avatar} Привет! Я Муза — помогу превратить идею в песню. Какой повод думаешь? 💫`,
    `${avatar} Рада знакомству! Я Муза. Что нужно — поздравление, песня для близких, инструменталка?`,
    `${avatar} Доброго дня! Я Муза. Помогу с подарком-песней или своим треком — что больше интересно?`,
  ];

  // 5. Time-of-day variants
  const hour = getMskHour();
  const timeVariants: string[] = [];
  if (hour >= 5 && hour < 12) {
    timeVariants.push(
      `${avatar} Доброе утро! Я Муза ☀️ Хорошее настроение для песни — что собираем?`,
      `${avatar} Утро! Я Муза. Какой повод сегодня — есть идея для трека? 🌅`,
    );
  } else if (hour >= 12 && hour < 18) {
    timeVariants.push(
      `${avatar} Добрый день! Я Муза 🌟 На какой повод думаешь песню?`,
      `${avatar} Привет! День в разгаре — самое время для творчества. Я Муза, что собираем?`,
    );
  } else if (hour >= 18 && hour < 23) {
    timeVariants.push(
      `${avatar} Добрый вечер! Я Муза 🌙 Вечером особенно хорошо звучат душевные песни. Что нужно?`,
      `${avatar} Вечер 🎵 Привет! Я Муза, помогу с песней. На какой повод?`,
    );
  } else {
    timeVariants.push(
      `${avatar} Привет, полуночник! 🌙 Я Муза — самое время для творчества. Что собираем?`,
      `${avatar} Привет 🌃 Я Муза. В тишине ночи особенно хорошо рождаются песни — какая идея?`,
    );
  }

  // 6. Season variants
  const season = getSeason();
  const seasonVariants: string[] = [];
  if (season === "winter") {
    seasonVariants.push(`${avatar} Привет! Зима — время уютных песен ❄️ Я Муза, что собираем?`);
  } else if (season === "spring") {
    seasonVariants.push(`${avatar} Привет! Весна 🌸 пробуждает идеи. Я Муза, расскажи что в голове?`);
  } else if (season === "summer") {
    seasonVariants.push(`${avatar} Лето! ☀️ Привет, я Муза. Какая идея сейчас в голове?`);
  } else {
    seasonVariants.push(`${avatar} Осенью особенно тонко звучит музыка 🍂 Привет, я Муза. Что собираем?`);
  }

  // Combine all pools with weights — base встречается чаще (универсальный)
  const allVariants = [
    ...basePool, ...basePool, // удваиваем для weight
    ...geoVariants,
    ...timeVariants,
    ...seasonVariants,
  ];

  return pickRandom(allVariants);
}

/**
 * Короткая версия — для fallback при ошибке (короткая, без TTL/контекста).
 */
export function pickMusaShortGreeting(avatar = "🎵"): string {
  const shorts = [
    `${avatar} Привет! Я — Муза. Чем помочь?`,
    `${avatar} Здравствуй! Я Муза — рада что заглянул.`,
    `${avatar} Привет! Я Муза, готова помочь с песней.`,
    `${avatar} Эй, привет! Я Муза. Что нужно?`,
  ];
  return pickRandom(shorts);
}
