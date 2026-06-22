import { Router } from "express";
import Docker from "dockerode";
import os from "os";
import { execSync } from "child_process";
import { existsSync, readFileSync, writeFileSync, rmSync } from "fs";
import { recordAudit } from "../auditLog.js";
import { requireRole } from "../middleware/requireRole.js";

export const actionsRouter = Router();

const docker = new Docker({ socketPath: "/var/run/docker.sock" });

const MAINTENANCE_FILE = "/tmp/pn-maintenance.json";

const ALLOWED_ACTIONS = new Set(["start", "stop", "restart"]);

// POST /api/actions/run — { action, containerId } (also accepts target for compat)
// action: "start" | "stop" | "restart"
// containerId: container id or name
actionsRouter.post("/run", async (req, res) => {
  const { action, containerId, target } = req.body || {};
  const id = containerId || target;

  if (!action || !ALLOWED_ACTIONS.has(action)) {
    return res.status(400).json({ ok: false, error: `Unsupported action: ${action}` });
  }
  if (!id) {
    return res.status(400).json({ ok: false, error: "action and containerId are required" });
  }

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

  try {
    if (action === "stacks.stop-all") {
      const list = await docker.listContainers({ all: false });
      const results = [];
      for (const c of list) {
        const name = (c.Names?.[0] || "").replace(/^\//, "");
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
      const state = { enabled: true, since: new Date().toISOString(), reason: reason || null };
      writeFileSync(MAINTENANCE_FILE, JSON.stringify(state));
      recordAudit(req, "emergency.maintenance.enable", null, "success");
      return res.json({ ok: true, action, maintenanceMode: state });
    }

    if (action === "maintenance.disable") {
      if (existsSync(MAINTENANCE_FILE)) rmSync(MAINTENANCE_FILE);
      recordAudit(req, "emergency.maintenance.disable", null, "success");
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
