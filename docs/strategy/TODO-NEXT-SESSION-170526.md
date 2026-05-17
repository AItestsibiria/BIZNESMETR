# TODO следующей сессии — 17.05.2026

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

## Приоритет 4 — Cookies + IP geo profile

- Собирать cookies + IP geo (Maxmind или ip-api.com) в `user_profiles` table
- Связывать с user_journey events
- Проверка «автор или нет» (existing user или first visit)
- Выводить в brain-export
- Использовать в персонализации (Муза узнаёт юзера: «Привет [имя], видел тебя из [город]»)

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
