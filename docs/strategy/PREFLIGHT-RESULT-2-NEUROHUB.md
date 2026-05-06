# Аудит neurohub — отчёт #2

**Дата:** 2026-05-06 (Perplexity по prompt из `PERPLEXITY-PROMPT-2-NEUROHUB.md`)

---

## 1. Связка clone.muziai.ru → neurohub ✅ ПОДТВЕРЖДЕНА

```
clone.muziai.ru:443 (HTTPS via Certbot)
    ↓ nginx vhost "muziai-clone"
proxy_pass http://127.0.0.1:5000
    ↓
pm2 process "neurohub" (id 3)
    /var/www/neurohub/dist/index.cjs (Node v22.22.0, fork mode)
    listens on 0.0.0.0:5000
```

`curl http://127.0.0.1:5000/` → `HTTP 200` — приложение живо. nginx терминирует TLS, проксирует с upgrade-заголовками (значит, ws/sse работает).

---

## 2. Что такое `neurohub`

| Поле | Значение |
|---|---|
| package.json `name` | **`rest-express`** |
| version | 1.0.0 |
| description | (пусто) |
| `scripts.dev` | `NODE_ENV=development tsx server/index.ts` |
| `scripts.build` | `tsx script/build.ts` |
| `scripts.start` | `NODE_ENV=production node dist/index.cjs` |
| `scripts.check` | `tsc` |
| `scripts.db:push` | `drizzle-kit push` |
| git remote | **(пусто, репозиторий не подключён к remote)** |
| git log | пусто |

**Стек:** Express + TypeScript (через `tsx`) + **Drizzle ORM** + SQLite. **Совпадает со стеком v304** из CLAUDE.md.

⚠️ **Критично — что отсутствует на сервере:**
- Нет каталога `server/` (хотя `scripts.dev` ссылается на `server/index.ts`).
- Нет каталога `script/` (на который ссылается `scripts.build`).
- Нет `.git/` (или git remote пустой).
- На сервере **только скомпилированный билд** в `dist/index.cjs` + `node_modules/`. Это **deploy-only** инстанс.

**Вывод:** исходный код neurohub **где-то ещё** — у Евгения локально, в Replit / Github / другой машине. Сервер только держит билд. Для v304-кодинга нам нужен доступ к источнику.

---

## 3. Почему 30 рестартов за 17 ч

Из `pm2 logs neurohub --lines 200`:

### Bug №1 (рестарты): отсутствует модуль `bcryptjs`
```
Error: Cannot find module 'bcryptjs'
Require stack:
- /var/www/neurohub/dist/index.cjs
```
**Причина:** билдер esbuild не вшил bcryptjs в `dist/index.cjs` (вероятно `external: ['bcryptjs']`), а в `node_modules/` его нет (или сломан). **Кикает рестарт-цикл** при попытке использовать auth-роут.

**Фикс:**
```bash
cd /var/www/neurohub && npm install bcryptjs
pm2 restart neurohub
```

### Bug №2 (warning, не падает): отсутствует `ffprobe`
```
[FADE] Failed on .../gen_642.mp3: Command failed: ffprobe -v error -show_entries format=duration ...
```
**Причина:** в системе не установлен `ffmpeg` (он же даёт `ffprobe`). Длительности треков не определяются.

**Фикс:**
```bash
sudo apt-get update && sudo apt-get install -y ffmpeg
```

### 🚨 Подозрительная находка (не баг, а security): открытые `/api/.env` и `/api/test`
```
12:00:53 PM HEAD /api/.env  200 in 2ms
12:00:53 PM GET  /api/.env  200 in 1ms
12:01:02 PM HEAD /api/test  200 in 2ms
12:01:03 PM GET  /api/test  200 in 5ms
```
Ботнеты сканируют `/api/.env` — типичная попытка слить секреты. Endpoint отвечает `200`. Нужно проверить, что **отдаёт** этот endpoint — если содержимое `.env` в ответе, это критичная утечка. Подозреваю, что это catch-all роут или недоразумение в роутинге; в любом случае закрыть.

---

## 4. Структура `/var/www/neurohub/`

```
/var/www/neurohub/
├── .env                72 B (минимальный)
├── authors/            ← медиа треков (gen_*.mp3)
├── data.db             3.9 MB
├── data.db-shm         32 KB    ← SQLite WAL
├── data.db-wal         1.6 MB
├── deploy/             ← какие-то deploy-скрипты
├── dist/
│   └── index.cjs       ← единственный исходник на сервере (compiled)
├── node_modules/       299 каталогов
├── package-lock.json   266 KB
└── package.json        3.6 KB
```

---

## 5. Карта портов сервера

| Порт | Кто | Назначение |
|---|---|---|
| 22 | sshd | SSH |
| 80 | nginx | HTTP → 301 на 443 |
| 443 | nginx | HTTPS proxy (TLS via Certbot) |
| **5000** | **node neurohub** | бэкенд clone.muziai.ru (наш) |
| 5001 | gunicorn (3 воркера) | бэкенд worldbeauty.su (Flask) |
| 10050 | zabbix_agentd | мониторинг |

Никаких сюрпризов или подозрительных портов.

---

## 6. Решения по результату

### ✅ Готовы стартовать v304-кодинг
Стек подтверждён (Express + Drizzle + SQLite + TS) → `CLAUDE.md` стек-секция уже актуальна. Связка clone.muziai.ru → neurohub работает.

### ⚠️ Перед Sprint 1 надо закрыть
1. **Источник кода neurohub** — где он? Получить read/write доступ (см. вопрос ниже).
2. **bcryptjs** — npm install + restart pm2.
3. **ffmpeg** — apt install.
4. **`/api/.env`** — security-fix, проверить и закрыть.
5. **rclone + бэкапы** — §3 PREFLIGHT.md.
6. (Опц.) swap +2 GiB — память тонкая.

### ❓ Открытые вопросы к Евгению
- **Где исходники neurohub?** (Replit / Github / GitLab / локальная машина / другой VPS) — без них не получится развивать v304.
- **Кто сейчас деплоит neurohub на 72.56.1.149?** (rsync? scp dist/? CI/CD?)
- **Есть ли история коммитов где-то?** (даже без remote — `.git/` локальной разработки)

---

*Last updated: 2026-05-06*
