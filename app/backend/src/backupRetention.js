import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { listBackups } from "./fileBackups.js";
import { getKnownGood } from "./fileKnownGood.js";
import { getAllBackupLabelsForFile } from "./backupLabels.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BACKUPS_DIR = path.resolve(__dirname, "../data/backups");

/**
 * Compute prune candidates and protected backups for a file.
 * LKG and labeled backups are always protected.
 *
 * Policies:
 *   { mode: "count", keep: number }  — keep newest N non-protected backups
 *   { mode: "age",   days:  number } — delete backups older than N days
 *
 * @returns {{
 *   candidates: Array<{fileName, createdAt, reason}>,
 *   protected:  Array<{fileName, createdAt, reason, label?}>
 * }}
 */
export function computePrunePlan(fileId, policy) {
  const backups = listBackups(fileId); // newest-first
  const kg = getKnownGood(fileId);
  const labels = getAllBackupLabelsForFile(fileId);

  const kgFileName = kg?.fileName || null;
  const labeledSet = new Set(Object.keys(labels));

  const nonProtected = [];
  const protectedBackups = [];

  for (const backup of backups) {
    if (backup.fileName === kgFileName) {
      protectedBackups.push({ fileName: backup.fileName, createdAt: backup.createdAt, reason: "known-good" });
    } else if (labeledSet.has(backup.fileName)) {
      protectedBackups.push({ fileName: backup.fileName, createdAt: backup.createdAt, reason: "labeled", label: labels[backup.fileName].label });
    } else {
      nonProtected.push(backup);
    }
  }

  const candidates = [];

  if (policy.mode === "count") {
    const keep = Math.max(0, Math.floor(policy.keep));
    for (let i = 0; i < nonProtected.length; i++) {
      const b = nonProtected[i];
      if (i < keep) {
        protectedBackups.push({ fileName: b.fileName, createdAt: b.createdAt, reason: "within-policy" });
      } else {
        candidates.push({ fileName: b.fileName, createdAt: b.createdAt, reason: "count-excess" });
      }
    }
  } else if (policy.mode === "age") {
    const days = Math.max(0, policy.days);
    const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
    for (const b of nonProtected) {
      if (new Date(b.createdAt).getTime() < cutoff) {
        candidates.push({ fileName: b.fileName, createdAt: b.createdAt, reason: `older-than-${days}d` });
      } else {
        protectedBackups.push({ fileName: b.fileName, createdAt: b.createdAt, reason: "within-policy" });
      }
    }
  }

  return { candidates, protected: protectedBackups };
}

/**
 * Delete candidate backup files from disk.
 * Validates every path stays within BACKUPS_DIR.
 * @param {Array<{fileName: string}>} candidates
 * @returns {string[]} deleted file names
 */
export function executeDeleteCandidates(candidates) {
  const deleted = [];
  for (const c of candidates) {
    if (!c.fileName || c.fileName.includes("/") || c.fileName.includes("\\")) continue;
    const filePath = path.join(BACKUPS_DIR, c.fileName);
    if (!filePath.startsWith(BACKUPS_DIR + path.sep)) continue;
    try {
      fs.unlinkSync(filePath);
      deleted.push(c.fileName);
    } catch {
      // silently skip if already gone
    }
  }
  return deleted;
}
