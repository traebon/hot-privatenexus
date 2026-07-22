#!/bin/bash
# Pushes host + container facts into PrivateNexus's discovery pipeline
# (POST /api/discovery/ingest) so the Ops board has real data to review.
# Runs at boot and periodically via the discovery-agent.timer systemd unit.
set -euo pipefail

INSTALL_DIR="${PRIVATENEXUS_INSTALL_DIR:-/opt/privatenexus}"
TOKEN_FILE="$INSTALL_DIR/secrets/discovery_agent_token.txt"
INGEST_URL="${PRIVATENEXUS_INGEST_URL:-https://privatenexus.net/api/discovery/ingest}"

if [ ! -f "$TOKEN_FILE" ]; then
  echo "discovery-agent: token file not found at $TOKEN_FILE" >&2
  exit 1
fi

HOSTNAME_F=$(hostname)
OS_PRETTY=$(. /etc/os-release && echo "$PRETTY_NAME")
KERNEL=$(uname -r)
UPTIME_H=$(uptime -p)
CPU_CORES=$(nproc)
MEM_TOTAL_MB=$(free -m | awk '/^Mem:/{print $2}')
MEM_USED_MB=$(free -m | awk '/^Mem:/{print $3}')
DISK_TOTAL=$(df -h / | awk 'NR==2{print $2}')
DISK_USED=$(df -h / | awk 'NR==2{print $3}')
DISK_PCT=$(df -h / | awk 'NR==2{print $5}')
WG_HANDSHAKE=$(wg show wg0 latest-handshakes 2>/dev/null | awk '{print $2}')

DOCKER_PS_JSON=$(docker ps --format '{{json .}}' | jq -s '.')

TOKEN=$(cat "$TOKEN_FILE") \
HOSTNAME_F="$HOSTNAME_F" OS_PRETTY="$OS_PRETTY" KERNEL="$KERNEL" UPTIME_H="$UPTIME_H" \
CPU_CORES="$CPU_CORES" MEM_TOTAL_MB="$MEM_TOTAL_MB" MEM_USED_MB="$MEM_USED_MB" \
DISK_TOTAL="$DISK_TOTAL" DISK_USED="$DISK_USED" DISK_PCT="$DISK_PCT" \
WG_HANDSHAKE="$WG_HANDSHAKE" DOCKER_PS_JSON="$DOCKER_PS_JSON" INGEST_URL="$INGEST_URL" \
python3 <<'PYEOF'
import json, os, re, urllib.request

def slugify(name):
    return re.sub(r'^-|-$', '', re.sub(r'[^a-z0-9]+', '-', name.lower()))

hostname = os.environ["HOSTNAME_F"]

host_candidate = {
    "source": "system_info",
    "host": hostname,
    "raw_name": hostname,
    "raw_image": None,
    "suggested_slug": slugify(hostname),
    "suggested_name": f"{hostname} (PrivateNexus stand-in VPS)",
    "suggested_description": "Hostkey CH VPS — temporary PrivateNexus dev+test stand-in during the bare-metal outage (see hostkey_server_replacement)",
    "suggested_category": "infra",
    "suggested_access_mode": "vpn_only",
    "suggested_runtime": "vps",
    "suggested_health_ep": None,
    "raw_data": {
        "os": os.environ["OS_PRETTY"],
        "kernel": os.environ["KERNEL"],
        "uptime": os.environ["UPTIME_H"],
        "cpu_cores": int(os.environ["CPU_CORES"]),
        "mem_total_mb": int(os.environ["MEM_TOTAL_MB"]),
        "mem_used_mb": int(os.environ["MEM_USED_MB"]),
        "disk_total": os.environ["DISK_TOTAL"],
        "disk_used": os.environ["DISK_USED"],
        "disk_pct": os.environ["DISK_PCT"],
        "wg_tunnel_last_handshake_epoch": os.environ["WG_HANDSHAKE"] or None,
    },
}

# Images used purely as ephemeral, one-shot tooling (e.g. a bare curl call
# against another container, dead again within a second) — never a real
# long-running service. `docker ps` is a point-in-time snapshot, so an
# unlucky timer firing can still catch one mid-life; exclude by image so it
# never gets queued as a discovery candidate in the first place.
EPHEMERAL_PROBE_IMAGE_PREFIXES = ("curlimages/curl",)

candidates = [host_candidate]
for c in json.loads(os.environ["DOCKER_PS_JSON"]):
    name = c.get("Names", "")
    if not name:
        continue
    image = c.get("Image", "")
    if image.startswith(EPHEMERAL_PROBE_IMAGE_PREFIXES):
        continue
    candidates.append({
        "source": "docker",
        "host": hostname,
        "raw_name": name,
        "raw_image": c.get("Image"),
        "suggested_slug": slugify(name),
        "suggested_name": name,
        "suggested_description": None,
        "suggested_category": "app",
        "suggested_access_mode": "internal",
        "suggested_runtime": "docker",
        "suggested_health_ep": None,
        "raw_data": {
            "status": c.get("Status"),
            "ports": c.get("Ports"),
            "created_at": c.get("CreatedAt"),
        },
    })

payload = json.dumps({"candidates": candidates}).encode()
req = urllib.request.Request(
    os.environ["INGEST_URL"],
    data=payload,
    headers={
        "Authorization": f"Bearer {os.environ['TOKEN']}",
        "Content-Type": "application/json",
    },
    method="POST",
)
with urllib.request.urlopen(req, timeout=15) as resp:
    print(resp.read().decode())
PYEOF
