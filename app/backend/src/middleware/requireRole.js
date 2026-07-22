import { recordAudit } from "../auditLog.js";

const ROLE_HIERARCHY = ["viewer", "operator", "admin", "superadmin", "breakglass"];

export function requireRole(minRole) {
  const minLevel = ROLE_HIERARCHY.indexOf(minRole);
  if (minLevel === -1) throw new Error(`Unknown role: ${minRole}`);

  return (req, res, next) => {
    const userRoles = req.session?.user?.roles ?? [];
    const userLevel = Math.max(
      ...userRoles.map((r) => ROLE_HIERARCHY.indexOf(r)).filter((l) => l >= 0),
      -1
    );
    if (userLevel >= minLevel) return next();
    recordAudit(req, "access.forbidden", req.originalUrl, "failure", {
      method: req.method,
      required: minRole,
    });
    res.status(403).json({ error: "Forbidden", required: minRole });
  };
}

export function userRole(session) {
  const roles = session?.user?.roles ?? [];
  let highest = -1;
  for (const r of roles) {
    const l = ROLE_HIERARCHY.indexOf(r);
    if (l > highest) highest = l;
  }
  return highest >= 0 ? ROLE_HIERARCHY[highest] : null;
}
