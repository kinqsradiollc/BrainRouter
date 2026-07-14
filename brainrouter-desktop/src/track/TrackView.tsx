/**
 * Track mode — the main surface (not a right-rail panel): a Jira-class project
 * over the workspace, switched in from the left sidebar (Chat · Track · Code).
 * Views: Board · List · Backlog · Sprint · Roadmap · Reports, a shared filter
 * bar, and a work-item detail drawer. Reads project/items/sprints from App state
 * (fed by host `track-*` queries) and mutates through the `ops` callbacks.
 *
 * This file is the thin shell: it owns the header/tabbar/filter bar + the board
 * layout, delegates every other layout to a cohesive sibling under
 * `./TrackView/`, and re-exports the module's public surface (types + icons)
 * so existing importers of `./TrackView.js` are unaffected.
 */
import React, { useMemo, useRef, useState } from 'react';
import type { TrackProject, WorkItem, WorkItemType, WorkItemPriority, Sprint, Module, SavedView, TrackLayout, AutomationRule, ProjectMember } from '@kinqs/brainrouter-types';
import { parseTrackQuery } from '../lib/track/query.js';
import { Icon } from '../icons.js';
import { TrackDetail } from './TrackDetail.js';
import { PRIORITY_RANK, type SyncConfig, type SyncResult, type GitTrackContext, type TrackPrStatus, type TrackOps } from './TrackView/shared/types.js';
import { looksLikeQuery, FilterChip, Compose, Card, ViewsMenu } from './TrackView/shared/helpers.js';
import { SpreadsheetView, CalendarView, GanttView } from './TrackView/views/LayoutViews.js';
import { ListView, BacklogView, SprintView, RoadmapView } from './TrackView/views/ListViews.js';
import { ModulesView, ReportsView } from './TrackView/views/PanelViews.js';
import { AutomationView } from './TrackView/views/AutomationView.js';
import { MembersView } from './TrackView/views/MembersView.js';
import { SyncView } from './TrackView/views/SyncView.js';

// Re-export the module's public surface so `./TrackView.js` importers are
// unaffected by the split.
export { TYPE_ICON, PRIORITY_RANK } from './TrackView/shared/types.js';
export type { SyncRepoConfig, SyncConfig, SyncRow, SyncResult, GitTrackRemote, GitTrackContext, TrackPrStatus, TrackOps } from './TrackView/shared/types.js';

export interface TrackViewProps {
  project: TrackProject | null;
  items: WorkItem[];
  sprints: Sprint[];
  modules: Module[];
  views: SavedView[];
  automations: AutomationRule[];
  members: ProjectMember[];
  sync: { config: SyncConfig | null; result: SyncResult | null };
  git: GitTrackContext | null;
  pr: TrackPrStatus | null;
  ops: TrackOps;
  /** When the left sidebar is collapsed, show a reopen button in the header. */
  railOpen?: boolean;
  onOpenRail?: () => void;
}

type TrackTab = 'board' | 'list' | 'spreadsheet' | 'calendar' | 'gantt' | 'backlog' | 'sprint' | 'modules' | 'roadmap' | 'reports' | 'automation' | 'members' | 'sync';
interface Filter { type?: WorkItemType; statusCategory?: string; priority?: WorkItemPriority; assignee?: string; text?: string }

const TABS: Array<{ id: TrackTab; label: string; icon: string }> = [
  { id: 'board', label: 'Board', icon: 'layout' },
  { id: 'list', label: 'List', icon: 'tasks' },
  { id: 'spreadsheet', label: 'Sheet', icon: 'tasks' },
  { id: 'calendar', label: 'Calendar', icon: 'panels' },
  { id: 'gantt', label: 'Gantt', icon: 'chart' },
  { id: 'backlog', label: 'Backlog', icon: 'panels' },
  { id: 'sprint', label: 'Sprint', icon: 'bolt' },
  { id: 'modules', label: 'Modules', icon: 'panels' },
  { id: 'roadmap', label: 'Roadmap', icon: 'chart' },
  { id: 'reports', label: 'Reports', icon: 'chart' },
  { id: 'automation', label: 'Automation', icon: 'bolt' },
  { id: 'members', label: 'Members', icon: 'shield' },
  { id: 'sync', label: 'Sync', icon: 'refresh' },
];
const PRIMARY_TAB_IDS = new Set<TrackTab>(['board', 'list', 'backlog', 'sprint', 'roadmap']);
const PRIMARY_TABS = TABS.filter((tab) => PRIMARY_TAB_IDS.has(tab.id));
const MORE_TAB_GROUPS: Array<{ label: string; tabs: TrackTab[] }> = [
  { label: 'Alternate views', tabs: ['spreadsheet', 'calendar', 'gantt'] },
  { label: 'Insights', tabs: ['modules', 'reports'] },
  { label: 'Project', tabs: ['automation', 'members', 'sync'] },
];

export function TrackView({ project, items, sprints, modules, views, automations, members, sync, git, pr, ops, railOpen = true, onOpenRail }: TrackViewProps): React.ReactElement {
  const [tab, setTab] = useState<TrackTab>('board');
  const [moreOpen, setMoreOpen] = useState(false);
  const moreToggleRef = useRef<HTMLButtonElement | null>(null);
  const [filter, setFilter] = useState<Filter>({});
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [composing, setComposing] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  // Drag-and-drop: the work-item key being dragged + the column under the cursor.
  const [dragKey, setDragKey] = useState<string | null>(null);
  const [overCol, setOverCol] = useState<string | null>(null);

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
      (!filter.assignee || w.assignees.includes(filter.assignee)) &&
      (query ? (query.ok ? query.pred!(w) : false) : (!t || w.key.toLowerCase().includes(t) || w.title.toLowerCase().includes(t))));
  }, [items, filter, query]);

  const submitNew = (stateId: string): void => {
    const title = draft.trim();
    if (title) ops.create({ title, type: 'task', status: stateId });
    setDraft(''); setComposing(null);
  };

  const applyView = (v: SavedView): void => {
    setTab(v.layout as TrackTab);
    setFilter({
      type: (v.filters?.type as WorkItemType) || undefined,
      statusCategory: v.filters?.status,
      priority: (v.filters?.priority as WorkItemPriority) || undefined,
      assignee: v.filters?.assignee,
      text: v.query,
    });
  };
  const saveCurrentView = (name: string): void => {
    const filters: Record<string, string> = {};
    if (filter.type) filters.type = filter.type;
    if (filter.statusCategory) filters.status = filter.statusCategory;
    if (filter.priority) filters.priority = filter.priority;
    if (filter.assignee) filters.assignee = filter.assignee;
    const layout: TrackLayout = (['automation', 'members', 'sync'] as string[]).includes(tab) ? 'board' : (tab as TrackLayout);
    ops.saveView({ name, layout, query: filter.text, filters });
  };

  const assignees = useMemo(() => [...new Set(items.flatMap((w) => w.assignees))], [items]);
  // name → color from the project's label registry (for colored chips).
  const labelColors = useMemo(() => {
    const m = new Map<string, string>();
    for (const l of project?.labels ?? []) m.set(l.name.toLowerCase(), l.color);
    return m;
  }, [project]);
  const activeMoreTab = TABS.find((item) => item.id === tab && !PRIMARY_TAB_IDS.has(item.id));
  const selectTab = (next: TrackTab, restoreMoreFocus = false): void => {
    setTab(next);
    setMoreOpen(false);
    if (restoreMoreFocus) requestAnimationFrame(() => moreToggleRef.current?.focus());
  };

  return (
    <div className="track">
      <header className="track-head">
        {!railOpen && onOpenRail ? <button className="icon-btn track-rail-open" title="Open sidebar" aria-label="Open sidebar" onClick={onOpenRail}><Icon name="layout" size={15} /></button> : null}
        <div className="track-title">
          <span className="track-key">{project?.key ?? '—'}</span>
          <span className="track-name">{project?.name ?? 'Project'}</span>
          <span className="track-count">{items.length} item{items.length === 1 ? '' : 's'}</span>
        </div>
        <ViewsMenu views={views} onApply={applyView} onSave={saveCurrentView} onDelete={(id) => ops.deleteView(id)} />
      </header>
      <div className="track-tabbar">
        {PRIMARY_TABS.map((tb) => (
          <button key={tb.id} className={`track-tab${tab === tb.id ? ' active' : ''}`} onClick={() => selectTab(tb.id)}><Icon name={tb.icon} size={12} /> {tb.label}</button>
        ))}
        <button ref={moreToggleRef} type="button" className={`track-tab track-more-toggle${activeMoreTab ? ' active' : ''}`} aria-expanded={moreOpen} aria-controls="track-more-navigation" onClick={() => setMoreOpen((open) => !open)}>
          <Icon name={activeMoreTab?.icon ?? 'panels'} size={12} /> {activeMoreTab?.label ?? 'More'} <Icon name="chev-down" size={9} />
        </button>
      </div>
      {moreOpen ? (
        <div id="track-more-navigation" className="track-more-menu" aria-label="More project views">
          {MORE_TAB_GROUPS.map((group) => (
            <div key={group.label} className="track-more-group">
              <span className="track-more-label">{group.label}</span>
              <div className="track-more-options">
                {group.tabs.map((id) => {
                  const option = TABS.find((item) => item.id === id)!;
                  return (
                    <button key={id} type="button" className={`track-tab${tab === id ? ' active' : ''}`} onClick={() => selectTab(id, true)}>
                      <Icon name={option.icon} size={12} /> {option.label}
                    </button>
                  );
                })}
              </div>
            </div>
          ))}
        </div>
      ) : null}

      {tab !== 'automation' && tab !== 'members' && tab !== 'sync' ? (
      <div className="track-filter">
        <span className={`track-filter-search${query ? (query.ok ? ' is-query' : ' is-bad') : ''}`} title="Type a JQL query like: priority >= high AND status != done">
          <Icon name="search" size={12} />
          <input value={filter.text ?? ''} onChange={(e) => setFilter((f) => ({ ...f, text: e.target.value || undefined }))} placeholder="Filter by text — or a query (priority >= high AND type = bug)" />
          {query ? <span className="track-query-badge">{query.ok ? 'JQL' : '!'}</span> : null}
        </span>
        {query && !query.ok ? <span className="track-query-error" title={query.error}>{query.error}</span> : null}
        <FilterChip label="Type" value={filter.type} options={['epic', 'story', 'task', 'bug', 'sub-task']} onPick={(v) => setFilter((f) => ({ ...f, type: v as WorkItemType }))} />
        <FilterChip label="Status" value={filter.statusCategory} options={['backlog', 'unstarted', 'started', 'completed', 'cancelled']} onPick={(v) => setFilter((f) => ({ ...f, statusCategory: v }))} />
        <FilterChip label="Priority" value={filter.priority} options={['urgent', 'high', 'medium', 'low', 'none']} onPick={(v) => setFilter((f) => ({ ...f, priority: v as WorkItemPriority }))} />
        {assignees.length ? <FilterChip label="Assignee" value={filter.assignee} options={assignees} onPick={(v) => setFilter((f) => ({ ...f, assignee: v }))} /> : null}
        {Object.values(filter).some(Boolean) ? <button className="track-filter-clear" onClick={() => setFilter({})}>Clear</button> : null}
      </div>
      ) : null}

      {tab === 'board' ? (
        <div className="track-board">
          {states.map((s) => {
            const col = filtered.filter((w) => w.status === s.id).sort((a, b) => PRIORITY_RANK[b.priority] - PRIORITY_RANK[a.priority]);
            return (
              <section className={`track-col${dragKey && overCol === s.id ? ' drag-over' : ''}`} key={s.id}
                onDragOver={(e) => { if (dragKey) { e.preventDefault(); e.dataTransfer.dropEffect = 'move'; if (overCol !== s.id) setOverCol(s.id); } }}
                onDrop={() => { if (dragKey) { const w = items.find((x) => x.key === dragKey); if (w && w.status !== s.id) ops.transition(dragKey, s.id); } setDragKey(null); setOverCol(null); }}>
                <div className="track-col-head">
                  <span className={`track-cat track-cat-${s.category}`} /><span className="track-col-name">{s.name}</span><span className="track-col-count">{col.length}</span>
                  <button className="track-add" title={`New in ${s.name}`} onClick={() => { setComposing(s.id); setDraft(''); }}><Icon name="plus" size={12} /></button>
                </div>
                <div className="track-col-body">
                  {composing === s.id ? <Compose draft={draft} setDraft={setDraft} onAdd={() => submitNew(s.id)} onCancel={() => setComposing(null)} /> : null}
                  {col.map((w) => <Card key={w.id} item={w} states={states} labelColors={labelColors} onOpen={() => setSelectedKey(w.key)} onTransition={(st) => ops.transition(w.key, st)} onDragStart={() => setDragKey(w.key)} onDragEnd={() => { setDragKey(null); setOverCol(null); }} dragging={dragKey === w.key} />)}
                  {col.length === 0 && composing !== s.id ? <div className="track-col-empty">{dragKey ? 'Drop here' : '—'}</div> : null}
                </div>
              </section>
            );
          })}
        </div>
      ) : tab === 'list' ? (
        <ListView items={filtered} states={states} onOpen={(w) => setSelectedKey(w.key)} />
      ) : tab === 'spreadsheet' ? (
        <SpreadsheetView items={filtered} states={states} onOpen={(w) => setSelectedKey(w.key)} />
      ) : tab === 'calendar' ? (
        <CalendarView items={filtered} onOpen={(w) => setSelectedKey(w.key)} />
      ) : tab === 'gantt' ? (
        <GanttView items={filtered} onOpen={(w) => setSelectedKey(w.key)} />
      ) : tab === 'backlog' ? (
        <BacklogView items={filtered} sprints={sprints} ops={ops} onOpen={(w) => setSelectedKey(w.key)} />
      ) : tab === 'sprint' ? (
        <SprintView items={items} sprints={sprints} states={states} ops={ops} onOpen={(w) => setSelectedKey(w.key)} />
      ) : tab === 'roadmap' ? (
        <RoadmapView items={filtered} states={states} onOpen={(w) => setSelectedKey(w.key)} />
      ) : tab === 'modules' ? (
        <ModulesView modules={modules} items={items} ops={ops} />
      ) : tab === 'reports' ? (
        <ReportsView items={items} states={states} sprints={sprints} />
      ) : tab === 'automation' ? (
        <AutomationView automations={automations} states={states} ops={ops} />
      ) : tab === 'members' ? (
        <MembersView members={members} ops={ops} provider={sync.config?.provider} />
      ) : (
        <SyncView sync={sync} git={git} ops={ops} />
      )}

      {selected ? <TrackDetail item={selected} project={project} allItems={items} sprints={sprints} modules={modules} ops={ops} onClose={() => setSelectedKey(null)} /> : null}
    </div>
  );
}
