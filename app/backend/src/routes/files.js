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

// POST /api/files/restore — restore a backup to live (safety-backup current live first)
filesRouter.post("/restore", (req, res) => {
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

  // Guard: backup must belong to this file id (same prefix check as backups/read)
  if (!backupFileName.startsWith(`${id}__`) || !backupFileName.endsWith(".bak")) {
    return res.status(403).json({ ok: false, error: "Backup does not belong to this file" });
  }

  // Read backup content (readBackup also guards against path traversal)
  const backupContent = readBackup(backupFileName);
  if (backupContent === null) {
    return res.status(404).json({ ok: false, error: "Backup not found" });
  }

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

    return res.json({
      ok: true,
      id,
      restoredFrom: backupFileName,
      safetyBackup: { fileName: safetyBackup.fileName, size: safetyBackup.size },
      file: { path: file.path, modifiedAt: stats.mtime.toISOString(), size: stats.size },
    });
  } catch (err) {
    console.error(`Failed to restore ${id} from ${backupFileName}`, err);
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

  // Phase 1 — safety backup + restore
  let safetyBackup;
  try {
    const currentContent = fs.existsSync(file.path)
      ? fs.readFileSync(file.path, "utf8")
      : "";
    safetyBackup = backupLiveFile(id, file.path, currentContent);
    fs.writeFileSync(file.path, backupContent, "utf8");
    console.log(`[restore-and-apply] restored ${id} ← ${backupFileName}`);
  } catch (err) {
    console.error(`Failed to restore ${id}`, err);
    return res.status(500).json({ ok: false, error: "Restore phase failed", phase: "restore" });
  }

  // Phase 2 — pre-apply validation (if validatable)
  if (file.validatable) {
    const validation = validateFile(file.type, backupContent);
    if (validation.status === "red") {
      return res.status(422).json({
        ok: false,
        phase: "validate",
        error: "Restored content has validation errors — apply skipped",
        safetyBackup: { fileName: safetyBackup.fileName, size: safetyBackup.size },
        validation,
      });
    }
  }

  // Phase 3 — apply
  const applyResult = applyFile(file.applyStrategy, file.applyPath);
  console.log(`[restore-and-apply] apply ${file.applyStrategy} → ${file.applyPath} — ${applyResult.ok ? "ok" : "failed"}`);

  recordApply({
    fileId: file.id,
    strategy: file.applyStrategy,
    target: file.applyPath,
    timestamp: new Date().toISOString(),
    ok: applyResult.ok,
    output: applyResult.output || "",
  });

  const stats = fs.statSync(file.path);
  return res.status(applyResult.ok ? 200 : 500).json({
    ok: applyResult.ok,
    id,
    phase: applyResult.ok ? "done" : "apply",
    restoredFrom: backupFileName,
    safetyBackup: { fileName: safetyBackup.fileName, size: safetyBackup.size },
    apply: {
      ok: applyResult.ok,
      action: file.applyStrategy,
      target: file.applyPath,
      output: applyResult.output,
    },
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
