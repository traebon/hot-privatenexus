import fs from "fs";
import path from "path";
import { Router } from "express";
import { getRegisteredFileById, listRegisteredFiles } from "../filesRegistry.js";

export const filesRouter = Router();

// GET /api/files — list all registered files with metadata
filesRouter.get("/", (_req, res) => {
  try {
    res.json(listRegisteredFiles());
  } catch (err) {
    console.error("Failed to list files", err);
    res.status(500).json({ ok: false, error: "Failed to list files" });
  }
});

// GET /api/files/read?id=<id> — read a whitelisted file
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
    });
  } catch (err) {
    console.error(`Failed to read file: ${file.path}`, err);
    res.status(500).json({ ok: false, error: "Failed to read file" });
  }
});
