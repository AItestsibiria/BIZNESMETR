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

  // Adaptive sizing — Босс 2026-05-30 «гармония кнопок 3D — заметно крупнее
  // на desktop, лучшее spacing». iPhone SE ≤375: h-9/text-[11px]; mobile
  // 376-639: h-10/text-xs; tablet ≥640: h-11/text-sm; desktop ≥1024:
  // h-12/text-base. Symmetry — flex-1 + max-w cap для парности с ShareMuzaButton.
  // Compact — без увеличения на md (для inline-bubbles в плеере и т.п.).
  const sizeClasses =
    variant === "compact"
      ? "h-8 px-2 text-[10px]"
      : "min-w-[88px] sm:min-w-[100px] md:min-w-[120px] lg:min-w-[140px] h-9 sm:h-10 md:h-11 lg:h-12 px-2.5 sm:px-3 md:px-4 lg:px-5 text-[11px] sm:text-xs md:text-sm lg:text-base";

  return (
    <button
      type="button"
      onClick={handleClick}
      className={`shrink-0 ${sizeClasses} rounded-full flex items-center justify-center gap-1.5 font-sans font-semibold whitespace-nowrap border bg-transparent text-white/85 border-white/25 hover:border-white/55 active:scale-95 transition-all ${className}`}
      aria-label={ariaLabel}
      title={title}
    >
      <Undo2 className="w-3.5 h-3.5 sm:w-4 sm:h-4 md:w-5 md:h-5 shrink-0" aria-hidden="true" />
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
