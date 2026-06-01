# Ночной стратегический аудит — 17.05.2026

**Автор:** Claude Code (по запросу Босса 17.05.2026 ночью)
**Scope:** безопасность, Муза AI / бот, сервисы. План усиления позиций.
**Тип:** read-only стратегический аудит — без правок кода, только анализ + roadmap.

---

## 1. Контекст (короткий)

**MuzaAi** — платформа авторского трекмейкинга на базе AI. Архитектура (live на `muzaai.ru`, VPS `31.130.148.107`):

| Слой | Стек | Состояние на 17.05.2026 |
|---|---|---|
| Backend | Express 4 + SQLite + Drizzle ORM + Zod | OK |
| Frontend | React + Vite + Tailwind | OK |
| Auth | Phone-OTP (SMS.ru) + email-password + Telegram-link | OK |
| Music gen | Suno via **GPTunnel** (paid proxy) | OK, balance ~1 299 ₽ |
| STT (voice) | **Yandex SpeechKit** (single provider) | OK, без fallback |
| TTS (Muza voice) | **Yandex SpeechKit** (8 голосов) | OK |
| LLM primary | **Anthropic Claude Haiku 4.5** | 🔴 **403** (ключ leaked, pending rotation) |
| LLM fallback | **TimeWeb AI Proxy** (anthropic/claude-haiku-4-5) | OK после fix сегодня |
| Email | Gmail SMTP (`GMAIL_APP_PASSWORD`) | 🔴 пусто на проде (.env stub) |
| Payments | **Robokassa** | 🔴 ключи `🔴ВСТАВЬ` (не работает) |
| Telegram | `@Muziaipodari_bot` | OK после ротации сегодня |
| Max channel | через `dev.max.ru` API | MVP |
| Voice-admin (новое) | админ говорит с Музой голосом в `/admin/v304` | OK |

**За день случилось 3 инцидента:**
1. Утечка root-password в чат → ротировано.
2. 2 чужих SSH-сессии обнаружены на VPS (Босс видел в `who`/`w`).
3. Anthropic ключ leaked → 403, заменили на TimeWeb gateway как primary fallback.

---

## 2. БЕЗОПАСНОСТЬ — критический аудит

### 2.1 🔴 КРИТИЧНЫЕ дыры

| # | Issue | Файл/Source | Что случится если эксплуатируют | Likelihood | Effort |
|---|---|---|---|---|---|
| **K1** | `authMiddleware` пускает **любого залогиненного юзера** на ~14 endpoint'ах `/api/admin/*` (не `/api/admin/v304/*`) — там inline `if (user.email !== "egnovoselov@gmail.com")` после auth. **Hardcoded email** + если в БД появится второй админ — он не пройдёт. Логика обхода если адресный кейс с подменой email. | `apps/neurohub/server/routes.ts:6371-7821` (24 hits для `egnovoselov@gmail.com`) | Любой залогиненный → пройдёт `authMiddleware` → `403` от inline-check. **Сейчас OK,** но fragile: одна правка где забыли inline-check → дыра. **Если кто-то получит Bearer админа** — все 14 endpoint'ов открыты (включая `/api/admin/block/:userId` → блокировка любого юзера, `/api/admin/moderate/:id` → удаление треков). | medium | low (заменить `authMiddleware` на `requireAdmin` + удалить inline-checks) |
| **K2** | **Все API ключи в plain `.env`** на VPS. Если SSH compromise или backup leak — все 11 ключей сразу: GPTunnel, Yandex, OpenAI, Anthropic, Telegram, Max, SMS.ru, Gmail, Robokassa×2, VK. | `/var/www/neurohub/.env` | Полная компрометация платформы за один шаг: можно сжечь баланс GPTunnel, отправить SMS со всеми деньгами, прочитать платёжную историю всех юзеров. Сегодняшний leak root-password — точная демонстрация этого риска. | medium-high | medium (vault: HashiCorp / sops-encrypted / age-encrypted env) |
| **K3** | **2 чужих SSH-сессии сегодня.** Если был доступ — мог установить backdoor (cronjob, systemd timer, modified pm2 hook, hidden user). **Никакого backdoor scan не было проведено.** | VPS audit (logs за 17.05) | Persistent access без cred'ов: атакующий приходит когда хочет, exfiltrate БД, наблюдает за нашими действиями, может ждать pay-day. | medium | medium (rkhunter, chkrootkit, integrity scan `/etc/cron.*`, `/etc/systemd/system/*`, `~/.ssh/authorized_keys`, новые users в `/etc/passwd`) |
| **K4** | **Anthropic ключ leaked ранее** (явно по 403 → revoke прошёл). Нет автоматизированной procedure для ротации Anthropic — Босс делает руками каждый раз в Termius. При следующем leak'е — снова downtime LLM пока Босс не свободен. | пусто (только manual rotation pattern в CLAUDE.md) | Downtime Музы (LLM упал) → юзеры видят fallback-баннер → потерянные продажи. | medium | medium (automated rotation flow: web admin → ввод нового ключа → sed + pm2 restart + verify через `/admin/v304/api-keys/health` за один клик) |
| **K5** | `express.json()` без `limit:` → дефолт 100 KB. **Для admin endpoints** где Босс может посылать большие JSON (например batch update) — нормально, но **для public `/api/muza/chat`** — payload без ограничения на длину `userText` в Zod schema. | `apps/neurohub/server/index.ts:118-124` + `routes.ts:2631` (muzachat) | Memory exhaustion attack: атакующий шлёт 100 KB JSON × 100 RPS → Node OOM. Защита есть на rate-limit (30/мин), но 30 × 100 KB = 3 MB/мин — не катастрофично, но не идеально. | low | low (express.json({ limit: '64kb' }) + Zod max(8000) на userText) |
| **K6** | `SUNO_WEBHOOK_SECRET` deriveится через **SHA256 от SESSION_SECRET** (fallback "fallback") если в env пусто. Если `SESSION_SECRET` = literal `"fallback"` (default) → webhook secret = известный публичный hash, любой может подделать Suno-callback и отметить любую генерацию `done`. | `apps/neurohub/server/routes.ts:438-440` | Атакующий поддельным callback переводит свою генерацию в `done` → файл из его `result_url` сохранён как трек юзера → CSRF на musa.ru: треки автора подменены. | low (SESSION_SECRET наверняка задан) | low (явная проверка `if (!process.env.SESSION_SECRET) throw`) |

### 2.2 🟡 СРЕДНИЕ дыры

| # | Issue | Файл/Source | Что случится | Likelihood | Effort |
|---|---|---|---|---|---|
| **M1** | Sessions = JWT-like Bearer в таблице `sessions`, никакой ротации `SESSION_SECRET`. Если он leaks — все active sessions компрометируются. **kick-all-users command не реализован** (есть `kick_session` на одного юзера). | `apps/neurohub/server/lib/tokenStore.ts` | leak `SESSION_SECRET` → атакующий генерит свои Bearer → пожизненный доступ ко ВСЕМ юзерам. | low-medium | medium (TRUNCATE sessions + force re-login; добавить `kick_all` admin tool) |
| **M2** | `recordFailedLogin(ip)` + `isLoginIpLocked(ip)` существуют, но **не используются вызывающими handler'ами** регистрации/логина. Grep на `recordFailedLogin` в routes.ts: **0 hits**. | `security-guard/module.ts:251-274` vs `routes.ts:1228` | Brute-force login: атакующий с одного IP может делать 10 login/15min (rateLimit), но **failed attempts не пишутся** → нет ban после 5 неудач. | medium | low (добавить вызовы в /api/auth/login + /api/auth/sms/verify-otp + /api/auth/admin-verify-code) |
| **M3** | Admin email-2FA codes только 6 цифр (1M комбинаций). Если SMTP перехвачен / Босс на open-WiFi → атакующий читает email с кодом. **Не используется time-based TOTP** (Google Authenticator). | `apps/neurohub/server/lib/admin2fa.ts:60-64` | Compromise через MITM email: атакующий между Gmail и Босс'ом читает 6 цифр → admin доступ. На текущей инфраструктуре маловероятно (Gmail TLS), но как только Босс на сторонней Wi-Fi — open. | low | medium (добавить TOTP secret в `admin2fa_totp_secret`, проверять `otplib` вместо/вдобавок к email) |
| **M4** | **fail2ban статус неизвестен.** В `ADMIN-SECURITY-AUDIT-170526.md` упомянуто что 22-порт key-only, но нет упоминания fail2ban или активного списка banned IPs. | VPS state | Brute-force SSH (даже на key-auth: атакующий нагружает CPU sshd попытками). На SSH key-only — невозможно зайти, но DoS на sshd возможен. | low-medium | low (apt install fail2ban + jail для sshd с findtime=600 maxretry=5) |
| **M5** | **Admin concurrent-session-alert** правило в CLAUDE.md описано, но **не реализовано в коде.** Если кто-то получит admin Bearer и зайдёт с другого IP — никакого alert'а. | CLAUDE.md → `Admin-concurrent-session-alert rule` | Stolen admin token = silent access. | medium | medium (новый helper `notifyOnConcurrentAdminLogin` + hook в requireAdmin middleware) |
| **M6** | Telegram-bot SHA256(SESSION_SECRET) для webhook secret. Если SESSION_SECRET leaks — атакующий поддельно отправляет webhook-update'ы → Муза «отвечает» от имени любого юзера, чьим chat_id подделали. | `apps/neurohub/server/plugins/telegram-bot/module.ts:885-895` | Impersonation чужого юзера в чате Музы → может выудить чужие данные через tool'ы (`get_user_balance`, `check_recent_payments`). | low (SESSION_SECRET protected) | low (явный `TELEGRAM_WEBHOOK_SECRET` env, отдельный от SESSION_SECRET) |
| **M7** | **Origin/Referer CSRF guard в WARN-режиме** для не-admin /api/* (только admin — strict). Любой third-party сайт может POST на `/api/muza/chat`, `/api/auth/sms/send-otp` от имени юзера через CORS. Auth=Bearer → CSRF не страшен напрямую, но возможна enumeration ID. | `security-guard/module.ts:105-114` | Атакующий сайт через iframe + fetch с no-cors → forced calls (без чтения ответа, но с side-effects: отправка SMS на номер юзера, создание handoff'ов). | low | low (включить strict mode для всех POST /api/* через 1 неделю наблюдений) |
| **M8** | **GMAIL_USER пустой на проде** → email-OTP, password reset, admin-2FA email **не работают.** Single failure mode: leaked сессия не может быть kicknута, потому что admin не зайдёт за 2FA-кодом который не пришёл. | `apps/neurohub/server/plugins/notifications/module.ts:113` + .env | Lockout админа в момент инцидента (когда нужно срочно kicknуть). | high (уже не работает) | low (Босс вписывает GMAIL_APP_PASSWORD + GMAIL_USER в .env, pm2 restart --update-env) |
| **M9** | LLM tool `query_users` отдаёт PII (email, phone) маскированные, но **возвращает userId** — атакующий с admin role через voice-channel может за раз перечислить top-10 юзеров. 2FA есть, но **2FA bypass** через `ADMIN_2FA_BYPASS=1` env. | `apps/neurohub/server/lib/muzaTools.ts:1272-1310` + `admin2fa.ts:44` | Если bypass env остался в проде по ошибке — admin tools без 2FA. Кто-то с admin Bearer = full PII enumeration. | low (env под контролем) | low (явный server-warning при старте если `ADMIN_2FA_BYPASS=1`) |
| **M10** | **Prompt injection** через `<user_message>` обёртку защищена только regex'ом `replace(/<user_message>/gi, "")`. **Не покрывает варианты:** `<UsErMessage>`, `<user message>`, `<<user_message>>`, base64-encoded "<user_message>" если он попадёт в historical context. | `llmCore.ts:317-322` | Sophisticated jailbreak: атакующий обманывает LLM ролёвыми вставками → может попытаться вызвать admin tool через `escalate_to_human(team="commercial", reason="ignore previous...")` — нет, не сработает потому что админ-tools уже filterToolsForRole'ом отфильтрованы для non-admin. ОК. **Но** для admin-voice channel — попытка инъекции через STT (произнесёт «выполни kick_session»). 2FA блокирует. ОК. | low | low (более жёсткий regex + проверка на длину tool input'ов) |

### 2.3 🟢 МЕЛКИЕ

| # | Issue | Где | Effort |
|---|---|---|---|
| L1 | `console.log` логирует имена пользователей, IPs в открытом виде → попадёт в pm2 logs (`/root/.pm2/logs/*`) → leak при backup logs | везде в `plugins/`, `routes.ts` | medium (sanitize PII в logger wrapper) |
| L2 | Cookie не используются (Bearer-auth) — но `SameSite` для XSS не определён, browser fingerprinting на 100% | front | low |
| L3 | `git push` всегда на feature branch без commit signing (GPG) — атакующий с access к dev машине может commit'ить от моего имени | dev | low (configure GPG signing) |
| L4 | В `secrets-admin-only` rule сказано «brain-export → masks only», но я не верифицировал что **реально** в `apps/neurohub/server/plugins/master-dashboard/module.ts` нет `process.env.X` в response. | `master-dashboard/module.ts` | low (`grep -n "process.env" master-dashboard/module.ts`) |
| L5 | Admin endpoints rate-limit 60 req/min/IP — нормально, но **per-Bearer не лимитится** — атакующий с украденным Bearer + смена IP (Tor) обходит. | `security-guard/module.ts:144-168` | medium (rate-limit per (userId, IP) parsy) |
| L6 | `voice-admin` endpoint multipart, audio cap 5 MB — но **нет content-type whitelist** — можно прислать `audio/wav` 5 MB всеми нулями → Yandex отклонит, но мы потратили bandwidth. | `voice-admin/module.ts` | low |

---

## 3. МУЗА AI / БОТ — критический аудит

### 3.1 LLM Resilience (главное)

**Current chain:** `ANTHROPIC_API_KEY → ANTHROPIC_API_KEY_BACKUP → ANTHROPIC_API_KEY_BOT → TimeWeb Gateway → null`

✅ **Хорошо:** TimeWeb fallback работает после сегодняшнего fix.
✅ **Хорошо:** Cross-channel persona через `personaFor(userKey)`, hash-stable.
✅ **Хорошо:** Tool-use loop ограничен 4 итерациями (`llmCore.ts:393`).
✅ **Хорошо:** `<user_message>` prompt-injection guard.
✅ **Хорошо:** `filterToolsForRole` отфильтровывает admin-tools для user channels.
✅ **Хорошо:** Все admin-only handlers имеют `isAdminCtx` guard как defense-in-depth.

❌ **Проблема А — Single LLM provider chain:** Все 3 Anthropic ключа + TimeWeb gateway → **все идут на один upstream (Anthropic)**. Если Anthropic как сервис упадёт целиком (региональный outage, законодательная блокировка в РФ, выпуск из-за финансовых санкций) — **все 4 опции падают одновременно**. TimeWeb gateway — это прокси к Anthropic, не другой LLM.

❌ **Проблема Б — Без 3-й (нон-Anthropic) опции:** GPTunnel поддерживает OpenAI Chat Completions, и у нас есть `GPTUNNEL_API_KEY`. Можно добавить GPT-4o-mini через GPTunnel как 5-й fallback в случае Anthropic ecosystem outage.

❌ **Проблема В — TimeWeb gateway не поддерживает Anthropic tools.** При fallback на TimeWeb весь MUZA_TOOLS не работает → Муза в degraded mode (тексты OK, но `get_user_balance` etc. не работают). Юзер не видит этого, но конверсия падает.

### 3.2 Tool security

✅ **Admin-only tools:** `[ADMIN-ONLY]` marker + `filterToolsForRole` + `isAdminCtx` guard на handler-level — defense in depth.
✅ **Email-2FA на destructive admin actions:** `reload_kb`, `send_telegram_alert`, `change_registration_status`, `query_users`, `pause_bot`, `kick_session`.
✅ **Audit-log:** Каждое 2FA-action пишется в `admin_audit_log` через `writeAuditFor2FA`.

❌ **Player-tools без auth-check:** `play_track`, `pause_player`, `next_track`, `find_tracks` доступны **всем**, включая анонимных. Это **не дыра** (они не делают side-effect на чужие данные — markers возвращают), но `find_tracks` с пустым/wildcard query → **SQL LIKE '%' on generations table** → может загрузить весь production index → DoS на БД при 100 RPS. **Mitigation:** Zod schema добавить min length на query.

❌ **`change_voice` без rate-limit:** Можно дёргать 100 раз в секунду — каждый emit'ит CustomEvent во frontend. **Mitigation:** Rate-limit per session.

### 3.3 Cross-channel persona

✅ Hash-stable `personaFor(userKey)` — один юзер = одна персона стабильно.
✅ Cross-channel history: `loadHistoryForLLM(sessionId, 15)` мерджит все sessions того же userId.
✅ Имя Музы всегда «Муза» (правило в `consultantPersona.ts:229-241`).

❌ **chatbot_sessions.userId апдейтится только при первом сообщении** (не сразу при auth) — есть короткое окно когда сессия anonymous и не линкуется. Mitigation: hook на logout/login event → update existing anon sessions с same browser fingerprint.

### 3.4 Voice (Yandex)

✅ 8 голосов, picker UI, marker-based selection.
✅ TTS opt-in (`?tts=1` в voice-admin).

❌ **STT no fallback** (см. transcribe.ts:235 — `transcribeRussianAudio` теперь ONLY Yandex. Раньше был OpenAI + GPTunnel fallback, отключен Eugene 2026-05-09).
❌ **TTS no fallback** — Yandex упал → Муза молчит.

### 3.5 Knowledge Base sync

✅ mtime-cache + `?secret=...` reload endpoint.
✅ Knowledge-base sync rule в CLAUDE.md.

❌ **KB не versioned** — если кто-то правит вживую на VPS, нет diff'а. Mitigation: KB только через git (запретить SSH-правки).

### 3.6 Empty-LLM fallback

✅ Intent detection на frontend (banner «Муза временно не отвечает»).

❌ **Hardcoded fallback string на сервере не покрыт:** `routes.ts:2631+` muzachat handler возвращает 200 с пустым ответом — нет специфической ошибки для frontend «LLM down» vs «no answer».

### 3.7 Tool-use loop

✅ `loopIter < 4` ограничение защищает от infinite loop. ✅ OK.

### 3.8 Сессии и impersonation

❌ **sessionId в чате — UUID, генерится на frontend.** Если кто-то догадается о sessionId другого юзера (или украдёт из localStorage через XSS) — он подключится к чужому диалогу и увидит историю. **Mitigation:** требовать Bearer для resume сессии, или генерировать sessionId с signed-hash от userId.

---

## 4. СЕРВИСЫ — критический аудит

### 4.1 GPTunnel (Suno + Whisper)
- ✅ API key установлен, balance ~1 299 ₽ = ~144 трека.
- ✅ Watchdog: `suno-watchdog` plugin отслеживает `low_balance` + `unreachable`.
- ❌ **Нет автоматического top-up alert юзеру/Боссу при < 100 треков.** Был раньше `low_balance` watchdog — нужно проверить что cron активен и telegram-alert работает.
- ❌ **Нет alternate Suno-provider** — если GPTunnel закрытся или Suno изменит условия, мы остаёмся без генерации.

### 4.2 Yandex SpeechKit (STT + TTS)
- ✅ Один ключ, один сервис.
- ❌ **STT без fallback** (см. 3.4). OpenAI Whisper и GPTunnel Whisper доступны в коде (`transcribe.ts:157+`), но **отключены** в публичной `transcribeRussianAudio()` функции. **Рекомендация:** включить chain `Yandex → GPTunnel Whisper → OpenAI Whisper`.
- ❌ **TTS без fallback** — Muza voice = только Yandex. Можно добавить OpenAI TTS как fallback (есть voices alloy/echo/etc).

### 4.3 TimeWeb AI Proxy
- ✅ После сегодняшнего fix работает с моделью `anthropic/claude-haiku-4-5`.
- ❌ **Не поддерживает Anthropic tools** — degraded mode (см. 3.1В).
- ❌ Если TimeWeb тоже использует Anthropic upstream → single point of failure для всего LLM (см. 3.1А).

### 4.4 SMS.ru (phone-auth)
- ✅ Reverse flashcall + 6-digit SMS-OTP оба работают.
- ✅ Rate-limit 5/мин/IP на `phone-check`.
- ❌ **Нет alternate провайдера** настроенного. SmsProvider interface существует, но реализован только SMS.ru.
- ❌ Если SMS.ru rate-limit'нет нас (например 100 SMS/min лимит на тариф) — регистрация мёртвая.

### 4.5 Robokassa
- ❌ **`ROBO_PASSWORD_1` / `ROBO_PASSWORD_2` сейчас `🔴ВСТАВЬ`** в .env → платежи **не работают на проде**.
- ❌ **Нет alternate payment-провайдера** (CloudPayments, ЮKassa, Stripe RU).
- ✅ Signature check через MD5 — OK по стандарту Robokassa.

### 4.6 Email (SMTP)
- ❌ **`GMAIL_USER` пустой** на проде → email-OTP, password reset, admin-2FA email **сломаны** (см. M8 выше).
- ❌ **Нет alternate SMTP-провайдера** (SendGrid, Mailgun, Yandex SMTP).
- 🟡 Если ротация Gmail App-Password не сделается timely — система ламается тихо.

### 4.7 Telegram bot
- ✅ BOT_TOKEN ротирован сегодня, webhook config корректен.
- ❌ **Backup channel для alerts если bot down не настроен.** Если Telegram упадёт + email сломан (см. M8) → Босс не получает никаких alert'ов от системы.
- ❌ **Никаких alert если сам bot down.** Bot-channels-health плагин логирует, но если он молчит — кто это заметит?

---

## 5. ПЛАН УСИЛЕНИЯ — ROADMAP

### 5.1 Короткое плечо — 1-2 дня (max bang-for-buck)

| # | Что | Эффект | Trade-off |
|---|---|---|---|
| **S1** | **Backdoor scan на VPS** после 2-х чужих SSH-сессий: `rkhunter --check`, `chkrootkit`, проверка `/etc/cron.*`, `/etc/systemd/system/*.timer`, `~/.ssh/authorized_keys`, `/etc/passwd` (новые users), `last -20`, `who`. Затем — **смена SSH key** (revoke старого), включить fail2ban (sshd jail), отключить password-auth в sshd_config (если ещё включён). | Закрывает persistent-access vector. Снимает риск молчаливого backdoor'а. | 30-60 мин Босса в Termius |
| **S2** | **Включить email** (`GMAIL_USER` + `GMAIL_APP_PASSWORD` через `sed -i` + pm2 restart). Без email — admin-2FA не работает, password reset не работает, юзеры не получают подарочные треки уведомления. | Восстанавливает основной канал коммуникаций. | 5 мин Босса |
| **S3** | **Заменить `authMiddleware` на `requireAdmin` во всех `/api/admin/*`** routes (24 hardcoded email checks → удалить). Один `requireAdmin` всегда checking `role='admin'` через адрес `ADMIN_EMAIL` env. | Закрывает K1 — fragile inline-checks. | 30 мин кода + test |
| **S4** | **Активировать `recordFailedLogin` + `isLoginIpLocked`** в /api/auth/login и /api/auth/sms/verify-otp + admin-verify-code. | Закрывает M2 — brute-force protection. | 15 мин кода |
| **S5** | **Включить STT fallback chain** (Yandex → GPTunnel Whisper → OpenAI Whisper) в `transcribeRussianAudio`. Уже всё есть в коде, нужно убрать early return. | Audio-режим переживает Yandex outage. | 10 мин кода |
| **S6** | **5-й LLM fallback через GPTunnel OpenAI-compatible (GPT-4o-mini).** Защита от Anthropic ecosystem outage. | Закрывает 3.1А. | 30 мин кода |
| **S7** | **Phone-check: понизить rate-limit до 3/мин/IP** + добавить geo-block для phone из не-СНГ стран. Сейчас 5/мин (см. auth-sms:467) — нормально, но 3 строже. | Защита от phone-enumeration. | 5 мин кода |
| **S8** | **Express body limit 64KB** (или 32KB) для `/api/muza/chat`, `/api/auth/*` — public endpoints. Admin endpoints — оставить дефолт. | Закрывает K5. | 10 мин кода (per-route limit) |
| **S9** | **Concurrent-admin-session alert** (M5): hook в `requireAdmin` → если IP отличается от last_seen IP в существующих admin sessions → fire Telegram alert. | Закрывает M5 — stolen-token early detection. | 1 час кода |
| **S10** | **Rkb scan на VPS:** добавить cron-задачу 03:00 МСК которая делает `find / -mmin -1440 -type f -newer /tmp/last_audit_marker -path '/etc/*'` и шлёт diff в Telegram админу. | Audit trail для системных правок. | 30 мин Босса + cron |

### 5.2 Среднее плечо — 1-2 недели

| # | Что | Эффект |
|---|---|---|
| **M1** | **Secrets vault.** Перевести все секреты в sops + age-encrypted `secrets.yaml` в репо (зашифровано), на проде decrypt через `sops -d` в startup-скрипте. Тогда даже если VPS compromised, секреты — encrypted at rest. | Закрывает K2 |
| **M2** | **Automated key rotation flow.** Web admin UI с кнопкой «Ротировать GPTUNNEL_API_KEY» → запрос email-2FA → admin вводит новый ключ → sed + pm2 restart + verify через `/admin/v304/api-keys/health` → audit-log. Без SSH. | Закрывает K4 |
| **M3** | **TOTP 2FA для admin** в дополнение к email-2FA. `otplib` + Google Authenticator. | Закрывает M3 |
| **M4** | **Robokassa + alternate payment** (ЮKassa или CloudPayments). Один сервис может зашуметь, фейл одного → второй продолжает. | Resilience платежей |
| **M5** | **Alternate SMS-провайдер** (SMSC + Devino + SMSAero) с auto-failover. | Resilience регистрации |
| **M6** | **Per-Bearer rate-limit** (M5 → L5) — счётчик per (userId, IP), не только per IP. | Закрывает L5 |
| **M7** | **Admin session ротация:** автоматический logout админа после 24 часов inactivity. Сейчас sessions живут вечно. | Reduces token-leak window |
| **M8** | **PII redaction в pm2 logs.** Logger wrapper который маскирует emails, phones, names в `console.log`. | Закрывает L1 |
| **M9** | **`kick_all_admin_sessions` tool** + `kick_all_user_sessions(userId)` tool. | Закрывает M1 (SESSION_SECRET ротация) |
| **M10** | **Strict CSRF mode для всех POST /api/*** (после недели наблюдений в WARN-режиме). | Закрывает M7 |

### 5.3 Долгое плечо — 1-3 месяца

| # | Что | Эффект |
|---|---|---|
| **L1** | **Migrate to PostgreSQL** (v305 plan в `ANSWERS.md`). SQLite single-file = backup catastrophe risk. | Долгосрочная надёжность |
| **L2** | **Web Application Firewall (Cloudflare / Yandex WAF).** Блокировка bot-traffic на уровне CDN, rate-limit per-country. | DDoS resilience |
| **L3** | **Multi-VPS deployment.** Один VPS — single failure point. ProD + secondary VPS с replicated SQLite (через Litestream → S3 backup). Auto-failover через DNS. | Disaster recovery |
| **L4** | **GDPR / personal-data compliance audit.** Сейчас храним: phone, email, IP, country. Нужны: privacy policy update, data export endpoint для юзера, hard-delete pipeline (`Admin-everything-except-delete rule` уже описан). | Юридическая защита |
| **L5** | **SOC 2 lite — security baseline.** Документация security policies, log retention policy (сейчас pm2 logs неограниченно), incident response playbook. | Trust signals для корп клиентов |
| **L6** | **LLM model diversification:** добавить TimeWeb Cloud AI (свой Llama 3 Russian), Yandex GPT (через folder + API key), как полностью независимые от Anthropic options. | Long-term LLM independence |
| **L7** | **Encrypted backups** SQLite → ежедневный snapshot → S3-compatible (Selectel / Yandex Object Storage) с age-encryption. Если VPS целиком потерян (диск, провайдер блок) — данные восстанавливаются за 30 мин. | Disaster recovery |

---

## 6. ТОП-5 ДЕЙСТВИЙ ПРЯМО СЕЙЧАС

Приоритет — по критичности × urgency. С готовыми командами для Босса (там где не требует моих code-changes).

### 6.1 🥇 Backdoor scan VPS (S1)

После 2-х чужих SSH-сессий сегодня. **Делать первым** — пока не убедились что нет persistent access, остальные правки бессмысленны.

```
ssh root@31.130.148.107 'apt install -y rkhunter chkrootkit && rkhunter --update && rkhunter --check --skip-keypress 2>&1 | tail -60 && chkrootkit 2>&1 | grep -v "not found\|nothing detected" | head -30 && echo "--- recent cron changes ---" && find /etc/cron.* /var/spool/cron -mmin -10080 -type f 2>/dev/null && echo "--- recent systemd ---" && find /etc/systemd/system -mmin -10080 -type f 2>/dev/null && echo "--- users ---" && awk -F: "($3>=1000)&&($3<65534){print}" /etc/passwd && echo "--- auth_keys ---" && for u in $(awk -F: "($3>=0)&&($3<65534){print $1}" /etc/passwd); do echo "[$u]"; sudo -u $u cat ~$u/.ssh/authorized_keys 2>/dev/null; done && echo "--- recent ssh ---" && last -20 -F'
```

**Ожидаемый вывод:** `rkhunter` — нет warnings, `chkrootkit` — `nothing detected`, нет новых cron/systemd за последнюю неделю, только expected users, только наши SSH keys, last — только Босс.

Если есть **что-то непривычное** — копируй сюда, разбираемся вместе.

### 6.2 🥈 Включить email (S2)

После 6.1. Без email — admin-2FA сломан, lockout-риск.

```
ssh root@31.130.148.107 'sed -i "/^GMAIL_USER=/d; /^GMAIL_APP_PASSWORD=/d" /var/www/neurohub/.env && echo "GMAIL_USER=egnovoselov@gmail.com" >> /var/www/neurohub/.env && echo "GMAIL_APP_PASSWORD=🔴ВПИШИ_16_СИМВОЛОВ_БЕЗ_ПРОБЕЛОВ🔴" >> /var/www/neurohub/.env && chmod 600 /var/www/neurohub/.env && pm2 restart neurohub --update-env'
```

Где 🔴ВПИШИ_16_СИМВОЛОВ_БЕЗ_ПРОБЕЛОВ🔴 — Gmail app password из https://myaccount.google.com/apppasswords (формат: `xxxx xxxx xxxx xxxx` → **убрать пробелы**, оставить 16 символов).

Verify через https://muzaai.ru/api/admin/v304/email-test (admin Bearer required).

### 6.3 🥉 Ротация SSH ключей VPS

После сегодняшних чужих сессий + leak root-password. Старые ключи скомпрометированы.

```
# Локально (на устройстве Босса):
ssh-keygen -t ed25519 -f ~/.ssh/muzaai_vps_v2 -N "" -C "muzaai-vps-$(date +%Y%m%d)"

# Скопировать новый pub-key на VPS (используя ТЕКУЩИЙ доступ):
ssh-copy-id -i ~/.ssh/muzaai_vps_v2.pub root@31.130.148.107

# Удалить старый authorized_keys (на VPS):
ssh root@31.130.148.107 'cp /root/.ssh/authorized_keys /root/.ssh/authorized_keys.bak.$(date +%s) && grep -v "OLD_KEY_PATTERN" /root/.ssh/authorized_keys.bak.* > /root/.ssh/authorized_keys && chmod 600 /root/.ssh/authorized_keys'

# Verify новый key работает:
ssh -i ~/.ssh/muzaai_vps_v2 root@31.130.148.107 'echo OK'

# В Termius — обновить ssh-config на новый ключ.
```

### 6.4 4️⃣ Включить fail2ban + harden sshd

```
ssh root@31.130.148.107 'apt install -y fail2ban && cat > /etc/fail2ban/jail.d/sshd.local <<EOF
[sshd]
enabled = true
maxretry = 3
findtime = 600
bantime = 3600
EOF
systemctl restart fail2ban && fail2ban-client status sshd'
```

И в `/etc/ssh/sshd_config` убедиться:
```
PasswordAuthentication no
PermitRootLogin prohibit-password
```

(после изменения — `systemctl reload sshd`, и **проверь что текущая сессия не разорвалась** перед logout).

### 6.5 5️⃣ Дать команду включить code-fixes (S3 + S4 + S5 + S6)

После 6.1-6.4 — позвать меня и сказать «реализуй S3, S4, S5, S6». Это короткий код-патч (~2 часа моей работы), без сложной архитектуры. Закроет K1, M2 и сделает Музу resilient к Yandex/Anthropic outage.

---

## Заключение

**Главное** — после сегодняшних инцидентов (leak password + 2 чужих сессий) **первоочередная задача = backdoor scan + ротация SSH ключей**, до всех остальных code-fixes. Атакующий с persistent access делает любые наши security improvements бесполезными.

**Архитектурно** — Муза и MuzaAi устойчивы на уровне приложения, но **зависят от одного канала per service** (один Anthropic ecosystem, один Yandex для STT/TTS, один SMS.ru, один Gmail, один GPTunnel→Suno). При outage любого — соответствующая функциональность падает. Добавление 2-х альтернатив на каждый critical service = первоочередной долг.

**Секреты** — главный системный риск. Все хранятся plain на VPS. Любой compromise = total compromise. Vault (sops/age) — на следующие 2 недели.

**Admin panel** — хорошая защита (requireAdmin + email-2FA + audit-log + filterToolsForRole), но `authMiddleware` + hardcoded email на 14 endpoint'ах — fragile.

**Муза LLM** — отличная архитектура (cross-channel, tool-use, filterByRole), но degraded mode при Anthropic-outage (TimeWeb без tools). Добавить 5-й fallback через GPTunnel OpenAI = быстрый win.

После выполнения 5 топ-приоритетов — пересмотрим этот аудит за ужином, обновим план.

---

_Eugene Босс — этот аудит read-only, никакого кода не тронуто. Если согласен с топ-5 — даём знак, начинаю с S3/S4/S5/S6 (мой код), а 6.1-6.4 (твоя SSH-часть) — параллельно._

_🕐 2026-05-17 02:14 MSK_
