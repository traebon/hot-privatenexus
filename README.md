# PrivateNexus

**Infrastructure Operations Platform** — service inventory, health monitoring, backup visibility, safe operational actions, and a live activity feed. Built for self-hosted infrastructure teams.

## Version

1.0.0

## What it does

- **Inventory** — register and classify all services across workspaces; flag missing metadata
- **Health** — HTTP and TCP health checks on a 60s schedule; status history per service
- **Recovery** — per-service backup records with trust states and a recovery score (A–F)
- **Safe actions** — container restart, health refresh, maintenance mode with auto-expiry; all actions gated by role and audit-logged
- **Activity feed** — live audit trail with severity filtering and real-time polling
- **Emergency board** — maintenance mode, health probe override, quick access to critical ops

## Stack

| Layer | Technology |
|---|---|
| Frontend | React (Vite) |
| Backend | Node.js Express v4 ESM |
| Database | PostgreSQL 16 |
| Cache / Session | Redis 7 |
| Identity | Keycloak OIDC |
| Gateway | Caddy |
| Runtime | Docker Compose v2 |

## Quick start

See **[docs/install.md](docs/install.md)** for the full install guide.

```bash
git clone https://git.securenexus.net/tristian/privatenexus.git /opt/privatenexus
cd /opt/privatenexus/compose
cp .env.example .env   # edit with your values
# create secrets/ files (see install guide §4)
docker compose up -d
curl http://localhost:3001/api/health
```

## Roles

`viewer` → `operator` → `admin` → `superadmin` → `breakglass`

Actions require minimum `operator`. Role management requires `superadmin`.

## Backup

- **Config / code:** Forgejo (`git.securenexus.net/tristian/privatenexus`) mirrored to Codeberg + GitHub
- **Database:** daily `pg_dump` at 01:30 to `/opt/privatenexus/backups/` (14-day retention)
- **VM snapshot:** Proxmox PBS daily at 02:00 covers the full VM including Docker volumes

## License

Proprietary — House of Trae / PrivateNexus Programme. All rights reserved.
