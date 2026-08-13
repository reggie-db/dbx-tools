#!/usr/bin/env bash
set -euo pipefail

DOMAIN="${DOMAIN:-dbx.tools}"
API_ROOT="https://api.cloudflare.com/client/v4"

if [[ -z "${CLOUDFLARE_API_TOKEN:-}" ]]; then
  echo "CLOUDFLARE_API_TOKEN is required" >&2
  exit 1
fi

request() {
  curl -fsS \
    -H "Authorization: Bearer ${CLOUDFLARE_API_TOKEN}" \
    -H "Content-Type: application/json" \
    "$@"
}

zone_id="$(
  request "${API_ROOT}/zones?name=${DOMAIN}&status=active" |
    jq -er '.result | if length == 1 then .[0].id else error("expected one active zone") end'
)"

existing="$(
  request "${API_ROOT}/zones/${zone_id}/dns_records?name=${DOMAIN}&per_page=100"
)"

while IFS= read -r record_id; do
  request -X DELETE "${API_ROOT}/zones/${zone_id}/dns_records/${record_id}" >/dev/null
done < <(
  jq -r '.result[] | select(.type == "A" or .type == "AAAA" or .type == "CNAME") | .id' \
    <<<"${existing}"
)

create_record() {
  local type="$1"
  local content="$2"
  local body
  body="$(
    jq -n \
      --arg type "${type}" \
      --arg name "${DOMAIN}" \
      --arg content "${content}" \
      '{type: $type, name: $name, content: $content, ttl: 1, proxied: false}'
  )"
  request \
    -X POST \
    --data "${body}" \
    "${API_ROOT}/zones/${zone_id}/dns_records" |
    jq -e '.success == true' >/dev/null
}

for address in \
  185.199.108.153 \
  185.199.109.153 \
  185.199.110.153 \
  185.199.111.153; do
  create_record A "${address}"
done

for address in \
  2606:50c0:8000::153 \
  2606:50c0:8001::153 \
  2606:50c0:8002::153 \
  2606:50c0:8003::153; do
  create_record AAAA "${address}"
done

echo "Configured ${DOMAIN} for GitHub Pages with Cloudflare proxying disabled."
