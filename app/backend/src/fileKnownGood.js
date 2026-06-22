import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const KG_PATH = path.join(__dirname, "../data/known-good.json");
const KG_TMP  = KG_PATH + ".tmp";

function readStore() {
  try {
    return JSON.parse(fs.readFileSync(KG_PATH, "utf8"));
  } catch {
    return {};
  }
}

/**
 * Mark a backup as the Last-Known-Good for a file.
 * @param {string} fileId
 * @param {string} fileName  — must already be validated by the caller
 * @returns {{ fileName: string, markedAt: string }}
 */
export function markKnownGood(fileId, fileName) {
  const store = readStore();
  const markedAt = new Date().toISOString();
  store[fileId] = { fileName, markedAt };
  fs.writeFileSync(KG_TMP, JSON.stringify(store, null, 2));
  fs.renameSync(KG_TMP, KG_PATH);
  return { fileName, markedAt };
}

/**
 * Return the Last-Known-Good entry for a file, or null if none.
 * @param {string} fileId
 * @returns {{ fileName: string, markedAt: string } | null}
 */
export function getKnownGood(fileId) {
  const store = readStore();
  return store[fileId] || null;
}

/**
 * Clear the Last-Known-Good for a file (e.g. backup was deleted).
 * No-op if not set.
 * @param {string} fileId
 */
export function clearKnownGood(fileId) {
  const store = readStore();
  if (!store[fileId]) return;
  delete store[fileId];
  fs.writeFileSync(KG_TMP, JSON.stringify(store, null, 2));
  fs.renameSync(KG_TMP, KG_PATH);
}
