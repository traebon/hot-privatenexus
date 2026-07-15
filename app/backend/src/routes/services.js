import { Router } from "express";
import { getPool, HOT_TENANT_ID } from "../db.js";
import { requireRole } from "../middleware/requireRole.js";
import { recordAudit } from "../auditLog.js";
import { probeAllServices } from "../healthProbe.js";
import { recordChange } from "./governance.js";

export const servicesRouter = Router();

const VALID_CATEGORIES   = ["business", "personal", "ops", "admin", "infra"];
const VALID_ACCESS_MODES = ["public", "sso", "vpn_only", "internal", "mtls"];
const VALID_RUNTIME_TYPES = ["docker", "podman", "vm", "lxc", "external", "api"];
const VALID_STATUSES     = ["healthy", "warning", "degraded", "down", "unknown"];
const VALID_BACKUP_POLICIES = ["none", "daily", "weekly", "monthly", "manual"];
const VALID_URL_SCHEMES = new Set(["http:", "https:", "tcp:"]);

function validateUrl(urlStr, field) {
  if (!urlStr) return null;
  try {
    const { protocol } = new URL(urlStr);
    if (!VALID_URL_SCHEMES.has(protocol)) return `${field} must use http, https, or tcp scheme`;
  } catch {
    return `${field} is not a valid URL`;
  }
  return null;
}

function validate(body) {
  const errors = [];
  if (!body.name?.trim())         errors.push("name is required");
  if (!body.slug?.trim())         errors.push("slug is required");
  if (!VALID_CATEGORIES.includes(body.category))    errors.push("invalid category");
  if (!VALID_ACCESS_MODES.includes(body.access_mode)) errors.push("invalid access_mode");
  if (!VALID_RUNTIME_TYPES.includes(body.runtime_type)) errors.push("invalid runtime_type");
  if (!body.owner?.trim())        errors.push("owner is required");
  if (!VALID_BACKUP_POLICIES.includes(body.backup_policy)) errors.push("invalid backup_policy");
  const urlFields = { health_endpoint: body.health_endpoint, access_url: body.access_url, recovery_runbook_url: body.recovery_runbook_url };
  for (const [field, val] of Object.entries(urlFields)) {
    const err = validateUrl(val, field);
    if (err) errors.push(err);
  }
  return errors;
}

// GET /api/services?category=&workspace_id=&status=&archived=false
servicesRouter.get("/", requireRole("viewer"), async (req, res) => {
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
    if (req.query.status) {
      if (!VALID_STATUSES.includes(req.query.status))
        return res.status(400).json({ error: `Invalid status — must be one of: ${VALID_STATUSES.join(", ")}` });
      params.push(req.query.status);
      conditions.push(`s.status = $${params.length}`);
    }
    const showArchived = req.query.archived === "true";
    if (!showArchived) conditions.push("s.archived = FALSE");

    const where = `WHERE ${conditions.join(" AND ")}`;
    const { rows } = await getPool().query(
      `SELECT s.id, s.name, s.slug, s.description, s.category, s.access_url,
              s.access_mode, s.runtime_type, s.owner, s.backup_policy,
              s.health_endpoint, s.status, s.archived, s.created_at, s.updated_at,
              s.workspace_id, w.name AS workspace_name,
              (SELECT COUNT(*)::int FROM service_backups b WHERE b.service_id = s.id AND b.tenant_id = s.tenant_id) AS backup_count,
              (SELECT COUNT(*)::int FROM service_backups b WHERE b.service_id = s.id AND b.tenant_id = s.tenant_id AND b.trust_state = 'lkg') AS lkg_count,
              (SELECT COUNT(*)::int FROM service_backups b WHERE b.service_id = s.id AND b.tenant_id = s.tenant_id AND b.trust_state IN ('lkg','trusted')) AS trusted_count
         FROM services s
         LEFT JOIN workspaces w ON w.id = s.workspace_id
        ${where}
        ORDER BY s.category, s.name`,
      params
    );
    res.json(rows);
  } catch (err) {
    console.error("[services] error:", err.message);
    res.status(500).json({ error: "Service unavailable" });
  }
});

// POST /api/services — admin+
servicesRouter.post("/", requireRole("admin"), async (req, res) => {
  const errors = validate(req.body);
  if (errors.length) return res.status(400).json({ error: errors.join("; ") });

  const { name, slug, description, category, access_url, access_mode,
          runtime_type, owner, backup_policy, health_endpoint, workspace_id,
          recovery_runbook_url } = req.body;

  try {
    const { rows } = await getPool().query(
      `INSERT INTO services
         (tenant_id, workspace_id, name, slug, description, category, access_url,
          access_mode, runtime_type, owner, backup_policy, health_endpoint, recovery_runbook_url)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
       RETURNING *`,
      [HOT_TENANT_ID, workspace_id || null, name.trim(), slug.trim(),
       description || null, category, access_url || null, access_mode,
       runtime_type, owner.trim(), backup_policy, health_endpoint || null,
       recovery_runbook_url || null]
    );
    recordAudit(req, "service.create", rows[0].slug, "success");
    recordChange(HOT_TENANT_ID, rows[0].id, rows[0].name, "service_registered",
      req.session?.user?.username || "unknown",
      `Service '${rows[0].name}' registered in category '${rows[0].category}'`);
    res.status(201).json(rows[0]);
  } catch (err) {
    if (err.code === "23505") return res.status(409).json({ error: "Slug already exists" });
    console.error("[services] error:", err.message);
    res.status(500).json({ error: "Service unavailable" });
  }
});

// PUT /api/services/:id — admin+
servicesRouter.put("/:id", requireRole("admin"), async (req, res) => {
  const errors = validate(req.body);
  if (errors.length) return res.status(400).json({ error: errors.join("; ") });

  const { name, slug, description, category, access_url, access_mode,
          runtime_type, owner, backup_policy, health_endpoint, workspace_id,
          recovery_runbook_url } = req.body;

  try {
    const { rows } = await getPool().query(
      `UPDATE services SET
         workspace_id          = $1,
         name                  = $2,
         slug                  = $3,
         description           = $4,
         category              = $5,
         access_url            = $6,
         access_mode           = $7,
         runtime_type          = $8,
         owner                 = $9,
         backup_policy         = $10,
         health_endpoint       = $11,
         recovery_runbook_url  = $12,
         updated_at            = NOW()
       WHERE id = $13 AND tenant_id = $14
       RETURNING *`,
      [workspace_id || null, name.trim(), slug.trim(), description || null,
       category, access_url || null, access_mode, runtime_type, owner.trim(),
       backup_policy, health_endpoint || null, recovery_runbook_url || null,
       req.params.id, HOT_TENANT_ID]
    );
    if (!rows.length) return res.status(404).json({ error: "Not found" });
    recordAudit(req, "service.update", rows[0].slug, "success");
    recordChange(HOT_TENANT_ID, rows[0].id, rows[0].name, "service_updated",
      req.session?.user?.username || "unknown",
      `Service '${rows[0].name}' configuration updated`);
    res.json(rows[0]);
  } catch (err) {
    if (err.code === "23505") return res.status(409).json({ error: "Slug already exists" });
    console.error("[services] error:", err.message);
    res.status(500).json({ error: "Service unavailable" });
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
    console.error("[services] error:", err.message);
    res.status(500).json({ ok: false, error: "Service unavailable" });
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
    console.error("[services] error:", err.message);
    res.status(500).json({ error: "Service unavailable" });
  }
});

// GET /api/services/health — probe all services, write health_events, return results
servicesRouter.get("/health", requireRole("operator"), async (_req, res) => {
  try {
    const results = await probeAllServices("manual");
    res.json({ ok: true, results, ts: new Date().toISOString() });
  } catch (err) {
    console.error("[services] error:", err.message);
    res.status(500).json({ ok: false, error: "Service unavailable" });
  }
});

// GET /api/services/:id/health-history?limit=50 — health event history for a service
servicesRouter.get("/:id/health-history", requireRole("viewer"), async (req, res) => {
  const limit = Math.min(Number(req.query.limit) || 50, 200);
  try {
    const { rows } = await getPool().query(
      `SELECT id, ts, status, status_code, latency_ms, error, source
       FROM health_events
       WHERE service_id = $1 AND tenant_id = $2
       ORDER BY ts DESC
       LIMIT $3`,
      [req.params.id, HOT_TENANT_ID, limit]
    );
    res.json({ ok: true, events: rows });
  } catch (err) {
    console.error("[services] error:", err.message);
    res.status(500).json({ ok: false, error: "Service unavailable" });
  }
});

// ── Service backup records ────────────────────────────────────────────────────

const VALID_BACKUP_TYPES  = ["vm_snapshot", "data_export", "config", "full", "incremental", "manual"];
const VALID_TRUST_STATES  = ["lkg", "trusted", "untrusted", "unknown"];

function computeRecoveryScore(backups) {
  if (!backups.length) {
    return { score: 0, grade: "F", color: "rose", reasons: ["No backup records registered"], backupCount: 0, latestAt: null };
  }
  const sorted = [...backups].sort((a, b) => new Date(b.taken_at) - new Date(a.taken_at));
  const latest = sorted[0];
  const hasLkg     = backups.some((b) => b.trust_state === "lkg");
  const hasTrusted = backups.some((b) => ["lkg", "trusted"].includes(b.trust_state));
  const ageDays    = (Date.now() - new Date(latest.taken_at).getTime()) / 86_400_000;

  let score = 100;
  const reasons = [];

  if (!hasLkg)     { score -= 30; reasons.push("No LKG backup designated"); }
  if (!hasTrusted) { score -= 20; reasons.push("No trusted backup available"); }

  if      (ageDays > 30) { score -= 40; reasons.push(`Latest backup is ${Math.floor(ageDays)} days old`); }
  else if (ageDays > 7)  { score -= 25; reasons.push(`Latest backup is ${Math.floor(ageDays)} days old`); }
  else if (ageDays > 3)  { score -= 10; reasons.push(`Latest backup is ${Math.floor(ageDays)} days old`); }
  else if (ageDays > 1)  { score -= 5;  reasons.push(`Latest backup is ${Math.ceil(ageDays)} day old`); }

  score = Math.max(0, score);
  const grade = score >= 80 ? "A" : score >= 60 ? "B" : score >= 40 ? "C" : score >= 20 ? "D" : "F";
  const color = score >= 80 ? "emerald" : score >= 60 ? "yellow" : score >= 40 ? "amber" : "rose";
  return { score, grade, color, reasons, backupCount: backups.length, latestAt: latest.taken_at };
}

// GET /api/services/:id/backups — list backup records + recovery score
servicesRouter.get("/:id/backups", requireRole("viewer"), async (req, res) => {
  try {
    const { rows } = await getPool().query(
      `SELECT id, label, backup_type, trust_state, location, taken_at, size_bytes, notes, created_at
       FROM service_backups
       WHERE service_id = $1 AND tenant_id = $2
       ORDER BY taken_at DESC`,
      [req.params.id, HOT_TENANT_ID]
    );
    res.json({ ok: true, backups: rows, score: computeRecoveryScore(rows) });
  } catch (err) {
    console.error("[services] error:", err.message);
    res.status(500).json({ ok: false, error: "Service unavailable" });
  }
});

// POST /api/services/:id/backups — register a backup record (operator+)
servicesRouter.post("/:id/backups", requireRole("operator"), async (req, res) => {
  const { label, backup_type, trust_state, location, taken_at, size_bytes, notes } = req.body || {};
  if (!label?.trim()) return res.status(400).json({ ok: false, error: "label is required" });
  if (backup_type && !VALID_BACKUP_TYPES.includes(backup_type))
    return res.status(400).json({ ok: false, error: `invalid backup_type — must be one of: ${VALID_BACKUP_TYPES.join(", ")}` });
  if (trust_state && !VALID_TRUST_STATES.includes(trust_state))
    return res.status(400).json({ ok: false, error: `invalid trust_state — must be one of: ${VALID_TRUST_STATES.join(", ")}` });

  try {
    const { rows } = await getPool().query(
      `INSERT INTO service_backups
         (tenant_id, service_id, label, backup_type, trust_state, location, taken_at, size_bytes, notes)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       RETURNING *`,
      [HOT_TENANT_ID, req.params.id, label.trim(),
       backup_type || "manual", trust_state || "unknown",
       location || null, taken_at ? new Date(taken_at) : new Date(),
       size_bytes ? Number(size_bytes) : null, notes || null]
    );
    recordAudit(req, "service_backup.create", req.params.id, "success", { label: rows[0].label });
    res.status(201).json({ ok: true, backup: rows[0] });
  } catch (err) {
    console.error("[services] error:", err.message);
    res.status(500).json({ ok: false, error: "Service unavailable" });
  }
});

// PATCH /api/services/:id/backups/:backupId — update trust_state or notes (operator+)
servicesRouter.patch("/:id/backups/:backupId", requireRole("operator"), async (req, res) => {
  const { trust_state, notes, label } = req.body || {};
  if (trust_state && !VALID_TRUST_STATES.includes(trust_state))
    return res.status(400).json({ ok: false, error: "invalid trust_state" });

  const sets = [];
  const vals = [];
  if (trust_state !== undefined) { vals.push(trust_state); sets.push(`trust_state = $${vals.length}`); }
  if (notes      !== undefined) { vals.push(notes);       sets.push(`notes = $${vals.length}`); }
  if (label      !== undefined) { vals.push(label?.trim()); sets.push(`label = $${vals.length}`); }
  if (!sets.length) return res.status(400).json({ ok: false, error: "Nothing to update" });

  vals.push(req.params.backupId, HOT_TENANT_ID);
  try {
    const { rows } = await getPool().query(
      `UPDATE service_backups SET ${sets.join(", ")} WHERE id = $${vals.length - 1} AND tenant_id = $${vals.length} RETURNING *`,
      vals
    );
    if (!rows.length) return res.status(404).json({ ok: false, error: "Not found" });
    recordAudit(req, "service_backup.update", req.params.id, "success", { backupId: rows[0].id });
    res.json({ ok: true, backup: rows[0] });
  } catch (err) {
    console.error("[services] error:", err.message);
    res.status(500).json({ ok: false, error: "Service unavailable" });
  }
});

// DELETE /api/services/:id/backups/:backupId — remove a backup record (admin+)
servicesRouter.delete("/:id/backups/:backupId", requireRole("admin"), async (req, res) => {
  try {
    const { rowCount } = await getPool().query(
      "DELETE FROM service_backups WHERE id = $1 AND tenant_id = $2",
      [req.params.backupId, HOT_TENANT_ID]
    );
    if (!rowCount) return res.status(404).json({ ok: false, error: "Not found" });
    recordAudit(req, "service_backup.delete", req.params.id, "success", { backupId: req.params.backupId });
    res.json({ ok: true });
  } catch (err) {
    console.error("[services] error:", err.message);
    res.status(500).json({ ok: false, error: "Service unavailable" });
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
    recordAudit(req, "workspace.create", rows[0].slug, "success");
    res.status(201).json({ ok: true, workspace: rows[0] });
  } catch (err) {
    if (err.code === "23505") return res.status(409).json({ ok: false, error: "Slug already in use" });
    console.error("[services] error:", err.message);
    res.status(500).json({ ok: false, error: "Service unavailable" });
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
    recordAudit(req, "workspace.update", rows[0].slug, "success");
    res.json({ ok: true, workspace: rows[0] });
  } catch (err) {
    if (err.code === "23505") return res.status(409).json({ ok: false, error: "Slug already in use" });
    console.error("[services] error:", err.message);
    res.status(500).json({ ok: false, error: "Service unavailable" });
  }
});

// DELETE /api/services/workspaces/:id — delete a workspace (admin+)
servicesRouter.delete("/workspaces/:id", requireRole("admin"), async (req, res) => {
  // Reassign any services in this workspace to null first
  const { rowCount: reassigned } = await getPool().query(
    "UPDATE services SET workspace_id=NULL WHERE workspace_id=$1 AND tenant_id=$2",
    [req.params.id, HOT_TENANT_ID]
  );
  const { rows } = await getPool().query(
    "DELETE FROM workspaces WHERE id=$1 AND tenant_id=$2 RETURNING slug",
    [req.params.id, HOT_TENANT_ID]
  );
  if (!rows.length) return res.status(404).json({ ok: false, error: "Not found" });
  recordAudit(req, "workspace.delete", rows[0].slug, "success", { servicesReassigned: reassigned });
  res.json({ ok: true });
});
