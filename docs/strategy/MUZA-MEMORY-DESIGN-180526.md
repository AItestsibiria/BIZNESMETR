# MUZA-MEMORY-DESIGN — 18.05.2026

**Author:** Claude · Опус 4.7 (1M ctx)
**Trigger:** Босс «у бота должен быть свой файл памяти. При смене модели задействовать память. Будем обучать».
**Status:** Design proposal — read-only research + дизайн, БЕЗ кода (код — следующим subagent'ом).

---

## 0. TL;DR

Муза получает **5-слойную persistent memory** на plain-text базе (Markdown + SQLite columns) — model-agnostic, переживает смену LLM (Anthropic → OpenAI → TimeWeb → Llama), фиксированный token budget ~6K на memory из 200K context window. Архитектура — гибрид трёх лучших мировых подходов:

- **Letta/MemGPT core memory blocks** (Identity + Knowledge живут в context всегда, character-limited)
- **LangMem 3-типа памяти** (Semantic + Episodic + Procedural namespaced per-userId)
- **Karpathy LLM Wiki** (markdown files, версионируются в git, без векторного индекса на старте)

Существующая таблица `agent_notes` (schema.ts:731) **уже создана, но не используется** — становится фундаментом User-specific слоя без новых миграций.

---

## 1. Research — что говорят docs мирового уровня

### 1.1. MemGPT / Letta (UC Berkeley paper 2310.08560)

> «MemGPT's OS-inspired multi-level memory architecture delineates between two primary memory types: **main context** (analogous to main memory/physical memory/RAM) and **external context** (analogous to disk memory/disk storage).»
> — [MemGPT paper, arxiv.org/abs/2310.08560](https://arxiv.org/abs/2310.08560)

> «Core memory blocks have a **default length limit of 2,000 characters per block**, which is customizable and prevents excessive token usage. If an agent tries to exceed the limit, the operation will throw an error.»
> — [Letta Docs · Memory Blocks](https://docs.letta.com/guides/core-concepts/memory/memory-blocks/)

> «MemGPT demonstrated the idea of self-editing memory with two in-context memory blocks: a **"Human" memory block** for storing information about the user, and a **"Persona" memory block** containing the agent's own self-concept, personality traits, and behavioral guidelines.»
> — [Letta Blog · Memory Blocks](https://www.letta.com/blog/memory-blocks)

**Вывод для Музы:** заимствуем разделение на always-loaded blocks (Identity = Persona, Knowledge = операционка) vs disk-tier (user-specific + experiences).

### 1.2. LangMem (LangChain) — 3 типа памяти

> «**Semantic memory** stores facts and data... **Episodic memory** captures past experiences/events... **Procedural memory** comprises learned behavior/instructions/policies that shape how the agent behaves.»
> — [LangMem · Long-term Memory in LLM Applications](https://langchain-ai.github.io/langmem/concepts/conceptual_guide/)

> «**Namespaces are by far the easiest/best mechanism to prevent memory leakage across users.** If you're building a system with multiple users, you could dynamically assign the namespace per user, like `namespace=(user_id, "memories")`.»
> — [LangChain Blog · LangMem SDK launch](https://www.langchain.com/blog/langmem-sdk-launch)

**Вывод для Музы:** маппим на 5 слоёв (см. §2). User-specific isolation через `agent_notes.user_id` (уже есть).

### 1.3. Mem0 — ADD-only + multi-signal retrieval

> «Single-pass ADD-only extraction... no UPDATE/DELETE... preventing destructive overwrites while memories naturally compound.»
> — [Mem0 · github.com/mem0ai/mem0](https://github.com/mem0ai/mem0)

> «**Multi-signal retrieval — semantic, BM25 keyword, and entity matching scored in parallel and fused.**»
> — [Mem0 README](https://github.com/mem0ai/mem0)

**Вывод для Музы:** старт с BM25/TF-IDF (без embeddings — экономия инфраструктуры). Embeddings — добавляем позже если scale потребует. Append-only для experiences/failures (история не теряется).

### 1.4. Karpathy LLM Wiki pattern

> «Plain Markdown (.md) is the best choice because **it's human-readable, LLMs understand its structure natively, it renders nicely in most editors, and it's trivial to version with Git.** Avoid formats that require proprietary apps to read — the whole point is portability and longevity.»
> — [MindStudio · Karpathy LLM Wiki Pattern](https://www.mindstudio.ai/blog/karpathy-llm-wiki-knowledge-base-pattern)

> «Standard Markdown format means **no vendor lock-in** — your agent's memory is not locked into OpenAI's `thread_id` or a proprietary vector store, and you can swap the underlying model (e.g., switch from Claude to GPT-4o) and simply feed it the same Markdown file.»
> — [Beyond RAG · Level Up Coding (Apr 2026)](https://levelup.gitconnected.com/beyond-rag-how-andrej-karpathys-llm-wiki-pattern-builds-knowledge-that-actually-compounds-31a08528665e)

**Вывод для Музы:** 4 layer'а (Identity, Knowledge, Experiences, Failures) — это `.md` файлы. Git-tracked. Admin UI читает/правит через FS API.

### 1.5. Anthropic Memory Tool (May 2026)

> «The Anthropic Memory Tool (`type: memory_20250818`) is an API-level feature... exposes a **filesystem-style interface where Claude can create, read, update, and delete files inside a `/memories` directory** it controls. The tool supports six operations: view, create, str_replace, insert, delete, and rename.»
> — [Claude API · Memory Tool](https://platform.claude.com/docs/en/agents-and-tools/tool-use/memory-tool)

> «**84% token reduction in extended workflows** — essentially, agents doing more with less because they're not constantly re-loading information that should already be known.»
> — [Anthropic press · Persistent memory in Managed Agents](https://www.anthropic.com/news/persistent-memory-managed-agents)

**Вывод для Музы:** Anthropic stripped-down filesystem API совпадает с нашей `/lib/musa-memory/*.md` директорией → если перейдём на Anthropic Managed Agents — миграция 1:1 (path-mapping). Также: Claude Sonnet 4.5/4.6/4.7 умеет читать markdown структуру без RAG-overhead.

### 1.6. Vector vs Markdown — token economics

> «**Expanded context windows (128K–1M tokens) make the LLM Wiki pattern more viable than ever**, allowing you to load multiple documents simultaneously... start with the simpler pattern — if your knowledge fits in a well-organized set of markdown files, the LLM Wiki will likely outperform RAG and save setup time.»
> — [Milvus Blog · Why AI Agents Burn Tokens](https://milvus.io/blog/why-ai-agents-like-openclaw-burn-through-tokens-and-how-to-cut-costs.md)

**Вывод для Музы:** на старте — БЕЗ embeddings. SQLite FTS5 (built-in BM25) + simple TF-IDF в node — достаточно для 1K-5K experiences записей. Embeddings → когда experiences.md перевалит за 50K строк.

---

## 2. Ответы на 8 ключевых вопросов

| # | Вопрос | Ответ для Музы |
|---|---|---|
| **A** | Какие классы памяти бывают? | Working (FIFO dialog history) · Semantic (facts about user/world) · Episodic (past conversations) · Procedural (how-to behaviors). Letta доп. блоки: Persona (self-concept) + Human (about-user). **Для Музы — 5 слоёв** (см. §3). |
| **B** | Selective load vs every-turn? | **Гибрид.** Identity + Knowledge — каждый turn (always-loaded, ~2K tokens). User-specific + Experiences + Failures — selective via BM25 retrieval (~1K tokens на topic). |
| **C** | Embedding vs markdown vs SQLite? | **Markdown для статики (Identity/Knowledge/Experiences/Failures) + SQLite для динамики (User-specific через `agent_notes`).** Embeddings — отложены до scale-trigger. |
| **D** | Token budget? | **~6K tokens на memory** (3% от 200K Sonnet context). Распределение: Identity 1.5K · Knowledge 2K · Recent dialog 3K · User-specific 0.5K · Experiences 0.5K · Failures 0.2K. Остальное на response. |
| **E** | Memory updating — LLM tool vs deterministic? | **Гибрид.** LLM tool `remember_about_user(key, value, importance)` для intentional саве. Deterministic background analyzer для passive (упомянуто имя/возраст ребёнка/жанр → INSERT). Mem0-style ADD-only. |
| **F** | Forgetting/compaction? | **TTL-based + importance-based pruning** (вместо delete). `agent_notes.expires_at` уже в схеме. Cron каждую ночь: `DELETE WHERE expires_at < now() OR (importance < 0.3 AND last_used_at < now-90d)`. Experiences/failures — append-only, monthly summary через LLM. |
| **G** | Multi-user разделение? | **Per-userId через `agent_notes.user_id`** (LangMem namespace pattern). Shared (Identity/Knowledge/Experiences/Failures) — единые файлы. User-specific — изолировано. Анонимы — temp-memory в `chatbot_sessions` без cross-session persist. |
| **H** | Cross-model survival? | **Plain text everywhere.** Никаких model-specific embeddings, function-schemas. Markdown + SQL columns читаются любой LLM через тот же system prompt template. Смена Anthropic → OpenAI → TimeWeb = смена API клиента, memory format не меняется. |

---

## 3. Архитектура: 5 слоёв памяти Музы

```
┌──────────────────────────────────────────────────────────────┐
│  MAIN CONTEXT (always-loaded, ~3.5K tokens)                  │
│  ┌─────────────────┐  ┌─────────────────────────────────┐   │
│  │ 1. IDENTITY     │  │ 2. KNOWLEDGE                    │   │
│  │ ~1.5K tokens    │  │ ~2K tokens                      │   │
│  │ identity.md     │  │ knowledge.md (KNOWLEDGE-BASE-BOT)│  │
│  └─────────────────┘  └─────────────────────────────────┘   │
├──────────────────────────────────────────────────────────────┤
│  RECENT DIALOG (FIFO ~10 messages, ~3K tokens)               │
│  chatbot_messages WHERE session_id=? ORDER BY ts DESC        │
├──────────────────────────────────────────────────────────────┤
│  EXTERNAL CONTEXT (retrieval, ~1.5K tokens total)            │
│  ┌─────────────────┐ ┌─────────────────┐ ┌──────────────┐  │
│  │ 3. USER-SPECIFIC│ │ 4. EXPERIENTIAL │ │ 5. FAILURES  │  │
│  │ ~500 tokens     │ │ ~500 tokens     │ │ ~200 tokens  │  │
│  │ agent_notes(uid)│ │ experiences.md  │ │ failures.md  │  │
│  └─────────────────┘ └─────────────────┘ └──────────────┘  │
└──────────────────────────────────────────────────────────────┘
```

### 3.1. Identity (Letta «Persona» block)

**Файл:** `apps/neurohub/server/lib/musa-memory/identity.md`
**Размер:** ~1500 chars (≈ 400 tokens) — следуем Letta default 2000 chars cap
**Loaded:** ВСЕГДА (каждый turn)

**Содержание (sketch):**
```markdown
# Я — Муза

## Кто я
Помощница MuzaAi. Помогаю людям создавать музыку для близких,
для бизнеса, для души. Знаю стили, голоса, шаблоны.

## Ценности (что я НЕ делаю)
- Не давлю продажей.
- Не обманываю про возможности (если Suno нестабилен — говорю).
- Не критикую вкус юзера. Любой жанр — норм.
- Не использую AI-маркеры («как языковая модель»).

## Тон
Тёплый, живой. Предложения короткие. Без markdown в чате.
Подстраиваюсь под psychotype юзера (warm/energetic/analytical/calm).

## Имя меняется по persona-rotation (Аня/Татьяна/Мария/Ольга/...)
Когда отвечаю — представляюсь именем своей persona, но идентичность Музы.
```

**Update flow:** только Босс через admin UI. LLM не редактирует Identity.

### 3.2. Knowledge (operational facts)

**Файл:** уже есть → `docs/strategy/KNOWLEDGE-BASE-BOT.md` (загружается `loadKB()` в `consultantPersona.ts:155`)
**Размер:** ~2000 tokens (текущий KB как раз ~5K chars)
**Loaded:** ВСЕГДА

**Содержание:** тарифы · шаблоны · промокоды · политика возвратов · ссылки на live endpoints.
**Update flow:** Босс правит файл → `POST /api/telegram/kb/reload?secret=` → mtime-cache инвалидируется.
Уже работает — НЕ дублируем.

### 3.3. User-specific (LangMem «semantic per-user»)

**Storage:** SQLite таблица `agent_notes` (уже создана в `schema.ts:731`, миграция в `storage.ts:806`).

**Текущая схема (без изменений!):**
```sql
agent_notes(
  id text PK,
  user_id integer,
  kind text,           -- 'preference' | 'context' | 'admin_note'
  value text,
  confidence real default 0.5,
  source text,          -- session_id || 'admin' || 'auto-analyzer'
  expires_at integer,   -- TTL unix-ms или NULL = бессрочно
  created_at integer
)
```

**Расширение (1 ALTER — additive, безопасный):**
```sql
ALTER TABLE agent_notes ADD COLUMN importance REAL DEFAULT 0.5;  -- 0..1 для prune sorting
ALTER TABLE agent_notes ADD COLUMN last_used_at INTEGER;          -- unix-ms, обновляется при retrieve
ALTER TABLE agent_notes ADD COLUMN key TEXT;                      -- 'child_name' | 'fav_genre' | ...
```

**Retrieval (на каждый turn):**
```sql
SELECT key, value, importance
FROM agent_notes
WHERE user_id = ? AND (expires_at IS NULL OR expires_at > unixepoch()*1000)
ORDER BY importance DESC, last_used_at DESC NULLS LAST
LIMIT 5;
```

**Token budget:** 5 записей × ~100 tokens = ~500 tokens.

**Examples:**
| key | value | importance |
|---|---|---|
| `child_name` | `«Дочка Маша, 7 лет»` | 0.9 |
| `fav_genre` | `«Любит рок и инди-фолк»` | 0.7 |
| `occupation` | `«Хирург в стоматологии»` | 0.6 |
| `gift_recipient` | `«Покупает для жены Лены — годовщина 12 мая»` | 0.95 |
| `previous_purchase` | `«Купил Кавер на «Хочу тебя» 2026-04-15»` | 0.5 |

### 3.4. Experiential (Mem0-style ADD-only)

**Файл:** `apps/neurohub/server/lib/musa-memory/experiences.md`
**Размер:** unbounded на диске, но retrieval ограничен ~500 tokens
**Loaded:** TF-IDF top-3 матчей к user query

**Формат (append-only blocks):**
```markdown
## 2026-05-10 · sales_conversion · warm_psychotype
**Trigger:** Юзер сомневается «не уверен что подарок понравится».
**Action:** Предложила Аудио-режим (запись голоса → песня) — «попробуйте, в случае
чего вернём деньги».
**Result:** Создал трек, поделился, оплатил. Тэги: `#refund-promise`, `#audio-mode-suggestion`.

## 2026-05-12 · template_match
**Trigger:** «Хочу песню для бабушки на 80 лет».
**Action:** Шаблон «Юбилей бабушки» + предложить Female Vocal warm.
**Result:** ✓ создал.
```

**Retrieval:** SQLite FTS5 индекс по тексту → BM25 score → top-3 блока.
Альтернатива: in-memory TF-IDF (для <500 блоков fast enough).

**Update flow:**
- Auto: background-analyzer детектит «conversion» event (юзер кликнул «Создать» после диалога) → APPEND блок с trigger/action/result.
- Manual: admin UI «Записать опыт» button.

### 3.5. Failures (PITFALLS.md style для Музы)

**Файл:** `apps/neurohub/server/lib/musa-memory/failures.md`
**Размер:** retrieval ~200 tokens
**Loaded:** топ-2 матча к user query/topic

**Формат:**
```markdown
## fail-001 · 2026-05-08 · wrong_pricing_quote
**Симптом:** Сказала юзеру «трек стоит 199₽» — реально 299₽. Юзер пришёл с
претензией, пришлось извиняться.
**Корень:** Промокод EARLYBIRD в KB не помечен как expired.
**Защита:** Перед quote цены — `check_promo(code)` tool. Если undefined → дефолт.

## fail-002 · 2026-05-14 · pushed_too_hard
**Симптом:** Юзер написал «спасибо, подумаю» → я отправила ещё 2 follow-up.
Юзер: «Отстаньте». Lost.
**Корень:** Sales playbook 5-step без exit-stop.
**Защита:** При «подумаю»/«позже»/«сам решу» — один follow-up через 24ч max.
```

**Update flow:**
- Auto: background-analyzer ловит negative feedback (`agent_feedback.label='wrong_info'|'rude'`) → APPEND.
- Manual: Босс правит руками.

---

## 4. Context Assembly алгоритм

**Точка вызова:** перед каждым `/api/chat/*` запросом (web + telegram + max + future).

**Pseudocode:**
```ts
async function assembleMuzaContext(userId, sessionId, userMessage): SystemPrompt {
  // 1. Always-loaded (parallel reads)
  const [identity, knowledge] = await Promise.all([
    loadIdentity(),           // ~1500 chars from identity.md
    loadKB(),                 // existing loadKB() in consultantPersona.ts
  ]);

  // 2. User-specific (per-userId, only if logged-in)
  const userNotes = userId
    ? await db.select().from(agentNotes)
        .where(eq(agentNotes.userId, userId))
        .orderBy(desc(agentNotes.importance), desc(agentNotes.lastUsedAt))
        .limit(5)
    : [];

  // 3. Recent dialog (FIFO last 10 messages)
  const recentDialog = await loadHistoryForLLM(sessionId, 10);  // existing chatHistory.ts

  // 4. Experiences relevant to query (TF-IDF top-3)
  const experiences = await retrieveExperiences(userMessage, { topK: 3 });

  // 5. Failures relevant to topic (top-2)
  const failures = await retrieveFailures(userMessage, { topK: 2 });

  // Mark notes as "recently used" (async fire-and-forget)
  void markUsed(userNotes.map(n => n.id));

  return buildPersonaSystem({
    persona: pickPersona(userId),  // existing PERSONAS rotation
    identity,
    knowledge,
    userNotes,
    experiences,
    failures,
    dialogTail: recentDialog,
  });
}
```

**Token budget enforcement:**
```ts
const BUDGETS = { identity: 1500, knowledge: 2000, userNotes: 500, experiences: 500, failures: 200 };
// Trim each section to its budget before assembly. Hard cap, no overflow.
```

---

## 5. Memory Update Flow

### 5.1. LLM tool-call path (intentional)

Расширяем `muzaTools.ts` (уже 1642 строки) двумя tools:

```ts
{
  name: "remember_about_user",
  description: "Сохрани важный факт о юзере для будущих диалогов. " +
               "Используй когда юзер упомянул что-то значимое: имя ребёнка, " +
               "повод, профессию, предпочтения. НЕ для temp-данных.",
  input_schema: {
    key: "string (snake_case, e.g. 'child_name')",
    value: "string (≤200 chars)",
    importance: "number 0..1 (1=critical, 0.5=normal, 0.2=trivial)",
    expires_in_days: "number? optional, default null=forever",
  }
}
{
  name: "log_experience",
  description: "Когда диалог привёл к конверсии или важному инсайту — " +
               "запиши опыт чтобы повторить в будущем.",
  input_schema: {
    category: "'sales_conversion' | 'template_match' | 'objection_handled' | 'rapport_built'",
    trigger: "string (что сказал юзер)",
    action: "string (что я сделала)",
    result: "string (что получилось)",
    tags: "string[] (для retrieval)",
  }
}
```

### 5.2. Deterministic background analyzer (passive)

**Файл:** `apps/neurohub/server/lib/musa-memory/analyzer.ts` (новый)
**Trigger:** после каждого `chatbot_messages` INSERT (event-bus subscribe или setImmediate).
**Fire-and-forget** — не блокирует response.

**Извлекает (regex + LLM-light):**
- Имена близких: `/(?:дочк|сын|мам|пап|жен|муж|бабушк|дедушк)[аеуи]\s+([А-ЯЁ][а-яё]+)/g` → `child_name=Маша`
- Возраст: `/(\d+)\s+(?:лет|год|года)/g` → `age=7`
- Жанры: match против списка `["рок", "поп", "инди", "фолк", "рэп", "классика", ...]`
- Поводы: `/(?:юбилей|свадьб|годовщин|день рождени|выпускн)/i` → `event_type=anniversary`

**Conversion detection:**
- Event `generation.started` после диалога → `log_experience({ category: 'sales_conversion', ... })`.
- Event `agent_feedback.label='wrong_info'|'rude'` → APPEND to `failures.md` (с redacted user message).

### 5.3. Pruning / Forgetting (nightly cron)

**Cron:** `0 3 * * *` (03:00 MSK — quiet hours, см. Hourly-digest rule)
```sql
-- 1. Expired notes
DELETE FROM agent_notes WHERE expires_at < unixepoch()*1000;

-- 2. Low-importance + stale
DELETE FROM agent_notes
WHERE importance < 0.3
  AND last_used_at IS NOT NULL
  AND last_used_at < unixepoch()*1000 - 90*86400*1000;

-- 3. Per-user cap (защита от spam)
-- Если у юзера >100 notes — оставить top-100 by importance.
```

**Experiences/Failures compaction (monthly):**
- Cron первого числа месяца в 04:00.
- LLM (Sonnet) читает `experiences.md` → group similar entries → produce condensed summary.
- Original archived в `experiences-archive-2026-05.md`, live file rewritten.

---

## 6. Model Swap Survival

**Сценарий:** Anthropic заблокировал РФ → переключаем на TimeWeb AI Gateway (Mistral Large) → потом на Llama-3.3 self-hosted.

**Что меняется в коде:** только `llmCore.ts` (API клиент).

**Что НЕ меняется (memory):**
1. `identity.md` — plain markdown, любая LLM прочтёт.
2. `knowledge.md` (KB) — то же.
3. `experiences.md` / `failures.md` — markdown.
4. `agent_notes` SQLite таблица — text columns.
5. Context assembly алгоритм (§4) — model-agnostic.

**Что МОЖЕТ потребовать tuning:**
- Tool-calling schema (function_calls vs tool_use). У нас тонкий wrapper в `muzaTools.ts` — переключение через flag.
- Context window: если модель <32K — урезаем budget (Identity 1K · Knowledge 1.5K · etc).

**Проверка cross-model:**
```bash
# Команда для smoke-test после смены провайдера
curl -X POST https://muzaai.ru/api/chat/test \
  -H 'Content-Type: application/json' \
  -d '{"userId": 1, "message": "Привет, ты помнишь как зовут мою дочку?"}'
# Ожидаемый ответ упоминает «Маша» если в agent_notes есть запись.
```

---

## 7. Что уже есть в проекте (не дублировать)

| Артефакт | Файл / таблица | Состояние | Используется в дизайне |
|---|---|---|---|
| KB markdown | `docs/strategy/KNOWLEDGE-BASE-BOT.md` | ✅ live, mtime-cache | Layer 2 Knowledge — **переиспользуем 1:1** |
| `loadKB()` | `consultantPersona.ts:155` | ✅ live | Тот же loader |
| `buildPersonaSystem()` | `consultantPersona.ts:223` | ✅ live | Extending с memory inject |
| `PERSONAS` rotation | `consultantPersona.ts:37-100` | ✅ live | Identity inherits persona name/tone |
| `agent_notes` table | `schema.ts:731` + `storage.ts:806` | 🟡 schema есть, **0 read/write кода** | Layer 3 User-specific — **wire up** |
| `agent_feedback` table | `schema.ts:743` | 🟡 schema есть | Sourcing для failures.md analyzer |
| `loadHistoryForLLM()` | `chatHistory.ts` | ✅ live, cross-channel merge | Recent dialog tail |
| `muzaTools.ts` | `lib/muzaTools.ts` (1642 строки) | ✅ live, 40+ tools | Расширяем 2-мя memory tools |
| `musaBriefing.ts` | `lib/musaBriefing.ts` (138 строк) | ✅ live | Не пересекается (это admin briefing, не memory) |

**Вывод:** дизайн встраивается в existing — НЕ создаёт параллельную систему. Соответствует `No-duplicates rule` и `Reuse-working-solutions rule`.

---

## 8. Implementation steps (для follow-up subagent)

### 8.1. Phase 1 — Foundation (1 commit, безопасный)
1. Создать директорию `apps/neurohub/server/lib/musa-memory/`
2. Создать 3 файла:
   - `identity.md` (sketch из §3.1, ~1500 chars)
   - `experiences.md` (header + 2-3 seed примера из реальных past conversions)
   - `failures.md` (header + 2-3 seed примера из incidents)
3. ALTER `agent_notes`: добавить `importance`, `last_used_at`, `key` (idempotent через `ALTER TABLE ... ADD COLUMN`).
4. Создать helper `apps/neurohub/server/lib/musa-memory/io.ts` (load/save markdown files с mtime-cache).
5. Smoke-test: чтение всех 4 файлов через unit test.

### 8.2. Phase 2 — Storage layer (1 commit)
1. `storage.ts`: добавить методы `upsertAgentNote()`, `getTopAgentNotes(userId, limit)`, `markAgentNoteUsed(ids)`.
2. Создать SQLite FTS5 виртуальную таблицу `experiences_fts(content, tags)` для BM25 retrieval.
3. Cron job в `admin-overview` plugin: nightly prune (03:00 MSK).

### 8.3. Phase 3 — Assembler (1 commit)
1. `apps/neurohub/server/lib/musa-memory/assembler.ts` — функция `assembleMuzaContext(userId, sessionId, message)` из §4.
2. Token budget enforcer (`trimToBudget(text, tokens)`).
3. Integration в `consultantPersona.buildPersonaSystem()` — extending существующий код, не replace.

### 8.4. Phase 4 — Update flow (1 commit)
1. `analyzer.ts` — passive extraction (regex для имён/возраста/жанра/поводов).
2. Расширить `muzaTools.ts` двумя tools (`remember_about_user`, `log_experience`).
3. Event subscribe на `chatbot.message.user` → fire-and-forget analyzer.

### 8.5. Phase 5 — Admin UI tab (1 commit, согласовать с Боссом)
1. Новая вкладка `🧠 Память Музы` в `admin-v304.tsx`.
2. Sub-tabs:
   - Identity — textarea редактор `identity.md`
   - Knowledge — link на existing KB editor
   - User-specific — таблица `agent_notes` с фильтрами по userId, kind, importance
   - Experiences — markdown editor + «Добавить опыт» button
   - Failures — markdown editor
3. Endpoints `GET/PUT /api/admin/v304/musa-memory/:layer`.
4. «Тренировать на этой записи» button — promote `importance += 0.1`, `last_used_at = now`.

### 8.6. Phase 6 — Cross-model verify (smoke test)
1. Tests в `__tests__/muza-memory-assembly.test.ts`:
   - User-specific retrieval возвращает top-5 by importance.
   - Token budget enforcer не превышает cap.
   - Markdown loader handles missing files (graceful fallback).
   - TF-IDF retrieval возвращает relevant блоки.

---

## 9. Risks & Mitigations

| Риск | Mitigation |
|---|---|
| LLM hallucinates fake user facts → `remember_about_user` сохранит мусор | Validation: `value.length ≤ 200`, `key` whitelist (`child_name`, `fav_genre`, ...). Confidence-threshold для auto-extract: 0.7+. |
| `agent_notes` table grow unbounded | Nightly prune cron (§5.3). Per-user cap 100 entries. |
| `experiences.md` deteriorates через accumulation | Monthly LLM-compaction (§5.3 last paragraph). |
| Privacy: PII (имя ребёнка) в файлах admin может прочитать | Audit-log на каждый admin read. `agent_notes` уже изолированы per-userId. GDPR delete-request flow существует (см. Admin-everything-except-delete rule). |
| Cross-model: tool-schema format отличается | `muzaTools.ts` wrapper нормализует (уже есть). Identity/Knowledge — pure text, не affected. |
| TF-IDF плохой match для русского (стемминг) | Использовать sqlite-fts5 + porter stemmer rusm. Fallback на substring match для коротких блоков. |
| LLM «забывает» использовать tool `remember_about_user` | Periodic reminder в system prompt: «Если юзер упомянул важный факт — используй tool remember_about_user». Background analyzer работает как safety net. |

---

## 10. Метрики успеха

После rollout — admin UI «🧠 Память Музы» показывает:

1. **Recall rate:** на тестовом наборе 50 диалогов с 2-х turn'овой памятью → % правильных ответов «помнишь X?».
2. **Storage health:** `count(agent_notes)`, growth rate, top-10 keys by frequency.
3. **Token usage:** среднее tokens per turn (до и после memory). Цель: −20% vs baseline (per Anthropic 84%-reduction claim, у нас более скромный, но measurable).
4. **Conversion lift:** sales conversion rate у юзеров с >5 agent_notes vs cold users. Цель: +10%.
5. **Cross-model resilience:** при failover на TimeWeb — recall rate не падает >5%.

---

## 11. Источники (Sources)

- [MemGPT paper · arxiv.org/abs/2310.08560](https://arxiv.org/abs/2310.08560)
- [Letta Docs · Memory Blocks](https://docs.letta.com/guides/core-concepts/memory/memory-blocks/)
- [Letta Blog · The Key to Agentic Context Management](https://www.letta.com/blog/memory-blocks)
- [LangMem · Long-term Memory Conceptual Guide](https://langchain-ai.github.io/langmem/concepts/conceptual_guide/)
- [LangChain Blog · LangMem SDK Launch](https://www.langchain.com/blog/langmem-sdk-launch)
- [Mem0 · github.com/mem0ai/mem0](https://github.com/mem0ai/mem0)
- [Karpathy LLM Wiki pattern · MindStudio](https://www.mindstudio.ai/blog/karpathy-llm-wiki-knowledge-base-pattern)
- [Beyond RAG · LLM Wiki Pattern · Level Up Coding (Apr 2026)](https://levelup.gitconnected.com/beyond-rag-how-andrej-karpathys-llm-wiki-pattern-builds-knowledge-that-actually-compounds-31a08528665e)
- [Claude API · Memory Tool docs](https://platform.claude.com/docs/en/agents-and-tools/tool-use/memory-tool)
- [Anthropic · Persistent Memory in Managed Agents (May 2026)](https://www.anthropic.com/news/persistent-memory-managed-agents)
- [Milvus Blog · Why Agents Burn Tokens (LLM Wiki vs RAG)](https://milvus.io/blog/why-ai-agents-like-openclaw-burn-through-tokens-and-how-to-cut-costs.md)
- [Atlan · Types of AI Agent Memory 2026](https://atlan.com/know/types-of-ai-agent-memory/)
- [MarkTechPost · Comparing Memory Systems for LLM Agents](https://www.marktechpost.com/2025/11/10/comparing-memory-systems-for-llm-agents-vector-graph-and-event-logs/)
- [LangMem · How to Extract Semantic Memories](https://langchain-ai.github.io/langmem/guides/extract_semantic_memories/)

---

🕐 2026-05-18 (timestamp footer per CLAUDE.md timestamp rule)
