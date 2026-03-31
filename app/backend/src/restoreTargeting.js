import fs from "fs";
import path from "path";

/**
 * Generate a safe side-by-side restore target path.
 * Pattern: <dir>/<base>.restore-<timestamp><ext>
 * e.g. /etc/caddy/Caddyfile.restore-2026-03-31T04-12-00
 */
export function getSideBySidePath(livePath) {
  const dir = path.dirname(livePath);
  const ext = path.extname(livePath);
  const base = path.basename(livePath, ext);
  const ts = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  return path.join(dir, `${base}.restore-${ts}${ext}`);
}

/**
 * Validate that a caller-supplied target path is safe for a side-by-side restore.
 * Rules:
 *  - Must resolve to the same directory as the live file (no escaping)
 *  - Must not equal the live file path
 *  - Must not already exist
 *
 * @param {string} livePath — resolved path to the live file
 * @param {string} targetPath — candidate alternate path
 * @returns {{ ok: true } | { ok: false, error: string }}
 */
export function validateTargetPath(livePath, targetPath) {
  const liveDir = path.dirname(path.resolve(livePath));
  const resolvedTarget = path.resolve(targetPath);
  const targetDir = path.dirname(resolvedTarget);

  if (targetDir !== liveDir) {
    return { ok: false, error: "Target path must be in the same directory as the live file" };
  }
  if (resolvedTarget === path.resolve(livePath)) {
    return { ok: false, error: "Target path must differ from the live file path" };
  }
  if (fs.existsSync(resolvedTarget)) {
    return { ok: false, error: "Target path already exists — choose a different name" };
  }
  return { ok: true };
}
