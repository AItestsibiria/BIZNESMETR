// Eugene 2026-05-30 Босс: Ферзь — реестр всех ошибок от агентов + диагностики
// системы. Period filter + копировать ошибки + прогнать сейчас (1/день + on-demand).
// Endpoints: GET /ferz/report, POST /ferz/run-now?period=...
//
// Ферзь агрегирует (см. lib/ferzAgent.ts): orchestrator agents, user_action_failures,
// incidents, gen_lifecycle errors, LLM-провайдеры, payments, DB integrity, Фрон, Бэк.
import { useEffect, useState } from "react";

type Severity = "critical" | "high" | "medium" | "low";

interface FerzFinding {
  severity: Severity;
  area: string;
  title: string;
  detail: string;
  metric?: string;
}

interface FerzReport {
  generatedAt: string;
  severityCounts: Record<Severity, number>;
  findings: FerzFinding[];
  summary: string;
}

const SEV_LABEL: Record<Severity, string> = {
  critical: "критич",
  high: "важн",
  medium: "средн",
  low: "мелк",
};
const SEV_CLASS: Record<Severity, string> = {
  critical: "bg-red-500/20 text-red-300 border-red-500/40",
  high: "bg-amber-500/20 text-amber-300 border-amber-500/40",
  medium: "bg-fuchsia-500/15 text-fuchsia-300 border-fuchsia-500/30",
  low: "bg-white/10 text-white/50 border-white/20",
};
const AREA_LABEL: Record<string, string> = {
  agents: "агенты",
  failures: "сбои юзеров",
  incidents: "инциденты",
  generations: "генерации",
  llm: "LLM",
  payments: "платежи",
  db: "БД",
  frontend: "Фрон",
  backend: "Бэк",
  bottleneck: "узкое место",
};

const PERIODS: Array<{ id: string; label: string }> = [
  { id: "today", label: "Сегодня" },
  { id: "yesterday", label: "Вчера" },
  { id: "week", label: "Неделя" },
  { id: "month", label: "Месяц" },
  { id: "year", label: "Год" },
  { id: "all", label: "Всё время" },
];

async function fetchJson<T>(url: string, init?: RequestInit): Promise<T> {
  const token = localStorage.getItem("auth_token") || "";
  const r = await fetch(url, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(init?.headers || {}),
    },
  });
  const j = await r.json();
  if (!r.ok || j.error) throw new Error(j.error || `HTTP ${r.status}`);
  return j.data as T;
}

export default function FerzTab() {
  const [report, setReport] = useState<FerzReport | null>(null);
  const [period, setPeriod] = useState<string>("today");
  const [loading, setLoading] = useState(true);
  const [running, setRunning] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);

  async function load() {
    setLoading(true);
    setErr(null);
    try {
      const d = await fetchJson<FerzReport>("/api/admin/v304/ferz/report");
      setReport(d);
    } catch (e: any) {
      setErr(e?.message || String(e));
    } finally {
      setLoading(false);
    }
  }

  async function runNow(p: string) {
    setRunning(true);
    setErr(null);
    try {
      const d = await fetchJson<FerzReport>("/api/admin/v304/ferz/run-now", {
        method: "POST",
        body: JSON.stringify({ period: p }),
      });
      setReport(d);
      setToast(`Прогон выполнен: ${d.findings.length} находок`);
    } catch (e: any) {
      setErr(e?.message || String(e));
      setToast("Ошибка прогона");
    } finally {
      setRunning(false);
    }
  }

  useEffect(() => { load(); }, []);
  useEffect(() => {
    if (!toast) return;
    const t = window.setTimeout(() => setToast(null), 2500);
    return () => window.clearTimeout(t);
  }, [toast]);

  function copyAllFindings() {
    if (!report) return;
    const sev = report.severityCounts || { critical: 0, high: 0, medium: 0, low: 0 };
    const lines: string[] = [];
    lines.push(`📋 Ферзь — реестр ошибок (период: ${PERIODS.find(p => p.id === period)?.label || period})`);
    lines.push(`По важности: критич ${sev.critical || 0} · важн ${sev.high || 0} · средн ${sev.medium || 0} · мелк ${sev.low || 0}`);
    lines.push(`🕐 Обновлено: ${new Date(report.generatedAt).toLocaleString("ru-RU")}`);
    if (report.summary) { lines.push(""); lines.push(report.summary); }
    if (!report.findings.length) {
      lines.push(""); lines.push("Чистый горизонт — Ферзь ничего критичного не нашёл.");
    } else {
      for (let i = 0; i < report.findings.length; i++) {
        const f = report.findings[i];
        lines.push("");
        lines.push("═".repeat(70));
        lines.push(`${i + 1}. [${SEV_LABEL[f.severity]} · ${AREA_LABEL[f.area] || f.area}] ${f.title}`);
        if (f.metric) lines.push(`   📊 ${f.metric}`);
        if (f.detail) lines.push(`   ${f.detail}`);
      }
    }
    const text = lines.join("\n");
    navigator.clipboard?.writeText(text).then(
      () => setToast(`Скопировано: ${report.findings.length} ошибок 📋`),
      () => setToast("Не удалось скопировать"),
    );
  }

  return (
    <div className="space-y-4">
      {/* Заголовок + действия */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-xl font-display font-bold gradient-text">♛ Ферзь — реестр ошибок</h2>
          <p className="text-xs text-muted-foreground mt-0.5">
            Все ошибки от агентов (Фрон, Бэк, gen-lifecycle, channel-watchdog) + диагностики системы (incidents, user_action_failures, LLM, платежи, БД) в одном месте. 1 раз в день автоматически + по запросу.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {/* Period chips */}
          <div className="flex flex-wrap gap-1 items-center">
            {PERIODS.map(p => (
              <button
                key={p.id}
                onClick={() => { setPeriod(p.id); runNow(p.id); }}
                disabled={running}
                className={`px-2.5 py-1 rounded-md text-xs font-medium border ${period === p.id ? "bg-purple-500/20 text-purple-200 border-purple-400/50" : "bg-white/5 border-white/10 text-white/60 hover:bg-white/10"}`}
              >{p.label}</button>
            ))}
          </div>
          <button
            onClick={() => runNow(period)}
            disabled={running}
            className="px-3 py-1.5 rounded-lg text-xs font-medium bg-gradient-to-r from-purple-500 via-fuchsia-500 to-blue-500 text-white shadow-[0_0_16px_rgba(124,58,237,0.4)] disabled:opacity-50"
          >{running ? "Гоняю…" : "🔁 Прогнать"}</button>
          <button
            onClick={load}
            className="px-3 py-1.5 rounded-lg text-xs font-medium bg-white/5 border border-white/10 hover:bg-white/10 text-white/70"
          >↻ Обновить</button>
        </div>
      </div>

      {/* ИТОГ + копировать */}
      <div className="glass-card rounded-2xl p-4 border border-fuchsia-500/30">
        <div className="flex items-center justify-between mb-2">
          <span className="text-sm font-bold text-white">📋 Итог</span>
          <div className="flex items-center gap-2">
            <button onClick={copyAllFindings} disabled={!report} className="text-[11px] px-2 py-0.5 rounded-md bg-fuchsia-500/15 border border-fuchsia-500/40 text-fuchsia-200 hover:bg-fuchsia-500/25 disabled:opacity-50">📋 Скопировать ошибки</button>
          </div>
        </div>
        <pre className="text-[13px] text-white/80 whitespace-pre-wrap font-sans leading-relaxed">
          {loading ? "Загружаю…" : err ? `Ошибка: ${err}` : (report?.summary || "Пока нет данных — нажми «🔁 Прогнать».")}
        </pre>
        {report ? (
          <div className="mt-2 text-[11px] text-muted-foreground flex flex-wrap gap-x-4 gap-y-1">
            <span>Критич: <b className="text-red-300">{report.severityCounts.critical}</b></span>
            <span>Важн: <b className="text-amber-300">{report.severityCounts.high}</b></span>
            <span>Средн: <b className="text-fuchsia-300">{report.severityCounts.medium}</b></span>
            <span>Мелк: <b className="text-white/60">{report.severityCounts.low}</b></span>
            <span>Всего находок: <b className="text-white/80">{report.findings.length}</b></span>
            <span>Обновлено: {new Date(report.generatedAt).toLocaleString("ru-RU")}</span>
          </div>
        ) : null}
      </div>

      {/* Список находок */}
      <div className="space-y-2">
        {report && report.findings.length === 0 && !loading ? (
          <div className="text-center text-sm text-muted-foreground py-6">Ферзь ничего критичного не нашёл — чистый горизонт ✓</div>
        ) : null}
        {report?.findings.map((f, i) => (
          <div key={i} className={`glass-card rounded-xl p-3 border ${SEV_CLASS[f.severity]}`}>
            <div className="flex items-center gap-2 flex-wrap text-[11px] mb-1">
              <span className={`px-1.5 py-0.5 rounded ${SEV_CLASS[f.severity]} border`}>{SEV_LABEL[f.severity]}</span>
              <span className="text-white/60">область: <b className="text-white/80">{AREA_LABEL[f.area] || f.area}</b></span>
              {f.metric ? <span className="text-white/50">· 📊 {f.metric}</span> : null}
            </div>
            <div className="text-sm font-semibold text-white">{f.title}</div>
            {f.detail ? <div className="text-[12px] text-white/70 mt-0.5">{f.detail}</div> : null}
          </div>
        ))}
      </div>

      {toast ? (
        <div className="fixed bottom-6 right-6 z-50 px-3 py-2 rounded-lg bg-fuchsia-500/90 text-white text-xs shadow-xl">{toast}</div>
      ) : null}
    </div>
  );
}
