/**
 * ADR-028 D1 + D4 — what can conflict, and how it resolves.
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
 * **D4, resolution.** Field-level last-writer-wins by HLC, so two devices
 * setting `dueDate` and `priority` both win — except in the three places where
 * LWW destroys something a person cannot get back.
 *
 * Not CRDTs, consistent with ADR-027, and for a narrower reason than usual: a
 * CRDT text merge produces a document neither person wrote, which is worse than
 * a conflict marker because it looks like agreement.
 */
import { compareHlc, hlcAfter, type Hlc } from './hybridClock.js';

export type ItemOrigin = 'owned' | 'mirrored';

/** A value plus the stamp of the edit that set it. */
export interface Stamped<T> {
  value: T;
  at: Hlc;
}

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

export interface ConflictRecord {
  /** Both versions, kept. The human picks; nothing is discarded to decide. */
  ours: unknown;
  theirs: unknown;
  oursAt: Hlc;
  theirsAt: Hlc;
  reason: 'concurrent_text' | 'delete_vs_edit';
}

/** Fields where a lost value is a lost sentence, not a lost checkbox. */
const FREE_TEXT_FIELDS = new Set(['title', 'notes']);

/**
 * Merge one field by last-writer-wins.
 *
 * Independent per field: two devices editing different fields of the same item
 * is not a conflict at all, and treating it as one is how naive whole-record
 * LWW loses an edit that nothing was competing with.
 */
export function mergeField<T>(ours: Stamped<T> | undefined, theirs: Stamped<T> | undefined): Stamped<T> | undefined {
  if (!ours) return theirs;
  if (!theirs) return ours;
  return hlcAfter(theirs.at, ours.at) ? theirs : ours;
}

/**
 * Merge completion, where the tie is broken deliberately.
 *
 * Complete wins at equal clocks. The asymmetry is intentional: un-completing
 * something you finished is more annoying than re-completing something that
 * bounced back, because the first makes you doubt the record and the second is
 * one click.
 */
export function mergeCompletion(
  ours: Stamped<boolean> | undefined,
  theirs: Stamped<boolean> | undefined,
): Stamped<boolean> | undefined {
  if (!ours) return theirs;
  if (!theirs) return ours;
  // "Equal clocks" means equal physical AND logical — the deviceId tie-break
  // must NOT be consulted first, or it decides every tie and the asymmetry
  // below never applies to anything.
  const sameClock =
    ours.at.physical === theirs.at.physical && ours.at.logical === theirs.at.logical;
  if (!sameClock) return compareHlc(theirs.at, ours.at) > 0 ? theirs : ours;
  return ours.value ? ours : theirs;
}

/**
 * Merge free text.
 *
 * Concurrent edits are marked conflicted and BOTH are kept. A planner is not
 * important enough to lose a paragraph over, and exactly important enough that
 * quietly losing one destroys trust in the whole surface — after which people
 * keep a second copy somewhere else, which defeats the point of the planner.
 */
export function mergeText(
  field: string,
  ours: Stamped<string> | undefined,
  theirs: Stamped<string> | undefined,
): { value: Stamped<string> | undefined; conflict?: ConflictRecord } {
  if (!ours) return { value: theirs };
  if (!theirs) return { value: ours };
  if (ours.value === theirs.value) {
    return { value: hlcAfter(theirs.at, ours.at) ? theirs : ours };
  }
  const order = compareHlc(theirs.at, ours.at);
  if (order === 0) {
    return { value: ours };
  }
  // Concurrent = neither stamp saw the other. With an HLC that shows up as
  // equal physical+logical from different devices; a strictly later stamp did
  // see it and legitimately supersedes.
  if (ours.at.physical === theirs.at.physical && ours.at.logical === theirs.at.logical) {
    return {
      value: order > 0 ? theirs : ours,
      conflict: {
        ours: ours.value, theirs: theirs.value,
        oursAt: ours.at, theirsAt: theirs.at,
        reason: 'concurrent_text',
      },
    };
  }
  void field;
  return { value: order > 0 ? theirs : ours };
}

/**
 * Merge two versions of an owned item.
 *
 * Mirrored items never reach here — see `refreshMirrored`.
 */
export function mergeOwnedItem(ours: PlannerItem, theirs: PlannerItem): PlannerItem {
  const conflicts: Record<string, ConflictRecord> = { ...(ours.conflicts ?? {}), ...(theirs.conflicts ?? {}) };

  const title = mergeText('title', ours.title, theirs.title);
  if (title.conflict) conflicts.title = title.conflict;
  const notes = mergeText('notes', ours.notes, theirs.notes);
  if (notes.conflict) conflicts.notes = notes.conflict;

  // Delete versus edit. A tombstone does not simply win: an edit stamped after
  // it means someone was working on this after someone else removed it, and
  // both silently undeleting and silently discarding the edit are wrong.
  const tombstone = ours.deletedAt && theirs.deletedAt
    ? (hlcAfter(theirs.deletedAt, ours.deletedAt) ? theirs.deletedAt : ours.deletedAt)
    : (ours.deletedAt ?? theirs.deletedAt);

  const latestEdit = latestEditStamp({ ...ours, title: title.value!, notes: notes.value });
  const latestTheirEdit = latestEditStamp(theirs);
  const newestEdit = latestEdit && latestTheirEdit
    ? (hlcAfter(latestTheirEdit, latestEdit) ? latestTheirEdit : latestEdit)
    : (latestEdit ?? latestTheirEdit);

  let deletedAt = tombstone;
  if (tombstone && newestEdit && hlcAfter(newestEdit, tombstone)) {
    // Resurrect as conflicted rather than choosing for them.
    deletedAt = undefined;
    conflicts.deleted = {
      ours: 'deleted', theirs: 'edited',
      oursAt: tombstone, theirsAt: newestEdit,
      reason: 'delete_vs_edit',
    };
  }

  return {
    id: ours.id,
    origin: 'owned',
    title: title.value!,
    ...(notes.value ? { notes: notes.value } : {}),
    ...(mergeField(ours.dueDate, theirs.dueDate) ? { dueDate: mergeField(ours.dueDate, theirs.dueDate)! } : {}),
    ...(mergeField(ours.priority, theirs.priority) ? { priority: mergeField(ours.priority, theirs.priority)! } : {}),
    ...(mergeCompletion(ours.completed, theirs.completed) ? { completed: mergeCompletion(ours.completed, theirs.completed)! } : {}),
    ...(deletedAt ? { deletedAt } : {}),
    ...(Object.keys(conflicts).length ? { conflicts } : {}),
  };
}

function latestEditStamp(item: PlannerItem): Hlc | undefined {
  const stamps = [item.title?.at, item.notes?.at, item.dueDate?.at, item.priority?.at, item.completed?.at]
    .filter((s): s is Hlc => !!s);
  if (stamps.length === 0) return undefined;
  return stamps.reduce((a, b) => (hlcAfter(b, a) ? b : a));
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
