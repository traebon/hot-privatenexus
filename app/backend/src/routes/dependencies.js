import { Router } from "express";
import { getPool, HOT_TENANT_ID } from "../db.js";
import { requireRole } from "../middleware/requireRole.js";
import { recordAudit } from "../auditLog.js";

export const dependenciesRouter = Router();

// ── Full graph ───────────────────────────────────────────────────────────────
// Returns all services as nodes + all dependency edges
dependenciesRouter.get("/graph", requireRole("viewer"), async (_req, res) => {
  try {
    const pool = getPool();
    const { rows: services } = await pool.query(
      `SELECT id, name, slug, category, status, workspace_id, runtime_type, archived
       FROM services WHERE tenant_id = $1 AND archived = FALSE
       ORDER BY name`,
      [HOT_TENANT_ID]
    );
    const { rows: edges } = await pool.query(
      `SELECT sd.id, sd.upstream_id, sd.downstream_id, sd.dep_type, sd.notes,
              u.name AS upstream_name, u.slug AS upstream_slug,
              d.name AS downstream_name, d.slug AS downstream_slug
       FROM service_dependencies sd
       JOIN services u ON u.id = sd.upstream_id
       JOIN services d ON d.id = sd.downstream_id
       WHERE sd.tenant_id = $1`,
      [HOT_TENANT_ID]
    );
    res.json({ ok: true, nodes: services, edges });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ── Blast radius ─────────────────────────────────────────────────────────────
// Given a service ID, return all services that would be affected if it went down
dependenciesRouter.get("/blast-radius/:id", requireRole("viewer"), async (req, res) => {
  try {
    const pool = getPool();
    const { id } = req.params;

    // Verify service belongs to tenant
    const { rows: svc } = await pool.query(
      "SELECT id, name, slug FROM services WHERE id = $1 AND tenant_id = $2",
      [id, HOT_TENANT_ID]
    );
    if (!svc[0]) return res.status(404).json({ ok: false, error: "Service not found" });

    // BFS: traverse downstream (services that depend on this one)
    const visited = new Set([id]);
    const queue   = [{ id, depth: 0, via: null, dep_type: null }];
    const affected = [];

    while (queue.length) {
      const current = queue.shift();
      const { rows: deps } = await pool.query(
        `SELECT sd.downstream_id AS id, sd.dep_type, sd.notes,
                s.name, s.slug, s.status, s.category
         FROM service_dependencies sd
         JOIN services s ON s.id = sd.downstream_id
         WHERE sd.upstream_id = $1 AND sd.tenant_id = $2`,
        [current.id, HOT_TENANT_ID]
      );
      for (const dep of deps) {
        if (!visited.has(dep.id)) {
          visited.add(dep.id);
          affected.push({ ...dep, depth: current.depth + 1, via: current.id });
          queue.push({ id: dep.id, depth: current.depth + 1, via: current.id, dep_type: dep.dep_type });
        }
      }
    }

    const hardCount = affected.filter(a => a.dep_type === "hard").length;
    res.json({
      ok: true,
      service: svc[0],
      affected,
      summary: { total: affected.length, hard: hardCount, soft: affected.length - hardCount },
    });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ── Restore chain ─────────────────────────────────────────────────────────────
// Given a service ID, return the ordered list of services to restore first
dependenciesRouter.get("/restore-chain/:id", requireRole("viewer"), async (req, res) => {
  try {
    const pool = getPool();
    const { id } = req.params;

    const { rows: svc } = await pool.query(
      "SELECT id, name, slug FROM services WHERE id = $1 AND tenant_id = $2",
      [id, HOT_TENANT_ID]
    );
    if (!svc[0]) return res.status(404).json({ ok: false, error: "Service not found" });

    // BFS upstream: what does this service depend on?
    const visited = new Set([id]);
    const queue   = [id];
    const nodes   = new Map(); // id → { id, name, slug, status, dep_type }
    const inEdges = new Map(); // id → Set of upstream ids it depends on

    nodes.set(id, { ...svc[0], dep_type: null });
    inEdges.set(id, new Set());

    while (queue.length) {
      const current = queue.shift();
      const { rows: deps } = await pool.query(
        `SELECT sd.upstream_id AS id, sd.dep_type,
                s.name, s.slug, s.status, s.category, s.backup_policy
         FROM service_dependencies sd
         JOIN services s ON s.id = sd.upstream_id
         WHERE sd.downstream_id = $1 AND sd.tenant_id = $2`,
        [current, HOT_TENANT_ID]
      );
      for (const dep of deps) {
        if (!nodes.has(dep.id)) {
          nodes.set(dep.id, dep);
          inEdges.set(dep.id, new Set());
          queue.push(dep.id);
        }
        inEdges.get(current)?.add(dep.id);
      }
    }

    // Kahn's topological sort (upstream first)
    const outDegree = new Map([...nodes.keys()].map(k => [k, 0]));
    for (const [, upstreams] of inEdges) {
      for (const u of upstreams) outDegree.set(u, (outDegree.get(u) || 0) + 1);
    }

    const ready  = [...nodes.keys()].filter(k => outDegree.get(k) === 0);
    const sorted = [];
    while (ready.length) {
      const n = ready.shift();
      if (n !== id) sorted.push(nodes.get(n)); // exclude the target service itself
      for (const [k, ups] of inEdges) {
        if (ups.has(n)) {
          ups.delete(n);
          if (ups.size === 0 && k !== id) outDegree.set(n, (outDegree.get(n) || 1) - 1);
          if (inEdges.get(k).size === 0) ready.push(k);
        }
      }
    }

    // Simpler: just return BFS order (upstream levels first)
    const chain = [];
    const seen  = new Set([id]);
    const bfsQ  = [{ id, depth: 0 }];
    while (bfsQ.length) {
      const cur = bfsQ.shift();
      const { rows: ups } = await pool.query(
        `SELECT sd.upstream_id AS id, sd.dep_type,
                s.name, s.slug, s.status, s.category, s.backup_policy
         FROM service_dependencies sd
         JOIN services s ON s.id = sd.upstream_id
         WHERE sd.downstream_id = $1 AND sd.tenant_id = $2`,
        [cur.id, HOT_TENANT_ID]
      );
      for (const u of ups) {
        if (!seen.has(u.id)) {
          seen.add(u.id);
          chain.push({ ...u, restore_order: cur.depth + 1 });
          bfsQ.push({ id: u.id, depth: cur.depth + 1 });
        }
      }
    }

    // Sort: deepest first (restore dependencies before dependents)
    chain.sort((a, b) => b.restore_order - a.restore_order);
    chain.push({ ...svc[0], restore_order: 0, dep_type: "target" });

    res.json({ ok: true, service: svc[0], chain });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ── List deps for a service ──────────────────────────────────────────────────
dependenciesRouter.get("/", requireRole("viewer"), async (req, res) => {
  try {
    const { service_id } = req.query;
    const pool = getPool();
    let q, params;

    if (service_id) {
      q = `SELECT sd.*, u.name AS upstream_name, u.slug AS upstream_slug,
                  u.status AS upstream_status, u.category AS upstream_category,
                  d.name AS downstream_name, d.slug AS downstream_slug,
                  d.status AS downstream_status
           FROM service_dependencies sd
           JOIN services u ON u.id = sd.upstream_id
           JOIN services d ON d.id = sd.downstream_id
           WHERE sd.tenant_id = $1 AND (sd.upstream_id = $2 OR sd.downstream_id = $2)
           ORDER BY sd.dep_type, u.name`;
      params = [HOT_TENANT_ID, service_id];
    } else {
      q = `SELECT sd.*, u.name AS upstream_name, d.name AS downstream_name
           FROM service_dependencies sd
           JOIN services u ON u.id = sd.upstream_id
           JOIN services d ON d.id = sd.downstream_id
           WHERE sd.tenant_id = $1 ORDER BY u.name, d.name`;
      params = [HOT_TENANT_ID];
    }

    const { rows } = await pool.query(q, params);
    res.json({ ok: true, dependencies: rows });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ── Create dependency ────────────────────────────────────────────────────────
dependenciesRouter.post("/", requireRole("operator"), async (req, res) => {
  const { upstream_id, downstream_id, dep_type = "hard", notes } = req.body;
  if (!upstream_id || !downstream_id)
    return res.status(400).json({ ok: false, error: "upstream_id and downstream_id required" });
  if (upstream_id === downstream_id)
    return res.status(400).json({ ok: false, error: "A service cannot depend on itself" });

  try {
    const pool = getPool();
    const { rows } = await pool.query(
      `INSERT INTO service_dependencies (tenant_id, upstream_id, downstream_id, dep_type, notes, created_by)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (tenant_id, upstream_id, downstream_id) DO UPDATE
         SET dep_type = EXCLUDED.dep_type, notes = EXCLUDED.notes
       RETURNING *`,
      [HOT_TENANT_ID, upstream_id, downstream_id, dep_type, notes ?? null,
       req.session?.user?.username || "operator"]
    );
    recordAudit(req, "dependency.create", `${upstream_id}→${downstream_id}`, "success");
    res.json({ ok: true, dependency: rows[0] });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ── Delete dependency ────────────────────────────────────────────────────────
dependenciesRouter.delete("/:id", requireRole("operator"), async (req, res) => {
  try {
    const { rows } = await getPool().query(
      "DELETE FROM service_dependencies WHERE id = $1 AND tenant_id = $2 RETURNING id",
      [req.params.id, HOT_TENANT_ID]
    );
    if (!rows[0]) return res.status(404).json({ ok: false, error: "Not found" });
    recordAudit(req, "dependency.delete", req.params.id, "success");
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});
