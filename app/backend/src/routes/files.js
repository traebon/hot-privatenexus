import fs from "fs";
import path from "path";
import { Router } from "express";
import { getRegisteredFileById, listRegisteredFiles } from "../filesRegistry.js";
import { readDraft, writeDraft } from "../drafts.js";
import { backupLiveFile } from "../fileBackups.js";
import { validateFile } from "../fileValidator.js";
import { applyFile } from "../fileApply.js";

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

  return res.status(status).json({
    ok: result.ok,
    id,
    action: file.applyStrategy,
    target: file.applyPath,
    output: result.output,
  });
});
