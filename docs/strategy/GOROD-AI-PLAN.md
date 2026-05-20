# 🏙 Город Ай — План разработки (планируется к запуску 2026-05-21)

> **Status:** Подготовлено 2026-05-20, запуск subagent через 24h
> **Источник ТЗ:** `docs/strategy/GOROD-AI-SPEC.md`
> **Срок:** 6-8 недель
> **Команда:** subagent (research + architecture phase), затем dev sprint

## Что делает subagent в фазе 1 (3-4 дня)

**Задача:** на основе ТЗ из `GOROD-AI-SPEC.md` подготовить **техническую архитектуру** виджета «Город Ай»:

1. **Сравнить 3 варианта формата** (Web Component vs iframe vs JS SDK) — pros/cons для нашего случая, рекомендация с обоснованием
2. **Архитектурную диаграмму** — как widget живёт на host-странице, как persists across navigation, как streamит audio, как auth flow
3. **Bundle budget plan** — какие зависимости минимально нужны чтобы уложиться в 150 KB gzipped (без React? только vanilla? с preact?)
4. **Server-side API endpoints** — какие новые endpoints нужны в neurohub:
   - `GET /api/embed/playlists` (public list)
   - `GET /api/embed/playlist/:id` (tracks + metadata)
   - `GET /api/embed/stream/:trackId?token=...` (audio с CORS для cross-origin)
   - OAuth 2.0 endpoints (если scenario B)
   - Analytics events endpoint
5. **CORS + CSP** конкретный план — какие headers и какие домены добавить
6. **Сравнение с existing players** (Spotify embed, SoundCloud embed, Yandex.Music widget) — что у них хорошо/плохо, чему учиться
7. **MVP scope** — что войдёт в первую версию (2-3 недели до alpha), что отложить на V2

**Не делает в фазе 1:** не пишет код, не делает PR. Только architecture doc.

**Output:** `docs/strategy/GOROD-AI-ARCHITECTURE.md` — полный architecture spec.

## Subagent prompt (готовый к запуску)

Ниже — точный prompt для запуска через `Agent` tool with `subagent_type: "Plan"`:

```
ВАЖНО: Прочитай сначала docs/strategy/GOROD-AI-SPEC.md — это ТЗ от Босса 2026-05-20 на embeddable widget MuzaAi (кодовое имя «Город Ай»).

Затем подготовь архитектурный документ docs/strategy/GOROD-AI-ARCHITECTURE.md со следующими разделами:

1. **Выбор формата** (Web Component / iframe / JS SDK) — сравни 3 варианта по критериям:
   - Совместимость с host frameworks (React, Vue, vanilla)
   - Bundle size impact
   - MediaSession API (только top-frame работает)
   - CSP-совместимость
   - Скорость интеграции для клиента
   Дай рекомендацию с обоснованием.

2. **Архитектурная диаграмма** (текстом, без графики):
   - Как widget живёт на host-странице
   - Как persists state across navigation (App Shell pattern)
   - Audio streaming flow (cookie auth, range requests, MediaSession)
   - OAuth 2.0 flow с PKCE
   - Cross-origin communication

3. **Bundle budget plan** для 150 KB gzipped:
   - Какие зависимости минимально нужны
   - Preact vs vanilla DOM
   - Code splitting strategy
   - Tree shaking checklist

4. **Server-side API design** — новые endpoints для embed:
   - GET /api/embed/playlists?lang=ru&genre=focus
   - GET /api/embed/playlist/:id
   - GET /api/embed/stream/:trackId?token=...&range=...
   - OAuth 2.0 endpoints (authorize, token, refresh)
   - POST /api/embed/analytics (события виджета)
   Каждый endpoint — request/response shape, CORS headers, auth requirements.

5. **CORS + CSP план** — конкретно:
   - Какие домены платформы добавить в Access-Control-Allow-Origin
   - Какие наши CDN/API домены платформа должна добавить в её CSP
   - Содержание Content-Security-Policy для самого виджета
   - Service Worker (если нужен)

6. **Сравнение с конкурентами**:
   - Spotify embed (iframe-based, ограничения MediaSession)
   - SoundCloud Widget API
   - Yandex.Music embed
   - Apple Music embed
   Что у них хорошо/плохо, какие patterns переиспользовать.

7. **MVP scope** — разделить ТЗ на:
   - **V1 alpha** (2-3 недели): минимум для встраивания на 1 пилотную платформу
   - **V1 beta** (4-5 недель): полный functional spec из ТЗ
   - **V2** (после launch): SSO, advanced analytics, mobile native SDK

8. **Риски и open questions**:
   - Что неизвестно про коммерческую модель
   - Лицензионные риски (треки для embed)
   - MediaSession API в iframe (workarounds?)
   - Cross-page playback в SPA vs traditional websites
   - Тестирование на разных host platforms

Под 800-1500 строк документ. Конкретика, не общие фразы. С file:line ссылками на existing код если применимо (например audio streaming logic в server/routes.ts).

НЕ пиши код, не делай PR. Только architecture doc в docs/strategy/GOROD-AI-ARCHITECTURE.md.
```

## Reminder для Claude

**Когда Босс открывает сессию 2026-05-21:** вспомни этот plan, спроси «запустить subagent сейчас?» — если да, паст prompt выше через `Agent` tool с `subagent_type: "Plan"` (или `general-purpose` если хочешь implementations).

## После фазы 1

Когда subagent выдаст `GOROD-AI-ARCHITECTURE.md`:
1. Босс ревьюит, утверждает формат + MVP scope
2. Создаём `docs/strategy/GOROD-AI-SPRINT-PLAN.md` — детальный sprint plan
3. Назначаем dev-команду (или subagent на фазу 2)
4. Старт coding

## Зависимости

Прежде чем dev-фаза начнётся, должно быть готово:
- OAuth 2.0 server-side endpoints (V2 plan)
- Public playlist API (если ещё нет)
- Track streaming endpoint с CORS+CSP для embeds
- Analytics endpoint для widget events
- Подтверждение коммерческой модели от Босса
- Tech lead назначен (или подтверждение что subagent ведёт)
