import { readFileSync } from "fs";

// Grafana Alerting silence integration -- used by the maintenance window
// (routes/actions.js) to suppress Ntfy/email alerts for its duration.
// No GRAFANA_API_TOKEN exists yet -- Grafana lives on sn-monitor, one of the
// 7 VMs behind the dead bare-metal host, completely unreachable right now
// (stale 20+ day WireGuard handshake, no ping, 502 through Caddy). Same
// "placeholder secret, real integration point, honest failure" pattern as
// PROXMOX_TOKEN (discovery.js) -- this is wired up and ready to work the
// moment sn-monitor is back and a real Grafana service account token is
// issued and dropped into the secret file; every call fails gracefully
// until then rather than pretending to succeed.
const GRAFANA_URL = process.env.GRAFANA_URL || "https://grafana.house-of-trae.com";

function readSecret(path) {
  try { return readFileSync(path, "utf8").trim(); } catch { return null; }
}

function getToken() {
  return readSecret("/run/secrets/grafana_token") ?? process.env.GRAFANA_API_TOKEN ?? null;
}

// Silences every alert rule (broad alertname regex match) for the given
// window -- maintenance mode is fleet-wide (routes/actions.js's emergency
// board), not per-service, so this matches that scope rather than trying to
// target individual rules. Grafana auto-expires the silence at endsAt on its
// own -- this is what makes "then resumes on expiry" true with zero PN-side
// cron/timer needed for the resume half.
export async function createMaintenanceSilence({ endsAt, reason, createdBy }) {
  const token = getToken();
  if (!token) return { ok: false, error: "GRAFANA_API_TOKEN not configured" };
  if (!endsAt) return { ok: false, error: "endsAt is required -- Grafana silences cannot be open-ended" };

  try {
    const r = await fetch(`${GRAFANA_URL}/api/alertmanager/grafana/api/v2/silences`, {
      method: "POST",
      signal: AbortSignal.timeout(8000),
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        matchers: [{ name: "alertname", value: ".+", isRegex: true, isEqual: true }],
        startsAt: new Date().toISOString(),
        endsAt,
        createdBy: createdBy || "privatenexus",
        comment: reason ? `PrivateNexus maintenance window: ${reason}` : "PrivateNexus maintenance window",
      }),
    });
    if (!r.ok) {
      const body = await r.text().catch(() => "");
      return { ok: false, error: `Grafana returned ${r.status}${body ? `: ${body.slice(0, 200)}` : ""}` };
    }
    const data = await r.json();
    const silenceId = data.silenceID || data.silenceId || data.id;
    if (!silenceId) return { ok: false, error: "Grafana response had no silence ID" };
    return { ok: true, silenceId };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

// Only needed for an *early* maintenance.disable -- natural expiry needs no
// call at all, Grafana's own endsAt already stops the silence matching.
export async function deleteMaintenanceSilence(silenceId) {
  const token = getToken();
  if (!token) return { ok: false, error: "GRAFANA_API_TOKEN not configured" };

  try {
    const r = await fetch(`${GRAFANA_URL}/api/alertmanager/grafana/api/v2/silence/${encodeURIComponent(silenceId)}`, {
      method: "DELETE",
      signal: AbortSignal.timeout(8000),
      headers: { Authorization: `Bearer ${token}` },
    });
    // 404 means it's already gone (expired naturally, or already deleted) -- not a failure.
    if (!r.ok && r.status !== 404) {
      return { ok: false, error: `Grafana returned ${r.status}` };
    }
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}
