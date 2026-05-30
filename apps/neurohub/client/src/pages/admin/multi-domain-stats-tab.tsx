// v304 multi-domain-stats tab (Eugene 2026-05-21 Босс «фикс который собирает
// статистику по отдельному домену + сводная по всем доменам»).
//
// Источник: GET /api/admin/v304/aggregated-stats (admin only, cache 5 мин).
// Локальный domain + все peers из ENV MULTI_DOMAIN_PEERS.
//
// Brand-style: glass-card + cyber-grid фон + status pills (🟢/🔴) per peer.
// Mobile-friendly: table → grid of cards на узких экранах.

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { apiRequest } from "@/lib/queryClient";
import { Loader2 } from "lucide-react";

type PeerStatus = "ok" | "timeout" | "error" | "auth_failed" | "invalid_response";

interface LocalStatsPayload {
  meta: { hostname: string; timestamp: string; dbSizeMb: number; publicUrl: string | null };
  users: { total: number; admins: number; new7d: number; new24h: number };
  visits: { uniqueFingerprints: number; totalVisits: number; countries: number };
  generations: { total: number; music: number; musicDone: number; publicMain: number; deleted: number };
  plays: { byAction: Array<{ action: string; count: number }>; metaPlaysSum: number; tracksWithMeta: number };
  payments: { total: number; paid: number; paidRubTotal: number };
  chatbot: { messages: number; sessions: number };
}

interface PeerRow {
  url: string;
  domain: string;
  reachable: boolean;
  status: PeerStatus;
  errorMessage?: string;
  fetchedAt: string;
  stats: LocalStatsPayload | null;
}

interface AggregatedResponse {
  data: {
    generatedAt: string;
    localDomain: string;
    peerCount: number;
    reachableCount: number;
    peers: PeerRow[];
    totals: {
      users: number;
      admins: number;
      new7d: number;
      new24h: number;
      visitsUnique: number;
      visitsTotal: number;
      generations: number;
      musicDone: number;
      plays: number;
      payments: number;
      paidRubTotal: number;
      chatbotMessages: number;
    };
  } | null;
  error: string | null;
}

interface LocalResponse {
  data: LocalStatsPayload | null;
  error: string | null;
}

function num(v: number | null | undefined): string {
  if (v == null || !Number.isFinite(v)) return "—";
  if (Math.abs(v) >= 1_000_000) return `${(v / 1_000_000).toFixed(1)}M`;
  if (Math.abs(v) >= 1_000) return `${(v / 1_000).toFixed(1)}K`;
  return String(v);
}

function rub(v: number | null | undefined): string {
  if (v == null || !Number.isFinite(v)) return "—";
  return `${Math.round(v).toLocaleString("ru-RU")} ₽`;
}

function statusDot(reachable: boolean, status: PeerStatus): { label: string; color: string } {
  if (reachable && status === "ok") return { label: "🟢 онлайн", color: "text-emerald-300" };
  if (status === "timeout") return { label: "🟡 timeout", color: "text-amber-300" };
  if (status === "auth_failed") return { label: "🔴 auth", color: "text-rose-300" };
  if (status === "invalid_response") return { label: "🟠 формат", color: "text-orange-300" };
  return { label: "🔴 offline", color: "text-rose-400" };
}

function buildLocalRow(local: LocalStatsPayload, isLocal: boolean): {
  domain: string;
  users: number;
  visits: number;
  gens: number;
  plays: number;
  payments: number;
  rub: number;
  isLocal: boolean;
  reachable: boolean;
  status: PeerStatus;
  errorMessage?: string;
  fetchedAt: string;
} {
  const playRow = local.plays.byAction.find((a) => a.action === "play");
  return {
    domain: local.meta.publicUrl
      ? new URL(local.meta.publicUrl.startsWith("http") ? local.meta.publicUrl : `https://${local.meta.publicUrl}`).host
      : local.meta.hostname,
    users: local.users.total,
    visits: local.visits.uniqueFingerprints,
    gens: local.generations.musicDone,
    plays: playRow?.count ?? 0,
    payments: local.payments.paid,
    rub: local.payments.paidRubTotal,
    isLocal,
    reachable: true,
    status: "ok" as PeerStatus,
    fetchedAt: local.meta.timestamp,
  };
}

function copyToClipboard(text: string): void {
  try {
    navigator.clipboard.writeText(text);
  } catch {}
}

export default function MultiDomainStatsTab() {
  const [refreshTick, setRefreshTick] = useState(0);

  const { data: localResp, isLoading: loadingLocal, refetch: refetchLocal } = useQuery<LocalResponse>({
    queryKey: ["/api/admin/v304/local-stats", refreshTick],
    queryFn: async () => {
      const r = await apiRequest("GET", `/api/admin/v304/local-stats`);
      return r.json();
    },
    refetchInterval: 60_000,
  });

  const { data: aggResp, isLoading: loadingAgg, refetch: refetchAgg, isError, error } = useQuery<AggregatedResponse>({
    queryKey: ["/api/admin/v304/aggregated-stats", refreshTick],
    queryFn: async () => {
      const r = await apiRequest("GET", `/api/admin/v304/aggregated-stats`);
      return r.json();
    },
    refetchInterval: 5 * 60_000,
  });

  const local = localResp?.data ?? null;
  const agg = aggResp?.data ?? null;

  const rows: Array<{
    domain: string;
    users: number;
    visits: number;
    gens: number;
    plays: number;
    payments: number;
    rub: number;
    isLocal: boolean;
    reachable: boolean;
    status: PeerStatus;
    errorMessage?: string;
    fetchedAt: string;
  }> = [];

  if (local) {
    rows.push(buildLocalRow(local, true));
  }
  if (agg?.peers) {
    for (const p of agg.peers) {
      if (p.reachable && p.stats) {
        rows.push({ ...buildLocalRow(p.stats, false), domain: p.domain, reachable: true, status: p.status, fetchedAt: p.fetchedAt });
      } else {
        rows.push({
          domain: p.domain,
          users: 0,
          visits: 0,
          gens: 0,
          plays: 0,
          payments: 0,
          rub: 0,
          isLocal: false,
          reachable: false,
          status: p.status,
          errorMessage: p.errorMessage,
          fetchedAt: p.fetchedAt,
        });
      }
    }
  }

  const totals = agg?.totals;
  const peersConfigured = agg?.peerCount ?? 0;
  const reachableCount = agg?.reachableCount ?? 0;

  const onRefresh = () => {
    setRefreshTick((t) => t + 1);
    refetchLocal();
    refetchAgg();
  };

  return (
    <div className="space-y-4 relative cyber-grid">
      {/* Header */}
      <Card className="glass-card border-purple-500/30">
        <CardContent className="p-4 sm:p-6">
          <div className="flex flex-col sm:flex-row sm:items-start sm:justify-between gap-3">
            <div>
              <h2 className="text-xl sm:text-2xl font-display font-bold gradient-text mb-1">
                🌐 Все домены
              </h2>
              <p className="text-sm text-muted-foreground">
                Per-domain статистика + сводка по всем instance'ам MuzaAi.
              </p>
              <div className="mt-2 flex flex-wrap items-center gap-2 text-xs font-mono">
                <span className="px-2 py-0.5 rounded-full bg-purple-500/20 text-purple-200">
                  локальный: {local?.meta.publicUrl ?? local?.meta.hostname ?? "—"}
                </span>
                <span className="px-2 py-0.5 rounded-full bg-cyan-500/20 text-cyan-200">
                  peers: {reachableCount}/{peersConfigured}
                </span>
                {agg?.generatedAt && (
                  <span className="px-2 py-0.5 rounded-full bg-white/5 text-white/60">
                    обновлено: {new Date(agg.generatedAt).toLocaleTimeString("ru-RU")}
                  </span>
                )}
              </div>
            </div>
            <div className="flex gap-2">
              <Button
                onClick={onRefresh}
                disabled={loadingLocal || loadingAgg}
                className="bg-gradient-to-r from-purple-500 via-fuchsia-500 to-blue-500 text-white shadow-[0_0_24px_rgba(124,58,237,0.4)]"
                data-testid="multi-domain-refresh"
              >
                {(loadingLocal || loadingAgg) ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : null}
                Обновить
              </Button>
              <Button
                variant="outline"
                className="border-fuchsia-400/40 bg-fuchsia-500/15 text-fuchsia-200 hover:bg-fuchsia-500/25"
                onClick={() => {
                  const lines: string[] = [];
                  lines.push(`🌐 Все домены — отчёт`);
                  lines.push(`🕐 ${new Date().toLocaleString("ru-RU")}`);
                  lines.push(`Peers: ${reachableCount}/${peersConfigured} доступны`);
                  lines.push("");
                  if (totals) {
                    lines.push(`ИТОГО: юзеров ${num(totals.users)} · визитов ${num(totals.visitsUnique)} · треков ${num(totals.musicDone)} · плеев ${num(totals.plays)} · оплат ${num(totals.payments)} · выручка ${rub(totals.paidRubTotal)}`);
                    lines.push("");
                  }
                  lines.push(`Per-domain (${rows.length}):`);
                  for (const r of rows) {
                    if (r.reachable) {
                      lines.push(`  ${r.domain}${r.isLocal ? " (local)" : ""} · юзеры ${num(r.users)} · визиты ${num(r.visits)} · треки ${num(r.gens)} · плеи ${num(r.plays)} · оплаты ${num(r.payments)} · выручка ${rub(r.rub)} · статус ${r.status}`);
                    } else {
                      lines.push(`  ${r.domain} · 🔴 НЕДОСТУПЕН · статус ${r.status}${r.errorMessage ? ` · ${r.errorMessage}` : ""}`);
                    }
                  }
                  copyToClipboard(lines.join("\n"));
                }}
                data-testid="multi-domain-copy"
              >
                📋 Скопировать ВСЕ
              </Button>
              <Button
                variant="outline"
                className="border-purple-400/40 hover:bg-purple-500/20"
                onClick={() => copyToClipboard(JSON.stringify(agg ?? local ?? {}, null, 2))}
                data-testid="multi-domain-copy-json"
              >
                📋 JSON
              </Button>
            </div>
          </div>
          {peersConfigured === 0 && (
            <div className="mt-3 p-3 rounded-lg border border-amber-500/30 bg-amber-500/10 text-xs sm:text-sm text-amber-200">
              ⚠️ MULTI_DOMAIN_PEERS не настроен — отображаются только локальные данные. Запусти{" "}
              <code className="font-mono text-amber-300">bash deploy/setup-multi-domain.sh</code> для получения команд установки на каждый VPS.
            </div>
          )}
          {isError && (
            <div className="mt-3 p-3 rounded-lg border border-rose-500/30 bg-rose-500/10 text-xs text-rose-200">
              Ошибка: {(error as any)?.message ?? "не удалось загрузить aggregated-stats"}
            </div>
          )}
        </CardContent>
      </Card>

      {/* TOTAL summary cards */}
      {totals && (
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-2 sm:gap-3">
          <SummaryCard label="Юзеры" value={num(totals.users)} accent="purple" />
          <SummaryCard label="Визиты (unique)" value={num(totals.visitsUnique)} accent="cyan" />
          <SummaryCard label="Треки готовы" value={num(totals.musicDone)} accent="emerald" />
          <SummaryCard label="Плеи" value={num(totals.plays)} accent="amber" />
          <SummaryCard label="Оплат" value={num(totals.payments)} accent="fuchsia" />
          <SummaryCard label="Выручка" value={rub(totals.paidRubTotal)} accent="violet" />
        </div>
      )}

      {/* Per-domain table */}
      <Card className="glass-card border-purple-500/30">
        <CardContent className="p-3 sm:p-4">
          <h3 className="text-sm sm:text-base font-sans font-bold text-white mb-3">
            Per-domain breakdown
          </h3>
          {loadingLocal && loadingAgg && rows.length === 0 ? (
            <div className="flex items-center gap-2 text-white/60 text-sm">
              <Loader2 className="h-4 w-4 animate-spin" />
              Загрузка...
            </div>
          ) : (
            <div className="overflow-x-auto -mx-3 sm:mx-0">
              <table className="w-full text-xs sm:text-sm" data-testid="multi-domain-table">
                <thead>
                  <tr className="text-left text-white/60 border-b border-white/10">
                    <th className="py-2 px-2 sm:px-3 font-medium">Домен</th>
                    <th className="py-2 px-2 sm:px-3 font-medium text-right">Юзеры</th>
                    <th className="py-2 px-2 sm:px-3 font-medium text-right">Визиты</th>
                    <th className="py-2 px-2 sm:px-3 font-medium text-right">Треки</th>
                    <th className="py-2 px-2 sm:px-3 font-medium text-right">Плеи</th>
                    <th className="py-2 px-2 sm:px-3 font-medium text-right">Оплат</th>
                    <th className="py-2 px-2 sm:px-3 font-medium text-right">Выручка</th>
                    <th className="py-2 px-2 sm:px-3 font-medium">Статус</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r, i) => {
                    const dot = statusDot(r.reachable, r.status);
                    return (
                      <tr
                        key={`${r.domain}-${i}`}
                        className={`border-b border-white/5 hover:bg-white/5 ${r.isLocal ? "bg-purple-500/10" : ""}`}
                        data-testid={`multi-domain-row-${r.domain}`}
                      >
                        <td className="py-2 px-2 sm:px-3 font-mono">
                          {r.isLocal && <span className="mr-1 text-purple-300">●</span>}
                          {r.domain}
                          {r.isLocal && <span className="ml-1 text-[10px] text-purple-300">(local)</span>}
                        </td>
                        <td className="py-2 px-2 sm:px-3 text-right font-mono">{r.reachable ? num(r.users) : "—"}</td>
                        <td className="py-2 px-2 sm:px-3 text-right font-mono">{r.reachable ? num(r.visits) : "—"}</td>
                        <td className="py-2 px-2 sm:px-3 text-right font-mono">{r.reachable ? num(r.gens) : "—"}</td>
                        <td className="py-2 px-2 sm:px-3 text-right font-mono">{r.reachable ? num(r.plays) : "—"}</td>
                        <td className="py-2 px-2 sm:px-3 text-right font-mono">{r.reachable ? num(r.payments) : "—"}</td>
                        <td className="py-2 px-2 sm:px-3 text-right font-mono">{r.reachable ? rub(r.rub) : "—"}</td>
                        <td className={`py-2 px-2 sm:px-3 ${dot.color}`}>
                          <span title={r.errorMessage}>{dot.label}</span>
                        </td>
                      </tr>
                    );
                  })}
                  {/* TOTAL row */}
                  {totals && (
                    <tr className="border-t-2 border-purple-500/30 bg-gradient-to-r from-purple-500/10 via-fuchsia-500/10 to-blue-500/10 font-bold">
                      <td className="py-2 px-2 sm:px-3 font-mono text-purple-200">TOTAL</td>
                      <td className="py-2 px-2 sm:px-3 text-right font-mono text-white">{num(totals.users)}</td>
                      <td className="py-2 px-2 sm:px-3 text-right font-mono text-white">{num(totals.visitsUnique)}</td>
                      <td className="py-2 px-2 sm:px-3 text-right font-mono text-white">{num(totals.musicDone)}</td>
                      <td className="py-2 px-2 sm:px-3 text-right font-mono text-white">{num(totals.plays)}</td>
                      <td className="py-2 px-2 sm:px-3 text-right font-mono text-white">{num(totals.payments)}</td>
                      <td className="py-2 px-2 sm:px-3 text-right font-mono text-white">{rub(totals.paidRubTotal)}</td>
                      <td className="py-2 px-2 sm:px-3 text-purple-200">{reachableCount + 1}/{peersConfigured + 1} ok</td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          )}

          {/* Errors per peer */}
          {rows.some((r) => !r.reachable && r.errorMessage) && (
            <div className="mt-3 space-y-1">
              <h4 className="text-xs text-white/60 mb-1">Недоступные peers:</h4>
              {rows
                .filter((r) => !r.reachable && r.errorMessage)
                .map((r, i) => (
                  <div key={`err-${i}`} className="text-xs font-mono text-rose-300/80 px-2">
                    <span className="text-rose-200">{r.domain}</span>: {r.errorMessage}
                  </div>
                ))}
            </div>
          )}
        </CardContent>
      </Card>

      {/* Setup instructions */}
      <Card className="glass-card border-amber-500/30">
        <CardContent className="p-3 sm:p-4 text-xs sm:text-sm">
          <h3 className="text-sm font-sans font-bold text-amber-200 mb-2">⚙️ Setup на каждом VPS</h3>
          <ol className="list-decimal list-inside space-y-1 text-white/70">
            <li>На локальной машине: <code className="font-mono text-amber-300">bash deploy/setup-multi-domain.sh</code></li>
            <li>Скрипт генерирует <code className="font-mono">MULTI_DOMAIN_SHARED_TOKEN</code> + печатает ssh-команды</li>
            <li>Выполнить ssh-команду на каждом VPS (muzaai / clone / podaripesnu)</li>
            <li>После <code className="font-mono">pm2 restart neurohub --update-env</code> — обновить эту вкладку</li>
          </ol>
        </CardContent>
      </Card>
    </div>
  );
}

function SummaryCard({
  label,
  value,
  accent,
}: {
  label: string;
  value: string;
  accent: "purple" | "cyan" | "emerald" | "amber" | "fuchsia" | "violet";
}) {
  const colorMap: Record<string, string> = {
    purple: "border-purple-500/40 bg-purple-500/10",
    cyan: "border-cyan-500/40 bg-cyan-500/10",
    emerald: "border-emerald-500/40 bg-emerald-500/10",
    amber: "border-amber-500/40 bg-amber-500/10",
    fuchsia: "border-fuchsia-500/40 bg-fuchsia-500/10",
    violet: "border-violet-500/40 bg-violet-500/10",
  };
  return (
    <div className={`glass-card rounded-xl p-3 border ${colorMap[accent]}`}>
      <div className="text-[10px] sm:text-xs text-white/60 mb-1">{label}</div>
      <div className="text-lg sm:text-2xl font-display font-bold text-white">{value}</div>
    </div>
  );
}
