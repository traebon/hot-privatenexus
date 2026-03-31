import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const LOG_PATH = path.join(__dirname, "../data/restore-log.json");
const LOG_TMP  = LOG_PATH + ".tmp";
const MAX_ENTRIES = 200;

function readLog() {
  try {
    return JSON.parse(fs.readFileSync(LOG_PATH, "utf8"));
  } catch {
    return [];
  }
}

/**
 * Record a restore attempt (success or failure).
 * @param {{
 *   fileId: string,
 *   backupFileName: string,
 *   backupLabel: string|null,
 *   wasLkg: boolean,
 *   riskLevel: "safe"|"warning"|"high_risk"|null,
 *   type: "restore"|"restore-and-apply",
 *   outcome: "success"|"failed",
 *   timestamp: string,
 *   output: string|null
 * }} entry
 */
export function recordRestore(entry) {
  const log = readLog();
  log.push({
    fileId:         entry.fileId,
    backupFileName: entry.backupFileName,
    backupLabel:    entry.backupLabel    ?? null,
    wasLkg:         entry.wasLkg        ?? false,
    riskLevel:      entry.riskLevel     ?? null,
    type:           entry.type,
    outcome:        entry.outcome,
    timestamp:      entry.timestamp,
    output:         entry.output        ?? null,
    // v0.8.1 optional fields — omitted from old entries so callers must guard with ?.
    ...(entry.phases                !== undefined && { phases:                  entry.phases }),
    ...(entry.validation            !== undefined && { validation:              entry.validation }),
    ...(entry.rollbackRecommendation !== undefined && { rollbackRecommendation: entry.rollbackRecommendation }),
  });
  const trimmed = log.slice(-MAX_ENTRIES);
  try {
    fs.writeFileSync(LOG_TMP, JSON.stringify(trimmed, null, 2));
    fs.renameSync(LOG_TMP, LOG_PATH);
  } catch (err) {
    console.error("[restore-log] Failed to write restore log", err);
  }
}

/**
 * Return restore log entries, optionally filtered by fileId.
 * @param {string|undefined} fileId
 * @returns {Array}
 */
export function getRestoreLog(fileId) {
  const log = readLog();
  return fileId ? log.filter((e) => e.fileId === fileId) : log;
}
