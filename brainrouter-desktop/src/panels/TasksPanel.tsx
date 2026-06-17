/**
 * DESK-5w — the Background tasks panel: agents running in this chat (clickable
 * to open their read-only conversation) plus a list of finished ones.
 */
import React from 'react';

export interface FinishedTask { id: string; label: string; status: string }

export function TasksPanel({ fleet, finished, onClear, onOpen }: {
  fleet: Array<{ kind: string; id: string; label: string }>;
  finished: FinishedTask[];
  onClear: () => void;
  /** DESK-5w — open a running task's conversation (read-only). */
  onOpen?: (id: string) => void;
}): React.ReactElement {
  return (
    <div className="scroll">
      <div className="tasks-section"><span>Running in this chat</span></div>
      {fleet.length === 0 ? <div className="empty">Nothing running in this chat.</div> : fleet.map((f) => (
        <button key={f.id} className="task-row clickable" onClick={() => onOpen?.(f.id)} title="Open this task's conversation">
          <span className="task-kind">{f.kind}</span><span className="file-name">{f.label}</span><span className="task-open">→</span>
        </button>
      ))}
      <div className="tasks-section"><span>Finished</span>{finished.length ? <button className="tasks-clear" onClick={onClear}>Clear</button> : null}</div>
      {finished.length === 0 ? <div className="empty">Nothing finished yet.</div> : finished.map((f) => (
        <div key={f.id}>
          <div className="task-row"><span className="session-dot" /><span className="file-name">{f.label}</span></div>
          <div className="task-status">{f.status}</div>
        </div>
      ))}
    </div>
  );
}
