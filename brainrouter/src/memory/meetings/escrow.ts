/**
 * ADR-035 D11 — the data plane behind `/api/meetings/captures` (migration 062).
 *
 * D7 made the local disk the source of truth and the network an accelerator, and D11 says
 * that is wrong for the ONE host whose storage can be taken away from it: in a browser,
 * `navigator.storage.persist()` can be refused and eviction is per-origin, so a long
 * meeting can vanish mid-recording however early anything warned. The remedy is that the
 * bytes leave the machine — this is where they land.
 *
 * **Text, not audio.** What a browser escrows is the transcript and enough of the session
 * to turn it into a meeting. That scope call is argued in `escrow.ts` in core, beside the
 * shape it produces; the consequence here is that this table can never be the reason a
 * deployment needs blob storage.
 *
 * **The server merges nothing.** Unlike notes (ADR-028 D11), a capture has exactly one
 * writer: the tab that is recording it, holding the origin's Web Lock for that session.
 * A second writer is not a conflict to resolve, it is the defect ADR-035 spent four
 * rounds removing. So the newest push wins, and the ONE field the client cannot move is
 * `started_at` — the recording's identity and its retention clock.
 *
 * **The sweep runs on the read.** D6's third deletion trigger has no daemon here on
 * purpose: a cron would be a second schedule to keep honest, and the moment that matters
 * is the one where somebody is about to be shown what the server holds. So every list
 * deletes what has outlived its own window first, and a device that never comes back
 * still has its escrow deleted by the next time its owner opens the page.
 */
import {
  isEscrowWorthKeeping,
  MEETING_ESCROW_MAX_PER_USER,
  normalizeCaptureEscrow,
  type MeetingCaptureEscrow,
  type MeetingCaptureEscrowInput,
} from "@kinqs/brainrouter-core/meetings";

import { memoryEngine } from "../engine.js";
import type { MeetingEscrowRow, UpsertMeetingEscrowInput } from "../store/postgres/queries/meetingEscrowQueries.js";

/**
 * The store surface this needs, as a structural type.
 *
 * Same reason `notes/backend.ts` takes one: the policy is here and testable, and a test
 * does not have to be a database. It is also what keeps this honest about scope — every
 * method takes the org and the user, so there is no call this module could make that
 * reaches a row it was not authorized for.
 */
export interface MeetingEscrowStore {
  upsertMeetingEscrow(orgId: string, userId: string, input: UpsertMeetingEscrowInput): Promise<void>;
  listMeetingEscrow(orgId: string, userId: string, limit: number): Promise<MeetingEscrowRow[]>;
  countMeetingEscrow(orgId: string, userId: string): Promise<number>;
  meetingEscrowExists(orgId: string, userId: string, sessionId: string): Promise<boolean>;
  deleteMeetingEscrow(orgId: string, userId: string, sessionId: string): Promise<boolean>;
  deleteExpiredMeetingEscrow(orgId: string, userId: string): Promise<string[]>;
}

const rootStore = (): MeetingEscrowStore => memoryEngine.store as unknown as MeetingEscrowStore;

/** What a caller gets back: the record, plus when the server last heard from the device. */
export interface MeetingEscrowDTO extends MeetingCaptureEscrow {
  readonly updatedAt: string;
}

export class MeetingEscrowRejected extends Error {}

function toDTO(row: MeetingEscrowRow): MeetingEscrowDTO {
  // Through the SHARED normalizer on the way out as well as on the way in. A row written
  // by an older build, or widened by a later migration, is presented as the shape this
  // version's clients are written against — and a row whose identity cannot be normalized
  // is not returned at all, which `listEscrow` filters.
  const escrow = normalizeCaptureEscrow({
    sessionId: row.sessionId,
    title: row.title,
    template: row.template,
    language: row.language,
    startedAt: row.startedAt,
    transcript: row.transcript,
    coverageMs: row.coverageMs,
    retentionDays: row.retentionDays,
  });
  if (!escrow) throw new MeetingEscrowRejected(`Stored capture ${row.sessionId} is not a readable escrow.`);
  return { ...escrow, updatedAt: row.updatedAt };
}

/**
 * D11 — hold what the device has now.
 *
 * Two refusals, and neither is about content:
 *
 * - a body that is not an escrow (an id that is not a capture session id, a start instant
 *   that cannot be read). Everything else is clamped by the shared normalizer, because a
 *   meeting refused over a long title is a meeting the server declined to hold;
 * - a NEW capture beyond the per-user bound. An existing one is always accepted, however
 *   many there are: refusing an update would strand a recording that is happening right
 *   now, which is precisely the case this path exists for. The bound is on how many
 *   distinct captures one person may have open, not on how much any one of them holds.
 */
export async function putEscrow(
  userId: string,
  orgId: string,
  input: MeetingCaptureEscrowInput,
  store: MeetingEscrowStore = rootStore(),
): Promise<MeetingEscrowDTO> {
  const escrow = normalizeCaptureEscrow(input);
  if (!escrow) throw new MeetingEscrowRejected("A capture needs a session id and a start time.");
  if (!isEscrowWorthKeeping(escrow)) throw new MeetingEscrowRejected("A capture with no transcript cannot be held.");
  if (!(await store.meetingEscrowExists(orgId, userId, escrow.sessionId))) {
    if ((await store.countMeetingEscrow(orgId, userId)) >= MEETING_ESCROW_MAX_PER_USER) {
      throw new MeetingEscrowRejected("Too many unfinished recordings are already held for this workspace.");
    }
  }
  await store.upsertMeetingEscrow(orgId, userId, { ...escrow });
  return { ...escrow, updatedAt: new Date().toISOString() };
}

/**
 * D11 — what the server is holding for this person here, with the expired already gone.
 *
 * The sweep is not best-effort decoration: it is D6's window applied to the copy the user
 * cannot see or delete from their own device, so it runs before the read rather than
 * beside it. Its result is reported, because "we deleted three of your recordings" is a
 * fact and a list that silently got shorter is the retention incident wearing a spinner.
 */
export async function listEscrow(
  userId: string,
  orgId: string,
  store: MeetingEscrowStore = rootStore(),
): Promise<{ captures: MeetingEscrowDTO[]; expired: string[] }> {
  const expired = await store.deleteExpiredMeetingEscrow(orgId, userId);
  const rows = await store.listMeetingEscrow(orgId, userId, MEETING_ESCROW_MAX_PER_USER);
  const captures: MeetingEscrowDTO[] = [];
  for (const row of rows) {
    try {
      captures.push(toDTO(row));
    } catch {
      // A row this build cannot read is left alone rather than deleted: it is somebody's
      // meeting, and the reader is the wrong place to decide that damaged metadata is
      // authority to destroy the words. Its own window still reaps it.
    }
  }
  return { captures, expired };
}

/** D6/D11 — the capture is filed or thrown away, so the server's copy goes with it. */
export async function deleteEscrow(
  userId: string,
  orgId: string,
  sessionId: string,
  store: MeetingEscrowStore = rootStore(),
): Promise<boolean> {
  return store.deleteMeetingEscrow(orgId, userId, sessionId);
}
