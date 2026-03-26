import { Router } from "express";
import os from "os";
import { execSync } from "child_process";

export const metricsRouter = Router();

const history = {
  cpu: [],
  memory: [],
  storage: [],
  network: [],
};

const MAX_POINTS = 10;

function pushPoint(key, value) {
  history[key].push(value);
  if (history[key].length > MAX_POINTS) {
    history[key].shift();
  }
}

let previousCpuTimes = null;
let previousNetBytes = null;
let previousNetTs = null;

function sampleCpuPercent() {
  const cpus = os.cpus();

  const totals = cpus.map((cpu) => {
    const t = cpu.times;
    return {
      idle: t.idle,
      total: t.user + t.nice + t.sys + t.idle + t.irq,
    };
  });

  if (!previousCpuTimes) {
    previousCpuTimes = totals;
    return 0;
  }

  let idleDiff = 0;
  let totalDiff = 0;

  totals.forEach((curr, idx) => {
    const prev = previousCpuTimes[idx];
    idleDiff += curr.idle - prev.idle;
    totalDiff += curr.total - prev.total;
  });

  previousCpuTimes = totals;

  if (totalDiff <= 0) return 0;
  return Math.max(0, Math.min(100, Math.round((1 - idleDiff / totalDiff) * 100)));
}

function sampleMemoryPercent() {
  const total = os.totalmem();
  const free = os.freemem();
  return Math.max(0, Math.min(100, Math.round(((total - free) / total) * 100)));
}

function sampleStoragePercent() {
  try {
    const output = execSync("df -P / | awk 'NR==2 {print $5}'", { encoding: "utf8" }).trim();
    return Math.max(0, Math.min(100, parseInt(output.replace("%", ""), 10) || 0));
  } catch {
    return 0;
  }
}

function getPrimaryInterface() {
  const nets = os.networkInterfaces();
  for (const [name, entries] of Object.entries(nets)) {
    if (!entries) continue;
    const hasIpv4 = entries.some((e) => e.family === "IPv4" && !e.internal);
    if (hasIpv4 && !name.startsWith("lo")) return name;
  }
  return null;
}

function readNetworkCounters(iface) {
  try {
    const rx = Number(execSync(`cat /sys/class/net/${iface}/statistics/rx_bytes`, { encoding: "utf8" }).trim());
    const tx = Number(execSync(`cat /sys/class/net/${iface}/statistics/tx_bytes`, { encoding: "utf8" }).trim());
    return rx + tx;
  } catch {
    return null;
  }
}

function sampleNetworkMbps() {
  const iface = getPrimaryInterface();
  if (!iface) return 0;

  const totalBytes = readNetworkCounters(iface);
  const now = Date.now();

  if (totalBytes == null) return 0;

  if (previousNetBytes == null || previousNetTs == null) {
    previousNetBytes = totalBytes;
    previousNetTs = now;
    return 0;
  }

  const bytesDiff = totalBytes - previousNetBytes;
  const secondsDiff = (now - previousNetTs) / 1000;

  previousNetBytes = totalBytes;
  previousNetTs = now;

  if (secondsDiff <= 0 || bytesDiff < 0) return 0;

  const mbps = (bytesDiff * 8) / secondsDiff / 1_000_000;
  return Math.max(0, Math.round(mbps));
}

let lastCollectedAt = null;

function collectMetrics() {
  pushPoint("cpu", sampleCpuPercent());
  pushPoint("memory", sampleMemoryPercent());
  pushPoint("storage", sampleStoragePercent());
  pushPoint("network", sampleNetworkMbps());
  lastCollectedAt = new Date().toISOString();
}

for (let i = 0; i < MAX_POINTS; i++) {
  collectMetrics();
}

setInterval(collectMetrics, 2 * 60 * 1000);

metricsRouter.get("/", (_req, res) => {
  res.json({
    cpu: history.cpu,
    memory: history.memory,
    storage: history.storage,
    network: history.network,
    collectedAt: lastCollectedAt,
    latest: {
      cpu: history.cpu[history.cpu.length - 1] ?? null,
      memory: history.memory[history.memory.length - 1] ?? null,
      storage: history.storage[history.storage.length - 1] ?? null,
      network: history.network[history.network.length - 1] ?? null,
      timestamp: lastCollectedAt,
    },
  });
});
