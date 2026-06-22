import { Router } from "express";
import { getPool } from "../db.js";
import { requireRole } from "../middleware/requireRole.js";

export const activityRouter = Router();

// GET /api/activity
// Query params:
//   limit        — max events to return (default 50, max 200)
//   offset       — pagination offset (default 0)
//   since_id     — only return events with id > since_id (live polling cursor)
//   action_prefix — e.g. "container" matches "container.%"
//   username     — ILIKE partial match
//   outcome      — "success" | "failure"
//   from_ts      — ISO lower bound
//   to_ts        — ISO upper bound
//
// Returns: { ok: true, events: [...], total: N, maxId: N }
activityRouter.get("/", requireRole("operator"), async (req, res) => {
  try {
    const limit  = Math.min(parseInt(req.query.limit)  || 50, 200);
    const offset = Math.max(parseInt(req.query.offset) || 0,   0);

    const conditions = [];
    const params     = [];

    if (req.query.since_id) {
      params.push(BigInt(req.query.since_id));
      conditions.push(`id > $${params.length}`);
    }
    if (req.query.username) {
      params.push(`%${req.query.username}%`);
      conditions.push(`username ILIKE $${params.length}`);
    }
    if (req.query.action_prefix) {
      params.push(`${req.query.action_prefix}.%`);
      conditions.push(`action LIKE $${params.length}`);
    }
    if (req.query.outcome) {
      params.push(req.query.outcome);
      conditions.push(`outcome = $${params.length}`);
    }
    if (req.query.from_ts) {
      params.push(new Date(req.query.from_ts));
      conditions.push(`ts >= $${params.length}`);
    }
    if (req.query.to_ts) {
      params.push(new Date(req.query.to_ts));
      conditions.push(`ts <= $${params.length}`);
    }

    const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";

    // Count total matching (without pagination) — skip when using since_id (polling)
    let total = null;
    if (!req.query.since_id) {
      const { rows: countRows } = await getPool().query(
        `SELECT COUNT(*)::int AS n FROM audit_log ${where}`,
        params
      );
      total = countRows[0].n;
    }

    // Fetch events — newest first for initial load, oldest-first for since_id polling
    const orderDir = req.query.since_id ? "ASC" : "DESC";
    const pageParams = [...params, limit, offset];

    const { rows: events } = await getPool().query(
      `SELECT id, ts, username, role, action, target, outcome, detail, ip
       FROM audit_log ${where}
       ORDER BY ts ${orderDir}, id ${orderDir}
       LIMIT $${pageParams.length - 1} OFFSET $${pageParams.length}`,
      pageParams
    );

    const maxId = events.length
      ? events.reduce((m, e) => (BigInt(e.id) > m ? BigInt(e.id) : m), 0n).toString()
      : (req.query.since_id || "0");

    res.json({ ok: true, events, total, maxId });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});
