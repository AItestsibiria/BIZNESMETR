import { useState, useRef, useEffect, useCallback, useMemo } from "react";
import { useAuth } from "@/lib/auth";
import { startBgMusic, stopBgMusic } from "@/components/background-music";
import { useLocation } from "wouter";
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
  return (
    <div className="flex items-end gap-[2px] h-10">
      {Array.from({ length: 20 }).map((_, i) => (
        <div
          key={i}
          className={`w-[3px] rounded-full bg-gradient-to-t from-purple-500 via-blue-500 to-cyan-400 transition-all ${
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
  const [, navigate] = useLocation();
  const { toast } = useToast();

  // Check for lyrics/style/voiceType passed from other pages
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
      const val = params.get("lyrics");
      return val ? { lyrics: val, style: null, fullStyle: null, voiceType: null } : null;
    } catch { return null; }
  })();

  const [mode, setMode] = useState<"basic" | "audio" | "advanced">(() => {
    // ТЗ Eugene 2026-05-07: 3 режима по частоте использования.
    // Default — basic (минимум полей). Запоминаем выбор пользователя.
    try {
      const tabFromUrl = new URLSearchParams(window.location.hash.split("?")[1] || "").get("tab");
      if (tabFromUrl === "basic" || tabFromUrl === "audio" || tabFromUrl === "advanced") return tabFromUrl;
      const saved = localStorage.getItem("music_mode");
      if (saved === "basic" || saved === "audio" || saved === "advanced") return saved;
    } catch {}
    return "basic";
  });
  useEffect(() => { try { localStorage.setItem("music_mode", mode); } catch {} }, [mode]);
  const [audioMode, setAudioMode] = useState<"simple" | "advanced">(() => {
    try { const s = localStorage.getItem("music_audio_mode"); if (s === "simple" || s === "advanced") return s; } catch {}
    return "simple";
  });
  useEffect(() => { try { localStorage.setItem("music_audio_mode", audioMode); } catch {} }, [audioMode]);
  // Аудио-вход: пользовательский upload (mp3) для cover/extend режима.
  // Sprint 3 backend ещё не готов (см. docs/strategy/v304-audio-input-TZ.md),
  // UI собирается заранее — отправит uploadUrl когда endpoint появится.
  const [audioFile, setAudioFile] = useState<File | null>(null);
  const [audioUploadUrl, setAudioUploadUrl] = useState<string | null>(null);
  const [audioUploadSha, setAudioUploadSha] = useState<string | null>(null);
  const [audioUploading, setAudioUploading] = useState(false);
  const [audioWeight, setAudioWeight] = useState(0.7);
  // Транскрипция + LLM-rewrite (ТЗ Eugene 2026-05-07 12:09: «голос → суть → текст песни»)
  const [transcribing, setTranscribing] = useState(false);
  const [audioTranscript, setAudioTranscript] = useState<string>("");
  const [audioLyrics, setAudioLyrics] = useState<string>("");
  const [audioSuggestion, setAudioSuggestion] = useState<{ genre?: string; bpm?: number; templateSlug?: string; title?: string } | null>(null);
  const [rewriting, setRewriting] = useState(false);
  const [rewriteHint, setRewriteHint] = useState("");
  // Внутри Расширенного — старая Simple/Lyrics подвкладка (была prev top-mode).
  const [legacyMode, setLegacyMode] = useState<"simple" | "advanced">("simple");
  const [prompt, setPrompt] = useState("");
  const [style, setStyle] = useState(transferred?.style || "pop");
  const [selectedStyles, setSelectedStyles] = useState<string[]>([transferred?.style || "pop"]);
  const [lyrics, setLyrics] = useState(transferred?.lyrics || "");
  const [songCategory, setSongCategory] = useState<'song' | 'greeting'>('greeting'); // по умолчанию Поздравление
  const [title, setTitle] = useState("");
  // ТЗ Eugene 2026-05-07 §5: при повторе из dashboard используем
  // voiceType исходного трека (не дефолтим). transferred.voiceType ∈
  // 'male' | 'female' | 'duet' | 'instrumental' | 'auto' | null.
  const _transferredVT = (transferred?.voiceType || "").toString().toLowerCase();
  const [instrumental, setInstrumental] = useState<boolean>(_transferredVT === "instrumental");
  const [voice, setVoice] = useState<"female" | "male">(
    _transferredVT === "male" ? "male" : "female",
  );
  const [isPrivate, setIsPrivate] = useState(true);
  const [authorName, setAuthorName] = useState(user?.name || "");
  const [lastGenId, setLastGenId] = useState<number | null>(null);
  const [loading, setLoading] = useState(false);
  const [polling, setPolling] = useState(false);
  const [resultUrl, setResultUrl] = useState<string | null>(null);
  const [showInlineAuth, setShowInlineAuth] = useState(false);
  const [usedStyles, setUsedStyles] = useState<string[]>(transferred?.style ? [transferred.style] : []);
  const [showAdvanced, setShowAdvanced] = useState(false);
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

  // Resume polling for any processing generation on page load
  useEffect(() => {
    if (!user) return;
    apiRequest("GET", "/api/generations").then(r => r.json()).then((gens: any[]) => {
      const processing = gens.find((g: any) => g.type === "music" && g.status === "processing" && g.taskId);
      if (processing) {
        setLoading(true);
        setPolling(true);
        setLastGenId(processing.id);
        startBgMusic();
        pollRef.current = setInterval(() => pollStatus(processing.taskId), 5000);
      }
    }).catch(() => {});

    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
    };
  }, [user]);

  const handleGenerate = async () => {
    if (!user) {
      setShowInlineAuth(true);
      return;
    }
    // Audio mode — отдельный путь: upload + cover endpoint
    if (mode === "audio") {
      if (!audioFile && !audioUploadUrl) {
        toast({ title: "Загрузите аудио-файл", variant: "destructive" });
        return;
      }
      try {
        setLoading(true);
        startBgMusic();
        let sha = audioUploadSha;
        if (audioFile && !sha) {
          setAudioUploading(true);
          const fd = new FormData();
          fd.append("audio", audioFile);
          const up = await fetch("/api/gen/upload", { method: "POST", body: fd });
          const upJson = await up.json();
          setAudioUploading(false);
          if (!up.ok || !upJson?.data?.uploadUrl) {
            throw new Error(upJson?.error || "upload failed");
          }
          sha = upJson.data.sha;
          setAudioUploadSha(sha);
          setAudioUploadUrl(upJson.data.uploadUrl);
        }
        // Автоматический style из LLM-suggestion если пользователь не задал свой
        const finalStyle = (audioMode === "advanced" && stylePrompt.trim())
          ? stylePrompt.trim()
          : (audioSuggestion?.genre ?? "");
        // Lyrics: правленый или auto-сгенерированный из транскрипции
        const finalLyrics = audioLyrics.trim();
        const coverBody: any = {
          uploadSha: sha,
          voiceType: instrumental ? "instrumental" : isDuet ? "duet" : voice,
          voice, isDuet, instrumental,
          audioWeight: audioMode === "advanced" ? audioWeight : 0.7,
          authorName: authorName.trim(),
          isPublic: !isPrivate,
        };
        if (finalStyle) coverBody.style = finalStyle;
        if (finalLyrics.length >= 50) {
          coverBody.lyrics = finalLyrics;
          coverBody.title = audioSuggestion?.title || title || "Кавер";
        }
        const r = await apiRequest("POST", "/api/gen/audio-cover", coverBody);
        const j = await r.json();
        if (j?.data?.generationId) {
          toast({ title: "🎵 Кавер запущен", description: `gen #${j.data.generationId} — открываю страницу с авто-обновлением.` });
          setTimeout(() => navigate(`/track/${j.data.generationId}`), 800);
        } else {
          throw new Error(j?.error || "cover failed");
        }
      } catch (err: any) {
        toast({ title: "Не удалось создать кавер", description: err?.message || "ошибка", variant: "destructive" });
      } finally {
        setLoading(false);
        setAudioUploading(false);
      }
      return;
    }

    const isBasic = mode === "basic";
    const mainPrompt = isBasic ? prompt : (legacyMode === "simple" ? prompt : lyrics);
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

    // collect last error message for user feedback
    // (set in catch below via closure variable)
    if (allTaskIds.length > 0) {
      setPolling(true);
      // Track all tasks; finish when all done/error
      const pendingTasks = new Set(allTaskIds);
      const errorMessages: string[] = [];
      let doneCount = 0;
      pollRef.current = setInterval(async () => {
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
          stopBgMusic();
          if (pollRef.current) clearInterval(pollRef.current);
          await refreshUser();
          // Резюме по всем трекам с учётом ошибок от Suno
          if (doneCount > 0 && errorMessages.length === 0) {
            toast({ title: doneCount > 1 ? `${doneCount} треков готово` : "Трек готов!" });
          } else if (doneCount > 0 && errorMessages.length > 0) {
            toast({
              title: `Готово: ${doneCount}, отклонено: ${errorMessages.length}`,
              description: errorMessages[0].slice(0, 200),
              variant: "destructive",
            });
          } else {
            // Все треки отклонены — покажем первое сообщение полностью (самый важный случай)
            toast({
              title: "Трек не создан",
              description: errorMessages[0] || "Неизвестная ошибка. Баланс возвращён.",
              variant: "destructive",
              duration: 12000,
            });
          }
        }
      }, 5000);
      if (stylesToGenerate.length > 1 && errorCount < stylesToGenerate.length) {
        toast({ title: `Запущено ${allTaskIds.length} треков`, description: "Все треки появятся в личном кабинете" });
      }
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
        {/* Header */}
        <div className="flex items-center gap-3 mb-8">
          <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-blue-500 to-blue-700 flex items-center justify-center">
            <Music className="w-5 h-5 text-white" />
          </div>
          <div>
            <h1 className="text-xl font-bold text-white" data-testid="text-music-title">Музыка + Вокал</h1>
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
        <div className="mb-6 flex items-start justify-between gap-3 flex-wrap">
          <Tabs value={mode} onValueChange={(v) => setMode(v as any)}>
            <TabsList className="bg-white/5 border border-white/10 h-auto p-1 gap-1">
              <TabsTrigger
                value="audio"
                className="group data-[state=active]:bg-gradient-to-r data-[state=active]:from-cyan-500/30 data-[state=active]:to-blue-500/20 data-[state=active]:text-white data-[state=active]:shadow-[0_0_24px_rgba(34,211,238,0.4)] px-4 py-2 rounded-lg transition-all"
                data-testid="tab-audio"
              >
                <span className="inline-flex items-center gap-2">
                  <Mic className="w-4 h-4 text-cyan-300" />
                  <span className="flex items-end gap-[2px] h-3" aria-hidden>
                    <span className="w-[3px] bg-cyan-400 rounded-sm animate-eq-bar1" style={{ height: "30%" }} />
                    <span className="w-[3px] bg-cyan-300 rounded-sm animate-eq-bar2" style={{ height: "60%" }} />
                    <span className="w-[3px] bg-blue-300 rounded-sm animate-eq-bar3" style={{ height: "100%" }} />
                    <span className="w-[3px] bg-cyan-300 rounded-sm animate-eq-bar2" style={{ height: "55%" }} />
                  </span>
                  <span className="font-medium">Аудио</span>
                </span>
              </TabsTrigger>
              <TabsTrigger
                value="basic"
                className="data-[state=active]:bg-purple-500/20 data-[state=active]:text-white px-3 py-2 rounded-lg"
                data-testid="tab-basic"
              >
                <span className="inline-flex items-center gap-1.5">
                  <FileText className="w-4 h-4 text-purple-300" />
                  Текст · Простой
                </span>
              </TabsTrigger>
              <TabsTrigger
                value="advanced"
                className="data-[state=active]:bg-violet-500/20 data-[state=active]:text-white px-3 py-2 rounded-lg"
                data-testid="tab-advanced"
              >
                <span className="inline-flex items-center gap-1.5">
                  <Settings2 className="w-4 h-4 text-violet-300" />
                  Текст · Расширенный
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
                icon: <Mic />, color: "text-cyan-300", label: "🎤 Аудио — основной путь",
                text: <><b>Запишите смысл голосом</b> 20-30 сек: кому, о чём, повод. MuziAi распознает суть, напишет текст песни и сделает кавер. Можно записывать заново, переписывать текст («ReТекст» сколько нужно). <span className="text-cyan-300">299 ₽</span>.</>,
              },
              {
                icon: <FileText />, color: "text-purple-300", label: "Текст · Простой",
                text: <>Опишите песню одним предложением — MuziAi сам подберёт стиль, темп и мелодию. Быстро. <span className="text-purple-300">299 ₽</span>.</>,
              },
              {
                icon: <Settings2 />, color: "text-violet-300", label: "Текст · Расширенный",
                text: <>Полный контроль: жанр, BPM, настроение, темп, свой текст, мульти-стиль. <b>Самый точный и качественный результат</b> — для тех кто знает чего хочет. <span className="text-violet-300">от 299 ₽ за трек</span>.</>,
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
              <TabsList className="bg-white/5 border border-white/10">
                <TabsTrigger value="simple" className="data-[state=active]:bg-cyan-500/20 data-[state=active]:text-white" data-testid="tab-audio-simple">
                  Простой
                </TabsTrigger>
                <TabsTrigger value="advanced" className="data-[state=active]:bg-cyan-500/20 data-[state=active]:text-white" data-testid="tab-audio-advanced">
                  Расширенный
                </TabsTrigger>
              </TabsList>
            </Tabs>
          </div>
        )}

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
              {/* Voice selector — те же 4 кнопки что в advanced */}
              <div className="space-y-2">
                <Label className="text-sm text-muted-foreground">Голос</Label>
                <div className="flex flex-wrap gap-2">
                  <button type="button"
                    className={`px-3 py-1.5 text-sm rounded-lg border transition-colors ${!instrumental && !isDuet && voice === "female" ? "border-purple-500/40 bg-purple-500/15 text-purple-300" : "border-white/10 bg-white/5 text-muted-foreground hover:text-white"}`}
                    onClick={() => { setInstrumental(false); setIsDuet(false); setVoice("female"); }}
                    data-testid="btn-basic-female">
                    👩 Женский
                  </button>
                  <button type="button"
                    className={`px-3 py-1.5 text-sm rounded-lg border transition-colors ${!instrumental && !isDuet && voice === "male" ? "border-blue-500/40 bg-blue-500/15 text-blue-300" : "border-white/10 bg-white/5 text-muted-foreground hover:text-white"}`}
                    onClick={() => { setInstrumental(false); setIsDuet(false); setVoice("male"); }}
                    data-testid="btn-basic-male">
                    👨 Мужской
                  </button>
                  <button type="button"
                    className={`px-3 py-1.5 text-sm rounded-lg border transition-colors ${isDuet ? "border-pink-500/40 bg-pink-500/15 text-pink-300" : "border-white/10 bg-white/5 text-muted-foreground hover:text-white"}`}
                    onClick={() => { setInstrumental(false); setIsDuet(true); }}
                    data-testid="btn-basic-duet">
                    👫 Дуэт
                  </button>
                  <button type="button"
                    className={`px-3 py-1.5 text-sm rounded-lg border transition-colors ${instrumental ? "border-amber-500/40 bg-amber-500/15 text-amber-300" : "border-white/10 bg-white/5 text-muted-foreground hover:text-white"}`}
                    onClick={() => { setIsDuet(false); setInstrumental(true); }}
                    data-testid="btn-basic-instrumental">
                    🎻 Инструментальная
                  </button>
                </div>
              </div>
            </>
          ) : mode === "audio" ? (
            <>
              {/* === АУДИО-РЕЖИМ — микрофон ИЛИ файл === */}
              <div className="space-y-3">
                <Label className="text-sm text-muted-foreground">🎤 Запись с микрофона (до 3 мин)</Label>
                <MicRecorder
                  maxSeconds={180}
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
                        body: JSON.stringify({ uploadSha: sha }),
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
                        toast({ title: "⚠ Whisper не распознал", description: tJson.data.warning, variant: "destructive" });
                      }
                      if (tJson?.data?.transcript) setAudioTranscript(tJson.data.transcript);
                      if (tJson?.data?.suggestion) {
                        setAudioSuggestion(tJson.data.suggestion);
                        if (tJson.data.suggestion.lyrics) setAudioLyrics(tJson.data.suggestion.lyrics);
                        toast({ title: "✅ Текст готов", description: "Можете править или нажать ReТекст для другого варианта." });
                      } else if (tJson?.data?.fallbackToManual) {
                        toast({ title: "📝 Введите текст вручную", description: "Whisper недоступен — наберите описание ниже" });
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
                {audioTranscript && (
                  <div className="space-y-2 p-3 rounded-lg border border-cyan-500/30 bg-cyan-500/5">
                    <Label className="text-xs text-cyan-300">📝 Что я услышал:</Label>
                    <div className="text-xs italic text-muted-foreground">{audioTranscript}</div>
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
                  <div className="space-y-2">
                    <div className="flex items-center justify-between gap-2">
                      <Label className="text-xs text-muted-foreground">🎵 Текст песни (можно править перед генерацией):</Label>
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        className="h-7 text-[11px] border-cyan-500/40 text-cyan-300 hover:bg-cyan-500/10"
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
                      value={audioLyrics}
                      onChange={(e) => setAudioLyrics(e.target.value)}
                      rows={6}
                      placeholder="LLM напишет текст из вашего голоса. Если нет — наберите вручную."
                      className="bg-background/50 border-cyan-500/30"
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
              <div className="my-2 flex items-center gap-2 text-[10px] text-muted-foreground/50">
                <div className="flex-1 h-px bg-white/10" />
                <span>или</span>
                <div className="flex-1 h-px bg-white/10" />
              </div>
              <div className="space-y-3">
                <Label className="text-sm text-muted-foreground">📁 Загрузить файл (mp3/wav/m4a, до 20 MB)</Label>
                <div className="flex items-center gap-3">
                  <input
                    type="file"
                    accept="audio/*"
                    onChange={(e) => {
                      const f = e.target.files?.[0] || null;
                      setAudioFile(f);
                      setAudioUploadUrl(null);
                    }}
                    className="text-sm file:mr-3 file:px-3 file:py-1.5 file:rounded-md file:border-0 file:bg-cyan-500/20 file:text-cyan-200 file:cursor-pointer cursor-pointer"
                    data-testid="input-audio-file"
                  />
                  {audioFile && <span className="text-xs text-muted-foreground truncate max-w-[180px]">{audioFile.name}</span>}
                </div>
                <p className="text-[10px] text-cyan-300/80">
                  Принимаем mp3/wav/m4a/webm/ogg, до 20 MB. Файл загружается на наш сервер,
                  MuziAi делает кавер с нужным голосом и стилем.
                </p>
              </div>
              {audioMode === "advanced" && (
                <div className="space-y-2">
                  <Label className="text-sm text-muted-foreground">audioWeight — насколько копировать мелодию ({audioWeight.toFixed(2)})</Label>
                  <input
                    type="range" min={0} max={1} step={0.05}
                    value={audioWeight}
                    onChange={(e) => setAudioWeight(parseFloat(e.target.value))}
                    className="w-full accent-cyan-500"
                    data-testid="input-audio-weight"
                  />
                  <div className="flex justify-between text-[10px] text-muted-foreground/70">
                    <span>0 = свободная импровизация</span>
                    <span>1 = почти копия</span>
                  </div>
                </div>
              )}
              {/* Voice — те же 4 кнопки */}
              <div className="space-y-2">
                <Label className="text-sm text-muted-foreground">Голос для кавера</Label>
                <div className="flex flex-wrap gap-2">
                  <button type="button"
                    className={`px-3 py-1.5 text-sm rounded-lg border ${!instrumental && !isDuet && voice === "female" ? "border-purple-500/40 bg-purple-500/15 text-purple-300" : "border-white/10 bg-white/5 text-muted-foreground"}`}
                    onClick={() => { setInstrumental(false); setIsDuet(false); setVoice("female"); }}>👩 Женский</button>
                  <button type="button"
                    className={`px-3 py-1.5 text-sm rounded-lg border ${!instrumental && !isDuet && voice === "male" ? "border-blue-500/40 bg-blue-500/15 text-blue-300" : "border-white/10 bg-white/5 text-muted-foreground"}`}
                    onClick={() => { setInstrumental(false); setIsDuet(false); setVoice("male"); }}>👨 Мужской</button>
                  <button type="button"
                    className={`px-3 py-1.5 text-sm rounded-lg border ${isDuet ? "border-pink-500/40 bg-pink-500/15 text-pink-300" : "border-white/10 bg-white/5 text-muted-foreground"}`}
                    onClick={() => { setInstrumental(false); setIsDuet(true); }}>👫 Дуэт</button>
                  <button type="button"
                    className={`px-3 py-1.5 text-sm rounded-lg border ${instrumental ? "border-amber-500/40 bg-amber-500/15 text-amber-300" : "border-white/10 bg-white/5 text-muted-foreground"}`}
                    onClick={() => { setIsDuet(false); setInstrumental(true); }}>🎻 Инструментальная</button>
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

          {/* Настроение — видно всегда в расширенном */}
          {legacyMode === "advanced" && (
            <div className="space-y-2">
              <Label className="text-sm text-muted-foreground">Настроение</Label>
              <div className="flex flex-wrap gap-2">
                {["Весёлое", "Грустное", "Энергичное", "Романтичное", "Агрессивное", "Спокойное", "Эпичное", "Меланхоличное"].map(m => (
                  <button
                    key={m}
                    type="button"
                    className={`text-xs px-3 py-1.5 rounded-lg border transition-colors ${
                      mood === m
                        ? "border-purple-500 bg-purple-500/20 text-purple-300"
                        : "border-white/10 bg-white/5 text-muted-foreground hover:text-white hover:border-white/20"
                    }`}
                    onClick={() => setMood(mood === m ? "" : m)}
                  >
                    {m}
                  </button>
                ))}
              </div>
            </div>
          )}

          {/* Для опытных авторов — только в расширенном */}
          {legacyMode === "advanced" && (
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
          )}

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

          <Button
            className="w-full btn-gradient rounded-xl h-12 text-base"
            onClick={handleGenerate}
            disabled={
              loading || audioUploading
              || (mode === "advanced" && selectedStyles.length === 0)
              || (mode === "basic" && !prompt.trim())
              || (mode === "audio" && !audioFile && !audioUploadUrl)
            }
            data-testid="button-generate-music"
          >
            {loading ? (
              <span className="flex items-center gap-2">
                <Loader2 className="w-4 h-4 animate-spin" />
                {polling ? "Генерация трека..." : "Отправляем запрос..."}
              </span>
            ) : mode === "basic" ? (
              <span className="flex items-center gap-2">
                <Music className="w-4 h-4" />
                {!prompt.trim() ? "Опишите песню" : "Создать песню — 299 ₽"}
              </span>
            ) : mode === "audio" ? (
              <span className="flex items-center gap-2">
                <Mic className="w-4 h-4" />
                {audioUploading ? "Загружаю файл…"
                  : !audioFile && !audioUploadUrl ? "Выберите аудио-файл"
                  : "Создать кавер — 299 ₽"}
              </span>
            ) : (
              <span className="flex items-center gap-2">
                <Music className="w-4 h-4" />
                {selectedStyles.length === 0
                  ? "Выберите стиль"
                  : selectedStyles.length > 1
                  ? `Создать ${selectedStyles.length} ${selectedStyles.length <= 4 ? "трека" : "треков"} — ${selectedStyles.length * 299} ₽`
                  : "Создать песню — 299 ₽"}
              </span>
            )}
          </Button>

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
              Генерация трека... Обычно это занимает 30-120 секунд
            </p>
            <div className="w-full h-1 bg-white/5 rounded-full mt-4 overflow-hidden">
              <div className="h-full audio-progress rounded-full animate-pulse" style={{ width: "60%" }} />
            </div>
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
