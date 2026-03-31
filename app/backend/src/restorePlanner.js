import fs from "fs";
import { getRegisteredFileById } from "./filesRegistry.js";
import { getKnownGood } from "./fileKnownGood.js";
import { getBackupLabel, getAllBackupLabelsForFile } from "./backupLabels.js";
import { listBackups, readBackup } from "./fileBackups.js";
import { getSideBySidePath } from "./restoreTargeting.js";

/**
 * Build a restore plan for a given file + backup combination.
 * Read-only — never modifies the filesystem.
 *
 * @param {string} fileId
 * @param {string} backupFileName
 * @returns {{ ok: true, plan: object } | { ok: false, error: string }}
 */
export function buildRestorePlan(fileId, backupFileName) {
  const file = getRegisteredFileById(fileId);
  if (!file) return { ok: false, error: "File not found in registry" };

  // Validate backup belongs to this file
  if (!backupFileName.startsWith(`${fileId}__`) || !backupFileName.endsWith(".bak")) {
    return { ok: false, error: "Backup does not belong to this file" };
  }

  const backupContent = readBackup(backupFileName);
  if (backupContent === null) return { ok: false, error: "Backup not found" };

  // Backup metadata
  const backups = listBackups(fileId);
  const backupMeta = backups.find((b) => b.fileName === backupFileName);
  const createdAt = backupMeta?.createdAt ?? null;

  // Trust state
  const kg = getKnownGood(fileId);
  const isLkg = kg?.fileName === backupFileName;
  const labelEntry = getBackupLabel(backupFileName);
  const label = labelEntry?.label ?? null;

  // Drift: does backup content differ from live?
  let driftedFromLive = false;
  let liveExists = false;
  let liveModifiedAt = null;
  try {
    if (fs.existsSync(file.path)) {
      liveExists = true;
      const liveContent = fs.readFileSync(file.path, "utf8");
      const stats = fs.statSync(file.path);
      liveModifiedAt = stats.mtime.toISOString();
      driftedFromLive = liveContent !== backupContent;
    }
  } catch {
    // can't read live file — treat as non-existent
  }

  // Dependencies
  const dependencies = (file.dependsOn || []).map((dep) => {
    const depFile = getRegisteredFileById(dep.id);
    const exists = depFile ? fs.existsSync(depFile.path) : false;
    return {
      id: dep.id,
      label: depFile?.label ?? dep.id,
      exists,
      required: dep.required ?? false,
    };
  });

  // Risk assessment (rules applied in priority order)
  const riskReasons = [];
  let riskLevel = "safe";

  if (!isLkg && !label) {
    riskLevel = "high_risk";
    riskReasons.push("Backup has no trust marker — not LKG and not labeled");
  }

  const missingRequired = dependencies.filter((d) => d.required && !d.exists);
  if (missingRequired.length > 0) {
    riskLevel = "high_risk";
    riskReasons.push(`Required dependencies missing: ${missingRequired.map((d) => d.label).join(", ")}`);
  }

  if (riskLevel === "safe") {
    if (!isLkg && label) {
      riskLevel = "warning";
      riskReasons.push("Backup is labeled but not the trusted LKG baseline");
    }

    if (driftedFromLive) {
      if (riskLevel === "safe") riskLevel = "warning";
      riskReasons.push("Backup content differs from current live file");
    }

    const missingOptional = dependencies.filter((d) => !d.required && !d.exists);
    if (missingOptional.length > 0) {
      if (riskLevel === "safe") riskLevel = "warning";
      riskReasons.push(`Optional dependencies missing: ${missingOptional.map((d) => d.label).join(", ")}`);
    }
  }

  const recommendation = buildRecommendation(riskLevel, isLkg, label, driftedFromLive, dependencies);
  const suggestedSideBySidePath = getSideBySidePath(file.path);

  return {
    ok: true,
    plan: {
      fileId,
      fileLabel: file.label,
      livePath: file.path,
      backup: { fileName: backupFileName, createdAt, isLkg, label, driftedFromLive },
      dependencies,
      overwrite: { liveExists, liveModifiedAt },
      riskLevel,
      riskReasons,
      recommendation,
      supportedModes: ["in_place", "side_by_side"],
      sideBySide: {
        allowed: true,
        suggestedPath: suggestedSideBySidePath,
        caveats: [],
      },
    },
  };
}

function buildRecommendation(riskLevel, isLkg, label, driftedFromLive, deps) {
  if (riskLevel === "high_risk") {
    if (!isLkg && !label) return "Backup has no trust context. Review carefully before restoring.";
    return "One or more required dependencies are missing. Resolve before restoring.";
  }
  if (riskLevel === "warning") {
    if (driftedFromLive && isLkg) return "LKG backup differs from live — this will overwrite local changes.";
    if (!isLkg) return "Backup is labeled but not the trusted baseline. Proceed with care.";
    return "Some optional dependencies are missing. Restore may proceed but review first.";
  }
  return "Restore looks safe. Backup is the trusted LKG and all dependencies are present.";
}
