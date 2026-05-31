// Eugene 2026-05-30 (Босс v3): 2-шаговый wizard «Полёт по Солнечной системе».
//
// Шаг 1 — «Куда летим?»: большая плитка «🪐 Все планеты» (default) + чекбоксы
// 8 планет + опции (спутники / главный пояс / Койпер / Сатурн сквозь кольца).
// Шаг 2 — «Под какой трек?»: default «🚀 Гагарин — Поехали!» (silent fallback)
// + раскрывашка «📋 Топ 100 треков MuzaAi» (fetch `/api/playlist?status=main&sort=rating`).
//
// LocalStorage: `muza:sis-prefs` — {planets[], satellites, mainBelt, kuiperBelt,
// saturnThroughRings, lastTrackId}.
//
// При «🚀 Поехали!» (CTA в шаге 2):
//   1. Сохранить prefs в localStorage.
//   2. dispatch `muza:globe-solar-prefs` (globe-view.tsx подхватит).
//   3. Вернуть selected track || null родителю через onLaunch — landing.tsx
//      сам решает запустить playTrack или нет (Persistent-audio-only rule —
//      audio управляется только из landing.tsx, не из wizard).
//
// UI правила:
//  • Brand-style consistency rule — purple-fuchsia-cyan gradient на CTA,
//    glass-card cards, font-display для заголовков.
//  • Device-fit-100 + Layout-fit-no-overlap — wizard как modal с
//    max-w-[min(96vw,640px)] + max-h-[calc(100dvh - 48px)] + внутренний scroll.
//  • Топ-100 список — max-h-[55dvh] с overflow-y:auto.
//  • Backdrop click / Escape / ✕ → onClose без launch.

import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { motion, AnimatePresence } from "framer-motion";
import { X, ChevronLeft, Music, Rocket } from "lucide-react";

// ────────────────────────────────────────────────────────────
// Типы prefs (совпадают с solarPrefsRef в globe-view.tsx)
// ────────────────────────────────────────────────────────────

export type SolarPrefs = {
  planets: string[];
  satellites: boolean;
  mainBelt: boolean;
  kuiperBelt: boolean;
  saturnThroughRings: boolean;
  lastTrackId: string | null;
  // Босс 2026-05-31: скорость полёта камеры между планетами.
  // light — «световая» (эталон Земля↔Марс ≈10с, cap 3-60с)
  // slow  — медленный реалистичный (max 3 мин на любой полёт)
  speedMode: "light" | "slow";
};

// ────────────────────────────────────────────────────────────
// Каталог планет/спутников.
// Босс 2026-05-30: «Луна должна быть первой» + «вид планеты/спутника как
// в реале» — иконки procedural CSS (radial-gradient под реальные цвета тел).
// ────────────────────────────────────────────────────────────

const PLANETS: Array<{ key: string; label: string; emoji: string }> = [
  { key: "moon",    label: "Луна",     emoji: "🌙" },
  { key: "mercury", label: "Меркурий", emoji: "☿" },
  { key: "venus",   label: "Венера",   emoji: "♀" },
  { key: "earth",   label: "Земля",    emoji: "🌍" },
  { key: "mars",    label: "Марс",     emoji: "♂" },
  { key: "jupiter", label: "Юпитер",   emoji: "♃" },
  { key: "saturn",  label: "Сатурн",   emoji: "🪐" },
  { key: "uranus",  label: "Уран",     emoji: "♅" },
  { key: "neptune", label: "Нептун",   emoji: "♆" },
];

// Луна — спутник, при single-select запускает tap-to-fly Moon, в групповом туре
// идёт первой остановкой. Остальные 8 — планеты (для тура solar).
const PLANET_ONLY_KEYS = PLANETS.filter((p) => p.key !== "moon").map((p) => p.key);
const ALL_PLANET_KEYS = PLANETS.map((p) => p.key);

// Procedural CSS-иконки тел (Босс 2026-05-30 «как в реале», простые radial-градиенты,
// без HD-текстур). Кольцо Сатурна — pseudo-element через box-shadow ring.
const PLANET_VISUALS: Record<string, { background: string; ring?: boolean }> = {
  moon: {
    background:
      "radial-gradient(circle at 35% 35%, #f5f5f0 0%, #d8d4c8 45%, #8a8478 100%)",
  },
  mercury: {
    background:
      "radial-gradient(circle at 35% 35%, #c9c0b5 0%, #998b7a 50%, #5a4f44 100%)",
  },
  venus: {
    background:
      "radial-gradient(circle at 35% 35%, #fff3cf 0%, #e9c878 50%, #a87a3a 100%)",
  },
  earth: {
    background:
      "radial-gradient(circle at 35% 35%, #6fc3ff 0%, #2978c8 45%, #134a82 100%)",
  },
  mars: {
    background:
      "radial-gradient(circle at 35% 35%, #ff8a55 0%, #c4502a 50%, #7a2e15 100%)",
  },
  jupiter: {
    background:
      "linear-gradient(180deg, #d9b78a 0%, #b88a5a 18%, #e0c498 35%, #9a6c40 52%, #d0a070 70%, #b88a5a 88%, #8a5e36 100%)",
  },
  saturn: {
    background:
      "radial-gradient(circle at 35% 35%, #f5e2b0 0%, #d4b878 50%, #8a6e3a 100%)",
    ring: true,
  },
  uranus: {
    background:
      "radial-gradient(circle at 35% 35%, #b8f0ee 0%, #76c8cf 50%, #3a78a0 100%)",
  },
  neptune: {
    background:
      "radial-gradient(circle at 35% 35%, #6f9cff 0%, #2e54c0 50%, #1a306e 100%)",
  },
};

/**
 * Маленькая procedural-иконка планеты/спутника. Радиальный градиент под реальные
 * цвета тела (Босс 2026-05-30 «как в реале»). Для Сатурна — overlay-кольцо.
 */
export function PlanetMiniIcon({ planetKey, size = 28 }: { planetKey: string; size?: number }) {
  const vis = PLANET_VISUALS[planetKey];
  if (!vis) return null;
  return (
    <span
      className="relative shrink-0 inline-block rounded-full"
      style={{
        width: size,
        height: size,
        background: vis.background,
        boxShadow: "inset -2px -2px 4px rgba(0,0,0,0.35), 0 0 6px rgba(255,255,255,0.08)",
      }}
      aria-hidden="true"
    >
      {vis.ring && (
        <span
          className="absolute left-1/2 top-1/2"
          style={{
            width: size * 1.55,
            height: size * 0.42,
            transform: "translate(-50%, -50%) rotate(-18deg)",
            borderRadius: "50%",
            border: "1.5px solid rgba(245, 226, 176, 0.85)",
            boxShadow: "inset 0 0 2px rgba(245, 226, 176, 0.4)",
            pointerEvents: "none",
          }}
        />
      )}
    </span>
  );
}

const DEFAULT_PREFS: SolarPrefs = {
  // Босс 2026-05-31: по умолчанию НИ ОДНА одиночная не выбрана. Юзер видит чистый
  // wizard — только Полный тур доступен сразу, чекбоксы пустые.
  planets: [],
  satellites: true,
  mainBelt: true,
  kuiperBelt: false,
  saturnThroughRings: true,
  lastTrackId: null,
  // Босс 2026-05-31 default — световая скорость.
  speedMode: "light",
};

// ────────────────────────────────────────────────────────────
// Трек из /api/playlist (минимальный shape).
// ────────────────────────────────────────────────────────────

type PlaylistTrack = {
  id: string | number;
  displayTitle?: string | null;
  authorName?: string | null;
  imageUrl?: string;
};

// ────────────────────────────────────────────────────────────
// Props.
// ────────────────────────────────────────────────────────────

interface SolarWizardProps {
  open: boolean;
  onClose: () => void;
  onLaunch: (args: { prefs: SolarPrefs; track: PlaylistTrack | null; moonOnly?: boolean }) => void;
  /**
   * Точка-источник «откуда вырастает» wizard (центр кнопки «🪐 Солнечная»
   * в viewport-координатах). Используется как transform-origin для popover
   * animation — юзер визуально понимает откуда взялось меню.
   * Босс 2026-05-30: «Меню должно появляться из соответствующего пункта
   * с пониманием откуда оно».
   */
  originPoint?: { x: number; y: number } | null;
  /**
   * Босс 2026-05-30 (Вариант A): preselect конкретного небесного тела при
   * открытии. Когда юзер тапает планету в 3D-globe → диспатчится
   * `muza:globe-tap-preselect {key}` → landing открывает wizard
   * с preselectKey=<key>. Wizard переопределяет `prefs.planets` на [key]
   * (даже если в saved prefs было что-то другое), показывает юзеру его
   * выбор. Юзер может скорректировать (добавить/убрать) или сразу нажать
   * «🚀 Поехали» — запустится existing solar тур по этим prefs.
   *
   * Если preselectKey совпадает с одной из 8 планет → planets = [key];
   * 'moon' → planets = ['moon'] (wizard поймёт это как moonOnly при launch);
   * 'sun' / 'earth' / unknown → не override (стандартный flow).
   */
  preselectKey?: string | null;
}

// ────────────────────────────────────────────────────────────
// Load / save prefs.
// ────────────────────────────────────────────────────────────

function loadPrefs(): SolarPrefs {
  try {
    const raw = localStorage.getItem("muza:sis-prefs");
    if (!raw) return DEFAULT_PREFS;
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return DEFAULT_PREFS;
    const planets = Array.isArray(parsed.planets)
      ? parsed.planets.filter((k: unknown) => typeof k === "string" && ALL_PLANET_KEYS.includes(k))
      : DEFAULT_PREFS.planets;
    return {
      planets: planets.length > 0 ? planets : DEFAULT_PREFS.planets,
      satellites: typeof parsed.satellites === "boolean" ? parsed.satellites : DEFAULT_PREFS.satellites,
      mainBelt: typeof parsed.mainBelt === "boolean" ? parsed.mainBelt : DEFAULT_PREFS.mainBelt,
      kuiperBelt: typeof parsed.kuiperBelt === "boolean" ? parsed.kuiperBelt : DEFAULT_PREFS.kuiperBelt,
      saturnThroughRings: typeof parsed.saturnThroughRings === "boolean" ? parsed.saturnThroughRings : DEFAULT_PREFS.saturnThroughRings,
      lastTrackId: parsed.lastTrackId == null ? null : String(parsed.lastTrackId),
      speedMode: parsed.speedMode === "slow" ? "slow" : DEFAULT_PREFS.speedMode,
    };
  } catch {
    return DEFAULT_PREFS;
  }
}

function savePrefs(p: SolarPrefs): void {
  try { localStorage.setItem("muza:sis-prefs", JSON.stringify(p)); } catch { /* ignore */ }
}

// ────────────────────────────────────────────────────────────
// Компонент.
// ────────────────────────────────────────────────────────────

export function SolarWizard({ open, onClose, onLaunch, originPoint, preselectKey }: SolarWizardProps) {
  const [step, setStep] = useState<1 | 2>(1);
  const [prefs, setPrefs] = useState<SolarPrefs>(() => loadPrefs());
  const [topListOpen, setTopListOpen] = useState(false);
  const [tracks, setTracks] = useState<PlaylistTrack[]>([]);
  const [tracksLoading, setTracksLoading] = useState(false);
  const [tracksError, setTracksError] = useState<string | null>(null);
  const [selectedTrack, setSelectedTrack] = useState<PlaylistTrack | null>(null);

  useEffect(() => {
    if (open) {
      setStep(1);
      const loaded = loadPrefs();
      // Босс 2026-05-30 (Вариант A): тап планеты в 3D-globe → wizard открывается
      // с этой планетой preselected (override saved prefs). Юзер видит свой выбор
      // отмеченным, может скорректировать (добавить/убрать) или сразу «🚀 Поехали».
      // Если preselectKey совпадает с одной из планет (включая Луну) — planets=[key].
      // 'sun' / 'earth' / unknown — стандартный flow без override.
      if (preselectKey && ALL_PLANET_KEYS.includes(preselectKey)) {
        setPrefs({ ...loaded, planets: [preselectKey] });
      } else {
        setPrefs(loaded);
      }
      setTopListOpen(false);
      setSelectedTrack(null);
    }
  }, [open, preselectKey]);

  const openedAtRef = useRef<number>(0);
  useEffect(() => {
    if (open) openedAtRef.current = Date.now();
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  // «Все планеты» = 8 планет от Меркурия до Нептуна (без Луны — она спутник,
  // выбирается отдельно из списка). Чекбокс «Все планеты выбраны» подсвечивается,
  // если ВСЕ 8 планетных ключей в prefs (Луна опциональна, не влияет на match).
  const allPlanetsSelected = useMemo(() => {
    return PLANET_ONLY_KEYS.every((k) => prefs.planets.includes(k));
  }, [prefs.planets]);

  const handleSelectAllPlanets = () => {
    // Сохраняем уже отмеченную Луну если была — просто добавляем все планеты.
    setPrefs((p) => {
      const set = new Set(p.planets);
      PLANET_ONLY_KEYS.forEach((k) => set.add(k));
      return { ...p, planets: Array.from(set) };
    });
    setStep(2);
  };

  const togglePlanet = (key: string) => {
    setPrefs((p) => {
      const has = p.planets.includes(key);
      const next = has ? p.planets.filter((k) => k !== key) : [...p.planets, key];
      return { ...p, planets: next };
    });
  };

  const handleConfirmStep1 = () => {
    if (prefs.planets.length === 0) {
      setPrefs((p) => ({ ...p, planets: [...ALL_PLANET_KEYS] }));
    }
    setStep(2);
  };

  useEffect(() => {
    if (!topListOpen || tracks.length > 0 || tracksLoading) return;
    let cancelled = false;
    setTracksLoading(true);
    setTracksError(null);
    fetch("/api/playlist?status=main&sort=rating&dir=desc&limit=100&_=" + Date.now(), { cache: "no-store" })
      .then(async (r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        const data = await r.json();
        if (!Array.isArray(data)) throw new Error("invalid response");
        return data as PlaylistTrack[];
      })
      .then((list) => {
        if (cancelled) return;
        setTracks(list.slice(0, 100));
        setTracksLoading(false);
        const last = prefs.lastTrackId;
        if (last) {
          const found = list.find((t) => String(t.id) === last);
          if (found) setSelectedTrack(found);
        }
      })
      .catch((e) => {
        if (cancelled) return;
        setTracksLoading(false);
        setTracksError(String(e?.message || e));
      });
    return () => { cancelled = true; };
  }, [topListOpen, tracks.length, tracksLoading, prefs.lastTrackId]);

  const handleLaunch = () => {
    try {
      if (typeof window !== "undefined" && window.localStorage?.getItem("muzaai-click-debug") === "1") {
        // eslint-disable-next-line no-console
        console.error("[click] 🚀 Поехали!");
      }
    } catch { /* no-op */ }
    const finalPrefs: SolarPrefs = {
      ...prefs,
      lastTrackId: selectedTrack ? String(selectedTrack.id) : null,
    };
    savePrefs(finalPrefs);
    try {
      window.dispatchEvent(new CustomEvent("muza:globe-solar-prefs", { detail: finalPrefs }));
    } catch { /* no-op */ }
    // Босс 2026-05-30: передаём флаг moonOnly в onLaunch — landing решит какой
    // event dispatch'ить (избегаем race: предыдущая логика dispatch'ила fly-to
    // ЗДЕСЬ, потом onLaunch ставил solar mode — race перетирал moon на solar).
    const moonOnly = finalPrefs.planets.length === 1 && finalPrefs.planets[0] === "moon";
    onLaunch({ prefs: finalPrefs, track: selectedTrack, moonOnly });
  };

  const handleBackdropClick = (e: React.MouseEvent) => {
    if (e.target !== e.currentTarget) return;
    if (Date.now() - openedAtRef.current < 300) return;
    onClose();
  };

  // Popover animation «из кнопки» (Босс 2026-05-30): transform-origin = точка
  // источника. CSS `transform-origin` интерпретируется ОТНОСИТЕЛЬНО самого
  // элемента (его bounding box, 0,0 — верх-лев угол). Поэтому вычисляем offset
  // viewport-точки кнопки относительно левого-верхнего угла content-box.
  // Pre-mount default = "center bottom" (от низа): пока ref не привязан,
  // используем дефолт; после mount эффект пересчитывает реальный origin.
  // Fallback на "center center" если originPoint не задан.
  const contentRef = useRef<HTMLDivElement | null>(null);
  const [transformOrigin, setTransformOrigin] = useState<string>("center center");
  useEffect(() => {
    if (!open) return;
    if (!originPoint || typeof window === "undefined") {
      setTransformOrigin("center center");
      return;
    }
    // RAF: ждём первого рендера motion.div чтобы getBoundingClientRect был валиден.
    const raf = requestAnimationFrame(() => {
      const el = contentRef.current;
      if (!el) return;
      const rect = el.getBoundingClientRect();
      // Offset точки кнопки от верх-лев угла content-box.
      const ox = originPoint.x - rect.left;
      const oy = originPoint.y - rect.top;
      // CSS принимает off-bounds значения (отрицательные / больше size) —
      // это и даёт popover effect «вырастает из точки за пределами/внутри панели».
      setTransformOrigin(`${Math.round(ox)}px ${Math.round(oy)}px`);
    });
    return () => cancelAnimationFrame(raf);
  }, [open, originPoint]);

  // Босс 2026-05-30: «Нажатие на Солнечная не привело к полёту… нет меню».
  // Root cause: wizard рендерился внутри `<section z-[1]>` (создаёт стэкинг-контекст);
  // его `z-[250]` не мог перебить globe-fullscreen portal `z-[200]` в `body`.
  // Fix: рендерим wizard через createPortal в document.body — z-index сравнивается
  // на root-уровне с globe-portal, wizard оказывается ПОВЕРХ.
  if (typeof document === "undefined") return null;
  return createPortal(
    <AnimatePresence>
      {open && (
        <motion.div
          key="solar-wizard-backdrop"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.2 }}
          onClick={handleBackdropClick}
          // Босс 2026-05-30: «нажатие на пустое место меню закрывает» — backdrop
          // ловит pointerdown (onClick на backdrop → handleBackdropClick → onClose).
          // z-[250] ВЫШЕ globe-fullscreen (z-[200] в landing.tsx createPortal) —
          // иначе wizard невидим за глобусом-fullscreen, что было root cause
          // «нет меню» (Босс жалоба «Нажатие на Солнечная не привело… нет меню»).
          className="fixed inset-0 z-[250] flex items-center justify-center px-4 py-6"
          style={{
            // Босс 2026-05-30 п.5: «Меню прозрачное видео только слова и контуры меню».
            // Лёгкий dim + сильный blur — глобус виден сквозь backdrop как видео-фон.
            background: "rgba(8,4,20,0.28)",
            backdropFilter: "blur(8px)",
            WebkitBackdropFilter: "blur(8px)",
          }}
          role="dialog"
          aria-modal="true"
          aria-label="Полёт по Солнечной системе"
        >
          <motion.div
            key="solar-wizard-content"
            ref={contentRef}
            // Popover animation: scale 0.5 → 1 ИЗ точки кнопки (transform-origin
            // = offset кнопки от верх-лев угла content-box, см. useEffect выше).
            // Юзер видит «меню выросло из кнопки» — понимает источник появления.
            initial={{ scale: 0.5, opacity: 0 }}
            animate={{ scale: 1, opacity: 1 }}
            exit={{ scale: 0.6, opacity: 0 }}
            transition={{ type: "spring", stiffness: 320, damping: 28 }}
            onClick={(e) => e.stopPropagation()}
            className="relative w-full overflow-hidden rounded-3xl border border-purple-400/35 shadow-[0_0_32px_rgba(124,58,237,0.35),inset_0_0_18px_rgba(168,85,247,0.12)]"
            style={{
              maxWidth: "min(96vw, 640px)",
              maxHeight: "calc(100dvh - 48px - env(safe-area-inset-top) - env(safe-area-inset-bottom))",
              transformOrigin,
              // Босс 2026-05-31: суб-панель ПРОЗРАЧНАЯ (видны планеты сквозь).
              // Контур — brand-purple линия + brand-glow (как плеер). Внутри
              // фона почти нет, только тонкий blur чтобы текст читался.
              background: "rgba(10,8,24,0.08)",
              backdropFilter: "blur(18px) saturate(140%)",
              WebkitBackdropFilter: "blur(18px) saturate(140%)",
            }}
          >
            {/* Заголовок + крестик */}
            <div className="flex items-center justify-between px-5 sm:px-6 pt-5 pb-3 border-b border-white/10">
              <div className="flex items-center gap-2 min-w-0">
                {step === 2 && (
                  <button
                    type="button"
                    onClick={() => setStep(1)}
                    className="shrink-0 h-8 w-8 rounded-full flex items-center justify-center text-white/80 hover:text-white hover:bg-white/10 active:scale-90 transition-all"
                    aria-label="Назад к выбору планет"
                  >
                    <ChevronLeft size={18} />
                  </button>
                )}
                <div className="min-w-0">
                  <div className="text-[11px] uppercase tracking-widest text-purple-300/80 font-semibold">
                    Шаг {step} из 2
                  </div>
                  <h2 className="text-lg sm:text-xl font-display font-bold bg-gradient-to-r from-purple-300 via-fuchsia-300 to-cyan-300 bg-clip-text text-transparent truncate">
                    {step === 1 ? "🪐 Куда летим?" : "🎵 Под какой трек?"}
                  </h2>
                </div>
              </div>
              <button
                type="button"
                onClick={onClose}
                className="shrink-0 h-9 w-9 rounded-full flex items-center justify-center text-white/70 hover:text-white hover:bg-white/10 active:scale-90 transition-all"
                aria-label="Закрыть"
              >
                <X size={18} />
              </button>
            </div>

            {/* Тело — scrollable */}
            <div
              className="overflow-y-auto px-5 sm:px-6 py-4"
              style={{ maxHeight: "calc(100dvh - 200px)" }}
            >
              {step === 1 ? (
                <Step1Body
                  prefs={prefs}
                  allPlanetsSelected={allPlanetsSelected}
                  onSelectAll={handleSelectAllPlanets}
                  onTogglePlanet={togglePlanet}
                  onUpdate={(patch) => setPrefs((p) => ({ ...p, ...patch }))}
                />
              ) : (
                <Step2Body
                  tracks={tracks}
                  tracksLoading={tracksLoading}
                  tracksError={tracksError}
                  topListOpen={topListOpen}
                  onToggleTopList={() => setTopListOpen((v) => !v)}
                  selectedTrack={selectedTrack}
                  onSelectTrack={setSelectedTrack}
                />
              )}
            </div>

            {/* Footer CTA — Босс 2026-05-30 п.5: прозрачный, только контур и текст. */}
            <div className="px-5 sm:px-6 py-4 border-t border-white/15">
              {step === 1 ? (
                <button
                  type="button"
                  onClick={handleConfirmStep1}
                  className="w-full h-12 rounded-2xl text-base font-bold text-white shadow-[0_0_32px_rgba(168,85,247,0.45)] active:scale-95 transition-all"
                  style={{
                    background: "linear-gradient(90deg, #7C3AED 0%, #D946EF 50%, #06B6D4 100%)",
                  }}
                >
                  ✓ ОК
                </button>
              ) : (
                <button
                  type="button"
                  onClick={handleLaunch}
                  className="w-full h-12 rounded-2xl text-base font-bold text-white shadow-[0_0_32px_rgba(168,85,247,0.5)] active:scale-95 transition-all flex items-center justify-center gap-2"
                  style={{
                    background: "linear-gradient(90deg, #7C3AED 0%, #D946EF 50%, #06B6D4 100%)",
                  }}
                >
                  <Rocket size={18} />
                  Поехали!
                </button>
              )}
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>,
    document.body,
  );
}

// ────────────────────────────────────────────────────────────
// Step1 — выбор планет + опции.
// ────────────────────────────────────────────────────────────

function Step1Body({
  prefs,
  allPlanetsSelected,
  onSelectAll,
  onTogglePlanet,
  onUpdate,
}: {
  prefs: SolarPrefs;
  allPlanetsSelected: boolean;
  onSelectAll: () => void;
  onTogglePlanet: (key: string) => void;
  onUpdate: (patch: Partial<SolarPrefs>) => void;
}) {
  return (
    <div className="space-y-4">
      {/* Босс 2026-05-31 «1 строка полный тур — только кнопку Поехали».
          Tile «Полный тур» сразу запускает — onSelectAll + автоматический
          переход на Step 2 + (можно сразу onLaunch с дефолтным треком).
          Стиль: прозрачный контур brand, фон solar-gradient прозрачный. */}
      <button
        type="button"
        onClick={onSelectAll}
        className={`w-full rounded-2xl p-4 sm:p-5 text-left transition-all active:scale-[0.98] border ${allPlanetsSelected
          ? "border-purple-300/55 bg-gradient-to-r from-purple-500/12 via-fuchsia-500/12 to-cyan-500/12 shadow-[0_0_24px_rgba(168,85,247,0.25)]"
          : "border-purple-400/30 bg-transparent hover:border-purple-400/55 hover:bg-purple-500/5"}`}
        aria-label="Полный тур — 8 планет — нажать Поехали"
      >
        <div className="flex items-center gap-3">
          <div className="text-3xl">🪐</div>
          <div className="min-w-0 flex-1">
            <div className="text-base sm:text-lg font-display font-bold bg-gradient-to-r from-purple-300 via-fuchsia-300 to-cyan-300 bg-clip-text text-transparent">Полный тур</div>
            <div className="text-[12px] text-white/70 truncate">8 планет: Меркурий → Нептун. Просто жми Поехали.</div>
          </div>
          <div className="shrink-0 text-purple-300 text-sm font-semibold">▶</div>
        </div>
      </button>

      {/* Список 8 планет с чекбоксами */}
      <div>
        <div className="text-[11px] uppercase tracking-widest text-white/60 font-semibold mb-2 px-1">
          …или выбери планеты вручную
        </div>
        <div className="grid grid-cols-2 gap-2">
          {PLANETS.map((p) => {
            const checked = prefs.planets.includes(p.key);
            // Босс 2026-05-30: «Планеты цветные как есть» (procedural-иконки
            // остаются), но border/bg в стиле 3D-плеера — нейтральные пока
            // не выбраны, brand-gradient fill при selected.
            return (
              <label
                key={p.key}
                className={`flex items-center gap-2 px-3 py-2.5 rounded-xl border cursor-pointer transition-all active:scale-[0.97] ${checked
                  ? "border-white/40 bg-gradient-to-r from-purple-500/15 via-fuchsia-500/15 to-cyan-500/15 text-white"
                  : "bg-transparent border-white/25 hover:border-white/55 text-white/80"}`}
              >
                <input
                  type="checkbox"
                  checked={checked}
                  onChange={() => onTogglePlanet(p.key)}
                  className="w-4 h-4 accent-purple-500 cursor-pointer"
                />
                <PlanetMiniIcon planetKey={p.key} size={22} />
                <span className={`text-sm font-medium truncate ${checked ? "bg-gradient-to-r from-purple-300 via-fuchsia-300 to-cyan-300 bg-clip-text text-transparent font-display font-bold" : ""}`}>{p.label}</span>
              </label>
            );
          })}
        </div>
      </div>

      {/* Доп. опции */}
      <div>
        <div className="text-[11px] uppercase tracking-widest text-white/60 font-semibold mb-2 px-1">
          Дополнительно
        </div>
        <div className="space-y-2">
          {/* Босс 2026-05-31: выбор скорости облёта. По умолчанию — световая. */}
          <div className="flex gap-2">
            <button
              type="button"
              onClick={() => onUpdate({ speedMode: "light" })}
              className={`flex-1 px-3 py-2.5 rounded-xl border text-sm font-medium transition-all ${prefs.speedMode === "light"
                ? "border-purple-300/55 bg-gradient-to-r from-purple-500/15 via-fuchsia-500/15 to-cyan-500/15 text-white"
                : "border-white/20 bg-transparent text-white/70 hover:border-white/40"}`}
            >⚡ Световая</button>
            <button
              type="button"
              onClick={() => onUpdate({ speedMode: "slow" })}
              className={`flex-1 px-3 py-2.5 rounded-xl border text-sm font-medium transition-all ${prefs.speedMode === "slow"
                ? "border-purple-300/55 bg-gradient-to-r from-purple-500/15 via-fuchsia-500/15 to-cyan-500/15 text-white"
                : "border-white/20 bg-transparent text-white/70 hover:border-white/40"}`}
            >🐢 3 минуты</button>
          </div>
          <OptionRow
            label="🌙 Со спутниками планет"
            description="Луна, Ио, Европа, Титан и другие — главные ~17 лун"
            checked={prefs.satellites}
            onChange={(v) => onUpdate({ satellites: v })}
          />
          <OptionRow
            label="☄️ Главный пояс астероидов"
            description="Между Марсом и Юпитером"
            checked={prefs.mainBelt}
            onChange={(v) => onUpdate({ mainBelt: v })}
          />
          <OptionRow
            label="❄️ Пояс Койпера"
            description="Ледяные тела за Нептуном"
            checked={prefs.kuiperBelt}
            onChange={(v) => onUpdate({ kuiperBelt: v })}
          />
          <OptionRow
            label="🪐 Сатурн — сквозь кольца"
            description="Эффектный пролёт через кольцевую систему"
            checked={prefs.saturnThroughRings}
            onChange={(v) => onUpdate({ saturnThroughRings: v })}
          />
        </div>
      </div>
    </div>
  );
}

function OptionRow({
  label,
  description,
  checked,
  onChange,
}: {
  label: string;
  description: string;
  checked: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <label className={`flex items-start gap-3 px-3 py-2.5 rounded-xl border cursor-pointer transition-all active:scale-[0.99] ${checked
      ? "border-fuchsia-300/50 bg-fuchsia-400/10"
      : "border-white/15 bg-white/5 hover:bg-white/10"}`}>
      <input
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        className="mt-0.5 w-4 h-4 accent-fuchsia-500 cursor-pointer shrink-0"
      />
      <div className="min-w-0 flex-1">
        <div className="text-sm font-medium text-white">{label}</div>
        <div className="text-[11px] text-white/55 leading-snug">{description}</div>
      </div>
    </label>
  );
}

// ────────────────────────────────────────────────────────────
// Step2 — выбор трека (Гагарин default + раскрывашка топ-100).
// ────────────────────────────────────────────────────────────

function Step2Body({
  tracks,
  tracksLoading,
  tracksError,
  topListOpen,
  onToggleTopList,
  selectedTrack,
  onSelectTrack,
}: {
  tracks: PlaylistTrack[];
  tracksLoading: boolean;
  tracksError: string | null;
  topListOpen: boolean;
  onToggleTopList: () => void;
  selectedTrack: PlaylistTrack | null;
  onSelectTrack: (t: PlaylistTrack | null) => void;
}) {
  return (
    <div className="space-y-3">
      {/* Default — Гагарин (silent placeholder, метка-маркер запуска без музыки) */}
      <button
        type="button"
        onClick={() => onSelectTrack(null)}
        className={`w-full rounded-2xl p-4 text-left transition-all active:scale-[0.98] border ${selectedTrack === null
          ? "border-purple-300/70 bg-gradient-to-r from-purple-500/25 via-fuchsia-500/15 to-cyan-500/15 shadow-[0_0_24px_rgba(168,85,247,0.30)]"
          : "border-white/20 bg-white/5 hover:bg-white/10"}`}
      >
        <div className="flex items-center gap-3">
          <div className="text-2xl shrink-0">🚀</div>
          <div className="min-w-0 flex-1">
            <div className="text-sm sm:text-base font-display font-bold text-white truncate">
              Юрий Гагарин — Поехали!
            </div>
            <div className="text-[11px] text-white/60 truncate">
              Тихий полёт без музыки — исторический референс 1961
            </div>
          </div>
          {selectedTrack === null && (
            <div className="shrink-0 text-purple-300 text-sm">✓</div>
          )}
        </div>
      </button>

      {/* Toggle: топ-100 треков MuzaAi */}
      <button
        type="button"
        onClick={onToggleTopList}
        className="w-full rounded-2xl p-3 text-left transition-all active:scale-[0.99] border border-white/20 bg-white/5 hover:bg-white/10"
        aria-expanded={topListOpen}
      >
        <div className="flex items-center gap-3">
          <Music size={18} className="text-cyan-300 shrink-0" />
          <div className="flex-1 min-w-0">
            <div className="text-sm font-medium text-white">📋 Топ 100 треков MuzaAi</div>
            <div className="text-[11px] text-white/55 truncate">
              {topListOpen ? "Свернуть список" : "Выбрать трек из топа главной"}
            </div>
          </div>
          <div className={`shrink-0 text-white/60 text-base transition-transform ${topListOpen ? "rotate-180" : ""}`}>▾</div>
        </div>
      </button>

      {/* Раскрывашка — список треков */}
      {topListOpen && (
        <div
          className="rounded-2xl border border-white/15 bg-black/30 overflow-y-auto"
          style={{ maxHeight: "min(55dvh, 380px)" }}
        >
          {tracksLoading && (
            <div className="px-4 py-6 text-center text-sm text-white/60">Загружаю топ-100…</div>
          )}
          {tracksError && (
            <div className="px-4 py-6 text-center text-sm text-red-300">Не удалось загрузить: {tracksError}</div>
          )}
          {!tracksLoading && !tracksError && tracks.length === 0 && (
            <div className="px-4 py-6 text-center text-sm text-white/60">Пусто</div>
          )}
          {!tracksLoading && !tracksError && tracks.length > 0 && (
            <ul className="divide-y divide-white/8">
              {tracks.map((t, idx) => {
                const isSelected = selectedTrack && String(selectedTrack.id) === String(t.id);
                const title = t.displayTitle || "Без названия";
                const author = t.authorName || "—";
                return (
                  <li key={String(t.id)}>
                    <button
                      type="button"
                      onClick={() => onSelectTrack(t)}
                      className={`w-full flex items-center gap-3 px-3 py-2.5 text-left transition-all active:bg-white/10 ${isSelected ? "bg-cyan-400/10" : "hover:bg-white/5"}`}
                    >
                      <div className="shrink-0 w-6 text-center text-[11px] tabular-nums text-white/50 font-mono">
                        {idx + 1}
                      </div>
                      {t.imageUrl ? (
                        <img
                          src={t.imageUrl}
                          alt=""
                          loading="lazy"
                          className="shrink-0 w-9 h-9 rounded-md object-cover bg-white/10"
                        />
                      ) : (
                        <div className="shrink-0 w-9 h-9 rounded-md bg-white/10 flex items-center justify-center text-white/40">
                          <Music size={14} />
                        </div>
                      )}
                      <div className="min-w-0 flex-1">
                        <div className="text-[13px] font-medium text-white truncate">{title}</div>
                        <div className="text-[11px] text-white/55 truncate">{author}</div>
                      </div>
                      {isSelected && <div className="shrink-0 text-cyan-300 text-sm">✓</div>}
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      )}

      {/* Подпись выбранного — для confirm */}
      <div className="text-center text-[11px] text-white/55 pt-1">
        {selectedTrack
          ? <>Выбран: <span className="text-cyan-200 font-medium">{selectedTrack.displayTitle || "Без названия"}</span></>
          : <>Без музыки — тихий полёт</>}
      </div>
    </div>
  );
}
