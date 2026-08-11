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
 *
 * **Why it is generic.** This was written against `PlannerState`/`PlannerItem`
 * and ADR-029 B3 needs the same loop for note blocks. Copying it would have
 * produced two sync systems, which is the failure B3 exists to prevent: they
 * disagree eventually, and the disagreement shows up as one surface holding
 * stale data while the other holds fresh — indistinguishable from a bug in
 * whichever one you are looking at.
 *
 * So the record type and the merge rule became parameters and everything else
 * stayed where it was. `plannerSync.ts` and `notesSync.ts` are both thin
 * instantiations; neither owns a copy of the loop.
 */
import { hlcReceive, type Hlc } from './hybridClock.js';
import {
  acknowledge, nextBatch, recordFailure, shed, stuckOperations,
  type OutboxOperation, type OutboxState,
} from './outbox.js';

/**
 * What the engine needs from a surface's cache, and nothing more.
 *
 * Structural rather than a base class, so `PlannerState` and `NotesState` keep
 * their own field names for their own records — `items` and `blocks` read
 * correctly in their own surfaces, and neither had to be renamed to something
 * generic that reads worse in both.
 */
export interface SyncState {
  /** This device's clock. Persisted so ordering survives a restart. */
  clock: Hlc;
  /** Server revision this cache last saw, for `changed-since` pulls. */
  lastPulledAt?: string;
  outbox: OutboxState;
}

export interface PullResponse<T> {
  /** Records changed on the server since `since`. */
  items: T[];
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
  /** Accepted operations whose content was kept as a fenced conflict. */
  fenced?: Array<{ idempotencyKey: string; itemId: string; reason: string }>;
}

export interface SyncTransport<T> {
  pull(since: string | undefined): Promise<PullResponse<T>>;
  push(operations: readonly OutboxOperation[]): Promise<PushResponse>;
}

/**
 * How one surface stores and merges its own records.
 *
 * `merge` is only ever called when a local copy EXISTS. The absent case is
 * handled by the engine and is not negotiable per surface: an unseen record is
 * a new record, never a deletion to reconcile, and letting a surface decide
 * otherwise is how property 1 gets broken by one implementation.
 */
export interface SyncRecords<S extends SyncState, T> {
  idOf(record: T): string;
  read(state: S, id: string): T | undefined;
  write(state: S, id: string, record: T): void;
  merge(local: T, remote: T, fetchedAt: string): { value: T; conflicted: boolean };
  /** Highest embedded stamp, so a fast peer is absorbed before our next edit. */
  observedClock?(record: T): Hlc | undefined;
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
 * Merge one server record into local state.
 *
 * Exported because both instantiations' own `applyRemote*` helpers are tested
 * directly, and because the absent-local rule above is the one a caller must
 * not be able to reimplement.
 */
export function applyRemoteRecord<S extends SyncState, T>(
  state: S,
  remote: T,
  fetchedAt: string,
  records: SyncRecords<S, T>,
): { conflicted: boolean } {
  const id = records.idOf(remote);
  const local = records.read(state, id);

  if (!local) {
    // Unseen on this device. A new record, not a deletion to reconcile.
    records.write(state, id, remote);
    return { conflicted: false };
  }

  const merged = records.merge(local, remote, fetchedAt);
  records.write(state, id, merged.value);
  return { conflicted: merged.conflicted };
}

/**
 * A push response must account for exactly the operations in its request.
 * Anything else is an untrusted/partial acknowledgement and must leave every
 * operation durable: accepting an extraneous key can delete work that was not
 * sent, while omitting a key can leave it retrying forever without a reason.
 */
export function invalidPushPartition(
  batch: readonly Pick<OutboxOperation, 'idempotencyKey'>[],
  response: unknown,
): string | null {
  if (!response || typeof response !== 'object' || Array.isArray(response)) {
    return 'The server returned an invalid Planner acknowledgement.';
  }
  const record = response as Record<string, unknown>;
  if (!Array.isArray(record.accepted) || !Array.isArray(record.rejected)) {
    return 'The server returned an incomplete Planner acknowledgement.';
  }
  const expected = new Set(batch.map((operation) => operation.idempotencyKey));
  if (expected.size !== batch.length) return 'The Planner batch contains duplicate idempotency keys.';
  const seen = new Set<string>();
  for (const key of record.accepted) {
    if (typeof key !== 'string' || !expected.has(key) || seen.has(key)) {
      return 'The server acknowledged an unknown or duplicate Planner operation.';
    }
    seen.add(key);
  }
  for (const rejection of record.rejected) {
    if (!rejection || typeof rejection !== 'object' || Array.isArray(rejection)) {
      return 'The server returned an invalid Planner rejection.';
    }
    const value = rejection as Record<string, unknown>;
    if (typeof value.idempotencyKey !== 'string' || !expected.has(value.idempotencyKey)
      || seen.has(value.idempotencyKey) || typeof value.reason !== 'string' || !value.reason.trim()) {
      return 'The server rejected an unknown or duplicate Planner operation.';
    }
    seen.add(value.idempotencyKey);
  }
  return seen.size === expected.size
    ? null
    : 'The server omitted a Planner operation from its acknowledgement.';
}

/**
 * One sync cycle.
 *
 * Mutates `state` in place and returns what happened; the caller persists. A
 * transport failure is NOT an exception — offline is the normal mode that
 * happens to be syncing, and a thrown error at this layer would push callers
 * into try/catch around something that is expected to fail routinely.
 */
export async function syncRecords<S extends SyncState, T>(
  state: S,
  transport: SyncTransport<T>,
  records: SyncRecords<S, T>,
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
  let pull: PullResponse<T>;
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
    const observed = records.observedClock?.(remote);
    if (observed) state.clock = hlcReceive(state.clock, observed, nowMs);
    const { conflicted } = applyRemoteRecord(state, remote, fetchedAt, records);
    result.pulled += 1;
    if (conflicted) result.conflicted.push(records.idOf(remote));
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

  const invalidPartition = invalidPushPartition(batch, push);
  if (invalidPartition) {
    for (const op of batch) {
      state.outbox = recordFailure(state.outbox, op.idempotencyKey, invalidPartition);
      result.rejected.push({ idempotencyKey: op.idempotencyKey, reason: invalidPartition });
    }
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
export function isFirstSync(state: SyncState): boolean {
  return !state.lastPulledAt;
}

/**
 * What the human is told after a sync.
 *
 * Ordered by what needs action. Conflicts first because they are the only thing
 * that cannot resolve itself; offline last because it resolves on its own and
 * saying so loudly trains people to ignore the line.
 *
 * `noun` is supplied by the surface so the sentence names what the person is
 * looking at — "2 items changed in two places" in the planner, "2 blocks" in a
 * note. Everything else is shared, so the two surfaces cannot drift into
 * describing the same sync state differently.
 */
export function describeRecordSync(result: SyncResult, outbox: OutboxState, noun = 'item'): string {
  if (result.conflicted.length > 0) {
    const n = result.conflicted.length;
    return `${n} ${noun}${n === 1 ? '' : 's'} changed in two places — pick which version to keep.`;
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
