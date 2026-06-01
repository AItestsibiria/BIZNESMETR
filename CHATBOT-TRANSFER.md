# Chatbot Architecture — Transfer Package

Standalone chatbot framework для переноса в другой проект. Исключён MuzaAi-specific функционал (Suno генерация, музыкальные tools, оплата треков). Сохранены архитектурные паттерны.

---

## 🏗 Архитектура (высокий уровень)

```
┌──────────────────────────────────────────────────────────────┐
│ Каналы (web / telegram / max / future)                       │
└────────────┬─────────────────────────────────────────────────┘
             │ единый формат сообщений
             ▼
┌──────────────────────────────────────────────────────────────┐
│ Cross-channel linker (один thread по userId)                 │
│   loadHistoryForLLM(sessionId) — merged across каналов       │
└────────────┬─────────────────────────────────────────────────┘
             │ history + new message
             ▼
┌──────────────────────────────────────────────────────────────┐
│ Persona builder (system prompt)                              │
│   buildPersonaSystem({role, mode, channel, userContext, KB}) │
└────────────┬─────────────────────────────────────────────────┘
             ▼
┌──────────────────────────────────────────────────────────────┐
│ LLM Core (multi-provider fallback chain)                     │
│   DeepSeek → TimeWeb → Anthropic → GPTunnel                  │
│   tools работают ТОЛЬКО на Anthropic-шаге                    │
└────────────┬─────────────────────────────────────────────────┘
             ▼
┌──────────────────────────────────────────────────────────────┐
│ Tool framework (function-calling)                            │
│   approval flow: confirm_spend / confirm_publish             │
│   audit-log каждого успешного call                           │
│   refund при ошибке                                          │
└────────────┬─────────────────────────────────────────────────┘
             ▼
┌──────────────────────────────────────────────────────────────┐
│ Memory / context (per-user)                                  │
│   summary + facts + preferences (compression каждые N msg)   │
└──────────────────────────────────────────────────────────────┘
```

---

## 🔄 1. LLM Core — multi-provider fallback chain

### Порядок попыток (cheapest first)

| # | Provider | ENV | Default model | Tools? |
|---|---|---|---|---|
| 1 | DeepSeek (primary, cheap) | `DEEPSEEK_API_KEY` | `deepseek-chat` | ❌ |
| 2 | TimeWeb Gateway (proxy Anthropic) | `TIMEWEB_GATEWAY_KEY` | `anthropic/claude-haiku-4-5` | ❌ |
| 3 | Anthropic direct | `ANTHROPIC_API_KEY` | `claude-haiku-4-5-20251001` | ✅ |
| 4 | Anthropic backup | `ANTHROPIC_API_KEY_BACKUP` | то же | ✅ |
| 5 | Anthropic bot | `ANTHROPIC_API_KEY_BOT` | то же | ✅ |
| 6 | GPTunnel (last resort) | `GPTUNNEL_API_KEY` | `gpt-4o-mini` | ❌ |

### Pricing (для оценки)

- **DeepSeek**: $0.27/M input + $1.10/M output — самый дешёвый для базовых диалогов
- **Anthropic Haiku 4.5**: $0.80/M input + $4.00/M output
- **Anthropic Sonnet 4.6**: $3/M input + $15/M output
- **Claude Opus 4.7**: $15/M input + $75/M output

### Файл-эталон: `server/lib/llmCore.ts`

```ts
export async function callUnifiedLLM(opts: {
  systemPrompt: string;
  messages: ChatMessage[];
  tools?: AnthropicTool[];
  preferTools?: boolean; // если true — пропустить DeepSeek/TimeWeb
}): Promise<{text: string; provider: string; toolCalls?: ToolCall[]}> {
  const chain = opts.preferTools
    ? ['anthropic', 'anthropic_backup', 'anthropic_bot', 'gptunnel']
    : ['deepseek', 'timeweb', 'anthropic', 'anthropic_backup', 'anthropic_bot', 'gptunnel'];

  for (const provider of chain) {
    try {
      const result = await callProvider(provider, opts);
      if (result.text || result.toolCalls?.length) return result;
    } catch (err) {
      console.warn(`[llm] ${provider} failed:`, err.message);
      continue;
    }
  }
  throw new Error('Все LLM-провайдеры недоступны');
}
```

### Functional check для health-status

Не просто HTTP 200 — каждый ключ проверяется как «бот отвечает на русском в нужной роли»:

```ts
function isFunctionalReply(text: string, expectCyrillic = true): boolean {
  if (!text || text.length < 5 || text.length > 500) return false;
  if (expectCyrillic && !/[А-Яа-яЁё]/.test(text)) return false;
  const deny = /as an ai|i cannot|i'm sorry, but i|я не могу|не имею возможности/i;
  if (deny.test(text)) return false;
  return true;
}
```

---

## 🎭 2. Persona system

### Принцип

Один **builder** генерирует system prompt по контексту:
- `role` (admin / user / anonymous) — определяет уровень доступа
- `mode` (consultant / dialog / support) — стиль общения
- `channel` (web / telegram / max) — формат вывода
- `userContext` — facts о юзере (из memory + cabinet)
- `KB` — relevant chunks из knowledge base

### Файл-эталон: `server/lib/persona.ts`

```ts
export function buildPersonaSystem(opts: PersonaOptions): string {
  const sections: string[] = [];

  // 1. Базовая идентичность
  sections.push(`Ты — <Имя>, ассистент проекта <Проект>.`);

  // 2. Опционально — gender/age constraints (например женский род)
  if (opts.persona?.gender === 'female') {
    sections.push(`ОБЯЗАТЕЛЬНО — ты говоришь от лица девушки.
Все глаголы прошедшего времени — женский род (сделала, увидела, поняла).
Все причастия — женский род (готова, рада, уверена).`);
  }

  // 3. Governance — что можно рассказывать
  if (opts.role === 'admin') {
    sections.push(`ROLE=admin → full access. Можешь обсуждать любые детали проекта.`);
  } else if (opts.role === 'user') {
    sections.push(`ROLE=user → только о СВОИХ данных юзера (по userId). 
НЕ раскрывай: архитектуру, секреты, других юзеров, админ-инсайды.`);
  } else {
    sections.push(`ROLE=anonymous → только публичная информация.`);
  }

  // 4. User context (если auth)
  if (opts.userContext) {
    sections.push(`[USER CONTEXT]
Это ${opts.userContext.name} (${opts.userContext.country}).
Помнишь о нём: ${opts.userContext.summary}
Активность: ${opts.userContext.activitySummary}
Открой разговор как менеджер — не с нуля.`);
  }

  // 5. KB relevant chunks (опционально, по retrieval)
  if (opts.kbChunks?.length) {
    sections.push(`[KNOWLEDGE BASE]\n${opts.kbChunks.join('\n---\n')}`);
  }

  // 6. Channel-specific formatting
  if (opts.channel === 'telegram') {
    sections.push(`Формат Telegram: коротко, без markdown-таблиц. Эмодзи умеренно.`);
  }

  return sections.join('\n\n');
}
```

---

## 🛠 3. Tool framework (function-calling)

### Approval flow для платных/важных действий

Любой tool который может списать деньги / опубликовать контент / удалить данные — **обязательно** проверяет confirm-флаг:

```ts
// 1. Юзер: «Сделай X»
// 2. LLM вызывает tool БЕЗ confirm_spend:
{
  ok: false,
  approval_required: true,
  tool: 'do_paid_action',
  estimated_cost_kopecks: 39900,
  estimated_cost_label: '399 ₽',
  user_balance_label: '1200 ₽',
  params_preview: {...},
  message: 'Подтвердить действие X — 399 ₽?'
}
// 3. Frontend рендерит approval card с кнопками [Подтвердить] / [Отмена]
// 4. При [Подтвердить] → отправляется текст «Да, подтверждаю. confirm_spend=true»
// 5. LLM повторяет вызов с confirm_spend: true → backend списывает + выполняет
```

### Жёсткие правила (must-have для любого tool)

1. **confirm_spend === true** перед списанием. Без — `approval_required: true`
2. **confirm_publish === true** для visibility/publish actions
3. **Audit-log обязателен** — `recordAuditEntry({entity, entityKey, after: {...params}})`
4. **Ownership check** — `if (resource.userId !== ctx.userId) return {ok:false, error:'Не найдено'}`
5. **Refund при ошибке** — если списали деньги но действие упало → откатить + `{ok:false, refunded:true}`
6. **Reuse existing logic** — tools = wrappers над существующими storage methods, НЕ параллельные pipelines
7. **Timeout 30+ сек** для tools которые дёргают external APIs

### Файл-эталон: `server/lib/toolFramework.ts`

```ts
export interface ToolHandler {
  name: string;
  description: string;
  inputSchema: JSONSchema;
  requiresAuth: boolean;
  requiresAdmin?: boolean;
  estimatedCost?: (params: any) => Promise<{kopecks: number; label: string}>;
  handler: (params: any, ctx: ToolContext) => Promise<ToolResult>;
}

export interface ToolContext {
  userId: number | null;
  role: 'admin' | 'super_admin' | 'user' | 'anonymous';
  channel: 'web' | 'telegram' | 'max';
  sessionId: string;
}

export interface ToolResult {
  ok: boolean;
  error?: string;
  approval_required?: boolean;
  refunded?: boolean;
  data?: any;
  hint?: string; // e.g. 'attachedJob:<id>' для frontend rendering
}

export async function executeTool(
  toolName: string,
  params: any,
  ctx: ToolContext
): Promise<ToolResult> {
  const tool = TOOL_REGISTRY[toolName];
  if (!tool) return {ok: false, error: 'Tool not found'};
  if (tool.requiresAuth && !ctx.userId) return {ok: false, error: 'Не залогинен'};
  if (tool.requiresAdmin && !['admin','super_admin'].includes(ctx.role)) {
    return {ok: false, error: 'Только для админа'};
  }

  try {
    const validated = validateSchema(params, tool.inputSchema);
    const result = await tool.handler(validated, ctx);
    if (result.ok) {
      await recordAuditEntry({
        entity: `chat_tool:${toolName}`,
        entityKey: result.data?.id || ctx.sessionId,
        after: validated,
        userId: ctx.userId,
      });
    }
    return result;
  } catch (err) {
    console.error(`[tool:${toolName}]`, err);
    return {ok: false, error: 'Ошибка выполнения. Попробуйте позже.'};
  }
}
```

### Anti-pattern (что нельзя)

- ❌ Tool который списывает деньги без confirm_spend
- ❌ Tool без ownership check → юзер X через LLM меняет данные юзера Y
- ❌ Tool без refund при error → деньги списаны, действие не выполнено
- ❌ Tool который дублирует REST endpoint логику вместо переиспользования

---

## 📚 4. Knowledge Base loader

### Принцип: file-based KB с mtime invalidation

KB живёт в `docs/KB.md` (или нескольких файлах). Загружается при первом chat-call, кэшируется 60 мин или до изменения файла.

```ts
let kbCache: {content: string; mtime: number; loadedAt: number} | null = null;

export function loadKB(filePath = 'docs/KB.md'): string {
  const stat = fs.statSync(filePath);
  const now = Date.now();
  const TTL_MS = 60 * 60 * 1000;

  if (kbCache && 
      kbCache.mtime === stat.mtimeMs && 
      now - kbCache.loadedAt < TTL_MS) {
    return kbCache.content;
  }

  const content = fs.readFileSync(filePath, 'utf8');
  kbCache = {content, mtime: stat.mtimeMs, loadedAt: now};
  return content;
}

// Опциональный admin endpoint для принудительного reload
// GET /api/admin/kb/reload?secret=...
```

### Retrieval (если KB большая)

Для KB > 5K токенов — chunking + retrieval:

```ts
export function selectKBChunks(query: string, kb: string, maxChunks = 3): string[] {
  const chunks = kb.split(/\n## /).map((c, i) => i === 0 ? c : `## ${c}`);
  // Simple keyword match (для production — embeddings)
  const scored = chunks.map(c => ({
    chunk: c,
    score: countKeywordMatches(query.toLowerCase(), c.toLowerCase())
  }));
  return scored.sort((a, b) => b.score - a.score)
    .slice(0, maxChunks)
    .map(s => s.chunk);
}
```

---

## 🔗 5. Cross-channel conversation linking

### Принцип: один thread по userId, независимо от канала

Юзер пишет в Telegram → потом в Web → видит continuation. Bot тоже видит всю историю.

### Таблица `chatbot_messages`

```sql
CREATE TABLE chatbot_messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL,
  user_id INTEGER, -- nullable для anonymous
  channel TEXT NOT NULL CHECK(channel IN ('web', 'telegram', 'max')),
  role TEXT NOT NULL CHECK(role IN ('user', 'assistant', 'system')),
  text TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  -- метаданные
  audio_url TEXT,
  attached_data TEXT -- JSON
);
CREATE INDEX idx_msg_user ON chatbot_messages(user_id, created_at);
CREATE INDEX idx_msg_session ON chatbot_messages(session_id, created_at);
```

### Загрузка истории для LLM

```ts
export async function loadHistoryForLLM(
  sessionId: string, 
  limit = 40
): Promise<ChatMessage[]> {
  const session = await db.select().from(chatbotSessions)
    .where(eq(chatbotSessions.id, sessionId)).limit(1);
  
  if (session[0]?.userId) {
    // Linked user — merge ВСЕ его сессии по timestamp
    const all = await db.select().from(chatbotMessages)
      .where(eq(chatbotMessages.userId, session[0].userId))
      .orderBy(desc(chatbotMessages.createdAt))
      .limit(limit);
    
    return all.reverse().map(m => ({
      role: m.role,
      content: m.channel === session[0].channel 
        ? m.text 
        : `[${m.channel.toUpperCase()}] ${m.text}`
    }));
  } else {
    // Anonymous — только текущая сессия
    return loadSessionMessages(sessionId, limit);
  }
}
```

### Pair-link для перехода между каналами

После 2+ exchange в боте — Музa предлагает кликабельную ссылку на web:
- `https://example.com/?pair=<CODE>` (6-сим случайный код)
- Frontend detects `?pair=` → POST `/api/chat/init {pairCode}` → server линкует web-session с bot-session
- Greeting на web: «Я узнала тебя — мы только что общались в Telegram. Продолжим?»

---

## 🧠 6. User memory / context

### Принцип

После каждых N exchange (default N=10) — background LLM call сжимает историю в `user_memory`:

```sql
CREATE TABLE user_memory (
  user_id INTEGER PRIMARY KEY,
  summary TEXT, -- narrative, 1-3 параграфа
  facts_json TEXT, -- {name, occupation, hobbies, preferences, ...}
  preferences_json TEXT,
  last_updated_at INTEGER,
  message_count_summarized INTEGER,
  version INTEGER DEFAULT 1
);
```

### Compression prompt

```ts
const COMPRESS_PROMPT = `Сожми разговор в narrative-форму.
Сохраняй: имя, занятия, ключевые события (дни рождения, юбилеи), 
темы которые юзер обсуждал, упоминания близких, эмоциональный контекст.
Удаляй: разовый smalltalk, общие фразы.

Предыдущая память:
{previous_summary}

Новые сообщения:
{recent_messages}

Output JSON:
{
  "summary": "...",
  "facts": {...},
  "preferences": {...}
}`;
```

### Inject в system prompt

При каждом chat-call:
1. Загрузить `user_memory.summary + facts`
2. Загрузить live cabinet snapshot (профиль, активность, баланс)
3. Inject в system prompt как `[USER CONTEXT — MANAGER VIEW]` блок

### Privacy

- Юзер видит свою память через `/api/account/memory`
- Кнопка «Забыть меня» → `DELETE user_memory` + audit-log
- GDPR — при удалении аккаунта `user_memory` тоже удаляется

---

## 🔐 7. Audit-log pattern

### Каждый успешный tool call → запись

```ts
export async function recordAuditEntry(entry: {
  entity: string; // 'chat_tool:rename_my_track'
  entityKey: string; // resource ID
  before?: any;
  after?: any;
  userId: number | null;
  adminEmail?: string; // 'bot-self-service' для bot actions
}) {
  await db.insert(adminAuditLog).values({
    entity: entry.entity,
    entityKey: String(entry.entityKey),
    beforeJson: entry.before ? JSON.stringify(entry.before) : null,
    afterJson: entry.after ? JSON.stringify(entry.after) : null,
    userId: entry.userId,
    adminEmail: entry.adminEmail,
    createdAt: Date.now()
  });
}
```

### Restore endpoint (откат)

```
POST /api/admin/audit/:id/restore
```

Берёт `beforeJson` → применяет обратно. Полезно для случайных edits.

---

## 🚨 8. User-action-failure registry

### Принцип

Любое неудачное действие пользователя пишется в БД для админ-аналитики:

```sql
CREATE TABLE user_action_failures (
  id INTEGER PRIMARY KEY,
  user_id INTEGER,
  channel TEXT, -- web/telegram/max
  action TEXT, -- 'login', 'send_message', 'tool:X'
  error_code TEXT, -- normalized
  error_message TEXT,
  endpoint TEXT,
  status_code INTEGER,
  context_json TEXT,
  group_key TEXT, -- action::error_code для GROUP BY
  created_at INTEGER
);
```

### Helper

```ts
export function logUserActionFailure(params: {
  userId?: number;
  channel: string;
  action: string;
  errorCode: string;
  errorMessage: string;
  endpoint?: string;
  statusCode?: number;
  context?: any;
}) {
  try {
    db.insert(userActionFailures).values({
      ...params,
      group_key: `${params.action}::${params.errorCode}`,
      created_at: Date.now()
    });
  } catch {} // never throw — не блокирует основной flow
}
```

### Admin endpoint

`GET /api/admin/user-failures?since=ISO&channel=X` — группировка по group_key, count, uniq users.

---

## 📡 9. Channels — webhook patterns

### Telegram (long-polling или webhook)

```ts
// dedup по update_id (TTL 10 мин, max 200)
const processed = new Map<number, number>();
function isDup(updateId: number): boolean {
  const now = Date.now();
  // cleanup old
  for (const [id, ts] of processed) {
    if (now - ts > 10 * 60 * 1000) processed.delete(id);
  }
  if (processed.has(updateId)) return true;
  processed.set(updateId, now);
  if (processed.size > 200) {
    const oldest = [...processed.entries()].sort((a,b) => a[1]-b[1])[0];
    processed.delete(oldest[0]);
  }
  return false;
}

// webhook handler
app.post('/api/telegram/webhook', async (req, res) => {
  const update = req.body;
  if (isDup(update.update_id)) return res.json({ok: true});
  
  await processTelegramUpdate(update);
  res.json({ok: true});
});
```

### Authorization headers (provider-specific)

- **Telegram**: token в URL `https://api.telegram.org/bot<TOKEN>/...`
- **Max**: `Authorization: <TOKEN>` (БЕЗ `Bearer` префикса)
- **VK**: `access_token=<TOKEN>` в query

### Webhook secret verification (timing-safe)

```ts
import { timingSafeEqual } from 'crypto';

function verifyWebhookSecret(received: string, expected: string): boolean {
  if (received.length !== expected.length) return false;
  return timingSafeEqual(Buffer.from(received), Buffer.from(expected));
}
```

---

## 🛡 10. Security must-haves

| Concern | Solution |
|---|---|
| **DoS body size** | `express.json({limit: '1mb'})` |
| **OTP brute-force** | rate-limit + attempts counter в БД |
| **Tool brute-force** | rate-limit 5/min per user на платные tools |
| **XSS reflected** | escapeHtml на ВСЕ `:param` echo в response |
| **HTML injection (CMS)** | DOMPurify wrapper |
| **Token storage** | HttpOnly + Secure + SameSite=Strict cookies |
| **Webhook HMAC** | timingSafeEqual для подписей |
| **Auth verify** | timingSafeEqual для Telegram auth hash |
| **Helmet** | helmet({contentSecurityPolicy: ...}) |
| **HSTS** | max-age=31536000 includeSubDomains preload |
| **Trust proxy** | `app.set('trust proxy', 1)` для real IP |
| **X-Powered-By** | `app.disable('x-powered-by')` |

---

## 📂 11. Файлы для переноса

Минимальный набор (без MuzaAi бизнес-логики):

```
server/
  lib/
    llmCore.ts           — multi-provider chain
    persona.ts           — system prompt builder
    toolFramework.ts     — tool execution + audit
    kbLoader.ts          — file-based KB cache
    chatHistory.ts       — cross-channel merge
    userMemory.ts        — compression pipeline
    auditLog.ts          — recordAuditEntry helper
    userActionFailures.ts — failure registry
    rateLimiter.ts       — per-user/IP buckets
    sanitizeSecrets.ts   — redact в error responses
    timingSafe.ts        — HMAC compare wrappers

  plugins/
    chatbot/
      module.ts          — main /api/chat endpoint
      tools.ts           — registered tools (customize per project)
    telegram-bot/
      module.ts          — webhook handler
    max-bot/
      module.ts          — webhook handler

  middleware/
    requireAuth.ts
    requireAdmin.ts
    rateLimitMiddleware.ts

client/
  components/
    floating-consultant.tsx  — chat FAB (UI patterns)
    chat-approval-card.tsx   — approval flow UI
    chat-job-card.tsx        — attached data rendering

shared/
  schema.ts (или drizzle/schema/) — DB tables: 
    chatbot_messages, chatbot_sessions, user_memory,
    user_action_failures, admin_audit_log
```

---

## 🔧 12. ENV requirements

```bash
# LLM keys (опционально — chain работает с любым подмножеством)
DEEPSEEK_API_KEY=
TIMEWEB_GATEWAY_KEY=
ANTHROPIC_API_KEY=
ANTHROPIC_API_KEY_BACKUP=
ANTHROPIC_API_KEY_BOT=
GPTUNNEL_API_KEY=

# Channels
TELEGRAM_BOT_TOKEN=
MAX_BOT_TOKEN=
MAX_WEBHOOK_SECRET=

# Auth
SESSION_SECRET=        # openssl rand -base64 32
SIGNED_URL_SECRET=     # openssl rand -base64 32

# Admin notifications
ADMIN_TELEGRAM_ID=
SMTP_HOST=
SMTP_USER=
SMTP_PASS=
ADMIN_EMAIL=

# Trust + safety
ADMIN_TRUSTED_IPS=     # CSV для auto-apply admin commands
```

---

## ⚠️ 13. Anti-patterns (что НЕ делать)

| ❌ Не делать | ✅ Делать |
|---|---|
| Tool без confirm_spend для платных действий | Approval flow с явным подтверждением юзера |
| Tool без ownership check | `if (resource.userId !== ctx.userId) error` |
| `process.env.X` в response body | Только маски / status / length |
| `console.log(token)` в логах | `console.log('token length:', token.length)` |
| Direct DB calls в LLM tools | Reuse existing storage methods |
| Hardcoded provider в chain | Configurable через chain[] |
| Tool без timeout | 30+ сек для external API tools |
| KB без mtime invalidation | mtime-based cache reload |
| Webhook без dedup | dedup по update_id (TTL 10 мин) |
| HMAC через === compare | timingSafeEqual |

---

## 🎯 14. Что НЕ включено (MuzaAi-specific)

Эти модули **исключены** из transfer package — они для music generation business:

- `generate_lyrics` / `rewrite_lyrics` / `create_music_job` tools
- Suno integration (GPTunnel /media/create polling)
- Robokassa payment endpoints
- `generations` таблица + meta.plays counter
- Player + lock-screen MediaSession patterns
- Cover generation pipeline
- Refund pipeline для failed Suno gens
- Track-rename + ID3 sync
- Premium voice messages tier
- Music-specific persona ("Музa — 25-летняя девушка")

Если в новом проекте нужны платные генерации (любого типа) — копируй approval flow + audit + refund паттерны, но pipeline создавай свой под domain.

---

## 📋 15. Quick start checklist

1. ✅ Скопировать `server/lib/` (10 файлов выше)
2. ✅ Скопировать DB schema (5 таблиц) + Drizzle config
3. ✅ Создать `.env` с минимум 1 LLM key (DeepSeek проще всего)
4. ✅ Customize `persona.ts` под проект (имя ассистента, gender, governance)
5. ✅ Customize `tools.ts` — оставить только нужные tools, добавить свои
6. ✅ Если нужны каналы — настроить webhook'и (TG/Max/VK)
7. ✅ Frontend chat-UI — взять `floating-consultant.tsx` как базу
8. ✅ Admin endpoints — `/api/admin/conversations`, `/api/admin/user-failures`, `/api/admin/audit`
9. ✅ Smoke-test: `curl /api/chat -d '{"text":"привет"}'` → LLM отвечает
10. ✅ Production: добавить helmet + CSP + HSTS + rate-limit + body-size

---

## 📦 TL;DR для нового проекта

**Минимум для рабочего chatbot:**
- 1 LLM key (DeepSeek $0.27/M — самый дёшево)
- 3 файла: `llmCore.ts` + `persona.ts` + endpoint `/api/chat`
- 1 таблица БД: `chatbot_messages`
- Frontend: один FAB с input + message list

**Уровень MVP+ (production-ready):**
- + multi-provider fallback (3+ keys в chain)
- + tools framework (с approval flow для платных)
- + audit-log + user_action_failures
- + KB loader (file-based)
- + cross-channel linking (TG/Max)
- + memory compression
- + helmet + rate-limit + HSTS

**Уровень mature (как MuzaAi):**
- + voice TTS/STT integration (Yandex / OpenAI Whisper)
- + admin dashboard со срезами
- + pair-link cross-channel
- + persona variants per-user
- + nightly channel test-drive
- + concurrent session alerts

Подробности по каждому модулю — в исходниках. Файлы в проекте под `apps/neurohub/server/` (TypeScript, strict mode, Drizzle ORM, Express).
