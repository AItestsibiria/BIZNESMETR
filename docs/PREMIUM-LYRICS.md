# Premium Lyrics — 4-step refinement pipeline

**Eugene 2026-05-24** — реализация качественной генерации лирики для подписчиков premium-tier `text_quality` и one-off покупки 149 ₽.

Real Anthropic fine-tuning публично закрыт. Этот pipeline даёт quality up через prompt engineering + последовательное self-refinement, без необходимости в собственной модели.

---

## Что это даёт

Стандартная генерация лирики (`/api/lyrics/generate`, 99 ₽) — один LLM-вызов → готовый текст. Иногда содержит клише, рваный ритм, плоские эмоции. Хорошо, но не WOW.

Premium-pipeline (`/api/lyrics/premium-generate`, 149 ₽ или подписка 299 ₽/мес) — четыре последовательных LLM-вызова:

| # | Шаг | Что делает |
|---|-----|------------|
| 1 | **Draft** | Первый набросок 12-16 строк по описанию + стилю + настроению |
| 2 | **Critique** | Самокритика — ищет ровно 3 слабых места (клише, рваный ритм, плоские эмоции) |
| 3 | **Refine** | Переписывает текст целиком, исправляя найденные проблемы |
| 4 | **Polish** | Финальная проверка размера, рифмы, структуры [Куплет/Припев/Бридж] |

На каждом шаге используется LLM-цепочка `callDeepSeek → callTimeWebGateway → Anthropic chain` (см. `lib/llmCore.ts`). DeepSeek первый — самый дешёвый. Если step падает — graceful degrade, возвращаем лучший доступный draft с пометкой `error` в response.

---

## Economics

### Наша стоимость

| Шаг | LLM | Input tokens | Output tokens | Cost (DeepSeek) |
|---|---|---|---|---|
| Draft | DeepSeek | ~600 | ~400 | ~$0.0006 |
| Critique | DeepSeek | ~800 | ~300 | ~$0.0006 |
| Refine | DeepSeek | ~1200 | ~500 | ~$0.001 |
| Polish | DeepSeek | ~900 | ~500 | ~$0.0008 |
| **Итого** | | | | **~$0.003 (~0.30 ₽)** |

При fallback на Anthropic Haiku (если DeepSeek/TimeWeb упали): ~$0.012 (~1.20 ₽) — всё равно <1% от выручки.

### Revenue

- **One-off:** 149 ₽ → маржа ~99%+
- **Подписка `text_quality`:** 299 ₽/мес — рентабельна с **~2 драфтов в месяц**. У активных авторов обычно 5-20 драфтов → отличная LTV.

### Сравнение с standard

| | Standard 99 ₽ | Premium 149 ₽ |
|---|---|---|
| LLM-вызовов | 1 | 4 |
| Метафоры | базовые | свежие, без клише |
| Ритм | как получится | проверенный 5-8 слогов/строка |
| Структура | [Куплет][Припев] | + полировка тэгов и рифм |
| Эмоция | плоская | конкретные детали, не общие слова |
| Время генерации | ~3 сек | ~10-15 сек |

---

## API endpoints

### `POST /api/lyrics/premium-generate` (auth required)

**Request body:**
```json
{
  "prompt": "песня маме на 70 лет — про её доброту, рыбалку с папой и крепкие чай",
  "genre": "pop",           // или style
  "mood": "warm",
  "language": "ru",
  "important_words": ["мама", "70", "рыбалка"]  // optional, до 12 элементов
}
```

**Response (success):**
```json
{
  "id": 12345,
  "lyrics": "[Куплет 1]\nТвой смех светлей чем рассвет...\n...",
  "balance": 35100,
  "iterations": 4,
  "steps_used": ["draft", "critique", "refine", "polish"],
  "viaSubscription": false,
  "chargedKopecks": 14900
}
```

**Response (insufficient funds, no subscription):**
```json
{
  "message": "Premium-текст стоит 149 ₽. Ваш баланс: 50 ₽. Пополните или оформите подписку «Премиум-качество текста» (299 ₽/мес — безлимит).",
  "needsTopup": true,
  "tariff": "premium_lyrics_oneoff",
  "priceKopecks": 14900
}
```

**Response (graceful degrade if some step failed):**
```json
{
  "id": 12345,
  "lyrics": "<draft без полного refinement>",
  "iterations": 2,
  "steps_used": ["draft", "critique"],
  "error": "Refine-шаг недоступен — выдан draft + critique без переписи."
}
```

### `GET /api/lyrics/premium-status` (auth required)

```json
{
  "hasSubscription": true,
  "expiresAt": "2026-06-23T12:00:00.000Z",
  "oneoffPriceKopecks": 14900,
  "oneoffPriceLabel": "149 ₽",
  "subscriptionMonthlyKopecks": 29900,
  "subscriptionMonthlyLabel": "299 ₽/мес"
}
```

---

## Subscription activation flow

1. Юзер пишет Музе в чате: «оформи подписку на премиум-тексты»
2. Музa вызывает `issue_invoice({ tariff: "premium_text_quality", description: "Подписка Премиум-качество текста" })`
3. Юзер получает invoice URL → переходит → Robokassa redirect → оплачивает 299 ₽
4. Robokassa Result callback в `routes.ts` ловит `TARIFF_TO_TIER['premium_text_quality']` → `{ tier: 'text_quality', days: 30 }`
5. INSERT/UPDATE в `premium_subscriptions` с `status='active'`, `expires_at = now + 30d`
6. Следующий `/api/lyrics/premium-generate` для этого юзера → бесплатно, audit-log `via=subscription`

При повторной оплате — `expires_at` продлевается (`max(existing, now) + 30d`), не сбрасывается.

---

## Pricing register (Pricing-single-source rule)

Все цены централизованы в `apps/neurohub/server/routes.ts`:

```ts
const PRICES = {
  lyrics: 9900,                  // 99 ₽
  premium_lyrics_oneoff: 14900,  // 149 ₽
  music: 39900,                  // 399 ₽
  cover: 9900,                   // 99 ₽
};

const PREMIUM_TIERS = {
  text_quality: { monthly_kopecks: 29900, days: 30 },  // 299 ₽/мес
  voice_messages: { monthly_kopecks: 19900, days: 30 },
};

const TARIFF_TO_TIER = {
  premium_voice_msg: { tier: "voice_messages", days: 30 },
  premium_text_quality: { tier: "text_quality", days: 30 },
};
```

И в `apps/neurohub/server/lib/muzaTools.ts` `issue_invoice` TARIFFS:

```ts
premium_text_quality: { amountRub: 299, tariffKey: "premium_text_quality" },
premium_lyrics_oneoff: { amountRub: 149, tariffKey: "premium_lyrics_oneoff" },
```

При изменении цен — обновить **все** места + KB + persona prompt (см. Pricing-single-source rule в CLAUDE.md).

---

## UI

### Toggle на `/lyrics` page

Checkbox-card между form-fields и кнопкой «Создать текст»:

```
[ ] ✨ Премиум-качество текста   [+149 ₽] [как работает]
    4-этапное улучшение: Draft → Critique → Refine → Polish.
    Ярче метафоры, точнее под настроение, без штампов.
```

При активной подписке — badge `[Включено в подписку]` (emerald) вместо цены.

При клике «как работает» — modal с описанием 4 шагов + опцией подписки.

При активном toggle — кнопка меняется: «✨ Создать премиум-текст — 149 ₽» (или «Создать премиум-текст (подписка)»).

В результате — badge `[✨ premium: draft→critique→refine→polish]` в заголовке «Результат».

---

## Safeguards

- **Refund при ошибке pipeline** — обязателен по правилу «Refund при ошибке» (см. CLAUDE.md). Если LLM-цепочка вернула null/error — `storage.refundGeneration` + ответ `refunded: true`.
- **Sanity hard limit 400 символов** — даже premium-pipeline иногда даёт длиннее, обрезаем по последней целой строке.
- **Graceful degrade** — если хоть один шаг недоступен, возвращаем лучший доступный результат (НЕ refund если шаг 1 успешен, юзер всё равно получил value).
- **Audit-log** — каждая операция → `recordAuditEntry` с entity `premium_lyrics_oneoff` или `premium_lyrics_subscription`. Босс видит в `/admin/v304 → audit-log`.
- **Ownership check** — `authMiddleware` гарантирует `userId`. `gen.userId === userId` гарантировано через `storage.createGeneration({ userId, ... })`.

---

## Связано с CLAUDE.md правилами

- **Pricing-single-source rule** — все цены через `PRICES` + `PREMIUM_TIERS` + `TARIFF_TO_TIER` + `muzaTools.ts TARIFFS`.
- **Premium voice-messages rule** — pattern для tier-based premium features (`audio_premium_only` → `text_quality` tier).
- **Reuse-working-solutions rule** — endpoint обёртка над `storage.createGeneration` + `refundGeneration` + `callDeepSeek` + `saveGenFiles` (не создаём параллельные).
- **Backup-before-edit rule** — audit-log per operation.
- **Musa-knowledge-governance rule** — info доступна всем юзерам (это feature, не админ-инсайд), Music может предложить подписку через `issue_invoice`.

---

## Future extensions

- **Premium-кавер** (`tier='cover_quality'`) — аналогичный 4-step refinement для cover-image prompts
- **Premium-аудио** (`tier='audio_quality'`) — re-generation с другим voice/style без доп. оплаты
- **Combo-подписка** (`tier='pro'`) — все три premium-feature за 599 ₽/мес
