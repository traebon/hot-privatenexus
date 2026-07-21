import net from "node:net";
import { getPool } from "./db.js";

const PROBE_TIMEOUT_MS = Number(process.env.HEALTH_PROBE_TIMEOUT_MS || 8000);

// TCP probe: opens a connection to host:port, closes it immediately on success.
// health_endpoint format: tcp://host:port
function probeTcp(host, port, timeoutMs) {
  return new Promise((resolve) => {
    const start = Date.now();
    const socket = new net.Socket();
    let settled = false;

    const finish = (status, error = null) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve({ status, latencyMs: Date.now() - start, error });
    };

    socket.setTimeout(timeoutMs);
    socket.connect(port, host, () => finish("healthy"));
    socket.on("timeout", () => finish("down", "timeout"));
    socket.on("error",   (err) => finish("down", err.message));
  });
}

/**
 * Probes all non-archived services that have a health_endpoint, across every
 * tenant — this runs on a background timer (healthScheduler.js), not inside
 * a request, so there is no session to scope a single tenant from.
 * Supports http://, https://, and tcp://host:port endpoints.
 * Updates services.status and writes one health_events row per service.
 * Returns the results array.
 *
 * @param {"scheduler"|"manual"} source — recorded in health_events.source
 */
export async function probeAllServices(source = "scheduler") {
  const pool = getPool();

  const { rows: services } = await pool.query(
    `SELECT id, tenant_id, slug, health_endpoint FROM services
     WHERE health_endpoint IS NOT NULL AND archived = FALSE`
  );

  if (!services.length) return [];

  const probeOne = async (svc) => {
    const start = Date.now();

    // TCP probe branch
    if (svc.health_endpoint.startsWith("tcp://")) {
      try {
        const url  = new URL(svc.health_endpoint);
        const host = url.hostname;
        const port = Number(url.port);
        if (!host || !port) throw new Error("invalid tcp:// endpoint — must be tcp://host:port");
        const { status, latencyMs, error } = await probeTcp(host, port, PROBE_TIMEOUT_MS);
        return { id: svc.id, tenantId: svc.tenant_id, slug: svc.slug, status, statusCode: null, latencyMs, error };
      } catch (err) {
        return { id: svc.id, tenantId: svc.tenant_id, slug: svc.slug, status: "down", statusCode: null, latencyMs: Date.now() - start, error: err.message };
      }
    }

    // HTTP/HTTPS probe branch
    try {
      const r = await fetch(svc.health_endpoint, {
        method: "GET",
        signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
        headers: { "User-Agent": "PrivateNexus-HealthCheck/1.0" },
      });
      const latencyMs  = Date.now() - start;
      const statusCode = r.status;
      const status = statusCode < 300 ? "healthy"
                   : statusCode < 500 ? "warning"
                   : "degraded";
      return { id: svc.id, tenantId: svc.tenant_id, slug: svc.slug, status, statusCode, latencyMs, error: null };
    } catch (err) {
      return {
        id: svc.id, tenantId: svc.tenant_id, slug: svc.slug,
        status: "down",
        statusCode: null,
        latencyMs: Date.now() - start,
        error: err.name === "TimeoutError" ? "timeout" : err.message,
      };
    }
  };

  const results = await Promise.all(services.map(probeOne));

  // Persist status + event in one shot per service
  await Promise.all(
    results.map((r) => Promise.all([
      pool.query(
        `UPDATE services SET status = $1, updated_at = NOW()
         WHERE id = $2 AND tenant_id = $3`,
        [r.status, r.id, r.tenantId]
      ),
      pool.query(
        `INSERT INTO health_events
           (tenant_id, service_id, slug, status, status_code, latency_ms, error, source)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [r.tenantId, r.id, r.slug, r.status, r.statusCode ?? null,
         r.latencyMs, r.error ?? null, source]
      ),
    ]))
  );

  return results;
}
