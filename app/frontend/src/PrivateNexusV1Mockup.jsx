import React, { useMemo, useState } from "react";

export default function PrivateNexusV1Mockup() {
  function StacksBoard() {
    const [panel, setPanel] = useState(null);

    const items = [
      { key: "create", title: "Create", desc: "Scaffold new stack", colorClass: "hover:border-amber-400/30" },
      { key: "import", title: "Import", desc: "Parse compose", colorClass: "hover:border-cyan-400/30" },
      { key: "lifecycle", title: "Lifecycle", desc: "Running / Drafts / Updates", colorClass: "hover:border-emerald-400/30" },
      { key: "insight", title: "Insights", desc: "Health / History / Recovery", colorClass: "hover:border-purple-400/30" },
      { key: "files", title: "Files", desc: "Dockerfiles, docs, configs", colorClass: "hover:border-rose-400/30" },
    ];

    const panelContent = {
      create: ["Create Stack", "Template Library", "Clone Stack"],
      import: ["Paste Compose", "Security Review", "Generate Skeleton"],
      lifecycle: ["Running Stacks", "Draft Stacks", "Update Queue", "Review Queue"],
      insight: ["Recent Changes", "Stack Health", "Deployment History", "Recovery Tools"],
      files: ["Edit Dockerfile", "Edit Compose", "Edit App Docs", "Edit Config Files"],
    };

    const stackCards = [
      {
        name: "Nextcloud",
        details: "docker-compose.yml · Dockerfile · Caddyfile",
        docs: "README.md · deployment-notes.md",
      },
      {
        name: "Immich",
        details: "docker-compose.yml · worker.env · reverse-proxy.conf",
        docs: "README.md · gpu-notes.md",
      },
      {
        name: "Notesnook",
        details: "docker-compose.yml · secrets.env",
        docs: "README.md · backup-policy.md",
      },
      {
        name: "Paperless",
        details: "docker-compose.yml · import-review.yml",
        docs: "README.md · recovery-notes.md",
      },
    ];

    return (
      <div className="space-y-4">
        <div className="rounded-2xl border border-amber-400/20 bg-gradient-to-r from-amber-500/10 via-orange-500/10 to-yellow-500/10 p-4">
          <div className="flex items-center justify-between">
            <div>
              <div className="text-xs uppercase tracking-wider text-amber-300/80">Build Bay</div>
              <div className="text-lg font-semibold">Stack Control Center</div>
            </div>
            <div className="flex gap-2">
              <span className="rounded-full bg-emerald-500/20 px-2 py-1 text-xs text-emerald-300">8 running</span>
              <span className="rounded-full bg-blue-500/20 px-2 py-1 text-xs text-blue-300">3 drafts</span>
              <span className="rounded-full bg-amber-500/20 px-2 py-1 text-xs text-amber-300">2 updates</span>
            </div>
          </div>
        </div>

        <div className="flex gap-3">
          {items.map((item) => (
            <div
              key={item.key}
              onClick={() => setPanel(panel === item.key ? null : item.key)}
              className={["flex-1 cursor-pointer rounded-2xl border border-neutral-800 bg-neutral-900/70 p-4 transition", item.colorClass].join(" ")}
            >
              <div className="font-semibold">{item.title}</div>
              <div className="text-xs text-neutral-400">{item.desc}</div>
            </div>
          ))}
        </div>

        {panel ? (
          <div className="grid grid-cols-4 gap-4 rounded-2xl border border-neutral-800 bg-neutral-900/70 p-4">
            {panelContent[panel].map((entry) => (
              <div key={entry} className="rounded-xl border border-neutral-800 bg-neutral-800/80 p-3 text-sm">
                {entry}
              </div>
            ))}
          </div>
        ) : null}

        <div className="grid grid-cols-2 gap-4">
          {stackCards.map((stack) => (
            <div key={stack.name} className="rounded-2xl border border-amber-400/20 bg-neutral-900/80 p-4">
              <div className="font-semibold">{stack.name}</div>
              <div className="mt-1 text-xs text-neutral-400">{stack.details}</div>
              <div className="mt-1 text-xs text-neutral-500">{stack.docs}</div>
              <div className="mt-3 flex flex-wrap gap-2">
                {["Edit Dockerfile", "Edit Compose", "Edit Docs", "Open Config"].map((action) => (
                  <div
                    key={action}
                    className="rounded-lg border border-neutral-700 bg-neutral-800/80 px-2 py-1 text-[10px] text-neutral-300"
                  >
                    {action}
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      </div>
    );
  }

  const [activeBoard, setActiveBoard] = useState("Home");
  const [confirmAction, setConfirmAction] = useState(null);
  const [logs, setLogs] = useState([]);
  const [adminView, setAdminView] = useState(null);
  const [showAllApps, setShowAllApps] = useState(false);
  const [appSearch, setAppSearch] = useState("");
  const [appCategory, setAppCategory] = useState("All");

  const user = { name: "Trae", role: "Superadmin", realm: "PrivateNexus" };

  const announcements = [
    { title: "Major system error", level: "critical" },
    { title: "Updates available", level: "warning" },
    { title: "Backup OK", level: "info" },
  ];

  const boards = ["Home", "Ops", "Admin", "Stacks", "Emergency"];

  const boardThemes = {
    Home: {
      active: "from-cyan-400 to-blue-500",
      ring: "border-cyan-400/30",
      hover: "hover:border-cyan-400/30",
      shell: "from-cyan-500/10 to-blue-500/5",
    },
    Ops: {
      active: "from-emerald-400 to-green-500",
      ring: "border-emerald-400/30",
      hover: "hover:border-emerald-400/30",
      shell: "from-emerald-500/10 to-green-500/5",
    },
    Admin: {
      active: "from-purple-400 to-indigo-500",
      ring: "border-purple-400/30",
      hover: "hover:border-purple-400/30",
      shell: "from-purple-500/10 to-indigo-500/5",
    },
    Stacks: {
      active: "from-amber-400 to-orange-500",
      ring: "border-amber-400/30",
      hover: "hover:border-amber-400/30",
      shell: "from-amber-500/10 to-orange-500/5",
    },
    Emergency: {
      active: "from-rose-400 to-pink-500",
      ring: "border-rose-400/30",
      hover: "hover:border-rose-400/30",
      shell: "from-rose-500/10 to-pink-500/5",
    },
  };

  const theme = boardThemes[activeBoard];

  const services = [
    { name: "Nextcloud", cpu: 24, mem: 62 },
    { name: "Immich", cpu: 71, mem: 78 },
    { name: "Notesnook", cpu: 9, mem: 31 },
    { name: "Paperless", cpu: 0, mem: 0 },
  ];

  const recentApps = [
    { name: "Nextcloud", logo: "☁️", category: "Cloud" },
    { name: "Immich", logo: "🖼️", category: "Media" },
    { name: "Notesnook", logo: "📝", category: "Notes" },
    { name: "Paperless", logo: "📄", category: "Docs" },
    { name: "Grafana", logo: "📊", category: "Monitoring" },
  ];

  const allApps = [
    { name: "Nextcloud", logo: "☁️", category: "Cloud", meta: "Files · Sync" },
    { name: "Immich", logo: "🖼️", category: "Media", meta: "Photos · ML" },
    { name: "Notesnook", logo: "📝", category: "Notes", meta: "Vault · Secure" },
    { name: "Paperless", logo: "📄", category: "Docs", meta: "OCR · Archive" },
    { name: "Grafana", logo: "📊", category: "Monitoring", meta: "Dashboards" },
    { name: "Uptime Kuma", logo: "🟢", category: "Monitoring", meta: "Status checks" },
    { name: "Keycloak", logo: "🛡️", category: "Identity", meta: "SSO · MFA" },
    { name: "Caddy", logo: "🌐", category: "Infra", meta: "Reverse proxy" },
    { name: "Backups", logo: "💾", category: "Infra", meta: "Snapshots · Restore" },
    { name: "Portainer", logo: "🐳", category: "Infra", meta: "Containers" },
    { name: "Loki", logo: "📚", category: "Monitoring", meta: "Logs" },
    { name: "Admin Panel", logo: "⚙️", category: "Identity", meta: "Users · Policies" },
  ];

  const appCategories = ["All", "Cloud", "Media", "Notes", "Docs", "Monitoring", "Identity", "Infra"];

  const filteredApps = allApps.filter(function (app) {
    const matchesCategory = appCategory === "All" || app.category === appCategory;
    const search = appSearch.trim().toLowerCase();
    const matchesSearch = !search || app.name.toLowerCase().includes(search) || app.meta.toLowerCase().includes(search);
    return matchesCategory && matchesSearch;
  });

  const announcementStyles = useMemo(
    function () {
      return {
        critical: "border-rose-400/30 bg-rose-500/10",
        warning: "border-amber-400/30 bg-amber-500/10",
        info: "border-cyan-400/30 bg-cyan-500/10",
      };
    },
    []
  );

  function executeAction(item) {
    setLogs(function (prev) {
      return ["[" + new Date().toLocaleTimeString() + "] Executed: " + item.name].concat(prev);
    });
    setConfirmAction(null);
  }

  function handleAction(item) {
    if (item.variant === "danger") {
      setConfirmAction(item);
      return;
    }
    executeAction(item);
  }

  function renderCards(items) {
    return (
      <div className="grid grid-cols-2 gap-4">
        {items.map(function (item, idx) {
          const baseClasses = [
            "p-4",
            "bg-neutral-900/70",
            "bg-gradient-to-br",
            theme.shell,
            "rounded-2xl",
            "border",
            "border-neutral-800",
            theme.hover,
            "transition",
            "cursor-pointer",
          ].join(" ");

          const variants = {
            safe: "border-cyan-400/30 bg-gradient-to-br from-cyan-500/10 to-blue-500/5 hover:border-cyan-400/50",
            danger: "border-rose-400/30 bg-gradient-to-br from-rose-500/10 to-pink-500/5 hover:border-rose-400/50",
            neutral: "",
          };

          const variantClass = item.variant ? variants[item.variant] : variants.neutral;
          const recommendedGlow =
            item.variant === "safe" && activeBoard === "Emergency" && idx === 0
              ? "ring-2 ring-cyan-400/40 shadow-[0_0_20px_rgba(34,211,238,0.15)]"
              : "";

          const cardClasses = [baseClasses, variantClass, recommendedGlow].join(" ").trim();
          const onClick = item.onClick
            ? item.onClick
            : function () {
                handleAction(item);
              };

          return (
            <div key={item.name || item.title} onClick={onClick} className={cardClasses}>
              <div className="font-semibold">{item.name || item.title}</div>
              {item.cpu !== undefined && item.mem !== undefined ? (
                <div className="mt-1 text-xs text-neutral-400">
                  CPU {item.cpu}% · RAM {item.mem}%
                </div>
              ) : null}
            </div>
          );
        })}
      </div>
    );
  }

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
              onClick={function () {
                setShowAllApps(true);
              }}
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
          {recentApps.slice(0, 5).map(function (app, index) {
            const recentClasses =
              index === 0
                ? "flex h-14 w-14 shrink-0 items-center justify-center rounded-2xl border border-cyan-400/40 bg-gradient-to-br from-cyan-500/20 to-blue-500/10 text-2xl shadow-[0_0_20px_rgba(34,211,238,0.15)]"
                : "flex h-14 w-14 shrink-0 items-center justify-center rounded-2xl border border-neutral-800 bg-neutral-800/80 text-2xl transition hover:border-cyan-400/30 hover:bg-neutral-700/80";

            return (
              <div key={app.name} className={recentClasses} title={app.name}>
                <span aria-hidden="true">{app.logo}</span>
              </div>
            );
          })}
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
          {
            name: "Backup Configuration",
            onClick: function () {
              setAdminView("backup");
            },
          },
          {
            name: "Backup Schedules",
            onClick: function () {
              setAdminView("backup");
            },
          },
          {
            name: "Backup Destinations",
            onClick: function () {
              setAdminView("backup");
            },
          },
          {
            name: "Test Restore",
            onClick: function () {
              setAdminView("backup");
            },
          },
        ])}
      </div>

      <div>
        <div className="mb-2 text-sm font-semibold text-neutral-400">Identity & Access</div>
        {renderCards([
          { name: "User Management" },
          { name: "Keycloak SSO" },
          { name: "Access Policies" },
          { name: "Audit Logs" },
          {
            name: "Add Network",
            onClick: function () {
              setAdminView("network");
            },
          },
          {
            name: "Network Policies",
            onClick: function () {
              setAdminView("network");
            },
          },
        ])}
      </div>
    </div>
  );

  const backupPanel = (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div className="text-lg font-semibold">Backup Control Panel</div>
        <button
          onClick={function () {
            setAdminView(null);
          }}
          className="text-xs text-neutral-400"
        >
          Back
        </button>
      </div>

      <div className="grid grid-cols-2 gap-4">
        <div className="rounded-2xl border border-neutral-800 bg-neutral-900/70 p-4">
          <div className="text-sm font-semibold">Schedule</div>
          <div className="mt-1 text-xs text-neutral-400">Daily at 02:00 · Retention 7 days</div>
        </div>
        <div className="rounded-2xl border border-neutral-800 bg-neutral-900/70 p-4">
          <div className="text-sm font-semibold">Destination</div>
          <div className="mt-1 text-xs text-neutral-400">Backblaze B2 (encrypted)</div>
        </div>
        <div className="rounded-2xl border border-neutral-800 bg-neutral-900/70 p-4">
          <div className="text-sm font-semibold">Last Run</div>
          <div className="mt-1 text-xs text-emerald-400">Success · 02:01</div>
        </div>
        <div className="rounded-2xl border border-neutral-800 bg-neutral-900/70 p-4">
          <div className="text-sm font-semibold">Next Run</div>
          <div className="mt-1 text-xs text-neutral-400">Tonight · 02:00</div>
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
        <button
          onClick={function () {
            setAdminView(null);
          }}
          className="text-xs text-neutral-400"
        >
          Back
        </button>
      </div>

      <div className="grid grid-cols-2 gap-4">
        <div className="rounded-2xl border border-neutral-800 bg-neutral-900/70 p-4">
          <div className="text-sm font-semibold">Primary Network</div>
          <div className="mt-1 text-xs text-neutral-400">10.10.40.0/24 · VLAN internal</div>
        </div>
        <div className="rounded-2xl border border-neutral-800 bg-neutral-900/70 p-4">
          <div className="text-sm font-semibold">Gateway</div>
          <div className="mt-1 text-xs text-neutral-400">10.10.40.1</div>
        </div>
        <div className="rounded-2xl border border-neutral-800 bg-neutral-900/70 p-4">
          <div className="text-sm font-semibold">DNS / Resolver</div>
          <div className="mt-1 text-xs text-neutral-400">Internal resolver linked</div>
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

  const opsView = (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-4">
        <div className="rounded-2xl border border-cyan-400/20 bg-gradient-to-br from-cyan-500/10 to-blue-500/5 p-4">
          <div className="mb-2 flex items-center justify-between">
            <div className="font-semibold">CPU Load</div>
            <div className="text-xs text-cyan-300">48%</div>
          </div>
          <div className="mb-3 h-2 rounded-full bg-neutral-800">
            <div className="h-2 w-[48%] rounded-full bg-cyan-400" />
          </div>
          <div className="h-16">
            <svg viewBox="0 0 100 40" className="h-16 w-full">
              <polyline fill="none" stroke="#22d3ee" strokeWidth="2" points="0,30 10,20 20,25 30,10 40,15 50,5 60,22 70,12 80,18 90,26" />
            </svg>
          </div>
        </div>

        <div className="rounded-2xl border border-purple-400/20 bg-gradient-to-br from-purple-500/10 to-indigo-500/5 p-4">
          <div className="mb-2 flex items-center justify-between">
            <div className="font-semibold">Memory Pressure</div>
            <div className="text-xs text-purple-300">63%</div>
          </div>
          <div className="mb-3 h-2 rounded-full bg-neutral-800">
            <div className="h-2 w-[63%] rounded-full bg-purple-400" />
          </div>
          <div className="h-16">
            <svg viewBox="0 0 100 40" className="h-16 w-full">
              <polyline fill="none" stroke="#a855f7" strokeWidth="2" points="0,28 10,27 20,26 30,24 40,20 50,18 60,16 70,14 80,15 90,16" />
            </svg>
          </div>
        </div>

        <div className="rounded-2xl border border-emerald-400/20 bg-gradient-to-br from-emerald-500/10 to-green-500/5 p-4">
          <div className="mb-2 flex items-center justify-between">
            <div className="font-semibold">Storage Utilisation</div>
            <div className="text-xs text-emerald-300">71%</div>
          </div>
          <div className="mb-3 h-2 rounded-full bg-neutral-800">
            <div className="h-2 w-[71%] rounded-full bg-emerald-400" />
          </div>
          <div className="h-16">
            <svg viewBox="0 0 100 40" className="h-16 w-full">
              <polyline fill="none" stroke="#34d399" strokeWidth="2" points="0,30 10,28 20,26 30,24 40,22 50,20 60,18 70,16 80,15 90,14" />
            </svg>
          </div>
        </div>

        <div className="rounded-2xl border border-amber-400/20 bg-gradient-to-br from-amber-500/10 to-orange-500/5 p-4">
          <div className="mb-2 flex items-center justify-between">
            <div className="font-semibold">Network Throughput</div>
            <div className="text-xs text-amber-300">842 Mbps</div>
          </div>
          <div className="mb-3 h-2 rounded-full bg-neutral-800">
            <div className="h-2 w-[58%] rounded-full bg-amber-400" />
          </div>
          <div className="h-16">
            <svg viewBox="0 0 100 40" className="h-16 w-full">
              <polyline fill="none" stroke="#f59e0b" strokeWidth="2" points="0,35 10,30 20,20 30,15 40,10 50,5 60,12 70,8 80,11 90,14" />
            </svg>
          </div>
        </div>
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
          {["Live Metrics", "Service Drilldown", "Anomaly Detection", "Capacity Forecast", "Auto Refresh", "Export Snapshot"].map(function (option) {
            return (
              <div
                key={option}
                className="cursor-pointer rounded-xl border border-neutral-800 bg-neutral-900/70 p-3 text-sm transition hover:border-emerald-400/30 hover:bg-neutral-800/80"
              >
                {option}
              </div>
            );
          })}
        </div>
      </div>

      {renderCards(services)}
    </div>
  );

  return (
    <div className="min-h-screen bg-gradient-to-br from-neutral-950 to-neutral-900 p-6 text-white">
      <div className="mx-auto grid max-w-7xl gap-6 lg:grid-cols-[260px_1fr]">
        <aside className={["rounded-2xl border bg-neutral-900/70 p-4 bg-gradient-to-br", theme.ring, theme.shell].join(" ")}>
          <div className="grid gap-2" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(120px, 1fr))" }}>
            {boards.map(function (board) {
              const buttonClasses =
                activeBoard === board
                  ? ["cursor-pointer rounded-lg px-4 py-2 text-sm text-center transition bg-gradient-to-r", boardThemes[board].active, "text-black shadow"].join(" ")
                  : "cursor-pointer rounded-lg px-4 py-2 text-sm text-center transition bg-neutral-800 text-neutral-200 hover:bg-neutral-700";

              return (
                <div
                  key={board}
                  onClick={function () {
                    setActiveBoard(board);
                    if (board !== "Admin") {
                      setAdminView(null);
                    }
                  }}
                  className={buttonClasses}
                >
                  {board}
                </div>
              );
            })}
          </div>
        </aside>

        <main className="space-y-6">
          <section className="grid gap-4 md:grid-cols-2">
            <div className={["rounded-2xl border border-neutral-800 bg-neutral-900/70 bg-gradient-to-br p-4", theme.shell, theme.hover].join(" ")}>
              <div className="text-sm text-neutral-400">User</div>
              <div className="text-lg font-bold">{user.name}</div>
              <div className="text-xs text-neutral-500">
                {user.role} · {user.realm}
              </div>
            </div>

            <div className={["grid grid-cols-3 gap-2 rounded-2xl border border-neutral-800 bg-neutral-900/70 bg-gradient-to-br p-4", theme.shell, theme.hover].join(" ")}>
              {announcements.map(function (announcement) {
                return (
                  <div key={announcement.title} className={["rounded border p-2", announcementStyles[announcement.level]].join(" ")}>
                    <div className="text-xs font-bold">{announcement.title}</div>
                  </div>
                );
              })}
            </div>
          </section>

          {activeBoard === "Home" ? homeView : null}
          {activeBoard === "Ops" ? opsView : null}
          {activeBoard === "Admin" ? (adminView === "backup" ? backupPanel : adminView === "network" ? networkPanel : adminRootView) : null}
          {activeBoard === "Stacks" ? <StacksBoard /> : null}
          {activeBoard === "Emergency"
            ? renderCards([
                { name: "Shutdown All Stacks", variant: "safe" },
                { name: "Restart All Services", variant: "danger" },
                { name: "Maintenance Mode", variant: "neutral" },
                { name: "Kill Network", variant: "danger" },
                { name: "Failover Trigger", variant: "danger" },
                { name: "Run Diagnostics", variant: "safe" },
              ])
            : null}

          {logs.length > 0 ? (
            <div className="rounded-2xl border border-neutral-800 bg-neutral-900/80 p-4">
              <div className="mb-2 text-sm font-semibold">Execution Logs</div>
              <div className="max-h-40 space-y-1 overflow-auto text-xs text-neutral-400">
                {logs.map(function (log, index) {
                  return <div key={log + "-" + index}>{log}</div>;
                })}
              </div>
            </div>
          ) : null}
        </main>
      </div>

      {showAllApps ? (
        <div className="fixed inset-0 z-40 flex items-center justify-center bg-black/70">
          <div className="w-[min(96vw,1400px)] max-h-[90vh] max-w-full overflow-hidden rounded-2xl border border-cyan-400/30 bg-neutral-900 p-6 shadow-[0_0_40px_rgba(34,211,238,0.10)]">
            <div className="mb-4 flex items-center justify-between gap-4">
              <div>
                <div className="text-lg font-semibold">All Applications</div>
                <div className="text-xs text-neutral-500">Launch, scan, and filter everything from one place</div>
              </div>
              <button
                onClick={function () {
                  setShowAllApps(false);
                }}
                className="text-xs text-neutral-400"
              >
                Close
              </button>
            </div>

            <div className="mb-4 grid gap-3 md:grid-cols-[1fr_auto]">
              <input
                value={appSearch}
                onChange={function (e) {
                  setAppSearch(e.target.value);
                }}
                placeholder="Search apps, services, or roles..."
                className="rounded-xl border border-neutral-800 bg-neutral-800/80 px-4 py-3 text-sm text-neutral-200 outline-none placeholder:text-neutral-500 focus:border-cyan-400/40"
              />
              <div className="flex flex-wrap gap-2">
                {appCategories.map(function (category) {
                  const active = appCategory === category;
                  return (
                    <button
                      key={category}
                      onClick={function () {
                        setAppCategory(category);
                      }}
                      className={[
                        "rounded-lg px-3 py-2 text-xs transition",
                        active
                          ? "border border-cyan-400/30 bg-cyan-500/10 text-cyan-300"
                          : "border border-neutral-800 bg-neutral-800/80 text-neutral-300 hover:border-cyan-400/20",
                      ].join(" ")}
                    >
                      {category}
                    </button>
                  );
                })}
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

            <div className="max-h-[60vh] overflow-y-auto pr-1">
              <div
                className="grid gap-4"
                style={{ gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))" }}
              >
                {filteredApps.map(function (app, idx) {
                  return (
                    <div
                      key={app.name + idx}
                      className="group rounded-2xl border border-neutral-800 bg-neutral-800/70 p-4 transition hover:border-cyan-400/30 hover:bg-neutral-800"
                    >
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
                  );
                })}
              </div>
            </div>
          </div>
        </div>
      ) : null}

      {confirmAction ? (
        <div className="fixed inset-0 flex items-center justify-center bg-black/70">
          <div className="w-96 rounded-xl border border-rose-400/30 bg-neutral-900 p-6">
            <div className="mb-2 text-lg font-bold">Confirm Action</div>
            <div className="mb-4 text-sm text-neutral-400">Are you sure you want to run: {confirmAction.name}?</div>
            <div className="flex justify-end gap-2">
              <button
                onClick={function () {
                  setConfirmAction(null);
                }}
                className="rounded bg-neutral-700 px-3 py-1"
              >
                Cancel
              </button>
              <button
                onClick={function () {
                  executeAction(confirmAction);
                }}
                className="rounded bg-rose-500 px-3 py-1 text-black"
              >
                Confirm
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
