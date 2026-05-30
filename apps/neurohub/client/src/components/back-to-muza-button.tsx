// Eugene 2026-05-30 (Босс «кнопки в едином стиле»):
// Единый компонент кнопки «к Музе» — возврат на главную с плейлистом.
//
// Дефолтное действие (если onClick не передан): закрывает 3D-глобус через
// глобальное событие `muza:close-globe` (родитель ловит и делает setShowGlobe(false))
// + плавный скролл к секции плейлиста. Полностью переопределяемо через onClick.
//
// CLAUDE.md: Unified-back-share-buttons rule. Стиль — прозрачный контур
// (brand purple), lucide Undo2 (НЕ emoji ↩), adaptive sizing под устройство.

import { Undo2 } from "lucide-react";

export interface BackToMuzaButtonProps {
  /** Своё действие — если задано, дефолтный close+scroll НЕ выполняется. */
  onClick?: (e: React.MouseEvent<HTMLButtonElement>) => void;
  /** primary = крупнее на десктопе; compact = всегда минимальный размер. */
  variant?: "primary" | "compact";
  /** Дополнительные классы — складываются с базовыми. */
  className?: string;
  /** Текст рядом с иконкой (default — «Музе» с brand-gradient на «Музе»). */
  label?: React.ReactNode;
  /** Aria-label (default — «Вернуться к Музе»). */
  ariaLabel?: string;
  /** Title (default — «Свернуть 3D и вернуться к Музе»). */
  title?: string;
}

export function BackToMuzaButton({
  onClick,
  variant = "primary",
  className = "",
  label,
  ariaLabel = "Вернуться к Музе",
  title = "Свернуть 3D и вернуться к Музе",
}: BackToMuzaButtonProps) {
  const handleClick = (e: React.MouseEvent<HTMLButtonElement>) => {
    e.stopPropagation();
    if (onClick) {
      onClick(e);
      return;
    }
    // Дефолтное действие — глобальное событие закрытия 3D + scroll к плейлисту.
    try {
      window.dispatchEvent(new CustomEvent("muza:close-globe"));
    } catch {
      /* no-op */
    }
    window.setTimeout(() => {
      document.getElementById("playlist-section")?.scrollIntoView({
        behavior: "smooth",
        block: "start",
      });
    }, 100);
  };

  // Adaptive sizing — Босс 2026-05-30 «кнопки 3д под устройство в автомате».
  // iPhone SE ≤375: h-8/text-[10px]; mobile 376-639: h-9/text-[11px];
  // tablet+desktop ≥640: h-10/text-xs. Compact — без увеличения на md.
  const sizeClasses =
    variant === "compact"
      ? "h-8 px-2 text-[10px]"
      : "h-8 sm:h-9 md:h-10 px-2 sm:px-2.5 md:px-3 text-[10px] sm:text-[11px] md:text-xs";

  return (
    <button
      type="button"
      onClick={handleClick}
      className={`shrink-0 ${sizeClasses} rounded-full flex items-center justify-center gap-1.5 font-sans font-semibold whitespace-nowrap border bg-transparent text-white/85 border-purple-300/50 hover:border-purple-300/85 active:scale-95 transition-all ${className}`}
      aria-label={ariaLabel}
      title={title}
    >
      <Undo2 className="w-3.5 h-3.5 sm:w-4 sm:h-4 shrink-0" aria-hidden="true" />
      {label ?? (
        <>
          к{" "}
          <span className="font-display font-bold bg-gradient-to-r from-purple-300 via-fuchsia-300 to-cyan-300 bg-clip-text text-transparent">
            Музе
          </span>
        </>
      )}
    </button>
  );
}

export default BackToMuzaButton;
