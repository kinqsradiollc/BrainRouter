/**
 * ADR-041 D14 (#2/#3/#4) — the Trajectory panel: a turn-by-turn ledger of the
 * active session. Each STEP shows the model, its wall-clock duration, token
 * usage, and the tools it requested — each tagged with a semantic render intent
 * (terminal / diff / read / search / web). Interleaved LOG-ONLY events (#4) — tool
 * approvals and compaction brackets — are rendered too, so "what the model knew"
 * and "what happened" are separately visible; a step whose context a later
 * compaction dropped is shown dimmed (shadowed). Self-contained: reads the LOCAL
 * session sidecar over one bridgeQuery (`trajectory:read`) — the ledger lives on
 * this machine, so a server-side brain cannot see it; the desktop can. Opt-in via
 * `cli.traceTrajectory`; when off and empty, the panel says how to turn it on.
 *
 * Row shapes are mirrored locally (not imported from core) so the renderer bundle
 * never pulls a node-only module; the shadow overlay is applied host-side.
 */
import React from 'react';
import { bridgeQuery } from '../../lib/bridgeQuery.js';
import { usePanelPolling } from '../../lib/panels/usePanelPolling.js';

type RenderIntent = 'terminal' | 'diff' | 'read' | 'search' | 'web' | 'text';
type Visibility = 'model-visible' | 'log-only' | 'shadowed';

interface TrajectoryTool { name: string; intent: RenderIntent }

interface TrajectoryStep {
  kind: 'step';
  seq: number;
  model: string;
  at: string;
  durationMs?: number;
  tokensIn?: number;
  tokensOut?: number;
  tools: TrajectoryTool[];
  excerpt?: string;
  visibility: Visibility;
}

interface TrajectoryEvent {
  kind: 'event';
  seq: number;
  at: string;
  event: 'approval' | 'compaction';
  label: string;
  detail?: string;
  droppedMessages?: number;
  keptMessages?: number;
  visibility: 'log-only';
}

type TrajectoryRecord = TrajectoryStep | TrajectoryEvent;

interface TrajectoryReadResult { records: TrajectoryRecord[]; enabled: boolean }

function formatDuration(ms: number | undefined): string {
  if (typeof ms !== 'number') return '—';
  return ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`;
}

function StepRow({ step, open, onToggle }: { step: TrajectoryStep; open: boolean; onToggle: () => void }): React.ReactElement {
  const shadowed = step.visibility === 'shadowed';
  return (
    <React.Fragment>
      <div
        className="task-row"
        title={shadowed ? 'context dropped by a later compaction (shadowed)' : undefined}
        style={{ cursor: step.excerpt ? 'pointer' : 'default', opacity: shadowed ? 0.5 : 1 }}
        onClick={onToggle}
      >
        <span className="task-kind">step {step.seq}{shadowed ? ' · shadowed' : ''}</span>
        <span className="file-name">{step.model}</span>
        <span className="task-elapsed">
          {formatDuration(step.durationMs)}
          {step.tokensIn !== undefined || step.tokensOut !== undefined
            ? ` · ↑${step.tokensIn ?? 0} ↓${step.tokensOut ?? 0}`
            : ''}
        </span>
      </div>
      {step.tools.length > 0 ? (
        <div className="task-row" style={{ paddingTop: 0, gap: 6, flexWrap: 'wrap', opacity: shadowed ? 0.5 : 1 }}>
          {step.tools.map((t, i) => (
            <span key={`${step.seq}:${i}`} className="task-kind" title={`render intent: ${t.intent}`} style={{ opacity: 0.75 }}>
              {t.name}<span style={{ opacity: 0.6 }}> · {t.intent}</span>
            </span>
          ))}
        </div>
      ) : null}
      {open && step.excerpt ? (
        <div className="task-row" style={{ display: 'block' }}>
          <pre style={{ margin: 0, maxHeight: 200, overflow: 'auto', whiteSpace: 'pre-wrap', opacity: 0.8 }}>
            {step.excerpt}
          </pre>
        </div>
      ) : null}
    </React.Fragment>
  );
}

function EventRow({ ev }: { ev: TrajectoryEvent }): React.ReactElement {
  const icon = ev.event === 'compaction' ? '⋯' : '⚑';
  const counts = ev.event === 'compaction' && (ev.droppedMessages !== undefined || ev.keptMessages !== undefined)
    ? ` · dropped ${ev.droppedMessages ?? 0}, kept ${ev.keptMessages ?? 0}`
    : '';
  return (
    <div className="task-row" title={ev.detail ?? undefined} style={{ opacity: 0.7, fontStyle: 'italic' }}>
      <span className="task-kind">{icon} log-only</span>
      <span className="file-name">{ev.label}{counts}</span>
      <span className="task-elapsed">{ev.event}</span>
    </div>
  );
}

export function TrajectoryPanel({ active = true }: { active?: boolean }): React.ReactElement {
  const [records, setRecords] = React.useState<TrajectoryRecord[]>([]);
  const [enabled, setEnabled] = React.useState(true);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState('');
  const [openSeq, setOpenSeq] = React.useState<number | null>(null);

  const mounted = React.useRef(true);
  React.useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);

  const refresh = React.useCallback(async (): Promise<void> => {
    setBusy(true);
    try {
      const result = await bridgeQuery<TrajectoryReadResult>('trajectory:read', { limit: 80 }, 10_000);
      if (!mounted.current) return;
      setRecords(Array.isArray(result?.records) ? result.records : []);
      setEnabled(result?.enabled !== false);
      setError('');
    } catch (error) {
      if (mounted.current) setError((error as Error).message || 'Trajectory lookup failed.');
    } finally {
      if (mounted.current) setBusy(false);
    }
  }, []);

  usePanelPolling({ active, intervalMs: 3_000, refresh });

  const stepCount = records.filter((r) => r.kind === 'step').length;

  return (
    <div className="scroll">
      <div className="tasks-section">
        <span>Trajectory · {stepCount} step{stepCount === 1 ? '' : 's'}</span>
        <button className="tasks-clear" type="button" onClick={() => void refresh()} disabled={busy}>
          {busy ? 'Refreshing…' : 'Refresh'}
        </button>
      </div>
      {error ? <div className="empty error">{error}</div> : null}
      {!error && records.length === 0 && !enabled ? (
        <div className="empty">
          Trajectory tracing is off. Enable <code>cli.traceTrajectory</code> in Settings, then take a turn.
        </div>
      ) : null}
      {!error && records.length === 0 && enabled ? (
        <div className="empty">No trajectory recorded yet — take a turn and it will fill in.</div>
      ) : null}
      {records.map((r) => (
        r.kind === 'event'
          ? <EventRow key={`e${r.seq}`} ev={r} />
          : <StepRow key={`s${r.seq}`} step={r} open={openSeq === r.seq} onToggle={() => setOpenSeq((cur) => (cur === r.seq ? null : r.seq))} />
      ))}
    </div>
  );
}
