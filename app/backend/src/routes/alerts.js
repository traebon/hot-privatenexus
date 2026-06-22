import { Router } from "express";

export const alertsRouter = Router();

const PROMETHEUS_URL = process.env.PROMETHEUS_URL || "http://10.10.50.104:9090";

async function promInstant(query) {
  const url = `${PROMETHEUS_URL}/api/v1/query?query=${encodeURIComponent(query)}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Prometheus ${res.status}`);
  const json = await res.json();
  return json.data?.result || [];
}

async function buildAlerts() {
  const [ruleAlerts, probeResults, nodeResults] = await Promise.all([
    promInstant('ALERTS{alertstate="firing"}'),
    promInstant('probe_success{job="blackbox-https"}'),
    promInstant('up{job=~".*-node"}'),
  ]);

  const alerts = [];

  for (const r of ruleAlerts) {
    alerts.push({
      id: `rule:${r.metric.alertname}:${r.metric.instance || ""}`,
      name: r.metric.alertname,
      instance: r.metric.instance || r.metric.job || "",
      level: r.metric.severity || "warning",
      message: `${r.metric.alertname} firing`,
      source: "prometheus-rule",
    });
  }

  for (const r of probeResults) {
    if (r.value[1] === "0") {
      const instance = r.metric.instance || r.metric.target || "";
      alerts.push({
        id: `probe:${instance}`,
        name: "Probe failed",
        instance,
        level: "critical",
        message: `${instance} is unreachable`,
        source: "blackbox",
      });
    }
  }

  for (const r of nodeResults) {
    if (r.value[1] === "0") {
      const instance = r.metric.instance || r.metric.job || "";
      alerts.push({
        id: `node:${instance}`,
        name: "Node down",
        instance,
        level: "critical",
        message: `${instance} node exporter unreachable`,
        source: "node-exporter",
      });
    }
  }

  return alerts;
}

alertsRouter.get("/", async (_req, res) => {
  try {
    res.json(await buildAlerts());
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

alertsRouter.get("/stream", (req, res) => {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders();

  const send = async () => {
    try {
      const alerts = await buildAlerts();
      res.write(`data: ${JSON.stringify(alerts)}\n\n`);
    } catch {
      res.write(`data: ${JSON.stringify([])}\n\n`);
    }
  };

  send();
  const interval = setInterval(send, 30000);
  req.on("close", () => clearInterval(interval));
});
