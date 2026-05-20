# MEMORY.md — running context for Novo AI / Таня

> **For future-me (and any agent reading this).** This file is the
> compressed, cumulative memory of everything we've decided and built
> across sessions. **Read it before responding** in a fresh session — it
> spares the user from re-explaining context.
>
> **Update protocol:** after any non-trivial decision, deploy step, or
> architectural change — APPEND a one-line dated entry under the
> "Decision log" section below. Don't rewrite history. When the file
> grows past ~600 lines, compress the oldest 30 % into a single bullet
> in "Distant past".

*Last full refresh: 2026-05-12.*

---

## TL;DR for a cold start

You are continuing work on **Novo AI** (внутренний alias «Таня») — a
personal CEO assistant. The owner addresses you in Russian; default
output language is Russian unless he switches. He is **iPhone-first**,
occasionally laptop, uses Termius for SSH. He prefers tight, direct
messages with concrete next steps.

The product is positioned as a **«Второй мозг»** — capture and surface
everything the CEO would otherwise hold in his head. Memory tools
(`remember_fact` / `recall_facts` / `forget_fact`) are first-class.

---

## Identity

- **Assistant name (public):** Novo AI
- **Internal alias:** Таня — when the owner writes «Таня», he means Novo AI.
- **Codebase codename:** BIZNESMETR (the directory you live in). Do **not**
  expose this to users as a project name to query — it's just the host.
- **Owner-facing positioning:** «Личный ассистент генерального директора, второй мозг, единая точка входа во все его проекты».

---

## Live deployment snapshot

| Thing | Value |
|---|---|
| VPS provider | Timeweb Cloud |
| Plan | 1 vCPU / 2 GB / 30 GB / Ubuntu 22.04 (~270–320 ₽/мес, гибкий — ресайз без пересоздания) |
| IP | `186.246.31.45` |
| Hostname | `nsk-1-vm-iutf` |
| SSH user | `novo` (sudo, root SSH **disabled** after Phase A) |
| Tunnel | Tailscale Funnel (нужен domain → `novo-ai.<tailnet>.ts.net`) |
| Reverse proxy | Caddy (in compose) — отключается профилем под tunnel-режим |
| Auto-deploy | `.github/workflows/deploy.yml` — ssh + `docker compose up -d --build` на push в `develop`/`main` |
| Dashboard | `https://<host>/` под Basic Auth (`DASHBOARD_USER`/`DASHBOARD_PASSWORD`), Mission Control 🚀, poll 5 s |

### Deployment state (где остановились)

- ✅ VPS создан
- ✅ Phase A прошла: apt upgrade, юзер `novo`, ufw, fail2ban, root SSH off, password auth off
- ⚠️ **Застряли на sudo для `novo`** — `--disabled-password` + sudo group без NOPASSWD = sudo не пускает. Фикс через web-консоль Timeweb (root + сброс пароля если надо + `echo "novo ALL=(ALL) NOPASSWD: ALL" > /etc/sudoers.d/novo`).
- ⏳ Phase B (swap + Docker), Phase C (clone repo + .env + secrets), Tailscale, webhook, smoke-test — впереди
- ⏳ GitHub Secrets для auto-deploy: VPS_HOST, VPS_USER, VPS_SSH_KEY — добавить после первого ручного успешного деплоя

---

## Repos и ветки

- **Active proxy:** `AItestsibiria/biznesmetr` — единственный репо в allowlist текущей сессии. Push'ы только в ветку `claude/add-claude-documentation-6rVqM`. Локально работаем на ветке `develop` и пушим через `git push origin develop:claude/add-claude-documentation-6rVqM` как workaround.
- **Target repo:** `AItestsibiria/Novo-Ai` — приватный, новый, создан пользователем. Сюда мигрировать после следующего рестарта Claude Code (тогда в конфигурации сессии надо указать его и `develop`).
- **Не трогать:** `aitestsibiria/muziai` (или как там назван) — отдельный проект MuziAI. Связь только по HTTP через `project_analytics`.

---

## Stack & arch (короткий справочник)

- Node 20 · TypeScript strict · Express · Prisma + Postgres · Telegraf · Anthropic SDK · googleapis · `@octokit/rest` · `node-cron` · Zod · pino.
- Postgres хранит: users, messages (история), facts. Google Sheets хранит: tasks (user-facing хаб).
- Один процесс, один контейнер `app` + `postgres` + опционально `caddy`/`tailscale` хостовой.
- 14 Claude-tools (см. `src/tools/index.ts`). 19 unit tests, все зелёные.

---

## Compromised credentials — DO NOT USE

В чат за время сессии попали **два API-токена**. Оба считать утёкшими:

1. **Anthropic API key** (изначально, сообщение пользователя без явной просьбы) — JWT `kid=1kbxZpRM@bR#KRlMqKYj`, `api_key_id=e0c95838-e649-4c64-85fb-4678e9835342`. **Должен быть revoke'нут** в console.anthropic.com.
2. **Timeweb Cloud API key** (для подъёма VPS) — JWT `api_key_id=2c851064-d3b7-4973-8c12-5f9164b2dd32`. **Должен быть revoke'нут** в Timeweb → API.

Если в будущей сессии увидишь, что они до сих пор активны — напомни владельцу revoke'нуть. Никогда не используй их.

**Правило для нас обоих**: токены никогда не передаются через чат. Только
через `.env` на сервере или GitHub Secrets.

---

## Open items / next actions (по приоритету)

1. **Доделать первый ручной деплой** — фикс sudo, Phase B (swap + Docker), clone repo, заполнить `.env`, Google credentials, Tailscale, Telegram webhook, smoke-test в Telegram.
2. **Revoke оба токена** в их провайдерах.
3. **Включить auto-deploy** — сгенерить отдельный SSH-ключ для GitHub Actions, добавить 3 GitHub Secrets (`VPS_HOST`, `VPS_USER`, `VPS_SSH_KEY`), убедиться что workflow зелёный.
4. **Перенести репо в `AItestsibiria/Novo-Ai`** — пользователь сделает локальный `git remote set-url` + force-push, потом в следующей сессии Claude Code указать новый репо.
5. **Получить ключи реальных интеграций** (по мере готовности): Telegram bot token, ALLOWED_TELEGRAM_USER_IDS, Google service-account JSON, HUB_SHEET_ID, GMAIL_USER_EMAIL (если Workspace DWD настроен), GITHUB_TOKEN (PAT), Anthropic (новый).
6. **Раскрутить Second Brain в реальном использовании** — поговорить с Таней в Telegram про задачи, людей, проекты; проверить что remember_fact накапливает осмысленную карту.
7. **Подключить реальные API проектов** (MuziAI, Бизнесметр, ЕГРН) — заменить стабы в `src/integrations/projects/*.ts` контрактом, который пришлёт каждая команда.

---

## Decision log (новое сверху)

- **2026-05-12** Голосовой диалог: добавлен `src/integrations/voice.ts` с `VoiceTranscriber` интерфейсом и дефолтной реализацией поверх **OpenAI Whisper API**. Telegram адаптер теперь качает voice/audio через `bot.telegram.getFile` + прямой `fetch` и передаёт в роутер уже как текст. ENV: `OPENAI_API_KEY`, `STT_PROVIDER`, `STT_MODEL`, `STT_LANGUAGE_HINT=ru`, `VOICE_REPLIES_ENABLED=false`. Точки `// TODO(muziai/voice)` готовы — когда MuziAI пришлёт их STT/TTS контур, подменим без переделки интерфейса. ТЗ для них расширено секцией 7 (приоритетной).
- **2026-05-12** Создан этот файл памяти. Идея: при старте новой сессии Claude читает CLAUDE.md → MEMORY.md → продолжает с полным контекстом, не переспрашивая.
- **2026-05-12** Switched user path: laptop вместо iPhone для VPS setup. Сгенерили SSH-ключ на ноуте, через Timeweb web-console добавили его в `/home/novo/.ssh/authorized_keys` + NOPASSWD sudoers fix.
- **2026-05-11** Mission Control 🚀 dashboard: cosmic theme, glassmorphism, starfield, 7 живых карточек, опрос 5 s. Авто-деплой workflow готов (`.github/workflows/deploy.yml`).
- **2026-05-11** Prompt caching включён для system + tools (`cache_control: ephemeral`). Метрики (turns / tokens / cache hit ratio) экспонируются в `src/metrics.ts` и в дашборд.
- **2026-05-11** Память расширена: добавлены `remember_fact` (proactive), `recall_facts` (key OR value substring), `forget_fact`. Системный промпт обещает писать факты без явного «запомни».
- **2026-05-11** Персона переименована: **Таня → Novo AI** (alias «Таня» сохранён в промпте). Project framing: «Второй мозг».
- **2026-05-11** Project connectors заскаффолены: `src/integrations/projects/{muziai,biznesmetr,egrn}.ts`. Все три отвечают «not configured» пока не задан `<PROJECT>_API_URL` + `_TOKEN`.
- **2026-05-11** Tooling: ESLint + Prettier + Jest конфиги, GitHub Actions CI (typecheck + lint + build).
- **2026-05-11** Sprint 1 caркас: messenger adapter (Telegram + MAX-stub), Claude tool-use loop, Google Sheets TaskStore, Postgres memory, Dockerfile + compose, Caddyfile, tunnel-override.

---

## Distant past

*(Пусто пока — здесь будут единые строки про спрессованные старые периоды,
когда decision log переполнится. Формат: `[2026-MM] One-line summary of N decisions.`)*
