/**
 * ADR-035 D9/D10 — turning a server coverage proof into DURABLE transcript.
 *
 * A coverage event says: every sample through this durability chunk is
 * represented by earlier finals or by silence, and will not be revised. That is
 * a statement about audio, not about a transcript — so promoting it is two
 * moves, and this module is both of them:
 *
 * 1. **Seal the proven run into units.** `sealUnit({ throughSequence })` is the
 *    shared rule and the endpoint's boundary is preserved unless a hard
 *    duration/byte ceiling has to cut it. Chunks past the proof stay open.
 * 2. **Settle each new unit with the words that belong to it**, so the session
 *    on disk carries the text and the shared `transcriptFold` puts it in the
 *    compose box exactly as a segmented result would.
 *
 * **A chunk already claimed by a unit is never re-sealed**, which is the whole
 * of "no doubled text". `sealUnit` only ever takes the OPEN suffix, so audio a
 * ceiling already cut into a unit — or that `stopCapture` sealed — belongs to
 * the segmented queue, and coverage over it creates nothing here. The two
 * strategies therefore share one meeting without either writing the other's
 * range.
 *
 * **Which final belongs to which unit is decided by where it STARTS.** A final's
 * start falls in exactly one unit's range, so the mapping is total and no
 * utterance can be written twice or dropped between two units. Bucketing by end
 * or by overlap would do neither. Finals that begin before the first new unit
 * are already accounted for — by an earlier commit, or by a unit the segmented
 * path owns — and are deliberately not written again.
 *
 * **This is a rule both hosts need and it is temporarily host-local.** It lives
 * here rather than in `@kinqs/brainrouter-core/meetings` only because the
 * desktop's D10 wiring lands separately; D1b means the second host must call
 * this rule rather than write a second one, and this file should move to core
 * the moment it does.
 */
import {
  markDone,
  sealUnit,
  type MeetingCaptureSession,
  type MeetingLiveUtterance,
} from "@kinqs/brainrouter-core/meetings";

/**
 * The session as it is once the proof through `coveredThroughSequence` has been
 * written down. Returns the input unchanged when the proof claims no open audio.
 *
 * The caller persists the result and its checkpoint in ONE write, and only then
 * treats the checkpoint as resume authority — that ordering is the contract's,
 * and it is why this function is pure.
 */
export function commitStreamedCoverage(
  session: MeetingCaptureSession,
  coveredThroughSequence: number,
  utterances: readonly MeetingLiveUtterance[],
): MeetingCaptureSession {
  const before = session.segments.length;
  const sealed = sealUnit(session, { throughSequence: coveredThroughSequence });
  let next = sealed;
  for (let index = before; index < sealed.segments.length; index += 1) {
    const unit = sealed.segments[index]!;
    next = markDone(next, index, utteranceTextFor(unit.startMs, unit.endMs, utterances));
  }
  return next;
}

/**
 * The settled words for one unit's range.
 *
 * Only `final` utterances contribute: a partial is a revision the endpoint may
 * still replace, and writing one into the durable session would put provisional
 * text where D4 promises settled text. Coverage is what says the finals for this
 * range are complete.
 */
function utteranceTextFor(
  startMs: number,
  endMs: number,
  utterances: readonly MeetingLiveUtterance[],
): string {
  const words: string[] = [];
  for (const utterance of utterances) {
    if (utterance.state !== "final" || utterance.startMs < startMs || utterance.startMs >= endMs) continue;
    const text = utterance.text.trim();
    if (text) words.push(text);
  }
  return words.join(" ");
}
