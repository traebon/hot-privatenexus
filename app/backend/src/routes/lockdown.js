import { Router } from "express";
import { getPool } from "../db.js";
import { recordAudit } from "../auditLog.js";
import { requireRole, userRole, roleLevel } from "../middleware/requireRole.js";

export const lockdownRouter = Router();

// Tiers escalate in this fixed order; the escalate endpoint only allows moving
// forward (index increasing) — de-escalation is always the separate /clear
// endpoint, never implicit. See PrivateNexus_Security_Lockdown_Mode_Design.md §1.
const TIERS = ["alert", "soft", "hard", "full"];

// Minimum role required to *manually* escalate into each tier. Full is
// deliberately gated at breakglass — the top of the hierarchy, stricter than
// even superadmin — matching the design doc's decision that a fleet-wide stop
// should never be one admin click away.
const TIER_MIN_ROLE = { alert: "operator", soft: "operator", hard: "admin", full: "breakglass" };

function tierIndex(tier) {
  return TIERS.indexOf(tier);
}

// GET /api/lockdown/status — current active episode for this tenant, or tier:"none"
lockdownRouter.get("/status", requireRole("viewer"), async (req, res) => {
  try {
    const { rows } = await getPool().query(
      `SELECT id, tier, activated_at, activated_by, trigger_source, trigger_ref, reason, expires_at
       FROM lockdown_state
       WHERE tenant_id = $1 AND cleared_at IS NULL
       ORDER BY activated_at DESC LIMIT 1`,
      [req.session.user.tenant_id]
    );
    if (!rows[0]) return res.json({ ok: true, tier: "none" });
    res.json({ ok: true, tier: rows[0].tier, ...rows[0] });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// GET /api/lockdown/history — recent tier-change/action events for this tenant
lockdownRouter.get("/history", requireRole("viewer"), async (req, res) => {
  try {
    const { rows } = await getPool().query(
      `SELECT le.id, le.event_type, le.detail, le.created_at,
              ls.id AS lockdown_id, ls.tier, ls.activated_by, ls.cleared_at
       FROM lockdown_events le
       JOIN lockdown_state ls ON ls.id = le.lockdown_id
       WHERE ls.tenant_id = $1
       ORDER BY le.created_at DESC LIMIT 100`,
      [req.session.user.tenant_id]
    );
    res.json({ ok: true, events: rows });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// POST /api/lockdown/escalate — { tier, reason }
// Manual-only in this step — trigger_source is always "manual" until the
// Wazuh webhook (step 4) and CrowdSec/Hard-tier wiring (step 3) land. No
// side-effecting actions (maintenance mode, CrowdSec bans, container stops)
// are performed yet — this step only proves the state machine + audit trail.
lockdownRouter.post("/escalate", requireRole("operator"), async (req, res) => {
  const { tier, reason } = req.body || {};

  if (!TIERS.includes(tier)) {
    return res.status(400).json({ ok: false, error: `tier must be one of: ${TIERS.join(", ")}` });
  }
  if (!reason || typeof reason !== "string" || !reason.trim()) {
    return res.status(400).json({ ok: false, error: "reason is required" });
  }

  const minRole = TIER_MIN_ROLE[tier];
  const callerLevel = roleLevel(userRole(req.session));
  if (callerLevel < roleLevel(minRole)) {
    recordAudit(req, "lockdown.escalate.blocked", tier, "failure", { reason: "elevation_required", required: minRole });
    return res.status(403).json({ ok: false, error: `Escalating to '${tier}' requires ${minRole} role or higher` });
  }

  const db = getPool();
  const tenantId = req.session.user.tenant_id;
  const actor = req.session?.user?.username || "unknown";

  try {
    const { rows: active } = await db.query(
      `SELECT id, tier FROM lockdown_state WHERE tenant_id = $1 AND cleared_at IS NULL LIMIT 1`,
      [tenantId]
    );
    const current = active[0];

    if (current) {
      if (tierIndex(tier) <= tierIndex(current.tier)) {
        return res.status(409).json({
          ok: false,
          error: `Already at '${current.tier}', which is at or above '${tier}'. Use /clear to de-escalate first.`,
        });
      }

      await db.query(
        `UPDATE lockdown_state SET tier = $1 WHERE id = $2`,
        [tier, current.id]
      );
      await db.query(
        `INSERT INTO lockdown_events (lockdown_id, event_type, detail)
         VALUES ($1, 'tier_change', $2)`,
        [current.id, JSON.stringify({ from: current.tier, to: tier, reason, trigger_source: "manual", actor })]
      );
      recordAudit(req, "lockdown.escalate", tier, "success", { from: current.tier, to: tier, reason });
      return res.json({ ok: true, tier, lockdown_id: current.id, from: current.tier });
    }

    const { rows: created } = await db.query(
      `INSERT INTO lockdown_state (tenant_id, tier, activated_by, trigger_source, reason)
       VALUES ($1, $2, $3, 'manual', $4) RETURNING id`,
      [tenantId, tier, actor, reason]
    );
    await db.query(
      `INSERT INTO lockdown_events (lockdown_id, event_type, detail)
       VALUES ($1, 'tier_change', $2)`,
      [created[0].id, JSON.stringify({ from: "none", to: tier, reason, trigger_source: "manual", actor })]
    );
    recordAudit(req, "lockdown.escalate", tier, "success", { from: "none", to: tier, reason });
    res.status(201).json({ ok: true, tier, lockdown_id: created[0].id, from: "none" });
  } catch (err) {
    recordAudit(req, "lockdown.escalate", tier, "failure", { error: err.message });
    res.status(500).json({ ok: false, error: err.message });
  }
});

// POST /api/lockdown/clear — de-escalate to none. Deliberately admin+, not
// breakglass-gated — clearing a false alarm shouldn't need the highest role,
// only *entering* Full does.
lockdownRouter.post("/clear", requireRole("admin"), async (req, res) => {
  const { note } = req.body || {};
  const db = getPool();
  const tenantId = req.session.user.tenant_id;
  const actor = req.session?.user?.username || "unknown";

  try {
    const { rows: active } = await db.query(
      `SELECT id, tier FROM lockdown_state WHERE tenant_id = $1 AND cleared_at IS NULL LIMIT 1`,
      [tenantId]
    );
    const current = active[0];
    if (!current) {
      return res.status(404).json({ ok: false, error: "No active lockdown to clear" });
    }

    await db.query(
      `UPDATE lockdown_state SET cleared_at = now(), cleared_by = $1 WHERE id = $2`,
      [actor, current.id]
    );
    await db.query(
      `INSERT INTO lockdown_events (lockdown_id, event_type, detail)
       VALUES ($1, 'tier_change', $2)`,
      [current.id, JSON.stringify({ from: current.tier, to: "none", note: note || null, actor })]
    );
    recordAudit(req, "lockdown.clear", current.tier, "success", { from: current.tier, note: note || null });
    res.json({ ok: true, tier: "none", cleared_from: current.tier });
  } catch (err) {
    recordAudit(req, "lockdown.clear", null, "failure", { error: err.message });
    res.status(500).json({ ok: false, error: err.message });
  }
});
