/**
 * ADR-028 D2 — local-first with an outbox; the network is never on the critical
 * path.
 *
 * Every mutation writes locally and returns immediately, then appends to a
 * durable outbox that drains when there is a network. The user-visible property
 * is that the planner is never waiting on a server, and that is not a
 * performance nicety — a planner that stalls is a planner people stop using
 * mid-thought.
 *
 * Offline is not a degraded mode with a banner across the top. It is the normal
 * mode, which happens to be syncing.
 *
 * Three constraints make that safe:
 *
 *  - **Idempotency keys** (ADR-027 D12), so a redelivery does not double-apply.
 *  - **Ordered per item.** Reordering two edits to one todo produces a state
 *    neither device ever had, which is worse than either — it is a state nobody
 *    can explain. Different items reorder freely; that is where the throughput
 *    comes from.
 *  - **Bounded, with age-based shedding.** A device offline three months
 *    refreshes from the server instead of replaying a thousand stale
 *    operations — and is TOLD that happened, because silently discarding
 *    someone's queued work is the same lie B1 refuses for receipts.
 */
import type { Hlc } from './hybridClock.js';
import { compareHlc } from './hybridClock.js';

export interface OutboxOperation {
  /** Unique per operation. A redelivery with the same key is a no-op. */
  idempotencyKey: string;
  /** Which item this touches. Operations on one item never reorder. */
  itemId: string;
  kind: 'create' | 'update' | 'delete' | 'source_action';
  /** The stamp of the local write, for ordering and for the server's merge. */
  at: Hlc;
  /** Opaque to the outbox. */
  payload: unknown;
  /** Failed attempts so far. */
  attempts: number;
  /** Why the last attempt failed, if it did. */
  lastError?: string;
}

export interface OutboxState {
  operations: readonly OutboxOperation[];
  /** Set when shedding dropped operations, so the UI can say so. */
  shedNotice?: string;
}

/** Beyond this the queue is not a queue, it is a backlog nobody will reconcile. */
export const MAX_OUTBOX_OPERATIONS = 500;
/** Older than this, a full refresh is cheaper and more correct than a replay. */
export const MAX_OUTBOX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

export function emptyOutbox(): OutboxState {
  return { operations: [] };
}

/**
 * Append a locally-applied mutation.
 *
 * Deduplicates on the idempotency key so a retry at the call site cannot
 * enqueue twice — the key is generated with the local write, not with the send.
 */
export function enqueue(state: OutboxState, op: OutboxOperation): OutboxState {
  if (state.operations.some((o) => o.idempotencyKey === op.idempotencyKey)) return state;
  return { ...state, operations: [...state.operations, op] };
}

/**
 * The next batch to send.
 *
 * At most one operation per item, because a later edit to the same item must
 * not overtake an earlier one. Everything else goes in parallel — the ordering
 * requirement is per item, and applying it globally would make a single stuck
 * operation block the entire queue.
 */
export function nextBatch(state: OutboxState, limit = 25): OutboxOperation[] {
  const claimed = new Set<string>();
  const batch: OutboxOperation[] = [];
  for (const op of state.operations) {
    if (claimed.has(op.itemId)) continue;
    claimed.add(op.itemId);
    batch.push(op);
    if (batch.length >= limit) break;
  }
  return batch;
}

/** Remove operations the server confirmed. */
export function acknowledge(state: OutboxState, keys: readonly string[]): OutboxState {
  const done = new Set(keys);
  return { ...state, operations: state.operations.filter((o) => !done.has(o.idempotencyKey)) };
}

/**
 * Record a failure without dropping the operation.
 *
 * The attempt count is what lets a permanently-failing operation become
 * visible rather than retrying forever in the background — a queue that never
 * empties and never complains is indistinguishable from one that is working.
 */
export function recordFailure(
  state: OutboxState,
  key: string,
  error: string,
): OutboxState {
  return {
    ...state,
    operations: state.operations.map((o) =>
      o.idempotencyKey === key ? { ...o, attempts: o.attempts + 1, lastError: error } : o,
    ),
  };
}

/** Operations that have failed enough times to be worth a human's attention. */
export const ATTEMPTS_BEFORE_SURFACING = 5;

export function stuckOperations(state: OutboxState): OutboxOperation[] {
  return state.operations.filter((o) => o.attempts >= ATTEMPTS_BEFORE_SURFACING);
}

/**
 * Shed what is too old or too numerous to be worth replaying.
 *
 * The device then refreshes from the server, which is both cheaper and more
 * correct than replaying a month of operations against a world that has moved
 * on. The notice is the important part: this discards work someone did, and
 * doing that quietly is exactly the failure this ADR is about.
 */
export function shed(
  state: OutboxState,
  nowMs: number,
  opts: { maxAgeMs?: number; maxOperations?: number } = {},
): OutboxState {
  const maxAge = opts.maxAgeMs ?? MAX_OUTBOX_AGE_MS;
  const maxOps = opts.maxOperations ?? MAX_OUTBOX_OPERATIONS;

  const fresh = state.operations.filter((o) => nowMs - o.at.physical <= maxAge);
  const agedOut = state.operations.length - fresh.length;

  // Keep the NEWEST when over the cap: the oldest are the most likely to have
  // been superseded, and the newest reflect what the person currently believes.
  const kept = fresh.length > maxOps ? fresh.slice(fresh.length - maxOps) : fresh;
  const overflow = fresh.length - kept.length;

  const dropped = agedOut + overflow;
  if (dropped === 0) return { operations: kept };

  const parts: string[] = [];
  if (agedOut > 0) parts.push(`${agedOut} older than ${Math.round(maxAge / 86_400_000)} days`);
  if (overflow > 0) parts.push(`${overflow} beyond the ${maxOps}-operation limit`);

  return {
    operations: kept,
    shedNotice:
      `${dropped} queued change${dropped === 1 ? '' : 's'} could not be sent and ${dropped === 1 ? 'was' : 'were'} dropped ` +
      `(${parts.join('; ')}). This device has refreshed from the server instead. ` +
      'Anything you changed while offline that long may need redoing.',
  };
}

/**
 * Sort operations for replay.
 *
 * Per item by stamp; across items, stable. A total order across everything
 * would be simpler and wrong — it would serialise unrelated work behind
 * whichever item happened to be stamped first.
 */
export function replayOrder(operations: readonly OutboxOperation[]): OutboxOperation[] {
  const byItem = new Map<string, OutboxOperation[]>();
  const order: string[] = [];
  for (const op of operations) {
    if (!byItem.has(op.itemId)) { byItem.set(op.itemId, []); order.push(op.itemId); }
    byItem.get(op.itemId)!.push(op);
  }
  const out: OutboxOperation[] = [];
  for (const itemId of order) {
    out.push(...byItem.get(itemId)!.sort((a, b) => compareHlc(a.at, b.at)));
  }
  return out;
}

/**
 * What the UI says about sync state.
 *
 * Never "offline" as an error. A pending count is a fact; a banner announcing
 * degradation is a judgement about a mode that is supposed to be normal.
 */
export function describeSyncState(state: OutboxState): string {
  const stuck = stuckOperations(state).length;
  if (stuck > 0) {
    return `${stuck} change${stuck === 1 ? '' : 's'} could not be sent — open sync to see why.`;
  }
  const pending = state.operations.length;
  if (pending === 0) return 'Everything is synced.';
  return `${pending} change${pending === 1 ? '' : 's'} waiting to sync.`;
}
