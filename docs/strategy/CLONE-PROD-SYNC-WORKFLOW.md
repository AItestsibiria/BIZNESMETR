# CLONE ↔ PROD sync workflow (полная инструкция)

**Дата:** 2026-05-21
**Версия:** v2 (заменяет `CLONE-SYNC-FROM-PROD-180526.md` v1)
**Правило-источник:** `Clone-first-mirror rule (Eugene 2026-05-18)` + `Prod-auto-deploy + versioned backup rule` в CLAUDE.md.

Босс (2026-05-21): «Держать синхронизацию базовых данных Prod и Clone. Привести Clone в тот же commit что Prod. Экспериментировать на Clone, потом push на Prod если OK.»

---

## TL;DR — One-command операции

| Что нужно | Команда (запуск на VPS clone, 72.56.1.149, под root) |
|---|---|
| Снять prod→clone, привести clone к тому же SHA | `bash /opt/neurohub-src/deploy/sync-prod-to-clone.sh` |
| То же, но с mp3 файлами | `bash /opt/neurohub-src/deploy/sync-prod-to-clone.sh --with-mp3` |
| То же, БЕЗ копирования .env (сохранить clone ключи) | `bash /opt/neurohub-src/deploy/sync-prod-to-clone.sh --no-env` |
| Просмотр без изменений | `bash /opt/neurohub-src/deploy/sync-prod-to-clone.sh --dry-run` |
| Промоушн clone→prod (создать tag) | `bash /opt/neurohub-src/deploy/promote-clone-to-prod.sh` |

---

## Архитектура двух VPS

| Атрибут | Prod (muzaai.ru) | Clone (clone.muziai.ru) |
|---|---|---|
| IP | `31.130.148.107` | `72.56.1.149` |
| App dir | `/var/www/neurohub` | `/var/www/neurohub` |
| Git src | `/opt/muziai-src` | `/opt/neurohub-src` |
| pm2 name | `neurohub` | `neurohub` |
| Auto-deploy | systemd timer (1 мин) | systemd timer (1 мин) |
| Watched branch | `claude/add-claude-documentation-OW5V7` | `claude/add-claude-documentation-OW5V7` |
| Backup dir (auto-deploy) | `/var/backups/neurohub-prod-auto/` | `/var/backups/neurohub-auto/` |
| Backup dir (pre-sync) | — | `/var/backups/neurohub-pre-sync/` |

Оба слушают одну ветку — после `git push` оба пуллят за ~60 сек естественно. Clone обычно подхватывает раньше (chained timer offset).

---

## Полный workflow (рекомендуемый порядок)

### Шаг 1 — Sync prod→clone (база данных + файлы)

Запускается на clone VPS (`72.56.1.149`) под root. Скрипт сам по SSH дёргает prod, делает консистентный snapshot, rsync на clone, разворачивает.

```bash
ssh root@72.56.1.149 'bash /opt/neurohub-src/deploy/sync-prod-to-clone.sh'
```

Что делает скрипт (по шагам):

1. **Pre-flight backup clone** в `/var/backups/neurohub-pre-sync/MuzaAi-Triumph-DDMMYY-HHMM.tar.gz` (data.db + .env + authors без mp3).
2. **Snapshot prod** через SSH (`sqlite3 .backup` — без stop pm2, online consistent snapshot). Tar authors/ (без mp3 по default). cp .env.
3. **rsync prod→clone** snapshot tarball'ов.
4. **Stop pm2 clone** → cp data.db → tar xzf authors → cp .env → restart pm2.
5. **git checkout** в `/opt/neurohub-src` на тот же SHA что HEAD prod-а.
6. **Rebuild + pm2 restart + health check** `/api/example/ping`.
7. **Cleanup** временных snapshot dirs на prod и clone.

После выполнения clone === prod на 100% (БД, файлы, ключи, код).

### Шаг 2 — Эксперимент на clone (feature branch + push)

Стандартный flow: правишь код локально → `git push` → systemd timer на clone пуллит за ~60 сек → проверяешь.

```bash
# Локально на dev-машине
git add ...
git commit -m "feat(...): ..."
git push -u origin claude/add-claude-documentation-OW5V7
```

Логи clone auto-deploy:
```bash
ssh root@72.56.1.149 'tail -30 /var/log/neurohub-clone-auto-deploy.log'
```

### Шаг 3 — Тест на clone

Открыть https://clone.muziai.ru и https://clone.muziai.ru/#/admin — проверить что фича работает. Smoke-тест: регистрация по телефону, генерация трека, оплата (test mode Robokassa), дашборд.

⚠️ **Если .env был синхронизирован с prod** (default режим `sync-prod-to-clone.sh`), то Robokassa и SMTP на clone используют **боевые** ключи. Тестируй с осторожностью — реальные платежи будут проходить.

Для безопасного теста: запускай sync c `--no-env` и держи на clone отдельные test-ключи Robokassa.

### Шаг 4 — Если OK → промоушн clone→prod

На clone (или dev-машине с git push'ем) запустить:

```bash
ssh root@72.56.1.149 'bash /opt/neurohub-src/deploy/promote-clone-to-prod.sh'
```

Что делает скрипт:

1. Берёт текущий HEAD SHA `/opt/neurohub-src` (то что сейчас работает на clone).
2. Rebuild + health check на clone — guarantee что код собирается.
3. Создаёт annotated git tag `prod-ready-DDMMYY-HHMM` на этом SHA.
4. Push tag в GitHub.
5. Печатает 3 варианта deploy на prod (A: GH Actions UI, B: auto-deploy timer, C: manual SSH).

**Рекомендую вариант A (GH Actions workflow_dispatch)** — full audit-log, есть kill switch, видно в GitHub UI.

URL для запуска: https://github.com/AItestsibiria/biznesmetr/actions/workflows/deploy-prod.yml → «Run workflow» → ref = `prod-ready-DDMMYY-HHMM` → Run.

### Шаг 5 — Если что-то сломалось на prod → rollback

`deploy/auto-deploy-prod.sh` имеет **встроенный auto-rollback**: при провале health-check после deploy — автоматически распаковывает pre-flight backup из `/var/backups/neurohub-prod-auto/dist-*.tar.gz` и pm2 restart. Telegram alert админу.

**Ручной rollback** (если auto-rollback не сработал или нужно вернуться к более старой версии):

```bash
ssh root@31.130.148.107 'ls -t /var/backups/neurohub-prod-auto/dist-*.tar.gz | head -10'
# выбрать backup, например dist-20260521-143022-c26c114.tar.gz
ssh root@31.130.148.107 'cd /var/www/neurohub && rm -rf dist && tar xzf /var/backups/neurohub-prod-auto/dist-20260521-143022-c26c114.tar.gz && pm2 restart neurohub --update-env'
```

Rollback БД (если миграция испортила data.db) — отдельная процедура, обычно через `data.db.before-sync-*` файлы (если sync был накануне) или через `sqlite3 .backup` snapshot c clone:

```bash
ssh root@72.56.1.149 'sqlite3 /var/www/neurohub/data.db ".backup /tmp/clone-data.db"'
scp root@72.56.1.149:/tmp/clone-data.db root@31.130.148.107:/tmp/
ssh root@31.130.148.107 'cd /var/www/neurohub && pm2 stop neurohub && cp data.db data.db.before-rollback-$(date +%s) && cp /tmp/clone-data.db data.db && pm2 start neurohub --update-env'
```

---

## SSH-setup (one-time, требует Босса)

Скрипт `sync-prod-to-clone.sh` запускается на clone и **дёргает prod по SSH**. Нужно установить SSH-trust **с clone-а на prod**.

### Вариант A (рекомендую) — `~/.ssh/config` alias

На clone VPS под root:

```bash
ssh root@72.56.1.149

# 1. Сгенерить SSH-ключ (если ещё нет)
[ -f ~/.ssh/id_ed25519 ] || ssh-keygen -t ed25519 -N "" -f ~/.ssh/id_ed25519

# 2. Скопировать pub-key с clone на prod (Босс вводит prod root password один раз)
ssh-copy-id -i ~/.ssh/id_ed25519.pub root@31.130.148.107

# 3. Создать ~/.ssh/config alias
cat >> ~/.ssh/config << 'EOF'

Host prod-muzaai
  HostName 31.130.148.107
  User root
  IdentityFile ~/.ssh/id_ed25519
  StrictHostKeyChecking accept-new
EOF

chmod 600 ~/.ssh/config

# 4. Verify
ssh prod-muzaai 'echo ok'
# Ожидаем: ok
```

После этого скрипт `sync-prod-to-clone.sh` найдёт alias `prod-muzaai` и будет использовать его автоматически.

### Вариант B (fallback) — без alias

Если SSH-config настраивать неудобно — скрипт автоматически попробует `root@31.130.148.107` напрямую. Нужно убедиться что pub-key clone-а есть в `/root/.ssh/authorized_keys` на prod (шаг 2 выше).

### Безопасность

- Pub-key clone-а в authorized_keys prod-а = clone имеет full root access на prod. Это OK для дев-команды из одного человека (Босс), но НЕ для multi-tenant deployments.
- Если нужна более узкая делегация — `command="..."` restriction в authorized_keys (ограничить только sqlite3/tar/cp). Не реализовано в текущей версии — спросить если нужно.

---

## Что синхронизируется vs нет

### Синхронизируется (через `sync-prod-to-clone.sh`):

- ✅ `data.db` — полная БД (юзеры, треки, платежи, сессии, муза-actions, audit-log)
- ✅ `authors/` — файлы (cover-обложки always; mp3 по флагу `--with-mp3`)
- ✅ `.env` — все API-ключи и секреты (отключить флагом `--no-env`)
- ✅ Git SHA — clone приводится к HEAD prod-а через `git checkout` + rebuild

### НЕ синхронизируется (разное на каждом VPS):

- ❌ nginx config (`/etc/nginx/*`) — разные домены
- ❌ pm2 ecosystem config — разные процессы (если есть differences)
- ❌ systemd auto-deploy timer/service — разные paths + branches
- ❌ Локальные backups (`/var/backups/`) — каждый VPS свой
- ❌ Логи (`/var/log/*`) — локальные
- ❌ SSH keys (`~/.ssh/*`) — каждый VPS свой

---

## Idempotency & retry

Оба скрипта **idempotent**:

- `sync-prod-to-clone.sh` — повторный запуск создаёт новый pre-flight backup (`MuzaAi-Triumph-DDMMYY-HHMM.tar.gz` уникален по времени) и применяет свежий snapshot. Retention: 20 последних backup'ов.
- `promote-clone-to-prod.sh` — если tag с тем же именем уже существует на том же SHA, скрипт продолжает (no-op). Если на другом SHA — fail с явной ошибкой.

Retry safe: если скрипт упал на шаге N — повторный запуск выполнит все шаги заново. БД snapshot через `sqlite3 .backup` — atomic, не оставит частичное состояние.

---

## Backup-naming convention

По `Backup-naming rule (Eugene 2026-05-20)`:

- Pre-sync backups: `MuzaAi-Triumph-DDMMYY-HHMM.tar.gz`
- Auto-deploy backups: `dist-YYYYMMDD-HHMMSS-<SHA7>.tar.gz` (исторический формат, не trogаем)
- Git tags: `prod-ready-DDMMYY-HHMM` (промоушн), `triumph-DDMMYY` (триумф-метки)

---

## Cron auto-sync (опционально, не реализован)

Если Босс захочет регулярную sync (например, раз в неделю в 03:00 МСК):

```bash
# На clone VPS
ssh root@72.56.1.149 'crontab -e'
# Добавить:
# 0 0 * * 0 /opt/neurohub-src/deploy/sync-prod-to-clone.sh > /var/log/sync-prod-to-clone.log 2>&1
```

В текущей реализации — manual on-demand. Если activate cron — учти что синхронизация может конфликтовать с активными dev-сессиями на clone (перепишет твои тестовые правки в БД).

---

## Troubleshooting

### `Permission denied (publickey)` при SSH к prod

→ SSH-trust не настроен. См. §SSH-setup выше.

### `data.db integrity_check FAILED`

→ Snapshot повредился. Проверь свободное место на prod (`df -h`). Re-run скрипт. Если повторяется — на prod проверить `sqlite3 data.db 'PRAGMA integrity_check;'` (если prod БД сама битая — отдельная проблема, не от sync).

### Clone не стартует после sync

→ Скорее всего runtime/migration error. Проверить `pm2 logs neurohub --lines 100`. Откатить через pre-flight backup:

```bash
ssh root@72.56.1.149 'cd /var/www/neurohub && pm2 stop neurohub && \
  tar xzf /var/backups/neurohub-pre-sync/MuzaAi-Triumph-DDMMYY-HHMM.tar.gz && \
  pm2 restart neurohub --update-env'
```

### Health check fails после rebuild

→ Скорее всего code regression. Откатить через auto-deploy backup на clone:

```bash
ssh root@72.56.1.149 'ls -t /var/backups/neurohub-auto/dist-*.tar.gz | head -5'
# выбрать → распаковать → pm2 restart
```

### Disk space фор snapshots

→ `/tmp/prod-snapshot-*` cleanup'ятся скриптом в самом конце. Если скрипт упал в середине — оставит мусор в `/tmp/`. Ручной cleanup: `rm -rf /tmp/prod-snapshot-*` на обоих VPS.

---

## Связанные правила в CLAUDE.md

- `Clone-first-mirror rule (Eugene 2026-05-18)` — обоснование подхода
- `Prod-auto-deploy + versioned backup rule (Eugene 2026-05-17)` — auto-deploy timer + rollback
- `Backup-naming rule (Eugene 2026-05-20)` — формат имён backup-файлов
- `Triumph-tag rule (Eugene 2026-05-10)` — формат git tags
- `Secrets-admin-only rule` + `Never-leak-secrets rule` — обработка .env

---

*Создано Claude по запросу Боса 2026-05-21. Заменяет CLONE-SYNC-FROM-PROD-180526.md как актуальный source-of-truth для sync workflow.*
