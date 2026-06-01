// Eugene 2026-05-18 Босс «Escalation queue UI».
//
// Admin-вкладка «🚨 Эскалации» — список негативных сообщений с priority,
// triggers chips, action buttons (resolve / dismiss).
// Подвкладки: 🚨 Открытые / ✅ Решённые / ❌ Отклонённые
// Filter: priority (high/medium/low).

import { useMemo, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Loader2 } from "lucide-react";
import { ADMIN_PERIODS, type PeriodId, filterByPeriod, periodLabel } from "@/lib/adminPeriods";

type Item = {
  id: number;
  userId: number | null;
  anonymousSession: string | null;
  chatSessionId: string | null;
  messageText: string;
  sentimentScore: number | null;
  triggers: string[];
  priority: string;
  status: string;
  assignedToUserId: number | null;
  resolution: string | null;
  resolvedAt: number | null;
  createdAt: number;
};

type Resp = { items: Item[]; counts: { status: string; priority: string; cnt: number }[] };

const SUB_TABS = [
  { key: "open", label: "🚨 Открытые" },
  { key: "resolved", label: "✅ Решённые" },
  { key: "dismissed", label: "❌ Отклонённые" },
] as const;
type SubTab = (typeof SUB_TABS)[number]["key"];

const PRIORITIES = ["", "high", "medium", "low"];

function fmtTime(ms: number | null): string {
  if (!ms) return "—";
  return new Date(ms).toLocaleString("ru-RU", { dateStyle: "short", timeStyle: "short" });
}

function priorityBadge(p: string): string {
  if (p === "high") return "bg-red-500/20 text-red-300 border-red-500/40";
  if (p === "medium") return "bg-amber-500/20 text-amber-300 border-amber-500/40";
  if (p === "low") return "bg-cyan-500/15 text-cyan-300 border-cyan-500/30";
  return "bg-white/5 text-white/60 border-white/15";
}

function scoreColor(s: number | null): string {
  if (s === null) return "text-white/40";
  if (s < -0.5) return "text-red-400";
  if (s < 0) return "text-amber-300";
  return "text-emerald-400";
}

function fetchList(qs: string): Promise<Resp> {
  return fetch(`/api/admin/v304/escalations?${qs}`, { credentials: "include" })
    .then(async (r) => {
      if (!r.ok) throw new Error(`${r.status}`);
      const j = await r.json();
      return j.data as Resp;
    });
}

export default function EscalationsTab({ toast }: { toast: any }) {
  const [sub, setSub] = useState<SubTab>("open");
  const [priority, setPriority] = useState<string>("");
  // Eugene 2026-05-30 canonical period selector (client-side фильтр createdAt).
  const [period, setPeriod] = useState<PeriodId>("today");
  const qc = useQueryClient();

  const qs = useMemo(() => {
    const p = new URLSearchParams();
    p.set("status", sub);
    if (priority) p.set("priority", priority);
    p.set("limit", "200");
    return p.toString();
  }, [sub, priority]);

  const { data, isLoading } = useQuery({
    queryKey: ["/api/admin/v304/escalations", qs],
    queryFn: () => fetchList(qs),
    refetchInterval: 30_000,
  });

  const resolveMut = useMutation({
    mutationFn: async ({ id, resolution }: { id: number; resolution: string }) => {
      const r = await fetch(`/api/admin/v304/escalations/${id}/resolve`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ resolution }),
      });
      const j = await r.json();
      if (!r.ok) throw new Error(j?.error || `HTTP ${r.status}`);
      return j;
    },
    onSuccess: () => {
      toast?.({ title: "Закрыто", description: "Эскалация решена" });
      qc.invalidateQueries({ queryKey: ["/api/admin/v304/escalations"] });
    },
    onError: (e: any) =>
      toast?.({ title: "Ошибка", description: e?.message || "—", variant: "destructive" }),
  });

  const dismissMut = useMutation({
    mutationFn: async ({ id, reason }: { id: number; reason?: string }) => {
      const r = await fetch(`/api/admin/v304/escalations/${id}/dismiss`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ reason }),
      });
      const j = await r.json();
      if (!r.ok) throw new Error(j?.error || `HTTP ${r.status}`);
      return j;
    },
    onSuccess: () => {
      toast?.({ title: "Отклонено", description: "Эскалация отклонена" });
      qc.invalidateQueries({ queryKey: ["/api/admin/v304/escalations"] });
    },
    onError: (e: any) =>
      toast?.({ title: "Ошибка", description: e?.message || "—", variant: "destructive" }),
  });

  function onResolve(it: Item) {
    const r = window.prompt("Резолюция (что сделано / как закрыто):");
    if (!r || !r.trim()) return;
    resolveMut.mutate({ id: it.id, resolution: r.trim() });
  }

  function onDismiss(it: Item) {
    const r = window.prompt("Причина отклонения (опц.):") ?? undefined;
    dismissMut.mutate({ id: it.id, reason: r });
  }

  const counts = useMemo(() => {
    const m: Record<string, number> = { open: 0, resolved: 0, dismissed: 0 };
    for (const c of data?.counts ?? []) {
      if (m[c.status] !== undefined) m[c.status] += c.cnt;
    }
    return m;
  }, [data]);

  const itemsInPeriod = useMemo(
    () => filterByPeriod(data?.items ?? [], period, (it) => it.createdAt),
    [data, period],
  );

  function copyAllReport() {
    const lines: string[] = [];
    lines.push(`🚨 Эскалации — отчёт (${SUB_TABS.find((s) => s.key === sub)?.label} · ${periodLabel(period)})`);
    lines.push(`🕐 ${new Date().toLocaleString("ru-RU")}`);
    lines.push(`Всего в окне: ${itemsInPeriod.length}`);
    lines.push(`Counts: open ${counts.open || 0} · resolved ${counts.resolved || 0} · dismissed ${counts.dismissed || 0}`);
    if (itemsInPeriod.length === 0) {
      lines.push("");
      lines.push("Очередь пуста.");
    } else {
      for (const it of itemsInPeriod) {
        lines.push("");
        lines.push("═".repeat(70));
        lines.push(`#${it.id} · ${it.priority} · score:${(it.sentimentScore ?? 0).toFixed(2)} · ${fmtTime(it.createdAt)} · ${it.userId ? `user:#${it.userId}` : "анон"}`);
        lines.push(`  ${it.messageText.slice(0, 500).replace(/\s+/g, " ")}`);
        if (it.triggers?.length) lines.push(`  Триггеры: ${it.triggers.join(", ")}`);
        if (it.resolution) lines.push(`  Резолюция: ${it.resolution}`);
        if (it.resolvedAt) lines.push(`  Закрыто: ${fmtTime(it.resolvedAt)}`);
      }
    }
    navigator.clipboard.writeText(lines.join("\n")).then(
      () => toast?.({ title: "Скопировано", description: `${itemsInPeriod.length} эскалаций` }),
      () => toast?.({ title: "Ошибка", description: "Не удалось скопировать", variant: "destructive" }),
    );
  }

  return (
    <div className="space-y-4">
      <Card className="glass-card border-red-500/20">
        <CardHeader>
          <CardTitle className="font-display font-bold gradient-text text-2xl">
            🚨 Эскалации — негативная обратная связь
          </CardTitle>
          <p className="text-sm font-sans text-muted-foreground">
            Автоматически собранные негативные сообщения от Музы. High priority → Telegram alert.
          </p>
        </CardHeader>
        <CardContent>
          <div className="flex flex-wrap gap-2 mb-4">
            {SUB_TABS.map((s) => {
              const n = counts[s.key] ?? 0;
              const active = sub === s.key;
              return (
                <button
                  key={s.key}
                  type="button"
                  onClick={() => setSub(s.key)}
                  className={`px-3 py-1.5 rounded-lg text-sm font-medium transition ${
                    active
                      ? "bg-gradient-to-r from-red-500/30 via-fuchsia-500/20 to-purple-500/30 border border-red-400/50 text-white shadow-[0_0_16px_rgba(239,68,68,0.4)]"
                      : "bg-white/5 border border-white/10 text-white/70 hover:bg-white/10"
                  }`}
                >
                  {s.label} {n > 0 ? <span className="font-mono text-xs ml-1">({n})</span> : null}
                </button>
              );
            })}
          </div>

          <div className="flex flex-wrap gap-3 mb-4 items-center">
            <label className="text-xs text-white/60 font-sans flex items-center gap-2">
              Priority:
              <select
                value={priority}
                onChange={(e) => setPriority(e.target.value)}
                className="bg-black/40 border border-white/15 rounded px-2 py-1 text-white text-sm"
              >
                {PRIORITIES.map((p) => (
                  <option key={p} value={p}>{p || "все"}</option>
                ))}
              </select>
            </label>
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

          {!isLoading && itemsInPeriod.length === 0 && (
            <div className="text-white/50 text-sm py-6 text-center">Очередь пуста за {periodLabel(period)}</div>
          )}

          <div className="space-y-3">
            {itemsInPeriod.map((it) => (
              <div
                key={it.id}
                className={`glass-card rounded-xl p-4 border ${
                  it.priority === "high" ? "border-red-500/40" : "border-white/10"
                }`}
              >
                <div className="flex items-start justify-between gap-3 mb-2">
                  <div className="flex flex-wrap items-center gap-2 flex-1 min-w-0">
                    <span className={`px-2 py-0.5 rounded-full text-[11px] font-medium border ${priorityBadge(it.priority)}`}>
                      {it.priority}
                    </span>
                    <span className="font-mono text-xs text-white/40">#{it.id}</span>
                    <span className={`font-mono text-xs ${scoreColor(it.sentimentScore)}`}>
                      score:{(it.sentimentScore ?? 0).toFixed(2)}
                    </span>
                    <span className="font-mono text-xs text-white/40">{fmtTime(it.createdAt)}</span>
                    {it.userId ? (
                      <span className="font-mono text-xs text-cyan-300">user:#{it.userId}</span>
                    ) : (
                      <span className="font-mono text-xs text-white/30">аноним</span>
                    )}
                    {it.chatSessionId ? (
                      <a
                        href={`#/admin/v304?tab=dialogs&session=${encodeURIComponent(it.chatSessionId)}`}
                        className="font-mono text-xs text-purple-300 hover:underline"
                      >
                        → диалог
                      </a>
                    ) : null}
                  </div>
                  {it.status === "open" && (
                    <div className="flex gap-2 shrink-0">
                      <button
                        type="button"
                        onClick={() => onResolve(it)}
                        disabled={resolveMut.isPending}
                        className="px-3 py-1.5 rounded-lg text-sm bg-emerald-500/15 border border-emerald-500/40 text-emerald-200 hover:bg-emerald-500/25"
                      >
                        ✅ Решено
                      </button>
                      <button
                        type="button"
                        onClick={() => onDismiss(it)}
                        disabled={dismissMut.isPending}
                        className="px-3 py-1.5 rounded-lg text-sm bg-white/5 border border-white/15 text-white/70 hover:bg-white/10"
                      >
                        ❌ Отклонить
                      </button>
                    </div>
                  )}
                </div>
                <div className="text-sm font-sans text-white/90 whitespace-pre-wrap break-words mb-2">
                  {it.messageText}
                </div>
                {it.triggers && it.triggers.length > 0 && (
                  <div className="flex flex-wrap gap-1 mb-1">
                    {it.triggers.map((t, idx) => (
                      <span
                        key={idx}
                        className="text-[10px] font-mono px-1.5 py-0.5 rounded bg-red-500/10 text-red-300 border border-red-500/20"
                      >
                        {t}
                      </span>
                    ))}
                  </div>
                )}
                {it.resolution ? (
                  <div className="mt-2 text-xs text-emerald-300 font-sans">
                    Резолюция: {it.resolution}
                  </div>
                ) : null}
                {it.resolvedAt ? (
                  <div className="mt-1 text-xs text-white/40 font-mono">
                    Закрыто {fmtTime(it.resolvedAt)} админом #{it.assignedToUserId ?? "—"}
                  </div>
                ) : null}
              </div>
            ))}
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
