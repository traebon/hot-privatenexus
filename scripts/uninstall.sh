#!/usr/bin/env bash
set -euo pipefail
TARGET_DIR="/opt/privatenexus"
if [[ -d "$TARGET_DIR/compose" ]]; then
  cd "$TARGET_DIR/compose"
  docker compose --env-file ../.env down || true
fi
read -r -p "Remove $TARGET_DIR completely? [y/N]: " CONFIRM
if [[ "$CONFIRM" =~ ^[Yy]$ ]]; then
  rm -rf "$TARGET_DIR"
  echo "Removed $TARGET_DIR"
else
  echo "Stopped services only"
fi
