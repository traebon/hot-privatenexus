import React, { useEffect, useMemo, useRef, useState } from "react";

class ErrorBoundary extends React.Component {
  constructor(props) { super(props); this.state = { error: null }; }
  static getDerivedStateFromError(e) { return { error: e }; }
  render() {
    if (this.state.error) {
      // Never expose stack traces in production — they leak internal file paths and component tree.
      const isDev = typeof import.meta !== 'undefined' && import.meta.env?.DEV;
      return React.createElement('div', {
        style: { padding: 32, color: '#f87171', fontFamily: 'monospace', background: '#111', minHeight: '100vh' }
      }, React.createElement('h2', null, 'Something went wrong'),
         React.createElement('p', null, 'An unexpected error occurred. Please refresh the page or contact support.'),
         isDev && React.createElement('pre', { style: { marginTop: 16, fontSize: 12, opacity: 0.7 } },
           String(this.state.error?.stack || this.state.error?.message || this.state.error)));
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

    // Action confirmation modal state
    const [pendingConfirm, setPendingConfirm] = useState(null); // { containerId, containerName, action, serviceId, serviceName }
    // Blast-radius follow-up modal — shown when /run/v2 reports hard downstream dependencies
    const [blastConfirm, setBlastConfirm] = useState(null); // { containerId, containerName, action, serviceId, hardDeps, affected }
    const [actionInfo, setActionInfo] = useState(null); // non-error status, e.g. "queued for approval"

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

    const runAction = async (containerId, action, { serviceId, containerName, force } = {}) => {
      const key = `${containerId}:${action}`;
      setActionPending(key);
      setActionError(null);
      setActionInfo(null);
      try {
        const res = await fetch(`${API_BASE}/api/actions/run/v2`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action, containerId, service_id: serviceId || undefined, force: !!force }),
        });
        const data = await res.json();

        if (res.status === 409 && data.blast_radius) {
          // Hard downstream dependencies found — let the operator see them and force through if intended.
          setBlastConfirm({ containerId, containerName, action, serviceId, hardDeps: data.hard_deps, affected: data.affected });
          return;
        }
        if (res.status === 202 && data.queued) {
          setActionInfo(`${action} on ${containerName || containerId} requires approval — queued (request #${data.requestId}).`);
          return;
        }
        if (!res.ok) {
          setActionError(`${action} failed: ${data.error}`);
          return;
        }
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
      <>
      {/* Action confirmation modal for Restart / Stop / Start */}
      {pendingConfirm && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4">
          <div className="w-full max-w-sm rounded-2xl border border-amber-400/20 bg-neutral-950 shadow-2xl">
            <div className="flex items-center justify-between border-b border-neutral-800 px-6 py-4">
              <div className="text-base font-semibold capitalize">{pendingConfirm.action} Container</div>
              <button onClick={() => setPendingConfirm(null)} className="text-neutral-500 hover:text-white text-lg">✕</button>
            </div>
            <div className="px-6 py-4 space-y-2 text-sm text-neutral-400">
              <div className="font-mono text-neutral-200">{pendingConfirm.containerName}</div>
              <div>{pendingConfirm.action === "restart" ? "This will restart the container. Active connections will be dropped briefly." : pendingConfirm.action === "stop" ? "This will stop the container. The service will be unavailable until manually started." : "This will start the container."}</div>
              {(pendingConfirm.action === "stop" || pendingConfirm.action === "restart") && (
                pendingConfirm.serviceId ? (
                  <div className="rounded-lg border border-orange-400/20 bg-orange-500/5 px-3 py-2 text-xs text-orange-300/80">
                    <span className="font-medium">Blast-radius check:</span> the server will verify downstream dependencies for "{pendingConfirm.serviceName}" before executing. If hard dependencies are affected, you'll be asked to confirm again.
                  </div>
                ) : (
                  <div className="rounded-lg border border-neutral-700 bg-neutral-800/40 px-3 py-2 text-xs text-neutral-400">
                    This container isn't linked to a registered service, so no dependency check is possible — approve it in Discovery to enable blast-radius protection.
                  </div>
                )
              )}
              <div className="rounded-lg border border-amber-400/20 bg-amber-500/10 px-3 py-2 text-xs text-amber-300">
                This action will be recorded in the audit log.
              </div>
            </div>
            <div className="flex justify-end gap-2 border-t border-neutral-800 px-6 py-4">
              <button onClick={() => setPendingConfirm(null)}
                className="rounded-lg border border-neutral-700 px-4 py-2 text-xs text-neutral-400 hover:text-white">Cancel</button>
              <button
                onClick={() => { const { containerId, containerName, action, serviceId } = pendingConfirm; setPendingConfirm(null); runAction(containerId, action, { serviceId, containerName }); }}
                className={["rounded-lg border px-4 py-2 text-xs",
                  pendingConfirm.action === "stop"    ? "border-rose-400/30 bg-rose-500/10 text-rose-300 hover:bg-rose-500/20" :
                  pendingConfirm.action === "restart" ? "border-amber-400/30 bg-amber-500/10 text-amber-300 hover:bg-amber-500/20" :
                  "border-emerald-400/30 bg-emerald-500/10 text-emerald-300 hover:bg-emerald-500/20"].join(" ")}>
                Confirm {pendingConfirm.action}
              </button>
            </div>
          </div>
        </div>
      )}
      {/* Blast-radius follow-up modal — shown when /run/v2 finds hard downstream dependencies */}
      {blastConfirm && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4">
          <div className="w-full max-w-md rounded-2xl border border-rose-400/30 bg-neutral-950 shadow-2xl">
            <div className="flex items-center justify-between border-b border-neutral-800 px-6 py-4">
              <div className="text-base font-semibold text-rose-300">Hard dependencies affected</div>
              <button onClick={() => setBlastConfirm(null)} className="text-neutral-500 hover:text-white text-lg">✕</button>
            </div>
            <div className="px-6 py-4 space-y-2 text-sm text-neutral-400">
              <div>
                {blastConfirm.hardDeps} service{blastConfirm.hardDeps === 1 ? "" : "s"} depend{blastConfirm.hardDeps === 1 ? "s" : ""} hard on
                {" "}<span className="font-mono text-neutral-200">{blastConfirm.containerName}</span> and will likely break if you {blastConfirm.action} it:
              </div>
              <ul className="space-y-1 rounded-lg border border-neutral-800 bg-neutral-900/60 px-3 py-2 text-xs">
                {(blastConfirm.affected || []).map((dep, i) => (
                  <li key={i} className="flex items-center justify-between">
                    <span className="font-mono text-neutral-300">{dep.name}</span>
                    <span className="text-neutral-500">{dep.dep_type} · {dep.status}</span>
                  </li>
                ))}
              </ul>
            </div>
            <div className="flex justify-end gap-2 border-t border-neutral-800 px-6 py-4">
              <button onClick={() => setBlastConfirm(null)}
                className="rounded-lg border border-neutral-700 px-4 py-2 text-xs text-neutral-400 hover:text-white">Cancel</button>
              <button
                onClick={() => { const { containerId, containerName, action, serviceId } = blastConfirm; setBlastConfirm(null); runAction(containerId, action, { serviceId, containerName, force: true }); }}
                className="rounded-lg border border-rose-400/30 bg-rose-500/10 px-4 py-2 text-xs text-rose-300 hover:bg-rose-500/20">
                {blastConfirm.action} anyway
              </button>
            </div>
          </div>
        </div>
      )}
      {actionInfo && (
        <div className="fixed bottom-4 right-4 z-50 max-w-sm rounded-lg border border-sky-400/30 bg-sky-500/10 px-4 py-3 text-xs text-sky-300 shadow-xl">
          <div className="flex items-start justify-between gap-3">
            <span>{actionInfo}</span>
            <button onClick={() => setActionInfo(null)} className="text-sky-400/70 hover:text-white">✕</button>
          </div>
        </div>
      )}
      {/* Recovery playbook — triggered contextually from Intelligence signals/proposals */}
      {incidentPlan && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4">
          <div className="max-h-[85vh] w-full max-w-lg overflow-y-auto rounded-2xl border border-sky-400/30 bg-neutral-950 shadow-2xl">
            <div className="sticky top-0 flex items-center justify-between border-b border-neutral-800 bg-neutral-950 px-6 py-4">
              <div className="text-base font-semibold text-sky-300">
                {incidentPlan.ok ? incidentPlan.playbook.title : "Recovery Plan"}
              </div>
              <button onClick={() => setIncidentPlan(null)} className="text-neutral-500 hover:text-white text-lg">✕</button>
            </div>
            {!incidentPlan.ok && (
              <div className="px-6 py-4 text-sm text-rose-300">{incidentPlan.error}</div>
            )}
            {incidentPlan.ok && (
              <div className="space-y-3 px-6 py-4 text-sm">
                <div className="text-xs text-neutral-400">{incidentPlan.playbook.incident_summary}</div>
                <div className="flex gap-3 text-xs">
                  <span className="rounded-lg border border-sky-400/20 bg-sky-500/10 px-2 py-1 text-sky-300">
                    Est. RTO: {incidentPlan.playbook.summary.estimated_rto_min ?? "—"} min
                  </span>
                  <span className="rounded-lg border border-neutral-700 bg-neutral-800/60 px-2 py-1 text-neutral-400">
                    {incidentPlan.playbook.summary.dependencies_in_scope} dependenc{incidentPlan.playbook.summary.dependencies_in_scope === 1 ? "y" : "ies"} in scope
                  </span>
                </div>
                {incidentPlan.playbook.summary.blockers?.length > 0 && (
                  <div className="rounded-lg border border-rose-400/30 bg-rose-500/10 px-3 py-2 text-xs text-rose-300">
                    {incidentPlan.playbook.summary.blockers.map((b, i) => <div key={i}>⚠ {b}</div>)}
                  </div>
                )}
                <div className="space-y-2">
                  {incidentPlan.playbook.sections.map(step => (
                    <div key={step.step} className={`rounded-lg border p-3 ${step.is_target ? "border-sky-400/30 bg-sky-500/5" : "border-neutral-700/50 bg-neutral-800/40"}`}>
                      <div className="flex items-center justify-between gap-2">
                        <div className="flex items-center gap-2">
                          <span className="rounded bg-neutral-800/80 px-1.5 py-0.5 text-xs text-neutral-400">Step {step.step}</span>
                          <span className="text-sm font-medium">{step.service_name}</span>
                          {step.is_target && <span className="rounded bg-sky-500/20 px-1.5 py-0.5 text-xs text-sky-300">Target</span>}
                        </div>
                        {step.rto_min != null && <span className="text-xs text-neutral-500">~{step.rto_min}min</span>}
                      </div>
                      {step.backup_source && (
                        <div className="mt-1 text-xs text-neutral-500">Backup: {step.backup_source}</div>
                      )}
                      <ul className="mt-2 space-y-0.5 text-xs text-neutral-400">
                        {step.instructions.map((instr, i) => <li key={i}>• {instr}</li>)}
                      </ul>
                      {step.runbook_url && (
                        <a href={step.runbook_url} target="_blank" rel="noreferrer" className="mt-1 inline-block text-xs text-sky-400 hover:underline">
                          Open runbook →
                        </a>
                      )}
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        </div>
      )}
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
                              onClick={() => setPendingConfirm({ containerId: c.id, containerName: c.name || c.id, action: "restart", serviceId: c.serviceId, serviceName: c.serviceName })}
                              className="rounded-lg border border-amber-400/20 bg-amber-500/10 px-2 py-1 text-[10px] text-amber-300 hover:bg-amber-500/20 disabled:cursor-not-allowed disabled:opacity-40"
                            >
                              {actionPending === `${c.id}:restart` ? "…" : "Restart"}
                            </button>
                            <button
                              disabled={!!actionPending || !can("operator")}
                              title={!can("operator") ? "Requires operator role" : undefined}
                              onClick={() => setPendingConfirm({ containerId: c.id, containerName: c.name || c.id, action: "stop", serviceId: c.serviceId, serviceName: c.serviceName })}
                              className="rounded-lg border border-rose-400/20 bg-rose-500/10 px-2 py-1 text-[10px] text-rose-300 hover:bg-rose-500/20 disabled:cursor-not-allowed disabled:opacity-40"
                            >
                              {actionPending === `${c.id}:stop` ? "…" : "Stop"}
                            </button>
                          </>
                        ) : (
                          <button
                            disabled={!!actionPending || !can("operator")}
                            title={!can("operator") ? "Requires operator role" : undefined}
                            onClick={() => setPendingConfirm({ containerId: c.id, containerName: c.name || c.id, action: "start", serviceId: c.serviceId, serviceName: c.serviceName })}
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
      </>
    );
  }

  // -------------------------------------------------------------------------
  // Inner component — SuperAdmin console (tenant management), superadmin-only.
  // Self-contained like StacksBoard: /api/tenants itself is role-gated server
  // side, so this checks can("superadmin") up front rather than gating each
  // action individually the way the Admin board does.
  // -------------------------------------------------------------------------
  function SuperAdminBoard() {
    const [tenants, setTenants] = useState([]);
    const [loading, setLoading] = useState(true);
    const [loadError, setLoadError] = useState(false);

    const [expandedId, setExpandedId] = useState(null);
    const [members, setMembers] = useState({}); // tenantId -> members[]
    const [membersLoading, setMembersLoading] = useState(false);

    const [showCreateModal, setShowCreateModal] = useState(false);
    const [createForm, setCreateForm] = useState({ name: "", slug: "" });
    const [createSaving, setCreateSaving] = useState(false);
    const [createError, setCreateError] = useState(null);

    const [addMemberForm, setAddMemberForm] = useState({ user_sub: "", role: "member" });
    const [addMemberSaving, setAddMemberSaving] = useState(false);
    const [addMemberError, setAddMemberError] = useState(null);

    const loadTenants = async () => {
      try {
        const res = await fetch(`${API_BASE}/api/tenants`);
        if (!res.ok) { setLoadError(true); return; }
        const data = await res.json();
        setTenants(data.tenants || []);
        setLoadError(false);
      } catch {
        setLoadError(true);
      } finally {
        setLoading(false);
      }
    };

    useEffect(() => {
      if (!can("superadmin")) { setLoading(false); return; }
      loadTenants();
      const interval = setInterval(loadTenants, 30000);
      return () => clearInterval(interval);
    }, []);

    const loadMembers = async (tenantId) => {
      setMembersLoading(true);
      try {
        const res = await fetch(`${API_BASE}/api/tenants/${tenantId}/members`);
        const data = await res.json();
        setMembers((m) => ({ ...m, [tenantId]: data.members || [] }));
      } catch {
        /* leave stale/absent — row still shows its last-known members */
      } finally {
        setMembersLoading(false);
      }
    };

    const toggleExpand = (tenantId) => {
      if (expandedId === tenantId) { setExpandedId(null); return; }
      setExpandedId(tenantId);
      if (!members[tenantId]) loadMembers(tenantId);
    };

    const createTenant = async () => {
      setCreateSaving(true);
      setCreateError(null);
      try {
        const res = await fetch(`${API_BASE}/api/tenants`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(createForm),
        });
        const data = await res.json();
        if (!res.ok) { setCreateError(data.error || "Failed to create tenant"); return; }
        setShowCreateModal(false);
        setCreateForm({ name: "", slug: "" });
        await loadTenants();
      } catch (err) {
        setCreateError(err.message);
      } finally {
        setCreateSaving(false);
      }
    };

    const addMember = async (tenantId) => {
      setAddMemberSaving(true);
      setAddMemberError(null);
      try {
        const res = await fetch(`${API_BASE}/api/tenants/${tenantId}/members`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(addMemberForm),
        });
        const data = await res.json();
        if (!res.ok) { setAddMemberError(data.error || "Failed to add member"); return; }
        setAddMemberForm({ user_sub: "", role: "member" });
        await loadMembers(tenantId);
        await loadTenants();
      } catch (err) {
        setAddMemberError(err.message);
      } finally {
        setAddMemberSaving(false);
      }
    };

    const removeMember = async (tenantId, userSub) => {
      try {
        await fetch(`${API_BASE}/api/tenants/${tenantId}/members/${encodeURIComponent(userSub)}`, { method: "DELETE" });
        await loadMembers(tenantId);
        await loadTenants();
      } catch {
        /* row stays as-is; user can retry */
      }
    };

    if (!can("superadmin")) {
      return (
        <div className="rounded-2xl border border-purple-400/20 bg-neutral-900/70 p-8 text-center">
          <div className="text-sm text-neutral-400">
            SuperAdmin console requires the <span className="font-semibold text-purple-300">superadmin</span> role.
          </div>
        </div>
      );
    }

    return (
      <div className="space-y-4">
        <div className="flex items-center justify-between">
          <div>
            <div className="text-xs uppercase tracking-wider text-purple-300/80">System</div>
            <div className="text-lg font-semibold">SuperAdmin — Tenants</div>
          </div>
          <button
            onClick={() => setShowCreateModal(true)}
            className="rounded-lg border border-purple-400/30 bg-purple-500/10 px-3 py-1 text-xs text-purple-300 hover:bg-purple-500/20"
          >
            + New Tenant
          </button>
        </div>

        {loadError && (
          <div className="rounded-lg bg-rose-500/15 px-3 py-2 text-xs text-rose-300">Failed to load tenants — is /api/tenants reachable?</div>
        )}
        {loading && <div className="text-xs text-neutral-600">Loading…</div>}

        <div className="space-y-2">
          {tenants.map((t) => {
            const isExpanded = expandedId === t.id;
            const healthPct = t.service_count > 0 ? Math.round((t.healthy_count / t.service_count) * 100) : null;
            return (
              <div key={t.id} className="overflow-hidden rounded-xl border border-neutral-800 bg-neutral-900/70">
                <div
                  onClick={() => toggleExpand(t.id)}
                  className="flex cursor-pointer items-center justify-between px-4 py-3 hover:bg-neutral-800/40"
                >
                  <div>
                    <div className="flex items-center gap-2">
                      <span className="text-sm font-semibold text-neutral-200">{t.name}</span>
                      <span className="font-mono text-[11px] text-neutral-500">{t.slug}</span>
                    </div>
                    <div className="mt-0.5 text-[11px] text-neutral-500">
                      {t.member_count} member{t.member_count === 1 ? "" : "s"} · {t.service_count} service{t.service_count === 1 ? "" : "s"}
                      {t.last_activity_at ? <> · last activity {new Date(t.last_activity_at).toLocaleString()}</> : <> · no activity yet</>}
                    </div>
                  </div>
                  <div className="flex items-center gap-3">
                    {t.service_count > 0 ? (
                      <span
                        className={[
                          "rounded-full border px-2 py-0.5 text-[10px] font-semibold",
                          healthPct === 100 ? "border-emerald-400/40 bg-emerald-500/10 text-emerald-300"
                            : healthPct >= 50 ? "border-amber-400/40 bg-amber-500/10 text-amber-300"
                            : "border-rose-400/40 bg-rose-500/10 text-rose-300",
                        ].join(" ")}
                      >
                        {t.healthy_count}/{t.service_count} healthy
                      </span>
                    ) : (
                      <span className="rounded-full border border-neutral-700 bg-neutral-800/60 px-2 py-0.5 text-[10px] text-neutral-500">no services</span>
                    )}
                    <span className={["text-[10px] transition-transform", isExpanded ? "rotate-90" : ""].join(" ")}>▸</span>
                  </div>
                </div>

                {isExpanded && (
                  <div className="space-y-3 border-t border-neutral-800 bg-neutral-950/40 px-4 py-3">
                    <div className="text-[10px] uppercase tracking-wide text-neutral-500">Members</div>
                    {membersLoading && !members[t.id] && <div className="text-xs text-neutral-600">Loading members…</div>}
                    <div className="space-y-1">
                      {(members[t.id] || []).map((m) => (
                        <div key={m.id} className="flex items-center justify-between rounded-lg bg-neutral-900/70 px-3 py-1.5">
                          <div className="font-mono text-[11px] text-neutral-300">{m.user_sub}</div>
                          <div className="flex items-center gap-3">
                            <span className="text-[10px] text-neutral-500">{m.role}</span>
                            <button onClick={() => removeMember(t.id, m.user_sub)} className="text-[10px] text-neutral-500 hover:text-rose-400">
                              Remove
                            </button>
                          </div>
                        </div>
                      ))}
                      {members[t.id] && members[t.id].length === 0 && (
                        <div className="text-xs text-neutral-600">No members yet</div>
                      )}
                    </div>

                    <div className="flex items-center gap-2 pt-1">
                      <input
                        value={addMemberForm.user_sub}
                        onChange={(e) => setAddMemberForm((f) => ({ ...f, user_sub: e.target.value }))}
                        placeholder="Keycloak user sub (UUID)"
                        className="flex-1 rounded-lg border border-neutral-700 bg-neutral-900 px-3 py-1.5 text-xs font-mono text-neutral-200 focus:border-purple-400/50 focus:outline-none"
                      />
                      <select
                        value={addMemberForm.role}
                        onChange={(e) => setAddMemberForm((f) => ({ ...f, role: e.target.value }))}
                        className="rounded-lg border border-neutral-700 bg-neutral-900 px-2 py-1.5 text-xs text-neutral-200 focus:border-purple-400/50 focus:outline-none"
                      >
                        <option value="member">member</option>
                        <option value="owner">owner</option>
                      </select>
                      <button
                        onClick={() => addMember(t.id)}
                        disabled={addMemberSaving || !addMemberForm.user_sub.trim()}
                        className="rounded-lg border border-purple-400/30 bg-purple-500/10 px-3 py-1.5 text-xs text-purple-300 hover:bg-purple-500/20 disabled:opacity-50"
                      >
                        {addMemberSaving ? "Adding…" : "Add"}
                      </button>
                    </div>
                    {addMemberError && <div className="text-xs text-rose-400">{addMemberError}</div>}
                  </div>
                )}
              </div>
            );
          })}
          {!loading && !loadError && tenants.length === 0 && (
            <div className="rounded-xl border border-neutral-800 bg-neutral-900/60 p-6 text-center text-xs text-neutral-600">No tenants yet</div>
          )}
        </div>

        {showCreateModal && (
          <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4">
            <div className="w-full max-w-sm rounded-2xl border border-purple-400/20 bg-neutral-950 shadow-2xl">
              <div className="flex items-center justify-between border-b border-neutral-800 px-6 py-4">
                <div className="text-base font-semibold">New Tenant</div>
                <button onClick={() => setShowCreateModal(false)} className="text-lg text-neutral-500 hover:text-white">✕</button>
              </div>
              <div className="space-y-3 px-6 py-4 text-sm">
                <div>
                  <label className="mb-1 block text-xs text-neutral-400">Name *</label>
                  <input
                    value={createForm.name}
                    onChange={(e) =>
                      setCreateForm((f) => ({ ...f, name: e.target.value, slug: f.slug || e.target.value.toLowerCase().replace(/[^a-z0-9]+/g, "-") }))
                    }
                    placeholder="Acme Corp"
                    autoFocus
                    className="w-full rounded-lg border border-neutral-700 bg-neutral-900 px-3 py-1.5 text-sm text-neutral-200 focus:border-purple-400/50 focus:outline-none"
                  />
                </div>
                <div>
                  <label className="mb-1 block text-xs text-neutral-400">Slug</label>
                  <input
                    value={createForm.slug}
                    onChange={(e) => setCreateForm((f) => ({ ...f, slug: e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, "") }))}
                    placeholder="acme-corp"
                    className="w-full rounded-lg border border-neutral-700 bg-neutral-900 px-3 py-1.5 text-sm font-mono text-neutral-200 focus:border-purple-400/50 focus:outline-none"
                  />
                </div>
              </div>
              <div className="border-t border-neutral-800 px-6 py-4">
                {createError && <div className="mb-3 rounded-lg bg-rose-500/15 px-3 py-2 text-xs text-rose-300">{createError}</div>}
                <div className="flex justify-end gap-2">
                  <button onClick={() => setShowCreateModal(false)} className="rounded-lg border border-neutral-700 px-4 py-2 text-xs text-neutral-400 hover:text-white">
                    Cancel
                  </button>
                  <button
                    onClick={createTenant}
                    disabled={createSaving || !createForm.name.trim() || !createForm.slug.trim()}
                    className="rounded-lg border border-purple-400/30 bg-purple-500/10 px-4 py-2 text-xs text-purple-300 hover:bg-purple-500/20 disabled:opacity-50"
                  >
                    {createSaving ? "Creating…" : "Create"}
                  </button>
                </div>
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
  const [openGroups, setOpenGroups] = useState(() => new Set());
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
  // Activity feed
  const [activityEvents, setActivityEvents]       = useState([]);
  const [activityLoading, setActivityLoading]     = useState(false);
  const [activityError, setActivityError]         = useState(null);
  const [activityTotal, setActivityTotal]         = useState(null);
  const [activityMaxId, setActivityMaxId]         = useState("0");
  const [activityNewCount, setActivityNewCount]   = useState(0);
  const [activityPolling, setActivityPolling]     = useState(true);
  const [activityFilter, setActivityFilter]       = useState({ action_prefix: "", username: "", outcome: "", from_ts: "", to_ts: "", severity: "" });
  const [activityPage, setActivityPage]           = useState(0);
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
  const [maintenanceDuration, setMaintenanceDuration] = useState("1h");

  // Dependencies board
  const [depGraph, setDepGraph]               = useState({ services: [], edges: [] });
  const [depLoading, setDepLoading]           = useState(false);
  const [depError, setDepError]               = useState(null);
  const [depSelected, setDepSelected]         = useState(null);
  const [depBlast, setDepBlast]               = useState(null);
  const [depBlastLoading, setDepBlastLoading] = useState(false);
  const [depRestore, setDepRestore]           = useState(null);
  const [depRestoreLoading, setDepRestoreLoading] = useState(false);
  const [depAnalysisMode, setDepAnalysisMode] = useState("blast");
  const [showAddDepModal, setShowAddDepModal] = useState(false);
  const [addDepForm, setAddDepForm]           = useState({ upstream_id: "", downstream_id: "", dep_type: "hard", notes: "" });
  const [addDepSaving, setAddDepSaving]       = useState(false);
  const [addDepError, setAddDepError]         = useState(null);

  // Governance board
  const [govViolations, setGovViolations]       = useState([]);
  const [govSummary, setGovSummary]             = useState({ critical: 0, warning: 0, info: 0, total: 0 });
  const [govLoading, setGovLoading]             = useState(false);
  const [govError, setGovError]                 = useState(null);
  const [govTab, setGovTab]                     = useState("recommendations");
  const [govRules, setGovRules]                 = useState([]);
  const [govRuleToggling, setGovRuleToggling]   = useState(null); // rule_key
  const [govExceptions, setGovExceptions]       = useState([]);
  const [govExDeleting, setGovExDeleting]       = useState(null); // exception id
  const [govExLoading, setGovExLoading]         = useState(false);
  const [govChangeRecords, setGovChangeRecords] = useState([]);
  const [govCrLoading, setGovCrLoading]         = useState(false);
  const [govReport, setGovReport]               = useState(null);
  const [govReportLoading, setGovReportLoading] = useState(false);
  const [showAddExModal, setShowAddExModal]     = useState(null);
  const [addExForm, setAddExForm]               = useState({ reason: "", expires_at: "" });

  // Recovery board
  const [recTab, setRecTab]                       = useState("readiness");
  const [recReadiness, setRecReadiness]           = useState(null);   // { services, summary }
  const [recReadinessLoading, setRecReadinessLoading] = useState(false);
  const [recGaps, setRecGaps]                     = useState(null);   // { gaps, total }
  const [recGapsLoading, setRecGapsLoading]       = useState(false);
  const [recSimServices, setRecSimServices]       = useState([]);     // service list for simulator form
  const [recWorkspaces, setRecWorkspaces]         = useState([]);
  const [recSimForm, setRecSimForm]               = useState({ scenario_type: "service_down", target_type: "service", target_id: "" });
  const [recSimRunning, setRecSimRunning]         = useState(false);
  const [recSimResult, setRecSimResult]           = useState(null);
  const [recSimError, setRecSimError]             = useState(null);
  const [recSimHistory, setRecSimHistory]         = useState([]);
  const [recSimHistoryLoading, setRecSimHistoryLoading] = useState(false);
  const [recPlaybookService, setRecPlaybookService] = useState("");
  const [recPlaybookIncident, setRecPlaybookIncident] = useState("");
  const [recPlaybookRunning, setRecPlaybookRunning] = useState(false);
  const [recPlaybook, setRecPlaybook]             = useState(null);
  const [recPlaybookError, setRecPlaybookError]   = useState(null);
  const [recTests, setRecTests]                   = useState([]);
  const [recTestsLoading, setRecTestsLoading]     = useState(false);
  const [showAddTestModal, setShowAddTestModal]   = useState(false);
  const [addTestForm, setAddTestForm]             = useState({ service_id: "", test_type: "dry_run", outcome: "passed", rto_actual_min: "", notes: "" });
  const [addTestSaving, setAddTestSaving]         = useState(false);
  const [addTestError, setAddTestError]           = useState(null);
  const [recExpandedService, setRecExpandedService] = useState(null); // for signals detail
  const [addExSaving, setAddExSaving]           = useState(false);
  const [addExError, setAddExError]             = useState(null);
  // Approval queue
  const [actRequests, setActRequests]           = useState([]);
  const [actReqLoading, setActReqLoading]       = useState(false);
  const [actReqFilter, setActReqFilter]         = useState("pending");
  const [actReqReviewNote, setActReqReviewNote] = useState({});
  // Blast-radius confirmation modal (for Ops actions)
  const [blastModal, setBlastModal]             = useState(null); // { action, containerId, service_id, hardDeps, affected }
  // Deploy / rollback
  const [showDeployModal, setShowDeployModal]   = useState(null); // service object
  const [deployForm, setDeployForm]             = useState({ new_image: "", force: false });
  const [deploySaving, setDeploySaving]         = useState(false);
  const [deployError, setDeployError]           = useState(null);
  const [rollbackSaving, setRollbackSaving]     = useState(false);
  const [rollbackPoints, setRollbackPoints]     = useState({});

  // Intelligence board
  const [intelTab, setIntelTab]                       = useState("signals");
  const [intelSignals, setIntelSignals]               = useState(null);
  const [intelSignalsLoading, setIntelSignalsLoading] = useState(false);
  const [intelProposals, setIntelProposals]           = useState(null);
  const [intelProposalsLoading, setIntelProposalsLoading] = useState(false);
  const [intelPropFilter, setIntelPropFilter]         = useState("pending");
  const [intelPolicies, setIntelPolicies]             = useState(null);
  const [intelPoliciesLoading, setIntelPoliciesLoading] = useState(false);
  const [intelScanRunning, setIntelScanRunning]       = useState(false);
  const [intelScanResult, setIntelScanResult]         = useState(null);
  const [intelApproving, setIntelApproving]           = useState(null); // proposal id
  const [intelDismissing, setIntelDismissing]         = useState(null); // proposal id
  const [intelTogglingPolicy, setIntelTogglingPolicy] = useState(null); // policy id
  const [incidentRunning, setIncidentRunning]         = useState(null); // service id
  const [incidentPlan, setIncidentPlan]               = useState(null); // { ok, incident, restore_plan } | { ok:false, error }

  // Discovery board
  const [discCandidates, setDiscCandidates]   = useState([]);
  const [discSummary, setDiscSummary]         = useState({});
  const [discLoading, setDiscLoading]         = useState(false);
  const [discError, setDiscError]             = useState(null);
  const [discStatusFilter, setDiscStatusFilter] = useState("pending");
  const [discScanning, setDiscScanning]       = useState(false);
  const [discScanResult, setDiscScanResult]   = useState(null);
  const [discDrift, setDiscDrift]             = useState(null);
  const [discDriftLoading, setDiscDriftLoading] = useState(false);
  const [discEditId, setDiscEditId]           = useState(null);
  const [discEditForm, setDiscEditForm]       = useState({});
  const [discActionPending, setDiscActionPending] = useState(null);
  const [agentTokens, setAgentTokens]         = useState([]);
  const [agentTokensLoading, setAgentTokensLoading] = useState(false);
  const [agentTokenSaving, setAgentTokenSaving] = useState(false);
  const [agentTokenRevoking, setAgentTokenRevoking] = useState(null); // token id
  const [newTokenLabel, setNewTokenLabel]     = useState("");
  const [newTokenTTL, setNewTokenTTL]         = useState("168");
  const [createdToken, setCreatedToken]       = useState(null);
  const [agentTokensOpen, setAgentTokensOpen] = useState(false);

  // Admin panel — certs / disk / users / backup run
  const [certData, setCertData] = useState(null);
  const [certError, setCertError] = useState(false);
  const [diskData, setDiskData] = useState(null);
  const [usersData, setUsersData] = useState(null);
  const [usersMgmtData, setUsersMgmtData] = useState(null);
  const [usersMgmtLoading, setUsersMgmtLoading] = useState(false);
  const [backupRunning, setBackupRunning] = useState(false);
  const [updateCheckData, setUpdateCheckData] = useState(null);
  const [updateCheckError, setUpdateCheckError] = useState(false);
  const [updateCheckLoading, setUpdateCheckLoading] = useState(false);
  const [backupRunResult, setBackupRunResult] = useState(null);

  // Inventory / Service Registry
  const [servicesData, setServicesData] = useState([]);
  const [servicesLoading, setServicesLoading] = useState(false);
  const [servicesError, setServicesError] = useState(null);
  const [serviceGroupBy, setServiceGroupBy] = useState("category");
  const [serviceCategoryFilter, setServiceCategoryFilter] = useState("all");
  const [serviceStatusFilter, setServiceStatusFilter] = useState("all");
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
  // Service backup records + recovery score
  const [serviceBackups, setServiceBackups] = useState([]);
  const [serviceBackupsLoading, setServiceBackupsLoading] = useState(false);
  const [recoveryScore, setRecoveryScore] = useState(null);
  const [showAddBackupModal, setShowAddBackupModal] = useState(false);
  const [addBackupForm, setAddBackupForm] = useState({ label: "", backup_type: "manual", trust_state: "unknown", location: "", taken_at: "", notes: "" });
  const [addBackupSaving, setAddBackupSaving] = useState(false);
  const [addBackupError, setAddBackupError] = useState(null);
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
  const [catalogueRepository, setCatalogueRepository] = useState(null);
  const [catalogueRepoFallback, setCatalogueRepoFallback] = useState(false);
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
    if (adminView === "updates" && !updateCheckData) {
      setUpdateCheckError(false); setUpdateCheckLoading(true);
      fetch(`${API_BASE}/api/admin/update-check`)
        .then(r=>r.json())
        .then(d=>{ if(d.ok) setUpdateCheckData(d); else setUpdateCheckError(true); })
        .catch(()=>setUpdateCheckError(true))
        .finally(()=>setUpdateCheckLoading(false));
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
    if (activeBoard === "Inventory" && serviceStatusFilter !== "all") params.set("status", serviceStatusFilter);
    fetch(`${API_BASE}/api/services?${params}`)
      .then((r) => r.json())
      .then((data) => { setServicesData(Array.isArray(data) ? data : []); setServicesLoading(false); })
      .catch(() => { setServicesError("Failed to load service registry"); setServicesLoading(false); });
  }, [activeBoard, showArchivedServices, serviceCategoryFilter, serviceStatusFilter, API_BASE]);

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
      .then((d) => {
        if (!d.ok) return;
        setCatalogueApps(d.apps);
        setCatalogueRepository(d.repository);
        setCatalogueRepoFallback(!!d.repository_fallback);
      })
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

  // Governance — load recommendations + rules when board becomes active or tab changes
  useEffect(() => {
    if (activeBoard !== "Governance") return;
    setGovLoading(true); setGovError(null);
    fetch(`${API_BASE}/api/governance/recommendations`)
      .then(r => r.json())
      .then(d => { if (!d.ok) throw new Error(d.error || "Failed"); setGovViolations(d.violations || []); setGovSummary({ critical: d.violations?.filter(v=>v.severity==="critical").length||0, warning: d.violations?.filter(v=>v.severity==="warning").length||0, info: d.violations?.filter(v=>v.severity==="info").length||0, total: d.count||0 }); })
      .catch(e => setGovError(e.message))
      .finally(() => setGovLoading(false));
    fetch(`${API_BASE}/api/governance/rules`).then(r=>r.json()).then(d=>{ if(d.ok) setGovRules(d.rules||[]); }).catch(()=>{});
  }, [activeBoard]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (activeBoard !== "Governance") return;
    if (govTab === "exceptions") { setGovExLoading(true); fetch(`${API_BASE}/api/governance/exceptions`).then(r=>r.json()).then(d=>{ if(d.ok) setGovExceptions(d.exceptions||[]); }).catch(()=>{}).finally(()=>setGovExLoading(false)); }
    if (govTab === "changelog")  { setGovCrLoading(true); fetch(`${API_BASE}/api/governance/change-records`).then(r=>r.json()).then(d=>{ if(d.ok) setGovChangeRecords(d.records||[]); }).catch(()=>{}).finally(()=>setGovCrLoading(false)); }
    if (govTab === "report")     { setGovReportLoading(true); fetch(`${API_BASE}/api/governance/report`).then(r=>r.json()).then(d=>{ if(d.ok) setGovReport(d); }).catch(()=>{}).finally(()=>setGovReportLoading(false)); }
    if (govTab === "approvals")  { setActReqLoading(true); fetch(`${API_BASE}/api/actions/requests?status=${actReqFilter}`).then(r=>r.json()).then(d=>{ if(d.ok) setActRequests(d.requests||[]); }).catch(()=>{}).finally(()=>setActReqLoading(false)); }
  }, [activeBoard, govTab]); // eslint-disable-line react-hooks/exhaustive-deps

  // Recovery — load data when board or tab changes
  useEffect(() => {
    if (activeBoard !== "Recovery") return;
    if (recTab === "readiness" && !recReadiness) {
      setRecReadinessLoading(true);
      fetch(`${API_BASE}/api/recovery/readiness`).then(r=>r.json()).then(d=>{ if(d.ok) setRecReadiness(d); }).catch(()=>{}).finally(()=>setRecReadinessLoading(false));
    }
    if (recTab === "gaps" && !recGaps) {
      setRecGapsLoading(true);
      fetch(`${API_BASE}/api/recovery/gaps`).then(r=>r.json()).then(d=>{ if(d.ok) setRecGaps(d); }).catch(()=>{}).finally(()=>setRecGapsLoading(false));
    }
    if ((recTab === "simulator" || recTab === "playbook") && recSimServices.length === 0) {
      fetch(`${API_BASE}/api/services`).then(r=>r.json()).then(d=>{ if(Array.isArray(d)) setRecSimServices(d); }).catch(()=>{});
    }
    if (recTab === "simulator" && recSimHistory.length === 0) {
      setRecSimHistoryLoading(true);
      fetch(`${API_BASE}/api/recovery/simulations`).then(r=>r.json()).then(d=>{ if(d.ok) setRecSimHistory(d.simulations||[]); }).catch(()=>{}).finally(()=>setRecSimHistoryLoading(false));
    }
    if (recTab === "tests") {
      setRecTestsLoading(true);
      fetch(`${API_BASE}/api/recovery/restore-tests`).then(r=>r.json()).then(d=>{ if(d.ok) setRecTests(d.tests||[]); }).catch(()=>{}).finally(()=>setRecTestsLoading(false));
      if (recSimServices.length === 0) fetch(`${API_BASE}/api/services`).then(r=>r.json()).then(d=>{ if(Array.isArray(d)) setRecSimServices(d); }).catch(()=>{});
    }
  }, [activeBoard, recTab]); // eslint-disable-line react-hooks/exhaustive-deps


  // Intelligence — load data when board or tab changes
  useEffect(() => {
    if (activeBoard !== "Intelligence") return;
    if (intelTab === "signals" && !intelSignals) {
      setIntelSignalsLoading(true);
      fetch(`${API_BASE}/api/intelligence/signals?hours=24`)
        .then(r => r.json())
        .then(d => { if (d.ok) setIntelSignals(d); })
        .catch(() => {})
        .finally(() => setIntelSignalsLoading(false));
    }
    if (intelTab === "proposals" && !intelProposals) {
      setIntelProposalsLoading(true);
      fetch(`${API_BASE}/api/intelligence/proposals?status=${intelPropFilter}`)
        .then(r => r.json())
        .then(d => { if (d.ok) setIntelProposals(d); })
        .catch(() => {})
        .finally(() => setIntelProposalsLoading(false));
    }
    if (intelTab === "autonomous" && !intelPolicies) {
      setIntelPoliciesLoading(true);
      fetch(`${API_BASE}/api/intelligence/autonomous`)
        .then(r => r.json())
        .then(d => { if (d.ok) setIntelPolicies(d); })
        .catch(() => {})
        .finally(() => setIntelPoliciesLoading(false));
    }
  }, [activeBoard, intelTab]); // eslint-disable-line react-hooks/exhaustive-deps

  // Dependencies — load graph when board becomes active
  useEffect(() => {
    if (activeBoard !== "Dependencies") return;
    setDepLoading(true); setDepError(null);
    fetch(`${API_BASE}/api/dependencies/graph`)
      .then(r => r.json())
      .then(d => { if (!d.ok) throw new Error(d.error || "Failed"); setDepGraph(d); })
      .catch(e => setDepError(e.message))
      .finally(() => setDepLoading(false));
  }, [activeBoard]); // eslint-disable-line react-hooks/exhaustive-deps

  // Discovery — load candidates when board becomes active
  useEffect(() => {
    if (activeBoard !== "Discovery") return;
    loadDiscCandidates(discStatusFilter);
  }, [activeBoard]); // eslint-disable-line react-hooks/exhaustive-deps

  // Activity feed — initial load when board becomes active or filters change
  useEffect(() => {
    if (activeBoard !== "Activity") return;
    setActivityLoading(true);
    setActivityError(null);
    setActivityNewCount(0);
    const params = new URLSearchParams({ limit: "50", offset: String(activityPage * 50) });
    if (activityFilter.action_prefix) params.set("action_prefix", activityFilter.action_prefix);
    if (activityFilter.username)      params.set("username",      activityFilter.username);
    if (activityFilter.outcome)       params.set("outcome",       activityFilter.outcome);
    if (activityFilter.from_ts)       params.set("from_ts",       activityFilter.from_ts);
    if (activityFilter.to_ts)         params.set("to_ts",         activityFilter.to_ts);
    fetch(`${API_BASE}/api/activity?${params}`)
      .then((r) => r.json())
      .then((d) => {
        if (!d.ok) throw new Error(d.error || "Failed");
        setActivityEvents(d.events || []);
        setActivityTotal(d.total);
        setActivityMaxId(d.maxId || "0");
        setActivityLoading(false);
      })
      .catch((e) => { setActivityError(e.message); setActivityLoading(false); });
  }, [activeBoard, activityFilter, activityPage, API_BASE]);

  // Activity feed — live polling for new events (since_id cursor)
  useEffect(() => {
    if (activeBoard !== "Activity" || !activityPolling) return;
    const poll = () => {
      if (!activityMaxId || activityMaxId === "0") return;
      const params = new URLSearchParams({ since_id: activityMaxId, limit: "50" });
      if (activityFilter.action_prefix) params.set("action_prefix", activityFilter.action_prefix);
      if (activityFilter.username)      params.set("username",      activityFilter.username);
      if (activityFilter.outcome)       params.set("outcome",       activityFilter.outcome);
      fetch(`${API_BASE}/api/activity?${params}`)
        .then((r) => r.json())
        .then((d) => {
          if (!d.ok || !d.events.length) return;
          setActivityEvents((prev) => [...d.events.reverse(), ...prev]);
          setActivityMaxId(d.maxId);
          setActivityNewCount((n) => n + d.events.length);
        })
        .catch(() => {});
    };
    const id = setInterval(poll, 10_000);
    return () => clearInterval(id);
  }, [activeBoard, activityPolling, activityMaxId, activityFilter, API_BASE]);

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

  // Sidebar groups — "Home" is pinned standalone above these; every other
  // board lives in exactly one group so the sidebar can collapse to 6 rows
  // instead of listing all 17 boards flat.
  const boardGroups = [
    { name: "Monitor",        boards: ["Ops", "Alerts", "Logs", "Activity"] },
    { name: "Services",       boards: ["Inventory", "Stacks", "Catalogue", "Discovery", "Dependencies"] },
    { name: "Infrastructure", boards: ["DNS", "Files"] },
    { name: "Governance",     boards: ["Governance", "Recovery", "Intelligence"] },
    { name: "System",         boards: ["Admin", "SuperAdmin", "Emergency"] },
  ];

  // Idle-state accent per group header, each echoing the color already
  // established for that group's most representative board in boardThemes
  // below (Alerts/Inventory/DNS/Governance/Admin) so the collapsed sidebar
  // still reads as color-coded, not flat gray.
  const groupThemes = {
    Monitor:        { text: "text-rose-300",    ring: "border-rose-400/20",    hoverRing: "hover:border-rose-400/40",    hoverBg: "hover:bg-rose-500/10" },
    Services:       { text: "text-teal-300",    ring: "border-teal-400/20",    hoverRing: "hover:border-teal-400/40",    hoverBg: "hover:bg-teal-500/10" },
    Infrastructure: { text: "text-emerald-300", ring: "border-emerald-400/20", hoverRing: "hover:border-emerald-400/40", hoverBg: "hover:bg-emerald-500/10" },
    Governance:     { text: "text-amber-300",   ring: "border-amber-400/20",   hoverRing: "hover:border-amber-400/40",   hoverBg: "hover:bg-amber-500/10" },
    System:         { text: "text-purple-300",  ring: "border-purple-400/20",  hoverRing: "hover:border-purple-400/40",  hoverBg: "hover:bg-purple-500/10" },
  };

  const boardThemes = {
    Home:      { active: "from-cyan-400 to-blue-500",     ring: "border-cyan-400/30",     hover: "hover:border-cyan-400/30",     shell: "from-cyan-500/10 to-blue-500/5" },
    Ops:       { active: "from-emerald-400 to-green-500", ring: "border-emerald-400/30",  hover: "hover:border-emerald-400/30",  shell: "from-emerald-500/10 to-green-500/5" },
    Admin:     { active: "from-purple-400 to-indigo-500", ring: "border-purple-400/30",   hover: "hover:border-purple-400/30",   shell: "from-purple-500/10 to-indigo-500/5" },
    SuperAdmin: { active: "from-fuchsia-400 to-purple-500", ring: "border-fuchsia-400/30", hover: "hover:border-fuchsia-400/30", shell: "from-fuchsia-500/10 to-purple-500/5" },
    Stacks:    { active: "from-amber-400 to-orange-500",  ring: "border-amber-400/30",    hover: "hover:border-amber-400/30",    shell: "from-amber-500/10 to-orange-500/5" },
    Files:     { active: "from-rose-400 to-pink-500",     ring: "border-rose-400/30",     hover: "hover:border-rose-400/30",     shell: "from-rose-500/10 to-pink-500/5" },
    Inventory: { active: "from-teal-400 to-cyan-500",     ring: "border-teal-400/30",     hover: "hover:border-teal-400/30",     shell: "from-teal-500/10 to-cyan-500/5" },
    Alerts:    { active: "from-red-400 to-rose-500",      ring: "border-red-400/30",      hover: "hover:border-red-400/30",      shell: "from-red-500/10 to-rose-500/5" },
    Logs:      { active: "from-cyan-400 to-blue-500",      ring: "border-cyan-400/30",     hover: "hover:border-cyan-400/30",     shell: "from-cyan-500/10 to-blue-500/5" },
    DNS:       { active: "from-emerald-400 to-teal-500",   ring: "border-emerald-400/30",  hover: "hover:border-emerald-400/30",  shell: "from-emerald-500/10 to-teal-500/5" },
    Catalogue: { active: "from-violet-400 to-purple-500",  ring: "border-violet-400/30",   hover: "hover:border-violet-400/30",   shell: "from-violet-500/10 to-purple-500/5" },
    Activity:  { active: "from-sky-400 to-indigo-500",    ring: "border-sky-400/30",      hover: "hover:border-sky-400/30",      shell: "from-sky-500/10 to-indigo-500/5" },
    Discovery: { active: "from-teal-400 to-cyan-500",     ring: "border-teal-400/30",     hover: "hover:border-teal-400/30",     shell: "from-teal-500/10 to-cyan-500/5" },
    Dependencies: { active: "from-violet-400 to-fuchsia-500", ring: "border-violet-400/30",  hover: "hover:border-violet-400/30",  shell: "from-violet-500/10 to-fuchsia-500/5" },
    Governance:   { active: "from-amber-400 to-yellow-500",  ring: "border-amber-400/30",   hover: "hover:border-amber-400/30",   shell: "from-amber-500/10 to-yellow-500/5" },
    Recovery:  { active: "from-emerald-400 to-teal-500",  ring: "border-emerald-400/30",  hover: "hover:border-emerald-400/30",  shell: "from-emerald-500/10 to-teal-500/5" },
    Intelligence: { active: "from-sky-400 to-violet-500",   ring: "border-sky-400/30",   hover: "hover:border-sky-400/30",   shell: "from-sky-500/10 to-violet-500/5" },
    Emergency: { active: "from-rose-400 to-pink-500",     ring: "border-rose-400/30",     hover: "hover:border-rose-400/30",     shell: "from-rose-500/10 to-pink-500/5" },
  };

  const theme = boardThemes[activeBoard];

  // Auto-expand whichever sidebar group contains the active board — covers
  // navigation that jumps boards from outside the sidebar (e.g. Home's
  // "View all →" links into Inventory) without ever force-closing a group
  // the user opened manually.
  useEffect(() => {
    const grp = boardGroups.find((g) => g.boards.includes(activeBoard));
    if (!grp) return;
    setOpenGroups((prev) => (prev.has(grp.name) ? prev : new Set(prev).add(grp.name)));
  }, [activeBoard]);

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
            <div className="text-lg font-semibold">Backend Container</div>
            <div className="text-[10px] text-neutral-500">This container&apos;s own resource usage — see Fleet below for host/VM-wide metrics</div>
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

      {/* Workspace view — health broken down by workspace */}
      {servicesData.length > 0 && (() => {
        const byWorkspace = {};
        for (const s of servicesData) {
          if (s.archived) continue;
          const key = s.workspace_name || "Unassigned";
          if (!byWorkspace[key]) byWorkspace[key] = [];
          byWorkspace[key].push(s);
        }
        const workspaces = Object.entries(byWorkspace).sort(([a], [b]) => a.localeCompare(b));
        if (!workspaces.length) return null;
        return (
          <div className="rounded-2xl border border-neutral-800 bg-neutral-900/70 p-4">
            <div className="mb-3 flex items-center justify-between">
              <div className="text-sm font-semibold text-neutral-200">Workspaces</div>
              <button onClick={() => setActiveBoard("Inventory")} className="text-[10px] text-neutral-600 hover:text-neutral-300">View all →</button>
            </div>
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
              {workspaces.map(([name, svcs]) => {
                const healthy = svcs.filter((s) => s.status === "healthy").length;
                const down = svcs.filter((s) => s.status === "down").length;
                const degraded = svcs.filter((s) => s.status === "degraded" || s.status === "warning").length;
                return (
                  <button key={name}
                    onClick={() => { setActiveBoard("Inventory"); setServiceGroupBy("workspace"); }}
                    className="flex items-center justify-between rounded-xl border border-neutral-800 bg-neutral-950/60 px-3 py-2 text-left transition hover:border-teal-400/30">
                    <span className="truncate text-xs font-medium text-neutral-300">{name}</span>
                    <span className="ml-2 flex shrink-0 items-center gap-1.5 text-[10px]">
                      <span className={down > 0 ? "text-rose-300" : degraded > 0 ? "text-amber-300" : "text-emerald-300"}>{healthy}/{svcs.length}</span>
                      {down > 0 && <span className="rounded-full bg-rose-500/15 px-1.5 py-0.5 text-rose-300">{down} down</span>}
                      {degraded > 0 && <span className="rounded-full bg-amber-500/15 px-1.5 py-0.5 text-amber-300">{degraded} degraded</span>}
                    </span>
                  </button>
                );
              })}
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
      {/* System */}
      <div>
        <div className="mb-2 text-xs font-semibold uppercase tracking-wider text-neutral-500">System</div>
        {renderCards([
          { name: "Version & Updates",    onClick: () => setAdminView("updates") },
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

  const updatesPanel = (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <div className="text-xs uppercase tracking-wider text-cyan-300/80">Admin</div>
          <div className="text-lg font-semibold">Version & Updates</div>
        </div>
        <button onClick={() => setAdminView(null)} className="text-xs text-neutral-400 hover:text-white">← Back</button>
      </div>

      {updateCheckLoading && !updateCheckData && <div className="text-xs text-neutral-500">Checking GitHub for the latest release…</div>}

      {updateCheckError && (
        <div className="rounded-xl border border-rose-400/30 bg-rose-500/10 p-3 text-xs text-rose-300">
          Could not reach GitHub to check for updates. Try again shortly.
        </div>
      )}

      {updateCheckData && (
        <>
          <div className="grid grid-cols-2 gap-3">
            <div className="rounded-xl border border-neutral-800 bg-neutral-900/70 p-3">
              <div className="text-[10px] uppercase tracking-wide text-neutral-500">Running Version</div>
              <div className="mt-1 font-mono text-sm text-neutral-200">{updateCheckData.currentVersion}</div>
            </div>
            <div className="rounded-xl border border-neutral-800 bg-neutral-900/70 p-3">
              <div className="text-[10px] uppercase tracking-wide text-neutral-500">Latest on GitHub</div>
              <div className="mt-1 font-mono text-sm text-neutral-200">{updateCheckData.latestVersion}</div>
            </div>
          </div>

          <div
            className={[
              "rounded-2xl border p-4",
              updateCheckData.updateAvailable
                ? "border-amber-400/30 bg-amber-500/10"
                : "border-emerald-400/30 bg-emerald-500/10",
            ].join(" ")}
          >
            <div className={updateCheckData.updateAvailable ? "font-semibold text-amber-200" : "font-semibold text-emerald-200"}>
              {updateCheckData.updateAvailable === null
                ? "Current version isn't a recognized semver — can't compare"
                : updateCheckData.updateAvailable
                ? `Update available: v${updateCheckData.latestVersion}`
                : "Up to date"}
            </div>
            {updateCheckData.updateAvailable && (
              <a href={updateCheckData.releaseUrl} target="_blank" rel="noreferrer" className="mt-1 inline-block text-xs text-amber-300 underline">
                View release on GitHub →
              </a>
            )}
          </div>

          <div className="flex items-center justify-between text-[10px] text-neutral-600">
            <span>{updateCheckData.cached ? "cached result" : "checked just now"} · {new Date(updateCheckData.checkedAt).toLocaleTimeString()}</span>
            <button
              disabled={updateCheckLoading}
              onClick={() => {
                setUpdateCheckLoading(true); setUpdateCheckError(false);
                fetch(`${API_BASE}/api/admin/update-check?force=true`)
                  .then(r=>r.json())
                  .then(d=>{ if(d.ok) setUpdateCheckData(d); else setUpdateCheckError(true); })
                  .catch(()=>setUpdateCheckError(true))
                  .finally(()=>setUpdateCheckLoading(false));
              }}
              className="text-neutral-400 hover:text-white disabled:opacity-50"
            >
              {updateCheckLoading ? "Checking…" : "Check again"}
            </button>
          </div>
        </>
      )}
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
    business:   "Business",
    personal:   "Personal",
    ops:        "Ops",
    admin:      "Admin",
    infra:      "Infra",
    app:        "App",
    monitoring: "Monitoring",
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

  async function submitDeploy(e) {
    e.preventDefault();
    setDeploySaving(true); setDeployError(null);
    try {
      const svc = showDeployModal;
      const res = await fetch(`${API_BASE}/api/actions/deploy`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ service_id: svc.id, container_name: svc.container_name, new_image: deployForm.new_image, force: deployForm.force }),
      });
      const d = await res.json();
      if (res.status === 409 && d.blast_radius) {
        setDeployError(`⚠ ${d.hard_deps} hard downstream dependenc${d.hard_deps===1?"y":"ies"} affected. Enable "Force" to proceed.`);
        setDeploySaving(false); return;
      }
      if (!d.ok) throw new Error(d.error || "Deploy failed");
      setShowDeployModal(null);
      setDeployForm({ new_image: "", force: false });
      // Refresh rollback points
      const rpRes = await fetch(`${API_BASE}/api/actions/rollback-points/${svc.container_name}`);
      const rpData = await rpRes.json();
      if (rpData.ok) setRollbackPoints(p => ({ ...p, [svc.container_name]: rpData.points }));
    } catch (err) { setDeployError(err.message); }
    finally { setDeploySaving(false); }
  }

  async function doRollback(svc) {
    if (rollbackSaving) return;
    const points = rollbackPoints[svc.container_name];
    if (!points?.length) return;
    setRollbackSaving(true);
    try {
      const res = await fetch(`${API_BASE}/api/actions/rollback`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ service_id: svc.id, container_name: svc.container_name }),
      });
      const d = await res.json();
      if (!d.ok) alert(d.error);
      else {
        const rpRes = await fetch(`${API_BASE}/api/actions/rollback-points/${svc.container_name}`);
        const rpData = await rpRes.json();
        if (rpData.ok) setRollbackPoints(p => ({ ...p, [svc.container_name]: rpData.points }));
      }
    } finally {
      setRollbackSaving(false);
    }
  }

  async function loadRollbackPoints(containerName) {
    if (!containerName || rollbackPoints[containerName] !== undefined) return;
    const res = await fetch(`${API_BASE}/api/actions/rollback-points/${containerName}`);
    const d = await res.json();
    if (d.ok) setRollbackPoints(p => ({ ...p, [containerName]: d.points }));
  }

  async function runSimulation(e) {
    e.preventDefault();
    if (!recSimForm.target_id) return;
    setRecSimRunning(true); setRecSimError(null); setRecSimResult(null);
    try {
      const res = await fetch(`${API_BASE}/api/recovery/simulate`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify(recSimForm),
      });
      const d = await res.json();
      if (!d.ok) throw new Error(d.error || "Simulation failed");
      setRecSimResult(d);
      // Refresh history
      fetch(`${API_BASE}/api/recovery/simulations`).then(r=>r.json()).then(d=>{ if(d.ok) setRecSimHistory(d.simulations||[]); }).catch(()=>{});
    } catch (err) { setRecSimError(err.message); }
    finally { setRecSimRunning(false); }
  }

  async function generatePlaybook(e) {
    e.preventDefault();
    if (!recPlaybookService) return;
    setRecPlaybookRunning(true); setRecPlaybookError(null); setRecPlaybook(null);
    try {
      const res = await fetch(`${API_BASE}/api/recovery/playbook`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ service_id: recPlaybookService, incident_summary: recPlaybookIncident || undefined }),
      });
      const d = await res.json();
      if (!d.ok) throw new Error(d.error || "Failed to generate playbook");
      setRecPlaybook(d.playbook);
    } catch (err) { setRecPlaybookError(err.message); }
    finally { setRecPlaybookRunning(false); }
  }

  async function saveRestoreTest(e) {
    e.preventDefault();
    setAddTestSaving(true); setAddTestError(null);
    try {
      const body = { ...addTestForm };
      if (body.rto_actual_min) body.rto_actual_min = Number(body.rto_actual_min); else delete body.rto_actual_min;
      const res = await fetch(`${API_BASE}/api/recovery/restore-tests`, {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
      });
      const d = await res.json();
      if (!d.ok) throw new Error(d.error || "Failed to save test");
      setShowAddTestModal(false);
      setAddTestForm({ service_id: "", test_type: "dry_run", outcome: "passed", rto_actual_min: "", notes: "" });
      setRecTests(prev => [d.test, ...prev]);
      // Invalidate readiness cache so it refreshes on next view
      setRecReadiness(null); setRecGaps(null);
    } catch (err) { setAddTestError(err.message); }
    finally { setAddTestSaving(false); }
  }

  async function deleteRestoreTest(id) {
    if (!confirm("Delete this restore test record?")) return;
    const res = await fetch(`${API_BASE}/api/recovery/restore-tests/${id}`, { method: "DELETE" });
    if (res.ok) { setRecTests(prev => prev.filter(t => t.id !== id)); setRecReadiness(null); setRecGaps(null); }
  }

  async function deleteSimulation(id) {
    if (!confirm("Delete this simulation?")) return;
    const res = await fetch(`${API_BASE}/api/recovery/simulations/${id}`, { method: "DELETE" });
    if (res.ok) setRecSimHistory(prev => prev.filter(s => s.id !== id));
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

  function loadServiceBackups(serviceId) {
    setServiceBackupsLoading(true);
    fetch(`${API_BASE}/api/services/${serviceId}/backups`)
      .then((r) => r.json())
      .then((d) => {
        setServiceBackups(d.backups || []);
        setRecoveryScore(d.score || null);
        setServiceBackupsLoading(false);
      })
      .catch(() => setServiceBackupsLoading(false));
  }

  function openServiceDetail(svc) {
    setSelectedService(svc);
    setServiceHealthHistory([]);
    setServiceActionError(null);
    setServiceHistoryLoading(true);
    setServiceBackups([]);
    setRecoveryScore(null);
    fetch(`${API_BASE}/api/services/${svc.id}/health-history?limit=40`)
      .then((r) => r.json())
      .then((d) => { setServiceHealthHistory(d.events || []); setServiceHistoryLoading(false); })
      .catch(() => setServiceHistoryLoading(false));
    loadServiceBackups(svc.id);
  }

  function closeServiceDetail() {
    setSelectedService(null);
    setServiceHealthHistory([]);
    setServiceActionError(null);
    setServiceActionConfirm(null);
    setServiceBackups([]);
    setRecoveryScore(null);
    setShowAddBackupModal(false);
    setAddBackupError(null);
  }

  async function addServiceBackup() {
    if (!selectedService || !addBackupForm.label.trim()) return;
    setAddBackupSaving(true);
    setAddBackupError(null);
    try {
      const body = { ...addBackupForm };
      if (!body.taken_at) delete body.taken_at;
      if (!body.location) delete body.location;
      if (!body.notes) delete body.notes;
      const r = await fetch(`${API_BASE}/api/services/${selectedService.id}/backups`, {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
      });
      const d = await r.json();
      if (!r.ok) { setAddBackupError(d.error || "Failed to save backup record"); return; }
      setShowAddBackupModal(false);
      setAddBackupForm({ label: "", backup_type: "manual", trust_state: "unknown", location: "", taken_at: "", notes: "" });
      loadServiceBackups(selectedService.id);
    } catch (err) {
      setAddBackupError(err.message);
    } finally {
      setAddBackupSaving(false);
    }
  }

  async function updateBackupTrust(backupId, trust_state) {
    if (!selectedService) return;
    await fetch(`${API_BASE}/api/services/${selectedService.id}/backups/${backupId}`, {
      method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ trust_state }),
    });
    loadServiceBackups(selectedService.id);
  }

  async function deleteServiceBackup(backupId) {
    if (!selectedService) return;
    await fetch(`${API_BASE}/api/services/${selectedService.id}/backups/${backupId}`, { method: "DELETE" });
    loadServiceBackups(selectedService.id);
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
            { label: "Access",       value: (selectedService.access_mode || "unknown").replace(/_/g, " ") },
            { label: "Owner",        value: selectedService.owner || "—" },
            { label: "Backup",       value: selectedService.backup_policy === "none" ? "No backup" : selectedService.backup_policy },
            { label: "Workspace",    value: selectedService.workspace_name || "—" },
            { label: "Health check", value: selectedService.health_endpoint ? (selectedService.health_endpoint.startsWith("tcp://") ? selectedService.health_endpoint : "HTTP configured") : "Not set" },
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
              {selectedService.health_check_exempt
                ? "No health endpoint by design — exempted, see this service's recovery runbook for why."
                : "No health endpoint configured. Edit this service to add one."}
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
          <div className="mb-3 flex items-center justify-between">
            <div className="text-sm font-semibold text-neutral-200">Recovery Score</div>
            {recoveryScore && (
              <span className={["rounded-full px-2.5 py-0.5 text-[10px] font-bold border",
                recoveryScore.color === "emerald" ? "border-emerald-400/30 bg-emerald-500/10 text-emerald-300" :
                recoveryScore.color === "yellow"  ? "border-yellow-400/30 bg-yellow-500/10 text-yellow-300" :
                recoveryScore.color === "amber"   ? "border-amber-400/30 bg-amber-500/10 text-amber-300" :
                "border-rose-400/30 bg-rose-500/10 text-rose-300"].join(" ")}>
                {recoveryScore.score}/100 · {recoveryScore.grade}
              </span>
            )}
          </div>
          {serviceBackupsLoading ? (
            <div className="text-xs text-neutral-500">Loading backup records…</div>
          ) : recoveryScore ? (
            <div className="space-y-2">
              <div className="flex items-center gap-4 text-xs text-neutral-500">
                <div>Policy: <span className={["font-medium", selectedService.backup_policy === "none" && !selectedService.backup_policy_exempt ? "text-amber-400" : "text-emerald-400"].join(" ")}>{selectedService.backup_policy === "none" && selectedService.backup_policy_exempt ? "none (exempt)" : selectedService.backup_policy}</span></div>
                <div>Records: <span className="font-medium text-neutral-300">{recoveryScore.backupCount}</span></div>
                {recoveryScore.latestAt && <div>Latest: <span className="font-medium text-neutral-300">{new Date(recoveryScore.latestAt).toLocaleDateString()}</span></div>}
              </div>
              {recoveryScore.reasons.length > 0 && (
                <div className="space-y-1">
                  {recoveryScore.reasons.map((r, i) => (
                    <div key={i} className="flex items-center gap-1.5 text-xs text-amber-400/80">
                      <span className="shrink-0">⚠</span><span>{r}</span>
                    </div>
                  ))}
                </div>
              )}
              {recoveryScore.reasons.length === 0 && (
                <div className="flex items-center gap-1.5 text-xs text-emerald-400/80"><span>✓</span><span>All recovery criteria met</span></div>
              )}
            </div>
          ) : (
            <div className="text-xs text-neutral-500">Loading…</div>
          )}
        </div>

        {/* Backup inventory */}
        <div className="rounded-2xl border border-neutral-800 bg-neutral-900/70 p-4">
          <div className="mb-3 flex items-center justify-between">
            <div className="text-sm font-semibold text-neutral-200">Backup Records</div>
            {can("operator") && (
              <button onClick={() => { setAddBackupForm({ label: "", backup_type: "manual", trust_state: "unknown", location: "", taken_at: "", notes: "" }); setAddBackupError(null); setShowAddBackupModal(true); }}
                className="rounded-lg border border-emerald-400/30 bg-emerald-500/10 px-3 py-1 text-xs text-emerald-300 hover:bg-emerald-500/20 transition-colors">
                + Add Record
              </button>
            )}
          </div>
          {serviceBackupsLoading ? (
            <div className="text-xs text-neutral-500">Loading…</div>
          ) : serviceBackups.length === 0 ? (
            <div className="rounded-lg bg-neutral-800/60 px-3 py-3 text-center text-xs text-neutral-500">
              No backup records registered for this service.{can("operator") ? " Use + Add Record to register one." : ""}
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-xs">
                <thead>
                  <tr className="border-b border-neutral-800 text-left text-neutral-500">
                    <th className="pb-2 pr-3 font-medium">Label</th>
                    <th className="pb-2 pr-3 font-medium">Type</th>
                    <th className="pb-2 pr-3 font-medium">Trust</th>
                    <th className="pb-2 pr-3 font-medium">Taken</th>
                    <th className="pb-2 font-medium">Location</th>
                    {can("operator") && <th className="pb-2 text-right font-medium">Actions</th>}
                  </tr>
                </thead>
                <tbody className="divide-y divide-neutral-800/50">
                  {serviceBackups.map((bk) => (
                    <tr key={bk.id} className="group">
                      <td className="py-2 pr-3 font-medium text-neutral-200">{bk.label}</td>
                      <td className="py-2 pr-3 text-neutral-400 font-mono">{bk.backup_type}</td>
                      <td className="py-2 pr-3">
                        <span className={["rounded-full px-1.5 py-0.5 text-[10px] border",
                          bk.trust_state === "lkg"      ? "border-emerald-400/30 text-emerald-300 bg-emerald-500/10" :
                          bk.trust_state === "trusted"  ? "border-cyan-400/30 text-cyan-300 bg-cyan-500/10" :
                          bk.trust_state === "untrusted"? "border-rose-400/30 text-rose-300 bg-rose-500/10" :
                          "border-neutral-600 text-neutral-400 bg-neutral-800"].join(" ")}>
                          {bk.trust_state}
                        </span>
                      </td>
                      <td className="py-2 pr-3 text-neutral-400">{new Date(bk.taken_at).toLocaleDateString()}</td>
                      <td className="py-2 text-neutral-500 truncate max-w-[120px]" title={bk.location || ""}>{bk.location || "—"}</td>
                      {can("operator") && (
                        <td className="py-2 text-right">
                          <div className="flex items-center justify-end gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                            {bk.trust_state !== "lkg" && (
                              <button onClick={() => updateBackupTrust(bk.id, "lkg")}
                                title="Mark as Last Known Good"
                                className="rounded px-1.5 py-0.5 text-[10px] border border-emerald-400/30 text-emerald-400 hover:bg-emerald-500/10">
                                LKG
                              </button>
                            )}
                            {bk.trust_state !== "trusted" && bk.trust_state !== "lkg" && (
                              <button onClick={() => updateBackupTrust(bk.id, "trusted")}
                                title="Mark as trusted"
                                className="rounded px-1.5 py-0.5 text-[10px] border border-cyan-400/30 text-cyan-400 hover:bg-cyan-500/10">
                                Trust
                              </button>
                            )}
                            {can("admin") && (
                              <button onClick={() => { if (confirm(`Delete backup record "${bk.label}"?`)) deleteServiceBackup(bk.id); }}
                                className="rounded px-1.5 py-0.5 text-[10px] border border-rose-400/30 text-rose-400 hover:bg-rose-500/10">
                                Del
                              </button>
                            )}
                          </div>
                        </td>
                      )}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>

        {/* Deploy / Rollback — only shown when container_name is configured */}
        {selectedService.container_name && can("admin") && (
          <div className="rounded-2xl border border-violet-400/20 bg-neutral-900/70 p-4">
            <div className="mb-3 flex items-center justify-between">
              <div className="text-sm font-semibold text-neutral-200">Container Orchestration</div>
              <span className="rounded-full border border-violet-400/30 bg-violet-500/10 px-2.5 py-0.5 text-[10px] font-mono text-violet-300">
                {selectedService.container_name}
              </span>
            </div>
            <div className="flex flex-wrap items-center gap-3">
              <button
                onClick={() => { setShowDeployModal(selectedService); setDeployForm({ new_image: "", force: false }); setDeployError(null); loadRollbackPoints(selectedService.container_name); }}
                className="rounded-lg border border-violet-400/30 bg-violet-500/10 px-4 py-1.5 text-xs text-violet-300 hover:bg-violet-500/20 transition-colors">
                Deploy New Image
              </button>
              <button
                onClick={() => { loadRollbackPoints(selectedService.container_name); doRollback(selectedService); }}
                disabled={rollbackSaving || !rollbackPoints[selectedService.container_name]?.length}
                className="rounded-lg border border-amber-400/30 bg-amber-500/10 px-4 py-1.5 text-xs text-amber-300 hover:bg-amber-500/20 transition-colors disabled:opacity-40 disabled:cursor-not-allowed">
                {rollbackSaving ? "Rolling back…" : "Rollback"}
              </button>
              {rollbackPoints[selectedService.container_name]?.length > 0 && (
                <div className="text-xs text-neutral-500">
                  Last image: <span className="font-mono text-neutral-400">{rollbackPoints[selectedService.container_name][0]?.previous_image}</span>
                  <span className="ml-2 text-neutral-600">({new Date(rollbackPoints[selectedService.container_name][0]?.created_at).toLocaleDateString()})</span>
                </div>
              )}
              {rollbackPoints[selectedService.container_name] !== undefined && rollbackPoints[selectedService.container_name].length === 0 && (
                <div className="text-xs text-neutral-600">No rollback points recorded yet.</div>
              )}
            </div>
          </div>
        )}

        {/* Restore planner access */}
        <div className="rounded-2xl border border-neutral-800 bg-neutral-900/70 p-4">
          <div className="mb-2 flex items-center justify-between">
            <div className="text-sm font-semibold text-neutral-200">Config Files & Restore Planner</div>
            <button onClick={() => setActiveBoard("Files")}
              className="rounded-lg border border-rose-400/30 bg-rose-500/10 px-3 py-1 text-xs text-rose-300 hover:bg-rose-500/20 transition-colors">
              Open Files Board ↗
            </button>
          </div>
          <div className="text-xs text-neutral-500 space-y-1">
            <div>Register config files (Caddyfile, compose.yml, .env) in the <span className="text-rose-300/80">Files board</span> to enable the restore planner, LKG designation, and side-by-side restore mode.</div>
            <div>The restore planner performs risk assessment and dependency checking before any file restore.</div>
          </div>
        </div>
      </div>

      {/* Add backup record modal */}
      {showAddBackupModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4">
          <div className="flex max-h-[90vh] w-full max-w-md flex-col rounded-2xl border border-emerald-400/20 bg-neutral-950 shadow-2xl">
            <div className="flex shrink-0 items-center justify-between border-b border-neutral-800 px-6 py-4">
              <div className="text-base font-semibold">Add Backup Record</div>
              <button onClick={() => setShowAddBackupModal(false)} className="text-neutral-500 hover:text-white text-lg">✕</button>
            </div>
            <div className="flex-1 overflow-y-auto px-6 py-4 space-y-3 text-sm">
              <div>
                <label className="mb-1 block text-xs text-neutral-400">Label <span className="text-rose-400">*</span></label>
                <input value={addBackupForm.label} onChange={(e) => setAddBackupForm((f) => ({ ...f, label: e.target.value }))}
                  placeholder="e.g. pre-migration-2026-06-22"
                  className="w-full rounded-lg border border-neutral-700 bg-neutral-900 px-3 py-1.5 text-sm text-neutral-200 focus:border-emerald-400/50 focus:outline-none" />
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="mb-1 block text-xs text-neutral-400">Type</label>
                  <select value={addBackupForm.backup_type} onChange={(e) => setAddBackupForm((f) => ({ ...f, backup_type: e.target.value }))}
                    className="w-full rounded-lg border border-neutral-700 bg-neutral-900 px-3 py-1.5 text-sm text-neutral-200 focus:border-emerald-400/50 focus:outline-none">
                    {["vm_snapshot","data_export","config","full","incremental","manual"].map((t) => <option key={t} value={t}>{t}</option>)}
                  </select>
                </div>
                <div>
                  <label className="mb-1 block text-xs text-neutral-400">Trust state</label>
                  <select value={addBackupForm.trust_state} onChange={(e) => setAddBackupForm((f) => ({ ...f, trust_state: e.target.value }))}
                    className="w-full rounded-lg border border-neutral-700 bg-neutral-900 px-3 py-1.5 text-sm text-neutral-200 focus:border-emerald-400/50 focus:outline-none">
                    {["unknown","trusted","lkg","untrusted"].map((t) => <option key={t} value={t}>{t}</option>)}
                  </select>
                </div>
              </div>
              <div>
                <label className="mb-1 block text-xs text-neutral-400">Taken at <span className="text-neutral-600">(leave blank for now)</span></label>
                <input type="datetime-local" value={addBackupForm.taken_at} onChange={(e) => setAddBackupForm((f) => ({ ...f, taken_at: e.target.value }))}
                  className="w-full rounded-lg border border-neutral-700 bg-neutral-900 px-3 py-1.5 text-sm text-neutral-200 focus:border-emerald-400/50 focus:outline-none" />
              </div>
              <div>
                <label className="mb-1 block text-xs text-neutral-400">Location <span className="text-neutral-600">(optional)</span></label>
                <input value={addBackupForm.location} onChange={(e) => setAddBackupForm((f) => ({ ...f, location: e.target.value }))}
                  placeholder="e.g. Backblaze B2 / QNAP NAS / local /backup/"
                  className="w-full rounded-lg border border-neutral-700 bg-neutral-900 px-3 py-1.5 text-sm text-neutral-200 focus:border-emerald-400/50 focus:outline-none" />
              </div>
              <div>
                <label className="mb-1 block text-xs text-neutral-400">Notes <span className="text-neutral-600">(optional)</span></label>
                <textarea value={addBackupForm.notes} onChange={(e) => setAddBackupForm((f) => ({ ...f, notes: e.target.value }))}
                  rows={2} placeholder="e.g. Taken before ERPNext v17 upgrade"
                  className="w-full rounded-lg border border-neutral-700 bg-neutral-900 px-3 py-1.5 text-sm text-neutral-200 focus:border-emerald-400/50 focus:outline-none resize-none" />
              </div>
              {addBackupError && <div className="rounded-lg border border-rose-400/20 bg-rose-500/10 px-3 py-2 text-xs text-rose-300">{addBackupError}</div>}
            </div>
            <div className="flex justify-end gap-2 border-t border-neutral-800 px-6 py-4">
              <button onClick={() => setShowAddBackupModal(false)}
                className="rounded-lg border border-neutral-700 px-4 py-2 text-xs text-neutral-400 hover:text-white">Cancel</button>
              <button onClick={addServiceBackup} disabled={addBackupSaving || !addBackupForm.label.trim()}
                className="rounded-lg border border-emerald-400/30 bg-emerald-500/10 px-4 py-2 text-xs text-emerald-300 hover:bg-emerald-500/20 disabled:opacity-50">
                {addBackupSaving ? "Saving…" : "Save Record"}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Deploy new image modal */}
      {showDeployModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4">
          <div className="flex max-h-[90vh] w-full max-w-md flex-col rounded-2xl border border-violet-400/20 bg-neutral-950 shadow-2xl">
            <div className="flex shrink-0 items-center justify-between border-b border-neutral-800 px-6 py-4">
              <div className="text-base font-semibold">Deploy New Image</div>
              <button onClick={() => setShowDeployModal(null)} className="text-neutral-500 hover:text-white text-lg">✕</button>
            </div>
            <form onSubmit={submitDeploy} className="flex flex-col flex-1 overflow-hidden">
              <div className="flex-1 overflow-y-auto px-6 py-4 space-y-4 text-sm">
                <div className="rounded-lg border border-neutral-800 bg-neutral-900/70 px-3 py-2 text-xs text-neutral-500">
                  Container: <span className="font-mono text-violet-300">{showDeployModal.container_name}</span>
                  <span className="ml-2">· Service: <span className="text-neutral-300">{showDeployModal.name}</span></span>
                </div>
                <div>
                  <label className="mb-1 block text-xs text-neutral-400">New image tag <span className="text-rose-400">*</span></label>
                  <input
                    value={deployForm.new_image}
                    onChange={(e) => setDeployForm((f) => ({ ...f, new_image: e.target.value }))}
                    placeholder="e.g. frappe/erpnext:v16.5.2"
                    className="w-full rounded-lg border border-neutral-700 bg-neutral-900 px-3 py-1.5 text-sm font-mono text-neutral-200 focus:border-violet-400/50 focus:outline-none"
                    autoFocus
                  />
                </div>
                <div className="flex items-center gap-2">
                  <input type="checkbox" id="deploy-force" checked={deployForm.force} onChange={(e) => setDeployForm((f) => ({ ...f, force: e.target.checked }))}
                    className="h-3.5 w-3.5 rounded border-neutral-700 bg-neutral-900 accent-violet-500" />
                  <label htmlFor="deploy-force" className="text-xs text-neutral-400">Force — proceed even if blast-radius check flags downstream dependencies</label>
                </div>
                <div className="rounded-lg border border-amber-400/20 bg-amber-500/5 px-3 py-2 text-xs text-amber-300/80">
                  Deploy will pull the new image, stop and remove the existing container, and recreate it with the same configuration. A rollback point will be saved automatically.
                </div>
                {deployError && (
                  <div className="rounded-lg border border-rose-400/20 bg-rose-500/10 px-3 py-2 text-xs text-rose-300">{deployError}</div>
                )}
              </div>
              <div className="flex justify-end gap-2 border-t border-neutral-800 px-6 py-4">
                <button type="button" onClick={() => setShowDeployModal(null)}
                  className="rounded-lg border border-neutral-700 px-4 py-2 text-xs text-neutral-400 hover:text-white">Cancel</button>
                <button type="submit" disabled={deploySaving || !deployForm.new_image.trim()}
                  className="rounded-lg border border-violet-400/30 bg-violet-500/10 px-4 py-2 text-xs text-violet-300 hover:bg-violet-500/20 disabled:opacity-50">
                  {deploySaving ? "Deploying…" : "Deploy"}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
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
                  <option value="app">App</option>
                  <option value="monitoring">Monitoring</option>
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
                placeholder="https://.../health or tcp://host:port"
                className="w-full rounded-lg border border-neutral-700 bg-neutral-900 px-3 py-1.5 text-sm text-neutral-200 font-mono focus:border-teal-400/50 focus:outline-none" />
            </div>

            {/* Recovery Runbook URL */}
            <div>
              <label className="mb-1 block text-xs text-neutral-400">Recovery Runbook URL</label>
              <input value={serviceForm.recovery_runbook_url || ""} onChange={(e) => setServiceForm((f) => ({ ...f, recovery_runbook_url: e.target.value }))}
                placeholder="https://docs.internal/runbooks/service-name"
                className="w-full rounded-lg border border-neutral-700 bg-neutral-900 px-3 py-1.5 text-sm text-neutral-200 font-mono focus:border-teal-400/50 focus:outline-none" />
            </div>

            {/* Container Name (for deploy/rollback) */}
            <div>
              <label className="mb-1 block text-xs text-neutral-400">Container Name <span className="text-neutral-600">(optional — enables deploy/rollback)</span></label>
              <input value={serviceForm.container_name || ""} onChange={(e) => setServiceForm((f) => ({ ...f, container_name: e.target.value }))}
                placeholder="privatenexus-frontend"
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

  // ── Activity feed helpers ─────────────────────────────────────────────────
  const ACTION_CATEGORIES = [
    { value: "",             label: "All actions" },
    { value: "container",   label: "Container" },
    { value: "service",     label: "Service" },
    { value: "service_backup", label: "Backup record" },
    { value: "emergency",   label: "Emergency" },
    { value: "backup",      label: "Backup" },
    { value: "diagnostics", label: "Diagnostics" },
    { value: "dns",         label: "DNS" },
    { value: "files",       label: "Files" },
    { value: "auth",        label: "Auth" },
  ];

  const actionColor = (action = "") => {
    if (action.startsWith("container."))     return "text-amber-300";
    if (action.startsWith("service_backup."))return "text-cyan-300";
    if (action.startsWith("service."))       return "text-teal-300";
    if (action.startsWith("emergency."))     return "text-rose-300";
    if (action.startsWith("backup."))        return "text-violet-300";
    if (action.startsWith("diagnostics."))   return "text-sky-300";
    if (action.startsWith("dns."))           return "text-emerald-300";
    if (action.startsWith("files."))         return "text-pink-300";
    if (action.startsWith("auth."))          return "text-blue-300";
    return "text-neutral-300";
  };

  const roleColor = (role = "") => {
    if (role === "breakglass") return "border-rose-400/50 text-rose-300 bg-rose-500/10";
    if (role === "superadmin") return "border-purple-400/50 text-purple-300 bg-purple-500/10";
    if (role === "admin")      return "border-indigo-400/50 text-indigo-300 bg-indigo-500/10";
    if (role === "operator")   return "border-amber-400/50 text-amber-300 bg-amber-500/10";
    return "border-neutral-600 text-neutral-400 bg-neutral-800";
  };

  const relTime = (ts) => {
    const sec = Math.floor((Date.now() - new Date(ts).getTime()) / 1000);
    if (sec < 60)   return `${sec}s ago`;
    if (sec < 3600) return `${Math.floor(sec / 60)}m ago`;
    if (sec < 86400)return `${Math.floor(sec / 3600)}h ago`;
    return `${Math.floor(sec / 86400)}d ago`;
  };

  const severityOf = (ev) => {
    const a = ev.action || "";
    if (ev.outcome === "failure") return "warning";
    if (a.startsWith("emergency.") || a === "emergency.maintenance.enable") return "critical";
    if (a.startsWith("container.stop") || a.startsWith("container.restart")) return "warning";
    if (a.startsWith("auth.")) return "info";
    return "info";
  };

  const SEVERITY_STYLES = {
    critical: "border-rose-400/40 bg-rose-500/10 text-rose-300",
    warning:  "border-amber-400/40 bg-amber-500/10 text-amber-300",
    info:     "border-sky-400/20 bg-sky-500/5 text-sky-400/70",
  };

  // ── Discovery helpers ──────────────────────────────────────────────────────
  const loadDiscCandidates = async (status = discStatusFilter) => {
    setDiscLoading(true); setDiscError(null);
    try {
      const r = await fetch(`/api/discovery/candidates?status=${encodeURIComponent(status)}`, { credentials: "include" });
      const d = await r.json();
      if (!d.ok) throw new Error(d.error);
      setDiscCandidates(d.candidates); setDiscSummary(d.summary || {});
    } catch (e) { setDiscError(e.message); }
    finally { setDiscLoading(false); }
  };

  const runDiscScan = async (sources) => {
    setDiscScanning(true); setDiscScanResult(null);
    try {
      const r = await fetch("/api/discovery/scan", {
        method: "POST", credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sources }),
      });
      const d = await r.json();
      setDiscScanResult(d);
      await loadDiscCandidates("pending");
    } catch (e) { setDiscScanResult({ ok: false, error: e.message }); }
    finally { setDiscScanning(false); }
  };

  const discAction = async (id, action, extra = {}) => {
    setDiscActionPending(id + ":" + action);
    try {
      const r = await fetch(`/api/discovery/candidates/${id}`, {
        method: "PATCH", credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action, ...extra }),
      });
      const d = await r.json();
      if (!d.ok) throw new Error(d.error);
      await loadDiscCandidates(discStatusFilter);
    } catch (e) { alert(e.message); }
    finally { setDiscActionPending(null); }
  };

  const loadDiscDrift = async () => {
    setDiscDriftLoading(true);
    try {
      const r = await fetch("/api/discovery/drift", { credentials: "include" });
      const d = await r.json();
      setDiscDrift(d);
    } catch (e) { setDiscDrift({ ok: false, error: e.message }); }
    finally { setDiscDriftLoading(false); }
  };

  const loadAgentTokens = async () => {
    setAgentTokensLoading(true);
    try {
      const r = await fetch("/api/discovery/agent-tokens");
      const d = await r.json();
      if (d.ok) setAgentTokens(d.tokens);
    } catch {/* ignore */} finally { setAgentTokensLoading(false); }
  };

  const createAgentToken = async () => {
    if (!newTokenLabel.trim() || agentTokenSaving) return;
    setAgentTokenSaving(true);
    try {
      const r = await fetch("/api/discovery/agent-tokens", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ label: newTokenLabel, ttl_hours: Number(newTokenTTL) || null }),
      });
      const d = await r.json();
      if (d.ok) {
        setCreatedToken(d.token);
        setNewTokenLabel("");
        await loadAgentTokens();
      }
    } finally {
      setAgentTokenSaving(false);
    }
  };

  const revokeAgentToken = async (id) => {
    if (agentTokenRevoking) return;
    setAgentTokenRevoking(id);
    try {
      await fetch(`/api/discovery/agent-tokens/${id}`, { method: "DELETE" });
      await loadAgentTokens();
    } finally {
      setAgentTokenRevoking(null);
    }
  };

  const completenessBar = (score) => {
    const colour = score >= 80 ? "bg-emerald-500" : score >= 50 ? "bg-amber-500" : "bg-rose-500";
    return (
      <div className="flex items-center gap-2">
        <div className="h-1.5 w-16 overflow-hidden rounded-full bg-neutral-700">
          <div className={`h-full rounded-full ${colour}`} style={{ width: `${score}%` }} />
        </div>
        <span className="text-[10px] text-neutral-400">{score}%</span>
      </div>
    );
  };

  // ── Dependency graph helpers ─────────────────────────────────────────────
  const DEP_COLORS = { hard: "#a78bfa", soft: "#67e8f9", data: "#fbbf24", auth: "#f472b6", network: "#34d399" };
  const DEP_LABELS = { hard: "Hard", soft: "Soft", data: "Data", auth: "Auth", network: "Net" };

  function layoutGraph(services, edges) {
    const n = services.length;
    if (n === 0) return { nodes: [], arrows: [] };
    const W = 600; const H = 340; const R = Math.min(W, H) * 0.38;
    const cx = W / 2; const cy = H / 2;
    const nodes = services.map((s, i) => {
      const angle = (2 * Math.PI * i) / n - Math.PI / 2;
      return { ...s, x: cx + R * Math.cos(angle), y: cy + R * Math.sin(angle) };
    });
    const nodeById = Object.fromEntries(nodes.map(n => [n.id, n]));
    const arrows = edges.map(e => {
      const src = nodeById[e.upstream_id]; const dst = nodeById[e.downstream_id];
      if (!src || !dst) return null;
      const dx = dst.x - src.x; const dy = dst.y - src.y;
      const dist = Math.sqrt(dx * dx + dy * dy) || 1;
      const NR = 18;
      return { ...e, x1: src.x + dx/dist*NR, y1: src.y + dy/dist*NR, x2: dst.x - dx/dist*NR, y2: dst.y - dy/dist*NR };
    }).filter(Boolean);
    return { nodes, arrows };
  }

  function loadDepAnalysis(svc) {
    if (!svc) return;
    setDepSelected(svc);
    setDepBlast(null); setDepRestore(null);
    setDepBlastLoading(true);
    fetch(`${API_BASE}/api/dependencies/blast-radius/${svc.id}`)
      .then(r => r.json()).then(d => setDepBlast(d)).catch(() => {})
      .finally(() => setDepBlastLoading(false));
    setDepRestoreLoading(true);
    fetch(`${API_BASE}/api/dependencies/restore-chain/${svc.id}`)
      .then(r => r.json()).then(d => setDepRestore(d)).catch(() => {})
      .finally(() => setDepRestoreLoading(false));
  }

  async function submitAddDep(e) {
    e.preventDefault();
    setAddDepSaving(true); setAddDepError(null);
    try {
      const r = await fetch(`${API_BASE}/api/dependencies`, {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(addDepForm),
      });
      const d = await r.json();
      if (!d.ok) throw new Error(d.error || "Failed");
      setShowAddDepModal(false);
      setAddDepForm({ upstream_id: "", downstream_id: "", dep_type: "hard", notes: "" });
      setDepLoading(true); setDepError(null);
      fetch(`${API_BASE}/api/dependencies/graph`)
        .then(r => r.json()).then(d => { if (d.ok) setDepGraph(d); })
        .finally(() => setDepLoading(false));
    } catch(err) { setAddDepError(err.message); }
    finally { setAddDepSaving(false); }
  }

  async function deleteDep(id) {
    await fetch(`${API_BASE}/api/dependencies/${id}`, { method: "DELETE" });
    fetch(`${API_BASE}/api/dependencies/graph`)
      .then(r => r.json()).then(d => { if (d.ok) setDepGraph(d); });
    if (depSelected) loadDepAnalysis(depSelected);
  }

  const { nodes: graphNodes, arrows: graphArrows } = layoutGraph(depGraph.services || [], depGraph.edges || []);

  const depBoard = (
    <div className="space-y-4">
      {/* Header */}
      <div className="rounded-2xl border border-violet-400/30 bg-gradient-to-r from-violet-500/15 via-fuchsia-500/10 to-purple-500/10 p-4">
        <div className="flex items-start justify-between gap-4">
          <div>
            <h2 className="text-lg font-semibold text-white">Dependency Intelligence</h2>
            <p className="mt-0.5 text-sm text-neutral-400">
              Map service dependencies, analyse blast radius, and plan recovery order.
            </p>
          </div>
          <button
            onClick={() => { setAddDepForm({ upstream_id: "", downstream_id: "", dep_type: "hard", notes: "" }); setAddDepError(null); setShowAddDepModal(true); }}
            className="shrink-0 rounded-lg border border-violet-400/40 bg-violet-500/15 px-3 py-1.5 text-xs font-semibold text-violet-300 hover:bg-violet-500/25">
            + Add Dependency
          </button>
        </div>
        <div className="mt-3 flex flex-wrap gap-3 text-xs text-neutral-400">
          {Object.entries(DEP_COLORS).map(([k, c]) => (
            <span key={k} className="flex items-center gap-1">
              <span className="inline-block h-2 w-4 rounded-full" style={{ background: c }}></span>
              {DEP_LABELS[k]}
            </span>
          ))}
          <span className="ml-2 text-neutral-500">{(depGraph.services||[]).length} services · {(depGraph.edges||[]).length} edges</span>
        </div>
      </div>

      {depError && <div className="rounded-xl border border-rose-400/30 bg-rose-500/10 px-4 py-2 text-xs text-rose-300">{depError}</div>}
      {depLoading && <div className="text-center text-xs text-neutral-500 py-8">Loading graph…</div>}

      {!depLoading && (
        <div className="grid grid-cols-1 gap-4 xl:grid-cols-3">
          {/* Graph panel */}
          <div className="xl:col-span-2 rounded-2xl border border-violet-400/20 bg-neutral-900/60 p-4">
            <div className="mb-3 text-xs font-medium uppercase tracking-wider text-neutral-500">Dependency Graph</div>
            {graphNodes.length === 0
              ? <div className="flex h-40 items-center justify-center text-sm text-neutral-600">No services registered yet.</div>
              : (
                <svg viewBox="0 0 600 340" className="w-full select-none" style={{ maxHeight: 340 }}>
                  <defs>
                    {Object.entries(DEP_COLORS).map(([k, c]) => (
                      <marker key={k} id={`arrow-${k}`} markerWidth="8" markerHeight="8" refX="6" refY="3" orient="auto">
                        <path d="M0,0 L0,6 L8,3 z" fill={c} />
                      </marker>
                    ))}
                  </defs>
                  {graphArrows.map((a, i) => (
                    <line key={i} x1={a.x1} y1={a.y1} x2={a.x2} y2={a.y2}
                      stroke={DEP_COLORS[a.dep_type] || "#6b7280"} strokeWidth="1.5" strokeOpacity="0.7"
                      markerEnd={`url(#arrow-${a.dep_type})`} />
                  ))}
                  {graphNodes.map(n => (
                    <g key={n.id} className="cursor-pointer" onClick={() => loadDepAnalysis(n)}>
                      <circle cx={n.x} cy={n.y} r={18}
                        fill={depSelected?.id === n.id ? "#7c3aed" : "#1e1b4b"}
                        stroke={depSelected?.id === n.id ? "#a78bfa" : "#4c1d95"}
                        strokeWidth={depSelected?.id === n.id ? 2 : 1} />
                      <circle cx={n.x} cy={n.y} r={5}
                        fill={n.status === "healthy" ? "#34d399" : n.status === "down" ? "#f87171" : "#6b7280"} />
                      <text x={n.x} y={n.y + 30} textAnchor="middle" fontSize="9" fill="#a1a1aa"
                        className="pointer-events-none">
                        {n.name?.length > 14 ? n.name.slice(0, 13) + "…" : n.name}
                      </text>
                    </g>
                  ))}
                </svg>
              )
            }
            <div className="mt-2 text-[10px] text-neutral-600">Click a node to analyse blast radius and restore chain.</div>
          </div>

          {/* Analysis panel */}
          <div className="rounded-2xl border border-violet-400/20 bg-neutral-900/60 p-4">
            {!depSelected
              ? <div className="flex h-full min-h-[200px] flex-col items-center justify-center gap-2 text-sm text-neutral-600">
                  <span className="text-2xl">⬡</span>
                  Select a node to see analysis
                </div>
              : (
                <div>
                  <div className="mb-3 flex items-center justify-between">
                    <div>
                      <div className="text-sm font-semibold text-white">{depSelected.name}</div>
                      <div className="text-[10px] text-neutral-500">{depSelected.slug}</div>
                    </div>
                    <div className="flex gap-1">
                      {["blast","restore"].map(m => (
                        <button key={m} onClick={() => setDepAnalysisMode(m)}
                          className={["rounded px-2 py-0.5 text-[10px] font-medium capitalize transition-colors", depAnalysisMode === m ? "bg-violet-500/30 text-violet-300" : "bg-neutral-800 text-neutral-500 hover:text-white"].join(" ")}>
                          {m === "blast" ? "Blast Radius" : "Restore Chain"}
                        </button>
                      ))}
                    </div>
                  </div>

                  {depAnalysisMode === "blast" && (
                    depBlastLoading
                      ? <div className="text-xs text-neutral-500">Analysing…</div>
                      : depBlast && (
                        <div>
                          <div className="mb-2 rounded-lg border border-violet-400/20 bg-violet-500/10 px-3 py-2 text-xs">
                            <span className="font-semibold text-violet-300">{depBlast.summary?.total ?? 0}</span>
                            <span className="text-neutral-400"> services affected</span>
                            {depBlast.summary?.hard > 0 && <span className="ml-2 text-rose-300">({depBlast.summary.hard} hard)</span>}
                          </div>
                          <div className="space-y-1 max-h-52 overflow-y-auto">
                            {(depBlast.affected || []).length === 0
                              ? <div className="text-xs text-neutral-600">No downstream dependencies.</div>
                              : (depBlast.affected || []).map(a => (
                                <div key={a.id} className="flex items-center gap-2 rounded-lg border border-neutral-800 bg-neutral-800/40 px-2 py-1.5">
                                  <span className="inline-block h-2 w-2 rounded-full" style={{ background: DEP_COLORS[a.dep_type] || "#6b7280" }}></span>
                                  <span className="flex-1 text-xs text-neutral-300">{a.name}</span>
                                  <span className="text-[10px] text-neutral-600">depth {a.depth}</span>
                                  <span className={["text-[10px]", a.status === "healthy" ? "text-emerald-400" : a.status === "down" ? "text-rose-400" : "text-neutral-500"].join(" ")}>{a.status}</span>
                                </div>
                              ))
                            }
                          </div>
                        </div>
                      )
                  )}

                  {depAnalysisMode === "restore" && (
                    depRestoreLoading
                      ? <div className="text-xs text-neutral-500">Calculating…</div>
                      : depRestore && (
                        <div>
                          <div className="mb-2 text-[10px] text-neutral-500">Restore deepest dependencies first</div>
                          <div className="space-y-1 max-h-52 overflow-y-auto">
                            {(depRestore.restore_chain || []).map((r, i) => (
                              <div key={r.id || i} className="flex items-center gap-2 rounded-lg border border-neutral-800 bg-neutral-800/40 px-2 py-1.5">
                                <span className="text-[10px] font-mono text-neutral-600 w-5 shrink-0">{i + 1}.</span>
                                <span className="flex-1 text-xs text-neutral-300">{r.name}</span>
                                {r.dep_type === "target" && <span className="text-[10px] text-violet-400">target</span>}
                                <span className={["text-[10px]", r.status === "healthy" ? "text-emerald-400" : r.status === "down" ? "text-rose-400" : "text-neutral-500"].join(" ")}>{r.status}</span>
                              </div>
                            ))}
                          </div>
                        </div>
                      )
                  )}
                </div>
              )
            }
          </div>
        </div>
      )}

      {/* Edge list */}
      {!depLoading && (depGraph.edges || []).length > 0 && (
        <div className="rounded-2xl border border-violet-400/20 bg-neutral-900/60 p-4">
          <div className="mb-3 text-xs font-medium uppercase tracking-wider text-neutral-500">All Dependencies ({depGraph.edges.length})</div>
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead>
                <tr className="border-b border-neutral-800 text-left text-[10px] uppercase tracking-wider text-neutral-600">
                  <th className="pb-2 pr-4">Upstream</th>
                  <th className="pb-2 pr-4">→</th>
                  <th className="pb-2 pr-4">Downstream</th>
                  <th className="pb-2 pr-4">Type</th>
                  <th className="pb-2 pr-4">Notes</th>
                  <th className="pb-2"></th>
                </tr>
              </thead>
              <tbody className="divide-y divide-neutral-800/50">
                {depGraph.edges.map(e => (
                  <tr key={e.id} className="hover:bg-white/5">
                    <td className="py-1.5 pr-4 text-neutral-300">{e.upstream_name}</td>
                    <td className="pr-4">
                      <span className="inline-block h-2 w-3 rounded-full" style={{ background: DEP_COLORS[e.dep_type] || "#6b7280" }}></span>
                    </td>
                    <td className="pr-4 text-neutral-300">{e.downstream_name}</td>
                    <td className="pr-4"><span className="rounded px-1.5 py-0.5 text-[10px] font-medium" style={{ background: (DEP_COLORS[e.dep_type] || "#6b7280") + "33", color: DEP_COLORS[e.dep_type] || "#6b7280" }}>{e.dep_type}</span></td>
                    <td className="pr-4 text-neutral-600 max-w-[160px] truncate">{e.notes || "—"}</td>
                    <td>
                      <button onClick={() => deleteDep(e.id)} className="text-[10px] text-neutral-600 hover:text-rose-400 transition-colors">✕</button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Add Dependency Modal */}
      {showAddDepModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60">
          <div className="w-full max-w-md rounded-2xl border border-violet-400/30 bg-neutral-900 p-6 shadow-2xl">
            <div className="mb-4 flex items-center justify-between">
              <h3 className="text-base font-semibold text-white">Add Dependency</h3>
              <button onClick={() => setShowAddDepModal(false)} className="text-neutral-500 hover:text-white">✕</button>
            </div>
            <form onSubmit={submitAddDep} className="space-y-3">
              <div>
                <label className="mb-1 block text-xs text-neutral-400">Upstream (depends-on)</label>
                <select value={addDepForm.upstream_id} onChange={e => setAddDepForm(f => ({ ...f, upstream_id: e.target.value }))}
                  className="w-full rounded-lg border border-neutral-700 bg-neutral-800 px-3 py-2 text-xs text-white" required>
                  <option value="">— select service —</option>
                  {(depGraph.services || []).map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
                </select>
              </div>
              <div>
                <label className="mb-1 block text-xs text-neutral-400">Downstream (depends on upstream)</label>
                <select value={addDepForm.downstream_id} onChange={e => setAddDepForm(f => ({ ...f, downstream_id: e.target.value }))}
                  className="w-full rounded-lg border border-neutral-700 bg-neutral-800 px-3 py-2 text-xs text-white" required>
                  <option value="">— select service —</option>
                  {(depGraph.services || []).filter(s => s.id !== addDepForm.upstream_id).map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
                </select>
              </div>
              <div>
                <label className="mb-1 block text-xs text-neutral-400">Dependency Type</label>
                <select value={addDepForm.dep_type} onChange={e => setAddDepForm(f => ({ ...f, dep_type: e.target.value }))}
                  className="w-full rounded-lg border border-neutral-700 bg-neutral-800 px-3 py-2 text-xs text-white">
                  {Object.entries(DEP_LABELS).map(([k, v]) => <option key={k} value={k}>{v} — {k === "hard" ? "fails without upstream" : k === "soft" ? "degrades without upstream" : k === "data" ? "reads data from upstream" : k === "auth" ? "authenticates via upstream" : "routed through upstream"}</option>)}
                </select>
              </div>
              <div>
                <label className="mb-1 block text-xs text-neutral-400">Notes (optional)</label>
                <input type="text" value={addDepForm.notes} onChange={e => setAddDepForm(f => ({ ...f, notes: e.target.value }))}
                  placeholder="e.g. uses PostgreSQL connection pool"
                  className="w-full rounded-lg border border-neutral-700 bg-neutral-800 px-3 py-2 text-xs text-white placeholder:text-neutral-600" />
              </div>
              {addDepError && <div className="text-xs text-rose-400">{addDepError}</div>}
              <div className="flex gap-2 pt-1">
                <button type="button" onClick={() => setShowAddDepModal(false)}
                  className="flex-1 rounded-lg border border-neutral-700 bg-neutral-800 py-2 text-xs text-neutral-400 hover:text-white">Cancel</button>
                <button type="submit" disabled={addDepSaving}
                  className="flex-1 rounded-lg bg-violet-600 py-2 text-xs font-semibold text-white hover:bg-violet-500 disabled:opacity-50">
                  {addDepSaving ? "Saving…" : "Add Dependency"}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );

  // ── Governance helpers ───────────────────────────────────────────────────
  async function toggleRule(key) {
    if (govRuleToggling) return;
    setGovRuleToggling(key);
    try {
      await fetch(`${API_BASE}/api/governance/rules/${key}/toggle`, { method: "PATCH" });
      const r = await fetch(`${API_BASE}/api/governance/rules`);
      const d = await r.json();
      if (d.ok) setGovRules(d.rules || []);
    } finally {
      setGovRuleToggling(null);
    }
  }

  async function submitAddException(e) {
    e.preventDefault();
    setAddExSaving(true); setAddExError(null);
    try {
      const r = await fetch(`${API_BASE}/api/governance/exceptions`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ service_id: showAddExModal.service_id, rule_key: showAddExModal.rule_key, reason: addExForm.reason, expires_at: addExForm.expires_at || undefined }),
      });
      const d = await r.json();
      if (!d.ok) throw new Error(d.error || "Failed");
      setShowAddExModal(null);
      setAddExForm({ reason: "", expires_at: "" });
      setGovLoading(true);
      fetch(`${API_BASE}/api/governance/recommendations`).then(r=>r.json()).then(d=>{ if(d.ok) { setGovViolations(d.violations||[]); setGovSummary({ critical: d.violations?.filter(v=>v.severity==="critical").length||0, warning: d.violations?.filter(v=>v.severity==="warning").length||0, info: d.violations?.filter(v=>v.severity==="info").length||0, total: d.count||0 }); }}).finally(()=>setGovLoading(false));
    } catch(err) { setAddExError(err.message); }
    finally { setAddExSaving(false); }
  }

  async function deleteException(id) {
    if (govExDeleting) return;
    setGovExDeleting(id);
    try {
      await fetch(`${API_BASE}/api/governance/exceptions/${id}`, { method: "DELETE" });
      fetch(`${API_BASE}/api/governance/exceptions`).then(r=>r.json()).then(d=>{ if(d.ok) setGovExceptions(d.exceptions||[]); });
      fetch(`${API_BASE}/api/governance/recommendations`).then(r=>r.json()).then(d=>{ if(d.ok) { setGovViolations(d.violations||[]); setGovSummary({ critical: d.violations?.filter(v=>v.severity==="critical").length||0, warning: d.violations?.filter(v=>v.severity==="warning").length||0, info: d.violations?.filter(v=>v.severity==="info").length||0, total: d.count||0 }); }});
    } finally {
      setGovExDeleting(null);
    }
  }

  const SEV_STYLES = {
    critical: { badge: "border-rose-400/40 bg-rose-500/15 text-rose-300",    dot: "bg-rose-400",    label: "Critical" },
    warning:  { badge: "border-amber-400/40 bg-amber-500/15 text-amber-300",  dot: "bg-amber-400",   label: "Warning"  },
    info:     { badge: "border-sky-400/40  bg-sky-500/15  text-sky-300",      dot: "bg-sky-400",     label: "Info"     },
  };

  const RULE_LABELS = {
    owner_required:          "Owner Required",
    backup_policy_required:  "Backup Policy Required",
    health_check_required:   "Health Check Required",
    access_mode_classified:  "Access Mode Required",
    admin_service_protected: "Admin Service Protection",
    recovery_runbook_required:"Recovery Runbook Required",
    stale_backup:            "Stale Backup",
  };

  const govBoard = (
    <div className="space-y-4">
      {/* Header */}
      <div className="rounded-2xl border border-amber-400/30 bg-gradient-to-r from-amber-500/15 via-yellow-500/10 to-orange-500/10 p-4">
        <div className="flex items-start justify-between gap-4">
          <div>
            <h2 className="text-lg font-semibold text-white">Governance Engine</h2>
            <p className="mt-0.5 text-sm text-neutral-400">Live policy enforcement across the service registry.</p>
          </div>
          <button onClick={() => { setGovLoading(true); fetch(`${API_BASE}/api/governance/recommendations`).then(r=>r.json()).then(d=>{ if(d.ok) { setGovViolations(d.violations||[]); setGovSummary({ critical: d.violations?.filter(v=>v.severity==="critical").length||0, warning: d.violations?.filter(v=>v.severity==="warning").length||0, info: d.violations?.filter(v=>v.severity==="info").length||0, total: d.count||0 }); }}).finally(()=>setGovLoading(false)); }}
            className="shrink-0 rounded-lg border border-amber-400/30 bg-amber-500/10 px-3 py-1.5 text-xs text-amber-300 hover:bg-amber-500/20">
            Refresh
          </button>
        </div>
        {/* Summary pills */}
        <div className="mt-3 flex flex-wrap gap-2">
          {[["critical","rose"],["warning","amber"],["info","sky"]].map(([sev, col]) => (
            <span key={sev} className={`rounded-full border px-3 py-0.5 text-xs font-medium border-${col}-400/40 bg-${col}-500/15 text-${col}-300`}>
              {govSummary[sev]} {sev}
            </span>
          ))}
          <span className="text-xs text-neutral-500 self-center ml-1">{govSummary.total} total violation{govSummary.total !== 1 ? "s" : ""}</span>
        </div>
      </div>

      {/* Tabs */}
      <div className="flex gap-1 border-b border-neutral-800 pb-0">
        {[["recommendations","Recommendations"],["approvals","Approvals"],["rules","Policy Rules"],["exceptions","Exceptions"],["changelog","Change Log"],["report","Report"]].map(([t, label]) => (
          <button key={t} onClick={() => setGovTab(t)}
            className={["px-3 py-1.5 text-xs font-medium transition-colors border-b-2 -mb-px", govTab === t ? "border-amber-400 text-amber-300" : "border-transparent text-neutral-500 hover:text-white"].join(" ")}>
            {label}
            {t === "recommendations" && govSummary.total > 0 && <span className="ml-1.5 rounded-full bg-rose-500/20 px-1.5 py-0.5 text-[10px] text-rose-300">{govSummary.total}</span>}
          </button>
        ))}
      </div>

      {govError && <div className="rounded-xl border border-rose-400/30 bg-rose-500/10 px-4 py-2 text-xs text-rose-300">{govError}</div>}

      {/* ── Recommendations tab ── */}
      {govTab === "recommendations" && (
        <div>
          {govLoading && <div className="text-center text-xs text-neutral-500 py-8">Evaluating policies…</div>}
          {!govLoading && govViolations.length === 0 && (
            <div className="flex flex-col items-center gap-2 py-12 text-sm text-neutral-600">
              <span className="text-3xl">✓</span>
              All policies satisfied — no violations detected.
            </div>
          )}
          {!govLoading && govViolations.length > 0 && (
            <div className="space-y-1">
              {govViolations.map((v, i) => {
                const st = SEV_STYLES[v.severity] || SEV_STYLES.info;
                return (
                  <div key={i} className="flex items-start gap-3 rounded-xl border border-neutral-800 bg-neutral-900/60 px-3 py-2.5 hover:bg-white/5">
                    <span className={`mt-1 h-2 w-2 shrink-0 rounded-full ${st.dot}`}></span>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="text-xs font-medium text-white">{v.service_name}</span>
                        {v.workspace_name && <span className="text-[10px] text-neutral-600">{v.workspace_name}</span>}
                        <span className={`rounded border px-1.5 py-0 text-[10px] font-medium ${st.badge}`}>{st.label}</span>
                      </div>
                      <div className="mt-0.5 text-[11px] text-neutral-400">
                        <span className="text-neutral-500">{RULE_LABELS[v.rule_key] || v.rule_key}:</span>{" "}{v.detail}
                      </div>
                    </div>
                    <button onClick={() => { setShowAddExModal(v); setAddExForm({ reason: "", expires_at: "" }); setAddExError(null); }}
                      className="shrink-0 rounded px-2 py-0.5 text-[10px] text-neutral-500 hover:bg-neutral-700 hover:text-amber-300 transition-colors">
                      Suppress
                    </button>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}

      {/* ── Approvals tab ── */}
      {govTab === "approvals" && (
        <div className="rounded-2xl border border-neutral-800 bg-neutral-900/60 p-4">
          <div className="mb-3 flex items-center justify-between">
            <div className="text-xs font-medium uppercase tracking-wider text-neutral-500">Action Requests</div>
            <div className="flex gap-1">
              {["pending","approved","rejected","executed","failed"].map(s => (
                <button key={s} onClick={() => { setActReqFilter(s); setActReqLoading(true); fetch(`${API_BASE}/api/actions/requests?status=${s}`).then(r=>r.json()).then(d=>{ if(d.ok) setActRequests(d.requests||[]); }).finally(()=>setActReqLoading(false)); }}
                  className={["rounded px-2 py-0.5 text-[10px] font-medium capitalize transition-colors", actReqFilter === s ? "bg-amber-500/20 text-amber-300" : "bg-neutral-800 text-neutral-500 hover:text-white"].join(" ")}>
                  {s}
                </button>
              ))}
            </div>
          </div>
          {actReqLoading && <div className="text-xs text-neutral-500">Loading…</div>}
          {!actReqLoading && actRequests.length === 0 && <div className="py-8 text-center text-sm text-neutral-600">No {actReqFilter} requests.</div>}
          <div className="space-y-2">
            {actRequests.map(r => {
              const isPending = r.status === "pending";
              const isExpired = new Date(r.expires_at) < new Date();
              return (
                <div key={r.id} className="rounded-xl border border-neutral-800 bg-neutral-800/30 p-3">
                  <div className="flex items-start justify-between gap-3">
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="rounded bg-neutral-700 px-1.5 py-0 text-[10px] font-mono text-neutral-300">{r.action_type}</span>
                        {r.service_name && <span className="text-xs text-white">{r.service_name}</span>}
                        <span className={["rounded px-1.5 py-0 text-[10px] font-medium",
                          r.status === "pending"  ? "bg-amber-500/15 text-amber-300" :
                          r.status === "executed" ? "bg-emerald-500/15 text-emerald-300" :
                          r.status === "rejected" ? "bg-rose-500/15 text-rose-300" :
                          r.status === "failed"   ? "bg-rose-500/15 text-rose-400" :
                          "bg-neutral-700 text-neutral-400"].join(" ")}>{r.status}</span>
                        {isExpired && isPending && <span className="text-[10px] text-rose-400">expired</span>}
                      </div>
                      <div className="mt-1 text-[10px] text-neutral-500">
                        Proposed by <span className="text-neutral-400">{r.proposed_by}</span> · {new Date(r.proposed_at).toLocaleString()}
                      </div>
                      {r.params?.blast_radius?.hard > 0 && (
                        <div className="mt-1 rounded border border-amber-400/20 bg-amber-500/10 px-2 py-1 text-[10px] text-amber-300">
                          ⚠ {r.params.blast_radius.hard} hard downstream dependencies affected
                        </div>
                      )}
                      {r.review_note && <div className="mt-1 text-[10px] text-neutral-400 italic">"{r.review_note}"</div>}
                    </div>
                    {isPending && !isExpired && (
                      <div className="flex shrink-0 flex-col gap-1.5">
                        <input value={actReqReviewNote[r.id] || ""} onChange={e => setActReqReviewNote(n => ({...n, [r.id]: e.target.value}))}
                          placeholder="Note (optional)"
                          className="w-36 rounded border border-neutral-700 bg-neutral-900 px-2 py-0.5 text-[10px] text-white placeholder:text-neutral-600" />
                        <button onClick={async () => {
                            const note = actReqReviewNote[r.id] || "";
                            await fetch(`${API_BASE}/api/actions/requests/${r.id}/approve`, { method: "POST", headers: {"Content-Type":"application/json"}, body: JSON.stringify({ note }) });
                            fetch(`${API_BASE}/api/actions/requests?status=${actReqFilter}`).then(rr=>rr.json()).then(d=>{ if(d.ok) setActRequests(d.requests||[]); });
                          }}
                          className="rounded bg-emerald-600 px-2 py-0.5 text-[10px] font-semibold text-white hover:bg-emerald-500">Approve</button>
                        <button onClick={async () => {
                            const reason = actReqReviewNote[r.id] || "Rejected";
                            await fetch(`${API_BASE}/api/actions/requests/${r.id}/reject`, { method: "POST", headers: {"Content-Type":"application/json"}, body: JSON.stringify({ reason }) });
                            fetch(`${API_BASE}/api/actions/requests?status=${actReqFilter}`).then(rr=>rr.json()).then(d=>{ if(d.ok) setActRequests(d.requests||[]); });
                          }}
                          className="rounded bg-rose-900/50 border border-rose-500/30 px-2 py-0.5 text-[10px] text-rose-300 hover:bg-rose-900/80">Reject</button>
                      </div>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* ── Rules tab ── */}
      {govTab === "rules" && (
        <div className="rounded-2xl border border-neutral-800 bg-neutral-900/60 p-4">
          <div className="mb-3 text-xs font-medium uppercase tracking-wider text-neutral-500">Policy Rules ({govRules.length})</div>
          <div className="space-y-1">
            {govRules.map(rule => {
              const st = SEV_STYLES[rule.severity] || SEV_STYLES.info;
              return (
                <div key={rule.id} className="flex items-center gap-3 rounded-lg border border-neutral-800 bg-neutral-800/40 px-3 py-2">
                  <span className={`h-2 w-2 rounded-full shrink-0 ${st.dot}`}></span>
                  <div className="flex-1 min-w-0">
                    <div className="text-xs font-medium text-white">{rule.name}</div>
                    <div className="text-[10px] text-neutral-500">{rule.description}</div>
                  </div>
                  <span className={`shrink-0 rounded border px-1.5 py-0 text-[10px] font-medium ${st.badge}`}>{st.label}</span>
                  {rule.built_in && <span className="shrink-0 text-[10px] text-neutral-600">built-in</span>}
                  <button onClick={() => toggleRule(rule.rule_key)}
                    disabled={!!govRuleToggling}
                    className={["shrink-0 rounded px-2 py-0.5 text-[10px] font-medium transition-colors disabled:opacity-40 disabled:cursor-not-allowed", rule.enabled ? "bg-emerald-500/15 text-emerald-300 hover:bg-rose-500/15 hover:text-rose-300" : "bg-neutral-700 text-neutral-500 hover:bg-emerald-500/15 hover:text-emerald-300"].join(" ")}>
                    {govRuleToggling === rule.rule_key ? "…" : rule.enabled ? "Enabled" : "Disabled"}
                  </button>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* ── Exceptions tab ── */}
      {govTab === "exceptions" && (
        <div className="rounded-2xl border border-neutral-800 bg-neutral-900/60 p-4">
          <div className="mb-3 flex items-center justify-between">
            <div className="text-xs font-medium uppercase tracking-wider text-neutral-500">Active Exceptions ({govExceptions.length})</div>
          </div>
          {govExLoading && <div className="text-xs text-neutral-500">Loading…</div>}
          {!govExLoading && govExceptions.length === 0 && <div className="text-sm text-neutral-600 py-4 text-center">No exceptions recorded.</div>}
          <div className="space-y-1">
            {govExceptions.map(ex => {
              const expired = ex.expires_at && new Date(ex.expires_at) < new Date();
              return (
                <div key={ex.id} className={["flex items-start gap-3 rounded-lg border px-3 py-2", expired ? "border-neutral-800/50 opacity-50" : "border-neutral-800 bg-neutral-800/40"].join(" ")}>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="text-xs font-medium text-white">{ex.service_name}</span>
                      <span className="text-[10px] text-neutral-500">{RULE_LABELS[ex.rule_key] || ex.rule_key}</span>
                      {expired && <span className="text-[10px] text-rose-400">expired</span>}
                    </div>
                    <div className="mt-0.5 text-[11px] text-neutral-400">{ex.reason}</div>
                    <div className="mt-0.5 text-[10px] text-neutral-600">
                      by {ex.created_by}{ex.expires_at ? ` · expires ${new Date(ex.expires_at).toLocaleDateString()}` : " · no expiry"}
                    </div>
                  </div>
                  <button onClick={() => deleteException(ex.id)} disabled={!!govExDeleting}
                    className="shrink-0 text-[10px] text-neutral-600 hover:text-rose-400 transition-colors disabled:opacity-40 disabled:cursor-not-allowed">
                    {govExDeleting === ex.id ? "…" : "✕"}
                  </button>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* ── Change Log tab ── */}
      {govTab === "changelog" && (
        <div className="rounded-2xl border border-neutral-800 bg-neutral-900/60 p-4">
          <div className="mb-3 text-xs font-medium uppercase tracking-wider text-neutral-500">Change Records</div>
          {govCrLoading && <div className="text-xs text-neutral-500">Loading…</div>}
          {!govCrLoading && govChangeRecords.length === 0 && <div className="text-sm text-neutral-600 py-4 text-center">No change records yet.</div>}
          <div className="space-y-1">
            {govChangeRecords.map(r => (
              <div key={r.id} className="flex items-start gap-3 rounded-lg border border-neutral-800 bg-neutral-800/30 px-3 py-2">
                <span className="shrink-0 mt-0.5 rounded bg-neutral-700 px-1.5 py-0.5 text-[9px] font-mono text-neutral-400 whitespace-nowrap">{r.change_type}</span>
                <div className="flex-1 min-w-0">
                  <div className="text-xs text-neutral-300">{r.summary}</div>
                  <div className="mt-0.5 text-[10px] text-neutral-600">{r.actor} · {new Date(r.created_at).toLocaleString()}</div>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* ── Report tab ── */}
      {govTab === "report" && (
        <div className="space-y-4">
          {govReportLoading && <div className="text-center text-xs text-neutral-500 py-8">Generating report…</div>}
          {govReport && (
            <>
              {/* Summary cards */}
              <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
                {[["Total Services", govReport.summary?.total_services, "text-white"],["Critical", govReport.summary?.critical, "text-rose-300"],["Warning", govReport.summary?.warning, "text-amber-300"],["Info", govReport.summary?.info, "text-sky-300"]].map(([label, val, cls]) => (
                  <div key={label} className="rounded-xl border border-neutral-800 bg-neutral-900/60 p-3 text-center">
                    <div className={`text-2xl font-bold ${cls}`}>{val ?? "—"}</div>
                    <div className="mt-0.5 text-[10px] text-neutral-500 uppercase tracking-wider">{label}</div>
                  </div>
                ))}
              </div>

              {/* Stale backups */}
              {govReport.sections?.stale_backups?.length > 0 && (
                <div className="rounded-2xl border border-amber-400/20 bg-neutral-900/60 p-4">
                  <div className="mb-2 text-xs font-medium uppercase tracking-wider text-amber-400/70">Stale Backups ({govReport.sections.stale_backups.length})</div>
                  <table className="w-full text-xs">
                    <thead><tr className="text-left text-[10px] text-neutral-600 border-b border-neutral-800"><th className="pb-1 pr-4">Service</th><th className="pb-1 pr-4">Workspace</th><th className="pb-1">Last Backup</th></tr></thead>
                    <tbody className="divide-y divide-neutral-800/40">
                      {govReport.sections.stale_backups.map(s => (
                        <tr key={s.id} className="hover:bg-white/5">
                          <td className="py-1 pr-4 text-neutral-300">{s.name}</td>
                          <td className="pr-4 text-neutral-500">{s.workspace_name || "—"}</td>
                          <td className={s.latest_backup ? "text-amber-300" : "text-rose-300"}>{s.latest_backup ? `${s.age_days}d ago` : "Never"}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}

              {/* Activity by user */}
              {govReport.sections?.activity_by_user?.length > 0 && (
                <div className="rounded-2xl border border-neutral-800 bg-neutral-900/60 p-4">
                  <div className="mb-2 text-xs font-medium uppercase tracking-wider text-neutral-500">Admin Activity by User</div>
                  <table className="w-full text-xs">
                    <thead><tr className="text-left text-[10px] text-neutral-600 border-b border-neutral-800"><th className="pb-1 pr-4">User</th><th className="pb-1 pr-4">Actions (30d)</th><th className="pb-1">Actions (90d)</th></tr></thead>
                    <tbody className="divide-y divide-neutral-800/40">
                      {govReport.sections.activity_by_user.map(u => (
                        <tr key={u.username} className="hover:bg-white/5">
                          <td className="py-1 pr-4 text-neutral-300">{u.username}</td>
                          <td className="pr-4 text-neutral-400">{u.actions_30d}</td>
                          <td className="text-neutral-400">{u.actions_90d}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}

              {/* Restore readiness */}
              <div className="rounded-2xl border border-neutral-800 bg-neutral-900/60 p-4">
                <div className="mb-2 flex items-center justify-between">
                  <div className="text-xs font-medium uppercase tracking-wider text-neutral-500">Restore Readiness per Service</div>
                  <a href={`${API_BASE}/api/governance/report/export`}
                    className="rounded-lg border border-neutral-700 bg-neutral-800 px-2.5 py-1 text-[10px] text-neutral-400 hover:text-white transition-colors">
                    Export JSON ↓
                  </a>
                </div>
                <table className="w-full text-xs">
                  <thead><tr className="text-left text-[10px] text-neutral-600 border-b border-neutral-800"><th className="pb-1 pr-4">Service</th><th className="pb-1 pr-2">Backup Policy</th><th className="pb-1 pr-2">Health EP</th><th className="pb-1 pr-2">Runbook</th><th className="pb-1">Status</th></tr></thead>
                  <tbody className="divide-y divide-neutral-800/40">
                    {(govReport.sections?.restore_readiness || []).map(s => (
                      <tr key={s.id} className="hover:bg-white/5">
                        <td className="py-1 pr-4 text-neutral-300">{s.name}</td>
                        <td className="pr-2 text-neutral-500 text-[10px]">{s.backup_policy}{s.backup_policy_exempt && <span className="text-neutral-600"> (exempt)</span>}</td>
                        <td className="pr-2">{s.health_endpoint ? <span className="text-emerald-400">✓</span> : s.health_endpoint_exempt ? <span className="text-neutral-500">exempt</span> : <span className="text-rose-400">✗</span>}</td>
                        <td className="pr-2">{s.recovery_runbook_url ? <span className="text-emerald-400">✓</span> : <span className="text-rose-400">✗</span>}</td>
                        <td className={s.status === "healthy" ? "text-emerald-400" : s.status === "down" ? "text-rose-400" : "text-neutral-500"}>{s.status}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          )}
        </div>
      )}

      {/* Suppress (add exception) modal */}
      {showAddExModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60">
          <div className="w-full max-w-md rounded-2xl border border-amber-400/30 bg-neutral-900 p-6 shadow-2xl">
            <div className="mb-4">
              <div className="text-base font-semibold text-white">Suppress Violation</div>
              <div className="mt-1 text-xs text-neutral-400">
                <span className="text-white">{showAddExModal.service_name}</span> — {RULE_LABELS[showAddExModal.rule_key] || showAddExModal.rule_key}
              </div>
              <div className="mt-0.5 text-[11px] text-neutral-500">{showAddExModal.detail}</div>
            </div>
            <form onSubmit={submitAddException} className="space-y-3">
              <div>
                <label className="mb-1 block text-xs text-neutral-400">Reason for exception <span className="text-rose-400">*</span></label>
                <textarea value={addExForm.reason} onChange={e => setAddExForm(f=>({...f, reason: e.target.value}))} rows={3} required
                  placeholder="e.g. Dev-only service, backup handled by infrastructure layer"
                  className="w-full rounded-lg border border-neutral-700 bg-neutral-800 px-3 py-2 text-xs text-white placeholder:text-neutral-600 resize-none" />
              </div>
              <div>
                <label className="mb-1 block text-xs text-neutral-400">Expires (optional)</label>
                <input type="date" value={addExForm.expires_at} onChange={e => setAddExForm(f=>({...f, expires_at: e.target.value}))}
                  className="w-full rounded-lg border border-neutral-700 bg-neutral-800 px-3 py-2 text-xs text-white" />
              </div>
              {addExError && <div className="text-xs text-rose-400">{addExError}</div>}
              <div className="flex gap-2 pt-1">
                <button type="button" onClick={() => setShowAddExModal(null)}
                  className="flex-1 rounded-lg border border-neutral-700 bg-neutral-800 py-2 text-xs text-neutral-400 hover:text-white">Cancel</button>
                <button type="submit" disabled={addExSaving}
                  className="flex-1 rounded-lg bg-amber-600 py-2 text-xs font-semibold text-white hover:bg-amber-500 disabled:opacity-50">
                  {addExSaving ? "Saving…" : "Suppress"}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );

  const discoveryBoard = (
    <div className="space-y-4">
      {/* Header */}
      <div className="rounded-2xl border border-teal-400/30 bg-gradient-to-r from-teal-500/15 via-cyan-500/10 to-emerald-500/10 p-4">
        <div className="flex items-start justify-between gap-4">
          <div>
            <h2 className="text-lg font-semibold text-white">Discovery</h2>
            <p className="mt-0.5 text-sm text-neutral-400">
              Scan running infrastructure and approve candidates into the service registry.
            </p>
          </div>
          <div className="flex shrink-0 gap-2">
            <button
              onClick={() => { setDiscStatusFilter("pending"); loadDiscCandidates("pending"); }}
              className="rounded-lg border border-teal-400/30 bg-teal-500/10 px-3 py-1.5 text-xs font-medium text-teal-300 hover:bg-teal-500/20">
              Refresh
            </button>
            <button
              disabled={discScanning}
              onClick={() => runDiscScan(["local_docker"])}
              className="rounded-lg border border-cyan-400/40 bg-cyan-500/15 px-3 py-1.5 text-xs font-semibold text-cyan-300 hover:bg-cyan-500/25 disabled:opacity-50">
              {discScanning ? "Scanning…" : "Scan Docker"}
            </button>
          </div>
        </div>

        {/* Summary pills */}
        <div className="mt-3 flex flex-wrap gap-2">
          {[["pending","amber"],["approved","emerald"],["merged","sky"],["rejected","neutral"]].map(([s, col]) => (
            <button key={s}
              onClick={() => { setDiscStatusFilter(s); loadDiscCandidates(s); }}
              className={[
                "rounded-full border px-3 py-0.5 text-xs font-medium capitalize transition-colors",
                discStatusFilter === s
                  ? `border-${col}-400/50 bg-${col}-500/20 text-${col}-300`
                  : "border-neutral-700 bg-neutral-800/50 text-neutral-400 hover:text-white",
              ].join(" ")}>
              {s} {discSummary[s] != null ? `(${discSummary[s]})` : ""}
            </button>
          ))}
        </div>

        {discScanResult && (
          <div className={["mt-3 rounded-lg border px-3 py-2 text-xs",
            discScanResult.ok
              ? "border-emerald-400/30 bg-emerald-500/10 text-emerald-300"
              : "border-rose-400/30 bg-rose-500/10 text-rose-300"].join(" ")}>
            {discScanResult.ok
              ? `Scan complete — ${discScanResult.inserted} new candidates, ${discScanResult.skipped} skipped${discScanResult.errors?.length ? `, ${discScanResult.errors.length} errors` : ""}`
              : `Scan error: ${discScanResult.error}`}
          </div>
        )}
      </div>

      {/* Candidates table */}
      <div className="rounded-2xl border border-neutral-800 bg-neutral-900/60 overflow-hidden">
        <div className="border-b border-neutral-800 px-4 py-3 flex items-center justify-between">
          <span className="text-sm font-medium text-white capitalize">{discStatusFilter} candidates</span>
          <span className="text-xs text-neutral-500">{discCandidates.length} shown</span>
        </div>

        {discLoading ? (
          <div className="px-4 py-10 text-center text-sm text-neutral-500">Loading…</div>
        ) : discError ? (
          <div className="px-4 py-6 text-center text-sm text-rose-400">{discError}</div>
        ) : discCandidates.length === 0 ? (
          <div className="px-4 py-10 text-center text-sm text-neutral-500">
            {discStatusFilter === "pending"
              ? "No pending candidates — run a scan to discover services."
              : `No ${discStatusFilter} candidates.`}
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead>
                <tr className="border-b border-neutral-800 text-left text-neutral-500">
                  <th className="px-4 py-2.5 font-medium">Name / Slug</th>
                  <th className="px-3 py-2.5 font-medium">Source</th>
                  <th className="px-3 py-2.5 font-medium">Image / Type</th>
                  <th className="px-3 py-2.5 font-medium">Category</th>
                  <th className="px-3 py-2.5 font-medium">Health EP</th>
                  <th className="px-3 py-2.5 font-medium">Completeness</th>
                  {discStatusFilter === "pending" && (
                    <th className="px-3 py-2.5 font-medium text-right">Actions</th>
                  )}
                  {discStatusFilter === "merged" && (
                    <th className="px-3 py-2.5 font-medium">Reviewed</th>
                  )}
                  {discStatusFilter === "rejected" && (
                    <th className="px-3 py-2.5 font-medium">Reason</th>
                  )}
                </tr>
              </thead>
              <tbody className="divide-y divide-neutral-800/50">
                {discCandidates.map((c) => (
                  <tr key={c.id} className="hover:bg-neutral-800/40 transition-colors">
                    <td className="px-4 py-2.5">
                      <div className="font-medium text-neutral-200">{c.suggested_name || c.raw_name}</div>
                      <div className="font-mono text-[10px] text-neutral-500">{c.suggested_slug}</div>
                    </td>
                    <td className="px-3 py-2.5">
                      <span className="rounded border border-teal-400/20 bg-teal-500/10 px-1.5 py-0.5 text-[10px] text-teal-300">
                        {c.source}
                      </span>
                      {c.host && <div className="mt-0.5 text-[10px] text-neutral-600">{c.host}</div>}
                    </td>
                    <td className="px-3 py-2.5 max-w-[130px]">
                      <div className="truncate text-neutral-400" title={c.raw_image}>{c.raw_image || "—"}</div>
                    </td>
                    <td className="px-3 py-2.5">
                      <span className="rounded border border-neutral-700 bg-neutral-800 px-1.5 py-0.5 text-[10px] text-neutral-300">
                        {c.suggested_category || "—"}
                      </span>
                    </td>
                    <td className="px-3 py-2.5 max-w-[160px]">
                      {c.suggested_health_ep
                        ? <span className="truncate font-mono text-[10px] text-sky-400" title={c.suggested_health_ep}>{c.suggested_health_ep}</span>
                        : <span className="text-neutral-600">—</span>}
                    </td>
                    <td className="px-3 py-2.5">{completenessBar(c.completeness_score)}</td>

                    {discStatusFilter === "pending" && (
                      <td className="px-3 py-2.5 text-right">
                        <div className="flex justify-end gap-1">
                          <button
                            disabled={discActionPending === c.id + ":approve"}
                            onClick={() => discAction(c.id, "approve")}
                            className="rounded-lg border border-emerald-400/30 bg-emerald-500/10 px-2 py-0.5 text-[10px] font-medium text-emerald-300 hover:bg-emerald-500/20 disabled:opacity-40">
                            {discActionPending === c.id + ":approve" ? "…" : "Approve"}
                          </button>
                          <button
                            disabled={discActionPending === c.id + ":reject"}
                            onClick={() => discAction(c.id, "reject", { reject_reason: "Manually rejected" })}
                            className="rounded-lg border border-rose-400/30 bg-rose-500/10 px-2 py-0.5 text-[10px] font-medium text-rose-300 hover:bg-rose-500/20 disabled:opacity-40">
                            {discActionPending === c.id + ":reject" ? "…" : "Reject"}
                          </button>
                        </div>
                      </td>
                    )}
                    {discStatusFilter === "merged" && (
                      <td className="px-3 py-2.5 text-[10px] text-neutral-500">
                        {c.reviewed_by} · {c.reviewed_at ? new Date(c.reviewed_at).toLocaleDateString() : "—"}
                      </td>
                    )}
                    {discStatusFilter === "rejected" && (
                      <td className="px-3 py-2.5 text-[10px] text-neutral-500">{c.reject_reason || "—"}</td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Drift detection */}
      <div className="rounded-2xl border border-neutral-800 bg-neutral-900/60 overflow-hidden">
        <div className="border-b border-neutral-800 px-4 py-3 flex items-center justify-between">
          <div>
            <span className="text-sm font-medium text-white">Registry Drift</span>
            <p className="text-xs text-neutral-500 mt-0.5">Docker services in the registry not seen in the last scan</p>
          </div>
          <button
            disabled={discDriftLoading}
            onClick={loadDiscDrift}
            className="rounded-lg border border-neutral-700 px-3 py-1.5 text-xs text-neutral-400 hover:text-white disabled:opacity-40">
            {discDriftLoading ? "Checking…" : "Check Drift"}
          </button>
        </div>

        {!discDrift ? (
          <div className="px-4 py-8 text-center text-sm text-neutral-600">Click Check Drift to compare against the last Docker inventory (from either a manual scan or the automated hourly agent).</div>
        ) : !discDrift.ok ? (
          <div className="px-4 py-6 text-center text-sm text-rose-400">{discDrift.error}</div>
        ) : discDrift.drift?.length === 0 ? (
          <div className="px-4 py-8 text-center text-sm text-emerald-400">No drift detected — all registered Docker services were seen in the last scan.</div>
        ) : (
          <div className="divide-y divide-neutral-800/50">
            {discDrift.drift.map((s) => (
              <div key={s.id} className="flex items-center justify-between px-4 py-3">
                <div>
                  <span className="text-sm font-medium text-amber-300">{s.name}</span>
                  <span className="ml-2 font-mono text-xs text-neutral-500">{s.slug}</span>
                </div>
                <span className="rounded border border-amber-400/30 bg-amber-500/10 px-2 py-0.5 text-[10px] text-amber-300">
                  not found in last scan
                </span>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Agent Tokens */}
      <div className="rounded-2xl border border-neutral-800 bg-neutral-900/60">
        <button
          className="flex w-full items-center justify-between px-4 py-3"
          onClick={() => { setAgentTokensOpen(!agentTokensOpen); if (!agentTokensOpen) loadAgentTokens(); }}
        >
          <h3 className="text-sm font-medium text-white">Agent Tokens</h3>
          <span className="text-xs text-neutral-500">{agentTokensOpen ? "▲ collapse" : "▼ expand"}</span>
        </button>
        {agentTokensOpen && (
          <div className="border-t border-neutral-800 px-4 pb-4 pt-3 space-y-3">
            {createdToken && (
              <div className="rounded-lg border border-teal-400/30 bg-teal-500/10 p-3">
                <p className="text-xs font-medium text-teal-300 mb-1">Token created — copy now, it will not be shown again</p>
                <code className="block break-all rounded bg-neutral-800 p-2 text-[10px] text-teal-200 select-all">{createdToken}</code>
                <button className="mt-2 text-[10px] text-neutral-500 hover:text-neutral-300" onClick={() => setCreatedToken(null)}>dismiss</button>
              </div>
            )}
            <div className="flex gap-2">
              <input
                className="flex-1 rounded-lg border border-neutral-700 bg-neutral-800 px-2 py-1 text-xs text-white placeholder:text-neutral-600"
                placeholder="Token label (e.g. sn-infra agent)"
                value={newTokenLabel}
                onChange={(e) => setNewTokenLabel(e.target.value)}
              />
              <select
                className="rounded-lg border border-neutral-700 bg-neutral-800 px-2 py-1 text-xs text-white"
                value={newTokenTTL}
                onChange={(e) => setNewTokenTTL(e.target.value)}
              >
                <option value="24">24h</option>
                <option value="168">7d</option>
                <option value="720">30d</option>
                <option value="">No expiry</option>
              </select>
              <button
                className="rounded-lg border border-teal-500/40 bg-teal-600/20 px-3 py-1 text-xs text-teal-300 hover:bg-teal-600/30 disabled:opacity-50"
                onClick={createAgentToken}
                disabled={!newTokenLabel.trim() || agentTokenSaving}
              >
                {agentTokenSaving ? "Creating…" : "Create"}
              </button>
            </div>
            {agentTokensLoading ? (
              <div className="text-center py-3 text-xs text-neutral-500">Loading…</div>
            ) : agentTokens.length === 0 ? (
              <div className="text-center py-3 text-xs text-neutral-600">No agent tokens yet</div>
            ) : (
              <div className="divide-y divide-neutral-800 rounded-lg border border-neutral-800">
                {agentTokens.map((t) => (
                  <div key={t.id} className="flex items-center justify-between px-3 py-2">
                    <div>
                      <span className={`text-xs font-medium ${t.revoked ? "line-through text-neutral-600" : "text-white"}`}>{t.label}</span>
                      <span className="ml-2 text-[10px] text-neutral-500">
                        {t.expires_at ? `expires ${new Date(t.expires_at).toLocaleDateString()}` : "no expiry"}
                      </span>
                      {t.last_used_at && (
                        <span className="ml-2 text-[10px] text-neutral-600">
                          last used {new Date(t.last_used_at).toLocaleDateString()}
                        </span>
                      )}
                    </div>
                    {!t.revoked && (
                      <button
                        className="rounded border border-rose-500/30 bg-rose-500/10 px-2 py-0.5 text-[10px] text-rose-400 hover:bg-rose-500/20 disabled:opacity-40 disabled:cursor-not-allowed"
                        onClick={() => revokeAgentToken(t.id)}
                        disabled={!!agentTokenRevoking}
                      >
                        {agentTokenRevoking === t.id ? "…" : "Revoke"}
                      </button>
                    )}
                  </div>
                ))}
              </div>
            )}
            <p className="text-[10px] text-neutral-600 pt-1">
              Use with:&nbsp;
              <code className="text-teal-400/70">DISCOVERY_AGENT_TOKEN=&lt;token&gt; bash docker-agent.sh</code>
            </p>
          </div>
        )}
      </div>
    </div>
  );

  const activityBoard = (
    <div className="space-y-4">
      {/* Header */}
      <div className="rounded-2xl border border-sky-400/20 bg-gradient-to-r from-sky-500/10 via-indigo-500/10 to-blue-500/10 p-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <div className="flex items-center gap-2">
              <div className="text-xs uppercase tracking-wider text-sky-300/80">Audit Trail</div>
              {activityPolling && (
                <span className="flex items-center gap-1 text-[10px] text-emerald-400/80">
                  <span className="inline-block h-1.5 w-1.5 animate-pulse rounded-full bg-emerald-400" />
                  Live
                </span>
              )}
            </div>
            <div className="text-lg font-semibold">Activity Feed</div>
          </div>
          <div className="flex items-center gap-2">
            {activityNewCount > 0 && (
              <span className="rounded-full border border-sky-400/30 bg-sky-500/10 px-2.5 py-0.5 text-xs text-sky-300">
                +{activityNewCount} new
              </span>
            )}
            {activityTotal !== null && (
              <span className="rounded-full bg-neutral-800 px-2.5 py-0.5 text-xs text-neutral-400">
                {activityTotal.toLocaleString()} total
              </span>
            )}
            <button
              onClick={() => setActivityPolling((p) => !p)}
              className={["rounded-lg border px-3 py-1 text-xs transition-colors",
                activityPolling
                  ? "border-emerald-400/30 bg-emerald-500/10 text-emerald-300 hover:bg-emerald-500/20"
                  : "border-neutral-700 bg-neutral-800 text-neutral-400 hover:text-white"].join(" ")}>
              {activityPolling ? "Pause" : "Resume"}
            </button>
          </div>
        </div>
      </div>

      {/* Filters */}
      <div className="flex flex-wrap items-center gap-2 rounded-2xl border border-neutral-800 bg-neutral-900/70 px-4 py-3">
        <select
          value={activityFilter.action_prefix}
          onChange={(e) => { setActivityFilter((f) => ({ ...f, action_prefix: e.target.value })); setActivityPage(0); setActivityNewCount(0); }}
          className="rounded-lg border border-neutral-700 bg-neutral-900 px-2.5 py-1 text-xs text-neutral-200 focus:border-sky-400/50 focus:outline-none">
          {ACTION_CATEGORIES.map((c) => <option key={c.value} value={c.value}>{c.label}</option>)}
        </select>
        <input
          value={activityFilter.username}
          onChange={(e) => { setActivityFilter((f) => ({ ...f, username: e.target.value })); setActivityPage(0); setActivityNewCount(0); }}
          placeholder="Username…"
          className="rounded-lg border border-neutral-700 bg-neutral-900 px-2.5 py-1 text-xs text-neutral-200 focus:border-sky-400/50 focus:outline-none w-32" />
        <select
          value={activityFilter.outcome}
          onChange={(e) => { setActivityFilter((f) => ({ ...f, outcome: e.target.value })); setActivityPage(0); setActivityNewCount(0); }}
          className="rounded-lg border border-neutral-700 bg-neutral-900 px-2.5 py-1 text-xs text-neutral-200 focus:border-sky-400/50 focus:outline-none">
          <option value="">All outcomes</option>
          <option value="success">Success</option>
          <option value="failure">Failure</option>
        </select>
        <input type="datetime-local"
          value={activityFilter.from_ts}
          onChange={(e) => { setActivityFilter((f) => ({ ...f, from_ts: e.target.value })); setActivityPage(0); }}
          className="rounded-lg border border-neutral-700 bg-neutral-900 px-2.5 py-1 text-xs text-neutral-400 focus:border-sky-400/50 focus:outline-none" />
        <span className="text-xs text-neutral-600">→</span>
        <input type="datetime-local"
          value={activityFilter.to_ts}
          onChange={(e) => { setActivityFilter((f) => ({ ...f, to_ts: e.target.value })); setActivityPage(0); }}
          className="rounded-lg border border-neutral-700 bg-neutral-900 px-2.5 py-1 text-xs text-neutral-400 focus:border-sky-400/50 focus:outline-none" />
        <select
          value={activityFilter.severity}
          onChange={(e) => { setActivityFilter((f) => ({ ...f, severity: e.target.value })); setActivityNewCount(0); }}
          className="rounded-lg border border-neutral-700 bg-neutral-900 px-2.5 py-1 text-xs text-neutral-200 focus:border-sky-400/50 focus:outline-none">
          <option value="">All severities</option>
          <option value="critical">Critical</option>
          <option value="warning">Warning</option>
          <option value="info">Info</option>
        </select>
        {(activityFilter.action_prefix || activityFilter.username || activityFilter.outcome || activityFilter.from_ts || activityFilter.to_ts || activityFilter.severity) && (
          <button
            onClick={() => { setActivityFilter({ action_prefix: "", username: "", outcome: "", from_ts: "", to_ts: "", severity: "" }); setActivityPage(0); setActivityNewCount(0); }}
            className="rounded-lg border border-neutral-700 px-2.5 py-1 text-xs text-neutral-400 hover:text-white">
            Clear
          </button>
        )}
      </div>

      {/* Event table */}
      <div className="rounded-2xl border border-neutral-800 bg-neutral-900/70">
        {activityError ? (
          <div className="px-4 py-8 text-center text-sm text-rose-400">{activityError}</div>
        ) : activityLoading ? (
          <div className="px-4 py-12 text-center text-sm text-neutral-500">Loading events…</div>
        ) : activityEvents.filter((ev) => !activityFilter.severity || severityOf(ev) === activityFilter.severity).length === 0 ? (
          <div className="px-4 py-12 text-center text-sm text-neutral-500">No events match the current filters.</div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead>
                <tr className="border-b border-neutral-800 text-left text-neutral-500">
                  <th className="px-4 py-2.5 font-medium">Time</th>
                  <th className="px-3 py-2.5 font-medium">Sev</th>
                  <th className="px-3 py-2.5 font-medium">User</th>
                  <th className="px-3 py-2.5 font-medium">Action</th>
                  <th className="px-3 py-2.5 font-medium">Target</th>
                  <th className="px-3 py-2.5 font-medium">Outcome</th>
                  <th className="px-3 py-2.5 font-medium text-right">IP</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-neutral-800/50">
                {activityEvents.filter((ev) => !activityFilter.severity || severityOf(ev) === activityFilter.severity).map((ev) => {
                  const sev = severityOf(ev);
                  return (
                  <tr key={ev.id}
                    className={["transition-colors", ev.outcome === "failure" ? "bg-rose-500/5 hover:bg-rose-500/10" : "hover:bg-neutral-800/40"].join(" ")}>
                    <td className="px-4 py-2.5 whitespace-nowrap">
                      <span className="text-neutral-300" title={new Date(ev.ts).toLocaleString()}>
                        {relTime(ev.ts)}
                      </span>
                      <div className="text-[10px] text-neutral-600">{new Date(ev.ts).toLocaleTimeString()}</div>
                    </td>
                    <td className="px-3 py-2.5">
                      <span className={["rounded border px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide", SEVERITY_STYLES[sev]].join(" ")}>
                        {sev}
                      </span>
                    </td>
                    <td className="px-3 py-2.5">
                      <div className="font-medium text-neutral-200">{ev.username}</div>
                      <span className={["rounded-full border px-1.5 py-0.5 text-[10px]", roleColor(ev.role)].join(" ")}>
                        {ev.role}
                      </span>
                    </td>
                    <td className="px-3 py-2.5">
                      <span className={["font-mono", actionColor(ev.action)].join(" ")}>{ev.action}</span>
                    </td>
                    <td className="px-3 py-2.5 max-w-[140px] truncate text-neutral-400" title={ev.target || ""}>
                      {ev.target || <span className="text-neutral-700">—</span>}
                    </td>
                    <td className="px-3 py-2.5">
                      <span className={["rounded-full border px-1.5 py-0.5 text-[10px]",
                        ev.outcome === "success"
                          ? "border-emerald-400/30 bg-emerald-500/10 text-emerald-300"
                          : "border-rose-400/30 bg-rose-500/10 text-rose-300"].join(" ")}>
                        {ev.outcome}
                      </span>
                    </td>
                    <td className="px-3 py-2.5 text-right font-mono text-neutral-600">{ev.ip || "—"}</td>
                  </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
        {/* Pagination */}
        {!activityLoading && activityTotal !== null && (
          <div className="flex items-center justify-between border-t border-neutral-800 px-4 py-3">
            <div className="text-xs text-neutral-500">
              Showing {activityPage * 50 + 1}–{Math.min((activityPage + 1) * 50, activityTotal)} of {activityTotal.toLocaleString()}
            </div>
            <div className="flex gap-2">
              <button
                disabled={activityPage === 0}
                onClick={() => setActivityPage((p) => p - 1)}
                className="rounded-lg border border-neutral-700 px-3 py-1 text-xs text-neutral-400 hover:text-white disabled:opacity-30">
                ← Prev
              </button>
              <button
                disabled={(activityPage + 1) * 50 >= activityTotal}
                onClick={() => setActivityPage((p) => p + 1)}
                className="rounded-lg border border-neutral-700 px-3 py-1 text-xs text-neutral-400 hover:text-white disabled:opacity-30">
                Next →
              </button>
            </div>
          </div>
        )}
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
          <option value="app">App</option>
          <option value="monitoring">Monitoring</option>
        </select>
        <select value={serviceStatusFilter} onChange={(e) => setServiceStatusFilter(e.target.value)}
          className="rounded-lg border border-neutral-700 bg-neutral-900 px-3 py-1.5 text-xs text-neutral-300 focus:border-teal-400/50 focus:outline-none">
          <option value="all">All statuses</option>
          <option value="healthy">Healthy</option>
          <option value="warning">Warning</option>
          <option value="degraded">Degraded</option>
          <option value="down">Down</option>
          <option value="unknown">Unknown</option>
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
                svc.backup_policy === "none" && !svc.backup_policy_exempt && "backup policy",
                !svc.health_endpoint && !svc.health_check_exempt && "health check",
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
                    <span className={["rounded-full px-2 py-0.5 text-[10px]", svc.backup_policy === "none" && svc.backup_policy_exempt ? "bg-neutral-800 text-neutral-500" : "bg-neutral-800 text-neutral-400"].join(" ")}
                      title={svc.backup_policy === "none" && svc.backup_policy_exempt ? "Not backed up by PrivateNexus — exempted, see recovery runbook" : undefined}>
                      {svc.backup_policy === "none" ? (svc.backup_policy_exempt ? "backup: exempt" : "no backup") : `backup: ${svc.backup_policy}`}
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

                  {/* Recovery indicator */}
                  <div className="mt-2 flex items-center gap-1.5">
                    {svc.backup_count > 0 ? (
                      <>
                        {svc.lkg_count > 0 ? (
                          <span className="rounded-full border border-emerald-400/30 bg-emerald-500/10 px-2 py-0.5 text-[10px] text-emerald-300">LKG ✓</span>
                        ) : svc.trusted_count > 0 ? (
                          <span className="rounded-full border border-cyan-400/30 bg-cyan-500/10 px-2 py-0.5 text-[10px] text-cyan-300">{svc.backup_count} backup{svc.backup_count !== 1 ? "s" : ""}</span>
                        ) : (
                          <span className="rounded-full border border-amber-400/30 bg-amber-500/10 px-2 py-0.5 text-[10px] text-amber-300">{svc.backup_count} backup{svc.backup_count !== 1 ? "s" : ""} · no trust</span>
                        )}
                      </>
                    ) : svc.backup_policy !== "none" ? (
                      <span className="rounded-full border border-rose-400/30 bg-rose-500/10 px-2 py-0.5 text-[10px] text-rose-300">No backup records</span>
                    ) : null}
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

        {/* Sidebar — border and gradient tint track the active board. Groups
            collapse to keep the sidebar short; the group holding the active
            board auto-expands (see the useEffect above). */}
        <aside className={["rounded-2xl border bg-neutral-900/70 bg-gradient-to-br p-4", theme.ring, theme.shell].join(" ")}>
          <div className="space-y-1">
            {/* Home — pinned standalone, not part of any group */}
            <button
              onClick={() => { setActiveBoard("Home"); setAdminView(null); }}
              className={[
                "w-full rounded-lg px-4 py-2 text-left text-sm transition",
                activeBoard === "Home"
                  ? `bg-gradient-to-r text-black shadow ${boardThemes.Home.active}`
                  : "bg-neutral-800 text-neutral-200 hover:bg-neutral-700",
              ].join(" ")}
            >
              Home
            </button>

            {boardGroups.map((group) => {
              const isOpen = openGroups.has(group.name);
              const groupHasActive = group.boards.includes(activeBoard);
              const groupAlertCount = group.boards.includes("Alerts") ? liveAlerts.length : 0;
              const gt = groupThemes[group.name];
              return (
                <div key={group.name}>
                  <button
                    onClick={() =>
                      setOpenGroups((prev) => {
                        const next = new Set(prev);
                        if (next.has(group.name)) next.delete(group.name);
                        else next.add(group.name);
                        return next;
                      })
                    }
                    className={[
                      "flex w-full items-center justify-between rounded-lg border px-4 py-2 text-sm transition",
                      groupHasActive && !isOpen
                        ? `border-transparent bg-gradient-to-r text-black shadow ${boardThemes[activeBoard].active}`
                        : `bg-neutral-800/60 ${gt.text} ${gt.ring} ${gt.hoverRing} ${gt.hoverBg}`,
                    ].join(" ")}
                  >
                    <span>{group.name}</span>
                    <span className="flex items-center gap-2">
                      {groupAlertCount > 0 && (
                        <span className="flex h-4 w-4 items-center justify-center rounded-full bg-rose-500 text-[9px] font-bold text-white">
                          {groupAlertCount > 9 ? "9+" : groupAlertCount}
                        </span>
                      )}
                      <span className={["text-[10px] transition-transform", isOpen ? "rotate-90" : ""].join(" ")}>▸</span>
                    </span>
                  </button>

                  {isOpen && (
                    <div className="mt-1 grid gap-1 pl-2" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(96px, 1fr))" }}>
                      {group.boards.map((board) => (
                        <button
                          key={board}
                          onClick={() => {
                            setActiveBoard(board);
                            if (board !== "Admin") setAdminView(null);
                          }}
                          className={[
                            "relative rounded-lg px-3 py-1.5 text-center text-xs transition",
                            activeBoard === board
                              ? `bg-gradient-to-r text-black shadow ${boardThemes[board].active}`
                              : "bg-neutral-800/80 text-neutral-300 hover:bg-neutral-700",
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
                  )}
                </div>
              );
            })}
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
            adminView === "updates" ? updatesPanel :
            adminView === "users"        ? usersPanel      :
            adminView === "users-manage" ? usersMgmtPanel  :
            adminView === "workspaces"    ? workspacesPanel :
            adminRootView
          )}

          {/* SuperAdmin */}
          {activeBoard === "SuperAdmin" && <SuperAdminBoard />}

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
                {catalogueRepository && (
                  <div className="mt-2 flex items-center gap-2 text-[10px] text-neutral-500">
                    <span>{catalogueRepository.name} · v{catalogueRepository.version}</span>
                    <span className="text-neutral-700">·</span>
                    <span>{catalogueRepository.source === "bundled" ? "bundled default" : "custom repository"}</span>
                    {catalogueRepoFallback && (
                      <span className="rounded-full bg-amber-500/15 px-2 py-0.5 text-amber-300">
                        custom repo unreachable — showing bundled default
                      </span>
                    )}
                  </div>
                )}
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
                  (!lq || a.name.toLowerCase().includes(lq) || a.description.toLowerCase().includes(lq) || a.tags.some((t) => t.toLowerCase().includes(lq)))
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
                                        category: app.category === "business" ? "business"
                                          : ["media","productivity","finance","home"].includes(app.category) ? "personal"
                                          : "infra",
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

          {/* Activity feed */}
          {activeBoard === "Activity" && activityBoard}

          {/* Discovery */}
          {activeBoard === "Discovery" && discoveryBoard}

          {/* Dependencies */}
          {activeBoard === "Dependencies" && depBoard}

          {/* Governance */}
          {activeBoard === "Governance" && govBoard}

          {/* Recovery Intelligence */}
          {activeBoard === "Recovery" && (() => {
            const TIER_STYLES = {
              recoverable: "border-emerald-400/30 bg-emerald-500/10 text-emerald-300",
              at_risk:     "border-amber-400/30 bg-amber-500/10 text-amber-300",
              unproven:    "border-orange-400/30 bg-orange-500/10 text-orange-300",
              blocked:     "border-rose-400/30 bg-rose-500/10 text-rose-300",
            };
            const TIER_LABEL = { recoverable: "Recoverable", at_risk: "At Risk", unproven: "Unproven", blocked: "Blocked" };
            const PRIORITY_STYLES = { critical: "text-rose-300", high: "text-amber-300", medium: "text-sky-300", low: "text-neutral-400" };
            const REC_TABS = ["readiness", "gaps", "simulator", "playbook", "tests"];
            const fmtRTO = min => min == null ? "unknown" : min >= 60 ? `~${Math.round(min/60)}h` : `~${min}m`;
            const fmtDLW = min => min == null ? "unknown" : min >= 1440 ? `~${Math.round(min/1440)}d` : min >= 60 ? `~${Math.round(min/60)}h` : `~${min}m`;

            return (
              <div className="space-y-4">
                {/* Header */}
                <div className="rounded-2xl border border-emerald-400/20 bg-gradient-to-r from-emerald-500/10 via-teal-500/10 to-cyan-500/5 p-4">
                  <div className="flex items-center justify-between">
                    <div>
                      <div className="text-xs uppercase tracking-wider text-emerald-300/80">v4.0</div>
                      <div className="text-lg font-semibold">Recovery Intelligence</div>
                    </div>
                    <button onClick={() => { setRecReadiness(null); setRecGaps(null); setRecSimHistory([]); setRecTests([]); setRecTab(t => t); }}
                      className="rounded-lg border border-emerald-400/20 bg-emerald-500/10 px-3 py-1 text-xs text-emerald-300 hover:bg-emerald-500/20">
                      Refresh All
                    </button>
                  </div>
                </div>

                {/* Summary tiles */}
                {recReadiness?.summary && (
                  <div className="grid grid-cols-2 gap-3 md:grid-cols-5">
                    {[
                      { label: "Recoverable", key: "recoverable", cls: "border-emerald-400/30 bg-emerald-500/10 text-emerald-300" },
                      { label: "At Risk",     key: "at_risk",     cls: "border-amber-400/30 bg-amber-500/10 text-amber-300" },
                      { label: "Unproven",    key: "unproven",    cls: "border-orange-400/30 bg-orange-500/10 text-orange-300" },
                      { label: "Blocked",     key: "blocked",     cls: "border-rose-400/30 bg-rose-500/10 text-rose-300" },
                      { label: "Avg Score",   key: "avg_score",   cls: "border-neutral-600 bg-neutral-800/60 text-neutral-300", suffix: "/100" },
                    ].map(({ label, key, cls, suffix = "" }) => (
                      <div key={key} className={["rounded-xl border px-4 py-3 text-center", cls].join(" ")}>
                        <div className="text-2xl font-bold">{recReadiness.summary[key]}{suffix}</div>
                        <div className="mt-0.5 text-[10px] uppercase tracking-wider opacity-70">{label}</div>
                      </div>
                    ))}
                  </div>
                )}

                {/* Tabs */}
                <div className="flex gap-1 border-b border-neutral-800">
                  {REC_TABS.map(t => (
                    <button key={t} onClick={() => setRecTab(t)}
                      className={["px-3 py-1.5 text-xs font-medium transition-colors border-b-2 -mb-px",
                        recTab === t ? "border-emerald-400 text-emerald-300" : "border-transparent text-neutral-500 hover:text-white"].join(" ")}>
                      {t === "tests" ? "Restore Tests" : t.charAt(0).toUpperCase() + t.slice(1)}
                      {t === "gaps" && recGaps?.total > 0 && <span className="ml-1.5 rounded-full bg-amber-500/20 px-1.5 py-0.5 text-[10px] text-amber-300">{recGaps.total}</span>}
                    </button>
                  ))}
                </div>

                {/* ── READINESS TAB ── */}
                {recTab === "readiness" && (
                  <div>
                    {recReadinessLoading && <div className="py-8 text-center text-xs text-neutral-500">Loading readiness data…</div>}
                    {!recReadinessLoading && !recReadiness && <div className="py-8 text-center text-xs text-neutral-500">Click Refresh All to load.</div>}
                    {recReadiness?.services?.length === 0 && <div className="py-8 text-center text-xs text-neutral-500">No services registered yet.</div>}
                    {recReadiness?.services?.length > 0 && (
                      <div className="overflow-x-auto rounded-2xl border border-neutral-800">
                        <table className="w-full text-xs">
                          <thead>
                            <tr className="border-b border-neutral-800 bg-neutral-900/60 text-left text-neutral-500">
                              <th className="px-3 py-2.5 font-medium">Service</th>
                              <th className="px-3 py-2.5 font-medium">Tier</th>
                              <th className="px-3 py-2.5 font-medium">Score</th>
                              <th className="px-3 py-2.5 font-medium">Est. RTO</th>
                              <th className="px-3 py-2.5 font-medium">Data Loss</th>
                              <th className="px-3 py-2.5 font-medium">Blockers</th>
                              <th className="px-3 py-2.5 font-medium">Signals</th>
                            </tr>
                          </thead>
                          <tbody>
                            {recReadiness.services.map(svc => (
                              <React.Fragment key={svc.id}>
                                <tr className="border-b border-neutral-800/50 hover:bg-neutral-800/30">
                                  <td className="px-3 py-2.5">
                                    <div className="font-medium text-neutral-200">{svc.name}</div>
                                    <div className="text-[10px] text-neutral-600 capitalize">{svc.category} · {svc.workspace_name || "—"}</div>
                                  </td>
                                  <td className="px-3 py-2.5">
                                    <span className={["rounded-full border px-2.5 py-0.5 text-[10px] font-medium", TIER_STYLES[svc.tier] || "border-neutral-600 text-neutral-400"].join(" ")}>
                                      {TIER_LABEL[svc.tier] || svc.tier}
                                    </span>
                                  </td>
                                  <td className="px-3 py-2.5">
                                    <div className="flex items-center gap-2">
                                      <div className="h-1.5 w-16 overflow-hidden rounded-full bg-neutral-800">
                                        <div className={["h-full rounded-full transition-all", svc.score >= 85 ? "bg-emerald-500" : svc.score >= 60 ? "bg-amber-500" : svc.score >= 30 ? "bg-orange-500" : "bg-rose-500"].join(" ")}
                                          style={{ width: `${svc.score}%` }} />
                                      </div>
                                      <span className="font-medium text-neutral-300">{svc.score}</span>
                                    </div>
                                  </td>
                                  <td className="px-3 py-2.5 text-neutral-400">{fmtRTO(svc.rto_min)}</td>
                                  <td className="px-3 py-2.5 text-neutral-400">{fmtDLW(svc.data_loss_window_min)}</td>
                                  <td className="px-3 py-2.5">
                                    {svc.blockers.length === 0
                                      ? <span className="text-emerald-400/60 text-[10px]">None</span>
                                      : <span className="rounded-full bg-rose-500/10 px-1.5 py-0.5 text-[10px] text-rose-300">{svc.blockers.length}</span>}
                                  </td>
                                  <td className="px-3 py-2.5">
                                    <button onClick={() => setRecExpandedService(recExpandedService === svc.id ? null : svc.id)}
                                      className="rounded border border-neutral-700 px-2 py-0.5 text-[10px] text-neutral-500 hover:border-emerald-400/30 hover:text-emerald-300">
                                      {recExpandedService === svc.id ? "Hide" : "Details"}
                                    </button>
                                  </td>
                                </tr>
                                {recExpandedService === svc.id && (
                                  <tr key={svc.id + "-det"} className="bg-neutral-900/40">
                                    <td colSpan={7} className="px-4 py-3">
                                      <div className="grid grid-cols-2 gap-2 md:grid-cols-4">
                                        {svc.signals.map(sig => (
                                          <div key={sig.key} className={["flex items-start gap-2 rounded-lg border p-2", sig.pass ? "border-emerald-400/20 bg-emerald-500/5" : "border-rose-400/20 bg-rose-500/5"].join(" ")}>
                                            <span className={["shrink-0 text-sm leading-none mt-0.5", sig.pass ? "text-emerald-400" : "text-rose-400"].join(" ")}>{sig.pass ? "✓" : "✗"}</span>
                                            <div className="min-w-0">
                                              <div className="text-[10px] font-medium text-neutral-300">{sig.label}</div>
                                              <div className="text-[10px] text-neutral-500 break-all">{sig.detail}</div>
                                              <div className="text-[10px] text-neutral-700">{sig.earned}/{sig.points}pts</div>
                                            </div>
                                          </div>
                                        ))}
                                      </div>
                                      {svc.blockers.length > 0 && (
                                        <div className="mt-2 space-y-1">
                                          {svc.blockers.map((b, i) => (
                                            <div key={i} className="flex items-center gap-1.5 text-[10px] text-rose-300/80"><span>⛔</span><span>{b}</span></div>
                                          ))}
                                        </div>
                                      )}
                                    </td>
                                  </tr>
                                )}
                              </React.Fragment>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    )}
                  </div>
                )}

                {/* ── GAPS TAB ── */}
                {recTab === "gaps" && (
                  <div className="space-y-3">
                    {recGapsLoading && <div className="py-8 text-center text-xs text-neutral-500">Analysing gaps…</div>}
                    {!recGapsLoading && recGaps?.gaps?.length === 0 && (
                      <div className="rounded-2xl border border-emerald-400/20 bg-emerald-500/5 px-6 py-10 text-center">
                        <div className="text-2xl">✓</div>
                        <div className="mt-2 text-sm font-medium text-emerald-300">All services are Recoverable</div>
                        <div className="mt-1 text-xs text-neutral-500">No recovery gaps detected.</div>
                      </div>
                    )}
                    {recGaps?.gaps?.map(gap => (
                      <div key={gap.id} className="rounded-2xl border border-neutral-800 bg-neutral-900/70 p-4">
                        <div className="flex items-start justify-between gap-3">
                          <div className="flex items-center gap-3">
                            <span className={["rounded-full border px-2.5 py-0.5 text-[10px] font-medium", TIER_STYLES[gap.tier] || ""].join(" ")}>{TIER_LABEL[gap.tier]}</span>
                            <div>
                              <div className="font-medium text-neutral-200">{gap.name}</div>
                              <div className="text-[10px] text-neutral-600 capitalize">{gap.category} · {gap.workspace_name || "Unassigned"}</div>
                            </div>
                          </div>
                          <div className="shrink-0 text-lg font-bold text-neutral-300">{gap.score}<span className="text-xs text-neutral-600">/100</span></div>
                        </div>
                        {gap.blockers.length > 0 && (
                          <div className="mt-3 space-y-1">
                            {gap.blockers.map((b, i) => <div key={i} className="flex items-start gap-1.5 text-xs text-rose-300/80"><span className="shrink-0">⛔</span><span>{b}</span></div>)}
                          </div>
                        )}
                        {gap.remediation.length > 0 && (
                          <div className="mt-3 border-t border-neutral-800 pt-3 space-y-1.5">
                            <div className="text-[10px] uppercase tracking-wider text-neutral-600">Remediation steps</div>
                            {gap.remediation.map((r, i) => (
                              <div key={i} className="flex items-start gap-2 text-xs">
                                <span className={["shrink-0 rounded px-1 py-px text-[9px] font-bold uppercase", PRIORITY_STYLES[r.priority] || "text-neutral-400"].join(" ")}>{r.priority}</span>
                                <span className="text-neutral-400">{r.action}</span>
                              </div>
                            ))}
                          </div>
                        )}
                      </div>
                    ))}
                  </div>
                )}

                {/* ── SIMULATOR TAB ── */}
                {recTab === "simulator" && (
                  <div className="space-y-4">
                    <div className="rounded-2xl border border-neutral-800 bg-neutral-900/70 p-4">
                      <div className="mb-3 text-sm font-semibold text-neutral-200">Run Failure Simulation</div>
                      <form onSubmit={runSimulation} className="space-y-3">
                        <div className="grid grid-cols-2 gap-3">
                          <div>
                            <label className="mb-1 block text-xs text-neutral-400">Scenario</label>
                            <select value={recSimForm.scenario_type} onChange={e => setRecSimForm(f => ({ ...f, scenario_type: e.target.value }))}
                              className="w-full rounded-lg border border-neutral-700 bg-neutral-900 px-3 py-1.5 text-sm text-neutral-200 focus:border-emerald-400/50 focus:outline-none">
                              <option value="service_down">Service Down</option>
                              <option value="workspace_down">Workspace Down</option>
                            </select>
                          </div>
                          <div>
                            <label className="mb-1 block text-xs text-neutral-400">Target type</label>
                            <select value={recSimForm.target_type}
                              onChange={e => setRecSimForm(f => ({ ...f, target_type: e.target.value, target_id: "" }))}
                              className="w-full rounded-lg border border-neutral-700 bg-neutral-900 px-3 py-1.5 text-sm text-neutral-200 focus:border-emerald-400/50 focus:outline-none">
                              <option value="service">Service</option>
                              <option value="workspace">Workspace</option>
                            </select>
                          </div>
                        </div>
                        <div>
                          <label className="mb-1 block text-xs text-neutral-400">
                            {recSimForm.target_type === "workspace" ? "Workspace" : "Service"} <span className="text-rose-400">*</span>
                          </label>
                          <select value={recSimForm.target_id} onChange={e => setRecSimForm(f => ({ ...f, target_id: e.target.value }))}
                            className="w-full rounded-lg border border-neutral-700 bg-neutral-900 px-3 py-1.5 text-sm text-neutral-200 focus:border-emerald-400/50 focus:outline-none">
                            <option value="">Select…</option>
                            {recSimForm.target_type === "service"
                              ? recSimServices.map(s => <option key={s.id} value={s.id}>{s.name}</option>)
                              : [...new Map(recSimServices.filter(s => s.workspace_id).map(s => [s.workspace_id, s])).values()]
                                  .map(s => <option key={s.workspace_id} value={s.workspace_id}>{s.workspace_name}</option>)}
                          </select>
                        </div>
                        {recSimError && <div className="rounded-lg border border-rose-400/20 bg-rose-500/10 px-3 py-2 text-xs text-rose-300">{recSimError}</div>}
                        <button type="submit" disabled={recSimRunning || !recSimForm.target_id}
                          className="rounded-lg border border-emerald-400/30 bg-emerald-500/10 px-4 py-2 text-xs text-emerald-300 hover:bg-emerald-500/20 disabled:opacity-50">
                          {recSimRunning ? "Simulating…" : "Run Simulation"}
                        </button>
                      </form>
                    </div>

                    {recSimResult && (
                      <div className="rounded-2xl border border-emerald-400/20 bg-neutral-900/70 p-4 space-y-3">
                        <div className="flex items-center justify-between">
                          <div className="text-sm font-semibold text-neutral-200">{recSimResult.target_names?.join(", ")}</div>
                          <span className={["rounded-full border px-2.5 py-0.5 text-[10px] font-medium", TIER_STYLES[recSimResult.summary.overall_tier] || ""].join(" ")}>
                            {TIER_LABEL[recSimResult.summary.overall_tier] || recSimResult.summary.overall_tier}
                          </span>
                        </div>
                        <div className="grid grid-cols-2 gap-3 md:grid-cols-4 text-xs">
                          {[
                            ["Steps",      recSimResult.summary.steps],
                            ["Total RTO",  fmtRTO(recSimResult.summary.total_rto_min)],
                            ["Max Loss",   fmtDLW(recSimResult.summary.worst_data_loss_min)],
                            ["Blockers",   recSimResult.summary.blockers_count],
                          ].map(([label, val]) => (
                            <div key={label} className="rounded-lg border border-neutral-800 bg-neutral-900/60 px-3 py-2">
                              <div className="text-neutral-500 text-[10px]">{label}</div>
                              <div className="mt-0.5 font-semibold text-neutral-200">{val}</div>
                            </div>
                          ))}
                        </div>
                        {recSimResult.blockers.length > 0 && (
                          <div className="rounded-lg border border-rose-400/20 bg-rose-500/5 p-3 space-y-1">
                            <div className="text-[10px] uppercase tracking-wider text-rose-400/70">Blockers</div>
                            {recSimResult.blockers.map((b, i) => (
                              <div key={i} className="text-xs text-rose-300/80">⛔ <span className="text-neutral-500">{b.service}:</span> {b.blocker}</div>
                            ))}
                          </div>
                        )}
                        <div className="overflow-hidden rounded-xl border border-neutral-800">
                          <table className="w-full text-xs">
                            <thead>
                              <tr className="border-b border-neutral-800 bg-neutral-900/60 text-left text-neutral-500">
                                <th className="px-3 py-2 font-medium">#</th>
                                <th className="px-3 py-2 font-medium">Service</th>
                                <th className="px-3 py-2 font-medium">Tier</th>
                                <th className="px-3 py-2 font-medium">RTO</th>
                                <th className="px-3 py-2 font-medium">Last Backup</th>
                                <th className="px-3 py-2 font-medium">Runbook</th>
                              </tr>
                            </thead>
                            <tbody className="divide-y divide-neutral-800/50">
                              {recSimResult.plan.map(step => (
                                <tr key={step.service_id} className={["hover:bg-neutral-800/30", step.is_target ? "bg-emerald-500/5" : ""].join(" ")}>
                                  <td className="px-3 py-2 text-neutral-500">{step.step}</td>
                                  <td className="px-3 py-2">
                                    <div className={["font-medium", step.is_target ? "text-emerald-300" : "text-neutral-200"].join(" ")}>{step.service_name}</div>
                                    <div className="text-[10px] text-neutral-600">{step.is_target ? "target" : "dependency"}</div>
                                  </td>
                                  <td className="px-3 py-2">
                                    <span className={["rounded-full border px-2 py-px text-[10px]", TIER_STYLES[step.tier] || ""].join(" ")}>{TIER_LABEL[step.tier]}</span>
                                  </td>
                                  <td className="px-3 py-2 text-neutral-400">{fmtRTO(step.rto_min)}</td>
                                  <td className="px-3 py-2 text-neutral-400">
                                    {step.latest_backup
                                      ? `${step.latest_backup.trust_state} · ${new Date(step.latest_backup.taken_at).toLocaleDateString()}`
                                      : <span className="text-rose-400/60">None</span>}
                                  </td>
                                  <td className="px-3 py-2">
                                    {step.runbook_url
                                      ? <a href={step.runbook_url} target="_blank" rel="noreferrer" className="text-emerald-400/70 hover:text-emerald-300">↗</a>
                                      : <span className="text-neutral-700">—</span>}
                                  </td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        </div>
                      </div>
                    )}

                    {recSimHistory.length > 0 && (
                      <div className="rounded-2xl border border-neutral-800 bg-neutral-900/70 p-4">
                        <div className="mb-3 text-sm font-semibold text-neutral-200">Simulation History</div>
                        <div className="space-y-2">
                          {recSimHistory.map(sim => (
                            <div key={sim.id} className="flex items-center justify-between rounded-lg border border-neutral-800 bg-neutral-900/40 px-3 py-2">
                              <div className="text-xs">
                                <span className="font-medium text-neutral-300">{sim.target_name}</span>
                                <span className="ml-2 text-neutral-600 capitalize">{sim.scenario_type?.replace("_", " ")}</span>
                                <span className="ml-2 text-neutral-700">· {new Date(sim.created_at).toLocaleDateString()}</span>
                                {sim.summary?.overall_tier && <span className={["ml-2 rounded-full border px-2 py-px text-[10px]", TIER_STYLES[sim.summary.overall_tier] || ""].join(" ")}>{TIER_LABEL[sim.summary.overall_tier]}</span>}
                              </div>
                              {can("admin") && (
                                <button onClick={() => deleteSimulation(sim.id)} className="rounded px-2 py-0.5 text-[10px] border border-rose-400/20 text-rose-400/60 hover:bg-rose-500/10">Del</button>
                              )}
                            </div>
                          ))}
                        </div>
                      </div>
                    )}
                  </div>
                )}

                {/* ── PLAYBOOK TAB ── */}
                {recTab === "playbook" && (
                  <div className="space-y-4">
                    <div className="rounded-2xl border border-neutral-800 bg-neutral-900/70 p-4">
                      <div className="mb-3 text-sm font-semibold text-neutral-200">Generate Recovery Playbook</div>
                      <form onSubmit={generatePlaybook} className="space-y-3">
                        <div>
                          <label className="mb-1 block text-xs text-neutral-400">Service <span className="text-rose-400">*</span></label>
                          <select value={recPlaybookService} onChange={e => setRecPlaybookService(e.target.value)}
                            className="w-full rounded-lg border border-neutral-700 bg-neutral-900 px-3 py-1.5 text-sm text-neutral-200 focus:border-emerald-400/50 focus:outline-none">
                            <option value="">Select service…</option>
                            {recSimServices.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
                          </select>
                        </div>
                        <div>
                          <label className="mb-1 block text-xs text-neutral-400">Incident summary <span className="text-neutral-600">(optional)</span></label>
                          <input value={recPlaybookIncident} onChange={e => setRecPlaybookIncident(e.target.value)}
                            placeholder="e.g. Nextcloud is returning 502 after VM migration"
                            className="w-full rounded-lg border border-neutral-700 bg-neutral-900 px-3 py-1.5 text-sm text-neutral-200 focus:border-emerald-400/50 focus:outline-none" />
                        </div>
                        {recPlaybookError && <div className="rounded-lg border border-rose-400/20 bg-rose-500/10 px-3 py-2 text-xs text-rose-300">{recPlaybookError}</div>}
                        <button type="submit" disabled={recPlaybookRunning || !recPlaybookService}
                          className="rounded-lg border border-emerald-400/30 bg-emerald-500/10 px-4 py-2 text-xs text-emerald-300 hover:bg-emerald-500/20 disabled:opacity-50">
                          {recPlaybookRunning ? "Generating…" : "Generate Playbook"}
                        </button>
                      </form>
                    </div>

                    {recPlaybook && (
                      <div className="rounded-2xl border border-emerald-400/20 bg-neutral-900/70 p-4 space-y-4">
                        <div className="flex items-start justify-between gap-3">
                          <div>
                            <div className="text-base font-bold text-neutral-100">{recPlaybook.title}</div>
                            <div className="text-xs text-neutral-500">Generated {new Date(recPlaybook.generated_at).toLocaleString()}</div>
                          </div>
                          <div className="shrink-0 text-right text-xs text-neutral-500">
                            <div>{recPlaybook.summary.total_steps} step{recPlaybook.summary.total_steps !== 1 ? "s" : ""}</div>
                            <div>Est. RTO: {fmtRTO(recPlaybook.summary.estimated_rto_min)}</div>
                          </div>
                        </div>
                        <div className="rounded-lg border border-amber-400/20 bg-amber-500/5 px-3 py-2 text-xs text-amber-300/80">
                          <span className="font-medium">Incident:</span> {recPlaybook.incident_summary}
                        </div>
                        {recPlaybook.summary.blockers.length > 0 && (
                          <div className="rounded-lg border border-rose-400/20 bg-rose-500/5 p-3 space-y-1">
                            <div className="text-[10px] uppercase tracking-wider text-rose-400/70">Blockers — resolve before attempting restore</div>
                            {recPlaybook.summary.blockers.map((b, i) => <div key={i} className="text-xs text-rose-300/80">⛔ {b}</div>)}
                          </div>
                        )}
                        <div className="space-y-3">
                          {recPlaybook.sections.map(sec => (
                            <div key={sec.service_id} className={["rounded-xl border p-4", sec.is_target ? "border-emerald-400/20 bg-emerald-500/5" : "border-neutral-800 bg-neutral-900/40"].join(" ")}>
                              <div className="mb-2 flex items-center justify-between gap-2">
                                <div className="flex items-center gap-2">
                                  <span className="h-5 w-5 shrink-0 rounded-full border border-emerald-400/30 bg-emerald-500/20 text-center text-[10px] leading-5 text-emerald-300 font-bold">{sec.step}</span>
                                  <span className="text-sm font-medium text-neutral-200">{sec.service_name}</span>
                                  {!sec.is_target && <span className="text-[10px] text-neutral-600">dependency</span>}
                                  {sec.is_target && <span className="text-[10px] text-emerald-500/70">target</span>}
                                </div>
                                <span className="text-xs text-neutral-500">{sec.rto_min != null ? fmtRTO(sec.rto_min) : "RTO unknown"}</span>
                              </div>
                              {sec.backup_source && (
                                <div className="mb-2 rounded border border-neutral-800 bg-neutral-900/60 px-2 py-1 text-[10px] text-neutral-400 font-mono">{sec.backup_source}</div>
                              )}
                              {sec.warnings.length > 0 && sec.warnings.map((w, i) => <div key={i} className="mb-1 text-xs text-rose-300/80">⚠ {w}</div>)}
                              <ol className="ml-4 list-decimal space-y-1 text-xs text-neutral-400 marker:text-neutral-700">
                                {sec.instructions.map((instr, i) => (
                                  <li key={i} className={instr.startsWith("⚠") ? "text-amber-300/80" : ""}>{instr}</li>
                                ))}
                              </ol>
                              {sec.runbook_url && (
                                <a href={sec.runbook_url} target="_blank" rel="noreferrer"
                                  className="mt-2 inline-block rounded border border-emerald-400/20 px-2 py-0.5 text-[10px] text-emerald-400/70 hover:text-emerald-300">
                                  Open Runbook ↗
                                </a>
                              )}
                            </div>
                          ))}
                        </div>
                      </div>
                    )}
                  </div>
                )}

                {/* ── RESTORE TESTS TAB ── */}
                {recTab === "tests" && (
                  <div className="space-y-4">
                    <div className="flex items-center justify-between">
                      <div className="text-xs text-neutral-500">{recTests.length} test record{recTests.length !== 1 ? "s" : ""}</div>
                      {can("operator") && (
                        <button onClick={() => { setShowAddTestModal(true); setAddTestError(null); setAddTestForm({ service_id: "", test_type: "dry_run", outcome: "passed", rto_actual_min: "", notes: "" }); }}
                          className="rounded-lg border border-emerald-400/30 bg-emerald-500/10 px-3 py-1 text-xs text-emerald-300 hover:bg-emerald-500/20">
                          + Record Test
                        </button>
                      )}
                    </div>
                    {recTestsLoading && <div className="py-8 text-center text-xs text-neutral-500">Loading…</div>}
                    {!recTestsLoading && recTests.length === 0 && (
                      <div className="rounded-2xl border border-neutral-800 bg-neutral-900/70 px-6 py-10 text-center">
                        <div className="text-sm text-neutral-500">No restore tests recorded yet.</div>
                        <div className="mt-1 text-xs text-neutral-600">A passed test within 90 days adds 15 pts to the confidence score.</div>
                      </div>
                    )}
                    {recTests.length > 0 && (
                      <div className="overflow-hidden rounded-2xl border border-neutral-800">
                        <table className="w-full text-xs">
                          <thead>
                            <tr className="border-b border-neutral-800 bg-neutral-900/60 text-left text-neutral-500">
                              <th className="px-3 py-2.5 font-medium">Service</th>
                              <th className="px-3 py-2.5 font-medium">Type</th>
                              <th className="px-3 py-2.5 font-medium">Outcome</th>
                              <th className="px-3 py-2.5 font-medium">Actual RTO</th>
                              <th className="px-3 py-2.5 font-medium">By</th>
                              <th className="px-3 py-2.5 font-medium">Date</th>
                              <th className="px-3 py-2.5 font-medium">Notes</th>
                              {can("admin") && <th className="px-3 py-2.5"></th>}
                            </tr>
                          </thead>
                          <tbody className="divide-y divide-neutral-800/50">
                            {recTests.map(t => (
                              <tr key={t.id} className="hover:bg-neutral-800/30">
                                <td className="px-3 py-2 font-medium text-neutral-200">{t.service_name || "—"}</td>
                                <td className="px-3 py-2 font-mono text-neutral-400">{t.test_type}</td>
                                <td className="px-3 py-2">
                                  <span className={["rounded-full border px-2 py-px text-[10px] font-medium",
                                    t.outcome === "passed" ? "border-emerald-400/30 bg-emerald-500/10 text-emerald-300" :
                                    t.outcome === "partial" ? "border-amber-400/30 bg-amber-500/10 text-amber-300" :
                                    "border-rose-400/30 bg-rose-500/10 text-rose-300"].join(" ")}>
                                    {t.outcome}
                                  </span>
                                </td>
                                <td className="px-3 py-2 text-neutral-400">{t.rto_actual_min != null ? `${t.rto_actual_min}m` : "—"}</td>
                                <td className="px-3 py-2 text-neutral-400">{t.tested_by}</td>
                                <td className="px-3 py-2 text-neutral-400">{new Date(t.tested_at).toLocaleDateString()}</td>
                                <td className="px-3 py-2 text-neutral-500 max-w-[120px] truncate" title={t.notes || ""}>{t.notes || "—"}</td>
                                {can("admin") && (
                                  <td className="px-3 py-2">
                                    <button onClick={() => deleteRestoreTest(t.id)} className="rounded px-1.5 py-0.5 text-[10px] border border-rose-400/20 text-rose-400/60 hover:bg-rose-500/10">Del</button>
                                  </td>
                                )}
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    )}

                    {/* Add restore test modal */}
                    {showAddTestModal && (
                      <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4">
                        <div className="flex max-h-[90vh] w-full max-w-md flex-col rounded-2xl border border-emerald-400/20 bg-neutral-950 shadow-2xl">
                          <div className="flex shrink-0 items-center justify-between border-b border-neutral-800 px-6 py-4">
                            <div className="text-base font-semibold">Record Restore Test</div>
                            <button onClick={() => setShowAddTestModal(false)} className="text-neutral-500 hover:text-white text-lg">✕</button>
                          </div>
                          <form onSubmit={saveRestoreTest} className="flex flex-col flex-1 overflow-hidden">
                            <div className="flex-1 overflow-y-auto px-6 py-4 space-y-3 text-sm">
                              <div>
                                <label className="mb-1 block text-xs text-neutral-400">Service <span className="text-rose-400">*</span></label>
                                <select value={addTestForm.service_id} onChange={e => setAddTestForm(f => ({ ...f, service_id: e.target.value }))}
                                  className="w-full rounded-lg border border-neutral-700 bg-neutral-900 px-3 py-1.5 text-sm text-neutral-200 focus:border-emerald-400/50 focus:outline-none">
                                  <option value="">Select…</option>
                                  {recSimServices.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
                                </select>
                              </div>
                              <div className="grid grid-cols-2 gap-3">
                                <div>
                                  <label className="mb-1 block text-xs text-neutral-400">Test type</label>
                                  <select value={addTestForm.test_type} onChange={e => setAddTestForm(f => ({ ...f, test_type: e.target.value }))}
                                    className="w-full rounded-lg border border-neutral-700 bg-neutral-900 px-3 py-1.5 text-sm text-neutral-200 focus:border-emerald-400/50 focus:outline-none">
                                    <option value="dry_run">Dry run</option>
                                    <option value="partial">Partial</option>
                                    <option value="full">Full</option>
                                  </select>
                                </div>
                                <div>
                                  <label className="mb-1 block text-xs text-neutral-400">Outcome</label>
                                  <select value={addTestForm.outcome} onChange={e => setAddTestForm(f => ({ ...f, outcome: e.target.value }))}
                                    className="w-full rounded-lg border border-neutral-700 bg-neutral-900 px-3 py-1.5 text-sm text-neutral-200 focus:border-emerald-400/50 focus:outline-none">
                                    <option value="passed">Passed</option>
                                    <option value="partial">Partial</option>
                                    <option value="failed">Failed</option>
                                  </select>
                                </div>
                              </div>
                              <div>
                                <label className="mb-1 block text-xs text-neutral-400">Actual RTO <span className="text-neutral-600">(minutes, optional)</span></label>
                                <input type="number" value={addTestForm.rto_actual_min} onChange={e => setAddTestForm(f => ({ ...f, rto_actual_min: e.target.value }))}
                                  placeholder="e.g. 45"
                                  className="w-full rounded-lg border border-neutral-700 bg-neutral-900 px-3 py-1.5 text-sm text-neutral-200 focus:border-emerald-400/50 focus:outline-none" />
                              </div>
                              <div>
                                <label className="mb-1 block text-xs text-neutral-400">Notes <span className="text-neutral-600">(optional)</span></label>
                                <textarea value={addTestForm.notes} onChange={e => setAddTestForm(f => ({ ...f, notes: e.target.value }))}
                                  rows={2} placeholder="e.g. Restored from B2 to staging — data intact, took 38min"
                                  className="w-full rounded-lg border border-neutral-700 bg-neutral-900 px-3 py-1.5 text-sm text-neutral-200 focus:border-emerald-400/50 focus:outline-none resize-none" />
                              </div>
                              {addTestError && <div className="rounded-lg border border-rose-400/20 bg-rose-500/10 px-3 py-2 text-xs text-rose-300">{addTestError}</div>}
                            </div>
                            <div className="flex justify-end gap-2 border-t border-neutral-800 px-6 py-4">
                              <button type="button" onClick={() => setShowAddTestModal(false)}
                                className="rounded-lg border border-neutral-700 px-4 py-2 text-xs text-neutral-400 hover:text-white">Cancel</button>
                              <button type="submit" disabled={addTestSaving || !addTestForm.service_id}
                                className="rounded-lg border border-emerald-400/30 bg-emerald-500/10 px-4 py-2 text-xs text-emerald-300 hover:bg-emerald-500/20 disabled:opacity-50">
                                {addTestSaving ? "Saving…" : "Save Test"}
                              </button>
                            </div>
                          </form>
                        </div>
                      </div>
                    )}
                  </div>
                )}
              </div>
            );
          })()}

          {activeBoard === "Intelligence" && (() => {
            const SIG_STYLES = {
              critical: "border-rose-400/30 bg-rose-500/10 text-rose-300",
              warning:  "border-amber-400/30 bg-amber-500/10 text-amber-300",
              info:     "border-sky-400/30 bg-sky-500/10 text-sky-300",
            };
            const SIG_LABELS = { down_spike: "Down Spike", degrading: "Degrading", latency_spike: "Latency Spike", intermittent: "Intermittent", latency_trending: "Latency Trending", auth_failure_burst: "Login Attack", resource_trending: "Resource Trending" };

            const runScan = async () => {
              setIntelScanRunning(true); setIntelScanResult(null);
              try {
                const r = await fetch(`${API_BASE}/api/intelligence/scan`, { method: "POST" });
                const d = await r.json();
                setIntelScanResult(d);
                // Refresh signals after scan
                setIntelSignals(null);
                fetch(`${API_BASE}/api/intelligence/signals?hours=24`)
                  .then(r2 => r2.json()).then(d2 => { if (d2.ok) setIntelSignals(d2); }).catch(() => {});
              } catch { setIntelScanResult({ ok: false, error: "Request failed" }); }
              finally { setIntelScanRunning(false); }
            };

            const approveProposal = async (id) => {
              setIntelApproving(id);
              try {
                const r = await fetch(`${API_BASE}/api/intelligence/proposals/${id}/approve`, { method: "POST" });
                const d = await r.json();
                setIntelProposals(null); // force reload
              } catch {}
              finally { setIntelApproving(null); }
            };

            const dismissProposal = async (id) => {
              setIntelDismissing(id);
              try {
                await fetch(`${API_BASE}/api/intelligence/proposals/${id}/dismiss`, { method: "POST" });
                setIntelProposals(null);
              } catch {}
              finally { setIntelDismissing(null); }
            };

            const runIncidentResponse = async (serviceId, description) => {
              setIncidentRunning(serviceId);
              setIncidentPlan(null);
              try {
                const r = await fetch(`${API_BASE}/api/recovery/playbook`, {
                  method: "POST",
                  headers: { "Content-Type": "application/json" },
                  body: JSON.stringify({ service_id: serviceId, incident_summary: description }),
                });
                const d = await r.json();
                setIncidentPlan(d.ok ? d : { ok: false, error: d.error || "Request failed" });
              } catch {
                setIncidentPlan({ ok: false, error: "Request failed" });
              } finally {
                setIncidentRunning(null);
              }
            };

            const togglePolicy = async (policy) => {
              setIntelTogglingPolicy(policy.id);
              try {
                const r = await fetch(`${API_BASE}/api/intelligence/autonomous/${policy.id}`, {
                  method: "PATCH",
                  headers: { "Content-Type": "application/json" },
                  body: JSON.stringify({ enabled: !policy.enabled }),
                });
                const d = await r.json();
                if (d.ok) setIntelPolicies(prev => prev ? { ...prev, policies: prev.policies.map(p => p.id === policy.id ? d.policy : p) } : null);
              } catch {}
              finally { setIntelTogglingPolicy(null); }
            };

            return (
              <div className="space-y-4">
                {/* Header */}
                <div className="rounded-2xl border border-sky-400/30 bg-gradient-to-r from-sky-500/15 via-violet-500/10 to-indigo-500/10 p-4">
                  <div className="flex items-center justify-between">
                    <div>
                      <div className="text-xs uppercase tracking-wider text-sky-300/80">Autonomous Operations</div>
                      <div className="text-lg font-semibold">Intelligence Engine</div>
                      <div className="mt-1 text-xs text-neutral-400">Signal detection · Remediation proposals · Autonomous execution</div>
                    </div>
                    <button
                      onClick={runScan}
                      disabled={intelScanRunning}
                      className="rounded-lg border border-sky-400/20 bg-sky-500/10 px-3 py-1.5 text-xs font-medium text-sky-300 hover:bg-sky-500/20 disabled:opacity-50"
                    >
                      {intelScanRunning ? "Scanning…" : "Run Scan"}
                    </button>
                  </div>
                  {intelScanResult && (
                    <div className={`mt-3 rounded-lg border px-3 py-2 text-xs ${intelScanResult.ok ? "border-emerald-400/30 bg-emerald-500/10 text-emerald-300" : "border-rose-400/30 bg-rose-500/10 text-rose-300"}`}>
                      {intelScanResult.ok
                        ? `Scan complete — ${intelScanResult.new_signals} new signal(s), ${intelScanResult.new_proposals} proposal(s), ${intelScanResult.executed} auto-executed`
                        : `Scan failed: ${intelScanResult.error}`}
                    </div>
                  )}
                </div>

                {/* Summary counts */}
                {intelSignals && (
                  <div className="grid grid-cols-3 gap-3">
                    {[
                      { label: "Critical", count: intelSignals.counts?.critical || 0, color: "rose" },
                      { label: "Warning",  count: intelSignals.counts?.warning  || 0, color: "amber" },
                      { label: "Total",    count: intelSignals.counts?.total    || 0, color: "sky"   },
                    ].map(({ label, count, color }) => (
                      <div key={label} className={`rounded-xl border border-${color}-400/20 bg-${color}-500/10 p-3 text-center`}>
                        <div className={`text-2xl font-bold text-${color}-300`}>{count}</div>
                        <div className="text-xs text-neutral-400">{label}</div>
                      </div>
                    ))}
                  </div>
                )}

                {/* Tab nav */}
                <div className="flex gap-1 rounded-xl border border-neutral-700/40 bg-neutral-800/40 p-1">
                  {[
                    { id: "signals",    label: "Signals" },
                    { id: "proposals",  label: "Proposals" },
                    { id: "autonomous", label: "Autonomous" },
                  ].map(t => (
                    <button
                      key={t.id}
                      onClick={() => setIntelTab(t.id)}
                      className={`flex-1 rounded-lg px-3 py-1.5 text-xs font-medium transition-all ${intelTab === t.id ? "bg-gradient-to-r from-sky-400 to-violet-500 text-black shadow" : "text-neutral-400 hover:text-neutral-200"}`}
                    >
                      {t.label}
                    </button>
                  ))}
                </div>

                {/* ── Signals tab ─────────────────────────────────────────── */}
                {intelTab === "signals" && (
                  <div className="space-y-2">
                    {intelSignalsLoading && <div className="py-8 text-center text-xs text-neutral-500">Loading signals…</div>}
                    {!intelSignalsLoading && intelSignals && intelSignals.signals?.length === 0 && (
                      <div className="rounded-xl border border-emerald-400/20 bg-emerald-500/10 py-8 text-center text-sm text-emerald-300">
                        No active signals — estate looks healthy
                      </div>
                    )}
                    {!intelSignalsLoading && intelSignals && intelSignals.signals?.map(sig => (
                      <div key={sig.id} className={`rounded-xl border p-3 ${SIG_STYLES[sig.severity] || SIG_STYLES.info}`}>
                        <div className="flex items-start justify-between gap-2">
                          <div className="min-w-0 flex-1">
                            <div className="flex items-center gap-2">
                              <span className="text-xs font-semibold uppercase">{sig.severity}</span>
                              <span className="rounded bg-neutral-800/60 px-1.5 py-0.5 text-xs text-neutral-300">{SIG_LABELS[sig.signal_type] || sig.signal_type}</span>
                              {sig.resolved_at && <span className="rounded bg-emerald-500/20 px-1.5 py-0.5 text-xs text-emerald-300">Resolved</span>}
                              {sig.acknowledged && !sig.resolved_at && <span className="rounded bg-sky-500/20 px-1.5 py-0.5 text-xs text-sky-300">Ack'd</span>}
                            </div>
                            <div className="mt-1 text-sm font-medium">{sig.service_name}</div>
                            <div className="mt-0.5 text-xs opacity-80">{sig.detail}</div>
                            <div className="mt-1 text-xs opacity-60">{new Date(sig.fired_at).toLocaleString()}</div>
                          </div>
                          <div className="flex shrink-0 flex-col gap-1">
                            {!sig.acknowledged && !sig.resolved_at && (
                              <button
                                onClick={() => {
                                  fetch(`${API_BASE}/api/intelligence/signals/${sig.id}/ack`, { method: "POST" })
                                    .then(r => r.json())
                                    .then(d => { if (d.ok) setIntelSignals(prev => prev ? { ...prev, signals: prev.signals.map(s => s.id === sig.id ? { ...s, acknowledged: true } : s) } : null); })
                                    .catch(() => {});
                                }}
                                className="rounded-lg border border-current/20 bg-black/20 px-2 py-1 text-xs hover:bg-black/40"
                              >
                                Ack
                              </button>
                            )}
                            {sig.service_id && (
                              <button
                                onClick={() => runIncidentResponse(sig.service_id, sig.detail)}
                                disabled={incidentRunning === sig.service_id}
                                className="rounded-lg border border-current/20 bg-black/20 px-2 py-1 text-xs hover:bg-black/40 disabled:opacity-50"
                              >
                                {incidentRunning === sig.service_id ? "…" : "Recovery Plan"}
                              </button>
                            )}
                          </div>
                        </div>
                      </div>
                    ))}
                    {!intelSignalsLoading && !intelSignals && (
                      <button onClick={() => { setIntelSignalsLoading(true); fetch(`${API_BASE}/api/intelligence/signals?hours=24`).then(r=>r.json()).then(d=>{ if(d.ok) setIntelSignals(d); }).catch(()=>{}).finally(()=>setIntelSignalsLoading(false)); }} className="w-full rounded-xl border border-sky-400/20 py-4 text-xs text-sky-400 hover:bg-sky-500/10">
                        Load signals
                      </button>
                    )}
                  </div>
                )}

                {/* ── Proposals tab ───────────────────────────────────────── */}
                {intelTab === "proposals" && (
                  <div className="space-y-3">
                    {/* Filter */}
                    <div className="flex gap-1 rounded-lg border border-neutral-700/40 bg-neutral-800/40 p-1">
                      {["pending", "executed", "dismissed", "all"].map(f => (
                        <button
                          key={f}
                          onClick={() => { setIntelPropFilter(f); setIntelProposals(null); }}
                          className={`flex-1 rounded px-2 py-1 text-xs capitalize transition-all ${intelPropFilter === f ? "bg-sky-500/20 text-sky-300" : "text-neutral-500 hover:text-neutral-300"}`}
                        >
                          {f}
                        </button>
                      ))}
                    </div>
                    {intelProposalsLoading && <div className="py-8 text-center text-xs text-neutral-500">Loading…</div>}
                    {!intelProposalsLoading && intelProposals && intelProposals.proposals?.length === 0 && (
                      <div className="py-6 text-center text-xs text-neutral-500">No {intelPropFilter} proposals</div>
                    )}
                    {!intelProposalsLoading && intelProposals && intelProposals.proposals?.map(prop => (
                      <div key={prop.id} className="rounded-xl border border-neutral-700/50 bg-neutral-800/50 p-3">
                        <div className="flex items-start justify-between gap-2">
                          <div className="min-w-0 flex-1">
                            <div className="flex items-center gap-2">
                              <span className={`rounded px-1.5 py-0.5 text-xs font-medium ${
                                prop.status === "pending"  ? "bg-amber-500/20 text-amber-300" :
                                prop.status === "executed" ? "bg-emerald-500/20 text-emerald-300" :
                                prop.status === "failed"   ? "bg-rose-500/20 text-rose-300" :
                                "bg-neutral-700/60 text-neutral-400"
                              }`}>{prop.status}</span>
                              <span className="rounded bg-sky-500/10 px-1.5 py-0.5 text-xs text-sky-300">{prop.action_type}</span>
                              {prop.requires_approval && <span className="rounded bg-amber-500/10 px-1.5 py-0.5 text-xs text-amber-400">Approval required</span>}
                            </div>
                            <div className="mt-1 text-sm font-medium">{prop.service_name}</div>
                            <div className="mt-0.5 text-xs text-neutral-400">{prop.rationale}</div>
                            {prop.result && (
                              <div className="mt-1 rounded bg-neutral-900/60 px-2 py-1 font-mono text-xs text-neutral-400">
                                {typeof prop.result === "string" ? prop.result : JSON.stringify(prop.result).slice(0, 120)}
                              </div>
                            )}
                            <div className="mt-1 text-xs text-neutral-600">{new Date(prop.proposed_at).toLocaleString()}</div>
                          </div>
                          <div className="flex shrink-0 flex-col gap-1">
                            {prop.status === "pending" && (
                              <>
                                <button
                                  onClick={() => approveProposal(prop.id)}
                                  disabled={!!intelApproving || !!intelDismissing}
                                  className="rounded-lg border border-emerald-400/30 bg-emerald-500/10 px-2 py-1 text-xs text-emerald-300 hover:bg-emerald-500/20 disabled:opacity-50"
                                >
                                  {intelApproving === prop.id ? "Executing…" : "Approve"}
                                </button>
                                <button
                                  onClick={() => dismissProposal(prop.id)}
                                  disabled={!!intelApproving || !!intelDismissing}
                                  className="rounded-lg border border-neutral-600/30 bg-neutral-700/30 px-2 py-1 text-xs text-neutral-400 hover:bg-neutral-700/50 disabled:opacity-50"
                                >
                                  {intelDismissing === prop.id ? "…" : "Dismiss"}
                                </button>
                              </>
                            )}
                            <button
                              onClick={() => runIncidentResponse(prop.service_id, prop.rationale)}
                              disabled={incidentRunning === prop.service_id}
                              className="rounded-lg border border-sky-400/20 bg-sky-500/10 px-2 py-1 text-xs text-sky-300 hover:bg-sky-500/20 disabled:opacity-50"
                            >
                              {incidentRunning === prop.service_id ? "…" : "Recovery Plan"}
                            </button>
                          </div>
                        </div>
                      </div>
                    ))}
                  </div>
                )}

                {/* ── Autonomous tab ──────────────────────────────────────── */}
                {intelTab === "autonomous" && (
                  <div className="space-y-3">
                    <div className="rounded-xl border border-amber-400/20 bg-amber-500/10 px-3 py-2 text-xs text-amber-300">
                      Autonomous policies are <strong>disabled by default</strong>. Enabling health.refresh is safe — the engine will re-probe services matching that signal. Enable container.restart only if you are confident in the container_name field on each service.
                    </div>
                    {intelPoliciesLoading && <div className="py-8 text-center text-xs text-neutral-500">Loading policies…</div>}
                    {!intelPoliciesLoading && intelPolicies && intelPolicies.policies?.map(policy => (
                      <div key={policy.id} className="rounded-xl border border-neutral-700/50 bg-neutral-800/50 p-3">
                        <div className="flex items-center justify-between gap-3">
                          <div className="min-w-0 flex-1">
                            <div className="flex items-center gap-2">
                              <span className="rounded bg-sky-500/10 px-1.5 py-0.5 text-xs text-sky-300">{policy.signal_type}</span>
                              <span className="text-xs text-neutral-500">→</span>
                              <span className="rounded bg-violet-500/10 px-1.5 py-0.5 text-xs text-violet-300">{policy.action_type}</span>
                            </div>
                            <div className="mt-1 text-xs text-neutral-400">{policy.description}</div>
                            <div className="mt-1 text-xs text-neutral-600">
                              Max {policy.max_per_hour}/hr · cooldown {Math.round(policy.cooldown_secs / 60)}min
                            </div>
                          </div>
                          <button
                            onClick={() => togglePolicy(policy)}
                            disabled={intelTogglingPolicy === policy.id}
                            className={`shrink-0 rounded-lg border px-3 py-1.5 text-xs font-medium transition-all disabled:opacity-50 ${
                              policy.enabled
                                ? "border-emerald-400/30 bg-emerald-500/15 text-emerald-300 hover:bg-emerald-500/25"
                                : "border-neutral-600/40 bg-neutral-700/30 text-neutral-400 hover:bg-neutral-700/50"
                            }`}
                          >
                            {intelTogglingPolicy === policy.id ? "…" : policy.enabled ? "Enabled" : "Disabled"}
                          </button>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            );
          })()}

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
                        {emergencyStatus.maintenanceMode.endsAt && (
                          <div className="mt-0.5 text-[11px] text-amber-300/80">
                            Expires {new Date(emergencyStatus.maintenanceMode.endsAt).toLocaleTimeString()} · {emergencyStatus.maintenanceMode.durationSecs >= 3600 ? `${emergencyStatus.maintenanceMode.durationSecs / 3600}h` : `${emergencyStatus.maintenanceMode.durationSecs / 60}m`}
                          </div>
                        )}
                        {!emergencyStatus.maintenanceMode.endsAt && (
                          <div className="mt-0.5 text-[11px] text-amber-300/60">No auto-expiry set</div>
                        )}
                        {emergencyStatus.maintenanceMode.reason && (
                          <div className="mt-0.5 text-[11px] text-amber-300/60">{emergencyStatus.maintenanceMode.reason}</div>
                        )}
                      </div>
                      {/* Never let this box go unrendered when suppression failed -- a
                          silent gap here is exactly the misleading-toggle class of bug
                          found elsewhere in this app (Emergency board policy enforcement,
                          the down_spike autonomous-restart toggle). */}
                      <div className={[
                        "rounded-lg border px-3 py-2 text-[11px]",
                        emergencyStatus.maintenanceMode.grafanaSilence?.ok
                          ? "border-emerald-400/20 bg-emerald-500/5 text-emerald-300/80"
                          : "border-rose-400/20 bg-rose-500/5 text-rose-300/80",
                      ].join(" ")}>
                        {emergencyStatus.maintenanceMode.grafanaSilence?.ok
                          ? "Ntfy/email alerts suppressed via Grafana silence — resumes automatically on expiry"
                          : `Alert suppression NOT active — ${emergencyStatus.maintenanceMode.grafanaSilence?.error || "unknown reason"}`}
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
                      <div className="grid grid-cols-2 gap-2">
                        <select
                          value={maintenanceDuration}
                          onChange={(e) => setMaintenanceDuration(e.target.value)}
                          className="rounded-lg border border-neutral-700 bg-neutral-800/60 px-2 py-1.5 text-xs text-neutral-200 outline-none focus:border-amber-400/30">
                          <option value="1h">1 hour</option>
                          <option value="4h">4 hours</option>
                          <option value="8h">8 hours</option>
                          <option value="24h">24 hours</option>
                        </select>
                        <input
                          value={maintenanceReason}
                          onChange={(e) => setMaintenanceReason(e.target.value)}
                          placeholder="Reason (optional)"
                          className="rounded-lg border border-neutral-700 bg-neutral-800/60 px-2 py-1.5 text-xs text-neutral-200 placeholder:text-neutral-600 outline-none focus:border-amber-400/30"
                        />
                      </div>
                      <button
                        onClick={() => runEmergencyAction("maintenance.enable", { duration: maintenanceDuration, reason: maintenanceReason || undefined })}
                        disabled={!!emergencyPending || !can("admin")}
                        title={!can("admin") ? "Requires admin role" : undefined}
                        className="w-full rounded-lg border border-amber-400/20 bg-amber-500/10 px-3 py-2 text-xs text-amber-300 hover:bg-amber-500/20 disabled:opacity-40 disabled:cursor-not-allowed"
                      >
                        {emergencyPending === "maintenance.enable" ? "Enabling…" : `Enable Maintenance (${maintenanceDuration})`}
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
