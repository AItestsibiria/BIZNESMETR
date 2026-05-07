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

  // ============================================================
  // Расширение Sprint 2: 23 новых шаблона по группам
  // (ТЗ Eugene 2026-05-07 11:11). Каждый — production-ready
  // с готовой структурой, BPM и стилем.
  // ============================================================

  // === Группа: celebration (личные праздники) ===
  { slug: "name-day", name: "Именины", category: "celebration",
    description: "Тёплая застольная песня к именинам / тезоименитству.",
    promptTemplate: "Уютная застольная песня на именины {имя}. Тёплые слова, добрые пожелания, лёгкая ностальгия.",
    style: "warm acoustic, folk pop, gentle vocals, accordion accents",
    structuralTags: [{tag:"[Intro]"},{tag:"[Verse]"},{tag:"[Chorus]"},{tag:"[Verse]"},{tag:"[Chorus]"},{tag:"[Outro]"}],
    recommendedBpm: 100, recommendedKey: "G major" },

  { slug: "engagement", name: "Помолвка", category: "celebration",
    description: "Романтичная песня для объявления помолвки / вечеринки.",
    promptTemplate: "Романтика, обещание, начало пути вдвоём. Имена: {он} и {она}.",
    style: "romantic pop ballad, piano, soft strings, female lead",
    structuralTags: [{tag:"[Intro]"},{tag:"[Verse]"},{tag:"[Pre-Chorus]"},{tag:"[Chorus]"},{tag:"[Bridge]"},{tag:"[Chorus]"},{tag:"[Outro]"}],
    recommendedBpm: 78, recommendedKey: "C major" },

  { slug: "baby-birth", name: "Рождение ребёнка", category: "celebration",
    description: "Песня-поздравление для новорождённого и счастливых родителей.",
    promptTemplate: "Светлая радость, новая жизнь, благословение. Имя малыша: {имя}.",
    style: "lullaby pop, music box, soft female vocals, gentle harmonies",
    structuralTags: [{tag:"[Intro]"},{tag:"[Verse]"},{tag:"[Chorus]"},{tag:"[Verse]"},{tag:"[Chorus]"},{tag:"[Outro]"}],
    recommendedBpm: 82, recommendedKey: "F major" },

  { slug: "senior-jubilee", name: "Юбилей 50/60/70", category: "celebration",
    description: "Тёплая песня на круглую дату — для старшего поколения.",
    promptTemplate: "Юбилей {лет} лет. Уважение, благодарность за прожитые годы, тёплые слова детей и внуков. Имя: {имя}.",
    style: "warm orchestral pop, soft strings, mature male vocal, classic ballad",
    structuralTags: [{tag:"[Intro]"},{tag:"[Verse]"},{tag:"[Chorus]"},{tag:"[Verse]"},{tag:"[Chorus]"},{tag:"[Bridge]"},{tag:"[Chorus]"},{tag:"[Outro]"}],
    recommendedBpm: 88, recommendedKey: "D major" },

  // === Группа: holiday (государственные/массовые) ===
  { slug: "new-year", name: "Новогодняя песня", category: "holiday",
    description: "Праздничная песня к Новому году — для семьи или корпоратива.",
    promptTemplate: "Снег, ёлка, бой курантов, ожидание чуда. {личное_посвящение}.",
    style: "festive pop, sleigh bells, bright synths, cheerful chorus, mixed vocals",
    structuralTags: [{tag:"[Intro]"},{tag:"[Verse]"},{tag:"[Pre-Chorus]"},{tag:"[Chorus]"},{tag:"[Verse]"},{tag:"[Chorus]"},{tag:"[Outro]"}],
    recommendedBpm: 120, recommendedKey: "C major" },

  { slug: "8-march", name: "К 8 марта", category: "holiday",
    description: "Поздравление женщине / мамам / коллегам к 8 марта.",
    promptTemplate: "Восхищение красотой, благодарность, весеннее настроение. Адресат: {кому}.",
    style: "soft romantic pop, acoustic guitar, warm male vocal, spring vibes",
    structuralTags: [{tag:"[Intro]"},{tag:"[Verse]"},{tag:"[Chorus]"},{tag:"[Verse]"},{tag:"[Chorus]"},{tag:"[Outro]"}],
    recommendedBpm: 96, recommendedKey: "G major" },

  { slug: "23-feb", name: "К 23 февраля", category: "holiday",
    description: "Поздравление мужчине / отцу / коллегам-защитникам.",
    promptTemplate: "Уважение, мужество, честь, благодарность. Адресат: {кому}.",
    style: "heroic anthem, brass, marching drums, male choir, anthemic",
    structuralTags: [{tag:"[Intro]"},{tag:"[Verse]"},{tag:"[Chorus]"},{tag:"[Verse]"},{tag:"[Chorus]"},{tag:"[Bridge]"},{tag:"[Chorus]"},{tag:"[Outro]"}],
    recommendedBpm: 110, recommendedKey: "D minor" },

  { slug: "9-may", name: "9 мая (День Победы)", category: "holiday",
    description: "Песня памяти и благодарности ветеранам.",
    promptTemplate: "Гордость, память о подвиге, благодарность поколениям. Семейная история: {ветеран_семьи}.",
    style: "patriotic ballad, orchestra, choir, solemn male lead, brass",
    structuralTags: [{tag:"[Intro]"},{tag:"[Verse]"},{tag:"[Chorus]"},{tag:"[Verse]"},{tag:"[Chorus]"},{tag:"[Bridge]"},{tag:"[Chorus]"},{tag:"[Outro]"}],
    recommendedBpm: 80, recommendedKey: "G minor" },

  { slug: "valentines-day", name: "День Святого Валентина", category: "holiday",
    description: "Романтичная мини-песня в подарок 14 февраля.",
    promptTemplate: "Признание, объятия, нежность. {моё_имя} → {твоё_имя}.",
    style: "romantic acoustic pop, fingerpicking guitar, intimate vocal, soft strings",
    structuralTags: [{tag:"[Intro]"},{tag:"[Verse]"},{tag:"[Chorus]"},{tag:"[Verse]"},{tag:"[Chorus]"},{tag:"[Outro]"}],
    recommendedBpm: 72, recommendedKey: "A major" },

  // === Группа: b2b (расширение) ===
  { slug: "product-launch", name: "Запуск продукта", category: "b2b",
    description: "Энергичный гимн к запуску нового продукта / релизу.",
    promptTemplate: "Революция, прорыв, новая эпоха. Продукт: {название}. Преимущества: {USP}.",
    style: "modern electronic pop, rising synths, four-on-the-floor, anthemic chorus",
    structuralTags: [{tag:"[Intro]"},{tag:"[Verse]"},{tag:"[Pre-Chorus]"},{tag:"[Chorus]"},{tag:"[Drop]"},{tag:"[Verse]"},{tag:"[Chorus]"},{tag:"[Outro]"}],
    recommendedBpm: 128, recommendedKey: "F# minor" },

  { slug: "award-ceremony", name: "Награждение / Premium", category: "b2b",
    description: "Торжественный фон для церемонии награждения.",
    promptTemplate: "Триумф, признание, вершина пути. Награждаемый: {имя}. За: {достижение}.",
    style: "cinematic orchestral, swelling strings, brass fanfare, choral",
    structuralTags: [{tag:"[Intro]"},{tag:"[Build]"},{tag:"[Climax]"},{tag:"[Outro]"}],
    recommendedBpm: 90, recommendedKey: "C major" },

  // === Группа: kids (расширение) ===
  { slug: "kids-fun", name: "Весёлая детская", category: "kids",
    description: "Озорная песенка для детского праздника / хороводов.",
    promptTemplate: "Игра, смех, прыжки, дружба. Имена детей: {имена}.",
    style: "playful kids pop, bright melodies, claps, ukulele, child-like vocals",
    structuralTags: [{tag:"[Intro]"},{tag:"[Verse]"},{tag:"[Chorus]"},{tag:"[Verse]"},{tag:"[Chorus]"},{tag:"[Outro]"}],
    recommendedBpm: 130, recommendedKey: "C major" },

  { slug: "kids-birthday", name: "Детский день рождения", category: "kids",
    description: "Весёлое поздравление ребёнку на праздник — короткая, цепляющая.",
    promptTemplate: "С днём рождения, {имя}! {лет} лет. Подарки, торт, друзья, шары.",
    style: "cheerful kids pop, bright synth, claps, female lead, party vibes",
    structuralTags: [{tag:"[Intro]"},{tag:"[Verse]"},{tag:"[Chorus]"},{tag:"[Verse]"},{tag:"[Chorus]"},{tag:"[Outro]"}],
    recommendedBpm: 140, recommendedKey: "G major" },

  // === Группа: love (расширение) ===
  { slug: "proposal-song", name: "Предложение руки и сердца", category: "love",
    description: "Песня для момента предложения — романтика, обещание.",
    promptTemplate: "Один вопрос, одна жизнь вдвоём. {он} обращается к {она}.",
    style: "intimate acoustic ballad, piano, strings swell, male lead, emotional",
    structuralTags: [{tag:"[Intro]"},{tag:"[Verse]"},{tag:"[Pre-Chorus]"},{tag:"[Chorus]"},{tag:"[Bridge]"},{tag:"[Chorus]"},{tag:"[Outro]"}],
    recommendedBpm: 70, recommendedKey: "D major" },

  { slug: "long-distance", name: "На расстоянии", category: "love",
    description: "Песня для пары в долгой разлуке — нежность, ожидание.",
    promptTemplate: "Километры между нами, но сердце рядом. {имена_пары}.",
    style: "indie folk, fingerpicking, melancholic vocals, soft drums",
    structuralTags: [{tag:"[Intro]"},{tag:"[Verse]"},{tag:"[Chorus]"},{tag:"[Verse]"},{tag:"[Chorus]"},{tag:"[Outro]"}],
    recommendedBpm: 86, recommendedKey: "E minor" },

  { slug: "first-date", name: "Первое свидание", category: "love",
    description: "Лёгкая, флирт-вайб для подарка после первой встречи.",
    promptTemplate: "Случайная встреча, первый взгляд, желание увидеть снова. {его_имя} ↔ {её_имя}.",
    style: "indie pop, jangly guitar, bright drums, mixed vocals, fresh",
    structuralTags: [{tag:"[Intro]"},{tag:"[Verse]"},{tag:"[Chorus]"},{tag:"[Verse]"},{tag:"[Chorus]"},{tag:"[Outro]"}],
    recommendedBpm: 110, recommendedKey: "G major" },

  // === Группа: friendship ===
  { slug: "best-friend", name: "Лучшему другу", category: "friendship",
    description: "Песня в подарок другу/подруге — благодарность за дружбу.",
    promptTemplate: "Через годы рядом. Слова дружбы и поддержки. Имя: {друг}.",
    style: "uplifting acoustic pop, claps, group vocals, sing-along chorus",
    structuralTags: [{tag:"[Intro]"},{tag:"[Verse]"},{tag:"[Chorus]"},{tag:"[Verse]"},{tag:"[Chorus]"},{tag:"[Bridge]"},{tag:"[Chorus]"},{tag:"[Outro]"}],
    recommendedBpm: 116, recommendedKey: "D major" },

  { slug: "reunion", name: "Встреча выпускников", category: "friendship",
    description: "Ностальгическая песня для класса/группы/команды через много лет.",
    promptTemplate: "Прошло {лет} лет. Старые истории, общие воспоминания. Год выпуска: {год}.",
    style: "nostalgic indie folk, warm vocals, acoustic guitar, brushed drums",
    structuralTags: [{tag:"[Intro]"},{tag:"[Verse]"},{tag:"[Chorus]"},{tag:"[Verse]"},{tag:"[Chorus]"},{tag:"[Outro]"}],
    recommendedBpm: 92, recommendedKey: "C major" },

  // === Группа: memory (расширение) ===
  { slug: "in-memory-pet", name: "Памяти питомца", category: "memory",
    description: "Тихая песня в память об ушедшем питомце.",
    promptTemplate: "Прощай, друг. Имя питомца: {кличка}. Особые воспоминания: {воспоминание}.",
    style: "quiet piano ballad, soft strings, gentle female vocal, melancholic",
    structuralTags: [{tag:"[Intro]"},{tag:"[Verse]"},{tag:"[Chorus]"},{tag:"[Verse]"},{tag:"[Chorus]"},{tag:"[Outro]"}],
    recommendedBpm: 68, recommendedKey: "F minor" },

  // === Группа: ethnic (расширение) ===
  { slug: "celtic", name: "Кельтская баллада", category: "ethnic",
    description: "Атмосферная баллада в кельтском духе — для тематических праздников.",
    promptTemplate: "Туманные холмы, древние истории, путь героя. Тема: {тема}.",
    style: "celtic folk, fiddle, tin whistle, bodhran, female lead",
    structuralTags: [{tag:"[Intro]"},{tag:"[Verse]"},{tag:"[Chorus]"},{tag:"[Verse]"},{tag:"[Chorus]"},{tag:"[Instrumental]"},{tag:"[Chorus]"},{tag:"[Outro]"}],
    recommendedBpm: 96, recommendedKey: "D minor" },

  { slug: "latin", name: "Латиноамериканская", category: "ethnic",
    description: "Жаркий латино-фьюжн — танцевальное настроение.",
    promptTemplate: "Танец, страсть, ритм. Адресат / повод: {кому}.",
    style: "latin pop, salsa percussion, brass, spanish guitar, bilingual hooks",
    structuralTags: [{tag:"[Intro]"},{tag:"[Verse]"},{tag:"[Pre-Chorus]"},{tag:"[Chorus]"},{tag:"[Verse]"},{tag:"[Chorus]"},{tag:"[Outro]"}],
    recommendedBpm: 105, recommendedKey: "A minor" },

  // === Группа: genre-demo (демо стилей) ===
  { slug: "genre-rock-anthem", name: "Демо: рок-гимн", category: "genre-demo",
    description: "Образец тяжёлого рок-гимна для проб стиля.",
    promptTemplate: "Свобода, восстание, энергия толпы. Тема: {тема}.",
    style: "arena rock, distorted guitars, big drums, anthemic male vocal, power chords",
    structuralTags: [{tag:"[Intro]"},{tag:"[Verse]"},{tag:"[Pre-Chorus]"},{tag:"[Chorus]"},{tag:"[Verse]"},{tag:"[Chorus]"},{tag:"[Solo]"},{tag:"[Chorus]"},{tag:"[Outro]"}],
    recommendedBpm: 130, recommendedKey: "E minor" },

  { slug: "genre-jazz", name: "Демо: джазовая баллада", category: "genre-demo",
    description: "Лаунж-джаз с тёплым саксофоном и мягким вокалом.",
    promptTemplate: "Поздний вечер, бокал, неон. Тема: {тема}.",
    style: "smooth jazz ballad, saxophone, brushed drums, upright bass, sultry female vocal",
    structuralTags: [{tag:"[Intro]"},{tag:"[Verse]"},{tag:"[Chorus]"},{tag:"[Verse]"},{tag:"[Chorus]"},{tag:"[Sax Solo]"},{tag:"[Chorus]"},{tag:"[Outro]"}],
    recommendedBpm: 84, recommendedKey: "Bb major" },

  { slug: "genre-rap", name: "Демо: рэп / hip-hop", category: "genre-demo",
    description: "Жёсткий рэп для тематической поздравлялки или диссa.",
    promptTemplate: "Городской ритм, чёткие punchlines. Тема: {тема}. Адресат: {кому}.",
    style: "modern hip-hop, hard 808 drums, melodic trap, male flow, catchy hook",
    structuralTags: [{tag:"[Intro]"},{tag:"[Verse]"},{tag:"[Hook]"},{tag:"[Verse]"},{tag:"[Hook]"},{tag:"[Bridge]"},{tag:"[Hook]"},{tag:"[Outro]"}],
    recommendedBpm: 90, recommendedKey: "G minor" },
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
  description: "Seeds 36 song templates по 9 группам (celebration/holiday/b2b/kids/love/friendship/memory/ethnic/genre-demo) и отдаёт их через GET /api/gen-templates.",
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
