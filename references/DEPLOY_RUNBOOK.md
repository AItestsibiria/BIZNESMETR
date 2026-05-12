# Деплой Тани на Timeweb + Tailscale Funnel

Пошаговый runbook. Все команды копируются и выполняются на сервере, кроме шага «На локальной машине», который явно помечен. Ориентировочное время: **~45–60 минут** в первый раз.

> **Почему Tailscale Funnel, а не cloudflared:** Funnel даёт стабильный
> `https://<host>.<tailnet>.ts.net` URL, который не меняется при перезапусках.
> Это критично — Telegram webhook регистрируется один раз. Cloudflared в
> `--url` режиме даёт ephemeral URL, который пришлось бы перерегистрировать.

---

## 0. Что должно быть у тебя до старта

- [ ] Аккаунт **Timeweb** с балансом ≥ 600₽.
- [ ] **Anthropic API key** (после ротации, после инцидента).
- [ ] **Telegram бот** через @BotFather → токен + знаешь свой `chat_id` (узнать через @userinfobot).
- [ ] **Google Cloud service account** с JSON-ключом и доступом к нужным Sheets/Calendar.
- [ ] **GitHub аккаунт** для авторизации Tailscale (или Google/Microsoft — Tailscale пускает по любому из них; отдельной регистрации не надо).
- [ ] Локальный SSH-клиент (на macOS/Linux — встроенный; на Windows — PuTTY или OpenSSH).

---

## 1. Создать VPS на Timeweb

1. https://timeweb.cloud → «Cloud-серверы» → «Создать».
2. **Конфигурация (самая экономная рабочая):**
   - **Образ:** Ubuntu 22.04 LTS
   - **CPU/RAM/Диск:** **1 vCPU / 2 GB RAM / 30 GB SSD** (~270–320 ₽/мес).
     Это абсолютный минимум для Тани: Postgres + Node + Docker + Tailscale
     уместятся в ~1.4 GB, остаётся ~600 MB на пики. Тариф 1 GB ОЗУ нельзя
     — будет OOM-kill Postgres'а во время больших ответов Claude.
   - **Процессор:** AMD EPYC / Standard (любой — нагрузка I/O-bound).
   - **Локация:** Москва (или ближайшая к тебе).
   - **Резервное копирование:** опционально (~50 ₽/мес), можно отказаться.
   - **Сетевая защита:** не нужна (Tailscale пробивает наружу сам).
3. **SSH-ключи:** выбери «Загрузить новый», вставь содержимое `~/.ssh/id_ed25519.pub` со своей машины. Если ключа нет — на локальной машине:
   ```bash
   ssh-keygen -t ed25519 -C "your@email"
   cat ~/.ssh/id_ed25519.pub
   ```
4. Создай сервер, дождись «активен», запиши IP.
5. На локальной машине проверь доступ:
   ```bash
   ssh root@<TIMEWEB_IP>
   ```
   Если входит без пароля — отлично.

> **Когда стоит брать дороже:** если будешь подключать несколько мессенджеров
> одновременно (Telegram + MAX), вешать тяжёлые интеграции (ЕГРН с обработкой
> PDF, генерацию изображений) или хочешь запас на 12+ месяцев без апгрейда —
> бери 2 vCPU / 4 GB (~600 ₽/мес). Менять тариф у Timeweb потом тоже можно,
> но с downtime.

---

## 2. Базовая настройка сервера

Дальше все команды — **на сервере** (после `ssh root@<IP>`).

```bash
# Обновить пакеты
apt update && apt upgrade -y

# Создать невырутового юзера
adduser --disabled-password --gecos "" tanya
usermod -aG sudo tanya
mkdir -p /home/tanya/.ssh
cp ~/.ssh/authorized_keys /home/tanya/.ssh/
chown -R tanya:tanya /home/tanya/.ssh
chmod 700 /home/tanya/.ssh
chmod 600 /home/tanya/.ssh/authorized_keys

# Базовый firewall: пускаем только SSH (Tailscale сам пробивает наружу)
apt install -y ufw fail2ban
ufw allow OpenSSH
ufw --force enable

# Запретить вход root по SSH и парольный вход
sed -i 's/^#*PermitRootLogin.*/PermitRootLogin no/' /etc/ssh/sshd_config
sed -i 's/^#*PasswordAuthentication.*/PasswordAuthentication no/' /etc/ssh/sshd_config
systemctl restart sshd
```

**Не закрывай старую SSH-сессию.** Открой новую вкладку и проверь:
```bash
ssh tanya@<TIMEWEB_IP>
```
Если входит — старую `root@` сессию можно закрыть.

---

## 2a. Swap-файл (обязательно для 2 GB RAM)

Без swap'а на 2 GB любой пик памяти (большой ответ Claude, миграция Prisma)
кончается OOM-killer'ом Postgres'а. 2 GB swap — бесплатная страховка,
которая в норме почти не используется.

```bash
sudo fallocate -l 2G /swapfile
sudo chmod 600 /swapfile
sudo mkswap /swapfile
sudo swapon /swapfile
echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab

# Подкрутить swappiness: не лезть в swap по мелочам
echo 'vm.swappiness=10' | sudo tee -a /etc/sysctl.conf
sudo sysctl -p

# Проверка
free -h
# Должен показать "Swap: 2.0Gi"
```

---

## 3. Установить Docker

Дальше все команды — от юзера `tanya`. Когда нужен root — пиши `sudo`.

```bash
# Docker по официальному гайду
sudo apt update
sudo apt install -y ca-certificates curl gnupg
sudo install -m 0755 -d /etc/apt/keyrings
curl -fsSL https://download.docker.com/linux/ubuntu/gpg | \
  sudo gpg --dearmor -o /etc/apt/keyrings/docker.gpg
sudo chmod a+r /etc/apt/keyrings/docker.gpg
echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] \
  https://download.docker.com/linux/ubuntu $(. /etc/os-release && echo $VERSION_CODENAME) stable" | \
  sudo tee /etc/apt/sources.list.d/docker.list
sudo apt update
sudo apt install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin

# Запустить и сделать так, чтобы tanya мог без sudo
sudo systemctl enable --now docker
sudo usermod -aG docker tanya
# ВЫЙТИ и зайти заново, чтобы группа docker применилась
exit
ssh tanya@<TIMEWEB_IP>

# Проверка
docker run --rm hello-world
```

---

## 4. Клонировать репозиторий

```bash
sudo apt install -y git
cd ~
git clone https://github.com/AItestsibiria/BIZNESMETR.git tanya
cd tanya
# Переключиться на рабочую ветку, пока main пуст
git checkout claude/add-claude-documentation-6rVqM
```

---

## 5. Положить Google service-account JSON

На **локальной машине** (где лежит ключ):
```bash
scp /path/to/google-credentials.json tanya@<TIMEWEB_IP>:~/tanya/secrets/google-credentials.json
```
Если папки `secrets/` ещё нет — создай:
```bash
# на сервере
mkdir -p ~/tanya/secrets
chmod 700 ~/tanya/secrets
chmod 600 ~/tanya/secrets/google-credentials.json
```

---

## 6. Подготовить .env

```bash
cd ~/tanya
cp .env.example .env
nano .env
```

Заполняй **только** то, что готово. Пустые переменные = соответствующая интеграция выключена (бот не упадёт). Минимум для первого запуска:

```dotenv
NODE_ENV=production
PORT=3000
ASSISTANT_NAME=Таня

DATABASE_URL=postgresql://biznesmetr:biznesmetr@postgres:5432/biznesmetr?schema=public

ANTHROPIC_API_KEY=<ротированный ключ — НЕ старый!>

TELEGRAM_BOT_TOKEN=<токен от BotFather>
TELEGRAM_WEBHOOK_SECRET=<любая случайная строка, например: openssl rand -hex 32>
ALLOWED_TELEGRAM_USER_IDS=<твой chat_id от @userinfobot>

GOOGLE_APPLICATION_CREDENTIALS=/run/secrets/google-credentials.json
HUB_SHEET_ID=<id таблицы из URL>
GOOGLE_CALENDAR_ID=primary

DEFAULT_TZ=Europe/Moscow
LOG_LEVEL=info
```

Сохрани (`Ctrl+O`, `Enter`, `Ctrl+X`) и закрой права:
```bash
chmod 600 .env
```

---

## 7. Установить Tailscale + поднять Funnel

```bash
curl -fsSL https://tailscale.com/install.sh | sh

# Подключить машину к твоему Tailnet (по GitHub/Google логину)
sudo tailscale up --hostname=tanya
# В выводе будет URL — открой его на локальной машине, авторизуйся.
```

После авторизации проверь, что машина в сети:
```bash
tailscale status
```

Включи MagicDNS и HTTPS-сертификаты (если ещё не включены):
- В web-интерфейсе https://login.tailscale.com/admin/dns
  - **MagicDNS:** включить
  - **HTTPS Certificates:** включить (Tailscale выпустит Let's Encrypt-серт на `<host>.<tailnet>.ts.net`)
- **Funnel access:** https://login.tailscale.com/admin/settings/funnel → включить для всех или конкретно для `tanya`

Подними Funnel на порту 3000:
```bash
sudo tailscale funnel --bg 3000
```

Выведет публичный URL вида:
```
https://tanya.<TAILNET>.ts.net/
```

**Этот URL стабилен** — не меняется при перезапусках сервера. Запиши его — будем юзать в шаге 9.

---

## 8. Запустить стек

```bash
cd ~/tanya
docker compose -f docker-compose.yml -f docker-compose.tunnel.yml up -d --build
```

Первая сборка займёт 3–5 минут. Дальше:

```bash
# Логи приложения
docker compose logs -f app
```

Должен увидеть строку вроде:
```
{"level":30,"msg":"BIZNESMETR is up","port":3000,"env":"production"}
```

Проверь, что Funnel пробивает до приложения:
```bash
curl https://tanya.<TAILNET>.ts.net/health
# {"status":"ok","uptime":...}
```

---

## 9. Зарегистрировать Telegram webhook

```bash
TG_TOKEN=<TELEGRAM_BOT_TOKEN>
TG_SECRET=<TELEGRAM_WEBHOOK_SECRET из .env>
TG_URL=https://tanya.<TAILNET>.ts.net/webhooks/telegram

curl -X POST "https://api.telegram.org/bot${TG_TOKEN}/setWebhook" \
  -H "Content-Type: application/json" \
  -d "{\"url\":\"${TG_URL}\",\"secret_token\":\"${TG_SECRET}\",\"drop_pending_updates\":true}"
```

Должно вернуть `{"ok":true,"result":true,...}`.

Проверь, что webhook прицепился:
```bash
curl "https://api.telegram.org/bot${TG_TOKEN}/getWebhookInfo"
```

---

## 10. Smoke-тест

В Telegram открой своего бота, напиши:
```
Привет, Таня
```

В логах сервера (`docker compose logs -f app`) должен увидеть:
- входящее сообщение,
- вызов Claude,
- (возможно) tool_use,
- исходящий ответ.

В чате — ответ от Тани.

Если ответ не пришёл — обычно одно из:
- `ALLOWED_TELEGRAM_USER_IDS` не содержит твой id → бот молча игнорирует;
- неправильный `TELEGRAM_WEBHOOK_SECRET` → Telegraf отвергает запрос (видно в логах);
- упал Claude API → ошибка про `ANTHROPIC_API_KEY` в логах.

---

## 11. Эксплуатация

```bash
# Логи всех сервисов
docker compose logs -f

# Перезапуск только приложения
docker compose restart app

# Обновить код (когда я выкачу новую версию)
cd ~/tanya
git pull
docker compose -f docker-compose.yml -f docker-compose.tunnel.yml up -d --build

# Остановить всё
docker compose down

# База на месте — пережёвет любое обновление кода
docker volume ls | grep pgdata
```

---

## 12. Финал: отозвать утёкший API key

Сразу после того, как убедишься, что новый ключ в `.env` работает:

1. Зайди в провайдера, где был выписан **тот** скомпрометированный токен (по `kid` в JWT — узнаешь у того, кто его выдавал; если это твой собственный сервис — найди в админке по `api_key_id`).
2. Нажми **Revoke / Delete**.
3. Подтверди, что новый (тот, что сейчас в `.env` Тани) — действующий и НЕ совпадает со старым.
4. Проверь логи / биллинг провайдера на предмет подозрительных вызовов между моментом утечки и моментом отзыва.

---

## Когда появится домен

1. Купи домен (.ru на reg.ru ~200₽/год, .com на namecheap ~$10/год).
2. Направь A-запись `tanya.example.com` на IP Timeweb-сервера.
3. Открой порты 80 и 443:
   ```bash
   sudo ufw allow 80
   sudo ufw allow 443
   ```
4. Подмени `bot.example.com` в `Caddyfile` на свой домен.
5. Поменяй запуск:
   ```bash
   # выключить tunnel-режим, включить caddy
   docker compose -f docker-compose.yml up -d --build
   ```
6. Перерегистрируй Telegram webhook на новый адрес (шаг 9, с другим URL).
7. Можно выключить Tailscale Funnel:
   ```bash
   sudo tailscale funnel reset
   ```
   (Tailscale остаётся для SSH-доступа, это удобно.)

---

*Готовил: 2026-05-11. Если что-то не работает — кидай вывод соответствующего шага в чат, разберу.*
