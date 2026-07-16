# Recovery Runbook — privatenexus-db

PostgreSQL 16 container holding all PrivateNexus application state (services
registry, audit log, governance rules/exceptions, discovery candidates,
intelligence signals, etc.). The only service in this stack with
irreplaceable data — everything else is rebuildable from git + image.

## Backup

- **Local (pn-vps):** `privatenexus-pg-dump.timer` runs `scripts/pg_dump.sh`
  daily at 03:00 CEST — `docker exec privatenexus-db pg_dump` piped to gzip,
  written to `/opt/privatenexus/backups/`, 14-day local retention. Each
  successful dump is registered in the `service_backups` table.
- **Off-host (Gateway VPS):** `backup-pn-vps-privatenexus-db.sh`
  (`hot-config`) runs daily at 03:30 CEST, `rsync`s the dump to
  `/var/backups/pn-vps-privatenexus-db/` on the Gateway (30-day retention),
  then pushes it into the existing `hetzner-crypt:pn-vps-privatenexus-db/`
  and `b2-hot-crypt:pn-vps-privatenexus-db/` rclone-crypt remotes — the same
  cloud pipeline the rest of the Gateway's backups use.

## Restore

1. Locate the dump to restore from (newest unless you specifically need an
   older point-in-time):
   - pn-vps: `ls -t /opt/privatenexus/backups/*.sql.gz | head -1`
   - Gateway (off-host copy): `ls -t /var/backups/pn-vps-privatenexus-db/*.sql.gz | head -1`
   - Cloud (if both hosts are lost): `rclone lsl hetzner-crypt:pn-vps-privatenexus-db/`
2. Stop the backend so nothing writes during restore:
   `docker compose -f /opt/privatenexus/compose/docker-compose.yml stop privatenexus-backend`
3. Restore into the running `privatenexus-db` container:
   ```
   gunzip -c privatenexus_<timestamp>.sql.gz | \
     docker exec -i privatenexus-db psql -U privatenexus -d privatenexus
   ```
   For a full clean restore (not a merge), drop and recreate the `public`
   schema first: `docker exec privatenexus-db psql -U privatenexus -d privatenexus -c "DROP SCHEMA public CASCADE; CREATE SCHEMA public;"`
   before piping the dump in.
4. Restart the backend: `docker compose -f /opt/privatenexus/compose/docker-compose.yml up -d privatenexus-backend`
5. Verify: `curl http://localhost:3001/api/health` should return `{"ok":true,...}`,
   and `docker exec privatenexus-db psql -U privatenexus -d privatenexus -c "SELECT COUNT(*) FROM services;"`
   should return 11 (or however many are registered as of the restored dump).
6. Register the restore itself as a change: `recordChange`/`recordAudit`
   entries happen automatically for anything done through the app afterward,
   but the restore action itself is manual — note it in
   `change_records` or just document it here in git history.

## RTO estimate

Dump size is ~100KB (small dataset) — restore itself takes seconds. Time is
dominated by locating the right backup and stopping/starting the backend
cleanly. Budget 15-30 minutes for a careful restore including verification.
