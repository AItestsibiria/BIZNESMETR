# Места, ждущие материалов из MuziAI

Все точки в коде помечены `// TODO(muziai)`. Список ниже — для удобства,
чтобы быстро пройтись по ним, когда придут файлы.

## Telegram-бот
- `src/messengers/telegram.ts`
  - Подменить базовую обработку `bot.on('message')` на стиль MuziAI (router,
    middleware-цепочка, attachment parsing для photo/voice/document/audio).

## Запуск и контейнеризация
- `Dockerfile`
  - Сверить с их `Dockerfile`: используют ли multi-stage, как делают
    миграции на старте, какой entrypoint, есть ли healthcheck-команда.
- `docker-compose.yml`
  - Добавить reverse proxy (Caddy / nginx / Traefik) — какой у них.
  - Подменить блок `app` под их конвенции (имена volume, networks).

## CI / деплой
- Нет пока файлов — создадим `.github/workflows/deploy.yml` по образцу MuziAI.

## MAX
- `src/messengers/max.ts` — реализовать через тот же интерфейс, что и Telegram.
  Это Спринт 2, не зависит от MuziAI напрямую, но если у них есть готовые
  утилиты для абстракции мессенджеров — заберём.

## Голосовой диалог
- `src/integrations/voice.ts` — заменить `WhisperTranscriber` на их выбор
  провайдера (если другой). Помеченные `// TODO(muziai/voice)` точки —
  где это сделать без переделки интерфейса.
- `src/messengers/telegram.ts` — взять у них продакшен-проверенную
  обработку voice/audio (нарезка длинных, фильтр форматов, ошибки).
- **TTS** — добавить новый клиент, когда узнаем их провайдера и голос.
  В текущей версии TTS отключён (`VOICE_REPLIES_ENABLED=false`).
