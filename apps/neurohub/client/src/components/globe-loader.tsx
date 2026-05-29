// Eugene 2026-05-29 (Босс) «по загрузке 3D — показать процент в динамике, рост
// загрузки в стиле MuzaAi, типа взлетаем» + «не прям ракетой смысл». Брендовый
// лоадер 3D-глобуса БЕЗ ракеты: растущий процент (асимптотически к 96%, плавно),
// волна MuzaAi + прогресс-бар + поднимающийся эквалайзер (ощущение «взлёта»/
// энергии), brand-градиент purple→fuchsia→cyan + мягкое свечение. Когда глобус
// готов — компонент размонтируется (визуально = 100%).

import { useEffect, useState } from "react";

export function GlobeLoader() {
  const [pct, setPct] = useState(2);

  useEffect(() => {
    let p = 2;
    const id = window.setInterval(() => {
      // Асимптотический рост к 96% — замедляется ближе к концу (естественный
      // прогресс при неизвестной длительности сети). До 100% доводит размонтаж.
      const remaining = 96 - p;
      p += Math.max(0.5, remaining * 0.07);
      if (p > 96) p = 96;
      setPct(Math.round(p));
    }, 130);
    return () => window.clearInterval(id);
  }, []);

  return (
    <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 px-6 select-none pointer-events-none">
      {/* Волна MuzaAi с пульсацией + аура */}
      <div className="relative">
        <span aria-hidden className="absolute -inset-5 rounded-full blur-2xl opacity-50 cover-aura" />
        <div className="relative w-12 h-12 rounded-2xl bg-gradient-to-br from-purple-600 via-fuchsia-500 to-cyan-500 flex items-center justify-center shadow-[0_0_24px_rgba(217,70,239,0.5)] animate-pulse">
          <svg viewBox="0 0 24 24" className="w-7 h-7" fill="none">
            <path d="M3 12c1.5-3 3-5 4.5-3s2 4 3.5 2 2.5-5 4-3 2 4 3.5 2 2.5-4 3.5-2" stroke="white" strokeWidth="2.2" strokeLinecap="round" />
          </svg>
        </div>
      </div>

      {/* Растущий процент — слегка поднимается по мере роста («взлёт») */}
      <div
        className="text-4xl font-display font-black tabular-nums bg-gradient-to-r from-purple-400 via-fuchsia-300 to-cyan-300 bg-clip-text text-transparent drop-shadow-[0_0_12px_rgba(217,70,239,0.45)] transition-transform duration-150 ease-out"
        style={{ transform: `translateY(${Math.round((1 - pct / 100) * 6)}px)` }}
      >
        {pct}%
      </div>

      {/* Прогресс-бар */}
      <div className="w-48 h-1.5 rounded-full bg-white/10 overflow-hidden">
        <div
          className="h-full rounded-full bg-gradient-to-r from-purple-500 via-fuchsia-500 to-cyan-400 transition-[width] duration-150 ease-out"
          style={{ width: `${pct}%` }}
        />
      </div>

      {/* Поднимающийся эквалайзер — ощущение взлёта/энергии (без ракеты) */}
      <div className="flex items-end gap-[3px] h-4" aria-hidden>
        {[0, 0.15, 0.3, 0.45, 0.6].map((d, i) => (
          <span
            key={i}
            className="w-[3px] rounded-full equalizer-bar bg-gradient-to-t from-purple-500 via-fuchsia-400 to-cyan-300"
            style={{ animationDelay: `${d}s` }}
          />
        ))}
      </div>

      <p className="text-xs font-sans text-white/70 tracking-wide">Загружаем 3D…</p>
    </div>
  );
}
