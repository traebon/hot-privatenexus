import fs from "fs";
import path from "path";

const DRAFTS_DIR = "/root/privatenexus/app/backend/data/drafts";

function ensureDraftsDir() {
  fs.mkdirSync(DRAFTS_DIR, { recursive: true });
}

function getDraftPath(id) {
  return path.join(DRAFTS_DIR, `${id}.draft`);
}

export function hasDraft(id) {
  ensureDraftsDir();
  return fs.existsSync(getDraftPath(id));
}

export function readDraft(id) {
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
