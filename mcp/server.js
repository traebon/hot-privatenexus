#!/usr/bin/env node
// PrivateNexus MCP Server v3 — read + write tools for JARVIS/Claude Code
// Read tools: direct PostgreSQL queries
// Write tools: call backend HTTP API with X-MCP-Internal auth header
import { readFileSync } from "fs";
import http from "node:http";
import pg from "pg";

const { Pool } = pg;

const PORT      = Number(process.env.MCP_PORT    || 3002);
const TOKEN     = readSecret("/run/secrets/mcp_token") ?? process.env.MCP_TOKEN;
const TENANT_ID = "10000000-0000-0000-0000-000000000001";
const BACKEND   = process.env.BACKEND_URL || "http://privatenexus-backend:3001";

function readSecret(path) {
  try { return readFileSync(path, "utf8").trim(); } catch { return null; }
}

const pool = new Pool({
  host:     process.env.DB_HOST     || "privatenexus-db",
  port:     Number(process.env.DB_PORT || 5432),
  database: process.env.DB_NAME     || "privatenexus",
  user:     process.env.DB_USER     || "privatenexus",
  password: process.env.DB_PASSWORD || readSecret("/run/secrets/db_password"),
  max: 3,
});

// ── Backend API caller ────────────────────────────────────────────────────────
async function backendCall(method, path, body = null) {
  const url = `${BACKEND}${path}`;
  const opts = {
    method,
    headers: {
      "Content-Type": "application/json",
      "X-MCP-Internal": TOKEN || "",
    },
    signal: AbortSignal.timeout(30_000),
  };
  if (body) opts.body = JSON.stringify(body);
  const res = await fetch(url, opts);
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch { data = { raw: text }; }
  if (!res.ok) throw new Error(`Backend ${method} ${path} → ${res.status}: ${JSON.stringify(data)}`);
  return data;
}

// ── Tool definitions ─────────────────────────────────────────────────────────
const TOOLS = [
  // ── Read tools (v2 — unchanged) ───────────────────────────────────────────
  {
    name: "pn_summary",
    description: "Overall PrivateNexus health summary: service counts by status, recent incidents, pending discovery candidates.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "pn_list_services",
    description: "List all registered services with their current health status, workspace, category, backup policy, and health endpoint.",
    inputSchema: {
      type: "object",
      properties: {
        status:    { type: "string", description: "Filter by status: healthy|down|unknown|degraded" },
        workspace: { type: "string", description: "Filter by workspace slug" },
        category:  { type: "string", description: "Filter by category" },
      },
    },
  },
  {
    name: "pn_get_service",
    description: "Get full details for a single service including recent health history and backup records.",
    inputSchema: {
      type: "object",
      properties: { slug: { type: "string", description: "Service slug" } },
      required: ["slug"],
    },
  },
  {
    name: "pn_blast_radius",
    description: "Given a service slug, return all services that would be affected if it went down, with dependency types (hard/soft) and depth.",
    inputSchema: {
      type: "object",
      properties: { slug: { type: "string", description: "Service slug to analyse" } },
      required: ["slug"],
    },
  },
  {
    name: "pn_restore_chain",
    description: "Given a service slug, return the ordered list of services that must be restored first (dependencies before dependents).",
    inputSchema: {
      type: "object",
      properties: { slug: { type: "string", description: "Service slug to restore" } },
      required: ["slug"],
    },
  },
  {
    name: "pn_health_history",
    description: "Return recent health check events for a service.",
    inputSchema: {
      type: "object",
      properties: {
        slug:  { type: "string", description: "Service slug" },
        limit: { type: "number", description: "Number of events to return (default 20)" },
      },
      required: ["slug"],
    },
  },
  {
    name: "pn_list_backups",
    description: "List backup records, optionally filtered by service slug.",
    inputSchema: {
      type: "object",
      properties: {
        slug:  { type: "string", description: "Service slug (optional)" },
        limit: { type: "number", description: "Max records to return (default 20)" },
      },
    },
  },
  {
    name: "pn_recent_activity",
    description: "Return recent audit log activity — logins, service actions, config changes.",
    inputSchema: {
      type: "object",
      properties: {
        limit:  { type: "number", description: "Number of events (default 30)" },
        action: { type: "string", description: "Filter by action prefix e.g. auth, service, discovery" },
      },
    },
  },
  {
    name: "pn_discovery_pending",
    description: "List pending Discovery candidates awaiting review.",
    inputSchema: {
      type: "object",
      properties: { limit: { type: "number", description: "Max results (default 20)" } },
    },
  },
  // ── Write / action tools (v3 — new) ──────────────────────────────────────
  {
    name: "pn_list_signals",
    description: "List active intelligence signals — anomalies detected by the autonomous scanner (down spikes, degradation, latency, flapping).",
    inputSchema: {
      type: "object",
      properties: {
        hours: { type: "number", description: "Look-back window in hours (default 24, max 168)" },
      },
    },
  },
  {
    name: "pn_approve_proposal",
    description: "Approve and immediately execute a pending remediation proposal (e.g. restart a container). Requires operator role.",
    inputSchema: {
      type: "object",
      properties: {
        proposal_id: { type: "string", description: "UUID of the remediation proposal to approve" },
      },
      required: ["proposal_id"],
    },
  },
  {
    name: "pn_refresh_health",
    description: "Trigger an immediate health probe on a service by slug. Updates service status and writes a health event.",
    inputSchema: {
      type: "object",
      properties: {
        slug: { type: "string", description: "Service slug to probe" },
      },
      required: ["slug"],
    },
  },
  {
    name: "pn_restart_service",
    description: "Restart the Docker container associated with a service. The service must have container_name set. Creates a change record.",
    inputSchema: {
      type: "object",
      properties: {
        slug: { type: "string", description: "Service slug to restart" },
      },
      required: ["slug"],
    },
  },
  {
    name: "pn_run_simulation",
    description: "Run a recovery simulation for a service or the full estate. Returns RTO estimates, blockers, and restore order.",
    inputSchema: {
      type: "object",
      properties: {
        target_type: { type: "string", description: "service | category | estate" },
        target_slug: { type: "string", description: "Service slug (required when target_type=service)" },
        scenario:    { type: "string", description: "Scenario type: full_loss | partial | data_corruption | network_failure (default: full_loss)" },
      },
      required: ["target_type"],
    },
  },
  {
    name: "pn_get_playbook",
    description: "Generate a step-by-step recovery playbook for a service. Returns ordered instructions including backup source, runbook URL, and health check steps.",
    inputSchema: {
      type: "object",
      properties: {
        slug: { type: "string", description: "Service slug" },
      },
      required: ["slug"],
    },
  },
];

// ── Tool handlers ─────────────────────────────────────────────────────────────
async function callTool(name, args) {
  switch (name) {

    case "pn_summary": {
      const [svcs, activity, disc, signals] = await Promise.all([
        pool.query("SELECT status, COUNT(*)::int n FROM services WHERE tenant_id=$1 AND archived=FALSE GROUP BY status", [TENANT_ID]),
        pool.query("SELECT action, outcome, ts FROM audit_log WHERE tenant_id=$1 ORDER BY ts DESC LIMIT 5", [TENANT_ID]),
        pool.query("SELECT COUNT(*)::int n FROM discovery_candidates WHERE tenant_id=$1 AND status='pending'", [TENANT_ID]),
        pool.query("SELECT COUNT(*)::int n FROM intelligence_signals WHERE tenant_id=$1 AND resolved_at IS NULL AND fired_at > NOW() - INTERVAL '24 hours'", [TENANT_ID])
          .catch(() => ({ rows: [{ n: 0 }] })), // graceful if table doesn't exist yet
      ]);
      const statusMap = Object.fromEntries(svcs.rows.map(r => [r.status, r.n]));
      return {
        service_counts: statusMap,
        total_services: Object.values(statusMap).reduce((a, b) => a + b, 0),
        pending_discovery: disc.rows[0].n,
        open_signals: signals.rows[0].n,
        recent_activity: activity.rows,
      };
    }

    case "pn_list_services": {
      const { status, workspace, category } = args;
      const params  = [TENANT_ID];
      const clauses = ["s.tenant_id = $1", "s.archived = FALSE"];
      if (status)    { params.push(status);    clauses.push(`s.status = $${params.length}`); }
      if (category)  { params.push(category);  clauses.push(`s.category = $${params.length}`); }
      if (workspace) { params.push(workspace); clauses.push(`w.slug = $${params.length}`); }
      const { rows } = await pool.query(
        `SELECT s.name, s.slug, s.status, s.category, s.access_mode, s.runtime_type,
                s.backup_policy, s.health_endpoint, s.container_name, s.updated_at,
                w.name AS workspace
         FROM services s LEFT JOIN workspaces w ON w.id = s.workspace_id
         WHERE ${clauses.join(" AND ")}
         ORDER BY s.status DESC, s.name`,
        params
      );
      return { services: rows, count: rows.length };
    }

    case "pn_get_service": {
      const { slug } = args;
      const { rows: svcs } = await pool.query(
        `SELECT s.*, w.name AS workspace FROM services s
         LEFT JOIN workspaces w ON w.id = s.workspace_id
         WHERE s.tenant_id = $1 AND s.slug = $2`,
        [TENANT_ID, slug]
      );
      if (!svcs[0]) return { error: `Service '${slug}' not found` };
      const svc = svcs[0];
      const [health, backups, deps] = await Promise.all([
        pool.query(
          "SELECT status, status_code, latency_ms, error, ts FROM health_events WHERE service_id=$1 ORDER BY ts DESC LIMIT 10",
          [svc.id]
        ),
        pool.query(
          "SELECT label, backup_type, trust_state, taken_at, size_bytes FROM service_backups WHERE service_id=$1 ORDER BY taken_at DESC LIMIT 5",
          [svc.id]
        ),
        pool.query(
          `SELECT dep_type, u.name AS upstream, d.name AS downstream
           FROM service_dependencies sd
           JOIN services u ON u.id = sd.upstream_id
           JOIN services d ON d.id = sd.downstream_id
           WHERE sd.tenant_id=$1 AND (sd.upstream_id=$2 OR sd.downstream_id=$2)`,
          [TENANT_ID, svc.id]
        ),
      ]);
      return { service: svc, health_history: health.rows, backups: backups.rows, dependencies: deps.rows };
    }

    case "pn_blast_radius": {
      const { slug } = args;
      const { rows: svcs } = await pool.query(
        "SELECT id, name, slug FROM services WHERE tenant_id=$1 AND slug=$2", [TENANT_ID, slug]
      );
      if (!svcs[0]) return { error: `Service '${slug}' not found` };
      const id      = svcs[0].id;
      const visited = new Set([id]);
      const queue   = [{ id, depth: 0 }];
      const affected = [];
      while (queue.length) {
        const cur = queue.shift();
        const { rows } = await pool.query(
          `SELECT sd.downstream_id AS id, sd.dep_type, s.name, s.slug, s.status
           FROM service_dependencies sd JOIN services s ON s.id=sd.downstream_id
           WHERE sd.upstream_id=$1 AND sd.tenant_id=$2`,
          [cur.id, TENANT_ID]
        );
        for (const r of rows) {
          if (!visited.has(r.id)) {
            visited.add(r.id);
            affected.push({ ...r, depth: cur.depth + 1 });
            queue.push({ id: r.id, depth: cur.depth + 1 });
          }
        }
      }
      return {
        service: svcs[0], affected,
        summary: {
          total: affected.length,
          hard:  affected.filter(a => a.dep_type === "hard").length,
          soft:  affected.filter(a => a.dep_type !== "hard").length,
        },
      };
    }

    case "pn_restore_chain": {
      const { slug } = args;
      const { rows: svcs } = await pool.query(
        "SELECT id, name, slug FROM services WHERE tenant_id=$1 AND slug=$2", [TENANT_ID, slug]
      );
      if (!svcs[0]) return { error: `Service '${slug}' not found` };
      const id   = svcs[0].id;
      const seen = new Set([id]);
      const queue = [{ id, depth: 0 }];
      const chain = [];
      while (queue.length) {
        const cur = queue.shift();
        const { rows } = await pool.query(
          `SELECT sd.upstream_id AS id, sd.dep_type, s.name, s.slug, s.status, s.backup_policy
           FROM service_dependencies sd JOIN services s ON s.id=sd.upstream_id
           WHERE sd.downstream_id=$1 AND sd.tenant_id=$2`,
          [cur.id, TENANT_ID]
        );
        for (const r of rows) {
          if (!seen.has(r.id)) {
            seen.add(r.id);
            chain.push({ ...r, restore_order: cur.depth + 1 });
            queue.push({ id: r.id, depth: cur.depth + 1 });
          }
        }
      }
      chain.sort((a, b) => b.restore_order - a.restore_order);
      chain.push({ ...svcs[0], restore_order: 0, dep_type: "target" });
      return { service: svcs[0], restore_chain: chain };
    }

    case "pn_health_history": {
      const { slug, limit = 20 } = args;
      const { rows: svcs } = await pool.query(
        "SELECT id FROM services WHERE tenant_id=$1 AND slug=$2", [TENANT_ID, slug]
      );
      if (!svcs[0]) return { error: `Service '${slug}' not found` };
      const { rows } = await pool.query(
        "SELECT status, status_code, latency_ms, error, ts, source FROM health_events WHERE service_id=$1 ORDER BY ts DESC LIMIT $2",
        [svcs[0].id, Math.min(Number(limit), 100)]
      );
      return { slug, events: rows };
    }

    case "pn_list_backups": {
      const { slug, limit = 20 } = args;
      let q, params;
      if (slug) {
        const { rows: svcs } = await pool.query(
          "SELECT id FROM services WHERE tenant_id=$1 AND slug=$2", [TENANT_ID, slug]
        );
        if (!svcs[0]) return { error: `Service '${slug}' not found` };
        q      = `SELECT sb.*, s.name, s.slug FROM service_backups sb JOIN services s ON s.id=sb.service_id WHERE sb.service_id=$1 ORDER BY sb.taken_at DESC LIMIT $2`;
        params = [svcs[0].id, Math.min(Number(limit), 100)];
      } else {
        q      = `SELECT sb.*, s.name, s.slug FROM service_backups sb JOIN services s ON s.id=sb.service_id WHERE sb.tenant_id=$1 ORDER BY sb.taken_at DESC LIMIT $2`;
        params = [TENANT_ID, Math.min(Number(limit), 100)];
      }
      const { rows } = await pool.query(q, params);
      return { backups: rows };
    }

    case "pn_recent_activity": {
      const { limit = 30, action } = args;
      const params = [TENANT_ID];
      const where  = ["tenant_id = $1"];
      if (action) { params.push(`${action}%`); where.push(`action LIKE $${params.length}`); }
      const { rows } = await pool.query(
        `SELECT ts, username, role, action, target, outcome, ip
         FROM audit_log WHERE ${where.join(" AND ")} ORDER BY ts DESC LIMIT $${params.push(Math.min(Number(limit), 100))}`,
        params
      );
      return { events: rows };
    }

    case "pn_discovery_pending": {
      const { limit = 20 } = args;
      const { rows } = await pool.query(
        `SELECT source, host, suggested_name, suggested_slug, suggested_category,
                completeness_score, discovered_at
         FROM discovery_candidates WHERE tenant_id=$1 AND status='pending'
         ORDER BY completeness_score DESC, discovered_at DESC LIMIT $2`,
        [TENANT_ID, Math.min(Number(limit), 50)]
      );
      return { candidates: rows, count: rows.length };
    }

    // ── v3 write tools ────────────────────────────────────────────────────────

    case "pn_list_signals": {
      const { hours = 24 } = args;
      return backendCall("GET", `/api/intelligence/signals?hours=${Math.min(Number(hours), 168)}`);
    }

    case "pn_approve_proposal": {
      const { proposal_id } = args;
      if (!proposal_id) return { error: "proposal_id is required" };
      return backendCall("POST", `/api/intelligence/proposals/${proposal_id}/approve`);
    }

    case "pn_refresh_health": {
      const { slug } = args;
      if (!slug) return { error: "slug is required" };
      const { rows: svcs } = await pool.query(
        "SELECT id FROM services WHERE tenant_id=$1 AND slug=$2", [TENANT_ID, slug]
      );
      if (!svcs[0]) return { error: `Service '${slug}' not found` };
      return backendCall("POST", `/api/intelligence/service/${svcs[0].id}/probe`);
    }

    case "pn_restart_service": {
      const { slug } = args;
      if (!slug) return { error: "slug is required" };
      const { rows: svcs } = await pool.query(
        "SELECT id, container_name FROM services WHERE tenant_id=$1 AND slug=$2", [TENANT_ID, slug]
      );
      if (!svcs[0]) return { error: `Service '${slug}' not found` };
      if (!svcs[0].container_name) return { error: `Service '${slug}' has no container_name set` };
      return backendCall("POST", `/api/intelligence/service/${svcs[0].id}/restart`);
    }

    case "pn_run_simulation": {
      const { target_type, target_slug, scenario = "full_loss" } = args;
      if (!target_type) return { error: "target_type is required" };
      let target_id = null, target_name = null;
      if (target_slug) {
        const { rows: svcs } = await pool.query(
          "SELECT id, name FROM services WHERE tenant_id=$1 AND slug=$2", [TENANT_ID, target_slug]
        );
        if (!svcs[0]) return { error: `Service '${target_slug}' not found` };
        target_id   = svcs[0].id;
        target_name = svcs[0].name;
      }
      return backendCall("POST", "/api/recovery/simulate", {
        scenario_type: scenario, target_type, target_id, target_name,
      });
    }

    case "pn_get_playbook": {
      const { slug } = args;
      if (!slug) return { error: "slug is required" };
      const { rows: svcs } = await pool.query(
        "SELECT id FROM services WHERE tenant_id=$1 AND slug=$2", [TENANT_ID, slug]
      );
      if (!svcs[0]) return { error: `Service '${slug}' not found` };
      return backendCall("POST", "/api/recovery/playbook", { service_id: svcs[0].id });
    }

    default:
      return { error: `Unknown tool: ${name}` };
  }
}

// ── MCP HTTP server ──────────────────────────────────────────────────────────
function jsonResp(res, body, status = 200) {
  const data = JSON.stringify(body);
  res.writeHead(status, { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(data) });
  res.end(data);
}

const server = http.createServer(async (req, res) => {
  // Auth
  const auth = req.headers.authorization || "";
  if (TOKEN && auth !== `Bearer ${TOKEN}`) {
    return jsonResp(res, { error: "Unauthorized" }, 401);
  }

  if (req.method === "GET" && req.url === "/health") {
    return jsonResp(res, { ok: true, service: "privatenexus-mcp", version: "3.0.0", tools: TOOLS.length });
  }

  if (req.method !== "POST" || req.url !== "/mcp") {
    return jsonResp(res, { error: "POST /mcp only" }, 404);
  }

  let body = "";
  req.on("data", c => body += c);
  req.on("end", async () => {
    let rpc;
    try { rpc = JSON.parse(body); } catch {
      return jsonResp(res, { jsonrpc: "2.0", error: { code: -32700, message: "Parse error" }, id: null });
    }

    const { method, params, id } = rpc;

    if (method === "initialize") {
      return jsonResp(res, {
        jsonrpc: "2.0", id,
        result: {
          protocolVersion: "2024-11-05",
          capabilities: { tools: {} },
          serverInfo: { name: "privatenexus", version: "3.0.0" },
        },
      });
    }

    if (method === "tools/list") {
      return jsonResp(res, { jsonrpc: "2.0", id, result: { tools: TOOLS } });
    }

    if (method === "tools/call") {
      const { name, arguments: args = {} } = params;
      try {
        const result = await callTool(name, args);
        return jsonResp(res, {
          jsonrpc: "2.0", id,
          result: { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] },
        });
      } catch (err) {
        return jsonResp(res, {
          jsonrpc: "2.0", id,
          result: { content: [{ type: "text", text: `Error: ${err.message}` }], isError: true },
        });
      }
    }

    jsonResp(res, { jsonrpc: "2.0", error: { code: -32601, message: "Method not found" }, id });
  });
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`PrivateNexus MCP server v3 listening on ${PORT} — ${TOOLS.length} tools (${TOOLS.filter(t => ["pn_list_signals","pn_approve_proposal","pn_refresh_health","pn_restart_service","pn_run_simulation","pn_get_playbook"].includes(t.name)).length} write)`);
});
