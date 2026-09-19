/**
 * ADR-038 — the Planner presentation shared by Dashboard and Desktop.
 * Host shells own transport, auth, local persistence, routing, and external
 * effects; this component owns hierarchy, interactions, accessibility, and the
 * visual vocabulary people must not relearn between surfaces.
 */
import {
  Fragment,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import type { FocusEvent, KeyboardEvent, ReactElement, ReactNode } from 'react';

import { PlannerCalendar } from './PlannerCalendar.js';
import type {
  PlannerItemView,
  PlannerOps,
  PlannerSurfaceProps,
  PlannerSyncBlocker,
  PlannerSyncView,
  PlannerView,
  TodayGroup,
} from './types.js';
import {
  GROUP_LABEL,
  QUICK_ESTIMATES,
  addDays,
  canEdit,
  carriedForItem,
  conflictBanner,
  dayLabel,
  dayProgress,
  emptyMessage,
  formatMinutes,
  groupFor,
  itemsForDay,
  noteList,
  provenanceFor,
  relativeDayLabel,
  shiftWeek,
  shortDayLabel,
  sortForToday,
  visibleEstimate,
  weekStart,
  weekStrip,
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
  // The day the Today panel is looking at. Today by default; any day of the
  // week strip can be focused to see what it holds, and "Today" brings it back.
  const [focusDate, setFocusDate] = useState(today);
  const [stripWeekOf, setStripWeekOf] = useState(() => weekStart(today));
  useEffect(() => { setFocusDate(today); setStripWeekOf(weekStart(today)); }, [today]);
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
            allItems={items}
            items={open}
            completed={done}
            blocks={blocks}
            today={today}
            focusDate={focusDate}
            onFocusDate={(date) => { setFocusDate(date); setStripWeekOf(weekStart(date)); }}
            stripWeekOf={stripWeekOf}
            onStripWeek={setStripWeekOf}
            scheduledIds={scheduledIds}
            draft={draft}
            onDraft={setDraft}
            onSubmit={submit}
            driftNote={driftNote}
            ops={ops}
            onOpenCalendar={() => setView('calendar')}
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

/** The short reason for the label; the full sentence lives in the popover. */
export function syncBlockerShort(kind: PlannerSyncBlocker['kind']): string {
  switch (kind) {
    case 'local-only': return 'no server configured';
    case 'sign-in': return 'sign in to sync';
    case 'organization': return 'choose an organization';
    case 'unreachable': return 'server unreachable';
    default: return 'sync failed';
  }
}

/** What the label says, given what the host last learned. */
export function syncLabel(sync: PlannerSyncView): string {
  if (sync.blocker && sync.pendingCount > 0) {
    return `${sync.pendingCount} change${sync.pendingCount === 1 ? '' : 's'} waiting — ${syncBlockerShort(sync.blocker.kind)}.`;
  }
  return sync.label;
}

function SyncControl({ sync }: { sync: PlannerSyncView }): ReactElement {
  const [open, setOpen] = useState(false);
  const failed = sync.issues.filter((issue) => issue.attempts > 0);
  // A blocker is a failure the person can act on; "no server configured" is a
  // mode, not a failure, and stays quiet.
  const blocked = sync.blocker && sync.blocker.kind !== 'local-only' && sync.pendingCount > 0;
  return (
    <div className="br-planner-sync">
      <button
        type="button"
        className={failed.length || blocked ? 'has-failure' : sync.pendingCount ? 'has-pending' : ''}
        aria-expanded={open}
        aria-controls="br-planner-sync-detail"
        onClick={() => setOpen((value) => !value)}
      >
        <span className="br-planner-sync-dot" aria-hidden="true" />
        <span>{syncLabel(sync)}</span>
      </button>
      {open ? (
        <div id="br-planner-sync-detail" className="br-planner-sync-popover" role="region" aria-label="Planner sync details">
          <div className="br-planner-sync-summary">
            <strong>{sync.pendingCount ? `${sync.pendingCount} queued change${sync.pendingCount === 1 ? '' : 's'}` : 'No queued changes'}</strong>
            {sync.lastSyncedAt ? <span>Last synced {formatSyncTime(sync.lastSyncedAt)}</span> : null}
          </div>
          {sync.blocker ? (
            <p className={`br-planner-sync-blocker is-${sync.blocker.kind}`} role="status">
              {sync.blocker.message}
              {sync.blocker.since ? <small> · since {formatSyncTime(sync.blocker.since)}</small> : null}
            </p>
          ) : null}
          {sync.issues.length ? (
            <ul>
              {sync.issues.map((issue) => (
                <li key={issue.id}>
                  <span>{issue.itemTitle ?? issue.itemId ?? issue.action}</span>
                  <small>
                    {issue.entity} · {issue.action}
                    {issue.ageLabel ? ` · queued ${issue.ageLabel}` : ''}
                    {issue.lastError ? ` · ${issue.lastError}` : sync.blocker ? '' : ' · Waiting for a connection.'}
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
  allItems,
  items,
  completed,
  blocks,
  today,
  focusDate,
  onFocusDate,
  stripWeekOf,
  onStripWeek,
  scheduledIds,
  draft,
  onDraft,
  onSubmit,
  driftNote,
  ops,
  onOpenCalendar,
}: {
  allItems: PlannerItemView[];
  items: PlannerItemView[];
  completed: PlannerItemView[];
  blocks: PlannerSurfaceProps['blocks'];
  today: string;
  focusDate: string;
  onFocusDate: (date: string) => void;
  stripWeekOf: string;
  onStripWeek: (weekOf: string) => void;
  scheduledIds: ReadonlySet<string>;
  draft: string;
  onDraft: (value: string) => void;
  onSubmit: () => void;
  driftNote: string | null;
  ops: PlannerOps;
  onOpenCalendar: () => void;
}): ReactElement {
  const empty = emptyMessage('today');
  const captureRef = useRef<HTMLInputElement | null>(null);
  const focusingToday = focusDate === today;
  const progress = useMemo(() => dayProgress(allItems, blocks, today), [allItems, blocks, today]);
  const strip = useMemo(() => weekStrip(allItems, blocks, stripWeekOf, today), [allItems, blocks, stripWeekOf, today]);
  // A focused day other than today is a plain look at what that day holds.
  const dayItems = useMemo(() => (focusingToday ? [] : itemsForDay(allItems, blocks, focusDate)), [allItems, blocks, focusDate, focusingToday]);
  const dayOpen = dayItems.filter((item) => !item.completed);
  const dayDone = dayItems.filter((item) => item.completed);
  const nothingAtAll = allItems.length === 0;
  let lastGroup: TodayGroup | null = null;

  const overdueOwned = items.filter((item) => groupFor(item, today, scheduledIds) === 'overdue' && canEdit(item, 'dueDate'));
  const moveOverdueToToday = (): void => {
    for (const item of overdueOwned) ops.setDueDate?.(item.id, today);
  };

  return (
    <div className="br-planner-scroll">
      <div className="br-planner-day">
        <div className="br-planner-day-title">
          <strong>{relativeDayLabel(focusDate, today)}</strong>
          <span>{focusingToday ? dayLabel(today) : `${dayOpen.length} open · ${dayDone.length} done`}</span>
          {!focusingToday ? (
            <button type="button" className="br-planner-day-back" onClick={() => onFocusDate(today)}>Back to today</button>
          ) : null}
        </div>
        {focusingToday && progress.total > 0 ? (
          <div className="br-planner-day-score" aria-label={`${progress.done} of ${progress.total} done today`}>
            <span>{progress.done} of {progress.total} done</span>
            <div className="br-planner-progress" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={progress.percent} aria-label="Today's progress">
              <div style={{ width: `${progress.percent}%` }} />
            </div>
            <span className="br-planner-day-pct">{progress.percent}%</span>
          </div>
        ) : null}
      </div>

      <div className="br-planner-week" role="group" aria-label="This week">
        <button type="button" className="br-planner-week-nav" aria-label="Previous week" onClick={() => onStripWeek(shiftWeek(stripWeekOf, -1))}>‹</button>
        {strip.map((day) => {
          const count = day.open + day.carried;
          const state = day.done + count === 0 ? 'nothing' : count === 0 ? 'done' : 'open';
          return (
            <button
              type="button"
              key={day.date}
              className={`br-planner-week-day${day.isToday ? ' is-today' : ''}${day.date === focusDate ? ' is-focused' : ''}${day.isPast ? ' is-past' : ''} is-${state}`}
              aria-pressed={day.date === focusDate}
              aria-label={`${day.weekday} ${day.day}: ${count} open, ${day.done} done`}
              onClick={() => onFocusDate(day.date)}
            >
              <span>{day.weekday}</span>
              <strong>{day.day}</strong>
              <small>{count > 0 ? count : day.done > 0 ? '✓' : '·'}</small>
            </button>
          );
        })}
        <button type="button" className="br-planner-week-nav" aria-label="Next week" onClick={() => onStripWeek(shiftWeek(stripWeekOf, 1))}>›</button>
        {stripWeekOf !== weekStart(today) || !focusingToday ? (
          <button type="button" className="br-planner-week-today" onClick={() => onFocusDate(today)}>Today</button>
        ) : null}
      </div>

      {ops.addItem && focusingToday ? (
        <div className="br-planner-capture">
          <input
            ref={captureRef}
            value={draft}
            onChange={(event) => onDraft(event.target.value)}
            onKeyDown={(event) => { if (event.key === 'Enter') onSubmit(); }}
            placeholder="What do you intend to do? Press Enter to add"
            aria-label="New planner item"
          />
          <button type="button" onClick={onSubmit} disabled={!draft.trim()}>Add</button>
        </div>
      ) : null}
      {driftNote && focusingToday ? <div className="br-planner-drift">{driftNote}</div> : null}

      {!focusingToday ? (
        <>
          {dayItems.length === 0 ? (
            <div className="br-planner-empty">
              <strong>Nothing on {relativeDayLabel(focusDate, today)}</strong>
              <span>Give an item this day from its row, or block time for it in the calendar.</span>
            </div>
          ) : null}
          {dayOpen.map((item) => <ItemRow key={item.id} item={item} blocks={blocks} today={today} ops={ops} />)}
          {dayDone.length ? (
            <details className="br-planner-completed" open>
              <summary>Completed <span>{dayDone.length}</span></summary>
              {dayDone.map((item) => <ItemRow key={item.id} item={item} blocks={blocks} today={today} ops={ops} />)}
            </details>
          ) : null}
        </>
      ) : nothingAtAll ? (
        <div className="br-planner-empty br-planner-starters">
          <strong>{empty.title}</strong>
          <span>Three ways to start the day:</span>
          <div className="br-planner-starter-list">
            {ops.addItem ? (
              <button type="button" onClick={() => captureRef.current?.focus()}>
                <strong>Capture an intention</strong>
                <span>Type it above and press Enter. It lands under Anytime until you give it a day.</span>
              </button>
            ) : null}
            <button type="button" onClick={onOpenCalendar}>
              <strong>Block an hour</strong>
              <span>Open the calendar and pick a slot; estimates start meaning something once time is real.</span>
            </button>
            <div>
              <strong>Bring in connected issues</strong>
              <span>Issues from a linked source appear here with their own chip, ready to schedule.</span>
            </div>
          </div>
        </div>
      ) : items.length === 0 && completed.length === 0 ? (
        <div className="br-planner-empty"><strong>{empty.title}</strong><span>{empty.note}</span></div>
      ) : null}

      {focusingToday ? items.map((item) => {
        const group = groupFor(item, today, scheduledIds);
        const heading = group === lastGroup ? null : GROUP_LABEL[group];
        lastGroup = group;
        return (
          <Fragment key={item.id}>
            {heading ? (
              <div className="br-planner-group-row">
                <h2 className="br-planner-group">{heading}</h2>
                {group === 'overdue' && ops.setDueDate && overdueOwned.length ? (
                  <button type="button" className="br-planner-group-action" onClick={moveOverdueToToday}>
                    Move {overdueOwned.length === 1 ? 'it' : `all ${overdueOwned.length}`} to today
                  </button>
                ) : null}
              </div>
            ) : null}
            <ItemRow item={item} blocks={blocks} today={today} ops={ops} />
          </Fragment>
        );
      }) : null}
      {focusingToday && completed.length ? (
        <details className="br-planner-completed" open>
          <summary>Completed <span>{completed.length}</span></summary>
          {completed.map((item) => <ItemRow key={item.id} item={item} blocks={blocks} today={today} ops={ops} />)}
        </details>
      ) : null}
    </div>
  );
}

/**
 * A small popover anchored to a chip. Closes on Escape and when focus leaves
 * it, so the keyboard path is: Tab to the chip, Enter, Tab through the picks,
 * Escape back. Non-modal: the gate treats a modal dialog as a blocked surface.
 */
function ChipPopover({ label, open, onOpen, className, children }: {
  label: ReactNode;
  open: boolean;
  onOpen: (open: boolean) => void;
  className: string;
  children: ReactNode;
}): ReactElement {
  const rootRef = useRef<HTMLDivElement | null>(null);
  const leave = (event: FocusEvent<HTMLDivElement>): void => {
    if (!rootRef.current?.contains(event.relatedTarget as Node | null)) onOpen(false);
  };
  return (
    <div
      ref={rootRef}
      className={`br-planner-chip${open ? ' is-open' : ''}`}
      onBlur={leave}
      onKeyDown={(event) => { if (event.key === 'Escape' && open) { event.preventDefault(); onOpen(false); } }}
    >
      {label}
      {open ? <div className={`br-planner-popover ${className}`} role="group">{children}</div> : null}
    </div>
  );
}

/** "When" — the day an item belongs to, set from the row in two clicks. */
function WhenChip({ item, today, ops }: { item: PlannerItemView; today: string; ops: PlannerOps }): ReactElement | null {
  const [open, setOpen] = useState(false);
  const due = item.dueDate?.slice(0, 10) ?? null;
  const editable = Boolean(ops.setDueDate) && canEdit(item, 'dueDate');
  const set = (date: string | null): void => { ops.setDueDate?.(item.id, date); setOpen(false); };
  if (!editable) {
    return due ? (
      <time className="br-planner-due" dateTime={item.dueDate} title={`${dayLabel(due)} · ${whyReadOnly(item, 'dueDate') ?? ''}`}>
        {shortDayLabel(due, today)}
      </time>
    ) : null;
  }
  const week = weekStart(today);
  const days = Array.from({ length: 7 }, (_, index) => addDays(week, index));
  return (
    <ChipPopover
      open={open}
      onOpen={setOpen}
      className="br-planner-when-popover"
      label={(
        <button
          type="button"
          className={`br-planner-due${due ? '' : ' is-unset'}${due && due < today ? ' is-late' : ''}`}
          aria-label={`Due date for ${item.title}`}
          aria-expanded={open}
          title={due ? dayLabel(due) : 'Give this item a day'}
          onClick={() => setOpen((value) => !value)}
        >
          {due ? shortDayLabel(due, today) : 'Set day'}
        </button>
      )}
    >
      <div className="br-planner-popover-row">
        <button type="button" onClick={() => set(today)}>Today</button>
        <button type="button" onClick={() => set(addDays(today, 1))}>Tomorrow</button>
        <button type="button" onClick={() => set(addDays(today, 7))}>Next week</button>
      </div>
      <div className="br-planner-popover-days" role="group" aria-label="This week">
        {days.map((date) => {
          const d = new Date(`${date}T00:00:00.000Z`);
          return (
            <button
              type="button"
              key={date}
              className={`${date === due ? 'is-selected' : ''}${date === today ? ' is-today' : ''}${date < today ? ' is-past' : ''}`}
              aria-label={`${dayLabel(date)}`}
              aria-pressed={date === due}
              onClick={() => set(date)}
            >
              <span>{['S', 'M', 'T', 'W', 'T', 'F', 'S'][d.getUTCDay()]}</span>
              <strong>{d.getUTCDate()}</strong>
            </button>
          );
        })}
      </div>
      <div className="br-planner-popover-row">
        <input
          type="date"
          value={due ?? ''}
          aria-label={`Pick a date for ${item.title}`}
          onChange={(event) => ops.setDueDate?.(item.id, event.target.value || null)}
        />
        {due ? <button type="button" onClick={() => set(null)}>Clear</button> : null}
      </div>
    </ChipPopover>
  );
}

/** The estimate — shown when known, settable in one click when the host can hold a block. */
function EstimateChip({ item, blocks, ops }: { item: PlannerItemView; blocks: PlannerSurfaceProps['blocks']; ops: PlannerOps }): ReactElement | null {
  const [open, setOpen] = useState(false);
  const estimate = visibleEstimate(item, blocks);
  const editable = Boolean(ops.scheduleBlock) && !item.completed;
  if (!editable) return estimate ? <span className="br-planner-badge" title="Estimated time">{formatMinutes(estimate)}</span> : null;
  return (
    <ChipPopover
      open={open}
      onOpen={setOpen}
      className="br-planner-estimate-popover"
      label={(
        <button
          type="button"
          className={`br-planner-badge br-planner-estimate${estimate ? '' : ' is-unset'}`}
          aria-label={`Estimate for ${item.title}`}
          aria-expanded={open}
          title={estimate ? 'Estimated time' : 'Add an estimate'}
          onClick={() => setOpen((value) => !value)}
        >
          {estimate ? formatMinutes(estimate) : '＋ est'}
        </button>
      )}
    >
      <div className="br-planner-popover-row">
        {QUICK_ESTIMATES.map((minutes) => (
          <button type="button" key={minutes} className={estimate === minutes ? 'is-selected' : ''} onClick={() => { ops.scheduleBlock?.(item.id, minutes); setOpen(false); }}>
            {formatMinutes(minutes)}
          </button>
        ))}
      </div>
    </ChipPopover>
  );
}

function ItemRow({ item, blocks, today, ops }: {
  item: PlannerItemView;
  blocks: PlannerSurfaceProps['blocks'];
  today: string;
  ops: PlannerOps;
}): ReactElement {
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
      {/* Four fixed cells — flags · source · estimate · day — so every row's
          chips sit in the same columns and the eye reads DOWN a column instead
          of hunting across a ragged edge. Empty cells stay in the grid. */}
      <span className="br-planner-meta">
        <span className="br-planner-cell br-planner-flags">
          {item.blockedReason ? <span className="br-planner-badge is-blocked" title={item.blockedReason}>Blocked</span> : null}
          {carried > 2 ? <span className="br-planner-badge" title={`Moved forward ${carried} times`}>Moved {carried}×</span> : null}
        </span>
        <span className="br-planner-cell">
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
        </span>
        <span className="br-planner-cell"><EstimateChip item={item} blocks={blocks} ops={ops} /></span>
        {/*
          D3 — the field that SORTS the day, editable from the surface whose job is
          the day. `groupFor` reads `dueDate` to decide overdue / due today / next
          / anytime. Owned-only, and honestly so: `dueDate` is not in Core's
          PLANNER_OWNED_FIELDS, so a due date set on a mirrored issue would be
          undone by the next refresh; `whyReadOnly` says exactly that as the tooltip.
        */}
        <span className="br-planner-cell"><WhenChip item={item} today={today} ops={ops} /></span>
      </span>
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
      ) : <span className="br-planner-delete-slot" aria-hidden="true" />}
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
