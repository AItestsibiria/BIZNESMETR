// CosmicCloseButton — единая «космическая» закрывающая кнопка.
// Eugene 2026-05-09: «все крестики в квадрате — заменить на красивые
// космические кнопки, всё в одном дизайнерском стиле».
//
// Применяется в dialog, sheet, toast, navbar mobile-toggle.
// Внутри — иконка X с rotate-90 на hover, glow-shadow, magic-pulse ring.

import * as React from "react";
import { X } from "lucide-react";
import { cn } from "@/lib/utils";

type Size = "sm" | "md" | "lg";

interface CosmicCloseButtonProps
  extends Omit<React.ButtonHTMLAttributes<HTMLButtonElement>, "type"> {
  size?: Size;
  asChild?: boolean;
  ariaLabel?: string;
}

const SIZE_CLS: Record<Size, string> = {
  sm: "w-6 h-6 [&_svg]:w-3 [&_svg]:h-3",
  md: "w-8 h-8 [&_svg]:w-4 [&_svg]:h-4",
  lg: "w-10 h-10 [&_svg]:w-5 [&_svg]:h-5",
};

export const CosmicCloseButton = React.forwardRef<HTMLButtonElement, CosmicCloseButtonProps>(
  ({ size = "md", className, ariaLabel = "Закрыть", ...props }, ref) => {
    return (
      <button
        ref={ref}
        type="button"
        aria-label={ariaLabel}
        data-testid="cosmic-close"
        className={cn(
          "group relative inline-flex items-center justify-center rounded-full",
          "bg-gradient-to-br from-purple-500/20 to-cyan-500/15",
          "border border-white/15 backdrop-blur-md",
          "transition-all duration-200",
          "hover:from-purple-500/40 hover:to-cyan-500/30",
          "hover:border-cyan-400/60",
          "hover:shadow-[0_0_20px_rgba(34,211,238,0.4),0_0_40px_rgba(139,92,246,0.25)]",
          "active:scale-90",
          "focus:outline-none focus-visible:ring-2 focus-visible:ring-cyan-400/60 focus-visible:ring-offset-2 focus-visible:ring-offset-background",
          "disabled:opacity-40 disabled:pointer-events-none",
          SIZE_CLS[size],
          className,
        )}
        {...props}
      >
        <X className="text-white/70 group-hover:text-white group-hover:rotate-90 transition-all duration-300" />
        {/* magic-pulse ring on hover */}
        <span className="absolute inset-0 rounded-full opacity-0 group-hover:opacity-100 ring-2 ring-cyan-400/30 animate-ping pointer-events-none" />
      </button>
    );
  },
);
CosmicCloseButton.displayName = "CosmicCloseButton";
