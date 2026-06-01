// Eugene 2026-05-23 Босс «Информация о Музе» — публичное меню разделов
// о продукте. Trigger-кнопка + modal с tabs/accordion + markdown body
// + список загруженных к разделу файлов.
//
// Brand-style consistency rule: purple → fuchsia → cyan gradient, glass-card,
// font-display titles, font-sans body. Layout-fit-no-overlap rule: modal
// max-h-[88dvh] + scroll body, кнопка не перекрывает FAB-кнопки (Музa, S).

import { useEffect, useMemo, useState } from "react";
import { marked } from "marked";
import {
  Dialog,
  DialogContent,
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
  attachments: Attachment[];
};

// Лёгкая sanitization rendered HTML — удаляем потенциально опасные
// элементы. Контент пишет админ (не пользователи), но на всякий случай.
function sanitizeHtml(raw: string): string {
  let s = String(raw || "");
  s = s.replace(/<script\b[^>]*>[\s\S]*?<\/script\s*>/gi, "");
  s = s.replace(/<style\b[^>]*>[\s\S]*?<\/style\s*>/gi, "");
  s = s.replace(/<iframe\b[^>]*>[\s\S]*?<\/iframe\s*>/gi, "");
  s = s.replace(/<object\b[^>]*>[\s\S]*?<\/object\s*>/gi, "");
  s = s.replace(/\son[a-z]+\s*=\s*"[^"]*"/gi, "");
  s = s.replace(/\son[a-z]+\s*=\s*'[^']*'/gi, "");
  s = s.replace(/\son[a-z]+\s*=\s*[^\s>]+/gi, "");
  s = s.replace(/(href|src)\s*=\s*"\s*javascript:[^"]*"/gi, '$1="#"');
  s = s.replace(/(href|src)\s*=\s*'\s*javascript:[^']*'/gi, "$1='#'");
  return s;
}

function renderMarkdown(md: string): string {
  try {
    const html = marked.parse(md || "", { async: false, breaks: true }) as string;
    return sanitizeHtml(html);
  } catch {
    return sanitizeHtml(md || "");
  }
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

function attachmentIcon(mime: string): string {
  if (mime.startsWith("image/")) return "🖼";
  if (mime === "application/pdf") return "📄";
  if (mime.startsWith("audio/")) return "🎵";
  if (mime.startsWith("video/")) return "🎬";
  if (mime.startsWith("text/")) return "📝";
  return "📎";
}

export function MuzaInfoMenu() {
  const [open, setOpen] = useState(false);
  const [sections, setSections] = useState<Section[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [activeId, setActiveId] = useState<number | null>(null);

  useEffect(() => {
    if (!open) return;
    let aborted = false;
    setLoading(true);
    setError(null);
    fetch("/api/info/sections", { cache: "no-store" })
      .then((r) => r.json())
      .then((j) => {
        if (aborted) return;
        if (j?.error) throw new Error(j.error);
        const rows: Section[] = Array.isArray(j?.data) ? j.data : [];
        setSections(rows);
        if (rows.length > 0 && activeId === null) {
          setActiveId(rows[0].id);
        }
      })
      .catch((e) => {
        if (!aborted) setError(e?.message ?? String(e));
      })
      .finally(() => {
        if (!aborted) setLoading(false);
      });
    return () => {
      aborted = true;
    };
  }, [open]);

  const active = useMemo(
    () => sections.find((s) => s.id === activeId) ?? sections[0] ?? null,
    [sections, activeId],
  );

  return (
    <>
      {/* Trigger button — brand gradient + glow */}
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="inline-flex items-center gap-2 rounded-full px-5 py-2.5 text-sm font-sans font-medium text-white
                   bg-gradient-to-r from-purple-500 via-fuchsia-500 to-blue-500
                   shadow-[0_0_20px_rgba(217,70,239,0.35)]
                   hover:shadow-[0_0_28px_rgba(217,70,239,0.55)] hover:scale-[1.03]
                   active:scale-[0.97] transition-all
                   border border-fuchsia-300/30"
        data-testid="muza-info-trigger"
        aria-label="Открыть информацию о Музе"
      >
        <span className="text-base">📖</span>
        <span>О Музе</span>
      </button>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent
          className="max-w-4xl w-[calc(100vw-2rem)] max-h-[88dvh] overflow-hidden
                     bg-gradient-to-br from-[#0a0a17]/95 via-[#1a0f2e]/95 to-[#0a0a17]/95
                     backdrop-blur-xl border border-purple-500/30"
        >
          <DialogHeader>
            <DialogTitle className="font-display text-2xl sm:text-3xl font-bold">
              <span className="bg-gradient-to-r from-purple-400 via-fuchsia-300 to-cyan-300 bg-clip-text text-transparent">
                Информация о Музе
              </span>
            </DialogTitle>
            <p className="text-xs text-muted-foreground font-sans">
              Всё о MuzaAi — как работает, сколько стоит, какие возможности
            </p>
          </DialogHeader>

          {loading && (
            <div className="flex items-center justify-center py-12">
              <div className="inline-block animate-spin rounded-full h-8 w-8 border-b-2 border-purple-400"></div>
            </div>
          )}

          {error && (
            <div className="rounded-xl border border-red-500/30 bg-red-500/10 p-4 text-sm text-red-300">
              Не удалось загрузить разделы: {error}
            </div>
          )}

          {!loading && !error && sections.length === 0 && (
            <div className="py-12 text-center text-muted-foreground font-sans text-sm">
              Разделы пока не настроены
            </div>
          )}

          {!loading && !error && sections.length > 0 && (
            <div className="grid grid-cols-1 md:grid-cols-[220px_1fr] gap-4 overflow-hidden">
              {/* Sidebar — список разделов */}
              <nav
                className="md:max-h-[60dvh] overflow-y-auto md:pr-2
                           flex md:flex-col gap-1 overflow-x-auto md:overflow-x-visible
                           snap-x md:snap-none"
              >
                {sections.map((s) => {
                  const isActive = active?.id === s.id;
                  return (
                    <button
                      key={s.id}
                      type="button"
                      onClick={() => setActiveId(s.id)}
                      className={`
                        shrink-0 md:shrink text-left rounded-xl px-3 py-2 text-sm font-sans
                        transition-all snap-start
                        ${
                          isActive
                            ? "bg-gradient-to-r from-purple-500/30 via-fuchsia-500/20 to-blue-500/30 border border-fuchsia-400/40 text-white shadow-[0_0_16px_rgba(217,70,239,0.25)]"
                            : "bg-white/[0.03] border border-white/[0.05] text-white/70 hover:bg-white/[0.08] hover:text-white"
                        }
                      `}
                      data-testid={`muza-info-tab-${s.slug}`}
                    >
                      <span className="inline-flex items-center gap-2 whitespace-nowrap md:whitespace-normal">
                        <span className="text-base shrink-0">{s.emoji || "•"}</span>
                        <span className="font-medium">{s.title}</span>
                      </span>
                    </button>
                  );
                })}
              </nav>

              {/* Content — выбранный раздел */}
              <div className="md:max-h-[60dvh] overflow-y-auto pr-1">
                {active && (
                  <article className="space-y-4">
                    <header>
                      <h2 className="font-display text-xl sm:text-2xl font-bold text-white inline-flex items-center gap-2">
                        <span className="text-2xl sm:text-3xl">{active.emoji || "📖"}</span>
                        <span className="bg-gradient-to-r from-purple-300 via-fuchsia-200 to-cyan-300 bg-clip-text text-transparent">
                          {active.title}
                        </span>
                      </h2>
                    </header>

                    <div
                      className="muza-info-body text-sm sm:text-base font-sans text-white/80 leading-relaxed
                                 [&_a]:text-cyan-300 [&_a]:underline [&_a:hover]:text-cyan-200
                                 [&_strong]:text-white [&_strong]:font-semibold
                                 [&_h1]:text-lg [&_h1]:font-bold [&_h1]:text-white [&_h1]:mt-4 [&_h1]:mb-2
                                 [&_h2]:text-base [&_h2]:font-bold [&_h2]:text-white [&_h2]:mt-3 [&_h2]:mb-2
                                 [&_h3]:text-sm [&_h3]:font-bold [&_h3]:text-white [&_h3]:mt-3 [&_h3]:mb-1
                                 [&_p]:my-2
                                 [&_ul]:my-2 [&_ul]:pl-5 [&_ul]:list-disc
                                 [&_ol]:my-2 [&_ol]:pl-5 [&_ol]:list-decimal
                                 [&_li]:my-1
                                 [&_code]:bg-purple-500/15 [&_code]:text-fuchsia-200 [&_code]:px-1.5 [&_code]:py-0.5 [&_code]:rounded
                                 [&_pre]:bg-black/40 [&_pre]:p-3 [&_pre]:rounded-lg [&_pre]:my-3 [&_pre]:overflow-x-auto
                                 [&_blockquote]:border-l-2 [&_blockquote]:border-purple-400/60 [&_blockquote]:pl-3 [&_blockquote]:italic [&_blockquote]:text-white/70 [&_blockquote]:my-3"
                      dangerouslySetInnerHTML={{ __html: renderMarkdown(active.bodyMarkdown) }}
                    />

                    {active.attachments && active.attachments.length > 0 && (
                      <section className="space-y-2 pt-2 border-t border-white/[0.06]">
                        <h3 className="text-xs font-sans font-semibold uppercase tracking-wider text-fuchsia-300/80">
                          Прикреплённые файлы
                        </h3>
                        <ul className="space-y-2">
                          {active.attachments.map((a) => {
                            const isImage = a.mime.startsWith("image/");
                            return (
                              <li
                                key={a.filename}
                                className="rounded-xl border border-purple-400/20 bg-white/[0.03] p-3"
                              >
                                {isImage ? (
                                  <a
                                    href={a.url}
                                    target="_blank"
                                    rel="noopener noreferrer"
                                    className="block"
                                  >
                                    <img
                                      src={a.url}
                                      alt={a.originalName}
                                      className="rounded-lg max-h-64 w-auto mx-auto"
                                      loading="lazy"
                                    />
                                    <div className="mt-2 text-xs text-white/60 text-center">
                                      {a.originalName} · {formatBytes(a.size)}
                                    </div>
                                  </a>
                                ) : (
                                  <a
                                    href={a.url}
                                    target="_blank"
                                    rel="noopener noreferrer"
                                    download={a.originalName}
                                    className="flex items-center gap-3 text-sm hover:text-cyan-300 transition-colors"
                                  >
                                    <span className="text-2xl">{attachmentIcon(a.mime)}</span>
                                    <span className="flex-1 min-w-0">
                                      <span className="block font-medium text-white truncate">
                                        {a.originalName}
                                      </span>
                                      <span className="block text-xs text-white/50">
                                        {formatBytes(a.size)} · {a.mime}
                                      </span>
                                    </span>
                                    <span className="text-xs text-cyan-400 shrink-0">скачать ↓</span>
                                  </a>
                                )}
                              </li>
                            );
                          })}
                        </ul>
                      </section>
                    )}
                  </article>
                )}
              </div>
            </div>
          )}
        </DialogContent>
      </Dialog>
    </>
  );
}

export default MuzaInfoMenu;
