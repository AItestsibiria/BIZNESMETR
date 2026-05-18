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
//
// Eugene 2026-05-17 Босс «фирменный стиль MuzaAi» (Brand-style consistency):
// • Container растянут: w-[90vw] max-w-[900px] / sm:max-w-[1100px]
// • Cover больше: aspect-square max-h-[85vh]
// • Title крупнее + font-display + gradient-text (purple→blue)
// • Body text увеличен (text-base / text-lg)
// • Фон deep-space с violet tint + brand-border + brand-glow
// • Стрелки 14×14 с brand gradient hover-glow (purple/cyan)
//
// Eugene 2026-05-17 Босс «в раскрытой обложке — полный набор управления плеером»:
// • Под обложкой — glass-card controls bar с play/pause/skip/seek/volume/repeat
// • Аудио-элемент остаётся в родителе (landing/dashboard) — не remount
// • State синхронизирован через props/callbacks; при закрытии modal playback
//   продолжается; при повторном открытии — текущее состояние видно
// • Mobile-friendly: touch-targets ≥44px, controls bar full-width
import { useEffect, useRef, useState } from "react";
import { X, ChevronLeft, ChevronRight, Info, Play, Pause, SkipBack, SkipForward, Repeat, Repeat1 } from "lucide-react";
import { motion, AnimatePresence, type PanInfo } from "framer-motion";
import { VolumeSlider } from "./volume-slider";

export interface CoverDetailsTrack {
  id: number | string;
  imageUrl?: string;
  // Eugene 2026-05-18 Босс «подсветка обложки во всех режимах».
  hasCustomCover?: boolean;
  coverGenId?: number | null;
  displayTitle?: string | null;
  prompt?: string | null;
  authorName?: string | null;
  createdAt?: string | null;
  // Eugene 2026-05-17 Босс «публикация — другое событие, не дата генерации».
  // Если есть publishedAt — показываем его как «Опубликовано N»; иначе
  // fallback на createdAt с лейблом «Создано».
  publishedAt?: string | null;
  styleInfo?: string | null;
}

interface CoverDetailsModalProps {
  open: boolean;
  onClose: () => void;
  track: CoverDetailsTrack | null;
  onNext?: () => void;
  onPrev?: () => void;
  // Eugene 2026-05-17 — расширенные controls (play/pause/seek/volume/repeat).
  // Все опциональны: если callback не передан — соответствующая кнопка скрывается.
  isPlaying?: boolean;
  onPlayPause?: () => void;
  currentTime?: number;     // seconds
  duration?: number;        // seconds
  onSeek?: (sec: number) => void;
  volume?: number;          // 0..1
  onVolumeChange?: (v: number) => void;
  repeatMode?: "off" | "one" | "all";
  onRepeatToggle?: () => void;
}

// Утилита mm:ss форматтер для seek-bar timestamps.
function formatTime(sec: number): string {
  if (!isFinite(sec) || sec < 0) return "0:00";
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${s.toString().padStart(2, "0")}`;
}

const SWIPE_OFFSET_THRESHOLD = 80;
const SWIPE_VELOCITY_THRESHOLD = 500;
const HINT_STORAGE_KEY = "cover-modal-hint-seen";
const HINT_AUTO_HIDE_MS = 3000;

export function CoverDetailsModal({
  open,
  onClose,
  track,
  onNext,
  onPrev,
  isPlaying,
  onPlayPause,
  currentTime,
  duration,
  onSeek,
  volume,
  onVolumeChange,
  repeatMode,
  onRepeatToggle,
}: CoverDetailsModalProps) {
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
  // Eugene 2026-05-17 Босс: показываем дату ПУБЛИКАЦИИ (когда трек появился
  // в плейлисте) с лейблом «Опубликовано». Fallback на дату генерации с
  // лейблом «Создано» (для приватных черновиков publishedAt = NULL).
  const dateSource = track.publishedAt || track.createdAt;
  const dateLabel = track.publishedAt ? "Опубликовано" : "Создано";
  const date = dateSource
    ? new Date(dateSource).toLocaleDateString("ru-RU", { day: "numeric", month: "long", year: "numeric" })
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
      className="fixed inset-0 z-[200] flex items-center justify-center bg-gradient-to-br from-[#0a0a17]/95 via-[#1a0f2e]/95 to-[#0a0a17]/95 backdrop-blur-xl animate-in fade-in duration-200 cursor-zoom-out"
      data-testid="cover-details-modal"
    >
      {/* Eugene 2026-05-17 — hi-tech holographic overlay поверх backdrop
          (subtle 12-сек shimmer 3 brand-color, pointer-events-none чтобы
          не блокировать клики). */}
      <div
        className="absolute inset-0 holographic pointer-events-none"
        aria-hidden="true"
      />
      {/* Eugene 2026-05-17 Босс «на большой обложке тоже S» — bomb-цвет S кнопка.
          Подсказка о swipe-режиме, при click тоже toggle info popover. */}
      <button
        type="button"
        aria-label="Свайп-режим (S)"
        onClick={(e) => { e.stopPropagation(); setShowInfo(v => !v); }}
        className="absolute top-4 right-28 w-10 h-10 rounded-full bg-gradient-to-br from-purple-500 via-fuchsia-500 to-cyan-400 hover:from-purple-400 hover:via-fuchsia-400 hover:to-cyan-300 flex items-center justify-center text-white font-display font-bold text-lg transition-all shadow-[0_0_24px_rgba(217,70,239,0.6)] hover:shadow-[0_0_36px_rgba(217,70,239,0.85)] hover:scale-110 active:scale-95 border border-fuchsia-300/50 animate-details-pulse z-10"
        data-testid="cover-details-swipe-s"
      >
        <span className="drop-shadow-[0_0_8px_rgba(255,255,255,0.9)]">S</span>
      </button>

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

      {/* Eugene 2026-05-18 Босс «не вижу S в раскрытой обложке» — кликабельная
          кнопка с лёгким bg + border + glow для visibility. Click закрывает
          modal (как S «вернись из swipe»). */}
      <button
        type="button"
        aria-label="Закрыть свайп-режим"
        title="Закрыть свайп-режим"
        onClick={(e) => { e.stopPropagation(); onClose(); }}
        className="absolute bottom-4 right-4 w-14 h-14 rounded-full bg-black/40 backdrop-blur-sm border border-white/20 hover:border-fuchsia-400/60 hover:bg-black/60 flex items-center justify-center transition-all hover:scale-110 active:scale-95 z-50"
        data-testid="cover-details-s-bottom-right"
      >
        <span className="font-display font-bold italic text-3xl tracking-wider text-white drop-shadow-[0_0_10px_rgba(255,255,255,0.95)] drop-shadow-[0_0_20px_rgba(217,70,239,0.9)]">S</span>
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

      {/* Eugene 2026-05-18 Босс «уменьши в свайпе» — compact 60% экрана.
          Было w-[90vw] max-w-[1100px] (слишком огромная на iPad).
          Стало max-w-2xl (~672px) — элегантно, не закрывает фоном весь экран. */}
      <div className="w-[80vw] max-w-2xl flex flex-col items-center gap-2 px-4 relative">
        {/* Левая стрелка-хинт (показывается если есть onPrev) */}
        {onPrev && (
          <button
            type="button"
            aria-label="Предыдущий трек"
            onClick={(e) => { e.stopPropagation(); dismissHint(); onPrev(); }}
            className={`hidden sm:flex absolute left-[-72px] top-1/2 -translate-y-1/2 w-14 h-14 rounded-full items-center justify-center transition-all z-10 ${
              dragDirection === "right"
                ? "bg-gradient-to-br from-purple-500 via-fuchsia-500/80 to-cyan-500/70 border border-purple-300/70 scale-110 text-white shadow-[0_0_32px_rgba(124,58,237,0.6)]"
                : "bg-white/5 border border-purple-400/20 text-white/50 hover:bg-gradient-to-br hover:from-purple-500/60 hover:via-fuchsia-500/50 hover:to-cyan-500/40 hover:text-white hover:scale-110 hover:border-purple-400/60 hover:shadow-[0_0_32px_rgba(124,58,237,0.5)]"
            }`}
            data-testid="cover-details-prev"
          >
            <ChevronLeft className="w-8 h-8" />
          </button>
        )}

        {/* Правая стрелка-хинт (показывается если есть onNext) */}
        {onNext && (
          <button
            type="button"
            aria-label="Следующий трек"
            onClick={(e) => { e.stopPropagation(); dismissHint(); onNext(); }}
            className={`hidden sm:flex absolute right-[-72px] top-1/2 -translate-y-1/2 w-14 h-14 rounded-full items-center justify-center transition-all z-10 ${
              dragDirection === "left"
                ? "bg-gradient-to-br from-purple-500 via-fuchsia-500/80 to-cyan-500/70 border border-purple-300/70 scale-110 text-white shadow-[0_0_32px_rgba(124,58,237,0.6)]"
                : "bg-white/5 border border-purple-400/20 text-white/50 hover:bg-gradient-to-br hover:from-purple-500/60 hover:via-fuchsia-500/50 hover:to-cyan-500/40 hover:text-white hover:scale-110 hover:border-purple-400/60 hover:shadow-[0_0_32px_rgba(124,58,237,0.5)]"
            }`}
            data-testid="cover-details-next"
          >
            <ChevronRight className="w-8 h-8" />
          </button>
        )}

        {/* Eugene 2026-05-17 Босс «бутират свет вокруг обложки в фирменных
            цветах пусть переливаются». Brand aura wrap — animated conic
            gradient (purple→fuchsia→cyan→amber) + blur + spin + opacity pulse.
            Обложка остаётся резкой внутри. */}
        <div className="relative w-full">
          <div
            aria-hidden="true"
            className="absolute -inset-4 sm:-inset-6 rounded-3xl opacity-80 blur-3xl pointer-events-none cover-aura"
          />
        {/* Обложка с swipe-жестом */}
        <div
          className="relative w-full aspect-square max-h-[85vh] rounded-3xl overflow-hidden bg-gradient-to-br from-[#1a0f2e] via-[#0a0a17] to-[#0f1830] shadow-[0_0_64px_rgba(124,58,237,0.25)] border border-purple-500/20"
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
                  className={`w-full h-full object-cover pointer-events-none ${
                    (track.hasCustomCover || track.coverGenId)
                      ? "ring-4 ring-fuchsia-400/30 shadow-[0_0_40px_rgba(217,70,239,0.3)]"
                      : ""
                  }`}
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
              {/* Eugene 2026-05-18 Босс «убери лишнее» — text-overlay убран,
                  стрелки сами по себе достаточно понятный hint. */}
            </div>
          )}
        </div>
        </div>

        {/* Eugene 2026-05-17 — controls bar (play/pause/skip/seek/volume/repeat).
            Glass-card под обложкой. Touch-targets ≥44px, full-width on mobile. */}
        {(onPlayPause || onSeek || onVolumeChange || onRepeatToggle) && (
          <div
            className="w-full glass-card rounded-2xl border border-purple-500/20 p-4 sm:p-5 shadow-[0_0_32px_rgba(124,58,237,0.18)]"
            onClick={(e) => e.stopPropagation()}
            data-testid="cover-details-controls-bar"
          >
            {/* Seek bar — full width, фирменный purple→cyan gradient.
                Видна только если есть onSeek и duration. */}
            {onSeek && typeof duration === "number" && duration > 0 && (
              <div className="w-full mb-3">
                <div
                  className="relative w-full h-5 flex items-center cursor-pointer group"
                  onClick={(e) => {
                    const rect = e.currentTarget.getBoundingClientRect();
                    const pct = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
                    onSeek(pct * duration);
                  }}
                  data-testid="cover-details-seek-bar"
                >
                  <div className="absolute inset-x-0 h-1.5 rounded-full bg-white/10 pointer-events-none" />
                  <div
                    className="absolute left-0 h-1.5 rounded-full bg-gradient-to-r from-purple-500 via-fuchsia-500 to-cyan-400 pointer-events-none transition-all"
                    style={{ width: `${duration > 0 ? Math.min(((currentTime || 0) / duration) * 100, 100) : 0}%` }}
                  />
                  <div
                    className="absolute w-3.5 h-3.5 group-hover:w-4 group-hover:h-4 rounded-full bg-white shadow-lg ring-2 ring-purple-500/40 pointer-events-none transition-all"
                    style={{
                      left: `calc(${duration > 0 ? Math.min(((currentTime || 0) / duration) * 100, 100) : 0}% - 7px)`,
                    }}
                  />
                  <input
                    type="range"
                    min={0}
                    max={duration}
                    step={0.1}
                    value={Math.min(currentTime || 0, duration)}
                    onChange={(e) => onSeek(parseFloat(e.target.value))}
                    aria-label="Перемотка"
                    className="absolute inset-0 w-full h-full opacity-0 cursor-pointer"
                    data-testid="cover-details-seek-input"
                  />
                </div>
                <div className="flex justify-between mt-1.5 px-0.5">
                  <span className="text-[11px] font-mono text-white/60 tabular-nums">{formatTime(currentTime || 0)}</span>
                  <span className="text-[11px] font-mono text-white/60 tabular-nums">{formatTime(duration)}</span>
                </div>
              </div>
            )}

            {/* Controls row — center group (skip/play/skip) + side group (repeat/volume) */}
            <div className="flex items-center gap-3 sm:gap-4">
              {/* Repeat — leftmost (secondary control) */}
              {onRepeatToggle && (
                <button
                  type="button"
                  onClick={onRepeatToggle}
                  aria-label="Режим повтора"
                  title={
                    repeatMode === "off" ? "Повтор выключен"
                      : repeatMode === "one" ? "Повтор одного трека"
                        : "Повтор всех треков"
                  }
                  className={`w-11 h-11 rounded-full flex items-center justify-center transition-all shrink-0 ${
                    repeatMode && repeatMode !== "off"
                      ? "bg-gradient-to-br from-purple-500/40 to-cyan-500/30 border border-purple-400/50 text-white shadow-[0_0_16px_rgba(124,58,237,0.35)]"
                      : "bg-white/5 border border-white/10 text-white/40 hover:bg-white/10 hover:text-white/70"
                  }`}
                  data-testid="cover-details-repeat"
                >
                  {repeatMode === "one" ? <Repeat1 className="w-5 h-5" /> : <Repeat className="w-5 h-5" />}
                </button>
              )}

              {/* Центральная группа: skip prev / play-pause / skip next */}
              <div className="flex-1 flex items-center justify-center gap-3 sm:gap-4">
                {onPrev && (
                  <button
                    type="button"
                    onClick={onPrev}
                    aria-label="Предыдущий трек"
                    className="w-12 h-12 rounded-full bg-white/5 hover:bg-white/15 active:scale-95 transition-all flex items-center justify-center border border-white/10 shrink-0"
                    data-testid="cover-details-skip-prev"
                  >
                    <SkipBack className="w-5 h-5 text-white" />
                  </button>
                )}

                {onPlayPause && (
                  <button
                    type="button"
                    onClick={onPlayPause}
                    aria-label={isPlaying ? "Пауза" : "Воспроизвести"}
                    className="w-16 h-16 rounded-full bg-gradient-to-br from-purple-500 via-fuchsia-500 to-blue-500 hover:from-purple-400 hover:via-fuchsia-400 hover:to-blue-400 active:scale-95 transition-all flex items-center justify-center shadow-[0_0_32px_rgba(124,58,237,0.5)] border border-white/20 shrink-0"
                    data-testid="cover-details-play-pause"
                  >
                    {isPlaying
                      ? <Pause className="w-7 h-7 text-white" />
                      : <Play className="w-7 h-7 text-white ml-0.5" />
                    }
                  </button>
                )}

                {onNext && (
                  <button
                    type="button"
                    onClick={onNext}
                    aria-label="Следующий трек"
                    className="w-12 h-12 rounded-full bg-white/5 hover:bg-white/15 active:scale-95 transition-all flex items-center justify-center border border-white/10 shrink-0"
                    data-testid="cover-details-skip-next"
                  >
                    <SkipForward className="w-5 h-5 text-white" />
                  </button>
                )}
              </div>

              {/* Volume — rightmost. Reuse существующего VolumeSlider компонента. */}
              {onVolumeChange && typeof volume === "number" && (
                <div className="hidden sm:flex items-center w-40 lg:w-48 shrink-0">
                  <VolumeSlider
                    volume={volume}
                    onVolumeChange={onVolumeChange}
                    showPercent={false}
                  />
                </div>
              )}
            </div>

            {/* Mobile-only volume row (под основным rows of controls) */}
            {onVolumeChange && typeof volume === "number" && (
              <div className="sm:hidden mt-3 pt-3 border-t border-white/5">
                <VolumeSlider
                  volume={volume}
                  onVolumeChange={onVolumeChange}
                  showPercent={false}
                />
              </div>
            )}
          </div>
        )}

        <div className="w-full text-center px-2 pb-1" onClick={(e) => e.stopPropagation()}>
          {/* Eugene 2026-05-17 — neon-text accent поверх gradient-text. */}
          <p className="text-xl sm:text-2xl font-display font-bold gradient-text neon-text leading-tight">{title}</p>
          {track.authorName && (
            <p className="text-sm text-purple-300/90 mt-1 font-medium font-sans">{track.authorName}</p>
          )}
          {/* Eugene 2026-05-18 Босс «убери Промт» — track.prompt full text тоже
              скрыт в swipe modal (был рендер «Рок · быстрый · ...» как промт). */}
          {/* Eugene 2026-05-18 Босс «убери Промт, лишние пробеты, надо в кадр».
              Дата — компактнее (mt-2 вместо mt-4, без подписи лейбла). Help text
              убран — функционал интуитивен через стрелки и swipe. */}
          {date && (
            <p className="text-xs text-white/40 mt-2 font-mono">{date}</p>
          )}
        </div>
      </div>
    </div>
  );
}
