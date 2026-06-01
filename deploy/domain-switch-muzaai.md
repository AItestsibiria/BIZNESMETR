# Переход muziai.ru → muzaai.ru (Eugene 2026-05-15)

Порядок действий. muziai.ru остаётся работать (301-redirect на muzaai.ru), все
ранее отправленные ссылки переходят на новый домен.

## Этап 1 — DNS (делает Eugene у регистратора)

В кабинете регистратора muzaai.ru → DNS:

| Тип | Имя | Значение | TTL |
|---|---|---|---|
| A | `@` | `31.130.148.107` | 600 |
| A | `www` | `31.130.148.107` | 600 |

Через 5-15 мин проверка на VPS:
```bash
dig muzaai.ru +short    # должно показать 31.130.148.107
dig www.muzaai.ru +short # то же
```

## Этап 2 — Nginx config + SSL (на VPS prod 31.130.148.107)

```bash
# 1. Скопировать новый config
cp /opt/muziai-src/deploy/nginx-muzaai.conf /etc/nginx/sites-available/muzaai.ru

# 2. Создать symlink
ln -sf /etc/nginx/sites-available/muzaai.ru /etc/nginx/sites-enabled/muzaai.ru

# 3. Удалить старый config muziai.ru (он замещается новым с redirect'ом)
#    Сначала ПРОВЕРЬ что в нём — может быть ссылки на cert. Бэкап:
cp /etc/nginx/sites-enabled/muziai.ru /root/nginx-muziai-old-backup.conf 2>/dev/null || true
rm /etc/nginx/sites-enabled/muziai.ru 2>/dev/null || true

# 4. ПЕРВЫЙ certbot run (выпуск SSL для muzaai.ru + auto-attach к muziai.ru):
#    Сначала нужен временный nginx без SSL для ACME challenge.
#    Закомментировать SSL-блоки в nginx-muzaai.conf на время certbot ИЛИ:
certbot --nginx -d muzaai.ru -d www.muzaai.ru -d muziai.ru -d www.muziai.ru \
  --non-interactive --agree-tos -m hello@muziai.ru --redirect

# Certbot сам:
#  - выпустит единый SAN-сертификат для всех 4 доменов
#  - добавит SSL-блоки в /etc/nginx/sites-enabled/muzaai.ru
#  - переподпишет redirect-секции на 443

# 5. Проверка + reload
nginx -t && systemctl reload nginx
```

## Этап 3 — .env update (BASE_DOMAIN)

В коде есть `process.env.BASE_DOMAIN` для:
- SMS-OTP формат `@${BASE_DOMAIN} #123456` (Web OTP API на Android требует совпадения домена в SMS и домена страницы)

```bash
# Обновить .env
sed -i '/^BASE_DOMAIN=/d' /var/www/neurohub/.env
echo "BASE_DOMAIN=muzaai.ru" >> /var/www/neurohub/.env
chmod 600 /var/www/neurohub/.env

# Restart pm2
pm2 restart neurohub --update-env
```

## Этап 4 — Проверка

1. **DNS:** `dig muzaai.ru +short` → `31.130.148.107`
2. **SSL:** `curl -I https://muzaai.ru/` → `200 OK` (или `301 → www`)
3. **301 от старого:** `curl -I https://muziai.ru/dashboard` → `301 Moved Permanently` + `Location: https://muzaai.ru/dashboard`
4. **Backend:** https://muzaai.ru/api/_status → JSON
5. **Frontend:** открой https://muzaai.ru/ — главная грузится
6. **SMS-формат:** `sms send +7XXX` → проверь что в SMS-логе `@muzaai.ru` (не `@muziai.ru`)

## Rollback (если что-то сломалось)

```bash
# Вернуть старый nginx-config
cp /root/nginx-muziai-old-backup.conf /etc/nginx/sites-enabled/muziai.ru
rm /etc/nginx/sites-enabled/muzaai.ru
nginx -t && systemctl reload nginx

# Вернуть .env
sed -i '/^BASE_DOMAIN=/d' /var/www/neurohub/.env
pm2 restart neurohub --update-env
```

## Hardcoded "muziai.ru" в коде — что осталось

После этапов 1-4 nginx-redirect делает всю работу. Email-адреса
(`hello@muziai.ru`, `*@phone.muziai.ru`) остаются на старом домене —
их менять не нужно (MX-записи на muziai.ru). Это **placeholder-emails**
для phone-users (внутренний uniqueness, не реальная отправка).

Если в будущем будем переносить email — отдельный план с MX и mailserver.
