# Контекст проекта MuziAi — снимок 2026-05-09

> Сжатая выжимка для Eugene. Используется как справочник между сессиями Claude.
> Без секретов. Только команды, URL'ы, схемы.
> Универсальный Markdown — экспортируется в любой AI (Perplexity, ChatGPT, Gemini).

---

## 1. Что это

**MuziAi** (`muziai.ru`) — платформа генерации песен через Suno (через GPTunnel API).
Репо: `AItestsibiria/BIZNESMETR`, ветка разработки: `claude/add-claude-documentation-OW5V7`.
Стек: Express + SQLite + Drizzle + React + TypeScript + 26 plugins.

## 2. Серверы

| Имя | IP | Hostname | Назначение | Hosting |
|---|---|---|---|---|
| **prod** | `31.130.148.107` | `7481293-uf895983` | muziai.ru — продажи | Timeweb |
| **clone** | `72.56.1.149` | (другой) | clone.muziai.ru — staging | Timeweb |

Оба используют:
- Путь приложения: `/var/www/neurohub/`
- Source git: `/opt/muziai-src/` (prod) / `/opt/neurohub-src/` (clone)
- PM2 process: `neurohub`
- БД: SQLite `/var/www/neurohub/data.db`
- Файлы треков: `/var/www/neurohub/authors/<author>/gen_<id>.{mp3,jpg}`

## 3. Auto-deploy

При каждом `git push` в ветку `claude/add-claude-documentation-OW5V7`:

1. Cron каждую минуту проверяет git
2. Новый коммит → backup current dist → npm ci + build → swap dist → pm2 restart
3. Health check `/api/example/ping` → fail → автоматический rollback
4. Telegram alert при rollback (если ключи в .env)
5. Лог: `/var/log/neurohub-prod-auto-deploy.log`

Eugene'у не нужны ручные deploy команды.

## 4. Что сделано в эту сессию (2026-05-08/09)

База: tag `triumph-na-efire-080526` → commit `13600c0`. После него 25+ коммитов.

**Главное**:
- Auto-deploy на prod (`auto-deploy-prod.sh` + cron)
- Sync-check / audio-test / cover-debug / covers/audit-playlist / email-test admin endpoints
- Cover refactor (3 root cause фикса + finally `probeCoverPath` с 4 расширениями)
- Cache-bust по mtime файла в `/api/playlist`
- Auto-poll баланса GPTunnel выключен (платный ~18₽/запрос)
- Auto-play «Встала страна» через 5 сек после загрузки landing
- /music дефолт = «Аудио · Расширенный» + миграция localStorage
- Backfill обложек с Suno CDN (одной кнопкой 🖼)
- Yandex SpeechKit only (убран Whisper / GPTunnel STT)
- Все секреты вынесены в `process.env` (TELEGRAM_BOT_TOKEN + GMAIL_APP_PASSWORD были захардкожены)
- `.env.example` шаблон в репо

Полный changelog: `docs/strategy/CHANGELOG-AFTER-TRIUMPH-NA-EFIRE.md`.

## 5. Правила в CLAUDE.md (текущие)

20 действующих правил. Самые важные за эту сессию:

1. **Never-leak-secrets rule** + полный реестр 11 секретов с rotation-командами
2. **Leak detection rule** — 🚨 первой строкой при обнаружении leak
3. **Ready-to-paste-commands rule** — один code-fence = одна операция, маркеры 🔴
4. **Prod-deploy 3-warning rule** — 3 явных подтверждения перед prod
5. **Deploy-target-options rule** — Clone → MuziAi
6. **Working rhythm rule** — после результата автоматически дальше
7. **Decreasing-reliability options rule** — варианты от надёжного к компромиссу
8. **Browser-link rule** — кликабельные URL
9. **Numbered options rule** — варианты нумеруются
10. **Latin-keyboard decode rule** — расшифровка iPad-латиницы

## 6. Текущее состояние

### ✅ Работает
- Auto-deploy prod + clone
- Cover показ через `/api/cover/<id>.jpg?v=<mtime>`
- 26 plugins загружены
- GPTunnel генерация треков
- pm2 neurohub online
- Email через Gmail SMTP

### ⚠ Сломано / нужно дочинить
- **`YANDEX_FOLDER_ID` на prod**: содержит API key (начинается с `AQV`), должен быть `b1g...` ID. Из-за этого Yandex 401 → audio не работает.
- **Termius → prod** ходит по password (key auth не настроен)

### 🔄 Не начато
- Sync Master plugin (merge clone → prod)
- DB revision обоих серверов
- Daily snapshots через Timeweb API
- Termius Snippets для one-tap операций

## 7. Полезные admin endpoints

Все требуют login на `/admin/v304`.

- `/api/admin/v304/sync-check` — 7 секций целостности
- `/api/admin/v304/audio-test` — 12 точек цепочки voice→text
- `/api/admin/v304/cover-debug/:id` — диагностика обложки
- `/api/admin/v304/covers/audit-playlist` — статус обложек 50 треков
- `/api/admin/v304/covers/refresh-index` — сброс кэша
- `/api/admin/v304/covers/backfill` — скачать недостающие обложки
- `/api/admin/v304/email-test?to=tissan2021@gmail.com` — тест SMTP
- `/api/admin/v304/gptunnel-balance` — баланс GPTunnel
- `/api/_status` — pluginsLoaded count

## 8. Реестр секретов проекта

Без значений. Длины и где взять — в CLAUDE.md → Never-leak-secrets rule.

| KEY | Назначение | Где взять | Длина |
|---|---|---|---|
| `GPTUNNEL_API_KEY` | Suno + LLM | gptunnel.ru → API Keys | ~32 |
| `YANDEX_SPEECHKIT_API_KEY` | STT | console.cloud.yandex.ru → SA → API Key | ~40 |
| `YANDEX_FOLDER_ID` | Биллинг для SpeechKit | console.cloud.yandex.ru → Идентификаторы | ~20 (b1g…) |
| `OPENAI_API_KEY` | Whisper STT fallback | platform.openai.com/api-keys | ~51 |
| `ANTHROPIC_API_KEY` | Claude для агентов | console.anthropic.com/settings/keys | ~108 |
| `GMAIL_APP_PASSWORD` | SMTP отправка | myaccount.google.com/apppasswords | 16 |
| `TELEGRAM_BOT_TOKEN` | Telegram-логин | @BotFather /token | ~46 |
| `ROBO_PASSWORD_1` + `_2` | Robokassa | partner.robokassa.ru | 8-32 |
| `SESSION_SECRET` etc | Внутренние подписи | `openssl rand -base64 32` НА VPS | 44 |
| `VK_*` | VK community | VK community → API | разные |
| `MAX_*` | Max messenger | Max BotFather | разные |

## 9. Полезные команды

**Проверка состояния** (Web Console):
```
pm2 status
crontab -l | grep neurohub
cat /var/www/neurohub/.deployed-sha-prod 2>/dev/null
curl -s -m 3 "http://127.0.0.1:5000/api/example/ping"
df -h /var/www
```

**Длины ключей** (без значений):
```
awk -F= '/^(YANDEX|GPTUNNEL_API_KEY|OPENAI_API_KEY|ANTHROPIC_API_KEY|TELEGRAM_BOT_TOKEN|GMAIL_APP_PASSWORD)/{print $1, length($2)}' /var/www/neurohub/.env
```

**Логи auto-deploy**:
```
tail -30 /var/log/neurohub-prod-auto-deploy.log
```

**Логи Yandex STT**:
```
pm2 logs neurohub --lines 100 --nostream | grep "YANDEX-STT"
```

**Force redeploy**:
```
/usr/local/bin/neurohub-prod-auto-deploy.sh
```

## 10. Структура репо

```
/home/user/BIZNESMETR/
├── apps/neurohub/
│   ├── server/
│   │   ├── routes.ts                  # Главный роутер 4500+ строк
│   │   ├── lib/transcribe.ts          # Yandex SpeechKit only
│   │   ├── plugins/                   # 26 плагинов
│   │   ├── index.ts                   # Express + plugin registry
│   │   └── storage.ts                 # Drizzle SQLite
│   ├── client/src/pages/
│   │   ├── landing.tsx                # / — главная + плейлист
│   │   ├── dashboard.tsx              # /dashboard
│   │   ├── music.tsx                  # /music — генерация
│   │   ├── admin-v304.tsx             # /admin/v304
│   │   └── ...
│   └── .env.example
├── deploy/
│   ├── auto-deploy.sh                 # Для clone
│   └── auto-deploy-prod.sh            # Для prod
├── docs/strategy/
│   ├── CHANGELOG-AFTER-TRIUMPH-NA-EFIRE.md
│   ├── MuziAi-CONTEXT-2026-05-09.md   # этот файл
│   ├── PITFALLS.md
│   └── original/00-NAVIGATOR-...md
└── CLAUDE.md                          # Все правила
```

## 11. Tags

- `triumph-080526` → commit `c699913` (стабильная редакция от 8 мая)
- `triumph-na-efire-080526` → commit `13600c0` (готова к эфиру, без audio гарантии)
- HEAD ветки `claude/add-claude-documentation-OW5V7`

Восстановление: `git checkout <tag-name>`.

## 12. Контакты

- **SMTP отправитель**: `tissan2021@gmail.com`
- **Admin alert email**: `egnovoselo@gmail.com`
- **GitHub репо**: https://github.com/AItestsibiria/BIZNESMETR
- **Timeweb panel**: https://timeweb.cloud/my

## 13. Открытые задачи

1. **Audio fix**: `YANDEX_FOLDER_ID` на prod — впиcать `b1g...` из Yandex Cloud
2. **Termius key auth** для prod
3. **DB revision** обеих БД
4. **Sync Master plugin**: merge clone → prod
5. **Daily snapshots** через Timeweb API
6. **Termius Snippets** для one-tap операций

## 14. Миграция в другую AI-платформу

Этот документ — universal Markdown, экспортируется в любой AI:

- **Perplexity Pro/Sonar**: вставь весь Markdown как «context» в промт
- **ChatGPT**: создай Custom GPT с этим документом в Knowledge Base
- **Gemini**: вставь в System Instructions / Files
- **Notion AI / Cursor**: импортируй .md файл

Для **полного контекста** также дай новой AI ссылки на:
- https://github.com/AItestsibiria/BIZNESMETR/blob/claude/add-claude-documentation-OW5V7/CLAUDE.md (все правила и архитектура)
- https://github.com/AItestsibiria/BIZNESMETR/blob/claude/add-claude-documentation-OW5V7/docs/strategy/CHANGELOG-AFTER-TRIUMPH-NA-EFIRE.md (последние 8 коммитов)
- https://github.com/AItestsibiria/BIZNESMETR/blob/claude/add-claude-documentation-OW5V7/docs/strategy/PITFALLS.md (известные ошибки)

Большинство AI читают raw.githubusercontent.com URL'ы.

---

## 15. Архитектурные принципы (для новой AI)

1. **Никогда не присылай секреты в чат** (включая JWT, API keys, passwords)
2. **При обнаружении leak** — первой строкой 🚨 предупреждение, попроси revoke + новый ключ через прямой SSH
3. **Один code-fence = одна операция** (через `&&` или heredoc)
4. **Placeholder'ы** — только `🔴ВПИШИ_СЮДА🔴` маркером
5. **Перед prod deploy** — 3 явных подтверждения от Eugene
6. **Все user-facing тексты на русском**, без упоминания «Suno» (только «MuziAi»)
7. **Decreasing reliability** — варианты от самого надёжного к компромиссу
8. **Numbered options** — варианты нумеруются цифрами
9. **Browser-link rule** — кликабельные URL вместо описания пути
10. **Timestamp footer** — `🕐 YYYY-MM-DD HH:MM MSK` в каждом ответе

---

*Дата создания: 2026-05-09 23:30 MSK.*
*Полные правила и архитектура: см. CLAUDE.md в корне репо.*
