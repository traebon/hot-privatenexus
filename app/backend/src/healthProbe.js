import { getPool, HOT_TENANT_ID } from "./db.js";

const PROBE_TIMEOUT_MS = Number(process.env.HEALTH_PROBE_TIMEOUT_MS || 8000);

/**
 * Probes all non-archived services that have a health_endpoint.
 * Updates services.status and writes one health_events row per service.
 * Returns the results array.
 *
 * @param {"scheduler"|"manual"} source — recorded in health_events.source
 */
export async function probeAllServices(source = "scheduler") {
  const pool = getPool();

  const { rows: services } = await pool.query(
    `SELECT id, slug, health_endpoint FROM services
     WHERE tenant_id = $1 AND health_endpoint IS NOT NULL AND archived = FALSE`,
    [HOT_TENANT_ID]
  );

  if (!services.length) return [];

  const probeOne = async (svc) => {
    const start = Date.now();
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
      return { id: svc.id, slug: svc.slug, status, statusCode, latencyMs, error: null };
    } catch (err) {
      return {
        id: svc.id, slug: svc.slug,
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
        [r.status, r.id, HOT_TENANT_ID]
      ),
      pool.query(
        `INSERT INTO health_events
           (tenant_id, service_id, slug, status, status_code, latency_ms, error, source)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [HOT_TENANT_ID, r.id, r.slug, r.status, r.statusCode ?? null,
         r.latencyMs, r.error ?? null, source]
      ),
    ]))
  );

  return results;
}
