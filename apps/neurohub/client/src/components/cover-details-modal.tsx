// Eugene 2026-05-16 Босс «добавить кнопку 🔍 Детали справа от Repeat —
// full-screen cover modal».
//
// Reusable across landing/dashboard/music players. Single click anywhere
// inside modal → closes (per ТЗ «при клике в любую точку → сворачивается»).
// Cover image занимает до 80% viewport (max-w-[80vw] max-h-[80vh]).
//
// Mobile-friendly: на узких экранах cover остаётся в пределах viewport,
// мета-блок (title/author/prompt/date) стэкается под обложкой.
//
// Escape ключ + клик по backdrop тоже закрывают.
import { useEffect } from "react";
import { X } from "lucide-react";

export interface CoverDetailsTrack {
  id: number | string;
  imageUrl?: string;
  displayTitle?: string | null;
  prompt?: string | null;
  authorName?: string | null;
  createdAt?: string | null;
  styleInfo?: string | null;
}

interface CoverDetailsModalProps {
  open: boolean;
  onClose: () => void;
  track: CoverDetailsTrack | null;
}

export function CoverDetailsModal({ open, onClose, track }: CoverDetailsModalProps) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    // Lock body scroll while open
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = prevOverflow;
    };
  }, [open, onClose]);

  if (!open || !track) return null;

  const title = track.displayTitle || (track.prompt || "").slice(0, 80) || "Без названия";
  const date = track.createdAt
    ? new Date(track.createdAt).toLocaleDateString("ru-RU", { day: "numeric", month: "long", year: "numeric" })
    : "";

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Детали обложки"
      onClick={onClose}
      className="fixed inset-0 z-[200] flex items-center justify-center bg-black/85 backdrop-blur-md animate-in fade-in duration-200 cursor-zoom-out"
      data-testid="cover-details-modal"
    >
      <button
        type="button"
        aria-label="Закрыть"
        onClick={(e) => { e.stopPropagation(); onClose(); }}
        className="absolute top-4 right-4 w-10 h-10 rounded-full bg-white/10 hover:bg-white/20 backdrop-blur-sm flex items-center justify-center transition-colors border border-white/15 z-10"
        data-testid="cover-details-close"
      >
        <X className="w-5 h-5 text-white" />
      </button>
      <div
        className="w-[80vw] max-w-[600px] flex flex-col items-center gap-4 px-4"
      >
        <div className="w-full aspect-square max-h-[80vh] rounded-2xl overflow-hidden bg-gradient-to-br from-purple-900/40 to-blue-900/40 shadow-2xl shadow-purple-500/20 border border-white/10">
          {track.imageUrl ? (
            <img
              src={track.imageUrl}
              alt={title}
              className="w-full h-full object-cover"
              onError={(e) => { (e.target as HTMLImageElement).style.display = "none"; }}
            />
          ) : (
            <div className="w-full h-full flex items-center justify-center text-white/30 text-6xl">
              ♪
            </div>
          )}
        </div>
        <div className="w-full text-center px-2 pb-4">
          <p className="text-xl sm:text-2xl font-bold text-white leading-tight">{title}</p>
          {track.authorName && (
            <p className="text-sm sm:text-base text-purple-300/90 mt-1.5 font-medium">{track.authorName}</p>
          )}
          {track.styleInfo && (
            <p className="text-xs sm:text-sm text-white/60 mt-2">{track.styleInfo}</p>
          )}
          {track.prompt && track.prompt !== title && (
            <p className="text-xs sm:text-sm text-white/50 mt-3 leading-relaxed max-h-32 overflow-y-auto">
              {track.prompt.slice(0, 240)}{track.prompt.length > 240 ? "…" : ""}
            </p>
          )}
          {date && (
            <p className="text-[11px] text-white/40 mt-3">{date}</p>
          )}
          <p className="text-[11px] text-white/40 mt-4 italic">Кликните в любую точку, чтобы закрыть</p>
        </div>
      </div>
    </div>
  );
}
