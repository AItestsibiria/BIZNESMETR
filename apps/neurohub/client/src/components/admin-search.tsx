// Eugene 2026-05-15 Босс «строку поиска по всей панели — типа google по проекту».
//
// Глобальный поиск по admin-v304:
// - Статический каталог вкладок (метки, описания, синонимы)
// - Динамический поиск пользователей по name / email / phone
// - Динамический поиск треков (generations) по title / prompt
// - Cmd+K / Ctrl+K shortcut
//
// При клике на результат — onSelect(tab, options) — родитель меняет
// активную вкладку и скроллит к нужному месту.

import { useState, useEffect, useMemo, useRef } from "react";
import { Search, X, Hash, Users as UsersIcon, Music as MusicIcon } from "lucide-react";

interface TabEntry {
  key: string;          // value Tabs (overview / failures / ...)
  label: string;        // отображаемое имя
  description: string;  // что внутри вкладки
  synonyms: string[];   // дополнительные ключевые слова
  emoji?: string;
}

// Статический каталог. Расширяется при добавлении новых вкладок.
const ADMIN_TABS: TabEntry[] = [
  {
    key: "overview", label: "Обзор", emoji: "📊",
    description: "Health всех плагинов, infra-сервисы (БД, диск, GPTunnel), live баланс, лиды, события за 24ч.",
    synonyms: ["health", "статус", "балланс", "плагины", "infrastructure", "обзор", "dashboard", "главная", "панель"],
  },
  {
    key: "friend", label: "Муза", emoji: "👤",
    description: "Профиль помощника-Музы, persona-настройки, KB knowledge base.",
    synonyms: ["муза", "ассистент", "помощник", "persona", "kb", "knowledge", "ани", "татьяна", "мария", "ольга"],
  },
  {
    key: "bot-stats", label: "Бот", emoji: "🤖",
    description: "Статистика Telegram-бота, max-бота: сессии, конверсии, доход из чатов.",
    synonyms: ["bot", "telegram", "max", "tg", "конверсия", "доход", "сессии", "messenger", "чат-бот"],
  },
  {
    key: "ai-keys", label: "Ключи AI", emoji: "🤖",
    description: "API-ключи Anthropic, OpenAI, GPTunnel — статус, баланс, проверка.",
    synonyms: ["claude", "anthropic", "openai", "gptunnel", "api", "ключ", "key", "ai", "балланс", "llm"],
  },
  {
    key: "delegates", label: "Заместители", emoji: "🤝",
    description: "Делегирование прав админа другим email — кто может смотреть и менять.",
    synonyms: ["admin", "delegate", "права", "доступ", "роли", "email", "заместитель"],
  },
  {
    key: "secrets", label: "Секреты", emoji: "🔑",
    description: "Безопасная ротация API-ключей и SMTP. Verify тестовый запрос, runtime-check .env vs процесс.",
    synonyms: ["secret", "key", "rotate", "ротация", "smtp", "email", "пароль", "token", "ключ", ".env", "ротация ключей"],
  },
  {
    key: "templates", label: "Шаблоны", emoji: "📝",
    description: "10+ готовых шаблонов генерации (свадьба, юбилей, корпоратив). Править/удалять с откатом.",
    synonyms: ["template", "шаблон", "свадьба", "юбилей", "корпоратив", "событие", "генерация", "поздравление"],
  },
  {
    key: "flags", label: "Feature flags", emoji: "🚦",
    description: "Включай/выключай фичи без релиза. Toggle по флагу — изменение применяется сразу.",
    synonyms: ["flag", "feature", "флаг", "фича", "toggle", "выключатель", "релиз"],
  },
  {
    key: "leads", label: "Лиды", emoji: "👥",
    description: "Все email-подписки и demo-запросы с landing-страницы. CSV-экспорт.",
    synonyms: ["lead", "лид", "подписка", "email", "demo", "newsletter", "csv", "контакты"],
  },
  {
    key: "audit", label: "Audit log", emoji: "📜",
    description: "Все правки в админке с before/after JSON и кнопкой «Восстановить».",
    synonyms: ["audit", "log", "история", "правки", "лог", "restore", "восстановить", "before", "after"],
  },
  {
    key: "failures", label: "Проблемы", emoji: "⚠️",
    description: "Реестр неудачных действий пользователей: failed auth/payment/generation/chat. Группировка по action+error_code.",
    synonyms: ["failure", "ошибка", "проблема", "fail", "issue", "user", "auth", "payment", "generation", "chat"],
  },
];

type ResultKind = "tab" | "user" | "gen";

interface SearchResult {
  kind: ResultKind;
  key: string;          // tab key или user id или gen id
  title: string;
  subtitle?: string;
  meta?: string;        // small label справа (например «вкладка» / «пользователь»)
  emoji?: string;
  // Куда переключить:
  tabKey?: string;
  scrollAnchor?: string;
}

interface Props {
  onSelect: (result: SearchResult) => void;
}

export default function AdminSearch({ onSelect }: Props) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const [users, setUsers] = useState<any[]>([]);
  const [gens, setGens] = useState<any[]>([]);
  const inputRef = useRef<HTMLInputElement>(null);

  // Cmd+K / Ctrl+K shortcut.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setOpen(o => !o);
      }
      if (e.key === "Escape") setOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  useEffect(() => {
    if (open) setTimeout(() => inputRef.current?.focus(), 50);
  }, [open]);

  // Debounced server-side search для users/gens.
  useEffect(() => {
    if (!q || q.length < 2) { setUsers([]); setGens([]); return; }
    const t = setTimeout(async () => {
      try {
        const r = await fetch(`/api/admin/v304/search?q=${encodeURIComponent(q)}`, {
          headers: { Authorization: `Bearer ${getToken()}` },
        });
        if (r.ok) {
          const j = await r.json();
          setUsers(j?.users || []);
          setGens(j?.gens || []);
        }
      } catch {}
    }, 200);
    return () => clearTimeout(t);
  }, [q]);

  const tabResults = useMemo(() => {
    const query = q.trim().toLowerCase();
    if (!query) return ADMIN_TABS.slice(0, 6).map(t => tabToResult(t));
    return ADMIN_TABS
      .map(t => ({ t, score: scoreTab(t, query) }))
      .filter(x => x.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, 8)
      .map(x => tabToResult(x.t));
  }, [q]);

  const userResults: SearchResult[] = users.slice(0, 6).map((u: any) => ({
    kind: "user", key: String(u.id),
    title: u.name || u.email || `#${u.id}`,
    subtitle: [u.email, u.phone].filter(Boolean).join(" · "),
    emoji: "👤",
    meta: "пользователь",
    tabKey: "leads",
    scrollAnchor: `user-${u.id}`,
  }));

  const genResults: SearchResult[] = gens.slice(0, 5).map((g: any) => ({
    kind: "gen", key: String(g.id),
    title: g.displayTitle || g.prompt?.slice(0, 60) || `Трек #${g.id}`,
    subtitle: `${g.type || "music"} · ${g.status || ""} · #${g.id}`,
    emoji: "🎵",
    meta: "трек",
    tabKey: "overview",
    scrollAnchor: `gen-${g.id}`,
  }));

  const allResults = [...tabResults, ...userResults, ...genResults];
  const hasAny = allResults.length > 0;

  if (!open) {
    return (
      <button
        onClick={() => setOpen(true)}
        className="inline-flex items-center gap-2 px-3 py-1.5 rounded-lg bg-white/5 border border-white/10 hover:bg-white/10 text-sm text-muted-foreground transition"
        data-testid="admin-search-trigger"
      >
        <Search className="w-3.5 h-3.5" />
        <span className="hidden sm:inline">Поиск по админке</span>
        <kbd className="hidden md:inline-block ml-2 text-[10px] px-1.5 py-0.5 rounded bg-white/10 text-white/70">⌘K</kbd>
      </button>
    );
  }

  return (
    <div className="fixed inset-0 z-[100] flex items-start justify-center pt-[15vh] px-4 bg-black/60 backdrop-blur-sm" onClick={() => setOpen(false)}>
      <div
        className="w-full max-w-xl bg-background border border-white/10 rounded-2xl shadow-2xl overflow-hidden"
        onClick={e => e.stopPropagation()}
      >
        <div className="flex items-center gap-3 px-4 py-3 border-b border-white/10">
          <Search className="w-4 h-4 text-muted-foreground" />
          <input
            ref={inputRef}
            value={q}
            onChange={e => setQ(e.target.value)}
            placeholder="Что ищем? Вкладка, юзер, трек, ключ, шаблон…"
            className="flex-1 bg-transparent outline-none text-sm text-white placeholder:text-muted-foreground"
          />
          <button
            onClick={() => setOpen(false)}
            className="p-1 rounded hover:bg-white/10 text-muted-foreground"
            aria-label="Закрыть"
          >
            <X className="w-4 h-4" />
          </button>
        </div>
        <div className="max-h-[60dvh] overflow-y-auto">
          {!hasAny && q.length >= 2 && (
            <div className="px-4 py-8 text-sm text-center text-muted-foreground">
              Ничего не нашлось по «{q}». Попробуй другое слово.
            </div>
          )}
          {!q && (
            <div className="px-4 py-2 text-[11px] uppercase tracking-wider text-muted-foreground">
              Все вкладки
            </div>
          )}
          {tabResults.length > 0 && (
            <Section title={q ? "Вкладки" : null}>
              {tabResults.map(r => (
                <ResultRow key={`tab-${r.key}`} result={r} onSelect={() => { setOpen(false); onSelect(r); }} />
              ))}
            </Section>
          )}
          {userResults.length > 0 && (
            <Section title="Пользователи">
              {userResults.map(r => (
                <ResultRow key={`user-${r.key}`} result={r} onSelect={() => { setOpen(false); onSelect(r); }} />
              ))}
            </Section>
          )}
          {genResults.length > 0 && (
            <Section title="Треки">
              {genResults.map(r => (
                <ResultRow key={`gen-${r.key}`} result={r} onSelect={() => { setOpen(false); onSelect(r); }} />
              ))}
            </Section>
          )}
        </div>
        <div className="flex items-center justify-between px-4 py-2 border-t border-white/10 text-[10px] text-muted-foreground">
          <span>↑↓ выбор · Enter открыть · Esc закрыть</span>
          <span>⌘K чтобы переоткрыть</span>
        </div>
      </div>
    </div>
  );
}

function Section({ title, children }: { title: string | null; children: React.ReactNode }) {
  return (
    <div>
      {title && (
        <div className="px-4 py-1.5 text-[11px] uppercase tracking-wider text-muted-foreground bg-white/[0.02]">
          {title}
        </div>
      )}
      <div>{children}</div>
    </div>
  );
}

function ResultRow({ result, onSelect }: { result: SearchResult; onSelect: () => void }) {
  return (
    <button
      onClick={onSelect}
      className="w-full text-left px-4 py-2.5 flex items-center gap-3 hover:bg-white/5 transition"
    >
      <span className="text-base shrink-0">{result.emoji || <Hash className="w-3.5 h-3.5" />}</span>
      <span className="flex-1 min-w-0">
        <span className="block text-sm text-white truncate">{result.title}</span>
        {result.subtitle && (
          <span className="block text-[11px] text-muted-foreground truncate">{result.subtitle}</span>
        )}
      </span>
      {result.meta && (
        <span className="text-[10px] text-muted-foreground uppercase tracking-wider shrink-0">
          {result.meta}
        </span>
      )}
    </button>
  );
}

function tabToResult(t: TabEntry): SearchResult {
  return {
    kind: "tab", key: t.key,
    title: `${t.emoji ? t.emoji + " " : ""}${t.label}`,
    subtitle: t.description,
    meta: "вкладка",
    tabKey: t.key,
  };
}

function scoreTab(t: TabEntry, query: string): number {
  const hay = `${t.key} ${t.label} ${t.description} ${t.synonyms.join(" ")}`.toLowerCase();
  if (hay.includes(query)) {
    // Bonus за совпадение в label / synonyms.
    if (t.label.toLowerCase().includes(query)) return 100;
    if (t.synonyms.some(s => s.toLowerCase().includes(query))) return 80;
    return 50;
  }
  // Fuzzy: каждое слово запроса должно найтись.
  const words = query.split(/\s+/).filter(Boolean);
  let score = 0;
  for (const w of words) {
    if (hay.includes(w)) score += 30;
  }
  return score;
}

function getToken(): string {
  // Cookie-based read — соответствует client/src/lib/auth.tsx.
  try {
    const m = document.cookie.match(/(?:^|;\s*)token=([^;]+)/);
    return m ? decodeURIComponent(m[1]) : "";
  } catch { return ""; }
}
