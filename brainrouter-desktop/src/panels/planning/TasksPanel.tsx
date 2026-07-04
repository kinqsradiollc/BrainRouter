/**
 * DESK-5w / §3 — the Background tasks panel: live agents/workflows AND durable
 * background tasks (plan revisions, reviews, attachment jobs) running for the
 * active workspace. Durable rows show a status badge, current phase, and elapsed time;
 * clicking any row opens its transcript/conversation (read-only). Workspace- and
 * global-scoped inspection lives in the Dashboard panel; this panel shows the
 * active workspace's running tasks.
 */
import React from 'react';
import type { FleetRow } from '../../types.js';
import { bridgeQuery } from '../../lib/bridgeQuery.js';

export interface FinishedTask { id: string; label: string; status: string }
export interface SuggestedTaskView {
  kind: 'failing-checks' | 'merge-conflict' | 'unresolved-reviews' | 'labeled-issue' | string;
  title: string;
  repo: string;
  number: number;
  url: string;
  suggestedPrompt: string;
}
export interface SuggestedTasksViewResult {
  repo: string;
  tasks: SuggestedTaskView[];
  error?: string;
  warnings: string[];
}

/** Compact elapsed-time label from an ISO start time. */
function elapsed(startedAt?: string): string {
  if (!startedAt) return '';
  const start = Date.parse(startedAt);
  if (Number.isNaN(start)) return '';
  const s = Math.max(0, Math.round((Date.now() - start) / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}

// Attachments are CONTENT (durable AttachmentRecords), not background jobs — they
// no longer create a task, so they don't belong in this durable-task whitelist.
const DURABLE_KINDS = new Set(['plan-revision', 'review', 'verification']);

const SUGGESTED_KIND_TAGS: Record<string, string> = {
  'failing-checks': 'checks',
  'merge-conflict': 'conflict',
  'unresolved-reviews': 'reviews',
  'labeled-issue': 'issue',
};

export function suggestedTaskKindTag(kind: string): string {
  return SUGGESTED_KIND_TAGS[kind] ?? kind;
}

export function TasksPanel({ fleet, recent = [], onOpen, onKill, onStartSuggestedTask }: {
  fleet: FleetRow[];
  /** §3 — recently-finished DURABLE tasks (completed/failed), e.g. a verification
   *  run that just ended. Clicking reopens its transcript/result. */
  recent?: FleetRow[];
  finished?: FinishedTask[];
  onClear?: () => void;
  /** DESK-5w — open a running task's conversation (read-only). */
  onOpen?: (id: string) => void;
  /** WS2 2.4 — stop a background shell (dev server etc.) from the panel. */
  onKill?: (id: string) => void;
  /** MC-B6 — stage a suggested starter prompt in the composer. */
  onStartSuggestedTask?: (prompt: string) => void;
}): React.ReactElement {
  // Don't double-list a task that's still running in the fleet above.
  const runningIds = new Set(fleet.map((f) => f.id));
  const finishedDurable = recent.filter((t) => !runningIds.has(t.id)).slice(0, 25);
  const [suggested, setSuggested] = React.useState<SuggestedTasksViewResult | null>(null);
  const [suggestBusy, setSuggestBusy] = React.useState(false);
  const [suggestError, setSuggestError] = React.useState('');
  const refreshSuggested = React.useCallback(() => {
    setSuggestBusy(true);
    setSuggestError('');
    void bridgeQuery<SuggestedTasksViewResult>('suggested-tasks', {}, 30_000)
      .then((result) => {
        setSuggested({
          repo: result.repo || '',
          tasks: Array.isArray(result.tasks) ? result.tasks : [],
          warnings: Array.isArray(result.warnings) ? result.warnings : [],
          ...(result.error ? { error: result.error } : {}),
        });
        setSuggestError(result.error ?? '');
      })
      .catch((error) => {
        setSuggested(null);
        setSuggestError((error as Error).message || 'Suggested-task scan failed.');
      })
      .finally(() => setSuggestBusy(false));
  }, []);
  React.useEffect(() => { refreshSuggested(); }, [refreshSuggested]);
  return (
    <div className="scroll">
      <div className="tasks-section">
        <span>Suggested starters{suggested?.repo ? ` · ${suggested.repo}` : ''}</span>
        <button className="tasks-clear" type="button" onClick={refreshSuggested} disabled={suggestBusy}>{suggestBusy ? 'Scanning...' : 'Refresh'}</button>
      </div>
      {suggestError ? <div className="empty error">{suggestError}</div> : null}
      {!suggestError && suggested && suggested.tasks.length === 0 && !suggestBusy ? <div className="empty">No suggested starters in this workspace.</div> : null}
      {!suggestError && !suggested && suggestBusy ? <div className="empty">Scanning connected repo...</div> : null}
      {suggested?.tasks.slice(0, 8).map((task) => (
        <div key={`${task.kind}:${task.repo}:${task.number}:${task.title}`} className="task-row suggested-task-row">
          <span className="task-kind">{suggestedTaskKindTag(task.kind)}</span>
          <span className="file-name suggested-task-title">{task.title}</span>
          {task.url ? (
            <button className="task-link" type="button" title="Open in browser" onClick={() => window.brainrouter.send({ kind: 'query', id: `suggested-open:${task.number}`, name: 'action:open-external', args: { url: task.url } } as never)}>
              Open
            </button>
          ) : null}
          <button
            className="task-stop task-start"
            type="button"
            disabled={!onStartSuggestedTask}
            onClick={() => onStartSuggestedTask?.(task.suggestedPrompt)}
            title="Send this starter prompt to the composer"
          >
            Start
          </button>
        </div>
      ))}
      {suggested?.warnings.length ? (
        <div className="suggested-task-warnings">
          {suggested.warnings.slice(0, 3).map((warning) => <div key={warning}>warning: {warning}</div>)}
        </div>
      ) : null}
      <div className="tasks-section"><span>Running in this workspace{fleet.length ? ` · ${fleet.length}` : ''}</span></div>
      {fleet.length === 0 ? <div className="empty">Nothing running in this workspace.</div> : fleet.map((f) => {
        const durable = f.durable === true || DURABLE_KINDS.has(f.kind);
        const el = elapsed(f.startedAt);
        const content = (
          <>
            <span className="task-kind">{f.kind}</span>
            {/* only render the (flex:1) name when there's a label — otherwise an
                empty name stretches and orphans the kind badge from the status. */}
            {f.label ? <span className="file-name">{f.label}</span> : null}
            {durable && f.status && f.status !== 'running' ? <span className={`task-status st-${f.status}`}>{f.status}</span> : null}
            {durable && f.phase && (!f.status || f.status === 'running') ? <span className="task-phase">{f.phase}</span> : null}
            {el ? <span className="task-elapsed">{el}</span> : null}
          </>
        );
        // WS2 2.4 — a background shell (e.g. a dev server) gets a Stop control; a
        // nested <button> is invalid, so the row becomes a flex div with an inner
        // open-button + the Stop button.
        if (f.kind === 'shell' && onKill) {
          return (
            <div key={f.id} className="task-row">
              <button className="task-row-main" onClick={() => onOpen?.(f.id)} title="Open this task's output">{content}</button>
              <button className="task-stop" title="Stop this background process (kills the whole tree)" onClick={() => onKill(f.id)}>Stop</button>
            </div>
          );
        }
        return (
          <button key={f.id} className="task-row clickable" onClick={() => onOpen?.(f.id)} title="Open this task's conversation">
            {content}
            <span className="task-open">→</span>
          </button>
        );
      })}
      {finishedDurable.length > 0 ? (
        <>
          <div className="tasks-section"><span>Recently finished · {finishedDurable.length}</span></div>
          {finishedDurable.map((f) => (
            <button key={f.id} className="task-row clickable" onClick={() => onOpen?.(f.id)} title="Open this task's result">
              <span className="task-kind">{f.kind}</span>
              {f.label ? <span className="file-name">{f.label}</span> : null}
              {f.status ? <span className={`task-status st-${f.status}`}>{f.status}</span> : null}
              <span className="task-open">→</span>
            </button>
          ))}
        </>
      ) : null}
    </div>
  );
}
