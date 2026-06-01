# Admin Panel Security Audit — 17.05.2026

Аудит безопасности admin panel MuzaAi (`muzaai.ru`, VPS `31.130.148.107`).
Цель — максимально жёсткая защита admin endpoints + email-2FA на важные действия.

Источник: Босс 17.05.2026.

---

## TL;DR — Найденные issues

| # | Severity | Issue | Where | Fix |
|---|---|---|---|---|
| 1 | HIGH | Express listens на `0.0.0.0:5000` (потенциально доступен с IP, если firewall не блокирует) | `apps/neurohub/server/index.ts:411` | Привязать к `127.0.0.1` если nginx-proxy на той же машине, либо проверить `ufw status` |
| 2 | HIGH | CSRF-guard в **WARN-режиме** — пропускает чужой Origin с логом, не блокирует | `apps/neurohub/server/plugins/security-guard/module.ts:64` | Включить блокировку для `/api/admin/*` через strict-mode |
| 3 | MEDIUM | Нет rate-limit per-IP на `/api/admin/v304/*` (только login + register) | `apps/neurohub/server/routes.ts:40` rateLimit map | Добавить middleware 60 req/min/IP |
| 4 | MEDIUM | `Access-Control-Allow-Origin: *` на `/api/cover/:id.jpg` (cover serving) | `apps/neurohub/server/routes.ts:5701` | OK для public assets, но проверить чтобы не было на admin |
| 5 | MEDIUM | Нет блокировки доступа по direct-IP (Host header = IP, не домен) | nginx + security-guard | Добавить check в security-guard |
| 6 | MEDIUM | Нет email-2FA на разрушительные admin actions (`kick_session`, `query_users`, `delete_user`) | `muzaTools.ts:738-967` | Wrap через `adminTwoFactor.ts` (этот аудит) |
| 7 | LOW | Webhook endpoints (`/api/payment/result`, `/api/telegram/webhook`) whitelisted в CSRF без явной signature-check на этом уровне | `security-guard/module.ts:31-37` | Signature check уже в handler'ах (Robokassa, Telegram secret_token); OK |
| 8 | LOW | Cookies не используются (auth — Bearer header) → CSRF surface меньше | grep `res.cookie` → 0 hits | OK |
| 9 | LOW | `nodemailer` SMTP пароль через env (`GMAIL_APP_PASSWORD`) — OK | `routes.ts:286` | Если leaked — ротировать (см. Key rotation pattern) |

---

## (a) Открытые порты на VPS 31.130.148.107

**Команда для Босса (проверка):**

```
ssh root@31.130.148.107 'ss -tlnp | grep LISTEN'
```

**Ожидаемый вывод (что должно быть открыто):**

| Порт | Слушатель | OK? | Примечание |
|---|---|---|---|
| `22` | sshd | ✅ | Только key-auth (см. `/etc/ssh/sshd_config`) |
| `80` | nginx | ✅ | Redirect 301 → HTTPS |
| `443` | nginx | ✅ | Public HTTPS, terminate TLS |
| `5000` | node (pm2 neurohub) | ⚠️ **должно быть `127.0.0.1:5000`, не `0.0.0.0:5000`** | Сейчас bindится на `0.0.0.0` (см. `server/index.ts:411`) — если ufw не блокирует 5000 снаружи, это прямой обход nginx |

**Рекомендация (fix #1):**

Вариант **A (надёжный)** — поменять host в `server/index.ts`:

```ts
host: process.env.BIND_HOST || (process.env.NODE_ENV === "production" ? "127.0.0.1" : "0.0.0.0"),
```

В prod `.env` ставится `BIND_HOST=127.0.0.1`. Снаружи `5000` недоступен даже если ufw упал.

Вариант **B (быстрый)** — оставить 0.0.0.0, но убедиться что **ufw блокирует 5000 снаружи**:

```
ssh root@31.130.148.107 'ufw status verbose | head -20'
```

Должен быть запрет на 5000/tcp from any.

**Проверка direct-IP с локальной машины Босса:**

```
curl -m 5 http://31.130.148.107:5000/api/example/ping
```

Если 5000 firewall'нут — connection timeout. Если ответ есть — 5000 открыт наружу (проблема).

---

## (b) Прямой доступ к admin без домена

**Команда (Босс из своей машины):**

```
curl -H "Host: anything-else.com" http://31.130.148.107/api/admin/v304/dashboard-summary
```

Сейчас nginx с большой вероятностью **отдаст ответ** (default-server), если не настроен strict server_name.

**Рекомендация (fix #5):**

1. На nginx уровне (более строгий):

```nginx
# /etc/nginx/sites-available/muzaai
server {
    listen 443 ssl default_server;
    server_name _;
    return 444;  # closes connection without response
    ssl_certificate /path/to/dummy.crt;
    ssl_certificate_key /path/to/dummy.key;
}
```

2. На app-уровне (резерв) — security-guard plugin блокирует Host=IP (см. commit ниже).

---

## (c) Webhook endpoints — signature checks

| Endpoint | Provider | Signature mechanism | Где проверяется |
|---|---|---|---|
| `/api/payment/result` | Robokassa | MD5(`OutSum:InvId:Password2:Shp_*`) | `routes.ts` Robokassa handler |
| `/api/payment/success` | Robokassa | MD5(`OutSum:InvId:Password1:Shp_*`) | `routes.ts` |
| `/api/telegram/webhook` | Telegram | `X-Telegram-Bot-Api-Secret-Token` header | `telegram-bot/module.ts` |
| `/api/vk/webhook` | VK | body.secret или body.signature | `vk-channel` (если включён) |
| `/api/max/webhook` | Max | `MAX_WEBHOOK_SECRET` | `max-bot/module.ts` |

**Все signature-checks существуют на уровне handler'ов**, security-guard пропускает их по path whitelist (это OK).

Рекомендация — проверить в logs за 24 часа что нет 401/403 от legitimate webhook'ов (false positive signature reject). Скрипт:

```
ssh root@31.130.148.107 'pm2 logs neurohub --lines 1000 --nostream | grep -E "webhook.*(401|403|signature|invalid)"'
```

---

## (d) CORS

| Endpoint | Allow-Origin | OK? |
|---|---|---|
| `/api/cover/:id.jpg` | `*` | ✅ public cover assets — wildcard ОК |
| `/api/admin/v304/*` | не выставляется (Express default — same-origin) | ✅ |
| `/api/auth/*` | не выставляется | ✅ (полагаемся на Origin/Referer guard в security-guard) |
| `/api/stream/:id.mp3` | не выставляется (signed-url проверка вместо CORS) | ✅ |

**Нет `*` на admin endpoints** — проверено grep'ом.

Рекомендация — оставить как есть. CORS строгий по умолчанию у Express, public endpoints (covers) явно открыты.

---

## (e) CSRF guard

**Текущее состояние (`security-guard/module.ts`):**

- Проверяет Origin/Referer для всех non-GET `/api/*` requests
- Допустимые: `clone.muziai.ru`, `muziai.ru`, `podaripesnu.ru` + localhost dev
- **WARN-режим** — если Origin не trusted, **пропускает запрос** с warning в лог (строка 64)
- Webhook'и whitelisted по path

**Проблема (fix #2):** в WARN-режиме реальной защиты нет. CSRF-attack из malicious sub-resource (например, картинка из другого домена → форма submit на `/api/admin/v304/...`) пройдёт с предупреждением в логи.

**Рекомендация:** для `/api/admin/v304/*` включить **strict-mode** (block 403), оставив WARN для остальных API на 1 неделю наблюдений, потом тоже strict. Реализовано в commit ниже (security-guard расширение).

---

## (f) Rate limits

**Существующие:**

| Endpoint | Limit | Window | Where |
|---|---|---|---|
| `/api/auth/register` | 5 req | 1 час | `routes.ts:882` |
| `/api/auth/login` | 10 req | 15 мин | `routes.ts:1100` |
| `/api/engagement/*` | 60 req | 1 мин | `routes.ts:1632` |
| `/api/muzachat/*` | 30 req | 1 мин | `routes.ts:2390` |
| SMS OTP send | 1 SMS/мин, 5/час | per phone | `auth-sms/module.ts` |

**Отсутствуют (gap):**

| Endpoint | Risk | Recommended |
|---|---|---|
| `/api/admin/v304/*` | brute-force admin endpoints | 60 req/min/IP |
| `/api/auth/login` failed | credentials stuffing | 5 **failed**/15min/IP (сейчас 10 total) |

Реализовано в commit ниже (`security-guard` расширение).

---

## (g) Cookie security

**Текущее состояние:** auth через **Bearer header** (Authorization: `Bearer <token>`). Cookies не используются для аутентификации (grep `res.cookie` → 0 hits в server/).

Это уменьшает CSRF surface (нет auto-send credentials с другого origin). OK.

**Замечание:** session token хранится в `localStorage` на клиенте → vulnerable к XSS (если XSS вообще найдётся). Mitigation — строгий CSP header (см. отдельный аудит) + Express helmet middleware.

---

## Реализация защиты (commits ниже)

### Commit 1 — security-guard расширение

- **Strict CSRF** для `/api/admin/v304/*` — Origin MUST match whitelist, иначе 403
- **Per-IP rate limit** 60 req/min на `/api/admin/v304/*`
- **Failed-login rate limit** 5 failed/15min/IP
- **Block direct-IP** — если Host header матчит `^\d+\.\d+\.\d+\.\d+(:\d+)?$` → 403 (только non-webhook)

### Commit 2-4 — Email 2FA на admin tools

Защищаемые actions (9 шт):

| Action | Tool | Что делает | Risk |
|---|---|---|---|
| `change_registration_status` | `change_registration_status` | Открыть/закрыть регистрацию | Affects all new users |
| `kick_session` | `kick_session` | Удалить все сессии юзера (force logout всех устройств) | Lock out user |
| `query_users` | `query_users` | Поиск users по PII (email/phone/name) | Mass PII access |
| `send_telegram_alert` | `send_telegram_alert` | Отправить custom message админу в TG | Outbound msg (low) — но включаем для consistency |
| `reload_kb` | `reload_kb` | Перезагрузить KB бота | Affects all users (бот меняет ответы) |
| `pause_bot` | `pause_bot` | Пауза/возобновление бота | Affects all incoming TG users |
| `restart_pm2` | (новый, planned) | Перезапуск процесса pm2 | Service downtime |
| `delete_user` | (новый, planned) | Hard-delete user | Irreversible |
| `refund_payment` | (новый, planned) | Возврат платежа | Финансовая операция |

Flow:

1. Муза (или admin UI) вызывает action с `confirmed: false`
2. Action создаёт запись в `admin_pending_actions` + шлёт 6-значный код на admin email
3. Возвращает `{ requiresEmailConfirm: true, actionId, message }`
4. Admin вводит код в modal → `POST /api/admin/v304/protected-action/confirm`
5. Verify код → execute action → mark `used`
6. Запись в `admin_audit_log` с `viaEmailConfirm=true`

### Commit 5 — Email template

Russian template через Gmail SMTP. Subject:
> 🔐 Код подтверждения admin-действия MuzaAi

Body содержит action name + code + warning «если это не ты — смени пароль».

### Commit 6 — Admin UI modal

Компонент `AdminConfirmAction.tsx` — modal с 6-digit input + 10-min countdown.

### Commit 7 — Enriched audit log

`admin_audit_log` уже существует, добавляем колонки `via_email_confirm`, `ip`, `user_agent` (через ALTER).

---

## Команды для Босса (после merge)

1. Открой https://muzaai.ru/admin/v304 — попробуй вызвать "pause bot" через Музу → должен прийти email с кодом
2. Введи код в модалку → action выполнится
3. Проверь audit-log: `GET https://muzaai.ru/api/admin/v304/audit-log?recent=10`
4. SSH проверка ports:
   ```
   ssh root@31.130.148.107 'ss -tlnp | grep LISTEN'
   ```
5. Проверка direct-IP блокировки (после deploy security-guard расширения):
   ```
   curl -H "Host: 31.130.148.107" https://muzaai.ru/api/admin/v304/dashboard-summary
   ```
   Должен вернуть 403.

---

*Аудит составлен Claude по запросу Босса 17.05.2026. Изменения реализованы в этой же ветке.*
