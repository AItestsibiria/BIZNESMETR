# PREFLIGHT — что нужно сделать до старта Sprint 1

## 🚨 Топология: три инстанса на одном VPS

**IP `72.56.1.149`** хостит **три** приложения:

| Домен | Роль | Можно трогать? |
|---|---|---|
| `podaripesnu.ru` | prod #1 — продаёт | ❌ только READ-ONLY |
| `muziai.ru` | prod #2 — продаёт | ❌ только READ-ONLY |
| `clone.muziai.ru` | staging — копия данных prod | ✅ рабочая зона v304 |

Они физически делят CPU, RAM, диск, nginx, pm2-демон. Любая операция, не ограниченная путём clone-инстанса, может задеть один из prod. Поэтому **все pre-sprint задачи касаются только clone**.

**Поток выкатки v304:** clone → smoke + integration → согласие Евгения → `podaripesnu.ru` → `muziai.ru`. Каждый prod-катап = отдельное пятиуровневое предупреждение + ручной snapshot + протестированный rollback.

**SSH:** `ssh root@72.56.1.149`. Перед каждой командой — пятиуровневое предупреждение и явное подтверждение Евгения.

---

## Pre-Sprint 1 (3 блокера)

### 1. ✅ CLAUDE.md — стек поправлен (закрыто)

`SQLite + Drizzle + Vitest` уже зафиксированы в `CLAUDE.md`. Источник: `docs/strategy/ANSWERS.md` §16.

---

### 2. SSH-проверка VPS1

Чтобы понять, на чём стоит сейчас сервер, и нужен ли апгрейд Node до 20 LTS.

```bash
ssh root@72.56.1.149 '
  echo "=== System ===";       uname -a;
  echo "=== Node ===";         node -v;
  echo "=== npm ===";          npm -v;
  echo "=== pm2 ===";          pm2 -v && pm2 status;
  echo "=== sqlite3 ===";      sqlite3 --version;
  echo "=== git ===";          git --version;
  echo "=== nginx ===";        nginx -v 2>&1;
  echo "=== Disk ===";         df -h /var;
  echo "=== Memory ===";       free -h;
  echo "=== /var/www/muziai ==="; ls -la /var/www/muziai 2>/dev/null | head -20;
  echo "=== current pm2 process ===";
  pm2 jlist | python3 -c "import sys, json; data=json.load(sys.stdin); print(\"\\n\".join(f\"{p[\\"name\\"]} → {p[\\"pm2_env\\"][\\"version\\"]} (pid {p[\\"pid\\"]})\" for p in data))" 2>/dev/null || true;
'
```

**Действия по результату:**

| Если | Делаем |
|---|---|
| Node `< 20` | Обновляем: `nvm install 20 --lts && nvm use 20 && pm2 update` |
| `pm2` не установлен | `npm i -g pm2` |
| `sqlite3` не установлен | `apt-get install -y sqlite3` |
| Памяти `< 2G` | Включаем swap (`fallocate -l 2G /swapfile && mkswap /swapfile && swapon /swapfile`) |
| `/var/www/muziai` пуст | Готовимся к `git clone` через `v304.sh install` |

**Записываем результат в:** `docs/strategy/PREFLIGHT-RESULT.md` (создать после проверки).

---

### 3. Бэкапы `data.db` на Google Drive (rclone)

> ⚠️ Бэкапим **только clone-инстанс**. Путь к нему уточним по результату §2 SSH-аудита (Perplexity вернёт реальный путь). В шагах ниже псевдо-путь `/var/www/muziai-clone/` — заменить на фактический.

#### 3.1 Установка rclone на VPS1

```bash
# с пятиуровневым подтверждением!
curl https://rclone.org/install.sh | sudo bash
rclone version
```

#### 3.2 Авторизация через service-account (рекомендуется)

Service-account JSON получается в Google Cloud Console:
1. Создать новый проект `muziai-backups` в Google Cloud.
2. Включить Drive API.
3. Создать service-account → Keys → JSON.
4. Расшарить целевую папку Drive (`muziai-backups/`) на email service-account-а.

```bash
# скопировать JSON на VPS1
scp ./gcp-sa.json root@72.56.1.149:/etc/rclone/gcp-sa.json
chmod 600 /etc/rclone/gcp-sa.json

# настроить remote
rclone config create gdrive drive \
  service_account_file /etc/rclone/gcp-sa.json \
  scope drive \
  team_drive ""

# проверить
rclone lsd gdrive:
```

> Альтернатива (быстрее, но на личный аккаунт): `rclone config` интерактивно → выбрать Google Drive → авторизация в браузере (one-time). Подходит на старте; для prod-надёжности лучше service-account.

#### 3.3 Cron-задания для бэкапов

```bash
mkdir -p /var/backups/muziai-clone

cat > /usr/local/bin/muziai-backup.sh <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
TS=$(date +%Y%m%d-%H%M%S)
# ⚠️ ПУТЬ К clone-инстансу — уточнить по результату §2 SSH-аудита.
# Это путь к data.db именно clone.muziai.ru, НЕ prod.
DB=/var/www/muziai-clone/data.db
DST=/var/backups/muziai-clone/data-$TS.db

[[ -f "$DB" ]] || { echo "DB not found"; exit 1; }
sqlite3 "$DB" ".backup $DST"
gzip "$DST"

# на Drive: hourly за сутки + daily за 30 дней
HOUR=$(date +%H)
rclone copy "$DST.gz" "gdrive:muziai-backups/hourly/" --quiet
if [[ "$HOUR" == "03" ]]; then
  rclone copy "$DST.gz" "gdrive:muziai-backups/daily/" --quiet
fi

# локальная ретенция: 24 hourly + 30 daily
find /var/backups/muziai-clone -name 'data-*.db.gz' -mtime +2 -delete

# Drive ретенция
rclone delete --min-age 25h gdrive:muziai-backups/hourly/ --quiet || true
rclone delete --min-age 30d gdrive:muziai-backups/daily/ --quiet || true
EOF

chmod +x /usr/local/bin/muziai-backup.sh

# каждый час в :05
( crontab -l 2>/dev/null; echo "5 * * * * /usr/local/bin/muziai-backup.sh >> /var/log/muziai-backup.log 2>&1" ) | crontab -
```

#### 3.4 Smoke-тест

```bash
/usr/local/bin/muziai-backup.sh
ls -la /var/backups/muziai-clone/
rclone ls gdrive:muziai-backups/hourly/ | tail -3
```

#### 3.5 Ручной snapshot перед миграцией v304 (на clone)

Перед каждым `v304.sh install` на clone:

```bash
sqlite3 /var/www/muziai-clone/data.db ".backup /tmp/pre-v304-clone.db"
rclone copy /tmp/pre-v304-clone.db gdrive:muziai-backups/manual/ --quiet
```

#### 3.6 Cutover на prod (после зелёного теста на clone)

Порядок: сначала `podaripesnu.ru`, затем `muziai.ru` (или наоборот, по решению Евгения). **Между катапами — окно наблюдения 24 часа.**

Перед каждым `v304.sh install` на prod:

```bash
# для podaripesnu.ru
sqlite3 /var/www/podaripesnu/data.db ".backup /tmp/pre-v304-podaripesnu.db"
rclone copy /tmp/pre-v304-podaripesnu.db gdrive:muziai-backups/manual/ --quiet

# для muziai.ru
sqlite3 /var/www/muziai/data.db ".backup /tmp/pre-v304-muziai.db"
rclone copy /tmp/pre-v304-muziai.db gdrive:muziai-backups/manual/ --quiet
```

> Точные пути уточним по §2 SSH-аудита.

⚠️ Каждый prod-катап:
- пятиуровневое предупреждение и явное «да» Евгения;
- окно минимальной нагрузки (например, 03:00–06:00 МСК);
- протестированный заранее `v304.sh rollback`;
- мониторинг 30 минут после: `pm2 status`, `/api/health`, error logs.

---

## Pre-Sprint 6 (email, бот, B2B)

### 4. Email-инфраструктура (с нуля)

1. В **Timeweb** (DNS управляется там, регистратор Nic.ru):
   - MX → почтовый провайдер (Yandex360 / Mail.ru для бизнеса)
   - SPF: `v=spf1 include:_spf.yandex.net ~all`
   - DKIM: ключ сгенерирует провайдер
   - DMARC: `v=DMARC1; p=quarantine; rua=mailto:postmaster@podaripesnu.ru`
2. Завести ящики `noreply@podaripesnu.ru`, `support@podaripesnu.ru`.
3. Сохранить SMTP/IMAP-креды в `.env` на VPS1 (НЕ в репо).

### 5. Telegram-токен

Существующий бот → передать токен через `.env` на VPS1 (`TELEGRAM_BOT_TOKEN`). НЕ через чат.

### 6. VK community + token

Совместная сессия с Евгением:
- Создать Standalone-app в VK для community-token.
- Включить Callback API → URL `https://podaripesnu.ru/api/vk/webhook`.
- Сохранить в `.env`: `VK_GROUP_ID`, `VK_ACCESS_TOKEN`, `VK_CONFIRMATION_CODE`, `VK_SECRET`.

### 7. Юр-документы

- Политика конфиденциальности — обновить под cookies / pixels / GPTunnel-Suno / реферал / chatbot-логи.
- Оферта — переписать под 4 SKU + B2B банковский перевод.

---

## Pre-Sprint 7 (реклама)

### 8. VK Ads кабинет

Создать под ИП. Верификация ИП-документами. Привязать карту/счёт. Получить `vk_ads_account_id` и токен Conversions API.

### 9. Yandex Direct кабинет

Создать под ИП. Привязать `YM_COUNTER_ID` (Метрика) для импорта целей.

---

## Правила обращения с секретами

| Где | Что |
|---|---|
| ✅ `.env` на VPS1 | Все секреты — только здесь |
| ✅ Локальный `.env` разработчика | Тестовые/dev-ключи |
| ✅ Защищённый password-manager (1Password, Bitwarden) | Долговременное хранение |
| ❌ Чат с AI | **Никогда** — даже зашифрованные блобы. Контекст AI сохраняется и может быть проиндексирован |
| ❌ Git (commit/PR) | Никогда |
| ❌ Slack/Telegram сообщения | Никогда |

Если нужно передать секрет с одного хоста на другой — `scp` или `rclone copyto` напрямую, мимо AI-чатов.

---

*Last updated: 2026-05-06*
