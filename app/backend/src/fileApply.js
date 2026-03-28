import path from "path";
import { execSync } from "child_process";

/**
 * Whitelisted apply strategies.
 * All commands are constructed from registry data only — no user input reaches exec.
 * Returns { ok: boolean, output: string }
 */
const HANDLERS = {
  "compose-up": (applyPath) => {
    const dir = path.dirname(applyPath);
    return run(`docker compose -f "${applyPath}" up -d 2>&1`, { cwd: dir, timeout: 90000 });
  },
  "caddy-reload": (applyPath) => {
    return run(`caddy reload --config "${applyPath}" 2>&1`, { timeout: 30000 });
  },
};

function run(cmd, opts = {}) {
  try {
    const output = execSync(cmd, { encoding: "utf8", ...opts });
    return { ok: true, output: output.trim() || "(no output)" };
  } catch (err) {
    const output = (err.stdout || "") + (err.stderr || "") || err.message;
    return { ok: false, output: output.trim() };
  }
}

export function applyFile(strategy, applyPath) {
  const handler = HANDLERS[strategy];
  if (!handler) return { ok: false, output: `Unknown apply strategy: ${strategy}` };
  return handler(applyPath);
}

export const KNOWN_STRATEGIES = Object.keys(HANDLERS);
