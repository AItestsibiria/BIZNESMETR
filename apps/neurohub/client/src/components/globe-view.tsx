// globe-view.tsx — настоящий 3D-глобус Земли (ФАЗА 1, без погоды).
// Eugene 2026-05-26 Босс «настоящий 3D-глобус, реальная география континентов,
// вращение планеты, стильный, с зумом». + уточнение: учитывай реальное положение
// Солнца (день/ночь); ночная сторона — текстура ночных огней (earth-night);
// смешивание по терминатору через кастомный day/night шейдер; маркеры стран
// ЗАГОРАЮТСЯ ярче на видимой стороне (и днём ярче ночи); столицы на ночной
// стороне — яркий огонёк; ripple-кольцо — доп. акцент. Погода — Фаза 2 (НЕ здесь).
//
// Архитектура изоляции (глобус НЕ должен ломать страницу):
//   1. Lazy-load: react-globe.gl грузится через React.lazy + <Suspense> — тяжёлый
//      chunk (three.js ~600KB) не попадает в main bundle. three импортируется
//      внутри ЭТОГО модуля (он сам lazy) → в том же изолированном chunk'е.
//   2. ErrorBoundary ловит ЛЮБУЮ ошибку рендера/инициализации (нет WebGL / CDN
//      не загрузилась / несовместимость) → fallback (список стран). Без throw.
//   3. Feature-toggle "globe-3d" (default ON) — проверяется на стороне landing.
//   4. Responsive (Device-fit-100 rule): высота через dvh+safe-area у обёртки;
//      сам глобус — под размер контейнера (ResizeObserver).
//
// День/Ночь — порт офиц. примера react-globe.gl «Day/Night Cycle»
// (Docs-first-always rule: github.com/vasturiano/react-globe.gl
//  example/day-night-cycle/index.html): ShaderMaterial с dayTexture/nightTexture,
// uniform sunPosition [subsolarLng°, declination°] (реальная субсолярная точка по
// UTC) + globeRotation [lng,lat камеры]; во fragment intensity=dot(normal,sun),
// smoothstep → терминатор, mix(night, day). Положение Солнца — собственные
// NOAA-формулы (subsolarPoint), обновляется раз в минуту (Босс п.4).
//
// Brand-style consistency rule: маркеры/кольца/atmosphere в фирменной палитре
// (Cyber Violet #7C3AED / Electric Blue #00D4FF / Hot Magenta #FF006E).
//
// Источник данных — /api/playlist/geo-top и /api/public/countries-count
// (Reuse-working-solutions rule). Координаты — таблицы центроидов/столиц ISO alpha-2.

import {
  Component,
  Suspense,
  lazy,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ComponentType,
  type ReactNode,
  type Ref,
} from "react";
// three импортируется внутри ЭТОГО модуля (он сам грузится через React.lazy из
// landing) → остаётся в том же изолированном lazy-chunk'е, не в main bundle.
// three@0.184 поставляется БЕЗ собственных .d.ts (типы вынесены в @types/three,
// который в проекте не установлен — добавлять npm-зависимость без подтверждения
// Босса нельзя, Autonomous-execution rule). Поэтому подавляем TS7016 на этой
// строке: импорт корректен в рантайме (пакет three установлен), типы не нужны —
// ниже THREE используется через локальный any-каст (THREE_ANY).
// @ts-expect-error — нет @types/three; runtime-импорт валиден, типы добавим вместе с @types/three.
import * as THREE_NS from "three";
import { GlobeLoader } from "@/components/globe-loader";
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const THREE: any = THREE_NS as any;

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
  color: string; // текущий rgba с альфой (= яркость), пересчитывается rAF
  altitude: number; // текущая высота столбика, пересчитывается rAF
  key: string;
  capLat: number; // координата столицы (для подсветки на ночной стороне)
  capLng: number;
  // Runtime-поля — пересчитываются rAF-циклом «загорания по повороту + день/ночь».
  _front?: boolean; // на фронтальной (видимой) стороне глобуса
  _delta?: number; // |долгота − камерный меридиан| в градусах (0 = по центру)
  _night?: boolean; // точка сейчас на ночной стороне планеты
};

// Точка-«огонёк» столицы на ночной стороне (Босс п.3: столицы ночью подчёркивай).
type CapitalLight = {
  lat: number;
  lng: number;
  label: string;
  color: string; // rgba с альфой (яркость = глубина ночи × фронтальность)
  key: string;
};

// Кольцо «приём сигнала» — расходящаяся радиоволна (ripple) от точки страны
// в момент её выхода во фронт. Бренд-цвета fuchsia→cyan→purple.
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

// react-globe.gl default export — React-компонент. React.lazy теряет props-типы,
// поэтому приводим к типизированному ComponentType (props выверены по d.ts пакета).
type GlobeComponentProps = {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ref?: Ref<any>;
  width?: number;
  height?: number;
  backgroundColor?: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  rendererConfig?: any;
  globeImageUrl?: string | null;
  bumpImageUrl?: string | null;
  backgroundImageUrl?: string | null; // звёздный фон (реальный космос)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  globeMaterial?: any; // кастомный day/night ShaderMaterial
  showAtmosphere?: boolean;
  atmosphereColor?: string;
  atmosphereAltitude?: number;
  onGlobeReady?: () => void;
  onZoom?: (pov: { lat: number; lng: number; altitude: number }) => void;
  pointsData?: object[];
  pointLat?: (d: GlobePoint) => number;
  pointLng?: (d: GlobePoint) => number;
  pointColor?: (d: GlobePoint) => string;
  pointAltitude?: (d: GlobePoint) => number;
  pointRadius?: number | ((d: GlobePoint) => number);
  pointResolution?: number;
  pointsTransitionDuration?: number;
  pointLabel?: (d: GlobePoint) => string;
  ringsData?: object[];
  ringLat?: (d: RingDatum) => number;
  ringLng?: (d: RingDatum) => number;
  ringColor?: (d: RingDatum) => string[] | string;
  ringMaxRadius?: (d: RingDatum) => number;
  ringPropagationSpeed?: (d: RingDatum) => number;
  ringRepeatPeriod?: (d: RingDatum) => number;
  ringResolution?: number;
  labelsData?: object[];
  labelLat?: (d: CapitalLight) => number;
  labelLng?: (d: CapitalLight) => number;
  labelText?: (d: CapitalLight) => string;
  labelColor?: (d: CapitalLight) => string;
  labelDotRadius?: number | ((d: CapitalLight) => number);
  labelSize?: number;
  labelResolution?: number;
  labelAltitude?: number;
};
const Globe = lazy(() => import("react-globe.gl")) as unknown as ComponentType<GlobeComponentProps>;

// ───────────────────────────────────────────────────────────────────────────
// Текстуры Земли (CDN, грузятся в браузере юзера). Реальная география.
// День — earth-day (blue-marble дневная сторона). Ночь — earth-night
// («black marble» NASA: огни городов/столиц). Bump — рельеф.
const EARTH_DAY_URL = "//unpkg.com/three-globe/example/img/earth-day.jpg";
const EARTH_NIGHT_URL = "//unpkg.com/three-globe/example/img/earth-night.jpg";
const EARTH_BUMP_URL = "//unpkg.com/three-globe/example/img/earth-topology.png";
// Звёздное небо (первоначальный вид — Босс 2026-05-29 «верни первоначальный вид
// звёзд»): реальная текстура звёздного неба three-globe (night-sky.png).
const NIGHT_SKY_URL = "//unpkg.com/three-globe/example/img/night-sky.png";

// ───────────────────────────────────────────────────────────────────────────
// Day/Night шейдер — порт офиц. примера react-globe.gl «Day/Night Cycle».
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
    // Ночная сторона светлее и ВСЯ в огнях городов (Босс): сильнее тянем огни
    // (×2.4 + warm boost для жёлто-городского свечения) + выше ambient-пол, чтобы
    // материки ночью были хорошо видны, а не мрачная чернота.
    vec3 lights = nightColor.rgb * 2.4;
    lights += nightColor.rgb * vec3(0.35, 0.22, 0.0); // тёплый «городской» оттенок
    vec3 nightBoost = lights + vec3(0.045, 0.055, 0.10);
    float blendFactor = smoothstep(-0.12, 0.12, intensity);
    vec3 col = mix(nightBoost, dayColor.rgb, blendFactor);
    gl_FragColor = vec4(col, 1.0);
  }
`;

type DayNightMaterial = {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  material: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  uniforms: any;
};

// Собирает day/night ShaderMaterial (TextureLoader + ShaderMaterial). Текстуры
// грузятся асинхронно — материал валиден сразу, затем шейдер сам перерисуется.
// onDay/onNight — колбэки готовности текстур (для поэтапной детализации сцены).
// null при ошибке → откат на статичную дневную текстуру.
function buildDayNightMaterial(onDay?: () => void, onNight?: () => void): DayNightMaterial | null {
  try {
    const loader = new THREE.TextureLoader();
    loader.setCrossOrigin("anonymous");
    const dayTex = loader.load(EARTH_DAY_URL, onDay, undefined, onDay);
    const nightTex = loader.load(EARTH_NIGHT_URL, onNight, undefined, onNight);
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const srgb = (THREE as any).SRGBColorSpace;
      if (srgb) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (dayTex as any).colorSpace = srgb;
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (nightTex as any).colorSpace = srgb;
      }
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
// Положение Солнца (субсолярная точка) по текущему UTC → [subsolarLng°, decl°].
// subsolarLng — долгота солнечного полудня (формула офиц. примера минус
// equation-of-time/4). decl — солнечное склонение по дню года. NOAA-аппроксимации.
function julianCentury(dt: number): number {
  const jd = dt / 86400000 + 2440587.5;
  return (jd - 2451545.0) / 36525.0;
}

function solarDeclinationDeg(t: number): number {
  const L0 = (280.46646 + t * (36000.76983 + t * 0.0003032)) % 360;
  const M = 357.52911 + t * (35999.05029 - 0.0001537 * t);
  const Mrad = (M * Math.PI) / 180;
  const C =
    Math.sin(Mrad) * (1.914602 - t * (0.004817 + 0.000014 * t)) +
    Math.sin(2 * Mrad) * (0.019993 - 0.000101 * t) +
    Math.sin(3 * Mrad) * 0.000289;
  const trueLong = L0 + C;
  const omega = 125.04 - 1934.136 * t;
  const lambda = trueLong - 0.00569 - 0.00478 * Math.sin((omega * Math.PI) / 180);
  const seconds = 21.448 - t * (46.815 + t * (0.00059 - t * 0.001813));
  let eps0 = 23 + (26 + seconds / 60) / 60;
  eps0 += 0.00256 * Math.cos((omega * Math.PI) / 180);
  const sinDecl = Math.sin((eps0 * Math.PI) / 180) * Math.sin((lambda * Math.PI) / 180);
  return (Math.asin(sinDecl) * 180) / Math.PI;
}

function equationOfTimeMin(t: number): number {
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
  return ((Etime * 180) / Math.PI) * 4;
}

function subsolarPoint(dt: number): [number, number] {
  const day = new Date(dt).setUTCHours(0, 0, 0, 0);
  const t = julianCentury(dt);
  const longitude = ((day - dt) / 864e5) * 360 - 180;
  const lng = longitude - equationOfTimeMin(t) / 4;
  const lat = solarDeclinationDeg(t);
  return [lng, lat];
}

// Подлунная точка [lng°, lat°] — точка Земли прямо под Луной (низкоточная формула
// Meeus, точность ±неск. градусов — достаточно «в реальности» для визуала Луны).
function subLunarPoint(dt: number): [number, number] {
  const d = dt / 86400000 + 2440587.5 - 2451545.0; // дни от J2000
  const rad = Math.PI / 180;
  const L = 218.316 + 13.176396 * d;        // средняя долгота Луны
  const M = 134.963 + 13.064993 * d;        // средняя аномалия
  const F = 93.272 + 13.22935 * d;          // аргумент широты
  const lambda = L + 6.289 * Math.sin(M * rad);   // эклиптическая долгота
  const beta = 5.128 * Math.sin(F * rad);          // эклиптическая широта
  const eps = 23.439 - 0.0000004 * d;              // наклон эклиптики
  const lr = lambda * rad, br = beta * rad, er = eps * rad;
  const sinDec = Math.sin(br) * Math.cos(er) + Math.cos(br) * Math.sin(er) * Math.sin(lr);
  const dec = Math.asin(sinDec) / rad;
  const ra = Math.atan2(
    Math.sin(lr) * Math.cos(er) - Math.tan(br) * Math.sin(er),
    Math.cos(lr),
  ) / rad;
  const gmst = (280.4606 + 360.9856473 * d) % 360; // среднее звёздное время Гринвича
  let lng = ((ra - gmst + 180) % 360) - 180;
  if (lng < -180) lng += 360;
  return [lng, dec];
}

// Нормаль поверхности в (lat,lng) — базис Polar2Cartesian как в шейдере.
function surfaceNormal(lat: number, lng: number): [number, number, number] {
  const theta = ((90 - lng) * Math.PI) / 180;
  const phi = ((90 - lat) * Math.PI) / 180;
  return [Math.sin(phi) * Math.cos(theta), Math.cos(phi), Math.sin(phi) * Math.sin(theta)];
}

// Единичный вектор на Солнце в мировых координатах (CPU-расчёт день/ночь).
function sunDirWorld([lng, lat]: [number, number]): [number, number, number] {
  return surfaceNormal(lat, lng);
}

// Освещённость точки: dot(normal, sunDir) ∈ [-1..1]. >0 день, <0 ночь.
function illumination(lat: number, lng: number, sunDir: [number, number, number]): number {
  const n = surfaceNormal(lat, lng);
  return n[0] * sunDir[0] + n[1] * sunDir[1] + n[2] * sunDir[2];
}

// ───────────────────────────────────────────────────────────────────────────
// Центроиды стран по ISO 3166-1 alpha-2 (lat, lon). Fallback null если кода нет.
const COUNTRY_CENTROIDS: Record<string, [number, number]> = {
  RU: [61.52, 105.31], US: [37.09, -95.71], KZ: [48.02, 66.92], BY: [53.71, 27.95],
  UA: [48.38, 31.17], DE: [51.17, 10.45], GB: [55.38, -3.44], FR: [46.23, 2.21],
  IT: [41.87, 12.57], ES: [40.46, -3.75], PL: [51.92, 19.15], NL: [52.13, 5.29],
  MD: [47.41, 28.37], TR: [38.96, 35.24], CN: [35.86, 104.2], JP: [36.2, 138.25],
  IN: [20.59, 78.96], BR: [-14.24, -51.93], CA: [56.13, -106.35], AU: [-25.27, 133.78],
  IL: [31.05, 34.85], AE: [23.42, 53.85], GE: [42.32, 43.36], AM: [40.07, 45.04],
  AZ: [40.14, 47.58], UZ: [41.38, 64.59], KG: [41.2, 74.77], TJ: [38.86, 71.28],
  TM: [38.97, 59.56], FI: [61.92, 25.75], SE: [60.13, 18.64], NO: [60.47, 8.47],
  CZ: [49.82, 15.47], AT: [47.52, 14.55], CH: [46.82, 8.23], BE: [50.5, 4.47],
  PT: [39.4, -8.22], GR: [39.07, 21.82], RO: [45.94, 24.97], HU: [47.16, 19.5],
  BG: [42.73, 25.49], RS: [44.02, 21.01], KR: [35.91, 127.77], TH: [15.87, 100.99],
  VN: [14.06, 108.28], ID: [-0.79, 113.92], MX: [23.63, -102.55], AR: [-38.42, -63.62],
  EG: [26.82, 30.8], ZA: [-30.56, 22.94], EE: [58.6, 25.01], LV: [56.88, 24.6],
  LT: [55.17, 23.88], IE: [53.41, -8.24],
};

// Столицы стран по ISO alpha-2 [lat, lon] — подсветка на ночной стороне (Босс п.3).
const COUNTRY_CAPITALS: Record<string, [number, number]> = {
  RU: [55.75, 37.62], US: [38.9, -77.04], KZ: [51.17, 71.43], BY: [53.9, 27.57],
  UA: [50.45, 30.52], DE: [52.52, 13.41], GB: [51.51, -0.13], FR: [48.86, 2.35],
  IT: [41.9, 12.5], ES: [40.42, -3.7], PL: [52.23, 21.01], NL: [52.37, 4.9],
  MD: [47.01, 28.86], TR: [39.93, 32.87], CN: [39.9, 116.41], JP: [35.68, 139.69],
  IN: [28.61, 77.21], BR: [-15.79, -47.88], CA: [45.42, -75.7], AU: [-35.28, 149.13],
  IL: [31.78, 35.22], AE: [24.45, 54.38], GE: [41.72, 44.78], AM: [40.18, 44.51],
  AZ: [40.41, 49.87], UZ: [41.3, 69.24], KG: [42.87, 74.59], TJ: [38.56, 68.79],
  TM: [37.95, 58.38], FI: [60.17, 24.94], SE: [59.33, 18.07], NO: [59.91, 10.75],
  CZ: [50.08, 14.44], AT: [48.21, 16.37], CH: [46.95, 7.45], BE: [50.85, 4.35],
  PT: [38.72, -9.14], GR: [37.98, 23.73], RO: [44.43, 26.1], HU: [47.5, 19.04],
  BG: [42.7, 23.32], RS: [44.79, 20.45], KR: [37.57, 126.98], TH: [13.76, 100.5],
  VN: [21.03, 105.85], ID: [-6.21, 106.85], MX: [19.43, -99.13], AR: [-34.6, -58.38],
  EG: [30.04, 31.24], ZA: [-25.75, 28.19], EE: [59.44, 24.75], LV: [56.95, 24.11],
  LT: [54.69, 25.28], IE: [53.35, -6.26],
};

// Маппинг названий на ISO-код (на случай если придёт name без code).
const NAME_TO_CODE: Record<string, string> = {
  Россия: "RU", Russia: "RU",
  США: "US", "United States": "US",
  Казахстан: "KZ", Kazakhstan: "KZ",
  Беларусь: "BY", Belarus: "BY",
  Украина: "UA", Ukraine: "UA",
  Германия: "DE", Germany: "DE",
  Великобритания: "GB", "United Kingdom": "GB",
  Франция: "FR", France: "FR",
  Италия: "IT", Italy: "IT",
  Испания: "ES", Spain: "ES",
  Польша: "PL", Poland: "PL",
  Нидерланды: "NL", Netherlands: "NL",
  Молдова: "MD", Moldova: "MD",
  Турция: "TR", Turkey: "TR",
};

function isoOf(code: string, name?: string): string {
  return ((code && code.length === 2 ? code : (name && NAME_TO_CODE[name])) || "").toUpperCase();
}

function resolveLatLon(code: string, name?: string): [number, number] | null {
  const cc = isoOf(code, name);
  return (cc && COUNTRY_CENTROIDS[cc]) || null;
}

function resolveCapital(code: string, name?: string): [number, number] | null {
  const cc = isoOf(code, name);
  if (cc && COUNTRY_CAPITALS[cc]) return COUNTRY_CAPITALS[cc];
  if (cc && COUNTRY_CENTROIDS[cc]) return COUNTRY_CENTROIDS[cc]; // fallback
  return null;
}

// Brand palette для маркеров/колец.
const BRAND_PURPLE = "#7C3AED";
const BRAND_CYAN = "#00D4FF";
const BRAND_FUCHSIA = "#FF006E";
const MARKER_COLORS = [BRAND_PURPLE, BRAND_CYAN, BRAND_FUCHSIA, "#A78BFA", "#67E8F9"];

// «Загорание по повороту»: страна на ФРОНТАЛЬНОЙ (видимой) стороне, если её
// долгота в пределах ±FRONT_HALF_DEG от меридиана камеры (pointOfView().lng).
const FRONT_HALF_DEG = 80;

// Resting altitude камеры — «отдыхающее» расстояние после интро/наводки на юзера.
// Босс 2026-05-29: «глобус чуть меньше + больше зазоры слева/справа» → дальше
// камера (2.0 → 2.4, +20%) → Земля визуально меньше, симметричные отступы по бокам.
const RESTING_ALTITUDE = 2.8; // Босс 2026-05-29: панорамный отъезд — к точке юзера, но не зум вплотную (обзорно)
// Обзорная (intro) altitude — общий план, чтобы в кадр попали Солнце и Луна.
const OVERVIEW_ALTITUDE = 3.0;
// Длительности интро-анимации (Босс: 2с обзор Солнце+Луна → плавный 2с полёт к юзеру).
const INTRO_OVERVIEW_HOLD_MS = 2000;
const INTRO_FLY_MS = 10000; // Босс 2026-05-29: плавный полёт к геолокации — 10 сек
const INTRO_SUNRISE_MS = 3500; // Босс 2026-05-29: «восход» — солнце поднимается из-за края (пан лимб→обзор)

// prefers-reduced-motion — уважаем системную настройку (без интро-полёта, сразу
// геолокация). В файле раньше проверки не было — добавлено вместе с интро-анимацией.
function prefersReducedMotion(): boolean {
  if (typeof window === "undefined" || !window.matchMedia) return false;
  try {
    return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  } catch {
    return false;
  }
}

// Нормализует разницу долгот в диапазон [-180, 180].
function lngDelta(a: number, b: number): number {
  let d = ((a - b + 180) % 360) - 180;
  if (d < -180) d += 360;
  return d;
}

// hex → rgba-строка с заданной alpha (динамическая яркость маркеров).
function hexToRgba(hex: string, alpha: number): string {
  const h = hex.replace("#", "");
  const r = parseInt(h.substring(0, 2), 16);
  const g = parseInt(h.substring(2, 4), 16);
  const b = parseInt(h.substring(4, 6), 16);
  return `rgba(${r},${g},${b},${Math.max(0, Math.min(1, alpha)).toFixed(3)})`;
}

// ISO alpha-2 → emoji-флаг (regional indicator symbols). Пустая строка если не код.
function isoToFlag(cc: string): string {
  const c = (cc || "").toUpperCase();
  if (!/^[A-Z]{2}$/.test(c)) return "";
  const A = 0x1f1e6;
  return String.fromCodePoint(A + (c.charCodeAt(0) - 65), A + (c.charCodeAt(1) - 65));
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
            {c.visits || c.n ? (
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
// Внутренний компонент — <Globe> с day/night шейдером, яркостью маркеров
// (фронт + день/ночь), огоньками столиц ночью и кольцами «приём сигнала».
function GlobeInner({ points }: { points: GlobePoint[] }) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const globeRef = useRef<any>(null);
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const [size, setSize] = useState<{ w: number; h: number }>({ w: 320, h: 320 });
  const [ready, setReady] = useState(false);

  // Поэтапная детализация (Босс «сначала малая детализация — сразу увидеть сцену,
  // далее плавный рост до 100%»): фаза 0 — дешёвый материал (мгновенно), фаза 2 —
  // полный day/night ShaderMaterial когда ОБЕ текстуры загрузились. Переход — плавный.
  const [texturesReady, setTexturesReady] = useState(false);
  const loadedRef = useRef(0);
  const markTexLoaded = () => {
    loadedRef.current += 1;
    if (loadedRef.current >= 2) setTexturesReady(true);
  };
  const dayNight = useMemo<DayNightMaterial | null>(
    () => buildDayNightMaterial(markTexLoaded, markTexLoaded),
    [],
  );
  // Дешёвый материал-заглушка (без текстур) — сцена видна мгновенно.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const cheapMat = useMemo<any>(() => {
    try {
      return new THREE.MeshPhongMaterial({ color: 0x16315e, emissive: 0x0a1530, shininess: 6 });
    } catch {
      return null;
    }
  }, []);
  const sunDirRef = useRef<[number, number, number]>(sunDirWorld(subsolarPoint(Date.now())));
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const sunMeshRef = useRef<any>(null);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const moonMeshRef = useRef<any>(null);
  // Геолокация юзера для стартового обзора (Босс: «открытие глобуса по геолокации»).
  const userLatLngRef = useRef<{ lat: number; lng: number } | null>(null);
  const [userLatLng, setUserLatLng] = useState<{ lat: number; lng: number } | null>(null);
  const introDoneRef = useRef(false); // интро-полёт выполняется один раз

  const basePointsRef = useRef<GlobePoint[]>(points);
  useEffect(() => {
    basePointsRef.current = points;
  }, [points]);

  const [litPoints, setLitPoints] = useState<GlobePoint[]>(points);
  const [rings, setRings] = useState<RingDatum[]>([]);

  // Стабильные подписи-названия стран (3D-текст). react-globe.gl рендерит их в
  // 3D-сцене: на обратной стороне планеты они скрыты (затухают по повороту),
  // ближе к камере крупнее, дальше — мельче (естественная перспектива, Босс).
  // Массив СТАБИЛЕН (useMemo) — не перестраиваем geometry каждый кадр (нет джанка).
  const labelData = useMemo<CapitalLight[]>(
    () =>
      points.map((p) => ({
        lat: p.lat,
        lng: p.lng,
        label: p.label,
        color: "#E6D8FF",
        key: p.key,
      })),
    [points],
  );

  const rafRef = useRef<number | null>(null);
  const ringIdRef = useRef(0);
  const frontSetRef = useRef<Set<string>>(new Set());

  // Освобождаем GPU-ресурсы day/night материала/текстур при размонтировании.
  useEffect(() => {
    return () => {
      try {
        dayNight?.uniforms?.dayTexture?.value?.dispose?.();
        dayNight?.uniforms?.nightTexture?.value?.dispose?.();
        dayNight?.material?.dispose?.();
      } catch {
        // ignore
      }
      // Освобождаем Солнце/Луну (geometry + material + дети-гало).
      try {
        for (const m of [sunMeshRef.current, moonMeshRef.current]) {
          if (!m) continue;
          m.parent?.remove?.(m);
          m.geometry?.dispose?.();
          m.material?.dispose?.();
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          (m.children || []).forEach((ch: any) => { ch.geometry?.dispose?.(); ch.material?.dispose?.(); });
        }
        sunMeshRef.current = null;
        moonMeshRef.current = null;
      } catch {
        // ignore
      }
      try { cheapMat?.dispose?.(); } catch { /* ignore */ }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dayNight]);

  // Позиционирование видимых 3D-Солнца и Луны над субсолярной/подлунной точками
  // (Босс «Солнце и Луну не видно» — теперь это реальные объекты сцены).
  const positionSunMoon = () => {
    const g = globeRef.current;
    if (!g?.getCoords) return;
    try {
      if (sunMeshRef.current) {
        const sp = subsolarPoint(Date.now());
        const c = g.getCoords(sp[1], sp[0], 3.0); // (lat, lng, altitude≈3 радиуса)
        sunMeshRef.current.position.set(c.x, c.y, c.z);
      }
      if (moonMeshRef.current) {
        const mp = subLunarPoint(Date.now());
        const c = g.getCoords(mp[1], mp[0], 1.9);
        moonMeshRef.current.position.set(c.x, c.y, c.z);
      }
    } catch {
      // ignore
    }
  };

  // Обновление положения Солнца раз в минуту (Босс п.4). Старт = момент открытия.
  useEffect(() => {
    const tick = () => {
      const sp = subsolarPoint(Date.now());
      sunDirRef.current = sunDirWorld(sp);
      try {
        dayNight?.uniforms?.sunPosition?.value?.set?.(sp[0], sp[1]);
      } catch {
        // ignore
      }
      positionSunMoon();
    };
    tick();
    const id = window.setInterval(tick, 60_000);
    return () => window.clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dayNight]);

  // Геолокация юзера → стартовый обзор глобуса (Босс «открытие по геолокации»).
  // Async + permission prompt; при отказе/таймауте — fallback «Солнце слева».
  useEffect(() => {
    if (typeof navigator === "undefined" || !navigator.geolocation) return;
    let cancelled = false;
    try {
      navigator.geolocation.getCurrentPosition(
        (pos) => {
          if (cancelled) return;
          const ll = { lat: pos.coords.latitude, lng: pos.coords.longitude };
          userLatLngRef.current = ll;
          setUserLatLng(ll);
        },
        () => { /* отказ/ошибка — остаёмся на fallback-обзоре */ },
        { enableHighAccuracy: false, timeout: 6000, maximumAge: 600000 },
      );
    } catch {
      // ignore
    }
    return () => { cancelled = true; };
  }, []);

  // Стартовая интро-анимация (Босс 2026-05-29): при открытии глобуса сначала ~2с
  // показываем «рассвет Солнца и Луны» — обзорный кадр, где видно Солнце и Луну
  // (точка между субсолярной и подлунной, общий план), затем ПЛАВНО (~2с) летим
  // камерой к геолокации юзера. reduced-motion → без полёта, сразу геолокация.
  // Таймер очищается в cleanup (clearTimeout) — нет утечек/гонок при размонтаже.
  useEffect(() => {
    // Босс 2026-05-29: полёт запускается ВСЕГДА при готовности глобуса (раньше был
    // gated на userLatLng — на шар-ссылках геолокация часто не выдаётся → полёта не
    // было, глобус статичен). Цель: геолокация юзера; если её нет — топ-страна по
    // слушателям; иначе разумный дефолт. Выполняется один раз (introDoneRef).
    if (!ready || introDoneRef.current) return;
    const g = globeRef.current;
    if (!g?.pointOfView) return;
    let target = userLatLng;
    if (!target) {
      const top = points.slice().sort((a, b) => (b.weight || 0) - (a.weight || 0))[0];
      target = top ? { lat: top.lat, lng: top.lng } : { lat: 50, lng: 30 };
    }
    introDoneRef.current = true;

    // Уважаем prefers-reduced-motion: без обзора и полёта — сразу на цель.
    if (prefersReducedMotion()) {
      try {
        g.pointOfView({ lat: target.lat, lng: target.lng, altitude: RESTING_ALTITUDE }, 0);
      } catch {
        // ignore
      }
      return;
    }

    let flyTimer: number | null = null;
    let rotTimer: number | null = null;
    try {
      // Обзорный кадр: точка между подсолнечной и подлунной (видно Солнце+Луну).
      // Fallback при недоступности формул — разумный общий план (день по центру).
      // Босс 2026-05-29: начальный кадр — точка ВОСХОДА (терминатор, экватор):
      // меридиан восхода = subsolar−90° (~6 утра), видно восход (лучи задевают край
      // земли) + Луну. Тот же кадр, что выставлен в onGlobeReady → плавно, без прыжка.
      const overviewLat = 0;
      let overviewLng = subsolarPoint(Date.now())[0] - 90;
      try {
        overviewLng = subsolarPoint(Date.now())[0] - 90;
      } catch {
        // fallback-значение выше
      }
      // Стадия 1 — ВОСХОД: солнце поднимается из-за края. Плавный пан от лимба
      // (старт subsolar−110° в onGlobeReady) к обзору (subsolar−90°) за ~3.5с —
      // солнце «растёт» из сливера до полного. Стадия 2 — плавный пролёт к геолокации.
      g.pointOfView({ lat: overviewLat, lng: overviewLng, altitude: OVERVIEW_ALTITUDE }, INTRO_SUNRISE_MS);
      flyTimer = window.setTimeout(() => {
        try {
          globeRef.current?.pointOfView?.(
            { lat: target.lat, lng: target.lng, altitude: RESTING_ALTITUDE },
            INTRO_FLY_MS,
          );
        } catch {
          // ignore
        }
        // Босс 2026-05-29 «продолжая плавный поворот»: после прилёта к геолокации —
        // МЯГКОЕ авто-вращение (не резкое). Включаем по завершении полёта.
        rotTimer = window.setTimeout(() => {
          try {
            const c = globeRef.current?.controls?.();
            if (c) { c.autoRotate = true; c.autoRotateSpeed = 0.22; }
          } catch { /* no-op */ }
        }, INTRO_FLY_MS + 400);
      }, INTRO_SUNRISE_MS + INTRO_OVERVIEW_HOLD_MS);
    } catch {
      // ignore
    }
    return () => {
      if (flyTimer !== null) window.clearTimeout(flyTimer);
      if (rotTimer !== null) window.clearTimeout(rotTimer);
    };
  }, [ready, userLatLng, points]);

  // Fallback: если геолокация так и не пришла (отказ/таймаут ~6с), после короткого
  // обзора плавно садимся на resting altitude на текущем обзорном кадре (Солнце+Луна),
  // чтобы глобус не «завис» на общем плане. Если геолокация появится — основной
  // интро-effect выше перехватит наводку. Таймер очищается в cleanup.
  useEffect(() => {
    if (!ready || userLatLng) return;
    if (prefersReducedMotion()) return;
    const settleTimer = window.setTimeout(() => {
      if (userLatLngRef.current) return; // геолокация подоспела — её ведёт другой effect
      try {
        const g = globeRef.current;
        const pov = g?.pointOfView?.();
        if (pov) {
          g.pointOfView({ lat: pov.lat, lng: pov.lng, altitude: RESTING_ALTITUDE }, INTRO_FLY_MS);
        }
      } catch {
        // ignore
      }
    }, INTRO_OVERVIEW_HOLD_MS + 5000);
    return () => window.clearTimeout(settleTimer);
  }, [ready, userLatLng]);

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

  // rAF-цикл: globeRotation uniform + яркость маркеров (фронт + день/ночь) +
  // кольца + огоньки столиц ночью. Throttle ~12fps (lightweight).
  useEffect(() => {
    if (!ready) return;
    let destroyed = false;
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

      // Разворот камеры в шейдер — терминатор в реальной ориентации при вращении.
      try {
        dayNight?.uniforms?.globeRotation?.value?.set?.(camLng, camLat);
      } catch {
        // ignore
      }

      const sunDir = sunDirRef.current;
      const pts = basePointsRef.current;
      if (pts.length === 0) {
        return;
      }

      const nextFront = new Set<string>();
      const newRings: RingDatum[] = [];
      const capPts: GlobePoint[] = [];

      // Сердечный пульс «тук-тук» (Босс: не часто, стильно, как пульс сердца).
      // Период 3 сек: сильный «тук» (lub) + чуть слабее «тук» (dub), затем покой.
      // Все огни пульсируют синхронно мягко (±18%) — не дёрганое мигание.
      const HB_PERIOD = 3000;
      const hbPhase = (now % HB_PERIOD) / HB_PERIOD;
      const lub = Math.exp(-Math.pow((hbPhase - 0.08) / 0.05, 2));
      const dub = 0.7 * Math.exp(-Math.pow((hbPhase - 0.22) / 0.055, 2));
      const heart = Math.min(1, lub + dub); // 0..1
      const pulse = 0.82 + 0.18 * heart;

      const lit: GlobePoint[] = pts.map((p) => {
        const delta = Math.abs(lngDelta(p.lng, camLng)); // 0 центр → 180 сзади
        const isFront = delta <= FRONT_HALF_DEG;
        const illum = illumination(p.lat, p.lng, sunDir); // >0 день, <0 ночь
        const isNight = illum < 0;

        if (isFront) {
          nextFront.add(p.key);
          if (!frontSetRef.current.has(p.key)) {
            const w = p.weight || 1;
            newRings.push({
              lat: p.lat,
              lng: p.lng,
              color: [BRAND_FUCHSIA, BRAND_CYAN, BRAND_PURPLE],
              maxR: 4 + Math.min(5, Math.log10(w + 1) * 2.5),
              speed: 2.4,
              period: 900,
              bornAt: now,
              id: ringIdRef.current++,
            });
          }
          // Столица в тени (ночь) и во фронте → яркий тёплый огонёк (Босс п.3).
          // Вкладываем в поток точек (отдельный канал labels занят названиями).
          const capDelta = Math.abs(lngDelta(p.capLng, camLng));
          const capIllum = illumination(p.capLat, p.capLng, sunDir);
          if (capDelta <= FRONT_HALF_DEG && capIllum < -0.02) {
            const depth = Math.min(1, -capIllum / 0.6);
            const frontF = 1 - (capDelta / FRONT_HALF_DEG) * 0.7;
            // Яркие точки столиц (Босс) + мягкий сердечный пульс.
            const a = Math.max(0.55, Math.min(1, (depth * frontF + 0.4) * pulse));
            capPts.push({
              lat: p.capLat,
              lng: p.capLng,
              label: p.label,
              weight: 0,
              baseColor: "#FFE9A8",
              color: hexToRgba("#FFF0C2", a), // тёплый яркий «городской свет»
              altitude: 0.01,
              capLat: p.capLat,
              capLng: p.capLng,
              key: `${p.key}:cap`,
              _front: true,
            });
          }
        }

        // Яркость: НЕПРЕРЫВНАЯ по фронтальности (без резкого скачка на границе —
        // это и был «некрасивый» блинк) + днём ярче ночи + мягкий сердечный пульс.
        const fr = Math.max(0, Math.min(1, 1 - delta / 130));
        const frEase = fr * fr * (3 - 2 * fr); // smoothstep — плавно
        const dayFactor = 0.55 + 0.45 * Math.max(0, Math.min(1, (illum + 0.2) / 1.2));
        const base = (0.2 + 0.62 * frEase) * dayFactor;
        const alpha = Math.max(0.14, Math.min(1, base * pulse));
        const color = hexToRgba(p.baseColor, alpha);
        const baseAlt = 0.02 + Math.min(0.22, Math.log10((p.weight || 1) + 1) * 0.08);
        const altitude = isFront ? baseAlt * 1.6 : baseAlt * 0.55;

        return { ...p, _front: isFront, _delta: delta, _night: isNight, color, altitude };
      });

      frontSetRef.current = nextFront;
      setLitPoints(capPts.length ? [...lit, ...capPts] : lit);

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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, dayNight]);

  useEffect(() => {
    if (!ready) setLitPoints(points);
  }, [points, ready]);

  // OrbitControls (auto-rotate + zoom) + стартовый обзор. Defensive.
  const onGlobeReady = () => {
    try {
      const g = globeRef.current;
      if (!g) {
        setReady(true);
        return;
      }
      const controls = g.controls?.();
      if (controls) {
        // Босс 2026-05-29: НЕ «резко крутится» — авто-вращение ВЫКЛ. Камера спокойно
        // делает интро-полёт от восхода к геолокации, дальше юзер вращает сам.
        controls.autoRotate = false;
        controls.enableZoom = true;
        controls.enablePan = false;
        controls.minDistance = 180;
        controls.maxDistance = 600;
        controls.rotateSpeed = 0.7;
        controls.zoomSpeed = 0.8;
      }
      // Стартовый кадр — точка ВОСХОДА (терминатор, экватор): лучи солнца задевают
      // край земли, виден восход + Луна. Ставим СРАЗУ (duration 0), пока канвас ещё
      // прозрачный (opacity 0→1) → плавно с первого кадра, без рывка/прыжка.
      try {
        // Старт на ЛИМБЕ (subsolar−110°): солнце с лучами только пробивается из-за
        // края земли (сливер). Дальше intro-эффект плавно «поднимает» его (пан к −90°).
        const sp0 = subsolarPoint(Date.now());
        g.pointOfView?.({ lat: 0, lng: sp0[0] - 110, altitude: OVERVIEW_ALTITUDE }, 0);
      } catch { /* no-op */ }
      // Видимые 3D-Солнце и Луна (Босс «Солнца и Луну не видно»). Добавляем в
      // сцену один раз; позиция — над субсолярной/подлунной точками (positionSunMoon).
      try {
        const scene = g.scene?.();
        if (scene && !sunMeshRef.current) {
          // Солнце — яркий диск + аддитивное гало.
          const sun = new THREE.Mesh(
            new THREE.SphereGeometry(11, 28, 28),
            new THREE.MeshBasicMaterial({ color: 0xfff1c4 }),
          );
          const glow = new THREE.Mesh(
            new THREE.SphereGeometry(22, 28, 28),
            new THREE.MeshBasicMaterial({
              color: 0xffd27a, transparent: true, opacity: 0.28,
              blending: THREE.AdditiveBlending, depthWrite: false,
            }),
          );
          sun.add(glow);
          scene.add(sun);
          sunMeshRef.current = sun;
        }
        if (scene && !moonMeshRef.current) {
          // Луна — серый диск с лёгким холодным свечением по краю.
          const moon = new THREE.Mesh(
            new THREE.SphereGeometry(4.2, 28, 28),
            new THREE.MeshBasicMaterial({ color: 0xd9dbe2 }),
          );
          const moonGlow = new THREE.Mesh(
            new THREE.SphereGeometry(6.4, 24, 24),
            new THREE.MeshBasicMaterial({
              color: 0xaab4d6, transparent: true, opacity: 0.18,
              blending: THREE.AdditiveBlending, depthWrite: false,
            }),
          );
          moon.add(moonGlow);
          scene.add(moon);
          moonMeshRef.current = moon;
        }
        positionSunMoon();
      } catch (e) {
        console.error("[GlobeView] sun/moon setup failed:", e);
      }

      // Стартовый кадр перед интро-анимацией (Босс 2026-05-29): обзор «рассвет
      // Солнца и Луны» — точка между субсолярной и подлунной, общий план, чтобы
      // видеть Солнце+Луну. Дальнейший плавный полёт к геолокации делает effect
      // [ready, userLatLng] (после setReady ниже). При reduced-motion или отсутствии
      // геолокации интро не летит — остаётся этот обзорный/fallback кадр.
      try {
        const sp = subsolarPoint(Date.now()); // [lng, lat]
        const mp = subLunarPoint(Date.now()); // [lng, lat]
        const overLat = (sp[1] + mp[1]) / 2;
        const overLng = sp[0] + lngDelta(mp[0], sp[0]) / 2;
        g.pointOfView?.({ lat: overLat, lng: overLng, altitude: OVERVIEW_ALTITUDE }, 0);
      } catch {
        // Fallback: Солнце слева (камера на 90° восточнее субсолярной долготы).
        const [subLng] = subsolarPoint(Date.now());
        g.pointOfView?.({ lat: 22, lng: subLng + 90, altitude: OVERVIEW_ALTITUDE }, 0);
      }
    } catch (e) {
      console.error("[GlobeView] onGlobeReady controls setup failed:", e);
    } finally {
      setReady(true);
    }
  };

  // Разворот камеры → globeRotation uniform (мгновенно, в дополнение к rAF).
  const onZoom = (pov: { lat: number; lng: number }) => {
    try {
      dayNight?.uniforms?.globeRotation?.value?.set?.(pov.lng ?? 0, pov.lat ?? 0);
    } catch {
      // ignore
    }
  };

  return (
    <div
      ref={wrapRef}
      className="absolute inset-0"
      data-testid="globe-3d-canvas"
      // Near-black с нотками MuzaAi (подложка под звёздный фон, без «вспышки пустоты»
      // пока грузится текстура неба): глубокий космос + лёгкие purple/cyan-блики бренда.
      style={{
        // Near-black с нотками MuzaAi — подложка под текстуру звёздного неба
        // (без «вспышки пустоты» пока грузится night-sky.png).
        background:
          "radial-gradient(ellipse at 22% 28%, rgba(124,58,237,0.16) 0%, transparent 55%)," +
          "radial-gradient(ellipse at 80% 78%, rgba(0,212,255,0.12) 0%, transparent 60%)," +
          "#03030a",
        // Плавное появление сцены + мягкий рост детализации (Босс «плавный»).
        opacity: ready ? 1 : 0,
        filter: texturesReady ? "none" : "saturate(0.78) brightness(0.92)",
        transition: "opacity 0.7s ease, filter 0.8s ease",
      }}
    >
      <Globe
        ref={globeRef}
        width={size.w}
        height={size.h}
        backgroundColor="rgba(0,0,0,0)"
        backgroundImageUrl={NIGHT_SKY_URL}
        rendererConfig={{ antialias: true, alpha: true }}
        {...(dayNight && texturesReady
          ? { globeMaterial: dayNight.material }
          : cheapMat
            ? { globeMaterial: cheapMat }
            : { globeImageUrl: EARTH_DAY_URL, bumpImageUrl: EARTH_BUMP_URL })}
        showAtmosphere={true}
        atmosphereColor="#7C3AED"
        atmosphereAltitude={0.22}
        onGlobeReady={onGlobeReady}
        onZoom={onZoom}
        pointsData={litPoints}
        pointLat={(d: GlobePoint) => d.lat}
        pointLng={(d: GlobePoint) => d.lng}
        pointColor={(d: GlobePoint) => d.color}
        pointAltitude={(d: GlobePoint) => d.altitude ?? 0.04}
        pointRadius={(d: GlobePoint) => (d._front ? 0.6 : 0.32)}
        pointResolution={6}
        pointsTransitionDuration={300}
        pointLabel={(d: GlobePoint) => {
          const flag = isoToFlag(d.key.replace(/:cap$/, ""));
          return `<div style="font-family:Inter,sans-serif;font-size:13px;color:#fff;background:rgba(10,10,23,0.88);padding:5px 9px;border-radius:9px;border:1px solid rgba(124,58,237,0.55);display:flex;align-items:center;gap:6px">${d.label}${d.weight ? `<span style="opacity:.6">· ${d.weight}</span>` : ""}${flag ? `<span style="font-size:16px">${flag}</span>` : ""}</div>`;
        }}
        labelsData={labelData}
        labelLat={(d: CapitalLight) => d.lat}
        labelLng={(d: CapitalLight) => d.lng}
        labelText={(d: CapitalLight) => d.label}
        labelColor={(d: CapitalLight) => d.color}
        labelDotRadius={0}
        labelSize={0.62}
        labelResolution={2}
        labelAltitude={0.014}
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

  const points = useMemo<GlobePoint[]>(() => {
    const arr: GlobePoint[] = [];
    let i = 0;
    for (const c of countries) {
      const ll = resolveLatLon(c.code, c.name);
      if (!ll) continue;
      const weight = c.visits || c.n || 1;
      const baseColor = MARKER_COLORS[i % MARKER_COLORS.length];
      const cap = resolveCapital(c.code, c.name) || ll;
      arr.push({
        lat: ll[0],
        lng: ll[1],
        label: c.name,
        weight,
        baseColor,
        color: baseColor,
        altitude: 0.02 + Math.min(0.22, Math.log10(weight + 1) * 0.08),
        capLat: cap[0],
        capLng: cap[1],
        key: (c.code || c.name || `i${i}`).toUpperCase(),
      });
      i++;
    }
    return arr;
  }, [countries]);

  if (!webglOk) {
    return <CountriesFallbackList countries={countries} />;
  }

  const fallback = <CountriesFallbackList countries={countries} />;

  return (
    <div className="relative w-full h-full">
      <GlobeErrorBoundary fallback={fallback}>
        <Suspense fallback={<GlobeLoader />}>
          <GlobeInner points={points} />
        </Suspense>
      </GlobeErrorBoundary>
    </div>
  );
}
