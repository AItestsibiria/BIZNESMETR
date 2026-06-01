# TODO следующей сессии — 17.05.2026

## КРИТИЧНО — Phone-auth полный пересмотр

**Босс:** «Нам никто не звонит» + «если автор то приветствуй по имени»

### Проблема 1: confusion в callcheck logic

Sms.ru `callcheck/add` — **classical flashcall** (sms.ru ЗВОНИТ юзеру). Subagent ранее переписал на «reverse» — это **неправильно**. Юзер видит наш номер и думает что нужно ему звонить — но никто не звонит → frustration.

**Правильный flow** (classical sms.ru flashcall):
1. Юзер вводит свой phone
2. Backend POST `callcheck/add?phone=USER_PHONE` → возвращает `call_phone` (короткий номер откуда позвонят юзеру)
3. **Sms.ru звонит юзеру** автоматически
4. Юзер видит входящий, не отвечает, читает последние 4 цифры от номера
5. Юзер вводит 4 цифры на странице
6. Backend проверяет `callcheck/status` → success

UI:
- «Сейчас вам позвонят с номера +7XXX...YYYY» — не «звоните сюда»
- «Введите 4 последние цифры от номера откуда позвонили»

### Проблема 2: existing user — auto-login

- POST `/api/auth/phone-check` body `{phone}` — fast lookup
  - Если exists → `{exists: true, name: "Иван", maskedPhone: "+7926***4567"}`
  - Если не exists → `{exists: false}`
- UI на /register-phone:
  - Если **exists** → меняется: «Привет, Иван! С возвращением. Сейчас позвоним для входа»
  - Если **not exists** → обычная регистрация

### Файлы для правки

- `apps/neurohub/server/plugins/auth-sms/module.ts` — переписать `send-call` и `verify-call` (classical, НЕ reverse)
- `apps/neurohub/client/src/components/phone-otp-form.tsx` — UI text «вам позвонят» вместо «звоните сюда»
- Новый endpoint `/api/auth/phone-check` (без auth, rate-limit 5/min)
- `apps/neurohub/client/src/pages/register-phone.tsx` — auto-redirect logic если exists

## Старый TODO (продолжается ниже)

Subagent rate-limit активен (You're out of extra usage — resets 6am UTC). После сброса (9:00 MSK):

## Приоритет 1 — Плеер controls в swipe режим (раскрытую обложку)

**Босс:** «Плеер на главной последние кнопки надо в свайп режим было»

`CoverDetailsModal` сейчас имеет только swipe-навигацию + close. **Нужно добавить полный набор контролов** внизу раскрытой обложки:
- ⏮ Previous track (уже есть как stretch arrow)
- ⏯ Play / Pause toggle
- ⏭ Next track (уже есть)
- 🔁 Repeat mode (toggle one/all/off)
- 🔊 Volume slider (reuse VolumeSlider компонент)

Реализация:
- В `cover-details-modal.tsx` добавить prop `audioRef` или callbacks `onPlay/onPause/onSeek`
- Controls bar внизу cover: glass-card row с 5 кнопками
- isPlaying state синхронизирован с main player
- При выходе из modal — продолжается воспроизведение
- Mobile-friendly (touch-target 44px)

## Приоритет 2 — Регистрация по телефону (визуальное усиление)

- `register-phone.tsx` + `login-phone.tsx` + `phone-otp-form.tsx`
- **«ЗВОНОК БЕСПЛАТНЫЙ»** крупным текстом — большие буквы + фирменный gradient amber→cyan
- Образ «главной двери» — большой, заметный, фирменный стиль
- Анимация attention на номере для звонка (pulse-glow)
- Дополнительное explainer почему звонок бесплатный
- Кнопка «📞 ПОЛУЧИТЬ ЗВОНОК» — большая, btn-cosmic, prominent

## Приоритет 2 — Voice recording тестирование

- После моего fix `recorder.start(250)` + `800ms minimum delay` — проверить работает ли
- Если всё ещё «запись короткая» → дальнейшая отладка

## Приоритет 3 — Кнопки на плеере в swipe режим

- В CoverDetailsModal — добавить **рабочие плеер-кнопки** (▶/⏸/⏭/⏮) на full-screen раскрытой обложке
- Сейчас swipe только переключает трек, но играть/паузить внутри modal нельзя
- Громкость slider тоже там

## Приоритет 4 — Cookies + IP geo profile (admin-only access)

**Босс 2026-05-17:** «Cookies надо собирать и привязывать к профилю автора только у админа доступ»

- Собирать cookies (visitor_id, session_id, last_seen, referrer, UTM-params) + IP geo (Maxmind или ip-api.com) в `user_profiles` table
- Связывать с user_journey events + с `users.id` если автор зарегистрирован
- Проверка «автор или нет» (existing user или first visit) — auto-link при первом авторизованном request'е
- **Доступ к этим данным — ТОЛЬКО админ** через `/api/admin/v304/user-profile/:userId` (requireAdmin middleware)
  - НЕ через user-facing endpoint, НЕ в brain-export для не-админов
  - Юзер не должен видеть свой собственный «портрет» в API
- В admin UI (`/admin/v304`) — вкладка «👤 Профили авторов»:
  - Список юзеров + их cookies / IP geo / device / first/last seen / city / referrer
  - Click на юзера → детали: history визитов, devices (multi-IP detection), conversion funnel
- Использовать в персонализации **внутри Музы** (не в открытом API):
  - Муза узнаёт юзера: «Привет [имя], видел тебя из [город]» — но через server-side context, юзер сам не делает запрос за этими данными
- Privacy: GDPR-like — при удалении аккаунта профиль помечается deleted_at + cookies expire

## Приоритет 5 — Дашборд drill-down на ВСЕХ кнопках

- При click на любую метрику/чарт/элемент → переход дальше на связанные элементы
- Выбор админа: «показать users этой когорты», «показать треки этого жанра», «показать диалоги этой темы»
- Connected dashboard navigation

## Приоритет 6 — L1/L3 security завершить

- L1 login 2FA (subagent упал на rate limit)
- L3 session security (subagent упал)
- Deputy role (subagent упал)

## Команды быстрого старта

```bash
# После 9:00 MSK — лимит сброшен. Запустить subagent'ов:
# 1. Регистрация phone visual (приоритет 1)
# 2. Player controls в swipe modal (приоритет 3)
# 3. Cookies + IP profile (приоритет 4)
```

🕐 Создан 2026-05-17 11:30 MSK
