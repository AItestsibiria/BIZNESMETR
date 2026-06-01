# Гайд: создание Google Cloud Service Account для rclone-бэкапов

Ниже — пошаговая инструкция, как создать **отдельный Google Cloud проект**, выпустить **Service Account JSON-ключ** и **расшарить папку Google Drive** на этот SA. Результат — файл `gcp-sa.json`, который мы безопасно перенесём на **clone.muziai.ru** (staging-сервер; бэкапим именно его, не VPS1) — мимо чата с AI.

**Время:** 15–20 минут. Расходов: бесплатно (Drive квота — 15 ГБ на личный аккаунт; для бэкапов SQLite этого хватит на годы).

---

## Шаг 1. Создаём GCP проект

1. Открой <https://console.cloud.google.com/projectcreate>
2. Выполни вход под Google-аккаунтом, на котором будут лежать бэкапы (можно под существующим, можно под отдельным `muziai-backup@gmail.com`).
3. Поле **Project name:** `muziai-backups`
4. **Project ID:** оставь автогенерированный или поставь `muziai-backups-<3 цифры>`.
5. **Organization / Location:** «No organization» (если личный аккаунт) или твоя организация.
6. Кнопка **Create**. Жди 10–20 секунд пока создастся.

**Чекпоинт:** сверху в шапке консоли отображается `muziai-backups`.

---

## Шаг 2. Включаем Drive API

1. Открой <https://console.cloud.google.com/apis/library/drive.googleapis.com>
2. Убедись, что в шапке выбран проект `muziai-backups` (если нет — переключи).
3. Нажми **Enable**. Жди 5–10 секунд.

**Чекпоинт:** на странице появилась надпись «API enabled» и кнопка **Manage**.

---

## Шаг 3. Создаём Service Account

1. Открой <https://console.cloud.google.com/iam-admin/serviceaccounts>
2. **Project = muziai-backups** в шапке.
3. Кнопка **+ Create Service Account** сверху.
4. Заполни:
   - **Name:** `rclone-backup`
   - **ID:** `rclone-backup` (автоподставится)
   - **Description:** `Service account for rclone → Drive backups of MuziAI data.db`
5. Нажми **Create and Continue**.
6. **Grant this service account access to project:** оставь пустым (нам не нужны IAM-роли GCP, только Drive). Кнопка **Continue**.
7. **Grant users access:** оставь пустым. Кнопка **Done**.

**Чекпоинт:** в списке появился `rclone-backup@muziai-backups-XXX.iam.gserviceaccount.com`. **Скопируй этот email** — он понадобится в Шаге 5.

---

## Шаг 4. Создаём JSON-ключ

1. Кликни на созданный SA → вкладка **Keys**.
2. **Add Key → Create new key → JSON → Create**.
3. Браузер скачает файл вида `muziai-backups-XXX-abcdef123456.json`.
4. **Сохрани его в безопасное место** на своей машине, например:
   ```
   ~/secrets/muziai/gcp-sa.json
   chmod 600 ~/secrets/muziai/gcp-sa.json
   ```

⚠️ **Не добавляй этот файл в git, не присылай его в чат с AI, не клади в Drive «общим доступом». Это ключ ко всем бэкапам.**

---

## Шаг 5. Создаём папку на Drive и расшариваем на SA

1. Открой <https://drive.google.com/drive/my-drive>
2. **+ New → Folder → имя:** `muziai-backups`. Создай.
3. Внутри неё — три подпапки: `hourly/`, `daily/`, `manual/`.
4. На корневой папке `muziai-backups`: **правый клик → Share**.
5. В поле «Add people and groups» вставь email из Шага 3 (`rclone-backup@muziai-backups-XXX.iam.gserviceaccount.com`).
6. **Роль:** `Editor` (Редактор).
7. **Снять галочку «Notify people»** (на SA нет почты, уведомление пойдёт в никуда).
8. **Share**.

**Чекпоинт:** под папкой видно «1 person has access» с иконкой service-account.

---

## Шаг 6. Переносим JSON на VPS1

⚠️ **Только через SSH, не через чат.** Делает сам Евгений или Perplexity (с пятиуровневым предупреждением).

```bash
# с локальной машины
scp ~/secrets/muziai/gcp-sa.json root@72.56.1.149:/etc/rclone/gcp-sa.json

# на VPS1
ssh root@72.56.1.149 '
  mkdir -p /etc/rclone &&
  chmod 700 /etc/rclone &&
  chmod 600 /etc/rclone/gcp-sa.json &&
  ls -la /etc/rclone/
'
```

---

## Шаг 7. Настраиваем rclone remote

```bash
ssh root@72.56.1.149 '
  rclone config create gdrive drive \
    service_account_file /etc/rclone/gcp-sa.json \
    scope drive

  # smoke test: должна вывести 3 папки
  rclone lsd gdrive: --drive-shared-with-me
'
```

**Чекпоинт:** видишь `hourly`, `daily`, `manual`.

> Если `rclone lsd gdrive:` ничего не выводит — попробуй `--drive-shared-with-me` или перепроверь, что папка действительно расшарена на email SA (Шаг 5).

---

## Шаг 8. Ставим backup-скрипт и cron

См. `PREFLIGHT.md` §3.3 — там готовый блок с `muziai-backup.sh` и crontab. Копируй прямо как есть на VPS1.

---

## Шаг 9. Smoke-тест

```bash
ssh root@72.56.1.149 '
  /usr/local/bin/muziai-backup.sh && \
  rclone ls gdrive:muziai-backups/hourly/ | tail -3
'
```

**Чекпоинт:** в выводе видишь `data-YYYYMMDD-HHMMSS.db.gz` — последний бэкап только что попал на Drive.

---

## Что делать, если что-то сломалось

| Симптом | Причина | Фикс |
|---|---|---|
| `rclone lsd gdrive:` пусто | Папка не расшарена на email SA | Шаг 5 повтори |
| `403 storageQuotaExceeded` | Личный Drive переполнен | Удали старые файлы или возьми `muziai-backup@gmail.com` отдельно |
| `403 forbidden` при `rclone copy` | SA имеет роль Viewer вместо Editor | В Drive Share → роль `Editor` |
| `service_account_file` not found | JSON не на VPS1 или права 600 не выставлены | Шаг 6 повтори |

---

## После Шага 9 — задача §3 закрыта

Сообщи мне в чат: **«rclone настроен, бэкапы идут на Drive»** — я отмечу §3 как закрытое и подготовлю старт Спринта 1.

---

*Last updated: 2026-05-06*
