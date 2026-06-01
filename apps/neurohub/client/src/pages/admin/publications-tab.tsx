// Eugene 2026-05-25 Босс «Музa Директор — блок публикаций по датам со статусом:
// подготовлено → одобрено → опубликовано / снято с публикации. Реальная
// отправка только после одобрения. Готовить рекламные кампании на постоянной
// основе».
//
// Источники (все requireAdmin):
//   GET  /api/admin/v304/director/publications?status=&from=&to=
//   POST /api/admin/v304/director/publications/:id/approve
//   POST /api/admin/v304/director/publications/:id/publish
//   POST /api/admin/v304/director/publications/:id/unpublish
//   POST /api/admin/v304/director/publications/generate-now
//
// Admin-tabs-groups rule: группа musa (🎵). Brand-style consistency rule:
// glass-card, brand palette, font-display title, font-mono для дат/id.

import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";

type StatusFilter = "all" | "prepared" | "approved" | "published" | "unpublished";

interface Publication {
  id: number;
  campaign_id: string | null;
  channel: string;
  title: string;
  content: string;
  scheduled_at: number | null;
  status: string;
  created_at: number | null;
  approved_at: number | null;
  published_at: number | null;
  notes: string | null;
}

interface PublicationsResponse {
  items: Publication[];
  grouped: Array<{ date: string; items: Publication[] }>;
  counts: Record<string, number>;
  total: number;
}

const STATUS_FILTERS: StatusFilter[] = ["all", "prepared", "approved", "published", "unpublished"];
const STATUS_FILTER_LABELS: Record<StatusFilter, string> = {
  all: "Все",
  prepared: "Подготовлено",
  approved: "Одобрено",
  published: "Опубликовано",
  unpublished: "Снято",
};

const STATUS_LABEL: Record<string, string> = {
  prepared: "подготовлено",
  approved: "одобрено",
  published: "опубликовано",
  unpublished: "снято",
};

// Status badge palette (по ТЗ): prepared=amber, approved=cyan, published=emerald, unpublished=zinc.
const STATUS_BADGE: Record<string, string> = {
  prepared: "bg-amber-500/20 text-amber-300 border-amber-500/40",
  approved: "bg-cyan-500/20 text-cyan-300 border-cyan-500/40",
  published: "bg-emerald-500/20 text-emerald-300 border-emerald-500/40",
  unpublished: "bg-zinc-500/20 text-zinc-300 border-zinc-500/40",
};

const CHANNEL_LABEL: Record<string, string> = {
  web: "Сайт",
  telegram: "Telegram",
  max: "Max",
  vk: "ВКонтакте",
  email: "Email",
};

function fetcher<T>(url: string, init?: RequestInit): Promise<T> {
  return fetch(url, { credentials: "include", ...init }).then(async (r) => {
    if (!r.ok) {
      const txt = await r.text();
      throw new Error(`${r.status}: ${txt.slice(0, 200)}`);
    }
    const j = await r.json();
    if (j.error) throw new Error(j.error);
    return (j.data ?? j) as T;
  });
}

function fmtDateTime(ms: number | null): string {
  if (!ms) return "—";
  try {
    return new Date(ms).toLocaleString("ru-RU", { dateStyle: "short", timeStyle: "short" });
  } catch {
    return "—";
  }
}

function fmtDateHeader(key: string): string {
  if (!key || key === "Без даты") return "Без даты";
  try {
    const d = new Date(`${key}T00:00:00`);
    return d.toLocaleDateString("ru-RU", { day: "numeric", month: "long", year: "numeric", weekday: "short" });
  } catch {
    return key;
  }
}

function StatusBadge({ status }: { status: string }) {
  const cls = STATUS_BADGE[status] || "bg-zinc-500/20 text-zinc-300 border-zinc-500/40";
  return (
    <span className={`text-[10px] font-sans font-medium px-2 py-0.5 rounded-full border ${cls}`}>
      {STATUS_LABEL[status] || status}
    </span>
  );
}

function ChannelChip({ channel }: { channel: string }) {
  return (
    <span className="text-[10px] font-sans font-medium px-2 py-0.5 rounded-full bg-purple-500/20 text-purple-300 border border-purple-500/40">
      {CHANNEL_LABEL[channel] || channel}
    </span>
  );
}

function PublicationCard({
  pub,
  onApprove,
  onPublish,
  onUnpublish,
  busy,
}: {
  pub: Publication;
  onApprove: (id: number) => void;
  onPublish: (id: number) => void;
  onUnpublish: (id: number) => void;
  busy: boolean;
}) {
  return (
    <div className="rounded-xl border border-fuchsia-500/20 bg-white/5 p-4">
      <div className="flex items-start gap-2 flex-wrap mb-2">
        <ChannelChip channel={pub.channel} />
        <StatusBadge status={pub.status} />
        <span className="text-[10px] font-mono text-muted-foreground">#{pub.id}</span>
        {pub.campaign_id && (
          <span className="text-[10px] font-mono text-muted-foreground">· {pub.campaign_id}</span>
        )}
        <span className="text-[10px] font-mono text-muted-foreground ml-auto">
          🗓 {fmtDateTime(pub.scheduled_at)}
        </span>
      </div>
      <h4 className="text-sm font-sans font-bold text-white mb-1">{pub.title}</h4>
      <p className="text-sm font-sans text-muted-foreground leading-relaxed whitespace-pre-wrap">{pub.content}</p>
      {pub.notes && <p className="text-[11px] font-sans text-muted-foreground/70 mt-2 italic">{pub.notes}</p>}
      <div className="flex items-center gap-2 flex-wrap mt-3">
        {pub.status === "prepared" && (
          <Button
            size="sm"
            disabled={busy}
            onClick={() => onApprove(pub.id)}
            className="bg-gradient-to-r from-cyan-500/70 to-blue-500/70 hover:from-cyan-500 hover:to-blue-500 text-white"
          >
            ✓ Одобрить
          </Button>
        )}
        {pub.status === "approved" && (
          <Button
            size="sm"
            disabled={busy}
            onClick={() => onPublish(pub.id)}
            className="bg-gradient-to-r from-emerald-500/70 to-green-500/70 hover:from-emerald-500 hover:to-green-500 text-white"
          >
            🚀 Опубликовать
          </Button>
        )}
        {pub.status !== "unpublished" && (
          <Button
            size="sm"
            variant="outline"
            disabled={busy}
            onClick={() => onUnpublish(pub.id)}
            className="bg-white/5 border-zinc-400/30 text-zinc-300 hover:bg-zinc-500/20"
          >
            Снять
          </Button>
        )}
      </div>
    </div>
  );
}

export default function PublicationsTab() {
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("all");
  const qc = useQueryClient();

  const q = useQuery({
    queryKey: ["director-publications", statusFilter],
    queryFn: () =>
      fetcher<PublicationsResponse>(
        `/api/admin/v304/director/publications${statusFilter !== "all" ? `?status=${statusFilter}` : ""}`,
      ),
    refetchInterval: 60_000,
    refetchOnWindowFocus: false,
  });

  const invalidate = () => qc.invalidateQueries({ queryKey: ["director-publications"] });

  const approveMut = useMutation({
    mutationFn: (id: number) =>
      fetcher(`/api/admin/v304/director/publications/${id}/approve`, { method: "POST" }),
    onSuccess: invalidate,
  });
  const publishMut = useMutation({
    mutationFn: (id: number) =>
      fetcher(`/api/admin/v304/director/publications/${id}/publish`, { method: "POST" }),
    onSuccess: invalidate,
  });
  const unpublishMut = useMutation({
    mutationFn: (id: number) =>
      fetcher(`/api/admin/v304/director/publications/${id}/unpublish`, { method: "POST" }),
    onSuccess: invalidate,
  });
  const generateMut = useMutation({
    mutationFn: () =>
      fetcher(`/api/admin/v304/director/publications/generate-now`, { method: "POST" }),
    onSuccess: invalidate,
  });

  const busy =
    approveMut.isPending || publishMut.isPending || unpublishMut.isPending || generateMut.isPending;
  const counts = q.data?.counts || {};

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="glass-card rounded-2xl p-6 border border-fuchsia-500/30">
        <div className="flex items-start gap-3 flex-wrap">
          <div className="flex-1 min-w-[200px]">
            <h2 className="text-xl sm:text-2xl font-display font-bold gradient-text mb-1">🎵 Публикации</h2>
            <p className="text-sm font-sans text-muted-foreground leading-relaxed">
              Музa Директор готовит рекламный креатив и складывает в очередь публикаций по датам.
              Реальная отправка — только после «Одобрить». Ничего не публикуется автоматически.
            </p>
          </div>
          <Button
            disabled={busy}
            onClick={() => generateMut.mutate()}
            className="bg-gradient-to-r from-purple-500 via-fuchsia-500 to-pink-500 hover:opacity-90 text-white"
          >
            {generateMut.isPending ? "Готовлю…" : "✨ Подготовить черновики сейчас"}
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={() => q.refetch()}
            disabled={q.isFetching}
            className="bg-white/5 border-fuchsia-400/30 text-fuchsia-300 hover:bg-fuchsia-500/20"
          >
            🔄 Обновить
          </Button>
        </div>
      </div>

      {/* Status filter chips */}
      <div className="flex items-center gap-2 flex-wrap">
        {STATUS_FILTERS.map((s) => (
          <button
            key={s}
            onClick={() => setStatusFilter(s)}
            className={`text-xs font-sans px-3 py-1.5 rounded-full border transition-colors ${
              statusFilter === s
                ? "bg-gradient-to-r from-purple-500/40 to-fuchsia-500/40 text-white border-fuchsia-400/50"
                : "bg-white/5 text-muted-foreground border-white/10 hover:bg-white/10"
            }`}
          >
            {STATUS_FILTER_LABELS[s]}
            {s !== "all" && counts[s] != null && <span className="ml-1 font-mono opacity-70">{counts[s]}</span>}
          </button>
        ))}
      </div>

      {/* Body */}
      <Card className="glass-card border border-fuchsia-500/30">
        <CardContent className="p-4 sm:p-6 space-y-6">
          {q.isLoading && <p className="text-sm font-sans text-muted-foreground">Загрузка…</p>}
          {q.isError && (
            <p className="text-sm font-sans text-red-400">Ошибка: {(q.error as Error)?.message}</p>
          )}
          {q.data && q.data.total === 0 && (
            <p className="text-sm font-sans text-muted-foreground">
              Публикаций нет. Нажми «Подготовить черновики сейчас».
            </p>
          )}
          {q.data?.grouped.map((group) => (
            <div key={group.date}>
              <h3 className="text-sm font-sans font-bold text-fuchsia-300 mb-3 border-b border-fuchsia-500/20 pb-2">
                🗓 {fmtDateHeader(group.date)}
                <span className="ml-2 text-[11px] font-mono text-muted-foreground">({group.items.length})</span>
              </h3>
              <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
                {group.items.map((pub) => (
                  <PublicationCard
                    key={pub.id}
                    pub={pub}
                    busy={busy}
                    onApprove={(id) => approveMut.mutate(id)}
                    onPublish={(id) => publishMut.mutate(id)}
                    onUnpublish={(id) => unpublishMut.mutate(id)}
                  />
                ))}
              </div>
            </div>
          ))}
        </CardContent>
      </Card>
    </div>
  );
}
