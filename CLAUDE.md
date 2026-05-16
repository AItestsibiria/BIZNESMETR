# CLAUDE.md — AI Assistant Guide for BIZNESMETR

This file provides context and conventions for AI assistants (Claude Code and others) working in this repository.

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

### Working rhythm rule (Eugene 2026-05-06)

**После каждого успешного промежуточного результата (отчёт Perplexity, прохождение этапа, верификация чек-пойнта) — автоматически переходи к следующему логическому шагу. Не задавай «что дальше?», не жди команды.** Останавливайся ТОЛЬКО при:
- неоднозначности, требующей выбора Евгения (тогда `AskUserQuestion`),
- риске, требующем подтверждения (cutover на prod, удаление данных, ротация ключей),
- зафиксированном сбое, который надо разобрать перед движением дальше.

В остальных случаях движение по плану — настройка по умолчанию.

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

### Play-counting rule (Eugene 2026-05-15)

**Прослушивание трека засчитывается при выполнении ВСЕХ 5 условий.** Применяется в `/api/playlist/play/:id` и `/api/gen-activity/:id/play` (server/routes.ts → `shouldCountPlay()`).

Условия:
1. **5+ секунд воспроизведения.** Frontend плеер передаёт `elapsedSec` в body POST после первых 5 сек play. Если поле отсутствует — считаем (backward-compat для старых плееров).
2. **Dedup IP/час.** Один IP не может прибавить больше 1 play на трек за 60 мин. Проверка через `gen_activity` WHERE ip=? AND action='play' AND created_at > now-1h.
3. **Author-self исключён.** Если `gen.userId == authedUserId` — НЕ считаем (плеи автора собственного трека идут в `play_rejected:author-self`, не в `play`).
4. **Admin исключён** (правило Босса «кроме админа»). Если `user.role IN ('admin', 'super_admin')` — НЕ считаем.
5. **Bot UA исключён.** User-Agent matching `/bot|crawler|spider|slurp|curl|wget|httpie|python-requests|java-http|axios|fetch|head/i` → НЕ считаем.

При неудаче пишется в `gen_activity.action='play_rejected:<reason>'` для аналитики (можно посмотреть сколько накруток отбрасывается). В `meta.plays` (JSON в `generations.style`) пишется только реальный play.

Применяется к: счётчику `meta.plays`, челофильтру для перевода новых авторов в основной плейлист (>50 за 24ч), таблице top-tracks. Не применяется к: download / copy / share — они без anti-fraud (плотность ниже).

Tuning параметров (если нужно ужесточить):
- IP-window: 60 мин (можно 24ч для жёсткости)
- Min duration: 5 сек (можно 15-30 сек как у Spotify)
- Bot list: можно расширить через ENV `BOT_UA_REGEX`

### Two-playlist rule (Eugene 2026-05-15)

**На главной 2 плейлиста: «Плейлист авторов» (одобренный, default) и «Новые авторы» (только опубликованное, ждёт челофильтра/админа).**

Состояния `generations.is_public`:
- `0` — приват (в кабинете автора, не показывается на главной)
- `1` — основной плейлист («Плейлист авторов» — одобрено редакцией)
- `2` — новые авторы («Новые авторы» — только что опубликовано, ждёт review)

Flow:
1. Автор жмёт «Опубликовать» → `is_public` становится `2` (попадает в «Новые авторы»). Автору отправляется уведомление (TODO: следующим коммитом подключить notifications).
2. На главной — toggle «Плейлист авторов» / «Новые авторы». Большие визуальные кнопки с активным glow (purple-amber для main, emerald-cyan для new). Сохраняется в localStorage пер-юзер.
3. `/api/playlist?status=main|new` — выдаёт треки соответствующего плейлиста (`is_public=1` или `=2`).
4. **Челофильтр >50/24ч**: треки в «Новые авторы» с >50 play за последние 24ч (по правилу прослушиваний — без накруток) попадают в admin-список «🔥 Кандидаты на основной». Admin одним кликом переводит.
5. Admin endpoint `POST /api/admin/v304/generations/:id/playlist {status: main|new|private}` — перевод между плейлистами + audit-log.
6. Admin endpoint `GET /api/admin/v304/playlist-candidates` — список треков `is_public=2` sort by `plays24h DESC` + флаг `hot:true` если >50.
7. Обратный flow тоже работает: трек из `main` можно вернуть в `new` (если упали показатели или есть жалобы).

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

### Max bot docs reference (Eugene 2026-05-11)

Документация Max business API для настройки бота:
- https://dev.max.ru/docs/maxbusiness/selectionservices

При работе с `plugins/max-bot/module.ts` и `plugins/max-channel/module.ts` сначала свериться с этой страницей: правильный endpoint для регистрации webhook (subscriptions), формат payload update'ов (поля `chat_id` / `sender` / `body.text`), поддержка inline keyboards и selection services. Текущий MVP в max-bot был сделан по аналогии с Telegram API — может потребовать правок после изучения.

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

### Docs-first debugging rule (Eugene 2026-05-08)

**При возникновении проблем сначала обращаюсь к официальной документации провайдера/инструмента, потом к связкам внутри проекта.** Очерёдность:

1. **Docs первым**: открываю docs.gptunnel.ru / yandex.cloud/docs / suno docs — что говорит API про этот код ошибки / лимит / формат payload.
2. **Связки проекта вторым**: уже зная что хочет провайдер, иду в наш код и смотрю где расходимся (gptunnelFetch, transcribe.ts, normalizeVocalParams).
3. **Только потом — гипотезы**.

Анти-паттерн который это закрывает: пытаюсь угадать root cause по логам, делаю фиксы вслепую, накапливаю commits. Документация решила бы за 1 минуту.

Применяется к: ошибкам интеграции с внешними сервисами (Suno/GPTunnel/Yandex/Robokassa/Telegram). Не применяется к: чисто внутренним багам (TypeScript, React state).

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

### Key-insert-marker rule (Eugene 2026-05-08)

**Когда даю SSH-команду для вставки секретного ключа — место подстановки помечаю заметным red-маркером**, чтобы Eugene не вписал ключ в неправильное место.

Стандартный маркер: `🔴ВСТАВЬ_КЛЮЧ_СЮДА🔴` или `🔴КЛЮЧ_1,КЛЮЧ_2,КЛЮЧ_3🔴` (для CSV).

Анти-паттерн который это закрывает:
- ❌ `echo "GPTUNNEL_API_KEY=YOUR_KEY"` — Eugene может оставить буквально `YOUR_KEY`, не заменив
- ❌ `echo "GPTUNNEL_API_KEY=$KEY"` — Eugene не понимает что это переменная shell, или забывает её сначала задать
- ✅ `echo "GPTUNNEL_API_KEY=🔴ВСТАВЬ_КЛЮЧ_СЮДА🔴"` — однозначно видно где замена

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
