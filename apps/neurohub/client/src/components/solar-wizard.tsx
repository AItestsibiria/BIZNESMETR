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
};

// ────────────────────────────────────────────────────────────
// Каталог планет (8 шт).
// ────────────────────────────────────────────────────────────

const PLANETS: Array<{ key: string; label: string; emoji: string }> = [
  { key: "mercury", label: "Меркурий", emoji: "☿" },
  { key: "venus",   label: "Венера",   emoji: "♀" },
  { key: "earth",   label: "Земля",    emoji: "🌍" },
  { key: "mars",    label: "Марс",     emoji: "♂" },
  { key: "jupiter", label: "Юпитер",   emoji: "♃" },
  { key: "saturn",  label: "Сатурн",   emoji: "🪐" },
  { key: "uranus",  label: "Уран",     emoji: "♅" },
  { key: "neptune", label: "Нептун",   emoji: "♆" },
];

const ALL_PLANET_KEYS = PLANETS.map((p) => p.key);

const DEFAULT_PREFS: SolarPrefs = {
  planets: ALL_PLANET_KEYS,
  satellites: true,
  mainBelt: true,
  kuiperBelt: false,
  saturnThroughRings: true,
  lastTrackId: null,
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
  onLaunch: (args: { prefs: SolarPrefs; track: PlaylistTrack | null }) => void;
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

export function SolarWizard({ open, onClose, onLaunch }: SolarWizardProps) {
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
      setPrefs(loadPrefs());
      setTopListOpen(false);
      setSelectedTrack(null);
    }
  }, [open]);

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

  const allPlanetsSelected = useMemo(() => prefs.planets.length === ALL_PLANET_KEYS.length, [prefs.planets]);

  const handleSelectAllPlanets = () => {
    setPrefs((p) => ({ ...p, planets: [...ALL_PLANET_KEYS] }));
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
    const finalPrefs: SolarPrefs = {
      ...prefs,
      lastTrackId: selectedTrack ? String(selectedTrack.id) : null,
    };
    savePrefs(finalPrefs);
    try {
      window.dispatchEvent(new CustomEvent("muza:globe-solar-prefs", { detail: finalPrefs }));
    } catch { /* no-op */ }
    onLaunch({ prefs: finalPrefs, track: selectedTrack });
  };

  const handleBackdropClick = (e: React.MouseEvent) => {
    if (e.target !== e.currentTarget) return;
    if (Date.now() - openedAtRef.current < 300) return;
    onClose();
  };

  return (
    <AnimatePresence>
      {open && (
        <motion.div
          key="solar-wizard-backdrop"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.2 }}
          onClick={handleBackdropClick}
          className="fixed inset-0 z-[80] flex items-center justify-center px-4 py-6"
          style={{
            background: "radial-gradient(ellipse at center, rgba(20,8,40,0.78) 0%, rgba(8,4,20,0.92) 70%)",
            backdropFilter: "blur(12px)",
            WebkitBackdropFilter: "blur(12px)",
          }}
          role="dialog"
          aria-modal="true"
          aria-label="Полёт по Солнечной системе"
        >
          <motion.div
            key="solar-wizard-content"
            initial={{ scale: 0.92, opacity: 0, y: 12 }}
            animate={{ scale: 1, opacity: 1, y: 0 }}
            exit={{ scale: 0.94, opacity: 0, y: 8 }}
            transition={{ type: "spring", stiffness: 280, damping: 26 }}
            onClick={(e) => e.stopPropagation()}
            className="relative w-full overflow-hidden rounded-3xl border border-purple-400/35 shadow-[0_0_60px_rgba(168,85,247,0.35)]"
            style={{
              maxWidth: "min(96vw, 640px)",
              maxHeight: "calc(100dvh - 48px - env(safe-area-inset-top) - env(safe-area-inset-bottom))",
              background: "linear-gradient(135deg, rgba(16,8,32,0.96) 0%, rgba(22,12,48,0.96) 60%, rgba(10,6,28,0.96) 100%)",
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

            {/* Footer CTA */}
            <div className="px-5 sm:px-6 py-4 border-t border-white/10 bg-black/30">
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
    </AnimatePresence>
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
      {/* Big tile «Все планеты» */}
      <button
        type="button"
        onClick={onSelectAll}
        className={`w-full rounded-2xl p-4 sm:p-5 text-left transition-all active:scale-[0.98] border ${allPlanetsSelected
          ? "border-purple-300/70 bg-gradient-to-r from-purple-500/25 via-fuchsia-500/20 to-cyan-500/20 shadow-[0_0_24px_rgba(168,85,247,0.35)]"
          : "border-white/20 bg-white/5 hover:bg-white/10"}`}
        aria-label="Выбрать все 8 планет и перейти к выбору трека"
      >
        <div className="flex items-center gap-3">
          <div className="text-3xl">🪐</div>
          <div className="min-w-0 flex-1">
            <div className="text-base sm:text-lg font-display font-bold text-white">Все планеты</div>
            <div className="text-[12px] text-white/70 truncate">Полный тур: 8 планет — Меркурий → Нептун</div>
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
            return (
              <label
                key={p.key}
                className={`flex items-center gap-2 px-3 py-2.5 rounded-xl border cursor-pointer transition-all active:scale-[0.97] ${checked
                  ? "border-cyan-300/60 bg-cyan-400/10"
                  : "border-white/15 bg-white/5 hover:bg-white/10"}`}
              >
                <input
                  type="checkbox"
                  checked={checked}
                  onChange={() => onTogglePlanet(p.key)}
                  className="w-4 h-4 accent-purple-500 cursor-pointer"
                />
                <span className="text-lg shrink-0">{p.emoji}</span>
                <span className="text-sm font-medium text-white truncate">{p.label}</span>
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
