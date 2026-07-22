import { Router } from "express";
import { getDocker } from "../dockerClient.js";
import os from "os";
import { execSync } from "child_process";
import { existsSync, readFileSync, writeFileSync, rmSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { recordAudit } from "../auditLog.js";
import { requireRole, userRole } from "../middleware/requireRole.js";
import { getPool } from "../db.js";
import { recordChange } from "./governance.js";
import { createMaintenanceSilence, deleteMaintenanceSilence } from "../grafana.js";

export const actionsRouter = Router();

const docker = getDocker();

// Was "/tmp/pn-maintenance.json" -- ephemeral, wiped on every redeploy. Now
// under app/backend/data/, which the Dockerfile creates and chowns to the
// runtime user at build time (see the Files board fix, same day) -- no
// runtime mkdirSync needed here, the directory is guaranteed to already
// exist and be writable by the time this module loads.
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MAINTENANCE_FILE = path.join(__dirname, "../../data/maintenance.json");

// Auto-expiry timer for maintenance mode
let maintenanceTimer = null;
function clearMaintenanceTimer() {
  if (maintenanceTimer) { clearTimeout(maintenanceTimer); maintenanceTimer = null; }
}
function scheduleMaintenanceExpiry(endsAt) {
  clearMaintenanceTimer();
  const ms = new Date(endsAt).getTime() - Date.now();
  if (ms <= 0) return;
  maintenanceTimer = setTimeout(() => {
    try { if (existsSync(MAINTENANCE_FILE)) rmSync(MAINTENANCE_FILE); } catch {}
    console.log("[maintenance] auto-expired at", new Date().toISOString());
  }, ms);
}

// On startup: re-arm timer if maintenance file exists with future endsAt
try {
  if (existsSync(MAINTENANCE_FILE)) {
    const saved = JSON.parse(readFileSync(MAINTENANCE_FILE, "utf8"));
    if (saved.endsAt && new Date(saved.endsAt) > new Date()) {
      scheduleMaintenanceExpiry(saved.endsAt);
    } else if (saved.endsAt) {
      rmSync(MAINTENANCE_FILE); // expired while process was down
    }
  }
} catch {}

const ALLOWED_ACTIONS = new Set(["start", "stop", "restart"]);

// Containers that may never be stopped or restarted via the actions API.
// Stopping the database or cache mid-session causes data loss and session wipe.
// Exported: routes/intelligence.js's autonomous/human-approved remediation
// executor has its own container.restart path and must enforce this too —
// it does not go through this router at all.
export const CONTAINER_BLOCKLIST = new Set([
  "privatenexus-db",
  "privatenexus-redis",
]);

// Only containers in this list may be targeted by the /run endpoint.
// Add container names here as the managed estate grows.
const CONTAINER_ALLOWLIST = new Set([
  "privatenexus-frontend",
  "privatenexus-backend",
]);

// Per-container cooldown: prevents rapid-fire actions (e.g. accidental double-click restart).
// Exported and shared with intelligence.js's remediation executor — a restart
// triggered via the Stacks board and one triggered via MCP/autonomous
// remediation must rate-limit against the same container, not two independent
// 60s windows that together allow effectively-unlimited rapid restarts.
export const COOLDOWN_MS = 60_000;
export const actionCooldowns = new Map(); // containerId → lastActionTs (ms)

// Docker image reference: registry/namespace/name:tag[@digest]
// Permits only safe characters — rejects shell metacharacters and control chars.
const IMAGE_REF_RE = /^[a-z0-9][a-zA-Z0-9._\-/:@]*$/;

// POST /api/actions/run — { action, containerId } (also accepts target for compat)
// action: "start" | "stop" | "restart"
// containerId: container id or name
actionsRouter.post("/run", requireRole("operator"), async (req, res) => {
  const { action, containerId, target } = req.body || {};
  const id = containerId || target;

  if (!action || !ALLOWED_ACTIONS.has(action)) {
    return res.status(400).json({ ok: false, error: `Unsupported action: ${action}` });
  }
  if (!id) {
    return res.status(400).json({ ok: false, error: "action and containerId are required" });
  }

  if (CONTAINER_BLOCKLIST.has(id)) {
    recordAudit(req, `container.${action}.blocked`, id, "failure", { reason: "blocklisted" });
    return res.status(403).json({ ok: false, error: `Container '${id}' cannot be controlled via this API` });
  }

  if (!CONTAINER_ALLOWLIST.has(id)) {
    recordAudit(req, `container.${action}.blocked`, id, "failure", { reason: "not in allowlist" });
    return res.status(403).json({ ok: false, error: `Container '${id}' is not in the approved action allowlist` });
  }

  const lastTs = actionCooldowns.get(id) || 0;
  const elapsed = Date.now() - lastTs;
  if (elapsed < COOLDOWN_MS) {
    const retryAfterMs = COOLDOWN_MS - elapsed;
    recordAudit(req, `container.${action}.cooldown`, id, "failure", { retryAfterMs });
    return res.status(429).json({
      ok: false,
      error: `Action cooldown active — wait ${Math.ceil(retryAfterMs / 1000)}s before retrying`,
      retryAfterMs,
    });
  }
  actionCooldowns.set(id, Date.now());

  try {
    const container = docker.getContainer(id);
    if (action === "start") await container.start();
    else if (action === "stop") await container.stop({ t: 10 });
    else if (action === "restart") await container.restart({ t: 10 });

    recordAudit(req, `container.${action}`, id, "success");
    res.json({ ok: true, mode: "docker", action, containerId: id, ts: new Date().toISOString() });
  } catch (err) {
    console.error(`Failed to ${action} container ${id}:`, err.message);
    recordAudit(req, `container.${action}`, id, "failure", { error: err.message });
    res.status(500).json({ ok: false, error: `Failed to ${action} container`, detail: err.message });
  }
});

// GET /api/actions/emergency/status — system snapshot + maintenance mode state
actionsRouter.get("/emergency/status", requireRole("admin"), async (_req, res) => {
  try {
    const containers = await docker.listContainers({ all: true });
    const running = containers.filter((c) => c.State === "running").length;
    const stopped = containers.filter((c) => c.State !== "running").length;

    let maintenanceMode = null;
    if (existsSync(MAINTENANCE_FILE)) {
      try { maintenanceMode = JSON.parse(readFileSync(MAINTENANCE_FILE, "utf8")); } catch {}
    }

    const totalMem = os.totalmem();
    const freeMem  = os.freemem();

    let diskPct = null;
    try {
      const raw = execSync("df -P / | awk 'NR==2 {print $5}'", { encoding: "utf8" }).trim();
      diskPct = parseInt(raw.replace("%", ""), 10) || null;
    } catch {}

    res.json({
      containers: { running, stopped, total: containers.length },
      memory:      { usedPct: Math.round(((totalMem - freeMem) / totalMem) * 100) },
      disk:        { usedPct: diskPct },
      maintenanceMode,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/actions/emergency — fleet-wide emergency operations (admin+)
actionsRouter.post("/emergency", requireRole("admin"), async (req, res) => {
  const { action, reason } = req.body || {};

  const ALLOWED_EMERGENCY = new Set([
    "stacks.stop-all",
    "stacks.restart-all",
    "maintenance.enable",
    "maintenance.disable",
    "diagnostics.run",
  ]);

  if (!ALLOWED_EMERGENCY.has(action)) {
    return res.status(400).json({ ok: false, error: `Unknown emergency action: ${action}` });
  }

  // Fleet-wide stop-all has a seeded action_policies row (elevation_required=
  // superadmin, cooldown_secs=3600) that this route never consulted at all —
  // requireRole("admin") above let plain admins trigger it immediately,
  // repeatedly. Enforcing elevation + cooldown here (not requires_approval —
  // dual-control on the single highest-blast-radius action would lock out a
  // solo operator during a real emergency, a deliberate choice, not an
  // oversight). restart-all has no seeded policy row, so it's intentionally
  // left at the admin-only bar this route always had.
  if (action === "stacks.stop-all") {
    const policy = await getPolicy("emergency.stop-all");
    if (policy?.elevation_required && userRoleLevel(req) < requiredLevel(policy.elevation_required)) {
      recordAudit(req, "emergency.stacks.stop-all.blocked", null, "failure", { reason: "elevation_required", required: policy.elevation_required });
      return res.status(403).json({ ok: false, error: `Action requires ${policy.elevation_required} role or higher` });
    }
    if (policy?.cooldown_secs) {
      const cooldownKey = "emergency:stacks.stop-all";
      const cooldownMs  = policy.cooldown_secs * 1000;
      const lastTs      = actionCooldowns.get(cooldownKey) || 0;
      const elapsed     = Date.now() - lastTs;
      if (elapsed < cooldownMs) {
        return res.status(429).json({ ok: false, error: `Cooldown active — wait ${Math.ceil((cooldownMs - elapsed) / 1000)}s before retrying` });
      }
      actionCooldowns.set(cooldownKey, Date.now());
    }
  }

  // maintenance.enable has a seeded cooldown_secs=300 policy row that was
  // never consulted anywhere -- same unenforced-policy bug as stop-all had,
  // just lower stakes (maintenance mode is currently a pure display flag,
  // nothing else in the app gates on it, confirmed by grep). elevation_required
  // is already satisfied by this route's own requireRole("admin") gate, so
  // only the cooldown is meaningfully new here. Only gates enable, not
  // disable -- no reason to rate-limit turning it back off.
  if (action === "maintenance.enable") {
    const policy = await getPolicy("maintenance.enable");
    if (policy?.cooldown_secs) {
      const cooldownKey = "emergency:maintenance.enable";
      const cooldownMs  = policy.cooldown_secs * 1000;
      const lastTs      = actionCooldowns.get(cooldownKey) || 0;
      const elapsed     = Date.now() - lastTs;
      if (elapsed < cooldownMs) {
        return res.status(429).json({ ok: false, error: `Cooldown active — wait ${Math.ceil((cooldownMs - elapsed) / 1000)}s before retrying` });
      }
      actionCooldowns.set(cooldownKey, Date.now());
    }
  }

  try {
    if (action === "stacks.stop-all") {
      const list = await docker.listContainers({ all: false });
      const results = [];
      for (const c of list) {
        const name = (c.Names?.[0] || "").replace(/^\//, "");
        if (CONTAINER_BLOCKLIST.has(name)) {
          results.push({ name, ok: false, skipped: true, reason: "blocklisted — not stopped" });
          continue;
        }
        try {
          await docker.getContainer(c.Id).stop({ t: 10 });
          results.push({ name, ok: true });
        } catch (err) {
          results.push({ name, ok: false, error: err.message });
        }
      }
      const ok = results.every((r) => r.ok);
      recordAudit(req, "emergency.stacks.stop-all", null, ok ? "success" : "failure", { results });
      return res.json({ ok, action, results });
    }

    if (action === "stacks.restart-all") {
      const list = await docker.listContainers({ all: false });
      const results = [];
      for (const c of list) {
        const name = (c.Names?.[0] || "").replace(/^\//, "");
        if (CONTAINER_BLOCKLIST.has(name)) {
          results.push({ name, ok: false, skipped: true, reason: "blocklisted — not restarted" });
          continue;
        }
        try {
          await docker.getContainer(c.Id).restart({ t: 10 });
          results.push({ name, ok: true });
        } catch (err) {
          results.push({ name, ok: false, error: err.message });
        }
      }
      const ok = results.every((r) => r.ok);
      recordAudit(req, "emergency.stacks.restart-all", null, ok ? "success" : "failure", { results });
      return res.json({ ok, action, results });
    }

    if (action === "maintenance.enable") {
      const VALID_DURATIONS = { "1h": 3600, "4h": 14400, "8h": 28800, "24h": 86400 };
      const rawDuration = req.body.duration;
      let durationSecs = null;
      let endsAt = null;
      if (rawDuration) {
        durationSecs = VALID_DURATIONS[rawDuration] ?? (Number.isFinite(Number(rawDuration)) ? Math.min(Number(rawDuration), 86400) : null);
        if (!durationSecs || durationSecs <= 0) {
          return res.status(400).json({ ok: false, error: "Invalid duration — use 1h, 4h, 8h, 24h, or seconds (max 86400)" });
        }
        endsAt = new Date(Date.now() + durationSecs * 1000).toISOString();
      }

      // Suppress Ntfy/email alerts for the window via a Grafana Alerting
      // silence -- Grafana auto-expires it at endsAt, so "resumes on expiry"
      // needs no PN-side timer of its own. Requires a duration: Grafana
      // silences can't be open-ended, so indefinite maintenance (no
      // duration given) honestly reports suppression as unavailable rather
      // than silently covering only part of the window. Never lets a
      // Grafana failure block maintenance mode itself -- the display flag
      // and the alert suppression are reported separately so the UI can't
      // imply protection that didn't actually happen.
      const grafanaSilence = endsAt
        ? await createMaintenanceSilence({ endsAt, reason, createdBy: req.session?.user?.username })
        : { ok: false, error: "No duration set -- open-ended maintenance cannot suppress alerts (Grafana silences require an end time)" };
      if (!grafanaSilence.ok) console.warn("[maintenance] alert suppression unavailable:", grafanaSilence.error);

      const state = { enabled: true, since: new Date().toISOString(), reason: reason || null, durationSecs, endsAt, grafanaSilence };
      writeFileSync(MAINTENANCE_FILE, JSON.stringify(state));
      if (endsAt) scheduleMaintenanceExpiry(endsAt);
      else clearMaintenanceTimer();
      recordAudit(req, "emergency.maintenance.enable", null, "success", { durationSecs, endsAt, alertSuppression: grafanaSilence.ok ? "active" : grafanaSilence.error });
      return res.json({ ok: true, action, maintenanceMode: state });
    }

    if (action === "maintenance.disable") {
      clearMaintenanceTimer();
      let priorSilence = null;
      if (existsSync(MAINTENANCE_FILE)) {
        try { priorSilence = JSON.parse(readFileSync(MAINTENANCE_FILE, "utf8")).grafanaSilence; } catch {}
        rmSync(MAINTENANCE_FILE);
      }
      let silenceCleared = null;
      if (priorSilence?.ok && priorSilence.silenceId) {
        silenceCleared = await deleteMaintenanceSilence(priorSilence.silenceId);
        if (!silenceCleared.ok) console.warn("[maintenance] failed to clear Grafana silence early:", silenceCleared.error);
      }
      recordAudit(req, "emergency.maintenance.disable", null, "success", silenceCleared ? { alertSuppressionCleared: silenceCleared.ok } : undefined);
      return res.json({ ok: true, action, maintenanceMode: null });
    }

    if (action === "diagnostics.run") {
      const list = await docker.listContainers({ all: true });
      const running = list.filter((c) => c.State === "running");
      const stopped = list.filter((c) => c.State !== "running");

      const totalMem = os.totalmem();
      const freeMem  = os.freemem();

      let diskInfo = null;
      try {
        const raw = execSync("df -P / | awk 'NR==2 {print $2,$3,$4,$5}'", { encoding: "utf8" }).trim().split(/\s+/);
        diskInfo = {
          total: Math.round(parseInt(raw[0]) / 1024 / 1024) + " GB",
          used:  Math.round(parseInt(raw[1]) / 1024 / 1024) + " GB",
          free:  Math.round(parseInt(raw[2]) / 1024 / 1024) + " GB",
          pct:   parseInt((raw[3] || "0").replace("%", ""), 10),
        };
      } catch {}

      const loadAvg = os.loadavg();

      const diag = {
        ts: new Date().toISOString(),
        containers: {
          total:        list.length,
          running:      running.length,
          stopped:      stopped.length,
          stoppedNames: stopped.map((c) => (c.Names?.[0] || "").replace(/^\//, "")),
        },
        memory: {
          totalMB: Math.round(totalMem / 1024 / 1024),
          freeMB:  Math.round(freeMem  / 1024 / 1024),
          usedPct: Math.round(((totalMem - freeMem) / totalMem) * 100),
        },
        disk: diskInfo,
        system: {
          loadAvg1:    Math.round(loadAvg[0] * 100) / 100,
          loadAvg5:    Math.round(loadAvg[1] * 100) / 100,
          uptimeHours: Math.round(os.uptime() / 3600 * 10) / 10,
        },
      };

      recordAudit(req, "diagnostics.run", null, "success");
      return res.json({ ok: true, action, diagnostics: diag });
    }
  } catch (err) {
    recordAudit(req, `emergency.${action}`, null, "failure", { error: err.message });
    return res.status(500).json({ ok: false, action, error: err.message });
  }
});

const ROLE_LEVEL = { viewer: 0, operator: 1, admin: 2, superadmin: 3, breakglass: 4 };

// ── Helpers ───────────────────────────────────────────────────────────────────

// req.session.user only ever carries a `roles` array (set at the Keycloak
// callback in routes/auth.js) — there is no singular `.role` field. Route
// through the same userRole() helper requireRole() itself uses, so this
// stays correct if the session shape ever changes.
function userRoleLevel(req) {
  return ROLE_LEVEL[userRole(req.session)] ?? -1;
}

function requiredLevel(elevation) {
  return ROLE_LEVEL[elevation] ?? 1;
}

async function blastRadiusCheck(serviceId, tenantId) {
  if (!serviceId) return { count: 0, hard: 0, affected: [] };
  const { rows } = await getPool().query(
    `SELECT sd.dep_type, s.name, s.slug, s.status
     FROM service_dependencies sd
     JOIN services s ON s.id = sd.downstream_id
     WHERE sd.upstream_id = $1 AND sd.tenant_id = $2`,
    [serviceId, tenantId]
  );
  return {
    count: rows.length,
    hard:  rows.filter(r => r.dep_type === "hard").length,
    affected: rows,
  };
}

async function getPolicy(actionType) {
  const { rows } = await getPool().query(
    `SELECT * FROM action_policies WHERE action_type = $1 AND enabled = TRUE LIMIT 1`,
    [actionType]
  );
  return rows[0] || null;
}

function pullImage(dockerClient, image) {
  return new Promise((resolve, reject) => {
    dockerClient.pull(image, (err, stream) => {
      if (err) return reject(err);
      dockerClient.modem.followProgress(stream, err => err ? reject(err) : resolve());
    });
  });
}

async function executeDeployContainer(containerName, newImage) {
  if (CONTAINER_BLOCKLIST.has(containerName))
    throw new Error(`Container '${containerName}' is protected and cannot be replaced via deploy`);
  if (!newImage || !IMAGE_REF_RE.test(newImage) || newImage.length > 256)
    throw new Error("Invalid image reference — must match [registry/][namespace/]name[:tag][@digest] with no special characters");
  // Shared with /run's cooldown map (keyed there by container ID; here by
  // containerName — two namespaces in the same Map, same limitation already
  // documented in intelligence.js). Deploy/rollback recreate the container
  // entirely (stop+remove+create) — a double-click or two near-simultaneous
  // calls racing each other here is worse than a plain restart double-fire,
  // and this function had no cooldown protection at all across any of its
  // three callers (/deploy, /rollback, /requests/:id/approve's service.deploy).
  const lastTs = actionCooldowns.get(containerName) || 0;
  const elapsed = Date.now() - lastTs;
  if (elapsed < COOLDOWN_MS)
    throw new Error(`Cooldown active — wait ${Math.ceil((COOLDOWN_MS - elapsed) / 1000)}s before retrying`);
  actionCooldowns.set(containerName, Date.now());
  const container = docker.getContainer(containerName);
  const info = await container.inspect();
  const oldImage = info.Config.Image;

  // Pull new image first (fail fast before touching running container)
  await pullImage(docker, newImage);

  // Build network config for recreation
  const networkConfig = {};
  for (const [netName, netInfo] of Object.entries(info.NetworkSettings.Networks || {})) {
    networkConfig[netName] = { Aliases: netInfo.Aliases?.filter(a => a !== containerName) || [] };
  }

  // Stop and remove
  if (info.State.Running) await container.stop({ t: 15 }).catch(() => {});
  await container.remove({ force: true });

  // Re-create with new image, preserving core config
  const newContainer = await docker.createContainer({
    name: containerName,
    Image: newImage,
    Env: info.Config.Env,
    Labels: info.Config.Labels,
    ExposedPorts: info.Config.ExposedPorts,
    HostConfig: info.HostConfig,
    NetworkingConfig: { EndpointsConfig: networkConfig },
  });
  await newContainer.start();
  return { oldImage, newImage };
}

// ── Approval-aware /run v2 ────────────────────────────────────────────────────
// Updated /run with blast-radius pre-check and policy lookup
actionsRouter.post("/run/v2", requireRole("operator"), async (req, res) => {
  const { action, containerId, target, service_id, force } = req.body || {};
  const id = containerId || target;

  if (!action || !ALLOWED_ACTIONS.has(action))
    return res.status(400).json({ ok: false, error: `Unsupported action: ${action}` });
  if (!id)
    return res.status(400).json({ ok: false, error: "containerId required" });
  if (CONTAINER_BLOCKLIST.has(id)) {
    recordAudit(req, `container.${action}.blocked`, id, "failure", { reason: "blocklisted" });
    return res.status(403).json({ ok: false, error: `Container '${id}' cannot be controlled via this API` });
  }
  if (!CONTAINER_ALLOWLIST.has(id)) {
    recordAudit(req, `container.${action}.blocked`, id, "failure", { reason: "not in allowlist" });
    return res.status(403).json({ ok: false, error: `Container '${id}' is not in the approved action allowlist` });
  }

  const policy = await getPolicy(`container.${action}`);

  // Elevation check
  if (policy?.elevation_required && userRoleLevel(req) < requiredLevel(policy.elevation_required)) {
    return res.status(403).json({ ok: false, error: `Action requires ${policy.elevation_required} role or higher` });
  }

  // Blast-radius check
  if (policy?.blast_radius_check && service_id && !force) {
    const br = await blastRadiusCheck(service_id, req.session.user.tenant_id);
    if (br.hard > 0) {
      return res.status(409).json({
        ok: false,
        blast_radius: true,
        hard_deps: br.hard,
        affected: br.affected,
        error: `${br.hard} hard downstream dependenc${br.hard === 1 ? "y" : "ies"} will be affected. Pass force:true to proceed.`,
      });
    }
  }

  // Cooldown (in-memory — same as original /run)
  const cooldownMs = (policy?.cooldown_secs ?? 60) * 1000;
  const lastTs = actionCooldowns.get(id) || 0;
  const elapsed = Date.now() - lastTs;
  if (elapsed < cooldownMs) {
    const retryAfterMs = cooldownMs - elapsed;
    return res.status(429).json({ ok: false, error: `Cooldown active — wait ${Math.ceil(retryAfterMs / 1000)}s`, retryAfterMs });
  }
  actionCooldowns.set(id, Date.now());

  // Approval required → queue instead of execute
  if (policy?.requires_approval) {
    const { rows } = await getPool().query(
      `INSERT INTO action_requests (tenant_id, action_type, params, proposed_by)
       VALUES ($1, $2, $3, $4) RETURNING id`,
      [req.session.user.tenant_id, `container.${action}`, JSON.stringify({ containerId: id, service_id }), req.session?.user?.username || "unknown"]
    );
    recordAudit(req, `container.${action}.queued`, id, "success", { requestId: rows[0].id });
    return res.status(202).json({ ok: true, queued: true, requestId: rows[0].id, message: "Action queued for approval" });
  }

  // Execute directly
  try {
    const container = docker.getContainer(id);
    if (action === "start") await container.start();
    else if (action === "stop") await container.stop({ t: 10 });
    else if (action === "restart") await container.restart({ t: 10 });
    recordAudit(req, `container.${action}`, id, "success");
    res.json({ ok: true, action, containerId: id, ts: new Date().toISOString() });
  } catch (err) {
    recordAudit(req, `container.${action}`, id, "failure", { error: err.message });
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ── Action requests (approval workflow) ─────────────────────────────────────

// GET /api/actions/requests?status=pending
actionsRouter.get("/requests", requireRole("operator"), async (req, res) => {
  const status = req.query.status;
  const params = [req.session.user.tenant_id];
  let where = "tenant_id = $1";
  if (status) { params.push(status); where += ` AND status = $${params.length}`; }
  try {
    const { rows } = await getPool().query(
      `SELECT * FROM action_requests WHERE ${where} ORDER BY proposed_at DESC LIMIT 100`,
      params
    );
    res.json({ ok: true, requests: rows });
  } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});

// POST /api/actions/requests — operator proposes
actionsRouter.post("/requests", requireRole("operator"), async (req, res) => {
  const { action_type, service_id, params = {} } = req.body;
  if (!action_type) return res.status(400).json({ ok: false, error: "action_type required" });
  const ALLOWED_REQUEST_TYPES = new Set(["service.deploy", "container.restart", "container.stop"]);
  if (!ALLOWED_REQUEST_TYPES.has(action_type))
    return res.status(400).json({ ok: false, error: `Unknown action_type '${action_type}' — must be one of: ${[...ALLOWED_REQUEST_TYPES].join(", ")}` });

  if (action_type === "service.deploy") {
    const img = params.new_image;
    if (!img || !IMAGE_REF_RE.test(img) || img.length > 256)
      return res.status(400).json({ ok: false, error: "Invalid new_image — must match [registry/][namespace/]name[:tag][@digest] with no special characters" });
  }

  // Get service name if service_id provided
  let service_name = null;
  if (service_id) {
    const { rows } = await getPool().query("SELECT name FROM services WHERE id = $1 AND tenant_id = $2", [service_id, req.session.user.tenant_id]);
    service_name = rows[0]?.name || null;
  }

  // Blast-radius check (informational — stored in params, not blocking here)
  const br = service_id ? await blastRadiusCheck(service_id, req.session.user.tenant_id) : { count: 0, hard: 0, affected: [] };

  try {
    const { rows } = await getPool().query(
      `INSERT INTO action_requests (tenant_id, service_id, service_name, action_type, params, proposed_by)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
      [req.session.user.tenant_id, service_id || null, service_name, action_type,
       JSON.stringify({ ...params, blast_radius: br }), req.session?.user?.username || "unknown"]
    );
    recordAudit(req, "action.request.propose", action_type, "success", { id: rows[0].id });
    res.status(201).json({ ok: true, request: rows[0], blast_radius: br });
  } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});

// POST /api/actions/requests/:id/approve — admin executes the action
actionsRouter.post("/requests/:id/approve", requireRole("admin"), async (req, res) => {
  const db = getPool();
  const { rows } = await db.query(
    "SELECT * FROM action_requests WHERE id = $1 AND tenant_id = $2",
    [req.params.id, req.session.user.tenant_id]
  );
  const actionReq = rows[0];
  if (!actionReq) return res.status(404).json({ ok: false, error: "Request not found" });
  if (actionReq.status !== "pending")
    return res.status(409).json({ ok: false, error: `Request is ${actionReq.status}, not pending` });
  if (new Date(actionReq.expires_at) < new Date())
    return res.status(410).json({ ok: false, error: "Request expired" });

  const approver = req.session?.user?.username || "unknown";
  if (actionReq.proposed_by === approver)
    return res.status(403).json({ ok: false, error: "Cannot approve your own action request — dual-control requires a different approver" });

  // Mark approved
  await db.query(
    `UPDATE action_requests SET status='approved', reviewed_by=$1, reviewed_at=NOW(), review_note=$2 WHERE id=$3`,
    [req.session?.user?.username || "unknown", req.body.note || null, req.params.id]
  );

  // Execute the action
  let result = null;
  let finalStatus = "executed";
  try {
    const p = actionReq.params || {};

    if (actionReq.action_type === "service.deploy") {
      const { container_name, new_image } = p;
      const { oldImage, newImage } = await executeDeployContainer(container_name, new_image);
      result = { oldImage, newImage };
      await db.query(
        `INSERT INTO deploy_rollback_points (tenant_id, service_id, container_name, previous_image, deployed_image, deployed_by)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [req.session.user.tenant_id, actionReq.service_id, container_name, oldImage, newImage, req.session?.user?.username || "unknown"]
      );
      recordChange(req.session.user.tenant_id, actionReq.service_id, actionReq.service_name, "service_deployed",
        req.session?.user?.username || "unknown",
        `Deployed '${container_name}' → ${newImage} (was ${oldImage})`);

    } else if (actionReq.action_type === "container.restart") {
      await docker.getContainer(p.containerId).restart({ t: 10 });
      result = { containerId: p.containerId };

    } else if (actionReq.action_type === "container.stop") {
      await docker.getContainer(p.containerId).stop({ t: 10 });
      result = { containerId: p.containerId };

    } else {
      result = { message: "No executor registered for this action_type" };
    }

    recordAudit(req, `action.${actionReq.action_type}.executed`, actionReq.service_name || actionReq.action_type, "success");
  } catch (err) {
    finalStatus = "failed";
    result = { error: err.message };
    recordAudit(req, `action.${actionReq.action_type}.failed`, actionReq.action_type, "failure", { error: err.message });
  }

  await db.query(
    `UPDATE action_requests SET status=$1, executed_at=NOW(), result=$2 WHERE id=$3`,
    [finalStatus, JSON.stringify(result), req.params.id]
  );

  res.json({ ok: finalStatus === "executed", status: finalStatus, result });
});

// POST /api/actions/requests/:id/reject — admin rejects
actionsRouter.post("/requests/:id/reject", requireRole("admin"), async (req, res) => {
  const { rows } = await getPool().query(
    "SELECT * FROM action_requests WHERE id = $1 AND tenant_id = $2",
    [req.params.id, req.session.user.tenant_id]
  );
  if (!rows[0]) return res.status(404).json({ ok: false, error: "Request not found" });
  if (rows[0].status !== "pending")
    return res.status(409).json({ ok: false, error: `Request is ${rows[0].status}, not pending` });
  await getPool().query(
    `UPDATE action_requests SET status='rejected', reviewed_by=$1, reviewed_at=NOW(), review_note=$2 WHERE id=$3`,
    [req.session?.user?.username || "unknown", req.body.reason || null, req.params.id]
  );
  recordAudit(req, "action.request.reject", rows[0].action_type, "success", { id: req.params.id });
  res.json({ ok: true, status: "rejected" });
});

// POST /api/actions/deploy — direct deploy (admin only, still checks blast-radius)
actionsRouter.post("/deploy", requireRole("admin"), async (req, res) => {
  const { service_id, container_name, new_image, force } = req.body;
  if (!container_name || !new_image)
    return res.status(400).json({ ok: false, error: "container_name and new_image required" });

  // Blast-radius check
  if (service_id && !force) {
    const br = await blastRadiusCheck(service_id, req.session.user.tenant_id);
    if (br.hard > 0) {
      return res.status(409).json({
        ok: false, blast_radius: true, hard_deps: br.hard, affected: br.affected,
        error: `${br.hard} hard downstream dependenc${br.hard === 1 ? "y" : "ies"} affected. Pass force:true to proceed.`,
      });
    }
  }

  // Fetch service name
  let service_name = null;
  if (service_id) {
    const { rows } = await getPool().query("SELECT name FROM services WHERE id = $1 AND tenant_id = $2", [service_id, req.session.user.tenant_id]);
    service_name = rows[0]?.name;
  }

  try {
    const { oldImage, newImage } = await executeDeployContainer(container_name, new_image);
    await getPool().query(
      `INSERT INTO deploy_rollback_points (tenant_id, service_id, container_name, previous_image, deployed_image, deployed_by)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [req.session.user.tenant_id, service_id || null, container_name, oldImage, newImage, req.session?.user?.username || "unknown"]
    );
    recordAudit(req, "service.deploy", container_name, "success", { oldImage, newImage });
    recordChange(req.session.user.tenant_id, service_id, service_name, "service_deployed",
      req.session?.user?.username || "unknown",
      `Deployed '${container_name}' → ${newImage} (was: ${oldImage})`);
    res.json({ ok: true, oldImage, newImage, container: container_name });
  } catch (err) {
    recordAudit(req, "service.deploy", container_name, "failure", { error: err.message });
    res.status(500).json({ ok: false, error: err.message });
  }
});

// POST /api/actions/rollback — restore previous image (admin only)
actionsRouter.post("/rollback", requireRole("admin"), async (req, res) => {
  const { service_id, container_name, rollback_point_id, force } = req.body;
  if (!container_name) return res.status(400).json({ ok: false, error: "container_name required" });

  // Find rollback point
  const pointQuery = rollback_point_id
    ? "SELECT * FROM deploy_rollback_points WHERE id = $1 AND container_name = $2 AND tenant_id = $3"
    : "SELECT * FROM deploy_rollback_points WHERE container_name = $1 AND tenant_id = $2 ORDER BY created_at DESC LIMIT 1";
  const pointParams = rollback_point_id
    ? [rollback_point_id, container_name, req.session.user.tenant_id]
    : [container_name, req.session.user.tenant_id];
  const { rows: points } = await getPool().query(pointQuery, pointParams);
  if (!points[0]) return res.status(404).json({ ok: false, error: "No rollback point found for this container" });
  const point = points[0];

  // Blast-radius check
  const svcId = service_id || point.service_id;
  if (svcId && !force) {
    const br = await blastRadiusCheck(svcId, req.session.user.tenant_id);
    if (br.hard > 0) {
      return res.status(409).json({
        ok: false, blast_radius: true, hard_deps: br.hard, affected: br.affected,
        error: `${br.hard} hard downstream dependenc${br.hard === 1 ? "y" : "ies"} affected. Pass force:true to proceed.`,
      });
    }
  }

  try {
    const { oldImage, newImage } = await executeDeployContainer(container_name, point.previous_image);
    recordAudit(req, "service.rollback", container_name, "success", { restoredImage: point.previous_image });
    recordChange(req.session.user.tenant_id, svcId, null, "service_rolled_back",
      req.session?.user?.username || "unknown",
      `Rolled back '${container_name}' → ${point.previous_image}`);
    res.json({ ok: true, restoredImage: point.previous_image, container: container_name });
  } catch (err) {
    recordAudit(req, "service.rollback", container_name, "failure", { error: err.message });
    res.status(500).json({ ok: false, error: err.message });
  }
});

// GET /api/actions/rollback-points/:container_name — list rollback points
actionsRouter.get("/rollback-points/:container", requireRole("admin"), async (req, res) => {
  try {
    const { rows } = await getPool().query(
      `SELECT * FROM deploy_rollback_points
       WHERE container_name = $1 AND tenant_id = $2
       ORDER BY created_at DESC LIMIT 10`,
      [req.params.container, req.session.user.tenant_id]
    );
    res.json({ ok: true, points: rows });
  } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});

// GET /api/actions/policies — list action policies
actionsRouter.get("/policies", requireRole("admin"), async (_req, res) => {
  try {
    const { rows } = await getPool().query(
      "SELECT * FROM action_policies ORDER BY action_type"
    );
    res.json({ ok: true, policies: rows });
  } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});
