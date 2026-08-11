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
 *
 * **D10 adds a third state above those two, and it is the one §1.1's fourth
 * failure was really about.** A streaming endpoint sends words while the
 * sentence is still being said, long before any of it is a settled unit on this
 * device — so those utterances are rendered here, after the segments they
 * follow, and rendered as what they are. A partial is a revision the endpoint
 * may replace; an upstream final is words this device has not saved yet. Neither
 * wears `.liveText`, which is reserved for text that has settled, and neither is
 * ever the compose box: `captureSurface.ts` puts words there only once a
 * coverage proof has been persisted, which is what keeps a late revision away
 * from a line somebody has edited (D4).
 *
 * **And which path is running is stated, always** (golden rule 23). A segmented
 * transcript on a server that offers no stream is a perfectly good transcript;
 * one that fell back mid-meeting because the connection died is a fact the
 * person can act on. Silence would make the two look identical.
 */
import {
  capturePhaseNote,
  formatCaptureTimestamp,
  transcriptSoFar,
  type MeetingCaptureSession,
  type MeetingDrainPhase,
  type MeetingLiveUtterance,
  type MeetingTranscriptionMode,
} from "@kinqs/brainrouter-core/meetings";

import styles from "./meetings.module.css";

export interface LiveTranscriptProps {
  readonly session: MeetingCaptureSession;
  /** Why the queue last stopped, or null before it has run. */
  readonly phase: MeetingDrainPhase | null;
  /** Segment currently being retried by hand, so its control can say so. */
  readonly retrying: number | null;
  /** D10 — utterances the endpoint has sent that this device has not settled yet. */
  readonly live: readonly MeetingLiveUtterance[];
  /** D10 — the strategy actually running right now, not the one advertised. */
  readonly mode: MeetingTranscriptionMode;
  /** Golden rule 23 — why the live path is not running, or "" when it is. */
  readonly notice: string;
  readonly onRetry: (index: number) => void;
}

export function LiveTranscript({ session, phase, retrying, live, mode, notice, onRetry }: LiveTranscriptProps) {
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
          {settled} transcribed{provisional ? ` · ${provisional} in progress` : ""}{gaps ? ` · ${gaps} gap${gaps === 1 ? "" : "s"}` : ""}{live.length ? ` · ${live.length} live` : ""}
        </span>
      </div>
      {entries.length === 0 && live.length === 0 ? (
        <div className={styles.liveEmpty}>
          {mode === "streaming"
            ? "Audio is being saved to this device. Text appears as you speak."
            : "Audio is being saved to this device. Text appears as each segment transcribes."}
        </div>
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
          {/* D10 — after the segments, because that is where in the meeting they
              are. `startMs` is the endpoint's own timeline over the durability
              ledger, so a live row sits where the audio it describes sits. */}
          {live.map((utterance) => (
            <div
              key={utterance.utteranceId}
              className={styles.liveRow}
              role="listitem"
              aria-live={utterance.state === "partial" ? "polite" : "off"}
            >
              <span className={styles.liveTime}>{formatCaptureTimestamp(utterance.startMs)}</span>
              <span className={`${styles.liveUtterance} ${utterance.state === "final" ? styles.liveSettling : ""}`}>
                <span>{utterance.text || "…"}</span>
                <small>{utterance.state === "partial" ? "still being said" : "not saved to this device yet"}</small>
              </span>
            </div>
          ))}
        </div>
      )}
      {note ? <div className={styles.teamPickNote}>{note}</div> : null}
      {/* Golden rule 23 — which path is running, and why the better one is not.
          `mode` is what IS running rather than what was offered, so a stream that
          dropped mid-meeting stops claiming live text in the same instant. */}
      {mode === "streaming" ? (
        <div className={styles.teamPickNote} role="status">
          Live transcription is running — text appears while you speak, and settles once this device has saved it.
        </div>
      ) : notice ? (
        <div className={styles.teamPickNote} role="status">{notice}</div>
      ) : null}
    </div>
  );
}
