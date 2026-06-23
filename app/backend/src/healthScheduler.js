import { probeAllServices } from "./healthProbe.js";
import { runIntelligenceScan } from "./routes/intelligence.js";
import { getPool, HOT_TENANT_ID } from "./db.js";

const INTERVAL_MS      = Number(process.env.HEALTH_CHECK_INTERVAL_MS    || 2 * 60 * 1000);
const RETENTION_DAYS   = Number(process.env.HEALTH_EVENT_RETENTION_DAYS || 30);
const STARTUP_DELAY_MS = 15_000;
// Run intelligence scan every Nth health cycle (N=5 → every 10 min at default 2min interval)
const INTEL_EVERY_N    = Number(process.env.INTEL_SCAN_EVERY_N || 5);

let running   = false;
let timer     = null;
let cycleCount = 0;

async function runCycle() {
  if (running) {
    console.log("[healthScheduler] previous cycle still in progress — skipping");
    return;
  }
  running = true;
  cycleCount++;
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

    // Intelligence scan on every Nth cycle
    if (cycleCount % INTEL_EVERY_N === 0) {
      try {
        const intel = await runIntelligenceScan();
        if (intel.new_signals > 0 || intel.executed > 0) {
          console.log(`[intelligence] scan complete — signals: ${intel.new_signals}, proposals: ${intel.new_proposals}, executed: ${intel.executed}`);
        }
      } catch (intelErr) {
        console.error("[intelligence] scan error:", intelErr.message);
      }
    }
  } catch (err) {
    console.error("[healthScheduler] cycle error:", err.message);
  } finally {
    running = false;
  }
}

export function startHealthScheduler() {
  const intervalSecs = Math.round(INTERVAL_MS / 1000);
  console.log(`[healthScheduler] starting — interval ${intervalSecs}s, retention ${RETENTION_DAYS}d, intel every ${INTEL_EVERY_N} cycles`);
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
