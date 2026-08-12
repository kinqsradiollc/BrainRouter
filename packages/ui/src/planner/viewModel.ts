/**
 * ADR-038 — pure Planner presentation decisions shared by Desktop and Web.
 * Dates are passed in and all grouping/layout rules are side-effect free so one
 * test suite pins what both hosts show.
 */
import type { PlannerBlockView, PlannerItemView, PlannerView, TodayGroup } from './types.js';

export const GROUP_LABEL: Record<TodayGroup, string> = {
  overdue: 'Now · carried over',
  due: 'Now · due today',
  scheduled: 'Now · scheduled',
  next: 'Next',
  anytime: 'Later · anytime',
};

const GROUP_ORDER: Record<TodayGroup, number> = {
  overdue: 0,
  due: 1,
  scheduled: 2,
  next: 3,
  anytime: 4,
};

function daysBetween(from: string, to: string): number {
  const start = new Date(`${from}T00:00:00.000Z`).getTime();
  const end = new Date(`${to}T00:00:00.000Z`).getTime();
  return Math.round((end - start) / 86_400_000);
}

/**
 * The items whose "Now · scheduled" claim is true.
 *
 * Membership used to be every item holding any open block, which put two kinds
 * of item in a group whose heading says NOW: ones whose block carries no time at
 * all — the same ones the calendar files under "No time" — and ones blocked out
 * on other days. The Today tab and the Calendar tab then disagreed about the
 * same block, and the heading was the one that was wrong.
 */
export function scheduledTodayIds(
  blocks: readonly PlannerBlockView[],
  today: string,
): Set<string> {
  const ids = new Set<string>();
  for (const block of blocks) {
    if (block.completedAt) continue;
    if (block.scheduledFor?.slice(0, 10) !== today) continue;
    ids.add(block.itemId);
  }
  return ids;
}

export function groupFor(item: PlannerItemView, today: string, scheduledIds: ReadonlySet<string>): TodayGroup {
  const due = item.dueDate?.slice(0, 10);
  if (due && due < today) return 'overdue';
  if (due === today) return 'due';
  if (scheduledIds.has(item.id)) return 'scheduled';
  if (due && daysBetween(today, due) <= 7) return 'next';
  return 'anytime';
}

export function sortForToday(
  items: readonly PlannerItemView[],
  today: string,
  scheduledIds: ReadonlySet<string>,
): PlannerItemView[] {
  return [...items].sort((a, b) => {
    const group = GROUP_ORDER[groupFor(a, today, scheduledIds)] - GROUP_ORDER[groupFor(b, today, scheduledIds)];
    if (group !== 0) return group;
    const priority = (a.priority ?? 99) - (b.priority ?? 99);
    if (priority !== 0) return priority;
    return a.title.localeCompare(b.title);
  });
}

// The merge rule itself, not a second copy of it. Core decides what survives a
// refresh; a surface that duplicated the list would eventually offer an edit the
// next sync undoes — which is the projection drift ADR-038's audit found.
import { PLANNER_OWNED_FIELDS } from '@kinqs/brainrouter-core/planner/presentation';

export function canEdit(item: PlannerItemView, field: string): boolean {
  if (field === 'title' && item.capabilities?.editTitle !== undefined) return item.capabilities.editTitle;
  if (field === 'completed' && item.capabilities?.complete !== undefined) return item.capabilities.complete;
  if (field === 'delete' && item.capabilities?.delete !== undefined) return item.capabilities.delete;
  return item.origin === 'owned' || PLANNER_OWNED_FIELDS.has(field);
}

export function whyReadOnly(item: PlannerItemView, field: string): string | null {
  if (canEdit(item, field)) return null;
  return `"${field}" belongs to ${item.source ?? 'the source'}. Editing it here would be undone by the next refresh.`;
}

export interface CalendarDay {
  date: string;
  blocks: PlannerBlockView[];
  plannedMinutes: number;
  isToday: boolean;
}

export function localDateOf(iso: string): string {
  const date = new Date(iso);
  return [date.getFullYear(), String(date.getMonth() + 1).padStart(2, '0'), String(date.getDate()).padStart(2, '0')]
    .join('-');
}

/** Keyboard parity for calendar drag: Alt+arrows move by an hour or a day. */
export function keyboardBlockTime(scheduledFor: string, key: string): string | null {
  const date = new Date(scheduledFor);
  if (!Number.isFinite(date.getTime())) return null;
  if (key === 'ArrowUp') date.setHours(date.getHours() - 1);
  else if (key === 'ArrowDown') date.setHours(date.getHours() + 1);
  else if (key === 'ArrowLeft') date.setDate(date.getDate() - 1);
  else if (key === 'ArrowRight') date.setDate(date.getDate() + 1);
  else return null;
  return date.toISOString();
}

export function weekView(blocks: readonly PlannerBlockView[], startDate: string, today: string): CalendarDay[] {
  const start = new Date(`${startDate}T00:00:00.000Z`);
  return Array.from({ length: 7 }, (_, index) => {
    const date = new Date(start.getTime() + index * 86_400_000).toISOString().slice(0, 10);
    const dayBlocks = blocks
      .filter((block) => block.scheduledFor && localDateOf(block.scheduledFor) === date)
      .sort((a, b) => (a.scheduledFor ?? '').localeCompare(b.scheduledFor ?? ''));
    return {
      date,
      blocks: dayBlocks,
      plannedMinutes: dayBlocks.reduce((sum, block) => sum + block.estimateMinutes, 0),
      isToday: date === today,
    };
  });
}

export function weekStart(date: string): string {
  const value = new Date(`${date}T00:00:00.000Z`);
  const day = value.getUTCDay();
  const offset = day === 0 ? -6 : 1 - day;
  return new Date(value.getTime() + offset * 86_400_000).toISOString().slice(0, 10);
}

export function shiftWeek(startDate: string, weeks: number): string {
  const value = new Date(`${startDate}T00:00:00.000Z`);
  return new Date(value.getTime() + weeks * 7 * 86_400_000).toISOString().slice(0, 10);
}

export function unscheduledBlocks(blocks: readonly PlannerBlockView[]): PlannerBlockView[] {
  return blocks.filter((block) => !block.scheduledFor && !block.completedAt);
}

export function isNote(item: PlannerItemView): boolean {
  return !item.dueDate && !!item.notes?.trim();
}

export function noteList(items: readonly PlannerItemView[]): PlannerItemView[] {
  return items.filter(isNote);
}

export function emptyMessage(view: PlannerView): { title: string; note: string } {
  if (view === 'today') {
    return {
      title: 'Nothing planned for today',
      note: 'Capture an intention here, or connect an issue source and choose what belongs in your day.',
    };
  }
  if (view === 'calendar') {
    return {
      title: 'No time blocked this week',
      note: 'Choose an hour to make room for work; estimates become useful once the actual time is recorded.',
    };
  }
  return {
    title: 'No notes yet',
    note: 'Keep context beside the work, then open it as a page when it needs structure and links.',
  };
}

export function conflictBanner(items: readonly PlannerItemView[]): string | null {
  const count = items.filter((item) => item.conflictFields.length > 0).length;
  if (count === 0) return null;
  return `${count} item${count === 1 ? '' : 's'} changed in two places. Both versions were kept — pick which to keep.`;
}

export interface PositionedBlock {
  block: PlannerBlockView;
  topPct: number;
  heightPct: number;
  lane: number;
  lanes: number;
}

export const DAY_START_HOUR = 7;
export const DAY_END_HOUR = 21;
const DAY_MINUTES = (DAY_END_HOUR - DAY_START_HOUR) * 60;
const MIN_HEIGHT_PCT = 2.2;

function minutesFromDayStart(iso: string): number {
  const date = new Date(iso);
  return (date.getHours() - DAY_START_HOUR) * 60 + date.getMinutes();
}

export function layOutDay(blocks: readonly PlannerBlockView[]): PositionedBlock[] {
  const timed = blocks
    .filter((block) => block.scheduledFor)
    .map((block) => ({
      block,
      start: minutesFromDayStart(block.scheduledFor!),
      end: minutesFromDayStart(block.scheduledFor!) + Math.max(15, block.estimateMinutes),
    }))
    .sort((a, b) => a.start - b.start || b.end - a.end);
  const result: PositionedBlock[] = [];
  let cluster: typeof timed = [];
  let clusterEnd = -1;
  const flush = (): void => {
    if (cluster.length === 0) return;
    const laneEnds: number[] = [];
    const laneOf = new Map<(typeof cluster)[number], number>();
    for (const item of cluster) {
      let lane = laneEnds.findIndex((end) => end <= item.start);
      if (lane < 0) {
        lane = laneEnds.length;
        laneEnds.push(item.end);
      } else {
        laneEnds[lane] = item.end;
      }
      laneOf.set(item, lane);
    }
    for (const item of cluster) {
      const top = Math.max(0, Math.min(DAY_MINUTES, item.start));
      const height = Math.max(0, Math.min(DAY_MINUTES, item.end) - top);
      result.push({
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
  return result;
}

export function hourLabels(): Array<{ hour: number; label: string }> {
  return Array.from({ length: DAY_END_HOUR - DAY_START_HOUR + 1 }, (_, index) => {
    const hour = DAY_START_HOUR + index;
    const display = hour % 12 === 0 ? 12 : hour % 12;
    return { hour, label: `${display} ${hour < 12 ? 'am' : 'pm'}` };
  });
}

export function nowMarkerPct(now: Date): number | null {
  const minutes = (now.getHours() - DAY_START_HOUR) * 60 + now.getMinutes();
  return minutes < 0 || minutes > DAY_MINUTES ? null : (minutes / DAY_MINUTES) * 100;
}

export function dayHeading(date: string): { weekday: string; day: string } {
  const value = new Date(`${date}T00:00:00.000Z`);
  return {
    weekday: ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][value.getUTCDay()]!,
    day: String(value.getUTCDate()),
  };
}

export function estimateForItem(itemId: string, blocks: readonly PlannerBlockView[]): number | null {
  const minutes = blocks
    .filter((block) => block.itemId === itemId && !block.completedAt)
    .reduce((sum, block) => sum + block.estimateMinutes, 0);
  return minutes > 0 ? minutes : null;
}

export function visibleEstimate(item: PlannerItemView, blocks: readonly PlannerBlockView[]): number | null {
  return item.estimateMinutes && item.estimateMinutes > 0
    ? item.estimateMinutes
    : estimateForItem(item.id, blocks);
}

export function provenanceFor(item: PlannerItemView): {
  source: string;
  externalId?: string;
  url?: string;
  kind?: string;
  freshness?: PlannerItemView['sourceFreshness'];
} | null {
  if (item.provenance) {
    return {
      source: item.provenance.source,
      ...(item.provenance.externalId ? { externalId: item.provenance.externalId } : {}),
      ...(item.provenance.url ? { url: item.provenance.url } : {}),
      ...(item.provenance.kind ? { kind: item.provenance.kind } : {}),
      ...(item.sourceFreshness ? { freshness: item.sourceFreshness } : {}),
    };
  }
  if (!item.source) return null;
  return {
    source: item.source,
    ...(item.externalId ? { externalId: item.externalId } : {}),
    ...(item.sourceUrl ? { url: item.sourceUrl } : {}),
    ...(item.sourceKind ? { kind: item.sourceKind } : {}),
    ...(item.sourceFreshness ? { freshness: item.sourceFreshness } : {}),
  };
}

export function carriedForItem(itemId: string, blocks: readonly PlannerBlockView[]): number {
  return Math.max(0, ...blocks.filter((block) => block.itemId === itemId).map((block) => block.carriedOver));
}

export function formatMinutes(minutes: number): string {
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const remainder = minutes % 60;
  return remainder ? `${hours}h ${remainder}m` : `${hours}h`;
}
