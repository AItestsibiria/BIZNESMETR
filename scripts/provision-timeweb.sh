#!/usr/bin/env bash
# Create the Novo AI VPS on Timeweb Cloud via API.
#
# Usage:
#   export TIMEWEB_TOKEN='<your token; create at https://timeweb.cloud → API>'
#   bash scripts/provision-timeweb.sh
#
# Optional env overrides (with their defaults):
#   NAME=novo-ai                  Server display name on Timeweb
#   CPU=1                         vCPU count (1..8)
#   RAM_MB=2048                   RAM in MB
#   DISK_GB=30                    Disk in GB
#   LOCATION=ru-1                 Datacenter (ru-1 = Moscow; ru-2 / pl-1 also valid)
#   OS_NAME='Ubuntu 22.04'        Substring match against the OS list
#   SSH_KEY_IDS=                  Comma-separated Timeweb SSH key IDs to inject
#                                 (create one at https://timeweb.cloud → SSH-ключи).
#                                 If empty, Timeweb mails a root password.
#
# What it does:
#   1) Validates token against /api/v1/account/status
#   2) Lists configurators, picks the cheapest one supporting Linux + the
#      requested CPU/RAM/disk ranges
#   3) Finds the OS_ID for OS_NAME (Ubuntu 22.04 by default)
#   4) POSTs /api/v1/servers with the resolved config
#   5) Prints the new server's id, status and IPv4 (waits up to 90s for it)
#
# This script never echoes the token. Set +x style debugging is on for the
# config-resolution steps but off for any HTTP body that may contain the
# token in headers.

set -euo pipefail

if [[ -z "${TIMEWEB_TOKEN:-}" ]]; then
  echo "ERROR: TIMEWEB_TOKEN is not set." >&2
  echo "       export it first: 'export TIMEWEB_TOKEN=<your_token>'" >&2
  exit 2
fi

NAME="${NAME:-novo-ai}"
CPU="${CPU:-1}"
RAM_MB="${RAM_MB:-2048}"
DISK_GB="${DISK_GB:-30}"
LOCATION="${LOCATION:-ru-1}"
OS_NAME="${OS_NAME:-Ubuntu 22.04}"
SSH_KEY_IDS="${SSH_KEY_IDS:-}"

API="https://api.timeweb.cloud/api/v1"
AUTH_HEADER="Authorization: Bearer ${TIMEWEB_TOKEN}"
CT_HEADER="Content-Type: application/json"
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT

require_jq() {
  if ! command -v jq >/dev/null 2>&1; then
    echo "ERROR: 'jq' is required. Install via: apt install jq (Debian/Ubuntu) or brew install jq (macOS)." >&2
    exit 2
  fi
}

http_get() {
  # $1 = path; result body to stdout, status code to stderr
  local code
  code=$(curl -sS -o "$TMP/body" -w "%{http_code}" --max-time 30 \
    -H "$AUTH_HEADER" -H "$CT_HEADER" "$API$1")
  echo "$code" >&2
  cat "$TMP/body"
}

http_post() {
  # $1 = path, $2 = body file
  local code
  code=$(curl -sS -o "$TMP/body" -w "%{http_code}" --max-time 30 \
    -X POST -H "$AUTH_HEADER" -H "$CT_HEADER" --data-binary @"$2" "$API$1")
  echo "$code" >&2
  cat "$TMP/body"
}

main() {
  require_jq

  echo "→ Step 1/5: validating token…"
  local status
  status=$(http_get "/account/status" 2> "$TMP/code") || true
  if [[ "$(cat "$TMP/code")" != "200" ]]; then
    echo "ERROR: token invalid or no access. Got HTTP $(cat "$TMP/code"). Body:" >&2
    head -c 300 "$TMP/body" >&2; echo >&2
    exit 1
  fi
  local balance
  balance=$(echo "$status" | jq -r '.status.balance // "?"' 2>/dev/null || echo "?")
  echo "  ✓ token OK · balance: $balance RUB"

  echo "→ Step 2/5: finding a configurator that fits $CPU vCPU / $RAM_MB MB / $DISK_GB GB…"
  local cfg_body cfg_id
  cfg_body=$(http_get "/configurator/servers" 2>/dev/null)
  cfg_id=$(echo "$cfg_body" | jq -r --argjson cpu "$CPU" --argjson ram "$RAM_MB" --argjson disk "$DISK_GB" '
    [.server_configurators[]
      | select(.type == "standard" or .type == "shared" or .type == null)
      | select(.requirements.cpu_min <= $cpu and .requirements.cpu_max >= $cpu)
      | select(.requirements.ram_min <= $ram and .requirements.ram_max >= $ram)
      | select(.requirements.disk_min <= $disk and .requirements.disk_max >= $disk)
      | select(any(.locations[]?; . == "'"$LOCATION"'"))
    ] | min_by(.requirements.cpu_min) | .id // empty
  ')
  if [[ -z "$cfg_id" || "$cfg_id" == "null" ]]; then
    echo "  ! No matching configurator found. Dumping available IDs for manual selection:" >&2
    echo "$cfg_body" | jq '.server_configurators[] | {id, type, locations, requirements}' >&2
    exit 1
  fi
  echo "  ✓ configurator_id: $cfg_id"

  echo "→ Step 3/5: looking up OS '$OS_NAME' in location $LOCATION…"
  local os_body os_id
  os_body=$(http_get "/os/servers" 2>/dev/null)
  os_id=$(echo "$os_body" | jq -r --arg n "$OS_NAME" --arg loc "$LOCATION" '
    [.servers_os[] | select(.name | ascii_downcase | contains($n | ascii_downcase))] | .[0].id // empty
  ')
  if [[ -z "$os_id" || "$os_id" == "null" ]]; then
    echo "  ! OS '$OS_NAME' not found. Available:" >&2
    echo "$os_body" | jq '.servers_os[] | {id, name, version}' >&2
    exit 1
  fi
  echo "  ✓ os_id: $os_id"

  echo "→ Step 4/5: creating server '$NAME'…"
  cat > "$TMP/create.json" <<JSON
{
  "name": "$NAME",
  "os_id": $os_id,
  "configurator": {
    "id": $cfg_id,
    "cpu": $CPU,
    "ram": $RAM_MB,
    "disk": $((DISK_GB * 1024))
  },
  "availability_zone": "$LOCATION"
$(if [[ -n "$SSH_KEY_IDS" ]]; then
    echo ","
    echo '  "ssh_keys_ids": [' "$(echo "$SSH_KEY_IDS" | sed 's/,/, /g')" ']'
  fi)
}
JSON
  local create_body server_id
  create_body=$(http_post "/servers" "$TMP/create.json" 2> "$TMP/code")
  if [[ "$(cat "$TMP/code")" -ge "300" ]]; then
    echo "ERROR: server creation failed: HTTP $(cat "$TMP/code")" >&2
    echo "$create_body" | head -c 1000 >&2; echo >&2
    exit 1
  fi
  server_id=$(echo "$create_body" | jq -r '.server.id // empty')
  if [[ -z "$server_id" ]]; then
    echo "ERROR: server.id missing in response:" >&2
    echo "$create_body" | head -c 1000 >&2; echo >&2
    exit 1
  fi
  echo "  ✓ created server id: $server_id"

  echo "→ Step 5/5: waiting for IPv4 (up to 90s)…"
  local ip status_now elapsed=0
  while (( elapsed < 90 )); do
    local info
    info=$(http_get "/servers/$server_id" 2>/dev/null)
    status_now=$(echo "$info" | jq -r '.server.status // "?"')
    ip=$(echo "$info" | jq -r '.server.networks[]? | select(.type == "public_v4") | .ips[]?.ip // empty' | head -n1)
    if [[ -n "$ip" && "$status_now" == "on" ]]; then break; fi
    echo "  status: $status_now · ip: ${ip:-not yet}"
    sleep 5
    elapsed=$((elapsed + 5))
  done

  echo
  echo "=============================================================="
  echo "  Novo AI VPS provisioned"
  echo "  id:     $server_id"
  echo "  name:   $NAME"
  echo "  status: $status_now"
  echo "  ipv4:   ${ip:-(not yet — check Timeweb panel)}"
  echo "  ssh:    ssh root@${ip:-<ip>}"
  if [[ -z "$SSH_KEY_IDS" ]]; then
    echo "  note:   Timeweb has emailed the root password to your account email."
  fi
  echo "=============================================================="
  echo
  echo "NEXT: continue from runbook section 2 (harden + non-root user)."
  echo "      AFTER deploy works → REVOKE this API token in Timeweb panel."
}

main "$@"
