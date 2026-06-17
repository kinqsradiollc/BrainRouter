/**
 * T1 — workflow / background dashboard. A higher-level view than the per-chat
 * TasksPanel: scope toggle (this Workspace · All workspaces) + lifecycle/kind
 * tabs (Running · Finished · Failed · Workflows · Agents · Bash), grouped by
 * workspace, with per-workspace review badges. Dense + flicker-free (the parent
 * polls and replaces state; rows have stable keys).
 */
import React from 'react';
import { Icon } from '../icons.js';
import { fmtElapsed } from '../lib/format.js';
import { DASH_TABS, filterTasks, countByTab, allTasks, type DashTab, type DashTask, type WorkspaceDash } from '../lib/workspace/dashboard.js';
import { GATE_LABEL } from './reviewShared.js';

const TAB_LABEL: Record<DashTab, string> = { running: 'Running', finished: 'Finished', failed: 'Failed', workflows: 'Workflows', agents: 'Agents', bash: 'Bash' };

export function DashboardPanel({ scope, setScope, tab, setTab, boards, busy, onRefresh, onOpenTask, onStopTask }: {
  scope: 'workspace' | 'all';
  setScope: (s: 'workspace' | 'all') => void;
  tab: DashTab;
  setTab: (t: DashTab) => void;
  /** the boards to show — one entry (active workspace) or many (global). */
  boards: WorkspaceDash[];
  busy?: boolean;
  onRefresh: () => void;
  onOpenTask: (t: DashTask) => void;
  onStopTask?: (t: DashTask) => void;
}): React.ReactElement {
  const counts = countByTab(allTasks(boards));
  const shown = boards.map((b) => ({ ...b, tasks: filterTasks(b.tasks, tab) })).filter((b) => scope === 'all' ? true : b.tasks.length || true);
  const totalShown = shown.reduce((n, b) => n + b.tasks.length, 0);
  return (
    <div className="scroll dash-panel">
      <div className="dash-bar">
        <div className="seg dash-scope">
          <button className={scope === 'workspace' ? 'active' : ''} onClick={() => setScope('workspace')}>Workspace</button>
          <button className={scope === 'all' ? 'active' : ''} onClick={() => setScope('all')}>All workspaces</button>
        </div>
        <button className="dash-refresh" disabled={busy} onClick={onRefresh} title="Refresh">{busy ? '…' : '↻'}</button>
      </div>
      <div className="dash-tabs">
        {DASH_TABS.map((t) => (
          <button key={t} className={`dash-tab${tab === t ? ' active' : ''}`} onClick={() => setTab(t)}>
            {TAB_LABEL[t]}{counts[t] ? <span className="dash-count">{counts[t]}</span> : null}
          </button>
        ))}
      </div>
      {totalShown === 0 ? <div className="empty center-empty">Nothing {TAB_LABEL[tab].toLowerCase()}{scope === 'all' ? ' across your workspaces' : ' in this workspace'}.</div> : null}
      {shown.map((b) => (
        b.tasks.length === 0 && scope === 'workspace' ? null : (
          <div key={b.workspaceRoot} className="dash-ws">
            {scope === 'all' ? (
              <div className="dash-ws-head">
                <Icon name="folder" size={12} />
                <span className="dash-ws-name" title={b.workspaceRoot}>{b.workspaceRoot.split('/').pop() || b.workspaceRoot}</span>
                {b.reviewGate && b.reviewGate.status !== 'clean' ? (
                  <span className={`dash-ws-gate gate-${b.reviewGate.status}`} title={b.reviewGate.reason}>{GATE_LABEL[b.reviewGate.status] ?? b.reviewGate.status}</span>
                ) : null}
                <span className="dash-ws-count">{b.tasks.length}</span>
              </div>
            ) : null}
            {b.tasks.map((t) => {
              const running = !/complete|done|finished|success|fail|error|cancel/i.test(t.status ?? '');
              return (
                <div key={`${b.workspaceRoot}:${t.id}`} className="dash-row">
                  <span className={`dash-dot ${running ? 'run' : /fail|error|cancel/i.test(t.status ?? '') ? 'fail' : 'done'}`} />
                  <button className="dash-row-main" onClick={() => onOpenTask(t)} title="Open this task's conversation">
                    <span className="dash-kind">{t.worktree ? <Icon name="merge" size={10} /> : null}{t.kind}</span>
                    <span className="dash-label">{t.label}</span>
                    {t.role ? <span className="dash-role">{t.role}</span> : null}
                  </button>
                  {t.startedAt ? <span className="dash-time">{fmtElapsed(t.startedAt)}</span> : null}
                  {running && onStopTask ? <button className="dash-stop" title="Stop / cancel" onClick={() => onStopTask(t)}><Icon name="close" size={11} /></button> : null}
                </div>
              );
            })}
          </div>
        )
      ))}
    </div>
  );
}
