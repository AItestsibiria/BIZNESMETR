// FeatureTogglesPanel — модалка с toggles для всех опциональных frontend-фич.
// Eugene 2026-05-19: «по всему проекту фронт — простая возможность выключить».
// Eugene 2026-05-19: «все делаем, отключим если надо».
//
// Группировка по категориям, pending=true помечается как «скоро».
// Открывается кликом на ⚙ в navbar.

import { useEffect, useState } from "react";
import { X } from "lucide-react";
import {
  FEATURES,
  CATEGORY_LABELS,
  featureEnabled,
  setFeatureEnabled,
  resetAllFeatures,
  type FeatureKey,
  type FeatureCategory,
} from "@/lib/featureToggles";

interface Props {
  open: boolean;
  onClose: () => void;
  /** admin mode — показывает adminHint под description */
  admin?: boolean;
}

export function FeatureTogglesPanel({ open, onClose, admin = false }: Props) {
  const [tick, setTick] = useState(0);
  useEffect(() => {
    if (!open) return;
    const onEsc = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onEsc);
    return () => window.removeEventListener("keydown", onEsc);
  }, [open, onClose]);

  if (!open) return null;

  const toggle = (key: FeatureKey) => {
    setFeatureEnabled(key, !featureEnabled(key));
    setTick(t => t + 1);
  };

  const reset = () => {
    resetAllFeatures();
    setTick(t => t + 1);
  };

  // Группировка фич по category
  const grouped: Record<FeatureCategory, typeof FEATURES> = {} as any;
  for (const f of FEATURES) {
    if (!grouped[f.category]) grouped[f.category] = [];
    grouped[f.category].push(f);
  }
  const categoryOrder: FeatureCategory[] = ["ui", "notifications", "audio", "musa", "mobile", "a11y", "system", "privacy"];

  return (
    <div
      className="fixed inset-0 z-[9999] flex items-center justify-center p-4 backdrop-blur-sm bg-black/60 animate-in fade-in duration-200"
      onClick={onClose}
    >
      <div
        className="relative w-full max-w-lg max-h-[88vh] overflow-y-auto rounded-2xl bg-gradient-to-br from-[#1a0f2e]/95 via-[#0a0a17]/95 to-[#0f1830]/95 border border-purple-500/30 shadow-[0_0_48px_rgba(124,58,237,0.3)] backdrop-blur-xl"
        onClick={e => e.stopPropagation()}
        data-testid="feature-toggles-panel"
      >
        <div className="sticky top-0 z-10 flex items-center justify-between px-5 py-4 border-b border-white/10 bg-gradient-to-b from-[#1a0f2e]/95 to-[#1a0f2e]/80 backdrop-blur-xl">
          <h2 className="text-lg font-display font-bold gradient-text">
            {admin ? "Управление UI-фичами" : "Настройки интерфейса"}
          </h2>
          <button
            onClick={onClose}
            className="w-8 h-8 rounded-full bg-white/5 hover:bg-white/10 flex items-center justify-center text-white/60 hover:text-white transition-colors"
            aria-label="Закрыть"
          >
            <X className="w-4 h-4" />
          </button>
        </div>
        <div className="px-2 py-2">
          {categoryOrder.map(cat => {
            const items = grouped[cat] || [];
            if (items.length === 0) return null;
            return (
              <div key={cat} className="mb-3">
                <div className="px-3 pt-3 pb-1 text-xs font-bold text-purple-300/80 uppercase tracking-wider">
                  {CATEGORY_LABELS[cat]}
                </div>
                {items.map(f => {
                  const on = featureEnabled(f.key);
                  return (
                    <button
                      key={f.key}
                      onClick={() => toggle(f.key)}
                      className="w-full flex items-start gap-3 px-3 py-2.5 rounded-xl hover:bg-white/[0.04] transition-colors text-left"
                      data-testid={`toggle-${f.key}`}
                    >
                      <div className="flex-1 min-w-0">
                        <div className="text-sm font-medium text-white flex items-center gap-2 flex-wrap">
                          {f.label}
                          {f.pending && (
                            <span className="text-[9px] font-mono px-1.5 py-0.5 rounded bg-amber-500/20 text-amber-300 border border-amber-500/30">
                              скоро
                            </span>
                          )}
                        </div>
                        <div className="text-xs text-white/55 mt-0.5 leading-relaxed">{f.description}</div>
                        {admin && f.adminHint && (
                          <div className="text-[11px] text-cyan-300/70 mt-1 leading-relaxed font-mono bg-cyan-500/5 px-2 py-1 rounded border border-cyan-500/15">
                            🛠 {f.adminHint}
                          </div>
                        )}
                      </div>
                      <div
                        className={`shrink-0 mt-1 w-11 h-6 rounded-full transition-colors relative ${
                          on ? "bg-gradient-to-r from-purple-500 to-fuchsia-500" : "bg-white/15"
                        }`}
                        aria-pressed={on}
                        role="switch"
                      >
                        <div
                          className={`absolute top-0.5 w-5 h-5 rounded-full bg-white shadow-md transition-all ${
                            on ? "left-[22px]" : "left-0.5"
                          }`}
                        />
                      </div>
                    </button>
                  );
                })}
              </div>
            );
          })}
        </div>
        <div className="sticky bottom-0 px-5 py-3 border-t border-white/10 flex items-center justify-between gap-2 bg-gradient-to-t from-[#1a0f2e]/95 to-[#1a0f2e]/80 backdrop-blur-xl">
          <button
            onClick={reset}
            className="text-xs text-white/50 hover:text-white/80 transition-colors px-2 py-1"
          >
            Сбросить все к умолчанию
          </button>
          <button
            onClick={onClose}
            className="text-sm font-medium px-4 py-1.5 rounded-lg bg-gradient-to-r from-purple-500/70 to-fuchsia-500/70 hover:from-purple-500 hover:to-fuchsia-500 text-white transition-all"
          >
            Готово
          </button>
        </div>
      </div>
    </div>
  );
}
