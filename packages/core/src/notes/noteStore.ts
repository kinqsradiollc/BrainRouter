/**
 * ADR-029 Part B — the notes store, and the caller everything else needs.
 *
 * **User-scoped, not workspace-scoped (D1).** ADR-028 D9 recorded getting
 * exactly this wrong for the planner: notes are personal and cross-project, and
 * scoping them per repository would make the same note invisible from a
 * different checkout of the same work. The durable copy is the server's
 * `(org_id, user_id, id)` row; this file is the local cache, and with no server
 * configured it is authoritative — local-first means solo is the normal mode,
 * not a degraded one.
 *
 * Every mutation stamps an HLC (D3) and appends to the outbox (D2), and per B3
 * the outbox record is the BLOCK: two blocks of one page sync in parallel while
 * edits to a single block stay ordered.
 *
 * **An id carries the device that minted it.** The planner's does not — its ids
 * are `<time><counter>` with a module-level counter that restarts at zero with
 * the process — and that is survivable there because items are created rarely.
 * A block is created every time someone presses Enter, on every device, and the
 * server key is `(org_id, user_id, id)`, so a collision does not coexist: one
 * block merges into the other and a paragraph disappears.
 */
import path from 'node:path';
import { getBrainrouterHome, readJsonFile, writeJsonFile } from '../storage/store.js';
import { stableDeviceId } from '../sync/deviceId.js';
import { hlcNow, hlcZero, type Hlc } from '../sync/hybridClock.js';
import { emptyOutbox, enqueue, MAX_OUTBOX_AGE_MS, type OutboxState } from '../sync/outbox.js';
import type { Stamped } from '../sync/stamped.js';
import { isLiveBlock, isTextlessKind, type NoteBlock, type NoteBlockKind } from './block.js';
import {
  acquireBlockLease, fenceBlockWrite, releaseBlockLease, renewBlockLease,
  sweepBlockLeases, type BlockLease, type LeaseClaim, type LeaseOutcome,
} from './blockLease.js';
import { mergeNoteBlock, resolveBlockConflict } from './blockMerge.js';
import { DATABASE_BLOCK_KIND, defaultDatabaseSchema, defaultDatabaseViews } from './database.js';
import type { NoteDatabaseView } from './databaseView.js';
import type { NotePropertyDef, NotePropertyValue } from './properties.js';
import { buildNoteTree, subtreeBlockIds } from './noteTree.js';
import { compareRank, FIRST_RANK, rankBetween } from './rank.js';
import { deletedSubtreeIds, favouriteBlocks, listTrashEntries, type TrashEntry } from './trash.js';

export interface NotesState {
  schemaVersion: 1;
  /** This device's stable id, persisted so it cannot drift. */
  deviceId: string;
  /** Server revision this cache last saw, for `changed-since` pulls (D11). */
  lastPulledAt?: string;
  /** This device's clock. Persisted so ordering survives a restart. */
  clock: Hlc;
  blocks: Record<string, NoteBlock>;
  /**
   * Block locks, held BESIDE the content.
   *
   * Not a field on the block, because a lease is coordination and content is
   * merged by last-writer-wins — and a lease merged that way would hand the
   * lock to whichever device has the faster clock, regardless of who was
   * refused it. Kept out of the synced record for the same reason.
   */
  leases: Record<string, BlockLease>;
  outbox: OutboxState;
}

export function notesFile(userId?: string): string {
  const safe = (userId ?? 'local').replace(/[^A-Za-z0-9._-]/g, '_');
  return path.join(getBrainrouterHome(), `notes-${safe}.json`);
}

export function notesDeviceId(userId: string | undefined): string {
  return stableDeviceId(notesFile(userId));
}

export function readNotes(userId: string | undefined): NotesState {
  const deviceId = notesDeviceId(userId);
  const stored = readJsonFile<Partial<NotesState>>(notesFile(userId), {});
  return {
    schemaVersion: 1,
    // A stored file from a previous schema may be missing whole sections; a
    // notes surface that throws on read is worse than one that starts empty.
    deviceId: stored.deviceId ?? deviceId,
    ...(stored.lastPulledAt ? { lastPulledAt: stored.lastPulledAt } : {}),
    clock: stored.clock ?? hlcZero(stored.deviceId ?? deviceId),
    blocks: stored.blocks ?? {},
    leases: stored.leases ?? {},
    outbox: stored.outbox ?? emptyOutbox(),
  };
}

/**
 * Persist. Exported because the sync client mutates the state it is given
 * (advancing the clock, draining the outbox) and the caller has to write the
 * result — a sync whose outcome is not persisted repeats the same push.
 */
export function writeNotes(userId: string | undefined, state: NotesState): void {
  writeJsonFile(notesFile(userId), state);
}

function stamp(state: NotesState, nowMs: number): Hlc {
  const next = hlcNow(state.clock, nowMs);
  state.clock = next;
  return next;
}

let counter = 0;
function newBlockId(deviceId: string, nowMs: number): string {
  counter = (counter + 1) % 100_000;
  return `blk_${nowMs.toString(36)}${counter.toString(36)}_${deviceId}`;
}

const value = <T>(v: T, at: Hlc): Stamped<T> => ({ value: v, at });

function liveBlocks(state: NotesState): NoteBlock[] {
  return Object.values(state.blocks).filter(isLiveBlock);
}

function siblingsOf(state: NotesState, parentId: string | null): NoteBlock[] {
  return liveBlocks(state)
    .filter((b) => (b.parentId.value ?? null) === parentId)
    .sort((a, b) => compareRank({ rank: a.rank.value, id: a.id }, { rank: b.rank.value, id: b.id }));
}

/**
 * Where a new or moved block lands among its siblings.
 *
 * `after`/`before` name a sibling rather than an index, because an index means
 * something different on two devices whose sibling lists differ by one pending
 * insert — and "put it under the line I am looking at" is what the person
 * actually asked for.
 */
export interface BlockPosition {
  parentId?: string | null;
  after?: string;
  before?: string;
}

function rankFor(state: NotesState, parentId: string | null, at: BlockPosition, movingId?: string): string {
  const siblings = siblingsOf(state, parentId).filter((b) => b.id !== movingId);
  if (siblings.length === 0) return FIRST_RANK;

  if (at.after) {
    const index = siblings.findIndex((b) => b.id === at.after);
    if (index >= 0) return rankBetween(siblings[index]!.rank.value, siblings[index + 1]?.rank.value ?? null);
  }
  if (at.before) {
    const index = siblings.findIndex((b) => b.id === at.before);
    if (index >= 0) return rankBetween(siblings[index - 1]?.rank.value ?? null, siblings[index]!.rank.value);
  }
  return rankBetween(siblings[siblings.length - 1]!.rank.value, null);
}

/* --------------------------------------------------------------- mutations */

export interface CreateBlockInput extends BlockPosition {
  kind?: NoteBlockKind;
  text?: string;
  level?: number;
  checked?: boolean;
  language?: string;
  collapsed?: boolean;
  icon?: string;
  cover?: string;
  favourite?: boolean;
  /** E3 — a row's property values, keyed by property id. */
  props?: Record<string, NotePropertyValue>;
  /** E3 — a database block's property definitions. */
  schema?: readonly NotePropertyDef[];
  /** E3 — a database block's stored projections. */
  views?: readonly NoteDatabaseView[];
}

/** Stamp every written property value with this edit's clock, keeping the rest. */
function stampProps(
  current: NoteBlock['props'],
  written: Record<string, NotePropertyValue>,
  at: Hlc,
): NoteBlock['props'] {
  const next: NonNullable<NoteBlock['props']> = { ...(current ?? {}) };
  for (const [key, value] of Object.entries(written)) next[key] = { value, at };
  return next;
}

export function createBlock(
  userId: string | undefined,
  input: CreateBlockInput,
  nowMs: number,
): NoteBlock {
  const state = readNotes(userId);
  const at = stamp(state, nowMs);
  const id = newBlockId(state.deviceId, nowMs);

  const parentId = input.parentId ?? null;
  const kind = input.kind ?? 'paragraph';
  // E3 — a database arrives with a schema and a table view, whichever path made
  // it. Seeding here rather than in `createDatabase` is what keeps the slash
  // menu's `/database` and the explicit call producing the same block: a
  // database created without a schema would render as a container with no
  // columns, and the person would conclude the feature is broken.
  const seeded = kind === DATABASE_BLOCK_KIND && !input.schema
    ? { schema: defaultDatabaseSchema(), views: input.views ?? defaultDatabaseViews(defaultDatabaseSchema()) }
    : { ...(input.schema ? { schema: input.schema } : {}), ...(input.views ? { views: input.views } : {}) };

  const block: NoteBlock = {
    id,
    parentId: value(parentId, at),
    rank: value(rankFor(state, parentId, input), at),
    kind: value(kind, at),
    text: value(isTextlessKind(kind) && !input.text ? '' : (input.text ?? ''), at),
    ...(input.props ? { props: stampProps(undefined, input.props, at) } : {}),
    ...(seeded.schema ? { schema: value(seeded.schema, at) } : {}),
    ...(seeded.views ? { views: value(seeded.views, at) } : {}),
    ...(input.level !== undefined ? { level: value(input.level, at) } : {}),
    ...(input.checked !== undefined ? { checked: value(input.checked, at) } : {}),
    ...(input.language !== undefined ? { language: value(input.language, at) } : {}),
    ...(input.collapsed !== undefined ? { collapsed: value(input.collapsed, at) } : {}),
    ...(input.icon !== undefined ? { icon: value(input.icon, at) } : {}),
    ...(input.cover !== undefined ? { cover: value(input.cover, at) } : {}),
    ...(input.favourite !== undefined ? { favourite: value(input.favourite, at) } : {}),
  };

  state.blocks[id] = block;
  state.outbox = enqueue(state.outbox, {
    idempotencyKey: `${id}:create:${at.physical}.${at.logical}`,
    itemId: id,
    kind: 'create',
    at,
    // The RANK travels, not just the `after`/`before` that produced it. The
    // server holds a different set of siblings — this device may have three
    // unsynced insertions above — so re-deriving the rank there yields a
    // different string under the same stamp, and the two never reconcile
    // because neither edit is newer. The placing device decides; everyone else
    // merges the value.
    //
    // The SEEDED schema travels too, for the same reason: a server that received
    // a database with no columns would hand a schema-less one to the dashboard,
    // which has no local store to repair it from.
    payload: {
      ...input, id, rank: block.rank.value,
      ...(block.schema ? { schema: block.schema.value } : {}),
      ...(block.views ? { views: block.views.value } : {}),
    },
    attempts: 0,
  });
  writeNotes(userId, state);
  return block;
}

/** B4 — a page is a block, so this is `createBlock` with one argument fixed. */
export function createPage(
  userId: string | undefined,
  input: { title: string; parentId?: string | null },
  nowMs: number,
): NoteBlock {
  return createBlock(userId, { kind: 'page', text: input.title, parentId: input.parentId ?? null }, nowMs);
}

export interface UpdateBlockInput {
  text?: string;
  kind?: NoteBlockKind;
  level?: number;
  checked?: boolean;
  language?: string;
  collapsed?: boolean;
  /** A page's icon or a callout's glyph — see `NoteBlock.icon` for why one field. */
  icon?: string;
  cover?: string;
  favourite?: boolean;
  /**
   * E3 — property values to write on a row, keyed by property id.
   *
   * A PARTIAL map: only the keys present are written, and each is stamped
   * separately, so setting one cell never re-stamps the others. Writing the
   * whole map would make one device's status change outrank every other cell it
   * happened to be holding a stale copy of.
   */
  props?: Record<string, NotePropertyValue>;
  schema?: readonly NotePropertyDef[];
  views?: readonly NoteDatabaseView[];
}

export type BlockWriteResult =
  | {
      ok: true;
      block: NoteBlock;
      /** Which path the fence chose. `merge` may have produced a conflict. */
      path: 'leased' | 'merge';
      conflicted: boolean;
      /** Present on the merge path: why the write was not treated as owned. */
      note?: string;
    }
  | { ok: false; reason: 'not_found' }
  | { ok: false; reason: 'locked'; holder: BlockLease; detail: string }
  | { ok: false; reason: 'would_nest_inside_itself'; detail: string };

/**
 * Apply an edit, through the fence and then through D4.
 *
 * The two halves are both load-bearing. The FENCE decides whether this device
 * may write as the owner; a stale claim does not lose the edit, it demotes it
 * to a merge (see `fenceBlockWrite`). The MERGE is then applied even for a
 * purely local edit, so D4's rules are exercised on the one path rather than on
 * a sync path that gets tested less.
 *
 * The queued operation carries the epoch this edit was AUTHORED under, not the
 * epoch at flush time. That distinction is the whole point: a device that slept
 * mid-edit and wakes up holding a reissued lock would otherwise re-stamp its
 * stale edit as fresh and land it on top of what happened while it was gone —
 * which is migration 048's defect exactly, moved up a layer.
 *
 * It carries that epoch whether or not the lease is still good. Sending it only
 * on the owner's path is the same leak in reverse: a device whose lease lapsed
 * would send NOTHING, and no epoch means "not claiming ownership" — a fresh
 * edit on a block nothing holds. The server cannot tell that apart from a
 * device that never claimed the block, so the one write that most needs fencing
 * arrives as the one write that cannot be fenced. What the server needs is not
 * whether the lock is still valid — it is the only side that can decide that —
 * but which lock this sentence was written under.
 */
export function updateBlock(
  userId: string | undefined,
  id: string,
  input: UpdateBlockInput,
  nowMs: number,
): BlockWriteResult {
  const state = readNotes(userId);
  const current = state.blocks[id];
  if (!current) return { ok: false, reason: 'not_found' };

  const lease = state.leases[id];
  // Every lease record this device has ever taken on this block counts, live or
  // lapsed — `releaseBlockLease` ends the term without dropping the record for
  // exactly this reason. The epoch is what the edit was written under, not a
  // claim that it is still good.
  const authoredUnder = lease && lease.deviceId === state.deviceId ? lease.epoch : undefined;
  const fence = fenceBlockWrite(lease, { deviceId: state.deviceId, epoch: authoredUnder }, nowMs);
  if (fence.path === 'blocked') {
    return { ok: false, reason: 'locked', holder: fence.holder, detail: fence.detail };
  }

  const at = stamp(state, nowMs);
  // E3 — a line CONVERTED into a database gets the same seed a created one does.
  // The slash menu turns an empty paragraph into a database through this path,
  // and a database with no schema would render as a container with no columns —
  // a different outcome from the same gesture depending on which code path made
  // the block.
  const seed = input.kind === DATABASE_BLOCK_KIND && !current.schema && !input.schema
    ? { schema: defaultDatabaseSchema(), views: defaultDatabaseViews(defaultDatabaseSchema()) }
    : null;

  const edit: NoteBlock = {
    ...current,
    ...(input.text !== undefined ? { text: value(input.text, at) } : {}),
    ...(input.kind !== undefined ? { kind: value(input.kind, at) } : {}),
    ...(input.level !== undefined ? { level: value(input.level, at) } : {}),
    ...(input.checked !== undefined ? { checked: value(input.checked, at) } : {}),
    ...(input.language !== undefined ? { language: value(input.language, at) } : {}),
    ...(input.collapsed !== undefined ? { collapsed: value(input.collapsed, at) } : {}),
    ...(input.icon !== undefined ? { icon: value(input.icon, at) } : {}),
    ...(input.cover !== undefined ? { cover: value(input.cover, at) } : {}),
    ...(input.favourite !== undefined ? { favourite: value(input.favourite, at) } : {}),
    ...(input.props ? { props: stampProps(current.props, input.props, at) } : {}),
    ...(input.schema ? { schema: value(input.schema, at) } : {}),
    ...(input.views ? { views: value(input.views, at) } : {}),
    ...(seed ? { schema: value(seed.schema, at), views: value(seed.views, at) } : {}),
  };

  const merged = mergeNoteBlock(current, edit);
  state.blocks[id] = merged;
  state.outbox = enqueue(state.outbox, {
    idempotencyKey: `${id}:update:${at.physical}.${at.logical}`,
    itemId: id,
    kind: 'update',
    at,
    payload: {
      ...input,
      // The seed travels, or the server would hold a database with no columns
      // and the dashboard has no local store to repair it from.
      ...(seed ?? {}),
      ...(authoredUnder === undefined ? {} : { leaseEpoch: authoredUnder }),
    },
    attempts: 0,
  });
  writeNotes(userId, state);

  return {
    ok: true,
    block: merged,
    path: fence.path,
    conflicted: Object.keys(merged.conflicts ?? {}).length > 0,
    ...(fence.path === 'merge' && fence.reason !== 'no_lease' ? { note: fence.detail } : {}),
  };
}

/**
 * Move a block, refusing to nest it inside its own subtree.
 *
 * Refused locally rather than repaired later. `buildNoteTree` can break a cycle
 * that two devices produced concurrently, but a cycle one device could see
 * coming and made anyway is a different thing: the block would vanish from
 * where the person dropped it and reappear at the top with a repair notice, for
 * an action that was simply not possible.
 */
export function moveBlock(
  userId: string | undefined,
  id: string,
  to: BlockPosition,
  nowMs: number,
): BlockWriteResult {
  const state = readNotes(userId);
  const current = state.blocks[id];
  if (!current) return { ok: false, reason: 'not_found' };

  const parentId = to.parentId === undefined ? (current.parentId.value ?? null) : to.parentId;
  if (parentId !== null && subtreeBlockIds(Object.values(state.blocks), id).includes(parentId)) {
    return {
      ok: false,
      reason: 'would_nest_inside_itself',
      detail: 'A block cannot be moved inside one of its own children.',
    };
  }

  const at = stamp(state, nowMs);
  const moved: NoteBlock = {
    ...current,
    parentId: value(parentId, at),
    rank: value(rankFor(state, parentId, to, id), at),
  };
  state.blocks[id] = moved;
  state.outbox = enqueue(state.outbox, {
    idempotencyKey: `${id}:move:${at.physical}.${at.logical}`,
    itemId: id, kind: 'update', at, payload: { parentId, rank: moved.rank.value }, attempts: 0,
  });
  writeNotes(userId, state);
  return { ok: true, block: moved, path: 'merge', conflicted: false };
}

/**
 * Delete as a tombstone, and take the subtree with it.
 *
 * The tombstone is D4's rule and C5's: a later edit arriving from another
 * device must be able to resurrect this as conflicted, which removing the
 * record outright would turn into a creation, silently un-happening the delete.
 * References to it survive and render as tombstones — deleting a target never
 * deletes the link.
 *
 * The subtree goes too, and explicitly rather than by implication. A child left
 * live under a deleted parent is not deleted and not reachable: present in the
 * data, absent from every page. `buildNoteTree` would surface it at the top
 * level as an orphan, which means deleting a page would scatter its contents
 * across the sidebar.
 */
export function deleteBlock(userId: string | undefined, id: string, nowMs: number): string[] {
  const state = readNotes(userId);
  if (!state.blocks[id]) return [];

  const ids = subtreeBlockIds(Object.values(state.blocks), id);
  for (const blockId of ids) {
    const block = state.blocks[blockId];
    if (!block || !isLiveBlock(block)) continue;
    const at = stamp(state, nowMs);
    state.blocks[blockId] = { ...block, deletedAt: at };
    state.outbox = enqueue(state.outbox, {
      idempotencyKey: `${blockId}:delete:${at.physical}.${at.logical}`,
      itemId: blockId, kind: 'delete', at, payload: {}, attempts: 0,
    });
  }
  writeNotes(userId, state);
  return ids;
}

/**
 * Take a delete back — E4's "trash with restore", and the whole of it.
 *
 * The subtree comes back because the subtree went: `deleteBlock` tombstoned
 * every descendant, so restoring only the root would put an empty page back and
 * leave its contents in the trash as forty separate entries nobody can
 * reassemble.
 *
 * A restore is its own stamped event rather than a delete of the tombstone.
 * Clearing the field would leave this device with no way to tell a peer still
 * holding the delete that the deletion was already decided about — its next
 * push would simply re-delete the block, and the person would watch the page
 * they restored vanish again a few seconds later.
 */
export function restoreBlock(userId: string | undefined, id: string, nowMs: number): string[] {
  const state = readNotes(userId);
  const ids = deletedSubtreeIds(Object.values(state.blocks), id);
  if (ids.length === 0) return [];

  for (const blockId of ids) {
    const block = state.blocks[blockId];
    if (!block || isLiveBlock(block)) continue;
    const at = stamp(state, nowMs);
    state.blocks[blockId] = { ...block, restoredAt: at };
    state.outbox = enqueue(state.outbox, {
      idempotencyKey: `${blockId}:restore:${at.physical}.${at.logical}`,
      itemId: blockId, kind: 'update', at, payload: { restore: true }, attempts: 0,
    });
  }
  writeNotes(userId, state);
  return ids;
}

/* ------------------------------------------------------------------ leases */

/** Take the lock before typing. B2's prevention half. */
export function beginEditing(
  userId: string | undefined,
  blockId: string,
  nowMs: number,
  holder?: string,
): LeaseOutcome {
  const state = readNotes(userId);
  const outcome = acquireBlockLease(
    state.leases[blockId],
    { blockId, deviceId: state.deviceId, ...(holder ? { holder } : {}) },
    nowMs,
  );
  if (outcome.ok) {
    state.leases[blockId] = outcome.lease;
    state.leases = sweepBlockLeases(state.leases, nowMs, MAX_OUTBOX_AGE_MS);
    writeNotes(userId, state);
  }
  return outcome;
}

/** Q1's "renewed while typing". */
export function keepEditing(
  userId: string | undefined,
  blockId: string,
  claim: LeaseClaim,
  nowMs: number,
): LeaseOutcome {
  const state = readNotes(userId);
  const outcome = renewBlockLease(state.leases[blockId], claim, nowMs);
  if (outcome.ok) {
    state.leases[blockId] = outcome.lease;
    writeNotes(userId, state);
  }
  return outcome;
}

export function endEditing(
  userId: string | undefined,
  blockId: string,
  claim: LeaseClaim,
  nowMs: number,
): LeaseOutcome {
  const state = readNotes(userId);
  const outcome = releaseBlockLease(state.leases[blockId], claim, nowMs);
  if (outcome.ok) {
    state.leases[blockId] = outcome.lease;
    writeNotes(userId, state);
  }
  return outcome;
}

/* -------------------------------------------------------------------- reads */

export function listBlocks(userId: string | undefined): NoteBlock[] {
  return Object.values(readNotes(userId).blocks).filter(isLiveBlock);
}

/** Every block including tombstones — what the trash and a restore need. */
export function listAllBlocks(userId: string | undefined): NoteBlock[] {
  return Object.values(readNotes(userId).blocks);
}

/** C5's tombstones, read as a trash. A projection, never a second table. */
export function listTrash(userId: string | undefined): TrashEntry[] {
  return listTrashEntries(Object.values(readNotes(userId).blocks));
}

export function listFavourites(userId: string | undefined): NoteBlock[] {
  return favouriteBlocks(Object.values(readNotes(userId).blocks));
}

export function getBlock(userId: string | undefined, id: string): NoteBlock | null {
  return readNotes(userId).blocks[id] ?? null;
}

export function noteTree(userId: string | undefined) {
  return buildNoteTree(Object.values(readNotes(userId).blocks));
}

/**
 * Blocks with an unresolved merge conflict.
 *
 * Its own read because a conflict nobody is shown is the same as having
 * discarded the losing edit — the outcome D4 refuses.
 */
export function listConflicts(userId: string | undefined): NoteBlock[] {
  return Object.values(readNotes(userId).blocks)
    .filter((b) => b.conflicts && Object.keys(b.conflicts).length > 0);
}

export function resolveConflict(
  userId: string | undefined,
  id: string,
  field: string,
  keep: 'ours' | 'theirs',
  nowMs: number,
): NoteBlock | null {
  const state = readNotes(userId);
  const block = state.blocks[id];
  if (!block) return null;
  const at = stamp(state, nowMs);
  const resolved = resolveBlockConflict(block, field, keep, at);
  if (!resolved) return null;

  state.blocks[id] = resolved;
  state.outbox = enqueue(state.outbox, {
    idempotencyKey: `${id}:resolve:${at.physical}.${at.logical}`,
    itemId: id, kind: 'update', at, payload: { field, keep }, attempts: 0,
  });
  writeNotes(userId, state);
  return resolved;
}
