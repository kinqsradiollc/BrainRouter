/**
 * ADR-028 G6 — the planner mode.
 *
 * A fifth workspace mode beside Chat · Code · Track · Meetings, not a right
 * panel. Panels are bound to the current workspace and session; the planner is
 * user-scoped and spans every project, and putting a cross-workspace surface
 * inside a workspace-scoped container is the same category error as scoping the
 * store per repository.
 *
 * Three views over one store, so an item scheduled in Calendar is the same
 * record Today shows and the agent sees.
 *
 * This component renders. Every judgement — grouping, ordering, what is
 * editable, what the empty state says — comes from `plannerView`.
 */
import React, { useMemo, useState } from 'react';
import { Icon } from '../icons.js';
import { Button } from '../components/primitives/Button.js';
import { CalendarView } from './CalendarView.js';
import {
  sortForToday, groupFor, GROUP_LABEL, canEdit, whyReadOnly,
  weekStart, noteList, emptyMessage, conflictBanner,
  type PlannerItemView, type PlannerBlockView, type PlannerView, type TodayGroup,
} from '../lib/planner/plannerView.js';

export interface PlannerOps {
  addItem: (title: string) => void;
  toggleComplete: (id: string, completed: boolean) => void;
  setDueDate: (id: string, date: string | null) => void;
  deleteItem: (id: string) => void;
  scheduleBlock: (itemId: string, minutes: number, at?: string) => void;
  resolveConflict: (id: string, field: string, keep: 'ours' | 'theirs') => void;
  /** Click an empty calendar slot — the primary gesture of every calendar. */
  blockTimeAt: (iso: string) => void;
  openBlock: (blockId: string) => void;
}

const VIEWS: ReadonlyArray<readonly [PlannerView, string, string]> = [
  ['today', 'tasks', 'Today'],
  ['calendar', 'chart', 'Calendar'],
  ['notes', 'file', 'Notes'],
];

export function PlannerMode({
  items, blocks, today, syncState, staleSources, driftNote, ops,
}: {
  items: PlannerItemView[];
  blocks: PlannerBlockView[];
  /** ISO date, `YYYY-MM-DD`. Passed in so the view is deterministic in tests. */
  today: string;
  syncState: string;
  staleSources: string[];
  /** D5's ratio, when there is enough sample to say anything. */
  driftNote: string | null;
  ops: PlannerOps;
}): React.ReactElement {
  const [view, setView] = useState<PlannerView>('today');
  const [draft, setDraft] = useState('');
  const [weekOf, setWeekOf] = useState<string>(() => weekStart(today));

  const scheduledIds = useMemo(
    () => new Set(blocks.filter((b) => !b.completedAt).map((b) => b.itemId)),
    [blocks],
  );
  const open = useMemo(() => items.filter((i) => !i.completed), [items]);
  const sorted = useMemo(() => sortForToday(open, today, scheduledIds), [open, today, scheduledIds]);
  const banner = conflictBanner(items);
  const titleFor = useMemo(() => {
    const map: Record<string, string> = {};
    for (const i of items) map[i.id] = i.title;
    return map;
  }, [items]);

  const submit = (): void => {
    const text = draft.trim();
    if (!text) return;
    ops.addItem(text);
    setDraft('');
  };

  return (
    <div className="planner-mode">
      <header className="planner-head">
        <div className="planner-views" role="tablist" aria-label="Planner view">
          {VIEWS.map(([id, icon, label]) => (
            <button key={id} role="tab" aria-selected={view === id}
              className={`planner-view-btn${view === id ? ' active' : ''}`}
              onClick={() => setView(id)}>
              <Icon name={icon} size={12} /> {label}
            </button>
          ))}
        </div>
        <div className="planner-status">
          {/* ADR-028 D2 — sync runs on its own. A button asking you to press
              it is the network on the critical path wearing a different
              costume: it makes staying in sync YOUR job, and the moment you
              forget once, the planner is quietly wrong. The line reports state
              as a fact; offline is the normal mode that happens to be syncing. */}
          <span className="planner-sync">{syncState}</span>
        </div>
      </header>

      {banner ? (
        // The only planner state that cannot resolve itself, so the only one
        // that gets a banner.
        <div className="planner-conflict-banner">{banner}</div>
      ) : null}

      {staleSources.map((line) => (
        // A stale source says its age rather than presenting items as current.
        <div key={line} className="planner-stale">{line}</div>
      ))}

      {view === 'today' ? (
        <TodayView
          items={sorted} today={today} scheduledIds={scheduledIds}
          draft={draft} setDraft={setDraft} submit={submit}
          driftNote={driftNote} ops={ops}
        />
      ) : view === 'calendar' ? (
        <CalendarView
          blocks={blocks} today={today} titleFor={titleFor}
          weekOf={weekOf} onWeek={setWeekOf}
          onCreateAt={ops.blockTimeAt} onOpenBlock={ops.openBlock}
        />
      ) : (
        <NotesView items={items} />
      )}
    </div>
  );
}

function TodayView({
  items, today, scheduledIds, draft, setDraft, submit, driftNote, ops,
}: {
  items: PlannerItemView[];
  today: string;
  scheduledIds: ReadonlySet<string>;
  draft: string;
  setDraft: (v: string) => void;
  submit: () => void;
  driftNote: string | null;
  ops: PlannerOps;
}): React.ReactElement {
  const empty = emptyMessage('today');
  let lastGroup: TodayGroup | null = null;

  return (
    <div className="planner-body scroll">
      <div className="planner-add">
        <input className="filter" placeholder="What do you intend to do?" value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') submit(); }} />
        <Button variant="primary" onClick={submit}>Add</Button>
      </div>

      {driftNote ? (
        // A ratio that teaches, not a scoreboard. Both directions worded the
        // same way, because praise on one side makes the other feel like
        // failure and then nobody looks at the number.
        <div className="planner-drift">{driftNote}</div>
      ) : null}

      {items.length === 0 ? (
        <div className="empty">
          <span className="empty-title">{empty.title}</span>
          <span className="empty-note">{empty.note}</span>
        </div>
      ) : items.map((item) => {
        const group = groupFor(item, today, scheduledIds);
        const header = group !== lastGroup ? GROUP_LABEL[group] : null;
        lastGroup = group;
        return (
          <React.Fragment key={item.id}>
            {header ? <div className="planner-group">{header}</div> : null}
            <ItemRow item={item} ops={ops} />
          </React.Fragment>
        );
      })}
    </div>
  );
}

function ItemRow({ item, ops }: { item: PlannerItemView; ops: PlannerOps }): React.ReactElement {
  const titleLocked = whyReadOnly(item, 'title');
  return (
    <div className={`planner-row${item.conflictFields.length ? ' conflicted' : ''}`}>
      <input type="checkbox" checked={item.completed}
        aria-label={`Complete ${item.title}`}
        onChange={(e) => ops.toggleComplete(item.id, e.target.checked)} />

      <span className="planner-title" title={titleLocked ?? undefined}>{item.title}</span>

      {item.source ? (
        // Provenance, always. A mirrored item that looks local invites edits
        // the next refresh will undo.
        <span className="planner-source" title={`Mirrored from ${item.source}`}>{item.source}</span>
      ) : null}

      {item.dueDate ? <span className="planner-due">{item.dueDate.slice(0, 10)}</span> : null}

      {item.conflictFields.map((field) => (
        <span key={field} className="planner-conflict">
          {field} differs
          <button onClick={() => ops.resolveConflict(item.id, field, 'ours')}>keep mine</button>
          <button onClick={() => ops.resolveConflict(item.id, field, 'theirs')}>keep theirs</button>
        </span>
      ))}

      {canEdit(item, 'title') ? (
        <button className="planner-del" aria-label={`Delete ${item.title}`}
          onClick={() => ops.deleteItem(item.id)}>
          <Icon name="close" size={11} />
        </button>
      ) : null}
    </div>
  );
}

function NotesView({ items }: { items: PlannerItemView[] }): React.ReactElement {
  const notes = noteList(items);
  const empty = emptyMessage('notes');
  return (
    <div className="planner-body scroll">
      {notes.length === 0 ? (
        <div className="empty">
          <span className="empty-title">{empty.title}</span>
          <span className="empty-note">{empty.note}</span>
        </div>
      ) : notes.map((n) => (
        <div key={n.id} className="planner-note">
          <div className="planner-note-title">{n.title}</div>
          <div className="planner-note-body">{n.notes}</div>
          {n.source ? <span className="planner-source">{n.source}</span> : null}
        </div>
      ))}
    </div>
  );
}
