/**
 * DESK-5 — the Worktrees panel: sibling checkouts under `.worktrees/` so an
 * agent can run in one without touching your main checkout. List, create,
 * open (switch this window), inline-diff, and remove.
 */
import React, { useState } from 'react';
import { Icon } from '../icons.js';
import { DiffView } from './diff.js';
import { Button } from '../components/primitives/Button.js';
import { type WorktreeEntry } from '../lib/worktree/worktreeParser.js';

export function WorktreesPanel({ worktrees, diffs, onCreate, onRemove, onOpen, onDiff }: {
  worktrees: WorktreeEntry[];
  diffs: Record<string, string>;
  onCreate: (name: string, ref: string) => void;
  onRemove: (path: string) => void;
  onOpen: (path: string) => void;
  onDiff: (path: string) => void;
}): React.ReactElement {
  const [name, setName] = useState('');
  const [ref, setRef] = useState('');
  const [openPath, setOpenPath] = useState<string | null>(null);
  const submit = (): void => { if (name.trim()) { onCreate(name.trim(), ref.trim()); setName(''); setRef(''); } };
  const toggleDiff = (p: string): void => {
    const next = openPath === p ? null : p;
    setOpenPath(next);
    if (next && diffs[next] === undefined) onDiff(next);
  };
  return (
    <div className="scroll wt-panel">
      <div className="sched-add">
        <div className="sched-add-row">
          <input className="filter" placeholder="new worktree name" value={name} onChange={(e) => setName(e.target.value)} />
          <input className="filter" placeholder="base ref (HEAD)" value={ref} onChange={(e) => setRef(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') submit(); }} />
          <button className="sched-add-btn" onClick={submit}>Add</button>
        </div>
      </div>
      {worktrees.length === 0 ? <div className="empty">No worktrees. The main checkout plus any you add appear here.</div> : worktrees.map((w) => (
        <div key={w.path} className="wt-row">
          <div className="wt-head">
            <Icon name="branch" size={13} />
            <span className="wt-branch">{w.isDetached ? '(detached)' : w.branch || '—'}</span>
            {w.isMain ? <span className="wt-tag">main</span> : null}
            {w.isCurrent ? <span className="wt-tag cur">open</span> : null}
          </div>
          <div className="wt-path" title={w.path}>{w.path}</div>
          <div className="wt-actions">
            {!w.isCurrent ? <Button onClick={() => onOpen(w.path)}>Open</Button> : null}
            <Button onClick={() => toggleDiff(w.path)}>{openPath === w.path ? 'Hide diff' : 'Diff'}</Button>
            {!w.isMain ? <Button variant="danger" onClick={() => onRemove(w.path)}>Remove</Button> : null}
          </div>
          {openPath === w.path ? (
            <div className="wt-diff">
              {diffs[w.path] === undefined ? <div className="empty">Loading diff…</div>
                : diffs[w.path].trim() ? <DiffView diff={diffs[w.path]} />
                : <div className="empty">No uncommitted changes in this worktree.</div>}
            </div>
          ) : null}
        </div>
      ))}
      <div className="sched-note">Worktrees are sibling checkouts under <code>.worktrees/</code> — run an agent in one without touching your main checkout. “Open” switches this window to it.</div>
    </div>
  );
}
