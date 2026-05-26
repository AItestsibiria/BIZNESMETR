// globe-view.tsx — настоящий 3D-глобус Земли (ФАЗА 1, без погоды).
// Eugene 2026-05-26 Босс «настоящий 3D-глобус, реальная география континентов,
// вращение планеты, стильный, с зумом».
//
// Архитектура изоляции (глобус НЕ должен ломать страницу):
//   1. Lazy-load: react-globe.gl (обёртка three-globe) грузится через
//      React.lazy(() => import("react-globe.gl")) + <Suspense> — тяжёлый chunk
//      (three.js ~600KB) не попадает в main bundle. Образец lazy-подхода —
//      second-brain-3d.tsx (там import() внутри useEffect; здесь компонент
//      сам React-узел, поэтому правильнее React.lazy + Suspense).
//   2. ErrorBoundary (GlobeErrorBoundary) ловит ЛЮБУЮ ошибку рендера/инициализации
//      глобуса (WebGL недоступен / CDN-текстура не загрузилась / несовместимая
//      версия) → мягкий fallback (список стран). Никаких throw наружу.
//   3. Feature-toggle "globe-3d" (default ON) — проверяется на стороне landing.
//   4. Responsive (Device-fit-100 rule): высота через dvh + safe-area задаётся
//      обёрткой; сам глобус подстраивается под размер контейнера (ResizeObserver).
//
// Реальная геометрия континентов = equirectangular earth-текстура с CDN
// (jsdelivr three-globe example img). Текстуры тянутся в БРАУЗЕРЕ юзера в рантайме.
//
// Brand-style consistency rule: маркеры/atmosphere/glow в фирменной палитре
// (Cyber Violet #7C3AED / Electric Blue #00D4FF / Hot Magenta #FF006E).
//
// Источник данных стран — /api/playlist/geo-top и /api/public/countries-count
// (Reuse-working-solutions rule). Маркеры наносятся по lat/lon через таблицу
// центроидов стран по ISO alpha-2.

import {
  Component,
  Suspense,
  lazy,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import * as THREE from "three";

// React.lazy грузит react-globe.gl отдельным chunk'ом. Если пакета нет в
// бандле / ошибка импорта — ErrorBoundary поймает на этапе рендера Suspense.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const Globe = lazy(() => import("react-globe.gl") as Promise<{ default: any }>);

// День/Ночь ShaderMaterial — собирается лениво (нужен THREE.TextureLoader,
// который безопасен только в браузере). Кэшируем, чтобы не пересоздавать.
// Возвращает { material, uniforms } или null при ошибке загрузки текстур.
function buildDayNightMaterial(): {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  material: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  uniforms: any;
} | null {
  try {
    const loader = new THREE.TextureLoader();
    loader.setCrossOrigin("anonymous");
    const dayTex = loader.load(EARTH_DAY_URL);
    const nightTex = loader.load(EARTH_NIGHT_URL);
    // sRGB-кодировка текстур (иначе день слишком тёмный).
    try {
      // three >=0.152: colorSpace; старее: encoding. Покрываем оба.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (dayTex as any).colorSpace = (THREE as any).SRGBColorSpace ?? (dayTex as any).colorSpace;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (nightTex as any).colorSpace = (THREE as any).SRGBColorSpace ?? (nightTex as any).colorSpace;
    } catch {
      // ignore
    }
    const uniforms = {
      dayTexture: { value: dayTex },
      nightTexture: { value: nightTex },
      sunPosition: { value: new THREE.Vector2() },
      globeRotation: { value: new THREE.Vector2() },
    };
    const material = new THREE.ShaderMaterial({
      uniforms,
      vertexShader: DAY_NIGHT_VERTEX,
      fragmentShader: DAY_NIGHT_FRAGMENT,
    });
    return { material, uniforms };
  } catch (e) {
    console.error("[GlobeView] buildDayNightMaterial failed:", e);
    return null;
  }
}

// ───────────────────────────────────────────────────────────────────────────
// Текстуры Земли (CDN, грузятся в браузере юзера). Реальная география.
// День — earth-day (blue-marble дневная сторона). Ночь — earth-night
// («black marble» NASA: городские/столичные огни). Смешиваются по терминатору
// в кастомном day/night шейдере (см. buildDayNightMaterial ниже).
// Eugene 2026-05-26 Босс «учитывай реальное положение Солнца, ночная сторона —
// текстура ночных огней, день/ночь шейдер как в офиц. примере react-globe.gl».
const EARTH_DAY_URL = "//cdn.jsdelivr.net/npm/three-globe/example/img/earth-day.jpg";
const EARTH_NIGHT_URL = "//unpkg.com/three-globe/example/img/earth-night.jpg";
const EARTH_BUMP_URL = "//cdn.jsdelivr.net/npm/three-globe/example/img/earth-topology.png";

// ───────────────────────────────────────────────────────────────────────────
// Day/Night шейдер — точный порт официального примера react-globe.gl
// «Day/Night Cycle» (github.com/vasturiano/react-globe.gl example/day-night-cycle).
// Источник (Docs-first-always rule): два sampler2D (dayTexture/nightTexture),
// uniform sunPosition [subsolarLng, declination] + globeRotation [lng,lat камеры].
// Во fragment shader: переводим субсолярную точку в декартов вектор, поворачиваем
// его обратными матрицами под текущий разворот глобуса, считаем
// intensity = dot(normal, sunDir); smoothstep даёт мягкий терминатор; mix night↔day.
const DAY_NIGHT_VERTEX = `
  varying vec3 vNormal;
  varying vec2 vUv;
  void main() {
    vNormal = normalize(normalMatrix * normal);
    vUv = uv;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

const DAY_NIGHT_FRAGMENT = `
  #define PI 3.141592653589793
  uniform sampler2D dayTexture;
  uniform sampler2D nightTexture;
  uniform vec2 sunPosition;
  uniform vec2 globeRotation;
  varying vec3 vNormal;
  varying vec2 vUv;

  float toRad(in float a) { return a * PI / 180.0; }

  vec3 Polar2Cartesian(in vec2 c) { // [lng, lat]
    float theta = toRad(90.0 - c.x);
    float phi = toRad(90.0 - c.y);
    return vec3(
      sin(phi) * cos(theta),
      cos(phi),
      sin(phi) * sin(theta)
    );
  }

  void main() {
    float invLon = toRad(globeRotation.x);
    float invLat = -toRad(globeRotation.y);
    mat3 rotX = mat3(
      1, 0, 0,
      0, cos(invLat), -sin(invLat),
      0, sin(invLat), cos(invLat)
    );
    mat3 rotY = mat3(
      cos(invLon), 0, sin(invLon),
      0, 1, 0,
      -sin(invLon), 0, cos(invLon)
    );
    vec3 rotatedSunDirection = rotX * rotY * Polar2Cartesian(sunPosition);
    float intensity = dot(normalize(vNormal), normalize(rotatedSunDirection));
    vec4 dayColor = texture2D(dayTexture, vUv);
    vec4 nightColor = texture2D(nightTexture, vUv);
    float blendFactor = smoothstep(-0.1, 0.1, intensity);
    gl_FragColor = mix(nightColor, dayColor, blendFactor);
  }
`;

// ───────────────────────────────────────────────────────────────────────────
// Положение Солнца (субсолярная точка) по текущему UTC.
// Возвращает [subsolarLongitude (°), declination (°)].
//   • subsolarLongitude — долгота, над которой Солнце в зените (местный солнечный
//     полдень). Формула из офиц. примера (день - dt → доля суток), минус поправка
//     equation-of-time / 4 (минуты → градусы долготы, 1 мин = 0.25°).
//   • declination — солнечное склонение (наклон Солнца к экватору) по дню года.
// Реализация без npm solar-calculator — стандартные NOAA-аппроксимации (точности
// ±0.2° более чем достаточно для ориентации терминатора день/ночь).
function julianCentury(dt: number): number {
  // Юлианская дата → юлианские столетия от J2000.0.
  const jd = dt / 86400000 + 2440587.5;
  return (jd - 2451545.0) / 36525.0;
}

function solarDeclinationDeg(t: number): number {
  // Геометрическая средняя долгота и аномалия Солнца (NOAA).
  const L0 = (280.46646 + t * (36000.76983 + t * 0.0003032)) % 360;
  const M = 357.52911 + t * (35999.05029 - 0.0001537 * t);
  const Mrad = (M * Math.PI) / 180;
  const C =
    Math.sin(Mrad) * (1.914602 - t * (0.004817 + 0.000014 * t)) +
    Math.sin(2 * Mrad) * (0.019993 - 0.000101 * t) +
    Math.sin(3 * Mrad) * 0.000289;
  const trueLong = L0 + C; // истинная долгота Солнца
  const omega = 125.04 - 1934.136 * t;
  const lambda = trueLong - 0.00569 - 0.00478 * Math.sin((omega * Math.PI) / 180);
  // Наклон эклиптики (с поправкой нутации).
  const seconds = 21.448 - t * (46.815 + t * (0.00059 - t * 0.001813));
  let eps0 = 23 + (26 + seconds / 60) / 60;
  eps0 += 0.00256 * Math.cos((omega * Math.PI) / 180);
  const sinDecl = Math.sin((eps0 * Math.PI) / 180) * Math.sin((lambda * Math.PI) / 180);
  return (Math.asin(sinDecl) * 180) / Math.PI;
}

function equationOfTimeMin(t: number): number {
  // Уравнение времени (минуты) — NOAA.
  const epsilon = 23.43929111 - t * (0.013004167 + t * (1.6389e-7 - t * 5.036e-7));
  const L0 = (280.46646 + t * (36000.76983 + t * 0.0003032)) % 360;
  const M = 357.52911 + t * (35999.05029 - 0.0001537 * t);
  const e = 0.016708634 - t * (0.000042037 + 0.0000001267 * t);
  const y = Math.tan((epsilon * Math.PI) / 360) ** 2;
  const L0r = (L0 * Math.PI) / 180;
  const Mr = (M * Math.PI) / 180;
  const Etime =
    y * Math.sin(2 * L0r) -
    2 * e * Math.sin(Mr) +
    4 * e * y * Math.sin(Mr) * Math.cos(2 * L0r) -
    0.5 * y * y * Math.sin(4 * L0r) -
    1.25 * e * e * Math.sin(2 * Mr);
  return ((Etime * 180) / Math.PI) * 4; // радианы → градусы → минуты (×4)
}

function subsolarPoint(dt: number): [number, number] {
  const day = new Date(dt).setUTCHours(0, 0, 0, 0);
  const t = julianCentury(dt);
  const longitude = ((day - dt) / 864e5) * 360 - 180;
  const lng = longitude - equationOfTimeMin(t) / 4;
  const lat = solarDeclinationDeg(t);
  return [lng, lat];
}

// Нормаль поверхности в точке (lat,lng) — тот же базис Polar2Cartesian что в
// шейдере (конвенция [lng,lat]). dot с sunDir > 0 = день, < 0 = ночь.
function surfaceNormal(lat: number, lng: number): [number, number, number] {
  const theta = ((90 - lng) * Math.PI) / 180;
  const phi = ((90 - lat) * Math.PI) / 180;
  return [Math.sin(phi) * Math.cos(theta), Math.cos(phi), Math.sin(phi) * Math.sin(theta)];
}

// Единичный вектор на Солнце в тех же мировых координатах (для CPU-расчёта яркости).
function sunDirWorld([lng, lat]: [number, number]): [number, number, number] {
  return surfaceNormal(lat, lng);
}

// Освещённость точки: dot(normal, sunDir) ∈ [-1..1]. >0 — день, <0 — ночь.
function illumination(lat: number, lng: number, sunDir: [number, number, number]): number {
  const n = surfaceNormal(lat, lng);
  return n[0] * sunDir[0] + n[1] * sunDir[1] + n[2] * sunDir[2];
}

// ───────────────────────────────────────────────────────────────────────────
// Центроиды стран по ISO 3166-1 alpha-2 (lat, lon). Топ для нашей аудитории +
// распространённые мировые. Fallback null если кода нет — точка не рисуется.
const COUNTRY_CENTROIDS: Record<string, [number, number]> = {
  RU: [61.52, 105.31],   // Россия
  US: [37.09, -95.71],   // США
  KZ: [48.02, 66.92],    // Казахстан
  BY: [53.71, 27.95],    // Беларусь
  UA: [48.38, 31.17],    // Украина
  DE: [51.17, 10.45],    // Германия
  GB: [55.38, -3.44],    // Великобритания
  FR: [46.23, 2.21],     // Франция
  IT: [41.87, 12.57],    // Италия
  ES: [40.46, -3.75],    // Испания
  PL: [51.92, 19.15],    // Польша
  NL: [52.13, 5.29],     // Нидерланды
  MD: [47.41, 28.37],    // Молдова
  TR: [38.96, 35.24],    // Турция
  CN: [35.86, 104.20],   // Китай
  JP: [36.20, 138.25],   // Япония
  IN: [20.59, 78.96],    // Индия
  BR: [-14.24, -51.93],  // Бразилия
  CA: [56.13, -106.35],  // Канада
  AU: [-25.27, 133.78],  // Австралия
  IL: [31.05, 34.85],    // Израиль
  AE: [23.42, 53.85],    // ОАЭ
  GE: [42.32, 43.36],    // Грузия
  AM: [40.07, 45.04],    // Армения
  AZ: [40.14, 47.58],    // Азербайджан
  UZ: [41.38, 64.59],    // Узбекистан
  KG: [41.20, 74.77],    // Кыргызстан
  TJ: [38.86, 71.28],    // Таджикистан
  TM: [38.97, 59.56],    // Туркменистан
  FI: [61.92, 25.75],    // Финляндия
  SE: [60.13, 18.64],    // Швеция
  NO: [60.47, 8.47],     // Норвегия
  CZ: [49.82, 15.47],    // Чехия
  AT: [47.52, 14.55],    // Австрия
  CH: [46.82, 8.23],     // Швейцария
  BE: [50.50, 4.47],     // Бельгия
  PT: [39.40, -8.22],    // Португалия
  GR: [39.07, 21.82],    // Греция
  RO: [45.94, 24.97],    // Румыния
  HU: [47.16, 19.50],    // Венгрия
  BG: [42.73, 25.49],    // Болгария
  RS: [44.02, 21.01],    // Сербия
  KR: [35.91, 127.77],   // Южная Корея
  TH: [15.87, 100.99],   // Таиланд
  VN: [14.06, 108.28],   // Вьетнам
  ID: [-0.79, 113.92],   // Индонезия
  MX: [23.63, -102.55],  // Мексика
  AR: [-38.42, -63.62],  // Аргентина
  EG: [26.82, 30.80],    // Египет
  ZA: [-30.56, 22.94],   // ЮАР
  EE: [58.60, 25.01],    // Эстония
  LV: [56.88, 24.60],    // Латвия
  LT: [55.17, 23.88],    // Литва
  IE: [53.41, -8.24],    // Ирландия
};

// Маппинг названий на ISO-код (на случай если придёт name без code).
const NAME_TO_CODE: Record<string, string> = {
  "Россия": "RU", "Russia": "RU",
  "США": "US", "United States": "US",
  "Казахстан": "KZ", "Kazakhstan": "KZ",
  "Беларусь": "BY", "Belarus": "BY",
  "Украина": "UA", "Ukraine": "UA",
  "Германия": "DE", "Germany": "DE",
  "Великобритания": "GB", "United Kingdom": "GB",
  "Франция": "FR", "France": "FR",
  "Италия": "IT", "Italy": "IT",
  "Испания": "ES", "Spain": "ES",
  "Польша": "PL", "Poland": "PL",
  "Нидерланды": "NL", "Netherlands": "NL",
  "Молдова": "MD", "Moldova": "MD",
  "Турция": "TR", "Turkey": "TR",
};

function resolveLatLon(code: string, name?: string): [number, number] | null {
  const cc = (code && code.length === 2 ? code : (name && NAME_TO_CODE[name])) || "";
  if (cc && COUNTRY_CENTROIDS[cc.toUpperCase()]) return COUNTRY_CENTROIDS[cc.toUpperCase()];
  return null;
}

// ───────────────────────────────────────────────────────────────────────────
// Столицы стран по ISO alpha-2 [lat, lon] — Eugene 2026-05-26 Босс «столицы
// стран-слушателей на ночной стороне подчёркивай (яркая точка на координате
// столицы когда она в тени)». Если столицы нет в таблице — fallback на центроид.
const COUNTRY_CAPITALS: Record<string, [number, number]> = {
  RU: [55.75, 37.62],    // Москва
  US: [38.90, -77.04],   // Вашингтон
  KZ: [51.17, 71.43],    // Астана
  BY: [53.90, 27.57],    // Минск
  UA: [50.45, 30.52],    // Киев
  DE: [52.52, 13.41],    // Берлин
  GB: [51.51, -0.13],    // Лондон
  FR: [48.86, 2.35],     // Париж
  IT: [41.90, 12.50],    // Рим
  ES: [40.42, -3.70],    // Мадрид
  PL: [52.23, 21.01],    // Варшава
  NL: [52.37, 4.90],     // Амстердам
  MD: [47.01, 28.86],    // Кишинёв
  TR: [39.93, 32.87],    // Анкара
  CN: [39.90, 116.41],   // Пекин
  JP: [35.68, 139.69],   // Токио
  IN: [28.61, 77.21],    // Нью-Дели
  BR: [-15.79, -47.88],  // Бразилиа
  CA: [45.42, -75.70],   // Оттава
  AU: [-35.28, 149.13],  // Канберра
  IL: [31.78, 35.22],    // Иерусалим
  AE: [24.45, 54.38],    // Абу-Даби
  GE: [41.72, 44.78],    // Тбилиси
  AM: [40.18, 44.51],    // Ереван
  AZ: [40.41, 49.87],    // Баку
  UZ: [41.30, 69.24],    // Ташкент
  KG: [42.87, 74.59],    // Бишкек
  TJ: [38.56, 68.79],    // Душанбе
  TM: [37.95, 58.38],    // Ашхабад
  FI: [60.17, 24.94],    // Хельсинки
  SE: [59.33, 18.07],    // Стокгольм
  NO: [59.91, 10.75],    // Осло
  CZ: [50.08, 14.44],    // Прага
  AT: [48.21, 16.37],    // Вена
  CH: [46.95, 7.45],     // Берн
  BE: [50.85, 4.35],     // Брюссель
  PT: [38.72, -9.14],    // Лиссабон
  GR: [37.98, 23.73],    // Афины
  RO: [44.43, 26.10],    // Бухарест
  HU: [47.50, 19.04],    // Будапешт
  BG: [42.70, 23.32],    // София
  RS: [44.79, 20.45],    // Белград
  KR: [37.57, 126.98],   // Сеул
  TH: [13.76, 100.50],   // Бангкок
  VN: [21.03, 105.85],   // Ханой
  ID: [-6.21, 106.85],   // Джакарта
  MX: [19.43, -99.13],   // Мехико
  AR: [-34.60, -58.38],  // Буэнос-Айрес
  EG: [30.04, 31.24],    // Каир
  ZA: [-25.75, 28.19],   // Претория
  EE: [59.44, 24.75],    // Таллин
  LV: [56.95, 24.11],    // Рига
  LT: [54.69, 25.28],    // Вильнюс
  IE: [53.35, -6.26],    // Дублин
};

function resolveCapital(code: string, name?: string): [number, number] | null {
  const cc = (code && code.length === 2 ? code : (name && NAME_TO_CODE[name])) || "";
  const up = cc.toUpperCase();
  if (up && COUNTRY_CAPITALS[up]) return COUNTRY_CAPITALS[up];
  // Fallback — центроид (если столицы нет, но страна известна).
  if (up && COUNTRY_CENTROIDS[up]) return COUNTRY_CENTROIDS[up];
  return null;
}

// Brand palette для маркеров/колец — purple / cyan / fuchsia.
const BRAND_PURPLE = "#7C3AED";
const BRAND_CYAN = "#00D4FF";
const BRAND_FUCHSIA = "#FF006E";
const MARKER_COLORS = [BRAND_PURPLE, BRAND_CYAN, BRAND_FUCHSIA, "#A78BFA", "#67E8F9"];

// «Загорание по повороту»: страна считается на ФРОНТАЛЬНОЙ (видимой) стороне
// глобуса, если её долгота в пределах ±FRONT_HALF_DEG от меридиана, обращённого
// к камере (камерная долгота из pointOfView().lng авто-вращения).
const FRONT_HALF_DEG = 80;

// Нормализует разницу долгот в диапазон [-180, 180].
function lngDelta(a: number, b: number): number {
  let d = ((a - b + 180) % 360) - 180;
  if (d < -180) d += 360;
  return d;
}

// hex → rgba-строка с заданной alpha (для динамической яркости маркеров).
function hexToRgba(hex: string, alpha: number): string {
  const h = hex.replace("#", "");
  const r = parseInt(h.substring(0, 2), 16);
  const g = parseInt(h.substring(2, 4), 16);
  const b = parseInt(h.substring(4, 6), 16);
  return `rgba(${r},${g},${b},${Math.max(0, Math.min(1, alpha)).toFixed(3)})`;
}

// WebGL detection — если нет, сразу fallback (3D смысла не имеет).
function hasWebGL(): boolean {
  if (typeof window === "undefined") return false;
  try {
    const canvas = document.createElement("canvas");
    const gl = canvas.getContext("webgl") || canvas.getContext("experimental-webgl");
    return !!gl;
  } catch {
    return false;
  }
}

export type GlobeCountry = {
  code: string;
  name: string;
  visits?: number;
  n?: number;
};

type GlobePoint = {
  lat: number;
  lng: number;
  label: string;
  weight: number;
  baseColor: string; // фирменный цвет маркера (до модуляции яркости)
  color: string;     // текущий rgba с альфой (= яркость), пересчитывается rAF
  altitude: number;  // текущая высота столбика, пересчитывается rAF
  key: string;
  capLat: number;    // координата столицы (для подсветки ночью)
  capLng: number;
  // Runtime-поля, пересчитываются rAF-циклом «загорания по повороту + день/ночь».
  _front?: boolean;  // на фронтальной (видимой) стороне глобуса
  _delta?: number;   // |долгота − камерный меридиан| в градусах (0 = по центру)
  _night?: boolean;  // точка сейчас на ночной стороне планеты
};

// Точка-столица на ночной стороне — яркий «огонёк» столицы (Босс п.3).
type CapitalPoint = {
  lat: number;
  lng: number;
  label: string;
  color: string; // rgba с альфой (яркость = насколько глубоко в ночи + во фронте)
  key: string;
};

// Кольцо «приём сигнала» — расходящаяся радиоволна (ripple) от точки страны
// в момент её выхода во фронт. Бренд-цвета purple→cyan→fuchsia.
type RingDatum = {
  lat: number;
  lng: number;
  color: string[];
  maxR: number;
  speed: number;
  period: number;
  bornAt: number;
  id: number;
};

// ───────────────────────────────────────────────────────────────────────────
// ErrorBoundary — ловит ошибки рендера глобуса, не роняет страницу.
class GlobeErrorBoundary extends Component<
  { fallback: ReactNode; children: ReactNode },
  { hasError: boolean }
> {
  constructor(props: { fallback: ReactNode; children: ReactNode }) {
    super(props);
    this.state = { hasError: false };
  }
  static getDerivedStateFromError() {
    return { hasError: true };
  }
  componentDidCatch(error: unknown) {
    // Логируем, но НЕ пробрасываем — страница остаётся живой.
    console.error("[GlobeView] render error → fallback:", error);
  }
  render() {
    if (this.state.hasError) return this.props.fallback;
    return this.props.children;
  }
}

// ───────────────────────────────────────────────────────────────────────────
// Список стран — мягкий fallback (нет WebGL / ошибка / lazy-chunk не загрузился).
function CountriesFallbackList({ countries }: { countries: GlobeCountry[] }) {
  const sorted = useMemo(
    () => [...countries].sort((a, b) => (b.visits || b.n || 0) - (a.visits || a.n || 0)),
    [countries],
  );
  return (
    <div className="w-full h-full overflow-y-auto p-3" style={{ touchAction: "pan-y" }}>
      <p className="text-xs text-white/50 text-center mb-2 font-sans">
        Список стран (3D-глобус недоступен на этом устройстве)
      </p>
      <ul className="m-0 p-0 list-none space-y-1">
        {sorted.length === 0 && (
          <li className="text-xs text-white/40 text-center py-3">Пока нет данных</li>
        )}
        {sorted.map((c) => (
          <li
            key={c.code || c.name}
            className="flex items-center gap-2 text-[13px] py-1.5 px-2 rounded-lg hover:bg-white/[0.06]"
          >
            <span className="flex-1 break-words bg-gradient-to-r from-purple-300 via-fuchsia-200 to-cyan-300 bg-clip-text text-transparent font-medium">
              {c.name}
            </span>
            {(c.visits || c.n) ? (
              <span className="text-[11px] tabular-nums text-white/50 shrink-0">
                {c.visits || c.n}
              </span>
            ) : null}
          </li>
        ))}
      </ul>
    </div>
  );
}

// ───────────────────────────────────────────────────────────────────────────
// Внутренний компонент — рендерит сам <Globe>. Размер берёт у контейнера через
// ResizeObserver (Device-fit-100 rule — подстройка под любой вьюпорт).
//
// Здесь же — rAF-цикл «загорания по повороту»:
//   • читает текущую долготу камеры (pointOfView().lng авто-вращения) +
//     текущее положение Солнца (subsolarPoint по UTC);
//   • для каждой страны считает «фронтальность» (на видимой стороне?) и
//     «освещённость» (день/ночь) → модулирует яркость/высоту маркера;
//   • при ВХОДЕ страны во фронтальный сектор — выпускает кольцо (ripple,
//     «приём сигнала») в бренд-цветах;
//   • столицы стран, оказавшихся в тени (ночь) + во фронте — подсвечивает
//     отдельным слоем ярких огоньков;
//   • обновляет uniform globeRotation у day/night-шейдера (камера ↔ терминатор).
function GlobeInner({ points }: { points: GlobePoint[] }) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const globeRef = useRef<any>(null);
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const [size, setSize] = useState<{ w: number; h: number }>({ w: 320, h: 320 });
  const [ready, setReady] = useState(false);

  // day/night ShaderMaterial — строим лениво один раз (TextureLoader в браузере).
  const dayNight = useMemo(() => buildDayNightMaterial(), []);

  // Базовые точки в ref — rAF-цикл читает их без пересоздания эффекта.
  const basePointsRef = useRef<GlobePoint[]>(points);
  useEffect(() => {
    basePointsRef.current = points;
  }, [points]);

  // Что реально рендерится (пересчитывается rAF по фронтальности + дню/ночи).
  const [litPoints, setLitPoints] = useState<GlobePoint[]>(points);
  const [capitalLights, setCapitalLights] = useState<CapitalPoint[]>([]);
  const [rings, setRings] = useState<RingDatum[]>([]);

  const rafRef = useRef<number | null>(null);
  const ringIdRef = useRef(0);
  // Страны, СЕЙЧАС на фронте — чтобы ловить переход back→front и выпускать
  // кольцо только при ВХОДЕ страны в видимый сектор (а не каждый кадр).
  const frontSetRef = useRef<Set<string>>(new Set());

  // Замер размера контейнера + ResizeObserver.
  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const measure = () => {
      const w = el.clientWidth;
      const h = el.clientHeight;
      if (w > 0 && h > 0) setSize({ w, h });
    };
    measure();
    let ro: ResizeObserver | null = null;
    try {
      ro = new ResizeObserver(measure);
      ro.observe(el);
    } catch {
      window.addEventListener("resize", measure);
    }
    return () => {
      try {
        ro?.disconnect();
      } catch {
        // ignore
      }
      window.removeEventListener("resize", measure);
    };
  }, []);

  // ───────────────────────────────────────────────────────────────────────
  // rAF-цикл «загорание по повороту» + день/ночь + кольца.
  useEffect(() => {
    if (!ready) return;
    let destroyed = false;
    // Throttle тяжёлых setState до ~12fps — достаточно для плавного «загорания»,
    // не грузит React лишними рендерами (lightweight).
    let lastTick = 0;
    const TICK_MS = 80;

    const tick = (now: number) => {
      if (destroyed) return;
      rafRef.current = requestAnimationFrame(tick);
      if (now - lastTick < TICK_MS) return;
      lastTick = now;

      const g = globeRef.current;
      if (!g) return;
      let camLng = 0;
      let camLat = 0;
      try {
        const pov = g.pointOfView?.();
        if (!pov) return;
        camLng = pov.lng ?? 0;
        camLat = pov.lat ?? 0;
      } catch {
        return;
      }

      // Положение Солнца сейчас (субсолярная точка) + uniform'ы шейдера.
      const sun = subsolarPoint(Date.now());
      if (dayNight) {
        try {
          dayNight.uniforms.sunPosition.value.set(sun[0], sun[1]);
          dayNight.uniforms.globeRotation.value.set(camLng, camLat);
        } catch {
          // ignore
        }
      }
      const sunDir = sunDirWorld(sun);

      const pts = basePointsRef.current;
      if (pts.length === 0) return;

      const nextFront = new Set<string>();
      const newRings: RingDatum[] = [];
      const caps: CapitalPoint[] = [];

      const lit: GlobePoint[] = pts.map((p) => {
        // Фронтальность: |delta| 0° = по центру видимой стороны, 180° = сзади.
        const delta = Math.abs(lngDelta(p.lng, camLng));
        const isFront = delta <= FRONT_HALF_DEG;
        // Освещённость: dot(normal, sunDir). >0 — день, <0 — ночь.
        const illum = illumination(p.lat, p.lng, sunDir);
        const isNight = illum < 0;

        if (isFront) {
          nextFront.add(p.key);
          // Переход back→front → «приём сигнала»: кольцо.
          if (!frontSetRef.current.has(p.key)) {
            const w = p.weight || 1;
            newRings.push({
              lat: p.lat,
              lng: p.lng,
              // Бренд-волна: внутри fuchsia → cyan → purple снаружи.
              color: [BRAND_FUCHSIA, BRAND_CYAN, BRAND_PURPLE],
              // Радиус/период зависят от веса (больше слушателей — мощнее пинг).
              maxR: 4 + Math.min(5, Math.log10(w + 1) * 2.5),
              speed: 2.4,
              period: 900,
              bornAt: now,
              id: ringIdRef.current++,
            });
          }
          // Столица в тени и во фронте — яркий огонёк столицы (Босс п.3).
          if (isNight) {
            const nightDepth = Math.min(1, -illum); // насколько глубоко в ночи
            caps.push({
              lat: p.capLat,
              lng: p.capLng,
              label: p.label,
              color: hexToRgba("#FFE9A8", 0.35 + 0.6 * nightDepth), // тёплый огонёк
              key: p.key,
            });
          }
        }

        // Яркость маркера: фронт + день = максимум; тёмная сторона = тускло.
        const t = Math.max(0, Math.min(1, 1 - delta / 180)); // 1 центр → 0 сзади
        const frontGain = isFront ? Math.max(0.55, t) : t * 0.45;
        const alpha = 0.16 + 0.79 * frontGain;
        const color = hexToRgba(p.baseColor, alpha);
        const baseAlt = 0.02 + Math.min(0.22, Math.log10((p.weight || 1) + 1) * 0.08);
        const altitude = isFront ? baseAlt * 1.6 : baseAlt * 0.55;

        return { ...p, _front: isFront, _delta: delta, _night: isNight, color, altitude };
      });

      frontSetRef.current = nextFront;
      setLitPoints(lit);
      setCapitalLights(caps);

      if (newRings.length) {
        setRings((prev) => {
          const alive = prev.filter((r) => now - r.bornAt < 1800);
          return [...alive, ...newRings];
        });
      } else {
        setRings((prev) => {
          if (prev.length === 0) return prev;
          const alive = prev.filter((r) => now - r.bornAt < 1800);
          return alive.length === prev.length ? prev : alive;
        });
      }
    };
    rafRef.current = requestAnimationFrame(tick);
    return () => {
      destroyed = true;
      if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
    };
  }, [ready, dayNight]);

  // Если набор стран сменился до первого tick — синхронизируем отображаемые.
  useEffect(() => {
    if (!ready) setLitPoints(points);
  }, [points, ready]);

  // После mount глобуса — настраиваем OrbitControls (auto-rotate + zoom) и
  // стартовую точку обзора. Defensive: controls API может отличаться в minor.
  const onGlobeReady = () => {
    try {
      const g = globeRef.current;
      if (!g) {
        setReady(true);
        return;
      }
      const controls = g.controls?.();
      if (controls) {
        controls.autoRotate = true;
        controls.autoRotateSpeed = 0.6; // медленно, как Земля
        controls.enableZoom = true;
        controls.enablePan = false;
        controls.minDistance = 180;
        controls.maxDistance = 600;
        controls.rotateSpeed = 0.7;
        controls.zoomSpeed = 0.8;
      }
      // Компактная стартовая позиция — Европа/Россия (наша аудитория).
      g.pointOfView?.({ lat: 30, lng: 50, altitude: 2.4 }, 0);
    } catch (e) {
      console.error("[GlobeView] onGlobeReady controls setup failed:", e);
    } finally {
      setReady(true);
    }
  };

  return (
    <div ref={wrapRef} className="absolute inset-0" data-testid="globe-3d-canvas">
      <Globe
        ref={globeRef}
        width={size.w}
        height={size.h}
        backgroundColor="rgba(0,0,0,0)"
        rendererConfig={{ antialias: true, alpha: true }}
        // day/night шейдер (реальное Солнце + ночные огни). Если текстуры/шейдер
        // не собрались — fallback на дневную текстуру (глобус всё равно живой).
        {...(dayNight
          ? { globeMaterial: dayNight.material }
          : { globeImageUrl: EARTH_DAY_URL, bumpImageUrl: EARTH_BUMP_URL })}
        showAtmosphere={true}
        atmosphereColor="#7C3AED"
        atmosphereAltitude={0.22}
        onGlobeReady={onGlobeReady}
        // ── Маркеры «загораются» по повороту (фронт + день = ярко). ───────
        pointsData={litPoints}
        pointLat={(d: GlobePoint) => d.lat}
        pointLng={(d: GlobePoint) => d.lng}
        pointColor={(d: GlobePoint) => d.color}
        pointAltitude={(d: GlobePoint) => d.altitude ?? 0.04}
        pointRadius={(d: GlobePoint) => (d._front ? 0.6 : 0.32)}
        pointResolution={6}
        pointsTransitionDuration={300}
        pointLabel={(d: GlobePoint) =>
          `<div style="font-family:Inter,sans-serif;font-size:12px;color:#fff;background:rgba(10,10,23,0.85);padding:4px 8px;border-radius:8px;border:1px solid rgba(124,58,237,0.5)">${d.label}${d.weight ? ` · ${d.weight}` : ""}</div>`
        }
        // ── Огоньки столиц на ночной стороне (тёплая точка-«город»). ──────
        labelsData={capitalLights}
        labelLat={(d: CapitalPoint) => d.lat}
        labelLng={(d: CapitalPoint) => d.lng}
        labelText={() => ""}
        labelColor={(d: CapitalPoint) => d.color}
        labelDotRadius={0.32}
        labelSize={0}
        labelResolution={2}
        labelAltitude={0.012}
        // ── Кольца «приём сигнала»: расходящаяся радиоволна при выходе во фронт.
        ringsData={rings}
        ringLat={(d: RingDatum) => d.lat}
        ringLng={(d: RingDatum) => d.lng}
        ringColor={(d: RingDatum) => d.color}
        ringMaxRadius={(d: RingDatum) => d.maxR}
        ringPropagationSpeed={(d: RingDatum) => d.speed}
        ringRepeatPeriod={(d: RingDatum) => d.period}
        ringResolution={64}
      />
    </div>
  );
}

// ───────────────────────────────────────────────────────────────────────────
// Публичный компонент глобуса.
export default function GlobeView({ countries }: { countries: GlobeCountry[] }) {
  const [webglOk] = useState<boolean>(() => hasWebGL());

  // Точки-маркеры из стран (только те, для которых знаем координаты).
  const points = useMemo<GlobePoint[]>(() => {
    const arr: GlobePoint[] = [];
    let i = 0;
    for (const c of countries) {
      const ll = resolveLatLon(c.code, c.name);
      if (!ll) continue;
      const weight = c.visits || c.n || 1;
      const baseColor = MARKER_COLORS[i % MARKER_COLORS.length];
      const cap = resolveCapital(c.code, c.name) || ll; // fallback на центроид
      arr.push({
        lat: ll[0],
        lng: ll[1],
        label: c.name,
        weight,
        baseColor,
        color: baseColor, // стартовая яркость до первого rAF-tick
        altitude: 0.02 + Math.min(0.22, Math.log10(weight + 1) * 0.08),
        capLat: cap[0],
        capLng: cap[1],
        key: (c.code || c.name || `i${i}`).toUpperCase(),
      });
      i++;
    }
    return arr;
  }, [countries]);

  // Нет WebGL → сразу список без попытки грузить тяжёлый chunk.
  if (!webglOk) {
    return <CountriesFallbackList countries={countries} />;
  }

  const fallback = <CountriesFallbackList countries={countries} />;

  return (
    <div className="relative w-full h-full">
      <GlobeErrorBoundary fallback={fallback}>
        <Suspense
          fallback={
            <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
              <div className="text-center">
                <div className="inline-block animate-spin rounded-full h-8 w-8 border-b-2 border-purple-500 mb-2" />
                <p className="text-xs font-sans text-white/50">Загружаем планету…</p>
              </div>
            </div>
          }
        >
          <GlobeInner points={points} />
        </Suspense>
      </GlobeErrorBoundary>
    </div>
  );
}
