/**
 * Track mode — the main surface (not a right-rail panel): a Jira-class project
 * over the workspace, switched in from the left sidebar (Chat · Track · Code).
 * Views: Board · List · Backlog · Sprint · Roadmap · Reports, a shared filter
 * bar, and a work-item detail drawer. Reads project/items/sprints from App state
 * (fed by host `track-*` queries) and mutates through the `ops` callbacks.
 */
import React, { useMemo, useState } from 'react';
import type { TrackProject, WorkItem, WorkItemType, WorkItemPriority, Sprint, SprintState, AutomationRule, AutomationTrigger, AutomationAction, AutomationActionType, ProjectMember, ProjectRole, ProjectCapability } from '@kinqs/brainrouter-types';
import { roleCan } from '../lib/track/permissions.js';
import { parseTrackQuery } from '../lib/track/query.js';
import { Icon } from '../icons.js';
import { TrackDetail } from './TrackDetail.js';

/** True when the search text looks like a JQL query (has an operator/keyword). */
const looksLikeQuery = (s: string): boolean => /[=~<>]|(\s(and|or|in)\s)/i.test(s);

// External sync (GitHub) — view-side shapes mirroring core's githubSync results.
export interface SyncConfig { repo: string | null; hasToken: boolean; tokenSource: string | null }
export interface SyncRow { key?: string; issueNumber?: number; title: string; action: 'create' | 'update' }
export interface SyncResult { direction: 'export' | 'import'; dryRun: boolean; exported?: SyncRow[]; imported?: SyncRow[]; errors: string[] }

export const TYPE_ICON: Record<WorkItemType, string> = {
  epic: 'spark', story: 'review', task: 'check-circle', bug: 'warn', 'sub-task': 'tasks',
};
export const PRIORITY_RANK: Record<WorkItemPriority, number> = { lowest: 0, low: 1, medium: 2, high: 3, highest: 4 };

export interface TrackOps {
  create: (input: { title: string; type: WorkItemType; status: string }) => void;
  transition: (idOrKey: string, toStatus: string) => void;
  update: (idOrKey: string, patch: Partial<WorkItem>) => void;
  comment: (idOrKey: string, body: string) => void;
  link: (idOrKey: string, input: { codeLinks?: WorkItem['codeLinks']; linkedMemoryIds?: string[]; blocks?: string }) => void;
  assignSprint: (idOrKey: string, sprintId: string | null) => void;
  createSprint: (name: string, goal?: string) => void;
  sprintState: (id: string, state: SprintState) => void;
  createAutomation: (input: { name: string; trigger: AutomationTrigger; condition?: string; actions: AutomationAction[] }) => void;
  updateAutomation: (id: string, patch: Partial<AutomationRule>) => void;
  deleteAutomation: (id: string) => void;
  addMember: (input: { id: string; name?: string; role: ProjectRole }) => void;
  updateMemberRole: (id: string, role: ProjectRole) => void;
  removeMember: (id: string) => void;
  syncMembers: () => void;
  sync: (direction: 'import' | 'export', dryRun: boolean) => void;
}

export interface TrackViewProps {
  project: TrackProject | null;
  items: WorkItem[];
  sprints: Sprint[];
  automations: AutomationRule[];
  members: ProjectMember[];
  sync: { config: SyncConfig | null; result: SyncResult | null };
  ops: TrackOps;
}

type TrackTab = 'board' | 'list' | 'backlog' | 'sprint' | 'roadmap' | 'reports' | 'automation' | 'members' | 'sync';
interface Filter { type?: WorkItemType; statusCategory?: string; priority?: WorkItemPriority; assignee?: string; text?: string }

const TABS: Array<{ id: TrackTab; label: string; icon: string }> = [
  { id: 'board', label: 'Board', icon: 'layout' },
  { id: 'list', label: 'List', icon: 'tasks' },
  { id: 'backlog', label: 'Backlog', icon: 'panels' },
  { id: 'sprint', label: 'Sprint', icon: 'bolt' },
  { id: 'roadmap', label: 'Roadmap', icon: 'chart' },
  { id: 'reports', label: 'Reports', icon: 'chart' },
  { id: 'automation', label: 'Automation', icon: 'bolt' },
  { id: 'members', label: 'Members', icon: 'shield' },
  { id: 'sync', label: 'Sync', icon: 'refresh' },
];

export function TrackView({ project, items, sprints, automations, members, sync, ops }: TrackViewProps): React.ReactElement {
  const [tab, setTab] = useState<TrackTab>('board');
  const [filter, setFilter] = useState<Filter>({});
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [composing, setComposing] = useState<string | null>(null);
  const [draft, setDraft] = useState('');

  const states = project?.workflowStates ?? [];
  const selected = selectedKey ? items.find((w) => w.key === selectedKey) ?? null : null;

  // The search box is dual-purpose: a JQL query (e.g. `priority >= high AND
  // status != done`) when it contains an operator, otherwise a plain substring.
  const query = useMemo(() => {
    const q = filter.text?.trim();
    if (!q || !looksLikeQuery(q)) return null;
    return parseTrackQuery(q);
  }, [filter.text]);

  const filtered = useMemo(() => {
    const t = query ? undefined : filter.text?.toLowerCase();
    return items.filter((w) =>
      (!filter.type || w.type === filter.type) &&
      (!filter.statusCategory || w.statusCategory === filter.statusCategory) &&
      (!filter.priority || w.priority === filter.priority) &&
      (!filter.assignee || w.assignee === filter.assignee) &&
      (query ? (query.ok ? query.pred!(w) : false) : (!t || w.key.toLowerCase().includes(t) || w.title.toLowerCase().includes(t))));
  }, [items, filter, query]);

  const submitNew = (stateId: string): void => {
    const title = draft.trim();
    if (title) ops.create({ title, type: 'task', status: stateId });
    setDraft(''); setComposing(null);
  };

  const assignees = useMemo(() => [...new Set(items.map((w) => w.assignee).filter(Boolean) as string[])], [items]);

  return (
    <div className="track">
      <header className="track-head">
        <div className="track-title">
          <span className="track-key">{project?.key ?? '—'}</span>
          <span className="track-name">{project?.name ?? 'Project'}</span>
          <span className="track-count">{items.length} item{items.length === 1 ? '' : 's'}</span>
        </div>
      </header>
      <div className="track-tabbar">
        {TABS.map((tb) => (
          <button key={tb.id} className={`track-tab${tab === tb.id ? ' active' : ''}`} onClick={() => setTab(tb.id)}><Icon name={tb.icon} size={12} /> {tb.label}</button>
        ))}
      </div>

      {tab !== 'automation' && tab !== 'members' && tab !== 'sync' ? (
      <div className="track-filter">
        <span className={`track-filter-search${query ? (query.ok ? ' is-query' : ' is-bad') : ''}`} title="Type a JQL query like: priority >= high AND status != done">
          <Icon name="search" size={12} />
          <input value={filter.text ?? ''} onChange={(e) => setFilter((f) => ({ ...f, text: e.target.value || undefined }))} placeholder="Filter by text — or a query (priority >= high AND type = bug)" />
          {query ? <span className="track-query-badge">{query.ok ? 'JQL' : '!'}</span> : null}
        </span>
        {query && !query.ok ? <span className="track-query-error" title={query.error}>{query.error}</span> : null}
        <FilterChip label="Type" value={filter.type} options={['epic', 'story', 'task', 'bug', 'sub-task']} onPick={(v) => setFilter((f) => ({ ...f, type: v as WorkItemType }))} />
        <FilterChip label="Status" value={filter.statusCategory} options={['todo', 'in-progress', 'done']} onPick={(v) => setFilter((f) => ({ ...f, statusCategory: v }))} />
        <FilterChip label="Priority" value={filter.priority} options={['highest', 'high', 'medium', 'low', 'lowest']} onPick={(v) => setFilter((f) => ({ ...f, priority: v as WorkItemPriority }))} />
        {assignees.length ? <FilterChip label="Assignee" value={filter.assignee} options={assignees} onPick={(v) => setFilter((f) => ({ ...f, assignee: v }))} /> : null}
        {Object.values(filter).some(Boolean) ? <button className="track-filter-clear" onClick={() => setFilter({})}>Clear</button> : null}
      </div>
      ) : null}

      {tab === 'board' ? (
        <div className="track-board">
          {states.map((s) => {
            const col = filtered.filter((w) => w.status === s.id).sort((a, b) => PRIORITY_RANK[b.priority] - PRIORITY_RANK[a.priority]);
            return (
              <section className="track-col" key={s.id}>
                <div className="track-col-head">
                  <span className={`track-cat track-cat-${s.category}`} /><span className="track-col-name">{s.name}</span><span className="track-col-count">{col.length}</span>
                  <button className="track-add" title={`New in ${s.name}`} onClick={() => { setComposing(s.id); setDraft(''); }}><Icon name="plus" size={12} /></button>
                </div>
                <div className="track-col-body">
                  {composing === s.id ? <Compose draft={draft} setDraft={setDraft} onAdd={() => submitNew(s.id)} onCancel={() => setComposing(null)} /> : null}
                  {col.map((w) => <Card key={w.id} item={w} states={states} onTransition={ops.transition} onOpen={() => setSelectedKey(w.key)} />)}
                  {col.length === 0 && composing !== s.id ? <div className="track-col-empty">—</div> : null}
                </div>
              </section>
            );
          })}
        </div>
      ) : tab === 'list' ? (
        <ListView items={filtered} states={states} onOpen={(w) => setSelectedKey(w.key)} />
      ) : tab === 'backlog' ? (
        <BacklogView items={filtered} sprints={sprints} ops={ops} onOpen={(w) => setSelectedKey(w.key)} />
      ) : tab === 'sprint' ? (
        <SprintView items={items} sprints={sprints} states={states} ops={ops} onOpen={(w) => setSelectedKey(w.key)} />
      ) : tab === 'roadmap' ? (
        <RoadmapView items={filtered} states={states} onOpen={(w) => setSelectedKey(w.key)} />
      ) : tab === 'reports' ? (
        <ReportsView items={items} states={states} sprints={sprints} />
      ) : tab === 'automation' ? (
        <AutomationView automations={automations} states={states} ops={ops} />
      ) : tab === 'members' ? (
        <MembersView members={members} ops={ops} />
      ) : (
        <SyncView sync={sync} ops={ops} />
      )}

      {selected ? <TrackDetail item={selected} project={project} allItems={items} sprints={sprints} ops={ops} onClose={() => setSelectedKey(null)} /> : null}
    </div>
  );
}

function FilterChip({ label, value, options, onPick }: { label: string; value?: string; options: string[]; onPick: (v: string | undefined) => void }): React.ReactElement {
  const [open, setOpen] = useState(false);
  return (
    <span className="track-fchip-wrap">
      <button className={`track-fchip${value ? ' active' : ''}`} onClick={() => setOpen((o) => !o)}>{label}{value ? `: ${value}` : ''} <Icon name="chev-down" size={10} /></button>
      {open ? (
        <div className="track-fmenu" onMouseLeave={() => setOpen(false)}>
          <button onClick={() => { onPick(undefined); setOpen(false); }}>Any</button>
          {options.map((o) => <button key={o} className={value === o ? 'active' : ''} onClick={() => { onPick(o); setOpen(false); }}>{o}</button>)}
        </div>
      ) : null}
    </span>
  );
}

function Compose({ draft, setDraft, onAdd, onCancel }: { draft: string; setDraft: (s: string) => void; onAdd: () => void; onCancel: () => void }): React.ReactElement {
  return (
    <div className="track-compose">
      <textarea autoFocus value={draft} onChange={(e) => setDraft(e.target.value)} placeholder="What needs doing?"
        onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); onAdd(); } if (e.key === 'Escape') onCancel(); }} />
      <div className="track-compose-actions"><button className="track-compose-add" onClick={onAdd}>Add</button><button className="track-compose-cancel" onClick={onCancel}>Cancel</button></div>
    </div>
  );
}

function Card({ item, states, onTransition, onOpen }: { item: WorkItem; states: TrackProject['workflowStates']; onTransition: (k: string, s: string) => void; onOpen: () => void }): React.ReactElement {
  const [menu, setMenu] = useState(false);
  return (
    <div className="track-card" onClick={onOpen}>
      <div className="track-card-top">
        <span className={`track-type track-type-${item.type}`}><Icon name={TYPE_ICON[item.type]} size={11} /></span>
        <span className="track-card-key mono">{item.key}</span>
        <span className={`track-pri pri-${item.priority}`} title={`Priority: ${item.priority}`} />
        <button className="track-card-move" title="Move" onClick={(e) => { e.stopPropagation(); setMenu((m) => !m); }}><Icon name="chev-down" size={11} /></button>
        {menu ? (
          <div className="track-move-menu" onClick={(e) => e.stopPropagation()}>
            {states.filter((s) => s.id !== item.status).map((s) => <button key={s.id} onClick={() => { onTransition(item.key, s.id); setMenu(false); }}>{s.name}</button>)}
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

function ListView({ items, states, onOpen }: { items: WorkItem[]; states: TrackProject['workflowStates']; onOpen: (w: WorkItem) => void }): React.ReactElement {
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
          <span className="tl-asn">{w.assignee ?? '—'}</span>
        </button>
      ))}
      {items.length === 0 ? <div className="track-empty">No matching work items.</div> : null}
    </div>
  );
}

function BacklogView({ items, sprints, ops, onOpen }: { items: WorkItem[]; sprints: Sprint[]; ops: TrackOps; onOpen: (w: WorkItem) => void }): React.ReactElement {
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
            <select className="track-sprint-select" value="" onChange={(e) => { if (e.target.value) ops.assignSprint(w.key, e.target.value); }}>
              <option value="">→ sprint…</option>
              {sprints.filter((s) => s.state !== 'completed').map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
            </select>
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

function SprintView({ items, sprints, states, ops, onOpen }: { items: WorkItem[]; sprints: Sprint[]; states: TrackProject['workflowStates']; ops: TrackOps; onOpen: (w: WorkItem) => void }): React.ReactElement {
  const active = sprints.find((s) => s.state === 'active') ?? sprints[0];
  if (!active) return <div className="track-empty">No sprint yet — create one in Backlog.</div>;
  const sprintItems = items.filter((w) => w.sprintId === active.id);
  const points = sprintItems.reduce((n, w) => n + (w.storyPoints ?? 0), 0);
  const done = sprintItems.filter((w) => w.statusCategory === 'done').length;
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
            <section className="track-col" key={s.id}>
              <div className="track-col-head"><span className={`track-cat track-cat-${s.category}`} /><span className="track-col-name">{s.name}</span><span className="track-col-count">{col.length}</span></div>
              <div className="track-col-body">
                {col.map((w) => <Card key={w.id} item={w} states={states} onTransition={ops.transition} onOpen={() => onOpen(w)} />)}
                {col.length === 0 ? <div className="track-col-empty">—</div> : null}
              </div>
            </section>
          );
        })}
      </div>
    </div>
  );
}

function RoadmapView({ items, states, onOpen }: { items: WorkItem[]; states: TrackProject['workflowStates']; onOpen: (w: WorkItem) => void }): React.ReactElement {
  const epics = items.filter((w) => w.type === 'epic');
  const orphans = items.filter((w) => w.type !== 'epic' && !w.epicId);
  const cat = (w: WorkItem) => w.statusCategory;
  return (
    <div className="track-roadmap">
      {epics.map((e) => {
        const children = items.filter((w) => w.epicId === e.id);
        const done = children.filter((w) => cat(w) === 'done').length;
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

function ReportsView({ items, states, sprints }: { items: WorkItem[]; states: TrackProject['workflowStates']; sprints: Sprint[] }): React.ReactElement {
  const byCat = (c: string) => items.filter((w) => w.statusCategory === c).length;
  const byType = (t: WorkItemType) => items.filter((w) => w.type === t).length;
  const byPri = (p: WorkItemPriority) => items.filter((w) => w.priority === p).length;
  const total = items.length || 1;
  const points = items.reduce((n, w) => n + (w.storyPoints ?? 0), 0);
  const donePoints = items.filter((w) => w.statusCategory === 'done').reduce((n, w) => n + (w.storyPoints ?? 0), 0);
  return (
    <div className="track-reports">
      <div className="track-report-card">
        <div className="track-report-title">Status</div>
        {(['todo', 'in-progress', 'done'] as const).map((c) => (
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
        {(['highest', 'high', 'medium', 'low', 'lowest'] as const).map((p) => byPri(p) ? (
          <div key={p} className="track-report-row"><span className={`track-pri pri-${p}`} /><span className="trr-label">{p}</span><span className="trr-n">{byPri(p)}</span></div>
        ) : null)}
      </div>
      <div className="track-report-card">
        <div className="track-report-title">Throughput</div>
        <div className="track-report-big">{Math.round((byCat('done') / total) * 100)}%<span> done</span></div>
        <div className="track-report-row"><span className="trr-label">Items</span><span className="trr-n">{byCat('done')} / {items.length}</span></div>
        {points ? <div className="track-report-row"><span className="trr-label">Story points</span><span className="trr-n">{donePoints} / {points}</span></div> : null}
        <div className="track-report-row"><span className="trr-label">Sprints</span><span className="trr-n">{sprints.filter((s) => s.state === 'active').length} active · {sprints.length} total</span></div>
      </div>
    </div>
  );
}

const TRIGGERS: Array<{ id: AutomationTrigger; label: string; hint: string }> = [
  { id: 'created', label: 'When created', hint: 'a new work item is added' },
  { id: 'transitioned', label: 'When moved', hint: 'an item changes status' },
  { id: 'updated', label: 'When edited', hint: 'any field changes' },
];
const ACTION_TYPES: Array<{ id: AutomationActionType; label: string; placeholder: string }> = [
  { id: 'set-status', label: 'Set status', placeholder: 'status id (e.g. in-progress)' },
  { id: 'set-priority', label: 'Set priority', placeholder: 'highest · high · medium · low · lowest' },
  { id: 'set-assignee', label: 'Assign to', placeholder: 'name' },
  { id: 'add-label', label: 'Add label', placeholder: 'label' },
  { id: 'comment', label: 'Comment', placeholder: 'comment text' },
];
const actionLabel = (a: AutomationAction): string => `${ACTION_TYPES.find((t) => t.id === a.type)?.label ?? a.type}: ${a.value}`;

function AutomationView({ automations, states, ops }: { automations: AutomationRule[]; states: TrackProject['workflowStates']; ops: TrackOps }): React.ReactElement {
  const [adding, setAdding] = useState(false);
  return (
    <div className="track-automation">
      <div className="track-section-head">
        Automation rules <span className="track-col-count">{automations.length}</span>
        <button className="track-auto-new" onClick={() => setAdding((a) => !a)}><Icon name={adding ? 'close' : 'plus'} size={12} /> {adding ? 'Cancel' : 'New rule'}</button>
      </div>
      <p className="track-auto-intro">When something happens on this project, run an action automatically — no human in the loop. Conditions use the same query language as the filter bar (e.g. <code>type = bug</code>).</p>
      {adding ? <AutomationForm states={states} onCreate={(input) => { ops.createAutomation(input); setAdding(false); }} onCancel={() => setAdding(false)} /> : null}
      <div className="track-auto-list">
        {automations.map((r) => (
          <div key={r.id} className={`track-auto-row${r.enabled ? '' : ' off'}`}>
            <button className={`track-auto-toggle${r.enabled ? ' on' : ''}`} title={r.enabled ? 'Enabled — click to pause' : 'Paused — click to enable'} onClick={() => ops.updateAutomation(r.id, { enabled: !r.enabled })}>
              <span className="track-auto-knob" />
            </button>
            <div className="track-auto-body">
              <div className="track-auto-name">{r.name}</div>
              <div className="track-auto-flow">
                <span className="track-auto-trigger">{TRIGGERS.find((t) => t.id === r.trigger)?.label ?? r.trigger}</span>
                {r.condition ? <span className="track-auto-cond mono">if {r.condition}</span> : null}
                <Icon name="chev-right" size={11} />
                {r.actions.map((a, i) => <span key={i} className="track-auto-act">{actionLabel(a)}</span>)}
              </div>
            </div>
            <button className="track-auto-del" title="Delete rule" onClick={() => ops.deleteAutomation(r.id)}><Icon name="trash" size={12} /></button>
          </div>
        ))}
        {automations.length === 0 && !adding ? <div className="track-empty">No automation rules yet. Create one to run actions automatically.</div> : null}
      </div>
    </div>
  );
}

function AutomationForm({ states, onCreate, onCancel }: { states: TrackProject['workflowStates']; onCreate: (input: { name: string; trigger: AutomationTrigger; condition?: string; actions: AutomationAction[] }) => void; onCancel: () => void }): React.ReactElement {
  const [name, setName] = useState('');
  const [trigger, setTrigger] = useState<AutomationTrigger>('created');
  const [condition, setCondition] = useState('');
  const [actions, setActions] = useState<AutomationAction[]>([{ type: 'set-priority', value: '' }]);
  const condCheck = useMemo(() => (condition.trim() ? parseTrackQuery(condition.trim()) : null), [condition]);
  const valid = name.trim() && actions.every((a) => a.value.trim()) && (!condCheck || condCheck.ok);

  const setAction = (i: number, patch: Partial<AutomationAction>): void => setActions((as) => as.map((a, j) => (j === i ? { ...a, ...patch } : a)));
  const submit = (): void => {
    if (!valid) return;
    onCreate({ name: name.trim(), trigger, condition: condition.trim() || undefined, actions: actions.map((a) => ({ ...a, value: a.value.trim() })) });
  };

  return (
    <div className="track-auto-form">
      <input className="track-auto-fname" autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder="Rule name (e.g. Bugs start at high priority)" />
      <div className="track-auto-field">
        <label>When</label>
        <select value={trigger} onChange={(e) => setTrigger(e.target.value as AutomationTrigger)}>
          {TRIGGERS.map((t) => <option key={t.id} value={t.id}>{t.label} — {t.hint}</option>)}
        </select>
      </div>
      <div className="track-auto-field">
        <label>If <span className="track-auto-opt">(optional query)</span></label>
        <input className={`mono${condCheck && !condCheck.ok ? ' bad' : ''}`} value={condition} onChange={(e) => setCondition(e.target.value)} placeholder="type = bug AND priority >= high" />
        {condCheck && !condCheck.ok ? <span className="track-auto-cond-err">{condCheck.error}</span> : null}
      </div>
      <div className="track-auto-field">
        <label>Then</label>
        <div className="track-auto-actions">
          {actions.map((a, i) => (
            <div key={i} className="track-auto-actrow">
              <select value={a.type} onChange={(e) => setAction(i, { type: e.target.value as AutomationActionType })}>
                {ACTION_TYPES.map((t) => <option key={t.id} value={t.id}>{t.label}</option>)}
              </select>
              {a.type === 'set-status' ? (
                <select value={a.value} onChange={(e) => setAction(i, { value: e.target.value })}>
                  <option value="">status…</option>
                  {states.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
                </select>
              ) : a.type === 'set-priority' ? (
                <select value={a.value} onChange={(e) => setAction(i, { value: e.target.value })}>
                  <option value="">priority…</option>
                  {(['highest', 'high', 'medium', 'low', 'lowest'] as const).map((p) => <option key={p} value={p}>{p}</option>)}
                </select>
              ) : (
                <input value={a.value} onChange={(e) => setAction(i, { value: e.target.value })} placeholder={ACTION_TYPES.find((t) => t.id === a.type)?.placeholder} />
              )}
              {actions.length > 1 ? <button className="track-auto-actdel" title="Remove action" onClick={() => setActions((as) => as.filter((_, j) => j !== i))}><Icon name="close" size={11} /></button> : null}
            </div>
          ))}
          <button className="track-auto-addact" onClick={() => setActions((as) => [...as, { type: 'add-label', value: '' }])}><Icon name="plus" size={11} /> Add action</button>
        </div>
      </div>
      <div className="track-auto-form-actions">
        <button className="track-auto-save" disabled={!valid} onClick={submit}>Create rule</button>
        <button className="track-auto-cancel" onClick={onCancel}>Cancel</button>
      </div>
    </div>
  );
}

const ROLES: Array<{ id: ProjectRole; label: string; blurb: string }> = [
  { id: 'owner', label: 'Owner', blurb: 'Full control, incl. members & deletion' },
  { id: 'admin', label: 'Admin', blurb: 'Manage members, automation, delete items' },
  { id: 'member', label: 'Member', blurb: 'Create, edit & plan work' },
  { id: 'viewer', label: 'Viewer', blurb: 'Read-only access to the board' },
];
const CAPS: Array<{ cap: ProjectCapability; label: string }> = [
  { cap: 'view', label: 'View board' },
  { cap: 'create-item', label: 'Create items' },
  { cap: 'edit-item', label: 'Edit & comment' },
  { cap: 'manage-sprints', label: 'Manage sprints' },
  { cap: 'delete-item', label: 'Delete items' },
  { cap: 'manage-automation', label: 'Automation' },
  { cap: 'manage-members', label: 'Manage members' },
];

function MembersView({ members, ops }: { members: ProjectMember[]; ops: TrackOps }): React.ReactElement {
  const [adding, setAdding] = useState(false);
  const [id, setId] = useState('');
  const [name, setName] = useState('');
  const [role, setRole] = useState<ProjectRole>('member');
  const owners = members.filter((m) => m.role === 'owner').length;
  const soleOwner = (m: ProjectMember): boolean => m.role === 'owner' && owners === 1;

  const submit = (): void => {
    const handle = id.trim();
    if (!handle) return;
    ops.addMember({ id: handle, name: name.trim() || undefined, role });
    setId(''); setName(''); setRole('member'); setAdding(false);
  };

  return (
    <div className="track-members">
      <div className="track-section-head">
        Members <span className="track-col-count">{members.length}</span>
        <button className="track-member-pull" title="Import this repo's collaborators as members (roles mapped from their GitHub permission)" onClick={() => ops.syncMembers()}><Icon name="refresh" size={12} /> Pull from GitHub</button>
        <button className="track-auto-new" onClick={() => setAdding((a) => !a)}><Icon name={adding ? 'close' : 'plus'} size={12} /> {adding ? 'Cancel' : 'Add member'}</button>
      </div>
      <p className="track-auto-intro">Each member has a role that gates what they can do on this project. <b>Pull from GitHub</b> imports the repo's collaborators (admin → admin · write → member · read → viewer); the local owner is kept. The board, the CLI, and the agent all enforce the same policy.</p>

      {adding ? (
        <div className="track-member-form">
          <input className="track-member-id" autoFocus value={id} onChange={(e) => setId(e.target.value)} placeholder="handle (username / email)" />
          <input className="track-member-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="display name (optional)" />
          <select value={role} onChange={(e) => setRole(e.target.value as ProjectRole)}>
            {ROLES.map((r) => <option key={r.id} value={r.id}>{r.label}</option>)}
          </select>
          <button className="track-auto-save" disabled={!id.trim()} onClick={submit}>Add</button>
        </div>
      ) : null}

      <div className="track-member-list">
        {members.map((m) => (
          <div key={m.id} className="track-member-row">
            <span className="track-member-avatar">{(m.name ?? m.id).slice(0, 2).toUpperCase()}</span>
            <div className="track-member-id-col">
              <span className="track-member-disp">{m.name ?? m.id}</span>
              <span className="track-member-handle mono">{m.id}</span>
            </div>
            <select className="track-member-role" value={m.role} disabled={soleOwner(m)} title={soleOwner(m) ? 'The sole owner role is locked' : 'Change role'}
              onChange={(e) => ops.updateMemberRole(m.id, e.target.value as ProjectRole)}>
              {ROLES.map((r) => <option key={r.id} value={r.id}>{r.label}</option>)}
            </select>
            <button className="track-member-del" title={soleOwner(m) ? 'Cannot remove the last owner' : 'Remove member'} disabled={soleOwner(m)} onClick={() => ops.removeMember(m.id)}><Icon name="trash" size={12} /></button>
          </div>
        ))}
      </div>

      <div className="track-perm-matrix">
        <div className="track-perm-title">What each role can do</div>
        <table>
          <thead><tr><th>Capability</th>{ROLES.map((r) => <th key={r.id}>{r.label}</th>)}</tr></thead>
          <tbody>
            {CAPS.map((c) => (
              <tr key={c.cap}>
                <td>{c.label}</td>
                {ROLES.map((r) => <td key={r.id} className={roleCan(r.id, c.cap) ? 'yes' : 'no'}>{roleCan(r.id, c.cap) ? '✓' : '·'}</td>)}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function SyncView({ sync, ops }: { sync: { config: SyncConfig | null; result: SyncResult | null }; ops: TrackOps }): React.ReactElement {
  const [busy, setBusy] = useState<'import' | 'export' | null>(null);
  const cfg = sync.config;
  const result = sync.result;
  const configured = !!(cfg?.repo && cfg?.hasToken);

  // Clear the busy spinner whenever a fresh result lands.
  React.useEffect(() => { setBusy(null); }, [result]);

  const run = (direction: 'import' | 'export', dryRun: boolean): void => {
    if (!configured) return;
    setBusy(direction);
    ops.sync(direction, dryRun);
  };
  const rows = result ? (result.exported ?? result.imported ?? []) : [];

  return (
    <div className="track-sync">
      <div className="track-section-head">External sync <span className="track-col-count">GitHub Issues</span></div>
      <p className="track-auto-intro">Two-way sync between this project and a GitHub repository's issues. Work items export as issues (type/priority become labels, done → closed); issues import back as work items. Re-runs update in place — no duplicates.</p>

      <div className="track-sync-config">
        <div className="track-sync-conn">
          <span className={`track-sync-dot${configured ? ' on' : ''}`} />
          {cfg?.repo ? (
            <>
              <span className="track-sync-repo mono">{cfg.repo}</span>
              <span className={`track-sync-token${cfg.hasToken ? ' ok' : ''}`}>{cfg.hasToken ? `token via ${cfg.tokenSource}` : 'no token'}</span>
            </>
          ) : <span className="track-sync-unset">No repository configured</span>}
        </div>
        {!configured ? (
          <p className="track-sync-help">
            Set <code className="mono">cli.track.githubRepo</code> (e.g. <code className="mono">owner/name</code>) and a token in
            <code className="mono"> cli.track.githubToken</code> — or export <code className="mono">GITHUB_TOKEN</code> — then reopen this tab.
          </p>
        ) : null}
      </div>

      <div className="track-sync-actions">
        <div className="track-sync-act">
          <div className="track-sync-act-head"><Icon name="arrow-up" size={13} /> Export → GitHub</div>
          <div className="track-sync-act-sub">Push work items to issues</div>
          <div className="track-sync-btns">
            <button className="track-sync-dry" disabled={!configured || !!busy} onClick={() => run('export', true)}>Dry-run</button>
            <button className="track-sync-go" disabled={!configured || !!busy} onClick={() => run('export', false)}>{busy === 'export' ? 'Exporting…' : 'Export'}</button>
          </div>
        </div>
        <div className="track-sync-act">
          <div className="track-sync-act-head"><Icon name="arrow-down" size={13} /> Import ← GitHub</div>
          <div className="track-sync-act-sub">Pull issues into the board</div>
          <div className="track-sync-btns">
            <button className="track-sync-dry" disabled={!configured || !!busy} onClick={() => run('import', true)}>Dry-run</button>
            <button className="track-sync-go" disabled={!configured || !!busy} onClick={() => run('import', false)}>{busy === 'import' ? 'Importing…' : 'Import'}</button>
          </div>
        </div>
      </div>

      {result ? (
        <div className="track-sync-result">
          <div className="track-sync-result-head">
            {result.dryRun ? <span className="track-sync-badge dry">Dry-run</span> : <span className="track-sync-badge live">Applied</span>}
            {result.direction === 'export' ? 'Export' : 'Import'} — {rows.filter((r) => r.action === 'create').length} new, {rows.filter((r) => r.action === 'update').length} updated
          </div>
          <div className="track-sync-rows">
            {rows.map((r, i) => (
              <div key={i} className="track-sync-row">
                <span className={`track-sync-act-tag ${r.action}`}>{r.action === 'create' ? '+ new' : '~ upd'}</span>
                <span className="mono tl-key">{r.key ?? (r.issueNumber ? `#${r.issueNumber}` : '—')}</span>
                <span className="tl-title">{r.title}</span>
              </div>
            ))}
            {rows.length === 0 ? <div className="track-col-empty">Nothing to sync.</div> : null}
          </div>
          {result.errors.length ? (
            <div className="track-sync-errors">{result.errors.map((e, i) => <div key={i}>{e}</div>)}</div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
