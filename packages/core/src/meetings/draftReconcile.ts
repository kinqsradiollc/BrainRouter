/**
 * ADR-035 D4 — what the compose box should hold when a restored draft and a
 * recovered session BOTH claim to know the transcript.
 *
 * This module owns one question and nothing else: given the text a person's
 * draft came back with, and the session §6's destructive test just recovered,
 * which segments does that text already account for?
 *
 * It exists because both hosts answered it the same wrong way. Both mirror the
 * live transcript into the draft as it settles, and both persist that draft. So
 * after a kill the draft ALREADY holds the transcript — and then the desktop
 * reset its fold to `EMPTY_TRANSCRIPT_FOLD` before adopting the session, and the
 * dashboard passed the restored draft as `base` and appended the whole
 * transcript to it. Both produced the meeting twice, and both POSTed and
 * summarized the doubled text. A shared misunderstanding is a shared rule that
 * was never written down, so it is written down here.
 *
 * The rule, and the reason it is not simply "use the session":
 *
 * 1. **Text the session can account for is folded in exactly once.** A
 *    contribution the box already holds verbatim is not appended again. This is
 *    the duplication fix.
 * 2. **Text the session cannot account for survives untouched.** A pasted
 *    transcript, a typed note, an imported file's text — none of it is in any
 *    segment, and nothing here removes or rewrites it. Getting this direction
 *    wrong destroys what a person wrote, which is worse than the duplication it
 *    would be fixing.
 * 3. **An edit outranks the session.** D4: "a user editing settled text must not
 *    have their edit overwritten by a late-arriving segment." A segment whose
 *    text the box no longer holds verbatim, but which the draft has plainly
 *    moved PAST (a later segment is still there), was edited or deleted on
 *    purpose. It is reported as accounted-for and user-owned, and is never
 *    re-appended. This is the same rule the desktop's `foldTranscript` already
 *    encodes when it declines to replace a gap marker that is no longer there.
 *
 * How coverage is decided, and the one honest limit of it:
 *
 * A contribution is always written on its own line (both hosts join with `\n`),
 * so matching is done on whole lines, in capture order, with a monotonic cursor.
 * The frontier is the HIGHEST-indexed segment still found in the box; everything
 * at or below it is the surface's own past writing — matched, or since edited —
 * and everything above it has never reached the box.
 *
 * The limit: a person who edits the LAST settled segment and nothing after it
 * leaves no anchor behind, so that segment reads as never-folded and is appended
 * once more. That is the safe direction of the two — their edit is still there,
 * beside a duplicate line they can delete — whereas guessing that trailing text
 * IS the edited segment would swallow a pasted draft whole.
 *
 * Pure, like the rest of this subsystem: no draft store, no textarea, no host.
 */
import { formatCaptureGap, transcriptSoFar, type MeetingTranscriptEntry } from './transcript.js';
import type { MeetingCaptureSession } from './types.js';

export interface MeetingDraftReconciliation {
  /**
   * What the box should hold now.
   *
   * This is the draft, with one correction: a gap marker the draft states for a
   * segment the recovered session has since settled is replaced in place by that
   * segment's text (D5 — "retrying fills them in from the audio still on disk").
   * Nothing is ever appended here; appending is the fold's job, and it resumes
   * at `next`.
   */
  readonly text: string;
  /**
   * Segment indices `text` already accounts for, in capture order. A caller must
   * not fold these in again — that is the doubling this module exists to end.
   */
  readonly accounted: readonly number[];
  /**
   * index → the exact string `text` currently holds for that segment.
   *
   * Only verbatim-present segments appear. This is what lets a later gap-heal
   * (`foldTranscript` rule 3) find its own marker and replace it, and what keeps
   * it from touching anything else.
   */
  readonly matched: ReadonlyMap<number, string>;
  /**
   * Accounted indices whose contribution the box no longer holds verbatim: the
   * person edited or deleted them. Neither host may rewrite these — D4's rule 3.
   */
  readonly userOwned: readonly number[];
  /** The first index the box does not account for. The fold resumes here. */
  readonly next: number;
  /**
   * The draft with every accounted contribution removed — the person's own
   * words, and only those.
   *
   * A host that recomposes the whole transcript on each drain (rather than
   * appending to it) needs this as its base: composing over the raw draft is
   * precisely how the dashboard doubled the meeting.
   */
  readonly retained: string;
}

/**
 * Reconcile a restored draft against a recovered session.
 *
 * Neither argument is modified and no text is ever deleted from the draft: the
 * result's `text` differs from `draft` only where a stated gap has been healed.
 */
export function reconcileCaptureDraft(
  draft: string,
  session: MeetingCaptureSession,
): MeetingDraftReconciliation {
  const lines = draft.length ? draft.split('\n') : [];
  const matched = new Map<number, string>();
  const consumed = new Set<number>();
  let cursor = 0;
  let frontier = -1;

  for (const entry of transcriptSoFar(session)) {
    const found = locate(lines, entry, cursor);
    if (!found) continue;
    let value = found.value;
    let span = found.run.length;
    // The draft states a gap the session has since filled in. Replace it where it
    // sits: appending the recovered words at the end would leave the false claim
    // standing AND put the text out of order.
    if (entry.kind === 'settled' && entry.text && entry.text !== value) {
      const replacement = entry.text.split('\n');
      // Safe to splice: the walk is monotonic, so every line already recorded in
      // `consumed` sits before `found.at` and none of their indices move.
      lines.splice(found.at, span, ...replacement);
      value = entry.text;
      span = replacement.length;
    }
    for (let offset = 0; offset < span; offset += 1) consumed.add(found.at + offset);
    matched.set(entry.index, value);
    cursor = found.at + span;
    frontier = entry.index;
  }

  const accounted: number[] = [];
  const userOwned: number[] = [];
  for (let index = 0; index <= frontier; index += 1) {
    accounted.push(index);
    if (!matched.has(index)) userOwned.push(index);
  }

  return {
    text: lines.join('\n'),
    accounted,
    matched,
    userOwned,
    next: frontier + 1,
    retained: retain(lines, consumed),
  };
}

interface LocatedContribution {
  readonly at: number;
  readonly run: readonly string[];
  readonly value: string;
}

/**
 * The strings this entry could have put in the box.
 *
 * A settled entry gets its text AND its gap marker: the draft may have been
 * written while the segment was still a stated gap, and a retry filled it in
 * afterwards. Everything else can only ever have contributed a marker —
 * provisional segments contribute nothing until a host settles them all at
 * submit time, and a gap's text IS its marker.
 */
function candidates(entry: MeetingTranscriptEntry): readonly string[] {
  const marker = formatCaptureGap(entry.startMs, entry.endMs);
  if (entry.kind === 'settled' && entry.text) return [entry.text, marker];
  return [marker];
}

/** The earliest place at or after `from` where this entry's text still sits. */
function locate(
  lines: readonly string[],
  entry: MeetingTranscriptEntry,
  from: number,
): LocatedContribution | null {
  let best: LocatedContribution | null = null;
  for (const value of candidates(entry)) {
    const run = value.split('\n');
    const at = findRun(lines, run, from);
    if (at < 0 || (best && at >= best.at)) continue;
    best = { at, run, value };
  }
  return best;
}

/**
 * Whole-line matching, not substring matching.
 *
 * Both hosts write a contribution as its own line (or run of lines), so anchoring
 * to line boundaries costs nothing and refuses the false positive that matters:
 * a short segment ("Yes.") appearing inside a sentence the person typed, which
 * would otherwise mark that segment folded and drop it from the transcript.
 */
function findRun(lines: readonly string[], run: readonly string[], from: number): number {
  if (!run.length) return -1;
  for (let start = Math.max(0, from); start + run.length <= lines.length; start += 1) {
    let hit = true;
    for (let offset = 0; offset < run.length; offset += 1) {
      if (lines[start + offset] !== run[offset]) { hit = false; break; }
    }
    if (hit) return start;
  }
  return -1;
}

/** The lines no segment claimed, with the blank edges a removal leaves trimmed off. */
function retain(lines: readonly string[], consumed: ReadonlySet<number>): string {
  const kept = lines.filter((_, index) => !consumed.has(index));
  while (kept.length && !kept[0]!.trim()) kept.shift();
  while (kept.length && !kept[kept.length - 1]!.trim()) kept.pop();
  return kept.join('\n');
}
