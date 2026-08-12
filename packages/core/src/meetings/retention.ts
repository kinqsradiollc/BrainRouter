/**
 * ADR-035 D6 — the retention window, and the one rule that decides what has
 * outlived it.
 *
 * ## What it owns
 *
 * The window itself (its default, its bounds, how a stored one is read back),
 * the instant a capture's clock starts from, and the pure set difference that
 * turns "these captures exist" into "these captures may be deleted now".
 * Nothing else: no clock of its own, no filesystem, no opinion about who is
 * recording.
 *
 * ## Why it exists
 *
 * D6 names three ways captured audio stops existing — the meeting is summarized
 * and accepted, the user discards it, "or after a retention window the user can
 * see and set". The first two were built and the third was not, and the shape of
 * that absence is worth stating because it is the failure this ADR keeps
 * returning to: a capture that is never filed is never terminal, so no
 * transition ever fires, so the audio stays on the device for ever. `resumable`
 * goes on offering it, the boot reap deliberately spares it (it HAS a record and
 * it HAS bytes), and the person who recorded a meeting they abandoned has
 * microphone audio on their disk with no expiry and nothing to point at.
 *
 * A default nobody can change is not the decision either. D6 says the window is
 * one the user can SEE and SET, so hosts persist a number and show it; this
 * module is what that number means.
 *
 * ## The invariants
 *
 * 1. **Only the caller knows what is live, and this module never guesses.** Same
 *    boundary as `recovery.ts`: the desktop's per-process writer map and the
 *    browser's Web Lock are the only things that can answer "is somebody
 *    recording into this right now", and a sweep that deleted a capture being
 *    written to would be the loss this ADR exists to end, arriving on a
 *    schedule. So liveness comes in as `exclude` and is subtracted before
 *    anything is named.
 * 2. **A date that cannot be read is not authority to delete.** An unparseable
 *    or absent timestamp answers "not expired". Both hosts already refuse to
 *    turn a damaged record into a deletion (`parseStored` salvages rather than
 *    reaps; `reapOrphans` quarantines a corrupt manifest), and a retention sweep
 *    is the one pass that runs unattended, so it is the last place to start
 *    guessing.
 * 3. **The clock runs from the capture's last durable activity, not from its
 *    start.** A meeting is over when its recording stopped, so `stoppedAt` wins
 *    where it exists. Using `startedAt` alone would age a six-hour recording
 *    from the moment somebody pressed Record.
 * 4. **The window is a bound on UNFILED audio only.** A finalized or discarded
 *    capture has already had its bytes deleted by its transition, so nothing
 *    here needs a status: what reaches a sweep is what no transition ever
 *    claimed.
 */
import type { MeetingCaptureSession } from './types.js';

/**
 * D6 — how long audio nobody filed stays on the device.
 *
 * Thirty days is chosen to be nameable rather than derived: it is long enough
 * that a meeting recorded before a holiday is still there afterwards, and short
 * enough that "we keep your microphone audio" has an end to it. The ADR can
 * print this number, which is the property that matters — an implicit window is
 * the same as no window.
 */
export const MEETING_RETENTION_DEFAULT_DAYS = 30;

/**
 * One day, because same-day deletion of a recording someone made this morning is
 * a foot-gun rather than a preference, and a year, because past that the setting
 * is indistinguishable from "keep for ever" while still costing a sweep.
 */
export const MIN_MEETING_RETENTION_DAYS = 1;
export const MAX_MEETING_RETENTION_DAYS = 365;

/** The choices a surface offers. A list, so both hosts show the same ladder. */
export const MEETING_RETENTION_DAY_CHOICES: readonly number[] = [1, 7, 14, 30, 90, 180, 365];

/**
 * One rung of that ladder, in the units a person picks it in rather than in
 * days.
 *
 * Here rather than in each host for the same reason `describeMeetingRetention`
 * is: the two surfaces are offering ONE policy, and "90 days" on one host beside
 * "3 months" on the other reads as two different settings to the person who has
 * both open. A number that is not on the ladder still prints, in days, because
 * a stored window can be any whole number in range.
 */
export function meetingRetentionChoiceLabel(days: number): string {
  const window = normalizeMeetingRetentionDays(days);
  if (window === 1) return '1 day';
  if (window % 365 === 0) return window === 365 ? '1 year' : `${window / 365} years`;
  if (window % 30 === 0) return window === 30 ? '1 month' : `${window / 30} months`;
  if (window % 7 === 0) return window === 7 ? '1 week' : `${window / 7} weeks`;
  return `${window} days`;
}

const MS_PER_DAY = 86_400_000;

export function isMeetingRetentionDays(value: unknown): value is number {
  return typeof value === 'number'
    && Number.isInteger(value)
    && value >= MIN_MEETING_RETENTION_DAYS
    && value <= MAX_MEETING_RETENTION_DAYS;
}

/**
 * A stored or user-supplied window, read back as a usable one.
 *
 * Out of range CLAMPS and unreadable FALLS BACK, and the split is deliberate: a
 * person who typed 5000 meant "a long time" and gets the longest window this
 * supports, while a torn settings file means nothing at all and gets the
 * default. Clamping junk to the maximum would turn a corrupt byte into a
 * retention policy; defaulting a deliberate 5000 to thirty days would silently
 * delete audio someone asked to keep.
 */
export function normalizeMeetingRetentionDays(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return MEETING_RETENTION_DEFAULT_DAYS;
  const whole = Math.round(value);
  if (whole < MIN_MEETING_RETENTION_DAYS) return MIN_MEETING_RETENTION_DAYS;
  if (whole > MAX_MEETING_RETENTION_DAYS) return MAX_MEETING_RETENTION_DAYS;
  return whole;
}

/**
 * The instant before which an unfiled capture has outlived the window.
 *
 * In epoch milliseconds rather than an ISO string because the comparison is
 * against parsed timestamps, and comparing ISO text would quietly depend on both
 * sides being normalized to the same offset — which a record written by another
 * build is not obliged to be.
 */
export function meetingRetentionCutoffMs(nowMs: number, days: number): number {
  return nowMs - normalizeMeetingRetentionDays(days) * MS_PER_DAY;
}

/**
 * D6 — when a capture's retention clock starts.
 *
 * `stoppedAt` where the recording ended cleanly, `startedAt` otherwise, which is
 * the case §6's destructive test leaves behind: a process killed mid-recording
 * never wrote a stop. Neither is a heartbeat and neither is re-derived from the
 * chunk ledger — a few hours of imprecision against a window measured in days
 * buys nothing, and reading elapsed audio here would make the sweep depend on
 * exactly the ledger a torn record damages.
 */
export function captureRetentionAt(session: MeetingCaptureSession): string {
  return session.stoppedAt ?? session.startedAt;
}

/** One capture as a sweep sees it: a name, and when its clock started. */
export interface RetainedCapture {
  readonly id: string;
  /** ISO 8601. `captureRetentionAt` for a session; the manifest's own stamp for a store that has no session model. */
  readonly at: string;
}

export interface MeetingRetentionSweepOptions {
  /** Epoch milliseconds. Taken by the caller so a test can state the day. */
  readonly nowMs: number;
  readonly days: number;
  /**
   * Captures no sweep may touch, whatever their age — invariant 1. In practice
   * the ones a host says are being written to right now, plus any reserved
   * record that is not a meeting at all (the dashboard keeps its compose draft
   * and its own retention setting in the capture store).
   */
  readonly exclude?: readonly string[];
}

/**
 * The captures that have outlived the window, in the order they were given.
 *
 * A pure set difference, and a deliberately small one: everything that makes
 * this decision dangerous — which captures are live, which records are not
 * meetings, whether the delete succeeded — belongs to the host, and this returns
 * names rather than performing anything.
 */
export function expiredCaptureIds(
  captures: readonly RetainedCapture[],
  options: MeetingRetentionSweepOptions,
): readonly string[] {
  const cutoff = meetingRetentionCutoffMs(options.nowMs, options.days);
  const excluded = new Set(options.exclude ?? []);
  const expired: string[] = [];
  for (const capture of captures) {
    if (excluded.has(capture.id)) continue;
    const at = Date.parse(capture.at);
    // Invariant 2. `NaN` fails this comparison, which is the answer we want, but
    // it is checked out loud rather than left to the operator: a reader has to
    // be able to see that a record with no readable date survives the sweep.
    if (!Number.isFinite(at)) continue;
    if (at < cutoff) expired.push(capture.id);
  }
  return expired;
}

/**
 * D6 — the window, in the words a surface prints beside the control.
 *
 * Here rather than in each host because it is the SENTENCE that has to agree:
 * the desktop and the dashboard delete on the same rule, and two independently
 * worded descriptions of one policy is how they come to describe two.
 */
export function describeMeetingRetention(days: number): string {
  const window = normalizeMeetingRetentionDays(days);
  const period = window === 1 ? 'a day' : window === 365 ? 'a year' : `${window} days`;
  return `Recordings you have not turned into a meeting or discarded are deleted ${period} after they were made.`;
}
