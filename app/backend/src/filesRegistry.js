import fs from "fs";
import path from "path";
import { hasDraft, readDraft } from "./drafts.js";

const REGISTRY_PATH = "/opt/privatenexus/data/file-registry.json";
const DEFAULTS = [
  {
    id: "privatenexus-compose",
    label: "PrivateNexus Compose",
    type: "compose",
    path: "/opt/privatenexus/compose/docker-compose.yml",
    stack: "privatenexus",
    editable: true,
    validatable: true,
    primary: true,
    applyStrategy: "compose-up",
    applyPath: "/opt/privatenexus/compose/docker-compose.yml",
    dependsOn: [],
  },
  {
    id: "privatenexus-backend-server",
    label: "PrivateNexus Backend",
    type: "javascript",
    path: "/opt/privatenexus/app/backend/src/server.js",
    stack: "privatenexus",
    editable: true,
    validatable: false,
    primary: false,
    applyStrategy: null,
    applyPath: null,
    dependsOn: [],
  },
  {
    id: "privatenexus-frontend-env",
    label: "PrivateNexus Frontend Env",
    type: "env",
    path: "/opt/privatenexus/app/frontend/.env",
    stack: "privatenexus",
    editable: true,
    validatable: false,
    primary: false,
    applyStrategy: "compose-up",
    applyPath: "/opt/privatenexus/compose/docker-compose.yml",
    dependsOn: [],
  },
];

function ensureDataDir() {
  const dir = path.dirname(REGISTRY_PATH);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function loadRegistry() {
  try {
    if (fs.existsSync(REGISTRY_PATH)) {
      const extra = JSON.parse(fs.readFileSync(REGISTRY_PATH, "utf8"));
      // Merge: defaults first, then any custom entries not already in defaults
      const defaultIds = new Set(DEFAULTS.map((d) => d.id));
      return [...DEFAULTS, ...extra.filter((e) => !defaultIds.has(e.id))];
    }
  } catch {}
  return [...DEFAULTS];
}

function saveRegistry(entries) {
  ensureDataDir();
  // Only persist non-default entries
  const defaultIds = new Set(DEFAULTS.map((d) => d.id));
  const custom = entries.filter((e) => !defaultIds.has(e.id));
  fs.writeFileSync(REGISTRY_PATH, JSON.stringify(custom, null, 2), "utf8");
}

function getFileStats(filePath) {
  try {
    const stats = fs.statSync(filePath);
    return { exists: true, size: stats.size, modifiedAt: stats.mtime.toISOString() };
  } catch {
    return { exists: false, size: 0, modifiedAt: null };
  }
}

export function listRegisteredFiles() {
  return loadRegistry().map((entry) => ({
    ...entry,
    ...getFileStats(entry.path),
    fileName: path.basename(entry.path),
    hasDraft: hasDraft(entry.id),
    draftModifiedAt: (() => { const d = readDraft(entry.id); return d ? d.modifiedAt : null; })(),
    draftSize: (() => { const d = readDraft(entry.id); return d ? d.size : 0; })(),
  }));
}

export function getRegisteredFileById(id) {
  return loadRegistry().find((e) => e.id === id) || null;
}

export function registerFile(entry) {
  const registry = loadRegistry();
  if (registry.find((e) => e.id === entry.id)) {
    throw new Error(`ID "${entry.id}" already registered`);
  }
  registry.push(entry);
  saveRegistry(registry);
  return entry;
}

export function unregisterFile(id) {
  const defaultIds = new Set(DEFAULTS.map((d) => d.id));
  if (defaultIds.has(id)) throw new Error("Cannot unregister a built-in file entry");
  const registry = loadRegistry();
  const idx = registry.findIndex((e) => e.id === id);
  if (idx === -1) throw new Error("Not found");
  registry.splice(idx, 1);
  saveRegistry(registry);
}
