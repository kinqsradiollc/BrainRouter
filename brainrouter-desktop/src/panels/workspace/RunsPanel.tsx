/**
 * ADR-040 A40-10 — Desktop Runs.
 *
 * This renders the SAME projection the CLI's `/runs` renders. Neither host
 * decides what a run looks like; Core's `runsView` does. Two surfaces
 * formatting the same events independently is how they come to disagree about
 * whether something failed, and the person is then left working out which one
 * to believe.
 *
 * The accessible fallback is a list, and the list is the primary. A graph is a
 * nicety; a run you cannot read with a screen reader is a run you cannot
 * inspect at all.
 */
import React from 'react';
import { bridgeQuery } from '../../lib/bridgeQuery.js';
// ADR-040 A40-10 — the row/detail/preview shapes are Core's `runsView` types, not
// a second copy. A type-only import (erased at build, so it never pulls Core's
// node-side runStore into the renderer bundle) makes the "one projection, two
// hosts" guarantee compile-time-enforced: if Core's shape drifts, the panel stops
// compiling instead of silently disagreeing with the CLI.
import type { RunsListRow, RunDetailView, PlanPreview } from '@kinqs/brainrouter-core/orchestration/runs';

export type RunsRow = RunsListRow;
export type RunsDetail = RunDetailView;
export type RunsPreview = PlanPreview;

/**
 * Live-state vocabulary. `stale` is deliberately distinct from `error`: a
 * reconnecting panel still shows the last good answer, and saying so is not the
 * same as claiming a failure.
 */
export type RunsConnection = 'live' | 'stale' | 'error';

export function connectionNotice(connection: RunsConnection): string | null {
  if (connection === 'live') return null;
  if (connection === 'stale') return 'Reconnecting — showing the last runs this panel received.';
  return 'Runs are unavailable right now. Nothing below is current.';
}

/**
 * What a row is allowed to say. A summary-only row must not imply it has an
 * execution map behind it, or a person clicks through expecting detail that was
 * never retained.
 */
export function rowDetailLabel(row: Pick<RunsRow, 'detail'>): string {
  return row.detail === 'projected' ? 'Execution map' : 'Summary only';
}

export function statusTone(status: string): 'ok' | 'bad' | 'warn' | 'muted' {
  if (status === 'succeeded') return 'ok';
  if (status === 'failed' || status === 'blocked') return 'bad';
  if (status === 'interrupted' || status === 'cancelled') return 'warn';
  return 'muted';
}

/**
 * A40-10 live updates — the terminal-status predicate the panel polls on. Inlined
 * (not imported from Core) because Core's `isTerminalRunStatus` is a value on the
 * node-side runs subpath, and importing a value from it would pull the run store
 * into the renderer bundle. The set is small and pinned by a test against Core's.
 */
const TERMINAL_RUN_STATUSES: ReadonlySet<string> = new Set([
  'succeeded', 'failed', 'blocked', 'interrupted', 'cancelled', 'degraded',
]);

export function isRunTerminal(status: string): boolean {
  return TERMINAL_RUN_STATUSES.has(status);
}

/**
 * A40-10 preview/confirm — the one thing a person confirming a launch is owed:
 * whether it will spawn children, in words.
 */
export function previewChildrenSummary(preview: RunsPreview): string {
  return preview.createsChildren
    ? `Spawns child agents — up to ${preview.effectiveParallel} in parallel.`
    : 'Runs on the primary agent — no child agents.';
}

const POLL_INTERVAL_MS = 3_000;

export function RunsPanel(): React.ReactElement {
  const [rows, setRows] = React.useState<RunsRow[]>([]);
  const [connection, setConnection] = React.useState<RunsConnection>('live');
  const [selected, setSelected] = React.useState<RunsDetail | null>(null);

  // A40-10 explicit strategy launch.
  const [launchTask, setLaunchTask] = React.useState('');
  const [launchStrategy, setLaunchStrategy] = React.useState('');
  const [preview, setPreview] = React.useState<RunsPreview | null>(null);
  const [previewing, setPreviewing] = React.useState(false);

  const refreshList = React.useCallback(async () => {
    try {
      const result = await bridgeQuery<{ runs: RunsRow[] }>('runs.list', {});
      setRows(result?.runs ?? []);
      setConnection('live');
    } catch {
      // Keep whatever was already on screen: a failed refresh is not proof that
      // the previous answer was wrong.
      setConnection((prev) => (prev === 'live' ? 'stale' : 'error'));
    }
  }, []);

  const openDetail = React.useCallback(async (runId: string) => {
    try {
      const r = await bridgeQuery<{ run: RunsDetail }>('runs.detail', { runId });
      setSelected(r?.run ?? null);
    } catch {
      setSelected(null);
    }
  }, []);

  // A40-10 live/reconnect — poll the list, and the open run while it is still in
  // flight, instead of a one-shot mount fetch. A terminal run stops being re-read.
  React.useEffect(() => {
    let cancelled = false;
    void refreshList();
    const timer = setInterval(() => {
      if (cancelled) return;
      void refreshList();
      const openId = selected && !isRunTerminal(selected.status) ? selected.runId : null;
      if (openId) void openDetail(openId);
    }, POLL_INTERVAL_MS);
    return () => { cancelled = true; clearInterval(timer); };
  }, [refreshList, openDetail, selected]);

  const notice = connectionNotice(connection);

  const handlePreview = React.useCallback(async () => {
    if (!launchTask.trim()) return;
    setPreviewing(true);
    try {
      const r = await bridgeQuery<{ preview: RunsPreview | null }>('runs.preview', {
        task: launchTask,
        ...(launchStrategy.trim() ? { strategyId: launchStrategy.trim() } : {}),
      });
      setPreview(r?.preview ?? null);
    } catch {
      setPreview(null);
    } finally {
      setPreviewing(false);
    }
  }, [launchTask, launchStrategy]);

  const handleConfirmStart = React.useCallback(async () => {
    try {
      await bridgeQuery('runs.start', {
        task: launchTask,
        ...(launchStrategy.trim() ? { strategyId: launchStrategy.trim() } : {}),
      });
    } finally {
      setPreview(null);
      setLaunchTask('');
      setLaunchStrategy('');
      void refreshList();
    }
  }, [launchTask, launchStrategy, refreshList]);

  return (
    <div className="br-runs" aria-label="Runs">
      <h2>Runs</h2>
      {notice ? <p role="status" className="br-runs-notice">{notice}</p> : null}

      {/* A40-10 — explicit strategy launch: preview, then confirm before starting. */}
      <section className="br-runs-launch" aria-label="Run with strategy">
        <h3>Run with strategy</h3>
        <label>
          Task
          <input
            type="text"
            value={launchTask}
            aria-label="Task to run"
            placeholder="What should this run do?"
            onChange={(e) => { setLaunchTask(e.target.value); setPreview(null); }}
          />
        </label>
        <label>
          Strategy (optional)
          <input
            type="text"
            value={launchStrategy}
            aria-label="Strategy id (optional)"
            placeholder="leave blank to auto-select"
            onChange={(e) => { setLaunchStrategy(e.target.value); setPreview(null); }}
          />
        </label>
        {preview === null ? (
          <button type="button" disabled={!launchTask.trim() || previewing} onClick={() => void handlePreview()}>
            {previewing ? 'Previewing…' : 'Preview'}
          </button>
        ) : (
          <div className="br-runs-preview" role="group" aria-label="Strategy preview">
            <p className="br-runs-preview-strategy">
              Strategy: <strong>{preview.strategyId ?? '(direct)'}</strong> <em>[{preview.selectionSource}]</em>
            </p>
            <p className="br-runs-preview-children" data-warn={preview.createsChildren ? 'true' : 'false'}>
              {previewChildrenSummary(preview)}
            </p>
            <ol className="br-runs-preview-stages">
              {preview.stages.map((stage) => (
                <li key={stage.id}>
                  {stage.id} ({stage.executor})
                  {stage.requiresApproval ? ' — approval' : ''}
                  {stage.fanOut ? ` — fan-out ${stage.fanOut.min}-${stage.fanOut.max}` : ''}
                  {': '}{stage.objective}
                </li>
              ))}
            </ol>
            <button type="button" onClick={() => void handleConfirmStart()}>Confirm &amp; start</button>
            <button type="button" onClick={() => setPreview(null)}>Cancel</button>
          </div>
        )}
      </section>

      {rows.length === 0 ? (
        <p className="br-runs-empty">No runs recorded for this workspace yet.</p>
      ) : (
        <ul className="br-runs-list">
          {rows.map((row) => (
            <li key={row.runId}>
              <button
                type="button"
                data-tone={statusTone(row.status)}
                aria-label={`${row.runId}, ${row.status}, ${rowDetailLabel(row)}`}
                onClick={() => void openDetail(row.runId)}
              >
                <span className="br-runs-id">{row.runId}</span>
                <span className="br-runs-status">{row.status}</span>
                <span className="br-runs-detail">{rowDetailLabel(row)}</span>
              </button>
            </li>
          ))}
        </ul>
      )}

      {selected ? (
        <section className="br-runs-detail-pane" aria-label={`Run ${selected.runId}`}>
          <h3>{selected.runId}</h3>
          {selected.goalId ? <p className="br-runs-goal">Goal: {selected.goalId}</p> : null}
          {selected.caveat ? <p role="status">{selected.caveat}</p> : null}
          {selected.nodes.length === 0 ? null : (
            <ol>
              {selected.nodes.map((node) => (
                <li key={`${node.nodeId}#${node.attempt}@${node.iterationPath.join('.')}`}>
                  {node.nodeId}
                  {node.iterationPath.length ? ` @${node.iterationPath.join('.')}` : ''}
                  {' — '}
                  {node.status}
                  {node.attempt > 1 ? ` (attempt ${node.attempt})` : ''}
                  {node.childSessionIds.length ? (
                    <ul className="br-runs-children" aria-label={`Child sessions of ${node.nodeId}`}>
                      {node.childSessionIds.map((child) => (
                        <li key={child}>
                          <button
                            type="button"
                            className="br-runs-child"
                            aria-label={`Open transcript ${child}`}
                            onClick={() => void bridgeQuery('session.open', { sessionKey: child }).catch(() => {})}
                          >
                            ↳ {child}
                          </button>
                        </li>
                      ))}
                    </ul>
                  ) : null}
                </li>
              ))}
            </ol>
          )}
        </section>
      ) : null}
    </div>
  );
}
