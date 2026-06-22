#!/bin/bash
# Daily PostgreSQL dump for PrivateNexus
# Output compressed to /opt/privatenexus/backups/
set -euo pipefail

BACKUP_DIR=/opt/privatenexus/backups
TIMESTAMP=$(date +%Y%m%d_%H%M%S)
FILE="${BACKUP_DIR}/privatenexus_${TIMESTAMP}.sql.gz"
KEEP_DAYS=14

mkdir -p "$BACKUP_DIR"

docker exec privatenexus-db pg_dump \
  -U privatenexus \
  -d privatenexus \
  --no-password \
  | gzip > "$FILE"

# Prune old dumps beyond retention window
find "$BACKUP_DIR" -name 'privatenexus_*.sql.gz' -mtime +${KEEP_DAYS} -delete

SIZE=$(du -sh "$FILE" | cut -f1)
echo "pg_dump complete: $FILE ($SIZE)"
