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
}

export interface ConflictRecord {
  /** Both versions, kept. The human picks; nothing is discarded to decide. */
  ours: unknown;
  theirs: unknown;
  oursAt: Hlc;
  theirsAt: Hlc;
  reason: 'concurrent_text' | 'delete_vs_edit';
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
