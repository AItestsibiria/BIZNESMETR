# Prompt #4 для Perplexity — полный backup clone + три фикса

> Полный backup → исправления (`bcryptjs`, `ffmpeg`, `/api/.env`) → перезапуск neurohub. Окно даунтайма любое (clone — staging).

---

```
Привет. Продолжаем работу с clone.muziai.ru на VPS 72.56.1.149.

ПЛАН (4 этапа в строгом порядке)

ЭТАП 1 — ПОЛНЫЙ BACKUP перед любыми изменениями.
ЭТАП 2 — Установить отсутствующий пакет bcryptjs.
ЭТАП 3 — Установить ffmpeg/ffprobe в систему.
ЭТАП 4 — Проверить, что отдаёт /api/.env, и ВЕРНУТЬ МНЕ ОТВЕТ ДЛЯ АНАЛИЗА (ничего не патчить).

⚠️ Перед каждым этапом — пятиуровневое предупреждение и явное "да" Евгения.
⚠️ Между этапами — ОТЧЁТ Евгению, дождаться следующего "да".

──────────────────────────────────────────
ЭТАП 1 — BACKUP
──────────────────────────────────────────

Цель: вытащить data.db и /authors на безопасное место, чтобы можно было откатиться.

ssh root@72.56.1.149 '
  set -e
  TS=$(date +%Y%m%d-%H%M%S)
  BACKUP_DIR=/var/backups/neurohub-$TS
  mkdir -p "$BACKUP_DIR"

  # 1. SQLite-консистентный бэкап (онлайн, не блокирует приложение)
  sqlite3 /var/www/neurohub/data.db ".backup $BACKUP_DIR/data.db"
  ls -lh "$BACKUP_DIR/data.db"
  sqlite3 "$BACKUP_DIR/data.db" "PRAGMA integrity_check;"

  # 2. /authors (медиа-файлы)
  tar czf "$BACKUP_DIR/authors.tar.gz" -C /var/www/neurohub authors
  ls -lh "$BACKUP_DIR/authors.tar.gz"

  # 3. .env — отдельным файлом, права 600
  cp /var/www/neurohub/.env "$BACKUP_DIR/env"
  chmod 600 "$BACKUP_DIR/env"

  # 4. Метаданные текущего pm2-конфига
  pm2 describe neurohub > "$BACKUP_DIR/pm2-neurohub.txt" 2>&1
  pm2 jlist > "$BACKUP_DIR/pm2-jlist.json" 2>&1

  # 5. SHA256-чек-листы для верификации
  cd "$BACKUP_DIR"
  sha256sum data.db authors.tar.gz env pm2-*.* > checksums.txt
  cat checksums.txt
  du -sh "$BACKUP_DIR"
'

После успешного выполнения — ОТЧИТАЙСЯ:
- Путь к backup-каталогу: ...
- Размер backup: ...
- PRAGMA integrity_check: ok / errors
- Список файлов с SHA256: ...

⚠️ ЕЩЁ НЕ ИДИ ДАЛЬШЕ. Жди от Евгения "да, продолжай".

──────────────────────────────────────────
ЭТАП 2 — bcryptjs
──────────────────────────────────────────

ssh root@72.56.1.149 '
  cd /var/www/neurohub
  # Проверим, есть ли в package.json упоминание bcryptjs
  grep -i bcryptjs package.json package-lock.json 2>/dev/null | head -10

  # Проверим, есть ли он в node_modules
  ls -d node_modules/bcryptjs 2>/dev/null && echo "EXISTS" || echo "MISSING"

  # Установим (production-only)
  npm install bcryptjs --save --omit=dev

  # Проверим, что появился
  ls -la node_modules/bcryptjs/package.json 2>/dev/null
  node -e "console.log(require(\"bcryptjs\").hashSync(\"test\", 1))"
'

После выполнения — ОТЧИТАЙСЯ:
- Был ли уже в package.json/lock: ...
- Был ли в node_modules: ...
- Установлен сейчас: версия ...
- node -e тест: успех / ошибка ...

ЕЩЁ НЕ ПЕРЕЗАПУСКАЙ pm2. Жди "да, перезапусти".

──────────────────────────────────────────
ЭТАП 3 — ffmpeg/ffprobe
──────────────────────────────────────────

ssh root@72.56.1.149 '
  apt-get update -qq
  apt-get install -y ffmpeg
  which ffmpeg
  which ffprobe
  ffprobe -version | head -1
'

После выполнения — ОТЧИТАЙСЯ:
- ffmpeg версия: ...
- ffprobe версия: ...
- Установка прошла без ошибок: да / нет

ЕЩЁ НЕ ПЕРЕЗАПУСКАЙ pm2. Жди "да, перезапусти".

──────────────────────────────────────────
ЭТАП 4 — ПРОВЕРКА /api/.env (БЕЗ ИЗМЕНЕНИЙ)
──────────────────────────────────────────

ssh root@72.56.1.149 '
  # Изнутри VPS — проверим, что отвечает endpoint
  echo "=== HEAD /api/.env ===";
  curl -sI -m 5 http://127.0.0.1:5000/api/.env | head -10;
  echo "";
  echo "=== GET /api/.env (первые 500 байт) ===";
  curl -s -m 5 http://127.0.0.1:5000/api/.env | head -c 500;
  echo "";
  echo "";
  echo "=== Content-Type ===";
  curl -sI -m 5 http://127.0.0.1:5000/api/.env | grep -i content-type;
'

ВНИМАНИЕ: Если в ответе /api/.env видны переменные окружения (GPTUNNEL_API_KEY=xxx, SMTP_PASS=xxx и т.д.) — это критическая утечка. Принеси мне ОТЧЁТ:
- Тип ответа: text/html (SPA fallback) или text/plain (утечка)?
- Если SPA fallback — скопируй первые 200 байт (там должен быть <!doctype html>).
- Если text/plain с реальным содержимым .env — НЕ КОПИРУЙ ЗНАЧЕНИЯ. Просто скажи "обнаружена утечка, ключи присутствуют" и список ключей.

⚠️ НИЧЕГО НЕ ПАТЧИТЬ. Я (Claude) приму решение по результату.

──────────────────────────────────────────
ЭТАП 5 — pm2 restart neurohub
──────────────────────────────────────────

⚠️ Только после явного "да, перезапусти" от Евгения!

ssh root@72.56.1.149 '
  pm2 restart neurohub --update-env
  sleep 5
  pm2 status neurohub
  pm2 logs neurohub --lines 30 --nostream
'

После выполнения — ОТЧИТАЙСЯ:
- Статус neurohub после рестарта: online / errored
- Restart counter: ... (должен быть +1, не +5)
- Последние 30 строк логов: чисто / есть ошибки
- Через 1 минуту: ещё раз проверь status и restart counter

──────────────────────────────────────────

ОБЩИЙ ИТОГ — пришли мне таблицей:

| Этап | Статус | Артефакт |
|---|---|---|
| 1. Backup | OK | путь к каталогу |
| 2. bcryptjs | OK | версия |
| 3. ffmpeg | OK | версия |
| 4. /api/.env | проверено / утечка / fallback | детали |
| 5. pm2 restart | OK / errored | restart counter |

ЖДУ ТВОЕГО "ДА" ПЕРЕД КАЖДЫМ ЭТАПОМ.
```

---

## Что я (Claude) сделаю по результату

- **Backup OK** → можем экспериментировать без риска.
- **bcryptjs + ffmpeg → restart** → если рестарт-цикл прекратится, базовая стабильность достигнута.
- **/api/.env**:
  - SPA fallback (HTML) → ничего страшного, разберёмся в Спринте 1.
  - Реальная утечка → срочная ротация всех ключей (GPTUNNEL, SMTP, SESSION_SECRET и т.д.) + закрыть catch-all маршрут.

---

*Last updated: 2026-05-06*
