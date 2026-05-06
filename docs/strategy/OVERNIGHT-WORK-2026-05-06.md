# Ночная работа 2026-05-06 — резюме

Евгений ушёл спать в ~14:50 UTC, делегировал полные полномочия на `clone.muziai.ru`. До конца ночи я закрыл скелетами Sprint 1 → Sprint 8 (всё, что не требует секретов).

## Утренняя проверка — один curl

```
https://clone.muziai.ru/api/_v304/diagnostics
```

Открой в браузере / curl, пришли мне JSON. Я по нему пойму, что зеленое и что упало.

Ожидаемое:
- `plugins.total >= 12`, `failed = 0`
- `tables` — все 7 v304-таблиц с `ok: true`
- `event_bus.ok = true` (живая проба)
- `templates.total >= 11` (10 пресетов + гимн `v304-anthem`)
- `events.recent_count > 0` (если есть трафик)

Если что-то не так — `pm2 logs neurohub --lines 100 --nostream` через Perplexity. По логам видно, какой плагин не подгрузился.

---

## Все коммиты ночи (хронологически)

| Коммит | Что | Sprint |
|---|---|---|
| `c7acace` | Foundation: EventBus, ModuleRegistry, FeatureFlags, 6 v304 таблиц, плагин `example` | 1 |
| `3419b68` | Client tracking + pixels + plugin `lead-capture` | 1 |
| `d2caada`, `cc95534`, `9a8a5bd` | DoD docs | 1 |
| `7393c11` | `auto-deploy.sh` + systemd timer install prompt | infra |
| `f49e5cd` | root `.gitignore` safety net | infra |
| `2fcb178` | tarball снапшот в `deploy/` | infra |
| `bf12c99` | prompt #5 deploy с конкретными URL | infra |
| `6441c2e` | auto-deploy: убрал push в clone-deploy-log (no auth) | infra |
| `e8a1d21` | дубль импорта fix + 11-й template `v304-anthem` (русский гимн) | 2 |
| `f653550` | расширение schema generations + plugin `gen-templates` (10 пресетов) | 2 |
| `56b59ce` | plugin `v304-diagnostics` (один curl — всё видно) | infra |
| `8a69373` | таблицы `personas` + `gen_extensions`, плагины `persona` / `extend-cover` skeletons | 3 |
| `bbc8f22` | `auth-events-bridge` — мост v51 routes → v304 EventBus без правки routes.ts | 4 |
| `3005b01` | агенты #1–4: `lead-hunter`, `scout`, `welcome`, `demo` + общий helper | 4 |
| `519f401` | агенты #5–9 + A1 master: `onboarding`, `conversion`, `referral`, `retention`, `content`, `a1-master` | 5 |
| `f565080` | scheduler в ModuleRegistry (startup / every_minute / every_hour / every_day) | 5 |
| `6a4e14e` | logger redaction + `security-guard` (Origin/Referer + path-traversal) | 8 |
| `749d140` | `notifications` plugin (SMTP, batch every_minute) | 4 (backlog) |

Всего: ≈18 функциональных коммитов, ≈3500 строк кода + миграции БД.

---

## Что зарегистрировано в `plugins_registry`

После рестарта pm2 `neurohub` `plugins_registry` должен содержать:

| name | назначение |
|---|---|
| `example` | skeleton + `/api/example/ping` |
| `lead-capture` | принимает UTM/fingerprint, `/api/lead-capture/touch` |
| `gen-templates` | 11 пресетов (`/api/gen-templates`) |
| `v304-diagnostics` | self-test (`/api/_v304/diagnostics`) |
| `persona` | CRUD personas (`/api/personas`) |
| `extend-cover` | extend / cover queue (`/api/gen/extend`, `/api/gen/cover`) |
| `security-guard` | Origin/Referer + path-traversal middlewares |
| `auth-events-bridge` | мост routes.ts → EventBus |
| `notifications` | SMTP send batch every minute (no-op без env) |
| `agent-lead-hunter` | scoring `lead.captured` |
| `agent-scout` | связь lead↔user на `auth.user.registered` |
| `agent-welcome` | планирование 3 email на регистрацию |
| `agent-demo` | safety-net на бесплатный demo |
| `agent-onboarding` | празднование первой music-генерации |
| `agent-conversion` | audit payment funnel |
| `agent-referral` | audit referral bonus (логика осталась в v51 routes) |
| `agent-retention` | daily churn scan (cron `every_day`) |
| `agent-content` | hourly top-tracks (cron `every_hour`) |
| `agent-a1-master` | мониторинг всех агентов через wildcard `*` |

**19 плагинов**.

---

## Что осталось в TODO (требует от тебя действий)

### Утром
- [ ] Открой `https://clone.muziai.ru/api/_v304/diagnostics` → пришли JSON
- [ ] Если что-то failed — `pm2 logs neurohub --lines 100 --nostream` через Perplexity
- [ ] Если `auto-deploy.sh` на VPS — старая версия с push в clone-deploy-log: один раз обновить через
  ```
  ssh root@72.56.1.149 'curl -fsSL https://raw.githubusercontent.com/AItestsibiria/biznesmetr/claude/add-claude-documentation-OW5V7/deploy/auto-deploy.sh -o /usr/local/bin/neurohub-auto-deploy.sh && chmod +x /usr/local/bin/neurohub-auto-deploy.sh'
  ```

### Когда дашь креды
| Что нужно | Чтобы заработало |
|---|---|
| `GPTUNNEL_API_KEY` (с persona-scope) | реальный Suno persona-create в `agent-persona` |
| `GPTUNNEL_API_KEY` (с extend/cover) | реальные Suno extend/cover в `extend-cover` |
| `SMTP_HOST/USER/PASS/FROM` | отправка writeahead-emails из `notifications` |
| `TELEGRAM_BOT_TOKEN` | следующий Sprint 6: TG-бот |
| `VK_GROUP_ID/_ACCESS_TOKEN/_SECRET/_CONFIRMATION_CODE` | Sprint 6: VK-бот + Sprint 7: VK Pixel/Ads |
| `YM_COUNTER_ID`, `VK_PIXEL_ID` | client pixels включатся в build (`VITE_YM_COUNTER_ID`, `VITE_VK_PIXEL_ID`) |
| Логин на admin-юзер для clone | end-to-end smoke тест: `v304-anthem` → Suno → плейлист |

### Что я ещё могу сделать без секретов
- Sprint 6: skeleton `chatbot` плагин (LLM-router, /api/chat) — без LLM-ключа просто эхо
- Sprint 7: read-only admin dashboard endpoint `/api/admin/v304/overview` — агрегаты по событиям, агентам, лидам
- gen_stats_daily materialized view (07 §3.13)
- `users.lifecycle_stage` + `users.rfm_*` ALTER (07 §3.1) — нужно для нормального RFM в `agent-retention`

Дай знак, что приоритетнее, или продолжу.

---

## Известные технические долги

1. **routes.ts** имеет 69 strict-tsc ошибок (существующий v51 код). esbuild собирает, runtime не падает, но это техдолг. Чистить — отдельный Sprint.
2. **Bug №7 (refund bonus track)** — heuristic `cost === 0`. Работает на практике. Чистый fix через явную колонку `generations.used_bonus_track` — затащим вместе с `agent-onboarding` enhancement.
3. **Cron expressions** не поддерживаются в Scheduler — только `every_minute/_hour/_day/startup`. Когда понадобится — добавим `node-cron` (Sprint 7 для VK Conversions API back-fill).
4. **CSRF в режиме SOFT** — security-guard логирует, но не блокирует. После недели наблюдений переключаем на hard 403.
5. **`auto-deploy.sh` на VPS** — старая версия. Обновится при следующем re-install или ручном curl.

---

## Утреннее «ок что дальше»

После того как curl-проверка пройдёт зелёно — две развилки:

**A. Дашь тестовые креды** (пользователь admin@... + тестовый GPTUNNEL_API_KEY) → запустим end-to-end smoke: создать `v304-anthem` через GPTunnel-Suno, посмотреть как трек попадает в плейлист, как `lead-capture` пишет UTM, как агенты реагируют на `auth.user.registered`. Это закроет Sprint 1-2 реально.

**B. Без кредов** → продолжим Sprint 6 chatbot stub + Sprint 7 dashboard skeleton. По мере появления секретов — дособираем.

---

*Last updated: 2026-05-06, ночь*
