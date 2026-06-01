# Prompt #5 для Perplexity — деплой v304-фундамента на clone

> Все URL и пути — конкретные, без плейсхолдеров. Просто копируй блок целиком.

---

## Что попадёт на сервер

`apps/neurohub/` версии Sprint 1 close — поверх существующего v51 baseline.
Источник: `deploy/v304-sprint-1-src.tar.gz` в репозитории `aitestsibiria/biznesmetr`, ветка `claude/add-claude-documentation-OW5V7`.

| Параметр | Значение |
|---|---|
| Repo | `aitestsibiria/biznesmetr` |
| Branch | `claude/add-claude-documentation-OW5V7` |
| Tarball path в репо | `deploy/v304-sprint-1-src.tar.gz` |
| Tarball SHA256 | `2a28b37fe05cc1f1fe4f9601083574b8d6e537a787d238d884e15f15009de356` |
| Размер | 2.7 МБ |
| Raw URL (если репо публичен) | `https://raw.githubusercontent.com/AItestsibiria/biznesmetr/claude/add-claude-documentation-OW5V7/deploy/v304-sprint-1-src.tar.gz` |

---

## Prompt

```
Привет. Деплоим v304 Sprint 1 foundation на clone.muziai.ru.

⚠️ КРИТИЧНО
- Меняем ТОЛЬКО clone (/var/www/neurohub/) и его pm2-процесс neurohub.
- prod podaripesnu.ru и muziai.ru на ДРУГОМ VPS — их НЕ касаемся.
- Перед каждой командой — пятиуровневое предупреждение, явное "да" Евгения.
- Откат-бэкап от 2026-05-06 уже лежит в /var/backups/neurohub-20260506-135834.

ИСТОЧНИК v304 SOURCE
Repo: aitestsibiria/biznesmetr
Branch: claude/add-claude-documentation-OW5V7
Tarball: deploy/v304-sprint-1-src.tar.gz
SHA256: 2a28b37fe05cc1f1fe4f9601083574b8d6e537a787d238d884e15f15009de356

ЭТАП A — Получить tarball на VPS

Попробуй один из путей в порядке предпочтения:

A1. git clone (если git доступен и репо публичен либо есть креды):
  ssh root@72.56.1.149 '
    set -e
    rm -rf /tmp/biznesmetr
    git clone --branch claude/add-claude-documentation-OW5V7 --depth 1 \
      https://github.com/AItestsibiria/biznesmetr.git /tmp/biznesmetr
    ls -lh /tmp/biznesmetr/deploy/v304-sprint-1-src.tar.gz
  '

A2. wget raw URL (если репо публичен):
  ssh root@72.56.1.149 '
    set -e
    mkdir -p /tmp/v304-deploy
    wget -O /tmp/v304-deploy/v304-sprint-1-src.tar.gz \
      https://raw.githubusercontent.com/AItestsibiria/biznesmetr/claude/add-claude-documentation-OW5V7/deploy/v304-sprint-1-src.tar.gz
  '

A3. scp с локальной машины Евгения (он сделал git pull локально):
  scp /path/to/biznesmetr/deploy/v304-sprint-1-src.tar.gz root@72.56.1.149:/tmp/v304-deploy/

ЕСЛИ ВСЕ ТРИ ПУТИ НЕ РАБОТАЮТ — ОСТАНОВИСЬ И СПРОСИ ЕВГЕНИЯ
(возможно репо приватный без read-токена; Евгений тогда сделает pull локально и пришлёт scp).

После успешного скачивания — верификация:
  ssh root@72.56.1.149 '
    cd /tmp  # или /tmp/v304-deploy
    sha256sum biznesmetr/deploy/v304-sprint-1-src.tar.gz 2>/dev/null \
      || sha256sum /tmp/v304-deploy/v304-sprint-1-src.tar.gz
  '
Ожидаем: 2a28b37fe05cc1f1fe4f9601083574b8d6e537a787d238d884e15f15009de356
Если SHA не совпадает — стоп, не деплоим повреждённый артефакт.

ЭТАП B — Pre-flight backup текущего dist

ssh root@72.56.1.149 '
  set -e
  TS=$(date +%Y%m%d-%H%M%S)
  cd /var/www/neurohub
  tar czf /var/backups/neurohub-$TS-dist.tar.gz dist/
  ls -lh /var/backups/neurohub-$TS-dist.tar.gz
  echo "BACKUP_TS=$TS"
'

ОТЧИТАЙСЯ Евгению значением BACKUP_TS — это точка возврата.
ЖДИ "да, продолжай".

ЭТАП C — Распаковка + сборка на сервере

ssh root@72.56.1.149 '
  set -e
  rm -rf /tmp/neurohub-build
  mkdir -p /tmp/neurohub-build
  cd /tmp/neurohub-build

  # Берём tarball, который скачали в этапе A (укажи правильный путь)
  TAR=$(ls /tmp/biznesmetr/deploy/v304-sprint-1-src.tar.gz \
        /tmp/v304-deploy/v304-sprint-1-src.tar.gz 2>/dev/null | head -1)
  test -n "$TAR" || { echo "tarball not found"; exit 1; }
  tar xzf "$TAR"

  # Переиспользуем существующий node_modules для скорости
  cp -r /var/www/neurohub/node_modules ./node_modules

  # Подгружаем недостающие зависимости (drizzle-zod уже есть в v51, нет новых)
  npm install --omit=dev

  # Сборка
  npm run build

  ls -la dist/ | head -10
'

ЖДИ "да, продолжай".

ЭТАП D — Swap dist + restart

ssh root@72.56.1.149 '
  set -e
  cd /var/www/neurohub
  rm -rf dist
  cp -r /tmp/neurohub-build/dist ./
  pm2 restart neurohub --update-env
  sleep 5
  pm2 status neurohub
  pm2 logs neurohub --lines 50 --nostream
'

В логах ищи:
  - "[boot] info v304 registry online (2 modules)"
  - НЕ должно быть "[registry] error module ... failed to load"
  - НЕ должно быть "Cannot find module ..."

ЭТАП E — Smoke

ssh root@72.56.1.149 '
  echo "=== /api/example/ping ==="
  curl -s http://127.0.0.1:5000/api/example/ping
  echo

  echo "=== plugins_registry ==="
  sqlite3 /var/www/neurohub/data.db \
    "SELECT name, version, status, loaded_at FROM plugins_registry;"

  echo "=== v304 tables ==="
  sqlite3 /var/www/neurohub/data.db ".tables" | tr " " "\n" | \
    grep -E "^(events|plugins_registry|feature_flags|leads|agent_actions|tracking_attribution)$"
'

Должны увидеть:
  - {"data":{"pong":true,"ts":...},"error":null}
  - example | 0.1.0 | active | 2026-05-06T...
  - lead-capture | 0.1.0 | active | 2026-05-06T...
  - все 6 v304-таблиц

ЭТАП F — Live UTM test (опционально)

В incognito браузере открыть:
  https://clone.muziai.ru/?utm_source=test&utm_medium=manual&utm_campaign=v304-sprint1

Через 10 сек:
ssh root@72.56.1.149 '
  sqlite3 /var/www/neurohub/data.db \
    "SELECT id, fingerprint, first_seen FROM leads ORDER BY id DESC LIMIT 3;"
  sqlite3 /var/www/neurohub/data.db \
    "SELECT id, lead_id, first_utm_source, first_utm_campaign FROM tracking_attribution ORDER BY id DESC LIMIT 3;"
  sqlite3 /var/www/neurohub/data.db \
    "SELECT id, name, source_module, occurred_at FROM events ORDER BY occurred_at DESC LIMIT 5;"
'

Ожидаем:
  - leads: новый ряд с fingerprint
  - tracking_attribution: utm_source=test, utm_campaign=v304-sprint1
  - events: запись 'lead.captured' от source_module='lead-capture'

ЭТАП G — Откат (если нужен)

ssh root@72.56.1.149 '
  pm2 stop neurohub
  cd /var/www/neurohub
  rm -rf dist
  tar xzf /var/backups/neurohub-<BACKUP_TS из этапа B>-dist.tar.gz
  pm2 restart neurohub
  pm2 logs neurohub --lines 30 --nostream
'

────────────────────────────────────────────

ИТОГОВЫЙ ОТЧЁТ

| Этап | Статус | Артефакт |
|---|---|---|
| A. Tarball на VPS | OK / fail | какой путь сработал, SHA256 совпал |
| B. Pre-flight backup | OK | BACKUP_TS |
| C. Build | OK / fail | размер dist |
| D. Swap + restart | OK / errored | restart counter |
| E. Smoke | OK / partial | ping ответил, plugins_registry содержит 2 модуля, 6 таблиц |
| F. Live UTM test | OK / partial | leads/tracking/events |

При ошибке на любом этапе — НЕМЕДЛЕННО ЭТАП G и пришли мне:
  - текст ошибки
  - последние 50 строк pm2 logs
  - результат отката
```

---

## Что я (Claude) делаю по результату

- Все 6 этапов OK → отмечаю Sprint 1 закрытым на сервере, открываю Sprint 2 (Suno на 100%).
- A провалился (нет git/wget) → подскажу Евгению как сделать локальный `git pull` и `scp`.
- C провалился (build error) → ищу проблему типов или импортов; правлю commit + новый tarball.
- D/E провалились (registry не загрузился) → читаю pm2 logs, ищу `[registry] failed to load`.
- F пустой (UTM не пишутся) → проверяю tracking.ts на клиенте + lead-capture endpoint.

---

*Last updated: 2026-05-06*
