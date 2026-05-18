// Eugene 2026-05-18 Босс «Operator-команды (Ярс)».
//
// Admin-вкладка «🎙 Команды Ярса» — очередь команд от авторизованного
// оператора. Подвкладки:
//   🟢 Готовые к применению (safe=1 pending)
//   🔴 Опасные (safe=0 pending — требуют confirm + reason)
//   📜 Применённые
//   ❌ Отклонённые
//
// Brand-style: glass-card / font-display / font-mono для IDs и hash.

import { useMemo, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Loader2 } from "lucide-react";

type Cmd = {
  id: number;
  senderHashShort: string;
  commandText: string;
  category: string;
  safe: boolean;
  status: string;
  appliedAt: number | null;
  appliedByUserId: number | null;
  rejectionReason: string | null;
  sourceChatSession: string | null;
  createdAt: number;
  expiresAt: number;
};

type Resp = { items: Cmd[]; counts: { status: string; safe: number; cnt: number }[] };

function fmtTime(ms: number | null): string {
  if (!ms) return "—";
  return new Date(ms).toLocaleString("ru-RU", { dateStyle: "short", timeStyle: "short" });
}

function categoryBadge(cat: string): string {
  switch (cat) {
    case "news_post": return "bg-purple-500/15 text-purple-300 border-purple-500/30";
    case "ui_text": return "bg-cyan-500/15 text-cyan-300 border-cyan-500/30";
    case "kb_update": return "bg-emerald-500/15 text-emerald-300 border-emerald-500/30";
    case "persona_tweak": return "bg-fuchsia-500/15 text-fuchsia-300 border-fuchsia-500/30";
    case "delete": return "bg-red-500/15 text-red-300 border-red-500/40";
    case "secret": return "bg-red-500/15 text-red-300 border-red-500/40";
    case "deploy": return "bg-amber-500/15 text-amber-300 border-amber-500/40";
    default: return "bg-white/5 text-white/60 border-white/15";
  }
}

const SUB_TABS = [
  { key: "ready", label: "🟢 Готовые" },
  { key: "danger", label: "🔴 Опасные" },
  { key: "applied", label: "📜 Применённые" },
  { key: "rejected", label: "❌ Отклонённые" },
] as const;

type SubTab = (typeof SUB_TABS)[number]["key"];

function fetchQueue(qs: string): Promise<Resp> {
  return fetch(`/api/admin/v304/operator-commands?${qs}`, { credentials: "include" })
    .then(async (r) => {
      if (!r.ok) throw new Error(`${r.status}`);
      const j = await r.json();
      return j.data as Resp;
    });
}

export default function OperatorCommandsTab({ toast }: { toast: any }) {
  const [sub, setSub] = useState<SubTab>("ready");
  const qc = useQueryClient();

  const status = sub === "applied" ? "applied" : sub === "rejected" ? "rejected" : "pending";
  const qs = `status=${status}&limit=200`;

  const { data, isLoading } = useQuery({
    queryKey: ["/api/admin/v304/operator-commands", status],
    queryFn: () => fetchQueue(qs),
    refetchInterval: 30_000,
  });

  // Pending фильтруем на клиенте по safe.
  const items = useMemo(() => {
    if (!data?.items) return [];
    if (sub === "ready") return data.items.filter((c) => c.safe);
    if (sub === "danger") return data.items.filter((c) => !c.safe);
    return data.items;
  }, [data, sub]);

  const counts = useMemo(() => {
    const m = { ready: 0, danger: 0, applied: 0, rejected: 0 };
    for (const c of data?.counts ?? []) {
      if (c.status === "pending" && c.safe) m.ready += c.cnt;
      else if (c.status === "pending" && !c.safe) m.danger += c.cnt;
      else if (c.status === "applied") m.applied += c.cnt;
      else if (c.status === "rejected") m.rejected += c.cnt;
    }
    return m;
  }, [data]);

  const applyMut = useMutation({
    mutationFn: async (id: number) => {
      const r = await fetch(`/api/admin/v304/operator-commands/${id}/apply`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      const j = await r.json();
      if (!r.ok) throw new Error(j?.error || `HTTP ${r.status}`);
      return j;
    },
    onSuccess: () => {
      toast?.({ title: "Применено", description: "Команда отмечена как применённая" });
      qc.invalidateQueries({ queryKey: ["/api/admin/v304/operator-commands"] });
    },
    onError: (e: any) => toast?.({ title: "Ошибка", description: e?.message || "—", variant: "destructive" }),
  });

  const rejectMut = useMutation({
    mutationFn: async ({ id, reason }: { id: number; reason: string }) => {
      const r = await fetch(`/api/admin/v304/operator-commands/${id}/reject`, {
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
      toast?.({ title: "Отклонено", description: "Команда отклонена" });
      qc.invalidateQueries({ queryKey: ["/api/admin/v304/operator-commands"] });
    },
    onError: (e: any) => toast?.({ title: "Ошибка", description: e?.message || "—", variant: "destructive" }),
  });

  function onApply(c: Cmd) {
    if (c.safe) {
      applyMut.mutate(c.id);
    } else {
      // Double confirm для dangerous команд.
      if (!window.confirm(`⚠ ОПАСНАЯ команда (${c.category}). Применить?\n\n«${c.commandText.slice(0, 200)}»`)) return;
      const second = window.prompt("Повторное подтверждение: введи слово «применяю» для опасной команды:");
      if ((second ?? "").trim().toLowerCase() !== "применяю") {
        toast?.({ title: "Отменено", description: "Не введено подтверждение" });
        return;
      }
      applyMut.mutate(c.id);
    }
  }

  function onReject(c: Cmd) {
    const reason = window.prompt("Причина отклонения:");
    if (!reason || !reason.trim()) return;
    rejectMut.mutate({ id: c.id, reason: reason.trim() });
  }

  return (
    <div className="space-y-4">
      <Card className="glass-card border-purple-500/20">
        <CardHeader>
          <CardTitle className="font-display font-bold gradient-text text-2xl">
            🎙 Команды Ярса
          </CardTitle>
          <p className="text-sm font-sans text-muted-foreground">
            Очередь команд от авторизованного оператора (через Музу). Безопасные — 1 кликом, опасные — двойной confirm.
          </p>
        </CardHeader>
        <CardContent>
          <div className="flex flex-wrap gap-2 mb-4">
            {SUB_TABS.map((s) => {
              const n = counts[s.key];
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
                  {s.label} {n > 0 ? <span className="font-mono text-xs ml-1">({n})</span> : null}
                </button>
              );
            })}
          </div>

          {isLoading && (
            <div className="flex items-center gap-2 text-white/60 py-6 justify-center">
              <Loader2 className="w-4 h-4 animate-spin" /> Загрузка…
            </div>
          )}

          {!isLoading && items.length === 0 && (
            <div className="text-white/50 text-sm py-6 text-center">Очередь пуста</div>
          )}

          <div className="space-y-3">
            {items.map((c) => (
              <div
                key={c.id}
                className={`glass-card rounded-xl p-4 border ${
                  c.safe ? "border-emerald-500/30" : "border-red-500/40"
                }`}
              >
                <div className="flex items-start justify-between gap-3 mb-2">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className={`px-2 py-0.5 rounded-full text-[11px] font-medium border ${categoryBadge(c.category)}`}>
                      {c.category}
                    </span>
                    <span className="text-xs font-mono text-white/40">
                      #{c.id} · hash:{c.senderHashShort}…
                    </span>
                    <span className="text-xs font-mono text-white/40">{fmtTime(c.createdAt)}</span>
                    {c.status === "pending" && c.expiresAt < Date.now() + 3600 * 1000 ? (
                      <span className="text-xs font-mono text-amber-300">⏰ скоро истечёт</span>
                    ) : null}
                  </div>
                  {c.status === "pending" && (
                    <div className="flex gap-2 shrink-0">
                      <button
                        type="button"
                        onClick={() => onApply(c)}
                        disabled={applyMut.isPending}
                        className={`px-3 py-1.5 rounded-lg text-sm font-medium border transition ${
                          c.safe
                            ? "bg-emerald-500/15 border-emerald-500/40 text-emerald-200 hover:bg-emerald-500/25"
                            : "bg-red-500/15 border-red-500/40 text-red-200 hover:bg-red-500/25"
                        }`}
                      >
                        {c.safe ? "✅ Применить" : "⚠ Применить опасное"}
                      </button>
                      <button
                        type="button"
                        onClick={() => onReject(c)}
                        disabled={rejectMut.isPending}
                        className="px-3 py-1.5 rounded-lg text-sm bg-white/5 border border-white/15 text-white/70 hover:bg-white/10"
                      >
                        ❌ Отклонить
                      </button>
                    </div>
                  )}
                </div>
                <div className="text-sm font-sans text-white/90 whitespace-pre-wrap break-words">
                  {c.commandText}
                </div>
                {c.rejectionReason ? (
                  <div className="mt-2 text-xs text-red-300 font-sans">
                    Причина отклонения: {c.rejectionReason}
                  </div>
                ) : null}
                {c.appliedAt && c.status === "applied" ? (
                  <div className="mt-2 text-xs text-emerald-300 font-mono">
                    Применено {fmtTime(c.appliedAt)} админом #{c.appliedByUserId ?? "—"}
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
