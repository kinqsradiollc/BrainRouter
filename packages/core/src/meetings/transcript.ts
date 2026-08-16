/**
 * ADR-035 D4/D5 — the transcript so far, including the parts that are missing.
 *
 * This is the selector both surfaces read. It exists because the interesting
 * question is not "what text do we have" — a `map(...).join(' ')` answers that —
 * but "what does the transcript say about what it does NOT have".
 *
 * D5 settles it: a segment that could not be transcribed stays in the transcript
 * as a gap carrying its time range, never as an omission. So this module emits
 * one entry per segment, always, and the only way for a segment to vanish from
 * the output is for it to vanish from the session. A transcript with an unmarked
 * hole is quietly wrong; `00:12:30–00:13:00 could not be transcribed` is a fact
 * a person can act on.
 *
 * D4's provisional/settled split is carried on the entry rather than resolved
 * here, because the two surfaces render it differently and neither should have
 * to re-derive which segments are still in flight.
 */
import type { MeetingCaptureSession, MeetingSegment, MeetingSegmentState } from './types.js';

/**
 * D4 — what the surface is looking at.
 *
 * `settled` is transcribed and persisted (safe to edit); `provisional` is still
 * in flight (do not let a user edit what is about to be replaced); `gap` is D5's
 * stated absence.
 */
export type MeetingTranscriptEntryKind = 'settled' | 'provisional' | 'gap';

export interface MeetingTranscriptEntry {
  readonly index: number;
  readonly startMs: number;
  readonly endMs: number;
  readonly kind: MeetingTranscriptEntryKind;
  /** The raw segment state, so a surface can say "queued" and "transcribing" differently (ADR-028). */
  readonly state: MeetingSegmentState;
  /** Transcribed text for `settled`, the gap marker for `gap`, empty for `provisional`. */
  readonly text: string;
  readonly failureReason?: string;
  readonly attempts?: number;
}

/** The wording D5 uses, kept in one place so both hosts and any export agree. */
export const MEETING_GAP_PHRASE = 'could not be transcribed';

/** `hh:mm:ss` for a gap marker. Hours are always shown so ranges sort and align as text. */
export function formatCaptureTimestamp(elapsedMs: number): string {
  const totalSeconds = Math.max(0, Math.floor(elapsedMs / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  return [hours, minutes, seconds].map((part) => String(part).padStart(2, '0')).join(':');
}

/** The exact sentence D5 asks a transcript to contain in place of a hole. */
export function formatCaptureGap(startMs: number, endMs: number): string {
  return `[${formatCaptureTimestamp(startMs)}–${formatCaptureTimestamp(endMs)} ${MEETING_GAP_PHRASE}]`;
}

/**
 * One entry per segment, in capture order — the transcript so far.
 *
 * Length always equals `session.segments.length`. That equality is the whole
 * guarantee: a failed segment cannot be filtered out of a transcript by a caller
 * who forgot it existed, because there is no state in which this function omits
 * one.
 */
export function transcriptSoFar(session: MeetingCaptureSession): readonly MeetingTranscriptEntry[] {
  return session.segments.map(toEntry);
}

export interface TranscriptTextOptions {
  /**
   * Join with this between entries. A newline keeps gap markers on their own
   * line, which is what makes them survive being pasted somewhere else.
   */
  readonly separator?: string;
  /**
   * Drop gap markers. Off by default and named honestly: a caller that sets it
   * is choosing a transcript that does not say what is missing, and D5 says that
   * choice is worse than the alternative.
   */
  readonly omitGaps?: boolean;
}

/**
 * The transcript as text, with gaps stated.
 *
 * Provisional segments contribute nothing — they have no text yet, and inventing
 * a placeholder for them would put "…" into an exported document. Their absence
 * here is not the D5 failure: they are still coming, and `transcriptSoFar`
 * reports them.
 */
export function transcriptText(session: MeetingCaptureSession, options: TranscriptTextOptions = {}): string {
  const separator = options.separator ?? '\n';
  return transcriptSoFar(session)
    .filter((entry) => (entry.kind === 'gap' ? !options.omitGaps : entry.kind === 'settled'))
    .map((entry) => entry.text)
    .filter((text) => text.length > 0)
    .join(separator);
}

/** D5's retry affordance needs the gaps; the surface should not re-filter for them. */
export function transcriptGaps(session: MeetingCaptureSession): readonly MeetingTranscriptEntry[] {
  return transcriptSoFar(session).filter((entry) => entry.kind === 'gap');
}

function toEntry(segment: MeetingSegment): MeetingTranscriptEntry {
  const base = {
    index: segment.index,
    startMs: segment.startMs,
    endMs: segment.endMs,
    state: segment.state,
  };
  if (segment.state === 'done') {
    return { ...base, kind: 'settled', text: segment.text ?? '' };
  }
  if (segment.state === 'failed') {
    return {
      ...base,
      kind: 'gap',
      text: formatCaptureGap(segment.startMs, segment.endMs),
      failureReason: segment.failureReason,
      attempts: segment.attempts,
    };
  }
  return { ...base, kind: 'provisional', text: '', attempts: segment.attempts };
}
