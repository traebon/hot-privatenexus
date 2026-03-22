#!/usr/bin/env bash
set -euo pipefail
TARGET_DIR="/opt/privatenexus"
if [[ ! -d "$TARGET_DIR/compose" ]]; then
  echo "Install not found at $TARGET_DIR"
  exit 1
fi
cd "$TARGET_DIR/compose"
docker compose --env-file ../.env up -d --build
