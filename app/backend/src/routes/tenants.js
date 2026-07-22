import { Router } from "express";
import { getPool, getTenantSettings } from "../db.js";
import { recordAudit } from "../auditLog.js";
import { VALID_CATEGORIES } from "./services.js";

export const tenantsRouter = Router();

// Mounted with requireRole("superadmin") in server.js — every route here is
// superadmin-only, no per-route guard needed.

// GET /api/tenants — all tenants with service counts, health summary, last activity
tenantsRouter.get("/", async (_req, res) => {
  try {
    const { rows } = await getPool().query(`
      SELECT
        t.id, t.name, t.slug, t.created_at,
        COUNT(DISTINCT m.user_sub)::int AS member_count,
        COUNT(DISTINCT s.id)::int AS service_count,
        COUNT(DISTINCT s.id) FILTER (WHERE s.status = 'healthy')::int AS healthy_count,
        COUNT(DISTINCT s.id) FILTER (WHERE s.status IN ('warning','degraded','down'))::int AS unhealthy_count,
        MAX(a.ts) AS last_activity_at
      FROM tenants t
      LEFT JOIN tenant_memberships m ON m.tenant_id = t.id
      LEFT JOIN services s ON s.tenant_id = t.id AND s.archived = FALSE
      LEFT JOIN audit_log a ON a.tenant_id = t.id
      GROUP BY t.id, t.name, t.slug, t.created_at
      ORDER BY t.created_at ASC
    `);
    res.json({ ok: true, tenants: rows });
  } catch (err) {
    console.error("[tenants] error:", err.message);
    res.status(500).json({ ok: false, error: "Service unavailable" });
  }
});

// POST /api/tenants — create a new tenant
tenantsRouter.post("/", async (req, res) => {
  const { name, slug } = req.body || {};
  if (!name?.trim() || !slug?.trim()) {
    return res.status(400).json({ ok: false, error: "name and slug are required" });
  }
  const cleanSlug = slug.trim().toLowerCase().replace(/[^a-z0-9-]/g, "-");
  try {
    const { rows } = await getPool().query(
      "INSERT INTO tenants (name, slug) VALUES ($1, $2) RETURNING id, name, slug, created_at",
      [name.trim(), cleanSlug]
    );
    recordAudit(req, "tenant.create", rows[0].slug, "success", { tenant_id: rows[0].id });
    res.status(201).json({ ok: true, tenant: rows[0] });
  } catch (err) {
    if (err.code === "23505") return res.status(409).json({ ok: false, error: "Slug already in use" });
    console.error("[tenants] error:", err.message);
    res.status(500).json({ ok: false, error: "Service unavailable" });
  }
});

// POST /api/tenants/:id/members — add a user (by Keycloak sub) to a tenant
tenantsRouter.post("/:id/members", async (req, res) => {
  const { user_sub, role } = req.body || {};
  if (!user_sub?.trim()) return res.status(400).json({ ok: false, error: "user_sub is required" });
  try {
    const { rows } = await getPool().query(
      `INSERT INTO tenant_memberships (user_sub, tenant_id, role)
       VALUES ($1, $2, $3)
       ON CONFLICT (user_sub, tenant_id) DO UPDATE SET role = EXCLUDED.role
       RETURNING id, user_sub, tenant_id, role, joined_at`,
      [user_sub.trim(), req.params.id, role?.trim() || "member"]
    );
    recordAudit(req, "tenant.member_add", user_sub.trim(), "success", { tenant_id: req.params.id });
    res.status(201).json({ ok: true, membership: rows[0] });
  } catch (err) {
    if (err.code === "23503") return res.status(404).json({ ok: false, error: "Tenant not found" });
    console.error("[tenants] error:", err.message);
    res.status(500).json({ ok: false, error: "Service unavailable" });
  }
});

// GET /api/tenants/:id/members — list members of a tenant
tenantsRouter.get("/:id/members", async (req, res) => {
  try {
    const { rows } = await getPool().query(
      "SELECT id, user_sub, role, joined_at FROM tenant_memberships WHERE tenant_id = $1 ORDER BY joined_at ASC",
      [req.params.id]
    );
    res.json({ ok: true, members: rows });
  } catch (err) {
    console.error("[tenants] error:", err.message);
    res.status(500).json({ ok: false, error: "Service unavailable" });
  }
});

// DELETE /api/tenants/:id/members/:userSub — remove a member from a tenant
tenantsRouter.delete("/:id/members/:userSub", async (req, res) => {
  try {
    const { rowCount } = await getPool().query(
      "DELETE FROM tenant_memberships WHERE tenant_id = $1 AND user_sub = $2",
      [req.params.id, req.params.userSub]
    );
    if (!rowCount) return res.status(404).json({ ok: false, error: "Not found" });
    recordAudit(req, "tenant.member_remove", req.params.userSub, "success", { tenant_id: req.params.id });
    res.json({ ok: true });
  } catch (err) {
    console.error("[tenants] error:", err.message);
    res.status(500).json({ ok: false, error: "Service unavailable" });
  }
});

// GET /api/tenants/:id/settings — discovery/topology config (Proxmox/Caddy
// URLs, category inference rules, default workspace). Returns safe empty
// defaults if the tenant has never configured any of this yet.
tenantsRouter.get("/:id/settings", async (req, res) => {
  try {
    const settings = await getTenantSettings(req.params.id);
    res.json({ ok: true, settings });
  } catch (err) {
    console.error("[tenants] error:", err.message);
    res.status(500).json({ ok: false, error: "Service unavailable" });
  }
});

// PATCH /api/tenants/:id/settings — upsert (a tenant with no row yet gets
// one created on first save)
tenantsRouter.patch("/:id/settings", async (req, res) => {
  const { proxmox_url, caddy_admin_url, category_rules, default_category, default_workspace_slug, catalogue_repo_url } = req.body || {};

  if (default_category !== undefined && !VALID_CATEGORIES.includes(default_category)) {
    return res.status(400).json({ ok: false, error: `default_category must be one of: ${VALID_CATEGORIES.join(", ")}` });
  }
  if (catalogue_repo_url) {
    try { new URL(catalogue_repo_url); } catch {
      return res.status(400).json({ ok: false, error: "catalogue_repo_url must be a valid URL" });
    }
  }
  if (category_rules !== undefined) {
    if (!Array.isArray(category_rules)) {
      return res.status(400).json({ ok: false, error: "category_rules must be an array of {pattern, category}" });
    }
    for (const rule of category_rules) {
      if (!rule?.pattern || !VALID_CATEGORIES.includes(rule.category)) {
        return res.status(400).json({ ok: false, error: `every category_rules entry needs a pattern and a category in: ${VALID_CATEGORIES.join(", ")}` });
      }
      try { new RegExp(rule.pattern); } catch {
        return res.status(400).json({ ok: false, error: `invalid regex pattern: ${rule.pattern}` });
      }
    }
  }

  try {
    const { rows } = await getPool().query(
      `INSERT INTO tenant_settings (tenant_id, proxmox_url, caddy_admin_url, category_rules, default_category, default_workspace_slug, catalogue_repo_url)
       VALUES ($1, $2, $3, COALESCE($4::jsonb, '[]'::jsonb), COALESCE($5, 'app'), COALESCE($6, 'infrastructure'), $7)
       ON CONFLICT (tenant_id) DO UPDATE SET
         proxmox_url            = COALESCE(EXCLUDED.proxmox_url, tenant_settings.proxmox_url),
         caddy_admin_url        = COALESCE(EXCLUDED.caddy_admin_url, tenant_settings.caddy_admin_url),
         category_rules         = CASE WHEN $4::jsonb IS NULL THEN tenant_settings.category_rules ELSE EXCLUDED.category_rules END,
         default_category       = CASE WHEN $5 IS NULL THEN tenant_settings.default_category ELSE EXCLUDED.default_category END,
         default_workspace_slug = CASE WHEN $6 IS NULL THEN tenant_settings.default_workspace_slug ELSE EXCLUDED.default_workspace_slug END,
         catalogue_repo_url     = COALESCE(EXCLUDED.catalogue_repo_url, tenant_settings.catalogue_repo_url),
         updated_at              = NOW()
       RETURNING *`,
      [
        req.params.id,
        proxmox_url ?? null,
        caddy_admin_url ?? null,
        category_rules !== undefined ? JSON.stringify(category_rules) : null,
        default_category ?? null,
        default_workspace_slug ?? null,
        catalogue_repo_url ?? null,
      ]
    );
    recordAudit(req, "tenant.settings.update", req.params.id, "success");
    res.json({ ok: true, settings: rows[0] });
  } catch (err) {
    if (err.code === "23503") return res.status(404).json({ ok: false, error: "Tenant not found" });
    console.error("[tenants] error:", err.message);
    res.status(500).json({ ok: false, error: "Service unavailable" });
  }
});
