import path from "path";
import { spawnSync } from "child_process";

// Command array form — never shell: true, never interpolated strings.
// All args are passed as discrete elements to avoid shell injection.
const HANDLERS = {
  "compose-up": (applyPath) => {
    const dir = path.dirname(applyPath);
    return run(["docker", "compose", "-f", applyPath, "up", "-d"], { cwd: dir, timeout: 90000 });
  },
  "caddy-reload": (applyPath) => {
    return run(["caddy", "reload", "--config", applyPath], { timeout: 30000 });
  },
};

function run(argv, opts = {}) {
  const { timeout = 60000, cwd } = opts;
  const [cmd, ...args] = argv;
  const result = spawnSync(cmd, args, { shell: false, encoding: "utf8", timeout, cwd });
  const stdout = (result.stdout || "").trim();
  const stderr = (result.stderr || "").trim();
  const exitCode = result.status ?? -1;
  const ok = exitCode === 0 && !result.error;
  const output = [stdout, stderr].filter(Boolean).join("\n") || "(no output)";
  return { ok, output, stdout, stderr, exitCode };
}

export function applyFile(strategy, applyPath) {
  const handler = HANDLERS[strategy];
  if (!handler) {
    const msg = `Unknown apply strategy: ${strategy}`;
    return { ok: false, output: msg, stdout: "", stderr: msg, exitCode: -1 };
  }
  return handler(applyPath);
}

export const KNOWN_STRATEGIES = Object.keys(HANDLERS);
