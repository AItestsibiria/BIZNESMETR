#!/bin/bash
# Полная диагностика Max-бота на prod muzaai.ru
# Использование: bash /opt/muziai-src/deploy/check-max-bot.sh
# или из репо: bash $(dirname $0)/check-max-bot.sh

set +e
ENV_FILE=/var/www/neurohub/.env
LOCAL_API=127.0.0.1:5000

echo "=== ENV (Max vars) ==="
if [ ! -f "$ENV_FILE" ]; then
  echo "❌ $ENV_FILE not found"
  exit 1
fi

awk -F= '
  /^MAX_BOT_TOKEN=/{print "MAX_BOT_TOKEN length:", length($2), "(empty=0)"}
  /^MAX_WEBHOOK_SECRET=/{print "MAX_WEBHOOK_SECRET length:", length($2), "(expect 44)"}
  /^MAX_BOT_ID=/{print "MAX_BOT_ID:", $2}
  /^MAX_BOT_LINK=/{print "MAX_BOT_LINK:", $2}
  /^MAX_API_BASE=/{print "MAX_API_BASE:", $2}
  /^CRON_SECRET=/{print "CRON_SECRET length:", length($2)}
  /^PUBLIC_BASE_URL=/{print "PUBLIC_BASE_URL:", $2}
' "$ENV_FILE"

echo ""
echo "=== PM2 status ==="
pm2 jlist 2>/dev/null | jq -r '.[] | select(.name=="neurohub") | "name: " + .name + " | status: " + .pm2_env.status + " | restarts: " + (.pm2_env.restart_time|tostring) + " | uptime sec: " + (((now*1000 - .pm2_env.pm_uptime)/1000)|floor|tostring)' 2>/dev/null || echo "❌ pm2 jlist failed"

echo ""
echo "=== Local /api/max-bot/status ==="
curl -fsS "http://${LOCAL_API}/api/max-bot/status" 2>/dev/null | jq . 2>/dev/null || echo "❌ endpoint failed (server down or route not registered)"

echo ""
echo "=== Max API getMe (using token from .env) ==="
TOK=$(grep '^MAX_BOT_TOKEN=' "$ENV_FILE" | cut -d= -f2-)
BASE=$(grep '^MAX_API_BASE=' "$ENV_FILE" | cut -d= -f2-)
[ -z "$BASE" ] && BASE="https://botapi.max.ru"

if [ -z "$TOK" ]; then
  echo "❌ MAX_BOT_TOKEN пуст — пропустил getMe"
else
  echo "API base: $BASE"
  curl -fsS "${BASE}/me?access_token=${TOK}" 2>/dev/null | jq . 2>/dev/null || curl -s "${BASE}/me?access_token=${TOK}"
fi

echo ""
echo "=== Webhook subscriptions ==="
if [ -n "$TOK" ]; then
  curl -fsS "${BASE}/subscriptions?access_token=${TOK}" 2>/dev/null | jq . 2>/dev/null || curl -s "${BASE}/subscriptions?access_token=${TOK}"
fi

echo ""
echo "=== Recent logs (max-bot last 30 lines) ==="
pm2 logs neurohub --nostream --lines 200 2>&1 | grep -iE 'max-bot|max_bot|max webhook|max ping' | tail -30 || echo "(no max-bot mentions in recent logs)"

echo ""
echo "=== DONE ==="
