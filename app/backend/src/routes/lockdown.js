import { Router } from "express";
import { createHash } from "crypto";
import { getPool } from "../db.js";
import { recordAudit } from "../auditLog.js";
import { requireRole, userRole, roleLevel } from "../middleware/requireRole.js";
import { applyCrowdSecBan } from "../crowdsecClient.js";
import {
  enableMaintenanceMode,
  disableMaintenanceMode,
  getMaintenanceState,
  blastRadiusCheck,
  CONTAINER_BLOCKLIST,
} from "./actions.js";
import { getDocker } from "../dockerClient.js";

export const lockdownRouter = Router();

function hashToken(t) {
  return createHash("sha256").update(t).digest("hex");
}

// Wazuh rule-level cutoffs -- design doc §1. Full tier has no automatic
// trigger at all (manual + breakglass-only), so there is no HARD_LEVEL ceiling
// here -- anything at HARD_LEVEL or above still only auto-escalates to 'hard'.
const ALERT_LEVEL = 10;
const SOFT_LEVEL = 12;
const HARD_LEVEL = 15;

// Soft tier's fleet-wide cooldown multiplier -- a starting proposal per the
// design doc, tunable once real signal volume is observed. Restored to the
// exact original per-row values on /clear (see the cooldown_multiplier
// lockdown_events row written below), not just divided back, so repeated
// escalations during one episode can't compound the multiplier.
const COOLDOWN_MULTIPLIER = 3;

// Soft tier's auto-enabled maintenance window -- long enough to cover a real
// investigation, short enough that it can't be silently forgotten the way
// indefinite maintenance mode used to be (see actions.js's ACT-03 fix).
const SOFT_MAINTENANCE_SECS = 4 * 3600;

// Marker written into the maintenance-mode reason string so /clear can tell
// whether it auto-enabled maintenance mode itself (and should turn it back
// off) versus an operator having separately turned it on for unrelated
// reasons (which this feature must not clobber).
const LOCKDOWN_MAINTENANCE_MARKER = "[pn-lockdown-soft]";

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

// Applies the tier-specific side effects (design doc §1) and records each one
// as a lockdown_events row, win or lose — a failed action is just as
// important to see on the timeline as a successful one.
async function applyTierActions({ tenantId, lockdownId, tier, reason, targetIp, targetScope, durationSecs, containerName, serviceId }) {
  const db = getPool();
  const actions = {};

  if (tier === "soft") {
    // Tighten every enabled action_policies row's cooldown fleet-wide for the
    // duration of this tier. Snapshot the pre-multiplier values into the
    // event detail so /clear can restore them exactly, not just divide back
    // (which would compound if Soft is entered more than once per episode —
    // it can't be here since tiers are monotonic, but the snapshot approach
    // is correct either way and costs nothing extra).
    const { rows: policies } = await db.query(
      `SELECT action_type, cooldown_secs FROM action_policies WHERE enabled = TRUE AND cooldown_secs IS NOT NULL`
    );
    if (policies.length) {
      await db.query(
        `UPDATE action_policies SET cooldown_secs = cooldown_secs * $1 WHERE enabled = TRUE AND cooldown_secs IS NOT NULL`,
        [COOLDOWN_MULTIPLIER]
      );
      await db.query(
        `INSERT INTO lockdown_events (lockdown_id, event_type, detail) VALUES ($1, 'action_taken', $2)`,
        [lockdownId, JSON.stringify({ action: "cooldown_multiplier", multiplier: COOLDOWN_MULTIPLIER, originals: policies })]
      );
      actions.cooldownMultiplier = { applied: true, multiplier: COOLDOWN_MULTIPLIER, affected: policies.length };
    }

    const maintReason = `${LOCKDOWN_MAINTENANCE_MARKER} ${reason || "Lockdown Mode Soft tier"}`;
    const maintState = await enableMaintenanceMode({ durationSecs: SOFT_MAINTENANCE_SECS, reason: maintReason, createdBy: "pn-lockdown" });
    await db.query(
      `INSERT INTO lockdown_events (lockdown_id, event_type, detail) VALUES ($1, 'action_taken', $2)`,
      [lockdownId, JSON.stringify({ action: "maintenance.enable", durationSecs: SOFT_MAINTENANCE_SECS })]
    );
    actions.maintenance = maintState;
  }

  if (tier === "hard") {
    if (targetIp) {
      const banResult = await applyCrowdSecBan({
        scope: targetScope === "range" ? "range" : "ip",
        value: targetIp,
        durationSecs: Number.isFinite(Number(durationSecs)) ? Number(durationSecs) : undefined,
        reason,
      });
      await db.query(
        `INSERT INTO lockdown_events (lockdown_id, event_type, detail) VALUES ($1, $2, $3)`,
        [lockdownId, banResult.ok ? "action_taken" : "action_failed",
         JSON.stringify({ action: "crowdsec.ban", target: targetIp, scope: targetScope || "ip", result: banResult })]
      );
      actions.ban = banResult;
    }

    // Container-stop is optional and only applies when the caller (manual
    // escalate, or a future richer Wazuh decoder) can actually name a
    // PN-managed container — routed through the *existing* blast-radius
    // check, never bypassing it, per the design doc's explicit "Hard tier
    // does not get a bypass" rule.
    if (containerName) {
      if (CONTAINER_BLOCKLIST.has(containerName)) {
        await db.query(
          `INSERT INTO lockdown_events (lockdown_id, event_type, detail) VALUES ($1, 'action_failed', $2)`,
          [lockdownId, JSON.stringify({ action: "container.stop", target: containerName, blocked: "blocklisted" })]
        );
        actions.containerStop = { ok: false, blocked: "blocklisted" };
      } else {
        const br = serviceId ? await blastRadiusCheck(serviceId, tenantId) : { count: 0, hard: 0, affected: [] };
        if (br.hard > 0) {
          await db.query(
            `INSERT INTO lockdown_events (lockdown_id, event_type, detail) VALUES ($1, 'action_failed', $2)`,
            [lockdownId, JSON.stringify({ action: "container.stop", target: containerName, blocked: "blast_radius", blast_radius: br })]
          );
          actions.containerStop = { ok: false, blast_radius: true, affected: br.affected };
        } else {
          try {
            await getDocker().getContainer(containerName).stop({ t: 10 });
            await db.query(
              `INSERT INTO lockdown_events (lockdown_id, event_type, detail) VALUES ($1, 'action_taken', $2)`,
              [lockdownId, JSON.stringify({ action: "container.stop", target: containerName })]
            );
            actions.containerStop = { ok: true };
          } catch (err) {
            await db.query(
              `INSERT INTO lockdown_events (lockdown_id, event_type, detail) VALUES ($1, 'action_failed', $2)`,
              [lockdownId, JSON.stringify({ action: "container.stop", target: containerName, error: err.message })]
            );
            actions.containerStop = { ok: false, error: err.message };
          }
        }
      }
    }
  }

  return actions;
}

// Reverses whatever applyTierActions did over the life of the whole episode
// (not just the final tier) — called from /clear, before the episode is
// marked cleared.
async function revertTierActions({ lockdownId }) {
  const db = getPool();

  const { rows: multEvents } = await db.query(
    `SELECT detail FROM lockdown_events
     WHERE lockdown_id = $1 AND event_type = 'action_taken' AND detail->>'action' = 'cooldown_multiplier'
     ORDER BY created_at DESC LIMIT 1`,
    [lockdownId]
  );
  if (multEvents[0]) {
    const { originals } = multEvents[0].detail;
    for (const o of originals) {
      await db.query(`UPDATE action_policies SET cooldown_secs = $1 WHERE action_type = $2`, [o.cooldown_secs, o.action_type]);
    }
  }

  // Only turn maintenance mode back off if it's still the one this feature
  // auto-enabled (marker check) — an operator may have separately re-enabled
  // or extended it for unrelated reasons, and this must not clobber that.
  const state = getMaintenanceState();
  if (state?.enabled && typeof state.reason === "string" && state.reason.startsWith(LOCKDOWN_MAINTENANCE_MARKER)) {
    await disableMaintenanceMode();
  }
}

// Shared core for both the manual /escalate route and the Wazuh webhook —
// the only difference between a human clicking "escalate" and Wazuh's
// active-response calling in is trigger_source/trigger_ref and who counts as
// "actor"; the state machine and tier actions are identical either way.
async function performEscalation({ tenantId, tier, reason, actor, triggerSource, triggerRef, targetIp, targetScope, durationSecs, containerName, serviceId }) {
  const db = getPool();

  const { rows: active } = await db.query(
    `SELECT id, tier FROM lockdown_state WHERE tenant_id = $1 AND cleared_at IS NULL LIMIT 1`,
    [tenantId]
  );
  const current = active[0];

  if (current && tierIndex(tier) <= tierIndex(current.tier)) {
    return { ok: false, status: 409, error: `Already at '${current.tier}', which is at or above '${tier}'. Use /clear to de-escalate first.` };
  }

  const fromTier = current ? current.tier : "none";
  let lockdownId;

  if (current) {
    await db.query(`UPDATE lockdown_state SET tier = $1 WHERE id = $2`, [tier, current.id]);
    lockdownId = current.id;
  } else {
    const { rows: created } = await db.query(
      `INSERT INTO lockdown_state (tenant_id, tier, activated_by, trigger_source, trigger_ref, reason)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
      [tenantId, tier, actor, triggerSource, triggerRef || null, reason]
    );
    lockdownId = created[0].id;
  }

  await db.query(
    `INSERT INTO lockdown_events (lockdown_id, event_type, detail) VALUES ($1, 'tier_change', $2)`,
    [lockdownId, JSON.stringify({ from: fromTier, to: tier, reason, trigger_source: triggerSource, trigger_ref: triggerRef || null, actor })]
  );

  const actions = await applyTierActions({ tenantId, lockdownId, tier, reason, targetIp, targetScope, durationSecs, containerName, serviceId });

  return { ok: true, status: current ? 200 : 201, tier, lockdownId, fromTier, actions };
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

// POST /api/lockdown/escalate — { tier, reason, target_ip?, target_scope?, duration_secs? }
// Manual-only in this step — trigger_source is always "manual" until the
// Wazuh webhook (step 4) lands. Hard tier optionally applies a real CrowdSec
// range-ban (step 3) when target_ip is given; Soft's maintenance-mode
// auto-enable and Full's fleet-stop reuse are not wired yet.
lockdownRouter.post("/escalate", requireRole("operator"), async (req, res) => {
  const { tier, reason, target_ip, target_scope, duration_secs, container_name, service_id } = req.body || {};

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

  const tenantId = req.session.user.tenant_id;
  const actor = req.session?.user?.username || "unknown";

  try {
    const result = await performEscalation({
      tenantId, tier, reason, actor, triggerSource: "manual", triggerRef: null,
      targetIp: target_ip, targetScope: target_scope, durationSecs: duration_secs,
      containerName: container_name, serviceId: service_id,
    });

    if (!result.ok) return res.status(result.status).json({ ok: false, error: result.error });

    recordAudit(req, "lockdown.escalate", tier, "success", { from: result.fromTier, to: tier, reason });
    if (result.actions.ban) {
      recordAudit(req, "lockdown.crowdsec_ban", target_ip, result.actions.ban.ok ? "success" : "failure", result.actions.ban);
    }

    res.status(result.status).json({
      ok: true, tier, lockdown_id: result.lockdownId, from: result.fromTier,
      actions: result.actions, ban: result.actions.ban || null,
    });
  } catch (err) {
    recordAudit(req, "lockdown.escalate", tier, "failure", { error: err.message });
    res.status(500).json({ ok: false, error: err.message });
  }
});

// POST /api/lockdown/webhook/wazuh — Wazuh's active-response calls this
// directly (see the ossec.conf block + active-response/bin script on
// sn-security). Bearer-token auth against agent_tokens, same pattern as
// discovery.js's /ingest -- there is no human session to authenticate
// against here. Auto-escalates based on the alert's rule level; Full tier is
// structurally unreachable from this path (tierFromLevel below never
// produces it), matching the design's "no automatic trigger" decision.
function tierFromLevel(level) {
  if (level >= HARD_LEVEL) return "hard";
  if (level >= SOFT_LEVEL) return "soft";
  if (level >= ALERT_LEVEL) return "alert";
  return null;
}

lockdownRouter.post("/webhook/wazuh", async (req, res) => {
  const authHeader = req.headers.authorization || "";
  const rawToken = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : null;
  if (!rawToken) return res.status(401).json({ ok: false, error: "Unauthorized" });

  try {
    const db = getPool();
    const hash = hashToken(rawToken);
    const { rows: tokenRows } = await db.query(
      `SELECT id, tenant_id FROM agent_tokens
       WHERE token_hash = $1 AND revoked = FALSE AND (expires_at IS NULL OR expires_at > NOW())`,
      [hash]
    );
    if (!tokenRows.length) return res.status(401).json({ ok: false, error: "Unauthorized" });
    const tenantId = tokenRows[0].tenant_id;
    await db.query("UPDATE agent_tokens SET last_used_at = NOW() WHERE id = $1", [tokenRows[0].id]);

    const alert = req.body?.alert || req.body || {};
    const ruleLevel = Number(alert?.rule?.level);
    const ruleId = alert?.rule?.id;
    const ruleDesc = alert?.rule?.description;
    const srcIp = alert?.data?.srcip || alert?.srcip || null;
    const agentName = alert?.agent?.name || null;

    const tier = Number.isFinite(ruleLevel) ? tierFromLevel(ruleLevel) : null;
    if (!tier) {
      return res.json({ ok: true, escalated: false, reason: "below ALERT_LEVEL threshold", ruleLevel: Number.isFinite(ruleLevel) ? ruleLevel : null });
    }

    const reason = `Wazuh rule ${ruleId ?? "?"} (level ${ruleLevel})${agentName ? ` on ${agentName}` : ""}: ${ruleDesc || "no description"}`;

    const result = await performEscalation({
      tenantId, tier, reason, actor: "wazuh",
      triggerSource: "wazuh", triggerRef: ruleId != null ? String(ruleId) : null,
      targetIp: tier === "hard" ? srcIp : null,
    });

    if (!result.ok) {
      // Already at or above this tier -- not an error, just nothing new to do.
      return res.json({ ok: true, escalated: false, reason: result.error });
    }

    res.json({ ok: true, escalated: true, tier, lockdown_id: result.lockdownId, from: result.fromTier, actions: result.actions });
  } catch (err) {
    console.error("[lockdown] wazuh webhook error:", err.message);
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

    await revertTierActions({ lockdownId: current.id });

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
