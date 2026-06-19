/**
 * T4 — the Environment column (right of the chat): a quick-glance card of
 * git changes, branch, last commit, GitHub CI status, last-turn tool-call
 * health, and this workspace's running background tasks. Extracted verbatim from
 * App.tsx; the App owns all state and passes it through. The card is a layout
 * column (never an overlay) gated by `envAnim` (useClosable).
 */
import React, { type Dispatch, type SetStateAction } from 'react';
import { Icon } from '../icons.js';
import { fmtElapsed } from '../lib/format.js';
import { summarizeChecks, ciStatusLabel } from '../lib/ci/ciFormat.js';
import type { CiApi } from '../lib/ci/useCi.js';
import type { FleetRow } from '../types.js';
import type { PanelId } from '../panels/Panel.js';
import type { SettingsSection } from '../lib/commands/commands.js';

type GitInfo = { repo: string; branch: string | null; insertions: number; deletions: number; gitRoot?: string | null; repoRelativePath?: string; isSubdir?: boolean } | null;

export interface EnvironmentPanelProps {
  envAnim: { mounted: boolean; closing: boolean };
  openSettings: (section: SettingsSection) => void;
  gitInfo: GitInfo;
  ensurePanel: (id: PanelId) => void;
  setTermDockOpen: Dispatch<SetStateAction<boolean>>;
  branches: { current: string | null; branches: string[]; loading?: boolean };
  q: (id: string, name: string, args?: Record<string, unknown>) => void;
  commitSubjects: string[];
  ci: CiApi;
  openCiPanel: () => void;
  lastTurnFails: number | null;
  backgroundTasks: FleetRow[];
  openTask: (f: FleetRow) => void;
}

export function EnvironmentPanel(p: EnvironmentPanelProps): React.ReactElement | null {
  const { envAnim, openSettings, gitInfo, ensurePanel, setTermDockOpen, branches, q, commitSubjects, ci, openCiPanel, lastTurnFails, backgroundTasks, openTask } = p;
  if (!envAnim.mounted) return null;
  return (
    <aside className={`env-col${envAnim.closing ? ' closing' : ''}`}>
      <div className="env-pop">
        <div className="env-head">
          <span>Environment</span>
          <button className="icon-btn" title="Settings" onClick={() => openSettings('general')}><Icon name="gear" size={13} /></button>
        </div>
        {/* Sections render only when they apply: git rows need a
            repo, the checks row needs a finished turn. */}
        {gitInfo?.branch ? (
          <button className="env-row" onClick={() => ensurePanel('diff')}>
            <Icon name="diff" size={14} /><span>Changes</span>
            {gitInfo.insertions + gitInfo.deletions > 0 ? <b>+{gitInfo.insertions.toLocaleString()} -{gitInfo.deletions.toLocaleString()}</b> : null}
          </button>
        ) : null}
        <button className="env-row" onClick={() => setTermDockOpen(true)}>
          <Icon name="monitor" size={14} /><span>Local</span><Icon name="chev-down" size={10} />
        </button>
        {gitInfo?.branch ? (
          <>
            <button className="env-row" onClick={() => q('q-branches', 'git-branches')}>
              <Icon name="branch" size={14} /><span>{branches.current ?? gitInfo.branch}</span><Icon name="chev-down" size={10} />
            </button>
            <button className="env-row" onClick={() => ensurePanel('diff')}>
              <Icon name="commit" size={14} /><span>Commit or push</span>
            </button>
            {commitSubjects[0] ? (
              <div className="env-row inert"><Icon name="merge" size={14} /><span>{commitSubjects[0]}</span></div>
            ) : null}
          </>
        ) : null}
        {/* T6 — REAL GitHub CI (gh), distinct from the local tool-call result below. */}
        <button className={`env-row ci-env-${summarizeChecks(ci.checks).conclusion}`} onClick={openCiPanel} title="GitHub CI / checks (gh)">
          <Icon name="check-circle" size={14} />
          <span>{ci.checks.length ? ciStatusLabel(summarizeChecks(ci.checks)) : 'CI / checks — open'}</span>
        </button>
        {/* Local tool-call outcome of the last turn — NOT CI. */}
        {lastTurnFails === null ? null : lastTurnFails === 0 ? (
          <div className="env-row inert checks-ok"><Icon name="check-circle" size={14} /><span>Last turn: all tool calls OK</span></div>
        ) : (
          <div className="env-row inert checks-bad"><Icon name="warn" size={14} /><span>{lastTurnFails} tool call{lastTurnFails === 1 ? '' : 's'} failed last turn</span></div>
        )}
        <div className="env-sep" />
        <div className="env-label">Background tasks{backgroundTasks.length ? ` · ${backgroundTasks.length}` : ''}</div>
        {backgroundTasks.length === 0 ? (
          <div className="env-row inert muted"><Icon name="tasks" size={14} /><span>Nothing running in this workspace</span></div>
        ) : backgroundTasks.slice(0, 4).map((f) => (
          <button key={f.id} className="env-row" title={`${f.kind} · ${f.id} — open its conversation`} onClick={() => openTask(f)}>
            <span className="st-branch"><Icon name="merge" size={13} /></span>
            <span>{f.label}{f.worktree ? ' ⎇' : ''}</span>
            {fmtElapsed(f.startedAt) ? <b>{fmtElapsed(f.startedAt)}</b> : <span className="st"><span className="spinner sm" /></span>}
          </button>
        ))}
        {backgroundTasks.length > 4 ? (
          <button className="env-row muted" onClick={() => ensurePanel('tasks')}>
            <span className="st-branch"><Icon name="tasks" size={13} /></span><span>and {backgroundTasks.length - 4} more…</span>
          </button>
        ) : null}
      </div>
    </aside>
  );
}
