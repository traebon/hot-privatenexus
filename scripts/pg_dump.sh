#!/bin/bash
# Daily PostgreSQL dump for PrivateNexus
# Output compressed to /opt/privatenexus/backups/, and registered in the
# app's own service_backups table so Governance/Recovery reflect reality.
set -euo pipefail

BACKUP_DIR=/opt/privatenexus/backups
TIMESTAMP=$(date +%Y%m%d_%H%M%S)
FILE="${BACKUP_DIR}/privatenexus_${TIMESTAMP}.sql.gz"
KEEP_DAYS=14

TENANT_ID="10000000-0000-0000-0000-000000000001"
SERVICE_ID="2f461571-7aaa-4501-9f8b-dc8ac8255498"  # privatenexus-db

mkdir -p "$BACKUP_DIR"

docker exec privatenexus-db pg_dump \
  -U privatenexus \
  -d privatenexus \
  --no-password \
  | gzip > "$FILE"

SIZE_BYTES=$(stat -c%s "$FILE")
if [ "$SIZE_BYTES" -lt 1024 ]; then
  echo "pg_dump produced a suspiciously small file (${SIZE_BYTES} bytes) — not registering as trusted" >&2
  exit 1
fi

# Register the backup so the app's own governance/recovery views (and
# service_backups-backed features like the Recovery Plan modal) see it.
docker exec -i privatenexus-db psql -U privatenexus -d privatenexus -v ON_ERROR_STOP=1 \
  -v tenant="$TENANT_ID" -v service="$SERVICE_ID" \
  -v label="Automated daily pg_dump — ${TIMESTAMP}" \
  -v location="pn-vps:${FILE}" -v size="$SIZE_BYTES" <<'SQL'
INSERT INTO service_backups (tenant_id, service_id, label, backup_type, trust_state, location, size_bytes, notes)
VALUES (:'tenant', :'service', :'label', 'full', 'trusted', :'location', :size,
        'Local dump on pn-vps + off-host copy pulled nightly to the Gateway VPS — see pg_dump.sh / gateway-side pull timer');
SQL

# Prune old local dumps beyond retention window
find "$BACKUP_DIR" -name 'privatenexus_*.sql.gz' -mtime +${KEEP_DAYS} -delete

SIZE=$(du -sh "$FILE" | cut -f1)
echo "pg_dump complete: $FILE ($SIZE) — registered in service_backups"
