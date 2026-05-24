// Eugene 2026-05-23 Босс «Оркестратор нужен всеми компаниями агентами начать
// в проекте — коде».
//
// Eugene 2026-05-24 Босс «Оркестратор переименуем Музa Директор. Он контролирует
// всех агентов, собирает всю информацию, итоговую докладывает через аудио».
// Display name: «🎬 Музa Директор». Технический термин «orchestrator» остаётся
// в endpoint URLs / file names (backward compat).
//
// Admin-вкладка «🎬 Музa Директор» — единая визуализация всех зарегистрированных
// agents (channels / personas / watchdogs / cron / internal) + voice report.
//
// Источник данных:
//   GET /api/admin/v304/orchestrator/agents — list + summary
//   GET /api/admin/v304/orchestrator/health — run healthCheckAll
//   GET /api/admin/v304/director/voice-report?period=today — итоговый аудио-доклад
//
// Управление start/stop/restart НЕ предоставляется — info-only panel.
// Brand-style: glass-card + brand gradient palette из CLAUDE.md.

import { useEffect, useState, useMemo } from "react";

type Status = "active" | "paused" | "error" | "not_configured";

interface Agent {
  id: string;
  name: string;
  channel: string;
  role: string;
  persona_key: string | null;
  status: Status;
  capabilities: string[];
  lastSeenAt: number | null;
  lastSeenAgo: number | null;
  metadata: Record<string, unknown> | null;
  hasHealthProbe: boolean;
  lastHealth: { ok: boolean; details?: unknown; durationMs: number; checkedAt: number } | null;
}

interface Summary {
  total: number;
  byStatus: Record<Status, number>;
  byChannel: Record<string, number>;
  byRole: Record<string, number>;
}

interface Edge {
  from: string;
  to: string;
  type: string;
  config?: Record<string, unknown>;
  createdAt: number;
  lastUsedAt?: number;
  usageCount?: number;
}

interface MarketingCampaign {
  id: string;
  name: string;
  channels: string[];
  segment: string;
  status: string;
  createdAt: number;
  startedAt?: number;
  createdBy: string;
  variants: Array<{ key: string; content: string; share: number; sent: number; opened: number; clicked: number; converted: number }>;
  metrics: { targetSize: number; sent: number; opened: number; clicked: number; converted: number; revenue: number; updatedAt: number };
  meta?: Record<string, unknown>;
}

interface MarketingStats {
  campaigns: { total: number; byStatus: Record<string, number> };
  calendar: { scheduledCount: number; nextScheduledAt: number | null };
  performance: {
    windowStart: number;
    windowEnd: number;
    byChannel: Record<string, { campaigns: number; sent: number; opened: number; clicked: number; converted: number; revenue: number }>;
    totals: { campaigns: number; sent: number; opened: number; clicked: number; converted: number; revenue: number; openRate: number; clickRate: number; conversionRate: number };
  };
}

const CHANNEL_LABELS: Record<string, string> = {
  web: "🌐 Web",
  telegram: "✈️ Telegram",
  max: "🅼 Max",
  vk: "🆅 VK",
  email: "📧 Email",
  voice: "🎤 Voice",
  admin: "🛡 Admin",
  cron: "⏰ Cron",
  internal: "⚙️ Internal",
};

const ROLE_LABELS: Record<string, string> = {
  consultant: "💬 Consultant",
  watchdog: "🐕 Watchdog",
  moderator: "🛡 Moderator",
  broadcaster: "📡 Broadcaster",
  diagnostic: "🔬 Diagnostic",
  tool: "🛠 Tool",
};

function statusBadge(status: Status) {
  switch (status) {
    case "active":
      return { label: "🟢 active", cls: "text-emerald-300 bg-emerald-500/10 border-emerald-400/30" };
    case "paused":
      return { label: "🟡 paused", cls: "text-amber-300 bg-amber-500/10 border-amber-400/30" };
    case "error":
      return { label: "🔴 error", cls: "text-red-300 bg-red-500/10 border-red-400/30" };
    case "not_configured":
      return { label: "⚪ not_configured", cls: "text-white/40 bg-white/5 border-white/10" };
    default:
      return { label: status, cls: "text-white/60 bg-white/5 border-white/10" };
  }
}

function relativeTime(ms: number | null): string {
  if (!ms) return "никогда";
  const sec = Math.floor(ms / 1000);
  if (sec < 60) return `${sec} сек назад`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min} мин назад`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr} ч назад`;
  const days = Math.floor(hr / 24);
  return `${days} д назад`;
}

type SubTab = "agents" | "edges" | "marketing";

export default function OrchestratorTab() {
  const [subTab, setSubTab] = useState<SubTab>("agents");
  const [agents, setAgents] = useState<Agent[]>([]);
  const [summary, setSummary] = useState<Summary | null>(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [filterChannel, setFilterChannel] = useState<string>("");
  const [filterRole, setFilterRole] = useState<string>("");
  const [filterStatus, setFilterStatus] = useState<string>("");
  const [healthRunning, setHealthRunning] = useState(false);
  const [healthResult, setHealthResult] = useState<Record<string, { ok: boolean; details?: unknown }> | null>(null);

  // Edges state
  const [edges, setEdges] = useState<Edge[]>([]);
  const [edgesLoading, setEdgesLoading] = useState(false);

  // Marketing state
  const [mktStats, setMktStats] = useState<MarketingStats | null>(null);
  const [mktCampaigns, setMktCampaigns] = useState<MarketingCampaign[]>([]);
  const [mktLoading, setMktLoading] = useState(false);
  const [mktTriggerEvent, setMktTriggerEvent] = useState<string>("payment.succeeded");
  const [mktTriggerPayload, setMktTriggerPayload] = useState<string>('{"userId":1,"amount":39900}');
  const [mktTriggerResult, setMktTriggerResult] = useState<string | null>(null);

  async function load() {
    setLoading(true);
    setErr(null);
    try {
      const p = new URLSearchParams();
      if (filterChannel) p.set("channel", filterChannel);
      if (filterRole) p.set("role", filterRole);
      if (filterStatus) p.set("status", filterStatus);
      const r = await fetch(`/api/admin/v304/orchestrator/agents?${p.toString()}`, { credentials: "include" });
      if (!r.ok) throw new Error(`${r.status}`);
      const j = await r.json();
      setAgents(j.data?.agents || []);
      setSummary(j.data?.summary || null);
    } catch (e: any) {
      setErr(String(e?.message || e));
    } finally {
      setLoading(false);
    }
  }

  async function loadEdges() {
    setEdgesLoading(true);
    try {
      const r = await fetch("/api/admin/v304/orchestrator/edges", { credentials: "include" });
      if (!r.ok) throw new Error(`${r.status}`);
      const j = await r.json();
      setEdges(j.data?.edges || []);
    } catch (e: any) {
      setErr(`edges: ${e?.message || e}`);
    } finally {
      setEdgesLoading(false);
    }
  }

  async function loadMarketing() {
    setMktLoading(true);
    try {
      const [s, c] = await Promise.all([
        fetch("/api/admin/v304/marketing/stats", { credentials: "include" }).then(r => r.json()),
        fetch("/api/admin/v304/marketing/campaigns", { credentials: "include" }).then(r => r.json()),
      ]);
      setMktStats(s.data || null);
      setMktCampaigns(c.data?.campaigns || []);
    } catch (e: any) {
      setErr(`marketing: ${e?.message || e}`);
    } finally {
      setMktLoading(false);
    }
  }

  async function runHealthCheck() {
    setHealthRunning(true);
    try {
      const r = await fetch("/api/admin/v304/orchestrator/health", { credentials: "include" });
      if (!r.ok) throw new Error(`${r.status}`);
      const j = await r.json();
      setHealthResult(j.data?.results || {});
      await load();
    } catch (e: any) {
      setErr(`health check: ${e?.message || e}`);
    } finally {
      setHealthRunning(false);
    }
  }

  async function triggerMarketingEvent() {
    setMktTriggerResult(null);
    try {
      let payload: any = {};
      try { payload = JSON.parse(mktTriggerPayload || "{}"); } catch {
        setMktTriggerResult("⚠ Invalid JSON payload");
        return;
      }
      const r = await fetch("/api/admin/v304/marketing/trigger-event", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ eventName: mktTriggerEvent, payload }),
      });
      const j = await r.json();
      if (!r.ok) {
        setMktTriggerResult(`⚠ ${j.error || r.status}`);
        return;
      }
      setMktTriggerResult(`✓ Event '${mktTriggerEvent}' triggered. Reload campaigns to see auto-created.`);
      await loadMarketing();
    } catch (e: any) {
      setMktTriggerResult(`⚠ ${e?.message || e}`);
    }
  }

  useEffect(() => {
    load();
    const t = setInterval(load, 60_000);
    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filterChannel, filterRole, filterStatus]);

  useEffect(() => {
    if (subTab === "edges") loadEdges();
    if (subTab === "marketing") loadMarketing();
  }, [subTab]);

  const uniqueChannels = useMemo(() => Object.keys(CHANNEL_LABELS), []);
  const uniqueRoles = useMemo(() => Object.keys(ROLE_LABELS), []);

  return (
    <div className="space-y-4 p-2">
      {/* Header + summary */}
      <div className="glass-card rounded-2xl p-4 border border-purple-500/30">
        <div className="flex items-start gap-3">
          <span className="text-3xl">🎬</span>
          <div className="flex-1">
            <h2 className="text-lg font-sans font-bold text-white mb-1">
              <span className="bg-gradient-to-r from-purple-400 via-fuchsia-400 to-cyan-300 bg-clip-text text-transparent">
                Музa Директор
              </span>
            </h2>
            <p className="text-sm font-sans text-muted-foreground leading-relaxed">
              Контролирует всех агентов, собирает всю информацию, докладывает итоги голосом.
              Реестр каналов, персон, watchdog'ов и cron'ов. Один логический agent может
              маскироваться разными persona по каналам (Single-persona-across-channels rule).
            </p>
          </div>
        </div>

        {/* Voice report block */}
        <DirectorVoiceReport />


        {summary && (
          <div className="mt-4 grid grid-cols-2 sm:grid-cols-4 gap-2">
            <div className="rounded-lg bg-white/5 border border-white/10 p-3">
              <div className="text-xs text-muted-foreground">Всего</div>
              <div className="text-2xl font-mono font-bold text-white">{summary.total}</div>
            </div>
            <div className="rounded-lg bg-emerald-500/10 border border-emerald-400/30 p-3">
              <div className="text-xs text-emerald-300">🟢 Active</div>
              <div className="text-2xl font-mono font-bold text-emerald-300">{summary.byStatus.active || 0}</div>
            </div>
            <div className="rounded-lg bg-red-500/10 border border-red-400/30 p-3">
              <div className="text-xs text-red-300">🔴 Error</div>
              <div className="text-2xl font-mono font-bold text-red-300">{summary.byStatus.error || 0}</div>
            </div>
            <div className="rounded-lg bg-white/5 border border-white/10 p-3">
              <div className="text-xs text-white/40">⚪ Not configured</div>
              <div className="text-2xl font-mono font-bold text-white/40">
                {summary.byStatus.not_configured || 0}
              </div>
            </div>
          </div>
        )}
      </div>

      {/* Sub-tabs */}
      <div className="flex flex-wrap gap-2">
        {[
          { id: "agents" as SubTab, label: "🤖 Agents" },
          { id: "edges" as SubTab, label: "🔗 Связи" },
          { id: "marketing" as SubTab, label: "📣 Маркетинг" },
        ].map(t => (
          <button
            key={t.id}
            onClick={() => setSubTab(t.id)}
            className={`px-4 py-1.5 rounded-lg text-sm font-medium transition-all ${
              subTab === t.id
                ? "bg-gradient-to-r from-purple-500 via-fuchsia-500 to-blue-500 text-white shadow-[0_0_16px_rgba(124,58,237,0.45)]"
                : "bg-white/5 border border-purple-400/20 text-white/70 hover:bg-white/10"
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>

      {subTab === "agents" && (
      <>
      {/* Filters + actions */}
      <div className="glass-card rounded-2xl p-3 border border-purple-500/20 flex flex-wrap gap-2 items-center">
        <select
          value={filterChannel}
          onChange={e => setFilterChannel(e.target.value)}
          className="bg-white/5 border border-purple-400/20 text-white rounded-lg px-3 py-1.5 text-sm"
        >
          <option value="">Все каналы</option>
          {uniqueChannels.map(c => (
            <option key={c} value={c}>
              {CHANNEL_LABELS[c] || c}
            </option>
          ))}
        </select>
        <select
          value={filterRole}
          onChange={e => setFilterRole(e.target.value)}
          className="bg-white/5 border border-purple-400/20 text-white rounded-lg px-3 py-1.5 text-sm"
        >
          <option value="">Все роли</option>
          {uniqueRoles.map(r => (
            <option key={r} value={r}>
              {ROLE_LABELS[r] || r}
            </option>
          ))}
        </select>
        <select
          value={filterStatus}
          onChange={e => setFilterStatus(e.target.value)}
          className="bg-white/5 border border-purple-400/20 text-white rounded-lg px-3 py-1.5 text-sm"
        >
          <option value="">Все статусы</option>
          <option value="active">🟢 active</option>
          <option value="paused">🟡 paused</option>
          <option value="error">🔴 error</option>
          <option value="not_configured">⚪ not_configured</option>
        </select>
        <div className="flex-1" />
        <button
          onClick={runHealthCheck}
          disabled={healthRunning}
          className="px-4 py-1.5 rounded-lg bg-gradient-to-r from-purple-500 via-fuchsia-500 to-blue-500 text-white text-sm font-medium shadow-[0_0_16px_rgba(124,58,237,0.35)] hover:shadow-[0_0_24px_rgba(217,70,239,0.45)] transition-shadow disabled:opacity-50"
        >
          {healthRunning ? "⏳ Проверяю..." : "🔬 Запустить health check"}
        </button>
        <button
          onClick={load}
          className="px-3 py-1.5 rounded-lg bg-white/5 border border-purple-400/20 text-white text-sm hover:bg-white/10"
        >
          🔄 Обновить
        </button>
      </div>

      {err && (
        <div className="glass-card rounded-2xl p-3 border border-red-500/30 text-red-300 text-sm">
          ⚠ {err}
        </div>
      )}

      {/* Agents grid */}
      {loading && !agents.length ? (
        <div className="text-white/60 text-sm">Загрузка...</div>
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
          {agents.map(a => {
            const sb = statusBadge(a.status);
            const hr = healthResult?.[a.id] || a.lastHealth;
            return (
              <div
                key={a.id}
                className="glass-card rounded-2xl p-4 border border-purple-500/20 hover:border-fuchsia-500/40 transition-colors"
              >
                <div className="flex items-start justify-between gap-2 mb-2">
                  <div className="flex-1 min-w-0">
                    <div className="text-base font-sans font-bold text-white truncate">{a.name}</div>
                    <div className="text-xs font-mono text-white/40 truncate">{a.id}</div>
                  </div>
                  <span
                    className={`shrink-0 text-[10px] font-mono px-2 py-0.5 rounded-full border ${sb.cls}`}
                  >
                    {sb.label}
                  </span>
                </div>

                <div className="flex flex-wrap gap-1 mb-2">
                  <span className="text-[10px] px-2 py-0.5 rounded-full bg-purple-500/15 text-purple-300 border border-purple-400/20">
                    {CHANNEL_LABELS[a.channel] || a.channel}
                  </span>
                  <span className="text-[10px] px-2 py-0.5 rounded-full bg-cyan-500/15 text-cyan-300 border border-cyan-400/20">
                    {ROLE_LABELS[a.role] || a.role}
                  </span>
                  {a.persona_key && (
                    <span className="text-[10px] px-2 py-0.5 rounded-full bg-fuchsia-500/15 text-fuchsia-300 border border-fuchsia-400/20 truncate max-w-[180px]">
                      🎭 {a.persona_key}
                    </span>
                  )}
                </div>

                {a.capabilities.length > 0 && (
                  <div className="flex flex-wrap gap-1 mb-2">
                    {a.capabilities.map(c => (
                      <span
                        key={c}
                        className="text-[10px] px-1.5 py-0.5 rounded bg-white/5 text-white/60 border border-white/10"
                      >
                        {c}
                      </span>
                    ))}
                  </div>
                )}

                <div className="text-xs text-white/50 space-y-1">
                  <div>
                    <span className="text-white/30">Last seen:</span>{" "}
                    <span className="font-mono">{relativeTime(a.lastSeenAgo)}</span>
                  </div>
                  {a.hasHealthProbe && (
                    <div>
                      <span className="text-white/30">Health probe:</span>{" "}
                      <span className="text-emerald-300/80">✓ available</span>
                    </div>
                  )}
                  {hr && (
                    <div>
                      <span className="text-white/30">Last health:</span>{" "}
                      <span className={hr.ok ? "text-emerald-300" : "text-red-300"}>
                        {hr.ok ? "✓ ok" : "✗ fail"}
                      </span>
                      {hr.details ? (
                        <span className="text-white/40 font-mono ml-1">
                          ({String(hr.details).slice(0, 60)})
                        </span>
                      ) : null}
                    </div>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}

      {!loading && !agents.length && (
        <div className="glass-card rounded-2xl p-8 border border-purple-500/20 text-center text-white/60">
          Нет зарегистрированных agents (после рестарта проверь bootstrapDefaultAgents()).
        </div>
      )}
      </>
      )}

      {/* === EDGES tab === */}
      {subTab === "edges" && (
        <div className="space-y-3">
          <div className="glass-card rounded-2xl p-4 border border-cyan-500/30">
            <div className="flex items-center justify-between gap-2 mb-2">
              <div>
                <h3 className="text-base font-sans font-bold text-white">
                  <span className="bg-gradient-to-r from-cyan-300 via-blue-400 to-purple-400 bg-clip-text text-transparent">
                    Граф связей agent ↔ agent
                  </span>
                </h3>
                <p className="text-xs text-muted-foreground">
                  Описывает ВОЗМОЖНЫЕ связи. Реальный трафик идёт через существующие endpoints / EventBus.
                </p>
              </div>
              <button
                onClick={loadEdges}
                disabled={edgesLoading}
                className="px-3 py-1.5 rounded-lg bg-white/5 border border-cyan-400/20 text-white text-sm hover:bg-white/10"
              >
                {edgesLoading ? "⏳" : "🔄"}
              </button>
            </div>

            {edgesLoading && !edges.length ? (
              <div className="text-white/60 text-sm">Загрузка...</div>
            ) : edges.length === 0 ? (
              <div className="text-white/60 text-sm">Edges не зарегистрированы.</div>
            ) : (
              <div className="space-y-1.5">
                {edges.map((e, i) => (
                  <div
                    key={`${e.from}::${e.to}::${e.type}::${i}`}
                    className="flex flex-wrap items-center gap-2 rounded-lg bg-white/5 border border-white/10 px-3 py-2 text-sm"
                  >
                    <span className="font-mono text-purple-300">{e.from}</span>
                    <span className="text-cyan-300">→</span>
                    <span className="font-mono text-fuchsia-300">{e.to}</span>
                    <span className="text-[10px] px-2 py-0.5 rounded-full bg-cyan-500/15 text-cyan-300 border border-cyan-400/20">
                      {e.type}
                    </span>
                    {e.usageCount && e.usageCount > 0 ? (
                      <span className="text-[10px] text-amber-300 font-mono">used {e.usageCount}×</span>
                    ) : null}
                    {e.config?.purpose ? (
                      <span className="text-xs text-white/50 ml-auto truncate max-w-[280px]">
                        {String(e.config.purpose)}
                      </span>
                    ) : null}
                  </div>
                ))}
              </div>
            )}

            {/* Legend */}
            <div className="mt-3 flex flex-wrap gap-2 text-[10px] text-white/50">
              <span className="px-2 py-0.5 rounded bg-cyan-500/10 border border-cyan-400/20">pair-link</span>
              <span className="px-2 py-0.5 rounded bg-fuchsia-500/10 border border-fuchsia-400/20">broadcast</span>
              <span className="px-2 py-0.5 rounded bg-purple-500/10 border border-purple-400/20">webhook</span>
              <span className="px-2 py-0.5 rounded bg-amber-500/10 border border-amber-400/20">notify</span>
              <span className="px-2 py-0.5 rounded bg-emerald-500/10 border border-emerald-400/20">event</span>
              <span className="px-2 py-0.5 rounded bg-pink-500/10 border border-pink-400/20">campaign</span>
              <span className="px-2 py-0.5 rounded bg-blue-500/10 border border-blue-400/20">data-sync</span>
            </div>
          </div>
        </div>
      )}

      {/* === MARKETING tab === */}
      {subTab === "marketing" && (
        <div className="space-y-3">
          {/* Performance overview */}
          {mktStats && (
            <div className="glass-card rounded-2xl p-4 border border-fuchsia-500/30">
              <h3 className="text-base font-sans font-bold text-white mb-3">
                <span className="bg-gradient-to-r from-fuchsia-400 via-purple-400 to-cyan-300 bg-clip-text text-transparent">
                  📊 Performance metrics
                </span>
              </h3>
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 mb-3">
                <div className="rounded-lg bg-white/5 border border-white/10 p-3">
                  <div className="text-xs text-white/50">Кампаний</div>
                  <div className="text-2xl font-mono font-bold text-white">{mktStats.campaigns.total}</div>
                </div>
                <div className="rounded-lg bg-emerald-500/10 border border-emerald-400/30 p-3">
                  <div className="text-xs text-emerald-300">Sent</div>
                  <div className="text-2xl font-mono font-bold text-emerald-300">{mktStats.performance.totals.sent}</div>
                </div>
                <div className="rounded-lg bg-cyan-500/10 border border-cyan-400/30 p-3">
                  <div className="text-xs text-cyan-300">Opened</div>
                  <div className="text-2xl font-mono font-bold text-cyan-300">{mktStats.performance.totals.opened}</div>
                </div>
                <div className="rounded-lg bg-fuchsia-500/10 border border-fuchsia-400/30 p-3">
                  <div className="text-xs text-fuchsia-300">Converted</div>
                  <div className="text-2xl font-mono font-bold text-fuchsia-300">{mktStats.performance.totals.converted}</div>
                </div>
              </div>
              <div className="grid grid-cols-3 gap-2 text-xs">
                <div className="rounded bg-white/5 border border-white/10 p-2">
                  <div className="text-white/50">Open rate</div>
                  <div className="font-mono text-white">{(mktStats.performance.totals.openRate * 100).toFixed(1)}%</div>
                </div>
                <div className="rounded bg-white/5 border border-white/10 p-2">
                  <div className="text-white/50">Click rate</div>
                  <div className="font-mono text-white">{(mktStats.performance.totals.clickRate * 100).toFixed(1)}%</div>
                </div>
                <div className="rounded bg-white/5 border border-white/10 p-2">
                  <div className="text-white/50">Conversion</div>
                  <div className="font-mono text-white">{(mktStats.performance.totals.conversionRate * 100).toFixed(2)}%</div>
                </div>
              </div>
              {mktStats.performance.totals.revenue > 0 && (
                <div className="mt-2 text-sm text-amber-300">
                  💰 Revenue: <span className="font-mono">{mktStats.performance.totals.revenue.toLocaleString("ru-RU")} коп.</span>
                </div>
              )}
            </div>
          )}

          {/* Trigger manual event */}
          <div className="glass-card rounded-2xl p-4 border border-amber-500/30">
            <h3 className="text-base font-sans font-bold text-white mb-2">⚡ Trigger marketing event</h3>
            <p className="text-xs text-muted-foreground mb-3">
              Тестировать auto-campaign listeners без реального payment/publish. Auto-campaign будет создана в draft со scheduledAt в будущее.
            </p>
            <div className="flex flex-wrap gap-2 items-center">
              <select
                value={mktTriggerEvent}
                onChange={e => setMktTriggerEvent(e.target.value)}
                className="bg-white/5 border border-amber-400/20 text-white rounded-lg px-3 py-1.5 text-sm"
              >
                <option value="payment.succeeded">payment.succeeded</option>
                <option value="generation.published">generation.published</option>
                <option value="user.churned">user.churned</option>
                <option value="generation.milestone">generation.milestone</option>
                <option value="subscription.expired">subscription.expired</option>
                <option value="referral.bonus.given">referral.bonus.given</option>
                <option value="user.registered">user.registered</option>
              </select>
              <input
                type="text"
                value={mktTriggerPayload}
                onChange={e => setMktTriggerPayload(e.target.value)}
                placeholder='{"userId":1,"amount":39900}'
                className="flex-1 min-w-[200px] bg-white/5 border border-amber-400/20 text-white rounded-lg px-3 py-1.5 text-sm font-mono"
              />
              <button
                onClick={triggerMarketingEvent}
                className="px-4 py-1.5 rounded-lg bg-gradient-to-r from-amber-500 to-fuchsia-500 text-white text-sm font-medium hover:shadow-[0_0_16px_rgba(251,191,36,0.4)]"
              >
                ⚡ Trigger
              </button>
            </div>
            {mktTriggerResult && (
              <div className={`mt-2 text-xs ${mktTriggerResult.startsWith("✓") ? "text-emerald-300" : "text-red-300"}`}>
                {mktTriggerResult}
              </div>
            )}
          </div>

          {/* Campaigns list */}
          <div className="glass-card rounded-2xl p-4 border border-purple-500/30">
            <div className="flex items-center justify-between mb-2">
              <h3 className="text-base font-sans font-bold text-white">📣 Campaigns ({mktCampaigns.length})</h3>
              <button
                onClick={loadMarketing}
                disabled={mktLoading}
                className="px-3 py-1.5 rounded-lg bg-white/5 border border-purple-400/20 text-white text-sm hover:bg-white/10"
              >
                {mktLoading ? "⏳" : "🔄"}
              </button>
            </div>

            {mktLoading && !mktCampaigns.length ? (
              <div className="text-white/60 text-sm">Загрузка...</div>
            ) : mktCampaigns.length === 0 ? (
              <div className="text-white/60 text-sm">
                Кампаний пока нет. Trigger marketing event выше или жди реального payment/publish hook.
              </div>
            ) : (
              <div className="space-y-2">
                {mktCampaigns.map(c => (
                  <div key={c.id} className="rounded-lg bg-white/5 border border-purple-400/20 p-3">
                    <div className="flex flex-wrap items-start gap-2 mb-1">
                      <div className="flex-1 min-w-0">
                        <div className="text-sm font-sans font-bold text-white truncate">{c.name}</div>
                        <div className="text-[10px] font-mono text-white/40">{c.id}</div>
                      </div>
                      <span className={`text-[10px] px-2 py-0.5 rounded-full border ${
                        c.status === "running" ? "bg-emerald-500/15 text-emerald-300 border-emerald-400/30"
                        : c.status === "scheduled" ? "bg-cyan-500/15 text-cyan-300 border-cyan-400/30"
                        : c.status === "completed" ? "bg-white/10 text-white/60 border-white/20"
                        : c.status === "failed" ? "bg-red-500/15 text-red-300 border-red-400/30"
                        : "bg-amber-500/15 text-amber-300 border-amber-400/30"
                      }`}>
                        {c.status}
                      </span>
                    </div>
                    <div className="flex flex-wrap gap-1 text-[10px] mb-1">
                      {c.channels.map(ch => (
                        <span key={ch} className="px-2 py-0.5 rounded-full bg-cyan-500/15 text-cyan-300 border border-cyan-400/20">
                          {ch}
                        </span>
                      ))}
                      <span className="px-2 py-0.5 rounded-full bg-fuchsia-500/15 text-fuchsia-300 border border-fuchsia-400/20">
                        {c.segment}
                      </span>
                      <span className="px-2 py-0.5 rounded-full bg-white/5 text-white/50 border border-white/10">
                        by {c.createdBy}
                      </span>
                    </div>
                    <div className="grid grid-cols-4 gap-1 text-[10px] text-white/50 font-mono mt-2">
                      <div>📤 sent: <span className="text-white/80">{c.metrics.sent}</span></div>
                      <div>👁 opened: <span className="text-cyan-300">{c.metrics.opened}</span></div>
                      <div>🖱 clicked: <span className="text-fuchsia-300">{c.metrics.clicked}</span></div>
                      <div>💎 conv: <span className="text-emerald-300">{c.metrics.converted}</span></div>
                    </div>
                    {c.variants.length > 1 && (
                      <div className="mt-2 text-[10px] text-white/40">
                        A/B variants: {c.variants.map(v => `${v.key}(${(v.share * 100).toFixed(0)}%)`).join(" · ")}
                      </div>
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

// ============================================================
// DirectorVoiceReport — Eugene 2026-05-24
// «Музa Директор контролирует всех агентов, собирает всю информацию,
//  итоговую докладывает через аудио».
//
// Большая brand-gradient кнопка «🎤 Доложи итоги». Click → POST
// /api/admin/v304/director/voice-report → играет mp3 (Yandex TTS) или
// fallback на browser SpeechSynthesis API. Под кнопкой transcript.
// Auto-refresh каждые 5 минут (опциональный toggle).
// ============================================================
interface DirectorReport {
  textSummary: string;
  audioBase64?: string;
  audioContentType?: string;
  ttsError?: string;
  generatedAt: string;
  period: { id: string; label: string; fromIso: string; toIso: string };
}

function DirectorVoiceReport() {
  const [report, setReport] = useState<DirectorReport | null>(null);
  const [loading, setLoading] = useState(false);
  const [transcriptOpen, setTranscriptOpen] = useState(false);
  const [autoRefresh, setAutoRefresh] = useState(false);
  const [period, setPeriod] = useState<string>("today");
  const [err, setErr] = useState<string | null>(null);

  async function generateReport() {
    setLoading(true);
    setErr(null);
    try {
      const r = await fetch(
        `/api/admin/v304/director/voice-report?period=${encodeURIComponent(period)}`,
        { credentials: "include" },
      );
      if (!r.ok) throw new Error(`${r.status}`);
      const j = await r.json();
      const rep: DirectorReport = j.data;
      setReport(rep);

      // Play audio: Yandex TTS mp3 (base64) preferred, fallback на browser SpeechSynthesis
      if (rep.audioBase64 && rep.audioContentType) {
        try {
          const blob = base64ToBlob(rep.audioBase64, rep.audioContentType);
          const url = URL.createObjectURL(blob);
          const audio = new Audio(url);
          audio.play().catch(() => {
            speakViaBrowser(rep.textSummary);
          });
        } catch {
          speakViaBrowser(rep.textSummary);
        }
      } else {
        // Yandex TTS не доступен — fallback на browser SpeechSynthesis
        speakViaBrowser(rep.textSummary);
      }
    } catch (e: any) {
      setErr(String(e?.message || e));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    if (!autoRefresh) return;
    const t = setInterval(generateReport, 5 * 60_000);
    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoRefresh, period]);

  return (
    <div className="mt-4 rounded-xl border border-fuchsia-500/30 bg-gradient-to-br from-purple-900/20 via-fuchsia-900/15 to-cyan-900/15 p-3">
      <div className="flex flex-wrap items-center gap-2 mb-2">
        <button
          onClick={generateReport}
          disabled={loading}
          className="px-4 py-2 rounded-lg bg-gradient-to-r from-purple-500 via-fuchsia-500 to-cyan-500 text-white text-sm font-bold shadow-[0_0_24px_rgba(217,70,239,0.45)] hover:shadow-[0_0_32px_rgba(124,58,237,0.55)] transition-shadow disabled:opacity-50"
        >
          {loading ? "⏳ Собираю..." : "🎤 Доложи итоги"}
        </button>
        <select
          value={period}
          onChange={e => setPeriod(e.target.value)}
          className="bg-white/5 border border-fuchsia-400/20 text-white rounded-lg px-2 py-1.5 text-xs"
        >
          <option value="today">сегодня</option>
          <option value="yesterday">вчера</option>
          <option value="7d">7 дней</option>
          <option value="30d">30 дней</option>
        </select>
        <label className="flex items-center gap-1 text-xs text-white/70 cursor-pointer">
          <input
            type="checkbox"
            checked={autoRefresh}
            onChange={e => setAutoRefresh(e.target.checked)}
            className="accent-fuchsia-500"
          />
          auto 5 мин
        </label>
        {report && (
          <button
            onClick={() => setTranscriptOpen(o => !o)}
            className="text-xs text-cyan-300 hover:text-cyan-200 underline"
          >
            {transcriptOpen ? "скрыть текст" : "показать текст"}
          </button>
        )}
      </div>

      {err && (
        <div className="text-xs text-red-300 mt-1">⚠ {err}</div>
      )}

      {report && report.ttsError && (
        <div className="text-[10px] text-amber-300 mt-1">
          ⚠ TTS: {report.ttsError} — играю через браузерный голос
        </div>
      )}

      {report && transcriptOpen && (
        <div className="mt-2 p-3 rounded-lg bg-black/30 border border-white/10 text-xs text-white/80 leading-relaxed whitespace-pre-wrap">
          {report.textSummary}
          <div className="mt-2 text-[10px] text-white/40 font-mono">
            {report.period.label} · {new Date(report.generatedAt).toLocaleString("ru-RU")}
          </div>
        </div>
      )}
    </div>
  );
}

function base64ToBlob(base64: string, contentType: string): Blob {
  const byteChars = atob(base64);
  const byteNumbers = new Array(byteChars.length);
  for (let i = 0; i < byteChars.length; i++) {
    byteNumbers[i] = byteChars.charCodeAt(i);
  }
  return new Blob([new Uint8Array(byteNumbers)], { type: contentType });
}

function speakViaBrowser(text: string) {
  try {
    if (typeof window === "undefined" || !("speechSynthesis" in window)) return;
    const u = new SpeechSynthesisUtterance(text);
    u.lang = "ru-RU";
    u.rate = 1.05;
    window.speechSynthesis.cancel();
    window.speechSynthesis.speak(u);
  } catch {
    // ignore — TTS просто не сработает
  }
}
