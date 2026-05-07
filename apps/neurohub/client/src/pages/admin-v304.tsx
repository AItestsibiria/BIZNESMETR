// v304 admin panel — Overview / Templates / Flags / Leads / Audit.
// Spec: docs/strategy/original/03 §4 + Eugene «Backup-before-edit» правило.
//
// Все редакции сохраняют snapshot в admin_audit_log; в успешном
// ответе возвращается auditId, по которому можно откатить через
// POST /api/admin/v304/audit/:id/restore. Это и видно на вкладке Audit.

import { useState } from "react";
import { useLocation } from "wouter";
import { useQuery, useMutation } from "@tanstack/react-query";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { useAuth } from "@/lib/auth";
import { useToast } from "@/hooks/use-toast";
import { HelpBuddy } from "@/components/help-buddy";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Switch } from "@/components/ui/switch";
import { Progress } from "@/components/ui/progress";
import { ResponsiveContainer, BarChart, Bar, XAxis, YAxis, Tooltip, Cell } from "recharts";

type Overview = {
  timestamp: string;
  events: { total: number; breakdown: { name: string; count: number }[] };
  agents: Record<string, { executed: number; failed: number; pending: number }>;
  leads: { total: number; byStatus: Record<string, number> };
  templates: { top: { slug: string; name: string; popularity: number }[] };
  featureFlags: { key: string; enabled: boolean; rollout: number }[];
  generations: { recent: any[]; totalByStatus: { status: string; c: number }[] };
  chatbot: { recent: any[]; byChannel: { channel: string; count: number }[] };
  plugins: { total: number; active: number; failed: number; list: any[] };
};

type Template = {
  id: number;
  slug: string;
  name: string;
  category: string | null;
  description: string | null;
  promptTemplate: string | null;
  style: string | null;
  recommendedBpm: number | null;
  recommendedKey: string | null;
  active: number;
};

type Flag = {
  key: string;
  enabled: number;
  rolloutPercent: number;
  description: string | null;
};

type Lead = {
  id: number;
  fingerprint: string | null;
  email: string | null;
  status: string;
  score: number;
  segment: string | null;
};

type AuditEntry = {
  id: number;
  adminEmail: string | null;
  action: string;
  entity: string;
  entityKey: string;
  beforeJson: string | null;
  afterJson: string | null;
  createdAt: string;
};

function fetcher<T>(url: string): Promise<T> {
  return fetch(url, { credentials: "include" }).then(async (r) => {
    if (!r.ok) throw new Error(`${r.status}: ${await r.text()}`);
    const j = await r.json();
    return j.data as T;
  });
}

export default function AdminV304Page() {
  const { user } = useAuth();
  const { toast } = useToast();

  // Защита на стороне клиента — мягкая (бэк всё равно проверит).
  // Админ-доступ для тех, чей email есть в server-side ADMIN_EMAIL списке;
  // на клиенте это знание неполное, поэтому показываем UI всем
  // авторизованным пользователям и оставляем backend ответить 403.
  if (!user) {
    return (
      <div className="p-8 max-w-2xl mx-auto">
        <Card>
          <CardHeader>
            <CardTitle>Войди в систему</CardTitle>
          </CardHeader>
          <CardContent>
            <a href="#/login" className="underline">→ Войти</a>
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div className="container mx-auto p-4 sm:p-6 max-w-7xl">
      <div className="flex items-center gap-3 mb-6">
        <h1 className="text-2xl sm:text-3xl font-bold">Admin · v304</h1>
        <HelpBuddy
          variant="violet"
          title="Что есть в админ-панели?"
          align="start"
          sections={[
            { label: "Обзор", text: "Health всех 22 плагинов, infra-сервисы (БД, диск, GPTunnel), live баланс, лиды, события за 24ч, кнопки 🎵 Запустить гимн / 🚑 Реанимировать.", color: "text-violet-300" },
            { label: "🔑 Секреты", text: "Безопасная ротация API-ключей и SMTP. Verify пробный запрос, runtime-check сравнивает .env vs процесс.", color: "text-amber-300" },
            { label: "Шаблоны", text: "10 готовых шаблонов генерации (свадьба, юбилей, корпоратив). Можно править/удалять с откатом.", color: "text-purple-300" },
            { label: "Feature flags", text: "Включай/выключай фичи без релиза.", color: "text-emerald-300" },
            { label: "Лиды", text: "Все email-подписки и demo-запросы.", color: "text-cyan-300" },
            { label: "Audit log", text: "Все правки в админке с before/after JSON и кнопкой «Восстановить».", color: "text-rose-300" },
          ]}
        />
      </div>
      <Tabs defaultValue="overview">
        <TabsList className="mb-4 flex flex-wrap">
          <TabsTrigger value="overview">Обзор</TabsTrigger>
          <TabsTrigger value="secrets">🔑 Секреты</TabsTrigger>
          <TabsTrigger value="templates">Шаблоны</TabsTrigger>
          <TabsTrigger value="flags">Feature flags</TabsTrigger>
          <TabsTrigger value="leads">Лиды</TabsTrigger>
          <TabsTrigger value="audit">Audit log</TabsTrigger>
        </TabsList>
        <TabsContent value="overview"><OverviewTab toast={toast} /></TabsContent>
        <TabsContent value="secrets"><SecretsTab toast={toast} /></TabsContent>
        <TabsContent value="templates"><TemplatesTab toast={toast} /></TabsContent>
        <TabsContent value="flags"><FlagsTab toast={toast} /></TabsContent>
        <TabsContent value="leads"><LeadsTab toast={toast} /></TabsContent>
        <TabsContent value="audit"><AuditTab toast={toast} /></TabsContent>
      </Tabs>
    </div>
  );
}

// ============================================================
// Overview tab — красивый dashboard с health-check всех служб
// ============================================================
type HealthCheck = {
  timestamp: string;
  overall: "ok" | "degraded" | "down";
  summary: {
    plugins_total: number;
    plugins_ok: number;
    plugins_degraded: number;
    plugins_down: number;
    plugins_unknown: number;
  };
  plugins: Array<{
    name: string;
    version: string;
    status: "ok" | "degraded" | "down" | "unknown";
    durationMs: number;
    details?: Record<string, unknown>;
    error?: string;
  }>;
  services: Array<{
    name: string;
    status: "ok" | "degraded" | "down" | "skipped";
    details?: Record<string, unknown>;
    error?: string;
  }>;
};

function statusColor(s: string): string {
  switch (s) {
    case "ok": return "bg-emerald-500";
    case "degraded": return "bg-amber-500";
    case "down": return "bg-rose-600";
    case "skipped": return "bg-slate-500";
    case "unknown": return "bg-slate-400";
    default: return "bg-slate-300";
  }
}

// Карточка баланса GPTunnel — auto-refresh каждые 60 сек, ручной refresh
// через кнопку 'Обновить'. Показывает большим шрифтом текущий баланс.
function GptunnelBalanceCard() {
  const { data, refetch, isLoading } = useQuery({
    queryKey: ["gptunnel-balance"],
    queryFn: () => fetcher<any>("/api/admin/v304/gptunnel-balance"),
    refetchInterval: 60000,
  });

  const refresh = useMutation({
    mutationFn: async () => {
      const r = await apiRequest("GET", "/api/admin/v304/gptunnel-balance?force=1");
      return r.json();
    },
    onSuccess: () => refetch(),
  });

  const available = data?.available !== false;
  const balance = data?.balance ?? null;
  const currency = data?.currency ?? "₽";
  const reason = data?.reason ?? data?.error ?? null;
  const sunoTracks = data?.suno?.estimatedTracks ?? null;
  const sunoPrice = data?.suno?.pricePerTrack ?? null;
  const low = balance != null && balance < 750;
  const cls = !available
    ? "from-rose-600/20 via-rose-600/5 to-transparent border-rose-500/40"
    : low
      ? "from-amber-500/25 via-amber-500/5 to-transparent border-amber-500/50"
      : "from-emerald-500/20 via-emerald-500/5 to-transparent border-emerald-500/40";

  return (
    <Card className={`bg-gradient-to-br ${cls}`}>
      <CardContent className="p-5 flex flex-col sm:flex-row items-start sm:items-center justify-between gap-3">
        <div className="flex-1 min-w-0">
          <div className="text-xs uppercase text-muted-foreground tracking-wider">GPTunnel баланс</div>
          {available ? (
            <>
              <div className="text-4xl font-bold mt-1">
                {balance != null ? balance.toLocaleString("ru-RU") : "—"}
                <span className="text-base font-normal text-muted-foreground ml-1">{currency}</span>
                {low && <Badge variant="destructive" className="ml-3 align-middle">⚠ ниже 750</Badge>}
              </div>
              {sunoTracks != null && (
                <div className="mt-2 flex items-center gap-2 text-sm">
                  <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-violet-500/15 text-violet-300 border border-violet-500/30">
                    🎵 MuziAi: ≈ <b>{sunoTracks.toLocaleString("ru-RU")}</b> треков
                  </span>
                  {sunoPrice != null && (
                    <span className="text-[10px] text-muted-foreground">
                      по {sunoPrice}₽/трек
                    </span>
                  )}
                </div>
              )}
            </>
          ) : (
            <div className="text-base text-rose-500 mt-1">⚠ недоступен: {reason ?? "?"}</div>
          )}
          {data?.fetchedAt && (
            <div className="text-[10px] text-muted-foreground mt-1">
              {data.cached ? "из кэша · " : ""}
              обновлено {new Date(data.fetchedAt).toLocaleTimeString("ru-RU")}
            </div>
          )}
        </div>
        <Button
          variant="outline"
          size="sm"
          onClick={() => refresh.mutate()}
          disabled={refresh.isPending || isLoading}
        >
          {refresh.isPending ? "Обновляю…" : "🔄 Обновить"}
        </Button>
      </CardContent>
    </Card>
  );
}

function StatBox({ label, value, color }: { label: string; value: number; color: string }) {
  return (
    <div className="rounded-md border bg-background/40 backdrop-blur px-3 py-2 min-w-[60px]">
      <div className={`text-2xl font-bold ${color}`}>{value}</div>
      <div className="text-[10px] uppercase text-muted-foreground">{label}</div>
    </div>
  );
}

function BigStat({ label, value, color, hint }: { label: string; value: number | string; color: string; hint?: string }) {
  const colorClass = ({
    emerald: "from-emerald-500/15 to-transparent border-emerald-500/30",
    indigo: "from-indigo-500/15 to-transparent border-indigo-500/30",
    violet: "from-violet-500/15 to-transparent border-violet-500/30",
    amber: "from-amber-500/15 to-transparent border-amber-500/30",
  } as Record<string, string>)[color] ?? "";
  return (
    <div className={`rounded-xl border p-4 bg-gradient-to-br ${colorClass}`}>
      <div className="text-3xl font-bold">{value}</div>
      <div className="text-xs uppercase text-muted-foreground">{label}</div>
      {hint && <div className="text-[10px] text-muted-foreground mt-1">{hint}</div>}
    </div>
  );
}

type Incident = {
  id: number;
  kind: string;
  severity: "critical" | "warning" | "info";
  title: string;
  rootCause: string | null;
  resolution: string | null;
  evidence: string | null;
  status: "open" | "resolved" | "auto-resolved" | "dismissed";
  firstSeenAt: string | null;
  lastSeenAt: string | null;
  resolvedAt: string | null;
  occurrences: number;
};

function CriticalIncidentsCard() {
  const { toast } = useToast();
  const { data, refetch } = useQuery({
    queryKey: ["v304-incidents"],
    queryFn: () => fetcher<{ open: Incident[]; recentResolved: Incident[]; counts: { open: number; critical_open: number; warning_open: number } }>("/api/admin/v304/incidents"),
    refetchInterval: 20000,
  });

  const resolve = useMutation({
    mutationFn: async ({ id, action }: { id: number; action: "resolve" | "dismiss" }) => {
      const r = await apiRequest("POST", `/api/admin/v304/incidents/${id}/${action}`, {});
      return r.json();
    },
    onSuccess: () => {
      toast({ title: "Инцидент закрыт" });
      refetch();
    },
    onError: (e: Error) => toast({ title: "Ошибка", description: e.message, variant: "destructive" }),
  });

  const scan = useMutation({
    mutationFn: async () => {
      const r = await apiRequest("POST", "/api/admin/v304/incidents/scan-now", {});
      return r.json();
    },
    onSuccess: () => {
      toast({ title: "Сканирование запущено" });
      refetch();
    },
  });

  if (!data) return null;
  const open = data.open;
  if (open.length === 0) {
    return (
      <Card className="border-emerald-500/40 bg-emerald-500/5">
        <CardContent className="p-3 text-sm flex items-center justify-between gap-3">
          <span className="text-emerald-500 font-medium">✅ Нет открытых инцидентов</span>
          <Button size="sm" variant="outline" onClick={() => scan.mutate()} disabled={scan.isPending}>
            {scan.isPending ? "Сканирую…" : "🔎 Сканировать сейчас"}
          </Button>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card className="border-rose-600 bg-gradient-to-br from-rose-600/15 via-rose-600/5 to-transparent">
      <CardHeader className="pb-2">
        <CardTitle className="text-base flex items-center gap-2">
          <span className="text-rose-500 text-lg">🔴 Критично</span>
          <Badge variant="destructive">{data.counts.critical_open} критических</Badge>
          {data.counts.warning_open > 0 && <Badge variant="outline">{data.counts.warning_open} warn</Badge>}
          <span className="ml-auto">
            <Button size="sm" variant="outline" onClick={() => scan.mutate()} disabled={scan.isPending}>
              {scan.isPending ? "Сканирую…" : "🔎 Скан"}
            </Button>
          </span>
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        {open.map((i) => (
          <div
            key={i.id}
            className={`rounded-lg border p-3 space-y-2 ${
              i.severity === "critical" ? "border-rose-500/60 bg-rose-500/5" : "border-amber-500/50 bg-amber-500/5"
            }`}
          >
            <div className="flex items-start justify-between gap-3">
              <div className="flex-1 min-w-0">
                <div className="font-semibold text-sm flex items-center gap-2">
                  <Badge
                    className={i.severity === "critical" ? "bg-rose-600" : "bg-amber-500"}
                  >
                    {i.severity === "critical" ? "CRITICAL" : "WARN"}
                  </Badge>
                  <code className="text-xs text-muted-foreground">{i.kind}</code>
                  <span className="text-xs text-muted-foreground">×{i.occurrences}</span>
                </div>
                <div className="mt-1 text-sm">{i.title}</div>
              </div>
              <div className="flex flex-col gap-1 shrink-0">
                <Button size="sm" variant="outline" onClick={() => resolve.mutate({ id: i.id, action: "resolve" })}>
                  ✓ Решено
                </Button>
                <Button size="sm" variant="ghost" onClick={() => resolve.mutate({ id: i.id, action: "dismiss" })}>
                  Игнорировать
                </Button>
              </div>
            </div>
            {i.rootCause && (
              <div className="text-xs">
                <span className="font-medium">Первопричина: </span>
                <span className="text-muted-foreground">{i.rootCause}</span>
              </div>
            )}
            {i.resolution && (
              <div className="text-xs rounded bg-background/50 border p-2">
                <span className="font-medium">Что делать: </span>
                {i.resolution}
              </div>
            )}
            {i.lastSeenAt && (
              <div className="text-[10px] text-muted-foreground">
                Последний раз: {new Date(i.lastSeenAt).toLocaleString("ru-RU")}
              </div>
            )}
          </div>
        ))}
      </CardContent>
    </Card>
  );
}

function OverviewTab({ toast: _t }: { toast: any }) {
  const overview = useQuery({
    queryKey: ["admin-overview"],
    queryFn: () => fetcher<Overview>("/api/admin/v304/overview"),
    refetchInterval: 30000,
  });
  const health = useQuery({
    queryKey: ["v304-health-check-all"],
    queryFn: () => fetcher<HealthCheck>("/api/_v304/health-check-all"),
    refetchInterval: 60000,
  });

  if (overview.isLoading || health.isLoading) {
    return <div className="p-8 text-center text-muted-foreground">Загрузка дашборда…</div>;
  }
  if (overview.error) return <div className="text-rose-500">Overview error: {(overview.error as Error).message}</div>;

  const data = overview.data;
  const hc = health.data;
  if (!data) return null;

  const overall = hc?.overall ?? "unknown";
  const heroBg =
    overall === "ok"
      ? "from-emerald-500/15 via-emerald-500/5 to-transparent"
      : overall === "degraded"
        ? "from-amber-500/15 via-amber-500/5 to-transparent"
        : overall === "down"
          ? "from-rose-600/20 via-rose-600/10 to-transparent"
          : "from-slate-500/10 via-transparent to-transparent";
  const heroPulse = overall === "ok" ? "bg-emerald-500" : overall === "degraded" ? "bg-amber-500" : overall === "down" ? "bg-rose-600" : "bg-slate-500";
  const overallText = overall === "ok" ? "OK" : overall === "degraded" ? "DEGRADED" : overall === "down" ? "DOWN" : "UNKNOWN";

  const eventsChart = data.events.breakdown.slice(0, 8).map((e) => ({ name: e.name.slice(-22), count: e.count }));

  return (
    <div className="space-y-6">
      <CriticalIncidentsCard />

      <div className={`rounded-2xl border bg-gradient-to-br ${heroBg} p-6 sm:p-8`}>
        <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4">
          <div className="flex items-center gap-4">
            <div className="relative">
              <div className={`w-4 h-4 rounded-full ${heroPulse} animate-pulse`} />
              <div className={`absolute inset-0 w-4 h-4 rounded-full ${heroPulse} animate-ping opacity-40`} />
            </div>
            <div>
              <div className="text-2xl sm:text-3xl font-bold">
                v304 platform: <span className={
                  overall === "ok" ? "text-emerald-500"
                  : overall === "degraded" ? "text-amber-500"
                  : overall === "down" ? "text-rose-500"
                  : "text-slate-500"
                }>{overallText}</span>
              </div>
              <div className="text-xs text-muted-foreground">
                {hc?.timestamp ? new Date(hc.timestamp).toLocaleString("ru-RU") : "—"}
              </div>
            </div>
          </div>
          <div className="grid grid-cols-4 gap-3 text-center">
            <StatBox label="OK" value={hc?.summary.plugins_ok ?? 0} color="text-emerald-500" />
            <StatBox label="Degraded" value={hc?.summary.plugins_degraded ?? 0} color="text-amber-500" />
            <StatBox label="Down" value={hc?.summary.plugins_down ?? 0} color="text-rose-500" />
            <StatBox label="Total" value={hc?.summary.plugins_total ?? 0} color="text-foreground" />
          </div>
        </div>
      </div>

      {hc && (
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-base">Инфраструктурные сервисы</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="flex flex-wrap gap-3">
              {hc.services.map((s) => (
                <div key={s.name} className="flex items-center gap-2 rounded-lg border px-3 py-2">
                  <div className={`w-2.5 h-2.5 rounded-full ${statusColor(s.status)}`} />
                  <div>
                    <div className="font-medium uppercase text-xs">{s.name}</div>
                    <div className="text-[11px] text-muted-foreground">
                      {s.details && Object.keys(s.details).length > 0
                        ? Object.entries(s.details).slice(0, 2).map(([k, v]) => `${k}=${v}`).join(", ")
                        : s.error?.slice(0, 50) ?? s.status.toUpperCase()}
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      )}

      {hc && (
        <Card>
          <CardHeader className="pb-2 flex-row items-center justify-between">
            <CardTitle className="text-base">Плагины · {hc.plugins.length} модулей</CardTitle>
            <Badge variant="outline">{hc.summary.plugins_ok}/{hc.summary.plugins_total} OK</Badge>
          </CardHeader>
          <CardContent>
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-2">
              {hc.plugins.map((p) => (
                <div key={p.name} className="flex items-center justify-between rounded-md border px-3 py-2 text-sm">
                  <div className="flex items-center gap-2 min-w-0">
                    <div className={`w-2 h-2 rounded-full ${statusColor(p.status)} shrink-0`} />
                    <span className="font-mono text-xs truncate" title={p.name}>{p.name}</span>
                  </div>
                  <div className="text-[10px] text-muted-foreground shrink-0 ml-2">
                    {p.durationMs}ms
                  </div>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      )}

      <GptunnelBalanceCard />

      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        <BigStat label="События / 24ч" value={data.events.total} color="emerald" />
        <BigStat label="Лиды всего" value={data.leads.total} color="indigo" />
        <BigStat label="Шаблоны" value={data.templates.top.length} color="violet" hint="(топ-5)" />
        <BigStat label="Плагины" value={`${data.plugins.active}/${data.plugins.total}`} color="amber" hint={`failed: ${data.plugins.failed}`} />
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Топ событий за 24ч</CardTitle>
        </CardHeader>
        <CardContent style={{ height: 220 }}>
          {eventsChart.length === 0 ? (
            <div className="text-muted-foreground text-sm py-6 text-center">Событий пока нет</div>
          ) : (
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={eventsChart} margin={{ top: 5, right: 10, left: 0, bottom: 5 }}>
                <XAxis dataKey="name" tick={{ fontSize: 10 }} angle={-15} textAnchor="end" height={60} />
                <YAxis tick={{ fontSize: 10 }} allowDecimals={false} />
                <Tooltip cursor={{ fill: "rgba(0,0,0,0.05)" }} />
                <Bar dataKey="count" radius={[4, 4, 0, 0]}>
                  {eventsChart.map((_, i) => (
                    <Cell key={i} fill={`hsl(${(160 + i * 30) % 360}, 70%, 50%)`} />
                  ))}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          )}
        </CardContent>
      </Card>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Агенты · 24ч</CardTitle>
          </CardHeader>
          <CardContent>
            {Object.keys(data.agents).length === 0 ? (
              <div className="text-muted-foreground text-sm py-6 text-center">Агенты пока не активны</div>
            ) : (
              <table className="w-full text-sm">
                <thead className="text-xs text-muted-foreground">
                  <tr><th className="text-left">Агент</th><th>OK</th><th>Failed</th><th>Pending</th></tr>
                </thead>
                <tbody>
                  {Object.entries(data.agents).map(([name, s]) => (
                    <tr key={name} className="border-t">
                      <td className="py-1.5 font-mono text-xs">{name}</td>
                      <td className="text-center text-emerald-500">{s.executed}</td>
                      <td className={`text-center ${s.failed > 0 ? "text-rose-500 font-bold" : ""}`}>{s.failed}</td>
                      <td className="text-center text-amber-500">{s.pending}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-base">Лиды по статусу</CardTitle>
          </CardHeader>
          <CardContent>
            {data.leads.total === 0 ? (
              <div className="text-muted-foreground text-sm py-6 text-center">Лидов пока нет</div>
            ) : (
              <div className="space-y-2">
                {Object.entries(data.leads.byStatus).map(([s, c]) => {
                  const pct = Math.round((c / data.leads.total) * 100);
                  return (
                    <div key={s}>
                      <div className="flex justify-between text-xs mb-1">
                        <span className="capitalize">{s}</span>
                        <span className="font-mono">{c} <span className="text-muted-foreground">({pct}%)</span></span>
                      </div>
                      <Progress value={pct} className="h-2" />
                    </div>
                  );
                })}
              </div>
            )}
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Последние генерации</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="text-xs space-y-1.5">
            {data.generations.recent.length === 0 ? (
              <div className="text-muted-foreground py-3 text-center">Генераций пока нет</div>
            ) : (
              data.generations.recent.slice(0, 12).map((g) => (
                <div key={g.id} className="flex items-center justify-between rounded border px-2 py-1.5">
                  <div className="flex items-center gap-2">
                    <span className="font-mono text-xs">#{g.id}</span>
                    <Badge variant="outline" className="text-[10px]">{g.type}</Badge>
                  </div>
                  <Badge
                    variant={g.status === "done" ? "default" : g.status === "error" ? "destructive" : "outline"}
                    className="text-[10px]"
                  >
                    {g.status}
                  </Badge>
                </div>
              ))
            )}
          </div>
        </CardContent>
      </Card>

      {/* ANTHEM ONE-CLICK */}
      <Card className="border-violet-500/60 bg-gradient-to-br from-violet-600/20 via-fuchsia-500/10 to-transparent">
        <CardContent className="p-5 flex flex-col sm:flex-row items-start sm:items-center justify-between gap-3">
          <div>
            <div className="text-lg font-bold flex items-center gap-2">
              👑 Запустить Гимн MUZIAI v304
              <Badge className="bg-violet-600">официальный</Badge>
            </div>
            <div className="text-xs text-muted-foreground mt-1">
              Один клик. Через 1–2 минуты MP3 в /dashboard.
            </div>
          </div>
          <AnthemRunner />
        </CardContent>
      </Card>

      <DebugBatchCard />
    </div>
  );
}

function DebugRow({ it, onRecovered }: { it: any; onRecovered: () => void }) {
  const { toast } = useToast();
  const recoverable = it.status === "error"
    && it.sunoFresh?.firstTrackStatus === "succeeded"
    && it.sunoFreshStatus === 200;
  const recover = useMutation({
    mutationFn: async () => {
      const r = await apiRequest("POST", `/api/admin/v304/generations/${it.id}/recover-from-suno`, {});
      return r.json();
    },
    onSuccess: (j) => {
      const d = j.data;
      if (d?.recovered) {
        toast({ title: `🟢 #${it.id} восстановлен`, description: `audio_url подхвачен, открой /track/${it.id}` });
        onRecovered();
      } else {
        toast({ title: "Recovery невозможен", description: d?.message || "MuziAi не вернул succeeded трек", variant: "destructive" });
      }
    },
    onError: (e: Error) => toast({ title: "Ошибка recover", description: e.message, variant: "destructive" }),
  });
  return (
    <div className={`text-[11px] p-2 rounded border ${
      it.status === "done" ? "border-emerald-500/30 bg-emerald-500/5"
      : it.status === "error" ? "border-rose-500/30 bg-rose-500/5"
      : "border-amber-500/30 bg-amber-500/5"
    }`}>
      <div className="flex items-start justify-between gap-2">
        <div className="font-mono text-white flex-1">
          #{it.id} · status=<b>{it.status}</b> · voiceType={it.voiceType ?? "—"} · cost={it.cost}
        </div>
        {recoverable && (
          <Button
            size="sm"
            variant="outline"
            className="h-6 px-2 text-[10px] border-emerald-500/40 text-emerald-300 hover:bg-emerald-500/10"
            onClick={() => recover.mutate()}
            disabled={recover.isPending}
            data-testid={`btn-recover-${it.id}`}
          >
            {recover.isPending ? "…" : "🟢 Восстановить"}
          </Button>
        )}
      </div>
      {it.prompt && <div className="text-muted-foreground mt-0.5">prompt: {it.prompt}</div>}
      {it.errorReason && <div className="text-rose-300 mt-1">errorReason: {it.errorReason}</div>}
      {it.sunoFresh && (
        <div className="text-cyan-300 mt-1">
          MuziAi HTTP {it.sunoFreshStatus} · status={it.sunoFresh.status} · code={it.sunoFresh.code} · msg={it.sunoFresh.message ?? "—"}
          {it.sunoFresh.firstTrackStatus && ` · firstTrack=${it.sunoFresh.firstTrackStatus}`}
        </div>
      )}
      {it.sunoFreshError && <div className="text-rose-300 mt-1">network: {it.sunoFreshError}</div>}
      {!it.exists && <div className="text-rose-300 mt-1">генерация не существует в БД</div>}
    </div>
  );
}

// DebugBatchCard — прямо в UI вводишь диапазон или CSV ID, видишь raw
// Suno-ответ + DB-статус для каждого. Закрывает кейс «нет консоли в браузере».
function DebugBatchCard() {
  const { toast } = useToast();
  const [input, setInput] = useState("672-679");
  const [output, setOutput] = useState<any>(null);

  const parseIds = (s: string): number[] => {
    const out = new Set<number>();
    for (const part of s.split(",")) {
      const t = part.trim();
      if (!t) continue;
      const m = t.match(/^(\d+)\s*-\s*(\d+)$/);
      if (m) {
        const a = parseInt(m[1], 10), b = parseInt(m[2], 10);
        if (a <= b) for (let i = a; i <= b; i++) out.add(i);
      } else {
        const n = parseInt(t, 10);
        if (Number.isFinite(n)) out.add(n);
      }
    }
    return Array.from(out).slice(0, 50);
  };

  const run = useMutation({
    mutationFn: async () => {
      const ids = parseIds(input);
      if (ids.length === 0) throw new Error("Не распознал ID. Формат: 672-679 или 672,673,675");
      const r = await apiRequest("POST", "/api/admin/v304/generations/debug-batch", { ids });
      return r.json();
    },
    onSuccess: (j) => setOutput(j.data),
    onError: (e: Error) => toast({ title: "Ошибка", description: e.message, variant: "destructive" }),
  });

  return (
    <Card className="border-rose-500/30 bg-gradient-to-br from-rose-500/5 to-transparent">
      <CardHeader>
        <CardTitle className="text-base flex items-center gap-2">
          🔬 Диагностика генераций (batch)
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="text-xs text-muted-foreground">
          Введи диапазон («672-679») или CSV («672,673,675»). До 50 ID за раз.
          Получишь DB-статус + свежий ответ MuziAi для каждого.
        </div>
        <div className="flex gap-2">
          <input
            type="text"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder="672-679"
            className="flex-1 px-3 py-2 text-sm rounded-lg bg-background/50 border border-white/10"
            data-testid="input-debug-ids"
          />
          <Button onClick={() => run.mutate()} disabled={run.isPending} variant="outline">
            {run.isPending ? "Опрашиваю MuziAi…" : "Проверить"}
          </Button>
        </div>
        {output && (
          <div className="space-y-2">
            <div className="text-xs text-muted-foreground">
              Найдено: {output.count}. Успешные = «firstTrackStatus:succeeded», ошибки — поле «errorReason» или «sunoFresh.message».
            </div>
            <div className="space-y-1 max-h-[500px] overflow-y-auto">
              {output.items?.map((it: any) => <DebugRow key={it.id} it={it} onRecovered={() => run.mutate()} />)}
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function AnthemRunner() {
  const { toast } = useToast();
  const [, navigate] = useLocation();
  const run = useMutation({
    mutationFn: async () => {
      const r = await apiRequest("POST", "/api/admin/v304/generate-anthem", {});
      return r.json();
    },
    onSuccess: (j) => {
      const d = j.data;
      toast({
        title: "🎵 Гимн отправлен в MuziAi",
        description: `gen #${d.generationId}, taskId ${(d.taskId || "").slice(0, 12)}…  Откроется через секунду.`,
      });
      setTimeout(() => navigate(`/track/${d.generationId}`), 1500);
    },
    onError: (e: Error) => {
      toast({
        title: "Не удалось запустить гимн",
        description: e.message,
        variant: "destructive",
      });
    },
  });

  const revive = useMutation({
    mutationFn: async () => {
      const r = await apiRequest("POST", "/api/admin/v304/anthem/revive", {});
      return r.json();
    },
    onSuccess: (j) => {
      const d = j.data;
      if (!d?.found) {
        toast({ title: "Гимны ещё не запускались", description: "Сначала нажми 🎵 Запустить гимн" });
        return;
      }
      const status = d.status as string;
      if (status === "done") {
        toast({
          title: d.recoveredFromError ? "🟢 Гимн восстановлен из error" : "✅ Гимн готов",
          description: d.recoveredFromError
            ? `gen #${d.generationId} был помечен error по таймауту, но MuziAi реально вернул трек — recovery успешен. Открываю…`
            : `gen #${d.generationId} — открываю…`,
        });
        setTimeout(() => navigate(`/track/${d.generationId}`), 800);
      } else if (status === "error") {
        toast({
          title: "❌ Гимн упал в error",
          description: d.errorReason || "MuziAi вернул ошибку. Запусти новый.",
          variant: "destructive",
        });
      } else {
        toast({
          title: "⏳ MuziAi ещё работает",
          description: `gen #${d.generationId} в processing — открываю страницу с авто-опросом.`,
        });
        setTimeout(() => navigate(`/track/${d.generationId}`), 800);
      }
    },
    onError: (e: Error) => {
      toast({ title: "Не удалось проверить", description: e.message, variant: "destructive" });
    },
  });

  return (
    <div className="flex flex-wrap gap-2">
      <Button
        size="lg"
        onClick={() => run.mutate()}
        disabled={run.isPending}
        className="bg-violet-600 hover:bg-violet-700"
      >
        {run.isPending ? "Отправляю…" : "🎵 Запустить гимн"}
      </Button>
      <Button
        size="lg"
        variant="outline"
        onClick={() => revive.mutate()}
        disabled={revive.isPending}
      >
        {revive.isPending ? "Опрашиваю MuziAi…" : "🚑 Реанимировать последний"}
      </Button>
    </div>
  );
}

// ============================================================
// Secrets tab — простая ротация ключей с verify
// ============================================================
type SecretRow = {
  key: string;
  name: string;
  description: string;
  verifiable: boolean;
  present: boolean;
  masked: { length: number; first8: string; hasLeadingSpace: boolean } | null;
};

function SecretsTab({ toast }: { toast: any }) {
  const { data, isLoading } = useQuery({
    queryKey: ["admin-secrets"],
    queryFn: () => fetcher<SecretRow[]>("/api/admin/v304/secrets"),
    refetchInterval: 60000,
  });
  const runtime = useQuery({
    queryKey: ["admin-runtime-check"],
    queryFn: () => fetcher<{
      pid: number;
      uptime_sec: number;
      desynced: string[];
      compare: Array<{ key: string; file: { length: number; first8: string }; runtime: { length: number; first8: string }; synced: boolean }>;
    }>("/api/admin/v304/secrets/runtime-check"),
    refetchInterval: 30000,
  });
  const [editKey, setEditKey] = useState<string | null>(null);
  const [editValue, setEditValue] = useState("");

  const restartPm2 = useMutation({
    mutationFn: async () => {
      const r = await apiRequest("POST", "/api/admin/v304/secrets/restart", {});
      return r.json();
    },
    onSuccess: () => {
      toast({ title: "Рестарт запланирован", description: "pm2 подхватит .env через ~2 секунды" });
      setTimeout(() => {
        queryClient.invalidateQueries({ queryKey: ["admin-runtime-check"] });
      }, 4000);
    },
    onError: (e: Error) => toast({ title: "Ошибка рестарта", description: e.message, variant: "destructive" }),
  });

  const testSuno = useMutation({
    mutationFn: async () => {
      const r = await apiRequest("POST", "/api/admin/v304/secrets/test-suno", {});
      return r.json();
    },
    onSuccess: (j) => {
      const d = j.data;
      const r = d.runtime;
      const v = r?.ok;
      toast({
        title: v ? "✅ Suno create OK" : "❌ Suno create FAIL",
        description: `runtime status=${r?.httpStatus ?? "?"} ${r?.message ?? r?.error ?? d.hint ?? ""}`,
        variant: v ? "default" : "destructive",
      });
    },
    onError: (e: Error) => toast({ title: "Ошибка test-suno", description: e.message, variant: "destructive" }),
  });

  const upsert = useMutation({
    mutationFn: async ({ key, value }: { key: string; value: string }) => {
      const r = await apiRequest("PUT", "/api/admin/v304/secrets", { key, value, restart: true });
      return r.json();
    },
    onSuccess: (j, vars) => {
      const m = j.data.masked;
      toast({
        title: `${vars.key} сохранён`,
        description: `length=${m.length}, first8=${m.first8}${m.hasLeadingSpace ? " ⚠ ВЕДУЩИЙ ПРОБЕЛ" : ""}. Audit #${j.data.auditId}. Сервер перезапускается…`,
      });
      setEditKey(null);
      setEditValue("");
      // pm2 restart ~ 2-3 сек, дадим time + invalidate
      setTimeout(() => queryClient.invalidateQueries({ queryKey: ["admin-secrets"] }), 4000);
    },
    onError: (e: Error) => toast({ title: "Ошибка", description: e.message, variant: "destructive" }),
  });

  const verify = useMutation({
    mutationFn: async (key: string) => {
      const r = await apiRequest("POST", "/api/admin/v304/secrets/verify", { key });
      return r.json();
    },
    onSuccess: (j, key) => {
      const v = j.data.verified;
      const status = v === true ? "✅ работает" : v === false ? "❌ не валиден" : "ℹ️ verify не поддерживается";
      toast({
        title: `${key}: ${status}`,
        description: j.data.hint || j.data.message || j.data.responsePreview?.slice(0, 80) || "",
        variant: v === false ? "destructive" : "default",
      });
    },
    onError: (e: Error) => toast({ title: "Ошибка verify", description: e.message, variant: "destructive" }),
  });

  if (isLoading) return <div>Загрузка…</div>;

  const desyncedCount = runtime.data?.desynced?.length ?? 0;
  const isDesynced = desyncedCount > 0;

  return (
    <div className="space-y-4">
      {/* RUNTIME SYNC STATUS */}
      <Card className={isDesynced ? "border-amber-500/60 bg-amber-500/5" : "border-emerald-500/40 bg-emerald-500/5"}>
        <CardContent className="p-3">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="text-sm">
              {isDesynced ? (
                <>
                  <span className="font-bold text-amber-500">⚠ Runtime ≠ .env</span>
                  <span className="text-muted-foreground"> — pm2 ещё не подхватил свежие значения для: </span>
                  <span className="font-mono text-xs">{runtime.data?.desynced.join(", ")}</span>
                </>
              ) : (
                <>
                  <span className="font-bold text-emerald-500">✅ Runtime = .env</span>
                  <span className="text-muted-foreground"> — все секреты синхронизированы</span>
                </>
              )}
              {runtime.data && (
                <span className="text-xs text-muted-foreground ml-2">
                  (pid {runtime.data.pid}, uptime {runtime.data.uptime_sec}s)
                </span>
              )}
            </div>
            <div className="flex gap-2">
              <Button
                size="sm"
                variant={isDesynced ? "default" : "outline"}
                onClick={() => restartPm2.mutate()}
                disabled={restartPm2.isPending}
              >
                {restartPm2.isPending ? "Рестарт…" : "🔄 Restart pm2"}
              </Button>
              <Button
                size="sm"
                variant="outline"
                onClick={() => testSuno.mutate()}
                disabled={testSuno.isPending}
              >
                {testSuno.isPending ? "Тестирую…" : "🎵 Test Suno create"}
              </Button>
            </div>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardContent className="text-xs text-muted-foreground p-3 space-y-1">
          <div>🔒 <b>Безопасность.</b> Значение секрета передаётся по TLS, пишется в <code>/var/www/neurohub/.env</code> с правами 600. В audit — только факт + длина.</div>
          <div>⚡ <b>Авто-trim.</b> Ведущие/висящие пробелы и кавычки снимаются — PITFALLS #12.</div>
          <div>🔄 <b>Авто-restart.</b> После save через ~1 сек pm2 рестарт + source .env (читает свежие значения, не кэш).</div>
          <div>🧪 <b>Verify.</b> GET /v1/balance — проверяет, что аккаунт жив.</div>
          <div>🎵 <b>Test Suno create.</b> Реальный POST /v1/media/create с минимальным payload — проверяет media-scope ключа. Это то, что использует /api/music/generate.</div>
        </CardContent>
      </Card>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        {data?.map((s) => (
          <Card key={s.key}>
            <CardHeader className="pb-2">
              <CardTitle className="text-base flex items-center gap-2">
                {s.name}
                {s.present ? (
                  <Badge variant="default">установлен</Badge>
                ) : (
                  <Badge variant="outline">пусто</Badge>
                )}
                {s.masked?.hasLeadingSpace && <Badge variant="destructive">⚠ ПРОБЕЛ</Badge>}
              </CardTitle>
              <div className="text-xs text-muted-foreground">{s.description}</div>
              <div className="text-xs font-mono">
                {s.present
                  ? `length=${s.masked?.length}, first8=${s.masked?.first8}…`
                  : "—"}
              </div>
            </CardHeader>
            <CardContent className="pt-2 space-y-2">
              {editKey === s.key ? (
                <>
                  <Input
                    type="password"
                    autoComplete="off"
                    placeholder="Новое значение (без кавычек, без пробелов в начале)"
                    value={editValue}
                    onChange={(e) => setEditValue(e.target.value)}
                  />
                  <div className="flex gap-2">
                    <Button
                      size="sm"
                      onClick={() => upsert.mutate({ key: s.key, value: editValue })}
                      disabled={!editValue || upsert.isPending}
                    >
                      {upsert.isPending ? "Сохраняю…" : "Сохранить + рестарт"}
                    </Button>
                    <Button size="sm" variant="outline" onClick={() => { setEditKey(null); setEditValue(""); }}>
                      Отмена
                    </Button>
                  </div>
                </>
              ) : (
                <div className="flex flex-wrap gap-2">
                  <Button size="sm" onClick={() => { setEditKey(s.key); setEditValue(""); }}>
                    {s.present ? "Обновить" : "Установить"}
                  </Button>
                  {s.verifiable && s.present && (
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => verify.mutate(s.key)}
                      disabled={verify.isPending}
                    >
                      {verify.isPending && verify.variables === s.key ? "Проверяю…" : "🧪 Проверить"}
                    </Button>
                  )}
                </div>
              )}
            </CardContent>
          </Card>
        ))}
      </div>
    </div>
  );
}

// ============================================================
// Templates tab
// ============================================================
function TemplatesTab({ toast }: { toast: any }) {
  const { data, isLoading } = useQuery({
    queryKey: ["admin-templates"],
    queryFn: () => fetcher<Template[]>("/api/admin/v304/templates"),
  });
  const [edit, setEdit] = useState<Partial<Template> | null>(null);

  const upsert = useMutation({
    mutationFn: async (t: Partial<Template>) => {
      const r = await apiRequest("PUT", "/api/admin/v304/templates", {
        slug: t.slug,
        name: t.name,
        category: t.category,
        description: t.description,
        promptTemplate: t.promptTemplate,
        style: t.style,
        recommendedBpm: t.recommendedBpm,
        recommendedKey: t.recommendedKey,
        active: t.active === 1,
      });
      return r.json();
    },
    onSuccess: (j) => {
      toast({ title: "Сохранено", description: `Backup audit #${j.data.auditId}` });
      setEdit(null);
      queryClient.invalidateQueries({ queryKey: ["admin-templates"] });
    },
    onError: (e: Error) => toast({ title: "Ошибка", description: e.message, variant: "destructive" }),
  });

  const remove = useMutation({
    mutationFn: async (slug: string) => {
      const r = await apiRequest("DELETE", `/api/admin/v304/templates/${slug}`);
      return r.json();
    },
    onSuccess: (j) => {
      toast({ title: "Деактивирован", description: `Backup audit #${j.data.auditId}` });
      queryClient.invalidateQueries({ queryKey: ["admin-templates"] });
    },
    onError: (e: Error) => toast({ title: "Ошибка", description: e.message, variant: "destructive" }),
  });

  if (isLoading) return <div>Загрузка…</div>;
  return (
    <div className="space-y-4">
      <Button onClick={() => setEdit({ active: 1 })}>+ Новый шаблон</Button>
      {edit && (
        <Card>
          <CardHeader>
            <CardTitle>{edit.slug ? `Редактировать: ${edit.slug}` : "Новый шаблон"}</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <div>
              <Label>Slug *</Label>
              <Input value={edit.slug ?? ""} onChange={(e) => setEdit({ ...edit, slug: e.target.value })} placeholder="например: party-pop" />
            </div>
            <div>
              <Label>Название *</Label>
              <Input value={edit.name ?? ""} onChange={(e) => setEdit({ ...edit, name: e.target.value })} />
            </div>
            <div>
              <Label>Категория</Label>
              <Input value={edit.category ?? ""} onChange={(e) => setEdit({ ...edit, category: e.target.value })} />
            </div>
            <div>
              <Label>Описание</Label>
              <Input value={edit.description ?? ""} onChange={(e) => setEdit({ ...edit, description: e.target.value })} />
            </div>
            <div>
              <Label>Prompt template</Label>
              <Textarea value={edit.promptTemplate ?? ""} onChange={(e) => setEdit({ ...edit, promptTemplate: e.target.value })} rows={6} />
            </div>
            <div>
              <Label>Style</Label>
              <Input value={edit.style ?? ""} onChange={(e) => setEdit({ ...edit, style: e.target.value })} />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <Label>BPM</Label>
                <Input type="number" value={edit.recommendedBpm ?? ""} onChange={(e) => setEdit({ ...edit, recommendedBpm: parseInt(e.target.value) || undefined })} />
              </div>
              <div>
                <Label>Key</Label>
                <Input value={edit.recommendedKey ?? ""} onChange={(e) => setEdit({ ...edit, recommendedKey: e.target.value })} />
              </div>
            </div>
            <div className="flex items-center gap-2">
              <Switch checked={edit.active === 1} onCheckedChange={(c) => setEdit({ ...edit, active: c ? 1 : 0 })} />
              <Label>Активен</Label>
            </div>
            <div className="flex gap-2">
              <Button onClick={() => upsert.mutate(edit)} disabled={!edit.slug || !edit.name || upsert.isPending}>
                {upsert.isPending ? "Сохраняю…" : "Сохранить"}
              </Button>
              <Button variant="outline" onClick={() => setEdit(null)}>Отмена</Button>
            </div>
          </CardContent>
        </Card>
      )}
      <Card>
        <CardContent className="p-0">
          <table className="w-full text-sm">
            <thead className="bg-muted text-xs">
              <tr><th className="text-left p-2">Slug</th><th className="text-left p-2">Название</th><th className="p-2">Категория</th><th className="p-2">BPM</th><th className="p-2">Active</th><th></th></tr>
            </thead>
            <tbody>
              {data?.map((t) => (
                <tr key={t.slug} className="border-t">
                  <td className="p-2 font-mono">{t.slug}</td>
                  <td className="p-2">{t.name}</td>
                  <td className="p-2 text-center">{t.category}</td>
                  <td className="p-2 text-center">{t.recommendedBpm}</td>
                  <td className="p-2 text-center">{t.active === 1 ? "✅" : "—"}</td>
                  <td className="p-2 text-right space-x-1">
                    <Button size="sm" variant="outline" onClick={() => setEdit(t)}>edit</Button>
                    {t.active === 1 && <Button size="sm" variant="outline" onClick={() => remove.mutate(t.slug)}>off</Button>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </CardContent>
      </Card>
    </div>
  );
}

// ============================================================
// Flags tab
// ============================================================
function FlagsTab({ toast }: { toast: any }) {
  const { data, isLoading } = useQuery({
    queryKey: ["admin-flags"],
    queryFn: () => fetcher<Flag[]>("/api/admin/v304/flags"),
  });
  const [edit, setEdit] = useState<Partial<Flag> | null>(null);

  const upsert = useMutation({
    mutationFn: async (f: Partial<Flag>) => {
      const r = await apiRequest("PUT", "/api/admin/v304/flags", {
        key: f.key,
        enabled: f.enabled === 1,
        rolloutPercent: f.rolloutPercent ?? 100,
        description: f.description,
      });
      return r.json();
    },
    onSuccess: (j) => {
      toast({ title: "Сохранено", description: `Backup audit #${j.data.auditId ?? "—"}` });
      setEdit(null);
      queryClient.invalidateQueries({ queryKey: ["admin-flags"] });
    },
    onError: (e: Error) => toast({ title: "Ошибка", description: e.message, variant: "destructive" }),
  });

  if (isLoading) return <div>Загрузка…</div>;
  return (
    <div className="space-y-4">
      <Button onClick={() => setEdit({ enabled: 0, rolloutPercent: 100 })}>+ Новый флаг</Button>
      {edit && (
        <Card>
          <CardHeader><CardTitle>{edit.key ? edit.key : "Новый флаг"}</CardTitle></CardHeader>
          <CardContent className="space-y-3">
            <div><Label>Key *</Label>
              <Input value={edit.key ?? ""} onChange={(e) => setEdit({ ...edit, key: e.target.value })} placeholder="ff_some_feature" />
            </div>
            <div className="flex items-center gap-2">
              <Switch checked={edit.enabled === 1} onCheckedChange={(c) => setEdit({ ...edit, enabled: c ? 1 : 0 })} />
              <Label>Включён</Label>
            </div>
            <div><Label>Rollout %</Label>
              <Input type="number" min={0} max={100} value={edit.rolloutPercent ?? 100} onChange={(e) => setEdit({ ...edit, rolloutPercent: parseInt(e.target.value) || 0 })} />
            </div>
            <div><Label>Описание</Label>
              <Input value={edit.description ?? ""} onChange={(e) => setEdit({ ...edit, description: e.target.value })} />
            </div>
            <div className="flex gap-2">
              <Button onClick={() => upsert.mutate(edit)} disabled={!edit.key || upsert.isPending}>Сохранить</Button>
              <Button variant="outline" onClick={() => setEdit(null)}>Отмена</Button>
            </div>
          </CardContent>
        </Card>
      )}
      <Card>
        <CardContent className="p-0">
          <table className="w-full text-sm">
            <thead className="bg-muted text-xs">
              <tr><th className="text-left p-2">Key</th><th className="p-2">Enabled</th><th className="p-2">Rollout</th><th className="text-left p-2">Описание</th><th></th></tr>
            </thead>
            <tbody>
              {data?.map((f) => (
                <tr key={f.key} className="border-t">
                  <td className="p-2 font-mono">{f.key}</td>
                  <td className="p-2 text-center">{f.enabled === 1 ? "✅" : "—"}</td>
                  <td className="p-2 text-center">{f.rolloutPercent}%</td>
                  <td className="p-2 text-xs text-muted-foreground">{f.description}</td>
                  <td className="p-2 text-right">
                    <Button size="sm" variant="outline" onClick={() => setEdit(f)}>edit</Button>
                  </td>
                </tr>
              ))}
              {(data?.length ?? 0) === 0 && (
                <tr><td colSpan={5} className="text-center text-muted-foreground p-4">Флагов пока нет — создай первый.</td></tr>
              )}
            </tbody>
          </table>
        </CardContent>
      </Card>
    </div>
  );
}

// ============================================================
// Leads tab
// ============================================================
function LeadsTab({ toast }: { toast: any }) {
  const { data, isLoading } = useQuery({
    queryKey: ["admin-leads"],
    queryFn: () => fetcher<Lead[]>("/api/admin/v304/leads?limit=200"),
  });

  const patch = useMutation({
    mutationFn: async ({ id, body }: { id: number; body: any }) => {
      const r = await apiRequest("PATCH", `/api/admin/v304/leads/${id}`, body);
      return r.json();
    },
    onSuccess: (j) => {
      toast({ title: "Изменено", description: `Backup audit #${j.data.auditId}` });
      queryClient.invalidateQueries({ queryKey: ["admin-leads"] });
    },
    onError: (e: Error) => toast({ title: "Ошибка", description: e.message, variant: "destructive" }),
  });

  if (isLoading) return <div>Загрузка…</div>;
  return (
    <Card>
      <CardContent className="p-0 overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="bg-muted text-xs">
            <tr>
              <th className="p-2">ID</th>
              <th className="text-left p-2">Email / fp</th>
              <th className="p-2">Score</th>
              <th className="p-2">Status</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {data?.map((l) => (
              <tr key={l.id} className="border-t">
                <td className="p-2 text-center">#{l.id}</td>
                <td className="p-2 truncate max-w-xs">{l.email ?? l.fingerprint?.slice(0, 12)}</td>
                <td className="p-2 text-center">{l.score}</td>
                <td className="p-2 text-center">
                  <Badge variant={l.status === "converted" ? "default" : "outline"}>{l.status}</Badge>
                </td>
                <td className="p-2 text-right space-x-1">
                  {["new", "engaged", "converted", "dead"]
                    .filter((s) => s !== l.status)
                    .map((s) => (
                      <Button key={s} size="sm" variant="outline" onClick={() => patch.mutate({ id: l.id, body: { status: s } })}>
                        → {s}
                      </Button>
                    ))}
                </td>
              </tr>
            ))}
            {(data?.length ?? 0) === 0 && (
              <tr><td colSpan={5} className="text-center text-muted-foreground p-4">Лидов пока нет.</td></tr>
            )}
          </tbody>
        </table>
      </CardContent>
    </Card>
  );
}

// ============================================================
// Audit tab — список + restore
// ============================================================
function AuditTab({ toast }: { toast: any }) {
  const { data, isLoading } = useQuery({
    queryKey: ["admin-audit"],
    queryFn: () => fetcher<AuditEntry[]>("/api/admin/v304/audit?limit=100"),
    refetchInterval: 30000,
  });

  const restore = useMutation({
    mutationFn: async (id: number) => {
      const r = await apiRequest("POST", `/api/admin/v304/audit/${id}/restore`, {});
      return r.json();
    },
    onSuccess: (j) => {
      toast({ title: "Восстановлено", description: `Новый audit #${j.data.newAuditId}` });
      queryClient.invalidateQueries({ queryKey: ["admin-audit"] });
      queryClient.invalidateQueries({ queryKey: ["admin-templates"] });
      queryClient.invalidateQueries({ queryKey: ["admin-flags"] });
      queryClient.invalidateQueries({ queryKey: ["admin-leads"] });
    },
    onError: (e: Error) => toast({ title: "Ошибка", description: e.message, variant: "destructive" }),
  });

  if (isLoading) return <div>Загрузка…</div>;
  return (
    <Card>
      <CardContent className="p-0 overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="bg-muted text-xs">
            <tr>
              <th className="p-2">#</th>
              <th className="text-left p-2">Время</th>
              <th className="p-2">Кто</th>
              <th className="p-2">Действие</th>
              <th className="p-2">Сущность</th>
              <th className="text-left p-2">Ключ</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {data?.map((a) => (
              <tr key={a.id} className="border-t">
                <td className="p-2 text-center font-mono text-xs">{a.id}</td>
                <td className="p-2 text-xs">{new Date(a.createdAt).toLocaleString("ru-RU")}</td>
                <td className="p-2 text-xs">{a.adminEmail ?? "—"}</td>
                <td className="p-2 text-center">
                  <Badge variant={a.action === "delete" ? "destructive" : "outline"}>{a.action}</Badge>
                </td>
                <td className="p-2 text-center text-xs">{a.entity}</td>
                <td className="p-2 font-mono text-xs">{a.entityKey}</td>
                <td className="p-2 text-right">
                  {a.beforeJson && a.action !== "restore" && (
                    <Button size="sm" variant="outline" onClick={() => restore.mutate(a.id)}>
                      ↶ restore
                    </Button>
                  )}
                </td>
              </tr>
            ))}
            {(data?.length ?? 0) === 0 && (
              <tr><td colSpan={7} className="text-center text-muted-foreground p-4">Audit log пуст — никаких редакций пока не было.</td></tr>
            )}
          </tbody>
        </table>
      </CardContent>
    </Card>
  );
}
