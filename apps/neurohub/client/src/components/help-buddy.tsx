// HelpBuddy — единый «человечек-помощник» на сайте.
// Маленькая круглая кнопка с эмодзи-лицом 🧑‍🎤. По клику — popover с
// объяснением: title + список секций или произвольный children.
//
// ТЗ Eugene 2026-05-07: «пусть везде она будет где необходимо по смыслу
// объяснять что к чему, пусть это будет в форме человечка».

import type { ReactNode } from "react";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";

type Variant = "violet" | "cyan" | "amber" | "rose" | "emerald";

interface HelpBuddySection {
  icon?: ReactNode;
  color?: string;       // tailwind text-color class, например "text-cyan-300"
  label: string;
  text: ReactNode;
}

interface HelpBuddyProps {
  title?: string;
  sections?: HelpBuddySection[];
  children?: ReactNode;             // произвольный контент вместо sections
  variant?: Variant;                // цвет кнопки
  size?: "sm" | "md";
  align?: "start" | "center" | "end";
  className?: string;
  ariaLabel?: string;
  emoji?: string;                   // override эмодзи (default 🧑‍🎤)
}

const VARIANT_CLS: Record<Variant, string> = {
  violet: "from-violet-500/40 to-purple-500/40 border-violet-400/60 hover:shadow-[0_0_18px_rgba(167,139,250,0.5)]",
  cyan:   "from-cyan-500/40 to-blue-500/40 border-cyan-400/60 hover:shadow-[0_0_18px_rgba(34,211,238,0.5)]",
  amber:  "from-amber-500/40 to-orange-500/40 border-amber-400/60 hover:shadow-[0_0_18px_rgba(251,191,36,0.5)]",
  rose:   "from-rose-500/40 to-pink-500/40 border-rose-400/60 hover:shadow-[0_0_18px_rgba(251,113,133,0.5)]",
  emerald:"from-emerald-500/40 to-teal-500/40 border-emerald-400/60 hover:shadow-[0_0_18px_rgba(52,211,153,0.5)]",
};

export function HelpBuddy({
  title,
  sections,
  children,
  variant = "violet",
  size = "md",
  align = "end",
  className = "",
  ariaLabel = "Подсказка",
  emoji = "🧑‍💼",
}: HelpBuddyProps) {
  const s = size === "sm" ? "w-7 h-7 text-sm" : "w-9 h-9 text-base";
  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label={ariaLabel}
          data-testid="help-buddy"
          className={`${s} relative inline-flex items-center justify-center rounded-full bg-gradient-to-br ${VARIANT_CLS[variant]} border backdrop-blur cursor-pointer transition-all hover:scale-105 active:scale-95 ${className}`}
        >
          <span className="block leading-none select-none">{emoji}</span>
          {/* speech-bubble pulse — обращает внимание */}
          <span className="absolute -top-0.5 -right-0.5 w-2.5 h-2.5 rounded-full bg-cyan-400 animate-ping opacity-60" />
          <span className="absolute -top-0.5 -right-0.5 w-2.5 h-2.5 rounded-full bg-cyan-400/80" />
        </button>
      </PopoverTrigger>
      <PopoverContent
        align={align}
        className="w-[320px] sm:w-[380px] bg-background/95 backdrop-blur border border-white/10 p-4 space-y-3 text-sm shadow-xl"
      >
        {title && <div className="font-semibold text-white text-base">{title}</div>}
        {sections && sections.map((sec, i) => (
          <div key={i} className="flex gap-2.5">
            {sec.icon && <div className={`${sec.color ?? "text-violet-300"} shrink-0 mt-0.5 [&_svg]:w-5 [&_svg]:h-5`}>{sec.icon}</div>}
            <div className="min-w-0">
              <div className={`font-medium ${sec.color ?? "text-violet-300"}`}>{sec.label}</div>
              <div className="text-xs text-muted-foreground leading-relaxed">{sec.text}</div>
            </div>
          </div>
        ))}
        {children}
      </PopoverContent>
    </Popover>
  );
}
