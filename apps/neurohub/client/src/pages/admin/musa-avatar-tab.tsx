// Musa-avatar admin tab — Eugene 2026-05-18 Босс «дожать 3D Музу».
// Brand-style consistency rule: gradient-text title, glass-card,
// btn-cosmic CTA. Copy-reports-button rule: текущий JSON state copyable.

import { useEffect, useState } from "react";
import { apiRequest } from "@/lib/queryClient";

interface MusaAvatarState {
  has3d: boolean;
  has3dPng1024: boolean;
  has3dWebp256: boolean;
  consultantPngMtime: number | null;
  publicUrls: {
    consultantPng: string;
    musa3d1024: string;
    musa3d512: string;
    musa3d256: string;
    musa3dWebp512: string;
    musa3dWebp256: string;
  };
  defaultPrompt: string;
}

interface GenerateResult {
  promptUsed: string;
  modelTried: string[];
  durationMs: number;
  publicUrls: MusaAvatarState["publicUrls"];
  previewUrl: string;
  refUsed: string | null;
}

// toast — shadcn useToast() возвращает функцию с разнообразными опциями
// (см. остальные таб-компоненты, где `toast: any`).
export function MusaAvatarTab({ toast }: { toast: any }) {
  function notify(msg: string, kind: "success" | "error" | "info" = "info") {
    toast({
      title: msg,
      variant: kind === "error" ? "destructive" : "default",
    });
  }

  const [state, setState] = useState<MusaAvatarState | null>(null);
  const [prompt, setPrompt] = useState("");
  const [refTrackId, setRefTrackId] = useState("");
  const [generating, setGenerating] = useState(false);
  const [approving, setApproving] = useState(false);
  const [lastResult, setLastResult] = useState<GenerateResult | null>(null);
  const [errorReport, setErrorReport] = useState<unknown>(null);

  async function loadState() {
    try {
      const r = await apiRequest("GET", "/api/admin/v304/musa-avatar/state");
      const j = await r.json();
      if (j.error) {
        notify(j.error, "error");
        return;
      }
      setState(j.data);
      if (!prompt) setPrompt(j.data?.defaultPrompt ?? "");
    } catch (e) {
      notify("Не удалось загрузить состояние аватара: " + String(e), "error");
    }
  }

  useEffect(() => { loadState(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, []);

  async function onGenerate() {
    setGenerating(true);
    setErrorReport(null);
    setLastResult(null);
    try {
      const body: Record<string, unknown> = {};
      if (prompt && prompt.trim().length > 12 && prompt !== state?.defaultPrompt) body.prompt = prompt.trim();
      const refNum = Number(refTrackId);
      if (refTrackId && Number.isFinite(refNum) && refNum > 0) body.useRefTrack = refNum;
      const r = await apiRequest("POST", "/api/admin/v304/musa-avatar/generate", body);
      const j = await r.json();
      if (j.error) {
        setErrorReport(j);
        notify("Генерация не удалась: " + j.error, "error");
        return;
      }
      setLastResult(j.data);
      notify(`✨ Сгенерировано через ${j.data?.modelTried?.[j.data.modelTried.length - 1] ?? "GPTunnel"} за ${Math.round((j.data?.durationMs ?? 0) / 1000)}с`, "success");
      // Force-reload preview (cache-bust)
      await loadState();
    } catch (e) {
      notify("Сетевая ошибка: " + String(e), "error");
    } finally {
      setGenerating(false);
    }
  }

  async function onApprove() {
    if (!confirm("Применить сгенерированного 3D-аватара как новый аватар Музы на сайте, в Telegram и Max? Старый PNG будет перезаписан, SVG останется в .svg.bak.")) return;
    setApproving(true);
    try {
      const r = await apiRequest("POST", "/api/admin/v304/musa-avatar/approve", {});
      const j = await r.json();
      if (j.error) {
        notify("Не удалось применить: " + j.error, "error");
        return;
      }
      notify("✅ Аватар обновлён. Боты подхватят при следующей отправке фото.", "success");
      await loadState();
    } catch (e) {
      notify("Сетевая ошибка: " + String(e), "error");
    } finally {
      setApproving(false);
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

  const cacheBust = state?.consultantPngMtime ?? Date.now();
  const previewSrc = lastResult?.previewUrl
    ? `${lastResult.previewUrl}?v=${Date.now()}`
    : `${state?.publicUrls.musa3d1024 ?? "/consultant-avatar.svg"}?v=${cacheBust}`;
  const currentBotSrc = `${state?.publicUrls.consultantPng ?? "/consultant-avatar.png"}?v=${cacheBust}`;

  return (
    <div className="space-y-6">
      {/* Заголовок */}
      <div className="p-4 rounded-2xl border border-purple-500/30 bg-gradient-to-br from-purple-500/[0.06] via-fuchsia-500/[0.04] to-cyan-500/[0.04]">
        <h2 className="text-2xl font-display font-bold gradient-text mb-1">🎨 Аватар Музы — 3D</h2>
        <p className="text-sm font-sans text-muted-foreground">
          Светлые волосы, MuzaAi-стиль, фирменные акценты (purple #7C3AED · cyan #00D4FF). Один клик «Сгенерировать» → GPTunnel вернёт image → resize 1024/512/256 PNG+WebP. После одобрения — копируется в consultant-avatar.png (сайт + Telegram + Max автоматически подхватят через mtime cache-bust).
        </p>
      </div>

      {/* Preview row */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <div className="glass-card rounded-2xl p-4 border border-purple-500/20">
          <div className="flex items-center justify-between mb-3">
            <h3 className="text-lg font-sans font-bold text-white">📸 Текущий (в эфире)</h3>
            <span className="text-[10px] font-mono text-muted-foreground">consultant-avatar.png</span>
          </div>
          <div className="relative aspect-square max-w-[256px] mx-auto bg-gradient-to-br from-[#0a0a17] via-[#1a0f2e] to-[#0f1830] rounded-xl overflow-hidden border border-purple-500/20">
            <img
              src={currentBotSrc}
              alt="Текущий аватар Музы"
              className="w-full h-full object-contain"
              onError={(e) => { (e.target as HTMLImageElement).src = "/consultant-avatar.svg"; }}
            />
          </div>
          <p className="text-xs font-mono text-muted-foreground mt-2 text-center">
            mtime: {state?.consultantPngMtime ?? "—"}
          </p>
        </div>

        <div className="glass-card rounded-2xl p-4 border border-cyan-500/20">
          <div className="flex items-center justify-between mb-3">
            <h3 className="text-lg font-sans font-bold text-white">✨ 3D Превью</h3>
            <span className="text-[10px] font-mono text-muted-foreground">musa-3d-1024.png</span>
          </div>
          <div className="relative aspect-square max-w-[256px] mx-auto bg-gradient-to-br from-[#0a0a17] via-[#1a0f2e] to-[#0f1830] rounded-xl overflow-hidden border border-cyan-500/20">
            {state?.has3dPng1024 ? (
              <img
                src={previewSrc}
                alt="3D превью"
                className="w-full h-full object-contain"
              />
            ) : (
              <div className="flex items-center justify-center h-full text-muted-foreground text-sm font-sans p-4 text-center">
                3D ещё не сгенерирован.<br />Жми «✨ Сгенерировать».
              </div>
            )}
          </div>
          {lastResult && (
            <p className="text-xs font-mono text-cyan-300 mt-2 text-center">
              {lastResult.modelTried?.[lastResult.modelTried.length - 1]} · {Math.round((lastResult.durationMs ?? 0) / 1000)}с
            </p>
          )}
        </div>
      </div>

      {/* Form */}
      <div className="glass-card rounded-2xl p-6 border border-purple-500/20 space-y-4">
        <div>
          <label className="block text-sm font-sans font-bold text-white mb-2">
            Промпт (на английском — модели лучше понимают)
          </label>
          <textarea
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            rows={5}
            className="w-full px-4 py-3 rounded-xl bg-[#0a0a17] border border-purple-500/30 text-white text-sm font-sans focus:outline-none focus:border-purple-400 focus:shadow-[0_0_16px_rgba(124,58,237,0.3)] input-glow"
            placeholder="Опиши какой видишь Музу..."
            disabled={generating}
          />
          <p className="text-xs font-sans text-muted-foreground mt-1">
            Дефолтный промпт уже подставлен — можешь оставить как есть или дописать детали (одежда, эмоция, фон).
          </p>
        </div>

        <div>
          <label className="block text-sm font-sans font-bold text-white mb-2">
            🎵 Использовать обложку трека как референс (опц.)
          </label>
          <input
            type="number"
            value={refTrackId}
            onChange={(e) => setRefTrackId(e.target.value.replace(/[^0-9]/g, ""))}
            placeholder="ID трека (generations.id)"
            className="w-full px-4 py-3 rounded-xl bg-[#0a0a17] border border-cyan-500/30 text-white text-sm font-mono focus:outline-none focus:border-cyan-400 focus:shadow-[0_0_16px_rgba(0,212,255,0.3)] input-glow"
            disabled={generating}
          />
          <p className="text-xs font-sans text-muted-foreground mt-1">
            Если у модели поддерживается image-to-image — возьмёт обложку как опорное изображение. Иначе игнорирует и работает по prompt-only.
          </p>
        </div>

        <div className="flex flex-wrap gap-3 pt-2">
          <button
            onClick={onGenerate}
            disabled={generating}
            className="btn-cosmic px-6 py-3 text-base font-display font-bold disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {generating ? "⏳ Генерируем (15-60 сек)..." : "✨ Сгенерировать"}
          </button>
          <button
            onClick={onApprove}
            disabled={!state?.has3dPng1024 || approving || generating}
            className="px-6 py-3 rounded-xl bg-gradient-to-r from-emerald-500 to-cyan-500 text-white text-base font-display font-bold shadow-[0_0_24px_rgba(16,185,129,0.4)] hover:shadow-[0_0_32px_rgba(16,185,129,0.6)] transition-shadow disabled:opacity-40 disabled:cursor-not-allowed"
          >
            {approving ? "⏳ Применяем..." : "✅ Сохранить как аватар"}
          </button>
          <button
            onClick={() => loadState()}
            className="px-4 py-3 rounded-xl bg-white/5 border border-white/10 text-white text-sm font-sans hover:bg-white/10 transition-colors"
          >
            🔄 Обновить
          </button>
        </div>
      </div>

      {/* Result / error report */}
      {lastResult && (
        <div className="glass-card rounded-2xl p-4 border border-emerald-500/20">
          <div className="flex items-center justify-between mb-3">
            <h3 className="text-lg font-sans font-bold text-white">✅ Результат генерации</h3>
            <button
              onClick={() => copyReport(lastResult)}
              className="text-xs font-sans px-3 py-1.5 rounded-lg bg-white/5 border border-white/10 hover:bg-white/10 text-white"
            >
              📋 Копировать
            </button>
          </div>
          <pre className="text-xs font-mono text-emerald-200 bg-[#0a0a17] rounded-lg p-3 overflow-x-auto whitespace-pre-wrap">
{JSON.stringify(lastResult, null, 2)}
          </pre>
        </div>
      )}

      {errorReport ? (
        <div className="glass-card rounded-2xl p-4 border border-red-500/30">
          <div className="flex items-center justify-between mb-3">
            <h3 className="text-lg font-sans font-bold text-red-300">❌ Ошибка генерации</h3>
            <button
              onClick={() => copyReport(errorReport)}
              className="text-xs font-sans px-3 py-1.5 rounded-lg bg-white/5 border border-white/10 hover:bg-white/10 text-white"
            >
              📋 Копировать отчёт
            </button>
          </div>
          <pre className="text-xs font-mono text-red-200 bg-[#0a0a17] rounded-lg p-3 overflow-x-auto whitespace-pre-wrap max-h-96">
{JSON.stringify(errorReport, null, 2)}
          </pre>
          <p className="text-xs font-sans text-muted-foreground mt-2">
            Если все модели вернули 404 — GPTunnel ещё не выкатил image-gen на этот аккаунт, либо нужно купить отдельный пакет (DALL-E 3 / Midjourney). Проверь баланс на /admin/v304 → 🔑 API ключи.
          </p>
        </div>
      ) : null}

      {/* Доп. URLs */}
      <div className="glass-card rounded-2xl p-4 border border-white/10">
        <h3 className="text-sm font-sans font-bold text-white mb-2">📁 Файлы 3D-аватара</h3>
        <ul className="text-xs font-mono text-muted-foreground space-y-1">
          <li>1024 PNG: <a className="text-purple-300 hover:underline" href={`${state?.publicUrls.musa3d1024}?v=${cacheBust}`} target="_blank" rel="noreferrer">{state?.publicUrls.musa3d1024}</a></li>
          <li>512 PNG: <a className="text-purple-300 hover:underline" href={`${state?.publicUrls.musa3d512}?v=${cacheBust}`} target="_blank" rel="noreferrer">{state?.publicUrls.musa3d512}</a></li>
          <li>256 PNG: <a className="text-purple-300 hover:underline" href={`${state?.publicUrls.musa3d256}?v=${cacheBust}`} target="_blank" rel="noreferrer">{state?.publicUrls.musa3d256}</a></li>
          <li>512 WebP: <a className="text-cyan-300 hover:underline" href={`${state?.publicUrls.musa3dWebp512}?v=${cacheBust}`} target="_blank" rel="noreferrer">{state?.publicUrls.musa3dWebp512}</a></li>
          <li>256 WebP: <a className="text-cyan-300 hover:underline" href={`${state?.publicUrls.musa3dWebp256}?v=${cacheBust}`} target="_blank" rel="noreferrer">{state?.publicUrls.musa3dWebp256}</a></li>
        </ul>
      </div>
    </div>
  );
}

export default MusaAvatarTab;
