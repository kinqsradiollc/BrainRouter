/**
 * ADR-035 D6 — the retention window in the BROWSER: where the number is kept,
 * and the sweep that makes it a deletion rather than a preference.
 *
 * The rule itself is shared (`retention.ts` in core) because the desktop and
 * this host must age a capture by the same clause. What is host-specific is the
 * two things underneath it: where a number lives on an origin that has no
 * settings file, and what "delete it" means over a store whose backend is OPFS
 * or IndexedDB.
 *
 * **The number lives in the capture store, beside the audio it governs.** The
 * same argument `meetingDraft.ts` makes, and it lands harder here: this is the
 * module that already owns quota, serialization and deletion for this origin's
 * meeting data, and a policy kept in `localStorage` would be a policy any page
 * script could rewrite — the setting that decides when a microphone recording is
 * deleted is the last one to leave somewhere enumerable. It is a manifest
 * payload under a reserved id, exactly as the draft is, and it inherits the
 * draft's two properties: it can never be offered back as a meeting (it holds no
 * chunks, and `isResumableSession` requires audio), and the reap CAN take it, so
 * every caller of `reapOrphans` has to refuse the reserved ids — which is why
 * they are exported as a set rather than named one at a time.
 *
 * **The sweep asks the browser twice.** Liveness is `navigator.locks`, the same
 * answer the offer, the discard and the reap take, and it is asked again
 * immediately before each delete rather than trusted from the listing: reading
 * every record on the origin is not instant, and a Record pressed while this
 * pass was reading is exactly the capture whose chunks must not disappear
 * underneath its recorder. A browser that cannot answer at all (no Web Locks —
 * golden rule 23's case) deletes NOTHING, for the same reason D6a gives: an
 * unattended pass is the last place to guess about a live recording.
 */
import {
  captureRetentionAt,
  expiredCaptureIds,
  MEETING_RETENTION_DEFAULT_DAYS,
  normalizeMeetingRetentionDays,
} from "@kinqs/brainrouter-core/meetings";

import { parseCapturePayload } from "./capturePayload";
import type { CaptureSessionRecord, MeetingCaptureStore } from "./captureStore";
import { MEETING_DRAFT_CAPTURE_ID } from "./meetingDraft";

/**
 * The reserved capture id the window is stored under.
 *
 * Named the same way the draft's is, and for the same reason: it has to be
 * recognisable in a store listing as an entry that is not a meeting.
 */
export const MEETING_RETENTION_CAPTURE_ID = "brainrouter-meeting-retention";

/**
 * Every id in this origin's capture listing that is NOT a recording.
 *
 * Exported as one list because the two failure modes are symmetrical and both
 * are silent: a pass that treats these as meetings deletes the person's compose
 * draft and resets their retention window, and a pass that forgets one of them
 * leaves it behind for ever. Any caller of `reapOrphans` or of the sweep below
 * has to say the same thing, so there is one place to say it.
 */
export const RESERVED_CAPTURE_IDS: readonly string[] = [MEETING_DRAFT_CAPTURE_ID, MEETING_RETENTION_CAPTURE_ID];

export function isReservedCaptureId(sessionId: string): boolean {
  return RESERVED_CAPTURE_IDS.includes(sessionId);
}

/**
 * A stored window, read back as a usable one.
 *
 * Never throws: a torn payload yields the shared default, because a settings
 * record we cannot parse must not be able to stop the Meetings page rendering —
 * and must not be read as "delete everything", which is what a zero would mean.
 */
export function parseCaptureRetention(text: string): number {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text || "{}");
  } catch {
    return MEETING_RETENTION_DEFAULT_DAYS;
  }
  if (!parsed || typeof parsed !== "object") return MEETING_RETENTION_DEFAULT_DAYS;
  return normalizeMeetingRetentionDays((parsed as { days?: unknown }).days);
}

export async function readCaptureRetentionDays(store: MeetingCaptureStore): Promise<number> {
  const record = await store.read(MEETING_RETENTION_CAPTURE_ID);
  return record ? parseCaptureRetention(record.payload) : MEETING_RETENTION_DEFAULT_DAYS;
}

/**
 * Write the window, creating its record the first time.
 *
 * The same `setPayload`-then-`begin`-then-`setPayload` dance the draft uses, and
 * for the same reason: `setPayload` refuses a session that does not exist,
 * `begin` refuses one that does, and two saves can reach `begin` together.
 * Returns what was actually stored, which is the normalized number rather than
 * the one that was asked for.
 */
export async function writeCaptureRetentionDays(store: MeetingCaptureStore, days: number): Promise<number> {
  const stored = normalizeMeetingRetentionDays(days);
  const payload = JSON.stringify({ version: 1, days: stored });
  try {
    await store.setPayload(MEETING_RETENTION_CAPTURE_ID, payload);
    return stored;
  } catch {
    // No record yet — the ordinary first save.
  }
  try {
    await store.begin({ sessionId: MEETING_RETENTION_CAPTURE_ID, payload });
  } catch {
    await store.setPayload(MEETING_RETENTION_CAPTURE_ID, payload);
  }
  return stored;
}

/**
 * D6 — when one stored capture's retention clock started.
 *
 * The session's own answer where the payload can be read (`stoppedAt` first, so
 * a six-hour recording is not aged from the moment Record was pressed), and the
 * manifest's stamp where it cannot. The fallback is deliberately not "skip it":
 * a capture whose payload is unreadable is precisely the one no transition will
 * ever claim, and leaving it unaged would keep microphone audio on the device
 * for ever because its metadata is damaged.
 */
export function captureRetentionStamp(record: CaptureSessionRecord): string {
  const session = parseCapturePayload(record.payload).session;
  return session ? captureRetentionAt(session) : record.startedAt;
}

export interface CaptureRetentionSweep {
  /** Epoch milliseconds — the surface's clock port, so a test can state the day. */
  readonly nowMs: number;
  readonly days: number;
  /**
   * Asked again immediately before each delete. `true` spares the capture.
   *
   * A predicate rather than a list because that is the difference between this
   * and a guess: the listing is already stale by the time the first delete
   * happens, and this is the pass that runs without anybody watching.
   */
  readonly writing: (sessionId: string) => Promise<boolean>;
  /** Captures the caller holds itself — the one fact the browser cannot report. */
  readonly keep?: readonly string[];
}

/**
 * D6 — delete the captures that have outlived the window, and say which.
 *
 * Takes the listing the caller already has rather than making its own: the one
 * caller is the recovery refresh, which reads the store immediately before this
 * runs, and a second full listing would double the work on exactly the path that
 * renders the offer. Freshness is bought back where it matters — at the delete,
 * from `writing`.
 *
 * The delete is `store.delete`, which is the same call an explicit discard makes
 * for a capture no queue holds: manifest and every chunk, not a flag. D6 asks
 * for a real deletion, and a second, softer one would be the retention incident
 * this decision exists to prevent.
 */
export async function sweepExpiredCaptures(
  store: MeetingCaptureStore,
  records: readonly CaptureSessionRecord[],
  sweep: CaptureRetentionSweep,
): Promise<readonly string[]> {
  const expired = expiredCaptureIds(
    records
      .filter((record) => !isReservedCaptureId(record.sessionId))
      .map((record) => ({ id: record.sessionId, at: captureRetentionStamp(record) })),
    { nowMs: sweep.nowMs, days: sweep.days, exclude: sweep.keep ?? [] },
  );
  const deleted: string[] = [];
  for (const sessionId of expired) {
    if (await sweep.writing(sessionId)) continue;
    await store.delete(sessionId);
    deleted.push(sessionId);
  }
  return deleted;
}
