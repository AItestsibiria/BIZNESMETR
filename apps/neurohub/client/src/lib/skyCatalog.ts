// Босс 2026-05-30 — Каталог реального звёздного неба для 3D-глобуса MuzaAi.
//
// Содержит:
// - BRIGHT_STARS — 40+ самых ярких звёзд (включая весь Большой Ковш). Координаты
//   RA (часы) / Dec (градусы) — эпоха J2000, magnitude — визуальная (V), spectral
//   class по Морган-Кинан.
// - CONSTELLATIONS — ключевые созвездия + их линии-связки (по Bayer-обозначениям).
// - raDecToVec3 — конвертация астрономических координат в 3D-вектор на сфере.
// - magToSize — magnitude → размер точки в пикселях.
// - spectralToColor — спектральный класс → RGB (диаграмма Герцшпрунга-Расселла).
//
// CLAUDE.md:
// - Russian-communication rule — все имена/комментарии по-русски (Bayer на латинице — это термин).
// - Reuse-working-solutions rule — единый источник правды для каталога неба.
// - No-duplicates rule — не дублировать данные между файлами.

// @ts-expect-error — нет @types/three; runtime-импорт валиден, типы добавим вместе с @types/three.
import * as THREE_NS from "three";
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const THREE: any = THREE_NS as any;

// Единый радиус «небесной сферы» для звёзд + созвездий + flight-target.
// Босс 2026-05-31 — unified STARFIELD_RADIUS:
// раньше отрисовка использовала 280000, flight target — 50000 → камера не долетала.
// Теперь оба значения из одной константы (Pricing-single-source-style).
export const STARFIELD_RADIUS = 280000;

export type SpectralClass = "O" | "B" | "A" | "F" | "G" | "K" | "M";

export interface StarRecord {
  id: string;              // машинный идентификатор (sirius, vega, ...)
  name: string;            // русское имя звезды (Сириус, Вега, ...)
  bayer: string;           // Bayer-обозначение (α CMa, β Ori, ...) — латиница, астрономический стандарт
  constellation: string;   // русское имя созвездия
  ra: number;              // прямое восхождение, часы (0..24)
  dec: number;             // склонение, градусы (-90..+90)
  mag: number;             // видимая звёздная величина (visual magnitude)
  spectralClass: SpectralClass;
}

// 40+ ярчайших звёзд — северное + южное небо. Включён весь Большой Ковш
// (7 звёзд) для корректного рисунка астеризма.
export const BRIGHT_STARS: StarRecord[] = [
  // Ярчайшие (mag < 1.0)
  { id: "sirius",     name: "Сириус",     bayer: "α CMa", constellation: "Большой Пёс",  ra:  6.7525, dec: -16.7161, mag: -1.46, spectralClass: "A" },
  { id: "canopus",    name: "Канопус",    bayer: "α Car", constellation: "Киль",         ra:  6.3992, dec: -52.6957, mag: -0.74, spectralClass: "F" },
  { id: "arcturus",   name: "Арктур",     bayer: "α Boo", constellation: "Волопас",      ra: 14.2610, dec:  19.1825, mag: -0.05, spectralClass: "K" },
  { id: "rigil",      name: "Альфа Центавра", bayer: "α Cen", constellation: "Центавр",  ra: 14.6600, dec: -60.8350, mag: -0.27, spectralClass: "G" },
  { id: "vega",       name: "Вега",       bayer: "α Lyr", constellation: "Лира",         ra: 18.6156, dec:  38.7837, mag:  0.03, spectralClass: "A" },
  { id: "capella",    name: "Капелла",    bayer: "α Aur", constellation: "Возничий",     ra:  5.2782, dec:  45.9981, mag:  0.08, spectralClass: "G" },
  { id: "rigel",      name: "Ригель",     bayer: "β Ori", constellation: "Орион",        ra:  5.2422, dec:  -8.2017, mag:  0.13, spectralClass: "B" },
  { id: "procyon",    name: "Процион",    bayer: "α CMi", constellation: "Малый Пёс",    ra:  7.6550, dec:   5.2250, mag:  0.34, spectralClass: "F" },
  { id: "achernar",   name: "Ахернар",    bayer: "α Eri", constellation: "Эридан",       ra:  1.6286, dec: -57.2367, mag:  0.46, spectralClass: "B" },
  { id: "betelgeuse", name: "Бетельгейзе", bayer: "α Ori", constellation: "Орион",       ra:  5.9195, dec:   7.4071, mag:  0.42, spectralClass: "M" },
  { id: "hadar",      name: "Бета Центавра", bayer: "β Cen", constellation: "Центавр",   ra: 14.0637, dec: -60.3729, mag:  0.61, spectralClass: "B" },
  { id: "altair",     name: "Альтаир",    bayer: "α Aql", constellation: "Орёл",         ra: 19.8463, dec:   8.8683, mag:  0.77, spectralClass: "A" },
  { id: "acrux",      name: "Акрукс",     bayer: "α Cru", constellation: "Южный Крест",  ra: 12.4433, dec: -63.0991, mag:  0.77, spectralClass: "B" },
  { id: "aldebaran",  name: "Альдебаран", bayer: "α Tau", constellation: "Телец",        ra:  4.5987, dec:  16.5093, mag:  0.85, spectralClass: "K" },
  { id: "antares",    name: "Антарес",    bayer: "α Sco", constellation: "Скорпион",     ra: 16.4901, dec: -26.4320, mag:  1.09, spectralClass: "M" },
  { id: "spica",      name: "Спика",      bayer: "α Vir", constellation: "Дева",         ra: 13.4199, dec: -11.1614, mag:  1.04, spectralClass: "B" },
  { id: "pollux",     name: "Поллукс",    bayer: "β Gem", constellation: "Близнецы",     ra:  7.7553, dec:  28.0262, mag:  1.14, spectralClass: "K" },
  { id: "fomalhaut",  name: "Фомальгаут", bayer: "α PsA", constellation: "Южная Рыба",   ra: 22.9608, dec: -29.6222, mag:  1.16, spectralClass: "A" },
  { id: "deneb",      name: "Денеб",      bayer: "α Cyg", constellation: "Лебедь",       ra: 20.6905, dec:  45.2803, mag:  1.25, spectralClass: "A" },
  { id: "mimosa",     name: "Бета Южного Креста", bayer: "β Cru", constellation: "Южный Крест", ra: 12.7953, dec: -59.6886, mag: 1.25, spectralClass: "B" },
  { id: "regulus",    name: "Регул",      bayer: "α Leo", constellation: "Лев",          ra: 10.1395, dec:  11.9672, mag:  1.36, spectralClass: "B" },
  { id: "adhara",     name: "Адхара",     bayer: "ε CMa", constellation: "Большой Пёс",  ra:  6.9770, dec: -28.9722, mag:  1.50, spectralClass: "B" },
  { id: "castor",     name: "Кастор",     bayer: "α Gem", constellation: "Близнецы",     ra:  7.5766, dec:  31.8883, mag:  1.58, spectralClass: "A" },
  { id: "gacrux",     name: "Гакрукс",    bayer: "γ Cru", constellation: "Южный Крест",  ra: 12.5194, dec: -57.1133, mag:  1.59, spectralClass: "M" },
  { id: "shaula",     name: "Шаула",      bayer: "λ Sco", constellation: "Скорпион",     ra: 17.5601, dec: -37.1038, mag:  1.62, spectralClass: "B" },
  { id: "bellatrix",  name: "Беллатрикс", bayer: "γ Ori", constellation: "Орион",        ra:  5.4188, dec:   6.3497, mag:  1.64, spectralClass: "B" },
  { id: "elnath",     name: "Эльнат",     bayer: "β Tau", constellation: "Телец",        ra:  5.4382, dec:  28.6075, mag:  1.65, spectralClass: "B" },
  { id: "alnilam",    name: "Альнилам",   bayer: "ε Ori", constellation: "Орион",        ra:  5.6036, dec:  -1.2019, mag:  1.69, spectralClass: "B" },
  { id: "alnitak",    name: "Альнитак",   bayer: "ζ Ori", constellation: "Орион",        ra:  5.6793, dec:  -1.9426, mag:  1.74, spectralClass: "O" },
  { id: "mintaka",    name: "Минтака",    bayer: "δ Ori", constellation: "Орион",        ra:  5.5334, dec:  -0.2991, mag:  2.23, spectralClass: "O" },
  { id: "alioth",     name: "Алиот",      bayer: "ε UMa", constellation: "Большая Медведица", ra: 12.9004, dec: 55.9598, mag: 1.77, spectralClass: "A" },
  { id: "dubhe",      name: "Дубхе",      bayer: "α UMa", constellation: "Большая Медведица", ra: 11.0621, dec: 61.7508, mag: 1.79, spectralClass: "K" },
  { id: "alkaid",     name: "Алькаид",    bayer: "η UMa", constellation: "Большая Медведица", ra: 13.7923, dec: 49.3133, mag: 1.86, spectralClass: "B" },
  { id: "merak",      name: "Мерак",      bayer: "β UMa", constellation: "Большая Медведица", ra: 11.0307, dec: 56.3824, mag: 2.37, spectralClass: "A" },
  { id: "phecda",     name: "Фекда",      bayer: "γ UMa", constellation: "Большая Медведица", ra: 11.8972, dec: 53.6948, mag: 2.44, spectralClass: "A" },
  { id: "megrez",     name: "Мегрец",     bayer: "δ UMa", constellation: "Большая Медведица", ra: 12.2571, dec: 57.0326, mag: 3.31, spectralClass: "A" },
  { id: "mizar",      name: "Мицар",      bayer: "ζ UMa", constellation: "Большая Медведица", ra: 13.3988, dec: 54.9254, mag: 2.04, spectralClass: "A" },
  { id: "polaris",    name: "Полярная",   bayer: "α UMi", constellation: "Малая Медведица", ra:  2.5302, dec: 89.2641, mag: 1.97, spectralClass: "F" },
  { id: "kochab",     name: "Кохаб",      bayer: "β UMi", constellation: "Малая Медведица", ra: 14.8451, dec: 74.1556, mag: 2.07, spectralClass: "K" },
  // Кассиопея (W-форма)
  { id: "schedar",    name: "Шедар",      bayer: "α Cas", constellation: "Кассиопея",    ra:  0.6751, dec:  56.5374, mag:  2.23, spectralClass: "K" },
  { id: "caph",       name: "Каф",        bayer: "β Cas", constellation: "Кассиопея",    ra:  0.1530, dec:  59.1498, mag:  2.27, spectralClass: "F" },
  { id: "tsih",       name: "Гамма Кассиопеи", bayer: "γ Cas", constellation: "Кассиопея", ra: 0.9456, dec: 60.7167, mag: 2.47, spectralClass: "B" },
  { id: "ruchbah",    name: "Рукбах",     bayer: "δ Cas", constellation: "Кассиопея",    ra:  1.4302, dec:  60.2353, mag:  2.68, spectralClass: "A" },
  { id: "segin",      name: "Сегин",      bayer: "ε Cas", constellation: "Кассиопея",    ra:  1.9067, dec:  63.6701, mag:  3.38, spectralClass: "B" },
  // Лебедь (Северный крест) — кроме Денеба
  { id: "sadr",       name: "Садр",       bayer: "γ Cyg", constellation: "Лебедь",       ra: 20.3704, dec:  40.2566, mag:  2.23, spectralClass: "F" },
  { id: "gienah_cyg", name: "Гиена",      bayer: "ε Cyg", constellation: "Лебедь",       ra: 20.7702, dec:  33.9703, mag:  2.48, spectralClass: "K" },
  { id: "albireo",    name: "Альбирео",   bayer: "β Cyg", constellation: "Лебедь",       ra: 19.5121, dec:  27.9597, mag:  3.18, spectralClass: "K" },
  // Андромеда, Пегас
  { id: "alpheratz",  name: "Альферац",   bayer: "α And", constellation: "Андромеда",    ra:  0.1398, dec:  29.0904, mag:  2.06, spectralClass: "B" },
  { id: "mirach",     name: "Мирах",      bayer: "β And", constellation: "Андромеда",    ra:  1.1622, dec:  35.6206, mag:  2.05, spectralClass: "M" },
  { id: "almach",     name: "Аламак",     bayer: "γ And", constellation: "Андромеда",    ra:  2.0649, dec:  42.3297, mag:  2.10, spectralClass: "K" },
  { id: "scheat",     name: "Шеат",       bayer: "β Peg", constellation: "Пегас",        ra: 23.0629, dec:  28.0828, mag:  2.42, spectralClass: "M" },
  { id: "markab",     name: "Маркаб",     bayer: "α Peg", constellation: "Пегас",        ra: 23.0793, dec:  15.2053, mag:  2.49, spectralClass: "B" },
  { id: "algenib",    name: "Альгениб",   bayer: "γ Peg", constellation: "Пегас",        ra:  0.2206, dec:  15.1836, mag:  2.83, spectralClass: "B" },
];

// Линии созвездий — соединения по id-звёздам из BRIGHT_STARS. Если звезда
// отсутствует в каталоге, линия пропускается (graceful-skip).
export interface ConstellationLine {
  from: string; // id звезды из BRIGHT_STARS
  to: string;
}

export interface Constellation {
  id: string;
  name: string;      // латинское имя (Ursa Major)
  ru_name: string;   // русское имя (Большая Медведица)
  lines: ConstellationLine[];
}

export const CONSTELLATIONS: Constellation[] = [
  {
    id: "ursa_major",
    name: "Ursa Major",
    ru_name: "Большая Медведица",
    lines: [
      { from: "dubhe",  to: "merak"  },
      { from: "merak",  to: "phecda" },
      { from: "phecda", to: "megrez" },
      { from: "megrez", to: "dubhe"  },
      { from: "megrez", to: "alioth" },
      { from: "alioth", to: "mizar"  },
      { from: "mizar",  to: "alkaid" },
    ],
  },
  {
    id: "orion",
    name: "Orion",
    ru_name: "Орион",
    lines: [
      { from: "betelgeuse", to: "bellatrix" },
      { from: "bellatrix",  to: "mintaka"   },
      { from: "mintaka",    to: "alnilam"   },
      { from: "alnilam",    to: "alnitak"   },
      { from: "alnitak",    to: "betelgeuse"},
      { from: "rigel",      to: "mintaka"   },
    ],
  },
  {
    id: "cassiopeia",
    name: "Cassiopeia",
    ru_name: "Кассиопея",
    lines: [
      { from: "segin",   to: "ruchbah" },
      { from: "ruchbah", to: "tsih"    },
      { from: "tsih",    to: "schedar" },
      { from: "schedar", to: "caph"    },
    ],
  },
  {
    id: "cygnus",
    name: "Cygnus",
    ru_name: "Лебедь",
    lines: [
      { from: "deneb",      to: "sadr"       },
      { from: "sadr",       to: "albireo"    },
      { from: "sadr",       to: "gienah_cyg" },
    ],
  },
  {
    id: "ursa_minor",
    name: "Ursa Minor",
    ru_name: "Малая Медведица",
    lines: [
      { from: "polaris", to: "kochab" },
    ],
  },
  {
    id: "andromeda",
    name: "Andromeda",
    ru_name: "Андромеда",
    lines: [
      { from: "alpheratz", to: "mirach" },
      { from: "mirach",    to: "almach" },
    ],
  },
  {
    id: "pegasus",
    name: "Pegasus",
    ru_name: "Пегас",
    lines: [
      { from: "scheat",    to: "markab"    },
      { from: "markab",    to: "algenib"   },
      { from: "algenib",   to: "alpheratz" },
      { from: "alpheratz", to: "scheat"    },
    ],
  },
  {
    id: "crux",
    name: "Crux",
    ru_name: "Южный Крест",
    lines: [
      { from: "acrux",  to: "gacrux" },
      { from: "mimosa", to: "acrux"  },
    ],
  },
];

// RA (часы 0..24) + Dec (градусы -90..+90) → 3D-вектор на сфере радиуса `radius`.
// Соглашение совпадает с three.js: y — «вверх» (полюс мира), x/z — экваториальная
// плоскость. RA умножается на 15° (1 час = 15°), знак подобран так, чтобы вращение
// «по часовой стрелке для наблюдателя с Земли» совпадало с астрономическим небом.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function raDecToVec3(ra: number, dec: number, radius: number): any {
  const raRad = (ra * 15 * Math.PI) / 180;   // долгота
  const decRad = (dec * Math.PI) / 180;      // широта
  const x = radius * Math.cos(decRad) * Math.cos(raRad);
  const y = radius * Math.sin(decRad);
  const z = -radius * Math.cos(decRad) * Math.sin(raRad);
  return new THREE.Vector3(x, y, z);
}

// Magnitude (видимая величина) → размер точки в пикселях. Чем меньше mag, тем
// ярче и крупнее звезда. Босс 2026-05-30 «Сириус сильно ярче остальных»:
// расширил диапазон до 3..14px (было 1..6) — Сириус ≈ 13.6px, mag 1 ≈ 9px,
// mag 3 ≈ 5px. Чтобы реальные звёзды доминировали над фоновым шумом 800 точек.
export function magToSize(mag: number): number {
  // size = clamp(10 - 1.8 * mag, 3.0, 14.0)
  return Math.max(3.0, Math.min(14.0, 10.0 - 1.8 * mag));
}

// Magnitude → opacity (0.85..1.0): почти все яркие звёзды читаемы. Тусклые чуть мягче.
export function magToOpacity(mag: number): number {
  return Math.max(0.85, Math.min(1.0, 1.1 - 0.06 * mag));
}

// Спектральный класс → RGB-цвет (0..1) по диаграмме Герцшпрунга-Расселла.
// O — голубой ~30000 K, B — бело-голубой, A — белый, F — бледно-жёлтый,
// G — жёлтый (Солнце), K — оранжевый, M — красный ~3000 K.
// Босс 2026-05-30 «цвета saturated» — увеличена насыщенность для O/B (голубые
// заметно холоднее), K/M (оранжево-красные заметно теплее). Чтобы спектральная
// разница была видна глазом, не только в коде.
export function spectralToColor(cls: SpectralClass): [number, number, number] {
  switch (cls) {
    case "O": return [0.45, 0.60, 1.00]; // насыщенный голубой
    case "B": return [0.65, 0.78, 1.00]; // бело-голубой
    case "A": return [0.95, 0.97, 1.00]; // белый (чуть холодный)
    case "F": return [1.00, 0.98, 0.88]; // бледно-жёлтый
    case "G": return [1.00, 0.93, 0.68]; // жёлтый (Солнце)
    case "K": return [1.00, 0.75, 0.45]; // насыщенный оранжевый
    case "M": return [1.00, 0.55, 0.35]; // насыщенный красно-оранжевый
    default:  return [1.00, 1.00, 1.00];
  }
}

// Быстрый поиск звезды по id (для рисования линий созвездий).
const STAR_BY_ID: Record<string, StarRecord> = (() => {
  const m: Record<string, StarRecord> = {};
  for (const s of BRIGHT_STARS) m[s.id] = s;
  return m;
})();

export function getStarById(id: string): StarRecord | undefined {
  return STAR_BY_ID[id];
}
