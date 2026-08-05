/**
 * ADR-028 Part D — the planner store.
 *
 * The piece that was missing: D1–D8 shipped as libraries with nothing calling
 * them, which is the exact failure E1 exists to catch. Everything below is the
 * caller.
 *
 * Persistence follows the artifact/requirement convention — one JSON file under
 * the workspace state directory, shared with the CLI, so desktop and CLI see the
 * same planner without a server in between. That is D2's local-first promise in
 * its simplest honest form: the file IS the truth, the network is a later
 * synchroniser, and nothing here waits on it.
 *
 * Every mutation stamps an HLC (D3) and appends to the outbox (D2), so the sync
 * layer, when it arrives, has an ordered, idempotent record rather than a
 * reconstruction.
 */
import { getStateFile, readJsonFile, writeJsonFile } from '../storage/store.js';
import { hlcNow, hlcZero, type Hlc } from './hybridClock.js';
import { mergeOwnedItem, type PlannerItem, type Stamped } from './itemMerge.js';
import { emptyOutbox, enqueue, type OutboxState } from './outbox.js';
import type { TimeBlock } from './timetable.js';

export interface PlannerState {
  schemaVersion: 1;
  /** This device's clock. Persisted so ordering survives a restart. */
  clock: Hlc;
  items: Record<string, PlannerItem>;
  blocks: Record<string, TimeBlock>;
  outbox: OutboxState;
}

function plannerFile(workspaceRoot: string): string {
  return getStateFile(workspaceRoot, 'planner.json');
}

/**
 * A stable per-install device id.
 *
 * Part of every HLC stamp, and the final tie-break that makes ordering total.
 * Derived from the workspace path rather than random so a reinstall does not
 * look like a new device to its own history.
 */
export function deviceIdFor(workspaceRoot: string): string {
  let hash = 0;
  for (let i = 0; i < workspaceRoot.length; i += 1) {
    hash = (hash * 31 + workspaceRoot.charCodeAt(i)) | 0;
  }
  return `d${Math.abs(hash).toString(36)}`;
}

export function readPlanner(workspaceRoot: string): PlannerState {
  const empty: PlannerState = {
    schemaVersion: 1,
    clock: hlcZero(deviceIdFor(workspaceRoot)),
    items: {},
    blocks: {},
    outbox: emptyOutbox(),
  };
  const stored = readJsonFile<Partial<PlannerState>>(plannerFile(workspaceRoot), {});
  return {
    ...empty,
    ...stored,
    // A stored file from a previous schema may be missing whole sections; a
    // planner that throws on read is worse than one that starts empty.
    clock: stored.clock ?? empty.clock,
    items: stored.items ?? {},
    blocks: stored.blocks ?? {},
    outbox: stored.outbox ?? emptyOutbox(),
  };
}

function write(workspaceRoot: string, state: PlannerState): void {
  writeJsonFile(plannerFile(workspaceRoot), state);
}

/** Advance the persisted clock and return the stamp for this mutation. */
function stamp(state: PlannerState, nowMs: number): Hlc {
  const next = hlcNow(state.clock, nowMs);
  state.clock = next;
  return next;
}

let counter = 0;
function newId(prefix: string, nowMs: number): string {
  counter = (counter + 1) % 100_000;
  return `${prefix}_${nowMs.toString(36)}${counter.toString(36)}`;
}

const value = <T>(v: T, at: Hlc): Stamped<T> => ({ value: v, at });

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
}

export function addItem(
  workspaceRoot: string,
  input: AddItemInput,
  nowMs: number,
): PlannerItem {
  const state = readPlanner(workspaceRoot);
  const at = stamp(state, nowMs);
  const id = input.externalId ? `${input.source}:${input.externalId}` : newId('itm', nowMs);

  const item: PlannerItem = {
    id,
    origin: input.source ? 'mirrored' : 'owned',
    ...(input.source ? { source: input.source, fetchedAt: new Date(nowMs).toISOString() } : {}),
    title: value(input.title, at),
    ...(input.notes ? { notes: value(input.notes, at) } : {}),
    ...(input.dueDate ? { dueDate: value(input.dueDate, at) } : {}),
    ...(input.priority !== undefined ? { priority: value(input.priority, at) } : {}),
  };

  state.items[id] = item;
  state.outbox = enqueue(state.outbox, {
    idempotencyKey: `${id}:create:${at.physical}.${at.logical}`,
    itemId: id, kind: 'create', at, payload: input, attempts: 0,
  });
  write(workspaceRoot, state);
  return item;
}

export interface UpdateItemInput {
  title?: string;
  notes?: string;
  dueDate?: string | null;
  priority?: number;
  completed?: boolean;
}

/**
 * Apply an edit, merging rather than overwriting.
 *
 * Routed through `mergeOwnedItem` even for a purely local edit, so the D4 rules
 * — field-level LWW, concurrent text conflicts, complete-wins — are exercised
 * on the one path instead of on a sync path that gets tested less.
 */
export function updateItem(
  workspaceRoot: string,
  id: string,
  input: UpdateItemInput,
  nowMs: number,
): PlannerItem | null {
  const state = readPlanner(workspaceRoot);
  const current = state.items[id];
  if (!current) return null;
  const at = stamp(state, nowMs);

  const edit: PlannerItem = {
    ...current,
    ...(input.title !== undefined ? { title: value(input.title, at) } : {}),
    ...(input.notes !== undefined ? { notes: value(input.notes, at) } : {}),
    ...(input.dueDate !== undefined ? { dueDate: value(input.dueDate, at) } : {}),
    ...(input.priority !== undefined ? { priority: value(input.priority, at) } : {}),
    ...(input.completed !== undefined ? { completed: value(input.completed, at) } : {}),
  };

  const merged = current.origin === 'owned' ? mergeOwnedItem(current, edit) : edit;
  state.items[id] = merged;
  state.outbox = enqueue(state.outbox, {
    idempotencyKey: `${id}:update:${at.physical}.${at.logical}`,
    itemId: id, kind: 'update', at, payload: input, attempts: 0,
  });
  write(workspaceRoot, state);
  return merged;
}

/**
 * Delete as a tombstone, never as an absence.
 *
 * D4: a later edit arriving from another device must be able to resurrect this
 * as conflicted. Removing the record outright would make that edit look like a
 * creation, and the deletion would silently un-happen.
 */
export function deleteItem(workspaceRoot: string, id: string, nowMs: number): boolean {
  const state = readPlanner(workspaceRoot);
  const current = state.items[id];
  if (!current) return false;
  const at = stamp(state, nowMs);
  state.items[id] = { ...current, deletedAt: at };
  state.outbox = enqueue(state.outbox, {
    idempotencyKey: `${id}:delete:${at.physical}.${at.logical}`,
    itemId: id, kind: 'delete', at, payload: {}, attempts: 0,
  });
  write(workspaceRoot, state);
  return true;
}

/* ------------------------------------------------------------------ blocks */

export function scheduleBlock(
  workspaceRoot: string,
  input: { itemId: string; scheduledFor?: string; estimateMinutes: number },
  nowMs: number,
): TimeBlock {
  const state = readPlanner(workspaceRoot);
  const at = stamp(state, nowMs);
  const id = newId('blk', nowMs);
  const block: TimeBlock = {
    id,
    itemId: input.itemId,
    ...(input.scheduledFor ? { scheduledFor: input.scheduledFor } : {}),
    estimateMinutes: input.estimateMinutes,
    carriedOver: 0,
  };
  state.blocks[id] = block;
  state.outbox = enqueue(state.outbox, {
    idempotencyKey: `${id}:create:${at.physical}.${at.logical}`,
    itemId: input.itemId, kind: 'update', at, payload: block, attempts: 0,
  });
  write(workspaceRoot, state);
  return block;
}

/** Record what a block actually took — D5's whole point. */
export function recordActual(
  workspaceRoot: string,
  blockId: string,
  actualMinutes: number,
  nowMs: number,
): TimeBlock | null {
  const state = readPlanner(workspaceRoot);
  const block = state.blocks[blockId];
  if (!block) return null;
  state.blocks[blockId] = {
    ...block,
    actualMinutes,
    completedAt: new Date(nowMs).toISOString(),
  };
  write(workspaceRoot, state);
  return state.blocks[blockId]!;
}

/* -------------------------------------------------------------------- reads */

/** Live items — not deleted. Completed ones are included; callers filter. */
export function listItems(
  workspaceRoot: string,
  opts: { includeCompleted?: boolean; source?: string } = {},
): PlannerItem[] {
  const state = readPlanner(workspaceRoot);
  return Object.values(state.items)
    .filter((i) => !i.deletedAt)
    .filter((i) => (opts.includeCompleted ? true : !i.completed?.value))
    .filter((i) => (opts.source ? i.source === opts.source : true))
    .sort((a, b) => (a.priority?.value ?? 99) - (b.priority?.value ?? 99));
}

export function listBlocks(workspaceRoot: string): TimeBlock[] {
  return Object.values(readPlanner(workspaceRoot).blocks);
}

export function getItem(workspaceRoot: string, id: string): PlannerItem | null {
  return readPlanner(workspaceRoot).items[id] ?? null;
}

/**
 * Items with an unresolved merge conflict.
 *
 * Surfaced as its own read because a conflict that nobody is shown is the same
 * as having discarded the losing edit — which is the outcome D4 refuses.
 */
export function listConflicts(workspaceRoot: string): PlannerItem[] {
  return Object.values(readPlanner(workspaceRoot).items)
    .filter((i) => i.conflicts && Object.keys(i.conflicts).length > 0);
}

/** Keep one side of a conflicted field and clear the marker. */
export function resolveConflict(
  workspaceRoot: string,
  id: string,
  field: string,
  keep: 'ours' | 'theirs',
  nowMs: number,
): PlannerItem | null {
  const state = readPlanner(workspaceRoot);
  const item = state.items[id];
  const conflict = item?.conflicts?.[field];
  if (!item || !conflict) return null;
  const at = stamp(state, nowMs);

  const chosen = keep === 'ours' ? conflict.ours : conflict.theirs;
  const rest = { ...item.conflicts };
  delete rest[field];

  state.items[id] = {
    ...item,
    ...(field === 'title' ? { title: value(String(chosen), at) } : {}),
    ...(field === 'notes' ? { notes: value(String(chosen), at) } : {}),
    ...(Object.keys(rest).length > 0 ? { conflicts: rest } : { conflicts: undefined }),
  };
  write(workspaceRoot, state);
  return state.items[id]!;
}
