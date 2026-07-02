/**
 * Track view — Modules + Reports panels. Split out of TrackView.tsx
 * byte-for-byte; no behavior change.
 */
import React, { useState } from 'react';
import type { TrackProject, WorkItem, WorkItemType, WorkItemPriority, Sprint, Module, ModuleStatus } from '@kinqs/brainrouter-types';
import { Icon } from '../../icons.js';
import { TrackDropdown } from '../Dropdown.js';
import { TYPE_ICON, type TrackOps } from './types.js';

const MODULE_STATUSES: ModuleStatus[] = ['backlog', 'planned', 'in-progress', 'paused', 'completed', 'cancelled'];

export function ModulesView({ modules, items, ops }: { modules: Module[]; items: WorkItem[]; ops: TrackOps }): React.ReactElement {
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState('');
  const submit = (): void => { const n = name.trim(); if (n) ops.createModule(n); setName(''); setCreating(false); };
  return (
    <div className="track-modules">
      <div className="track-modules-head">
        <span className="track-modules-count">{modules.length} module{modules.length === 1 ? '' : 's'}</span>
        <button className="track-mod-new" onClick={() => setCreating(true)}>+ New module</button>
      </div>
      {creating ? (
        <div className="track-mod-create">
          <input autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder="Module name"
            onKeyDown={(e) => { if (e.key === 'Enter') submit(); if (e.key === 'Escape') { setCreating(false); setName(''); } }} />
          <button onClick={submit}>Add</button><button onClick={() => { setCreating(false); setName(''); }}>Cancel</button>
        </div>
      ) : null}
      {modules.length === 0 && !creating ? <div className="track-empty">No modules yet. Group related work into a module.</div> : null}
      <div className="track-mod-grid">
        {modules.map((m) => {
          const own = items.filter((w) => w.moduleId === m.id);
          const done = own.filter((w) => w.statusCategory === 'completed').length;
          const pct = own.length ? Math.round((done / own.length) * 100) : 0;
          return (
            <div className="track-mod-card" key={m.id}>
              <div className="track-mod-card-top">
                <span className={`track-cat track-mod-st-${m.status}`} />
                <span className="track-mod-name">{m.name}</span>
                <TrackDropdown value={m.status} options={MODULE_STATUSES.map((s) => ({ value: s, label: s }))}
                  onChange={(v) => ops.updateModule(m.id, { status: v as ModuleStatus })} />
                <button className="track-mod-del" title="Delete module" onClick={() => ops.deleteModule(m.id)}>×</button>
              </div>
              {m.description ? <div className="track-mod-desc">{m.description}</div> : null}
              <div className="track-mod-bar"><span className="track-mod-bar-fill" style={{ width: `${pct}%` }} /></div>
              <div className="track-mod-meta">
                <span>{done} / {own.length} done · {pct}%</span>
                {m.lead ? <span className="track-mod-lead">lead {m.lead}</span> : null}
                {m.targetDate ? <span>{new Date(m.targetDate).toLocaleDateString()}</span> : null}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

export function ReportsView({ items, states, sprints }: { items: WorkItem[]; states: TrackProject['workflowStates']; sprints: Sprint[] }): React.ReactElement {
  const byCat = (c: string) => items.filter((w) => w.statusCategory === c).length;
  const byType = (t: WorkItemType) => items.filter((w) => w.type === t).length;
  const byPri = (p: WorkItemPriority) => items.filter((w) => w.priority === p).length;
  const total = items.length || 1;
  const points = items.reduce((n, w) => n + (w.storyPoints ?? 0), 0);
  const donePoints = items.filter((w) => w.statusCategory === 'completed').reduce((n, w) => n + (w.storyPoints ?? 0), 0);
  return (
    <div className="track-reports">
      <div className="track-report-card">
        <div className="track-report-title">Status</div>
        {(['backlog', 'unstarted', 'started', 'completed', 'cancelled'] as const).map((c) => (
          <div key={c} className="track-report-bar"><span className="trb-label">{c}</span><span className="trb-track"><span className={`trb-fill track-cat-${c}`} style={{ width: `${(byCat(c) / total) * 100}%` }} /></span><span className="trb-n">{byCat(c)}</span></div>
        ))}
      </div>
      <div className="track-report-card">
        <div className="track-report-title">By type</div>
        {(['epic', 'story', 'task', 'bug', 'sub-task'] as const).map((t) => byType(t) ? (
          <div key={t} className="track-report-row"><Icon name={TYPE_ICON[t]} size={12} /><span className="trr-label">{t}</span><span className="trr-n">{byType(t)}</span></div>
        ) : null)}
      </div>
      <div className="track-report-card">
        <div className="track-report-title">By priority</div>
        {(['urgent', 'high', 'medium', 'low', 'none'] as const).map((p) => byPri(p) ? (
          <div key={p} className="track-report-row"><span className={`track-pri pri-${p}`} /><span className="trr-label">{p}</span><span className="trr-n">{byPri(p)}</span></div>
        ) : null)}
      </div>
      <div className="track-report-card">
        <div className="track-report-title">Throughput</div>
        <div className="track-report-big">{Math.round((byCat('completed') / total) * 100)}%<span> done</span></div>
        <div className="track-report-row"><span className="trr-label">Items</span><span className="trr-n">{byCat('completed')} / {items.length}</span></div>
        {points ? <div className="track-report-row"><span className="trr-label">Story points</span><span className="trr-n">{donePoints} / {points}</span></div> : null}
        <div className="track-report-row"><span className="trr-label">Sprints</span><span className="trr-n">{sprints.filter((s) => s.state === 'active').length} active · {sprints.length} total</span></div>
      </div>
    </div>
  );
}
