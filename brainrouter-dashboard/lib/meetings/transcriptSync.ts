/**
 * ADR-035 D4 — keeping the compose box in step with a live transcript WITHOUT
 * ever overwriting what a person typed.
 *
 * D4 states the requirement in one sentence: "A user editing settled text must
 * not have their edit overwritten by a late-arriving segment." The shared model
 * already holds up its half — `markDone` drops a result for a segment that is
 * already `done`, so a late duplicate cannot rewrite settled text. But the
 * dashboard has a second writer the model cannot see: this page composes the
 * whole transcript into a textarea on every drain, and that composition would
 * happily replace a paragraph the user just fixed.
 *
 * So the rule this module encodes is: **the surface only ever replaces text it
 * put there itself.** The moment the textarea stops matching what we last wrote,
 * the capture is `dirty` and automatic composition stops for good — replaced by
 * an explicit "append what has transcribed since" affordance, because silently
 * withholding new text would be the ADR-028 failure in the other direction.
 *
 * Everything here is pure so the rule can be tested without a browser. The
 * transcript itself — which segments are settled, which are provisional, and
 * what a gap says — comes from the shared `transcriptSoFar`/`transcriptText`;
 * this module only decides what goes in the box and when.
 */
import {
  finalizeCapture,
  formatCaptureGap,
  isTerminalCaptureStatus,
  transcriptSoFar,
  transcriptText,
  unsettledSegments,
  type MeetingCaptureSession,
} from "@kinqs/brainrouter-core/meetings";

/**
 * What the surface last wrote, and whether it is still allowed to write.
 *
 * `base` is whatever was in the box when the capture started — a pasted
 * transcript, a recovered draft. Capture text is APPENDED to it rather than
 * replacing it, because pressing Record is not a request to delete what you
 * already wrote.
 */
export interface TranscriptSyncState {
  readonly base: string;
  /** The exact string this module last put in the box. */
  readonly written: string;
  /**
   * Segment indices whose text is already in `written`, as a SET rather than a
   * high-water mark.
   *
   * A high-water mark is the obvious implementation and it is wrong: segments do
   * not settle in order. Segment 1 can fail while 2 succeeds, and 1 can then be
   * filled in by a D5 retry minutes later. Under a high-water mark that recovered
   * text is below the line and is never offered again — a segment silently
   * dropped from the transcript, which is the exact failure D5 exists to refuse.
   */
  readonly included: readonly number[];
  /** Once true, automatic composition is off for this capture, permanently. */
  readonly dirty: boolean;
}

export function beginTranscriptSync(base: string): TranscriptSyncState {
  return { base, written: base, included: [], dirty: false };
}

/** The whole transcript so far, appended to whatever the box already held. */
export function composeCaptureTranscript(base: string, session: MeetingCaptureSession): string {
  const composed = transcriptText(session);
  if (!composed) return base;
  return base ? `${base}\n${composed}` : composed;
}

/**
 * Every segment index that currently contributes text — settled text or a stated
 * gap. A segment still in flight is deliberately absent: it has nothing to say
 * yet, so recording it as "included" would mean its text was never offered once
 * it arrived.
 */
export function includedTranscriptIndices(session: MeetingCaptureSession): readonly number[] {
  return transcriptSoFar(session)
    .filter((entry) => entry.kind !== "provisional" && entry.text.length > 0)
    .map((entry) => entry.index);
}

/** The text the box does not have yet, in capture order. Append-only. */
export function pendingTranscriptText(
  session: MeetingCaptureSession,
  included: readonly number[],
): string {
  const already = new Set(included);
  return transcriptSoFar(session)
    .filter((entry) => !already.has(entry.index) && entry.kind !== "provisional" && entry.text.length > 0)
    .map((entry) => entry.text)
    .join("\n");
}

/**
 * Put recovered text where its gap marker was.
 *
 * Appending alone is not enough for D5. A gap the user already has in their box
 * is a claim that a range of the meeting could not be transcribed; when a retry
 * proves otherwise, appending the recovered words at the END would leave that
 * false claim standing AND put the text out of order. So the marker is replaced
 * exactly where it sits.
 *
 * Safe against editing precisely because the match must be exact: the marker
 * string is one this surface wrote verbatim (`formatCaptureGap`), so if the user
 * has touched that line it simply does not match and nothing is rewritten. It
 * can never edit prose a person typed.
 */
export function healTranscriptGaps(session: MeetingCaptureSession, current: string): string {
  let text = current;
  for (const entry of transcriptSoFar(session)) {
    if (entry.kind !== "settled" || !entry.text) continue;
    const marker = formatCaptureGap(entry.startMs, entry.endMs);
    if (text.includes(marker)) text = text.split(marker).join(entry.text);
  }
  return text;
}

/**
 * Whether the box is out of step with the transcript — new text has settled, or
 * a gap in it has since been filled in.
 *
 * Only meaningful once the capture is `dirty`: before that the box is kept in
 * step automatically and there is nothing to offer.
 */
export function transcriptRevisionPending(
  state: TranscriptSyncState,
  session: MeetingCaptureSession,
  current: string,
): boolean {
  if (!state.dirty) return false;
  if (pendingTranscriptText(session, state.included).length > 0) return true;
  return healTranscriptGaps(session, current) !== current;
}

/**
 * Decide the next sync state and, if the box should change, what to put in it.
 *
 * Returns `text: undefined` when nothing should be written — which is the common
 * case, and deliberately distinguished from writing an empty string.
 */
export function nextTranscriptSync(
  state: TranscriptSyncState,
  session: MeetingCaptureSession,
  current: string,
): { readonly state: TranscriptSyncState; readonly text?: string } {
  // The box no longer holds what we wrote, so a person changed it. From here the
  // capture is theirs; we only offer.
  if (!state.dirty && current !== state.written) return { state: { ...state, dirty: true } };
  if (state.dirty) return { state };
  const composed = composeCaptureTranscript(state.base, session);
  if (composed === state.written) return { state };
  return {
    state: { base: state.base, written: composed, included: includedTranscriptIndices(session), dirty: false },
    text: composed,
  };
}

/**
 * Fold the transcript's changes into the user's own text, once they ask.
 *
 * Gaps are healed where they stand and genuinely new text is appended at the
 * end. Both, in that order, because a recovered gap is a correction to something
 * already in the box and new text is not.
 */
export function appendTranscriptSync(
  state: TranscriptSyncState,
  session: MeetingCaptureSession,
  current: string,
): { readonly state: TranscriptSyncState; readonly text: string } {
  const healed = healTranscriptGaps(session, current);
  const pending = pendingTranscriptText(session, state.included);
  const text = pending ? (healed ? `${healed}\n${pending}` : pending) : healed;
  if (text === current) return { state, text: current };
  // Stays `dirty`: their edit is still theirs, and the next drain must not
  // replace the whole box just because it matches what we last wrote again.
  return { state: { ...state, written: text, included: includedTranscriptIndices(session), dirty: true }, text };
}

export interface SubmitTranscript {
  readonly state: TranscriptSyncState;
  /** The text the meeting must be created from. */
  readonly text: string;
  /**
   * Segments this text now states as gaps because they never transcribed —
   * empty when the queue had already finished. What the surface warns about
   * BEFORE the click is the same set (`unsettledSegments`); this is what
   * actually went in.
   */
  readonly stated: readonly number[];
}

/**
 * D5, at the one moment it is irreversible: the text a meeting is created from.
 *
 * `transcriptText` keeps only settled segments and stated gaps, so a segment
 * still in flight contributes NOTHING to the compose box. That is right while
 * the meeting is being recorded — it is still coming — and wrong at submit,
 * because the create is followed by `finalizeCapture` and the deletion of the
 * audio, so it is never coming again. Posted as-is, twenty seconds of a meeting
 * would vanish between two sentences that then read as contiguous speech: D5's
 * "unmarked hole", which it calls worse than a transcript that says
 * `00:12:30–00:13:00 could not be transcribed`.
 *
 * So the text is composed over the session as `finalizeCapture` is about to
 * leave it — that transition IS the shared rule for "unsettled at the end
 * becomes a stated gap", and calling it here rather than restating its verdict
 * is what keeps the transcript and the record saying the same thing.
 *
 * Which composition applies is the same question as ever, and gets the same
 * answer: an untouched box is recomposed, an edited one is appended to. `current
 * !== state.written` counts as edited even when `dirty` is not set yet, because
 * submit can be the very next thing after a keystroke and the sync effect that
 * would have noticed runs after the render.
 */
export function settleTranscriptForSubmit(
  state: TranscriptSyncState,
  session: MeetingCaptureSession,
  current: string,
): SubmitTranscript {
  const stated = unsettledSegments(session).map((segment) => segment.index);
  const settled = stated.length && !isTerminalCaptureStatus(session.status)
    ? finalizeCapture(session)
    : session;
  if (state.dirty || current !== state.written) {
    const appended = appendTranscriptSync({ ...state, dirty: true }, settled, current);
    return { state: appended.state, text: appended.text, stated };
  }
  const next = nextTranscriptSync(state, settled, current);
  return { state: next.state, text: next.text ?? current, stated };
}

/**
 * The whole of "what text does this meeting get created from", including the
 * case where there is no capture at all.
 *
 * This exists to remove a variable. The page used to settle into a `let
 * transcript = draftTranscript` and then post the identifier — so deleting the
 * one line that assigned the settled text put the unmarked-hole defect back
 * while every test still passed, because the call was still there, still
 * ordered, and the posted identifier was spelled the same either way. There is
 * no line to delete now: the text a meeting is created from is this function's
 * return value, and a pasted transcript with no session takes the same path
 * rather than a branch beside it.
 *
 * `stated` is empty for a pasted transcript because nothing was captured, which
 * is not the same claim as "nothing failed" — with no session there is no
 * segment that could have.
 */
export function submitTranscript(
  state: TranscriptSyncState,
  session: MeetingCaptureSession | null,
  current: string,
): SubmitTranscript {
  if (!session) return { state, text: current, stated: [] };
  return settleTranscriptForSubmit(state, session, current);
}
