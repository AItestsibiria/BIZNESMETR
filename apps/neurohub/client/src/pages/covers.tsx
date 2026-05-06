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
  if ((window as any).__coverForTrack) { delete (window as any).__coverForTrack; delete (window as any).__coverPrompt; }

  const [prompt, setPrompt] = useState(coverPrompt || "");
  const [style, setStyle] = useState("cyberpunk");
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
      const res = await apiRequest("POST", "/api/covers/generate", { prompt, style });
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

        {/* Form */}
        <div className="gradient-border p-6 rounded-2xl space-y-5 mb-6">
          <div className="space-y-2">
            <Label className="text-sm text-muted-foreground">Описание обложки</Label>
            <Textarea
              placeholder="Например: неоновый город в дожде, с силуэтом музыканта на переднем плане..."
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              rows={4}
              className="bg-background/50 border-white/10 input-glow resize-none"
              data-testid="input-cover-prompt"
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
            <div className="flex gap-3 max-w-md mx-auto">
              {/* Attach to track button — if came from cabinet */}
              {coverForTrack.current && lastGenId && (
                <Button
                  className="flex-1 rounded-xl h-10 border border-purple-500/30 bg-purple-500/10 text-purple-300 hover:bg-purple-500/20 text-sm"
                  variant="outline"
                  onClick={async () => {
                    try {
                      await apiRequest("POST", `/api/generations/${coverForTrack.current}/cover`, { coverGenId: lastGenId });
                      toast({ title: "Обложка привязана к треку!" });
                      coverForTrack.current = null;
                    } catch { toast({ title: "Ошибка", variant: "destructive" }); }
                  }}
                  data-testid="button-attach-cover"
                >
                  <Music className="w-3.5 h-3.5 mr-1.5" />
                  Привязать к песне
                </Button>
              )}
              <Button
                className={`rounded-xl h-10 text-sm ${coverForTrack.current ? "" : "w-full"} btn-gradient`}
                onClick={handleDownload}
                data-testid="button-download-cover"
              >
                <Download className="w-3.5 h-3.5 mr-1.5" />
                Скачать
              </Button>
            </div>
          </div>
        )}
      </div>


    </div>
  );
}
