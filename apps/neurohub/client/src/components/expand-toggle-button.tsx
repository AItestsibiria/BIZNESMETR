// Eugene 2026-05-16 Босс «добавить кнопку раскрыть (expand) на плееры везде».
// Стрелки по диагонали — Maximize2 (↖↘), при раскрытии — Minimize2 (↘↖).
// Reusable across landing/dashboard players.
// Touch-target ≥44px на mobile (sm:w-9 = 36px на desktop, w-11 = 44px на mobile).
import { Maximize2, Minimize2 } from "lucide-react";

interface ExpandToggleButtonProps {
  expanded: boolean;
  onToggle: () => void;
  /** Variant: light = white-on-dark cover overlay; dark = subtle on light surface. */
  variant?: "light" | "dark";
  /** Position class — caller controls placement (absolute usually). */
  className?: string;
  ariaLabelExpand?: string;
  ariaLabelCollapse?: string;
}

export function ExpandToggleButton({
  expanded,
  onToggle,
  variant = "light",
  className = "",
  ariaLabelExpand = "Раскрыть обложку",
  ariaLabelCollapse = "Свернуть обложку",
}: ExpandToggleButtonProps) {
  const colorClass =
    variant === "light"
      ? "bg-black/55 hover:bg-black/75 text-white border-white/20"
      : "bg-white/10 hover:bg-white/20 text-white/80 border-white/10";

  return (
    <button
      type="button"
      aria-label={expanded ? ariaLabelCollapse : ariaLabelExpand}
      title={expanded ? ariaLabelCollapse : ariaLabelExpand}
      onClick={(e) => {
        e.stopPropagation();
        onToggle();
      }}
      className={`w-11 h-11 sm:w-9 sm:h-9 rounded-full backdrop-blur-sm flex items-center justify-center border transition-all active:scale-95 shadow-lg ${colorClass} ${className}`}
      data-testid={expanded ? "button-collapse-cover" : "button-expand-cover"}
    >
      {expanded ? (
        <Minimize2 className="w-4 h-4 sm:w-4 sm:h-4" />
      ) : (
        <Maximize2 className="w-4 h-4 sm:w-4 sm:h-4" />
      )}
    </button>
  );
}
