# Recovery Runbook — watchtower

Monitor-only Watchtower instance on pn-vps (`/opt/stacks/watchtower/`,
tracked in `hot-config` at `pn-vps/watchtower/`). Pinned `v1.5.3`
(see the fleet-wide Watchtower version pin — v1.7.1 has a known Docker API
negotiation bug). Emails on available image updates for the three
locally-built PrivateNexus containers' dependencies; does not auto-apply
updates (`WATCHTOWER_MONITOR_ONLY=true`).

## Why there's no health check or backup policy

No listening port at all — confirmed via `nc` from inside
`compose_pn-internal` (2026-07-16): it's a cron-scheduled poller
(`WATCHTOWER_SCHEDULE=0 0 4 * * *`), not an HTTP service
(`WATCHTOWER_HTTP_API_UPDATE` is unset). The image `EXPOSE`s `8080/tcp` but
nothing actually listens there without that env var — don't be misled by
`docker inspect` showing the port as metadata. No persistent volume either
— purely a Docker-socket-reading scheduler with nothing stateful. Both the
`health_check_required` and `backup_policy_required` governance exceptions
recorded for this service (2026-07-16) document this same reasoning.

## Recovery

```
cd /opt/stacks/watchtower
docker compose up -d
```

Config, including the SMTP notification settings, is entirely in the
tracked `docker-compose.yml` (the SMTP password comes from
`WATCHTOWER_SMTP_PASSWORD` — check `.env` alongside the compose file if it's
missing after a rebuild).

## Verify

`docker logs watchtower --tail 20` — should show it completing a scan cycle
(runs at 04:00 daily) without Docker API errors. There's no health endpoint
to curl; container running + clean logs is the only available signal.

## RTO estimate

Seconds — plain container start, no data or rebuild involved.
