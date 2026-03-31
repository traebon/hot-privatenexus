import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const LABELS_PATH = path.join(__dirname, "../data/backup-labels.json");
const LABELS_TMP  = LABELS_PATH + ".tmp";

const MAX_LABEL_LENGTH = 64;

function readStore() {
  try {
    return JSON.parse(fs.readFileSync(LABELS_PATH, "utf8"));
  } catch {
    return {};
  }
}

/**
 * Return the label entry for a backup file, or null if none.
 * @param {string} fileName
 * @returns {{ fileId: string, label: string, updatedAt: string } | null}
 */
export function getBackupLabel(fileName) {
  const store = readStore();
  return store[fileName] || null;
}

/**
 * Set or clear the label for a backup file.
 * Empty label string removes the entry.
 * @param {string} fileId
 * @param {string} fileName
 * @param {string} label  — trimmed and capped to MAX_LABEL_LENGTH; empty clears
 * @returns {{ fileId: string, label: string, updatedAt: string } | null}
 */
export function setBackupLabel(fileId, fileName, label) {
  const trimmed = label.trim().slice(0, MAX_LABEL_LENGTH);
  const store = readStore();
  let entry = null;
  if (trimmed) {
    const updatedAt = new Date().toISOString();
    entry = { fileId, label: trimmed, updatedAt };
    store[fileName] = entry;
  } else {
    delete store[fileName];
  }
  fs.writeFileSync(LABELS_TMP, JSON.stringify(store, null, 2));
  fs.renameSync(LABELS_TMP, LABELS_PATH);
  return entry;
}

/**
 * Return all label entries for a given fileId.
 * @param {string} fileId
 * @returns {{ [fileName: string]: { fileId: string, label: string, updatedAt: string } }}
 */
export function getAllBackupLabelsForFile(fileId) {
  const store = readStore();
  const result = {};
  for (const [fileName, entry] of Object.entries(store)) {
    if (entry.fileId === fileId) {
      result[fileName] = entry;
    }
  }
  return result;
}
