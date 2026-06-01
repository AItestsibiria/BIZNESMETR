// Admin CMS для новостей лендинга (Eugene 2026-05-17 Босс).
// Изолированный компонент — подключается в admin-v304.tsx ОДНОЙ строкой
// импорта + одной строкой TabsTrigger/TabsContent. Не вмешивается в другие
// вкладки (чтобы не пересекаться с параллельным subagent'ом).
//
// Эндпоинты бэка живут в server/plugins/landing-cms/module.ts.

import { useMemo, useRef, useState } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { queryClient } from "@/lib/queryClient";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";

const ALL = "__all__";
const NEW_CAT = "__new__";

type LandingNewsRow = {
  id: number;
  category: string | null;
  title: string;
  body: string | null;
  bodyHtml: string | null;
  iconUrl: string | null;
  iconEmoji: string | null;
  ctaUrl: string | null;
  ctaLabel: string | null;
  badgeColor: string | null;
  borderColor: string | null;
  publishedAt: string | null;
  sortOrder: number | null;
  position: number | null;
  active: number | null;
  isVisible: number | null;
  viewCount: number | null;
  createdAt: string | null;
  updatedAt: string | null;
};

type Draft = Partial<LandingNewsRow> & { __new?: boolean };

// Локальный fetcher — задублирован чтобы не зависеть от приватной helper'ы
// из admin-v304.tsx (изолируем компонент). Опирается на глобальный fetch-патч
// из lib/auth.tsx — он сам подставляет Authorization: Bearer.
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

export function LandingCmsTab({ toast }: { toast: any }) {
  const { data, isLoading, error } = useQuery({
    queryKey: ["admin-landing-news"],
    queryFn: () => jget<LandingNewsRow[]>("/api/admin/v304/landing-news"),
  });

  const categories = useMemo(() => {
    const set = new Set<string>(["main"]);
    (data ?? []).forEach((r) => {
      if (r.category) set.add(r.category);
    });
    return Array.from(set);
  }, [data]);

  const [activeCat, setActiveCat] = useState<string>(ALL);
  const [edit, setEdit] = useState<Draft | null>(null);
  const [newCatName, setNewCatName] = useState("");
  const [askingCat, setAskingCat] = useState(false);

  const visibleRows = useMemo(() => {
    const rows = data ?? [];
    if (activeCat === ALL) return rows;
    return rows.filter((r) => (r.category ?? "main") === activeCat);
  }, [data, activeCat]);

  const upsert = useMutation({
    mutationFn: async (d: Draft) => {
      const body = {
        category: d.category ?? "main",
        title: d.title ?? "",
        bodyHtml: d.bodyHtml ?? d.body ?? "",
        iconUrl: d.iconUrl ?? null,
        iconEmoji: d.iconEmoji ?? null,
        ctaUrl: d.ctaUrl ?? null,
        ctaLabel: d.ctaLabel ?? null,
        badgeColor: d.badgeColor ?? "purple",
        borderColor: d.borderColor ?? "purple",
        publishedAt: d.publishedAt ?? null,
        sortOrder: typeof d.sortOrder === "number" ? d.sortOrder : 0,
        isVisible: d.isVisible === undefined ? 1 : Number(d.isVisible) ? 1 : 0,
      };
      if (d.__new || !d.id) {
        return jsend<{ id: number }>("POST", "/api/admin/v304/landing-news", body);
      }
      return jsend<{ id: number }>(
        "PUT",
        `/api/admin/v304/landing-news/${d.id}`,
        body,
      );
    },
    onSuccess: () => {
      toast?.({ title: "Сохранено", description: "Запись обновлена" });
      setEdit(null);
      queryClient.invalidateQueries({ queryKey: ["admin-landing-news"] });
    },
    onError: (e: Error) =>
      toast?.({ title: "Ошибка", description: e.message, variant: "destructive" }),
  });

  const remove = useMutation({
    mutationFn: async (id: number) =>
      jsend<{ id: number }>("DELETE", `/api/admin/v304/landing-news/${id}`),
    onSuccess: () => {
      toast?.({ title: "Удалено" });
      queryClient.invalidateQueries({ queryKey: ["admin-landing-news"] });
    },
    onError: (e: Error) =>
      toast?.({ title: "Ошибка", description: e.message, variant: "destructive" }),
  });

  const toggleVisible = useMutation({
    mutationFn: async (row: LandingNewsRow) => {
      const next = row.isVisible ? 0 : 1;
      return jsend<{ id: number }>(
        "PUT",
        `/api/admin/v304/landing-news/${row.id}`,
        { isVisible: next },
      );
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["admin-landing-news"] });
    },
    onError: (e: Error) =>
      toast?.({ title: "Ошибка", description: e.message, variant: "destructive" }),
  });

  const reorder = useMutation({
    mutationFn: async ({ id, sortOrder }: { id: number; sortOrder: number }) =>
      jsend<{ id: number }>("PUT", `/api/admin/v304/landing-news/${id}`, {
        sortOrder,
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["admin-landing-news"] });
    },
    onError: (e: Error) =>
      toast?.({ title: "Ошибка", description: e.message, variant: "destructive" }),
  });

  if (isLoading) return <div>Загрузка…</div>;
  if (error)
    return (
      <div className="text-sm text-red-400">
        Ошибка загрузки: {error instanceof Error ? error.message : String(error)}
      </div>
    );

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="flex items-center justify-between flex-wrap gap-2">
            <span>🏠 Главная — CMS новостей</span>
            <div className="flex items-center gap-2">
              <Button
                size="sm"
                onClick={() =>
                  setEdit({
                    __new: true,
                    category: activeCat === ALL ? "main" : activeCat,
                    isVisible: 1,
                    badgeColor: "purple",
                    borderColor: "purple",
                    sortOrder: 0,
                  })
                }
              >
                + Добавить новость
              </Button>
            </div>
          </CardTitle>
        </CardHeader>
        <CardContent>
          <Tabs value={activeCat} onValueChange={setActiveCat}>
            <TabsList className="flex flex-wrap h-auto">
              <TabsTrigger value={ALL}>Все</TabsTrigger>
              {categories.map((c) => (
                <TabsTrigger key={c} value={c}>
                  {c}
                </TabsTrigger>
              ))}
              <TabsTrigger
                value={NEW_CAT}
                onClick={(e) => {
                  e.preventDefault();
                  setAskingCat(true);
                }}
              >
                + Новая категория
              </TabsTrigger>
            </TabsList>
          </Tabs>

          {askingCat && (
            <div className="mt-3 flex gap-2 items-end">
              <div className="flex-1">
                <Label>Имя новой категории</Label>
                <Input
                  value={newCatName}
                  onChange={(e) => setNewCatName(e.target.value)}
                  placeholder="например: announcements"
                />
              </div>
              <Button
                onClick={() => {
                  const name = newCatName.trim();
                  if (!name) return;
                  // Категория появится после создания первой записи в ней.
                  setEdit({
                    __new: true,
                    category: name,
                    isVisible: 1,
                    badgeColor: "purple",
                    borderColor: "purple",
                    sortOrder: 0,
                  });
                  setActiveCat(name);
                  setNewCatName("");
                  setAskingCat(false);
                }}
              >
                Создать
              </Button>
              <Button variant="outline" onClick={() => setAskingCat(false)}>
                Отмена
              </Button>
            </div>
          )}
        </CardContent>
      </Card>

      <div className="space-y-3">
        {visibleRows.length === 0 && (
          <Card>
            <CardContent className="py-6 text-center text-sm text-muted-foreground">
              В этой категории пока пусто. Нажмите «+ Добавить новость».
            </CardContent>
          </Card>
        )}
        {visibleRows.map((r, idx) => (
          <Card
            key={r.id}
            className={r.isVisible ? "" : "opacity-60"}
            data-testid={`news-card-${r.id}`}
          >
            <CardContent className="p-3 flex items-start gap-3 flex-wrap sm:flex-nowrap">
              <div className="w-14 h-14 rounded-lg bg-muted/40 flex items-center justify-center overflow-hidden shrink-0">
                {r.iconUrl ? (
                  <img
                    src={r.iconUrl}
                    alt=""
                    className="w-full h-full object-cover"
                  />
                ) : r.iconEmoji ? (
                  <span className="text-3xl">{r.iconEmoji}</span>
                ) : (
                  <span className="text-xs text-muted-foreground">—</span>
                )}
              </div>
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 flex-wrap">
                  <Badge variant="outline" className="text-[10px]">
                    {r.category ?? "main"}
                  </Badge>
                  <Badge variant="outline" className="text-[10px]">
                    sort {r.sortOrder ?? 0}
                  </Badge>
                  <Badge variant="outline" className="text-[10px]">
                    👁 {r.viewCount ?? 0}
                  </Badge>
                  {r.publishedAt && (
                    <Badge variant="outline" className="text-[10px]">
                      {r.publishedAt}
                    </Badge>
                  )}
                </div>
                <div className="font-semibold text-sm mt-1 truncate">{r.title}</div>
                <div className="text-xs text-muted-foreground line-clamp-2 mt-0.5">
                  {(r.bodyHtml ?? r.body ?? "").replace(/<[^>]+>/g, " ").slice(0, 160)}
                </div>
              </div>
              <div className="flex flex-col sm:flex-row gap-1 shrink-0">
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => setEdit(r as Draft)}
                  data-testid={`news-edit-${r.id}`}
                >
                  ✏ Редактировать
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => toggleVisible.mutate(r)}
                  data-testid={`news-visible-${r.id}`}
                >
                  {r.isVisible ? "🙈 Скрыть" : "👁 Показать"}
                </Button>
                <div className="flex gap-1">
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={idx === 0}
                    onClick={() => {
                      const prev = visibleRows[idx - 1];
                      if (!prev) return;
                      reorder.mutate({
                        id: r.id,
                        sortOrder: (prev.sortOrder ?? 0) + 1,
                      });
                    }}
                    data-testid={`news-up-${r.id}`}
                  >
                    ↑
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={idx === visibleRows.length - 1}
                    onClick={() => {
                      const next = visibleRows[idx + 1];
                      if (!next) return;
                      reorder.mutate({
                        id: r.id,
                        sortOrder: (next.sortOrder ?? 0) - 1,
                      });
                    }}
                    data-testid={`news-down-${r.id}`}
                  >
                    ↓
                  </Button>
                </div>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => {
                    if (confirm(`Удалить «${r.title}»?`)) remove.mutate(r.id);
                  }}
                  data-testid={`news-delete-${r.id}`}
                >
                  🗑 Удалить
                </Button>
              </div>
            </CardContent>
          </Card>
        ))}
      </div>

      {edit && (
        <EditDialog
          draft={edit}
          onClose={() => setEdit(null)}
          onSave={(d) => upsert.mutate(d)}
          saving={upsert.isPending}
          knownCategories={categories}
          toast={toast}
        />
      )}
    </div>
  );
}

function EditDialog({
  draft,
  onClose,
  onSave,
  saving,
  knownCategories,
  toast,
}: {
  draft: Draft;
  onClose: () => void;
  onSave: (d: Draft) => void;
  saving: boolean;
  knownCategories: string[];
  toast: any;
}) {
  const [d, setD] = useState<Draft>(draft);
  const fileRef = useRef<HTMLInputElement | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const [uploading, setUploading] = useState(false);

  const uploadIcon = async (file: File) => {
    if (file.size > 1024 * 1024) {
      toast?.({
        title: "Файл слишком большой",
        description: "Максимум 1 MB",
        variant: "destructive",
      });
      return;
    }
    setUploading(true);
    try {
      const form = new FormData();
      form.append("icon", file);
      const r = await fetch("/api/admin/v304/landing-news/upload-icon", {
        method: "POST",
        body: form,
        credentials: "include",
      });
      if (!r.ok) throw new Error(`${r.status}: ${await r.text()}`);
      const j = await r.json();
      if (j?.error) throw new Error(j.error);
      setD((cur) => ({ ...cur, iconUrl: j.data.iconUrl }));
      toast?.({ title: "Иконка загружена" });
    } catch (e: any) {
      toast?.({
        title: "Ошибка загрузки",
        description: e?.message ?? String(e),
        variant: "destructive",
      });
    } finally {
      setUploading(false);
    }
  };

  const onDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setDragOver(false);
    const f = e.dataTransfer.files?.[0];
    if (f) uploadIcon(f);
  };

  const titleOk = (d.title ?? "").trim().length > 0;
  const bodyOk = (d.bodyHtml ?? d.body ?? "").trim().length > 0;

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-2xl max-h-[90dvh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>
            {d.__new ? "Новая новость" : `Редактирование #${d.id}`}
          </DialogTitle>
        </DialogHeader>
        <div className="space-y-3">
          <div>
            <Label>Категория</Label>
            <div className="flex gap-2 flex-wrap">
              {knownCategories.map((c) => (
                <Button
                  key={c}
                  size="sm"
                  variant={d.category === c ? "default" : "outline"}
                  onClick={() => setD({ ...d, category: c })}
                  type="button"
                >
                  {c}
                </Button>
              ))}
              <Input
                value={d.category ?? ""}
                onChange={(e) => setD({ ...d, category: e.target.value })}
                placeholder="custom"
                className="max-w-[180px]"
              />
            </div>
          </div>

          <div>
            <Label>Заголовок *</Label>
            <Input
              value={d.title ?? ""}
              onChange={(e) => setD({ ...d, title: e.target.value })}
              placeholder="Заголовок (HTML allowed для gradient-span)"
            />
          </div>

          <div>
            <Label>Тело (HTML / Markdown) *</Label>
            <Textarea
              value={d.bodyHtml ?? d.body ?? ""}
              onChange={(e) => setD({ ...d, bodyHtml: e.target.value })}
              rows={8}
              placeholder="Можно <span>, <a>, <strong>… <script> вырежется при сохранении."
            />
            {bodyOk && (
              <details className="mt-2">
                <summary className="text-xs cursor-pointer text-muted-foreground">
                  Preview
                </summary>
                <div
                  className="mt-2 p-3 rounded-lg border border-border bg-card/40 text-sm prose prose-invert max-w-none"
                  dangerouslySetInnerHTML={{ __html: d.bodyHtml ?? d.body ?? "" }}
                />
              </details>
            )}
          </div>

          <div>
            <Label>Иконка</Label>
            <div
              onDragOver={(e) => {
                e.preventDefault();
                setDragOver(true);
              }}
              onDragLeave={() => setDragOver(false)}
              onDrop={onDrop}
              onClick={() => fileRef.current?.click()}
              className={`mt-1 cursor-pointer rounded-lg border-2 border-dashed p-4 text-center transition-colors ${dragOver ? "border-primary bg-primary/10" : "border-border"}`}
            >
              {d.iconUrl ? (
                <div className="flex items-center gap-3">
                  <img
                    src={d.iconUrl}
                    alt=""
                    className="w-16 h-16 object-cover rounded-md"
                  />
                  <div className="flex-1 text-left">
                    <div className="text-xs text-muted-foreground break-all">
                      {d.iconUrl}
                    </div>
                    <Button
                      size="sm"
                      variant="outline"
                      type="button"
                      className="mt-1"
                      onClick={(e) => {
                        e.stopPropagation();
                        setD({ ...d, iconUrl: null });
                      }}
                    >
                      Убрать
                    </Button>
                  </div>
                </div>
              ) : (
                <div className="text-sm text-muted-foreground">
                  {uploading
                    ? "Загружаю…"
                    : "Перетащите файл сюда или кликните для выбора (jpg/png/webp/svg, ≤1MB)"}
                </div>
              )}
              <input
                ref={fileRef}
                type="file"
                accept="image/jpeg,image/png,image/webp,image/svg+xml"
                hidden
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  if (f) uploadIcon(f);
                  e.target.value = "";
                }}
              />
            </div>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label>Emoji-иконка (fallback)</Label>
              <Input
                value={d.iconEmoji ?? ""}
                onChange={(e) => setD({ ...d, iconEmoji: e.target.value })}
                placeholder="🚀"
                maxLength={4}
              />
            </div>
            <div>
              <Label>Дата (отображается)</Label>
              <Input
                value={d.publishedAt ?? ""}
                onChange={(e) => setD({ ...d, publishedAt: e.target.value })}
                placeholder="12 мая 2026"
              />
            </div>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label>CTA URL</Label>
              <Input
                value={d.ctaUrl ?? ""}
                onChange={(e) => setD({ ...d, ctaUrl: e.target.value })}
                placeholder="https://muzaai.ru/music"
              />
            </div>
            <div>
              <Label>CTA Label</Label>
              <Input
                value={d.ctaLabel ?? ""}
                onChange={(e) => setD({ ...d, ctaLabel: e.target.value })}
                placeholder="Попробовать"
              />
            </div>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label>Цвет рамки</Label>
              <Input
                value={d.borderColor ?? "purple"}
                onChange={(e) => setD({ ...d, borderColor: e.target.value })}
                placeholder="purple / cyan / pink / amber / emerald"
              />
            </div>
            <div>
              <Label>Цвет бейджа</Label>
              <Input
                value={d.badgeColor ?? "purple"}
                onChange={(e) => setD({ ...d, badgeColor: e.target.value })}
                placeholder="purple / cyan / pink / amber / emerald"
              />
            </div>
          </div>

          <div className="grid grid-cols-2 gap-3 items-end">
            <div>
              <Label>Sort Order</Label>
              <Input
                type="number"
                value={d.sortOrder ?? 0}
                onChange={(e) =>
                  setD({
                    ...d,
                    sortOrder: parseInt(e.target.value, 10) || 0,
                  })
                }
              />
            </div>
            <div className="flex items-center gap-2 pb-2">
              <Switch
                checked={!!d.isVisible}
                onCheckedChange={(c) => setD({ ...d, isVisible: c ? 1 : 0 })}
              />
              <Label>Видимая</Label>
            </div>
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Отмена
          </Button>
          <Button
            onClick={() => onSave(d)}
            disabled={!titleOk || !bodyOk || saving || uploading}
          >
            {saving ? "Сохраняю…" : "Сохранить"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export default LandingCmsTab;
