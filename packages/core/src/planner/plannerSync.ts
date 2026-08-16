/**
 * ADR-028 D11 — the planner's instantiation of the shared sync engine.
 *
 * The loop itself (pull → merge → push, shed first, never destructive on either
 * side) lives in `sync/recordSync.ts`. What is planner-specific and stays here
 * is exactly one rule: mirrored items are RE-READ rather than merged.
 *
 * That rule is D1, and it is why the split lands where it does. A mirrored item
 * projects something whose truth is elsewhere, so asserting our cached copy
 * might be more correct than the system of record is never right. Notes has no
 * equivalent — every block is owned — so the rule belongs to the planner rather
 * than to the engine.
 */
import type { OutboxOperation } from '../sync/outbox.js';
import { compareHlc, hlcReceive, type Hlc } from '../sync/hybridClock.js';
import {
  isFirstSync, syncRecords,
  type PullResponse as RecordPullResponse, type PushResponse,
  type SyncRecords, type SyncResult,
} from '../sync/recordSync.js';
import { mergeOwnedItem, refreshMirrored, type PlannerItem } from './itemMerge.js';
import type { PlannerState } from './plannerStore.js';
import type { TimeBlock } from './timetable.js';

export { isFirstSync, type PushResponse, type SyncResult };

/** The planner's pull includes time blocks while retaining the item envelope. */
export interface PullResponse extends RecordPullResponse<PlannerItem> {
  /** Optional for compatibility with servers that predate block sync. */
  blocks?: TimeBlock[];
}

export interface PlannerTransport {
  pull(since: string | undefined): Promise<PullResponse>;
  push(operations: readonly OutboxOperation[]): Promise<PushResponse>;
}

export interface PlannerSyncResult extends SyncResult {
  pulledBlocks: number;
}

const PLANNER_RECORDS: SyncRecords<PlannerState, PlannerItem> = {
  idOf: (item) => item.id,
  read: (state, id) => state.items[id],
  write: (state, id, item) => { state.items[id] = item; },
  merge: (local, remote, fetchedAt) => {
    if (remote.origin === 'mirrored') {
      return { value: refreshMirrored(local, remote, fetchedAt), conflicted: false };
    }
    const merged = mergeOwnedItem(local, remote);
    return { value: merged, conflicted: Object.keys(merged.conflicts ?? {}).length > 0 };
  },
  observedClock: newestPlannerItemStamp,
  afterApply: cascadeItemTombstone,
};

/**
 * A deleted item takes its time blocks with it.
 *
 * An item's blocks are not records the server sends — they hang off the item —
 * so a tombstone pulled from another device would otherwise remove the item and
 * leave its blocks sitting on the day, attached to nothing. `updateBlock`
 * refuses to touch a block whose parent is gone, so they would also be
 * unmovable.
 *
 * This ran as part of `applyRemoteItem` until 2026-08-12, and `applyRemoteItem`
 * had no caller: the pull loop goes through `applyRemoteRecord`, which knew
 * nothing about it. It is a `SyncRecords` hook now, so the loop cannot take a
 * path that skips it.
 */
function cascadeItemTombstone(state: PlannerState, remote: PlannerItem): void {
  const deletedAt = state.items[remote.id]?.deletedAt;
  if (!deletedAt) return;
  for (const [blockId, block] of Object.entries(state.blocks)) {
    if (block.itemId !== remote.id) continue;
    const tombstone = block.deletedAt && compareHlc(block.deletedAt, deletedAt) > 0
      ? block.deletedAt
      : deletedAt;
    state.blocks[blockId] = { ...block, updatedAt: tombstone, deletedAt: tombstone };
  }
}

function newestPlannerItemStamp(item: PlannerItem): Hlc | undefined {
  const stamps: Hlc[] = [
    item.title?.at, item.notes?.at, item.dueDate?.at, item.priority?.at,
    item.completed?.at, item.estimateUpdatedAt, item.blockedReason?.at,
    item.deletedAt, item.conflictResolutions?.title, item.conflictResolutions?.notes,
    item.deletionResolution?.at,
    ...Object.values(item.conflicts ?? {}).flatMap((conflict) => [conflict.oursAt, conflict.theirsAt]),
  ].filter((stamp): stamp is Hlc => !!stamp);
  return stamps.sort(compareHlc).at(-1);
}

/*
 * `applyRemoteItem` stood here and was **retired 2026-08-12**. It wrapped
 * `applyRemoteRecord` to add the block-tombstone cascade above, and nothing
 * called it — `syncOnce` reaches `applyRemoteRecord` through `syncRecords`,
 * which had no way to know the wrapper existed. The cascade is a
 * `SyncRecords.afterApply` hook now, so it runs on the path that actually
 * pulls.
 */

function newestLocalBlockStamp(state: PlannerState, blockId: string): Hlc | undefined {
  const blockStamp = state.blocks[blockId]?.updatedAt;
  const queued = state.outbox.operations
    .filter((op) => op.entity === 'block' && op.itemId === blockId)
    .map((op) => op.at)
    .sort(compareHlc)
    .at(-1);
  if (!blockStamp) return queued;
  if (!queued) return blockStamp;
  return compareHlc(queued, blockStamp) > 0 ? queued : blockStamp;
}

/** Merge one pulled block without overwriting a newer queued local move. */
export function applyRemoteBlock(state: PlannerState, remote: TimeBlock): boolean {
  const local = state.blocks[remote.id];
  if (!local) {
    state.blocks[remote.id] = remote;
    return true;
  }
  const localStamp = newestLocalBlockStamp(state, remote.id);
  if (!remote.updatedAt) {
    if (localStamp) return false;
  } else if (localStamp && compareHlc(remote.updatedAt, localStamp) <= 0) {
    return false;
  }
  state.blocks[remote.id] = remote;
  return true;
}

/** One sync cycle. Mutates `state` in place; the caller persists. */
export async function syncOnce(
  state: PlannerState,
  transport: PlannerTransport,
  nowMs: number,
): Promise<PlannerSyncResult> {
  let pulledBlocks = 0;
  const itemTransport = {
    pull: async (since: string | undefined): Promise<RecordPullResponse<PlannerItem>> => {
      const response = await transport.pull(since);
      for (const block of response.blocks ?? []) {
        const observed = block.deletedAt ?? block.updatedAt;
        if (observed) state.clock = hlcReceive(state.clock, observed, nowMs);
        if (applyRemoteBlock(state, block)) pulledBlocks += 1;
      }
      return response;
    },
    push: transport.push,
  };
  const result = await syncRecords(state, itemTransport, PLANNER_RECORDS, nowMs);
  return { ...result, pulledBlocks };
}

/*
 * `describeSync` — `describeRecordSync(result, outbox, 'item')` — was **retired
 * 2026-08-12**. No caller: what both hosts render is `describeSyncState`, which
 * describes the OUTBOX and is what a person looks at between syncs. Notes keeps
 * its own wrapper because its noun differs ("block"); the planner's said
 * "item", which is `describeRecordSync`'s default.
 */
