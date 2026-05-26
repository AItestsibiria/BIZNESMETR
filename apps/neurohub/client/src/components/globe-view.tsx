// globe-view.tsx — настоящий 3D-глобус Земли (ФАЗА 1, без погоды).
// Eugene 2026-05-26 Босс «настоящий 3D-глобус, реальная география континентов,
// вращение планеты, стильный, с зумом». ФАЗА 1 — БЕЗ погоды/день-ночь
// (это Фаза 2, добавим отдельно после подтверждения Босса).
//
// Архитектура изоляции (глобус НЕ должен ломать страницу):
//   1. Lazy-load: react-globe.gl (обёртка three-globe) грузится через
//      React.lazy(() => import("react-globe.gl")) + <Suspense> — тяжёлый chunk
//      (three.js ~600KB) не попадает в main bundle. Образец lazy-подхода —
//      second-brain-3d.tsx.
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
  type ComponentType,
  type ReactNode,
  type Ref,
} from "react";

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
  // Runtime-поля — пересчитываются rAF-циклом «загорания по повороту».
  _front?: boolean;  // на фронтальной (видимой) стороне глобуса
  _delta?: number;   // |долгота − камерный меридиан| в градусах (0 = по центру)
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

// react-globe.gl default export — React-компонент (FCwithRef<GlobeProps,
// GlobeMethods>). React.lazy теряет props-типизацию, поэтому приводим
// результат к типизированному ComponentType: props выверены по d.ts пакета.
// Тяжёлый chunk грузится отдельно. Если импорт упадёт — GlobeErrorBoundary
// поймает на этапе рендера Suspense.
type GlobeComponentProps = {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ref?: Ref<any>;
  width?: number;
  height?: number;
  backgroundColor?: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  rendererConfig?: any;
  globeImageUrl?: string | null;
  backgroundImageUrl?: string;
  bumpImageUrl?: string | null;
  showAtmosphere?: boolean;
  atmosphereColor?: string;
  atmosphereAltitude?: number;
  onGlobeReady?: () => void;
  pointsData?: object[];
  pointLat?: (d: GlobePoint) => number;
  pointLng?: (d: GlobePoint) => number;
  pointColor?: (d: GlobePoint) => string;
  pointAltitude?: (d: GlobePoint) => number;
  pointRadius?: number | ((d: GlobePoint) => number);
  pointResolution?: number;
  pointsTransitionDuration?: number;
  pointLabel?: (d: GlobePoint) => string;
  // Rings layer — кольца «приём сигнала» (расходящаяся радиоволна).
  ringsData?: object[];
  ringLat?: (d: RingDatum) => number;
  ringLng?: (d: RingDatum) => number;
  ringColor?: (d: RingDatum) => string[] | string;
  ringMaxRadius?: (d: RingDatum) => number;
  ringPropagationSpeed?: (d: RingDatum) => number;
  ringRepeatPeriod?: (d: RingDatum) => number;
  ringResolution?: number;
};
const Globe = lazy(() => import("react-globe.gl")) as unknown as ComponentType<GlobeComponentProps>;

// ───────────────────────────────────────────────────────────────────────────
// Текстуры Земли (CDN, грузятся в браузере юзера). Реальная география.
// Blue Marble (NASA) даёт настоящие континенты в equirectangular-проекции.
const EARTH_TEXTURE_URL = "//cdn.jsdelivr.net/npm/three-globe/example/img/earth-blue-marble.jpg";
const EARTH_BUMP_URL = "//cdn.jsdelivr.net/npm/three-globe/example/img/earth-topology.png";

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

// Brand palette для маркеров/колец — purple / cyan / fuchsia.
const BRAND_PURPLE = "#7C3AED";
const BRAND_CYAN = "#00D4FF";
const BRAND_FUCHSIA = "#FF006E";
const MARKER_COLORS = [BRAND_PURPLE, BRAND_CYAN, BRAND_FUCHSIA, "#A78BFA", "#67E8F9"];

// «Загорание по повороту»: страна на ФРОНТАЛЬНОЙ (видимой) стороне глобуса,
// если её долгота в пределах ±FRONT_HALF_DEG от меридиана, обращённого к камере
// (камерная долгота из pointOfView().lng авто-вращения).
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
function GlobeInner({ points }: { points: GlobePoint[] }) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const globeRef = useRef<any>(null);
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const [size, setSize] = useState<{ w: number; h: number }>({ w: 320, h: 320 });
  const [ready, setReady] = useState(false);

  // Базовые точки в ref — rAF-цикл читает их без пересоздания эффекта.
  const basePointsRef = useRef<GlobePoint[]>(points);
  useEffect(() => {
    basePointsRef.current = points;
  }, [points]);

  // Что реально рендерится (пересчитывается rAF по фронтальности).
  const [litPoints, setLitPoints] = useState<GlobePoint[]>(points);
  const [rings, setRings] = useState<RingDatum[]>([]);

  const rafRef = useRef<number | null>(null);
  const ringIdRef = useRef(0);
  // Страны СЕЙЧАС на фронте — чтобы ловить переход back→front и выпускать
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
  // rAF-цикл «загорание по повороту» + кольца «приём сигнала».
  // Читает долготу камеры (pointOfView().lng авто-вращения) → считает
  // фронтальность каждой страны → модулирует яркость/высоту маркера; при ВХОДЕ
  // страны во фронтальный сектор выпускает расходящееся кольцо (ripple).
  useEffect(() => {
    if (!ready) return;
    let destroyed = false;
    // Throttle тяжёлых setState (пересборка массива точек) до ~12fps —
    // достаточно для плавного «загорания», не грузит React (lightweight).
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
      try {
        const pov = g.pointOfView?.();
        if (!pov) return;
        camLng = pov.lng ?? 0;
      } catch {
        return;
      }

      const pts = basePointsRef.current;
      if (pts.length === 0) return;

      const nextFront = new Set<string>();
      const newRings: RingDatum[] = [];

      const lit: GlobePoint[] = pts.map((p) => {
        // Фронтальность: |delta| 0° = по центру видимой стороны, 180° = сзади.
        const delta = Math.abs(lngDelta(p.lng, camLng));
        const isFront = delta <= FRONT_HALF_DEG;

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
        }

        // Яркость маркера: фронт = ярко (min 0.55), тёмная сторона = тускло.
        const t = Math.max(0, Math.min(1, 1 - delta / 180)); // 1 центр → 0 сзади
        const frontGain = isFront ? Math.max(0.55, t) : t * 0.45;
        const alpha = 0.16 + 0.79 * frontGain;
        const color = hexToRgba(p.baseColor, alpha);
        const baseAlt = 0.02 + Math.min(0.22, Math.log10((p.weight || 1) + 1) * 0.08);
        // На фронте маркер «приподнимается» (загорелся), сзади — прижат.
        const altitude = isFront ? baseAlt * 1.6 : baseAlt * 0.55;

        return { ...p, _front: isFront, _delta: delta, color, altitude };
      });

      frontSetRef.current = nextFront;
      setLitPoints(lit);

      if (newRings.length) {
        setRings((prev) => {
          // Кольцо живёт ~1.8s. Чистим старые, чтобы массив не рос.
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
  }, [ready]);

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
      g.pointOfView?.({ lat: 30, lng: 50, altitude: 1.9 }, 0);
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
        backgroundImageUrl="//cdn.jsdelivr.net/npm/three-globe/example/img/night-sky.png"
        globeImageUrl={EARTH_TEXTURE_URL}
        bumpImageUrl={EARTH_BUMP_URL}
        showAtmosphere={true}
        atmosphereColor="#7C3AED"
        atmosphereAltitude={0.22}
        onGlobeReady={onGlobeReady}
        // ── Маркеры «загораются» по повороту (фронт = ярко + приподнят). ──
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
      arr.push({
        lat: ll[0],
        lng: ll[1],
        label: c.name,
        weight,
        baseColor,
        color: baseColor, // стартовая яркость до первого rAF-tick
        altitude: 0.02 + Math.min(0.22, Math.log10(weight + 1) * 0.08),
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
