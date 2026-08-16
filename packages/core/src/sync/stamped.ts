/**
 * ADR-028 D4's merge rules, as the shared primitives ADR-029 B3 requires.
 *
 * These began inside `planner/itemMerge.ts` and were entirely generic there:
 * they operate on a value plus the stamp of the edit that set it, and know
 * nothing about todos. B3 says Notes reuses the planner's stack rather than
 * growing a second one, so the shared half moved here and the planner's own
 * field list stayed behind.
 *
 * Moving rather than copying is the whole point. Two implementations of
 * last-writer-wins will disagree about a tie eventually, and the disagreement
 * surfaces as one surface showing a value the other does not — indistinguishable
 * from a bug in whichever one you happen to be looking at.
 *
 * Not CRDTs, consistent with ADR-027, and for a narrower reason than usual: a
 * CRDT text merge produces a document neither person wrote, which is worse than
 * a conflict marker because it looks like agreement.
 */
import { compareHlc, hlcAfter, type Hlc } from './hybridClock.js';

/** A value plus the stamp of the edit that set it. */
export interface Stamped<T> {
  value: T;
  at: Hlc;
  /**
   * Per-replica causal frontier this edit had observed. Optional only for
   * backward compatibility with records written before causal metadata.
   */
  seen?: Hlc[];
}

const MAX_CAUSAL_REPLICAS = 64;

/** Compact a causal frontier to the newest event per replica. */
export function causalFrontier(stamps: ReadonlyArray<Hlc | undefined>): Hlc[] {
  const newest = new Map<string, Hlc>();
  for (const stamp of stamps) {
    if (!stamp) continue;
    const current = newest.get(stamp.deviceId);
    if (!current || compareHlc(stamp, current) > 0) newest.set(stamp.deviceId, stamp);
  }
  return [...newest.values()]
    .sort(compareHlc)
    .slice(-MAX_CAUSAL_REPLICAS);
}

/** Stamp an edit with the version(s) it was derived from. */
export function causalValue<T>(value: T, at: Hlc, ...previous: Array<Stamped<unknown> | undefined>): Stamped<T> {
  return {
    value,
    at,
    seen: causalFrontier(previous.flatMap((stamp) => stamp ? [stamp.at, ...(stamp.seen ?? [])] : [])),
  };
}

function observes(edit: Stamped<unknown>, event: Hlc): boolean {
  if (edit.at.deviceId === event.deviceId && compareHlc(edit.at, event) >= 0) return true;
  return (edit.seen ?? []).some((seen) =>
    seen.deviceId === event.deviceId && compareHlc(seen, event) >= 0);
}

/**
 * Why both versions were kept — the CAUSE, not the symptom.
 *
 * The first two are races nobody could have prevented: two edits that never saw
 * each other, or an edit and a delete. The `fenced_*` three are the opposite —
 * something DID hold the block and this write did not have it, so the write is
 * kept beside the text it did not see rather than on top of it (ADR-029 B2's
 * third departure: a refused write is not a dropped write).
 *
 * They are separate values rather than one `fenced` because the sentence a
 * person reads has to name which refusal: "your lock had been reissued" and
 * "another device is editing this" lead to different next actions. Collapsing
 * them is the same mistake migration 048's complete/fail paths make when they
 * return `null` for both "not running" and "wrong epoch".
 */
export type ConflictReason =
  /** Neither stamp saw the other. */
  | 'concurrent_text'
  /** Deleted on one device, edited on another. */
  | 'delete_vs_edit'
  /** The write named an epoch the lease had already moved past. */
  | 'fenced_stale_epoch'
  /** The lock this write was made under had run out before it landed. */
  | 'fenced_lease_expired'
  /** Another device held the block when this write arrived. */
  | 'fenced_blocked';

export interface ConflictRecord {
  /** Both versions, kept. The human picks; nothing is discarded to decide. */
  ours: unknown;
  theirs: unknown;
  oursAt: Hlc;
  theirsAt: Hlc;
  reason: ConflictReason;
}

/**
 * Merge one field by last-writer-wins.
 *
 * Independent per field: two devices editing different fields of the same
 * record is not a conflict at all, and treating it as one is how naive
 * whole-record LWW loses an edit that nothing was competing with.
 */
export function mergeField<T>(ours: Stamped<T> | undefined, theirs: Stamped<T> | undefined): Stamped<T> | undefined {
  if (!ours) return theirs;
  if (!theirs) return ours;
  return hlcAfter(theirs.at, ours.at) ? theirs : ours;
}

/**
 * Merge a boolean where the tie is broken deliberately toward `true`.
 *
 * The asymmetry is intentional: un-completing something you finished is more
 * annoying than re-completing something that bounced back, because the first
 * makes you doubt the record and the second is one click. Notes' checklist
 * items inherit the same reasoning, which is why this is shared rather than
 * re-derived per surface.
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
 * Concurrent edits are marked conflicted and BOTH are kept. ADR-029 B2 records
 * that this is worse for prose than for a todo title — a marker lands
 * mid-paragraph where someone is reading — and answers it by PREVENTING the
 * concurrent edit with a block lease rather than by weakening this rule. This
 * stays the floor for the case a lease cannot cover: both devices offline.
 */
export function mergeText(
  ours: Stamped<string> | undefined,
  theirs: Stamped<string> | undefined,
): { value: Stamped<string> | undefined; conflict?: ConflictRecord } {
  if (!ours) return { value: theirs };
  if (!theirs) return { value: ours };
  const causal = ours.seen !== undefined && theirs.seen !== undefined;
  if (ours.value === theirs.value) {
    const winner = hlcAfter(theirs.at, ours.at) ? theirs : ours;
    if (!causal) return { value: winner };
    return {
      value: {
        ...winner,
        seen: causalFrontier([
          ours.at, ...(ours.seen ?? []), theirs.at, ...(theirs.seen ?? []),
        ]),
      },
    };
  }
  const order = compareHlc(theirs.at, ours.at);
  if (order === 0) {
    return { value: ours };
  }
  if (causal) {
    const theirsSawOurs = observes(theirs, ours.at);
    const oursSawTheirs = observes(ours, theirs.at);
    if (theirsSawOurs && !oursSawTheirs) return { value: theirs };
    if (oursSawTheirs && !theirsSawOurs) return { value: ours };
    return {
      value: order > 0 ? theirs : ours,
      conflict: {
        ours: ours.value, theirs: theirs.value,
        oursAt: ours.at, theirsAt: theirs.at,
        reason: 'concurrent_text',
      },
    };
  }
  // Legacy records had no causal frontier. Preserve their former HLC behavior
  // while every new Planner edit carries explicit ancestry.
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
  return { value: order > 0 ? theirs : ours };
}

/** The newest stamp among a record's fields, ignoring the ones it does not have. */
export function latestStamp(stamps: ReadonlyArray<Hlc | undefined>): Hlc | undefined {
  const present = stamps.filter((s): s is Hlc => !!s);
  if (present.length === 0) return undefined;
  return present.reduce((a, b) => (hlcAfter(b, a) ? b : a));
}

export interface TombstoneOutcome {
  /** The surviving tombstone, or undefined when the record was resurrected. */
  deletedAt?: Hlc;
  /** Set when the resurrection needs a human to decide. */
  conflict?: ConflictRecord;
}

/**
 * Delete versus edit.
 *
 * A tombstone does not simply win: an edit stamped after it means someone was
 * working on this after someone else removed it, and both silently undeleting
 * and silently discarding the edit are wrong. So the record comes back marked
 * conflicted, and a person decides.
 *
 * Shared rather than reimplemented per surface because this is the rule most
 * likely to be got subtly differently the second time — and a planner that
 * resurrects where Notes discards is a data-loss bug that only appears when
 * someone compares two surfaces.
 */
export function resolveTombstone(
  ours: Hlc | undefined,
  theirs: Hlc | undefined,
  newestEdit: Hlc | undefined,
): TombstoneOutcome {
  const tombstone = ours && theirs
    ? (hlcAfter(theirs, ours) ? theirs : ours)
    : (ours ?? theirs);
  if (!tombstone) return {};
  if (newestEdit && hlcAfter(newestEdit, tombstone)) {
    return {
      conflict: {
        ours: 'deleted', theirs: 'edited',
        oursAt: tombstone, theirsAt: newestEdit,
        reason: 'delete_vs_edit',
      },
    };
  }
  return { deletedAt: tombstone };
}
