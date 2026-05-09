# Реестр фиксов после «Триумф в Эфир» (`triumph-na-efire-080526`)

**База**: tag `triumph-na-efire-080526` → commit `13600c0` (Eugene 2026-05-08)
**Ветка разработки**: `claude/add-claude-documentation-OW5V7`
**Цель документа**: фиксированный список изменений между prod-редакцией Триумф и текущим HEAD на MuziAi prod, чтобы потом точечно реплицировать всё это на clone для тренировок без потери уже отработанных решений.

---

## Как пользоваться реестром на clone

Если clone отстал от prod (или его пересобрали с нуля) — каждый пункт ниже даёт способ повторить фикс:

1. **cherry-pick из ветки** (если git-история сохранена):
   ```bash
   git fetch origin claude/add-claude-documentation-OW5V7
   git cherry-pick <SHA>
   ```
2. **либо** взять файлы из ветки одной командой:
   ```bash
   git checkout claude/add-claude-documentation-OW5V7 -- <files>
   git commit -m "replay: <description> from prod"
   ```
3. **либо** воспроизвести руками по описанию из соответствующей секции (полезно если меняешь архитектуру и хочешь только идею, а не код 1:1)

После каждой реплики на clone — обязателен `npm run build` в `apps/neurohub/` и проверка через `https://clone.muziai.ru/#/admin → 🩺 Sync-check`.

---

## Хронология (8 коммитов, 2026-05-08 → 2026-05-09)

### 1. `d2c6bd6` — docs: tag Триумф в Эфир — 2026-05-08 12:55

**Тип**: docs (только тэг + CLAUDE.md секция)
**Что**: зафиксирован стабильный slice кодовой базы как `triumph-na-efire-080526`. В scope — refund pipeline, auto-recovery, watchdog, playlist persistence, регенерация errored, Track-title rule, /diag UI, F-pack. **НЕ в scope** — audio-модуль (mic→Yandex→Suno), его стабильность не гарантируется.
**Replay на clone**: тэг создаётся из той же точки графа, на clone уже есть. Если нужно «вернуться к Триумфу» — `git checkout triumph-na-efire-080526` локально.
**Проверка**: `git tag -l 'triumph-na-efire-*'` → должен быть один тэг.

### 2. `a97903d` — feat: GitHub Actions deploy-prod workflow — 2026-05-08 16:08

**Тип**: feat
**Файлы**:
- `.github/workflows/deploy-prod.yml` (новый, ~134 строки)

**Что**: добавлен workflow_dispatch + tag-push (`production-*`) триггер для one-click deploy с iPad/Mac/web на muziai.ru. SSH через `appleboy/ssh-action@v1.0.3`, secrets `PROD_SSH_KEY` / `PROD_HOST` / `PROD_USER`. Алгоритм: source-folder `/opt/muziai-src` → fetch/reset --hard ref → npm ci → npm run build → backup `/var/backups/neurohub-github-deploy-<TS>/` (dist + .env + db_integrity_check) → replace dist + package*.json → npm install --omit=dev → pm2 restart neurohub --update-env → smoke /api/example/ping + /api/_status.

**Required secrets** (на GitHub repo settings):
- `PROD_SSH_KEY` — приватный ключ который имеет write-доступ на 31.130.148.107:/var/www/neurohub
- `PROD_HOST` — `31.130.148.107`
- `PROD_USER` — `root`

**Replay на clone**: НЕ нужен на clone (clone деплоится через `auto-deploy.sh` по push'у в ветку, а не через GitHub Actions). Файл просто остаётся в репо — на работу clone не влияет.

**Проверка**: на GitHub https://github.com/AItestsibiria/biznesmetr/actions/workflows/deploy-prod.yml — workflow видим. Если manually disabled — Eugene включает руками в UI.

### 3. `f274aba` — feat: /api/admin/v304/sync-check + UI кнопка — 2026-05-09 00:42

**Тип**: feat
**Файлы**:
- `apps/neurohub/server/plugins/admin-overview/module.ts` — новый endpoint
- `apps/neurohub/client/src/pages/admin-v304.tsx` — Card в OverviewTab
- `CLAUDE.md` — Deploy-target-options rule

**Что**: единый endpoint для проверки целостности после deploy. Возвращает 7 секций (database / authors_folder / covers / env_vars / ffmpeg / disk / plugins) с статусами `ok`/`warn`/`fail` + summary counts. UI: кнопка «🔄 Запустить проверку» + «📋 Копировать» весь JSON + раскрывающиеся details с цветовой индикацией.

**Деплой-статус**: clone ✅ + prod ✅ (в коммите `eef81e6`)

**Replay на clone**: cherry-pick `f274aba` или скопировать файлы. После — `npm run build` + проверка `/admin/v304 → 🩺 Sync-check → Запустить`.

**Проверка**: `curl https://clone.muziai.ru/api/admin/v304/sync-check` (с admin-сессией) → JSON с 7 секциями.

### 4. `d9692bf` — docs: Prod-deploy 3-warning rule — 2026-05-09 00:44

**Тип**: docs (CLAUDE.md правило)
**Файлы**: `CLAUDE.md`
**Что**: правило процесса для Claude — перед любым deploy на prod muziai.ru требовать 3 явных подтверждения от Eugene (CLONE проверен / Backup есть / rollback-команда известна).

**Replay на clone**: правило применимо к prod, на clone не используется. Но если файл `CLAUDE.md` на clone отстал — `git checkout claude/add-claude-documentation-OW5V7 -- CLAUDE.md`.

**Проверка**: открыть `CLAUDE.md` локально → искать «Prod-deploy 3-warning rule».

### 5. `52f86aa` — fix: sync-check covers + env_vars false-positives — 2026-05-09 00:55

**Тип**: fix
**Файлы**: `apps/neurohub/server/plugins/admin-overview/module.ts`
**Что**:
- **covers**: исключаем gens младше 5 мин (saveGenFiles ещё может работать асинхронно). Для gens с `localPath = null` пытаемся найти `<id>.jpg` в любой подпапке authors/ — раньше такие admin-flow gens (anthem) ложно считались missing.
- **env_vars**: только `GPTUNNEL_API_KEY` реально критичен. `SESSION_SECRET` / `DATABASE_URL` имеют дефолты в коде → их отсутствие больше не FAIL'ит. Optional ключи (Yandex/OpenAI/Anthropic/Telegram/SMTP/Robokassa) дают warn, не fail. Каждый ключ помечен флагом `critical: bool`.

**Деплой-статус**: clone ✅ + prod ✅
**Replay на clone**: cherry-pick `52f86aa` (точечный фикс в одном файле).
**Проверка**: на пустой `.env` (только GPTUNNEL_API_KEY) запустить sync-check → `env_vars: warn`, не `fail`.

### 6. `d71c4bd` — fix: fallback-индекс `<id>.jpg` для плейлиста — 2026-05-09 01:09

**Тип**: fix (root cause v1 для проблемы «обложки в плейлисте — нота»)
**Файлы**:
- `apps/neurohub/server/routes.ts` — функция `getJpgIndex()` + fallback в `resolveCoverPath()`
- `apps/neurohub/server/plugins/admin-overview/module.ts` — endpoint `/api/admin/v304/covers/refresh-index`
- `apps/neurohub/client/src/pages/admin-v304.tsx` — кнопка «🖼 Обновить обложки»

**Что**: `resolveCoverPath()` искал обложки только через `gen.localPath` или `gen.coverGenId`. Если `localPath = null` или jpg сохранён без mp3-соседа — обложка не находилась. Добавлен `getJpgIndex()` со кэшем 5 мин — карта `gen.id → jpg path` после скана `authors/<author>/`. Используется как последний fallback. Endpoint `/api/admin/v304/covers/refresh-index` сбрасывает кэш и возвращает `{totalAuthors, totalJpg}`.

**Деплой-статус**: clone ✅ + prod ✅
**Replay на clone**: cherry-pick `d71c4bd`.
**Проверка**: `/admin/v304 → 🖼 Обновить обложки` → toast `Авторов: N, JPG: M` с цифрой > 0.

### 7. `f79136d` — fix: regex для реального формата `gen_<id>.jpg` — 2026-05-09 02:09

**Тип**: fix (root cause v2)
**Файлы**:
- `apps/neurohub/server/routes.ts`
- `apps/neurohub/server/plugins/admin-overview/module.ts`

**Что**: `saveToAuthorFolder()` сохраняет файлы как `gen_<id>.<ext>` (см. `routes.ts:53`), а мой fallback-индекс искал только `<id>.jpg` без префикса. На prod `/covers/refresh-index` возвращал `JPG: 0`. Регекс изменён на `/^(?:gen_)?(\d+)\.jpg$/i` — матчит и `gen_527.jpg`, и legacy `527.jpg`. Case-insensitive.

**Деплой-статус**: clone ✅ + prod ✅
**Replay на clone**: cherry-pick `f79136d`.
**Проверка**: `/admin/v304 → 🖼 Обновить обложки` → toast должен показать **сотни** JPG (а не 0).

### 8. `eef81e6` — fix: `/api/stream/:id?type=image` использует `resolveCoverPath` — 2026-05-09 02:16

**Тип**: fix (root cause v3 — финальный для эпика обложек)
**Файлы**: `apps/neurohub/server/routes.ts`
**Что**: плейлист на `/dashboard` рендерит обложки через `getCoverUrl(gen)` → `/api/stream/<id>?type=image`, а **НЕ** через `/api/cover/<id>.jpg`. Мой fallback-индекс (commit `f79136d`) применялся только в `/api/cover/`, а `tryServeLocal()` в `/api/stream` имел свою (старую) логику `localPath.replace(.mp3 → .jpg)`. Если `localPath = null` или mp3 не сохранён — UI получал 404 → значок ноты. Fix: `tryServeLocal()` при `wantImage = true` теперь делегирует в `resolveCoverPath()`. Для аудио (`wantImage = false`) поведение без изменений.

**Деплой-статус**: clone ✅ + prod ✅
**Replay на clone**: cherry-pick `eef81e6`.
**Проверка**: открыть `/dashboard` → плейлист → треки должны показывать реальные обложки, а не ноту-плейсхолдер. Хард-рефреш обязателен.

---

## Сводная таблица изменённых файлов

| Файл | Коммиты | Назначение |
|------|---------|------------|
| `.github/workflows/deploy-prod.yml` | a97903d | Prod-deploy workflow (новый) |
| `apps/neurohub/server/routes.ts` | d71c4bd, f79136d, eef81e6 | `getJpgIndex()`, `resolveCoverPath()`, `tryServeLocal()` |
| `apps/neurohub/server/plugins/admin-overview/module.ts` | f274aba, 52f86aa, d71c4bd, f79136d | sync-check endpoint + covers/refresh-index endpoint |
| `apps/neurohub/client/src/pages/admin-v304.tsx` | f274aba, d71c4bd | Sync-check Card + кнопка 🖼 Обновить обложки |
| `CLAUDE.md` | d2c6bd6, f274aba, d9692bf | Triumph секция + Deploy-target-options + 3-warning |
| `docs/strategy/CHANGELOG-AFTER-TRIUMPH-NA-EFIRE.md` | (этот файл) | Реестр |

---

## Реплика «всё разом» на clone (если clone полностью отстал)

```bash
# 1) убедись что ветка свежая
cd /opt/neurohub-src   # или где у тебя clone source
git fetch origin

# 2) сравни диапазон
git log --oneline 13600c0..origin/claude/add-claude-documentation-OW5V7

# 3) если совпадает с реестром — fast-forward
git checkout claude/add-claude-documentation-OW5V7
git pull --ff-only origin claude/add-claude-documentation-OW5V7

# 4) собрать и перезапустить
cd apps/neurohub && npm run build
pm2 restart neurohub --update-env

# 5) проверить
curl -s http://127.0.0.1:5000/api/_status | python3 -m json.tool | head -20
# Открыть https://clone.muziai.ru/#/admin → 🩺 Sync-check
```

Если что-то отдельное на clone отличается от prod — точечный cherry-pick по SHA из таблицы выше.

---

## Что НЕ входит в этот реестр (вне scope)

- audio-модуль (mic-recording → Yandex STT → Suno) — вне Триумфа в Эфир, фиксы по нему пишутся отдельно
- ENV-keys (`YANDEX_FOLDER_ID`, `YANDEX_SPEECHKIT_API_KEY` и т.д.) — это данные среды, не код. Реплика идёт через `/var/www/neurohub/.env` руками, а не через git
- `data.db` и `authors/` — данные пользователей, реплика только через rsync (если нужно), не через deploy
- Inkomplete: «Мастер синхронизации» — глобальный merge clone↔prod данных. Запрошен Eugene, спроектирован, реализация не начата

---

*Последнее обновление: 2026-05-09 19:11 MSK (после успешного prod-deploy `eef81e6`).*
