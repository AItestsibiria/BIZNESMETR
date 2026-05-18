# Sync prod → clone (готовые SSH-команды)

**Дата:** 18 мая 2026  
**Цель:** clone.muziai.ru должен стать копией muzaai.ru (с учётом генераций треков юзеров).

После sync — все тесты на clone, потом cherry-pick на prod через GH Actions.

---

## Workflow

```
LOCAL → git push (feature branch)
         ↓
    clone.muziai.ru (auto-deploy, тестирование)
         ↓
    ✅ Босс одобрил
         ↓
    GH Actions workflow_dispatch на prod
         ↓
    muzaai.ru (production)
```

---

## Команды для одноразовой синхронизации

Все 4 шага — в **Termius**, копируешь и Enter.

### Шаг 1 — Snapshot prod (на 31.130.148.107)

```bash
ssh root@31.130.148.107 'set -e; \
  cd /var/www/neurohub && \
  STAMP=$(date +%Y%m%d-%H%M%S) && \
  echo "[1/3] Stopping pm2 для consistent snapshot..." && \
  pm2 stop neurohub && \
  echo "[2/3] Backup data.db (SQLite .backup мгновенный)..." && \
  sqlite3 data.db ".backup /tmp/prod-data-$STAMP.db" && \
  echo "[3/3] Tar authors/ directory..." && \
  tar czf /tmp/prod-authors-$STAMP.tar.gz authors/ && \
  pm2 start neurohub && \
  echo "✅ Snapshot готов:" && \
  ls -lh /tmp/prod-data-$STAMP.db /tmp/prod-authors-$STAMP.tar.gz'
```

После запуска — увидишь две строки с размером и timestamp.

### Шаг 2 — Скачать snapshot на свой Mac (если хочешь локальную копию)

Опционально — для архива:
```bash
scp root@31.130.148.107:/tmp/prod-data-*.db ~/Desktop/
scp root@31.130.148.107:/tmp/prod-authors-*.tar.gz ~/Desktop/
```

### Шаг 3 — Передать на clone напрямую (без посредника, быстрее)

```bash
ssh root@31.130.148.107 'set -e; \
  STAMP=$(ls -t /tmp/prod-data-*.db | head -1 | sed "s|.*prod-data-||" | sed "s|.db||") && \
  echo "Передаём snapshot $STAMP на clone (72.56.1.149)..." && \
  scp -o StrictHostKeyChecking=no /tmp/prod-data-$STAMP.db root@72.56.1.149:/tmp/ && \
  scp -o StrictHostKeyChecking=no /tmp/prod-authors-$STAMP.tar.gz root@72.56.1.149:/tmp/ && \
  echo "✅ Передано"'
```

⚠️ Нужно чтобы prod знал SSH-ключ clone'а — настраивается через `ssh-keygen` + `authorized_keys` на clone. Если SSH-trust не настроен, делаешь через свой Mac (Шаг 2 + потом upload с Mac на clone).

### Шаг 4 — Применить snapshot на clone (на 72.56.1.149)

```bash
ssh root@72.56.1.149 'set -e; \
  cd /var/www/neurohub && \
  STAMP=$(ls -t /tmp/prod-data-*.db | head -1 | sed "s|.*prod-data-||" | sed "s|.db||") && \
  echo "[1/5] Останавливаем pm2..." && \
  pm2 stop neurohub && \
  echo "[2/5] Backup текущей data.db и authors/ (откат если что)..." && \
  cp data.db data.db.before-sync-$STAMP && \
  mv authors authors.before-sync-$STAMP && \
  echo "[3/5] Применяем prod-snapshot..." && \
  cp /tmp/prod-data-$STAMP.db data.db && \
  tar xzf /tmp/prod-authors-$STAMP.tar.gz && \
  echo "[4/5] Чистим временные..." && \
  rm /tmp/prod-data-$STAMP.db /tmp/prod-authors-$STAMP.tar.gz && \
  echo "[5/5] pm2 start..." && \
  pm2 start neurohub --update-env && \
  sleep 5 && \
  curl -s -o /dev/null -w "Health: %{http_code}\n" https://clone.muziai.ru/api/example/ping && \
  echo "✅ Clone синхронизирован с prod. Backup в data.db.before-sync-$STAMP + authors.before-sync-$STAMP"'
```

### Шаг 5 (опционально) — Откат если что-то пошло не так

```bash
ssh root@72.56.1.149 'set -e; \
  cd /var/www/neurohub && \
  STAMP=$(ls -t data.db.before-sync-* | head -1 | sed "s|.*before-sync-||") && \
  pm2 stop neurohub && \
  cp data.db.before-sync-$STAMP data.db && \
  rm -rf authors && \
  mv authors.before-sync-$STAMP authors && \
  pm2 start neurohub --update-env && \
  echo "✅ Откат на $STAMP выполнен"'
```

---

## После sync — Workflow тестирования

| Что | Команда / URL |
|---|---|
| **Открыть clone** | https://clone.muziai.ru |
| **Открыть admin clone** | https://clone.muziai.ru/#/admin |
| **Smoke-test** | Зарегистрироваться, сгенерить трек, оплатить (test mode Robokassa), проверить дашборд |
| **Push новых правок** | `git push -u origin claude/add-claude-documentation-OW5V7` → clone auto-deploy (~60-90 сек) |
| **Если OK** → deploy на prod | Открыть https://github.com/AItestsibiria/biznesmetr/actions/workflows/deploy-prod.yml → «Run workflow» → выбрать branch |
| **Если не OK** → откат на clone | `ssh root@72.56.1.149 'cd /var/www/neurohub && cat /var/backups/neurohub-auto/dist-*.tar.gz \| head -10'` → выбрать backup → `tar xzf` |

---

## Регулярная синхронизация (раз в неделю — опционально)

Можно добавить cron на prod который раз в неделю делает snapshot и пушит на clone. Скрипт `deploy/sync-prod-to-clone.sh`:

```bash
#!/bin/bash
# Cron: каждое воскресенье в 03:00 МСК
# 0 3 * * 0 root /usr/local/bin/sync-prod-to-clone.sh

set -e
STAMP=$(date +%Y%m%d-%H%M%S)
sqlite3 /var/www/neurohub/data.db ".backup /tmp/prod-data-$STAMP.db"
tar czf /tmp/prod-authors-$STAMP.tar.gz -C /var/www/neurohub authors/
scp /tmp/prod-data-$STAMP.db root@72.56.1.149:/tmp/
scp /tmp/prod-authors-$STAMP.tar.gz root@72.56.1.149:/tmp/
ssh root@72.56.1.149 "cd /var/www/neurohub && pm2 stop neurohub && cp /tmp/prod-data-$STAMP.db data.db && tar xzf /tmp/prod-authors-$STAMP.tar.gz && pm2 start neurohub --update-env"
rm /tmp/prod-data-$STAMP.db /tmp/prod-authors-$STAMP.tar.gz
echo "Sync done at $STAMP"
```

Активировать (если нужна regular sync):
```bash
ssh root@31.130.148.107 'cat > /usr/local/bin/sync-prod-to-clone.sh << EOF
🔴ВПИШИ_СКРИПТ_ВЫШЕ🔴
EOF
chmod +x /usr/local/bin/sync-prod-to-clone.sh && \
(crontab -l 2>/dev/null; echo "0 3 * * 0 /usr/local/bin/sync-prod-to-clone.sh > /var/log/sync-prod-to-clone.log 2>&1") | crontab -'
```

---

## Что НЕ синхронизируется

- **PM2 ecosystem config** — у каждого VPS свой
- **nginx config** — разные домены
- **systemd auto-deploy timer** — разные ветки и paths
- **`/var/log/*`** — локальные логи

## Что СИНХРОНИЗИРУЕТСЯ (включая .env)

**Eugene 2026-05-18 Босс «100% должны быть одинаковы, ключи рабочие туда же переноси»:**

Шаг 6 (новый) — копия `.env`:

```bash
ssh root@31.130.148.107 'set -e; \
  STAMP=$(date +%Y%m%d-%H%M%S) && \
  cp /var/www/neurohub/.env /tmp/prod-env-$STAMP && \
  scp -o StrictHostKeyChecking=no /tmp/prod-env-$STAMP root@72.56.1.149:/tmp/'

ssh root@72.56.1.149 'set -e; \
  cd /var/www/neurohub && \
  STAMP=$(ls -t /tmp/prod-env-* | head -1 | sed "s|.*prod-env-||") && \
  cp .env .env.before-sync-$STAMP && \
  cp /tmp/prod-env-$STAMP .env && \
  chmod 600 .env && \
  rm /tmp/prod-env-$STAMP && \
  pm2 restart neurohub --update-env && \
  echo "✅ .env скопирован с prod на clone (backup: .env.before-sync-$STAMP)"'
```

### ⚠️ ВАЖНО при копировании .env

Все ключи прода теперь активны на clone. Что это значит:

- **Robokassa** — clone будет принимать **РЕАЛЬНЫЕ платежи** (раньше был test/null). Тестировать оплату только на маленькую сумму!
- **GPTUNNEL / OpenAI** — генерации с clone списываются с **общего баланса** прода. Не делать массовый stress-test.
- **Telegram bot token** — тот же бот будет получать webhook'и от обоих VPS одновременно (потенциально 2× уведомлений). Если важно — изменить webhook только на одном.
- **SMTP** — emails будут отправляться от того же hello@muzaai.ru. Не делать массовые рассылки тестов.

### Если нужно НЕ копировать sensitive ключи

Альтернативный вариант — копировать .env **минус Robokassa и SMTP**:

```bash
ssh root@31.130.148.107 'grep -v "^ROBO_\|^SMTP_\|^GMAIL_" /var/www/neurohub/.env > /tmp/prod-env-safe.txt'
scp root@31.130.148.107:/tmp/prod-env-safe.txt root@72.56.1.149:/tmp/
ssh root@72.56.1.149 'cd /var/www/neurohub && cp .env .env.bak && grep "^ROBO_\|^SMTP_\|^GMAIL_" .env > /tmp/clone-payment-keys.txt && cat /tmp/prod-env-safe.txt /tmp/clone-payment-keys.txt > .env && chmod 600 .env && pm2 restart neurohub --update-env'
```

Это сохраняет существующие Robokassa/SMTP ключи clone (test mode), копирует всё остальное с prod.

---

## Backup-точки которые останутся после sync

- На prod: `/var/backups/neurohub-prod-auto/dist-*.tar.gz` (10 последних deploy'ев)
- На clone: `data.db.before-sync-YYYYMMDD-HHMMSS` + `authors.before-sync-YYYYMMDD-HHMMSS`
- Локально: git tags (perma-точки в кодовой истории)

---

*Создано Eugene + Claude, 18 мая 2026.*
