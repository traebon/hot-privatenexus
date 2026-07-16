import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

// Was a hardcoded Gateway-local dev path -- same bug as drafts.js. Now
// matches backupRetention.js's own BACKUPS_DIR resolution exactly, closing
// a second, quieter inconsistency (that module computed the "correct"
// portable path independently but could never actually reach the files
// fileBackups.js wrote, since the two never agreed on a location).
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BACKUPS_DIR = path.join(__dirname, "../data/backups");

function ensureBackupsDir() {
  fs.mkdirSync(BACKUPS_DIR, { recursive: true });
}

function safeTimestamp() {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

export function backupLiveFile(id, originalPath, content) {
  ensureBackupsDir();

  const baseName = path.basename(originalPath);
  const backupName = `${id}__${safeTimestamp()}__${baseName}.bak`;
  const backupPath = path.join(BACKUPS_DIR, backupName);

  fs.writeFileSync(backupPath, content, "utf8");

  const stats = fs.statSync(backupPath);
  return {
    path: backupPath,
    fileName: backupName,
    modifiedAt: stats.mtime.toISOString(),
    size: stats.size,
  };
}

export function listBackups(fileId) {
  ensureBackupsDir();
  let files;
  try {
    files = fs.readdirSync(BACKUPS_DIR);
  } catch {
    return [];
  }
  const prefix = `${fileId}__`;
  return files
    .filter((f) => f.startsWith(prefix) && f.endsWith(".bak"))
    .map((fileName) => {
      const filePath = path.join(BACKUPS_DIR, fileName);
      try {
        const stats = fs.statSync(filePath);
        return { fileName, createdAt: stats.mtime.toISOString(), size: stats.size };
      } catch {
        return null;
      }
    })
    .filter(Boolean)
    .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
}

export function readBackup(fileName) {
  if (
    !fileName ||
    typeof fileName !== "string" ||
    fileName.includes("/") ||
    fileName.includes("\\") ||
    !fileName.endsWith(".bak")
  ) {
    return null;
  }
  const filePath = path.join(BACKUPS_DIR, fileName);
  if (!filePath.startsWith(BACKUPS_DIR + path.sep)) return null;
  try {
    return fs.readFileSync(filePath, "utf8");
  } catch {
    return null;
  }
}
