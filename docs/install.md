# PrivateNexus — Install Guide

**Version:** 1.0
**Target:** Ubuntu 22.04 LTS VM (dedicated — do not share with other production services)
**Requires:** Caddy gateway, Keycloak, PostgreSQL accessible at deploy time

---

## Prerequisites

| Requirement | Detail |
|---|---|
| VM | Ubuntu 22.04 LTS, 2 vCPU, 8 GB RAM, 40+ GB disk |
| Docker | Engine 24+ with Compose v2 plugin |
| Keycloak | Realm `privatenexus` with OIDC client configured (see §3) |
| DNS | Subdomain pointing to your Caddy gateway (e.g. `privatenexus.example.com`) |
| Caddy | Reverse proxy with TLS already handling your domain |
| Network | VM must be reachable from Caddy gateway; no public ports required |

---

## 1. VM Setup

```bash
apt update && apt upgrade -y
apt install -y ca-certificates curl gnupg ufw git jq

# Docker
install -m 0755 -d /etc/apt/keyrings
curl -fsSL https://download.docker.com/linux/ubuntu/gpg | gpg --dearmor -o /etc/apt/keyrings/docker.gpg
echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] \
  https://download.docker.com/linux/ubuntu $(. /etc/os-release && echo "$VERSION_CODENAME") stable" \
  > /etc/apt/sources.list.d/docker.list
apt update && apt install -y docker-ce docker-ce-cli containerd.io docker-compose-plugin

# Firewall — adjust source CIDR to match your admin network / WireGuard subnet
ufw default deny incoming
ufw default allow outgoing
ufw allow from 10.10.0.0/16
ufw enable
```

---

## 2. Clone and Layout

```bash
git clone https://git.securenexus.net/tristian/privatenexus.git /opt/privatenexus
cd /opt/privatenexus
mkdir -p secrets backups
```

Directory layout after clone:

```
/opt/privatenexus/
├── app/            # frontend + backend source
├── compose/        # docker-compose.yml
├── config/         # seed data
├── docs/           # this guide + architecture docs
├── scripts/        # pg_dump.sh, etc.
├── secrets/        # secret files (NOT committed — create manually)
└── backups/        # pg_dump output (NOT committed)
```

---

## 3. Keycloak Setup

In your Keycloak admin console:

1. Create realm: `privatenexus`
2. Create client:
   - **Client ID:** `privatenexus`
   - **Client authentication:** On (confidential)
   - **Standard flow:** Enabled
   - **Valid redirect URIs:** `https://privatenexus.example.com/auth/callback`
   - **Valid post-logout redirect URIs:** `https://privatenexus.example.com/`
   - **Web origins:** `https://privatenexus.example.com`
3. Under client → Credentials: copy the **Client Secret**
4. Create realm roles: `viewer`, `operator`, `admin`, `superadmin`, `breakglass`
5. Assign MFA policy to `admin`, `superadmin`, `breakglass`
6. Raise `access_code_lifespan` to `300` seconds on the realm (Settings → Tokens)
   — default 60s causes broker expiry errors if using realm federation

> **Note:** `OIDC_API_URL` must point to the realm root: `.../realms/privatenexus`
> Do NOT use the protocol endpoint URL — it omits `jwks_uri` and causes a 500.

---

## 4. Secrets

Create these files in `/opt/privatenexus/secrets/`. All must be `chmod 644`.

```bash
cd /opt/privatenexus/secrets

# PostgreSQL password (generate a strong random string)
openssl rand -base64 32 > db_password.txt

# Session secret for express-session
openssl rand -base64 48 > session_secret.txt

# Keycloak client secret (from step 3 above)
echo 'paste-client-secret-here' > keycloak_client_secret.txt

chmod 644 *.txt
```

---

## 5. Environment Config

Copy the example and edit:

```bash
cp /opt/privatenexus/compose/.env.example /opt/privatenexus/compose/.env
```

Minimum required values in `.env`:

```env
KEYCLOAK_URL=https://auth.example.com
KEYCLOAK_REALM=privatenexus
KEYCLOAK_CLIENT_ID=privatenexus
APP_URL=https://privatenexus.example.com
NODE_ENV=production
SESSION_COOKIE_DOMAIN=privatenexus.example.com

# Optional — defaults shown
HEALTH_CHECK_INTERVAL_MS=60000
HEALTH_PROBE_TIMEOUT_MS=8000
PROMETHEUS_URL=http://your-prometheus:9090
```

---

## 6. First Deploy

```bash
cd /opt/privatenexus/compose
docker compose pull
docker compose up -d

# Watch logs until backend says "listening on 3001"
docker compose logs -f backend
```

Verify:

```bash
curl http://localhost:3001/api/health
# → {"ok":true,"service":"privatenexus-backend","version":"1.16.0"}

docker compose ps
# All containers: healthy or running
```

---

## 7. Caddy Configuration

Add to your Caddyfile (on the gateway):

```caddyfile
privatenexus.example.com {
    reverse_proxy pn-test-ip:3000   # frontend
}
```

The frontend proxies `/api/*` internally to the backend container — you only need to expose the frontend port. Reload Caddy after editing.

---

## 8. PowerDNS DNS Record

```bash
curl -s -X POST http://10.10.0.1:8081/api/v1/servers/localhost/zones/example.com \
  -H "X-API-Key: your-pdns-api-key" \
  -H "Content-Type: application/json" \
  -d '{"rrsets":[{"name":"privatenexus.example.com.","type":"A","ttl":300,
       "records":[{"content":"151.241.217.91","disabled":false}],
       "changetype":"REPLACE"}]}'
```

---

## 9. First Login

1. Browse to `https://privatenexus.example.com`
2. Login redirects to Keycloak — authenticate with your `privatenexus` realm account
3. First OIDC login creates an account with `viewer` role
4. Promote to `admin` in the Admin board (superadmin required), or directly in DB:
   ```sql
   -- run inside privatenexus-db container
   UPDATE users SET role = 'admin' WHERE keycloak_sub = 'your-sub-id';
   ```

---

## 10. Seed the Service Catalogue

After first login, use the Catalogue board to register your services, or run the seed script:

```bash
cd /opt/privatenexus
node config/seed.js
```

The seed script populates workspaces and the House of Trae service catalogue. Review and adjust `/opt/privatenexus/config/seed.js` for your environment before running.

---

## 11. Automated pg_dump Backup

```bash
# Test it first
/opt/privatenexus/scripts/pg_dump.sh

# Add to cron (runs at 01:30 daily, after config sync but before Proxmox PBS)
(crontab -l 2>/dev/null; echo '30 1 * * * /opt/privatenexus/scripts/pg_dump.sh >> /var/log/pn-pgdump.log 2>&1') | crontab -
```

Dumps are written to `/opt/privatenexus/backups/` with 14-day retention. The directory is covered by the Proxmox PBS VM snapshot, so dumps also land in the PBS destination.

---

## 12. Post-Deploy Checklist

- [ ] `GET /api/health` returns `ok: true` with correct version
- [ ] All containers healthy in `docker compose ps`
- [ ] Login via Keycloak works end-to-end
- [ ] Logout clears session and redirects correctly
- [ ] At least one service registered in the Catalogue board
- [ ] Health checks running (check Home board status cards)
- [ ] pg_dump cron installed and tested
- [ ] PrivateNexus itself registered as a service with backup records
- [ ] Uptime Kuma monitor added for `https://privatenexus.example.com/api/health`
- [ ] Prometheus scrape target added (if using metrics endpoint)
- [ ] TLS certificate provisioned (verify in Admin → Certs board)

---

## Upgrade

```bash
cd /opt/privatenexus
git pull origin main

cd compose
docker compose build --no-cache
docker compose up -d --force-recreate

curl http://localhost:3001/api/health   # confirm new version
```

Database migrations run automatically on backend startup via `initDb()`.

---

## Troubleshooting

| Symptom | Check |
|---|---|
| Backend exits immediately | `docker compose logs backend` — usually a missing secret file or wrong DB password |
| Keycloak login loops | Verify `post_logout_redirect_uris` matches your `APP_URL` exactly |
| `expired_code` broker errors | Raise `access_code_lifespan` to 300s on the Keycloak realm |
| Health checks stuck at `unknown` | Service has no `health_endpoint` set — configure via Catalogue → service detail |
| TCP probe always `down` | Confirm firewall allows pn-test → target host on the probe port |
| Session lost on page reload | Check `SESSION_COOKIE_DOMAIN` matches the actual domain; check Redis is healthy |
| pg_dump fails | Confirm `privatenexus-db` container is running; check `/var/log/pn-pgdump.log` |
