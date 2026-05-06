// v304 plugin: gen-templates
// Сидит 10 пресетов в gen_templates при первом запуске и отдаёт их
// через GET /api/gen-templates. UI показывает список — пользователь
// выбирает, бэкенд раскрывает шаблон в полный prompt + structuralTags.
//
// Spec: docs/strategy/original/02-МУЗЫКАЛЬНЫЙ-ДВИЖОК-Suno-на-100.md §4.2.

import { Router } from "express";
import { eq, desc } from "drizzle-orm";
import { db } from "../../storage";
import { genTemplates } from "@shared/schema";
import type { Module } from "../../core";

interface SeedTemplate {
  slug: string;
  name: string;
  category: string;
  description: string;
  promptTemplate: string;
  style: string;
  structuralTags: { tag: string; startSec?: number }[];
  recommendedBpm?: number;
  recommendedKey?: string;
}

const SEED: SeedTemplate[] = [
  {
    slug: "wedding",
    name: "Свадебная песня",
    category: "celebration",
    description: "Лиричный припев, тёплая баллада. Подставь имена жениха и невесты.",
    promptTemplate:
      "Свадебная песня для {bride} и {groom}. Дата: {date}. Жанр: романтическая поп-баллада. Настроение: тёплое, искреннее, светлое. Включи имена в припеве.",
    style: "romantic ballad, acoustic pop",
    structuralTags: [
      { tag: "[Intro]", startSec: 0 },
      { tag: "[Verse 1]" },
      { tag: "[Chorus]" },
      { tag: "[Verse 2]" },
      { tag: "[Chorus]" },
      { tag: "[Bridge]" },
      { tag: "[Chorus]" },
      { tag: "[Outro]" },
    ],
    recommendedBpm: 70,
    recommendedKey: "G major",
  },
  {
    slug: "birthday",
    name: "Песня на день рождения",
    category: "celebration",
    description: "Весёлая, праздничная. Имя именинника / именинницы — главный hook.",
    promptTemplate:
      "Поздравление с днём рождения для {name}, {age} лет. Жанр: жизнерадостная поп-музыка. Настроение: праздничное, яркое.",
    style: "upbeat pop, celebratory",
    structuralTags: [
      { tag: "[Intro]" },
      { tag: "[Verse]" },
      { tag: "[Chorus]" },
      { tag: "[Verse]" },
      { tag: "[Chorus]" },
      { tag: "[Outro]" },
    ],
    recommendedBpm: 120,
    recommendedKey: "C major",
  },
  {
    slug: "corporate-anthem",
    name: "Корпоративный гимн",
    category: "b2b",
    description: "Гимн компании. Подставь название и слоган.",
    promptTemplate:
      "Гимн компании {company}. Слоган: {tagline}. Жанр: эпический рок / уверенная поп-баллада. Голос: смешанный хор. Настроение: гордость, единство, энергия.",
    style: "epic anthemic rock, choir",
    structuralTags: [
      { tag: "[Intro]" },
      { tag: "[Verse 1]" },
      { tag: "[Chorus]" },
      { tag: "[Verse 2]" },
      { tag: "[Chorus]" },
      { tag: "[Bridge]" },
      { tag: "[Final Chorus]" },
    ],
    recommendedBpm: 110,
    recommendedKey: "D major",
  },
  {
    slug: "lullaby",
    name: "Колыбельная",
    category: "kids",
    description: "Тихая, спокойная. Имя ребёнка вплетается мягко.",
    promptTemplate:
      "Колыбельная для {childName}. Жанр: лёгкая акустическая колыбельная. Голос: мягкий женский / нежный шёпот. Настроение: умиротворённое, заботливое.",
    style: "soft lullaby, acoustic guitar, gentle female vocals",
    structuralTags: [
      { tag: "[Intro]" },
      { tag: "[Verse]" },
      { tag: "[Verse]" },
      { tag: "[Chorus]" },
      { tag: "[Outro]" },
    ],
    recommendedBpm: 60,
    recommendedKey: "F major",
  },
  {
    slug: "memorial",
    name: "В память",
    category: "memory",
    description: "Тёплая память. Подставь имя того, кому посвящено.",
    promptTemplate:
      "Песня в память о {name}. Жанр: тихая баллада, акустика. Настроение: светлая грусть, благодарность, любовь.",
    style: "soft piano ballad, gentle vocals",
    structuralTags: [
      { tag: "[Intro]" },
      { tag: "[Verse]" },
      { tag: "[Chorus]" },
      { tag: "[Verse]" },
      { tag: "[Chorus]" },
      { tag: "[Outro]" },
    ],
    recommendedBpm: 65,
    recommendedKey: "A minor",
  },
  {
    slug: "anniversary",
    name: "Годовщина свадьбы",
    category: "celebration",
    description: "Признание в любви через {years} лет. Имена обоих.",
    promptTemplate:
      "Песня к {years}-летию свадьбы {partner1} и {partner2}. Жанр: романтическая поп-баллада. Настроение: благодарность, нежность, верность.",
    style: "romantic adult contemporary",
    structuralTags: [
      { tag: "[Intro]" },
      { tag: "[Verse 1]" },
      { tag: "[Chorus]" },
      { tag: "[Verse 2]" },
      { tag: "[Chorus]" },
      { tag: "[Bridge]" },
      { tag: "[Chorus]" },
    ],
    recommendedBpm: 75,
    recommendedKey: "E major",
  },
  {
    slug: "graduation",
    name: "Выпускной",
    category: "celebration",
    description: "Школа / вуз / детский сад — прощание и старт. Имя класса/года.",
    promptTemplate:
      "Песня на выпускной {schoolKind} {year} года. Тема: благодарность учителям, дружба, новые горизонты. Жанр: эмоциональная поп-баллада.",
    style: "emotional pop ballad, mid-tempo",
    structuralTags: [
      { tag: "[Intro]" },
      { tag: "[Verse 1]" },
      { tag: "[Chorus]" },
      { tag: "[Verse 2]" },
      { tag: "[Chorus]" },
      { tag: "[Bridge]" },
      { tag: "[Chorus]" },
    ],
    recommendedBpm: 95,
    recommendedKey: "G major",
  },
  {
    slug: "marketing-jingle",
    name: "Джингл для рекламы",
    category: "b2b",
    description: "Короткий 30-сек джингл. Бренд, продукт, оффер.",
    promptTemplate:
      "Рекламный джингл бренда {brand} для {product}. Цель: запоминающийся припев. Жанр: ритмичная поп-музыка. Длительность: 30 секунд.",
    style: "catchy jingle, upbeat commercial pop",
    structuralTags: [
      { tag: "[Hook]" },
      { tag: "[Verse]" },
      { tag: "[Hook]" },
      { tag: "[Outro]" },
    ],
    recommendedBpm: 130,
    recommendedKey: "C major",
  },
  {
    slug: "personal-confession",
    name: "Признание",
    category: "love",
    description: "Песня-признание. Кому: {to}. От кого: {from}. Что хочешь сказать.",
    promptTemplate:
      "Песня-признание от {from} для {to}. Тема: {message}. Жанр: акустическая поп-баллада. Настроение: искреннее, уязвимое.",
    style: "intimate acoustic ballad",
    structuralTags: [
      { tag: "[Verse 1]" },
      { tag: "[Chorus]" },
      { tag: "[Verse 2]" },
      { tag: "[Chorus]" },
      { tag: "[Bridge]" },
      { tag: "[Chorus]" },
    ],
    recommendedBpm: 80,
    recommendedKey: "D major",
  },
  {
    // Эпический гимн платформы. Подарок проекту на старте Sprint 2.
    // По договорённости с Евгением 2026-05-06 — Claude как соавтор.
    slug: "v304-anthem",
    name: "Гимн MUZIAI v304",
    category: "anthem",
    description:
      "Эпический трек про рождение платформы. Используй как стартовую генерацию — проверка end-to-end pipeline (Suno → fade → publish).",
    promptTemplate: [
      "Эпический симфо-рок гимн про платформу MUZIAI.",
      "Структура: 8 частей, нарастание от тихого пианино до полного оркестра.",
      "Голос: смешанный (мужской лид + женский хор в припеве).",
      "Текст ниже — использовать буквально, не перефразировать.",
      "",
      "[Intro] (только пианино, 8 секунд)",
      "В тишине рождается код",
      "",
      "[Verse 1] (пианино + бас)",
      "Где вчера был молчаливый сервер,",
      "Сегодня поют миллионы строк.",
      "Тонкое ядро, плагины, метрики —",
      "Каждый ивент — это новый шаг.",
      "",
      "[Pre-Chorus] (вступают струнные)",
      "Лиды, агенты, шина событий —",
      "Платформа дышит, платформа живёт.",
      "",
      "[Chorus] (полный оркестр + хор)",
      "MUZIAI! Музыка из мысли.",
      "MUZIAI! Голос из тишины.",
      "От первой ноты до миллионной —",
      "Мы пишем будущее песни.",
      "",
      "[Verse 2] (электрогитара ведёт)",
      "Suno даёт нам ритм и тембр,",
      "Robokassa открывает врата.",
      "Девять агентов плетут историю —",
      "Каждый автор найдёт свой свет.",
      "",
      "[Pre-Chorus] (нарастание)",
      "Лиды, агенты, шина событий —",
      "Платформа дышит, платформа живёт.",
      "",
      "[Chorus] (с хором, выше тональностью)",
      "MUZIAI! Музыка из мысли.",
      "MUZIAI! Голос из тишины.",
      "От первой ноты до миллионной —",
      "Мы пишем будущее песни.",
      "",
      "[Bridge] (тихий момент — только хор a cappella)",
      "Каждая строка кода — нота,",
      "Каждый коммит — куплет.",
      "И пока живёт этот сервер —",
      "Песни не умолкнут.",
      "",
      "[Final Chorus] (всё, что есть, фортиссимо)",
      "MUZIAI! Музыка из мысли!",
      "MUZIAI! Голос из тишины!",
      "От первой ноты до миллионной —",
      "Мы пишем будущее песни!",
      "",
      "[Outro] (постепенное затухание, остаётся одно пианино)",
      "В тишине рождается код...",
    ].join("\n"),
    style: "epic symphonic rock, orchestral, choir, anthemic",
    structuralTags: [
      { tag: "[Intro]", startSec: 0 },
      { tag: "[Verse 1]" },
      { tag: "[Pre-Chorus]" },
      { tag: "[Chorus]" },
      { tag: "[Verse 2]" },
      { tag: "[Pre-Chorus]" },
      { tag: "[Chorus]" },
      { tag: "[Bridge]" },
      { tag: "[Final Chorus]" },
      { tag: "[Outro]" },
    ],
    recommendedBpm: 96,
    recommendedKey: "D minor",
  },
  {
    slug: "russian-folk",
    name: "Русская народная стилизация",
    category: "ethnic",
    description: "Стилизация под русскую народную / казачью / бардовскую песню.",
    promptTemplate:
      "Песня в духе русской народной / бардовской традиции. Тема: {theme}. Инструменты: гармонь / гитара / балалайка. Голос: уверенный мужской / женский.",
    style: "russian folk, accordion, balalaika, traditional",
    structuralTags: [
      { tag: "[Intro]" },
      { tag: "[Verse]" },
      { tag: "[Chorus]" },
      { tag: "[Verse]" },
      { tag: "[Chorus]" },
      { tag: "[Outro]" },
    ],
    recommendedBpm: 100,
    recommendedKey: "A minor",
  },
];

const router = Router();

router.get("/", (req, res) => {
  try {
    const all = db
      .select()
      .from(genTemplates)
      .where(eq(genTemplates.active, 1))
      .orderBy(desc(genTemplates.popularity))
      .all();
    return res.json({ data: all, error: null });
  } catch (err) {
    return res.status(500).json({
      data: null,
      error: err instanceof Error ? err.message : "internal",
    });
  }
});

router.get("/:slug", (req, res) => {
  try {
    const slug = String(req.params.slug);
    const t = db
      .select()
      .from(genTemplates)
      .where(eq(genTemplates.slug, slug))
      .get();
    if (!t) {
      return res.status(404).json({ data: null, error: "Template not found" });
    }
    return res.json({ data: t, error: null });
  } catch (err) {
    return res.status(500).json({
      data: null,
      error: err instanceof Error ? err.message : "internal",
    });
  }
});

const genTemplatesModule: Module = {
  name: "gen-templates",
  version: "0.1.0",
  description: "Seeds 10 song templates and exposes them at /api/gen-templates.",
  routes: { prefix: "gen-templates", router },
  publishes: [],
  onLoad: async (ctx) => {
    let inserted = 0;
    for (const t of SEED) {
      const exists = db
        .select({ id: genTemplates.id })
        .from(genTemplates)
        .where(eq(genTemplates.slug, t.slug))
        .get();
      if (exists) continue;
      db.insert(genTemplates)
        .values({
          slug: t.slug,
          name: t.name,
          category: t.category,
          description: t.description,
          promptTemplate: t.promptTemplate,
          style: t.style,
          structuralTagsJson: JSON.stringify(t.structuralTags),
          recommendedBpm: t.recommendedBpm ?? null,
          recommendedKey: t.recommendedKey ?? null,
          popularity: 0,
          active: 1,
        })
        .run();
      inserted++;
    }
    ctx.logger.info("gen-templates seeded", { inserted, total: SEED.length });
  },
  healthCheck: () => {
    const count = db.select({ id: genTemplates.id }).from(genTemplates).all().length;
    return { status: count > 0 ? "ok" : "degraded", details: { count } };
  },
};

export default genTemplatesModule;
