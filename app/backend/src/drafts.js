import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

// Was a hardcoded Gateway-local dev path ("/root/privatenexus/...") that
// never existed inside any deployed container -- every draft read/write
// failed with EACCES/ENOENT. Matches the portable __dirname-relative
// pattern the other data/-writing modules already use correctly.
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DRAFTS_DIR = path.join(__dirname, "../data/drafts");

// Draft IDs come from the file registry (slugs set by admins).
// Validate here so that a malicious registry ID cannot traverse out of DRAFTS_DIR.
function assertSafeId(id) {
  if (typeof id !== "string" || !/^[a-zA-Z0-9_-]{1,128}$/.test(id)) {
    throw new Error(`Invalid draft ID: "${id}"`);
  }
}

function ensureDraftsDir() {
  fs.mkdirSync(DRAFTS_DIR, { recursive: true });
}

function getDraftPath(id) {
  return path.join(DRAFTS_DIR, `${id}.draft`);
}

export function hasDraft(id) {
  assertSafeId(id);
  ensureDraftsDir();
  return fs.existsSync(getDraftPath(id));
}

export function readDraft(id) {
  assertSafeId(id);
  ensureDraftsDir();
  const draftPath = getDraftPath(id);
  if (!fs.existsSync(draftPath)) return null;

  const stats = fs.statSync(draftPath);
  const content = fs.readFileSync(draftPath, "utf8");

  return {
    content,
    modifiedAt: stats.mtime.toISOString(),
    size: stats.size,
  };
}

export function writeDraft(id, content) {
  assertSafeId(id);
  ensureDraftsDir();
  const draftPath = getDraftPath(id);
  fs.writeFileSync(draftPath, content, "utf8");

  const stats = fs.statSync(draftPath);
  return {
    path: draftPath,
    modifiedAt: stats.mtime.toISOString(),
    size: stats.size,
  };
}
