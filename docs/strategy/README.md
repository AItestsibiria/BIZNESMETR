# Стратегический пакет MUZIAI v304

**Источник:** Google Drive · папка `2026-05-04_v304-strategy` (id: `13n-gs206xBx7Svrh6YTzX7vmlfCfzz9S`)
**Дата выгрузки:** 2026-05-06
**Объём:** 17 markdown-файлов (≈256 KB чистой стратегии и кода)
**Проект:** podaripesnu.ru / MuziAI · VPS1 `72.56.1.149`

> ⚠️ VPS1 (72.56.1.149) — **НЕ ТРОГАТЬ без явного подтверждения Евгения**. Любая операция деплоя — пятиуровневое предупреждение.

---

## Структура

```
docs/strategy/
├── README.md                    ← этот файл
├── original/                    ← оригинальные документы (8 файлов)
│   ├── 00-NAVIGATOR-объединённая-стратегия.md
│   ├── 01-АУДИТ-И-АРХИТЕКТУРА.md
│   ├── 02-МУЗЫКАЛЬНЫЙ-ДВИЖОК-Suno-на-100.md
│   ├── 03-АГЕНТЫ-ДАШБОРД-CRM.md
│   ├── 04-ЧАТ-БОТ-И-ХАБ-ВЗАИМОДЕЙСТВИЙ.md
│   ├── 05-СОЦСЕТИ-РЕКЛАМА-PIXELS.md
│   ├── 06-PLUGIN-АРХИТЕКТУРА-ХВОСТЫ.md
│   └── 07-DEPLOY-ROADMAP-СХЕМА-БД.md
└── v001_claude/                 ← переработанные Claude версии (9 файлов)
    ├── 00-NAVIGATOR-объединённая-стратегия_v001_Claude.md
    ├── 01-АУДИТ-И-АРХИТЕКТУРА_v001_Claude.md
    ├── 02-МУЗЫКАЛЬНЫЙ-ДВИЖОК-Suno-на-100_v001_Claude.md
    ├── 03-АГЕНТЫ-ДАШБОРД-CRM_v001_Claude.md
    ├── 04-ЧАТ-БОТ-И-ХАБ-ВЗАИМОДЕЙСТВИЙ_v001_Claude.md
    ├── 05-СОЦСЕТИ-РЕКЛАМА-PIXELS_v001_Claude.md
    ├── 06-PLUGIN-АРХИТЕКТУРА-ХВОСТЫ_v001_Claude.md
    ├── 07-DEPLOY-ROADMAP-СХЕМА-БД_v001_Claude.md
    └── 08-АУДИТ-ПЛЕЕР-БИБЛИОТЕКА-ПЛЕЙЛИСТЫ_v001_Claude.md
```

> Документ **08** существует только в `v001_claude/` — это эксклюзивная Claude-версия про аудит плеера, библиотеки и плейлистов.

---

## Что в каких документах (карта пакета)

| #  | Файл | О чём | Когда читать |
|----|------|-------|--------------|
| 00 | NAVIGATOR | общая карта системы, философия, навигация | первым, 10 минут |
| 01 | АУДИТ-И-АРХИТЕКТУРА | 11 нестыковок в коде v303, исправления, целевая архитектура v304 | перед спринтом 1 |
| 02 | МУЗЫКАЛЬНЫЙ-ДВИЖОК-Suno | persona, weighting, structural tags, extend, cover; план внедрения | перед спринтом 2-3 |
| 03 | АГЕНТЫ-ДАШБОРД-CRM | 9 агентов под A1, Lead Scoring, RFM, NBA, дашборд | перед спринтом 4-5 |
| 04 | ЧАТ-БОТ-И-ХАБ-ВЗАИМОДЕЙСТВИЙ | ConductorBot, email/TG/VK, тикеты, счета, документы | перед спринтом 6 |
| 05 | СОЦСЕТИ-РЕКЛАМА-PIXELS | VK Pixel, Yandex Metrika, MyTarget, Meta; UTM, события, lookalike | перед спринтом 7 |
| 06 | PLUGIN-АРХИТЕКТУРА-ХВОСТЫ | Module API, Event Bus, Hook Points — фундамент всего нового | перед спринтом 1 |
| 07 | DEPLOY-ROADMAP-СХЕМА-БД | one-command deploy, 8-спринтовый roadmap, 20 новых таблиц | перед стартом |
| 08 | АУДИТ-ПЛЕЕР-БИБЛИОТЕКА-ПЛЕЙЛИСТЫ | разбор UX плеера/библиотеки/плейлистов | вместе с 02 |

---

## Быстрая навигация — «что мне нужно → какой файл»

| Я хочу… | Открой |
|---|---|
| Понять, что в коде сломано | 01 §1 |
| Заставить Suno работать на полную | 02 |
| Узнать, какие агенты нужны и как они общаются | 03 §3.1–3.3 |
| Увидеть макет нового дашборда | 03 §4 |
| Поднять чат-бот за 1 спринт | 04 §1–§4 |
| Подключить email-поддержку | 04 §5 |
| Сделать счета для юрлиц | 04 §6 |
| Поставить пиксели и настроить рекламу | 05 |
| Запустить автопостинг в VK | 05 §6 |
| Добавить новый модуль | 06 — Plugin API |
| Дать Perplexity задеплоить | 07 §1 |
| Понять, что делать первой неделей | 01 §0.1 |

---

## Архитектурные принципы (из 00-NAVIGATOR)

| Принцип | Что значит |
|---|---|
| **Тонкое ядро + плагины** | Всё новое — плагины через единый Module API. Ядро не трогаем. |
| **Event-driven** | Модули общаются через events (`user.registered`, `gen.completed`, `payment.succeeded`). |
| **Конфигурируемость без релиза** | Цены, промокоды, шаблоны писем, скрипты бота — в БД, меняются из админки. |
| **Observability по умолчанию** | Каждое действие → событие → метрика. Нет «слепых зон». |
| **One-command deploy** | Любой деплой — одна команда из Drive. Никаких ручных шагов. |
| **Без vendor lock** | Suno, Robokassa — за абстракциями. Можно поменять за 1 файл. |

---

## Roadmap (8 спринтов ≈ 2.5 месяца, см. 07 §2)

| # | Спринт | Главное |
|---|---|---|
| 1 | Фундамент | EventBus, ModuleRegistry, feature_flags, leads, agent_actions, базовые pixels, баги ядра |
| 2 | Suno на 100% | Структурные теги, tempo/mood/key, negative prompts, 10 шаблонов |
| 3 | Persona / Extend / Cover | Новые SKU (11 шт.), bundles, AOV +30% |
| 4 | Агенты часть 1 | LeadHunter → DemoAgent + Lead Scoring + plugin notifications |
| 5 | Агенты часть 2 | OnboardingAgent → ContentAgent + RFM + A1 Master |
| 6 | Чат-бот | ConductorBot, web-widget, Telegram, plugins support/invoicing/omnichannel |
| 7 | Дашборд + реклама | 8 виджетов, server-side tracking, VK Conversions API, автопостинг |
| 8 | Полировка | CSRF, path traversal, logger redaction, smoke/integration tests |

---

## Изменения БД (полный DDL — в 07 §3)

**20 новых таблиц:**
`events` · `plugins_registry` · `feature_flags` · `leads` · `agent_actions` · `support_tickets` · `ticket_messages` · `chatbot_sessions` · `chatbot_messages` · `chatbot_prompts` · `faq_articles` (+ FTS5) · `invoices` · `documents` · `email_outbox` · `email_inbox` · `notification_templates` · `notifications` · `pixel_configs` · `pixel_events` · `tracking_attribution` · `audience_segments` · `marketing_spend` · `personas` · `gen_extensions` · `gen_templates` · `pricing` · `gen_stats_daily` · `promo_codes`

**Расширения существующих:**
- `users` (+12: `lead_id`, `lifecycle_stage`, `lead_score`, RFM, `telegram_chat_id`, `vk_user_id`, …)
- `generations` (+8: `persona_id`, `structural_tags`, `vocal_weights`, `source_gen_id`, `suno_model`, …)
- `payments` (+3: `invoice_id`, `receipt_url`, `attribution_id`)

---

## Блокеры старта — 25 вопросов к Евгению (07 §4)

Без ответов кодинг не начинаем. По 6 категориям: **бизнес** (цены, реферал, ОФД, самозанятые), **каналы** (Telegram-токен, VK-админ, WhatsApp/SMS, SMTP/SPF), **реклама** (бюджеты VK Ads / Yandex Direct), **технические** (Node-версия, бэкапы, DNS), **юридические** (политика, оферта, cookie-баннер), **операционка** (ревью автопостов, шаблоны писем, NPS).

---

## Операционные правила (повтор)

1. **VPS1 72.56.1.149 (MuziAI)** — не трогаем без явного разрешения. Пятиуровневое предупреждение перед любой операцией.
2. **Язык** — русский во всех интерфейсах, документах и коммуникациях.
3. **Сохранение результатов** — Drive-папка `1s6I4L4BFgdV2gwoWTkf1UndVYhXOLA37`, подпапки по датам.
4. **PDF/документы** — сохраняем точную форму оригинала.
5. **Всё новое — через Plugin API**, прямые правки ядра только для критических багов.

---

*Папка-источник на Google Drive: <https://drive.google.com/drive/folders/13n-gs206xBx7Svrh6YTzX7vmlfCfzz9S>*
