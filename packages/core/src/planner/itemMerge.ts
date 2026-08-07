/**
 * ADR-028 D1 — what can conflict at all, and the planner's own field list.
 *
 * **D1, the split everything rests on.** A *mirrored* item projects something
 * whose truth lives elsewhere — a GitHub issue, a Track item, a review finding.
 * We never merge those; we re-read them. If an issue changed while you were
 * offline there is no conflict, because the issue is whatever GitHub says it
 * is. Local state is a cache with a fetch time.
 *
 * *Owned* items are created in the planner: a todo, a time block, a note.
 * Those are the only things that can genuinely conflict.
 *
 * So a planner aggregating ten sources has a conflict surface of ONE. Most of
 * the apparent difficulty of "sync everything across devices" dissolves the
 * moment mirrored data stops pretending to be editable local state.
 *
 * **D4's resolution rules live in `sync/stamped.ts`**, shared with Notes per
 * ADR-029 B3. They were always generic — field-level last-writer-wins over a
 * value and its stamp knows nothing about todos — and a second copy of them
 * would eventually disagree with this one about a tie. What stays here is the
 * part that is genuinely the planner’s: which fields it has, and which of them
 * are free text.
 *
 * The names D4 introduced are re-exported so `@kinqs/brainrouter-core/planner`
 * still answers for them; the backend imports the merge from that path and must
 * keep calling the same functions this client does.
 */
import { hlcAfter, type Hlc } from '../sync/hybridClock.js';
import {
  latestStamp, mergeCompletion, mergeField, mergeText, resolveTombstone,
  type ConflictRecord, type Stamped,
} from '../sync/stamped.js';

export {
  mergeCompletion, mergeField, mergeText,
  type ConflictRecord, type Stamped,
} from '../sync/stamped.js';

export type ItemOrigin = 'owned' | 'mirrored';

export interface PlannerItem {
  id: string;
  origin: ItemOrigin;
  /** For mirrored items: which adapter owns the truth. */
  source?: string;
  /** For mirrored items: when we last re-read it. */
  fetchedAt?: string;

  title: Stamped<string>;
  notes?: Stamped<string>;
  dueDate?: Stamped<string | null>;
  priority?: Stamped<number>;
  completed?: Stamped<boolean>;
  /** Set when a delete was recorded. Deletion is a tombstone, not an absence. */
  deletedAt?: Hlc;
  /** Fields whose merge could not be decided without losing work. */
  conflicts?: Record<string, ConflictRecord>;
}

/**
 * Merge two versions of an owned item.
 *
 * Mirrored items never reach here — see `refreshMirrored`.
 */
export function mergeOwnedItem(ours: PlannerItem, theirs: PlannerItem): PlannerItem {
  const conflicts: Record<string, ConflictRecord> = { ...(ours.conflicts ?? {}), ...(theirs.conflicts ?? {}) };

  const title = mergeText(ours.title, theirs.title);
  if (title.conflict) conflicts.title = title.conflict;
  const notes = mergeText(ours.notes, theirs.notes);
  if (notes.conflict) conflicts.notes = notes.conflict;

  const latestEdit = latestEditStamp({ ...ours, title: title.value!, notes: notes.value });
  const latestTheirEdit = latestEditStamp(theirs);
  const newestEdit = latestEdit && latestTheirEdit
    ? (hlcAfter(latestTheirEdit, latestEdit) ? latestTheirEdit : latestEdit)
    : (latestEdit ?? latestTheirEdit);

  const tombstone = resolveTombstone(ours.deletedAt, theirs.deletedAt, newestEdit);
  if (tombstone.conflict) conflicts.deleted = tombstone.conflict;

  return {
    id: ours.id,
    origin: 'owned',
    title: title.value!,
    ...(notes.value ? { notes: notes.value } : {}),
    ...(mergeField(ours.dueDate, theirs.dueDate) ? { dueDate: mergeField(ours.dueDate, theirs.dueDate)! } : {}),
    ...(mergeField(ours.priority, theirs.priority) ? { priority: mergeField(ours.priority, theirs.priority)! } : {}),
    ...(mergeCompletion(ours.completed, theirs.completed) ? { completed: mergeCompletion(ours.completed, theirs.completed)! } : {}),
    ...(tombstone.deletedAt ? { deletedAt: tombstone.deletedAt } : {}),
    ...(Object.keys(conflicts).length ? { conflicts } : {}),
  };
}

function latestEditStamp(item: PlannerItem): Hlc | undefined {
  return latestStamp([item.title?.at, item.notes?.at, item.dueDate?.at, item.priority?.at, item.completed?.at]);
}

/**
 * Re-read a mirrored item.
 *
 * Not a merge. The remote is the truth, and the only thing carried across is
 * planner metadata — the scheduling, ordering and snoozing that the planner
 * itself owns and the source knows nothing about. Merging the remote's own
 * fields would mean asserting our cached copy might be more correct than the
 * system of record, which it never is.
 */
export function refreshMirrored(
  local: PlannerItem,
  remote: Pick<PlannerItem, 'title' | 'notes' | 'dueDate' | 'completed' | 'source'>,
  fetchedAt: string,
): PlannerItem {
  return {
    id: local.id,
    origin: 'mirrored',
    ...(remote.source ? { source: remote.source } : local.source ? { source: local.source } : {}),
    fetchedAt,
    title: remote.title,
    ...(remote.notes ? { notes: remote.notes } : {}),
    ...(remote.dueDate ? { dueDate: remote.dueDate } : {}),
    ...(remote.completed ? { completed: remote.completed } : {}),
    // Planner-owned metadata survives the re-read.
    ...(local.priority ? { priority: local.priority } : {}),
  };
}

/**
 * May this edit be applied locally?
 *
 * Local edits to a mirrored item are limited to planner metadata — schedule it,
 * order it, snooze it. Changing an issue's title is an action against GitHub,
 * queued as an outbound operation and failing visibly, not a local write that
 * the next refresh silently reverts.
 */
const PLANNER_OWNED_FIELDS = new Set(['priority', 'scheduledFor', 'snoozedUntil', 'order']);

export function canEditLocally(
  item: Pick<PlannerItem, 'origin' | 'source'>,
  field: string,
): { allowed: boolean; reason?: string } {
  if (item.origin === 'owned') return { allowed: true };
  if (PLANNER_OWNED_FIELDS.has(field)) return { allowed: true };
  return {
    allowed: false,
    reason:
      `"${field}" belongs to ${item.source ?? 'the source system'}, not the planner. Changing it here ` +
      'would be reverted by the next refresh — it has to be sent to the source as an action, where ' +
      'it can fail where you can see it.',
  };
}
