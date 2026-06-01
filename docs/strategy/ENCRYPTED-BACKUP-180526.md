# Encrypted Full Backup — закрытая от всех копия данных MuzaAi

**Eugene 2026-05-18:** «Особенно. Бoюсь за базы, я бы сделал копию закрытую от всех» + «Я бы все файлы так)».

Pipeline шифрует **data.db + authors/ + .env** (без BACKUP_PASSPHRASE) одним архивом AES256, отправляет в Telegram self-chat (если < 50MB), кладёт локально в `/var/backups/neurohub-encrypted/` (TTL 30 дней). Без passphrase — никто не вскроет, даже если получит .gpg файл.

## Файлы

- `deploy/backup-encrypted.sh` — создание encrypted backup
- `deploy/restore-encrypted-backup.sh` — восстановление

## Установка (one-time на prod VPS)

1. **Сгенерировать passphrase на VPS** (никогда не передавать через чат):

```bash
ssh root@31.130.148.107 'openssl rand -base64 48'
```

Скопировать вывод в Boss-only password manager. Это единственный способ потом расшифровать backup.

2. **Записать passphrase в .env** (только на prod VPS):

```bash
ssh root@31.130.148.107 'sed -i "/^BACKUP_PASSPHRASE=/d" /var/www/neurohub/.env && echo "BACKUP_PASSPHRASE=🔴ВПИШИ_СЮДА🔴" >> /var/www/neurohub/.env && chmod 600 /var/www/neurohub/.env'
```

(`backup-encrypted.sh` сам вырезает эту строку перед шифрованием — passphrase в backup'е никогда не окажется)

3. **Опционально: отдельный Telegram chat для бэкапов** (рекомендую):

Создать второй Telegram chat (или secret chat сам с собой), добавить бот, узнать chat_id, прописать:

```bash
ssh root@31.130.148.107 'echo "BACKUP_TELEGRAM_CHAT_ID=🔴BACKUP_CHAT_ID🔴" >> /var/www/neurohub/.env'
```

Если не указан — fallback на `ADMIN_TELEGRAM_ID` (тот же chat что и alerts).

4. **Установить скрипты**:

```bash
ssh root@31.130.148.107 'cp /opt/muziai-src/deploy/backup-encrypted.sh /usr/local/bin/backup-encrypted.sh && cp /opt/muziai-src/deploy/restore-encrypted-backup.sh /usr/local/bin/restore-encrypted-backup.sh && chmod 700 /usr/local/bin/backup-encrypted.sh /usr/local/bin/restore-encrypted-backup.sh'
```

5. **Cron еженедельно** (Sunday 04:00 MSK = 01:00 UTC, db-only):

```bash
ssh root@31.130.148.107 'cat > /etc/cron.d/neurohub-backup-encrypted <<EOF
0 1 * * 0 root /usr/local/bin/backup-encrypted.sh >/dev/null 2>&1
EOF'
```

6. **Cron ежемесячный full** (1-го числа 04:30 MSK = 01:30 UTC, включает authors/):

```bash
ssh root@31.130.148.107 'cat >> /etc/cron.d/neurohub-backup-encrypted <<EOF
30 1 1 * * root FULL_BACKUP=1 /usr/local/bin/backup-encrypted.sh >/dev/null 2>&1
EOF'
```

## Ручной запуск

**DB-only** (быстрый, ~10MB):

```bash
ssh root@31.130.148.107 '/usr/local/bin/backup-encrypted.sh'
```

**FULL** (включая authors/, может быть 5-20GB):

```bash
ssh root@31.130.148.107 'FULL_BACKUP=1 /usr/local/bin/backup-encrypted.sh'
```

Если `> 50MB` — Telegram upload пропустится, только локальная копия. Тогда вытянуть на свой Mac через rsync:

```bash
rsync -avz root@31.130.148.107:/var/backups/neurohub-encrypted/ ~/muzaai-backups/
```

## Восстановление

**Список доступных бэкапов**:

```bash
ssh root@31.130.148.107 'ls -lh /var/backups/neurohub-encrypted/'
```

**Восстановить latest**:

```bash
ssh root@31.130.148.107 'BACKUP_PASSPHRASE="🔴ВПИШИ_СЮДА🔴" /usr/local/bin/restore-encrypted-backup.sh latest'
```

**Восстановить конкретный** (timestamp в имени):

```bash
ssh root@31.130.148.107 'BACKUP_PASSPHRASE="🔴ВПИШИ_СЮДА🔴" /usr/local/bin/restore-encrypted-backup.sh /var/backups/neurohub-encrypted/backup-full-20260520-013000.tar.gz.gpg'
```

Скрипт автоматически:
1. Decrypt + verify sha256 manifest
2. Спрашивает подтверждение (если интерактивный TTY)
3. Делает pre-restore snapshot текущей БД (safety net)
4. pm2 stop neurohub
5. Заменяет data.db
6. PRAGMA integrity_check на новой БД (если FAIL — откат на pre-restore)
7. pm2 start neurohub

## Безопасность

- **AES256 symmetric** (GPG) — без раскрытия публичного ключа
- **Passphrase хранится ТОЛЬКО**:
  - На prod VPS в `/var/www/neurohub/.env` (chmod 600, root-only)
  - У Босса в password manager
- **В backup .gpg файле passphrase нет** — `BACKUP_PASSPHRASE=` строка вырезается перед tar
- **chmod 600** на encrypted файлы — даже root-доступ к VPS даёт только зашифрованный артефакт
- **Telegram bot chat** — encrypted at rest у Telegram + AES256 wrapper. Двойная защита.
- **TTL 30 дней** для local copies — старые автоматически удаляются

## Что НЕ в backup

- `node_modules/` — пересоздаётся через npm ci
- `dist/` — пересоздаётся через npm run build
- `tmp/`, `.pm2/`, логи — оперативные данные
- `BACKUP_PASSPHRASE` строка из .env — нужна отдельно для restore

## TTL и место

- 4 backup'а в месяц × ~10MB (db-only) = 40MB
- 1 full backup в месяц × ~5-20GB (с authors/) = храним 2-3 full локально (TTL 30 дней auto-cleanup)
- Telegram chat растёт постоянно — Босс может вручную чистить старые messages

## Pitfalls

- **Если потерять passphrase — backup необратимо потерян.** Хранить минимум в 2 местах (password manager + бумага в сейфе).
- **Если .env скомпрометирован — ротировать ALL остальные секреты** (passphrase, API keys, tokens). Скрипт ротации passphrase: сгенерировать новый, переписать .env, новые backup'ы с новым ключом. Старые backup'ы остаются с старым passphrase (документировать какой когда).
- **При больших authors/** (>50MB) — Telegram не упустит. Скрипт fallback на локальный only. Босс должен периодически вытягивать через rsync на Mac.
