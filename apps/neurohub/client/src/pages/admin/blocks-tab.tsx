// Eugene 2026-05-18 Босс «вкладка для управления блокировками».
//
// /admin/v304 → 🚫 Блокировки.
// Три подкладки:
//  1. 🔥 Кандидаты — топ-N подозрительных IP/countries/UA из
//     /api/admin/v304/blocks/suspicious. Один клик «Заблокировать».
//  2. 🚫 Активные — текущие блокировки, «Разблокировать».
//  3. ➕ Добавить вручную — форма для ручной блокировки по типу.
//
// Brand-style consistency: glass-card / gradient-text / font-mono для IPs,
// фирменные цвета (purple / cyan / amber / fuchsia).

import { useMemo, useState } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { queryClient } from "@/lib/queryClient";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Loader2 } from "lucide-react";

type BlockType = "ip" | "user" | "country" | "ua_substring";

type BlockedEntityRow = {
  id: number;
  type: BlockType;
  value: string;
  reason: string | null;
  blockedBy: number | null;
  createdAt: number;
  expiresAt: number | null;
  active: number;
};

type SuspiciousCandidate = {
  type: BlockType;
  value: string;
  hits: number;
  uniqPages?: number;
  uniqSessions?: number;
  country?: string | null;
  city?: string | null;
  userAgent?: string | null;
  hint: string;
  alreadyBlocked: boolean;
};

// Локальный fetcher — опирается на patched fetch в lib/auth.tsx
// (Authorization: Bearer подставляется автоматически).
async function jget<T>(url: string): Promise<T> {
  const r = await fetch(url, { credentials: "include" });
  if (!r.ok) throw new Error(`${r.status}: ${await r.text()}`);
  const j = await r.json();
  if (j?.error) throw new Error(String(j.error));
  return j.data as T;
}

async function jsend<T>(method: string, url: string, body?: unknown): Promise<T> {
  const r = await fetch(url, {
    method,
    headers: body ? { "Content-Type": "application/json" } : {},
    body: body ? JSON.stringify(body) : undefined,
    credentials: "include",
  });
  if (!r.ok) throw new Error(`${r.status}: ${await r.text()}`);
  const j = await r.json();
  if (j?.error) throw new Error(String(j.error));
  return j.data as T;
}

const TYPE_LABELS: Record<BlockType, string> = {
  ip: "IP",
  user: "Юзер",
  country: "Страна",
  ua_substring: "UA-substring",
};
const TYPE_COLORS: Record<BlockType, string> = {
  ip: "bg-cyan-500/20 text-cyan-300 border-cyan-500/40",
  user: "bg-purple-500/20 text-purple-300 border-purple-500/40",
  country: "bg-amber-500/20 text-amber-300 border-amber-500/40",
  ua_substring: "bg-fuchsia-500/20 text-fuchsia-300 border-fuchsia-500/40",
};

function formatTs(ms: number | null | undefined): string {
  if (!ms) return "—";
  return new Date(ms).toLocaleString("ru-RU", { dateStyle: "short", timeStyle: "short" });
}

export function BlocksTab({ toast }: { toast?: any }) {
  return (
    <div className="space-y-6">
      <div className="rounded-2xl border border-purple-500/30 p-6 glass-card">
        <h2 className="text-2xl font-display font-bold gradient-text mb-2">
          🚫 Блокировки
        </h2>
        <p className="text-sm font-sans text-muted-foreground">
          Anti-abuse / спам-защита. Блокируем по IP, userId, country (ISO 3166-1 alpha-2)
          или UA-substring. Записи остаются в БД для аудита после снятия.
        </p>
      </div>

      <Tabs defaultValue="suspicious">
        <TabsList>
          <TabsTrigger value="suspicious">🔥 Кандидаты</TabsTrigger>
          <TabsTrigger value="active">🚫 Активные</TabsTrigger>
          <TabsTrigger value="manual">➕ Добавить вручную</TabsTrigger>
        </TabsList>

        <TabsContent value="suspicious" className="mt-4">
          <SuspiciousPane toast={toast} />
        </TabsContent>

        <TabsContent value="active" className="mt-4">
          <ActivePane toast={toast} />
        </TabsContent>

        <TabsContent value="manual" className="mt-4">
          <ManualPane toast={toast} />
        </TabsContent>
      </Tabs>
    </div>
  );
}

// --------- 🔥 Кандидаты ---------

function SuspiciousPane({ toast }: { toast?: any }) {
  const [hours, setHours] = useState(24);
  const { data, isLoading, error, refetch } = useQuery({
    queryKey: ["admin-blocks-suspicious", hours],
    queryFn: () => jget<{ windowHours: number; total: number; candidates: SuspiciousCandidate[] }>(
      `/api/admin/v304/blocks/suspicious?hours=${hours}`,
    ),
  });

  const blockMut = useMutation({
    mutationFn: (input: { type: BlockType; value: string; reason: string; expiresInDays?: number | null }) =>
      jsend<{ id: number; alreadyActive: boolean }>("POST", "/api/admin/v304/blocks", input),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["admin-blocks-suspicious"] });
      queryClient.invalidateQueries({ queryKey: ["admin-blocks-active"] });
      toast?.({ title: "Заблокировано", description: "Запись добавлена в blocked_entities" });
    },
    onError: (e: any) => {
      toast?.({ title: "Ошибка", description: String(e?.message || e), variant: "destructive" });
    },
  });

  if (isLoading) {
    return <div className="flex items-center gap-2 text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" />Загружаем…</div>;
  }
  if (error) {
    return <div className="text-sm text-red-400">Ошибка: {String((error as any)?.message || error)}</div>;
  }

  const candidates = data?.candidates || [];

  return (
    <div className="space-y-4">
      <Card className="glass-card border-purple-500/30">
        <CardHeader>
          <CardTitle className="text-base font-sans font-bold text-white">
            Подозрительная активность за последние{" "}
            <span className="font-mono text-amber-300">{data?.windowHours || hours}ч</span>
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="flex items-center gap-3">
            <Label className="text-xs font-sans text-muted-foreground">Окно (ч):</Label>
            <Input
              type="number"
              min={1}
              max={168}
              value={hours}
              onChange={(e) => setHours(Math.max(1, Math.min(168, Number(e.target.value) || 24)))}
              className="w-24 bg-white/5 border-purple-400/20"
            />
            <Button
              variant="outline"
              onClick={() => refetch()}
              className="bg-white/5 border-purple-400/20 hover:bg-purple-500/20"
            >
              🔄 Обновить
            </Button>
            <span className="text-xs font-sans text-muted-foreground ml-auto">
              Найдено: <span className="font-mono text-cyan-300">{candidates.length}</span>
            </span>
          </div>
        </CardContent>
      </Card>

      {candidates.length === 0 ? (
        <div className="text-sm font-sans text-muted-foreground italic">
          Нет кандидатов. Эвристика: low pages ratio (&gt;100 hits + ≤3 unique pages),
          bot-UA &gt;50% по стране, bot-UA подстроки.
        </div>
      ) : (
        <div className="grid gap-2">
          {candidates.map((c, i) => (
            <Card key={`${c.type}:${c.value}:${i}`} className="glass-card border-white/10">
              <CardContent className="pt-4 pb-4">
                <div className="flex items-center justify-between gap-3 flex-wrap">
                  <div className="flex items-center gap-2 flex-wrap">
                    <Badge className={`${TYPE_COLORS[c.type]} text-[10px] font-sans`}>
                      {TYPE_LABELS[c.type]}
                    </Badge>
                    <span className="font-mono text-sm text-white">{c.value}</span>
                    {c.country && (
                      <span className="text-xs font-sans text-muted-foreground">
                        {c.city ? `${c.city}, ` : ""}{c.country}
                      </span>
                    )}
                    <Badge className="bg-amber-500/20 text-amber-300 text-[10px] font-sans">
                      {c.hint}
                    </Badge>
                  </div>
                  <div className="flex items-center gap-2">
                    <span className="font-mono text-xs text-cyan-300">{c.hits} hits</span>
                    {c.uniqPages !== undefined && (
                      <span className="font-mono text-xs text-muted-foreground">/{c.uniqPages}p</span>
                    )}
                    {c.alreadyBlocked ? (
                      <Badge className="bg-red-500/20 text-red-300 text-[10px]">Уже блок</Badge>
                    ) : (
                      <Button
                        size="sm"
                        className="bg-gradient-to-r from-purple-500 via-fuchsia-500 to-blue-500 hover:opacity-90 text-white text-xs"
                        onClick={() => {
                          const reason = window.prompt(
                            `Причина блокировки ${TYPE_LABELS[c.type]} «${c.value}»?`,
                            c.hint,
                          );
                          if (reason === null) return;
                          const daysRaw = window.prompt("Срок блокировки в днях (пусто = навсегда):", "");
                          const expiresInDays = daysRaw && /^\d+$/.test(daysRaw.trim())
                            ? Number(daysRaw.trim())
                            : null;
                          blockMut.mutate({
                            type: c.type,
                            value: c.value,
                            reason: reason || c.hint,
                            expiresInDays,
                          });
                        }}
                      >
                        🚫 Заблокировать
                      </Button>
                    )}
                  </div>
                </div>
                {c.userAgent && (
                  <div className="mt-2 text-[10px] font-mono text-muted-foreground truncate">
                    UA: {c.userAgent.slice(0, 120)}
                  </div>
                )}
              </CardContent>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}

// --------- 🚫 Активные ---------

function ActivePane({ toast }: { toast?: any }) {
  const [typeFilter, setTypeFilter] = useState<"" | BlockType>("");
  const { data, isLoading, error } = useQuery({
    queryKey: ["admin-blocks-active", typeFilter],
    queryFn: () =>
      jget<{ total: number; blocks: BlockedEntityRow[] }>(
        `/api/admin/v304/blocks?active=1${typeFilter ? `&type=${typeFilter}` : ""}`,
      ),
  });

  const unblockMut = useMutation({
    mutationFn: (id: number) => jsend<{ id: number; unblocked: boolean }>("DELETE", `/api/admin/v304/blocks/${id}`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["admin-blocks-active"] });
      queryClient.invalidateQueries({ queryKey: ["admin-blocks-suspicious"] });
      toast?.({ title: "Разблокировано", description: "active=0 (soft-unblock)" });
    },
    onError: (e: any) => {
      toast?.({ title: "Ошибка", description: String(e?.message || e), variant: "destructive" });
    },
  });

  const rows = useMemo(() => data?.blocks || [], [data]);

  return (
    <div className="space-y-4">
      <Card className="glass-card border-purple-500/30">
        <CardHeader>
          <CardTitle className="text-base font-sans font-bold text-white">
            Активные блокировки <span className="font-mono text-cyan-300">({rows.length})</span>
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="flex items-center gap-3 flex-wrap">
            <Label className="text-xs font-sans text-muted-foreground">Тип:</Label>
            {(["", "ip", "user", "country", "ua_substring"] as const).map((t) => (
              <Button
                key={t || "all"}
                size="sm"
                variant={typeFilter === t ? "default" : "outline"}
                className={
                  typeFilter === t
                    ? "bg-gradient-to-r from-purple-500 to-fuchsia-500 text-white"
                    : "bg-white/5 border-purple-400/20"
                }
                onClick={() => setTypeFilter(t)}
              >
                {t === "" ? "Все" : TYPE_LABELS[t]}
              </Button>
            ))}
          </div>
        </CardContent>
      </Card>

      {isLoading && <Loader2 className="h-4 w-4 animate-spin text-purple-400" />}
      {error && <div className="text-sm text-red-400">Ошибка: {String((error as any)?.message || error)}</div>}

      <div className="grid gap-2">
        {rows.map((row) => (
          <Card key={row.id} className="glass-card border-white/10">
            <CardContent className="pt-4 pb-4">
              <div className="flex items-center justify-between gap-3 flex-wrap">
                <div className="flex items-center gap-2 flex-wrap min-w-0">
                  <Badge className={`${TYPE_COLORS[row.type]} text-[10px] font-sans shrink-0`}>
                    {TYPE_LABELS[row.type]}
                  </Badge>
                  <span className="font-mono text-sm text-white truncate" title={row.value}>
                    {row.value}
                  </span>
                  {row.reason && (
                    <span className="text-xs font-sans text-muted-foreground italic">
                      «{row.reason}»
                    </span>
                  )}
                </div>
                <div className="flex items-center gap-3 flex-wrap">
                  <span className="text-[10px] font-mono text-muted-foreground">
                    создан {formatTs(row.createdAt)}
                  </span>
                  {row.expiresAt && (
                    <span className="text-[10px] font-mono text-amber-300">
                      до {formatTs(row.expiresAt)}
                    </span>
                  )}
                  <span className="text-[10px] font-mono text-muted-foreground">
                    id <span className="text-cyan-300">{row.id}</span>
                  </span>
                  <Button
                    size="sm"
                    variant="outline"
                    className="bg-white/5 border-emerald-500/40 hover:bg-emerald-500/20 text-emerald-300 text-xs"
                    onClick={() => {
                      if (window.confirm(`Разблокировать ${TYPE_LABELS[row.type]} «${row.value}»?`)) {
                        unblockMut.mutate(row.id);
                      }
                    }}
                  >
                    ✓ Разблокировать
                  </Button>
                </div>
              </div>
            </CardContent>
          </Card>
        ))}
        {!isLoading && rows.length === 0 && (
          <div className="text-sm font-sans text-muted-foreground italic">
            Нет активных блокировок.
          </div>
        )}
      </div>
    </div>
  );
}

// --------- ➕ Добавить вручную ---------

function ManualPane({ toast }: { toast?: any }) {
  const [type, setType] = useState<BlockType>("ip");
  const [value, setValue] = useState("");
  const [reason, setReason] = useState("");
  const [expiresInDays, setExpiresInDays] = useState<string>("");

  const blockMut = useMutation({
    mutationFn: (input: { type: BlockType; value: string; reason: string; expiresInDays?: number | null }) =>
      jsend<{ id: number; alreadyActive: boolean }>("POST", "/api/admin/v304/blocks", input),
    onSuccess: (r) => {
      queryClient.invalidateQueries({ queryKey: ["admin-blocks-active"] });
      toast?.({
        title: r.alreadyActive ? "Обновлено" : "Заблокировано",
        description: `id=${r.id} type=${type} value=${value}`,
      });
      setValue("");
      setReason("");
      setExpiresInDays("");
    },
    onError: (e: any) => {
      toast?.({ title: "Ошибка", description: String(e?.message || e), variant: "destructive" });
    },
  });

  function handleSubmit() {
    const v = value.trim();
    if (!v) {
      toast?.({ title: "Заполни значение", variant: "destructive" });
      return;
    }
    const days = expiresInDays.trim();
    const expiresInDaysParsed = days && /^\d+$/.test(days) ? Number(days) : null;
    blockMut.mutate({
      type,
      value: v,
      reason: reason.trim() || "manual block",
      expiresInDays: expiresInDaysParsed,
    });
  }

  const placeholderByType: Record<BlockType, string> = {
    ip: "82.118.30.110",
    user: "1234 (userId число)",
    country: "CZ (ISO 3166-1 alpha-2)",
    ua_substring: "DataForSeoBot или curl/7",
  };

  return (
    <Card className="glass-card border-purple-500/30">
      <CardHeader>
        <CardTitle className="text-base font-sans font-bold text-white">
          Добавить блокировку вручную
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <div>
          <Label className="text-xs font-sans text-muted-foreground mb-2 block">Тип</Label>
          <div className="flex gap-2 flex-wrap">
            {(["ip", "user", "country", "ua_substring"] as const).map((t) => (
              <Button
                key={t}
                size="sm"
                variant={type === t ? "default" : "outline"}
                className={
                  type === t
                    ? "bg-gradient-to-r from-purple-500 to-fuchsia-500 text-white"
                    : "bg-white/5 border-purple-400/20"
                }
                onClick={() => setType(t)}
              >
                {TYPE_LABELS[t]}
              </Button>
            ))}
          </div>
        </div>

        <div>
          <Label className="text-xs font-sans text-muted-foreground mb-1 block">Значение</Label>
          <Input
            value={value}
            onChange={(e) => setValue(e.target.value)}
            placeholder={placeholderByType[type]}
            className="bg-white/5 border-purple-400/20 font-mono"
          />
        </div>

        <div>
          <Label className="text-xs font-sans text-muted-foreground mb-1 block">
            Причина (для аудита)
          </Label>
          <Input
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder="Спам-бот / mailer scraper / по жалобе #123"
            className="bg-white/5 border-purple-400/20"
          />
        </div>

        <div>
          <Label className="text-xs font-sans text-muted-foreground mb-1 block">
            Срок блокировки в днях (пусто = навсегда)
          </Label>
          <Input
            type="number"
            min={1}
            max={365}
            value={expiresInDays}
            onChange={(e) => setExpiresInDays(e.target.value)}
            placeholder="30 (макс 365)"
            className="w-32 bg-white/5 border-purple-400/20 font-mono"
          />
        </div>

        <Button
          onClick={handleSubmit}
          disabled={blockMut.isPending}
          className="bg-gradient-to-r from-purple-500 via-fuchsia-500 to-blue-500 text-white shadow-[0_0_24px_rgba(124,58,237,0.4)] hover:opacity-90"
        >
          {blockMut.isPending && <Loader2 className="h-4 w-4 animate-spin mr-2" />}
          🚫 Заблокировать
        </Button>
      </CardContent>
    </Card>
  );
}

export default BlocksTab;
