/**
 * Per-type file validators.
 * Returns { status: 'green' | 'amber' | 'red', issues: [{ level: 'error'|'warning', message }] }
 */
export function validateFile(type, content) {
  switch (type) {
    case "env":     return validateEnv(content);
    case "compose": return validateCompose(content);
    case "caddy":   return validateCaddy(content);
    default:        return { status: "green", issues: [] };
  }
}

// ---------------------------------------------------------------------------
// .env
// ---------------------------------------------------------------------------
function validateEnv(content) {
  const issues = [];
  const lines = content.split("\n");

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const lineNum = i + 1;
    const trimmed = line.trim();

    if (trimmed === "" || trimmed.startsWith("#")) continue;

    const eqIdx = line.indexOf("=");
    if (eqIdx === -1) {
      issues.push({ level: "error", message: `Line ${lineNum}: missing '=' — expected KEY=VALUE` });
      continue;
    }

    const key = line.slice(0, eqIdx);
    const value = line.slice(eqIdx + 1);

    if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(key)) {
      issues.push({ level: "error", message: `Line ${lineNum}: invalid key "${key}" — keys must be alphanumeric/underscore` });
    } else if (value.trim() === "") {
      issues.push({ level: "warning", message: `Line ${lineNum}: ${key} has an empty value` });
    }
  }

  return toResult(issues);
}

// ---------------------------------------------------------------------------
// docker-compose.yml
// ---------------------------------------------------------------------------
function validateCompose(content) {
  const issues = [];
  const lines = content.split("\n");

  // YAML forbids tab indentation
  for (let i = 0; i < lines.length; i++) {
    if (/^\t/.test(lines[i])) {
      issues.push({ level: "error", message: `Line ${i + 1}: YAML cannot use tabs for indentation` });
    }
  }

  // Must have a top-level services: key
  const servicesIdx = lines.findIndex((l) => /^services\s*:/.test(l));
  if (servicesIdx === -1) {
    issues.push({ level: "error", message: 'Missing top-level "services:" block' });
  } else {
    // services block should have at least one indented entry
    const rest = lines.slice(servicesIdx + 1).filter((l) => l.trim() !== "");
    if (rest.length === 0 || !/^\s+/.test(rest[0])) {
      issues.push({ level: "warning", message: '"services:" block appears to be empty' });
    }
  }

  // version: is deprecated in Compose v2+
  if (lines.some((l) => /^version\s*:/.test(l))) {
    issues.push({ level: "warning", message: '"version:" key is deprecated in Compose v2+ and can be removed' });
  }

  // Each service should have image: or build:
  const serviceIndentRe = /^  \S/; // 2-space indented top-level service names
  let inServicesBlock = false;
  for (const line of lines) {
    if (/^services\s*:/.test(line)) { inServicesBlock = true; continue; }
    if (inServicesBlock && /^\S/.test(line)) { inServicesBlock = false; }
    // We skip per-service image/build checks — too complex without a real YAML parser
  }

  return toResult(issues);
}

// ---------------------------------------------------------------------------
// Caddyfile
// ---------------------------------------------------------------------------
function validateCaddy(content) {
  const issues = [];
  const lines = content.split("\n");

  // Check brace balance
  let depth = 0;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    for (const ch of line) {
      if (ch === "{") depth++;
      else if (ch === "}") {
        depth--;
        if (depth < 0) {
          issues.push({ level: "error", message: `Line ${i + 1}: unexpected closing brace` });
          depth = 0;
        }
      }
    }
  }
  if (depth !== 0) {
    issues.push({ level: "error", message: `Unbalanced braces: ${depth} unclosed {` });
  }

  // Should have at least one site block
  const hasSiteBlock = lines.some((l) => l.includes("{") && !l.trim().startsWith("#"));
  if (!hasSiteBlock && content.trim().length > 0) {
    issues.push({ level: "warning", message: "No site blocks found — config may be empty or incomplete" });
  }

  // Warn if no common handler found
  if (hasSiteBlock) {
    const hasHandler =
      content.includes("reverse_proxy") ||
      content.includes("file_server") ||
      content.includes("respond") ||
      content.includes("redir");
    if (!hasHandler) {
      issues.push({ level: "warning", message: "No handler directive found (reverse_proxy, file_server, respond, redir)" });
    }
  }

  return toResult(issues);
}

// ---------------------------------------------------------------------------
// Shared
// ---------------------------------------------------------------------------
function toResult(issues) {
  const hasError = issues.some((i) => i.level === "error");
  const status = hasError ? "red" : issues.length > 0 ? "amber" : "green";
  return { status, issues };
}
