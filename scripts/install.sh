#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_EXAMPLE="$ROOT_DIR/config/.env.example"
TARGET_DIR="/opt/privatenexus"

if [[ $EUID -ne 0 ]]; then
  echo "Run as root or with sudo."
  exit 1
fi

if [[ ! -f "$ENV_EXAMPLE" ]]; then
  echo "Missing $ENV_EXAMPLE"
  exit 1
fi

read -r -p "Install path [$TARGET_DIR]: " INPUT_DIR
TARGET_DIR="${INPUT_DIR:-$TARGET_DIR}"

read -r -p "Frontend port [5173]: " INPUT_FRONTEND_PORT
FRONTEND_PORT="${INPUT_FRONTEND_PORT:-5173}"

read -r -p "Backend port [3001]: " INPUT_BACKEND_PORT
BACKEND_PORT="${INPUT_BACKEND_PORT:-3001}"

echo "[1/6] Installing dependencies"
apt-get update
apt-get install -y ca-certificates curl git jq

if ! command -v docker >/dev/null 2>&1; then
  echo "[2/6] Installing Docker"
  curl -fsSL https://get.docker.com | sh
fi

mkdir -p "$TARGET_DIR"

echo "[3/6] Copying bundle to $TARGET_DIR"
rsync -a --delete \
  --exclude '.git' \
  --exclude 'node_modules' \
  --exclude 'dist' \
  "$ROOT_DIR/" "$TARGET_DIR/"

echo "[4/6] Writing environment file"
cat > "$TARGET_DIR/.env" <<EOF
PRIVATENEXUS_INSTALL_DIR=$TARGET_DIR
PRIVATENEXUS_FRONTEND_PORT=$FRONTEND_PORT
PRIVATENEXUS_BACKEND_PORT=$BACKEND_PORT
PRIVATENEXUS_VERSION=$(cat "$TARGET_DIR/VERSION")
EOF

echo "[5/6] Building and starting services"
cd "$TARGET_DIR/compose"
docker compose --env-file ../.env up -d --build

echo "[6/6] Done"
IP_ADDR="$(hostname -I | awk '{print $1}')"
echo "PrivateNexus installed"
echo "Frontend: http://$IP_ADDR:$FRONTEND_PORT"
echo "Backend:  http://$IP_ADDR:$BACKEND_PORT/api/health"
