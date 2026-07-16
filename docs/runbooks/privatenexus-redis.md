# Recovery Runbook — privatenexus-redis

Cache/queue layer per the Phase 0 stack freeze — no persistent volume
configured (`redis:7-alpine`, no `volumes:` entry in
`/opt/privatenexus/compose/docker-compose.yml`), so its contents are already
in-memory-only and lost on any container restart regardless of backup
policy. A formal backup policy would be meaningless here — there is nothing
durable to protect.

## Recovery

```
cd /opt/privatenexus/compose
docker compose up -d privatenexus-redis
```

The backend has a `condition: service_healthy` dependency on this container,
so restarting `privatenexus-backend` afterward (or letting Compose's
dependency ordering handle it) is enough to pick it back up cleanly.

## Impact of loss

- Active user sessions cached here are dropped — affected users need to log
  in again via Keycloak. No data corruption risk, just a re-auth prompt.
- Any in-flight background job queue entries are lost. Given the queue here
  backs periodic/idempotent work (health scheduling, intelligence scans),
  the next scheduled cycle re-populates state — nothing needs manual replay.

## RTO estimate

Seconds — this is a plain container restart, no rebuild or data restore
involved.
