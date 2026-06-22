import { listBackups } from "./fileBackups.js";
import { getKnownGood } from "./fileKnownGood.js";
import { getAllBackupLabelsForFile } from "./backupLabels.js";

/**
 * Suggest a rollback target after a failed restore-and-apply.
 * Prefers LKG, then newest labeled backup, then no suggestion.
 * Never suggests the backup that was just attempted.
 *
 * @param {string} fileId
 * @param {string} currentBackupFileName — the backup that was just restored (exclude it)
 * @returns {{ suggested: boolean, backupFileName: string|null, reason: string|null }}
 */
export function getRollbackRecommendation(fileId, currentBackupFileName) {
  const kg = getKnownGood(fileId);

  if (kg && kg.fileName !== currentBackupFileName) {
    return {
      suggested: true,
      backupFileName: kg.fileName,
      reason: "Apply failed after restore. Restoring the last known good backup is recommended.",
    };
  }

  const labels = getAllBackupLabelsForFile(fileId);
  const backups = listBackups(fileId); // newest-first

  for (const backup of backups) {
    if (backup.fileName === currentBackupFileName) continue;
    if (labels[backup.fileName]) {
      return {
        suggested: true,
        backupFileName: backup.fileName,
        reason: "Apply failed after restore. A labeled backup is available as a recovery point.",
      };
    }
  }

  return { suggested: false, backupFileName: null, reason: null };
}
