/**
 * Track mode — the main surface (not a right-rail panel): a Jira-class board
 * over the workspace's project. Switched in from the left sidebar (Chat · Track
 * · Code). Reads the project + work items from App state (fed by host
 * `track-*` queries) and mutates through callbacks that fire those queries.
 */
import React, { useMemo, useState } from 'react';
import type { TrackProject, WorkItem, WorkItemType, WorkItemPriority, StatusCategory } from '@kinqs/brainrouter-types';
import { Icon } from '../icons.js';

const TYPE_ICON: Record<WorkItemType, string> = {
  epic: 'spark', story: 'review', task: 'check-circle', bug: 'warn', 'sub-task': 'tasks',
};
const PRIORITY_RANK: Record<WorkItemPriority, number> = { lowest: 0, low: 1, medium: 2, high: 3, highest: 4 };

export interface TrackViewProps {
  project: TrackProject | null;
  items: WorkItem[];
  onCreate: (input: { title: string; type: WorkItemType; status: string }) => void;
  onTransition: (idOrKey: string, toStatus: string) => void;
  onOpen?: (item: WorkItem) => void;
}

type TrackTab = 'board' | 'list';

export function TrackView({ project, items, onCreate, onTransition, onOpen }: TrackViewProps): React.ReactElement {
  const [tab, setTab] = useState<TrackTab>('board');
  const [composing, setComposing] = useState<string | null>(null); // stateId being added to
  const [draft, setDraft] = useState('');

  const states = project?.workflowStates ?? [];
  const byState = useMemo(() => {
    const m = new Map<string, WorkItem[]>();
    for (const s of states) m.set(s.id, []);
    for (const w of items) (m.get(w.status) ?? m.set(w.status, []).get(w.status)!).push(w);
    for (const list of m.values()) list.sort((a, b) => PRIORITY_RANK[b.priority] - PRIORITY_RANK[a.priority]);
    return m;
  }, [items, states]);

  const submitNew = (stateId: string): void => {
    const title = draft.trim();
    if (title) onCreate({ title, type: 'task', status: stateId });
    setDraft(''); setComposing(null);
  };

  return (
    <div className="track">
      <header className="track-head">
        <div className="track-title">
          <span className="track-key">{project?.key ?? '—'}</span>
          <span className="track-name">{project?.name ?? 'Project'}</span>
          <span className="track-count">{items.length} item{items.length === 1 ? '' : 's'}</span>
        </div>
        <div className="track-tabs">
          <button className={`track-tab${tab === 'board' ? ' active' : ''}`} onClick={() => setTab('board')}><Icon name="layout" size={12} /> Board</button>
          <button className={`track-tab${tab === 'list' ? ' active' : ''}`} onClick={() => setTab('list')}><Icon name="tasks" size={12} /> List</button>
        </div>
      </header>

      {tab === 'board' ? (
        <div className="track-board">
          {states.map((s) => {
            const col = byState.get(s.id) ?? [];
            return (
              <section className="track-col" key={s.id}>
                <div className="track-col-head">
                  <span className={`track-cat track-cat-${s.category}`} />
                  <span className="track-col-name">{s.name}</span>
                  <span className="track-col-count">{col.length}</span>
                  <button className="track-add" title={`New in ${s.name}`} onClick={() => { setComposing(s.id); setDraft(''); }}><Icon name="plus" size={12} /></button>
                </div>
                <div className="track-col-body">
                  {composing === s.id ? (
                    <div className="track-compose">
                      <textarea autoFocus value={draft} onChange={(e) => setDraft(e.target.value)} placeholder="What needs doing?"
                        onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); submitNew(s.id); } if (e.key === 'Escape') setComposing(null); }} />
                      <div className="track-compose-actions">
                        <button className="track-compose-add" onClick={() => submitNew(s.id)}>Add</button>
                        <button className="track-compose-cancel" onClick={() => setComposing(null)}>Cancel</button>
                      </div>
                    </div>
                  ) : null}
                  {col.map((w) => <Card key={w.id} item={w} states={states} onTransition={onTransition} onOpen={onOpen} />)}
                  {col.length === 0 && composing !== s.id ? <div className="track-col-empty">—</div> : null}
                </div>
              </section>
            );
          })}
        </div>
      ) : (
        <div className="track-list">
          <div className="track-list-head">
            <span className="tl-key">Key</span><span className="tl-type">Type</span><span className="tl-title">Title</span>
            <span className="tl-status">Status</span><span className="tl-pri">Priority</span><span className="tl-asn">Assignee</span>
          </div>
          {items.map((w) => (
            <button key={w.id} className="track-list-row" onClick={() => onOpen?.(w)}>
              <span className="tl-key mono">{w.key}</span>
              <span className="tl-type"><Icon name={TYPE_ICON[w.type]} size={12} /> {w.type}</span>
              <span className="tl-title">{w.title}</span>
              <span className="tl-status"><span className={`track-cat track-cat-${w.statusCategory}`} /> {states.find((s) => s.id === w.status)?.name ?? w.status}</span>
              <span className={`tl-pri pri-${w.priority}`}>{w.priority}</span>
              <span className="tl-asn">{w.assignee ?? '—'}</span>
            </button>
          ))}
          {items.length === 0 ? <div className="track-empty">No work items yet — switch to Board and add one.</div> : null}
        </div>
      )}
    </div>
  );
}

function Card({ item, states, onTransition, onOpen }: {
  item: WorkItem; states: TrackProject['workflowStates'];
  onTransition: (idOrKey: string, toStatus: string) => void; onOpen?: (item: WorkItem) => void;
}): React.ReactElement {
  const [menu, setMenu] = useState(false);
  return (
    <div className="track-card" onClick={() => onOpen?.(item)}>
      <div className="track-card-top">
        <span className={`track-type track-type-${item.type}`}><Icon name={TYPE_ICON[item.type]} size={11} /></span>
        <span className="track-card-key mono">{item.key}</span>
        <span className={`track-pri pri-${item.priority}`} title={`Priority: ${item.priority}`} />
        <button className="track-card-move" title="Move" onClick={(e) => { e.stopPropagation(); setMenu((m) => !m); }}><Icon name="chev-down" size={11} /></button>
        {menu ? (
          <div className="track-move-menu" onClick={(e) => e.stopPropagation()}>
            {states.filter((s) => s.id !== item.status).map((s) => (
              <button key={s.id} onClick={() => { onTransition(item.key, s.id); setMenu(false); }}>{s.name}</button>
            ))}
          </div>
        ) : null}
      </div>
      <div className="track-card-title">{item.title}</div>
      {(item.assignee || item.labels.length) ? (
        <div className="track-card-foot">
          {item.labels.slice(0, 2).map((l) => <span key={l} className="track-label">{l}</span>)}
          {item.assignee ? <span className="track-asn" title={item.assignee}>{item.assignee.slice(0, 2).toUpperCase()}</span> : null}
        </div>
      ) : null}
    </div>
  );
}
