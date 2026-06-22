import { Router } from "express";
import { requireRole } from "../middleware/requireRole.js";

export const opsRouter = Router();

const VM_NAMES = {
  "10.10.10.100": "sn-infra",
  "10.10.20.101": "sn-business",
  "10.10.30.102": "sn-web",
  "10.10.40.103": "sn-personal",
  "10.10.50.104": "sn-monitor",
  "10.10.60.105": "pn-test",
  "10.10.70.106": "sn-security",
};

async function promQuery(promUrl, q) {
  const r = await fetch(`${promUrl}/api/v1/query?query=${encodeURIComponent(q)}`, {
    signal: AbortSignal.timeout(5000),
  });
  const data = await r.json();
  return data.data?.result || [];
}

// GET /api/ops/vms — per-VM metrics from Prometheus node-exporter
opsRouter.get("/vms", requireRole("viewer"), async (_req, res) => {
  const promUrl = process.env.PROMETHEUS_URL || "http://10.10.50.104:9090";

  try {
    const [cpuRes, ramRes, diskRes, loadRes, uptimeRes] = await Promise.all([
      promQuery(promUrl, '100 - (avg by(instance) (irate(node_cpu_seconds_total{mode="idle"}[5m])) * 100)'),
      promQuery(promUrl, "(1 - (node_memory_MemAvailable_bytes / node_memory_MemTotal_bytes)) * 100"),
      promQuery(promUrl, '(1 - (node_filesystem_avail_bytes{mountpoint="/",fstype!="tmpfs"} / node_filesystem_size_bytes{mountpoint="/",fstype!="tmpfs"})) * 100'),
      promQuery(promUrl, "node_load1"),
      promQuery(promUrl, "node_time_seconds - node_boot_time_seconds"),
    ]);

    const vms = {};
    const get = (instance) => {
      const ip = instance.split(":")[0];
      if (!vms[ip]) vms[ip] = { instance, ip, name: VM_NAMES[ip] || ip, cpu: null, ram: null, disk: null, load1: null, uptimeSeconds: null };
      return vms[ip];
    };

    for (const r of cpuRes)    get(r.metric.instance).cpu           = Math.round(parseFloat(r.value[1]));
    for (const r of ramRes)    get(r.metric.instance).ram           = Math.round(parseFloat(r.value[1]));
    for (const r of diskRes)   get(r.metric.instance).disk          = Math.round(parseFloat(r.value[1]));
    for (const r of loadRes)   get(r.metric.instance).load1         = parseFloat(r.value[1]).toFixed(2);
    for (const r of uptimeRes) get(r.metric.instance).uptimeSeconds = Math.round(parseFloat(r.value[1]));

    const sorted = Object.values(vms).sort((a, b) => a.name.localeCompare(b.name));
    res.json({ ok: true, vms: sorted, ts: new Date().toISOString() });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});
