import { getPool, HOT_TENANT_ID } from "./db.js";
import { userRole } from "./middleware/requireRole.js";

export function recordAudit(req, action, target, outcome, detail = null, userOverride = null) {
  const user = userOverride ?? req.session?.user ?? {};
  const role = userOverride ? (userOverride.role ?? "unknown") : (userRole(req.session) ?? "unknown");
  const ip   = req.ip || null;
  // Falls back to HOT_TENANT_ID only for pre-tenant-resolution sessions (there
  // shouldn't be any once auth.js always sets tenant_id at login) — not a
  // silent default that would misattribute a second tenant's audit trail.
  const tenantId = user.tenant_id ?? req.session?.user?.tenant_id ?? HOT_TENANT_ID;

  getPool()
    .query(
      `INSERT INTO audit_log (tenant_id, user_sub, username, role, action, target, outcome, detail, ip)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [
        tenantId,
        user.sub      ?? "unknown",
        user.username ?? "unknown",
        role,
        action,
        target  ?? null,
        outcome,
        detail !== null ? JSON.stringify(detail) : null,
        ip,
      ]
    )
    .catch((err) => console.error("[audit] write failed:", err.message));
}
