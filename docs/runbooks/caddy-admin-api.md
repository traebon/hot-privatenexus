# Recovery Runbook — Caddy Admin API

External dependency, not run or backed up by PrivateNexus, and **not
currently functional by design** — the Gateway VPS's `Caddyfile` has
`admin off` (line 2), a deliberate security choice. Confirmed live
(2026-07-16): PowerDNS and Keycloak, hosted on the same Gateway box, both
respond normally over the same network path — this isolates the
unreachability specifically to the admin API being intentionally disabled,
not a connectivity fault.

## Why PrivateNexus doesn't back this up

There's nothing running to back up — the admin API doesn't listen at all.
`discovery.js`'s `scanCaddy()` source (Proxmox-style Caddy route discovery)
is the only PrivateNexus feature that would use this, and it's non-functional
as long as `admin off` stands.

**See:** `https://github.com/traebon/hot-config/blob/main/CLAUDE.md`,
`/opt/stacks/caddy/Caddyfile` line 2, and the **"Operational Rules"** table
(`Caddy reload` row — the documented, correct way to apply config changes
without the admin API: `docker compose restart caddy`).

## If this ever needs to change

Re-enabling the admin API is a real security-relevant decision (unauthenticated
by default, full config-mutation control) — don't flip `admin off` to fix this
runbook without confirming with Mr. Byrne first. Caddy config changes are
already handled correctly without it, via the tracked `Caddyfile` + restart.

## Impact

Discovery's Caddy-based scan source doesn't work. No other PrivateNexus
feature depends on this. Caddy itself is fully healthy and serving traffic —
this only affects PrivateNexus's ability to introspect its routes via API.
