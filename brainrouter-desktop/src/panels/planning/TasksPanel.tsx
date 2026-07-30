/**
 * The unified Tasks panel — the single home for background work. It merges the
 * old Background-tasks list and the Dashboard into one surface:
 *   1. Suggested starters — repo issues the agent could pick up (workspace-local).
 *   2. A task board — scope toggle (this Workspace · All workspaces) + lifecycle
 *      / kind tabs (Running · Finished · Failed · Workflows · Agents · Bash),
 *      grouped by workspace. Clicking any task opens it READ-ONLY in the Task
 *      side panel (never in the chat). Running tasks can be stopped in place.
 */
import React from 'react';
import { Icon } from '../../icons.js';
import { fmtElapsed } from '../../lib/format.js';
import { bridgeQuery } from '../../lib/bridgeQuery.js';
import {
  DASH_TABS,
  countByTab,
  allTasks,
  visibleDashboardBoards,
  taskLifecycle,
  taskStatusLabel,
  type DashTab,
  type DashTask,
  type WorkspaceDash,
} from '../../lib/workspace/dashboard.js';
import { GATE_LABEL } from '../reviewShared.js';

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

const TAB_LABEL: Record<DashTab, string> = { running: 'Running', finished: 'Finished', failed: 'Failed/Stale', workflows: 'Workflows', agents: 'Agents', bash: 'Bash' };

const SUGGESTED_KIND_TAGS: Record<string, string> = {
  'failing-checks': 'checks',
  'merge-conflict': 'conflict',
  'unresolved-reviews': 'reviews',
  'labeled-issue': 'issue',
};

export function suggestedTaskKindTag(kind: string): string {
  return SUGGESTED_KIND_TAGS[kind] ?? kind;
}

/** How a suggested starter is launched. `here` drafts it into the current
 *  composer; `session` opens a fresh session for it; `worktree` runs it now on an
 *  isolated git worktree (optionally based on `branch`) so the working tree is
 *  untouched — mirroring "review PR on a worktree". */
export type StartMode = 'here' | 'session' | 'worktree';

export function TasksPanel({ scope, setScope, tab, setTab, boards, busy, onRefresh, onOpenTask, onStopTask, onKill, onStartSuggested, branches = [] }: {
  scope: 'workspace' | 'all';
  setScope: (s: 'workspace' | 'all') => void;
  tab: DashTab;
  setTab: (t: DashTab) => void;
  /** the boards to show — one entry (active workspace) or many (global). */
  boards: WorkspaceDash[];
  busy?: boolean;
  onRefresh: () => void;
  /** Open a task's conversation READ-ONLY in the Task side panel. */
  onOpenTask: (t: DashTask) => void;
  /** Interrupt / cancel a running agent or workflow task. */
  onStopTask?: (t: DashTask) => void;
  /** Kill a background shell (dev server etc.) by its id — kills the whole tree. */
  onKill?: (id: string) => void;
  /** Launch a suggested starter — here / new session / isolated worktree (+branch). */
  onStartSuggested?: (prompt: string, opts: { mode: StartMode; branch?: string }) => void;
  /** Branch names for the "worktree from branch…" options. */
  branches?: string[];
}): React.ReactElement {
  // Which suggested-task row has its "Start ▾" menu open (by row key), if any.
  const [startMenu, setStartMenu] = React.useState<string | null>(null);
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

  const counts = countByTab(allTasks(boards));
  const shown = visibleDashboardBoards(boards, tab, scope);
  const totalShown = shown.reduce((n, b) => n + b.tasks.length, 0);

  return (
    <div className="scroll dash-panel">
      {/* 1. Suggested starters — repo work the agent could pick up. */}
      <div className="tasks-section">
        <span>Suggested starters{suggested?.repo ? ` · ${suggested.repo}` : ''}</span>
        <button className="tasks-clear" type="button" onClick={refreshSuggested} disabled={suggestBusy}>{suggestBusy ? 'Scanning...' : 'Refresh'}</button>
      </div>
      {suggestError ? <div className="empty error">{suggestError}</div> : null}
      {!suggestError && suggested && suggested.tasks.length === 0 && !suggestBusy ? <div className="empty">No suggested starters in this workspace.</div> : null}
      {!suggestError && !suggested && suggestBusy ? <div className="empty">Scanning connected repo...</div> : null}
      {suggested?.tasks.slice(0, 8).map((task) => {
        const rowKey = `${task.kind}:${task.repo}:${task.number}:${task.title}`;
        const start = (mode: StartMode, branch?: string): void => { setStartMenu(null); onStartSuggested?.(task.suggestedPrompt, { mode, branch }); };
        return (
          <div key={rowKey} className="task-row suggested-task-row">
            <span className="task-kind">{suggestedTaskKindTag(task.kind)}</span>
            <span className="file-name suggested-task-title">{task.title}</span>
            {task.url ? (
              <button className="task-link" type="button" title="Open in browser" onClick={() => window.brainrouter.send({ kind: 'query', id: `suggested-open:${task.number}`, name: 'action:open-external', args: { url: task.url } } as never)}>
                Open
              </button>
            ) : null}
            <div className="start-wrap" onBlur={() => window.setTimeout(() => setStartMenu((k) => (k === rowKey ? null : k)), 120)}>
              <button
                className="task-stop task-start"
                type="button"
                disabled={!onStartSuggested}
                onClick={() => setStartMenu((k) => (k === rowKey ? null : rowKey))}
                title="Choose how to start this task"
              >
                Start ▾
              </button>
              {startMenu === rowKey ? (
                <div className="start-menu">
                  <button type="button" className="start-item" onMouseDown={(e) => e.preventDefault()} onClick={() => start('here')}>Start here <span className="start-hint">in this chat</span></button>
                  <button type="button" className="start-item" onMouseDown={(e) => e.preventDefault()} onClick={() => start('session')}>New session <span className="start-hint">fresh chat</span></button>
                  <button type="button" className="start-item" onMouseDown={(e) => e.preventDefault()} onClick={() => start('worktree')}>New worktree <span className="start-hint">isolated · runs now</span></button>
                  {branches.length ? (
                    <>
                      <div className="start-sep">Worktree from branch…</div>
                      {branches.slice(0, 8).map((b) => (
                        <button key={b} type="button" className="start-item start-branch" onMouseDown={(e) => e.preventDefault()} onClick={() => start('worktree', b)}>{b}</button>
                      ))}
                    </>
                  ) : null}
                </div>
              ) : null}
            </div>
          </div>
        );
      })}
      {suggested?.warnings.length ? (
        <div className="suggested-task-warnings">
          {suggested.warnings.slice(0, 3).map((warning) => <div key={warning}>warning: {warning}</div>)}
        </div>
      ) : null}

      {/* 2. Task board — scope + lifecycle/kind tabs, grouped by workspace. */}
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
              const lifecycle = taskLifecycle(t);
              const status = taskStatusLabel(t);
              const phase = t.phase && t.phase !== t.status ? t.phase.replace(/[-_]+/g, ' ') : '';
              const isShell = t.kind === 'shell' || t.kind === 'bash';
              return (
                <div key={`${b.workspaceRoot}:${t.id}`} className="dash-row">
                  <span className={`dash-dot ${lifecycle === 'running' ? 'run' : lifecycle === 'failed' ? 'fail' : 'done'}`} />
                  <button className="dash-row-main" onClick={() => onOpenTask(t)} title="Open this task's output (read-only) in the Task panel">
                    <span className="dash-kind">{t.worktree ? <Icon name="merge" size={10} /> : null}{t.kind}</span>
                    <span className="dash-label">{t.label}</span>
                    {t.role ? <span className="dash-role">{t.role}</span> : null}
                  </button>
                  <span className={`dash-status ${lifecycle}`}>{status}</span>
                  {phase ? <span className="dash-phase">{phase}</span> : null}
                  {t.startedAt ? <span className="dash-time">{fmtElapsed(t.startedAt)}</span> : null}
                  {lifecycle === 'running' && isShell && onKill ? (
                    <button className="dash-stop" title="Stop this background process (kills the whole tree)" onClick={() => onKill(t.id)}><Icon name="close" size={11} /></button>
                  ) : lifecycle === 'running' && onStopTask ? (
                    <button className="dash-stop" title="Stop / cancel" onClick={() => onStopTask(t)}><Icon name="close" size={11} /></button>
                  ) : null}
                </div>
              );
            })}
          </div>
        )
      ))}
    </div>
  );
}
