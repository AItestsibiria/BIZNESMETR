# CLAUDE.md — AI Assistant Guide for BIZNESMETR

This file provides context and conventions for AI assistants (Claude Code and others) working in this repository.

---

## Project Overview

**BIZNESMETR / Acme API** is a business metrics REST API platform — implementation host for the **MUZIAI v304** strategy (`podaripesnu.ru`).

**Repository:** `aitestsibiria/biznesmetr`  
**Primary remote:** `origin`  
**Runtime:** Node.js 20 LTS (verify on VPS1 — see `docs/strategy/PREFLIGHT.md`)  
**Stack:** Express · **SQLite** (`data.db`) · **Drizzle ORM** · TypeScript (strict) · Vitest · Zod  
**Note on stack:** PostgreSQL migration is planned for v305–v306 (see `docs/strategy/ANSWERS.md` §16). Until then, SQLite is the only DB.

---

## Strategy Package — MUZIAI v304 (READ FIRST)

The repository hosts the implementation of the **MUZIAI v304** strategy for `podaripesnu.ru`. The full strategic specification — architecture, plugin API, event catalog, full DB DDL, 8-sprint roadmap, deployment scripts — lives in `docs/strategy/`.

**Before writing any new code, read at least:**

1. `docs/strategy/README.md` — index and quick navigation
2. `docs/strategy/original/00-NAVIGATOR-объединённая-стратегия.md` — system map
3. `docs/strategy/original/06-PLUGIN-АРХИТЕКТУРА-ХВОСТЫ.md` — Module API, Event Bus, Hook Points (foundation for all new features)
4. `docs/strategy/original/07-DEPLOY-ROADMAP-СХЕМА-БД.md` — full DB schema, 8-sprint plan, one-command deploy

### Non-negotiable architectural rules

| Rule | What it means in code |
|---|---|
| **Thin core + plugins** | All new features live in `plugins/<name>/`. Never modify core (`auth`, `billing`, `generations`, `streaming`, `payments`, `playlist`, `admin`, `diagnostics`) except for critical bug fixes. |
| **Event-driven** | Plugins publish/subscribe through the `EventBus` — no direct cross-plugin calls. Standard event names live in `06 §2.3`. |
| **Plugin owns its tables** | Each plugin ships its own SQL migration; core schema is off-limits except for the additive ALTERs listed in `07 §3`. |
| **Feature flags by default** | New behavior gates on `feature_flags` so it can be toggled without a release. |
| **No vendor lock** | Suno via GPTunnel and Robokassa sit behind abstractions — keep that boundary. |

### Operational constraints

- **🚨 Single-VPS topology, three instances:** the host `72.56.1.149` runs:
  - `podaripesnu.ru` — **production #1** (live, selling) — DO NOT TOUCH
  - `muziai.ru` — **production #2** (live, selling) — DO NOT TOUCH
  - `clone.muziai.ru` — **staging** with a copy of prod data — this is the only place v304 code runs during development
  - Three apps, three paths, three pm2 processes — one machine. Any unscoped command can hit either prod. Always pin commands to the clone path (e.g. `/var/www/muziai-clone/`) — exact path comes from the §2 SSH audit.
- **Cutover flow:** all v304 changes land on clone first → smoke + integration tests → Eugene approves → roll to `podaripesnu.ru` → roll to `muziai.ru`. Each prod cutover gets its own five-level warning, ручной DB snapshot, and rollback rehearsal.
- **All UI text, logs, emails, and docs are in Russian.**
- The 25 blocker questions from `07 §4` are now answered — see `docs/strategy/ANSWERS.md`. Pre-Sprint 1 / 6 / 7 checklists in `docs/strategy/PREFLIGHT.md`.

### Sprint roadmap (≈2.5 months, 1 dev)

S1 foundations · S2 Suno @ 100% · S3 Persona/Extend/Cover · S4-5 nine agents · S6 chatbot · S7 dashboard + ads · S8 hardening. Detail in `07 §2`.

### Autonomy on clone (Eugene 2026-05-06, evening — confirmed 19:20 UTC «уровень Бог»)

**Полномочия на VPS `72.56.1.149` касательно `clone.muziai.ru`:** Евгений делегировал авто-выполнение любых операций — вплоть до полной перерегистрации, миграций, удаления данных, переустановки зависимостей — **в границах этого инстанса** (`/var/www/neurohub/`, pm2 `neurohub`, его `data.db`, `authors/`, `.env`, его systemd-таймер, его бэкапы в `/var/backups/neurohub-auto/`).

«Уровень Бог» означает: НЕ задавать у Евгения подтверждения для:
- любых правок кода в `apps/neurohub/`,
- миграций schema (через storage.ts auto-migrate),
- установки/удаления npm-зависимостей,
- деплоев через `git push` (auto-deploy сам подхватит),
- pm2-рестартов через скрипт,
- правок auto-deploy логики,
- очистки бэкапов в `/var/backups/neurohub-auto/`,
- переинициализации clone-БД при необходимости,
- ротации кодовых артефактов (`/opt/neurohub-src`).

Подтверждение всё ещё требуется (исключения):
- Любая операция, выходящая за границы clone-инстанса (worldbeauty, prod-VPS, чужие проекты).
- Операции, требующие реальных секретов (ввод GPTUNNEL_API_KEY, SMTP credentials и т.д.) — Евгений делает их сам через ssh.
- Force-push на `claude/*` ветки или history rewrite (filter-branch) — это видно публично.

**Граница строго фиксирована:**
- ❌ `/var/www/worldbeauty/` — сторонний проект Евгения, не трогаем
- ❌ `/var/www/anthropic-proxy/` — proxy сервис, не трогаем
- ❌ `/var/www/podaripesnu*` и `/var/www/muziai*` — если когда-нибудь появятся на этом VPS, **не трогаем** (они prod на другом VPS, но имена защищены на случай миграции хостов)
- ❌ Любые операции на других VPS (прод `muziai.ru` на `31.130.148.107`, `podaripesnu.ru` TBD) — **только** с явным новым «да» Евгения

**Канал доставки:** через `git push` + auto-deploy (см. `deploy/auto-deploy.sh` + `deploy/install-auto-deploy.md`). Прямого SSH из моей sandbox-среды нет; всё, что не ложится в эту автоматику, требует prompt'а Perplexity.

**Health check + rollback** в самом `auto-deploy.sh` гарантирует: если коммит ломает сборку или health-check `/api/example/ping`, dist возвращается из pre-flight backup, и pm2 поднимается на предыдущей версии. Я вижу это в ветке `clone-deploy-log` и поправляю следующим коммитом.

### Pitfalls registry rule (Eugene 2026-05-07)

**Перед задачей класса, который уже встречался — сверяюсь с `docs/strategy/PITFALLS.md`.** Каждая ошибка после первого раза становится записью в этом файле. Документ покрывает: shell-экранирование, systemd+pm2 HOME, esbuild + dynamic imports, SQLite timestamp compare, v51 auth pattern, self-update гонки, npm install через symlink, hardcoded keys, секреты в чате.

При появлении нового класса бага — обновляю PITFALLS.md в том же коммите что и фикс. Это превращает накопленный опыт в навигационную карту: каждое будущее действие проверяется по списку.

### Key rotation pattern (Eugene 2026-05-07)

**Стандартный путь ротации любого секрета** (GPTUNNEL_API_KEY, SMTP_PASS, TELEGRAM_BOT_TOKEN, ROBO_PASSWORD*, и т.д.) на VPS:

```
ssh root@72.56.1.149 'sed -i "/^ИМЯ_КЛЮЧА=/d" /var/www/neurohub/.env \
  && echo "ИМЯ_КЛЮЧА=ВПИСАТЬ_РУКАМИ" >> /var/www/neurohub/.env \
  && chmod 600 /var/www/neurohub/.env \
  && pm2 restart neurohub --update-env'
```

**Жёсткие правила:**

1. **Никаких пробелов** между `=` и значением (см. PITFALLS #12 — dotenv не trim'ит lead-space).
2. **Никаких кавычек** вокруг значения — dotenv их сделает частью строки.
3. Значение **набирается руками** с клавиатуры в Mac Terminal, **никогда** Cmd+V из любого источника, который мог пройти через AI-чат.
4. После — `pm2 restart neurohub --update-env` обязательно (без `--update-env` env не подхватится).
5. **Верификация** через awk:
   ```
   ssh root@72.56.1.149 'awk -F= "/^ИМЯ_КЛЮЧА/{print \"length:\", length(\$2), \"first8: [\" substr(\$2,1,8) \"]\"}" /var/www/neurohub/.env'
   ```
   length должна совпадать с реальной длиной (без +1 от пробела), first8 — без пробела в первой позиции.
6. **Ротация трижды и более** на одном ключе считается компрометацией → следующая ротация это +1 секрет, который тоже под наблюдением.
7. **Если ключ всё-таки попал в чат / git / мессенджер** → его надо отозвать у провайдера. Замены недостаточно — попавший наружу секрет permanent скомпрометирован.

См. `docs/strategy/PITFALLS.md` пункты #10 (секреты в чате) и #12 (lead-space в .env).

### Backup-before-edit rule (Eugene 2026-05-07)

**Любая admin-редакция данных через UI/API создаёт snapshot прежнего состояния.** Применяется ко всем PUT/PATCH/DELETE на `/api/admin/v304/*`. Технически:

- Таблица `admin_audit_log` хранит per-edit JSON-снапшот (before / after).
- Каждый ответ admin-эндпоинта содержит `auditId` — путь восстановления.
- POST `/api/admin/v304/audit/:id/restore` откатывает к prior state.
- `data.db` целиком бэкапится скриптом `auto-deploy.sh` (`/var/backups/neurohub-auto/`) при каждом успешном деплое — это страховка более грубого зерна.

Для **критических операций** (миграции, удаление таблиц, ротация ключей) — отдельный manual snapshot вне auto-deploy цикла.

### Working rhythm rule (Eugene 2026-05-06)

**После каждого успешного промежуточного результата (отчёт Perplexity, прохождение этапа, верификация чек-пойнта) — автоматически переходи к следующему логическому шагу. Не задавай «что дальше?», не жди команды.** Останавливайся ТОЛЬКО при:
- неоднозначности, требующей выбора Евгения (тогда `AskUserQuestion`),
- риске, требующем подтверждения (cutover на prod, удаление данных, ротация ключей),
- зафиксированном сбое, который надо разобрать перед движением дальше.

В остальных случаях движение по плану — настройка по умолчанию.

### Decreasing-reliability options rule (Eugene 2026-05-08)

**Когда предлагаю варианты решения — всегда сортирую от самого надёжного и необходимого к менее.** То есть: первый вариант = best practice, проверенное решение, минимизирует риск; последний — компромисс / временный костыль.

Формат:
1. **[Самое надёжное]** — proper fix, может занять больше времени но закрывает root cause
2. **[Среднее]** — компромисс между качеством и временем
3. **[Быстрое]** — patch чтобы разблокировать, требует follow-up
4. **[Не рекомендую]** — если бы вообще делал, то так

Применяется к: предложениям после bug-аудита, выбору архитектуры, рефакторингу. Не применяется к: просто-описание состояния системы, ответам на вопросы где есть один правильный ответ.

### Reuse-working-solutions rule (Eugene 2026-05-07)

**Запоминай какие решения работают без отказно — приоритетно используй их повторно.** Перед написанием НОВОГО endpoint'а / pipeline'а / компонента — сначала смотрю, есть ли в кодовой базе аналог, который уже подтверждённо работает в проде. Если есть — funnel через него, не создаю параллельный путь.

Анти-паттерн который это правило закрывает:
- Я создал `/api/gen/audio-cover` со своей логикой sunoBody (vocalGender, instrumental flag, suno-cover model). Накопил 3 коммита фиксов. По итогу это не работало. Решение: funnel audio mode через РАБОЧИЙ `/api/music/generate` (тот же что у Текст·Расширенный) — заработало с первого раза.
- Похожие случаи: магический звон/цвет можно собрать с нуля ИЛИ переиспользовать `btn-cosmic` от landing CTA (что уже знаем работает). Второе — приоритет.

Цикл проверки перед новой реализацией:
1. Grep по существующим endpoint'ам / компонентам со схожим назначением
2. Подтвердить что они РАБОТАЮТ (Eugene успешно использует, тесты прошли, нет инцидентов)
3. Использовать их напрямую (вызов / ре-export / wrapper) вместо параллельной реализации
4. Только если параметрические нужды РЕАЛЬНО не покрываются — создавать новое

Реестр работающих решений (обновляется):
- `/api/music/generate` — генерация music (custom-mode + basic-mode). Принимает lyrics, style, voice/voiceType, isDuet, instrumental. Вшит refund/timeout/poller. Используется для Текст·Простой / Текст·Расширенный / Audio (после af965ea).
- `/api/admin/v304/gptunnel-balance` — реальный баланс GPTunnel + расчёт Suno-треков.
- `transcribeRussianAudio()` (server/lib/transcribe.ts) — multi-provider STT с приоритетом Yandex.
- `normalizeVocalParams()` (server/lib/normalizeVocalParams.ts) — единый normalizer voice (Female Vocal / Male Vocal / Duet / Instrumental).
- `btn-cosmic` (index.css) — magic shimmer-gradient CSS class. Используется на landing CTA + magic-кнопке /music.
- `pollProcessingGenerations()` + bonus 2-й трек (admin-overview/module.ts).

### Numbered options rule (Eugene 2026-05-07)

**Любые варианты, тест-кейсы, чек-листы и опции я нумерую цифрами с новой строки.** Это позволяет Евгению отвечать в формате «1 ок, 2 не ок, 3 ошибка X» — без переспрашивания «о каком пункте речь».

Формат:
```
1. Открой /dashboard → ?
2. Открой /admin/v304 → ?
3. F12 Console → ?
```

Применяется к: тест-планам после деплоя, AskUserQuestion-альтернативам в свободном тексте, любым перечислениям action items для Евгения. Не применяется к буллет-листам нерелевантных деталей (документация, пояснения).

### Latin-keyboard decode rule (Eugene 2026-05-07)

**Когда Евгений набирает русские слова латинскими буквами (т.е. забыл переключить раскладку, печатает русские буквы по физическим клавишам Mac/PC), первым делом показываю расшифровку, потом отвечаю по сути.**

Пример входа: `dslfdfq nj xnj vyt ye;yj jnrhsdfnm ccskrfvb`
Распознавание: маппинг QWERTY-позиций ↔ ЙЦУКЕН (`d→в, s→ы, l→д, f→а, q→й, n→т, j→о, x→ч, v→м, y→н, t→е, e→у, ;→ж, r→к, h→р, k→л, b→и, c→с, m→ь, …`).
Формат ответа:
> Понял как: «выдавай что мне нужно открывать ссылками»
>
> [Содержательный ответ ниже]

Если расшифровка двусмысленная — указываю обе версии и спрашиваю «правильно?». Если латинский текст — английский (а не транслит), декодирую как английский без комментария.

### Pre-edit analysis rule (Eugene 2026-05-07)

**Перед правкой — анализирую взаимосвязи. Во время кодинга — учитываю выводы анализа. После правки — проверяю итог.** Цикл:

1. **Анализ перед правкой:** какие файлы зависят от меняемого кода? Кто импортирует функцию/таблицу/эндпоинт? Какие соседние модули могут стать жертвой коллизии (одинаковые префиксы routes, одинаковые dom id, одинаковые ключи env, конфликтующие миграции)? Что в БД может быть несовместимо (старые строки без новых колонок)?
2. **Кодинг:** меняю с явным учётом найденных зависимостей — никаких «потом подправлю». Если нашёл коллизию — сразу разрешаю переименованием/изоляцией, а не затыкаю «работает локально».
3. **Проверка итога:** после правки — `npm run build` (зелёный?), grep на ВСЕ места использования изменённого имени (нет ли осиротевших), запуск smoke-test'а на clone, чтение логов pm2 после деплоя в течение хотя бы одной минуты. Если правка касается БД — проверка миграции на пустой clone-БД.

Анти-паттерны, которые это правило закрывает:
- две POST-route с одним путём в разных плагинах → первый зарегистрированный съедает запрос
- ALTER TABLE ADD COLUMN без default → старые селекты получают NULL и падают
- переименование функции без обновления всех call-site'ов
- удаление env-ключа без проверки кто его читает
- правка одного из 4 entry-point'ов нормализатора при наличии 5-го

Это правило сильнее «working rhythm rule» — рывок без анализа стоит дороже, чем минута на проверку.

### Timestamp footer rule (Eugene 2026-05-07)

**В конце каждого ответа в чате — мелким шрифтом (HTML `<sub>` или markdown с эмодзи `🕐`) дата + время с точностью до минуты, по часам сервера.** Формат: `🕐 2026-05-07 08:34 MSK`. Цель — Евгений видит хронологию всей переписки и может ссылаться на конкретную запись по времени.

Применяется к **каждому** assistant-ответу, включая короткие подтверждения, сообщения об ошибках, статусы push'ей. Не применяется к tool-output'ам (они и так timestamped средой).

> ⚠️ The CLAUDE.md sections below describe the local Acme API conventions that apply to **how** we write code in this repo (Express, Drizzle, Zod, etc.). The strategy package describes **what** we build. Follow both.

---

## Commands

```bash
npm run dev             # Start development server
npm run test            # Run tests (Vitest)
npm run test:smoke      # Smoke tests only (target: < 10 min)
npm run lint            # ESLint + Prettier check
npm run build           # Production build
npm run db:migrate      # Apply Drizzle migrations to data.db
npm run db:test:reset   # Recreate test SQLite DB and apply migrations
```

---

## Architecture

- **Framework:** Express REST API
- **Database:** SQLite (`data.db`) accessed via **Drizzle ORM**. Migrations live in `drizzle/migrations/`; per-plugin migrations in `plugins/<name>/migrations/`.
- **Request handlers:** `src/handlers/` (core) and `plugins/<name>/routes.ts` (plugins) — one file per resource / route group
- **Shared types:** `src/types/` — TypeScript interfaces and Zod schemas shared across the app
- **Plugin runtime:** Module API (see `docs/strategy/original/06-PLUGIN-АРХИТЕКТУРА-ХВОСТЫ.md`) — every new feature is a plugin with its own `module.ts`, migrations, routes, jobs, event subscriptions
- **Eventing:** in-process `EventBus` with persisted events in the `events` table

### Response Shape

Every endpoint returns the same envelope — no exceptions:

```ts
{ data: T | null, error: string | null }
```

Never break this shape. On success, set `data` and leave `error` null. On failure, set `error` and leave `data` null. Never expose stack traces or internal error messages to the client.

---

## Conventions

### Validation

Use **Zod** for all request body and query-param validation. Define schemas in `src/types/` when they are shared; colocate them in the handler file when they are route-specific.

```ts
import { z } from 'zod'

const CreateWidgetSchema = z.object({
  name: z.string().min(1),
  value: z.number().positive(),
})
```

Parse at the handler boundary before any business logic runs.

### Logging

Use the **`logger` module** — never `console.log`, `console.error`, etc.

```ts
import { logger } from '../logger'

logger.info('Widget created', { widgetId })
logger.error('Failed to create widget', { error })
```

### TypeScript

- **Strict mode is on.** The compiler will reject unused imports — remove them.
- Do not use `any`. Use `unknown` and narrow with type guards or Zod `.parse()`.
- Do not silence TypeScript errors with `// @ts-ignore` or `// @ts-expect-error` without a comment explaining why.

### Error Handling

- Catch errors at the handler level; return `{ data: null, error: 'Human-readable message' }`.
- Never let raw Drizzle errors, Zod errors, or Node errors propagate to the HTTP response body.
- Log the full error internally before sending the sanitized response.

---

## Testing

Tests use a **real local SQLite database** — not mocks.

```bash
# Always reset the test DB before a test run
npm run db:test:reset
npm run test
```

- Test files live alongside source files or in a `__tests__/` subdirectory (per file 06 §6.1, plugins keep their tests in `plugins/<name>/__tests__/`).
- Seed data and fixtures go through Drizzle directly — no raw SQL in tests except for `PRAGMA` statements.
- Each test suite is responsible for cleaning up the data it creates.
- `PRAGMA integrity_check` is part of smoke tests.

---

## Branch Conventions

| Pattern | Purpose |
|---|---|
| `main` | Stable, production-ready code |
| `develop` | Integration branch for features |
| `feature/<description>` | New features |
| `fix/<description>` | Bug fixes |
| `claude/<description>-<id>` | Branches created by Claude Code (auto-generated) |

Claude Code branches follow the pattern `claude/<short-description>-<random-suffix>`, e.g. `claude/add-claude-documentation-GOqfS`.

**Never push directly to `main`.** All changes go through pull requests.

---

## Commit Message Convention

Use [Conventional Commits](https://www.conventionalcommits.org/):

```
<type>(<scope>): <short summary>

[optional body]

[optional footer]
```

Common types: `feat`, `fix`, `refactor`, `test`, `docs`, `chore`

Examples:
```
feat(handlers): add GET /widgets endpoint with pagination
fix(auth): handle expired token refresh correctly
test(handlers): add coverage for widget creation errors
```

---

## For AI Assistants

### Before Making Changes

1. **Read the relevant files first.** Never edit code you haven't read.
2. **Follow existing patterns.** Check nearby handlers for how validation, logging, and responses are structured before writing new code.
3. **Scope changes to what was asked.** Do not refactor surrounding code, add docstrings, or clean up unrelated areas.

### Critical Rules

- Always use the `logger` module — never `console.log`.
- Always validate request input with Zod before touching business logic.
- Always return `{ data, error }` — never a bare object or array.
- Never expose stack traces, Drizzle error details, or internal paths to the client.
- Remove all unused imports — TypeScript strict mode will fail the build otherwise.
- Before suggesting tests pass, run `npm run db:test:reset` then `npm run test`.
- New features go into `plugins/<name>/` — never modify core directly except for fixes listed in `docs/strategy/original/01-АУДИТ-И-АРХИТЕКТУРА.md`.

### Security

- Never introduce command injection, SQL injection, XSS, or other OWASP Top 10 vulnerabilities.
- Use Drizzle's parameterized queries — never string-interpolate user input into queries.
- Do not log secrets, tokens, passwords, or PII. Logger has a redaction layer (Sprint 8).
- Do not commit secrets to the repo. `.env` is git-ignored. **Do not paste secrets into chats / PRs / commits — even encrypted blobs.** Eugene installs secrets directly into VPS1 `.env` over SSH.

### Git Workflow for AI Assistants

- Develop on the designated feature branch (check task description or system prompt).
- Commit with descriptive messages following Conventional Commits format above.
- Push using `git push -u origin <branch-name>`.
- Do **not** create a pull request unless explicitly asked.
- Do **not** force-push or rebase published commits.

---

## Environment Variables

Full list lives in `docs/strategy/original/07-DEPLOY-ROADMAP-СХЕМА-БД.md` §1.6 (`.env.example`). Minimum to boot:

| Variable | Required | Description |
|---|---|---|
| `NODE_ENV` | Yes | `development`, `test`, or `production` |
| `DATABASE_URL` | Yes | SQLite path, e.g. `file:./data.db` |
| `TEST_DATABASE_URL` | Yes | Separate SQLite path for Vitest, e.g. `file:./data.test.db` |
| `SESSION_SECRET` | Yes | 32-byte random for signed cookies |
| `SIGNED_URL_SECRET` | Yes | 32-byte random for streaming signatures |
| `GPTUNNEL_API_KEY` | Yes (S2+) | Suno via GPTunnel |
| `ROBOKASSA_LOGIN` / `_PASSWORD_1` / `_PASSWORD_2` | Yes (S3+) | Payments |
| `SMTP_*` / `IMAP_*` | Yes (S6) | Email hub |
| `TELEGRAM_BOT_TOKEN` | Yes (S6) | TG channel |
| `VK_GROUP_ID` / `VK_ACCESS_TOKEN` / `VK_CONFIRMATION_CODE` / `VK_SECRET` | Yes (S6) | VK channel |
| `YM_COUNTER_ID` / `VK_PIXEL_ID` | Yes (S1) | Pixels |
| `LLM_PROVIDER` / `LLM_MODEL` | Yes (S6) | ConductorBot LLM |

Store secrets in `.env` (git-ignored). Commit `.env.example` with placeholder values only. **Do not transmit secrets through the chat — Eugene puts them on VPS1 directly over SSH.**

---

*Last updated: 2026-05-06 — Stack corrected to SQLite + Drizzle + Vitest (per `ANSWERS.md` §16). 25 v304 blocker questions answered; pre-sprint checklists in `docs/strategy/PREFLIGHT.md`.*
