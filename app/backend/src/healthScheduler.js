import { probeAllServices } from "./healthProbe.js";
import { getPool, HOT_TENANT_ID } from "./db.js";

const INTERVAL_MS     = Number(process.env.HEALTH_CHECK_INTERVAL_MS    || 2 * 60 * 1000);
const RETENTION_DAYS  = Number(process.env.HEALTH_EVENT_RETENTION_DAYS || 30);
const STARTUP_DELAY_MS = 15_000;

let running = false;
let timer   = null;

async function runCycle() {
  if (running) {
    console.log("[healthScheduler] previous cycle still in progress — skipping");
    return;
  }
  running = true;
  const start = Date.now();
  try {
    const results = await probeAllServices("scheduler");
    const elapsed = Date.now() - start;
    const unhealthy = results.filter(r => r.status !== "healthy");

    if (unhealthy.length) {
      const summary = unhealthy.map(r => `${r.slug}(${r.status})`).join(", ");
      console.log(`[healthScheduler] ${results.length} services probed in ${elapsed}ms — ${unhealthy.length} non-healthy: ${summary}`);
    } else {
      console.log(`[healthScheduler] ${results.length} services probed in ${elapsed}ms — all healthy`);
    }

    // Prune events older than retention window
    await getPool().query(
      `DELETE FROM health_events
       WHERE tenant_id = $1 AND ts < NOW() - INTERVAL '1 day' * $2`,
      [HOT_TENANT_ID, RETENTION_DAYS]
    );
  } catch (err) {
    console.error("[healthScheduler] cycle error:", err.message);
  } finally {
    running = false;
  }
}

export function startHealthScheduler() {
  const intervalSecs = Math.round(INTERVAL_MS / 1000);
  console.log(`[healthScheduler] starting — interval ${intervalSecs}s, retention ${RETENTION_DAYS}d`);
  // First cycle after startup delay, then regular interval
  setTimeout(async () => {
    await runCycle();
    timer = setInterval(runCycle, INTERVAL_MS);
  }, STARTUP_DELAY_MS);
}

export function stopHealthScheduler() {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}
