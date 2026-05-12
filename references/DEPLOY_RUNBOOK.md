# Деплой Novo AI на Timeweb + Tailscale Funnel

Пошаговый runbook. Все команды копируются и выполняются на сервере, кроме шага «На локальной машине», который явно помечен. Ориентировочное время: **~45–60 минут** в первый раз.

> **Почему Tailscale Funnel, а не cloudflared:** Funnel даёт стабильный
> `https://<host>.<tailnet>.ts.net` URL, который не меняется при перезапусках.
> Это критично — Telegram webhook регистрируется один раз. Cloudflared в
> `--url` режиме даёт ephemeral URL, который пришлось бы перерегистрировать.

---

> Раньше ассистент назывался «Таня». Сейчас бренд переехал на **Novo AI**;
> в кодовой базе хост / директория / `ASSISTANT_NAME` обновлены, на функции
> и тулзы переименование не повлияло.

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

> **Timeweb Cloud — гибкий тариф.** CPU / RAM / диск можно двигать
> ползунками в панели в любой момент: ресайз CPU+RAM занимает ~1 минуту с
> кратковременным reboot'ом, диск увеличивается «на лету». Поэтому начинаем
> с минимального тарифа из таблицы — апгрейдиться будем по сигналам (см.
> раздел «Когда увеличить ресурсы» ниже).

---

## 2. Базовая настройка сервера

Дальше все команды — **на сервере** (после `ssh root@<IP>`).

```bash
# Обновить пакеты
apt update && apt upgrade -y

# Создать невырутового юзера
adduser --disabled-password --gecos "" novo
usermod -aG sudo novo
mkdir -p /home/novo/.ssh
cp ~/.ssh/authorized_keys /home/novo/.ssh/
chown -R novo:novo /home/novo/.ssh
chmod 700 /home/novo/.ssh
chmod 600 /home/novo/.ssh/authorized_keys

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
ssh novo@<TIMEWEB_IP>
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

Дальше все команды — от юзера `novo`. Когда нужен root — пиши `sudo`.

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

# Запустить и сделать так, чтобы novo мог без sudo
sudo systemctl enable --now docker
sudo usermod -aG docker novo
# ВЫЙТИ и зайти заново, чтобы группа docker применилась
exit
ssh novo@<TIMEWEB_IP>

# Проверка
docker run --rm hello-world
```

---

## 4. Клонировать репозиторий

```bash
sudo apt install -y git
cd ~
git clone https://github.com/AItestsibiria/BIZNESMETR.git novo-ai
cd novo-ai
# Активная ветка проекта — develop (main пока пустой)
git checkout develop
```

---

## 5. Положить Google service-account JSON

На **локальной машине** (где лежит ключ):
```bash
scp /path/to/google-credentials.json novo@<TIMEWEB_IP>:~/novo-ai/secrets/google-credentials.json
```
Если папки `secrets/` ещё нет — создай:
```bash
# на сервере
mkdir -p ~/novo-ai/secrets
chmod 700 ~/novo-ai/secrets
chmod 600 ~/novo-ai/secrets/google-credentials.json
```

---

## 6. Подготовить .env

```bash
cd ~/novo-ai
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

# Дашборд (Basic Auth — придумай логин/пароль; именно их браузер спросит при заходе на /).
DASHBOARD_USER=ceo
DASHBOARD_PASSWORD=<любой случайный, например: openssl rand -hex 16>
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
sudo tailscale up --hostname=novo-ai
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
- **Funnel access:** https://login.tailscale.com/admin/settings/funnel → включить для всех или конкретно для `novo-ai`

Подними Funnel на порту 3000:
```bash
sudo tailscale funnel --bg 3000
```

Выведет публичный URL вида:
```
https://novo-ai.<TAILNET>.ts.net/
```

**Этот URL стабилен** — не меняется при перезапусках сервера. Запиши его — будем юзать в шаге 9.

---

## 8. Запустить стек

```bash
cd ~/novo-ai
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
curl https://novo-ai.<TAILNET>.ts.net/health
# {"status":"ok","uptime":...}
```

---

## 9. Зарегистрировать Telegram webhook

```bash
TG_TOKEN=<TELEGRAM_BOT_TOKEN>
TG_SECRET=<TELEGRAM_WEBHOOK_SECRET из .env>
TG_URL=https://novo-ai.<TAILNET>.ts.net/webhooks/telegram

curl -X POST "https://api.telegram.org/bot${TG_TOKEN}/setWebhook" \
  -H "Content-Type: application/json" \
  -d "{\"url\":\"${TG_URL}\",\"secret_token\":\"${TG_SECRET}\",\"drop_pending_updates\":true}"
```

Должно вернуть `{"ok":true,"result":true,...}`.

### Бонус: открыть дашборд

В браузере открой:
```
https://novo-ai.<TAILNET>.ts.net/
```
Браузер спросит логин/пароль (`DASHBOARD_USER` / `DASHBOARD_PASSWORD` из `.env`).
Внутри — живая сводка: задачи, календарь, GitHub PR'ы, статусы коннекторов
(MuziAI / Бизнесметр / ЕГРН), память (Second Brain), статистика AI и
системные чеки. Опрос каждые 5 секунд.

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
cd ~/novo-ai
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

## Когда увеличить ресурсы (Timeweb resize)

Стартовая конфигурация 1 vCPU / 2 GB / 30 GB сделана **с запасом 600 MB
ОЗУ**. Этого хватает на текущий набор интеграций + Postgres + Docker.
Расти будем по сигналам, а не на всякий случай.

### Сигналы «пора апгрейдить RAM» (с 2 GB → 4 GB)

| Сигнал | Где смотреть | Что значит |
|---|---|---|
| OOM-kill в `dmesg` | `sudo dmesg --ctime \| grep -i 'killed process'` | Ядро убивает процесс — обычно Postgres или Node. **Немедленный апгрейд.** |
| Swap занят >50% постоянно | дашборд → System; `free -h` | Не критично, но тормозит ответы Тани. **Запланировать апгрейд.** |
| Latency дашборда / `/health` >1s | дашборд → AI usage; `curl -w '%{time_total}' /health` | Сервис давится. Сначала смотри логи, потом RAM. |
| `/ready` периодически 503 | `curl /ready` | Postgres или Sheets не отвечают вовремя — часто из-за RAM-давления. |

### Сигналы «пора апгрейдить CPU» (с 1 → 2 vCPU)

| Сигнал | Где смотреть | Что значит |
|---|---|---|
| `load average` >1.5 длительно | `uptime` | CPU перегружен. Не критично если RAM ОК, но ответы Тани медленнее. |
| Сборка докера долгая | `docker compose build` >5 мин | Тоже сигнал, что один vCPU — узкое горлышко. |
| Параллельные мессенджеры (Telegram + MAX) активно | дашборд → AI usage (turns/мин) | При >5 turn'ов в минуту одного ядра не хватает. |

### Сигналы «пора увеличить диск» (с 30 → 60 GB)

| Сигнал | Где смотреть | Что значит |
|---|---|---|
| `df -h /` показывает <20% свободного | `df -h` | Postgres + docker layers съели место. |
| Логи docker-compose >2 GB | `du -sh /var/lib/docker/containers/*` | Не апгрейд диска, а ротация логов. Настроить `daemon.json` с `max-size`. |

### Как сделать ресайз на Timeweb

1. https://timeweb.cloud → **Cloud Servers** → выбрать твой → **Изменить
   конфигурацию**.
2. Подвинь ползунок CPU / RAM / диск. **Диск только в плюс** — Timeweb
   не позволяет уменьшать, ext4 живёт онлайн.
3. Нажми «Применить». Сервер делает reboot (~30 сек), Docker
   автоматически поднимается (`restart: unless-stopped` в compose).
4. После ребута: `tailscale status` проверь, что Funnel вернулся (он
   автоматически восстанавливается, но не помешает убедиться).
5. Telegram webhook **не нужно** перерегистрировать — URL не меняется.

### Если апгрейднул RAM — донастрой Postgres

В `docker-compose.yml` лимиты подкручены под 2 GB. На 4 GB можно дать
Postgres'у больше:

```yaml
postgres:
  command:
    - postgres
    - -c
    - shared_buffers=512MB      # было 128MB
    - -c
    - effective_cache_size=1500MB  # было 384MB
    - -c
    - work_mem=8MB              # было 4MB
    - -c
    - maintenance_work_mem=64MB # было 32MB
  deploy:
    resources:
      limits:
        memory: 1500M           # было 512M

app:
  environment:
    NODE_OPTIONS: --max-old-space-size=1024  # было 640
  deploy:
    resources:
      limits:
        memory: 1500M           # было 768M
```

Закоммитил, запушил → авто-деплой подхватит. Скажи мне, когда апгрейднешь
— я подготовлю PR с этими цифрами под твой новый тариф.

---

## Авто-деплой из GitHub (после первого ручного запуска)

После того как ты один раз вручную поднял Novo AI по шагам 1–10, можно
включить автоматический деплой: каждый push в ветку `develop` / `main`
будет за ~30 секунд прилетать на сервер.

### 1. Сгенерить SSH-ключ для GitHub Actions (на сервере)

```bash
ssh novo@<TIMEWEB_IP>
ssh-keygen -t ed25519 -N "" -C "github-actions-novo-ai" -f ~/.ssh/github_actions
cat ~/.ssh/github_actions.pub >> ~/.ssh/authorized_keys
chmod 600 ~/.ssh/authorized_keys

# Скопируй ПРИВАТНЫЙ ключ — он нужен будет в GitHub Secret:
cat ~/.ssh/github_actions
```

Из соображений гигиены этот ключ должен быть **отдельный**, не тот, которым
ты сам ходишь по SSH. Если что — удаляешь именно его строку из
`authorized_keys`, не теряя свой собственный доступ.

### 2. Добавить секреты в GitHub

В репозитории `AItestsibiria/biznesmetr` (или Novo-Ai после переноса):
**Settings → Secrets and variables → Actions → New repository secret**.

| Name | Value |
|---|---|
| `VPS_HOST` | IP сервера Timeweb |
| `VPS_USER` | `novo` |
| `VPS_SSH_KEY` | весь приватный ключ из `~/.ssh/github_actions` целиком (включая `-----BEGIN OPENSSH PRIVATE KEY-----` и `-----END…-----`) |
| `VPS_PORT` | (опционально) `22` |
| `DEPLOY_COMPOSE_FILES` | (опционально) `-f docker-compose.yml -f docker-compose.tunnel.yml` — по умолчанию уже это |

### 3. Проверка

После добавления секретов сделай любой коммит в `develop` (например, мелкая
правка README) и запушь. Зайди в **Actions → Deploy to VPS** — увидишь job
с шагами:
- `git fetch / checkout / reset --hard`
- `docker compose up -d --build`
- `curl /health` с ретраями
- последние 20 строк лога приложения

Зелёная галка → деплой автоматический. С этого момента ты больше **не
заходишь на сервер вручную**, кроме случаев правки `.env` или диагностики.

### 4. Откат

Если новый коммит сломал прод — `git revert <sha> && git push`, Actions
выкатит откатанную версию через 30 секунд. Или вручную:
```bash
ssh novo@<TIMEWEB_IP>
cd ~/novo-ai
git checkout <предыдущий-good-sha>
docker compose -f docker-compose.yml -f docker-compose.tunnel.yml up -d --build
```

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
