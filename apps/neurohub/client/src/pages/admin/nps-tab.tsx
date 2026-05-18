// Eugene 2026-05-18 Босс «NPS».
//
// Admin-вкладка «📊 NPS» — Net Promoter Score:
//   - Period selector (today/week/month/year/all)
//   - Big number NPS (% promoters - % detractors)
//   - SVG bar chart 0..10 distribution (без deps)
//   - Last 20 comments

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Loader2 } from "lucide-react";

type Resp = {
  period: string;
  total: number;
  npsScore: number;
  promoters: number;
  passives: number;
  detractors: number;
  distribution: Record<number, number>;
  comments: { id: number; user_id: number | null; score: number; comment: string; created_at: number }[];
};

const PERIODS = [
  { key: "today", label: "Сегодня" },
  { key: "week", label: "Неделя" },
  { key: "month", label: "Месяц" },
  { key: "year", label: "Год" },
  { key: "all", label: "Всё время" },
] as const;

function fmtTime(ms: number): string {
  return new Date(ms).toLocaleString("ru-RU", { dateStyle: "short", timeStyle: "short" });
}

function npsColor(n: number): string {
  if (n >= 50) return "text-emerald-400";
  if (n >= 0) return "text-amber-300";
  return "text-red-400";
}

function fetchNps(period: string): Promise<Resp> {
  return fetch(`/api/admin/v304/nps?period=${period}`, { credentials: "include" })
    .then(async (r) => {
      if (!r.ok) throw new Error(`${r.status}`);
      const j = await r.json();
      return j.data as Resp;
    });
}

export default function NpsTab(_props: { toast?: any }) {
  const [period, setPeriod] = useState<string>("month");

  const { data, isLoading } = useQuery({
    queryKey: ["/api/admin/v304/nps", period],
    queryFn: () => fetchNps(period),
    refetchInterval: 60_000,
  });

  const dist = data?.distribution ?? {};
  const maxBar = Math.max(1, ...Object.values(dist));
  const total = data?.total ?? 0;

  return (
    <div className="space-y-4">
      <Card className="glass-card border-purple-500/20">
        <CardHeader>
          <div className="flex items-center justify-between flex-wrap gap-3">
            <CardTitle className="font-display font-bold gradient-text text-2xl">
              📊 NPS — лояльность юзеров
            </CardTitle>
            <div className="flex gap-1 flex-wrap">
              {PERIODS.map((p) => (
                <button
                  key={p.key}
                  type="button"
                  onClick={() => setPeriod(p.key)}
                  className={`px-2.5 py-1 rounded-md text-xs font-medium transition ${
                    period === p.key
                      ? "bg-gradient-to-r from-purple-500/30 to-blue-500/30 border border-purple-400/50 text-white"
                      : "bg-white/5 border border-white/10 text-white/60 hover:bg-white/10"
                  }`}
                >
                  {p.label}
                </button>
              ))}
            </div>
          </div>
        </CardHeader>
        <CardContent>
          {isLoading && (
            <div className="flex items-center gap-2 text-white/60 py-10 justify-center">
              <Loader2 className="w-5 h-5 animate-spin" /> Загрузка…
            </div>
          )}

          {!isLoading && total === 0 && (
            <div className="text-white/50 text-sm py-10 text-center">
              За период {period} нет NPS-оценок.
            </div>
          )}

          {!isLoading && total > 0 && data && (
            <>
              {/* Big score */}
              <div className="flex flex-wrap items-end gap-6 mb-6">
                <div>
                  <div className={`font-display font-bold text-7xl ${npsColor(data.npsScore)}`}>
                    {data.npsScore > 0 ? "+" : ""}{data.npsScore}
                  </div>
                  <div className="text-xs text-white/50 font-sans">NPS = %промоутеров − %дитракторов</div>
                </div>
                <div className="grid grid-cols-3 gap-3 flex-1 min-w-[200px]">
                  <div className="glass-card rounded-lg p-3 border border-emerald-500/30 text-center">
                    <div className="font-mono text-2xl text-emerald-400 font-bold">{data.promoters}</div>
                    <div className="text-[10px] text-emerald-300/80 mt-1">Промоутеры (9-10)</div>
                  </div>
                  <div className="glass-card rounded-lg p-3 border border-amber-500/30 text-center">
                    <div className="font-mono text-2xl text-amber-300 font-bold">{data.passives}</div>
                    <div className="text-[10px] text-amber-200/80 mt-1">Пассивы (7-8)</div>
                  </div>
                  <div className="glass-card rounded-lg p-3 border border-red-500/30 text-center">
                    <div className="font-mono text-2xl text-red-400 font-bold">{data.detractors}</div>
                    <div className="text-[10px] text-red-300/80 mt-1">Дитракторы (0-6)</div>
                  </div>
                </div>
              </div>

              {/* Distribution bar chart (SVG inline, no deps) */}
              <div className="mb-6">
                <div className="text-sm font-sans text-white/70 mb-2">Распределение оценок (всего {total})</div>
                <svg viewBox="0 0 320 140" className="w-full max-w-2xl">
                  {Array.from({ length: 11 }, (_, i) => i).map((s) => {
                    const cnt = dist[s] ?? 0;
                    const h = (cnt / maxBar) * 100;
                    const x = s * 28 + 10;
                    const y = 110 - h;
                    const fill = s >= 9 ? "#10b981" : s <= 6 ? "#ef4444" : "#fbbf24";
                    return (
                      <g key={s}>
                        <rect x={x} y={y} width={22} height={h} fill={fill} opacity={0.7} />
                        <text x={x + 11} y={125} fontSize={10} textAnchor="middle" fill="rgba(255,255,255,0.6)" fontFamily="monospace">
                          {s}
                        </text>
                        {cnt > 0 && (
                          <text x={x + 11} y={y - 3} fontSize={9} textAnchor="middle" fill="rgba(255,255,255,0.9)" fontFamily="monospace">
                            {cnt}
                          </text>
                        )}
                      </g>
                    );
                  })}
                </svg>
              </div>

              {/* Comments */}
              <div>
                <div className="text-sm font-sans text-white/70 mb-2">Последние комментарии</div>
                {data.comments.length === 0 ? (
                  <div className="text-white/40 text-xs">Без комментариев за период.</div>
                ) : (
                  <div className="space-y-2">
                    {data.comments.map((c) => {
                      const scoreColor = c.score >= 9 ? "text-emerald-400" : c.score <= 6 ? "text-red-400" : "text-amber-300";
                      return (
                        <div key={c.id} className="glass-card rounded-lg p-3 border border-white/10">
                          <div className="flex items-center gap-2 text-xs mb-1">
                            <span className={`font-mono font-bold ${scoreColor}`}>{c.score}/10</span>
                            <span className="font-mono text-white/40">#{c.id}</span>
                            <span className="font-mono text-white/40">{fmtTime(c.created_at)}</span>
                          </div>
                          <div className="text-sm text-white/85 whitespace-pre-wrap break-words">{c.comment}</div>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            </>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
