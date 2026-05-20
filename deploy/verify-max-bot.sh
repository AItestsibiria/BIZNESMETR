#!/bin/bash
# Финальная проверка Max-бота — БЕЗ leak'ов секретов в вывод.
# Использует токены/secret из .env для запросов, но НЕ печатает их значения.
# Только flag'и (✓/✗), длины, и публичные данные (имя бота, кол-во подписок).
# Запуск: bash /opt/muziai-src/deploy/verify-max-bot.sh

set +e
ENV_FILE=/var/www/neurohub/.env
API_BASE="https://botapi.max.ru"
WEBHOOK_URL="https://muzaai.ru/api/max-bot/webhook"

if [ ! -f "$ENV_FILE" ]; then
  echo "❌ $ENV_FILE not found"
  exit 1
fi

# Загружаем секреты в переменные shell, НЕ печатаем их
TOK=$(grep '^MAX_BOT_TOKEN=' "$ENV_FILE" | cut -d= -f2-)
SECRET=$(grep '^MAX_WEBHOOK_SECRET=' "$ENV_FILE" | cut -d= -f2-)
BOT_ID=$(grep '^MAX_BOT_ID=' "$ENV_FILE" | cut -d= -f2-)
BOT_LINK=$(grep '^MAX_BOT_LINK=' "$ENV_FILE" | cut -d= -f2-)

green() { printf "\e[32m%s\e[0m\n" "$1"; }
yellow() { printf "\e[33m%s\e[0m\n" "$1"; }
red() { printf "\e[31m%s\e[0m\n" "$1"; }

VERDICT_GREEN=1
VERDICT_YELLOW=0

echo ""
echo "=== Max-bot Health Check ==="

# 1. ENV vars
echo ""
echo "[1] ENV vars (длины — без значений):"
if [ -n "$TOK" ]; then
  green "  ✓ MAX_BOT_TOKEN: ${#TOK} chars"
else
  red "  ✗ MAX_BOT_TOKEN: пуст"
  VERDICT_GREEN=0
fi

if [ -n "$SECRET" ] && [ ${#SECRET} -eq 44 ]; then
  green "  ✓ MAX_WEBHOOK_SECRET: 44 chars (правильная длина)"
elif [ -n "$SECRET" ]; then
  yellow "  ⚠ MAX_WEBHOOK_SECRET: ${#SECRET} chars (ожидается 44)"
  VERDICT_YELLOW=1
else
  red "  ✗ MAX_WEBHOOK_SECRET: пуст"
  VERDICT_GREEN=0
fi

if [ -n "$BOT_ID" ]; then
  green "  ✓ MAX_BOT_ID: $BOT_ID"
else
  yellow "  ⚠ MAX_BOT_ID: пуст"
  VERDICT_YELLOW=1
fi

if [ -n "$BOT_LINK" ]; then
  green "  ✓ MAX_BOT_LINK: $BOT_LINK"
else
  yellow "  ⚠ MAX_BOT_LINK: пуст"
  VERDICT_YELLOW=1
fi

# 2. PM2 status
echo ""
echo "[2] PM2 neurohub:"
PM2_STATUS=$(pm2 list 2>/dev/null | grep '│ neurohub' | head -1)
if echo "$PM2_STATUS" | grep -q "online"; then
  RESTARTS=$(echo "$PM2_STATUS" | awk -F'│' '{print $9}' | tr -d ' ')
  green "  ✓ online (restarts: $RESTARTS)"
else
  red "  ✗ не online или pm2 недоступен"
  VERDICT_GREEN=0
fi

# 3. Local endpoint
echo ""
echo "[3] Local /api/max-bot/status:"
LOCAL_HTTP=$(curl -s -o /dev/null -w "%{http_code}" "http://127.0.0.1:5000/api/max-bot/status" 2>/dev/null)
if [ "$LOCAL_HTTP" = "200" ]; then
  green "  ✓ HTTP $LOCAL_HTTP"
else
  red "  ✗ HTTP $LOCAL_HTTP (endpoint не работает)"
  VERDICT_GREEN=0
fi

# 4. Max API getMe — публичные данные о боте
echo ""
echo "[4] Max API getMe:"
if [ -n "$TOK" ]; then
  ME_JSON=$(curl -s -H "Authorization: $TOK" "${API_BASE}/me" 2>/dev/null)
  if echo "$ME_JSON" | grep -q '"user_id"'; then
    NAME=$(echo "$ME_JSON" | grep -oP '"first_name":"[^"]*"' | head -1 | cut -d'"' -f4)
    UNAME=$(echo "$ME_JSON" | grep -oP '"username":"[^"]*"' | head -1 | cut -d'"' -f4)
    UID=$(echo "$ME_JSON" | grep -oP '"user_id":[0-9]+' | head -1 | cut -d: -f2)
    green "  ✓ bot: $NAME (@$UNAME, id=$UID)"
    # Сверка с MAX_BOT_ID
    if [ -n "$BOT_ID" ] && [ "$UID" != "$BOT_ID" ]; then
      yellow "  ⚠ MAX_BOT_ID в .env ($BOT_ID) != getMe user_id ($UID)"
      VERDICT_YELLOW=1
    fi
  else
    red "  ✗ getMe не вернул валидный JSON (токен невалиден?)"
    VERDICT_GREEN=0
  fi
else
  red "  ✗ пропущен (нет MAX_BOT_TOKEN)"
fi

# 5. Webhook subscriptions — только count и наличие нашего URL
echo ""
echo "[5] Webhook subscriptions:"
if [ -n "$TOK" ]; then
  SUBS_JSON=$(curl -s -H "Authorization: $TOK" "${API_BASE}/subscriptions" 2>/dev/null)
  # Count subscriptions
  COUNT=$(echo "$SUBS_JSON" | grep -oP '"url":"[^"]*"' | wc -l)
  if [ "$COUNT" -eq 0 ]; then
    yellow "  ⚠ 0 subscriptions — webhook не зарегистрирован"
    VERDICT_YELLOW=1
  else
    green "  ✓ $COUNT subscription(s) активных"
    # Проверим что наш URL внутри (без вывода других URLs если есть)
    if echo "$SUBS_JSON" | grep -q "$WEBHOOK_URL"; then
      green "  ✓ наш URL зарегистрирован: $WEBHOOK_URL"
    else
      yellow "  ⚠ наш URL ($WEBHOOK_URL) НЕ в subscriptions"
      VERDICT_YELLOW=1
    fi
  fi
else
  red "  ✗ пропущен"
fi

# 6. Recent logs — только flag (без содержимого)
echo ""
echo "[6] Recent logs (max-bot за последние 100 строк):"
LOGS=$(pm2 logs neurohub --nostream --lines 100 2>&1 | grep -iE 'max-bot|max_bot' || true)
ERR_COUNT=$(echo "$LOGS" | grep -ciE 'error|fail|undefined' || echo 0)
TOTAL_COUNT=$(echo "$LOGS" | grep -c '.' || echo 0)
if [ "$TOTAL_COUNT" = "0" ]; then
  yellow "  ⚠ нет упоминаний max-bot в недавних логах"
elif [ "$ERR_COUNT" = "0" ]; then
  green "  ✓ $TOTAL_COUNT строк, без errors"
else
  yellow "  ⚠ $TOTAL_COUNT строк, из них $ERR_COUNT с error/fail"
  VERDICT_YELLOW=1
fi

# === Verdict ===
echo ""
echo "=== VERDICT ==="
if [ "$VERDICT_GREEN" = "0" ]; then
  red "🔴 ISSUES — есть критические проблемы (см. ✗ выше)"
elif [ "$VERDICT_YELLOW" = "1" ]; then
  yellow "🟡 PARTIAL — есть warning'и (см. ⚠ выше), но ничего критичного"
else
  green "🟢 READY — Max-бот полностью настроен и готов к работе"
  echo ""
  echo "Тестирование: открой $BOT_LINK в Max → /start → должна ответить Музa"
fi
echo ""
