# ЧЕКЛИСТ ПОДАЧИ В Robokassa
## Для внутреннего использования (не отправлять)

**Дата:** 18 мая 2026 г.

---

## ШАГ 1 — Заполнить placeholder'ы в документах

Перед отправкой Robokassa замени **все** красные маркеры `🔴ВПИШИ_ХХХ🔴` на реальные значения:

В файлах:
- `01-oferta.md`
- `02-privacy.md`
- `03-refund.md`
- `04-description.md`
- `05-contacts.md`

Что вписать:
- [ ] `🔴ВПИШИ_ИНН🔴` — твой ИНН (12 цифр для ИП)
- [ ] `🔴ВПИШИ_ОГРНИП🔴` — ОГРНИП (15 цифр)
- [ ] `🔴ВПИШИ_АДРЕС🔴` — юр. адрес регистрации (полностью с индексом)
- [ ] `🔴ВПИШИ_ФАКТИЧЕСКИЙ_АДРЕС🔴` — фактический адрес (может совпадать)
- [ ] `🔴ВПИШИ_ТЕЛЕФОН🔴` — контактный телефон (+7XXX...)
- [ ] `🔴ВПИШИ_ГОРОД🔴` — город в шапке оферты
- [ ] `🔴ВПИШИ_СЕРИЮ🔴` `🔴ВПИШИ_НОМЕР🔴` `🔴ВПИШИ_КЕМ_ВЫДАН🔴` `🔴ВПИШИ_ДАТУ_ВЫДАЧИ🔴` `🔴ВПИШИ_КОД🔴` — паспортные данные (только в `05-contacts.md`, если требуется)
- [ ] `🔴ВПИШИ_ДАТУ_РЕГИСТРАЦИИ🔴` — дата регистрации ИП
- [ ] Банковские реквизиты (`05-contacts.md`):
  - `🔴ВПИШИ_РАСЧЁТНЫЙ_СЧЁТ🔴` — расчётный счёт (20 цифр)
  - `🔴ВПИШИ_БАНК🔴` — название банка
  - `🔴ВПИШИ_БИК🔴` — БИК (9 цифр)
  - `🔴ВПИШИ_КОРР_СЧЁТ🔴` — корреспондентский счёт

**Быстрая проверка:** `grep -n "🔴" docs/robokassa-package/*.md` — не должно быть ни одного маркера после заполнения.

---

## ШАГ 2 — Конвертировать .md → .docx или .pdf

**Вариант А — Google Docs (самое простое):**
1. Открой Google Drive → New → File Upload → загрузи каждый `.md`
2. Кликни правой → Open with → Google Docs
3. File → Download → Microsoft Word (.docx) или PDF

**Вариант B — на Mac через pandoc:**
```
brew install pandoc
cd /Users/eugene/.../docs/robokassa-package
for f in 01-oferta 02-privacy 03-refund 04-description 05-contacts; do
  pandoc $f.md -o $f.pdf
done
```

**Вариант C — на VPS через libreoffice:**
```
ssh root@31.130.148.107 'cd /opt/muziai-src/docs/robokassa-package && for f in 01-oferta 02-privacy 03-refund 04-description 05-contacts; do libreoffice --headless --convert-to pdf $f.md; done'
```

---

## ШАГ 3 — Зайти в кабинет Robokassa

URL: https://partner.robokassa.ru

Раздел: **Магазины → MuzaAi → Документы**

Загрузить:
- [ ] `01-oferta.pdf` → **Договор-оферта**
- [ ] `02-privacy.pdf` → **Политика конфиденциальности**
- [ ] `03-refund.pdf` → **Условия возврата**
- [ ] `04-description.pdf` → **Описание услуг** (или в раздел «Сайт → Описание»)
- [ ] `05-contacts.pdf` → **Реквизиты юр.лица**

Если в кабинете нет отдельных слотов под каждый — объедини в один PDF и загрузи как «Договор-оферта» (он включает в себя все ключевые разделы).

---

## ШАГ 4 — Проверить что сайт соответствует требованиям

Открой каждую страницу и убедись что:

- [ ] https://muzaai.ru — footer показывает ИНН/ОГРН/email/телефон (не placeholder'ы)
- [ ] https://muzaai.ru/contacts — все реквизиты заполнены
- [ ] https://muzaai.ru/oferta — оферта читается, ИНН/ОГРН на месте
- [ ] https://muzaai.ru/privacy — политика ПДн читается
- [ ] https://muzaai.ru/refund — условия возврата читаются
- [ ] https://muzaai.ru/terms → ведёт на оферту (редирект)
- [ ] На странице оплаты есть выбор: **💳 Картой / 📱 СБП**
- [ ] Цены чётко указаны (99 ₽ / 890 ₽ / и т.д.)
- [ ] Есть согласие на обработку ПДн при регистрации (checkbox 152-ФЗ)

Чтобы поднять реквизиты на сайте — заполни `.env` через SSH:

```
ssh root@31.130.148.107 'sed -i "/^LEGAL_/d" /var/www/neurohub/.env && cat >> /var/www/neurohub/.env <<EOF
LEGAL_ENTITY_NAME=ИП Новосёлов Е.С.
LEGAL_ENTITY_FULL_NAME=Индивидуальный предприниматель Новосёлов Евгений Сергеевич
LEGAL_INN=ТВОЙ_ИНН
LEGAL_OGRN=ТВОЙ_ОГРНИП
LEGAL_ADDRESS=ТВОЙ_АДРЕС
LEGAL_PHONE=+7XXX...
LEGAL_EMAIL=hello@muzaai.ru
LEGAL_SNO=npd
LEGAL_DEFAULT_TAX=none
EOF
chmod 600 /var/www/neurohub/.env && pm2 restart neurohub --update-env'
```

---

## ШАГ 5 — Заполнить анкету магазина в Robokassa

В кабинете → **Магазины → MuzaAi → Реквизиты и Заполнить анкету:**

- [ ] Название магазина: **MuzaAi**
- [ ] URL: **https://muzaai.ru**
- [ ] Описание (1-2 предложения): «Российская AI-платформа для создания музыкальных треков и обложек по тексту»
- [ ] Категория услуг: «Цифровые услуги / ПО»
- [ ] MCC-код: 5734 или 7372
- [ ] Способ доставки: Электронный (через личный кабинет)
- [ ] Средний чек: 99-890 ₽
- [ ] Ожидаемый оборот в месяц: 🔴ВПИШИ_ОЖИДАНИЕ🔴 ₽

---

## ШАГ 6 — Дождаться модерации

Срок: типично 1-3 рабочих дня.

После одобрения Robokassa выдаст:
- Production ROBO_LOGIN (имя магазина)
- ROBO_PASSWORD_1 (пароль для подписи запроса)
- ROBO_PASSWORD_2 (пароль для проверки результата)

Эти значения нужно записать в `.env` на VPS (БЕЗ ПЕРЕДАЧИ ЧЕРЕЗ ЧАТ!):

```
ssh root@31.130.148.107 'sed -i "/^ROBO_LOGIN=/d; /^ROBO_PASSWORD_1=/d; /^ROBO_PASSWORD_2=/d" /var/www/neurohub/.env && cat >> /var/www/neurohub/.env <<EOF
ROBO_LOGIN=🔴ВВОДИШЬ_РУКАМИ🔴
ROBO_PASSWORD_1=🔴ВВОДИШЬ_РУКАМИ🔴
ROBO_PASSWORD_2=🔴ВВОДИШЬ_РУКАМИ🔴
EOF
chmod 600 /var/www/neurohub/.env && pm2 restart neurohub --update-env'
```

---

## ШАГ 7 — Тестовый платёж

После активации:
1. Заходишь на muzaai.ru как обычный юзер
2. Жмёшь **💳 Картой** → Robokassa → 99 ₽ → оплата
3. Проверяешь:
   - Деньги списались с карты
   - Электронный чек пришёл на email (от Robokassa)
   - На дашборде появились пакетные треки
4. Делаешь возврат через кабинет Robokassa → проверяешь что вернулись

Если всё ок — повторяешь с СБП.

---

## ПРОВЕРКА API alias'ов СБП и Карты

Если Robokassa использует свои метки валют — проверь через GetCurrencies:

```
curl 'https://auth.robokassa.ru/Merchant/WebService/Service.asmx/GetCurrencies?MerchantLogin=ТВОЙ_LOGIN&language=ru'
```

В ответе ищи:
- `<Code>BANK` или `BANKOCEAN2` — карты → `ROBO_LABEL_CARD=...`
- `<Code>SBP` или `SBP_R` — СБП → `ROBO_LABEL_SBP=...`

Если значения отличаются от `BANK`/`SBP` — добавь в env:
```
ssh root@31.130.148.107 'cat >> /var/www/neurohub/.env <<EOF
ROBO_LABEL_CARD=ТОЧНОЕ_ЗНАЧЕНИЕ_BANK
ROBO_LABEL_SBP=ТОЧНОЕ_ЗНАЧЕНИЕ_SBP
EOF
pm2 restart neurohub --update-env'
```
