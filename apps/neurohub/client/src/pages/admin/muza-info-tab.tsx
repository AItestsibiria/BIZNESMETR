// Eugene 2026-05-23 Босс «заведи у админа возможность делать правки,
// загружать файлы к конкретным в том числе новым пунктам меню, назови
// в админке Информация о Музе». Admin CMS для muza_info_sections.
//
// Изолированный компонент — подключается в admin-v304.tsx ОДНОЙ строкой
// импорта + одной строкой TabsTrigger/TabsContent.
//
// Эндпоинты бэка — server/plugins/muza-info/module.ts.

import { useMemo, useRef, useState } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { queryClient } from "@/lib/queryClient";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

type Attachment = {
  filename: string;
  originalName: string;
  url: string;
  size: number;
  mime: string;
  uploadedAt: number;
};

type Section = {
  id: number;
  slug: string;
  title: string;
  emoji: string | null;
  position: number;
  bodyMarkdown: string;
  attachmentsJson: string;
  attachments: Attachment[];
  isPublished: number;
  createdAt: number;
  updatedAt: number;
};

type Draft = Partial<Section> & { __new?: boolean };

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

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

export default function MuzaInfoTab({ toast }: { toast?: any }) {
  const { data, isLoading, error } = useQuery({
    queryKey: ["admin-muza-info-sections"],
    queryFn: () => jget<Section[]>("/api/admin/v304/info/sections"),
  });

  const sections = useMemo(() => data ?? [], [data]);
  const [edit, setEdit] = useState<Draft | null>(null);

  const invalidate = () => {
    queryClient.invalidateQueries({ queryKey: ["admin-muza-info-sections"] });
  };

  const onCreate = () => {
    setEdit({
      __new: true,
      slug: "",
      title: "",
      emoji: "📖",
      position: (sections[sections.length - 1]?.position ?? 0) + 10,
      bodyMarkdown: "",
      isPublished: 1,
      attachments: [],
    });
  };

  const onEdit = (s: Section) => {
    setEdit({ ...s });
  };

  return (
    <div className="space-y-6">
      <div className="p-4 rounded-2xl border border-purple-500/20 bg-gradient-to-br from-purple-500/[0.05] via-fuchsia-500/[0.04] to-blue-500/[0.05]">
        <div className="flex items-start justify-between gap-3 flex-wrap">
          <div>
            <h2 className="text-lg font-display font-bold text-white mb-1">
              <span className="bg-gradient-to-r from-purple-300 via-fuchsia-200 to-cyan-300 bg-clip-text text-transparent">
                📖 Информация о Музе
              </span>
            </h2>
            <p className="text-xs text-muted-foreground font-sans">
              Разделы публичного меню «О Музе» на главной. CRUD + загрузка файлов.
              Контент обновляется без redeploy.
            </p>
          </div>
          <Button
            onClick={onCreate}
            className="bg-gradient-to-r from-purple-500 via-fuchsia-500 to-blue-500 text-white shadow-[0_0_16px_rgba(217,70,239,0.35)] hover:shadow-[0_0_24px_rgba(217,70,239,0.55)]"
            data-testid="muza-info-add"
          >
            + Добавить раздел
          </Button>
        </div>
      </div>

      {isLoading && (
        <div className="flex items-center justify-center py-12">
          <div className="inline-block animate-spin rounded-full h-8 w-8 border-b-2 border-purple-400"></div>
        </div>
      )}

      {error && (
        <div className="rounded-xl border border-red-500/30 bg-red-500/10 p-4 text-sm text-red-300">
          Не удалось загрузить разделы: {(error as Error).message}
        </div>
      )}

      {!isLoading && sections.length === 0 && (
        <div className="py-12 text-center text-muted-foreground font-sans text-sm">
          Пока нет разделов — нажмите «Добавить раздел»
        </div>
      )}

      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
        {sections.map((s) => (
          <Card
            key={s.id}
            className="bg-white/[0.03] border border-purple-400/15 hover:border-fuchsia-400/40 transition-colors cursor-pointer"
            onClick={() => onEdit(s)}
            data-testid={`muza-info-card-${s.slug}`}
          >
            <CardContent className="p-4 space-y-2">
              <div className="flex items-start justify-between gap-2">
                <div className="flex items-start gap-2 min-w-0 flex-1">
                  <span className="text-2xl shrink-0">{s.emoji || "📖"}</span>
                  <div className="min-w-0 flex-1">
                    <h3 className="text-sm font-sans font-bold text-white truncate">
                      {s.title}
                    </h3>
                    <code className="text-[10px] font-mono text-fuchsia-300/70">
                      {s.slug}
                    </code>
                  </div>
                </div>
                <div className="flex flex-col items-end gap-1 shrink-0">
                  {s.isPublished ? (
                    <Badge className="bg-emerald-500/20 text-emerald-300 border-emerald-400/30 text-[10px]">
                      опубл.
                    </Badge>
                  ) : (
                    <Badge className="bg-amber-500/20 text-amber-300 border-amber-400/30 text-[10px]">
                      черновик
                    </Badge>
                  )}
                  <span className="text-[10px] font-mono text-white/40">
                    pos: {s.position}
                  </span>
                </div>
              </div>
              <p className="text-xs font-sans text-white/60 line-clamp-2">
                {(s.bodyMarkdown || "").slice(0, 120) || <em>пусто</em>}
              </p>
              {s.attachments && s.attachments.length > 0 && (
                <div className="text-[11px] text-cyan-300/80">
                  📎 файлов: {s.attachments.length}
                </div>
              )}
            </CardContent>
          </Card>
        ))}
      </div>

      {edit && (
        <SectionEditor
          draft={edit}
          onClose={() => setEdit(null)}
          onSaved={() => {
            invalidate();
            setEdit(null);
          }}
          onRefresh={(updated) => {
            invalidate();
            setEdit(updated);
          }}
          toast={toast}
        />
      )}
    </div>
  );
}

function SectionEditor({
  draft,
  onClose,
  onSaved,
  onRefresh,
  toast,
}: {
  draft: Draft;
  onClose: () => void;
  onSaved: () => void;
  onRefresh: (updated: Draft) => void;
  toast?: any;
}) {
  const [d, setD] = useState<Draft>(draft);
  const [uploading, setUploading] = useState(false);
  const fileRef = useRef<HTMLInputElement | null>(null);

  const isNew = !!d.__new;

  const saveMut = useMutation({
    mutationFn: async () => {
      if (isNew) {
        const slug = (d.slug || "").trim().toLowerCase();
        if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(slug)) {
          throw new Error("slug: a-z, 0-9, дефис (1-64 символов, начинается с буквы/цифры)");
        }
        if (!(d.title || "").trim()) throw new Error("Название обязательно");
        return jsend<{ id: number }>("POST", "/api/admin/v304/info/sections", {
          slug,
          title: d.title,
          emoji: d.emoji ?? null,
          position: d.position ?? 0,
          bodyMarkdown: d.bodyMarkdown ?? "",
          isPublished: d.isPublished ?? 1,
        });
      }
      return jsend<{ id: number }>("PUT", `/api/admin/v304/info/sections/${d.id}`, {
        title: d.title,
        emoji: d.emoji ?? null,
        position: d.position ?? 0,
        bodyMarkdown: d.bodyMarkdown ?? "",
        isPublished: d.isPublished ?? 1,
      });
    },
    onSuccess: () => {
      toast?.({ title: isNew ? "Раздел создан" : "Сохранено" });
      onSaved();
    },
    onError: (e: any) => {
      toast?.({
        title: "Ошибка",
        description: e?.message ?? String(e),
        variant: "destructive",
      });
    },
  });

  const deleteMut = useMutation({
    mutationFn: async () => {
      if (!d.id) return;
      return jsend("DELETE", `/api/admin/v304/info/sections/${d.id}`);
    },
    onSuccess: () => {
      toast?.({ title: "Удалено" });
      onSaved();
    },
    onError: (e: any) => {
      toast?.({
        title: "Ошибка удаления",
        description: e?.message ?? String(e),
        variant: "destructive",
      });
    },
  });

  const uploadFile = async (file: File) => {
    if (!d.id) {
      toast?.({
        title: "Сначала сохраните раздел",
        description: "Загружать файлы можно после создания записи",
        variant: "destructive",
      });
      return;
    }
    if (file.size > 10 * 1024 * 1024) {
      toast?.({
        title: "Файл слишком большой",
        description: "Максимум 10 MB",
        variant: "destructive",
      });
      return;
    }
    setUploading(true);
    try {
      const form = new FormData();
      form.append("file", file);
      const r = await fetch(`/api/admin/v304/info/sections/${d.id}/upload`, {
        method: "POST",
        body: form,
        credentials: "include",
      });
      if (!r.ok) throw new Error(`${r.status}: ${await r.text()}`);
      const j = await r.json();
      if (j?.error) throw new Error(j.error);
      const newAttachment = j.data as Attachment;
      const next = {
        ...d,
        attachments: [...(d.attachments || []), newAttachment],
      };
      setD(next);
      onRefresh(next);
      toast?.({ title: "Файл загружен" });
    } catch (e: any) {
      toast?.({
        title: "Ошибка загрузки",
        description: e?.message ?? String(e),
        variant: "destructive",
      });
    } finally {
      setUploading(false);
      if (fileRef.current) fileRef.current.value = "";
    }
  };

  const removeAttachment = async (filename: string) => {
    if (!d.id) return;
    if (!confirm("Удалить файл?")) return;
    try {
      await jsend(
        "DELETE",
        `/api/admin/v304/info/sections/${d.id}/files/${encodeURIComponent(filename)}`,
      );
      const next = {
        ...d,
        attachments: (d.attachments || []).filter((a) => a.filename !== filename),
      };
      setD(next);
      onRefresh(next);
      toast?.({ title: "Файл удалён" });
    } catch (e: any) {
      toast?.({
        title: "Ошибка",
        description: e?.message ?? String(e),
        variant: "destructive",
      });
    }
  };

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="font-display">
            {isNew ? "Новый раздел" : `Редактирование: ${d.title || d.slug}`}
          </DialogTitle>
        </DialogHeader>

        <div className="space-y-4">
          <div className="grid grid-cols-[80px_1fr] gap-3">
            <div>
              <Label className="text-xs">Иконка</Label>
              <Input
                value={d.emoji ?? ""}
                onChange={(e) => setD({ ...d, emoji: e.target.value })}
                placeholder="📖"
                maxLength={8}
                className="text-center text-xl"
                data-testid="muza-info-emoji"
              />
            </div>
            <div>
              <Label className="text-xs">Название</Label>
              <Input
                value={d.title ?? ""}
                onChange={(e) => setD({ ...d, title: e.target.value })}
                placeholder="Сколько стоит"
                maxLength={200}
                data-testid="muza-info-title"
              />
            </div>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label className="text-xs">Slug (URL-id)</Label>
              <Input
                value={d.slug ?? ""}
                onChange={(e) => setD({ ...d, slug: e.target.value.toLowerCase() })}
                placeholder="pricing"
                maxLength={64}
                disabled={!isNew}
                className="font-mono text-sm"
                data-testid="muza-info-slug"
              />
              {!isNew && (
                <p className="text-[10px] text-muted-foreground mt-1">
                  Slug менять нельзя после создания
                </p>
              )}
            </div>
            <div>
              <Label className="text-xs">Позиция (порядок)</Label>
              <Input
                type="number"
                value={d.position ?? 0}
                onChange={(e) => setD({ ...d, position: Number(e.target.value) || 0 })}
                min={0}
                step={10}
                data-testid="muza-info-position"
              />
            </div>
          </div>

          <div>
            <Label className="text-xs">Контент (Markdown)</Label>
            <Textarea
              value={d.bodyMarkdown ?? ""}
              onChange={(e) => setD({ ...d, bodyMarkdown: e.target.value })}
              placeholder="**Жирный**, *курсив*, [ссылка](https://...), - список, # заголовок"
              rows={10}
              maxLength={50_000}
              className="font-mono text-sm"
              data-testid="muza-info-body"
            />
            <p className="text-[10px] text-muted-foreground mt-1">
              Markdown: ** жирный **, * курсив *, [текст](url), - список, # заголовок
            </p>
          </div>

          <div className="flex items-center gap-3">
            <Switch
              checked={!!d.isPublished}
              onCheckedChange={(v) => setD({ ...d, isPublished: v ? 1 : 0 })}
              data-testid="muza-info-published"
            />
            <Label className="text-sm">
              {d.isPublished ? "Опубликовано" : "Черновик (видит только админ)"}
            </Label>
          </div>

          {/* Файлы — только после сохранения */}
          <div className="space-y-2 pt-2 border-t border-white/[0.06]">
            <Label className="text-xs">Прикреплённые файлы</Label>
            {!d.id ? (
              <p className="text-xs text-muted-foreground italic">
                Сначала сохраните раздел, потом сможете загружать файлы
              </p>
            ) : (
              <>
                {(d.attachments || []).length === 0 && (
                  <p className="text-xs text-muted-foreground italic">Файлов нет</p>
                )}
                {(d.attachments || []).map((a) => (
                  <div
                    key={a.filename}
                    className="flex items-center gap-2 p-2 rounded-lg border border-white/[0.08] bg-white/[0.02] text-xs"
                  >
                    <span className="text-base shrink-0">
                      {a.mime.startsWith("image/")
                        ? "🖼"
                        : a.mime.startsWith("audio/")
                          ? "🎵"
                          : a.mime.startsWith("video/")
                            ? "🎬"
                            : a.mime === "application/pdf"
                              ? "📄"
                              : "📎"}
                    </span>
                    <div className="flex-1 min-w-0">
                      <a
                        href={a.url}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="font-medium text-white hover:text-cyan-300 truncate block"
                      >
                        {a.originalName}
                      </a>
                      <span className="text-[10px] text-white/50">
                        {formatBytes(a.size)} · {a.mime}
                      </span>
                    </div>
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => removeAttachment(a.filename)}
                      className="text-red-300 hover:text-red-200 hover:bg-red-500/10 h-7"
                      data-testid={`muza-info-file-delete-${a.filename}`}
                    >
                      ✕
                    </Button>
                  </div>
                ))}
                <div>
                  <input
                    ref={fileRef}
                    type="file"
                    className="hidden"
                    onChange={(e) => {
                      const f = e.target.files?.[0];
                      if (f) uploadFile(f);
                    }}
                    accept="image/*,application/pdf,audio/mpeg,audio/wav,video/mp4,video/quicktime,text/plain"
                  />
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={uploading}
                    onClick={() => fileRef.current?.click()}
                    className="border-purple-400/30 hover:bg-purple-500/15"
                    data-testid="muza-info-upload-button"
                  >
                    {uploading ? "Загружаем..." : "📎 Загрузить файл"}
                  </Button>
                  <p className="text-[10px] text-muted-foreground mt-1">
                    До 10 MB. jpg/png/webp/gif/svg/pdf/mp3/wav/mp4/mov/txt.
                  </p>
                </div>
              </>
            )}
          </div>
        </div>

        <DialogFooter className="gap-2 flex-wrap">
          {!isNew && d.id && (
            <Button
              variant="destructive"
              onClick={() => {
                if (confirm(`Удалить раздел «${d.title}»? Все файлы тоже будут удалены.`)) {
                  deleteMut.mutate();
                }
              }}
              disabled={deleteMut.isPending}
              data-testid="muza-info-delete"
            >
              {deleteMut.isPending ? "Удаляем..." : "🗑 Удалить"}
            </Button>
          )}
          <div className="flex-1" />
          <Button variant="outline" onClick={onClose}>
            Отмена
          </Button>
          <Button
            onClick={() => saveMut.mutate()}
            disabled={saveMut.isPending}
            className="bg-gradient-to-r from-purple-500 via-fuchsia-500 to-blue-500 text-white"
            data-testid="muza-info-save"
          >
            {saveMut.isPending ? "Сохраняем..." : isNew ? "Создать" : "Сохранить"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
