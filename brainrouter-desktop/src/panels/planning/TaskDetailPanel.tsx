/**
 * Task-detail viewer — a background task's conversation opened READ-ONLY in the
 * right panel (never in the chat, so the live conversation stays put). You can
 * inspect the full preserved output, interrupt a running task, and Back out.
 * It reuses the chat's own `renderRow` so a task reads identically to a chat.
 */
import React from 'react';
import { Icon } from '../../icons.js';
import type { ChatRow, TaskViewState } from '../../types.js';

export function TaskDetailPanel({ task, renderRow, onBack, onInterrupt }: {
  task: TaskViewState | null;
  renderRow: (row: ChatRow, isLast: boolean) => React.ReactElement;
  onBack: () => void;
  /**
   * Stop THIS task.
   *
   * It previously called the session-wide `requestStop`, which sends
   * `{ kind: 'interrupt' }` and ends the whole agent turn — so interrupting a
   * background shell killed the conversation that spawned it. The button said
   * "Interrupt" next to one task and stopped everything, which is a claim about
   * scope that the action did not honour.
   */
  onInterrupt: (task: TaskViewState) => void;
}): React.ReactElement {
  if (!task) {
    return (
      <div className="empty" style={{ padding: 18 }}>
        No task open. Click a task in <b>Background tasks</b> to inspect it here.
      </div>
    );
  }
  const title = task.title || task.goal || task.role || task.kind;
  const running = task.status === 'running' || !task.status;
  return (
    <div className="task-detail-panel">
      <div className="task-detail-bar">
        <button className="btn btn--chip" onClick={onBack}><Icon name="arrow-left" size={12} /> Back</button>
        <span className="task-detail-title" title={title}>{title}</span>
        {task.status ? <span className={`task-status ${task.status}`}>{task.status}</span> : null}
        {running ? (
          <button className="btn btn--chip danger" onClick={() => onInterrupt(task)}>Interrupt</button>
        ) : null}
      </div>
      <div className="task-convo task-detail-convo">
        {task.rows.map((r) => renderRow(r, false))}
      </div>
    </div>
  );
}
