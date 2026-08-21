/**
 * ADR-041 D14 (#2/#3) — the Trajectory panel: a turn-by-turn ledger of the
 * active session's model calls. Each step shows the model, its wall-clock
 * duration, token usage, and the tools it requested — each tool tagged with a
 * semantic render intent (terminal / diff / read / search / web) rather than a
 * bare name. Self-contained: reads the LOCAL session sidecar over one bridgeQuery
 * (`trajectory:read`) — the ledger lives on this machine, so a server-side brain
 * cannot see it; the desktop can. Opt-in via `cli.traceTrajectory`; when it is
 * off and empty, the panel says how to turn it on.
 *
 * The row shape is mirrored locally (not imported from core) so the renderer
 * bundle never pulls a node-only module.
 */
import React from 'react';
import { bridgeQuery } from '../../lib/bridgeQuery.js';

type RenderIntent = 'terminal' | 'diff' | 'read' | 'search' | 'web' | 'text';

interface TrajectoryTool { name: string; intent: RenderIntent }

interface TrajectoryStep {
  seq: number;
  model: string;
  at: string;
  durationMs?: number;
  tokensIn?: number;
  tokensOut?: number;
  tools: TrajectoryTool[];
  excerpt?: string;
  visibility: 'model-visible' | 'log-only' | 'shadowed';
}

interface TrajectoryReadResult { records: TrajectoryStep[]; enabled: boolean }

const INTENT_LABEL: Record<RenderIntent, string> = {
  terminal: 'terminal',
  diff: 'diff',
  read: 'read',
  search: 'search',
  web: 'web',
  text: 'text',
};

function formatDuration(ms: number | undefined): string {
  if (typeof ms !== 'number') return '—';
  return ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`;
}

export function TrajectoryPanel(): React.ReactElement {
  const [steps, setSteps] = React.useState<TrajectoryStep[]>([]);
  const [enabled, setEnabled] = React.useState(true);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState('');
  const [openSeq, setOpenSeq] = React.useState<number | null>(null);

  const mounted = React.useRef(true);
  React.useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);

  const refresh = React.useCallback(() => {
    setBusy(true);
    void bridgeQuery<TrajectoryReadResult>('trajectory:read', { limit: 60 }, 10_000)
      .then((r) => {
        if (!mounted.current) return;
        setSteps(Array.isArray(r?.records) ? r.records : []);
        setEnabled(r?.enabled !== false);
        setError('');
      })
      .catch((err) => { if (mounted.current) setError((err as Error).message || 'Trajectory lookup failed.'); })
      .finally(() => { if (mounted.current) setBusy(false); });
  }, []);

  React.useEffect(() => {
    refresh();
    const t = setInterval(refresh, 3000);
    return () => clearInterval(t);
  }, [refresh]);

  return (
    <div className="scroll">
      <div className="tasks-section">
        <span>Trajectory · {steps.length} step{steps.length === 1 ? '' : 's'}</span>
        <button className="tasks-clear" type="button" onClick={refresh} disabled={busy}>
          {busy ? 'Refreshing…' : 'Refresh'}
        </button>
      </div>
      {error ? <div className="empty error">{error}</div> : null}
      {!error && steps.length === 0 && !enabled ? (
        <div className="empty">
          Trajectory tracing is off. Enable <code>cli.traceTrajectory</code> in Settings, then take a turn.
        </div>
      ) : null}
      {!error && steps.length === 0 && enabled ? (
        <div className="empty">No trajectory recorded yet — take a turn and it will fill in.</div>
      ) : null}
      {steps.map((step) => (
        <React.Fragment key={step.seq}>
          <div
            className="task-row"
            style={{ cursor: step.excerpt ? 'pointer' : 'default' }}
            onClick={() => setOpenSeq((cur) => (cur === step.seq ? null : step.seq))}
          >
            <span className="task-kind">step {step.seq}</span>
            <span className="file-name">{step.model}</span>
            <span className="task-elapsed">
              {formatDuration(step.durationMs)}
              {step.tokensIn !== undefined || step.tokensOut !== undefined
                ? ` · ↑${step.tokensIn ?? 0} ↓${step.tokensOut ?? 0}`
                : ''}
            </span>
          </div>
          {step.tools.length > 0 ? (
            <div className="task-row" style={{ paddingTop: 0, gap: 6, flexWrap: 'wrap' }}>
              {step.tools.map((t, i) => (
                <span key={`${step.seq}:${i}`} className="task-kind" title={`render intent: ${t.intent}`} style={{ opacity: 0.75 }}>
                  {t.name}
                  <span style={{ opacity: 0.6 }}> · {INTENT_LABEL[t.intent] ?? 'text'}</span>
                </span>
              ))}
            </div>
          ) : null}
          {openSeq === step.seq && step.excerpt ? (
            <div className="task-row" style={{ display: 'block' }}>
              <pre style={{ margin: 0, maxHeight: 200, overflow: 'auto', whiteSpace: 'pre-wrap', opacity: 0.8 }}>
                {step.excerpt}
              </pre>
            </div>
          ) : null}
        </React.Fragment>
      ))}
    </div>
  );
}
