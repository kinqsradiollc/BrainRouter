/**
 * ADR-038 — the Planner presentation shared by Dashboard and Desktop.
 * Host shells own transport, auth, local persistence, routing, and external
 * effects; this component owns hierarchy, interactions, accessibility, and the
 * visual vocabulary people must not relearn between surfaces.
 */
import {
  Fragment,
  useMemo,
  useRef,
  useState,
} from 'react';
import type { KeyboardEvent, ReactElement } from 'react';

import { PlannerCalendar } from './PlannerCalendar.js';
import type {
  PlannerItemView,
  PlannerOps,
  PlannerSurfaceProps,
  PlannerSyncView,
  PlannerView,
  TodayGroup,
} from './types.js';
import {
  GROUP_LABEL,
  canEdit,
  carriedForItem,
  conflictBanner,
  emptyMessage,
  formatMinutes,
  groupFor,
  noteList,
  provenanceFor,
  sortForToday,
  visibleEstimate,
  weekStart,
  scheduledTodayIds,
  whyReadOnly,
} from './viewModel.js';

const VIEWS: ReadonlyArray<readonly [PlannerView, string]> = [
  ['today', 'Today'],
  ['calendar', 'Calendar'],
  ['notes', 'Notes'],
];

export function PlannerSurface({
  items,
  blocks,
  today,
  sync,
  staleSources = [],
  driftNote = null,
  refLabels = {},
  ops,
  initialView = 'today',
  renderNotesText,
}: PlannerSurfaceProps): ReactElement {
  const [view, setView] = useState<PlannerView>(initialView);
  const [draft, setDraft] = useState('');
  const [weekOf, setWeekOf] = useState(() => weekStart(today));
  const tabs = useRef<Array<HTMLButtonElement | null>>([]);
  const scheduledIds = useMemo(() => scheduledTodayIds(blocks, today), [blocks, today]);
  const open = useMemo(() => sortForToday(items.filter((item) => !item.completed), today, scheduledIds), [items, scheduledIds, today]);
  const done = useMemo(() => items.filter((item) => item.completed), [items]);
  const titleFor = useMemo(() => Object.fromEntries(items.map((item) => [item.id, item.title])), [items]);
  const banner = conflictBanner(items);

  const selectTab = (event: KeyboardEvent<HTMLButtonElement>, index: number): void => {
    let next = index;
    if (event.key === 'ArrowRight') next = (index + 1) % VIEWS.length;
    else if (event.key === 'ArrowLeft') next = (index - 1 + VIEWS.length) % VIEWS.length;
    else if (event.key === 'Home') next = 0;
    else if (event.key === 'End') next = VIEWS.length - 1;
    else return;
    event.preventDefault();
    setView(VIEWS[next]![0]);
    tabs.current[next]?.focus();
  };

  const submit = (): void => {
    const title = draft.trim();
    if (!title || !ops.addItem) return;
    ops.addItem(title);
    setDraft('');
  };

  return (
    <section className="br-planner" aria-label="Planner">
      <header className="br-planner-header">
        <div className="br-planner-tabs" role="tablist" aria-label="Planner view">
          {VIEWS.map(([id, label], index) => (
            <button
              type="button"
              key={id}
              ref={(node) => { tabs.current[index] = node; }}
              id={`br-planner-tab-${id}`}
              role="tab"
              aria-selected={view === id}
              aria-controls={`br-planner-panel-${id}`}
              tabIndex={view === id ? 0 : -1}
              className={view === id ? 'is-active' : ''}
              onClick={() => setView(id)}
              onKeyDown={(event) => selectTab(event, index)}
            >
              {label}
            </button>
          ))}
        </div>
        <SyncControl sync={sync} />
      </header>

      {banner ? <div className="br-planner-banner" role="status">{banner}</div> : null}
      {staleSources.map((line) => <div key={line} className="br-planner-stale" role="status">{line}</div>)}

      <div
        id={`br-planner-panel-${view}`}
        role="tabpanel"
        aria-labelledby={`br-planner-tab-${view}`}
        className="br-planner-panel"
      >
        {view === 'today' ? (
          <TodayView
            items={open}
            completed={done}
            blocks={blocks}
            today={today}
            scheduledIds={scheduledIds}
            draft={draft}
            onDraft={setDraft}
            onSubmit={submit}
            driftNote={driftNote}
            ops={ops}
          />
        ) : view === 'calendar' ? (
          <PlannerCalendar
            blocks={blocks}
            today={today}
            titleFor={titleFor}
            weekOf={weekOf}
            onWeek={setWeekOf}
            onCreateAt={ops.blockTimeAt}
            onRescheduleBlock={ops.rescheduleBlock}
            onRecordActual={ops.recordActual}
          />
        ) : (
          <NotesView
            items={items}
            refLabels={refLabels}
            ops={ops}
            renderNotesText={renderNotesText}
          />
        )}
      </div>
    </section>
  );
}

function SyncControl({ sync }: { sync: PlannerSyncView }): ReactElement {
  const [open, setOpen] = useState(false);
  const failed = sync.issues.filter((issue) => issue.attempts > 0);
  return (
    <div className="br-planner-sync">
      <button
        type="button"
        className={failed.length ? 'has-failure' : sync.pendingCount ? 'has-pending' : ''}
        aria-expanded={open}
        aria-controls="br-planner-sync-detail"
        onClick={() => setOpen((value) => !value)}
      >
        <span className="br-planner-sync-dot" aria-hidden="true" />
        <span>{sync.label}</span>
      </button>
      {open ? (
        <div id="br-planner-sync-detail" className="br-planner-sync-popover" role="region" aria-label="Planner sync details">
          <div className="br-planner-sync-summary">
            <strong>{sync.pendingCount ? `${sync.pendingCount} queued change${sync.pendingCount === 1 ? '' : 's'}` : 'No queued changes'}</strong>
            {sync.lastSyncedAt ? <span>Last synced {formatSyncTime(sync.lastSyncedAt)}</span> : null}
          </div>
          {sync.issues.length ? (
            <ul>
              {sync.issues.map((issue) => (
                <li key={issue.id}>
                  <span>{issue.itemTitle ?? issue.itemId ?? issue.action}</span>
                  <small>
                    {issue.entity} · {issue.action}
                    {issue.ageLabel ? ` · queued ${issue.ageLabel}` : ''}
                    {issue.lastError ? ` · ${issue.lastError}` : ' · Waiting for a connection.'}
                    {issue.attempts ? ` · ${issue.attempts} attempt${issue.attempts === 1 ? '' : 's'}` : ''}
                  </small>
                  {/* `stuck` alone is five failed attempts, and below it the row
                      showed an error and an attempt count while offering nothing
                      to do about it. Anything that has failed once can be retried
                      by hand — but NOT while a retry is already in flight, or the
                      click has no visible consequence and invites another. */}
                  {(issue.stuck || issue.attempts > 0) && !issue.retryRequested && sync.onRetryIssue ? (
                    <button type="button" className="br-planner-retry-issue" onClick={() => sync.onRetryIssue?.(issue.id)}>
                      Retry this change
                    </button>
                  ) : null}
                </li>
              ))}
            </ul>
          ) : <p>Everything on this device has reached the server.</p>}
          {sync.onRetry && sync.pendingCount ? (
            <button type="button" className="br-planner-retry" disabled={sync.retrying} onClick={sync.onRetry}>
              {sync.retrying ? 'Retrying…' : 'Retry queued changes'}
            </button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

function TodayView({
  items,
  completed,
  blocks,
  today,
  scheduledIds,
  draft,
  onDraft,
  onSubmit,
  driftNote,
  ops,
}: {
  items: PlannerItemView[];
  completed: PlannerItemView[];
  blocks: PlannerSurfaceProps['blocks'];
  today: string;
  scheduledIds: ReadonlySet<string>;
  draft: string;
  onDraft: (value: string) => void;
  onSubmit: () => void;
  driftNote: string | null;
  ops: PlannerOps;
}): ReactElement {
  const empty = emptyMessage('today');
  let lastGroup: TodayGroup | null = null;
  return (
    <div className="br-planner-scroll">
      {ops.addItem ? (
        <div className="br-planner-capture">
          <input
            value={draft}
            onChange={(event) => onDraft(event.target.value)}
            onKeyDown={(event) => { if (event.key === 'Enter') onSubmit(); }}
            placeholder="What do you intend to do?"
            aria-label="New planner item"
          />
          <button type="button" onClick={onSubmit} disabled={!draft.trim()}>Add</button>
        </div>
      ) : null}
      {driftNote ? <div className="br-planner-drift">{driftNote}</div> : null}
      {items.length === 0 && completed.length === 0 ? (
        <div className="br-planner-empty"><strong>{empty.title}</strong><span>{empty.note}</span></div>
      ) : null}
      {items.map((item) => {
        const group = groupFor(item, today, scheduledIds);
        const heading = group === lastGroup ? null : GROUP_LABEL[group];
        lastGroup = group;
        return (
          <Fragment key={item.id}>
            {heading ? <h2 className="br-planner-group">{heading}</h2> : null}
            <ItemRow item={item} blocks={blocks} ops={ops} />
          </Fragment>
        );
      })}
      {completed.length ? (
        <details className="br-planner-completed" open>
          <summary>Completed <span>{completed.length}</span></summary>
          {completed.map((item) => <ItemRow key={item.id} item={item} blocks={blocks} ops={ops} />)}
        </details>
      ) : null}
    </div>
  );
}

function ItemRow({ item, blocks, ops }: {
  item: PlannerItemView;
  blocks: PlannerSurfaceProps['blocks'];
  ops: PlannerOps;
}): ReactElement {
  const estimate = visibleEstimate(item, blocks);
  const carried = carriedForItem(item.id, blocks);
  const titleLocked = whyReadOnly(item, 'title');
  const provenance = provenanceFor(item);
  const conflicts = item.conflicts ?? item.conflictFields.map((field) => ({
    field,
    versionA: { label: 'Version A', value: 'Retained version' },
    versionB: { label: 'Version B', value: 'Retained version' },
  }));
  return (
    <div className={`br-planner-row${item.completed ? ' is-complete' : ''}${conflicts.length ? ' has-conflict' : ''}`}>
      <input
        type="checkbox"
        checked={item.completed}
        disabled={!ops.toggleComplete || !canEdit(item, 'completed')}
        title={whyReadOnly(item, 'completed') ?? undefined}
        aria-label={`${item.completed ? 'Reopen' : 'Complete'} ${item.title}`}
        onChange={(event) => ops.toggleComplete?.(item.id, event.target.checked)}
      />
      <span className="br-planner-title" title={titleLocked ?? undefined}>{item.title}</span>
      {item.blockedReason ? <span className="br-planner-badge is-blocked" title={item.blockedReason}>Blocked</span> : null}
      {carried > 2 ? <span className="br-planner-badge" title={`Moved forward ${carried} times`}>Moved {carried}×</span> : null}
      {estimate ? <span className="br-planner-badge" title="Estimated time">{formatMinutes(estimate)}</span> : null}
      {provenance ? (
        <button
          type="button"
          className="br-planner-source"
          title={`${provenance.kind ? `${provenance.kind} from ` : 'Open '}${provenance.source}${provenance.externalId ? ` ${provenance.externalId}` : ''}${provenance.freshness?.label ? ` · ${provenance.freshness.label}` : ''}`}
          data-stale={provenance.freshness?.stale ? 'true' : undefined}
          disabled={!provenance.url || !ops.openSource}
          onClick={() => { if (provenance.url) ops.openSource?.(provenance.url); }}
        >
          {provenance.source}{provenance.externalId ? ` ${provenance.externalId}` : ''}
        </button>
      ) : null}
      {/*
        D3 — the field that SORTS the day, editable from the surface whose job is
        the day. `groupFor` reads `dueDate` to decide overdue / due today / next
        / anytime, and until now nothing on either host could set it: `setDueDate`
        was declared on the contract and implemented by the desktop, and no
        component called it. `/planner due` worked from the terminal, so the CLI
        could move work the GUI could not — the inverse of D5.

        Owned-only, and honestly so: `dueDate` is not in Core's
        PLANNER_OWNED_FIELDS, so a due date set on a mirrored issue would be
        undone by the next refresh. `whyReadOnly` already says exactly that, and
        it is the tooltip rather than a disabled control with no explanation.
      */}
      {ops.setDueDate && canEdit(item, 'dueDate') ? (
        <input
          type="date"
          className="br-planner-due"
          value={item.dueDate?.slice(0, 10) ?? ''}
          aria-label={`Due date for ${item.title}`}
          onChange={(event) => ops.setDueDate?.(item.id, event.target.value || null)}
        />
      ) : item.dueDate ? (
        <time className="br-planner-due" dateTime={item.dueDate} title={whyReadOnly(item, 'dueDate') ?? undefined}>
          {item.dueDate.slice(0, 10)}
        </time>
      ) : null}
      {conflicts.map((conflict) => (
        <span key={conflict.field} className="br-planner-conflict">
          <span>{conflict.field} differs</span>
          <span title={conflict.versionA.value}>{conflict.versionA.label}: {conflict.versionA.value}</span>
          <span title={conflict.versionB.value}>{conflict.versionB.label}: {conflict.versionB.value}</span>
          {ops.resolveConflict ? (
            <>
              <button type="button" onClick={() => ops.resolveConflict?.(item.id, conflict.field, 'ours')}>Keep version A</button>
              <button type="button" onClick={() => ops.resolveConflict?.(item.id, conflict.field, 'theirs')}>Keep version B</button>
            </>
          ) : null}
        </span>
      ))}
      {canEdit(item, 'delete') && ops.deleteItem ? (
        <button type="button" className="br-planner-delete" aria-label={`Delete ${item.title}`} onClick={() => ops.deleteItem?.(item.id)}>×</button>
      ) : null}
    </div>
  );
}

function NotesView({
  items,
  refLabels,
  ops,
  renderNotesText,
}: {
  items: PlannerItemView[];
  refLabels: Record<string, string>;
  ops: PlannerOps;
  renderNotesText: PlannerSurfaceProps['renderNotesText'];
}): ReactElement {
  const notes = noteList(items);
  const empty = emptyMessage('notes');
  return (
    <div className="br-planner-scroll">
      {notes.length === 0 ? (
        <div className="br-planner-empty"><strong>{empty.title}</strong><span>{empty.note}</span></div>
      ) : notes.map((note) => (
        <article key={note.id} className="br-planner-note">
          <h2>{note.title}</h2>
          <div>{renderNotesText
            ? renderNotesText(note.notes ?? '', refLabels, ops.openRef)
            : note.notes}</div>
          <footer>
            {note.source ? <span>{note.source}</span> : null}
            {ops.openNotesPage ? (
              <button type="button" onClick={() => ops.openNotesPage?.(note.id, note.title, note.notes ?? '')}>Open as a page</button>
            ) : null}
          </footer>
        </article>
      ))}
    </div>
  );
}

function formatSyncTime(iso: string): string {
  const value = new Date(iso);
  return Number.isNaN(value.getTime()) ? iso : value.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}
