import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const LOG_PATH = path.join(__dirname, "../data/apply-log.json");
const MAX_ENTRIES = 200;

function readLog() {
  try {
    return JSON.parse(fs.readFileSync(LOG_PATH, "utf8"));
  } catch {
    return [];
  }
}

/**
 * Record an apply attempt.
 * @param {{ fileId: string, strategy: string, target: string, timestamp: string, ok: boolean, output: string }} entry
 */
export function recordApply({ fileId, strategy, target, timestamp, ok, output }) {
  const log = readLog();
  log.push({ fileId, strategy, target, timestamp, ok, output });
  const trimmed = log.slice(-MAX_ENTRIES);
  try {
    fs.writeFileSync(LOG_PATH, JSON.stringify(trimmed, null, 2));
  } catch (err) {
    console.error("[apply-log] Failed to write apply log", err);
  }
}

/**
 * Return apply log entries, optionally filtered by fileId.
 * @param {string|undefined} fileId
 * @returns {Array}
 */
export function getApplyLog(fileId) {
  const log = readLog();
  return fileId ? log.filter((e) => e.fileId === fileId) : log;
}
