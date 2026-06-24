import { Router } from "express";
import { getPool, HOT_TENANT_ID } from "../db.js";
import { requireRole } from "../middleware/requireRole.js";
import { recordAudit } from "../auditLog.js";
import { recordChange } from "./governance.js";

export const recoveryRouter = Router();

// ── RTO estimate (minutes) by backup type ────────────────────────────────────
const RTO_BY_TYPE = { vm_snapshot: 30, full: 90, data_export: 240, incremental: 60, config: 15, manual: 480 };

function estimateRTO(backups) {
  if (!backups?.length) return null;
  const preferred = backups.find(b => ["lkg", "trusted"].includes(b.trust_state)) || backups[0];
  return RTO_BY_TYPE[preferred.backup_type] ?? 120;
}

// ── Confidence score v3 — 8 signals, 100 pts total ──────────────────────────
function computeConfidence(svc, backups = [], restoreTests = [], depCount = 0) {
  const signals = [];
  let score = 0;

  function sig(key, label, pts, earned, pass, detail) {
    signals.push({ key, label, points: pts, earned, pass, detail });
    score += earned;
  }

  // 1. Backup exists (20 pts)
  const hasBackup = backups.length > 0;
  sig("backup_exists", "Backup exists", 20, hasBackup ? 20 : 0, hasBackup,
    hasBackup ? `${backups.length} record${backups.length > 1 ? "s" : ""}` : "No backup records");

  // 2. Backup recency (20 pts)
  const latest = backups[0] ?? null;
  let recPts = 0, recDetail = "No backup";
  if (latest) {
    const ageDays = (Date.now() - new Date(latest.taken_at).getTime()) / 86_400_000;
    if      (ageDays < 1)  { recPts = 20; recDetail = `${Math.round(ageDays * 24)}h old`; }
    else if (ageDays < 3)  { recPts = 15; recDetail = `${Math.round(ageDays)}d old`; }
    else if (ageDays < 7)  { recPts = 10; recDetail = `${Math.round(ageDays)}d old`; }
    else if (ageDays < 30) { recPts = 5;  recDetail = `${Math.round(ageDays)}d old`; }
    else                   { recPts = 0;  recDetail = `${Math.round(ageDays)}d old — stale`; }
  }
  sig("backup_recency", "Backup recency", 20, recPts, recPts >= 10, recDetail);

  // 3. Backup trust (15 pts)
  const lkg     = backups.find(b => b.trust_state === "lkg");
  const trusted = backups.find(b => b.trust_state === "trusted");
  const trustPts = lkg ? 15 : trusted ? 10 : 0;
  sig("backup_trusted", "Backup trust", 15, trustPts, trustPts > 0,
    lkg ? "Last Known Good present" : trusted ? "Trusted backup present" : "No trusted backup");

  // 4. Restore validated (15 pts)
  const latestTest = restoreTests[0] ?? null;
  let testPts = 0, testDetail = "Never validated";
  if (latestTest?.outcome === "passed") {
    const ageDays = (Date.now() - new Date(latestTest.tested_at).getTime()) / 86_400_000;
    if      (ageDays < 90)  { testPts = 15; testDetail = `Passed ${Math.round(ageDays)}d ago`; }
    else if (ageDays < 180) { testPts = 5;  testDetail = `Passed ${Math.round(ageDays)}d ago (stale)`; }
    else                    { testPts = 0;  testDetail = `Last pass ${Math.round(ageDays)}d ago (expired)`; }
  } else if (latestTest) {
    testDetail = `Last test: ${latestTest.outcome}`;
  }
  sig("restore_validated", "Restore validated", 15, testPts, testPts >= 15, testDetail);

  // 5. Recovery runbook (10 pts)
  const hasRunbook = !!svc.recovery_runbook_url;
  sig("runbook_present", "Recovery runbook", 10, hasRunbook ? 10 : 0, hasRunbook,
    hasRunbook ? "Runbook URL configured" : "No runbook URL");

  // 6. Dependencies mapped (10 pts)
  const isLeaf  = ["external", "api"].includes(svc.runtime_type);
  const depPts  = depCount > 0 || isLeaf ? 10 : 0;
  sig("dependencies_mapped", "Dependencies mapped", 10, depPts, depPts > 0,
    depCount > 0 ? `${depCount} edge${depCount > 1 ? "s" : ""} mapped`
    : isLeaf ? "Leaf service — no deps expected" : "No dependency edges mapped");

  // 7. Health check (5 pts)
  sig("health_check", "Health check", 5, svc.health_endpoint ? 5 : 0, !!svc.health_endpoint,
    svc.health_endpoint ? "Configured" : "Not configured");

  // 8. Owner assigned (5 pts)
  const ownerOk = !!(svc.owner || "").trim() &&
    !["unknown","unassigned","tbd","n/a","none"].includes((svc.owner || "").toLowerCase().trim());
  sig("owner_assigned", "Owner assigned", 5, ownerOk ? 5 : 0, ownerOk,
    ownerOk ? svc.owner : `Owner is '${svc.owner || "unset"}'`);

  const tier   = score >= 85 ? "recoverable" : score >= 60 ? "at_risk" : score >= 30 ? "unproven" : "blocked";
  const rtoMin = estimateRTO(backups);
  const dlwMin = latest ? Math.round((Date.now() - new Date(latest.taken_at).getTime()) / 60_000) : null;

  const blockers = [];
  if (!hasBackup)                blockers.push("No backup records — restore source unknown");
  if (hasBackup && trustPts === 0) blockers.push("No trusted or LKG backup — integrity unverified");
  if (testPts === 0)             blockers.push("Restore never validated — recovery path unproven");
  if (!hasRunbook && ["admin","infra","ops","business"].includes(svc.category))
    blockers.push("No recovery runbook — operator must improvise during an incident");
  if (depPts === 0)              blockers.push("Dependencies unmapped — restore order unknown");

  return { score, tier, signals, blockers, rto_min: rtoMin, data_loss_window_min: dlwMin };
}

// ── Bulk data loader ─────────────────────────────────────────────────────────
async function loadServiceData(pool, tenantId, serviceIds) {
  if (!serviceIds.length) return { backupsByService: {}, testsByService: {}, depCountByService: {} };

  const [{ rows: backups }, { rows: tests }, { rows: depRows }] = await Promise.all([
    pool.query(
      `SELECT service_id, id, trust_state, backup_type, taken_at FROM service_backups
       WHERE tenant_id = $1 AND service_id = ANY($2) ORDER BY service_id, taken_at DESC`,
      [tenantId, serviceIds]
    ),
    pool.query(
      `SELECT service_id, outcome, test_type, tested_at, rto_actual_min FROM restore_tests
       WHERE tenant_id = $1 AND service_id = ANY($2) ORDER BY service_id, tested_at DESC`,
      [tenantId, serviceIds]
    ),
    pool.query(
      `SELECT service_id, SUM(cnt)::int AS dep_count FROM (
         SELECT upstream_id   AS service_id, COUNT(*) AS cnt FROM service_dependencies
           WHERE tenant_id = $1 AND upstream_id   = ANY($2) GROUP BY upstream_id
         UNION ALL
         SELECT downstream_id AS service_id, COUNT(*) AS cnt FROM service_dependencies
           WHERE tenant_id = $1 AND downstream_id = ANY($2) GROUP BY downstream_id
       ) t GROUP BY service_id`,
      [tenantId, serviceIds]
    ),
  ]);

  const r = { backupsByService: {}, testsByService: {}, depCountByService: {} };
  for (const id of serviceIds) {
    r.backupsByService[id]  = [];
    r.testsByService[id]    = [];
    r.depCountByService[id] = 0;
  }
  for (const b of backups) r.backupsByService[b.service_id]?.push(b);
  for (const t of tests)   r.testsByService[t.service_id]?.push(t);
  for (const d of depRows) r.depCountByService[d.service_id] = d.dep_count;
  return r;
}

// ── Restore chain BFS (upstream deps, ordered deepest-first) ────────────────
async function buildRestoreChain(pool, tenantId, seedIds) {
  const seenIds     = new Set(seedIds);
  const extraSteps  = new Map();
  const queue       = seedIds.map(id => ({ id, order: 0 }));

  while (queue.length) {
    const cur = queue.shift();
    const { rows: ups } = await pool.query(
      `SELECT sd.upstream_id AS id, sd.dep_type,
              s.name, s.slug, s.category, s.backup_policy, s.status,
              s.recovery_runbook_url, s.health_endpoint, s.owner, s.runtime_type
       FROM service_dependencies sd JOIN services s ON s.id = sd.upstream_id
       WHERE sd.downstream_id = $1 AND sd.tenant_id = $2`,
      [cur.id, tenantId]
    );
    for (const u of ups) {
      if (!seenIds.has(u.id)) {
        seenIds.add(u.id);
        extraSteps.set(u.id, { ...u, restore_order: cur.order + 1, is_target: false });
        queue.push({ id: u.id, order: cur.order + 1 });
      }
    }
  }
  return { seenIds, extraSteps };
}

// ── GET /api/recovery/readiness ──────────────────────────────────────────────
recoveryRouter.get("/readiness", requireRole("viewer"), async (_req, res) => {
  try {
    const pool = getPool();
    const { rows: services } = await pool.query(
      `SELECT s.*, w.name AS workspace_name FROM services s
       LEFT JOIN workspaces w ON w.id = s.workspace_id
       WHERE s.tenant_id = $1 AND s.archived = FALSE ORDER BY s.category, s.name`,
      [HOT_TENANT_ID]
    );
    if (!services.length) {
      return res.json({ ok: true, services: [], summary: { recoverable: 0, at_risk: 0, unproven: 0, blocked: 0, total: 0, avg_score: 0 } });
    }

    const ids = services.map(s => s.id);
    const { backupsByService, testsByService, depCountByService } = await loadServiceData(pool, HOT_TENANT_ID, ids);

    const rows = services.map(svc => {
      const conf = computeConfidence(svc, backupsByService[svc.id], testsByService[svc.id], depCountByService[svc.id]);
      return {
        id: svc.id, name: svc.name, slug: svc.slug, category: svc.category,
        workspace_name: svc.workspace_name, status: svc.status,
        backup_policy: svc.backup_policy, recovery_runbook_url: svc.recovery_runbook_url,
        owner: svc.owner, health_endpoint: svc.health_endpoint,
        ...conf,
      };
    });

    const counts = { recoverable: 0, at_risk: 0, unproven: 0, blocked: 0 };
    for (const r of rows) counts[r.tier]++;
    const avg_score = Math.round(rows.reduce((s, r) => s + r.score, 0) / rows.length);

    res.json({ ok: true, services: rows, summary: { ...counts, total: rows.length, avg_score } });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ── GET /api/recovery/confidence/:id ────────────────────────────────────────
recoveryRouter.get("/confidence/:id", requireRole("viewer"), async (req, res) => {
  try {
    const pool = getPool();
    const { rows: [svc] } = await pool.query(
      `SELECT s.*, w.name AS workspace_name FROM services s LEFT JOIN workspaces w ON w.id = s.workspace_id
       WHERE s.id = $1 AND s.tenant_id = $2`,
      [req.params.id, HOT_TENANT_ID]
    );
    if (!svc) return res.status(404).json({ ok: false, error: "Service not found" });
    const { backupsByService, testsByService, depCountByService } = await loadServiceData(pool, HOT_TENANT_ID, [svc.id]);
    const conf = computeConfidence(svc, backupsByService[svc.id], testsByService[svc.id], depCountByService[svc.id]);
    res.json({ ok: true, service: { id: svc.id, name: svc.name, slug: svc.slug }, ...conf });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ── GET /api/recovery/gaps ───────────────────────────────────────────────────
recoveryRouter.get("/gaps", requireRole("viewer"), async (_req, res) => {
  try {
    const pool = getPool();
    const { rows: services } = await pool.query(
      `SELECT s.*, w.name AS workspace_name FROM services s LEFT JOIN workspaces w ON w.id = s.workspace_id
       WHERE s.tenant_id = $1 AND s.archived = FALSE ORDER BY s.name`,
      [HOT_TENANT_ID]
    );
    if (!services.length) return res.json({ ok: true, gaps: [], total: 0 });

    const { backupsByService, testsByService, depCountByService } = await loadServiceData(pool, HOT_TENANT_ID, services.map(s => s.id));

    const gaps = [];
    for (const svc of services) {
      const conf = computeConfidence(svc, backupsByService[svc.id], testsByService[svc.id], depCountByService[svc.id]);
      if (conf.tier === "recoverable") continue;

      const remediation = [];
      for (const sig of conf.signals) {
        if (sig.pass) continue;
        if (sig.key === "backup_exists")        remediation.push({ priority: "critical", action: "Register at least one backup record in the Inventory board" });
        if (sig.key === "backup_recency")       remediation.push({ priority: "high",     action: `Backup is stale — verify policy '${svc.backup_policy}' is running` });
        if (sig.key === "backup_trusted")       remediation.push({ priority: "high",     action: "Mark a backup as Trusted or Last Known Good in Inventory → Backup Records" });
        if (sig.key === "restore_validated")    remediation.push({ priority: "high",     action: "Record a restore validation test (dry-run or partial restore) in Recovery → Restore Tests" });
        if (sig.key === "runbook_present")      remediation.push({ priority: "medium",   action: "Add a recovery runbook URL to this service via Inventory → Edit Service" });
        if (sig.key === "dependencies_mapped")  remediation.push({ priority: "medium",   action: "Map this service's dependencies in the Dependencies board" });
        if (sig.key === "health_check")         remediation.push({ priority: "low",      action: "Add a health endpoint to this service via Inventory → Edit Service" });
        if (sig.key === "owner_assigned")       remediation.push({ priority: "low",      action: "Assign an owner to this service via Inventory → Edit Service" });
      }
      gaps.push({
        id: svc.id, name: svc.name, slug: svc.slug, category: svc.category,
        workspace_name: svc.workspace_name, score: conf.score, tier: conf.tier,
        blockers: conf.blockers, remediation,
      });
    }

    const tierOrder = { blocked: 0, unproven: 1, at_risk: 2 };
    gaps.sort((a, b) => (tierOrder[a.tier] ?? 3) - (tierOrder[b.tier] ?? 3) || a.score - b.score);

    res.json({ ok: true, gaps, total: gaps.length });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ── POST /api/recovery/simulate ──────────────────────────────────────────────
recoveryRouter.post("/simulate", requireRole("operator"), async (req, res) => {
  const { scenario_type, target_id, target_type = "service" } = req.body;
  if (!scenario_type || !target_id)
    return res.status(400).json({ ok: false, error: "scenario_type and target_id required" });
  const VALID_SCENARIOS = ["full_loss", "partial", "data_corruption", "network_failure"];
  if (!VALID_SCENARIOS.includes(scenario_type))
    return res.status(400).json({ ok: false, error: `scenario_type must be one of: ${VALID_SCENARIOS.join(", ")}` });

  try {
    const pool = getPool();
    let targetServices = [];

    if (target_type === "service") {
      const { rows: [svc] } = await pool.query(
        "SELECT * FROM services WHERE id = $1 AND tenant_id = $2 AND archived = FALSE",
        [target_id, HOT_TENANT_ID]
      );
      if (!svc) return res.status(404).json({ ok: false, error: "Service not found" });
      targetServices = [svc];
    } else if (target_type === "workspace") {
      const { rows } = await pool.query(
        "SELECT * FROM services WHERE workspace_id = $1 AND tenant_id = $2 AND archived = FALSE ORDER BY name",
        [target_id, HOT_TENANT_ID]
      );
      if (!rows.length) return res.status(404).json({ ok: false, error: "No active services in workspace" });
      targetServices = rows;
    } else {
      return res.status(400).json({ ok: false, error: "target_type must be 'service' or 'workspace'" });
    }

    // Build restore chain from all target services upwards
    const seedIds = targetServices.map(s => s.id);
    const { seenIds, extraSteps } = await buildRestoreChain(pool, HOT_TENANT_ID, seedIds);

    const allIds = [...seenIds];
    const { backupsByService, testsByService, depCountByService } = await loadServiceData(pool, HOT_TENANT_ID, allIds);

    // Build combined service map: targets at order 0, deps at order > 0
    const allSvcs = new Map();
    for (const svc of targetServices) allSvcs.set(svc.id, { ...svc, restore_order: 0, is_target: true });
    for (const [id, svc] of extraSteps) allSvcs.set(id, svc);

    // Sort deepest dependency first, target last
    const plan = [...allSvcs.values()]
      .sort((a, b) => b.restore_order - a.restore_order)
      .map((svc, idx) => {
        const backups  = backupsByService[svc.id] || [];
        const tests    = testsByService[svc.id]   || [];
        const conf     = computeConfidence(svc, backups, tests, depCountByService[svc.id] || 0);
        return {
          step:          idx + 1,
          service_id:    svc.id,
          service_name:  svc.name,
          category:      svc.category,
          is_target:     svc.is_target ?? false,
          restore_order: svc.restore_order,
          tier:          conf.tier,
          score:         conf.score,
          rto_min:       conf.rto_min,
          data_loss_window_min: conf.data_loss_window_min,
          blockers:      conf.blockers,
          latest_backup: backups[0]
            ? { taken_at: backups[0].taken_at, trust_state: backups[0].trust_state, backup_type: backups[0].backup_type }
            : null,
          runbook_url:   svc.recovery_runbook_url || null,
          health_check:  svc.health_endpoint      || null,
          last_test:     tests[0] ? { outcome: tests[0].outcome, tested_at: tests[0].tested_at } : null,
        };
      });

    const allBlockers  = plan.flatMap(s => s.blockers.map(b => ({ service: s.service_name, blocker: b })));
    const totalRTO     = plan.reduce((sum, s) => sum + (s.rto_min ?? 0), 0);
    const worstDLW     = plan.reduce((max, s) => s.data_loss_window_min != null ? Math.max(max, s.data_loss_window_min) : max, 0);
    const canRecover   = allBlockers.length === 0;
    const overallTier  = !canRecover ? "blocked" : totalRTO < 120 ? "recoverable" : "at_risk";

    const result = {
      scenario_type,
      target_type,
      target_id,
      target_names: targetServices.map(s => s.name),
      plan,
      summary: {
        steps:               plan.length,
        total_rto_min:       totalRTO,
        worst_data_loss_min: worstDLW || null,
        blockers_count:      allBlockers.length,
        can_recover:         canRecover,
        overall_tier:        overallTier,
      },
      blockers: allBlockers,
    };

    // Persist simulation
    const actor = req.session?.user?.username || "operator";
    const { rows: [simRow] } = await pool.query(
      `INSERT INTO recovery_simulations (tenant_id, scenario_type, target_type, target_id, target_name, run_by, result)
       VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
      [HOT_TENANT_ID, scenario_type, target_type, target_id,
       targetServices.map(s => s.name).join(", "), actor, JSON.stringify(result)]
    );
    recordAudit(req, "recovery.simulate", `${scenario_type}:${target_id}`, "success");

    res.json({ ok: true, simulation_id: simRow.id, ...result });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ── POST /api/recovery/playbook ──────────────────────────────────────────────
recoveryRouter.post("/playbook", requireRole("viewer"), async (req, res) => {
  const { service_id, incident_summary } = req.body;
  if (!service_id) return res.status(400).json({ ok: false, error: "service_id required" });

  try {
    const pool = getPool();
    const { rows: [svc] } = await pool.query(
      "SELECT * FROM services WHERE id = $1 AND tenant_id = $2 AND archived = FALSE",
      [service_id, HOT_TENANT_ID]
    );
    if (!svc) return res.status(404).json({ ok: false, error: "Service not found" });

    const { seenIds, extraSteps } = await buildRestoreChain(pool, HOT_TENANT_ID, [svc.id]);
    const allIds = [...seenIds];
    const { backupsByService, testsByService } = await loadServiceData(pool, HOT_TENANT_ID, allIds);

    const allSvcs = new Map([[svc.id, { ...svc, restore_order: 0, is_target: true }]]);
    for (const [id, s] of extraSteps) allSvcs.set(id, s);

    const ordered = [...allSvcs.values()].sort((a, b) => b.restore_order - a.restore_order);

    const sections = ordered.map((s, idx) => {
      const backups  = backupsByService[s.id] || [];
      const tests    = testsByService[s.id]   || [];
      const latest   = backups[0];
      const bestBk   = backups.find(b => b.trust_state === "lkg") ||
                       backups.find(b => b.trust_state === "trusted") ||
                       latest;
      const rto      = estimateRTO(backups);

      const instructions = [];
      instructions.push(`Verify ${s.name} is down or unreachable`);
      if (bestBk) {
        const label = bestBk.trust_state === "lkg" ? "Last Known Good" : bestBk.trust_state === "trusted" ? "Trusted" : "latest";
        instructions.push(`Locate ${label} backup from ${new Date(bestBk.taken_at).toISOString().slice(0, 10)} (type: ${bestBk.backup_type})`);
        instructions.push("Restore from identified backup — follow your platform restore procedure");
      } else {
        instructions.push("⚠ No backup records found — identify restore source manually before proceeding");
      }
      if (s.recovery_runbook_url)  instructions.push(`Follow runbook: ${s.recovery_runbook_url}`);
      if (s.health_endpoint)       instructions.push(`Confirm healthy: ${s.health_endpoint}`);
      else                         instructions.push("Confirm service healthy (no health endpoint — check manually)");
      if (tests[0]) {
        const ageDays = Math.round((Date.now() - new Date(tests[0].tested_at).getTime()) / 86_400_000);
        instructions.push(`Restore test note: last test was ${tests[0].outcome} (${ageDays}d ago)`);
      }

      return {
        step:         idx + 1,
        service_id:   s.id,
        service_name: s.name,
        category:     s.category,
        is_target:    s.is_target ?? false,
        rto_min:      rto,
        backup_source: bestBk
          ? `${bestBk.backup_type} · ${new Date(bestBk.taken_at).toLocaleDateString()} · ${bestBk.trust_state}`
          : null,
        runbook_url:    s.recovery_runbook_url || null,
        warnings:       !bestBk ? ["No backup records — restore source unknown"] : [],
        instructions,
      };
    });

    const totalRTO   = sections.reduce((sum, s) => sum + (s.rto_min ?? 0), 0);
    const allBlockers = sections.filter(s => s.warnings.length).flatMap(s => s.warnings.map(w => `${s.service_name}: ${w}`));

    res.json({
      ok: true,
      playbook: {
        title:          `Recovery Playbook — ${svc.name}`,
        generated_at:   new Date().toISOString(),
        incident_summary: incident_summary || `${svc.name} is unavailable`,
        target_service: { id: svc.id, name: svc.name, category: svc.category },
        sections,
        summary: {
          total_steps:          sections.length,
          estimated_rto_min:    totalRTO,
          blockers_count:       allBlockers.length,
          blockers:             allBlockers,
          dependencies_in_scope: sections.filter(s => !s.is_target).length,
        },
      },
    });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ── Simulation history ───────────────────────────────────────────────────────
recoveryRouter.get("/simulations", requireRole("viewer"), async (_req, res) => {
  try {
    const { rows } = await getPool().query(
      `SELECT id, scenario_type, target_type, target_name, run_by,
              result->'summary' AS summary, created_at
       FROM recovery_simulations WHERE tenant_id = $1 ORDER BY created_at DESC LIMIT 50`,
      [HOT_TENANT_ID]
    );
    res.json({ ok: true, simulations: rows });
  } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});

recoveryRouter.get("/simulations/:id", requireRole("viewer"), async (req, res) => {
  try {
    const { rows: [sim] } = await getPool().query(
      "SELECT * FROM recovery_simulations WHERE id = $1 AND tenant_id = $2",
      [req.params.id, HOT_TENANT_ID]
    );
    if (!sim) return res.status(404).json({ ok: false, error: "Not found" });
    res.json({ ok: true, simulation: { ...sim, result: sim.result } });
  } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});

recoveryRouter.delete("/simulations/:id", requireRole("admin"), async (req, res) => {
  try {
    const { rows: [row] } = await getPool().query(
      "DELETE FROM recovery_simulations WHERE id = $1 AND tenant_id = $2 RETURNING id",
      [req.params.id, HOT_TENANT_ID]
    );
    if (!row) return res.status(404).json({ ok: false, error: "Not found" });
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});

// ── Restore tests ────────────────────────────────────────────────────────────
recoveryRouter.get("/restore-tests", requireRole("viewer"), async (req, res) => {
  try {
    const params = [HOT_TENANT_ID];
    let where = "rt.tenant_id = $1";
    if (req.query.service_id) { params.push(req.query.service_id); where += ` AND rt.service_id = $${params.length}`; }
    const { rows } = await getPool().query(
      `SELECT rt.*, s.name AS service_name, s.slug AS service_slug
       FROM restore_tests rt LEFT JOIN services s ON s.id = rt.service_id
       WHERE ${where} ORDER BY rt.tested_at DESC LIMIT 100`,
      params
    );
    res.json({ ok: true, tests: rows });
  } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});

recoveryRouter.post("/restore-tests", requireRole("operator"), async (req, res) => {
  const { service_id, backup_id, test_type = "dry_run", outcome = "passed", rto_actual_min, notes } = req.body;
  if (!service_id) return res.status(400).json({ ok: false, error: "service_id required" });
  const VALID_TEST_TYPES = ["dry_run", "partial", "full", "tabletop"];
  const VALID_OUTCOMES   = ["passed", "failed", "partial"];
  if (!VALID_TEST_TYPES.includes(test_type))
    return res.status(400).json({ ok: false, error: `test_type must be one of: ${VALID_TEST_TYPES.join(", ")}` });
  if (!VALID_OUTCOMES.includes(outcome))
    return res.status(400).json({ ok: false, error: `outcome must be one of: ${VALID_OUTCOMES.join(", ")}` });
  try {
    const pool  = getPool();
    const { rows: [svc] } = await pool.query(
      "SELECT id, name FROM services WHERE id = $1 AND tenant_id = $2", [service_id, HOT_TENANT_ID]
    );
    if (!svc) return res.status(404).json({ ok: false, error: "Service not found" });
    const actor = req.session?.user?.username || "operator";
    const { rows: [row] } = await pool.query(
      `INSERT INTO restore_tests (tenant_id, service_id, backup_id, tested_by, test_type, outcome, rto_actual_min, notes)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *`,
      [HOT_TENANT_ID, service_id, backup_id || null, actor, test_type, outcome, rto_actual_min ?? null, notes ?? null]
    );
    recordChange(HOT_TENANT_ID, service_id, svc.name, "restore_tested", actor,
      `Restore test recorded (${test_type}): ${outcome}`, { test_type, outcome, rto_actual_min });
    recordAudit(req, "recovery.restore_test.create", svc.name, "success");
    res.json({ ok: true, test: row });
  } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});

recoveryRouter.delete("/restore-tests/:id", requireRole("admin"), async (req, res) => {
  try {
    const { rows: [row] } = await getPool().query(
      "DELETE FROM restore_tests WHERE id = $1 AND tenant_id = $2 RETURNING id",
      [req.params.id, HOT_TENANT_ID]
    );
    if (!row) return res.status(404).json({ ok: false, error: "Not found" });
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});
