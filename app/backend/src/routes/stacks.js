import { Router } from "express";
import Docker from "dockerode";
import { requireRole } from "../middleware/requireRole.js";

export const stacksRouter = Router();

const docker = new Docker({ socketPath: "/var/run/docker.sock" });

function formatContainer(c) {
  const labels = c.Labels || {};
  return {
    id: c.Id.slice(0, 12),
    fullId: c.Id,
    name: (c.Names?.[0] || "").replace(/^\//, ""),
    image: c.Image,
    status: c.Status,
    state: c.State,
    created: c.Created,
    ports: (c.Ports || [])
      .filter((p) => p.PublicPort)
      .map((p) => `${p.IP || "0.0.0.0"}:${p.PublicPort}->${p.PrivatePort}/${p.Type || "tcp"}`),
    project: labels["com.docker.compose.project"] || null,
    service: labels["com.docker.compose.service"] || null,
    composeFile: labels["com.docker.compose.project.config_files"] || null,
  };
}

// GET /api/stacks — all containers grouped by compose project
stacksRouter.get("/", requireRole("viewer"), async (_req, res) => {
  try {
    const raw = await docker.listContainers({ all: true });
    const containers = raw.map(formatContainer);

    const projectMap = {};
    for (const c of containers) {
      const key = c.project || "__standalone__";
      if (!projectMap[key]) projectMap[key] = { project: key, containers: [] };
      projectMap[key].containers.push(c);
    }

    const projects = Object.values(projectMap).map((p) => ({
      ...p,
      state: p.containers.every((c) => c.state === "running")
        ? "running"
        : p.containers.some((c) => c.state === "running")
        ? "partial"
        : "stopped",
    }));

    res.json({ projects, total: containers.length });
  } catch (err) {
    console.error("Docker listContainers failed:", err.message);
    res.status(500).json({ error: "Docker unavailable", detail: err.message });
  }
});

// GET /api/stacks/:id — single container inspect summary
stacksRouter.get("/:id", requireRole("viewer"), async (req, res) => {
  try {
    const container = docker.getContainer(req.params.id);
    const info = await container.inspect();

    const publishedPorts = [];
    for (const [key, bindings] of Object.entries(info.NetworkSettings?.Ports || {})) {
      if (bindings) {
        for (const b of bindings) {
          publishedPorts.push(`${b.HostIp || "0.0.0.0"}:${b.HostPort} -> ${key}`);
        }
      }
    }

    res.json({
      id: info.Id.slice(0, 12),
      name: info.Name.replace(/^\//, ""),
      image: info.Config?.Image,
      state: {
        status: info.State?.Status,
        running: info.State?.Running,
        paused: info.State?.Paused,
        restarting: info.State?.Restarting,
        health: info.State?.Health?.Status || null,
        startedAt: info.State?.StartedAt,
        finishedAt: info.State?.FinishedAt,
        exitCode: info.State?.ExitCode,
      },
      created: info.Created,
      restartPolicy: {
        name: info.HostConfig?.RestartPolicy?.Name || "no",
        maxRetry: info.HostConfig?.RestartPolicy?.MaximumRetryCount || 0,
      },
      // src (host path) omitted — would expose secret file locations on the host
      mounts: (info.Mounts || []).map((m) => ({
        type: m.Type,
        dst: m.Destination,
        mode: m.Mode,
        hostMounted: m.Type === "bind",
      })),
      mountCount: (info.Mounts || []).length,
      networks: Object.keys(info.NetworkSettings?.Networks || {}),
      publishedPorts,
      labels: info.Config?.Labels || {},
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/stacks/:id/logs — last N lines (operator+ only — logs may contain credentials/tokens)
stacksRouter.get("/:id/logs", requireRole("operator"), async (req, res) => {
  const tail = Math.min(Number(req.query.tail) || 100, 500);
  try {
    const container = docker.getContainer(req.params.id);
    const stream = await container.logs({ stdout: true, stderr: true, tail, timestamps: true });
    const lines = [];
    let buf = Buffer.isBuffer(stream) ? stream : Buffer.from(stream);
    let offset = 0;
    while (offset + 8 <= buf.length) {
      const size = buf.readUInt32BE(offset + 4);
      if (offset + 8 + size > buf.length) break;
      lines.push(buf.slice(offset + 8, offset + 8 + size).toString("utf8").trimEnd());
      offset += 8 + size;
    }
    res.json({ id: req.params.id, tail, lines });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});
