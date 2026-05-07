import { useEffect, useRef, useState } from "react";
import { useRoute, Link } from "wouter";
import { Play, Pause, Download, Share2, Sparkles, ArrowLeft, Music } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  setLockScreenTrack,
  setLockScreenPlaybackState,
  setLockScreenPosition,
  clearLockScreen,
} from "@/lib/lockscreen";

interface TrackData {
  id: number;
  status?: string; // "done" | "processing" | "error" | "pending"
  errorReason?: string | null;
  type: string;
  prompt: string;
  audioUrl: string;
  imageUrl: string | null;
  authorName: string;
  createdAt: string;
  lyrics: string;
  isBonus?: boolean;
  bonusFromGenId?: number | null;
  styleInfo: string;
  baseStyle: string;
  fullStyle: string;
  category: "song" | "greeting" | "cover";
  isPublic: number;
}

export default function TrackPage() {
  const [, shareParams] = useRoute("/share/:id");
  const [, playParams] = useRoute("/play/:id");
  const [, trackParams] = useRoute("/track/:id");
  const id = shareParams?.id || playParams?.id || trackParams?.id;
  const [track, setTrack] = useState<TrackData | null>(null);
  const [loading, setLoading] = useState(true);
  const [notFound, setNotFound] = useState(false);
  const [pending, setPending] = useState<{ status: string; errorReason?: string | null; prompt?: string } | null>(null);
  const [playing, setPlaying] = useState(false);
  const [progress, setProgress] = useState(0);
  const [duration, setDuration] = useState(0);
  const [countdown, setCountdown] = useState<number | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);

  useEffect(() => {
    if (!id) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const fetchOnce = async () => {
      try {
        const r = await fetch(`/api/track/${id}`);
        if (!r.ok) {
          if (!cancelled) { setNotFound(true); setLoading(false); }
          return;
        }
        const d = await r.json();
        if (cancelled) return;
        if (d.status === "done" || d.audioUrl) {
          setTrack(d as TrackData);
          setPending(null);
          setLoading(false);
        } else {
          setPending({ status: d.status || "processing", errorReason: d.errorReason, prompt: d.prompt });
          setLoading(false);
          // авто-опрос каждые 5 сек пока processing
          if (d.status === "processing" || d.status === "pending") {
            timer = setTimeout(fetchOnce, 5000);
          }
        }
      } catch {
        if (!cancelled) { setNotFound(true); setLoading(false); }
      }
    };

    setLoading(true);
    fetchOnce();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [id]);

  useEffect(() => {
    if (!track) return;
    document.title = `${track.prompt} — MuziAi`;
  }, [track]);

  // Countdown → auto-redirect to main playlist after track finishes
  useEffect(() => {
    if (countdown === null) return;
    if (countdown <= 0) {
      window.location.href = "/";
      return;
    }
    const t = setTimeout(() => setCountdown(c => (c === null ? null : c - 1)), 1000);
    return () => clearTimeout(t);
  }, [countdown]);

  const cancelCountdown = () => setCountdown(null);
  const goHome = () => { window.location.href = "/"; };

  const togglePlay = async () => {
    if (!audioRef.current || !track) return;
    if (playing) {
      audioRef.current.pause();
      setPlaying(false);
      setLockScreenPlaybackState("paused");
    } else {
      // Configure lock screen BEFORE play (iOS requirement)
      await setLockScreenTrack(
        {
          id: track.id,
          title: track.prompt || "MuziAi",
          artist: track.authorName ? `MuziAi · ${track.authorName}` : "MuziAi",
          album: "MuziAi",
        },
        {
          play: () => { audioRef.current?.play(); setPlaying(true); setLockScreenPlaybackState("playing"); },
          pause: () => { audioRef.current?.pause(); setPlaying(false); setLockScreenPlaybackState("paused"); },
          seekto: (t: number) => { if (audioRef.current) audioRef.current.currentTime = t; },
        },
        track.createdAt // cache-buster tied to gen record
      );
      try {
        await audioRef.current.play();
        setPlaying(true);
        setLockScreenPlaybackState("playing");
      } catch {}
      // log activity
      fetch(`/api/gen-activity/${track?.id}/play`, { method: "POST" }).catch(() => {});
    }
  };

  const handleShare = async () => {
    if (!track) return;
    const url = `https://muziai.ru/share/${track.id}`;
    const title = track.prompt;
    if (navigator.share) {
      try {
        await navigator.share({ title: `Послушай на MuziAi.ru`, text: title, url });
        fetch(`/api/gen-activity/${track.id}/share`, { method: "POST" }).catch(() => {});
        return;
      } catch {}
    }
    try {
      await navigator.clipboard.writeText(url);
      alert("Ссылка скопирована");
    } catch {}
  };

  const handleDownload = () => {
    if (!track) return;
    const a = document.createElement("a");
    a.href = `${track.audioUrl}?download=1`;
    a.download = `${track.prompt}.mp3`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    fetch(`/api/gen-activity/${track.id}/download`, { method: "POST" }).catch(() => {});
  };

  const handleCreateSimilar = () => {
    if (!track) return;
    // Pass the full style to the music page through window globals (same pattern as landing)
    (window as any).__styleTransfer = track.baseStyle || track.fullStyle;
    (window as any).__fullStyleTransfer = track.fullStyle;
    (window as any).__lyricsTransfer = track.lyrics || "";
    window.location.href = "/#/music";
  };

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-background text-foreground">
        <div className="animate-pulse text-muted-foreground">Загрузка…</div>
      </div>
    );
  }
  if (pending) {
    if (pending.status === "error") {
      return (
        <div className="min-h-screen flex flex-col items-center justify-center bg-background text-foreground p-6 text-center gap-4">
          <Music className="w-16 h-16 text-rose-400" />
          <h1 className="text-2xl font-semibold">Генерация не удалась</h1>
          {pending.prompt && <p className="text-sm text-muted-foreground">{pending.prompt}</p>}
          {pending.errorReason && (
            <p className="text-sm text-rose-300/90 max-w-md p-3 rounded-lg bg-rose-500/10 border border-rose-500/30">
              {pending.errorReason}
            </p>
          )}
          <Link href="/"><Button variant="outline"><ArrowLeft className="w-4 h-4 mr-2" />На главную</Button></Link>
        </div>
      );
    }
    return (
      <div className="min-h-screen flex flex-col items-center justify-center bg-background text-foreground p-6 text-center gap-4">
        <div className="relative">
          <Music className="w-16 h-16 text-violet-400 animate-pulse" />
          <Sparkles className="w-6 h-6 text-amber-300 absolute -top-1 -right-1 animate-spin" style={{ animationDuration: "3s" }} />
        </div>
        <h1 className="text-2xl font-semibold">MuziAi работает над треком…</h1>
        {pending.prompt && <p className="text-sm text-muted-foreground max-w-sm">{pending.prompt}</p>}
        <p className="text-xs text-muted-foreground/70 max-w-sm">
          Обычно занимает 1–2 минуты. Страница обновится автоматически — не закрывайте.
        </p>
        <div className="flex gap-2">
          <Button variant="outline" onClick={() => window.location.reload()}>
            Обновить сейчас
          </Button>
          <Link href="/"><Button variant="ghost"><ArrowLeft className="w-4 h-4 mr-2" />На главную</Button></Link>
        </div>
      </div>
    );
  }
  if (notFound || !track) {
    return (
      <div className="min-h-screen flex flex-col items-center justify-center bg-background text-foreground p-6 text-center gap-4">
        <Music className="w-16 h-16 text-muted-foreground" />
        <h1 className="text-2xl font-semibold">Трек не найден</h1>
        <p className="text-muted-foreground max-w-sm">Возможно, ссылка устарела или трек был удалён автором.</p>
        <Link href="/"><Button variant="outline"><ArrowLeft className="w-4 h-4 mr-2" />На главную</Button></Link>
      </div>
    );
  }

  const fmt = (s: number) => {
    if (!isFinite(s)) return "0:00";
    const m = Math.floor(s / 60);
    const ss = Math.floor(s % 60).toString().padStart(2, "0");
    return `${m}:${ss}`;
  };

  return (
    <div className="min-h-screen bg-gradient-to-b from-background via-background to-background/80 text-foreground">
      {/* back link */}
      <div className="max-w-xl mx-auto px-4 pt-4">
        <Link href="/">
          <button className="text-sm text-muted-foreground hover:text-foreground inline-flex items-center gap-1" data-testid="btn-back-home">
            <ArrowLeft className="w-4 h-4" /> На главную
          </button>
        </Link>
      </div>

      <div className="max-w-xl mx-auto px-4 py-6 flex flex-col items-center gap-6">
        {/* cover */}
        <div className="w-full aspect-square rounded-3xl overflow-hidden bg-muted shadow-2xl shadow-black/40 relative">
          {track.imageUrl ? (
            <img
              src={track.imageUrl}
              alt={track.prompt}
              className="w-full h-full object-cover"
              data-testid="img-track-cover"
            />
          ) : (
            <div className="w-full h-full flex items-center justify-center bg-gradient-to-br from-purple-900/40 to-blue-900/40">
              <Music className="w-24 h-24 text-white/40" />
            </div>
          )}
          {track.category === "greeting" && (
            <div className="absolute top-3 left-3 px-2.5 py-1 rounded-full bg-pink-500/90 text-white text-xs font-medium backdrop-blur-sm">
              🎁 Поздравление
            </div>
          )}
          {track.isBonus && (
            <div className="absolute top-3 right-3 px-2.5 py-1 rounded-full bg-gradient-to-r from-emerald-500 to-cyan-500 text-white text-xs font-medium backdrop-blur-sm shadow-lg">
              🎁 Бонус от MuziAi
            </div>
          )}
        </div>

        {/* title / author */}
        <div className="text-center w-full">
          <h1 className="text-2xl font-bold tracking-tight" data-testid="text-track-title">{track.prompt}</h1>
          <p className="text-sm text-muted-foreground mt-1" data-testid="text-author-name">
            Автор: {track.authorName}
          </p>
          {track.styleInfo && (
            <p className="text-xs text-muted-foreground/80 mt-2" data-testid="text-style-info">
              <span className="opacity-60">Промт:</span> {track.styleInfo}
            </p>
          )}
        </div>

        {/* audio */}
        <audio
          ref={audioRef}
          src={track.audioUrl}
          preload="metadata"
          onLoadedMetadata={e => setDuration((e.target as HTMLAudioElement).duration)}
          onTimeUpdate={e => {
            const a = e.target as HTMLAudioElement;
            setProgress(a.currentTime);
            setLockScreenPosition(a.duration, a.currentTime);
          }}
          onEnded={() => { setPlaying(false); setCountdown(5); setLockScreenPlaybackState("paused"); }}
        />

        {/* progress */}
        <div className="w-full">
          <input
            type="range"
            min={0}
            max={duration || 0}
            value={progress}
            onChange={e => {
              if (audioRef.current) {
                audioRef.current.currentTime = Number(e.target.value);
                setProgress(Number(e.target.value));
              }
            }}
            className="w-full accent-primary"
            data-testid="input-progress"
          />
          <div className="flex justify-between text-xs text-muted-foreground mt-1">
            <span>{fmt(progress)}</span>
            <span>{fmt(duration)}</span>
          </div>
        </div>

        {/* big play */}
        <button
          onClick={togglePlay}
          className="w-20 h-20 rounded-full bg-primary text-primary-foreground flex items-center justify-center shadow-xl hover:scale-105 transition-transform active:scale-95"
          data-testid="btn-play-toggle"
          aria-label={playing ? "Пауза" : "Воспроизвести"}
        >
          {playing ? <Pause className="w-8 h-8" /> : <Play className="w-8 h-8 ml-1" />}
        </button>

        {/* action buttons */}
        <div className="flex flex-wrap gap-2 justify-center w-full">
          <Button variant="outline" onClick={handleShare} data-testid="btn-share">
            <Share2 className="w-4 h-4 mr-2" /> Поделиться
          </Button>
          <Button variant="outline" onClick={handleDownload} data-testid="btn-download">
            <Download className="w-4 h-4 mr-2" /> Скачать
          </Button>
          {/* «Перегенерировать» — для треков-каверов из аудио (ТЗ Eugene 11:55) */}
          {track.category === "cover" && (
            <Button
              variant="outline"
              className="border-cyan-500/40 text-cyan-300 hover:bg-cyan-500/10"
              onClick={async () => {
                try {
                  const r = await fetch(`/api/gen/audio-cover/${track.id}/regenerate`, {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: "{}",
                  });
                  const j = await r.json();
                  if (j?.data?.generationId) {
                    window.location.href = `/#/track/${j.data.generationId}`;
                  } else {
                    alert(j?.error || "Регенерация недоступна");
                  }
                } catch (err) {
                  alert(err instanceof Error ? err.message : "ошибка");
                }
              }}
              data-testid="btn-regenerate-cover"
            >
              🔄 Перегенерировать
            </Button>
          )}
        </div>

        {/* Blinking CTA — under "Create similar" on share pages, including non-public tracks */}
        <button
          onClick={goHome}
          className="relative w-full py-3.5 rounded-2xl font-semibold text-white overflow-hidden group"
          data-testid="btn-muziai-blink"
          style={{
            background: "linear-gradient(90deg, #a855f7 0%, #ec4899 50%, #3b82f6 100%)",
            backgroundSize: "200% 100%",
            animation: "muziai-pulse 1.8s ease-in-out infinite, muziai-gradient-shift 4s linear infinite",
            boxShadow: "0 10px 30px -10px rgba(168, 85, 247, 0.6)",
          }}
        >
          <span className="relative z-10 inline-flex items-center justify-center gap-2">
            <Music className="w-5 h-5" />
            <span className="tracking-wide">MuziAi.ru</span>
          </span>
        </button>
        <style>{`
          @keyframes muziai-pulse {
            0%, 100% { box-shadow: 0 10px 30px -10px rgba(168, 85, 247, 0.45), 0 0 0 0 rgba(236, 72, 153, 0.5); transform: scale(1); }
            50% { box-shadow: 0 14px 38px -8px rgba(236, 72, 153, 0.7), 0 0 0 10px rgba(236, 72, 153, 0); transform: scale(1.015); }
          }
          @keyframes muziai-gradient-shift {
            0% { background-position: 0% 50%; }
            50% { background-position: 100% 50%; }
            100% { background-position: 0% 50%; }
          }
        `}</style>

        {/* lyrics */}
        {track.lyrics && (
          <div className="w-full mt-4 p-4 rounded-2xl bg-card/40 border border-white/5">
            <h2 className="text-sm font-semibold mb-2 text-muted-foreground">Текст песни</h2>
            <pre className="whitespace-pre-wrap text-sm leading-relaxed font-sans" data-testid="text-lyrics">
              {track.lyrics}
            </pre>
          </div>
        )}

        {/* Big CTA — listen to other tracks on main */}
        <button
          onClick={goHome}
          className="w-full mt-4 py-4 rounded-2xl bg-gradient-to-r from-purple-600 via-violet-500 to-blue-500 text-white font-semibold text-base shadow-lg shadow-purple-600/30 hover:shadow-purple-600/50 hover:scale-[1.01] active:scale-[0.99] transition-all flex items-center justify-center gap-2"
          data-testid="btn-listen-more"
        >
          <Music className="w-5 h-5" />
          Слушать другие треки на MuziAi.ru
        </button>
      </div>

      {/* Auto-redirect countdown overlay after track ends */}
      {countdown !== null && (
        <div className="fixed bottom-4 left-4 right-4 md:left-auto md:max-w-sm md:right-4 z-50 p-4 rounded-2xl bg-card/95 backdrop-blur-md border border-white/10 shadow-2xl flex items-center gap-3" data-testid="countdown-overlay">
          <div className="w-12 h-12 rounded-full bg-primary/20 text-primary flex items-center justify-center text-xl font-bold flex-shrink-0">
            {countdown}
          </div>
          <div className="flex-1 min-w-0">
            <p className="text-sm font-medium">Переход на главную…</p>
            <p className="text-xs text-muted-foreground truncate">Или останься здесь</p>
          </div>
          <button
            onClick={cancelCountdown}
            className="px-3 py-1.5 rounded-lg bg-white/10 hover:bg-white/20 text-xs font-medium transition-colors"
            data-testid="btn-cancel-countdown"
          >
            Отмена
          </button>
          <button
            onClick={goHome}
            className="px-3 py-1.5 rounded-lg bg-primary text-primary-foreground hover:bg-primary/90 text-xs font-medium transition-colors"
            data-testid="btn-go-home-now"
          >
            Перейти
          </button>
        </div>
      )}
    </div>
  );
}
