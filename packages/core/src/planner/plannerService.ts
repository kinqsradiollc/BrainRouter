/**
 * ADR-028 Part D — the planner service.
 *
 * One place the desktop panel, the CLI commands and the agent tools all call,
 * so the three surfaces cannot drift into disagreeing about what "today" means
 * or which items are overdue. The alternative — each surface assembling its own
 * view from the store — is how the CLI ends up showing a different plan from
 * the panel, and then neither is trusted.
 *
 * Everything here is a projection over `plannerStore` plus the D5–D7 helpers.
 * Takes a `userId`, never a workspace root — the planner is user-scoped and
 * cross-workspace (D9), so a workspace parameter appearing here would mean the
 * scoping had regressed.
 */
import {
  listItems, listBlocks, listConflicts, readPlanner,
} from './plannerStore.js';
import { dayView, summarizeDrift, needsAttention, commitmentFor, type TimeBlock, type DriftSummary } from './timetable.js';
import { describeSyncState } from '../sync/outbox.js';
import { isStale, describeFreshness, type SourceFreshness } from './sourceAdapter.js';
import type { PlannerItem } from './itemMerge.js';

export interface TodayView {
  /** Items due today, overdue, or scheduled today. */
  items: PlannerItem[];
  /** Blocks for the day, split by whether they have a clock time. */
  scheduled: TimeBlock[];
  unscheduled: TimeBlock[];
  /** Blocks carried forward too often to keep quietly re-scheduling. */
  stalled: TimeBlock[];
  /** Planned minutes against the day, when the caller supplies a budget. */
  commitment: { committedMinutes: number; overBy: number; note: string | null };
  drift: DriftSummary;
  /** Items whose merge could not be decided — shown, never silently dropped. */
  conflicts: PlannerItem[];
  /** One line about pending sync. Never phrased as an error (D2). */
  syncState: string;
  /** Sources whose data is old enough that presenting it as current would lie. */
  staleSources: string[];
}

export interface TodayOptions {
  /** ISO date, `YYYY-MM-DD`. */
  date: string;
  nowMs: number;
  /** Minutes genuinely available. Defaults to a working day. */
  availableMinutes?: number;
  freshness?: readonly SourceFreshness[];
}

/**
 * Everything a "today" surface needs, assembled once.
 *
 * Overdue items are folded into today rather than given their own count. A
 * separate overdue tally is the red badge D5 rejects: it makes the surface feel
 * like an accusation, and the response is to stop opening it.
 */
export function todayView(userId: string | undefined, opts: TodayOptions): TodayView {
  const allItems = listItems(userId);
  const blocks = listBlocks(userId);
  const day = dayView(blocks, opts.date);
  const scheduledItemIds = new Set([...day.scheduled, ...day.unscheduled].map((b) => b.itemId));

  const items = allItems.filter((item) => {
    if (scheduledItemIds.has(item.id)) return true;
    const due = item.dueDate?.value;
    // Due today OR before it — an overdue item belongs in today, not in a
    // separate pile that only grows.
    return typeof due === 'string' && due.slice(0, 10) <= opts.date;
  });

  return {
    items,
    scheduled: day.scheduled,
    unscheduled: day.unscheduled,
    stalled: needsAttention(blocks),
    commitment: commitmentFor([...day.scheduled, ...day.unscheduled], opts.availableMinutes ?? 480),
    drift: summarizeDrift(blocks),
    conflicts: listConflicts(userId),
    syncState: describeSyncState(readPlanner(userId).outbox),
    staleSources: (opts.freshness ?? [])
      .filter((f) => isStale(f, opts.nowMs))
      .map((f) => describeFreshness(f, opts.nowMs)),
  };
}

/**
 * Search across titles and notes.
 *
 * Deliberately dumb — substring, case-insensitive. A planner search that ranks
 * cleverly hides the item you know exists, and the list is small enough that
 * finding it by eye works.
 */
export function findItems(userId: string | undefined, query: string): PlannerItem[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return [];
  return listItems(userId, { includeCompleted: true }).filter((i) =>
    i.title.value.toLowerCase().includes(needle) ||
    (i.notes?.value ?? '').toLowerCase().includes(needle),
  );
}

/**
 * The timetable for a day, oldest first.
 *
 * Separate from `todayView` because a timetable is a different question: what
 * does the shape of this day look like, rather than what should I be doing.
 */
export function timetableView(
  userId: string | undefined,
  date: string,
): { blocks: TimeBlock[]; titles: Record<string, string> } {
  const blocks = listBlocks(userId);
  const day = dayView(blocks, date);
  const items = listItems(userId, { includeCompleted: true });
  const titles: Record<string, string> = {};
  for (const item of items) titles[item.id] = item.title.value;
  return { blocks: [...day.scheduled, ...day.unscheduled], titles };
}
