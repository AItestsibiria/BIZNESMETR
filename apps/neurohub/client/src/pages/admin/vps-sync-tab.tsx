// Admin VPS sync tab — Eugene 2026-05-18 Босс «таблицу сводного анализа 2
// VPS сделай — я подтвержу на clone».
//
// Side-by-side таблица prod (muzaai.ru) vs clone (clone.muziai.ru):
// БД-метрики, размеры, git SHA/branch, env-флаги. После rsync prod->clone
// Босс открывает вкладку и видит синхронизировались ли цифры.
//
// Brand-style consistency rule: glass-card, gradient-text, font-mono для
// чисел/SHA, emerald = match, amber = critical diff, magenta = missing key.

import { Fragment, useEffect, useState } from "react";
import { apiRequest } from "@/lib/queryClient";

interface DatabaseStats {
  usersTotal: number;
  usersActive7d: number;
  generationsTotal: number;
  generationsLast24h: number;
  generationsLast7d: number;
  paymentsTotal: number;
  paymentsLast7dSum: number;
  chatSessions: number;
  chatMessages: number;
  userLyricDrafts: number;
  coverFiles: number;
}

interface DiskStats {
  dataDbSizeBytes: number;
  authorsDirSizeBytes: number;
  uploadsDirSizeBytes: number;
  diskFreePercent: number | null;
}

interface UptimeStats {
  processUptimeSec: number;
  bootTimeIso: string;
}

interface VersionStats {
  gitSha: string | null;
  gitBranch: string | null;
  buildTime: string | null;
}

interface EnvStats {
  nodeEnv: string;
  hasGptunnel: boolean;
  hasOpenai: boolean;
  hasYandex: boolean;
  hasAnthropic: boolean;
  hasRobokassa: boolean;
  hasSmtp: boolean;
  hasTelegram: boolean;
  hasSmsRu: boolean;
  hasOperatorAuth: boolean;
  hasSessionSecret: boolean;
  hasSignedUrlSecret: boolean;
  publicDomain: string;
}

interface VPSStats {
  hostname: string;
  isProd: boolean;
  isClone: boolean;
  collectedAt: string;
  database: DatabaseStats;
  disk: DiskStats;
  uptime: UptimeStats;
  version: VersionStats;
  env: EnvStats;
}

interface CriticalDiff {
  field: string;
  local: unknown;
  remote: unknown;
  severity: "low" | "medium" | "high";
  note?: string;
}

interface ComparisonResponse {
  local: VPSStats;
  remote: VPSStats | null;
  remoteUrl: string | null;
  remoteError: string | null;
  diff: {
    criticalDiffs: CriticalDiff[];
    missingOnClone: string[];
  };
}

function fmtBytes(n: number): string {
  if (!n) return "—";
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(2)} MB`;
  return `${(n / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

function fmtNum(n: number): string {
  return n.toLocaleString("ru-RU");
}

function fmtRub(kopecksOrRub: number): string {
  // payments.amount хранятся в рублях. Если значение крупное (>1млн) —
  // возможно копейки, делим на 100.
  const rub = kopecksOrRub > 1_000_000 ? Math.round(kopecksOrRub / 100) : kopecksOrRub;
  return `${rub.toLocaleString("ru-RU")} ₽`;
}

function fmtUptime(sec: number): string {
  if (sec < 60) return `${sec} сек`;
  if (sec < 3600) return `${Math.round(sec / 60)} мин`;
  if (sec < 86400) return `${Math.round(sec / 3600)} ч`;
  return `${Math.round(sec / 86400)} дн`;
}

function fmtTime(iso: string | null): string {
  if (!iso) return "—";
  try {
    return new Date(iso).toLocaleString("ru-RU", { dateStyle: "short", timeStyle: "short" });
  } catch {
    return iso;
  }
}

type Row = {
  label: string;
  emoji: string;
  prodValue: string;
  cloneValue: string;
  match: "same" | "diff" | "missing-clone" | "missing-prod" | "unknown";
  note?: string;
};

function diffPct(a: number, b: number): number {
  const base = Math.max(Math.abs(a), Math.abs(b), 1);
  return Math.abs(a - b) / base * 100;
}

function numRow(label: string, emoji: string, prod: number, clone: number, fmt: (n: number) => string, thresholdPct: number = 5): Row {
  const pct = diffPct(prod, clone);
  const match: Row["match"] = pct < thresholdPct ? "same" : "diff";
  return {
    label,
    emoji,
    prodValue: fmt(prod),
    cloneValue: fmt(clone),
    match,
    note: match === "diff" ? `${pct.toFixed(0)}% разница` : undefined,
  };
}

function strRow(label: string, emoji: string, prod: string | null, clone: string | null): Row {
  if (!prod && !clone) return { label, emoji, prodValue: "—", cloneValue: "—", match: "unknown" };
  if (!prod) return { label, emoji, prodValue: "—", cloneValue: clone || "—", match: "missing-prod" };
  if (!clone) return { label, emoji, prodValue: prod, cloneValue: "—", match: "missing-clone" };
  return { label, emoji, prodValue: prod, cloneValue: clone, match: prod === clone ? "same" : "diff" };
}

function boolRow(label: string, emoji: string, prod: boolean, clone: boolean): Row {
  const match: Row["match"] = prod === clone ? "same" : prod && !clone ? "missing-clone" : "missing-prod";
  return {
    label,
    emoji,
    prodValue: prod ? "✅" : "❌",
    cloneValue: clone ? "✅" : "❌",
    match,
  };
}

function buildRows(local: VPSStats, remote: VPSStats | null): { groups: Array<{ title: string; rows: Row[] }>; isLocalProd: boolean } {
  // Если local = prod, prodValue приходит из local.
  const isLocalProd = local.isProd || !local.isClone;
  const prod = isLocalProd ? local : remote;
  const clone = isLocalProd ? remote : local;

  const empty: DatabaseStats = {
    usersTotal: 0, usersActive7d: 0, generationsTotal: 0, generationsLast24h: 0,
    generationsLast7d: 0, paymentsTotal: 0, paymentsLast7dSum: 0, chatSessions: 0,
    chatMessages: 0, userLyricDrafts: 0, coverFiles: 0,
  };
  const emptyDisk: DiskStats = { dataDbSizeBytes: 0, authorsDirSizeBytes: 0, uploadsDirSizeBytes: 0, diskFreePercent: null };
  const emptyEnv: EnvStats = {
    nodeEnv: "—", hasGptunnel: false, hasOpenai: false, hasYandex: false, hasAnthropic: false,
    hasRobokassa: false, hasSmtp: false, hasTelegram: false, hasSmsRu: false,
    hasOperatorAuth: false, hasSessionSecret: false, hasSignedUrlSecret: false, publicDomain: "—",
  };

  const p = prod?.database ?? empty;
  const c = clone?.database ?? empty;
  const pd = prod?.disk ?? emptyDisk;
  const cd = clone?.disk ?? emptyDisk;
  const pe = prod?.env ?? emptyEnv;
  const ce = clone?.env ?? emptyEnv;
  const pv = prod?.version ?? { gitSha: null, gitBranch: null, buildTime: null };
  const cv = clone?.version ?? { gitSha: null, gitBranch: null, buildTime: null };
  const pu = prod?.uptime ?? { processUptimeSec: 0, bootTimeIso: "" };
  const cu = clone?.uptime ?? { processUptimeSec: 0, bootTimeIso: "" };

  const groups = [
    {
      title: "🗄 БД — данные",
      rows: [
        numRow("Юзеров всего", "👥", p.usersTotal, c.usersTotal, fmtNum),
        numRow("Активных за 7д", "🔥", p.usersActive7d, c.usersActive7d, fmtNum, 10),
        numRow("Треков всего", "🎵", p.generationsTotal, c.generationsTotal, fmtNum),
        numRow("Треков за 24ч", "⏱", p.generationsLast24h, c.generationsLast24h, fmtNum, 25),
        numRow("Треков за 7д", "📈", p.generationsLast7d, c.generationsLast7d, fmtNum, 15),
        numRow("Платежей всего", "💳", p.paymentsTotal, c.paymentsTotal, fmtNum),
        numRow("Платежей за 7д (₽)", "💰", p.paymentsLast7dSum, c.paymentsLast7dSum, fmtRub, 25),
        numRow("Чат-сессий", "💬", p.chatSessions, c.chatSessions, fmtNum),
        numRow("Чат-сообщений", "📝", p.chatMessages, c.chatMessages, fmtNum, 10),
        numRow("Lyric drafts", "✍️", p.userLyricDrafts, c.userLyricDrafts, fmtNum),
        numRow("Cover files", "🎨", p.coverFiles, c.coverFiles, fmtNum),
      ],
    },
    {
      title: "💾 Диск",
      rows: [
        numRow("data.db", "🗂", pd.dataDbSizeBytes, cd.dataDbSizeBytes, fmtBytes, 10),
        numRow("authors/", "📂", pd.authorsDirSizeBytes, cd.authorsDirSizeBytes, fmtBytes, 10),
        numRow("uploads/", "📤", pd.uploadsDirSizeBytes, cd.uploadsDirSizeBytes, fmtBytes, 15),
        strRow(
          "Свободно %",
          "📊",
          pd.diskFreePercent != null ? `${pd.diskFreePercent}%` : null,
          cd.diskFreePercent != null ? `${cd.diskFreePercent}%` : null,
        ),
      ],
    },
    {
      title: "🌐 Версия",
      rows: [
        strRow("Git SHA", "🔖", pv.gitSha, cv.gitSha),
        strRow("Git branch", "🌿", pv.gitBranch, cv.gitBranch),
        strRow("Build time", "🏗", pv.buildTime ? fmtTime(pv.buildTime) : null, cv.buildTime ? fmtTime(cv.buildTime) : null),
        strRow("Public domain", "🔗", pe.publicDomain, ce.publicDomain),
      ],
    },
    {
      title: "⏱ Uptime",
      rows: [
        strRow("Process uptime", "⏰", pu.bootTimeIso ? fmtUptime(pu.processUptimeSec) : null, cu.bootTimeIso ? fmtUptime(cu.processUptimeSec) : null),
        strRow("Boot time", "🚀", pu.bootTimeIso ? fmtTime(pu.bootTimeIso) : null, cu.bootTimeIso ? fmtTime(cu.bootTimeIso) : null),
      ],
    },
    {
      title: "🔑 Ключи (только наличие, без значений)",
      rows: [
        strRow("NODE_ENV", "⚙️", pe.nodeEnv, ce.nodeEnv),
        boolRow("GPTunnel (Suno)", "🎵", pe.hasGptunnel, ce.hasGptunnel),
        boolRow("Anthropic (Claude)", "🧠", pe.hasAnthropic, ce.hasAnthropic),
        boolRow("OpenAI (Whisper)", "🤖", pe.hasOpenai, ce.hasOpenai),
        boolRow("Yandex (STT)", "🎤", pe.hasYandex, ce.hasYandex),
        boolRow("Robokassa", "💳", pe.hasRobokassa, ce.hasRobokassa),
        boolRow("SMTP (email)", "📧", pe.hasSmtp, ce.hasSmtp),
        boolRow("Telegram bot", "💬", pe.hasTelegram, ce.hasTelegram),
        boolRow("SMS.ru", "📱", pe.hasSmsRu, ce.hasSmsRu),
        boolRow("Operator hash", "🛡", pe.hasOperatorAuth, ce.hasOperatorAuth),
        boolRow("SESSION_SECRET", "🔐", pe.hasSessionSecret, ce.hasSessionSecret),
        boolRow("SIGNED_URL_SECRET", "🔏", pe.hasSignedUrlSecret, ce.hasSignedUrlSecret),
      ],
    },
  ];

  return { groups, isLocalProd };
}

function severityColor(s: "low" | "medium" | "high"): string {
  if (s === "high") return "text-fuchsia-300 bg-fuchsia-500/15 border-fuchsia-500/40";
  if (s === "medium") return "text-amber-300 bg-amber-500/15 border-amber-500/40";
  return "text-cyan-300 bg-cyan-500/10 border-cyan-500/30";
}

function rowMatchClass(m: Row["match"]): string {
  if (m === "same") return "border-emerald-500/20 bg-emerald-500/[0.04]";
  if (m === "diff") return "border-amber-500/30 bg-amber-500/[0.06]";
  if (m === "missing-clone" || m === "missing-prod")
    return "border-fuchsia-500/30 bg-fuchsia-500/[0.07] shadow-[0_0_18px_rgba(255,0,110,0.15)]";
  return "border-white/10 bg-white/[0.02]";
}

function rowMatchBadge(m: Row["match"]): { text: string; cls: string } {
  if (m === "same") return { text: "✓", cls: "text-emerald-300" };
  if (m === "diff") return { text: "≠", cls: "text-amber-300" };
  if (m === "missing-clone") return { text: "только prod", cls: "text-fuchsia-300" };
  if (m === "missing-prod") return { text: "только clone", cls: "text-fuchsia-300" };
  return { text: "?", cls: "text-white/40" };
}

interface VpsSyncTabProps {
  toast?: (opts: { title: string; variant?: "destructive" | "default" }) => void;
}

function VpsSyncTab({ toast }: VpsSyncTabProps = {}) {
  function notify(msg: string, kind: "success" | "error" | "info" = "info") {
    if (toast) {
      toast({ title: msg, variant: kind === "error" ? "destructive" : "default" });
    } else {
      // Fallback к browser alert в isolation-mode (когда tab вызвана без props)
      // — а в admin-v304 toast всегда передаётся.
      console.log(`[vps-sync] ${kind}: ${msg}`);
    }
  }

  const [data, setData] = useState<ComparisonResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [showInstructions, setShowInstructions] = useState(false);

  async function loadComparison() {
    setLoading(true);
    try {
      const r = await apiRequest("GET", "/api/admin/v304/vps-comparison");
      const j = await r.json();
      if (j.error) {
        notify(j.error, "error");
        return;
      }
      setData(j.data as ComparisonResponse);
    } catch (e) {
      notify("Не удалось загрузить сравнение: " + String(e), "error");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    loadComparison();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function copyReport() {
    if (!data) return;
    try {
      navigator.clipboard.writeText(JSON.stringify(data, null, 2));
      notify("📋 Скопировано", "success");
    } catch {
      notify("Не удалось скопировать", "error");
    }
  }

  if (loading && !data) {
    return (
      <div className="p-6 rounded-2xl glass-card border border-purple-500/20">
        <p className="text-sm font-sans text-muted-foreground">Загружаем срез VPS…</p>
      </div>
    );
  }

  if (!data) {
    return (
      <div className="p-6 rounded-2xl glass-card border border-fuchsia-500/30 bg-fuchsia-500/[0.05]">
        <h2 className="text-2xl font-display font-bold gradient-text mb-2">🖥 VPS Sync</h2>
        <p className="text-sm font-sans text-muted-foreground mb-4">
          Не удалось загрузить данные. Попробуй обновить.
        </p>
        <button
          onClick={loadComparison}
          className="px-4 py-2 rounded-xl bg-white/5 border border-purple-400/20 hover:bg-gradient-to-br hover:from-purple-500/60 hover:to-fuchsia-500/60 transition-all font-sans text-sm text-white"
        >
          🔄 Обновить
        </button>
      </div>
    );
  }

  const { groups, isLocalProd } = buildRows(data.local, data.remote);
  const prodLabel = isLocalProd ? data.local.hostname : data.remote?.hostname || "—";
  const cloneLabel = isLocalProd ? data.remote?.hostname || "—" : data.local.hostname;
  const prodCollected = isLocalProd ? data.local.collectedAt : data.remote?.collectedAt;
  const cloneCollected = isLocalProd ? data.remote?.collectedAt : data.local.collectedAt;

  return (
    <div className="space-y-6">
      {/* Заголовок */}
      <div className="p-5 rounded-2xl glass-card border border-purple-500/30 bg-gradient-to-br from-purple-500/[0.06] via-fuchsia-500/[0.04] to-cyan-500/[0.04]">
        <div className="flex items-start justify-between gap-4 flex-wrap">
          <div>
            <h2 className="text-3xl font-display font-bold gradient-text mb-1">🖥 VPS Sync — сводный анализ</h2>
            <p className="text-sm font-sans text-muted-foreground">
              Сравнение prod (<span className="font-mono text-purple-300">muzaai.ru</span>) и clone
              (<span className="font-mono text-cyan-300">clone.muziai.ru</span>) для проверки синхронизации данных.
            </p>
            <p className="text-xs font-sans text-white/50 mt-1">
              Текущий VPS:{" "}
              <span className="font-mono text-amber-300">{data.local.hostname}</span>
              {" "}
              ({data.local.isProd ? "🏆 prod" : data.local.isClone ? "🧪 clone" : "❓ неизвестно"})
            </p>
          </div>
          <div className="flex gap-2 items-start">
            <button
              onClick={loadComparison}
              disabled={loading}
              className="px-4 py-2 rounded-xl bg-white/5 border border-purple-400/20 hover:bg-gradient-to-br hover:from-purple-500/60 hover:to-fuchsia-500/60 transition-all font-sans text-sm text-white disabled:opacity-50"
              data-testid="vps-sync-refresh"
            >
              {loading ? "…" : "🔄 Обновить"}
            </button>
            <button
              onClick={copyReport}
              className="px-4 py-2 rounded-xl bg-white/5 border border-cyan-400/20 hover:bg-cyan-500/20 transition-all font-sans text-sm text-white"
              data-testid="vps-sync-copy"
            >
              📋 Копировать
            </button>
          </div>
        </div>
      </div>

      {/* Remote error banner */}
      {data.remoteError && (
        <div className="p-4 rounded-xl glass-card border border-fuchsia-500/40 bg-fuchsia-500/[0.08]">
          <p className="text-sm font-sans text-fuchsia-200">
            ⚠ Удалённый VPS недоступен:{" "}
            <span className="font-mono text-xs">{data.remoteError}</span>
          </p>
          <p className="text-xs font-sans text-white/50 mt-1">
            Показан только срез текущего VPS. Для сравнения нужен валидный{" "}
            <span className="font-mono">ADMIN_SYNC_TOKEN</span> в .env обоих хостов.
          </p>
        </div>
      )}

      {/* Critical diffs banner */}
      {data.diff.criticalDiffs.length > 0 && (
        <div className="p-4 rounded-xl glass-card border border-amber-500/30 bg-amber-500/[0.06]">
          <h3 className="text-base font-sans font-bold text-white mb-2">
            ⚠ Критические расхождения ({data.diff.criticalDiffs.length})
          </h3>
          <div className="space-y-1.5">
            {data.diff.criticalDiffs.map((d, i) => (
              <div key={i} className="flex items-center gap-2 text-xs font-sans">
                <span className={`px-2 py-0.5 rounded-full border ${severityColor(d.severity)} font-medium`}>
                  {d.severity}
                </span>
                <span className="font-mono text-white/80">{d.field}</span>
                <span className="text-white/40">prod=</span>
                <span className="font-mono text-purple-300">{String(d.local)}</span>
                <span className="text-white/40">clone=</span>
                <span className="font-mono text-cyan-300">{String(d.remote)}</span>
                {d.note && <span className="text-white/50">— {d.note}</span>}
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Missing on clone */}
      {data.diff.missingOnClone.length > 0 && (
        <div className="p-4 rounded-xl glass-card border border-fuchsia-500/30 bg-fuchsia-500/[0.06]">
          <h3 className="text-base font-sans font-bold text-white mb-2">
            🚫 Есть на prod, но нет на clone ({data.diff.missingOnClone.length})
          </h3>
          <div className="flex flex-wrap gap-1.5">
            {data.diff.missingOnClone.map((k) => (
              <span
                key={k}
                className="px-2 py-1 rounded-md border border-fuchsia-500/40 bg-fuchsia-500/10 text-fuchsia-200 font-mono text-xs"
              >
                {k}
              </span>
            ))}
          </div>
        </div>
      )}

      {/* Большая таблица */}
      <div className="rounded-2xl glass-card border border-purple-500/20 overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="bg-gradient-to-r from-purple-500/15 via-fuchsia-500/10 to-cyan-500/15 border-b border-purple-500/20">
              <th className="px-4 py-3 text-left font-sans font-bold text-white/80 w-1/3">Метрика</th>
              <th className="px-4 py-3 text-left font-sans font-bold text-purple-300">
                🏆 Prod
                <div className="text-[10px] font-mono text-white/40 font-normal">
                  {prodLabel} · {fmtTime(prodCollected ?? null)}
                </div>
              </th>
              <th className="px-4 py-3 text-left font-sans font-bold text-cyan-300">
                🧪 Clone
                <div className="text-[10px] font-mono text-white/40 font-normal">
                  {cloneLabel} · {fmtTime(cloneCollected ?? null)}
                </div>
              </th>
              <th className="px-4 py-3 text-center font-sans font-bold text-white/80 w-24">Diff</th>
            </tr>
          </thead>
          <tbody>
            {groups.map((g, gi) => (
              <Fragment key={`g-${gi}`}>
                <tr>
                  <td colSpan={4} className="px-4 py-2 bg-white/[0.02] border-y border-white/5">
                    <span className="text-xs font-sans font-bold text-white/60 uppercase tracking-wide">
                      {g.title}
                    </span>
                  </td>
                </tr>
                {g.rows.map((r, ri) => {
                  const badge = rowMatchBadge(r.match);
                  return (
                    <tr key={`r-${gi}-${ri}`} className={`border-b border-white/5 ${rowMatchClass(r.match)} transition-colors`}>
                      <td className="px-4 py-2.5 font-sans text-white/80">
                        <span className="mr-2">{r.emoji}</span>
                        {r.label}
                      </td>
                      <td className="px-4 py-2.5 font-mono text-xs text-purple-200 break-all">{r.prodValue}</td>
                      <td className="px-4 py-2.5 font-mono text-xs text-cyan-200 break-all">{r.cloneValue}</td>
                      <td className={`px-4 py-2.5 text-center font-mono text-xs ${badge.cls}`}>
                        {badge.text}
                        {r.note && (
                          <div className="text-[9px] text-white/50 font-sans mt-0.5">{r.note}</div>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </Fragment>
            ))}
          </tbody>
        </table>
      </div>

      {/* CTA — инструкция по sync */}
      <div className="p-5 rounded-2xl glass-card border border-amber-500/30 bg-gradient-to-br from-amber-500/[0.06] via-purple-500/[0.04] to-fuchsia-500/[0.04]">
        <div className="flex items-start justify-between gap-4 flex-wrap">
          <div className="flex-1 min-w-[200px]">
            <h3 className="text-lg font-sans font-bold text-white mb-1">
              🔄 Запросить sync prod → clone
            </h3>
            <p className="text-sm font-sans text-muted-foreground">
              Команда вызывает rsync data.db + authors/ + uploads/ с prod на clone. Делается через SSH
              (см. <span className="font-mono text-amber-200">docs/strategy/CLONE-SYNC-FROM-PROD-180526.md</span>).
            </p>
          </div>
          <button
            onClick={() => setShowInstructions((v) => !v)}
            className="px-4 py-2 rounded-xl bg-gradient-to-r from-purple-500 via-fuchsia-500 to-blue-500 hover:opacity-90 transition-all font-sans text-sm text-white shadow-[0_0_24px_rgba(124,58,237,0.4)]"
          >
            {showInstructions ? "Скрыть" : "Показать инструкцию"}
          </button>
        </div>
        {showInstructions && (
          <div className="mt-4 p-4 rounded-xl bg-[#0a0a17]/60 border border-white/10">
            <pre className="text-[11px] font-mono text-white/80 overflow-x-auto whitespace-pre-wrap">
{`# Полная sync prod -> clone (на VPS 31.130.148.107):
ssh root@31.130.148.107 'bash <<EOF
  set -e
  cd /var/www/neurohub
  TS=\$(date +%Y%m%d-%H%M%S)
  cp data.db /var/backups/neurohub-auto/data.db-presync-\$TS
  rsync -avz --delete data.db root@72.56.1.149:/var/www/neurohub/data.db.new
  rsync -avz --delete authors/ root@72.56.1.149:/var/www/neurohub/authors/
  rsync -avz --delete uploads/ root@72.56.1.149:/var/www/neurohub/uploads/
EOF'

# На clone (72.56.1.149) — переключение БД:
ssh root@72.56.1.149 'cd /var/www/neurohub && mv data.db data.db.bak && mv data.db.new data.db && pm2 restart neurohub --update-env'

# Проверка: открой эту вкладку повторно — цифры должны совпасть.
# Подробности: docs/strategy/CLONE-SYNC-FROM-PROD-180526.md`}
            </pre>
            <p className="text-xs font-sans text-amber-300/80 mt-2">
              ⚠ Команды выполняются Боссом вручную в Termius. Здесь — справочный текст для copy-paste.
            </p>
          </div>
        )}
      </div>

      {/* Footer */}
      <div className="text-[11px] font-sans text-white/40 text-center">
        Собрано: <span className="font-mono">{fmtTime(data.local.collectedAt)}</span>
        {data.remote && (
          <>
            {" · Remote: "}
            <span className="font-mono">{fmtTime(data.remote.collectedAt)}</span>
          </>
        )}
      </div>
    </div>
  );
}

// Named export для admin-v304.tsx (любой import-style). Регистрация tab —
// после merge muza-mind, отдельным Edit.
export { VpsSyncTab };
export default VpsSyncTab;
