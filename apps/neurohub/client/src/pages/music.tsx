import { useState, useRef, useEffect, useCallback, useMemo } from "react";
import { useAuth } from "@/lib/auth";
import { startBgMusic, stopBgMusic } from "@/components/background-music";
import { apiRequest } from "@/lib/queryClient";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import { InlineAuth } from "@/components/inline-auth";
import { Music, Loader2, Download, Play, Pause, Volume2, Copy, Check, RefreshCcw, ChevronDown, Sparkles, Sliders, Mic, FileText, Settings2, Share2 } from "lucide-react";
import { HelpBuddy } from "@/components/help-buddy";
import { MicRecorder } from "@/components/mic-recorder";
import { StudioMicEq } from "@/components/studio-mic-eq";
import { useToast } from "@/hooks/use-toast";

const styles = [
  { value: "pop", label: "Поп", desc: "весёлая, лёгкая" },
  { value: "rock", label: "Рок", desc: "энергичная, мощная" },
  { value: "rap", label: "Рэп", desc: "ритмичная, читка" },
  { value: "electronic", label: "Электронная", desc: "синтезаторы, бит" },
  { value: "jazz", label: "Джаз", desc: "свинг, импровизация" },
  { value: "lofi", label: "Lo-Fi", desc: "спокойная, фоновая" },
  { value: "cinematic", label: "Кинематограф", desc: "эпичная, оркестр" },
  { value: "ballad", label: "Баллада", desc: "медленная, душевная" },
  { value: "folk", label: "Фолк", desc: "народная, акустика" },
  { value: "rnb", label: "R&B", desc: "соул, грув" },
  { value: "reggae", label: "Регги", desc: "расслабленная, солнечная" },
  { value: "metal", label: "Метал", desc: "тяжёлая, агрессивная" },
  { value: "country", label: "Кантри", desc: "гитара, Америка" },
  { value: "classical", label: "Классика", desc: "оркестр, фортепиано" },
  { value: "chanson", label: "Шансон", desc: "душевная, русская" },
  { value: "dance", label: "Данс", desc: "танцевальная, клубная" },
];

const tempos = [
  { value: "", label: "Любой" },
  { value: "slow", label: "Медленный" },
  { value: "moderate", label: "Средний" },
  { value: "fast", label: "Быстрый" },
  { value: "very fast", label: "Очень быстрый" },
];

const moods = [
  { value: "", label: "Любое" },
  { value: "happy", label: "Весёлое" },
  { value: "sad", label: "Грустное" },
  { value: "romantic", label: "Романтичное" },
  { value: "energetic", label: "Энергичное" },
  { value: "calm", label: "Спокойное" },
  { value: "dramatic", label: "Драматичное" },
  { value: "epic", label: "Эпичное" },
  { value: "dreamy", label: "Мечтательное" },
  { value: "aggressive", label: "Агрессивное" },
];

function Equalizer({ playing }: { playing: boolean }) {
  // Spectrum-analyzer стиль (Eugene 2026-05-09 DJ hi-tech): низкие частоты
  // снизу — тёплые цвета (red→orange), верхние частоты — холодные (cyan→violet).
  // Имитирует визуализацию частотного спектра реального hardware-микшера.
  const spectrumColor = (i: number): string => {
    const r = i / 19;
    if (r < 0.20) return "from-red-500 via-orange-400 to-amber-300";
    if (r < 0.40) return "from-orange-500 via-amber-400 to-yellow-300";
    if (r < 0.60) return "from-emerald-500 via-emerald-300 to-emerald-100";
    if (r < 0.80) return "from-cyan-500 via-cyan-300 to-cyan-100";
    return "from-violet-500 via-violet-300 to-violet-100";
  };
  return (
    <div className="flex items-end gap-[2px] h-10">
      {Array.from({ length: 20 }).map((_, i) => (
        <div
          key={i}
          className={`w-[3px] rounded-full bg-gradient-to-t ${spectrumColor(i)} transition-all ${
            playing ? "equalizer-bar" : ""
          }`}
          style={{
            height: playing ? undefined : "15%",
            animationDelay: `${i * 0.06}s`,
            animationDuration: `${0.6 + (i % 5) * 0.15}s`,
          }}
        />
      ))}
    </div>
  );
}

function AudioPlayer({ url, autoPlay }: { url: string; autoPlay?: boolean }) {
  const audioRef = useRef<HTMLAudioElement>(null);
  const [playing, setPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [volume, setVolume] = useState(0.8);

  useEffect(() => {
    const audio = audioRef.current;
    if (!audio) return;
    const onTime = () => setCurrentTime(audio.currentTime);
    const onMeta = () => setDuration(audio.duration);
    const onEnd = () => { setPlaying(false); };
    const onPlay = () => { stopBgMusic(); };
    audio.addEventListener("timeupdate", onTime);
    audio.addEventListener("loadedmetadata", onMeta);
    audio.addEventListener("ended", onEnd);
    audio.addEventListener("play", onPlay);

    // Autoplay when result arrives
    if (autoPlay) {
      audio.play().catch(() => {});
      setPlaying(true);
    }

    return () => {
      audio.removeEventListener("timeupdate", onTime);
      audio.removeEventListener("loadedmetadata", onMeta);
      audio.removeEventListener("ended", onEnd);
      audio.removeEventListener("play", onPlay);
    };
  }, [autoPlay]);

  const togglePlay = () => {
    if (!audioRef.current) return;
    if (playing) {
      audioRef.current.pause();
    } else {
      audioRef.current.play();
    }
    setPlaying(!playing);
  };

  const seek = (e: React.MouseEvent<HTMLDivElement>) => {
    if (!audioRef.current || !duration) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const pct = (e.clientX - rect.left) / rect.width;
    audioRef.current.currentTime = pct * duration;
  };

  const changeVolume = (e: React.ChangeEvent<HTMLInputElement>) => {
    const v = parseFloat(e.target.value);
    setVolume(v);
    if (audioRef.current) audioRef.current.volume = v;
  };

  const fmt = (s: number) => {
    const m = Math.floor(s / 60);
    const sec = Math.floor(s % 60);
    return `${m}:${sec.toString().padStart(2, "0")}`;
  };

  const progress = duration ? (currentTime / duration) * 100 : 0;

  return (
    <div className="gradient-border p-6 rounded-2xl" data-testid="audio-player">
      <audio ref={audioRef} src={url} preload="metadata" />

      {/* Equalizer */}
      <div className="flex justify-center mb-6">
        <Equalizer playing={playing} />
      </div>

      {/* Controls */}
      <div className="flex items-center gap-4">
        <button
          onClick={togglePlay}
          className="w-12 h-12 rounded-full btn-gradient flex items-center justify-center shrink-0"
          data-testid="button-play-pause"
        >
          {playing ? <Pause className="w-5 h-5 text-white" /> : <Play className="w-5 h-5 text-white ml-0.5" />}
        </button>

        <div className="flex-1">
          {/* Progress bar */}
          <div
            className="w-full h-2 rounded-full bg-white/10 cursor-pointer relative overflow-hidden"
            onClick={seek}
            data-testid="audio-progress"
          >
            <div
              className="absolute inset-y-0 left-0 audio-progress rounded-full transition-all"
              style={{ width: `${progress}%` }}
            />
          </div>
          <div className="flex justify-between mt-1">
            <span className="text-xs text-muted-foreground">{fmt(currentTime)}</span>
            <span className="text-xs text-muted-foreground">{fmt(duration)}</span>
          </div>
        </div>

        {/* Volume */}
        <div className="hidden sm:flex items-center gap-2">
          <Volume2 className="w-4 h-4 text-muted-foreground" />
          <input
            type="range"
            min={0}
            max={1}
            step={0.05}
            value={volume}
            onChange={changeVolume}
            className="w-16 accent-purple-500"
            data-testid="input-volume"
          />
        </div>
      </div>
    </div>
  );
}

export default function MusicPage() {
  const { user, refreshUser } = useAuth();
  const { toast } = useToast();

  // Check for lyrics/style/voiceType passed from other pages
  // Eugene 2026-05-08: regenerate flow — переход с дашборда из errored трека
  // подставляет все параметры из gen.style и заставляет кнопку моргать.
  const regeneratePayload = (() => {
    try {
      const raw = sessionStorage.getItem("musicRegenerate");
      if (!raw) return null;
      sessionStorage.removeItem("musicRegenerate");
      return JSON.parse(raw);
    } catch { return null; }
  })();
  const [pulseGenerate, setPulseGenerate] = useState<boolean>(!!regeneratePayload);

  const transferred = (() => {
    let lyricsT = (window as any).__lyricsTransfer;
    let styleT = (window as any).__styleTransfer;
    let fullStyleT = (window as any).__fullStyleTransfer;
    let voiceTypeT = (window as any).__voiceTypeTransfer;
    // Fallback на sessionStorage (переживёт рефреш и полную навигацию)
    try {
      if (!lyricsT) lyricsT = sessionStorage.getItem("__lyricsTransfer") || null;
      if (!styleT) styleT = sessionStorage.getItem("__styleTransfer") || null;
      if (!fullStyleT) fullStyleT = sessionStorage.getItem("__fullStyleTransfer") || null;
      if (!voiceTypeT) voiceTypeT = sessionStorage.getItem("__voiceTypeTransfer") || null;
    } catch {}
    if (lyricsT) delete (window as any).__lyricsTransfer;
    if (styleT) delete (window as any).__styleTransfer;
    if (fullStyleT) delete (window as any).__fullStyleTransfer;
    if (voiceTypeT) delete (window as any).__voiceTypeTransfer;
    try {
      sessionStorage.removeItem("__lyricsTransfer");
      sessionStorage.removeItem("__styleTransfer");
      sessionStorage.removeItem("__fullStyleTransfer");
      sessionStorage.removeItem("__voiceTypeTransfer");
    } catch {}
    if (lyricsT || styleT || fullStyleT || voiceTypeT) {
      return { lyrics: lyricsT || null, style: styleT || null, fullStyle: fullStyleT || null, voiceType: voiceTypeT || null };
    }
    // URL query fallback
    try {
      const hash = window.location.hash;
      const qIdx = hash.indexOf("?");
      if (qIdx === -1) return null;
      const params = new URLSearchParams(hash.slice(qIdx));
      // Eugene 2026-05-11: расширенный pre-fill через URL — бот строит
      // ссылку https://muziai.ru/#/music?mode=...&prompt=...&lyrics=...
      // &title=...&style=...&voice=... — pre-fill всех полей формы.
      const urlPrompt = params.get("prompt");
      const urlLyrics = params.get("lyrics");
      const urlTitle = params.get("title");
      const urlStyle = params.get("style");
      const urlVoice = params.get("voice"); // 'female' | 'male' | 'duet' | 'instrumental'
      if (urlPrompt || urlLyrics || urlTitle || urlStyle || urlVoice) {
        // Engagement: юзер пришёл по pre-filled ссылке (от помощника).
        try {
          let sid = sessionStorage.getItem("_engagementSid");
          if (!sid) { sid = Math.random().toString(36).slice(2, 14); sessionStorage.setItem("_engagementSid", sid); }
          fetch("/api/engagement/track", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ event: "consultant_action", sessionId: sid, meta: { action: "music_link_open", mode: params.get("mode") || params.get("tab") || null } }),
            keepalive: true,
          }).catch(() => {});
        } catch {}
        return {
          lyrics: urlLyrics || null,
          style: urlStyle || null,
          fullStyle: null,
          voiceType: urlVoice || null,
          prompt: urlPrompt || null,
          title: urlTitle || null,
        };
      }
      return null;
    } catch { return null; }
  })();

  const [mode, setMode] = useState<"basic" | "audio" | "advanced">(() => {
    // Eugene 2026-05-09: ОДНОКРАТНАЯ МИГРАЦИЯ — у всех у кого в localStorage
    // сохранён старый music_mode (basic/audio/advanced любой) — сбрасываем
    // его и форсируем новый default 'audio'. Маркер music_mode_v2='1'
    // предотвращает повторный сброс. После миграции выбор юзера снова
    // запоминается как обычно (saved value > default).
    try {
      if (!localStorage.getItem("music_mode_v2")) {
        localStorage.removeItem("music_mode");
        localStorage.removeItem("music_audio_mode");
        localStorage.setItem("music_mode_v2", "1");
      }
    } catch {}
    // Eugene 2026-05-09: дефолт переведён на 'audio' (раньше был 'basic').
    // Регенерация (как и раньше) — форсирует 'advanced' если есть длинная
    // лирика. URL ?tab= и сохранённый выбор имеют приоритет над дефолтом.
    if (regeneratePayload) {
      return regeneratePayload.lyrics && regeneratePayload.lyrics.length >= 50 ? "advanced" : "basic";
    }
    try {
      // Eugene 2026-05-11: ?tab= и ?mode= оба валидны (бот шлёт ?mode=).
      const _p = new URLSearchParams(window.location.hash.split("?")[1] || "");
      const tabFromUrl = _p.get("tab") || _p.get("mode");
      if (tabFromUrl === "basic" || tabFromUrl === "audio" || tabFromUrl === "advanced") return tabFromUrl;
      const saved = localStorage.getItem("music_mode");
      if (saved === "basic" || saved === "audio" || saved === "advanced") return saved;
    } catch {}
    return "audio";
  });
  useEffect(() => { try { localStorage.setItem("music_mode", mode); } catch {} }, [mode]);
  const [audioMode, setAudioMode] = useState<"simple" | "advanced">(() => {
    // Eugene 2026-05-09: дефолт переведён на 'advanced' (раньше был 'simple').
    try { const s = localStorage.getItem("music_audio_mode"); if (s === "simple" || s === "advanced") return s; } catch {}
    return "advanced";
  });
  useEffect(() => { try { localStorage.setItem("music_audio_mode", audioMode); } catch {} }, [audioMode]);
  // Аудио-вход: пользовательский upload (mp3) для cover/extend режима.
  // Sprint 3 backend ещё не готов (см. docs/strategy/v304-audio-input-TZ.md),
  // UI собирается заранее — отправит uploadUrl когда endpoint появится.
  const [audioFile, setAudioFile] = useState<File | null>(null);
  const [audioUploadUrl, setAudioUploadUrl] = useState<string | null>(null);
  const [audioUploadSha, setAudioUploadSha] = useState<string | null>(null);
  const [audioUploading, setAudioUploading] = useState(false);
  // audioWeight убран — относилось к file-upload (Eugene 13:18). Default 0.7
  // зашит ниже в coverBody.
  // Транскрипция + LLM-rewrite (ТЗ Eugene 2026-05-07 12:09: «голос → суть → текст песни»)
  const [transcribing, setTranscribing] = useState(false);
  const [audioTranscript, setAudioTranscript] = useState<string>("");
  const [audioLyrics, setAudioLyrics] = useState<string>("");
  const [audioSuggestion, setAudioSuggestion] = useState<{ genre?: string; bpm?: number; templateSlug?: string; title?: string } | null>(null);
  const [rewriting, setRewriting] = useState(false);
  const [rewriteHint, setRewriteHint] = useState("");
  // Cosmic disclosure для транскрипции «Что я услышал» (Eugene 2026-05-09).
  // На смартфоне раскрывается полупрозрачным, закрытие — cosmic-fade анимация.
  const [transcriptOpen, setTranscriptOpen] = useState(false);
  const [transcriptExiting, setTranscriptExiting] = useState(false);
  // Авто-открытие пока lyrics не сгенерированы; авто-закрытие когда lyrics появились.
  useEffect(() => {
    if (audioTranscript && !audioLyrics) setTranscriptOpen(true);
    if (audioLyrics && transcriptOpen && !transcriptExiting) {
      setTranscriptExiting(true);
      const t = setTimeout(() => { setTranscriptOpen(false); setTranscriptExiting(false); }, 420);
      return () => clearTimeout(t);
    }
  }, [audioTranscript, audioLyrics]);
  // Auto-expand lyrics textarea после Re Текст (Eugene 2026-05-09: «новый текст в раскрытом положении»).
  const lyricsTextareaRef = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    const ta = lyricsTextareaRef.current;
    if (!ta || !audioLyrics) return;
    ta.style.height = "auto";
    ta.style.height = `${Math.max(ta.scrollHeight + 2, 240)}px`;
  }, [audioLyrics]);
  // Scroll-to-tabs если страница открыта с ?tab=* (Eugene 2026-05-09:
  // «Новости ссылка на аудио должна приводить на окно генерации аудио»).
  // На mobile форма уезжает ниже viewport — без скролла юзер видит page-title
  // и думает что страница пустая. После mount делаем smooth-scroll к Mode Toggle.
  const modeTabsRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    try {
      const params = new URLSearchParams(window.location.hash.split("?")[1] || "");
      const hasTabParam = params.has("tab") || params.has("mode") || params.has("prompt") || params.has("lyrics");
      if (!hasTabParam) return;
      const t = setTimeout(() => {
        // Eugene 2026-05-11: при заходе по pre-filled URL — скроллим в самый
        // верх формы чтобы юзер видел все блоки сверху вниз.
        modeTabsRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
      }, 250);
      return () => clearTimeout(t);
    } catch {}
  }, []);
  // Внутри Расширенного — старая Simple/Lyrics подвкладка (была prev top-mode).
  // Eugene 2026-05-11: если URL содержит lyrics — авто-выбираем «Свой текст».
  const [legacyMode, setLegacyMode] = useState<"simple" | "advanced">(
    regeneratePayload?.mode === "advanced" || (transferred?.lyrics && String(transferred.lyrics).length >= 50) ? "advanced" : "simple",
  );
  const [prompt, setPrompt] = useState(regeneratePayload?.prompt || transferred?.prompt || "");
  const [style, setStyle] = useState(regeneratePayload?.style || transferred?.style || "pop");
  const [selectedStyles, setSelectedStyles] = useState<string[]>([regeneratePayload?.style || transferred?.style || "pop"]);
  const [lyrics, setLyrics] = useState(regeneratePayload?.lyrics || transferred?.lyrics || "");
  const [songCategory, setSongCategory] = useState<'song' | 'greeting'>('greeting');
  const [title, setTitle] = useState(regeneratePayload?.title || "");
  // ТЗ Eugene 2026-05-07 §5 + 2026-05-08 regenerate flow.
  const _transferredVT = (regeneratePayload?.voiceType || transferred?.voiceType || "").toString().toLowerCase();
  const [instrumental, setInstrumental] = useState<boolean>(_transferredVT === "instrumental" || !!regeneratePayload?.instrumental);
  const [voice, setVoice] = useState<"female" | "male">(
    regeneratePayload?.voice === "male" || _transferredVT === "male" ? "male" : "female",
  );
  const [isPrivate, setIsPrivate] = useState(true);
  const [authorName, setAuthorName] = useState(user?.name || "");
  const [lastGenId, setLastGenId] = useState<number | null>(null);
  const [loading, setLoading] = useState(false);
  const [polling, setPolling] = useState(false);
  // Eugene 2026-05-08: после 3 мин ожидания показываем choice-панель
  // (подождать ещё / открыть дашборд)
  const [showLongWait, setShowLongWait] = useState(false);
  const [resultUrl, setResultUrl] = useState<string | null>(null);
  const [showInlineAuth, setShowInlineAuth] = useState(false);
  const [usedStyles, setUsedStyles] = useState<string[]>(transferred?.style ? [transferred.style] : []);
  // Eugene 2026-05-11: при заходе по pre-filled URL — все блоки сверху вниз
  // развёрнуты, чтобы клиент сразу видел все параметры.
  const _prefilled = !!(transferred?.prompt || transferred?.lyrics || transferred?.style || transferred?.voiceType);
  const [showAdvanced, setShowAdvanced] = useState(_prefilled);
  // Parse fullStyle transfer: "Рок · энергичное · 170 BPM"
  const parsedTransfer = useMemo(() => {
    if (!transferred?.fullStyle) return { mood: '', tempo: '', bpm: '' };
    const parts = transferred.fullStyle.split(' \u00b7 ').map((p: string) => p.trim().toLowerCase());
    const moodRev: Record<string,string> = { 'весёлое':'happy', 'грустное':'sad', 'романтичное':'romantic', 'энергичное':'energetic', 'спокойное':'calm', 'драматичное':'dramatic', 'эпичное':'epic', 'мечтательное':'dreamy', 'агрессивное':'aggressive' };
    const tempoRev: Record<string,string> = { 'медленный':'slow', 'средний':'moderate', 'быстрый':'fast', 'очень быстрый':'very fast' };
    let m = '', t = '', b = '';
    for (const p of parts.slice(1)) {
      if (moodRev[p]) m = moodRev[p];
      else if (tempoRev[p]) t = tempoRev[p];
      else if (p.match(/\d+\s*bpm/)) b = p.replace(/[^0-9]/g, '');
    }
    return { mood: m, tempo: t, bpm: b };
  }, []);
  const [bpm, setBpm] = useState(parsedTransfer.bpm);
  const [mood, setMood] = useState(parsedTransfer.mood);
  const [tempo, setTempo] = useState(parsedTransfer.tempo);
  const [stylePrompt, setStylePrompt] = useState("");
  const [isDuet, setIsDuet] = useState<boolean>(_transferredVT === "duet");
  const [lastPromptText, setLastPromptText] = useState("");
  const [copiedPrompt, setCopiedPrompt] = useState(false);
  const [highlightStyles, setHighlightStyles] = useState(!!transferred?.style);
  const [showTransferBanner, setShowTransferBanner] = useState(!!transferred?.fullStyle);
  const pollRef = useRef<ReturnType<typeof setInterval>>();

  const pollStatus = useCallback(async (taskId: string) => {
    try {
      const res = await apiRequest("GET", `/api/music/status/${taskId}`);
      const data = await res.json();
      if (data.status === "done" && (data.audioUrl || data.result)) {
        // Suno returns tracks array; backend normalizes to audioUrl
        const url = data.audioUrl || (Array.isArray(data.result) ? data.result[0]?.audio_url : data.result);
        setResultUrl(url);
        setPolling(false);
        setLoading(false);
        stopBgMusic();
        if (pollRef.current) clearInterval(pollRef.current);
        await refreshUser();
        toast({ title: "Трек готов!" });
        if (isPrivate && lastGenId) {
          apiRequest("POST", `/api/generations/${lastGenId}/privacy`, { isPublic: false }).catch(() => {});
        }
      } else if (data.status === "error" || data.status === "failed") {
        setPolling(false);
        setLoading(false);
        stopBgMusic();
        if (pollRef.current) clearInterval(pollRef.current);
        toast({
          title: "Ошибка генерации",
          description: "Текст сохранён — отредактируйте и попробуйте снова",
          variant: "destructive",
        });
      }
    } catch {
      // keep polling
    }
  }, [refreshUser, toast, isPrivate, lastGenId]);

  // Cleanup: stop bgm when leaving page
  useEffect(() => {
    return () => { stopBgMusic(); if (pollRef.current) clearInterval(pollRef.current); };
  }, []);

  // Active processing generations — для баннера «Идёт процесс генерации».
  // Eugene 2026-05-08: показываем юзеру live-статус, обновляем каждые 10 сек.
  const [activeGens, setActiveGens] = useState<any[]>([]);

  // Resume polling for any processing generation on page load
  useEffect(() => {
    if (!user) return;
    const fetchActive = async () => {
      try {
        const r = await apiRequest("GET", "/api/generations");
        const gens: any[] = await r.json();
        const proc = gens.filter((g: any) => g.status === "processing");
        setActiveGens(proc);
        const processing = proc.find((g: any) => g.type === "music" && g.taskId);
        if (processing && !pollRef.current) {
          setLoading(true);
          setPolling(true);
          setLastGenId(processing.id);
          startBgMusic();
          pollRef.current = setInterval(() => pollStatus(processing.taskId), 5000);
        }
      } catch {}
    };
    fetchActive();
    const tick = setInterval(fetchActive, 10_000);
    return () => {
      clearInterval(tick);
      if (pollRef.current) clearInterval(pollRef.current);
    };
  }, [user]);

  const handleGenerate = async () => {
    if (!user) {
      setShowInlineAuth(true);
      return;
    }

    // ТЗ Eugene 2026-05-08: ОДИНАКОВЫЙ визуал и процесс для всех 3 форм
    // (Audio / Текст·Простой / Текст·Расширенный). После клика — ОСТАЁМСЯ
    // на странице, показываем progress-панель, после готовности — inline
    // AudioPlayer + кнопки. Никаких redirect'ов.
    const runPollAndFinalize = (taskIds: string[], stylesCount: number) => {
      if (taskIds.length === 0) {
        setLoading(false);
        stopBgMusic();
        return;
      }
      setPolling(true);
      setShowLongWait(false);
      const pendingTasks = new Set(taskIds);
      const errorMessages: string[] = [];
      let doneCount = 0;
      // Eugene 2026-05-08 docs-first audit: client-side 30-мин hard timeout.
      // Eugene 2026-05-08: после 3 мин — предложение «подождать ещё / открыть
      // дашборд» (Suno иногда думает дольше — не нагнетаем тревогу).
      const startedAt = Date.now();
      const MAX_POLL_MS = 30 * 60 * 1000;
      const LONG_WAIT_MS = 3 * 60 * 1000;
      pollRef.current = setInterval(async () => {
        if (Date.now() - startedAt > LONG_WAIT_MS && !showLongWait) {
          setShowLongWait(true);
        }
        if (Date.now() - startedAt > MAX_POLL_MS) {
          if (pollRef.current) clearInterval(pollRef.current);
          setPolling(false);
          setLoading(false);
          setShowLongWait(false);
          stopBgMusic();
          toast({
            title: "Трек ещё готовится 🎵",
            description: "Прошло 30 мин — давайте посмотрим в дашборде. Когда MuziAi закончит, трек появится сам. Баланс в безопасности.",
            duration: 10000,
          });
          await refreshUser();
          return;
        }
        for (const tid of [...pendingTasks]) {
          try {
            const r = await apiRequest("GET", `/api/music/status/${tid}`);
            const d = await r.json();
            if (d.status === "done" || d.status === "error" || d.status === "failed") {
              pendingTasks.delete(tid);
              if (d.status === "done" && d.audioUrl) {
                setResultUrl(d.audioUrl);
                doneCount++;
              } else if (d.status === "error" || d.status === "failed") {
                if (d.userMessage) errorMessages.push(d.userMessage);
                else if (d.message) errorMessages.push(d.message);
                else errorMessages.push("Не удалось создать трек");
              }
            }
          } catch {}
        }
        if (pendingTasks.size === 0) {
          setPolling(false);
          setLoading(false);
          setShowLongWait(false);
          stopBgMusic();
          if (pollRef.current) clearInterval(pollRef.current);
          await refreshUser();
          if (doneCount > 0 && errorMessages.length === 0) {
            toast({ title: doneCount > 1 ? `${doneCount} треков готово` : "Трек готов!" });
          } else if (doneCount > 0 && errorMessages.length > 0) {
            toast({
              title: `Готово: ${doneCount}, отклонено: ${errorMessages.length}`,
              description: errorMessages[0].slice(0, 200),
              variant: "destructive",
            });
          } else {
            toast({
              title: "Трек не создан",
              description: errorMessages[0] || "Неизвестная ошибка. Баланс возвращён.",
              variant: "destructive",
              duration: 12000,
            });
          }
        }
      }, 5000);
      if (stylesCount > 1 && taskIds.length > 0) {
        toast({ title: `Запущено ${taskIds.length} треков`, description: "Слушайте здесь — все треки также сохранены в личном кабинете" });
      }
    };

    // Audio mode — голос → текст уже распознан, шлём на ПРОВЕРЕННЫЙ
    // /api/music/generate (тот же endpoint что Текст·Расширенный).
    // ТЗ Eugene 13:53 «реши кардинально» — без отдельного audio-cover.
    if (mode === "audio") {
      // ТЗ Eugene 14:39 «возьми из text-mode и поставь в audio».
      // Точная копия рабочего text-mode pipeline: тот же loop, тот же body.
      const finalLyrics = audioLyrics.trim();
      if (!finalLyrics || finalLyrics.length < 50) {
        toast({ title: "Текст слишком короткий", description: "Нужно минимум 50 символов lyrics. Запиши голос ещё раз или дополни вручную.", variant: "destructive" });
        return;
      }
      // Для audio используем selectedStyles если есть, иначе суггестию LLM, иначе pop
      const audioStyles = audioMode === "advanced" && selectedStyles.length > 0
        ? selectedStyles
        : [stylePrompt.trim() || audioSuggestion?.genre || "pop"];
      setLoading(true);
      startBgMusic();
      setResultUrl(null);
      setLastPromptText(finalLyrics);
      const audioTaskIds: string[] = [];
      let lastIdAudio: number | null = null;
      let errorCountAudio = 0;
      let lastErrorAudio = "";
      for (let i = 0; i < audioStyles.length; i++) {
        const s = audioStyles[i];
        try {
          // Тот же fullStyle-enrichment как у text-mode (Eugene 14:39)
          let fullStyle = s;
          if (tempo) fullStyle += `, ${tempo} tempo`;
          if (isDuet) fullStyle += `, male and female duet, duet vocals`;
          if (mood) fullStyle += `, ${mood.toLowerCase()} mood`;
          if (bpm) fullStyle += `, ${bpm} BPM`;
          if (stylePrompt.trim() && audioMode === "advanced" && !s.includes(stylePrompt.trim())) {
            fullStyle += `, ${stylePrompt.trim()}`;
          }
          const body: any = { category: "song" };
          if (fullStyle) body.style = fullStyle;
          body.lyrics = finalLyrics;
          if (title || audioSuggestion?.title) body.title = title || audioSuggestion?.title;
          body.instrumental = instrumental;
          body.isDuet = isDuet;
          body.voiceType = instrumental ? "instrumental" : isDuet ? "duet" : voice;
          if (!instrumental && !isDuet) body.voice = voice;
          body.authorName = authorName.trim();
          body.isPublic = !isPrivate;
          console.log("[AUDIO-FLOW] step 3/3 generate body:", body);

          const res = await apiRequest("POST", "/api/music/generate", body);
          const data = await res.json();
          console.log("[AUDIO-FLOW] generate response:", data);
          if (data?.id) lastIdAudio = data.id;
          if (data?.taskId) audioTaskIds.push(data.taskId);
          if (!data?.taskId) errorCountAudio++;
        } catch (err: any) {
          errorCountAudio++;
          let serverMsg = "";
          try {
            const m = err.message?.match(/^\d+:\s*(.+)$/);
            if (m) {
              const parsed = JSON.parse(m[1]);
              serverMsg = parsed.message || parsed.error || "";
            }
          } catch {}
          if (err.message?.includes("402")) {
            toast({ title: "Недостаточно средств", description: serverMsg || `Запустилось ${i} из ${audioStyles.length}.`, variant: "destructive" });
            break;
          }
          if (serverMsg) lastErrorAudio = serverMsg;
        }
      }
      if (lastIdAudio) setLastGenId(lastIdAudio);
      if (audioTaskIds.length > 0) {
        // ОСТАЁМСЯ на странице, показываем progress-панель + результат inline
        runPollAndFinalize(audioTaskIds, audioStyles.length);
      } else {
        setLoading(false);
        stopBgMusic();
        toast({
          title: "Не удалось создать песню",
          description: lastErrorAudio || "Сервер не вернул taskId. Проверь логи в /admin/v304.",
          variant: "destructive",
          duration: 10000,
        });
      }
      return;
    }

    const isBasic = mode === "basic";
    // Eugene 2026-05-08: fallback при регенерации — если в текущем mode пусто,
    // но в другом поле есть текст, используем его. Иначе юзер видел «Опишите
    // песню» хотя lyrics были заполнены из musicRegenerate.
    let mainPrompt = isBasic ? prompt : (legacyMode === "simple" ? prompt : lyrics);
    if (!mainPrompt.trim()) {
      mainPrompt = (lyrics || prompt || "").trim();
    }
    if (!mainPrompt.trim()) {
      toast({ title: isBasic ? "Опишите песню" : (legacyMode === "simple" ? "Опишите желаемый трек" : "Вставьте текст песни"), variant: "destructive" });
      return;
    }

    // Базовый режим: один трек, без явного стиля. Передаём пустой stylesToGenerate
    // как [""] — handleGenerate ниже не будет добавлять fullStyle если basic.
    const stylesToGenerate = isBasic ? [""] : (selectedStyles.length > 0 ? selectedStyles : [style]);

    setLoading(true);
    startBgMusic();
    setResultUrl(null);
    setHighlightStyles(false);
    setLastPromptText(legacyMode === "simple" ? prompt : lyrics);
    setUsedStyles(prev => {
      const next = [...prev];
      for (const s of stylesToGenerate) { if (!next.includes(s)) next.push(s); }
      return next;
    });

    const allTaskIds: string[] = [];
    let lastId: number | null = null;
    let errorCount = 0;
    let lastErrorMsg = "";

    for (let i = 0; i < stylesToGenerate.length; i++) {
      const s = stylesToGenerate[i];
      try {
        // Базовый режим — стиль не задаём, нормализатор/Suno решат сами.
        // Расширенный — собираем enriched style.
        let fullStyle = "";
        if (!isBasic) {
          fullStyle = s;
          if (tempo) fullStyle += `, ${tempo} tempo`;
          if (isDuet) fullStyle += `, male and female duet, duet vocals`;
          if (mood) fullStyle += `, ${mood.toLowerCase()} mood`;
          if (bpm) fullStyle += `, ${bpm} BPM`;
          if (stylePrompt.trim()) fullStyle += `, ${stylePrompt.trim()}`;
        }

        const body: any = { category: songCategory };
        if (fullStyle) body.style = fullStyle;
        if (isBasic) {
          body.prompt = prompt;
        } else if (legacyMode === "simple") {
          body.prompt = prompt;
        } else {
          body.lyrics = lyrics;
          if (title) body.title = title;
        }
        body.instrumental = instrumental;
        body.isDuet = isDuet;
        // Eugene 2026-05-07: всегда отправляем явный voiceType, не только
        // когда не-instrumental + не-duet. Сервер использует normalizeVocalParams
        // как единый источник правды и больше не дефолтит на Female.
        body.voiceType = instrumental ? "instrumental"
          : isDuet ? "duet"
          : voice; // 'male' | 'female'
        // legacy 'voice' — оставляем для совместимости с не-обновлённым сервером.
        if (!instrumental && !isDuet) body.voice = voice;
        body.authorName = authorName.trim();
        body.isPublic = !isPrivate;

        const res = await apiRequest("POST", "/api/music/generate", body);
        const data = await res.json();

        if (data.id) lastId = data.id;
        if (data.taskId) allTaskIds.push(data.taskId);
        if (!data.taskId) errorCount++;
      } catch (err: any) {
        errorCount++;
        // Extract server error message (apiRequest throws "STATUS: <JSON body>")
        let serverMsg = "";
        try {
          const m = err.message?.match(/^\d+:\s*(.+)$/);
          if (m) {
            const parsed = JSON.parse(m[1]);
            serverMsg = parsed.message || parsed.error || "";
          }
        } catch {}
        if (err.message?.includes("402")) {
          toast({
            title: "Недостаточно средств",
            description: `Удалось запустить ${i} из ${stylesToGenerate.length} треков. Пополните баланс.`,
            variant: "destructive",
          });
          break;
        }
        if (serverMsg) {
          lastErrorMsg = serverMsg;
        }
      }
    }

    if (lastId) setLastGenId(lastId);

    if (allTaskIds.length > 0) {
      runPollAndFinalize(allTaskIds, stylesToGenerate.length);
    } else {
      setLoading(false);
      stopBgMusic();
      toast({
        title: "Ошибка создания",
        description: lastErrorMsg || "Текст сохранён. Попробуйте снова.",
        variant: "destructive",
      });
    }
  };

  const handleDownload = () => {
    if (!resultUrl) return;
    const a = document.createElement("a");
    a.href = resultUrl;
    a.download = "track-muziai.mp3";
    a.target = "_blank";
    a.click();
  };

  return (
    <div className="min-h-screen pt-20 px-4 pb-12 hero-gradient">
      <div className="max-w-3xl mx-auto">
        {/* Eugene 2026-05-08: «Идёт процесс генерации» live-статус.
            Берём из activeGens (обновляются каждые 10 сек). */}
        {activeGens.length > 0 && (
          <div className="mb-4 rounded-xl border border-purple-500/40 bg-gradient-to-r from-purple-500/15 to-blue-500/15 p-3 flex items-center gap-3 animate-pulse">
            <div className="w-2.5 h-2.5 rounded-full bg-purple-400 animate-ping shrink-0" />
            <div className="flex-1 min-w-0">
              <p className="text-sm font-semibold text-purple-100">
                🔄 Идёт процесс генерации: {activeGens.length} {activeGens.length === 1 ? "трек" : "трека"}
              </p>
              <p className="text-xs text-purple-200/80 truncate">
                {activeGens.slice(0, 3).map((g) => g.displayTitle || g.prompt?.slice(0, 40) || `#${g.id}`).join(" · ")}
                {activeGens.length > 3 && ` · ещё ${activeGens.length - 3}`}
              </p>
            </div>
          </div>
        )}

        {/* Header */}
        <div className="flex items-center gap-3 mb-8">
          <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-blue-500 to-blue-700 flex items-center justify-center">
            <Music className="w-5 h-5 text-white" />
          </div>
          <div>
            <h1 className="text-xl font-bold text-white font-display tracking-wide" data-testid="text-music-title">Музыка + Вокал</h1>
            <p className="text-sm text-muted-foreground">Полноценная песня с помощью MuziAi</p>
          </div>
          <span className="ml-auto price-badge" data-testid="badge-price-music">299 ₽</span>
        </div>

        {/* Яркий баннер характеристик при переходе из плеера */}
        {showTransferBanner && transferred?.fullStyle && (
          <div className="mb-4 p-3 rounded-xl border-2 border-purple-500/50 bg-purple-500/10 animate-in fade-in slide-in-from-top-2 duration-500">
            <div className="flex items-center justify-between mb-2">
              <p className="text-sm font-bold text-purple-300 flex items-center gap-2">
                <Sparkles className="w-4 h-4" /> Создай в том же стиле
              </p>
              <button onClick={() => setShowTransferBanner(false)} className="text-xs text-muted-foreground hover:text-white">×</button>
            </div>
            <div className="flex flex-wrap gap-1.5">
              {transferred.fullStyle.split(' \u00b7 ').map((part: string, i: number) => (
                <span key={i} className={`text-xs px-2.5 py-1 rounded-lg font-medium ${
                  i === 0 ? 'bg-purple-500/30 text-purple-200 border border-purple-400/40' :
                  part.match(/\d+\s*BPM/i) ? 'bg-orange-500/30 text-orange-200 border border-orange-400/40' :
                  'bg-pink-500/20 text-pink-200 border border-pink-400/30'
                }`}>
                  {part}
                </span>
              ))}
              {parsedTransfer.bpm && (
                <span className="text-xs px-2.5 py-1 rounded-lg font-medium bg-orange-500/30 text-orange-200 border border-orange-400/40">
                  {parsedTransfer.bpm} BPM
                </span>
              )}
            </div>
            <p className="text-[10px] text-muted-foreground/60 mt-2">Параметры установлены — напишите текст и нажмите Создать</p>
          </div>
        )}

        {/* Категория: Песня / Поздравление */}
        <div className="mb-4 flex gap-2">
          <button
            type="button"
            className={`flex-1 py-2.5 rounded-xl text-sm font-medium transition-colors border ${songCategory === 'greeting' ? 'border-pink-500/40 bg-pink-500/15 text-pink-300' : 'border-white/10 bg-white/5 text-muted-foreground hover:text-white'}`}
            onClick={() => setSongCategory('greeting')}
          >
            🎉 Песня-поздравление
          </button>
          <button
            type="button"
            className={`flex-1 py-2.5 rounded-xl text-sm font-medium transition-colors border ${songCategory === 'song' ? 'border-purple-500/40 bg-purple-500/15 text-purple-300' : 'border-white/10 bg-white/5 text-muted-foreground hover:text-white'}`}
            onClick={() => setSongCategory('song')}
          >
            🎵 Песня
          </button>
        </div>

        {/* Mode Toggle — 3 режима. Аудио слева, синий, с микрофоном+эквалайзером.
            Затем «Текст Простой» / «Текст Расширенный» (ТЗ Eugene 2026-05-07). */}
        <div ref={modeTabsRef} className="mb-6 flex items-start justify-between gap-3 flex-wrap scroll-mt-24">
          <Tabs value={mode} onValueChange={(v) => setMode(v as any)}>
            <TabsList className="bg-black/30 border border-white/10 h-auto p-1 gap-1 backdrop-blur-md">
              <TabsTrigger
                value="audio"
                className="group hardware-button data-[state=active]:bg-gradient-to-b data-[state=active]:from-cyan-500/25 data-[state=active]:to-cyan-500/5 data-[state=active]:text-white px-4 py-2 rounded-lg transition-all"
                data-testid="tab-audio"
              >
                <span className="inline-flex items-center gap-2">
                  <StudioMicEq size="sm" />
                  <span className="font-medium font-display tracking-wide">Аудио</span>
                  {mode === "audio" && <span className="led-indicator text-cyan-400" />}
                </span>
              </TabsTrigger>
              <TabsTrigger
                value="basic"
                className="hardware-button data-[state=active]:bg-gradient-to-b data-[state=active]:from-purple-500/25 data-[state=active]:to-purple-500/5 data-[state=active]:text-white px-3 py-2 rounded-lg transition-all"
                data-testid="tab-basic"
              >
                <span className="inline-flex items-center gap-1.5">
                  <FileText className="w-4 h-4 text-purple-300" />
                  <span className="font-medium font-display tracking-wide">Текст · Простой</span>
                  {mode === "basic" && <span className="led-indicator text-purple-400" />}
                </span>
              </TabsTrigger>
              <TabsTrigger
                value="advanced"
                className="hardware-button data-[state=active]:bg-gradient-to-b data-[state=active]:from-purple-600/30 data-[state=active]:to-purple-600/5 data-[state=active]:text-white px-3 py-2 rounded-lg transition-all"
                data-testid="tab-advanced"
              >
                <span className="inline-flex items-center gap-1.5">
                  <Settings2 className="w-4 h-4 text-purple-200" />
                  <span className="font-medium font-display tracking-wide">Текст · Расширенный</span>
                  {mode === "advanced" && <span className="led-indicator text-purple-300" />}
                </span>
              </TabsTrigger>
            </TabsList>
          </Tabs>
          <style>{`
            @keyframes eq-bar1 { 0%,100%{height:20%}50%{height:80%} }
            @keyframes eq-bar2 { 0%,100%{height:50%}50%{height:30%} }
            @keyframes eq-bar3 { 0%,100%{height:90%}50%{height:45%} }
            .animate-eq-bar1 { animation: eq-bar1 0.9s ease-in-out infinite; }
            .animate-eq-bar2 { animation: eq-bar2 1.1s ease-in-out infinite; }
            .animate-eq-bar3 { animation: eq-bar3 0.7s ease-in-out infinite; }
          `}</style>

          {/* Помощник-человечек справа — описание режимов */}
          <HelpBuddy
            title="Какой режим выбрать?"
            variant="cyan"
            sections={[
              {
                icon: <Mic />, color: "text-cyan-300", label: "🎤 Аудио",
                text: <>Записал голосом — получил песню. Самый быстрый. Качество среднее.</>,
              },
              {
                icon: <FileText />, color: "text-purple-300", label: "Текст · Простой",
                text: <>Описал одной фразой — MuziAi подобрал стиль. Быстро, качество среднее.</>,
              },
              {
                icon: <Settings2 />, color: "text-purple-200", label: "Текст · Расширенный",
                text: <>Полный контроль: жанр, BPM, темп, текст, мульти-стиль. Самый точный.</>,
              },
            ]}
          >
            <div className="pt-2 border-t border-white/10 text-[10px] text-muted-foreground/70">
              Голос (мужской / женский / дуэт / инструментал) выбирается в любом режиме отдельно.
            </div>
          </HelpBuddy>
        </div>

        {/* Аудио-режим — sub-tabs Простой/Расширенный */}
        {mode === "audio" && (
          <div className="mb-4">
            <Tabs value={audioMode} onValueChange={(v) => setAudioMode(v as any)}>
              <TabsList className="bg-black/30 border border-white/10 backdrop-blur-md">
                <TabsTrigger value="simple" className="hardware-button data-[state=active]:bg-gradient-to-b data-[state=active]:from-cyan-400/15 data-[state=active]:to-cyan-400/[0.04] data-[state=active]:text-white font-display tracking-wide" data-testid="tab-audio-simple">
                  Простой
                </TabsTrigger>
                <TabsTrigger value="advanced" className="hardware-button data-[state=active]:bg-gradient-to-b data-[state=active]:from-cyan-500/30 data-[state=active]:to-cyan-500/5 data-[state=active]:text-white font-display tracking-wide" data-testid="tab-audio-advanced">
                  Расширенный
                </TabsTrigger>
              </TabsList>
            </Tabs>
          </div>
        )}

        {/* Breadcrumb текущего режима — Eugene 2026-05-09 (Phase 3 audit):
            «юзер видит за 1 секунду я в режиме Y семейства X». */}
        <div className="mb-3 text-[11px] text-muted-foreground font-display tracking-wider flex items-center gap-1.5" data-testid="breadcrumb-mode">
          <span className={mode === "audio" ? "text-cyan-300" : "text-purple-300"}>
            {mode === "audio" ? "🎤 Аудио" : "📄 Текст"}
          </span>
          <span className="text-muted-foreground/40">·</span>
          <span className="text-white/80">
            {mode === "audio"
              ? (audioMode === "simple" ? "Простой" : "Расширенный")
              : mode === "basic" ? "Простой" : "Расширенный"}
          </span>
        </div>

        {/* Form */}
        <div className="gradient-border p-6 rounded-2xl space-y-5 mb-6">
          {/* === БАЗОВЫЙ РЕЖИМ — минимум полей, без выбора стиля === */}
          {mode === "basic" ? (
            <>
              <div className="space-y-2">
                <Label className="text-sm text-muted-foreground">Опишите песню в свободной форме</Label>
                <Textarea
                  placeholder="Например: грустная баллада о расставании / весёлый детский гимн ко дню рождения / эпический рок про космос…"
                  value={prompt}
                  onChange={(e) => setPrompt(e.target.value)}
                  rows={5}
                  className="bg-background/50 border-white/10 input-glow resize-none"
                  data-testid="input-basic-prompt"
                />
                <p className="text-[10px] text-muted-foreground/70">
                  Стиль и темп выберет MuziAi автоматически. Достаточно описать настроение и тему.
                </p>
              </div>
              {/* Voice — 4 равные ячейки, единый shell (Eugene 13:18) */}
              <div className="space-y-2">
                <Label className="text-sm text-muted-foreground">Голос</Label>
                <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 p-1 rounded-2xl bg-gradient-to-br from-white/[0.03] to-transparent border border-white/[0.06]">
                  <button type="button"
                    className={`h-14 rounded-xl border hardware-button flex flex-col items-center justify-center gap-0.5 text-sm font-medium transition-all ${!instrumental && !isDuet && voice === "female" ? "border-purple-400/60 bg-gradient-to-br from-purple-500/30 to-pink-500/20 text-purple-100 shadow-lg shadow-purple-500/30 scale-[1.02]" : "border-white/10 bg-white/5 text-muted-foreground hover:text-white hover:border-white/20 hover:bg-white/10"}`}
                    onClick={() => { setInstrumental(false); setIsDuet(false); setVoice("female"); }}
                    data-testid="btn-basic-female">
                    <span className="text-lg leading-none">👩‍🎤</span>
                    <span className="text-[11px] leading-none">Женский</span>
                  </button>
                  <button type="button"
                    className={`h-14 rounded-xl border hardware-button flex flex-col items-center justify-center gap-0.5 text-sm font-medium transition-all ${!instrumental && !isDuet && voice === "male" ? "border-blue-400/60 bg-gradient-to-br from-blue-500/30 to-cyan-500/20 text-blue-100 shadow-lg shadow-blue-500/30 scale-[1.02]" : "border-white/10 bg-white/5 text-muted-foreground hover:text-white hover:border-white/20 hover:bg-white/10"}`}
                    onClick={() => { setInstrumental(false); setIsDuet(false); setVoice("male"); }}
                    data-testid="btn-basic-male">
                    <span className="text-lg leading-none">👨‍🎤</span>
                    <span className="text-[11px] leading-none">Мужской</span>
                  </button>
                  <button type="button"
                    className={`h-14 rounded-xl border hardware-button flex flex-col items-center justify-center gap-0.5 text-sm font-medium transition-all ${isDuet ? "border-pink-400/60 bg-gradient-to-br from-pink-500/30 to-rose-500/20 text-pink-100 shadow-lg shadow-pink-500/30 scale-[1.02]" : "border-white/10 bg-white/5 text-muted-foreground hover:text-white hover:border-white/20 hover:bg-white/10"}`}
                    onClick={() => { setInstrumental(false); setIsDuet(true); }}
                    data-testid="btn-basic-duet">
                    <span className="text-lg leading-none">👩‍🎤👨‍🎤</span>
                    <span className="text-[11px] leading-none">Дуэт</span>
                  </button>
                  <button type="button"
                    className={`h-14 rounded-xl border hardware-button flex flex-col items-center justify-center gap-0.5 text-sm font-medium transition-all ${instrumental ? "border-amber-400/60 bg-gradient-to-br from-amber-500/30 to-orange-500/20 text-amber-100 shadow-lg shadow-amber-500/30 scale-[1.02]" : "border-white/10 bg-white/5 text-muted-foreground hover:text-white hover:border-white/20 hover:bg-white/10"}`}
                    onClick={() => { setIsDuet(false); setInstrumental(true); }}
                    data-testid="btn-basic-instrumental">
                    <span className="text-lg leading-none">🎻</span>
                    <span className="text-[11px] leading-none">Инструментал</span>
                  </button>
                </div>
              </div>
            </>
          ) : mode === "audio" ? (
            <>
              {/* === АУДИО-РЕЖИМ — микрофон ИЛИ файл === */}
              {/* Eugene 2026-05-08 «усиль контроль точка: генерация аудио,
                  распознавание, генерация текста». Visual status-strip:
                  юзер видит на каком шаге пайплайн прямо сейчас. */}
              <div className="grid grid-cols-4 gap-1.5 mb-3">
                {[
                  { label: "🎤 Запись", active: !!audioFile, current: !audioFile && !audioUploadSha },
                  { label: "📤 Загрузка", active: !!audioUploadSha, current: audioUploading },
                  { label: "🔤 Распознавание", active: !!audioLyrics, current: transcribing },
                  { label: "🎵 Готов к генерации", active: !!audioLyrics && audioLyrics.length >= 50, current: false },
                ].map((step, i) => (
                  <div
                    key={i}
                    className={`relative text-center text-[10px] sm:text-xs py-2 px-1 rounded-md border hardware-button overflow-hidden transition-all ${
                      step.active
                        ? "border-emerald-500/50 bg-gradient-to-b from-emerald-500/15 to-emerald-500/5 text-emerald-200"
                        : step.current
                          ? "border-purple-500/50 bg-gradient-to-b from-purple-500/15 to-purple-500/5 text-purple-200"
                          : "border-white/10 bg-white/[0.03] text-muted-foreground/60"
                    }`}
                  >
                    <span className="inline-flex items-center gap-1.5 font-display">
                      {step.active && <span className="led-indicator text-emerald-400" />}
                      {step.current && !step.active && <span className="led-indicator text-purple-400" />}
                      {step.label}
                    </span>
                    {(step.active || step.current) && (
                      <span
                        className={`absolute left-0 bottom-0 h-[2px] ${
                          step.active ? "w-full bg-emerald-400/80 shadow-[0_0_8px_rgba(52,211,153,0.6)]" : "w-1/2 bg-purple-400/80 shadow-[0_0_8px_rgba(167,139,250,0.6)] animate-pulse"
                        }`}
                      />
                    )}
                  </div>
                ))}
              </div>
              <div className="space-y-3">
                <Label className="text-sm text-muted-foreground">🎤 Запись с микрофона (до 30 секунд)</Label>
                <MicRecorder
                  maxSeconds={30}
                  onRecorded={async (file) => {
                    setAudioFile(file);
                    setAudioUploadSha(null);
                    setAudioTranscript("");
                    setAudioLyrics("");
                    setAudioSuggestion(null);
                    if (!user) {
                      setShowInlineAuth(true);
                      toast({ title: "Войдите", description: "Чтобы использовать аудио-генерацию, нужен аккаунт. Бесплатно за 30 сек.", variant: "destructive" });
                      return;
                    }
                    // Видимый прогресс по шагам (Eugene 12:32 — «надиктовал но
                    // не появляется транскрибация»). Раньше silent fail.
                    try {
                      console.log("[AUDIO-FLOW] step 1/3: uploading", { size: file.size, type: file.type });
                      setAudioUploading(true);
                      toast({ title: "📤 Загружаю файл…", description: `${Math.round(file.size / 1024)} KB` });
                      const fd = new FormData();
                      fd.append("audio", file);
                      const up = await fetch("/api/gen/upload", { method: "POST", body: fd });
                      const upJson = await up.json().catch(() => ({}));
                      console.log("[AUDIO-FLOW] upload response", { status: up.status, ok: up.ok, body: upJson });
                      if (up.status === 401) {
                        setShowInlineAuth(true);
                        toast({ title: "401 — войдите", description: "Сессия истекла. Перелогиньтесь.", variant: "destructive" });
                        return;
                      }
                      if (!up.ok || !upJson?.data?.sha) {
                        toast({ title: `❌ Upload ${up.status}`, description: upJson?.error || "Сервер не вернул sha", variant: "destructive" });
                        return;
                      }
                      const sha = upJson.data.sha;
                      setAudioUploadSha(sha);
                      setAudioUploadUrl(upJson.data.uploadUrl);
                      setAudioUploading(false);
                      toast({ title: "✅ Загружено", description: `Файл сохранён (sha=${sha.slice(0, 8)}…). Распознаю голос…` });

                      console.log("[AUDIO-FLOW] step 2/3: transcribing");
                      setTranscribing(true);
                      const t = await fetch("/api/gen/transcribe", {
                        method: "POST",
                        headers: { "Content-Type": "application/json" },
                        body: JSON.stringify({
                          uploadSha: sha,
                          style: stylePrompt.trim() || undefined,
                          bpm: bpm || undefined,
                          mood: mood || undefined,
                          tempo: tempo || undefined,
                          voiceType: instrumental ? "instrumental" : isDuet ? "duet" : voice,
                        }),
                      });
                      const tJson = await t.json().catch(() => ({}));
                      console.log("[AUDIO-FLOW] transcribe response", { status: t.status, body: tJson });
                      if (t.status === 401) {
                        setShowInlineAuth(true);
                        toast({ title: "401 на transcribe", variant: "destructive" });
                        return;
                      }
                      if (!t.ok) {
                        toast({ title: `❌ Transcribe ${t.status}`, description: tJson?.error || "сервер вернул ошибку", variant: "destructive" });
                        return;
                      }
                      if (tJson?.data?.warning) {
                        toast({ title: "⚠ Не удалось распознать", description: tJson.data.warning, variant: "destructive" });
                      }
                      if (tJson?.data?.transcript) setAudioTranscript(tJson.data.transcript);
                      if (tJson?.data?.suggestion) {
                        setAudioSuggestion(tJson.data.suggestion);
                        if (tJson.data.suggestion.lyrics) setAudioLyrics(tJson.data.suggestion.lyrics);
                        toast({ title: "✅ Текст готов", description: "Можете править или нажать ReТекст для другого варианта." });
                      } else if (tJson?.data?.llmError) {
                        // Eugene 2026-05-09: транскрипт получен, но LLM не сделал lyrics.
                        // Показываем точную ошибку чтобы было понятно что чинить.
                        toast({
                          title: "⚠ Транскрипция получена, но генерация текста упала",
                          description: tJson.data.llmError,
                          variant: "destructive"
                        });
                      } else if (tJson?.data?.fallbackToManual) {
                        // Eugene 2026-05-09: показываем точную причину (warning),
                        // которая теперь содержит реальный ответ Yandex
                        // (HTTP status / empty result / ffmpeg fail / network).
                        toast({
                          title: "📝 Не распознано — введите текст вручную",
                          description: tJson.data.warning || "Yandex SpeechKit временно недоступен. Наберите описание ниже.",
                          variant: "destructive",
                        });
                      }
                    } catch (err) {
                      const m = err instanceof Error ? err.message : "fail";
                      console.error("[AUDIO-FLOW] error", err);
                      toast({ title: "❌ Ошибка обработки", description: m, variant: "destructive" });
                    } finally {
                      setAudioUploading(false);
                      setTranscribing(false);
                    }
                  }}
                  disabled={loading || audioUploading || transcribing}
                />
                {transcribing && (
                  <div className="text-xs text-cyan-300 flex items-center gap-2">
                    <Loader2 className="w-3 h-3 animate-spin" />
                    Распознаю голос и пишу текст песни… (15-30 сек)
                  </div>
                )}
                {/* Транскрипция — cosmic disclosure (Eugene 2026-05-09). Полупрозрачное
                    раскрытие на смартфоне, закрытие — cosmic-fade. Авто-сворачивание
                    после готовности lyrics (Eugene 13:21). */}
                {audioTranscript && (
                  <div>
                    <button
                      type="button"
                      onClick={() => {
                        if (transcriptExiting) return;
                        if (transcriptOpen) {
                          setTranscriptExiting(true);
                          setTimeout(() => { setTranscriptOpen(false); setTranscriptExiting(false); }, 420);
                        } else {
                          setTranscriptOpen(true);
                        }
                      }}
                      className="w-full cursor-pointer list-none p-2.5 rounded-lg border border-cyan-500/20 bg-cyan-500/5 text-[11px] text-cyan-300 flex items-center gap-2 hover:bg-cyan-500/10 transition-colors"
                      data-testid="btn-transcript-toggle"
                    >
                      <ChevronDown className={`w-3 h-3 transition-transform ${transcriptOpen ? "rotate-180" : ""}`} />
                      📝 Что я услышал ({audioTranscript.length} симв.)
                    </button>
                    {transcriptOpen && (
                      <div
                        className={`mt-2 px-3 py-2 text-xs italic text-muted-foreground leading-relaxed rounded-lg border border-cyan-500/15 bg-cyan-500/[0.06] sm:bg-transparent sm:border-transparent backdrop-blur-md sm:backdrop-blur-none ${transcriptExiting ? "cosmic-disclosure-exit" : "cosmic-disclosure-enter"}`}
                        data-testid="text-transcript"
                      >
                        {audioTranscript}
                      </div>
                    )}
                  </div>
                )}
                {audioSuggestion && (audioSuggestion.genre || audioSuggestion.templateSlug) && (
                  <div className="flex flex-wrap gap-2 text-[10px]">
                    {audioSuggestion.genre && <span className="px-2 py-1 rounded-full bg-violet-500/15 text-violet-300 border border-violet-500/30">🎨 {audioSuggestion.genre}</span>}
                    {audioSuggestion.bpm && <span className="px-2 py-1 rounded-full bg-amber-500/15 text-amber-300 border border-amber-500/30">⏱ {audioSuggestion.bpm} BPM</span>}
                    {audioSuggestion.templateSlug && <span className="px-2 py-1 rounded-full bg-emerald-500/15 text-emerald-300 border border-emerald-500/30">📁 {audioSuggestion.templateSlug}</span>}
                  </div>
                )}
                {(audioLyrics || audioTranscript) && (
                  <div className="space-y-2 p-4 rounded-2xl border border-cyan-500/40 bg-gradient-to-br from-cyan-500/[0.07] via-purple-500/[0.04] to-transparent shadow-lg shadow-cyan-500/10">
                    <div className="flex items-center justify-between gap-2">
                      <Label className="text-sm text-cyan-200 font-semibold">🎵 Текст песни — правьте до запуска:</Label>
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        className="h-7 text-[11px] border-cyan-500/30 bg-cyan-500/[0.08] text-cyan-200 backdrop-blur-md hover:bg-cyan-500/20 hover:border-cyan-400/60 hover:text-white shadow-[inset_0_0_12px_rgba(34,211,238,0.08)]"
                        disabled={rewriting || !audioTranscript}
                        onClick={async () => {
                          setRewriting(true);
                          try {
                            const r = await fetch("/api/gen/rewrite-lyrics", {
                              method: "POST",
                              headers: { "Content-Type": "application/json" },
                              body: JSON.stringify({
                                transcript: audioTranscript,
                                templateSlug: audioSuggestion?.templateSlug,
                                hint: rewriteHint.trim() || undefined,
                                // Передаём текущие настройки чтобы re-roll учитывал
                                style: stylePrompt.trim() || undefined,
                                bpm: bpm || undefined,
                                mood: mood || undefined,
                                tempo: tempo || undefined,
                                voiceType: instrumental ? "instrumental" : isDuet ? "duet" : voice,
                              }),
                            });
                            const j = await r.json();
                            const s = j?.data?.suggestion;
                            if (s) {
                              setAudioSuggestion(s);
                              if (s.lyrics) setAudioLyrics(s.lyrics);
                            } else {
                              toast({ title: "Не удалось переписать", description: j?.error || "LLM вернул пусто", variant: "destructive" });
                            }
                          } catch (err) {
                            toast({ title: "Ошибка", description: err instanceof Error ? err.message : "fail", variant: "destructive" });
                          } finally {
                            setRewriting(false);
                          }
                        }}
                        data-testid="btn-rewrite-lyrics"
                      >
                        {rewriting ? <><Loader2 className="w-3 h-3 mr-1 animate-spin" />ReТекст…</> : <><RefreshCcw className="w-3 h-3 mr-1" />ReТекст</>}
                      </Button>
                    </div>
                    <Textarea
                      ref={lyricsTextareaRef}
                      value={audioLyrics}
                      onChange={(e) => setAudioLyrics(e.target.value)}
                      rows={10}
                      placeholder="LLM напишет текст из вашего голоса. Если нет — наберите вручную."
                      className="bg-background/60 border-cyan-500/30 text-sm leading-relaxed font-medium resize-y overflow-hidden"
                      data-testid="textarea-audio-lyrics"
                    />
                    <input
                      type="text"
                      value={rewriteHint}
                      onChange={(e) => setRewriteHint(e.target.value)}
                      placeholder="Опц.: добавить пожелание для re-roll'а (например «более грустно» или «больше упомянуть детей»)"
                      className="w-full px-3 py-1.5 text-[11px] rounded bg-background/30 border border-white/10 placeholder:text-muted-foreground/40"
                      data-testid="input-rewrite-hint"
                    />
                  </div>
                )}
                <div className="text-[10px] text-muted-foreground/70">
                  Запишите голосом любую идею — система распознает суть и напишет полноценный текст песни. Текст можно править. Если результат не понравится — на странице трека кнопка «🔄 Перегенерировать».
                </div>
              </div>
              {/* Voice — 4 равные ячейки в единой carded-сетке (Eugene 13:18). */}
              <div className="space-y-2">
                <Label className="text-sm text-muted-foreground">Голос для кавера</Label>
                <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 p-1 rounded-2xl bg-gradient-to-br from-white/[0.03] to-transparent border border-white/[0.06]">
                  <button type="button"
                    className={`h-14 rounded-xl border hardware-button flex flex-col items-center justify-center gap-0.5 text-sm font-medium transition-all ${!instrumental && !isDuet && voice === "female" ? "border-purple-400/60 bg-gradient-to-br from-purple-500/30 to-pink-500/20 text-purple-100 shadow-lg shadow-purple-500/30 scale-[1.02]" : "border-white/10 bg-white/5 text-muted-foreground hover:text-white hover:border-white/20 hover:bg-white/10"}`}
                    onClick={() => { setInstrumental(false); setIsDuet(false); setVoice("female"); }}>
                    <span className="text-lg leading-none">👩‍🎤</span>
                    <span className="text-[11px] leading-none">Женский</span>
                  </button>
                  <button type="button"
                    className={`h-14 rounded-xl border hardware-button flex flex-col items-center justify-center gap-0.5 text-sm font-medium transition-all ${!instrumental && !isDuet && voice === "male" ? "border-blue-400/60 bg-gradient-to-br from-blue-500/30 to-cyan-500/20 text-blue-100 shadow-lg shadow-blue-500/30 scale-[1.02]" : "border-white/10 bg-white/5 text-muted-foreground hover:text-white hover:border-white/20 hover:bg-white/10"}`}
                    onClick={() => { setInstrumental(false); setIsDuet(false); setVoice("male"); }}>
                    <span className="text-lg leading-none">👨‍🎤</span>
                    <span className="text-[11px] leading-none">Мужской</span>
                  </button>
                  <button type="button"
                    className={`h-14 rounded-xl border hardware-button flex flex-col items-center justify-center gap-0.5 text-sm font-medium transition-all ${isDuet ? "border-pink-400/60 bg-gradient-to-br from-pink-500/30 to-rose-500/20 text-pink-100 shadow-lg shadow-pink-500/30 scale-[1.02]" : "border-white/10 bg-white/5 text-muted-foreground hover:text-white hover:border-white/20 hover:bg-white/10"}`}
                    onClick={() => { setInstrumental(false); setIsDuet(true); }}>
                    <span className="text-lg leading-none">👩‍🎤👨‍🎤</span>
                    <span className="text-[11px] leading-none">Дуэт</span>
                  </button>
                  <button type="button"
                    className={`h-14 rounded-xl border hardware-button flex flex-col items-center justify-center gap-0.5 text-sm font-medium transition-all ${instrumental ? "border-amber-400/60 bg-gradient-to-br from-amber-500/30 to-orange-500/20 text-amber-100 shadow-lg shadow-amber-500/30 scale-[1.02]" : "border-white/10 bg-white/5 text-muted-foreground hover:text-white hover:border-white/20 hover:bg-white/10"}`}
                    onClick={() => { setIsDuet(false); setInstrumental(true); }}>
                    <span className="text-lg leading-none">🎻</span>
                    <span className="text-[11px] leading-none">Инструментал</span>
                  </button>
                </div>
              </div>
              {audioMode === "advanced" && (
                <>
                  <div className="space-y-2">
                    <Label className="text-sm text-muted-foreground">Стиль (опционально, переопределяет авто-подбор)</Label>
                    <input
                      type="text"
                      placeholder={audioSuggestion?.genre ? `авто: ${audioSuggestion.genre}` : "напр.: acoustic fingerpicking, intimate"}
                      value={stylePrompt}
                      onChange={(e) => setStylePrompt(e.target.value)}
                      className="w-full px-3 py-2 text-sm rounded-lg bg-background/50 border border-white/10 input-glow"
                      data-testid="input-audio-style"
                    />
                  </div>
                  <div className="grid grid-cols-3 gap-2">
                    <div>
                      <Label className="text-[11px] text-muted-foreground">BPM</Label>
                      <input
                        type="number"
                        min={60} max={180}
                        placeholder={audioSuggestion?.bpm ? String(audioSuggestion.bpm) : "120"}
                        value={bpm}
                        onChange={(e) => setBpm(e.target.value)}
                        className="w-full px-2 py-1 text-xs rounded bg-background/50 border border-white/10"
                        data-testid="input-audio-bpm"
                      />
                    </div>
                    <div>
                      <Label className="text-[11px] text-muted-foreground">Настроение</Label>
                      <select
                        value={mood}
                        onChange={(e) => setMood(e.target.value)}
                        className="w-full px-2 py-1 text-xs rounded bg-background/50 border border-white/10"
                        data-testid="select-audio-mood"
                      >
                        <option value="">—</option>
                        <option value="happy">Весёлое</option>
                        <option value="sad">Грустное</option>
                        <option value="romantic">Романтичное</option>
                        <option value="energetic">Энергичное</option>
                        <option value="calm">Спокойное</option>
                        <option value="dramatic">Драматичное</option>
                        <option value="epic">Эпичное</option>
                      </select>
                    </div>
                    <div>
                      <Label className="text-[11px] text-muted-foreground">Темп</Label>
                      <select
                        value={tempo}
                        onChange={(e) => setTempo(e.target.value)}
                        className="w-full px-2 py-1 text-xs rounded bg-background/50 border border-white/10"
                        data-testid="select-audio-tempo"
                      >
                        <option value="">—</option>
                        <option value="slow">Медленный</option>
                        <option value="moderate">Средний</option>
                        <option value="fast">Быстрый</option>
                        <option value="very fast">Очень быстрый</option>
                      </select>
                    </div>
                  </div>

                  {/* Multi-style picker — parity с Текст·Расширенный (Eugene 13:23) */}
                  <div className="space-y-2">
                    <Label className="text-sm text-muted-foreground">Стили <span className="text-white/40">(можно выбрать несколько — будет N треков)</span></Label>
                    <div className="flex flex-wrap gap-2">
                      {styles.map((s) => {
                        const isChecked = selectedStyles.includes(s.value);
                        return (
                          <button
                            key={s.value}
                            type="button"
                            className={`text-xs px-3 py-1.5 rounded-lg border transition-all flex items-center gap-1.5 ${
                              isChecked
                                ? "border-cyan-500 bg-cyan-500/20 text-cyan-100 shadow shadow-cyan-500/20"
                                : "border-white/10 bg-white/5 text-muted-foreground hover:text-white hover:border-white/20"
                            }`}
                            onClick={() => {
                              setSelectedStyles((prev) => {
                                if (prev.includes(s.value)) {
                                  if (prev.length === 1) return prev;
                                  return prev.filter((v) => v !== s.value);
                                }
                                return [...prev, s.value];
                              });
                            }}
                          >
                            <span className={`w-3.5 h-3.5 rounded border flex items-center justify-center text-[9px] ${
                              isChecked ? "border-cyan-400 bg-cyan-500/30 text-cyan-100" : "border-white/20 bg-white/5"
                            }`}>
                              {isChecked ? "✓" : ""}
                            </span>
                            {s.label}
                          </button>
                        );
                      })}
                    </div>
                    {selectedStyles.length > 1 && (
                      <div className="flex items-center gap-2 p-2.5 rounded-lg bg-amber-500/10 border border-amber-500/20">
                        <span className="text-amber-400 text-xs">⚡</span>
                        <p className="text-xs text-amber-300/90">
                          Будет создано <strong>{selectedStyles.length}</strong> кавера в разных стилях. Стоимость: <strong>{selectedStyles.length * 299} ₽</strong>
                        </p>
                      </div>
                    )}
                  </div>

                  {/* Custom title — parity с Текст·Расширенный */}
                  <div className="space-y-2">
                    <Label className="text-sm text-muted-foreground">Название трека <span className="text-white/40">(опционально)</span></Label>
                    <Input
                      value={title}
                      onChange={(e) => setTitle(e.target.value)}
                      placeholder={audioSuggestion?.title || "Например: Мой гимн"}
                      className="bg-background/50 border-white/10 input-glow"
                      data-testid="input-audio-title"
                    />
                  </div>
                </>
              )}
            </>
          ) : (
            // === РАСШИРЕННЫЙ РЕЖИМ — старый код с внутренней Simple/Lyrics подвкладкой ===
            <>
              {/* Sub-tabs внутри Расширенного */}
              <div>
                <Tabs value={legacyMode} onValueChange={(v) => setLegacyMode(v as any)}>
                  <TabsList className="bg-white/5 border border-white/10">
                    <TabsTrigger value="simple" className="data-[state=active]:bg-purple-500/20 data-[state=active]:text-white" data-testid="tab-legacy-simple">
                      По описанию
                    </TabsTrigger>
                    <TabsTrigger value="advanced" className="data-[state=active]:bg-purple-500/20 data-[state=active]:text-white" data-testid="tab-legacy-lyrics">
                      Свой текст
                    </TabsTrigger>
                  </TabsList>
                </Tabs>
              </div>
              {legacyMode === "simple" ? (
            <>
              <div className="space-y-2">
                <Label className="text-sm text-muted-foreground">Опишите желаемый трек</Label>
                <Textarea
                  placeholder="Например: энергичная поп-песня о танцах в ночном клубе, с запоминающимся припевом..."
                  value={prompt}
                  onChange={(e) => setPrompt(e.target.value)}
                  rows={4}
                  className="bg-background/50 border-white/10 input-glow resize-none"
                  data-testid="input-music-prompt"
                />
              </div>

              {/* Один стиль */}
              <div className="space-y-2">
                <Label className="text-sm text-muted-foreground">Стиль</Label>
                <div className="grid grid-cols-2 sm:grid-cols-4 gap-1.5" data-testid="select-music-style">
                  {styles.map((s, idx) => (
                    <button
                      key={s.value}
                      type="button"
                      className={`text-left text-xs px-2.5 py-2 rounded-lg border transition-colors ${
                        style === s.value
                          ? "border-purple-500 bg-purple-500/20 text-purple-300"
                          : "border-white/10 bg-white/5 text-muted-foreground hover:text-white hover:border-white/20"
                      }`}
                      onClick={() => { setStyle(s.value); setSelectedStyles([s.value]); }}
                    >
                      <span className="font-medium">{idx + 1}. {s.label}</span>
                      <span className="block text-[10px] text-muted-foreground/60 mt-0.5">{s.desc}</span>
                    </button>
                  ))}
                </div>

                {/* Темп + Настроение */}
                <div className="grid grid-cols-2 gap-3 mt-3">
                  <div>
                    <Label className="text-xs text-muted-foreground mb-1.5 block">Темп</Label>
                    <div className="flex flex-wrap gap-1">
                      {tempos.map(t => (
                        <button key={t.value} type="button" onClick={() => setTempo(t.value)}
                          className={`text-[10px] px-2 py-1 rounded-md border transition-colors ${tempo === t.value ? 'border-blue-500 bg-blue-500/20 text-blue-300' : 'border-white/10 bg-white/5 text-muted-foreground hover:text-white'}`}>
                          {t.label}
                        </button>
                      ))}
                    </div>
                  </div>
                  <div>
                    <Label className="text-xs text-muted-foreground mb-1.5 block">Настроение</Label>
                    <div className="flex flex-wrap gap-1">
                      {moods.map(m => (
                        <button key={m.value} type="button" onClick={() => setMood(m.value)}
                          className={`text-[10px] px-2 py-1 rounded-md border transition-colors ${mood === m.value ? 'border-pink-500 bg-pink-500/20 text-pink-300' : 'border-white/10 bg-white/5 text-muted-foreground hover:text-white'}`}>
                          {m.label}
                        </button>
                      ))}
                    </div>
                  </div>
                </div>
              </div>
            </>
          ) : (
            /* === РАСШИРЕННЫЙ РЕЖИМ === */
            <>
              <div className="space-y-2">
                <div className="flex items-center justify-between">
                  <Label className="text-sm text-muted-foreground">Текст песни</Label>
                  {lyrics.trim() && (
                    <button type="button" onClick={() => { navigator.clipboard.writeText(lyrics); setCopiedPrompt(true); setTimeout(() => setCopiedPrompt(false), 2000); }}
                      className="text-[10px] px-2 py-0.5 rounded bg-white/5 text-muted-foreground hover:text-white transition-colors flex items-center gap-1">
                      {copiedPrompt ? <><Check className="w-3 h-3" /> Скопировано</> : <><Copy className="w-3 h-3" /> Копировать</>}
                    </button>
                  )}
                </div>
                <Textarea
                  placeholder="Напишите главные Слова, фразы, действия, смысл песни, Имя (имена), кому песня адресована.

Искусственный интеллект Ai сам сгенерирует текст, музыку, вокал.
Вам нужно выбрать кнопками внизу варианты.
На практике 2–3 генерации песни и изменение стилей музыки при этом же тексте — вы получите лучший выбор.

Желаем музыкальных шедевров в соавторстве с Ai ✨"
                  value={lyrics}
                  onChange={(e) => setLyrics(e.target.value)}
                  rows={8}
                  className="bg-background/50 border-white/10 input-glow resize-none"
                  data-testid="input-music-lyrics"
                />
                <div className="flex items-center justify-between text-xs">
                  <p className={
                    lyrics.length > 3000 ? "text-red-400" :
                    lyrics.length > 0 && lyrics.length < 50 ? "text-amber-400" :
                    "text-muted-foreground"
                  }>
                    {lyrics.length} символов
                    {lyrics.length > 3000 ? " — лишние будут обрезаны" :
                     lyrics.length === 0 ? " — свой текст необязателен (Ai напишет сам)" :
                     lyrics.length < 50 ? ` — для своего текста нужно минимум 50 (иначе Ai напишет сам)` :
                     " — свой текст будет использован"}
                  </p>
                </div>

                {/* Detector: имя + отчество в обращении часто блокирует Suno */}
                {(() => {
                  // Паттерн: «Имя, ... Днём рождения» или Два слова с заглавными буквами подряд (имя+отчество)
                  const hasNamePattern = /[А-Я][а-яё]+\s+[А-Я][а-яё]*(евич|ович|евна|овна|ич)/i.test(lyrics);
                  const hasBirthdayName = /[А-Я][а-яё]{2,},\s*с\s*дн/i.test(lyrics);
                  if (lyrics.length > 30 && (hasNamePattern || hasBirthdayName)) {
                    return (
                      <div className="mt-2 p-2.5 rounded-lg bg-amber-500/10 border border-amber-500/30 text-xs text-amber-200" data-testid="warning-name-pattern">
                        ⚠️ <b>Возможна блокировка.</b> MuziAi часто отклоняет тексты с именем и отчеством («Иван Иванович») или прямыми обращениями «Имя, с днём рождения». Чтобы не терять 99 ₽:
                        <ul className="list-disc list-inside mt-1 space-y-0.5">
                          <li>Используйте инициалы: «И. И., с днём»</li>
                          <li>Строчная буква или уменьшительное: «валера» вместо «Валерий»</li>
                          <li>Замените на «друг», «брат», «родной»</li>
                          <li>Или вынесите имя в название трека</li>
                        </ul>
                      </div>
                    );
                  }
                  return null;
                })()}
              </div>
              <div className="space-y-2">
                <Label className="text-sm text-muted-foreground">Название трека</Label>
                <Input
                  placeholder="Мой трек"
                  value={title}
                  onChange={(e) => setTitle(e.target.value)}
                  className="bg-background/50 border-white/10 input-glow"
                  data-testid="input-music-title"
                />
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                {/* Мульти-стили */}
                <div className="space-y-2">
                  <Label className="text-sm text-muted-foreground">Стили <span className="text-white/40">(можно выбрать несколько)</span></Label>
                  <div className="flex flex-wrap gap-2" data-testid="select-music-style">
                    {styles.map((s) => {
                      const isUsed = usedStyles.includes(s.value);
                      const isChecked = selectedStyles.includes(s.value);
                      const isNew = highlightStyles && !isUsed;
                      return (
                        <button
                          key={s.value}
                          type="button"
                          className={`text-xs px-3 py-1.5 rounded-lg border transition-all flex items-center gap-1.5 ${
                            isChecked
                              ? "border-purple-500 bg-purple-500/20 text-purple-300"
                              : isNew
                              ? "border-green-500/50 bg-green-500/10 text-green-300 animate-pulse"
                              : isUsed
                              ? "border-white/5 bg-white/[0.02] text-muted-foreground/50"
                              : "border-white/10 bg-white/5 text-muted-foreground hover:text-white hover:border-white/20"
                          }`}
                          onClick={() => {
                            setHighlightStyles(false);
                            setSelectedStyles(prev => {
                              if (prev.includes(s.value)) {
                                if (prev.length === 1) return prev;
                                const next = prev.filter(v => v !== s.value);
                                setStyle(next[0]);
                                return next;
                              } else {
                                setStyle(s.value);
                                return [...prev, s.value];
                              }
                            });
                          }}
                        >
                          <span className={`w-3.5 h-3.5 rounded border flex items-center justify-center text-[9px] ${
                            isChecked ? "border-purple-400 bg-purple-500/30 text-purple-200" : "border-white/20 bg-white/5"
                          }`}>
                            {isChecked ? "✓" : ""}
                          </span>
                          {s.label}
                          {isUsed && !isChecked && " ✓"}
                        </button>
                      );
                    })}
                  </div>
                  {selectedStyles.length > 1 && (
                    <div className="flex items-center gap-2 p-2.5 rounded-lg bg-amber-500/10 border border-amber-500/20">
                      <span className="text-amber-400 text-xs">⚡</span>
                      <p className="text-xs text-amber-300/90">
                        Будет создано <strong>{selectedStyles.length} {selectedStyles.length <= 4 ? "трека" : "треков"}</strong> в разных стилях.
                        Стоимость: <strong>{selectedStyles.length * 299} ₽</strong>
                      </p>
                    </div>
                  )}
                </div>

                {/* Правая колонка */}
                <div className="space-y-3 pt-6 sm:pt-0 sm:self-end sm:pb-2">
                  <div className="space-y-2">
                    <Label className="text-sm text-muted-foreground">Автор</Label>
                    <Input
                      value={authorName}
                      onChange={(e) => setAuthorName(e.target.value)}
                      placeholder={user?.name || "Ваше имя"}
                      className="bg-background/50 border-white/10 input-glow"
                      data-testid="input-author-name"
                    />
                  </div>

                  <div className="flex items-center gap-3">
                    <Switch
                      checked={instrumental}
                      onCheckedChange={setInstrumental}
                      data-testid="switch-instrumental"
                    />
                    <Label className="text-sm text-muted-foreground cursor-pointer" onClick={() => setInstrumental(!instrumental)}>
                      Инструментальная (без вокала)
                    </Label>
                  </div>
                  {!instrumental && (
                    <div className="space-y-2">
                      <div className="flex items-center gap-2">
                        <Label className="text-sm text-muted-foreground">Голос:</Label>
                        <button
                          className={`px-3 py-1 text-xs rounded-lg border transition-colors ${!isDuet && voice === "female" ? "border-purple-500/40 bg-purple-500/15 text-purple-300" : "border-white/10 bg-white/5 text-muted-foreground hover:text-white"}`}
                          onClick={() => { setVoice("female"); setIsDuet(false); }}
                          data-testid="voice-female"
                        >
                          Женский
                        </button>
                        <button
                          className={`px-3 py-1 text-xs rounded-lg border transition-colors ${!isDuet && voice === "male" ? "border-blue-500/40 bg-blue-500/15 text-blue-300" : "border-white/10 bg-white/5 text-muted-foreground hover:text-white"}`}
                          onClick={() => { setVoice("male"); setIsDuet(false); }}
                          data-testid="voice-male"
                        >
                          Мужской
                        </button>
                        <button
                          className={`px-3 py-1 text-xs rounded-lg border transition-colors ${isDuet ? "border-pink-500/40 bg-pink-500/15 text-pink-300" : "border-white/10 bg-white/5 text-muted-foreground hover:text-white"}`}
                          onClick={() => setIsDuet(!isDuet)}
                        >
                          🎵 Дуэт
                        </button>
                      </div>
                      {isDuet && (
                        <div className="p-3 rounded-lg bg-pink-500/5 border border-pink-500/15 space-y-2">
                          <p className="text-xs text-pink-300/90 font-medium">Разметьте текст для дуэта:</p>
                          <pre className="text-[10px] text-muted-foreground/70 leading-relaxed whitespace-pre-wrap font-mono">{`[Verse 1 - Male Voice]
Твои строки для мужского голоса...

[Verse 2 - Female Voice]
Строки для женского голоса...

[Chorus - Duet]
Поют вместе...`}</pre>
                          <button
                            type="button"
                            className="text-[10px] text-pink-400 hover:text-pink-300 transition-colors"
                            onClick={() => {
                              const tpl = `[Verse 1 - Male Voice]\n\n\n[Verse 2 - Female Voice]\n\n\n[Chorus - Duet]\n\n\n[Bridge - Harmonized Duet]\n`;
                              setLyrics(prev => prev ? prev + "\n\n" + tpl : tpl);
                              setMode("advanced");
                            }}
                          >
                            → Вставить шаблон в текст
                          </button>
                        </div>
                      )}
                    </div>
                  )}

                </div>
              </div>
            </>
          )}

          {/* Настроение + Темп — видно всегда в Текст·Расширенный (Eugene 2026-05-11
              «текст также расширенно как audio»). Раньше Mood гейтился
              legacyMode === "advanced", теперь доступен и в «По описанию». */}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div className="space-y-2">
              <Label className="text-sm text-muted-foreground">Настроение</Label>
              <div className="flex flex-wrap gap-1.5">
                {moods.filter(m => m.value !== "").map(m => (
                  <button
                    key={m.value}
                    type="button"
                    className={`text-xs px-3 py-1.5 rounded-lg border transition-colors ${
                      mood === m.value
                        ? "border-pink-500 bg-pink-500/20 text-pink-300"
                        : "border-white/10 bg-white/5 text-muted-foreground hover:text-white hover:border-white/20"
                    }`}
                    onClick={() => setMood(mood === m.value ? "" : m.value)}
                  >
                    {m.label}
                  </button>
                ))}
              </div>
            </div>
            <div className="space-y-2">
              <Label className="text-sm text-muted-foreground">Темп</Label>
              <div className="flex flex-wrap gap-1.5">
                {tempos.filter(t => t.value !== "").map(t => (
                  <button
                    key={t.value}
                    type="button"
                    className={`text-xs px-3 py-1.5 rounded-lg border transition-colors ${
                      tempo === t.value
                        ? "border-blue-500 bg-blue-500/20 text-blue-300"
                        : "border-white/10 bg-white/5 text-muted-foreground hover:text-white hover:border-white/20"
                    }`}
                    onClick={() => setTempo(tempo === t.value ? "" : t.value)}
                  >
                    {t.label}
                  </button>
                ))}
              </div>
            </div>
          </div>

          {/* Для опытных авторов — теперь доступно в обоих sub-tabs Текст·Расширенный.
              Eugene 2026-05-11: «текст расширенно как audio» — BPM + расширенный
              стиль (английский prompt) видны и в «По описанию» и в «Свой текст». */}
          <div className="border border-white/[0.06] rounded-xl overflow-hidden">
            <button
              type="button"
              className="w-full flex items-center justify-between px-4 py-3 text-sm font-medium text-muted-foreground hover:text-white transition-colors"
              onClick={() => setShowAdvanced(!showAdvanced)}
            >
              <span className="flex items-center gap-2">
                <Sliders className="w-4 h-4 text-purple-400" />
                Для опытных авторов
              </span>
              <ChevronDown className={`w-4 h-4 transition-transform duration-200 ${showAdvanced ? "rotate-180" : ""}`} />
            </button>
            {showAdvanced && (
              <div className="px-4 pb-4 space-y-4 border-t border-white/[0.06] pt-4 animate-in fade-in slide-in-from-top-2 duration-200">
                {/* BPM */}
                <div className="space-y-2">
                  <Label className="text-sm text-muted-foreground">Tempo (BPM)</Label>
                  <div className="flex items-center gap-3">
                    <Input
                      type="number"
                      min={60}
                      max={200}
                      placeholder="120"
                      value={bpm}
                      onChange={(e) => setBpm(e.target.value)}
                      className="bg-background/50 border-white/10 input-glow w-24"
                    />
                    <div className="flex gap-1.5">
                      {[{l: "Медленно", v: "70"}, {l: "Средне", v: "110"}, {l: "Быстро", v: "140"}, {l: "Очень быстро", v: "170"}].map(b => (
                        <button
                          key={b.v}
                          type="button"
                          className={`text-[10px] px-2 py-1 rounded-md border transition-colors ${
                            bpm === b.v
                              ? "border-blue-500/40 bg-blue-500/15 text-blue-300"
                              : "border-white/10 bg-white/5 text-muted-foreground hover:text-white"
                          }`}
                          onClick={() => setBpm(bpm === b.v ? "" : b.v)}
                        >
                          {b.l}
                        </button>
                      ))}
                    </div>
                  </div>
                </div>

                {/* Расширенный стиль */}
                <div className="space-y-2">
                  <Label className="text-sm text-muted-foreground">Расширенный стиль <span className="text-white/30">(на английском)</span></Label>
                  <Input
                    placeholder="Cyberpunk synthwave, aggressive bass, reverb vocals..."
                    value={stylePrompt}
                    onChange={(e) => setStylePrompt(e.target.value)}
                    className="bg-background/50 border-white/10 input-glow"
                  />
                  <p className="text-[10px] text-muted-foreground/60">
                    Дополнительные указания по стилю, звучанию, инструментам. Примеры: deep house with piano, acoustic folk fingerpicking, 80s synthpop with vocoder
                  </p>
                </div>
              </div>
            )}
          </div>

          {/* === КОНЕЦ Расширенного режима. Кнопка Generate — общая для всех 3 mode'ов === */}
            </>
          )}

          {/* Сводка параметров генерации (только Расширенный) */}
          {mode === "advanced" && selectedStyles.length > 0 && (
            <div className="text-[11px] p-3 rounded-lg bg-purple-500/[0.06] border border-purple-500/20 mb-2 space-y-1">
              <p className="text-purple-300/80 text-[10px] font-semibold mb-1">Параметры генерации:</p>
              {selectedStyles.map((sv, i) => {
                const s = styles.find(x => x.value === sv);
                return (
                  <p key={sv} className="text-muted-foreground">
                    <span className="text-purple-300 font-medium">{i + 1}. {s?.label || sv}</span>
                    <span className="text-muted-foreground/40"> — {s?.desc}</span>
                  </p>
                );
              })}
              {(tempo || mood || bpm || isDuet || instrumental) && (
                <p className="text-muted-foreground pt-1 border-t border-white/[0.04] mt-1 flex flex-wrap gap-x-3 gap-y-0.5">
                  {tempo && <span>Темп: <span className="text-blue-300">{tempos.find(t => t.value === tempo)?.label}</span></span>}
                  {mood && <span>Настроение: <span className="text-pink-300">{moods.find(m => m.value === mood)?.label}</span></span>}
                  {bpm && <span>Скорость: <span className="text-orange-300">{bpm} BPM</span></span>}
                  {isDuet && <span className="text-yellow-300">Дуэт</span>}
                  {instrumental && <span className="text-cyan-300">Инструментал</span>}
                </p>
              )}
            </div>
          )}

          {/* === MAGIC GENERATE BUTTON ===
              Магический звон + вспышка при клике + пульсирующее свечение.
              ТЗ Eugene 2026-05-07 13:00: «приятная музыка, вспышка,
              магический свет, сказка». */}
          <button
            type="button"
            disabled={
              loading || audioUploading || transcribing
              || (mode === "advanced" && selectedStyles.length === 0)
              || (mode === "basic" && !prompt.trim())
              || (mode === "audio" && !audioFile)
            }
            onClick={(e) => {
              // Космический звон + вспышка при клике
              const btn = e.currentTarget;
              btn.classList.add("magic-flash");
              setTimeout(() => btn.classList.remove("magic-flash"), 600);
              try {
                const ctx = new ((window as any).AudioContext || (window as any).webkitAudioContext)();
                const now = ctx.currentTime;
                [523.25, 659.25, 783.99, 1046.50].forEach((freq, i) => {
                  const osc = ctx.createOscillator();
                  const gain = ctx.createGain();
                  osc.type = "sine";
                  osc.frequency.setValueAtTime(freq, now);
                  gain.gain.setValueAtTime(0, now + i * 0.04);
                  gain.gain.linearRampToValueAtTime(0.06, now + i * 0.04 + 0.04);
                  gain.gain.exponentialRampToValueAtTime(0.001, now + 0.9 + i * 0.1);
                  osc.connect(gain).connect(ctx.destination);
                  osc.start(now + i * 0.04);
                  osc.stop(now + 1.2);
                });
                setTimeout(() => ctx.close(), 1500);
              } catch {}
              setPulseGenerate(false);
              handleGenerate();
            }}
            className={`magic-btn btn-cosmic group relative w-full h-16 rounded-2xl text-base sm:text-lg font-bold text-white overflow-hidden transition-all duration-300 disabled:opacity-50 disabled:cursor-not-allowed disabled:saturate-50 ${pulseGenerate ? "animate-pulse ring-4 ring-purple-400/60 ring-offset-2 ring-offset-background scale-105" : ""}`}
            data-testid="button-generate-music"
          >
            {/* Pulsing glow layer */}
            <span aria-hidden className="absolute inset-0 rounded-2xl opacity-70 group-hover:opacity-100 transition-opacity"
              style={{
                background: "radial-gradient(circle at 30% 50%, rgba(255,255,255,0.25), transparent 60%)",
                animation: "magic-shine 3s ease-in-out infinite",
              }}
            />
            {/* Sparkle dots */}
            <span aria-hidden className="absolute top-1.5 right-3 text-yellow-200 text-xs animate-pulse">✨</span>
            <span aria-hidden className="absolute bottom-1.5 left-4 text-pink-200 text-xs animate-pulse" style={{ animationDelay: "0.4s" }}>✦</span>
            <span aria-hidden className="absolute top-3 left-1/3 text-cyan-200 text-[8px] animate-pulse" style={{ animationDelay: "0.8s" }}>✧</span>
            {/* Content */}
            <span className="relative z-10 flex items-center justify-center gap-2.5 drop-shadow-lg">
              {loading ? (
                <>
                  <Loader2 className="w-5 h-5 animate-spin" />
                  <span className="tracking-wide">{polling ? "Генерация трека…" : "Отправляем запрос…"}</span>
                </>
              ) : mode === "basic" ? (
                <>
                  <Sparkles className="w-5 h-5 text-yellow-200 drop-shadow" />
                  <span className="tracking-wide">{!prompt.trim() ? "Опишите песню" : "✨ Создать песню — 299 ₽"}</span>
                </>
              ) : mode === "audio" ? (
                <>
                  <span className="text-2xl drop-shadow transition-transform duration-300 hover:scale-110" key={voice + (isDuet ? "d" : "") + (instrumental ? "i" : "")}>
                    {instrumental ? "🎻" : isDuet ? "👩‍🎤👨‍🎤" : voice === "male" ? "👨‍🎤" : "👩‍🎤"}
                  </span>
                  <span className="tracking-wide">{audioUploading ? "Загружаю…"
                    : !audioFile && !audioUploadUrl ? "Запишите голос"
                    : "🎵 Создать кавер — 299 ₽"}</span>
                </>
              ) : (
                <>
                  <Sparkles className="w-5 h-5 text-yellow-200 drop-shadow" />
                  <span className="tracking-wide">
                    {selectedStyles.length === 0
                      ? "Выберите стиль"
                      : selectedStyles.length > 1
                      ? `✨ Создать ${selectedStyles.length} ${selectedStyles.length <= 4 ? "трека" : "треков"} — ${selectedStyles.length * 299} ₽`
                      : "✨ Создать песню — 299 ₽"}
                  </span>
                </>
              )}
            </span>
          </button>
          <style>{`
            /* Усиление btn-cosmic для магической кнопки генерации (Eugene 13:13).
               btn-cosmic уже даёт 6-цветный анимированный shimmer как на landing. */
            .magic-btn {
              animation: magic-pulse 2.4s ease-in-out infinite;
            }
            @keyframes magic-pulse {
              0%, 100% { box-shadow: 0 0 24px rgba(139, 92, 246, 0.45), 0 0 48px rgba(59, 130, 246, 0.25); }
              50% { box-shadow: 0 0 40px rgba(139, 92, 246, 0.75), 0 0 80px rgba(236, 72, 153, 0.5), 0 0 120px rgba(34, 211, 238, 0.3); }
            }
            .magic-btn:hover { transform: translateY(-2px) scale(1.01); }
            .magic-btn:active { transform: translateY(0) scale(0.98); }
            .magic-btn.magic-flash::before {
              content: ""; position: absolute; inset: 0;
              background: radial-gradient(circle, rgba(255,255,255,0.95) 0%, rgba(255,255,255,0) 70%);
              animation: magic-flash-anim 0.6s ease-out;
              pointer-events: none; z-index: 5;
            }
            @keyframes magic-flash-anim {
              0% { opacity: 1; transform: scale(0.5); }
              100% { opacity: 0; transform: scale(2); }
            }
          `}</style>

          {/* Inline auth form - appears when not logged in */}
          {showInlineAuth && !user && (
            <InlineAuth onSuccess={() => setShowInlineAuth(false)} />
          )}
        </div>

        {/* Loading progress */}
        {polling && (
          <div className="gradient-border p-6 rounded-2xl text-center mb-6" data-testid="music-loading">
            <div className="flex justify-center mb-4">
              <Equalizer playing={true} />
            </div>
            <p className="text-sm text-muted-foreground pulse-gradient">
              {showLongWait ? "Suno думает дольше обычного — это нормально" : "Генерация трека... Обычно это занимает 30-120 секунд"}
            </p>
            <div className="w-full h-1 bg-white/5 rounded-full mt-4 overflow-hidden">
              <div className="h-full audio-progress rounded-full animate-pulse" style={{ width: "60%" }} />
            </div>
            {/* Eugene 2026-05-08: после 3 мин предлагаем выбор —
                подождать ещё или уйти в дашборд (там трек появится сам). */}
            {showLongWait && (
              <div className="mt-5 pt-4 border-t border-white/10 space-y-3">
                <p className="text-xs text-muted-foreground">
                  Прошло больше 3 мин. Можешь подождать здесь — или открыть дашборд: трек сам появится в плейлисте когда Suno закончит, баланс не пострадает.
                </p>
                <div className="flex gap-2 justify-center">
                  <Button
                    variant="outline"
                    className="rounded-xl border-purple-500/40 text-purple-200 hover:bg-purple-500/10"
                    onClick={() => setShowLongWait(false)}
                    data-testid="btn-wait-more"
                  >
                    ⏳ Подождать ещё
                  </Button>
                  <Button
                    className="rounded-xl bg-gradient-to-r from-purple-500 to-blue-500"
                    onClick={() => {
                      // Дашборд продолжит polling статуса; pollRef отдадим cron'у на сервере
                      if (pollRef.current) clearInterval(pollRef.current);
                      setPolling(false);
                      setLoading(false);
                      setShowLongWait(false);
                      stopBgMusic();
                      window.location.hash = "#/dashboard";
                    }}
                    data-testid="btn-open-dashboard"
                  >
                    📊 Открыть дашборд
                  </Button>
                </div>
              </div>
            )}
          </div>
        )}

        {/* Result */}
        {resultUrl && (
          <div className="space-y-4" data-testid="music-result">
            <AudioPlayer url={resultUrl} autoPlay />

            {/* Prompt copy */}
            {lastPromptText && (
              <div className="glass-card rounded-xl p-4">
                <div className="flex items-start justify-between gap-2 mb-1">
                  <p className="text-xs text-muted-foreground">Промпт</p>
                  <button
                    className="text-xs text-muted-foreground hover:text-purple-400 transition-colors flex items-center gap-1 shrink-0"
                    onClick={() => {
                      navigator.clipboard.writeText(lastPromptText);
                      setCopiedPrompt(true);
                      setTimeout(() => setCopiedPrompt(false), 2000);
                    }}
                    data-testid="button-copy-prompt"
                  >
                    {copiedPrompt ? <Check className="w-3 h-3 text-green-400" /> : <Copy className="w-3 h-3" />}
                    {copiedPrompt ? "Скопировано" : "Копировать"}
                  </button>
                </div>
                <p className="text-sm text-foreground/80 whitespace-pre-wrap line-clamp-4">{lastPromptText}</p>
              </div>
            )}

            <div className="flex gap-3">
              <Button
                className="flex-1 btn-gradient rounded-xl h-11"
                onClick={handleDownload}
                data-testid="button-download-music"
              >
                <Download className="w-4 h-4 mr-2" />
                Скачать трек
              </Button>
              <Button
                variant="outline"
                className="flex-1 rounded-xl h-11 border-purple-500/30 hover:bg-purple-500/10 text-purple-300"
                onClick={() => {
                  // Reset result, keep text, highlight unused styles
                  setResultUrl(null);
                  setHighlightStyles(true);
                  // Keep only unused styles pre-selected, or clear to let user pick
                  setSelectedStyles([]);
                  // Scroll to top of form
                  window.scrollTo({ top: 0, behavior: "smooth" });
                  toast({ title: "Выберите новый стиль", description: "Подсвечены стили, которые вы ещё не пробовали" });
                }}
                data-testid="button-retry-style"
              >
                <RefreshCcw className="w-4 h-4 mr-2" />
                Другой стиль
              </Button>
            </div>
          </div>
        )}
      </div>

      <ShareFAB user={user} />
    </div>
  );
}

// ShareFAB — плавающая кнопка bottom-right. ТЗ Eugene 12:56:
// «человек может тут же авторизироваться и продолжить генерацию».
// Если не залогинен — внутри dialog'а показывается InlineAuth.
function ShareFAB({ user }: { user: any }) {
  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState(false);

  const shareUrl = typeof window !== "undefined" ? window.location.origin + "/#/music" : "";

  const copyLink = async () => {
    try {
      await navigator.clipboard.writeText(shareUrl);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {}
  };

  const nativeShare = async () => {
    try {
      if ((navigator as any).share) {
        await (navigator as any).share({
          title: "MuziAi — создаю песню по голосу",
          text: "Попробуй создать свою песню в MuziAi за 1 минуту",
          url: shareUrl,
        });
      } else {
        copyLink();
      }
    } catch {}
  };

  return (
    <>
      {/* FAB */}
      <button
        type="button"
        aria-label="Поделиться и продолжить"
        onClick={() => setOpen(true)}
        className="fixed bottom-5 right-5 z-40 w-14 h-14 rounded-full bg-gradient-to-br from-cyan-500 to-blue-600 text-white shadow-2xl shadow-cyan-500/40 hover:scale-110 active:scale-95 transition-all flex items-center justify-center border-2 border-white/20"
        data-testid="fab-share"
      >
        <Share2 className="w-6 h-6" />
        <span className="absolute top-0 right-0 w-3 h-3 bg-emerald-400 rounded-full border-2 border-background animate-pulse" />
      </button>

      {/* Modal */}
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Share2 className="w-5 h-5 text-cyan-300" />
              Поделиться MuziAi
            </DialogTitle>
            <DialogDescription>
              {user
                ? "Расскажи друзьям и продолжай создавать."
                : "Зарегистрируйся за 30 сек ниже — продолжишь генерацию здесь же."}
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-3">
            <div className="flex flex-wrap gap-2">
              <Button onClick={nativeShare} className="flex-1 bg-cyan-500/20 text-cyan-200 hover:bg-cyan-500/30 border border-cyan-500/30">
                📤 Поделиться
              </Button>
              <Button onClick={copyLink} variant="outline" className="flex-1">
                {copied ? <><Check className="w-4 h-4 mr-2" />Скопировано</> : <><Copy className="w-4 h-4 mr-2" />Скопировать</>}
              </Button>
            </div>

            <div className="grid grid-cols-3 gap-2 text-xs">
              <a
                href={`https://api.whatsapp.com/send?text=${encodeURIComponent("MuziAi: создай свою песню за 1 минуту — " + shareUrl)}`}
                target="_blank" rel="noopener noreferrer"
                className="px-3 py-2 rounded-lg bg-emerald-500/10 border border-emerald-500/30 text-emerald-300 text-center hover:bg-emerald-500/20"
              >
                WhatsApp
              </a>
              <a
                href={`https://t.me/share/url?url=${encodeURIComponent(shareUrl)}&text=${encodeURIComponent("Попробуй MuziAi")}`}
                target="_blank" rel="noopener noreferrer"
                className="px-3 py-2 rounded-lg bg-blue-500/10 border border-blue-500/30 text-blue-300 text-center hover:bg-blue-500/20"
              >
                Telegram
              </a>
              <a
                href={`https://vk.com/share.php?url=${encodeURIComponent(shareUrl)}`}
                target="_blank" rel="noopener noreferrer"
                className="px-3 py-2 rounded-lg bg-indigo-500/10 border border-indigo-500/30 text-indigo-300 text-center hover:bg-indigo-500/20"
              >
                VK
              </a>
            </div>

            {!user && (
              <div className="pt-3 border-t border-white/10 space-y-2">
                <div className="text-xs text-violet-300 font-semibold flex items-center gap-1.5">
                  <Sparkles className="w-3.5 h-3.5" />
                  Войди — продолжи генерацию здесь же
                </div>
                <InlineAuth onSuccess={() => setOpen(false)} />
              </div>
            )}

            {user && (
              <div className="pt-3 border-t border-white/10">
                <Button
                  className="w-full"
                  onClick={() => setOpen(false)}
                >
                  Продолжить генерацию →
                </Button>
              </div>
            )}
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}
