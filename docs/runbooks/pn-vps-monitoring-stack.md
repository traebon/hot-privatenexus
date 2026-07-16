# Recovery Runbook — pn-prometheus / pn-loki / pn-node-exporter / pn-promtail

Local monitoring stand-in stood up on pn-vps (`/opt/stacks/monitoring-temp/`,
tracked in `hot-config` at `pn-vps/monitoring-temp/`) — monitors pn-vps
itself (not the wider HoT fleet) while `PROMETHEUS_URL`/`LOKI_URL` are
repointed here from sn-monitor during the bare-metal outage. All four sit on
the `compose_pn-internal` network only, no host ports published.

## Why there's no backup policy for these

Prometheus (`prometheus_data`) and Loki (`loki_data`) have named Docker
volumes holding real accumulated data — but it's retention-capped (15 days
for Prometheus, per `--storage.tsdb.retention.time=15d` in the compose
command) and inherently disposable observability data, not irreplaceable
records. node-exporter and Promtail have no persistent volume at all — they
're pure exporters/shippers with nothing to hold. See the
`backup_policy_required` governance exception recorded for each (2026-07-16)
for the same reasoning.

## Recovery

Config (compose files, `prometheus.yml`, `loki-config.yml`,
`promtail-config.yml`) lives in git (`hot-config`, `pn-vps/monitoring-temp/`)
— not on pn-vps alone. To rebuild from scratch:

```
cd /opt/stacks/monitoring-temp
docker compose up -d
```

If volumes were lost too (not just containers), this starts clean —
Prometheus/Loki simply begin accumulating fresh data with no gap-filling
needed; historical data prior to the loss is not recoverable, which is an
accepted trade-off for stand-in infrastructure like this.

## Known quirk

Loki's `/ready` endpoint returns a cosmetic 503
(`"waiting for 15s after being ready"`) even when healthy and correctly
ingesting logs — a documented single-node quirk. This is why its
`health_endpoint` in the PrivateNexus service registry uses a plain
`tcp://pn-loki:3100` check rather than an HTTP one; don't "fix" this by
switching it to an HTTP `/ready` check, it'll just generate false alarms.

## Verify

- `curl http://pn-prometheus:9090/-/healthy` (from inside `compose_pn-internal`)
- `docker logs pn-promtail --tail 20` — should show it successfully shipping
  to Loki, not connection errors
- Grafana/dashboard queries against Loki return recent log lines

## RTO estimate

A few minutes for containers to come back up; historical metrics/logs older
than the outage are gone but that's expected and accepted for this stack.
