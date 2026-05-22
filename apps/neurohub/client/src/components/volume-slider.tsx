// Eugene 2026-05-17 Босс «стильный ползунок громкости в плеере».
//
// Reusable across landing (active player) + dashboard (MyPlaylist player).
// Volume управляется через audioRef.current.volume в plug-сайте.
//
// Дизайн:
// • Track: h-1.5 rounded-full bg-white/10
// • Filled: gradient from-purple-500 to-cyan-500 (фирменный)
// • Thumb: w-3 h-3 rounded-full bg-white, ring-2 ring-purple-500/40
// • Hover thumb растёт до w-4 h-4
//
// Layout: [icon] [slider] [%]
// • Mobile (< 640px): без процентов, компактно
// • Click на иконку → toggle mute (сохраняет prev volume, restore при unmute)
import { useRef, useState, useEffect } from "react";
import { Volume2, VolumeX, Volume1 } from "lucide-react";
import { isVolumeControlSupported } from "@/lib/lockscreen";

export interface VolumeSliderProps {
  volume: number;          // 0..1
  onVolumeChange: (v: number) => void;
  className?: string;
  showPercent?: boolean;   // на mobile прячем
}

export function VolumeSlider({ volume, onVolumeChange, className = "", showPercent = true }: VolumeSliderProps) {
  // prevVolume — для restore при unmute
  const prevVolumeRef = useRef<number>(volume > 0 ? volume : 0.7);
  const [hovering, setHovering] = useState(false);
  // Eugene 2026-05-22 Босс «регулировка громкости не работает, используй
  // документацию». По Apple WebKit docs на iOS Safari audio.volume read-only
  // (system volume). Показываем info-tooltip на iOS чтобы юзер знал что
  // громкость регулируется физическими кнопками устройства.
  const supported = isVolumeControlSupported();

  // Sync prevVolumeRef когда volume меняется в не-mute состоянии.
  useEffect(() => {
    if (volume > 0) prevVolumeRef.current = volume;
  }, [volume]);

  const toggleMute = () => {
    if (volume > 0) {
      // Текущий volume — non-zero. Запоминаем и заглушаем.
      prevVolumeRef.current = volume;
      onVolumeChange(0);
    } else {
      // Восстанавливаем previous (или 0.7 если не было).
      onVolumeChange(prevVolumeRef.current || 0.7);
    }
  };

  // Выбор иконки по уровню громкости.
  const Icon = volume === 0
    ? VolumeX
    : volume < 0.33
      ? Volume1
      : volume < 0.66
        ? Volume1
        : Volume2;

  const pct = Math.round(volume * 100);

  const iosTooltip = "Громкость регулируется кнопками устройства (iOS WebKit)";
  return (
    <div
      className={`flex items-center gap-2 ${className} ${supported ? "" : "opacity-60"}`}
      data-testid="volume-slider"
      title={supported ? undefined : iosTooltip}
    >
      <button
        type="button"
        onClick={toggleMute}
        title={!supported ? iosTooltip : volume === 0 ? "Включить звук" : "Заглушить"}
        aria-label={volume === 0 ? "Включить звук" : "Заглушить"}
        className="w-7 h-7 rounded-full bg-white/5 hover:bg-white/15 transition-colors flex items-center justify-center shrink-0"
        data-testid="volume-mute-toggle"
      >
        <Icon className={`w-4 h-4 ${volume === 0 ? "text-white/40" : "text-white/80"}`} />
      </button>

      {/* Slider track — h-1.5 rounded-full bg-white/10 с filled gradient.
          Используем нативный <input type="range"> с custom styling для accessibility
          (touch, keyboard, screen-reader). Visual overlay рисуется div'ом. */}
      <div
        className="relative flex-1 min-w-[60px] sm:min-w-[80px] h-5 flex items-center cursor-pointer"
        onMouseEnter={() => setHovering(true)}
        onMouseLeave={() => setHovering(false)}
      >
        {/* Background track */}
        <div className="absolute inset-x-0 h-1.5 rounded-full bg-white/10 pointer-events-none" />
        {/* Filled portion — фирменный purple → cyan */}
        <div
          className="absolute left-0 h-1.5 rounded-full bg-gradient-to-r from-purple-500 to-cyan-500 pointer-events-none transition-all"
          style={{ width: `${pct}%` }}
        />
        {/* Thumb — растёт на hover */}
        <div
          className={`absolute rounded-full bg-white shadow-lg ring-2 ring-purple-500/40 pointer-events-none transition-all ${
            hovering ? "w-4 h-4" : "w-3 h-3"
          }`}
          style={{
            left: `calc(${pct}% - ${hovering ? 8 : 6}px)`,
          }}
        />
        {/* Native input — invisible но active для drag/keyboard/touch */}
        <input
          type="range"
          min={0}
          max={1}
          step={0.01}
          value={volume}
          onChange={(e) => onVolumeChange(parseFloat(e.target.value))}
          aria-label="Громкость"
          className="absolute inset-0 w-full h-full opacity-0 cursor-pointer"
          data-testid="volume-slider-input"
        />
      </div>

      {showPercent && (
        <span
          className="hidden sm:inline-block text-[10px] text-white/50 tabular-nums w-8 text-right shrink-0"
          data-testid="volume-percent"
        >
          {pct}%
        </span>
      )}
    </div>
  );
}
