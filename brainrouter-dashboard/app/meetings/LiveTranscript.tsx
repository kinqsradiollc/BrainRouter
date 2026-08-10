"use client";

/**
 * ADR-035 D4/D5 — the transcript while the meeting is still happening, and what
 * it says about the parts it does not have.
 *
 * §1.1's fourth failure is that "nothing is visible until the end": no text
 * exists during the meeting, so a user cannot correct a name, cannot see the mic
 * is on the wrong device, cannot tell whether it is working at all. The first
 * evidence arrives after the only moment it could have been fixed. This panel is
 * that evidence.
 *
 * Two rules it exists to keep, both from ADR-028's "the surface says which state
 * it is in":
 *
 * - **Provisional is not settled.** A segment in flight is visibly not text yet,
 *   and "queued because the endpoint is down" (D7) reads differently from
 *   "transcribing right now" — the shared model keeps those states apart, so the
 *   surface does too rather than showing one spinner for both.
 * - **A gap is a fact, not an omission.** D5: a failed segment stays in the
 *   transcript with its time range and a retry control. "Transcribing…" on a
 *   segment that failed twenty minutes ago is the failure this ADR is trying to
 *   end, wearing a spinner.
 *
 * It renders `transcriptSoFar` and nothing derived: the shared selector already
 * guarantees one entry per segment, always, so no segment can fall out of this
 * list by a filter someone wrote here.
 */
import {
  capturePhaseNote,
  formatCaptureTimestamp,
  transcriptSoFar,
  type MeetingCaptureSession,
  type MeetingDrainPhase,
} from "@kinqs/brainrouter-core/meetings";

import styles from "./meetings.module.css";

export interface LiveTranscriptProps {
  readonly session: MeetingCaptureSession;
  /** Why the queue last stopped, or null before it has run. */
  readonly phase: MeetingDrainPhase | null;
  /** Segment currently being retried by hand, so its control can say so. */
  readonly retrying: number | null;
  readonly onRetry: (index: number) => void;
}

export function LiveTranscript({ session, phase, retrying, onRetry }: LiveTranscriptProps) {
  const entries = transcriptSoFar(session);
  const settled = entries.filter((entry) => entry.kind === "settled").length;
  const provisional = entries.filter((entry) => entry.kind === "provisional").length;
  const gaps = entries.filter((entry) => entry.kind === "gap").length;
  // The wording and the precedence between the states are the SHARED
  // `capturePhase`'s, not this component's and no longer this host's: the branch
  // that matters most — the queue having stopped waiting for the endpoint on a
  // segment's behalf — is one no render test can reach by hand, and while the
  // rule lived once here and once in the desktop's meetings view the two had
  // already drifted a word apart in the outage sentence.
  const note = capturePhaseNote(session, phase, { gaps, provisional });

  return (
    <div className={styles.linkzone}>
      <div className={styles.liveHead}>
        <span className={styles.teamPickH}>Live transcript</span>
        <span className={styles.liveCounts}>
          {settled} transcribed{provisional ? ` · ${provisional} in progress` : ""}{gaps ? ` · ${gaps} gap${gaps === 1 ? "" : "s"}` : ""}
        </span>
      </div>
      {entries.length === 0 ? (
        <div className={styles.liveEmpty}>Audio is being saved to this device. Text appears as each segment transcribes.</div>
      ) : (
        <div className={styles.liveRows} role="list" aria-label="Live transcript segments">
          {entries.map((entry) => (
            <div key={entry.index} className={styles.liveRow} role="listitem">
              <span className={styles.liveTime}>{formatCaptureTimestamp(entry.startMs)}</span>
              {entry.kind === "settled" ? (
                <span className={styles.liveText}>{entry.text || "(silence)"}</span>
              ) : entry.kind === "provisional" ? (
                <span className={styles.liveProvisional}>
                  {entry.state === "transcribing" ? "Transcribing…" : "Queued"}
                </span>
              ) : (
                <span className={styles.liveGap}>
                  <b>{entry.text}</b>
                  {entry.failureReason ? <small>{entry.failureReason}</small> : null}
                  <button
                    type="button"
                    className={styles.track}
                    disabled={retrying !== null}
                    onClick={() => onRetry(entry.index)}
                  >
                    {retrying === entry.index ? "Retrying…" : "Retry this segment"}
                  </button>
                </span>
              )}
            </div>
          ))}
        </div>
      )}
      {note ? <div className={styles.teamPickNote}>{note}</div> : null}
    </div>
  );
}
