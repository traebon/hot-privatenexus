# Recovery Runbook — PowerDNS API

External dependency, not run or backed up by PrivateNexus. Hosted on the
Gateway VPS, bound to the WireGuard interface (`10.10.0.1:8081`). Backs
PrivateNexus's DNS board — reading and writing real records for
house-of-trae.com, securenexus.net, and the other managed zones.

## Why PrivateNexus doesn't back this up

The zone data itself lives in PowerDNS's own database on the Gateway VPS,
covered by the Gateway's own backup routine, not PrivateNexus's. PrivateNexus
only ever calls the API — it holds no independent copy of DNS state.

**See:** `https://github.com/traebon/hot-config/blob/main/CLAUDE.md`,
section **"PowerDNS"** (API port, key location, zone list) and the
**"Operational Rules"** table (`PowerDNS API` row — port 8081, not 8053).

## Impact of this API being unreachable

The DNS board in PrivateNexus stops working (can't read or write records).
No other board depends on it. DNS resolution itself is unaffected — that's
served by the authoritative nameservers independently of the management API.

## Verify

`nc -z 10.10.0.1 8081` from within the WireGuard mesh, or an authenticated
`GET /api/v1/servers/localhost` with the API key.
