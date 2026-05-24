import { useEffect, useState } from "react";
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
  // Eugene 2026-05-24 Premium-lyrics rule: toggle для 4-step refinement.
  // hasSubscription === true → free, иначе one-off 149 ₽.
  const [premiumEnabled, setPremiumEnabled] = useState(false);
  const [premiumInfoOpen, setPremiumInfoOpen] = useState(false);
  const [premiumStatus, setPremiumStatus] = useState<{
    hasSubscription: boolean;
    expiresAt: string | null;
    oneoffPriceLabel: string;
    subscriptionMonthlyLabel: string;
  } | null>(null);
  const [premiumSteps, setPremiumSteps] = useState<string[] | null>(null);

  // Eugene 2026-05-23 Risk #9 fix: consumer prefill из Музa-чата. Mount read +
  // event listener (corner-case когда юзер уже на /lyrics — wouter не remount).
  useEffect(() => {
    const applyPrefill = (prefill: any) => {
      if (!prefill || typeof prefill !== "object") return;
      if (typeof prefill.prompt === "string" && prefill.prompt) setPrompt(prefill.prompt);
      if (typeof prefill.topic === "string" && prefill.topic) setPrompt(prefill.topic);
      if (typeof prefill.genre === "string" && prefill.genre) setGenre(prefill.genre);
      if (typeof prefill.style === "string" && prefill.style) setGenre(prefill.style);
      if (typeof prefill.mood === "string" && prefill.mood) setMood(prefill.mood);
      if (typeof prefill.language === "string" && prefill.language) setLanguage(prefill.language);
    };
    let raw: string | null = null;
    try { raw = sessionStorage.getItem("muza_panel_prefill:lyrics"); } catch {}
    if (raw) {
      try { sessionStorage.removeItem("muza_panel_prefill:lyrics"); } catch {}
      try { applyPrefill(JSON.parse(raw)); } catch {}
    }
    const onPrefill = (e: Event) => {
      const ce = e as CustomEvent<{ group: string; prefill: any }>;
      if (ce.detail?.group === "lyrics") {
        try { sessionStorage.removeItem("muza_panel_prefill:lyrics"); } catch {}
        applyPrefill(ce.detail.prefill);
      }
    };
    window.addEventListener("muza-panel-prefill", onPrefill);
    return () => window.removeEventListener("muza-panel-prefill", onPrefill);
  }, []);

  // Eugene 2026-05-24 Premium-lyrics rule: load premium status (subscription + price).
  useEffect(() => {
    if (!user) { setPremiumStatus(null); return; }
    let cancelled = false;
    apiRequest("GET", "/api/lyrics/premium-status")
      .then(r => r.json())
      .then(d => {
        if (cancelled) return;
        setPremiumStatus({
          hasSubscription: !!d.hasSubscription,
          expiresAt: d.expiresAt || null,
          oneoffPriceLabel: d.oneoffPriceLabel || "149 ₽",
          subscriptionMonthlyLabel: d.subscriptionMonthlyLabel || "299 ₽/мес",
        });
      })
      .catch(() => {
        if (cancelled) return;
        // Silent fallback — UI просто покажет дефолтные лейблы.
        setPremiumStatus({
          hasSubscription: false,
          expiresAt: null,
          oneoffPriceLabel: "149 ₽",
          subscriptionMonthlyLabel: "299 ₽/мес",
        });
      });
    return () => { cancelled = true; };
  }, [user?.id]);

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
    setPremiumSteps(null);
    startBgMusic();
    setResult(null);
    try {
      // Eugene 2026-05-24: premium endpoint при premiumEnabled, иначе обычный.
      const endpoint = premiumEnabled ? "/api/lyrics/premium-generate" : "/api/lyrics/generate";
      const res = await apiRequest("POST", endpoint, { prompt, genre, style: genre, mood, language });
      const data = await res.json();
      setResult(data.lyrics);
      if (premiumEnabled && Array.isArray(data.steps_used)) {
        setPremiumSteps(data.steps_used);
      }
      await refreshUser();
      toast({
        title: premiumEnabled ? "Премиум-текст готов!" : "Текст создан!",
        description: premiumEnabled && data.viaSubscription
          ? "Использована подписка «Премиум-качество текста»"
          : undefined,
      });
    } catch (err: any) {
      const msg = String(err?.message || "");
      toast({
        title: "Ошибка",
        description: msg.includes("402") ? "Недостаточно средств. Пополните баланс." : msg,
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
    a.download = "lyrics-muziai.txt";
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

          {/* Eugene 2026-05-24 Premium-lyrics rule: toggle для 4-step refinement.
              Brand-style consistency rule: glass-card + purple/fuchsia gradient.
              Layout-fit-no-overlap rule: flex-col mobile, flex-row sm+. */}
          <div
            className={`glass-card rounded-xl p-4 border transition-all cursor-pointer ${
              premiumEnabled
                ? "border-fuchsia-500/50 shadow-[0_0_24px_rgba(217,70,239,0.25)]"
                : "border-purple-400/20 hover:border-fuchsia-500/30"
            }`}
            onClick={() => setPremiumEnabled(v => !v)}
            data-testid="premium-lyrics-toggle"
          >
            <div className="flex items-start gap-3">
              <div className="flex-shrink-0 mt-0.5">
                <div
                  className={`w-5 h-5 rounded-md border-2 flex items-center justify-center transition-all ${
                    premiumEnabled
                      ? "border-fuchsia-400 bg-gradient-to-br from-purple-500 to-fuchsia-500"
                      : "border-purple-400/40 bg-transparent"
                  }`}
                >
                  {premiumEnabled && <Check className="w-3 h-3 text-white" strokeWidth={3} />}
                </div>
              </div>
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="text-sm font-sans font-semibold text-white">
                    ✨ Премиум-качество текста
                  </span>
                  {premiumStatus?.hasSubscription ? (
                    <span className="text-[10px] px-2 py-0.5 rounded-full bg-emerald-500/20 text-emerald-300 font-medium">
                      Включено в подписку
                    </span>
                  ) : (
                    <span className="text-[10px] font-mono px-2 py-0.5 rounded-full bg-fuchsia-500/20 text-fuchsia-300 font-bold">
                      +{premiumStatus?.oneoffPriceLabel || "149 ₽"}
                    </span>
                  )}
                  <button
                    type="button"
                    onClick={(e) => { e.stopPropagation(); setPremiumInfoOpen(true); }}
                    className="text-[11px] text-purple-300 hover:text-fuchsia-300 underline-offset-2 hover:underline"
                  >
                    как работает
                  </button>
                </div>
                <p className="text-xs text-muted-foreground mt-1 leading-snug">
                  4-этапное улучшение: Draft → Critique → Refine → Polish. Ярче метафоры, точнее под настроение, без штампов.
                </p>
              </div>
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
                {premiumEnabled ? "Premium-pipeline (4 шага)..." : "Генерация текста..."}
              </span>
            ) : premiumEnabled ? (
              <span className="flex items-center gap-2">
                <PenLine className="w-4 h-4" />
                {premiumStatus?.hasSubscription
                  ? "Создать премиум-текст (подписка)"
                  : `✨ Создать премиум-текст — ${premiumStatus?.oneoffPriceLabel || "149 ₽"}`}
              </span>
            ) : (
              <span className="flex items-center gap-2">
                <PenLine className="w-4 h-4" />
                Создать текст — 99 ₽
              </span>
            )}
          </Button>

          {/* Premium info modal — что даёт 4-step pipeline */}
          <Dialog open={premiumInfoOpen} onOpenChange={setPremiumInfoOpen}>
            <DialogContent className="max-w-md">
              <DialogHeader>
                <DialogTitle className="font-display gradient-text">✨ Премиум-качество текста</DialogTitle>
                <DialogDescription className="text-muted-foreground">
                  4-этапное улучшение через несколько LLM-вызовов
                </DialogDescription>
              </DialogHeader>
              <div className="space-y-3 text-sm">
                <div className="space-y-2">
                  <div className="flex items-start gap-2">
                    <span className="text-purple-300 font-bold">1.</span>
                    <div>
                      <div className="font-semibold text-white">Draft</div>
                      <div className="text-muted-foreground text-xs">Первый набросок 12-16 строк по описанию</div>
                    </div>
                  </div>
                  <div className="flex items-start gap-2">
                    <span className="text-fuchsia-300 font-bold">2.</span>
                    <div>
                      <div className="font-semibold text-white">Critique</div>
                      <div className="text-muted-foreground text-xs">Поиск 3 слабых мест — клише, рваный ритм, плоские эмоции</div>
                    </div>
                  </div>
                  <div className="flex items-start gap-2">
                    <span className="text-cyan-300 font-bold">3.</span>
                    <div>
                      <div className="font-semibold text-white">Refine</div>
                      <div className="text-muted-foreground text-xs">Переписываем слабые места — ярче, точнее, эмоциональнее</div>
                    </div>
                  </div>
                  <div className="flex items-start gap-2">
                    <span className="text-emerald-300 font-bold">4.</span>
                    <div>
                      <div className="font-semibold text-white">Polish</div>
                      <div className="text-muted-foreground text-xs">Финальная проверка размера, рифмы, структуры</div>
                    </div>
                  </div>
                </div>
                <div className="pt-3 border-t border-purple-500/20 space-y-1.5">
                  <div className="flex items-center justify-between text-xs">
                    <span className="text-muted-foreground">Один premium-текст:</span>
                    <span className="font-mono text-fuchsia-300 font-bold">{premiumStatus?.oneoffPriceLabel || "149 ₽"}</span>
                  </div>
                  <div className="flex items-center justify-between text-xs">
                    <span className="text-muted-foreground">Подписка (безлимит):</span>
                    <span className="font-mono text-emerald-300 font-bold">{premiumStatus?.subscriptionMonthlyLabel || "299 ₽/мес"}</span>
                  </div>
                  <p className="text-[11px] text-muted-foreground pt-1">
                    Подписку можно оформить через Музу в чате — попроси «оформи мне подписку на премиум-тексты».
                  </p>
                </div>
              </div>
            </DialogContent>
          </Dialog>

          {/* Inline auth form */}
          {showInlineAuth && !user && (
            <InlineAuth onSuccess={() => setShowInlineAuth(false)} />
          )}
        </div>

        {/* Result */}
        {result && (
          <div className="gradient-border p-6 rounded-2xl" data-testid="lyrics-result">
            <div className="flex items-center justify-between mb-4">
              <h3 className="text-base font-semibold gradient-text">
                Результат
                {premiumSteps && premiumSteps.length > 0 && (
                  <span className="ml-2 text-[10px] font-mono px-2 py-0.5 rounded-full bg-fuchsia-500/20 text-fuchsia-300 font-medium">
                    ✨ premium: {premiumSteps.join("→")}
                  </span>
                )}
              </h3>
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
