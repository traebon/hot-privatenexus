import fs from "fs";
import path from "path";
import { Router } from "express";
import { getRegisteredFileById, listRegisteredFiles } from "../filesRegistry.js";
import { readDraft, writeDraft } from "../drafts.js";
import { backupLiveFile } from "../fileBackups.js";

export const filesRouter = Router();

// GET /api/files — list all registered files with metadata + draft state
filesRouter.get("/", (_req, res) => {
  try {
    res.json(listRegisteredFiles());
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
