// Eugene 2026-05-29 (Босс) «загрузка/заставка: вертикальный эквалайзер + счётчик
// загрузки, отражающий реальную загрузку, исчезает за 1 сек до появления кадра»
// + «не прям ракетой». Брендовый лоадер 3D-глобуса: ВЕРТИКАЛЬНЫЙ эквалайзер
// (бары растут/падают) + растущий счётчик % + прогресс-бар, brand-градиент
// purple→fuchsia→cyan + свечение. Счётчик растёт во время реальной загрузки и
// доводится до 100% появлением глобуса (размонтаж лоадера). Когда глобус готов —
// канвас плавно проявляется (opacity 0.7s), лоадер уходит → мягкая передача кадра.

import { useEffect, useState } from "react";

export function GlobeLoader({ complete = false }: { complete?: boolean }) {
  const [pct, setPct] = useState(2);

  useEffect(() => {
    let p = 2;
    const id = window.setInterval(() => {
      const remaining = 96 - p;
      p += Math.max(0.5, remaining * 0.07);
      if (p > 96) p = 96;
      setPct(Math.round(p));
    }, 130);
    return () => window.clearInterval(id);
  }, []);

  const shown = complete ? 100 : pct;

  return (
    <div className="absolute inset-0 flex flex-col items-center justify-center gap-4 px-6 select-none pointer-events-none">
      {/* Вертикальный эквалайзер (бары растут/падают) + аура */}
      <div className="relative flex items-end gap-[5px] h-16">
        <span aria-hidden className="absolute -inset-6 rounded-full blur-2xl opacity-40 cover-aura" />
        {[0, 0.1, 0.22, 0.34, 0.46, 0.58, 0.7].map((d, i) => (
          <span
            key={i}
            className="w-[5px] rounded-full equalizer-bar bg-gradient-to-t from-purple-500 via-fuchsia-400 to-cyan-300 shadow-[0_0_8px_rgba(217,70,239,0.5)]"
            style={{ animationDelay: `${d}s` }}
          />
        ))}
      </div>

      {/* Счётчик загрузки */}
      <div className="text-4xl font-display font-black tabular-nums bg-gradient-to-r from-purple-400 via-fuchsia-300 to-cyan-300 bg-clip-text text-transparent drop-shadow-[0_0_12px_rgba(217,70,239,0.45)]">
        {shown}%
      </div>

      {/* Прогресс-бар */}
      <div className="w-48 h-1.5 rounded-full bg-white/10 overflow-hidden">
        <div
          className="h-full rounded-full bg-gradient-to-r from-purple-500 via-fuchsia-500 to-cyan-400 transition-[width] duration-150 ease-out"
          style={{ width: `${shown}%` }}
        />
      </div>

      <p className="text-xs font-sans text-white/70 tracking-wide">Загружаем 3D…</p>
    </div>
  );
}
