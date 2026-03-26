import fs from "fs";
import path from "path";

const BACKUPS_DIR = "/root/privatenexus/app/backend/data/backups";

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
