// Eugene 2026-05-18 Босс «Во втором мозге анализируй тренды проекта,
// рекомендации по снятию барьеров между входом и генерацией с предоплатой».
//
// Вкладка «🧠 Второй мозг — Аналитика» в /admin/v304. Дополняет существующий
// 3D-визуальный «🧠 Второй мозг» (second-brain-3d.tsx) — этот tab чисто
// аналитический.
//
// Содержит:
//  1. 📊 Воронка вход → генерация → оплата (стадии + конверсии + dropoff).
//  2. 💡 Рекомендации по снятию барьеров (heuristic-based).
//  3. 📈 Тренды (графики регистраций / генераций / платежей / визитов).
//
// Period — через global bottom-bar (CustomEvent `admin-period-change`).

import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Loader2 } from "lucide-react";

// ---------- shared helpers ----------

function fetchJson<T>(url: string): Promise<T> {
  return fetch(url, { credentials: "include" }).then(async (r) => {
    if (!r.ok) throw new Error(`${r.status}: ${await r.text()}`);
    const j = await r.json();
    if (j.error) throw new Error(j.error);
    return j.data as T;
  });
}

function fmtNumber(n: number): string {
  return (n ?? 0).toLocaleString("ru-RU");
}

function copyJson(obj: unknown, toast?: (o: { title: string }) => void) {
  try {
    navigator.clipboard.writeText(JSON.stringify(obj, null, 2)).then(() => {
      toast?.({ title: "Скопировано" });
    });
  } catch {}
}

// ---------- types ----------

interface FunnelStage {
  id: string;
  label: string;
  count: number;
  conversionFromPrev: number;
  conversionFromTotal: number;
  dropoffPct: number;
}

interface FunnelData {
  period: string;
  periodLabel: string;
  fromIso: string;
  toIso: string;
  stages: FunnelStage[];
  worstStageIdx: number;
  worstStagePct: number;
}

interface BarrierRow {
  errorCode: string | null;
  errorMessage: string | null;
  count: number;
  severity: "high" | "medium" | "low";
}

interface BarrierData {
  period: string;
  periodLabel: string;
  topBarriers: {
    registration: BarrierRow[];
    payment: BarrierRow[];
  };
  abandonedPayments: number;
  avgTimes: {
    registerToFirstGenMin: number | null;
    registerToFirstPayHours: number | null;
  };
  gaps: {
    registeredButNoGen: number;
    genButNoPay: number;
  };
  topReferrers: Array<{ source: string; visits: number }>;
  recommendations: Array<{
    priority: "high" | "medium" | "low";
    text: string;
    detail?: string;
  }>;
}

interface TrendsData {
  period: string;
  periodLabel: string;
  series: {
    registrations: Array<{ day: string; c: number }>;
    generations: Array<{ day: string; c: number }>;
    payments: Array<{ day: string; c: number }>;
    paymentsSumKopecks: Array<{ day: string; c: number }>;
    visits: Array<{ day: string; c: number }>;
  };
}

// ---------- main ----------

export function SecondBrainTab({ toast }: { toast?: any }) {
  // period from global bottom-bar (admin-period-change CustomEvent).
  const [period, setPeriod] = useState<string>("today");

  useEffect(() => {
    const handler = (e: any) => {
      const p = e?.detail?.period;
      if (typeof p === "string") setPeriod(p);
    };
    window.addEventListener("admin-period-change", handler as any);
    return () =>
      window.removeEventListener("admin-period-change", handler as any);
  }, []);

  const funnelQ = useQuery<FunnelData>({
    queryKey: ["brain-funnel", period],
    queryFn: () =>
      fetchJson<FunnelData>(`/api/admin/v304/funnel-analysis?period=${period}`),
    refetchInterval: 60_000,
  });

  const barriersQ = useQuery<BarrierData>({
    queryKey: ["brain-barriers", period],
    queryFn: () =>
      fetchJson<BarrierData>(
        `/api/admin/v304/barrier-analysis?period=${period}`,
      ),
    refetchInterval: 120_000,
  });

  const trendsQ = useQuery<TrendsData>({
    queryKey: ["brain-trends", period],
    queryFn: () =>
      fetchJson<TrendsData>(`/api/admin/v304/brain-trends?period=${period}`),
    refetchInterval: 120_000,
  });

  return (
    <div className="space-y-4 relative">
      {/* cyber-grid фон + holographic header */}
      <div
        className="absolute inset-0 -z-10 cyber-grid pointer-events-none"
        aria-hidden
      />
      <Card className="glass-card border-purple-500/30 holographic">
        <CardHeader>
          <div className="flex items-center justify-between flex-wrap gap-2">
            <CardTitle className="font-display gradient-text neon-text text-2xl">
              🧠 Второй мозг — Аналитика
            </CardTitle>
            <span className="text-[10px] font-mono text-white/40">
              Period:{" "}
              <span className="text-cyan-300">
                {funnelQ.data?.periodLabel ?? period}
              </span>
            </span>
          </div>
          <p className="text-xs font-sans text-muted-foreground mt-1">
            Аналитический разбор: воронка от посетителя до повторной оплаты,
            точки потери юзеров, recommendations по снятию барьеров,
            daily-тренды (регистрации / генерации / платежи / визиты).
          </p>
        </CardHeader>
      </Card>

      {/* === FUNNEL === */}
      <Card className="glass-card border-cyan-500/20">
        <CardHeader>
          <CardTitle className="font-sans font-bold text-white text-base">
            📊 Воронка: вход → регистрация → генерация → оплата
          </CardTitle>
        </CardHeader>
        <CardContent>
          {funnelQ.isLoading ? (
            <div className="text-xs text-cyan-300 flex items-center gap-2">
              <Loader2 className="w-3 h-3 animate-spin" /> Загрузка воронки…
            </div>
          ) : funnelQ.error ? (
            <div className="text-xs text-rose-300">
              Ошибка: {String(funnelQ.error)}
            </div>
          ) : funnelQ.data ? (
            <FunnelView data={funnelQ.data} />
          ) : null}
          <div className="flex justify-end mt-3">
            <button
              onClick={() => copyJson(funnelQ.data, toast)}
              className="text-[11px] font-sans px-2.5 py-1 rounded-md bg-white/5 hover:bg-white/10 text-white/70"
            >
              📋 Копировать
            </button>
          </div>
        </CardContent>
      </Card>

      {/* === BARRIERS === */}
      <Card className="glass-card border-amber-500/20">
        <CardHeader>
          <CardTitle className="font-sans font-bold text-white text-base">
            💡 Рекомендации по снятию барьеров
          </CardTitle>
        </CardHeader>
        <CardContent>
          {barriersQ.isLoading ? (
            <div className="text-xs text-amber-300 flex items-center gap-2">
              <Loader2 className="w-3 h-3 animate-spin" /> Анализирую…
            </div>
          ) : barriersQ.error ? (
            <div className="text-xs text-rose-300">
              Ошибка: {String(barriersQ.error)}
            </div>
          ) : barriersQ.data ? (
            <BarriersView data={barriersQ.data} />
          ) : null}
          <div className="flex justify-end mt-3">
            <button
              onClick={() => copyJson(barriersQ.data, toast)}
              className="text-[11px] font-sans px-2.5 py-1 rounded-md bg-white/5 hover:bg-white/10 text-white/70"
            >
              📋 Копировать
            </button>
          </div>
        </CardContent>
      </Card>

      {/* === TRENDS === */}
      <Card className="glass-card border-purple-500/20">
        <CardHeader>
          <CardTitle className="font-sans font-bold text-white text-base">
            📈 Тренды (по дням)
          </CardTitle>
        </CardHeader>
        <CardContent>
          {trendsQ.isLoading ? (
            <div className="text-xs text-purple-300 flex items-center gap-2">
              <Loader2 className="w-3 h-3 animate-spin" /> Загрузка трендов…
            </div>
          ) : trendsQ.error ? (
            <div className="text-xs text-rose-300">
              Ошибка: {String(trendsQ.error)}
            </div>
          ) : trendsQ.data ? (
            <TrendsView data={trendsQ.data} />
          ) : null}
        </CardContent>
      </Card>
    </div>
  );
}

// ---------- FunnelView ----------

function FunnelView({ data }: { data: FunnelData }) {
  const max = Math.max(1, ...data.stages.map((s) => s.count));
  return (
    <div className="space-y-2">
      {data.stages.map((s, idx) => {
        const widthPct = Math.max(2, (s.count / max) * 100);
        const isWorst = idx === data.worstStageIdx;
        return (
          <div key={s.id} className="space-y-1">
            <div className="flex items-center justify-between gap-2 text-[11px] font-sans">
              <span className="text-white/80">
                <span className="text-white/40 font-mono">{idx + 1}.</span>{" "}
                {s.label}
              </span>
              <div className="flex items-center gap-2 font-mono text-[10px]">
                <span className="text-white font-semibold">
                  {fmtNumber(s.count)}
                </span>
                {idx > 0 ? (
                  <span
                    className={
                      s.dropoffPct > 50
                        ? "text-rose-300"
                        : s.dropoffPct > 25
                          ? "text-amber-300"
                          : "text-emerald-300"
                    }
                  >
                    ↓{s.dropoffPct}%
                  </span>
                ) : null}
                <span className="text-white/40">
                  {s.conversionFromTotal}% от входа
                </span>
              </div>
            </div>
            <div className="relative h-6 rounded-md bg-white/5 overflow-hidden">
              <div
                className={`absolute inset-y-0 left-0 rounded-md transition-all ${
                  isWorst
                    ? "bg-gradient-to-r from-rose-500/60 to-rose-400/40 shadow-[0_0_16px_rgba(244,63,94,0.4)]"
                    : "bg-gradient-to-r from-purple-500/60 via-fuchsia-500/50 to-blue-500/40"
                }`}
                style={{ width: `${widthPct}%` }}
              />
              {isWorst ? (
                <span className="absolute right-2 inset-y-0 flex items-center text-[10px] font-sans text-rose-200 font-medium">
                  🔥 макс. dropoff
                </span>
              ) : null}
            </div>
          </div>
        );
      })}
      {data.worstStageIdx >= 0 ? (
        <div className="text-[11px] font-sans text-rose-300/80 mt-2 p-2 rounded-md bg-rose-500/[0.05] border border-rose-500/20">
          🔥 Главная точка потери: стадия «
          {data.stages[data.worstStageIdx]?.label}» — теряем{" "}
          <span className="font-mono font-semibold">
            {data.worstStagePct}%
          </span>{" "}
          юзеров vs предыдущая стадия.
        </div>
      ) : null}
    </div>
  );
}

// ---------- BarriersView ----------

function BarriersView({ data }: { data: BarrierData }) {
  return (
    <div className="space-y-4">
      {/* Recommendations (top) */}
      <div className="space-y-2">
        {data.recommendations.map((r, idx) => (
          <div
            key={idx}
            className={`p-2.5 rounded-md border ${
              r.priority === "high"
                ? "border-rose-500/30 bg-rose-500/[0.04]"
                : r.priority === "medium"
                  ? "border-amber-500/30 bg-amber-500/[0.04]"
                  : "border-emerald-500/20 bg-emerald-500/[0.03]"
            }`}
          >
            <div className="flex items-start gap-2">
              <span
                className={`text-[10px] font-sans px-1.5 py-0.5 rounded-full font-medium ${
                  r.priority === "high"
                    ? "bg-rose-500/30 text-rose-200"
                    : r.priority === "medium"
                      ? "bg-amber-500/30 text-amber-200"
                      : "bg-emerald-500/20 text-emerald-200"
                }`}
              >
                {r.priority === "high"
                  ? "⚡ КРИТ"
                  : r.priority === "medium"
                    ? "⚠ ВАЖНО"
                    : "💡"}
              </span>
              <div className="flex-1 text-[11px] font-sans text-white/90">
                {r.text}
                {r.detail ? (
                  <div className="text-[10px] text-white/60 mt-1">
                    {r.detail}
                  </div>
                ) : null}
              </div>
            </div>
          </div>
        ))}
      </div>

      {/* Stats grid */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-2">
        <Stat
          label="Зарег., но без генерации"
          value={fmtNumber(data.gaps.registeredButNoGen)}
          color="amber"
        />
        <Stat
          label="Генерили, но без оплаты"
          value={fmtNumber(data.gaps.genButNoPay)}
          color="rose"
        />
        <Stat
          label="Регистрация → 1я ген (мин)"
          value={
            data.avgTimes.registerToFirstGenMin !== null
              ? `${data.avgTimes.registerToFirstGenMin}м`
              : "—"
          }
          color="cyan"
        />
        <Stat
          label="Регистрация → 1я оплата (ч)"
          value={
            data.avgTimes.registerToFirstPayHours !== null
              ? `${data.avgTimes.registerToFirstPayHours}ч`
              : "—"
          }
          color="purple"
        />
      </div>

      {/* Top barriers tables */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
        <BarrierTable
          title="Топ причин отказа от регистрации"
          rows={data.topBarriers.registration}
        />
        <BarrierTable
          title="Топ причин отказа от оплаты"
          rows={data.topBarriers.payment}
        />
      </div>

      {/* Top referrers */}
      {data.topReferrers.length > 0 ? (
        <div>
          <div className="text-[10px] uppercase font-sans text-white/50 mb-1.5">
            Топ источников трафика
          </div>
          <div className="space-y-1">
            {data.topReferrers.map((r, idx) => (
              <div
                key={idx}
                className="flex items-center gap-2 text-[11px] font-sans p-1.5 rounded-md bg-white/[0.03] border border-cyan-500/15"
              >
                <span className="font-mono text-white/40 w-5">{idx + 1}.</span>
                <span className="text-white/85 flex-1 truncate font-mono">
                  {r.source}
                </span>
                <span className="font-mono text-cyan-300">
                  {fmtNumber(r.visits)}
                </span>
              </div>
            ))}
          </div>
        </div>
      ) : null}
    </div>
  );
}

function Stat({
  label,
  value,
  color,
}: {
  label: string;
  value: string;
  color: "amber" | "rose" | "cyan" | "purple";
}) {
  const colorClass =
    color === "amber"
      ? "text-amber-300 border-amber-500/30"
      : color === "rose"
        ? "text-rose-300 border-rose-500/30"
        : color === "cyan"
          ? "text-cyan-300 border-cyan-500/30"
          : "text-purple-300 border-purple-500/30";
  return (
    <div
      className={`glass-card rounded-md p-2 border ${colorClass.split(" ")[1]}`}
    >
      <div className="text-[10px] font-sans text-white/50 mb-0.5">{label}</div>
      <div
        className={`text-lg font-display font-bold ${colorClass.split(" ")[0]}`}
      >
        {value}
      </div>
    </div>
  );
}

function BarrierTable({
  title,
  rows,
}: {
  title: string;
  rows: BarrierRow[];
}) {
  return (
    <div className="glass-card rounded-md border border-purple-500/15 p-2.5">
      <div className="text-[10px] uppercase font-sans text-white/50 mb-1.5">
        {title}
      </div>
      {rows.length === 0 ? (
        <div className="text-[11px] text-white/40 py-1">Нет ошибок.</div>
      ) : (
        <div className="space-y-1">
          {rows.map((r, idx) => (
            <div
              key={idx}
              className="flex items-center gap-2 text-[11px] font-sans"
            >
              <span
                className={`text-[10px] font-sans px-1.5 py-0.5 rounded-full ${
                  r.severity === "high"
                    ? "bg-rose-500/20 text-rose-300"
                    : r.severity === "medium"
                      ? "bg-amber-500/20 text-amber-300"
                      : "bg-emerald-500/20 text-emerald-300"
                }`}
              >
                {r.severity}
              </span>
              <span className="font-mono text-white/80 flex-1 truncate">
                {r.errorCode || "—"}
              </span>
              <span className="font-mono text-white">{r.count}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ---------- TrendsView ----------

function TrendsView({ data }: { data: TrendsData }) {
  return (
    <div className="space-y-4">
      <TrendChart
        title="🆕 Регистрации"
        series={data.series.registrations}
        color="#39FF14"
      />
      <TrendChart
        title="🎵 Генерации"
        series={data.series.generations}
        color="#7C3AED"
      />
      <TrendChart
        title="💰 Платежи (count)"
        series={data.series.payments}
        color="#FBBF24"
      />
      <TrendChart
        title="💵 Сумма оплат (₽)"
        series={data.series.paymentsSumKopecks.map((p) => ({
          day: p.day,
          c: Math.round(p.c / 100),
        }))}
        color="#FF006E"
        suffix="₽"
      />
      <TrendChart
        title="👥 Уникальные посетители (по IP)"
        series={data.series.visits}
        color="#00D4FF"
      />
    </div>
  );
}

// SVG-based sparkline chart (без зависимостей). 100% width, fixed 60px height.
function TrendChart({
  title,
  series,
  color,
  suffix,
}: {
  title: string;
  series: Array<{ day: string; c: number }>;
  color: string;
  suffix?: string;
}) {
  if (series.length === 0) {
    return (
      <div className="text-[11px] font-sans text-white/40 py-1">
        {title} — данных нет
      </div>
    );
  }
  const max = Math.max(1, ...series.map((s) => s.c));
  const sum = series.reduce((a, b) => a + b.c, 0);
  const W = 600;
  const H = 60;
  const stepX = series.length > 1 ? W / (series.length - 1) : W;
  const points = series
    .map((s, i) => `${i * stepX},${H - (s.c / max) * (H - 4) - 2}`)
    .join(" ");
  return (
    <div>
      <div className="flex items-center justify-between text-[11px] font-sans mb-1">
        <span className="text-white/80">{title}</span>
        <span className="font-mono text-white/40">
          сумма:{" "}
          <span className="text-white/80">
            {fmtNumber(sum)}
            {suffix ?? ""}
          </span>{" "}
          · max <span className="text-white/60">{fmtNumber(max)}</span>
        </span>
      </div>
      <div className="relative">
        <svg
          viewBox={`0 0 ${W} ${H}`}
          preserveAspectRatio="none"
          className="w-full h-[60px] rounded-md bg-white/[0.02] border border-white/5"
        >
          <polyline
            fill="none"
            stroke={color}
            strokeWidth="1.5"
            points={points}
            vectorEffect="non-scaling-stroke"
          />
          <polyline
            fill={color}
            fillOpacity="0.15"
            stroke="none"
            points={`0,${H} ${points} ${W},${H}`}
          />
        </svg>
        <div className="flex justify-between text-[9px] font-mono text-white/30 mt-0.5">
          <span>{series[0]?.day}</span>
          <span>{series[series.length - 1]?.day}</span>
        </div>
      </div>
    </div>
  );
}

export default SecondBrainTab;
