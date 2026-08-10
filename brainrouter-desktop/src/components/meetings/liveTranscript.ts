/**
 * ADR-035 D4/D5 — folding the live transcript into the draft a person can edit.
 *
 * D4 states one rule that a naive "render the transcript" implementation breaks
 * on its first late segment: **a user editing settled text must not have their
 * edit overwritten**. So the compose box is never re-rendered from the session.
 * It is only ever APPENDED to, in capture order, by this function — which is why
 * it exists as a pure module instead of a `useEffect` body: this is the part
 * that has to be right, and it is the part a React test could not check.
 *
 * Three rules, and each one is a specific way of getting D4/D5 wrong:
 *
 * 1. **Append only, and only the run that is finished.** The fold walks forward
 *    from where it stopped and stops again at the first segment that could still
 *    change on its own — a provisional one, or a gap the shared queue is still
 *    going to retry. That keeps the box in chronological order without ever
 *    rewriting a line, which is exactly what makes an edit safe.
 * 2. **Whether a gap is still coming back is the SHARED queue's answer.**
 *    `planTranscription` decides which segments are exhausted. Comparing attempt
 *    counts here would be a second retry rule, and the two would drift.
 * 3. **A gap that later transcribes is corrected in place — unless a person has
 *    touched it.** §6 asks that retrying "fills them in from the audio still on
 *    disk", so the marker this module wrote is replaced by the recovered text.
 *    If that exact marker is no longer in the box the user has taken ownership
 *    of that region and nothing is replaced: rule 1 outranks the correction.
 *
 * The gap wording is `formatCaptureGap` from the shared transcript module, never
 * a sentence composed here, so a transcript exported from the desktop says the
 * same thing as one exported from the dashboard.
 */
import {
  formatCaptureGap,
  planTranscription,
  transcriptSoFar,
  type MeetingCaptureSession,
  type MeetingTranscriptEntry,
} from "@kinqs/brainrouter-core/meetings";

export interface TranscriptFold {
  /** Segment index → the exact text this module put in the box for it. */
  readonly inserted: ReadonlyMap<number, string>;
  /** The first segment index that has not been folded in yet. */
  readonly next: number;
}

export const EMPTY_TRANSCRIPT_FOLD: TranscriptFold = { inserted: new Map(), next: 0 };

export interface FoldTranscriptOptions {
  /**
   * Submit-time: stop waiting and state every unresolved segment as a gap.
   *
   * A meeting is being created from this text, so a segment still in flight will
   * never reach it. D5 says the transcript must say so rather than omit it, and
   * this matches what `finalizeCapture` does to the record at the same moment.
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
 * The text a segment contributes, or `null` for "stop here, it is not finished".
 *
 * A settled segment with no text is a genuinely silent twenty seconds: it
 * contributes nothing and does not stop the walk.
 */
function contribution(
  entry: MeetingTranscriptEntry,
  settleAll: boolean,
  exhausted: ReadonlySet<number>,
): string | null {
  if (entry.kind === "settled") return entry.text;
  if (settleAll) return formatCaptureGap(entry.startMs, entry.endMs);
  if (entry.kind === "gap" && exhausted.has(entry.index)) return entry.text;
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

  // Rule 3 — a gap we already stated has since transcribed.
  for (const [index, previous] of fold.inserted) {
    const entry = entries[index];
    if (!entry || entry.kind !== "settled" || !entry.text || entry.text === previous) continue;
    if (!text.includes(previous)) continue;
    text = text.replace(previous, entry.text);
    inserted.set(index, entry.text);
    changed = true;
  }

  // Rule 1/2 — append the next run that will not change on its own.
  const exhausted = new Set(settleAll ? [] : planTranscription(session).exhausted);
  const additions: string[] = [];
  let next = fold.next;
  while (next < entries.length) {
    const value = contribution(entries[next]!, settleAll, exhausted);
    if (value === null) break;
    // Only non-empty text is recorded as inserted: an empty marker would make
    // the correction pass above match everywhere.
    if (value) {
      additions.push(value);
      inserted.set(next, value);
    }
    next += 1;
  }
  if (additions.length) {
    const joined = additions.join("\n");
    text = text ? `${text}\n${joined}` : joined;
    changed = true;
  }

  return { text, fold: { inserted, next }, changed };
}
