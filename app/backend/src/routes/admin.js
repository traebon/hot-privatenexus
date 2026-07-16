import { Router } from "express";
import os from "os";
import { execSync } from "child_process";
import { getPool } from "../db.js";
import { requireRole } from "../middleware/requireRole.js";
import { recordAudit } from "../auditLog.js";
import { getDocker } from "../dockerClient.js";

export const adminRouter = Router();

const docker = getDocker();

// GET /api/admin/backup — static reference info matching the real, documented
// backup architecture (main infra CLAUDE.md, "Backup Architecture" section) —
// not live state, this box has no way to check job status on the Gateway/
// Proxmox host that actually runs these.
adminRouter.get("/backup", requireRole("viewer"), (_req, res) => {
  res.json({
    schedule:    "01:00 config sync → 02:00 vzdump (~3h) → 03:00 pn-vps DB dump → 03:30 Gateway pull → 06:00 Hetzner → 07:30 B2",
    destination: "Hetzner Storage Box + Backblaze B2 (both rclone crypt)",
    lastRun:     "—",
    nextRun:     "01:00 UTC",
    tiers: [
      { name: "VM Snapshots",           tool: "vzdump (Proxmox)",                              schedule: "02:00 daily",                         dest: "/var/lib/vz/dump (ZFS)" },
      { name: "Config Sync",            tool: "git + cron",                                    schedule: "01:00 daily",                         dest: "Forgejo → Codeberg + GitHub" },
      { name: "Cloud (Hetzner)",        tool: "rclone crypt",                                  schedule: "06:00 daily",                         dest: "Hetzner Storage Box" },
      { name: "Cloud (B2)",             tool: "rclone crypt",                                  schedule: "07:30 daily",                         dest: "Backblaze B2" },
      { name: "pn-vps PrivateNexus DB", tool: "pg_dump + Gateway pull + rclone crypt",         schedule: "03:00 dump → 03:30 Gateway pull", dest: "pn-vps (14d) → Gateway (30d) → Hetzner + B2" },
    ],
  });
});

// POST /api/admin/backup/run — acknowledge trigger (actual backup runs on gateway/proxmox)
adminRouter.post("/backup/run", requireRole("admin"), (req, res) => {
  recordAudit(req, "backup.run", null, "success");
  res.json({ ok: true, message: "Backup trigger acknowledged — backup jobs run on the gateway and Proxmox host.", ts: new Date().toISOString() });
});

// GET /api/admin/network — real network interfaces via Node os module + Docker networks
adminRouter.get("/network", requireRole("operator"), async (_req, res) => {
  try {
    const ifaces = os.networkInterfaces();
    const interfaces = Object.entries(ifaces).map(([name, addrs]) => ({
      name,
      addresses: (addrs || []).map((a) => ({ address: a.address, family: a.family, internal: a.internal })),
    }));

    let networks = [];
    try {
      const dockerNets = await docker.listNetworks();
      networks = dockerNets.map((n) => ({
        name:   n.Name,
        driver: n.Driver,
        scope:  n.Scope,
        subnet: n.IPAM?.Config?.[0]?.Subnet || "—",
      }));
    } catch {}

    res.json({ ok: true, interfaces, networks, ts: new Date().toISOString() });
  } catch (err) {
    console.error("[admin] error:", err.message);
    res.status(500).json({ ok: false, error: "Service unavailable" });
  }
});

// GET /api/admin/certs — TLS cert expiry from Prometheus Blackbox Exporter
adminRouter.get("/certs", requireRole("operator"), async (_req, res) => {
  try {
    const promUrl = process.env.PROMETHEUS_URL || "http://10.10.50.104:9090";
    const url = `${promUrl}/api/v1/query?query=probe_ssl_earliest_cert_expiry`;
    const r = await fetch(url, { signal: AbortSignal.timeout(5000) });
    const data = await r.json();
    const now = Date.now() / 1000;
    const certs = (data.data?.result || []).map((s) => {
      const expiry   = parseFloat(s.value[1]);
      const daysLeft = Math.floor((expiry - now) / 86400);
      return {
        instance: s.metric.instance,
        job:      s.metric.job || "—",
        expiry:   new Date(expiry * 1000).toISOString(),
        daysLeft,
        status:   daysLeft < 7 ? "critical" : daysLeft < 14 ? "warning" : "ok",
      };
    }).sort((a, b) => a.daysLeft - b.daysLeft);
    res.json({ ok: true, certs, ts: new Date().toISOString() });
  } catch (err) {
    console.error("[admin] error:", err.message);
    res.status(500).json({ ok: false, error: "Service unavailable" });
  }
});

// GET /api/admin/disk — real disk usage + Docker volume info
adminRouter.get("/disk", requireRole("operator"), async (_req, res) => {
  try {
    const dfRaw = execSync("df -Pk 2>/dev/null", { encoding: "utf8" }).trim().split("\n").slice(1);
    const mounts = dfRaw.map((line) => {
      const parts = line.trim().split(/\s+/);
      return {
        fs:    parts[0],
        total: parseInt(parts[1]) || 0,
        used:  parseInt(parts[2]) || 0,
        avail: parseInt(parts[3]) || 0,
        pct:   parseInt((parts[4] || "0").replace("%", "")) || 0,
        mount: parts[5],
      };
    }).filter((m) =>
      !m.fs.startsWith("shm") &&
      !m.fs.startsWith("tmpfs") &&
      !m.mount.startsWith("/dev") &&
      !m.mount.startsWith("/etc/") &&
      !m.mount.startsWith("/run/") &&
      !m.mount.startsWith("/sys/") &&
      !m.mount.startsWith("/proc/") &&
      m.total > 100000
    ).reduce((acc, m) => {
      if (!acc.some((x) => x.fs === m.fs)) acc.push(m);
      return acc;
    }, []);

    let dockerVolumes = [];
    try {
      const vols = await docker.listVolumes();
      dockerVolumes = (vols.Volumes || []).map((v) => ({ name: v.Name, driver: v.Driver, mountpoint: v.Mountpoint }));
    } catch {}

    res.json({ ok: true, mounts, dockerVolumes, ts: new Date().toISOString() });
  } catch (err) {
    console.error("[admin] error:", err.message);
    res.status(500).json({ ok: false, error: "Service unavailable" });
  }
});

// GET /api/admin/users — activity summary from audit log
adminRouter.get("/users", requireRole("admin"), async (_req, res) => {
  try {
    const { rows } = await getPool().query(`
      SELECT
        username,
        role,
        MAX(ts)   AS last_seen,
        COUNT(*)::int  AS action_count,
        COUNT(CASE WHEN outcome = 'failure' THEN 1 END)::int AS failures
      FROM audit_log
      GROUP BY username, role
      ORDER BY last_seen DESC
      LIMIT 100
    `);
    res.json({ ok: true, users: rows });
  } catch (err) {
    console.error("[admin] error:", err.message);
    res.status(500).json({ ok: false, error: "Service unavailable" });
  }
});

// GET /api/admin/audit?limit=100&offset=0&username=x&action=y
adminRouter.get("/audit", requireRole("operator"), async (req, res) => {
  try {
    const limit  = Math.min(parseInt(req.query.limit)  || 100, 500);
    const offset = Math.max(parseInt(req.query.offset) || 0,   0);
    const conditions = [];
    const params = [];

    if (req.query.username) { params.push(req.query.username); conditions.push(`username = $${params.length}`); }
    if (req.query.action)   { params.push(req.query.action);   conditions.push(`action = $${params.length}`);   }
    if (req.query.outcome)  { params.push(req.query.outcome);  conditions.push(`outcome = $${params.length}`);  }

    const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
    params.push(limit, offset);

    const { rows } = await getPool().query(
      `SELECT id, ts, username, role, action, target, outcome, detail, ip
       FROM audit_log ${where}
       ORDER BY ts DESC
       LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params
    );
    res.json(rows);
  } catch (err) {
    console.error("[admin] error:", err.message);
    res.status(500).json({ error: "Service unavailable" });
  }
});

// GET /api/admin/users-manage — all known users (from audit log) with roles + sub IDs
adminRouter.get("/users-manage", requireRole("admin"), async (_req, res) => {
  try {
    const { rows } = await getPool().query(`
      WITH user_stats AS (
        SELECT user_sub,
          COUNT(*)::int AS action_count,
          COUNT(CASE WHEN outcome = 'failure' THEN 1 END)::int AS failures,
          MAX(ts) AS last_seen
        FROM audit_log
        GROUP BY user_sub
      ),
      latest_role AS (
        SELECT DISTINCT ON (user_sub) user_sub, username, role
        FROM audit_log
        ORDER BY user_sub, ts DESC
      )
      SELECT lr.user_sub, lr.username, lr.role,
             us.last_seen, us.action_count, us.failures
      FROM latest_role lr
      JOIN user_stats us ON us.user_sub = lr.user_sub
      ORDER BY us.last_seen DESC
    `);
    res.json({ ok: true, users: rows, ts: new Date().toISOString() });
  } catch (err) {
    console.error("[admin] error:", err.message);
    res.status(500).json({ ok: false, error: "Service unavailable" });
  }
});
