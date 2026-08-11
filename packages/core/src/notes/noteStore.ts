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
import { blockWrittenAt, mergeNoteBlock, resolveBlockConflict } from './blockMerge.js';
import {
  boundCommentAuthor, boundCommentBody, newCommentId, type NoteComment,
} from './comment.js';
import { DATABASE_BLOCK_KIND, defaultDatabaseSchema, defaultDatabaseViews } from './database.js';
import type { NoteDatabaseView } from './databaseView.js';
import {
  describeRefusedUndo, emptyNoteHistory, entryWriteTargets, newestEntryIndex, pushUndoEntry,
  remoteChangeUnder, UNDO_LABELS,
  type NoteHistory, type NoteInverseOp, type NoteUndoEntry,
} from './noteHistory.js';
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
  /**
   * F4 — the page-level undo stacks, held BESIDE the content and never synced.
   *
   * Local for the same reason a lease is: an inverse operation is this device's
   * record of what this device just did, and a stack merged across devices would
   * let ⌘Z on a laptop take back a paragraph typed on a phone — which is not
   * undo, it is a remote edit with a friendly keyboard shortcut.
   *
   * Persisted rather than held in memory because the store is re-read on every
   * call: the host answers each IPC message from the file, so a stack in a
   * module variable would survive a re-render (which is what F4 asks for) and
   * nothing else. Bounded in `noteHistory.ts`.
   */
  history: NoteHistory;
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
    history: stored.history ?? emptyNoteHistory(),
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

/**
 * Mint an id before executing a pure gesture plan.
 *
 * Creation still happens through `createBlock`; this only lets the planner put
 * the same id in its result, its reference rewrites and the eventual outbox
 * operation. A remote host supplies its own deterministic mint function.
 */
export function mintNoteBlockId(userId: string | undefined, nowMs: number): string {
  return newBlockId(notesDeviceId(userId), nowMs);
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
  /**
   * F4 — the exact rank, for a caller that already knows it.
   *
   * Only an inverse operation uses this. `after`/`before` re-derive a rank from
   * the siblings that are there NOW, and undoing a move has to put the block
   * back where it was rather than where a neighbour has since ended up — the
   * neighbour may have been deleted, or three blocks may have been inserted
   * above it. An undo that lands "roughly there" is not an undo.
   */
  rank?: string;
}

function rankFor(state: NotesState, parentId: string | null, at: BlockPosition, movingId?: string): string {
  if (at.rank !== undefined) return at.rank;
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

/* ------------------------------------------------------- F4: recording undo */

/**
 * The gesture currently being recorded as ONE ⌘Z, or null.
 *
 * Module-level because a gesture is several store calls — a split writes the
 * head and then creates the tail; a merge writes the block above, re-parents the
 * children and then deletes — and F4's requirement is that the whole gesture is
 * one step back. Threading a group id through every signature would put the
 * bookkeeping in every caller, and the caller that forgot would be the gesture
 * ⌘Z silently broke in half.
 *
 * Safe as module state because these mutations are SYNCHRONOUS: each one reads
 * the file, changes it and writes it before returning, so there is no point at
 * which two gestures interleave. If a mutation here ever becomes async, this
 * has to move into the state file with it.
 */
let openGroup: {
  label: string;
  /** Set by the first recorded operation, while the blocks it names still exist. */
  pageId: string | null;
  started: boolean;
  ops: NoteInverseOp[];
  guard: Record<string, Hlc>;
} | null = null;

/**
 * Which stack the inverses being recorded belong on.
 *
 * `past` is the normal case. While an undo is being APPLIED the inverses of its
 * own operations are the redo, so they go to `future`; while a redo is applied
 * they go back to `past`. Without this, applying an undo would push a new
 * ordinary entry and ⌘Z would oscillate between two states forever.
 */
let recordingTo: 'past' | 'future' = 'past';

/**
 * True while an undo or a redo is being applied.
 *
 * It stops the redo branch being cleared: an ordinary edit abandons everything
 * ⌘⇧Z could have replayed, but a redo IS the replay, and clearing on it would
 * make the second ⌘⇧Z of a run do nothing.
 */
let applying = false;

let entryCounter = 0;
function newEntryId(deviceId: string, nowMs: number): string {
  entryCounter = (entryCounter + 1) % 100_000;
  return `und_${nowMs.toString(36)}${entryCounter.toString(36)}_${deviceId}`;
}

/**
 * Which page's stack an operation on this block belongs to.
 *
 * The nearest CONTAINER ancestor — a page or E3's database — which is the same
 * answer the surfaces use to decide what a page's body contains. `null` is the
 * top level, which B4 makes a real page rather than an absence.
 *
 * A container's OWN creation belongs to the page it was created on, not to
 * itself: pressing ⌘Z after making a sub-page should take the sub-page back
 * while you are still looking at the page you made it from.
 */
function pageIdOf(state: NotesState, blockId: string): string | null {
  const seen = new Set<string>([blockId]);
  let cursor = state.blocks[blockId]?.parentId.value ?? null;
  while (cursor !== null && !seen.has(cursor)) {
    seen.add(cursor);
    const parent = state.blocks[cursor];
    if (!parent) return null;
    const kind = parent.kind.value;
    if (kind === 'page' || kind === DATABASE_BLOCK_KIND) return parent.id;
    cursor = parent.parentId.value ?? null;
  }
  return null;
}

/**
 * Record one inverse, either into the open gesture or as a step of its own.
 *
 * Called with the state already mutated, so `guard` carries the stamp this
 * device has just written — which is exactly what `remoteChangeUnder` needs to
 * tell "nothing has happened since" from "somebody else has been here".
 */
function record(
  state: NotesState,
  op: NoteInverseOp,
  ctx: { label: string; pageId: string | null; at: Hlc },
): void {
  const ids = op.op === 'restore' ? op.blockIds : [op.blockId];
  if (openGroup) {
    if (!openGroup.started) { openGroup.pageId = ctx.pageId; openGroup.started = true; }
    openGroup.ops.push(op);
    for (const id of ids) openGroup.guard[id] = ctx.at;
    return;
  }
  const entry: NoteUndoEntry = {
    id: newEntryId(state.deviceId, ctx.at.physical),
    label: ctx.label,
    pageId: ctx.pageId,
    ops: [op],
    guard: Object.fromEntries(ids.map((id) => [id, ctx.at])),
    at: ctx.at,
  };
  commit(state, entry);
}

function commit(state: NotesState, entry: NoteUndoEntry): void {
  if (recordingTo === 'future') {
    state.history = { past: state.history.past, future: pushUndoEntry(state.history.future, entry) };
    return;
  }
  state.history = {
    past: pushUndoEntry(state.history.past, entry),
    // A fresh edit abandons the redo branch, or ⌘⇧Z would replay something that
    // never happened after it — the same rule the text history already follows.
    future: applying ? state.history.future : [],
  };
}

/**
 * Perform several mutations as ONE step back.
 *
 * The gestures in `blockOps` are the callers that need it: F4's sentence is that
 * "a split, merge, indent or delete is one ⌘Z", and a split is two writes.
 *
 * Synchronous by signature, deliberately. An async body would let a second
 * gesture start while this one's group was open, and the two would be recorded
 * as one entry — so ⌘Z would take back an edit the person made afterwards.
 */
export function asOneUndo<T>(userId: string | undefined, label: string, fn: () => T): T {
  // A nested call joins the group it is inside rather than opening a second one:
  // `duplicateBlock` is one gesture whether it is invoked directly or from a
  // template instantiation that is itself one gesture.
  if (openGroup) return fn();

  openGroup = { label, pageId: null, started: false, ops: [], guard: {} };
  let result: T;
  try {
    result = fn();
  } catch (error) {
    openGroup = null;
    throw error;
  }
  const group = openGroup;
  openGroup = null;
  if (group.ops.length === 0) return result;

  const state = readNotes(userId);
  const at = stamp(state, Date.now());
  commit(state, {
    id: newEntryId(state.deviceId, at.physical),
    label,
    pageId: group.pageId,
    ops: group.ops,
    guard: group.guard,
    at,
  });
  writeNotes(userId, state);
  return result;
}

/* --------------------------------------------------------------- mutations */

export interface CreateBlockInput extends BlockPosition {
  /** An id already minted by a Core gesture plan. Ordinary callers omit it. */
  id?: string;
  kind?: NoteBlockKind;
  text?: string;
  level?: number;
  checked?: boolean;
  language?: string;
  collapsed?: boolean;
  icon?: string;
  cover?: string;
  favourite?: boolean;
  template?: boolean;
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
  const id = input.id ?? newBlockId(state.deviceId, nowMs);
  if (state.blocks[id]) throw new Error(`Block id ${id} already exists.`);

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
    // F3 — creation is recorded once, here, because nothing downstream can
    // recover it: every stamp on the block moves forward when its field is
    // edited, so a "Created" column derived from them would drift.
    createdAt: at,
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
    ...(input.template !== undefined ? { template: value(input.template, at) } : {}),
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
  // F4 — the inverse of a creation is a tombstone, not a removal. Removing the
  // record would make the redo a second creation with a second id, so ⌘⇧Z would
  // leave two copies on a page where a person expects one.
  record(state, { op: 'delete', blockId: id }, {
    label: UNDO_LABELS.insert, pageId: pageIdOf(state, id), at,
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
  /** F3 — mark a page as something to start FROM. See `NoteBlock.template`. */
  template?: boolean;
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
    ...(input.template !== undefined ? { template: value(input.template, at) } : {}),
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
  // F4 — the previous values of exactly the fields this write touched. Recorded
  // from `current` rather than from the merge, because the inverse has to put
  // back what was there before this device wrote, and the merge result may
  // already contain another device's value that this undo must not touch.
  record(state, { op: 'fields', blockId: id, fields: inverseFields(current, input) }, {
    label: UNDO_LABELS.edit, pageId: pageIdOf(state, id), at,
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
 * F4 — the previous value of every field an update is about to write.
 *
 * **An absent field is written back as its NEUTRAL value, not as an absence.**
 * The store has no "unset" and the server's patch format has none either, so an
 * inverse that tried to remove a field would diverge from what the server holds
 * — the undo would look right here and not have happened there. For every
 * optional field on a block the neutral value renders identically to absence: an
 * unchecked box, an unfolded toggle, no icon, no language.
 *
 * `level` is the one exception and it is skipped rather than defaulted. It only
 * means anything on a heading, and the write that introduced it also changed the
 * kind — so the inverse restores the non-heading kind and the stale level is
 * unreachable. Writing `level: 1` back would be inventing a heading level nobody
 * chose, on a block that is not a heading.
 */
function inverseFields(current: NoteBlock, input: UpdateBlockInput): UpdateBlockInput {
  const out: UpdateBlockInput = {};
  if (input.text !== undefined) out.text = current.text.value;
  if (input.kind !== undefined) out.kind = current.kind.value;
  if (input.level !== undefined && current.level) out.level = current.level.value;
  if (input.checked !== undefined) out.checked = current.checked?.value === true;
  if (input.language !== undefined) out.language = current.language?.value ?? '';
  if (input.collapsed !== undefined) out.collapsed = current.collapsed?.value === true;
  if (input.icon !== undefined) out.icon = current.icon?.value ?? '';
  if (input.cover !== undefined) out.cover = current.cover?.value ?? '';
  if (input.favourite !== undefined) out.favourite = current.favourite?.value === true;
  if (input.template !== undefined) out.template = current.template?.value === true;
  if (input.props) {
    // E3 stores a cleared cell as a stamped `null` rather than a removed key, so
    // "there was nothing here" is expressible for a property and the inverse of
    // setting one is exact.
    const props: Record<string, NotePropertyValue> = {};
    for (const key of Object.keys(input.props)) props[key] = current.props?.[key]?.value ?? null;
    out.props = props;
  }
  if (input.schema && current.schema) out.schema = current.schema.value;
  if (input.views && current.views) out.views = current.views.value;
  return out;
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

  const wasUnder = current.parentId.value ?? null;
  const wasAt = current.rank.value;

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
  // F4 — the EXACT place it came from. Re-deriving it from a neighbour would put
  // the block back next to whatever now sits where that neighbour was.
  record(state, { op: 'place', blockId: id, parentId: wasUnder, rank: wasAt }, {
    label: UNDO_LABELS.move, pageId: pageIdOf(state, id), at,
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

  // Resolved BEFORE the tombstones: once the subtree is deleted the walk that
  // finds its page has nothing live to walk.
  const pageId = pageIdOf(state, id);
  const ids = subtreeBlockIds(Object.values(state.blocks), id);
  const tombstoned: string[] = [];
  let lastAt: Hlc | null = null;
  for (const blockId of ids) {
    const block = state.blocks[blockId];
    if (!block || !isLiveBlock(block)) continue;
    const at = stamp(state, nowMs);
    lastAt = at;
    state.blocks[blockId] = { ...block, deletedAt: at };
    tombstoned.push(blockId);
    state.outbox = enqueue(state.outbox, {
      idempotencyKey: `${blockId}:delete:${at.physical}.${at.logical}`,
      itemId: blockId, kind: 'delete', at, payload: {}, attempts: 0,
    });
  }
  // F4 — the whole subtree comes back, at its own ranks, under its own parents.
  // "An empty block at the end" is the outcome F4 names as not being an undo,
  // and it is what restoring only the root would produce.
  if (lastAt && tombstoned.length > 0) {
    record(state, { op: 'restore', blockIds: tombstoned }, {
      label: UNDO_LABELS.delete, pageId, at: lastAt,
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
  const ids = deletedSubtreeIds(Object.values(readNotes(userId).blocks), id);
  return restoreBlocks(userId, ids, id, nowMs);
}

/**
 * Restore exactly these blocks — F4's inverse of a delete.
 *
 * Separate from `restoreBlock` because an undo knows precisely which blocks its
 * delete tombstoned, and re-deriving the set from the tree would include
 * anything deleted separately in the meantime. The two share a body so a restore
 * from the trash and a restore from ⌘Z cannot come to differ.
 */
export function restoreBlocks(
  userId: string | undefined,
  ids: readonly string[],
  rootId: string,
  nowMs: number,
): string[] {
  const state = readNotes(userId);
  if (ids.length === 0) return [];

  const restored: string[] = [];
  let lastAt: Hlc | null = null;
  for (const blockId of ids) {
    const block = state.blocks[blockId];
    if (!block || isLiveBlock(block)) continue;
    const at = stamp(state, nowMs);
    lastAt = at;
    state.blocks[blockId] = { ...block, restoredAt: at };
    restored.push(blockId);
    state.outbox = enqueue(state.outbox, {
      idempotencyKey: `${blockId}:restore:${at.physical}.${at.logical}`,
      itemId: blockId, kind: 'update', at, payload: { restore: true }, attempts: 0,
    });
  }
  // F4 — ONE op for the whole restore, so ⌘Z after taking a page out of the
  // trash puts the page back rather than removing it a line at a time. Deleting
  // the root takes the subtree with it (`deleteBlock`'s own rule), which is
  // exactly the set this restore brought out.
  if (lastAt && restored.length > 0) {
    record(state, { op: 'delete', blockId: rootId }, {
      label: UNDO_LABELS.restore, pageId: pageIdOf(state, rootId), at: lastAt,
    });
  }
  writeNotes(userId, state);
  return restored;
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
  expected: { oursAt: Hlc; theirsAt: Hlc },
): NoteBlock | null {
  const state = readNotes(userId);
  const block = state.blocks[id];
  if (!block) return null;
  const conflict = block.conflicts?.[field];
  if (!conflict || !sameHlc(conflict.oursAt, expected.oursAt)
    || !sameHlc(conflict.theirsAt, expected.theirsAt)) return null;
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

function sameHlc(left: Hlc, right: Hlc): boolean {
  return left.physical === right.physical
    && left.logical === right.logical
    && left.deviceId === right.deviceId;
}

/* ------------------------------------------------------- F3: comments (C5) */

export type CommentWriteResult =
  | { ok: true; block: NoteBlock; comment: NoteComment }
  | { ok: false; reason: 'not_found' };

/**
 * Write one comment onto a block, through the same merge every field uses.
 *
 * **The lease is deliberately NOT consulted.** B2's lock exists so two people do
 * not type into one paragraph at once; a comment is not the paragraph, and
 * refusing to leave a remark because somebody is editing the line is refusing
 * the one thing you most want to do while they are working on it. Comments
 * merge per key (`mergeComments`), so concurrent comments from two devices both
 * land — which is the outcome a lock would have been protecting against
 * elsewhere and is simply correct here.
 *
 * **Not recorded on the undo stack, and that is a decision rather than a gap.**
 * ⌘Z after typing a paragraph must not silently retract a remark addressed to
 * somebody else; a comment is taken back with a gesture that says so
 * (`removeComment`), which leaves a tombstone the other device can see.
 */
function writeComment(
  userId: string | undefined,
  blockId: string,
  commentId: string,
  change: (existing: NoteComment | undefined, at: Hlc) => NoteComment | null,
  nowMs: number,
): CommentWriteResult {
  const state = readNotes(userId);
  const current = state.blocks[blockId];
  if (!current) return { ok: false, reason: 'not_found' };

  const at = stamp(state, nowMs);
  const next = change(current.comments?.[commentId], at);
  if (!next) return { ok: false, reason: 'not_found' };

  const edit: NoteBlock = { ...current, comments: { ...(current.comments ?? {}), [commentId]: next } };
  const merged = mergeNoteBlock(current, edit);
  state.blocks[blockId] = merged;
  state.outbox = enqueue(state.outbox, {
    idempotencyKey: `${blockId}:comment:${commentId}:${at.physical}.${at.logical}`,
    itemId: blockId,
    kind: 'update',
    at,
    // Only the changed comment travels. Sending the whole map would make one
    // remark's write take every other remark this device happened to hold a
    // stale copy of — the per-key rule `mergeComments` exists to keep.
    payload: { comments: { [commentId]: next } },
    attempts: 0,
  });
  writeNotes(userId, state);
  return { ok: true, block: merged, comment: merged.comments?.[commentId] ?? next };
}

export function addComment(
  userId: string | undefined,
  blockId: string,
  input: { body: string; author?: string },
  nowMs: number,
): CommentWriteResult {
  const id = newCommentId(readNotes(userId).deviceId, nowMs);
  return writeComment(userId, blockId, id, (_existing, at) => ({
    id,
    body: { value: boundCommentBody(input.body), at },
    author: boundCommentAuthor(input.author),
    createdAt: at,
    resolved: { value: false, at },
  }), nowMs);
}

export function setCommentResolved(
  userId: string | undefined,
  blockId: string,
  commentId: string,
  resolved: boolean,
  nowMs: number,
): CommentWriteResult {
  return writeComment(userId, blockId, commentId, (existing, at) => (
    existing ? { ...existing, resolved: { value: resolved, at } } : null
  ), nowMs);
}

export function editComment(
  userId: string | undefined,
  blockId: string,
  commentId: string,
  body: string,
  nowMs: number,
): CommentWriteResult {
  return writeComment(userId, blockId, commentId, (existing, at) => (
    existing ? { ...existing, body: { value: boundCommentBody(body), at } } : null
  ), nowMs);
}

/** A comment taken back — a tombstone, so a peer's later edit cannot revive it. */
export function removeComment(
  userId: string | undefined,
  blockId: string,
  commentId: string,
  nowMs: number,
): CommentWriteResult {
  return writeComment(userId, blockId, commentId, (existing, at) => (
    existing ? { ...existing, deletedAt: at } : null
  ), nowMs);
}

/* ------------------------------------------------------------- F4: undo */

export type NoteUndoResult =
  | {
      ok: true;
      direction: 'undo' | 'redo';
      /** What was taken back, in words — see `UNDO_LABELS`. */
      label: string;
      /** Where the caret belongs afterwards, or null when nothing survived. */
      focusId: string | null;
      changedIds: string[];
    }
  | { ok: false; reason: 'nothing_to_undo' | 'nothing_to_redo' }
  /** F4's data-loss guard: another device wrote here after this step was recorded. */
  | { ok: false; reason: 'remote_change'; blockId: string; detail: string }
  /** B2's lease: somebody is typing in a block this step would rewrite. */
  | { ok: false; reason: 'locked'; blockId: string; detail: string };

function applyInverse(userId: string | undefined, op: NoteInverseOp, nowMs: number): void {
  switch (op.op) {
    case 'fields':
      updateBlock(userId, op.blockId, op.fields, nowMs);
      return;
    case 'place':
      moveBlock(userId, op.blockId, { parentId: op.parentId, rank: op.rank }, nowMs);
      return;
    case 'delete':
      deleteBlock(userId, op.blockId, nowMs);
      return;
    case 'restore':
      restoreBlocks(userId, op.blockIds, op.blockIds[0] ?? '', nowMs);
  }
}

/**
 * One step back (or forward) on the page being read.
 *
 * The entry is taken OFF its stack and persisted before anything is applied, so
 * the inverses recorded while applying cannot land beside the entry that
 * produced them — which would leave ⌘Z oscillating between two states.
 *
 * The ops are applied in REVERSE order: a gesture's writes are ordered (a merge
 * writes the block above, re-parents the children, then deletes), and undoing
 * them forwards would restore a block into a place its own inverse had not yet
 * recreated.
 */
function stepNoteHistory(
  userId: string | undefined,
  pageId: string | null,
  direction: 'undo' | 'redo',
  nowMs: number,
): NoteUndoResult {
  const state = readNotes(userId);
  const stack = direction === 'undo' ? state.history.past : state.history.future;
  const index = newestEntryIndex(stack, pageId);
  if (index < 0) {
    return { ok: false, reason: direction === 'undo' ? 'nothing_to_undo' : 'nothing_to_redo' };
  }
  const entry = stack[index]!;

  // F4's guard, checked over the WHOLE entry before any of it is applied. A
  // partly-applied inverse leaves the document in a state nobody produced, and
  // the person who pressed ⌘Z has no way back to either end of it.
  //
  // Over the blocks the inverse would WRITE TO, not the ones it names: a
  // `delete` inverse tombstones the subtree, and the guard that only saw the
  // named id let ⌘Z take a peer's nested block with it.
  const allBlocks = Object.values(state.blocks);
  const subtreeOf = (id: string): readonly string[] => subtreeBlockIds(allBlocks, id);
  const targets = entryWriteTargets(entry, subtreeOf);
  const collided = remoteChangeUnder(
    entry,
    // `blockWrittenAt`, not `blockEditedAt`: a peer's DELETE and a peer's
    // database view are writes this undo would destroy, and neither of them is
    // an "edit" as the Edited column means the word.
    (id) => { const block = state.blocks[id]; return block ? blockWrittenAt(block) : undefined; },
    state.deviceId,
    subtreeOf,
  );
  if (collided) {
    // The entry comes OFF the stack as it is refused. A remote stamp only moves
    // forward, so this step can never become applicable again — and leaving it
    // in place wedged the page: every later ⌘Z popped the same poisoned entry
    // and refused, which is "⌘Z stopped working", the thing F4 is about.
    const dropped = [...stack];
    dropped.splice(index, 1);
    state.history = direction === 'undo'
      ? { past: dropped, future: state.history.future }
      : { past: state.history.past, future: dropped };
    writeNotes(userId, state);
    return { ok: false, reason: 'remote_change', blockId: collided, detail: describeRefusedUndo(entry.label) };
  }

  for (const id of targets) {
    const fence = fenceBlockWrite(state.leases[id], { deviceId: state.deviceId }, nowMs);
    if (fence.path === 'blocked') {
      return { ok: false, reason: 'locked', blockId: id, detail: fence.detail };
    }
  }

  const remaining = [...stack];
  remaining.splice(index, 1);
  state.history = direction === 'undo'
    ? { past: remaining, future: state.history.future }
    : { past: state.history.past, future: remaining };
  writeNotes(userId, state);

  const previousSink = recordingTo;
  const previouslyApplying = applying;
  recordingTo = direction === 'undo' ? 'future' : 'past';
  applying = true;
  try {
    asOneUndo(userId, entry.label, () => {
      for (const op of [...entry.ops].reverse()) applyInverse(userId, op, nowMs);
    });
  } finally {
    recordingTo = previousSink;
    applying = previouslyApplying;
  }

  const after = readNotes(userId);
  // What actually changed, which for a delete inverse is the subtree it took.
  const changedIds = targets;
  return {
    ok: true,
    direction,
    label: entry.label,
    // The first block of the step that is still there. A caret sent to a block
    // the undo tombstoned would land nowhere, which reads as ⌘Z having also
    // dismissed the page.
    focusId: changedIds.find((id) => {
      const block = after.blocks[id];
      return !!block && isLiveBlock(block);
    }) ?? null,
    changedIds,
  };
}

/** F4 — ⌘Z on the page being read. */
export function undoNotes(
  userId: string | undefined,
  pageId: string | null,
  nowMs: number,
): NoteUndoResult {
  return stepNoteHistory(userId, pageId, 'undo', nowMs);
}

/** F4 — ⌘⇧Z, the same machinery with the stacks swapped. */
export function redoNotes(
  userId: string | undefined,
  pageId: string | null,
  nowMs: number,
): NoteUndoResult {
  return stepNoteHistory(userId, pageId, 'redo', nowMs);
}

/**
 * What ⌘Z and ⌘⇧Z would do on this page right now.
 *
 * Read by a surface so a menu item can say "Undo splitting the block" rather
 * than being permanently enabled and sometimes doing nothing — which is the
 * same defect F1 is about, in a menu instead of a slash catalog.
 */
export function noteUndoState(
  userId: string | undefined,
  pageId: string | null,
): { undo: string | null; redo: string | null } {
  const state = readNotes(userId);
  const back = newestEntryIndex(state.history.past, pageId);
  const forward = newestEntryIndex(state.history.future, pageId);
  return {
    undo: back < 0 ? null : state.history.past[back]!.label,
    redo: forward < 0 ? null : state.history.future[forward]!.label,
  };
}
