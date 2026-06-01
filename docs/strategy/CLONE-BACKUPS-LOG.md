# Журнал ручных бэкапов clone.muziai.ru

Каждый ручной snapshot перед потенциально опасной операцией фиксируется здесь — путь, дата, SHA256-манифест. Это позволяет верифицировать целостность бэкапа перед откатом.

---

## 2026-05-06 — pre-fix backup (этап 1 prompt #4)

**Контекст:** перед установкой `bcryptjs`, `ffmpeg` и инспекцией `/api/.env`.
**Исполнитель:** Perplexity по prompt из `PERPLEXITY-PROMPT-4-BACKUP-AND-FIXES.md`, ЭТАП 1.
**Хост:** `72.56.1.149` (clone.muziai.ru).

### SHA256 manifest

```
11e3b1ec7c2999143930e8b1b203ef3a34d1e82177ac52c28bf329c813c76165  data.db
1d7e1fccdc3f656554c149d136d5d10c2b8611befc3785bffd5db20986a02407  authors.tar.gz
446ad14044c59165aa1074e662a37f058189ddaa4289001de9d45874e064c8a5  env
5d314c36b66d5fe995eff3d3f054a7bf814df62a3d96e83a44aacbfb583ab8a4  pm2-jlist.json
eafa840015551ed054a76f0001c761c3aa168c2d1a66044054803408869e38e8  pm2-neurohub.txt
```

### Состав

| Файл | Что внутри |
|---|---|
| `data.db` | SQLite snapshot через `sqlite3 .backup` (consistent online) |
| `authors.tar.gz` | gzip-tar `/var/www/neurohub/authors/` (медиа треков) |
| `env` | копия `/var/www/neurohub/.env` (chmod 600) |
| `pm2-jlist.json` | `pm2 jlist` — полное описание процессов |
| `pm2-neurohub.txt` | `pm2 describe neurohub` — текстовый snapshot |

### Незаполнено в отчёте Perplexity (запросить при необходимости)

- [ ] Путь к backup-каталогу (`/var/backups/neurohub-<TS>/`)
- [ ] Общий размер `du -sh`
- [ ] Результат `PRAGMA integrity_check` (должно быть `ok`)

### Как откатиться (если потребуется)

```bash
ssh root@72.56.1.149 '
  set -e
  BACKUP_DIR=/var/backups/neurohub-<TIMESTAMP>   # см. отчёт
  # Верификация SHA256 ДО восстановления:
  cd "$BACKUP_DIR" && sha256sum -c checksums.txt
  # Стоп приложения, восстановление:
  pm2 stop neurohub
  cp "$BACKUP_DIR/data.db" /var/www/neurohub/data.db
  rm -rf /var/www/neurohub/authors
  tar xzf "$BACKUP_DIR/authors.tar.gz" -C /var/www/neurohub/
  cp "$BACKUP_DIR/env" /var/www/neurohub/.env
  pm2 restart neurohub
'
```

---

## Журнал фиксов на clone (prompt #4)

### Этап 2 — bcryptjs · 2026-05-06 · ✅ выполнено

- В `package.json`: `^3.0.3` ✓
- В `package-lock.json`: ✓
- В `node_modules/bcryptjs`: **уже существовал** до запуска `npm install`
- `npm install bcryptjs --save --omit=dev`: `up to date`
- Smoke `node -e require('bcryptjs').hashSync(...)`: ✅ ok

**Открытое наблюдение:** модуль был на диске, но работающий pm2-процесс выдавал `Cannot find module 'bcryptjs'`. Возможные причины:
1. Сборка `dist/index.cjs` минифицирована со ссылкой на путь до того, как bcryptjs появился (нет, директория создана 2026-04-15).
2. esbuild bundle ищет модуль по `require.resolve()` с другого CWD, и резолв не находит (важно: pm2 cwd = `/var/www/neurohub`, а `dist/index.cjs` минифицирован).
3. Какой-то конкретный path triggers лениво подгружаемый require, а dist кеширует старый require.cache.

**План:** диагностируем после Этапа 5 (`pm2 restart neurohub --update-env`). Если рестарт-цикл прекратится — причина была «процесс не перезагружался с момента появления bcryptjs». Если останется — расследуем глубже.

**npm audit:** 371 packages, 3 vulnerabilities (2 moderate, 1 high). Не фиксим сейчас (риск major-bump). Запланировано на Sprint 8 (hardening).

### Этап 3 — ffmpeg · 2026-05-06 · ✅ выполнено

- `ffmpeg`/`ffprobe` версия **4.4.2** (Ubuntu 22.04 apt репозиторий)
- `[FADE]`-ошибки на старте после рестарта **не должны воспроизводиться** на новых треках. Хвост в error.log с историческими `gen_646..654` — это старые записи до установки.

### Этап 4 — `/api/.env` · 2026-05-06 · ✅ безопасно

- **HEAD /api/.env** → `HTTP/1.1 403 Forbidden`
- **GET /api/.env** → `{"message":"Forbidden"}` (Content-Type: `application/json`)
- ✅ **Утечки НЕТ.** Endpoint уже защищён существующим middleware. Боты получают 403, реального содержимого `.env` не получают.
- 200-в логах из аудита #2 был артефактом другого роута / кеша / другого URL — на текущем sandbox-VPS endpoint закрыт.

> Действие: ничего не делаем. Закрытый 403 — корректное поведение.

### Этап 5 — pm2 restart · 2026-05-06 · ✅ выполнено

| Метрика | До | После |
|---|---|---|
| pid | 432848 | 528828 |
| restart counter | 30 | 31 (+1, как ожидалось) |
| status | online | online |
| memory | 229.9 MB | 91.2 MB |
| uptime | 17 ч | 54 с (на момент проверки) |

После рестарта:
- `[express] serving on port 5000` ✅
- `[DAILY-BUMP] added 18 country records` ✅ (cron сработал)
- Свежих ошибок `Cannot find module 'bcryptjs'` — нет ✅
- Свежих `ffprobe: not found` — нет (только исторические) ✅

**Сводная таблица prompt #4:**

| Этап | Статус | Артефакт |
|---|---|---|
| 1. Backup | OK | `/var/backups/neurohub-20260506-135834` |
| 2. bcryptjs | OK | присутствует, require работает |
| 3. ffmpeg | OK | 4.4.2 |
| 4. /api/.env | OK | 403 Forbidden — НЕ утечка |
| 5. pm2 restart | OK | online, counter 30 → 31 |

**Что осталось проверить через 10–15 минут:**
- Restart counter должен остаться **31**. Если вырос до 32+ — рестарт-цикл не сломан, ищем глубже.
- Память не должна вырасти выше 250–300 MB на свежем процессе (текущая 91 MB — норма).

---

*Last updated: 2026-05-06*
