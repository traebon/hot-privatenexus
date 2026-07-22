import net from "node:net";
import { Router } from "express";
import { getPool } from "../db.js";
import { requireRole } from "../middleware/requireRole.js";
import { recordAudit } from "../auditLog.js";
import { recordChange } from "./governance.js";
import { getDocker } from "../dockerClient.js";
import { CONTAINER_BLOCKLIST, COOLDOWN_MS, actionCooldowns } from "./actions.js";

export const intelligenceRouter = Router();

const docker = getDocker();

// ── Shared trend math ────────────────────────────────────────────────────────
// Simple linear regression slope over a chronologically-ordered (oldest first)
// numeric series, plus oldest-third vs newest-third averages. Used by both
// latency_trending (per-service, ratio-based significance test) and
// resource_trending (per-VM, absolute-delta significance test) — the
// regression math itself is identical, only what counts as "significant"
// differs by domain (ms latency spans orders of magnitude; a 0-100 bounded
// percentage doesn't).
function linearTrend(valuesChrono) {
  const n = valuesChrono.length;
  const xMean = (n - 1) / 2;
  const yMean = valuesChrono.reduce((s, v) => s + v, 0) / n;
  let num = 0, den = 0;
  valuesChrono.forEach((v, i) => {
    num += (i - xMean) * (v - yMean);
    den += (i - xMean) ** 2;
  });
  const slope = den > 0 ? num / den : 0;
  const third  = Math.max(1, Math.floor(n / 3));
  const oldAvg = valuesChrono.slice(0, third).reduce((s, v) => s + v, 0) / third;
  const newAvg = valuesChrono.slice(-third).reduce((s, v) => s + v, 0) / third;
  return { slope, oldAvg, newAvg, n };
}

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

  // 5. Predictive latency trend — the only signal designed to fire BEFORE any
  // check has actually failed. Signals 1-4 above all require at least one
  // observed non-healthy or already-slow event; this one looks for a service
  // that is still passing every recent check (consec === 0) but whose response
  // time has been climbing steadily across the whole window — the kind of
  // early warning v5.0's "predictive degradation" gate item is actually meant
  // to prove (see PrivateNexus_Release_Roadmap_v1.0.md, v5.0 acceptance gate).
  if (consec === 0) {
    const withLatency = recent.filter(e => e.status === "healthy" && e.latency_ms != null);
    if (withLatency.length >= 8) {
      // withLatency[0] is newest (recent is ORDER BY ts DESC) — reverse to
      // chronological order so the regression slope reads "ms increase per
      // probe going forward in time", not backward.
      const chrono = [...withLatency].reverse().map(e => e.latency_ms);
      const { slope, oldAvg, newAvg, n } = linearTrend(chrono);
      // Slope alone is noise-prone (one outlier can tilt a small sample) —
      // also require the newest third to be meaningfully above the oldest
      // third (ratio-based: latency spans orders of magnitude), so this only
      // fires on a real sustained climb, not a blip.
      if (slope > 5 && oldAvg > 30 && newAvg > oldAvg * 1.6) {
        signals.push({
          type: "latency_trending",
          severity: "warning",
          detail: `Latency climbing while still healthy: ~${Math.round(oldAvg)}ms → ~${Math.round(newAvg)}ms over last ${n} probes (+${Math.round(slope)}ms/probe)`,
          action_hint: "health.refresh",
        });
      }
    }
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

async function probeService(svc, tenantId) {
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
        [status, svc.id, tenantId]),
      pool.query(
        `INSERT INTO health_events (tenant_id,service_id,slug,status,status_code,latency_ms,error,source)
         VALUES ($1,$2,$3,$4,$5,$6,$7,'autonomous')`,
        [tenantId, svc.id, svc.slug, status, status_code, latency_ms ?? Date.now() - start, error]
      ),
    ]);
    return { ok: true, status, status_code, latency_ms };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

// ── Autonomous action executor ───────────────────────────────────────────────
async function executeAction(svc, actionType, tenantId) {
  if (actionType === "health.refresh") return probeService(svc, tenantId);
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
// tenantId is required — the scheduler loops this across every tenant (see
// healthScheduler.js), and each route caller passes req.session.user.tenant_id.
export async function runIntelligenceScan(tenantId) {
  const pool = getPool();

  const { rows: services } = await pool.query(
    `SELECT id, name, slug, category, container_name, health_endpoint, status
     FROM services WHERE tenant_id=$1 AND archived=FALSE`,
    [tenantId]
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
    [tenantId, ids]
  );

  // Existing open signals — to avoid duplicates. Must NOT bound by fired_at: a
  // signal is open for as long as resolved_at is NULL, however long that takes:
  // a `fired_at > NOW() - INTERVAL '1 hour'` cutoff here previously caused any
  // signal whose underlying condition outlasted an hour (e.g. Proxmox down for
  // the multi-day bare-metal outage) to silently drop out of openSet on the next
  // scan and get re-fired as "new" indefinitely, flooding intelligence_signals
  // and remediation_proposals with duplicates of the same persistent condition.
  const { rows: openSigs } = await pool.query(
    `SELECT service_id, signal_type FROM intelligence_signals
     WHERE tenant_id=$1 AND resolved_at IS NULL`,
    [tenantId]
  );
  const openSet = new Set(openSigs.map(s => `${s.service_id}:${s.signal_type}`));

  // Load autonomous policies (enabled only)
  const { rows: autoPolicies } = await pool.query(
    "SELECT signal_type, action_type, max_per_hour, cooldown_secs FROM autonomous_policies WHERE enabled=TRUE AND (tenant_id IS NULL OR tenant_id=$1)",
    [tenantId]
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
    [tenantId]
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
        [tenantId, svc.id, svc.name, sig.type, sig.severity, sig.detail]
      );
      openSet.add(key);
      newSignals++;

      // Generate remediation proposal if action_hint is valid for this service
      const actionType = sig.action_hint;
      if (actionType === "health.refresh" && !svc.health_endpoint) continue;
      if (actionType === "container.restart" && !svc.container_name) continue;

      // Check no pending proposal already exists. Same class of bug as the
      // openSet query above: a proposed_at time bound here would let a still-
      // pending (just unreviewed for a while) proposal get silently duplicated
      // the next time its signal legitimately re-fires — pending/approved means
      // open regardless of age, matching what this comment already promises.
      const { rows: existingProp } = await pool.query(
        `SELECT id FROM remediation_proposals
         WHERE tenant_id=$1 AND service_id=$2 AND action_type=$3
           AND status IN ('pending','approved')`,
        [tenantId, svc.id, actionType]
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

        const result = await executeAction(svc, actionType, tenantId);
        await pool.query(
          `INSERT INTO remediation_proposals
             (tenant_id, signal_id, service_id, service_name, action_type, rationale,
              status, requires_approval, reviewed_by, reviewed_at, executed_at, result)
           VALUES ($1,$2,$3,$4,$5,$6,'executed',FALSE,'autonomous',NOW(),NOW(),$7)`,
          [tenantId, sigRow.id, svc.id, svc.name, actionType, rationale, JSON.stringify(result)]
        );
        recordChange(tenantId, svc.id, svc.name, "autonomous_action",
          "intelligence-engine", `Autonomous ${actionType}: ${sig.detail}`, result);
        executed++;
      } else {
        // Create pending proposal for human review
        await pool.query(
          `INSERT INTO remediation_proposals
             (tenant_id, signal_id, service_id, service_name, action_type, rationale, requires_approval)
           VALUES ($1,$2,$3,$4,$5,$6,$7)`,
          [tenantId, sigRow.id, svc.id, svc.name, actionType, rationale, requiresApproval]
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
        [tenantId, svc.id]
      );
    }
  }

  const auditResult = await detectAuditAnomalies(pool, tenantId);
  newSignals += auditResult.newSignals;

  const resourceResult = await detectResourceAnomalies(pool, tenantId);
  newSignals += resourceResult.newSignals;

  return { new_signals: newSignals, new_proposals: newProposals, executed };
}

// ── Audit anomaly detection ──────────────────────────────────────────────────
// Not tied to any service (service_id stays NULL, service_name holds the
// source IP) -- this flags a pattern in login activity against the platform
// itself, not a specific service's health, so it doesn't fit the per-service
// loop above. No matching action_hint/remediation-proposal path either: there
// is no automated fix for "someone is guessing passwords" the way there is
// for a slow health check, so this is signal-only, for a human to review.
async function detectAuditAnomalies(pool, tenantId) {
  const WINDOW_MINUTES = 30;
  const THRESHOLD = 5;

  const { rows: bursts } = await pool.query(
    `SELECT ip, count(*)::int AS n, max(ts) AS last_attempt
     FROM audit_log
     WHERE tenant_id=$1 AND action='auth.login' AND outcome='failure'
       AND ip IS NOT NULL AND ts > NOW() - INTERVAL '${WINDOW_MINUTES} minutes'
     GROUP BY ip
     HAVING count(*) >= $2`,
    [tenantId, THRESHOLD]
  );

  const { rows: openBursts } = await pool.query(
    `SELECT id, service_name AS ip FROM intelligence_signals
     WHERE tenant_id=$1 AND signal_type='auth_failure_burst' AND resolved_at IS NULL`,
    [tenantId]
  );
  const openIpSet = new Set(openBursts.map(r => r.ip));

  let newSignals = 0;
  for (const b of bursts) {
    if (openIpSet.has(b.ip)) continue; // already flagged and still open
    const severity = b.n >= 10 ? "critical" : "warning";
    await pool.query(
      `INSERT INTO intelligence_signals (tenant_id, service_id, service_name, signal_type, severity, detail)
       VALUES ($1, NULL, $2, 'auth_failure_burst', $3, $4)`,
      [
        tenantId, b.ip, severity,
        `${b.n} failed login attempts from this IP in the last ${WINDOW_MINUTES} minutes (latest: ${new Date(b.last_attempt).toISOString()})`,
      ]
    );
    newSignals++;
  }

  // Auto-resolve bursts whose IP has gone quiet for a full window
  for (const ob of openBursts) {
    const { rows: stillActive } = await pool.query(
      `SELECT 1 FROM audit_log WHERE tenant_id=$1 AND action='auth.login' AND outcome='failure'
         AND ip=$2 AND ts > NOW() - INTERVAL '${WINDOW_MINUTES} minutes' LIMIT 1`,
      [tenantId, ob.ip]
    );
    if (!stillActive.length) {
      await pool.query(`UPDATE intelligence_signals SET resolved_at=NOW() WHERE id=$1`, [ob.id]);
    }
  }

  return { newSignals };
}

// ── Resource usage anomaly detection ─────────────────────────────────────────
// Prometheus range query — same client this file otherwise has no need for
// (ops.js has its own instant-query promQuery(), not exported; this is the
// first range query anywhere in the backend).
async function promQueryRange(promUrl, query, startSec, endSec, stepSec) {
  const url = `${promUrl}/api/v1/query_range?query=${encodeURIComponent(query)}&start=${startSec}&end=${endSec}&step=${stepSec}`;
  const r = await fetch(url, { signal: AbortSignal.timeout(8000) });
  const data = await r.json();
  return data.data?.result || [];
}

// One entry per fleet-wide metric this checks. minDelta is an absolute
// percentage-point threshold, not a ratio like latency_trending's -- a 0-100
// bounded metric going from 5% to 8% is a 1.6x ratio but noise, while 40% to
// 55% is only 1.375x but a real, meaningful climb. Absolute delta is the
// correct significance test for this domain; ratio is correct for latency,
// which spans orders of magnitude. Same regression math (linearTrend),
// different "is this significant" rule on top.
const RESOURCE_METRICS = [
  { key: "cpu",  label: "CPU",
    query: '100 - (avg by(instance) (irate(node_cpu_seconds_total{mode="idle"}[5m])) * 100)',
    minDelta: 20 },
  { key: "ram",  label: "Memory",
    query: "(1 - (node_memory_MemAvailable_bytes / node_memory_MemTotal_bytes)) * 100",
    minDelta: 15 },
  { key: "disk", label: "Disk",
    query: '(1 - (node_filesystem_avail_bytes{mountpoint="/",fstype!="tmpfs"} / node_filesystem_size_bytes{mountpoint="/",fstype!="tmpfs"})) * 100',
    minDelta: 10 },
];

// Not tied to any service, same reasoning as detectAuditAnomalies -- this is
// host-level, not a specific service's health. service_name holds "<instance>
// — <metric label>" so multiple metrics on the same VM can be open at once
// without colliding. No action_hint/remediation-proposal: there's no safe
// automated fix for "a VM's disk is filling up," same as auth_failure_burst.
// NOTE: the underlying Prometheus metrics here are fleet/host-wide, not
// per-tenant data — this attributes the resulting signal to whichever
// tenant's scan happened to run it, which double-reports the same VM trend
// once per tenant if more than one tenant is ever scanned. Fine for the
// single-tenant reality today; revisit (e.g. a NULL-tenant "platform" signal
// class) if/when a second tenant is actually onboarded.
async function detectResourceAnomalies(pool, tenantId) {
  const promUrl = process.env.PROMETHEUS_URL || "http://10.10.50.104:9090";
  const nowSec   = Math.floor(Date.now() / 1000);
  const startSec = nowSec - 2 * 3600; // 2h lookback, 5m step -> ~24 points
  const stepSec  = 300;

  const { rows: openTrends } = await pool.query(
    `SELECT id, service_name AS key FROM intelligence_signals
     WHERE tenant_id=$1 AND signal_type='resource_trending' AND resolved_at IS NULL`,
    [tenantId]
  );
  const openKeySet = new Set(openTrends.map(r => r.key));
  const stillTrendingKeys = new Set();

  const queriedMetrics = new Set(); // labels that queried successfully this cycle

  let newSignals = 0;
  for (const m of RESOURCE_METRICS) {
    let series;
    try {
      series = await promQueryRange(promUrl, m.query, startSec, nowSec, stepSec);
      queriedMetrics.add(m.label);
    } catch (err) {
      console.error(`[intelligence] resource query failed (${m.key}):`, err.message);
      continue; // Prometheus unreachable shouldn't abort the whole scan
    }

    for (const s of series) {
      const instance = s.metric?.instance;
      if (!instance) continue;
      const values = (s.values || [])
        .map(([, v]) => Number(v))
        .filter(v => Number.isFinite(v));
      if (values.length < 8) continue; // not enough history for a real trend

      const { slope, oldAvg, newAvg } = linearTrend(values);
      const key = `${instance} — ${m.label}`;

      if (slope > 0 && newAvg - oldAvg >= m.minDelta && newAvg <= 95) {
        stillTrendingKeys.add(key);
        if (openKeySet.has(key)) continue; // already flagged and still open
        await pool.query(
          `INSERT INTO intelligence_signals (tenant_id, service_id, service_name, signal_type, severity, detail)
           VALUES ($1, NULL, $2, 'resource_trending', $3, $4)`,
          [
            tenantId, key, newAvg >= 85 ? "critical" : "warning",
            `${m.label} climbing on ${instance}: ~${Math.round(oldAvg)}% → ~${Math.round(newAvg)}% over the last 2h`,
          ]
        );
        newSignals++;
      }
    }
  }

  // Auto-resolve trends that are no longer climbing -- but only for metrics
  // that actually queried successfully this cycle. A transient Prometheus
  // failure must not resolve a real open trend just because it couldn't be
  // re-checked this pass.
  for (const ot of openTrends) {
    const metricLabel = ot.key.split(" — ")[1];
    if (!queriedMetrics.has(metricLabel)) continue;
    if (!stillTrendingKeys.has(ot.key)) {
      await pool.query(`UPDATE intelligence_signals SET resolved_at=NOW() WHERE id=$1`, [ot.id]);
    }
  }

  return { newSignals };
}

// ── GET /api/intelligence/signals ────────────────────────────────────────────
intelligenceRouter.get("/signals", requireRole("viewer"), async (req, res) => {
  try {
    const hours = Math.min(Number(req.query.hours || 24), 168);
    const { rows } = await getPool().query(
      `SELECT * FROM intelligence_signals
       WHERE tenant_id=$1 AND fired_at > NOW() - INTERVAL '1 hour' * $2
       ORDER BY fired_at DESC LIMIT 100`,
      [req.session.user.tenant_id, hours]
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
      [actor, req.params.id, req.session.user.tenant_id]
    );
    if (!row) return res.status(404).json({ ok: false, error: "Signal not found" });
    recordAudit(req, "intelligence.signal.ack", row.signal_type, "success");
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
      [req.params.id, req.session.user.tenant_id]
    );
    if (!row) return res.status(404).json({ ok: false, error: "Signal not found" });
    recordAudit(req, "intelligence.signal.resolve", row.signal_type, "success");
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
    const params = [req.session.user.tenant_id];
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
      [req.params.id, req.session.user.tenant_id]
    );
    if (!prop) return res.status(404).json({ ok: false, error: "Proposal not found" });
    if (prop.status !== "pending") return res.status(409).json({ ok: false, error: `Already ${prop.status}` });

    // Fetch service for execution
    const { rows: [svc] } = await pool.query(
      "SELECT id, name, slug, container_name, health_endpoint FROM services WHERE id=$1 AND tenant_id=$2",
      [prop.service_id, req.session.user.tenant_id]
    );
    if (!svc) return res.status(404).json({ ok: false, error: "Service not found" });

    const result = await executeAction(svc, prop.action_type, req.session.user.tenant_id);
    const newStatus = result.ok ? "executed" : "failed";
    await pool.query(
      `UPDATE remediation_proposals
       SET status=$1, reviewed_by=$2, reviewed_at=NOW(), executed_at=NOW(), result=$3
       WHERE id=$4`,
      [newStatus, actor, JSON.stringify(result), prop.id]
    );
    recordAudit(req, `intelligence.proposal.${newStatus}`, prop.service_name, newStatus === "executed" ? "success" : "failure", result);
    recordChange(req.session.user.tenant_id, prop.service_id, prop.service_name, "proposal_executed",
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
      [actor, req.params.id, req.session.user.tenant_id]
    );
    if (!row) return res.status(404).json({ ok: false, error: "Not found or not pending" });
    recordAudit(req, "intelligence.proposal.dismiss", row.service_name, "success");
    res.json({ ok: true });
  } catch (err) {
    console.error("[intelligence] error:", err.message);
    res.status(500).json({ ok: false, error: "Service unavailable" });
  }
});

// ── GET /api/intelligence/autonomous ─────────────────────────────────────────
intelligenceRouter.get("/autonomous", requireRole("viewer"), async (req, res) => {
  try {
    const { rows } = await getPool().query(
      "SELECT * FROM autonomous_policies WHERE (tenant_id IS NULL OR tenant_id=$1) ORDER BY signal_type, action_type",
      [req.session.user.tenant_id]
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
    params.push(req.params.id, req.session.user.tenant_id);
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
    const result = await runIntelligenceScan(req.session.user.tenant_id);
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
      [req.params.id, req.session.user.tenant_id]
    );
    if (!svc) return res.status(404).json({ ok: false, error: "Service not found" });
    const result = await probeService(svc, req.session.user.tenant_id);
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
      [req.params.id, req.session.user.tenant_id]
    );
    if (!svc) return res.status(404).json({ ok: false, error: "Service not found" });
    if (!svc.container_name) return res.status(422).json({ ok: false, error: "container_name not set on service" });
    const result = await executeAction(svc, "container.restart", req.session.user.tenant_id);
    const actor  = req.session?.user?.username || "operator";
    recordAudit(req, "intelligence.service.restart", svc.name, result.ok ? "success" : "failure", result);
    recordChange(req.session.user.tenant_id, svc.id, svc.name, "container_restart", actor, `MCP-triggered restart of ${svc.container_name}`, result);
    res.json({ ok: true, service: svc.slug, ...result });
  } catch (err) {
    console.error("[intelligence] error:", err.message);
    res.status(500).json({ ok: false, error: "Service unavailable" });
  }
});
