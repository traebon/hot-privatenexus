import net from "node:net";
import { Router } from "express";
import { getPool, HOT_TENANT_ID } from "../db.js";
import { requireRole } from "../middleware/requireRole.js";
import { recordAudit } from "../auditLog.js";
import { recordChange } from "./governance.js";
import { getDocker } from "../dockerClient.js";
import { CONTAINER_BLOCKLIST, COOLDOWN_MS, actionCooldowns } from "./actions.js";

export const intelligenceRouter = Router();

const docker = getDocker();

// ── Signal detection ─────────────────────────────────────────────────────────
function detectSignals(svc, events) {
  const signals = [];
  if (events.length < 3) return signals;

  const recent = events.slice(0, 10);
  const older  = events.slice(10, 20);

  // 1. Consecutive failures
  let consec = 0;
  for (const ev of recent) {
    if (ev.status !== "healthy") consec++; else break;
  }
  if (consec >= 3) {
    signals.push({
      type: "down_spike",
      severity: consec >= 5 ? "critical" : "warning",
      detail: `${consec} consecutive non-healthy events (latest: ${events[0].status})`,
      action_hint: svc.container_name ? "container.restart" : "health.refresh",
    });
  }

  // 2. Degradation trend
  if (consec < 3) { // skip if already caught above
    const recentH = recent.filter(e => e.status === "healthy").length / recent.length;
    const olderH  = older.length >= 5
      ? older.filter(e => e.status === "healthy").length / older.length
      : null;
    if (recentH < 0.7 && (olderH === null || recentH < olderH - 0.15)) {
      signals.push({
        type: "degrading",
        severity: recentH < 0.4 ? "critical" : "warning",
        detail: `${Math.round(recentH * 100)}% healthy (last 10 probes)${olderH !== null ? ` — was ${Math.round(olderH * 100)}%` : ""}`,
        action_hint: "health.refresh",
      });
    }
  }

  // 3. Latency spike
  const rLat = recent.filter(e => e.latency_ms != null && e.status === "healthy");
  const oLat = older.filter(e => e.latency_ms != null && e.status === "healthy");
  if (rLat.length >= 3 && oLat.length >= 3) {
    const avgR = rLat.slice(0, 5).reduce((s, e) => s + e.latency_ms, 0) / Math.min(5, rLat.length);
    const avgO = oLat.slice(0, 5).reduce((s, e) => s + e.latency_ms, 0) / Math.min(5, oLat.length);
    if (avgO > 50 && avgR > avgO * 2.5 && avgR > 500) {
      signals.push({
        type: "latency_spike",
        severity: "warning",
        detail: `Avg latency ${Math.round(avgR)}ms vs ${Math.round(avgO)}ms (${Math.round(avgR / avgO)}× increase)`,
        action_hint: "health.refresh",
      });
    }
  }

  // 4. Intermittent / flapping
  let flaps = 0;
  for (let i = 1; i < Math.min(10, recent.length); i++) {
    if ((recent[i - 1].status === "healthy") !== (recent[i].status === "healthy")) flaps++;
  }
  if (flaps >= 4 && consec < 3) {
    signals.push({
      type: "intermittent",
      severity: "warning",
      detail: `${flaps} status transitions in last ${Math.min(10, recent.length)} probes`,
      action_hint: "health.refresh",
    });
  }

  return signals;
}

// ── Single-service health probe (mirrors healthProbe.js) ────────────────────
function tcpProbe(host, port, timeoutMs = 8000) {
  return new Promise(resolve => {
    const start  = Date.now();
    const socket = new net.Socket();
    let done = false;
    const fin = (status, error = null) => {
      if (done) return; done = true; socket.destroy();
      resolve({ status, latency_ms: Date.now() - start, error });
    };
    socket.setTimeout(timeoutMs);
    socket.connect(port, host, () => fin("healthy"));
    socket.on("timeout", () => fin("down", "timeout"));
    socket.on("error",   e  => fin("down", e.message));
  });
}

async function probeService(svc) {
  const start = Date.now();
  if (!svc.health_endpoint) return { ok: false, error: "No health endpoint" };

  let status, status_code = null, error = null, latency_ms;
  if (svc.health_endpoint.startsWith("tcp://")) {
    const u = new URL(svc.health_endpoint);
    const r = await tcpProbe(u.hostname, Number(u.port));
    status = r.status; error = r.error; latency_ms = r.latency_ms;
  } else {
    // Catch fetch failures (connection refused, DNS, timeout) here specifically
    // and record them as a real "down" event, mirroring healthProbe.js's
    // scheduler. Previously this was only caught by the outer try/catch below,
    // which skipped the DB write entirely on any network failure — the exact
    // failure mode this whole signal-detection system exists to catch would
    // silently produce no health_events row and no status update at all.
    try {
      const r = await fetch(svc.health_endpoint, {
        method: "GET",
        signal: AbortSignal.timeout(8000),
        headers: { "User-Agent": "PrivateNexus-Intelligence/1.0" },
      });
      latency_ms  = Date.now() - start;
      status_code = r.status;
      status = r.status < 300 ? "healthy" : r.status < 500 ? "warning" : "degraded";
    } catch (err) {
      status = "down";
      latency_ms = Date.now() - start;
      error = err.name === "TimeoutError" ? "timeout" : err.message;
    }
  }

  try {
    const pool = getPool();
    await Promise.all([
      pool.query("UPDATE services SET status=$1, updated_at=NOW() WHERE id=$2 AND tenant_id=$3",
        [status, svc.id, HOT_TENANT_ID]),
      pool.query(
        `INSERT INTO health_events (tenant_id,service_id,slug,status,status_code,latency_ms,error,source)
         VALUES ($1,$2,$3,$4,$5,$6,$7,'autonomous')`,
        [HOT_TENANT_ID, svc.id, svc.slug, status, status_code, latency_ms ?? Date.now() - start, error]
      ),
    ]);
    return { ok: true, status, status_code, latency_ms };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

// ── Autonomous action executor ───────────────────────────────────────────────
async function executeAction(svc, actionType) {
  if (actionType === "health.refresh") return probeService(svc);
  if (actionType === "container.restart") {
    if (!svc.container_name) return { ok: false, error: "No container_name on service" };
    if (CONTAINER_BLOCKLIST.has(svc.container_name))
      return { ok: false, error: `Container '${svc.container_name}' is protected and cannot be restarted via remediation` };
    // Shares actions.js's cooldown map (keyed there by container ID, here by
    // container_name — not perfectly unified across both entry points, but
    // this closes the actual gap: this path had zero cooldown at all before,
    // and nothing in the frontend ever reaches it — only MCP's
    // pn_restart_service and the autonomous scanner do.
    const lastTs = actionCooldowns.get(svc.container_name) || 0;
    const elapsed = Date.now() - lastTs;
    if (elapsed < COOLDOWN_MS) {
      return { ok: false, error: `Cooldown active — wait ${Math.ceil((COOLDOWN_MS - elapsed) / 1000)}s before retrying` };
    }
    actionCooldowns.set(svc.container_name, Date.now());
    try {
      await docker.getContainer(svc.container_name).restart({ t: 10 });
      return { ok: true, restarted: svc.container_name };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  }
  return { ok: false, error: `${actionType} not supported for autonomous execution` };
}

// ── Core scan ────────────────────────────────────────────────────────────────
export async function runIntelligenceScan() {
  const pool = getPool();

  const { rows: services } = await pool.query(
    `SELECT id, name, slug, category, container_name, health_endpoint, status
     FROM services WHERE tenant_id=$1 AND archived=FALSE`,
    [HOT_TENANT_ID]
  );
  if (!services.length) return { new_signals: 0, new_proposals: 0, executed: 0 };

  const ids = services.map(s => s.id);

  // Last 20 events per service (last 2 days covers it — scheduler runs every 2 min)
  const { rows: evRows } = await pool.query(
    `SELECT service_id, status, latency_ms, ts FROM (
       SELECT *, ROW_NUMBER() OVER (PARTITION BY service_id ORDER BY ts DESC) rn
       FROM health_events
       WHERE tenant_id=$1 AND service_id=ANY($2) AND ts > NOW() - INTERVAL '2 days'
     ) t WHERE rn <= 20`,
    [HOT_TENANT_ID, ids]
  );

  // Existing open signals — to avoid duplicates
  const { rows: openSigs } = await pool.query(
    `SELECT service_id, signal_type FROM intelligence_signals
     WHERE tenant_id=$1 AND resolved_at IS NULL AND fired_at > NOW() - INTERVAL '1 hour'`,
    [HOT_TENANT_ID]
  );
  const openSet = new Set(openSigs.map(s => `${s.service_id}:${s.signal_type}`));

  // Load autonomous policies (enabled only)
  const { rows: autoPolicies } = await pool.query(
    "SELECT signal_type, action_type, max_per_hour, cooldown_secs FROM autonomous_policies WHERE enabled=TRUE AND (tenant_id IS NULL OR tenant_id=$1)",
    [HOT_TENANT_ID]
  );
  const autoMap = new Map(autoPolicies.map(p => [`${p.signal_type}:${p.action_type}`, p]));

  // Rate-limit tracking for autonomous execution. Seeded from actual executed
  // proposals in the last hour (not just this scan pass) — an in-memory-only
  // counter reset on every call would never actually enforce max_per_hour
  // across repeated scans (manual "Run Scan" clicks, or the scheduler's own
  // 5-cycle interval), since openSet already prevents the same signal firing
  // twice within one pass, so the local counter could basically never exceed 1
  // regardless of the configured limit.
  const { rows: recentExecs } = await pool.query(
    `SELECT service_id, action_type, COUNT(*)::int AS n
     FROM remediation_proposals
     WHERE tenant_id=$1 AND status='executed' AND reviewed_by='autonomous'
       AND executed_at > NOW() - INTERVAL '1 hour'
     GROUP BY service_id, action_type`,
    [HOT_TENANT_ID]
  );
  const autoExecuted = {};
  for (const r of recentExecs) autoExecuted[`${r.service_id}:${r.action_type}`] = r.n;

  const eventsByService = {};
  for (const id of ids) eventsByService[id] = [];
  for (const ev of evRows) eventsByService[ev.service_id]?.push(ev);

  let newSignals = 0, newProposals = 0, executed = 0;

  for (const svc of services) {
    if (!svc.health_endpoint) continue; // only analyse services with health checks
    const events  = eventsByService[svc.id] || [];
    const signals = detectSignals(svc, events);

    for (const sig of signals) {
      const key = `${svc.id}:${sig.type}`;
      if (openSet.has(key)) continue; // already open

      // Insert signal
      const { rows: [sigRow] } = await pool.query(
        `INSERT INTO intelligence_signals (tenant_id, service_id, service_name, signal_type, severity, detail)
         VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
        [HOT_TENANT_ID, svc.id, svc.name, sig.type, sig.severity, sig.detail]
      );
      openSet.add(key);
      newSignals++;

      // Generate remediation proposal if action_hint is valid for this service
      const actionType = sig.action_hint;
      if (actionType === "health.refresh" && !svc.health_endpoint) continue;
      if (actionType === "container.restart" && !svc.container_name) continue;

      // Check no pending proposal already exists
      const { rows: existingProp } = await pool.query(
        `SELECT id FROM remediation_proposals
         WHERE tenant_id=$1 AND service_id=$2 AND action_type=$3
           AND status IN ('pending','approved') AND proposed_at > NOW() - INTERVAL '2 hours'`,
        [HOT_TENANT_ID, svc.id, actionType]
      );
      if (existingProp.length) continue;

      const rationale = `Signal '${sig.type}': ${sig.detail}`;
      const autoPolicy = autoMap.get(`${sig.type}:${actionType}`);

      // container.restart only bypasses approval when an enabled autonomous
      // policy explicitly covers it, AND only for critical-severity signals —
      // matching the down_spike:container.restart policy's own documented
      // intent ("5+ consecutive failures"). detectSignals() fires down_spike
      // starting at 3 consecutive failures (severity stays "warning" until 5+),
      // so without the severity check, enabling the toggle would auto-restart
      // far earlier than the policy describes. health.refresh is unaffected —
      // it's always safe to auto-run regardless of severity.
      const canAutoExecute = !!autoPolicy &&
        (actionType !== "container.restart" || sig.severity === "critical");
      const requiresApproval = actionType === "container.restart" && !canAutoExecute;

      if (canAutoExecute) {
        const execKey = `${svc.id}:${actionType}`;
        if ((autoExecuted[execKey] || 0) >= autoPolicy.max_per_hour) continue;
        autoExecuted[execKey] = (autoExecuted[execKey] || 0) + 1;

        const result = await executeAction(svc, actionType);
        await pool.query(
          `INSERT INTO remediation_proposals
             (tenant_id, signal_id, service_id, service_name, action_type, rationale,
              status, requires_approval, reviewed_by, reviewed_at, executed_at, result)
           VALUES ($1,$2,$3,$4,$5,$6,'executed',FALSE,'autonomous',NOW(),NOW(),$7)`,
          [HOT_TENANT_ID, sigRow.id, svc.id, svc.name, actionType, rationale, JSON.stringify(result)]
        );
        recordChange(HOT_TENANT_ID, svc.id, svc.name, "autonomous_action",
          "intelligence-engine", `Autonomous ${actionType}: ${sig.detail}`, result);
        executed++;
      } else {
        // Create pending proposal for human review
        await pool.query(
          `INSERT INTO remediation_proposals
             (tenant_id, signal_id, service_id, service_name, action_type, rationale, requires_approval)
           VALUES ($1,$2,$3,$4,$5,$6,$7)`,
          [HOT_TENANT_ID, sigRow.id, svc.id, svc.name, actionType, rationale, requiresApproval]
        );
        newProposals++;
      }
    }

    // Auto-resolve signals whose service is now healthy
    if (events[0]?.status === "healthy") {
      await pool.query(
        `UPDATE intelligence_signals SET resolved_at=NOW()
         WHERE tenant_id=$1 AND service_id=$2 AND resolved_at IS NULL
           AND fired_at < NOW() - INTERVAL '10 minutes'`,
        [HOT_TENANT_ID, svc.id]
      );
    }
  }

  return { new_signals: newSignals, new_proposals: newProposals, executed };
}

// ── GET /api/intelligence/signals ────────────────────────────────────────────
intelligenceRouter.get("/signals", requireRole("viewer"), async (req, res) => {
  try {
    const hours = Math.min(Number(req.query.hours || 24), 168);
    const { rows } = await getPool().query(
      `SELECT * FROM intelligence_signals
       WHERE tenant_id=$1 AND fired_at > NOW() - INTERVAL '1 hour' * $2
       ORDER BY fired_at DESC LIMIT 100`,
      [HOT_TENANT_ID, hours]
    );
    const counts = { critical: 0, warning: 0, info: 0, total: rows.length };
    for (const r of rows) if (r.severity in counts) counts[r.severity]++;
    res.json({ ok: true, signals: rows, counts });
  } catch (err) {
    console.error("[intelligence] error:", err.message);
    res.status(500).json({ ok: false, error: "Service unavailable" });
  }
});

// ── POST /api/intelligence/signals/:id/ack ───────────────────────────────────
intelligenceRouter.post("/signals/:id/ack", requireRole("operator"), async (req, res) => {
  try {
    const actor = req.session?.user?.username || "operator";
    const { rows: [row] } = await getPool().query(
      `UPDATE intelligence_signals SET acknowledged=TRUE, ack_by=$1, ack_at=NOW()
       WHERE id=$2 AND tenant_id=$3 RETURNING *`,
      [actor, req.params.id, HOT_TENANT_ID]
    );
    if (!row) return res.status(404).json({ ok: false, error: "Signal not found" });
    res.json({ ok: true, signal: row });
  } catch (err) {
    console.error("[intelligence] error:", err.message);
    res.status(500).json({ ok: false, error: "Service unavailable" });
  }
});

// ── POST /api/intelligence/signals/:id/resolve ───────────────────────────────
intelligenceRouter.post("/signals/:id/resolve", requireRole("operator"), async (req, res) => {
  try {
    const { rows: [row] } = await getPool().query(
      `UPDATE intelligence_signals SET resolved_at=NOW(), acknowledged=TRUE
       WHERE id=$1 AND tenant_id=$2 RETURNING *`,
      [req.params.id, HOT_TENANT_ID]
    );
    if (!row) return res.status(404).json({ ok: false, error: "Signal not found" });
    res.json({ ok: true, signal: row });
  } catch (err) {
    console.error("[intelligence] error:", err.message);
    res.status(500).json({ ok: false, error: "Service unavailable" });
  }
});

// ── GET /api/intelligence/proposals ─────────────────────────────────────────
intelligenceRouter.get("/proposals", requireRole("viewer"), async (req, res) => {
  try {
    const status = req.query.status || "pending";
    const params = [HOT_TENANT_ID];
    let where = "tenant_id=$1";
    if (status !== "all") { params.push(status); where += ` AND status=$${params.length}`; }
    const { rows } = await getPool().query(
      `SELECT * FROM remediation_proposals WHERE ${where} ORDER BY proposed_at DESC LIMIT 50`,
      params
    );
    res.json({ ok: true, proposals: rows });
  } catch (err) {
    console.error("[intelligence] error:", err.message);
    res.status(500).json({ ok: false, error: "Service unavailable" });
  }
});

// ── POST /api/intelligence/proposals/:id/approve ─────────────────────────────
intelligenceRouter.post("/proposals/:id/approve", requireRole("operator"), async (req, res) => {
  try {
    const pool  = getPool();
    const actor = req.session?.user?.username || "operator";
    const { rows: [prop] } = await pool.query(
      "SELECT * FROM remediation_proposals WHERE id=$1 AND tenant_id=$2",
      [req.params.id, HOT_TENANT_ID]
    );
    if (!prop) return res.status(404).json({ ok: false, error: "Proposal not found" });
    if (prop.status !== "pending") return res.status(409).json({ ok: false, error: `Already ${prop.status}` });

    // Fetch service for execution
    const { rows: [svc] } = await pool.query(
      "SELECT id, name, slug, container_name, health_endpoint FROM services WHERE id=$1 AND tenant_id=$2",
      [prop.service_id, HOT_TENANT_ID]
    );
    if (!svc) return res.status(404).json({ ok: false, error: "Service not found" });

    const result = await executeAction(svc, prop.action_type);
    const newStatus = result.ok ? "executed" : "failed";
    await pool.query(
      `UPDATE remediation_proposals
       SET status=$1, reviewed_by=$2, reviewed_at=NOW(), executed_at=NOW(), result=$3
       WHERE id=$4`,
      [newStatus, actor, JSON.stringify(result), prop.id]
    );
    recordAudit(req, `intelligence.proposal.${newStatus}`, prop.service_name, newStatus === "executed" ? "success" : "failure", result);
    recordChange(HOT_TENANT_ID, prop.service_id, prop.service_name, "proposal_executed",
      actor, `${prop.action_type} proposal ${newStatus}`, result);
    res.json({ ok: true, result, status: newStatus });
  } catch (err) {
    console.error("[intelligence] error:", err.message);
    res.status(500).json({ ok: false, error: "Service unavailable" });
  }
});

// ── POST /api/intelligence/proposals/:id/dismiss ─────────────────────────────
intelligenceRouter.post("/proposals/:id/dismiss", requireRole("operator"), async (req, res) => {
  try {
    const actor = req.session?.user?.username || "operator";
    const { rows: [row] } = await getPool().query(
      "UPDATE remediation_proposals SET status='dismissed', reviewed_by=$1, reviewed_at=NOW() WHERE id=$2 AND tenant_id=$3 AND status='pending' RETURNING *",
      [actor, req.params.id, HOT_TENANT_ID]
    );
    if (!row) return res.status(404).json({ ok: false, error: "Not found or not pending" });
    res.json({ ok: true });
  } catch (err) {
    console.error("[intelligence] error:", err.message);
    res.status(500).json({ ok: false, error: "Service unavailable" });
  }
});

// ── GET /api/intelligence/autonomous ─────────────────────────────────────────
intelligenceRouter.get("/autonomous", requireRole("viewer"), async (_req, res) => {
  try {
    const { rows } = await getPool().query(
      "SELECT * FROM autonomous_policies WHERE (tenant_id IS NULL OR tenant_id=$1) ORDER BY signal_type, action_type",
      [HOT_TENANT_ID]
    );
    res.json({ ok: true, policies: rows });
  } catch (err) {
    console.error("[intelligence] error:", err.message);
    res.status(500).json({ ok: false, error: "Service unavailable" });
  }
});

// ── PATCH /api/intelligence/autonomous/:id ───────────────────────────────────
intelligenceRouter.patch("/autonomous/:id", requireRole("admin"), async (req, res) => {
  try {
    const { enabled, max_per_hour, cooldown_secs } = req.body;
    const pool  = getPool();
    const sets  = []; const params = [];
    if (typeof enabled === "boolean") { params.push(enabled);       sets.push(`enabled=$${params.length}`); }
    if (max_per_hour  != null)        { params.push(max_per_hour);  sets.push(`max_per_hour=$${params.length}`); }
    if (cooldown_secs != null)        { params.push(cooldown_secs); sets.push(`cooldown_secs=$${params.length}`); }
    if (!sets.length) return res.status(400).json({ ok: false, error: "Nothing to update" });
    params.push(req.params.id, HOT_TENANT_ID);
    const { rows: [row] } = await pool.query(
      `UPDATE autonomous_policies SET ${sets.join(",")} WHERE id=$${params.length - 1} AND (tenant_id IS NULL OR tenant_id=$${params.length}) RETURNING *`,
      params
    );
    if (!row) return res.status(404).json({ ok: false, error: "Policy not found" });
    const actor = req.session?.user?.username || "admin";
    recordAudit(req, "intelligence.autonomous.toggle", `${row.signal_type}:${row.action_type}`, "success");
    res.json({ ok: true, policy: row });
  } catch (err) {
    console.error("[intelligence] error:", err.message);
    res.status(500).json({ ok: false, error: "Service unavailable" });
  }
});

// ── POST /api/intelligence/scan ───────────────────────────────────────────────
intelligenceRouter.post("/scan", requireRole("operator"), async (req, res) => {
  try {
    const result = await runIntelligenceScan();
    recordAudit(req, "intelligence.scan", "estate", "success", result);
    res.json({ ok: true, ...result });
  } catch (err) {
    console.error("[intelligence] error:", err.message);
    res.status(500).json({ ok: false, error: "Service unavailable" });
  }
});

// ── POST /api/intelligence/service/:id/probe ──────────────────────────────────
intelligenceRouter.post("/service/:id/probe", requireRole("operator"), async (req, res) => {
  try {
    const { rows: [svc] } = await getPool().query(
      "SELECT id, name, slug, health_endpoint FROM services WHERE id=$1 AND tenant_id=$2 AND archived=FALSE",
      [req.params.id, HOT_TENANT_ID]
    );
    if (!svc) return res.status(404).json({ ok: false, error: "Service not found" });
    const result = await probeService(svc);
    recordAudit(req, "intelligence.service.probe", svc.name, result.ok ? "success" : "failure", result);
    res.json({ ok: true, service: svc.slug, ...result });
  } catch (err) {
    console.error("[intelligence] error:", err.message);
    res.status(500).json({ ok: false, error: "Service unavailable" });
  }
});

// ── POST /api/intelligence/service/:id/restart ────────────────────────────────
intelligenceRouter.post("/service/:id/restart", requireRole("operator"), async (req, res) => {
  try {
    const pool = getPool();
    const { rows: [svc] } = await pool.query(
      "SELECT id, name, slug, container_name FROM services WHERE id=$1 AND tenant_id=$2 AND archived=FALSE",
      [req.params.id, HOT_TENANT_ID]
    );
    if (!svc) return res.status(404).json({ ok: false, error: "Service not found" });
    if (!svc.container_name) return res.status(422).json({ ok: false, error: "container_name not set on service" });
    const result = await executeAction(svc, "container.restart");
    const actor  = req.session?.user?.username || "operator";
    recordAudit(req, "intelligence.service.restart", svc.name, result.ok ? "success" : "failure", result);
    recordChange(HOT_TENANT_ID, svc.id, svc.name, "container_restart", actor, `MCP-triggered restart of ${svc.container_name}`, result);
    res.json({ ok: true, service: svc.slug, ...result });
  } catch (err) {
    console.error("[intelligence] error:", err.message);
    res.status(500).json({ ok: false, error: "Service unavailable" });
  }
});
