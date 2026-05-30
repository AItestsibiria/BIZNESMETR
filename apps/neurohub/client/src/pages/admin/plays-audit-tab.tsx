// v304 admin tab: «📊 Аудит прослушиваний» (Eugene 2026-05-18 Босс «треки
// сверху по дате с 0 плеев — почему?»).
//
// Что показывает:
//  1) Ввод ID трека → детальный отчёт по запросу:
//     - 0 → 47 (метрика «показано / реально попыток»)
//     - Donut chart по 5 категориям rejected (author-self, admin, bot-ua,
//       too-short, ip-dedup-1h)
//     - Last 20 activities table с подсветкой
//     - Diagnosis + рекомендации Боссу
//  2) Снизу: Top-10 треков где meta.plays=0 но totalRejected > 0.
//
// Источник: /api/admin/v304/plays-audit/:id и /api/admin/v304/plays-audit/top-zero
// Стиль: glass-card + amber-glow (admin-themed) по Brand-style consistency rule.

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { PieChart, Pie, Cell, ResponsiveContainer, Tooltip } from "recharts";

type AuditDetail = {
  generationId: number;
  title: string;
  authorName: string | null;
  authorUserId: number;
  authorRole: string | null;
  isPublic: number;
  status: string;
  createdAt: string | null;
  metaPlays: number;
  rawActivity: {
    totalAttempts: number;
    successful: number;
    rejected: Record<string, number>;
  };
  last20Activities: Array<{
    ts: string | null;
    action: string;
    ip: string | null;
    geo: string | null;
    host: string | null;
  }>;
  diagnosis: string;
  recommendations: string[];
};

type TopZeroRow = {
  generationId: number;
  title: string;
  authorUserId: number;
  isPublic: number;
  createdAt: string | null;
  metaPlays: number;
  totalRejected: number;
  topReason: string;
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

const REASON_LABELS: Record<string, string> = {
  "author-self": "Автор слушал свой трек",
  admin: "Слушал админ",
  "bot-ua": "Бот / краулер",
  "too-short": "<5 сек",
  "ip-dedup-1h": "Повтор IP в 10 мин",
};

// Brand palette (см. Brand-style consistency rule)
const REASON_COLORS: Record<string, string> = {
  "author-self": "#7C3AED", // Cyber Violet
  admin: "#FBBF24", // Amber Glow
  "bot-ua": "#00D4FF", // Electric Blue
  "too-short": "#FF006E", // Hot Magenta
  "ip-dedup-1h": "#39FF14", // Neon Green
};

function copyToClipboard(text: string) {
  if (navigator.clipboard) {
    navigator.clipboard.writeText(text);
  }
}

export default function PlaysAuditTab() {
  const [genIdInput, setGenIdInput] = useState("");
  const [submittedId, setSubmittedId] = useState<number | null>(null);

  const detail = useQuery<AuditDetail>({
    queryKey: ["plays-audit", submittedId],
    queryFn: () => fetcher<AuditDetail>(`/api/admin/v304/plays-audit/${submittedId}`),
    enabled: submittedId !== null,
    refetchOnWindowFocus: false,
  });

  const topZero = useQuery<TopZeroRow[]>({
    queryKey: ["plays-audit-top-zero"],
    queryFn: () => fetcher<TopZeroRow[]>("/api/admin/v304/plays-audit/top-zero?limit=10"),
    refetchInterval: 120_000,
  });

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const n = parseInt(genIdInput.trim(), 10);
    if (Number.isFinite(n) && n > 0) setSubmittedId(n);
  };

  const pieData = detail.data
    ? Object.entries(detail.data.rawActivity.rejected).map(([reason, count]) => ({
        name: REASON_LABELS[reason] || reason,
        reason,
        value: count,
      }))
    : [];

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="glass-card rounded-2xl p-6 border border-amber-500/30">
        <h2 className="text-2xl font-display font-bold gradient-text mb-2">
          📊 Аудит прослушиваний
        </h2>
        <p className="text-sm font-sans text-muted-foreground leading-relaxed">
          Показывает СКОЛЬКО реальных попыток было на трек и ПОЧЕМУ они не
          засчитались. Применяется фильтр Play-counting rule (5 категорий
          rejected). Источник: <code className="font-mono text-amber-300">
          /api/admin/v304/plays-audit/:id</code>.
        </p>
      </div>

      {/* Input form */}
      <form
        onSubmit={handleSubmit}
        className="glass-card rounded-2xl p-6 border border-purple-500/30 flex gap-3 flex-wrap items-end"
      >
        <div className="flex-1 min-w-[200px]">
          <label className="block text-xs font-sans text-muted-foreground mb-2">
            ID трека (generationId)
          </label>
          <input
            type="number"
            min={1}
            value={genIdInput}
            onChange={(e) => setGenIdInput(e.target.value)}
            placeholder="например 123"
            className="input-glow w-full bg-white/5 border border-purple-400/30 rounded-lg px-4 py-2 text-white font-mono focus:outline-none focus:border-purple-400"
          />
        </div>
        <Button
          type="submit"
          className="bg-gradient-to-r from-purple-500 via-fuchsia-500 to-blue-500 text-white shadow-[0_0_24px_rgba(124,58,237,0.4)] hover:opacity-90"
        >
          🔍 Проанализировать
        </Button>
      </form>

      {/* Detail card */}
      {submittedId !== null && (
        <Card className="glass-card border border-amber-500/30">
          <CardContent className="p-6 space-y-4">
            {detail.isLoading && (
              <div className="text-sm font-sans text-muted-foreground">Загрузка...</div>
            )}
            {detail.error && (
              <div className="text-sm font-sans text-red-400">
                Ошибка: {(detail.error as Error).message}
              </div>
            )}
            {detail.data && (
              <>
                {/* Title row */}
                <div className="flex items-start gap-3 flex-wrap">
                  <div className="flex-1 min-w-[200px]">
                    <h3 className="text-lg font-sans font-bold text-white mb-1">
                      «{detail.data.title}»
                    </h3>
                    <div className="text-xs font-mono text-muted-foreground">
                      id={detail.data.generationId} · userId={detail.data.authorUserId}
                      {detail.data.authorName && ` · ${detail.data.authorName}`}
                      {detail.data.authorRole && detail.data.authorRole !== "user" &&
                        ` · ${detail.data.authorRole}`}
                    </div>
                  </div>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => {
                      const d = detail.data!;
                      const lines: string[] = [];
                      lines.push(`📊 Аудит прослушиваний — трек #${d.generationId}`);
                      lines.push(`🕐 ${new Date().toLocaleString("ru-RU")}`);
                      lines.push(`Название: ${d.title}`);
                      lines.push(`Автор: ${d.authorName || "—"} (userId ${d.authorUserId}${d.authorRole ? `, ${d.authorRole}` : ""})`);
                      lines.push(`Статус: ${d.status} · isPublic ${d.isPublic} · создан: ${d.createdAt || "—"}`);
                      lines.push("");
                      lines.push(`Показано юзеру (meta.plays): ${d.metaPlays}`);
                      lines.push(`Реально попыток: ${d.rawActivity.totalAttempts}`);
                      lines.push(`Успешных: ${d.rawActivity.successful}`);
                      lines.push("");
                      lines.push("Разбивка отказов:");
                      for (const [reason, count] of Object.entries(d.rawActivity.rejected)) {
                        if (count > 0) lines.push(`  ${REASON_LABELS[reason] || reason}: ${count}`);
                      }
                      lines.push("");
                      lines.push(`Диагноз: ${d.diagnosis}`);
                      if (d.recommendations?.length) {
                        lines.push("");
                        lines.push("Рекомендации:");
                        for (const r of d.recommendations) lines.push(`  • ${r}`);
                      }
                      if (d.last20Activities?.length) {
                        lines.push("");
                        lines.push(`Последние ${d.last20Activities.length} событий:`);
                        for (const a of d.last20Activities) {
                          lines.push(`  ${a.ts || "—"} · ${a.action} · ip ${a.ip || "—"} · geo ${a.geo || "—"} · host ${a.host || "—"}`);
                        }
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
                    onClick={() => copyToClipboard(JSON.stringify(detail.data, null, 2))}
                    className="bg-white/5 border-amber-400/30 text-amber-300 hover:bg-amber-500/20"
                  >
                    📋 JSON
                  </Button>
                </div>

                {/* Big metric: 0 → N */}
                <div className="flex items-center gap-4 flex-wrap">
                  <div className="text-center">
                    <div className="text-xs font-sans text-muted-foreground mb-1">
                      Показано юзеру
                    </div>
                    <div className="text-5xl font-display font-bold text-white">
                      {detail.data.metaPlays}
                    </div>
                  </div>
                  <div className="text-4xl text-amber-400">→</div>
                  <div className="text-center">
                    <div className="text-xs font-sans text-muted-foreground mb-1">
                      Реально попыток
                    </div>
                    <div className="text-5xl font-display font-bold text-amber-400">
                      {detail.data.rawActivity.totalAttempts}
                    </div>
                  </div>
                  <div className="flex-1 min-w-[200px] pl-4">
                    <div className="text-xs font-sans text-muted-foreground mb-1">Diagnosis</div>
                    <div className="text-sm font-sans text-white/80 leading-relaxed">
                      {detail.data.diagnosis}
                    </div>
                  </div>
                </div>

                {/* Donut chart of rejected reasons */}
                {pieData.length > 0 && (
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                    <div style={{ width: "100%", height: 240 }}>
                      <ResponsiveContainer>
                        <PieChart>
                          <Pie
                            data={pieData}
                            dataKey="value"
                            nameKey="name"
                            cx="50%"
                            cy="50%"
                            outerRadius={80}
                            innerRadius={40}
                            label={(e: any) => `${e.value}`}
                          >
                            {pieData.map((d, idx) => (
                              <Cell key={idx} fill={REASON_COLORS[d.reason] || "#888"} />
                            ))}
                          </Pie>
                          <Tooltip
                            contentStyle={{
                              background: "#0a0a17",
                              border: "1px solid #7C3AED",
                              borderRadius: 8,
                              color: "#fff",
                            }}
                          />
                        </PieChart>
                      </ResponsiveContainer>
                    </div>
                    <div className="space-y-2">
                      <div className="text-sm font-sans font-bold text-white mb-2">
                        Распределение отказов
                      </div>
                      {Object.entries(detail.data.rawActivity.rejected)
                        .sort((a, b) => b[1] - a[1])
                        .map(([reason, count]) => (
                          <div key={reason} className="flex items-center gap-2 text-sm font-sans">
                            <div
                              className="w-3 h-3 rounded-full"
                              style={{ background: REASON_COLORS[reason] || "#888" }}
                            />
                            <span className="text-white/80 flex-1">
                              {REASON_LABELS[reason] || reason}
                            </span>
                            <span className="font-mono text-amber-300">{count}</span>
                          </div>
                        ))}
                    </div>
                  </div>
                )}

                {/* Recommendations */}
                {detail.data.recommendations.length > 0 && (
                  <div className="bg-amber-500/10 border border-amber-500/30 rounded-lg p-4">
                    <div className="text-xs font-sans text-amber-300 font-bold mb-2 uppercase tracking-wide">
                      💡 Рекомендация
                    </div>
                    {detail.data.recommendations.map((r, i) => (
                      <p key={i} className="text-sm font-sans text-white/90 leading-relaxed">
                        {r}
                      </p>
                    ))}
                  </div>
                )}

                {/* Last 20 activities */}
                {detail.data.last20Activities.length > 0 && (
                  <div>
                    <h4 className="text-sm font-sans font-bold text-white mb-2">
                      Последние {detail.data.last20Activities.length} попыток
                    </h4>
                    <div className="overflow-x-auto rounded-lg border border-purple-500/20">
                      <table className="w-full text-xs font-mono">
                        <thead>
                          <tr className="bg-purple-500/10 text-purple-300 text-left">
                            <th className="px-3 py-2">Время</th>
                            <th className="px-3 py-2">Action</th>
                            <th className="px-3 py-2">IP</th>
                            <th className="px-3 py-2">Гео</th>
                            <th className="px-3 py-2">Host</th>
                          </tr>
                        </thead>
                        <tbody>
                          {detail.data.last20Activities.map((a, i) => {
                            const isReject = a.action.startsWith("play_rejected:");
                            const isAdmin = a.action === "play_rejected:admin";
                            return (
                              <tr
                                key={i}
                                className={`border-t border-purple-500/10 ${
                                  isAdmin
                                    ? "bg-red-500/10 text-red-300"
                                    : isReject
                                    ? "text-amber-300/80"
                                    : "text-emerald-300"
                                }`}
                              >
                                <td className="px-3 py-1.5">{a.ts || "—"}</td>
                                <td className="px-3 py-1.5">{a.action}</td>
                                <td className="px-3 py-1.5">{a.ip || "—"}</td>
                                <td className="px-3 py-1.5">{a.geo || "—"}</td>
                                <td className="px-3 py-1.5">{a.host || "—"}</td>
                              </tr>
                            );
                          })}
                        </tbody>
                      </table>
                    </div>
                  </div>
                )}
              </>
            )}
          </CardContent>
        </Card>
      )}

      {/* Top-Zero list */}
      <Card className="glass-card border border-purple-500/30">
        <CardContent className="p-6 space-y-3">
          <div className="flex items-center justify-between">
            <h3 className="text-lg font-sans font-bold text-white">
              🔥 Топ-10: 0 показано, но много попыток
            </h3>
            <Button
              variant="outline"
              size="sm"
              onClick={() => topZero.refetch()}
              className="bg-white/5 border-purple-400/30 text-purple-300"
            >
              🔄 Обновить
            </Button>
          </div>
          {topZero.isLoading && (
            <div className="text-sm font-sans text-muted-foreground">Загрузка...</div>
          )}
          {topZero.error && (
            <div className="text-sm font-sans text-red-400">
              {(topZero.error as Error).message}
            </div>
          )}
          {topZero.data && topZero.data.length === 0 && (
            <div className="text-sm font-sans text-muted-foreground">
              Подозрительных треков нет — все 0-плеевые треки и в gen_activity ничего.
            </div>
          )}
          {topZero.data && topZero.data.length > 0 && (
            <div className="overflow-x-auto rounded-lg border border-purple-500/20">
              <table className="w-full text-sm font-sans">
                <thead>
                  <tr className="bg-purple-500/10 text-purple-300 text-left">
                    <th className="px-3 py-2 font-mono text-xs">ID</th>
                    <th className="px-3 py-2">Название</th>
                    <th className="px-3 py-2 font-mono text-xs text-right">Plays</th>
                    <th className="px-3 py-2 font-mono text-xs text-right">Rejected</th>
                    <th className="px-3 py-2">Топ причина</th>
                    <th className="px-3 py-2"></th>
                  </tr>
                </thead>
                <tbody>
                  {topZero.data.map((r) => (
                    <tr key={r.generationId} className="border-t border-purple-500/10">
                      <td className="px-3 py-2 font-mono text-xs text-white/60">
                        {r.generationId}
                      </td>
                      <td className="px-3 py-2 text-white/90">{r.title}</td>
                      <td className="px-3 py-2 font-mono text-xs text-right text-white/80">
                        {r.metaPlays}
                      </td>
                      <td className="px-3 py-2 font-mono text-xs text-right text-amber-300">
                        {r.totalRejected}
                      </td>
                      <td className="px-3 py-2 text-white/80">
                        {REASON_LABELS[r.topReason] || r.topReason}
                      </td>
                      <td className="px-3 py-2">
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() => {
                            setGenIdInput(String(r.generationId));
                            setSubmittedId(r.generationId);
                          }}
                          className="bg-white/5 border-amber-400/30 text-amber-300 hover:bg-amber-500/20"
                        >
                          Открыть
                        </Button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
