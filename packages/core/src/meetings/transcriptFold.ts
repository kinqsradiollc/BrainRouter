/**
 * ADR-035 D4/D5 — the ONE rule for putting live transcript text into a compose
 * box. Both hosts call this; neither owns a second answer.
 *
 * ## What it owns
 *
 * Given the box as the person currently sees it, the session so far, and how
 * much of the transcript this rule has already put there, it answers: what
 * should the box hold now. Nothing else — no draft store, no textarea, no
 * timer, no host. That is what lets a kill-and-reopen be asserted as a string.
 *
 * ## Why it is here rather than in a host
 *
 * It was the desktop's (`liveTranscript.ts`), and the dashboard had a SECOND,
 * different answer for the same question: `composeCaptureTranscript` rebuilt
 * `base + transcriptText(session)` on every drain, with `base` set to
 * `reconcileCaptureDraft(...).retained` — the box with every segment stripped
 * out of it. Recomposing from that base puts ALL of the person's own words
 * first and the whole meeting after them, which reproduced two silent
 * corruptions on the dashboard and neither on the desktop:
 *
 * - a note typed BETWEEN two segments came back ABOVE the entire transcript
 *   after a kill and reopen — `"S1\nMy note\nS2\nS3"` reopened as
 *   `"My note\nS1\nS2\nS3"`;
 * - an edit to the LAST settled segment came back as
 *   `"S3 corrected\nS1\nS2\nS3"` — the pre-edit wording restored INTO the
 *   meeting and the edit relocated to the top.
 *
 * Both are one mistake: treating the box's ORDER as the surface's to decide.
 * **Position is the person's, not the surface's.** A rule that only ever
 * appends cannot make either error, which is why the append model is the one
 * that moved here rather than the recompose model.
 *
 * (The recompose model also needed a `dirty` flag to stop it overwriting an
 * edit, and that flag could not survive a reload: it was recomputed as
 * `reconciled.userOwned.length > 0`, which is `[]` whenever every segment still
 * matches — so automatic recomposition switched itself back ON across the very
 * kill it was protecting the box from. An append-only rule needs no such flag,
 * so there is nothing to reconstruct and nothing to reconstruct wrongly.)
 *
 * ## The invariants
 *
 * 1. **Append only, from `next`, and only the run that is finished.** Text
 *    already in the box is never moved, reordered, or removed. The walk starts
 *    where it stopped and stops again at the first segment that could still
 *    change on its own — one still in flight, or a gap the shared queue is
 *    going to retry — so the box stays in capture order without a line of it
 *    ever being rewritten. That is what makes an edit safe (D4: "a user editing
 *    settled text must not have their edit overwritten by a late-arriving
 *    segment").
 * 2. **Whether a gap is still coming back is the SHARED queue's answer.**
 *    `planTranscription` decides which segments are exhausted. Comparing
 *    attempt counts here would be a second retry rule, and the two would drift
 *    into two hosts disagreeing about when a meeting is out of retries.
 * 3. **A gap that later transcribes is corrected IN PLACE — unless a person has
 *    touched it.** §6 asks that a retry "fills them in from the audio still on
 *    disk", so the marker this rule wrote is replaced exactly where it sits;
 *    appending the recovered words at the end would leave the false claim
 *    standing AND put the meeting out of order. If that exact marker is no
 *    longer in the box, the person owns that region and nothing is replaced —
 *    invariant 1 outranks the correction, and a marker they deleted is not
 *    resurrected.
 *
 * The gap wording is `formatCaptureGap` from the shared transcript module,
 * never a sentence composed here, so a transcript exported from the desktop
 * says the same thing as one exported from the dashboard.
 */
import { unsettledSegments } from './captureSession.js';
import type { MeetingDraftReconciliation } from './draftReconcile.js';
import { planTranscription } from './queuePlan.js';
import { formatCaptureGap, transcriptSoFar, type MeetingTranscriptEntry } from './transcript.js';
import type { MeetingCaptureSession } from './types.js';

export interface TranscriptFold {
  /**
   * Segment index → the exact text this rule put in the box for it.
   *
   * Only segments that actually contributed a non-empty line appear. It is what
   * lets invariant 3 find its own marker and replace it, and what keeps it from
   * touching anything it did not write.
   */
  readonly inserted: ReadonlyMap<number, string>;
  /** The first segment index that has not been folded in yet. */
  readonly next: number;
}

/** A box that has never held any of this capture's transcript. */
export const EMPTY_TRANSCRIPT_FOLD: TranscriptFold = { inserted: new Map(), next: 0 };

/**
 * Where the fold resumes over a box that ALREADY holds part of this capture —
 * a restored draft, or a box this window folded into before adopting the
 * session again.
 *
 * `EMPTY_TRANSCRIPT_FOLD` here is the doubling defect: it says the box holds
 * none of the meeting, so every settled segment is appended a second time and
 * the doubled text is what gets POSTed and summarized. `reconcileCaptureDraft`
 * is the shared answer to which segments the box already accounts for, and its
 * `matched` drops straight in because it is keyed by segment index and holds
 * the exact strings the box currently has.
 */
export function beginTranscriptFold(reconciled: MeetingDraftReconciliation): TranscriptFold {
  return { inserted: reconciled.matched, next: reconciled.next };
}

export interface FoldTranscriptOptions {
  /**
   * Submit-time: stop waiting and state every unresolved segment as a gap.
   *
   * A meeting is being created from this text, so a segment still in flight
   * will never reach it. D5 says the transcript must say so rather than omit
   * it, and this matches what `finalizeCapture` does to the record at the same
   * moment.
   */
  readonly settleAll?: boolean;
}

export interface TranscriptFoldResult {
  readonly text: string;
  readonly fold: TranscriptFold;
  /** False when nothing moved, so a caller can skip a pointless state update. */
  readonly changed: boolean;
}

/**
 * The text a segment contributes, or `null` for "stop here, it is not
 * finished".
 *
 * A settled segment with no text is a genuinely silent stretch of the meeting:
 * it contributes nothing and does not stop the walk.
 */
function contribution(
  entry: MeetingTranscriptEntry,
  settleAll: boolean,
  exhausted: ReadonlySet<number>,
): string | null {
  if (entry.kind === 'settled') return entry.text;
  if (settleAll) return formatCaptureGap(entry.startMs, entry.endMs);
  if (entry.kind === 'gap' && exhausted.has(entry.index)) return entry.text;
  return null;
}

export function foldTranscript(
  current: string,
  session: MeetingCaptureSession,
  fold: TranscriptFold,
  options: FoldTranscriptOptions = {},
): TranscriptFoldResult {
  const entries = transcriptSoFar(session);
  const inserted = new Map(fold.inserted);
  const settleAll = Boolean(options.settleAll);
  let text = current;
  let changed = false;

  // Invariant 3 — a gap we already stated has since transcribed.
  for (const [index, previous] of fold.inserted) {
    const entry = entries[index];
    if (!entry || entry.kind !== 'settled' || !entry.text || entry.text === previous) continue;
    const at = text.indexOf(previous);
    // Not there any more: the person edited or deleted that region, so it is
    // theirs and the recovered text is not written anywhere — not here, and not
    // appended at the end either.
    if (at < 0) continue;
    // Spliced by index rather than `String.replace`, which reads `$&`, `` $` ``
    // and `$'` out of the REPLACEMENT — so a transcript that happens to contain
    // one would heal into the marker it was replacing.
    text = `${text.slice(0, at)}${entry.text}${text.slice(at + previous.length)}`;
    inserted.set(index, entry.text);
    changed = true;
  }

  // Invariants 1/2 — append the next run that will not change on its own.
  const exhausted = new Set(settleAll ? [] : planTranscription(session).exhausted);
  const additions: string[] = [];
  let next = fold.next;
  while (next < entries.length) {
    const value = contribution(entries[next]!, settleAll, exhausted);
    if (value === null) break;
    // Only non-empty text is recorded as inserted: the map is a claim about
    // what is in the box, and a silent segment put nothing there.
    if (value) {
      additions.push(value);
      inserted.set(next, value);
    }
    next += 1;
  }
  if (additions.length) {
    const joined = additions.join('\n');
    text = text ? `${text}\n${joined}` : joined;
    changed = true;
  }

  return { text, fold: { inserted, next }, changed };
}

export interface SettledTranscript extends TranscriptFoldResult {
  /**
   * Segments this text now states as gaps because they never transcribed —
   * empty when the queue had already finished, and empty for a pasted
   * transcript with no capture behind it (which is not the same claim as
   * "nothing failed": with no session there is no segment that could have).
   *
   * What a surface warns about BEFORE the click is the same set
   * (`unsettledSegments`); this is what actually went in.
   */
  readonly stated: readonly number[];
}

/**
 * D5, at the one moment it is irreversible: the text a meeting is created from.
 *
 * `transcriptSoFar` gives a segment still in flight no text, which is right
 * while the meeting is being recorded — it is still coming — and wrong at
 * submit, because the create is followed by `finalizeCapture` and the deletion
 * of the audio, so it is never coming again. Posted as-is, twenty seconds of a
 * meeting would vanish between two sentences that then read as contiguous
 * speech: D5's "unmarked hole", which it calls worse than a transcript that
 * says `00:12:30–00:13:00 could not be transcribed`.
 *
 * So this is `foldTranscript` with `settleAll`, plus the set that went in as
 * gaps. It is the same append rule — an edit is still not overwritten and
 * nothing is reordered on the way to the POST.
 */
export function settleTranscriptForSubmit(
  current: string,
  session: MeetingCaptureSession | null,
  fold: TranscriptFold,
): SettledTranscript {
  if (!session) return { text: current, fold, changed: false, stated: [] };
  const stated = unsettledSegments(session).map((segment) => segment.index);
  return { ...foldTranscript(current, session, fold, { settleAll: true }), stated };
}
