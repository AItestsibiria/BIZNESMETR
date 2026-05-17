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
//
// Eugene 2026-05-16 (вторая итерация) — нежный smooth swipe жест:
// • drag-x на обложке → swipe влево = onNext, swipe вправо = onPrev
// • dragConstraints + dragElastic дают мягкое сопротивление и spring back
// • AnimatePresence + key={track.id} → fade-in/out при смене трека
// • ArrowLeft / ArrowRight keyboard shortcuts (desktop)
// • Полупрозрачные стрелки `<` `>` по бокам как визуальный хинт
// • touch-action: pan-y на обложке — вертикальный scroll работает,
//   горизонтальный — drag
// • click anywhere → close сохраняется (drag имеет приоритет: dragged-флаг
//   подавляет close-click если был реальный свайп)
//
// Eugene 2026-05-17 Босс «обучающий swipe-hint»:
// • First-time overlay с пульсирующими стрелками + текстом «👆 Свайп для смены трека»
//   (fade-out через 3 сек ИЛИ при первом свайпе/клике-стрелке)
// • Info-кнопка «ⓘ» в углу — popover с инструкциями (ESC / click outside)
// • На mobile стрелки subtle wiggle ±3px каждые 4 сек (намёк на жест)
// • Desktop hover → стрелки scale-110, фирменный purple gradient
// • LocalStorage flag `cover-modal-hint-seen` — overlay показывается раз
import { useEffect, useRef, useState } from "react";
import { X, ChevronLeft, ChevronRight, Info } from "lucide-react";
import { motion, AnimatePresence, type PanInfo } from "framer-motion";

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
  onNext?: () => void;
  onPrev?: () => void;
}

const SWIPE_OFFSET_THRESHOLD = 80;
const SWIPE_VELOCITY_THRESHOLD = 500;
const HINT_STORAGE_KEY = "cover-modal-hint-seen";
const HINT_AUTO_HIDE_MS = 3000;

export function CoverDetailsModal({ open, onClose, track, onNext, onPrev }: CoverDetailsModalProps) {
  // dragDirection: 'left' | 'right' | null — для подсветки визуальных стрелок
  const [dragDirection, setDragDirection] = useState<"left" | "right" | null>(null);
  // didDragRef — флаг что был реальный swipe; используется чтобы
  // подавить «click anywhere → close» при выходе из drag-gesture
  const didDragRef = useRef(false);

  // Eugene 2026-05-17 — обучающий overlay при первом открытии modal.
  const [showHint, setShowHint] = useState(false);
  // Info-popover (отдельный от первого hint overlay).
  const [showInfo, setShowInfo] = useState(false);

  // Показываем hint только если localStorage flag отсутствует И есть навигация.
  useEffect(() => {
    if (!open) {
      setShowHint(false);
      setShowInfo(false);
      return;
    }
    if (!(onNext || onPrev)) return;
    try {
      if (!localStorage.getItem(HINT_STORAGE_KEY)) {
        setShowHint(true);
        const t = window.setTimeout(() => {
          setShowHint(false);
          try { localStorage.setItem(HINT_STORAGE_KEY, "1"); } catch {}
        }, HINT_AUTO_HIDE_MS);
        return () => window.clearTimeout(t);
      }
    } catch {}
  }, [open, onNext, onPrev]);

  // Гасит hint overlay (вызывается при первом swipe / click стрелки).
  const dismissHint = () => {
    if (!showHint) return;
    setShowHint(false);
    try { localStorage.setItem(HINT_STORAGE_KEY, "1"); } catch {}
  };

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        // ESC сначала закрывает info-popover, потом modal.
        if (showInfo) { setShowInfo(false); return; }
        onClose();
      }
      else if (e.key === "ArrowLeft" && onPrev) {
        e.preventDefault();
        dismissHint();
        onPrev();
      } else if (e.key === "ArrowRight" && onNext) {
        e.preventDefault();
        dismissHint();
        onNext();
      }
    };
    document.addEventListener("keydown", onKey);
    // Lock body scroll while open
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = prevOverflow;
    };
  }, [open, onClose, onNext, onPrev, showInfo, showHint]);

  if (!open || !track) return null;

  const title = track.displayTitle || (track.prompt || "").slice(0, 80) || "Без названия";
  const date = track.createdAt
    ? new Date(track.createdAt).toLocaleDateString("ru-RU", { day: "numeric", month: "long", year: "numeric" })
    : "";

  const handleDrag = (_: unknown, info: PanInfo) => {
    if (info.offset.x > 12) setDragDirection("right");
    else if (info.offset.x < -12) setDragDirection("left");
    else setDragDirection(null);
  };

  const handleDragEnd = (_: unknown, info: PanInfo) => {
    setDragDirection(null);
    const passedOffset = Math.abs(info.offset.x) > SWIPE_OFFSET_THRESHOLD;
    const passedVelocity = Math.abs(info.velocity.x) > SWIPE_VELOCITY_THRESHOLD;
    if (passedOffset || passedVelocity) {
      didDragRef.current = true;
      // Юзер сделал реальный swipe — гасим hint раньше срока.
      dismissHint();
      // Reset flag shortly after — click event фиксится после dragEnd
      setTimeout(() => { didDragRef.current = false; }, 300);
      if (info.offset.x < 0 || info.velocity.x < 0) {
        onNext?.();
      } else {
        onPrev?.();
      }
    } else if (Math.abs(info.offset.x) > 8) {
      // Был жест но не достиг порога — всё равно подавляем click
      didDragRef.current = true;
      setTimeout(() => { didDragRef.current = false; }, 200);
    }
  };

  const handleBackdropClick = () => {
    if (didDragRef.current) return;
    // Если открыт info-popover — клик в backdrop сначала закрывает его.
    if (showInfo) { setShowInfo(false); return; }
    onClose();
  };

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Детали обложки"
      onClick={handleBackdropClick}
      className="fixed inset-0 z-[200] flex items-center justify-center bg-black/85 backdrop-blur-md animate-in fade-in duration-200 cursor-zoom-out"
      data-testid="cover-details-modal"
    >
      {/* Info button — рядом с close */}
      <button
        type="button"
        aria-label="Подсказка по управлению"
        onClick={(e) => { e.stopPropagation(); setShowInfo(v => !v); }}
        className="absolute top-4 right-16 w-10 h-10 rounded-full bg-white/10 hover:bg-white/20 backdrop-blur-sm flex items-center justify-center transition-colors border border-white/15 z-10"
        data-testid="cover-details-info"
      >
        <Info className="w-5 h-5 text-white" />
      </button>

      <button
        type="button"
        aria-label="Закрыть"
        onClick={(e) => { e.stopPropagation(); onClose(); }}
        className="absolute top-4 right-4 w-10 h-10 rounded-full bg-white/10 hover:bg-white/20 backdrop-blur-sm flex items-center justify-center transition-colors border border-white/15 z-10"
        data-testid="cover-details-close"
      >
        <X className="w-5 h-5 text-white" />
      </button>

      {/* Info-popover (показывается при click на ⓘ) — glass-card, dark, fade-in */}
      {showInfo && (
        <div
          onClick={(e) => e.stopPropagation()}
          className="absolute top-16 right-4 z-20 w-[280px] sm:w-[320px] glass-card rounded-2xl p-4 border border-purple-500/30 shadow-2xl shadow-purple-500/20 animate-in fade-in slide-in-from-top-2 duration-200"
          data-testid="cover-details-info-popover"
        >
          <p className="text-sm font-bold text-white mb-3">Как управлять</p>
          <ul className="space-y-2 text-xs text-white/80">
            <li className="flex items-start gap-2">
              <span className="text-base leading-none">👆</span>
              <span>Свайп <span className="text-purple-300 font-medium">← →</span> или стрелки клавиатуры — смена трека</span>
            </li>
            <li className="flex items-start gap-2">
              <span className="text-base leading-none">👆</span>
              <span>Клик в любое место — <span className="text-purple-300 font-medium">закрыть</span></span>
            </li>
            <li className="flex items-start gap-2">
              <span className="text-base leading-none">⌨️</span>
              <span><span className="text-purple-300 font-medium">Esc</span> — выйти из режима</span>
            </li>
          </ul>
          <button
            type="button"
            onClick={() => setShowInfo(false)}
            className="mt-3 w-full py-1.5 rounded-lg bg-purple-500/20 hover:bg-purple-500/30 text-purple-200 text-xs font-medium transition-colors"
          >
            Понятно
          </button>
        </div>
      )}

      <div className="w-[80vw] max-w-[600px] flex flex-col items-center gap-4 px-4 relative">
        {/* Левая стрелка-хинт (показывается если есть onPrev) */}
        {onPrev && (
          <button
            type="button"
            aria-label="Предыдущий трек"
            onClick={(e) => { e.stopPropagation(); dismissHint(); onPrev(); }}
            className={`hidden sm:flex absolute left-[-56px] top-1/2 -translate-y-1/2 w-12 h-12 rounded-full items-center justify-center transition-all z-10 ${
              dragDirection === "right"
                ? "bg-gradient-to-br from-purple-500/60 to-cyan-500/40 border border-purple-400/60 scale-110 text-white shadow-lg shadow-purple-500/30"
                : "bg-white/5 border border-white/10 text-white/40 hover:bg-gradient-to-br hover:from-purple-500/40 hover:to-cyan-500/30 hover:text-white hover:scale-110 hover:border-purple-400/40"
            }`}
            data-testid="cover-details-prev"
          >
            <ChevronLeft className="w-7 h-7" />
          </button>
        )}

        {/* Правая стрелка-хинт (показывается если есть onNext) */}
        {onNext && (
          <button
            type="button"
            aria-label="Следующий трек"
            onClick={(e) => { e.stopPropagation(); dismissHint(); onNext(); }}
            className={`hidden sm:flex absolute right-[-56px] top-1/2 -translate-y-1/2 w-12 h-12 rounded-full items-center justify-center transition-all z-10 ${
              dragDirection === "left"
                ? "bg-gradient-to-br from-purple-500/60 to-cyan-500/40 border border-purple-400/60 scale-110 text-white shadow-lg shadow-purple-500/30"
                : "bg-white/5 border border-white/10 text-white/40 hover:bg-gradient-to-br hover:from-purple-500/40 hover:to-cyan-500/30 hover:text-white hover:scale-110 hover:border-purple-400/40"
            }`}
            data-testid="cover-details-next"
          >
            <ChevronRight className="w-7 h-7" />
          </button>
        )}

        {/* Обложка с swipe-жестом */}
        <div
          className="w-full aspect-square max-h-[80vh] rounded-2xl overflow-hidden bg-gradient-to-br from-purple-900/40 to-blue-900/40 shadow-2xl shadow-purple-500/20 border border-white/10 relative"
          onClick={(e) => e.stopPropagation()}
        >
          <AnimatePresence mode="wait" initial={false}>
            <motion.div
              key={track.id}
              drag={(onNext || onPrev) ? "x" : false}
              dragConstraints={{ left: -80, right: 80 }}
              dragElastic={0.3}
              dragMomentum={false}
              onDrag={handleDrag}
              onDragEnd={handleDragEnd}
              initial={{ opacity: 0, scale: 0.98 }}
              animate={{ opacity: 1, scale: 1 }}
              exit={{ opacity: 0, scale: 0.98 }}
              transition={{ duration: 0.25, ease: "easeOut" }}
              whileTap={{ cursor: "grabbing" }}
              className="w-full h-full select-none"
              style={{ touchAction: "pan-y", cursor: (onNext || onPrev) ? "grab" : "default" }}
              data-testid="cover-details-image-wrap"
            >
              {track.imageUrl ? (
                <img
                  src={track.imageUrl}
                  alt={title}
                  draggable={false}
                  className="w-full h-full object-cover pointer-events-none"
                  onError={(e) => { (e.target as HTMLImageElement).style.display = "none"; }}
                />
              ) : (
                <div className="w-full h-full flex items-center justify-center text-white/30 text-6xl">
                  ♪
                </div>
              )}
            </motion.div>
          </AnimatePresence>

          {/* Mobile-only inline arrow hints (на узких экранах нет места снаружи).
              Показываются всегда (subtle wiggle) — намёк на жест. На active drag —
              усиливаются. */}
          {(onPrev || onNext) && (
            <>
              {onPrev && (
                <div
                  className={`sm:hidden absolute left-2 top-1/2 -translate-y-1/2 w-9 h-9 rounded-full border flex items-center justify-center pointer-events-none transition-all ${
                    dragDirection === "right"
                      ? "bg-gradient-to-br from-purple-500/60 to-cyan-500/40 border-purple-400/70 scale-110"
                      : "bg-black/30 border-white/15 cover-arrow-wiggle-left"
                  }`}
                >
                  <ChevronLeft className={`w-5 h-5 ${dragDirection === "right" ? "text-white" : "text-white/60"}`} />
                </div>
              )}
              {onNext && (
                <div
                  className={`sm:hidden absolute right-2 top-1/2 -translate-y-1/2 w-9 h-9 rounded-full border flex items-center justify-center pointer-events-none transition-all ${
                    dragDirection === "left"
                      ? "bg-gradient-to-br from-purple-500/60 to-cyan-500/40 border-purple-400/70 scale-110"
                      : "bg-black/30 border-white/15 cover-arrow-wiggle-right"
                  }`}
                >
                  <ChevronRight className={`w-5 h-5 ${dragDirection === "left" ? "text-white" : "text-white/60"}`} />
                </div>
              )}
            </>
          )}

          {/* First-time hint overlay — пульсирующие стрелки + поясняющий текст.
              Появляется при первом открытии modal (нет localStorage flag).
              fade-out через 3 сек ИЛИ при первом swipe/click на стрелку. */}
          {showHint && (onPrev || onNext) && (
            <div
              className="absolute inset-0 z-[5] flex items-center justify-between px-4 pointer-events-none animate-in fade-in duration-300"
              data-testid="cover-details-hint-overlay"
            >
              <div className={`flex flex-col items-center gap-2 ${onPrev ? "opacity-100" : "opacity-0"}`}>
                <div className="w-16 h-16 rounded-full bg-gradient-to-br from-purple-500/60 to-cyan-500/50 border-2 border-white/40 flex items-center justify-center shadow-2xl cover-hint-pulse">
                  <ChevronLeft className="w-9 h-9 text-white drop-shadow-lg" />
                </div>
              </div>
              <div className={`flex flex-col items-center gap-2 ${onNext ? "opacity-100" : "opacity-0"}`}>
                <div className="w-16 h-16 rounded-full bg-gradient-to-br from-purple-500/60 to-cyan-500/50 border-2 border-white/40 flex items-center justify-center shadow-2xl cover-hint-pulse">
                  <ChevronRight className="w-9 h-9 text-white drop-shadow-lg" />
                </div>
              </div>
              <div className="absolute bottom-6 left-1/2 -translate-x-1/2 px-4 py-2 rounded-full bg-black/70 backdrop-blur-md border border-white/20 shadow-2xl">
                <p className="text-sm text-white font-medium whitespace-nowrap">
                  <span className="text-lg">👆</span> Свайп для смены трека
                </p>
              </div>
            </div>
          )}
        </div>

        <div className="w-full text-center px-2 pb-4" onClick={(e) => e.stopPropagation()}>
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
          <p className="text-[11px] text-white/40 mt-4 italic">
            {(onNext || onPrev)
              ? "Свайп ← → или стрелки клавиатуры. Кликните вне обложки, чтобы закрыть"
              : "Кликните в любую точку, чтобы закрыть"}
          </p>
        </div>
      </div>
    </div>
  );
}
