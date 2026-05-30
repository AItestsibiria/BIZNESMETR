// Eugene 2026-05-18 Босс «Suggestion aggregator».
//
// Admin-вкладка «💡 Предложения» — кластеры + одиночные suggestions.
// Подвкладки:
//   🔥 Кластеры >= 10
//   📥 Новые (reviewed=0)
//   ✅ Просмотренные (reviewed=1)
//
// Brand-style: glass-card / gradient-text / font-mono для scores.

import { useMemo, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Loader2 } from "lucide-react";
import { ADMIN_PERIODS, type PeriodId, filterByPeriod, periodLabel } from "@/lib/adminPeriods";

type Item = {
  id: number;
  user_id: number | null;
  anonymous_session: string | null;
  category: string | null;
  text: string;
  sentiment_score: number | null;
  source: string;
  chat_session_id: string | null;
  cluster_key: string;
  created_at: number;
  reviewed: number;
  reviewed_at: number | null;
  admin_note: string | null;
};

type Cluster = {
  cluster_key: string;
  cnt: number;
  sample_text: string;
  avg_sentiment: number | null;
  first_at: number;
  last_at: number;
};

type Resp = { items: Item[]; clusters: Cluster[]; threshold: number };

const SUB_TABS = [
  { key: "clusters", label: "🔥 Кластеры" },
  { key: "new", label: "📥 Новые" },
  { key: "reviewed", label: "✅ Просмотренные" },
] as const;
type SubTab = (typeof SUB_TABS)[number]["key"];

const CATEGORIES = ["", "feature", "bug", "pricing", "ui", "persona", "other"];

function fmtTime(ms: number | null): string {
  if (!ms) return "—";
  return new Date(ms).toLocaleString("ru-RU", { dateStyle: "short", timeStyle: "short" });
}

function sentimentColor(s: number | null): string {
  if (s === null) return "text-white/40";
  if (s > 0.2) return "text-emerald-400";
  if (s < -0.2) return "text-red-400";
  return "text-amber-300";
}

function sentimentLabel(s: number | null): string {
  if (s === null) return "—";
  if (s > 0.2) return "🟢";
  if (s < -0.2) return "🔴";
  return "🟡";
}

function fetchSuggestions(qs: string): Promise<Resp> {
  return fetch(`/api/admin/v304/suggestions?${qs}`, { credentials: "include" })
    .then(async (r) => {
      if (!r.ok) throw new Error(`${r.status}`);
      const j = await r.json();
      return j.data as Resp;
    });
}

export default function SuggestionsTab({ toast }: { toast: any }) {
  const [sub, setSub] = useState<SubTab>("clusters");
  const [category, setCategory] = useState<string>("");
  const [threshold, setThreshold] = useState<number>(10);
  const [expandedCluster, setExpandedCluster] = useState<string | null>(null);
  // Eugene 2026-05-30: canonical period selector (client-side фильтр).
  const [period, setPeriod] = useState<PeriodId>("today");
  const qc = useQueryClient();

  const qs = useMemo(() => {
    const p = new URLSearchParams();
    if (sub === "new") p.set("reviewed", "0");
    else if (sub === "reviewed") p.set("reviewed", "1");
    if (category) p.set("category", category);
    p.set("minThreshold", String(threshold));
    p.set("limit", "200");
    return p.toString();
  }, [sub, category, threshold]);

  const { data, isLoading } = useQuery({
    queryKey: ["/api/admin/v304/suggestions", qs],
    queryFn: () => fetchSuggestions(qs),
    refetchInterval: 60_000,
  });

  const reviewMut = useMutation({
    mutationFn: async ({ id, note }: { id: number; note?: string }) => {
      const r = await fetch(`/api/admin/v304/suggestions/${id}/review`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ note }),
      });
      const j = await r.json();
      if (!r.ok) throw new Error(j?.error || `HTTP ${r.status}`);
      return j;
    },
    onSuccess: () => {
      toast?.({ title: "Просмотрено", description: "Предложение отмечено" });
      qc.invalidateQueries({ queryKey: ["/api/admin/v304/suggestions"] });
    },
    onError: (e: any) =>
      toast?.({ title: "Ошибка", description: e?.message || "—", variant: "destructive" }),
  });

  function onReview(it: Item) {
    const note = window.prompt("Заметка админа (опционально):") ?? undefined;
    reviewMut.mutate({ id: it.id, note });
  }

  const itemsInPeriod = useMemo(
    () => filterByPeriod(data?.items ?? [], period, (it) => it.created_at),
    [data, period],
  );

  const clustersInPeriod = useMemo(
    () => (data?.clusters ?? []).filter((c) => {
      // Кластер попадает в период если его last_at пересекает окно.
      const inPeriod = filterByPeriod([{ ts: c.last_at }], period, (x) => x.ts);
      return inPeriod.length > 0;
    }),
    [data, period],
  );

  function copyAllReport() {
    const lines: string[] = [];
    lines.push(`💡 Предложения юзеров — отчёт (${SUB_TABS.find((s) => s.key === sub)?.label} · ${periodLabel(period)})`);
    lines.push(`🕐 ${new Date().toLocaleString("ru-RU")}`);
    if (sub === "clusters") {
      lines.push(`Кластеры с порогом ≥ ${threshold}: ${clustersInPeriod.length}`);
      for (const c of clustersInPeriod) {
        lines.push("");
        lines.push(`× ${c.cnt} · sentiment ${(c.avg_sentiment ?? 0).toFixed(2)} · ${fmtTime(c.first_at)} → ${fmtTime(c.last_at)}`);
        lines.push(`  ${c.sample_text}`);
      }
    } else {
      lines.push(`Записей: ${itemsInPeriod.length}`);
      for (const it of itemsInPeriod) {
        lines.push("");
        lines.push(`#${it.id} · ${it.category || "—"} · sentiment ${(it.sentiment_score ?? 0).toFixed(2)} · ${fmtTime(it.created_at)}`);
        lines.push(`  ${it.text.replace(/\s+/g, " ")}`);
        if (it.admin_note) lines.push(`  Заметка админа: ${it.admin_note}`);
      }
    }
    navigator.clipboard.writeText(lines.join("\n")).then(
      () => toast?.({ title: "Скопировано", description: `${sub === "clusters" ? clustersInPeriod.length + " кластеров" : itemsInPeriod.length + " записей"}` }),
      () => toast?.({ title: "Ошибка", variant: "destructive" }),
    );
  }

  return (
    <div className="space-y-4">
      <Card className="glass-card border-purple-500/20">
        <CardHeader>
          <CardTitle className="font-display font-bold gradient-text text-2xl">
            💡 Предложения юзеров
          </CardTitle>
          <p className="text-sm font-sans text-muted-foreground">
            Собранные через Музу запросы + жалобы. Кластеры показывают что повторяется.
          </p>
        </CardHeader>
        <CardContent>
          <div className="flex flex-wrap gap-2 mb-4">
            {SUB_TABS.map((s) => {
              const active = sub === s.key;
              return (
                <button
                  key={s.key}
                  type="button"
                  onClick={() => setSub(s.key)}
                  className={`px-3 py-1.5 rounded-lg text-sm font-medium transition ${
                    active
                      ? "bg-gradient-to-r from-purple-500/30 via-fuchsia-500/20 to-blue-500/30 border border-purple-400/50 text-white shadow-[0_0_16px_rgba(124,58,237,0.4)]"
                      : "bg-white/5 border border-white/10 text-white/70 hover:bg-white/10"
                  }`}
                >
                  {s.label}
                </button>
              );
            })}
          </div>

          <div className="flex flex-wrap gap-3 mb-4 items-center">
            <label className="text-xs text-white/60 font-sans flex items-center gap-2">
              Категория:
              <select
                value={category}
                onChange={(e) => setCategory(e.target.value)}
                className="bg-black/40 border border-white/15 rounded px-2 py-1 text-white text-sm"
              >
                {CATEGORIES.map((c) => (
                  <option key={c} value={c}>{c || "все"}</option>
                ))}
              </select>
            </label>
            {sub === "clusters" && (
              <label className="text-xs text-white/60 font-sans flex items-center gap-2">
                Порог:
                <input
                  type="number"
                  value={threshold}
                  min={2}
                  max={500}
                  onChange={(e) => setThreshold(Math.max(2, Number(e.target.value) || 10))}
                  className="bg-black/40 border border-white/15 rounded px-2 py-1 text-white text-sm w-20 font-mono"
                />
              </label>
            )}
            {/* Eugene 2026-05-30 canonical period chips */}
            <div className="flex flex-wrap gap-1 items-center">
              {ADMIN_PERIODS.map((p) => (
                <button
                  key={p.id}
                  type="button"
                  onClick={() => setPeriod(p.id)}
                  className={`px-2.5 py-1 rounded-md text-xs font-medium border ${
                    period === p.id
                      ? "bg-purple-500/20 text-purple-200 border-purple-400/50"
                      : "bg-white/5 border-white/10 text-white/60 hover:bg-white/10"
                  }`}
                >{p.label}</button>
              ))}
            </div>
            <button
              type="button"
              onClick={copyAllReport}
              disabled={isLoading}
              className="text-[11px] px-2 py-1 rounded-md bg-fuchsia-500/15 border border-fuchsia-500/40 text-fuchsia-200 hover:bg-fuchsia-500/25 disabled:opacity-50 ml-auto"
            >📋 Скопировать ВСЕ</button>
          </div>

          {isLoading && (
            <div className="flex items-center gap-2 text-white/60 py-6 justify-center">
              <Loader2 className="w-4 h-4 animate-spin" /> Загрузка…
            </div>
          )}

          {sub === "clusters" && !isLoading && (
            <div className="space-y-3">
              {clustersInPeriod.length === 0 && (
                <div className="text-white/50 text-sm py-6 text-center">
                  Нет кластеров с порогом ≥ {threshold} за {periodLabel(period)}
                </div>
              )}
              {clustersInPeriod.map((c) => {
                const isOpen = expandedCluster === c.cluster_key;
                const items = itemsInPeriod.filter((i) => i.cluster_key === c.cluster_key);
                return (
                  <div key={c.cluster_key} className="glass-card rounded-xl p-4 border border-amber-500/30">
                    <div className="flex items-start justify-between gap-3 mb-2">
                      <div>
                        <div className="flex items-center gap-2 mb-1">
                          <span className="font-display font-bold text-amber-300 text-lg font-mono">
                            ×{c.cnt}
                          </span>
                          <span className={`text-xs font-mono ${sentimentColor(c.avg_sentiment)}`}>
                            {sentimentLabel(c.avg_sentiment)} {(c.avg_sentiment ?? 0).toFixed(2)}
                          </span>
                          <span className="text-xs font-mono text-white/40">
                            {fmtTime(c.first_at)} → {fmtTime(c.last_at)}
                          </span>
                        </div>
                        <div className="text-sm text-white/90">{c.sample_text}</div>
                      </div>
                      <button
                        type="button"
                        onClick={() => setExpandedCluster(isOpen ? null : c.cluster_key)}
                        className="px-3 py-1.5 rounded-lg text-xs bg-white/5 border border-white/15 text-white/70 hover:bg-white/10 shrink-0"
                      >
                        {isOpen ? "↑ Свернуть" : "↓ Развернуть"}
                      </button>
                    </div>
                    {isOpen && (
                      <div className="mt-3 space-y-2 pl-4 border-l-2 border-amber-500/30">
                        {items.length === 0 ? (
                          <div className="text-xs text-white/50">
                            Записи кластера не попали в текущий limit — снизь фильтры.
                          </div>
                        ) : (
                          items.map((it) => (
                            <div key={it.id} className="text-xs text-white/70 font-sans">
                              <span className="font-mono text-white/40">#{it.id}</span> · {fmtTime(it.created_at)} ·{" "}
                              <span className={sentimentColor(it.sentiment_score)}>
                                {sentimentLabel(it.sentiment_score)}
                              </span>{" "}
                              · {it.text.slice(0, 200)}
                            </div>
                          ))
                        )}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}

          {sub !== "clusters" && !isLoading && (
            <div className="space-y-2">
              {itemsInPeriod.length === 0 && (
                <div className="text-white/50 text-sm py-6 text-center">Список пуст за {periodLabel(period)}</div>
              )}
              {itemsInPeriod.map((it) => (
                <div key={it.id} className="glass-card rounded-xl p-3 border border-purple-500/20">
                  <div className="flex items-start justify-between gap-3">
                    <div className="flex-1 min-w-0">
                      <div className="flex flex-wrap items-center gap-2 mb-1 text-xs">
                        <span className="font-mono text-white/40">#{it.id}</span>
                        {it.category ? (
                          <span className="px-2 py-0.5 rounded-full bg-purple-500/15 text-purple-300 border border-purple-500/30">
                            {it.category}
                          </span>
                        ) : null}
                        <span className={`font-mono ${sentimentColor(it.sentiment_score)}`}>
                          {sentimentLabel(it.sentiment_score)} {(it.sentiment_score ?? 0).toFixed(2)}
                        </span>
                        <span className="font-mono text-white/40">{fmtTime(it.created_at)}</span>
                      </div>
                      <div className="text-sm text-white/90 whitespace-pre-wrap break-words">{it.text}</div>
                      {it.admin_note ? (
                        <div className="text-xs text-emerald-300 mt-1">Заметка: {it.admin_note}</div>
                      ) : null}
                    </div>
                    {!it.reviewed && (
                      <button
                        type="button"
                        onClick={() => onReview(it)}
                        disabled={reviewMut.isPending}
                        className="px-3 py-1.5 rounded-lg text-sm bg-emerald-500/15 border border-emerald-500/40 text-emerald-200 hover:bg-emerald-500/25 shrink-0"
                      >
                        ✅ Просмотрел
                      </button>
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
