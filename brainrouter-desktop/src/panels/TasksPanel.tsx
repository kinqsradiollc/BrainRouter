/**
 * DESK-5w / §3 — the Background tasks panel: live agents/workflows AND durable
 * background tasks (plan revisions, reviews, attachment jobs) running for the
 * active workspace. Durable rows show a status badge, current phase, and elapsed time;
 * clicking any row opens its transcript/conversation (read-only). Workspace- and
 * global-scoped inspection lives in the Dashboard panel; this panel shows the
 * active workspace's running tasks.
 */
import React from 'react';
import type { FleetRow } from '../types.js';

export interface FinishedTask { id: string; label: string; status: string }

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

export function TasksPanel({ fleet, recent = [], onOpen, onKill }: {
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
}): React.ReactElement {
  // Don't double-list a task that's still running in the fleet above.
  const runningIds = new Set(fleet.map((f) => f.id));
  const finishedDurable = recent.filter((t) => !runningIds.has(t.id)).slice(0, 25);
  return (
    <div className="scroll">
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
