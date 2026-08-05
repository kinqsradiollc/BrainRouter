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
    const forDay = blocks.filter((b) => b.scheduledFor?.slice(0, 10) === date);
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
