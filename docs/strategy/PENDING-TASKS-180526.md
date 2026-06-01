# Pending tasks — 18.05.2026 00:42 MSK

**Назначение:** список нерешённых задач из контекста этой и предыдущих сессий. Собрано после двух дней audits (NIGHT + ACCESS-BYPASS) и стратегии MUZA-GOD-MODE.

**Источники:**
- `docs/strategy/TODO-NEXT-SESSION-170526.md`
- `docs/strategy/NIGHT-AUDIT-170526.md` §5 (roadmap) и §6 (top-5)
- `docs/strategy/ACCESS-BYPASS-AUDIT-170526.md` §7 (top-10)
- `docs/strategy/MUZA-GOD-MODE-180526.md` (новый план Музы)
- git stash list / git worktree list
- CLAUDE.md правила без code-implementation

---

## Категории

🔴 **Critical** — security / payment / production blockers
🟡 **Important** — UX features Босс просил
🟢 **Nice-to-have** — улучшения, не блокеры

---

## Сводный реестр задач

### 🔴 Critical

| ID | Title | Source | Status | Effort |
|---|---|---|---|---|
| C1 | **Backdoor scan VPS** — после 2-х чужих SSH-сессий 17.05 (rkhunter, chkrootkit, cron diff, authorized_keys audit) | NIGHT-AUDIT §6.1 | open, ждёт Босса | 30-60 мин Босса |
| C2 | **GMAIL_APP_PASSWORD пуст на проде** → admin-2FA email сломан, password reset не работает | NIGHT-AUDIT §6.2 + AUDIT-IT M8 | open, Босс вставляет 16 символов | 5 мин Босса |
| C3 | **Ротация SSH ключей VPS** — старые скомпрометированы leak'ом root-password | NIGHT-AUDIT §6.3 | open, Босс генерит новый ed25519 | 15 мин Босса |
| C4 | **fail2ban + sshd hardening** (Password=no, MaxRetry=3, ban 1h) | NIGHT-AUDIT §6.4 | open | 15 мин Босса |
| C5 | **Stream/Download access-check** — `/api/stream/:id`, `/api/download/:id`, `/api/track/:id` без auth → любой по угаданному ID скачает приватный трек | ACCESS-BYPASS §1.2 риск 1 | open | 30 мин кода |
| C6 | **Telegram webhook validation** — нет `X-Telegram-Bot-Api-Secret-Token` check → атакующий поддельные updates | ACCESS-BYPASS §1.2 риск 2 | open | 15 мин кода + Telegram setWebhook |
| C7 | **`sessions.token` без TTL и rotation** — Bearer = вечный доступ при leak | ACCESS-BYPASS §1.2 риск 3 | open | 1.5 часа (expires_at + refresh-flow + cron purge) |
| C8 | **Replace `authMiddleware` → `requireAdmin`** в 24 admin endpoints (удалить inline `if (user.email !== "egnovoselov@gmail.com")`) | NIGHT-AUDIT S3 / K1 | open | 30 мин кода + test |
| C9 | **`recordFailedLogin` не вызывается** — brute-force login без ban после 5 неудач | NIGHT-AUDIT S4 / M2 | open | 15 мин кода |
| C10 | **Anthropic ключ 403** (leaked → revoked провайдером) → primary LLM не работает | NIGHT-AUDIT §1 | Босс ротирует через console.anthropic.com → новый ключ → ssh sed + pm2 restart | 10 мин Босса |
| C11 | **Robokassa ключи `🔴ВСТАВЬ`** — платежи не работают | NIGHT-AUDIT §1 | open, Босс через partner.robokassa.ru | 10 мин Босса |
| C12 | **Phone-auth flashcall flow reverted** на classical (sms.ru звонит юзеру) — сейчас "reverse" и никто не звонит | TODO-170526 §1 | open | 1 час кода |
| C13 | **Phone-check endpoint** для auto-login existing user («Привет, Иван! С возвращением») | TODO-170526 §1 | open | 30 мин кода |
| C14 | **Direct-IP HTTP/HTTPS** обходит DNS-filtering — нужен `default_server return 444` в nginx | ACCESS-BYPASS §1.1 | open | 10 мин nginx config |
| C15 | **`SUNO_WEBHOOK_SECRET` derives from SESSION_SECRET** с literal `"fallback"` если env пуст → атакующий шлёт fake callback | NIGHT-AUDIT K6 | open | 5 мин кода (explicit throw) |

### 🟡 Important

| ID | Title | Source | Status | Effort |
|---|---|---|---|---|
| I1 | **Player controls в свайп-режим (CoverDetailsModal)** — play/pause, next/prev, repeat, volume | TODO-170526 §3 | open | 2-3 часа |
| I2 | **Registration phone — визуальное усиление** — «ЗВОНОК БЕСПЛАТНЫЙ» большим amber→cyan gradient, attention animation, btn-cosmic | TODO-170526 §2 | open | 2 часа |
| I3 | **Voice recording тестирование** — после `recorder.start(250)` + 800ms delay фикс — проверить на реальных устройствах | TODO-170526 §2 | open | 1 час Босса |
| I4 | **Cookies + IP geo profile (admin-only)** — `user_profiles` table, `/api/admin/v304/user-profile/:userId`, admin UI вкладка «👤 Профили авторов» | TODO-170526 §4 + CLAUDE.md | open | 4-6 часов |
| I5 | **Admin concurrent-session alert** — Telegram при втором IP в admin-сессии | CLAUDE.md правило + NIGHT-AUDIT M5 | open | 1 час |
| I6 | **STT fallback chain активировать** — Yandex → GPTunnel Whisper → OpenAI Whisper (код есть, early return блокирует) | NIGHT-AUDIT S5 | open | 10 мин |
| I7 | **5-й LLM fallback (GPT-4o-mini через GPTunnel)** — anti-Anthropic-outage | NIGHT-AUDIT S6 + MUZA-GOD-MODE | open | 30 мин |
| I8 | **MUZA-GOD-MODE Sprint A — KB infrastructure** (schema + folders + parser + chunker + embedder + watcher) | MUZA-GOD-MODE part 2 | open | 8-10 часов |
| I9 | **MUZA-GOD-MODE Sprint B — search_kb tool + admin UI вкладка** | MUZA-GOD-MODE part 2 + 7 | open | 6-8 часов |
| I10 | **MUZA-GOD-MODE Sprint C — per-user context tools + auto-inject** | MUZA-GOD-MODE part 3 + 7 | open | 3-4 часа |
| I11 | **MUZA-GOD-MODE Sprint D — proactive triggers (хлопки в ладоши)** | MUZA-GOD-MODE part 4 + 7 | open | 4-5 часов |
| I12 | **MUZA-GOD-MODE Sprint E — Persona reset (<5 KB core prompt)** | MUZA-GOD-MODE part 5 + 7 | open | 2 часа |
| I13 | **Дашборд drill-down на ВСЕХ кнопках** — каждая метрика → следующий уровень детализации | TODO-170526 §5 | open | 6 часов |
| I14 | **L1/L3 security завершить** — login 2FA, session security, deputy role (subagents упали на rate limit) | TODO-170526 §6 | open | 4 часа |
| I15 | **Body limit 64 KB на `/api/muza/chat`** + Zod max 8000 на userText | NIGHT-AUDIT K5 / S8 | open | 10 мин |
| I16 | **Phone-check rate-limit понизить до 3/мин/IP** + geo-block non-CIS phones | NIGHT-AUDIT S7 | open | 5 мин |
| I17 | **TOTP 2FA для админа** через otplib + Google Authenticator | NIGHT-AUDIT M3 | open | 1 час |
| I18 | **Alternate payment (ЮKassa или CloudPayments)** — резерв при сбое Robokassa | NIGHT-AUDIT M4 | open | 4-6 часов |
| I19 | **Alternate SMS-провайдер** (SMSC / Devino / SMSAero) с auto-failover | NIGHT-AUDIT M5 | open | 4-6 часов |
| I20 | **Audio-call регенерация при reverse-flashcall** (stash@{0} pending) | git stash | stashed, не катить пока | (см. stash) |

### 🟢 Nice-to-have

| ID | Title | Source | Effort |
|---|---|---|---|
| N1 | **PII redaction в pm2 logs** (logger wrapper) | NIGHT-AUDIT L1 / M8 | medium |
| N2 | **Cookie SameSite** для XSS | NIGHT-AUDIT L2 | low |
| N3 | **GPG signing commits** | NIGHT-AUDIT L3 | low |
| N4 | **Verify brain-export маскирует secrets** (grep "process.env" master-dashboard) | NIGHT-AUDIT L4 | low |
| N5 | **Per-Bearer rate-limit** (userId + IP) | NIGHT-AUDIT L5 / M6 | medium |
| N6 | **Voice-admin Content-Type whitelist** для audio uploads | NIGHT-AUDIT L6 | low |
| N7 | **kick_all admin tool** + force re-login после SESSION_SECRET rotation | NIGHT-AUDIT M9 | low |
| N8 | **Strict CSRF mode** через 1 неделю наблюдений | NIGHT-AUDIT M10 / M7 | low |
| N9 | **Streaming responses** (Claude Streams API + UI typing) | MUZA-GOD-MODE atom 8 | medium |
| N10 | **Retry button** в чате при fallback | MUZA-GOD-MODE atom 8 | low |
| N11 | **TTS fallback** на OpenAI TTS-1 (через GPTunnel) | MUZA-GOD-MODE atom 6 | low |
| N12 | **User-side voice picker** в floating-consultant (не только admin) | MUZA-GOD-MODE atom 6 | low |
| N13 | **PostgreSQL migration** (v305 план в ANSWERS.md) | NIGHT-AUDIT L1 | large |
| N14 | **WAF (Cloudflare / Yandex)** + per-country rate-limit | NIGHT-AUDIT L2 | medium |
| N15 | **Multi-VPS deployment + Litestream** | NIGHT-AUDIT L3 | large |
| N16 | **Encrypted backups (sops + S3)** | NIGHT-AUDIT L7 | medium |
| N17 | **Yandex GPT 6-й LLM fallback** | MUZA-GOD-MODE atom 1 | small |
| N18 | **User memories table** (долговременная память Музы про юзера) | MUZA-GOD-MODE atom 5 | medium |
| N19 | **Mode auto-detection** функция | MUZA-GOD-MODE part 5 | small |
| N20 | **Email + VK каналы** (S6 спринт по 06-PLUGIN-АРХИТЕКТУРА) | MUZA-GOD-MODE atom 4 | large |

---

## Stash + worktree состояние

### `git stash list`

```
stash@{0}: ROLLBACK-STASH-2026-05-17 — compact-modal + reverse-flashcall-text (НЕ катить пока)
  → contains compact-modal UI + текст для "reverse flashcall" подхода.
  → задача C12 (phone-auth) делается заново на classical flashcall — этот stash, видимо, drop'ится после C12.

stash@{1}: WIP on worktree-agent-admin-concurrent: e724e8e fix(security): удалить hardcoded TELEGRAM_BOT_TOKEN fallback (LEAK)
  → security fix внутри worktree agent-admin-concurrent.
  → можно merge'нуть в основную ветку отдельным PR.

stash@{2}: On claude/add-claude-documentation-OW5V7: orphan bot-channels tab — wait for subagent
  → новая admin вкладка для bot channels, оставлена в ожидании subagent.
  → I5 (Admin concurrent-session alert) — пересекается, проверить.
```

### `git worktree list` (relevant)

Активные agent worktrees (не locked, могут содержать готовую работу):

| Worktree | SHA | Что внутри |
|---|---|---|
| `agent-admin-concurrent` | e724e8e | C8 + Concurrent-admin-session alert + TELEGRAM_BOT_TOKEN leak fix |
| `agent-admin-concurrent-v2` | 1250693 | v2 итерация того же (более новая?) |
| `agent-dialogue-mode` | 360f26b | Voice continuous mode |
| `agent-domain-tracking` | c69aee4 | Visitor/UTM tracking? |
| `agent-global-period` | 8b9891e | Period-20-MSK rule (CLAUDE.md уже описано) |
| `agent-lockscreen-cover` | 7417d74 | id3 cover lock-screen (уже merge'нуто в main 1af7ea3) |
| `agent-muza-llm-fix` | aab6bda | Какой-то fix LLM, возможно TimeWeb или ключи |
| `agent-phone-auth` | 6ba768b | C12 / C13 — phone-auth classical flashcall? |
| `agent-player-controls` | 87206dd | I1 — player controls в swipe modal |
| `agent-player-voice` | dac5125 | Voice tools для player (уже merge 4b9561a) |
| `agent-published-at` | e40a197 | published_at (уже merge 60d9998) |
| `agent-support-button` | 7c666cc | Support button / escalation |
| `agent-user-profiles` | fbdf6e6 | I4 — user_profiles table |
| `agent-voice-context` | 589eda6 | Voice context injection (уже merge?) |
| `agent-voice-picker` | e600378 | Voice picker (уже merge e600378) |
| `agent-voice-revolution` | 24206f1 | Голос Музы крупное обновление |

**TODO для следующей сессии:** пройтись по каждому worktree и определить — что внутри merge'нуто в main, что ещё актуально, что устарело и worktree можно удалить.

50+ `agent-aXXXXXX` worktrees — locked, видимо результаты завершённых subagent jobs. Можно prune'нуть.

---

## ТОП-10 next-session pickup (по impact × low-effort)

Это «утром начни с этого». Сортировка: критичность × минимум усилий × максимум impact.

### 1. C10: Ротация Anthropic ключа (10 мин Босса)

Primary LLM Музы не работает. TimeWeb fallback есть, но без tools.
- https://console.anthropic.com/settings/keys → Create Key
- Команда из CLAUDE.md «Never-leak-secrets rule» §4

### 2. C2: Включить GMAIL_APP_PASSWORD (5 мин Босса)

Без email — admin-2FA сломан, lockout-риск.
- https://myaccount.google.com/apppasswords
- Команда: `ssh root@31.130.148.107 'sed -i "/^GMAIL_USER=/d; /^GMAIL_APP_PASSWORD=/d" /var/www/neurohub/.env && echo "GMAIL_USER=egnovoselov@gmail.com" >> /var/www/neurohub/.env && echo "GMAIL_APP_PASSWORD=🔴16СИМВОЛОВ🔴" >> /var/www/neurohub/.env && chmod 600 /var/www/neurohub/.env && pm2 restart neurohub --update-env'`

### 3. C1: Backdoor scan VPS (30-60 мин Босса)

После 2-х чужих SSH сессий — критично проверить persistent access.
- См. готовую команду в NIGHT-AUDIT §6.1.

### 4. C5: Stream/Download access-check (30 мин кода)

Любой угаданный ID = приватный трек скачан. Single largest user-facing security hole.
- Файлы: `routes.ts:6278` (`/api/stream/:id`), `routes.ts:4637` (`/api/download/:id`), `routes.ts:track/:id`
- Логика: если `generation.is_public === 0` (private) → требовать Bearer + `req.user.id === gen.userId` ИЛИ admin

### 5. C12 + C13: Phone-auth flashcall classical + phone-check (1.5 часа кода)

«Никто не звонит» — Босс сам сказал. Юзеры не понимают что им должны позвонить.
- `auth-sms/module.ts` — flip semantic
- New endpoint `/api/auth/phone-check`
- UI text «Сейчас вам позвонят с номера…»

### 6. C8 + C9: Replace authMiddleware → requireAdmin + recordFailedLogin (45 мин кода)

K1 (24 hardcoded email checks) + M2 (brute-force prot не работает).
- Этим закрывается сразу 2 audit-finding.
- Worktree `agent-admin-concurrent-v2` (1250693) **скорее всего** уже содержит это — проверить и merge.

### 7. C6: Telegram webhook validation (15 мин кода + 5 мин Telegram setWebhook)

`X-Telegram-Bot-Api-Secret-Token` header check. Без этого — fake updates.
- `setWebhook(url, secret_token=...)` через Telegram API.
- В webhook handler: `if (req.headers['x-telegram-bot-api-secret-token'] !== TELEGRAM_WEBHOOK_SECRET) return 403`.

### 8. I7: 5-й LLM fallback через GPTunnel GPT-4o-mini (30 мин)

Anti-Anthropic-outage. GPTunnel ключ уже есть, OpenAI-compatible API.
- Расширить `callUnifiedMuzaLLM` ещё одним блоком после TimeWeb.

### 9. I6: STT fallback chain активировать (10 мин)

Audio-режим переживает Yandex outage. Код уже есть, нужно убрать early return.
- `lib/transcribe.ts` — найти early return и убрать.

### 10. I8: MUZA-GOD-MODE Sprint A — KB infrastructure (8-10 часов)

Это самая большая user-visible новая фича. После security/quick wins — это next major investment.
- См. план в `MUZA-GOD-MODE-180526.md` §7 Sprint A.

---

## Notes для следующей сессии

1. **Прокачать каждый worktree:** прежде чем закрывать как «done», открыть, посмотреть diff vs main, отметить какой задаче соответствует, merge или drop.
2. **С stash@{0} (rollback-stash) и stash@{2} (orphan bot-channels)** — определить судьбу после C12 и I5 соответственно.
3. **C1-C4 (Backdoor + ротация SSH + email + fail2ban)** — это операции Босса, не кода. Я могу подготовить command-blocks но execute должен он.
4. **MUZA-GOD-MODE — отдельный фокусированный спринт.** Не мешать с security-fixes — это 27-35 часов sequential работы, нужно непрерывное окно.
5. **Если Босс хочет «начать с самого важного утром»** — пройтись по ТОП-10 в порядке списка. Первые 9 пунктов = ~3-4 часа суммарно (большая часть = руки Босса в Termius).

🕐 Создан 2026-05-18 00:42 MSK
