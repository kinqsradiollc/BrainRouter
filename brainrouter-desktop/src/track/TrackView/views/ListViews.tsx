/**
 * Track view — list · backlog · sprint · roadmap layouts. Split out of
 * TrackView.tsx byte-for-byte; no behavior change.
 */
import React, { useState } from 'react';
import type { TrackProject, WorkItem, Sprint } from '@kinqs/brainrouter-types';
import { Icon } from '../../../icons.js';
import { TrackDropdown } from '../../Dropdown.js';
import { TYPE_ICON, type TrackOps } from '../shared/types.js';
import { Card } from '../shared/helpers.js';

export function ListView({ items, states, onOpen }: { items: WorkItem[]; states: TrackProject['workflowStates']; onOpen: (w: WorkItem) => void }): React.ReactElement {
  return (
    <div className="track-list">
      <div className="track-list-head"><span>Key</span><span>Type</span><span>Title</span><span>Status</span><span>Priority</span><span>Assignee</span></div>
      {items.map((w) => (
        <button key={w.id} className="track-list-row" onClick={() => onOpen(w)}>
          <span className="tl-key mono">{w.key}</span>
          <span className="tl-type"><Icon name={TYPE_ICON[w.type]} size={12} /> {w.type}</span>
          <span className="tl-title">{w.title}</span>
          <span className="tl-status"><span className={`track-cat track-cat-${w.statusCategory}`} /> {states.find((s) => s.id === w.status)?.name ?? w.status}</span>
          <span className={`tl-pri pri-${w.priority}`}>{w.priority}</span>
          <span className="tl-asn">{w.assignees.join(', ') || '—'}</span>
        </button>
      ))}
      {items.length === 0 ? <div className="track-empty">No matching work items.</div> : null}
    </div>
  );
}

export function BacklogView({ items, sprints, ops, onOpen }: { items: WorkItem[]; sprints: Sprint[]; ops: TrackOps; onOpen: (w: WorkItem) => void }): React.ReactElement {
  const [newSprint, setNewSprint] = useState('');
  const backlog = items.filter((w) => !w.sprintId && w.type !== 'epic');
  return (
    <div className="track-backlog">
      <div className="track-backlog-main">
        <div className="track-section-head">Backlog <span className="track-col-count">{backlog.length}</span></div>
        {backlog.map((w) => (
          <div key={w.id} className="track-backlog-row">
            <button className="track-backlog-item" onClick={() => onOpen(w)}>
              <span className={`track-type track-type-${w.type}`}><Icon name={TYPE_ICON[w.type]} size={11} /></span>
              <span className="mono tl-key">{w.key}</span><span className="tl-title">{w.title}</span>
              <span className={`track-pri pri-${w.priority}`} />
            </button>
            <TrackDropdown className="dd-sprintsel" value="" placeholder="→ sprint…" onChange={(v) => { if (v) ops.assignSprint(w.key, v); }}
              options={sprints.filter((s) => s.state !== 'completed').map((s) => ({ value: s.id, label: s.name }))} />
          </div>
        ))}
        {backlog.length === 0 ? <div className="track-empty">Backlog is empty.</div> : null}
      </div>
      <aside className="track-backlog-side">
        <div className="track-section-head">Sprints</div>
        {sprints.map((s) => <SprintRow key={s.id} sprint={s} count={items.filter((w) => w.sprintId === s.id).length} ops={ops} />)}
        <div className="track-newsprint">
          <input value={newSprint} onChange={(e) => setNewSprint(e.target.value)} placeholder="New sprint name…" onKeyDown={(e) => { if (e.key === 'Enter' && newSprint.trim()) { ops.createSprint(newSprint.trim()); setNewSprint(''); } }} />
          <button onClick={() => { if (newSprint.trim()) { ops.createSprint(newSprint.trim()); setNewSprint(''); } }}>Add</button>
        </div>
      </aside>
    </div>
  );
}

function SprintRow({ sprint, count, ops }: { sprint: Sprint; count: number; ops: TrackOps }): React.ReactElement {
  return (
    <div className={`track-sprint-row state-${sprint.state}`}>
      <span className="track-sprint-name">{sprint.name}</span>
      <span className="track-sprint-meta">{count} · {sprint.state}</span>
      {sprint.state === 'future' ? <button onClick={() => ops.sprintState(sprint.id, 'active')}>Start</button> : null}
      {sprint.state === 'active' ? <button onClick={() => ops.sprintState(sprint.id, 'completed')}>Complete</button> : null}
    </div>
  );
}

export function SprintView({ items, sprints, states, ops, onOpen }: { items: WorkItem[]; sprints: Sprint[]; states: TrackProject['workflowStates']; ops: TrackOps; onOpen: (w: WorkItem) => void }): React.ReactElement {
  const [dragKey, setDragKey] = useState<string | null>(null);
  const [overCol, setOverCol] = useState<string | null>(null);
  const active = sprints.find((s) => s.state === 'active') ?? sprints[0];
  if (!active) return <div className="track-empty">No sprint yet — create one in Backlog.</div>;
  const sprintItems = items.filter((w) => w.sprintId === active.id);
  const points = sprintItems.reduce((n, w) => n + (w.storyPoints ?? 0), 0);
  const done = sprintItems.filter((w) => w.statusCategory === 'completed').length;
  return (
    <div className="track-sprintview">
      <div className="track-sprint-banner">
        <div><b>{active.name}</b>{active.goal ? <span className="track-sprint-goal"> — {active.goal}</span> : null}</div>
        <div className="track-sprint-stats">{sprintItems.length} items · {done} done{points ? ` · ${points} pts` : ''} · {active.state}
          {active.state === 'active' ? <button className="track-sprint-complete" onClick={() => ops.sprintState(active.id, 'completed')}>Complete sprint</button> : null}
        </div>
      </div>
      <div className="track-board">
        {states.map((s) => {
          const col = sprintItems.filter((w) => w.status === s.id);
          return (
            <section className={`track-col${dragKey && overCol === s.id ? ' drag-over' : ''}`} key={s.id}
              onDragOver={(e) => { if (dragKey) { e.preventDefault(); e.dataTransfer.dropEffect = 'move'; if (overCol !== s.id) setOverCol(s.id); } }}
              onDrop={() => { if (dragKey) { const w = items.find((x) => x.key === dragKey); if (w && w.status !== s.id) ops.transition(dragKey, s.id); } setDragKey(null); setOverCol(null); }}>
              <div className="track-col-head"><span className={`track-cat track-cat-${s.category}`} /><span className="track-col-name">{s.name}</span><span className="track-col-count">{col.length}</span></div>
              <div className="track-col-body">
                {col.map((w) => <Card key={w.id} item={w} states={states} onOpen={() => onOpen(w)} onTransition={(st) => ops.transition(w.key, st)} onDragStart={() => setDragKey(w.key)} onDragEnd={() => { setDragKey(null); setOverCol(null); }} dragging={dragKey === w.key} />)}
                {col.length === 0 ? <div className="track-col-empty">{dragKey ? 'Drop here' : '—'}</div> : null}
              </div>
            </section>
          );
        })}
      </div>
    </div>
  );
}

export function RoadmapView({ items, states, onOpen }: { items: WorkItem[]; states: TrackProject['workflowStates']; onOpen: (w: WorkItem) => void }): React.ReactElement {
  const epics = items.filter((w) => w.type === 'epic');
  const orphans = items.filter((w) => w.type !== 'epic' && !w.epicId);
  const cat = (w: WorkItem) => w.statusCategory;
  return (
    <div className="track-roadmap">
      {epics.map((e) => {
        const children = items.filter((w) => w.epicId === e.id);
        const done = children.filter((w) => cat(w) === 'completed').length;
        const pct = children.length ? Math.round((done / children.length) * 100) : 0;
        return (
          <div className="track-epic" key={e.id}>
            <button className="track-epic-head" onClick={() => onOpen(e)}>
              <span className="track-type track-type-epic"><Icon name="spark" size={12} /></span>
              <span className="mono tl-key">{e.key}</span><span className="track-epic-title">{e.title}</span>
              <span className="track-epic-prog"><span className="track-epic-bar" style={{ width: `${pct}%` }} /></span>
              <span className="track-epic-pct">{done}/{children.length}</span>
            </button>
            <div className="track-epic-children">
              {children.map((w) => (
                <button key={w.id} className="track-epic-child" onClick={() => onOpen(w)}>
                  <span className={`track-cat track-cat-${cat(w)}`} /><span className="mono tl-key">{w.key}</span><span className="tl-title">{w.title}</span>
                  <span className="tl-status-mini">{states.find((s) => s.id === w.status)?.name ?? w.status}</span>
                </button>
              ))}
              {children.length === 0 ? <div className="track-col-empty">No items linked to this epic.</div> : null}
            </div>
          </div>
        );
      })}
      {orphans.length ? <div className="track-epic"><div className="track-epic-head plain">No epic ({orphans.length})</div><div className="track-epic-children">{orphans.map((w) => <button key={w.id} className="track-epic-child" onClick={() => onOpen(w)}><span className={`track-cat track-cat-${cat(w)}`} /><span className="mono tl-key">{w.key}</span><span className="tl-title">{w.title}</span></button>)}</div></div> : null}
      {epics.length === 0 && orphans.length === 0 ? <div className="track-empty">No epics yet — create one and link items to it.</div> : null}
    </div>
  );
}
