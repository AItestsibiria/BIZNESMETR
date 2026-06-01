# ЧЕКЛИСТ ПОДАЧИ В Robokassa
## Для внутреннего использования (не отправлять)

**Дата:** 18 мая 2026 г.

---

## ШАГ 1 — Реквизиты ✅ заполнены автоматически

ЗАО «Инфолайн» — все поля подставлены из данных Босса:

| Поле | Значение |
|---|---|
| Полное наименование | Закрытое акционерное общество «Инфолайн» |
| Сокращённое | ЗАО «Инфолайн» |
| ИНН | 7017236261 |
| ОГРН | 1097017005601 |
| КПП | 701701001 |
| Юр. адрес | 634050, г. Томск, пр. Ленина, д. 151/1, корпус 1 |
| Фактический адрес | 634050, г. Томск, ул. Карла Маркса, д. 7, оф. 519 |
| Телефон | +7 (3822) 50-36-70 |
| Email (поддержка) | hello@muzaai.ru |
| Email (директор) | egnovoselov@gmail.com |
| Расчётный счёт | 40702810464000007838 |
| Банк | Томское ОСБ № 8616 ПАО Сбербанк г. Томск |
| БИК | 046902606 |
| Корр. счёт | 30101810800000000606 |
| Директор | Новосёлов Евгений Геннадьевич (на основании Устава) |
| Режим налогообложения | ОСН (НДС 20%) |

Контрольная проверка: `grep -n "🔴" docs/robokassa-package/*.md`. Если что-то осталось — только в этом файле (06-checklist.md) сами placeholder'ы как примеры, и в env-блоке шага 6 для пары ROBO_PASSWORD_1/2.

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

- [ ] https://muzaai.ru — footer показывает ИНН/ОГРН/email/телефон
- [ ] https://muzaai.ru/contacts — все реквизиты заполнены
- [ ] https://muzaai.ru/oferta — оферта читается
- [ ] https://muzaai.ru/privacy — политика ПДн читается
- [ ] https://muzaai.ru/refund — условия возврата читаются
- [ ] https://muzaai.ru/terms → ведёт на оферту (редирект)
- [ ] На странице оплаты есть выбор: **💳 Картой / 📱 СБП**
- [ ] Цены чётко указаны (99 ₽ / 890 ₽ / и т.д.)
- [ ] Согласие на обработку ПДн при регистрации (checkbox 152-ФЗ)

Чтобы реквизиты попали в footer сайта и /contacts — заполни `.env` на VPS:

```
ssh root@31.130.148.107 'sed -i "/^LEGAL_/d" /var/www/neurohub/.env && cat >> /var/www/neurohub/.env <<EOF
LEGAL_ENTITY_NAME=ЗАО «Инфолайн»
LEGAL_ENTITY_FULL_NAME=Закрытое акционерное общество «Инфолайн»
LEGAL_INN=7017236261
LEGAL_OGRN=1097017005601
LEGAL_KPP=701701001
LEGAL_ADDRESS=634050, г. Томск, пр. Ленина, д. 151/1, корпус 1
LEGAL_PHONE=+7 (3822) 50-36-70
LEGAL_EMAIL=hello@muzaai.ru
LEGAL_DIRECTOR=Новосёлов Евгений Геннадьевич
LEGAL_SNO=osn
LEGAL_DEFAULT_TAX=vat20
EOF
chmod 600 /var/www/neurohub/.env && pm2 restart neurohub --update-env'
```

---

## ШАГ 5 — Заполнить анкету магазина в Robokassa

В кабинете → **Магазины → MuzaAi → Реквизиты и Заполнить анкету:**

- [ ] Название магазина: **MuzaAi**
- [ ] URL: **https://muzaai.ru**
- [ ] Описание: «Российская AI-платформа для создания музыкальных треков и обложек по тексту»
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

Записать в `.env` на VPS (значения вводить РУКАМИ, не через чат):

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

1. muzaai.ru как обычный юзер
2. **💳 Картой** → Robokassa → 99 ₽
3. Проверить:
   - Деньги списались
   - Чек пришёл на email от Robokassa
   - Пакетные треки в дашборде
4. Возврат через кабинет Robokassa
5. Повторить с СБП

---

## ПРОВЕРКА API alias'ов

```
curl 'https://auth.robokassa.ru/Merchant/WebService/Service.asmx/GetCurrencies?MerchantLogin=ТВОЙ_LOGIN&language=ru'
```

В ответе ищи `<Code>BANK` (карты) и `<Code>SBP` (СБП). Если другие — добавь в .env:
```
ROBO_LABEL_CARD=ТОЧНОЕ_ЗНАЧЕНИЕ
ROBO_LABEL_SBP=ТОЧНОЕ_ЗНАЧЕНИЕ
```
