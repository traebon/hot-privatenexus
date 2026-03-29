import React, { useEffect, useMemo, useRef, useState } from "react";

export default function PrivateNexusV1Mockup() {
  const API_BASE = import.meta.env.VITE_API_URL || "http://127.0.0.1:3001";

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
  const [backupData, setBackupData] = useState(null);
  const [networkData, setNetworkData] = useState(null);
  const [metricsData, setMetricsData] = useState({ cpu: [], memory: [], storage: [], network: [], stats: null, collectedAt: null });
  const [metricsError, setMetricsError] = useState(false);
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

  useEffect(() => {
    fetch(`${API_BASE}/api/files`)
      .then((res) => res.json())
      .then((data) => {
        setFilesData(Array.isArray(data) ? data : []);
        setFilesError("");
      })
      .catch(() => setFilesError("Failed to load file registry"));
    loadAllApplyLog();
  }, [API_BASE]);

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
  const user = { name: "Trae", role: "Superadmin", realm: "PrivateNexus" };

  const announcements = [
    { title: "Major system error", level: "critical" },
    { title: "Updates available", level: "warning" },
    { title: "Backup OK", level: "info" },
  ];

  const boards = ["Home", "Ops", "Admin", "Stacks", "Files", "Emergency"];

  const boardThemes = {
    Home:      { active: "from-cyan-400 to-blue-500",    ring: "border-cyan-400/30",    hover: "hover:border-cyan-400/30",    shell: "from-cyan-500/10 to-blue-500/5" },
    Ops:       { active: "from-emerald-400 to-green-500", ring: "border-emerald-400/30", hover: "hover:border-emerald-400/30", shell: "from-emerald-500/10 to-green-500/5" },
    Admin:     { active: "from-purple-400 to-indigo-500", ring: "border-purple-400/30",  hover: "hover:border-purple-400/30",  shell: "from-purple-500/10 to-indigo-500/5" },
    Stacks:    { active: "from-amber-400 to-orange-500",  ring: "border-amber-400/30",   hover: "hover:border-amber-400/30",   shell: "from-amber-500/10 to-orange-500/5" },
    Files:     { active: "from-rose-400 to-pink-500",     ring: "border-rose-400/30",    hover: "hover:border-rose-400/30",    shell: "from-rose-500/10 to-pink-500/5" },
    Emergency: { active: "from-rose-400 to-pink-500",     ring: "border-rose-400/30",    hover: "hover:border-rose-400/30",    shell: "from-rose-500/10 to-pink-500/5" },
  };

  const theme = boardThemes[activeBoard];

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
    cpu:     metricsData.cpu,
    memory:  metricsData.memory,
    storage: metricsData.storage,
    network: metricsData.network,
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
          <div className="mt-1 text-xs text-neutral-400">{networkData?.lastChange || "—"}</div>
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
                    ? `bg-gradient-to-r text-black shadow ${boardThemes[board].active}`
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

          {/* Ops — real system metrics */}
          {activeBoard === "Ops" && (
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
          )}

          {/* Admin */}
          {activeBoard === "Admin" && (
            adminView === "backup"  ? backupPanel  :
            adminView === "network" ? networkPanel :
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
                  disabled={!fileDirty}
                  className="rounded-lg border border-rose-400/20 bg-rose-500/10 px-3 py-1 text-[11px] text-rose-300 hover:bg-rose-500/20 disabled:opacity-40"
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
                  disabled={selectedFile.validatable && (fileValidation === null || fileValidation.status === "red")}
                  title={
                    selectedFile.validatable && fileValidation === null
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
                      fileDirty ||
                      (selectedFile.validatable && fileValidation?.status === "red")
                    }
                    title={
                      fileDirty
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
                <div className={["mb-1.5 text-[11px] font-semibold uppercase tracking-wide", fileApplyResult.ok ? "text-blue-300" : "text-rose-300"].join(" ")}>
                  {fileApplyResult.ok ? `Applied · ${fileApplyResult.action}` : `Apply failed · ${fileApplyResult.action || "error"}`}
                </div>
                <pre className="whitespace-pre-wrap font-mono text-[10px] text-neutral-400">{fileApplyResult.output}</pre>
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

            <textarea
              value={fileEditorContent}
              onChange={(e) => { setFileEditorContent(e.target.value); setFileDirty(true); setFileValidation(null); }}
              className="min-h-0 flex-1 resize-none rounded-xl border border-neutral-800 bg-neutral-950/80 p-4 font-mono text-xs leading-6 text-neutral-200 outline-none focus:border-rose-400/30"
              spellCheck={false}
            />
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
