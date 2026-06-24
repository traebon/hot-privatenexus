import express from "express";
import { readFileSync } from "fs";
import { requireRole } from "../middleware/requireRole.js";

export const dnsRouter = express.Router();

const PDNS_URL = process.env.PDNS_URL || "http://10.10.0.1:8081";
function readSecret(p) { try { return readFileSync(p, "utf8").trim(); } catch { return null; } }
const PDNS_KEY = readSecret("/run/secrets/pdns_api_key") ?? process.env.PDNS_API_KEY;
if (!PDNS_KEY) throw new Error("PDNS_API_KEY secret not configured");
const PDNS_BASE = `${PDNS_URL}/api/v1/servers/localhost`;

// Allow valid DNS characters; reject path traversal sequences
function validateZone(zone) {
  return typeof zone === "string" && zone.length > 0
    && /^[a-zA-Z0-9._-]+$/.test(zone)
    && !zone.includes("..");
}

async function pdns(method, path, body) {
  const opts = {
    method,
    headers: { "X-API-Key": PDNS_KEY, "Content-Type": "application/json" },
  };
  if (body !== undefined) opts.body = JSON.stringify(body);
  const res = await fetch(`${PDNS_BASE}${path}`, opts);
  if (!res.ok) {
    const raw = await res.text().catch(() => "");
    // Truncate to first non-empty line to avoid leaking full PowerDNS response bodies
    const brief = (raw.split("\n").find(l => l.trim()) || res.statusText || "PowerDNS error").slice(0, 200);
    throw Object.assign(new Error(brief), { status: res.status });
  }
  if (res.status === 204) return null;
  return res.json();
}

// GET /api/dns/zones
dnsRouter.get("/zones", requireRole("viewer"), async (_req, res) => {
  try {
    const zones = await pdns("GET", "/zones");
    res.json({ ok: true, zones: zones.map((z) => ({
      id: z.id,
      name: z.name,
      kind: z.kind,
      serial: z.serial,
      dnssec: z.dnssec,
      records: z.rrsets?.length ?? 0,
    }))});
  } catch (err) {
    res.status(err.status || 502).json({ ok: false, error: err.message });
  }
});

// GET /api/dns/zones/:zone — full zone with rrsets
dnsRouter.get("/zones/:zone", requireRole("viewer"), async (req, res) => {
  if (!validateZone(req.params.zone)) return res.status(400).json({ ok: false, error: "invalid zone name" });
  try {
    const zone = await pdns("GET", `/zones/${req.params.zone}`);
    res.json({ ok: true, zone });
  } catch (err) {
    res.status(err.status || 502).json({ ok: false, error: err.message });
  }
});

// POST /api/dns/zones/:zone/records — create or replace an rrset
dnsRouter.post("/zones/:zone/records", requireRole("operator"), async (req, res) => {
  if (!validateZone(req.params.zone)) return res.status(400).json({ ok: false, error: "invalid zone name" });
  const { name, type, ttl = 300, records } = req.body;
  if (!name || !type || !records?.length) {
    return res.status(400).json({ ok: false, error: "name, type, and records are required" });
  }
  const fqdn = name.endsWith(".") ? name : `${name}.`;
  try {
    await pdns("PATCH", `/zones/${req.params.zone}`, {
      rrsets: [{ name: fqdn, type, ttl: Number(ttl), changetype: "REPLACE", records }],
    });
    res.json({ ok: true });
  } catch (err) {
    res.status(err.status || 502).json({ ok: false, error: err.message });
  }
});

// DELETE /api/dns/zones/:zone/records
dnsRouter.delete("/zones/:zone/records", requireRole("operator"), async (req, res) => {
  if (!validateZone(req.params.zone)) return res.status(400).json({ ok: false, error: "invalid zone name" });
  const { name, type } = req.body;
  if (!name || !type) return res.status(400).json({ ok: false, error: "name and type are required" });
  const fqdn = name.endsWith(".") ? name : `${name}.`;
  try {
    await pdns("PATCH", `/zones/${req.params.zone}`, {
      rrsets: [{ name: fqdn, type, changetype: "DELETE", records: [] }],
    });
    res.json({ ok: true });
  } catch (err) {
    res.status(err.status || 502).json({ ok: false, error: err.message });
  }
});
