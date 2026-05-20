#!/bin/bash
# Полная настройка Max-бота: ENV + webhook regestration в один paste.
# Запуск: bash /opt/muziai-src/deploy/setup-max-webhook.sh
# Идемпотентен — можно запускать многократно, повторно не плодит.

set +e
ENV_FILE=/var/www/neurohub/.env
API_BASE="https://botapi.max.ru"
WEBHOOK_URL="https://muzaai.ru/api/max-bot/webhook"
BOT_USERNAME="id7017236261_1_bot"
BOT_USER_ID="291072934"
BOT_DEEP_LINK="https://max.ru/id7017236261_1_bot"

if [ ! -f "$ENV_FILE" ]; then
  echo "❌ $ENV_FILE not found"
  exit 1
fi

TOK=$(grep '^MAX_BOT_TOKEN=' "$ENV_FILE" | cut -d= -f2-)
if [ -z "$TOK" ]; then
  echo "❌ MAX_BOT_TOKEN пуст. Сначала установи токен в $ENV_FILE."
  exit 1
fi

echo "=== Шаг 1: проверка/установка ENV vars ==="
NEED_RESTART=0

# MAX_WEBHOOK_SECRET — генерируем если пуст
if ! grep -q '^MAX_WEBHOOK_SECRET=.\+' "$ENV_FILE"; then
  NEW_SECRET=$(openssl rand -base64 32)
  sed -i "/^MAX_WEBHOOK_SECRET=/d" "$ENV_FILE"
  echo "MAX_WEBHOOK_SECRET=${NEW_SECRET}" >> "$ENV_FILE"
  echo "  ✓ MAX_WEBHOOK_SECRET сгенерирован (длина 44)"
  NEED_RESTART=1
else
  echo "  ✓ MAX_WEBHOOK_SECRET уже задан"
fi

# MAX_BOT_ID
if ! grep -q "^MAX_BOT_ID=${BOT_USER_ID}" "$ENV_FILE"; then
  sed -i "/^MAX_BOT_ID=/d" "$ENV_FILE"
  echo "MAX_BOT_ID=${BOT_USER_ID}" >> "$ENV_FILE"
  echo "  ✓ MAX_BOT_ID=${BOT_USER_ID} установлен"
  NEED_RESTART=1
else
  echo "  ✓ MAX_BOT_ID=${BOT_USER_ID} уже задан"
fi

# MAX_BOT_LINK
if ! grep -q "^MAX_BOT_LINK=${BOT_DEEP_LINK}" "$ENV_FILE"; then
  sed -i "/^MAX_BOT_LINK=/d" "$ENV_FILE"
  echo "MAX_BOT_LINK=${BOT_DEEP_LINK}" >> "$ENV_FILE"
  echo "  ✓ MAX_BOT_LINK установлен"
  NEED_RESTART=1
else
  echo "  ✓ MAX_BOT_LINK уже задан"
fi

chmod 600 "$ENV_FILE"

# Restart pm2 если ENV изменились
if [ "$NEED_RESTART" = "1" ]; then
  echo ""
  echo "=== Шаг 2: pm2 restart --update-env ==="
  pm2 restart neurohub --update-env 2>&1 | tail -5
  sleep 3
else
  echo ""
  echo "=== Шаг 2: pm2 restart пропущен (env не менялись) ==="
fi

# Регистрация webhook через Max API
SECRET=$(grep '^MAX_WEBHOOK_SECRET=' "$ENV_FILE" | cut -d= -f2-)
echo ""
echo "=== Шаг 3: Регистрация webhook в Max API ==="
echo "URL: ${WEBHOOK_URL}"
echo "Secret length: ${#SECRET}"

# Проверим есть ли уже подписка на этот URL
CURRENT_SUBS=$(curl -s -H "Authorization: ${TOK}" "${API_BASE}/subscriptions" 2>/dev/null)
echo "Текущие subscriptions:"
echo "$CURRENT_SUBS"
echo ""

if echo "$CURRENT_SUBS" | grep -q "$WEBHOOK_URL"; then
  echo "  ⚠ webhook уже зарегистрирован — пропускаю POST"
else
  echo "  → Отправляю POST /subscriptions"
  RESPONSE=$(curl -s -X POST \
    -H "Authorization: ${TOK}" \
    -H "Content-Type: application/json" \
    -d "{\"url\":\"${WEBHOOK_URL}\",\"update_types\":[\"message_created\",\"bot_started\",\"bot_added\",\"bot_removed\",\"message_callback\"],\"secret\":\"${SECRET}\"}" \
    "${API_BASE}/subscriptions" 2>/dev/null)
  echo "  Response: $RESPONSE"
fi

echo ""
echo "=== Шаг 4: Финальная проверка ==="
echo "--- getMe ---"
curl -s -H "Authorization: ${TOK}" "${API_BASE}/me" 2>/dev/null
echo ""
echo ""
echo "--- subscriptions ---"
curl -s -H "Authorization: ${TOK}" "${API_BASE}/subscriptions" 2>/dev/null
echo ""
echo ""
echo "=== DONE ==="
echo ""
echo "Если subscriptions содержит ${WEBHOOK_URL} — webhook live."
echo "Открой в Max бот ${BOT_DEEP_LINK} → отправь /start → должен ответить."
