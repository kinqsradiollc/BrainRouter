/**
 * ADR-035 D5/D7 + ADR-028 — one sentence saying what the transcription queue is
 * actually doing, so a live panel never has to infer it from a spinner.
 *
 * This module owns the wording and the precedence between the states, and
 * nothing else. It is a pure function of the session, the drain phase and what
 * the panel is showing, which is why it is here and not inside a component: the
 * branch that matters most is the one that fires rarely and is impossible to
 * reach by hand — a segment whose OUTAGE REFUNDS ARE SPENT — and a rule nobody
 * can test is a rule that silently stops holding.
 *
 * It is here rather than in one host for the D1b reason the rest of this
 * subsystem is here. It was written twice: extracted and tested on the
 * dashboard, and left as a private function inside the desktop's meetings view,
 * where it was untested and had ALREADY drifted — the outage sentence read
 * "these segments transcribe when it comes back" on one host and "these
 * segments will transcribe when it comes back" on the other. Two hosts, one
 * promise, two wordings is exactly how the second host becomes the worse one.
 *
 * The precedence, and why it is this way round:
 *
 * 1. **`unavailable`** — the endpoint is not answering right now. It gets the
 *    longest sentence on purpose: it is the state a user is most likely to read
 *    as "my meeting is being lost", and D7's whole point is that it is not.
 * 2. **`closed`** — the audio has been released; nothing more will happen.
 * 3. **Refunds spent** — the queue has stopped waiting for the endpoint on some
 *    segment's behalf (`MEETING_ENDPOINT_UNRESPONSIVE_REASON`). This OUTRANKS
 *    "something is still in flight", because it is precisely the moment a
 *    surface should stop showing a spinner and show the gap. Without this branch
 *    a user is never told that the waiting stopped, which is the ADR-028 failure
 *    this ADR keeps naming: a promise that quietly expired.
 * 4. Anything still provisional is its own explanation, so the note stays empty.
 * 5. Otherwise: waiting to retry, or nothing left to try automatically.
 *
 * The invariant: an empty string means the rows already say it, and is never a
 * "we do not know". Every state a user can be surprised by has a sentence.
 */
import { MEETING_ENDPOINT_UNRESPONSIVE_REASON } from './captureSession.js';
import type { MeetingDrainPhase } from './transcriptionQueue.js';
import type { MeetingCaptureSession } from './types.js';

/**
 * What the panel is currently showing, taken rather than derived so the sentence
 * describes the rows the person is looking at. Both hosts count these off
 * `transcriptSoFar(session)`, which is the only honest source for them.
 */
export interface CapturePhaseCounts {
  /** Segments stated as gaps right now. */
  readonly gaps: number;
  /** Segments still in flight — queued or transcribing. */
  readonly provisional: number;
}

export function capturePhaseNote(
  session: MeetingCaptureSession,
  phase: MeetingDrainPhase | null,
  counts: CapturePhaseCounts,
): string {
  if (phase === 'unavailable') {
    return 'The transcription service is not answering. The audio is saved on this device and these segments will transcribe when it comes back.';
  }
  if (phase === 'closed') return 'This meeting is closed; its audio has been released.';
  if (session.segments.some((segment) => segment.failureReason === MEETING_ENDPOINT_UNRESPONSIVE_REASON)) {
    return 'We have stopped waiting for the transcription service on some segments. The audio is still on this device — retry a gap once the service is back.';
  }
  if (counts.provisional > 0) return '';
  if (phase === 'waiting') return 'Waiting to retry.';
  if (counts.gaps > 0) {
    return 'Nothing left to try automatically — retry a gap to fill it in from the audio still on this device.';
  }
  return '';
}
