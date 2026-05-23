// Eugene 2026-05-22 Босс «жёсткий апгрейд скиллов Ярс + запрет изменений
// через мессенджеры». UI tab для очереди Yars-команд из chat-каналов.
// Apply/reject — только через Claude chat (claude.ai/code), не отсюда.
// Tab показывает что пришло, какого риска, и какой статус decision.
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";

interface YarsQueueItem {
  id: number;
  text: string;
  role: string;
  yars_category: string | null;
  yars_risk_level: "low" | "medium" | "high" | null;
  claude_review_decision: "pending" | "applied" | "rejected" | "auto_applied" | null;
  claude_review_at: number | null;
  claude_review_commit_sha: string | null;
  created_at: number;
  channel?: string;
  user_id?: number;
}

interface YarsQueueResponse {
  queue: YarsQueueItem[];
  summary: { total: number; byRisk: Record<string, number>; byCategory: Record<string, number> };
}

const RISK_STYLE: Record<string, string> = {
  low: "bg-emerald-500/15 text-emerald-300 border-emerald-500/40",
  medium: "bg-amber-500/15 text-amber-300 border-amber-500/40",
  high: "bg-red-500/15 text-red-300 border-red-500/40",
};

const DECISION_LABEL: Record<string, { txt: string; color: string }> = {
  pending: { txt: "⏳ Ждёт", color: "text-amber-300" },
  applied: { txt: "✅ Применено", color: "text-emerald-300" },
  auto_applied: { txt: "⚡ Auto", color: "text-cyan-300" },
  rejected: { txt: "❌ Отклонено", color: "text-red-300" },
};

export default function YarsQueueTab({ toast: _toast }: { toast?: any }) {
  const [statusFilter, setStatusFilter] = useState<"pending" | "all" | "applied" | "rejected">("pending");
  const [riskFilter, setRiskFilter] = useState<"" | "low" | "medium" | "high">("");

  const { data, isLoading, isError } = useQuery<YarsQueueResponse>({
    queryKey: ["/api/admin/v304/yars-queue", statusFilter, riskFilter],
    queryFn: async () => {
      const qs = new URLSearchParams();
      qs.set("status", statusFilter);
      qs.set("limit", "100");
      if (riskFilter) qs.set("risk", riskFilter);
      const r = await fetch(`/api/admin/v304/yars-queue?${qs.toString()}`, { credentials: "include" });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return r.json();
    },
    refetchInterval: 30_000,
  });

  return (
    <div className="space-y-4">
      {/* Warning banner — explain workflow */}
      <div className="glass-card rounded-2xl border border-amber-400/40 bg-amber-500/10 p-3 text-xs text-amber-200">
        <div className="font-semibold mb-1">🚨 Правило (Eugene 2026-05-22):</div>
        Ярс-команды из мессенджеров (TG/Max/web-chat) НЕ применяются автоматически
        к ключевым элементам проекта. Здесь показывается очередь — Claude анализирует
        и предлагает в чате claude.ai/code, Босс подтверждает там. Этот tab —
        read-only обзор.
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <div className="text-xs text-muted-foreground">Статус:</div>
        {(["pending", "applied", "rejected", "all"] as const).map((s) => (
          <button
            key={s}
            onClick={() => setStatusFilter(s)}
            className={`px-3 py-1 rounded-full text-xs border transition-colors ${
              statusFilter === s
                ? "bg-purple-500/25 border-purple-400/60 text-white"
                : "bg-white/5 border-white/10 text-muted-foreground hover:bg-white/10"
            }`}
          >
            {s === "pending" ? "⏳ Ждут" : s === "applied" ? "✅ Применено" : s === "rejected" ? "❌ Отклонено" : "Все"}
          </button>
        ))}
        <div className="text-xs text-muted-foreground ml-4">Риск:</div>
        {(["", "low", "medium", "high"] as const).map((r) => (
          <button
            key={r || "all"}
            onClick={() => setRiskFilter(r)}
            className={`px-3 py-1 rounded-full text-xs border transition-colors ${
              riskFilter === r
                ? "bg-purple-500/25 border-purple-400/60 text-white"
                : "bg-white/5 border-white/10 text-muted-foreground hover:bg-white/10"
            }`}
          >
            {r === "" ? "Все" : r === "low" ? "🟢 Low" : r === "medium" ? "🟡 Medium" : "🔴 High"}
          </button>
        ))}
      </div>

      {data?.summary && (
        <div className="flex flex-wrap items-center gap-3 text-xs">
          <span className="px-2 py-1 rounded bg-white/5 text-white/70">Всего: <b>{data.summary.total}</b></span>
          {Object.entries(data.summary.byRisk).map(([r, n]) => (
            <span key={r} className={`px-2 py-1 rounded border ${RISK_STYLE[r] || "bg-white/5 text-white/70 border-white/10"}`}>
              {r === "low" ? "🟢" : r === "medium" ? "🟡" : r === "high" ? "🔴" : "•"} {r} · {n}
            </span>
          ))}
        </div>
      )}

      {isLoading && <div className="text-sm text-muted-foreground">Загрузка...</div>}
      {isError && <div className="text-sm text-red-400">Ошибка загрузки очереди</div>}
      {data && data.queue.length === 0 && (
        <div className="text-sm text-muted-foreground py-6 text-center">
          Пусто — нет команд {statusFilter}{riskFilter ? ` · ${riskFilter}` : ""}
        </div>
      )}

      <div className="space-y-2">
        {data?.queue.map((item) => {
          const dec = item.claude_review_decision || "pending";
          const decMeta = DECISION_LABEL[dec] || DECISION_LABEL.pending;
          const risk = item.yars_risk_level || "medium";
          return (
            <div key={item.id} className="glass-card rounded-xl border border-white/10 p-3 space-y-2">
              <div className="flex items-center justify-between gap-2 flex-wrap">
                <div className="flex items-center gap-2">
                  <span className={`px-2 py-0.5 rounded text-[10px] border ${RISK_STYLE[risk]}`}>
                    {risk === "low" ? "🟢" : risk === "medium" ? "🟡" : "🔴"} {risk}
                  </span>
                  {item.yars_category && (
                    <span className="px-2 py-0.5 rounded text-[10px] bg-white/5 text-white/60 border border-white/10">
                      {item.yars_category}
                    </span>
                  )}
                  {item.channel && (
                    <span className="px-2 py-0.5 rounded text-[10px] bg-purple-500/15 text-purple-200 border border-purple-400/30">
                      {item.channel}
                    </span>
                  )}
                  <span className={`text-xs ${decMeta.color}`}>{decMeta.txt}</span>
                </div>
                <div className="text-[10px] text-muted-foreground tabular-nums">
                  #{item.id} · {new Date(item.created_at).toLocaleString("ru-RU")}
                </div>
              </div>
              <div className="text-sm text-white/90 whitespace-pre-wrap break-words">{item.text}</div>
              {item.claude_review_commit_sha && (
                <div className="text-[10px] text-cyan-300 font-mono">
                  SHA: {item.claude_review_commit_sha.slice(0, 12)}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
