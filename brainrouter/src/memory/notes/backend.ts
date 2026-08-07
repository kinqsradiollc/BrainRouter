/**
 * Notes backend — the data plane behind `/api/notes` (migration 052).
 *
 * ADR-029 D1: keyed by `(org_id, user_id, id)`. A note is personal and
 * cross-project, so the user is part of the KEY rather than an author column,
 * and `visibility` is what widens it. ADR-028 D9 recorded getting this wrong
 * once by scoping the planner per repository.
 *
 * **The server merges; it does not accept (ADR-028 D11).** A client that is
 * behind must not win by pushing last, so a push applies D4's rules against the
 * server's current state rather than taking the payload wholesale. The merge
 * functions live in core and BOTH halves call them — one implementation, so the
 * two sides cannot drift into disagreeing about who won a conflict.
 *
 * **The lease lives here too (B2/Q1), and that is not a detail.** A lock held in
 * a client's own file coordinates nothing: two devices can only see the same
 * lock through the server. So this is where a write's fencing epoch is checked,
 * one layer above the job lease of migration 048 — whose comment states the rule
 * both implement: a lease without a fencing token is not a lock.
 *
 * **`notes_refs` and `notes_index` are derived (A2).** Nothing here writes them
 * from anything but a block's own current text. `rebuildDerived` throws them
 * away and recomputes from `notes_blocks` alone, which is what makes A2's claim
 * testable instead of merely stated.
 */
import { randomUUID } from "node:crypto";
import { memoryEngine } from "../engine.js";
import {
  acquireBlockLease, blockReferences, contentWithoutRefs, fenceBlockWrite,
  FIRST_RANK, isLiveBlock, MAX_HEADING_LEVEL, mergeNoteBlock, NOTE_BLOCK_KINDS,
  rankBetween, releaseBlockLease,
  renewBlockLease, resolveBlockConflict, BLOCK_LEASE_MS,
  type BlockFence, type BlockLease, type BlockWritePath, type Hlc,
  type LeaseClaim, type LeaseOutcome,
  type NoteBlock, type NoteBlockKind, type Stamped,
} from "@kinqs/brainrouter-core/notes";
import {
  extractWorkspaceRefs, parseWorkspaceRef, workspaceRefKey,
} from "@kinqs/brainrouter-core/workspace/references";
import type {
  NoteAttachmentRow, NoteAttachmentUseRow, NoteBacklinkRow, NoteBlockLeaseRow,
  NoteBlockOwnerRow, NoteBlockRow, NoteRefRow, NoteSearchRow,
} from "../store/postgres/queries/notesQueries.js";

/**
 * A block is a paragraph, not a file. The cap is high enough that a pasted code
 * block or an imported transcript paragraph fits, and low enough that one
 * runaway write cannot become the whole of someone's sync payload.
 */
export const MAX_BLOCK_TEXT = 100_000;

/**
 * The metadata fields — a language name, an emoji, a cover URL.
 *
 * Bounded far tighter than the body because they are rendered as chrome: a
 * page's icon appears in every sidebar row, and an unbounded one is a way to
 * make somebody else's navigation unusable.
 */
export const MAX_META_TEXT = 2048;

/** How long an unreferenced attachment object waits before a sweep may reclaim it. */
export const ATTACHMENT_GRACE_MS = 24 * 60 * 60 * 1000;

/** Leases outlive their term so the epoch survives; this is when the record may go. */
const LEASE_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

interface NotesStore {
  databaseNowMs(): Promise<number>;
  listNoteBlocksSince(orgId: string, userId: string, since?: string): Promise<NoteBlockRow[]>;
  listAllNoteBlocks(orgId: string, userId: string): Promise<NoteBlockRow[]>;
  getNoteBlock(orgId: string, userId: string, id: string): Promise<NoteBlockRow | null>;
  findNoteBlockInOrg(orgId: string, id: string): Promise<NoteBlockOwnerRow | null>;
  upsertNoteBlock(orgId: string, userId: string, block: {
    id: string;
    parentId: string | null;
    kind: string;
    visibility?: string;
    payload: Record<string, unknown>;
    deletedAtHlc?: string | null;
  }): Promise<NoteBlockRow>;
  setNoteBlockVisibility(orgId: string, userId: string, id: string, visibility: string): Promise<number>;
  latestNoteRevision(orgId: string, userId: string): Promise<string>;
  wasNoteOperationApplied(orgId: string, userId: string, key: string): Promise<boolean>;
  recordNoteOperationApplied(orgId: string, userId: string, key: string, blockId: string): Promise<void>;
  replaceNoteRefs(orgId: string, userId: string, blockId: string, refs: readonly Omit<NoteRefRow, "fromBlockId">[]): Promise<void>;
  listNoteRefsFrom(orgId: string, userId: string, blockId: string): Promise<NoteRefRow[]>;
  listNoteBacklinks(orgId: string, viewerUserId: string, targetKey: string, limit?: number): Promise<NoteBacklinkRow[]>;
  upsertNoteIndex(orgId: string, userId: string, blockId: string, entry: { contentText: string; refKeys: readonly string[] }): Promise<void>;
  deleteNoteIndexEntry(orgId: string, userId: string, blockId: string): Promise<void>;
  clearNoteDerived(orgId: string, userId: string): Promise<void>;
  listNoteIndexEntries(orgId: string, userId: string): Promise<Array<{ blockId: string; contentText: string; refKeys: string[] }>>;
  searchNoteIndex(orgId: string, userId: string, query: string, limit?: number): Promise<NoteSearchRow[]>;
  readNoteBlockLease(orgId: string, userId: string, blockId: string): Promise<{ lease: NoteBlockLeaseRow | null; dbNowMs: number }>;
  upsertNoteBlockLease(orgId: string, userId: string, lease: NoteBlockLeaseRow): Promise<void>;
  sweepNoteBlockLeases(orgId: string, maxAgeMs: number): Promise<number>;
  registerNoteAttachment(orgId: string, object: { contentHash: string; byteSize: number; mediaType: string; storageKey: string }): Promise<NoteAttachmentRow>;
  linkNoteAttachment(orgId: string, userId: string, link: { blockId: string; contentHash: string; fileName?: string | null }): Promise<void>;
  unlinkNoteAttachment(orgId: string, userId: string, blockId: string, contentHash: string): Promise<number>;
  listNoteAttachments(orgId: string, userId: string, blockId: string): Promise<NoteAttachmentUseRow[]>;
  countNoteAttachmentUses(orgId: string, contentHash: string): Promise<number>;
  listUnreferencedNoteAttachments(orgId: string, olderThanMs: number, limit?: number): Promise<NoteAttachmentRow[]>;
}
const store = (): NotesStore => memoryEngine.store as unknown as NotesStore;

export interface NotePushOperation {
  idempotencyKey: string;
  /** The BLOCK. B3: the outbox record is the block, so two blocks sync in parallel. */
  itemId: string;
  kind: "create" | "update" | "delete" | "source_action";
  at: Hlc;
  payload: unknown;
}

export interface PushOutcome {
  accepted: string[];
  rejected: Array<{ idempotencyKey: string; reason: string }>;
}

/**
 * The server's own clock, sent with every pull so clients absorb it (D3).
 *
 * `deviceId: "server"` rather than a pod identity: the HLC's device is a
 * tie-break, and a value that changed with whichever pod answered would make
 * ties resolve differently on every request.
 */
export function serverClock(nowMs: number): Hlc {
  return { physical: nowMs, logical: 0, deviceId: "server" };
}

function hlcText(at: Hlc): string {
  return `${at.physical}.${at.logical}.${at.deviceId}`;
}

function isHlc(value: unknown): value is Hlc {
  const h = value as Hlc | undefined;
  return !!h && typeof h.physical === "number" && typeof h.logical === "number" && typeof h.deviceId === "string";
}

function blockOf(row: NoteBlockRow): NoteBlock {
  return row.payload as unknown as NoteBlock;
}

const stampedWith = <T>(value: T, at: Hlc): Stamped<T> => ({ value, at });

/* ---------------------------------------------------------------- reading */

/**
 * Everything changed for this user since the client's cursor.
 *
 * `since` is a server revision, not a timestamp: two rows written in the same
 * millisecond are indistinguishable by time, and a client resuming on a
 * timestamp boundary silently skips whichever one sorted second.
 */
export async function pullChanges(
  orgId: string,
  userId: string,
  since?: string,
): Promise<{ blocks: NoteBlock[]; cursor: string }> {
  const rows = await store().listNoteBlocksSince(orgId, userId, since);
  return {
    blocks: rows.map(blockOf),
    cursor: await store().latestNoteRevision(orgId, userId),
  };
}

/** Live blocks. Tombstones are a sync concern, not a read concern. */
export async function listBlocks(orgId: string, userId: string): Promise<NoteBlock[]> {
  const rows = await store().listAllNoteBlocks(orgId, userId);
  return rows.filter((r) => !r.deletedAtHlc).map(blockOf);
}

/** Every block including tombstones — what the tree and the context reads need. */
export async function listAllBlocks(orgId: string, userId: string): Promise<NoteBlock[]> {
  const rows = await store().listAllNoteBlocks(orgId, userId);
  return rows.map(blockOf);
}

export async function getBlock(orgId: string, userId: string, id: string): Promise<NoteBlock | null> {
  const row = await store().getNoteBlock(orgId, userId, id);
  return row ? blockOf(row) : null;
}

/** Who owns a block and how widely it is shared, without reading its text (A4). */
export async function findBlockOwner(orgId: string, id: string): Promise<NoteBlockOwnerRow | null> {
  return store().findNoteBlockInOrg(orgId, id);
}

/* ---------------------------------------------------------------- writing */

/**
 * Persist a block and re-derive everything that hangs off its text.
 *
 * One function, so there is no path that writes content without re-deriving the
 * cache. A2's rule survives refactoring only if updating the two is not a thing
 * a caller can forget.
 */
async function persistBlock(orgId: string, userId: string, block: NoteBlock, visibility?: string): Promise<NoteBlock> {
  await store().upsertNoteBlock(orgId, userId, {
    id: block.id,
    parentId: block.parentId?.value ?? null,
    kind: block.kind?.value ?? "paragraph",
    ...(visibility ? { visibility } : {}),
    payload: block as unknown as Record<string, unknown>,
    // The COLUMN says whether the block is currently there, which is not the
    // same as whether it carries a tombstone: a restored block keeps its
    // tombstone and is outvoted by a newer `restoredAt` (E4). Writing the field
    // directly would leave every restored block invisible to `listBlocks`,
    // making a restore look like it did nothing.
    deletedAtHlc: isLiveBlock(block) ? null : hlcText(block.deletedAt!),
  });
  await reindexBlock(orgId, userId, block);
  return block;
}

/**
 * Re-derive one block's references and its index row.
 *
 * A deleted block retracts both: it is not a search result, and its links stop
 * counting as backlinks — an index that only ever grows is how "what links here"
 * starts listing notes that stopped mentioning you.
 */
async function reindexBlock(orgId: string, userId: string, block: NoteBlock): Promise<void> {
  const text = block.text?.value ?? "";
  if (!isLiveBlock(block)) {
    await store().replaceNoteRefs(orgId, userId, block.id, []);
    await store().deleteNoteIndexEntry(orgId, userId, block.id);
    return;
  }

  const perTarget = new Map<string, Omit<NoteRefRow, "fromBlockId"> & { fragmentSet: Set<string> }>();
  for (const ref of extractWorkspaceRefs(text)) {
    const key = workspaceRefKey(ref);
    const entry = perTarget.get(key) ?? {
      targetKey: key,
      targetMode: ref.mode,
      targetKind: ref.kind,
      targetId: ref.id,
      fragments: [],
      citeCount: 0,
      fragmentSet: new Set<string>(),
    };
    entry.citeCount += 1;
    if (ref.fragment) entry.fragmentSet.add(ref.fragment);
    perTarget.set(key, entry);
  }
  const refs = [...perTarget.values()]
    .map(({ fragmentSet, ...row }) => ({ ...row, fragments: [...fragmentSet].sort() }))
    .sort((a, b) => a.targetKey.localeCompare(b.targetKey));

  await store().replaceNoteRefs(orgId, userId, block.id, refs);
  await store().upsertNoteIndex(orgId, userId, block.id, {
    // B5: the prose with the URIs lifted out, so a machine-generated id never
    // reads as a word the person wrote.
    contentText: contentWithoutRefs(text),
    refKeys: refs.map((r) => r.targetKey),
  });
}

/**
 * A2's testable claim: throw the derived tables away and recompute from content.
 *
 * If a rebuild changes the answer, the cache was the source of truth and A2 was
 * not implemented. Exported rather than private for exactly that reason — the
 * property is only worth stating if something can check it.
 */
export async function rebuildDerived(orgId: string, userId: string): Promise<{ blocks: number }> {
  await store().clearNoteDerived(orgId, userId);
  const rows = await store().listAllNoteBlocks(orgId, userId);
  for (const row of rows) await reindexBlock(orgId, userId, blockOf(row));
  return { blocks: rows.length };
}

/**
 * Server-side create — C1's `create` verb for the notes mode.
 *
 * This is the writer a cross-mode create calls (Q2): "the meeting summary
 * becomes a page" runs here, on the server, because the dashboard and the
 * backend's own flows have no local store to write through. It mints an id that
 * carries `server` as its device, so a block created here can never collide with
 * one a device minted in the same millisecond.
 */
export async function createBlock(
  orgId: string,
  userId: string,
  input: { kind?: NoteBlockKind; text?: string; parentId?: string | null; level?: number; visibility?: string },
  nowMs: number,
): Promise<NoteBlock> {
  const kind = input.kind ?? "paragraph";
  if (!NOTE_BLOCK_KINDS.includes(kind)) throw new Error(`"${kind}" is not a block kind`);
  const text = input.text ?? "";
  if (text.length > MAX_BLOCK_TEXT) throw new Error(`A block holds at most ${MAX_BLOCK_TEXT} characters`);

  const at = serverClock(nowMs);
  const parentId = input.parentId ?? null;
  const siblings = (await store().listAllNoteBlocks(orgId, userId))
    .filter((r) => !r.deletedAtHlc && r.parentId === parentId)
    .map(blockOf);
  const last = siblings.map((b) => b.rank?.value).filter((r): r is string => typeof r === "string").sort().at(-1);

  const block: NoteBlock = {
    id: `blk_${nowMs.toString(36)}${randomUUID().slice(0, 8)}_server`,
    parentId: stampedWith(parentId, at),
    rank: stampedWith(last ? rankBetween(last, null) : FIRST_RANK, at),
    kind: stampedWith(kind, at),
    text: stampedWith(text, at),
    ...(input.level !== undefined ? { level: stampedWith(input.level, at) } : {}),
  };
  return persistBlock(orgId, userId, block, input.visibility);
}

/** D1 — sharing widens visibility rather than moving the row. */
export async function setVisibility(
  orgId: string,
  userId: string,
  id: string,
  visibility: "private" | "team" | "org",
): Promise<boolean> {
  return (await store().setNoteBlockVisibility(orgId, userId, id, visibility)) > 0;
}

/**
 * Apply a client's operations, merging against server state.
 *
 * Refusals are RETURNED, never thrown: the client keeps a rejected operation in
 * its outbox and eventually shows it to a person, and a throw would collapse the
 * whole batch and lose which operation was at fault.
 */
export async function pushOperations(
  orgId: string,
  userId: string,
  operations: readonly NotePushOperation[],
): Promise<PushOutcome> {
  const outcome: PushOutcome = { accepted: [], rejected: [] };

  for (const op of operations) {
    // Idempotency first: a redelivered push must be a no-op, not a second apply.
    // Reported as accepted because from the client's side it DID land.
    if (await store().wasNoteOperationApplied(orgId, userId, op.idempotencyKey)) {
      outcome.accepted.push(op.idempotencyKey);
      continue;
    }
    const patch = op.payload as Record<string, unknown> | undefined;
    if (!patch || typeof patch !== "object") {
      outcome.rejected.push({ idempotencyKey: op.idempotencyKey, reason: "The operation carried no usable block." });
      continue;
    }
    if (!isHlc(op.at)) {
      // Without a stamp there is nothing to merge against: the write would have
      // to be applied blind, which is the "last writer wins by arriving last"
      // D11 exists to refuse.
      outcome.rejected.push({ idempotencyKey: op.idempotencyKey, reason: "The operation carried no clock stamp." });
      continue;
    }

    const invalid = validatePatch(patch);
    if (invalid) {
      outcome.rejected.push({ idempotencyKey: op.idempotencyKey, reason: invalid });
      continue;
    }

    try {
      const existingRow = await store().getNoteBlock(orgId, userId, op.itemId);
      const existing = existingRow ? blockOf(existingRow) : null;

      const next = existing
        ? await mergeIncoming(orgId, userId, existing, op, patch)
        : incomingBlock(null, op, patch);

      await persistBlock(orgId, userId, next, existingRow?.visibility);
      await store().recordNoteOperationApplied(orgId, userId, op.idempotencyKey, op.itemId);
      outcome.accepted.push(op.idempotencyKey);
    } catch (error) {
      outcome.rejected.push({
        idempotencyKey: op.idempotencyKey,
        reason: error instanceof Error ? error.message : "The server could not apply this change.",
      });
    }
  }
  return outcome;
}

function validatePatch(patch: Record<string, unknown>): string | null {
  if (typeof patch.text === "string" && patch.text.length > MAX_BLOCK_TEXT) {
    return `A block holds at most ${MAX_BLOCK_TEXT} characters; this one had ${patch.text.length}.`;
  }
  if (patch.kind !== undefined && !NOTE_BLOCK_KINDS.includes(patch.kind as NoteBlockKind)) {
    return `"${String(patch.kind)}" is not a block kind.`;
  }
  if (patch.level !== undefined) {
    const level = Number(patch.level);
    if (!Number.isInteger(level) || level < 1 || level > MAX_HEADING_LEVEL) {
      return `A heading level is 1 to ${MAX_HEADING_LEVEL}.`;
    }
  }
  // The short metadata fields are bounded here rather than trusted, because
  // they reach a page's chrome and an agent's context. Nothing legitimate is
  // near these; the limits exist so one pathological push cannot become the
  // label on every surface that renders the page.
  for (const field of ["language", "icon", "cover"] as const) {
    const value = patch[field];
    if (value !== undefined && (typeof value !== "string" || value.length > MAX_META_TEXT)) {
      return `"${field}" is a string of at most ${MAX_META_TEXT} characters.`;
    }
  }
  return null;
}

/**
 * Merge one operation into the block the server currently holds.
 *
 * **Every write merges. The lease decides what the merge is allowed to do.**
 * Taking a leaseholder's payload wholesale was the shape this had first, and it
 * inverted D11 on the one path D11 is about: a device holding a valid lock
 * could push text stamped an hour ago over text stamped a minute ago and win,
 * because nothing compared them. A lock is permission to write, never evidence
 * of having read.
 *
 * So a correct epoch buys exactly one thing — the absence of a fencing penalty.
 * The three refusals (`stale_epoch`, `lease_expired`, `blocked`) buy the
 * penalty: the write cannot take the text it did not see, and if it would have,
 * both versions are kept and marked with WHICH refusal (B2's third departure —
 * a refused write is not a dropped write, it is a person's sentence).
 *
 * `blocked` counts here for the same reason it counts as a refusal at all. That
 * path is normally a PRE-typing answer — the editor will not let you start
 * writing in a block another device holds — but by the time an operation
 * reaches this function the sentence exists, typed offline or before the lock
 * was taken. Discarding it would enforce a lock by destroying the work the lock
 * protects; letting it land clean would make the lock decorative.
 */
async function mergeIncoming(
  orgId: string,
  userId: string,
  existing: NoteBlock,
  op: NotePushOperation,
  patch: Record<string, unknown>,
): Promise<NoteBlock> {
  // A conflict resolution is not a field write: it picks one of two kept
  // versions. Applying it as a patch would merge the choice against the
  // conflict it was resolving and leave the marker in place.
  if (typeof patch.field === "string" && (patch.keep === "ours" || patch.keep === "theirs")) {
    return resolveBlockConflict(existing, patch.field, patch.keep, op.at) ?? existing;
  }

  const incoming = incomingBlock(existing, op, patch);
  const { lease, dbNowMs } = await store().readNoteBlockLease(orgId, userId, op.itemId);
  const claimed = typeof patch.leaseEpoch === "number" ? patch.leaseEpoch : undefined;
  const fence = fenceBlockWrite(
    lease ? toLease(lease) : undefined,
    { deviceId: op.at.deviceId, ...(claimed === undefined ? {} : { epoch: claimed }) },
    dbNowMs,
  );
  return mergeNoteBlock(existing, incoming, penaltyOf(fence));
}

/**
 * The fencing penalty a write earns, or none.
 *
 * `no_lease` earns none: B2 chose SOFT locking, so a block nobody holds is
 * freely editable and D4 is the floor. Requiring a lease to type would turn
 * every offline edit into a refusal, which is the opposite of ADR-028 D2's
 * position on offline.
 */
function penaltyOf(fence: BlockWritePath): BlockFence | undefined {
  if (fence.path === "blocked") return "blocked";
  if (fence.path === "merge" && fence.reason !== "no_lease") return fence.reason;
  return undefined;
}

/**
 * The block this operation is asking for, expressed against what already exists.
 *
 * Fields the patch does not mention keep their EXISTING stamps rather than being
 * re-stamped with this operation's clock. Re-stamping them would make an edit
 * that only changed the text also win every other field — so a device typing a
 * word would silently undo a move made on another device a second earlier.
 *
 * An operation for a block the server has never seen is treated as a creation
 * even when it is labelled an update: the create can legitimately have been shed
 * from an outbox that was offline for a month, and dropping the edit would lose
 * the only copy of it that exists.
 */
function incomingBlock(
  existing: NoteBlock | null,
  op: NotePushOperation,
  patch: Record<string, unknown>,
): NoteBlock {
  const at = op.at;
  const base: NoteBlock = existing ?? {
    id: op.itemId,
    parentId: stampedWith<string | null>(null, at),
    rank: stampedWith(FIRST_RANK, at),
    kind: stampedWith<NoteBlockKind>("paragraph", at),
    text: stampedWith("", at),
  };

  const next: NoteBlock = {
    ...base,
    id: op.itemId,
    ...(patch.parentId !== undefined
      ? { parentId: stampedWith((patch.parentId as string | null) ?? null, at) }
      : {}),
    ...(typeof patch.rank === "string" ? { rank: stampedWith(patch.rank, at) } : {}),
    ...(patch.kind !== undefined ? { kind: stampedWith(patch.kind as NoteBlockKind, at) } : {}),
    ...(typeof patch.text === "string" ? { text: stampedWith(patch.text, at) } : {}),
    ...(patch.level !== undefined ? { level: stampedWith(Number(patch.level), at) } : {}),
    ...(typeof patch.checked === "boolean" ? { checked: stampedWith(patch.checked, at) } : {}),
    ...(typeof patch.language === "string" ? { language: stampedWith(patch.language, at) } : {}),
    ...(typeof patch.collapsed === "boolean" ? { collapsed: stampedWith(patch.collapsed, at) } : {}),
    ...(typeof patch.icon === "string" ? { icon: stampedWith(patch.icon, at) } : {}),
    ...(typeof patch.cover === "string" ? { cover: stampedWith(patch.cover, at) } : {}),
    ...(typeof patch.favourite === "boolean" ? { favourite: stampedWith(patch.favourite, at) } : {}),
    // A delete is a tombstone stamped with the operation's clock (C5), so a
    // later edit from another device can resurrect it as conflicted.
    ...(op.kind === "delete" ? { deletedAt: at } : {}),
    // A restore is the tombstone's opposite number, and it is an operation
    // rather than a field write: clearing `deletedAt` would leave the server
    // unable to tell a peer's arriving delete apart from a new one, and the
    // block would go back in the trash a few seconds after coming out.
    ...(patch.restore === true ? { restoredAt: at } : {}),
  };

  // A block cannot be its own parent. Refused rather than repaired: the tree
  // builder can break a cycle two devices produced concurrently, but one device
  // asking for an impossible placement is a defect, not a race.
  if (next.parentId.value === next.id) {
    throw new Error("A block cannot be its own parent.");
  }
  return next;
}

/* ------------------------------------------------------------------ leases */

function toLease(row: NoteBlockLeaseRow): BlockLease {
  return {
    blockId: row.blockId,
    deviceId: row.deviceId,
    ...(row.holder ? { holder: row.holder } : {}),
    epoch: row.epoch,
    expiresAt: row.expiresAtMs,
  };
}

function toRow(lease: BlockLease): NoteBlockLeaseRow {
  return {
    blockId: lease.blockId,
    deviceId: lease.deviceId,
    holder: lease.holder ?? null,
    epoch: lease.epoch,
    expiresAtMs: lease.expiresAt,
  };
}

/** What a client shows as the read-only attribution, plus its own claim if it holds one. */
export async function readLease(
  orgId: string,
  userId: string,
  blockId: string,
): Promise<{ lease: BlockLease | null; nowMs: number; leaseMs: number }> {
  const { lease, dbNowMs } = await store().readNoteBlockLease(orgId, userId, blockId);
  return { lease: lease ? toLease(lease) : null, nowMs: dbNowMs, leaseMs: BLOCK_LEASE_MS };
}

/**
 * Take the lock, or say who has it.
 *
 * Liveness is judged on the DATABASE's clock, never the caller's: `expires_at`
 * is written by whichever API process granted the lease, and ADR-027 D12 moved
 * job lease expiry onto the database clock after skew between Node processes
 * translated directly into stolen leases.
 */
export async function acquireLease(
  orgId: string,
  userId: string,
  blockId: string,
  request: { deviceId: string; holder?: string },
): Promise<LeaseOutcome> {
  const { lease, dbNowMs } = await store().readNoteBlockLease(orgId, userId, blockId);
  const outcome = acquireBlockLease(
    lease ? toLease(lease) : undefined,
    { blockId, deviceId: request.deviceId, ...(request.holder ? { holder: request.holder } : {}) },
    dbNowMs,
  );
  if (outcome.ok) {
    await store().upsertNoteBlockLease(orgId, userId, toRow(outcome.lease));
    // Bounded rather than unbounded growth, and safe here: an operation older
    // than the outbox keeps has already been shed, so no write carrying a
    // swept lease's epoch can still arrive.
    await store().sweepNoteBlockLeases(orgId, LEASE_RETENTION_MS);
  }
  return outcome;
}

/** Q1's "renewed while typing". The epoch does not move — see `blockLease.ts`. */
export async function renewLease(
  orgId: string,
  userId: string,
  blockId: string,
  claim: LeaseClaim,
): Promise<LeaseOutcome> {
  const { lease, dbNowMs } = await store().readNoteBlockLease(orgId, userId, blockId);
  const outcome = renewBlockLease(lease ? toLease(lease) : undefined, claim, dbNowMs);
  if (outcome.ok) await store().upsertNoteBlockLease(orgId, userId, toRow(outcome.lease));
  return outcome;
}

/**
 * Give the lock back — by ending its term, not by deleting the record.
 *
 * The epoch has to survive: dropping the row resets the count, the next
 * acquisition mints epoch 1 again, and that matches the epoch a sleeping device
 * is still carrying. A fencing token that can be reset is not a fencing token.
 */
export async function releaseLease(
  orgId: string,
  userId: string,
  blockId: string,
  claim: LeaseClaim,
): Promise<LeaseOutcome> {
  const { lease, dbNowMs } = await store().readNoteBlockLease(orgId, userId, blockId);
  const outcome = releaseBlockLease(lease ? toLease(lease) : undefined, claim, dbNowMs);
  if (outcome.ok) await store().upsertNoteBlockLease(orgId, userId, toRow(outcome.lease));
  return outcome;
}

/* ------------------------------------------------------- search + backlinks */

export interface NoteSearchResult {
  blockId: string;
  kind: string;
  /** Which halves matched. Never empty. */
  matched: Array<"text" | "reference">;
  snippet: string;
  matchedRefs: string[];
  score: number;
}

/**
 * B5 — search over content and references, through the index.
 *
 * The client has an equivalent over its local cache (`searchNotes` in core); this
 * is the same question asked of the server, which is the only side that can
 * answer it for a dashboard with no local store. The two agree about what a
 * reference IS because both extract them with the same function.
 */
export async function searchBlocks(
  orgId: string,
  userId: string,
  query: string,
  limit = 50,
): Promise<NoteSearchResult[]> {
  const trimmed = query.trim();
  if (!trimmed) return [];
  const rows = await store().searchNoteIndex(orgId, userId, trimmed, limit);
  const needle = trimmed.toLowerCase();

  return rows.map((row) => {
    const block = row.payload as unknown as NoteBlock;
    const prose = contentWithoutRefs(block.text?.value ?? "");
    const matched: Array<"text" | "reference"> = [];
    if (row.matchedText) matched.push("text");
    if (row.matchedReference) matched.push("reference");
    return {
      blockId: row.blockId,
      kind: block.kind?.value ?? "paragraph",
      matched,
      snippet: prose.slice(0, 160),
      matchedRefs: blockReferences(block).filter((uri) => uri.toLowerCase().includes(needle)),
      score: row.rank,
    };
  });
}

/**
 * What links here — A2's derived answer, over the corpus this viewer may see.
 *
 * The target is keyed WITHOUT its fragment: a note citing `parser.ts#L59` and one
 * citing `#L12` both link to the same file, and splitting them by line number
 * answers a question nobody asked. The positions ride on the edge instead.
 */
export async function backlinksTo(
  orgId: string,
  viewerUserId: string,
  targetUri: string,
  limit = 200,
): Promise<{ target: string; backlinks: NoteBacklinkRow[] } | null> {
  const parsed = parseWorkspaceRef(targetUri);
  if (!parsed.ok) return null;
  const key = workspaceRefKey(parsed.ref);
  return { target: key, backlinks: await store().listNoteBacklinks(orgId, viewerUserId, key, limit) };
}

/** Every reference one block currently makes. Derived; never a stored back-edge. */
export async function referencesFrom(orgId: string, userId: string, blockId: string): Promise<NoteRefRow[]> {
  return store().listNoteRefsFrom(orgId, userId, blockId);
}

/* -------------------------------------------------------------- attachments */

const SHA256 = /^[0-9a-f]{64}$/;

/**
 * D3 — register the object once, then point at it.
 *
 * The hash IS the identity, so pasting the same image into a third note adds a
 * reference and no bytes. Without that, storage grows with how often people
 * paste rather than with what they have.
 */
export async function registerAttachment(
  orgId: string,
  object: { contentHash: string; byteSize: number; mediaType: string; storageKey: string },
): Promise<NoteAttachmentRow> {
  if (!SHA256.test(object.contentHash)) {
    throw new Error("An attachment is addressed by its sha256 digest, in lowercase hex.");
  }
  if (!Number.isFinite(object.byteSize) || object.byteSize < 0) {
    throw new Error("An attachment needs its byte size.");
  }
  return store().registerNoteAttachment(orgId, object);
}

export async function attachToBlock(
  orgId: string,
  userId: string,
  blockId: string,
  contentHash: string,
  fileName?: string | null,
): Promise<void> {
  const block = await store().getNoteBlock(orgId, userId, blockId);
  // Checked here rather than left to the foreign key so the caller gets a
  // sentence instead of a constraint name.
  if (!block) throw new Error("There is no such block to attach to.");
  await store().linkNoteAttachment(orgId, userId, { blockId, contentHash, fileName: fileName ?? null });
}

export async function detachFromBlock(
  orgId: string,
  userId: string,
  blockId: string,
  contentHash: string,
): Promise<boolean> {
  return (await store().unlinkNoteAttachment(orgId, userId, blockId, contentHash)) > 0;
}

export async function blockAttachments(
  orgId: string,
  userId: string,
  blockId: string,
): Promise<NoteAttachmentUseRow[]> {
  return store().listNoteAttachments(orgId, userId, blockId);
}

/** How many blocks point at one object — counted, never stored. */
export async function attachmentUses(orgId: string, contentHash: string): Promise<number> {
  return store().countNoteAttachmentUses(orgId, contentHash);
}

/** Objects nothing points at any more, past a grace period. The input to a byte sweep. */
export async function unreferencedAttachments(
  orgId: string,
  graceMs = ATTACHMENT_GRACE_MS,
): Promise<NoteAttachmentRow[]> {
  return store().listUnreferencedNoteAttachments(orgId, graceMs);
}
