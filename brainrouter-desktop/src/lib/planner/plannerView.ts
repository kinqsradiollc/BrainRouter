/**
 * ADR-028 G6 — the planner mode's view model.
 *
 * Pure. The three views (Today · Calendar · Notes) render what this decides, so
 * the judgements are testable without Electron and the components stay markup.
 *
 * The planner is user-scoped and cross-workspace (D9), so nothing here takes a
 * workspace root. If a function in this file ever needs one, the scoping has
 * regressed.
 */

export interface PlannerItemView {
  id: string;
  title: string;
  notes?: string;
  dueDate?: string;
  priority?: number;
  completed: boolean;
  /** 'owned' items can be edited freely; 'mirrored' ones belong to a source. */
  origin: 'owned' | 'mirrored';
  source?: string;
  /** Fields whose merge could not be decided — the human picks (D4). */
  conflictFields: string[];
}

export interface PlannerBlockView {
  id: string;
  itemId: string;
  scheduledFor?: string;
  estimateMinutes: number;
  actualMinutes?: number;
  carriedOver: number;
  completedAt?: string;
}

export type PlannerView = 'today' | 'calendar' | 'notes';

/**
 * How an item is grouped in Today.
 *
 * `overdue` is a grouping, NOT a badge. D5 rejects a red overdue count: it makes
 * the surface feel like an accusation, and the response is to stop opening it.
 * The item still appears in today's list; it is simply sorted first, because
 * something you meant to do days ago is the most likely thing to matter now.
 */
export type TodayGroup = 'overdue' | 'due' | 'scheduled' | 'anytime';

export function groupFor(item: PlannerItemView, today: string, scheduledIds: ReadonlySet<string>): TodayGroup {
  if (item.dueDate && item.dueDate.slice(0, 10) < today) return 'overdue';
  if (item.dueDate && item.dueDate.slice(0, 10) === today) return 'due';
  if (scheduledIds.has(item.id)) return 'scheduled';
  return 'anytime';
}

const GROUP_ORDER: Record<TodayGroup, number> = {
  overdue: 0, due: 1, scheduled: 2, anytime: 3,
};

/** Group label. Plain, never scolding — "Overdue", not "3 tasks late!". */
export const GROUP_LABEL: Record<TodayGroup, string> = {
  overdue: 'Carried over',
  due: 'Due today',
  scheduled: 'Scheduled',
  anytime: 'Anytime',
};

export function sortForToday(
  items: readonly PlannerItemView[],
  today: string,
  scheduledIds: ReadonlySet<string>,
): PlannerItemView[] {
  return [...items].sort((a, b) => {
    const g = GROUP_ORDER[groupFor(a, today, scheduledIds)] - GROUP_ORDER[groupFor(b, today, scheduledIds)];
    if (g !== 0) return g;
    const p = (a.priority ?? 99) - (b.priority ?? 99);
    if (p !== 0) return p;
    return a.title.localeCompare(b.title);
  });
}

/**
 * Which fields may this surface edit?
 *
 * D1: local edits to a mirrored item are limited to planner metadata. Changing
 * a GitHub issue's title here would be reverted by the next refresh, so the
 * control is not offered rather than offered-and-silently-undone.
 */
const PLANNER_OWNED_FIELDS = new Set(['priority', 'scheduledFor', 'snoozedUntil', 'order']);

export function canEdit(item: PlannerItemView, field: string): boolean {
  if (item.origin === 'owned') return true;
  return PLANNER_OWNED_FIELDS.has(field);
}

/** Why a control is absent, for the tooltip. */
export function whyReadOnly(item: PlannerItemView, field: string): string | null {
  if (canEdit(item, field)) return null;
  return `"${field}" belongs to ${item.source ?? 'the source'}. Editing it here would be undone by the next refresh.`;
}

/* ------------------------------------------------------------- the calendar */

export interface CalendarDay {
  date: string;
  blocks: PlannerBlockView[];
  /** Planned minutes for the day. */
  plannedMinutes: number;
  /** True for the day being viewed. */
  isToday: boolean;
}

/**
 * The LOCAL calendar date a block falls on.
 *
 * Not `iso.slice(0, 10)`, which is the UTC date. Blocks are positioned by local
 * hours (`getHours`), so bucketing them by UTC date puts a 9:30am Wednesday
 * meeting in Tuesday's column for anyone east of Greenwich — the event renders
 * in the right place on the wrong day, which looks like a data problem rather
 * than a rendering one.
 */
export function localDateOf(iso: string): string {
  const d = new Date(iso);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/** Seven days from `startDate`, each with its blocks. */
export function weekView(
  blocks: readonly PlannerBlockView[],
  startDate: string,
  today: string,
): CalendarDay[] {
  const days: CalendarDay[] = [];
  const start = new Date(`${startDate}T00:00:00.000Z`);
  for (let i = 0; i < 7; i += 1) {
    const date = new Date(start.getTime() + i * 86_400_000).toISOString().slice(0, 10);
    const forDay = blocks.filter((b) => b.scheduledFor && localDateOf(b.scheduledFor) === date);
    days.push({
      date,
      blocks: forDay.sort((a, b) => (a.scheduledFor ?? '').localeCompare(b.scheduledFor ?? '')),
      plannedMinutes: forDay.reduce((sum, b) => sum + b.estimateMinutes, 0),
      isToday: date === today,
    });
  }
  return days;
}

/** Monday of the week containing `date`, so the calendar starts consistently. */
export function weekStart(date: string): string {
  const d = new Date(`${date}T00:00:00.000Z`);
  const day = d.getUTCDay();
  const offset = day === 0 ? -6 : 1 - day;
  return new Date(d.getTime() + offset * 86_400_000).toISOString().slice(0, 10);
}

/**
 * Unscheduled blocks — a today list is a legitimate plan (D5).
 *
 * Shown beside the calendar rather than hidden by it. Forcing everything onto a
 * clock is how planners get abandoned by the people who most need one.
 */
export function unscheduledBlocks(blocks: readonly PlannerBlockView[]): PlannerBlockView[] {
  return blocks.filter((b) => !b.scheduledFor && !b.completedAt);
}

/* ---------------------------------------------------------------- the notes */

/**
 * Notes are items with a body and no due date.
 *
 * Not a separate record type: an idea often becomes a task, and making that a
 * conversion between two stores would mean either losing the note or keeping
 * two copies. Adding a due date to a note IS promoting it.
 */
export function isNote(item: PlannerItemView): boolean {
  return !item.dueDate && !!item.notes && item.notes.trim().length > 0;
}

export function noteList(items: readonly PlannerItemView[]): PlannerItemView[] {
  return items.filter(isNote);
}

/* ------------------------------------------------------------- the messages */

/**
 * The empty state for a view.
 *
 * Says what the view is FOR, not merely that it is empty. "No items" tells you
 * nothing you did not already know from looking at it.
 */
export function emptyMessage(view: PlannerView): { title: string; note: string } {
  switch (view) {
    case 'today':
      return {
        title: 'Nothing planned for today',
        note: 'Add something you intend to do, or pull an issue in from a connected source.',
      };
    case 'calendar':
      return {
        title: 'No time blocked this week',
        note: 'Blocks record what you planned against what it actually took — the gap is the useful part.',
      };
    case 'notes':
      return {
        title: 'No notes yet',
        note: 'Things that are not tasks. Give one a due date and it becomes one.',
      };
  }
}

/**
 * The banner when items need a human decision.
 *
 * Conflicts are the only planner state that cannot resolve itself, so they are
 * the only one that gets a banner. Everything else — pending sync, stale
 * sources — is a line of text that resolves on its own.
 */
export function conflictBanner(items: readonly PlannerItemView[]): string | null {
  const conflicted = items.filter((i) => i.conflictFields.length > 0);
  if (conflicted.length === 0) return null;
  const n = conflicted.length;
  return `${n} item${n === 1 ? '' : 's'} changed in two places. Both versions were kept — pick which to keep.`;
}

/* ------------------------------------------------ the time grid (calendar) */

/**
 * A block positioned on a day column.
 *
 * Percentages rather than pixels so the grid scales with the panel — a
 * calendar that only looks right at one width is a calendar people stop
 * resizing.
 */
export interface PositionedBlock {
  block: PlannerBlockView;
  /** Distance from the top of the day column, 0–100. */
  topPct: number;
  /** Height as a share of the day, 0–100. */
  heightPct: number;
  /** Which overlap lane this sits in, and how many lanes the cluster needs. */
  lane: number;
  lanes: number;
}

/** The hours a day column shows. Outside these, blocks clamp to the edge. */
export const DAY_START_HOUR = 7;
export const DAY_END_HOUR = 21;
const DAY_MINUTES = (DAY_END_HOUR - DAY_START_HOUR) * 60;

/** Shortest block that still shows its title. Below this, blocks are unreadable. */
const MIN_HEIGHT_PCT = 2.2;

function minutesFromDayStart(iso: string): number {
  const d = new Date(iso);
  return (d.getHours() - DAY_START_HOUR) * 60 + d.getMinutes();
}

/**
 * Lay out one day's blocks, side by side where they overlap.
 *
 * Overlapping events stacked on top of each other hide one entirely, which is
 * the single most common way a naive calendar loses information. Clustering
 * them into lanes is what Google Calendar does and it is not optional.
 */
export function layOutDay(blocks: readonly PlannerBlockView[]): PositionedBlock[] {
  const timed = blocks
    .filter((b) => b.scheduledFor)
    .map((b) => ({
      block: b,
      start: minutesFromDayStart(b.scheduledFor!),
      end: minutesFromDayStart(b.scheduledFor!) + Math.max(15, b.estimateMinutes),
    }))
    .sort((a, b) => a.start - b.start || b.end - a.end);

  // Cluster: any run of blocks that transitively overlap shares a lane count,
  // so two adjacent meetings do not each shrink to half the column width when
  // only one pair actually collides.
  const out: PositionedBlock[] = [];
  let cluster: typeof timed = [];
  let clusterEnd = -1;

  const flush = (): void => {
    if (cluster.length === 0) return;
    const laneEnds: number[] = [];
    const laneOf = new Map<typeof cluster[number], number>();
    for (const item of cluster) {
      let lane = laneEnds.findIndex((end) => end <= item.start);
      if (lane === -1) { lane = laneEnds.length; laneEnds.push(item.end); }
      else laneEnds[lane] = item.end;
      laneOf.set(item, lane);
    }
    for (const item of cluster) {
      const top = Math.max(0, Math.min(DAY_MINUTES, item.start));
      const height = Math.max(0, Math.min(DAY_MINUTES, item.end) - top);
      out.push({
        block: item.block,
        topPct: (top / DAY_MINUTES) * 100,
        heightPct: Math.max(MIN_HEIGHT_PCT, (height / DAY_MINUTES) * 100),
        lane: laneOf.get(item) ?? 0,
        lanes: laneEnds.length,
      });
    }
    cluster = [];
    clusterEnd = -1;
  };

  for (const item of timed) {
    if (cluster.length > 0 && item.start >= clusterEnd) flush();
    cluster.push(item);
    clusterEnd = Math.max(clusterEnd, item.end);
  }
  flush();
  return out;
}

/** Hour labels down the gutter. */
export function hourLabels(): Array<{ hour: number; label: string }> {
  const out: Array<{ hour: number; label: string }> = [];
  for (let h = DAY_START_HOUR; h <= DAY_END_HOUR; h += 1) {
    const suffix = h < 12 ? 'am' : 'pm';
    const display = h % 12 === 0 ? 12 : h % 12;
    out.push({ hour: h, label: `${display} ${suffix}` });
  }
  return out;
}

/**
 * Where "now" sits in the day column, or null when outside the visible hours.
 *
 * The line that tells you where you are. A calendar without it makes you read
 * the clock and do arithmetic — which is precisely the work it exists to save.
 */
export function nowMarkerPct(now: Date): number | null {
  const minutes = (now.getHours() - DAY_START_HOUR) * 60 + now.getMinutes();
  if (minutes < 0 || minutes > DAY_MINUTES) return null;
  return (minutes / DAY_MINUTES) * 100;
}

/** Shift a week start by whole weeks, for the prev/next controls. */
export function shiftWeek(startDate: string, weeks: number): string {
  const d = new Date(`${startDate}T00:00:00.000Z`);
  return new Date(d.getTime() + weeks * 7 * 86_400_000).toISOString().slice(0, 10);
}

/** `Mon 4` — short enough for a column head, unambiguous across months. */
export function dayHeading(date: string): { weekday: string; day: string } {
  const d = new Date(`${date}T00:00:00.000Z`);
  return {
    weekday: ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][d.getUTCDay()]!,
    day: String(d.getUTCDate()),
  };
}
