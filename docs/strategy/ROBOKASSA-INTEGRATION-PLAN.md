# Robokassa Integration Plan (MuzaAi)

**Eugene 2026-05-16.** Документ описывает текущее состояние интеграции Robokassa и план дозакрытия пробелов. Источники: исследование официальной документации (`docs.robokassa.ru/code-examples/`, `robokassa.com/content/podgotovka-sayta.php`) + перекрёстная проверка по широко-используемым библиотекам с открытым кодом (`hflabs/django-robokassa`, `artamonoviv/Robokassa-Pay`, `betsol/node-robokassa`).

Сайты `robokassa.com` и `docs.robokassa.ru` блокируют HTTP-доступ от non-browser клиентов (`403` на curl/WebFetch с любыми UA — anti-bot WAF). Поэтому первичный источник в этом плане — код производственных библиотек, реализация которых **подтверждена многолетним использованием**.

---

## 1. Endpoints (Robokassa side)

| Назначение | URL |
|---|---|
| Платёжная форма (test и prod — один и тот же endpoint) | `https://auth.robokassa.ru/Merchant/Index.aspx` |
| Альтернативная форма (JS-виджет) | `https://auth.robokassa.ru/Merchant/PaymentForm/FormMS.js` |

Test-режим переключается **не отдельным URL**, а параметром `IsTest=1` в payload и **отдельной парой технических паролей** в личном кабинете магазина (вкладка «Технические настройки» → секция «Тестовые пароли»). Если отправить `IsTest=1` с production-паролями — Robokassa вернёт ошибку 29.

Исторически был отдельный `test.robokassa.ru`. **Больше не используется** (см. activemerchant/offsite_payments#209).

---

## 2. Подпись (MD5, в верхнем регистре)

Алгоритм по умолчанию — **MD5**. Robokassa поддерживает SHA1/256/384/512 через параметр `Hash` (опционально). Подпись передаётся в `SignatureValue`. Сравнение — case-insensitive (нормализуем обе стороны в uppercase).

Custom-параметры пользователя **должны** начинаться с префикса `Shp_` (можно `shp_`/`SHP_` — но регистр сохраняется). Они:

1. **Передаются** в Robokassa как обычные query-параметры (`Shp_userId=42`).
2. **Возвращаются** Robokassa обратно в Result/Success/Fail callback'ах.
3. **Включаются в подпись** в формате `Shp_key=value`, **отсортированные алфавитно по ключу**, добавляемые **в конец** базовой строки через `:`.

### 2.1 Init signature (создание платежа, redirect к Robokassa)

```
md5( "MerchantLogin:OutSum:InvId:Password1[:Shp_a=...:Shp_b=...:...]" )
```

Пример (один extra-параметр `Shp_userId=42`):
```
MerchantLogin:OutSum:InvId:Password1:Shp_userId=42
```

### 2.2 Result URL signature (server-to-server callback от Robokassa)

```
md5( "OutSum:InvId:Password2[:Shp_a=...:Shp_b=...]" )
```

**Password2** (не Password1). Это разделение спроектировано чтобы init и result-handler работали с разными секретами — компрометация одного не давала полный доступ.

### 2.3 Success URL signature (юзера редиректят сюда после успеха)

```
md5( "OutSum:InvId:Password1[:Shp_a=...:Shp_b=...]" )
```

**Password1** (как и init). Отличается от Result URL.

### 2.4 Fail URL

Fail URL **подпись не присылает** — там только `OutSum`, `InvId`, `Culture`. Это значит fail-страницу нельзя верифицировать криптографически (Robokassa в принципе не подписывает). Доверять Fail URL для side-effects (например refund) нельзя — только для UI-уведомления.

---

## 3. Result URL — server-to-server webhook

После успешной оплаты Robokassa делает HTTP POST (`application/x-www-form-urlencoded`) на наш Result URL (настраивается в личном кабинете магазина). Параметры payload:

| Поле | Тип | Источник |
|---|---|---|
| `OutSum` | string | сумма с точкой `100.00` |
| `InvId` | integer | наш invoice ID |
| `SignatureValue` | string | MD5 (uppercase hex) от `OutSum:InvId:Password2[:Shp_...]` |
| `Shp_*` | strings | наши custom-параметры, переданные на init |

### Что вернуть Robokassa

Если подпись корректна И мы успешно записали оплату в свою БД — отвечаем `OK<InvId>` (без HTML-обёртки, plain text, статус 200). Например: `OK1042`.

Если ответ **не** в формате `OK<InvId>` или статус ≠ 200 — Robokassa считает callback failed и будет **повторять** с экспоненциальным backoff (часы → сутки). Это значит наш handler должен быть **идемпотентным** (если уже оплачен — снова вернуть `OK<InvId>`, не обрабатывать дважды).

### Жёсткие правила безопасности на Result handler

1. **Никогда** не доверять `OutSum` без проверки `SignatureValue` — иначе атакующий шлёт `OutSum=1000000` и кредитует юзеру миллион.
2. Сравнение подписи — через `crypto.timingSafeEqual` (не `===`). Иначе side-channel timing attack может постепенно угадать `Password2`.
3. **Не логировать** `Password2` ни в каком виде. Логируем только маскированную подпись и `InvId`.
4. **Идемпотентность по InvId** — двойной callback (retry от Robokassa или собственный) не должен дважды кредитить юзера. Реализуется через `payments.status='paid'` flag + UPDATE WHERE status='pending' (атомарно).
5. Не возвращать **подробности ошибок** в HTTP body — Robokassa их не читает, но в логах любого reverse-proxy они могут утечь.

---

## 4. Success URL — пользовательский редирект

Robokassa редиректит юзера на наш Success URL после оплаты. Параметры: `OutSum`, `InvId`, `SignatureValue` (подписан Password1, см. §2.3), `Culture`.

**Не путать с Result URL** — Success прилетает **в браузер пользователя** (можно подделать), Result — server-to-server (доверенный канал). Реальное зачисление денег — только через Result. Success — это просто UI «спасибо за оплату».

Минимум что должен делать handler: проверить подпись (Password1) → если ок и оплата уже зафиксирована через Result → показать UI «успех». Если Result ещё не пришёл (или подпись не совпала) → показать UI «оплата проверяется» с polling'ом на `/api/payments`.

---

## 5. Fail URL

Robokassa редиректит юзера на Fail URL при отказе от оплаты или ошибке. Параметры: `OutSum`, `InvId`, `Culture`. **Подписи нет** — Robokassa не подписывает Fail callback.

Поэтому Fail handler ничего НЕ должен менять в БД (status платежа управляется Result URL'ом или нашим TTL-крон). Только UI «оплата не прошла».

---

## 6. Env vars (текущая схема + дозакрытие)

| Имя | Что хранит | Где взять | Длина |
|---|---|---|---|
| `ROBO_MERCHANT_LOGIN` | login магазина (он же `MerchantLogin`) | partner.robokassa.ru → магазин → название | 4-32 символа |
| `ROBO_PASSWORD1` | технический пароль 1 (для подписи init + Success) | partner.robokassa.ru → Технические настройки | 8-32 символа |
| `ROBO_PASSWORD2` | технический пароль 2 (для подписи Result) | partner.robokassa.ru → Технические настройки | 8-32 символа |
| `ROBO_IS_TEST` | `"true"` (по умолчанию) или `"false"` — boolean флаг | conf | `true`/`false` |
| `ROBO_TEST_PASSWORD1` | тестовый пароль 1 (если `ROBO_IS_TEST=true`) | partner.robokassa.ru → тестовые настройки | 8-32 символа |
| `ROBO_TEST_PASSWORD2` | тестовый пароль 2 (если `ROBO_IS_TEST=true`) | partner.robokassa.ru → тестовые настройки | 8-32 символа |

**КРИТИЧНО:** в test-режиме (`IsTest=1`) подпись считается **тестовыми** паролями, а не production'ными. Если использовать production-пароли с `IsTest=1` — Robokassa вернёт `error 29` и юзер увидит «ошибка подписи». Текущий код использует один и тот же `ROBO_PASSWORD1/2` независимо от режима — это работает, **только если у магазина в кабинете test-пароли равны prod-паролям** (что плохая практика).

### Инконсистентность которая есть сейчас в репозитории

CLAUDE.md и часть плагинов (`api-health`, `suno-watchdog`) ссылаются на `ROBO_LOGIN`/`ROBO_PASSWORD_1`/`ROBO_PASSWORD_2` (с подчёркиванием). Реальный код в `routes.ts` читает `ROBO_MERCHANT_LOGIN`/`ROBO_PASSWORD1`/`ROBO_PASSWORD2` (без подчёркивания). Это два разных набора имён — `.env` должен содержать **оба варианта одновременно** до момента ручной выверки и нормализации. Иначе либо платежи (`routes.ts`) либо health-чек (`api-health`) будут видеть пустой ключ.

**Решение:** добавить `getRoboCreds()` helper, который читает оба варианта (sprint-level normalization идёт отдельной PR'ой — не ломаем prod в этом коммите).

---

## 7. Безопасность (чек-лист на review)

- [ ] `SignatureValue` сравнивается через `crypto.timingSafeEqual`, обе стороны в одном регистре, одинаковой длины
- [ ] `Password2` НЕ логируется (даже маскированно — длина выдаёт)
- [ ] Init signature использует `Password1`, Result — `Password2`, Success — `Password1`
- [ ] `Shp_*` параметры включены в подпись (alphabetical sort, `Shp_key=value` format)
- [ ] Idempotency: повторный POST на Result URL с тем же `InvId` не кредитует юзера дважды
- [ ] Result handler возвращает ровно `OK<InvId>` (no HTML, no JSON, status 200)
- [ ] Fail URL handler ничего не пишет в БД (нет подписи — нельзя доверять)
- [ ] Test mode: `IsTest=1` шлётся вместе с **тестовыми** паролями (иначе error 29)
- [ ] `payments` table содержит `inv_id UNIQUE` индекс (защита от дубликата)
- [ ] Webhook endpoint `/api/payment/result` whitelisted в `security-guard` (Origin-check skip) — **проверено** (✅)
- [ ] Все 4xx/5xx ответы на user-facing endpoint логируются через `logUserActionFailure` (см. user-action-failure registry rule)

---

## 8. Текущее состояние интеграции (audit)

### Что уже работает (`server/routes.ts:7458-7619`)

- ✅ `POST /api/payment/create` — создаёт invoice + redirect URL с подписью (Password1, `Shp_userId`)
- ✅ `POST /api/payment/result` — webhook, signature verification через `timingSafeEqual`, idempotency check, баланс кредитуется атомарно, реферальный бонус выдаётся атомарно
- ✅ `GET /api/payment/success` — редирект на `/#/payment/success`
- ✅ `GET /api/payment/fail` — редирект на `/#/payment/fail`
- ✅ `GET /api/payments` — история платежей юзера
- ✅ Frontend `client/src/pages/dashboard.tsx:2125` — кнопка «Пополнить баланс» с 4 номиналами (99/300/500/1000 ₽)
- ✅ `payments` table в схеме (`shared/schema.ts:104-113`) — `inv_id UNIQUE`, `status` enum, `robo_data` JSON
- ✅ `security-guard` whitelist для `/api/payment/result|success|fail`
- ✅ Transaction record на success (`storage.createTransaction({type: "topup"})`)

### Что НЕ закрыто (gaps)

1. **Success URL не верифицирует подпись** — `GET /api/payment/success` просто редиректит, не проверяя `SignatureValue`. Атакующий может подделать URL и показать юзеру fake «успех» без оплаты. Реальное зачисление идёт через Result URL — то есть деньги защищены, но **UI можно обмануть**, что усложнит саппорт-кейсы. **Fix:** добавить signature verification (Password1) + сверка с БД (`payments.status='paid'`) → если ок, показать success; если нет, показать «оплата проверяется».
2. **Test mode не различает пароли** — `ROBO_PASSWORD1/2` используется и в prod, и в test. Если в кабинете Robokassa test-пароли отличаются от prod (best practice) — test-callback'и будут падать с error 29. **Fix:** `ROBO_TEST_PASSWORD1/2` + выбор пары в зависимости от `ROBO_IS_TEST`.
3. **ENV inconsistency** — `ROBO_LOGIN` vs `ROBO_MERCHANT_LOGIN`, `ROBO_PASSWORD_1` vs `ROBO_PASSWORD1` (см. §6). **Fix:** `getRoboCreds()` helper, читающий оба варианта.
4. **Audit log на FAIL отсутствует** — если Robokassa прислала bad signature или payment not found — мы возвращаем 4xx, но `user_action_failures` не пишем. **Fix:** `logUserActionFailure({channel:'web', action:'robokassa_result', errorCode, ...})` в catch-ветках.
5. **Result URL не пишет в `incidents`** при системных ошибках (DB unreachable, etc) — только console.error. **Fix:** при 5xx → инцидент.
6. **Test-flow не задокументирован** — нет инструкции «как развернуть test-magazин и проверить полный цикл». **Fix:** §9 этого документа.
7. **`roboSignature(values, password)` — параметр `password` не используется** (он передаётся в `values[]`). Misleading signature. **Fix:** упростить до `roboSignature(values)` или явно использовать `password`.

---

## 9. Test flow (для prod cutover)

1. В `partner.robokassa.ru` → создать тестовый магазин ИЛИ переключить существующий в test-режим
2. В тестовых настройках магазина — задать `Result URL` = `https://muzaai.ru/api/payment/result` (или clone для проверки)
3. В `.env` на VPS: `ROBO_IS_TEST=true`, `ROBO_TEST_PASSWORD1=...`, `ROBO_TEST_PASSWORD2=...`
4. `pm2 restart neurohub --update-env`
5. Открыть `https://muzaai.ru/dashboard` (или `https://clone.muziai.ru/dashboard`) → «Пополнить баланс» → 99 ₽
6. На странице Robokassa выбрать «Тестовый платёж» → банковская карта (любой test PAN из Robokassa docs)
7. После оплаты:
   - Browser редиректит на `/api/payment/success` → `/#/payment/success`
   - Параллельно Robokassa делает POST на `/api/payment/result` → проверяем в pm2 logs `[PAYMENT RESULT] SUCCESS!`
   - В админке `/api/payments` — payment status `paid`
   - В кабинете юзера баланс пополнен
8. Для негативного теста — отменить платёж на странице Robokassa → проверить `/#/payment/fail` + payment status `pending` (не `failed` — у нас нет UPDATE через Fail URL, см. §5)
9. Для re-test — обнулить payment в БД руками или создать новый invoice

---

## 10. Production cutover

После прохождения test-flow + smoke на clone:

1. В личном кабинете Robokassa переключить магазин в production-режим (или создать отдельный prod-магазин)
2. Result URL = `https://muzaai.ru/api/payment/result` (НЕ clone)
3. Success URL = `https://muzaai.ru/api/payment/success`
4. Fail URL = `https://muzaai.ru/api/payment/fail`
5. В `.env` на prod VPS:
   - `ROBO_IS_TEST=false`
   - `ROBO_MERCHANT_LOGIN=<реальный login>`
   - `ROBO_PASSWORD1=<реальный prod пароль 1>`
   - `ROBO_PASSWORD2=<реальный prod пароль 2>`
6. `pm2 restart neurohub --update-env`
7. Сделать **один реальный тестовый платёж** на 1 ₽ собственной картой
8. Проверить полный цикл (Result + Success + транзакция в БД)
9. Если ок — открыть `/dashboard` для пользователей
10. Включить мониторинг Robokassa-кабинета на падение success-rate ниже 90%

---

## 11. Открытые вопросы для Босса

1. **Test-магазин уже создан в Robokassa или ещё нет?** Если нет — нужны test-credentials (login + 2 пароля) для test-режима на clone.
2. **На prod какой login используется сейчас** — `ROBO_MERCHANT_LOGIN` (как в коде) или `ROBO_LOGIN` (как в `api-health`)? Нужно сверить `.env` на VPS чтобы понять что реально работает.
3. **Какие категории платежей** добавить кроме «пополнение баланса» — подписка? покупка трека напрямую? B2B счета по реквизитам? Сейчас только topup.
4. ~~**Чек-онлайн (54-ФЗ)**~~ — **закрыто 2026-05-18 commit `feat(payments): IncCurrLabel + Receipt 54-ФЗ`.** Receipt параметр формируется автоматически через `buildReceipt()` (server/lib/robokassaMethods.ts) и попадает в подпись init по правилу: `Login:OutSum:InvId:Receipt:Password1[:Shp_*]`. По умолчанию используется СНО `npd` (самозанятый) и tax `none` — переопределяется через `LEGAL_SNO` / `LEGAL_DEFAULT_TAX` ENV.
5. ~~**Multi-currency**~~ — **закрыто 2026-05-18 commit `feat(payments): IncCurrLabel + Receipt 54-ФЗ`.** Поддержан выбор «карта / СБП» через `IncCurrLabel` (см. §12). Полноценная multi-currency (USD / EUR) пока не требуется.

---

## 12. Выбор способа оплаты — карта vs СБП (Eugene 2026-05-18)

### Что добавлено

- `apps/neurohub/server/lib/robokassaMethods.ts` — helper-модуль с:
  - `incCurrLabelFor(method)` — маппинг `'card' | 'sbp'` → значение `IncCurrLabel`. Дефолты: `BANK` для карты, `SBP` для СБП. Переопределяется через ENV `ROBO_LABEL_CARD` / `ROBO_LABEL_SBP` если у конкретного магазина alias другой.
  - `buildReceipt(sumRubles)` — формирует 54-ФЗ Receipt с одной позицией («Пополнение баланса MuzaAi»).
  - `receiptToParam(r)` — JSON.stringify + URL-encode (требование Robokassa «Фискализация», см. docs.robokassa.ru/fiscalization/).
- `apps/neurohub/server/lib/legalConfig.ts` — юридические реквизиты (ИНН/ОГРН/адрес/СНО) из ENV. Используется в Receipt + footer + страницах оферты/политики.

### Изменение в `/api/payment/create`

Принимает дополнительное поле в body:
```ts
{ amount: number, method?: 'card' | 'sbp' }
```

Алгоритм построения payload:

1. Формируется `Receipt` через `buildReceipt(sumRubles)`.
2. `receiptParam = encodeURIComponent(JSON.stringify(receipt))`.
3. Подпись init: `md5(MerchantLogin:OutSum:InvId:Receipt:Password1[:Shp_*])` — Receipt ВКЛЮЧАЕТСЯ в подпись между Password1 и Shp_*. (Источник: справка Robokassa «Фискализация» — «Значение должно быть URL-encoded перед использованием в строке для подсчёта подписи и перед отправкой в форме.»)
4. К Robokassa отправляется query: `MerchantLogin, OutSum, InvId, Description, SignatureValue, Email, Receipt=<encoded>, [IncCurrLabel=<BANK|SBP>], Shp_userId, [IsTest=1]`.

### IncCurrLabel — формат

- `card` → `IncCurrLabel=BANK` (universal alias группы банковских карт; покрывает Visa / MasterCard / МИР). У некоторых магазинов alias бывает `BANKOCEAN2` / `BANKOCEAN2R` — переопределяется через `ROBO_LABEL_CARD`.
- `sbp` → `IncCurrLabel=SBP` (Система Быстрых Платежей). У некоторых магазинов alias бывает `SBPB` — переопределяется через `ROBO_LABEL_SBP`.
- Если `method` не передан — `IncCurrLabel` НЕ добавляется (юзер выбирает на странице Robokassa).

**Узнать актуальные alias магазина:** `curl 'https://auth.robokassa.ru/Merchant/WebService/Service.asmx/GetCurrencies?MerchantLogin=<login>&language=ru'` → ищем в XML `<Currency>` с подписями.

### Result/Success/Fail handler — НЕ менялись

Receipt идёт ТОЛЬКО в init (Password1 signature). Result URL подписывает Robokassa Password2'м по тем же полям что и раньше (`OutSum:InvId:Password2[:Shp_*]`), Receipt туда не приходит. Обратная совместимость сохранена.

### Изменение в `payments` audit

В `payments.roboData` теперь пишется JSON `{ method, incCurrLabel, receipt }` на init — для дальнейшего сопоставления при разборе саппорт-кейсов. На Result-вебхуке поле перезаписывается полным `req.body` от Robokassa.

---

## 13. Правила сайта Robokassa — статус (Eugene 2026-05-18)

Требования собраны из справки `robokassa.com/content/connection/` (WebSearch 2026-05-18):

| Требование | Статус | Файл |
|---|---|---|
| Описание услуг с ценами | ✅ | `client/src/pages/landing.tsx` + `/templates` |
| Электронная почта и телефон в footer | ⚠️ partial | footer landing — есть только «Поддержка»; нужны телефон + ИНН (добавлено через `LEGAL_*`) |
| ИНН/ОГРН в подвале сайта | ⚠️ pending | будет в footer landing после заполнения `.env` `LEGAL_INN` / `LEGAL_OGRN` |
| Публичная оферта | ⚠️ pending | `/oferta` (заглушка существует только через `/terms` → `PrivacyPage` сейчас) |
| Политика обработки ПДн (152-ФЗ) | ✅ | `client/src/pages/privacy.tsx` |
| Политика возврата | ❌ missing | нет страницы `/refund` |
| Контакты (телефон + email + юр.адрес) | ❌ missing | нет страницы `/contacts` |

**Действие:** в коммите `feat(legal): oferta/refund/contacts pages` создаются 3 страницы + footer landing обновляется чтобы выводить ИНН/ОГРН/телефон из `legalConfig` и ссылки на новые страницы.

