// Admin tab: «🎛 UI Toggles» — управление всеми frontend feature toggle одним
// блоком с подсказками для админа. Eugene 2026-05-19: «заведи в админке
// управление одним блоком с подсказками для админа».
//
// Изменения сохраняются в localStorage (как и у юзера) — это управление
// СОБСТВЕННЫМ Settings для админ-аккаунта. Глобальный override (force-enable
// для всех юзеров) — потенциально через DB, отложено до запроса.

import { useState } from "react";
import {
  FEATURES,
  CATEGORY_LABELS,
  featureEnabled,
  setFeatureEnabled,
  resetAllFeatures,
  type FeatureKey,
  type FeatureCategory,
} from "@/lib/featureToggles";

export function FeatureTogglesAdminTab() {
  const [tick, setTick] = useState(0);
  const toggle = (key: FeatureKey) => {
    setFeatureEnabled(key, !featureEnabled(key));
    setTick(t => t + 1);
  };
  const reset = () => { resetAllFeatures(); setTick(t => t + 1); };

  const grouped: Record<FeatureCategory, typeof FEATURES> = {} as any;
  for (const f of FEATURES) {
    if (!grouped[f.category]) grouped[f.category] = [];
    grouped[f.category].push(f);
  }
  const order: FeatureCategory[] = ["ui", "notifications", "audio", "musa", "mobile", "a11y", "system", "privacy"];

  const total = FEATURES.length;
  const onCount = FEATURES.filter(f => featureEnabled(f.key)).length;
  const pendingCount = FEATURES.filter(f => f.pending).length;

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div>
          <h2 className="text-lg font-display font-bold gradient-text">🎛 UI Feature Toggles</h2>
          <p className="text-xs text-white/55 mt-1">Управление опциональными frontend-фичами проекта. Подсказки для админа в каждом пункте.</p>
        </div>
        <div className="flex items-center gap-2">
          <span className="text-xs px-3 py-1 rounded-full bg-purple-500/15 text-purple-300 border border-purple-500/30">
            Всего: {total}
          </span>
          <span className="text-xs px-3 py-1 rounded-full bg-emerald-500/15 text-emerald-300 border border-emerald-500/30">
            Активно: {onCount}
          </span>
          <span className="text-xs px-3 py-1 rounded-full bg-amber-500/15 text-amber-300 border border-amber-500/30">
            Скоро (без wiring): {pendingCount}
          </span>
          <button
            onClick={reset}
            className="text-xs px-3 py-1 rounded-full bg-white/5 hover:bg-white/10 text-white/70 hover:text-white border border-white/10 transition-colors"
          >
            Сбросить
          </button>
        </div>
      </div>

      {order.map(cat => {
        const items = grouped[cat] || [];
        if (items.length === 0) return null;
        return (
          <div key={cat} className="rounded-2xl border border-purple-500/20 bg-gradient-to-br from-[#1a0f2e]/60 to-[#0a0a17]/40 p-4">
            <div className="text-sm font-bold text-purple-300 uppercase tracking-wider mb-3">
              {CATEGORY_LABELS[cat]}
            </div>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
              {items.map(f => {
                const on = featureEnabled(f.key);
                return (
                  <button
                    key={f.key}
                    onClick={() => toggle(f.key)}
                    className="flex items-start gap-3 px-3 py-3 rounded-xl bg-white/[0.02] hover:bg-white/[0.04] border border-white/5 transition-colors text-left"
                    data-testid={`admin-toggle-${f.key}`}
                  >
                    <div className="flex-1 min-w-0">
                      <div className="text-sm font-medium text-white flex items-center gap-2 flex-wrap">
                        {f.label}
                        {f.pending && (
                          <span className="text-[9px] font-mono px-1.5 py-0.5 rounded bg-amber-500/20 text-amber-300 border border-amber-500/30">
                            скоро
                          </span>
                        )}
                        <code className="text-[10px] font-mono text-white/35">{f.key}</code>
                      </div>
                      <div className="text-xs text-white/60 mt-1 leading-relaxed">{f.description}</div>
                      {f.adminHint && (
                        <div className="text-[11px] text-cyan-300/80 mt-2 leading-relaxed bg-cyan-500/5 px-2 py-1.5 rounded border border-cyan-500/15">
                          <span className="font-semibold">🛠 Для админа:</span> {f.adminHint}
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
          </div>
        );
      })}

      <div className="rounded-xl border border-purple-500/20 bg-purple-500/5 p-4 text-xs text-white/60 leading-relaxed">
        <p className="font-semibold text-purple-200 mb-2">📘 Как это работает</p>
        <ul className="list-disc list-inside space-y-1">
          <li>Изменения сохраняются в <code className="font-mono text-white/80">localStorage._user_features</code> — для текущего админ-браузера.</li>
          <li><code className="font-mono">featureEnabled(key)</code> в любом компоненте — проверка состояния. Hook <code className="font-mono">useFeatureEnabled(key)</code> — для realtime ребилда.</li>
          <li>«скоро» — фича заявлена в реестре, но wiring к коду ещё не сделан. Toggle работает, но не имеет эффекта (пока).</li>
          <li>Глобальный force-override для всех юзеров (через DB) — отложен, можно добавить когда понадобится.</li>
        </ul>
      </div>
    </div>
  );
}
