import { Router } from "express";
import { requireRole } from "../middleware/requireRole.js";

export const appsRouter = Router();

const PROMETHEUS_URL = process.env.PROMETHEUS_URL || "http://10.10.50.104:9090";

async function probeStatus() {
  try {
    const url = `${PROMETHEUS_URL}/api/v1/query?query=${encodeURIComponent('probe_success{job="blackbox-https"}')}`;
    const res = await fetch(url);
    const json = await res.json();
    const map = {};
    for (const r of json.data?.result || []) {
      map[r.metric.instance] = r.value[1] === "1" ? "up" : "down";
    }
    return map;
  } catch {
    return {};
  }
}

const HOT_APPS = [
  { name: "Nextcloud",      logo: "☁️",  category: "Cloud",      meta: "Files · Sync",        url: "https://nextcloud.tresemme.space",    container: "nextcloud",            probe: "https://nextcloud.tresemme.space" },
  { name: "Immich",         logo: "🖼️", category: "Media",      meta: "Photos · ML",          url: "https://photos.tresemme.space",       container: "immich_server",        probe: "https://photos.tresemme.space" },
  { name: "Notesnook",      logo: "📝",  category: "Notes",      meta: "Vault · Secure",       url: "https://notes.tresemme.space",        container: "notesnook",            probe: "https://notes.tresemme.space" },
  { name: "Vaultwarden",    logo: "🔐",  category: "Identity",   meta: "Password vault",        url: "https://vaultwarden.tresemme.space",  container: "vaultwarden",          probe: "https://vaultwarden.tresemme.space" },
  { name: "Grafana",        logo: "📊",  category: "Monitoring", meta: "Dashboards",            url: "https://grafana.house-of-trae.com",   container: "monitoring-grafana-1", probe: "https://grafana.house-of-trae.com" },
  { name: "Uptime Kuma",    logo: "🟢",  category: "Monitoring", meta: "Status checks",         url: "https://status.house-of-trae.com",    container: "uptime-kuma",          probe: "https://status.house-of-trae.com" },
  { name: "Keycloak",       logo: "🛡️",  category: "Identity",   meta: "SSO · MFA",             url: "https://auth.house-of-trae.com",      container: "keycloak",             probe: "https://auth.house-of-trae.com" },
  { name: "Forgejo",        logo: "🦊",  category: "Infra",      meta: "Git · CI",              url: "https://git.securenexus.net",         container: "forgejo",              probe: "https://git.securenexus.net" },
  { name: "ERPNext",        logo: "🏢",  category: "Business",   meta: "ERP · POS",             url: "https://erp.dickson-supplies.com",    container: "dickson-backend",      probe: "https://erp.dickson-supplies.com" },
  { name: "Firefly III",    logo: "🦋",  category: "Finance",    meta: "Finance tracker",       url: "https://firefly.tresemme.space",      container: "firefly",              probe: "https://firefly.tresemme.space" },
  { name: "Actual Budget",  logo: "💰",  category: "Finance",    meta: "Budget · Envelope",     url: "https://actual.tresemme.space",       container: "actual",               probe: "https://actual.tresemme.space" },
  { name: "PowerDNS Admin", logo: "🌐",  category: "Infra",      meta: "DNS management",        url: "https://dns-admin.house-of-trae.com", container: "pdns-admin",           probe: "https://dns-admin.house-of-trae.com" },
  { name: "Namevault",      logo: "🏷️",  category: "Infra",      meta: "Domain namegen",        url: "https://namevault.co.uk",             container: "namevault",            probe: "https://namevault.co.uk" },
  { name: "Roundcube",      logo: "✉️",  category: "Cloud",      meta: "Webmail",               url: "https://webmail.house-of-trae.com",   container: "roundcube",            probe: "https://webmail.house-of-trae.com" },
  { name: "PrivateNexus",   logo: "🔷",  category: "Infra",      meta: "Dashboard · Control",   url: "https://privatenexus.net",            container: "privatenexus-backend", probe: "https://privatenexus.net" },
  { name: "Wazuh SIEM",     logo: "🔍",  category: "Security",   meta: "SIEM · Alerts",         url: null,                                  container: "wazuh.manager",        probe: null },
];

appsRouter.get("/", requireRole("viewer"), async (_req, res) => {
  const status = await probeStatus();
  const apps = HOT_APPS.map((app) => ({
    ...app,
    status: app.probe ? (status[app.probe] ?? "unknown") : "unknown",
  }));
  res.json(apps);
});
