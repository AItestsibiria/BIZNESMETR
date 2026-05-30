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
// Звёздное небо ВНУТРИ окна глобуса (Босс: внутри окна — звёздное небо и Земля).
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
  uniform float uWarmGlow; // 0..1 — тёплое сияние Солнца на видимой стороне (Босс 2026-05-30)
  uniform float uTime;     // секунды — медленная анимация «нитей света»
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
    // Босс 2026-05-30: «лёгкие нити света тепло доходят до видимой от солнца части планеты».
    // intensity > 0 — дневная сторона. dayFace 0..1, максимум там где Солнце в зените.
    float dayFace = smoothstep(0.0, 0.55, intensity);
    // «Нити» — медленные тёплые волны яркости по дневной стороне (uTime даёт жизнь).
    // Псевдо-шум через sin-комбинацию + лёгкая зависимость от vUv (текстурные координаты).
    float w1 = sin(vUv.x * 12.3 + uTime * 0.55) * 0.5 + 0.5;
    float w2 = sin(vUv.y * 9.7 - uTime * 0.42 + 1.7) * 0.5 + 0.5;
    float threads = w1 * w2; // 0..1, медленно плывущие пятна
    vec3 warmTint = vec3(1.00, 0.78, 0.48); // мягкое тёплое золото
    // Базовое тёплое сияние видимой стороны (всегда мало) + усиление при закате (uWarmGlow).
    float warmA = (0.08 + 0.35 * uWarmGlow) * dayFace * (0.6 + 0.4 * threads);
    col = mix(col, warmTint, warmA);
    // На самом терминаторе (intensity ≈ 0) добавляем оранжевый ободок «солнечная корона
    // на лимбе планеты» — Босс 2026-05-30 «слегка оранжево добавь в рассвет/закат».
    float term = 1.0 - smoothstep(0.0, 0.18, abs(intensity));
    vec3 sunsetCol = vec3(1.00, 0.55, 0.22);
    col = mix(col, sunsetCol, term * (0.18 + 0.55 * uWarmGlow));
    gl_FragColor = vec4(col, 1.0);
  }
`;

type DayNightMaterial = {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  material: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  uniforms: any;
};

// Фазовый шейдер Луны (Босс 2026-05-29: «Луна по правилам астрономии отражает
// солнце, обратная в тени»). Освещённость фрагмента = dot(мировая нормаль,
// направление на Солнце): сторона к Солнцу светлая, противоположная — в тени.
// Видимая фаза (серп/половина/полнолуние) возникает естественно из геометрии.
const MOON_VERTEX = `
  varying vec3 vWorldNormal;
  void main() {
    vWorldNormal = normalize(mat3(modelMatrix) * normal);
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;
const MOON_FRAGMENT = `
  uniform vec3 sunDir; // единичный вектор НА Солнце (мировые координаты)
  varying vec3 vWorldNormal;
  void main() {
    float i = dot(normalize(vWorldNormal), normalize(sunDir));
    float lit = smoothstep(-0.08, 0.12, i);   // мягкий терминатор Луны
    vec3 litCol  = vec3(0.90, 0.92, 0.99);    // освещённая сторона
    vec3 darkCol = vec3(0.03, 0.035, 0.065);  // обратная сторона — в тени
    gl_FragColor = vec4(mix(darkCol, litCol, lit), 1.0);
  }
`;

// Солнце (Босс 2026-05-30): 3D-сфера с плазменным шейдером (огненная поверхность,
// гранулы, горячие пятна) + внешняя «корона» из анимированного шума на лимбе —
// короткие переменные «лучи‑языки пламени», не длинный starburst. Референс — фото
// солнечного диска с короной по краю.
const SUN_VERTEX = `
  varying vec3 vNormal;
  varying vec3 vPos;
  varying vec3 vViewPos;
  void main() {
    vNormal = normalize(normalMatrix * normal);
    vPos = position;
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    vViewPos = mv.xyz;
    gl_Position = projectionMatrix * mv;
  }
`;
// Common noise helpers (используются в обоих шейдерах Солнца).
const SUN_NOISE = `
  float hash3(vec3 p) {
    p = fract(p * vec3(443.8975, 397.2973, 491.1871));
    p += dot(p, p.yxz + 19.19);
    return fract((p.x + p.y) * p.z);
  }
  float noise3(vec3 p) {
    vec3 i = floor(p); vec3 f = fract(p);
    f = f * f * (3.0 - 2.0 * f);
    return mix(mix(mix(hash3(i + vec3(0.0,0.0,0.0)), hash3(i + vec3(1.0,0.0,0.0)), f.x),
                   mix(hash3(i + vec3(0.0,1.0,0.0)), hash3(i + vec3(1.0,1.0,0.0)), f.x), f.y),
               mix(mix(hash3(i + vec3(0.0,0.0,1.0)), hash3(i + vec3(1.0,0.0,1.0)), f.x),
                   mix(hash3(i + vec3(0.0,1.0,1.0)), hash3(i + vec3(1.0,1.0,1.0)), f.x), f.y), f.z);
  }
  float fbm3(vec3 p) {
    float v = 0.0; float a = 0.5;
    for (int i = 0; i < 5; i++) { v += a * noise3(p); p *= 2.0; a *= 0.5; }
    return v;
  }
`;
const SUN_FRAGMENT = SUN_NOISE + `
  uniform float uTime;
  varying vec3 vNormal;
  varying vec3 vPos;
  varying vec3 vViewPos;
  void main() {
    vec3 p = normalize(vPos) * 3.0;
    float t = uTime * 0.18;
    float n1 = fbm3(p + vec3(0.0, 0.0, t));
    float n2 = fbm3(p * 2.1 + vec3(t * 1.3, t * 0.7, 0.0));
    float plasma = mix(n1, n2, 0.55);
    // Горячие «гранулы» из пиков шума.
    float hot = smoothstep(0.55, 0.85, n1 + n2 * 0.35);
    vec3 cWhite = vec3(1.00, 0.99, 0.92);  // почти белый горячий центр гранул (Босс 2026-05-30: «смешай с белым»)
    vec3 cYellow = vec3(1.00, 0.82, 0.55); // светло-жёлтый базовый (белее предыдущего)
    vec3 cOrange = vec3(1.00, 0.62, 0.30); // оранжево-розовые впадины (мягче, белее)
    vec3 base = mix(cOrange, cYellow, plasma);
    base = mix(base, cWhite, hot);
    // Лимб слегка темнее — атмосферное затемнение края.
    vec3 viewDir = normalize(-vViewPos);
    float fres = 1.0 - max(0.0, dot(normalize(vNormal), viewDir));
    base = mix(base, cOrange * 1.05, fres * 0.5);
    base *= 1.12 + 0.12 * plasma;
    gl_FragColor = vec4(base, 1.0);
  }
`;
// Корона — БИЛБОРДНЫЙ план (всегда лицом к камере), радиальные «огненные
// волоски»: тонкие, переменной длины, динамичные (Босс 2026-05-30, референс
// фото с протуберанцами). Полярные координаты от центра плана + 2D шум по углу.
const BILLBOARD_VERTEX = `
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;
const SUN_NOISE_2D = `
  float hash2(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
  float noise2(vec2 p) {
    vec2 i = floor(p); vec2 f = fract(p);
    f = f * f * (3.0 - 2.0 * f);
    return mix(mix(hash2(i + vec2(0.0,0.0)), hash2(i + vec2(1.0,0.0)), f.x),
               mix(hash2(i + vec2(0.0,1.0)), hash2(i + vec2(1.0,1.0)), f.x), f.y);
  }
  float fbm2(vec2 p) {
    float v = 0.0; float a = 0.5;
    for (int i = 0; i < 4; i++) { v += a * noise2(p); p *= 2.0; a *= 0.5; }
    return v;
  }
`;
const SUN_CORONA_FRAGMENT = SUN_NOISE_2D + `
  uniform float uTime;
  uniform float uSunsetBoost;     // 0..1 — Солнце касается лимба Земли (Босс 2026-05-30)
  uniform float uFlareIntensity;  // 0..1 — пик в момент полу-окклюзии Солнца Землёй (Босс 2026-05-30)
  uniform vec2  uFlareDir;        // unit-vec в plane-space, куда направлен flare (от Земли к видимой части кадра)
  varying vec2 vUv;
  void main() {
    vec2 c = vUv - 0.5;        // -0.5..0.5
    float r = length(c) * 2.0;  // 0 центр .. 1 край плана
    // Босс 2026-05-30: «усиль в 3 раза концентрацию лучей в сторону камеры» —
    // на пике окклюзии Солнце «слепит» прямо в зрителя: жёсткая белая вспышка
    // в центре плана, видимая даже за лимбом Земли (depthTest=false на короне).
    float centerBurst = (1.0 - smoothstep(0.0, 0.55, r)) * uFlareIntensity;
    if (r < 0.42) {
      // Внутри диска Солнца — только central flash, без волосков.
      vec3 burstCol = mix(vec3(1.00, 0.92, 0.72), vec3(1.00, 1.00, 0.96), centerBurst);
      gl_FragColor = vec4(burstCol, centerBurst * 0.95);
      return;
    }
    if (r > 1.0) discard;
    float ang = atan(c.y, c.x);  // -pi..pi
    float t = uTime;
    // Направленный flare (Босс 2026-05-30 «3д»): когда Солнце «задевает» Землю с т.зр.
    // камеры, лучи В НАПРАВЛЕНИИ ВИДИМОЙ части кадра становятся ярче и длиннее.
    // ×3 КОНЦЕНТРАЦИЯ В КАМЕРУ (Босс 2026-05-30): pow 3→9 — узкий острый пучок,
    // как настоящий lens-flare с фотографии заходящего за горизонт Солнца.
    vec2 pixDir = (length(c) > 0.001) ? normalize(c) : vec2(1.0, 0.0);
    float aligned = max(0.0, dot(pixDir, uFlareDir));
    float coneSharp = pow(aligned, 9.0);
    float flareBoost = coneSharp * uFlareIntensity;
    // Угловая текстура из высокочастотного шума → тонкие радиальные «волоски».
    // Босс 2026-05-30: «плотность лучей увеличить в 2 раза» — повышены частоты + понижен порог.
    float s1 = fbm2(vec2(ang * 22.0, t * 0.55));
    float s2 = fbm2(vec2(ang * 50.0, t * 1.3 + 7.3));
    float streak = pow(s1, 1.5) * pow(s2, 1.1);
    streak = clamp(streak * 3.6 - 0.25, 0.0, 1.0); // больше «волосков», но всё ещё избирательно
    // В flare-зоне волоски «сгущаются» — порог опускается ещё ниже → больше лучей.
    streak = clamp(streak + flareBoost * 0.35, 0.0, 1.0);
    // Переменная длина каждого «волоска» по углу (низкая частота).
    // Босс 2026-05-30: «длина лучей 1,5-3 раз разной длины» — 0.30..1.00 даёт ×3.3 разброс.
    // На закате/рассвете лучи плавно удлиняются (uSunsetBoost) — закат «грандиозный».
    // В flare-направлении длина и яркость утраиваются (Босс 2026-05-30 «×3 концентрация»).
    float lenN = fbm2(vec2(ang * 5.5, t * 0.35 + 2.1));
    float lenScale = 1.0 + uSunsetBoost * 0.55 + flareBoost * 6.0;   // до ×7 в пучке
    float maxR = clamp((0.30 + lenN * 0.70) * lenScale, 0.30, 1.50);
    // Профиль яркости: яркий у лимба, плавно гаснет к концу волоска.
    float fadeIn  = smoothstep(0.42, 0.50, r);
    float fadeOut = 1.0 - smoothstep(maxR * 0.68, maxR, r);
    float profile = fadeIn * fadeOut;
    float brightScale = 1.0 + uSunsetBoost * 0.65 + flareBoost * 5.4; // вспышка ×3 ярче
    float alpha = profile * streak * 0.95 * brightScale;
    // Босс 2026-05-30: «цвет солнца и лучей смешай с белым» — оба конца градиента ближе к белому.
    vec3 col = mix(vec3(1.00, 0.70, 0.40), vec3(1.00, 0.98, 0.92), streak);
    // На закате цвет смещается в тёплый оранжевый («слегка оранжево» — Босс).
    vec3 sunset = mix(vec3(1.00, 0.45, 0.18), vec3(1.00, 0.78, 0.45), streak);
    col = mix(col, sunset, uSunsetBoost * 0.55);
    // Вспышка в направлении flare — почти белый горячий свет.
    col = mix(col, vec3(1.00, 0.96, 0.88), flareBoost * 0.65);
    gl_FragColor = vec4(col, alpha);
  }
`;

// Сборка Солнца: тело (3D-сфера с плазмой) + билбордный план короны с радиальными
// «огненными волосками». Корону ориентирует к камере раз в кадр (см. rAF loop).
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function makeSunGroup(radius: number): { group: any; body: any; bodyMat: any; corona: any; coronaMat: any } | null {
  try {
    const bodyMat = new THREE.ShaderMaterial({
      uniforms: { uTime: { value: 0 } },
      vertexShader: SUN_VERTEX,
      fragmentShader: SUN_FRAGMENT,
    });
    const bodyGeo = new THREE.SphereGeometry(radius, 64, 64);
    const body = new THREE.Mesh(bodyGeo, bodyMat);
    const coronaMat = new THREE.ShaderMaterial({
      uniforms: {
        uTime: { value: 0 },
        uSunsetBoost: { value: 0 },
        uFlareIntensity: { value: 0 },                  // 0..1 — пик в полу-окклюзии
        uFlareDir: { value: new THREE.Vector2(1, 0) },  // unit-vec в plane-space (от Земли к Sun)
      },
      vertexShader: BILLBOARD_VERTEX,
      fragmentShader: SUN_CORONA_FRAGMENT,
      transparent: true,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    });
    // План 7R × 7R: «волоски» доходят до ~3 радиусов Солнца от лимба
    // (Босс 2026-05-30: длина лучей 1.5-3× — план расширен, чтобы хватило места длинным).
    const coronaSize = radius * 7;
    const coronaGeo = new THREE.PlaneGeometry(coronaSize, coronaSize);
    const corona = new THREE.Mesh(coronaGeo, coronaMat);
    corona.renderOrder = 2; // поверх тела (тело depthWrite — сначала)
    const group = new THREE.Group();
    group.add(body);
    group.add(corona);
    return { group, body, bodyMat, corona, coronaMat };
  } catch (e) {
    console.warn("[GlobeView] makeSunGroup failed:", e);
    return null;
  }
}

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
      uWarmGlow: { value: 0 }, // 0..1 — закат/рассвет, обновляется rAF (Босс 2026-05-30)
      uTime: { value: 0 },     // секунды — медленная «жизнь» тёплых нитей света
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

// Слепящая вспышка Солнца (Босс 2026-05-29 «надо чтобы прям слепило, играли лучи»):
// Sprite ВСЕГДА развёрнут к камере → круглый в любой точке кадра (3D-сфера у края
// проецируется в эллипс). Луна — шар с фазовым шейдером (см. ниже).
// белое ядро + аддитивное гало + лучи-спайки (starburst). Лучи «играют» (вращение
// material.rotation в rAF), яркость переменная (модуляция scale/opacity по лимбу).
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function makeSunFlareSprite(size: number): any {
  try {
    const N = 256;
    const cvs = document.createElement("canvas");
    cvs.width = N;
    cvs.height = N;
    const ctx = cvs.getContext("2d");
    if (!ctx) return null;
    const c = N / 2;
    // Гало (bloom): белое ядро → тёплое свечение → прозрачно.
    const halo = ctx.createRadialGradient(c, c, 0, c, c, c);
    halo.addColorStop(0.0, "rgba(255,255,255,1)");
    halo.addColorStop(0.1, "rgba(255,250,236,1)");
    halo.addColorStop(0.24, "rgba(255,226,150,0.85)");
    halo.addColorStop(0.5, "rgba(255,192,112,0.35)");
    halo.addColorStop(1.0, "rgba(255,170,80,0)");
    ctx.fillStyle = halo;
    ctx.fillRect(0, 0, N, N);
    // Лучи-спайки (слепящий starburst), аддитивно поверх гало.
    ctx.translate(c, c);
    ctx.globalCompositeOperation = "lighter";
    const rays = 12;
    for (let i = 0; i < rays; i++) {
      const ang = (i / rays) * Math.PI * 2;
      const long = i % 2 === 0 ? c * 0.97 : c * 0.6;
      const w = i % 2 === 0 ? 5 : 3;
      ctx.save();
      ctx.rotate(ang);
      const g = ctx.createLinearGradient(0, 0, long, 0);
      g.addColorStop(0, "rgba(255,255,255,0.95)");
      g.addColorStop(0.5, "rgba(255,226,150,0.32)");
      g.addColorStop(1, "rgba(255,200,120,0)");
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.moveTo(0, -w);
      ctx.lineTo(long, 0);
      ctx.lineTo(0, w);
      ctx.closePath();
      ctx.fill();
      ctx.restore();
    }
    const tex = new THREE.CanvasTexture(cvs);
    const mat = new THREE.SpriteMaterial({
      map: tex,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });
    const spr = new THREE.Sprite(mat);
    spr.scale.set(size, size, 1);
    return spr;
  } catch {
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

// ───────────────────────────────────────────────────────────────────────────
// Планеты (Меркурий/Венера/Марс/Юпитер/Сатурн) — низкоточная геоцентрическая
// эфемерида по Полю Шлютеру (orbital elements as fn of дня от эпохи 1999-12-31.0).
// Возвращает подпланетную точку [lng°, lat°] (точка Земли, где планета в зените) —
// тот же приём, что для Луны (subLunarPoint), → единый кадр со Солнцем/Луной/звёздами.
type OrbElem = {
  N: [number, number]; // долгота восходящего узла [base, /день]
  i: [number, number]; // наклонение
  w: [number, number]; // аргумент перигелия
  a: number; // большая полуось (а.е.)
  e: [number, number]; // эксцентриситет
  M: [number, number]; // средняя аномалия
};

const PLANET_ELEMENTS: Record<string, OrbElem> = {
  mercury: { N: [48.3313, 3.24587e-5], i: [7.0047, 5.0e-8], w: [29.1241, 1.01444e-5], a: 0.387098, e: [0.205635, 5.59e-10], M: [168.6562, 4.0923344368] },
  venus:   { N: [76.6799, 2.4659e-5],  i: [3.3946, 2.75e-8], w: [54.891, 1.38374e-5],  a: 0.72333,  e: [0.006773, -1.302e-9], M: [48.0052, 1.6021302244] },
  mars:    { N: [49.5574, 2.11081e-5], i: [1.8497, -1.78e-8], w: [286.5016, 2.92961e-5], a: 1.523688, e: [0.093405, 2.516e-9], M: [18.6021, 0.5240207766] },
  jupiter: { N: [100.4542, 2.76854e-5], i: [1.303, -1.557e-7], w: [273.8777, 1.64505e-5], a: 5.20256, e: [0.048498, 4.469e-9], M: [19.895, 0.0830853001] },
  saturn:  { N: [113.6634, 2.3898e-5], i: [2.4886, -1.081e-7], w: [339.3939, 2.97661e-5], a: 9.55475, e: [0.055546, -9.499e-9], M: [316.967, 0.0334442282] },
};

function rev(x: number): number {
  return ((x % 360) + 360) % 360;
}

// Дни от эпохи Шлютера (2000 Jan 0.0 UT = JD 2451543.5).
function schlyterDay(dt: number): number {
  return dt / 86400000 + 2440587.5 - 2451543.5;
}

// Геоцентрические RA/Dec планеты [deg, deg].
function planetRaDec(el: OrbElem, d: number): [number, number] {
  const rad = Math.PI / 180;
  // Солнце (для перевода гелиоцентрических → геоцентрических: xs, ys).
  const ws = 282.9404 + 4.70935e-5 * d;
  const es = 0.016709 - 1.151e-9 * d;
  const Ms = rev(356.047 + 0.9856002585 * d);
  const Es = Ms + (es / rad) * Math.sin(Ms * rad) * (1 + es * Math.cos(Ms * rad));
  const xvs = Math.cos(Es * rad) - es;
  const yvs = Math.sqrt(1 - es * es) * Math.sin(Es * rad);
  const vs = Math.atan2(yvs, xvs) / rad;
  const rs = Math.sqrt(xvs * xvs + yvs * yvs);
  const lonsun = (vs + ws) * rad;
  const xs = rs * Math.cos(lonsun);
  const ys = rs * Math.sin(lonsun);
  // Планета.
  const N = el.N[0] + el.N[1] * d;
  const i = el.i[0] + el.i[1] * d;
  const w = el.w[0] + el.w[1] * d;
  const a = el.a;
  const e = el.e[0] + el.e[1] * d;
  const M = rev(el.M[0] + el.M[1] * d);
  let E = M + (e / rad) * Math.sin(M * rad) * (1 + e * Math.cos(M * rad));
  for (let k = 0; k < 2; k++) {
    E = E - (E - (e / rad) * Math.sin(E * rad) - M) / (1 - e * Math.cos(E * rad));
  }
  const xv = a * (Math.cos(E * rad) - e);
  const yv = a * Math.sqrt(1 - e * e) * Math.sin(E * rad);
  const v = Math.atan2(yv, xv) / rad;
  const r = Math.sqrt(xv * xv + yv * yv);
  const vw = (v + w) * rad;
  const Nr = N * rad;
  const ir = i * rad;
  const xh = r * (Math.cos(Nr) * Math.cos(vw) - Math.sin(Nr) * Math.sin(vw) * Math.cos(ir));
  const yh = r * (Math.sin(Nr) * Math.cos(vw) + Math.cos(Nr) * Math.sin(vw) * Math.cos(ir));
  const zh = r * (Math.sin(vw) * Math.sin(ir));
  // Геоцентрические эклиптические.
  const xg = xh + xs;
  const yg = yh + ys;
  const zg = zh;
  // Эклиптика → экватор.
  const ecl = (23.4393 - 3.563e-7 * d) * rad;
  const xe = xg;
  const ye = yg * Math.cos(ecl) - zg * Math.sin(ecl);
  const ze = yg * Math.sin(ecl) + zg * Math.cos(ecl);
  const ra = rev(Math.atan2(ye, xe) / rad);
  const dec = Math.atan2(ze, Math.sqrt(xe * xe + ye * ye)) / rad;
  return [ra, dec];
}

// Подпланетная точка [lng°, lat°] (RA/Dec → lng через GMST, как у Луны).
function subPlanetPoint(planetKey: string, dt: number): [number, number] {
  const el = PLANET_ELEMENTS[planetKey];
  if (!el) return [0, 0];
  const [ra, dec] = planetRaDec(el, schlyterDay(dt));
  const dJ2000 = dt / 86400000 + 2440587.5 - 2451545.0;
  const gmst = (280.4606 + 360.9856473 * dJ2000) % 360;
  let lng = ((ra - gmst + 180) % 360) - 180;
  if (lng < -180) lng += 360;
  return [lng, dec];
}

// Спрайт планеты — мягкий цветной диск с лёгким гало (виден как «звезда-планета»).
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function makePlanetSprite(rgb: [number, number, number], size: number): any {
  try {
    const N = 64;
    const cvs = document.createElement("canvas");
    cvs.width = N;
    cvs.height = N;
    const ctx = cvs.getContext("2d");
    if (!ctx) return null;
    const c = N / 2;
    const [r, g, b] = rgb;
    const grad = ctx.createRadialGradient(c, c, 0, c, c, c);
    grad.addColorStop(0.0, "rgba(255,255,255,1)");
    grad.addColorStop(0.28, `rgba(${r},${g},${b},1)`);
    grad.addColorStop(0.6, `rgba(${r},${g},${b},0.5)`);
    grad.addColorStop(1.0, `rgba(${r},${g},${b},0)`);
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, N, N);
    const tex = new THREE.CanvasTexture(cvs);
    const mat = new THREE.SpriteMaterial({
      map: tex,
      transparent: true,
      depthWrite: false,
      depthTest: true, // прячется за Землёй (нельзя видеть планету сквозь планету)
      blending: THREE.AdditiveBlending,
    });
    const spr = new THREE.Sprite(mat);
    spr.scale.set(size, size, 1);
    return spr;
  } catch {
    return null;
  }
}

// Цвет + относительный размер каждой планеты (характерный вид на небе).
const PLANET_STYLE: Record<string, { rgb: [number, number, number]; size: number }> = {
  mercury: { rgb: [200, 200, 205], size: 26 },
  venus:   { rgb: [255, 246, 224], size: 40 },
  mars:    { rgb: [255, 122, 78], size: 30 },
  jupiter: { rgb: [240, 222, 184], size: 38 },
  saturn:  { rgb: [240, 224, 168], size: 34 },
};

// Радиус (мир) дальней небесной сферы для планет: ЗА Солнцем (Солнце ≈ 100·(1+2.2)=320)
// и в толще звёздного поля. 1500 → планеты «на звёздном небе», за Солнцем.
const PLANET_WORLD_RADIUS = 1500;

// Названия планет на английском (подпись при наведении — Босс 2026-05-29).
const PLANET_NAMES: Record<string, string> = {
  mercury: "Mercury",
  venus: "Venus",
  mars: "Mars",
  jupiter: "Jupiter",
  saturn: "Saturn",
};

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

// Тайминги/высоты интро (Босс 2026-05-29). Камеру ведёт единый rAF-режиссёр:
// восход (медленное вращение с 1-го кадра) → пролёт к геолокации (близкий подход)
// → пауза у точки (Морзе-приветствие из светящейся точки) → ПАНОРАМНЫЙ ОТЪЁЗД
// (точка пропорционально уменьшается, Морзе «Пока, Твоя Муза») → мягкое вращение.
const OVERVIEW_ALTITUDE = 3.0;    // обзор на восходе (видно Солнце и Луну)
const ARRIVE_ALTITUDE = 1.95;     // близкий подход к геолокации (точка крупно)
const CRUISE_ALTITUDE = 3.6;      // панорамный обзор после отъезда (Луна+Земля+Солнце в кадре)
const SUNRISE_HOLD_MS = 2600;     // восход: медленный показ + лёгкое вращение
const FLY_MS = 9000;              // плавный пролёт к геолокации
const ARRIVE_HOLD_MS = 3200;      // пауза у точки (Морзе-приветствие)
const DEPART_MS = 8000;           // панорамный отъезд (Морзе «Пока, Твоя Муза»)
const GLOBAL_DRIFT_DEG_S = 2.2;   // ЕДИНАЯ постоянная скорость вращения в ОДНУ сторону

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

// easeInOutCubic — плавно «от 1 до последнего кадра» (Босс: полёт плавный везде).
function easeInOutCubic(p: number): number {
  return p < 0.5 ? 4 * p * p * p : 1 - Math.pow(-2 * p + 2, 3) / 2;
}

// Центры континентов (для облёта east→west над экватором, Босс 2026-05-30).
// Антарктиду пропускаем (полюса не показываем). lat clamp ±50.
const CONTINENT_CENTERS: Array<{ lat: number; lng: number; name: string }> = [
  { lat: 50, lng: 15,   name: "Europe" },
  { lat: 0,  lng: 20,   name: "Africa" },
  { lat: 35, lng: 80,   name: "Asia" },
  { lat: -25,lng: 135,  name: "Australia" },
  { lat: 40, lng: -100, name: "NorthAmerica" },
  { lat: -15,lng: -60,  name: "SouthAmerica" },
];
// Возвращает целевую lat для текущей lng — ближайший континент (по lng-дуге).
function continentLatAtLng(lng: number): number {
  const n = ((lng + 540) % 360) - 180;
  let bestDist = Infinity;
  let bestLat = 0;
  for (const c of CONTINENT_CENTERS) {
    const d = Math.abs(((c.lng - n + 540) % 360) - 180);
    if (d < bestDist) { bestDist = d; bestLat = c.lat; }
  }
  return Math.max(-50, Math.min(50, bestLat));
}

// Азбука Морзе (латиница) — для «подмигивания» Музы. Мигаем словом MUZA.
const MORSE_TABLE: Record<string, string> = {
  A: ".-", B: "-...", C: "-.-.", D: "-..", E: ".", F: "..-.", G: "--.", H: "....",
  I: "..", J: ".---", K: "-.-", L: ".-..", M: "--", N: "-.", O: "---", P: ".--.",
  Q: "--.-", R: ".-.", S: "...", T: "-", U: "..-", V: "...-", W: ".--", X: "-..-",
  Y: "-.--", Z: "--..",
};
// Тайминг-последовательность вкл/выкл для слова (доли Морзе). Последовательность
// зацикливается на всё окно показа (Босс 2026-05-29 «10 сек Морзе»).
function morseTimeline(word: string): Array<{ on: boolean; ms: number }> {
  const DOT = 150, DASH = 450, GAP = 150, LGAP = 450;
  const seq: Array<{ on: boolean; ms: number }> = [];
  const letters = word.toUpperCase().split("");
  letters.forEach((ch, li) => {
    const code = MORSE_TABLE[ch];
    if (!code) return;
    code.split("").forEach((sym, si) => {
      seq.push({ on: true, ms: sym === "." ? DOT : DASH });
      if (si < code.length - 1) seq.push({ on: false, ms: GAP });
    });
    if (li < letters.length - 1) seq.push({ on: false, ms: LGAP });
  });
  return seq;
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
  // Материал Луны (фазовый шейдер) — обновляем uniform sunDir при движении Солнца.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const moonMatRef = useRef<any>(null);
  // Солнце-шейдеры (Босс 2026-05-30): плазма тело + анимированная огненная корона.
  // Каждый кадр обновляем uTime для шевеления плазмы и пламени.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const sunMatRef = useRef<any>(null);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const sunCoronaMatRef = useRef<any>(null);
  // Mesh короны — каждый кадр выставляем quaternion = camera.quaternion (билборд).
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const sunCoronaMeshRef = useRef<any>(null);
  // Глубокое 3D-звёздное поле (THREE.Points) — параллакс/«бесконечная глубина» за глобусом.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const deepStarsRef = useRef<any>(null);
  // Планеты (Меркурий/Венера/Марс/Юпитер/Сатурн) — спрайты на дальней небесной сфере,
  // позиции по реальной геоцентрической эфемериде (RA/Dec → подпланетная точка).
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const planetsRef = useRef<Array<{ key: string; mesh: any }>>([]);
  // Геолокация юзера для стартового обзора (Босс: «открытие глобуса по геолокации»).
  // Только ref — режиссёр читает его вживую в rAF (без перерендера и гонок таймеров).
  const userLatLngRef = useRef<{ lat: number; lng: number } | null>(null);
  const introDoneRef = useRef(false); // интро-полёт выполняется один раз
  // Камера-режиссёр: юзер сейчас сам вращает (пауза авто-движения) + хук пере-базы круиза.
  const userInteractingRef = useRef(false);
  const rebaseCruiseRef = useRef<(() => void) | null>(null);
  // Удержание камеры по двойному тапу (Босс 2026-05-29): после двойного тапа по планете
  // камера держит текущую позицию/траекторию до нового входа в режим или пока юзер сам
  // не сменит позицию (перетаскивание/зум).
  const holdRef = useRef(false);
  // 3-минутный таймер: после rotate юзером (с движением) → драфт от его ракурса
  // 3 мин, потом сценарий возобновляется (cycle_pano с начала). Босс 2026-05-30.
  const aiResumeAtRef = useRef<number>(0);
  // Sunset/sunrise boost (Босс 2026-05-30 «когда солнце задевает край земли — плавно
  // увеличить яркость и длину лучей»). 0..1 — плавно тянем к target в rAF.
  const sunsetBoostRef = useRef<number>(0);
  // Направленная вспышка (Босс 2026-05-30 «3д ... лучи увеличивают яркость и длину
  // направленную в видимую часть кадра, увеличивается до скрытия середины солнца,
  // потом затихает»). 0..1 + 2D-направление (camera plane-space).
  const flareIntensityRef = useRef<number>(0);
  const flareDirRef = useRef<{ x: number; y: number }>({ x: 1, y: 0 });
  // Морзе-подмигивание Музы: светящаяся точка ЗАКРЕПЛЕНА в точке геолокации
  // (проекция координаты в экран каждый кадр), без текста. По мере отъезда камеры
  // точка пропорционально уменьшается. Управление через ref'ы (без перерендера).
  const winkActiveRef = useRef(false);            // окно показа точки
  const morseOnRef = useRef(false);               // текущий импульс Морзе (вкл/выкл)
  const morseWordRef = useRef<string>("MUZA");     // что мигаем (приветствие → прощание)
  const winkAnchorRef = useRef<{ lat: number; lng: number } | null>(null);
  const winkDotRef = useRef<HTMLDivElement | null>(null);
  const winkCityRef = useRef<HTMLDivElement | null>(null);
  const cityNameRef = useRef<string>(""); // название города юзера (без доп. слов)
  const countryCodeRef = useRef<string>(""); // ISO-код страны (для эмодзи-флага, сам код не показываем)
  const winkFlagRef = useRef<HTMLDivElement | null>(null); // флаг страны (эмодзи, виден 3 сек на проходе)
  // Подпись планеты при наведении (Босс 2026-05-29). Экранные позиции планет считаются
  // каждый кадр в rAF (planetScreenRef), pointermove ищет ближайшую видимую → показывает имя.
  const planetLabelRef = useRef<HTMLDivElement | null>(null);
  const planetScreenRef = useRef<Array<{ key: string; x: number; y: number; r: number; visible: boolean }>>([]);
  const morseTimerRef = useRef<number | null>(null);
  // Целевая высота камеры для ПЛАВНОГО зума (кнопки +/− меняют её, круиз едет к ней).
  const zoomTargetRef = useRef<number | null>(null);
  // Режим полёта (Босс 2026-05-29): "ai" — многовариантная режиссура (Солнце/Земля/Луна);
  // "classic" — классический обзор Земли по параллели юзера, без диагональной режиссуры.
  // По умолчанию ВЕЗДЕ «Полёт» (classic); «Полёт Ai» включается кнопкой (Босс 2026-05-29).
  const flightModeRef = useRef<"classic" | "ai">("classic");

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
      // Освобождаем Солнце (Group из 2 шаров с шейдерами) и Луну (шар + фазовый шейдер).
      try {
        // Sun group: dispose всех children (body + corona), потом удалить группу.
        const sunG = sunMeshRef.current;
        if (sunG) {
          for (const child of sunG.children || []) {
            child.material?.dispose?.();
            child.geometry?.dispose?.();
          }
          sunG.parent?.remove?.(sunG);
        }
        const moon = moonMeshRef.current;
        if (moon) {
          moon.parent?.remove?.(moon);
          moon.material?.dispose?.();
          moon.geometry?.dispose?.();
        }
        sunMeshRef.current = null;
        sunMatRef.current = null;
        sunCoronaMatRef.current = null;
        sunCoronaMeshRef.current = null;
        moonMeshRef.current = null;
        moonMatRef.current = null;
      } catch {
        // ignore
      }
      // Освобождаем слои глубокого звёздного поля (Group → Points: geometry+material).
      try {
        const grp = deepStarsRef.current;
        if (grp) {
          for (const child of grp.children || []) {
            child.geometry?.dispose?.();
            child.material?.dispose?.();
          }
          grp.parent?.remove?.(grp);
        }
        deepStarsRef.current = null;
      } catch {
        // ignore
      }
      // Освобождаем спрайты планет (map + material).
      try {
        for (const p of planetsRef.current) {
          p.mesh.parent?.remove?.(p.mesh);
          p.mesh.material?.map?.dispose?.();
          p.mesh.material?.dispose?.();
        }
        planetsRef.current = [];
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
        // Ближе к Земле (Босс 2026-05-29: панорама Луна+Земля+Солнце в кадре) — 3.0→2.2.
        const c = g.getCoords(sp[1], sp[0], 2.2);
        sunMeshRef.current.position.set(c.x, c.y, c.z);
      }
      if (moonMeshRef.current) {
        const mp = subLunarPoint(Date.now());
        const c = g.getCoords(mp[1], mp[0], 1.5);
        moonMeshRef.current.position.set(c.x, c.y, c.z);
      }
      // Планеты — на дальней сфере (alt = R/100−1), по подпланетной точке (RA/Dec).
      if (planetsRef.current.length) {
        const palt = PLANET_WORLD_RADIUS / 100 - 1;
        const now = Date.now();
        for (const p of planetsRef.current) {
          const pp = subPlanetPoint(p.key, now);
          const c = g.getCoords(pp[1], pp[0], palt);
          p.mesh.position.set(c.x, c.y, c.z);
        }
      }
      // Фаза Луны: направление на Солнце в мировых координатах (= нормаль позиции
      // Солнца от центра сцены). Сторона Луны к Солнцу светлая, обратная — в тени.
      if (moonMatRef.current && sunMeshRef.current) {
        const s = sunMeshRef.current.position;
        const len = Math.hypot(s.x, s.y, s.z) || 1;
        moonMatRef.current.uniforms.sunDir.value.set(s.x / len, s.y / len, s.z / len);
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
          // Обратный геокодинг → название города НА АНГЛИЙСКОМ (Босс 2026-05-29).
          // Клиентский запрос без ключа; мягкий фолбэк — нет сети/города → без подписи.
          try {
            fetch(
              `https://api.bigdatacloud.net/data/reverse-geocode-client?latitude=${ll.lat}&longitude=${ll.lng}&localityLanguage=en`,
            )
              .then((r) => (r.ok ? r.json() : null))
              .then((d) => {
                if (cancelled || !d) return;
                // Только название города, без доп. слов (Босс 2026-05-29). Маленькое
                // поселение → ближайший город (city), иначе locality. Регион/страну НЕ пишем.
                // Полное название города со словами (напр. «Rio de Janeiro», «Нижний
                // Новгород»), БЕЗ админ-уточнений (округ/область/район/District/Oblast).
                // Босс 2026-05-29: НЕ дефисуем — натуральное имя с пробелами. Отсекаем
                // после запятой + вырезаем админ-слова. Пустое после чистки → исходное.
                const raw = String(d.city || d.locality || "").split(",")[0].trim();
                const cleaned = raw
                  .replace(
                    /\b(городской округ|муниципальн\w*|сельск\w*|поселени\w*|район|округ|область|край|автономн\w*|district|county|oblast|okrug|raion|krai|region|prefecture|province|municipalit\w*|gorodsk\w*|selsk\w*|poseleni\w*|munitsipaln\w*|avtonomn\w*)\b/gi,
                    " ",
                  )
                  .replace(/\s+/g, " ")
                  .trim();
                cityNameRef.current = cleaned || raw;
                countryCodeRef.current = String(d.countryCode || "").trim().toUpperCase();
              })
              .catch(() => {
                /* нет сети/политика — подпись просто не покажется */
              });
          } catch {
            // ignore
          }
        },
        () => { /* отказ/ошибка — остаёмся на fallback-обзоре */ },
        { enableHighAccuracy: false, timeout: 6000, maximumAge: 600000 },
      );
    } catch {
      // ignore
    }
    return () => { cancelled = true; };
  }, []);

  // Зум +/− из плеера (Босс 2026-05-29 «зум скачки убрать — при каждом нажатии
  // плавно изменяется размер»). Меняем ТОЛЬКО целевую высоту; круиз сам плавно
  // едет к ней каждый кадр (без скачков, без pointOfView-перехода/паузы режиссёра).
  useEffect(() => {
    const onZoom = (e: Event) => {
      const g = globeRef.current;
      if (!g?.pointOfView) return;
      try {
        const dir = ((e as CustomEvent).detail?.dir as number) || 0;
        const cur = zoomTargetRef.current ?? (g.pointOfView()?.altitude ?? 2.5);
        zoomTargetRef.current = Math.max(1.3, Math.min(4.5, cur + dir * 0.4));
        holdRef.current = false; // зум — смена позиции юзером → снимаем удержание
      } catch {
        // ignore
      }
    };
    window.addEventListener("muza:globe-zoom", onZoom as EventListener);
    return () => window.removeEventListener("muza:globe-zoom", onZoom as EventListener);
  }, []);

  // Переключение режима полёта из плеера (кнопки «Полёт» / «Полёт Ai»).
  useEffect(() => {
    const onFlight = (e: Event) => {
      const m = (e as CustomEvent).detail?.mode;
      if (m === "classic" || m === "ai") {
        flightModeRef.current = m;
        holdRef.current = false; // новый вход в режим снимает удержание
      }
    };
    window.addEventListener("muza:globe-flight", onFlight as EventListener);
    return () => window.removeEventListener("muza:globe-flight", onFlight as EventListener);
  }, []);

  // ── Камера-режиссёр (Босс 2026-05-29, «сделай на 100% правильно»). ЕДИНЫЙ rAF
  // владеет камерой и каждый кадр пишет pointOfView(..., 0) (мгновенно). Почему так:
  //   • НЕТ библиотечного autoRotate и НЕТ инерции (enableDamping=false) → планета
  //     не может «раскрутиться как мяч».
  //   • Долгота движется ТОЛЬКО в естественную сторону вращения Земли (на восток =
  //     убывание долготы камеры) → нет хода «против вращения» и резкой раскрутки.
  //   • Геолокация читается ЖИВО (userLatLngRef) внутри цикла → когда координаты
  //     приходят с задержкой, цель плавно уточняется, без рестарта эффекта/гонок
  //     таймеров (старый баг: смена userLatLng пересоздавала эффект и сбрасывала полёт).
  // Фазы: sunrise (медленное вращение + восход) → fly (плавный пролёт к юзеру,
  // «от 1 до последнего кадра») → cruise (мягкое непрерывное вращение). При прилёте —
  // подмигивание Морзе. reduced-motion → сразу на цель без движения.
  useEffect(() => {
    if (!ready || introDoneRef.current) return;
    const g = globeRef.current;
    if (!g?.pointOfView) return;
    introDoneRef.current = true;

    const fallbackTarget = (): { lat: number; lng: number } => {
      const top = basePointsRef.current
        .slice()
        .sort((a, b) => (b.weight || 0) - (a.weight || 0))[0];
      return top ? { lat: top.lat, lng: top.lng } : { lat: 50, lng: 30 };
    };

    if (prefersReducedMotion()) {
      const t = userLatLngRef.current || fallbackTarget();
      try {
        g.pointOfView({ lat: t.lat, lng: t.lng, altitude: CRUISE_ALTITUDE }, 0);
      } catch {
        // ignore
      }
      return;
    }

    // Первый кадр (Босс 2026-05-29): Тихий океан и Россия (центр ~150°E, сев. широты).
    // Ставим мгновенно, пока канвас прозрачный (opacity 0→1) → плавно с 1-го кадра.
    const startLng = 150; // Тихий океан + Дальний Восток России в кадре
    const startLat = 45;  // показываем Россию
    try {
      g.pointOfView({ lat: startLat, lng: startLng, altitude: OVERVIEW_ALTITUDE }, 0);
    } catch {
      // ignore
    }

    const t0 = performance.now();
    let phase: "sunrise" | "fly" | "hold" | "depart" | "cruise" = "sunrise";
    let flyStartAt = 0;
    const arrive = { lat: startLat };
    let holdAt = 0;
    let departAt = 0;
    const cruise: { lat: number; alt: number; lng: number } = { lat: startLat, alt: CRUISE_ALTITUDE, lng: startLng };
    let cruiseStartT = 0; // старт круиза — для «1 круг, далее по параллелям»
    // Сценарий Полёт Ai (Босс 2026-05-29 «1 сценой → подлёт → пролёт+флаг → возврат → ×2 → параллели»):
    // pano (2с, Солнце+Луна+Земля в кадре) → подлёт к юзеру → пролёт+флаг 3с → возврат на pano
    // → ×2 цикла → облёт по параллелям сверху-вниз (|lat|≤50, без полюсов). Долгота всегда у
    // userLng — страна юзера видна в кадре всегда (правило «земля крутится в позиции где видно страну»).
    // Сценарий Полёт Ai (Босс 2026-05-30, уточнённый):
    // 1) При открытии глобуса — ОРБИТАЛЬНЫЙ Pano-hold (страна юзера + Солнце справа
    //    best-effort + Луна), Солнце ЗАФИКСИРОВАНО на момент сессии (не дрейфует).
    // 2) Через 3 МИН бездействия → сценарий: pano 2с → подлёт 9с (ЕДИНСТВЕННЫЙ descent
    //    к юзеру) → пролёт на ЗАПАД 5с (флаг) → возврат 3.5с. Цикл ×2.
    // 3) 3-й круг — панорамный east→west над ЭКВАТОРОМ, БЕЗ снижения, континенты сами
    //    в кадре по порядку расположения; зациклено.
    // 4) User rotate (с движением) → rebase + сброс 3-мин таймера. Все переходы плавные.
    let aiSubPhase: "" | "idle" | "cycle_pano" | "fly" | "pass" | "return" | "continents" = "";
    let aiPhaseStartT = 0;
    let aiCyclesDone = 0;        // сколько сценарных циклов завершено (target 2 → continents)
    let aiResumeAt = 0;          // когда сценарий запустится / возобновится (idle → cycle_pano)
    let aiSunLngLocked = 0;      // субсолярная долгота на момент сессии (Sun-right best-effort)
    let aiPanoLng = 0;           // вычисленная Pano lng (user + sun компромисс)
    let aiPanoLat = 0;           // Pano lat (средняя sun/moon, clamp ±45)
    let aiInitDone = false;      // первый кадр AI: lock Sun + compute Pano
    let lastFlightMode: "classic" | "ai" = flightModeRef.current;
    // Босс 2026-05-30: плавность ВСЕХ переходов. Сохраняем lng/lat входа в continents,
    // чтобы первые 2.5с делать easeInOutCubic переход к новой траектории, без рывка.
    let aiContStartLng = 0;
    let aiContStartLat = 0;
    let aiContInitDone = false;
    const sessionSeed = Math.floor(Math.random() * 997); // «каждый раз по-новому» (многовариантность с 3-го круга)
    // Повтор моргания на КАЖДОМ проходе геолокации (Босс 2026-05-29) — без смены
    // фокуса камеры: при входе точки во фронт перезапускаем Морзе с начала.
    let winkWasFront = false;
    let morseRestart: () => void = () => {};
    let flagShownAt = -1e9; // момент входа точки во фронт — флаг виден 3 сек
    // ЕДИНЫЙ дрейф долготы (Босс 2026-05-29 «с 1-го кадра плавно ВСЕГДА двигается и
    // только в ОДНУ сторону»): lng = driftBaseLng + GLOBAL_DRIFT·(now−driftBaseT).
    // Знак «+»: камера дрейфует на восток → неподвижное Солнце идёт по экрану
    // СПРАВА НАЛЕВО = с востока на запад (Босс 2026-05-29, как реальное небо).
    // Постоянная скорость, одна сторона. Фазы меняют ТОЛЬКО широту и высоту.
    let driftBaseLng = startLng;
    let driftBaseT = t0;
    let raf = 0;
    let last = 0;

    // Rebase после ручного вращения/зума (OrbitControls 'end'): продолжаем дрейф с
    // текущей точки (без сброса), сохраняем широту и высоту (высота → цель зума).
    rebaseCruiseRef.current = () => {
      try {
        const pov = globeRef.current?.pointOfView?.();
        if (pov) {
          driftBaseLng = pov.lng;
          driftBaseT = performance.now();
          cruise.lat = pov.lat;
          cruise.alt = pov.altitude;
          zoomTargetRef.current = pov.altitude;
        }
      } catch {
        // ignore
      }
    };

    // Драйвер Морзе: мигает morseWordRef (приветствие у точки → прощание на отъезде),
    // зацикливается, выставляет morseOnRef для DOM-точки. Стоп при winkActiveRef=false.
    const startMorse = () => {
      let mi = 0;
      let mseq = morseTimeline(morseWordRef.current);
      morseRestart = () => { mi = 0; mseq = morseTimeline(morseWordRef.current); };
      const stepMorse = () => {
        if (!winkActiveRef.current) {
          morseOnRef.current = false;
          return;
        }
        if (mi >= mseq.length) {
          mi = 0;
          mseq = morseTimeline(morseWordRef.current); // подхватывает смену слова
          morseOnRef.current = false;
          morseTimerRef.current = window.setTimeout(stepMorse, 650);
          return;
        }
        const s = mseq[mi++];
        morseOnRef.current = s.on;
        morseTimerRef.current = window.setTimeout(stepMorse, s.ms);
      };
      stepMorse();
    };

    // Якорим светящуюся точку в координате геолокации (проекция в экран каждый кадр).
    // По мере отъезда (рост altitude) точка пропорционально уменьшается. На обратной
    // стороне глобуса — скрыта. Прямое изменение стиля DOM (без перерендера React).
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const updateWinkDot = (gg: any) => {
      const dot = winkDotRef.current;
      const cityEl = winkCityRef.current;
      const flagEl = winkFlagRef.current;
      const hide = () => {
        if (dot) dot.style.opacity = "0";
        if (cityEl) cityEl.style.opacity = "0";
        if (flagEl) flagEl.style.opacity = "0";
      };
      if (!dot) return;
      const anchor = winkAnchorRef.current;
      if (!winkActiveRef.current || !anchor) {
        hide();
        return;
      }
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      let pov: any = null;
      try {
        pov = gg.pointOfView?.();
      } catch {
        pov = null;
      }
      if (!pov) {
        hide();
        return;
      }
      // Видна ТОЛЬКО снаружи планеты, НЕ сквозь неё (Босс 2026-05-29). Корректная
      // проверка перекрытия диском: точка видна, если её нормаль направлена к камере
      // дальше лимба → dot(нормаль_точки, нормаль_камеры) > R/dist = cos(угла лимба).
      let front = false;
      try {
        const cam = gg.camera?.();
        const pc = gg.getCoords?.(anchor.lat, anchor.lng, 0); // точка на поверхности (мир)
        if (cam?.position && pc) {
          const cp = cam.position;
          const pl = Math.hypot(pc.x, pc.y, pc.z) || 1;
          const cl = Math.hypot(cp.x, cp.y, cp.z) || 1;
          const nDotC = (pc.x * cp.x + pc.y * cp.y + pc.z * cp.z) / (pl * cl);
          front = nDotC > 100 / cl; // перед лимбом → видно снаружи планеты
        }
      } catch {
        front = false;
      }
      // Новый проход (точка вошла во фронт) → перезапуск моргания + показ флага 3 сек.
      if (front && !winkWasFront) { morseRestart(); flagShownAt = performance.now(); }
      winkWasFront = front;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      let sc: any = null;
      try {
        sc = gg.getScreenCoords?.(anchor.lat, anchor.lng, 0.02);
      } catch {
        sc = null;
      }
      if (!front || !sc) {
        hide();
        return;
      }
      const scale = Math.max(0.3, Math.min(1.1, ARRIVE_ALTITUDE / (pov.altitude || ARRIVE_ALTITUDE)));
      dot.style.left = `${sc.x}px`;
      dot.style.top = `${sc.y}px`;
      dot.style.transform = `translate(-50%, -50%) scale(${scale})`;
      dot.style.opacity = morseOnRef.current ? "1" : "0.07";
      dot.style.boxShadow = morseOnRef.current
        ? "0 0 16px 5px rgba(124,58,237,0.92), 0 0 30px 10px rgba(0,212,255,0.55)"
        : "none";
      // Подпись города (англ.) под точкой — ровная (не мигает), читаемая. Уходит
      // вместе с окончанием Морзе (winkActiveRef=false → hide() выше). Босс 2026-05-29.
      if (cityEl) {
        const city = cityNameRef.current;
        if (!city) {
          cityEl.style.opacity = "0";
        } else {
          if (cityEl.textContent !== city) cityEl.textContent = city;
          cityEl.style.left = `${sc.x}px`;
          cityEl.style.top = `${sc.y + 7}px`; // строго рядом с Морзе-точкой (Босс 2026-05-29)
          cityEl.style.opacity = "0.95";
        }
      }
      // Флаг страны (эмодзи) над точкой — виден 3 сек при входе во фронт (Босс 2026-05-29:
      // флаг нужен, код не нужен). isoToFlag → regional-indicator эмодзи.
      if (flagEl) {
        const flag = isoToFlag(countryCodeRef.current);
        const show = !!flag && performance.now() - flagShownAt < 3000;
        if (!show) {
          flagEl.style.opacity = "0";
        } else {
          if (flagEl.textContent !== flag) flagEl.textContent = flag;
          flagEl.style.left = `${sc.x}px`;
          flagEl.style.top = `${sc.y - 22}px`;
          flagEl.style.opacity = "1";
        }
      }
    };

    // Экранные позиции планет + видимость (не за Землёй) — для hover-подписи.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const updatePlanetScreens = (gg: any) => {
      const arr = planetScreenRef.current;
      arr.length = 0;
      if (!planetsRef.current.length || !gg?.getScreenCoords) return;
      let camPos: { x: number; y: number; z: number } | null = null;
      let cl = 1;
      try {
        const cam = gg.camera?.();
        const pos = cam?.position;
        if (pos) {
          camPos = { x: pos.x, y: pos.y, z: pos.z };
          cl = Math.hypot(pos.x, pos.y, pos.z) || 1;
        }
      } catch {
        camPos = null;
      }
      const palt = PLANET_WORLD_RADIUS / 100 - 1;
      const cosAlpha = camPos ? Math.sqrt(Math.max(0, 1 - (100 / cl) * (100 / cl))) : 1;
      const now = Date.now();
      for (const p of planetsRef.current) {
        const pp = subPlanetPoint(p.key, now);
        let visible = true;
        try {
          const c0 = camPos;
          if (c0) {
            const pc = gg.getCoords?.(pp[1], pp[0], palt);
            if (pc) {
              const dpx = pc.x - c0.x, dpy = pc.y - c0.y, dpz = pc.z - c0.z;
              const dpl = Math.hypot(dpx, dpy, dpz) || 1;
              // Угол между «камера→центр Земли» и «камера→планета»: внутри диска Земли = скрыта.
              const dotv = (-c0.x * dpx - c0.y * dpy - c0.z * dpz) / (cl * dpl);
              if (dotv > cosAlpha) visible = false;
            }
          }
        } catch {
          visible = true;
        }
        let sc: { x: number; y: number } | null = null;
        try {
          sc = gg.getScreenCoords?.(pp[1], pp[0], palt);
        } catch {
          sc = null;
        }
        if (sc) {
          const style = PLANET_STYLE[p.key];
          arr.push({ key: p.key, x: sc.x, y: sc.y, r: Math.max(16, (style?.size ?? 30) * 0.6), visible });
        }
      }
    };

    const loop = (now: number) => {
      raf = requestAnimationFrame(loop);
      if (now - last < 33) return; // ~30fps — мягко и легко
      last = now;
      const gg = globeRef.current;
      if (!gg?.pointOfView) return;
      // Точка геолокации якорится каждый кадр (в т.ч. во время ручного вращения).
      updateWinkDot(gg);
      updatePlanetScreens(gg);
      // Во время самого жеста — камеру ведёт OrbitControls (юзер steering'ует).
      if (userInteractingRef.current) return;
      // Удержание по двойному тапу — камера стоит на месте до смены режима/позиции.
      if (holdRef.current) return;
      const elapsed = now - t0;
      // ЕДИНЫЙ дрейф долготы — одна сторона, постоянная скорость, с 1-го кадра.
      // (classic-режим переопределяет lng, наводя камеру на середину Солнце–Луна.)
      let lng = driftBaseLng + (GLOBAL_DRIFT_DEG_S * (now - driftBaseT)) / 1000;
      let lat = startLat;
      let alt = OVERVIEW_ALTITUDE;

      // Босс 2026-05-30: в режиме «Полёт» (classic) сценарий начинается с Pano сразу —
      // intro (sunrise→fly→hold→depart) пропускаем. «Полёт Ai» intro оставляем.
      if (flightModeRef.current === "classic" && phase !== "cruise") {
        phase = "cruise";
      }

      if (phase === "sunrise") {
        lat = startLat;
        alt = OVERVIEW_ALTITUDE;
        if (elapsed >= SUNRISE_HOLD_MS) {
          // Активируем точку+город+Морзе уже НА ПОДЛЁТЕ (Босс 2026-05-29: подпись
          // города при приближении и до прохода над страной; точка моргает в течении
          // прохода над страной). winkActiveRef больше НЕ гасим — точка моргает на
          // каждом проходе (updateWinkDot прячет её, когда страна на обратной стороне).
          const t1 = userLatLngRef.current || fallbackTarget();
          arrive.lat = t1.lat;
          winkAnchorRef.current = { lat: t1.lat, lng: t1.lng };
          winkActiveRef.current = true;
          morseWordRef.current = "MUZA";
          startMorse();
          flyStartAt = now;
          phase = "fly";
        }
      } else if (phase === "fly") {
        // Приближение к геолокации: меняем ТОЛЬКО широту и высоту (долгота — общий дрейф).
        const p = Math.min(1, (now - flyStartAt) / FLY_MS);
        const e = easeInOutCubic(p);
        const target = userLatLngRef.current || fallbackTarget();
        lat = startLat + (target.lat - startLat) * e;
        alt = OVERVIEW_ALTITUDE + (ARRIVE_ALTITUDE - OVERVIEW_ALTITUDE) * e;
        if (p >= 1) {
          const t2 = userLatLngRef.current || fallbackTarget();
          arrive.lat = t2.lat;
          winkAnchorRef.current = { lat: t2.lat, lng: t2.lng }; // уточняем (геолокация могла прийти позже)
          holdAt = now;
          phase = "hold";
        }
      } else if (phase === "hold") {
        lat = arrive.lat;
        alt = ARRIVE_ALTITUDE;
        if (now - holdAt >= ARRIVE_HOLD_MS) {
          departAt = now;
          phase = "depart";
        }
      } else if (phase === "depart") {
        // Панорамный отъезд: высота ARRIVE→CRUISE (точка пропорционально уменьшается).
        const p = Math.min(1, (now - departAt) / DEPART_MS);
        const e = easeInOutCubic(p);
        lat = arrive.lat;
        alt = ARRIVE_ALTITUDE + (CRUISE_ALTITUDE - ARRIVE_ALTITUDE) * e;
        if (p >= 1) {
          cruise.lat = arrive.lat;
          cruise.alt = CRUISE_ALTITUDE;
          cruiseStartT = now;
          if (zoomTargetRef.current == null) zoomTargetRef.current = CRUISE_ALTITUDE;
          phase = "cruise"; // точка остаётся моргающей при каждом проходе над страной
        }
      } else if (flightModeRef.current === "ai") {
        // ПОЛЁТ Ai (Босс 2026-05-30 «Это режим Полёта»): sun-moon framing —
        // плавный обзор Земли так, чтобы Солнце И Луна были в кадре (~50% времени).
        // Основной сценарий-режиссёр теперь у режима «Полёт» (classic) ниже.
        // кадре не менее 50% времени. Камера наводится на СЕРЕДИНУ между подсолнечной и
        // подлунной точками (по широте и долготе), с лёгким качанием для «полёта».
        const nowT = Date.now();
        let sLat = 0, sLng = 0, mLat = 0, mLng = 0;
        try { const s = subsolarPoint(nowT); sLng = s[0]; sLat = s[1]; } catch { /* no-op */ }
        try { const m = subLunarPoint(nowT); mLng = m[0]; mLat = m[1]; } catch { /* no-op */ }
        const midLat = (sLat + mLat) / 2;
        const dL = ((mLng - sLng + 540) % 360) - 180; // кратчайшая дуга Солнце→Луна
        const midLng = sLng + dL / 2; // середина по долготе
        cruise.lat += (Math.max(-46, Math.min(46, midLat)) - cruise.lat) * 0.02;
        lat = Math.max(-52, Math.min(52, cruise.lat));
        // Долгота — у середины Солнце/Луна + медленное качание ±14° (оба светила в кадре).
        const sweep = 14 * Math.sin(((now - cruiseStartT) / 1000) * 0.06);
        lng = midLng + sweep;
        // Отъезд назад, чтобы оба светила (на радиусах 250–320) поместились в кадр.
        const tgt = Math.max(zoomTargetRef.current ?? CRUISE_ALTITUDE, 3.6);
        cruise.alt += (tgt - cruise.alt) * 0.04;
        alt = cruise.alt;
      } else {
        // «ПОЛЁТ» (classic) — финальный сценарий (Босс 2026-05-30 «Это режим Полёта»):
        // Init: Sun-позиция фиксируется на момент сессии. Pano lng = компромисс,
        // чтобы страна юзера ВСЕГДА была в кадре + Sun-right best-effort.
        // Сценарий: cycle_pano 2с → подлёт 9с (ЕДИНСТВЕННЫЙ descent) → пролёт на
        // ЗАПАД 5с (флаг) → возврат 3.5с → ×2 → continents (east→west, выгодный
        // ракурс ближайшего континента, без снижения, зацикленно).
        // User-rotate с движением → 3 мин пауза, потом возобновление с cycle_pano.
        if (flightModeRef.current !== lastFlightMode) {
          aiInitDone = false;
          aiResumeAtRef.current = 0;
          aiSubPhase = "";
          aiCyclesDone = 0;
          aiContInitDone = false;
          lastFlightMode = flightModeRef.current;
        }
        if (!aiInitDone) {
          // Lock Sun + compute Pano (один раз за вход в AI-режим).
          try { aiSunLngLocked = subsolarPoint(Date.now())[0]; } catch { /* no-op */ }
          let sunLatI = 0, moonLatI = 0;
          try { sunLatI = subsolarPoint(Date.now())[1]; } catch { /* no-op */ }
          try { moonLatI = subLunarPoint(Date.now())[1]; } catch { /* no-op */ }
          aiPanoLat = Math.max(-45, Math.min(45, (sunLatI + moonLatI) / 2));
          const u0 = userLatLngRef.current || fallbackTarget();
          const sd = ((aiSunLngLocked - u0.lng + 540) % 360) - 180; // signed shortest arc
          // Если Солнце на дальней стороне (юзер в глубокой ночи) — приоритет страна юзера.
          if (Math.abs(sd) > 130) {
            aiPanoLng = u0.lng - 30; // страна слегка справа, Солнце где есть
          } else {
            aiPanoLng = u0.lng + sd * 0.4; // 40% пути от юзера к Солнцу — оба в кадре
          }
          // Босс 2026-05-30 «движения плавные, никаких резких разворотов»:
          // НЕ зануляем cruise мгновенно — cycle_pano плавно подтянет cruise→Pano.
          // Это убирает «прыжок» камеры при первом входе в режим.
          if (!Number.isFinite(cruise.lat) || cruise.lat === 0) cruise.lat = aiPanoLat;
          if (!Number.isFinite(cruise.lng) || cruise.lng === 0) cruise.lng = aiPanoLng;
          if (!Number.isFinite(cruise.alt) || cruise.alt === 0) cruise.alt = OVERVIEW_ALTITUDE;
          aiSubPhase = "cycle_pano";
          aiPhaseStartT = now;
          aiCyclesDone = 0;
          aiContInitDone = false;
          aiInitDone = true;
        }
        const user = userLatLngRef.current || fallbackTarget();
        const panoAlt = OVERVIEW_ALTITUDE;

        if (now < aiResumeAtRef.current) {
          // Пауза после user-rotate: драфт от его ракурса (cruise после rebase).
          // lng идёт по default-формуле (east-drift = Sun справа→налево); lat/alt из cruise.
          lat = cruise.lat;
          alt = cruise.alt;
          // lng остаётся = driftBaseLng + drift*t (вычислено в начале loop).
          // Сценарий сбрасывается — после паузы стартует с cycle_pano с начала.
          aiSubPhase = "";
        } else {
          if (aiSubPhase === "") {
            // Возобновление после паузы / fresh start.
            aiSubPhase = "cycle_pano";
            aiPhaseStartT = now;
            aiCyclesDone = 0;
          }
          const phaseT = now - aiPhaseStartT;
          if (aiSubPhase === "cycle_pano") {
            // 2с Pano: смягчённый снеп к Pano (eases для плавности после паузы).
            cruise.lat += (aiPanoLat - cruise.lat) * 0.08;
            const dLp = ((aiPanoLng - cruise.lng + 540) % 360) - 180;
            cruise.lng += dLp * 0.08;
            cruise.alt += (panoAlt - cruise.alt) * 0.08;
            lat = cruise.lat;
            lng = cruise.lng;
            alt = cruise.alt;
            if (phaseT >= 2000) { aiSubPhase = "fly"; aiPhaseStartT = now; }
          } else if (aiSubPhase === "fly") {
            // 9с подлёт к юзеру (единственный descent).
            const p = Math.min(1, phaseT / FLY_MS);
            const e = easeInOutCubic(p);
            lat = aiPanoLat + (user.lat - aiPanoLat) * e;
            const dL = ((user.lng - aiPanoLng + 540) % 360) - 180;
            lng = aiPanoLng + dL * e;
            alt = panoAlt + (ARRIVE_ALTITUDE - panoAlt) * e;
            cruise.lat = lat; cruise.lng = lng; cruise.alt = alt;
            if (p >= 1) {
              aiSubPhase = "pass";
              aiPhaseStartT = now;
              winkAnchorRef.current = { lat: user.lat, lng: user.lng };
              winkActiveRef.current = true;
              flagShownAt = now;
              morseWordRef.current = "MUZA";
            }
          } else if (aiSubPhase === "pass") {
            // 5с пролёт на ЗАПАД через страну (lng убывает), флаг виден всё время.
            const p = Math.min(1, phaseT / 5000);
            const e = easeInOutCubic(p);
            lat = user.lat;
            lng = user.lng - 30 * e; // -30° запад от точки юзера за 5с
            alt = ARRIVE_ALTITUDE;
            cruise.lat = lat; cruise.lng = lng; cruise.alt = alt;
            if (p >= 1) { aiSubPhase = "return"; aiPhaseStartT = now; }
          } else if (aiSubPhase === "return") {
            // 3.5с отъезд от точки юзера к Pano.
            const passEndLng = user.lng - 30;
            const p = Math.min(1, phaseT / 3500);
            const e = easeInOutCubic(p);
            lat = user.lat + (aiPanoLat - user.lat) * e;
            const dL = ((aiPanoLng - passEndLng + 540) % 360) - 180;
            lng = passEndLng + dL * e;
            alt = ARRIVE_ALTITUDE + (panoAlt - ARRIVE_ALTITUDE) * e;
            cruise.lat = lat; cruise.lng = lng; cruise.alt = alt;
            if (p >= 1) {
              aiCyclesDone += 1;
              if (aiCyclesDone >= 2) {
                aiSubPhase = "continents";
                aiPhaseStartT = now;
                aiContInitDone = false;
              } else {
                aiSubPhase = "cycle_pano";
                aiPhaseStartT = now;
              }
            }
          } else if (aiSubPhase === "continents") {
            // Панорамный east→west облёт. Одна скорость ~3°/сек west. Lat плавно
            // наводится на ближайший континент (выгодный ракурс «по ходу пролёта»).
            // Босс 2026-05-30 «никаких резких разворотов»: первые 2.5с — плавный
            // easeInOutCubic переход от точки входа (cruise.lng) к live-формуле
            // (user.lng - 3*tt). Без этого был мгновенный jump panoLng→user.lng.
            const tt = (now - aiPhaseStartT) / 1000;
            if (!aiContInitDone) {
              aiContStartLng = cruise.lng;
              aiContStartLat = cruise.lat;
              aiContInitDone = true;
            }
            const liveLng = user.lng - 3 * tt;
            const dLc = ((liveLng - aiContStartLng + 540) % 360) - 180;
            const blendP = Math.min(1, tt / 2.5);
            const blendE = easeInOutCubic(blendP);
            lng = aiContStartLng + dLc * blendE;
            const targetLat = continentLatAtLng(lng);
            cruise.lat += (targetLat - cruise.lat) * 0.02;
            cruise.lng = lng;
            cruise.alt += (panoAlt - cruise.alt) * 0.03;
            lat = cruise.lat;
            alt = cruise.alt;
            // Подавляем `aiContStartLat` неиспользование без логики, оставляем
            // на случай будущего lat-blend (сейчас lat и так плавно тянется через 0.02).
            void aiContStartLat;
          }
        }
      }

      try {
        gg.pointOfView({ lat, lng, altitude: alt }, 0);
      } catch {
        // ignore
      }
    };
    raf = requestAnimationFrame(loop);

    return () => {
      cancelAnimationFrame(raf);
      if (morseTimerRef.current !== null) window.clearTimeout(morseTimerRef.current);
      winkActiveRef.current = false;
      morseOnRef.current = false;
      rebaseCruiseRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready]);

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

  // Hover-подпись планеты (Босс 2026-05-29 «при наведении на планету показывай название»).
  useEffect(() => {
    const el = wrapRef.current;
    const label = planetLabelRef.current;
    if (!el || !label) return;
    const onMove = (e: PointerEvent) => {
      const rect = el.getBoundingClientRect();
      const px = e.clientX - rect.left;
      const py = e.clientY - rect.top;
      let best: { key: string; x: number; y: number } | null = null;
      let bestD = Infinity;
      for (const p of planetScreenRef.current) {
        if (!p.visible) continue;
        const d = Math.hypot(px - p.x, py - p.y);
        if (d <= p.r && d < bestD) {
          bestD = d;
          best = { key: p.key, x: p.x, y: p.y };
        }
      }
      if (best) {
        const name = PLANET_NAMES[best.key] || best.key;
        if (label.textContent !== name) label.textContent = name;
        label.style.left = `${best.x}px`;
        label.style.top = `${best.y - 16}px`;
        label.style.opacity = "1";
      } else {
        label.style.opacity = "0";
      }
    };
    const onLeave = () => {
      label.style.opacity = "0";
    };
    el.addEventListener("pointermove", onMove);
    el.addEventListener("pointerleave", onLeave);
    return () => {
      el.removeEventListener("pointermove", onMove);
      el.removeEventListener("pointerleave", onLeave);
    };
  }, []);

  // Двойной тап по планете → удержание камеры (Босс 2026-05-29). Чистый двойной тап
  // (без сдвига) ставит holdRef=true; перетаскивание/зум/смена режима его снимают.
  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    let downX = 0, downY = 0, downT = 0, moved = false;
    let lastTapT = 0, lastTapX = 0, lastTapY = 0;
    const onDown = (e: PointerEvent) => {
      downX = e.clientX; downY = e.clientY; downT = performance.now(); moved = false;
    };
    const onMove = (e: PointerEvent) => {
      if (Math.hypot(e.clientX - downX, e.clientY - downY) > 10) moved = true;
    };
    const onUp = (e: PointerEvent) => {
      const dur = performance.now() - downT;
      const dist = Math.hypot(e.clientX - downX, e.clientY - downY);
      if (moved || dist > 10 || dur > 300) { lastTapT = 0; return; } // это не чистый тап
      const t = performance.now();
      if (t - lastTapT <= 350 && Math.hypot(e.clientX - lastTapX, e.clientY - lastTapY) <= 30) {
        holdRef.current = true; // двойной тап → держим текущую позицию
        lastTapT = 0;
      } else {
        lastTapT = t; lastTapX = e.clientX; lastTapY = e.clientY;
      }
    };
    el.addEventListener("pointerdown", onDown);
    el.addEventListener("pointermove", onMove);
    el.addEventListener("pointerup", onUp);
    return () => {
      el.removeEventListener("pointerdown", onDown);
      el.removeEventListener("pointermove", onMove);
      el.removeEventListener("pointerup", onUp);
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

      // АСТРОНОМИЧЕСКИЙ блик Солнца (Босс 2026-05-29: всё астрономически — Солнце/Луна
      // Анимация Солнца (Босс 2026-05-30): плазма тело + огненная корона —
      // обновляем uTime каждый кадр, шейдеры сами «играют» (гранулы движутся,
      // языки пламени мерцают). depthTest сферы корректно перекрывает Землёй.
      try {
        const t = now * 0.001;
        if (sunMatRef.current?.uniforms?.uTime) sunMatRef.current.uniforms.uTime.value = t;
        if (sunCoronaMatRef.current?.uniforms?.uTime) sunCoronaMatRef.current.uniforms.uTime.value = t;
        // uTime для day-night шейдера — медленная анимация «нитей света» на дневной стороне.
        if (dayNight?.uniforms?.uTime) dayNight.uniforms.uTime.value = t;
        // Билборд короны: ориентируем mesh лицом к камере — лучи всегда радиальны
        // от диска Солнца с любого ракурса (как сцена с фото протуберанцев).
        const corona = sunCoronaMeshRef.current;
        const camera = g.camera?.();
        if (corona && camera) corona.quaternion.copy(camera.quaternion);
        // ──────────────────────────────────────────────────────────────────────
        // Босс 2026-05-30: «когда солнце задевает край земли — плавно увеличить
        // яркость и длину лучей. Рассвет/закат самое грандиозное действие».
        // + «3д» направленный flare: когда Sun «задевает» Землю с т.зр. камеры,
        // лучи В НАПРАВЛЕНИИ ВИДИМОЙ части кадра — вспышка, нарастает к моменту
        // полу-окклюзии (центр Sun под лимбом), потом затихает. Симметрично при
        // выходе Sun из-за Земли.
        // ──────────────────────────────────────────────────────────────────────
        let sunsetTarget = 0;
        let flareTarget = 0;
        let flareDirX = 1, flareDirY = 0;
        if (camera && sunMeshRef.current) {
          const camP = camera.position;
          const sunP = sunMeshRef.current.position;
          const dEarth = Math.hypot(camP.x, camP.y, camP.z);
          const dSun = Math.hypot(camP.x - sunP.x, camP.y - sunP.y, camP.z - sunP.z);
          if (dEarth > 100.5 && dSun > 1) {
            // Угол между (cam→Earth) и (cam→Sun).
            const ex = -camP.x, ey = -camP.y, ez = -camP.z;
            const sx = sunP.x - camP.x, sy = sunP.y - camP.y, sz = sunP.z - camP.z;
            const cosAng = (ex * sx + ey * sy + ez * sz) / (dEarth * dSun);
            const ang = Math.acos(Math.max(-1, Math.min(1, cosAng)));
            // Угловой радиус Земли с точки зрения камеры (R=100).
            const angR = Math.asin(Math.min(1, 100 / dEarth));
            // delta = ang - angR (signed): >0 Sun вне диска Земли, <0 Sun за ним.
            const delta = ang - angR;
            // Sunset boost: пик на лимбе (|delta|=0), затухает за angR*0.35.
            const sunsetBand = angR * 0.35;
            sunsetTarget = Math.max(0, 1 - Math.abs(delta) / sunsetBand);
            // FLARE (Босс 2026-05-30): пик при полу-окклюзии (delta ≈ -flareBand/2).
            // Растёт от delta=0 (лимб) к delta=-flareBand/2 (центр Sun под лимбом),
            // потом затухает к delta=-flareBand (полное скрытие). Симметрично:
            // окно [-flareBand, +flareBand*0.2] чтобы flare начинался слегка ДО касания
            // и пик был именно когда центр Sun уже под лимбом.
            const flareBand = angR * 0.6;
            const center = -flareBand * 0.5; // delta при пике
            const dist = Math.abs(delta - center);
            flareTarget = Math.max(0, 1 - dist / (flareBand * 0.6));
            // Направление flare в screen-space (camera right/up axes).
            // Earth — в начале координат; Sun — в sunP. Проецируем оба на плоскость
            // камеры (компоненты вдоль camera.right и camera.up).
            try {
              const camRight = new THREE.Vector3(1, 0, 0).applyQuaternion(camera.quaternion);
              const camUp    = new THREE.Vector3(0, 1, 0).applyQuaternion(camera.quaternion);
              // sun-вектор относительно камеры:
              const vRX = sunP.x * camRight.x + sunP.y * camRight.y + sunP.z * camRight.z;
              const vUY = sunP.x * camUp.x    + sunP.y * camUp.y    + sunP.z * camUp.z;
              // earth-вектор относительно камеры (origin -> earth):
              const eRX = 0; // earth at origin → projections тоже 0 для камера-relative direction.
              const eUY = 0;
              const dRX = vRX - eRX;
              const dUY = vUY - eUY;
              const dL = Math.hypot(dRX, dUY);
              if (dL > 1e-6) {
                flareDirX = dRX / dL;
                flareDirY = dUY / dL;
              }
            } catch {
              // fallback: keep last direction
            }
          }
        }
        // Плавный exponential lerp.
        sunsetBoostRef.current += (sunsetTarget - sunsetBoostRef.current) * 0.08;
        flareIntensityRef.current += (flareTarget - flareIntensityRef.current) * 0.10;
        // Направление flare — плавно вращаем к target (slerp по 2D углу).
        const curX = flareDirRef.current.x;
        const curY = flareDirRef.current.y;
        const lerpK = 0.12;
        flareDirRef.current.x = curX + (flareDirX - curX) * lerpK;
        flareDirRef.current.y = curY + (flareDirY - curY) * lerpK;
        const nLen = Math.hypot(flareDirRef.current.x, flareDirRef.current.y);
        if (nLen > 1e-6) {
          flareDirRef.current.x /= nLen;
          flareDirRef.current.y /= nLen;
        }
        const sb = sunsetBoostRef.current;
        const fi = flareIntensityRef.current;
        if (sunCoronaMatRef.current?.uniforms?.uSunsetBoost) {
          sunCoronaMatRef.current.uniforms.uSunsetBoost.value = sb;
        }
        if (sunCoronaMatRef.current?.uniforms?.uFlareIntensity) {
          sunCoronaMatRef.current.uniforms.uFlareIntensity.value = fi;
        }
        if (sunCoronaMatRef.current?.uniforms?.uFlareDir) {
          sunCoronaMatRef.current.uniforms.uFlareDir.value.set(
            flareDirRef.current.x,
            flareDirRef.current.y,
          );
        }
        if (dayNight?.uniforms?.uWarmGlow) {
          dayNight.uniforms.uWarmGlow.value = sb;
        }
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
        // Босс 2026-05-29 «планета не раскручивается как мяч»: НЕТ авто-вращения и
        // НЕТ инерции (enableDamping=false). Камеру каждый кадр ведёт rAF-режиссёр;
        // инерция OrbitControls больше не может «раскрутить» сцену в окне ready=false.
        controls.autoRotate = false;
        controls.autoRotateSpeed = 0;
        controls.enableDamping = false;
        // Зум ПАЛЬЦАМИ (pinch) включён (Босс 2026-05-29). Колесо мыши на десктопе
        // дополнительно закрывает окно (wheel-listener), pinch на тач-экране — зумит.
        controls.enableZoom = true;
        controls.enablePan = false;
        controls.minDistance = 180;
        controls.maxDistance = 600;
        controls.rotateSpeed = 0.7;
        controls.zoomSpeed = 0.8;
        // Взаимодействие НИКОГДА не останавливает полёт (Босс 2026-05-29), только меняет
        // траекторию: во время жеста камеру ведёт OrbitControls, на 'end' — если позиция
        // реально изменилась (перетаскивание/зум) → rebase + снятие удержания. Чистый тап
        // (без сдвига) НЕ ребейзит и НЕ снимает hold — он обрабатывается двойным тапом.
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        let gestureStartPov: any = null;
        try {
          controls.addEventListener?.("start", () => {
            userInteractingRef.current = true;
            try { gestureStartPov = globeRef.current?.pointOfView?.(); } catch { gestureStartPov = null; }
          });
          controls.addEventListener?.("end", () => {
            userInteractingRef.current = false;
            let moved = true;
            try {
              const pov = globeRef.current?.pointOfView?.();
              if (pov && gestureStartPov) {
                const dLng = Math.abs(((pov.lng - gestureStartPov.lng + 540) % 360) - 180);
                moved =
                  Math.abs(pov.lat - gestureStartPov.lat) > 0.4 ||
                  dLng > 0.4 ||
                  Math.abs(pov.altitude - gestureStartPov.altitude) > 0.02;
              }
            } catch {
              moved = true;
            }
            if (moved) {
              // Юзер сменил позицию → снимаем удержание и продолжаем полёт с новой точки.
              holdRef.current = false;
              rebaseCruiseRef.current?.();
              // Босс 2026-05-30: 3-мин пауза от user-rotate — драфт от его ракурса,
              // потом сценарий возобновляется с cycle_pano.
              aiResumeAtRef.current = performance.now() + 180_000;
            }
          });
        } catch {
          // ignore
        }
      }
      // Дальняя плоскость камеры — за глубоким звёздным небом (звёзды на 150 000–330 000,
      // Босс 2026-05-29 «граница звёзд за пределы Юпитера ×100»). Иначе они отсекаются.
      try {
        const cam = g.camera?.();
        if (cam) {
          cam.far = Math.max(cam.far || 0, 500000);
          cam.updateProjectionMatrix?.();
        }
      } catch {
        // ignore
      }
      // Начальный кадр (точка восхода) выставляет камера-режиссёр синхронно при ready
      // — здесь pointOfView НЕ зовём, чтобы не было конфликтующих наводок (это и
      // давало рывок/раскрутку). Канвас прозрачен (opacity 0→1) до первого кадра.

      // Видимые Солнце и Луна — БИЛБОРД-СПРАЙТЫ (Босс 2026-05-29 «солнце не эллипсом»):
      // спрайт всегда повёрнут к камере → идеальный круг в любой точке кадра, даже
      // у самого края (3D-сфера у края проецируется в эллипс из-за перспективы).
      try {
        const scene = g.scene?.();
        if (scene && !sunMeshRef.current) {
          // Босс 2026-05-30: 3D-сфера с плазмой + анимированная огненная корона
          // (короткие переменные лучи-языки, не starburst). См. SUN_FRAGMENT / SUN_CORONA_FRAGMENT.
          const made = makeSunGroup(15); // ~15 ед. — визуально соразмерно прежнему спрайту
          if (made) {
            scene.add(made.group);
            sunMeshRef.current = made.group;
            sunMatRef.current = made.bodyMat;
            sunCoronaMatRef.current = made.coronaMat;
            sunCoronaMeshRef.current = made.corona;
          }
        }
        if (scene && !moonMeshRef.current) {
          // Луна — ШАР с фазовым шейдером (отражает Солнце, обратная в тени).
          const moonUniforms = { sunDir: { value: new THREE.Vector3(1, 0, 0) } };
          const moonMat = new THREE.ShaderMaterial({
            uniforms: moonUniforms,
            vertexShader: MOON_VERTEX,
            fragmentShader: MOON_FRAGMENT,
          });
          // Луна увеличена ×2 (Босс 2026-05-29 «увеличь Луну в 2 раза»): radius 2.5→5.0.
          const moon = new THREE.Mesh(new THREE.SphereGeometry(5.0, 32, 32), moonMat);
          scene.add(moon);
          moonMeshRef.current = moon;
          moonMatRef.current = moonMat;
        }
        // Бесконечно глубокое небо (Босс 2026-05-29). Звёзды отодвинуты ДАЛЕКО ЗА планеты
        // (Юпитер на 1500) — на ~100× (150 000+), как реальное небо «на бесконечности».
        // sizeAttenuation:false → звёзды остаются видимыми крошечными точками на любой
        // дистанции (иначе на 150к они исчезнут). Параллакс почти нулевой = фон-небосвод.
        if (scene && !deepStarsRef.current) {
          const group = new THREE.Group();
          // Слои: [радиус, количество, размер(px), яркость]. Радиусы ≫ Юпитера (1500).
          const layers: Array<[number, number, number, number]> = [
            [150000, 1600, 1.7, 0.95],
            [230000, 1300, 2.3, 0.8],
            [330000, 1000, 2.9, 0.62],
          ];
          for (const [radius, count, size, opacity] of layers) {
            const pos = new Float32Array(count * 3);
            const col = new Float32Array(count * 3);
            for (let i = 0; i < count; i++) {
              // Равномерная сфера (метод обратного косинуса).
              const u = Math.random();
              const v = Math.random();
              const theta = 2 * Math.PI * u;
              const phi = Math.acos(2 * v - 1);
              const r = radius * (0.85 + Math.random() * 0.3);
              const sx = r * Math.sin(phi) * Math.cos(theta);
              const sy = r * Math.sin(phi) * Math.sin(theta);
              const sz = r * Math.cos(phi);
              pos[i * 3] = sx;
              pos[i * 3 + 1] = sy;
              pos[i * 3 + 2] = sz;
              // Лёгкий разброс оттенка: бело-голубой / бело-тёплый.
              const warm = Math.random();
              col[i * 3] = 0.78 + warm * 0.22;
              col[i * 3 + 1] = 0.82 + warm * 0.14;
              col[i * 3 + 2] = 0.95 + (1 - warm) * 0.05;
            }
            const geo = new THREE.BufferGeometry();
            geo.setAttribute("position", new THREE.BufferAttribute(pos, 3));
            geo.setAttribute("color", new THREE.BufferAttribute(col, 3));
            const mat = new THREE.PointsMaterial({
              size,
              sizeAttenuation: false, // постоянный размер в px → видны и на 150 000+
              transparent: true,
              opacity,
              vertexColors: true,
              depthWrite: false,
              blending: THREE.AdditiveBlending,
            });
            const pts = new THREE.Points(geo, mat);
            pts.frustumCulled = false;
            group.add(pts);
          }
          scene.add(group);
          deepStarsRef.current = group;
        }
        // Планеты на дальней небесной сфере (Босс 2026-05-29: «видеть Меркурий, Венеру,
        // Марс, Юпитер, Сатурн астрономически»). Позиция — по реальной эфемериде каждую
        // минуту (positionSunMoon). depthTest=true → за Землёй планета скрыта.
        if (scene && planetsRef.current.length === 0) {
          for (const key of Object.keys(PLANET_STYLE)) {
            const st = PLANET_STYLE[key];
            const spr = makePlanetSprite(st.rgb, st.size);
            if (spr) {
              scene.add(spr);
              planetsRef.current.push({ key, mesh: spr });
            }
          }
        }
        positionSunMoon();
      } catch (e) {
        console.error("[GlobeView] sun/moon setup failed:", e);
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
      // Босс 2026-05-29: ВНУТРИ окна — звёздное небо (текстура NIGHT_SKY) + Земля.
      // Подложка прозрачная: во время загрузки текстуры проступает чёрный фон с
      // летящими звёздами (StarfieldCanvas) ЗА окном.
      style={{
        background: "transparent",
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
      {/* Светящаяся точка Морзе — закреплена в точке геолокации (позиция/масштаб/
          мигание выставляет режиссёр напрямую через ref). База 6px (в 4× меньше),
          фирменные цвета MuzaAi. По мере отъезда камеры — пропорционально меньше. */}
      <div
        ref={winkDotRef}
        className="pointer-events-none absolute z-20 rounded-full"
        style={{
          left: 0,
          top: 0,
          width: 6,
          height: 6,
          opacity: 0,
          background:
            "radial-gradient(circle, #ffffff 0%, #67E8F9 34%, #7C3AED 70%, transparent 100%)",
          transition: "opacity 60ms linear, box-shadow 60ms linear",
          willChange: "left, top, transform, opacity",
        }}
      />
      {/* Название города юзера — ПРИВЯЗАНО к точке геолокации, остаётся на ней пока
          камера удаляется (Босс 2026-05-29). Шрифт мелкий (~в 3 раза меньше), «земной»
          градиент blue→cyan→emerald, как счётчик стран на плеере 1. */}
      <div
        ref={winkCityRef}
        className="pointer-events-none absolute z-20 font-sans font-semibold whitespace-nowrap"
        style={{
          left: 0,
          top: 0,
          opacity: 0,
          transform: "translate(-50%, 0)",
          fontSize: 6,
          letterSpacing: 0.2,
          background: "linear-gradient(90deg,#60a5fa,#22d3ee,#6ee7b7)",
          WebkitBackgroundClip: "text",
          backgroundClip: "text",
          color: "transparent",
          textShadow: "0 0 6px rgba(34,211,238,0.4)",
          transition: "opacity 220ms ease",
          willChange: "left, top, opacity",
        }}
      />
      {/* Флаг страны (эмодзи) над точкой — виден 3 сек на проходе (Босс 2026-05-29). */}
      <div
        ref={winkFlagRef}
        className="pointer-events-none absolute z-20 whitespace-nowrap"
        style={{
          left: 0,
          top: 0,
          opacity: 0,
          transform: "translate(-50%, -100%)",
          fontSize: 22,
          filter: "drop-shadow(0 0 6px rgba(124,58,237,0.5))",
          transition: "opacity 220ms ease",
          willChange: "left, top, opacity",
        }}
      />
      {/* Подпись планеты при наведении (Босс 2026-05-29) — название на английском. */}
      <div
        ref={planetLabelRef}
        className="pointer-events-none absolute z-30 font-sans font-semibold whitespace-nowrap"
        style={{
          left: 0,
          top: 0,
          opacity: 0,
          transform: "translate(-50%, -100%)",
          fontSize: 12,
          letterSpacing: 0.3,
          color: "#fff",
          textShadow: "0 0 8px rgba(0,0,0,0.9), 0 0 14px rgba(124,58,237,0.6)",
          transition: "opacity 140ms ease",
          willChange: "left, top, opacity",
        }}
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
