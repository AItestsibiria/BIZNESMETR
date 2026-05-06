# Prompt #5 для Perplexity — деплой v304-фундамента на clone

> Цель: собрать клон-актуальный `dist`, перенести на сервер, перезапустить pm2 с откатом при необходимости. **Только clone**, прода не касаемся.

---

## Где взять код

Источник правды теперь — git-репозиторий **`aitestsibiria/biznesmetr`**, ветка **`claude/add-claude-documentation-OW5V7`**, путь `apps/neurohub/`. На сегодня там лежит v51 baseline + v304-фундамент Sprint 1 (commits `c7acace`, `3419b68`).

> Если у Perplexity нет доступа к нашему репо — Евгений выгружает `apps/neurohub/` локально (`git clone ...`, `cd apps/neurohub`) и оттуда деплоит.

---

## Prompt

```
Привет. Деплоим v304 Sprint 1 foundation на clone.muziai.ru.

⚠️ КРИТИЧНО
- Меняем ТОЛЬКО clone (/var/www/neurohub/) и его pm2-процесс neurohub.
- prod podaripesnu.ru и muziai.ru на ДРУГОМ VPS — их не касаемся.
- Перед каждой командой — пятиуровневое предупреждение, явное "да" Евгения.
- Откат-бэкап от 2026-05-06 уже лежит в /var/backups/neurohub-20260506-135834.

ЭТАП A — Подготовка локально (на машине Евгения)

Если git ещё не клонирован:
  git clone <repo-url> /tmp/biznesmetr
  cd /tmp/biznesmetr
  git checkout claude/add-claude-documentation-OW5V7

Иначе — обновить:
  cd /tmp/biznesmetr && git pull

Сборка:
  cd apps/neurohub
  npm install
  npm run build

Проверка результата:
  ls -la dist/
  # должен быть dist/index.cjs и dist/public/ (Vite output)

Упаковка:
  cd apps/neurohub
  tar czf /tmp/v304-deploy.tar.gz dist/
  ls -lh /tmp/v304-deploy.tar.gz

ЭТАП B — Перенос на clone

scp /tmp/v304-deploy.tar.gz root@72.56.1.149:/tmp/

ЭТАП C — Подмена dist на сервере (с pre-flight backup)

ssh root@72.56.1.149 '
  set -e
  TS=$(date +%Y%m%d-%H%M%S)
  cd /var/www/neurohub

  # Защитный snapshot dist на случай отката
  tar czf /var/backups/neurohub-$TS-dist.tar.gz dist/
  ls -lh /var/backups/neurohub-$TS-dist.tar.gz

  # Подменяем
  rm -rf dist
  tar xzf /tmp/v304-deploy.tar.gz
  ls -la dist/ | head -10
'

ЭТАП D — Рестарт и smoke

ssh root@72.56.1.149 '
  pm2 restart neurohub --update-env
  sleep 5
  pm2 status neurohub
  echo "=== logs ==="
  pm2 logs neurohub --lines 50 --nostream
  echo "=== smoke /api/example/ping ==="
  curl -s http://127.0.0.1:5000/api/example/ping
  echo ""
  echo "=== plugins_registry ==="
  sqlite3 /var/www/neurohub/data.db "SELECT name, version, status, loaded_at FROM plugins_registry;"
  echo "=== v304 tables ==="
  sqlite3 /var/www/neurohub/data.db ".tables" | tr " " "\n" | grep -E "^(events|plugins_registry|feature_flags|leads|agent_actions|tracking_attribution)$"
'

ЭТАП E — Live test (опционально)

В браузере:
  https://clone.muziai.ru/api/example/ping
  → ожидается JSON {"data":{"pong":true,"ts":...},"error":null}

Открыть в incognito:
  https://clone.muziai.ru/?utm_source=test&utm_medium=manual&utm_campaign=v304

Через 5 сек:
ssh root@72.56.1.149 '
  sqlite3 /var/www/neurohub/data.db "SELECT id, fingerprint, first_seen FROM leads ORDER BY id DESC LIMIT 3;"
  sqlite3 /var/www/neurohub/data.db "SELECT id, lead_id, first_utm_source, first_utm_campaign FROM tracking_attribution ORDER BY id DESC LIMIT 3;"
  sqlite3 /var/www/neurohub/data.db "SELECT id, name, source_module, occurred_at FROM events ORDER BY occurred_at DESC LIMIT 5;"
'

Должны появиться:
  - leads: новая запись с fingerprint
  - tracking_attribution: utm_source=test, utm_campaign=v304
  - events: запись 'lead.captured' от source_module='lead-capture'

ЭТАП F — Откат (если что-то сломалось)

ssh root@72.56.1.149 '
  pm2 stop neurohub
  cd /var/www/neurohub
  rm -rf dist
  tar xzf /var/backups/neurohub-<TS>-dist.tar.gz
  pm2 restart neurohub
  pm2 logs neurohub --lines 30 --nostream
'

────────────────────────────────────────────

ОТЧЁТ

| Этап | Статус | Артефакт |
|---|---|---|
| A. Сборка | OK / fail | размер dist |
| B. Перенос | OK / fail | размер архива |
| C. Подмена | OK / fail | путь к pre-flight dist snapshot |
| D. Рестарт | OK / errored | restart counter, статус, /api/example/ping |
| E. Live test | OK / partial | leads / tracking / events — что появилось |

Если на любом этапе ошибка — НЕМЕДЛЕННО ЭТАП F и пришли мне:
  - текст ошибки
  - последние 50 строк pm2 logs
  - результат отката
```

---

## Что я делаю по результату

- **Всё OK** → отмечаю Sprint 1 закрытым, открываю Sprint 2 (Suno на 100%): структурные теги, tempo/mood/key, negative prompts, 10 шаблонов, расширение `generations`.
- **Сборка падает** → diff между текущим v51 и моими правками; правки минимальные, обычно 1-2 проблемы (типы, паттерны импортов).
- **/api/example/ping не отвечает** → проверяем pm2 logs, ищем `[boot] v304 registry online (2 modules)` и ошибку плагина.
- **plugins_registry пустой** → registry упал на bootstrap, ловим в logs `[registry] module ... failed to load`.
- **leads пустой при visit с UTM** → проблема в client-side `tracking.ts` или в плагине `lead-capture`.

---

*Last updated: 2026-05-06*
