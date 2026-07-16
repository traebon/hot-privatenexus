# Recovery Runbook — privatenexus-backend / -frontend / -mcp / -docker-proxy

Covers the four stateless PrivateNexus application containers: the Express
API (`privatenexus-backend`), the React SPA served by nginx
(`privatenexus-frontend`), the MCP server (`privatenexus-mcp`), and the
Docker socket proxy (`privatenexus-docker-proxy`). None of these hold any
persistent data of their own — their entire state is the git source + built
image. There is nothing to back up; recovery is a rebuild.

## Recovery

1. Confirm the source is current:
   `cd /opt/privatenexus && git pull` (origin is Forgejo,
   `git.securenexus.net` — unreachable during the current bare-metal outage;
   use the mirrors instead: `git pull github main` or `git pull codeberg main`,
   both at `traebon/hot-privatenexus`).
2. Rebuild and redeploy the affected container(s):
   ```
   cd /opt/privatenexus/compose
   docker compose build <service>
   docker compose up -d <service>
   ```
   (`<service>` is one of `privatenexus-backend`, `privatenexus-frontend`,
   `privatenexus-mcp`, `privatenexus-docker-proxy`.)
3. Verify:
   - backend: `curl http://localhost:3001/api/health`
   - frontend: `curl -o /dev/null -w '%{http_code}\n' https://privatenexus.net/`
   - mcp: `curl http://localhost:3002/health` (unauthenticated liveness probe)
   - docker-proxy: confirm the backend's own Docker-dependent features
     (Stacks board, container actions) work — it has no direct health
     endpoint of its own, it's a pure socket proxy.

## Dependencies

- `privatenexus-backend` needs `privatenexus-db` and `privatenexus-redis`
  healthy first (see their own runbooks/notes).
- `privatenexus-frontend` has no runtime dependency beyond the backend being
  reachable for API calls — the built static assets serve regardless.

## RTO estimate

Docker image build from source is the dominant cost — a few minutes per
container on pn-vps's hardware. No data restore step, so this is
consistently fast and low-risk to redo.
