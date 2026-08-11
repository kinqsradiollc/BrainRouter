/**
 * ADR-029 B3 — offline is the same offline.
 *
 * There is no sync loop in this file, and that is the point. The pull → merge →
 * push cycle, the shed-before-anything-else rule, the first-sync-never-deletes
 * property and the rejected-not-dropped property all live in
 * `sync/recordSync.ts` and are shared with the planner. Two sync systems in one
 * product will disagree, and the disagreement surfaces as one surface showing
 * stale data while the other shows fresh — indistinguishable from a bug in
 * whichever one you happen to be looking at.
 *
 * What Notes supplies is where its records live and how two versions of one
 * merge. Everything else is the planner's, unchanged.
 *
 * **Leases do not travel through here.** They are coordination, not content, so
 * they are not in the pulled record and not in the merge. A lease merged by
 * last-writer-wins would hand the lock to whichever device has the faster
 * clock, regardless of who was refused it — which inverts the failure B2 exists
 * to prevent. The lock's authority crosses the wire as the epoch stamped on
 * each write, which the server checks; that is the fence.
 */
import type { OutboxState } from '../sync/outbox.js';
import {
  applyRemoteRecord, describeRecordSync, isFirstSync, syncRecords,
  type PullResponse as RecordPullResponse, type PushResponse,
  type SyncRecords, type SyncResult, type SyncTransport,
} from '../sync/recordSync.js';
import type { NoteBlock } from './block.js';
import { blockWrittenAt, mergeNoteBlock } from './blockMerge.js';
import type { NotesState } from './noteStore.js';

export { isFirstSync, type PushResponse, type SyncResult };

export type NotesPullResponse = RecordPullResponse<NoteBlock>;
export type NotesTransport = SyncTransport<NoteBlock>;

const NOTE_RECORDS: SyncRecords<NotesState, NoteBlock> = {
  idOf: (block) => block.id,
  read: (state, id) => state.blocks[id],
  write: (state, id, block) => { state.blocks[id] = block; },
  merge: (local, remote) => {
    const merged = mergeNoteBlock(local, remote);
    return { value: merged, conflicted: Object.keys(merged.conflicts ?? {}).length > 0 };
  },
  observedClock: blockWrittenAt,
};

/** Merge one server block into local state. */
export function applyRemoteBlock(
  state: NotesState,
  remote: NoteBlock,
  fetchedAt: string,
): { conflicted: boolean } {
  return applyRemoteRecord(state, remote, fetchedAt, NOTE_RECORDS);
}

/** One sync cycle. Mutates `state` in place; the caller persists. */
export async function syncNotesOnce(
  state: NotesState,
  transport: NotesTransport,
  nowMs: number,
): Promise<SyncResult> {
  return syncRecords(state, transport, NOTE_RECORDS, nowMs);
}

/** The same sentence structure the planner uses, naming what the reader sees. */
export function describeNotesSync(result: SyncResult, outbox: OutboxState): string {
  return describeRecordSync(result, outbox, 'block');
}
