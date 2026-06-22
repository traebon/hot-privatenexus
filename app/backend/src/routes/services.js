import { Router } from "express";
import { getPool, HOT_TENANT_ID } from "../db.js";
import { requireRole } from "../middleware/requireRole.js";
import { recordAudit } from "../auditLog.js";

export const servicesRouter = Router();

const VALID_CATEGORIES   = ["business", "personal", "ops", "admin", "infra"];
const VALID_ACCESS_MODES = ["public", "sso", "vpn_only", "internal", "mtls"];
const VALID_RUNTIME_TYPES = ["docker", "podman", "vm", "lxc", "external", "api"];
const VALID_STATUSES     = ["healthy", "warning", "degraded", "down", "unknown"];
const VALID_BACKUP_POLICIES = ["none", "daily", "weekly", "monthly", "manual"];

function validate(body) {
  const errors = [];
  if (!body.name?.trim())         errors.push("name is required");
  if (!body.slug?.trim())         errors.push("slug is required");
  if (!VALID_CATEGORIES.includes(body.category))    errors.push("invalid category");
  if (!VALID_ACCESS_MODES.includes(body.access_mode)) errors.push("invalid access_mode");
  if (!VALID_RUNTIME_TYPES.includes(body.runtime_type)) errors.push("invalid runtime_type");
  if (!body.owner?.trim())        errors.push("owner is required");
  if (!VALID_BACKUP_POLICIES.includes(body.backup_policy)) errors.push("invalid backup_policy");
  return errors;
}

// GET /api/services?category=&workspace_id=&archived=false
servicesRouter.get("/", async (req, res) => {
  try {
    const conditions = ["s.tenant_id = $1"];
    const params = [HOT_TENANT_ID];

    if (req.query.category) {
      params.push(req.query.category);
      conditions.push(`s.category = $${params.length}`);
    }
    if (req.query.workspace_id) {
      params.push(req.query.workspace_id);
      conditions.push(`s.workspace_id = $${params.length}`);
    }
    const showArchived = req.query.archived === "true";
    if (!showArchived) conditions.push("s.archived = FALSE");

    const where = `WHERE ${conditions.join(" AND ")}`;
    const { rows } = await getPool().query(
      `SELECT s.id, s.name, s.slug, s.description, s.category, s.access_url,
              s.access_mode, s.runtime_type, s.owner, s.backup_policy,
              s.health_endpoint, s.status, s.archived, s.created_at, s.updated_at,
              s.workspace_id, w.name AS workspace_name
         FROM services s
         LEFT JOIN workspaces w ON w.id = s.workspace_id
        ${where}
        ORDER BY s.category, s.name`,
      params
    );
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/services — admin+
servicesRouter.post("/", requireRole("admin"), async (req, res) => {
  const errors = validate(req.body);
  if (errors.length) return res.status(400).json({ error: errors.join("; ") });

  const { name, slug, description, category, access_url, access_mode,
          runtime_type, owner, backup_policy, health_endpoint, workspace_id } = req.body;

  try {
    const { rows } = await getPool().query(
      `INSERT INTO services
         (tenant_id, workspace_id, name, slug, description, category, access_url,
          access_mode, runtime_type, owner, backup_policy, health_endpoint)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
       RETURNING *`,
      [HOT_TENANT_ID, workspace_id || null, name.trim(), slug.trim(),
       description || null, category, access_url || null, access_mode,
       runtime_type, owner.trim(), backup_policy, health_endpoint || null]
    );
    recordAudit(req, "service.create", rows[0].slug, "success");
    res.status(201).json(rows[0]);
  } catch (err) {
    if (err.code === "23505") return res.status(409).json({ error: "Slug already exists" });
    res.status(500).json({ error: err.message });
  }
});

// PUT /api/services/:id — admin+
servicesRouter.put("/:id", requireRole("admin"), async (req, res) => {
  const errors = validate(req.body);
  if (errors.length) return res.status(400).json({ error: errors.join("; ") });

  const { name, slug, description, category, access_url, access_mode,
          runtime_type, owner, backup_policy, health_endpoint, workspace_id } = req.body;

  try {
    const { rows } = await getPool().query(
      `UPDATE services SET
         workspace_id   = $1,
         name           = $2,
         slug           = $3,
         description    = $4,
         category       = $5,
         access_url     = $6,
         access_mode    = $7,
         runtime_type   = $8,
         owner          = $9,
         backup_policy  = $10,
         health_endpoint = $11,
         updated_at     = NOW()
       WHERE id = $12 AND tenant_id = $13
       RETURNING *`,
      [workspace_id || null, name.trim(), slug.trim(), description || null,
       category, access_url || null, access_mode, runtime_type, owner.trim(),
       backup_policy, health_endpoint || null, req.params.id, HOT_TENANT_ID]
    );
    if (!rows.length) return res.status(404).json({ error: "Not found" });
    recordAudit(req, "service.update", rows[0].slug, "success");
    res.json(rows[0]);
  } catch (err) {
    if (err.code === "23505") return res.status(409).json({ error: "Slug already exists" });
    res.status(500).json({ error: err.message });
  }
});

// GET /api/services/workspaces — list workspaces for the modal dropdown
servicesRouter.get("/workspaces", requireRole("viewer"), async (_req, res) => {
  try {
    const { rows } = await getPool().query(
      "SELECT id, name, slug FROM workspaces WHERE tenant_id = $1 ORDER BY name",
      [HOT_TENANT_ID]
    );
    res.json({ ok: true, workspaces: rows });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// GET /api/services/workspaces — list workspaces for the modal dropdown
servicesRouter.get("/workspaces", requireRole("viewer"), async (_req, res) => {
  try {
    const { rows } = await getPool().query(
      "SELECT id, name, slug FROM workspaces WHERE tenant_id = $1 ORDER BY name",
      [HOT_TENANT_ID]
    );
    res.json({ ok: true, workspaces: rows });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// PATCH /api/services/:id — admin+ (status or archived)
servicesRouter.patch("/:id", requireRole("admin"), async (req, res) => {
  const allowed = {};
  if (req.body.status !== undefined) {
    if (!VALID_STATUSES.includes(req.body.status))
      return res.status(400).json({ error: "invalid status" });
    allowed.status = req.body.status;
  }
  if (req.body.archived !== undefined) {
    allowed.archived = Boolean(req.body.archived);
  }
  if (!Object.keys(allowed).length) return res.status(400).json({ error: "Nothing to update" });

  const sets = Object.keys(allowed).map((k, i) => `${k} = $${i + 1}`);
  const vals = [...Object.values(allowed), req.params.id, HOT_TENANT_ID];

  try {
    const { rows } = await getPool().query(
      `UPDATE services SET ${sets.join(", ")}, updated_at = NOW()
       WHERE id = $${vals.length - 1} AND tenant_id = $${vals.length}
       RETURNING *`,
      vals
    );
    if (!rows.length) return res.status(404).json({ error: "Not found" });
    const action = allowed.archived !== undefined ? (allowed.archived ? "service.archive" : "service.restore") : "service.status";
    recordAudit(req, action, rows[0].slug, "success");
    res.json(rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/services/health — probe all services with a health_endpoint
// Maps HTTP status → service status, writes results to DB, returns probe array
servicesRouter.get("/health", requireRole("operator"), async (_req, res) => {
  try {
    const { rows: services } = await getPool().query(
      `SELECT id, slug, health_endpoint FROM services
       WHERE tenant_id = $1 AND health_endpoint IS NOT NULL AND archived = FALSE`,
      [HOT_TENANT_ID]
    );

    if (!services.length) return res.json({ ok: true, results: [], ts: new Date().toISOString() });

    const probe = async (svc) => {
      const start = Date.now();
      try {
        const r = await fetch(svc.health_endpoint, {
          method: "GET",
          signal: AbortSignal.timeout(5000),
          headers: { "User-Agent": "PrivateNexus-HealthCheck/1.0" },
        });
        const latencyMs  = Date.now() - start;
        const statusCode = r.status;
        const status = statusCode < 300 ? "healthy"
                     : statusCode < 500 ? "warning"
                     : "degraded";
        return { id: svc.id, slug: svc.slug, status, statusCode, latencyMs, error: null };
      } catch (err) {
        return {
          id: svc.id, slug: svc.slug,
          status: "down",
          statusCode: null,
          latencyMs: Date.now() - start,
          error: err.name === "TimeoutError" ? "timeout" : err.message,
        };
      }
    };

    const results = await Promise.all(services.map(probe));

    // Write results back to DB in bulk
    const pool = getPool();
    await Promise.all(
      results.map((r) =>
        pool.query(
          `UPDATE services SET status = $1, updated_at = NOW()
           WHERE id = $2 AND tenant_id = $3`,
          [r.status, r.id, HOT_TENANT_ID]
        )
      )
    );

    res.json({ ok: true, results, ts: new Date().toISOString() });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// POST /api/services/workspaces — create a workspace (admin+)
servicesRouter.post("/workspaces", requireRole("admin"), async (req, res) => {
  const { name, slug } = req.body;
  if (!name?.trim() || !slug?.trim()) {
    return res.status(400).json({ ok: false, error: "name and slug are required" });
  }
  try {
    const { rows } = await getPool().query(
      "INSERT INTO workspaces (tenant_id, name, slug) VALUES ($1, $2, $3) RETURNING id, name, slug",
      [HOT_TENANT_ID, name.trim(), slug.trim().toLowerCase().replace(/[^a-z0-9-]/g, "-")]
    );
    res.status(201).json({ ok: true, workspace: rows[0] });
  } catch (err) {
    if (err.code === "23505") return res.status(409).json({ ok: false, error: "Slug already in use" });
    res.status(500).json({ ok: false, error: err.message });
  }
});

// PATCH /api/services/workspaces/:id — rename a workspace (admin+)
servicesRouter.patch("/workspaces/:id", requireRole("admin"), async (req, res) => {
  const { name, slug } = req.body;
  if (!name?.trim()) return res.status(400).json({ ok: false, error: "name is required" });
  try {
    const { rows } = await getPool().query(
      "UPDATE workspaces SET name=$1, slug=$2 WHERE id=$3 AND tenant_id=$4 RETURNING id, name, slug",
      [name.trim(), (slug || name).trim().toLowerCase().replace(/[^a-z0-9-]/g, "-"), req.params.id, HOT_TENANT_ID]
    );
    if (!rows.length) return res.status(404).json({ ok: false, error: "Not found" });
    res.json({ ok: true, workspace: rows[0] });
  } catch (err) {
    if (err.code === "23505") return res.status(409).json({ ok: false, error: "Slug already in use" });
    res.status(500).json({ ok: false, error: err.message });
  }
});

// DELETE /api/services/workspaces/:id — delete a workspace (admin+)
servicesRouter.delete("/workspaces/:id", requireRole("admin"), async (req, res) => {
  // Reassign any services in this workspace to null first
  await getPool().query(
    "UPDATE services SET workspace_id=NULL WHERE workspace_id=$1 AND tenant_id=$2",
    [req.params.id, HOT_TENANT_ID]
  );
  const { rowCount } = await getPool().query(
    "DELETE FROM workspaces WHERE id=$1 AND tenant_id=$2",
    [req.params.id, HOT_TENANT_ID]
  );
  if (!rowCount) return res.status(404).json({ ok: false, error: "Not found" });
  res.json({ ok: true });
});
