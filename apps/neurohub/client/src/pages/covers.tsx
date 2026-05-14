import { useState, useRef, useEffect, useCallback } from "react";
import { useAuth } from "@/lib/auth";
import { startBgMusic, stopBgMusic } from "@/components/background-music";
import { useLocation } from "wouter";
import { apiRequest } from "@/lib/queryClient";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import { InlineAuth } from "@/components/inline-auth";
import { ImageIcon, Loader2, Download, Music } from "lucide-react";
import { useToast } from "@/hooks/use-toast";

const coverStyles = [
  { value: "cyberpunk", label: "Киберпанк" },
  { value: "minimalism", label: "Минимализм" },
  { value: "abstract", label: "Абстракт" },
  { value: "retro", label: "Ретро" },
  { value: "fantasy", label: "Фэнтези" },
  { value: "photorealism", label: "Фотореализм" },
];

export default function CoversPage() {
  const { user, refreshUser } = useAuth();
  const [, navigate] = useLocation();
  const { toast } = useToast();

  // Check if we came from cabinet to create cover for a specific track
  const coverForTrack = useRef<number | null>((window as any).__coverForTrack || null);
  const coverPrompt = (window as any).__coverPrompt || "";
  // Eugene 2026-05-14 Босс «связать стиль с окном генерации + сверху
  // зона какой текст и параметры».
  const trackInfo = useRef<any>((window as any).__coverTrackInfo || null);
  if ((window as any).__coverForTrack) {
    delete (window as any).__coverForTrack;
    delete (window as any).__coverPrompt;
    delete (window as any).__coverTrackInfo;
  }

  // Auto-mapping стиля трека → стиль обложки (если есть инфо).
  const autoStyleFromTrack = (trackStyle: string): string => {
    const s = trackStyle.toLowerCase();
    if (/rock|метал|metal|рок/i.test(s)) return "cyberpunk";
    if (/pop|поп|dance|танц/i.test(s)) return "abstract";
    if (/jazz|джаз|class|класс/i.test(s)) return "minimalism";
    if (/country|кантри|folk|фолк/i.test(s)) return "retro";
    if (/electronic|электрон|lofi/i.test(s)) return "fantasy";
    if (/ballad|баллад|chanson|шансон/i.test(s)) return "photorealism";
    return "cyberpunk";
  };

  const [prompt, setPrompt] = useState(coverPrompt || "");
  // Eugene 2026-05-14 Босс «во втором на фоне опишите что вы хотите увидеть
  // максимально детально цвета и т д».
  const [details, setDetails] = useState("");
  // Eugene 2026-05-14 Босс «по умолчанию минимализм».
  const [style, setStyle] = useState(() => trackInfo.current?.style ? autoStyleFromTrack(trackInfo.current.style) : "minimalism");
  const [loading, setLoading] = useState(false);
  const [polling, setPolling] = useState(false);
  const [resultUrl, setResultUrl] = useState<string | null>(null);
  const [lastGenId, setLastGenId] = useState<number | null>(null);
  const [showInlineAuth, setShowInlineAuth] = useState(false);
  const pollRef = useRef<ReturnType<typeof setInterval>>();

  const pollStatus = useCallback(async (taskId: string) => {
    try {
      const res = await apiRequest("GET", `/api/covers/status/${taskId}`);
      const data = await res.json();
      if (data.status === "done" && (data.imageUrl || data.url || data.result)) {
        const url = data.imageUrl || data.url || data.result;
        setResultUrl(url);
        // Extract cover gen ID from data
        if (data.id) setLastGenId(data.id);
        setPolling(false);
        setLoading(false);
        stopBgMusic();
        if (pollRef.current) clearInterval(pollRef.current);
        await refreshUser();
        // Auto-attach to track if came from cabinet
        if (coverForTrack.current && data.id) {
          try {
            await apiRequest("POST", `/api/generations/${coverForTrack.current}/cover`, { coverGenId: data.id });
            toast({ title: "Обложка привязана к треку!" });
            coverForTrack.current = null;
          } catch {
            toast({ title: "Обложка готова!" });
          }
        } else {
          toast({ title: "Обложка готова!" });
        }
      } else if (data.status === "error" || data.status === "failed") {
        setPolling(false);
        setLoading(false);
        stopBgMusic();
        if (pollRef.current) clearInterval(pollRef.current);
        await refreshUser();
        toast({
          title: data.moderationError ? "Модерация" : "Ошибка генерации",
          description: data.moderationError || "Средства возвращены на баланс",
          variant: "destructive",
        });
      }
    } catch {
      // keep polling
    }
  }, [refreshUser, toast]);

  useEffect(() => {
    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
    };
  }, []);

  const handleGenerate = async () => {
    if (!user) {
      setShowInlineAuth(true);
      return;
    }
    if (!prompt.trim()) {
      toast({ title: "Опишите обложку", variant: "destructive" });
      return;
    }

    setLoading(true);
    startBgMusic();
    setResultUrl(null);
    try {
      // Eugene 2026-05-14 Босс «второе поле детали — цвета, что увидеть».
      const fullPrompt = details.trim() ? `${prompt}. Детали визуала: ${details.trim()}` : prompt;
      const res = await apiRequest("POST", "/api/covers/generate", { prompt: fullPrompt, style });
      const data = await res.json();

      if (data.taskId) {
        setPolling(true);
        pollRef.current = setInterval(() => pollStatus(data.taskId), 5000);
      }
    } catch (err: any) {
      setLoading(false);
      toast({
        title: "Ошибка",
        description: err.message?.includes("402") ? "Недостаточно средств. Пополните баланс." : err.message,
        variant: "destructive",
      });
    }
  };

  const handleDownload = () => {
    if (!resultUrl) return;
    const a = document.createElement("a");
    a.href = resultUrl;
    a.download = "cover-muziai.png";
    a.target = "_blank";
    a.click();
  };

  return (
    <div className="min-h-screen pt-20 px-4 pb-12">
      <div className="max-w-3xl mx-auto">
        {/* Header */}
        <div className="flex items-center gap-3 mb-8">
          <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-cyan-500 to-cyan-700 flex items-center justify-center">
            <ImageIcon className="w-5 h-5 text-white" />
          </div>
          <div>
            <h1 className="text-xl font-bold text-white" data-testid="text-covers-title">Обложка альбома</h1>
            <p className="text-sm text-muted-foreground">Уникальная обложка для вашего трека</p>
          </div>
          <span className="ml-auto price-badge" data-testid="badge-price-covers">99 ₽</span>
        </div>

        {/* Eugene 2026-05-14 Босс «сверху зона какой текст и его параметры».
            Info-card если пришли с трека (coverForTrack + trackInfo). */}
        {trackInfo.current && (
          <div className="rounded-2xl border border-purple-500/30 bg-gradient-to-br from-purple-500/[0.08] via-blue-500/[0.05] to-cyan-500/[0.05] p-4 mb-4">
            <div className="text-[11px] uppercase tracking-wider text-purple-300/80 mb-1.5 font-display">Создаём обложку для трека</div>
            <div className="text-[15px] font-bold text-white mb-1">«{trackInfo.current.title}»</div>
            <div className="flex flex-wrap gap-1.5 text-[11px]">
              {trackInfo.current.authorName && (
                <span className="px-2 py-0.5 rounded-full bg-white/[0.06] text-white/70 border border-white/[0.08]">👤 {trackInfo.current.authorName}</span>
              )}
              {trackInfo.current.style && (
                <span className="px-2 py-0.5 rounded-full bg-purple-500/15 text-purple-300 border border-purple-500/25">🎼 {trackInfo.current.style}</span>
              )}
              {trackInfo.current.voiceType && (
                <span className="px-2 py-0.5 rounded-full bg-cyan-500/15 text-cyan-300 border border-cyan-500/25">🎤 {trackInfo.current.voiceType}</span>
              )}
            </div>
            {trackInfo.current.promptFull && (
              <div className="mt-2 text-[11px] text-white/50 italic max-h-12 overflow-hidden">
                Текст: «{String(trackInfo.current.promptFull).slice(0, 140)}{trackInfo.current.promptFull.length > 140 ? "…" : ""}»
              </div>
            )}
          </div>
        )}

        {/* Form */}
        <div className="gradient-border p-6 rounded-2xl space-y-5 mb-6">
          <div className="space-y-2">
            {/* Eugene 2026-05-14 Босс «кнопка I с разъяснением чем точнее
                опишете тем лучше дизайн». */}
            <div className="flex items-center gap-1.5">
              <Label className="text-sm text-muted-foreground">Описание обложки</Label>
              <span
                className="inline-flex w-4 h-4 rounded-full bg-purple-500/20 border border-purple-400/40 text-[10px] text-purple-200 items-center justify-center cursor-help font-bold"
                title="Чем детальнее опишете — тем точнее получится обложка. Указывайте: главные образы (девушка / гитара / закат), цвета (фиолетово-голубой), настроение (мечтательное / драматичное), стиль (рукописный шрифт / неон). Идеи + детали → дизайн вас удивит."
              >ⓘ</span>
            </div>
            <Textarea
              placeholder="Например: неоновый город в дожде, с силуэтом музыканта на переднем плане..."
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              rows={4}
              className="bg-background/50 border-white/10 input-glow resize-none"
              data-testid="input-cover-prompt"
            />
          </div>

          {/* Eugene 2026-05-14 Босс «во втором поле опишите что хотите
              увидеть максимально детально, цвета и т.д.» */}
          <div className="space-y-2">
            <Label className="text-sm text-muted-foreground">Детали визуала (опционально)</Label>
            <Textarea
              placeholder="Опишите максимально детально что хотите увидеть. Например: фиолетово-голубая палитра, тёплый закат, силуэт девушки, мечтательная атмосфера, рукописный шрифт..."
              value={details}
              onChange={(e) => setDetails(e.target.value)}
              rows={3}
              className="bg-background/50 border-white/10 input-glow resize-none text-sm"
            />
          </div>

          <div className="space-y-2">
            <Label className="text-sm text-muted-foreground">Стиль</Label>
            <Select value={style} onValueChange={setStyle}>
              <SelectTrigger className="bg-background/50 border-white/10" data-testid="select-cover-style">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {coverStyles.map((s) => (
                  <SelectItem key={s.value} value={s.value}>{s.label}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <Button
            className="w-full btn-gradient rounded-xl h-12 text-base"
            onClick={handleGenerate}
            disabled={loading}
            data-testid="button-generate-cover"
          >
            {loading ? (
              <span className="flex items-center gap-2">
                <Loader2 className="w-4 h-4 animate-spin" />
                {polling ? "Генерация обложки..." : "Отправляем запрос..."}
              </span>
            ) : (
              <span className="flex items-center gap-2">
                <ImageIcon className="w-4 h-4" />
                Создать обложку — 99 ₽
              </span>
            )}
          </Button>

          {/* Inline auth form */}
          {showInlineAuth && !user && (
            <InlineAuth onSuccess={() => setShowInlineAuth(false)} />
          )}
        </div>

        {/* Loading */}
        {polling && (
          <div className="gradient-border p-6 rounded-2xl text-center mb-6" data-testid="cover-loading">
            <Loader2 className="w-8 h-8 text-purple-400 animate-spin mx-auto mb-3" />
            <p className="text-sm text-muted-foreground pulse-gradient">
              Генерация обложки... Обычно 15-60 секунд
            </p>
          </div>
        )}

        {/* Result */}
        {resultUrl && (
          <div className="gradient-border p-6 rounded-2xl text-center" data-testid="cover-result">
            <div className="inline-block rounded-xl overflow-hidden mb-4 glow-purple">
              <img
                src={resultUrl}
                alt="Обложка альбома"
                className="w-full max-w-md aspect-square object-cover"
                data-testid="img-cover-result"
              />
            </div>
            {/* Eugene 2026-05-14 Босс «3 кнопки: Привязать к треку /
                ReОбложка / Выйти». */}
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-2 max-w-md mx-auto">
              {coverForTrack.current && lastGenId ? (
                <Button
                  className="rounded-xl h-10 border-2 border-green-500/40 bg-green-500/15 text-green-300 hover:bg-green-500/25 text-sm font-semibold"
                  variant="outline"
                  onClick={async () => {
                    try {
                      await apiRequest("POST", `/api/generations/${coverForTrack.current}/cover`, { coverGenId: lastGenId });
                      toast({ title: "Обложка привязана к треку!" });
                      coverForTrack.current = null;
                      navigate("/dashboard");
                    } catch { toast({ title: "Ошибка", variant: "destructive" }); }
                  }}
                  data-testid="button-attach-cover"
                >
                  ✓ Привязать к треку
                </Button>
              ) : (
                <Button
                  className="rounded-xl h-10 btn-gradient text-sm font-semibold"
                  onClick={handleDownload}
                  data-testid="button-download-cover"
                >
                  <Download className="w-3.5 h-3.5 mr-1.5" />
                  Скачать
                </Button>
              )}
              <Button
                variant="outline"
                className="rounded-xl h-10 border-2 border-purple-500/30 bg-purple-500/10 text-purple-300 hover:bg-purple-500/20 text-sm font-semibold"
                onClick={() => {
                  setResultUrl(null);
                  setLastGenId(null);
                  handleGenerate();
                }}
              >
                🔄 ReОбложка
              </Button>
              <Button
                variant="outline"
                className="rounded-xl h-10 border-2 border-red-500/30 bg-red-500/10 text-red-300 hover:bg-red-500/20 text-sm font-semibold"
                onClick={() => navigate(coverForTrack.current ? "/dashboard" : "/")}
              >
                ✕ Выйти
              </Button>
            </div>
          </div>
        )}
      </div>


    </div>
  );
}
