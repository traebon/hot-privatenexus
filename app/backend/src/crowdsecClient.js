import { readFileSync } from "fs";

// CrowdSec LAPI integration -- used by Hard-tier Lockdown Mode (routes/lockdown.js)
// to add a range-ban against a signal's offending source IP/CIDR.
//
// Important: bouncer API keys (X-Api-Key) are READ-ONLY against the LAPI --
// confirmed live 2026-07-30, POST /v1/alerts with a bouncer key returns 401
// "cookie token is empty". Writing a new decision requires machine (watcher)
// auth: POST /v1/watchers/login with a registered machine_id/password to get
// a short-lived JWT, then POST /v1/alerts with that bearer token. PN is
// registered as machine "pn-lockdown" (`cscli machines add pn-lockdown`) --
// this is a different registration from the Caddy bouncer already consuming
// decisions on the Gateway, and does not affect it.
//
// Reachable over the WireGuard mesh only (10.10.0.1:8083), not Tailscale --
// see PrivateNexus_Security_Lockdown_Mode_Design.md for why.
const CROWDSEC_LAPI_URL = process.env.CROWDSEC_LAPI_URL || "http://10.10.0.1:8083";
const MACHINE_ID = process.env.CROWDSEC_MACHINE_ID || "pn-lockdown";

// Real bug found and fixed 2026-07-30, worth the comment: CrowdSec's LAPI
// (one of its own collections -- crowdsecurity/http-cve, or a similar
// self-protection scenario watching its own access log) silently rejects any
// request whose User-Agent is the literal default Node sends ("node") --
// confirmed via a byte-level tcpdump comparison against an otherwise
// byte-identical curl request (same body, same headers otherwise, same
// source IP): curl consistently got 200, Node's default fetch/http.request
// consistently got a normal-looking 401 "incorrect Username or Password"
// from CrowdSec's own API -- not a network/firewall block, the credentials
// were never wrong. Spoofing User-Agent to "curl/..." or any other honest
// non-"node" string fixes it. Set explicitly on every request below.
const USER_AGENT = "privatenexus-lockdown/1.0";

function readSecret(path) {
  try { return readFileSync(path, "utf8").trim(); } catch { return null; }
}

function getMachinePassword() {
  return readSecret("/run/secrets/crowdsec_machine_password") ?? process.env.CROWDSEC_MACHINE_PASSWORD ?? null;
}

// In-memory JWT cache -- login tokens are short-lived (~2h observed) but
// there's no need to log in again for every single ban; refresh a little
// before actual expiry to avoid a race against a request in flight.
let cachedToken = null;
let cachedExpiry = 0;

async function login() {
  const password = getMachinePassword();
  if (!password) return { ok: false, error: "CROWDSEC_MACHINE_PASSWORD not configured" };

  try {
    const r = await fetch(`${CROWDSEC_LAPI_URL}/v1/watchers/login`, {
      method: "POST",
      signal: AbortSignal.timeout(8000),
      headers: { "Content-Type": "application/json", "User-Agent": USER_AGENT },
      body: JSON.stringify({ machine_id: MACHINE_ID, password }),
    });
    if (!r.ok) {
      const body = await r.text().catch(() => "");
      return { ok: false, error: `CrowdSec login returned ${r.status}${body ? `: ${body.slice(0, 200)}` : ""}` };
    }
    const data = await r.json();
    if (!data.token) return { ok: false, error: "CrowdSec login response had no token" };
    cachedToken = data.token;
    cachedExpiry = data.expire ? new Date(data.expire).getTime() : Date.now() + 5 * 60 * 1000;
    return { ok: true, token: cachedToken };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

async function getToken() {
  // Refresh 60s before actual expiry, not right at the edge.
  if (cachedToken && Date.now() < cachedExpiry - 60_000) return { ok: true, token: cachedToken };
  return login();
}

// scope: "ip" or "range" (CIDR) -- matches the design doc's "source IP/CIDR" language.
export async function applyCrowdSecBan({ scope = "ip", value, durationSecs = 4 * 3600, reason }) {
  if (!value) return { ok: false, error: "value (IP or CIDR) is required" };
  if (!["ip", "range"].includes(scope)) return { ok: false, error: "scope must be 'ip' or 'range'" };

  const tokenResult = await getToken();
  if (!tokenResult.ok) return tokenResult;

  const durationStr = `${Math.max(1, Math.round(durationSecs / 60))}m`;
  const scenario = "manual/pn-lockdown-hard-tier";

  const alert = [{
    scenario,
    scenario_version: "",
    scenario_hash: "",
    message: reason || "PrivateNexus Lockdown Mode (Hard tier) range-ban",
    events_count: 1,
    capacity: 1,
    leakspeed: "0",
    simulated: false,
    events: [],
    start_at: new Date().toISOString(),
    stop_at: new Date().toISOString(),
    source: { scope, value },
    decisions: [{
      duration: durationStr,
      scope,
      value,
      type: "ban",
      origin: MACHINE_ID,
      scenario,
    }],
  }];

  async function post(token) {
    return fetch(`${CROWDSEC_LAPI_URL}/v1/alerts`, {
      method: "POST",
      signal: AbortSignal.timeout(8000),
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", "User-Agent": USER_AGENT },
      body: JSON.stringify(alert),
    });
  }

  try {
    let r = await post(tokenResult.token);
    // Cached token may have gone stale between calls (e.g. CrowdSec restart
    // invalidating sessions) -- one retry with a fresh login, not an infinite loop.
    if (r.status === 401) {
      cachedToken = null;
      const retryLogin = await login();
      if (!retryLogin.ok) return retryLogin;
      r = await post(retryLogin.token);
    }
    if (!r.ok) {
      const body = await r.text().catch(() => "");
      return { ok: false, error: `CrowdSec returned ${r.status}${body ? `: ${body.slice(0, 200)}` : ""}` };
    }
    const alertIds = await r.json();
    return { ok: true, alertIds, scope, value, durationStr };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}
