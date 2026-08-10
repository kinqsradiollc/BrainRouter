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
 *    re-appended. This is the same rule the shared `foldTranscript` encodes when
 *    it declines to replace a gap marker that is no longer there.
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
 * The second limit, and the reason the contract below is the whole defence: in a
 * box that has never held the transcript, a typed line that happens to equal
 * segment N's text verbatim pins the frontier at N, and segments before it are
 * read as deleted rather than as never-folded. There is no rule that separates
 * those two readings — "unmatched below the frontier" is exactly what a
 * deliberate deletion looks like — and refusing to believe an unanchored match
 * would resurrect the first line of every transcript whose opening the person
 * deleted, which is worse and far commoner. A box that HOLDS the transcript has
 * anchors for every segment and cannot reach this state, which is why persisting
 * the whole box is not merely tidier than persisting `retained`.
 *
 * ## What `composeBox` must be, and why it is not a formality
 *
 * **`composeBox` is the WHOLE compose box, exactly as the person sees it** —
 * their words and every segment the surface has already folded in. It is what a
 * host persists as the draft and restores verbatim on reopen.
 *
 * **It is never `retained` from a previous call.** `retained` is this function's
 * answer to "which of this text did no segment contribute", and it is by
 * construction the COMPLEMENT of the frontier rule's input: every segment
 * contribution has been stripped out of it. Replaying it here runs the rule on
 * the one input it was not designed for, and the result is not a near miss — it
 * is four different silent corruptions, all of them reproduced in
 * `meeting-draft-reconcile.test.ts`:
 *
 * - a typed note that happens to be a whole line one segment also said pins the
 *   frontier at that segment, so every EARLIER segment is reported accounted-for
 *   and `userOwned` and is dropped from the meeting with no gap marker;
 * - an edit to a settled segment survives the strip (it is the person's text
 *   now), so on reopen the box holds the edit AND the original folds in again —
 *   the doubling this module exists to end, reappearing across a kill;
 * - a line the person DELETED comes back, because the deletion left nothing in
 *   the stripped box to record that it happened;
 * - a note typed BETWEEN two segments is relocated to the top, because the
 *   stripped box is all that survives and everything folds in after it.
 *
 * **This cannot be detected here, and pretending otherwise would be worse than
 * saying so.** A `retained` box and a perfectly legitimate box that has simply
 * never held the transcript — a fresh window, a pasted agenda, a session
 * recovered from a previous run — are the same string with the same relationship
 * to the same session. There is no property of the input that separates them,
 * because the thing that separates them (whether the box ever held those
 * segments) is exactly what stripping destroyed. So the contract is stated, in
 * the signature and here, and enforced by tests over the round trip the hosts
 * actually perform rather than by a guard that would fire on half of the honest
 * cases and none of the dishonest ones.
 *
 * `retained` remains correct for what it is for: composing the NEXT box in
 * memory, where the transcript is about to be appended to it again in the same
 * breath. See the field's own note.
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
   * (`foldTranscript` invariant 3) find its own marker and replace it, and what
   * keeps it from touching anything else. `beginTranscriptFold` is what carries
   * it across, so a host never assembles that resume point itself.
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
   * **Nothing should be composing from this, and the field is on its way out.**
   * It served the one host that recomposed the whole box on every drain
   * (`base + transcriptText(session)`), and that model is gone: composition is
   * `foldTranscript`, which appends from `next` and never moves a line the box
   * already holds. Recomposing from `retained` necessarily puts ALL of the
   * person's own words first and the whole meeting after them, which is why a
   * note typed BETWEEN two segments came back above the entire transcript, and
   * an edit to the last settled segment came back reverted AND relocated — both
   * reproduced, both on one host only, which is how a second composition rule
   * announces itself.
   *
   * It survives only until the dashboard stops passing it as `base`, and it is
   * deleted with that change. Until then: it is a composition base, not a
   * document. It must not be persisted as the draft and it must not be fed back
   * in as `composeBox` — see the module header for the four corruptions that
   * causes. What a host persists is `text`, or the box the person is looking at;
   * both hold the whole meeting, which is the only shape this function can
   * reconcile.
   */
  readonly retained: string;
}

/**
 * Reconcile a restored draft against a recovered session.
 *
 * @param composeBox The FULL compose box as the person sees it — their own words
 *   and every segment already folded into it. This is what a host persists and
 *   restores verbatim. It is NEVER `retained` from a previous call: that box has
 *   had the segments stripped out of it, which is the one input the frontier
 *   rule cannot read. The module header lists what replaying it destroys.
 * @param session The recovered capture record.
 *
 * Neither argument is modified and no text is ever deleted from the box: the
 * result's `text` differs from `composeBox` only where a stated gap has been
 * healed.
 */
export function reconcileCaptureDraft(
  composeBox: string,
  session: MeetingCaptureSession,
): MeetingDraftReconciliation {
  const lines = composeBox.length ? composeBox.split('\n') : [];
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
