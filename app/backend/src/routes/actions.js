import { Router } from "express";
import Docker from "dockerode";

export const actionsRouter = Router();

const docker = new Docker({ socketPath: "/var/run/docker.sock" });

const ALLOWED_ACTIONS = new Set(["start", "stop", "restart"]);

// POST /api/actions/run — { action, target }
// action: "start" | "stop" | "restart"
// target: container id or name
actionsRouter.post("/run", async (req, res) => {
  const { action, target } = req.body || {};

  if (!action || !ALLOWED_ACTIONS.has(action)) {
    return res.status(400).json({ error: `Invalid action. Allowed: ${[...ALLOWED_ACTIONS].join(", ")}` });
  }
  if (!target) {
    return res.status(400).json({ error: "Missing target (container id or name)" });
  }

  try {
    const container = docker.getContainer(target);
    if (action === "start") await container.start();
    else if (action === "stop") await container.stop({ t: 10 });
    else if (action === "restart") await container.restart({ t: 10 });

    res.json({ ok: true, action, target, ts: new Date().toISOString() });
  } catch (err) {
    console.error(`Action ${action} on ${target} failed:`, err.message);
    res.status(500).json({ ok: false, error: err.message, action, target });
  }
});
