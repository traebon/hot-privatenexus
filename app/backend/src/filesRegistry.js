import fs from "fs";
import path from "path";

const REGISTRY = [
  {
    id: "caddyfile",
    label: "Caddy Config",
    type: "caddy",
    path: "/etc/caddy/Caddyfile",
    stack: "gateway",
    editable: true,
    validatable: true,
  },
  {
    id: "privatenexus-frontend-env",
    label: "PrivateNexus Frontend Env",
    type: "env",
    path: "/root/privatenexus/app/frontend/.env",
    stack: "privatenexus",
    editable: true,
    validatable: true,
  },
  {
    id: "privatenexus-backend-server",
    label: "PrivateNexus Backend Server",
    type: "javascript",
    path: "/root/privatenexus/app/backend/src/server.js",
    stack: "privatenexus",
    editable: true,
    validatable: false,
  },
  {
    id: "privatenexus-compose",
    label: "PrivateNexus Compose",
    type: "compose",
    path: "/root/privatenexus/compose/docker-compose.yml",
    stack: "privatenexus",
    editable: true,
    validatable: true,
  },
];

function getFileStats(filePath) {
  try {
    const stats = fs.statSync(filePath);
    return {
      exists: true,
      size: stats.size,
      modifiedAt: stats.mtime.toISOString(),
    };
  } catch {
    return {
      exists: false,
      size: 0,
      modifiedAt: null,
    };
  }
}

export function listRegisteredFiles() {
  return REGISTRY.map((entry) => ({
    ...entry,
    ...getFileStats(entry.path),
    fileName: path.basename(entry.path),
  }));
}

export function getRegisteredFileById(id) {
  return REGISTRY.find((entry) => entry.id === id) || null;
}
