import { useEffect, useRef, useMemo } from "react";

interface KaraokeLyricsProps {
  lyrics: string;
  currentTime: number;
  duration: number;
  isPlaying: boolean;
  offsetSec?: number; // shift lyrics timing: negative = earlier, positive = later
}

export function KaraokeLyrics({ lyrics, currentTime, duration, isPlaying, offsetSec = 0 }: KaraokeLyricsProps) {
  const containerRef = useRef<HTMLDivElement>(null);

  // Parse and time lyrics with section-aware timing
  const timedLines = useMemo(() => {
    if (!lyrics || !duration) return [];
    const rawLines = lyrics.split("\n").filter(l => l.trim());
    const lines = rawLines.map(l => ({
      text: l.trim(),
      isTag: /^\[.*\]$/.test(l.trim()),
    }));
    const singableLines = lines.filter(l => !l.isTag);
    if (singableLines.length === 0) return [];

    // Count sections (tags) for inter-section pauses
    const sectionTags = lines.filter(l => l.isTag);
    const numSections = Math.max(1, sectionTags.length);

    // Time budget (accelerated 20%)
    const introTime = Math.min(duration * 0.15, 18); // 15% or max 18s intro
    const outroTime = Math.min(duration * 0.08, 10);  // 8% or max 10s outro
    const interSectionPause = Math.min(4, (duration * 0.04)); // ~4s pause between sections
    const totalPauses = (numSections - 1) * interSectionPause;
    const singableDuration = Math.max(duration - introTime - outroTime - totalPauses, duration * 0.5);
    const timePerLine = singableDuration / singableLines.length;

    // Build timed lines
    let cursor = introTime;
    let sectionIdx = 0;
    return lines.map((line, i) => {
      if (line.isTag) {
        // Section tag = pause
        if (sectionIdx > 0) cursor += interSectionPause;
        sectionIdx++;
        return { ...line, startTime: cursor, endTime: cursor };
      }
      const start = cursor;
      const end = cursor + timePerLine;
      cursor = end;
      return { ...line, startTime: start, endTime: end };
    });
  }, [lyrics, duration]);

  if (timedLines.length === 0) return null;

  // Find active line (apply offset: negative offset = text appears earlier)
  const adjustedTime = currentTime - offsetSec;
  const activeIdx = timedLines.findIndex(l => !l.isTag && adjustedTime >= l.startTime && adjustedTime < l.endTime);

  // Smooth scroll via translateY
  useEffect(() => {
    if (activeIdx >= 0 && containerRef.current) {
      const el = containerRef.current.children[activeIdx] as HTMLElement;
      if (el) {
        const containerH = containerRef.current.clientHeight;
        const elTop = el.offsetTop;
        const elH = el.clientHeight;
        const scrollTo = elTop - containerH / 2 + elH / 2;
        containerRef.current.scrollTo({ top: scrollTo, behavior: "smooth" });
      }
    }
  }, [activeIdx]);

  // Progress within active line (0-1)
  const lineProgress = activeIdx >= 0
    ? Math.min(1, Math.max(0, (adjustedTime - timedLines[activeIdx].startTime) / (timedLines[activeIdx].endTime - timedLines[activeIdx].startTime)))
    : 0;

  return (
    <div
      ref={containerRef}
      className="max-h-[130px] overflow-y-auto px-4 pr-1 py-2 space-y-0.5 scroll-smooth karaoke-scroll"
      style={{ maskImage: "linear-gradient(transparent, black 15%, black 85%, transparent)" }}
    >
      {timedLines.map((line, i) => {
        const isActive = i === activeIdx;
        const isPast = !line.isTag && activeIdx >= 0 && i < activeIdx;

        if (line.isTag) {
          return (
            <p key={i} className={`text-[10px] font-medium tracking-wider uppercase text-center transition-opacity duration-700 ${
              isPast ? "text-purple-400/20" : "text-purple-400/40"
            }`}>
              {line.text.replace(/[\[\]]/g, "")}
            </p>
          );
        }

        return (
          <p
            key={i}
            className={`text-center leading-relaxed transition-all duration-700 ${
              isActive
                ? "text-white text-[13px] font-semibold"
                : isPast
                ? "text-white/20 text-[11px]"
                : "text-white/40 text-[11px]"
            }`}
            style={isActive ? {
              background: `linear-gradient(90deg, rgba(255,255,255,1) ${lineProgress * 100}%, rgba(255,255,255,0.5) ${lineProgress * 100}%)`,
              WebkitBackgroundClip: "text",
              WebkitTextFillColor: "transparent",
            } : undefined}
          >
            {line.text}
          </p>
        );
      })}
    </div>
  );
}
