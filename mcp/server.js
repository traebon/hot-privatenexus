#!/usr/bin/env node
// PrivateNexus MCP Server — read-only tools for JARVIS/Claude Code
// Runs as HTTP server; tools query PostgreSQL directly (read-only connection)
import { readFileSync } from "fs";
import http from "node:http";
import pg from "pg";

const { Pool } = pg;

const PORT  = Number(process.env.MCP_PORT || 3002);
const TOKEN = readSecret("/run/secrets/mcp_token") ?? process.env.MCP_TOKEN;
const TENANT_ID = "10000000-0000-0000-0000-000000000001";

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

// ── Tool definitions ─────────────────────────────────────────────────────────
const TOOLS = [
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
      properties: {
        slug: { type: "string", description: "Service slug" },
      },
      required: ["slug"],
    },
  },
  {
    name: "pn_blast_radius",
    description: "Given a service slug, return all services that would be affected if it went down, with dependency types (hard/soft) and depth.",
    inputSchema: {
      type: "object",
      properties: {
        slug: { type: "string", description: "Service slug to analyse" },
      },
      required: ["slug"],
    },
  },
  {
    name: "pn_restore_chain",
    description: "Given a service slug, return the ordered list of services that must be restored first (dependencies before dependents).",
    inputSchema: {
      type: "object",
      properties: {
        slug: { type: "string", description: "Service slug to restore" },
      },
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
      properties: {
        limit: { type: "number", description: "Max results (default 20)" },
      },
    },
  },
];

// ── Tool handlers ─────────────────────────────────────────────────────────────
async function callTool(name, args) {
  switch (name) {

    case "pn_summary": {
      const [svcs, activity, disc] = await Promise.all([
        pool.query("SELECT status, COUNT(*)::int n FROM services WHERE tenant_id=$1 AND archived=FALSE GROUP BY status", [TENANT_ID]),
        pool.query("SELECT action, outcome, ts FROM audit_log WHERE tenant_id=$1 ORDER BY ts DESC LIMIT 5", [TENANT_ID]),
        pool.query("SELECT COUNT(*)::int n FROM discovery_candidates WHERE tenant_id=$1 AND status='pending'", [TENANT_ID]),
      ]);
      const statusMap = Object.fromEntries(svcs.rows.map(r => [r.status, r.n]));
      return {
        service_counts: statusMap,
        total_services: Object.values(statusMap).reduce((a, b) => a + b, 0),
        pending_discovery: disc.rows[0].n,
        recent_activity: activity.rows,
      };
    }

    case "pn_list_services": {
      const { status, workspace, category } = args;
      const params = [TENANT_ID];
      const clauses = ["s.tenant_id = $1", "s.archived = FALSE"];
      if (status)    { params.push(status);    clauses.push(`s.status = $${params.length}`); }
      if (category)  { params.push(category);  clauses.push(`s.category = $${params.length}`); }
      if (workspace) { params.push(workspace); clauses.push(`w.slug = $${params.length}`); }
      const { rows } = await pool.query(
        `SELECT s.name, s.slug, s.status, s.category, s.access_mode, s.runtime_type,
                s.backup_policy, s.health_endpoint, s.updated_at,
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
      const id = svcs[0].id;

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
      const id = svcs[0].id;

      const seen  = new Set([id]);
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
        q = `SELECT sb.*, s.name, s.slug FROM service_backups sb JOIN services s ON s.id=sb.service_id
             WHERE sb.service_id=$1 ORDER BY sb.taken_at DESC LIMIT $2`;
        params = [svcs[0].id, Math.min(Number(limit), 100)];
      } else {
        q = `SELECT sb.*, s.name, s.slug FROM service_backups sb JOIN services s ON s.id=sb.service_id
             WHERE sb.tenant_id=$1 ORDER BY sb.taken_at DESC LIMIT $2`;
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

    default:
      return { error: `Unknown tool: ${name}` };
  }
}

// ── MCP HTTP server ──────────────────────────────────────────────────────────
// Implements a minimal subset of MCP over HTTP (JSON-RPC 2.0)
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
    return jsonResp(res, { ok: true, service: "privatenexus-mcp", tools: TOOLS.length });
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
          serverInfo: { name: "privatenexus", version: "2.0.0" },
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
  console.log(`PrivateNexus MCP server listening on ${PORT} — ${TOOLS.length} tools`);
});
