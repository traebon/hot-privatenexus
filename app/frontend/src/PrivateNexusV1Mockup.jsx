import React, { useEffect, useMemo, useState } from "react";

export default function PrivateNexusV1Mockup() {
  const API_BASE = import.meta.env.VITE_API_URL || "http://127.0.0.1:3001";

  // -------------------------------------------------------------------------
  // Inner component — live Docker data, fully self-contained
  // -------------------------------------------------------------------------
  function StacksBoard() {
    const [projects, setProjects] = useState([]);
    const [total, setTotal] = useState(0);
    const [stacksError, setStacksError] = useState(false);
    const [actionPending, setActionPending] = useState(null); // "containerId:action"
    const [logsTarget, setLogsTarget] = useState(null);       // { id, name }
    const [logsLines, setLogsLines] = useState([]);
    const [logsLoading, setLogsLoading] = useState(false);

    const stateStyle = {
      running: "bg-emerald-500/20 text-emerald-300 border-emerald-500/30",
      exited:  "bg-neutral-700/60 text-neutral-400 border-neutral-600/30",
      paused:  "bg-amber-500/20 text-amber-300 border-amber-500/30",
      partial: "bg-amber-500/20 text-amber-300 border-amber-500/30",
      stopped: "bg-neutral-700/60 text-neutral-400 border-neutral-600/30",
    };

    const loadStacks = async () => {
      try {
        const res = await fetch(`${API_BASE}/api/stacks`);
        const data = await res.json();
        setProjects(data.projects || []);
        setTotal(data.total || 0);
        setStacksError(false);
      } catch {
        setStacksError(true);
      }
    };

    useEffect(() => {
      loadStacks();
      const interval = setInterval(loadStacks, 15000);
      return () => clearInterval(interval);
    }, []);

    const runAction = async (containerId, action) => {
      const key = `${containerId}:${action}`;
      setActionPending(key);
      try {
        await fetch(`${API_BASE}/api/actions/run`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action, target: containerId }),
        });
        await loadStacks();
      } finally {
        setActionPending(null);
      }
    };

    const openLogs = async (container) => {
      setLogsTarget(container);
      setLogsLines([]);
      setLogsLoading(true);
      try {
        const res = await fetch(`${API_BASE}/api/stacks/${container.id}/logs?tail=100`);
        const data = await res.json();
        setLogsLines(data.lines || []);
      } catch {
        setLogsLines(["Failed to fetch logs."]);
      } finally {
        setLogsLoading(false);
      }
    };

    const runningCount = projects.reduce((n, p) => n + p.containers.filter((c) => c.state === "running").length, 0);

    return (
      <div className="space-y-4">
        {/* Header */}
        <div className="rounded-2xl border border-amber-400/20 bg-gradient-to-r from-amber-500/10 via-orange-500/10 to-yellow-500/10 p-4">
          <div className="flex items-center justify-between">
            <div>
              <div className="text-xs uppercase tracking-wider text-amber-300/80">Live Docker</div>
              <div className="text-lg font-semibold">Stack Control Center</div>
            </div>
            <div className="flex items-center gap-2">
              <span className="rounded-full bg-emerald-500/20 px-2 py-1 text-xs text-emerald-300">{runningCount} running</span>
              <span className="rounded-full bg-neutral-700/60 px-2 py-1 text-xs text-neutral-400">{total} total</span>
              <button
                onClick={loadStacks}
                className="rounded-lg border border-amber-400/20 bg-amber-500/10 px-3 py-1 text-xs text-amber-300 hover:bg-amber-500/20"
              >
                Refresh
              </button>
            </div>
          </div>
          {stacksError && (
            <div className="mt-2 text-xs text-rose-400">Docker socket unavailable — cannot list containers.</div>
          )}
        </div>

        {/* Projects */}
        {projects.length === 0 && !stacksError && (
          <div className="rounded-2xl border border-neutral-800 bg-neutral-900/70 p-6 text-center text-sm text-neutral-500">
            No containers found on this host.
          </div>
        )}

        {projects.map((p) => (
          <div key={p.project} className="rounded-2xl border border-amber-400/20 bg-neutral-900/80 p-4">
            <div className="mb-3 flex items-center justify-between">
              <div className="flex items-center gap-2">
                <span className="font-semibold">{p.project === "__standalone__" ? "Standalone" : p.project}</span>
                <span className={["rounded-full border px-2 py-0.5 text-[10px]", stateStyle[p.state] || stateStyle.stopped].join(" ")}>
                  {p.state}
                </span>
              </div>
              <span className="text-xs text-neutral-500">{p.containers.length} container{p.containers.length !== 1 ? "s" : ""}</span>
            </div>

            <div className="space-y-2">
              {p.containers.map((c) => {
                const isRunning = c.state === "running";
                return (
                  <div key={c.id} className="flex items-center justify-between rounded-xl border border-neutral-800 bg-neutral-800/60 px-3 py-2">
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <span className={["h-2 w-2 shrink-0 rounded-full", isRunning ? "bg-emerald-400" : "bg-neutral-600"].join(" ")} />
                        <span className="truncate text-sm font-medium">{c.name}</span>
                      </div>
                      <div className="mt-0.5 truncate pl-4 text-[10px] text-neutral-500">
                        {c.image} · {c.status}
                        {c.ports.length > 0 && ` · ${c.ports.join(", ")}`}
                      </div>
                    </div>

                    <div className="ml-3 flex shrink-0 gap-1.5">
                      {isRunning ? (
                        <>
                          <button
                            disabled={!!actionPending}
                            onClick={() => runAction(c.id, "restart")}
                            className="rounded-lg border border-amber-400/20 bg-amber-500/10 px-2 py-1 text-[10px] text-amber-300 hover:bg-amber-500/20 disabled:opacity-40"
                          >
                            {actionPending === `${c.id}:restart` ? "…" : "Restart"}
                          </button>
                          <button
                            disabled={!!actionPending}
                            onClick={() => runAction(c.id, "stop")}
                            className="rounded-lg border border-rose-400/20 bg-rose-500/10 px-2 py-1 text-[10px] text-rose-300 hover:bg-rose-500/20 disabled:opacity-40"
                          >
                            {actionPending === `${c.id}:stop` ? "…" : "Stop"}
                          </button>
                        </>
                      ) : (
                        <button
                          disabled={!!actionPending}
                          onClick={() => runAction(c.id, "start")}
                          className="rounded-lg border border-emerald-400/20 bg-emerald-500/10 px-2 py-1 text-[10px] text-emerald-300 hover:bg-emerald-500/20 disabled:opacity-40"
                        >
                          {actionPending === `${c.id}:start` ? "…" : "Start"}
                        </button>
                      )}
                      <button
                        onClick={() => openLogs(c)}
                        className="rounded-lg border border-neutral-700 bg-neutral-800/80 px-2 py-1 text-[10px] text-neutral-300 hover:border-cyan-400/30"
                      >
                        Logs
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        ))}

        {/* Logs drawer */}
        {logsTarget && (
          <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/70 p-4">
            <div className="w-full max-w-4xl rounded-2xl border border-cyan-400/20 bg-neutral-900 p-4 shadow-2xl">
              <div className="mb-3 flex items-center justify-between">
                <div>
                  <div className="font-semibold">{logsTarget.name}</div>
                  <div className="text-xs text-neutral-500">Last 100 lines</div>
                </div>
                <button onClick={() => setLogsTarget(null)} className="text-xs text-neutral-400 hover:text-white">Close</button>
              </div>
              <div className="h-80 overflow-y-auto rounded-xl border border-neutral-800 bg-neutral-950 p-3 font-mono text-[11px] text-neutral-300">
                {logsLoading ? (
                  <div className="text-neutral-500">Loading…</div>
                ) : logsLines.length === 0 ? (
                  <div className="text-neutral-500">No log output.</div>
                ) : (
                  logsLines.map((line, i) => <div key={i}>{line}</div>)
                )}
              </div>
            </div>
          </div>
        )}
      </div>
    );
  }

  // -------------------------------------------------------------------------
  // State
  // -------------------------------------------------------------------------
  const [activeBoard, setActiveBoard] = useState("Home");
  const [confirmAction, setConfirmAction] = useState(null);
  const [logs, setLogs] = useState([]);
  const [adminView, setAdminView] = useState(null);
  const [showAllApps, setShowAllApps] = useState(false);
  const [appSearch, setAppSearch] = useState("");
  const [appCategory, setAppCategory] = useState("All");
  const [backupData, setBackupData] = useState(null);
  const [networkData, setNetworkData] = useState(null);
  const [metricsData, setMetricsData] = useState({ cpu: [], memory: [], storage: [], network: [] });
  const [metricsError, setMetricsError] = useState(false);
  const [loading, setLoading] = useState(true);

  // -------------------------------------------------------------------------
  // API — backup and network come from the backend; app/service data is static
  // -------------------------------------------------------------------------
  useEffect(() => {
    fetch(`${API_BASE}/api/admin/backup`)
      .then((res) => res.json())
      .then((data) => setBackupData(data))
      .catch((err) => console.error("Failed to load backup data", err));

    fetch(`${API_BASE}/api/admin/network`)
      .then((res) => res.json())
      .then((data) => setNetworkData(data))
      .catch((err) => console.error("Failed to load network data", err));
  }, [API_BASE]);

  useEffect(() => {
    let mounted = true;

    const loadMetrics = async () => {
      try {
        const res = await fetch(`${API_BASE}/api/metrics`);
        const data = await res.json();
        if (mounted) {
          setMetricsData(data);
          setMetricsError(false);
        }
      } catch (err) {
        console.error("Failed to load metrics", err);
        if (mounted) setMetricsError(true);
      } finally {
        if (mounted) setLoading(false);
      }
    };

    loadMetrics();
    const interval = setInterval(loadMetrics, 180000);

    return () => {
      mounted = false;
      clearInterval(interval);
    };
  }, [API_BASE]);

  // -------------------------------------------------------------------------
  // Static data
  // -------------------------------------------------------------------------
  const user = { name: "Trae", role: "Superadmin", realm: "PrivateNexus" };

  const announcements = [
    { title: "Major system error", level: "critical" },
    { title: "Updates available", level: "warning" },
    { title: "Backup OK", level: "info" },
  ];

  const boards = ["Home", "Ops", "Admin", "Stacks", "Emergency"];

  const boardThemes = {
    Home:      { active: "from-cyan-400 to-blue-500",    ring: "border-cyan-400/30",    hover: "hover:border-cyan-400/30",    shell: "from-cyan-500/10 to-blue-500/5" },
    Ops:       { active: "from-emerald-400 to-green-500", ring: "border-emerald-400/30", hover: "hover:border-emerald-400/30", shell: "from-emerald-500/10 to-green-500/5" },
    Admin:     { active: "from-purple-400 to-indigo-500", ring: "border-purple-400/30",  hover: "hover:border-purple-400/30",  shell: "from-purple-500/10 to-indigo-500/5" },
    Stacks:    { active: "from-amber-400 to-orange-500",  ring: "border-amber-400/30",   hover: "hover:border-amber-400/30",   shell: "from-amber-500/10 to-orange-500/5" },
    Emergency: { active: "from-rose-400 to-pink-500",     ring: "border-rose-400/30",    hover: "hover:border-rose-400/30",    shell: "from-rose-500/10 to-pink-500/5" },
  };

  const theme = boardThemes[activeBoard];

  const services = [
    { name: "Nextcloud",  cpu: 24, mem: 62 },
    { name: "Immich",     cpu: 71, mem: 78 },
    { name: "Notesnook", cpu: 9,  mem: 31 },
    { name: "Paperless",  cpu: 0,  mem: 0 },
  ];

  const recentApps = [
    { name: "Nextcloud",  logo: "☁️",  category: "Cloud" },
    { name: "Immich",     logo: "🖼️", category: "Media" },
    { name: "Notesnook", logo: "📝", category: "Notes" },
    { name: "Paperless",  logo: "📄", category: "Docs" },
    { name: "Grafana",    logo: "📊", category: "Monitoring" },
  ];

  const allApps = [
    { name: "Nextcloud",    logo: "☁️",  category: "Cloud",       meta: "Files · Sync" },
    { name: "Immich",       logo: "🖼️", category: "Media",       meta: "Photos · ML" },
    { name: "Notesnook",   logo: "📝", category: "Notes",       meta: "Vault · Secure" },
    { name: "Paperless",    logo: "📄", category: "Docs",        meta: "OCR · Archive" },
    { name: "Grafana",      logo: "📊", category: "Monitoring",  meta: "Dashboards" },
    { name: "Uptime Kuma",  logo: "🟢", category: "Monitoring",  meta: "Status checks" },
    { name: "Keycloak",     logo: "🛡️", category: "Identity",    meta: "SSO · MFA" },
    { name: "Caddy",        logo: "🌐", category: "Infra",       meta: "Reverse proxy" },
    { name: "Backups",      logo: "💾", category: "Infra",       meta: "Snapshots · Restore" },
    { name: "Portainer",    logo: "🐳", category: "Infra",       meta: "Containers" },
    { name: "Loki",         logo: "📚", category: "Monitoring",  meta: "Logs" },
    { name: "Admin Panel",  logo: "⚙️", category: "Identity",    meta: "Users · Policies" },
  ];

  const appCategories = ["All", "Cloud", "Media", "Notes", "Docs", "Monitoring", "Identity", "Infra"];

  const filteredApps = allApps.filter((app) => {
    const matchesCategory = appCategory === "All" || app.category === appCategory;
    const search = appSearch.trim().toLowerCase();
    const matchesSearch = !search || app.name.toLowerCase().includes(search) || app.meta.toLowerCase().includes(search);
    return matchesCategory && matchesSearch;
  });

  const announcementStyles = useMemo(
    () => ({
      critical: "border-rose-400/30 bg-rose-500/10",
      warning:  "border-amber-400/30 bg-amber-500/10",
      info:     "border-cyan-400/30 bg-cyan-500/10",
    }),
    []
  );

  // -------------------------------------------------------------------------
  // Ops board — graph helpers
  // -------------------------------------------------------------------------
  const graphSeries = {
    cpu:     metricsData.cpu.length     ? metricsData.cpu     : [42, 51, 48, 63, 57, 66, 52, 60, 55, 48],
    memory:  metricsData.memory.length  ? metricsData.memory  : [58, 59, 60, 61, 62, 63, 64, 63, 62, 63],
    storage: metricsData.storage.length ? metricsData.storage : [68, 68, 69, 69, 70, 70, 71, 71, 71, 71],
    network: metricsData.network.length ? metricsData.network : [320, 410, 560, 620, 710, 842, 690, 760, 720, 680],
  };

  const xLabels = ["-45m", "-35m", "-25m", "-15m", "now"];

  function buildPoints(data, maxValue) {
    const min = Math.min(...data);
    const max = Math.max(...data);
    const paddedMin = Math.max(0, min - (max - min || 5) * 0.25);
    const paddedMax = Math.min(maxValue, max + (max - min || 5) * 0.25);
    const range = paddedMax - paddedMin || 1;

    return data
      .map((value, idx) => {
        const x = (idx / (data.length - 1)) * 100;
        const y = 40 - ((value - paddedMin) / range) * 40;
        return `${x},${y}`;
      })
      .join(" ");
  }

  // -------------------------------------------------------------------------
  // Action handlers
  // -------------------------------------------------------------------------
  function executeAction(item) {
    setLogs((prev) => [`[${new Date().toLocaleTimeString()}] Executed: ${item.name}`, ...prev]);
    setConfirmAction(null);
  }

  function handleAction(item) {
    if (item.variant === "danger") {
      setConfirmAction(item);
      return;
    }
    executeAction(item);
  }

  // -------------------------------------------------------------------------
  // Shared card renderer — theme-aware, handles safe/danger/neutral variants
  // -------------------------------------------------------------------------
  function renderCards(items) {
    return (
      <div className="grid grid-cols-2 gap-4">
        {items.map((item, idx) => {
          const base = [
            "p-4 bg-neutral-900/70 bg-gradient-to-br rounded-2xl border border-neutral-800 transition cursor-pointer",
            theme.shell,
            theme.hover,
          ].join(" ");

          const variantMap = {
            safe:    "border-cyan-400/30 bg-gradient-to-br from-cyan-500/10 to-blue-500/5 hover:border-cyan-400/50",
            danger:  "border-rose-400/30 bg-gradient-to-br from-rose-500/10 to-pink-500/5 hover:border-rose-400/50",
            neutral: "",
          };

          const variantClass = item.variant ? variantMap[item.variant] : variantMap.neutral;
          const glow =
            item.variant === "safe" && activeBoard === "Emergency" && idx === 0
              ? "ring-2 ring-cyan-400/40 shadow-[0_0_20px_rgba(34,211,238,0.15)]"
              : "";

          const onClick = item.onClick ? item.onClick : () => handleAction(item);

          return (
            <div key={item.name || item.title} onClick={onClick} className={[base, variantClass, glow].join(" ").trim()}>
              <div className="font-semibold">{item.name || item.title}</div>
              {item.cpu !== undefined && item.mem !== undefined && (
                <div className="mt-1 text-xs text-neutral-400">CPU {item.cpu}% · RAM {item.mem}%</div>
              )}
            </div>
          );
        })}
      </div>
    );
  }

  // -------------------------------------------------------------------------
  // Board views — defined as JSX variables so they don't create new references
  // on every render (no inline function components)
  // -------------------------------------------------------------------------
  const homeView = (
    <div className="space-y-4">
      <div className="rounded-2xl border border-cyan-400/20 bg-gradient-to-r from-cyan-500/10 via-blue-500/10 to-indigo-500/10 p-4">
        <div className="flex items-center justify-between">
          <div>
            <div className="text-xs uppercase tracking-wider text-cyan-300/80">Command Center</div>
            <div className="text-lg font-semibold">System Overview</div>
          </div>
          <div className="flex items-center gap-2">
            <span className="rounded-full bg-emerald-500/20 px-2 py-1 text-xs text-emerald-300">All Systems Nominal</span>
            <span className="rounded-full bg-blue-500/20 px-2 py-1 text-xs text-blue-300">Uptime 99.98%</span>
            <button
              onClick={() => setShowAllApps(true)}
              className="ml-2 rounded-lg border border-cyan-400/30 bg-cyan-500/10 px-3 py-1 text-xs text-cyan-300 hover:bg-cyan-500/20"
            >
              All Apps
            </button>
          </div>
        </div>
      </div>

      <div className={["rounded-2xl border border-cyan-400/20 bg-neutral-900/70 bg-gradient-to-br p-4", theme.shell].join(" ")}>
        <div className="mb-3 text-sm font-semibold text-neutral-200">Recently Used</div>
        <div className="flex items-center gap-3 overflow-x-auto">
          {recentApps.slice(0, 5).map((app, index) => (
            <div
              key={app.name}
              title={app.name}
              className={
                index === 0
                  ? "flex h-14 w-14 shrink-0 items-center justify-center rounded-2xl border border-cyan-400/40 bg-gradient-to-br from-cyan-500/20 to-blue-500/10 text-2xl shadow-[0_0_20px_rgba(34,211,238,0.15)]"
                  : "flex h-14 w-14 shrink-0 items-center justify-center rounded-2xl border border-neutral-800 bg-neutral-800/80 text-2xl transition hover:border-cyan-400/30 hover:bg-neutral-700/80"
              }
            >
              <span aria-hidden="true">{app.logo}</span>
            </div>
          ))}
        </div>
      </div>

      <div className="grid grid-cols-2 gap-4">
        <div className="rounded-2xl border border-cyan-400/20 bg-gradient-to-br from-cyan-500/10 to-blue-500/5 p-4">
          <div className="font-semibold">System Overview</div>
          <div className="mt-1 text-xs text-neutral-300">CPU 32% · RAM 58%</div>
        </div>
        <div className="rounded-2xl border border-emerald-400/20 bg-gradient-to-br from-emerald-500/10 to-green-500/5 p-4">
          <div className="font-semibold">Active Services</div>
          <div className="mt-1 text-xs text-neutral-300">21 running</div>
        </div>
        <div className="rounded-2xl border border-amber-400/20 bg-gradient-to-br from-amber-500/10 to-orange-500/5 p-4">
          <div className="font-semibold">Recent Activity</div>
          <div className="mt-1 text-xs text-neutral-300">5 events in last hour</div>
        </div>
        <div className="rounded-2xl border border-purple-400/20 bg-gradient-to-br from-purple-500/10 to-indigo-500/5 p-4">
          <div className="font-semibold">Quick Actions</div>
          <div className="mt-1 text-xs text-neutral-300">Backup · Restart · Logs</div>
        </div>
      </div>
    </div>
  );

  const adminRootView = (
    <div className="space-y-4">
      <div>
        <div className="mb-2 text-sm font-semibold text-neutral-400">Storage</div>
        {renderCards([
          { name: "Storage Management" },
          { name: "Add Remote Storage" },
          { name: "Storage Pools & Mounts" },
          { name: "Disk Usage Overview" },
        ])}
      </div>
      <div>
        <div className="mb-2 text-sm font-semibold text-neutral-400">Backups</div>
        {renderCards([
          { name: "Backup Configuration", onClick: () => setAdminView("backup") },
          { name: "Backup Schedules",     onClick: () => setAdminView("backup") },
          { name: "Backup Destinations",  onClick: () => setAdminView("backup") },
          { name: "Test Restore",         onClick: () => setAdminView("backup") },
        ])}
      </div>
      <div>
        <div className="mb-2 text-sm font-semibold text-neutral-400">Identity & Access</div>
        {renderCards([
          { name: "User Management" },
          { name: "Keycloak SSO" },
          { name: "Access Policies" },
          { name: "Audit Logs" },
          { name: "Add Network",      onClick: () => setAdminView("network") },
          { name: "Network Policies", onClick: () => setAdminView("network") },
        ])}
      </div>
    </div>
  );

  const backupPanel = (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div className="text-lg font-semibold">Backup Control Panel</div>
        <button onClick={() => setAdminView(null)} className="text-xs text-neutral-400">Back</button>
      </div>
      <div className="grid grid-cols-2 gap-4">
        <div className="rounded-2xl border border-neutral-800 bg-neutral-900/70 p-4">
          <div className="text-sm font-semibold">Schedule</div>
          <div className="mt-1 text-xs text-neutral-400">{backupData ? backupData.schedule : "Daily at 02:00 · Retention 7 days"}</div>
        </div>
        <div className="rounded-2xl border border-neutral-800 bg-neutral-900/70 p-4">
          <div className="text-sm font-semibold">Destination</div>
          <div className="mt-1 text-xs text-neutral-400">{backupData ? backupData.destination : "Backblaze B2 (encrypted)"}</div>
        </div>
        <div className="rounded-2xl border border-neutral-800 bg-neutral-900/70 p-4">
          <div className="text-sm font-semibold">Last Run</div>
          <div className="mt-1 text-xs text-emerald-400">{backupData ? backupData.lastRun : "Success · 02:01"}</div>
        </div>
        <div className="rounded-2xl border border-neutral-800 bg-neutral-900/70 p-4">
          <div className="text-sm font-semibold">Next Run</div>
          <div className="mt-1 text-xs text-neutral-400">{backupData ? backupData.nextRun : "Tonight · 02:00"}</div>
        </div>
      </div>
      <div className="grid grid-cols-2 gap-4">
        <div className="cursor-pointer rounded-2xl border border-neutral-800 bg-neutral-900/70 p-4 hover:border-cyan-400/30">
          <div className="font-semibold">Run Backup Now</div>
        </div>
        <div className="cursor-pointer rounded-2xl border border-neutral-800 bg-neutral-900/70 p-4 hover:border-amber-400/30">
          <div className="font-semibold">Test Restore</div>
        </div>
      </div>
    </div>
  );

  const networkPanel = (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div className="text-lg font-semibold">Network Control Panel</div>
        <button onClick={() => setAdminView(null)} className="text-xs text-neutral-400">Back</button>
      </div>
      <div className="grid grid-cols-2 gap-4">
        <div className="rounded-2xl border border-neutral-800 bg-neutral-900/70 p-4">
          <div className="text-sm font-semibold">Primary Network</div>
          <div className="mt-1 text-xs text-neutral-400">{networkData ? `${networkData.subnet} · VLAN internal` : "10.10.40.0/24 · VLAN internal"}</div>
        </div>
        <div className="rounded-2xl border border-neutral-800 bg-neutral-900/70 p-4">
          <div className="text-sm font-semibold">Gateway</div>
          <div className="mt-1 text-xs text-neutral-400">{networkData ? networkData.gateway : "10.10.40.1"}</div>
        </div>
        <div className="rounded-2xl border border-neutral-800 bg-neutral-900/70 p-4">
          <div className="text-sm font-semibold">DNS / Resolver</div>
          <div className="mt-1 text-xs text-neutral-400">{networkData ? networkData.resolver : "Internal resolver linked"}</div>
        </div>
        <div className="rounded-2xl border border-neutral-800 bg-neutral-900/70 p-4">
          <div className="text-sm font-semibold">Last Change</div>
          <div className="mt-1 text-xs text-neutral-400">2 hours ago</div>
        </div>
      </div>
      <div className="grid grid-cols-2 gap-4">
        <div className="cursor-pointer rounded-2xl border border-neutral-800 bg-neutral-900/70 p-4 hover:border-cyan-400/30">
          <div className="font-semibold">Add Network</div>
        </div>
        <div className="cursor-pointer rounded-2xl border border-neutral-800 bg-neutral-900/70 p-4 hover:border-purple-400/30">
          <div className="font-semibold">Edit Network Policies</div>
        </div>
      </div>
    </div>
  );

  // -------------------------------------------------------------------------
  // Render
  // -------------------------------------------------------------------------
  if (loading) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-gradient-to-br from-neutral-950 to-neutral-900 text-white">
        <div className="text-center">
          <div className="mb-3 text-2xl font-bold tracking-wide text-cyan-400">PrivateNexus</div>
          <div className="text-sm text-neutral-500">Connecting to backend…</div>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gradient-to-br from-neutral-950 to-neutral-900 p-6 text-white">
      {metricsError && (
        <div className="mx-auto mb-4 max-w-7xl rounded-xl border border-amber-400/30 bg-amber-500/10 px-4 py-2 text-sm text-amber-300">
          Backend unreachable — graphs showing last cached readings.
        </div>
      )}

      <div className="mx-auto grid max-w-7xl gap-6 lg:grid-cols-[260px_1fr]">

        {/* Sidebar — border and gradient tint track the active board */}
        <aside className={["rounded-2xl border bg-neutral-900/70 bg-gradient-to-br p-4", theme.ring, theme.shell].join(" ")}>
          <div className="grid gap-2" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(120px, 1fr))" }}>
            {boards.map((board) => (
              <button
                key={board}
                onClick={() => {
                  setActiveBoard(board);
                  if (board !== "Admin") setAdminView(null);
                }}
                className={[
                  "rounded-lg px-4 py-2 text-sm text-center transition",
                  activeBoard === board
                    ? [
                        "bg-gradient-to-r text-black shadow",
                        board === "Home" && "from-cyan-400 to-blue-500",
                        board === "Ops" && "from-emerald-400 to-green-500",
                        board === "Admin" && "from-purple-400 to-indigo-500",
                        board === "Stacks" && "from-amber-400 to-orange-500",
                        board === "Emergency" && "from-rose-400 to-pink-500",
                      ]
                        .filter(Boolean)
                        .join(" ")
                    : "bg-neutral-800 text-neutral-200 hover:bg-neutral-700",
                ].join(" ")}
              >
                {board}
              </button>
            ))}
          </div>
        </aside>

        <main className="space-y-6">
          {/* User + announcements header — tinted by active board */}
          <section className="grid gap-4 md:grid-cols-2">
            <div className={["rounded-2xl border border-neutral-800 bg-neutral-900/70 bg-gradient-to-br p-4", theme.shell, theme.hover].join(" ")}>
              <div className="text-sm text-neutral-400">User</div>
              <div className="text-lg font-bold">{user.name}</div>
              <div className="text-xs text-neutral-500">{user.role} · {user.realm}</div>
            </div>
            <div className={["grid grid-cols-3 gap-2 rounded-2xl border border-neutral-800 bg-neutral-900/70 bg-gradient-to-br p-4", theme.shell, theme.hover].join(" ")}>
              {announcements.map((a) => (
                <div key={a.title} className={["rounded border p-2", announcementStyles[a.level]].join(" ")}>
                  <div className="text-xs font-bold">{a.title}</div>
                </div>
              ))}
            </div>
          </section>

          {/* Home */}
          {activeBoard === "Home" && homeView}

          {/* Ops — GraphCards + service CPU/RAM cards */}
          {activeBoard === "Ops" && (
            <div className="space-y-4">
              <div className="grid grid-cols-2 gap-4">
                {[
                  { title: "CPU Load",            value: graphSeries.cpu[graphSeries.cpu.length - 1] || 0,         unit: "%",    colorClass: "border-cyan-400/20 from-cyan-500/10 to-blue-500/5",       stroke: "#22d3ee", data: graphSeries.cpu,     maxValue: 100,  yMarks: ["100%","75%","50%","25%","0%"], progressWidth: `${graphSeries.cpu[graphSeries.cpu.length - 1] || 0}%` },
                  { title: "Memory Pressure",     value: graphSeries.memory[graphSeries.memory.length - 1] || 0,   unit: "%",    colorClass: "border-purple-400/20 from-purple-500/10 to-indigo-500/5",  stroke: "#a855f7", data: graphSeries.memory,  maxValue: 100,  yMarks: ["100%","75%","50%","25%","0%"], progressWidth: `${graphSeries.memory[graphSeries.memory.length - 1] || 0}%` },
                  { title: "Storage Utilisation", value: graphSeries.storage[graphSeries.storage.length - 1] || 0, unit: "%",    colorClass: "border-emerald-400/20 from-emerald-500/10 to-green-500/5", stroke: "#34d399", data: graphSeries.storage, maxValue: 100,  yMarks: ["100%","75%","50%","25%","0%"], progressWidth: `${graphSeries.storage[graphSeries.storage.length - 1] || 0}%` },
                  { title: "Network Throughput",  value: graphSeries.network[graphSeries.network.length - 1] || 0, unit: " Mbps",colorClass: "border-amber-400/20 from-amber-500/10 to-orange-500/5",   stroke: "#f59e0b", data: graphSeries.network, maxValue: 1000, yMarks: ["1Gb","750M","500M","250M","0"],  progressWidth: `${((graphSeries.network[graphSeries.network.length - 1] || 0) / 1000 * 100).toFixed(1)}%` },
                ].map(({ title, value, unit, colorClass, stroke, data, maxValue, yMarks, progressWidth }) => {
                  const minValue = Math.min(...data);
                  const maxSeen = Math.max(...data);
                  const avgValue = Math.round(data.reduce((sum, point) => sum + point, 0) / data.length);
                  const paddedMin = Math.max(0, minValue - (maxSeen - minValue || 5) * 0.25);
                  const paddedMax = Math.min(maxValue, maxSeen + (maxSeen - minValue || 5) * 0.25);
                  const paddedRange = paddedMax - paddedMin || 1;
                  return (
                    <div key={title} className={`rounded-2xl border ${colorClass} bg-gradient-to-br p-4`}>
                      <div className="mb-2 flex items-center justify-between">
                        <div className="font-semibold">{title}</div>
                        <div className="text-xs text-neutral-300">{value}{unit}</div>
                      </div>
                      <div className="mb-3 h-2 rounded-full bg-neutral-800">
                        <div className="h-2 rounded-full" style={{ width: progressWidth, backgroundColor: stroke }} />
                      </div>
                      <div className="rounded-xl border border-neutral-800/60 bg-neutral-950/40 p-3">
                        <div className="grid grid-cols-[44px_1fr] gap-3">
                          <div className="flex h-28 flex-col justify-between text-[10px] leading-none text-neutral-500">
                            {yMarks.map((mark) => (
                              <span key={mark}>{mark}</span>
                            ))}
                          </div>

                          <div>
                            <div className="relative h-28">
                              <div className="absolute inset-0 flex flex-col justify-between">
                                {yMarks.map((mark) => (
                                  <div key={mark} className="border-t border-dashed border-neutral-800/80" />
                                ))}
                              </div>

                              <svg viewBox="0 0 100 40" className="absolute inset-0 h-full w-full overflow-visible">
                                <polyline fill="none" stroke={stroke} strokeWidth="2" points={buildPoints(data, maxValue)} />
                                {data.map((point, idx) => {
                                  const x = (idx / (data.length - 1)) * 100;
                                  const y = 40 - ((point - paddedMin) / paddedRange) * 40;
                                  return <circle key={`${title}-${idx}`} cx={x} cy={y} r="1.4" fill={stroke} />;
                                })}
                              </svg>
                            </div>

                            <div className="mt-2 grid grid-cols-5 text-[10px] text-neutral-500">
                              {xLabels.map((label, idx) => (
                                <span
                                  key={label}
                                  className={
                                    idx === 0
                                      ? "text-left"
                                      : idx === xLabels.length - 1
                                      ? "text-right"
                                      : "text-center"
                                  }
                                >
                                  {label}
                                </span>
                              ))}
                            </div>
                          </div>
                        </div>
                      </div>

                      <div className="mt-3 grid grid-cols-3 gap-2 text-[11px] text-neutral-400">
                        <div className="rounded-lg border border-neutral-800 bg-neutral-900/50 px-2 py-2">
                          <div className="text-[10px] uppercase tracking-wide text-neutral-500">Min</div>
                          <div className="mt-1 font-medium text-neutral-200">{minValue}{unit}</div>
                        </div>
                        <div className="rounded-lg border border-neutral-800 bg-neutral-900/50 px-2 py-2">
                          <div className="text-[10px] uppercase tracking-wide text-neutral-500">Avg</div>
                          <div className="mt-1 font-medium text-neutral-200">{avgValue}{unit}</div>
                        </div>
                        <div className="rounded-lg border border-neutral-800 bg-neutral-900/50 px-2 py-2">
                          <div className="text-[10px] uppercase tracking-wide text-neutral-500">Max</div>
                          <div className="mt-1 font-medium text-neutral-200">{maxSeen}{unit}</div>
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>

              <div className="rounded-2xl border border-emerald-400/20 bg-gradient-to-br from-emerald-500/10 to-green-500/5 p-4">
                <div className="mb-3 flex items-center justify-between">
                  <div>
                    <div className="font-semibold">Next Level Ops</div>
                    <div className="text-xs text-neutral-400">Faster drill-down and smarter control options</div>
                  </div>
                  <div className="rounded-full bg-emerald-500/15 px-2 py-1 text-[10px] text-emerald-300">Advanced</div>
                </div>
                <div className="grid grid-cols-3 gap-3">
                  {["Live Metrics", "Service Drilldown", "Anomaly Detection", "Capacity Forecast", "Auto Refresh", "Export Snapshot"].map((opt) => (
                    <div key={opt} className="cursor-pointer rounded-xl border border-neutral-800 bg-neutral-900/70 p-3 text-sm transition hover:border-emerald-400/30 hover:bg-neutral-800/80">
                      {opt}
                    </div>
                  ))}
                </div>
              </div>

              {renderCards(services)}
            </div>
          )}

          {/* Admin */}
          {activeBoard === "Admin" && (
            adminView === "backup"  ? backupPanel  :
            adminView === "network" ? networkPanel :
            adminRootView
          )}

          {/* Stacks */}
          {activeBoard === "Stacks" && <StacksBoard />}

          {/* Emergency */}
          {activeBoard === "Emergency" && renderCards([
            { name: "Shutdown All Stacks",  variant: "safe" },
            { name: "Restart All Services", variant: "danger" },
            { name: "Maintenance Mode",     variant: "neutral" },
            { name: "Kill Network",         variant: "danger" },
            { name: "Failover Trigger",     variant: "danger" },
            { name: "Run Diagnostics",      variant: "safe" },
          ])}

          {/* Execution log */}
          {logs.length > 0 && (
            <div className="rounded-2xl border border-neutral-800 bg-neutral-900/80 p-4">
              <div className="mb-2 text-sm font-semibold">Execution Logs</div>
              <div className="max-h-40 space-y-1 overflow-auto text-xs text-neutral-400">
                {logs.map((log, index) => (
                  <div key={`${log}-${index}`}>{log}</div>
                ))}
              </div>
            </div>
          )}
        </main>
      </div>

      {/* All Apps modal */}
      {showAllApps && (
        <div className="fixed inset-0 z-40 flex items-center justify-center bg-black/70">
          <div className="w-[min(96vw,1400px)] max-h-[90vh] max-w-full overflow-hidden rounded-2xl border border-cyan-400/30 bg-neutral-900 p-6 shadow-[0_0_40px_rgba(34,211,238,0.10)]">
            <div className="mb-4 flex items-center justify-between gap-4">
              <div>
                <div className="text-lg font-semibold">All Applications</div>
                <div className="text-xs text-neutral-500">Launch, scan, and filter everything from one place</div>
              </div>
              <button onClick={() => setShowAllApps(false)} className="text-xs text-neutral-400">Close</button>
            </div>

            <div className="mb-4 grid gap-3 md:grid-cols-[1fr_auto]">
              <input
                value={appSearch}
                onChange={(e) => setAppSearch(e.target.value)}
                placeholder="Search apps, services, or roles..."
                className="rounded-xl border border-neutral-800 bg-neutral-800/80 px-4 py-3 text-sm text-neutral-200 outline-none placeholder:text-neutral-500 focus:border-cyan-400/40"
              />
              <div className="flex flex-wrap gap-2">
                {appCategories.map((cat) => (
                  <button
                    key={cat}
                    onClick={() => setAppCategory(cat)}
                    className={[
                      "rounded-lg px-3 py-2 text-xs transition",
                      appCategory === cat
                        ? "border border-cyan-400/30 bg-cyan-500/10 text-cyan-300"
                        : "border border-neutral-800 bg-neutral-800/80 text-neutral-300 hover:border-cyan-400/20",
                    ].join(" ")}
                  >
                    {cat}
                  </button>
                ))}
              </div>
            </div>

            <div className="mb-4 grid grid-cols-3 gap-3">
              <div className="rounded-xl border border-cyan-400/20 bg-gradient-to-br from-cyan-500/10 to-blue-500/5 p-3">
                <div className="text-xs text-neutral-400">Visible Apps</div>
                <div className="mt-1 text-lg font-semibold">{filteredApps.length}</div>
              </div>
              <div className="rounded-xl border border-emerald-400/20 bg-gradient-to-br from-emerald-500/10 to-green-500/5 p-3">
                <div className="text-xs text-neutral-400">Recent</div>
                <div className="mt-1 text-lg font-semibold">{recentApps.length}</div>
              </div>
              <div className="rounded-xl border border-purple-400/20 bg-gradient-to-br from-purple-500/10 to-indigo-500/5 p-3">
                <div className="text-xs text-neutral-400">Category</div>
                <div className="mt-1 text-lg font-semibold">{appCategory}</div>
              </div>
            </div>

            <div className="max-h-[50vh] overflow-y-auto pr-1">
              <div className="grid gap-4" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))" }}>
                {filteredApps.map((app, idx) => (
                  <div key={`${app.name}-${idx}`} className="group rounded-2xl border border-neutral-800 bg-neutral-800/70 p-4 transition hover:border-cyan-400/30 hover:bg-neutral-800">
                    <div className="flex items-center justify-between gap-2">
                      <div className="text-2xl">{app.logo}</div>
                      <span className="rounded-full bg-neutral-900 px-2 py-1 text-[10px] text-neutral-400">{app.category}</span>
                    </div>
                    <div className="mt-3 text-sm font-semibold text-neutral-200">{app.name}</div>
                    <div className="mt-1 text-xs text-neutral-500">{app.meta}</div>
                    <div className="mt-3 grid grid-cols-2 gap-2 opacity-0 transition group-hover:opacity-100">
                      <div className="rounded-lg border border-neutral-700 bg-neutral-900/80 px-2 py-1 text-center text-[10px] text-neutral-300">Open</div>
                      <div className="rounded-lg border border-neutral-700 bg-neutral-900/80 px-2 py-1 text-center text-[10px] text-neutral-300">Logs</div>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Confirm action modal */}
      {confirmAction && (
        <div className="fixed inset-0 flex items-center justify-center bg-black/70">
          <div className="w-96 rounded-xl border border-rose-400/30 bg-neutral-900 p-6">
            <div className="mb-2 text-lg font-bold">Confirm Action</div>
            <div className="mb-4 text-sm text-neutral-400">Are you sure you want to run: {confirmAction.name}?</div>
            <div className="flex justify-end gap-2">
              <button onClick={() => setConfirmAction(null)} className="rounded bg-neutral-700 px-3 py-1">Cancel</button>
              <button onClick={() => executeAction(confirmAction)} className="rounded bg-rose-500 px-3 py-1 text-black">Confirm</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
