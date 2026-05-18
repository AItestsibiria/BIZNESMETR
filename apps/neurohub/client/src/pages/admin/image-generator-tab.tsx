// Admin image generator tab — Eugene 2026-05-18 Босс «admin-генератор
// изображений по запросу для разных задач компании».
//
// Brand-style consistency rule: gradient-text title, glass-card, btn-cosmic
// CTA, font-mono для IDs / sizes. Copy-reports-button rule.

import { useEffect, useState } from "react";
import { apiRequest } from "@/lib/queryClient";

type ImagePreset = "avatar" | "cover" | "banner" | "logo" | "product" | "custom";
type ImageSize = "1024x1024" | "1792x1024" | "1024x1792";

interface GeneratedImage {
  id: number;
  type: string;
  prompt: string;
  fileUrl: string;
  fileSizeBytes: number | null;
  width: number | null;
  height: number | null;
  provider: string | null;
  model: string | null;
  costEstimateRub: number | null;
  referenceTrackId: number | null;
  usedAs: string | null;
  archived: boolean;
  createdAt: number;
}

interface GenerateResult {
  id: number;
  fileUrl: string;
  provider: string | null;
  model: string | null;
  modelTried: string[];
  durationMs: number;
  width: number | null;
  height: number | null;
  fileSizeBytes: number | null;
  costEstimateRub: number;
}

const PRESET_TEMPLATES: Record<ImagePreset, { label: string; emoji: string; prompt: string; tip: string }> = {
  avatar: {
    label: "Аватар",
    emoji: "👤",
    prompt:
      "Photorealistic 3D portrait of a friendly young woman with light blonde wavy hair, warm smile, modern over-ear headphones, MuzaAi brand colors (violet #7C3AED, cyan #00D4FF), soft studio lighting, deep space background (#0A0A17), 4K detail",
    tip: "Портрет помощника / певицы. Для замены образа Музы.",
  },
  cover: {
    label: "Обложка трека",
    emoji: "💿",
    prompt:
      "Album cover art, square 1:1, modern music aesthetic, vibrant gradient (violet to cyan), abstract waveform pattern, MuzaAi brand style, no text",
    tip: "Обложка для трека. Используется как ref для Suno или замена обложки.",
  },
  banner: {
    label: "Баннер",
    emoji: "🖼️",
    prompt:
      "Wide banner image (16:9), MuzaAi brand colors (purple #7C3AED, cyan #00D4FF, magenta #FF006E), abstract music visualization, hi-tech cyberpunk style, no text",
    tip: "Баннер для лендинга / соцсетей. Используй 1792x1024 размер.",
  },
  logo: {
    label: "Логотип",
    emoji: "✨",
    prompt:
      "Minimalist logo for MuzaAi music platform, abstract waveform icon, gradient violet to cyan, clean lines, transparent background, modern brand identity",
    tip: "Иконка / логотип. Лучше square 1024x1024.",
  },
  product: {
    label: "Продукт",
    emoji: "📦",
    prompt:
      "Product mockup image, clean modern style, soft shadow, branded MuzaAi colors, white-to-purple gradient background",
    tip: "Изображение продукта / товара для маркетинга.",
  },
  custom: {
    label: "Свободный",
    emoji: "🎨",
    prompt: "",
    tip: "Свободный prompt — пиши что хочешь сгенерировать.",
  },
};

const SIZE_OPTIONS: Array<{ value: ImageSize; label: string }> = [
  { value: "1024x1024", label: "Квадрат 1024×1024" },
  { value: "1792x1024", label: "Альбом 1792×1024" },
  { value: "1024x1792", label: "Портрет 1024×1792" },
];

export function ImageGeneratorTab({ toast }: { toast: any }) {
  function notify(msg: string, kind: "success" | "error" | "info" = "info") {
    toast({ title: msg, variant: kind === "error" ? "destructive" : "default" });
  }

  const [preset, setPreset] = useState<ImagePreset>("custom");
  const [prompt, setPrompt] = useState("");
  const [refTrackId, setRefTrackId] = useState("");
  const [size, setSize] = useState<ImageSize>("1024x1024");
  const [generating, setGenerating] = useState(false);
  const [lastResult, setLastResult] = useState<GenerateResult | null>(null);
  const [errorReport, setErrorReport] = useState<unknown>(null);
  const [history, setHistory] = useState<GeneratedImage[]>([]);
  const [applying, setApplying] = useState<number | null>(null);
  const [useAsValue, setUseAsValue] = useState("custom-banner");

  function applyPreset(p: ImagePreset) {
    setPreset(p);
    if (PRESET_TEMPLATES[p].prompt) setPrompt(PRESET_TEMPLATES[p].prompt);
  }

  async function loadHistory() {
    try {
      const r = await apiRequest("GET", "/api/admin/v304/images?limit=20&archived=0");
      const j = await r.json();
      if (j.error) {
        notify(j.error, "error");
        return;
      }
      setHistory(j.data?.items ?? []);
    } catch (e) {
      notify("Не удалось загрузить историю: " + String(e), "error");
    }
  }

  useEffect(() => {
    loadHistory();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function onGenerate() {
    if (!prompt || prompt.trim().length < 4) {
      notify("Промпт слишком короткий (мин 4 символа)", "error");
      return;
    }
    setGenerating(true);
    setErrorReport(null);
    setLastResult(null);
    try {
      const body: Record<string, unknown> = {
        prompt: prompt.trim(),
        presetCategory: preset,
        size,
      };
      const refNum = Number(refTrackId);
      if (refTrackId && Number.isFinite(refNum) && refNum > 0) body.refTrackId = refNum;
      const r = await apiRequest("POST", "/api/admin/v304/images/generate", body);
      const j = await r.json();
      if (j.error) {
        setErrorReport(j);
        notify("Генерация не удалась: " + j.error, "error");
        return;
      }
      setLastResult(j.data);
      notify(
        `✨ Сгенерировано (${j.data?.provider}/${j.data?.model}) за ${Math.round((j.data?.durationMs ?? 0) / 1000)}с`,
        "success",
      );
      await loadHistory();
    } catch (e) {
      notify("Сетевая ошибка: " + String(e), "error");
    } finally {
      setGenerating(false);
    }
  }

  async function onApply(id: number, usedAs: string) {
    if (!confirm(`Применить изображение #${id} как «${usedAs}»? Файл будет скопирован в нужное место.`)) return;
    setApplying(id);
    try {
      const r = await apiRequest("POST", `/api/admin/v304/images/${id}/use-as`, { usedAs });
      const j = await r.json();
      if (j.error) {
        notify(j.error, "error");
        return;
      }
      notify(`✅ Применено как ${usedAs}`, "success");
      await loadHistory();
    } catch (e) {
      notify("Сетевая ошибка: " + String(e), "error");
    } finally {
      setApplying(null);
    }
  }

  async function onArchive(id: number) {
    if (!confirm(`Архивировать #${id}?`)) return;
    try {
      const r = await apiRequest("DELETE", `/api/admin/v304/images/${id}`);
      const j = await r.json();
      if (j.error) {
        notify(j.error, "error");
        return;
      }
      notify("📦 В архиве", "success");
      await loadHistory();
    } catch (e) {
      notify("Сетевая ошибка: " + String(e), "error");
    }
  }

  function copyReport(payload: unknown) {
    try {
      navigator.clipboard.writeText(JSON.stringify(payload, null, 2));
      notify("📋 Скопировано", "success");
    } catch {
      notify("Не удалось скопировать", "error");
    }
  }

  const previewSrc = lastResult?.fileUrl ? `${lastResult.fileUrl}?v=${Date.now()}` : null;

  return (
    <div className="space-y-6">
      {/* Заголовок */}
      <div className="p-4 rounded-2xl border border-purple-500/30 bg-gradient-to-br from-purple-500/[0.06] via-fuchsia-500/[0.04] to-cyan-500/[0.04]">
        <h2 className="text-2xl font-display font-bold gradient-text mb-1">🎨 Генератор изображений</h2>
        <p className="text-sm font-sans text-muted-foreground">
          Любое изображение для нужд компании: аватары, обложки, баннеры, логотипы, продукты. GPTunnel (DALL-E / Flux / Midjourney) с автоматическим fallback на OpenAI DALL-E 3. Все файлы — в архиве, с возможностью применить «как Музу», «как обложку трека», «как баннер».
        </p>
      </div>

      {/* Preset picker */}
      <div className="glass-card rounded-2xl p-4 border border-purple-500/20">
        <h3 className="text-sm font-sans font-bold text-white mb-3">Категория</h3>
        <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-6 gap-2">
          {(Object.keys(PRESET_TEMPLATES) as ImagePreset[]).map((p) => (
            <button
              key={p}
              onClick={() => applyPreset(p)}
              className={`px-3 py-3 rounded-xl text-sm font-sans transition-all ${
                preset === p
                  ? "bg-gradient-to-br from-purple-500/40 to-cyan-500/30 border border-purple-400/60 text-white shadow-[0_0_24px_rgba(124,58,237,0.4)]"
                  : "bg-white/5 border border-white/10 text-muted-foreground hover:bg-white/10 hover:text-white"
              }`}
            >
              <div className="text-2xl mb-1">{PRESET_TEMPLATES[p].emoji}</div>
              <div className="text-xs font-medium">{PRESET_TEMPLATES[p].label}</div>
            </button>
          ))}
        </div>
        <p className="text-xs font-sans text-muted-foreground mt-3">{PRESET_TEMPLATES[preset].tip}</p>
      </div>

      {/* Form */}
      <div className="glass-card rounded-2xl p-6 border border-purple-500/20 space-y-4">
        <div>
          <label className="block text-sm font-sans font-bold text-white mb-2">
            Промпт (англ — модели лучше понимают)
          </label>
          <textarea
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            rows={5}
            className="w-full px-4 py-3 rounded-xl bg-[#0a0a17] border border-purple-500/30 text-white text-sm font-sans focus:outline-none focus:border-purple-400 focus:shadow-[0_0_16px_rgba(124,58,237,0.3)] input-glow"
            placeholder="Опиши что хочешь сгенерировать..."
            disabled={generating}
          />
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div>
            <label className="block text-sm font-sans font-bold text-white mb-2">
              🎵 Использовать обложку трека как референс (опц.)
            </label>
            <input
              type="number"
              value={refTrackId}
              onChange={(e) => setRefTrackId(e.target.value.replace(/[^0-9]/g, ""))}
              placeholder="ID трека"
              className="w-full px-4 py-3 rounded-xl bg-[#0a0a17] border border-cyan-500/30 text-white text-sm font-mono focus:outline-none focus:border-cyan-400 input-glow"
              disabled={generating}
            />
          </div>
          <div>
            <label className="block text-sm font-sans font-bold text-white mb-2">Размер</label>
            <select
              value={size}
              onChange={(e) => setSize(e.target.value as ImageSize)}
              className="w-full px-4 py-3 rounded-xl bg-[#0a0a17] border border-purple-500/30 text-white text-sm font-sans focus:outline-none focus:border-purple-400 input-glow"
              disabled={generating}
            >
              {SIZE_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>{o.label}</option>
              ))}
            </select>
          </div>
        </div>

        <div className="flex flex-wrap gap-3 pt-2">
          <button
            onClick={onGenerate}
            disabled={generating || prompt.trim().length < 4}
            className="btn-cosmic px-6 py-3 text-base font-display font-bold disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {generating ? "⏳ Генерируем (15-60 сек)..." : "✨ Сгенерировать"}
          </button>
          <button
            onClick={() => loadHistory()}
            className="px-4 py-3 rounded-xl bg-white/5 border border-white/10 text-white text-sm font-sans hover:bg-white/10 transition-colors"
          >
            🔄 Обновить
          </button>
        </div>
      </div>

      {/* Preview */}
      {lastResult && previewSrc && (
        <div className="glass-card rounded-2xl p-4 border border-emerald-500/30">
          <div className="flex items-center justify-between mb-3">
            <h3 className="text-lg font-sans font-bold text-white">✅ Готово #{lastResult.id}</h3>
            <button
              onClick={() => copyReport(lastResult)}
              className="text-xs font-sans px-3 py-1.5 rounded-lg bg-white/5 border border-white/10 hover:bg-white/10 text-white"
            >
              📋 Копировать
            </button>
          </div>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div className="relative aspect-square max-w-[512px] mx-auto bg-gradient-to-br from-[#0a0a17] via-[#1a0f2e] to-[#0f1830] rounded-xl overflow-hidden border border-emerald-500/20">
              <img src={previewSrc} alt="Preview" className="w-full h-full object-contain" />
            </div>
            <div className="space-y-3">
              <div className="text-xs font-mono text-muted-foreground">
                <div>Provider: <span className="text-cyan-300">{lastResult.provider}/{lastResult.model}</span></div>
                <div>Размер: <span className="text-purple-300">{lastResult.width}×{lastResult.height}</span></div>
                <div>Bytes: <span className="text-purple-300">{lastResult.fileSizeBytes ?? "—"}</span></div>
                <div>Стоимость: <span className="text-amber-300">~{lastResult.costEstimateRub}₽</span></div>
                <div>Длительность: <span className="text-purple-300">{Math.round((lastResult.durationMs ?? 0) / 1000)}с</span></div>
              </div>
              <div className="space-y-2 pt-2 border-t border-white/10">
                <label className="block text-xs font-sans font-bold text-white">Применить как:</label>
                <select
                  value={useAsValue}
                  onChange={(e) => setUseAsValue(e.target.value)}
                  className="w-full px-3 py-2 rounded-lg bg-[#0a0a17] border border-purple-500/30 text-white text-sm font-sans"
                >
                  <option value="musa-avatar">👤 Аватар Музы (consultant-avatar.png)</option>
                  <option value="banner-landing">🖼️ Баннер лендинга</option>
                  <option value="logo-site">✨ Логотип сайта</option>
                  <option value="custom-banner">📦 Custom: banner</option>
                </select>
                <button
                  onClick={() => onApply(lastResult.id, useAsValue)}
                  disabled={applying === lastResult.id}
                  className="w-full px-4 py-2 rounded-lg bg-gradient-to-r from-emerald-500 to-cyan-500 text-white text-sm font-display font-bold shadow-[0_0_24px_rgba(16,185,129,0.4)] hover:shadow-[0_0_32px_rgba(16,185,129,0.6)] transition-shadow disabled:opacity-40"
                >
                  {applying === lastResult.id ? "⏳ Применяем..." : "✅ Применить"}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {errorReport ? (
        <div className="glass-card rounded-2xl p-4 border border-red-500/30">
          <div className="flex items-center justify-between mb-3">
            <h3 className="text-lg font-sans font-bold text-red-300">❌ Ошибка</h3>
            <button
              onClick={() => copyReport(errorReport)}
              className="text-xs font-sans px-3 py-1.5 rounded-lg bg-white/5 border border-white/10 hover:bg-white/10 text-white"
            >
              📋 Копировать
            </button>
          </div>
          <pre className="text-xs font-mono text-red-200 bg-[#0a0a17] rounded-lg p-3 overflow-x-auto whitespace-pre-wrap max-h-96">
{JSON.stringify(errorReport, null, 2)}
          </pre>
        </div>
      ) : null}

      {/* History */}
      <div className="glass-card rounded-2xl p-4 border border-purple-500/20">
        <div className="flex items-center justify-between mb-3">
          <h3 className="text-lg font-sans font-bold text-white">🕓 История генераций (последние 20)</h3>
          <button
            onClick={() => loadHistory()}
            className="text-xs font-sans px-3 py-1.5 rounded-lg bg-white/5 border border-white/10 hover:bg-white/10 text-white"
          >
            🔄
          </button>
        </div>
        {history.length === 0 ? (
          <p className="text-sm font-sans text-muted-foreground text-center py-8">Пусто. Жми «Сгенерировать».</p>
        ) : (
          <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-3">
            {history.map((it) => (
              <div key={it.id} className="bg-[#0a0a17] rounded-xl overflow-hidden border border-white/10 hover:border-purple-400/40 transition-colors">
                <div className="aspect-square bg-gradient-to-br from-[#1a0f2e] to-[#0f1830] relative">
                  <img src={`${it.fileUrl}?v=${it.createdAt}`} alt={it.prompt.slice(0, 50)} className="w-full h-full object-cover" />
                  <span className="absolute top-1 left-1 text-[10px] font-mono px-1.5 py-0.5 rounded bg-black/60 text-purple-300">
                    #{it.id}
                  </span>
                  <span className="absolute top-1 right-1 text-[10px] font-mono px-1.5 py-0.5 rounded bg-black/60 text-cyan-300">
                    {it.type}
                  </span>
                </div>
                <div className="p-2 space-y-1">
                  <p className="text-[11px] font-sans text-white/80 line-clamp-2" title={it.prompt}>{it.prompt}</p>
                  {it.usedAs && (
                    <p className="text-[10px] font-mono text-emerald-300">→ {it.usedAs}</p>
                  )}
                  <div className="flex gap-1">
                    <a
                      href={it.fileUrl}
                      target="_blank"
                      rel="noreferrer"
                      className="flex-1 text-center text-[10px] font-sans px-2 py-1 rounded bg-purple-500/20 text-purple-300 hover:bg-purple-500/30"
                    >
                      👁
                    </a>
                    <button
                      onClick={() => onArchive(it.id)}
                      className="flex-1 text-[10px] font-sans px-2 py-1 rounded bg-red-500/20 text-red-300 hover:bg-red-500/30"
                    >
                      🗑
                    </button>
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

export default ImageGeneratorTab;
