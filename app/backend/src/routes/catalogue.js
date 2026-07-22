import { Router } from "express";
import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import { requireRole } from "../middleware/requireRole.js";
import { getTenantSettings } from "../db.js";

export const catalogueRouter = Router();

const __dirname = dirname(fileURLToPath(import.meta.url));
const DEFAULT_REPO_PATH = join(__dirname, "../catalogue/default-repo.json");

const DEFAULT_REPO = JSON.parse(readFileSync(DEFAULT_REPO_PATH, "utf8"));
DEFAULT_REPO.repository.source = "bundled";

const CATEGORIES = ["all","media","productivity","finance","devops","security","network","communication","business","home"];

// Custom repos are fetched over the network, so cache per-URL with a short
// TTL rather than fetch on every request — but never hide a fetch failure:
// getRepository() always reports whether the *active* response came from
// the custom source or fell back to bundled, and why.
const CUSTOM_REPO_CACHE_TTL_MS = 5 * 60 * 1000;
const customRepoCache = new Map(); // url -> { repo, fetchedAt, error }

function validateRepoShape(data) {
  if (!data || typeof data !== "object") return "not an object";
  if (!data.repository || typeof data.repository.name !== "string" || typeof data.repository.version !== "string")
    return "missing repository.name / repository.version";
  if (!Array.isArray(data.apps)) return "missing apps array";
  for (const a of data.apps) {
    if (!a.id || !a.name || !a.category || !a.image || !Array.isArray(a.tags))
      return `app entry missing required fields (id/name/category/image/tags): ${JSON.stringify(a).slice(0, 100)}`;
  }
  return null;
}

async function fetchCustomRepo(url) {
  const cached = customRepoCache.get(url);
  if (cached && Date.now() - cached.fetchedAt < CUSTOM_REPO_CACHE_TTL_MS) return cached;

  let entry;
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    const shapeError = validateRepoShape(data);
    if (shapeError) throw new Error(`invalid repository format — ${shapeError}`);
    data.repository.source = `custom: ${url}`;
    entry = { repo: data, fetchedAt: Date.now(), error: null };
  } catch (err) {
    entry = { repo: null, fetchedAt: Date.now(), error: err.message };
  }
  customRepoCache.set(url, entry);
  return entry;
}

// Resolves which repository a tenant should see: their configured
// catalogue_repo_url if set and fetchable, otherwise the bundled default.
// A configured-but-unreachable custom repo falls back to bundled rather
// than erroring the whole board — but the fallback is reported, not silent.
async function resolveRepository(tenantId) {
  const settings = await getTenantSettings(tenantId);
  if (!settings.catalogue_repo_url) {
    return { repo: DEFAULT_REPO, fallback: false, fetchError: null };
  }
  const { repo, error } = await fetchCustomRepo(settings.catalogue_repo_url);
  if (repo) return { repo, fallback: false, fetchError: null };
  return { repo: DEFAULT_REPO, fallback: true, fetchError: error };
}

// GET /api/catalogue — app list from the tenant's active repository
catalogueRouter.get("/", requireRole("viewer"), async (req, res) => {
  const { category, q } = req.query;
  const { repo, fallback, fetchError } = await resolveRepository(req.session.user.tenant_id);
  let apps = repo.apps;
  if (category && category !== "all") apps = apps.filter((a) => a.category === category);
  if (q) {
    const lq = q.toLowerCase();
    apps = apps.filter((a) =>
      a.name.toLowerCase().includes(lq) ||
      a.description.toLowerCase().includes(lq) ||
      a.tags.some((t) => t.toLowerCase().includes(lq))
    );
  }
  res.json({
    ok: true,
    apps,
    categories: CATEGORIES,
    total: repo.apps.length,
    repository: repo.repository,
    ...(fallback ? { repository_fallback: true, repository_fetch_error: fetchError } : {}),
  });
});

// GET /api/catalogue/repository — repository metadata only (no app list),
// for a UI panel showing source/version/count without the full payload.
catalogueRouter.get("/repository", requireRole("viewer"), async (req, res) => {
  const { repo, fallback, fetchError } = await resolveRepository(req.session.user.tenant_id);
  res.json({
    ok: true,
    repository: repo.repository,
    app_count: repo.apps.length,
    fallback,
    fetch_error: fetchError,
  });
});
