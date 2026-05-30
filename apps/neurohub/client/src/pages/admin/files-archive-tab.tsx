// Admin files archive tab — Eugene 2026-05-18 Босс «Архив файлов как таблица
// треков».
//
// Brand-style consistency rule: gradient-text, glass-card, font-mono для ID и
// размеров. Copy-reports-button rule на любые выводы JSON.

import { useEffect, useState, useMemo } from "react";
import { apiRequest } from "@/lib/queryClient";
import { ADMIN_PERIODS, type PeriodId, filterByPeriod, periodLabel } from "@/lib/adminPeriods";

type ImagePreset = "avatar" | "cover" | "banner" | "logo" | "product" | "custom" | "all";

interface GeneratedFile {
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
  usedAt: number | null;
  archived: boolean;
  createdAt: number;
  createdByUserId: number | null;
  meta?: unknown;
}

const TYPE_FILTERS: Array<{ value: ImagePreset; label: string; emoji: string }> = [
  { value: "all", label: "Все", emoji: "📁" },
  { value: "avatar", label: "Аватары", emoji: "👤" },
  { value: "cover", label: "Обложки", emoji: "💿" },
  { value: "banner", label: "Баннеры", emoji: "🖼️" },
  { value: "logo", label: "Логотипы", emoji: "✨" },
  { value: "product", label: "Продукты", emoji: "📦" },
  { value: "custom", label: "Свободные", emoji: "🎨" },
];

function fmtSize(bytes: number | null): string {
  if (!bytes) return "—";
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / 1024 / 1024).toFixed(2)}MB`;
}

function fmtTime(ms: number): string {
  return new Date(ms).toLocaleString("ru-RU", { dateStyle: "short", timeStyle: "short" });
}

export function FilesArchiveTab({ toast }: { toast: any }) {
  function notify(msg: string, kind: "success" | "error" | "info" = "info") {
    toast({ title: msg, variant: kind === "error" ? "destructive" : "default" });
  }

  const [view, setView] = useState<"active" | "archived">("active");
  const [typeFilter, setTypeFilter] = useState<ImagePreset>("all");
  const [items, setItems] = useState<GeneratedFile[]>([]);
  const [loading, setLoading] = useState(false);
  const [previewItem, setPreviewItem] = useState<GeneratedFile | null>(null);
  const [regenerating, setRegenerating] = useState<number | null>(null);
  // Eugene 2026-05-30: canonical period chips по createdAt.
  const [period, setPeriod] = useState<PeriodId>("today");

  const itemsInPeriod = useMemo(
    () => filterByPeriod(items, period, (it) => it.createdAt),
    [items, period],
  );

  function copyAllFiles() {
    const lines: string[] = [];
    lines.push(`📁 Архив файлов — отчёт (${view === "archived" ? "Архив" : "Активные"} · ${typeFilter} · ${periodLabel(period)})`);
    lines.push(`🕐 ${new Date().toLocaleString("ru-RU")}`);
    lines.push(`Записей: ${itemsInPeriod.length}`);
    for (const it of itemsInPeriod) {
      lines.push("");
      lines.push(`#${it.id} · ${it.type} · ${it.provider || "?"}/${it.model || "?"} · ${it.width || "?"}×${it.height || "?"} · ${fmtSize(it.fileSizeBytes)}`);
      lines.push(`  Создан: ${fmtTime(it.createdAt)}${it.usedAs ? ` · применён как ${it.usedAs}` : ""}`);
      lines.push(`  Промпт: ${(it.prompt || "").slice(0, 250).replace(/\s+/g, " ")}`);
      lines.push(`  URL: ${it.fileUrl}`);
    }
    navigator.clipboard.writeText(lines.join("\n")).then(() => notify(`📋 Скопировано: ${itemsInPeriod.length} файлов`, "success"));
  }

  async function loadList() {
    setLoading(true);
    try {
      const params = new URLSearchParams();
      params.set("limit", "200");
      params.set("archived", view === "archived" ? "1" : "0");
      if (typeFilter !== "all") params.set("type", typeFilter);
      const r = await apiRequest("GET", `/api/admin/v304/images?${params.toString()}`);
      const j = await r.json();
      if (j.error) {
        notify(j.error, "error");
        return;
      }
      setItems(j.data?.items ?? []);
    } catch (e) {
      notify("Не удалось загрузить: " + String(e), "error");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    loadList();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view, typeFilter]);

  async function onArchive(id: number) {
    if (!confirm(`Архивировать #${id}?`)) return;
    try {
      const r = await apiRequest("DELETE", `/api/admin/v304/images/${id}`);
      const j = await r.json();
      if (j.error) { notify(j.error, "error"); return; }
      notify("📦 Архивировано", "success");
      await loadList();
    } catch (e) {
      notify("Сетевая ошибка: " + String(e), "error");
    }
  }

  async function onRegenerate(it: GeneratedFile) {
    if (!confirm(`Регенерировать с тем же промптом? (создаст новую запись, текущая не удаляется)`)) return;
    setRegenerating(it.id);
    try {
      const body = {
        prompt: it.prompt,
        presetCategory: it.type,
      };
      const r = await apiRequest("POST", "/api/admin/v304/images/generate", body);
      const j = await r.json();
      if (j.error) { notify(j.error, "error"); return; }
      notify(`✨ Новая генерация #${j.data?.id}`, "success");
      await loadList();
    } catch (e) {
      notify("Сетевая ошибка: " + String(e), "error");
    } finally {
      setRegenerating(null);
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

  return (
    <div className="space-y-6">
      {/* Заголовок */}
      <div className="p-4 rounded-2xl border border-cyan-500/30 bg-gradient-to-br from-cyan-500/[0.06] via-purple-500/[0.04] to-fuchsia-500/[0.04]">
        <h2 className="text-2xl font-display font-bold gradient-text mb-1">📁 Архив файлов</h2>
        <p className="text-sm font-sans text-muted-foreground">
          Все сгенерированные изображения. Фильтры по типу, переключатель «Активные / В архиве», действия: preview / скачать / archive / регенерировать.
        </p>
      </div>

      {/* View toggle */}
      <div className="glass-card rounded-2xl p-4 border border-purple-500/20">
        <div className="flex flex-wrap gap-3 items-center">
          <div className="flex gap-1 p-1 bg-[#0a0a17] rounded-xl border border-white/10">
            <button
              onClick={() => setView("active")}
              className={`px-4 py-2 rounded-lg text-sm font-sans font-medium transition-all ${
                view === "active"
                  ? "bg-gradient-to-r from-purple-500/40 to-cyan-500/30 text-white shadow-[0_0_16px_rgba(124,58,237,0.3)]"
                  : "text-muted-foreground hover:text-white"
              }`}
            >
              Активные
            </button>
            <button
              onClick={() => setView("archived")}
              className={`px-4 py-2 rounded-lg text-sm font-sans font-medium transition-all ${
                view === "archived"
                  ? "bg-gradient-to-r from-amber-500/40 to-red-500/30 text-white shadow-[0_0_16px_rgba(251,191,36,0.3)]"
                  : "text-muted-foreground hover:text-white"
              }`}
            >
              📦 В архиве
            </button>
          </div>

          <div className="flex flex-wrap gap-1">
            {TYPE_FILTERS.map((f) => (
              <button
                key={f.value}
                onClick={() => setTypeFilter(f.value)}
                className={`px-3 py-1.5 rounded-lg text-xs font-sans transition-all ${
                  typeFilter === f.value
                    ? "bg-purple-500/30 border border-purple-400/50 text-white"
                    : "bg-white/5 border border-white/10 text-muted-foreground hover:bg-white/10 hover:text-white"
                }`}
              >
                {f.emoji} {f.label}
              </button>
            ))}
          </div>

          <button
            onClick={copyAllFiles}
            disabled={loading || itemsInPeriod.length === 0}
            className="ml-auto px-3 py-1.5 rounded-lg bg-fuchsia-500/15 border border-fuchsia-500/40 text-fuchsia-200 text-xs font-sans hover:bg-fuchsia-500/25 disabled:opacity-50"
          >
            📋 Скопировать ВСЕ
          </button>
          <button
            onClick={() => loadList()}
            className="px-3 py-1.5 rounded-lg bg-white/5 border border-white/10 text-white text-xs font-sans hover:bg-white/10"
          >
            🔄 Обновить
          </button>
        </div>
        {/* Eugene 2026-05-30 canonical period chips (по createdAt) */}
        <div className="flex flex-wrap items-center gap-1 mt-3">
          <span className="text-[10px] text-white/50 font-semibold">Период:</span>
          {ADMIN_PERIODS.map((p) => (
            <button
              key={p.id}
              type="button"
              onClick={() => setPeriod(p.id)}
              className={`text-[11px] px-2.5 py-1 rounded-md border ${
                period === p.id
                  ? "bg-purple-500/20 text-purple-200 border-purple-400/50"
                  : "bg-white/5 border-white/10 text-white/60 hover:bg-white/10"
              }`}
            >{p.label}</button>
          ))}
        </div>
      </div>

      {/* Table */}
      <div className="glass-card rounded-2xl border border-purple-500/20 overflow-hidden">
        {loading ? (
          <div className="text-center py-12 text-sm font-sans text-muted-foreground">Загрузка...</div>
        ) : itemsInPeriod.length === 0 ? (
          <div className="text-center py-12 text-sm font-sans text-muted-foreground">Пусто за {periodLabel(period)}.</div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm font-sans">
              <thead className="bg-[#0a0a17] border-b border-white/10">
                <tr>
                  <th className="text-left px-3 py-2 text-xs text-muted-foreground font-mono">#</th>
                  <th className="text-left px-3 py-2 text-xs text-muted-foreground">Preview</th>
                  <th className="text-left px-3 py-2 text-xs text-muted-foreground">Тип</th>
                  <th className="text-left px-3 py-2 text-xs text-muted-foreground">Промпт</th>
                  <th className="text-left px-3 py-2 text-xs text-muted-foreground">Провайдер</th>
                  <th className="text-left px-3 py-2 text-xs text-muted-foreground font-mono">Размер</th>
                  <th className="text-left px-3 py-2 text-xs text-muted-foreground">Создан</th>
                  <th className="text-left px-3 py-2 text-xs text-muted-foreground">Применён</th>
                  <th className="text-left px-3 py-2 text-xs text-muted-foreground">Actions</th>
                </tr>
              </thead>
              <tbody>
                {itemsInPeriod.map((it) => (
                  <tr key={it.id} className="border-b border-white/5 hover:bg-white/[0.02]">
                    <td className="px-3 py-2 font-mono text-xs text-purple-300">{it.id}</td>
                    <td className="px-3 py-2">
                      <img
                        src={`${it.fileUrl}?v=${it.createdAt}`}
                        alt=""
                        className="w-12 h-12 object-cover rounded border border-white/10 cursor-pointer"
                        onClick={() => setPreviewItem(it)}
                      />
                    </td>
                    <td className="px-3 py-2">
                      <span className="text-[10px] font-sans px-2 py-0.5 rounded-full bg-cyan-500/20 text-cyan-300 font-medium">
                        {it.type}
                      </span>
                    </td>
                    <td className="px-3 py-2 max-w-xs">
                      <span className="text-xs font-sans text-white/80 line-clamp-2" title={it.prompt}>
                        {it.prompt.slice(0, 100)}
                      </span>
                    </td>
                    <td className="px-3 py-2 text-xs font-mono text-muted-foreground">
                      {it.provider ?? "—"}<br />
                      <span className="text-[10px]">{it.model ?? ""}</span>
                    </td>
                    <td className="px-3 py-2 text-xs font-mono text-muted-foreground">
                      {it.width}×{it.height}<br />
                      <span className="text-[10px]">{fmtSize(it.fileSizeBytes)}</span>
                    </td>
                    <td className="px-3 py-2 text-xs font-mono text-muted-foreground">{fmtTime(it.createdAt)}</td>
                    <td className="px-3 py-2 text-xs">
                      {it.usedAs ? (
                        <span className="text-emerald-300 font-mono">{it.usedAs}</span>
                      ) : (
                        <span className="text-muted-foreground">—</span>
                      )}
                    </td>
                    <td className="px-3 py-2">
                      <div className="flex gap-1">
                        <button
                          onClick={() => setPreviewItem(it)}
                          className="px-2 py-1 rounded text-xs bg-purple-500/20 text-purple-300 hover:bg-purple-500/30"
                          title="Просмотр"
                        >👁</button>
                        <a
                          href={it.fileUrl}
                          download
                          className="px-2 py-1 rounded text-xs bg-cyan-500/20 text-cyan-300 hover:bg-cyan-500/30"
                          title="Скачать"
                        >⬇</a>
                        <button
                          onClick={() => onRegenerate(it)}
                          disabled={regenerating === it.id}
                          className="px-2 py-1 rounded text-xs bg-amber-500/20 text-amber-300 hover:bg-amber-500/30 disabled:opacity-40"
                          title="Регенерировать"
                        >🔄</button>
                        {!it.archived && (
                          <button
                            onClick={() => onArchive(it.id)}
                            className="px-2 py-1 rounded text-xs bg-red-500/20 text-red-300 hover:bg-red-500/30"
                            title="Архивировать"
                          >🗑</button>
                        )}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Preview modal */}
      {previewItem && (
        <div
          className="fixed inset-0 z-50 bg-gradient-to-br from-[#0a0a17]/95 via-[#1a0f2e]/95 to-[#0a0a17]/95 backdrop-blur-xl flex items-center justify-center p-4"
          onClick={() => setPreviewItem(null)}
        >
          <div
            className="glass-card rounded-2xl p-6 border border-purple-500/30 max-w-3xl w-full max-h-[90dvh] overflow-y-auto"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between mb-4">
              <h3 className="text-lg font-display font-bold gradient-text">
                Изображение #{previewItem.id}
              </h3>
              <button
                onClick={() => setPreviewItem(null)}
                className="text-white/60 hover:text-white text-2xl leading-none"
              >×</button>
            </div>
            <img
              src={`${previewItem.fileUrl}?v=${previewItem.createdAt}`}
              alt=""
              className="w-full max-h-[60dvh] object-contain bg-[#0a0a17] rounded-xl mb-4"
            />
            <div className="space-y-2 text-xs font-mono text-muted-foreground">
              <div>Тип: <span className="text-cyan-300">{previewItem.type}</span></div>
              <div>Provider: <span className="text-purple-300">{previewItem.provider}/{previewItem.model}</span></div>
              <div>Размер: <span className="text-purple-300">{previewItem.width}×{previewItem.height} · {fmtSize(previewItem.fileSizeBytes)}</span></div>
              <div>Создан: <span className="text-purple-300">{fmtTime(previewItem.createdAt)}</span></div>
              {previewItem.usedAs && (
                <div>Применён как: <span className="text-emerald-300">{previewItem.usedAs}</span> · {previewItem.usedAt ? fmtTime(previewItem.usedAt) : "—"}</div>
              )}
              <div className="pt-2 border-t border-white/10">
                <div className="text-xs text-white/80 mb-1">Промпт:</div>
                <pre className="text-xs font-sans whitespace-pre-wrap bg-[#0a0a17] p-3 rounded-lg">{previewItem.prompt}</pre>
              </div>
              <div className="flex gap-2 pt-3">
                <button
                  onClick={() => copyReport(previewItem)}
                  className="px-3 py-1.5 rounded-lg text-xs font-sans bg-white/5 border border-white/10 hover:bg-white/10 text-white"
                >📋 Копировать JSON</button>
                <a
                  href={previewItem.fileUrl}
                  download
                  className="px-3 py-1.5 rounded-lg text-xs font-sans bg-cyan-500/20 text-cyan-300 hover:bg-cyan-500/30"
                >⬇ Скачать</a>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

export default FilesArchiveTab;
