import { useState } from "react";
import { HelpBuddy } from "@/components/help-buddy";
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
import { PenLine, Loader2, Download, Copy, Check, Music } from "lucide-react";
import { useToast } from "@/hooks/use-toast";

const genres = [
  { value: "pop", label: "Поп" },
  { value: "rock", label: "Рок" },
  { value: "rap", label: "Рэп" },
  { value: "rnb", label: "R&B" },
  { value: "electronic", label: "Электронная" },
  { value: "jazz", label: "Джаз" },
  { value: "folk", label: "Фолк" },
];

const moods = [
  { value: "happy", label: "Весёлое" },
  { value: "sad", label: "Грустное" },
  { value: "romantic", label: "Романтичное" },
  { value: "energetic", label: "Энергичное" },
  { value: "calm", label: "Спокойное" },
];

export default function LyricsPage() {
  const { user, refreshUser } = useAuth();
  const [, navigate] = useLocation();
  const { toast } = useToast();

  const [prompt, setPrompt] = useState("");
  const [genre, setGenre] = useState("pop");
  const [mood, setMood] = useState("happy");
  const [language, setLanguage] = useState("ru");
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [showInlineAuth, setShowInlineAuth] = useState(false);

  const handleGenerate = async () => {
    if (!user) {
      setShowInlineAuth(true);
      return;
    }
    if (!prompt.trim()) {
      toast({ title: "Опишите тему песни", variant: "destructive" });
      return;
    }
    setLoading(true);
    startBgMusic();
    setResult(null);
    try {
      const res = await apiRequest("POST", "/api/lyrics/generate", { prompt, genre, mood, language });
      const data = await res.json();
      setResult(data.lyrics);
      await refreshUser();
      toast({ title: "Текст создан!" });
    } catch (err: any) {
      toast({
        title: "Ошибка",
        description: err.message?.includes("402") ? "Недостаточно средств. Пополните баланс." : err.message,
        variant: "destructive",
      });
    } finally {
      setLoading(false);
      stopBgMusic();
    }
  };

  const handleDownload = () => {
    if (!result) return;
    const blob = new Blob([result], { type: "text/plain;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "lyrics-muzaai.txt";
    a.click();
    URL.revokeObjectURL(url);
  };

  const handleCopy = () => {
    if (!result) return;
    navigator.clipboard.writeText(result);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <div className="min-h-screen pt-20 px-4 pb-12">
      <div className="max-w-3xl mx-auto">
        {/* Header */}
        <div className="flex items-center gap-3 mb-8">
          <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-purple-500 to-purple-700 flex items-center justify-center">
            <PenLine className="w-5 h-5 text-white" />
          </div>
          <div>
            <h1 className="text-xl font-bold text-white" data-testid="text-lyrics-title">Текст песни</h1>
            <p className="text-sm text-muted-foreground">AI напишет текст по вашему описанию</p>
          </div>
          <span className="ml-auto price-badge" data-testid="badge-price-lyrics">99 ₽</span>
          <HelpBuddy
            variant="violet"
            size="sm"
            title="Что это?"
            sections={[
              { label: "Как работает", text: "Опишите тему песни (например, «гимн ко дню рождения мамы») — AI напишет полный текст с куплетами и припевом.", color: "text-purple-300" },
              { label: "Цена", text: "99 ₽ за один полный текст. Бесплатных попыток 5 в день у новых.", color: "text-emerald-300" },
              { label: "Что дальше", text: "Готовый текст можно сразу перенести в «Музыка» — AI озвучит его в выбранном вами стиле и голосе.", color: "text-cyan-300" },
            ]}
          />
        </div>

        {/* Form */}
        <div className="gradient-border p-6 rounded-2xl space-y-5 mb-6">
          <div className="space-y-2">
            <Label className="text-sm text-muted-foreground">Тема / описание песни</Label>
            <Textarea
              placeholder="Например: песня о летнем путешествии на машине по побережью..."
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              rows={4}
              className="bg-background/50 border-white/10 input-glow resize-none"
              data-testid="input-lyrics-prompt"
            />
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
            <div className="space-y-2">
              <Label className="text-sm text-muted-foreground">Жанр</Label>
              <Select value={genre} onValueChange={setGenre}>
                <SelectTrigger className="bg-background/50 border-white/10" data-testid="select-genre">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {genres.map((g) => (
                    <SelectItem key={g.value} value={g.value}>{g.label}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label className="text-sm text-muted-foreground">Настроение</Label>
              <Select value={mood} onValueChange={setMood}>
                <SelectTrigger className="bg-background/50 border-white/10" data-testid="select-mood">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {moods.map((m) => (
                    <SelectItem key={m.value} value={m.value}>{m.label}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label className="text-sm text-muted-foreground">Язык</Label>
              <Select value={language} onValueChange={setLanguage}>
                <SelectTrigger className="bg-background/50 border-white/10" data-testid="select-language">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="ru">Русский</SelectItem>
                  <SelectItem value="en">English</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>

          <Button
            className="w-full btn-gradient rounded-xl h-12 text-base"
            onClick={handleGenerate}
            disabled={loading}
            data-testid="button-generate-lyrics"
          >
            {loading ? (
              <span className="flex items-center gap-2">
                <Loader2 className="w-4 h-4 animate-spin" />
                Генерация текста...
              </span>
            ) : (
              <span className="flex items-center gap-2">
                <PenLine className="w-4 h-4" />
                Создать текст — 99 ₽
              </span>
            )}
          </Button>

          {/* Inline auth form */}
          {showInlineAuth && !user && (
            <InlineAuth onSuccess={() => setShowInlineAuth(false)} />
          )}
        </div>

        {/* Result */}
        {result && (
          <div className="gradient-border p-6 rounded-2xl" data-testid="lyrics-result">
            <div className="flex items-center justify-between mb-4">
              <h3 className="text-base font-semibold gradient-text">Результат</h3>
              <div className="flex gap-2">
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={handleCopy}
                  className="text-muted-foreground hover:text-white"
                  data-testid="button-copy-lyrics"
                >
                  {copied ? <Check className="w-4 h-4 text-green-400" /> : <Copy className="w-4 h-4" />}
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={handleDownload}
                  className="text-muted-foreground hover:text-white"
                  data-testid="button-download-lyrics"
                >
                  <Download className="w-4 h-4" />
                </Button>
              </div>
            </div>
            <div className="text-sm text-foreground/90 leading-relaxed whitespace-pre-wrap font-mono bg-background/30 rounded-xl p-4 max-h-[500px] overflow-y-auto">
              {result}
            </div>
            <p className={`text-xs mt-2 ${(result?.length || 0) > 400 ? "text-red-400" : "text-muted-foreground"}`}>
              {result?.length || 0} / 400 символов {(result?.length || 0) > 400 ? "— текст будет обрезан при создании музыки" : "— готов для Suno"}
            </p>
            {/* Кнопка создать музыку с этим текстом */}
            <Button
              className="btn-gradient rounded-xl mt-4 w-full"
              onClick={() => {
                // Transfer lyrics via global variable (URL encoding breaks with long texts)
                (window as any).__lyricsTransfer = result || "";
                navigate("/music");
              }}
              data-testid="button-make-music-from-lyrics"
            >
              <Music className="w-4 h-4 mr-2" />
              Создать музыку с этим текстом
            </Button>
          </div>
        )}
      </div>


    </div>
  );
}
