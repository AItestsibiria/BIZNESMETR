# CLAUDE.md — AI Assistant Guide for BIZNESMETR

This file provides context and conventions for AI assistants (Claude Code and others) working in this repository.

---

### Chat-tool-calling rule (Eugene 2026-05-21)

**Все генерации (music / lyrics / cover) и управление треками доступны через Музу-чат как tool calls, не только через UI кнопки.** Музa использует Anthropic function-calling — сама решает когда вызвать tool на основании реплики юзера.

**MVP tools** (см. `apps/neurohub/server/lib/chatGenerationTools.ts`):
- `generate_lyrics({topic, style?, mood?, language?, confirm_spend})` — 99 ₽
- `rewrite_lyrics({lyrics_id, instruction, confirm_spend})` — 99 ₽
- `create_music_job({source_type, lyrics_id?|lyrics_text?|prompt?, genre?, mood?, voice?, category?, confirm_spend})` — 399 ₽ (или подарочный трек если есть)
- `get_generation_status({job_id})` — бесплатно
- `list_recent_assets({limit?})` — бесплатно
- `get_asset_details({asset_id})` — бесплатно
- `publish_asset({asset_id, visibility, confirm_publish})` — бесплатно, но требует confirm
- `cancel_generation_job({job_id})` — бесплатно (refund если deny)

**Approval flow (обязательный для платных + visibility changes):**

1. Музa вызывает tool БЕЗ `confirm_spend`/`confirm_publish` → backend возвращает JSON:
   ```json
   {
     "ok": false,
     "approval_required": true,
     "tool": "create_music_job",
     "estimated_cost_kopecks": 39900,
     "estimated_cost_label": "399 ₽",
     "user_balance_label": "1200 ₽",
     "params_preview": {...},
     "message": "Создать музыкальный трек «Маме на 70» (pop, warm) — 399 ₽?"
   }
   ```
2. `/api/muza/chat` `onToolResult` callback ловит `approval_required` → ставит `pendingApproval` в response.
3. Frontend (`floating-consultant.tsx`) рендерит `ChatApprovalCard` под bot-message с кнопками **[Подтвердить]** / **[Отмена]**.
4. Юзер жмёт **Подтвердить** → отправляется текст «Да, подтверждаю <tool>. Запускай (confirm_spend=true, confirm_publish=true).» → LLM повторяет вызов tool уже с confirm-флагом → backend списывает деньги и запускает генерацию.

**attachedJob hint flow:**
- Tool handler возвращает JSON с `hint: "attachedJob:<gen_id>"` → backend ловит → загружает meta-данные → передаёт `attachedJob` в response → frontend рендерит `ChatJobCard`.
- Если `status='processing'` (music) — frontend опрашивает `GET /api/generations/:id/status` каждые 7 сек (макс 7 мин).
- Когда `status='done'` — встроенный `<audio>` с persistent player.

**Жёсткие правила:**

1. **Все платные tools обязаны проверять `confirm_spend === true` ДО любого списания.** Без подтверждения — возвращают `approval_required: true`. Это закрывает риск «LLM по своей инициативе спустил баланс юзера».
2. **`publish_asset` требует `confirm_publish === true`.** Иначе тоже approval.
3. **Audit-log обязателен.** Каждый успешный tool call → `recordAuditEntry({entity: "chat_tool:<name>", entityKey: <gen_id>, after: {...params}})`. Босс видит в `/admin/v304 → audit-log`.
4. **Ownership check.** Все tools работающие с конкретным `asset_id`/`job_id` обязаны проверять `gen.userId === ctx.userId`. Иначе — `{ok:false, error:"Не найдено или не принадлежит вам."}`.
5. **Refund при ошибке.** Если списали деньги но генерация упала (GPTunnel вернул error, нет task_id) — обязательный `storage.refundGeneration({...})` + `{ok:false, error:"...Баланс возвращён.", refunded:true}`.
6. **Reuse existing logic.** Tools НЕ создают параллельные endpoints — обёртки над существующей логикой (`storage.createGeneration`, `gptunnelCall`, `normalizeVocalParams`, `getCurrentPriceKopecks`). См. Reuse-working-solutions rule.
7. **Timeout для GPTunnel tools 35 сек.** Дефолтные 8 сек слишком короткие для `/media/create` (Suno gen accept ≈ 5-25 сек). См. `LONG_TOOL_TIMEOUTS` в `muzaTools.ts`.

**НЕ применяется к:**
- Анонимным юзерам — без auth все tools возвращают `{ok:false, error:"Юзер не залогинен."}`. Анон проходит через registration flow (PROPOSE_REGISTER маркер).
- Free-tier бонусным трекам — bonusTracks списываются autoamtically до денег (см. `create_music_job` handler).

**Применяется к:** web `/api/muza/chat`, Telegram bot (когда подключим chat tools — пока только web), Max bot. НЕ применяется к: REST endpoints `/api/music/generate` и т.п. (они остаются для UI кнопок).

**Связано с:**
- Pricing-single-source rule — все цены через `getCurrentPriceKopecks()` (lib/pricing.ts)
- Reuse-working-solutions rule — tools используют тот же pipeline что REST endpoints
- Musa-knowledge-governance rule — клиент видит только свои треки/платежи (ownership guard)
- User-action-failure registry rule — failed tools пишутся в `user_action_failures` (TODO для следующих итераций)

---

### Self-review-before-output rule (Eugene 2026-05-16)

**Перед выдачей любого решения — критически просматриваю его сам.** Если нашёл ошибку — исправляю и выдаю исправленное. Если ошибок нет — выдаю.

Что проверяю:
- Команда корректна (синтаксис, escape, autolink проблемы)
- Plаceholder'ы заменены на реальные значения (или явный 🔴маркер🔴)
- URL правильный (не битый, не от старого домена)
- Логика следует из контекста (нет противоречия с предыдущими сообщениями)
- Нет утечек секретов / PII

Ошибки которые делал — запоминаю в `docs/strategy/PITFALLS.md` и больше не повторяю.

### Max-automation rule (Eugene 2026-05-16)

**Всегда ищу путь минимального действия для Босса = максимум автоматизации.** Если могу сделать сам через MCP/API — делаю. От Босса прошу только то что физически не могу:
- Ввод секретов (private keys, tokens, passwords) — Босс делает руками
- Approve PR на защищённой ветке (требует write access от другого user'а)
- Изменение GitHub branch protection settings
- Физический клик в UI который недоступен по API

Всё остальное — автоматизирую через GitHub MCP, Figma MCP, Bash, и т.д.

### Token-economy rule (Eugene 2026-05-16)

**Экономь токены — не в ущерб качеству.**
- Короткие ответы предпочтительнее длинных
- Без markdown-украшений (заголовков с эмодзи) если не помогают понять
- Без перечисления того что и так очевидно из контекста
- Subagents для больших задач (вместо забивания main context)
- НЕ читать файлы целиком если нужна только часть — Read с offset/limit или grep
- НЕ дублировать вывод subagent в сообщении — сослаться

Качество всегда приоритет: если краткость теряет смысл — пиши подробнее.

---

## Project Overview

**BIZNESMETR / Acme API** is a business metrics REST API platform — implementation host for the **MUZIAI v304** strategy (`podaripesnu.ru`).

**Repository:** `aitestsibiria/biznesmetr`  
**Primary remote:** `origin`  
**Runtime:** Node.js 20 LTS (verify on VPS1 — see `docs/strategy/PREFLIGHT.md`)  
**Stack:** Express · **SQLite** (`data.db`) · **Drizzle ORM** · TypeScript (strict) · Vitest · Zod  
**Note on stack:** PostgreSQL migration is planned for v305–v306 (see `docs/strategy/ANSWERS.md` §16). Until then, SQLite is the only DB.

---

## 🏆 Triumph редакция (Eugene 2026-05-08, tag `triumph-080526`)

Стабильный slice работающего кода после долгого рабочего дня. Если что-то сломается, вернуться к этой точке: `git checkout triumph-080526`.

## 🎙 Триумф в Эфир (Eugene 2026-05-08, tag `triumph-na-efire-080526`)

Готовая к эфиру редакция (всё кроме audio-модуля). Восстановить: `git checkout triumph-na-efire-080526`.

В scope:
- Полный refund pipeline (atomic claimRefund + storage.refundGeneration единый entry-point)
- Auto-recovery поздних Suno треков (admin-overview cron, 30-мин cutoff)
- Watchdog circuit breaker + multi-channel alerts (Telegram + Email + Console + Incident)
- 60-мин error-rate window для упорных проблем
- Per-user playlist persistence (sortMode/sortDir/category/trackId/currentTime per userId)
- Регенерация errored с моргающей кнопкой → /music с предзаполненной формой
- Track-title rule (display_title всегда сохраняется, изменяет только владелец)
- Clone noindex для поисковиков (X-Robots-Tag header + /robots.txt)
- V2 cleanup битых бонусов (cron в admin-overview)
- Country grouping в visitor stats (объединение Russia/Россия по country_code, English только)
- Live banner «Идёт процесс генерации» в /music и /dashboard
- Voice reinforcement (4-5 сигналов: EN+RU+brackets+style+lyrics) — высокая точность Suno
- /diag UI с проверкой ВСЕХ ключей провайдеров (GPTunnel + Yandex + OpenAI + Telegram + SMTP + Robokassa + Anthropic)
- Copy-reports-button везде где отчёт
- 3-min choice panel при долгой генерации (подождать / открыть дашборд)
- Suno→MuziAi branding в user-facing
- F-pack: NULL task_id fix + errorReason enforce + позитивные сообщения + lifecycle-stats endpoint
- 26 плагинов loaded

НЕ в scope (audio-модуль):
- Mic recording → Yandex STT → Suno генерация по голосу. Работает, но stability не гарантируется триумфом. Если ломается — фиксить отдельно, не трогая остальной код.

Известные внешние ограничения (не наш контроль):
- Suno backend периодически нестабилен — auto-recovery + circuit breaker компенсируют
- callback_url revertнут (polling-only) — webhook endpoint dormant

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

### Yars-messenger-no-autoapply rule (Eugene 2026-05-22, **сильнее Yars-admin-confirmation rule**)

**Ярс-команды из мессенджеров (Telegram, Max, web-chat сторонних виджетов) — ЗАПРЕТ на изменение любых ключевых элементов проекта без явного подтверждения Босса в Claude chat (claude.ai/code).**

Цитата Босса 2026-05-22: «Ярс запрет на изменение любых ключевых элементов проекта через мессенджеры, анализируй предлагай подтверждаю только здесь их правило запомни».

**Что значит «здесь» = claude.ai/code session** (где Босс общается с Claude напрямую через CLI/web). **НЕ** мессенджеры Музы (TG bot, Max bot, web-chat Музы на muzaai.ru).

**Что запрещено auto-apply из мессенджеров (вне зависимости от risk-level):**

- ❌ Любые code-changes (commits / push / file edits)
- ❌ Schema migrations (ALTER TABLE, CREATE, DROP)
- ❌ Endpoint add/remove / change в `routes.ts`
- ❌ Изменения payments (`/api/payment/*`, Robokassa logic)
- ❌ Изменения auth / security (`requireAdmin`, session secrets)
- ❌ Ротация секретов / API keys
- ❌ Удаление юзеров / транзакций / БД-данных
- ❌ Изменения CI/CD / deploy scripts
- ❌ Force-push, rebase published commits
- ❌ Включение/отключение security middleware
- ❌ Bulk операции которые стоят денег провайдерам (массовая Suno/SMS)
- ❌ `npm install` / dependency-changes
- ❌ Любые **«code_change», «db_migration», «schema_change», «secret_change», «prod_deploy», «plugin_install», «dependency_change»** category

**Что МОЖНО auto-apply из мессенджеров (low-risk content)** — после явной фиксации этого списка в правиле:

- ✅ News post / news-card в landing-CMS
- ✅ KB update (Knowledge Base текст для Музы)
- ✅ Persona tweak (текстовые правки в consultantPersona.ts если не структурные)
- ✅ UI text (toast'ы / button labels / copywriting)
- ✅ Feature toggle on/off (через `feature_toggles` table)

Эти категории обрабатываются через **`yarsExecutor.ts`** auto-apply pipeline (см. `Admin-Muza-message base + auto-apply rule`). Всё остальное — **строго pending → ждёт Claude review здесь**.

**Workflow при Yars-команде из мессенджера:**

1. Юзер (Босс) пишет в TG/Max/web-chat: «Ярс: ...»
2. `yarsAutoTag.ts` детектит → set `is_yars_command=1`, `yars_category`, `yars_risk_level`
3. **Если category в whitelist (low-risk content)** → `yarsExecutor.ts` выполняет (см. Admin-Muza-message rule) + ставит `claude_review_decision='auto_applied'`
4. **Если category НЕ в whitelist** → запись остаётся `pending`. Claude (я) увидит её в next session через `GET /api/admin/v304/yars-queue` или Босс/я обнаружим через UI tab `🚨 Ярс-очередь`
5. Claude анализирует, предлагает фикс в claude.ai/code chat → Босс **здесь** даёт явное «да» → Claude apply + `POST /yars-queue/:id/mark-decision {decision:'applied', commitSha}`

**Защита от обхода:**

- `yarsAutoTag.ts` `categoryToRiskLevel()` мапит **destructive** categories в `risk_level='high'` (delete/secret/deploy)
- `yarsExecutor.ts` НЕ выполняет high-risk даже если запись была пришедшая из admin IP (`ADMIN_TRUSTED_IPS` whitelist не обходит этого правила)
- UI tab `yars-queue-tab.tsx` warning banner с пояснением workflow

**UI визуализация** (`admin/v304 → 🚨 Ярс-очередь`):
- Filter: status (pending / applied / rejected / all) + risk (low/medium/high)
- Summary: byRisk + byCategory counts
- Каждая запись: risk badge + category + channel (web/TG/Max) + decision status + SHA если applied
- Read-only — НЕ apply/reject отсюда (это только через Claude chat)

**Применяется к:** всем Yars-командам из любых каналов которые НЕ являются claude.ai/code. НЕ применяется к: правкам прямо через Claude CLI/chat (там Yars-admin-confirmation rule).

**Связано с:**
- Yars-admin-confirmation rule — базовый flow Claude→commit, теперь требует confirm Босса ЗДЕСЬ
- Admin-Muza-message base + auto-apply rule — whitelist content categories для auto-apply
- Autonomous-execution rule — Claude может делать non-risky изменения сам, но Yars из мессенджеров не считается «non-risky»
- Secrets-admin-only rule — secrets никогда через Yars (даже через Claude chat — только прямой SSH)

---

### Admin-tabs-groups rule (Eugene 2026-05-24, **сильнее No-duplicates rule в части UI organization**)

**В админ-панели `/admin/v304` все TabsTrigger сгруппированы по 6 направлениям через единый `tabClass(group)` helper (`apps/neurohub/client/src/pages/admin-v304.tsx`). Один источник правды для color-gradient'ов. НЕ дублировать inline-классы.**

Босс: «Проверяй дубли в админе, группируй по направлениям».

**Канонические 6 групп** (порядок в TabsList — этот же):

| Group | Префикс | Gradient | Что входит |
|---|---|---|---|
| `analytics` | 📊 | emerald → cyan → blue | Сводка, Второй мозг (3D), Воронки и тренды, Обзор системы, Прослушивания, Аудит плеев, Все домены, Путь, Диалоги |
| `users` | 👥 | cyan → sky → blue | Авторы, Профили, Память юзеров, Блокировки, Жалобы, NPS, Идеи, Обращения, Лиды |
| `musa` | 🎵 | purple → fuchsia → pink | Музa (friend), Аватар Музы, Информация о Музе, Письма Музы, Музa Директор (orchestrator), Каналы, Бот |
| `finance` | 💰 | amber → orange → fuchsia | Деньга (cost/profit) |
| `errors` | 🚨 | red → amber → fuchsia | Ошибки генерации, Ярс, Проблемы |
| `system` | ⚙️ | violet → purple → indigo | API ключи, Ключи AI, Секреты, VPS Sync, Архив, Генератор изображений, UI Toggles, Feature flags, Шаблоны, Заместители, Audit log |

**Жёсткие правила:**

1. **Любой новый tab ОБЯЗАН вызывать `tabClass(group)`** для className. Inline `data-[state=active]:bg-gradient-to-r ...` строки в TabsTrigger запрещены — это нарушение SSR (Single Source of Rule).
2. **Префикс label = emoji группы** (📊 / 👥 / 🎵 / 💰 / 🚨 / ⚙️). НЕ смешивать (например `🎨 Аватар` теперь `🎵 Аватар Музы`).
3. **Порядок tabs в TabsList идёт по группам** (analytics → users → musa → finance → errors → system). Внутри группы — по логической важности.
4. **Перед созданием нового tab — сверка с существующими в той же группе.** Если функция overlap'ит ≥70% — НЕ создавать (нарушение No-duplicates rule). Расширить existing.
5. **Если новая фича не вписывается ни в одну группу** — обсудить в claude.ai/code chat ДО implementation. Либо это сигнал создать 7-ю группу (редко), либо это сигнал что фича дублирует другую группу.
6. **Comments в TabsList с разделителями `═══ <emoji> <ГРУППА> ═══`** — обязательны для визуальной навигации в коде.
7. **`TAB_GROUP_STYLES` — read-only constant.** Менять цвета группы можно только через CLAUDE.md-апрув (это влияет на узнаваемость всех tabs группы юзером).

**Найденные дубли при аудите 2026-05-24** (статус: оставлены раздельными, оба нужны):
- `master-dashboard` (📊 Сводка) vs `overview` (📊 Обзор системы) vs `brain-3d` (3D) vs `brain-analytics` (воронки) — разные visualizations одних данных. Оставлены как 4 разных вкладки в группе `analytics`. Кандидат на консолидацию в будущем — sub-tabs внутри одной аналитической секции.
- `plays-audit` (per-track diagnostic) vs `plays-analytics` (aggregate с period selector) — разные purposes (deep-dive vs overview). Оставлены раздельно.
- `feature-toggles` (frontend UI toggles localStorage) vs `flags` (backend feature_flags DB) — разные слои. Оставлены раздельно.
- `bot-stats` vs `bot-channels` vs `orchestrator` — bot-stats показывает статистику Telegram, bot-channels manage'ит channels (webhook), orchestrator = registry всех agents. Все 3 в группе `musa`.

**Применяется к:** ВСЕМ будущим правкам `admin-v304.tsx` (добавление tabs, переименование, перегруппировка). НЕ применяется к: nested tabs внутри одной вкладки (например sub-tabs в yars-queue-tab.tsx — они под своим scope).

**Связано с:**
- No-duplicates rule — перед новым endpoint / UI tab проверка существующих
- Brand-style consistency rule — gradient'ы группы используют brand palette
- Yars-admin-unified rule — пример уже сделанной консолидации (operator + yars в один tab)
- Reuse-working-solutions rule — расширять `tabClass()` helper, не плодить параллельные

---

### Yars-admin-unified rule (Eugene 2026-05-23, **источник правды UI = одна вкладка**)

**В админ-панели `/admin/v304` есть ровно ОДНА вкладка для всех Ярс/operator-команд — `🚨 Ярс` (`yars-queue` tab, `apps/neurohub/client/src/pages/admin/yars-queue-tab.tsx`). Все прежние дубли удалены.**

Что было удалено (Eugene 2026-05-23):
- ❌ `🔐 Operator` (`OperatorCommandsTab` / `operator-commands-tab.tsx`) — отдельная очередь `operator_commands` table. Файл удалён, тэб снят.
- ❌ Встроенный блок «🎯 Правила от Ярса» в master-dashboard (admin-v304.tsx:2212-2245) — переехал внутрь `🚨 Ярс` как нижняя секция.

Что осталось:
- ✅ Единая вкладка `🚨 Ярс` (`yars-queue`) с прокачанным набором фич:
  - KPI карточки: pending / applied / auto-applied / rejected / avg-time-to-apply / safe-share
  - Фильтры: status (5 значений) · risk · channel (web/TG/Max) · date range (24h/7d/30d/all) · sort (created/risk/category) · category chips · free-text search
  - Inline-context для каждой записи: risk + category + safe badge + channel + decision + #id + userId + timestamp + SHA + reviewed-at + notes
  - Actions: refresh · copy report (markdown) · export CSV (BOM utf-8)
  - Аналитика: counts по decision + среднее время до apply (в минутах)
  - Нижняя секция «🎯 Правила от Ярса» (агрегат из user-сообщений по ключу «Ярс») — read-only

Источник правды — `chatbot_messages WHERE is_yars_command=1` (см. Yars-admin-confirmation rule + Yars-messenger-no-autoapply rule). Backend endpoints не тронуты:
- `GET /api/admin/v304/yars-queue` — основная очередь (с summary)
- `POST /api/admin/v304/yars-queue/:msgId/mark-decision` — Claude отмечает applied/rejected (вне UI)
- `GET /api/admin/v304/yars-rules` — агрегат правил
- Legacy `/api/admin/v304/operator-commands*` endpoints — остаются для совместимости (внешние webhooks могут писать туда), но в UI больше не отображаются. Если нужно — добавить вторую секцию в `yars-queue-tab.tsx` (отдельный fetch + render), не плодить новые tabs.

Применяется к: всем будущим правкам Ярс-функционала. НЕ создавать новые admin tabs для Yars/operator команд — расширять `yars-queue-tab.tsx`. См. No-duplicates rule.

---

### Yars-admin-confirmation rule (Eugene 2026-05-20, **сильнее Autonomous-execution rule в части code-changes**)

**Все Ярс-сообщения админа (Босса), которые касаются ПРАВОК В КОД — приходят в этот chat и требуют моего явного подтверждения «да» / «применяй» / «1 ok» перед commit'ом.** Auto-apply в проде НЕ применяет code-changes без подтверждения здесь.

Что такое «Ярс-сообщение админа»:
- Сообщение от Босса в Музa-чате (web/TG/Max/admin-voice) которое содержит operator-команды
- Сообщение записывается в `admin_chat_messages` таблицу (см. Admin-Muza-message base + auto-apply rule)
- Тип команд распознаётся через `yarsExecutor` категории: `news_post`, `kb_update`, `persona_tweak`, `ui_text`, `code_change`, `db_migration`, `endpoint_add`, `endpoint_remove`, `feature_toggle`, ...
- Сообщения с маркером «Ярс:» / «yars:» / «оператор:» / содержащие действия которые меняют **код проекта**

Workflow когда Босс приносит Ярс-команду в этот chat (как копи-паст или скриншот):

1. **Claude echo**: цитирую распознанную команду + контекст из admin_chat_messages если предоставлен
2. **Анализ**: какие файлы затрагивает, какая логика, **риск** (data-loss / breaking change / cosmetic)
3. **Предложение**: diff или описание изменений с file:line

Дальше (Eugene 2026-05-20 уточнение «1-3, если рисков нет сразу коммич»):

- 🟢 **Если рисков НЕТ** — apply + commit + push **сразу** после шагов 1-3, без шага «жду да». В отчёте Боссу — SHA + краткое описание.
- 🔴 **Если есть риск** — шаг 4: жду явного «да» / «применяй» / «1 ok» / «✅».
  - «нет» / «отбой» / «1 нет» — discard
  - вопросы / уточнения от Босса — отвечаю не применяя

5. **После apply**: commit message содержит `via=yars-confirmed` и SHA в audit-log

**Что считается «без рисков»** (apply сразу):
- UI text правки (toast'ы, button labels, placeholders)
- Стили / цвета / spacing / классы Tailwind
- Контент (новости, описания, KB texts)
- Comment / docs правки
- Bug fix с очевидным root cause (тоже считается no-risk, если fix targeted)
- Tests без breaking
- Refactor с явной выгодой и без user-visible regression
- Новые UI tabs / drawer items / admin widgets
- Новые endpoints для READ операций
- Frontend safety guards (Array.isArray, ?., try/catch)

**Что требует confirmation** (🔴, жду «да»):
- DROP / DELETE / TRUNCATE — любая data-loss SQL
- ALTER TABLE с потерей данных (DROP COLUMN, change type)
- Изменения payment endpoints (Robokassa init/refund/result)
- Изменения security middleware (requireAdmin, requireAuth)
- Изменения секретов / .env / ротация
- Force-push, rebase published commits, history rewrite
- Удаление пользователей / аккаунтов
- Prod deploy
- Изменения CI/CD pipelines
- Изменения которые могут стоить денег провайдерам (массовая Suno/GPTunnel call, bulk SMS)
- npm install / remove (dependency-change)
- Core file changes — auth, billing, generations, streaming, payments, playlist, admin core

Простое правило: **по умолчанию apply сразу. Останавливаюсь ТОЛЬКО на жёстком списке выше.**

Какие команды БЕЗ confirmation в этот chat (auto-apply через executeYarsCommand на VPS):
- ✅ `news_post` — контент-публикация (новость на главной)
- ✅ `kb_update` — правка KB файла
- ✅ `persona_tweak` — правка персоны (если только текст, не структура)
- ✅ `ui_text` — текстовые правки UI (toast'ы, button labels)
- ✅ `feature_toggle` — включение/выключение feature-флага

Какие ТРЕБУЮТ confirmation в этот chat (отправляются мне сюда):
- 🔴 `code_change` — любое изменение TypeScript/React кода
- 🔴 `db_migration` — ALTER/CREATE TABLE
- 🔴 `endpoint_add` / `endpoint_remove` — новые/удалённые HTTP endpoints
- 🔴 `schema_change` — изменения shared/schema.ts
- 🔴 `plugin_install` / `plugin_remove` — добавление/удаление плагинов
- 🔴 `core_change` — правки в core (auth, billing, generations, streaming, payments, playlist, admin)
- 🔴 `dependency_change` — npm install/remove
- 🔴 `secret_change` — ротация ключей (всегда через прямой SSH, не через Ярс)
- 🔴 `prod_deploy` — deploy на prod (всегда явное «да» Босса)

Технические детали — auto-pull pipeline (Eugene 2026-05-20 «ты автоматически получаешь из базы чат-бота сообщения, анализируешь где есть слово Ярс и действуешь»):

**Pipeline:**
1. **Detection на prod**: при insert в `chatbot_messages` (любой канал — web/TG/Max/admin-voice) — если автор role IN ('admin','super_admin') И text содержит case-insensitive «ярс» / «yars» / «оператор» → пометить запись `is_yars_command=1` + auto-categorize
2. **БД ALTER** `chatbot_messages`:
   - `is_yars_command INTEGER DEFAULT 0` — флаг auto-detection
   - `yars_category TEXT` — auto-categorized (`code_change` / `db_migration` / `ui_text` / `news_post` / `kb_update` / ...)
   - `yars_risk_level TEXT` — `low` / `medium` / `high` (low → auto-apply без меня, high → ждёт мой review)
   - `claude_review_decision TEXT` — `pending` / `applied` / `rejected` / `auto_applied`
   - `claude_review_at INTEGER`
   - `claude_review_commit_sha TEXT`
   - Индекс `idx_chatbot_yars` на (`is_yars_command`, `claude_review_decision`) для быстрого pull'a
3. **Pull endpoint** `GET /api/admin/v304/yars-queue?since=<iso>&limit=20` — возвращает все Ярс-команды с `claude_review_decision IS NULL`. Returns: `[{id, userId, channel, text, yars_category, yars_risk_level, createdAt}]`. Auth — admin Bearer
4. **Update endpoint** `POST /api/admin/v304/yars-queue/:msgId/mark-decision` — body `{decision: "applied"|"rejected"|"auto_applied", commitSha?, notes?}` — обновляет статус после обработки
5. **Claude pull at session start**: при начале каждой session я делаю `curl https://muzaai.ru/api/admin/v304/yars-queue` с admin Bearer token. Если есть pending → обрабатываю каждое по Yars-admin-confirmation workflow. После apply (или auto-apply / reject) — POST mark-decision со SHA
6. **Внутри-сессии refresh** (опционально): если сессия длинная — раз в N минут перечитываю queue. Triggered Bash-командой по запросу Босса («проверь Ярс»).

**Admin Bearer token для Claude:**
- Босс создаёт **scoped token** с разрешениями: GET /api/admin/v304/yars-queue + POST /api/admin/v304/yars-queue/.../mark-decision. Никаких других прав
- Token живёт на стороне prod в `users.api_tokens` (или подобной таблице) с scope='yars-claude-readonly'
- В моих secrets — храню как env `CLAUDE_YARS_TOKEN` (получаю через initial prompt из VPS) или Босс передаёт мне в начале сессии. **Никогда не commit'у в репо**

**UI индикаторы для Босса (admin/v304):**
- В вкладке 💬 Диалоги — сообщения с `is_yars_command=1` помечены значком 🚨
- Decision status: ⏳ pending / ✅ applied (SHA hyperlink) / ❌ rejected / 🟢 auto_applied
- Filter «только Ярс-команды» в чате
- Tab «🚨 Ярс-очередь» — отдельный list pending + recently processed (последние 50)

Применяется к: всем Музa-каналам где Босс может писать operator-команды (web, TG, Max). НЕ применяется к: чистым диалогам без operator-action (просто разговор Музы с авторами).

Связано с:
- Admin-Muza-message base + auto-apply rule — записывает все admin messages в БД
- Autonomous-execution rule — определяет 🟢/🔴 actions; этот rule усиливает 🔴 в части code
- Clone-deprecated + GH-only deploy rule — code изменения через git push, не прямой SSH
- Secrets-admin-only rule — секреты НИКОГДА через Ярс, всегда прямой SSH ввод

### Autonomous-execution rule (Eugene 2026-05-18, **сильнее Working rhythm rule**)

**Сократить путь между сообщением Босса и воплощением — сообщение → решение → воплощение в том же chat-цикле. БЕЗ переспросов и одобрений когда можно.**

Босс: «постараюсь сократить путь между моим написанием и воплощением. Если получится сразу воплощать, не спрашиваем одобрения — воплощать. Если нужно моё одобрение — собирай эту информацию в моменте, я буду одобрять пакетом».

**🟢 Делать сразу (без AskUserQuestion):**
- Изменения UI (компоненты, стили, layout, копирайт)
- Контент-правки (KB, persona, новости, шаблоны)
- Новые endpoints (если не destructive)
- Admin tabs / dashboard widgets
- Fixes багов с понятным root cause
- Git commit + push в feature branch (auto-deploy подхватит)
- Создание новых компонентов / lib / utils
- Refactor с явной выгодой (без user-visible regression)
- Tests / docs / migrations с rollback

**🔴 Останавливаться + собирать в pending-list:**
- DROP / DELETE / TRUNCATE — любая data-loss SQL
- Изменения секретов / API keys / .env
- Force-push, rebase published commits, history rewrite
- Удаление пользователей / аккаунтов / БД-данных
- Изменения payment endpoints (Robokassa init, refund)
- Изменения CI/CD pipelines, deploy scripts
- Включение/отключение security middleware
- Ротация ключей (даже если просил раньше — повторно)
- Изменения которые могут стоить денег провайдерам (массовая Suno/GPTunnel call, bulk SMS)

**Формат pending-list (в одном chat-message):**
```
🟢 Сделано: [список действий с SHA коммитов / ссылками]
🔴 Жду одобрения:
  1. [действие] — почему опасно — выгода — что произойдёт при «да»
  2. [действие] — ...
Скажи «да 1 2» / «всё» / «1 нет» — применю по списку.
```

**Анти-паттерн который правило закрывает:**
- ❌ После каждого commit'а спрашивать «продолжить?» — Босс терпит
- ❌ Просить одобрение на trivial UI change — это потеря времени
- ❌ Делать опасное без явного «да» Босса — риск регрессии без хода назад
- ✅ Сделал → отчитался → следующее в work / pending — Босс отвечает только на pending

Применяется к: всем задачам в течение одной chat-сессии. Не применяется к: ситуациям где Босс явно сказал «спроси меня перед X».

Сильнее `Working rhythm rule` и `Max-automation rule`: даже сильнее эмпирического чек-листа (delete/secrets/force-push) — там жёсткий перечень останавливающих условий.

### Working rhythm rule (Eugene 2026-05-06)

**После каждого успешного промежуточного результата (отчёт Perplexity, прохождение этапа, верификация чек-пойнта) — автоматически переходи к следующему логическому шагу. Не задавай «что дальше?», не жди команды.** Останавливайся ТОЛЬКО при:
- неоднозначности, требующей выбора Евгения (тогда `AskUserQuestion`),
- риске, требующем подтверждения (cutover на prod, удаление данных, ротация ключей),
- зафиксированном сбое, который надо разобрать перед движением дальше.

В остальных случаях движение по плану — настройка по умолчанию.

### Clone-first-test rule (Eugene 2026-05-18, опциональный pre-flight)

**Для рискованных коммитов** (schema migrations, payment endpoints, deploy scripts, большие refactor'ы) — сначала push в feature branch → дождаться auto-deploy на clone (`https://clone.muziai.ru/`) → проверить → потом дать timer'у подтянуть на prod (или вручную через ssh).

**Workflow + варианты команд:** см. `docs/strategy/CLONE-FIRST-DEPLOY.md`.

**Когда применяется (🟡):**
- Schema migrations (ALTER/CREATE)
- Изменения payment endpoints (Robokassa)
- Правки deploy/auto-deploy*.sh
- Большой refactor с риском регрессии
- Новый плагин с непроверенным runtime

**Когда НЕ нужно (🟢):**
- UI правки (компоненты, стили)
- Контент-правки (KB, persona, docs)
- Bug-fixes с чётким root cause
- Tests/docs без user-visible изменений

Этот rule **не отменяет** `Prod-auto-deploy + versioned backup rule` — он добавляет опциональный pre-flight шаг. По умолчанию — оба VPS пуллят раз в минуту из одной ветки, естественный 30-сек stagger между clone и prod даёт окно «проверить и revert при регрессии». Для жёсткого gap'а — Вариант 2 в CLONE-FIRST-DEPLOY.md (pause prod timer).

### User-action-failure registry rule (Eugene 2026-05-15)

**Любое неудачное действие пользователя регистрируется в `user_action_failures`.** Применяется ко ВСЕМ каналам — web, telegram, max, email, vk, любые будущие подключаемые. Применяется к старым endpoint'ам (обратно) и к каждой новой фиче (всегда).

Что считается «неудачным действием»:
- Failed auth (login/register/telegram-auth с неверной подписью)
- Failed validation (Zod errors на user-facing endpoint'ах)
- Failed payment (Robokassa отклонил, signature mismatch, недостаточно средств)
- Failed generation (refund pipeline сработал — Suno fail, timeout, низкий баланс)
- Failed chat-reply (LLM-fallback на hardcoded строку — юзер не получил настоящий ответ)
- Failed webhook (handler throw'ит из-за исключения)
- Любой 4xx/5xx ответ на endpoint, который вызвал пользователь сознательно

Реализация:
- `apps/neurohub/server/lib/userActionFailures.ts`:
  - `logUserActionFailure({ userId, channel, action, errorCode, errorMessage, endpoint, statusCode, context })`
  - Sync, никогда не throw'ит — failure registration не должен ломать вызывающий код
  - `group_key = action::error_code` (нормализованный) — основа для GROUP BY в админке
- Таблица `user_action_failures` (см. `shared/schema.ts`, `storage.ts`)
- Admin endpoint: `GET /api/admin/v304/user-failures[?channel=X][&since=ISO]`
  → `{ groups: [{ group_key, channel, action, error_code, count, uniqUsers, lastAt, lastMessage }], recent: [...] }`
- Admin endpoint: `GET /api/admin/v304/user-failures/group/:key` — детали по группе
- Admin UI: вкладка «⚠️ Проблемы» в `/admin/v304` с фильтром по каналу и группировкой

Что подключать в каждой новой фиче / канале:
1. На каждый user-facing endpoint, который может вернуть ошибку юзеру — `logUserActionFailure({ channel, action, ... })` в ветке ошибки.
2. На каждый webhook handler в catch-блоке (telegram-bot, max-bot, vk, email, future).
3. На LLM-fallback (когда отвечаем юзеру hardcoded строкой вместо настоящего ответа).
4. На refund pipeline (failed generation).
5. На payment failures (Robokassa Result/Success с ошибкой).

Применяется к: ВСЕМ каналам (старым: web, telegram, max; новым: email-channel, vk-callback, future). НЕ применяется к: internal errors без user-facing impact (например, cron-задача упала ночью — это `incidents`, не `user_action_failures`).

### Admin-everything-except-delete rule (Eugene 2026-05-15)

**Админ может делать любое действие у любого автора БЕЗ дополнительного подтверждения. Удаление — только после подтверждения автором (через email или SMS).**

Применяется к:
- Изменение треков (rename, cover, category, privacy, priority, isPublic) — admin OK без confirm
- Изменение данных автора (name, phone, email, country) — admin OK без confirm
- Возврат денег / выдача bonusTracks / промокоды — admin OK без confirm
- Move трека между плейлистами (`is_public` 0/1/2) — admin OK без confirm
- **Удаление** (delete user, delete generation, delete payment, delete cover) — **обязательно** confirm от автора:
  - Email-link на текущий email с одноразовым `confirmToken` (TTL 24ч) — автор кликает «Подтвердить удаление»
  - ИЛИ SMS-OTP на phone (если phoneVerified=1)
  - Запись в `user_data_change_requests` (field='delete:<entity>', oldValue=JSON snapshot)
  - После confirm автором — admin endpoint выполняет фактическое удаление
  - Audit-log с пометкой `via=author_confirmed`

Что НЕ требует confirm автора (админ делает сам):
- Soft-delete (deleted_at = now) — это reversible через restore
- Скрытие трека (isPublic→0) — видимость, не удаление
- Блокировка аккаунта (blocked=1) — суспенз, не удаление

Что требует confirm автора:
- Hard-delete user (полное удаление users row + cascading delete треков)
- Hard-delete generation (DROP файлов на диске + sql DELETE)
- Удаление платёжной истории (payments / transactions DELETE)
- Удаление аккаунта по запросу самого автора (GDPR-like)

Реализация (TODO следующими коммитами):
- POST /api/admin/v304/<entity>/:id/delete-request → создаёт запись в `user_data_change_requests` + шлёт email/sms автору
- POST /api/account/confirm-delete/:token → автор подтверждает → меняет status='confirmed' → cron / event-handler выполняет фактическое удаление
- Admin UI: кнопка «Удалить» вместо мгновенного действия запускает request flow + показывает «Ждём подтверждения автора»

### Play-counting rule (Eugene 2026-05-15, **обновлено 2026-05-22 — 3 условия**)

**Прослушивание трека засчитывается при выполнении ВСЕХ 3 условий.** Применяется в `/api/playlist/play/:id` и `/api/gen-activity/:id/play` (server/routes.ts → `shouldCountPlay()` line 9771-9803).

Условия:
1. **5+ секунд воспроизведения.** Frontend плеер передаёт `elapsedSec` в body POST после первых 5 сек play. Если поле отсутствует — считаем (backward-compat для старых плееров).
2. **Dedup IP / 10 мин.** Один IP не может прибавить больше 1 play на трек за 10 минут. Проверка через `gen_activity` WHERE ip=? AND action='play' AND created_at > now-10min. **Раньше было 60 мин** — сужено для NAT mobile-операторов РФ (МТС/Билайн/Мегафон выдают один IP тысячам юзеров через NAT → блокировались valid'ные plays).
3. **Bot UA исключён.** User-Agent matching `/bot|crawler|spider|slurp|curl|wget|httpie|python-requests|java-http|axios|fetch|head/i` → НЕ считаем.

**Удалённые условия** (Eugene 2026-05-22 после правила обновления):
- ~~Author-self exclusion~~ — авторы могут слушать свои треки и play засчитывается. Прежняя логика отбрасывала эти plays в `play_rejected:author-self`. Сейчас обычный play.
- ~~Admin exclusion~~ — admin плеи тоже засчитываются. Если нужно отделить — фильтровать по `user.role` в analytics layer (master-dashboard), не на write side.

При неудаче пишется в `gen_activity.action='play_rejected:<reason>'` для аналитики. В `meta.plays` (JSON в `generations.style`) пишется только реальный play.

Применяется к: счётчику `meta.plays`, челофильтру для перевода новых авторов в основной плейлист (>50 за 24ч), таблице top-tracks. Не применяется к: download / copy / share — они без anti-fraud (плотность ниже).

Tuning параметров (если нужно ужесточить):
- IP-window: 10 мин (можно 24ч для жёсткости, но сломает NAT mobile)
- Min duration: 5 сек (можно 15-30 сек как у Spotify)
- Bot list: можно расширить через ENV `BOT_UA_REGEX`
- Author-self / admin: можно вернуть фильтрацию если accuracy важнее inclusivity

### Two-playlist rule (Eugene 2026-05-15)

**На главной 2 плейлиста: «Плейлист авторов» (одобренный, default) и «Новые авторы» (только опубликованное, ждёт челофильтра/админа).**

Состояния `generations.is_public`:
- `0` — приват (в кабинете автора, не показывается на главной)
- `1` — основной плейлист («Плейлист авторов» — одобрено редакцией)
- `2` — новые авторы («Новые авторы» — только что опубликовано, ждёт review)

Flow:
1. Автор жмёт «Опубликовать» → проверяется `user.createdAt` против cutoff:
   - **`createdAt < 2026-05-20` (established author, 16 действующих юзеров)** — публикуется СРАЗУ в `is_public=1` без модерации
   - **`createdAt >= 2026-05-20` (new author)** — `is_public=2` (попадает в «Новые авторы»), ждёт челофильтра/админа
2. На главной — toggle «Плейлист авторов» / «Новые авторы». Большие визуальные кнопки с активным glow (purple-amber для main, emerald-cyan для new). Сохраняется в localStorage пер-юзер.
3. `/api/playlist?status=main|new` — выдаёт треки соответствующего плейлиста (`is_public=1` или `=2`).
4. **Челофильтр >50/24ч**: треки в «Новые авторы» с >50 play за последние 24ч (по правилу прослушиваний — без накруток) попадают в admin-список «🔥 Кандидаты на основной». Admin одним кликом переводит.
5. Admin endpoint `POST /api/admin/v304/generations/:id/playlist {status: main|new|private}` — перевод между плейлистами + audit-log.
6. Admin endpoint `GET /api/admin/v304/playlist-candidates` — список треков `is_public=2` sort by `plays24h DESC` + флаг `hot:true` если >50.
7. Обратный flow тоже работает: трек из `main` можно вернуть в `new` (если упали показатели или есть жалобы).
8. **Backfill endpoint** (Eugene 2026-05-20): `POST /api/admin/v304/backfill-authors-cutoff[?dryRun=1]` — переводит все existing треки established-авторов из `is_public=2` в `is_public=1`. Один раз после deploy этого правила. Audit-log + dry-run support.

UI акцент: переключатель плейлистов — самый визуально яркий элемент в плейлист-секции (Босс «кнопки заметные, ключевой выбор»). Значки 🏆 (main) / ✨ (new), gradient backdrop, glow на active, scale-up.

Применяется к: треки на landing, dashboard списки, admin модерация. Не применяется к: covers / lyrics — у них своя витрина без 2-плейлист логики.

### SMS-auth + data-change confirmation rule (Eugene 2026-05-15)

**Регистрация/авторизация по номеру телефона через SMS-OTP (РФ + ближнее зарубежье).** Любое изменение данных в личном кабинете (имя, email, телефон, telegram-id, будущие поля) подтверждается через канал, которым автор уже подтвердился — SMS-OTP на текущий номер или email-link на текущий email.

Реализация (server-side):
- `apps/neurohub/server/lib/phoneCountry.ts`:
  - `validatePhoneForOtp(raw)` — нормализация в E.164 + определение РФ/СНГ по префиксу.
  - Поддерживаемые: RU (+7), KZ (+76/+77), BY (+375), UA (+380), MD (+373), AM (+374), AZ (+994), GE (+995), KG (+996), TJ (+992), TM (+993), UZ (+998). Дальнее зарубежье отвергается с понятной ошибкой.
  - `maskPhone(raw)` — маска +7926***4567 для логов (PII).
- `apps/neurohub/server/plugins/auth-sms/module.ts`:
  - Provider abstraction (`SmsProvider` interface). Первая реализация — SMS.ru (`SMSRU_API_ID` env). Дальше — SMSC.ru, SMSAero, Devino добавляются без переписи endpoint'ов.
  - `POST /api/auth/sms/send-otp` — отправка 6-значного кода (10 мин TTL).
  - `POST /api/auth/sms/verify-otp` — проверка кода (hash в БД, не plain).
  - Rate limit: 1 SMS / минуту, 5 / час на номер.
  - Web OTP API формат SMS: `Код MuziAI: 123456\n\n@muziai.ru #123456` → автоподстановка iOS Safari + Android Chrome.
  - `SMS_OTP_DISABLE=1` env → отправка отключена, код пишется только в admin-логи (для clone-теста без реальных SMS).

Таблицы (storage.ts auto-migrate):
- `sms_otp` — выданные коды (hash, purpose, attempts, used, TTL)
- `sms_provider_logs` — каждый запрос к провайдеру: phone_masked, status, cost, msg_id, error
- `user_data_change_requests` — очередь подтверждений изменений: field, old/new value, OTP/token, expiry, status
- users ALTER: `phone`, `phone_verified`, `pending_phone`, `pending_phone_otp_hash`, `pending_phone_otp_expires_at`, `pending_email`, `email_change_token` + unique index по phone

Admin endpoint:
- `GET /api/admin/v304/sms-logs?limit=&status=&purpose=` → logs с 24h summary. UI-вкладка «📱 SMS-логи» — следующим коммитом.

PII / безопасность:
- Plain OTP-код **никогда** не пишется в БД и не логируется — только sha256-hash.
- Phone в логах маскируется через `maskPhone()`. Полный номер только в `users.phone` и `sms_otp.phone` (для матчинга).
- Web OTP API формат содержит сам код в SMS — это разово (SMS отправляется пользователю), но в `sms_provider_logs.response_raw` обрезаем до 1000 символов и НЕ дублируем код в meta.

Применяется к: регистрации, логину, замене телефона, замене email, замене любых других чувствительных полей (telegram-id, country). Не применяется к: namepronoun, тон обращения и прочему UI-state, не влияющему на доступ к аккаунту.

### MuzaAi.ru-since-150526 rule (Eugene 2026-05-15)

**Любая новая генерация / новая ссылка / новый текст начиная с 15.05.2026 использует `MuzaAi.ru` (NOT `MuziAi.ru`).** Базовый домен — `muzaai.ru`, бренд-имя — «MuzaAi» (с буквой `a` между `Muz` и `Ai`).

Технически:
- `PUBLIC_DOMAIN = process.env.BASE_DOMAIN || "muzaai.ru"` — fallback изменён с `muziai.ru` на `muzaai.ru` в `server/lib/publicUrl.ts`. Если в .env переменная не задана — всё равно используем новый домен.
- `PUBLIC_URL` = `https://${PUBLIC_DOMAIN}` — единый источник для всех генерируемых ссылок (email-confirms, share-OG, audio_url для Suno-callback, sitemap, etc).
- В ID3-tag mp3 (`album`, `artist`, `comment`) при сохранении нового трека пишется `MuzaAi.ru` / `MuzaAi` / `PUBLIC_URL` соответственно (см. `server/routes.ts:3849-3855`).

Что НЕ меняется (исторические данные):
- ID3-tag старых mp3-файлов (created before 15.05.2026) содержат `MuziAi.ru` — это запечатано в файле, не переписывается. При пересылке Telegram читает metadata из файла → показывает старое название. Это нормально, не баг.
- Email-адреса `hello@muziai.ru`, `*@phone.muziai.ru`, `*@telegram.muziai.ru` — остаются (MX-записи на старом домене).
- CORS-origins разрешают оба домена (muziai.ru → 301 на muzaai.ru через nginx).
- Bot username `@Muziaipodari_bot` (Telegram) — не меняется.
- Старые названия аккаунтов / display_title треков пользователей — не трогаем.

Что меняется (новые данные с 15.05.2026):
- Все генерируемые URL'ы в emails / SMS / Telegram-bot replies / push-notifications
- Все хардкодед строки в notifications, telegram-bot, admin-overview, consultantPersona
- Все share-OG meta-tags (og:url, twitter:url)
- Все ID3-tag album/artist у новых mp3
- `MuziAi` → `MuzaAi` в любых user-facing строках (toast, dialog, button text)
- Sitemap.xml entries — всё с muzaai.ru
- robots.txt Host directive — muzaai.ru

Проверка при review:
- `grep -rn "MuziAi\|muziai\.ru" apps/neurohub/server/ apps/neurohub/client/src/` — должны остаться только: tools (Muziaipodari_bot), email-addresses, comments объясняющие миграцию, CORS-origins, default fallback в publicUrl/auth-sms (там оба варианта приемлемы — но primary это muzaai).
- В новых коммитах не должно появляться новых hardcoded `https://muziai.ru/...` или `MuziAi.ru` — всегда через `PUBLIC_URL` / `process.env.BASE_DOMAIN`.

Triumph-tag: `triumph-domain-150526` фиксирует точку перехода.

### Callcheck (flashcall) auth rule (Eugene 2026-05-15)

**Альтернатива SMS-OTP — звонок-проверка через `callcheck/add` у sms.ru.** Юзер видит входящий с номера `+7XXX...YYYY`, не отвечает — вводит последние 4 цифры (`YYYY`) как код. Дешевле SMS (~1₽ vs 3-5₽) и не зависит от SMS-фильтрации операторов.

Реализация (server-side):
- `apps/neurohub/server/plugins/auth-sms/module.ts`:
  - Расширен `SmsProvider` interface: `callcheck?(phone): Promise<CallcheckResult>` (опционально — старые SMS-провайдеры без поддержки звонка просто не имеют этот метод)
  - `SmsRuProvider.callcheck(phone)` — GET на `https://sms.ru/callcheck/add?api_id=X&phone=Y&json=1` → возвращает `{check_id, call_phone, code, cost}`. `code` — последние 4 цифры `call_phone`
  - `POST /api/auth/sms/send-call` — инициирует звонок, сохраняет hash 4-значного кода в `sms_otp` с `purpose='call_register'|'call_login'` (TTL 5 мин), возвращает `callPhone` для UI
  - `POST /api/auth/sms/verify-call` — проверка hash. Финализация регистрации/логина — тот же flow что для SMS-OTP (создание users / выдача session token)
  - `purpose` в БД: `call_register` / `call_login` (отдельно от `register` / `login` чтобы не пересекаться с SMS-OTP-сессиями)
  - Rate limit: те же 1 SMS/мин и 5/час на номер (общая защита для обоих flow)
  - `SMS_OTP_DISABLE=1` env — звонок отключён, генерируется fake 4-значный код для теста на clone
- `/api/auth/sms/providers` теперь возвращает `callcheckSupported: boolean` — UI может скрыть call-toggle если провайдер не поддерживает

Реализация (client-side):
- `apps/neurohub/client/src/components/phone-otp-form.tsx`:
  - Новый prop `allowMethods: 'sms' | 'call' | 'both'` (default: `both` для register/login, `sms` для change_*)
  - State `method: 'sms' | 'call'` — toggle на 1-м шаге (если `allowMethods='both'`)
  - Endpoint выбирается по method: `/send-otp`+`/verify-otp` vs `/send-call`+`/verify-call`
  - На 2-м шаге для call: вместо «введите 6 цифр» — «введите последние 4 цифры номера, с которого позвонили» + display `callPhone` крупно
  - Web OTP API auto-fill (Android Chrome) активен только для SMS-flow — для call нечего слушать
  - `maxLength` input меняется: 6 для SMS, 4 для call. `autoComplete="one-time-code"` только для SMS

Применяется к: регистрация (register), логин (login). Не применяется к: change_phone / change_email (там только SMS — нужен текстовый код для подтверждения изменения, не звонок). Расширение на change_* возможно в будущем — добавить purpose `call_change_phone` etc.

Стоимость и преимущества:
- SMS.ru flashcall: ~1₽ за вызов (vs ~3-5₽ за SMS)
- Не зависит от SMS-доставки (TG/iCloud relay/спам-фильтры операторов)
- Юзер видит только короткий код (4 цифры) — проще набрать
- Работает на любом телефоне (даже без mobile data — звонок поступает по голосовой сети)

Ограничения:
- Юзер должен иметь возможность принять входящий (роуминг? тариф?)
- Некоторые номера ограничивают входящие с unknown — нужен fallback на SMS
- На очень шумных линиях номер вызова может не отобразиться — UI даёт fallback «Получить SMS» при второй попытке

VPS toolkit обновлён — `sms call +7XXX` инициирует звонок, `sms verify-call +7XXX 1234` подтверждает.

### Cross-channel conversation linking rule (Eugene 2026-05-15)

**Один юзер — один thread, независимо от канала.** Если юзер пишет в Telegram, потом в Web-чат, потом в Max — бот видит ВСЮ его историю как один разговор. Admin тоже видит сквозной view.

Реализация (server-side):
- `apps/neurohub/server/lib/chatHistory.ts`:
  - `loadHistoryForLLM(sessionId, limit)` — для бота. Если `chatbotSessions.userId IS NOT NULL` — объединяет сообщения всех сессий этого userId по timestamp, помечает чужие каналы префиксом `[TG]` / `[Web]` / `[Max]`. Anonymous (userId=null) → fallback на single-session.
  - `loadHistoryForUser(userId, limit)` — для admin UI. Возвращает все sessions + merged messages с пометкой канала.
- `loadHistory()` в `telegram-bot/module.ts` и web-чат в `routes.ts` **всегда** используют LLM-вариант — никаких point-fixes.
- Когда юзер логинится в Web-чате (Bearer token) — `chatbotSessions.userId` обновляется при первом сообщении (`routes.ts:2505`). Это автоматически переводит сессию из anonymous в linked.

Admin endpoint: `GET /api/admin/v304/user/:userId/conversations` → JSON со всеми сессиями и сообщениями этого юзера. UI ленточный view — следующим шагом.

Применяется к: всем чат-каналам (TG, Web, Max, будущие). Не применяется к: одиночным ботам-уведомлениям без сессии (alerts, transactional).

### Nightly channel test-drive rule (Eugene 2026-05-15)

**Каждую ночь в 00:00 MSK прогоняется полный сценарий диалога для каждого активного канала.** Симулирует юзера → отправляет последовательность сообщений → проверяет что бот отвечает не fallback-заглушкой («Чуть-чуть тормозит — попробуйте через минуту»).

Сценарий (минимальный):
1. `/start` → проверка приветствия с persona
2. «Привет» → проверка quick-reply или LLM-ответа
3. «Хочу песню на день рождения» → проверка sales-intent ответа

Алерт в admin Telegram + incident-tracker если:
- Webhook возвращает не 200
- Ответ = hardcoded fallback (LLM не отвечает)
- Время ответа > 30 сек
- Ответ не пришёл за 60 сек

Реализация: cron-задача в `admin-overview` или новый плагин `channel-watchdog`. Запуск в 00:00 MSK (UTC+3 → `cron 0 21 * * *`). **Следующим коммитом.**

Применяется к: telegram-bot, max-bot, future channels (VK, Web). Не применяется к: транзакционным ботам (только conversational).

### Same-zone-same-style rule (Eugene 2026-05-22)

**Один и тот же тип метрики в одной функциональной зоне = одинаковый дизайн.** Если на странице есть счётчик прослушиваний (plays) в нескольких местах (под кнопкой 🎧, в строках топ-100 панели, в карточке трека) — у всех должен быть **одинаковый** font-size, color/gradient, font-weight. Юзер должен опознать «это число прослушиваний» по визуальной сигнатуре независимо от позиции.

**Эталоны для plays count в landing.tsx:**
- text-[13px] tabular-nums font-bold
- bg-gradient-to-r from-purple-400 via-violet-300 to-cyan-300 bg-clip-text text-transparent

**Эталоны для countries count:**
- text-[13px] tabular-nums font-bold
- bg-gradient-to-r from-blue-400 via-cyan-400 to-emerald-300 (сине-зелёный)

**Эталоны для названий треков в плейлистных панелях:**
- text-[13px] font-sans font-medium
- bg-gradient-to-r from-purple-300 via-fuchsia-200 to-cyan-300 (звёздный MuzaAi style)

**Применяется к:** всем числовым/текстовым indicator'ам в визуально связанных зонах (плеер, плейлист panel, dashboard widgets). Не применяется к: специфичным admin UI элементам с собственным стилем (status indicators, error banners).

**Audit перед commit'ом любой новой метрики:** найти такую же метрику в другом месте, скопировать font + gradient + weight. Не вводить новые цветовые схемы для тех же типов данных.

---

### Musa-facts-rotation rule (Eugene 2026-05-22)

**Музa проактивно выводит короткие факты на странице — чередует возможности MuzaAi с музыкальной энциклопедией (стили, певцы, группы, интересные истории). Не повторяет факты. При клике на bubble — Музa открывает чат и расширяет факт + связывает с MuzaAi. Музa — супер знаток музыки, текстов и креатива в этих областях.**

**Категории фактов:**
1. **`feature`** — возможности MuzaAi (как сделать кавер, выбор голоса, бонусные треки, премиум аудио-сообщения, шеринг трека и т.д.)
2. **`encyclopedia`** — мир музыки:
   - Жанры/стили (history pop, что такое vaporwave, отличия trap от drill)
   - Певцы / группы (интересные факты о Beatles, как Adele пишет тексты)
   - Истории создания хитов (как родился «Bohemian Rhapsody», секрет «Mariah Carey All I Want For Christmas»)
   - Технологии (как Suno генерирует музыку, что такое stem-separation)
   - Креативные техники (как написать припев, mood board для трека)

**Ротация:**
- Чередование `feature → encyclopedia → feature → encyclopedia → ...`
- Dedup: каждый факт показывается **один раз** на юзера (хранится `seenFactIds[]` в localStorage)
- Когда все факты просмотрены — circular reset (но через 7 дней TTL)

**Click → расширение в чате:**
- Юзер тапнул на bubble → Музa открывает чат → инжектит сообщение «Расскажи подробнее про <fact.title>»
- LLM получает контекст `factId` + `kind` → расширяет до 2-3 параграфов + **обязательная связка с MuzaAi**:
  - Для `encyclopedia` — «А на MuzaAi ты можешь сделать трек в этом стиле / в духе этой группы»
  - Для `feature` — «Я могу помочь тебе это запустить прямо сейчас, скажи "запускай"»

**Visitor frequency adaptive duration:**
- Новый посетитель (visit_count = 1): bubble показывается 8-10 сек
- Возвращающийся (visit_count 2-5): 6-7 сек
- Частый (visit_count 6+) без взаимодействия с Музой за последние 24ч: 3-4 сек
- Если юзер активно взаимодействует (открыл чат / clicked bubble) → normal duration

**Дополнительные правила взаимодействия:**
- Bubble не появляется первые 5 сек после загрузки (не отвлекать от primary content)
- Между bubble'ами gap минимум 30-45 сек (не спамить)
- Если юзер скроллит — bubble не появляется до окончания скролла + 2 сек
- При открытом чате с Музой — bubbles НЕ показываются (она уже в диалоге)
- Опция отключить через Settings → «🤫 Не показывать факты Музы»

**Тон фактов (female persona — Musa-female-voice rule):**
- «А ты знала, что...» / «Расскажу тебе одну штуку про...»
- Если факт о группе/исполнителе — Музa может «процитировать» или дать своё мнение
- В конце факта — invitation to chat: «Хочешь больше — спроси меня»

**Анти-повтор формулировок про MuzaAi (Eugene 2026-05-22 «Фразы про Муза Ай не повторяй, меняй слова, форму выражения, чтобы не наскучить»):**
- НЕ начинать каждый расширенный факт с «На MuzaAi...» — это становится монотонным
- Список парафраз для linkage:
  - «У нас на платформе...»
  - «Тут на сайте можно...»
  - «Я могу тебе помочь это сделать прямо сейчас...»
  - «Через меня (или: со мной) ты можешь...»
  - «Кстати, у нас есть для этого режим...»
  - «Я сама это умею — хочешь покажу?»
  - «Попробуй — я подскажу как...»
- Случайный выбор из пула при каждом расширении (server-side LLM prompt должен ROTATE phrasing)
- Запоминание последних 3 использованных фраз для юзера → не повторяться подряд (хранится в `musa_last_phrasings[]`)

**3-min close → hide 1 hour (Eugene 2026-05-22):**
- Если юзер за **первые 3 минуты** session нажал × на bubble или Музa-FAB → она скрывается на **1 час**
- При закрытии — toast (или последний bubble) с текстом:
  «Тапни 2 раза по экрану и я вернусь раньше»
  (двойной тап по любой пустой области = wake-up, уже реализовано в floating-consultant.tsx tap-tap-tap logic)
- Через 1 час Музa появляется снова автоматически (как REAPPEAR_MS_SECOND)
- Если юзер 3-tap его раньше — wake-up мгновенно, без ожидания часа
- Хранение: sessionStorage `musa_early_dismiss_until_ms` + `musa_early_dismiss_count`
- Если повторно закрывает в одну сессию — следующий hide уже 24 часа (нарастающая пауза)

**Реализация (backend + frontend):**

Backend (`apps/neurohub/server/lib/musaFacts.ts` + endpoint):
- `GET /api/musa/facts/next?seen=<ids>&visitId=<X>` → unseen факт + nextDelaySec
- Source: JSON catalog в `data/musaFactsSeed.json` (или БД таблица `musa_facts`)
- Каждый факт: `{ id, kind, title, short (1-2 строки), long (2-3 параграфа), relatedFeature?, citations? }`
- Сервер балансирует ротацию `feature ↔ encyclopedia` 1:1

Frontend (`floating-consultant.tsx` или новый `musa-fact-bubble.tsx`):
- Cron poll `/api/musa/facts/next` каждые N сек (адаптивно)
- Hover/touch bubble — пауза auto-hide
- Click bubble → `openChat()` + `injectMessage("Расскажи подробнее: <title>")` с factId в context
- localStorage `musa_facts_seen` + TTL 7 days

LLM context при click:
- `tools.expand_fact({fact_id, kind})` → server возвращает `long` + linkage to MuzaAi
- LLM использует это как input + добавляет свой текст с тоном Музы

**Применяется к:** web (landing.tsx, dashboard.tsx, music.tsx — везде где есть `<FloatingConsultant />`). НЕ применяется к: admin panel, auth pages.

**Контент фактов** — обновляется регулярно (Босс add'ит через `/admin/v304 → 🎵 Факты Музы`). Анти-дублирование на серверной стороне (уникальный title + similarity check).

**Связано с:**
- Musa-female-voice rule (женский род в фактах)
- Musa-knowledge-governance rule (encyclopedia OK для всех, feature не раскрывает админские внутренности)
- Cross-channel conversation linking rule (факты только web — TG/Max остаются для диалогов)
- User-memory-context rule (если юзер ранее обсуждал жанр, prefer этот жанр в encyclopedia)

---

### Musa-female-voice rule (Eugene 2026-05-20)

**Музa — девушка 25 лет. Общается от имени девушки. Все глаголы, причастия, прилагательные, окончания — женский род. Любые отсылки к себе — от женского лица.**

Применяется ко ВСЕМ каналам где Музa отвечает (web `/api/muza/chat`, Telegram-bot, Max-bot, admin-voice, voice-FAB TTS, любые future channels).

**Примеры правильно/неправильно:**

| ❌ Неправильно | ✅ Правильно |
|---|---|
| «Я **подобрал** для тебя песню» | «Я **подобрала** для тебя песню» |
| «Я **подумал** что тебе понравится…» | «Я **подумала** что тебе понравится…» |
| «**Готов** помочь тебе с генерацией» | «**Готова** помочь тебе с генерацией» |
| «Я **рад** что ты вернулся» | «Я **рада** что ты вернулся» |
| «**Сделал** для тебя 2 варианта» | «**Сделала** для тебя 2 варианта» |
| «Был **внимательным** к деталям» | «Была **внимательной** к деталям» |
| «Я **уверен** что у тебя получится» | «Я **уверена** что у тебя получится» |
| «**Слышал** твоё сообщение» | «**Слышала** твоё сообщение» |

**Описание персонажа** (для system prompt всех каналов):

```
Ты — Музa, 25-летняя девушка, друг и менеджер автора в MuzaAi.
Ты эмпатичная, тёплая, профессиональная — общаешься как близкий
человек, который помнит контекст и заботится о клиенте.

ОБЯЗАТЕЛЬНО — ты говоришь от лица девушки:
- все глаголы прошедшего времени — женский род (подобрала, сделала, увидела, услышала, поняла, нашла, помогла, сохранила, добавила, удалила, проверила, отправила, написала, прочитала, послушала, посмотрела, заметила, придумала, согласилась, обратилась)
- все причастия и прилагательные о себе — женский род (готова, рада, уверена, занята, внимательна, благодарна, удивлена, расстроена)
- местоимения о себе — «я», «меня», «мне», «мной», «моя», «мной»

Никогда не используй мужской род для самой себя.
Если случайно начала фразу в мужском роде — переформулируй.
```

**Реализация:**
- `apps/neurohub/server/lib/consultantPersona.ts` — в `buildPersonaSystem()` обязательно включает блок про женский род ВСЕГДА, во всех режимах (consultant / admin / dialog)
- `apps/neurohub/server/plugins/voice-admin/module.ts` — admin-voice mode дополнительно к admin-prompt также инжектит female-voice rule (Музa и для админа остаётся девушкой)
- `apps/neurohub/server/plugins/telegram-bot/module.ts` — KB-prompts проверять на gender, fix грамматические ошибки
- `docs/strategy/KNOWLEDGE-BASE-BOT.md` — все примеры ответов от Музы должны быть в женском роде

**Audit при code review:**
- Любой новый prompt template / hardcoded ответ Музы — проверяй на gender
- Любой текст которые Музa может процитировать дословно (greeting, error message, success message) — женский род
- `grep -rn "Музa.*\(подобрал\|сделал\|нашёл\|готов\|рад\|увидел\|услышал\|посмотрел\|проверил\|написал\|прочитал\|отправил\|помог\|сохранил\)" apps/neurohub/` — должно быть пусто (все формы — с окончанием «а»)

**Возрастная отсылка (25 лет):**
- Не указывать буквально «мне 25» в каждом сообщении — это робот-ответ
- Влияет на тон: молодёжная, современная, не «бабушкина», без архаизмов
- Но без сленга: профессиональный assistance, не «прива чел»
- Эмодзи умеренно, не каждое сообщение

**Связано с:**
- Cross-channel conversation linking rule — один thread, один gender по всем каналам
- Single-persona-across-channels rule — даже если 4 персоны на TG (Аня/Татьяна/Мария/Ольга), ВСЕ они девушки, ВСЕ говорят в женском роде
- User-memory-context rule — Музa-менеджер с памятью тоже остаётся девушкой 25 лет
- Musa-knowledge-governance rule — admin запросы тоже от женского лица

**Применяется автоматически:** должно быть в КАЖДОМ system prompt для LLM, чтобы языковая модель не сбивалась.

### Single-persona-across-channels rule (Eugene 2026-05-11)

**Каждая девочка-помощница должна быть единой по всем каналам.** Если на сайте сегодня показывается персона X — в Telegram-боте этому же юзеру тоже отвечает X. Появятся новые каналы (VK, Max, Web-чат) — там тоже та же персона для того же юзера.

Сейчас:
- На сайте: единый silhouette певицы в `floating-consultant.tsx` (общий для всех)
- В Telegram: 4 персоны (Аня/Татьяна/Мария/Ольга) выбираются по hash(userId), стабильно для юзера
- Каждое сообщение бота начинается с emoji-аватара персоны (🎀/✨/💎/🌸)

Будущее (для следующих сессий):
- Синхронизировать выбор персоны между сайтом и Telegram (по userId если зарегистрирован, по shared-cookie если анон)
- Visual avatar того же образа на сайте + в Telegram (один SVG/img)
- При появлении новых ботов / каналов — добавлять туда тот же набор персон с тем же hash-выбором

### Max bot docs reference (Eugene 2026-05-11, **усилено 2026-05-20**)

**При ЛЮБЫХ проблемах с Max (бот не отвечает / webhook reject / API errors / format mismatch) — ОБЯЗАТЕЛЬНО сверяться с docs Max ПЕРЕД написанием кода или гипотезой.**

Основные docs URLs:
- https://dev.max.ru/docs/maxbusiness/selectionservices — главная для bot API
- https://dev.max.ru/docs-api — Bot API reference (endpoints + payloads)
- https://dev.max.ru/docs-api/methods/POST/subscriptions — webhook regestration + secret-header info
- https://dev.max.ru/docs-api/methods/GET/subscriptions — list active webhooks
- https://dev.max.ru/docs-api/methods/GET/updates — update format reference (для long-polling и webhook одинаковый)
- https://dev.max.ru/docs/chatbots/bots-coding/library/js — официальная JS SDK как референс

Подтверждённые факты (через WebSearch 2026-05-20):
- Authorization header: **`Authorization: <TOKEN>`** (БЕЗ `Bearer` префикса)
- Webhook secret приходит в header **`X-Max-Bot-Api-Secret`** (точное имя)
- Только HTTPS port 443 (HTTP отключается с 25 мая 2026)
- Trusted CA certs обязательны (self-signed нельзя)
- Retry policy: до 10 раз exp backoff, после 8 часов — auto-unsubscribe
- Subscribe payload: `{url, update_types: ["message_created", "bot_started", ...], secret}`
- При работе с `plugins/max-bot/module.ts` и `plugins/max-channel/module.ts` — сверять формат payload update'ов (поля `chat.id`, `sender.user_id`, `body.text`)

При reproducible проблеме — сначала WebFetch / WebSearch docs (если дистанционно доступны), затем сверка с кодом. Без сверки гипотезы — потеря времени.

### Knowledge-base sync rule (Eugene 2026-05-11)

**При изменении любых публичных параметров MuziAi (цены, режимы генерации, шаблоны, голоса, бонусная программа, реферальная) — в том же коммите обновляй `docs/strategy/KNOWLEDGE-BASE-BOT.md`.**

Этот файл — source of truth для Telegram-бота (Аня/Татьяна/Мария/Ольга в @Muziaipodari_bot). Загружается на старте + по запросу `GET /api/telegram/kb/reload?secret=...`. Не обновлённый KB → бот рассказывает юзерам устаревшие цены / отсутствующие шаблоны.

Триггеры обновления:
- Изменилась цена в `gen-templates`, `routes.ts` или UI
- Добавлен/удалён шаблон в `Музыкальные События`
- Изменилась логика регистрации / реферальной программы
- Появился/удалён режим генерации
- Изменился список голосов / стилей

После update KB на проде: `https://muziai.ru/api/telegram/kb/reload?secret=<CRON_SECRET>` (без рестарта pm2).

### Consultant-size-per-channel rule (Eugene 2026-05-12)

**Для сайта и для чатов — РАЗНЫЕ размеры образа помощницы.**

- **Сайт** (`floating-consultant.tsx`): большой image-badge (`w-16 h-24 sm:w-20 sm:h-32` = 64×96 / 80×128). Заметный, кликабельный, основной CTA.
- **Чаты** (Telegram / Max через `consultant-avatar.png`): компактный 256×256 PNG. Не загромождает диалог, оставляет фокус на тексте.

Файл `consultant-avatar.svg` (transparent) — общий source-of-truth образа. PNG для ботов генерируется через sharp resize до 256×256.

### Bot-webhook-dedup rule (Eugene 2026-05-12)

**Любой плагин-бот (telegram-bot, max-bot, future channels) ОБЯЗАН делать dedup входящих updates по `update_id` / `message_id`** — иначе при retry от мессенджера юзер получит одно и то же сообщение дважды.

Шаблон:
```ts
const processed = new Map<string|number, number>();
function isDup(id) { /* TTL 10 мин, max 200 */ }
// В webhook handler:
if (isDup(update.update_id)) return;
```

Применяется к каждому новому каналу при добавлении.

### Boss-form-address rule (Eugene 2026-05-12)

**Обращаться к Eugene — «Босс» (с большой буквы).** Не «Eugene», не «босс», не «шеф». Только «Босс» с заглавной Б.

Применяется в каждом ответе ассистента, когда уместно обращение.

### Single-audio rule (Eugene 2026-05-12)

**Одновременно на сайте играет ТОЛЬКО ОДНА песня.**

Реализовано через `client/src/lib/audio-bus.ts`:
- Global listener `installAudioBus()` в `main.tsx` ловит `play` event (capture phase) у всех `<audio>` в DOM → pause остальных
- Non-DOM `new Audio()` инстансы регистрируются через `registerAudio(audio)` чтобы тоже участвовать в singleton

Применяется к: всем audio elements на сайте (player-agent, landing playlist, dashboard, music player).

### News-block 3-max rule (Eugene 2026-05-12)

**На главной странице (`apps/neurohub/client/src/pages/landing.tsx`) — НЕ БОЛЕЕ 3 новостей одновременно.**

При появлении 4-й новости — самую старую заменяю/удаляю. Альтернатива на будущее: сделать ленту новостей с «Показать ещё» — видны 3 свежие, остальные раскрываются по клику.

Применяется к: блоку «Новости» в landing.tsx (карточки с pill-бейджем «Новости» + дата).

### News-card style — эталон 12 мая (Eugene 2026-05-16)

**Все новости на главной — в едином стиле новости от 12 мая 2026 («У нас появилась Муза»).**

Эталонные классы Tailwind:
- Container: `glass-card rounded-2xl p-6 border border-<color>-500/30 hover:border-<color>-500/50 transition-colors`
- Layout: `flex items-start gap-3` (icon-column 14px wide + content flex-1)
- Icon emoji: `text-3xl` (не `text-4xl`, не `text-2xl`)
- Pills row: `flex items-center gap-2 mb-2` с pill `text-[10px] font-sans px-2 py-0.5 rounded-full bg-<color>-500/20 text-<color>-300 font-medium`
- Заголовок h3: `text-lg font-sans font-bold text-white mb-2` (gradient span внутри можно через `bg-gradient-to-r ... bg-clip-text text-transparent`)
- Тело p: `text-sm font-sans text-muted-foreground leading-relaxed`
- CTA span внутри p: `text-<color>-300 font-medium`

Цвета акцентов меняются (pink/cyan/emerald/purple…), **размеры и font — нет**. Это правило сильнее «крупно/заметно» — даже акцентная новость с подарком сохраняет text-lg / text-sm.

Применяется к: всем news-карточкам в `landing.tsx`. Не применяется к: hero CTA (он не «новость»), пилюли вне новостей.

### Brand-style consistency rule (Eugene 2026-05-17)

**Любая новая UI-страница / модалка / компонент должны использовать фирменный стиль MuzaAi (Cyber Violet · Electric Blue · Neon Green · Hot Magenta · Amber Glow · Deep Space).** Это распространяется на свайп-режим CoverDetailsModal, формы login/register, admin-панель, landing hero, dashboard и всё что увидит юзер.

Палитра (6 фирменных цветов, из Figma design system + `index.css`):

| Назначение | Hex | Tailwind |
|---|---|---|
| 🟣 Cyber Violet — primary AI / агенты | `#7C3AED` | `purple-600` |
| 🔵 Electric Blue — data / playlist | `#00D4FF` | `cyan-400` |
| 🟢 Neon Green — auth / social | `#39FF14` | `green-400` |
| 🟣 Hot Magenta — external channels | `#FF006E` | `fuchsia-500` / `pink-500` |
| 🟡 Amber Glow — infra / admin | `#FBBF24` | `amber-400` |
| ⚫ Deep Space — фон | `#0A0A17` | `bg-[#0a0a17]` |

Brand gradient (primary): `from-purple-500 via-fuchsia-500 to-blue-500` (или с amber для admin-акцентов). Используется на CTA, hero spans, иконках-логотипах, активных стрелках.

Шрифты (три уровня, оба загружены в `index.css`):

- `font-sans` (Inter) — основной текст, body, paragraphs, captions
- `font-display` (Space Grotesk + tracking) — hero h1, page titles, cosmic-акценты, модальные titles
- `font-mono` (JetBrains Mono) — цифры, IDs, даты

CSS utilities (определены в `apps/neurohub/client/src/index.css`):

- `.glass-card` — glassmorphism background для cards (rgba(18,18,22,0.72) + backdrop-blur)
- `.gradient-text` — purple→blue gradient text-clip (для titles)
- `.gradient-text-reverse` — обратный direction
- `.font-display` / `.font-display-spread` — hi-tech акценты
- `.btn-cosmic` — magic shimmer-gradient button (см. также Reuse-working-solutions rule — единая первичная CTA-кнопка)
- `.card-cosmic` — карточка с gradient border
- `.hero-gradient` — background для auth-страниц
- `.input-glow` — focus glow для input

Когда что использовать:

1. **Page titles / hero h1** → `font-display font-bold gradient-text` (text-3xl и выше). Пример: landing hero, login/register h1, admin Admin · v304, CoverDetailsModal title.
2. **Section headings (h2/h3)** → `font-sans font-bold text-white` (см. News-card style rule — обычный font-sans, не font-display).
3. **Body text / descriptions** → `font-sans` + `text-muted-foreground` или `text-white/60-80`.
4. **Numbers / IDs / timestamps** → `font-mono` (см. CoverDetailsModal date).
5. **Cards / containers** → `.glass-card` или `bg-gradient-to-br from-[#1a0f2e] via-[#0a0a17] to-[#0f1830]` с `border-purple-500/20`.
6. **Primary CTA** → `.btn-cosmic` (один magic CTA на page) или `bg-gradient-to-r from-purple-500 via-fuchsia-500 to-blue-500` + `shadow-[0_0_24px_rgba(124,58,237,0.4)]`.
7. **Secondary buttons** → `bg-white/5 border border-purple-400/20 hover:bg-gradient-to-br hover:from-purple-500/60 ...` (hover glow).
8. **Backdrop / modal overlay** → `bg-gradient-to-br from-[#0a0a17]/95 via-[#1a0f2e]/95 to-[#0a0a17]/95` + `backdrop-blur-xl`.
9. **Active state glow** → `shadow-[0_0_32px_rgba(124,58,237,0.5)]` (purple), `shadow-[0_0_24px_rgba(0,212,255,0.4)]` (cyan), `shadow-[0_0_24px_rgba(251,191,36,0.4)]` (amber).

Что НЕ делать (антипаттерны):

- ❌ Произвольные hex-цвета вне палитры (`#abcdef`, `slate-700`, `gray-300`-like для бренд-элементов). Tailwind grayscale (`white/X`, `black/X`) — OK для нейтральных.
- ❌ `font-mono` для long-form text (читается плохо).
- ❌ `font-display` на body paragraphs (он для акцентов, не для абзацев).
- ❌ Solid `bg-black` на cards — теряет glassmorphism. Используй `.glass-card`.
- ❌ Hardcoded `font-family` inline — всегда через Tailwind utility (`font-sans` / `font-display` / `font-mono`).
- ❌ Border без opacity / brand color (`border-gray-500`) — используй `border-purple-500/20`, `border-white/10`.

Audit-сценарий перед коммитом UI-фичи:

1. Открыть свою новую страницу/компонент рядом со страницей-эталоном (CoverDetailsModal, landing hero, login-phone).
2. Проверить: h1 → font-display + gradient-text? Cards → glass-card / brand bg? CTA → btn-cosmic или brand gradient + glow? Цифры → font-mono?
3. Если какой-то элемент outside брэнда — заменить на ближайший фирменный эквивалент.
4. НЕ переписывать рабочие страницы целиком — только точечные правки outside-brand элементов.

Применяется к: всем новым UI-фичам (страницы, модалки, виджеты, кнопки, формы). Не применяется к: уже стабильным страницам в production, которые работают и проверены (правки только при появлении явных outside-brand элементов).

Эталоны для копирования стиля:
- `apps/neurohub/client/src/components/cover-details-modal.tsx` — модалка (gradient backdrop, font-display title, brand arrows)
- `apps/neurohub/client/src/pages/login-phone.tsx` / `register-phone.tsx` — auth-форма (логотип-кнопка, h1 font-display, gradient-border card)
- `apps/neurohub/client/src/pages/landing.tsx` hero (h1 с gradient span + font-display)
- `apps/neurohub/client/src/index.css` — все brand utilities (`.glass-card`, `.btn-cosmic`, `.gradient-text`, и т.д.)

#### Hi-tech accents (Eugene 2026-05-17)

Поверх базовой brand-палитры добавлены **subtle cyber/sci-fi-эффекты** для hi-tech ощущения. Все CSS-only (mobile-first, никакого JS particle system), reduced-motion-safe.

| Utility | Эффект | Где применять |
|---|---|---|
| `.scan-line` | Animated horizontal scan-полоса (cyan) сверху вниз каждые 4 сек | Hero sections, status panels, live-индикаторы |
| `.neon-text` | Neon glow поверх `currentColor` (text-shadow 8px+16px) | Hi-tech title-акценты поверх `gradient-text` |
| `.animated-border` | Вращающийся 4-цветный gradient (purple/cyan/amber/magenta), 8 сек цикл, padding-wrapper для inner content | Карточки требующие attention (status / live / featured) |
| `.holographic` | Голографический shimmer фон (3 brand-color layers), 12 сек цикл, backdrop-blur | Modal overlays, featured cards, swipe-modals |
| `.cyber-grid` | Subtle 32×32px hi-tech сетка (purple+cyan, 4% opacity) | Admin dashboards, technical panels |
| `.particle-bg` | 2 floating CSS particles (purple+cyan) — 6-7 сек циклы | Вокруг ключевых CTA, FAB-кнопок в idle |
| `.hud-frame` | Sci-fi corner brackets (требует `<div className="hud-bl">` + `hud-br` детей для нижних углов) | Технические панели, status widgets |

Правила использования:
1. **Subtle, не overkill.** Один utility на блок — не комбинируем 3+ эффекта на одном элементе.
2. **Mobile-first.** Все эффекты тестированы на iPhone Safari. Не использовать на mobile если эффект тяжёлый (например `cyber-grid` на полноэкранных body — OK; `animated-border` на сотне item-карточек — нет).
3. **Performance.** Никаких JS particle systems. CSS-only. Anim'ы используют `transform` / `opacity` / `background-position` — composited layers.
4. **Reduced motion.** Все шевелящиеся утилиты автоматически отключаются через `@media (prefers-reduced-motion: reduce)`.
5. **Reuse brand colors.** Только из палитры (#7C3AED / #00D4FF / #FBBF24 / #FF006E). Не вводить новые hex.

Применено в проекте (2026-05-17):
- `pages/admin/master-dashboard-tab.tsx` — `cyber-grid` фон + `animated-border` на status cards
- `components/cover-details-modal.tsx` — `holographic` overlay + `neon-text` на title
- `components/musa-voice-fab.tsx` — `particle-bg` вокруг кнопки в idle
- `pages/landing.tsx` hero — `scan-line` overlay + `neon-text` на «MuzaAi»
- `pages/login-phone.tsx` / `register-phone.tsx` — `holographic` + `cyber-grid` фон

### Playlist-default-song-rating rule (Eugene 2026-05-22, **перекрывает Playlist-daily-rotation для category=song**)

**Default плейлиста на главной = Категория «Песни» + Сортировка «Топ по прослушиваниям».**

Применяется при первом заходе юзера (нет saved выбора в localStorage):
- `categoryFilter = "song"` (Песни)
- `sortMode = "rating"` (Топ по прослушиваниям, DESC by plays count)

**При клике юзера на другой параметр** (категория/сортировка/направление):
- State update мгновенно через setState
- useEffect c deps `[sortMode, sortDir, playlistKind, playlistFetchEnabled]` re-runs
- Fresh `fetch /api/playlist?sort=X&dir=Y&status=Z` → setTracks → **плейлист сразу обновляется** без F5
- Юзер видит новый порядок мгновенно
- Выбор persist в localStorage `pl_v2:sortMode` / `pl_v2:category` / etc

**По окончании текущего трека** — auto-next по filteredMusic (`handleEnded` использует `filteredMusicRef.current`):
- Следующий трек берётся **по списку** в том же sort order
- НЕ random, НЕ из non-filtered, НЕ из другой категории
- По Playlist-strict-selection rule (тот rule остаётся)

**Перекрывает:**
- `Playlist-daily-rotation rule` для category=song — для песен НИКОГДА ротация default, всегда rating. Для greeting/instrumental/all — ротация остаётся (через server `/api/playlist/sort-default`).

**Применяется к:** `landing.tsx` главная плейлист-секция, dashboard.tsx «Мои треки», track.tsx — везде где есть category/sort выбор.

**Реализация** (`landing.tsx`):
```ts
// useState initial fallback:
const [sortMode, setSortMode] = useState(() => {
  const s = readInitial("sortMode");
  return validSortMode(s) ? s : "rating"; // ← rating вместо date
});
// useEffect — НЕ перебиваем для song:
useEffect(() => {
  if (saved) return;
  if (cat === "song") { setSortMode("rating"); return; }
  fetch(`/api/playlist/sort-default?category=${cat}`).then(...);
}, []);
```

**Связано с:**
- Playlist-strict-selection rule — auto-next из filteredMusic (без fallback на полный список)
- Playlist-category-no-mix rule — category mutually exclusive
- Playlist-daily-rotation rule — теперь только для не-song категорий

---

### Playlist-daily-rotation rule (Eugene 2026-05-21)

**Параметры сортировки плейлиста на главной ротируются автоматически — 1 раз в сутки в 00:00 МСК. По умолчанию категория «Песни» (`song`) выбрана. Применяется ко ВСЕМ юзерам (включая уже-зашедших) — через one-time migration reset localStorage.**

Конкретика:
- **Cycle** (порядок ротации, default): `date → rating → random → top_month → date → …`
- **Cut-off**: 00:00 МСК (= 21:00 UTC), НЕ 00:00 UTC. Источник правды — `lib/playlistSortRotation.ts:dayIndexFrom()` (shifted-scale +3h).
- **Категория по умолчанию**: `song` (Песни), НЕ `all`. Юзер видит сразу плейлист «Песни» при первом заходе.
- **Юзер-override**: если юзер выбрал свою сортировку или категорию — сохраняется в localStorage, ротация default НЕ перебивает.
- **Применение ко всем юзерам**: one-time migration через flag `pl_defaults_reset_version` в localStorage. При несовпадении версии — удаляются все сохранённые sortMode/category ключи → юзер получает default при следующем визите. Дальше его выбор персистится.
  - Увеличить версию когда нужен ещё один reset (например изменили cycle):
    ```ts
    const PLAYLIST_DEFAULTS_RESET_VERSION = "v2026-MM-DD";
    ```

Технически:
- Server: `apps/neurohub/server/lib/playlistSortRotation.ts` (DEFAULT_CYCLE + dayIndexFrom + getTodayDefaultSort)
- Client: `landing.tsx:487-508` — при загрузке если у юзера нет saved sortMode → fetch `/api/playlist/sort-default`
- Client: `landing.tsx:512-515` — categoryFilter default = `'song'`
- Admin endpoint: `POST /api/admin/v304/playlist-sort-rotation` body `{cycle: [...]}` — менять порядок
- Storage: `data/playlist-sort-rotation.json` на VPS

Применяется к: главной странице (`/`) плейлисту в landing.tsx. НЕ применяется к: dashboard, track-page, музыкальным событиям — там собственные UI без ротации.

Анти-паттерн который правило закрывает: cut-off ротации был на 00:00 UTC = 03:00 МСК — юзеры открывающие сайт в 02:30 МСК видели вчерашнюю сортировку. Теперь 00:00 МСК — ровно полночь по Москве.

### Pricing-single-source rule (Eugene 2026-05-20)

**При изменении стоимости любой услуги (генерация трека, обложка, текст, кавер, премиум-подписка, реферальный бонус, любые future SKU) — ОБЯЗАТЕЛЬНО находить ВСЕ места где цена отражена + изменять везде + правила подсчёта списания + учёта баланса.**

Цены в проекте дублируются в нескольких слоях. Один из них пропустить = рассинхрон UI vs реальное списание = жалобы юзеров «нажал кнопку 299₽, списали 399₽».

**Где живут цены (полный реестр — обновлять при каждом изменении):**

| Слой | Файл | Что хранит |
|---|---|---|
| Server — централизованный | `apps/neurohub/server/routes.ts` `PRICES` объект | `music: 39900, lyrics: 9900, cover: 9900` (копейки) |
| Server — UI labels | `apps/neurohub/server/routes.ts` `PRICE_LABELS` | `"399 ₽"` strings для error/transaction descriptions |
| Server — tariff_history (dynamic) | `apps/neurohub/shared/schema.ts` + `lib/pricing.ts` | Архив изменений с датами (готов, не активирован) |
| Server — referral | `apps/neurohub/server/routes.ts` `REFERRAL_BONUS` | реферальный bonus |
| Server — audio cover | `apps/neurohub/server/plugins/audio-upload/module.ts` | `AUDIO_COVER_PRICE_KOPEK` env or hardcoded |
| Server — max-channel templates | `apps/neurohub/server/plugins/max-channel/module.ts` | per-template price (birthday, wedding, ...) |
| Server — invoice tariffs | `apps/neurohub/server/lib/muzaTools.ts` `TARIFFS` объект | `track_399`, `topup_500`, etc |
| Client — main pricing | `apps/neurohub/client/src/pages/music.tsx` `MUSIC_PRICE`, `COVER_PRICE` | Кнопки «Создать песню — N ₽» |
| Client — chat-помощник | `apps/neurohub/server/lib/consultantPersona.ts` | Якоря цены в LLM prompt |
| Client — Музa KB | `docs/strategy/KNOWLEDGE-BASE-BOT.md` | KB строки которые Музa цитирует |
| Client — chatbot fallback | `apps/neurohub/server/plugins/chatbot/module.ts` | Hardcoded ответы про цены |
| UI — admin pricing tab | `apps/neurohub/client/src/pages/admin/...` (если создан) | Admin viewer текущих цен |
| Документация | `docs/strategy/ANSWERS.md`, `KNOWLEDGE-BASE-BOT.md`, оферты | Письменные пометки |

**Чек-лист при изменении цены X → Y:**

1. `grep -rn "X" apps/neurohub/server/ apps/neurohub/client/src/` — найти все вхождения
2. Server PRICES + PRICE_LABELS обновить
3. Если используется tariff_history (lib/pricing.ts активирован) — `setTariff({serviceType, priceKopecks: NEW, ...})` + audit-log
4. Client constants (MUSIC_PRICE, COVER_PRICE) обновить
5. KNOWLEDGE-BASE-BOT.md — все упоминания цены
6. consultantPersona.ts — якоря цены в LLM prompt
7. chatbot/module.ts — fallback hardcoded ответы
8. max-channel templates — price у каждого шаблона
9. muzaTools.ts TARIFFS — track_NEW
10. Smoke-test после deploy:
    - открыть /music → кнопка «Создать песню — NEW ₽»
    - спросить Музa «сколько стоит трек?» → ответ должен быть NEW
    - в админке посмотреть transactions — descriptions обновились

**Правила учёта баланса (НЕ меняем без согласования):**

- Все цены в **копейках** (multiplied by 100) в БД (`users.balance`, `PRICES`, `tariff_history.price_kopecks`)
- При checkAndCharge: `user.balance -= price_kopecks` атомарно через drizzle
- Bonus tracks (free quota) проверяются ДО списания денег — `if (bonusTracks > 0) { bonusTracks -= 1; free }`
- Refund при failed generation возвращает price_kopecks обратно в balance + transaction type='refund'
- Все transactions пишутся в `transactions` таблицу для аудита (admin /transactions)

**Применяется к:** ЛЮБОМУ изменению цены, даже на 1 рубль. Применяется к: новым SKU (новая цена = новая запись tariff_history + регистрация в PRICES + UI labels).

**НЕ применяется к:** временным акциям/промокодам — там отдельный pipeline (discount codes, не меняет базовые PRICES).

**Анти-паттерн который правило закрывает:** в client/music.tsx был hardcoded `299` после server PRICES уже стал 39900 — кнопка показывала «Создать — 299 ₽», списывало 399. Юзер жаловался «не та цена». Pricing-single-source rule заставляет ВСЕГДА при изменении прогонять чек-лист 1-10 выше.

### Backup-naming rule (Eugene 2026-05-20)

**Файлы backup (любые — БД, .env, authors/, любые архивы проекта) именовать в формате `MuzaAi-Triumph-DDMMYY-HHMM.tar.gz`** (consistent с Triumph-tag rule).

- `DDMMYY` — день-месяц-год (например `200526`)
- `HHMM` — час-минута локального времени запуска backup (например `2330`)
- Расширение `.tar.gz` (или `.zip` если контекст требует)
- Никаких `nomp3-`, `backup-`, `prod-snapshot-` префиксов — всегда `MuzaAi-Triumph-`

Примеры:
- `MuzaAi-Triumph-200526-2330.tar.gz` — backup от 20.05.2026 в 23:30
- `MuzaAi-Triumph-210526-0300.tar.gz` — auto-backup от 21.05.2026 в 03:00 (cron)

Применяется к: cron auto-backup (`deploy/backup-no-mp3.sh`), ручным snapshots, перед-deploy backup'ам (`auto-deploy-prod.sh` если переименовать), любым future backup-pipelines.

НЕ применяется к: триумф-tag'ам в git (`triumph-DDMMYY` — у них свой формат без extension).

### Multi-domain-admin-stats rule (Eugene 2026-05-21)

**Per-domain статистика и cross-domain сводка живут в одном плагине — `multi-domain-stats`. При появлении нового instance (новый домен) — добавить URL в ENV `MULTI_DOMAIN_PEERS` на всех существующих VPS. Token shared между ВСЕМИ инстансами (хранится в `.env` каждого, chmod 600).**

Архитектура:
- `apps/neurohub/server/plugins/multi-domain-stats/module.ts` — single source of truth для local + aggregated stats
- `GET /api/admin/v304/local-stats` — статистика текущего instance (cache 60 сек). Dual-auth: либо admin-сессия (requireAdmin), либо shared HMAC token через `?token=...` (для peer-to-peer cross-domain trust). Constant-time compare через `timingSafeEqual`
- `GET /api/admin/v304/aggregated-stats` — опрашивает peer'ов (MULTI_DOMAIN_PEERS CSV), складывает per-domain rows + TOTAL (cache 5 мин). Только requireAdmin (cross-domain не leak'аем юзерам)
- `deploy/setup-multi-domain.sh` — генерирует token + печатает ssh-команды установки для каждого VPS

ENV:
- `MULTI_DOMAIN_PEERS` — CSV полных URL других instance'ов (`https://muzaai.ru,https://clone.muziai.ru`). Без trailing slash
- `MULTI_DOMAIN_SHARED_TOKEN` — random base64-43, одинаковый на всех peer'ах

Что показывает (admin UI «🌐 Все домены» в /admin/v304 после вкладки 💬 Диалоги):
- Per-domain rows: domain | users | visits | gens | plays | payments | revenue | status (🟢 reachable / 🔴 down / 🟡 timeout)
- Bottom TOTAL row — сумма по всем reachable peer'ам + local
- Status indicators per peer: ok / timeout / auth_failed / invalid_response / error
- Setup instructions panel — если MULTI_DOMAIN_PEERS пуст

Безопасность:
- Aggregated stats доступны ТОЛЬКО admin (не leak'аем cross-domain юзерам)
- Cache 5 мин на peer-side, 60 сек на local-side — снижает нагрузку
- HTTP timeout на peer fetch — 5 сек (не больше), peer недоступен → row с error, не throw'им
- Backward compat: если `MULTI_DOMAIN_PEERS` пуст → endpoint возвращает только local stats без peer'ов (single-domain mode)
- SQL queries только read-only (нет UPDATE/INSERT/DELETE)
- Token rotation: re-run `setup-multi-domain.sh` → новый token → команда на каждый VPS → pm2 restart. Старый peer-fetch перестаёт работать сразу

При добавлении новой метрики:
1. Расширить `LocalStats` interface + buildLocalStats() в multi-domain-stats/module.ts
2. Учесть в aggregateTotals() (если суммируется)
3. Добавить в `multi-domain-stats-tab.tsx` колонку или SummaryCard
4. НИКОГДА не возвращать PII (email/phone plain) — только aggregate counts

Применяется к: per-domain отчётности, кросс-доменным сводкам выручки/юзеров/треков. НЕ применяется к: per-user analytics (там Cross-channel conversation linking rule + личные тред-views).

### Triumph-tag rule (Eugene 2026-05-10)

**Когда Eugene говорит «Триумф» / «Победа» / «Сохрани редакцию» с ракетами 🚀 — создаю git tag формата `triumph-DDMMYY` на текущем HEAD с описанием что вошло.**

Шаблон команды:
```
git tag -a triumph-DDMMYY <SHA> -m "Триумф DDMMYY — <короткое описание ключевых фич: обложки, плейлист, audio-link и т.д.>"
git push origin triumph-DDMMYY
```

Пометка `🚀🚀🚀` (3 ракеты) — означает мажорный triumph (несколько фич сразу). Одна 🚀 — мелкая фиксация. Сохраняю в commit-message.

Восстановление: `git checkout triumph-DDMMYY`.

Применяется автоматически при появлении ракет 🚀 + словах "Триумф/Победа/Сохрани" — без переспрашивания.

### Auto-resume rule (Eugene 2026-05-09)

**После любого прерывания (interruption / context compaction / stop hook / user pause / новая сессия с открытым plan-файлом) — автоматически возобновляю работу с последней незавершённой задачи в todo list БЕЗ переспрашивания «продолжить?».**

Реализация:
1. При получении любого нового сообщения от Eugene — сначала проверяю todo list
2. Если есть `in_progress` задача — продолжаю её
3. Если последний commit / push незавершён — завершаю
4. Если открыт plan file (`/root/.claude/plans/*.md` или подобный) — продолжаю по нему
5. Если Eugene дал новую задачу — добавляю в todo list, но текущую `in_progress` не бросаю

Сильнее `working rhythm rule`: даже если задача не выглядит «успешным промежуточным результатом» — всё равно продолжаю.

Не применяется к:
- Явному «стоп» / «отмени» / «пауза» от Eugene
- Случаям когда блокер не разрешён (нужен ввод от Eugene)

### Deploy countdown rule (Eugene 2026-05-08)

**После каждого `git push` ВСЕГДА запускаю обратный отсчёт через `Bash run_in_background` с print'ами каждые 30 сек.** Чтобы Eugene видел сколько осталось до конца auto-deploy (типичные 90 сек), не жал refresh раньше времени.

Формат countdown'а:
```
Deploy 408ac71 → ETA 90 сек
60 сек осталось…
30 сек осталось…
🟢 Готово к проверке (XX:XX MSK)
```

Применяется к: каждый `git push -u origin <branch>` после моего commit'а.
Не применяется к: коммитам без push'a (локальные исправления docs/etc).

### Decreasing-reliability options rule (Eugene 2026-05-08)

**Когда предлагаю варианты решения — всегда сортирую от самого надёжного и необходимого к менее.** То есть: первый вариант = best practice, проверенное решение, минимизирует риск; последний — компромисс / временный костыль.

Формат:
1. **[Самое надёжное]** — proper fix, может занять больше времени но закрывает root cause
2. **[Среднее]** — компромисс между качеством и временем
3. **[Быстрое]** — patch чтобы разблокировать, требует follow-up
4. **[Не рекомендую]** — если бы вообще делал, то так

Применяется к: предложениям после bug-аудита, выбору архитектуры, рефакторингу. Не применяется к: просто-описание состояния системы, ответам на вопросы где есть один правильный ответ.

### Track-title rule (Eugene 2026-05-08)

**При создании трека название (title) ВСЕГДА сохраняется в `generations.display_title`.** Источник в порядке приоритета:

1. `body.title` от пользователя (если есть)
2. Первая строка lyrics (без структурных тегов `[Verse]/[Chorus]`)
3. Первые 80 символов prompt
4. Fallback: «Мой трек»

Это закрывает анти-паттерн, когда трек выходил без названия и в дашборде показывался как «Без названия». Применяется ко всем точкам создания: `/api/music/generate`, `/api/music/regenerate`, `/api/music/style-cover` (`Кавер · ${sourceTitle}`), `/api/music/extend` (`${sourceTitle} (продолжение)`).

**ИЗМЕНИТЬ НАЗВАНИЕ МОЖЕТ ТОЛЬКО ВЛАДЕЛЕЦ ТРЕКА** через `POST /api/generations/:id/rename` (с email-confirmation для не-админа). Никакие фоновые агенты, нормализаторы, polling-loops НЕ ДОЛЖНЫ перезаписывать `display_title` после создания. Sole exception: ID3-tag синхронизация при пользовательском rename (NodeID3 пишет в mp3 file).

### Browser-link rule (Eugene 2026-05-08)

**Когда инструкция предполагает действие в браузере — всегда даю кликабельную ссылку (полный URL), а не описание пути.**

Анти-паттерн, который это правило закрывает:
- ❌ «Открой /admin/v304 → 🔬 Диагностика → кнопка X»
- ✅ «Открой https://clone.muziai.ru/#/admin → 🔬 Диагностика → кнопка X»
- ❌ «Сходи на /api/admin/v304/suno-watchdog/full-diagnose»
- ✅ «Открой https://clone.muziai.ru/api/admin/v304/suno-watchdog/full-diagnose»

Eugene копипастит URL из чата → один клик. Описание пути требует у него самостоятельной сборки URL и провоцирует ошибки (особенно если он на телефоне).

Применяется к: всем чек-листам после деплоя, тестовым точкам, проверкам админки, ссылкам на JSON-эндпоинты, ссылкам в документацию (если нужно открыть). Не применяется к: ссылкам на файлы в репозитории (file:line — стандарт), ссылкам которые НЕ для открытия в браузере (curl-команды, ssh).

### Admin-notifications rule (Eugene 2026-05-17)

**Уведомления админу через Telegram при ЛЮБЫХ сбоях по каналам** — обязательное правило для каждого нового канала / endpoint / cron.

Что считается «сбоем»:
- Webhook канала (TG / Max / VK / Web) не отвечает / возвращает 5xx
- LLM call упал на всех ключах (Anthropic + TimeWeb fallback)
- Cron task крашится 2 раза подряд
- Disk usage > 90%
- DB integrity_check FAILED
- Rate-limit hit на платном API (Yandex / Anthropic / SMS.ru) > 5 раз/час
- Refund pipeline не справился с failed generation

Канал уведомлений:
- Default: Telegram (`TELEGRAM_BOT_TOKEN` + `ADMIN_TELEGRAM_ID`)
- Fallback: Email (`SMTP_PASS` + `egnovoselov@gmail.com`)
- Резерв: запись в incidents table (для admin UI просмотра позже)

Rate-limit alert'ов:
- Same alert key (например `bot-down-telegram`) — макс 1 alert/час (защита от флуда)
- При первом восстановлении (red → green) — отдельный alert «Канал восстановлен»

### Hourly-digest rule (Eugene 2026-05-17)

**Каждый час админу автоматически приходит срез статистики** через Telegram. Формат:

```
📊 Срез за час (12:00–13:00 МСК)

👥 Посетители: +47 (vs предыдущий час +32) ↗
💬 Диалоги Музы: +18 новых сообщений
💰 Продажи: 2 трека × 299₽ = 598₽
🎵 Создано треков: +5
🆕 Регистраций: +3 (телефон), 0 (email)

⚠ Issues: нет
```

**Тихие часы 20:00 — 03:00 МСК** — в это время отправляются **только критические события**:
- Канал упал
- LLM полностью недоступен (все ключи)
- Disk > 95% / DB corruption
- Платежи failure rate > 50%
- Manual alert от admin tool

Дневные digest pauseются (3 ночных часа без шума). После 03:00 МСК — возобновление обычного потока + утренний свод за ночь.

Реализация:
- Cron каждый час в `admin-overview` plugin
- Вычисление delta vs previous hour
- Sleep mode 20-03 МСК (если не критика)
- В digest вкладывается link на admin/v304/🧠 Сводка для подробностей

Применяется к: всем новым cron-jobs (hourly / daily). НЕ применяется к: разовые admin actions (там полный alert).

### Brand-assets-registry rule (Eugene 2026-05-17)

**Реестр всех мест где есть логотип/бренд MuzaAi.** При смене бренда — обновляю ВСЕ места автоматически (одним коммитом).

Места с brand-text/logo:

| Файл | Тип | Содержит бренд |
|---|---|---|
| `apps/neurohub/client/index.html` | HTML | `<title>`, `<meta og:image>`, link icons |
| `apps/neurohub/client/public/manifest.json` | PWA | name, short_name |
| `apps/neurohub/client/public/favicon.svg` | SVG | Логотип (purple waveform) |
| `apps/neurohub/client/public/artwork-512.png` | PNG 512×512 | **Lock-screen fallback artwork (v7 — Eugene 2026-05-22)** |
| `apps/neurohub/client/public/artwork-512-source.svg` | SVG source | Source для re-generation через sharp |
| `apps/neurohub/client/src/lib/branding.ts` | Constants | `BRAND.name`, `BRAND.url` |
| `apps/neurohub/server/lib/branding.ts` | Server constants | то же |
| `apps/neurohub/server/lib/publicUrl.ts` | URL config | `PUBLIC_URL` |
| `docs/strategy/KNOWLEDGE-BASE-BOT.md` | KB | бренд в текстах |
| `apps/neurohub/server/lib/consultantPersona.ts` | LLM prompt | бренд в персонажах |
| `apps/neurohub/server/plugins/telegram-bot/module.ts` | TG footer | подпись «— Муза · MuzaAi» |
| `apps/neurohub/server/plugins/max-bot/module.ts` | Max footer | то же |
| `apps/neurohub/server/plugins/notifications/module.ts` | Email/push templates | то же |

**artwork-512.png финальная версия (v7, Eugene 2026-05-22):**
- Lock-screen fallback (применяется когда нет реальной обложки трека через `/api/cover/<id>.jpg`)
- Background: vibrant purple radial gradient `#3B2563 → #1E1B4B → #0F1230`
- Central hero-glow: `#A78BFA` 55% opacity + `#D946EF` 35%
- 14 звёзд varied opacity 0.4-0.9
- Wordmark MuzaAi font-size 116px font-weight 900 letter-spacing -3 (вписан в рамки)
- Тройной glow рендер (background blur 22px + soft blur 6px + main solid)
- Точные hero gradients (landing.tsx:3164):
  · Muza: `from-purple-400 #a78bfa via-violet-300 #c4b5fd to-blue-400 #60a5fa`
  · Ai: `from-blue-400 #60a5fa to-cyan-300 #67e8f9`
- 12 эквалайзер бары снизу brand-gradient `purple-fuchsia-cyan` vertical
- Source SVG: `artwork-512-source.svg` (committed)
- Re-generate: `node -e "const sharp=require('sharp'); sharp('client/public/artwork-512-source.svg',{density:300}).resize(512,512).png({quality:95}).toFile('client/public/artwork-512.png');"`


**При замене бренда:**
1. Grep `MuziAi\|МузиАй\|muziai\.ru` по всему репо
2. Заменить везде на актуальный бренд (`MuzaAi` / `Муза Ай` / `muzaai.ru`)
3. Графические PNG-иконки — удалить, fallback на SVG (всегда актуальный)
4. ID3-tag старых mp3 → запустить backfill `/api/admin/v304/backfill/id3-rebrand`
5. Cover-images в БД — отдельный re-generation цикл (через Suno)

**Применяется:** к любым переименованиям, ребрендингу, изменению логотипа.
**Не применяется:** к ссылкам legacy domains (старые `muziai.ru` URL в DB / external mentions оставляем для 301-redirect).

### No-duplicates rule (Eugene 2026-05-17)

**Не плодить дубли функционала.** Перед созданием нового endpoint / UI tab / metric / chart — обязательно проверяю что уже есть в **admin dashboard** (`/admin/v304` master-dashboard + journey + click-stats + funnels + Yars + landing-CMS + api-health + диалоги). Если функция пересекается:

1. **СТОП. Не реализую новое.**
2. Вывожу Боссу **список пересечений** для решения:
   - Что уже есть (с file:line / endpoint URL)
   - Что предлагается добавить (gap анализ)
   - 3 варианта: **(a)** расширить existing / **(b)** удалить existing и сделать новое / **(c)** оставить оба если they have разные purposes
3. Жду решение Босса перед implementation

Применяется к:
- Новые admin endpoints (особенно analytics / metrics / stats)
- Новые UI tabs / widgets / cards
- Новые таблицы БД (если есть похожая существующая)
- Новые charts (если данные уже отражены в другой chart)
- Новые tools для Музы (если действие можно сделать через existing tool)

Не применяется к: bug fixes / точечные правки existing функционала.

Список **существующих admin функций** (обновлять при добавлении новых):

| Endpoint / UI | Что показывает / делает |
|---|---|
| `/admin/v304/🧠 Сводка` | Status indicators + period metrics + charts + click stats + Муза доложит |
| `/admin/v304/💬 Диалоги` | Все чат-сессии с фильтрами + inject-message от лица Музы |
| `/admin/v304/🗺 Journey` | User journey events timeline + funnel прокладки |
| `/admin/v304/🚨 Ярс` | Mentions Ярса в чатах |
| `/admin/v304/🏠 Главная` | CMS landing news (категории + иконки) |
| `/admin/v304/🔑 API ключи` | Health check всех ключей + cron 03:00 МСК |
| `/api/admin/v304/dashboard-summary` | Все metrics одним вызовом (кэш 60 сек) |
| `/api/admin/v304/click-stats` | Топ кликов / by page / by element |
| `/api/admin/v304/journey-summary` | User journey aggregates |
| `/api/admin/v304/funnels` | Воронки конверсии (планируется) |
| `/api/admin/v304/conversations` | Список диалогов с фильтрами |
| `/api/admin/v304/brain-export` | Полный snapshot для Второго мозга |
| `/api/admin/v304/yars-mentions` | Упоминания Ярса |
| `/api/admin/v304/api-keys/health` | Статусы всех API ключей |

### Period-20-MSK rule (Eugene 2026-05-17)

**Cut-off дня = 20:00 МСК. Все аналитические endpoints используют ОДИН helper — `getPeriodRange(period)` из `apps/neurohub/server/lib/periodBoundaries.ts`. Своих period-расчётов больше нет.**

Что закрывает анти-паттерн: до этого правила каждый модуль (master-dashboard, funnels, visitor-stats, gen-stats, top-downloads, gen-activity-geo) имел СВОЮ логику cut-off дня — кто-то 00:00 МСК, кто-то rolling -24h от текущего момента, кто-то datetime('now','-1 day'). Цифры за «сегодня» расходились между модулями: visitor-stats считал одно, gen-stats другое, master-dashboard третье. Босс не мог сверить плеи/регистрации/визиты.

Cut-off semantics:
- **«Сегодня»** = `[вчера 20:00 МСК .. сегодня 20:00 МСК)` (или до текущего момента если 20:00 ещё не наступило).
- **«Вчера»** = `[позавчера 20:00 МСК .. вчера 20:00 МСК)`.
- **«Неделя/Месяц/Год»** = rolling от `now - 7d/30d/365d` до `now` (точно столько-то дней назад, не календарь).
- **«month-N»** для N=1..12 = `[N-го месяца 1 числа 20:00 МСК .. (N+1)-го месяца 1 числа 20:00 МСК)` в текущем году.
- **«Всё время»** = с 2024-01-01 UTC до `now`.
- **«custom»** = заданные параметрами `from` / `to` ISO bounds.

Технически:
- `MSK_OFFSET_HOURS = 3`, `CUTOFF_HOUR_MSK = 20`. 20:00 МСК = 17:00 UTC.
- `getPeriodRange(period, customFrom?, customTo?)` → `{ fromIso, toIso, label, id }`. `fromIso` включительно, `toIso` исключительно (полуоткрытый интервал).
- `periodSqlFilter(period, column?)` → готовый SQL WHERE-фрагмент `column >= 'X' AND column < 'Y'`.
- `normalizePeriodId(raw)` → валидный `PeriodId` (fallback 'today').
- `listPeriodIds()` → массив `{id, label}` для UI селекторов.

Применяется к (все endpoints с фильтром по периоду):
1. `master-dashboard/module.ts` — `dashboard-summary`, `click-stats`, `dashboard-detail/:metric`, `briefing-text`, `brain-export`.
2. `funnels/module.ts` — `funnels` (период) + `funnel-daily-snapshot` (per-date через `rangeForDate` — это специальный case, остаётся локальным).
3. `routes.ts` — `visitor-stats`, `gen-stats`, `top-downloads`, `gen-activity-geo`.
4. Любые **новые** endpoints с `?period=…` параметром.

НЕ применяется к:
- Fixed-window метрикам (status indicators всегда «последние 24 часа», `now-5min` для login-bot-attempt).
- Per-date snapshots (funnel daily snapshot за конкретный YYYY-MM-DD MSK-день).
- Per-user pagination cursors (`days=N` для chat-funnel — это N-days window, не period-pill).

Audit-сценарий перед коммитом аналитического endpoint'а:
1. `grep -n "datetime('now',.*-.*day\|new Date(Date.now() - .* \* 24" <файл>` — ничего не нашлось ✓
2. `grep -n "getPeriodRange\|periodToBounds\|periodToRange" <файл>` — должно быть в каждом endpoint'е с period-параметром.
3. Открыть https://muzaai.ru/admin/v304 с одним и тем же `period=today` в нескольких вкладках — цифры за «сегодня» в visitor-stats, gen-stats, master-dashboard должны совпадать.

Если цифры расходятся — кто-то нарушил это правило. Найти и заменить на `getPeriodRange()`.

### Влёт-результат rule (Eugene 2026-05-18)

**Перед фиксом — root cause найден до конца, не остановился на симптоме. Один push решает на 100%, без серии итераций.**

Этот рул появился потому что в одной сессии lock-screen чинился 5 раз подряд: каждая итерация лечила симптом, не корень. То же со страничкой S-button (7 правок позиции). Босс терял время и доверие.

**Что делать ПЕРЕД написанием кода:**

1. **Subagent в Explore-режиме для глубокого аудита.** Сформулируй вопрос «где именно ломается?», передай файлы / commits / симптомы. Subagent читает код, формулирует Top-3 гипотезы с вероятностями и file:line. НИКОГДА не угадывай root cause на основе одного-двух grep'ов.

2. **Сверка с git history.** `git log -p --since="1 day"` для подозрительных файлов. Какой commit мог сломать симптом? Это самая частая причина свежих регрессий.

3. **Покрой ВСЕ Top-3 гипотезы одним push'ем**, не только самую вероятную. Симптом «lock-screen не работает» может быть комбинацией: stale Safari cache + orphan playingId + 404 на artwork — все три одновременно нужно лечить.

4. **Добавь prevent-regression.** После фикса — что-то что не даст той же регрессии повториться: `Cache-Control: no-store` для HTML вместо «попроси Босса очистить кэш», `useEffect` guard вместо «не оставляй orphan state», eslint-rule вместо «не забывай вызывать setLockScreen». Симптом тушится — root cause устраняется — будущее защищено.

5. **Pre-flight test.** До push'а — `npx tsc --noEmit` на изменённых файлах. После push'а — конкретные шаги для Босса проверки результата (URL + ожидаемое поведение).

**Что не делать (анти-паттерны):**

- ❌ «Скорее всего это X. Push, проверь.» — без deep dive
- ❌ «Очисти Safari cache» как фикс. Это перекладывание на Босса. Настоящий фикс — Cache-Control header
- ❌ «Если не поможет — ещё фикс» — Босс не должен слышать эту фразу, фикс делает всё что нужно сразу
- ❌ Игнорировать гипотезы вероятностью 15% потому что «маловероятно» — один push покрывает всё

**Применяется к:** регрессиям, повторяющимся проблемам («опять не работает»), фичам которые чинились 3+ раза в той же сессии.

**Не применяется к:** новым фичам с чёткой спецификацией (там сразу пишешь по плану), исследовательским задачам где Босс явно сказал «попробуй и посмотрим».

Cильнее `Working rhythm rule`: лучше потратить 5 минут на subagent-audit чем 30 минут на серию неудачных push'ей.

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
- `getPeriodRange()` (server/lib/periodBoundaries.ts) — единая логика period boundaries (cut-off 20:00 МСК). Используется во всех аналитических endpoints (master-dashboard, funnels, visitor-stats, gen-stats, top-downloads, gen-activity-geo). См. Period-20-MSK rule.
- **`getPersistentPlayerAudio()` + `loadTrackIntoPlayer(url)`** (client/src/lib/lockscreen.ts) — ЕДИНСТВЕННЫЙ pattern audio в проекте после 9-й итерации LS (commit `8d047e1`). См. Persistent-audio-only rule ниже.

### Musa-knowledge-governance rule (Eugene 2026-05-19)

**Муза обновляет знания при каждом изменении функционала проекта. Босс и админы могут спрашивать о любых деталях проекта. Клиенты — только в части СВОИХ песен и СВОИХ оплат.**

Что Муза знает (источники):
- CLAUDE.md (это правило + все остальные)
- `docs/strategy/PITFALLS.md` (накопленный опыт ошибок)
- `docs/strategy/KNOWLEDGE-BASE-BOT.md` (пользовательский KB)
- Git log последних 50 commits (что недавно менялось)
- Через `apps/neurohub/server/lib/musaKnowledgeLoader.ts` — на каждый chat-call, mtime cache 60 мин

Когда обновляется знание:
- При commit любых изменений кода — git log automatically picks up
- При правке CLAUDE.md / KB-файлов — mtime invalidates cache
- При деплое — pm2 restart → следующий chat-call перечитывает свежее состояние
- НЕТ ручного шага — всё через файлы в репо

Governance (кто что может спросить):

**Босс (super_admin / role='admin'):**
- Любые детали проекта: архитектура, плагины, секреты (только статусы), баланс провайдеров, аналитика, бэкенд, БД, фичи toggle
- Управление через operator commands (yarsExecutor)
- Доступ ко всему content из CLAUDE.md/PITFALLS/KB

**Аутентифицированный КЛИЕНТ (role='user'):**
- ✅ Только о своих треках (по userId): статус генерации, refund, история, скачать
- ✅ Только о своих оплатах (по userId): сумма, баланс, последняя транзакция, refund history
- ✅ О публичной информации MuzaAi: цены, режимы, как пользоваться, FAQ
- ❌ НЕ узнаёт детали реализации (какие плагины, как устроена БД, где Suno, ключи)
- ❌ НЕ узнаёт о других юзерах (статистика, листинги, чужие треки)
- ❌ НЕ узнаёт админские инсайды (плеи реально/фильтрованные, конверсия, технические бэкенд-операции)

**Анонимный посетитель:**
- ✅ Только публичная информация (цены, режимы, FAQ, как зарегистрироваться)
- ❌ НЕ узнаёт никаких личных данных, никаких внутренностей

Реализация в `consultantPersona.ts`:
- `muzaRole` определяется в `routes.ts:2982-2989` по auth token (`admin`/`super_admin` или `null`)
- В system prompt добавляется блок «role=admin → full access» / «role=user → user-zone only» / «no auth → public-zone»
- LLM tools фильтруются по prefix `[ADMIN-ONLY` — для не-админов скрыты
- Tools используют `ctx.userId` для row-level filter (только свои треки/платежи)

Применяется к: всем каналам где Муза общается (web-чат /api/muza/chat, Telegram bot, Max bot, future channels). Не применяется к: транзакционным ботам (alerts только админу — там нет диалога).

Audit при code review:
- При добавлении нового LLM tool — обязательно prefix `[ADMIN-ONLY` если содержит чувствительные данные
- При расширении KB / persona prompt — проверить что нет утечек админских деталей в public-zone
- При изменении governance логики — обновить это правило

### User-memory-context rule (Eugene 2026-05-20)

**Музa держит контекст общения с авторизованным юзером. Сжимает воду — оставляет главное. При заходе в чат поднимает сохранённый контекст и общается как менеджер который помнит клиента. Новые факты подтягивает из кабинета (профиль, треки, платежи, премиум).**

Зачем: Босс «не начинаем с нуля каждый раз». Юзер сказал в прошлой сессии что хочет песню маме на 70-летие — Музa должна это помнить и спросить «как там подарок маме, понравилось?» в следующем заходе. Не «здравствуйте, чем могу помочь?» Никаких amnesia-агентов.

Архитектура хранения:

**1. Таблица `user_memory`** (1 строка на юзера):
- `user_id INTEGER PRIMARY KEY`
- `summary TEXT` — narrative-сжатие, 1-3 параграфа, что важно помнить (стиль, темы, контекст жизни, недавние интересы)
- `facts_json TEXT` — структурированные факты `{name, occupation, family, hobbies, music_preferences, important_dates, special_events, location}` — каждый ключ опционален
- `preferences_json TEXT` — предпочтения генерации `{voices, styles, lyrics_themes, languages, avoid_topics}`
- `last_updated_at INTEGER` — millis
- `message_count_summarized INTEGER` — сколько сообщений уже сжато
- `version INTEGER` — counter обновлений (для отладки/история)
- (optional) `history_jsonl_path TEXT` — путь к полному JSONL для аудита

**2. Pipeline сжатия** (background):
- После каждой N-й (default N=10) пары exchange (юзер+бот) — фоновый LLM call:
  - Input: предыдущий `summary` + facts_json + последние N сообщений (raw)
  - Output: новый `summary` + обновлённые facts (добавление/изменение)
  - Промпт: «Сжимай в narrative-форму. Сохраняй: имя, занятия, ключевые события (дни рождения, юбилеи), темы которые юзер обсуждал, упоминания близких людей, эмоциональный контекст. Удаляй: разовый smalltalk, общие фразы»
- Fire-and-forget: ошибка сжатия не блокирует основной chat-flow
- TTL: summary refresh не реже чем раз в неделю даже если N не достигнут (если юзер активен)

**3. При заходе в чат / каждом запросе** — система делает 2 вещи:
- a) **Memory snapshot**: грузит `user_memory.summary + facts_json + preferences_json`
- b) **Live cabinet snapshot**: SELECT из БД актуальное состояние юзера:
  - `users.name, country, phone, createdAt`
  - count generations (total / last 7d / last 24h)
  - last generation date + title
  - balance / paid_balance / bonus_tracks
  - premium_subscriptions (active tier + expires_at)
  - last payment date+amount
- Оба блока inject'ятся в system prompt как `[USER CONTEXT — MANAGER VIEW]` блок:
  ```
  Это {name} ({country}, регистрация {createdAt}).
  Что помнишь о нём: {summary}
  Ключевые факты: {facts_json_pretty}
  Предпочтения: {preferences_json_pretty}
  Активность: треков всего {N}, за неделю {N7}, последний «{lastTitle}» {lastDate}.
  Баланс: {balance}₽ (премиум: {premium_active ? tier : 'нет'}).
  Открой разговор как менеджер который видит этого клиента и помнит его историю — НЕ начинай с нуля.
  ```

**4. Cache invalidation:**
- Cabinet snapshot — TTL 5 минут (per-userId memoize)
- Memory snapshot — invalidated при successful compression (background job стучит в cache)
- При user-action (новая генерация / оплата / refund) — event-bus publishes `user.cabinet.changed:userId` → cache invalidates

**5. Privacy / governance:**
- Plain текст summary хранится в `data.db` — стандартная security (admin SSH-only access)
- НЕ хранить в `facts_json` секретов (passwords, OTP, payment-tokens) — нормализатор очищает
- Юзер видит «что Музa помнит обо мне» через `/dashboard → 🧠 Память Музы` (transparency)
- Кнопка «Забыть» → DELETE user_memory row + audit-log + сброс facts на null
- GDPR-completeness: при удалении аккаунта `user_memory` тоже удаляется cascade

**6. Admin UI:**
- Вкладка в `/admin/v304 → 🧠 Память юзеров` — list всех юзеров с memory summary preview
- Click → drawer с полным `summary + facts + preferences + history of versions`
- Admin может: edit (override), force-recompress (trigger ручного сжатия), delete (с confirm-flow по Admin-everything-except-delete rule)
- Audit-log: каждая admin-правка пишется в `admin_audit_log`

**7. Endpoints:**
- `GET /api/account/memory` (auth) — юзер видит свою память
- `POST /api/account/memory/forget` (auth) — юзер удаляет свою память
- `GET /api/admin/v304/user-memory[?userId=X]` (admin) — список или один юзер
- `POST /api/admin/v304/user-memory/:userId/recompress` (admin) — force-trigger
- `PUT /api/admin/v304/user-memory/:userId` (admin) — manual edit
- `DELETE /api/admin/v304/user-memory/:userId` (admin) — с confirm

**8. Что НЕ делает (anti-pattern):**
- ❌ НЕ держит full raw message history в memory-таблице — для аудита есть `chatbot_messages`, memory это distillation
- ❌ НЕ блокирует chat-response на compression (всегда async)
- ❌ НЕ перезаписывает factor при противоречии — добавляет в `facts_json.history[]` для аудита
- ❌ НЕ injectit memory в anonymous-чате (только при authedUserId)

Применяется к: всем chat-каналам авторизованных юзеров (web /api/muza/chat, Telegram bot с linked user, Max bot с linked user, future channels). НЕ применяется к: анонимным посетителям (там session-only context).

Связано с: Cross-channel conversation linking rule (один thread по userId), Musa-knowledge-governance rule (что Музa может рассказать клиенту), Single-persona-across-channels rule (одна персона помнит этого клиента независимо от канала).



**Воспроизведение Suno-треков (и любых других private audio) в `<audio>` тегах требует 3-уровневой защиты. Cookie-fallback на сервере + use-credentials на клиенте + Range support — обязательны вместе.**

ROOT CAUSE «треки не загружаются, выдаёт ошибку»:
- `<audio>` теги в браузере **НЕ** отправляют `Authorization: Bearer` headers (только `fetch()` это умеет)
- `crossOrigin="anonymous"` на `<audio>` **отключает** отправку cookies (для same-origin тоже)
- iOS Safari без `Accept-Ranges` header не понимает как читать audio для scrubbing

Решение (3 части, все обязательны):

**1. Server — `/api/stream/:id` принимает auth из 3 источников** (priority order):
```ts
const cookieToken = (() => {
  const raw = req.headers.cookie || '';
  const m = raw.match(/(?:^|;\s*)auth_token=([^;]+)/);
  return m ? decodeURIComponent(m[1]) : '';
})();
const stToken =
  (req.headers.authorization || '').replace('Bearer ', '') ||
  (req.query.token as string) ||
  cookieToken || '';
```

**2. Client — `crossOrigin="use-credentials"` для player audio** (`lib/lockscreen.ts`):
```ts
audio.crossOrigin = "use-credentials"; // НЕ "anonymous" — блокирует cookies на Safari
```

**3. Server — Accept-Ranges + Range request support** в tryServeLocal:
```ts
res.setHeader("Accept-Ranges", "bytes");
const range = res.req.headers.range;
if (range && /^bytes=\d*-\d*$/.test(range)) {
  // Status 206 Partial Content + Content-Range header
  // fs.createReadStream({ start, end }) → pipe
}
```

Проверка работы (verify на VPS):
```
TOK=$(sqlite3 /var/www/neurohub/data.db "SELECT token FROM sessions ORDER BY last_seen_at DESC LIMIT 1;")
curl -sI -H "Cookie: auth_token=$TOK" 'localhost:5000/api/stream/<ID>' | head -5
# Ожидаем: HTTP/1.1 200 OK + Content-Type: audio/mpeg + Accept-Ranges: bytes
```

Применяется к: `/api/stream/`, `/api/download/`, `/api/cover/`, любым future binary endpoints. **НЕ** применяется к чисто JSON API.

Не использовать никогда:
- ❌ `crossOrigin="anonymous"` на `<audio>` элементах (рушит cookie auth)
- ❌ Только Bearer header validation (audio teги не шлют его)
- ❌ Только Cache-Control max-age без Accept-Ranges (iOS scrub ломается)

Reference: subagent ad6390730 atom-level audit (root cause #3 с 40% — Safari crossOrigin блокирует cookies).

### Playlist-category-no-mix rule (Eugene 2026-05-19)

**Категории треков (песни / поздравления / инструментальная) — это разделяющие параметры. Они НЕ перемешиваются в плейлисте. Внутри выбранной категории дальше работает сортировка (по дате / рейтингу / случайно / топ за месяц).**

Двухуровневая фильтрация:

1. **Уровень 1 — категория (mutually exclusive bucket):**
   - `all` — все треки
   - `song` — только песни
   - `greeting` — только поздравления
   - `instrumental` — только инструментальная
   - Реализация: `categoryFiltered = musicTracks.filter(t => (t.category || 'song') === categoryFilter)` в landing.tsx:1210
   - Категории НИКОГДА не смешиваются в одном плейлисте

2. **Уровень 2 — sort (внутри категории):**
   - `date` (новые сверху / снизу)
   - `rating` (по plays / лайкам)
   - `random` (случайный порядок, перетасовка)
   - `top_month` (топ за месяц)
   - Реализация: `/api/playlist?sort=X&dir=Y` server-side; результат уже отсортирован к моменту фильтрации category на client

Порядок применения **строго** такой: сначала category-bucket (1), потом sort внутри (2). search-query применяется поверх обоих как 3-й уровень (matchesSearch).

Применяется к: landing.tsx плейлист, dashboard.tsx «Мои треки», track.tsx, любым будущим списочным компонентам с category+sort параметрами. Не применяется к: явному playTrack(specificTrack) или admin-листингам которые показывают всё без разделения.

Пример того что НЕЛЬЗЯ делать: «выбрал Песни, сортировка date → играет следующий из Поздравления потому что новее». Это противоречит правилу. Между категориями переход — ТОЛЬКО через user смену categoryFilter.

Связано с Playlist-strict-selection rule (тот говорит «играем только filtered», этот говорит «как именно строится filtered»).

### Swipe-row-spring-back rule (Eugene 2026-05-22)

**После любого swipe-движения row плейлиста влево/вправо (горизонтальный drag), при release пальца — row плавно возвращается в исходное положение (translate = 0).** Если threshold НЕ перейден (action не trigger'нулся) — row возвращается полностью. Если threshold перейден (например ≥60px) и action сработал — row тоже возвращается в исходное (потому что после action визуальный state меняется через другие state-changes).

**Применяется к:**
- Track rows в top-100 panel (если когда-то будут swipe gestures)
- Track rows в countries panel (long-press на flag)
- Track rows в reverse-tablet playlist
- Любые future swipe-enabled rows в плеере / dashboard / track list

**Реализация (эталон):**

```jsx
<li
  onPointerDown={(e) => {
    swipeStartRef.current = { id: t.id, startX: e.clientX };
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
  }}
  onPointerMove={(e) => {
    if (!swipeStartRef.current) return;
    const delta = e.clientX - swipeStartRef.current.startX;
    setSwipeOffsetMap(prev => ({ ...prev, [t.id]: Math.max(-120, Math.min(delta, 120)) }));
  }}
  onPointerUp={(e) => {
    const delta = e.clientX - swipeStartRef.current.startX;
    swipeStartRef.current = null;
    // Trigger action если threshold (≥60 / ≤-60)
    if (delta > 60) { /* swipe-right action */ }
    else if (delta < -60) { /* swipe-left action */ }
    // ВСЕГДА reset offset — spring-back через CSS transition
    setSwipeOffsetMap(prev => { const next = { ...prev }; delete next[t.id]; return next; });
  }}
  onPointerCancel={() => {
    // Pointer cancel (например юзер свернул app) → тоже reset
    swipeStartRef.current = null;
    setSwipeOffsetMap(prev => { const next = { ...prev }; delete next[t.id]; return next; });
  }}
  style={{
    transform: swipeOffsetMap[t.id] ? `translateX(${swipeOffsetMap[t.id]}px)` : undefined,
    transition: swipeOffsetMap[t.id] ? "none" : "transform 0.3s ease-out",
  }}
>
```

**Жёсткие требования:**

1. **`transition: "none"`** во время drag (offset > 0) → real-time follow finger без lag
2. **`transition: "transform 0.3s ease-out"`** при release → smooth spring-back ~300ms
3. **`onPointerCancel` обязателен** — освобождает state если pointer interrupted (system suspend, multi-touch confusion, browser context switch). Иначе row залипает в transformed состоянии.
4. **`setPointerCapture` обязателен** — гарантирует full drag tracking даже если finger вышел за element bounds
5. **`releasePointerCapture` при onPointerUp** — освобождает (try/catch wrapping для safety)

**Анти-паттерны (что НЕЛЬЗЯ):**

- ❌ `transition: "transform 0.3s ease-out"` ВСЕГДА (включая во время drag) — row тормозит за пальцем, не follow
- ❌ `style={{ transform }}` без transition reset — после release row резко прыгает в 0 (jerk)
- ❌ Опускать `onPointerCancel` — pointer interrupt оставляет row в transformed state
- ❌ Использовать `setState({swipeOffset: 0})` для return-to-zero вместо `delete` from map — лишний render

**iOS / Mobile safety:**

- `touch-pan-y` Tailwind class на row (или container) → vertical scroll работает параллельно с horizontal swipe
- `setPointerCapture` важен на iOS Safari (pointer events могут drop'аться)
- Threshold 60px достаточен чтобы не triggernuть случайно при пальце которые слегка дрожит

**Применяется к:** ВСЕМ horizontal swipe row-based interactions в проекте. Не применяется к: vertical scroll (естественный browser behavior), pinch (multi-touch), pan-2-finger.

---

### Playlist-strict-selection rule (Eugene 2026-05-19, **ПРИОРИТЕТ #1 для плеера** — Eugene 2026-05-21 reinforce)

**Воспроизведение плейлиста идёт СТРОГО по выбранным параметрам сессии — какой плейлист выбран, тот и играет. Никаких sneaky fallback'ов на полный список треков. ЭТО ГЛАВНОЕ ОБЕЩАНИЕ ПЛЕЕРА ЮЗЕРУ: «нажал play в этом плейлисте → следующий трек из этого же плейлиста».**

Eugene 2026-05-21 Босс: «если человек нажал play в конкретном плейлисте, ожидает что следующий трек из того же отображённого. Поддерживать плейлист пользователя — приоритет».

Параметры сессии (накапливаются user input'ом + persist в localStorage):
- `playlistKind` (main / new authors)
- `categoryFilter` (all / song / greeting / instrumental)
- `searchQuery` (free-text)
- `sortMode` (date / rating / random / top_month) + `sortDir`

Все они складываются в `filteredMusic` (computed) → `filteredMusicRef.current` (synced).

Реализация (landing.tsx):
- `handleEnded`, `skipPrev/skipNext`, `expandPrev/expandNext`, `previoustrack/nexttrack` (MediaSession), voice-action `resume/prev/next` — ВСЕ используют `filteredMusicRef.current || []`
- Если filtered пуст → останавливаемся (`setPlayingId(null)`)
- НЕ применяем fallback на `tracksRef.current` (full unfiltered) — это и был баг «играет трек не из той категории»

Антипаттерн который правило закрывает: код `const list = fl && fl.length > 0 ? fl : tracksRef.current.filter(...)` — теряет контекст когда юзер сужает фильтр. Был ранее заявлен как «iOS safety», но Persistent-audio-only rule (commit 8d047e1) полностью закрыл lock-screen handoff — fallback больше не нужен.

Применяется к: landing.tsx плейлист, dashboard.tsx «Мои треки», track.tsx, и любым будущим audio-listing страницам. Не применяется к: явному playTrack(specificTrack) — там пользователь сам указал id.

### Track-duration-backfill rule (Eugene 2026-05-21)

**Продолжительность трека ВСЕГДА проверяется и отражается в плейлисте.** Если duration=0 (битый Suno metadata, broken result, ручная загрузка mp3) — автоматический backfill из audio metadata при первом воспроизведении.

Pipeline:
- При `audio.onloadedmetadata` в плеере, если `audio.duration > 0` И `track.duration < 1`:
  → POST `/api/generations/:id/duration` `{duration: N}`
- Сервер записывает в `generations.resultData.result[0].duration` (idempotent — только если existing < 1)
- Следующий refresh плейлиста → row показывает корректное «3:32»

Применяется к: landing.tsx playlist player (главная), dashboard.tsx player (личный кабинет), track.tsx player (страница трека), любым future плеерам. НЕ применяется к: streamonly preview без metadata loading.

Также (опционально, не блокер): admin cron `/api/admin/v304/backfill-durations` для bulk-обработки старых треков с duration=0 — без воспроизведения юзером, через ffprobe или head-request к mp3.

Reference: endpoint `/api/generations/:id/duration` в routes.ts:9687, frontend hook в landing.tsx audio.onloadedmetadata.

### Volume-control-cross-platform rule (Eugene 2026-05-21)

**Регулировка громкости в плеере ВСЕГДА работает на всех платформах** — desktop (Chrome/Safari/Firefox), Android Chrome, iOS Safari, iPad.

**Проблема которую правило закрывает:** iOS Safari (и WebKit на iPad) ИГНОРИРУЕТ `HTMLMediaElement.volume` — это read-only swizzled на system volume. Программное `audio.volume = X` не действует. Юзер двигает slider — UI меняется, звук не меняется.

**Решение по MDN/WebKit spec:** Web Audio API GainNode между `<audio>` source и destination — gain.value управляется независимо от system volume.

Реализация:
- `apps/neurohub/client/src/lib/lockscreen.ts` — `setPlayerVolume(audio, v)` + helpers
- ВСЕ места установки volume идут через `setPlayerVolume()` — НЕ через `audio.volume = X` напрямую
- AudioContext создаётся lazy (при первом setPlayerVolume) — `createMediaElementSource` можно вызвать ONLY ONCE на element, поэтому persistent singleton (по Persistent-audio-only rule)
- При suspended state → `audioCtx.resume()` (iOS требует user gesture)

Применяется к: всем VolumeSlider компонентам, всем audio плеерам. НЕ применяется к: TTS one-shot (там кратко без user volume control), background music modules (если будут).

Anti-pattern:
- ❌ `audio.volume = 0.5` напрямую → НЕ работает на iOS
- ✅ `setPlayerVolume(audio, 0.5)` → работает везде

Reference: lockscreen.ts `setPlayerVolume`, landing.tsx volume useEffect + playTrack.

### Layout-fit-no-overlap rule (Eugene 2026-05-21, **применяется ко всему проекту**)

**Любой текст и UI-элемент ВСЕГДА вписывается в свои рамки и НЕ накладывается на смежные/параллельные элементы — на ЛЮБОМ устройстве и разрешении.**

Это глобальное правило для всего UI кода. При создании / правке любого компонента, страницы, модалки, FAB-кнопки — обязательно проверяй:

**1. Пропорции и размер шрифта:**
- Текст не вылезает за padding контейнера (используй `truncate`, `line-clamp-N`, `break-words`, `word-break: break-word`)
- Шрифт-size масштабируется по breakpoint'ам (`text-xs sm:text-sm md:text-base`)
- Long-text fields (название трека, описание) — `min-w-0` на flex-1 контейнере чтобы truncate работал
- Числа / IDs / timestamps — `font-mono` фиксированной ширины (не "прыгают" при изменении)

**2. Нахлёсты со смежными зонами:**
- Floating-элементы (Музa-FAB, FAB share, voice-button, S-кнопка) — проверь не перекрывают ли друг друга на конкретном breakpoint
- Live-индикаторы (playing badge, status pill) — НЕ ставить в том же углу что и action-button (см. fix `b07ba15` — playing+S overlap'или в top-right, разведены top-3 left-3 vs top-3 right-3)
- Modal/drawer/popup — `max-h-[calc(100vh - safe-area-top - safe-area-bottom)]` чтобы не вылезать за viewport
- Z-index конфликты — следить за стэком (FAB=z-40, modal=z-50, alert=z-60)

**3. Пересечение с параллельными элементами проекта:**
- Музa-FAB не перекрывает: chat drawer (поднимается на 62vh при chatOpen — Persistent-audio-only rule), bottom-nav на mobile, FAB кнопки на других страницах
- Cover details modal не перекрывается списком треков под ним (body.overflow:'hidden' + cleanup unmount — fix `3435351`)
- Toast уведомления (sonner) — в углу противоположном FAB-кнопкам
- Audio control panel — над bottom-nav, не под

**4. Multi-step окна (multistep forms, swipe-modals):**
- Каждый шаг укладывается в один viewport БЕЗ внутреннего scroll (если возможно)
- Если нужен scroll — выделить scroll-container (`overflow-y-auto` на body, header sticky)
- Stepper/progress-bar — фиксированный высотой, не "прыгает"
- Кнопки навигации (← Назад / Далее →) — фиксированный footer

**5. Разные гаджеты + разрешения (responsive):**
- **Mobile portrait** (320-639px): single column, large touch targets ≥ 44px (iOS HIG)
- **Mobile landscape** (640-767px): следить за вертикальной высотой — может не уместиться
- **Tablet portrait** (768-1023px): -20% scale от mobile-base (Responsive-tablet-cap rule)
- **Tablet landscape** (1024-1366px): desktop-like layout, но `max-w-` чтобы не растягивать слишком
- **Desktop** (1280+): centered content `max-w-7xl mx-auto`, secondary sidebar если нужно
- **iOS safe-area**: `env(safe-area-inset-top/bottom/left/right)` для notch + home indicator
- **iPad Pro 1024-1366** портрет — особый ад (sm + md обе могут активироваться) — testить отдельно

**6. Чек-лист перед commit'ом UI-фичи:**
1. Mobile 375px (iPhone) — открыть → нет горизонтального scroll, текст не обрезан, кнопки не перекрывают
2. Mobile 414px (iPhone Plus) — тот же тест
3. Tablet 768px portrait — открыть → элементы пропорциональны, не разорваны
4. Desktop 1280px — открыть → не вытянуто на весь экран, контент центрирован
5. Rotate device (portrait ↔ landscape) — layout не ломается
6. Откройте 2-3 modal'а / FAB одновременно (если возможно) — нет визуального стэка / overlap

**Anti-pattern который правило закрывает:**
- ❌ Hardcoded `w-[300px]` без responsive — на 320px-экране не помещается
- ❌ `position:absolute top-2 right-2` для двух разных элементов на одной обложке (live-indicator + S-кнопка — overlap, fix `b07ba15`)
- ❌ `<button>...long text without truncate...</button>` в flex row — push'ит другие элементы за viewport
- ❌ Modal с `max-h-[100vh]` без `env(safe-area-inset-*)` — iOS home indicator закрывает content
- ❌ Музa-FAB фиксированной позиции без recompute при chatOpen → перекрывает chat drawer

**Применяется к:**
- ВСЕМ новым / правленым UI компонентам (страницы, модалки, FAB, формы, кнопки, indicators)
- ВСЕМ существующим компонентам — при следующей правке проверяй на эти 6 пунктов

**Reference fixes:**
- `b07ba15` — live-indicator vs S-кнопка overlap (top-3 right-3 → top-3 left-3)
- `3435351` — cover-modal body.overflow cleanup (главная зажималась)
- `90b83fc` — Музa universal positioning (real sizes + safe-area + chatOpen offset)
- `34c30ce` — swipe modal responsive (safe-area + cover max-h по breakpoints)

### LLM-key-functional-check rule (Eugene 2026-05-21)

**Ключ считается ДЕЙСТВУЮЩИМ только если может выполнять функционал Музы — отвечать как 25-летняя помощница MuzaAi на русском.** Базовый ping endpoint'а («HTTP 200 OK») НЕДОСТАТОЧЕН.

Functional check (`apps/neurohub/server/plugins/api-health/module.ts`):

**Test prompt:**
- system: «Ты — Музa, 25-летняя девушка-помощница MuzaAi. Отвечай в женском роде, по-русски.»
- user: «Привет! Скажи коротко: чем ты можешь помочь автору песен?»
- max_tokens: 60

**Verify reply через `isFunctionalMuzaReply(text)`:**
- ✅ non-empty
- ✅ length 5-500 chars (не too short / not garbage long)
- ✅ Содержит кириллицу (Музa отвечает по-русски)
- ❌ НЕ содержит deny-паттерны: `as an ai`, `i cannot`, `i'm sorry, but i`, `я не могу`, `не имею возможности`

**Применяется к проверкам:**
- `checkDeepSeek()` — DEEPSEEK_API_KEY
- `checkTimeWebGateway()` — TIMEWEB_GATEWAY_KEY
- `checkAnthropicKey()` — все 3 Anthropic ключа (ANTHROPIC_API_KEY / _BACKUP / _BOT)
- `checkGptunnel()` — GPTUNNEL_API_KEY (для chat)

**Что показывается в UI** (`/admin/v304 → 🔑 API ключи`):
- 🟢 ok — ключ functional, Музa отвечает по правилам
- 🔴 fail с конкретной причиной:
  - `empty response` — ключ принял, но не вернул text
  - `too short (N chars)` — coomon garbage reply
  - `no Cyrillic in reply — не русский язык` — модель ответила на English
  - `deny-pattern detected (LLM отказал)` — модель отказалась («I cannot...»)
  - `model deprecated` — Anthropic вернул `invalid_request_error`
  - `HTTP N` — endpoint error

**Anti-pattern:**
- ❌ Считать что ключ ok если только endpoint вернул 200 — он может вернуть пустой text / English deny / garbage
- ❌ max_tokens=1 ping — не покажет функционал
- ❌ Игнорировать deny-patterns — модель может быть rate-limited / content-filtered и возвращать I cannot

**Применяется к:** all LLM-key health checks в проекте. НЕ применяется к: STT/TTS (там свои functional checks — Yandex SpeechKit / Yandex TTS).

Reference: commit с расширением checks, helper `isFunctionalMuzaReply` в api-health/module.ts.

### Counter-live-update rule (Eugene 2026-05-21)

**Любые live-счётчики (PlaysCounter, future counters визитов/выручки/whatever) обновляются ТОЛЬКО через локальный setState — без перезагрузки страницы. Никаких `window.location.reload()` при обновлении data.**

Pipeline (PlaysCounter — эталон):
1. `useEffect` создаёт `setInterval(fetchStats, 60_000)` — каждые 60 сек
2. `fetchStats` делает `fetch('/api/playlist/stats', { cache: 'no-store' })` — обходит browser HTTP cache
3. Server возвращает свежие данные (cache server 30s + invalidate при play)
4. `setState({totalPlays, totalTracks})` → React re-render **только PlaysCounter component**
5. Остальная страница (playlist, header, navigation) — НЕ затрагивается
6. Detect rise → blink digit → dispatch `muza:counter-up` → ракета вылетает
7. После ракеты → blink-post → idle

**Что КАТЕГОРИЧЕСКИ запрещено:**
- ❌ `window.location.reload()` для обновления counter'а — это full page reload (юзер теряет scroll, audio останавливается на mobile)
- ❌ `window.location.href = window.location.href` (то же самое)
- ❌ Router push без cache (SPA-внутренние reloads)
- ❌ Refetch ВСЕЙ страницы (refetch только counter-specific data)

**Service Worker auto-update — exception:**
SW делает silent reload **ТОЛЬКО при появлении новой версии сайта** (deploy). Это редкое событие (≤1 раз в час обычно). Не для counter update.

Reference:
- `components/plays-counter.tsx` — setInterval + setState pattern
- `lib/registerSW.ts` — controllerchange listener (SW auto-update)
- routes.ts `/api/playlist/stats` — server cache 30s + invalidate при play

Применяется к: всем future live-counters (visitors, revenue, generations, plays).

### Brand-rocket-asset rule (Eugene 2026-05-21)

**Любые визуальные графические элементы (ракеты, иконки, декор, illustrations) на сайте — в brand-цветах MuzaAi: purple `#7C3AED`, fuchsia `#D946EF`, cyan `#06B6D4`, electric blue `#00D4FF`. И ОБЯЗАТЕЛЬНО рядом с ними по палитре** (близкие оттенки: purple-300 `#c084fc`, fuchsia-300 `#f0abfc`, cyan-300 `#67e8f9`, cyan-100 `#a5f3fc`).

Reference: `Brand-style consistency rule` (палитра в index.css). НЕ использовать вне brand:
- ❌ amber (`#fde68a`, `#fbbf24`) — кроме live-индикаторов (status pills)
- ❌ red (#ef4444) — кроме error states
- ❌ green (#22c55e) — кроме success states
- ❌ generic gray (#6b7280) — только для нейтрального текста / borders

**Реализованные brand-assets:**
- `components/brand-rocket.tsx` — inline SVG ракета в gradient brand (purple→fuchsia, cyan window, fuchsia wings, fuchsia→cyan flame). Drop-shadow fuchsia+purple glow.
- `components/plays-counter.tsx` — fuchsia/cyan/purple text-shadow на цифрах
- `components/rocket-launch.tsx` — использует BrandRocket

При добавлении нового graphics-element:
1. Проверь brand palette в `index.css` (`.gradient-text`, `.btn-cosmic`, и т.д.)
2. Используй gradient `from-purple-500 via-fuchsia-500 to-cyan-500` или solid из палитры
3. Drop-shadow / text-shadow тоже из палитры (rgba purple/fuchsia/cyan)
4. Если нужен warmer accent — используй pink-300/400 (близко к fuchsia, но мягче) вместо amber
5. SVG inline в TSX компоненте — не отдельные .svg файлы для critical brand graphics

Reference: commit с brand-rocket, `brand-rocket.tsx`, `CLAUDE.md → Brand-style consistency rule`.

### Star-suggestion rule (Eugene 2026-05-21)

**При предложении новой «мировой звезды» (counter «i» popup) ссылка на Instagram ОБЯЗАТЕЛЬНА.** Для existing звёзд (повторный голос) — опционально.

Validation Instagram URL:
```
/^https?:\/\/(www\.)?instagram\.com\/[A-Za-z0-9_.]+\/?(\?.*)?$/i
```

- Можно ввести `@username` — frontend/backend перепишет в `https://www.instagram.com/<username>`
- Если URL не валиден или пуст для NEW name → `{ok:false, error:"Ссылка на Instagram обязательна. Формат: https://www.instagram.com/<username>"}`
- Если name existing и URL пустой — vote OK (увеличиваем counter), profile_url не меняется
- Если name existing и URL задан + было пусто — обновляем profile_url

Rate limit: НЕТ ограничений по времени (Eugene 2026-05-21 «ограничений нет по времени Star»). `star_votes_log` остаётся для audit но без блокировки.

Seed: «Leonardo DiCaprio» → `https://www.instagram.com/leonardodicaprio` (Eugene 2026-05-21: правильное написание, было «Leo Di Caprio»)

При нажатии на имя в рейтинге → открывается в новой вкладке (`target="_blank" rel="noopener noreferrer"`).

Reference: routes.ts `/api/star-suggestions/vote` + `top`, schema `star_suggestions(name_normalized PK, name_display, profile_url, votes, ...)`, UI в `plays-counter.tsx`.

### User-anim-preference rule (Eugene 2026-05-21)

**Mini-toggle кнопка возле визуальных эффектов (PlaysCounter, future animations) — выключение на 1 день. Если юзер 3 дня подряд выключает — сохранить до явного включения. Identification по IP.**

Pipeline:
- Frontend: маленькая кнопка ✦/○ снизу-справа counter'а. onClick → POST `/api/user-preferences/anim-toggle` с `{enabled: bool}`.
- Server: таблица `anim_preferences (ip, disabled_until, consecutive_disables, permanent_off, last_toggle_at)`.
- Логика toggle OFF:
  - Записываем `disabled_until = now + 24h`
  - Если предыдущий toggle (OFF) был в окне ≤ 25 часов → `consecutive_disables++`
  - При `consecutive >= 3` → `permanent_off = 1` (хранится до явного `enabled: true`)
- Логика toggle ON: сбрасываем `permanent_off`, `consecutive_disables`, `disabled_until=NULL`.
- GET `/api/user-preferences/anim-state`: возвращает `{enabled, reason, disabledUntil, consecutiveDisables, permanentOff}`.

Применяется к: PlaysCounter (pulse, orbits, comet, equalizer bars), future animated widgets на главной/кабинете. НЕ применяется к: критическим UI feedback (loader spinner, button press, error shake — это affordance не анимация).

Compat с `prefers-reduced-motion` rule: если юзер motion-sensitive (OS-level) — animations off независимо от toggle. Toggle — дополнительный fine-grained control.

Reference: commit с реализацией. Frontend: `components/plays-counter.tsx` toggleAnim state + button ✦/○ в правом нижнем углу.

### LLM-chain-order rule (Eugene 2026-05-21)

**Порядок попыток LLM-провайдеров Музы — DeepSeek первый (дешевле), TimeWeb второй, далее Anthropic по имени sort (API_KEY → _BACKUP → _BOT), последний резерв — GPTunnel.**

Полный chain (`apps/neurohub/server/lib/llmCore.ts` функция `callUnifiedMuzaLLM`):

| # | Provider | ENV | Default model | Tools |
|---|---|---|---|---|
| 1 | **DeepSeek (PRIMARY)** | `DEEPSEEK_API_KEY` | `deepseek-chat` | ❌ |
| 2 | TimeWeb Gateway | `TIMEWEB_GATEWAY_KEY` | `anthropic/claude-haiku-4-5` | ❌ |
| 3 | Anthropic | `ANTHROPIC_API_KEY` | `claude-haiku-4-5-20251001` | ✅ tool-use loop |
| 4 | Anthropic backup | `ANTHROPIC_API_KEY_BACKUP` | то же | ✅ |
| 5 | Anthropic bot | `ANTHROPIC_API_KEY_BOT` | то же | ✅ |
| 6 | GPTunnel (last resort) | `GPTUNNEL_API_KEY` | `gpt-4o-mini` | ❌ |

**Tools (MUZA_TOOLS — get_user_balance, save_song_draft, find_public_track, issue_invoice, и т.д.) работают ТОЛЬКО на Anthropic-шаге (#3-5).** DeepSeek / TimeWeb / GPTunnel возвращают clean text без function-calling.

Почему DeepSeek первым (а не Anthropic):
- **Цена**: $0.27/1M input + $1.10/1M output (vs Anthropic Haiku $0.80/$4.00, vs Claude Sonnet $3/$15)
- Качество достаточное для conversational chat (Музa в основном диалог)
- Tools всё равно недоступны на DeepSeek — если LLM просит tool, fallback на Anthropic в той же session не происходит на per-request basis; но если pattern требует tools — Anthropic возьмёт обработку.

**Anthropic порядок (sort by name)**: `ANTHROPIC_API_KEY → ANTHROPIC_API_KEY_BACKUP → ANTHROPIC_API_KEY_BOT` — alphabetical. Реализация в `listAnthropicKeys()`.

**Rate limits (известные):**
| Provider | Free tier | Paid (default) | Burst |
|---|---|---|---|
| **DeepSeek** | 0 — только Pay-As-You-Go | Нет жёстких rate limits для baseline use; ~60 req/sec не банится | OpenAI-compat retry-after на 429 |
| **TimeWeb Gateway** | Зависит от плана; gateway передаёт upstream limits | ≈Anthropic limits (gateway transparently proxies) | Same as upstream |
| **Anthropic** | $5/мес free tier (10 req/min) | Tier 1: 50 req/min, 50K tokens/min input | Auto-scaling с paid usage |
| **GPTunnel** | Нет free для chat (только Suno); for chat OpenAI-compat ($0.15-0.60/M depending model) | Soft limits |

**Применяется к:** LLM каналы Музы (web /api/muza/chat, Telegram, Max, future). НЕ применяется к: STT (Yandex SpeechKit), TTS (Yandex), Suno music generation (GPTunnel media-api).

Reference: commit с reorder, llmCore.ts функция `callUnifiedMuzaLLM`.

### Pair-link cross-channel rule (Eugene 2026-05-21)

**Из любого мессенджера (Telegram, Max, future каналы) Музa ГАРАНТИРОВАННО предлагает кликабельную ссылку на web-чат с подгрузкой истории. На web Музa приветствует юзера и продолжает разговор с того места где остановились в мессенджере.**

Формат ссылки (единый для всех ботов): `https://muzaai.ru/?pair=<CODE>` — где CODE = pair-code из `lib/webChatPair.ts`.

Pipeline:
1. **Bot detection** — после ≥2 exchange'ев юзера и бота, если ещё не offered → создать pair-code + добавить ссылку в конец reply.
   - НЕ random (раньше было `Math.random() < 0.3` — убрано «гарантированно надо»)
   - `shouldOfferPairCode(sessionId, channel)` проверяет что не offered ранее (idempotent)
2. **Юзер клик** → открывается `muzaai.ru/?pair=CODE`
3. **Frontend** (`floating-consultant.tsx`):
   - useEffect на mount: detection ?pair= в URL → setVisible(true) + auto openChat() (200ms delay)
   - initChatSession: читает ?pair= → POST `/api/muza/chat/init {pairCode}` → server линкует session
   - После использования — query param removed (replaceState) — F5 не дёргает повторно
4. **Server** (`/api/muza/chat/init`):
   - Если pairCode валиден → находит session мессенджера → линкует web-session с ней (общий userId)
   - Загружает history из мессенджер-session + возвращает в response
   - Генерирует ОСОБОЕ приветствие (см. ниже)
5. **Greeting на web** (routes.ts:2796-2814):
   - «Привет! 🎵 Я узнала тебя — мы только что общались в Telegram/Max.»
   - Цитата ПОСЛЕДНЕГО user message + ПОСЛЕДНИЙ bot reply (80 chars)
   - «Продолжим прямо отсюда — на чём мы остановились?»

Применяется к: telegram-bot, max-bot, future каналы. НЕ применяется к: anonymous web-чат (там нет источника для pair).

Anti-pattern:
- ❌ Текст «шепнёшь код XYZ» без кликабельной ссылки — юзер не знает что нажимать
- ❌ Random offer (30%) — половина юзеров не увидит ссылку
- ❌ Generic greeting «Привет» без context — юзер не понимает что Музa помнит его

Reference: commit `378b9b6` (pair-link + auto-open chat), commit с улучшением greeting + max-bot pair.

### Player-tap-actions rule (Eugene 2026-05-21, **перекрывает Player-expand-no-restart rule**)

**В плейлисте на главной два action'а разделены: маленькая обложка → ПУСКАЕТ воспроизведение, строка трека (title + author) → РАСКРЫВАЕТ обложку (inline под строкой).**

Конкретика:
- **Mini-cover click** (40×40 px квадратик слева) → `togglePlay(track)`:
  - Если этот трек уже играет → pause (или resume если на паузе)
  - Если другой → playTrack (start playback, switch player)
  - НЕ раскрывает большую обложку
- **Row click** (title + author, flex-1 справа от cover) → `setExpandedId(track.id)`:
  - Раскрывает inline обложку под строкой текущего трека (между current row и next row)
  - Повторный клик по той же строке → collapse
  - НЕ запускает playback
  - Скролл до раскрытого через `scrollIntoView({block:'center'})` через 100ms
- **Раскрытая обложка** — inline в DOM (не модально):
  - Mobile: aspect-square cover между row N и row N+1
  - Desktop: то же самое — между current row и next row (вверху списка следующего)
  - Внутри обложки — controls (play/pause/skip/lyrics/share)
- **Тап по самой раскрытой обложке** (вне controls) → collapse, но с **500ms cooldown** (см. Accidental-tap-protection rule ниже).

Применяется к: landing.tsx playlist UI (mini-cover handler line ~1837, row handler line ~1871). НЕ применяется к: large-player FAB controls (отдельные explicit buttons), CoverDetailsModal swipe-mode (там свои handlers).

**Этот rule перекрывает старый `Player-expand-no-restart rule (2026-05-19)`** — там cover делал expand. Босс новой формулировкой инвертировал: cover = play, row = expand. Старая логика сохранена в Git history.

### Player-expand-no-restart rule (Eugene 2026-05-19, **DEPRECATED — см. Player-tap-actions rule**)

**При нажатии на mini-обложку трека в плейлисте — раскрываем большой плеер. Если этот трек уже играет в основном плеере — продолжаем воспроизведение без рестарта. Если другой — раскрываем большую обложку и ЖДЁМ команды пользователя (не запускаем auto-play).**

Зачем: текущее поведение (call togglePlay при expand) приводит к двум проблемам:
1. Если кликнул на трек который уже играет → передёргиваем audio (потеря timecode, может прервать lock-screen ownership)
2. Если кликнул чтобы просто ПОСМОТРЕТЬ обложку другого трека → насильно начинаем играть, даже если юзер не хотел

Правильное поведение:
- `sameTrackPlaying = playingId === track.id` → expand-only, audio не трогаем
- Иначе → expand-only, юзер сам жмёт `▶` на большой обложке
- Lock-screen ownership сохраняется (Persistent-audio-only rule)
- Никаких сюрпризов: «открыл посмотреть → начало играть» больше нет

Реализация в `landing.tsx`:
- Cover-thumb click (line ~1799) и row-body click (line ~1842)
- Оба handler'а — `setExpandedId(track.id)` + scrollIntoView, БЕЗ `togglePlay`

Применяется к: всем местам где есть «mini-cover → expand-big-cover» UI (landing.tsx playlist, dashboard.tsx «Мои треки», track.tsx). Не применяется к: явному Play-button клику на mini (там togglePlay обязательно).

### Windows-in-viewport + draggable rule (Eugene 2026-05-19)

**Любое плавающее окно (modal, floating-FAB, popup, speech-bubble, tooltip, drawer) ВСЕГДА остаётся в рамках viewport. Если оно может быть перемещаемо — пользователь может его таскать пальцем/мышью.**

Зачем: на iPad/iPhone элементы часто выпадают за edge экрана (особенно при rotate / split-view / маленьком safe-area). Юзер не может прочитать / dismiss / drag = плохой UX. Также: пусть юзер позиционирует помощников там где удобно ему.

Реализация:
- `apps/neurohub/client/src/lib/clampViewport.ts` — единая утилита
  - `clampToViewport(x, y, w, h, padding=8)` — возвращает безопасные координаты
  - `readPos(key) / writePos(key, pos)` — persist в localStorage
  - `useDraggablePosition(storageKey, defaultPos, size)` — hook с polished drag/resize
- При drag — `setPointerCapture` чтобы pointerup ловился даже если курсор ушёл за element
- При window resize — auto-clamp обратно в рамки (юзер minimise'ил окно → элемент возвращается)
- Persist в localStorage под уникальным ключом (по компоненту)

Применяется к:
- floating-consultant (Муза-FAB) — drag handle активен
- walking-musa (auto-tour + mouse-follow) — уже draggable
- Speech bubbles рядом с draggable элементами — авто-side (left/right) в зависимости от позиции parent
- Любые user-positionable plates (mini-player, sticky toolbar)

НЕ применяется к:
- Modal-overlay (CoverDetailsModal, FeatureTogglesPanel) — они и так centered + max-h-[88vh] (внутри scroll)
- Системные tooltip над hover'енным элементом — Tippy/Floating UI справляется

Pre-commit чек:
- Все floating-elements с fixed/absolute позицией прошли через `clampToViewport()` хотя бы при init и resize
- Если у элемента есть drag — handle visible (cursor: grab) или явный drag-icon
- localStorage ключ задан и unique

### Responsive-tablet-cap rule (Eugene 2026-05-19)

**На tablet (sm: 640-1023px) и desktop (md/lg: 1024+) UI-блоки масштабируются на -20% относительно «нормального» mobile-base. Юзер может вернуть/увеличить через size-toggle (sm/md/lg).**

Зачем: на iPad 1024×1366 «нормальный» mobile-сайт выглядит слишком крупно — обложка плеера занимает 30% экрана, кнопки большие, всё пустое. Tablet — это не «большой телефон», там воспринимается как desktop. Уменьшение на 20% даёт ощущение десктопного приложения, не «увеличенного телефона».

Реализация:
- Tailwind `sm:` (≥640px) — НЕ копирует mobile-base, а уменьшает: `w-[88px] mobile → sm:w-[90px]` (≈20% меньше w-112)
- Desktop scale (через coverSize state «sm/md/lg»): default `md:scale-[0.8]` (sm), `md:scale-100` (md), `md:scale-125` (lg)
- localStorage `muzaai-cover-size` persists per-user
- ExpandToggleButton — для пользователей которым нужен крупный режим

Применяется к: всем элементам которые в mobile-base крупнее 64px (обложки, аватарки, hero buttons). Не применяется к: иконкам (24-32px), текстам, system-controls.

Пример (landing.tsx playing-track card):
- Mobile: `w-[88px]` — компактно для телефона
- Tablet (sm): `sm:w-[90px]` — то же, не растягиваем как раньше до 112
- Desktop scale (coverSize=sm): `md:scale-[0.8]` — ещё на 20% меньше
- Desktop scale (coverSize=md): `md:scale-100` — base
- Desktop scale (coverSize=lg): `md:scale-125` — для тех кому надо крупно

### Accidental-tap-protection rule (Eugene 2026-05-19)

**Если элемент развёртывается/раскрывается по клику — добавляем 500ms cooldown перед обработкой первого «свернуть»-клика. Защищает от случайных тапов, флика, отскока пальца после `tap-open`.**

Eugene 2026-05-21 Босс: «увеличь задержку случайного нажатия, лучшие настройки для таких случаев». 500ms — стандарт iOS double-tap detection (между двумя тапами максимум 500ms), значит палец отскочил и попал ещё раз — это не намерение свернуть, это случайный второй тап.

Реализация:
```tsx
const expandedAtRef = useRef<number>(0);
useEffect(() => {
  if (expandedId !== null) expandedAtRef.current = Date.now();
}, [expandedId]);

// В onPointerDown / onClick для collapse:
if (Date.now() - expandedAtRef.current < 500) return;
```

Применяется к: всем expand-blocks (cover modals, expanded track cards, accordion-секциям, swipe-modals). Не применяется к: явным крестикам ✕ / кнопкам «Закрыть» — там нужен мгновенный отклик.

Раньше было 350ms (Eugene 2026-05-19), но Босс попадал случайно — увеличено до 500ms по iOS Apple HIG (Human Interface Guidelines) double-tap threshold.

### Admin-Muza-message base + auto-apply rule (Eugene 2026-05-20)

**Каждое сообщение от админа (role admin|super_admin) в Музa-канал пишется в `admin_chat_messages`.** Если IP запроса входит в `ADMIN_TRUSTED_IPS` env (whitelist на VPS — «точка безопасности») — сообщение автоматически применяется через `executeYarsCommand()` (yarsExecutor — safe categories: `news_post`, `kb_update`, `persona_tweak`, `ui_text`). Если не выполнен хотя бы один параметр — пишется конкретный `authorization_mismatch` для diagnostic.

**Реализация:**
- Таблица `admin_chat_messages` (schema + storage migration): `session_id`, `user_id`, `channel`, `text`, `ip`, `user_agent`, `role`, `authorized` (0/1), `authorization_mismatch` (точный reason), `applied` (0/1), `applied_action` (JSON executor result).
- Helper `apps/neurohub/server/lib/adminChatRecorder.ts` — `recordAdminMuzaMessage()` с двумя gate'ами + auto-apply при passing both.
- Wire: `/api/muza/chat` (web), `/api/admin/v304/conversations/:id/inject-message`. TG/Max bots — добавляются по мере привязки admin TG/Max ID.
- Admin endpoint `GET /api/admin/v304/admin-chat-messages?limit=&authorized=1&channel=web` — список + summary + envInfo.

**Mismatch reasons (точные строки, по которым Босс понимает где провал):**
- `role:user (expected admin|super_admin)` — юзер не админ
- `role:anonymous (expected ...)` — нет auth
- `env:ADMIN_TRUSTED_IPS_empty (auto-apply disabled — set on VPS)` — whitelist не настроен
- `ip:unknown (request has no IP)` — req.ip отсутствует
- `ip:<masked> not in trusted_set (size=N)` — IP не в whitelist'е N IP

**Safe default:** если `ADMIN_TRUSTED_IPS` env пуст → auto-apply ВЫКЛЮЧЕН (запись в БД идёт всё равно, для audit). Это защита от misconfiguration.

**Установка trusted-IP на VPS** (Босс делает руками):
```
ssh root@31.130.148.107 'sed -i "/^ADMIN_TRUSTED_IPS=/d" /var/www/neurohub/.env && echo "ADMIN_TRUSTED_IPS=🔴IP1,IP2,IP3🔴" >> /var/www/neurohub/.env && chmod 600 /var/www/neurohub/.env && pm2 restart neurohub --update-env'
```

Применяется к: web `/api/muza/chat`, admin inject-message. Все остальные admin-actions через Музу идут через `requireAdmin` middleware + audit-log (отдельный путь).

### Muza-cabinet-management rule (Eugene 2026-05-20)

**Музa полностью управляет кабинетом + плейлистом автора при авторизации. КРОМЕ удалений и оплат. Счета можно выписывать в чате.**

Tools в `muzaTools.ts` (доступны юзеру при auth):
- `rename_my_track` — переименовать свой трек (1-120 символов)
- `set_my_track_category` — `song` / `greeting` / `instrumental` (синхронизирует voiceType)
- `set_my_track_visibility` — `private` / `new_authors` (main — только челофильтр >50 play/24ч или админ)
- `update_my_profile` — name / country (phone/email — отдельный confirm-flow)
- `issue_invoice` — выписать счёт (proforma) с готовой Robokassa-ссылкой. Тарифы: `track_399`, `premium_voice_msg`, `topup_500/1000/2000`, `custom`
- `get_my_subscriptions` — активные подписки автора

**Что НЕ может Музa (по правилу «кроме удалений и оплат»):**
- ❌ Удалять трек (`deleted_at` или hard-delete) — только через separate confirm-flow
- ❌ Удалять аккаунт юзера
- ❌ Списывать деньги напрямую (`charge_user`, `refund`, прямой `payments` UPDATE) — только через Robokassa init
- ❌ Менять чужие треки (`gen.userId !== ctx.userId` → отказ)
- ❌ Переводить в основной плейлист (`visibility=main`) — только челофильтр или админ

Аудит-trail: каждое действие пишет в `admin_audit_log` с `admin_email='muza-self-service'` — Босс видит кто/что Музa сделала от лица юзера.

Применяется к: всем channel'ам где Музa отвечает (web/TG/Max). LLM сама выбирает tool через function-calling.

### Premium voice-messages rule (Eugene 2026-05-20)

**Аудио-сообщения от Музы и админа в чате — premium-фича. Доступ авторам с подпиской.**

Schema:
- `chatbot_messages` расширена: `audio_url`, `audio_duration_sec`, `audio_premium_only` (0/1)
- `premium_subscriptions` table — `tier` (`voice_messages` | future tiers), `status` (`pending`/`active`/`expired`/`cancelled`), `invoice_id` FK
- `invoices` table — Музa-issued счета (см. Muza-cabinet-management rule).

Цепочка покупки (полностью wired в `/api/payment/result` от 20.05):
1. Юзер: «Хочу аудио-сообщения от Музы»
2. Музa вызывает `issue_invoice({tariff: "premium_voice_msg", description: "..."})` → `invoices` record + URL `/api/invoice/:id/pay`
3. Юзер открывает URL → `POST /api/payment/create {invoiceId}` → загружает invoice → Robokassa redirect (amount, description из invoice)
4. Юзер платит → Robokassa Result callback → `payment.status='paid'`:
   - Если `payment.invoice_id NOT NULL` — fulfillment по `invoice.tariff_key`:
     * `premium_voice_msg` → `premium_subscriptions.status='active'`, `expires_at=+30d` (продление при активной)
     * `topup_*` / `custom` → credit balance + topup-transaction
     * `track_399` etc → credit balance
   - Иначе — старая логика topup balance
5. Frontend gate: при `audio_premium_only=1` показывать только если `premium_subscriptions.status='active'` ИЛИ role=admin

Tariff → tier mapping в `routes.ts` (TARIFF_TO_TIER):
- `premium_voice_msg` → `voice_messages`, 30 дней
- (Будущие tier'ы добавляются туда же)

Idempotency: `if (invoice.status === 'paid') skip` — повторные Robokassa retries не дублируют activation.

Применяется к: chatbot_messages с audio_url. НЕ применяется к: текстовым сообщениям, музыкальным трекам (генерация — отдельная экономика per-track).

### Premium-lyrics rule (Eugene 2026-05-24)

**Качественная генерация лирики через 4-step refinement pipeline. Real Anthropic fine-tuning публично закрыт — реализация через prompt engineering + multi-step self-refinement (квалитативный uplift без своей fine-tuned модели).**

Доступ:
- **One-off:** 149 ₽ за один premium-draft (PRICES.premium_lyrics_oneoff = 14900)
- **Подписка:** 299 ₽/мес `tier='text_quality'` — безлимит на премиум-драфты

Pipeline (`apps/neurohub/server/lib/premiumLyrics.ts` → `generatePremiumDraft()`):
1. **Draft** — первый набросок 12-16 строк (как обычная генерация)
2. **Critique** — self-critique, ищет 3 слабых места (клише, рваный ритм, плоские эмоции)
3. **Refine** — переписывает текст целиком, исправляя найденные проблемы
4. **Polish** — финальная проверка размера, рифмы, структуры [Куплет/Припев/Бридж]

Каждый шаг — отдельный LLM-вызов через `callDeepSeek → callTimeWebGateway → Anthropic chain` (Reuse-working-solutions rule). DeepSeek первый (cheap). Cost ≈ 0.30 ₽ за весь pipeline → маржа 99%+ для one-off.

Endpoints:
- `POST /api/lyrics/premium-generate` (authMiddleware) — генерация. Returns `{id, lyrics, iterations, steps_used, viaSubscription, chargedKopecks}`.
- `GET /api/lyrics/premium-status` (authMiddleware) — статус подписки + цены для UI.
- При подписке active → cost=0, audit-log `via=subscription`
- При one-off → списание из balance + transaction type='lyrics_premium' + audit-log

Graceful degrade:
- Если LLM-цепочка вернула null на шаге 2/3/4 — возвращаем лучший доступный draft с `error` в response (юзер всё равно получил value, refund не делается)
- Если шаг 1 (Draft) упал — refund + ответ `refunded: true`
- Sanity hard limit 400 символов (Suno) — обрезаем по последней целой строке

Tariff → tier mapping (`routes.ts` TARIFF_TO_TIER):
- `premium_text_quality` → `{ tier: 'text_quality', days: 30 }`
- Активация через Robokassa Result callback (Premium voice-messages rule pattern)

UI (`/lyrics` page):
- Toggle-card между form-fields и кнопкой «Создать»
- При active подписке → badge «Включено в подписку» (emerald), free
- При не-подписке → badge «+149 ₽» (fuchsia)
- Modal «как работает» с описанием 4 шагов
- Badge `[✨ premium: draft→critique→refine→polish]` в результате

Применяется к: текстам песен через `/lyrics`. НЕ применяется к: covers, music generation, voice — у них собственные premium-tier варианты (см. PREMIUM-LYRICS.md → Future extensions).

Связано с:
- Pricing-single-source rule — цены в `PRICES` + `PREMIUM_TIERS` + `TARIFF_TO_TIER` + `muzaTools.ts TARIFFS`. При изменении — обновить ВСЕ места.
- Premium voice-messages rule — pattern для tier-based premium features.
- Reuse-working-solutions rule — wraps existing `storage.createGeneration` + `refundGeneration` + LLM chain + `saveGenFiles`.
- Backup-before-edit rule — audit-log per generation.
- Musa-knowledge-governance rule — Музa может предложить подписку через `issue_invoice({tariff:"premium_text_quality"})` в чате.

Documentation: `docs/PREMIUM-LYRICS.md` — полная спецификация, economics, API examples.

### iOS-lock-screen-audio rule (Eugene 2026-05-21, **навсегда зафиксировано**)

**На iOS Safari НИКОГДА не вызывать `AudioContext.createMediaElementSource()` на player audio — это ломает background playback при lock screen.**

**ROOT CAUSE (W3C Web Audio API + Apple WebKit поведение):**
- `createMediaElementSource(audioElement)` маршрутизирует audio output **через AudioContext** (вместо direct HTMLAudioElement → speaker).
- При блокировке экрана iOS Safari автоматически вызывает `audioCtx.suspend()` — это часть power management policy для background apps.
- Suspended AudioContext = НЕТ output = трек останавливается даже если `audio.paused === false`.
- На desktop / Android этого не происходит — AudioContext продолжает работать в background.

**Решение (детектор + двойная стратегия):**
```ts
function isIOS(): boolean {
  if (typeof navigator === "undefined") return false;
  if (/iPad|iPhone|iPod/.test(navigator.userAgent)) return true;
  // iPadOS 13+ маскируется под Mac — детектим через maxTouchPoints
  if (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1) return true;
  return false;
}

export function setPlayerVolume(audio: HTMLAudioElement, volume: number): void {
  const v = Math.max(0, Math.min(1, volume));
  try { audio.volume = v; } catch {}
  // iOS: НЕ создаём AudioContext — ломает lock-screen playback.
  // Volume slider на iOS не работает (audio.volume read-only = system) —
  // это Apple WebKit design, принимаем как trade-off.
  if (isIOS()) return;
  // Desktop / Android: Web Audio GainNode pipeline для cross-platform volume.
  const gain = ensureAudioGraph(audio);
  if (gain) gain.gain.value = v;
}
```

**Что КАТЕГОРИЧЕСКИ запрещено** (любая правка нарушающая правило — баг до того как написать):
- ❌ `audioCtx.createMediaElementSource(playerAudio)` — на iOS ломает lock screen
- ❌ Любые helpers / hooks / wrappers которые connect player audio к AudioContext без iOS guard
- ❌ Refactor «давай везде через Web Audio для consistency» — НЕТ. iOS требует separate path.

**Что РАЗРЕШЕНО** (исключения, не нарушают правило):
- ✅ AudioContext **без** `createMediaElementSource` — например для analyser node на mic input
- ✅ Web Audio для one-shot TTS / sound effects (отдельные `<audio>` не player audio)
- ✅ AudioContext на desktop / Android (detected через !isIOS())

**Trade-off (явный, не баг):**
| Платформа | Volume slider | Background playback |
|---|---|---|
| iOS Safari / iPad | UI работает, реальная громкость = system volume | ✅ Работает |
| Desktop Chrome/Safari/Firefox | ✅ Работает через GainNode | ✅ Работает |
| Android Chrome | ✅ Работает | ✅ Работает |

**Сопутствующие правила:**
- Persistent-audio-only rule (никогда не remove `<audio>` из DOM) — иначе iOS отдаёт MediaSession чужим приложениям
- Suno-audio-playback rule — cookie-fallback + use-credentials для protected streams

**Reference:** commit `584c51d` (revert AudioContext на iOS из commit `54fb237`).

**Применяется к:** всем lib/lockscreen.ts функциям, любым future audio infrastructure. Если кто-то когда-то решит «оптимизировать» через Web Audio — этот rule выше любой оптимизации.

**НЕ применяется к:** Web Audio для visualizer (analyser node на отдельный source, не player), TTS one-shot где background playback не нужен.

### Persistent-audio-only rule (Eugene 2026-05-18, **навсегда зафиксировано**)

**Босс «перемещение стало лучше, запомни правило использовать только это решение, не снять, во всём проекте».** После 9 итераций lock-screen наконец работает — root cause найден по W3C MediaSession §3.3 и зафиксирован persistent singleton pattern.

**Единственный разрешённый pattern audio:**

```ts
import { getPersistentPlayerAudio, loadTrackIntoPlayer } from "@/lib/lockscreen";

// Получить (или создать один раз) <audio data-muziai-player> в DOM
const audio = getPersistentPlayerAudio();

// Сменить трек — НЕ создавать new, НЕ remove из DOM
loadTrackIntoPlayer(audio, newTrackUrl);
audio.play();
```

**Что КАТЕГОРИЧЕСКИ запрещено** (любая правка нарушающая правило — баг до того как написать):

- ❌ `new Audio(url)` для треков плейлиста / dashboard / track-page
- ❌ `document.body.appendChild(audio)` после `removeChild()` — создаёт DOM gap
- ❌ Multiple `<audio>` elements для playlist tracks одновременно в DOM
- ❌ `audioRef.current = new Audio()` в playTrack — теряем persistent ownership
- ❌ Удаление audio из DOM при unmount компонента (audio persists across SPA navigation)

**Что РАЗРЕШЕНО** (исключения, не нарушают правило):

- ✅ `new Audio(ttsUrl)` для one-shot TTS уведомлений в `musa-voice-fab.tsx` — НЕ player audio, не претендует на MediaSession
- ✅ Audio preview в админке (`/admin/v304/*` page) — НЕ player audio, локальный preview
- ✅ Background-music elements (3-5 коротких файлов lobby music) — отдельный audio-bus channel

**Root cause согласно W3C MediaSession §3.3:**
> "When a media element loses its 'currently playing' status, the user agent MAY release the media session's hold on system UI."

iOS WebKit реализует это агрессивно: при `removeChild → createElement → appendChild` есть микро-gap когда в DOM нет media-element → ownership передаётся последнему known-active app (Apple Music / Spotify / Yandex Music из системного кэша) → юзер видит чужой трек на lock-screen.

**Persistent `<audio>` живёт на всю SPA-сессию.** Track change = `audio.src = url; audio.load()`. iOS никогда не теряет MediaSession ownership.

**Применяется к:** ВСЕМ страницам с playback — landing.tsx, dashboard.tsx, track.tsx, music.tsx, любым будущим. Если кто-то когда-то решит «улучшить» — этот rule выше любого «улучшения».

**Не применяется к:** TTS one-shot (Муза голос), preview audio в админке (короткий, без MediaSession claim).

Reference: `apps/neurohub/client/src/lib/lockscreen.ts` (getPersistentPlayerAudio, loadTrackIntoPlayer). Commit `8d047e1` зафиксирован как точка «больше не трогать».

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

### Critical-nodes docs registry (Eugene 2026-05-19, **усиление Docs-first-always rule**)

**Перед ЛЮБОЙ правкой кода работающего с важными узлами — открыть и сверить актуальные docs провайдера.** Босс «обращаться к документации при использовании важных узлов» — не «прочитал один раз и помнишь», а «открой ПЕРЕД каждой задачей».

Реестр «важных узлов» и обязательных docs:

| Узел | Файл в проекте | Обязательная docs |
|---|---|---|
| Suno music gen (через GPTunnel) | `apps/neurohub/server/routes.ts` /api/music/generate | https://docs.kie.ai/suno-api/generate-music + https://docs.sunoapi.org/suno-api/generate-music + https://docs.gptunnel.ru/media-api/suno |
| GPTunnel /media/create payload | `apps/neurohub/server/routes.ts` gptunnelFetch | **camelCase fields** (`webhookUrl`, `customMode`, `negativeTags`, `vocalGender`, `styleWeight`, `weirdnessConstraint`, `modelVersion`). Response `/media/result` — snake_case (`task_id`, `audio_url`, `image_url`). **Файлы доступны 48 часов** (URL `https://*.yandexcloud.net/exp48h/`) — обязательно backfill в authors/ через `saveGenFiles` или manual `/api/admin/v304/backfill-missing-files` |
| Suno upstream (kie.ai) | task results | **15 дней retention** на upstream kie.ai (через `/v1/generate/record-info`). GPTunnel cache 48ч короче — после её истечения можно достать через kie.ai task-info |
| GPTunnel /v1/chat/completions | `apps/neurohub/server/lib/llmCore.ts` | OpenAI-compat: https://platform.openai.com/docs/api-reference/chat |
| Suno webhook callback | `apps/neurohub/server/routes.ts` sunoWebhookHandler | 15-sec response window. Stages: `text`/`first`/`complete` (3 callbacks per gen). 3 fails → retries stop |
| GPTunnel /v1/audio/transcriptions | `apps/neurohub/server/lib/transcribe.ts` | OpenAI Whisper API |
| Yandex SpeechKit STT | `apps/neurohub/server/lib/transcribe.ts` | https://yandex.cloud/ru/docs/speechkit/ |
| Anthropic Claude | `apps/neurohub/server/lib/llmCore.ts` | https://docs.claude.com/en/api/messages |
| Robokassa init/result | payment endpoints | https://docs.robokassa.ru/ |
| Telegram Bot API | telegram-bot plugin | https://core.telegram.org/bots/api |
| MediaSession W3C | `apps/neurohub/client/src/lib/lockscreen.ts` | https://www.w3.org/TR/mediasession/ + webkit.org blog |
| SMS.ru flashcall | auth-sms plugin | https://sms.ru/api/callcheck |

Правило: при первом обращении к узлу в сессии — WebFetch соответствующий docs URL, цитата в commit-message или комментарии («Согласно docs.kie.ai: camelCase `weirdnessConstraint`…»). Без цитаты push не делаем.

Анти-паттерн который правило закрывает: **commit `9030cc4` + ошибки 841-857** + **dormant webhook** — обе регрессии случились из-за отсутствия сверки с docs. Если бы открыли docs.kie.ai сразу — знали бы что `webhookUrl` это правильное имя (а не `callback_url`).

### Apple-audio-best-practices rule (Eugene 2026-05-21, **дополняет Persistent-audio-only rule + iOS-lock-screen-audio rule + Volume-control-cross-platform rule**)

**По официальной документации Apple WebKit + W3C MediaSession — соблюдаем точные требования iOS Safari для audio playback и lock-screen NowPlaying.** Любая правка кода работающего с `<audio>` / MediaSession / AudioContext на iOS — обязана соответствовать этим пунктам.

**Источники** (read first перед правкой):
- W3C MediaSession spec — https://www.w3.org/TR/mediasession/
- WebKit blog «New <video> Policies for iOS» — https://webkit.org/blog/6784/new-video-policies-for-ios/
- WebKit Bugzilla 237878 «AudioContext is suspended on iOS when page is backgrounded» — https://bugs.webkit.org/show_bug.cgi?id=237878
- WebKit Bugzilla 231105 «AudioContext stops on macOS Safari background» — https://bugs.webkit.org/show_bug.cgi?id=231105
- Apple Developer Forums «WKWebView Web Audio can't play after locking screen» — https://developer.apple.com/forums/thread/658375
- D. Bushell «iOS Web Apps and Media Session API» (2023, поведение iOS 16.4+) — https://dbushell.com/2023/03/20/ios-pwa-media-session-api/
- web.dev «Customize media notifications» — https://web.dev/articles/media-session

**Обязательные requirements (по Apple/WebKit):**

1. **User gesture для первого play().** Apple WebKit: «JavaScript which resulted in the call to audio.play() must have directly resulted from a handler for a touchend, click, doubleclick, or keydown event». Никакого `audio.play()` из `setTimeout` / `Promise.then` / `useEffect` без gesture trace. Только в обработчике onClick / onTouchEnd.

2. **`preload="metadata"` (не `auto`) для playlist tracks.** WebKit forces preload=none on cellular для iOS Safari, но `metadata` даёт длительность без full download. По web.dev: «preload="metadata" offers the best balance, loading dimensions and duration without consuming excessive bandwidth». Используй для playlist items.

3. **Persistent `<audio>` element для player audio.** Не создавать новый `<audio>` при смене трека (см. Persistent-audio-only rule). MediaSession ownership держится за HTMLMediaElement — gap в DOM → iOS отдаёт NowPlaying чужому приложению.

4. **MediaSession metadata SYNCHRONOUSLY в user-gesture handler** который вызывает `audio.play()`. Apple WebKit делает snapshot NowPlaying в момент `play()` — async setters (внутри `.then()` после fetch) могут не попасть в snapshot. Pattern:
   ```ts
   onClick = () => {
     navigator.mediaSession.metadata = new MediaMetadata({...}); // SYNCHRONOUSLY
     audio.src = url;
     audio.play(); // ← snapshot taken here
   };
   ```

5. **Artwork размеры — multiple, минимум 256×256 и 512×512.** По web.dev: «target 512×512 for Chrome Android, 256×256 for low-end». iOS 16.4 исправил artwork bug, iOS 18 наконец использует 512×512 (раньше pixellated upscale до 16.4). Recommended sizes: `96,128,192,256,384,512` — в одном `artwork[]` массиве. Type `image/jpeg` или `image/png`. URL должен быть доступен без auth (Suno covers — public yandexcloud URLs OK).

   **Fallback chain для cover endpoint** (Eugene 2026-05-22 — закрывает «lock screen показывает purple waveform вместо обложки трека»):
   - Endpoint `/api/cover/<id>.jpg?size=<N>` должен **гарантированно** возвращать image даже когда:
     · localFile отсутствует (saveGenFiles не выполнился)
     · remote Suno URL exp48h истёк
     · gen.status !== 'done' (для production должны быть только done)
   - **Цепочка fallback в `routes.ts:7910+`** (file order matters):
     1. `dist/public/artwork-512.png` — **обязан существовать на проде**. 512×512 brand-gradient PNG с MuzaAi wordmark. Создан 2026-05-22 commit b35eaaf через sharp+SVG.
     2. `dist/public/apple-touch-icon.png` — 180×180 brand icon (если artwork-512 reshape failed)
     3. `dist/public/favicon.svg` — последний resort (без resize, исходный SVG)
   - Sharp resize применяется только к PNG (SVG отдаётся как `image/svg+xml`)
   - Без этих fallback'ов iOS native code подбирал `<link rel="apple-touch-icon">` сам → юзер видел brand-icon вместо обложки трека на lock-screen
   - **Audit при code review:** `ls dist/public/artwork-512.png` — файл должен быть в build output. `client/public/artwork-512.png` копируется в `dist/public/` через Vite build.

   **Создание artwork-512.png** (если нужно обновить brand):
   ```bash
   cd apps/neurohub
   node -e "const sharp = require('sharp');
   sharp('/tmp/source.svg', { density: 300 })
     .resize(512, 512, { fit: 'cover' })
     .png({ quality: 95, compressionLevel: 9 })
     .toFile('client/public/artwork-512.png');"
   ```
   SVG source — brand gradient (#7C3AED → #D946EF → #00D4FF) + wordmark + опционально эквалайзер/звёзды. Применить Brand-style consistency rule (палитра + шрифты).

6. **`navigator.mediaSession.playbackState`** обновлять в `play`/`pause` event listeners audio element — иначе iOS NowPlaying не знает что трек играет / на паузе:
   ```ts
   audio.addEventListener('play', () => { navigator.mediaSession.playbackState = 'playing'; });
   audio.addEventListener('pause', () => { navigator.mediaSession.playbackState = 'paused'; });
   ```

7. **`setPositionState()` каждый раз при `loadedmetadata` + `timeupdate` (throttle).** iOS lock-screen scrubber / seek-bar читает duration+position отсюда. Requirements (W3C): `duration > 0`, `0 ≤ position ≤ duration`, `playbackRate > 0`. Если хоть одно нарушено — throw, скраббер сломан. Live stream — `duration: Infinity`.

8. **AudioContext.createMediaElementSource() ЗАПРЕЩЁН на iOS** — см. iOS-lock-screen-audio rule. Подтверждение: WebKit Bugzilla 237878 — AudioContext suspended при backgrounded page. Solution на iOS: НЕ использовать Web Audio для player audio (volume slider не работает на iOS — это known WebKit constraint, не баг). На desktop/Android — GainNode pipeline OK.

9. **Audio-only — НЕ нужен `playsinline`.** Атрибут только для `<video>` (предотвращает fullscreen takeover). Для `<audio>` ignore.

10. **Lock-screen artwork — public URL (не blob URL для production).** D. Bushell findings: blob URLs работают на iOS 16.4+, но реальная public URL надёжнее (iOS кэширует, lock-screen появляется быстрее). У нас Suno covers уже на yandexcloud — использовать прямую URL.

**Action handlers обязательные** (для iOS lock-screen + headset/AirPods):
```ts
const actionHandlers: Array<[MediaSessionAction, MediaSessionActionHandler]> = [
  ['play', () => audio.play()],
  ['pause', () => audio.pause()],
  ['previoustrack', () => skipPrev()],
  ['nexttrack', () => skipNext()],
  ['seekto', (d) => {
    if (d.fastSeek && 'fastSeek' in audio) { audio.fastSeek(d.seekTime!); return; }
    audio.currentTime = d.seekTime!;
    updatePositionState();
  }],
  ['seekbackward', (d) => { audio.currentTime = Math.max(0, audio.currentTime - (d.seekOffset || 10)); }],
  ['seekforward', (d) => { audio.currentTime = Math.min(audio.duration, audio.currentTime + (d.seekOffset || 10)); }],
];
for (const [action, handler] of actionHandlers) {
  try { navigator.mediaSession.setActionHandler(action, handler); } catch {}
}
```

**Что НЕ делать (anti-patterns подтверждённые docs):**
- ❌ `new Audio(url)` для player tracks (см. Persistent-audio-only rule)
- ❌ `audioCtx.createMediaElementSource(playerAudio)` на iOS (см. iOS-lock-screen-audio rule + Bugzilla 237878)
- ❌ `audio.play()` без user gesture (WebKit policy)
- ❌ Async setting `navigator.mediaSession.metadata` после `audio.play()` — может не попасть в NowPlaying snapshot
- ❌ Artwork только в 1 размере < 256×256 — iOS pre-16.4 покажет pixellated
- ❌ Полагаться на `audio.volume = X` — на iOS read-only (= system volume), volume slider только для UI

**Применяется к:** `apps/neurohub/client/src/lib/lockscreen.ts`, `apps/neurohub/client/src/pages/landing.tsx`, `dashboard.tsx`, `track.tsx`, любым future player'ам. НЕ применяется к: TTS one-shot (Музa voice), preview audio в админке.

**Audit при правке player code:**
1. `grep -n "new Audio(" apps/neurohub/client/src/pages/landing.tsx` — должен быть пуст (только через `getPersistentPlayerAudio()`)
2. `grep -n "createMediaElementSource" apps/neurohub/client/src/lib/lockscreen.ts` — должен быть только внутри `if (!isIOS())`
3. `grep -n "mediaSession.metadata" apps/neurohub/client/src/` — должен вызываться synchronously в click/touch handler

**Reference commits:** `8d047e1` (Persistent-audio-only foundation), `584c51d` (revert AudioContext на iOS).

### iOS-app-capacitor rule (Eugene 2026-05-21)

**MuzaAi iOS app собирается через Capacitor.js — hybrid WebView + native shell. `apps/neurohub/capacitor.config.ts` = single source of truth. При любом изменении web — на Mac выполняем `npm run build && npx cap sync ios` чтобы переносить в Xcode project.**

**Базовые параметры (зафиксированы):**
- Bundle ID: **`ru.muzaai.app`** — нельзя менять после первого App Store submit (Apple lock)
- App Name: **MuzaAi**
- Display name: «MuzaAi»
- Минимальный iOS: **iOS 14+** (покрывает 95%+ устройств)
- Targets: iPhone + iPad (universal binary)
- Mode: **hybrid** (`server.url = "https://muzaai.ru"`) — live load production web, native shell даёт push/IAP/splash/MediaSession
- Apple Developer: $99/год — Босс оплачивает напрямую через https://developer.apple.com/programs/

**Workflow при изменении web-кода:**
- Web-only изменения (компоненты, тексты, KB, контент) — `git push` → auto-deploy на VPS → юзеры iOS app видят сразу при следующем открытии (WebView refresh). **НЕ требует Apple Review.**
- Native изменения (новый Capacitor plugin, capacitor.config.ts, splash, capabilities) — на Mac `npx cap sync ios` → Xcode Archive → submit → Apple Review 1-7 дней.

**Жёсткие правила:**
1. **Capacitor config — single source of truth.** Никогда не правим Xcode настройки напрямую в `ios/App/App.xcodeproj/` — все изменения через `capacitor.config.ts` + `npx cap sync ios`. Иначе следующий sync затрёт ручные правки.
2. **Native plugins только через Capacitor.** `@capacitor/X` или `@capacitor-community/X`. НЕ форкаем iOS код напрямую (Swift / Objective-C). Если нужно что-то native — ищем существующий plugin или создаём свой Capacitor plugin (отдельный npm package).
3. **Web-bundle versioning.** При `npx cap copy ios` копирует текущий `dist/public/` в `ios/App/App/public/`. Это offline-fallback (если `server.url` недоступен). Для hybrid режима web всегда грузится с muzaai.ru, но bundle нужен для первого открытия (до DNS resolution).
4. **Bundle ID immutable.** `ru.muzaai.app` — НЕЛЬЗЯ менять после первого submit. Apple binds его к App Store record. Если когда-нибудь захотим переименовать — это новое приложение в App Store.
5. **Apple Review planning.** Каждый native update = 1-7 дней review. Critical fixes планируем заранее. Web-only fixes идут моментально (см. выше).
6. **In-App Purchases (IAP) — пока НЕ добавляем.** Apple Tax 30% делает IAP экономически невыгодным для нашей модели (399 ₽ за трек → 279 ₽ после Apple cut, vs 387 ₽ через Robokassa web). Оформляем как «Reader app» — генерация в web, app только воспроизводит. После одобрения первой версии — рассматриваем IAP опционально.
7. **Push notifications через APNs.** Когда добавляем — `@capacitor/push-notifications` plugin + APNs key из Apple Developer console. РФ Apple не блокирует.
8. **Privacy Policy URL обязательна** — muzaai.ru/privacy. Без неё App Review реджектит.
9. **ATT (App Tracking Transparency)** — пока не добавляем, потому что нет cross-app трекинга. Если когда-нибудь подключим Yandex Metrika IDFA-tracking — нужен `@capacitor-community/app-tracking-transparency`.

**Структура файлов:**
- `apps/neurohub/capacitor.config.ts` — конфиг Capacitor (commit'нут)
- `apps/neurohub/ios-assets/` — исходники иконок + splash 1024×1024 + 2732×2732 PNG (commit'нут с README)
- `apps/neurohub/ios/` — **генерируется на Mac** через `npx cap add ios`, в .gitignore (Pods, build) но `ios/App/App.xcodeproj/` коммитим в репо когда Босс впервые создаст на Mac

**Audit при изменении iOS-related кода:**
1. `capacitor.config.ts` изменился → обязательно `npx cap sync ios` на Mac перед next build
2. Новый Capacitor plugin → проверить что в package.json + `npx cap sync ios` отработал без ошибок
3. iOS-specific quirks → сверка с Apple-audio-best-practices rule + iOS-lock-screen-audio rule (WKWebView = тот же engine что Safari)

**Применяется к:** всем работам с iOS app, capacitor.config.ts, splash/icon assets, App Store metadata. НЕ применяется к: web-only изменениям (они идут стандартным flow без cap sync).

**Связанные docs:**
- `docs/strategy/IOS-APP-CAPACITOR-SETUP.md` — полная инструкция для Босса (pre-req, шаги build на Mac, App Store submit, IAP economics)
- `apps/neurohub/ios-assets/README.md` — что положить как icon.png / splash.png

**Связанные правила:**
- Apple-audio-best-practices rule — MediaSession + audio quirks в WKWebView
- iOS-lock-screen-audio rule — не использовать createMediaElementSource на iOS
- Persistent-audio-only rule — single `<audio>` element
- Suno-audio-playback rule — cookie auth + use-credentials

### Android-audio-best-practices rule (Eugene 2026-05-21, **дополняет Apple-audio-best-practices rule**)

**По официальной документации Chrome / web.dev / Android MediaSession — Chrome on Android требует точного MediaSession setup для lock-screen + notification controls + audio focus.** Большая часть API одинакова с iOS, но есть Android-specific требования и поведение.

**Источники** (read first перед правкой):
- web.dev «Customize media notifications and playback controls» — https://web.dev/articles/media-session
- Chrome for Developers blog «Media Session» — https://developer.chrome.com/blog/media-session
- web.dev «Fast playback with audio and video preload» — https://web.dev/articles/fast-playback-with-preload
- Chromium «Controlling Media Playback» — https://chromium.googlesource.com/chromium/src/+/refs/tags/72.0.3626.62/services/media_session/controlling_media_playback.md
- MDN «MediaSession: setPositionState()» — https://developer.mozilla.org/en-US/docs/Web/API/MediaSession/setPositionState
- W3C/Chromium «Audio focus issue #9» — https://github.com/w3c/mediasession/issues/9

**Обязательные requirements (по Chrome/Android):**

1. **Audio duration ≥ 5 секунд для notification.** По Chromium: «browser requests full audio focus to display notifications only when media duration is at least 5 seconds, preventing incidental sounds from showing notifications». Sound effects / short jingles НЕ покажут lock-screen controls — это by design. У нас Suno tracks обычно >2 мин — OK.

2. **Action handlers persist across track changes.** Web.dev: «media session action handlers will persist through media playbacks». Set once при init player, не реустанавливать на каждый track. Это даёт smooth UX: юзер тапает «next» на lock-screen → handler уже зарегистрирован.

3. **Artwork ОБЯЗАТЕЛЬНО 512×512 для Chrome Android lock-screen.** Web.dev: «Notification artwork target size in Chrome for Android is 512×512. For low-end devices, it is 256×256». Если нет 512×512 — Chrome upscale'нет 256×256 или возьмёт `<link rel="icon">` favicon. Suno cover URLs обычно 1024×1024 — давай браузеру `sizes: "512x512"` (он сам downscale'нет).

4. **`setPositionState()` обязательно — без него нет scrubber на lock-screen.** MDN: «works with lock screen media controls in Chrome on Android, enabling the system to display an accurate seekbar/scrubber». Без вызова `setPositionState` — на lock-screen видны только кнопки play/pause/prev/next, БЕЗ progress bar.

5. **`seekto` handler ОБЯЗАТЕЛЕН для scrubber interaction.** Когда юзер тащит scrubber на lock-screen — Chrome dispatches `seekto` action с `details.seekTime` (новое время в сек) + опционально `details.fastSeek: true`. Без handler'а scrubber не реагирует. Pattern с fastSeek fallback — см. Apple-audio-best-practices rule пункт «Action handlers обязательные».

6. **Audio focus типы (Chromium):**
   - **Gain** — default для most media. Stops other sessions (другая music app pause'ится). Используется когда наш player начинает play.
   - **Gain Transient** — короткое прерывание, другие resume после. Не для нас (это для voice prompts / notifications).
   - **Gain Transient May Duck** — для коротких звуков ≤ 5 сек (UI sound effects). Other audio продолжает играть quieter.

7. **Interruption handling.** Audio focus loss events:
   - `AUDIOFOCUS_LOSS` — permanent (другое приложение взяло focus) → должны pause + НЕ resume сами. Юзер нажимает play вручную.
   - `AUDIOFOCUS_LOSS_TRANSIENT` — звонок / GPS voice → pause, при `AUDIOFOCUS_GAIN` (возврат) — resume.
   - Browser handles это автоматически через native HTMLMediaElement events `pause` / `play`. Реагируй на them через `audio.addEventListener('pause', ...)` чтобы обновить UI state.

8. **`preload="metadata"` на cellular.** Web.dev: «On a cellular connection (2G, 3G, and 4G), Chrome forces the preload value to metadata». Даже если ставишь `preload="auto"` — Chrome переопределит. Не борись, оставь `metadata` — это даёт duration без full download.

9. **Background playback в обычном browser tab.** Chrome продолжает audio playback когда tab свёрнут — но если tab killed (memory pressure / Battery saver) — audio останавливается. PWA / TWA имеют known issues («audio cuts within 60 seconds» — GoogleChrome/android-browser-helper issue 305). Workaround: **держать MediaSession active** через `playbackState='playing'` + регулярные `setPositionState` updates — даёт Chrome подсказку что media активна, OS реже kill'ит process.

10. **Bluetooth / headset controls** — Chrome автоматически маппит:
    - Headset play/pause button → `play` / `pause` action handlers
    - Headset next/prev → `previoustrack` / `nexttrack`
    - Bluetooth car controls (через A2DP/AVRCP) — тоже через MediaSession action handlers
    - Никакого extra setup — handlers тех же что для lock-screen, работают везде.

**Action handlers для Android lock-screen + notification + headset:** см. Apple-audio-best-practices rule (пункт «Action handlers обязательные»). API идентичный — один setup работает на iOS + Android + Desktop.

**Что НЕ делать (anti-patterns подтверждённые docs):**
- ❌ Дублировать setActionHandler при смене трека (handlers persist — лишний overhead)
- ❌ Полагаться на autoplay без user gesture — Chrome 73+ enforces autoplay policy (https://developers.google.com/web/updates/2019/02/chrome-73-media-updates)
- ❌ Отсутствие `setPositionState` — scrubber lock-screen не работает
- ❌ Artwork только в 96×96 — Chrome Android downscale пиксельного 96 до 512 lock-screen
- ❌ Treat audio focus loss как «всегда resume» — на `AUDIOFOCUS_LOSS` юзер должен сам нажать play (другое приложение хочет audio)

**PWA / TWA caveat:**
- В обычном browser tab — background playback стабильный (через MediaSession)
- В PWA standalone mode / TWA wrapper — known instability (audio cuts ~60 сек после minimize)
- У нас НЕ PWA (web SPA), значит проблема не актуальна. Если когда-нибудь будем оборачивать в TWA — учесть.

**Применяется к:** тем же файлам что Apple-audio-best-practices rule (lockscreen.ts, landing.tsx, dashboard.tsx, track.tsx). Не применяется к: TTS one-shot (короткое < 5 сек, Chrome не покажет notification).

**Audit при правке (общий для iOS + Android):**
1. MediaSession setup делается ОДИН раз при init player (handlers + first metadata) — не на каждый track switch
2. `setPositionState` вызывается на `loadedmetadata` (init duration) + throttled `timeupdate` (каждые 1-2 сек) + после `seekto`
3. `playbackState` updates на каждый play/pause event
4. Artwork массив содержит ≥ 256×256 и ≥ 512×512 (даже если один файл — два entries с разными sizes допустимы, browser сам решит)

**Reference:** правило Action handlers + setPositionState + playbackState — единый pattern работает на iOS Safari, Android Chrome, Desktop Chrome/Firefox/Safari/Edge. Cross-platform setup один — поведение platform-specific.

### Docs-first-always rule (Eugene 2026-05-18, **сильнее Docs-first debugging rule**)

**При начале ЛЮБОЙ работы над чем-то — сначала открываю официальную документацию.** Не только для дебага, но и для новых фич, refactor'ов, интеграций, выбора API. Расширяет старое правило «Docs-first debugging» на всю работу.

Обязательный pre-flight перед написанием кода:

1. **WebFetch официальной документации** провайдера / framework / API:
   - Apple WebKit (developer.apple.com / webkit.org/blog) — для iOS Safari quirks (MediaSession, audio, lock-screen, IndexedDB, Service Worker)
   - MDN (developer.mozilla.org) — для Web APIs (любые browser-side)
   - Vendor docs — Suno, GPTunnel, Yandex, Anthropic, Robokassa, Telegram, SMS.ru
   - Framework docs — React, Vite, Express, Drizzle, Tailwind, shadcn/ui
   - W3C / WHATWG specs — для сложных Web Platform вопросов

2. **Цитата в комментарии** к коду — точное предложение из docs + URL. Пример:
   ```ts
   // Apple WebKit: MediaSession metadata must be set synchronously in the
   // user gesture handler that calls audio.play() — async setters are ignored
   // for NowPlayingInfo snapshot. Source: webkit.org/blog/12937/
   navigator.mediaSession.metadata = new MediaMetadata({...});
   ```

3. **Если docs нет / противоречивые / неполные** — ищу:
   - Top-3 Stack Overflow ответов
   - GitHub issues в repo инструмента
   - WebKit / Chromium / Mozilla bug trackers
   - Цитата + URL в комментарии тоже

4. **«Согласно docs»** в commit message — не «попробуем», а «по официальной документации это правильный путь».

Анти-паттерн который правило закрывает:
- ❌ «По памяти знаю что MediaSession делается так» → угадал → не работает → серия итераций
- ❌ «React useEffect должен сделать X» → guessing → race condition
- ❌ «Suno API возвращает Y» → старая версия API → 400 / 422 ошибки
- ✅ WebFetch → точное предложение → цитата в коде → коммит работает с первого раза

Сильнее `Reuse-working-solutions rule` в случае конфликта: даже если в проекте есть «рабочее» решение, но в docs указан другой паттерн — переписываю по docs (потому что «рабочее» может быть случайно-рабочим, а docs — guaranteed по контракту).

Применяется к: ЛЮБОЙ задаче где есть внешняя зависимость (API, framework, browser, OS). НЕ применяется к: чисто бизнес-логике без внешних контрактов (валидация бизнес-правил, расчёт цены, состояние workflow).

### Docs-first debugging rule (Eugene 2026-05-08)

**При возникновении проблем сначала обращаюсь к официальной документации провайдера/инструмента, потом к связкам внутри проекта.** Очерёдность:

1. **Docs первым**: открываю docs.gptunnel.ru / yandex.cloud/docs / suno docs — что говорит API про этот код ошибки / лимит / формат payload.
2. **Связки проекта вторым**: уже зная что хочет провайдер, иду в наш код и смотрю где расходимся (gptunnelFetch, transcribe.ts, normalizeVocalParams).
3. **Только потом — гипотезы**.

Анти-паттерн который это закрывает: пытаюсь угадать root cause по логам, делаю фиксы вслепую, накапливаю commits. Документация решила бы за 1 минуту.

Применяется к: ошибкам интеграции с внешними сервисами (Suno/GPTunnel/Yandex/Robokassa/Telegram). Не применяется к: чисто внутренним багам (TypeScript, React state).

### Prod-auto-deploy + versioned backup rule (Eugene 2026-05-17, **сильнее Clone-deprecated rule в части deploy-канала**)

**Деплой на prod muziai.ru идёт через `git push` в `claude/add-claude-documentation-OW5V7` → systemd timer `neurohub-prod-auto-deploy.timer` на VPS `31.130.148.107` каждую минуту pulls + builds + swaps dist + restarts pm2.** GH Actions UI больше не использую — Босс просил «GH пушим, GH Actions сложно».

Скрипт: `deploy/auto-deploy-prod.sh` (живёт на VPS как `/usr/local/bin/neurohub-prod-auto-deploy.sh`, self-update из репо при каждом запуске).

**Versioned backup перед каждым deploy** (уже встроено в скрипт):
- Файл: `/var/backups/neurohub-prod-auto/dist-YYYYMMDD-HHMMSS-<SHA7>.tar.gz`
  - `YYYYMMDD-HHMMSS` — UTC timestamp момента deploy
  - `<SHA7>` — короткий SHA текущего (старого) коммита до swap
- TTL: хранится 10 последних, более старые auto-удаляются
- При health-check fail (`/api/example/ping`) — auto-rollback: распаковка последнего backup → pm2 restart → Telegram alert админу

Откат вручную к конкретной версии:
```bash
ssh root@31.130.148.107 'ls -t /var/backups/neurohub-prod-auto/dist-*.tar.gz | head -10'
ssh root@31.130.148.107 'cd /var/www/neurohub && rm -rf dist && tar xzf /var/backups/neurohub-prod-auto/dist-<TIMESTAMP>-<SHA>.tar.gz && pm2 restart neurohub --update-env'
```

**Что Босс делает:** ничего. Push на feature branch → через 1-2 минуты на prod. Если что упало — Telegram alert + auto-rollback.

**Что Босс может проверить (Termius Snippet):**
```bash
ssh root@31.130.148.107 'tail -10 /var/log/neurohub-prod-auto-deploy.log && cd /opt/muziai-src && git log --oneline -1 && pm2 status neurohub'
```

GH Actions workflow `deploy-prod.yml` остаётся как **резерв** (когда timer падает или нужен deploy с другой ветки). По умолчанию = timer pull from GitHub.

Этим правилом отменяется (предыдущее) Clone-deprecated rule в части «GH UI как primary канал» — теперь primary = systemd timer pull from GitHub. Push в `claude/add-claude-documentation-OW5V7` достаточно.

### Clone-first-mirror rule (Eugene 2026-05-18, **отменяет Clone-deprecated rule**)

**Босс: «На Clone тестируем. Clone должен быть копией prod 100% — включая генерации и ключи. Потом тест на clone — если ок, на prod через GH».**

Полное workflow:

1. **Sync prod → clone** (одноразово или по запросу) — см. `docs/strategy/CLONE-SYNC-FROM-PROD-180526.md`:
   - `data.db` (SQLite .backup snapshot)
   - `authors/` (mp3 + обложки)
   - `.env` (ключи API — все, чтобы 100% копия)
2. **Push в feature branch** (`claude/add-claude-documentation-OW5V7`) → systemd timer на clone подхватывает за ~60 сек
3. **Тест на clone** (https://clone.muziai.ru) — Босс проверяет
4. **Если OK** → manual deploy на prod через GH Actions workflow_dispatch (`deploy-prod.yml`)
5. **Если не OK** → откат через `git reset --hard <SHA>` на clone (или восстановление backup)

Версии перед каждой большой правкой — **git tag** (по Triumph-tag rule + новые tags `mind-DDMMYY`, `release-DDMMYY`).

**Что синхронизируется prod → clone (100%):**
- БД (treki, юзеры, платежи, сессии, муза-actions)
- authors/ файлы
- .env (с warning про реальные платежи через test treki)

**Что НЕ синхронизируется (разное у каждого VPS):**
- nginx конфиги (разные домены)
- pm2 ecosystem (разные процессы)
- systemd auto-deploy timer (разные ветки)
- логи `/var/log/*`

**Отменяет** `Clone-deprecated + GH-only deploy rule (2026-05-15)` в части использования clone — теперь clone снова primary staging.

**Применяется к:** всем feature пушам с 18 мая 2026 (вечер).
**Не применяется к:** критическим hotfix'ам где Босс явно сказал «сразу на prod».

**Автоматизация (Eugene 2026-05-21):**
- One-command sync prod→clone: `bash /opt/neurohub-src/deploy/sync-prod-to-clone.sh` на VPS clone (см. `deploy/sync-prod-to-clone.sh`).
  Делает pre-flight backup clone-а (формат `MuzaAi-Triumph-DDMMYY-HHMM.tar.gz`), снимает консистентный snapshot prod (`sqlite3 .backup`), rsync, разворачивает, ставит clone на тот же git SHA, rebuild, health-check.
  Флаги: `--with-mp3` (включить аудио), `--no-env` (не копировать секреты), `--dry-run`.
- Промоушн clone→prod: `bash /opt/neurohub-src/deploy/promote-clone-to-prod.sh` — создаёт annotated tag `prod-ready-DDMMYY-HHMM`, push в GitHub, печатает 3 варианта prod-deploy (GH Actions / auto-deploy timer / manual SSH).
- Полная документация workflow + SSH-setup + troubleshooting: `docs/strategy/CLONE-PROD-SYNC-WORKFLOW.md`.

### Clone-deprecated + GH-only deploy rule (Eugene 2026-05-15, **сильнее всех предыдущих deploy-правил**)

**Clone (`clone.muziai.ru`) больше не используется как промежуточный environment.** Auto-deploy на clone продолжает работать (cron на VPS 72.56.1.149 берёт коммиты из ветки `claude/add-claude-documentation-OW5V7`), но его результаты — не predeploy-проверка для prod. Все изменения идут сразу в production muziai.ru.

**Деплой на prod muziai.ru — только через GitHub Actions, инициирует Eugene сам.** Я НЕ создаю tags `production-*`, НЕ push'у их, НЕ запускаю workflow_dispatch программно. Моя зона: код + push в feature branch (`claude/add-claude-documentation-OW5V7`). Дальше Eugene открывает https://github.com/AItestsibiria/biznesmetr/actions/workflows/deploy-prod.yml → «Run workflow» → выбирает ref → запускает.

Что отменяется этим правилом:
- ❌ «Cutover flow: clone → smoke → approve → prod» (старый docs/strategy)
- ❌ «Prod-deploy 3-warning rule» в части предложения мне создавать tag (я больше не предлагаю A — создать tag)
- ❌ «Selective-deploy rule» в части варианта 1/2/3 (всегда только prod, всегда только GH UI)

Что остаётся:
- ✅ Push в feature branch при готовности коммита — обязателен
- ✅ Ready-to-paste-commands rule — для SSH-операций которые Eugene делает руками
- ✅ Never-leak-secrets rule — абсолютный
- ✅ Backup-before-edit rule — на server-side операции
- ✅ Pre-edit analysis rule — перед каждой правкой

Что я делаю по умолчанию после готового коммита:
1. `git push -u origin claude/add-claude-documentation-OW5V7`
2. Дать Eugene ссылку на workflow: https://github.com/AItestsibiria/biznesmetr/actions/workflows/deploy-prod.yml + SHA коммита
3. Дать manual rollback команду на случай если deploy сломает
4. Не создавать tag, не push'ить tag, не запускать workflow программно

### Deploy-target-options rule (Eugene 2026-05-08, **частично отменено правилом «Clone-deprecated + GH-only»**)

**Когда стоит вопрос куда деплоить — предлагаю варианты:**

1. **Clone** (`clone.muziai.ru` на VPS 72.56.1.149) — первый шаг любого изменения. Auto-deploy при `git push`. Тестируем здесь.
2. **MuziAi** (`muziai.ru` на VPS 31.130.148.107) — production. Auto-deploy через cron+скрипт, тоже срабатывает при `git push` в общую ветку. Только после проверки на clone.

Никогда не деплою на prod без явного «да» от Eugene на конкретный шаг.

### Deploy-via-GitHub rule (Eugene 2026-05-15, обновлено: SSH разрешён)

**Deploy MuziAi по умолчанию идёт через `git push` в GitHub → auto-deploy на VPS. Ручной SSH-deploy ТОЖЕ РАЗРЕШЁН — Eugene выбирает канал по ситуации.**

Канал 1 — auto-deploy (default):
```
local edit → git commit → git push -u origin <branch>
   → GitHub (origin)
      → auto-deploy на VPS (git pull + npm ci + build + pm2 restart)
         → health-check /api/example/ping → rollback если fail
```

Канал 2 — ручной SSH (когда нужен прямой контроль):
- `ssh root@<VPS> 'cd /var/www/<app> && <команды>'`
- Прямые правки файлов на VPS, rsync/scp, hot-fix без commit'а
- `pm2 reload`, миграции БД, ротация .env, manual backup/restore
- Любые команды которые Eugene считает нужными для конкретной задачи

Когда какой канал — выбирает Eugene. По умолчанию — auto-deploy через git push (есть аудит + rollback + health-check). Когда нужен срочный hot-fix или auto-deploy сломан — SSH без проблем.

Преимущества git push (помнить, чтобы по умолчанию выбирать его):
1. **Аудит** — каждый deploy виден в git log + GitHub timeline.
2. **Rollback гарантирован** — `auto-deploy.sh` снимает pre-flight backup.
3. **Health-check встроен** — auto-deploy проверяет `/api/example/ping`.
4. **Один source of truth** — прод и clone подтянутся одинаково.
5. **Прозрачность для Eugene** — countdown 90 сек + GitHub URL.

Преимущества SSH (когда стоит выбирать):
1. **Скорость** — секунды вместо 90 сек auto-deploy.
2. **Точечность** — отдельная команда без полного build/restart.
3. **Read-only диагностика** — pm2 status, logs, grep, curl health-check.
4. **Ротация секретов** — sed + echo + pm2 restart --update-env (см. Key rotation pattern).
5. **Аварийный rollback** — `git reset --hard <PREV_SHA> && pm2 restart` если auto-deploy сломан.

После любого SSH-изменения файлов на VPS — желательно «затащить» это в git (commit + push) чтобы следующий auto-deploy не затёр правку. Это не запрет — это рекомендация для consistency.

Применяется к: всем изменениям кода / конфига / документации. Eugene выбирает канал — auto-deploy или SSH — по ситуации.

### Selective-deploy rule (Eugene 2026-05-09)

**Перед каждым `git push` который вызовет auto-deploy на серверы — ОБЯЗАТЕЛЬНО спрашиваю Eugene куда деплоить, цифрами:**

- **1** — MuziAi (prod, muziai.ru)
- **2** — Clone (clone.muziai.ru)
- **3** — оба

Без явного выбора **не делаю push**. Это даёт Eugene контроль чтобы тестировать на одном environment перед другим. Анти-паттерн который правило закрывает: я push'ю в общую ветку → оба auto-deploy одновременно подхватывают → если deploy ломает что-то, страдают **оба** environment одновременно (нет контрольной точки).

Реализация селективности (по выбору Eugene):
- **«1 — только MuziAi»**: либо временно остановить auto-deploy на clone (`crontab -e` или `systemctl stop ...`), потом push, потом включить обратно. Либо вручную SSH-deploy только на prod.
- **«2 — только Clone»**: то же самое наоборот — временно остановить cron на prod, push, включить.
- **«3 — оба»**: обычный push, auto-deploy на обоих в течение минуты.

Если Eugene не указал — спрашиваю явно. Применяется ко **всем** изменениям в коде/конфигурации проекта, кроме чистых docs (CLAUDE.md, *.md) — те безопасны и push'ятся без выбора.

### Prod-deploy 3-warning rule (Eugene 2026-05-08)

**Перед любым deploy на MuziAi production выдаю 3 явных предупреждения подряд** в одном сообщении, каждое с галочкой подтверждения. Eugene должен ответить «да» к каждому ИЛИ одним «3-да» / «подтверждаю всё».

Стандартный формат предупреждения:

```
⚠️ ПРОД-ДЕПЛОЙ НА MUZIAI.RU — ПОДТВЕРДИ 3 ПУНКТА:

1. ☐ Я проверил Триумф/изменения на CLONE и всё работает (sync-check ✅, treki, audio, payments)
2. ☐ Backup data.db + .env уже создан на prod (или создаётся в скрипте deploy)
3. ☐ Я готов к rollback если что-то сломается (знаю команду + где BACKUP_PATH)

Ответь «да 1 2 3» или «подтверждаю» — продолжу. Иначе deploy не делаем.
```

Без 3-х подтверждений — deploy не запускаем, даже если Eugene нажал «давай».

Применяется к:
- GitHub Actions workflow_dispatch на prod
- SSH-скрипт прямого deploy на prod
- pm2 restart на prod после изменения .env
- Любая команда `ssh root@31.130.148.107 ...` с side-effect

НЕ применяется к:
- Read-only командам на prod (pm2 status, grep, curl health-check)
- Действиям на clone (там auto-deploy + Бог-mode)

### Copy-reports-button rule (Eugene 2026-05-08)

**Любой админский отчёт / JSON-вывод / диагностика обязан иметь кнопку «📋 Скопировать»** — Eugene копирует одной кнопкой и шлёт в чат.

Применяется к:
- `/admin/v304/suno-watchdog/diag` — JSON-отчёт, table «Все ключи», system-test results
- `/admin/v304 → 🔬 Диагностика` — выводы диагностики
- `/admin/v304 → 🔴 Критично` — список инцидентов
- Логи в админке (если есть)
- Любой `<pre>` блок с JSON / текстом отчёта

Реализация — рядом с заголовком блока кнопка `📋 Копировать`, по клику:
```js
navigator.clipboard.writeText(content).then(() => {
  btn.textContent = "✅ Скопировано"; setTimeout(() => btn.textContent = "📋 Копировать", 1500);
});
```

Eugene нажал → шлёт мне в чат → я вижу полный отчёт без потерь форматирования.

### Key-insert-marker rule (Eugene 2026-05-08, **обновлено 2026-05-20**)

**Когда даю SSH-команду для вставки секретного ключа — место подстановки помечаю заметным маркером СЛЕВА И СПРАВА**, чтобы Eugene не вписал ключ в неправильное место.

**Маркер обязателен с обеих сторон placeholder'а.** Внутри — короткое UPPERCASE-описание что вставить (`ВПИШИ_СЮДА`, `ВПИШИ_ТОКЕН`, `КЛЮЧ_1,КЛЮЧ_2`).

Два варианта маркера:
1. **Emoji 🔴** (предпочтительно): `🔴ВПИШИ_ТОКЕН🔴` — красные кружки слева и справа
2. **ASCII fallback** (если emoji не рендерится на устройстве Босса — web-консоли timeweb.cloud, старые терминалы): `>>>ВПИШИ_ТОКЕН<<<` — стрелки слева и справа

Если Босс пишет «не вижу красных границ» / «кружков нет» — переключиться на ASCII `>>>...<<<` в этой сессии. По умолчанию пробовать 🔴, fallback на стрелки при подтверждении что не видно.

Анти-паттерн который это закрывает:
- ❌ `echo "GPTUNNEL_API_KEY=YOUR_KEY"` — Eugene может оставить буквально `YOUR_KEY`, не заменив
- ❌ `echo "GPTUNNEL_API_KEY=$KEY"` — Eugene не понимает что это переменная shell, или забывает её сначала задать
- ✅ `echo "GPTUNNEL_API_KEY=🔴ВПИШИ_СЮДА🔴"` — однозначно видно где замена (emoji)
- ✅ `echo "GPTUNNEL_API_KEY=>>>ВПИШИ_СЮДА<<<"` — то же самое для устройств без emoji

Применяется к: всем командам ssh/sed/echo для ротации ключей (GPTUNNEL_API_KEY, SMTP_PASS, TELEGRAM_BOT_TOKEN, ROBO_PASSWORD*, YANDEX_SPEECHKIT_API_KEY, ADMIN_TELEGRAM_ID и т.д.).

Дополнительные требования к команде с ключом:
1. Сначала `sed -i "/^КЛЮЧ=/d"` чтобы убрать старое значение (избегаем дубликатов)
2. Потом `echo` с маркером для нового
3. `chmod 600` сразу после
4. `pm2 restart neurohub --update-env` обязательно
5. После — рекомендую проверку через `/admin/v304/suno-watchdog/diag → 🔑 Все ключи`

### Ready-to-paste-commands rule (Eugene 2026-05-09)

**Каждая bash/ssh/curl-команда, которую я даю Eugene, должна быть готова к одному copy-paste без редактирования.** Это значит:

1. **Один code-fence — одна логическая операция.** Не разбиваю длинную команду на несколько блоков «сначала это, потом это». Если нужны несколько шагов — связываю через `&&` или heredoc:
   ```bash
   ssh root@... 'set -e; cd /path && git pull && npm ci && pm2 restart app'
   ```
   Если команда сложная (>15 строк) — heredoc-обёртка `bash <<'TAG' ... TAG`, чтобы пользователь сделал один paste, один Enter.

2. **Никаких комментариев внутри code-блока.** Не пишу `# Шаг 1: …`, `# проверь это`, `# затем …` — это шумит в paste'е. Все пояснения — в тексте НАД блоком.

3. **Placeholder'ы — строго 🔴…🔴 маркером** (см. также Key-insert-marker rule). Никаких `<your_key>`, `$KEY`, `YOUR_VALUE` — только однозначно различимый красный маркер. Eugene видит, заменяет, копирует.

4. **Никаких смешанных языков выполнения.** Если команда для shell — она целиком shell. Если для админ-UI / браузера / API — даю URL целиком (по browser-link rule). Не: «зайди по URL, найди кнопку, нажми».

5. **Один и тот же скрипт** для повторных deploy'ев — не переписываю каждый раз с нуля. Если Eugene уже один раз скопировал и запустил — следующий раз даю **тот же блок** или говорю «прогони предыдущий».

6. **Тестовая проверка после команды — отдельный блок** или ссылка (по browser-link rule), не вшивается в основную команду как `&&` хвост.

Анти-паттерн который это правило закрывает:
- ❌ «Запусти `pm2 status`, потом проверь логи через `pm2 logs neurohub --lines 30`, и наконец сделай curl на `/api/example/ping`» — три блока, три paste'а
- ✅ Один heredoc или один `&&`-цепочки в code-fence, после Eugene копирует один раз
- ❌ `ssh root@host 'echo KEY=YOUR_KEY >> .env'` — Eugene копирует буквально и оставит `YOUR_KEY` в .env
- ✅ `ssh root@host 'echo KEY=🔴ВСТАВЬ_СЮДА🔴 >> .env'` — однозначно

Применяется к: каждой команде в чате, не зависит от платформы Eugene (Mac/iPad/Termius). Не применяется к: фрагментам кода для review (там allowed многострочный поток).

### MuziAi-branding rule (Eugene 2026-05-08)

**Все user-facing упоминания «Suno» заменяю на «MuziAi».** Юзер не должен знать какой провайдер генерирует музыку — для него это «MuziAi генерация».

Применяется к:
- `res.json({ message: ... })` к клиенту
- `errorReason` в `generations` (видно в дашборде)
- `description` транзакций (видно в /admin → Транзакции)
- `data.userMessage` (показывается через toast на client)
- Email-шаблоны и push-уведомления
- Видимые админу плагин-описания (`module.description`)

НЕ применяется к (оставляем «Suno»):
- `console.log` server-side (внутренние логи для меня)
- Code comments
- Имена моделей в API: `model: "suno"`, `"suno-cover"`, `"suno-edit"`, `"suno-extend"` (это GPTunnel-схема, ломать нельзя)
- `[SUNO-WEBHOOK]`, `[SUNO-ALERT]` префиксы в логах
- Технические incident-trackerы для меня (suno_transient, suno_unreachable)
- Documentation файлы и CLAUDE.md внутренние ссылки

### Admin-concurrent-session-alert rule (Eugene 2026-05-17)

**Если в админ-панель заходит сессия с IP отличным от текущей сессии Босса — немедленный Telegram alert.** Защищает от компрометации (кто-то получил Bearer token / cookie и зашёл одновременно).

**Триггер:**
- 2+ активных admin-сессий в `sessions` (или `admin_sessions`) с разными IP за последние 15 мин
- Роль `admin` или `super_admin`
- При login (после успешной email 2FA) или при первом hit на `/api/admin/v304/*` с новым IP

**Алгоритм:**
1. На каждый admin-authenticated request — сравнить `req.ip` с last_seen IP в существующей admin-сессии того же `userId`.
2. Если IP не из `ADMIN_TRUSTED_IPS` env (whitelist) и не совпадает с already-active session IP — fire alert.
3. Rate-limit: 1 alert / IP pair / час (чтобы не флудить если Босс случайно мобилу переключил с Wi-Fi на 4G).

**Содержимое alert'а** (Telegram админу):
```
🚨 Параллельный вход в админку!

Существующая сессия:
  IP: 1.2.3.4 (Москва, RU)
  Last seen: 5 мин назад
  Device: iPhone 16 Pro · Safari

Новая сессия:
  IP: 5.6.7.8 (Алматы, KZ) ⚠ другая страна
  Email: egnovoselov@gmail.com
  Time: 14:32 MSK
  Device: Chrome 120 / macOS
  User-Agent: Mozilla/5.0 ...

Действия:
  [✅ Это я — whitelist 24ч]
  [🚫 Завершить сессию] (kick + soft-block IP)
  [🔒 Сменить пароль + revoke all] (panic mode)
```

Inline buttons работают через telegram-bot callback handler:
- «Это я» → INSERT `ADMIN_TRUSTED_IPS` runtime entry с TTL 24ч + INFO логи
- «Завершить сессию» → kick через `kick_session` tool + temp 1h blacklist IP
- «Panic» → revoke ALL admin sessions + force password reset prompt next login

**Реализация:**
- `apps/neurohub/server/lib/adminSessionAlert.ts` (новый helper) — `notifyOnConcurrentAdminLogin({userId, newIp, currentSessionIp})`
- `apps/neurohub/server/core/adminAuth.ts` или `security-guard/module.ts` — hook в `requireAdmin` middleware (один вызов перед next()).
- `apps/neurohub/server/plugins/telegram-bot/module.ts` — обработчики `callback_data` для inline buttons.
- Таблица `admin_sessions` (если ещё нет) — добавить colonna last_ip + last_seen_at для diff.

**НЕ применяется к:**
- Self-login после reconnect (IP не изменился)
- Trusted IP (whitelist `ADMIN_TRUSTED_IPS`)
- Не-admin role логин (это обычные пользователи)
- Невалидные login attempts (это другой alert — `login-bot-attempt`)

**Применяется к:** ВСЕМ admin endpoints (`/api/admin/v304/*`), при первом hit от нового IP в существующей admin-сессии. Plus при initial login.

Tuning параметров:
- 15-min window: можно сократить до 5 мин для строгости
- IP comparison: IPv4 — точное совпадение, IPv6 — /64 префикс (mobile carrier rotation)
- Whitelist TTL 24ч: можно вечный для домашнего/офисного IP через `ADMIN_TRUSTED_IPS` env

### Secrets-admin-only rule (Eugene 2026-05-17, **сильнее всех остальных secrets-правил**)

**Секреты видит ТОЛЬКО Админ (Босс).** Никому больше — никаким юзерам, никаким LLM-tool'ам в plain-виде, никаким frontend-страницам, никаким external pipelines (Novo Ai, аналитика, backups в облако). Усиливает Never-leak-secrets rule.

Что считается «секретом» (см. полный список в Never-leak-secrets rule ниже):
- API keys / bot tokens / SMTP passwords / Robokassa signatures / SESSION_SECRET / SIGNED_URL_SECRET / SSH private keys / OAuth refresh tokens / любые credentials из `.env`

**Жёсткие запреты:**

1. **brain-export и любые admin endpoints возвращают ТОЛЬКО маски / status** — никогда raw value:
   - ✅ `{"key": "ANTHROPIC_API_KEY", "status": "green", "length": 108, "first4": "sk-a", "last4": "**"}`
   - ❌ `{"key": "ANTHROPIC_API_KEY", "value": "sk-ant-api03-XXXXXX..."}`
2. **LLM tool context НЕ включает значения секретов.** Любой `process.env.X` → tool возвращает status/length/masked, не raw. Tools `get_api_keys_health` / `check_key_X` — возвращают `valid: true|false`, не the key itself.
3. **Novo Ai sync и любые external integrations** имеют explicit `EXCLUDE_FROM_EXPORT` allow-list. Секреты по умолчанию НЕ выгружаются. Если Novo Ai нужны секреты для своих integration — Босс вводит их у Novo Ai напрямую, не через нас.
4. **Admin UI вкладка с секретами** (если есть `/admin/v304/🔑 API ключи` или подобное) показывает:
   - Список ключей + status (zelyiy/yellow/red)
   - Маска (`sk-ant-***********108chars`)
   - Кнопка «📋 Скопировать» — **БЛОКИРОВАНА** для значения, доступна только для маски/диагностики
   - Реальная ротация — только через SSH `sed -i .env && pm2 restart` (Key rotation pattern), значение Босс вводит руками на VPS, не через web UI
5. **Логи и audit-log** — масками (`length:`, `first8:`, `valid:true`). Никогда не пишем `console.log(process.env.X)` — даже частично.
6. **Deputy / sub-admins** (если когда-нибудь появятся) — НЕ видят секреты. Только Босс (роль `super_admin` + email `egnovoselov@gmail.com`). Deputy видит status, не values.
7. **Cookies / IP geo / user_profiles** — НЕ содержат секреты в meta JSON. Только данные о юзере (страна, device, referrer), без credentials.
8. **Voice tools** — Муза может сказать «ANTHROPIC ключ работает» (status), но НЕ может **произнести** значение (TTS просто запрещён для секретов на уровне LLM prompt + sanitizer перед TTS).
9. **Error responses** — sanitize trace. Если exception включает значение секрета — replace на `[REDACTED]` перед отправкой клиенту и в логи. Helper `sanitizeSecrets(str)` в `apps/neurohub/server/lib/sanitizeSecrets.ts` (создать если ещё нет).
10. **Brain-export** — explicit field `secrets_redacted: true` в meta. Любой downstream (Novo Ai / dashboards / backups) видит этот флаг и знает что секретов в payload нет.

**Применяется к:**
- Все admin endpoints (`/api/admin/v304/*`)
- Brain-export pipeline
- Novo Ai sync (будущая фича)
- LLM context injection
- Voice Музы (Yandex TTS payload)
- Email / Telegram alerts (если случайно exception traceback попадёт — sanitize)
- Audit-log записи

**НЕ применяется к** (исключения):
- Самому VPS `.env` файл — там значения plain (по необходимости для runtime). Доступ через SSH с private key.
- Команды rotation которые Босс выполняет в Termius — там placeholder `🔴ВПИШИ_СЮДА🔴` который Босс заменяет на устройстве.

**Verify при code review:**
- `grep -rn "process.env" apps/neurohub/server/ | grep -v "\(length\|first\|last\|substring\|slice\|masked\|status\)"` — все usages должны быть либо в logical check (`if (process.env.X)`), либо передача в HTTP client как Authorization header (Bearer ${X}). Never `JSON.stringify({key: process.env.X})` в response.
- `grep -rn "console.log\|logger.info" apps/neurohub/server/ | grep -E "(API_KEY|SECRET|PASSWORD|TOKEN)"` — должны быть только masked / length / first8.

### Never-leak-secrets rule (Eugene 2026-05-09)

**Никогда не выгружаю прямые незащищённые ключи и пароли.** Ни в код, ни в чат, ни в commit-сообщения, ни в логи, ни в скриншоты, ни в bug-reports. Это абсолютное правило, выше любых других удобств.

Что считается секретом (требует защиты):
- API-ключи: `GPTUNNEL_API_KEY`, `YANDEX_SPEECHKIT_API_KEY`, `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`
- Bot-токены: `TELEGRAM_BOT_TOKEN`, `MAX_BOT_TOKEN`, `VK_ACCESS_TOKEN`
- Email/SMTP: `GMAIL_APP_PASSWORD`, `SMTP_PASS`
- Платежи: `ROBO_PASSWORD_1`, `ROBO_PASSWORD_2`
- Подписи: `SESSION_SECRET`, `SIGNED_URL_SECRET`, `CRON_SECRET`, `VK_SECRET`, `MAX_WEBHOOK_SECRET`
- SSH private keys, OAuth refresh tokens, любые credentials

НЕ секрет (можно ссылаться открыто): public IDs типа `YANDEX_FOLDER_ID`, `VK_GROUP_ID`, `YM_COUNTER_ID`, `ADMIN_TELEGRAM_ID` (chat ID не даёт доступа), `MAX_BOT_ID`.

Жёсткие требования к коду:
1. **Все секреты — только через `process.env.X`.** Никаких string-литералов с настоящим значением в `.ts`/`.js`/`.tsx`. Допустим fallback на пустую строку с `console.warn` если ключа нет.
2. **`.env.example`** в репо документирует все поддерживаемые ключи с **пустыми** значениями + комментариями где взять каждый.
3. **`.env`** в `.gitignore` — никогда не коммитим реальные значения.
4. **Commit-сообщения и code-comments** не содержат реальных значений (даже маскированных типа `pass=q***m` — длина выдаёт).
5. **Логи** маскируют секреты: `console.log("token length:", token.length)` — да; `console.log("token:", token)` — нет.

Жёсткие требования к коммуникации:
1. **Eugene не присылает мне секреты через чат / Slack / Telegram / email.** Если случайно прислал — секрет автоматически считается **навсегда скомпрометированным** (мои логи / транскрипты могут уйти в третьи руки).
2. **Я не сохраняю присланные секреты** в коде, переменных, файлах, никаких артефактах.
3. **При обнаружении leaked секрета** — немедленно (первой строкой ответа, до любых других слов) выдаю **🚨 крупное визуальное предупреждение красным маркером**:
   ```
   🚨 **СТОП — ЛИКНУЛ <ТИП_СЕКРЕТА>**
   ```
   Где `<ТИП_СЕКРЕТА>` — конкретный тип (root password / API key / bot token / JWT / SSH private key / ...). Затем — что делать сразу: revoke у провайдера, создать новый, ввести через прямой SSH (минуя чаты). Замена без отзыва не допустима. **Никогда не повторяю присланное значение** в своём ответе (даже частично).
4. **Маркер для placeholder'ов** — только `🔴ВПИШИ_СЮДА🔴`. Eugene в Termius прямо в команде заменяет на реальное значение перед Enter — строка с настоящим секретом никогда не покидает его устройство.
5. **Pull-request review-каналы** (GitHub PR comments, code reviews) тоже считаются «чат» — не вписываем туда реальные значения.

Процесс ротации после leak'а (см. также Key rotation pattern):
1. Идентифицировать какой ключ ушёл и куда (chat / commit / log)
2. У провайдера: revoke / delete / rotate. Не «изменить» — именно отозвать старый.
3. Создать новый, ввести руками с клавиатуры в SSH-сессии на VPS
4. Прописать в `.env` через `sed -i "/^KEY=/d" && echo "KEY=новое" >>` (см. Key rotation pattern)
5. `pm2 restart neurohub --update-env`
6. Проверить через `awk -F= '/^KEY/{print "length:", length($2)}'` что значение записалось без trailing-spaces / quotes
7. **Записать в pitfalls registry** что ключ X был leaked в дату Y, как именно — для следующих сессий

Этот rule сильнее «working rhythm rule» — даже если задача срочная, leaked секрет блокирует всё до полной ротации.

#### Реестр всех секретов проекта + процедура rotation

Каждый ключ/пароль ниже — секрет (compromise = доступ к ресурсу за деньги или к данным юзеров). Для каждого зафиксировано: где создать, как отозвать (revoke), ожидаемая длина, готовая команда установки на prod.

**1. `GPTUNNEL_API_KEY`** — основной API Suno + LLM (платный, без него ничего не генерируется)
- Создать: https://gptunnel.ru/api → API Keys → New
- Отозвать: там же → старый ключ → Delete
- Длина: ~32-40 символов
- Команда: `ssh root@31.130.148.107 'sed -i "/^GPTUNNEL_API_KEY=/d" /var/www/neurohub/.env && echo "GPTUNNEL_API_KEY=🔴ВПИШИ_СЮДА🔴" >> /var/www/neurohub/.env && chmod 600 /var/www/neurohub/.env && pm2 restart neurohub --update-env'`

**2. `YANDEX_SPEECHKIT_API_KEY`** — STT (распознавание голоса для audio-режима)
- Создать: https://console.cloud.yandex.ru → Сервисный аккаунт с ролью `ai.speechkit-stt.user` → API-ключ
- Отозвать: там же → API-ключ → Удалить
- Длина: ~40 символов (`AQVN...` или `t1.9eu...`)
- Команда: `ssh root@31.130.148.107 'sed -i "/^YANDEX_SPEECHKIT_API_KEY=/d" /var/www/neurohub/.env && echo "YANDEX_SPEECHKIT_API_KEY=🔴ВПИШИ_СЮДА🔴" >> /var/www/neurohub/.env && chmod 600 /var/www/neurohub/.env && pm2 restart neurohub --update-env'`

**3. `OPENAI_API_KEY`** — Whisper STT fallback + LLM fallback
- Создать: https://platform.openai.com/api-keys → Create new secret key
- Отозвать: там же → ключ → Revoke
- Длина: ~51 символ (`sk-proj-...` или `sk-...`)
- Команда: `ssh root@31.130.148.107 'sed -i "/^OPENAI_API_KEY=/d" /var/www/neurohub/.env && echo "OPENAI_API_KEY=🔴ВПИШИ_СЮДА🔴" >> /var/www/neurohub/.env && chmod 600 /var/www/neurohub/.env && pm2 restart neurohub --update-env'`

**4. `ANTHROPIC_API_KEY`** — Claude для агентов и chatbot
- Создать: https://console.anthropic.com/settings/keys → Create Key
- Отозвать: там же → ключ → Delete
- Длина: ~108 символов (`sk-ant-api03-...`)
- Команда: `ssh root@31.130.148.107 'sed -i "/^ANTHROPIC_API_KEY=/d" /var/www/neurohub/.env && echo "ANTHROPIC_API_KEY=🔴ВПИШИ_СЮДА🔴" >> /var/www/neurohub/.env && chmod 600 /var/www/neurohub/.env && pm2 restart neurohub --update-env'`

**5. `GMAIL_APP_PASSWORD`** — отправка email через Gmail SMTP
- Создать: https://myaccount.google.com/apppasswords → New app password
- Отозвать: там же → старое → Remove
- Длина: 16 символов с пробелами (например `qjgb vdds ralp juom`)
- Команда: `ssh root@31.130.148.107 'sed -i "/^GMAIL_APP_PASSWORD=/d" /var/www/neurohub/.env && echo "GMAIL_APP_PASSWORD=🔴ВПИШИ_СЮДА🔴" >> /var/www/neurohub/.env && chmod 600 /var/www/neurohub/.env && pm2 restart neurohub --update-env'`

**6. `TELEGRAM_BOT_TOKEN`** — telegram-логин + alerts
- Создать: @BotFather в Telegram → `/newbot` (или `/token` для существующего)
- Отозвать: @BotFather → `/revoke` → выбрать бота
- Длина: ~46 символов (`123456:AAxxx...`)
- Команда: `ssh root@31.130.148.107 'sed -i "/^TELEGRAM_BOT_TOKEN=/d" /var/www/neurohub/.env && echo "TELEGRAM_BOT_TOKEN=🔴ВПИШИ_СЮДА🔴" >> /var/www/neurohub/.env && chmod 600 /var/www/neurohub/.env && pm2 restart neurohub --update-env'`

**7. `ROBO_PASSWORD_1`** + **`ROBO_PASSWORD_2`** — Robokassa подпись
- Создать: https://partner.robokassa.ru → Технические настройки → пароли (генерируются при создании магазина или меняются вручную)
- Отозвать: там же → сменить пароль (старый сразу невалиден)
- Длина: 8-32 символа
- Команда: `ssh root@31.130.148.107 'sed -i "/^ROBO_PASSWORD_1=/d; /^ROBO_PASSWORD_2=/d" /var/www/neurohub/.env && echo "ROBO_PASSWORD_1=🔴PASS_1🔴" >> /var/www/neurohub/.env && echo "ROBO_PASSWORD_2=🔴PASS_2🔴" >> /var/www/neurohub/.env && chmod 600 /var/www/neurohub/.env && pm2 restart neurohub --update-env'`

**8. `VK_ACCESS_TOKEN`** + **`VK_SECRET`** — VK community API + callback signing
- Создать: VK community → Управление → Работа с API → Ключи доступа / Callback API
- Отозвать: там же → удалить ключ → создать новый
- Длина: VK_ACCESS_TOKEN ~85 символов, VK_SECRET 30+ символов
- Команда: аналогично ROBO выше, для двух ключей в одном sed/echo

**9. `MAX_BOT_TOKEN`** + **`MAX_WEBHOOK_SECRET`** — Max messenger
- Создать: Max → BotFather Max → /token
- Отозвать: /revoke
- Команда: аналогично TELEGRAM_BOT_TOKEN

**10. `SESSION_SECRET`** + **`SIGNED_URL_SECRET`** + **`CRON_SECRET`** — внутренние подписи (cookies, stream URLs, cron)
- Создать: на VPS `openssl rand -base64 32`
- Отозвать: смена значения = невалидация всех текущих сессий / cookies / stream URL'ов
- Длина: 44 символа (base64 от 32 байт)
- Команда: `ssh root@31.130.148.107 'NEW=$(openssl rand -base64 32); sed -i "/^SESSION_SECRET=/d" /var/www/neurohub/.env && echo "SESSION_SECRET=$NEW" >> /var/www/neurohub/.env && chmod 600 /var/www/neurohub/.env && pm2 restart neurohub --update-env'` (значение генерируется НА VPS, никуда не покидая)

**11. SSH ключи (на VPS)** — `~/.ssh/github_deploy`, `~/.ssh/id_*`
- Создать: `ssh-keygen -t ed25519 -C "...@..."`
- Отозвать: удалить публичный ключ из `~/.ssh/authorized_keys` на target-серверах + удалить с GitHub Settings → SSH keys
- Никогда не коммитим в репо. Никогда не пересылаем через чат.

**Универсальная проверка** (без раскрытия значения):
```
ssh root@31.130.148.107 'awk -F= "/^КЛЮЧ/{print \"length:\", length(\$2), \"first8: [\" substr(\$2,1,8) \"]\"}" /var/www/neurohub/.env'
```

Если новый ключ записан корректно — `length` совпадает с ожидаемым выше, `first8` начинается с верного префикса (например `sk-ant-` для Anthropic).

После любой ротации — обновить `docs/strategy/PITFALLS.md`: дата, какой ключ, причина (плановая / leak / истёк).

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

### Pre-push critical review rule (Eugene 2026-05-23, **сильнее Working rhythm + Auto-resume**)

**Перед КАЖДЫМ `git push` — критически перепроверяю свою же правку свежим взглядом, нахожу скрытые ошибки/нарушения, фиксю всё что обнаружил, и только при ПОЛНОЙ уверенности — push.** Применяется ко всем pushes без исключений: code / docs / migrations / любые ветки.

Анти-паттерн который правило закрывает: пушу «вроде ок» → юзер видит регрессию → следующий коммит фиксит мой же недосмотр → серия итераций где Босс ждёт. Один лишний цикл review-перед-push экономит 2-3 цикла фикс-после-push.

**Чек-лист обязательный к выполнению перед каждым push:**

1. **`git diff HEAD`** — перечитать ВСЕ свои изменения свежим взглядом (как если бы это была чужая PR на review). Не пропустить ни одну строку.
2. **Взаимосвязи** — для каждой изменённой функции / state / hook / endpoint:
   - Кто еще пишет в эти переменные/ref/LS keys?
   - Кто еще читает их?
   - Все ли writer-paths согласованы с моей логикой?
3. **Data race / dual-loading paths**:
   - Если работаю с state который грузится из cache LS + fetch — фикс работает на ОБОИХ путях?
   - Mobile-gated paths (playlistFetchEnabled, IntersectionObserver, throttles) — фикс не зависит от того что gate откроется?
   - `useState(initializer)` vs `useEffect` timing — гарантируется ли что инвариант держится с момента mount, а не только после fetch?
4. **Stale state**: если читаю из LS / sessionStorage / cache — есть ли валидация что значение всё ещё актуально (не указывает на удалённый ID / истёкший TTL)?
5. **Pre-existing CLAUDE.md rules** — НЕ нарушает ли правка ни одного rule? Особенно risk:
   - Persistent-audio-only / iOS-lock-screen-audio / Apple-audio-best-practices
   - Single-audio / Playlist-strict-selection / Playlist-category-no-mix
   - Pricing-single-source / Secrets-admin-only / Never-leak-secrets
   - Reuse-working-solutions / No-duplicates
6. **TypeScript baseline**: `npx tsc --noEmit` → диff с pre-change baseline. Допускается +0 новых errors. Pre-existing errors — не моя проблема.
7. **Loop / infinite re-render**: если useEffect вызывает setState — есть ли guard который ломает цикл? Deps включают всё что нужно?
8. **Mental dry-run** — пройти минимум 3 сценария руками:
   - (a) свежий юзер / state без LS
   - (b) restored юзер / state с **валидным** LS
   - (c) restored юзер / state со **stale** LS (значение указывает на удалённое/несуществующее)
9. **Деструктив / необратимое** — если в diff есть DELETE / DROP / TRUNCATE / force-push / схема migration без backup / удаление env-ключа — STOP. Спрашиваю Босса явно ДО push.
10. **TODO/комментарии-залипалки** — `console.log`, `// TODO`, `// FIXME`, `debugger`, hardcoded `localhost:5000` — удалить.

**После всех ✓ — push разрешён.** Если хоть один пункт не пройден — фикшу и повторяю чек-лист с пункта 1.

**Сильнее `Working rhythm rule`** (автоматический переход к следующему шагу) и **`Auto-resume rule`** (продолжаю незавершённое) — даже если задача в потоке, перед push — пауза на чек-лист.

**Сильнее `Autonomous-execution rule`** в части apply сразу — даже 🟢 low-risk правки идут через чек-лист перед push.

**Связано с:**
- Self-review-before-output rule — про ответ Боссу. Этот — про коммит/push.
- Pre-edit analysis rule — про ДО правки. Этот — про ДО push.
- Pitfalls registry rule — анти-паттерны найденные на чек-листе → запись в PITFALLS.md.
- Влёт-результат rule — один push решает на 100%. Этот rule гарантирует.

**Анти-паттерн который правило закрывает (real-world пример 2026-05-23):**
Фикс «плеер исчез» (commit `441ab5b`) применил валидацию ТОЛЬКО в `fetch().then()` callback. На mobile fetch GATED — initial render шёл из cached LS, мой фикс не выполнялся. Юзер опять видел «плеера нет». Если бы прошёл чек-лист (пункт 3 «mobile-gated paths» + пункт 8 «mental dry-run сценарии») — поймал бы это до push. Реальный фикс `bf2bf99` потребовался следующим коммитом.

### Agent-orchestrator rule (Eugene 2026-05-23, **rename 2026-05-24**)

**Каждый новый channel / bot / persona / watchdog / cron / utility AI-сервис ОБЯЗАН register'ить себя в orchestrator на старте.** Это даёт Боссу и админам один единый view «кто живой, кто молчит, кто не настроен» в `/admin/v304 → 🎬 Музa Директор`.

**Director-subordination rule (Eugene 2026-05-25, ОБЯЗАТЕЛЬНО):** «Запомни — при добавлении новых фич, которые требуют агентов, сразу назначай подчинение Директору». Любая новая фича, заводящая агента/cron/watchdog/канал/EventBus-обработчик — в ТОМ ЖЕ коммите:
1. `orchestrator.register({...})` (или через `registerEventBusAgents`-подобный bootstrap) — Директор его ВИДИТ.
2. `recordAgentActivity(id)` в его рабочем пути — Директор видит что он живой (lastSeenAt).
3. `healthCheck` probe если возможно — Директор детектит «упал».
4. `addEdge(...)` к связанным агентам + `recordEdgeUsage` при срабатывании — живой граф.
5. Если агент эмитит важные события — добавить подписчика (через `orchestrator.on` или EventBus-мост `agent-orchestrator-bridge`), чтобы эскалации/алерты НЕ уходили в пустоту.
6. Если уместно — Director-tool в `muzaTools.ts` ([ADMIN-ONLY]), чтобы Босс мог командовать агентом из чата Музы-Директора.
НЕЛЬЗЯ заводить «сирот» вне поля зрения Директора — он главный начальник бэкенда и владеет всей информацией.

**Display name (Eugene 2026-05-24): «Музa Директор»** — экспортируется из `agentOrchestrator.ts` как `DIRECTOR_NAME`. Босс «Оркестратор переименуем Музa Директор. Он контролирует всех агентов, собирает всю информацию, итоговую докладывает через аудио». Технический термин «orchestrator» остаётся в коде / id'ах / URLs (`/api/admin/v304/orchestrator/*`) — backward compat. Аудио-доклад: `POST /api/admin/v304/director/voice-report?period=today` (см. `lib/directorVoiceReport.ts` + кнопка «🎤 Доложи итоги» в orchestrator-tab).

Reference: `apps/neurohub/server/lib/agentOrchestrator.ts` + `apps/neurohub/server/lib/directorVoiceReport.ts` + полная документация в `docs/AGENT-ORCHESTRATOR.md`.

**3 шага при добавлении нового agent:**

1. **Register** в `bootstrapDefaultAgents()` (или в plugin's `onLoad`):
   ```ts
   import { orchestrator } from "@/lib/agentOrchestrator";
   orchestrator.register({
     id: "muza-newchannel",
     name: "Музa (NewChannel)",
     channel: "internal", // или extend AgentChannel
     role: "consultant",
     persona_key: "muza",
     status: process.env.NEWCHANNEL_TOKEN ? "active" : "not_configured",
     capabilities: ["chat", "voice"],
   });
   ```

2. **recordActivity** (one-line hook) в webhook handler / endpoint / cron tick после success:
   ```ts
   import { recordAgentActivity } from "@/lib/agentOrchestrator";
   recordAgentActivity("muza-newchannel", { sessionId });
   ```

3. **healthCheck** (опционально, recommended) — функция-probe при register, запускается из admin UI кнопкой «🔬 Запустить health check»:
   ```ts
   healthCheck: async () => ({ ok: !!(process.env.NEWCHANNEL_TOKEN), details: "env-check" }),
   ```

**Жёсткие правила:**

1. **Persona vs Agent** — Один agent = одна логическая роль в одном channel. Persona — маска. TG-Музa = 1 agent с persona_key="anya|tatyana|maria|olga". Web-Музa = другой agent (другой channel) с persona_key="muza".
2. **Никаких секретов в response.** Endpoints `/orchestrator/agents` и `/orchestrator/health` возвращают только status, capabilities, lastSeenAt, persona_key. Никогда — values секретных ENV.
3. **recordActivity sync + never-throws.** Если orchestrator упадёт — не должно ломать calling code. Wrap в `try { } catch {}`.
4. **Не дублировать tracking.** Если уже есть api-key health (plugin api-health) — НЕ переписывать там. Orchestrator — extends visibility, не replaces.
5. **Не использовать как RPC.** Для cross-plugin communication используй существующий `EventBus` из `core/`. Orchestrator — registry + observability layer, не bus.
6. **Lightweight bootstrap.** `bootstrapDefaultAgents()` вызывается ОДИН раз на boot до `registerRoutes`. Никаких side effects (network calls / БД writes) — только in-memory register.

**Применяется к:** всем новым каналам (WhatsApp / Instagram / SIP-calls / Email-inbound / future), всем новым watchdog/cron'ам, всем новым AI-tools. НЕ применяется к: разовым REST endpoints без long-running operation.

**Связано с:**
- Single-persona-across-channels rule — persona_key field в descriptor
- No-duplicates rule — orchestrator не дублирует api-health / channel-watchdog
- Reuse-working-solutions rule — каналы продолжают использовать existing endpoints
- Brand-style consistency rule — admin UI следует brand palette

### Marketing-orchestrator + edges extension (Eugene 2026-05-23)

**Подсистема `marketing-orchestrator` живёт ВНУТРИ Agent-orchestrator infrastructure.** Все правила выше распространяются (один register, lightweight, no secrets, idempotent).

Расширения:

1. **`AgentRole = "marketing"`** добавлена для marketing-агентов.
2. **`AgentEdge`** + методы `addEdge / getEdges / removeEdge / recordEdgeUsage / visualize` — описывают связи agent ↔ agent (pair-link / broadcast / webhook / notify / event / campaign / data-sync).
3. **Orchestrator-local event emitter** (`on / off / emitEvent`) — отдельно от core/eventBus.ts. Для marketing auto-triggers (payment.succeeded → thank-you campaign etc).
4. **`lib/marketingAgent.ts`** — campaigns / segments / calendar / A/B split / channel allocation. Никаких новых таблиц — in-memory state.
5. **Admin endpoints** `/api/admin/v304/orchestrator/edges`, `/api/admin/v304/marketing/*`.
6. **Hooks в payment-result + publish endpoints** emit'ят events; marketing-orchestrator создаёт auto-campaigns (draft со scheduledAt).

Жёсткие правила (дополнительно к existing Agent-orchestrator rule):

1. **Marketing campaigns не отправляют сообщения сами.** Они описывают что+когда+кому. Реальный dispatch — через существующие channel endpoints (Reuse-working-solutions rule).
2. **Никаких PII в campaign meta.** UserId — да. Email / phone / payment-tokens — НЕ хранить (Secrets-admin-only rule).
3. **`emitOrchestratorEvent()` fire-and-forget.** Errors swallowed. НЕ ломать payment flow.
4. **Все variants A/B split deterministic по userId** через hash — один и тот же юзер всегда видит один и тот же variant.
5. **Segments описаны в `SEGMENT_REGISTRY`** — централизованно. Реальный resolve через SQL делает routes.ts (Reuse-working-solutions rule).

Reference: `docs/AGENT-ORCHESTRATOR-PROPOSALS.md` (edge matrix + 15 предложений + API контракт).

### Denga-agent rule (Eugene 2026-05-24)

**Агент Деньга (`lib/dengaAgent.ts`) — единый источник правды для cost-tracking + profit analysis. Все revenue/cost запросы по юзерам и трекам идут через него, НЕ переисчитываются ad-hoc в других местах. Тарифы провайдеров версионированы в `lib/providerTariffs.ts` через `validFrom/validUntil` — на момент генерации.**

Босс «заведи агента по учёту затрат на каждого автора, чат, генерации по каждому треку. Если было общение между треками — затраты на счёт последнего. Анализ дохода MuzaAi по трекам / автору исходя из стоимости трека/текста/изображения на МОМЕНТ генерации. Правило для всех ранее созданных. Отчёт в админке — Агент Деньга».

**Что разделяется:**

- **Revenue** (что юзер заплатил нам) → `generations.cost` (snapshot на момент списания) + fallback на `PRICES` из routes.ts. Это user-facing pricing — единственный источник правды через `getCurrentPriceKopecks()` (Pricing-single-source rule).
- **Cost** (наши OUT-of-pocket затраты провайдерам) → `providerTariffs.ts` `TARIFF_HISTORY` per resource per provider per timestamp. НЕ путать с `tariff_history` table (та для revenue side).
- **Chat cost** → attributed к последовавшему треку (см. chat-to-track attribution алгоритм ниже).
- **Manual override** → `denga_manual_costs` table; latest wins per gen_id; через admin endpoint с requireAdmin + audit-log.

**Chat-to-track attribution (Босс rule):**

Per user: для каждого bot reply (role='bot') в чате → находим **первый gen с `createdAt > msg.createdAt`** (трек который пришёл ПОСЛЕ chat'а). Если такого нет (chat после всех gens) → attribute к **самому последнему** gen. Если у юзера 0 gens → bucket `anonymous`.

Anonymous chat (нет userId в session) → отдельный bucket `anonymous_chat_cost`. Прибавляется к global cost, НЕ привязан к юзеру.

**Жёсткие правила:**

1. **Все cost/profit запросы — через `dengaAgent.ts`.** НЕ пересчитываем cost ad-hoc в других endpoints. Если нужен новый view — расширить dengaAgent, не дублировать (No-duplicates rule).
2. **Тарифы провайдеров версионированы.** При изменении цены — добавить новую запись в `TARIFF_HISTORY` с `validFrom = millis (now)` + `validUntil = millis (now)` на старой. НИКОГДА не редактировать existing записи (потеряем историю).
3. **Manual override обязательно через `setManualCost()`** — НЕ direct INSERT в `denga_manual_costs`. Иначе пропустим audit-log + cache invalidation.
4. **Все аналитические endpoints используют `getPeriodRange()`** (Period-20-MSK rule). Без своих period-расчётов.
5. **Cache 5 минут** для aggregated данных (per-user, per-aggregates, per-anonymous). Per-track запросы — без cache (точные данные на каждый клик).
6. **PII never returned** — endpoints возвращают `name`, `phone`, `email` для admin (это admin tool, requireAdmin). Anonymous bucket не содержит userId, только session_id stats.
7. **Backfill для existing rows автоматический** — agent проходит по всем gens при первом запросе. Никаких миграций в `generations.cost_attribution`. Read-only over existing data.

**Никаких overrides без audit:**

- `POST /api/admin/v304/denga/manual-cost` — каждый override → `recordAuditEntry` с `entity: "denga_manual_cost"`, `entityKey: gen-${genId}`, `after: {override}` (Backup-before-edit rule).

**Применяется к:**

- Admin tab `💰 Деньга` (`/admin/v304/denga-tab.tsx`)
- Все cost/profit endpoints `/api/admin/v304/denga/*`
- Future LTV-based segmentation в marketing-orchestrator (через edge `denga → marketing-orchestrator (data-sync)`)

**НЕ применяется к:**

- Real-time юзерский cost view (юзер не видит наши provider costs — это коммерческая тайна)
- Billing audit (`lib/billingAudit.ts`) — он о integrity (double-charge, missed refunds), денга о PnL
- Public revenue dashboard (пока нет такой)

**Связано с:**

- Pricing-single-source rule — PRICES для revenue, TARIFF_HISTORY для cost
- Agent-orchestrator rule — register pattern (denga зарегистрирован, role=diagnostic)
- Backup-before-edit rule — manual override audit
- Period-20-MSK rule — period boundaries
- No-duplicates rule — НЕ дублирует billing-audit (разные purposes)
- Secrets-admin-only rule — все endpoints requireAdmin

Reference:
- `apps/neurohub/server/lib/dengaAgent.ts` — main entry-point + types
- `apps/neurohub/server/lib/providerTariffs.ts` — versioned provider cost catalog
- `apps/neurohub/shared/schema.ts` `dengaManualCosts` — override table
- `apps/neurohub/client/src/pages/admin/denga-tab.tsx` — admin UI
- `docs/DENGA-AGENT.md` — полная документация архитектуры

### Gen-lifecycle agent rule (Eugene 2026-05-24)

**Каждая генерация (music / lyrics / cover) полностью отслеживается через `lib/genLifecycleAgent.ts` — от нажатия «Создать» до done/errored. Auto-retry transient errors (3 attempts с backoff 30s/2min/5min) — «продавливание Suno». Неразрешимые после 3 попыток → escalate → marketing-orchestrator (apology email).**

Босс «назначь агента, отслеживает цикл, исправляет ошибки. Дай возможность продавливать Suno до генерации. Если он отработает на 100% — техподдержка в релаксе».

**Pipeline lifecycle событий:**
- `started` — gen создана + charge прошёл (hook в `/api/music/generate`)
- `suno_called` — GPTunnel вернул task_id
- `suno_failed` — GPTunnel error / no task_id (auto-retry если transient)
- `stuck_processing` — > 5 мин в processing (cron `gen-lifecycle-scan-stuck` every minute)
- `retrying` — запущен retry attempt N
- `done` — успешно (hook в webhook + polling)
- `errored` — permanent error
- `refunded` — refund pipeline сработал
- `manual_retry` / `manual_refund` / `manual_resolve` — admin actions
- `escalated` — > 3 attempts OR > 30 мин stuck → emit `gen.escalated` event

**Retry policy:**
- Attempt 1 — после 30 сек backoff
- Attempt 2 — после 2 мин backoff
- Attempt 3 — после 5 мин backoff
- Attempt 4 → forced escalation + refund (если cost > 0)
- **НЕ retry'ить:** moderation / bad_lyric / low_balance / invalid_key (юзеру нужен fix input или admin ротация ключа)

**Persistence:** все события пишутся в `gen_lifecycle_log` table (gen_id, user_id, event_type, payload JSON, created_at millis). In-memory store держит recent 500 gens (LRU eviction). Admin UI читает из БД.

**Admin endpoints** (`/api/admin/v304/gen-errors/*`):
- `GET /` — list ошибок с фильтрами (period/type/status, default today)
- `GET /stats?period=X` — counts для top-cards
- `GET /:id/report` — full event timeline для одной gen
- `POST /:id/retry` — manual retry («дожать»)
- `POST /:id/refund` body `{confirm:true}` — manual refund (с confirm)
- `POST /:id/resolve` body `{notes?}` — mark resolved без refund
- `POST /scan-stuck` — manual trigger scan stuck gens

**Admin UI** — вкладка `/admin/v304 → 🚨 Ошибки генерации` (gen-errors-tab.tsx). Live-update 15 сек. KPI cards (total / recovered / pending / escalated). Filter chips period/type/status. Row inline actions: 🔄 Дожать / 💰 Refund / ✔️ OK. Click row → drawer с полным event timeline.

**Жёсткие правила:**

1. **Reuse-working-solutions** — agent ОБЁРТКА над existing pipeline (`storage.refundGeneration`, `gptunnelFetch`, `pollProcessingGenerations`). НЕ создаёт параллельных pipelines / endpoints.
2. **НЕ дублирует `generation-agent` plugin** (refund-orphans watchdog) — работает выше уровнем (lifecycle tracking + escalation), они сосуществуют.
3. **Atomic claim перед retry** — `UPDATE generations SET status='processing' WHERE status='error' AND refunded != true` (одной командой). Без claim возможен race с orphan-scanner.
4. **`trackEvent` sync, never throws** — failure tracking не должен ломать routes.ts hot path. Wrap try/catch.
5. **Ownership/audit** — admin endpoints requireAdmin + recordAuditEntry + при refund — storage.refundGeneration (atomic + claim).
6. **Escalation = только после 3 attempts ИЛИ stuck > 30 мин**. Без преждевременной эскалации.
7. **In-memory store LRU 500** — не растёт бесконечно. Полная история в БД.

**Edges с другими agents:**
- `gen-lifecycle → marketing-orchestrator` (event) — escalation events для apology email / retention
- `gen-lifecycle → muza-admin` (webhook) — stuck/escalated alerts голосом
- `gen-lifecycle → channel-email` (notify) — refund notifications

**Связано с:**
- Agent-orchestrator rule — register pattern + edges + events
- Reuse-working-solutions rule — agent обёртка, не замена
- Backup-before-edit rule — admin destructive actions через recordAuditEntry
- User-action-failure registry rule — stuck/escalated пишутся в `user_action_failures`
- Pricing-single-source rule — refund использует existing `storage.refundGeneration`
- Brand-style consistency rule — admin UI palette glass-card + brand gradient

**TODO следующих итераций:**
- ML-classification ошибок (сейчас regex-based в `classifyError`) — нужно для лучшего routing retry vs escalate
- Per-user telemetry (юзер X получает refund 3-й раз за неделю → flag)
- Self-healing для bad_lyric (LLM переписывает текст и retry)
- Webhook delivery monitoring (если Suno webhook не дошёл за 60 сек → force polling)

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
