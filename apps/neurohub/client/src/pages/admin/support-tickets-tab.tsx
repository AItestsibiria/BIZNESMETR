// Eugene 2026-05-17 Босс «Заведи кнопку техподдержка ... вкладка обращения».
//
// Admin-вкладка «🆘 Обращения» — список support-ticket'ов из agent_handoffs
// с фильтрами status / priority / channel и действиями над ними.

import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Loader2 } from "lucide-react";

type Ticket = {
  id: string;
  status: "open" | "in_progress" | "resolved" | "closed" | string;
  priority: "low" | "normal" | "high" | "urgent" | string;
  channel: string | null;
  subject: string | null;
  reason: string | null;
  sessionId: string;
  userId: number | null;
  user: { name?: string; email?: string } | null;
  assignedTo: number | null;
  createdAt: number;
  updatedAt: number | null;
  resolvedAt: number | null;
};

type TicketsResp = { tickets: Ticket[]; total: number };

function fetchTickets(qs: string): Promise<TicketsResp> {
  return fetch(`/api/admin/v304/support/tickets?${qs}`, { credentials: "include" })
    .then(async (r) => {
      if (!r.ok) throw new Error(`${r.status}`);
      const j = await r.json();
      return j.data as TicketsResp;
    });
}

function changeStatus(id: string, body: any): Promise<any> {
  return fetch(`/api/admin/v304/support/tickets/${encodeURIComponent(id)}/status`, {
    method: "POST",
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  }).then((r) => r.json());
}

function fmtTime(ms: number | null): string {
  if (!ms) return "—";
  const d = new Date(ms);
  return d.toLocaleString("ru-RU", { dateStyle: "short", timeStyle: "short" });
}

const STATUS_OPTS = [
  { key: "active", label: "🟢 Активные" }, // open + in_progress
  { key: "open", label: "Open" },
  { key: "in_progress", label: "In progress" },
  { key: "resolved", label: "Resolved" },
  { key: "closed", label: "Closed" },
  { key: "all", label: "Все" },
];

const PRIO_OPTS = [
  { key: "", label: "Все" },
  { key: "urgent", label: "🚨 Urgent" },
  { key: "high", label: "🔥 High" },
  { key: "normal", label: "Normal" },
  { key: "low", label: "Low" },
];

const CHANNEL_OPTS = [
  { key: "", label: "Все" },
  { key: "web", label: "🌐 Web" },
  { key: "telegram", label: "📱 Telegram" },
  { key: "max", label: "💬 Max" },
];

function statusBadge(s: string): string {
  if (s === "open") return "bg-amber-500/15 text-amber-300 border-amber-500/30";
  if (s === "in_progress") return "bg-cyan-500/15 text-cyan-300 border-cyan-500/30";
  if (s === "resolved") return "bg-emerald-500/15 text-emerald-300 border-emerald-500/30";
  if (s === "closed") return "bg-white/5 text-white/60 border-white/10";
  return "bg-white/5 text-white/70 border-white/10";
}

function prioBadge(p: string): string {
  if (p === "urgent") return "bg-rose-500/20 text-rose-200 border-rose-500/40";
  if (p === "high") return "bg-fuchsia-500/15 text-fuchsia-200 border-fuchsia-500/30";
  if (p === "low") return "bg-white/5 text-white/50 border-white/10";
  return "bg-purple-500/10 text-purple-200 border-purple-500/20";
}

export default function SupportTicketsTab({ toast }: { toast: any }) {
  const [statusFilter, setStatusFilter] = useState<string>("active");
  const [priority, setPriority] = useState<string>("");
  const [channel, setChannel] = useState<string>("");
  const [q, setQ] = useState("");
  const [openId, setOpenId] = useState<string | null>(null);
  const [resolutionNote, setResolutionNote] = useState("");

  // Read ?ticket=xxx from hash to auto-open ticket (Telegram alert deep-link).
  useEffect(() => {
    try {
      const hash = window.location.hash || "";
      const qIdx = hash.indexOf("?");
      if (qIdx >= 0) {
        const params = new URLSearchParams(hash.slice(qIdx + 1));
        const tk = params.get("ticket");
        if (tk) setOpenId(tk);
      }
    } catch {}
  }, []);

  const qs = useMemo(() => {
    const p = new URLSearchParams();
    if (statusFilter && statusFilter !== "all" && statusFilter !== "active") p.set("status", statusFilter);
    if (priority) p.set("priority", priority);
    if (channel) p.set("channel", channel);
    if (q.trim()) p.set("q", q.trim());
    p.set("limit", "100");
    return p.toString();
  }, [statusFilter, priority, channel, q]);

  const { data, isLoading, refetch } = useQuery<TicketsResp>({
    queryKey: ["admin-support-tickets", qs],
    queryFn: () => fetchTickets(qs),
    refetchInterval: 15_000,
  });

  // Frontend-filter 'active' = open + in_progress.
  const tickets = useMemo(() => {
    const all = data?.tickets || [];
    if (statusFilter === "active") {
      return all.filter(t => t.status === "open" || t.status === "in_progress");
    }
    return all;
  }, [data, statusFilter]);

  const onSetStatus = async (id: string, status: string, extra?: any) => {
    try {
      const body = { status, ...(extra || {}) };
      const j = await changeStatus(id, body);
      if (j?.data) {
        toast({ title: "Статус обновлён", description: `Ticket #${id.slice(0, 8)} → ${status}` });
        setResolutionNote("");
        refetch();
      } else {
        toast({ title: "Не получилось", description: j?.error || "—", variant: "destructive" });
      }
    } catch (e: any) {
      toast({ title: "Ошибка", description: e?.message || String(e), variant: "destructive" });
    }
  };

  const onSetPriority = async (id: string, newPriority: string) => {
    try {
      const cur = tickets.find(t => t.id === id);
      const body = { status: cur?.status || "open", priority: newPriority };
      const j = await changeStatus(id, body);
      if (j?.data) {
        toast({ title: "Приоритет обновлён", description: `${newPriority}` });
        refetch();
      }
    } catch (e: any) {
      toast({ title: "Ошибка", description: e?.message || String(e), variant: "destructive" });
    }
  };

  const copyReport = () => {
    const lines = tickets.map(t =>
      `#${t.id.slice(0, 8)} · ${t.status} · ${t.priority} · ${t.channel || "—"} · ${t.user?.name || (t.userId ? `user-${t.userId}` : "anon")} · ${(t.subject || "").slice(0, 60)} · ${fmtTime(t.createdAt)}`
    );
    const text = `🆘 Обращения (${tickets.length})\n${lines.join("\n")}`;
    navigator.clipboard.writeText(text).then(() => {
      const btn = document.getElementById("support-copy-report");
      if (btn) {
        const orig = btn.textContent || "📋 Копировать";
        btn.textContent = "✅ Скопировано";
        setTimeout(() => { btn.textContent = orig; }, 1500);
      }
    }).catch(() => {});
  };

  const opened = openId ? tickets.find(t => t.id === openId) : null;

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-3 flex-wrap">
            <span>🆘 Обращения в техподдержку</span>
            <span className="text-xs text-muted-foreground font-normal">
              всего: <b>{tickets.length}</b>
              <> · polling 15s</>
            </span>
            <button
              id="support-copy-report"
              onClick={copyReport}
              className="ml-auto text-xs px-3 py-1.5 rounded-md bg-white/5 border border-purple-400/20 hover:bg-purple-500/20 text-purple-200"
            >
              📋 Копировать
            </button>
          </CardTitle>
          <p className="text-xs text-muted-foreground mt-1">
            Ticket'ы из agent_handoffs (reason='support_button' или с subject/channel).
            Клик по строке — детали + изменение статуса.
          </p>
        </CardHeader>
        <CardContent>
          {/* Filters */}
          <div className="flex flex-wrap items-center gap-2 mb-4">
            <div className="flex flex-wrap items-center gap-1">
              {STATUS_OPTS.map(o => (
                <button
                  key={o.key}
                  onClick={() => setStatusFilter(o.key)}
                  className={`text-xs px-3 py-1 rounded-md transition-colors ${statusFilter === o.key ? "bg-emerald-600/40 text-white border border-emerald-500/40" : "bg-white/5 hover:bg-white/10"}`}
                >{o.label}</button>
              ))}
            </div>
            <div className="flex flex-wrap items-center gap-1 sm:ml-2">
              <span className="text-xs text-white/40">Приоритет:</span>
              {PRIO_OPTS.map(o => (
                <button
                  key={o.key || "any"}
                  onClick={() => setPriority(o.key)}
                  className={`text-xs px-2 py-1 rounded-md ${priority === o.key ? "bg-fuchsia-500/30 text-white border border-fuchsia-400/30" : "bg-white/5 hover:bg-white/10"}`}
                >{o.label}</button>
              ))}
            </div>
            <div className="flex flex-wrap items-center gap-1 sm:ml-2">
              <span className="text-xs text-white/40">Канал:</span>
              {CHANNEL_OPTS.map(o => (
                <button
                  key={o.key || "any"}
                  onClick={() => setChannel(o.key)}
                  className={`text-xs px-2 py-1 rounded-md ${channel === o.key ? "bg-cyan-500/25 text-white border border-cyan-400/30" : "bg-white/5 hover:bg-white/10"}`}
                >{o.label}</button>
              ))}
            </div>
            <input
              value={q}
              onChange={e => setQ(e.target.value)}
              placeholder="по теме / id…"
              className="text-xs h-8 px-3 rounded-md bg-white/5 border border-white/10 text-white placeholder:text-white/30 max-w-[200px]"
            />
          </div>

          {/* Tickets table */}
          {isLoading ? (
            <div className="flex items-center gap-2 text-white/50 text-sm py-8">
              <Loader2 className="w-4 h-4 animate-spin" />
              <span>Загружаю…</span>
            </div>
          ) : tickets.length === 0 ? (
            <div className="text-center py-8 text-white/40 text-sm">Обращений не найдено</div>
          ) : (
            <div className="space-y-2">
              {tickets.map(t => (
                <div
                  key={t.id}
                  className={`p-3 rounded-xl border bg-white/[0.02] hover:bg-white/[0.04] transition-colors cursor-pointer ${openId === t.id ? "border-purple-400/50" : "border-white/10"}`}
                  onClick={() => setOpenId(openId === t.id ? null : t.id)}
                >
                  <div className="flex items-center gap-2 flex-wrap text-sm">
                    <span className="font-mono text-xs text-purple-300">#{t.id.slice(0, 8)}</span>
                    <span className={`text-[10px] px-2 py-0.5 rounded-full border ${statusBadge(t.status)}`}>
                      {t.status}
                    </span>
                    <span className={`text-[10px] px-2 py-0.5 rounded-full border ${prioBadge(t.priority)}`}>
                      {t.priority}
                    </span>
                    {t.channel ? (
                      <span className="text-[10px] px-2 py-0.5 rounded-full bg-white/5 text-white/60 border border-white/10">
                        {t.channel}
                      </span>
                    ) : null}
                    <span className="text-white/80 flex-1 min-w-0 truncate">
                      {t.subject || "Без темы"}
                    </span>
                    <span className="text-[11px] text-white/40 font-mono">{fmtTime(t.createdAt)}</span>
                  </div>
                  <div className="mt-1 text-xs text-white/50 flex items-center gap-2">
                    <span>
                      {t.user?.name || (t.userId ? `user-${t.userId}` : "анонимный")}
                      {t.user?.email ? ` · ${t.user.email}` : ""}
                    </span>
                  </div>

                  {openId === t.id ? (
                    <div className="mt-3 pt-3 border-t border-white/10 space-y-2" onClick={(e) => e.stopPropagation()}>
                      <div className="text-xs text-white/60 font-mono break-all">
                        sessionId: {t.sessionId}
                      </div>
                      <div className="flex flex-wrap gap-2">
                        <a
                          href={`#/admin/v304?conversation=${encodeURIComponent(t.sessionId)}`}
                          className="text-xs px-3 py-1 rounded-md bg-cyan-500/15 text-cyan-200 border border-cyan-400/30 hover:bg-cyan-500/25"
                          onClick={(e) => e.stopPropagation()}
                        >
                          💬 Открыть диалог
                        </a>
                        {t.status !== "in_progress" ? (
                          <button
                            onClick={() => onSetStatus(t.id, "in_progress")}
                            className="text-xs px-3 py-1 rounded-md bg-cyan-500/15 text-cyan-200 border border-cyan-400/30 hover:bg-cyan-500/25"
                          >
                            ▶ В работу
                          </button>
                        ) : null}
                        {t.status !== "resolved" ? (
                          <button
                            onClick={() => onSetStatus(t.id, "resolved", { resolutionNote: resolutionNote || undefined })}
                            className="btn-cosmic text-xs px-3 py-1 rounded-md"
                          >
                            ✅ Решено
                          </button>
                        ) : null}
                        {t.status !== "closed" ? (
                          <button
                            onClick={() => onSetStatus(t.id, "closed")}
                            className="text-xs px-3 py-1 rounded-md bg-white/5 text-white/70 border border-white/10 hover:bg-white/10"
                          >
                            🗄 Закрыть
                          </button>
                        ) : null}
                      </div>
                      <div className="flex items-center gap-2">
                        <span className="text-[10px] text-white/40">приоритет:</span>
                        {["urgent","high","normal","low"].map(p => (
                          <button
                            key={p}
                            onClick={() => onSetPriority(t.id, p)}
                            className={`text-[10px] px-2 py-0.5 rounded-full border ${t.priority === p ? prioBadge(p) : "bg-white/5 text-white/50 border-white/10 hover:bg-white/10"}`}
                          >{p}</button>
                        ))}
                      </div>
                      <textarea
                        value={resolutionNote}
                        onChange={e => setResolutionNote(e.target.value)}
                        placeholder="Резюме решения (отправится юзеру в чат при «✅ Решено»)…"
                        className="w-full text-xs h-16 p-2 rounded-md bg-white/[0.03] border border-white/10 text-white placeholder:text-white/30 resize-none"
                      />
                      <div className="text-[10px] text-white/30 font-mono">
                        обновлено: {fmtTime(t.updatedAt)}
                        {t.resolvedAt ? ` · решено: ${fmtTime(t.resolvedAt)}` : ""}
                      </div>
                    </div>
                  ) : null}
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
