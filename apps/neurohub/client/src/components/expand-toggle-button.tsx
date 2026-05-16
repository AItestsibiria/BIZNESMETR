// Eugene 2026-05-16 Босс «добавить кнопку раскрыть (expand) на плееры везде».
// Стрелки по диагонали — Maximize2 (↖↘), при раскрытии — Minimize2 (↘↖).
// Reusable across landing/dashboard players.
//
// Eugene 2026-05-16 update: «на смартфоне возвращаем в предыдущее значение» —
// кнопка только для desktop (md+). На mobile скрыта через `hidden md:flex` →
// layout остаётся compact row-flex (как до introducing expand). Это решает
// ситуацию когда на узком экране expanded-cover занимает всю высоту и
// неудобно прокручивать к controls.
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
      className={`hidden md:flex w-9 h-9 rounded-full backdrop-blur-sm items-center justify-center border transition-all active:scale-95 shadow-lg ${colorClass} ${className}`}
      data-testid={expanded ? "button-collapse-cover" : "button-expand-cover"}
    >
      {expanded ? (
        <Minimize2 className="w-4 h-4" />
      ) : (
        <Maximize2 className="w-4 h-4" />
      )}
    </button>
  );
}
