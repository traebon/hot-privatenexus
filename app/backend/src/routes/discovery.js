import { Router } from "express";
import { createHash, randomBytes } from "crypto";
import { readFileSync } from "fs";
import https from "node:https";
import { getDocker } from "../dockerClient.js";
import { getPool, HOT_TENANT_ID } from "../db.js"; // HOT_TENANT_ID: bootstrap-only fallback for /ingest's static token path
import { requireRole } from "../middleware/requireRole.js";
import { recordAudit } from "../auditLog.js";
import { recordChange } from "./governance.js";

function readSecret(path) {
  try { return readFileSync(path, "utf8").trim(); } catch { return null; }
}

function hashToken(t) {
  return createHash("sha256").update(t).digest("hex");
}

// HTTPS GET that skips cert verification — used only for Proxmox (self-signed cert)
function proxmoxFetch(url, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = https.request(url, {
      method: "GET",
      headers,
      agent: new https.Agent({ rejectUnauthorized: false }),
    }, (res) => {
      let body = "";
      res.on("data", (c) => { body += c; });
      res.on("end", () => resolve({ ok: res.statusCode >= 200 && res.statusCode < 300, status: res.statusCode, json: () => JSON.parse(body) }));
    });
    req.on("error", reject);
    req.setTimeout(10000, () => req.destroy(new Error("Proxmox request timeout")));
    req.end();
  });
}

export const discoveryRouter = Router();

const docker = getDocker();

// ── Completeness score ──────────────────────────────────────────────────────
function computeCompleteness(c) {
  let score = 100;
  if (!c.suggested_name)         score -= 20;
  if (!c.suggested_workspace_id) score -= 20;
  if (!c.suggested_category)     score -= 15;
  if (!c.suggested_health_ep)    score -= 20;
  if (!c.suggested_description)  score -= 15;
  if (!c.raw_data?.labels || Object.keys(c.raw_data.labels || {}).length === 0) score -= 10;
  return Math.max(0, score);
}

// ── Slug helper ─────────────────────────────────────────────────────────────
function toSlug(name = "") {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

// ── Infer category from image name ──────────────────────────────────────────
// Output must stay within services.js's VALID_CATEGORIES. "monitoring" and
// "app" are first-class categories with real live members; database/proxy/
// security/vcs images fold into "infra" since nothing distinguishes them
// as their own category yet.
function inferCategory(image = "") {
  const img = image.toLowerCase();
  if (/postgres|mariadb|mysql|redis|mongo/.test(img)) return "infra";
  if (/nginx|caddy|traefik|apache/.test(img))          return "infra";
  if (/grafana|prometheus|loki|uptime/.test(img))      return "monitoring";
  if (/keycloak|vault|authelia/.test(img))              return "infra";
  if (/forgejo|gitea|gitlab/.test(img))                 return "infra";
  if (/nextcloud|immich|vaultwarden/.test(img))         return "personal";
  if (/erpnext|frappe/.test(img))                       return "business";
  return "app";
}

// ── Infer health endpoint from container port bindings ──────────────────────
// Always address the container by its Docker network name, on its PrivatePort
// (the port it actually listens on) — never "localhost" or PublicPort, which
// only resolve correctly for host-published ports and are wrong or unreachable
// for the (now-common) internal-network-only deployment pattern. Prefer a
// recognized HTTP port for a real HTTP health check; fall back to a plain TCP
// connect on the first port the container exposes at all.
function inferHealthEndpoint(ports = [], labels = {}, containerName = "") {
  if (labels["pn.health_endpoint"]) return labels["pn.health_endpoint"];
  if (!containerName) return null;
  const httpPorts = [443, 8443, 80, 8080, 8000, 3000, 3001, 9090, 9191];
  const httpMatch = ports.find((p) => httpPorts.includes(p.PrivatePort));
  if (httpMatch) {
    const scheme = [443, 8443].includes(httpMatch.PrivatePort) ? "https" : "http";
    return `${scheme}://${containerName}:${httpMatch.PrivatePort}/`;
  }
  const anyPort = ports.find((p) => p.PrivatePort);
  if (anyPort) return `tcp://${containerName}:${anyPort.PrivatePort}`;
  return null;
}

// ── Workspace lookup helper ──────────────────────────────────────────────────
async function workspaceBySlug(pool, slug, tenantId) {
  if (!slug) return null;
  const { rows } = await pool.query(
    "SELECT id FROM workspaces WHERE tenant_id = $1 AND slug = $2 LIMIT 1",
    [tenantId, slug]
  );
  return rows[0]?.id ?? null;
}

// ── Deduplicate: skip candidates already in registry ────────────────────────
async function knownSlugs(pool, tenantId) {
  const { rows } = await pool.query(
    "SELECT slug FROM services WHERE tenant_id = $1",
    [tenantId]
  );
  return new Set(rows.map((r) => r.slug));
}

// ── Upsert candidate (on slug conflict update discovered_at + raw_data) ──────
async function upsertCandidate(pool, candidate, tenantId) {
  const score = computeCompleteness(candidate);
  const { rows } = await pool.query(
    `INSERT INTO discovery_candidates
       (tenant_id, source, host, raw_name, raw_image,
        suggested_slug, suggested_name, suggested_description,
        suggested_workspace_id, suggested_category,
        suggested_access_mode, suggested_runtime,
        suggested_health_ep, raw_data, completeness_score)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
     ON CONFLICT (tenant_id, source, raw_name) DO UPDATE SET
        host                   = EXCLUDED.host,
        raw_image              = EXCLUDED.raw_image,
        suggested_slug         = EXCLUDED.suggested_slug,
        suggested_name         = EXCLUDED.suggested_name,
        suggested_description  = EXCLUDED.suggested_description,
        suggested_workspace_id = EXCLUDED.suggested_workspace_id,
        suggested_category     = EXCLUDED.suggested_category,
        suggested_access_mode  = EXCLUDED.suggested_access_mode,
        suggested_runtime      = EXCLUDED.suggested_runtime,
        suggested_health_ep    = EXCLUDED.suggested_health_ep,
        raw_data               = EXCLUDED.raw_data,
        completeness_score     = EXCLUDED.completeness_score,
        discovered_at          = NOW()
     WHERE discovery_candidates.status = 'pending'
     RETURNING id`,
    [
      tenantId,
      candidate.source,
      candidate.host ?? null,
      candidate.raw_name ?? null,
      candidate.raw_image ?? null,
      candidate.suggested_slug ?? null,
      candidate.suggested_name ?? null,
      candidate.suggested_description ?? null,
      candidate.suggested_workspace_id ?? null,
      candidate.suggested_category ?? null,
      candidate.suggested_access_mode ?? "internal",
      candidate.suggested_runtime ?? "docker",
      candidate.suggested_health_ep ?? null,
      candidate.raw_data ?? null,
      score,
    ]
  );
  return rows[0];
}

// ── GET /api/discovery/candidates ───────────────────────────────────────────
discoveryRouter.get("/candidates", requireRole("operator"), async (req, res) => {
  try {
    const status = req.query.status || "pending";
    const source = req.query.source || null;
    const params = [req.session.user.tenant_id, status];
    const sourceClause = source ? `AND source = $${params.push(source)}` : "";

    const { rows } = await getPool().query(
      `SELECT dc.*,
              w.name AS workspace_name
       FROM discovery_candidates dc
       LEFT JOIN workspaces w ON w.id = dc.suggested_workspace_id
       WHERE dc.tenant_id = $1 AND dc.status = $2 ${sourceClause}
       ORDER BY dc.completeness_score DESC, dc.discovered_at DESC`,
      params
    );
    const counts = await getPool().query(
      `SELECT status, COUNT(*)::int AS n
       FROM discovery_candidates WHERE tenant_id = $1
       GROUP BY status`,
      [req.session.user.tenant_id]
    );
    const summary = Object.fromEntries(counts.rows.map((r) => [r.status, r.n]));
    res.json({ ok: true, candidates: rows, summary });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ── POST /api/discovery/scan ─────────────────────────────────────────────────
// sources: ['local_docker', 'proxmox', 'caddy'] — defaults to local_docker
discoveryRouter.post("/scan", requireRole("operator"), async (req, res) => {
  try {
    const sources = Array.isArray(req.body.sources)
      ? req.body.sources
      : ["local_docker"];

    const pool    = getPool();
    const tenantId = req.session.user.tenant_id;
    const known   = await knownSlugs(pool, tenantId);
    const results = { inserted: 0, skipped: 0, errors: [] };

    for (const source of sources) {
      try {
        if (source === "local_docker") {
          await scanLocalDocker(pool, known, results, tenantId);
        } else if (source === "proxmox") {
          await scanProxmox(pool, known, results, tenantId);
        } else if (source === "caddy") {
          await scanCaddy(pool, known, results, tenantId);
        }
      } catch (err) {
        results.errors.push({ source, error: err.message });
      }
    }

    recordAudit(req, "discovery.scan", null, "success", { sources, ...results });
    res.json({ ok: true, ...results });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ── Local Docker scanner ─────────────────────────────────────────────────────
async function scanLocalDocker(pool, known, results, tenantId) {
  const workspaces = await pool.query(
    "SELECT id, slug FROM workspaces WHERE tenant_id = $1",
    [tenantId]
  );
  const wsMap = Object.fromEntries(workspaces.rows.map((w) => [w.slug, w.id]));

  const containers = await docker.listContainers({ all: false });

  for (const c of containers) {
    const rawName  = (c.Names?.[0] || "").replace(/^\//, "");
    const slug     = toSlug(rawName);
    const labels   = c.Labels || {};

    if (!slug || known.has(slug)) { results.skipped++; continue; }

    const wsSlug = labels["pn.workspace"];
    const wsId   = wsSlug ? (wsMap[wsSlug] ?? null) : null;

    const candidate = {
      source:                "local_docker",
      host:                  "pn-test",
      raw_name:              rawName,
      raw_image:             c.Image,
      suggested_slug:        slug,
      suggested_name:        labels["pn.name"]        || rawName,
      suggested_description: labels["pn.description"] || null,
      suggested_workspace_id: wsId,
      suggested_category:    labels["pn.category"]    || inferCategory(c.Image),
      suggested_access_mode: labels["pn.access_mode"] || "internal",
      suggested_runtime:     "docker",
      suggested_health_ep:   inferHealthEndpoint(c.Ports, labels, rawName),
      raw_data: {
        id:      c.Id?.slice(0, 12),
        image:   c.Image,
        state:   c.State,
        status:  c.Status,
        ports:   c.Ports,
        labels,
        created: c.Created,
      },
    };

    const inserted = await upsertCandidate(pool, candidate, tenantId);
    inserted ? results.inserted++ : results.skipped++;
  }
}

// ── Proxmox scanner ──────────────────────────────────────────────────────────
async function scanProxmox(pool, known, results, tenantId) {
  const baseUrl = process.env.PROXMOX_URL || "https://10.10.0.2:8006/api2/json";
  const token   = readSecret("/run/secrets/proxmox_token") ?? process.env.PROXMOX_TOKEN;

  if (!token) throw new Error("PROXMOX_TOKEN not configured — add proxmox_token secret");

  const headers = { Authorization: `PVEAPIToken=${token}` };
  const wsId    = await workspaceBySlug(pool, "infrastructure", tenantId);

  for (const type of ["qemu", "lxc"]) {
    const r = await proxmoxFetch(`${baseUrl}/nodes/pve/${type}`, headers);
    if (!r.ok) throw new Error(`Proxmox API ${type}: HTTP ${r.status}`);
    const { data } = r.json();

    for (const vm of (data || [])) {
      const name = vm.name || `vm-${vm.vmid}`;
      const slug = toSlug(name);
      if (!slug || known.has(slug)) { results.skipped++; continue; }

      const candidate = {
        source:                "proxmox",
        host:                  "proxmox",
        raw_name:              name,
        raw_image:             type === "qemu" ? "qemu-vm" : "lxc-container",
        suggested_slug:        slug,
        suggested_name:        name,
        suggested_description: `Proxmox ${type === "qemu" ? "VM" : "LXC"} ${vm.vmid} — ${vm.status}`,
        suggested_workspace_id: wsId,
        suggested_category:    "infra",
        suggested_access_mode: "vpn_only",
        suggested_runtime:     type === "qemu" ? "vm" : "lxc",
        suggested_health_ep:   null,
        raw_data: {
          vmid:    vm.vmid,
          type,
          status:  vm.status,
          cpus:    vm.cpus,
          maxmem:  vm.maxmem,
          maxdisk: vm.maxdisk,
          uptime:  vm.uptime,
        },
      };

      const inserted = await upsertCandidate(pool, candidate, tenantId);
      inserted ? results.inserted++ : results.skipped++;
    }
  }
}

// ── Caddy scanner ────────────────────────────────────────────────────────────
async function scanCaddy(pool, known, results, tenantId) {
  const adminUrl = process.env.CADDY_ADMIN_URL || "http://10.10.0.1:2019";

  const r = await fetch(`${adminUrl}/config/apps/http/servers/srv0/routes`, {
    signal: AbortSignal.timeout(8000),
  });
  if (!r.ok) throw new Error(`Caddy admin API: HTTP ${r.status} — is CADDY_ADMIN_URL correct?`);

  const routes = await r.json();
  if (!Array.isArray(routes)) throw new Error("Caddy admin API returned unexpected shape");

  const wsId = await workspaceBySlug(pool, "infrastructure", tenantId);

  for (const route of routes) {
    const hosts = route.match?.[0]?.host || [];
    for (const host of hosts) {
      const slug = toSlug(host.replace(/\./g, "-"));
      if (!slug || known.has(slug)) { results.skipped++; continue; }

      const upstreams = (route.handle || [])
        .flatMap((h) => h.routes || [h])
        .flatMap((h) => h.handle || [])
        .filter((h) => h.handler === "reverse_proxy")
        .flatMap((h) => h.upstreams || [])
        .map((u) => u.dial);

      const candidate = {
        source:                "caddy",
        host:                  "gateway-vps",
        raw_name:              host,
        raw_image:             null,
        suggested_slug:        slug,
        suggested_name:        host,
        suggested_description: `Caddy route for ${host}`,
        suggested_workspace_id: wsId,
        suggested_category:    "app",
        suggested_access_mode: "public",
        suggested_runtime:     "caddy-route",
        suggested_health_ep:   `https://${host}/`,
        raw_data: { host, upstreams, route_id: route["@id"] || null },
      };

      const inserted = await upsertCandidate(pool, candidate, tenantId);
      inserted ? results.inserted++ : results.skipped++;
    }
  }
}

// ── POST /api/discovery/ingest ── agent push endpoint ───────────────────────
// Accepts a Bearer token verified against the agent_tokens table (or legacy env fallback)
discoveryRouter.post("/ingest", async (req, res) => {
  const authHeader = req.headers.authorization || "";
  const rawToken = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : null;
  if (!rawToken) return res.status(401).json({ ok: false, error: "Unauthorized" });

  try {
    const pool = getPool();
    const hash = hashToken(rawToken);

    // Check agent_tokens table first — the token itself determines the tenant
    // (there's no session here to resolve one from), so this must NOT filter
    // by a fixed tenant_id or no non-HoT tenant's agent could ever authenticate.
    const { rows: tokenRows } = await pool.query(
      `SELECT id, tenant_id FROM agent_tokens
       WHERE token_hash = $1 AND revoked = FALSE
         AND (expires_at IS NULL OR expires_at > NOW())`,
      [hash]
    );

    let tenantId;
    if (!tokenRows.length) {
      // Fallback: static env/secret token (bootstrap only — rotate to DB tokens).
      // Only ever valid for the House of Trae tenant — there is no per-tenant
      // static token, by design.
      const staticToken = readSecret("/run/secrets/discovery_agent_token") ?? process.env.DISCOVERY_AGENT_TOKEN;
      if (!staticToken || rawToken !== staticToken) {
        return res.status(401).json({ ok: false, error: "Unauthorized" });
      }
      tenantId = HOT_TENANT_ID;
    } else {
      tenantId = tokenRows[0].tenant_id;
      // Update last_used_at
      await pool.query("UPDATE agent_tokens SET last_used_at = NOW() WHERE id = $1", [tokenRows[0].id]);
    }

    const { candidates: incoming } = req.body;
    if (!Array.isArray(incoming) || !incoming.length) {
      return res.status(400).json({ ok: false, error: "candidates array required" });
    }
    const MAX_CANDIDATES_PER_INGEST = 100;
    if (incoming.length > MAX_CANDIDATES_PER_INGEST) {
      return res.status(400).json({ ok: false, error: `Batch size exceeds limit of ${MAX_CANDIDATES_PER_INGEST}` });
    }

    const known   = await knownSlugs(pool, tenantId);

    // T13-5: pre-fetch valid workspace IDs for this tenant so we can null out foreign IDs from agents
    const { rows: wsRows } = await pool.query(
      "SELECT id FROM workspaces WHERE tenant_id = $1",
      [tenantId]
    );
    const validWsIds = new Set(wsRows.map(r => r.id));

    let inserted  = 0;
    let skipped   = 0;

    for (const c of incoming) {
      const slug = toSlug(c.suggested_slug || c.raw_name || "");
      if (!slug || known.has(slug)) { skipped++; continue; }
      // Null out workspace_id from external agents if it doesn't belong to this tenant
      const safeWsId = (c.suggested_workspace_id && validWsIds.has(c.suggested_workspace_id))
        ? c.suggested_workspace_id : null;
      const row = await upsertCandidate(pool, { ...c, suggested_slug: slug, suggested_workspace_id: safeWsId }, tenantId);
      row ? inserted++ : skipped++;
    }

    res.json({ ok: true, inserted, skipped });
  } catch (err) {
    console.error("[discovery] ingest error:", err.message);
    res.status(500).json({ ok: false, error: "Service unavailable" });
  }
});

// ── GET /api/discovery/agent-tokens ─────────────────────────────────────────
discoveryRouter.get("/agent-tokens", requireRole("admin"), async (req, res) => {
  try {
    const { rows } = await getPool().query(
      `SELECT id, label, expires_at, last_used_at, created_by, created_at, revoked
       FROM agent_tokens WHERE tenant_id = $1
       ORDER BY created_at DESC`,
      [req.session.user.tenant_id]
    );
    res.json({ ok: true, tokens: rows });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ── POST /api/discovery/agent-tokens ─────────────────────────────────────────
// Creates a new agent token — returns plaintext once, never stored
discoveryRouter.post("/agent-tokens", requireRole("admin"), async (req, res) => {
  const { label, ttl_hours } = req.body;
  if (!label?.trim()) return res.status(400).json({ ok: false, error: "label required" });

  const plaintext  = randomBytes(32).toString("hex");
  const hash       = hashToken(plaintext);
  const expires_at = ttl_hours ? new Date(Date.now() + ttl_hours * 3600 * 1000) : null;
  const created_by = req.session?.user?.username || "admin";

  try {
    const { rows } = await getPool().query(
      `INSERT INTO agent_tokens (tenant_id, label, token_hash, expires_at, created_by)
       VALUES ($1, $2, $3, $4, $5) RETURNING id, label, expires_at, created_at`,
      [req.session.user.tenant_id, label.trim(), hash, expires_at, created_by]
    );
    recordAudit(req, "discovery.agent_token.create", label, "success");
    res.json({ ok: true, token: plaintext, ...rows[0] });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ── DELETE /api/discovery/agent-tokens/:id ───────────────────────────────────
discoveryRouter.delete("/agent-tokens/:id", requireRole("admin"), async (req, res) => {
  try {
    const { rows } = await getPool().query(
      `UPDATE agent_tokens SET revoked = TRUE
       WHERE id = $1 AND tenant_id = $2 RETURNING id, label`,
      [req.params.id, req.session.user.tenant_id]
    );
    if (!rows[0]) return res.status(404).json({ ok: false, error: "Token not found" });
    recordAudit(req, "discovery.agent_token.revoke", rows[0].label, "success");
    res.json({ ok: true, revoked: rows[0].label });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ── PATCH /api/discovery/candidates/:id ──────────────────────────────────────
// action: 'approve' | 'reject' | 'update'
discoveryRouter.patch("/candidates/:id", requireRole("operator"), async (req, res) => {
  const { id } = req.params;
  const { action, reject_reason, updates } = req.body;
  const pool = getPool();
  const tenantId = req.session.user.tenant_id;

  try {
    const { rows } = await pool.query(
      "SELECT * FROM discovery_candidates WHERE id = $1 AND tenant_id = $2",
      [id, tenantId]
    );
    if (!rows[0]) return res.status(404).json({ ok: false, error: "Candidate not found" });
    const candidate = rows[0];

    if (action === "reject") {
      await pool.query(
        `UPDATE discovery_candidates
         SET status = 'rejected', reject_reason = $1, reviewed_at = NOW(), reviewed_by = $2
         WHERE id = $3`,
        [reject_reason || null, req.session?.user?.username || "unknown", id]
      );
      recordAudit(req, "discovery.candidate.reject", candidate.suggested_slug, "success");
      return res.json({ ok: true, status: "rejected" });
    }

    if (action === "update") {
      const allowed = [
        "suggested_name", "suggested_slug", "suggested_description",
        "suggested_workspace_id", "suggested_category",
        "suggested_access_mode", "suggested_runtime", "suggested_health_ep",
      ];
      const sets   = [];
      const params = [id];
      for (const [k, v] of Object.entries(updates || {})) {
        if (allowed.includes(k)) {
          params.push(v);
          sets.push(`${k} = $${params.length}`);
        }
      }
      if (!sets.length) return res.status(400).json({ ok: false, error: "No valid fields to update" });

      // T13-5: verify workspace_id belongs to this tenant before accepting it
      if (updates?.suggested_workspace_id !== undefined && updates.suggested_workspace_id !== null) {
        const { rows: wsCheck } = await pool.query(
          "SELECT id FROM workspaces WHERE id = $1 AND tenant_id = $2",
          [updates.suggested_workspace_id, tenantId]
        );
        if (!wsCheck.length)
          return res.status(404).json({ ok: false, error: "workspace_id not found for this tenant" });
      }

      await pool.query(
        `UPDATE discovery_candidates SET ${sets.join(", ")} WHERE id = $1`,
        params
      );
      return res.json({ ok: true, status: "updated" });
    }

    if (action === "approve") {
      // Merge candidate into the service registry
      const name        = candidate.suggested_name  || candidate.raw_name;
      const slug        = candidate.suggested_slug;
      const category    = candidate.suggested_category || "app";
      const accessMode  = candidate.suggested_access_mode || "internal";
      const runtime     = candidate.suggested_runtime || "docker";
      const _rawHealthEp = candidate.suggested_health_ep || null;
      let healthEp = null;
      if (_rawHealthEp) {
        try {
          const _u = new URL(_rawHealthEp);
          if (["http:", "https:", "tcp:"].includes(_u.protocol)) healthEp = _rawHealthEp;
        } catch { /* malformed URL from ingest — silently drop */ }
      }
      const description = candidate.suggested_description || null;
      const wsId        = candidate.suggested_workspace_id || null;
      // Only docker-sourced candidates carry an actual Docker container name in
      // raw_name (Proxmox/Caddy sources have hostnames/routes there instead) —
      // this is what lets /api/actions/run/v2's blast-radius check and the
      // MCP-triggered autonomous restart (routes/intelligence.js) find the
      // right container for a registered service.
      const containerName = runtime === "docker" ? (candidate.raw_name || null) : null;

      if (!slug || !name) {
        return res.status(400).json({ ok: false, error: "slug and name required before approving" });
      }

      // Check no slug collision in services
      const existing = await pool.query(
        "SELECT id FROM services WHERE tenant_id = $1 AND slug = $2",
        [tenantId, slug]
      );
      if (existing.rows[0]) {
        return res.status(409).json({ ok: false, error: `Service with slug '${slug}' already exists` });
      }

      const { rows: svcRows } = await pool.query(
        `INSERT INTO services
           (tenant_id, workspace_id, name, slug, description, category,
            access_mode, runtime_type, owner, backup_policy, health_endpoint, status, container_name)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'unknown',$12)
         RETURNING id`,
        [
          tenantId, wsId, name, slug, description,
          category, accessMode, runtime,
          req.session?.user?.username || "discovered",
          "none", healthEp, containerName,
        ]
      );
      const newServiceId = svcRows[0].id;

      await pool.query(
        `UPDATE discovery_candidates
         SET status = 'merged', merged_service_id = $1, reviewed_at = NOW(), reviewed_by = $2
         WHERE id = $3`,
        [newServiceId, req.session?.user?.username || "unknown", id]
      );

      recordAudit(req, "discovery.candidate.approve", slug, "success", { newServiceId });
      recordChange(tenantId, newServiceId, name, "service_registered",
        req.session?.user?.username || "unknown",
        `Service '${name}' promoted from Discovery (slug: ${slug})`);
      return res.json({ ok: true, status: "merged", serviceId: newServiceId });
    }

    res.status(400).json({ ok: false, error: "action must be approve | reject | update" });
  } catch (err) {
    console.error("[discovery] candidate patch error:", err.message);
    res.status(500).json({ ok: false, error: "Service unavailable" });
  }
});

// ── DELETE /api/discovery/candidates/:id ─────────────────────────────────────
discoveryRouter.delete("/candidates/:id", requireRole("admin"), async (req, res) => {
  try {
    const { rows } = await getPool().query(
      "DELETE FROM discovery_candidates WHERE id = $1 AND tenant_id = $2 RETURNING id",
      [req.params.id, req.session.user.tenant_id]
    );
    if (!rows[0]) return res.status(404).json({ ok: false, error: "Not found" });
    recordAudit(req, "discovery.candidate.delete", req.params.id, "success");
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ── GET /api/discovery/drift ──────────────────────────────────────────────────
// Compare registered docker services against the last live Docker inventory —
// either the manual in-process scan (source='local_docker') or the automated
// hourly discovery-agent.timer push via /ingest (source='docker', see
// scripts/discovery-agent.sh). Both are genuine snapshots of what's actually
// running; only checking 'local_docker' left this permanently blind to the
// one pathway that's actually automated -- confirmed live, every real
// candidate in the table is source='docker' or 'system_info', zero are
// 'local_docker' (nobody had ever clicked the manual "Scan Docker" button).
discoveryRouter.get("/drift", requireRole("operator"), async (req, res) => {
  try {
    const pool = getPool();

    // All registered docker services
    const { rows: registered } = await pool.query(
      `SELECT id, slug, name, status FROM services
       WHERE tenant_id = $1 AND runtime_type = 'docker' AND archived = FALSE`,
      [req.session.user.tenant_id]
    );

    // Latest live-docker discovery batch slugs (either collection pathway)
    const { rows: discovered } = await pool.query(
      `SELECT suggested_slug FROM discovery_candidates
       WHERE tenant_id = $1 AND source IN ('local_docker', 'docker')
         AND discovered_at > NOW() - INTERVAL '25 hours'`,
      [req.session.user.tenant_id]
    );
    const discoveredSlugs = new Set(discovered.map((r) => r.suggested_slug));

    const drift = registered
      .filter((s) => discoveredSlugs.size > 0 && !discoveredSlugs.has(s.slug))
      .map((s) => ({ ...s, drift: "not_found_in_last_scan" }));

    res.json({ ok: true, drift, scannedAt: discovered.length ? "within 25h" : "no scan data" });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});
