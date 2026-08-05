/**
 * ADR-028 D11 — sync, pull-then-push, never destructive on either side.
 *
 * The order is the design. Pulling first means a push can never overwrite
 * something it has not seen; pushing first would let a device that has been
 * offline for a week clobber a week of other devices' work simply by being the
 * one that spoke last.
 *
 * Three properties this must never violate, because each destroys data:
 *
 *  1. **A first sync never deletes.** An empty local cache meeting a populated
 *     server is a NEW DEVICE, not a mass deletion — and the reverse is a fresh
 *     account, not a signal to wipe the device. Deletions travel only as
 *     tombstones carrying stamps.
 *  2. **The server merges too.** A client that is behind must not win by
 *     pushing last, so the server applies D4 against its own state rather than
 *     accepting a payload wholesale. This module is the client half; the
 *     contract is symmetric on purpose.
 *  3. **A rejected operation is returned, not dropped.** It stays in the outbox
 *     and surfaces after enough attempts, rather than retrying invisibly
 *     forever.
 */
import { hlcReceive, type Hlc } from './hybridClock.js';
import { mergeOwnedItem, refreshMirrored, type PlannerItem } from './itemMerge.js';
import {
  acknowledge, nextBatch, recordFailure, shed, stuckOperations,
  type OutboxOperation, type OutboxState,
} from './outbox.js';
import type { PlannerState } from './plannerStore.js';

export interface PullResponse {
  /** Items changed on the server since `since`. */
  items: PlannerItem[];
  /** The server's cursor to send on the next pull. */
  cursor: string;
  /** The server's clock, so this device can absorb it (D3). */
  serverClock?: Hlc;
}

export interface PushResponse {
  /** Idempotency keys the server applied. */
  accepted: string[];
  /** Keys the server refused, with a reason the human can read. */
  rejected: Array<{ idempotencyKey: string; reason: string }>;
}

export interface PlannerTransport {
  pull(since: string | undefined): Promise<PullResponse>;
  push(operations: readonly OutboxOperation[]): Promise<PushResponse>;
}

export interface SyncResult {
  pulled: number;
  pushed: number;
  rejected: Array<{ idempotencyKey: string; reason: string }>;
  /** Conflicts the merge could not decide — shown, never resolved silently. */
  conflicted: string[];
  /** Set when shedding dropped queued work. */
  shedNotice?: string;
  /** True when nothing could reach the server. Not an error state (D2). */
  offline: boolean;
}

/**
 * Merge one server item into local state.
 *
 * Mirrored items are re-read rather than merged (D1) — the source owns their
 * truth, and asserting our cached copy might be more correct than the system of
 * record is never right. Owned items go through the full D4 rules.
 */
export function applyRemoteItem(
  state: PlannerState,
  remote: PlannerItem,
  fetchedAt: string,
): { conflicted: boolean } {
  const local = state.items[remote.id];

  if (!local) {
    // Unseen on this device. A new item, not a deletion to reconcile.
    state.items[remote.id] = remote;
    return { conflicted: false };
  }

  if (remote.origin === 'mirrored') {
    state.items[remote.id] = refreshMirrored(local, remote, fetchedAt);
    return { conflicted: false };
  }

  const merged = mergeOwnedItem(local, remote);
  state.items[remote.id] = merged;
  return { conflicted: Object.keys(merged.conflicts ?? {}).length > 0 };
}

/**
 * One sync cycle.
 *
 * Mutates `state` in place and returns what happened; the caller persists. A
 * transport failure is NOT an exception — offline is the normal mode that
 * happens to be syncing, and a thrown error at this layer would push callers
 * into try/catch around something that is expected to fail routinely.
 */
export async function syncOnce(
  state: PlannerState,
  transport: PlannerTransport,
  nowMs: number,
): Promise<SyncResult> {
  const result: SyncResult = {
    pulled: 0, pushed: 0, rejected: [], conflicted: [], offline: false,
  };

  // Shed before anything else: a device returning after months should refresh
  // rather than replay a thousand operations against a world that moved on.
  const shedded = shed(state.outbox, nowMs);
  state.outbox = { operations: shedded.operations };
  if (shedded.shedNotice) result.shedNotice = shedded.shedNotice;

  /* ------------------------------------------------------------------ pull */
  let pull: PullResponse;
  try {
    pull = await transport.pull(state.lastPulledAt);
  } catch {
    // No network. The cache is still authoritative and the outbox still holds
    // everything; nothing is lost, so nothing is reported as an error.
    result.offline = true;
    return result;
  }

  if (pull.serverClock) {
    // Absorb the highest clock seen, so a device whose wall clock is behind
    // stops losing every tie the moment it talks to anyone.
    state.clock = hlcReceive(state.clock, pull.serverClock, nowMs);
  }

  const fetchedAt = new Date(nowMs).toISOString();
  for (const remote of pull.items) {
    const { conflicted } = applyRemoteItem(state, remote, fetchedAt);
    result.pulled += 1;
    if (conflicted) result.conflicted.push(remote.id);
  }
  state.lastPulledAt = pull.cursor;

  /* ------------------------------------------------------------------ push */
  const batch = nextBatch(state.outbox);
  if (batch.length === 0) return result;

  let push: PushResponse;
  try {
    push = await transport.push(batch);
  } catch {
    // The pull succeeded and is kept — a failed push does not undo it. Each
    // operation records an attempt so a permanently-failing one becomes
    // visible instead of retrying forever in silence.
    for (const op of batch) {
      state.outbox = recordFailure(state.outbox, op.idempotencyKey, 'Could not reach the server.');
    }
    result.offline = true;
    return result;
  }

  state.outbox = acknowledge(state.outbox, push.accepted);
  result.pushed = push.accepted.length;

  for (const rejection of push.rejected) {
    // Kept, not dropped. A silently discarded operation is work the person
    // did that nobody will ever tell them was lost.
    state.outbox = recordFailure(state.outbox, rejection.idempotencyKey, rejection.reason);
    result.rejected.push(rejection);
  }
  return result;
}

/**
 * Is this the first sync for this device?
 *
 * Called out because it is the case that most often produces catastrophe: an
 * empty cache meeting a populated server looks identical to "everything was
 * deleted" if you diff naively. It is a new device, and the correct action is
 * to accept everything and push nothing but genuine local work.
 */
export function isFirstSync(state: PlannerState): boolean {
  return !state.lastPulledAt;
}

/**
 * What the human is told after a sync.
 *
 * Ordered by what needs action. Conflicts first because they are the only thing
 * that cannot resolve itself; offline last because it resolves on its own and
 * saying so loudly trains people to ignore the line.
 */
export function describeSync(result: SyncResult, outbox: OutboxState): string {
  if (result.conflicted.length > 0) {
    const n = result.conflicted.length;
    return `${n} item${n === 1 ? '' : 's'} changed in two places — pick which version to keep.`;
  }
  if (result.shedNotice) return result.shedNotice;
  const stuck = stuckOperations(outbox).length;
  if (stuck > 0) {
    return `${stuck} change${stuck === 1 ? '' : 's'} could not be sent — open sync to see why.`;
  }
  if (result.offline) {
    const pending = outbox.operations.length;
    return pending > 0
      ? `${pending} change${pending === 1 ? '' : 's'} waiting to sync.`
      : 'Working offline.';
  }
  if (result.pulled === 0 && result.pushed === 0) return 'Everything is synced.';
  return `Synced — ${result.pulled} in, ${result.pushed} out.`;
}
