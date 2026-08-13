/**
 * ADR-035 D11 — what the SERVER holds for a browser recording that is still
 * being made, and the bounds on it.
 *
 * ## What it owns
 *
 * One record shape and one normalizer. The record is a capture as the server
 * keeps it: which session, whose workspace, what has been transcribed so far,
 * and how much of the audio that text covers. The normalizer is the single place
 * that decides whether a claimed escrow is well-formed, and it is shared because
 * both ends of the wire have to agree — the browser builds one, the route
 * accepts one, and two independent validators is how a client comes to send a
 * field a server silently drops.
 *
 * ## Why the server holds text and not audio
 *
 * D11's problem is that `navigator.storage.persist()` can be refused and
 * eviction is per-origin, so the browser's copy can be taken away mid-meeting.
 * Its remedy is "the bytes leave the machine". The bytes that leave are the
 * TRANSCRIPT, and that is a deliberate scope call rather than a shortcut:
 *
 * - The transcript is what a meeting IS on this product. `POST /api/meetings`
 *   takes a title and a transcript; audio is the means, and D8's paste path
 *   makes a meeting with no audio at all. A recovered escrow can therefore
 *   become a real meeting, which is what §6 asks for.
 * - The audio is already leaving the machine for transcription — every segment
 *   is posted to the STT endpoint, and D10's stream sends the chunks live. What
 *   was missing was never the transit; it was that nothing kept the RESULT.
 * - Retaining raw microphone audio server-side is a different decision with its
 *   own answers to settle (where the blobs live, who may read them, what an
 *   org's retention of other people's voices is). ADR-035 §6 judges D11 on
 *   whether the MEETING survives a refused persistence, not on whether the
 *   waveform does, and inventing that storage to satisfy a test it does not ask
 *   for would be the larger surface making the smaller claim.
 *
 * What is lost when an origin is evicted mid-meeting is therefore bounded and
 * nameable: the audio, and the tail that had not been transcribed yet. Not the
 * meeting.
 *
 * ## The bounds are here, not at the route
 *
 * A transcript is unbounded user text arriving on a path that writes to a
 * database on every settled segment, so a cap belongs in the shared rule where
 * the client can see the same number it will be held to. Truncation is
 * `MEETING_ESCROW_MAX_TRANSCRIPT_CHARS` from the START — the beginning of a
 * meeting is the part nothing else can reconstruct, since the tail is still on
 * the device that is recording it.
 */
import { normalizeMeetingRetentionDays } from './retention.js';
import { isMeetingSessionId } from './captureSession.js';
import type { MeetingCaptureTemplate } from './types.js';

/**
 * The most transcript one escrowed capture may hold.
 *
 * Roughly twelve hours of speech at conversational density, so it is not a limit
 * anybody meets in a meeting; it is the bound that stops a broken client, or a
 * deliberate one, from using this path as storage. A capture that reaches it
 * keeps its beginning.
 */
export const MEETING_ESCROW_MAX_TRANSCRIPT_CHARS = 400_000;

/** The most title a record carries — the same order as a meeting's own. */
export const MEETING_ESCROW_MAX_TITLE_CHARS = 300;

/** How many open captures one person may have escrowed in one workspace. */
export const MEETING_ESCROW_MAX_PER_USER = 50;

const TEMPLATES: readonly MeetingCaptureTemplate[] = ['general', 'standup', 'one-on-one', 'retrospective'];

/**
 * A capture the server is holding on a browser's behalf.
 *
 * `coverageMs` is how much of the recording the text accounts for, not how long
 * the recording is: the difference is exactly what an eviction would cost, and
 * it is carried so the surface can say so rather than implying the escrow is the
 * whole meeting.
 */
export interface MeetingCaptureEscrow {
  readonly sessionId: string;
  readonly title: string;
  readonly template: MeetingCaptureTemplate;
  /** BCP-47, or `""` for auto-detect — the compose box's own value. */
  readonly language: string;
  readonly startedAt: string;
  readonly transcript: string;
  readonly coverageMs: number;
  /** D6 — the window this capture is kept under, chosen by the person who made it. */
  readonly retentionDays: number;
}

/** What a caller may hand in: the same fields, unvalidated. */
export interface MeetingCaptureEscrowInput {
  readonly sessionId?: unknown;
  readonly title?: unknown;
  readonly template?: unknown;
  readonly language?: unknown;
  readonly startedAt?: unknown;
  readonly transcript?: unknown;
  readonly coverageMs?: unknown;
  readonly retentionDays?: unknown;
}

/**
 * D11 — a claimed escrow as a stored one, or `null` when it is not one.
 *
 * `null` for exactly two things, and both are identity rather than content: an
 * id that is not a capture session id, and a start instant that cannot be read.
 * Everything else is CLAMPED, because the alternative is worse in the direction
 * that matters — a meeting refused for a 301-character title is a meeting the
 * server declined to hold, and this is the path whose entire purpose is holding
 * one. A record with a trimmed title is still the meeting.
 */
export function normalizeCaptureEscrow(input: MeetingCaptureEscrowInput): MeetingCaptureEscrow | null {
  const sessionId = typeof input.sessionId === 'string' ? input.sessionId : '';
  if (!isMeetingSessionId(sessionId)) return null;
  const startedAt = typeof input.startedAt === 'string' ? input.startedAt : '';
  if (!Number.isFinite(Date.parse(startedAt))) return null;
  const transcript = typeof input.transcript === 'string' ? input.transcript : '';
  const title = typeof input.title === 'string' ? input.title.trim() : '';
  const template = TEMPLATES.find((known) => known === input.template) ?? 'general';
  const coverage = typeof input.coverageMs === 'number' && Number.isFinite(input.coverageMs) ? Math.max(0, Math.floor(input.coverageMs)) : 0;
  return {
    sessionId,
    title: title.slice(0, MEETING_ESCROW_MAX_TITLE_CHARS),
    template,
    language: typeof input.language === 'string' ? input.language.slice(0, 32) : '',
    startedAt: new Date(startedAt).toISOString(),
    transcript: transcript.slice(0, MEETING_ESCROW_MAX_TRANSCRIPT_CHARS),
    coverageMs: coverage,
    retentionDays: normalizeMeetingRetentionDays(input.retentionDays),
  };
}

/**
 * Whether an escrowed capture is worth keeping at all.
 *
 * A record with no words in it is a session id and a timestamp: it can never be
 * turned into a meeting (`POST /api/meetings` requires a transcript), so holding
 * it would be retaining somebody's meeting metadata on the server for nothing.
 * Checked by the WRITER, so an escrow that has not produced text yet is never
 * created rather than created and swept later.
 */
export function isEscrowWorthKeeping(escrow: MeetingCaptureEscrow): boolean {
  return escrow.transcript.trim().length > 0;
}
