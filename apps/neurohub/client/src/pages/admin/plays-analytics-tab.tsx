// v304 admin tab: «📊 Прослушивания» (Eugene 2026-05-21 Босс «админ-
// аналитика счётчика прослушиваний с разбивкой по периодам 1ч/24ч/7д/30д/
// всё время»).
//
// Что показывает:
//  1) Period selector pills: 1ч / 24ч / 7д / 30д / всё
//  2) Big counter card (font-mono, gradient-text)
//  3) Delta card с green/red arrow + growth % vs предыдущий период
//  4) Stats row 4 mini-cards: Засчитано / Отброшено / Уник IP / Скорость
//  5) Rejected breakdown — таблица 5 причин
//  6) Top-5 tracks list
//  7) Auto-refresh каждые 60 сек + manual refresh
//
// Источник: GET /api/admin/v304/plays-analytics?period=<P>
// Стиль: glass-card + Brand-style consistency rule (purple/fuchsia/cyan).

import { useState, useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";

type Period = "1h" | "24h" | "7d" | "30d" | "365d" | "all";

interface TopTrack {
  id: number;
  title: string;
  plays: number;
}

interface PlaysAnalytics {
  period: Period;
  since: string;
  until: string;
  counter: {
    current: number;
    delta: number;
    deltaPct: number;
  };
  plays: {
    counted: number;
    rejected: Record<string, number>;
    rejectedTotal: number;
    ratio: number;
  };
  topTracks: TopTrack[];
  uniqueIps: number;
  ratePerMin: number;
  comparison: {
    previousPeriod: number;
    growthPct: number;
  };
}

const PERIOD_LABELS: Record<Period, string> = {
  "1h": "1ч",
  "24h": "Сегодня",
  "7d": "Неделя",
  "30d": "Месяц",
  "365d": "Год",
  "all": "Всё время",
};

const PERIODS: Period[] = ["1h", "24h", "7d", "30d", "365d", "all"];

const REASON_LABELS: Record<string, string> = {
  "author-self": "Автор слушал свой трек",
  "admin": "Слушал админ",
  "bot-ua": "Бот / краулер",
  "too-short": "<5 сек",
  "ip-dedup-1h": "Повтор IP в 10 мин",
};

const REASON_COLORS: Record<string, string> = {
  "author-self": "#7C3AED",
  "admin": "#FBBF24",
  "bot-ua": "#00D4FF",
  "too-short": "#FF006E",
  "ip-dedup-1h": "#39FF14",
};

function fetcher<T>(url: string): Promise<T> {
  return fetch(url, { credentials: "include" }).then(async (r) => {
    if (!r.ok) {
      const txt = await r.text();
      throw new Error(`${r.status}: ${txt.slice(0, 200)}`);
    }
    const j = await r.json();
    if (j.error) throw new Error(j.error);
    return j.data as T;
  });
}

function num(n: number): string {
  if (!Number.isFinite(n)) return "0";
  return n.toLocaleString("ru-RU");
}

function copyToClipboard(text: string) {
  if (typeof navigator !== "undefined" && navigator.clipboard) {
    navigator.clipboard.writeText(text);
  }
}

export default function PlaysAnalyticsTab() {
  const [period, setPeriod] = useState<Period>("24h"); // Сегодня (default per task)

  const analytics = useQuery<PlaysAnalytics>({
    queryKey: ["plays-analytics", period],
    queryFn: () => fetcher<PlaysAnalytics>(`/api/admin/v304/plays-analytics?period=${period}`),
    refetchInterval: 60_000,
    refetchOnWindowFocus: false,
  });

  const data = analytics.data;

  const sortedRejected = useMemo(() => {
    if (!data) return [] as Array<[string, number]>;
    return Object.entries(data.plays.rejected).sort((a, b) => b[1] - a[1]);
  }, [data]);

  const growthDir = data && data.comparison.growthPct >= 0 ? "up" : "down";
  const growthColor = growthDir === "up" ? "text-emerald-400" : "text-red-400";
  const growthArrow = growthDir === "up" ? "▲" : "▼";

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="glass-card rounded-2xl p-6 border border-purple-500/30">
        <div className="flex items-start gap-3 flex-wrap">
          <div className="flex-1 min-w-[200px]">
            <h2 className="text-xl sm:text-2xl font-display font-bold gradient-text mb-1">
              📊 Прослушивания — аналитика
            </h2>
            <p className="text-sm font-sans text-muted-foreground leading-relaxed">
              Счётчик плеев с разбивкой по периодам. Source:{" "}
              <code className="font-mono text-purple-300">/api/admin/v304/plays-analytics</code>.
              Cache 60 сек, auto-refresh.
            </p>
          </div>
          <Button
            variant="outline"
            size="sm"
            onClick={() => analytics.refetch()}
            className="bg-white/5 border-purple-400/30 text-purple-300 hover:bg-purple-500/20"
            disabled={analytics.isFetching}
          >
            {analytics.isFetching ? "⏳" : "🔄"} Обновить
          </Button>
          {data && (
            <>
              <Button
                variant="outline"
                size="sm"
                onClick={() => {
                  const periodLabel = PERIOD_LABELS[period];
                  const lines: string[] = [];
                  lines.push(`📊 Прослушивания — отчёт (${periodLabel})`);
                  lines.push(`🕐 ${new Date().toLocaleString("ru-RU")}`);
                  lines.push("");
                  lines.push(`Текущий счётчик (всего): ${num(data.counter.current)}`);
                  lines.push(`Δ за ${periodLabel}: ${data.counter.delta >= 0 ? "+" : ""}${num(data.counter.delta)} (${data.comparison.growthPct >= 0 ? "▲" : "▼"} ${Math.abs(data.comparison.growthPct).toFixed(1)}%)`);
                  lines.push(`Vs предыдущий период: ${num(data.comparison.previousPeriod)}`);
                  lines.push("");
                  lines.push(`Засчитано: ${num(data.plays.counted)} (ratio ${(data.plays.ratio * 100).toFixed(1)}%)`);
                  lines.push(`Отброшено: ${num(data.plays.rejectedTotal)}`);
                  lines.push(`Уникальных IP: ${num(data.uniqueIps)}`);
                  lines.push(`Скорость: ${data.ratePerMin.toFixed(2)} плеев/мин`);
                  lines.push("");
                  lines.push("Разбивка отказов:");
                  for (const [reason, count] of sortedRejected) {
                    lines.push(`  ${REASON_LABELS[reason] || reason}: ${num(count)}`);
                  }
                  if (data.topTracks.length > 0) {
                    lines.push("");
                    lines.push(`Топ-${data.topTracks.length} треков за ${periodLabel}:`);
                    data.topTracks.forEach((t, i) => {
                      lines.push(`  ${i + 1}. #${t.id} · ${t.title} — ${num(t.plays)} плеев`);
                    });
                  }
                  copyToClipboard(lines.join("\n"));
                }}
                className="bg-fuchsia-500/15 border-fuchsia-400/40 text-fuchsia-200 hover:bg-fuchsia-500/25"
              >
                📋 Скопировать ВСЕ
              </Button>
              <Button
                variant="outline"
                size="sm"
                onClick={() => copyToClipboard(JSON.stringify(data, null, 2))}
                className="bg-white/5 border-amber-400/30 text-amber-300 hover:bg-amber-500/20"
              >
                📋 JSON
              </Button>
            </>
          )}
        </div>

        {/* Period selector pills */}
        <div className="mt-4 flex gap-2 flex-wrap">
          {PERIODS.map((p) => (
            <button
              key={p}
              type="button"
              onClick={() => setPeriod(p)}
              className={`px-4 py-2 rounded-full text-sm font-sans font-medium transition-all ${
                period === p
                  ? "bg-gradient-to-r from-purple-500 via-fuchsia-500 to-blue-500 text-white shadow-[0_0_24px_rgba(124,58,237,0.5)]"
                  : "bg-white/5 border border-purple-400/20 text-white/70 hover:bg-purple-500/10"
              }`}
            >
              {PERIOD_LABELS[p]}
            </button>
          ))}
        </div>
      </div>

      {/* Loading / error states */}
      {analytics.isLoading && (
        <div className="glass-card rounded-2xl p-6 border border-purple-500/30 text-sm font-sans text-muted-foreground">
          Загрузка...
        </div>
      )}
      {analytics.error && (
        <div className="glass-card rounded-2xl p-6 border border-red-500/30 text-sm font-sans text-red-400">
          Ошибка: {(analytics.error as Error).message}
        </div>
      )}

      {data && (
        <>
          {/* Big counter + delta row */}
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <Card className="glass-card border border-purple-500/30">
              <CardContent className="p-6">
                <div className="text-xs font-sans text-muted-foreground mb-2 uppercase tracking-wide">
                  🎵 Текущий счётчик (Плейлист авторов)
                </div>
                <div className="text-5xl sm:text-6xl font-mono font-bold bg-gradient-to-r from-purple-400 via-fuchsia-400 to-blue-400 bg-clip-text text-transparent">
                  {num(data.counter.current)}
                </div>
                <div className="text-xs font-sans text-muted-foreground mt-2">
                  Sum meta.plays для is_public=1 (все время)
                </div>
              </CardContent>
            </Card>

            <Card className="glass-card border border-amber-500/30">
              <CardContent className="p-6">
                <div className="text-xs font-sans text-muted-foreground mb-2 uppercase tracking-wide">
                  Δ за {PERIOD_LABELS[period]}
                </div>
                <div className="flex items-baseline gap-3">
                  <div className="text-5xl sm:text-6xl font-mono font-bold text-amber-300">
                    {data.counter.delta >= 0 ? "+" : ""}
                    {num(data.counter.delta)}
                  </div>
                  {period !== "all" && (
                    <div className={`text-2xl font-mono font-bold ${growthColor}`}>
                      {growthArrow} {Math.abs(data.comparison.growthPct).toFixed(1)}%
                    </div>
                  )}
                </div>
                <div className="text-xs font-sans text-muted-foreground mt-2">
                  {period !== "all" ? (
                    <>
                      vs предыдущий {PERIOD_LABELS[period]}:{" "}
                      <span className="font-mono text-white/70">{num(data.comparison.previousPeriod)}</span>
                    </>
                  ) : (
                    "за всё время"
                  )}
                </div>
              </CardContent>
            </Card>
          </div>

          {/* Stats row — 4 mini cards */}
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
            <Card className="glass-card border border-emerald-500/30">
              <CardContent className="p-4">
                <div className="text-xs font-sans text-muted-foreground mb-1">📈 Засчитано</div>
                <div className="text-2xl sm:text-3xl font-mono font-bold text-emerald-300">
                  {num(data.plays.counted)}
                </div>
                <div className="text-xs font-sans text-white/50 mt-1">
                  ratio {(data.plays.ratio * 100).toFixed(1)}%
                </div>
              </CardContent>
            </Card>
            <Card className="glass-card border border-pink-500/30">
              <CardContent className="p-4">
                <div className="text-xs font-sans text-muted-foreground mb-1">🛑 Отброшено</div>
                <div className="text-2xl sm:text-3xl font-mono font-bold text-pink-300">
                  {num(data.plays.rejectedTotal)}
                </div>
                <div className="text-xs font-sans text-white/50 mt-1">5 категорий ниже</div>
              </CardContent>
            </Card>
            <Card className="glass-card border border-cyan-500/30">
              <CardContent className="p-4">
                <div className="text-xs font-sans text-muted-foreground mb-1">👥 Уник IP</div>
                <div className="text-2xl sm:text-3xl font-mono font-bold text-cyan-300">
                  {num(data.uniqueIps)}
                </div>
                <div className="text-xs font-sans text-white/50 mt-1">DISTINCT за период</div>
              </CardContent>
            </Card>
            <Card className="glass-card border border-fuchsia-500/30">
              <CardContent className="p-4">
                <div className="text-xs font-sans text-muted-foreground mb-1">⚡ Скорость</div>
                <div className="text-2xl sm:text-3xl font-mono font-bold text-fuchsia-300">
                  {data.ratePerMin.toFixed(2)}
                </div>
                <div className="text-xs font-sans text-white/50 mt-1">плеев / мин</div>
              </CardContent>
            </Card>
          </div>

          {/* Rejected breakdown table */}
          <Card className="glass-card border border-pink-500/30">
            <CardContent className="p-6">
              <h3 className="text-lg font-sans font-bold text-white mb-3">
                🛑 Разбивка отказов по причинам
              </h3>
              {data.plays.rejectedTotal === 0 ? (
                <div className="text-sm font-sans text-muted-foreground">
                  Нет отброшенных попыток за {PERIOD_LABELS[period]}.
                </div>
              ) : (
                <div className="space-y-2">
                  {sortedRejected.map(([reason, count]) => {
                    const reasonPct = data.plays.rejectedTotal > 0
                      ? Math.round((count / data.plays.rejectedTotal) * 100)
                      : 0;
                    return (
                      <div key={reason} className="flex items-center gap-3 text-sm font-sans">
                        <div
                          className="w-3 h-3 rounded-full shrink-0"
                          style={{ background: REASON_COLORS[reason] || "#888" }}
                        />
                        <span className="text-white/80 flex-1 min-w-0 truncate">
                          {REASON_LABELS[reason] || reason}
                        </span>
                        <div className="flex-1 max-w-[200px] h-2 bg-white/5 rounded-full overflow-hidden">
                          <div
                            className="h-full rounded-full"
                            style={{
                              width: `${reasonPct}%`,
                              background: REASON_COLORS[reason] || "#888",
                            }}
                          />
                        </div>
                        <span className="font-mono text-amber-300 w-12 text-right shrink-0">
                          {num(count)}
                        </span>
                        <span className="font-mono text-white/40 w-10 text-right text-xs shrink-0">
                          {reasonPct}%
                        </span>
                      </div>
                    );
                  })}
                </div>
              )}
            </CardContent>
          </Card>

          {/* Top-5 tracks */}
          <Card className="glass-card border border-cyan-500/30">
            <CardContent className="p-6">
              <h3 className="text-lg font-sans font-bold text-white mb-3">
                🎵 Топ-5 треков за {PERIOD_LABELS[period]}
              </h3>
              {data.topTracks.length === 0 ? (
                <div className="text-sm font-sans text-muted-foreground">
                  За период никто не слушал треки.
                </div>
              ) : (
                <div className="overflow-x-auto rounded-lg border border-cyan-500/20">
                  <table className="w-full text-sm font-sans">
                    <thead>
                      <tr className="bg-cyan-500/10 text-cyan-300 text-left">
                        <th className="px-3 py-2 font-mono text-xs">#</th>
                        <th className="px-3 py-2 font-mono text-xs">ID</th>
                        <th className="px-3 py-2">Название</th>
                        <th className="px-3 py-2 font-mono text-xs text-right">Плеев</th>
                      </tr>
                    </thead>
                    <tbody>
                      {data.topTracks.map((t, i) => (
                        <tr key={t.id} className="border-t border-cyan-500/10">
                          <td className="px-3 py-2 font-mono text-xs text-white/40">
                            {i + 1}
                          </td>
                          <td className="px-3 py-2 font-mono text-xs text-white/60">
                            {t.id}
                          </td>
                          <td className="px-3 py-2 text-white/90 truncate max-w-[300px]">
                            {t.title}
                          </td>
                          <td className="px-3 py-2 font-mono text-cyan-300 text-right">
                            {num(t.plays)}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </CardContent>
          </Card>

          {/* Meta footer */}
          <div className="text-xs font-mono text-white/40 px-1">
            since={new Date(data.since).toISOString()} · until={new Date(data.until).toISOString()}
          </div>
        </>
      )}
    </div>
  );
}
