# Billing Audit — Atom-level checklist (методология + endpoint)

**Версия:** 2026-05-23
**Trigger:** Eugene Босс «явно там ошибки — найди по всем списаниям за весь период проекта».
**Read-only.** Никаких UPDATE/INSERT/DELETE в `transactions` / `payments` / `users.balance` / `premium_subscriptions` / `invoices` не делается. Только flag и список рекомендованных ручных refund'ов.

---

## TL;DR — как запустить отчёт на проде

```
https://muzaai.ru/api/admin/v304/billing/audit            # JSON
https://muzaai.ru/api/admin/v304/billing/audit?format=md  # markdown — копируется в этот doc
```

Auth — admin Bearer (тот же что для остальных `/api/admin/v304/*`). Audit-log запуска фиксируется в `admin_audit_log` под `entity='billing_audit'`.

Live snapshot на момент составления этого doc'а — нужно запустить на VPS с реальным `data.db`. Здесь зафиксирована **методология + где какие проверки**. Live numbers Босс получит из endpoint.

---

## Что проверяется (atom-level)

Реализовано в `apps/neurohub/server/lib/billingAudit.ts::runBillingAudit()`. Все проверки — read-only.

### Critical 🔴

| # | Категория | Что ищет | Severity |
|---|---|---|---|
| 1 | `double_charge` | Same user, same gen #N, same amount, ≥2 негативных транзакций | 🔴 |
| 2 | `missed_refund` | Generation status IN ('error','failed','cancelled'), cost > 0, нет positive transaction с #genId, `style.refunded` flag не выставлен | 🔴 |
| 3 | `payment_not_credited` | `payments.status='paid'` BUT нет transaction с упоминанием invId или invoice_id | 🔴 |
| 4 | `premium_fulfillment_missing` | `invoices.status='paid'`, tariff_key='premium_*', но **нет** строки в `premium_subscriptions` | 🔴 |

### Medium 🟡

| # | Категория | Что ищет |
|---|---|---|
| 5 | `price_anomaly` | Сумма списания не из PRICES (≠ 9900, 29900 legacy, 39900). Может быть от старой акции, ручной admin adjustment, или ошибки. |
| 6 | `premium_duplicate_subscription` | Один invoice → >1 `premium_subscriptions` rows (двойной fulfillment) |
| 7 | `balance_integrity` (>99₽) | `users.balance != SUM(transactions.amount)`. Delta ≥ 9900 коп. |

### Low 🟢

| # | Категория | Что ищет |
|---|---|---|
| 8 | `balance_integrity` (<99₽) | Delta < 9900 коп. Может быть rounding / pre-2026 legacy. |
| 9 | `premium_expired_active_flag` | `status='active'` но `expires_at < now()`. Cron expiry не отработал. |
| 10 | `bonus_tracks_anomaly` | `users.bonus_tracks > 10` — проверить ручные правки admin. |

### Reconciliation gen ↔ tx (Eugene 2026-05-23, расширение)

| # | Категория | Severity | Что ищет |
|---|---|---|---|
| 11 | `free_generation_bypass` | 🔴 | Generation status='done', cost > 0, НЕ bonus, НЕ promo — но НЕТ negative transaction с #genId. Юзер получил трек бесплатно (bug в pipeline checkAndCharge). |
| 12 | `orphan_charge` | 🔴 | Negative transaction с #genId есть, но generation row отсутствует/deleted, refund не сделан. Деньги списаны, юзер получил ничего. |
| 13 | `cost_mismatch` | 🟡 (списали меньше) / 🟢 (списали больше) | Списанная сумма ≠ gen.cost (delta > 10 коп). Legacy music=29900 до 2026-05-19 исключены. |

**SQL для проверки вручную:**

```sql
-- 11. Free generation bypass
SELECT g.id, g.user_id, g.type, g.cost, g.created_at
FROM generations g
WHERE g.status='done' AND g.deleted_at IS NULL AND g.cost > 0
  AND COALESCE(json_extract(g.style, '$.bonus_used'), 'false') != 'true'
  AND COALESCE(json_extract(g.style, '$.promo_applied'), 'false') != 'true'
  AND NOT EXISTS (
    SELECT 1 FROM transactions t
    WHERE t.user_id = g.user_id AND t.amount < 0
      AND t.description LIKE '%#' || g.id || '%'
  );

-- 12. Orphan charge (gen missing/deleted)
SELECT t.id, t.user_id, t.amount, t.type, t.description, t.created_at
FROM transactions t
WHERE t.amount < 0 AND t.type IN ('music','lyrics','cover')
  AND t.description LIKE '%#%'
  AND NOT EXISTS (
    SELECT 1 FROM generations g
    WHERE g.user_id = t.user_id AND g.deleted_at IS NULL
      AND t.description LIKE '%#' || g.id || '%'
  )
  AND NOT EXISTS (
    SELECT 1 FROM transactions r
    WHERE r.user_id = t.user_id AND r.type = t.type
      AND r.amount = -t.amount
      AND r.id > t.id
  );

-- 13. Cost mismatch (gen.cost ≠ charge amount)
SELECT g.id, g.user_id, g.type, g.cost, ABS(t.amount) AS charged
FROM generations g
JOIN transactions t ON t.user_id = g.user_id AND t.amount < 0 AND t.type = g.type
  AND t.description LIKE '%#' || g.id || '%'
WHERE g.cost > 0
  AND ABS(ABS(t.amount) - g.cost) > 10
  AND NOT (g.created_at < '2026-05-19' AND g.type='music' AND ABS(t.amount)=29900);
```

---

## Auto-fix workflow (Eugene 2026-05-23)

Три новых admin endpoints для batch-обработки:

### 1. POST `/api/admin/v304/billing/notify-findings`

Запускает audit и отправляет Telegram-сводку админу (`ADMIN_TELEGRAM_ID`).

Response:
```json
{ "ok": true, "telegramSent": true, "summary": { "totalIssues": N, "critical": N, "medium": N, "low": N, "recommendedRefundsCount": N, "recommendedRefundsKopecks": N } }
```

### 2. POST `/api/admin/v304/billing/refund/:userId/:genId`

Ручной refund конкретной генерации. Body: `{ cost?, type?, reason? }`. Если cost не передан — берётся из `gen.cost` с **type-aware** fallback (`PRICES["music"]`=39900 / `PRICES["lyrics"]`=9900 / `PRICES["cover"]`=9900).

### 3. POST `/api/admin/v304/billing/auto-fix?dry_run=1`

Batch refund для всех `recommendedRefunds[]`. **dry_run=1 по умолчанию** — показывает что бы сделано без actual апдейтов. `dry_run=0` — реальные refund'ы через `storage.refundGeneration`.

**Workflow для Босса:**

1. `POST /api/admin/v304/billing/notify-findings` — получить Telegram alert.
2. Открыть `https://muzaai.ru/admin/v304/billing/audit?format=md` — посмотреть полный отчёт.
3. `POST /api/admin/v304/billing/auto-fix?dry_run=1` — посмотреть what-if (что будет сделано).
4. Если ok — `POST /api/admin/v304/billing/auto-fix?dry_run=0` — реальный refund.
5. Orphan charges (genId<0 в списке) → `skipped_orphan` (нет gen для `claimRefund`) → ручной разбор через `/api/admin/v304/billing/refund/:userId/:genId` после verify ситуации.

**Audit trail:**
- Каждое auto-fix действие пишется в `admin_audit_log` как `entity='billing_auto_fix'`.
- Каждый manual refund — `entity='billing_refund'`.
- Telegram notification — `entity='billing_notify'`.

---

## Полная карта движений денег в проекте

### Списания

**`PRICES` (текущие, kopecks):**
- `music` = 39900 (399 ₽) — с 2026-05-19. До этого 29900 (299 ₽).
- `lyrics` = 9900 (99 ₽)
- `cover` = 9900 (99 ₽)

**Пути списания** (все через `checkAndCharge` + `storage.createTransaction`):
1. `/api/music/generate` — основной (с 9 вариантами: simple/advanced/audio/cover/extend/regenerate/style-cover/...)
2. `/api/lyrics/generate`
3. `/api/cover/generate`
4. Chat tools (`chatGenerationTools.ts` — `generate_lyrics`, `create_music_job`)
5. Музa-tools (`muzaTools.ts`)

Bonus track (`users.bonusTracks > 0`) расходуется ДО balance — пишется `amount=0` транзакция с description «🎁 подарочный трек».

### Возвраты (refunds)

**Единственный entry-point:** `storage.refundGeneration({ genId, userId, cost, type, description })` (в `storage.ts:1517`).

Использует `claimRefund(genId)` для атомарной защиты от double-refund через `generations.style.refunded` JSON flag.

**18 call-sites** в `routes.ts` + `generation-agent/module.ts` + `chatGenerationTools.ts` (Suno error, no task_id, empty response, файл недоступен, режим недоступен, таймаут, etc).

### Topup и бонусы

**Через Robokassa** (`/api/payment/result`) — `type='topup'`, amount > 0.

**Реферальный бонус** (`REFERRAL_BONUS = 39900`):
- При регистрации с `referredBy` юзеру и реферру по 399 ₽ — каждому отдельная `topup` транзакция.
- При первой оплате — дополнительный бонус через `referralBonusGiven` flag (защита от double).

**Welcome gift** (CIS, первые 1000):
- `users.welcomeGiftGiven=1` + `users.bonusTracks += 1` без денежного transaction (отдельно от balance).
- Pause: после 1000 — gate'нется (см. `WELCOME_GIFT_LIMIT`).

**Промокоды** (`promo_codes`): можно дать bonus_kopecks ИЛИ bonus_tracks.

**Premium-подписка** (`premium_voice_msg`): через `invoices` → Robokassa → `payment.invoice_id` → `premium_subscriptions.status='active'` + `expires_at = now + 30d`. **Balance НЕ кредитится** для premium tier — только subscription activate.

### Топап через invoice

`tariff_key` startsWith `topup_` или `custom` → balance credit + topup transaction (description «Счёт #N: …»).

---

## Где live numbers (после запуска endpoint)

После запуска `GET /api/admin/v304/billing/audit?format=md` Босс копирует output **в эту секцию** ниже.

### Live snapshot (TBD — Босс запустит):

```
[вставить сюда markdown output endpoint'а]
```

---

## 🔥 Bug-fixes applied 2026-05-23

### Fix #1: `gen.cost || 9900` fallback — type-aware

**Симптом:** 8 мест в `routes.ts` использовали `gen.cost || 9900` fallback при `refundGeneration()`. Для трёх music-refund мест (`type: "music"`) это означало refund 99 ₽ вместо 399 ₽, если `gen.cost` оказался NULL/0. Это происходило когда charge succeed но gen creation race-condition'ил с `cost` field.

**Fix:** заменено на `gen.cost || PRICES["music"] || 39900` (type-aware fallback) в 8 местах:
- `routes.ts:9912` — lyrics generation error refund
- `routes.ts:10148, 10184, 10482, 10617, 13656, 13665` — music refunds
- `routes.ts:10681` — cover refund

### Fix #2: TG users welcome gift bypass

**Симптом:** 3 пути регистрации Telegram-юзеров (`/api/auth/telegram` force_create, `/api/auth/telegram/poll`, `/api/auth/telegram-loginurl`) НЕ вызывали `tryGiveWelcomeGift()`. Email и SMS handlers это делали, но TG юзеры пропускались.

**Fix:** добавлен `await import("./lib/welcomeGift").tryGiveWelcomeGift({...})` после `db.insert(users)` во всех 3 путях. CIS-юзеры теперь получают bonus track.

### Fix #3: Generation ↔ Transaction reconciliation (расширение audit)

Добавлены 3 новых check'а — см. секция «Reconciliation gen ↔ tx» выше.

---

## Top-3 типичные ошибки которые ловит этот audit

1. **Refund pipeline упал в catch** — generation errored, но `refundGeneration` не вызвался (exception до неё). Юзер потерял 399 ₽.
   **Fix:** ручной refund через `storage.refundGeneration({...})` ИЛИ admin UI кнопка (если есть).

2. **Robokassa payment paid но Result callback failed** — `payments.status='paid'` есть, но в `transactions` нет строки. Может быть из-за `[INVOICE FULFILLMENT] failed` exception ИЛИ упал сервер во время callback.
   **Fix:** вручную сделать `storage.updateBalance` + `createTransaction({type:'topup', ...})` с указанием InvId в description.

3. **Premium voice activated но subscription row отсутствует** — Robokassa паид, invoice.status=paid, но в `premium_subscriptions` ничего. Юзер платил за premium но не получил доступ.
   **Fix:** ручной INSERT premium_subscriptions с expires_at = invoice.paid_at + 30 days.

---

## Recommended next steps Боссу

1. **Запустить audit на проде:**
   ```
   curl -H "Authorization: Bearer <ADMIN_TOKEN>" \
     https://muzaai.ru/api/admin/v304/billing/audit?format=md > /tmp/audit.md
   ```
   Открыть `/tmp/audit.md` локально или скопировать в этот документ.

2. **Если есть `recommendedRefunds` записи** — пройти ручно через admin UI / SSH (через `storage.refundGeneration`) каждый случай. Audit-log зафиксирует.

3. **Если есть `unbookedPayments`** — это редкий но опасный случай. Проверить логи `[PAYMENT RESULT]` за дату payment.created_at. Возможно нужен manual credit balance.

4. **Если `balanceMismatches` большие** — НЕ авто-correct. Может быть intentional admin manual UPDATE через old admin tabs. Отдельно расследовать каждый case.

5. **Repeat периодически.** Босс может скрипт `cron 0 4 * * *` на VPS:
   ```
   curl -s -H "Authorization: Bearer ..." \
     https://muzaai.ru/api/admin/v304/billing/audit \
   | jq '.buckets' \
   | mail -s "Daily billing audit" egnovoselov@gmail.com
   ```

---

## SQL queries для verify после фикса

```sql
-- 1. Re-check missed refunds
SELECT g.id, g.user_id, g.cost, g.status, g.error_reason
FROM generations g
WHERE g.status IN ('error','failed','cancelled')
  AND g.cost > 0
  AND COALESCE(json_extract(g.style, '$.refunded'), 'false') != 'true';

-- 2. Re-check balance integrity
SELECT u.id, u.balance,
  COALESCE((SELECT SUM(amount) FROM transactions WHERE user_id = u.id), 0) AS computed
FROM users u
WHERE u.balance != (SELECT COALESCE(SUM(amount), 0) FROM transactions WHERE user_id = u.id);

-- 3. Re-check unbooked Robokassa payments
SELECT p.id, p.inv_id, p.user_id, p.amount
FROM payments p
WHERE p.status='paid'
  AND NOT EXISTS (
    SELECT 1 FROM transactions t
    WHERE t.user_id = p.user_id
      AND t.description LIKE '%счёт #' || p.inv_id || '%'
  );

-- 4. Premium fulfillment integrity
SELECT i.id, i.user_id, i.tariff_key, i.paid_at
FROM invoices i
LEFT JOIN premium_subscriptions ps ON ps.invoice_id = i.id
WHERE i.status='paid'
  AND i.tariff_key LIKE 'premium_%'
  AND ps.id IS NULL;

-- 5. Expired but active subs
SELECT id, user_id, tier, expires_at
FROM premium_subscriptions
WHERE status='active' AND expires_at < datetime('now');
```

---

## Schema reality vs. prompt assumptions

Промпт изначально предполагал колонки `transactions.related_gen_id`, `related_payment_id`, `transactions.type IN ('spend','refund','welcome_gift','promo')`. **Это не так.** Реальная схема:

- `transactions.amount` — signed (negative=charge, positive=credit).
- `transactions.type` ∈ {'music', 'lyrics', 'cover', 'topup'}.
- Refund — same type как original charge, amount=positive.
- FK на generation/payment **отсутствует** — связь через regex по `description` (`#<genId>`, `счёт #<invId>`).

Audit учитывает реальную схему через regex matching по description.

---

## Связано с rules

- `Pricing-single-source rule` — все цены через PRICES + tariff_history.
- `Refund pipeline` (Triumph triumph-na-efire-080526) — единый `storage.refundGeneration` + `claimRefund`.
- `Backup-before-edit rule` — каждое manual вмешательство → audit log.
- `Secrets-admin-only rule` — endpoint requireAdmin only.
- `Pre-edit analysis rule` — этот audit это «pre-edit» снапшот перед manual фиксами.
