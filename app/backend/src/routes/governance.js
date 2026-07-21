import { Router } from "express";
import { getPool } from "../db.js";
import { requireRole } from "../middleware/requireRole.js";
import { recordAudit } from "../auditLog.js";

export const governanceRouter = Router();

// Helper — write a change record (non-fatal, fire-and-forget)
export async function recordChange(tenantId, serviceId, serviceName, changeType, actor, summary, detail = null) {
  try {
    await getPool().query(
      `INSERT INTO change_records (tenant_id, service_id, service_name, change_type, actor, summary, detail)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [tenantId, serviceId || null, serviceName || null, changeType, actor, summary,
       detail ? JSON.stringify(detail) : null]
    );
  } catch { /* non-fatal */ }
}

// ── Built-in rule evaluators ────────────────────────────────────────────────
const CHECKS = {
  owner_required(svc) {
    const v = (svc.owner || "").toLowerCase().trim();
    if (!v || ["unknown", "unassigned", "tbd", "n/a", "none", ""].includes(v))
      return `Owner is '${svc.owner || "unset"}'`;
    return null;
  },
  backup_policy_required(svc) {
    if (["dev", "test"].includes((svc.category || "").toLowerCase())) return null;
    const v = (svc.backup_policy || "").toLowerCase().trim();
    if (!v || ["none", "unknown", "tbd", ""].includes(v))
      return `Backup policy is '${svc.backup_policy || "unset"}'`;
    return null;
  },
  health_check_required(svc) {
    if (!svc.health_endpoint) return "No health endpoint configured";
    return null;
  },
  access_mode_classified(svc) {
    const v = (svc.access_mode || "").toLowerCase().trim();
    if (!v || v === "unknown") return `Access mode is '${svc.access_mode || "unset"}'`;
    return null;
  },
  admin_service_protected(svc) {
    if ((svc.category || "").toLowerCase() !== "admin") return null;
    const mode = (svc.access_mode || "").toLowerCase();
    if (!["vpn", "vpn_only", "sso", "mtls", "internal"].includes(mode))
      return `Admin service uses access_mode '${svc.access_mode || "unset"}'`;
    return null;
  },
  recovery_runbook_required(svc) {
    if (!svc.recovery_runbook_url) return "No recovery runbook URL set";
    return null;
  },
  stale_backup(svc, backup) {
    if (!backup) return "No backup records found";
    const ageDays = (Date.now() - new Date(backup.taken_at).getTime()) / 86_400_000;
    if (ageDays > 7) return `Latest backup is ${Math.round(ageDays)} days old`;
    return null;
  },
};

async function evaluateViolations(tenantId) {
  const db = getPool();

  const [{ rows: services }, { rows: backups }, { rows: rules }, { rows: exceptions }] =
    await Promise.all([
      db.query(
        `SELECT s.*, w.name AS workspace_name FROM services s
         LEFT JOIN workspaces w ON w.id = s.workspace_id
         WHERE s.tenant_id = $1 AND s.archived = FALSE ORDER BY s.name`,
        [tenantId]
      ),
      db.query(
        `SELECT DISTINCT ON (service_id) service_id, taken_at
         FROM service_backups WHERE tenant_id = $1 ORDER BY service_id, taken_at DESC`,
        [tenantId]
      ),
      db.query(
        `SELECT * FROM policy_rules
         WHERE enabled = TRUE AND (tenant_id IS NULL OR tenant_id = $1)`,
        [tenantId]
      ),
      db.query(
        `SELECT service_id, rule_key FROM policy_exceptions
         WHERE tenant_id = $1 AND (expires_at IS NULL OR expires_at > NOW())`,
        [tenantId]
      ),
    ]);

  const latestBackup = Object.fromEntries(backups.map(b => [b.service_id, b]));
  const exSet = new Set(exceptions.map(e => `${e.service_id}:${e.rule_key}`));

  const violations = [];
  for (const svc of services) {
    for (const rule of rules) {
      if (exSet.has(`${svc.id}:${rule.rule_key}`)) continue;
      const checker = CHECKS[rule.rule_key];
      if (!checker) continue;
      const detail = checker(svc, latestBackup[svc.id]);
      if (detail) {
        violations.push({
          service_id:     svc.id,
          service_name:   svc.name,
          service_slug:   svc.slug,
          workspace_name: svc.workspace_name,
          category:       svc.category,
          rule_key:       rule.rule_key,
          rule_name:      rule.name,
          severity:       rule.severity,
          detail,
        });
      }
    }
  }

  const order = { critical: 0, warning: 1, info: 2 };
  violations.sort((a, b) => (order[a.severity] ?? 3) - (order[b.severity] ?? 3));
  return violations;
}

// ── Routes ──────────────────────────────────────────────────────────────────

// GET /api/governance/summary
governanceRouter.get("/summary", requireRole("viewer"), async (req, res) => {
  try {
    const v = await evaluateViolations(req.session.user.tenant_id);
    const s = { critical: 0, warning: 0, info: 0, total: v.length };
    for (const x of v) s[x.severity] = (s[x.severity] || 0) + 1;
    res.json({ ok: true, ...s });
  } catch (err) {
    console.error("[governance] error:", err.message);
    res.status(500).json({ ok: false, error: "Service unavailable" });
  }
});

// GET /api/governance/recommendations
governanceRouter.get("/recommendations", requireRole("viewer"), async (req, res) => {
  try {
    const violations = await evaluateViolations(req.session.user.tenant_id);
    res.json({ ok: true, violations, count: violations.length });
  } catch (err) {
    console.error("[governance] error:", err.message);
    res.status(500).json({ ok: false, error: "Service unavailable" });
  }
});

// GET /api/governance/rules
governanceRouter.get("/rules", requireRole("viewer"), async (req, res) => {
  try {
    const { rows } = await getPool().query(
      `SELECT * FROM policy_rules
       WHERE tenant_id IS NULL OR tenant_id = $1
       ORDER BY severity, name`,
      [req.session.user.tenant_id]
    );
    res.json({ ok: true, rules: rows });
  } catch (err) {
    console.error("[governance] error:", err.message);
    res.status(500).json({ ok: false, error: "Service unavailable" });
  }
});

// PATCH /api/governance/rules/:key/toggle — admin
governanceRouter.patch("/rules/:key/toggle", requireRole("admin"), async (req, res) => {
  try {
    const { rows } = await getPool().query(
      `UPDATE policy_rules SET enabled = NOT enabled WHERE rule_key = $1 RETURNING *`,
      [req.params.key]
    );
    if (!rows.length) return res.status(404).json({ ok: false, error: "Rule not found" });
    recordAudit(req, "governance.rule.toggle", rows[0].rule_key, "success", { enabled: rows[0].enabled, severity: rows[0].severity });
    res.json({ ok: true, rule: rows[0] });
  } catch (err) {
    console.error("[governance] error:", err.message);
    res.status(500).json({ ok: false, error: "Service unavailable" });
  }
});

// GET /api/governance/exceptions
governanceRouter.get("/exceptions", requireRole("viewer"), async (req, res) => {
  try {
    const { rows } = await getPool().query(
      `SELECT pe.*, s.name AS service_name, s.slug AS service_slug
       FROM policy_exceptions pe
       JOIN services s ON s.id = pe.service_id
       WHERE pe.tenant_id = $1
       ORDER BY pe.created_at DESC`,
      [req.session.user.tenant_id]
    );
    res.json({ ok: true, exceptions: rows });
  } catch (err) {
    console.error("[governance] error:", err.message);
    res.status(500).json({ ok: false, error: "Service unavailable" });
  }
});

// POST /api/governance/exceptions — admin
governanceRouter.post("/exceptions", requireRole("admin"), async (req, res) => {
  const { service_id, rule_key, reason, expires_at } = req.body;
  if (!service_id || !rule_key || !reason)
    return res.status(400).json({ ok: false, error: "service_id, rule_key, reason required" });
  try {
    const { rows } = await getPool().query(
      `INSERT INTO policy_exceptions (tenant_id, service_id, rule_key, reason, expires_at, created_by)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (tenant_id, service_id, rule_key) DO UPDATE
         SET reason = EXCLUDED.reason, expires_at = EXCLUDED.expires_at,
             created_by = EXCLUDED.created_by, created_at = NOW()
       RETURNING *`,
      [req.session.user.tenant_id, service_id, rule_key, reason, expires_at || null,
       req.session?.user?.username || "unknown"]
    );
    recordAudit(req, "governance.exception.create", rule_key, "success", { service_id, reason, expires_at: expires_at || null });
    res.status(201).json({ ok: true, exception: rows[0] });
  } catch (err) {
    console.error("[governance] error:", err.message);
    res.status(500).json({ ok: false, error: "Service unavailable" });
  }
});

// DELETE /api/governance/exceptions/:id — admin
governanceRouter.delete("/exceptions/:id", requireRole("admin"), async (req, res) => {
  try {
    const { rows } = await getPool().query(
      `DELETE FROM policy_exceptions WHERE id = $1 AND tenant_id = $2 RETURNING *`,
      [req.params.id, req.session.user.tenant_id]
    );
    if (!rows.length) return res.status(404).json({ ok: false, error: "Exception not found" });
    recordAudit(req, "governance.exception.delete", rows[0].rule_key, "success", { service_id: rows[0].service_id, reason: rows[0].reason });
    res.json({ ok: true });
  } catch (err) {
    console.error("[governance] error:", err.message);
    res.status(500).json({ ok: false, error: "Service unavailable" });
  }
});

// GET /api/governance/change-records
governanceRouter.get("/change-records", requireRole("viewer"), async (req, res) => {
  const limit  = Math.min(Number(req.query.limit  || 50), 200);
  const offset = Number(req.query.offset || 0);
  const conditions = ["tenant_id = $1"];
  const params = [req.session.user.tenant_id];
  if (req.query.service_id) {
    params.push(req.query.service_id);
    conditions.push(`service_id = $${params.length}`);
  }
  params.push(limit, offset);
  const limitIdx  = params.length - 1;
  const offsetIdx = params.length;
  try {
    const { rows } = await getPool().query(
      `SELECT * FROM change_records WHERE ${conditions.join(" AND ")}
       ORDER BY created_at DESC LIMIT $${limitIdx} OFFSET $${offsetIdx}`,
      params
    );
    res.json({ ok: true, records: rows });
  } catch (err) {
    console.error("[governance] error:", err.message);
    res.status(500).json({ ok: false, error: "Service unavailable" });
  }
});

// GET /api/governance/report — full structured report
governanceRouter.get("/report", requireRole("admin"), async (req, res) => {
  const db = getPool();
  const tenantId = req.session.user.tenant_id;
  try {
    const [violations, { rows: svcs }, { rows: staleBackups }, { rows: activity }] =
      await Promise.all([
        evaluateViolations(tenantId),
        db.query(
          `SELECT s.id, s.name, s.slug, s.category, s.access_mode, s.backup_policy,
                  s.owner, s.health_endpoint, s.recovery_runbook_url, s.status,
                  w.name AS workspace_name
           FROM services s LEFT JOIN workspaces w ON w.id = s.workspace_id
           WHERE s.tenant_id = $1 AND s.archived = FALSE ORDER BY s.name`,
          [tenantId]
        ),
        db.query(
          `SELECT s.id, s.name, s.slug, w.name AS workspace_name,
                  MAX(sb.taken_at) AS latest_backup,
                  ROUND(EXTRACT(EPOCH FROM (NOW() - MAX(sb.taken_at)))/86400)::int AS age_days
           FROM services s
           LEFT JOIN workspaces w ON w.id = s.workspace_id
           LEFT JOIN service_backups sb ON sb.service_id = s.id
           WHERE s.tenant_id = $1 AND s.archived = FALSE
           GROUP BY s.id, s.name, s.slug, w.name
           HAVING MAX(sb.taken_at) IS NULL OR MAX(sb.taken_at) < NOW() - INTERVAL '7 days'
           ORDER BY age_days DESC NULLS FIRST`,
          [tenantId]
        ),
        db.query(
          `SELECT username,
                  COUNT(*) FILTER (WHERE ts > NOW() - INTERVAL '30 days')::int AS actions_30d,
                  COUNT(*) FILTER (WHERE ts > NOW() - INTERVAL '90 days')::int AS actions_90d
           FROM audit_log WHERE tenant_id = $1
           GROUP BY username ORDER BY actions_90d DESC LIMIT 20`,
          [tenantId]
        ),
      ]);

    const byRule = (key) => violations.filter(v => v.rule_key === key);

    res.json({
      ok: true,
      generated_at: new Date().toISOString(),
      tenant_id: tenantId,
      summary: {
        total_services:    svcs.length,
        total_violations:  violations.length,
        critical:          violations.filter(v => v.severity === "critical").length,
        warning:           violations.filter(v => v.severity === "warning").length,
        info:              violations.filter(v => v.severity === "info").length,
      },
      sections: {
        owner_gaps:         byRule("owner_required"),
        backup_policy_gaps: byRule("backup_policy_required"),
        stale_backups:      staleBackups,
        health_check_gaps:  byRule("health_check_required"),
        admin_protection:   byRule("admin_service_protected"),
        runbook_gaps:       byRule("recovery_runbook_required"),
        activity_by_user:   activity,
        restore_readiness:  svcs.map(s => ({
          id: s.id, name: s.name, slug: s.slug, workspace: s.workspace_name,
          status: s.status, backup_policy: s.backup_policy,
          health_endpoint: !!s.health_endpoint,
          recovery_runbook_url: !!s.recovery_runbook_url,
        })),
      },
    });
  } catch (err) {
    console.error("[governance] error:", err.message);
    res.status(500).json({ ok: false, error: "Service unavailable" });
  }
});

// GET /api/governance/report/export — JSON download
governanceRouter.get("/report/export", requireRole("admin"), async (req, res) => {
  try {
    const db = getPool();
    const violations = await evaluateViolations(req.session.user.tenant_id);
    const { rows: svcs } = await db.query(
      `SELECT s.*, w.name AS workspace_name FROM services s
       LEFT JOIN workspaces w ON w.id = s.workspace_id
       WHERE s.tenant_id = $1 AND s.archived = FALSE ORDER BY s.name`,
      [req.session.user.tenant_id]
    );
    res.setHeader("Content-Disposition",
      `attachment; filename="governance-${new Date().toISOString().slice(0, 10)}.json"`);
    res.json({ generated_at: new Date().toISOString(), tenant: "house-of-trae", violations, services: svcs });
  } catch (err) {
    console.error("[governance] error:", err.message);
    res.status(500).json({ ok: false, error: "Service unavailable" });
  }
});
