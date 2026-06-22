import React, { useEffect, useMemo, useRef, useState } from "react";

class ErrorBoundary extends React.Component {
  constructor(props) { super(props); this.state = { error: null }; }
  static getDerivedStateFromError(e) { return { error: e }; }
  render() {
    if (this.state.error) {
      return React.createElement('div', {
        style: { padding: 32, color: '#f87171', fontFamily: 'monospace', background: '#111', minHeight: '100vh' }
      }, React.createElement('h2', null, 'React crash'),
         React.createElement('pre', null, String(this.state.error?.message || this.state.error)),
         React.createElement('pre', null, String(this.state.error?.stack || '')));
    }
    return this.props.children;
  }
}

function PrivateNexusDashboard({ authUser }) {
  const API_BASE = "";
  // Ref so parent (applyFileLive) can trigger an immediate stacks refresh
  const stacksRefreshRef = useRef(null);

  // -------------------------------------------------------------------------
  // Inner component — live Docker data, fully self-contained
  // -------------------------------------------------------------------------
  function StacksBoard() {
    const [projects, setProjects] = useState([]);
    const [total, setTotal] = useState(0);
    const [stacksError, setStacksError] = useState(false);
    const [actionPending, setActionPending] = useState(null);
    const [actionError, setActionError] = useState(null);

    // Logs drawer state
    const [logsTarget, setLogsTarget] = useState(null);
    const [logsLines, setLogsLines] = useState([]);
    const [logsLoading, setLogsLoading] = useState(false);
    const [autoScroll, setAutoScroll] = useState(true);
    const logsEndRef = React.useRef(null);

    // Inspect panel state
    const [inspectTarget, setInspectTarget] = useState(null);
    const [inspectData, setInspectData] = useState(null);
    const [inspectLoading, setInspectLoading] = useState(false);

    // Health badge config — covers all Docker states
    const healthBadge = {
      running:    { dot: "bg-emerald-400",  badge: "bg-emerald-500/20 text-emerald-300 border-emerald-500/30" },
      exited:     { dot: "bg-neutral-500",  badge: "bg-neutral-700/60 text-neutral-400 border-neutral-600/30" },
      restarting: { dot: "bg-amber-400 animate-pulse", badge: "bg-amber-500/20 text-amber-300 border-amber-500/30" },
      paused:     { dot: "bg-blue-400",     badge: "bg-blue-500/20 text-blue-300 border-blue-500/30" },
      created:    { dot: "bg-neutral-400",  badge: "bg-neutral-700/40 text-neutral-400 border-neutral-700/30" },
      unhealthy:  { dot: "bg-rose-500 animate-pulse", badge: "bg-rose-500/20 text-rose-300 border-rose-500/30" },
      partial:    { dot: "bg-amber-400",    badge: "bg-amber-500/20 text-amber-300 border-amber-500/30" },
      stopped:    { dot: "bg-neutral-500",  badge: "bg-neutral-700/60 text-neutral-400 border-neutral-600/30" },
    };

    const getBadge = (state) => healthBadge[state] || healthBadge.stopped;

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
      stacksRefreshRef.current = loadStacks;
      loadStacks();
      const interval = setInterval(loadStacks, 15000);
      return () => {
        clearInterval(interval);
        stacksRefreshRef.current = null;
      };
    }, []);

    // Auto-scroll logs to bottom
    useEffect(() => {
      if (autoScroll && logsEndRef.current) {
        logsEndRef.current.scrollIntoView({ behavior: "smooth" });
      }
    }, [logsLines, autoScroll]);

    const runAction = async (containerId, action) => {
      const key = `${containerId}:${action}`;
      setActionPending(key);
      setActionError(null);
      try {
        const res = await fetch(`${API_BASE}/api/actions/run`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action, containerId }),
        });
        const data = await res.json();
        if (!res.ok) setActionError(`${action} failed: ${data.error}`);
        await loadStacks();
      } catch (err) {
        setActionError(`${action} failed: ${err.message}`);
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
        // Split timestamp from message for cleaner display
        setLogsLines((data.lines || []).map((line) => {
          const tsMatch = line.match(/^(\d{4}-\d{2}-\d{2}T[\d:.]+Z)\s(.*)/s);
          return tsMatch
            ? { ts: tsMatch[1].replace("T", " ").replace("Z", "").slice(0, 19), msg: tsMatch[2] }
            : { ts: null, msg: line };
        }));
      } catch {
        setLogsLines([{ ts: null, msg: "Failed to fetch logs." }]);
      } finally {
        setLogsLoading(false);
      }
    };

    const refreshLogs = () => logsTarget && openLogs(logsTarget);

    const openInspect = async (container) => {
      setInspectTarget(container);
      setInspectData(null);
      setInspectLoading(true);
      try {
        const res = await fetch(`${API_BASE}/api/stacks/${container.id}`);
        setInspectData(await res.json());
      } catch {
        setInspectData({ error: "Failed to fetch inspect data." });
      } finally {
        setInspectLoading(false);
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
              <button onClick={loadStacks} className="rounded-lg border border-amber-400/20 bg-amber-500/10 px-3 py-1 text-xs text-amber-300 hover:bg-amber-500/20">
                Refresh
              </button>
            </div>
          </div>
          {stacksError && <div className="mt-2 text-xs text-rose-400">Docker socket unavailable — cannot list containers.</div>}
          {actionError && (
            <div className="mt-2 flex items-center justify-between text-xs text-rose-400">
              <span>{actionError}</span>
              <button onClick={() => setActionError(null)} className="ml-2 text-neutral-500 hover:text-white">×</button>
            </div>
          )}
        </div>

        {projects.length === 0 && !stacksError && (
          <div className="rounded-2xl border border-neutral-800 bg-neutral-900/70 p-6 text-center text-sm text-neutral-500">
            No containers found on this host.
          </div>
        )}

        {projects.map((p) => {
          const badge = getBadge(p.state);
          return (
            <div key={p.project} className="rounded-2xl border border-amber-400/20 bg-neutral-900/80 p-4">
              <div className="mb-3 flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <span className="font-semibold">{p.project === "__standalone__" ? "Standalone" : p.project}</span>
                  <span className={["rounded-full border px-2 py-0.5 text-[10px]", badge.badge].join(" ")}>{p.state}</span>
                </div>
                <div className="flex items-center gap-2">
                  {(() => {
                    const stackFiles = getFilesForStack(p.project);
                    if (stackFiles.length === 0) return null;
                    const hasDraft = stackHasDraft(p.project);
                    return (
                      <>
                        <span className={["rounded-full px-2 py-0.5 text-[10px]", hasDraft ? "bg-amber-500/15 text-amber-300" : "bg-rose-500/10 text-rose-300/70"].join(" ")}>
                          {stackFiles.length} file{stackFiles.length !== 1 ? "s" : ""}{hasDraft ? " · draft" : ""}
                        </span>
                        {stackNeedsApply(p.project) && (
                          <span className="rounded-full bg-amber-500/10 px-2 py-0.5 text-[10px] text-amber-300">
                            Pending apply
                          </span>
                        )}
                        {stackHasDrift(p.project) ? (
                          <span className="rounded-full bg-amber-500/15 px-2 py-0.5 text-[10px] text-amber-300">
                            Baseline drift
                          </span>
                        ) : stackHasKnownGood(p.project) ? (
                          <span className="rounded-full bg-emerald-500/15 px-2 py-0.5 text-[10px] text-emerald-300">
                            Trusted baseline
                          </span>
                        ) : null}
                        <button
                          onClick={() => editStackConfig(p.project)}
                          className="rounded-lg border border-rose-400/20 bg-rose-500/10 px-2 py-1 text-[10px] text-rose-300 hover:bg-rose-500/20"
                        >
                          Edit Config
                        </button>
                      </>
                    );
                  })()}
                  <span className="text-xs text-neutral-500">{p.containers.length} container{p.containers.length !== 1 ? "s" : ""}</span>
                </div>
              </div>

              <div className="space-y-2">
                {p.containers.map((c) => {
                  const cb = getBadge(c.state);
                  const isRunning = c.state === "running";
                  return (
                    <div key={c.id} className="flex items-center justify-between rounded-xl border border-neutral-800 bg-neutral-800/60 px-3 py-2">
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-2">
                          <span className={["h-2 w-2 shrink-0 rounded-full", cb.dot].join(" ")} />
                          <span className="truncate text-sm font-medium">{c.name}</span>
                          <span className={["rounded-full border px-1.5 py-0.5 text-[9px]", cb.badge].join(" ")}>{c.state}</span>
                        </div>
                        <div className="mt-0.5 truncate pl-4 text-[10px] text-neutral-500">
                          {c.image} · {c.status}
                          {c.ports.length > 0 && ` · ${c.ports.join(" · ")}`}
                        </div>
                      </div>

                      <div className="ml-3 flex shrink-0 gap-1.5">
                        {isRunning ? (
                          <>
                            <button
                              disabled={!!actionPending || !can("operator")}
                              title={!can("operator") ? "Requires operator role" : undefined}
                              onClick={() => runAction(c.id, "restart")}
                              className="rounded-lg border border-amber-400/20 bg-amber-500/10 px-2 py-1 text-[10px] text-amber-300 hover:bg-amber-500/20 disabled:cursor-not-allowed disabled:opacity-40"
                            >
                              {actionPending === `${c.id}:restart` ? "…" : "Restart"}
                            </button>
                            <button
                              disabled={!!actionPending || !can("operator")}
                              title={!can("operator") ? "Requires operator role" : undefined}
                              onClick={() => runAction(c.id, "stop")}
                              className="rounded-lg border border-rose-400/20 bg-rose-500/10 px-2 py-1 text-[10px] text-rose-300 hover:bg-rose-500/20 disabled:cursor-not-allowed disabled:opacity-40"
                            >
                              {actionPending === `${c.id}:stop` ? "…" : "Stop"}
                            </button>
                          </>
                        ) : (
                          <button
                            disabled={!!actionPending || !can("operator")}
                            title={!can("operator") ? "Requires operator role" : undefined}
                            onClick={() => runAction(c.id, "start")}
                            className="rounded-lg border border-emerald-400/20 bg-emerald-500/10 px-2 py-1 text-[10px] text-emerald-300 hover:bg-emerald-500/20 disabled:cursor-not-allowed disabled:opacity-40"
                          >
                            {actionPending === `${c.id}:start` ? "…" : "Start"}
                          </button>
                        )}
                        <button
                          onClick={() => openInspect(c)}
                          className="rounded-lg border border-neutral-700 bg-neutral-800/80 px-2 py-1 text-[10px] text-neutral-300 hover:border-purple-400/30"
                        >
                          Inspect
                        </button>
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
          );
        })}

        {/* Inspect panel */}
        {inspectTarget && (
          <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4">
            <div className="w-full max-w-lg rounded-2xl border border-purple-400/20 bg-neutral-900 p-5 shadow-2xl">
              <div className="mb-4 flex items-center justify-between">
                <div>
                  <div className="font-semibold">{inspectTarget.name}</div>
                  <div className="text-xs text-neutral-500">Inspect summary</div>
                </div>
                <button onClick={() => setInspectTarget(null)} className="text-xs text-neutral-400 hover:text-white">Close</button>
              </div>

              {inspectLoading && <div className="text-sm text-neutral-500">Loading…</div>}
              {inspectData?.error && <div className="text-sm text-rose-400">{inspectData.error}</div>}

              {inspectData && !inspectData.error && (
                <div className="space-y-3 text-sm">
                  <div className="grid grid-cols-2 gap-2">
                    {[
                      { label: "Image",          value: inspectData.image },
                      { label: "Status",         value: inspectData.state?.status },
                      { label: "Restart policy", value: `${inspectData.restartPolicy?.name}${inspectData.restartPolicy?.maxRetry ? ` (×${inspectData.restartPolicy.maxRetry})` : ""}` },
                      { label: "Mounts",         value: `${inspectData.mountCount} volume${inspectData.mountCount !== 1 ? "s" : ""}` },
                      { label: "Networks",       value: (inspectData.networks || []).join(", ") || "none" },
                      { label: "Health",         value: inspectData.state?.health || "no healthcheck" },
                      { label: "Started",        value: inspectData.state?.startedAt ? inspectData.state.startedAt.slice(0, 19).replace("T", " ") : "—" },
                      { label: "Exit code",      value: inspectData.state?.running ? "—" : String(inspectData.state?.exitCode ?? "—") },
                    ].map(({ label, value }) => (
                      <div key={label} className="rounded-lg border border-neutral-800 bg-neutral-800/60 px-3 py-2">
                        <div className="text-[10px] uppercase tracking-wide text-neutral-500">{label}</div>
                        <div className="mt-0.5 truncate text-xs text-neutral-200">{value}</div>
                      </div>
                    ))}
                  </div>

                  {inspectData.publishedPorts?.length > 0 && (
                    <div className="rounded-lg border border-neutral-800 bg-neutral-800/60 px-3 py-2">
                      <div className="mb-1 text-[10px] uppercase tracking-wide text-neutral-500">Published ports</div>
                      {inspectData.publishedPorts.map((p) => (
                        <div key={p} className="font-mono text-[11px] text-neutral-300">{p}</div>
                      ))}
                    </div>
                  )}

                  {inspectData.mounts?.length > 0 && (
                    <div className="rounded-lg border border-neutral-800 bg-neutral-800/60 px-3 py-2">
                      <div className="mb-1 text-[10px] uppercase tracking-wide text-neutral-500">Mounts</div>
                      {inspectData.mounts.map((m, i) => (
                        <div key={i} className="font-mono text-[11px] text-neutral-400 truncate">{m.src} → {m.dst} <span className="text-neutral-600">({m.mode})</span></div>
                      ))}
                    </div>
                  )}
                </div>
              )}
            </div>
          </div>
        )}

        {/* Logs drawer */}
        {logsTarget && (
          <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/70 p-4">
            <div className="w-full max-w-4xl rounded-2xl border border-cyan-400/20 bg-neutral-900 p-4 shadow-2xl">
              <div className="mb-3 flex items-center justify-between gap-3">
                <div>
                  <div className="font-semibold">{logsTarget.name}</div>
                  <div className="text-xs text-neutral-500">Last 100 lines · timestamps UTC</div>
                </div>
                <div className="flex items-center gap-2">
                  <button
                    onClick={() => setAutoScroll((v) => !v)}
                    className={["rounded-lg border px-2 py-1 text-[10px] transition", autoScroll ? "border-cyan-400/30 bg-cyan-500/10 text-cyan-300" : "border-neutral-700 bg-neutral-800/80 text-neutral-400"].join(" ")}
                  >
                    Auto-scroll {autoScroll ? "on" : "off"}
                  </button>
                  <button onClick={refreshLogs} disabled={logsLoading} className="rounded-lg border border-neutral-700 bg-neutral-800/80 px-2 py-1 text-[10px] text-neutral-300 hover:border-cyan-400/30 disabled:opacity-40">
                    Refresh
                  </button>
                  <button onClick={() => setLogsTarget(null)} className="text-xs text-neutral-400 hover:text-white">Close</button>
                </div>
              </div>

              <div className="h-80 overflow-y-auto rounded-xl border border-neutral-800 bg-neutral-950 p-3 font-mono text-[11px]">
                {logsLoading ? (
                  <div className="text-neutral-500">Loading…</div>
                ) : logsLines.length === 0 ? (
                  <div className="text-neutral-500">No log output.</div>
                ) : (
                  logsLines.map((line, i) => (
                    <div key={i} className="flex gap-3 leading-relaxed">
                      {line.ts && <span className="shrink-0 text-neutral-600">{line.ts}</span>}
                      <span className="text-neutral-300">{line.msg}</span>
                    </div>
                  ))
                )}
                <div ref={logsEndRef} />
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
  const [liveAlerts, setLiveAlerts] = useState([]);
  const [alertFilter, setAlertFilter] = useState("all");      // all | critical | warning
  const [alertSilenced, setAlertSilenced] = useState([]);
  const [alertFirstSeen, setAlertFirstSeen] = useState({});   // id → ISO timestamp
  const [appsData, setAppsData] = useState([]);
  const [appLogsTarget, setAppLogsTarget] = useState(null);
  const [appLogsLines, setAppLogsLines] = useState([]);
  const [appLogsLoading, setAppLogsLoading] = useState(false);
  const [backupData, setBackupData] = useState(null);
  const [networkData, setNetworkData] = useState(null);
  const [auditData, setAuditData] = useState([]);
  const [auditLoading, setAuditLoading] = useState(false);
  const [auditError, setAuditError] = useState(null);
  const [auditFilter, setAuditFilter] = useState({ action: "", outcome: "" });
  const [metricsData, setMetricsData] = useState({ cpu: [], memory: [], storage: [], network: [], stats: null, collectedAt: null });
  const [metricsError, setMetricsError] = useState(false);
  const [opsVMs, setOpsVMs] = useState([]);
  const [opsVMsTs, setOpsVMsTs] = useState(null);
  const [opsVMsLoading, setOpsVMsLoading] = useState(false);
  const [logsSources, setLogsSources] = useState({ hosts: [], containers: [] });
  const [logsSourceType, setLogsSourceType] = useState("syslog");
  const [logsSource, setLogsSource] = useState("");
  const [logsRange, setLogsRange] = useState("1h");
  const [logsLevel, setLogsLevel] = useState("all");
  const [logsSearch, setLogsSearch] = useState("");
  const [logsResults, setLogsResults] = useState([]);
  const [logsLoading, setLogsLoading] = useState(false);
  const [logsError, setLogsError] = useState("");
  const [logsAutoRefresh, setLogsAutoRefresh] = useState(false);
  const [healthResults, setHealthResults] = useState({});
  const [healthChecking, setHealthChecking] = useState(false);
  const [loading, setLoading] = useState(true);
  const [filesData, setFilesData] = useState([]);
  const [selectedFile, setSelectedFile] = useState(null);
  const [fileViewerOpen, setFileViewerOpen] = useState(false);
  const [filesError, setFilesError] = useState("");
  const [fileEditorContent, setFileEditorContent] = useState("");
  const [fileDirty, setFileDirty] = useState(false);
  const [fileDraftStatus, setFileDraftStatus] = useState("");
  const [showSaveLiveConfirm, setShowSaveLiveConfirm] = useState(false);
  const [fileLiveStatus, setFileLiveStatus] = useState("");
  const [fileValidation, setFileValidation] = useState(null); // null | { status, issues }
  const [showApplyConfirm, setShowApplyConfirm] = useState(false);
  const [fileApplyResult, setFileApplyResult] = useState(null); // null | { ok, action, output }
  const [fileApplyLog, setFileApplyLog] = useState([]); // last N applies for the open file
  const [filesStackFilter, setFilesStackFilter] = useState("all");
  const [applyLogData, setApplyLogData] = useState([]);
  const [fileBackups, setFileBackups] = useState([]); // backup metadata for the open file
  const [selectedBackup, setSelectedBackup] = useState(null); // { fileName, content }
  const [diffMode, setDiffMode] = useState("draft-live"); // "draft-live" | "live-backup"
  const [showRestoreConfirm, setShowRestoreConfirm] = useState(false);
  const [restoreResult, setRestoreResult] = useState(null); // null | { ok, safetyBackup, restoredFrom, error }
  const [showRestoreApplyConfirm, setShowRestoreApplyConfirm] = useState(false);
  const [restoreApplyResult, setRestoreApplyResult] = useState(null); // null | { ok, phase, restoredFrom, safetyBackup, apply, error }
  const [lkg, setLkg] = useState(null); // null | { fileName, markedAt }
  const [knownGoodSummary, setKnownGoodSummary] = useState({}); // fileId → { hasKnownGood, knownGoodFile, drifted }
  const [backupLabels, setBackupLabels] = useState({}); // fileName → { label, updatedAt }
  const [labelEditing, setLabelEditing] = useState(null); // null | fileName
  const [labelInput, setLabelInput] = useState("");
  const [restorePlan, setRestorePlan] = useState(null); // null | plan object
  const [restorePlanLoading, setRestorePlanLoading] = useState(false);
  const [showRestorePlanModal, setShowRestorePlanModal] = useState(false);
  const [restoreMode, setRestoreMode] = useState("in_place"); // "in_place" | "side_by_side"
  const [sbsTargetPath, setSbsTargetPath] = useState(""); // side-by-side target path
  const [sbsResult, setSbsResult] = useState(null); // null | restore response for side-by-side
  const [sbsLoading, setSbsLoading] = useState(false);
  const [restoreLogData, setRestoreLogData] = useState([]); // file-scoped (last 5, current file)
  const [allRestoreLogData, setAllRestoreLogData] = useState([]); // global (for Home)
  const [expandedRestoreEntry, setExpandedRestoreEntry] = useState(null); // index into restoreLogData
  const [showPruneModal, setShowPruneModal] = useState(false);
  const [pruneMode, setPruneMode] = useState("count");
  const [pruneKeepCount, setPruneKeepCount] = useState(5);
  const [pruneDays, setPruneDays] = useState(30);
  const [prunePreview, setPrunePreview] = useState(null); // null | { candidates, protected, summary }
  const [pruneResult, setPruneResult] = useState(null); // null | { deleted, protected, summary }
  const [pruneLoading, setPruneLoading] = useState(false);

  // Emergency board
  const [emergencyStatus, setEmergencyStatus] = useState(null);
  const [emergencyStatusError, setEmergencyStatusError] = useState(false);
  const [emergencyPending, setEmergencyPending] = useState(null);
  const [emergencyResult, setEmergencyResult] = useState(null);
  const [maintenanceReason, setMaintenanceReason] = useState("");

  // Admin panel — certs / disk / users / backup run
  const [certData, setCertData] = useState(null);
  const [certError, setCertError] = useState(false);
  const [diskData, setDiskData] = useState(null);
  const [usersData, setUsersData] = useState(null);
  const [usersMgmtData, setUsersMgmtData] = useState(null);
  const [usersMgmtLoading, setUsersMgmtLoading] = useState(false);
  const [backupRunning, setBackupRunning] = useState(false);
  const [backupRunResult, setBackupRunResult] = useState(null);

  // Inventory / Service Registry
  const [servicesData, setServicesData] = useState([]);
  const [servicesLoading, setServicesLoading] = useState(false);
  const [servicesError, setServicesError] = useState(null);
  const [serviceGroupBy, setServiceGroupBy] = useState("category");
  const [serviceCategoryFilter, setServiceCategoryFilter] = useState("all");
  const [showServiceModal, setShowServiceModal] = useState(false);
  const [editingService, setEditingService] = useState(null);
  const [serviceForm, setServiceForm] = useState({});
  const [serviceFormError, setServiceFormError] = useState(null);
  const [serviceSaving, setServiceSaving] = useState(false);
  const [workspacesData, setWorkspacesData] = useState([]);
  const [slugTouched, setSlugTouched] = useState(false);
  const [showArchivedServices, setShowArchivedServices] = useState(false);
  // Service detail
  const [selectedService, setSelectedService] = useState(null);
  const [serviceHealthHistory, setServiceHealthHistory] = useState([]);
  const [serviceHistoryLoading, setServiceHistoryLoading] = useState(false);
  const [serviceActionPending, setServiceActionPending] = useState(null);
  const [serviceActionError, setServiceActionError] = useState(null);
  const [serviceActionConfirm, setServiceActionConfirm] = useState(null);
  // DNS state
  const [dnsZones, setDnsZones] = useState([]);
  const [dnsSelectedZone, setDnsSelectedZone] = useState(null);
  const [dnsZoneDetail, setDnsZoneDetail] = useState(null);
  const [dnsZonesLoading, setDnsZonesLoading] = useState(false);
  const [dnsZoneLoading, setDnsZoneLoading] = useState(false);
  const [dnsError, setDnsError] = useState(null);
  const [dnsTypeFilter, setDnsTypeFilter] = useState("all");
  const [dnsSearch, setDnsSearch] = useState("");
  const [showDnsModal, setShowDnsModal] = useState(false);
  const [dnsForm, setDnsForm] = useState({ name: "", type: "A", ttl: 300, contents: [""] });
  const [dnsFormError, setDnsFormError] = useState(null);
  const [dnsFormSaving, setDnsFormSaving] = useState(false);
  const [dnsEditRrset, setDnsEditRrset] = useState(null);
  // Catalogue state
  const [catalogueApps, setCatalogueApps] = useState([]);
  const [catalogueCategory, setCatalogueCategory] = useState("all");
  const [catalogueSearch, setCatalogueSearch] = useState("");
  const [catalogueLoading, setCatalogueLoading] = useState(false);
  // Workspace management state
  const [workspacesMgmt, setWorkspacesMgmt] = useState([]);
  const [workspacesMgmtLoading, setWorkspacesMgmtLoading] = useState(false);
  const [showWorkspaceModal, setShowWorkspaceModal] = useState(false);
  const [editingWorkspace, setEditingWorkspace] = useState(null);
  const [workspaceForm, setWorkspaceForm] = useState({ name: "", slug: "" });
  const [workspaceFormError, setWorkspaceFormError] = useState(null);
  const [workspaceFormSaving, setWorkspaceFormSaving] = useState(false);
  // File register modal state
  const [showRegisterFileModal, setShowRegisterFileModal] = useState(false);
  const [registerFileForm, setRegisterFileForm] = useState({ id:"", label:"", path:"", stack:"", type:"compose", editable:true, validatable:false, applyStrategy:null });
  const [registerFileError, setRegisterFileError] = useState(null);
  const [registerFileSaving, setRegisterFileSaving] = useState(false);

  // -------------------------------------------------------------------------
  // API — backup and network come from the backend; app/service data is static
  // -------------------------------------------------------------------------
  // Admin sub-view data — fetch on demand when the panel opens
  useEffect(() => {
    if (adminView === "backup" && !backupData) {
      fetch(`${API_BASE}/api/admin/backup`).then(r=>r.json()).then(setBackupData).catch(()=>{});
    }
    if (adminView === "network") {
      fetch(`${API_BASE}/api/admin/network`).then(r=>r.json()).then(setNetworkData).catch(()=>{});
    }
    if (adminView === "certs" || activeBoard === "Alerts") {
      setCertData(null); setCertError(false);
      fetch(`${API_BASE}/api/admin/certs`).then(r=>r.json()).then(d=>{ if(d.ok) setCertData(d); else setCertError(true); }).catch(()=>setCertError(true));
    }
    if (adminView === "disk") {
      setDiskData(null);
      fetch(`${API_BASE}/api/admin/disk`).then(r=>r.json()).then(d=>{ if(d.ok) setDiskData(d); }).catch(()=>{});
    }
    if (adminView === "users") {
      setUsersData(null);
      fetch(`${API_BASE}/api/admin/users`).then(r=>r.json()).then(d=>{ if(d.ok) setUsersData(d); }).catch(()=>{});
    }
    if (adminView === "users-manage") {
      setUsersMgmtData(null); setUsersMgmtLoading(true);
      fetch(`${API_BASE}/api/admin/users-manage`)
        .then(r=>r.json())
        .then(d=>{ if(d.ok) setUsersMgmtData(d); })
        .catch(()=>{})
        .finally(()=>setUsersMgmtLoading(false));
    }
  }, [adminView, activeBoard, API_BASE]);

  useEffect(() => {
    if (adminView !== "audit") return;
    setAuditLoading(true);
    setAuditError(null);
    const params = new URLSearchParams({ limit: "200" });
    if (auditFilter.action)  params.set("action",  auditFilter.action);
    if (auditFilter.outcome) params.set("outcome", auditFilter.outcome);
    fetch(`${API_BASE}/api/admin/audit?${params}`)
      .then((r) => r.json())
      .then((data) => { setAuditData(Array.isArray(data) ? data : []); setAuditLoading(false); })
      .catch(() => { setAuditError("Failed to load audit log"); setAuditLoading(false); });
  }, [adminView, auditFilter, API_BASE]);

  useEffect(() => {
    if (activeBoard !== "Inventory" && activeBoard !== "Home") return;
    setServicesLoading(true);
    setServicesError(null);
    const params = new URLSearchParams();
    if (activeBoard === "Inventory" && showArchivedServices) params.set("archived", "true");
    if (activeBoard === "Inventory" && serviceCategoryFilter !== "all") params.set("category", serviceCategoryFilter);
    fetch(`${API_BASE}/api/services?${params}`)
      .then((r) => r.json())
      .then((data) => { setServicesData(Array.isArray(data) ? data : []); setServicesLoading(false); })
      .catch(() => { setServicesError("Failed to load service registry"); setServicesLoading(false); });
  }, [activeBoard, showArchivedServices, serviceCategoryFilter, API_BASE]);

  useEffect(() => {
    if (activeBoard !== "Inventory") return;
    fetch(`${API_BASE}/api/services/workspaces`)
      .then((r) => r.json())
      .then((d) => { if (d.ok) setWorkspacesData(d.workspaces); })
      .catch(() => {});
  }, [activeBoard, API_BASE]);

  useEffect(() => {
    if (activeBoard !== "Inventory") return;
    setHealthChecking(true);
    fetch(`${API_BASE}/api/services/health`)
      .then((r) => r.json())
      .then((data) => {
        if (data.ok) {
          const map = {};
          for (const r of data.results) {
            map[r.id] = { status: r.status, latencyMs: r.latencyMs, statusCode: r.statusCode, error: r.error, checkedAt: data.ts };
          }
          setHealthResults(map);
          setServicesData((prev) => prev.map((svc) => {
            const h = map[svc.id];
            return h ? { ...svc, status: h.status } : svc;
          }));
        }
      })
      .catch(() => {})
      .finally(() => setHealthChecking(false));
  }, [activeBoard, API_BASE]);

  useEffect(() => {
    let mounted = true;

    const loadMetrics = async () => {
      try {
        const res = await fetch(`${API_BASE}/api/metrics`);
        const data = await res.json();
        if (mounted) {
          if (Array.isArray(data.cpu)) { setMetricsData(data); setMetricsError(false); }
          else setMetricsError(true);
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

  useEffect(() => {
    if (activeBoard !== "Ops" && activeBoard !== "Home") return;
    let mounted = true;
    const load = async () => {
      setOpsVMsLoading(true);
      try {
        const res = await fetch(`${API_BASE}/api/ops/vms`);
        const data = await res.json();
        if (mounted && data.ok) { setOpsVMs(data.vms); setOpsVMsTs(data.ts); }
      } catch {} finally { if (mounted) setOpsVMsLoading(false); }
    };
    load();
    const id = setInterval(load, 30000);
    return () => { mounted = false; clearInterval(id); };
  }, [activeBoard, API_BASE]);

  useEffect(() => {
    if (activeBoard !== "DNS") return;
    setDnsZonesLoading(true); setDnsError(null);
    fetch(`${API_BASE}/api/dns/zones`)
      .then((r) => r.json())
      .then((d) => { if (d.ok) { setDnsZones(d.zones); if (d.zones.length && !dnsSelectedZone) setDnsSelectedZone(d.zones[0].id); } else setDnsError(d.error); })
      .catch((e) => setDnsError(e.message))
      .finally(() => setDnsZonesLoading(false));
  }, [activeBoard, API_BASE]);

  useEffect(() => {
    if (!dnsSelectedZone || activeBoard !== "DNS") return;
    setDnsZoneLoading(true); setDnsZoneDetail(null); setDnsTypeFilter("all"); setDnsSearch("");
    fetch(`${API_BASE}/api/dns/zones/${encodeURIComponent(dnsSelectedZone)}`)
      .then((r) => r.json())
      .then((d) => { if (d.ok) setDnsZoneDetail(d.zone); else setDnsError(d.error); })
      .catch((e) => setDnsError(e.message))
      .finally(() => setDnsZoneLoading(false));
  }, [dnsSelectedZone, activeBoard, API_BASE]);

  useEffect(() => {
    if (adminView !== "workspaces") return;
    setWorkspacesMgmtLoading(true);
    fetch(`${API_BASE}/api/services/workspaces`)
      .then((r) => r.json())
      .then((d) => { if (d.ok) setWorkspacesMgmt(d.workspaces); })
      .catch(() => {})
      .finally(() => setWorkspacesMgmtLoading(false));
  }, [adminView, activeBoard, API_BASE]);

  useEffect(() => {
    if (activeBoard !== "Catalogue") return;
    setCatalogueLoading(true);
    fetch(`${API_BASE}/api/catalogue`)
      .then((r) => r.json())
      .then((d) => { if (d.ok) setCatalogueApps(d.apps); })
      .catch(() => {})
      .finally(() => setCatalogueLoading(false));
  }, [activeBoard, API_BASE]);

  // Load Loki sources when Logs board opens
  useEffect(() => {
    if (activeBoard !== "Logs") return;
    fetch(`${API_BASE}/api/logs/sources`)
      .then((r) => r.json())
      .then((d) => { if (d.ok) setLogsSources(d); })
      .catch(() => {});
  }, [activeBoard, API_BASE]);

  // Auto-refresh logs every 15s when enabled
  useEffect(() => {
    if (!logsAutoRefresh || !logsSource) return;
    const id = setInterval(runLogsQuery, 15000);
    return () => clearInterval(id);
  }, [logsAutoRefresh, logsSource, logsSourceType, logsRange, logsLevel, logsSearch]);

  useEffect(() => {
    fetch(`${API_BASE}/api/files`)
      .then((res) => res.json())
      .then((data) => {
        setFilesData(Array.isArray(data) ? data : []);
        setFilesError("");
      })
      .catch(() => setFilesError("Failed to load file registry"));
    loadAllApplyLog();
    loadAllRestoreLog();
    loadKnownGoodSummary();
  }, [API_BASE]);

  useEffect(() => {
    fetch(`${API_BASE}/api/apps`)
      .then((r) => r.json())
      .then((data) => setAppsData(Array.isArray(data) ? data : []))
      .catch(() => {});
  }, [API_BASE]);

  useEffect(() => {
    const es = new EventSource(`${API_BASE}/api/alerts/stream`);
    es.onmessage = (e) => {
      try { setLiveAlerts(JSON.parse(e.data)); } catch {}
    };
    es.onerror = () => setLiveAlerts([]);
    return () => es.close();
  }, [API_BASE]);

  useEffect(() => {
    if (!liveAlerts.length) return;
    const now = new Date().toISOString();
    setAlertFirstSeen((prev) => {
      const next = { ...prev };
      for (const a of liveAlerts) { if (!next[a.id]) next[a.id] = now; }
      return next;
    });
  }, [liveAlerts]);

  useEffect(() => {
    if (activeBoard !== "Emergency") return;
    fetchEmergencyStatus();
  }, [activeBoard]);

  async function loadApplyLog(id) {
    try {
      const res = await fetch(`${API_BASE}/api/files/apply-log?fileId=${encodeURIComponent(id)}`);
      const data = await res.json();
      if (res.ok) setFileApplyLog((data.log || []).slice(-5).reverse());
    } catch {
      // non-critical — silently ignore
    }
  }

  async function loadAllApplyLog() {
    try {
      const res = await fetch(`${API_BASE}/api/files/apply-log`);
      const data = await res.json();
      setApplyLogData([...(data.log || [])].reverse());
    } catch (err) {
      console.error("Failed to load apply log", err);
    }
  }

  async function openFileById(id) {
    try {
      const res = await fetch(`${API_BASE}/api/files/read?id=${encodeURIComponent(id)}`);
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Failed to read file");
      setSelectedFile(data);
      setFileEditorContent(data.draft?.exists ? data.draft.content : data.content);
      setFileDirty(false);
      setFileValidation(null);
      setFileApplyResult(null);
      setFileApplyLog([]);
      setFileBackups([]);
      setSelectedBackup(null);
      setDiffMode("draft-live");
      setRestoreResult(null);
      setRestoreApplyResult(null);
      setLkg(null);
      if (data.draft?.exists) {
        const draftStale = new Date(data.draft.modifiedAt) < new Date(data.modifiedAt);
        setFileDraftStatus(
          `Draft loaded · ${data.draft.modifiedAt.slice(0, 19).replace("T", " ")}` +
            (draftStale ? " · ⚠ live file is newer" : "")
        );
      } else {
        setFileDraftStatus("No draft yet");
      }
      setFileViewerOpen(true);
      setLogs((prev) => [`[${new Date().toLocaleTimeString()}] opened file → ${data.fileName}`, ...prev]);
      loadApplyLog(id);
      loadFileBackups(id);
      loadKnownGood(id);
      loadBackupLabels(id);
      loadRestoreLog(id);
    } catch (err) {
      setLogs((prev) => [`[${new Date().toLocaleTimeString()}] ERROR: ${err.message}`, ...prev]);
    }
  }

  async function saveFileDraft() {
    if (!selectedFile) return;
    try {
      const res = await fetch(`${API_BASE}/api/files/draft`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: selectedFile.id, content: fileEditorContent }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Failed to save draft");
      setFileDirty(false);
      setFileDraftStatus(`Draft saved · ${data.draft.modifiedAt.slice(0, 19).replace("T", " ")}`);
      setLogs((prev) => [`[${new Date().toLocaleTimeString()}] saved draft → ${selectedFile.id}`, ...prev]);
      // Refresh file list so draft badge updates
      const refresh = await fetch(`${API_BASE}/api/files`);
      const files = await refresh.json();
      setFilesData(Array.isArray(files) ? files : []);
    } catch (err) {
      setLogs((prev) => [`[${new Date().toLocaleTimeString()}] ERROR: ${err.message}`, ...prev]);
    }
  }

  async function saveFileLive() {
    if (!selectedFile) return;
    setRestoreResult(null);
    setRestoreApplyResult(null);
    setFileApplyResult(null);
    try {
      const res = await fetch(`${API_BASE}/api/files/write`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: selectedFile.id, content: fileEditorContent, source: "editor" }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Failed to save live file");
      setFileDirty(false);
      setFileLiveStatus(`Live saved · ${data.file.modifiedAt.slice(0, 19).replace("T", " ")} · backup: ${data.backup.fileName}`);
      setShowSaveLiveConfirm(false);
      setLogs((prev) => [`[${new Date().toLocaleTimeString()}] saved live → ${selectedFile.id}`, ...prev]);
      // Refresh file data and list
      const rf = await fetch(`${API_BASE}/api/files/read?id=${encodeURIComponent(selectedFile.id)}`);
      const rfData = await rf.json();
      if (rf.ok) {
        setSelectedFile(rfData);
        setFileEditorContent(rfData.draft?.exists ? rfData.draft.content : rfData.content);
      }
      const fl = await fetch(`${API_BASE}/api/files`);
      const flData = await fl.json();
      setFilesData(Array.isArray(flData) ? flData : []);
      loadFileBackups(selectedFile.id);
      loadKnownGoodSummary();
    } catch (err) {
      setLogs((prev) => [`[${new Date().toLocaleTimeString()}] ERROR: ${err.message}`, ...prev]);
      setShowSaveLiveConfirm(false);
    }
  }

  function revertEditorToLive() {
    if (!selectedFile) return;
    setFileEditorContent(selectedFile.content || "");
    setFileDirty(false);
    setFileLiveStatus("");
    setFileDraftStatus("Reverted to live file");
    setFileValidation(null);
  }

  async function validateFileContent() {
    if (!selectedFile) return;
    try {
      const res = await fetch(`${API_BASE}/api/files/validate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: selectedFile.id, content: fileEditorContent }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Validation request failed");
      setFileValidation({ status: data.status, issues: data.issues || [] });
      const label = data.status === "green" ? "valid" : data.status === "amber" ? "warnings" : "errors";
      setLogs((prev) => [`[${new Date().toLocaleTimeString()}] validated → ${selectedFile.id} · ${label}`, ...prev]);
    } catch (err) {
      setLogs((prev) => [`[${new Date().toLocaleTimeString()}] ERROR: ${err.message}`, ...prev]);
    }
  }

  async function applyFileLive() {
    if (!selectedFile) return;
    setRestoreResult(null);
    setRestoreApplyResult(null);
    const fileId = selectedFile.id;
    try {
      const res = await fetch(`${API_BASE}/api/files/apply`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: fileId }),
      });
      const data = await res.json();
      setFileApplyResult({ ok: data.ok, action: data.action, output: data.output || data.error });
      const label = data.ok ? "applied" : "apply failed";
      setLogs((prev) => [`[${new Date().toLocaleTimeString()}] ${label} → ${fileId} · ${data.action}`, ...prev]);
      // Refresh stacks immediately after a successful apply
      if (data.ok) stacksRefreshRef.current?.();
    } catch (err) {
      setFileApplyResult({ ok: false, action: null, output: err.message });
      setLogs((prev) => [`[${new Date().toLocaleTimeString()}] ERROR: ${err.message}`, ...prev]);
    } finally {
      setShowApplyConfirm(false);
      loadApplyLog(fileId);
      loadAllApplyLog();
    }
  }

  // -------------------------------------------------------------------------
  // v0.6.0-a — backup browser helpers
  // -------------------------------------------------------------------------
  async function loadFileBackups(id) {
    try {
      const res = await fetch(`${API_BASE}/api/files/backups?id=${encodeURIComponent(id)}`);
      const data = await res.json();
      if (res.ok) setFileBackups(data.backups || []);
    } catch {
      // non-critical
    }
  }

  async function loadKnownGood(id) {
    try {
      const res = await fetch(`${API_BASE}/api/files/backups/known-good?id=${encodeURIComponent(id)}`);
      const data = await res.json();
      if (res.ok) setLkg(data.knownGood || null);
    } catch {
      // non-critical
    }
  }

  async function loadKnownGoodSummary() {
    try {
      const res = await fetch(`${API_BASE}/api/files/known-good-summary`);
      const data = await res.json();
      if (res.ok) setKnownGoodSummary(data.files || {});
    } catch {
      // non-critical
    }
  }

  async function loadBackupLabels(id) {
    try {
      const res = await fetch(`${API_BASE}/api/files/backups/labels?id=${encodeURIComponent(id)}`);
      const data = await res.json();
      if (res.ok) setBackupLabels(data.labels || {});
    } catch {
      // non-critical
    }
  }

  async function loadRestoreLog(id) {
    try {
      const res = await fetch(`${API_BASE}/api/files/restore-log?fileId=${encodeURIComponent(id)}`);
      const data = await res.json();
      if (res.ok) setRestoreLogData((data.log || []).slice(-5).reverse());
    } catch {
      // non-critical
    }
  }

  async function loadAllRestoreLog() {
    try {
      const res = await fetch(`${API_BASE}/api/files/restore-log`);
      const data = await res.json();
      if (res.ok) setAllRestoreLogData([...(data.log || [])].reverse());
    } catch {
      // non-critical
    }
  }

  async function performSideBySideRestore() {
    if (!selectedFile || !restorePlan) return;
    setSbsLoading(true);
    setSbsResult(null);
    try {
      const res = await fetch(`${API_BASE}/api/files/restore`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          id: selectedFile.id,
          file: restorePlan.backup.fileName,
          mode: "side_by_side",
          ...(sbsTargetPath ? { targetPath: sbsTargetPath } : {}),
        }),
      });
      const data = await res.json();
      setSbsResult(data);
      if (res.ok) {
        setLogs((prev) => [
          `[${new Date().toLocaleTimeString()}] side-by-side restore → ${selectedFile.id} → ${data.targetPath}`,
          ...prev,
        ]);
        loadRestoreLog(selectedFile.id);
        loadAllRestoreLog();
      }
    } catch (err) {
      setSbsResult({ ok: false, error: err.message });
    } finally {
      setSbsLoading(false);
    }
  }

  async function loadRestorePlan(backupFileName) {
    if (!selectedFile) return;
    setRestorePlanLoading(true);
    try {
      const res = await fetch(`${API_BASE}/api/files/restore-plan`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: selectedFile.id, file: backupFileName }),
      });
      const data = await res.json();
      if (res.ok) {
        setRestorePlan(data.plan);
        setRestoreMode("in_place");
        setSbsTargetPath(data.plan.sideBySide?.suggestedPath ?? "");
        setSbsResult(null);
        setShowRestorePlanModal(true);
      }
    } catch {
      // non-critical
    } finally {
      setRestorePlanLoading(false);
    }
  }

  async function saveBackupLabel(fileName, label) {
    if (!selectedFile) return;
    try {
      const res = await fetch(`${API_BASE}/api/files/backups/label`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: selectedFile.id, file: fileName, label }),
      });
      const data = await res.json();
      if (res.ok) {
        setBackupLabels((prev) => {
          const next = { ...prev };
          if (data.label) {
            next[fileName] = { label: data.label, updatedAt: data.updatedAt };
          } else {
            delete next[fileName];
          }
          return next;
        });
        setLabelEditing(null);
        setLabelInput("");
      }
    } catch {
      // non-critical
    }
  }

  async function fetchPrunePreview() {
    if (!selectedFile) return;
    setPruneLoading(true);
    try {
      const body = pruneMode === "count"
        ? { id: selectedFile.id, mode: "count", keep: pruneKeepCount }
        : { id: selectedFile.id, mode: "age", days: pruneDays };
      const res = await fetch(`${API_BASE}/api/files/backups/prune-preview`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = await res.json();
      if (res.ok) setPrunePreview(data);
    } catch {
      // non-critical
    } finally {
      setPruneLoading(false);
    }
  }

  async function executePrune() {
    if (!selectedFile) return;
    setPruneLoading(true);
    try {
      const body = pruneMode === "count"
        ? { id: selectedFile.id, mode: "count", keep: pruneKeepCount }
        : { id: selectedFile.id, mode: "age", days: pruneDays };
      const res = await fetch(`${API_BASE}/api/files/backups/prune`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = await res.json();
      if (res.ok) {
        setPruneResult(data);
        setPrunePreview(null);
        loadFileBackups(selectedFile.id);
        loadKnownGood(selectedFile.id);
        loadKnownGoodSummary();
        loadBackupLabels(selectedFile.id);
      }
    } catch {
      // non-critical
    } finally {
      setPruneLoading(false);
    }
  }

  // -------------------------------------------------------------------------
  // Emergency board
  // -------------------------------------------------------------------------
  async function fetchEmergencyStatus() {
    setEmergencyStatusError(false);
    try {
      const res = await fetch(`${API_BASE}/api/actions/emergency/status`);
      if (res.ok) setEmergencyStatus(await res.json());
      else setEmergencyStatusError(true);
    } catch {
      setEmergencyStatusError(true);
    }
  }

  async function runEmergencyAction(action, payload = {}) {
    setEmergencyPending(action);
    setEmergencyResult(null);
    try {
      const res = await fetch(`${API_BASE}/api/actions/emergency`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action, ...payload }),
      });
      const data = await res.json();
      setEmergencyResult(data);
      if (action.startsWith("maintenance.") || action === "stacks.stop-all" || action === "stacks.restart-all") {
        await fetchEmergencyStatus();
        if (action === "stacks.stop-all" || action === "stacks.restart-all") {
          stacksRefreshRef.current?.();
        }
      }
      setLogs((prev) => [`[${new Date().toLocaleTimeString()}] emergency: ${action} · ${data.ok ? "ok" : "failed"}`, ...prev]);
    } catch (err) {
      setEmergencyResult({ ok: false, action, error: err.message });
      setLogs((prev) => [`[${new Date().toLocaleTimeString()}] ERROR emergency ${action}: ${err.message}`, ...prev]);
    } finally {
      setEmergencyPending(null);
    }
  }

  async function markAsKnownGood(fileName) {
    if (!selectedFile) return;
    try {
      const res = await fetch(`${API_BASE}/api/files/backups/mark-known-good`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: selectedFile.id, file: fileName }),
      });
      const data = await res.json();
      if (res.ok) {
        setLkg(data.knownGood);
        loadKnownGoodSummary();
      }
    } catch {
      // non-critical
    }
  }

  async function openBackupContent(fileName) {
    if (!selectedFile) return;
    if (selectedBackup?.fileName === fileName) {
      setSelectedBackup(null);
      setDiffMode("draft-live");
      return;
    }
    try {
      const res = await fetch(
        `${API_BASE}/api/files/backups/read?id=${encodeURIComponent(selectedFile.id)}&file=${encodeURIComponent(fileName)}`
      );
      const data = await res.json();
      if (res.ok) {
        setSelectedBackup({ fileName, content: data.content });
        setDiffMode("live-backup");
      }
    } catch (err) {
      setLogs((prev) => [`[${new Date().toLocaleTimeString()}] ERROR: ${err.message}`, ...prev]);
    }
  }

  // -------------------------------------------------------------------------
  // v0.6.0-c — restore flow
  // -------------------------------------------------------------------------
  async function restoreFile() {
    if (!selectedFile || !selectedBackup) return;
    setShowRestoreConfirm(false);
    setRestoreApplyResult(null);
    setFileApplyResult(null);
    try {
      const res = await fetch(`${API_BASE}/api/files/restore`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: selectedFile.id, file: selectedBackup.fileName }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Restore failed");

      setRestoreResult({
        ok: true,
        restoredFrom: data.restoredFrom,
        safetyBackup: data.safetyBackup,
        validation: data.validation ?? null,
      });
      const validNote = data.validation?.status === "red" ? " · validation failed (partial)" : data.validation ? ` · validation ${data.validation.status}` : "";
      setLogs((prev) => [
        `[${new Date().toLocaleTimeString()}] restored → ${selectedFile.id} ← ${data.restoredFrom}${validNote}`,
        ...prev,
      ]);

      // Reload live file content + backup list; clear backup selection + reset diff
      const rf = await fetch(`${API_BASE}/api/files/read?id=${encodeURIComponent(selectedFile.id)}`);
      const fileData = await rf.json();
      if (rf.ok) {
        setSelectedFile(fileData);
        setFileEditorContent(fileData.draft?.exists ? fileData.draft.content : fileData.content);
        setFileDirty(false);
        setFileValidation(null);
        setFileLiveStatus(`Restored · ${(fileData.modifiedAt || "").slice(0, 19).replace("T", " ")}`);
      }
      setSelectedBackup(null);
      setDiffMode("draft-live");
      loadFileBackups(selectedFile.id);
      loadKnownGood(selectedFile.id);
      loadKnownGoodSummary();
      loadBackupLabels(selectedFile.id);
      loadRestoreLog(selectedFile.id);
      loadAllRestoreLog();

      // Refresh file list so metadata badges update
      const fl = await fetch(`${API_BASE}/api/files`);
      const files = await fl.json();
      setFilesData(Array.isArray(files) ? files : []);
    } catch (err) {
      setRestoreResult({ ok: false, error: err.message });
      setLogs((prev) => [`[${new Date().toLocaleTimeString()}] ERROR restore: ${err.message}`, ...prev]);
    }
  }

  async function restoreAndApplyFile() {
    if (!selectedFile || !selectedBackup) return;
    setShowRestoreApplyConfirm(false);
    setRestoreResult(null);
    setFileApplyResult(null);
    const fileId = selectedFile.id;
    try {
      const res = await fetch(`${API_BASE}/api/files/restore-and-apply`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: fileId, file: selectedBackup.fileName }),
      });
      const data = await res.json();

      setRestoreApplyResult({
        ok: data.ok,
        phase: data.phase,
        restoredFrom: data.restoredFrom,
        safetyBackup: data.safetyBackup,
        apply: data.apply,
        validation: data.validation ?? null,
        rollbackRecommendation: data.rollbackRecommendation ?? null,
        phases: data.phases ?? null,
        error: data.error,
      });

      const label = data.ok ? "restore+apply" : `restore+apply failed (${data.phase})`;
      setLogs((prev) => [`[${new Date().toLocaleTimeString()}] ${label} → ${fileId}`, ...prev]);

      if (data.ok) stacksRefreshRef.current?.();

      // Reload live file, backup list, apply log
      const rf = await fetch(`${API_BASE}/api/files/read?id=${encodeURIComponent(fileId)}`);
      const fileData = await rf.json();
      if (rf.ok) {
        setSelectedFile(fileData);
        setFileEditorContent(fileData.draft?.exists ? fileData.draft.content : fileData.content);
        setFileDirty(false);
        setFileValidation(null);
        setFileLiveStatus(`Restored · ${(fileData.modifiedAt || "").slice(0, 19).replace("T", " ")}`);
      }
      setSelectedBackup(null);
      setDiffMode("draft-live");
      loadFileBackups(fileId);
      loadKnownGood(fileId);
      loadKnownGoodSummary();
      loadBackupLabels(fileId);
      loadRestoreLog(fileId);
      loadAllRestoreLog();
      loadApplyLog(fileId);
      loadAllApplyLog();

      const fl = await fetch(`${API_BASE}/api/files`);
      const files = await fl.json();
      setFilesData(Array.isArray(files) ? files : []);
    } catch (err) {
      setRestoreApplyResult({ ok: false, phase: "request", error: err.message });
      setLogs((prev) => [`[${new Date().toLocaleTimeString()}] ERROR restore+apply: ${err.message}`, ...prev]);
    }
  }

  // -------------------------------------------------------------------------
  // v0.6.0-b — diff engine
  // -------------------------------------------------------------------------
  function toLines(text) {
    return (text || "").replace(/\r\n/g, "\n").split("\n");
  }

  function buildSimpleDiff(leftText, rightText) {
    const left = toLines(leftText);
    const right = toLines(rightText);
    const max = Math.max(left.length, right.length);
    const rows = [];
    let added = 0, removed = 0, changed = 0;
    for (let i = 0; i < max; i++) {
      const l = left[i] ?? "";
      const r = right[i] ?? "";
      if (l === r) {
        rows.push({ type: "same", left: l, right: r, line: i + 1 });
      } else if (l && !r) {
        rows.push({ type: "removed", left: l, right: "", line: i + 1 });
        removed++;
      } else if (!l && r) {
        rows.push({ type: "added", left: "", right: r, line: i + 1 });
        added++;
      } else {
        rows.push({ type: "changed", left: l, right: r, line: i + 1 });
        changed++;
      }
    }
    return { rows, summary: { added, removed, changed } };
  }

  function diffRowClass(type) {
    switch (type) {
      case "added":   return "bg-emerald-500/10";
      case "removed": return "bg-rose-500/10";
      case "changed": return "bg-amber-500/10";
      default:        return "bg-neutral-900/40";
    }
  }

  // -------------------------------------------------------------------------
  // A6 — apply log helpers
  // -------------------------------------------------------------------------
  function getLatestApply(fileId) {
    return applyLogData.find((e) => e.fileId === fileId) || null;
  }
  function fileNeedsApply(file) {
    if (!file?.modifiedAt) return false;
    const latest = getLatestApply(file.id);
    if (!latest) return true;
    if (!latest.ok) return true;
    return new Date(file.modifiedAt) > new Date(latest.timestamp);
  }
  function stackNeedsApply(stackName) {
    return filesData.some((f) => f.stack === stackName && fileNeedsApply(f));
  }

  // -------------------------------------------------------------------------
  // A5 — stack ↔ file linkage helpers
  // -------------------------------------------------------------------------
  function getFilesForStack(stackName) {
    return filesData.filter((f) => f.stack === stackName);
  }
  function stackHasDraft(stackName) {
    return filesData.some((f) => f.stack === stackName && f.hasDraft);
  }
  function stackHasKnownGood(stackName) {
    return filesData.some((f) => f.stack === stackName && knownGoodSummary[f.id]?.hasKnownGood);
  }
  function stackHasDrift(stackName) {
    return filesData.some((f) => f.stack === stackName && knownGoodSummary[f.id]?.drifted);
  }
  const FILE_TYPE_ORDER = ["compose", "env", "caddy", "dockerfile", "docs", "javascript"];
  function getPrimaryFile(files) {
    const explicit = files.find((f) => f.primary && f.exists);
    if (explicit) return explicit;
    return [...files]
      .filter((f) => f.exists)
      .sort((a, b) => {
        const ai = FILE_TYPE_ORDER.indexOf(a.type);
        const bi = FILE_TYPE_ORDER.indexOf(b.type);
        return (ai === -1 ? 99 : ai) - (bi === -1 ? 99 : bi);
      })[0] || null;
  }
  async function editStackConfig(stackName) {
    const files = getFilesForStack(stackName);
    setFilesStackFilter(stackName);
    setActiveBoard("Files");
    const primary = getPrimaryFile(files);
    if (primary) {
      await openFileById(primary.id);
    }
  }

  // -------------------------------------------------------------------------
  // Static data
  // -------------------------------------------------------------------------
  const user = {
    name:  authUser?.name || authUser?.username || "—",
    role:  authUser?.roles?.find((r) => ["breakglass","superadmin","admin","operator","viewer"].includes(r)) || "viewer",
    realm: "securenexus",
  };

  const _ROLE_LEVELS = { viewer: 0, operator: 1, admin: 2, superadmin: 3, breakglass: 4 };
  const can = (minRole) => (_ROLE_LEVELS[user.role] ?? 0) >= (_ROLE_LEVELS[minRole] ?? 99);

  const announcements = liveAlerts.length === 0
    ? [{ title: "All systems OK", level: "info" }]
    : liveAlerts.slice(0, 3).map((a) => ({
        title: a.name,
        level: a.level === "critical" ? "critical" : a.level === "warning" ? "warning" : "info",
      }));

  const boards = ["Home", "Ops", "Admin", "Stacks", "Files", "DNS", "Catalogue", "Inventory", "Alerts", "Logs", "Emergency"];

  const boardThemes = {
    Home:      { active: "from-cyan-400 to-blue-500",     ring: "border-cyan-400/30",     hover: "hover:border-cyan-400/30",     shell: "from-cyan-500/10 to-blue-500/5" },
    Ops:       { active: "from-emerald-400 to-green-500", ring: "border-emerald-400/30",  hover: "hover:border-emerald-400/30",  shell: "from-emerald-500/10 to-green-500/5" },
    Admin:     { active: "from-purple-400 to-indigo-500", ring: "border-purple-400/30",   hover: "hover:border-purple-400/30",   shell: "from-purple-500/10 to-indigo-500/5" },
    Stacks:    { active: "from-amber-400 to-orange-500",  ring: "border-amber-400/30",    hover: "hover:border-amber-400/30",    shell: "from-amber-500/10 to-orange-500/5" },
    Files:     { active: "from-rose-400 to-pink-500",     ring: "border-rose-400/30",     hover: "hover:border-rose-400/30",     shell: "from-rose-500/10 to-pink-500/5" },
    Inventory: { active: "from-teal-400 to-cyan-500",     ring: "border-teal-400/30",     hover: "hover:border-teal-400/30",     shell: "from-teal-500/10 to-cyan-500/5" },
    Alerts:    { active: "from-red-400 to-rose-500",      ring: "border-red-400/30",      hover: "hover:border-red-400/30",      shell: "from-red-500/10 to-rose-500/5" },
    Logs:      { active: "from-cyan-400 to-blue-500",      ring: "border-cyan-400/30",     hover: "hover:border-cyan-400/30",     shell: "from-cyan-500/10 to-blue-500/5" },
    DNS:       { active: "from-emerald-400 to-teal-500",   ring: "border-emerald-400/30",  hover: "hover:border-emerald-400/30",  shell: "from-emerald-500/10 to-teal-500/5" },
    Catalogue: { active: "from-violet-400 to-purple-500",  ring: "border-violet-400/30",   hover: "hover:border-violet-400/30",   shell: "from-violet-500/10 to-purple-500/5" },
    Emergency: { active: "from-rose-400 to-pink-500",     ring: "border-rose-400/30",     hover: "hover:border-rose-400/30",     shell: "from-rose-500/10 to-pink-500/5" },
  };

  const theme = boardThemes[activeBoard];

  const recentApps = [
    { name: "Nextcloud",  logo: "☁️",  category: "Cloud" },
    { name: "Immich",     logo: "🖼️", category: "Media" },
    { name: "Notesnook", logo: "📝", category: "Notes" },
    { name: "Paperless",  logo: "📄", category: "Docs" },
    { name: "Grafana",    logo: "📊", category: "Monitoring" },
  ];

  const allApps = appsData.length > 0 ? appsData : [
    { name: "Nextcloud",   logo: "☁️",  category: "Cloud",      meta: "Files · Sync" },
    { name: "Immich",      logo: "🖼️", category: "Media",      meta: "Photos · ML" },
    { name: "Notesnook",   logo: "📝",  category: "Notes",      meta: "Vault · Secure" },
    { name: "Grafana",     logo: "📊",  category: "Monitoring", meta: "Dashboards" },
    { name: "Uptime Kuma", logo: "🟢",  category: "Monitoring", meta: "Status checks" },
    { name: "Keycloak",    logo: "🛡️",  category: "Identity",   meta: "SSO · MFA" },
    { name: "Forgejo",     logo: "🦊",  category: "Infra",      meta: "Git · CI" },
    { name: "ERPNext",     logo: "🏢",  category: "Business",   meta: "ERP · POS" },
    { name: "Vaultwarden", logo: "🔐",  category: "Identity",   meta: "Password vault" },
  ];

  const appCategories = ["All", "Cloud", "Media", "Notes", "Monitoring", "Identity", "Infra", "Business", "Finance", "Security"];

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
    cpu:     metricsData.cpu     ?? [],
    memory:  metricsData.memory  ?? [],
    storage: metricsData.storage ?? [],
    network: metricsData.network ?? [],
  };

  // Backend-computed stats; fall back to null (frontend will compute from series)
  const metricsStats = metricsData.stats || null;

  // trend arrow + colour — for CPU/mem/storage: up is bad (red), down is good (green)
  //                        for network: up is neutral (blue)
  function trendIndicator(key, trend) {
    if (!trend || trend === "flat") return { arrow: "→", cls: "text-neutral-500" };
    const isNetwork = key === "network";
    if (trend === "up")   return { arrow: "↑", cls: isNetwork ? "text-blue-400" : "text-rose-400" };
    return                       { arrow: "↓", cls: isNetwork ? "text-neutral-400" : "text-emerald-400" };
  }

  function getMetricsFreshness() {
    if (!metricsData.collectedAt) return { label: "no data yet", cls: "text-neutral-500", stale: true };
    const ageMins = (Date.now() - new Date(metricsData.collectedAt).getTime()) / 60000;
    if (ageMins < 5)  return { label: `updated ${Math.round(ageMins * 60)}s ago`, cls: "text-emerald-400", stale: false };
    if (ageMins < 10) return { label: `stale · ${Math.round(ageMins)}m ago`, cls: "text-amber-400", stale: true };
    return                   { label: `offline · ${Math.round(ageMins)}m ago`, cls: "text-rose-400", stale: true };
  }

  // 10 points × 2-min interval = ~18-min window; labels mark 0/25/50/75/100% positions
  const xLabels = ["-18m", "-14m", "-9m", "-5m", "now"];

  const runHealthCheck = async () => {
    setHealthChecking(true);
    try {
      const res = await fetch(`${API_BASE}/api/services/health`);
      const data = await res.json();
      if (data.ok) {
        const map = {};
        for (const r of data.results) {
          map[r.id] = { status: r.status, latencyMs: r.latencyMs, statusCode: r.statusCode, error: r.error, checkedAt: data.ts };
        }
        setHealthResults(map);
        setServicesData(prev => prev.map(svc => {
          const h = map[svc.id];
          return h ? { ...svc, status: h.status } : svc;
        }));
      }
    } catch (err) {
      console.error("Health check failed:", err);
    }
    setHealthChecking(false);
  };

  const openDnsAdd = () => {
    setDnsEditRrset(null);
    setDnsForm({ name: "", type: "A", ttl: 300, contents: [""] });
    setDnsFormError(null); setShowDnsModal(true);
  };

  const openDnsEdit = (rrset) => {
    setDnsEditRrset(rrset);
    setDnsForm({
      name: rrset.name,
      type: rrset.type,
      ttl: rrset.ttl,
      contents: rrset.records.map((r) => r.content),
    });
    setDnsFormError(null); setShowDnsModal(true);
  };

  const saveDnsRecord = async () => {
    const { name, type, ttl, contents } = dnsForm;
    const filled = contents.filter((c) => c.trim());
    if (!name.trim() || !filled.length) { setDnsFormError("Name and at least one content value are required"); return; }
    setDnsFormSaving(true); setDnsFormError(null);
    try {
      const res = await fetch(`${API_BASE}/api/dns/zones/${encodeURIComponent(dnsSelectedZone)}/records`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: name.trim(), type, ttl: Number(ttl), records: filled.map((c) => ({ content: c.trim(), disabled: false })) }),
      });
      const data = await res.json();
      if (!res.ok) { setDnsFormError(data.error || "Failed"); setDnsFormSaving(false); return; }
      setShowDnsModal(false);
      // Refresh zone
      const zr = await fetch(`${API_BASE}/api/dns/zones/${encodeURIComponent(dnsSelectedZone)}`);
      const zd = await zr.json();
      if (zd.ok) setDnsZoneDetail(zd.zone);
    } catch (err) { setDnsFormError(err.message); }
    setDnsFormSaving(false);
  };

  const deleteDnsRecord = async (rrset) => {
    if (!confirm(`Delete ${rrset.type} record "${rrset.name}"?`)) return;
    try {
      const res = await fetch(`${API_BASE}/api/dns/zones/${encodeURIComponent(dnsSelectedZone)}/records`, {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: rrset.name, type: rrset.type }),
      });
      if (res.ok) {
        const zr = await fetch(`${API_BASE}/api/dns/zones/${encodeURIComponent(dnsSelectedZone)}`);
        const zd = await zr.json();
        if (zd.ok) setDnsZoneDetail(zd.zone);
      }
    } catch (err) { console.error(err); }
  };

  const openWorkspaceCreate = () => {
    setEditingWorkspace(null);
    setWorkspaceForm({ name: "", slug: "" });
    setWorkspaceFormError(null); setShowWorkspaceModal(true);
  };
  const openWorkspaceEdit = (ws) => {
    setEditingWorkspace(ws);
    setWorkspaceForm({ name: ws.name, slug: ws.slug });
    setWorkspaceFormError(null); setShowWorkspaceModal(true);
  };
  const saveWorkspace = async () => {
    const { name, slug } = workspaceForm;
    if (!name.trim()) { setWorkspaceFormError("Name is required"); return; }
    setWorkspaceFormSaving(true); setWorkspaceFormError(null);
    const url = editingWorkspace
      ? `${API_BASE}/api/services/workspaces/${editingWorkspace.id}`
      : `${API_BASE}/api/services/workspaces`;
    const method = editingWorkspace ? "PATCH" : "POST";
    try {
      const res = await fetch(url, { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: name.trim(), slug: slug.trim() || name.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-") }) });
      const data = await res.json();
      if (!res.ok) { setWorkspaceFormError(data.error || "Failed"); setWorkspaceFormSaving(false); return; }
      setShowWorkspaceModal(false);
      const r = await fetch(`${API_BASE}/api/services/workspaces`);
      const d = await r.json();
      if (d.ok) { setWorkspacesMgmt(d.workspaces); setWorkspacesData(d.workspaces); }
    } catch (err) { setWorkspaceFormError(err.message); }
    setWorkspaceFormSaving(false);
  };
  const deleteWorkspace = async (ws) => {
    if (!confirm(`Delete workspace "${ws.name}"? Services will become unassigned.`)) return;
    const res = await fetch(`${API_BASE}/api/services/workspaces/${ws.id}`, { method: "DELETE" });
    if (res.ok) {
      const r = await fetch(`${API_BASE}/api/services/workspaces`);
      const d = await r.json();
      if (d.ok) { setWorkspacesMgmt(d.workspaces); setWorkspacesData(d.workspaces); }
    }
  };

  const saveRegisterFile = async () => {
    const { id, label, path: filePath, stack } = registerFileForm;
    if (!id || !label || !filePath || !stack) {
      setRegisterFileError("ID, label, path, and stack are all required");
      return;
    }
    setRegisterFileSaving(true); setRegisterFileError(null);
    try {
      const res = await fetch(`${API_BASE}/api/files/register`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...registerFileForm, path: filePath }),
      });
      const data = await res.json();
      if (!res.ok) { setRegisterFileError(data.error || "Failed"); setRegisterFileSaving(false); return; }
      setShowRegisterFileModal(false);
      setRegisterFileForm({ id:"", label:"", path:"", stack:"", type:"compose", editable:true, validatable:false, applyStrategy:null });
      // Refresh file list
      const fl = await fetch(`${API_BASE}/api/files`);
      const files = await fl.json();
      if (Array.isArray(files)) setFilesData(files);
    } catch (err) {
      setRegisterFileError(err.message);
    }
    setRegisterFileSaving(false);
  };

  const runLogsQuery = async () => {
    if (!logsSource) return;
    setLogsLoading(true);
    setLogsError("");
    try {
      const params = new URLSearchParams({
        type:   logsSourceType,
        source: logsSource,
        range:  logsRange,
        level:  logsLevel,
        search: logsSearch,
        limit:  "300",
      });
      const res  = await fetch(`${API_BASE}/api/logs/query?${params}`);
      const data = await res.json();
      if (data.ok) setLogsResults(data.lines || []);
      else setLogsError(data.error || "Query failed");
    } catch (err) {
      setLogsError(err.message);
    } finally {
      setLogsLoading(false);
    }
  };

  function formatUptime(seconds) {
    const d = Math.floor(seconds / 86400);
    const h = Math.floor((seconds % 86400) / 3600);
    if (d > 0) return `${d}d ${h}h`;
    const m = Math.floor((seconds % 3600) / 60);
    if (h > 0) return `${h}h ${m}m`;
    return `${m}m`;
  }

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
    if (item._action) runEmergencyAction(item._action);
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
            {metricsData.collectedAt
              ? <span className="rounded-full bg-emerald-500/20 px-2 py-1 text-xs text-emerald-300">Metrics live</span>
              : <span className="rounded-full bg-neutral-700/60 px-2 py-1 text-xs text-neutral-400">Awaiting metrics</span>}
            <button
              onClick={() => setShowAllApps(true)}
              className="ml-2 rounded-lg border border-cyan-400/30 bg-cyan-500/10 px-3 py-1 text-xs text-cyan-300 hover:bg-cyan-500/20"
            >
              All Apps
            </button>
          </div>
        </div>
      </div>

      {liveAlerts.length > 0 && (
        <div className="rounded-2xl border border-rose-400/30 bg-rose-500/10 p-4">
          <div className="mb-3 flex items-center justify-between">
            <div className="text-sm font-semibold text-rose-300">Active Alerts</div>
            <span className="rounded-full bg-rose-500/20 px-2 py-1 text-xs text-rose-300">{liveAlerts.length}</span>
          </div>
          <div className="space-y-2">
            {liveAlerts.map((a) => (
              <div
                key={a.id}
                className={[
                  "flex items-start gap-3 rounded-xl border px-3 py-2 text-xs",
                  a.level === "critical"
                    ? "border-rose-400/30 bg-rose-500/10 text-rose-300"
                    : "border-amber-400/30 bg-amber-500/10 text-amber-300",
                ].join(" ")}
              >
                <span>{a.level === "critical" ? "🔴" : "🟡"}</span>
                <div className="min-w-0">
                  <div className="font-semibold">{a.name}</div>
                  <div className="text-neutral-400">{a.message}</div>
                  {a.instance && <div className="mt-0.5 font-mono text-neutral-500">{a.instance}</div>}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Fleet VM tiles */}
      <div className="rounded-2xl border border-neutral-800 bg-neutral-900/70 p-4">
        <div className="mb-3 flex items-center justify-between">
          <div className="text-sm font-semibold text-neutral-200">Fleet</div>
          {opsVMsLoading && <span className="text-[10px] text-neutral-600">querying…</span>}
          {opsVMsTs && !opsVMsLoading && <span className="text-[10px] text-neutral-600">updated {new Date(opsVMsTs).toLocaleTimeString()}</span>}
        </div>
        {opsVMs.length === 0 && !opsVMsLoading && (
          <div className="text-xs text-neutral-600">No Prometheus data — ensure node-exporter is running on each VM</div>
        )}
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 xl:grid-cols-4">
          {opsVMs.map((vm) => {
            const cpuColor = vm.cpu > 90 ? "text-rose-300" : vm.cpu > 70 ? "text-amber-300" : "text-emerald-300";
            const ramColor = vm.ram > 90 ? "text-rose-300" : vm.ram > 70 ? "text-amber-300" : "text-cyan-300";
            const diskColor = vm.disk > 90 ? "text-rose-300" : vm.disk > 70 ? "text-amber-300" : "text-neutral-400";
            const barBase = "h-1 rounded-full";
            const cpuW = `${Math.min(vm.cpu ?? 0, 100)}%`;
            const ramW = `${Math.min(vm.ram ?? 0, 100)}%`;
            return (
              <div key={vm.name} className="rounded-xl border border-neutral-800 bg-neutral-950/60 p-2.5">
                <div className="flex items-center justify-between mb-1.5">
                  <span className="font-mono text-[11px] font-semibold text-neutral-200 truncate">{vm.name}</span>
                  <span className="shrink-0 ml-1 h-1.5 w-1.5 rounded-full bg-emerald-400"></span>
                </div>
                <div className="space-y-1.5">
                  <div>
                    <div className="flex justify-between text-[9px] mb-0.5">
                      <span className="text-neutral-600">CPU</span>
                      <span className={cpuColor}>{vm.cpu != null ? `${vm.cpu}%` : "—"}</span>
                    </div>
                    <div className="h-1 w-full rounded-full bg-neutral-800">
                      <div className={[barBase, vm.cpu > 90 ? "bg-rose-400" : vm.cpu > 70 ? "bg-amber-400" : "bg-emerald-400"].join(" ")} style={{ width: cpuW }} />
                    </div>
                  </div>
                  <div>
                    <div className="flex justify-between text-[9px] mb-0.5">
                      <span className="text-neutral-600">RAM</span>
                      <span className={ramColor}>{vm.ram != null ? `${vm.ram}%` : "—"}</span>
                    </div>
                    <div className="h-1 w-full rounded-full bg-neutral-800">
                      <div className={[barBase, vm.ram > 90 ? "bg-rose-400" : vm.ram > 70 ? "bg-amber-400" : "bg-cyan-400"].join(" ")} style={{ width: ramW }} />
                    </div>
                  </div>
                  {vm.disk != null && (
                    <div className="flex justify-between text-[9px]">
                      <span className="text-neutral-600">Disk</span>
                      <span className={diskColor}>{vm.disk}%</span>
                    </div>
                  )}
                  {vm.uptimeSeconds != null && (
                    <div className="flex justify-between text-[9px]">
                      <span className="text-neutral-600">Up</span>
                      <span className="text-neutral-500">{formatUptime(vm.uptimeSeconds)}</span>
                    </div>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {/* Service health summary */}
      {servicesData.length > 0 && (() => {
        const counts = servicesData.reduce((acc, s) => { acc[s.status] = (acc[s.status] || 0) + 1; return acc; }, {});
        const healthy = (counts.healthy || 0);
        const total = servicesData.filter((s) => !s.archived).length;
        const degraded = (counts.degraded || 0) + (counts.warning || 0);
        const down = counts.down || 0;
        const pct = total > 0 ? Math.round((healthy / total) * 100) : 0;
        return (
          <div className="rounded-2xl border border-neutral-800 bg-neutral-900/70 p-4">
            <div className="mb-3 flex items-center justify-between">
              <div className="text-sm font-semibold text-neutral-200">Services</div>
              <button onClick={() => setActiveBoard("Inventory")} className="text-[10px] text-neutral-600 hover:text-neutral-300">View all →</button>
            </div>
            <div className="mb-2 flex items-end gap-2">
              <span className={["text-2xl font-semibold", down > 0 ? "text-rose-300" : degraded > 0 ? "text-amber-300" : "text-emerald-300"].join(" ")}>{healthy}/{total}</span>
              <span className="mb-0.5 text-xs text-neutral-500">healthy</span>
            </div>
            <div className="h-1.5 w-full rounded-full bg-neutral-800 overflow-hidden flex">
              <div className="h-full bg-emerald-500 transition-all" style={{ width: `${pct}%` }} />
              {degraded > 0 && <div className="h-full bg-amber-500" style={{ width: `${Math.round((degraded/total)*100)}%` }} />}
              {down > 0 && <div className="h-full bg-rose-500" style={{ width: `${Math.round((down/total)*100)}%` }} />}
            </div>
            <div className="mt-2 flex flex-wrap gap-3 text-[10px]">
              {Object.entries(counts).sort().map(([st, n]) => (
                <span key={st} className={[
                  "capitalize",
                  st === "healthy" ? "text-emerald-400" : st === "down" ? "text-rose-400" : st === "degraded" || st === "warning" ? "text-amber-400" : "text-neutral-500"
                ].join(" ")}>{n} {st}</span>
              ))}
            </div>
          </div>
        );
      })()}

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

      <div className="rounded-2xl border border-neutral-800 bg-neutral-900 p-4">
        <div className="mb-3 text-sm font-semibold text-neutral-300">Recent Applies</div>
        {applyLogData.length === 0 ? (
          <div className="text-xs text-neutral-500">No apply activity yet</div>
        ) : (
          <div className="space-y-2 text-xs">
            {applyLogData.slice(0, 5).map((entry, i) => (
              <div key={i} className="flex justify-between">
                <div>
                  <span className={entry.ok ? "text-emerald-300" : "text-rose-300"}>
                    {entry.ok ? "✓" : "✕"}
                  </span>{" "}
                  {entry.fileId}
                </div>
                <div className="text-neutral-500">
                  {new Date(entry.timestamp).toLocaleTimeString()}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {allRestoreLogData.length > 0 && (
        <div className="rounded-2xl border border-neutral-800 bg-neutral-900 p-4">
          <div className="mb-3 text-sm font-semibold text-neutral-300">Recent Restores</div>
          <div className="space-y-2 text-xs">
            {allRestoreLogData.slice(0, 5).map((entry, i) => (
              <div key={i} className="flex items-center justify-between gap-2">
                <div className="flex items-center gap-1.5 min-w-0">
                  <span className={entry.outcome === "success" ? "text-emerald-300" : entry.outcome === "partial" ? "text-amber-300" : "text-rose-300"}>
                    {entry.outcome === "success" ? "✓" : entry.outcome === "partial" ? "◐" : "✕"}
                  </span>
                  <span className="truncate text-neutral-400">{entry.fileId}</span>
                  <span className="shrink-0 text-neutral-600">·</span>
                  <span className="shrink-0 text-neutral-500">{entry.type === "restore-and-apply" ? "r+apply" : "restore"}</span>
                  {entry.restoreMode === "side_by_side" && <span className="shrink-0 rounded bg-sky-500/15 px-1 py-0.5 text-[9px] text-sky-300">sbs</span>}
                  {entry.wasLkg && <span className="shrink-0 text-[9px] uppercase tracking-wide text-emerald-400/60">LKG</span>}
                  {entry.outcome === "partial" && <span className="shrink-0 rounded bg-amber-500/15 px-1 py-0.5 text-[9px] text-amber-300">partial</span>}
                  {entry.validation && (
                    <span className={[
                      "shrink-0 rounded px-1 py-0.5 text-[9px]",
                      entry.validation.status === "green" ? "text-emerald-400/60"
                      : entry.validation.status === "amber" ? "text-amber-400/60"
                      : "text-rose-400/60",
                    ].join(" ")}>v:{entry.validation.status}</span>
                  )}
                </div>
                <div className="shrink-0 text-neutral-600">{new Date(entry.timestamp).toLocaleTimeString()}</div>
              </div>
            ))}
          </div>
        </div>
      )}

      {(() => {
        const entries = Object.values(knownGoodSummary);
        const totalLkg = entries.filter((e) => e.hasKnownGood).length;
        if (totalLkg === 0) return null;
        const driftedFiles = entries.filter((e) => e.drifted).length;
        const uniqueStacks = [...new Set(filesData.map((f) => f.stack))];
        const driftedStacks = uniqueStacks.filter((s) => stackHasDrift(s)).length;
        return (
          <div className="rounded-2xl border border-emerald-400/20 bg-gradient-to-br from-emerald-500/10 to-green-500/5 p-4">
            <div className="mb-3 text-sm font-semibold text-neutral-200">Trust Summary</div>
            <div className="grid grid-cols-3 gap-3">
              <div className="rounded-xl border border-neutral-800 bg-neutral-900/50 px-3 py-2">
                <div className="text-[10px] uppercase tracking-wide text-neutral-500">Baselines</div>
                <div className="mt-1 text-lg font-semibold text-emerald-300">{totalLkg}</div>
              </div>
              <div className="rounded-xl border border-neutral-800 bg-neutral-900/50 px-3 py-2">
                <div className="text-[10px] uppercase tracking-wide text-neutral-500">Drifted files</div>
                <div className={["mt-1 text-lg font-semibold", driftedFiles > 0 ? "text-amber-300" : "text-neutral-400"].join(" ")}>{driftedFiles}</div>
              </div>
              <div className="rounded-xl border border-neutral-800 bg-neutral-900/50 px-3 py-2">
                <div className="text-[10px] uppercase tracking-wide text-neutral-500">Drifted stacks</div>
                <div className={["mt-1 text-lg font-semibold", driftedStacks > 0 ? "text-amber-300" : "text-neutral-400"].join(" ")}>{driftedStacks}</div>
              </div>
            </div>
          </div>
        );
      })()}

      <div className="grid grid-cols-2 gap-4">
        <div className="rounded-2xl border border-cyan-400/20 bg-gradient-to-br from-cyan-500/10 to-blue-500/5 p-4">
          <div className="text-[10px] uppercase tracking-wide text-neutral-500">CPU</div>
          <div className="mt-1 text-2xl font-semibold">
            {metricsData.stats?.cpu?.current !== null && metricsData.stats?.cpu?.current !== undefined
              ? `${metricsData.stats.cpu.current}%`
              : "—"}
          </div>
          <div className="mt-1 text-xs text-neutral-500">
            {metricsData.stats?.cpu?.trend === "up" ? "↑ increasing" : metricsData.stats?.cpu?.trend === "down" ? "↓ decreasing" : "→ stable"}
          </div>
        </div>
        <div className="rounded-2xl border border-purple-400/20 bg-gradient-to-br from-purple-500/10 to-indigo-500/5 p-4">
          <div className="text-[10px] uppercase tracking-wide text-neutral-500">Memory</div>
          <div className="mt-1 text-2xl font-semibold">
            {metricsData.stats?.memory?.current !== null && metricsData.stats?.memory?.current !== undefined
              ? `${metricsData.stats.memory.current}%`
              : "—"}
          </div>
          <div className="mt-1 text-xs text-neutral-500">
            {metricsData.stats?.memory?.trend === "up" ? "↑ increasing" : metricsData.stats?.memory?.trend === "down" ? "↓ decreasing" : "→ stable"}
          </div>
        </div>
        <div className="rounded-2xl border border-emerald-400/20 bg-gradient-to-br from-emerald-500/10 to-green-500/5 p-4">
          <div className="text-[10px] uppercase tracking-wide text-neutral-500">Storage</div>
          <div className="mt-1 text-2xl font-semibold">
            {metricsData.stats?.storage?.current !== null && metricsData.stats?.storage?.current !== undefined
              ? `${metricsData.stats.storage.current}%`
              : "—"}
          </div>
          <div className="mt-1 text-xs text-neutral-500">used on /</div>
        </div>
        <div className="rounded-2xl border border-amber-400/20 bg-gradient-to-br from-amber-500/10 to-orange-500/5 p-4">
          <div className="text-[10px] uppercase tracking-wide text-neutral-500">Metrics</div>
          <div className="mt-1 text-sm font-semibold">
            {metricsData.collectedAt
              ? new Date(metricsData.collectedAt).toLocaleTimeString()
              : "—"}
          </div>
          <div className="mt-1 text-xs text-neutral-500">
            {metricsData.cpu.length} point{metricsData.cpu.length !== 1 ? "s" : ""} · {metricsData.collectedAt ? "live" : "waiting"}
          </div>
        </div>
      </div>
    </div>
  );

  const adminRootView = (
    <div className="space-y-5">
      {/* Storage & Network */}
      <div>
        <div className="mb-2 text-xs font-semibold uppercase tracking-wider text-neutral-500">Storage & Network</div>
        {renderCards([
          { name: "Disk Usage",          onClick: () => setAdminView("disk") },
          { name: "Network",             onClick: () => setAdminView("network") },
        ])}
      </div>
      {/* Backups */}
      <div>
        <div className="mb-2 text-xs font-semibold uppercase tracking-wider text-neutral-500">Backups</div>
        {renderCards([
          { name: "Backup Configuration", onClick: () => setAdminView("backup") },
        ])}
      </div>
      {/* Identity & Access */}
      <div>
        <div className="mb-2 text-xs font-semibold uppercase tracking-wider text-neutral-500">Identity & Access</div>
        {renderCards([
          { name: "Manage Users",         onClick: () => setAdminView("users-manage") },
          { name: "Workspaces",            onClick: () => setAdminView("workspaces") },
          { name: "User Activity",        onClick: () => setAdminView("users") },
          { name: "Certificate Status",   onClick: () => setAdminView("certs") },
          { name: "Audit Log",            onClick: () => setAdminView("audit") },
          { name: "Keycloak Admin",       onClick: () => window.open("https://auth.house-of-trae.com/admin", "_blank") },
        ])}
      </div>
    </div>
  );

  const backupPanel = (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <div className="text-xs uppercase tracking-wider text-cyan-300/80">Admin</div>
          <div className="text-lg font-semibold">Backup Configuration</div>
        </div>
        <button onClick={() => setAdminView(null)} className="text-xs text-neutral-400 hover:text-white">← Back</button>
      </div>

      {/* Summary row */}
      <div className="grid grid-cols-2 gap-3">
        <div className="rounded-xl border border-neutral-800 bg-neutral-900/70 p-3">
          <div className="text-[10px] uppercase tracking-wide text-neutral-500">Schedule</div>
          <div className="mt-1 text-xs text-neutral-300">{backupData?.schedule ?? "Daily at 02:00 UTC"}</div>
        </div>
        <div className="rounded-xl border border-neutral-800 bg-neutral-900/70 p-3">
          <div className="text-[10px] uppercase tracking-wide text-neutral-500">Destinations</div>
          <div className="mt-1 text-xs text-neutral-300">{backupData?.destination ?? "B2 + Wasabi (encrypted)"}</div>
        </div>
      </div>

      {/* Tier table */}
      {backupData?.tiers && (
        <div className="rounded-xl border border-neutral-800 bg-neutral-900/70 overflow-hidden">
          <div className="grid grid-cols-4 gap-0 border-b border-neutral-800 px-3 py-2 text-[10px] uppercase tracking-wide text-neutral-500">
            <div>Tier</div><div>Tool</div><div>Schedule</div><div>Destination</div>
          </div>
          {backupData.tiers.map((t) => (
            <div key={t.name} className="grid grid-cols-4 gap-0 border-b border-neutral-800/50 px-3 py-2 text-xs last:border-0">
              <div className="font-semibold text-neutral-200">{t.name}</div>
              <div className="text-neutral-400">{t.tool}</div>
              <div className="text-neutral-400">{t.schedule}</div>
              <div className="text-neutral-500">{t.dest}</div>
            </div>
          ))}
        </div>
      )}

      {/* Actions */}
      <div className="grid grid-cols-2 gap-3">
        <button
          disabled={!can("admin") || backupRunning}
          onClick={async () => {
            setBackupRunning(true); setBackupRunResult(null);
            try {
              const r = await fetch(`${API_BASE}/api/admin/backup/run`, { method: "POST" });
              const d = await r.json();
              setBackupRunResult(d);
            } catch(e) { setBackupRunResult({ ok: false, message: e.message }); }
            finally { setBackupRunning(false); }
          }}
          className="rounded-2xl border border-cyan-400/30 bg-cyan-500/10 p-4 text-left hover:bg-cyan-500/20 disabled:opacity-50 disabled:cursor-not-allowed"
        >
          <div className="font-semibold text-cyan-200">{backupRunning ? "Triggering…" : "Run Backup Now"}</div>
          {backupRunResult && (
            <div className={`mt-1 text-xs ${backupRunResult.ok ? "text-emerald-400" : "text-rose-400"}`}>{backupRunResult.message}</div>
          )}
          {!can("admin") && <div className="mt-1 text-xs text-neutral-500">Requires admin role</div>}
        </button>
        <div className="cursor-pointer rounded-2xl border border-amber-400/30 bg-amber-500/10 p-4 hover:bg-amber-500/20">
          <div className="font-semibold text-amber-200">Test Restore</div>
          <div className="mt-1 text-xs text-neutral-500">Restore jobs run on Proxmox</div>
        </div>
      </div>
    </div>
  );

  const networkPanel = (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <div className="text-xs uppercase tracking-wider text-purple-300/80">Admin</div>
          <div className="text-lg font-semibold">Network Overview</div>
        </div>
        <button onClick={() => setAdminView(null)} className="text-xs text-neutral-400 hover:text-white">← Back</button>
      </div>

      {!networkData && <div className="text-xs text-neutral-500">Loading…</div>}

      {networkData?.interfaces && (
        <div>
          <div className="mb-2 text-xs font-semibold uppercase tracking-wide text-neutral-500">Host Interfaces</div>
          <div className="space-y-2">
            {networkData.interfaces
              .filter(iface => !iface.name.startsWith("br-") && iface.name !== "lo")
              .map(iface => (
                <div key={iface.name} className="rounded-xl border border-neutral-800 bg-neutral-900/70 p-3">
                  <div className="flex items-center justify-between">
                    <div className="font-mono text-sm text-neutral-200">{iface.name}</div>
                    <div className="text-[10px] text-neutral-600">{iface.addresses.length} addr</div>
                  </div>
                  {iface.addresses.map((a, i) => (
                    <div key={i} className="mt-1 font-mono text-xs text-neutral-400">
                      {a.address} <span className="text-neutral-600">({a.family})</span>
                    </div>
                  ))}
                </div>
              ))
            }
          </div>
        </div>
      )}

      {networkData?.networks && (
        <div>
          <div className="mb-2 text-xs font-semibold uppercase tracking-wide text-neutral-500">Docker Networks</div>
          <div className="rounded-xl border border-neutral-800 bg-neutral-900/70 overflow-hidden">
            <div className="grid grid-cols-4 border-b border-neutral-800 px-3 py-2 text-[10px] uppercase tracking-wide text-neutral-500">
              <div>Name</div><div>Driver</div><div>Scope</div><div>Subnet</div>
            </div>
            {networkData.networks
              .filter(n => !n.name.startsWith("br-") || n.subnet !== "—")
              .map(n => (
                <div key={n.name} className="grid grid-cols-4 border-b border-neutral-800/50 px-3 py-2 text-xs last:border-0">
                  <div className="font-mono text-neutral-200 truncate">{n.name}</div>
                  <div className="text-neutral-400">{n.driver}</div>
                  <div className="text-neutral-400">{n.scope}</div>
                  <div className="font-mono text-neutral-500">{n.subnet}</div>
                </div>
              ))
            }
          </div>
        </div>
      )}
    </div>
  );

  const certPanel = (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <div className="text-xs uppercase tracking-wider text-blue-300/80">TLS</div>
          <div className="text-lg font-semibold">Certificate Status</div>
        </div>
        <div className="flex gap-2">
          <button onClick={() => { setCertData(null); setCertError(false); fetch(`${API_BASE}/api/admin/certs`).then(r=>r.json()).then(d=>{if(d.ok)setCertData(d);else setCertError(true);}).catch(()=>setCertError(true)); }}
            className="rounded-lg border border-neutral-700 px-3 py-1 text-xs text-neutral-400 hover:text-white">Refresh</button>
          <button onClick={() => setAdminView(null)} className="text-xs text-neutral-400 hover:text-white">← Back</button>
        </div>
      </div>

      {certError && (
        <div className="rounded-xl border border-rose-400/30 bg-rose-500/10 p-3 text-xs text-rose-300">
          Failed to load — Prometheus Blackbox Exporter may be unreachable (10.10.50.104:9090)
        </div>
      )}

      {!certData && !certError && <div className="text-xs text-neutral-500">Loading cert data from Prometheus…</div>}

      {certData && (
        <>
          <div className="grid grid-cols-3 gap-3">
            <div className="rounded-xl border border-emerald-400/20 bg-emerald-500/10 p-3 text-center">
              <div className="text-lg font-semibold text-emerald-300">{certData.certs.filter(c=>c.status==="ok").length}</div>
              <div className="text-[10px] uppercase tracking-wide text-neutral-500">Healthy</div>
            </div>
            <div className="rounded-xl border border-amber-400/20 bg-amber-500/10 p-3 text-center">
              <div className="text-lg font-semibold text-amber-300">{certData.certs.filter(c=>c.status==="warning").length}</div>
              <div className="text-[10px] uppercase tracking-wide text-neutral-500">Warning &lt;14d</div>
            </div>
            <div className="rounded-xl border border-rose-400/20 bg-rose-500/10 p-3 text-center">
              <div className="text-lg font-semibold text-rose-300">{certData.certs.filter(c=>c.status==="critical").length}</div>
              <div className="text-[10px] uppercase tracking-wide text-neutral-500">Critical &lt;7d</div>
            </div>
          </div>
          <div className="space-y-2">
            {certData.certs.map((cert) => (
              <div key={cert.instance} className={[
                "rounded-xl border p-3",
                cert.status==="critical" ? "border-rose-400/30 bg-rose-500/5"
                : cert.status==="warning" ? "border-amber-400/30 bg-amber-500/5"
                : "border-neutral-800 bg-neutral-900/70"
              ].join(" ")}>
                <div className="flex items-center justify-between">
                  <div className="min-w-0 font-mono text-xs text-neutral-300 truncate">{cert.instance}</div>
                  <div className={["ml-3 shrink-0 text-sm font-bold",
                    cert.status==="critical" ? "text-rose-300"
                    : cert.status==="warning" ? "text-amber-300"
                    : "text-emerald-300"
                  ].join(" ")}>{cert.daysLeft}d</div>
                </div>
                <div className="mt-1 text-[10px] text-neutral-500">Expires {new Date(cert.expiry).toLocaleDateString()} · {cert.job}</div>
                <div className="mt-2 h-1 rounded-full bg-neutral-800">
                  <div className={["h-1 rounded-full",
                    cert.status==="critical" ? "bg-rose-400"
                    : cert.status==="warning" ? "bg-amber-400"
                    : "bg-emerald-400"
                  ].join(" ")} style={{ width: `${Math.min(100,Math.max(2,Math.round((cert.daysLeft/90)*100)))}%` }} />
                </div>
              </div>
            ))}
          </div>
          <div className="text-[10px] text-neutral-600">Source: Prometheus Blackbox Exporter · {new Date(certData.ts).toLocaleTimeString()}</div>
        </>
      )}
    </div>
  );

  const diskPanel = (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <div className="text-xs uppercase tracking-wider text-emerald-300/80">Admin</div>
          <div className="text-lg font-semibold">Disk Usage</div>
        </div>
        <button onClick={() => setAdminView(null)} className="text-xs text-neutral-400 hover:text-white">← Back</button>
      </div>

      {!diskData && <div className="text-xs text-neutral-500">Loading…</div>}

      {diskData && (
        <>
          <div className="space-y-2">
            {diskData.mounts.map((m) => (
              <div key={m.mount} className="rounded-xl border border-neutral-800 bg-neutral-900/70 p-3">
                <div className="flex items-center justify-between text-xs">
                  <span className="font-mono text-neutral-200">{m.mount}</span>
                  <span className={m.pct>90 ? "text-rose-300" : m.pct>80 ? "text-amber-300" : "text-neutral-400"}>{m.pct}%</span>
                </div>
                <div className="mt-1.5 h-1.5 rounded-full bg-neutral-800">
                  <div className={["h-1.5 rounded-full",m.pct>90?"bg-rose-400":m.pct>80?"bg-amber-400":"bg-emerald-400"].join(" ")}
                    style={{ width: `${m.pct}%` }} />
                </div>
                <div className="mt-1 text-[10px] text-neutral-600">{m.fs} · {Math.round(m.used/1024/1024)}GB used / {Math.round(m.total/1024/1024)}GB total · {Math.round(m.avail/1024/1024)}GB free</div>
              </div>
            ))}
          </div>
          {diskData.dockerVolumes.length > 0 && (
            <div>
              <div className="mb-2 text-xs font-semibold uppercase tracking-wide text-neutral-500">Docker Volumes ({diskData.dockerVolumes.length})</div>
              <div className="space-y-1">
                {diskData.dockerVolumes.map((v) => (
                  <div key={v.name} className="flex items-center justify-between rounded-lg border border-neutral-800/50 bg-neutral-900/50 px-3 py-2 text-xs">
                    <span className="font-mono text-neutral-300 truncate">{v.name}</span>
                    <span className="ml-2 shrink-0 text-neutral-600">{v.driver}</span>
                  </div>
                ))}
              </div>
            </div>
          )}
          <div className="text-[10px] text-neutral-600">{new Date(diskData.ts).toLocaleTimeString()}</div>
        </>
      )}
    </div>
  );

  const usersPanel = (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <div className="text-xs uppercase tracking-wider text-purple-300/80">IAM</div>
          <div className="text-lg font-semibold">User Activity</div>
        </div>
        <button onClick={() => setAdminView(null)} className="text-xs text-neutral-400 hover:text-white">← Back</button>
      </div>

      {!usersData && <div className="text-xs text-neutral-500">Loading…</div>}

      {usersData?.users?.length === 0 && <div className="text-xs text-neutral-500">No audit activity recorded yet.</div>}

      {usersData?.users && usersData.users.length > 0 && (
        <div className="space-y-2">
          {usersData.users.map((u) => (
            <div key={u.username} className="rounded-xl border border-neutral-800 bg-neutral-900/70 p-3">
              <div className="flex items-center justify-between">
                <div>
                  <div className="text-sm font-semibold text-neutral-200">{u.username}</div>
                  <div className="mt-0.5 text-xs capitalize text-neutral-500">{u.role}</div>
                </div>
                <div className="text-right">
                  <div className="text-xs text-neutral-400">{u.action_count} actions</div>
                  {u.failures > 0 && <div className="text-xs text-rose-400">{u.failures} failures</div>}
                  <div className="mt-0.5 text-[10px] text-neutral-600">{new Date(u.last_seen).toLocaleDateString()}</div>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );

  const ROLE_COLORS = {
    breakglass:  "border-rose-400/40 bg-rose-500/10 text-rose-300",
    superadmin:  "border-purple-400/40 bg-purple-500/10 text-purple-300",
    admin:       "border-amber-400/40 bg-amber-500/10 text-amber-300",
    operator:    "border-blue-400/40 bg-blue-500/10 text-blue-300",
    viewer:      "border-neutral-600 bg-neutral-800 text-neutral-400",
  };

  const usersMgmtPanel = (
    <div className="space-y-4">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <div className="text-xs uppercase tracking-wider text-purple-300/80">IAM</div>
          <div className="text-lg font-semibold">Manage Users</div>
        </div>
        <div className="flex items-center gap-2">
          <a href="https://auth.house-of-trae.com/admin" target="_blank" rel="noreferrer"
            className="rounded-lg border border-purple-400/30 bg-purple-500/10 px-3 py-1.5 text-xs text-purple-300 hover:bg-purple-500/20">
            Open Keycloak ↗
          </a>
          <button onClick={() => setAdminView(null)} className="text-xs text-neutral-400 hover:text-white">← Back</button>
        </div>
      </div>

      {/* Info note */}
      <div className="rounded-xl border border-neutral-800 bg-neutral-900/60 px-4 py-3 text-xs text-neutral-500">
        Users are provisioned via Keycloak SSO (realm: <span className="text-neutral-300">securenexus</span>). Create, deactivate or reset passwords in the Keycloak admin console. Roles shown below reflect the most recent authenticated session.
      </div>

      {/* Loading */}
      {usersMgmtLoading && <div className="text-xs text-neutral-500">Loading…</div>}

      {/* Empty */}
      {!usersMgmtLoading && usersMgmtData?.users?.length === 0 && (
        <div className="rounded-xl border border-neutral-800 bg-neutral-900/60 p-8 text-center text-xs text-neutral-600">
          No users have logged in yet.
        </div>
      )}

      {/* User table */}
      {usersMgmtData?.users && usersMgmtData.users.length > 0 && (
        <div className="overflow-hidden rounded-xl border border-neutral-800">
          <div className="grid grid-cols-[1fr_auto_auto_auto_auto] items-center border-b border-neutral-800 bg-neutral-900/80 px-4 py-2 text-[10px] uppercase tracking-wide text-neutral-500">
            <div>User</div>
            <div className="px-4">Role</div>
            <div className="px-4 text-right">Actions</div>
            <div className="px-4 text-right">Last Seen</div>
            <div />
          </div>
          {usersMgmtData.users.map((u) => (
            <div key={u.user_sub}
              className="grid grid-cols-[1fr_auto_auto_auto_auto] items-center border-b border-neutral-800/50 px-4 py-3 text-xs last:border-0 hover:bg-neutral-800/20">
              <div>
                <div className="font-semibold text-neutral-200">{u.username}</div>
                <div className="mt-0.5 font-mono text-[10px] text-neutral-600 truncate max-w-[220px]" title={u.user_sub}>
                  {u.user_sub.slice(0, 8)}…{u.user_sub.slice(-4)}
                </div>
              </div>
              <div className="px-4">
                <span className={["rounded-full border px-2 py-0.5 text-[10px] font-semibold capitalize",
                  ROLE_COLORS[u.role] || ROLE_COLORS.viewer
                ].join(" ")}>{u.role}</span>
              </div>
              <div className="px-4 text-right text-neutral-400">
                {u.action_count}
                {u.failures > 0 && (
                  <span className="ml-1 text-rose-400">({u.failures} fail)</span>
                )}
              </div>
              <div className="px-4 text-right text-neutral-500">
                {new Date(u.last_seen).toLocaleDateString()}
              </div>
              <div>
                <a
                  href={`https://auth.house-of-trae.com/admin/master/console/#/securenexus/users/${u.user_sub}`}
                  target="_blank" rel="noreferrer"
                  className="rounded-lg border border-neutral-700 px-2 py-1 text-[10px] text-neutral-500 hover:border-purple-400/40 hover:text-purple-300 transition">
                  KC ↗
                </a>
              </div>
            </div>
          ))}
        </div>
      )}

      <div className="text-[10px] text-neutral-600">
        {usersMgmtData?.users?.length ?? 0} known user{(usersMgmtData?.users?.length ?? 0) !== 1 ? "s" : ""} · source: audit log
      </div>
    </div>
  );

  const ACTION_COLORS = {
    "auth.login":             "text-cyan-400",
    "auth.logout":            "text-neutral-400",
    "container.start":        "text-emerald-400",
    "container.stop":         "text-rose-400",
    "container.restart":      "text-amber-400",
    "file.write":             "text-purple-400",
    "file.apply":             "text-purple-400",
    "file.draft":             "text-neutral-400",
    "file.restore":           "text-blue-400",
    "file.restore-and-apply": "text-blue-400",
    "file.prune":             "text-rose-400",
    "file.mark-known-good":   "text-emerald-400",
    "file.label":             "text-neutral-400",
    "service.create":                  "text-teal-400",
    "service.update":                  "text-teal-400",
    "service.archive":                 "text-amber-400",
    "service.restore":                 "text-emerald-400",
    "service.status":                  "text-neutral-400",
    "emergency.stacks.stop-all":       "text-rose-400",
    "emergency.stacks.restart-all":    "text-amber-400",
    "emergency.maintenance.enable":    "text-amber-400",
    "emergency.maintenance.disable":   "text-emerald-400",
    "diagnostics.run":                 "text-cyan-400",
  };

  const auditPanel = (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div className="text-lg font-semibold">Audit Log</div>
        <button onClick={() => setAdminView(null)} className="text-xs text-neutral-400 hover:text-white">← Back</button>
      </div>

      {/* Filters */}
      <div className="flex gap-3">
        <select
          value={auditFilter.action}
          onChange={(e) => setAuditFilter((f) => ({ ...f, action: e.target.value }))}
          className="rounded-lg border border-neutral-700 bg-neutral-900 px-3 py-1.5 text-xs text-neutral-300 focus:border-purple-400/50 focus:outline-none"
        >
          <option value="">All actions</option>
          <option value="auth.login">auth.login</option>
          <option value="auth.logout">auth.logout</option>
          <option value="container.start">container.start</option>
          <option value="container.stop">container.stop</option>
          <option value="container.restart">container.restart</option>
          <option value="file.write">file.write</option>
          <option value="file.apply">file.apply</option>
          <option value="file.draft">file.draft</option>
          <option value="file.restore">file.restore</option>
          <option value="file.restore-and-apply">file.restore-and-apply</option>
          <option value="file.prune">file.prune</option>
          <option value="file.mark-known-good">file.mark-known-good</option>
          <option value="file.label">file.label</option>
          <option value="service.create">service.create</option>
          <option value="service.update">service.update</option>
          <option value="service.archive">service.archive</option>
          <option value="service.restore">service.restore</option>
          <option value="service.status">service.status</option>
        </select>
        <select
          value={auditFilter.outcome}
          onChange={(e) => setAuditFilter((f) => ({ ...f, outcome: e.target.value }))}
          className="rounded-lg border border-neutral-700 bg-neutral-900 px-3 py-1.5 text-xs text-neutral-300 focus:border-purple-400/50 focus:outline-none"
        >
          <option value="">All outcomes</option>
          <option value="success">Success</option>
          <option value="failure">Failure</option>
        </select>
        {(auditFilter.action || auditFilter.outcome) && (
          <button
            onClick={() => setAuditFilter({ action: "", outcome: "" })}
            className="rounded-lg border border-neutral-700 bg-neutral-900 px-3 py-1.5 text-xs text-neutral-400 hover:text-white"
          >
            Clear
          </button>
        )}
        <div className="ml-auto text-xs text-neutral-500 self-center">
          {auditLoading ? "Loading…" : `${auditData.length} events`}
        </div>
      </div>

      {/* Table */}
      {auditError ? (
        <div className="rounded-xl border border-rose-500/30 bg-rose-500/10 px-4 py-3 text-sm text-rose-400">{auditError}</div>
      ) : auditLoading ? (
        <div className="py-12 text-center text-sm text-neutral-500">Loading audit log…</div>
      ) : auditData.length === 0 ? (
        <div className="py-12 text-center text-sm text-neutral-500">No events recorded yet.</div>
      ) : (
        <div className="overflow-hidden rounded-xl border border-neutral-800">
          <table className="w-full text-xs">
            <thead>
              <tr className="border-b border-neutral-800 bg-neutral-900/80 text-left text-neutral-500">
                <th className="px-3 py-2 font-medium">Time</th>
                <th className="px-3 py-2 font-medium">User</th>
                <th className="px-3 py-2 font-medium">Role</th>
                <th className="px-3 py-2 font-medium">Action</th>
                <th className="px-3 py-2 font-medium">Target</th>
                <th className="px-3 py-2 font-medium">Result</th>
              </tr>
            </thead>
            <tbody>
              {auditData.map((entry, i) => {
                const ts = new Date(entry.ts);
                const timeStr = ts.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", second: "2-digit" });
                const dateStr = ts.toLocaleDateString("en-GB", { day: "2-digit", month: "short" });
                const actionCls = ACTION_COLORS[entry.action] || "text-neutral-300";
                return (
                  <tr key={entry.id} className={["border-b border-neutral-800/60 hover:bg-neutral-800/30", i % 2 === 0 ? "bg-neutral-900/20" : ""].join(" ")}>
                    <td className="px-3 py-2 text-neutral-500 whitespace-nowrap">
                      <div>{timeStr}</div>
                      <div className="text-neutral-600">{dateStr}</div>
                    </td>
                    <td className="px-3 py-2 text-neutral-300 font-medium">{entry.username}</td>
                    <td className="px-3 py-2 text-neutral-500">{entry.role}</td>
                    <td className={["px-3 py-2 font-mono font-semibold", actionCls].join(" ")}>{entry.action}</td>
                    <td className="px-3 py-2 text-neutral-400 max-w-[180px] truncate" title={entry.target ?? "—"}>{entry.target ?? "—"}</td>
                    <td className="px-3 py-2">
                      {entry.outcome === "success" ? (
                        <span className="inline-flex items-center gap-1 rounded-full bg-emerald-500/10 px-2 py-0.5 text-emerald-400">✓ ok</span>
                      ) : (
                        <span className="inline-flex items-center gap-1 rounded-full bg-rose-500/10 px-2 py-0.5 text-rose-400" title={entry.detail?.error ?? ""}>✗ fail</span>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );

  // -------------------------------------------------------------------------
  // Inventory / Service Registry helpers
  // -------------------------------------------------------------------------
  const STATUS_STYLES = {
    healthy:  "bg-emerald-500/15 text-emerald-300 border-emerald-500/30",
    warning:  "bg-amber-500/15 text-amber-300 border-amber-500/30",
    degraded: "bg-orange-500/15 text-orange-300 border-orange-500/30",
    down:     "bg-rose-500/15 text-rose-300 border-rose-500/30",
    unknown:  "bg-neutral-700/40 text-neutral-400 border-neutral-600/30",
  };
  const ACCESS_MODE_STYLES = {
    public:   "bg-emerald-500/10 text-emerald-400",
    sso:      "bg-blue-500/10 text-blue-400",
    vpn_only: "bg-amber-500/10 text-amber-400",
    internal: "bg-neutral-700/40 text-neutral-400",
    mtls:     "bg-purple-500/10 text-purple-400",
  };
  const CATEGORY_LABELS = {
    business: "Business",
    personal: "Personal",
    ops:      "Ops",
    admin:    "Admin",
    infra:    "Infra",
  };

  const BLANK_SERVICE_FORM = {
    name: "", slug: "", description: "", category: "infra",
    access_url: "", access_mode: "internal", runtime_type: "docker",
    owner: "", backup_policy: "none", health_endpoint: "", workspace_id: "",
  };

  function slugify(str) {
    return str.toLowerCase().trim().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  }

  function openCreateService() {
    setEditingService(null);
    setServiceForm(BLANK_SERVICE_FORM);
    setServiceFormError(null);
    setSlugTouched(false);
    setShowServiceModal(true);
  }

  function openEditService(svc) {
    setEditingService(svc);
    setSlugTouched(true);
    setServiceForm({
      name: svc.name, slug: svc.slug, description: svc.description || "",
      category: svc.category, access_url: svc.access_url || "",
      access_mode: svc.access_mode, runtime_type: svc.runtime_type,
      owner: svc.owner, backup_policy: svc.backup_policy,
      health_endpoint: svc.health_endpoint || "",
      workspace_id: svc.workspace_id || "",
    });
    setServiceFormError(null);
    setShowServiceModal(true);
  }

  async function saveService() {
    setServiceSaving(true);
    setServiceFormError(null);
    try {
      const url  = editingService ? `${API_BASE}/api/services/${editingService.id}` : `${API_BASE}/api/services`;
      const method = editingService ? "PUT" : "POST";
      const res  = await fetch(url, { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(serviceForm) });
      const data = await res.json();
      if (!res.ok) { setServiceFormError(data.error || "Save failed"); setServiceSaving(false); return; }
      setShowServiceModal(false);
      setServicesData((prev) => {
        if (editingService) return prev.map((s) => s.id === data.id ? data : s);
        return [...prev, data];
      });
      if (editingService && selectedService?.id === data.id) setSelectedService(data);
    } catch { setServiceFormError("Network error"); }
    setServiceSaving(false);
  }

  async function archiveService(svc) {
    const res = await fetch(`${API_BASE}/api/services/${svc.id}`, {
      method: "PATCH", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ archived: !svc.archived }),
    });
    if (res.ok) {
      const data = await res.json();
      setServicesData((prev) => prev.map((s) => s.id === data.id ? data : s).filter((s) => showArchivedServices || !s.archived));
    }
  }

  function openServiceDetail(svc) {
    setSelectedService(svc);
    setServiceHealthHistory([]);
    setServiceActionError(null);
    setServiceHistoryLoading(true);
    fetch(`${API_BASE}/api/services/${svc.id}/health-history?limit=40`)
      .then((r) => r.json())
      .then((d) => { setServiceHealthHistory(d.events || []); setServiceHistoryLoading(false); })
      .catch(() => setServiceHistoryLoading(false));
  }

  function closeServiceDetail() {
    setSelectedService(null);
    setServiceHealthHistory([]);
    setServiceActionError(null);
    setServiceActionConfirm(null);
  }

  async function executeServiceAction(action) {
    if (!selectedService) return;
    setServiceActionPending(action);
    setServiceActionError(null);
    try {
      if (action === "health-refresh") {
        const r = await fetch(`${API_BASE}/api/services/health`);
        const d = await r.json();
        if (d.ok && d.results) {
          const result = d.results.find((x) => x.id === selectedService.id);
          if (result) {
            setSelectedService((prev) => ({ ...prev, status: result.status, updated_at: new Date().toISOString() }));
            setServicesData((prev) => prev.map((s) => s.id === selectedService.id ? { ...s, status: result.status } : s));
          }
          const hr = await fetch(`${API_BASE}/api/services/${selectedService.id}/health-history?limit=40`);
          const hd = await hr.json();
          setServiceHealthHistory(hd.events || []);
        }
      }
    } catch (err) {
      setServiceActionError("Action failed: " + err.message);
    } finally {
      setServiceActionPending(null);
    }
  }

  const serviceActionModal = serviceActionConfirm && selectedService && (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4">
      <div className="w-full max-w-sm rounded-2xl border border-emerald-400/20 bg-neutral-950 shadow-2xl">
        <div className="flex items-center justify-between border-b border-neutral-800 px-6 py-4">
          <div className="text-base font-semibold">{serviceActionConfirm.label}</div>
          <button onClick={() => setServiceActionConfirm(null)} className="text-neutral-500 hover:text-white text-lg">✕</button>
        </div>
        <div className="px-6 py-4 space-y-2 text-sm text-neutral-400">
          <div className="font-medium text-neutral-200">{selectedService.name}</div>
          <div>{serviceActionConfirm.desc}</div>
          <div className="rounded-lg border border-amber-400/20 bg-amber-500/10 px-3 py-2 text-xs text-amber-300">
            This action will be recorded in the audit log.
          </div>
        </div>
        <div className="flex justify-end gap-2 border-t border-neutral-800 px-6 py-4">
          <button onClick={() => setServiceActionConfirm(null)}
            className="rounded-lg border border-neutral-700 px-4 py-2 text-xs text-neutral-400 hover:text-white">
            Cancel
          </button>
          <button onClick={() => { executeServiceAction(serviceActionConfirm.action); setServiceActionConfirm(null); }}
            className="rounded-lg border border-emerald-400/30 bg-emerald-500/10 px-4 py-2 text-xs text-emerald-300 hover:bg-emerald-500/20">
            Confirm
          </button>
        </div>
      </div>
    </div>
  );

  const serviceDetailView = selectedService && (
    <>
      {serviceActionModal}
      <div className="space-y-4">
        {/* Detail header */}
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-teal-400/20 bg-gradient-to-r from-teal-500/10 via-cyan-500/10 to-blue-500/10 p-4">
          <div className="flex min-w-0 items-center gap-3">
            <button onClick={closeServiceDetail}
              className="shrink-0 rounded-lg border border-neutral-700 px-3 py-1.5 text-xs text-neutral-400 hover:border-teal-400/30 hover:text-teal-300">
              ← Back
            </button>
            <div className="min-w-0">
              <div className="text-[10px] uppercase tracking-wider text-teal-300/80">Service Detail</div>
              <div className="truncate text-lg font-semibold">{selectedService.name}</div>
            </div>
            <span className={["shrink-0 rounded-full border px-2.5 py-0.5 text-xs font-medium capitalize", STATUS_STYLES[selectedService.status] || STATUS_STYLES.unknown].join(" ")}>
              {selectedService.status}
            </span>
          </div>
          <div className="flex shrink-0 flex-wrap items-center gap-2">
            {selectedService.access_url && (
              <a href={selectedService.access_url} target="_blank" rel="noreferrer"
                className="rounded-lg border border-teal-400/30 bg-teal-500/10 px-3 py-1.5 text-xs text-teal-300 hover:bg-teal-500/20">
                Open ↗
              </a>
            )}
            {can("operator") && selectedService.health_endpoint && (
              <button
                onClick={() => setServiceActionConfirm({ action: "health-refresh", label: "Refresh Health Check", desc: `Run a live probe against the health endpoint and update the service status.` })}
                disabled={!!serviceActionPending}
                className="rounded-lg border border-emerald-400/30 bg-emerald-500/10 px-3 py-1.5 text-xs text-emerald-300 hover:bg-emerald-500/20 disabled:opacity-50">
                {serviceActionPending === "health-refresh" ? "Checking…" : "Refresh Health"}
              </button>
            )}
            {can("admin") && (
              <button onClick={() => openEditService(selectedService)}
                className="rounded-lg border border-neutral-700 px-3 py-1.5 text-xs text-neutral-400 hover:border-teal-400/30 hover:text-teal-300">
                Edit
              </button>
            )}
          </div>
        </div>

        {serviceActionError && (
          <div className="rounded-xl border border-rose-400/30 bg-rose-500/10 px-4 py-2 text-xs text-rose-300">
            {serviceActionError}
          </div>
        )}

        {/* Metadata grid */}
        <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
          {[
            { label: "Category",     value: CATEGORY_LABELS[selectedService.category] || selectedService.category },
            { label: "Runtime",      value: selectedService.runtime_type },
            { label: "Access",       value: selectedService.access_mode.replace(/_/g, " ") },
            { label: "Owner",        value: selectedService.owner || "—" },
            { label: "Backup",       value: selectedService.backup_policy === "none" ? "No backup" : selectedService.backup_policy },
            { label: "Workspace",    value: selectedService.workspace_name || "—" },
            { label: "Health check", value: selectedService.health_endpoint ? "Configured" : "Not set" },
            { label: "Last updated", value: new Date(selectedService.updated_at).toLocaleString() },
          ].map(({ label, value }) => (
            <div key={label} className="rounded-xl border border-neutral-800 bg-neutral-900/70 px-3 py-2.5">
              <div className="text-[10px] uppercase tracking-wider text-neutral-500">{label}</div>
              <div className="mt-0.5 text-sm font-medium capitalize text-neutral-200">{value}</div>
            </div>
          ))}
        </div>

        {/* Description */}
        {selectedService.description && (
          <div className="rounded-xl border border-neutral-800 bg-neutral-900/70 px-4 py-3 text-sm text-neutral-400">
            {selectedService.description}
          </div>
        )}

        {/* Health history */}
        <div className="rounded-2xl border border-neutral-800 bg-neutral-900/70 p-4">
          <div className="mb-3 flex items-center justify-between">
            <div className="text-sm font-semibold text-neutral-200">Health History</div>
            <span className="text-[10px] text-neutral-600">
              {serviceHealthHistory.length} events · scheduler runs every 2 min
            </span>
          </div>

          {!selectedService.health_endpoint ? (
            <div className="rounded-lg bg-neutral-800/60 px-3 py-2.5 text-xs text-neutral-500">
              No health endpoint configured. Edit this service to add one.
            </div>
          ) : (
            <>
              {/* Sparkline */}
              {serviceHealthHistory.length > 0 && (
                <div className="mb-4 flex items-end gap-[3px]">
                  {[...serviceHealthHistory].reverse().map((ev) => (
                    <div
                      key={ev.id}
                      title={`${new Date(ev.ts).toLocaleString()} — ${ev.status}${ev.latency_ms ? ` · ${ev.latency_ms}ms` : ""}${ev.error ? ` · ${ev.error}` : ""}`}
                      className={[
                        "w-2 rounded-sm transition-all",
                        ev.status === "healthy"  ? "h-6 bg-emerald-500/70"
                        : ev.status === "warning"  ? "h-5 bg-amber-500/70"
                        : ev.status === "degraded" ? "h-4 bg-orange-500/70"
                        : ev.status === "down"     ? "h-3 bg-rose-500/80"
                        : "h-2 bg-neutral-600",
                      ].join(" ")}
                    />
                  ))}
                </div>
              )}

              {serviceHistoryLoading && (
                <div className="py-4 text-center text-xs text-neutral-600">Loading history…</div>
              )}

              {!serviceHistoryLoading && serviceHealthHistory.length === 0 && (
                <div className="rounded-lg bg-neutral-800/60 px-3 py-2.5 text-xs text-neutral-500">
                  No events recorded yet — first probe fires 15 s after backend start, then every 2 min.
                </div>
              )}

              {!serviceHistoryLoading && serviceHealthHistory.length > 0 && (
                <div className="overflow-hidden rounded-xl border border-neutral-800">
                  <table className="w-full text-xs">
                    <thead>
                      <tr className="border-b border-neutral-800 bg-neutral-800/60">
                        <th className="px-3 py-2 text-left font-medium text-neutral-500">Time</th>
                        <th className="px-3 py-2 text-left font-medium text-neutral-500">Status</th>
                        <th className="px-3 py-2 text-left font-medium text-neutral-500">HTTP</th>
                        <th className="px-3 py-2 text-left font-medium text-neutral-500">Latency</th>
                        <th className="px-3 py-2 text-left font-medium text-neutral-500">Source</th>
                      </tr>
                    </thead>
                    <tbody>
                      {serviceHealthHistory.map((ev) => (
                        <tr key={ev.id} className="border-b border-neutral-800/50 last:border-0 hover:bg-neutral-800/30">
                          <td className="px-3 py-2 font-mono text-neutral-400">
                            {new Date(ev.ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })}
                            <span className="ml-1.5 text-[10px] text-neutral-600">
                              {new Date(ev.ts).toLocaleDateString([], { month: "short", day: "numeric" })}
                            </span>
                          </td>
                          <td className="px-3 py-2">
                            <span className={["rounded-full border px-2 py-0.5 text-[10px] font-medium capitalize", STATUS_STYLES[ev.status] || STATUS_STYLES.unknown].join(" ")}>
                              {ev.status}
                            </span>
                          </td>
                          <td className="px-3 py-2 font-mono text-neutral-400">{ev.status_code ?? "—"}</td>
                          <td className="px-3 py-2 text-neutral-400">
                            {ev.latency_ms != null ? `${ev.latency_ms}ms` : "—"}
                          </td>
                          <td className="px-3 py-2">
                            <span className={["rounded-full px-1.5 py-0.5 text-[10px]", ev.source === "scheduler" ? "text-cyan-500/60" : "text-teal-400/60"].join(" ")}>
                              {ev.source}
                            </span>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </>
          )}
        </div>

        {/* Recovery score */}
        <div className="rounded-2xl border border-neutral-800 bg-neutral-900/70 p-4">
          <div className="mb-2 flex items-center justify-between">
            <div className="text-sm font-semibold text-neutral-200">Recovery Score</div>
            <span className="rounded-full bg-neutral-800 px-2.5 py-0.5 text-[10px] text-neutral-500">Not calculated</span>
          </div>
          <div className="flex items-center gap-4 text-xs text-neutral-500">
            <div>Backup policy: <span className={["font-medium", selectedService.backup_policy === "none" ? "text-amber-400" : "text-emerald-400"].join(" ")}>{selectedService.backup_policy}</span></div>
            <div>Runtime: <span className="font-medium text-neutral-300">{selectedService.runtime_type}</span></div>
          </div>
          <div className="mt-2 rounded-lg bg-neutral-800/60 px-3 py-2 text-xs text-neutral-500">
            Recovery score requires backup records. Sandbox restore testing is planned for v2.0.
          </div>
        </div>
      </div>
    </>
  );

  const serviceGroups = (() => {
    const groups = {};
    for (const svc of servicesData) {
      const key = serviceGroupBy === "workspace" ? (svc.workspace_name || "Unassigned") : (CATEGORY_LABELS[svc.category] || svc.category);
      if (!groups[key]) groups[key] = [];
      groups[key].push(svc);
    }
    return Object.entries(groups).sort(([a], [b]) => a.localeCompare(b));
  })();

  const DNS_RECORD_TYPES = ["A","AAAA","CNAME","MX","TXT","NS","SRV","CAA","PTR","SOA","HTTPS","TLSA"];
  const LOCKED_TYPES = ["SOA","NS"];

  const dnsModal = showDnsModal && (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4">
      <div className="flex max-h-[90vh] w-full max-w-lg flex-col rounded-2xl border border-emerald-400/20 bg-neutral-950 shadow-2xl">
        <div className="flex shrink-0 items-center justify-between border-b border-neutral-800 px-6 py-4">
          <div className="text-base font-semibold">{dnsEditRrset ? "Edit Record" : "Add Record"}</div>
          <button onClick={() => setShowDnsModal(false)} className="text-neutral-500 hover:text-white text-lg">✕</button>
        </div>
        <div className="flex-1 overflow-y-auto px-6 py-4 space-y-3 text-sm">
          <div className="text-xs text-neutral-500">Zone: <span className="text-emerald-300 font-mono">{dnsSelectedZone?.replace(/\.$/, "")}</span></div>
          <div className="grid grid-cols-3 gap-3">
            <div className="col-span-2">
              <label className="mb-1 block text-xs text-neutral-400">Name <span className="text-neutral-600">(relative or FQDN)</span></label>
              <input value={dnsForm.name} onChange={(e) => setDnsForm((f) => ({ ...f, name: e.target.value }))}
                disabled={!!dnsEditRrset}
                placeholder={`www.${dnsSelectedZone?.replace(/\.$/, "") || "example.com"}.`}
                className="w-full rounded-lg border border-neutral-700 bg-neutral-900 px-3 py-1.5 text-sm font-mono text-neutral-200 focus:border-emerald-400/50 focus:outline-none disabled:opacity-50" />
            </div>
            <div>
              <label className="mb-1 block text-xs text-neutral-400">Type</label>
              <select value={dnsForm.type} onChange={(e) => setDnsForm((f) => ({ ...f, type: e.target.value }))}
                disabled={!!dnsEditRrset}
                className="w-full rounded-lg border border-neutral-700 bg-neutral-900 px-3 py-1.5 text-sm text-neutral-200 focus:border-emerald-400/50 focus:outline-none disabled:opacity-50">
                {DNS_RECORD_TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
              </select>
            </div>
          </div>
          <div>
            <label className="mb-1 block text-xs text-neutral-400">TTL <span className="text-neutral-600">(seconds)</span></label>
            <input type="number" value={dnsForm.ttl} onChange={(e) => setDnsForm((f) => ({ ...f, ttl: e.target.value }))}
              className="w-32 rounded-lg border border-neutral-700 bg-neutral-900 px-3 py-1.5 text-sm font-mono text-neutral-200 focus:border-emerald-400/50 focus:outline-none" />
          </div>
          <div>
            <label className="mb-1 block text-xs text-neutral-400">Content <span className="text-neutral-600">(one value per line)</span></label>
            {dnsForm.contents.map((c, i) => (
              <div key={i} className="mb-1.5 flex gap-2">
                <input value={c} onChange={(e) => setDnsForm((f) => { const cs=[...f.contents]; cs[i]=e.target.value; return {...f, contents:cs}; })}
                  placeholder={dnsForm.type === "A" ? "151.241.217.91" : dnsForm.type === "MX" ? "10 mail.example.com." : dnsForm.type === "TXT" ? `"v=spf1 include:..."` : ""}
                  className="flex-1 rounded-lg border border-neutral-700 bg-neutral-900 px-3 py-1.5 text-sm font-mono text-neutral-200 focus:border-emerald-400/50 focus:outline-none" />
                {dnsForm.contents.length > 1 && (
                  <button onClick={() => setDnsForm((f) => { const cs=f.contents.filter((_,j)=>j!==i); return {...f,contents:cs}; })} className="px-2 text-neutral-600 hover:text-rose-400">✕</button>
                )}
              </div>
            ))}
            <button onClick={() => setDnsForm((f) => ({ ...f, contents: [...f.contents, ""] }))}
              className="mt-1 text-xs text-emerald-400/60 hover:text-emerald-300">+ Add value</button>
          </div>
        </div>
        <div className="shrink-0 border-t border-neutral-800 px-6 py-4">
          {dnsFormError && <div className="mb-3 rounded-lg bg-rose-500/15 px-3 py-2 text-xs text-rose-300">{dnsFormError}</div>}
          <div className="flex justify-end gap-2">
            <button onClick={() => setShowDnsModal(false)} className="rounded-lg border border-neutral-700 px-4 py-2 text-xs text-neutral-400 hover:text-white">Cancel</button>
            <button onClick={saveDnsRecord} disabled={dnsFormSaving}
              className="rounded-lg border border-emerald-400/30 bg-emerald-500/10 px-4 py-2 text-xs text-emerald-300 hover:bg-emerald-500/20 disabled:opacity-50">
              {dnsFormSaving ? "Saving…" : dnsEditRrset ? "Update Record" : "Add Record"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );

  const workspacesPanel = (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <div className="text-xs uppercase tracking-wider text-cyan-300/80">Admin</div>
          <div className="text-lg font-semibold">Workspaces</div>
        </div>
        <div className="flex gap-2">
          <button onClick={openWorkspaceCreate}
            className="rounded-lg border border-cyan-400/30 bg-cyan-500/10 px-3 py-1 text-xs text-cyan-300 hover:bg-cyan-500/20">+ New Workspace</button>
          <button onClick={() => setAdminView(null)} className="text-xs text-neutral-400 hover:text-white">← Back</button>
        </div>
      </div>
      {workspacesMgmtLoading && <div className="text-xs text-neutral-600">Loading…</div>}
      <div className="space-y-2">
        {workspacesMgmt.map((ws) => (
          <div key={ws.id} className="flex items-center justify-between rounded-xl border border-neutral-800 bg-neutral-900/70 px-4 py-3">
            <div>
              <div className="font-semibold text-sm text-neutral-200">{ws.name}</div>
              <div className="font-mono text-[11px] text-neutral-500">{ws.slug}</div>
            </div>
            <div className="flex items-center gap-3">
              <span className="text-[10px] text-neutral-600">
                {servicesData.filter((s) => s.workspace_id === ws.id).length} services
              </span>
              <button onClick={() => openWorkspaceEdit(ws)} className="text-xs text-neutral-500 hover:text-cyan-300">Edit</button>
              <button onClick={() => deleteWorkspace(ws)} className="text-xs text-neutral-500 hover:text-rose-400">Delete</button>
            </div>
          </div>
        ))}
        {!workspacesMgmtLoading && workspacesMgmt.length === 0 && (
          <div className="rounded-xl border border-neutral-800 bg-neutral-900/60 p-6 text-center text-xs text-neutral-600">No workspaces yet</div>
        )}
      </div>
    </div>
  );

  const workspaceModal = showWorkspaceModal && (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4">
      <div className="w-full max-w-sm rounded-2xl border border-cyan-400/20 bg-neutral-950 shadow-2xl">
        <div className="flex items-center justify-between border-b border-neutral-800 px-6 py-4">
          <div className="text-base font-semibold">{editingWorkspace ? "Edit Workspace" : "New Workspace"}</div>
          <button onClick={() => setShowWorkspaceModal(false)} className="text-neutral-500 hover:text-white text-lg">✕</button>
        </div>
        <div className="px-6 py-4 space-y-3 text-sm">
          <div>
            <label className="mb-1 block text-xs text-neutral-400">Name *</label>
            <input value={workspaceForm.name}
              onChange={(e) => setWorkspaceForm((f) => ({ ...f, name: e.target.value, slug: f.slug || e.target.value.toLowerCase().replace(/[^a-z0-9]+/g, "-") }))}
              placeholder="Personal Services" autoFocus
              className="w-full rounded-lg border border-neutral-700 bg-neutral-900 px-3 py-1.5 text-sm text-neutral-200 focus:border-cyan-400/50 focus:outline-none" />
          </div>
          <div>
            <label className="mb-1 block text-xs text-neutral-400">Slug</label>
            <input value={workspaceForm.slug}
              onChange={(e) => setWorkspaceForm((f) => ({ ...f, slug: e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, "") }))}
              placeholder="personal-services"
              className="w-full rounded-lg border border-neutral-700 bg-neutral-900 px-3 py-1.5 text-sm font-mono text-neutral-200 focus:border-cyan-400/50 focus:outline-none" />
          </div>
        </div>
        <div className="border-t border-neutral-800 px-6 py-4">
          {workspaceFormError && <div className="mb-3 rounded-lg bg-rose-500/15 px-3 py-2 text-xs text-rose-300">{workspaceFormError}</div>}
          <div className="flex justify-end gap-2">
            <button onClick={() => setShowWorkspaceModal(false)} className="rounded-lg border border-neutral-700 px-4 py-2 text-xs text-neutral-400 hover:text-white">Cancel</button>
            <button onClick={saveWorkspace} disabled={workspaceFormSaving}
              className="rounded-lg border border-cyan-400/30 bg-cyan-500/10 px-4 py-2 text-xs text-cyan-300 hover:bg-cyan-500/20 disabled:opacity-50">
              {workspaceFormSaving ? "Saving…" : editingWorkspace ? "Update" : "Create"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );

  const registerFileModal = showRegisterFileModal && (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4">
      <div className="flex max-h-[90vh] w-full max-w-lg flex-col rounded-2xl border border-rose-400/20 bg-neutral-950 shadow-2xl">
        <div className="flex shrink-0 items-center justify-between border-b border-neutral-800 px-6 py-4">
          <div className="text-base font-semibold">Register File</div>
          <button onClick={() => setShowRegisterFileModal(false)} className="text-neutral-500 hover:text-white text-lg">✕</button>
        </div>
        <div className="flex-1 overflow-y-auto px-6 py-4 space-y-3 text-sm">
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="mb-1 block text-xs text-neutral-400">ID * <span className="text-neutral-600">(unique slug)</span></label>
              <input value={registerFileForm.id} onChange={(e) => setRegisterFileForm((f) => ({ ...f, id: e.target.value.toLowerCase().replace(/[^a-z0-9-]/g,"") }))}
                placeholder="my-compose" className="w-full rounded-lg border border-neutral-700 bg-neutral-900 px-3 py-1.5 text-sm font-mono text-neutral-200 focus:border-rose-400/50 focus:outline-none" />
            </div>
            <div>
              <label className="mb-1 block text-xs text-neutral-400">Label *</label>
              <input value={registerFileForm.label} onChange={(e) => setRegisterFileForm((f) => ({ ...f, label: e.target.value }))}
                placeholder="My Compose File" className="w-full rounded-lg border border-neutral-700 bg-neutral-900 px-3 py-1.5 text-sm text-neutral-200 focus:border-rose-400/50 focus:outline-none" />
            </div>
          </div>
          <div>
            <label className="mb-1 block text-xs text-neutral-400">File Path * <span className="text-neutral-600">(absolute path on this host)</span></label>
            <input value={registerFileForm.path} onChange={(e) => setRegisterFileForm((f) => ({ ...f, path: e.target.value }))}
              placeholder="/opt/stacks/myapp/docker-compose.yml"
              className="w-full rounded-lg border border-neutral-700 bg-neutral-900 px-3 py-1.5 text-sm font-mono text-neutral-200 focus:border-rose-400/50 focus:outline-none" />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="mb-1 block text-xs text-neutral-400">Stack * <span className="text-neutral-600">(group name)</span></label>
              <input value={registerFileForm.stack} onChange={(e) => setRegisterFileForm((f) => ({ ...f, stack: e.target.value }))}
                placeholder="myapp" className="w-full rounded-lg border border-neutral-700 bg-neutral-900 px-3 py-1.5 text-sm font-mono text-neutral-200 focus:border-rose-400/50 focus:outline-none" />
            </div>
            <div>
              <label className="mb-1 block text-xs text-neutral-400">Type</label>
              <select value={registerFileForm.type} onChange={(e) => setRegisterFileForm((f) => ({ ...f, type: e.target.value }))}
                className="w-full rounded-lg border border-neutral-700 bg-neutral-900 px-3 py-1.5 text-sm text-neutral-200 focus:border-rose-400/50 focus:outline-none">
                {["compose","env","caddy","nginx","json","yaml","javascript","text"].map((t) => (
                  <option key={t} value={t}>{t}</option>
                ))}
              </select>
            </div>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="mb-1 block text-xs text-neutral-400">Apply Strategy</label>
              <select value={registerFileForm.applyStrategy || ""} onChange={(e) => setRegisterFileForm((f) => ({ ...f, applyStrategy: e.target.value || null }))}
                className="w-full rounded-lg border border-neutral-700 bg-neutral-900 px-3 py-1.5 text-sm text-neutral-200 focus:border-rose-400/50 focus:outline-none">
                <option value="">None</option>
                <option value="compose-up">compose-up</option>
                <option value="caddy-reload">caddy-reload</option>
                <option value="nginx-reload">nginx-reload</option>
              </select>
            </div>
            <div className="flex items-end gap-4 pb-1">
              <label className="flex cursor-pointer items-center gap-2 text-xs text-neutral-400">
                <input type="checkbox" checked={registerFileForm.editable} onChange={(e) => setRegisterFileForm((f) => ({ ...f, editable: e.target.checked }))} className="rounded border-neutral-600 bg-neutral-800" />
                Editable
              </label>
              <label className="flex cursor-pointer items-center gap-2 text-xs text-neutral-400">
                <input type="checkbox" checked={registerFileForm.validatable} onChange={(e) => setRegisterFileForm((f) => ({ ...f, validatable: e.target.checked }))} className="rounded border-neutral-600 bg-neutral-800" />
                Validatable
              </label>
            </div>
          </div>
        </div>
        <div className="shrink-0 border-t border-neutral-800 px-6 py-4">
          {registerFileError && (
            <div className="mb-3 rounded-lg bg-rose-500/15 px-3 py-2 text-xs text-rose-300">{registerFileError}</div>
          )}
          <div className="flex justify-end gap-2">
            <button onClick={() => setShowRegisterFileModal(false)} className="rounded-lg border border-neutral-700 px-4 py-2 text-xs text-neutral-400 hover:text-white">Cancel</button>
            <button onClick={saveRegisterFile} disabled={registerFileSaving}
              className="rounded-lg border border-rose-400/30 bg-rose-500/10 px-4 py-2 text-xs text-rose-300 hover:bg-rose-500/20 disabled:opacity-50">
              {registerFileSaving ? "Registering…" : "Register File"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );

  const serviceModal = showServiceModal && (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4">
      <div className="flex max-h-[90vh] w-full max-w-lg flex-col rounded-2xl border border-teal-400/20 bg-neutral-950 shadow-2xl">
        {/* Modal header */}
        <div className="flex shrink-0 items-center justify-between border-b border-neutral-800 px-6 py-4">
          <div>
            <div className="text-base font-semibold">{editingService ? "Edit Service" : "Register Service"}</div>
            {editingService && <div className="mt-0.5 font-mono text-[10px] text-neutral-600">{editingService.slug}</div>}
          </div>
          <button onClick={() => setShowServiceModal(false)} className="text-neutral-500 hover:text-white text-lg leading-none">✕</button>
        </div>

        {/* Scrollable form body */}
        <div className="flex-1 overflow-y-auto px-6 py-4">
          <div className="space-y-3 text-sm">

            {/* Name + Slug */}
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="mb-1 block text-xs text-neutral-400">Name *</label>
                <input
                  value={serviceForm.name}
                  onChange={(e) => {
                    const name = e.target.value;
                    setServiceForm((f) => ({
                      ...f,
                      name,
                      slug: slugTouched ? f.slug : slugify(name),
                    }));
                  }}
                  placeholder="Nextcloud"
                  className="w-full rounded-lg border border-neutral-700 bg-neutral-900 px-3 py-1.5 text-sm text-neutral-200 focus:border-teal-400/50 focus:outline-none" />
              </div>
              <div>
                <label className="mb-1 block text-xs text-neutral-400">Slug *</label>
                <input
                  value={serviceForm.slug}
                  onChange={(e) => { setSlugTouched(true); setServiceForm((f) => ({ ...f, slug: e.target.value })); }}
                  placeholder="nextcloud"
                  className="w-full rounded-lg border border-neutral-700 bg-neutral-900 px-3 py-1.5 text-sm text-neutral-200 font-mono focus:border-teal-400/50 focus:outline-none" />
              </div>
            </div>

            {/* Description */}
            <div>
              <label className="mb-1 block text-xs text-neutral-400">Description</label>
              <textarea
                value={serviceForm.description}
                onChange={(e) => setServiceForm((f) => ({ ...f, description: e.target.value }))}
                rows={2}
                placeholder="What does this service do?"
                className="w-full resize-none rounded-lg border border-neutral-700 bg-neutral-900 px-3 py-1.5 text-sm text-neutral-200 focus:border-teal-400/50 focus:outline-none" />
            </div>

            {/* Category + Access Mode */}
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="mb-1 block text-xs text-neutral-400">Category *</label>
                <select value={serviceForm.category} onChange={(e) => setServiceForm((f) => ({ ...f, category: e.target.value }))}
                  className="w-full rounded-lg border border-neutral-700 bg-neutral-900 px-3 py-1.5 text-sm text-neutral-200 focus:border-teal-400/50 focus:outline-none">
                  <option value="infra">Infra</option>
                  <option value="ops">Ops</option>
                  <option value="admin">Admin</option>
                  <option value="business">Business</option>
                  <option value="personal">Personal</option>
                </select>
              </div>
              <div>
                <label className="mb-1 block text-xs text-neutral-400">Access Mode *</label>
                <select value={serviceForm.access_mode} onChange={(e) => setServiceForm((f) => ({ ...f, access_mode: e.target.value }))}
                  className="w-full rounded-lg border border-neutral-700 bg-neutral-900 px-3 py-1.5 text-sm text-neutral-200 focus:border-teal-400/50 focus:outline-none">
                  <option value="public">Public</option>
                  <option value="sso">SSO</option>
                  <option value="vpn_only">VPN Only</option>
                  <option value="internal">Internal</option>
                  <option value="mtls">mTLS</option>
                </select>
              </div>
            </div>

            {/* Runtime + Backup */}
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="mb-1 block text-xs text-neutral-400">Runtime *</label>
                <select value={serviceForm.runtime_type} onChange={(e) => setServiceForm((f) => ({ ...f, runtime_type: e.target.value }))}
                  className="w-full rounded-lg border border-neutral-700 bg-neutral-900 px-3 py-1.5 text-sm text-neutral-200 focus:border-teal-400/50 focus:outline-none">
                  <option value="docker">Docker</option>
                  <option value="podman">Podman</option>
                  <option value="vm">VM</option>
                  <option value="lxc">LXC</option>
                  <option value="external">External</option>
                  <option value="api">API</option>
                </select>
              </div>
              <div>
                <label className="mb-1 block text-xs text-neutral-400">Backup Policy *</label>
                <select value={serviceForm.backup_policy} onChange={(e) => setServiceForm((f) => ({ ...f, backup_policy: e.target.value }))}
                  className="w-full rounded-lg border border-neutral-700 bg-neutral-900 px-3 py-1.5 text-sm text-neutral-200 focus:border-teal-400/50 focus:outline-none">
                  <option value="none">None</option>
                  <option value="daily">Daily</option>
                  <option value="weekly">Weekly</option>
                  <option value="monthly">Monthly</option>
                  <option value="manual">Manual</option>
                </select>
              </div>
            </div>

            {/* Owner + Workspace */}
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="mb-1 block text-xs text-neutral-400">Owner *</label>
                <input value={serviceForm.owner} onChange={(e) => setServiceForm((f) => ({ ...f, owner: e.target.value }))}
                  placeholder="tristian"
                  className="w-full rounded-lg border border-neutral-700 bg-neutral-900 px-3 py-1.5 text-sm text-neutral-200 focus:border-teal-400/50 focus:outline-none" />
              </div>
              <div>
                <label className="mb-1 block text-xs text-neutral-400">Workspace</label>
                <select value={serviceForm.workspace_id} onChange={(e) => setServiceForm((f) => ({ ...f, workspace_id: e.target.value }))}
                  className="w-full rounded-lg border border-neutral-700 bg-neutral-900 px-3 py-1.5 text-sm text-neutral-200 focus:border-teal-400/50 focus:outline-none">
                  <option value="">— none —</option>
                  {workspacesData.map((w) => (
                    <option key={w.id} value={w.id}>{w.name}</option>
                  ))}
                </select>
              </div>
            </div>

            {/* Access URL */}
            <div>
              <label className="mb-1 block text-xs text-neutral-400">Access URL</label>
              <input value={serviceForm.access_url} onChange={(e) => setServiceForm((f) => ({ ...f, access_url: e.target.value }))}
                placeholder="https://nextcloud.tresemme.space"
                className="w-full rounded-lg border border-neutral-700 bg-neutral-900 px-3 py-1.5 text-sm text-neutral-200 font-mono focus:border-teal-400/50 focus:outline-none" />
            </div>

            {/* Health Endpoint */}
            <div>
              <label className="mb-1 block text-xs text-neutral-400">Health Endpoint</label>
              <input value={serviceForm.health_endpoint} onChange={(e) => setServiceForm((f) => ({ ...f, health_endpoint: e.target.value }))}
                placeholder="https://.../health or /api/health"
                className="w-full rounded-lg border border-neutral-700 bg-neutral-900 px-3 py-1.5 text-sm text-neutral-200 font-mono focus:border-teal-400/50 focus:outline-none" />
            </div>

          </div>
        </div>

        {/* Footer */}
        <div className="shrink-0 border-t border-neutral-800 px-6 py-4">
          {serviceFormError && (
            <div className="mb-3 rounded-lg bg-rose-500/15 px-3 py-2 text-xs text-rose-300">{serviceFormError}</div>
          )}
          <div className="flex justify-end gap-2">
            <button onClick={() => setShowServiceModal(false)} className="rounded-lg border border-neutral-700 px-4 py-2 text-xs text-neutral-400 hover:text-white">Cancel</button>
            <button onClick={saveService} disabled={serviceSaving}
              className="rounded-lg border border-teal-400/30 bg-teal-500/20 px-4 py-2 text-xs text-teal-300 hover:bg-teal-500/30 disabled:opacity-50">
              {serviceSaving ? "Saving…" : editingService ? "Save Changes" : "Register Service"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );

  const inventoryBoard = (
    <div className="space-y-4">
      {selectedService ? serviceDetailView : <>
      {/* Header */}
      <div className="rounded-2xl border border-teal-400/20 bg-gradient-to-r from-teal-500/10 via-cyan-500/10 to-blue-500/10 p-4">
        <div className="flex items-center justify-between">
          <div>
            <div className="text-xs uppercase tracking-wider text-teal-300/80">Service Registry</div>
            <div className="text-lg font-semibold">Inventory</div>
          </div>
          <div className="flex items-center gap-2">
            <span className="rounded-full bg-neutral-900/70 px-3 py-1 text-xs text-neutral-300">
              {servicesData.length} service{servicesData.length !== 1 ? "s" : ""}
            </span>
            <button
              onClick={runHealthCheck}
              disabled={healthChecking}
              className="rounded-full border border-emerald-400/30 bg-emerald-500/10 px-3 py-1 text-xs text-emerald-300 hover:bg-emerald-500/20 disabled:opacity-50">
              {healthChecking ? "Checking…" : "Check Health"}
            </button>
            {can("admin") && (
              <button onClick={openCreateService}
                className="rounded-full border border-teal-400/30 bg-teal-500/10 px-3 py-1 text-xs text-teal-300 hover:bg-teal-500/20">
                + Register
              </button>
            )}
          </div>
        </div>
      </div>

      {/* Toolbar */}
      <div className="flex flex-wrap items-center gap-3">
        <div className="flex rounded-lg border border-neutral-700 bg-neutral-900 p-0.5 text-xs">
          {["category", "workspace"].map((g) => (
            <button key={g} onClick={() => setServiceGroupBy(g)}
              className={["rounded px-3 py-1 transition", serviceGroupBy === g ? "bg-teal-500/20 text-teal-300" : "text-neutral-400 hover:text-white"].join(" ")}>
              By {g}
            </button>
          ))}
        </div>
        <select value={serviceCategoryFilter} onChange={(e) => setServiceCategoryFilter(e.target.value)}
          className="rounded-lg border border-neutral-700 bg-neutral-900 px-3 py-1.5 text-xs text-neutral-300 focus:border-teal-400/50 focus:outline-none">
          <option value="all">All categories</option>
          <option value="infra">Infra</option>
          <option value="ops">Ops</option>
          <option value="admin">Admin</option>
          <option value="business">Business</option>
          <option value="personal">Personal</option>
        </select>
        <label className="flex items-center gap-1.5 cursor-pointer text-xs text-neutral-400">
          <input type="checkbox" checked={showArchivedServices} onChange={(e) => setShowArchivedServices(e.target.checked)}
            className="rounded border-neutral-600 bg-neutral-800" />
          Show archived
        </label>
      </div>

      {servicesError && (
        <div className="rounded-2xl border border-rose-400/30 bg-rose-500/10 p-4 text-sm text-rose-200">{servicesError}</div>
      )}

      {servicesLoading && (
        <div className="text-center py-10 text-sm text-neutral-500">Loading service registry…</div>
      )}

      {!servicesLoading && servicesData.length === 0 && (
        <div className="rounded-2xl border border-neutral-800 bg-neutral-900/70 p-10 text-center">
          <div className="text-sm text-neutral-400">No services registered yet.</div>
          {can("admin") && (
            <button onClick={openCreateService} className="mt-3 rounded-lg border border-teal-400/30 bg-teal-500/10 px-4 py-2 text-xs text-teal-300 hover:bg-teal-500/20">
              Register first service
            </button>
          )}
        </div>
      )}

      {!servicesLoading && serviceGroups.map(([group, svcs]) => (
        <div key={group}>
          <div className="mb-2 text-xs font-semibold uppercase tracking-wider text-neutral-500">{group}</div>
          <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
            {svcs.map((svc) => {
              const missingFields = [
                !svc.owner && "owner",
                svc.backup_policy === "none" && "backup policy",
                !svc.health_endpoint && "health check",
              ].filter(Boolean);

              return (
                <div key={svc.id}
                  className={["rounded-2xl border bg-neutral-900/70 p-4 transition",
                    svc.archived ? "border-neutral-800/40 opacity-50" : "border-neutral-800 hover:border-teal-400/20"].join(" ")}>
                  {/* Title row */}
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <div className="flex items-center gap-2">
                        <span className="font-semibold truncate">{svc.name}</span>
                        {svc.archived && <span className="shrink-0 rounded-full bg-neutral-700/50 px-2 py-0.5 text-[10px] text-neutral-500">archived</span>}
                      </div>
                      {svc.description && <div className="mt-0.5 text-xs text-neutral-500 truncate">{svc.description}</div>}
                    </div>
                    {/* Status badge */}
                    <span className={["shrink-0 rounded-full border px-2 py-0.5 text-[10px] font-medium capitalize", STATUS_STYLES[svc.status] || STATUS_STYLES.unknown].join(" ")}>
                      {svc.status}
                    </span>
                  </div>

                  {/* Live health probe result */}
                  {(() => {
                    const h = healthResults[svc.id];
                    if (!h) return null;
                    return (
                      <div className="mt-2 flex items-center gap-2 text-[10px]">
                        <span className={[
                          "rounded-full px-2 py-0.5 font-medium",
                          h.status === "healthy"  ? "bg-emerald-500/15 text-emerald-300"
                          : h.status === "warning"  ? "bg-amber-500/15 text-amber-300"
                          : h.status === "degraded" ? "bg-orange-500/15 text-orange-300"
                          : "bg-rose-500/15 text-rose-300"
                        ].join(" ")}>
                          {h.status === "healthy" ? "✓" : "✕"} {h.status}
                        </span>
                        {h.latencyMs !== null && h.status !== "down" && (
                          <span className="text-neutral-500">{h.latencyMs}ms</span>
                        )}
                        {h.statusCode && (
                          <span className="text-neutral-600">HTTP {h.statusCode}</span>
                        )}
                        {h.error && (
                          <span className="text-rose-400/70 truncate">{h.error}</span>
                        )}
                        <span className="ml-auto text-neutral-700">{new Date(h.checkedAt).toLocaleTimeString()}</span>
                      </div>
                    );
                  })()}

                  {/* Meta row */}
                  <div className="mt-3 flex flex-wrap gap-1.5">
                    <span className={["rounded-full px-2 py-0.5 text-[10px] font-medium", ACCESS_MODE_STYLES[svc.access_mode] || "bg-neutral-700/40 text-neutral-400"].join(" ")}>
                      {svc.access_mode.replace("_", " ")}
                    </span>
                    <span className="rounded-full bg-neutral-800 px-2 py-0.5 text-[10px] text-neutral-400">
                      {svc.runtime_type}
                    </span>
                    <span className="rounded-full bg-neutral-800 px-2 py-0.5 text-[10px] text-neutral-400">
                      {svc.backup_policy === "none" ? "no backup" : `backup: ${svc.backup_policy}`}
                    </span>
                    {svc.workspace_name && (
                      <span className="rounded-full bg-teal-500/10 px-2 py-0.5 text-[10px] text-teal-400">{svc.workspace_name}</span>
                    )}
                  </div>

                  {/* Owner + URL */}
                  <div className="mt-2 grid grid-cols-2 gap-x-3 text-xs text-neutral-500">
                    <div>Owner: <span className="text-neutral-300">{svc.owner || "—"}</span></div>
                    <div className="truncate">
                      {svc.access_url
                        ? <a href={svc.access_url} target="_blank" rel="noreferrer" className="text-teal-400 hover:underline truncate">{svc.access_url.replace(/^https?:\/\//, "")}</a>
                        : <span className="text-neutral-600">no URL</span>}
                    </div>
                  </div>

                  {/* Missing fields warning */}
                  {missingFields.length > 0 && (
                    <div className="mt-2 flex items-center gap-1 rounded-lg bg-amber-500/10 px-2 py-1 text-[10px] text-amber-300">
                      <span>⚠</span>
                      <span>Missing: {missingFields.join(", ")}</span>
                    </div>
                  )}

                  {/* Card actions */}
                  <div className="mt-3 flex gap-2">
                    <button onClick={() => openServiceDetail(svc)}
                      className="rounded-lg border border-teal-400/30 bg-teal-500/10 px-3 py-1 text-[10px] text-teal-300 hover:bg-teal-500/20">
                      View
                    </button>
                    {can("admin") && (
                      <>
                        <button onClick={() => openEditService(svc)}
                          className="rounded-lg border border-neutral-700 px-3 py-1 text-[10px] text-neutral-400 hover:border-teal-400/30 hover:text-teal-300">
                          Edit
                        </button>
                        <button onClick={() => archiveService(svc)}
                          className="rounded-lg border border-neutral-700 px-3 py-1 text-[10px] text-neutral-400 hover:border-amber-400/30 hover:text-amber-300">
                          {svc.archived ? "Unarchive" : "Archive"}
                        </button>
                      </>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      ))}
      </>}
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
                  "relative rounded-lg px-4 py-2 text-sm text-center transition",
                  activeBoard === board
                    ? `bg-gradient-to-r text-black shadow ${boardThemes[board].active}`
                    : "bg-neutral-800 text-neutral-200 hover:bg-neutral-700",
                ].join(" ")}
              >
                {board}
                {board === "Alerts" && liveAlerts.length > 0 && (
                  <span className="absolute -right-1 -top-1 flex h-4 w-4 items-center justify-center rounded-full bg-rose-500 text-[9px] font-bold text-white">
                    {liveAlerts.length > 9 ? "9+" : liveAlerts.length}
                  </span>
                )}
              </button>
            ))}
          </div>
        </aside>

        <main className="space-y-6">
          {/* User + announcements header — tinted by active board */}
          <section className="grid gap-4 md:grid-cols-2">
            <div className={["rounded-2xl border border-neutral-800 bg-neutral-900/70 bg-gradient-to-br p-4", theme.shell, theme.hover].join(" ")}>
              <div className="flex items-start justify-between">
                <div>
                  <div className="text-sm text-neutral-400">User</div>
                  <div className="text-lg font-bold">{user.name}</div>
                  <div className="text-xs text-neutral-500">{user.role} · {user.realm}</div>
                </div>
                <a
                  href="/api/auth/logout"
                  className="rounded-lg border border-neutral-700 bg-neutral-800/80 px-2 py-1 text-[10px] text-neutral-400 hover:border-rose-400/40 hover:text-rose-300"
                >
                  Sign out
                </a>
              </div>
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

          {/* Ops — real system metrics */}
          {activeBoard === "Ops" && (
            <div className="space-y-6">

              {/* VM Fleet section */}
              <div>
                <div className="mb-3 flex items-center justify-between">
                  <div className="text-xs font-semibold uppercase tracking-wider text-neutral-400">VM Fleet</div>
                  <div className="flex items-center gap-2">
                    {opsVMsTs && (
                      <span className="text-[10px] text-neutral-600">
                        Updated {new Date(opsVMsTs).toLocaleTimeString()}
                      </span>
                    )}
                    <span className="text-[10px] text-neutral-700">Polling 30s</span>
                  </div>
                </div>

                {opsVMs.length === 0 ? (
                  <div className="rounded-2xl border border-neutral-800 bg-neutral-900/60 p-6 text-center text-xs text-neutral-600">
                    {opsVMsLoading ? "Querying Prometheus…" : "No node-exporter data from Prometheus"}
                  </div>
                ) : (
                  <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 xl:grid-cols-4">
                    {opsVMs.map((vm) => {
                      const bars = [["CPU", vm.cpu], ["RAM", vm.ram], ["Disk", vm.disk]];
                      const worst = [vm.cpu, vm.ram, vm.disk].filter(v => v !== null);
                      const maxPct = worst.length ? Math.max(...worst) : 0;
                      const borderCls = maxPct > 85 ? "border-rose-400/30" : maxPct > 70 ? "border-amber-400/30" : "border-neutral-800";
                      return (
                        <div key={vm.ip} className={`rounded-2xl border bg-neutral-900/60 p-4 ${borderCls}`}>
                          <div className="mb-3 flex items-start justify-between gap-2">
                            <div>
                              <div className="font-semibold text-sm leading-tight">{vm.name}</div>
                              <div className="mt-0.5 font-mono text-[10px] text-neutral-600">{vm.ip}</div>
                            </div>
                            <div className="shrink-0 text-[10px] text-neutral-600 text-right">
                              {vm.uptimeSeconds !== null ? formatUptime(vm.uptimeSeconds) : "—"}
                            </div>
                          </div>
                          {bars.map(([label, pct]) => (
                            <div key={label} className="mb-2">
                              <div className="mb-1 flex justify-between text-[10px]">
                                <span className="text-neutral-500">{label}</span>
                                <span className={pct === null ? "text-neutral-700" : pct > 85 ? "text-rose-300" : pct > 70 ? "text-amber-300" : "text-emerald-300"}>
                                  {pct !== null ? `${pct}%` : "—"}
                                </span>
                              </div>
                              <div className="h-1.5 rounded-full bg-neutral-800">
                                {pct !== null && (
                                  <div
                                    className={["h-1.5 rounded-full transition-all",
                                      pct > 85 ? "bg-rose-500" : pct > 70 ? "bg-amber-500" : "bg-emerald-500"
                                    ].join(" ")}
                                    style={{ width: `${Math.min(100, pct)}%` }}
                                  />
                                )}
                              </div>
                            </div>
                          ))}
                          {vm.load1 !== null && (
                            <div className="mt-2 text-[10px] text-neutral-500">
                              Load avg <span className="text-neutral-300">{vm.load1}</span>
                            </div>
                          )}
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>

              {/* Local telemetry divider */}
              <div>
                <div className="mb-3 flex items-center justify-between">
                  <div className="text-xs font-semibold uppercase tracking-wider text-neutral-400">This Node — pn-test</div>
                  {(() => {
                    const freshness = getMetricsFreshness();
                    return (
                      <span className={`text-[10px] ${freshness.cls}`}>
                        {metricsData.cpu?.length ?? 0} pt · {freshness.label}
                      </span>
                    );
                  })()}
                </div>
              <div className="space-y-4">
              {(() => {
                const freshness = getMetricsFreshness();
                return (
                  <div className="flex items-center justify-between text-[11px]">
                    <span className="text-neutral-600">
                      System metrics · {metricsData.cpu.length} point{metricsData.cpu.length !== 1 ? "s" : ""} collected
                    </span>
                    <span className={freshness.cls}>{freshness.label}</span>
                  </div>
                );
              })()}
              <div className="grid grid-cols-2 gap-4">
                {[
                  { key: "cpu",     title: "CPU Load",            unit: "%",    colorClass: "border-cyan-400/20 from-cyan-500/10 to-blue-500/5",       stroke: "#22d3ee", data: graphSeries.cpu,     maxValue: 100,  yMarks: ["100%","75%","50%","25%","0%"] },
                  { key: "memory",  title: "Memory Pressure",     unit: "%",    colorClass: "border-purple-400/20 from-purple-500/10 to-indigo-500/5",  stroke: "#a855f7", data: graphSeries.memory,  maxValue: 100,  yMarks: ["100%","75%","50%","25%","0%"] },
                  { key: "storage", title: "Storage Utilisation", unit: "%",    colorClass: "border-emerald-400/20 from-emerald-500/10 to-green-500/5", stroke: "#34d399", data: graphSeries.storage, maxValue: 100,  yMarks: ["100%","75%","50%","25%","0%"] },
                  { key: "network", title: "Network Throughput",  unit: " Mbps",colorClass: "border-amber-400/20 from-amber-500/10 to-orange-500/5",   stroke: "#f59e0b", data: graphSeries.network, maxValue: 1000, yMarks: ["1Gb","750M","500M","250M","0"] },
                ].map(({ key, title, unit, colorClass, stroke, data, maxValue, yMarks }) => {
                  const hasData   = data.length >= 2;
                  const currentVal = data.length ? data[data.length - 1] : null;
                  const bStats    = metricsStats?.[key];
                  const minValue  = bStats?.min  ?? (data.length ? Math.min(...data) : null);
                  const maxSeen   = bStats?.max  ?? (data.length ? Math.max(...data) : null);
                  const avgValue  = bStats?.avg  ?? (data.length ? Math.round(data.reduce((s, v) => s + v, 0) / data.length) : null);
                  const trend     = trendIndicator(key, bStats?.trend);
                  const progressPct = currentVal !== null
                    ? (key === "network" ? ((currentVal / maxValue) * 100).toFixed(1) : currentVal)
                    : 0;

                  const paddedMin = minValue !== null ? Math.max(0, minValue - (maxSeen - minValue || 5) * 0.25) : 0;
                  const paddedMax = maxSeen !== null  ? Math.min(maxValue, maxSeen + (maxSeen - minValue || 5) * 0.25) : maxValue;
                  const paddedRange = paddedMax - paddedMin || 1;

                  return (
                    <div key={title} className={`rounded-2xl border ${colorClass} bg-gradient-to-br p-4`}>
                      <div className="mb-2 flex items-center justify-between">
                        <div className="font-semibold">{title}</div>
                        <div className="flex items-center gap-1.5 text-xs text-neutral-300">
                          {currentVal !== null && <span className={trend.cls}>{trend.arrow}</span>}
                          <span>{currentVal !== null ? `${currentVal}${unit}` : "—"}</span>
                        </div>
                      </div>
                      <div className="mb-3 h-2 rounded-full bg-neutral-800">
                        <div className="h-2 rounded-full transition-all" style={{ width: `${progressPct}%`, backgroundColor: stroke }} />
                      </div>

                      {hasData ? (
                        <div className="rounded-xl border border-neutral-800/60 bg-neutral-950/40 p-3">
                          <div className="grid grid-cols-[44px_1fr] gap-3">
                            <div className="flex h-28 flex-col justify-between text-[10px] leading-none text-neutral-500">
                              {yMarks.map((mark) => <span key={mark}>{mark}</span>)}
                            </div>
                            <div>
                              <div className="relative h-28">
                                <div className="absolute inset-0 flex flex-col justify-between">
                                  {yMarks.map((mark) => <div key={mark} className="border-t border-dashed border-neutral-800/80" />)}
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
                                  <span key={label} className={idx === 0 ? "text-left" : idx === xLabels.length - 1 ? "text-right" : "text-center"}>
                                    {label}
                                  </span>
                                ))}
                              </div>
                            </div>
                          </div>
                        </div>
                      ) : (
                        <div className="flex h-28 items-center justify-center rounded-xl border border-neutral-800/60 bg-neutral-950/40 text-xs text-neutral-600">
                          {data.length === 0 ? "Collecting data…" : "Building history…"}
                        </div>
                      )}

                      <div className="mt-3 grid grid-cols-3 gap-2 text-[11px] text-neutral-400">
                        {[["Min", minValue], ["Avg", avgValue], ["Max", maxSeen]].map(([label, val]) => (
                          <div key={label} className="rounded-lg border border-neutral-800 bg-neutral-900/50 px-2 py-2">
                            <div className="text-[10px] uppercase tracking-wide text-neutral-500">{label}</div>
                            <div className="mt-1 font-medium text-neutral-200">{val !== null ? `${val}${unit}` : "—"}</div>
                          </div>
                        ))}
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
              </div>
            </div>
          )}

          {/* Admin */}
          {activeBoard === "Admin" && (
            adminView === "backup"  ? backupPanel  :
            adminView === "network" ? networkPanel :
            adminView === "audit"   ? auditPanel   :
            adminView === "certs"   ? certPanel    :
            adminView === "disk"    ? diskPanel    :
            adminView === "users"        ? usersPanel      :
            adminView === "users-manage" ? usersMgmtPanel  :
            adminView === "workspaces"    ? workspacesPanel :
            adminRootView
          )}

          {/* Stacks */}
          {activeBoard === "Stacks" && <StacksBoard />}

          {/* Files */}
          {activeBoard === "Files" && (
            <div className="space-y-4">
              <div className="rounded-2xl border border-rose-400/20 bg-gradient-to-r from-rose-500/10 via-pink-500/10 to-purple-500/10 p-4">
                <div className="flex items-center justify-between">
                  <div>
                    <div className="text-xs uppercase tracking-wider text-rose-300/80">
                      {filesStackFilter === "all" ? "Config Registry" : `Stack — ${filesStackFilter}`}
                    </div>
                    <div className="text-lg font-semibold">
                      {filesStackFilter === "all" ? "Files & Config Control" : `Files for ${filesStackFilter}`}
                    </div>
                  </div>
                  <div className="flex items-center gap-2">
                    {filesStackFilter !== "all" && (
                      <button
                        onClick={() => setFilesStackFilter("all")}
                        className="rounded-full border border-rose-400/20 bg-neutral-900/70 px-3 py-1 text-xs text-rose-300/70 hover:text-rose-300"
                      >
                        Show all files
                      </button>
                    )}
                    <span className="rounded-full bg-neutral-900/70 px-3 py-1 text-xs text-neutral-300">
                      {filesData.filter((f) => f.exists).length}/{filesData.length} on disk
                    </span>
                    {can("admin") && (
                      <button onClick={() => { setShowRegisterFileModal(true); setRegisterFileError(null); }}
                        className="rounded-full border border-rose-400/30 bg-rose-500/10 px-3 py-1 text-xs text-rose-300 hover:bg-rose-500/20">
                        + Register File
                      </button>
                    )}
                  </div>
                </div>
              </div>

              {filesError && (
                <div className="rounded-2xl border border-rose-400/30 bg-rose-500/10 p-4 text-sm text-rose-200">{filesError}</div>
              )}

              {filesStackFilter !== "all" && getFilesForStack(filesStackFilter).length === 0 && (
                <div className="rounded-2xl border border-neutral-800 bg-neutral-900/70 p-6 text-center">
                  <div className="text-sm text-neutral-400">No registered files found for stack <span className="text-neutral-200">{filesStackFilter}</span></div>
                  <div className="mt-1 text-xs text-neutral-600">Add entries to the file registry to enable config control for this stack.</div>
                </div>
              )}

              <div className="grid grid-cols-2 gap-4">
                {(filesStackFilter === "all" ? filesData : getFilesForStack(filesStackFilter)).map((file) => (
                  <div key={file.id} className={["rounded-2xl border bg-neutral-900/70 p-4 transition", file.exists ? "border-neutral-800 hover:border-rose-400/30" : "border-neutral-800/40 opacity-60"].join(" ")}>
                    <div className="flex items-start justify-between gap-3">
                      <div>
                        <div className="font-semibold">{file.label}</div>
                        <div className="mt-0.5 font-mono text-xs text-neutral-500">{file.fileName}</div>
                      </div>
                      <span className="shrink-0 rounded-full bg-neutral-800 px-2 py-1 text-[10px] text-neutral-400">{file.type}</span>
                    </div>

                    <div className="mt-3 grid grid-cols-2 gap-x-4 gap-y-1 text-xs text-neutral-400">
                      <div>Stack: <span className="text-neutral-300">{file.stack}</span></div>
                      <div>Exists: <span className={file.exists ? "text-emerald-400" : "text-rose-400"}>{file.exists ? "yes" : "no"}</span></div>
                      <div>Size: <span className="text-neutral-300">{file.size > 0 ? `${file.size} B` : "—"}</span></div>
                      <div className="truncate">Modified: <span className="text-neutral-300">{file.modifiedAt ? file.modifiedAt.slice(0, 10) : "—"}</span></div>
                    </div>

                    {file.hasDraft && (
                      <div className="mt-2 inline-flex items-center gap-1 rounded-full bg-amber-500/15 px-2 py-1 text-[10px] text-amber-300">
                        <span>Draft exists</span>
                        {file.draftModifiedAt && <span className="text-amber-400/60">· {file.draftModifiedAt.slice(0, 10)}</span>}
                      </div>
                    )}

                    {(() => {
                      const trust = knownGoodSummary[file.id];
                      if (!trust?.hasKnownGood) return null;
                      return (
                        <div className="mt-2 flex flex-wrap gap-1">
                          <span className="inline-flex items-center rounded-full bg-emerald-500/15 px-2 py-1 text-[10px] text-emerald-300">
                            LKG set
                          </span>
                          {trust.drifted && (
                            <span className="inline-flex items-center rounded-full bg-amber-500/15 px-2 py-1 text-[10px] text-amber-300">
                              Drift from LKG
                            </span>
                          )}
                        </div>
                      );
                    })()}

                    {(() => {
                      const latest = getLatestApply(file.id);
                      const needsApply = fileNeedsApply(file);
                      return (
                        <div className="mt-2 space-y-1 text-xs">
                          {!latest && (
                            <div className="text-neutral-400">Never applied</div>
                          )}
                          {latest && (
                            <div className="flex items-center gap-2">
                              <span className={latest.ok ? "text-emerald-300" : "text-rose-300"}>
                                {latest.ok ? "Applied" : "Failed"}
                              </span>
                              <span className="text-neutral-500">
                                {new Date(latest.timestamp).toLocaleString()}
                              </span>
                            </div>
                          )}
                          {latest && needsApply && (
                            <div className="text-amber-300">Needs apply</div>
                          )}
                        </div>
                      );
                    })()}

                    <div className="mt-3 flex flex-wrap gap-2">
                      <button
                        disabled={!file.exists}
                        onClick={() => openFileById(file.id)}
                        className="rounded-lg border border-rose-400/20 bg-rose-500/10 px-3 py-1 text-[11px] text-rose-300 hover:bg-rose-500/20 disabled:cursor-not-allowed disabled:opacity-40"
                      >
                        View
                      </button>
                      <span className="rounded-lg border border-neutral-800 bg-neutral-900/60 px-3 py-1 text-[11px] text-neutral-500">
                        {file.editable ? "Editable" : "Read-only"}
                      </span>
                      {can("admin") && !["caddyfile","privatenexus-compose","privatenexus-frontend-env","privatenexus-backend-server"].includes(file.id) && (
                        <button onClick={async () => {
                          if (!confirm(`Remove "${file.label}" from the file registry?`)) return;
                          const r = await fetch(`${API_BASE}/api/files/register/${encodeURIComponent(file.id)}`, { method: "DELETE" });
                          if (r.ok) {
                            const fl = await fetch(`${API_BASE}/api/files`);
                            const files = await fl.json();
                            if (Array.isArray(files)) setFilesData(files);
                          }
                        }} className="rounded-lg border border-rose-400/20 px-3 py-1 text-[11px] text-rose-400/60 hover:bg-rose-500/10 hover:text-rose-300">
                          Remove
                        </button>
                      )}
                      {file.validatable && (
                        <span className="rounded-lg border border-neutral-800 bg-neutral-900/60 px-3 py-1 text-[11px] text-neutral-500">
                          Validatable
                        </span>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* DNS */}
          {activeBoard === "DNS" && (
            <div className="space-y-4">
              {/* Header */}
              <div className="rounded-2xl border border-emerald-400/20 bg-gradient-to-r from-emerald-500/10 via-teal-500/5 to-cyan-500/10 p-4">
                <div className="flex items-center justify-between">
                  <div>
                    <div className="text-xs uppercase tracking-wider text-emerald-300/80">PowerDNS</div>
                    <div className="text-lg font-semibold">DNS Management</div>
                  </div>
                  <div className="flex items-center gap-2">
                    <span className="rounded-full bg-neutral-900/70 px-3 py-1 text-xs text-neutral-300">{dnsZones.length} zones</span>
                    {can("operator") && dnsSelectedZone && (
                      <button onClick={openDnsAdd}
                        className="rounded-full border border-emerald-400/30 bg-emerald-500/10 px-3 py-1 text-xs text-emerald-300 hover:bg-emerald-500/20">+ Add Record</button>
                    )}
                  </div>
                </div>
              </div>

              {dnsError && <div className="rounded-xl bg-rose-500/15 px-4 py-3 text-xs text-rose-300">{dnsError}</div>}

              <div className="grid grid-cols-1 gap-4 lg:grid-cols-[220px_1fr]">
                {/* Zone list */}
                <div className="space-y-1">
                  {dnsZonesLoading && <div className="text-xs text-neutral-600 px-2">Loading zones…</div>}
                  {dnsZones.map((z) => {
                    const display = z.name.replace(/\.$/, "");
                    return (
                      <button key={z.id} onClick={() => setDnsSelectedZone(z.id)}
                        className={["w-full text-left rounded-xl border px-3 py-2.5 text-xs transition",
                          dnsSelectedZone === z.id
                            ? "border-emerald-400/30 bg-emerald-500/10 text-emerald-200"
                            : "border-neutral-800 bg-neutral-900/50 text-neutral-400 hover:border-neutral-700 hover:text-neutral-200"
                        ].join(" ")}>
                        <div className="font-mono font-medium truncate">{display}</div>
                        <div className="mt-0.5 flex items-center gap-2 text-[10px] text-neutral-600">
                          <span>{z.kind}</span>
                          {z.dnssec && <span className="text-emerald-500/70">DNSSEC</span>}
                          <span>serial {z.serial}</span>
                        </div>
                      </button>
                    );
                  })}
                </div>

                {/* Records panel */}
                <div>
                  {dnsZoneLoading && <div className="text-xs text-neutral-600 py-4">Loading records…</div>}
                  {dnsZoneDetail && (() => {
                    const zoneName = dnsZoneDetail.name;
                    const ALL_TYPES = [...new Set((dnsZoneDetail.rrsets || []).map((r) => r.type))].sort();
                    const lq = dnsSearch.toLowerCase();
                    const rrsets = (dnsZoneDetail.rrsets || [])
                      .filter((r) => dnsTypeFilter === "all" || r.type === dnsTypeFilter)
                      .filter((r) => !lq || r.name.toLowerCase().includes(lq) || r.records.some((rc) => rc.content.toLowerCase().includes(lq)))
                      .sort((a, b) => {
                        const order = ["SOA","NS","MX","A","AAAA","CNAME","TXT","CAA","SRV","HTTPS","TLSA","PTR"];
                        const ai = order.indexOf(a.type), bi = order.indexOf(b.type);
                        if (ai !== bi) return (ai === -1 ? 99 : ai) - (bi === -1 ? 99 : bi);
                        return a.name.localeCompare(b.name);
                      });
                    return (
                      <div className="space-y-3">
                        {/* Filter bar */}
                        <div className="flex flex-wrap gap-2">
                          <input type="text" value={dnsSearch} onChange={(e) => setDnsSearch(e.target.value)}
                            placeholder="Filter records…"
                            className="flex-1 min-w-[140px] rounded-lg border border-neutral-700 bg-neutral-900 px-3 py-1.5 text-xs text-neutral-200 placeholder-neutral-600 focus:border-emerald-400/50 focus:outline-none" />
                          <div className="flex flex-wrap gap-1">
                            {["all", ...ALL_TYPES].map((t) => (
                              <button key={t} onClick={() => setDnsTypeFilter(t)}
                                className={["rounded-full px-2.5 py-0.5 text-[10px] font-mono transition",
                                  dnsTypeFilter === t ? "bg-emerald-500/20 text-emerald-300 border border-emerald-400/30" : "border border-neutral-700 text-neutral-500 hover:text-neutral-300"
                                ].join(" ")}>{t}</button>
                            ))}
                          </div>
                        </div>
                        {/* Records table */}
                        <div className="overflow-hidden rounded-xl border border-neutral-800">
                          <table className="w-full text-xs">
                            <thead>
                              <tr className="border-b border-neutral-800 bg-neutral-900/80">
                                <th className="px-3 py-2 text-left text-[10px] font-semibold uppercase tracking-wider text-neutral-500 w-16">Type</th>
                                <th className="px-3 py-2 text-left text-[10px] font-semibold uppercase tracking-wider text-neutral-500">Name</th>
                                <th className="px-3 py-2 text-left text-[10px] font-semibold uppercase tracking-wider text-neutral-500 w-16">TTL</th>
                                <th className="px-3 py-2 text-left text-[10px] font-semibold uppercase tracking-wider text-neutral-500">Content</th>
                                <th className="px-3 py-2 w-16"></th>
                              </tr>
                            </thead>
                            <tbody className="divide-y divide-neutral-800/60">
                              {rrsets.map((rrset) => {
                                const isLocked = LOCKED_TYPES.includes(rrset.type);
                                const relName = rrset.name === zoneName ? "@" : rrset.name.replace(new RegExp(`\\.?${zoneName.replace(".", "\\.")}$`), "");
                                return (
                                  <tr key={`${rrset.name}/${rrset.type}`} className={["transition", isLocked ? "opacity-50" : "hover:bg-neutral-800/30"].join(" ")}>
                                    <td className="px-3 py-2">
                                      <span className={["rounded px-1.5 py-0.5 text-[10px] font-mono font-semibold",
                                        rrset.type === "A" || rrset.type === "AAAA" ? "bg-blue-500/15 text-blue-300"
                                        : rrset.type === "CNAME" ? "bg-amber-500/15 text-amber-300"
                                        : rrset.type === "MX" ? "bg-purple-500/15 text-purple-300"
                                        : rrset.type === "TXT" ? "bg-emerald-500/15 text-emerald-300"
                                        : rrset.type === "NS" ? "bg-neutral-700 text-neutral-400"
                                        : rrset.type === "SOA" ? "bg-neutral-800 text-neutral-500"
                                        : "bg-neutral-700/50 text-neutral-400"
                                      ].join(" ")}>{rrset.type}</span>
                                    </td>
                                    <td className="px-3 py-2 font-mono text-neutral-200 max-w-[160px] truncate" title={rrset.name}>{relName}</td>
                                    <td className="px-3 py-2 font-mono text-neutral-500">{rrset.ttl}</td>
                                    <td className="px-3 py-2 text-neutral-400 max-w-[260px]">
                                      {rrset.records.map((r, i) => (
                                        <div key={i} className="font-mono truncate text-[11px]" title={r.content}>
                                          {r.disabled && <span className="mr-1 text-rose-400/60">[disabled]</span>}
                                          {r.content}
                                        </div>
                                      ))}
                                    </td>
                                    <td className="px-3 py-2">
                                      {!isLocked && can("operator") && (
                                        <div className="flex gap-1.5 justify-end">
                                          <button onClick={() => openDnsEdit(rrset)} className="text-neutral-600 hover:text-emerald-300 text-[11px]">edit</button>
                                          <button onClick={() => deleteDnsRecord(rrset)} className="text-neutral-600 hover:text-rose-400 text-[11px]">del</button>
                                        </div>
                                      )}
                                    </td>
                                  </tr>
                                );
                              })}
                            </tbody>
                          </table>
                          {!rrsets.length && (
                            <div className="py-6 text-center text-xs text-neutral-600">No records match your filter</div>
                          )}
                        </div>
                        <div className="text-right text-[10px] text-neutral-700">
                          {rrsets.length} rrset{rrsets.length !== 1 ? "s" : ""} · ns1.house-of-trae.com / ns2.house-of-trae.com
                        </div>
                      </div>
                    );
                  })()}
                </div>
              </div>
            </div>
          )}

          {/* Catalogue */}
          {activeBoard === "Catalogue" && (
            <div className="space-y-4">
              {/* Header */}
              <div className="rounded-2xl border border-violet-400/20 bg-gradient-to-r from-violet-500/10 via-purple-500/5 to-indigo-500/10 p-4">
                <div className="flex items-center justify-between">
                  <div>
                    <div className="text-xs uppercase tracking-wider text-violet-300/80">Self-Hosted</div>
                    <div className="text-lg font-semibold">App Catalogue</div>
                  </div>
                  <span className="rounded-full bg-neutral-900/70 px-3 py-1 text-xs text-neutral-300">
                    {catalogueApps.length} apps
                  </span>
                </div>
              </div>

              {/* Search + category filter */}
              <div className="flex flex-wrap gap-2">
                <input
                  type="text" value={catalogueSearch} onChange={(e) => setCatalogueSearch(e.target.value)}
                  placeholder="Search apps…"
                  className="flex-1 min-w-[180px] rounded-lg border border-neutral-700 bg-neutral-900 px-3 py-1.5 text-xs text-neutral-200 placeholder-neutral-600 focus:border-violet-400/50 focus:outline-none" />
                <div className="flex flex-wrap gap-1">
                  {["all","media","productivity","finance","devops","security","network","communication","business","home"].map((cat) => (
                    <button key={cat} onClick={() => setCatalogueCategory(cat)}
                      className={["rounded-full px-3 py-1 text-xs transition capitalize",
                        catalogueCategory === cat
                          ? "bg-violet-500/20 text-violet-300 border border-violet-400/30"
                          : "border border-neutral-700 text-neutral-400 hover:text-neutral-200"
                      ].join(" ")}>{cat}
                    </button>
                  ))}
                </div>
              </div>

              {catalogueLoading && <div className="text-center py-8 text-xs text-neutral-500">Loading catalogue…</div>}

              {/* App grid */}
              {!catalogueLoading && (() => {
                const lq = catalogueSearch.toLowerCase();
                const filtered = catalogueApps.filter((a) =>
                  (catalogueCategory === "all" || a.category === catalogueCategory) &&
                  (!lq || a.name.toLowerCase().includes(lq) || a.description.toLowerCase().includes(lq) || a.tags.some((t) => t.includes(lq)))
                );
                if (!filtered.length) return (
                  <div className="rounded-2xl border border-neutral-800 bg-neutral-900/60 p-8 text-center text-xs text-neutral-600">No apps match your filter</div>
                );
                // Group by category when showing all
                const groups = catalogueCategory === "all"
                  ? Object.entries(filtered.reduce((acc, a) => { (acc[a.category] = acc[a.category] || []).push(a); return acc; }, {}))
                  : [["", filtered]];
                return (
                  <div className="space-y-6">
                    {groups.map(([groupName, apps]) => (
                      <div key={groupName}>
                        {groupName && (
                          <div className="mb-3 text-xs font-semibold uppercase tracking-wider text-neutral-500 capitalize">{groupName}</div>
                        )}
                        <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3">
                          {apps.sort((a,b) => b.stars - a.stars).map((app) => {
                            const alreadyIn = servicesData.some((s) => s.slug === app.id);
                            return (
                              <div key={app.id} className="rounded-2xl border border-neutral-800 bg-neutral-900/70 p-4 transition hover:border-violet-400/20">
                                <div className="flex items-start justify-between gap-2">
                                  <div className="min-w-0">
                                    <div className="flex items-center gap-2">
                                      <span className="font-semibold text-neutral-100">{app.name}</span>
                                      {alreadyIn && (
                                        <span className="rounded-full bg-emerald-500/15 px-2 py-0.5 text-[10px] text-emerald-300">In Registry</span>
                                      )}
                                    </div>
                                    <div className="mt-0.5 text-xs text-neutral-500 leading-relaxed">{app.description}</div>
                                  </div>
                                  <div className="shrink-0 text-right">
                                    <div className="text-xs font-semibold text-amber-300">★ {app.stars}k</div>
                                    <div className="mt-0.5 text-[10px] capitalize text-neutral-600">{app.category}</div>
                                  </div>
                                </div>
                                <div className="mt-2 flex flex-wrap gap-1">
                                  {app.tags.slice(0,4).map((t) => (
                                    <span key={t} className="rounded-full bg-neutral-800 px-2 py-0.5 text-[10px] text-neutral-500">{t}</span>
                                  ))}
                                </div>
                                <div className="mt-3 flex items-center gap-2">
                                  <a href={app.site} target="_blank" rel="noreferrer"
                                    className="rounded-lg border border-neutral-700 px-3 py-1 text-[10px] text-neutral-400 hover:text-neutral-200">Site ↗</a>
                                  {can("admin") && !alreadyIn && (
                                    <button onClick={() => {
                                      setEditingService(null);
                                      setServiceForm({
                                        name: app.name, slug: app.id,
                                        description: app.description,
                                        category: ["media","productivity","finance","business","home"].includes(app.category) ? (app.category === "home" ? "personal" : app.category) : "infra",
                                        access_url: "", access_mode: app.access_mode,
                                        runtime_type: "docker", owner: "tristian",
                                        backup_policy: app.backup, health_endpoint: "",
                                        workspace_id: "",
                                      });
                                      setSlugTouched(true);
                                      setServiceFormError(null);
                                      setShowServiceModal(true);
                                    }} className="rounded-lg border border-violet-400/30 bg-violet-500/10 px-3 py-1 text-[10px] text-violet-300 hover:bg-violet-500/20">
                                      + Add to Registry
                                    </button>
                                  )}
                                  {alreadyIn && (
                                    <span className="text-[10px] text-emerald-400/60">✓ registered</span>
                                  )}
                                </div>
                                <div className="mt-2 font-mono text-[10px] text-neutral-700 truncate">{app.image}</div>
                              </div>
                            );
                          })}
                        </div>
                      </div>
                    ))}
                  </div>
                );
              })()}
            </div>
          )}

          {/* Inventory */}
          {activeBoard === "Inventory" && inventoryBoard}

          {/* Alerts */}
          {activeBoard === "Alerts" && (
            <div className="space-y-4">
              {/* Header */}
              <div className="rounded-2xl border border-red-400/20 bg-gradient-to-r from-red-500/10 via-rose-500/5 to-pink-500/10 p-4">
                <div className="flex items-center justify-between">
                  <div>
                    <div className="text-xs uppercase tracking-wider text-red-300/80">Live</div>
                    <div className="text-lg font-semibold">Alert Monitor</div>
                  </div>
                  <div className="flex items-center gap-2">
                    {liveAlerts.length === 0
                      ? <span className="rounded-full bg-emerald-500/20 px-3 py-1 text-xs text-emerald-300">All clear</span>
                      : <span className="rounded-full bg-rose-500/20 px-3 py-1 text-xs text-rose-300">{liveAlerts.length} firing</span>}
                    <span className="rounded-full bg-neutral-800 px-2 py-1 text-[10px] text-neutral-500">Polling 30s</span>
                  </div>
                </div>
              </div>

              {/* Filters + clear silenced */}
              <div className="flex items-center justify-between">
                <div className="flex rounded-lg border border-neutral-700 bg-neutral-900 p-0.5 text-xs">
                  {["all", "critical", "warning"].map((f) => (
                    <button key={f} onClick={() => setAlertFilter(f)}
                      className={["rounded px-3 py-1 capitalize transition",
                        alertFilter === f ? "bg-rose-500/20 text-rose-300" : "text-neutral-400 hover:text-white"
                      ].join(" ")}>{f}</button>
                  ))}
                </div>
                {alertSilenced.length > 0 && (
                  <button onClick={() => setAlertSilenced([])}
                    className="text-xs text-neutral-500 hover:text-neutral-300">
                    Clear {alertSilenced.length} silenced
                  </button>
                )}
              </div>

              {/* Summary counts */}
              {liveAlerts.length > 0 && (
                <div className="grid grid-cols-3 gap-3">
                  {[["Firing", liveAlerts.length, "text-rose-300", "border-rose-400/20 bg-rose-500/10"],
                    ["Critical", liveAlerts.filter(a=>a.level==="critical").length, "text-rose-300", "border-rose-400/20 bg-rose-500/5"],
                    ["Warning",  liveAlerts.filter(a=>a.level==="warning").length,  "text-amber-300", "border-amber-400/20 bg-amber-500/5"]
                  ].map(([label, count, textCls, borderCls]) => (
                    <div key={label} className={`rounded-xl border p-3 text-center ${borderCls}`}>
                      <div className={`text-xl font-bold ${textCls}`}>{count}</div>
                      <div className="text-[10px] uppercase tracking-wide text-neutral-500">{label}</div>
                    </div>
                  ))}
                </div>
              )}

              {/* All clear state */}
              {liveAlerts.filter(a => !alertSilenced.includes(a.id)).length === 0 && (
                <div className="rounded-2xl border border-emerald-400/20 bg-emerald-500/5 p-10 text-center">
                  <div className="text-3xl">✓</div>
                  <div className="mt-2 text-sm font-semibold text-emerald-300">All systems healthy</div>
                  <div className="mt-1 text-xs text-neutral-500">No active alerts — Prometheus + Blackbox polling every 30s</div>
                  {alertSilenced.length > 0 && (
                    <div className="mt-2 text-xs text-neutral-600">{alertSilenced.length} alert(s) silenced locally</div>
                  )}
                </div>
              )}

              {/* Alert cards */}
              <div className="space-y-2">
                {liveAlerts
                  .filter(a => !alertSilenced.includes(a.id))
                  .filter(a => alertFilter === "all" || a.level === alertFilter)
                  .map((a) => (
                    <div key={a.id} className={["rounded-2xl border p-4",
                      a.level === "critical" ? "border-rose-400/30 bg-rose-500/5" : "border-amber-400/30 bg-amber-500/5"
                    ].join(" ")}>
                      <div className="flex items-start justify-between gap-3">
                        <div className="flex min-w-0 items-start gap-3">
                          <span className="mt-0.5 shrink-0 text-base">{a.level === "critical" ? "🔴" : "🟡"}</span>
                          <div className="min-w-0">
                            <div className="font-semibold">{a.name}</div>
                            <div className="mt-0.5 text-xs text-neutral-400">{a.message}</div>
                            {a.instance && <div className="mt-1 font-mono text-xs text-neutral-500 truncate">{a.instance}</div>}
                          </div>
                        </div>
                        <div className="flex shrink-0 flex-col items-end gap-2">
                          <span className={["rounded-full border px-2 py-0.5 text-[10px] font-medium capitalize",
                            a.level === "critical" ? "border-rose-400/30 text-rose-300" : "border-amber-400/30 text-amber-300"
                          ].join(" ")}>{a.level}</span>
                          <button
                            onClick={() => setAlertSilenced(prev => prev.includes(a.id) ? prev : [...prev, a.id])}
                            className="text-[10px] text-neutral-600 hover:text-neutral-300"
                          >Silence</button>
                        </div>
                      </div>
                      <div className="mt-3 flex items-center gap-3 text-[10px] text-neutral-600">
                        <span className="rounded bg-neutral-800 px-1.5 py-0.5 text-neutral-400">{a.source}</span>
                        {alertFirstSeen[a.id] && (
                          <span>First seen {new Date(alertFirstSeen[a.id]).toLocaleTimeString()}</span>
                        )}
                      </div>
                    </div>
                  ))
                }
              </div>

              {/* TLS Cert Expiry */}
              <div className="rounded-2xl border border-neutral-800 bg-neutral-900/70 p-4">
                <div className="mb-3 flex items-center justify-between">
                  <div className="text-sm font-semibold text-neutral-200">TLS Certificates</div>
                  <div className="flex items-center gap-2">
                    {certData && <span className="text-[10px] text-neutral-600">updated {new Date(certData.ts).toLocaleTimeString()}</span>}
                    <button onClick={() => { setCertData(null); setCertError(false); fetch(`${API_BASE}/api/admin/certs`).then(r=>r.json()).then(d=>{if(d.ok)setCertData(d);else setCertError(true);}).catch(()=>setCertError(true)); }}
                      className="text-[10px] text-neutral-600 hover:text-neutral-300">&#8635;</button>
                  </div>
                </div>
                {certError && <div className="text-xs text-rose-400">Failed to load cert data from Prometheus</div>}
                {!certData && !certError && <div className="text-xs text-neutral-600">Loading...</div>}
                {certData && (
                  <div className="grid grid-cols-1 gap-1.5 sm:grid-cols-2 xl:grid-cols-3">
                    {[...certData.certs].sort((a,b)=>a.daysLeft-b.daysLeft).map((cert) => {
                      const domain = cert.instance.replace(/^https?:\/\//, "");
                      const rowCls = cert.daysLeft < 7
                        ? "border-rose-400/30 bg-rose-500/5"
                        : cert.daysLeft < 14
                        ? "border-rose-400/20 bg-rose-500/5"
                        : cert.daysLeft < 30
                        ? "border-amber-400/20 bg-amber-500/5"
                        : "border-neutral-800 bg-neutral-900/50";
                      const daysCls = cert.daysLeft < 14 ? "text-rose-300 font-bold"
                        : cert.daysLeft < 30 ? "text-amber-300 font-semibold"
                        : "text-emerald-300";
                      return (
                        <div key={cert.instance} className={["flex items-center justify-between rounded-lg border px-3 py-2 text-neutral-400", rowCls].join(" ")}>
                          <span className="font-mono text-[11px] truncate">{domain}</span>
                          <span className={["shrink-0 ml-2 text-[11px] tabular-nums", daysCls].join(" ")}>{cert.daysLeft}d</span>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>

              {/* Sources legend */}
              <div className="rounded-xl border border-neutral-800 bg-neutral-900/50 p-3">
                <div className="mb-2 text-[10px] uppercase tracking-wide text-neutral-500">Monitoring Sources</div>
                <div className="grid grid-cols-1 gap-1.5 text-xs text-neutral-500 sm:grid-cols-3">
                  <div><span className="text-neutral-300">prometheus-rule</span> — Grafana alert rules</div>
                  <div><span className="text-neutral-300">blackbox</span> — HTTPS endpoint probes</div>
                  <div><span className="text-neutral-300">node-exporter</span> — VM node exporters</div>
                </div>
              </div>
            </div>
          )}

          {/* Logs */}
          {activeBoard === "Logs" && (
            <div className="space-y-4">
              {/* Header */}
              <div className="rounded-2xl border border-cyan-400/20 bg-gradient-to-r from-cyan-500/10 via-blue-500/5 to-indigo-500/10 p-4">
                <div className="flex items-center justify-between">
                  <div>
                    <div className="text-xs uppercase tracking-wider text-cyan-300/80">Loki</div>
                    <div className="text-lg font-semibold">Log Explorer</div>
                  </div>
                  <div className="flex items-center gap-2">
                    {logsResults.length > 0 && (
                      <span className="rounded-full bg-cyan-500/20 px-3 py-1 text-xs text-cyan-300">
                        {logsResults.length} lines
                      </span>
                    )}
                    <span className="rounded-full bg-neutral-800 px-2 py-1 text-[10px] text-neutral-500">10.10.50.104:3100</span>
                  </div>
                </div>
              </div>

              {/* Controls */}
              <div className="rounded-2xl border border-neutral-800 bg-neutral-900/60 p-4 space-y-3">
                {/* Source type + source picker */}
                <div className="flex gap-2">
                  <div className="flex shrink-0 rounded-lg border border-neutral-700 bg-neutral-900 p-0.5 text-xs">
                    {[["syslog","System"],["container","Container"]].map(([t,l]) => (
                      <button key={t} onClick={() => { setLogsSourceType(t); setLogsSource(""); setLogsResults([]); }}
                        className={["rounded px-3 py-1 transition",
                          logsSourceType === t ? "bg-cyan-500/20 text-cyan-300" : "text-neutral-400 hover:text-white"
                        ].join(" ")}>{l}</button>
                    ))}
                  </div>
                  <select value={logsSource} onChange={(e) => setLogsSource(e.target.value)}
                    className="flex-1 rounded-lg border border-neutral-700 bg-neutral-900 px-3 py-1 text-xs text-neutral-200 focus:border-cyan-400/50 focus:outline-none">
                    <option value="">— select source —</option>
                    {(logsSourceType === "syslog" ? logsSources.hosts : logsSources.containers).map((s) => (
                      <option key={s} value={s}>{s}</option>
                    ))}
                  </select>
                </div>

                {/* Range + level */}
                <div className="flex flex-wrap gap-2">
                  <div className="flex rounded-lg border border-neutral-700 bg-neutral-900 p-0.5 text-xs">
                    {["15m","1h","6h","24h"].map((r) => (
                      <button key={r} onClick={() => setLogsRange(r)}
                        className={["rounded px-2.5 py-1 transition",
                          logsRange === r ? "bg-cyan-500/20 text-cyan-300" : "text-neutral-400 hover:text-white"
                        ].join(" ")}>{r}</button>
                    ))}
                  </div>
                  <div className="flex rounded-lg border border-neutral-700 bg-neutral-900 p-0.5 text-xs">
                    {[["all","All"],["error","Error"],["warn","Warn"],["info","Info"]].map(([v,l]) => (
                      <button key={v} onClick={() => setLogsLevel(v)}
                        className={["rounded px-2.5 py-1 transition",
                          logsLevel === v ? "bg-cyan-500/20 text-cyan-300" : "text-neutral-400 hover:text-white"
                        ].join(" ")}>{l}</button>
                    ))}
                  </div>
                </div>

                {/* Search + Query button + Auto toggle */}
                <div className="flex gap-2">
                  <input
                    type="text"
                    value={logsSearch}
                    onChange={(e) => setLogsSearch(e.target.value)}
                    onKeyDown={(e) => e.key === "Enter" && runLogsQuery()}
                    placeholder="Filter text (LogQL |= …)"
                    className="flex-1 rounded-lg border border-neutral-700 bg-neutral-900 px-3 py-1.5 text-xs text-neutral-200 placeholder-neutral-600 focus:border-cyan-400/50 focus:outline-none"
                  />
                  <button onClick={runLogsQuery} disabled={!logsSource || logsLoading}
                    className="rounded-lg border border-cyan-400/30 bg-cyan-500/10 px-4 py-1.5 text-xs text-cyan-300 hover:bg-cyan-500/20 disabled:opacity-40">
                    {logsLoading ? "Loading…" : "Query"}
                  </button>
                  <button
                    onClick={() => setLogsAutoRefresh((prev) => !prev)}
                    className={["rounded-lg border px-3 py-1.5 text-xs transition",
                      logsAutoRefresh
                        ? "border-emerald-400/30 bg-emerald-500/10 text-emerald-300"
                        : "border-neutral-700 text-neutral-500 hover:text-neutral-300"
                    ].join(" ")}>
                    {logsAutoRefresh ? "Auto ✓" : "Auto"}
                  </button>
                </div>
              </div>

              {/* Error */}
              {logsError && (
                <div className="rounded-xl border border-rose-400/30 bg-rose-500/10 p-3 text-xs text-rose-300">{logsError}</div>
              )}

              {/* Empty state */}
              {logsResults.length === 0 && !logsLoading && !logsError && logsSource && (
                <div className="rounded-2xl border border-neutral-800 bg-neutral-900/60 p-8 text-center text-xs text-neutral-600">
                  No logs found for the selected filters
                </div>
              )}

              {/* No source selected */}
              {!logsSource && (
                <div className="rounded-2xl border border-neutral-800 bg-neutral-900/60 p-8 text-center">
                  <div className="text-sm text-neutral-500">Select a source above and click Query</div>
                  <div className="mt-1 text-xs text-neutral-700">
                    {logsSources.hosts.length} hosts · {logsSources.containers.length} containers available
                  </div>
                </div>
              )}

              {/* Log lines */}
              {logsResults.length > 0 && (
                <div className="rounded-2xl border border-neutral-800 bg-neutral-950/80 font-mono">
                  <div className="flex items-center justify-between border-b border-neutral-800 px-4 py-2">
                    <span className="text-[10px] text-neutral-600">
                      {logsResults.length} lines · {logsSource} · last {logsRange}
                      {logsSearch && <span> · filter: {logsSearch}</span>}
                    </span>
                    <button onClick={runLogsQuery} disabled={logsLoading}
                      className="text-[10px] text-neutral-600 hover:text-neutral-300 disabled:opacity-40">↻ Refresh</button>
                  </div>
                  <div className="max-h-[36rem] overflow-y-auto p-2 space-y-px">
                    {logsResults.map((entry, idx) => {
                      const line    = entry.line || "";
                      const isError = /\b(error|err|fatal|panic|crit|emerg)\b/i.test(line);
                      const isWarn  = !isError && /\b(warn|warning)\b/i.test(line);
                      const tsMs    = entry.ts ? Number(BigInt(entry.ts) / 1_000_000n) : null;
                      const tsStr   = tsMs ? new Date(tsMs).toLocaleTimeString() : "";
                      return (
                        <div key={idx} className={["rounded px-2 py-0.5 text-[11px] leading-relaxed break-all",
                          isError ? "bg-rose-500/10 text-rose-200"
                          : isWarn  ? "bg-amber-500/10 text-amber-200"
                          : "text-neutral-400 hover:bg-neutral-800/50"
                        ].join(" ")}>
                          <span className="mr-2 shrink-0 select-none text-neutral-600 text-[10px]">{tsStr}</span>
                          {line}
                        </div>
                      );
                    })}
                  </div>
                </div>
              )}
            </div>
          )}

          {/* Emergency */}
          {activeBoard === "Emergency" && (
            <div className="space-y-4">
              {/* Header */}
              <div className="rounded-2xl border border-rose-400/30 bg-gradient-to-r from-rose-500/15 via-red-500/10 to-pink-500/10 p-4">
                <div className="flex items-center justify-between">
                  <div>
                    <div className="text-xs uppercase tracking-wider text-rose-300/80">High Impact Operations</div>
                    <div className="text-lg font-semibold">Emergency Control</div>
                  </div>
                  <button
                    onClick={fetchEmergencyStatus}
                    className="rounded-lg border border-rose-400/20 bg-rose-500/10 px-3 py-1 text-xs text-rose-300 hover:bg-rose-500/20"
                  >
                    Refresh
                  </button>
                </div>
                {emergencyStatusError && (
                  <div className="mt-2 text-xs text-amber-400">Status endpoint unavailable — backend may not have admin access.</div>
                )}
              </div>

              {/* Severity guide */}
              <div className="grid grid-cols-3 gap-3">
                {[
                  { label:"P1 Critical", resp:"15 min", color:"rose", examples:"Keycloak down, DNS outage, Reverse proxy failure, Storage failure" },
                  { label:"P2 Major",    resp:"1 hour",  color:"amber", examples:"Application outage, Monitoring failure, Backup failure" },
                  { label:"P3 Minor",    resp:"Maint window", color:"neutral", examples:"Dashboard issue, Reporting issue, Cosmetic issue" },
                ].map(({ label, resp, color, examples }) => (
                  <div key={label} className={[
                    "rounded-xl border p-3",
                    color === "rose" ? "border-rose-400/30 bg-rose-500/5"
                    : color === "amber" ? "border-amber-400/20 bg-amber-500/5"
                    : "border-neutral-800 bg-neutral-900/50"
                  ].join(" ")}>
                    <div className={["text-xs font-bold", color === "rose" ? "text-rose-300" : color === "amber" ? "text-amber-300" : "text-neutral-400"].join(" ")}>{label}</div>
                    <div className="mt-0.5 text-[10px] text-neutral-500">Response: <span className="text-neutral-300">{resp}</span></div>
                    <div className="mt-1.5 text-[10px] text-neutral-600 leading-relaxed">{examples}</div>
                  </div>
                ))}
              </div>

              {/* Recovery order + DR checklist */}
              <div className="grid grid-cols-2 gap-3">
                <div className="rounded-2xl border border-neutral-800 bg-neutral-900/70 p-4">
                  <div className="mb-3 text-xs font-semibold uppercase tracking-wider text-neutral-500">Recovery Order</div>
                  <ol className="space-y-1.5">
                    {["Network","DNS","Identity","Storage","Databases","Applications","Monitoring"].map((step, i) => (
                      <li key={step} className="flex items-center gap-2.5 text-xs text-neutral-300">
                        <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full border border-neutral-700 bg-neutral-800 text-[10px] font-semibold text-neutral-500">{i+1}</span>
                        {step}
                      </li>
                    ))}
                  </ol>
                </div>
                <div className="rounded-2xl border border-neutral-800 bg-neutral-900/70 p-4">
                  <div className="mb-3 text-xs font-semibold uppercase tracking-wider text-neutral-500">DR Checklist</div>
                  <div className="space-y-3 text-[11px]">
                    <div>
                      <div className="mb-1 font-medium text-neutral-400">Infrastructure</div>
                      {["Verify Proxmox health","Verify ZFS pools","Verify VLAN connectivity","Verify WireGuard/Tailscale"].map(s=>(
                        <div key={s} className="flex items-start gap-1.5 text-neutral-500 leading-relaxed"><span className="mt-0.5 shrink-0 text-neutral-700">○</span>{s}</div>
                      ))}
                    </div>
                    <div>
                      <div className="mb-1 font-medium text-neutral-400">Identity</div>
                      {["Restore Keycloak database","Validate realm configuration","Validate MFA policies"].map(s=>(
                        <div key={s} className="flex items-start gap-1.5 text-neutral-500 leading-relaxed"><span className="mt-0.5 shrink-0 text-neutral-700">○</span>{s}</div>
                      ))}
                    </div>
                    <div>
                      <div className="mb-1 font-medium text-neutral-400">Service</div>
                      {["Restore latest known-good backup","Validate dependencies","Re-enable routing"].map(s=>(
                        <div key={s} className="flex items-start gap-1.5 text-neutral-500 leading-relaxed"><span className="mt-0.5 shrink-0 text-neutral-700">○</span>{s}</div>
                      ))}
                    </div>
                  </div>
                </div>
              </div>

              {/* Quick links */}
              <div className="rounded-2xl border border-neutral-800 bg-neutral-900/70 p-4">
                <div className="mb-3 text-xs font-semibold uppercase tracking-wider text-neutral-500">Emergency Links</div>
                <div className="flex flex-wrap gap-2">
                  {[
                    { label:"Grafana",          url:"https://grafana.house-of-trae.com",          color:"text-orange-300" },
                    { label:"Uptime Kuma",       url:"https://status.house-of-trae.com",           color:"text-emerald-300" },
                    { label:"Keycloak Admin",    url:"https://auth.house-of-trae.com/admin",       color:"text-blue-300" },
                    { label:"Proxmox",           url:"https://proxmox.house-of-trae.com:8006",     color:"text-neutral-300" },
                    { label:"DNS Admin",         url:"https://dns-admin.house-of-trae.com",        color:"text-purple-300" },
                    { label:"Forgejo",           url:"https://git.securenexus.net",                color:"text-cyan-300" },
                  ].map(({ label, url, color }) => (
                    <a key={label} href={url} target="_blank" rel="noreferrer"
                      className={["rounded-lg border border-neutral-700 px-3 py-1.5 text-xs hover:border-neutral-500 hover:bg-neutral-800/60", color].join(" ")}>
                      {label} ↗
                    </a>
                  ))}
                </div>
              </div>

              {/* System Status + Maintenance Mode */}
              <div className="grid grid-cols-2 gap-4">
                {/* System Status */}
                <div className="rounded-2xl border border-neutral-800 bg-neutral-900/70 p-4">
                  <div className="mb-3 text-xs font-semibold uppercase tracking-wider text-neutral-500">System Snapshot</div>
                  {emergencyStatus ? (
                    <div className="space-y-3">
                      <div className="grid grid-cols-2 gap-2">
                        <div className="rounded-xl border border-emerald-500/20 bg-emerald-500/10 px-3 py-2">
                          <div className="text-[10px] uppercase text-neutral-500">Running</div>
                          <div className="mt-0.5 text-xl font-semibold text-emerald-300">{emergencyStatus.containers.running}</div>
                        </div>
                        <div className={["rounded-xl border px-3 py-2", emergencyStatus.containers.stopped > 0 ? "border-amber-500/20 bg-amber-500/10" : "border-neutral-800 bg-neutral-800/60"].join(" ")}>
                          <div className="text-[10px] uppercase text-neutral-500">Stopped</div>
                          <div className={["mt-0.5 text-xl font-semibold", emergencyStatus.containers.stopped > 0 ? "text-amber-300" : "text-neutral-400"].join(" ")}>{emergencyStatus.containers.stopped}</div>
                        </div>
                      </div>
                      <div className="grid grid-cols-2 gap-2 text-xs">
                        <div className="flex items-center justify-between rounded-lg border border-neutral-800 bg-neutral-800/50 px-3 py-1.5">
                          <span className="text-neutral-500">Memory</span>
                          <span className={emergencyStatus.memory.usedPct > 85 ? "text-rose-300" : emergencyStatus.memory.usedPct > 70 ? "text-amber-300" : "text-neutral-200"}>{emergencyStatus.memory.usedPct}%</span>
                        </div>
                        <div className="flex items-center justify-between rounded-lg border border-neutral-800 bg-neutral-800/50 px-3 py-1.5">
                          <span className="text-neutral-500">Disk</span>
                          <span className={emergencyStatus.disk.usedPct > 90 ? "text-rose-300" : emergencyStatus.disk.usedPct > 80 ? "text-amber-300" : "text-neutral-200"}>{emergencyStatus.disk.usedPct}%</span>
                        </div>
                      </div>
                    </div>
                  ) : (
                    <div className="text-sm text-neutral-500">{emergencyStatusError ? "Unavailable" : "Loading…"}</div>
                  )}
                </div>

                {/* Maintenance Mode */}
                <div className="rounded-2xl border border-neutral-800 bg-neutral-900/70 p-4">
                  <div className="mb-3 text-xs font-semibold uppercase tracking-wider text-neutral-500">Maintenance Mode</div>
                  {emergencyStatus?.maintenanceMode?.enabled ? (
                    <div className="space-y-3">
                      <div className="rounded-lg border border-amber-400/30 bg-amber-500/10 px-3 py-2">
                        <div className="text-xs font-semibold text-amber-300">Active</div>
                        <div className="mt-0.5 text-[11px] text-amber-300/60">
                          Since {emergencyStatus.maintenanceMode.since.slice(0, 19).replace("T", " ")} UTC
                        </div>
                        {emergencyStatus.maintenanceMode.reason && (
                          <div className="mt-0.5 text-[11px] text-amber-300/60">{emergencyStatus.maintenanceMode.reason}</div>
                        )}
                      </div>
                      <button
                        onClick={() => runEmergencyAction("maintenance.disable")}
                        disabled={!!emergencyPending || !can("admin")}
                        title={!can("admin") ? "Requires admin role" : undefined}
                        className="w-full rounded-lg border border-emerald-400/20 bg-emerald-500/10 px-3 py-2 text-xs text-emerald-300 hover:bg-emerald-500/20 disabled:opacity-40 disabled:cursor-not-allowed"
                      >
                        {emergencyPending === "maintenance.disable" ? "Disabling…" : "Disable Maintenance Mode"}
                      </button>
                    </div>
                  ) : (
                    <div className="space-y-3">
                      <div className="rounded-lg border border-neutral-800 bg-neutral-800/50 px-3 py-2 text-xs text-neutral-500">
                        Inactive
                      </div>
                      <input
                        value={maintenanceReason}
                        onChange={(e) => setMaintenanceReason(e.target.value)}
                        placeholder="Reason (optional)"
                        className="w-full rounded-lg border border-neutral-700 bg-neutral-800/60 px-3 py-1.5 text-xs text-neutral-200 placeholder:text-neutral-600 outline-none focus:border-amber-400/30"
                      />
                      <button
                        onClick={() => runEmergencyAction("maintenance.enable", { reason: maintenanceReason || undefined })}
                        disabled={!!emergencyPending || !can("admin")}
                        title={!can("admin") ? "Requires admin role" : undefined}
                        className="w-full rounded-lg border border-amber-400/20 bg-amber-500/10 px-3 py-2 text-xs text-amber-300 hover:bg-amber-500/20 disabled:opacity-40 disabled:cursor-not-allowed"
                      >
                        {emergencyPending === "maintenance.enable" ? "Enabling…" : "Enable Maintenance Mode"}
                      </button>
                    </div>
                  )}
                </div>
              </div>

              {/* Diagnostics */}
              <div className="rounded-2xl border border-neutral-800 bg-neutral-900/70 p-4">
                <div className="flex items-center justify-between">
                  <div className="text-xs font-semibold uppercase tracking-wider text-neutral-500">Diagnostics</div>
                  <button
                    onClick={() => runEmergencyAction("diagnostics.run")}
                    disabled={!!emergencyPending}
                    className="rounded-lg border border-cyan-400/20 bg-cyan-500/10 px-3 py-1 text-xs text-cyan-300 hover:bg-cyan-500/20 disabled:opacity-40"
                  >
                    {emergencyPending === "diagnostics.run" ? "Running…" : "Run Diagnostics"}
                  </button>
                </div>

                {emergencyResult?.action === "diagnostics.run" && emergencyResult.diagnostics && (
                  <div className="mt-4 space-y-3">
                    <div className="rounded-xl border border-neutral-800 bg-neutral-800/50 px-3 py-2">
                      <div className="mb-1.5 text-[10px] uppercase tracking-wide text-neutral-500">Containers</div>
                      <div className="grid grid-cols-3 gap-3 text-xs">
                        <div><span className="text-neutral-500">Total </span><span className="text-neutral-200">{emergencyResult.diagnostics.containers.total}</span></div>
                        <div><span className="text-neutral-500">Running </span><span className="text-emerald-300">{emergencyResult.diagnostics.containers.running}</span></div>
                        <div><span className="text-neutral-500">Stopped </span><span className={emergencyResult.diagnostics.containers.stopped > 0 ? "text-amber-300" : "text-neutral-400"}>{emergencyResult.diagnostics.containers.stopped}</span></div>
                      </div>
                      {emergencyResult.diagnostics.containers.stoppedNames.length > 0 && (
                        <div className="mt-1.5 text-[11px] text-amber-300/70">
                          Stopped: {emergencyResult.diagnostics.containers.stoppedNames.join(", ")}
                        </div>
                      )}
                    </div>

                    <div className="grid grid-cols-3 gap-3">
                      <div className="rounded-xl border border-neutral-800 bg-neutral-800/50 px-3 py-2">
                        <div className="text-[10px] uppercase text-neutral-500">Memory</div>
                        <div className={["mt-1 text-sm font-semibold", emergencyResult.diagnostics.memory.usedPct > 85 ? "text-rose-300" : "text-neutral-200"].join(" ")}>
                          {emergencyResult.diagnostics.memory.usedPct}%
                        </div>
                        <div className="text-[10px] text-neutral-500">{emergencyResult.diagnostics.memory.freeMB} MB free of {emergencyResult.diagnostics.memory.totalMB} MB</div>
                      </div>
                      <div className="rounded-xl border border-neutral-800 bg-neutral-800/50 px-3 py-2">
                        <div className="text-[10px] uppercase text-neutral-500">Disk /</div>
                        <div className={["mt-1 text-sm font-semibold", (emergencyResult.diagnostics.disk?.pct ?? 0) > 90 ? "text-rose-300" : "text-neutral-200"].join(" ")}>
                          {emergencyResult.diagnostics.disk?.pct ?? "—"}%
                        </div>
                        <div className="text-[10px] text-neutral-500">{emergencyResult.diagnostics.disk?.free ?? "—"} free of {emergencyResult.diagnostics.disk?.total ?? "—"}</div>
                      </div>
                      <div className="rounded-xl border border-neutral-800 bg-neutral-800/50 px-3 py-2">
                        <div className="text-[10px] uppercase text-neutral-500">Load Avg</div>
                        <div className="mt-1 text-sm font-semibold text-neutral-200">{emergencyResult.diagnostics.system.loadAvg1}</div>
                        <div className="text-[10px] text-neutral-500">5m: {emergencyResult.diagnostics.system.loadAvg5} · up {emergencyResult.diagnostics.system.uptimeHours}h</div>
                      </div>
                    </div>

                    <div className="text-[10px] text-neutral-600">Ran at {emergencyResult.diagnostics.ts.slice(0, 19).replace("T", " ")} UTC</div>
                  </div>
                )}
              </div>

              {/* Danger zone */}
              <div className="rounded-2xl border border-rose-400/20 bg-rose-500/5 p-4">
                <div className="mb-3 text-xs font-semibold uppercase tracking-wider text-rose-400/60">Danger Zone</div>
                <div className="grid grid-cols-2 gap-3">
                  <div className="rounded-xl border border-amber-400/20 bg-amber-500/10 p-4">
                    <div className="mb-1 text-sm font-semibold">Restart All Services</div>
                    <div className="mb-4 text-xs text-neutral-500">Restarts every running container. Brief downtime expected.</div>
                    <button
                      onClick={() => setConfirmAction({ name: "Restart All Services", variant: "danger", _action: "stacks.restart-all" })}
                      disabled={!!emergencyPending || !can("admin")}
                      title={!can("admin") ? "Requires admin role" : undefined}
                      className="w-full rounded-lg border border-amber-400/30 bg-amber-500/15 px-3 py-2 text-xs font-medium text-amber-300 hover:bg-amber-500/25 disabled:cursor-not-allowed disabled:opacity-40"
                    >
                      {emergencyPending === "stacks.restart-all" ? "Restarting…" : "Restart All"}
                    </button>
                  </div>

                  <div className="rounded-xl border border-rose-400/20 bg-rose-500/10 p-4">
                    <div className="mb-1 text-sm font-semibold">Shutdown All Stacks</div>
                    <div className="mb-4 text-xs text-neutral-500">Stops every running container. All services go offline.</div>
                    <button
                      onClick={() => setConfirmAction({ name: "Shutdown All Stacks", variant: "danger", _action: "stacks.stop-all" })}
                      disabled={!!emergencyPending || !can("admin")}
                      title={!can("admin") ? "Requires admin role" : undefined}
                      className="w-full rounded-lg border border-rose-400/30 bg-rose-500/15 px-3 py-2 text-xs font-medium text-rose-300 hover:bg-rose-500/25 disabled:cursor-not-allowed disabled:opacity-40"
                    >
                      {emergencyPending === "stacks.stop-all" ? "Stopping…" : "Shutdown All"}
                    </button>
                  </div>
                </div>
              </div>

              {/* Action result for stop-all / restart-all */}
              {emergencyResult && emergencyResult.action !== "diagnostics.run" && (
                <div className={["rounded-2xl border p-4", emergencyResult.ok ? "border-emerald-400/20 bg-emerald-500/10" : "border-rose-400/30 bg-rose-500/10"].join(" ")}>
                  <div className="mb-2 text-xs font-semibold uppercase tracking-wide">
                    <span className={emergencyResult.ok ? "text-emerald-300" : "text-rose-300"}>
                      {emergencyResult.ok ? "Completed" : "Failed"} — {emergencyResult.action}
                    </span>
                  </div>
                  {emergencyResult.results && (
                    <div className="space-y-1">
                      {emergencyResult.results.map((r, i) => (
                        <div key={i} className="flex items-center gap-2 text-xs">
                          <span className={r.ok ? "text-emerald-400" : "text-rose-400"}>{r.ok ? "✓" : "✕"}</span>
                          <span className="text-neutral-300">{r.name}</span>
                          {r.error && <span className="text-rose-400/70">{r.error}</span>}
                        </div>
                      ))}
                    </div>
                  )}
                  {emergencyResult.error && <div className="text-xs text-rose-300">{emergencyResult.error}</div>}
                </div>
              )}
            </div>
          )}

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

            {appLogsTarget && (
              <div className="mb-4 rounded-2xl border border-purple-400/30 bg-neutral-950 p-4">
                <div className="mb-2 flex items-center justify-between">
                  <div className="text-xs font-semibold text-purple-300">{appLogsTarget.name} — Logs</div>
                  <button onClick={() => setAppLogsTarget(null)} className="text-xs text-neutral-500 hover:text-white">Close</button>
                </div>
                {appLogsLoading ? (
                  <div className="text-xs text-neutral-500">Loading…</div>
                ) : appLogsLines.length === 0 ? (
                  <div className="text-xs text-neutral-500">No logs found</div>
                ) : (
                  <div className="max-h-48 overflow-y-auto font-mono text-[11px] text-neutral-400">
                    {appLogsLines.map((l, i) => (
                      <div key={i} className="border-b border-neutral-900 py-0.5">
                        <span className="mr-2 text-neutral-600">{new Date(Number(l.ts) / 1_000_000).toLocaleTimeString()}</span>
                        {l.line}
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}

            <div className="max-h-[50vh] overflow-y-auto pr-1">
              <div className="grid gap-4" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))" }}>
                {filteredApps.map((app, idx) => (
                  <div key={`${app.name}-${idx}`} className="group rounded-2xl border border-neutral-800 bg-neutral-800/70 p-4 transition hover:border-cyan-400/30 hover:bg-neutral-800">
                    <div className="flex items-center justify-between gap-2">
                      <div className="text-2xl">{app.logo}</div>
                      <div className="flex items-center gap-1.5">
                        <span className={[
                          "h-2 w-2 rounded-full",
                          app.status === "up" ? "bg-emerald-400" : app.status === "down" ? "bg-rose-500 animate-pulse" : "bg-neutral-600",
                        ].join(" ")} />
                        <span className="rounded-full bg-neutral-900 px-2 py-1 text-[10px] text-neutral-400">{app.category}</span>
                      </div>
                    </div>
                    <div className="mt-3 text-sm font-semibold text-neutral-200">{app.name}</div>
                    <div className="mt-1 text-xs text-neutral-500">{app.meta}</div>
                    <div className="mt-3 grid grid-cols-2 gap-2 opacity-0 transition group-hover:opacity-100">
                      {app.url
                        ? <button onClick={() => window.open(app.url, "_blank")} className="rounded-lg border border-neutral-700 bg-neutral-900/80 px-2 py-1 text-center text-[10px] text-neutral-300 hover:border-cyan-400/40 hover:text-cyan-300">Open</button>
                        : <div className="rounded-lg border border-neutral-800 bg-neutral-900/50 px-2 py-1 text-center text-[10px] text-neutral-600">N/A</div>
                      }
                      {app.container
                        ? <button
                            onClick={() => {
                              setAppLogsTarget(app);
                              setAppLogsLines([]);
                              setAppLogsLoading(true);
                              fetch(`${API_BASE}/api/logs/${encodeURIComponent(app.container)}`)
                                .then((r) => r.json())
                                .then((d) => setAppLogsLines(Array.isArray(d) ? d : []))
                                .catch(() => setAppLogsLines([]))
                                .finally(() => setAppLogsLoading(false));
                            }}
                            className="rounded-lg border border-neutral-700 bg-neutral-900/80 px-2 py-1 text-center text-[10px] text-neutral-300 hover:border-purple-400/40 hover:text-purple-300"
                          >Logs</button>
                        : <div className="rounded-lg border border-neutral-800 bg-neutral-900/50 px-2 py-1 text-center text-[10px] text-neutral-600">N/A</div>
                      }
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </div>
      )}

      {/* File viewer modal */}
      {fileViewerOpen && selectedFile && (
        <div className="fixed inset-0 z-40 flex items-center justify-center bg-black/70">
          <div className="flex max-h-[90vh] w-[min(96vw,1200px)] flex-col overflow-hidden rounded-2xl border border-rose-400/30 bg-neutral-900 p-6">
            <div className="mb-4 flex shrink-0 items-center justify-between gap-4">
              <div>
                <div className="text-lg font-semibold">{selectedFile.label}</div>
                <div className="font-mono text-xs text-neutral-500">{selectedFile.path}</div>
              </div>
              <button
                onClick={() => { setFileViewerOpen(false); setSelectedFile(null); }}
                className="text-xs text-neutral-400 hover:text-white"
              >
                Close
              </button>
            </div>

            <div className="mb-4 grid shrink-0 grid-cols-4 gap-3">
              {[
                { label: "Type",     value: selectedFile.type },
                { label: "Stack",    value: selectedFile.stack },
                { label: "Size",     value: `${selectedFile.size} B` },
                { label: "Modified", value: selectedFile.modifiedAt ? selectedFile.modifiedAt.slice(0, 19).replace("T", " ") : "n/a" },
              ].map(({ label, value }) => (
                <div key={label} className="rounded-xl border border-neutral-800 bg-neutral-800/50 p-3">
                  <div className="text-[10px] uppercase tracking-wide text-neutral-500">{label}</div>
                  <div className="mt-1 truncate text-sm text-neutral-200">{value}</div>
                </div>
              ))}
            </div>

            <div className="flex shrink-0 items-center justify-between gap-3">
              <div className="space-y-0.5 text-xs">
                <div className="text-neutral-500">{fileDraftStatus}</div>
                {fileLiveStatus && <div className="text-emerald-400">{fileLiveStatus}</div>}
              </div>
              <div className="flex items-center gap-2">
                <span className={["rounded-full px-2 py-1 text-[10px]", fileDirty ? "bg-amber-500/15 text-amber-300" : "bg-emerald-500/15 text-emerald-300"].join(" ")}>
                  {fileDirty ? "Unsaved changes" : "Saved"}
                </span>
                <button
                  onClick={revertEditorToLive}
                  className="rounded-lg border border-neutral-700 bg-neutral-800/80 px-3 py-1 text-[11px] text-neutral-300 hover:border-neutral-600"
                >
                  Revert
                </button>
                <button
                  onClick={saveFileDraft}
                  disabled={!fileDirty || !can("operator")}
                  title={!can("operator") ? "Requires operator role" : undefined}
                  className="rounded-lg border border-rose-400/20 bg-rose-500/10 px-3 py-1 text-[11px] text-rose-300 hover:bg-rose-500/20 disabled:cursor-not-allowed disabled:opacity-40"
                >
                  Save Draft
                </button>
                {selectedFile.validatable && (
                  <button
                    onClick={validateFileContent}
                    className={[
                      "rounded-lg border px-3 py-1 text-[11px] transition",
                      fileValidation === null
                        ? "border-neutral-700 bg-neutral-800/80 text-neutral-300 hover:border-neutral-600"
                        : fileValidation.status === "green"
                        ? "border-emerald-400/30 bg-emerald-500/10 text-emerald-300"
                        : fileValidation.status === "amber"
                        ? "border-amber-400/30 bg-amber-500/10 text-amber-300"
                        : "border-rose-400/30 bg-rose-500/10 text-rose-300",
                    ].join(" ")}
                  >
                    {fileValidation === null ? "Validate" : fileValidation.status === "green" ? "Valid" : fileValidation.status === "amber" ? "Warnings" : "Errors"}
                  </button>
                )}
                <button
                  onClick={() => setShowSaveLiveConfirm(true)}
                  disabled={!can("admin") || (selectedFile.validatable && (fileValidation === null || fileValidation.status === "red"))}
                  title={
                    !can("admin")
                      ? "Requires admin role"
                      : selectedFile.validatable && fileValidation === null
                      ? "Run Validate before saving live"
                      : selectedFile.validatable && fileValidation?.status === "red"
                      ? "Fix validation errors before saving live"
                      : undefined
                  }
                  className="rounded-lg border border-rose-400/40 bg-rose-500/20 px-3 py-1 text-[11px] font-medium text-rose-200 hover:bg-rose-500/30 disabled:cursor-not-allowed disabled:opacity-40"
                >
                  Save Live
                </button>
                {selectedFile.applyStrategy && (
                  <button
                    onClick={() => setShowApplyConfirm(true)}
                    disabled={
                      !can("admin") ||
                      fileDirty ||
                      (selectedFile.validatable && fileValidation?.status === "red")
                    }
                    title={
                      !can("admin")
                        ? "Requires admin role"
                        : fileDirty
                        ? "Save live before applying"
                        : selectedFile.validatable && fileValidation?.status === "red"
                        ? "Fix validation errors before applying"
                        : `Apply via ${selectedFile.applyStrategy}`
                    }
                    className="rounded-lg border border-blue-400/40 bg-blue-500/15 px-3 py-1 text-[11px] font-medium text-blue-200 hover:bg-blue-500/25 disabled:cursor-not-allowed disabled:opacity-40"
                  >
                    Apply
                  </button>
                )}
              </div>
            </div>

            {/* v0.7.0-a — LKG trusted baseline bar */}
            {lkg && (
              <div className="shrink-0 flex items-center gap-3 rounded-xl border border-emerald-400/20 bg-emerald-500/8 px-3 py-2">
                <div className="flex items-center gap-1.5 flex-1 min-w-0">
                  <span className="rounded bg-emerald-500/20 px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wide text-emerald-300">
                    Trusted baseline
                  </span>
                  <span className="truncate font-mono text-[11px] text-emerald-200/70">{lkg.fileName}</span>
                </div>
                <div className="flex shrink-0 gap-1.5">
                  <button
                    onClick={async () => {
                      await openBackupContent(lkg.fileName);
                      setShowRestoreConfirm(true);
                    }}
                    className="rounded-lg border border-emerald-400/25 bg-emerald-500/10 px-2 py-1 text-[10px] text-emerald-300 hover:bg-emerald-500/20"
                  >
                    Restore LKG
                  </button>
                  {selectedFile.applyStrategy && (
                    <button
                      onClick={async () => {
                        await openBackupContent(lkg.fileName);
                        setShowRestoreApplyConfirm(true);
                      }}
                      className="rounded-lg border border-emerald-400/25 bg-emerald-500/10 px-2 py-1 text-[10px] text-emerald-300 hover:bg-emerald-500/20"
                    >
                      Restore & Apply LKG
                    </button>
                  )}
                </div>
              </div>
            )}

            {/* Scrollable panels + editor — fills remaining modal height */}
            <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto">

            {fileValidation && fileValidation.issues.length > 0 && (
              <div className={[
                "shrink-0 rounded-xl border p-3",
                fileValidation.status === "red" ? "border-rose-400/30 bg-rose-500/10" : "border-amber-400/30 bg-amber-500/10",
              ].join(" ")}>
                <div className={["mb-1.5 text-[11px] font-semibold uppercase tracking-wide", fileValidation.status === "red" ? "text-rose-300" : "text-amber-300"].join(" ")}>
                  {fileValidation.status === "red" ? "Validation errors" : "Warnings"}
                </div>
                <ul className="space-y-1">
                  {fileValidation.issues.map((issue, i) => (
                    <li key={i} className={["text-xs", issue.level === "error" ? "text-rose-300" : "text-amber-300/80"].join(" ")}>
                      {issue.level === "error" ? "✕" : "△"} {issue.message}
                    </li>
                  ))}
                </ul>
              </div>
            )}
            {fileValidation && fileValidation.status === "green" && (
              <div className="shrink-0 rounded-xl border border-emerald-400/20 bg-emerald-500/10 px-3 py-2 text-xs text-emerald-300">
                Validation passed — no issues found
              </div>
            )}

            {fileApplyResult && (
              <div className={[
                "shrink-0 rounded-xl border p-3",
                fileApplyResult.ok ? "border-blue-400/30 bg-blue-500/10" : "border-rose-400/30 bg-rose-500/10",
              ].join(" ")}>
                <div className="mb-1.5 flex items-center justify-between">
                  <div className={["text-[11px] font-semibold uppercase tracking-wide", fileApplyResult.ok ? "text-blue-300" : "text-rose-300"].join(" ")}>
                    {fileApplyResult.ok ? `Applied · ${fileApplyResult.action}` : `Apply failed · ${fileApplyResult.action || "error"}`}
                  </div>
                  <button onClick={() => setFileApplyResult(null)} className="text-neutral-600 hover:text-neutral-400 text-xs">×</button>
                </div>
                <pre className="whitespace-pre-wrap font-mono text-[10px] text-neutral-400">{fileApplyResult.output}</pre>
              </div>
            )}

            {restoreResult && (
              <div className={[
                "shrink-0 rounded-xl border p-3",
                restoreResult.ok && restoreResult.validation?.status !== "red"
                  ? "border-emerald-400/30 bg-emerald-500/10"
                  : restoreResult.ok && restoreResult.validation?.status === "red"
                  ? "border-amber-400/30 bg-amber-500/10"
                  : "border-rose-400/30 bg-rose-500/10",
              ].join(" ")}>
                <div className="mb-1 flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <span className={[
                      "text-[11px] font-semibold uppercase tracking-wide",
                      restoreResult.ok && restoreResult.validation?.status !== "red" ? "text-emerald-300"
                      : restoreResult.ok ? "text-amber-300" : "text-rose-300",
                    ].join(" ")}>
                      {restoreResult.ok && restoreResult.validation?.status !== "red"
                        ? "Restore complete"
                        : restoreResult.ok
                        ? "Restore complete · validation failed"
                        : "Restore failed"}
                    </span>
                    {restoreResult.validation && (
                      <span className={[
                        "rounded px-1.5 py-0.5 text-[9px] uppercase tracking-wide",
                        restoreResult.validation.status === "green" ? "bg-emerald-500/20 text-emerald-300"
                        : restoreResult.validation.status === "amber" ? "bg-amber-500/20 text-amber-300"
                        : "bg-rose-500/20 text-rose-300",
                      ].join(" ")}>
                        validation {restoreResult.validation.status}
                      </span>
                    )}
                  </div>
                  <button onClick={() => setRestoreResult(null)} className="text-neutral-600 hover:text-neutral-400 text-xs">×</button>
                </div>
                {restoreResult.ok ? (
                  <div className="space-y-0.5 text-[11px] text-neutral-400">
                    <div>Restored from: <span className="font-mono text-neutral-300">{restoreResult.restoredFrom}</span></div>
                    <div>Safety backup: <span className="font-mono text-neutral-300">{restoreResult.safetyBackup?.fileName}</span></div>
                    {restoreResult.validation?.status === "red" && restoreResult.validation.errors?.length > 0 && (
                      <div className="mt-1.5 text-rose-300/80">
                        {restoreResult.validation.errors.slice(0, 3).map((e, i) => <div key={i}>{e}</div>)}
                      </div>
                    )}
                  </div>
                ) : (
                  <div className="text-[11px] text-rose-300">{restoreResult.error}</div>
                )}
              </div>
            )}

            {restoreApplyResult && (
              <div className={[
                "shrink-0 rounded-xl border p-3",
                restoreApplyResult.ok
                  ? "border-blue-400/30 bg-blue-500/10"
                  : restoreApplyResult.phase === "apply"
                  ? "border-amber-400/30 bg-amber-500/10"
                  : "border-rose-400/30 bg-rose-500/10",
              ].join(" ")}>
                <div className="mb-1.5 flex items-center justify-between">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className={[
                      "text-[11px] font-semibold uppercase tracking-wide",
                      restoreApplyResult.ok ? "text-blue-300" : restoreApplyResult.phase === "apply" ? "text-amber-300" : "text-rose-300",
                    ].join(" ")}>
                      {restoreApplyResult.ok
                        ? `Restore & Apply complete · ${restoreApplyResult.apply?.action}`
                        : restoreApplyResult.phase === "apply"
                        ? `Restored · Apply failed · ${restoreApplyResult.apply?.action}`
                        : `Restore & Apply failed (${restoreApplyResult.phase})`}
                    </span>
                    {restoreApplyResult.validation && (
                      <span className={[
                        "rounded px-1.5 py-0.5 text-[9px] uppercase tracking-wide",
                        restoreApplyResult.validation.status === "green" ? "bg-emerald-500/20 text-emerald-300"
                        : restoreApplyResult.validation.status === "amber" ? "bg-amber-500/20 text-amber-300"
                        : "bg-rose-500/20 text-rose-300",
                      ].join(" ")}>
                        validation {restoreApplyResult.validation.status}
                      </span>
                    )}
                  </div>
                  <button onClick={() => setRestoreApplyResult(null)} className="text-neutral-600 hover:text-neutral-400 text-xs">×</button>
                </div>
                {restoreApplyResult.restoredFrom && (
                  <div className="mb-1 space-y-0.5 text-[11px] text-neutral-400">
                    <div>Restored from: <span className="font-mono text-neutral-300">{restoreApplyResult.restoredFrom}</span></div>
                    {restoreApplyResult.safetyBackup && (
                      <div>Safety backup: <span className="font-mono text-neutral-300">{restoreApplyResult.safetyBackup.fileName}</span></div>
                    )}
                  </div>
                )}
                {restoreApplyResult.apply?.stderr && !restoreApplyResult.ok && (
                  <div className="mt-1.5">
                    <div className="mb-0.5 text-[9px] uppercase tracking-wide text-neutral-600">stderr</div>
                    <pre className="whitespace-pre-wrap font-mono text-[10px] text-rose-400/80">{restoreApplyResult.apply.stderr}</pre>
                  </div>
                )}
                {restoreApplyResult.apply?.output && !restoreApplyResult.apply?.stderr && (
                  <pre className="mt-1.5 whitespace-pre-wrap font-mono text-[10px] text-neutral-400">{restoreApplyResult.apply.output}</pre>
                )}
                {!restoreApplyResult.restoredFrom && restoreApplyResult.error && (
                  <div className="text-[11px] text-rose-300">{restoreApplyResult.error}</div>
                )}
                {restoreApplyResult.rollbackRecommendation?.suggested && (
                  <div className="mt-2 rounded-lg border border-amber-400/25 bg-amber-500/10 px-2.5 py-2">
                    <div className="mb-0.5 text-[9px] uppercase tracking-wide text-amber-400/80">Rollback recommended</div>
                    <div className="text-[11px] text-amber-200/90">{restoreApplyResult.rollbackRecommendation.reason}</div>
                    <div className="mt-1 font-mono text-[10px] text-neutral-400">{restoreApplyResult.rollbackRecommendation.backupFileName}</div>
                  </div>
                )}
              </div>
            )}

            {restoreLogData.length > 0 && (
              <div className="shrink-0 rounded-xl border border-neutral-800 bg-neutral-900/60 p-3">
                <div className="mb-2 text-[10px] uppercase tracking-wide text-neutral-500">Restore History</div>
                <div className="space-y-1.5">
                  {restoreLogData.map((entry, i) => {
                    const isExpanded = expandedRestoreEntry === i;
                    const outcomeCls = entry.outcome === "success" ? "text-emerald-400" : entry.outcome === "partial" ? "text-amber-400" : "text-rose-400";
                    const outcomeIcon = entry.outcome === "success" ? "✓" : entry.outcome === "partial" ? "◐" : "✕";
                    const hasDetail = entry.phases || entry.validation || entry.rollbackRecommendation?.suggested;
                    return (
                      <div key={i}>
                        <div
                          className={["flex items-center gap-2 text-[11px]", hasDetail ? "cursor-pointer hover:opacity-80" : ""].join(" ")}
                          onClick={() => hasDetail && setExpandedRestoreEntry(isExpanded ? null : i)}
                        >
                          <span className={outcomeCls}>{outcomeIcon}</span>
                          <span className="text-neutral-300">{entry.type}</span>
                          {entry.restoreMode === "side_by_side" && (
                            <span className="rounded bg-sky-500/15 px-1 py-0.5 text-[9px] text-sky-300">side-by-side</span>
                          )}
                          {entry.backupLabel && <span className="text-sky-300/70">· {entry.backupLabel}</span>}
                          {entry.wasLkg && <span className="text-[9px] uppercase tracking-wide text-emerald-400/60">LKG</span>}
                          {entry.outcome === "partial" && <span className="rounded bg-amber-500/20 px-1 py-0.5 text-[9px] text-amber-300">partial</span>}
                          {entry.validation && (
                            <span className={[
                              "rounded px-1 py-0.5 text-[9px]",
                              entry.validation.status === "green" ? "bg-emerald-500/15 text-emerald-300/80"
                              : entry.validation.status === "amber" ? "bg-amber-500/15 text-amber-300/80"
                              : "bg-rose-500/15 text-rose-300/80",
                            ].join(" ")}>v:{entry.validation.status}</span>
                          )}
                          <span className="ml-auto text-neutral-500">{entry.timestamp.slice(0, 19).replace("T", " ")}</span>
                          {hasDetail && <span className="text-neutral-600">{isExpanded ? "▲" : "▼"}</span>}
                        </div>
                        {isExpanded && (
                          <div className="ml-4 mt-1.5 space-y-1 text-[10px]">
                            {entry.phases && entry.phases.map((p, pi) => (
                              <div key={pi} className="flex items-center gap-2">
                                <span className={p.status === "ok" ? "text-emerald-400/70" : "text-rose-400/70"}>{p.status === "ok" ? "✓" : "✕"}</span>
                                <span className="text-neutral-400">{p.name}</span>
                                {p.detail && <span className="text-neutral-600 truncate">{p.detail}</span>}
                                <span className="ml-auto text-neutral-700">{p.timestamp.slice(11, 19)}</span>
                              </div>
                            ))}
                            {entry.rollbackRecommendation?.suggested && (
                              <div className="mt-1 rounded border border-amber-400/20 bg-amber-500/10 px-2 py-1.5">
                                <div className="text-amber-300/80">{entry.rollbackRecommendation.reason}</div>
                                <div className="mt-0.5 font-mono text-neutral-500">{entry.rollbackRecommendation.backupFileName}</div>
                              </div>
                            )}
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              </div>
            )}

            {fileApplyLog.length > 0 && (
              <div className="shrink-0 rounded-xl border border-neutral-800 bg-neutral-900/60 p-3">
                <div className="mb-2 text-[10px] uppercase tracking-wide text-neutral-500">Apply History</div>
                <div className="space-y-1">
                  {fileApplyLog.map((entry, i) => (
                    <div key={i} className="flex items-center gap-2 text-[11px]">
                      <span className={entry.ok ? "text-emerald-400" : "text-rose-400"}>{entry.ok ? "✓" : "✕"}</span>
                      <span className="text-neutral-300">{entry.strategy}</span>
                      <span className="text-neutral-600">·</span>
                      <span className="text-neutral-500">{entry.timestamp.slice(0, 19).replace("T", " ")}</span>
                      {!entry.ok && entry.output && (
                        <span className="truncate text-rose-400/70" title={entry.output}>{entry.output.slice(0, 60)}</span>
                      )}
                    </div>
                  ))}
                </div>
              </div>
            )}

            {fileBackups.length > 0 && (
              <div className="shrink-0 rounded-xl border border-neutral-800 bg-neutral-900/60 p-3">
                <div className="mb-2 flex items-center justify-between">
                  <div className="text-[10px] uppercase tracking-wide text-neutral-500">
                    Backups ({fileBackups.length})
                  </div>
                  <div className="flex items-center gap-2">
                    {selectedBackup && (
                      <button
                        onClick={() => { setSelectedBackup(null); setDiffMode("draft-live"); }}
                        className="text-[10px] text-neutral-500 hover:text-neutral-300"
                      >
                        Close preview
                      </button>
                    )}
                    <button
                      onClick={() => { setShowPruneModal(true); setPrunePreview(null); setPruneResult(null); }}
                      disabled={!can("admin")}
                      title={!can("admin") ? "Requires admin role" : undefined}
                      className="text-[10px] text-rose-400/60 hover:text-rose-300 disabled:cursor-not-allowed disabled:opacity-40"
                    >
                      Prune
                    </button>
                  </div>
                </div>
                <div className="space-y-0.5">
                  {fileBackups.map((backup) => (
                    <div
                      key={backup.fileName}
                      className={[
                        "rounded px-2 py-1 text-[11px]",
                        selectedBackup?.fileName === backup.fileName ? "bg-neutral-800" : "",
                      ].join(" ")}
                    >
                      {/* Main row */}
                      <div className="flex items-center gap-2">
                        <span className="flex-1 text-neutral-400">
                          {backup.createdAt.slice(0, 19).replace("T", " ")}
                        </span>
                        {lkg?.fileName === backup.fileName && (
                          <span className="rounded bg-emerald-500/15 px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wide text-emerald-300">
                            LKG
                          </span>
                        )}
                        {backupLabels[backup.fileName] && (
                          <span className="rounded bg-sky-500/15 px-1.5 py-0.5 text-[9px] text-sky-300">
                            {backupLabels[backup.fileName].label}
                          </span>
                        )}
                        <span className="text-neutral-600">{backup.size} B</span>
                        <button
                          onClick={() => openBackupContent(backup.fileName)}
                          className="text-[10px] text-blue-400 hover:text-blue-300"
                        >
                          {selectedBackup?.fileName === backup.fileName ? "Hide" : "View"}
                        </button>
                        <button
                          onClick={async () => {
                            if (selectedBackup?.fileName !== backup.fileName) {
                              await openBackupContent(backup.fileName);
                            }
                            setShowRestoreConfirm(true);
                          }}
                          disabled={!can("admin")}
                          title={!can("admin") ? "Requires admin role" : undefined}
                          className="text-[10px] text-amber-400 hover:text-amber-300 disabled:cursor-not-allowed disabled:opacity-40"
                        >
                          Restore
                        </button>
                        {selectedFile.applyStrategy && (
                          <button
                            onClick={async () => {
                              if (selectedBackup?.fileName !== backup.fileName) {
                                await openBackupContent(backup.fileName);
                              }
                              setShowRestoreApplyConfirm(true);
                            }}
                            disabled={!can("admin")}
                            title={!can("admin") ? "Requires admin role" : undefined}
                            className="text-[10px] text-blue-400 hover:text-blue-300 disabled:cursor-not-allowed disabled:opacity-40"
                          >
                            Restore & Apply
                          </button>
                        )}
                        <button
                          onClick={() => markAsKnownGood(backup.fileName)}
                          className={[
                            "text-[10px] transition",
                            lkg?.fileName === backup.fileName
                              ? "text-emerald-400 cursor-default"
                              : !can("operator")
                              ? "text-neutral-600 cursor-not-allowed opacity-40"
                              : "text-neutral-600 hover:text-emerald-400",
                          ].join(" ")}
                          title={
                            lkg?.fileName === backup.fileName
                              ? "This is the current LKG"
                              : !can("operator")
                              ? "Requires operator role"
                              : "Mark as Last-Known-Good"
                          }
                          disabled={lkg?.fileName === backup.fileName || !can("operator")}
                        >
                          {lkg?.fileName === backup.fileName ? "LKG ✓" : "Mark LKG"}
                        </button>
                        <button
                          onClick={() => {
                            if (!can("operator")) return;
                            if (labelEditing === backup.fileName) {
                              setLabelEditing(null);
                              setLabelInput("");
                            } else {
                              setLabelEditing(backup.fileName);
                              setLabelInput(backupLabels[backup.fileName]?.label || "");
                            }
                          }}
                          disabled={!can("operator")}
                          title={!can("operator") ? "Requires operator role" : undefined}
                          className="text-[10px] text-neutral-500 hover:text-sky-400 disabled:cursor-not-allowed disabled:opacity-40"
                        >
                          {backupLabels[backup.fileName] ? "Edit label" : "Label"}
                        </button>
                        <button
                          onClick={() => loadRestorePlan(backup.fileName)}
                          disabled={restorePlanLoading || !can("admin")}
                          title={!can("admin") ? "Requires admin role" : undefined}
                          className="text-[10px] text-neutral-500 hover:text-purple-400 disabled:cursor-not-allowed disabled:opacity-40"
                        >
                          Plan
                        </button>
                      </div>

                      {/* Inline label editor */}
                      {labelEditing === backup.fileName && (
                        <div className="mt-1.5 space-y-1.5 pb-0.5">
                          <div className="flex flex-wrap gap-1">
                            {["Stable", "Before upgrade", "Rollback point", "Known bad", "Pre-hotfix"].map((preset) => (
                              <button
                                key={preset}
                                onClick={() => setLabelInput(preset)}
                                className={[
                                  "rounded border px-2 py-0.5 text-[10px] transition",
                                  labelInput === preset
                                    ? "border-sky-400/40 bg-sky-500/20 text-sky-300"
                                    : "border-neutral-700 bg-neutral-800/60 text-neutral-400 hover:text-neutral-200",
                                ].join(" ")}
                              >
                                {preset}
                              </button>
                            ))}
                          </div>
                          <div className="flex items-center gap-1.5">
                            <input
                              value={labelInput}
                              onChange={(e) => setLabelInput(e.target.value.slice(0, 64))}
                              placeholder="Custom label…"
                              className="flex-1 rounded border border-neutral-700 bg-neutral-800/80 px-2 py-1 text-[11px] text-neutral-200 outline-none placeholder:text-neutral-600 focus:border-sky-400/40"
                              onKeyDown={(e) => {
                                if (e.key === "Enter") saveBackupLabel(backup.fileName, labelInput);
                                if (e.key === "Escape") { setLabelEditing(null); setLabelInput(""); }
                              }}
                              autoFocus
                            />
                            <button
                              onClick={() => saveBackupLabel(backup.fileName, labelInput)}
                              className="rounded border border-sky-400/30 bg-sky-500/15 px-2 py-1 text-[10px] text-sky-300 hover:bg-sky-500/25"
                            >
                              Save
                            </button>
                            <button
                              onClick={() => { setLabelEditing(null); setLabelInput(""); }}
                              className="rounded border border-neutral-700 bg-neutral-800/60 px-2 py-1 text-[10px] text-neutral-400 hover:text-neutral-200"
                            >
                              Cancel
                            </button>
                            {backupLabels[backup.fileName] && (
                              <button
                                onClick={() => saveBackupLabel(backup.fileName, "")}
                                className="rounded border border-neutral-700 bg-neutral-800/60 px-2 py-1 text-[10px] text-neutral-500 hover:text-rose-400"
                              >
                                Clear
                              </button>
                            )}
                          </div>
                        </div>
                      )}
                    </div>
                  ))}
                </div>
                {selectedBackup && (
                  <div className="mt-3 border-t border-neutral-800 pt-3">
                    <div className="mb-1.5 font-mono text-[10px] text-neutral-600">
                      {selectedBackup.fileName}
                    </div>
                    <pre className="max-h-52 overflow-auto rounded bg-neutral-950 p-3 font-mono text-[10px] leading-5 text-neutral-400">
                      {selectedBackup.content}
                    </pre>
                  </div>
                )}
              </div>
            )}

            {/* v0.6.0-b — diff viewer */}
            {(() => {
              const draftVsLive   = buildSimpleDiff(selectedFile.content || "", fileEditorContent || "");
              const liveVsBackup  = selectedBackup
                ? buildSimpleDiff(selectedBackup.content || "", selectedFile.content || "")
                : null;
              const activeDiff    = diffMode === "live-backup" && liveVsBackup ? liveVsBackup : draftVsLive;
              const activeLabel   = diffMode === "live-backup" && liveVsBackup
                ? `Live vs Backup: ${selectedBackup.fileName}`
                : "Draft vs Live";
              const { added, removed, changed } = activeDiff.summary;
              const hasDiff = added + removed + changed > 0;

              return (
                <div className="shrink-0 rounded-xl border border-neutral-800 bg-neutral-900/60">
                  {/* Controls */}
                  <div className="flex items-center gap-2 border-b border-neutral-800 px-3 py-2">
                    <span className="text-[10px] uppercase tracking-wide text-neutral-500">Diff</span>
                    <div className="flex gap-1">
                      <button
                        onClick={() => setDiffMode("draft-live")}
                        className={[
                          "rounded px-2 py-0.5 text-[10px] transition",
                          diffMode === "draft-live"
                            ? "bg-rose-500/20 text-rose-300"
                            : "text-neutral-500 hover:text-neutral-300",
                        ].join(" ")}
                      >
                        Draft vs Live
                      </button>
                      <button
                        disabled={!liveVsBackup}
                        onClick={() => setDiffMode("live-backup")}
                        className={[
                          "rounded px-2 py-0.5 text-[10px] transition",
                          diffMode === "live-backup"
                            ? "bg-blue-500/20 text-blue-300"
                            : "text-neutral-500 hover:text-neutral-300",
                          !liveVsBackup ? "opacity-30 cursor-not-allowed" : "",
                        ].join(" ")}
                      >
                        Live vs Backup
                      </button>
                    </div>
                    {hasDiff && (
                      <div className="ml-auto flex gap-1.5">
                        {added > 0 && (
                          <span className="rounded bg-emerald-500/10 px-2 py-0.5 text-[10px] text-emerald-300">
                            +{added} added
                          </span>
                        )}
                        {removed > 0 && (
                          <span className="rounded bg-rose-500/10 px-2 py-0.5 text-[10px] text-rose-300">
                            -{removed} removed
                          </span>
                        )}
                        {changed > 0 && (
                          <span className="rounded bg-amber-500/10 px-2 py-0.5 text-[10px] text-amber-300">
                            ~{changed} changed
                          </span>
                        )}
                      </div>
                    )}
                  </div>

                  {!hasDiff ? (
                    <div className="px-3 py-2 text-[11px] text-neutral-600">
                      {activeLabel} — no differences
                    </div>
                  ) : (
                    <div className="max-h-52 overflow-auto">
                      {/* Column headers */}
                      <div className="sticky top-0 z-10 grid grid-cols-[3rem_1fr_1fr] gap-0 border-b border-neutral-800 bg-neutral-900 px-0">
                        <div className="px-2 py-1 text-[9px] uppercase tracking-wide text-neutral-600">#</div>
                        <div className="border-l border-neutral-800 px-2 py-1 text-[9px] uppercase tracking-wide text-neutral-600">
                          {diffMode === "live-backup" ? "Backup" : "Draft"}
                        </div>
                        <div className="border-l border-neutral-800 px-2 py-1 text-[9px] uppercase tracking-wide text-neutral-600">
                          Live
                        </div>
                      </div>
                      {(() => {
                        const changedRows = activeDiff.rows.filter((row) => row.type !== "same");
                        const ROW_CAP = 150;
                        const visible = changedRows.slice(0, ROW_CAP);
                        const overflow = changedRows.length - visible.length;
                        return (
                          <>
                            {visible.map((row) => (
                              <div
                                key={row.line}
                                className={["grid grid-cols-[3rem_1fr_1fr] gap-0", diffRowClass(row.type)].join(" ")}
                              >
                                <div className="px-2 py-0.5 text-[10px] text-neutral-600 select-none">{row.line}</div>
                                <div className="border-l border-neutral-800/60 px-2 py-0.5 font-mono text-[10px] leading-5 text-neutral-400 whitespace-pre-wrap break-all">
                                  {row.left || <span className="text-neutral-700">—</span>}
                                </div>
                                <div className="border-l border-neutral-800/60 px-2 py-0.5 font-mono text-[10px] leading-5 text-neutral-300 whitespace-pre-wrap break-all">
                                  {row.right || <span className="text-neutral-700">—</span>}
                                </div>
                              </div>
                            ))}
                            {overflow > 0 && (
                              <div className="px-3 py-1.5 text-[10px] text-neutral-600">
                                … {overflow} more changed row{overflow !== 1 ? "s" : ""} not shown
                              </div>
                            )}
                          </>
                        );
                      })()}
                    </div>
                  )}
                </div>
              );
            })()}

            <textarea
              value={fileEditorContent}
              onChange={(e) => { setFileEditorContent(e.target.value); setFileDirty(true); setFileValidation(null); }}
              className="min-h-[180px] flex-1 resize-none rounded-xl border border-neutral-800 bg-neutral-950/80 p-4 font-mono text-xs leading-6 text-neutral-200 outline-none focus:border-rose-400/30"
              spellCheck={false}
            />

            </div>{/* end scrollable panels + editor */}
          </div>
        </div>
      )}

      {/* Confirm restore modal */}
      {showRestoreConfirm && selectedFile && selectedBackup && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70">
          <div className="w-[32rem] rounded-xl border border-amber-400/30 bg-neutral-900 p-6">
            <div className="mb-2 text-lg font-semibold">Confirm Restore</div>
            <div className="mb-1 text-sm text-neutral-400">You are about to restore this backup to the live file:</div>
            <div className="mb-3 rounded bg-neutral-800 px-3 py-2 font-mono text-xs text-amber-300">
              {selectedBackup.fileName}
            </div>
            <div className="mb-1 text-xs text-neutral-500">
              Target: <span className="font-mono text-neutral-300">{selectedFile.path}</span>
            </div>
            <div className="mt-3 rounded border border-amber-400/20 bg-amber-500/10 px-3 py-2 text-xs text-amber-300">
              The current live file will be automatically backed up before overwriting.
            </div>
            <div className="mt-4 flex justify-end gap-2">
              <button
                onClick={() => setShowRestoreConfirm(false)}
                className="rounded bg-neutral-700 px-3 py-1 text-sm hover:bg-neutral-600"
              >
                Cancel
              </button>
              <button
                onClick={restoreFile}
                className="rounded bg-amber-600 px-3 py-1 text-sm font-semibold text-white hover:bg-amber-500"
              >
                Restore Now
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Confirm restore & apply modal */}
      {showRestoreApplyConfirm && selectedFile && selectedBackup && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70">
          <div className="w-[34rem] rounded-xl border border-blue-400/30 bg-neutral-900 p-6">
            <div className="mb-2 text-lg font-semibold">Confirm Restore & Apply</div>
            <div className="mb-1 text-sm text-neutral-400">This will run two steps in sequence:</div>
            <ol className="mb-4 mt-2 space-y-2 text-sm">
              <li className="flex gap-3">
                <span className="shrink-0 rounded bg-amber-500/20 px-1.5 py-0.5 text-[10px] font-semibold text-amber-300">1</span>
                <div>
                  <div className="text-neutral-200">Restore backup to live</div>
                  <div className="mt-0.5 font-mono text-[11px] text-neutral-500">{selectedBackup.fileName}</div>
                </div>
              </li>
              <li className="flex gap-3">
                <span className="shrink-0 rounded bg-blue-500/20 px-1.5 py-0.5 text-[10px] font-semibold text-blue-300">2</span>
                <div>
                  <div className="text-neutral-200">Apply via <span className="font-mono text-blue-300">{selectedFile.applyStrategy}</span></div>
                  <div className="mt-0.5 font-mono text-[11px] text-neutral-500">{selectedFile.applyPath}</div>
                </div>
              </li>
            </ol>
            <div className="rounded border border-amber-400/20 bg-amber-500/10 px-3 py-2 text-xs text-amber-300">
              The current live file will be backed up before overwriting.
              {selectedFile.applyStrategy === "compose-up" && (
                <span> Running containers may restart.</span>
              )}
            </div>
            <div className="mt-4 flex justify-end gap-2">
              <button
                onClick={() => setShowRestoreApplyConfirm(false)}
                className="rounded bg-neutral-700 px-3 py-1 text-sm hover:bg-neutral-600"
              >
                Cancel
              </button>
              <button
                onClick={restoreAndApplyFile}
                className="rounded bg-blue-600 px-3 py-1 text-sm font-semibold text-white hover:bg-blue-500"
              >
                Restore & Apply Now
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Confirm apply modal */}
      {showApplyConfirm && selectedFile && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70">
          <div className="w-[32rem] rounded-xl border border-blue-400/30 bg-neutral-900 p-6">
            <div className="mb-2 text-lg font-semibold">Confirm Apply</div>
            <div className="mb-1 text-sm text-neutral-400">This will apply the saved live file to its stack:</div>
            <div className="mb-3 rounded bg-neutral-800 px-3 py-2 font-mono text-xs text-blue-300">
              {selectedFile.path}
            </div>
            <div className="mb-1 text-xs text-neutral-500">
              Strategy: <span className="text-neutral-300">{selectedFile.applyStrategy}</span>
            </div>
            <div className="mb-1 text-xs text-neutral-500">
              Target: <span className="text-neutral-300 font-mono">{selectedFile.applyPath}</span>
            </div>
            {selectedFile.applyStrategy === "compose-up" && (
              <div className="mb-4 mt-3 rounded border border-amber-400/20 bg-amber-500/10 px-3 py-2 text-xs text-amber-300">
                This will run <span className="font-mono">docker compose up -d</span> — running containers may restart.
              </div>
            )}
            {selectedFile.applyStrategy === "caddy-reload" && (
              <div className="mb-4 mt-3 rounded border border-blue-400/20 bg-blue-500/10 px-3 py-2 text-xs text-blue-300">
                This will hot-reload Caddy — no downtime expected.
              </div>
            )}
            {fileValidation?.status === "green" && (
              <div className="mb-4 rounded border border-emerald-400/20 bg-emerald-500/10 px-3 py-2 text-xs text-emerald-300">
                Validation passed
              </div>
            )}
            <div className="flex justify-end gap-2">
              <button
                onClick={() => setShowApplyConfirm(false)}
                className="rounded bg-neutral-700 px-3 py-1 text-sm"
              >
                Cancel
              </button>
              <button
                onClick={applyFileLive}
                className="rounded bg-blue-600 px-3 py-1 text-sm font-semibold text-white hover:bg-blue-500"
              >
                Apply Now
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Confirm live save modal */}
      {showSaveLiveConfirm && selectedFile && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70">
          <div className="w-[28rem] rounded-xl border border-rose-400/30 bg-neutral-900 p-6">
            <div className="mb-2 text-lg font-semibold">Confirm Live Save</div>
            <div className="mb-1 text-sm text-neutral-400">
              You are about to overwrite the live file:
            </div>
            <div className="mb-3 rounded bg-neutral-800 px-3 py-2 font-mono text-xs text-rose-300">
              {selectedFile.path}
            </div>
            {fileValidation?.status === "amber" && fileValidation.issues.length > 0 && (
              <div className="mb-3 rounded border border-amber-400/30 bg-amber-500/10 p-3">
                <div className="mb-1 text-[11px] font-semibold text-amber-300">Warnings (not blocking)</div>
                <ul className="space-y-1">
                  {fileValidation.issues.map((issue, i) => (
                    <li key={i} className="text-xs text-amber-300/80">△ {issue.message}</li>
                  ))}
                </ul>
              </div>
            )}
            {fileValidation?.status === "green" && (
              <div className="mb-3 rounded border border-emerald-400/20 bg-emerald-500/10 px-3 py-2 text-xs text-emerald-300">
                Validation passed
              </div>
            )}
            <div className="mb-4 text-xs text-neutral-500">
              A backup of the current live file will be created before writing.
            </div>
            <div className="flex justify-end gap-2">
              <button
                onClick={() => setShowSaveLiveConfirm(false)}
                className="rounded bg-neutral-700 px-3 py-1 text-sm"
              >
                Cancel
              </button>
              <button
                onClick={() => { setShowSaveLiveConfirm(false); saveFileLive(true); }}
                className="rounded bg-rose-500 px-3 py-1 text-sm font-semibold text-white"
              >
                Overwrite Live File
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Restore Plan modal */}
      {showRestorePlanModal && restorePlan && selectedFile && (
        <div className="fixed inset-0 z-60 flex items-center justify-center bg-black/70 p-4" style={{ zIndex: 60 }}>
          <div className="flex w-[min(96vw,580px)] flex-col rounded-xl border border-purple-400/25 bg-neutral-900 shadow-2xl">

            {/* Header */}
            <div className="flex items-center justify-between border-b border-neutral-800 px-5 py-4">
              <div>
                <div className="font-semibold">Restore Plan</div>
                <div className="mt-0.5 text-xs text-neutral-500">{restorePlan.fileLabel} · {restorePlan.fileId}</div>
              </div>
              <button
                onClick={() => { setShowRestorePlanModal(false); setRestorePlan(null); }}
                className="text-xs text-neutral-400 hover:text-white"
              >
                Close
              </button>
            </div>

            <div className="overflow-y-auto px-5 py-4 space-y-4">

              {/* Risk level */}
              {(() => {
                const risk = restorePlan.riskLevel;
                const badge = risk === "safe"
                  ? "border-emerald-400/30 bg-emerald-500/15 text-emerald-300"
                  : risk === "warning"
                  ? "border-amber-400/30 bg-amber-500/15 text-amber-300"
                  : "border-rose-400/30 bg-rose-500/15 text-rose-300";
                const label = risk === "safe" ? "Safe" : risk === "warning" ? "Proceed with caution" : "High risk";
                return (
                  <div className={["rounded-lg border px-4 py-3", badge].join(" ")}>
                    <div className="mb-1 flex items-center gap-2">
                      <span className="text-sm font-semibold">{label}</span>
                    </div>
                    {restorePlan.riskReasons.length > 0 && (
                      <ul className="mt-1 space-y-0.5">
                        {restorePlan.riskReasons.map((r, i) => (
                          <li key={i} className="text-xs opacity-80">{r}</li>
                        ))}
                      </ul>
                    )}
                    <div className="mt-1.5 text-xs opacity-70 italic">{restorePlan.recommendation}</div>
                  </div>
                );
              })()}

              {/* Source backup */}
              <div>
                <div className="mb-1.5 text-[10px] uppercase tracking-wide text-neutral-500">Source backup</div>
                <div className="rounded-lg border border-neutral-800 bg-neutral-800/50 px-3 py-2 space-y-1">
                  <div className="flex items-center gap-2 text-xs">
                    <span className="text-neutral-300 font-mono">
                      {restorePlan.backup.createdAt ? restorePlan.backup.createdAt.slice(0, 19).replace("T", " ") : restorePlan.backup.fileName}
                    </span>
                    {restorePlan.backup.isLkg && (
                      <span className="rounded bg-emerald-500/15 px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wide text-emerald-300">LKG</span>
                    )}
                    {restorePlan.backup.label && (
                      <span className="rounded bg-sky-500/15 px-1.5 py-0.5 text-[9px] text-sky-300">{restorePlan.backup.label}</span>
                    )}
                  </div>
                  <div className="text-[11px] text-neutral-500">
                    Differs from live: <span className={restorePlan.backup.driftedFromLive ? "text-amber-300" : "text-emerald-300"}>{restorePlan.backup.driftedFromLive ? "yes" : "no"}</span>
                  </div>
                </div>
              </div>

              {/* Overwrite */}
              <div>
                <div className="mb-1.5 text-[10px] uppercase tracking-wide text-neutral-500">Overwrite target</div>
                <div className="rounded-lg border border-neutral-800 bg-neutral-800/50 px-3 py-2 space-y-0.5 text-[11px]">
                  <div className="text-neutral-400">Live file: <span className={restorePlan.overwrite.liveExists ? "text-neutral-200" : "text-rose-400"}>{restorePlan.overwrite.liveExists ? "exists" : "missing"}</span></div>
                  {restorePlan.overwrite.liveModifiedAt && (
                    <div className="text-neutral-500">Last modified: {restorePlan.overwrite.liveModifiedAt.slice(0, 19).replace("T", " ")}</div>
                  )}
                  <div className="truncate font-mono text-neutral-600">{restorePlan.livePath}</div>
                </div>
              </div>

              {/* Dependencies */}
              {restorePlan.dependencies.length > 0 && (
                <div>
                  <div className="mb-1.5 text-[10px] uppercase tracking-wide text-neutral-500">Dependencies</div>
                  <div className="space-y-1">
                    {restorePlan.dependencies.map((dep) => (
                      <div key={dep.id} className="flex items-center justify-between rounded-lg border border-neutral-800 bg-neutral-800/50 px-3 py-1.5 text-[11px]">
                        <div>
                          <span className="text-neutral-300">{dep.label}</span>
                          {dep.required && <span className="ml-1.5 text-[9px] uppercase tracking-wide text-rose-400/70">required</span>}
                        </div>
                        <span className={dep.exists ? "text-emerald-400" : "text-rose-400"}>{dep.exists ? "✓ present" : "✕ missing"}</span>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* Restore mode selector */}
              <div>
                <div className="mb-2 text-[10px] uppercase tracking-wide text-neutral-500">Restore mode</div>
                <div className="flex gap-2">
                  <button
                    onClick={() => { setRestoreMode("in_place"); setSbsResult(null); }}
                    className={[
                      "flex-1 rounded-lg border px-3 py-2 text-xs transition-colors",
                      restoreMode === "in_place"
                        ? "border-amber-400/40 bg-amber-500/15 text-amber-300"
                        : "border-neutral-700 bg-neutral-800/50 text-neutral-400 hover:border-neutral-600",
                    ].join(" ")}
                  >
                    <div className="font-semibold">In-place</div>
                    <div className="mt-0.5 text-[10px] opacity-70">Overwrites live file</div>
                  </button>
                  <button
                    onClick={() => { setRestoreMode("side_by_side"); setSbsResult(null); }}
                    className={[
                      "flex-1 rounded-lg border px-3 py-2 text-xs transition-colors",
                      restoreMode === "side_by_side"
                        ? "border-sky-400/40 bg-sky-500/15 text-sky-300"
                        : "border-neutral-700 bg-neutral-800/50 text-neutral-400 hover:border-neutral-600",
                    ].join(" ")}
                  >
                    <div className="font-semibold">Side-by-side</div>
                    <div className="mt-0.5 text-[10px] opacity-70">Live file unchanged</div>
                  </button>
                </div>
              </div>

              {/* Side-by-side target path */}
              {restoreMode === "side_by_side" && (
                <div>
                  <div className="mb-1.5 text-[10px] uppercase tracking-wide text-neutral-500">Restore target</div>
                  <input
                    type="text"
                    value={sbsTargetPath}
                    onChange={(e) => { setSbsTargetPath(e.target.value); setSbsResult(null); }}
                    className="w-full rounded-lg border border-sky-400/20 bg-neutral-800/60 px-3 py-2 font-mono text-[11px] text-neutral-200 outline-none focus:border-sky-400/50"
                    placeholder="Target path (auto-generated if blank)"
                  />
                  <div className="mt-1.5 rounded border border-sky-400/15 bg-sky-500/5 px-2.5 py-1.5 text-[10px] text-sky-300/70">
                    Live file at <span className="font-mono">{restorePlan.livePath}</span> will remain unchanged. Restore writes to the path above.
                  </div>
                </div>
              )}

              {/* Side-by-side result */}
              {sbsResult && (
                <div className={[
                  "rounded-lg border p-3",
                  sbsResult.ok ? "border-sky-400/30 bg-sky-500/10" : "border-rose-400/30 bg-rose-500/10",
                ].join(" ")}>
                  <div className="mb-1.5 flex items-center gap-2">
                    <span className={["text-[11px] font-semibold uppercase tracking-wide", sbsResult.ok ? "text-sky-300" : "text-rose-300"].join(" ")}>
                      {sbsResult.ok ? "Side-by-side restore complete" : "Side-by-side restore failed"}
                    </span>
                    {sbsResult.validation && (
                      <span className={[
                        "rounded px-1.5 py-0.5 text-[9px] uppercase tracking-wide",
                        sbsResult.validation.status === "green" ? "bg-emerald-500/20 text-emerald-300"
                        : sbsResult.validation.status === "amber" ? "bg-amber-500/20 text-amber-300"
                        : "bg-rose-500/20 text-rose-300",
                      ].join(" ")}>
                        validation {sbsResult.validation.status}
                      </span>
                    )}
                  </div>
                  {sbsResult.ok ? (
                    <div className="space-y-1 text-[11px] text-neutral-400">
                      <div>Restored to: <span className="font-mono text-neutral-200 break-all">{sbsResult.targetPath}</span></div>
                      <div className="mt-1.5 text-sky-300/70 italic">{sbsResult.recommendation}</div>
                    </div>
                  ) : (
                    <div className="text-[11px] text-rose-300">{sbsResult.error}</div>
                  )}
                </div>
              )}
            </div>

            {/* Footer */}
            <div className="flex items-center justify-end gap-2 border-t border-neutral-800 px-5 py-3">
              <button
                onClick={() => { setShowRestorePlanModal(false); setRestorePlan(null); setSbsResult(null); }}
                className="rounded bg-neutral-700 px-3 py-1.5 text-xs hover:bg-neutral-600"
              >
                {sbsResult?.ok ? "Close" : "Cancel"}
              </button>
              {restoreMode === "in_place" ? (
                <>
                  <button
                    onClick={async () => {
                      setShowRestorePlanModal(false);
                      setRestorePlan(null);
                      await openBackupContent(restorePlan.backup.fileName);
                      setShowRestoreConfirm(true);
                    }}
                    className="rounded border border-amber-400/30 bg-amber-500/15 px-3 py-1.5 text-xs text-amber-300 hover:bg-amber-500/25"
                  >
                    Restore
                  </button>
                  {selectedFile.applyStrategy && (
                    <button
                      onClick={async () => {
                        setShowRestorePlanModal(false);
                        setRestorePlan(null);
                        await openBackupContent(restorePlan.backup.fileName);
                        setShowRestoreApplyConfirm(true);
                      }}
                      className="rounded border border-blue-400/30 bg-blue-500/15 px-3 py-1.5 text-xs text-blue-300 hover:bg-blue-500/25"
                    >
                      Restore & Apply
                    </button>
                  )}
                </>
              ) : (
                <button
                  onClick={performSideBySideRestore}
                  disabled={sbsLoading || sbsResult?.ok}
                  className="rounded border border-sky-400/30 bg-sky-500/15 px-3 py-1.5 text-xs text-sky-300 hover:bg-sky-500/25 disabled:opacity-40"
                >
                  {sbsLoading ? "Restoring…" : sbsResult?.ok ? "Restored" : "Restore Side-by-Side"}
                </button>
              )}
            </div>

          </div>
        </div>
      )}

      {/* Prune backups modal */}
      {showPruneModal && selectedFile && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4">
          <div className="flex w-[min(96vw,560px)] flex-col rounded-xl border border-rose-400/25 bg-neutral-900 shadow-2xl">

            {/* Header */}
            <div className="flex items-center justify-between border-b border-neutral-800 px-5 py-4">
              <div>
                <div className="font-semibold">Prune Backups</div>
                <div className="mt-0.5 text-xs text-neutral-500">{selectedFile.label} · {selectedFile.id}</div>
              </div>
              <button
                onClick={() => { setShowPruneModal(false); setPrunePreview(null); setPruneResult(null); }}
                className="text-xs text-neutral-400 hover:text-white"
              >
                Close
              </button>
            </div>

            <div className="overflow-y-auto px-5 py-4 space-y-4">

              {/* Result banner */}
              {pruneResult && (
                <div className="rounded-lg border border-emerald-400/25 bg-emerald-500/10 px-4 py-3">
                  <div className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-emerald-300">Prune complete</div>
                  <div className="flex gap-4 text-sm">
                    <span className="text-rose-300">{pruneResult.summary.deletedCount} deleted</span>
                    <span className="text-neutral-400">{pruneResult.summary.protectedCount} protected</span>
                  </div>
                </div>
              )}

              {/* Controls */}
              {!pruneResult && (
                <>
                  <div>
                    <div className="mb-2 text-[10px] uppercase tracking-wide text-neutral-500">Mode</div>
                    <div className="flex gap-2">
                      <button
                        onClick={() => { setPruneMode("count"); setPrunePreview(null); }}
                        className={["rounded-lg border px-3 py-1.5 text-xs transition", pruneMode === "count" ? "border-rose-400/30 bg-rose-500/15 text-rose-300" : "border-neutral-700 bg-neutral-800/60 text-neutral-400 hover:text-neutral-200"].join(" ")}
                      >
                        Keep newest N
                      </button>
                      <button
                        onClick={() => { setPruneMode("age"); setPrunePreview(null); }}
                        className={["rounded-lg border px-3 py-1.5 text-xs transition", pruneMode === "age" ? "border-rose-400/30 bg-rose-500/15 text-rose-300" : "border-neutral-700 bg-neutral-800/60 text-neutral-400 hover:text-neutral-200"].join(" ")}
                      >
                        Delete older than X days
                      </button>
                    </div>
                  </div>

                  <div>
                    {pruneMode === "count" ? (
                      <div className="flex items-center gap-3">
                        <label className="text-xs text-neutral-400 shrink-0">Keep newest</label>
                        <input
                          type="number"
                          min="0"
                          value={pruneKeepCount}
                          onChange={(e) => { setPruneKeepCount(Math.max(0, parseInt(e.target.value) || 0)); setPrunePreview(null); }}
                          className="w-20 rounded border border-neutral-700 bg-neutral-800/80 px-2 py-1 text-sm text-neutral-200 outline-none focus:border-rose-400/40"
                        />
                        <span className="text-xs text-neutral-500">backups per file</span>
                      </div>
                    ) : (
                      <div className="flex items-center gap-3">
                        <label className="text-xs text-neutral-400 shrink-0">Delete older than</label>
                        <input
                          type="number"
                          min="1"
                          value={pruneDays}
                          onChange={(e) => { setPruneDays(Math.max(1, parseInt(e.target.value) || 1)); setPrunePreview(null); }}
                          className="w-20 rounded border border-neutral-700 bg-neutral-800/80 px-2 py-1 text-sm text-neutral-200 outline-none focus:border-rose-400/40"
                        />
                        <span className="text-xs text-neutral-500">days</span>
                      </div>
                    )}
                  </div>

                  <button
                    onClick={fetchPrunePreview}
                    disabled={pruneLoading}
                    className="rounded-lg border border-neutral-700 bg-neutral-800/80 px-4 py-1.5 text-xs text-neutral-300 hover:border-rose-400/30 hover:text-rose-300 disabled:opacity-40"
                  >
                    {pruneLoading ? "Computing…" : "Preview"}
                  </button>
                </>
              )}

              {/* Preview results */}
              {prunePreview && !pruneResult && (
                <div className="space-y-3">
                  {/* Candidates */}
                  <div>
                    <div className="mb-1.5 flex items-center gap-2">
                      <span className="text-[10px] uppercase tracking-wide text-rose-400/80">
                        Will prune ({prunePreview.summary.candidateCount})
                      </span>
                    </div>
                    {prunePreview.candidates.length === 0 ? (
                      <div className="text-xs text-neutral-500">Nothing to prune.</div>
                    ) : (
                      <div className="space-y-0.5 max-h-40 overflow-y-auto rounded-lg border border-rose-400/15 bg-rose-500/5 px-3 py-2">
                        {prunePreview.candidates.map((c) => (
                          <div key={c.fileName} className="flex items-center justify-between gap-2 text-[11px]">
                            <span className="truncate text-neutral-300 font-mono">{c.createdAt.slice(0, 19).replace("T", " ")}</span>
                            <span className="shrink-0 text-rose-400/70">{c.reason}</span>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>

                  {/* Protected */}
                  {prunePreview.protected.filter((p) => p.reason !== "within-policy").length > 0 && (
                    <div>
                      <div className="mb-1.5 text-[10px] uppercase tracking-wide text-neutral-500">
                        Protected ({prunePreview.protected.filter((p) => p.reason !== "within-policy").length} trust-guarded)
                      </div>
                      <div className="space-y-0.5 max-h-32 overflow-y-auto rounded-lg border border-neutral-800 bg-neutral-900/60 px-3 py-2">
                        {prunePreview.protected.filter((p) => p.reason !== "within-policy").map((p) => (
                          <div key={p.fileName} className="flex items-center justify-between gap-2 text-[11px]">
                            <span className="truncate text-neutral-400 font-mono">{p.createdAt.slice(0, 19).replace("T", " ")}</span>
                            <span className={["shrink-0 rounded px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wide", p.reason === "known-good" ? "bg-emerald-500/15 text-emerald-300" : "bg-sky-500/15 text-sky-300"].join(" ")}>
                              {p.reason === "known-good" ? "LKG" : `Label: ${p.label}`}
                            </span>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}
                </div>
              )}

            </div>

            {/* Footer */}
            <div className="flex items-center justify-between border-t border-neutral-800 px-5 py-3">
              <div className="text-[11px] text-neutral-600">
                LKG and labeled backups are always preserved.
              </div>
              <div className="flex gap-2">
                <button
                  onClick={() => { setShowPruneModal(false); setPrunePreview(null); setPruneResult(null); }}
                  className="rounded bg-neutral-700 px-3 py-1.5 text-xs hover:bg-neutral-600"
                >
                  {pruneResult ? "Close" : "Cancel"}
                </button>
                {prunePreview && !pruneResult && prunePreview.candidates.length > 0 && (
                  <button
                    onClick={executePrune}
                    disabled={pruneLoading}
                    className="rounded bg-rose-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-rose-500 disabled:opacity-40"
                  >
                    {pruneLoading ? "Pruning…" : `Confirm Prune (${prunePreview.summary.candidateCount})`}
                  </button>
                )}
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

      {/* Workspace modal */}
      {workspaceModal}

      {/* DNS record modal */}
      {dnsModal}

      {/* File register modal */}
      {registerFileModal}

      {/* Service registry modal */}
      {serviceModal}
    </div>
  );
}

export default function PrivateNexusV1Mockup() {
  const API_BASE = "";
  const [authUser, setAuthUser] = useState(null);
  const [authChecked, setAuthChecked] = useState(false);
  const [authed, setAuthed] = useState(false);

  useEffect(() => {
    fetch(`${API_BASE}/api/auth/me`)
      .then((r) => {
        if (r.status === 401) { setAuthChecked(true); return null; }
        return r.json();
      })
      .then((data) => {
        if (data) { setAuthUser(data); setAuthed(true); }
        setAuthChecked(true);
      })
      .catch(() => setAuthChecked(true));
  }, []);

  if (!authChecked) {
    return (
      <div className="flex h-screen items-center justify-center bg-neutral-950">
        <div className="flex flex-col items-center gap-3">
          <div className="h-8 w-8 rounded-full border-2 border-cyan-400/30 border-t-cyan-400 animate-spin" />
          <span className="text-xs text-neutral-600 tracking-widest uppercase">Authenticating</span>
        </div>
      </div>
    );
  }

  if (!authed) {
    return (
      <div className="flex h-screen flex-col items-center justify-center bg-neutral-950 px-6">
        <div className="w-full max-w-sm">
          {/* Logo / wordmark */}
          <div className="mb-10 text-center">
            <div className="mb-3 inline-flex h-14 w-14 items-center justify-center rounded-2xl bg-gradient-to-br from-cyan-500/20 to-blue-500/10 border border-cyan-400/20 text-2xl shadow-[0_0_30px_rgba(34,211,238,0.1)]">
              🔐
            </div>
            <div className="text-xl font-bold tracking-tight text-neutral-100">PrivateNexus</div>
            <div className="mt-1 text-xs text-neutral-500 tracking-widest uppercase">House of Trae — Secure Operations</div>
          </div>

          {/* Sign-in card */}
          <div className="rounded-2xl border border-neutral-800 bg-neutral-900/80 p-6 backdrop-blur">
            <div className="mb-1 text-sm font-semibold text-neutral-200">Welcome back</div>
            <div className="mb-6 text-xs text-neutral-500">Sign in with your HoT account to continue.</div>
            <a
              href="/api/auth/login"
              className="flex w-full items-center justify-center gap-2 rounded-xl bg-gradient-to-r from-cyan-500 to-blue-500 px-4 py-2.5 text-sm font-semibold text-white shadow-[0_0_20px_rgba(34,211,238,0.2)] transition hover:shadow-[0_0_30px_rgba(34,211,238,0.35)] hover:opacity-90"
            >
              <span>Sign in with SSO</span>
              <span className="text-base">→</span>
            </a>
          </div>

          <div className="mt-6 text-center text-[10px] text-neutral-700 tracking-wider uppercase">
            Secured by Keycloak · SecureNexus realm
          </div>
        </div>
      </div>
    );
  }

  return React.createElement(ErrorBoundary, null, React.createElement(PrivateNexusDashboard, { authUser }));
}
