# История проекта neurohub — отчёт #3

**Источник:** ответ Perplexity на prompt из `PERPLEXITY-PROMPT-3-PROJECT-HISTORY.md`
**Дата:** 2026-05-06

---

## Ключевые находки

### 1. Истинное имя проекта
- В `package.json` — `rest-express` (унаследовано от boilerplate).
- **Реальное имя проекта в работе — `gptunnel-saas`**.
- На сервере pm2-имя — `neurohub`. Один и тот же codebase, три разных имени.

### 2. Топология prod / staging — финальная картина

| Домен | VPS | IP | Роль |
|---|---|---|---|
| **muziai.ru** | VPS3 | **`31.130.148.107`** | production MuziAI |
| **clone.muziai.ru** | VPS1 | `72.56.1.149` | staging (где мы сейчас) |
| (старый) neurohub | VPS-old | `5.42.112.116` | остаточный, не используем |
| **podaripesnu.ru** | ? | **TBD от Евгения** | production |
| worldbeauty.su | VPS1 | `72.56.1.149` | сторонний проект, не наш |

> ⚠️ Это правка ранней моей модели — я писал, что podaripesnu.ru тоже на `72.56.1.149`. На самом деле prod-сервер MuziAI — `31.130.148.107`. IP podaripesnu.ru пока неизвестен.

### 3. Источник правды для кода

**Нет публичного git-репозитория.** Источники правды:

1. **Локальная рабочая папка `gptunnel-saas`** в Computer/workspace Perplexity.
2. **Снапшоты на Google Drive** в формате `MAI_code.<дата>_v<NN>_🚀.tar.gz`.
3. **Последняя зафиксированная версия:** `v51` от **2026-05-02** (`MAI_code.02.05.2026_04-45_v51...tar.gz`).

Деплой — `scp` архива + `tar xzf` + `pm2 restart`. Без CI/CD, без git push, без code review.

### 4. Стек подтверждён

```
Express + Vite + React + Tailwind + shadcn/ui + Drizzle + SQLite
TypeScript (через tsx), сборка через esbuild → dist/index.cjs
Структура: client/ + server/ + shared/ (на clone отсутствует — только dist/)
```

Это **fullstack monorepo**: backend (Express) + frontend (Vite/React) собираются в один `dist/index.cjs`.

### 5. Существующий функционал

- AI-генерация музыки через **Suno via GPTunnel**
- Генерация обложек и текстов
- Публичный плейлист (`/api/playlist`, `/share/:id`, `/play/:id`)
- Кабинет автора (история, баланс, скачивание, публикация)
- Админка: генерации, посетители, страны, города, статистика, ошибки
- Cron на проверку GPTunnel баланса + email-alert
- Файлы треков: `/var/www/neurohub/authors/{name}/gen_{id}.mp3|jpg`

### 6. БД-схема (актуальные таблицы на clone)

`users`, `generations`, `transactions`, `payments`, `sessions`, `visitors`, `gen_activity`

> Это будет **существующая часть схемы**, к которой v304 добавит ещё 20 таблиц (см. `original/07 §3`).

### 7. Хронология (короткая)

| Дата | Событие |
|---|---|
| 2026-04-03 | Правило: не удалять `data.db` без тройного предупреждения |
| ~2026-04-15 | Ранняя установка runtime neurohub на VPS1 |
| 2026-04-27..05-04 | clone.muziai.ru закреплён как staging |
| 2026-05-01 | Активные работы: SEO, Яндекс-верификация, плейлист, dashboard, country counter, iOS lockscreen |
| 2026-05-02 | Зафиксирован паспорт проекта; найден исходник v51 на Drive |
| 2026-05-05 | Clone синхронизирован как staging-копия |
| 2026-05-06 | SSH-аудит: bcryptjs missing, ffprobe missing, /api/.env подозрителен |

### 8. Известные проблемы (приоритеты)

| Приоритет | Проблема | Действие |
|---|---|---|
| 🔴 P0 | `/api/.env` отвечает 200 (реальная утечка vs SPA fallback) | `curl -i https://clone.muziai.ru/api/.env` → разобрать |
| 🟡 P1 | bcryptjs missing → 30 рестартов | `npm install bcryptjs && pm2 restart neurohub` |
| 🟡 P1 | ffprobe missing → fade-out и duration не работают | `apt install ffmpeg` |
| 🟢 P2 | Нет исходников на сервере | Восстановить из v51 в `aitestsibiria/biznesmetr` |
| 🟢 P2 | Нет git remote / CI | Поставить нормальный pipeline в Спринт 1 |

### 9. Список ключей `.env` (значений Perplexity не раскрыл — правильно)

```
GPTUNNEL_API_KEY
SMTP_HOST / SMTP_USER / SMTP_PASS
ADMIN_EMAIL
BALANCE_ALERT_EMAIL
BALANCE_CRON_SECRET
SESSION_SECRET
PORT
ROBOKASSA_* (возможно)
TELEGRAM_BOT_TOKEN (возможно, не подтверждено)
```

### 10. Что Perplexity рекомендует ротировать

GPTunnel API key, SMTP пароль, `SESSION_SECRET`, `BALANCE_CRON_SECRET`, SSH root-пароль (→ перейти на SSH keys), Robokassa, Telegram (если используется).

Сделаем после Спринта 1, когда плагины notifications/payments перенесём на feature-flag-управление.

---

## Открытые вопросы Perplexity к Евгению

| # | Вопрос | Что я предлагаю |
|---|---|---|
| 1 | Проверить `/api/.env` — утечка или fallback? | Сейчас сделать `curl -i` (это безопасно) |
| 2 | Можно ли ронять clone на 1-2 минуты? | Если staging для тестов — да, окно 5 минут |
| 3 | Где главный полный исходник: Drive v51 / local / Replit? | **v51 на Drive** — забираем оттуда как baseline |
| 4 | Восстановить на clone структуру `client/server/shared`? | Лучше — поднять git-репо в `aitestsibiria/biznesmetr`, на сервере оставить только билд |
| 5 | Robokassa/Telegram на clone — оставлять? | Оставляем, но в test-режиме |
| 6 | Делать backup перед фиксами? | Обязательно (sqlite3 .backup + копия `/authors`) |

---

## Следующие шаги (мой план)

1. **Найти и скачать v51-архив с Google Drive** в репо как baseline исходного кода (могу сделать сам через MCP).
2. **Импортировать структуру `client/server/shared`** в `apps/neurohub/` нашей ветки — это станет источником правды.
3. После этого — мини-фиксы (`bcryptjs`, `ffmpeg`, `/api/.env`) делаем как первые коммиты в нормальном git-flow.
4. Спринт 1 v304 (EventBus, ModuleRegistry, plugins_registry) пишем поверх этой основы.

---

*Last updated: 2026-05-06*
