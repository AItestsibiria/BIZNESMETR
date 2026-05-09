// FloatingPlayer — sticky mini-player в углу всех страниц.
// Eugene 2026-05-09 (UI-DESIGN-SYSTEM-AUDIT.md задача C):
// «человек из любого места должен скользить по генерации».
//
// Поведение:
// - Виден только когда player-agent имеет current track
// - Скрыт пока юзер не закроет (cosmic-close button) — до следующего трека
// - Клик на miniplayer body → переход на /track/:id (полноразмерный плеер)
// - Inline play/pause кнопка
// - Mobile: bottom-right с safe-area отступом
// - Desktop: bottom-right больше отступы

import { useState, useEffect } from "react";
import { useLocation } from "wouter/use-hash-location";
import { Play, Pause } from "lucide-react";
import { usePlayer } from "@/lib/player-agent";
import { CosmicCloseButton } from "@/components/ui/cosmic-close";

export function FloatingPlayer() {
  const { current, status, toggle } = usePlayer();
  const [, setLocation] = useLocation();
  const [dismissedTrackId, setDismissedTrackId] = useState<number | null>(null);

  // Сбросить dismiss если current сменился
  useEffect(() => {
    if (current && dismissedTrackId && current.id !== dismissedTrackId) {
      setDismissedTrackId(null);
    }
  }, [current, dismissedTrackId]);

  if (!current) return null;
  if (dismissedTrackId === current.id) return null;

  const title = current.prompt || (current as any).display_title || "Трек";
  const author = current.authorName || "MuziAi";
  const isPlaying = status === "playing";

  const goToTrack = () => {
    setLocation(`/track/${current.id}`);
  };

  return (
    <div
      className="fixed z-40 bottom-4 right-4 sm:bottom-6 sm:right-6 max-w-[340px] flex items-center gap-2 p-2 rounded-2xl bg-background/85 backdrop-blur-xl border border-white/10 shadow-[0_8px_32px_rgba(0,0,0,0.5)] hover:shadow-[0_8px_32px_rgba(139,92,246,0.25),0_0_24px_rgba(34,211,238,0.15)] transition-shadow"
      data-testid="floating-player"
    >
      {/* Обложка + название — кликабельно к track-page */}
      <button
        type="button"
        onClick={goToTrack}
        className="flex items-center gap-2 min-w-0 flex-1 hover:bg-white/[0.04] rounded-lg p-1 -m-1 transition-colors text-left"
        aria-label="Открыть страницу трека"
        data-testid="floating-player-track"
      >
        {current.imageUrl ? (
          <img src={current.imageUrl} alt="" className="w-10 h-10 rounded-lg object-cover shrink-0" />
        ) : (
          <div className="w-10 h-10 rounded-lg bg-gradient-to-br from-purple-500/30 to-cyan-500/20 flex items-center justify-center shrink-0 text-base">🎵</div>
        )}
        <div className="min-w-0">
          <div className="text-xs font-medium text-white truncate font-display">{title}</div>
          <div className="text-[10px] text-muted-foreground truncate">{author}</div>
        </div>
      </button>

      {/* Play/Pause */}
      <button
        type="button"
        onClick={toggle}
        aria-label={isPlaying ? "Пауза" : "Играть"}
        data-testid="floating-player-toggle"
        className="w-9 h-9 rounded-full bg-gradient-to-br from-purple-500/40 to-cyan-500/30 hover:from-purple-500/60 hover:to-cyan-500/50 border border-white/15 flex items-center justify-center text-white shrink-0 transition-all active:scale-95"
      >
        {isPlaying ? <Pause className="w-4 h-4" /> : <Play className="w-4 h-4 translate-x-[1px]" />}
      </button>

      {/* Cosmic close (dismiss до следующего трека) */}
      <CosmicCloseButton
        size="sm"
        onClick={() => setDismissedTrackId(current.id)}
        ariaLabel="Скрыть мини-плеер"
      />
    </div>
  );
}
