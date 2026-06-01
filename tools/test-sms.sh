#!/usr/bin/env bash
# tools/test-sms.sh — Тестовый прогон SMS-OTP endpoint'ов на проде.
# Eugene 2026-05-15 Босс «один файл — один paste».
#
# Использование (на VPS muziai.ru или с любого хоста с доступом в интернет):
#
#   bash tools/test-sms.sh status                  — проверка /providers
#   bash tools/test-sms.sh send +79138209174       — отправить OTP на номер
#   bash tools/test-sms.sh verify +79138209174 123456 — подтвердить кодом
#   bash tools/test-sms.sh logs                    — последние 10 SMS-логов (требует admin token в SMS_ADMIN_TOKEN env)
#
# Скрипт не хранит номера и коды — всё параметром.

set -euo pipefail

BASE="${SMS_BASE:-https://muziai.ru}"
ACTION="${1:-status}"
PHONE="${2:-}"
CODE="${3:-}"

hr() { echo "================================================================"; }
pj() {
  # Печатаем JSON ответ, jq если есть, иначе сырой.
  if command -v jq >/dev/null 2>&1; then jq .; else cat; fi
}

case "$ACTION" in
  status)
    echo "→ GET $BASE/api/auth/sms/providers"
    hr
    curl -sSL "$BASE/api/auth/sms/providers" | pj
    hr
    echo "Если configured=false → задай SMSRU_API_ID в .env, рестартни pm2."
    ;;
  send)
    if [ -z "$PHONE" ]; then
      echo "Использование: bash tools/test-sms.sh send +79261234567"
      exit 1
    fi
    echo "→ POST $BASE/api/auth/sms/send-otp { phone: $PHONE, purpose: register }"
    hr
    curl -sSL -X POST "$BASE/api/auth/sms/send-otp" \
      -H 'Content-Type: application/json' \
      -d "{\"phone\":\"$PHONE\",\"purpose\":\"register\"}" | pj
    hr
    echo "Если data.sent=true → жди SMS, потом verify с кодом."
    echo "Если error содержит 'не настроен' / 'not configured' → нужно SMSRU_API_ID."
    ;;
  verify)
    if [ -z "$PHONE" ] || [ -z "$CODE" ]; then
      echo "Использование: bash tools/test-sms.sh verify +79261234567 123456"
      exit 1
    fi
    echo "→ POST $BASE/api/auth/sms/verify-otp { phone: $PHONE, code: $CODE, purpose: register }"
    hr
    curl -sSL -X POST "$BASE/api/auth/sms/verify-otp" \
      -H 'Content-Type: application/json' \
      -d "{\"phone\":\"$PHONE\",\"code\":\"$CODE\",\"purpose\":\"register\"}" | pj
    hr
    echo "Если data.verified=true → OTP корректен (финал register — следующий коммит)."
    ;;
  logs)
    if [ -z "${SMS_ADMIN_TOKEN:-}" ]; then
      echo "Нужен admin token. Запусти: SMS_ADMIN_TOKEN=<твой_токен> bash tools/test-sms.sh logs"
      exit 1
    fi
    echo "→ GET $BASE/api/admin/v304/sms-logs?limit=10"
    hr
    curl -sSL -H "Authorization: Bearer $SMS_ADMIN_TOKEN" \
      "$BASE/api/admin/v304/sms-logs?limit=10" | pj
    hr
    ;;
  *)
    echo "Использование:"
    echo "  bash tools/test-sms.sh status                  — статус SMS-провайдера"
    echo "  bash tools/test-sms.sh send +79261234567       — отправить OTP"
    echo "  bash tools/test-sms.sh verify +79261234567 123456 — подтвердить кодом"
    echo "  bash tools/test-sms.sh logs                    — последние 10 SMS-логов (SMS_ADMIN_TOKEN env)"
    echo
    echo "Переменные окружения:"
    echo "  SMS_BASE        (default: https://muziai.ru) — base URL"
    echo "  SMS_ADMIN_TOKEN — для logs (admin Bearer token)"
    exit 1
    ;;
esac
