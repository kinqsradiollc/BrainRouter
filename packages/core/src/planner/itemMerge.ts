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
import type { PlannerProvenance } from '@kinqs/brainrouter-types/planner';
import {
  latestStamp, mergeCompletion, mergeField, mergeText, resolveTombstone,
  causalValue, type ConflictRecord, type Stamped,
} from '../sync/stamped.js';

export {
  causalValue, mergeCompletion, mergeField, mergeText,
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
  /** Structured source identity for display and navigation. */
  provenance?: PlannerProvenance;

  title: Stamped<string>;
  notes?: Stamped<string>;
  dueDate?: Stamped<string | null>;
  priority?: Stamped<number>;
  completed?: Stamped<boolean>;
  /** Planner-owned estimate shown even when an item has no scheduled block. */
  estimateMinutes?: number;
  /** Stamp for the estimate's field-level merge. */
  estimateUpdatedAt?: Hlc;
  /** Source-owned reason the work cannot proceed, when known. */
  blockedReason?: Stamped<string | null>;
  /** Set when a delete was recorded. Deletion is a tombstone, not an absence. */
  deletedAt?: Hlc;
  /** Fields whose merge could not be decided without losing work. */
  conflicts?: Record<string, ConflictRecord>;
  /**
   * Durable per-field acknowledgement that a human chose a conflict value.
   * A later pull may still carry the old marker until this device pushes; the
   * watermark prevents that marker from being resurrected in the meantime.
   */
  conflictResolutions?: Partial<Record<'title' | 'notes', Hlc>>;
  /** Durable decision for a delete-versus-edit conflict. */
  deletionResolution?: { deleted: boolean; at: Hlc };
}

/**
 * Merge two versions of an owned item.
 *
 * Mirrored items never reach here — see `refreshMirrored`.
 */
export function mergeOwnedItem(ours: PlannerItem, theirs: PlannerItem): PlannerItem {
  const conflicts: Record<string, ConflictRecord> = { ...(ours.conflicts ?? {}), ...(theirs.conflicts ?? {}) };
  delete conflicts.deleted;

  const titleResolution = latestHlc(
    ours.conflictResolutions?.title,
    theirs.conflictResolutions?.title,
  );
  const notesResolution = latestHlc(
    ours.conflictResolutions?.notes,
    theirs.conflictResolutions?.notes,
  );

  const title = mergeResolutionAwareText(
    ours.title,
    theirs.title,
    ours.conflictResolutions?.title,
    theirs.conflictResolutions?.title,
  );
  if (title.conflict) conflicts.title = title.conflict;
  const notes = mergeResolutionAwareText(
    ours.notes,
    theirs.notes,
    ours.conflictResolutions?.notes,
    theirs.conflictResolutions?.notes,
  );
  if (notes.conflict) conflicts.notes = notes.conflict;
  clearResolvedConflict(conflicts, 'title', titleResolution);
  clearResolvedConflict(conflicts, 'notes', notesResolution);
  const dueDate = mergeField(ours.dueDate, theirs.dueDate);
  const priority = mergeField(ours.priority, theirs.priority);
  const completed = mergeCompletion(ours.completed, theirs.completed);
  const estimate = mergeEstimate(ours, theirs);
  const blockedReason = mergeField(ours.blockedReason, theirs.blockedReason);

  const latestEdit = latestEditStamp({ ...ours, title: title.value!, notes: notes.value });
  const latestTheirEdit = latestEditStamp(theirs);
  const newestEdit = latestEdit && latestTheirEdit
    ? (hlcAfter(latestTheirEdit, latestEdit) ? latestTheirEdit : latestEdit)
    : (latestEdit ?? latestTheirEdit);

  const deletionResolution = latestDeletionResolution(
    ours.deletionResolution,
    theirs.deletionResolution,
  );
  const tombstone = resolveTombstone(ours.deletedAt, theirs.deletedAt, newestEdit);
  let deletedAt = tombstone.deletedAt;
  if (tombstone.conflict) conflicts.deleted = tombstone.conflict;
  const resolutionAfterTombstone = !deletedAt
    || compareOrEqualHlc(deletionResolution?.at, deletedAt);
  const resolutionAfterConflict = !tombstone.conflict
    || (!!deletionResolution
      && hlcAfter(deletionResolution.at, tombstone.conflict.oursAt)
      && hlcAfter(deletionResolution.at, tombstone.conflict.theirsAt));
  if (deletionResolution && resolutionAfterTombstone && resolutionAfterConflict) {
    deletedAt = deletionResolution.deleted ? deletionResolution.at : undefined;
    delete conflicts.deleted;
  }

  return {
    id: ours.id,
    origin: 'owned',
    title: title.value!,
    ...(notes.value !== undefined ? { notes: notes.value } : {}),
    ...(dueDate ? { dueDate } : {}),
    ...(priority ? { priority } : {}),
    ...(completed ? { completed } : {}),
    ...(estimate.value !== undefined ? { estimateMinutes: estimate.value } : {}),
    ...(estimate.at ? { estimateUpdatedAt: estimate.at } : {}),
    ...(blockedReason ? { blockedReason } : {}),
    ...(deletedAt ? { deletedAt } : {}),
    ...(titleResolution || notesResolution
      ? { conflictResolutions: {
          ...(titleResolution ? { title: titleResolution } : {}),
          ...(notesResolution ? { notes: notesResolution } : {}),
        } }
      : {}),
    ...(deletionResolution ? { deletionResolution } : {}),
    ...(Object.keys(conflicts).length ? { conflicts } : {}),
  };
}

function compareOrEqualHlc(candidate: Hlc | undefined, reference: Hlc): boolean {
  return !!candidate && (sameHlc(candidate, reference) || hlcAfter(candidate, reference));
}

function latestDeletionResolution(
  ours: PlannerItem['deletionResolution'],
  theirs: PlannerItem['deletionResolution'],
): PlannerItem['deletionResolution'] {
  if (!ours) return theirs;
  if (!theirs) return ours;
  return hlcAfter(theirs.at, ours.at) ? theirs : ours;
}

function latestHlc(ours: Hlc | undefined, theirs: Hlc | undefined): Hlc | undefined {
  if (!ours) return theirs;
  if (!theirs) return ours;
  return hlcAfter(theirs, ours) ? theirs : ours;
}

function sameHlc(a: Hlc | undefined, b: Hlc | undefined): boolean {
  return !!a && !!b
    && a.physical === b.physical
    && a.logical === b.logical
    && a.deviceId === b.deviceId;
}

/** Two people may resolve the same conflict offline; the total HLC picks one. */
function mergeResolutionAwareText(
  ours: Stamped<string> | undefined,
  theirs: Stamped<string> | undefined,
  oursResolution: Hlc | undefined,
  theirsResolution: Hlc | undefined,
): ReturnType<typeof mergeText> {
  if (ours && theirs
    && sameHlc(ours.at, oursResolution)
    && sameHlc(theirs.at, theirsResolution)) {
    return { value: hlcAfter(theirsResolution!, oursResolution!) ? theirs : ours };
  }
  return mergeText(ours, theirs);
}

function clearResolvedConflict(
  conflicts: Record<string, ConflictRecord>,
  field: 'title' | 'notes',
  resolution: Hlc | undefined,
): void {
  const conflict = conflicts[field];
  if (!resolution || !conflict) return;
  if (hlcAfter(resolution, conflict.oursAt) && hlcAfter(resolution, conflict.theirsAt)) {
    delete conflicts[field];
  }
}

function latestEditStamp(item: PlannerItem): Hlc | undefined {
  return latestStamp([
    item.title?.at,
    item.notes?.at,
    item.dueDate?.at,
    item.priority?.at,
    item.completed?.at,
    item.estimateUpdatedAt,
    item.blockedReason?.at,
  ]);
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
  remote: Pick<
    PlannerItem,
    'title' | 'notes' | 'dueDate' | 'completed' | 'source' | 'provenance' | 'blockedReason'
  >,
  fetchedAt: string,
): PlannerItem {
  return {
    id: local.id,
    origin: 'mirrored',
    ...(remote.source ? { source: remote.source } : local.source ? { source: local.source } : {}),
    fetchedAt,
    ...(remote.provenance
      ? { provenance: { ...remote.provenance, fetchedAt } }
      : local.provenance ? { provenance: { ...local.provenance, fetchedAt } } : {}),
    title: remote.title,
    ...(remote.notes ? { notes: remote.notes } : {}),
    ...(remote.dueDate ? { dueDate: remote.dueDate } : {}),
    ...(remote.completed ? { completed: remote.completed } : {}),
    ...(remote.blockedReason ? { blockedReason: remote.blockedReason } : {}),
    // Planner-owned metadata survives the re-read.
    ...(local.priority ? { priority: local.priority } : {}),
    ...(local.estimateMinutes !== undefined ? { estimateMinutes: local.estimateMinutes } : {}),
    ...(local.estimateUpdatedAt ? { estimateUpdatedAt: local.estimateUpdatedAt } : {}),
  };
}

function mergeEstimate(
  ours: PlannerItem,
  theirs: PlannerItem,
): { value?: number; at?: Hlc } {
  if (ours.estimateMinutes === undefined) {
    return { value: theirs.estimateMinutes, at: theirs.estimateUpdatedAt };
  }
  if (theirs.estimateMinutes === undefined) {
    return { value: ours.estimateMinutes, at: ours.estimateUpdatedAt };
  }
  if (!ours.estimateUpdatedAt) {
    return { value: theirs.estimateMinutes, at: theirs.estimateUpdatedAt };
  }
  if (!theirs.estimateUpdatedAt || !hlcAfter(theirs.estimateUpdatedAt, ours.estimateUpdatedAt)) {
    return { value: ours.estimateMinutes, at: ours.estimateUpdatedAt };
  }
  return { value: theirs.estimateMinutes, at: theirs.estimateUpdatedAt };
}

/**
 * May this edit be applied locally?
 *
 * Local edits to a mirrored item are limited to planner metadata — schedule it,
 * order it, snooze it. Changing an issue's title is an action against GitHub,
 * queued as an outbound operation and failing visibly, not a local write that
 * the next refresh silently reverts.
 */
const PLANNER_OWNED_FIELDS = new Set([
  'priority', 'estimateMinutes', 'scheduledFor', 'snoozedUntil', 'order',
]);

export function canEditLocally(
  item: Pick<PlannerItem, 'origin' | 'source'>,
  field: string,
): { allowed: boolean; reason?: string } {
  if (item.origin === 'owned') return { allowed: true };
  if (PLANNER_OWNED_FIELDS.has(field)) return { allowed: true };
  if (field === 'delete') {
    return {
      allowed: false,
      reason:
        `This item belongs to ${item.source ?? 'the source system'}, so deleting it from the planner ` +
        'would only hide a cache entry that the next refresh must restore. Delete or close it in its source.',
    };
  }
  return {
    allowed: false,
    reason:
      `"${field}" belongs to ${item.source ?? 'the source system'}, not the planner. Changing it here ` +
      'would be reverted by the next refresh — it has to be sent to the source as an action, where ' +
      'it can fail where you can see it.',
  };
}
