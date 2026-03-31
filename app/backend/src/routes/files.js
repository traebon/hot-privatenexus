import fs from "fs";
import path from "path";
import { Router } from "express";
import { getRegisteredFileById, listRegisteredFiles } from "../filesRegistry.js";
import { readDraft, writeDraft } from "../drafts.js";
import { backupLiveFile, listBackups, readBackup } from "../fileBackups.js";
import { validateFile } from "../fileValidator.js";
import { applyFile } from "../fileApply.js";
import { recordApply, getApplyLog } from "../fileApplyLog.js";
import { markKnownGood, getKnownGood } from "../fileKnownGood.js";
import { setBackupLabel, getBackupLabel, getAllBackupLabelsForFile } from "../backupLabels.js";
import { computePrunePlan, executeDeleteCandidates } from "../backupRetention.js";
import { buildRestorePlan } from "../restorePlanner.js";
import { recordRestore, getRestoreLog } from "../restoreLog.js";
import { getRollbackRecommendation } from "../restoreRollbackAdvice.js";
import { getSideBySidePath, validateTargetPath } from "../restoreTargeting.js";

export const filesRouter = Router();

// GET /api/files[?stack=<name>] — list registered files; optional stack filter
filesRouter.get("/", (req, res) => {
  try {
    const { stack } = req.query;
    let files = listRegisteredFiles();
    if (stack && typeof stack === "string") {
      files = files.filter((f) => f.stack === stack);
    }
    res.json(files);
  } catch (err) {
    console.error("Failed to list files", err);
    res.status(500).json({ ok: false, error: "Failed to list files" });
  }
});

// GET /api/files/read?id=<id> — read whitelisted file + any existing draft
filesRouter.get("/read", (req, res) => {
  const { id } = req.query;

  if (!id || typeof id !== "string") {
    return res.status(400).json({ ok: false, error: "File id is required" });
  }

  const file = getRegisteredFileById(id);
  if (!file) {
    return res.status(404).json({ ok: false, error: "File not found in registry" });
  }

  try {
    const content = fs.readFileSync(file.path, "utf8");
    const stats = fs.statSync(file.path);
    const draft = readDraft(file.id);

    res.json({
      ok: true,
      id: file.id,
      label: file.label,
      type: file.type,
      stack: file.stack,
      path: file.path,
      fileName: path.basename(file.path),
      editable: file.editable,
      validatable: file.validatable,
      modifiedAt: stats.mtime.toISOString(),
      size: stats.size,
      content,
      draft: draft
        ? { exists: true, content: draft.content, modifiedAt: draft.modifiedAt, size: draft.size }
        : { exists: false, content: null, modifiedAt: null, size: 0 },
    });
  } catch (err) {
    console.error(`Failed to read file: ${file.path}`, err);
    res.status(500).json({ ok: false, error: "Failed to read file" });
  }
});

// POST /api/files/draft — save draft content for a whitelisted file
filesRouter.post("/draft", (req, res) => {
  const { id, content } = req.body || {};

  if (!id || typeof id !== "string") {
    return res.status(400).json({ ok: false, error: "File id is required" });
  }
  if (typeof content !== "string") {
    return res.status(400).json({ ok: false, error: "Draft content must be a string" });
  }

  const file = getRegisteredFileById(id);
  if (!file) {
    return res.status(404).json({ ok: false, error: "File not found in registry" });
  }

  try {
    const draft = writeDraft(id, content);
    res.json({
      ok: true,
      id,
      draft: { exists: true, modifiedAt: draft.modifiedAt, size: draft.size },
    });
  } catch (err) {
    console.error(`Failed to write draft for: ${id}`, err);
    res.status(500).json({ ok: false, error: "Failed to save draft" });
  }
});

// POST /api/files/validate — validate content without writing
filesRouter.post("/validate", (req, res) => {
  const { id, content } = req.body || {};

  if (!id || typeof id !== "string") {
    return res.status(400).json({ ok: false, error: "File id is required" });
  }
  if (typeof content !== "string") {
    return res.status(400).json({ ok: false, error: "Content must be a string" });
  }

  const file = getRegisteredFileById(id);
  if (!file) {
    return res.status(404).json({ ok: false, error: "File not found in registry" });
  }

  if (!file.validatable) {
    return res.json({ ok: true, validatable: false, status: "green", issues: [] });
  }

  const result = validateFile(file.type, content);
  return res.json({ ok: true, validatable: true, ...result });
});

// POST /api/files/write — overwrite live file (backup-on-write, whitelist only)
filesRouter.post("/write", (req, res) => {
  const { id, content, source } = req.body || {};

  if (!id || typeof id !== "string") {
    return res.status(400).json({ ok: false, error: "File id is required" });
  }
  if (typeof content !== "string") {
    return res.status(400).json({ ok: false, error: "Write content must be a string" });
  }

  const file = getRegisteredFileById(id);
  if (!file) {
    return res.status(404).json({ ok: false, error: "File not found in registry" });
  }
  if (!file.editable) {
    return res.status(403).json({ ok: false, error: "File is not editable" });
  }

  if (file.validatable) {
    const validation = validateFile(file.type, content);
    if (validation.status === "red") {
      return res.status(422).json({
        ok: false,
        error: "Validation errors must be fixed before saving live",
        validation,
      });
    }
  }

  try {
    const originalContent = fs.existsSync(file.path)
      ? fs.readFileSync(file.path, "utf8")
      : "";

    const backup = backupLiveFile(id, file.path, originalContent);

    fs.writeFileSync(file.path, content, "utf8");

    const stats = fs.statSync(file.path);
    res.json({
      ok: true,
      id,
      source: source || "editor",
      file: { path: file.path, modifiedAt: stats.mtime.toISOString(), size: stats.size },
      backup,
    });
  } catch (err) {
    console.error(`Failed to write live file: ${id}`, err);
    res.status(500).json({ ok: false, error: "Failed to save live file" });
  }
});

// POST /api/files/apply — apply the saved live file to its stack/service
filesRouter.post("/apply", (req, res) => {
  const { id } = req.body || {};

  if (!id || typeof id !== "string") {
    return res.status(400).json({ ok: false, error: "File id is required" });
  }

  const file = getRegisteredFileById(id);
  if (!file) {
    return res.status(404).json({ ok: false, error: "File not found in registry" });
  }
  if (!file.applyStrategy) {
    return res.status(400).json({ ok: false, error: "File has no apply strategy defined" });
  }

  // Belt-and-suspenders: re-validate the live file content before applying
  if (file.validatable) {
    try {
      const content = fs.existsSync(file.path) ? fs.readFileSync(file.path, "utf8") : "";
      const validation = validateFile(file.type, content);
      if (validation.status === "red") {
        return res.status(422).json({
          ok: false,
          error: "Live file has validation errors — fix before applying",
          validation,
        });
      }
    } catch (err) {
      return res.status(500).json({ ok: false, error: "Failed to read file for pre-apply validation" });
    }
  }

  const result = applyFile(file.applyStrategy, file.applyPath);
  const status = result.ok ? 200 : 500;

  console.log(`[apply] ${file.applyStrategy} → ${file.applyPath} — ${result.ok ? "ok" : "failed"}`);

  recordApply({
    fileId: file.id,
    strategy: file.applyStrategy,
    target: file.applyPath,
    timestamp: new Date().toISOString(),
    ok: result.ok,
    output: result.output || "",
  });

  return res.status(status).json({
    ok: result.ok,
    id,
    action: file.applyStrategy,
    target: file.applyPath,
    output: result.output,
  });
});

// GET /api/files/backups?id=<fileId> — list backups for a registered file, newest first
filesRouter.get("/backups", (req, res) => {
  const { id } = req.query;
  if (!id || typeof id !== "string") {
    return res.status(400).json({ ok: false, error: "File id is required" });
  }
  const file = getRegisteredFileById(id);
  if (!file) {
    return res.status(404).json({ ok: false, error: "File not found in registry" });
  }
  const backups = listBackups(id);
  res.json({ ok: true, backups });
});

// GET /api/files/backups/read?id=<fileId>&file=<fileName> — read a single backup
filesRouter.get("/backups/read", (req, res) => {
  const { id, file: fileName } = req.query;
  if (!id || typeof id !== "string") {
    return res.status(400).json({ ok: false, error: "File id is required" });
  }
  if (!fileName || typeof fileName !== "string") {
    return res.status(400).json({ ok: false, error: "Backup file name is required" });
  }
  const file = getRegisteredFileById(id);
  if (!file) {
    return res.status(404).json({ ok: false, error: "File not found in registry" });
  }
  if (!fileName.startsWith(`${id}__`)) {
    return res.status(403).json({ ok: false, error: "Backup does not belong to this file" });
  }
  const content = readBackup(fileName);
  if (content === null) {
    return res.status(404).json({ ok: false, error: "Backup not found" });
  }
  res.json({ ok: true, fileName, content });
});

// POST /api/files/restore — restore a backup to live (in_place) or alternate path (side_by_side)
filesRouter.post("/restore", (req, res) => {
  const { id, file: backupFileName, mode = "in_place", targetPath: requestedTargetPath } = req.body || {};

  if (!id || typeof id !== "string") {
    return res.status(400).json({ ok: false, error: "File id is required" });
  }
  if (!backupFileName || typeof backupFileName !== "string") {
    return res.status(400).json({ ok: false, error: "Backup file name is required" });
  }
  if (mode !== "in_place" && mode !== "side_by_side") {
    return res.status(400).json({ ok: false, error: "mode must be 'in_place' or 'side_by_side'" });
  }

  const file = getRegisteredFileById(id);
  if (!file) {
    return res.status(404).json({ ok: false, error: "File not found in registry" });
  }
  if (!file.editable) {
    return res.status(403).json({ ok: false, error: "File is not editable" });
  }

  // Guard: backup must belong to this file id (same prefix check as backups/read)
  if (!backupFileName.startsWith(`${id}__`) || !backupFileName.endsWith(".bak")) {
    return res.status(403).json({ ok: false, error: "Backup does not belong to this file" });
  }

  // Read backup content (readBackup also guards against path traversal)
  const backupContent = readBackup(backupFileName);
  if (backupContent === null) {
    return res.status(404).json({ ok: false, error: "Backup not found" });
  }

  // --- Side-by-side mode: write to alternate path, never touch live ---
  if (mode === "side_by_side") {
    let effectiveTargetPath;
    if (requestedTargetPath && typeof requestedTargetPath === "string") {
      const check = validateTargetPath(file.path, requestedTargetPath);
      if (!check.ok) return res.status(400).json({ ok: false, error: check.error });
      effectiveTargetPath = path.resolve(requestedTargetPath);
    } else {
      effectiveTargetPath = getSideBySidePath(file.path);
    }

    try {
      fs.writeFileSync(effectiveTargetPath, backupContent, "utf8");
      console.log(`[restore:side-by-side] ${id} → ${effectiveTargetPath}`);
    } catch (err) {
      console.error(`Side-by-side restore failed for ${id}`, err);
      return res.status(500).json({ ok: false, error: "Side-by-side restore failed" });
    }

    const validation = file.validatable ? validateFile(file.type, backupContent) : null;
    const kg = getKnownGood(id);
    const labelEntry = getBackupLabel(backupFileName);

    recordRestore({
      fileId: id,
      backupFileName,
      backupLabel: labelEntry?.label ?? null,
      wasLkg: kg?.fileName === backupFileName,
      riskLevel: null,
      type: "restore",
      outcome: "success",
      timestamp: new Date().toISOString(),
      output: null,
      validation: validation ?? undefined,
      restoreMode: "side_by_side",
      targetPath: effectiveTargetPath,
      livePathUnchanged: true,
    });

    return res.json({
      ok: true,
      id,
      mode: "side_by_side",
      restoredFrom: backupFileName,
      targetPath: effectiveTargetPath,
      livePathUnchanged: true,
      validation,
      recommendation: "Inspect the restored copy at the target path. Compare against live before proceeding with manual cutover.",
    });
  }

  // --- In-place mode (default) ---
  try {
    // Safety backup of current live before overwrite
    const currentContent = fs.existsSync(file.path)
      ? fs.readFileSync(file.path, "utf8")
      : "";
    const safetyBackup = backupLiveFile(id, file.path, currentContent);

    // Write backup content to live path
    fs.writeFileSync(file.path, backupContent, "utf8");

    const stats = fs.statSync(file.path);
    console.log(`[restore] ${id} ← ${backupFileName}`);

    // Post-restore validation (informational — file is already written)
    const validation = file.validatable ? validateFile(file.type, backupContent) : null;
    const validationFailed = validation?.status === "red";
    const outcome = validationFailed ? "partial" : "success";

    const kg = getKnownGood(id);
    const labelEntry = getBackupLabel(backupFileName);
    recordRestore({
      fileId: id,
      backupFileName,
      backupLabel: labelEntry?.label ?? null,
      wasLkg: kg?.fileName === backupFileName,
      riskLevel: null,
      type: "restore",
      outcome,
      timestamp: new Date().toISOString(),
      output: validationFailed ? "Validation failed after restore" : null,
      validation: validation ?? undefined,
      restoreMode: "in_place",
      targetPath: file.path,
      livePathUnchanged: false,
    });

    return res.json({
      ok: true,
      id,
      mode: "in_place",
      restoredFrom: backupFileName,
      safetyBackup: { fileName: safetyBackup.fileName, size: safetyBackup.size },
      file: { path: file.path, modifiedAt: stats.mtime.toISOString(), size: stats.size },
      validation,
    });
  } catch (err) {
    console.error(`Failed to restore ${id} from ${backupFileName}`, err);
    recordRestore({
      fileId: id,
      backupFileName,
      backupLabel: null,
      wasLkg: false,
      riskLevel: null,
      type: "restore",
      outcome: "failed",
      timestamp: new Date().toISOString(),
      output: err.message,
    });
    return res.status(500).json({ ok: false, error: "Restore failed" });
  }
});

// POST /api/files/restore-and-apply — restore backup to live then run apply strategy
filesRouter.post("/restore-and-apply", (req, res) => {
  const { id, file: backupFileName } = req.body || {};

  if (!id || typeof id !== "string") {
    return res.status(400).json({ ok: false, error: "File id is required" });
  }
  if (!backupFileName || typeof backupFileName !== "string") {
    return res.status(400).json({ ok: false, error: "Backup file name is required" });
  }

  const file = getRegisteredFileById(id);
  if (!file) {
    return res.status(404).json({ ok: false, error: "File not found in registry" });
  }
  if (!file.editable) {
    return res.status(403).json({ ok: false, error: "File is not editable" });
  }
  if (!file.applyStrategy) {
    return res.status(400).json({ ok: false, error: "File has no apply strategy — use restore instead" });
  }
  if (!backupFileName.startsWith(`${id}__`) || !backupFileName.endsWith(".bak")) {
    return res.status(403).json({ ok: false, error: "Backup does not belong to this file" });
  }

  const backupContent = readBackup(backupFileName);
  if (backupContent === null) {
    return res.status(404).json({ ok: false, error: "Backup not found" });
  }

  const phases = [];
  const now = () => new Date().toISOString();

  // Phase 1 — safety backup + restore
  let safetyBackup;
  try {
    const currentContent = fs.existsSync(file.path)
      ? fs.readFileSync(file.path, "utf8")
      : "";
    safetyBackup = backupLiveFile(id, file.path, currentContent);
    fs.writeFileSync(file.path, backupContent, "utf8");
    phases.push({ name: "restore_written", status: "ok", timestamp: now(), detail: null });
    console.log(`[restore-and-apply] restored ${id} ← ${backupFileName}`);
  } catch (err) {
    phases.push({ name: "restore_written", status: "failed", timestamp: now(), detail: err.message });
    console.error(`Failed to restore ${id}`, err);
    recordRestore({
      fileId: id, backupFileName,
      backupLabel: getBackupLabel(backupFileName)?.label ?? null,
      wasLkg: getKnownGood(id)?.fileName === backupFileName,
      riskLevel: null, type: "restore-and-apply", outcome: "failed",
      timestamp: now(), output: err.message,
      phases,
    });
    return res.status(500).json({ ok: false, error: "Restore phase failed", phase: "restore", phases });
  }

  // Phase 2 — pre-apply validation (if validatable)
  let validation = null;
  if (file.validatable) {
    validation = validateFile(file.type, backupContent);
    if (validation.status === "red") {
      phases.push({ name: "validation_failed", status: "failed", timestamp: now(), detail: `${validation.errors?.length ?? 0} error(s)` });
      recordRestore({
        fileId: id, backupFileName,
        backupLabel: getBackupLabel(backupFileName)?.label ?? null,
        wasLkg: getKnownGood(id)?.fileName === backupFileName,
        riskLevel: null, type: "restore-and-apply", outcome: "failed",
        timestamp: now(), output: "Validation errors blocked apply",
        phases, validation,
      });
      return res.status(422).json({
        ok: false,
        phase: "validate",
        error: "Restored content has validation errors — apply skipped",
        safetyBackup: { fileName: safetyBackup.fileName, size: safetyBackup.size },
        validation,
        phases,
      });
    }
    phases.push({ name: "validation_passed", status: "ok", timestamp: now(), detail: validation.status });
  }

  // Phase 3 — apply
  phases.push({ name: "apply_started", status: "ok", timestamp: now(), detail: file.applyStrategy });
  const applyResult = applyFile(file.applyStrategy, file.applyPath);
  console.log(`[restore-and-apply] apply ${file.applyStrategy} → ${file.applyPath} — ${applyResult.ok ? "ok" : "failed"}`);
  phases.push({
    name: applyResult.ok ? "apply_completed" : "apply_failed",
    status: applyResult.ok ? "ok" : "failed",
    timestamp: now(),
    detail: applyResult.ok ? null : (applyResult.stderr || applyResult.output || null),
  });

  recordApply({
    fileId: file.id,
    strategy: file.applyStrategy,
    target: file.applyPath,
    timestamp: now(),
    ok: applyResult.ok,
    output: applyResult.output || "",
  });

  const raKg = getKnownGood(id);
  const raLabel = getBackupLabel(backupFileName);
  const rollbackRecommendation = applyResult.ok
    ? null
    : getRollbackRecommendation(id, backupFileName);

  recordRestore({
    fileId: id,
    backupFileName,
    backupLabel: raLabel?.label ?? null,
    wasLkg: raKg?.fileName === backupFileName,
    riskLevel: null,
    type: "restore-and-apply",
    outcome: applyResult.ok ? "success" : "failed",
    timestamp: now(),
    output: applyResult.output || null,
    phases,
    validation: validation ?? undefined,
    rollbackRecommendation: rollbackRecommendation ?? undefined,
  });

  const stats = fs.statSync(file.path);
  return res.status(applyResult.ok ? 200 : 500).json({
    ok: applyResult.ok,
    id,
    phase: applyResult.ok ? "done" : "apply",
    restoredFrom: backupFileName,
    safetyBackup: { fileName: safetyBackup.fileName, size: safetyBackup.size },
    validation,
    apply: {
      ok: applyResult.ok,
      action: file.applyStrategy,
      target: file.applyPath,
      output: applyResult.output,
      stdout: applyResult.stdout,
      stderr: applyResult.stderr,
      exitCode: applyResult.exitCode,
    },
    rollbackRecommendation,
    phases,
    file: { path: file.path, modifiedAt: stats.mtime.toISOString(), size: stats.size },
  });
});

// GET /api/files/backups/known-good?id=<fileId> — return LKG entry for a file
filesRouter.get("/backups/known-good", (req, res) => {
  const { id } = req.query;
  if (!id || typeof id !== "string") {
    return res.status(400).json({ ok: false, error: "File id is required" });
  }
  const file = getRegisteredFileById(id);
  if (!file) {
    return res.status(404).json({ ok: false, error: "File not found in registry" });
  }
  const knownGood = getKnownGood(id);
  res.json({ ok: true, knownGood });
});

// POST /api/files/backups/mark-known-good — mark a backup as Last-Known-Good
filesRouter.post("/backups/mark-known-good", (req, res) => {
  const { id, file: fileName } = req.body || {};
  if (!id || typeof id !== "string") {
    return res.status(400).json({ ok: false, error: "File id is required" });
  }
  if (!fileName || typeof fileName !== "string") {
    return res.status(400).json({ ok: false, error: "Backup file name is required" });
  }
  const file = getRegisteredFileById(id);
  if (!file) {
    return res.status(404).json({ ok: false, error: "File not found in registry" });
  }
  if (!fileName.startsWith(`${id}__`) || !fileName.endsWith(".bak")) {
    return res.status(403).json({ ok: false, error: "Backup does not belong to this file" });
  }
  // Confirm the backup actually exists before marking
  const content = readBackup(fileName);
  if (content === null) {
    return res.status(404).json({ ok: false, error: "Backup not found" });
  }
  const knownGood = markKnownGood(id, fileName);
  res.json({ ok: true, knownGood });
});

// GET /api/files/backups/labels?id=<fileId> — all labels for a file's backups
filesRouter.get("/backups/labels", (req, res) => {
  const { id } = req.query;
  if (!id || typeof id !== "string") {
    return res.status(400).json({ ok: false, error: "File id is required" });
  }
  const file = getRegisteredFileById(id);
  if (!file) {
    return res.status(404).json({ ok: false, error: "File not found in registry" });
  }
  const labels = getAllBackupLabelsForFile(id);
  res.json({ ok: true, labels });
});

// POST /api/files/backups/label — set or clear a label for a backup
filesRouter.post("/backups/label", (req, res) => {
  const { id, file: fileName, label } = req.body || {};
  if (!id || typeof id !== "string") {
    return res.status(400).json({ ok: false, error: "File id is required" });
  }
  if (!fileName || typeof fileName !== "string") {
    return res.status(400).json({ ok: false, error: "Backup file name is required" });
  }
  if (typeof label !== "string") {
    return res.status(400).json({ ok: false, error: "Label must be a string" });
  }
  const file = getRegisteredFileById(id);
  if (!file) {
    return res.status(404).json({ ok: false, error: "File not found in registry" });
  }
  if (!fileName.startsWith(`${id}__`) || !fileName.endsWith(".bak")) {
    return res.status(403).json({ ok: false, error: "Backup does not belong to this file" });
  }
  const content = readBackup(fileName);
  if (content === null) {
    return res.status(404).json({ ok: false, error: "Backup not found" });
  }
  const entry = setBackupLabel(id, fileName, label);
  res.json({ ok: true, file: fileName, label: entry?.label ?? "", updatedAt: entry?.updatedAt ?? null });
});

// POST /api/files/backups/prune-preview — compute prune candidates without deleting
filesRouter.post("/backups/prune-preview", (req, res) => {
  const { id, mode, keep, days } = req.body || {};
  if (!id || typeof id !== "string") {
    return res.status(400).json({ ok: false, error: "File id is required" });
  }
  if (mode !== "count" && mode !== "age") {
    return res.status(400).json({ ok: false, error: "mode must be 'count' or 'age'" });
  }
  if (mode === "count" && (typeof keep !== "number" || keep < 0)) {
    return res.status(400).json({ ok: false, error: "keep must be a non-negative number" });
  }
  if (mode === "age" && (typeof days !== "number" || days < 0)) {
    return res.status(400).json({ ok: false, error: "days must be a non-negative number" });
  }
  const file = getRegisteredFileById(id);
  if (!file) {
    return res.status(404).json({ ok: false, error: "File not found in registry" });
  }
  const policy = mode === "count" ? { mode, keep } : { mode, days };
  const plan = computePrunePlan(id, policy);
  return res.json({
    ok: true,
    mode,
    candidates: plan.candidates,
    protected: plan.protected,
    summary: { candidateCount: plan.candidates.length, protectedCount: plan.protected.length },
  });
});

// POST /api/files/backups/prune — delete prune candidates
filesRouter.post("/backups/prune", (req, res) => {
  const { id, mode, keep, days } = req.body || {};
  if (!id || typeof id !== "string") {
    return res.status(400).json({ ok: false, error: "File id is required" });
  }
  if (mode !== "count" && mode !== "age") {
    return res.status(400).json({ ok: false, error: "mode must be 'count' or 'age'" });
  }
  if (mode === "count" && (typeof keep !== "number" || keep < 0)) {
    return res.status(400).json({ ok: false, error: "keep must be a non-negative number" });
  }
  if (mode === "age" && (typeof days !== "number" || days < 0)) {
    return res.status(400).json({ ok: false, error: "days must be a non-negative number" });
  }
  const file = getRegisteredFileById(id);
  if (!file) {
    return res.status(404).json({ ok: false, error: "File not found in registry" });
  }
  const policy = mode === "count" ? { mode, keep } : { mode, days };
  const plan = computePrunePlan(id, policy);

  if (plan.candidates.length === 0) {
    return res.json({
      ok: true,
      deleted: [],
      protected: plan.protected,
      summary: { deletedCount: 0, protectedCount: plan.protected.length },
    });
  }

  const deleted = executeDeleteCandidates(plan.candidates);
  console.log(`[prune] ${id} — deleted ${deleted.length} backups (mode: ${mode})`);

  return res.json({
    ok: true,
    deleted,
    protected: plan.protected,
    summary: { deletedCount: deleted.length, protectedCount: plan.protected.length },
  });
});

// POST /api/files/restore-plan — generate a restore plan without touching the filesystem
filesRouter.post("/restore-plan", (req, res) => {
  const { id, file: backupFileName } = req.body || {};
  if (!id || typeof id !== "string") {
    return res.status(400).json({ ok: false, error: "File id is required" });
  }
  if (!backupFileName || typeof backupFileName !== "string") {
    return res.status(400).json({ ok: false, error: "Backup file name is required" });
  }
  const result = buildRestorePlan(id, backupFileName);
  if (!result.ok) {
    return res.status(result.error === "File not found in registry" ? 404 : 400).json(result);
  }
  return res.json(result);
});

// GET /api/files/restore-log[?fileId=<id>] — return restore history
filesRouter.get("/restore-log", (req, res) => {
  const { fileId } = req.query;
  const fileIdStr = typeof fileId === "string" && fileId.length > 0 ? fileId : undefined;
  try {
    const log = getRestoreLog(fileIdStr);
    res.json({ ok: true, log });
  } catch (err) {
    console.error("Failed to read restore log", err);
    res.status(500).json({ ok: false, error: "Failed to read restore log" });
  }
});

// GET /api/files/known-good-summary — LKG trust state for all registered files
filesRouter.get("/known-good-summary", (req, res) => {
  const files = listRegisteredFiles();
  const summary = {};

  for (const file of files) {
    const kg = getKnownGood(file.id);
    if (!kg) {
      summary[file.id] = { hasKnownGood: false, knownGoodFile: null, drifted: false };
      continue;
    }

    const kgContent = readBackup(kg.fileName);
    let drifted = false;
    if (kgContent !== null) {
      try {
        const liveContent = fs.existsSync(file.path) ? fs.readFileSync(file.path, "utf8") : "";
        drifted = liveContent !== kgContent;
      } catch {
        // can't read live file — assume aligned
      }
    }

    summary[file.id] = { hasKnownGood: true, knownGoodFile: kg.fileName, drifted };
  }

  res.json({ ok: true, files: summary });
});

// GET /api/files/apply-log[?fileId=<id>] — return apply history
filesRouter.get("/apply-log", (req, res) => {
  const { fileId } = req.query;
  const fileIdStr = typeof fileId === "string" && fileId.length > 0 ? fileId : undefined;
  try {
    const log = getApplyLog(fileIdStr);
    res.json({ ok: true, log });
  } catch (err) {
    console.error("Failed to read apply log", err);
    res.status(500).json({ ok: false, error: "Failed to read apply log" });
  }
});
