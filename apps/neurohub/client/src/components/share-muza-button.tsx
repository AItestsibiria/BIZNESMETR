// Eugene 2026-05-30 (Босс «кнопки в едином стиле»):
// Единый компонент кнопки «Поделись Музой» — Web Share API + clipboard fallback.
//
// Default url = `${origin}/?globecard=1`, default title = «MuzaAi — Мир Музыки
// без границ», text = «Нас слушают по всему миру 🌍 Твоя Муза».
//
// CLAUDE.md: Unified-back-share-buttons rule. Стиль — прозрачный контур
// (brand fuchsia), lucide Share2 (НЕ emoji 📤), adaptive sizing под устройство.

import { Share2 } from "lucide-react";
import { useToast } from "@/hooks/use-toast";

export interface ShareMuzaButtonProps {
  /** URL для шеринга (default — `${window.location.origin}/?globecard=1`). */
  url?: string;
  /** Заголовок в Web Share API. */
  title?: string;
  /** Текст в Web Share API. */
  text?: string;
  /** primary = крупнее на десктопе; compact = всегда минимальный размер. */
  variant?: "primary" | "compact";
  /** Дополнительные классы. */
  className?: string;
  /** Label рядом с иконкой. */
  label?: React.ReactNode;
  /** Aria-label. */
  ariaLabel?: string;
  /** Title. */
  titleAttr?: string;
}

export function ShareMuzaButton({
  url,
  title = "MuzaAi — Мир Музыки без границ",
  text = "Нас слушают по всему миру 🌍 Твоя Муза",
  variant = "primary",
  className = "",
  label,
  ariaLabel = "Поделись Музой",
  titleAttr = "Поделись ссылкой на MuzaAi",
}: ShareMuzaButtonProps) {
  const { toast } = useToast();

  const handleClick = async (e: React.MouseEvent<HTMLButtonElement>) => {
    e.stopPropagation();
    const shareUrl =
      url ??
      (typeof window !== "undefined"
        ? `${window.location.origin}/?globecard=1`
        : "https://muzaai.ru/?globecard=1");
    const shareData: ShareData = { title, text, url: shareUrl };
    try {
      if (typeof navigator !== "undefined" && navigator.share) {
        await navigator.share(shareData);
        return;
      }
    } catch {
      /* юзер отменил шеринг — это норма */
    }
    try {
      if (typeof navigator !== "undefined" && navigator.clipboard) {
        await navigator.clipboard.writeText(shareUrl);
        toast({
          title: "Ссылка скопирована",
          description: "Поделись Музой 💜",
        });
      }
    } catch {
      /* no-op */
    }
  };

  // Босс 2026-05-30 «гармония кнопок 3D» — symmetry с BackToMuzaButton
  // (одинаковый sizing + flex-1 + max-w для парности на широких).
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
      title={titleAttr}
    >
      <Share2 className="w-3.5 h-3.5 sm:w-4 sm:h-4 md:w-5 md:h-5 shrink-0" aria-hidden="true" />
      {label ?? (
        <span className="font-display font-bold bg-gradient-to-r from-purple-300 via-fuchsia-300 to-cyan-300 bg-clip-text text-transparent">
          Музой
        </span>
      )}
    </button>
  );
}

export default ShareMuzaButton;
