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
import type { OutboxState } from '../sync/outbox.js';
import {
  applyRemoteRecord, describeRecordSync, isFirstSync, syncRecords,
  type PullResponse as RecordPullResponse, type PushResponse,
  type SyncRecords, type SyncResult, type SyncTransport,
} from '../sync/recordSync.js';
import { mergeOwnedItem, refreshMirrored, type PlannerItem } from './itemMerge.js';
import type { PlannerState } from './plannerStore.js';

export { isFirstSync, type PushResponse, type SyncResult };

/** The planner's shape of the shared pull response. */
export type PullResponse = RecordPullResponse<PlannerItem>;
export type PlannerTransport = SyncTransport<PlannerItem>;

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
};

/** Merge one server item into local state. */
export function applyRemoteItem(
  state: PlannerState,
  remote: PlannerItem,
  fetchedAt: string,
): { conflicted: boolean } {
  return applyRemoteRecord(state, remote, fetchedAt, PLANNER_RECORDS);
}

/** One sync cycle. Mutates `state` in place; the caller persists. */
export async function syncOnce(
  state: PlannerState,
  transport: PlannerTransport,
  nowMs: number,
): Promise<SyncResult> {
  return syncRecords(state, transport, PLANNER_RECORDS, nowMs);
}

export function describeSync(result: SyncResult, outbox: OutboxState): string {
  return describeRecordSync(result, outbox, 'item');
}
