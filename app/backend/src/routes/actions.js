import { Router } from "express";
import Docker from "dockerode";

export const actionsRouter = Router();

const docker = new Docker({ socketPath: "/var/run/docker.sock" });

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

    res.json({ ok: true, mode: "docker", action, containerId: id, ts: new Date().toISOString() });
  } catch (err) {
    console.error(`Failed to ${action} container ${id}:`, err.message);
    res.status(500).json({ ok: false, error: `Failed to ${action} container`, detail: err.message });
  }
});
