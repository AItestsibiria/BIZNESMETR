// Eugene 2026-05-18 Босс «надо сделать кабинет авторов у админа для полного
// управления и привяжи все данные ip geo и чаты». Вкладка «👥 Авторы».
//
// Что показывает:
//  - Список авторов с фильтрами (Все/Активные/Заблокированные/Phone-only/
//    Email/Платящие), поиском (email/phone/name/id), sort (Last seen /
//    Registered / Generations count / Spent ₽), пагинация 50/страница.
//  - Карточка author: ФИО + email + phone (masked в списке), country flag,
//    Last seen, stats (треков N · потрачено ₽ · бонусов Y), status pill,
//    quick actions (👁 / 🚫 / 💬 / ✉).
//  - Drill-down модал с табами: Профиль / Треки / Платежи / Чаты / IP/Geo /
//    Действия Музы / Audit log.
//
// Brand-style: glass-card, font-display gradient-text для заголовков,
// font-mono для IDs/timestamps/IPs, palette purple/cyan/amber/pink.

import { useState, useMemo } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Loader2 } from "lucide-react";

// ---------- types ----------

type StatusFilter =
  | "all"
  | "active"
  | "blocked"
  | "phone_only"
  | "email"
  | "paying";

type SortKey = "last_seen" | "registered" | "generations" | "spent";

interface AuthorRow {
  id: number;
  name: string;
  email: string | null;
  phone: string | null;
  phoneVerified: boolean;
  emailVerified: boolean;
  role: string;
  blocked: boolean;
  bonusTracks: number;
  balance: number;
  country: string | null;
  countryCode: string | null;
  lastCountry: string | null;
  lastCity: string | null;
  referralCode: string | null;
  welcomeGiftGiven: boolean;
  gens: number;
  gensDone: number;
  gensError: number;
  spent: number;
  payments: number;
  lastSeenAt: string | null;
  createdAt: string | null;
}

interface ListResponse {
  total: number;
  page: number;
  limit: number;
  items: AuthorRow[];
}

interface AuthorDetail {
  user: any;
  counters: { total: number; done: number; error: number; processing: number };
  recentGenerations: any[];
  recentTransactions: any[];
  recentPayments: any[];
  chats: {
    sessions: Array<{ id: string; channel: string; startedAt: string | null; lastMessageAt: string | null; personaName: string | null }>;
    messages: Array<{ id: number; sessionId: string; channel: string; role: string; text: string; createdAt: string | null }>;
  };
  profiles: any[];
  muzaActions: any[];
  auditEntries: any[];
  failures: any[];
  blockedRecord: any;
}

// ---------- helpers ----------

function fetchJson<T>(url: string, opts?: RequestInit): Promise<T> {
  return fetch(url, { credentials: "include", ...opts }).then(async (r) => {
    if (!r.ok) throw new Error(`${r.status}: ${await r.text()}`);
    const j = await r.json();
    if (j.error) throw new Error(j.error);
    return j.data as T;
  });
}

function fmtDate(s: string | null | undefined): string {
  if (!s) return "—";
  try {
    return new Date(s).toLocaleString("ru-RU");
  } catch {
    return String(s);
  }
}

function fmtRel(s: string | null | undefined): string {
  if (!s) return "—";
  try {
    const t = new Date(s).getTime();
    const diffSec = Math.floor((Date.now() - t) / 1000);
    if (diffSec < 60) return `${diffSec}с`;
    if (diffSec < 3600) return `${Math.floor(diffSec / 60)}м`;
    if (diffSec < 86400) return `${Math.floor(diffSec / 3600)}ч`;
    return `${Math.floor(diffSec / 86400)}д`;
  } catch {
    return "—";
  }
}

function fmtRub(kopecks: number): string {
  if (!kopecks) return "0₽";
  return `${(kopecks / 100).toLocaleString("ru-RU", {
    maximumFractionDigits: 0,
  })}₽`;
}

function maskPhone(raw: string | null | undefined): string {
  if (!raw) return "—";
  const s = String(raw);
  if (s.length < 6) return s;
  return s.slice(0, 4) + "***" + s.slice(-2);
}

function countryFlag(code: string | null | undefined): string {
  if (!code || code.length !== 2) return "🌐";
  // ISO alpha-2 → emoji flag (regional indicator).
  try {
    const cc = code.toUpperCase();
    return String.fromCodePoint(
      ...[...cc].map((c) => 127397 + c.charCodeAt(0)),
    );
  } catch {
    return "🌐";
  }
}

function copyJson(obj: unknown, toast?: (o: { title: string }) => void) {
  try {
    const txt = JSON.stringify(obj, null, 2);
    navigator.clipboard.writeText(txt).then(() => {
      toast?.({ title: "Скопировано" });
    });
  } catch {}
}

function channelEmoji(ch: string): string {
  const c = ch.toLowerCase();
  if (c.includes("tele")) return "📱";
  if (c.includes("max")) return "🟦";
  if (c.includes("vk")) return "💙";
  if (c.includes("web")) return "🌐";
  if (c.includes("email")) return "✉";
  return "💬";
}

// ---------- main component ----------

export function AuthorsTab({ toast }: { toast?: any }) {
  const qc = useQueryClient();
  const [search, setSearch] = useState("");
  const [status, setStatus] = useState<StatusFilter>("all");
  const [sort, setSort] = useState<SortKey>("registered");
  const [page, setPage] = useState(1);
  const [openUserId, setOpenUserId] = useState<number | null>(null);

  const queryStr = useMemo(() => {
    const p = new URLSearchParams();
    if (search.trim().length >= 2) p.set("q", search.trim());
    if (status !== "all") p.set("status", status);
    p.set("sort", sort);
    p.set("page", String(page));
    p.set("limit", "50");
    return p.toString();
  }, [search, status, sort, page]);

  const listQ = useQuery<ListResponse>({
    queryKey: ["admin-authors", queryStr],
    queryFn: () => fetchJson<ListResponse>(`/api/admin/v304/authors?${queryStr}`),
    refetchInterval: 60_000,
  });

  return (
    <div className="space-y-4">
      <Card className="glass-card border-purple-500/20">
        <CardHeader>
          <CardTitle className="font-display gradient-text text-2xl">
            👥 Авторы — полный кабинет
          </CardTitle>
          <p className="text-xs font-sans text-muted-foreground mt-1">
            Управление авторами с привязкой всех данных: IP geo, чаты,
            треки, платежи, действия Музы. Admin-everything-except-delete:
            редактирование без подтверждения, удаление — через author confirm.
          </p>
        </CardHeader>
        <CardContent>
          {/* === Top bar: search + filters + sort === */}
          <div className="flex flex-wrap items-center gap-2 mb-4">
            <input
              type="text"
              placeholder="🔍 Email / телефон / имя / ID"
              value={search}
              onChange={(e) => {
                setSearch(e.target.value.slice(0, 200));
                setPage(1);
              }}
              className="text-xs font-sans px-3 py-1.5 rounded-md bg-white/5 border border-cyan-400/20 text-white focus:outline-none focus:border-cyan-400/60 flex-1 min-w-[180px]"
            />
            <div className="flex flex-wrap gap-1">
              {(
                [
                  ["all", "Все"],
                  ["active", "🟢 Активные"],
                  ["blocked", "🚫 Блок"],
                  ["phone_only", "📱 Phone"],
                  ["email", "✉ Email"],
                  ["paying", "💰 Платящие"],
                ] as const
              ).map(([k, l]) => (
                <button
                  key={k}
                  onClick={() => {
                    setStatus(k);
                    setPage(1);
                  }}
                  className={`text-[11px] font-sans px-2.5 py-1 rounded-md transition-colors ${
                    status === k
                      ? "bg-gradient-to-r from-purple-500 via-fuchsia-500 to-blue-500 text-white shadow-[0_0_16px_rgba(124,58,237,0.3)]"
                      : "bg-white/5 hover:bg-white/10 text-white/80"
                  }`}
                >
                  {l}
                </button>
              ))}
            </div>
            <select
              value={sort}
              onChange={(e) => {
                setSort(e.target.value as SortKey);
                setPage(1);
              }}
              className="text-[11px] font-sans px-2.5 py-1.5 rounded-md bg-white/5 border border-purple-400/20 text-white focus:outline-none focus:border-purple-400/60"
            >
              <option value="registered">📅 По регистрации</option>
              <option value="last_seen">👀 По last seen</option>
              <option value="generations">🎵 По генерациям</option>
              <option value="spent">💰 По оплатам</option>
            </select>
            <button
              onClick={() => listQ.refetch()}
              className="text-[11px] font-sans px-2.5 py-1.5 rounded-md bg-white/5 hover:bg-white/10 text-white/80"
            >
              🔄
            </button>
            <button
              onClick={() => copyJson(listQ.data, toast)}
              className="text-[11px] font-sans px-2.5 py-1.5 rounded-md bg-white/5 hover:bg-white/10 text-white/80"
            >
              📋 Копировать
            </button>
          </div>

          {/* === Summary === */}
          {listQ.data ? (
            <div className="text-[11px] font-sans text-muted-foreground mb-3 flex items-center gap-3">
              <span>
                Всего: <span className="font-mono text-white">{listQ.data.total}</span>
              </span>
              <span>
                Страница{" "}
                <span className="font-mono text-white">{listQ.data.page}</span> ·{" "}
                <span className="font-mono text-white">{listQ.data.items.length}</span>{" "}
                на странице
              </span>
            </div>
          ) : null}

          {/* === List === */}
          {listQ.isLoading ? (
            <div className="text-xs text-cyan-300 flex items-center gap-2">
              <Loader2 className="w-3 h-3 animate-spin" /> Загрузка авторов…
            </div>
          ) : listQ.error ? (
            <div className="text-xs text-rose-300">Ошибка: {String(listQ.error)}</div>
          ) : listQ.data && listQ.data.items.length > 0 ? (
            <div className="space-y-2">
              {listQ.data.items.map((a) => (
                <AuthorCard
                  key={a.id}
                  author={a}
                  onOpen={() => setOpenUserId(a.id)}
                  toast={toast}
                />
              ))}
              {/* Pagination */}
              <div className="flex items-center justify-center gap-2 pt-3">
                <button
                  onClick={() => setPage((p) => Math.max(1, p - 1))}
                  disabled={page <= 1}
                  className="text-[11px] font-sans px-3 py-1.5 rounded-md bg-white/5 hover:bg-white/10 text-white/80 disabled:opacity-40 disabled:cursor-not-allowed"
                >
                  ← Назад
                </button>
                <span className="text-[11px] font-mono text-white/60 px-2">
                  стр. {page} / {Math.max(1, Math.ceil(listQ.data.total / 50))}
                </span>
                <button
                  onClick={() =>
                    setPage((p) =>
                      p * 50 < listQ.data!.total ? p + 1 : p,
                    )
                  }
                  disabled={page * 50 >= listQ.data.total}
                  className="text-[11px] font-sans px-3 py-1.5 rounded-md bg-white/5 hover:bg-white/10 text-white/80 disabled:opacity-40 disabled:cursor-not-allowed"
                >
                  Вперёд →
                </button>
              </div>
            </div>
          ) : (
            <div className="text-xs text-white/40 py-6 text-center">
              Авторы не найдены.
            </div>
          )}
        </CardContent>
      </Card>

      {/* === Drill-down modal === */}
      {openUserId !== null ? (
        <AuthorDrillDownModal
          userId={openUserId}
          onClose={() => {
            setOpenUserId(null);
            qc.invalidateQueries({ queryKey: ["admin-authors"] });
          }}
          toast={toast}
        />
      ) : null}
    </div>
  );
}

// ---------- AuthorCard ----------

function AuthorCard({
  author,
  onOpen,
  toast,
}: {
  author: AuthorRow;
  onOpen: () => void;
  toast?: any;
}) {
  const qc = useQueryClient();

  const blockMu = useMutation({
    mutationFn: () =>
      fetchJson(`/api/admin/v304/authors/${author.id}/block`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ unblock: author.blocked }),
      }),
    onSuccess: () => {
      toast?.({ title: author.blocked ? "Разблокирован" : "Заблокирован" });
      qc.invalidateQueries({ queryKey: ["admin-authors"] });
    },
    onError: (e: any) =>
      toast?.({ title: "Ошибка: " + (e?.message ?? String(e)) }),
  });

  return (
    <div className="glass-card rounded-xl p-3 border border-purple-500/20 hover:border-purple-500/40 transition-colors">
      <div className="flex items-start gap-3">
        <div className="flex-shrink-0 w-12 h-12 rounded-full bg-gradient-to-br from-purple-500/40 to-blue-500/40 flex items-center justify-center text-white font-display font-bold text-lg">
          {(author.name || "?").slice(0, 1).toUpperCase()}
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap mb-1">
            <span className="text-sm font-sans font-bold text-white truncate max-w-[200px]">
              {author.name || "—"}
            </span>
            <span className="text-[10px] font-mono text-white/40">
              #{author.id}
            </span>
            {author.blocked ? (
              <span className="text-[10px] font-sans px-2 py-0.5 rounded-full bg-rose-500/20 text-rose-300 font-medium">
                🚫 Блок
              </span>
            ) : (
              <span className="text-[10px] font-sans px-2 py-0.5 rounded-full bg-emerald-500/20 text-emerald-300 font-medium">
                🟢 Active
              </span>
            )}
            {author.role && author.role !== "user" ? (
              <span className="text-[10px] font-sans px-2 py-0.5 rounded-full bg-amber-500/20 text-amber-300 font-medium">
                ⚡ {author.role}
              </span>
            ) : null}
            {author.emailVerified ? (
              <span className="text-[10px] font-sans px-2 py-0.5 rounded-full bg-cyan-500/15 text-cyan-300">
                ✓ email
              </span>
            ) : null}
            {author.phoneVerified ? (
              <span className="text-[10px] font-sans px-2 py-0.5 rounded-full bg-cyan-500/15 text-cyan-300">
                ✓ phone
              </span>
            ) : null}
          </div>
          <div className="text-[11px] font-sans text-white/70 flex flex-wrap items-center gap-x-3 gap-y-0.5">
            <span className="truncate max-w-[180px]" title={author.email ?? ""}>
              ✉ {author.email ?? "—"}
            </span>
            <span className="font-mono">📞 {maskPhone(author.phone)}</span>
            <span className="font-mono">
              {countryFlag(author.countryCode)} {author.lastCity || author.country || "—"}
            </span>
            <span className="font-mono text-white/50">
              👀 {fmtRel(author.lastSeenAt)} назад
            </span>
          </div>
          <div className="text-[11px] font-sans text-white/60 flex flex-wrap items-center gap-x-3 gap-y-0.5 mt-1">
            <span>
              🎵{" "}
              <span className="font-mono text-purple-300">{author.gens}</span>{" "}
              <span className="text-[10px] text-white/40">
                ({author.gensDone}✓/{author.gensError}✗)
              </span>
            </span>
            <span>
              💰{" "}
              <span className="font-mono text-amber-300">
                {fmtRub(author.spent)}
              </span>{" "}
              <span className="text-[10px] text-white/40">
                · {author.payments} платежей
              </span>
            </span>
            <span>
              🎁{" "}
              <span className="font-mono text-emerald-300">
                {author.bonusTracks}
              </span>
            </span>
            <span className="text-[10px] font-mono text-white/30">
              рег. {fmtRel(author.createdAt)} назад
            </span>
          </div>
        </div>

        {/* Quick actions */}
        <div className="flex flex-col gap-1.5 items-end">
          <button
            onClick={onOpen}
            title="Полный профиль"
            className="text-xs px-2 py-1 rounded-md bg-purple-500/20 hover:bg-purple-500/30 text-purple-200 transition-colors"
          >
            👁
          </button>
          <button
            onClick={() => blockMu.mutate()}
            disabled={blockMu.isPending}
            title={author.blocked ? "Разблокировать" : "Заблокировать"}
            className={`text-xs px-2 py-1 rounded-md transition-colors ${
              author.blocked
                ? "bg-emerald-500/20 hover:bg-emerald-500/30 text-emerald-200"
                : "bg-rose-500/20 hover:bg-rose-500/30 text-rose-200"
            }`}
          >
            {author.blocked ? "🟢" : "🚫"}
          </button>
        </div>
      </div>
    </div>
  );
}

// ---------- Drill-down modal ----------

type DrillTab =
  | "profile"
  | "tracks"
  | "payments"
  | "chats"
  | "ip-geo"
  | "musa"
  | "audit";

function AuthorDrillDownModal({
  userId,
  onClose,
  toast,
}: {
  userId: number;
  onClose: () => void;
  toast?: any;
}) {
  const [tab, setTab] = useState<DrillTab>("profile");
  const qc = useQueryClient();

  const detailQ = useQuery<AuthorDetail>({
    queryKey: ["admin-author-detail", userId],
    queryFn: () =>
      fetchJson<AuthorDetail>(`/api/admin/v304/authors/${userId}`),
  });

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-2 sm:p-4 bg-gradient-to-br from-[#0a0a17]/95 via-[#1a0f2e]/95 to-[#0a0a17]/95 backdrop-blur-xl"
      onClick={onClose}
    >
      <div
        className="glass-card border border-purple-500/30 rounded-2xl max-w-5xl w-full max-h-[92vh] overflow-hidden flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between p-3 sm:p-4 border-b border-purple-500/20 bg-gradient-to-r from-purple-500/10 via-fuchsia-500/10 to-blue-500/10">
          <div className="flex items-center gap-3 min-w-0">
            <div className="w-10 h-10 rounded-full bg-gradient-to-br from-purple-500/60 to-blue-500/60 flex items-center justify-center text-white font-display font-bold">
              {(detailQ.data?.user?.name || "?").slice(0, 1).toUpperCase()}
            </div>
            <div className="min-w-0">
              <h2 className="font-display gradient-text text-lg sm:text-xl truncate">
                {detailQ.data?.user?.name ?? "Автор"}
              </h2>
              <div className="text-[10px] font-mono text-white/50">
                #{userId} · {detailQ.data?.user?.email ?? "—"}
              </div>
            </div>
          </div>
          <button
            onClick={onClose}
            className="text-white/60 hover:text-white text-2xl leading-none px-2 flex-shrink-0"
          >
            ×
          </button>
        </div>

        {/* Tab nav */}
        <div className="flex flex-nowrap overflow-x-auto gap-1 px-2 py-1.5 border-b border-purple-500/20 bg-[#0a0a17]/40 scrollbar-thin">
          {(
            [
              ["profile", "🧑 Профиль"],
              ["tracks", "🎵 Треки"],
              ["payments", "💰 Платежи"],
              ["chats", "💬 Чаты"],
              ["ip-geo", "🌐 IP/Geo"],
              ["musa", "✨ Муза"],
              ["audit", "📜 Audit"],
            ] as const
          ).map(([k, l]) => (
            <button
              key={k}
              onClick={() => setTab(k)}
              className={`text-[11px] font-sans px-3 py-1.5 rounded-md whitespace-nowrap transition-colors ${
                tab === k
                  ? "bg-gradient-to-r from-purple-500 via-fuchsia-500 to-blue-500 text-white shadow-[0_0_12px_rgba(124,58,237,0.3)]"
                  : "bg-white/5 hover:bg-white/10 text-white/70"
              }`}
            >
              {l}
            </button>
          ))}
        </div>

        {/* Tab content */}
        <div className="flex-1 overflow-y-auto p-3 sm:p-4">
          {detailQ.isLoading ? (
            <div className="text-xs text-cyan-300 flex items-center gap-2">
              <Loader2 className="w-3 h-3 animate-spin" /> Загрузка…
            </div>
          ) : detailQ.error ? (
            <div className="text-xs text-rose-300">
              Ошибка: {String(detailQ.error)}
            </div>
          ) : detailQ.data ? (
            <>
              {tab === "profile" ? (
                <ProfileEditor
                  detail={detailQ.data}
                  userId={userId}
                  onSaved={() => {
                    detailQ.refetch();
                    qc.invalidateQueries({ queryKey: ["admin-authors"] });
                  }}
                  toast={toast}
                />
              ) : null}
              {tab === "tracks" ? (
                <TracksList detail={detailQ.data} />
              ) : null}
              {tab === "payments" ? (
                <PaymentsList detail={detailQ.data} />
              ) : null}
              {tab === "chats" ? <ChatsList detail={detailQ.data} /> : null}
              {tab === "ip-geo" ? <IpGeoList detail={detailQ.data} /> : null}
              {tab === "musa" ? <MusaActionsList detail={detailQ.data} /> : null}
              {tab === "audit" ? <AuditList detail={detailQ.data} /> : null}
            </>
          ) : null}
        </div>

        {/* Footer */}
        <div className="px-3 sm:px-4 py-2 border-t border-purple-500/20 bg-[#0a0a17]/40 flex items-center justify-between gap-2 flex-wrap">
          <button
            onClick={() => copyJson(detailQ.data, toast)}
            className="text-[11px] font-sans px-3 py-1.5 rounded-md bg-white/5 hover:bg-white/10 text-white/80"
          >
            📋 Копировать профиль
          </button>
          <SendMessageBtn userId={userId} toast={toast} />
        </div>
      </div>
    </div>
  );
}

// ---------- Tab components ----------

function ProfileEditor({
  detail,
  userId,
  onSaved,
  toast,
}: {
  detail: AuthorDetail;
  userId: number;
  onSaved: () => void;
  toast?: any;
}) {
  const u = detail.user || {};
  const [name, setName] = useState<string>(u.name ?? "");
  const [email, setEmail] = useState<string>(u.email ?? "");
  const [phone, setPhone] = useState<string>(u.phone ?? "");
  const [country, setCountry] = useState<string>(u.country ?? "");
  const [countryCode, setCountryCode] = useState<string>(u.countryCode ?? "");
  const [role, setRole] = useState<string>(u.role ?? "user");
  const [bonusTracks, setBonusTracks] = useState<number>(u.bonusTracks ?? 0);
  const [balance, setBalance] = useState<number>(u.balance ?? 0);

  const saveMu = useMutation({
    mutationFn: (body: Record<string, unknown>) =>
      fetchJson(`/api/admin/v304/authors/${userId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      }),
    onSuccess: () => {
      toast?.({ title: "Сохранено" });
      onSaved();
    },
    onError: (e: any) =>
      toast?.({ title: "Ошибка: " + (e?.message ?? String(e)) }),
  });

  function submit() {
    const body: Record<string, unknown> = {};
    if (name !== u.name) body.name = name;
    if (email !== u.email) body.email = email;
    if (phone !== (u.phone ?? "")) body.phone = phone;
    if (country !== (u.country ?? "")) body.country = country;
    if (countryCode !== (u.countryCode ?? ""))
      body.countryCode = countryCode;
    if (role !== u.role) body.role = role;
    if (bonusTracks !== (u.bonusTracks ?? 0))
      body.bonusTracks = bonusTracks;
    if (balance !== (u.balance ?? 0)) body.balance = balance;
    if (Object.keys(body).length === 0) {
      toast?.({ title: "Нет изменений" });
      return;
    }
    saveMu.mutate(body);
  }

  return (
    <div className="space-y-3">
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <Field label="Имя">
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            className="w-full text-xs font-sans px-2.5 py-1.5 rounded-md bg-white/5 border border-purple-400/20 text-white focus:outline-none focus:border-purple-400/60"
          />
        </Field>
        <Field label="Email">
          <input
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            className="w-full text-xs font-sans px-2.5 py-1.5 rounded-md bg-white/5 border border-purple-400/20 text-white focus:outline-none focus:border-purple-400/60"
          />
        </Field>
        <Field label="Телефон">
          <input
            value={phone}
            onChange={(e) => setPhone(e.target.value)}
            className="w-full text-xs font-mono px-2.5 py-1.5 rounded-md bg-white/5 border border-purple-400/20 text-white focus:outline-none focus:border-purple-400/60"
          />
        </Field>
        <Field label="Страна">
          <div className="flex gap-2">
            <input
              value={country}
              onChange={(e) => setCountry(e.target.value)}
              placeholder="Russia"
              className="flex-1 text-xs font-sans px-2.5 py-1.5 rounded-md bg-white/5 border border-purple-400/20 text-white focus:outline-none focus:border-purple-400/60"
            />
            <input
              value={countryCode}
              onChange={(e) =>
                setCountryCode(e.target.value.toUpperCase().slice(0, 3))
              }
              placeholder="RU"
              className="w-16 text-xs font-mono px-2.5 py-1.5 rounded-md bg-white/5 border border-purple-400/20 text-white focus:outline-none focus:border-purple-400/60"
            />
          </div>
        </Field>
        <Field label="Роль">
          <select
            value={role}
            onChange={(e) => setRole(e.target.value)}
            className="w-full text-xs font-sans px-2.5 py-1.5 rounded-md bg-white/5 border border-purple-400/20 text-white focus:outline-none focus:border-purple-400/60"
          >
            <option value="user">user</option>
            <option value="admin">admin</option>
            <option value="super_admin">super_admin</option>
          </select>
        </Field>
        <Field label="Бонусные треки">
          <input
            type="number"
            value={bonusTracks}
            onChange={(e) => setBonusTracks(Number(e.target.value))}
            className="w-full text-xs font-mono px-2.5 py-1.5 rounded-md bg-white/5 border border-amber-400/20 text-white focus:outline-none focus:border-amber-400/60"
          />
        </Field>
        <Field label="Баланс (kopecks)">
          <input
            type="number"
            value={balance}
            onChange={(e) => setBalance(Number(e.target.value))}
            className="w-full text-xs font-mono px-2.5 py-1.5 rounded-md bg-white/5 border border-amber-400/20 text-white focus:outline-none focus:border-amber-400/60"
          />
        </Field>
      </div>
      <div className="flex items-center justify-between flex-wrap gap-2">
        <div className="text-[10px] font-sans text-white/50">
          ID: <span className="font-mono text-white/70">#{userId}</span> · Создан:{" "}
          <span className="font-mono">{fmtDate(u.createdAt)}</span> · Треков:{" "}
          <span className="font-mono text-purple-300">
            {detail.counters.total}
          </span>{" "}
          (
          <span className="text-emerald-300">{detail.counters.done}✓</span>/
          <span className="text-rose-300">{detail.counters.error}✗</span>/
          <span className="text-amber-300">{detail.counters.processing}…</span>)
        </div>
        <button
          onClick={submit}
          disabled={saveMu.isPending}
          className="text-xs font-sans px-4 py-1.5 rounded-md bg-gradient-to-r from-purple-500 via-fuchsia-500 to-blue-500 text-white shadow-[0_0_16px_rgba(124,58,237,0.3)] disabled:opacity-50"
        >
          {saveMu.isPending ? "Сохраняю…" : "💾 Сохранить"}
        </button>
      </div>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <div className="text-[10px] uppercase font-sans text-white/50 mb-1">
        {label}
      </div>
      {children}
    </div>
  );
}

function TracksList({ detail }: { detail: AuthorDetail }) {
  if (detail.recentGenerations.length === 0) {
    return (
      <div className="text-xs text-white/40 py-4 text-center">Треков нет.</div>
    );
  }
  return (
    <div className="space-y-1.5">
      {detail.recentGenerations.map((g) => (
        <div
          key={g.id}
          className="glass-card rounded-md p-2 border border-purple-500/15 hover:border-purple-500/30 transition-colors"
        >
          <div className="flex items-start gap-2 flex-wrap">
            <span className="text-[10px] font-mono text-white/40">#{g.id}</span>
            <span
              className={`text-[10px] font-sans px-1.5 py-0.5 rounded-full ${
                g.status === "done"
                  ? "bg-emerald-500/20 text-emerald-300"
                  : g.status === "error"
                    ? "bg-rose-500/20 text-rose-300"
                    : "bg-amber-500/20 text-amber-300"
              }`}
            >
              {g.status}
            </span>
            <span className="text-[10px] font-sans px-1.5 py-0.5 rounded-full bg-purple-500/15 text-purple-300">
              {g.type}
            </span>
            <span className="text-[11px] font-sans text-white/90 flex-1 min-w-0 truncate">
              {g.display_title || g.prompt?.slice(0, 80) || "—"}
            </span>
            {g.result_url ? (
              <a
                href={g.result_url}
                target="_blank"
                rel="noreferrer"
                className="text-[10px] text-cyan-300 hover:underline"
              >
                🔗 audio
              </a>
            ) : null}
          </div>
          {g.error_reason ? (
            <div className="text-[10px] font-sans text-rose-300/80 mt-0.5">
              ⚠ {g.error_reason}
            </div>
          ) : null}
          <div className="text-[10px] font-mono text-white/40 mt-0.5">
            {fmtDate(g.created_at)}
            {g.voice_type ? ` · ${g.voice_type}` : ""}
            {g.is_public ? ` · pub=${g.is_public}` : ""}
          </div>
        </div>
      ))}
    </div>
  );
}

function PaymentsList({ detail }: { detail: AuthorDetail }) {
  return (
    <div className="space-y-3">
      <div>
        <div className="text-[10px] uppercase font-sans text-white/50 mb-1.5">
          Платежи (Robokassa)
        </div>
        {detail.recentPayments.length === 0 ? (
          <div className="text-xs text-white/40 py-2">Платежей нет.</div>
        ) : (
          <div className="space-y-1">
            {detail.recentPayments.map((p) => (
              <div
                key={p.id}
                className="glass-card rounded-md p-2 border border-amber-500/15 flex items-center gap-2 flex-wrap"
              >
                <span className="text-[10px] font-mono text-white/40">
                  #{p.id}
                </span>
                <span className="text-[10px] font-mono text-white/60">
                  inv:{p.inv_id}
                </span>
                <span
                  className={`text-[10px] font-sans px-1.5 py-0.5 rounded-full ${
                    p.status === "paid"
                      ? "bg-emerald-500/20 text-emerald-300"
                      : p.status === "failed"
                        ? "bg-rose-500/20 text-rose-300"
                        : "bg-amber-500/20 text-amber-300"
                  }`}
                >
                  {p.status}
                </span>
                <span className="text-[11px] font-mono text-amber-300">
                  {fmtRub(p.amount)}
                </span>
                <span className="text-[10px] font-sans text-white/70 flex-1 truncate min-w-0">
                  {p.description ?? "—"}
                </span>
                <span className="text-[10px] font-mono text-white/40">
                  {fmtDate(p.created_at)}
                </span>
              </div>
            ))}
          </div>
        )}
      </div>
      <div>
        <div className="text-[10px] uppercase font-sans text-white/50 mb-1.5">
          Транзакции
        </div>
        {detail.recentTransactions.length === 0 ? (
          <div className="text-xs text-white/40 py-2">Транзакций нет.</div>
        ) : (
          <div className="space-y-1">
            {detail.recentTransactions.map((t) => (
              <div
                key={t.id}
                className="glass-card rounded-md p-2 border border-cyan-500/15 flex items-center gap-2 flex-wrap"
              >
                <span className="text-[10px] font-mono text-white/40">
                  #{t.id}
                </span>
                <span className="text-[10px] font-sans px-1.5 py-0.5 rounded-full bg-cyan-500/15 text-cyan-300">
                  {t.type}
                </span>
                <span
                  className={`text-[11px] font-mono ${t.amount >= 0 ? "text-emerald-300" : "text-rose-300"}`}
                >
                  {t.amount >= 0 ? "+" : ""}
                  {fmtRub(Math.abs(t.amount))}
                </span>
                <span className="text-[10px] font-sans text-white/70 flex-1 truncate min-w-0">
                  {t.description ?? "—"}
                </span>
                <span className="text-[10px] font-mono text-white/40">
                  {fmtDate(t.created_at)}
                </span>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function ChatsList({ detail }: { detail: AuthorDetail }) {
  const { sessions, messages } = detail.chats;
  if (sessions.length === 0) {
    return (
      <div className="text-xs text-white/40 py-4 text-center">
        Чатов нет (cross-channel пусто).
      </div>
    );
  }
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap gap-1.5">
        {sessions.map((s) => (
          <span
            key={s.id}
            className="text-[10px] font-mono px-2 py-1 rounded-md bg-white/5 text-white/70"
            title={`session: ${s.id}`}
          >
            {channelEmoji(s.channel)} {s.channel}
            {s.personaName ? ` · ${s.personaName}` : ""}
            {s.lastMessageAt
              ? ` · ${fmtRel(s.lastMessageAt)}`
              : ""}
          </span>
        ))}
      </div>
      <div className="space-y-1 max-h-[50vh] overflow-y-auto pr-1">
        {messages.map((m) => (
          <div
            key={m.id}
            className={`glass-card rounded-md p-2 border ${
              m.role === "user"
                ? "border-cyan-500/15 bg-cyan-500/[0.03]"
                : "border-purple-500/15 bg-purple-500/[0.03]"
            }`}
          >
            <div className="flex items-center gap-2 flex-wrap mb-0.5">
              <span className="text-[10px] font-sans text-white/60">
                {m.role === "user" ? "👤 Юзер" : "✨ Муза"}
              </span>
              <span className="text-[10px] font-mono text-white/40">
                {channelEmoji(m.channel)} {m.channel}
              </span>
              <span className="text-[10px] font-mono text-white/30 ml-auto">
                {fmtDate(m.createdAt)}
              </span>
            </div>
            <div className="text-[11px] font-sans text-white/85 whitespace-pre-wrap break-words">
              {m.text}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function IpGeoList({ detail }: { detail: AuthorDetail }) {
  if (detail.profiles.length === 0) {
    return (
      <div className="text-xs text-white/40 py-4 text-center">
        IP/Geo профилей нет.
      </div>
    );
  }
  return (
    <div className="space-y-2">
      {detail.profiles.map((p) => (
        <div
          key={p.id}
          className="glass-card rounded-md p-3 border border-cyan-500/15"
        >
          <div className="grid grid-cols-1 md:grid-cols-2 gap-2 text-[11px] font-sans">
            <div>
              <div className="text-[10px] uppercase text-white/50 mb-1">
                Сеть
              </div>
              <div>
                IP:{" "}
                <span className="font-mono text-white/80">{p.ip || "—"}</span>
              </div>
              <div>
                Страна:{" "}
                <span className="font-mono text-cyan-200">
                  {p.ip_country || "—"}
                </span>
              </div>
              <div>
                Город:{" "}
                <span className="font-mono text-cyan-200">
                  {p.ip_city || "—"}
                </span>
              </div>
              <div>
                Регион:{" "}
                <span className="font-mono text-white/70">
                  {p.ip_region || "—"}
                </span>
              </div>
              <div>
                ASN:{" "}
                <span className="font-mono text-white/70">{p.ip_asn || "—"}</span>
              </div>
            </div>
            <div>
              <div className="text-[10px] uppercase text-white/50 mb-1">
                Устройство
              </div>
              <div>
                Device:{" "}
                <span className="text-white/80">{p.device || "—"}</span>
              </div>
              <div>
                Browser:{" "}
                <span className="text-white/80">{p.browser || "—"}</span>
              </div>
              <div>
                OS: <span className="text-white/80">{p.os || "—"}</span>
              </div>
              <div className="text-[10px] font-mono text-white/40 mt-1">
                visits:{" "}
                <span className="text-amber-200">{p.visit_count}</span>
                {" · "}first:{" "}
                {fmtDate(p.first_seen)}
                {" · "}last: {fmtDate(p.last_seen)}
              </div>
            </div>
          </div>
          {p.cookie_data ? (
            <details className="mt-2">
              <summary className="text-[10px] font-sans text-white/50 cursor-pointer hover:text-white/80">
                cookies / utm / referrer (JSON)
              </summary>
              <pre className="text-[10px] font-mono text-white/70 whitespace-pre-wrap break-all mt-1 max-h-[160px] overflow-y-auto">
                {JSON.stringify(p.cookie_data, null, 2)}
              </pre>
            </details>
          ) : null}
        </div>
      ))}
    </div>
  );
}

function MusaActionsList({ detail }: { detail: AuthorDetail }) {
  if (detail.muzaActions.length === 0) {
    return (
      <div className="text-xs text-white/40 py-4 text-center">
        Действия Музы пока не отслеживаются (таблица muza_user_actions ещё не
        развёрнута либо записей нет).
      </div>
    );
  }
  return (
    <div className="space-y-1.5">
      {detail.muzaActions.map((a, idx) => (
        <div
          key={a.id ?? idx}
          className="glass-card rounded-md p-2 border border-pink-500/15"
        >
          <div className="text-[11px] font-sans text-white/85">
            <span className="text-pink-300 font-medium">
              {a.action ?? a.tool ?? "—"}
            </span>
            {a.summary ? ` — ${a.summary}` : ""}
          </div>
          <div className="text-[10px] font-mono text-white/40 mt-0.5">
            {fmtDate(a.created_at ?? a.createdAt)}
          </div>
        </div>
      ))}
    </div>
  );
}

function AuditList({ detail }: { detail: AuthorDetail }) {
  const audit = detail.auditEntries;
  const failures = detail.failures;
  return (
    <div className="space-y-3">
      <div>
        <div className="text-[10px] uppercase font-sans text-white/50 mb-1.5">
          Admin audit (последние 30)
        </div>
        {audit.length === 0 ? (
          <div className="text-xs text-white/40 py-2">Audit entries нет.</div>
        ) : (
          <div className="space-y-1">
            {audit.map((a) => (
              <div
                key={a.id}
                className="glass-card rounded-md p-2 border border-amber-500/15 flex items-center gap-2 flex-wrap text-[11px] font-sans"
              >
                <span className="font-mono text-white/40">#{a.id}</span>
                <span className="px-1.5 py-0.5 rounded-full bg-amber-500/15 text-amber-300 text-[10px]">
                  {a.action}
                </span>
                <span className="text-white/70">{a.entity}</span>
                <span className="font-mono text-white/40">{a.entity_key}</span>
                <span className="text-white/60 ml-auto truncate max-w-[200px]">
                  {a.admin_email}
                </span>
                <span className="font-mono text-white/40 text-[10px]">
                  {fmtDate(a.created_at)}
                </span>
              </div>
            ))}
          </div>
        )}
      </div>
      <div>
        <div className="text-[10px] uppercase font-sans text-white/50 mb-1.5">
          Неудачные действия юзера
        </div>
        {failures.length === 0 ? (
          <div className="text-xs text-white/40 py-2">Failures нет.</div>
        ) : (
          <div className="space-y-1">
            {failures.map((f) => (
              <div
                key={f.id}
                className="glass-card rounded-md p-2 border border-rose-500/15 text-[11px] font-sans"
              >
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="font-mono text-white/40">#{f.id}</span>
                  <span className="px-1.5 py-0.5 rounded-full bg-rose-500/15 text-rose-300 text-[10px]">
                    {f.channel}
                  </span>
                  <span className="text-white/70">{f.action}</span>
                  {f.error_code ? (
                    <span className="font-mono text-amber-300">
                      {f.error_code}
                    </span>
                  ) : null}
                  <span className="font-mono text-white/40 ml-auto text-[10px]">
                    {fmtDate(f.created_at)}
                  </span>
                </div>
                {f.error_message ? (
                  <div className="text-[10px] text-white/60 mt-0.5 truncate">
                    {f.error_message}
                  </div>
                ) : null}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function SendMessageBtn({
  userId,
  toast,
}: {
  userId: number;
  toast?: any;
}) {
  const [open, setOpen] = useState(false);
  const [text, setText] = useState("");
  const [channel, setChannel] = useState<"telegram" | "email" | "auto">("auto");

  const mu = useMutation({
    mutationFn: () =>
      fetchJson(`/api/admin/v304/authors/${userId}/send-message`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ channel, text }),
      }),
    onSuccess: () => {
      toast?.({ title: "Поставлено в очередь" });
      setText("");
      setOpen(false);
    },
    onError: (e: any) =>
      toast?.({ title: "Ошибка: " + (e?.message ?? String(e)) }),
  });

  if (!open) {
    return (
      <button
        onClick={() => setOpen(true)}
        className="text-[11px] font-sans px-3 py-1.5 rounded-md bg-gradient-to-r from-pink-500/40 to-fuchsia-500/40 hover:from-pink-500/60 hover:to-fuchsia-500/60 text-white"
      >
        ✉ Написать автору
      </button>
    );
  }
  return (
    <div className="flex flex-col sm:flex-row items-stretch sm:items-center gap-2 flex-1">
      <select
        value={channel}
        onChange={(e) => setChannel(e.target.value as any)}
        className="text-[11px] font-sans px-2.5 py-1.5 rounded-md bg-white/5 border border-pink-400/30 text-white focus:outline-none"
      >
        <option value="auto">Авто</option>
        <option value="telegram">Telegram</option>
        <option value="email">Email</option>
      </select>
      <input
        value={text}
        onChange={(e) => setText(e.target.value.slice(0, 4000))}
        placeholder="Текст сообщения…"
        className="flex-1 text-[11px] font-sans px-2.5 py-1.5 rounded-md bg-white/5 border border-pink-400/30 text-white focus:outline-none"
      />
      <button
        onClick={() => text.trim() && mu.mutate()}
        disabled={!text.trim() || mu.isPending}
        className="text-[11px] font-sans px-3 py-1.5 rounded-md bg-gradient-to-r from-pink-500 to-fuchsia-500 text-white shadow-[0_0_12px_rgba(236,72,153,0.3)] disabled:opacity-50"
      >
        {mu.isPending ? "…" : "Отправить"}
      </button>
      <button
        onClick={() => setOpen(false)}
        className="text-[11px] font-sans px-2 py-1.5 rounded-md bg-white/5 hover:bg-white/10 text-white/70"
      >
        ×
      </button>
    </div>
  );
}

export default AuthorsTab;
