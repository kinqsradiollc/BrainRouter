/**
 * ADR-028 Part D — the planner store.
 *
 * The piece that was missing: D1–D8 shipped as libraries with nothing calling
 * them, which is the exact failure E1 exists to catch. Everything below is the
 * caller.
 *
 * **This file is a CACHE, not the truth (D9).** The first version of it followed
 * the artifact convention and wrote per workspace, which was wrong twice: a
 * planner is personal, so scoping it per repository makes "today" depend on
 * which repo you have open; and a device-local file means two devices never
 * meet, so the D3/D4 conflict machinery could never fire.
 *
 * So it is user-scoped, under the brainrouter home rather than a workspace, and
 * the server holds the durable copy when one is configured. With no server the
 * cache is authoritative — local-first means solo mode is the normal mode, not
 * a degraded one.
 *
 * Every mutation stamps an HLC (D3) and appends to the outbox (D2), so the sync
 * layer, when it arrives, has an ordered, idempotent record rather than a
 * reconstruction.
 */
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { getBrainrouterHome, readJsonFile, writeJsonFile } from '../storage/store.js';
import { compareHlc, hlcNow, hlcReceive, hlcZero, type Hlc } from '../sync/hybridClock.js';
import { stableDeviceId } from '../sync/deviceId.js';
import { causalValue, canEditLocally, mergeOwnedItem, type PlannerItem, type Stamped } from './itemMerge.js';
import {
  emptyOutbox, enqueue, inspectOutbox, requestOperationRetry,
  type OutboxOperationDetail, type OutboxState,
} from '../sync/outbox.js';
import type { PlannerProvenance } from '@kinqs/brainrouter-types/planner';
import { carryOver, type TimeBlock } from './timetable.js';

export interface PlannerState {
  schemaVersion: 1;
  /** This device's stable id, persisted so it cannot drift. */
  deviceId: string;
  /** Server revision this cache last saw, for `changed-since` pulls (D11). */
  lastPulledAt?: string;
  /** This device's clock. Persisted so ordering survives a restart. */
  clock: Hlc;
  items: Record<string, PlannerItem>;
  blocks: Record<string, TimeBlock>;
  outbox: OutboxState;
}

/**
 * The cache path.
 *
 * User-scoped: one planner per person per install, regardless of which
 * workspace happens to be open. `userId` partitions the file when several
 * accounts share a machine; absent one, the single-user path is used.
 */
export function plannerFile(userId?: string): string {
  const safe = (userId ?? 'local').replace(/[^A-Za-z0-9._-]/g, '_');
  return path.join(getBrainrouterHome(), `planner-${safe}.json`);
}

/** This install's device id for the planner's clock. See `sync/deviceId.ts`. */
export function deviceIdFor(userId: string | undefined): string {
  return stableDeviceId(plannerFile(userId));
}

export function readPlanner(userId: string | undefined): PlannerState {
  const deviceId = deviceIdFor(userId);
  const empty: PlannerState = {
    schemaVersion: 1,
    deviceId,
    clock: hlcZero(deviceId),
    items: {},
    blocks: {},
    outbox: emptyOutbox(),
  };
  const stored = readJsonFile<Partial<PlannerState>>(plannerFile(userId), {});
  return {
    ...empty,
    ...stored,
    // A stored file from a previous schema may be missing whole sections; a
    // planner that throws on read is worse than one that starts empty.
    deviceId: stored.deviceId ?? deviceId,
    clock: stored.clock ?? empty.clock,
    items: stored.items ?? {},
    blocks: stored.blocks ?? {},
    outbox: stored.outbox ?? emptyOutbox(),
  };
}

/**
 * Persist the planner state.
 *
 * Exported because the sync client mutates the state it is given (advancing the
 * clock, draining the outbox) and the caller has to write the result — a sync
 * whose outcome is not persisted repeats the same push next tick.
 */
export function writePlanner(userId: string | undefined, state: PlannerState): void {
  writeJsonFile(plannerFile(userId), state);
}

/** Advance the persisted clock and return the stamp for this mutation. */
function stamp(state: PlannerState, nowMs: number): Hlc {
  const next = hlcNow(state.clock, nowMs);
  state.clock = next;
  return next;
}

function newId(prefix: string): string {
  return `${prefix}_${randomUUID()}`;
}

function newOperationKey(): string {
  return randomUUID();
}

const value = <T>(v: T, at: Hlc, ...previous: Array<Stamped<unknown> | undefined>): Stamped<T> =>
  causalValue(v, at, ...previous);

/* --------------------------------------------------------------- mutations */

export interface AddItemInput {
  title: string;
  notes?: string;
  dueDate?: string;
  priority?: number;
  /** Present for a mirrored item — the source that owns its truth (D1). */
  source?: string;
  /** The source's own id, so a re-read can find it again. */
  externalId?: string;
  /** Human-readable source name; defaults to `source`. */
  sourceLabel?: string;
  /** Opens the mirrored record in the source system. */
  sourceUrl?: string;
  estimateMinutes?: number;
  blockedReason?: string;
}

export function addItem(
  userId: string | undefined,
  input: AddItemInput,
  nowMs: number,
): PlannerItem {
  if (input.sourceUrl) {
    let protocol: string | undefined;
    try { protocol = new URL(input.sourceUrl).protocol; } catch { /* rejected below */ }
    if (protocol !== 'https:') {
      throw new Error('A connected planner source URL must use HTTPS.');
    }
  }
  const state = readPlanner(userId);
  const at = stamp(state, nowMs);
  const id = input.externalId ? `${input.source}:${input.externalId}` : newId('itm');
  const fetchedAt = new Date(nowMs).toISOString();
  const provenance: PlannerProvenance | undefined = input.source
    ? {
        sourceId: input.source,
        sourceLabel: input.sourceLabel ?? input.source,
        fetchedAt,
        ...(input.externalId ? { externalId: input.externalId } : {}),
        ...(input.sourceUrl ? { sourceUrl: input.sourceUrl } : {}),
      }
    : undefined;

  const item: PlannerItem = {
    id,
    origin: input.source ? 'mirrored' : 'owned',
    ...(input.source ? { source: input.source, fetchedAt } : {}),
    ...(provenance ? { provenance } : {}),
    title: value(input.title, at),
    ...(input.notes ? { notes: value(input.notes, at) } : {}),
    ...(input.dueDate ? { dueDate: value(input.dueDate, at) } : {}),
    ...(input.priority !== undefined ? { priority: value(input.priority, at) } : {}),
    ...(input.estimateMinutes !== undefined
      ? { estimateMinutes: input.estimateMinutes, estimateUpdatedAt: at }
      : {}),
    ...(input.blockedReason !== undefined ? { blockedReason: value(input.blockedReason, at) } : {}),
  };

  state.items[id] = item;
  state.outbox = enqueue(state.outbox, {
    idempotencyKey: newOperationKey(),
    itemId: id, entity: 'item', kind: 'create', at, payload: item, attempts: 0,
  });
  writePlanner(userId, state);
  return item;
}

export interface UpdateItemInput {
  title?: string;
  notes?: string;
  dueDate?: string | null;
  priority?: number;
  completed?: boolean;
  estimateMinutes?: number;
  blockedReason?: string | null;
}

/**
 * Check a whole local mutation before changing the cache or appending an
 * outbox operation. Kept separate from `updateItem` so a surface can show the
 * same refusal the store enforces instead of interpreting a null return.
 */
export function canUpdateItemLocally(
  item: Pick<PlannerItem, 'origin' | 'source'>,
  input: UpdateItemInput,
): { allowed: boolean; reason?: string } {
  for (const field of Object.keys(input)) {
    const decision = canEditLocally(item, field);
    if (!decision.allowed) return decision;
  }
  return { allowed: true };
}

/**
 * Apply an edit, merging rather than overwriting.
 *
 * Routed through `mergeOwnedItem` even for a purely local edit, so the D4 rules
 * — field-level LWW, concurrent text conflicts, complete-wins — are exercised
 * on the one path instead of on a sync path that gets tested less.
 */
export function updateItem(
  userId: string | undefined,
  id: string,
  input: UpdateItemInput,
  nowMs: number,
): PlannerItem | null {
  const state = readPlanner(userId);
  const current = state.items[id];
  if (!current) return null;
  if (!canUpdateItemLocally(current, input).allowed) return null;
  const at = stamp(state, nowMs);

  const edit: PlannerItem = {
    ...current,
    ...(input.title !== undefined ? { title: value(input.title, at, current.title) } : {}),
    ...(input.notes !== undefined ? { notes: value(input.notes, at, current.notes) } : {}),
    ...(input.dueDate !== undefined ? { dueDate: value(input.dueDate, at) } : {}),
    ...(input.priority !== undefined ? { priority: value(input.priority, at) } : {}),
    ...(input.completed !== undefined ? { completed: value(input.completed, at) } : {}),
    ...(input.estimateMinutes !== undefined
      ? { estimateMinutes: input.estimateMinutes, estimateUpdatedAt: at }
      : {}),
    ...(input.blockedReason !== undefined ? { blockedReason: value(input.blockedReason, at) } : {}),
  };

  const merged = current.origin === 'owned' ? mergeOwnedItem(current, edit) : edit;
  state.items[id] = merged;
  state.outbox = enqueue(state.outbox, {
    idempotencyKey: newOperationKey(),
    itemId: id, entity: 'item', kind: 'update', at, payload: {
      ...input,
      ...(input.title !== undefined ? { title: edit.title } : {}),
      ...(input.notes !== undefined ? { notes: edit.notes } : {}),
    }, attempts: 0,
  });
  writePlanner(userId, state);
  return merged;
}

/**
 * Delete as a tombstone, never as an absence.
 *
 * D4: a later edit arriving from another device must be able to resurrect this
 * as conflicted. Removing the record outright would make that edit look like a
 * creation, and the deletion would silently un-happen.
 */
export function deleteItem(userId: string | undefined, id: string, nowMs: number): boolean {
  const state = readPlanner(userId);
  const current = state.items[id];
  if (!current) return false;
  if (!canEditLocally(current, 'delete').allowed) return false;
  const at = stamp(state, nowMs);
  state.items[id] = { ...current, deletedAt: at };
  for (const [blockId, block] of Object.entries(state.blocks)) {
    if (block.itemId === id) {
      state.blocks[blockId] = { ...block, updatedAt: at, deletedAt: at };
    }
  }
  state.outbox = enqueue(state.outbox, {
    idempotencyKey: newOperationKey(),
    itemId: id, entity: 'item', kind: 'delete', at, payload: {}, attempts: 0,
  });
  writePlanner(userId, state);
  return true;
}

/* ------------------------------------------------------------------ blocks */

export function scheduleBlock(
  userId: string | undefined,
  input: { itemId: string; scheduledFor?: string; estimateMinutes: number },
  nowMs: number,
): TimeBlock {
  const state = readPlanner(userId);
  const parent = state.items[input.itemId];
  if (!parent || parent.deletedAt) {
    throw new Error(`The parent planner item ${input.itemId} does not exist.`);
  }
  const at = stamp(state, nowMs);
  const id = newId('blk');
  const block: TimeBlock = {
    id,
    itemId: input.itemId,
    ...(input.scheduledFor ? { scheduledFor: input.scheduledFor } : {}),
    estimateMinutes: input.estimateMinutes,
    carriedOver: 0,
    updatedAt: at,
  };
  state.blocks[id] = block;
  state.outbox = enqueue(state.outbox, {
    idempotencyKey: newOperationKey(),
    itemId: id, entity: 'block', kind: 'create', at, payload: block, attempts: 0,
  });
  writePlanner(userId, state);
  return block;
}

export interface UpdateBlockInput {
  scheduledFor?: string | null;
  estimateMinutes?: number;
  actualMinutes?: number | null;
  carriedOver?: number;
  completedAt?: string | null;
}

/** Move or update one time block and queue the block record itself for sync. */
export function updateBlock(
  userId: string | undefined,
  blockId: string,
  input: UpdateBlockInput,
  nowMs: number,
): TimeBlock | null {
  const state = readPlanner(userId);
  const current = state.blocks[blockId];
  if (!current || current.deletedAt) return null;
  const parent = state.items[current.itemId];
  if (!parent || parent.deletedAt) return null;
  const at = stamp(state, nowMs);
  // ADR-028 D5 — moving an unfinished block to a LATER day IS a carry-forward,
  // so `carryOver` is applied here rather than left to a caller to remember.
  // Nothing incremented `carriedOver` before this: `needsAttention` and
  // `describeCarryOver` both read it, both are rendered, and both could
  // therefore never fire — a "this has moved four times" prompt over a counter
  // stuck at zero. An explicit `carriedOver` still wins, because a pulled
  // remote block carries the count the other device already recorded.
  const carriedForward =
    input.carriedOver === undefined &&
    typeof input.scheduledFor === 'string' &&
    typeof current.scheduledFor === 'string' &&
    input.scheduledFor.slice(0, 10) > current.scheduledFor.slice(0, 10) &&
    !current.completedAt;
  const base = carriedForward ? carryOver([current], input.scheduledFor as string)[0]! : current;
  const next: TimeBlock = {
    ...base,
    ...(input.scheduledFor !== undefined
      ? input.scheduledFor === null ? { scheduledFor: undefined } : { scheduledFor: input.scheduledFor }
      : {}),
    ...(input.estimateMinutes !== undefined ? { estimateMinutes: input.estimateMinutes } : {}),
    ...(input.actualMinutes !== undefined
      ? input.actualMinutes === null ? { actualMinutes: undefined } : { actualMinutes: input.actualMinutes }
      : {}),
    ...(input.carriedOver !== undefined ? { carriedOver: input.carriedOver } : {}),
    ...(input.completedAt !== undefined
      ? input.completedAt === null ? { completedAt: undefined } : { completedAt: input.completedAt }
      : {}),
    updatedAt: at,
  };
  state.blocks[blockId] = next;
  state.outbox = enqueue(state.outbox, {
    idempotencyKey: newOperationKey(),
    itemId: blockId,
    entity: 'block',
    kind: 'update',
    at,
    // The derived count travels with the move. Sending only what the caller
    // passed would leave the server's copy at the old number, and the next pull
    // would undo the increment this device just made.
    payload: carriedForward ? { ...input, carriedOver: next.carriedOver } : input,
    attempts: 0,
  });
  writePlanner(userId, state);
  return next;
}

/** Record what a block actually took — D5's whole point. */
export function recordActual(
  userId: string | undefined,
  blockId: string,
  actualMinutes: number,
  nowMs: number,
): TimeBlock | null {
  return updateBlock(userId, blockId, {
    actualMinutes,
    completedAt: new Date(nowMs).toISOString(),
  }, nowMs);
}

/* -------------------------------------------------------------------- reads */

/** Live items — not deleted. Completed ones are included; callers filter. */
export function listItems(
  userId: string | undefined,
  opts: { includeCompleted?: boolean; source?: string } = {},
): PlannerItem[] {
  const state = readPlanner(userId);
  return Object.values(state.items)
    .filter((i) => !i.deletedAt)
    .filter((i) => (opts.includeCompleted ? true : !i.completed?.value))
    .filter((i) => (opts.source ? i.source === opts.source : true))
    .sort((a, b) => (a.priority?.value ?? 99) - (b.priority?.value ?? 99));
}

export function listBlocks(userId: string | undefined): TimeBlock[] {
  const state = readPlanner(userId);
  return Object.values(state.blocks)
    .filter((block) => !block.deletedAt)
    .filter((block) => !state.items[block.itemId]?.deletedAt);
}

/** Safe details for the sync control; operation payloads stay private. */
export function plannerOutboxDetails(
  userId: string | undefined,
  nowMs: number,
): OutboxOperationDetail[] {
  return inspectOutbox(readPlanner(userId).outbox, nowMs);
}

/** Persist a retry request so it survives a restart before the next sync. */
export function retryPlannerOperation(
  userId: string | undefined,
  idempotencyKey: string,
  nowMs: number,
): OutboxOperationDetail | null {
  const state = readPlanner(userId);
  const next = requestOperationRetry(state.outbox, idempotencyKey, new Date(nowMs).toISOString());
  if (next === state.outbox) return null;
  state.outbox = next;
  writePlanner(userId, state);
  return inspectOutbox(next, nowMs).find((detail) => detail.idempotencyKey === idempotencyKey) ?? null;
}

export function getItem(userId: string | undefined, id: string): PlannerItem | null {
  return readPlanner(userId).items[id] ?? null;
}

/**
 * Items with an unresolved merge conflict.
 *
 * Surfaced as its own read because a conflict that nobody is shown is the same
 * as having discarded the losing edit — which is the outcome D4 refuses.
 */
export function listConflicts(userId: string | undefined): PlannerItem[] {
  return Object.values(readPlanner(userId).items)
    .filter((i) => i.conflicts && Object.keys(i.conflicts).length > 0);
}

/** Keep one of the two recorded versions and clear the conflict marker. */
export function resolveConflict(
  userId: string | undefined,
  id: string,
  field: string,
  keep: 'ours' | 'theirs',
  nowMs: number,
): PlannerItem | null {
  const state = readPlanner(userId);
  const item = state.items[id];
  if (field !== 'title' && field !== 'notes' && field !== 'deleted') return null;
  const conflict = item?.conflicts?.[field];
  if (!item || !conflict) return null;
  // A fast remote device may have stamped the conflict ahead of this device's
  // wall clock. Absorb both sides before choosing so the resolution watermark
  // is causally after the values it acknowledges, not merely after local time.
  const latestConflict = compareHlc(conflict.theirsAt, conflict.oursAt) > 0
    ? conflict.theirsAt
    : conflict.oursAt;
  state.clock = hlcReceive(state.clock, latestConflict, nowMs);
  const at = stamp(state, nowMs);

  const chosen = keep === 'ours' ? conflict.ours : conflict.theirs;
  const rest = { ...item.conflicts };
  delete rest[field];

  if (field === 'deleted') {
    const deleted = keep === 'ours';
    state.items[id] = {
      ...item,
      ...(deleted ? { deletedAt: at } : { deletedAt: undefined }),
      deletionResolution: { deleted, at },
      ...(Object.keys(rest).length > 0 ? { conflicts: rest } : { conflicts: undefined }),
    };
    if (deleted) {
      for (const [blockId, block] of Object.entries(state.blocks)) {
        if (block.itemId !== id) continue;
        state.blocks[blockId] = { ...block, updatedAt: at, deletedAt: at };
      }
    }
    state.outbox = enqueue(state.outbox, {
      idempotencyKey: newOperationKey(),
      itemId: id,
      entity: 'item',
      kind: 'resolve_conflict',
      at,
      payload: { field: 'deleted', keep },
      attempts: 0,
    });
    writePlanner(userId, state);
    return state.items[id]!;
  }

  state.items[id] = {
    ...item,
    ...(field === 'title' ? {
      title: value(
        String(chosen), at,
        { value: conflict.ours, at: conflict.oursAt, seen: [] },
        { value: conflict.theirs, at: conflict.theirsAt, seen: [] },
      ),
    } : {}),
    ...(field === 'notes' ? {
      notes: value(
        String(chosen), at,
        { value: conflict.ours, at: conflict.oursAt, seen: [] },
        { value: conflict.theirs, at: conflict.theirsAt, seen: [] },
      ),
    } : {}),
    conflictResolutions: { ...item.conflictResolutions, [field]: at },
    ...(Object.keys(rest).length > 0 ? { conflicts: rest } : { conflicts: undefined }),
  };
  state.outbox = enqueue(state.outbox, {
    idempotencyKey: newOperationKey(),
    itemId: id,
    entity: 'item',
    kind: 'resolve_conflict',
    at,
    payload: { field, value: String(chosen) },
    attempts: 0,
  });
  writePlanner(userId, state);
  return state.items[id]!;
}
