# VK community integration — setup для Босса

Eugene 2026-05-23 (subagent vk-channel). Полная инструкция как привязать VK community «Музa Ай» к MuzaAi backend: Музa отвечает в DM, постит на стене, видна в admin diagnostics.

---

## Что уже сделано в коде

| Компонент | Где | Что делает |
|---|---|---|
| Plugin | `apps/neurohub/server/plugins/vk-channel/module.ts` | Webhook handler `POST /api/vk/callback`, sessions в `chatbot_sessions`, LLM reply через `callUnifiedMuzaLLM` |
| API library | `apps/neurohub/server/lib/vkApi.ts` | `vkApiCall`, `vkSendMessage`, `vkPostWallGroup`, `vkGroupInfo`, `vkConfigStatus` |
| Tool для Музы | `apps/neurohub/server/lib/muzaTools.ts` `post_to_vk` | [ADMIN-ONLY] Музa постит в community wall с approval flow |
| Admin endpoints | `apps/neurohub/server/routes.ts` | `GET /api/admin/v304/vk/status`, `POST /api/admin/v304/vk/test-post`, `GET /api/admin/v304/vk/messages?limit=50` |
| Schema.org | `apps/neurohub/client/index.html` | `sameAs` Organization включает `https://vk.com/muzaai` |
| Plugin registration | `apps/neurohub/server/index.ts` | `vkChannelModule` в PLUGINS list |

После следующего auto-deploy plugin будет загружен в `degraded` режиме (webhook принимает, но не отвечает) пока Босс не заполнит env vars.

---

## Шаги для Босса (вручную, ~10 минут)

### 1. VK Admin Panel — Получить Community Access Token

1. Зайти в community: https://vk.com/muzaai (или https://vk.com/club<ID>)
2. **Управление** (правая колонка) → **Работа с API** → **Ключи доступа**
3. **Создать ключ** → выбрать scope:
   - ✅ Сообщения сообщества (`messages`)
   - ✅ Управление сообществом (`manage`)
   - ✅ Доступ к фотографиям (`photos`)
   - ✅ Доступ к документам (`docs`)
   - ✅ Доступ к стене (`wall`)
4. Скопировать выданный токен (длинная строка ~85 символов) — это **`VK_ACCESS_TOKEN`**.
5. Записать **числовой ID** community (видно в URL `vk.com/club<ID>` или там же в настройках) — это **`VK_GROUP_ID`**.
6. Также записать **screen_name** community (например `muzaai`) — это **`VK_GROUP_USERNAME`**.

### 2. VK Admin Panel — Callback API setup

1. **Управление → Работа с API → Callback API**
2. Поле **URL** заполнить:
   ```
   https://muzaai.ru/api/vk/callback
   ```
3. VK сгенерирует **Строку для подтверждения** (8-16 символов) — это **`VK_CONFIRMATION_CODE`**. Скопировать.
4. Поле **Секретный ключ** — придумать свой случайный (например `openssl rand -base64 24` в Termius) — это **`VK_SECRET`**. Скопировать.
5. **Версия API** — `5.199` (или последняя доступная).
6. Сохранить настройки **ПОКА НЕ нажимая Confirm** — сначала задеплоить env vars (см. шаг 3).

### 3. Прописать env vars на VPS (через SSH с маркерами)

⚠️ По Key rotation pattern (CLAUDE.md). Значения вводи **руками** в Termius — не Cmd+V из любого источника прошедшего через AI-чат.

```bash
ssh root@31.130.148.107 'sed -i "/^VK_GROUP_ID=/d; /^VK_ACCESS_TOKEN=/d; /^VK_CONFIRMATION_CODE=/d; /^VK_SECRET=/d; /^VK_GROUP_USERNAME=/d" /var/www/neurohub/.env \
  && echo "VK_GROUP_ID=🔴ЧИСЛО_ИЗ_ШАГ_1🔴" >> /var/www/neurohub/.env \
  && echo "VK_ACCESS_TOKEN=🔴ТОКЕН_ИЗ_ШАГ_1🔴" >> /var/www/neurohub/.env \
  && echo "VK_CONFIRMATION_CODE=🔴ИЗ_ШАГ_2🔴" >> /var/www/neurohub/.env \
  && echo "VK_SECRET=🔴СОБСТВЕННЫЙ_СЕКРЕТ🔴" >> /var/www/neurohub/.env \
  && echo "VK_GROUP_USERNAME=🔴SCREEN_NAME🔴" >> /var/www/neurohub/.env \
  && chmod 600 /var/www/neurohub/.env \
  && pm2 restart neurohub --update-env'
```

Проверка что записалось без trailing spaces (без раскрытия значений):
```bash
ssh root@31.130.148.107 'awk -F= "/^VK_/{print \$1, \"len=\" length(\$2), \"first4=[\" substr(\$2,1,4) \"]\"}" /var/www/neurohub/.env'
```

### 4. VK Admin Panel — нажать Confirm

1. Вернуться в **Работа с API → Callback API**
2. Нажать **Подтвердить** рядом с URL.
3. VK сделает POST `{type: "confirmation", group_id: ...}` → наш сервер ответит plain-text `VK_CONFIRMATION_CODE` → VK покажет ✅ Сервер подтверждён.

Если ошибка — проверить через https://muzaai.ru/api/admin/v304/vk/status — должно быть `configured: true`.

### 5. VK Admin Panel — подписаться на events

1. **Работа с API → Callback API → Типы событий**
2. Включить:
   - ✅ **Входящие сообщения** (`message_new`) — главное, Музa в DM
   - ✅ **Новый участник** (`group_join`) — audit-log
   - ✅ **Покинул сообщество** (`group_leave`) — audit-log
   - ✅ **Новая запись** (`wall_post_new`) — опционально, audit-log
3. Сохранить.

### 6. VK Admin Panel — включить Бота для сообщений сообщества

1. **Управление → Сообщения** → включить **Сообщения сообщества**.
2. **Возможности ботов** → включить:
   - ✅ Возможности ботов в сообществе
   - ✅ Добавление кнопок к сообщениям (опционально)

### 7. Smoke-test

1. https://muzaai.ru/api/admin/v304/vk/status — должно быть:
   ```json
   {
     "ok": true,
     "configured": true,
     "env": {
       "VK_GROUP_ID": "...",
       "VK_ACCESS_TOKEN": "present (len=85, first4=vk1.)",
       ...
     },
     "group": { "id": ..., "name": "Музa Ай", "members_count": 1 }
   }
   ```
2. Написать DM сообщества: «Привет!» с любого VK-аккаунта.
3. Через 2-5 сек Музa ответит (через unified LLM pipeline, женский голос, MuzaAi context).
4. Проверка истории: https://muzaai.ru/api/admin/v304/vk/messages?limit=10

### 8. Test-post через admin endpoint (опционально)

```bash
curl -X POST https://muzaai.ru/api/admin/v304/vk/test-post \
  -H "Cookie: 🔴ADMIN_AUTH_COOKIE🔴" \
  -H "Content-Type: application/json" \
  -d '{"content": "Привет, MuzaAi на VK! 🎵", "confirm": true}'
```

Или через Музу в чате: «Опубликуй в VK что мы запустились» → Музa вызовет `post_to_vk` → подтверждение → пост.

---

## Что Музa умеет в VK

- ✅ Отвечает в DM community на любое текстовое сообщение (15 сек avg)
- ✅ Cross-channel memory — если юзер уже общался в Web/TG/Max и привязал аккаунт через `link_account` flow, Музa помнит контекст
- ✅ Постит на стене community через `post_to_vk` tool (admin-only, approval flow)
- ✅ Скрытно знает кто такой Босс если он пишет с linked VK-аккаунта (Musa-knowledge-governance rule)
- ❌ Пока **НЕ** загружает аудио в VK как native attachment (только URL в тексте поста) — TODO

---

## Troubleshooting

| Симптом | Что проверить |
|---|---|
| VK Confirmation не проходит | `curl https://muzaai.ru/api/vk/callback` отдаёт 404? — plugin не загружен, проверь pm2 logs neurohub |
| `configured: false` в admin status | env vars не задеплоились — повторить шаг 3 с pm2 restart --update-env |
| Музa не отвечает в DM | Проверить https://muzaai.ru/api/admin/v304/vk/messages — есть user сообщение но нет bot? → LLM упал. Логи: `pm2 logs neurohub --lines 200 \| grep vk-channel` |
| Все сообщения сразу с error | VK_SECRET не совпадает — проверить точное копирование без trailing space |
| 401 invalid secret | Если в VK Admin secret пустой — в .env тоже пустой. Если задан — должны совпадать байт-в-байт |

---

## TODO для следующих итераций (не блокер для запуска)

- [ ] Native audio upload через `docs.add` / `audio.add` чтобы Музa прикрепляла mp3 как полноценный VK attachment, а не текст-ссылку
- [ ] Welcome DM при `group_join` event (юзер подписался → Музa здоровается)
- [ ] VK Stories integration (post Suno track как audio story)
- [ ] VK widget на главной muzaai.ru — community feed
- [ ] Periodic auto-post лучших треков недели (cron в admin-overview)
- [ ] VK Pay для оплаты треков через VK без redirect на Robokassa

---

## Связано с

- `Cross-channel conversation linking rule` — Музa помнит юзера через все каналы
- `Single-persona-across-channels rule` — та же Музa в VK что и в web/TG/Max
- `Musa-female-voice rule` — женский род в репликах
- `Bot-webhook-dedup rule` — dedup по event_id / message.id
- `Secrets-admin-only rule` — VK_ACCESS_TOKEN никогда в response/logs raw
- `User-action-failure registry rule` — failed sends → user_action_failures
- `Chat-tool-calling rule` — post_to_vk требует confirm_publish

VK Callback API docs: https://dev.vk.com/api/callback/getting-started
VK methods reference: https://dev.vk.com/method
