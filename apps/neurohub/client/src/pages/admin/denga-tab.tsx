// Eugene 2026-05-24 Босс «Агент Деньга — отчёт в админке». Cost tracking +
// profit analysis с разбивкой по авторам / трекам / анонимам + period selector
// + ручной ввод стоимости.
//
// Источники данных (все requireAdmin):
//   GET /api/admin/v304/denga/aggregates?period=X
//   GET /api/admin/v304/denga/users?period=X&search=&sortBy=&sortDir=
//   GET /api/admin/v304/denga/tracks?period=X&search=&userId=
//   GET /api/admin/v304/denga/tracks/:genId  — детали + manual history
//   GET /api/admin/v304/denga/anonymous?period=X
//   GET /api/admin/v304/denga/tariffs
//   POST /api/admin/v304/denga/manual-cost  body: {genId, sunoCost?, chatCost?, coverCost?, lyricsCost?, notes?}
//
// Brand-style consistency rule: glass-card, brand palette, font-display titles,
// font-mono для цифр. Same-zone-same-style для метрик.

import { useState, useMemo } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";

type Period = "today" | "yesterday" | "7d" | "30d" | "365d" | "all";

interface DengaAggregates {
  periodLabel: string;
  fromIso: string;
  toIso: string;
  totalUsers: number;
  totalTracks: number;
  totalLyrics: number;
  totalCovers: number;
  totalRevenue: number;
  totalCost: number;
  totalChatCost: number;
  anonymousChatCost: number;
  manualSalesRevenue: number;
  totalProfit: number;
  avgProfitPerTrack: number;
  avgCostPerTrack: number;
  avgRevenuePerTrack: number;
  generatedAt: string;
}

interface ManualSaleRow {
  id: number;
  userId: number | null;
  amountKopecks: number;
  trackQty: number;
  note: string | null;
  adminId: number | null;
  createdAt: string | null;
  userEmail: string | null;
  userName: string | null;
}

interface DengaUserStats {
  userId: number;
  name: string;
  phone: string | null;
  email: string | null;
  createdAt: string | null;
  totalRevenue: number;
  totalCost: number;
  profit: number;
  tracksCount: number;
  lyricsCount: number;
  coversCount: number;
  chatCost: number;
  totalGenerations: number;
  avgProfitPerTrack: number;
  avgCostPerTrack: number;
  avgRevenuePerTrack: number;
  balance: number;
  bonusTracks: number;
}

interface DengaTrackStats {
  genId: number;
  userId: number | null;
  userName: string;
  type: string;
  title: string;
  createdAt: string | null;
  status: string;
  voiceType: string | null;
  sunoCost: number;
  chatCost: number;
  coverCost: number;
  lyricsCost: number;
  totalCost: number;
  revenue: number;
  profit: number;
  hasManualOverride: boolean;
}

interface DengaAnonymous {
  sessions: number;
  messagesCount: number;
  totalChatCost: number;
  avgCostPerSession: number;
  byChannel: Record<string, { sessions: number; messages: number; cost: number }>;
}

interface ProviderTariff {
  id: string;
  provider: string;
  resource: string;
  unit: string;
  costKopecks: number;
  validFrom: number;
  validUntil?: number;
  notes?: string;
}

const PERIODS: Period[] = ["today", "yesterday", "7d", "30d", "365d", "all"];
const PERIOD_LABELS: Record<Period, string> = {
  today: "Сегодня",
  yesterday: "Вчера",
  "7d": "Неделя",
  "30d": "Месяц",
  "365d": "Год",
  all: "Всё время",
};

type SubTab = "summary" | "users" | "tracks" | "anonymous" | "tariffs" | "override" | "manualSale";

function rub(kopecks: number): string {
  if (!Number.isFinite(kopecks)) return "0 ₽";
  return `${(kopecks / 100).toLocaleString("ru-RU", { maximumFractionDigits: 0 })} ₽`;
}

function rubPrecise(kopecks: number): string {
  if (!Number.isFinite(kopecks)) return "0,00 ₽";
  return `${(kopecks / 100).toLocaleString("ru-RU", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })} ₽`;
}

function num(n: number): string {
  if (!Number.isFinite(n)) return "0";
  return n.toLocaleString("ru-RU");
}

function fmtDate(iso: string | null): string {
  if (!iso) return "—";
  try {
    const d = new Date(iso);
    return d.toLocaleString("ru-RU", { dateStyle: "short", timeStyle: "short" });
  } catch {
    return iso;
  }
}

function fetcher<T>(url: string, init?: RequestInit): Promise<T> {
  return fetch(url, { credentials: "include", ...init }).then(async (r) => {
    if (!r.ok) {
      const txt = await r.text();
      throw new Error(`${r.status}: ${txt.slice(0, 200)}`);
    }
    const j = await r.json();
    if (j.error) throw new Error(j.error);
    return (j.data ?? j) as T;
  });
}

function copyText(text: string) {
  if (typeof navigator !== "undefined" && navigator.clipboard) {
    navigator.clipboard.writeText(text);
  }
}

// ============================================================
// Summary cards (5)
// ============================================================
function SummaryCards({ agg }: { agg: DengaAggregates }) {
  return (
    <div className="grid grid-cols-2 lg:grid-cols-5 gap-3">
      {/* Прибыль */}
      <Card className="glass-card border border-purple-500/30">
        <CardContent className="p-4">
          <div className="text-[10px] font-sans text-muted-foreground uppercase tracking-wide mb-2">
            💰 Прибыль (общая)
          </div>
          <div
            className={`font-mono font-bold text-xl sm:text-2xl ${
              agg.totalProfit >= 0
                ? "bg-gradient-to-r from-emerald-300 via-green-400 to-cyan-300 bg-clip-text text-transparent"
                : "text-red-400"
            }`}
          >
            {rub(agg.totalProfit)}
          </div>
        </CardContent>
      </Card>

      {/* Выручка */}
      <Card className="glass-card border border-cyan-500/30">
        <CardContent className="p-4">
          <div className="text-[10px] font-sans text-muted-foreground uppercase tracking-wide mb-2">
            📈 Выручка
          </div>
          <div className="font-mono font-bold text-xl sm:text-2xl bg-gradient-to-r from-blue-400 via-cyan-400 to-emerald-300 bg-clip-text text-transparent">
            {rub(agg.totalRevenue)}
          </div>
          {agg.manualSalesRevenue > 0 && (
            <div className="text-[10px] font-sans text-muted-foreground mt-1 whitespace-nowrap">
              из них ручные: {rub(agg.manualSalesRevenue)}
            </div>
          )}
        </CardContent>
      </Card>

      {/* Затраты */}
      <Card className="glass-card border border-fuchsia-500/30">
        <CardContent className="p-4">
          <div className="text-[10px] font-sans text-muted-foreground uppercase tracking-wide mb-2">
            💸 Затраты
          </div>
          <div className="font-mono font-bold text-xl sm:text-2xl bg-gradient-to-r from-fuchsia-400 via-pink-300 to-purple-300 bg-clip-text text-transparent">
            {rub(agg.totalCost)}
          </div>
          <div className="text-[10px] font-sans text-muted-foreground mt-1">
            chat {rub(agg.totalChatCost)} · anon {rub(agg.anonymousChatCost)}
          </div>
        </CardContent>
      </Card>

      {/* Средняя прибыль на 1 трек */}
      <Card className="glass-card border border-amber-500/30">
        <CardContent className="p-4">
          <div className="text-[10px] font-sans text-muted-foreground uppercase tracking-wide mb-2">
            🎵 Средняя прибыль / трек
          </div>
          <div
            className={`font-mono font-bold text-xl sm:text-2xl ${
              agg.avgProfitPerTrack >= 0
                ? "bg-gradient-to-r from-amber-300 via-yellow-300 to-orange-300 bg-clip-text text-transparent"
                : "text-red-400"
            }`}
          >
            {rub(agg.avgProfitPerTrack)}
          </div>
        </CardContent>
      </Card>

      {/* Средняя стоимость на 1 трек */}
      <Card className="glass-card border border-purple-500/30">
        <CardContent className="p-4">
          <div className="text-[10px] font-sans text-muted-foreground uppercase tracking-wide mb-2">
            🎯 Средняя стоимость / трек
          </div>
          <div className="font-mono font-bold text-xl sm:text-2xl bg-gradient-to-r from-purple-400 via-violet-300 to-cyan-300 bg-clip-text text-transparent">
            {rub(agg.avgCostPerTrack)}
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

// ============================================================
// Users sub-tab
// ============================================================
function UsersSubTab({ period }: { period: Period }) {
  const [search, setSearch] = useState("");
  const [sortBy, setSortBy] = useState<"profit" | "revenue" | "cost" | "tracks" | "id">("profit");

  const q = useQuery({
    queryKey: ["denga-users", period, search, sortBy],
    queryFn: () =>
      fetcher<{ users: DengaUserStats[]; total: number }>(
        `/api/admin/v304/denga/users?period=${period}&search=${encodeURIComponent(search)}&sortBy=${sortBy}&sortDir=desc&limit=200`,
      ),
    refetchInterval: 60_000,
    refetchOnWindowFocus: false,
  });

  return (
    <Card className="glass-card border border-purple-500/30">
      <CardContent className="p-4 sm:p-6 space-y-4">
        <div className="flex flex-wrap items-center gap-2">
          <Input
            placeholder="Поиск: имя / phone / email / userId..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="flex-1 min-w-[200px] bg-white/5 border-purple-400/30 text-white"
          />
          <select
            value={sortBy}
            onChange={(e) => setSortBy(e.target.value as any)}
            className="px-3 py-2 rounded-md bg-white/5 border border-purple-400/30 text-white text-sm font-sans"
          >
            <option value="profit">по прибыли</option>
            <option value="revenue">по выручке</option>
            <option value="cost">по затратам</option>
            <option value="tracks">по трекам</option>
            <option value="id">по ID</option>
          </select>
          <Button
            variant="outline"
            size="sm"
            onClick={() => q.refetch()}
            disabled={q.isFetching}
            className="bg-white/5 border-purple-400/30 text-purple-300 hover:bg-purple-500/20"
          >
            {q.isFetching ? "⏳" : "🔄"} Обновить
          </Button>
        </div>

        {q.isLoading && <div className="text-sm text-muted-foreground">Загрузка...</div>}
        {q.error && <div className="text-sm text-red-400">Ошибка: {(q.error as Error).message}</div>}
        {q.data && (
          <>
            <div className="text-xs text-muted-foreground">
              Показано: {q.data.users.length} из {q.data.total}
            </div>
            <div className="overflow-x-auto">
              <table className="w-full text-sm font-sans border-collapse">
                <thead>
                  <tr className="border-b border-purple-400/20 text-left">
                    <th className="py-2 px-2 text-xs uppercase text-muted-foreground">ID</th>
                    <th className="py-2 px-2 text-xs uppercase text-muted-foreground">Автор</th>
                    <th className="py-2 px-2 text-xs uppercase text-muted-foreground">Контакт</th>
                    <th className="py-2 px-2 text-xs uppercase text-muted-foreground text-right">Треки</th>
                    <th className="py-2 px-2 text-xs uppercase text-muted-foreground text-right">Выручка</th>
                    <th className="py-2 px-2 text-xs uppercase text-muted-foreground text-right">Затраты</th>
                    <th className="py-2 px-2 text-xs uppercase text-muted-foreground text-right">Чат</th>
                    <th className="py-2 px-2 text-xs uppercase text-muted-foreground text-right">Прибыль</th>
                    <th className="py-2 px-2 text-xs uppercase text-muted-foreground text-right">Ср. прибыль/трек</th>
                  </tr>
                </thead>
                <tbody>
                  {q.data.users.map((u) => (
                    <tr key={u.userId} className="border-b border-white/5 hover:bg-purple-500/5">
                      <td className="py-2 px-2 font-mono text-[12px] text-cyan-300">{u.userId}</td>
                      <td className="py-2 px-2 text-white">{u.name || "—"}</td>
                      <td className="py-2 px-2 text-[11px] text-muted-foreground">
                        {u.phone && <div>{u.phone}</div>}
                        {u.email && <div className="truncate max-w-[180px]">{u.email}</div>}
                      </td>
                      <td className="py-2 px-2 font-mono text-right text-white/80">
                        {num(u.tracksCount)}
                        {u.coversCount > 0 && <span className="text-[10px] text-fuchsia-300"> +{u.coversCount}c</span>}
                        {u.lyricsCount > 0 && <span className="text-[10px] text-cyan-300"> +{u.lyricsCount}л</span>}
                      </td>
                      <td className="py-2 px-2 font-mono text-right text-cyan-300">{rub(u.totalRevenue)}</td>
                      <td className="py-2 px-2 font-mono text-right text-fuchsia-300">{rub(u.totalCost)}</td>
                      <td className="py-2 px-2 font-mono text-right text-[11px] text-purple-300">
                        {rub(u.chatCost)}
                      </td>
                      <td
                        className={`py-2 px-2 font-mono text-right font-bold ${
                          u.profit >= 0 ? "text-emerald-300" : "text-red-400"
                        }`}
                      >
                        {rub(u.profit)}
                      </td>
                      <td className="py-2 px-2 font-mono text-right text-amber-300">
                        {rub(u.avgProfitPerTrack)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {q.data.users.length === 0 && (
              <div className="text-center text-sm text-muted-foreground py-8">
                Нет данных по фильтру. Измените поиск или период.
              </div>
            )}
          </>
        )}
      </CardContent>
    </Card>
  );
}

// ============================================================
// Tracks sub-tab
// ============================================================
function TracksSubTab({ period }: { period: Period }) {
  const [search, setSearch] = useState("");
  const [userId, setUserId] = useState("");

  const url = useMemo(() => {
    const u = `/api/admin/v304/denga/tracks?period=${period}&search=${encodeURIComponent(search)}&limit=200`;
    return userId ? `${u}&userId=${userId}` : u;
  }, [period, search, userId]);

  const q = useQuery({
    queryKey: ["denga-tracks", period, search, userId],
    queryFn: () => fetcher<{ tracks: DengaTrackStats[]; total: number }>(url),
    refetchInterval: 60_000,
    refetchOnWindowFocus: false,
  });

  return (
    <Card className="glass-card border border-purple-500/30">
      <CardContent className="p-4 sm:p-6 space-y-4">
        <div className="flex flex-wrap items-center gap-2">
          <Input
            placeholder="Поиск по названию / prompt..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="flex-1 min-w-[200px] bg-white/5 border-purple-400/30 text-white"
          />
          <Input
            placeholder="UserID (опционально)"
            value={userId}
            onChange={(e) => setUserId(e.target.value.replace(/[^\d]/g, ""))}
            className="w-32 bg-white/5 border-purple-400/30 text-white"
          />
          <Button
            variant="outline"
            size="sm"
            onClick={() => q.refetch()}
            disabled={q.isFetching}
            className="bg-white/5 border-purple-400/30 text-purple-300 hover:bg-purple-500/20"
          >
            {q.isFetching ? "⏳" : "🔄"} Обновить
          </Button>
        </div>

        {q.isLoading && <div className="text-sm text-muted-foreground">Загрузка...</div>}
        {q.error && <div className="text-sm text-red-400">Ошибка: {(q.error as Error).message}</div>}
        {q.data && (
          <>
            <div className="text-xs text-muted-foreground">
              Показано: {q.data.tracks.length} из {q.data.total}
            </div>
            <div className="overflow-x-auto">
              <table className="w-full text-sm font-sans border-collapse">
                <thead>
                  <tr className="border-b border-purple-400/20 text-left">
                    <th className="py-2 px-2 text-xs uppercase text-muted-foreground">ID</th>
                    <th className="py-2 px-2 text-xs uppercase text-muted-foreground">Тип</th>
                    <th className="py-2 px-2 text-xs uppercase text-muted-foreground">Название</th>
                    <th className="py-2 px-2 text-xs uppercase text-muted-foreground">Автор</th>
                    <th className="py-2 px-2 text-xs uppercase text-muted-foreground">Дата</th>
                    <th className="py-2 px-2 text-xs uppercase text-muted-foreground text-right">Suno</th>
                    <th className="py-2 px-2 text-xs uppercase text-muted-foreground text-right">Чат</th>
                    <th className="py-2 px-2 text-xs uppercase text-muted-foreground text-right">Cover</th>
                    <th className="py-2 px-2 text-xs uppercase text-muted-foreground text-right">Lyrics</th>
                    <th className="py-2 px-2 text-xs uppercase text-muted-foreground text-right">Затраты</th>
                    <th className="py-2 px-2 text-xs uppercase text-muted-foreground text-right">Выручка</th>
                    <th className="py-2 px-2 text-xs uppercase text-muted-foreground text-right">Прибыль</th>
                  </tr>
                </thead>
                <tbody>
                  {q.data.tracks.map((t) => (
                    <tr key={t.genId} className="border-b border-white/5 hover:bg-purple-500/5">
                      <td className="py-2 px-2 font-mono text-[11px] text-cyan-300">
                        {t.genId}
                        {t.hasManualOverride && (
                          <span title="Ручной override" className="ml-1 text-amber-300">✋</span>
                        )}
                      </td>
                      <td className="py-2 px-2 text-[11px] text-purple-300 uppercase">{t.type}</td>
                      <td className="py-2 px-2 text-white max-w-[200px] truncate" title={t.title}>
                        {t.title}
                      </td>
                      <td className="py-2 px-2 text-[11px] text-muted-foreground">{t.userName}</td>
                      <td className="py-2 px-2 text-[10px] font-mono text-muted-foreground">
                        {fmtDate(t.createdAt)}
                      </td>
                      <td className="py-2 px-2 font-mono text-right text-[11px] text-fuchsia-300">
                        {rub(t.sunoCost)}
                      </td>
                      <td className="py-2 px-2 font-mono text-right text-[11px] text-purple-300">
                        {rub(t.chatCost)}
                      </td>
                      <td className="py-2 px-2 font-mono text-right text-[11px] text-cyan-300">
                        {t.coverCost > 0 ? rub(t.coverCost) : "—"}
                      </td>
                      <td className="py-2 px-2 font-mono text-right text-[11px] text-amber-300">
                        {t.lyricsCost > 0 ? rub(t.lyricsCost) : "—"}
                      </td>
                      <td className="py-2 px-2 font-mono text-right text-fuchsia-300 font-bold">
                        {rub(t.totalCost)}
                      </td>
                      <td className="py-2 px-2 font-mono text-right text-cyan-300">
                        {rub(t.revenue)}
                      </td>
                      <td
                        className={`py-2 px-2 font-mono text-right font-bold ${
                          t.profit >= 0 ? "text-emerald-300" : "text-red-400"
                        }`}
                      >
                        {rub(t.profit)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {q.data.tracks.length === 0 && (
              <div className="text-center text-sm text-muted-foreground py-8">
                Нет треков по фильтру.
              </div>
            )}
          </>
        )}
      </CardContent>
    </Card>
  );
}

// ============================================================
// Anonymous sub-tab
// ============================================================
function AnonymousSubTab({ period }: { period: Period }) {
  const q = useQuery({
    queryKey: ["denga-anon", period],
    queryFn: () => fetcher<DengaAnonymous>(`/api/admin/v304/denga/anonymous?period=${period}`),
    refetchInterval: 60_000,
    refetchOnWindowFocus: false,
  });

  return (
    <Card className="glass-card border border-purple-500/30">
      <CardContent className="p-4 sm:p-6 space-y-4">
        <div className="text-sm font-sans text-muted-foreground">
          Затраты на чат с незарегистрированными юзерами (anonymous sessions без userId).
          Это наши расходы провайдерам LLM, которые мы НЕ возвращаем как revenue.
        </div>
        {q.isLoading && <div className="text-sm text-muted-foreground">Загрузка...</div>}
        {q.error && <div className="text-sm text-red-400">Ошибка: {(q.error as Error).message}</div>}
        {q.data && (
          <>
            <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
              <Card className="glass-card border border-purple-500/30">
                <CardContent className="p-4">
                  <div className="text-[10px] text-muted-foreground uppercase mb-1">Сессий</div>
                  <div className="font-mono font-bold text-xl bg-gradient-to-r from-purple-400 via-violet-300 to-cyan-300 bg-clip-text text-transparent">
                    {num(q.data.sessions)}
                  </div>
                </CardContent>
              </Card>
              <Card className="glass-card border border-cyan-500/30">
                <CardContent className="p-4">
                  <div className="text-[10px] text-muted-foreground uppercase mb-1">Ответов бота</div>
                  <div className="font-mono font-bold text-xl bg-gradient-to-r from-cyan-400 to-blue-400 bg-clip-text text-transparent">
                    {num(q.data.messagesCount)}
                  </div>
                </CardContent>
              </Card>
              <Card className="glass-card border border-fuchsia-500/30">
                <CardContent className="p-4">
                  <div className="text-[10px] text-muted-foreground uppercase mb-1">Затраты</div>
                  <div className="font-mono font-bold text-xl bg-gradient-to-r from-fuchsia-400 to-pink-300 bg-clip-text text-transparent">
                    {rub(q.data.totalChatCost)}
                  </div>
                </CardContent>
              </Card>
              <Card className="glass-card border border-amber-500/30">
                <CardContent className="p-4">
                  <div className="text-[10px] text-muted-foreground uppercase mb-1">Ср. на 1 сессию</div>
                  <div className="font-mono font-bold text-xl bg-gradient-to-r from-amber-300 to-orange-300 bg-clip-text text-transparent">
                    {rubPrecise(q.data.avgCostPerSession)}
                  </div>
                </CardContent>
              </Card>
            </div>

            <div className="overflow-x-auto">
              <h3 className="text-sm font-sans font-bold text-white/80 mb-2">По каналам:</h3>
              <table className="w-full text-sm font-sans border-collapse">
                <thead>
                  <tr className="border-b border-purple-400/20 text-left">
                    <th className="py-2 px-2 text-xs uppercase text-muted-foreground">Канал</th>
                    <th className="py-2 px-2 text-xs uppercase text-muted-foreground text-right">Сессий</th>
                    <th className="py-2 px-2 text-xs uppercase text-muted-foreground text-right">Сообщений</th>
                    <th className="py-2 px-2 text-xs uppercase text-muted-foreground text-right">Затраты</th>
                  </tr>
                </thead>
                <tbody>
                  {Object.entries(q.data.byChannel).map(([ch, v]) => (
                    <tr key={ch} className="border-b border-white/5">
                      <td className="py-2 px-2 text-white capitalize">{ch}</td>
                      <td className="py-2 px-2 font-mono text-right text-purple-300">{num(v.sessions)}</td>
                      <td className="py-2 px-2 font-mono text-right text-cyan-300">{num(v.messages)}</td>
                      <td className="py-2 px-2 font-mono text-right text-fuchsia-300">{rub(v.cost)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
}

// ============================================================
// Tariffs sub-tab
// ============================================================
function TariffsSubTab() {
  const q = useQuery({
    queryKey: ["denga-tariffs"],
    queryFn: () =>
      fetcher<{ current: ProviderTariff[]; history: ProviderTariff[] }>(
        "/api/admin/v304/denga/tariffs",
      ),
    refetchOnWindowFocus: false,
  });

  return (
    <Card className="glass-card border border-purple-500/30">
      <CardContent className="p-4 sm:p-6 space-y-4">
        <div className="text-sm font-sans text-muted-foreground">
          Тарифы провайдеров (наши OUT-of-pocket затраты, не PRICES для юзеров).
          Версионирование через validFrom/validUntil. Меняются через правку
          <code className="font-mono text-purple-300 mx-1">server/lib/providerTariffs.ts</code>.
        </div>
        {q.isLoading && <div className="text-sm text-muted-foreground">Загрузка...</div>}
        {q.error && <div className="text-sm text-red-400">Ошибка: {(q.error as Error).message}</div>}
        {q.data && (
          <div className="overflow-x-auto">
            <h3 className="text-sm font-sans font-bold text-white/80 mb-2">
              Актуальные тарифы ({q.data.current.length}):
            </h3>
            <table className="w-full text-sm font-sans border-collapse">
              <thead>
                <tr className="border-b border-purple-400/20 text-left">
                  <th className="py-2 px-2 text-xs uppercase text-muted-foreground">Provider</th>
                  <th className="py-2 px-2 text-xs uppercase text-muted-foreground">Resource</th>
                  <th className="py-2 px-2 text-xs uppercase text-muted-foreground">Unit</th>
                  <th className="py-2 px-2 text-xs uppercase text-muted-foreground text-right">Cost</th>
                  <th className="py-2 px-2 text-xs uppercase text-muted-foreground">С даты</th>
                  <th className="py-2 px-2 text-xs uppercase text-muted-foreground">Комментарий</th>
                </tr>
              </thead>
              <tbody>
                {q.data.current.map((t) => (
                  <tr key={t.id} className="border-b border-white/5">
                    <td className="py-2 px-2 font-mono text-[11px] text-purple-300">{t.provider}</td>
                    <td className="py-2 px-2 font-mono text-[11px] text-cyan-300">{t.resource}</td>
                    <td className="py-2 px-2 text-[11px] text-muted-foreground">{t.unit}</td>
                    <td className="py-2 px-2 font-mono text-right text-fuchsia-300 font-bold">
                      {rubPrecise(t.costKopecks)}
                    </td>
                    <td className="py-2 px-2 text-[10px] font-mono text-muted-foreground">
                      {fmtDate(new Date(t.validFrom).toISOString())}
                    </td>
                    <td className="py-2 px-2 text-[11px] text-muted-foreground max-w-[300px]">
                      {t.notes || "—"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

// ============================================================
// Manual cost override sub-tab
// ============================================================
function OverrideSubTab() {
  const queryClient = useQueryClient();
  const [genId, setGenId] = useState("");
  const [sunoCost, setSunoCost] = useState("");
  const [chatCost, setChatCost] = useState("");
  const [coverCost, setCoverCost] = useState("");
  const [lyricsCost, setLyricsCost] = useState("");
  const [notes, setNotes] = useState("");
  const [lookupResult, setLookupResult] = useState<DengaTrackStats | null>(null);
  const [lookupError, setLookupError] = useState<string | null>(null);
  const [submitMsg, setSubmitMsg] = useState<string | null>(null);

  const lookup = async () => {
    setLookupError(null);
    setLookupResult(null);
    if (!genId) {
      setLookupError("Введите genId");
      return;
    }
    try {
      const result = await fetcher<{ track: DengaTrackStats }>(
        `/api/admin/v304/denga/tracks/${genId}`,
      );
      setLookupResult(result.track);
      // Pre-fill in kopecks
      setSunoCost(result.track.sunoCost > 0 ? String(result.track.sunoCost) : "");
      setChatCost(result.track.chatCost > 0 ? String(result.track.chatCost) : "");
      setCoverCost(result.track.coverCost > 0 ? String(result.track.coverCost) : "");
      setLyricsCost(result.track.lyricsCost > 0 ? String(result.track.lyricsCost) : "");
    } catch (e: any) {
      setLookupError(e?.message || "Ошибка поиска");
    }
  };

  const mutation = useMutation({
    mutationFn: async () => {
      const body: any = { genId: Number(genId) };
      if (sunoCost) body.sunoCost = Number(sunoCost);
      if (chatCost) body.chatCost = Number(chatCost);
      if (coverCost) body.coverCost = Number(coverCost);
      if (lyricsCost) body.lyricsCost = Number(lyricsCost);
      if (notes) body.notes = notes;
      return fetcher<{ ok: boolean; id: number }>(
        "/api/admin/v304/denga/manual-cost",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        },
      );
    },
    onSuccess: (r: any) => {
      setSubmitMsg(`✅ Сохранено (override #${r.id})`);
      queryClient.invalidateQueries({ queryKey: ["denga-users"] });
      queryClient.invalidateQueries({ queryKey: ["denga-tracks"] });
      queryClient.invalidateQueries({ queryKey: ["denga-aggregates"] });
    },
    onError: (e: any) => {
      setSubmitMsg(`❌ Ошибка: ${e?.message || e}`);
    },
  });

  return (
    <Card className="glass-card border border-amber-500/30">
      <CardContent className="p-4 sm:p-6 space-y-4">
        <div className="text-sm font-sans text-muted-foreground">
          Ручной ввод стоимости для конкретной generation. Override применяется только к
          указанным полям (null = use tariff). Все правки попадают в audit log.
          Все суммы — в <strong>копейках</strong> (1 ₽ = 100 коп.).
        </div>

        <div className="flex gap-2">
          <Input
            placeholder="Generation ID..."
            value={genId}
            onChange={(e) => setGenId(e.target.value.replace(/[^\d]/g, ""))}
            className="flex-1 max-w-xs bg-white/5 border-amber-400/30 text-white"
          />
          <Button
            onClick={lookup}
            className="bg-gradient-to-r from-amber-500 to-orange-500 text-white"
          >
            🔍 Найти
          </Button>
        </div>

        {lookupError && (
          <div className="text-sm text-red-400 p-3 bg-red-500/10 rounded-lg border border-red-400/30">
            {lookupError}
          </div>
        )}

        {lookupResult && (
          <div className="p-3 bg-purple-500/10 rounded-lg border border-purple-400/30 space-y-2 text-[12px]">
            <div className="font-bold text-white">
              #{lookupResult.genId} · {lookupResult.title}
            </div>
            <div className="text-muted-foreground">
              Автор: <span className="text-purple-300">{lookupResult.userName}</span> ·{" "}
              Тип: <span className="text-cyan-300">{lookupResult.type}</span> ·{" "}
              Дата: <span className="font-mono">{fmtDate(lookupResult.createdAt)}</span>
            </div>
            <div className="grid grid-cols-2 md:grid-cols-4 gap-2 text-xs">
              <div>Suno: <span className="font-mono text-fuchsia-300">{rub(lookupResult.sunoCost)}</span></div>
              <div>Chat: <span className="font-mono text-purple-300">{rub(lookupResult.chatCost)}</span></div>
              <div>Cover: <span className="font-mono text-cyan-300">{rub(lookupResult.coverCost)}</span></div>
              <div>Lyrics: <span className="font-mono text-amber-300">{rub(lookupResult.lyricsCost)}</span></div>
            </div>
            <div className="text-xs">
              Revenue: <span className="font-mono text-cyan-300">{rub(lookupResult.revenue)}</span> ·{" "}
              Cost: <span className="font-mono text-fuchsia-300">{rub(lookupResult.totalCost)}</span> ·{" "}
              Profit: <span className={`font-mono font-bold ${lookupResult.profit >= 0 ? "text-emerald-300" : "text-red-400"}`}>
                {rub(lookupResult.profit)}
              </span>
            </div>
          </div>
        )}

        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="text-xs text-muted-foreground block mb-1">Suno cost (копейки)</label>
            <Input
              placeholder="22000 = 220₽"
              value={sunoCost}
              onChange={(e) => setSunoCost(e.target.value.replace(/[^\d]/g, ""))}
              className="bg-white/5 border-purple-400/30 text-white font-mono"
            />
          </div>
          <div>
            <label className="text-xs text-muted-foreground block mb-1">Chat cost (копейки)</label>
            <Input
              placeholder="500 = 5₽"
              value={chatCost}
              onChange={(e) => setChatCost(e.target.value.replace(/[^\d]/g, ""))}
              className="bg-white/5 border-purple-400/30 text-white font-mono"
            />
          </div>
          <div>
            <label className="text-xs text-muted-foreground block mb-1">Cover cost (копейки)</label>
            <Input
              placeholder="5000 = 50₽"
              value={coverCost}
              onChange={(e) => setCoverCost(e.target.value.replace(/[^\d]/g, ""))}
              className="bg-white/5 border-purple-400/30 text-white font-mono"
            />
          </div>
          <div>
            <label className="text-xs text-muted-foreground block mb-1">Lyrics cost (копейки)</label>
            <Input
              placeholder="2000 = 20₽"
              value={lyricsCost}
              onChange={(e) => setLyricsCost(e.target.value.replace(/[^\d]/g, ""))}
              className="bg-white/5 border-purple-400/30 text-white font-mono"
            />
          </div>
        </div>

        <div>
          <label className="text-xs text-muted-foreground block mb-1">Заметка (опционально)</label>
          <Textarea
            placeholder="Например: «promo discount от Suno на эту дату, реальный cost ниже»"
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            className="bg-white/5 border-purple-400/30 text-white"
            rows={2}
          />
        </div>

        <div className="flex gap-2 items-center">
          <Button
            onClick={() => mutation.mutate()}
            disabled={!genId || mutation.isPending}
            className="bg-gradient-to-r from-purple-500 via-fuchsia-500 to-blue-500 text-white shadow-[0_0_24px_rgba(124,58,237,0.5)]"
          >
            💾 Сохранить override
          </Button>
          {submitMsg && <div className="text-sm">{submitMsg}</div>}
        </div>
      </CardContent>
    </Card>
  );
}

// ============================================================
// Manual sale sub-tab — Eugene 2026-05-29 Босс «ручной ввод продажи».
// Пакеты продаются офлайн («10 треков — 2990 ₽»). Записываем выручку +
// начисляем бонус-треки покупателю (если указан). Аноним = только выручка.
// ============================================================
function ManualSaleSubTab() {
  const queryClient = useQueryClient();
  const [userRef, setUserRef] = useState(""); // email или числовой id
  const [trackQty, setTrackQty] = useState("10");
  const [amountRub, setAmountRub] = useState("2990");
  const [note, setNote] = useState("");
  const [submitMsg, setSubmitMsg] = useState("");

  const sales = useQuery({
    queryKey: ["denga-manual-sales"],
    queryFn: () =>
      fetcher<ManualSaleRow[]>("/api/admin/v304/denga/manual-sales?limit=50"),
    refetchOnWindowFocus: false,
  });

  const mutation = useMutation({
    mutationFn: async () => {
      const ref = userRef.trim();
      const isNumericId = /^\d+$/.test(ref);
      const body: Record<string, unknown> = {
        amountRub: Number(amountRub),
        trackQty: Number(trackQty),
        note: note.trim() || undefined,
      };
      if (ref) {
        if (isNumericId) body.userId = Number(ref);
        else body.email = ref;
      }
      const r = await fetch("/api/admin/v304/denga/manual-sale", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const j = await r.json();
      if (!r.ok || j.ok === false) {
        throw new Error(j.error || `HTTP ${r.status}`);
      }
      return j as { ok: true; id: number; granted: boolean };
    },
    onSuccess: (r) => {
      setSubmitMsg(
        `✅ Продажа записана (#${r.id})${r.granted ? " · бонус-треки начислены" : " · без начисления (покупатель не указан)"}`,
      );
      setNote("");
      sales.refetch();
      queryClient.invalidateQueries({ queryKey: ["denga-aggregates"] });
      queryClient.invalidateQueries({ queryKey: ["denga-users"] });
    },
    onError: (e: any) => {
      setSubmitMsg(`❌ Ошибка: ${e?.message || e}`);
    },
  });

  return (
    <div className="space-y-4">
      <Card className="glass-card border border-emerald-500/30">
        <CardContent className="p-4 sm:p-6 space-y-4">
          <div className="text-sm font-sans text-muted-foreground">
            Запись офлайн-продажи пакета (например «10 треков — 2990 ₽»). Выручка
            попадёт в Деньгу <strong>дополнительно</strong> к доходу по трекам.
            Если указан покупатель (email или ID) — ему начислятся бонус-треки.
            Без покупателя продажа учитывается только как выручка.
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            <div>
              <label className="text-xs text-muted-foreground block mb-1">
                Покупатель — email или ID (опционально)
              </label>
              <Input
                placeholder="user@mail.ru или 123"
                value={userRef}
                onChange={(e) => setUserRef(e.target.value)}
                className="bg-white/5 border-emerald-400/30 text-white"
              />
            </div>
            <div>
              <label className="text-xs text-muted-foreground block mb-1">
                Кол-во треков (бонус)
              </label>
              <Input
                placeholder="10"
                value={trackQty}
                onChange={(e) => setTrackQty(e.target.value.replace(/[^\d]/g, ""))}
                className="bg-white/5 border-emerald-400/30 text-white font-mono"
              />
            </div>
            <div>
              <label className="text-xs text-muted-foreground block mb-1">Сумма ₽</label>
              <Input
                placeholder="2990"
                value={amountRub}
                onChange={(e) => setAmountRub(e.target.value.replace(/[^\d.]/g, ""))}
                className="bg-white/5 border-emerald-400/30 text-white font-mono"
              />
            </div>
          </div>

          <div>
            <label className="text-xs text-muted-foreground block mb-1">Примечание (опционально)</label>
            <Textarea
              placeholder="Например: «оплата на карту, пакет 10 треков»"
              value={note}
              onChange={(e) => setNote(e.target.value)}
              className="bg-white/5 border-emerald-400/30 text-white"
              rows={2}
            />
          </div>

          <div className="flex gap-2 items-center flex-wrap">
            <Button
              onClick={() => mutation.mutate()}
              disabled={!amountRub || mutation.isPending}
              className="bg-gradient-to-r from-emerald-500 via-green-500 to-cyan-500 text-white shadow-[0_0_24px_rgba(16,185,129,0.45)]"
            >
              💵 Записать продажу
            </Button>
            {submitMsg && <div className="text-sm">{submitMsg}</div>}
          </div>
        </CardContent>
      </Card>

      {/* Recent manual sales */}
      <Card className="glass-card border border-cyan-500/30">
        <CardContent className="p-4 sm:p-6 space-y-3">
          <div className="text-sm font-sans font-bold text-white">Последние ручные продажи</div>
          {sales.isLoading && (
            <div className="text-sm text-muted-foreground">Загрузка...</div>
          )}
          {sales.error && (
            <div className="text-sm text-red-400">Ошибка: {(sales.error as Error).message}</div>
          )}
          {sales.data && sales.data.length === 0 && (
            <div className="text-sm text-muted-foreground">Пока нет записей.</div>
          )}
          {sales.data && sales.data.length > 0 && (
            <div className="overflow-x-auto">
              <table className="w-full text-[12px]">
                <thead>
                  <tr className="text-left text-muted-foreground border-b border-white/10">
                    <th className="py-2 pr-3">#</th>
                    <th className="py-2 pr-3">Покупатель</th>
                    <th className="py-2 pr-3 text-right">Сумма</th>
                    <th className="py-2 pr-3 text-right">Треков</th>
                    <th className="py-2 pr-3">Примечание</th>
                    <th className="py-2 pr-3">Дата</th>
                  </tr>
                </thead>
                <tbody>
                  {sales.data.map((s) => (
                    <tr key={s.id} className="border-b border-white/5">
                      <td className="py-2 pr-3 font-mono text-muted-foreground">{s.id}</td>
                      <td className="py-2 pr-3 min-w-0">
                        {s.userId != null ? (
                          <span className="text-purple-300 break-words">
                            {s.userEmail || s.userName || `ID ${s.userId}`}
                          </span>
                        ) : (
                          <span className="text-muted-foreground">аноним</span>
                        )}
                      </td>
                      <td className="py-2 pr-3 text-right font-mono text-cyan-300 whitespace-nowrap">
                        {rubPrecise(s.amountKopecks)}
                      </td>
                      <td className="py-2 pr-3 text-right font-mono text-emerald-300">{s.trackQty}</td>
                      <td className="py-2 pr-3 text-muted-foreground break-words max-w-[260px]">
                        {s.note || "—"}
                      </td>
                      <td className="py-2 pr-3 font-mono text-muted-foreground whitespace-nowrap">
                        {fmtDate(s.createdAt)}
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

// ============================================================
// Main tab
// ============================================================
export default function DengaTab() {
  // Eugene 2026-05-24 Босс «По умолчанию все данные в админ-панели — сегодня».
  const [period, setPeriod] = useState<Period>("today");
  const [subTab, setSubTab] = useState<SubTab>("summary");

  const agg = useQuery({
    queryKey: ["denga-aggregates", period],
    queryFn: () =>
      fetcher<DengaAggregates>(`/api/admin/v304/denga/aggregates?period=${period}`),
    refetchInterval: 60_000,
    refetchOnWindowFocus: false,
  });

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="glass-card rounded-2xl p-6 border border-amber-500/30">
        <div className="flex items-start gap-3 flex-wrap">
          <div className="flex-1 min-w-[200px]">
            <h2 className="text-xl sm:text-2xl font-display font-bold gradient-text mb-1">
              💰 Агент Деньга
            </h2>
            <p className="text-sm font-sans text-muted-foreground leading-relaxed">
              Cost tracking + profit analysis per user / per track + chat attribution
              + manual override. Apply Period-20-MSK rule (cut-off 20:00 МСК).
            </p>
          </div>
          {agg.data && (
            <Button
              variant="outline"
              size="sm"
              onClick={() => copyText(JSON.stringify(agg.data, null, 2))}
              className="bg-white/5 border-amber-400/30 text-amber-300 hover:bg-amber-500/20"
            >
              📋 Копировать сводку
            </Button>
          )}
          <Button
            variant="outline"
            size="sm"
            onClick={() => {
              fetcher("/api/admin/v304/denga/invalidate-cache", { method: "POST" });
              agg.refetch();
            }}
            className="bg-white/5 border-purple-400/30 text-purple-300 hover:bg-purple-500/20"
          >
            🔄 Cache reset
          </Button>
        </div>

        {/* Period selector */}
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

      {/* Summary cards */}
      {agg.isLoading && (
        <div className="glass-card rounded-2xl p-6 border border-purple-500/30 text-sm font-sans text-muted-foreground">
          Загрузка сводки...
        </div>
      )}
      {agg.error && (
        <div className="glass-card rounded-2xl p-6 border border-red-500/30 text-sm font-sans text-red-400">
          Ошибка: {(agg.error as Error).message}
        </div>
      )}
      {agg.data && (
        <>
          <SummaryCards agg={agg.data} />
          <div className="text-[10px] font-sans text-muted-foreground text-right">
            Период: {agg.data.periodLabel} ·{" "}
            юзеров: {num(agg.data.totalUsers)} ·{" "}
            треков: {num(agg.data.totalTracks)} ·{" "}
            обложек: {num(agg.data.totalCovers)} ·{" "}
            текстов: {num(agg.data.totalLyrics)} ·{" "}
            <span className="font-mono">{fmtDate(agg.data.generatedAt)}</span>
          </div>
        </>
      )}

      {/* Sub-tab navigation */}
      <div className="flex gap-2 flex-wrap border-b border-purple-400/20">
        {(
          [
            ["summary", "📊 Сводка"],
            ["users", "👥 По авторам"],
            ["tracks", "🎵 По трекам"],
            ["anonymous", "👤 Анонимы"],
            ["tariffs", "💵 Тарифы"],
            ["override", "✋ Ручной ввод"],
            ["manualSale", "💵 Ручная продажа"],
          ] as Array<[SubTab, string]>
        ).map(([key, label]) => (
          <button
            key={key}
            type="button"
            onClick={() => setSubTab(key)}
            className={`px-4 py-2 text-sm font-sans font-medium transition-all border-b-2 -mb-px ${
              subTab === key
                ? "border-fuchsia-400 text-fuchsia-300"
                : "border-transparent text-white/60 hover:text-white"
            }`}
          >
            {label}
          </button>
        ))}
      </div>

      {/* Sub-tab content */}
      {subTab === "summary" && agg.data && (
        <Card className="glass-card border border-purple-500/30">
          <CardContent className="p-6 space-y-3 text-sm">
            <div className="text-sm font-sans text-muted-foreground">
              Подробности по всем срезам — см. вкладки выше.
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 text-[12px]">
              <div className="flex justify-between border-b border-white/5 py-2">
                <span>Период:</span>
                <span className="font-mono text-purple-300">{agg.data.periodLabel}</span>
              </div>
              <div className="flex justify-between border-b border-white/5 py-2">
                <span>Сгенерировано:</span>
                <span className="font-mono text-muted-foreground">{fmtDate(agg.data.generatedAt)}</span>
              </div>
              <div className="flex justify-between border-b border-white/5 py-2">
                <span>Уникальных авторов:</span>
                <span className="font-mono text-cyan-300">{num(agg.data.totalUsers)}</span>
              </div>
              <div className="flex justify-between border-b border-white/5 py-2">
                <span>Музыкальных треков:</span>
                <span className="font-mono text-fuchsia-300">{num(agg.data.totalTracks)}</span>
              </div>
              <div className="flex justify-between border-b border-white/5 py-2">
                <span>Обложек:</span>
                <span className="font-mono text-cyan-300">{num(agg.data.totalCovers)}</span>
              </div>
              <div className="flex justify-between border-b border-white/5 py-2">
                <span>Текстов:</span>
                <span className="font-mono text-amber-300">{num(agg.data.totalLyrics)}</span>
              </div>
              <div className="flex justify-between border-b border-white/5 py-2">
                <span>Затраты на чат (auth):</span>
                <span className="font-mono text-purple-300">{rub(agg.data.totalChatCost)}</span>
              </div>
              <div className="flex justify-between border-b border-white/5 py-2">
                <span>Затраты на чат (anon):</span>
                <span className="font-mono text-fuchsia-300">{rub(agg.data.anonymousChatCost)}</span>
              </div>
              <div className="flex justify-between border-b border-white/5 py-2">
                <span>Ср. выручка / трек:</span>
                <span className="font-mono text-cyan-300">{rub(agg.data.avgRevenuePerTrack)}</span>
              </div>
              <div className="flex justify-between border-b border-white/5 py-2">
                <span>Ср. прибыль / трек:</span>
                <span
                  className={`font-mono font-bold ${
                    agg.data.avgProfitPerTrack >= 0 ? "text-emerald-300" : "text-red-400"
                  }`}
                >
                  {rub(agg.data.avgProfitPerTrack)}
                </span>
              </div>
            </div>
          </CardContent>
        </Card>
      )}
      {subTab === "users" && <UsersSubTab period={period} />}
      {subTab === "tracks" && <TracksSubTab period={period} />}
      {subTab === "anonymous" && <AnonymousSubTab period={period} />}
      {subTab === "tariffs" && <TariffsSubTab />}
      {subTab === "override" && <OverrideSubTab />}
      {subTab === "manualSale" && <ManualSaleSubTab />}
    </div>
  );
}
