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
// ADR-040 A40-10 — the row/detail shapes are Core's `runsView` types, not a
// second copy. A type-only import (erased at build, so it never pulls Core's
// node-side runStore into the renderer bundle) makes the "one projection, two
// hosts" guarantee compile-time-enforced: if Core's shape drifts, the panel
// stops compiling instead of silently disagreeing with the CLI.
import type { RunsListRow, RunDetailView } from '@kinqs/brainrouter-core/orchestration/runs';

export type RunsRow = RunsListRow;
export type RunsDetail = RunDetailView;

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

export function RunsPanel(): React.ReactElement {
  const [rows, setRows] = React.useState<RunsRow[]>([]);
  const [connection, setConnection] = React.useState<RunsConnection>('live');
  const [selected, setSelected] = React.useState<RunsDetail | null>(null);

  React.useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const result = await bridgeQuery<{ runs: RunsRow[] }>('runs.list', {});
        if (cancelled) return;
        setRows(result?.runs ?? []);
        setConnection('live');
      } catch {
        // Keep whatever was already on screen: a failed refresh is not proof
        // that the previous answer was wrong.
        if (!cancelled) setConnection((prev) => (prev === 'live' ? 'stale' : 'error'));
      }
    })();
    return () => { cancelled = true; };
  }, []);

  const notice = connectionNotice(connection);

  return (
    <div className="br-runs" aria-label="Runs">
      <h2>Runs</h2>
      {notice ? <p role="status" className="br-runs-notice">{notice}</p> : null}

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
                onClick={() => {
                  void bridgeQuery<{ run: RunsDetail }>('runs.detail', { runId: row.runId })
                    .then((r) => setSelected(r?.run ?? null))
                    .catch(() => setSelected(null));
                }}
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
                </li>
              ))}
            </ol>
          )}
        </section>
      ) : null}
    </div>
  );
}
