// Surface — единая «поверхность» для cards/panels/inset-blocks.
// Eugene 2026-05-09: «всё в одном дизайнерском стиле».
//
// 3 уровня:
//   - "glass"  — крупная стеклянная карточка (backdrop-blur 40px, white/8 border, hover purple-glow)
//   - "card"   — средний блок с тонкой рамкой и subtle background
//   - "panel"  — inset-блок (без border, едва заметный фон) для группировки полей
//
// Использовать вместо разнобоя `bg-white/5`, `bg-white/[0.03]`, `bg-cyan-500/[0.06]`.

import * as React from "react";
import { cn } from "@/lib/utils";

type Variant = "glass" | "card" | "panel";

interface SurfaceProps extends React.HTMLAttributes<HTMLDivElement> {
  variant?: Variant;
  asChild?: boolean;
}

const VARIANT_CLS: Record<Variant, string> = {
  glass: cn(
    "backdrop-blur-[40px] backdrop-saturate-150",
    "bg-[rgba(18,18,22,0.72)]",
    "border border-white/[0.08]",
    "rounded-2xl",
    "shadow-[0_8px_32px_rgba(0,0,0,0.4)]",
    "hover:shadow-[0_8px_32px_rgba(139,92,246,0.15)]",
    "transition-shadow duration-300",
  ),
  card: cn(
    "bg-white/[0.04]",
    "border border-white/[0.08]",
    "rounded-xl",
    "backdrop-blur-md",
  ),
  panel: cn(
    "bg-white/[0.02]",
    "rounded-lg",
  ),
};

export const Surface = React.forwardRef<HTMLDivElement, SurfaceProps>(
  ({ variant = "card", className, children, ...props }, ref) => {
    return (
      <div ref={ref} className={cn(VARIANT_CLS[variant], className)} {...props}>
        {children}
      </div>
    );
  },
);
Surface.displayName = "Surface";
