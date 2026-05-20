#!/bin/bash
# Eugene 2026-05-20: диагностика + переустановка Telegram webhook с правильным secret.
# Запуск: bash /opt/muziai-src/deploy/fix-telegram-webhook.sh
#
# Что делает:
# 1. Читает TELEGRAM_BOT_TOKEN, TELEGRAM_WEBHOOK_SECRET, PUBLIC_BASE_URL из .env
# 2. Печатает длины (без значений)
# 3. Получает getWebhookInfo от Telegram (показывает текущую регистрацию)
# 4. Перерегистрирует webhook с secret из .env
# 5. Повторно проверяет getWebhookInfo

set +e
ENV_FILE=/var/www/neurohub/.env

if [ ! -f "$ENV_FILE" ]; then
  echo "❌ $ENV_FILE not found"
  exit 1
fi

T=$(grep '^TELEGRAM_BOT_TOKEN=' "$ENV_FILE" | cut -d= -f2-)
S=$(grep '^TELEGRAM_WEBHOOK_SECRET=' "$ENV_FILE" | cut -d= -f2-)
BASE=$(grep '^PUBLIC_BASE_URL=' "$ENV_FILE" | cut -d= -f2-)
[ -z "$BASE" ] && BASE="https://muzaai.ru"

echo "=== ENV ==="
echo "TELEGRAM_BOT_TOKEN length: ${#T}"
echo "TELEGRAM_WEBHOOK_SECRET length: ${#S}"
echo "PUBLIC_BASE_URL: $BASE"

if [ -z "$T" ]; then
  echo "❌ TELEGRAM_BOT_TOKEN пуст — выходим"
  exit 1
fi

API="https://api.telegram.org/bot${T}"
WEBHOOK_URL="${BASE}/api/telegram/webhook"

echo ""
echo "=== Текущий webhook (до фикса) ==="
curl -s "${API}/getWebhookInfo" | head -10
echo ""

echo ""
echo "=== Регистрируем webhook заново с secret из .env ==="
if [ -z "$S" ]; then
  echo "⚠ TELEGRAM_WEBHOOK_SECRET пуст — генерирую новый 32-char alphanumeric"
  S=$(LC_ALL=C tr -dc 'a-zA-Z0-9' </dev/urandom | head -c 32)
  sed -i "/^TELEGRAM_WEBHOOK_SECRET=/d" "$ENV_FILE"
  echo "TELEGRAM_WEBHOOK_SECRET=${S}" >> "$ENV_FILE"
  chmod 600 "$ENV_FILE"
  echo "  ✓ Сгенерирован новый secret (длина 32)"
  echo "  → Сделаем pm2 restart чтобы handler читал новый secret"
  pm2 restart neurohub --update-env >/dev/null 2>&1
  sleep 2
fi

# setWebhook через POST JSON (надёжнее чем query string для secret_token)
RESPONSE=$(curl -s -X POST "${API}/setWebhook" \
  -H "Content-Type: application/json" \
  -d "{\"url\":\"${WEBHOOK_URL}\",\"secret_token\":\"${S}\",\"drop_pending_updates\":false,\"allowed_updates\":[\"message\",\"callback_query\",\"my_chat_member\"]}")
echo "$RESPONSE"

echo ""
echo "=== Проверка после фикса ==="
curl -s "${API}/getWebhookInfo" | head -10
echo ""

echo ""
echo "=== DONE ==="
echo ""
echo "Если в last_error_date пусто — webhook работает."
echo "Открой бота в Telegram → напиши /start → должна ответить Музa."
echo ""
echo "Если опять 'invalid webhook secret' — pm2 restart:"
echo "  pm2 restart neurohub --update-env"
