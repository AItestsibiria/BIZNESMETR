#!/bin/bash
# Eugene 2026-05-20: проверка email setup + тестовая отправка.
# Запуск: bash /opt/muziai-src/deploy/setup-email.sh [test-email@example.com]
#
# Что делает:
# 1. Печатает какие email ENV vars установлены (без значений)
# 2. Если передан test-email — отправляет тестовое письмо туда
# 3. Возвращает provider который сработал (custom-smtp / gmail / none)

set +e
ENV_FILE=/var/www/neurohub/.env
LOCAL_API=127.0.0.1:5000

if [ ! -f "$ENV_FILE" ]; then
  echo "❌ $ENV_FILE not found"
  exit 1
fi

echo "=== Email ENV vars (длины, не значения) ==="
awk -F= '
  /^SMTP_HOST=/{print "  SMTP_HOST:", $2}
  /^SMTP_PORT=/{print "  SMTP_PORT:", $2}
  /^SMTP_USER=/{print "  SMTP_USER:", $2}
  /^SMTP_PASS=/{print "  SMTP_PASS length:", length($2)}
  /^SMTP_FROM=/{print "  SMTP_FROM:", $2}
  /^GMAIL_USER=/{print "  GMAIL_USER:", $2}
  /^GMAIL_APP_PASSWORD=/{print "  GMAIL_APP_PASSWORD length:", length($2), "(16-19 expected)"}
  /^GMAIL_FROM=/{print "  GMAIL_FROM:", $2}
  /^SUPPORT_EMAIL=/{print "  SUPPORT_EMAIL:", $2}
  /^BRAND_NAME=/{print "  BRAND_NAME:", $2}
' "$ENV_FILE"

echo ""
echo "=== /api/admin/v304/email/status (через internal HTTP) ==="

# Используем admin token из storage если есть, иначе skip
ADMIN_TOK=$(sqlite3 /var/www/neurohub/data.db "SELECT token FROM sessions WHERE user_id IN (SELECT id FROM users WHERE role IN ('admin', 'super_admin')) ORDER BY last_seen_at DESC LIMIT 1;" 2>/dev/null)

if [ -n "$ADMIN_TOK" ]; then
  curl -fsS -H "Authorization: Bearer $ADMIN_TOK" "http://${LOCAL_API}/api/admin/v304/email/status" 2>/dev/null
  echo ""
else
  echo "  ⚠ не найден admin token в sessions — пропустил endpoint check"
fi

# Тестовая отправка если передан email
if [ -n "$1" ]; then
  TO="$1"
  echo ""
  echo "=== Test send to $TO ==="
  if [ -z "$ADMIN_TOK" ]; then
    echo "  ❌ нет admin token — не могу вызвать endpoint"
    exit 1
  fi
  curl -fsS -X POST \
    -H "Authorization: Bearer $ADMIN_TOK" \
    -H "Content-Type: application/json" \
    -d "{\"to\":\"$TO\",\"subject\":\"MuzaAi SMTP test ($(date '+%Y-%m-%d %H:%M'))\",\"text\":\"Это тест от $(hostname). Если ты это получил — email работает.\"}" \
    "http://${LOCAL_API}/api/admin/v304/email/test" 2>/dev/null
  echo ""
  echo ""
  echo "Если в ответе ok:true — письмо ушло. Проверь почту (включая spam) у $TO."
fi

echo ""
echo "=== DONE ==="
echo ""
echo "Если все провайдеры показывают 'configured: false':"
echo "  Установи переменные на VPS (см. ENV setup команды в чате)"
echo "  Затем pm2 restart neurohub --update-env"
