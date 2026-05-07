// v304 admin panel — Overview / Templates / Flags / Leads / Audit.
// Spec: docs/strategy/original/03 §4 + Eugene «Backup-before-edit» правило.
//
// Все редакции сохраняют snapshot в admin_audit_log; в успешном
// ответе возвращается auditId, по которому можно откатить через
// POST /api/admin/v304/audit/:id/restore. Это и видно на вкладке Audit.

import { useState } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { useAuth } from "@/lib/auth";
import { useToast } from "@/hooks/use-toast";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Switch } from "@/components/ui/switch";

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

  if (!user || user.email !== "egnovoselov@gmail.com") {
    return (
      <div className="p-8 max-w-2xl mx-auto">
        <Card>
          <CardHeader>
            <CardTitle>Доступ запрещён</CardTitle>
          </CardHeader>
          <CardContent>
            Эта панель только для администратора. Войди под admin-аккаунтом.
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div className="container mx-auto p-4 sm:p-6 max-w-7xl">
      <h1 className="text-2xl sm:text-3xl font-bold mb-6">Admin · v304</h1>
      <Tabs defaultValue="overview">
        <TabsList className="mb-4 flex flex-wrap">
          <TabsTrigger value="overview">Обзор</TabsTrigger>
          <TabsTrigger value="templates">Шаблоны</TabsTrigger>
          <TabsTrigger value="flags">Feature flags</TabsTrigger>
          <TabsTrigger value="leads">Лиды</TabsTrigger>
          <TabsTrigger value="audit">Audit log</TabsTrigger>
        </TabsList>
        <TabsContent value="overview"><OverviewTab toast={toast} /></TabsContent>
        <TabsContent value="templates"><TemplatesTab toast={toast} /></TabsContent>
        <TabsContent value="flags"><FlagsTab toast={toast} /></TabsContent>
        <TabsContent value="leads"><LeadsTab toast={toast} /></TabsContent>
        <TabsContent value="audit"><AuditTab toast={toast} /></TabsContent>
      </Tabs>
    </div>
  );
}

// ============================================================
// Overview tab
// ============================================================
function OverviewTab({ toast }: { toast: any }) {
  const { data, isLoading, error } = useQuery({
    queryKey: ["admin-overview"],
    queryFn: () => fetcher<Overview>("/api/admin/v304/overview"),
    refetchInterval: 30000,
  });

  if (isLoading) return <div>Загрузка…</div>;
  if (error) return <div className="text-red-500">Ошибка: {(error as Error).message}</div>;
  if (!data) return null;

  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
      <Card>
        <CardHeader><CardTitle>Плагины</CardTitle></CardHeader>
        <CardContent>
          <div className="text-3xl font-bold">{data.plugins.active}/{data.plugins.total}</div>
          <div className="text-sm text-muted-foreground">
            Failed: {data.plugins.failed}
          </div>
        </CardContent>
      </Card>
      <Card>
        <CardHeader><CardTitle>События за 24ч</CardTitle></CardHeader>
        <CardContent>
          <div className="text-3xl font-bold">{data.events.total}</div>
          <div className="text-xs mt-2 space-y-1 max-h-32 overflow-auto">
            {data.events.breakdown.slice(0, 8).map((e) => (
              <div key={e.name} className="flex justify-between">
                <span className="truncate">{e.name}</span>
                <span className="font-mono">{e.count}</span>
              </div>
            ))}
          </div>
        </CardContent>
      </Card>
      <Card>
        <CardHeader><CardTitle>Лиды</CardTitle></CardHeader>
        <CardContent>
          <div className="text-3xl font-bold">{data.leads.total}</div>
          <div className="text-xs mt-2 space-y-1">
            {Object.entries(data.leads.byStatus).map(([s, c]) => (
              <div key={s} className="flex justify-between">
                <span>{s}</span>
                <span className="font-mono">{c}</span>
              </div>
            ))}
          </div>
        </CardContent>
      </Card>
      <Card className="lg:col-span-2">
        <CardHeader><CardTitle>Агенты (24ч)</CardTitle></CardHeader>
        <CardContent>
          <table className="w-full text-sm">
            <thead><tr className="text-left text-xs text-muted-foreground">
              <th>Агент</th><th>OK</th><th>Failed</th><th>Pending</th>
            </tr></thead>
            <tbody>
              {Object.entries(data.agents).map(([n, s]) => (
                <tr key={n}>
                  <td className="py-1">{n}</td>
                  <td>{s.executed}</td>
                  <td className={s.failed > 0 ? "text-red-500" : ""}>{s.failed}</td>
                  <td>{s.pending}</td>
                </tr>
              ))}
              {Object.keys(data.agents).length === 0 && (
                <tr><td colSpan={4} className="text-muted-foreground py-2">Нет действий за 24ч</td></tr>
              )}
            </tbody>
          </table>
        </CardContent>
      </Card>
      <Card>
        <CardHeader><CardTitle>Свежие генерации</CardTitle></CardHeader>
        <CardContent>
          <div className="text-xs space-y-1 max-h-40 overflow-auto">
            {data.generations.recent.slice(0, 10).map((g) => (
              <div key={g.id} className="flex justify-between">
                <span>#{g.id} {g.type}</span>
                <Badge variant={g.status === "done" ? "default" : "outline"}>{g.status}</Badge>
              </div>
            ))}
          </div>
        </CardContent>
      </Card>
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
