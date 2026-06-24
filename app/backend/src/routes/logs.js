import { Router } from "express";
import { requireRole } from "../middleware/requireRole.js";

export const logsRouter = Router();

const LOKI_URL = process.env.LOKI_URL || "http://10.10.50.104:3100";

const RANGE_SECONDS = { "15m": 15 * 60, "1h": 3600, "6h": 6 * 3600, "24h": 24 * 3600 };
const LEVEL_FILTERS = {
  error: '|~ "(?i)\\b(error|err|fatal|panic|crit|emerg)\\b"',
  warn:  '|~ "(?i)\\b(warn|warning)\\b"',
  info:  '|~ "(?i)\\b(info|notice)\\b"',
};

async function lokiFetch(path, signal) {
  const r = await fetch(`${LOKI_URL}${path}`, { signal });
  if (!r.ok) throw new Error(`Loki ${r.status}`);
  return r.json();
}

// GET /api/logs/sources — label values for source pickers
logsRouter.get("/sources", requireRole("viewer"), async (_req, res) => {
  try {
    const [hostsJson, containersJson] = await Promise.all([
      lokiFetch("/loki/api/v1/label/host/values",      AbortSignal.timeout(5000)),
      lokiFetch("/loki/api/v1/label/container/values", AbortSignal.timeout(5000)),
    ]);
    res.json({
      ok:         true,
      hosts:      (hostsJson.data || []).sort(),
      containers: (containersJson.data || []).map((c) => c.replace(/^\//, "")).sort(),
    });
  } catch (err) {
    res.status(502).json({ ok: false, error: err.message });
  }
});

// GET /api/logs/query — flexible log query
logsRouter.get("/query", requireRole("viewer"), async (req, res) => {
  const { type = "syslog", source, range = "1h", search = "", level = "all", limit = "200" } = req.query;
  const limitN       = Math.min(parseInt(limit) || 200, 500);
  const rangeSeconds = RANGE_SECONDS[range] || 3600;

  const end   = BigInt(Date.now()) * 1_000_000n;
  const start = end - BigInt(rangeSeconds) * 1_000_000_000n;

  if (!source) return res.status(400).json({ ok: false, error: "source is required" });

  // Sanitize source: only allow hostname/container-name chars to prevent LogQL injection
  if (!/^[a-zA-Z0-9._-]+$/.test(source)) {
    return res.status(400).json({ ok: false, error: "invalid source" });
  }

  const selector = type === "container"
    ? `{container="/${source}"}`
    : `{job="syslog", host="${source}"}`;

  let query = selector;
  if (level !== "all" && LEVEL_FILTERS[level]) query += ` ${LEVEL_FILTERS[level]}`;
  if (search.trim()) query += ` |= ${JSON.stringify(search.trim())}`;

  try {
    const params = new URLSearchParams({
      query,
      limit:     String(limitN),
      start:     String(start),
      end:       String(end),
      direction: "backward",
    });
    const json = await lokiFetch(`/loki/api/v1/query_range?${params}`, AbortSignal.timeout(10000));

    const lines = [];
    for (const stream of json.data?.result || []) {
      for (const [ts, line] of stream.values || []) {
        lines.push({ ts, line });
      }
    }
    lines.sort((a, b) => (b.ts > a.ts ? 1 : -1));

    res.json({ ok: true, lines: lines.slice(0, limitN), ts: new Date().toISOString() });
  } catch (err) {
    res.status(502).json({ ok: false, error: err.message });
  }
});

// Legacy: GET /api/logs/:container — used by Stacks drawer
logsRouter.get("/:container", async (req, res) => {
  const rawName = req.params.container.replace(/^\//, "");
  if (!/^[a-zA-Z0-9._-]+$/.test(rawName)) {
    return res.status(400).json({ error: "invalid container name" });
  }
  const container = `/${rawName}`;
  const end   = Date.now() * 1_000_000;
  const start = end - 3_600_000_000_000;

  try {
    const params = new URLSearchParams({
      query:     `{container="${container}"}`,
      limit:     "150",
      start:     String(start),
      end:       String(end),
      direction: "backward",
    });
    const response = await fetch(`${LOKI_URL}/loki/api/v1/query_range?${params}`);
    if (!response.ok) throw new Error(`Loki ${response.status}`);
    const json = await response.json();

    const lines = [];
    for (const stream of json.data?.result || []) {
      for (const [ts, line] of stream.values || []) {
        lines.push({ ts, line });
      }
    }
    lines.sort((a, b) => (b.ts > a.ts ? 1 : -1));
    res.json(lines.slice(0, 150));
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});
