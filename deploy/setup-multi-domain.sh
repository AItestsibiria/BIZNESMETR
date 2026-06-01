#!/bin/bash
# Eugene 2026-05-21: one-time setup для cross-domain stats aggregation.
# Генерирует MULTI_DOMAIN_SHARED_TOKEN + печатает ssh-команды установки
# на каждый VPS (muzaai / clone / podaripesnu).
#
# Usage:
#   bash deploy/setup-multi-domain.sh
#   bash deploy/setup-multi-domain.sh --peers https://muzaai.ru,https://clone.muziai.ru
#
# Что делает:
#   1. Генерирует random 32-byte base64 token через openssl
#   2. Печатает sed/echo ssh-команды для каждого VPS
#   3. Босс копирует команду в Termius и запускает на каждом VPS
#   4. После — admin-v304 → 🌐 Все домены покажет per-domain stats

set -e

# --- Parse args ---
PEERS_DEFAULT="https://muzaai.ru,https://clone.muziai.ru"
PEERS="$PEERS_DEFAULT"

while [[ $# -gt 0 ]]; do
  case $1 in
    --peers)
      PEERS="$2"
      shift 2
      ;;
    --help|-h)
      echo "Usage: $0 [--peers https://A,https://B]"
      echo ""
      echo "  --peers   CSV list of peer URLs (default: $PEERS_DEFAULT)"
      exit 0
      ;;
    *)
      echo "Unknown arg: $1"
      exit 1
      ;;
  esac
done

# --- Generate token ---
if ! command -v openssl >/dev/null 2>&1; then
  echo "❌ openssl не найден. Установи: brew install openssl (Mac) или apt install openssl (Linux)"
  exit 1
fi

TOKEN=$(openssl rand -base64 32 | tr -d '\n=' | tr '+/' '-_' | cut -c1-43)
TIMESTAMP=$(date -u +%FT%TZ)

echo "================================================================"
echo "🌐 Multi-domain stats — Setup инструкции"
echo "================================================================"
echo "Сгенерировано: $TIMESTAMP"
echo ""
echo "🔐 Generated MULTI_DOMAIN_SHARED_TOKEN (один и тот же на всех VPS):"
echo "   $TOKEN"
echo ""
echo "📋 Peers:"
echo "   $PEERS"
echo ""
echo "================================================================"
echo "📡 Команды для установки на каждый VPS"
echo "================================================================"
echo ""

# Известные VPS (Босс адаптирует под реальные хосты)
VPS_LIST=(
  "31.130.148.107:muzaai.ru (prod)"
  "72.56.1.149:clone.muziai.ru (staging)"
)

for entry in "${VPS_LIST[@]}"; do
  IP="${entry%%:*}"
  LABEL="${entry##*:}"

  echo "--- VPS: $LABEL ($IP) ---"
  cat <<EOF
ssh root@$IP 'sed -i "/^MULTI_DOMAIN_PEERS=/d; /^MULTI_DOMAIN_SHARED_TOKEN=/d" /var/www/neurohub/.env \\
  && echo "MULTI_DOMAIN_PEERS=$PEERS" >> /var/www/neurohub/.env \\
  && echo "MULTI_DOMAIN_SHARED_TOKEN=$TOKEN" >> /var/www/neurohub/.env \\
  && chmod 600 /var/www/neurohub/.env \\
  && pm2 restart neurohub --update-env'
EOF
  echo ""
done

echo "================================================================"
echo "✅ После выполнения на ВСЕХ VPS — открыть:"
echo "   https://muzaai.ru/admin/v304 → вкладка 🌐 Все домены"
echo "   (или https://clone.muziai.ru/admin/v304 для staging)"
echo ""
echo "🔍 Verify на каждом VPS (без раскрытия значения):"
echo "   ssh root@31.130.148.107 'awk -F= \"/^MULTI_DOMAIN/{print \\\$1, length(\\\$2)}\" /var/www/neurohub/.env'"
echo ""
echo "⚠️  Token хранится только в .env (chmod 600). Не коммитить в git!"
echo "⚠️  Если token попал в чат / git / лог — сгенерировать новый (re-run этого скрипта)"
echo "================================================================"
