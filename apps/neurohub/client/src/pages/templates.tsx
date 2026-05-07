// /templates — публичная страница со всеми gen_templates.
// Клик → перенос lyrics + style в /music через sessionStorage
// (тот же механизм, что используется при transfer из /lyrics в /music).
//
// Sprint 2 финальный закрытие: backend уже отдаёт 11 шаблонов через
// /api/gen-templates, теперь у пользователя есть UI чтобы их увидеть
// и одним кликом получить prefilled генерацию.

import { useQuery } from "@tanstack/react-query";
import { useLocation } from "wouter";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";

type Template = {
  id: number;
  slug: string;
  name: string;
  category: string | null;
  description: string | null;
  promptTemplate: string | null;
  style: string | null;
  structuralTagsJson: string | null;
  recommendedBpm: number | null;
  recommendedKey: string | null;
  popularity: number;
};

function fetcher<T>(url: string): Promise<T> {
  return fetch(url, { credentials: "include" }).then(async (r) => {
    if (!r.ok) throw new Error(`${r.status}`);
    return ((await r.json()).data ?? null) as T;
  });
}

const CATEGORY_LABELS: Record<string, { label: string; emoji: string; color: string }> = {
  celebration: { label: "Праздник", emoji: "🎉", color: "from-amber-500/20 to-transparent border-amber-500/40" },
  anthem:      { label: "Гимн",     emoji: "👑", color: "from-violet-600/30 to-transparent border-violet-500/60" },
  b2b:         { label: "Бизнес",   emoji: "💼", color: "from-slate-500/20 to-transparent border-slate-500/40" },
  kids:        { label: "Детям",    emoji: "🧸", color: "from-pink-500/20 to-transparent border-pink-500/40" },
  memory:      { label: "Память",   emoji: "🕊️", color: "from-blue-500/20 to-transparent border-blue-500/40" },
  love:        { label: "Любовь",   emoji: "💛", color: "from-rose-500/20 to-transparent border-rose-500/40" },
  ethnic:      { label: "Этника",   emoji: "🪕", color: "from-emerald-500/20 to-transparent border-emerald-500/40" },
};

export default function TemplatesPage() {
  const [, navigate] = useLocation();
  const { data, isLoading, error } = useQuery({
    queryKey: ["gen-templates-public"],
    queryFn: () => fetcher<Template[]>("/api/gen-templates"),
  });

  const onPick = (t: Template) => {
    try {
      sessionStorage.setItem("__lyricsTransfer", t.promptTemplate ?? "");
      sessionStorage.setItem("__styleTransfer", t.style ?? "");
      sessionStorage.setItem("__fullStyleTransfer", t.style ?? "");
      sessionStorage.setItem("__templateSlugTransfer", t.slug);
    } catch {}
    navigate("/music");
  };

  return (
    <div className="container mx-auto px-4 sm:px-6 py-8 sm:py-12 max-w-6xl">
      <div className="mb-8">
        <h1 className="text-3xl sm:text-4xl font-bold mb-2">Шаблоны песен</h1>
        <p className="text-muted-foreground">
          {data?.length ?? 0} готовых сценариев. Клик — и текст с настройками
          перенесётся на страницу генерации.
        </p>
      </div>

      {isLoading && <div className="text-center text-muted-foreground py-12">Загрузка…</div>}
      {error && <div className="text-rose-500">Ошибка: {(error as Error).message}</div>}

      {data && (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
          {data.map((t) => {
            const cat = t.category ? CATEGORY_LABELS[t.category] : null;
            const isAnthem = t.slug === "v304-anthem";
            const cls = isAnthem
              ? "from-violet-600/30 via-fuchsia-500/15 to-transparent border-violet-500/60 ring-1 ring-violet-500/30"
              : cat?.color ?? "from-slate-500/10 to-transparent border-slate-500/30";
            return (
              <Card
                key={t.slug}
                className={`bg-gradient-to-br ${cls} cursor-pointer hover:scale-[1.02] transition-transform`}
                onClick={() => onPick(t)}
              >
                <CardContent className="p-5 space-y-3">
                  <div className="flex items-start justify-between gap-2">
                    <div className="flex items-center gap-2">
                      {cat && <span className="text-2xl">{cat.emoji}</span>}
                      <Badge variant="outline" className="text-[10px]">
                        {cat?.label ?? t.category ?? "—"}
                      </Badge>
                    </div>
                    {isAnthem && <Badge className="bg-violet-600">официальный</Badge>}
                  </div>
                  <div>
                    <div className="text-lg font-bold">{t.name}</div>
                    <div className="text-xs text-muted-foreground line-clamp-2 mt-1">
                      {t.description}
                    </div>
                  </div>
                  <div className="flex flex-wrap gap-2 text-[11px] text-muted-foreground">
                    {t.recommendedBpm && <span className="rounded bg-white/5 px-2 py-0.5">{t.recommendedBpm} BPM</span>}
                    {t.recommendedKey && <span className="rounded bg-white/5 px-2 py-0.5">{t.recommendedKey}</span>}
                    {t.style && (
                      <span className="rounded bg-white/5 px-2 py-0.5 truncate max-w-full" title={t.style}>
                        {t.style.split(",")[0]}
                      </span>
                    )}
                  </div>
                  <Button size="sm" className="w-full" onClick={(e) => { e.stopPropagation(); onPick(t); }}>
                    Создать → /music
                  </Button>
                </CardContent>
              </Card>
            );
          })}
        </div>
      )}
    </div>
  );
}
