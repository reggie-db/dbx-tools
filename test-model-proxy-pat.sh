#!/usr/bin/env bash
# Test a Databricks PAT against the model-serving APIs the dbx-tools model proxy uses.
# Reads host + token from a .databrickscfg profile so the secret never appears on the
# command line or in this file.
#
# Usage: ./test-model-proxy-pat.sh [PROFILE] [ENDPOINT]
#   PROFILE  - .databrickscfg profile name (default: E2-DOGFOOD-DBX-TOOLS-MODEL-PROXY)
#   ENDPOINT - serving endpoint to invoke (default: auto-pick a chat endpoint from discovery)
set -uo pipefail

PROFILE="${1:-E2-DOGFOOD-DBX-TOOLS-MODEL-PROXY}"
ENDPOINT="${2:-}"
CFG="${DATABRICKS_CONFIG_FILE:-$HOME/.databrickscfg}"

read_field() {  # read_field <key> -> value from [PROFILE] section
  awk -v sec="[$PROFILE]" -v key="$1" '
    /^\[/     { insec = ($0 == sec) }
    insec && $1 == key { print $3; exit }
  ' "$CFG"
}

HOST="$(read_field host)"
TOKEN="$(read_field token)"
HOST="${HOST%/}"

if [[ -z "$HOST" || -z "$TOKEN" ]]; then
  echo "ERROR: could not read host/token for profile [$PROFILE] in $CFG" >&2
  exit 1
fi

echo "Profile: $PROFILE"
echo "Host:    $HOST"
echo "Token:   ${TOKEN:0:6}… (len ${#TOKEN})"
echo

hdr=(-H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json")

echo "=== [1] discovery — GET /api/2.0/serving-endpoints   (scope: model-serving) ==="
code=$(curl -sS -o /tmp/mp_list.json -w '%{http_code}' "$HOST/api/2.0/serving-endpoints" "${hdr[@]}")
echo "HTTP $code"
head -c 400 /tmp/mp_list.json; echo; echo

# auto-pick a chat endpoint from the discovery response if none was passed
if [[ -z "$ENDPOINT" && "$code" == "200" ]]; then
  ENDPOINT=$(jq -r '.endpoints[]? | select(.task=="llm/v1/chat") | .name' /tmp/mp_list.json 2>/dev/null | head -1)
fi
ENDPOINT="${ENDPOINT:-databricks-claude-sonnet-4-5}"

echo "=== [2] inference — POST /serving-endpoints/$ENDPOINT/invocations   (scope: model-serving-inference) ==="
code=$(curl -sS -o /tmp/mp_inv.json -w '%{http_code}' -X POST \
  "$HOST/serving-endpoints/$ENDPOINT/invocations" "${hdr[@]}" \
  -d '{"messages":[{"role":"user","content":"say hi in 3 words"}],"max_tokens":20}')
echo "HTTP $code"
head -c 600 /tmp/mp_inv.json; echo; echo

echo "Interpretation:"
echo "  [1] 200 + [2] 200        -> token has both model-serving and model-serving-inference"
echo "  [1] 401 + [2] 200        -> missing 'model-serving' (discovery); inference OK"
echo "  [1] 200 + [2] 401/403    -> missing 'model-serving-inference' or no CAN_QUERY on endpoint"
echo "  both 401                 -> token type/auth problem, not scope"
