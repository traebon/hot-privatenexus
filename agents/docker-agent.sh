#!/bin/bash
# PrivateNexus Docker Discovery Agent
# Run on any Docker host to push container candidates to PrivateNexus.
#
# Usage:
#   PRIVATENEXUS_URL=https://privatenexus.net \
#   DISCOVERY_AGENT_TOKEN=your-token \
#   ./docker-agent.sh
#
# Optional env:
#   AGENT_HOST  — label for this host (defaults to hostname)
#   DRY_RUN=1   — print JSON without posting

set -euo pipefail

PN_URL="${PRIVATENEXUS_URL:?Set PRIVATENEXUS_URL}"
TOKEN="${DISCOVERY_AGENT_TOKEN:?Set DISCOVERY_AGENT_TOKEN}"
HOST_LABEL="${AGENT_HOST:-$(hostname)}"
DRY_RUN="${DRY_RUN:-0}"

command -v docker  >/dev/null 2>&1 || { echo "docker not found"; exit 1; }
command -v jq      >/dev/null 2>&1 || { echo "jq not found — apt install jq"; exit 1; }
command -v curl    >/dev/null 2>&1 || { echo "curl not found"; exit 1; }

to_slug() {
  echo "$1" | tr '[:upper:]' '[:lower:]' | sed 's/[^a-z0-9]/-/g' | sed 's/^-//;s/-$//'
}

infer_category() {
  local img="${1,,}"
  case "$img" in
    *postgres*|*mariadb*|*mysql*|*redis*|*mongo*) echo "database" ;;
    *nginx*|*caddy*|*traefik*|*apache*)            echo "proxy"    ;;
    *grafana*|*prometheus*|*loki*|*uptime*)        echo "monitoring" ;;
    *keycloak*|*vault*|*authelia*)                 echo "security" ;;
    *forgejo*|*gitea*|*gitlab*)                    echo "vcs"      ;;
    *nextcloud*|*immich*|*vaultwarden*)            echo "personal" ;;
    *erpnext*|*frappe*)                            echo "business" ;;
    *)                                             echo "app"      ;;
  esac
}

CANDIDATES="[]"

while IFS= read -r line; do
  NAME=$(echo "$line"   | jq -r '.Names[0] // empty' | sed 's|^/||')
  IMAGE=$(echo "$line"  | jq -r '.Image // empty')
  LABELS=$(echo "$line" | jq -r '.Labels // {}')

  [[ -z "$NAME" ]] && continue

  SLUG=$(to_slug "$NAME")
  [[ -z "$SLUG" ]] && continue

  CATEGORY=$(infer_category "$IMAGE")

  # Read optional pn.* Docker labels
  PN_NAME=$(echo "$LABELS"      | jq -r '."pn.name"          // empty')
  PN_DESC=$(echo "$LABELS"      | jq -r '."pn.description"   // empty')
  PN_WS=$(echo "$LABELS"        | jq -r '."pn.workspace"     // empty')
  PN_CAT=$(echo "$LABELS"       | jq -r '."pn.category"      // empty')
  PN_ACCESS=$(echo "$LABELS"    | jq -r '."pn.access_mode"   // empty')
  PN_HEALTH=$(echo "$LABELS"    | jq -r '."pn.health_endpoint" // empty')

  SUGGESTED_NAME="${PN_NAME:-$NAME}"
  SUGGESTED_CAT="${PN_CAT:-$CATEGORY}"
  SUGGESTED_ACCESS="${PN_ACCESS:-internal}"

  CANDIDATE=$(jq -n \
    --arg source   "docker_agent" \
    --arg host     "$HOST_LABEL" \
    --arg raw_name "$NAME" \
    --arg raw_image "$IMAGE" \
    --arg slug     "$SLUG" \
    --arg name     "$SUGGESTED_NAME" \
    --arg desc     "$PN_DESC" \
    --arg ws       "$PN_WS" \
    --arg cat      "$SUGGESTED_CAT" \
    --arg access   "$SUGGESTED_ACCESS" \
    --arg health   "$PN_HEALTH" \
    --argjson labels "$LABELS" \
    '{
      source:                $source,
      host:                  $host,
      raw_name:              $raw_name,
      raw_image:             $raw_image,
      suggested_slug:        $slug,
      suggested_name:        $name,
      suggested_description: (if $desc != "" then $desc else null end),
      suggested_category:    $cat,
      suggested_access_mode: $access,
      suggested_runtime:     "docker",
      suggested_health_ep:   (if $health != "" then $health else null end),
      raw_data: { labels: $labels }
    }')

  CANDIDATES=$(echo "$CANDIDATES" | jq --argjson c "$CANDIDATE" '. + [$c]')

done < <(docker ps --format '{{json .}}')

COUNT=$(echo "$CANDIDATES" | jq 'length')
echo "Discovered $COUNT containers on $HOST_LABEL"

if [[ "$DRY_RUN" == "1" ]]; then
  echo "$CANDIDATES" | jq .
  exit 0
fi

RESPONSE=$(curl -sf -X POST \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $TOKEN" \
  -d "{\"candidates\": $CANDIDATES}" \
  "${PN_URL}/api/discovery/ingest")

echo "$RESPONSE" | jq .
