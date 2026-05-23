// Eugene 2026-05-23 Босс «Оркестратор нужен всеми компаниями агентами начать
// в проекте — коде».
//
// Admin-вкладка «🤖 Оркестратор» — единая визуализация всех зарегистрированных
// agents (channels / personas / watchdogs / cron / internal).
//
// Источник данных:
//   GET /api/admin/v304/orchestrator/agents — list + summary
//   GET /api/admin/v304/orchestrator/health — run healthCheckAll
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

export default function OrchestratorTab() {
  const [agents, setAgents] = useState<Agent[]>([]);
  const [summary, setSummary] = useState<Summary | null>(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [filterChannel, setFilterChannel] = useState<string>("");
  const [filterRole, setFilterRole] = useState<string>("");
  const [filterStatus, setFilterStatus] = useState<string>("");
  const [healthRunning, setHealthRunning] = useState(false);
  const [healthResult, setHealthResult] = useState<Record<string, { ok: boolean; details?: unknown }> | null>(null);

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

  useEffect(() => {
    load();
    const t = setInterval(load, 60_000);
    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filterChannel, filterRole, filterStatus]);

  const uniqueChannels = useMemo(() => Object.keys(CHANNEL_LABELS), []);
  const uniqueRoles = useMemo(() => Object.keys(ROLE_LABELS), []);

  return (
    <div className="space-y-4 p-2">
      {/* Header + summary */}
      <div className="glass-card rounded-2xl p-4 border border-purple-500/30">
        <div className="flex items-start gap-3">
          <span className="text-3xl">🤖</span>
          <div className="flex-1">
            <h2 className="text-lg font-sans font-bold text-white mb-1">
              <span className="bg-gradient-to-r from-purple-400 via-fuchsia-400 to-cyan-300 bg-clip-text text-transparent">
                Оркестратор агентов
              </span>
            </h2>
            <p className="text-sm font-sans text-muted-foreground leading-relaxed">
              Реестр всех agents проекта — каналы, персоны, watchdog'и, cron'ы. Один логический agent
              может маскироваться разными persona по каналам (Single-persona-across-channels rule).
            </p>
          </div>
        </div>

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
    </div>
  );
}
