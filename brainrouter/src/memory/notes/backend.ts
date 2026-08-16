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
 *
 * **Part E's state travels the same path and nothing else (migration 053).** A
 * page's icon, a database's schema and a row's cells are pushed as fields of the
 * block, merged by the same functions, and projected into `notes_page_meta` /
 * `notes_row_values` by the same re-derive call as everything else. There is no
 * second endpoint that writes a schema and no second table that owns one — B3
 * exists to prevent exactly that, and a database with its own sync path would
 * disagree with the page it lives on within a day of shipping.
 */
import { createHash, randomUUID } from "node:crypto";
import { AsyncLocalStorage } from "node:async_hooks";
import { memoryEngine } from "../engine.js";
import {
  acquireBlockLease, blockComments, blockReferences, blockReferenceText, boundCommentAuthor,
  boundCommentBody, contentWithoutRefs, DATABASE_BLOCK_KIND, defaultDatabaseSchema,
  defaultDatabaseViews, describeTrashEntry,
  datePropertyDay, deletedSubtreeIds, exportFormatsFor, exportNote, fenceBlockWrite,
  FIRST_RANK, isLiveBlock, isSyncedBlock, isTemplate, MAX_COMMENT_LENGTH, MAX_EXPORT_BLOCKS, MAX_EXPORT_CHARS,
  listTrashEntries, MAX_HEADING_LEVEL, mergeNoteBlock, newCommentId, NOTE_BLOCK_KINDS,
  orphanedComments, pageTitleOrDefault,
  projectDatabase, rankBetween, readDatabase, releaseBlockLease,
  renewBlockLease, resolveBlockConflict, subtreeBlockIds, syncedSourceId, validateDatabaseFields,
  BLOCK_LEASE_MS,
  type BlockFence, type BlockLease, type BlockWritePath, type DatabaseProjection, type Hlc,
  type LeaseClaim, type LeaseOutcome, type NoteComment, type NoteDatabase, type NoteDatabaseView,
  type NoteBlock, type NoteBlockKind, type NoteExport, type NoteExportFormat,
  type NotePropertyDef, type NotePropertyValue, type Stamped,
} from "@kinqs/brainrouter-core/notes";
import {
  EMPTY_NOTES_MUTATION_SYNC, NOTES_EDITING_CONTRACT_VERSION, REMOTE_NOTES_HISTORY_STATE,
  describeInstantiation,
  planAddDatabaseProperty, planCreateDatabaseRow, planDeleteDatabaseProperty,
  planDeleteDatabaseView, planNoteGesture, planNoteSubtreeCopy, planReorderDatabaseProperties,
  planSaveDatabaseView, planSetDatabaseRowValue, planUpdateDatabaseProperty,
  remapNoteRefs, resolveNoteMutationPosition, rollupTargetPropertiesFromBlocks,
  type DatabaseMutationPlan, type NoteGesture, type NoteGesturePlan,
  type NoteGestureStep, type NotesMutationError, type NotesMutationOperation,
  type NotesMutationRequest, type NotesMutationResponse, type NotesMutationSyncReport,
  type RollupTargetPropertiesResult,
} from "@kinqs/brainrouter-core/notes/editing";
import {
  extractWorkspaceRefs, parseWorkspaceRef, workspaceRefKey,
} from "@kinqs/brainrouter-core/workspace/references";
import type {
  NoteAttachmentRow, NoteAttachmentUseRow, NoteBacklinkRow, NoteBlockLeaseRow,
  NoteBlockOwnerRow, NoteBlockRow, NotePageMetaRow, NoteRefRow, NoteRowValueInput,
  NoteSearchRow, NoteOperationReceipt, NoteMutationQueries,
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

/**
 * ADR-029 F3 — how many comments one push may carry.
 *
 * A client writes ONE comment per operation (`writeComment` sends only the
 * changed key), so anything past a handful is not the editor. The bound is here
 * rather than trusted because a thread is rendered to everyone a page is shared
 * with and sampled into an agent's context.
 */
export const MAX_COMMENTS_PER_PUSH = 8;

/** How long an unreferenced attachment object waits before a sweep may reclaim it. */
export const ATTACHMENT_GRACE_MS = 24 * 60 * 60 * 1000;

/** Leases outlive their term so the epoch survives; this is when the record may go. */
const LEASE_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

interface NotesStore {
  withNoteMutation<T>(
    orgId: string,
    userId: string,
    fn: (queries: NoteMutationQueries) => Promise<T>,
  ): Promise<T>;
  databaseNowMs(): Promise<number>;
  listNoteBlocksSince(orgId: string, userId: string, since?: string): Promise<NoteBlockRow[]>;
  listAllNoteBlocks(orgId: string, userId: string): Promise<NoteBlockRow[]>;
  getNoteBlock(orgId: string, userId: string, id: string): Promise<NoteBlockRow | null>;
  findNoteBlockInOrg(orgId: string, id: string): Promise<NoteBlockOwnerRow | null>;
  upsertNoteBlock(orgId: string, userId: string, block: {
    id: string;
    parentId: string | null;
    kind: string;
    rank?: string;
    visibility?: string;
    payload: Record<string, unknown>;
    deletedAtHlc?: string | null;
  }): Promise<NoteBlockRow>;
  listNoteChildBlocks(orgId: string, userId: string, parentId: string, limit?: number): Promise<NoteBlockRow[]>;
  setNoteBlockVisibility(orgId: string, userId: string, id: string, visibility: string): Promise<number>;
  latestNoteRevision(orgId: string, userId: string): Promise<string>;
  getNoteOperationReceipt(orgId: string, userId: string, key: string): Promise<NoteOperationReceipt | null>;
  wasNoteOperationApplied(orgId: string, userId: string, key: string): Promise<boolean>;
  recordNoteOperationApplied(
    orgId: string,
    userId: string,
    key: string,
    blockId: string,
    fingerprint?: string,
    response?: Record<string, unknown>,
  ): Promise<void>;
  replaceNoteRefs(orgId: string, userId: string, blockId: string, refs: readonly Omit<NoteRefRow, "fromBlockId">[]): Promise<void>;
  listNoteRefsFrom(orgId: string, userId: string, blockId: string): Promise<NoteRefRow[]>;
  listNoteBacklinks(orgId: string, viewerUserId: string, targetKey: string, limit?: number): Promise<NoteBacklinkRow[]>;
  upsertNoteIndex(orgId: string, userId: string, blockId: string, entry: { contentText: string; refKeys: readonly string[] }): Promise<void>;
  deleteNoteIndexEntry(orgId: string, userId: string, blockId: string): Promise<void>;
  clearNoteDerived(orgId: string, userId: string): Promise<void>;
  upsertNotePageMeta(orgId: string, userId: string, meta: NotePageMetaRow): Promise<void>;
  deleteNotePageMeta(orgId: string, userId: string, blockId: string): Promise<void>;
  listNotePageMeta(orgId: string, userId: string, opts?: { kinds?: readonly string[]; favouritesOnly?: boolean; limit?: number }): Promise<NotePageMetaRow[]>;
  getNotePageMeta(orgId: string, userId: string, blockId: string): Promise<NotePageMetaRow | null>;
  replaceNoteRowValues(orgId: string, userId: string, blockId: string, parentId: string | null, values: readonly NoteRowValueInput[]): Promise<void>;
  listNoteDatabaseRows(orgId: string, userId: string, databaseId: string, opts?: { orderBy?: string; descending?: boolean; limit?: number }): Promise<NoteBlockRow[]>;
  countNoteDatabaseRows(orgId: string, userId: string, databaseId: string): Promise<number>;
  listNoteIndexEntries(orgId: string, userId: string): Promise<Array<{ blockId: string; contentText: string; refKeys: string[] }>>;
  searchNoteIndex(orgId: string, userId: string, query: string, limit?: number): Promise<NoteSearchRow[]>;
  readNoteBlockLease(orgId: string, userId: string, blockId: string): Promise<{ lease: NoteBlockLeaseRow | null; dbNowMs: number }>;
  upsertNoteBlockLease(orgId: string, userId: string, lease: NoteBlockLeaseRow): Promise<void>;
  sweepNoteBlockLeases(orgId: string, maxAgeMs: number): Promise<number>;
  observeNoteHostClock(orgId: string, userId: string, remote: Hlc): Promise<void>;
  nextNoteHostClock(
    orgId: string,
    userId: string,
    deviceId: string,
    wallClockMs: number,
    reserve: number,
  ): Promise<Hlc>;
  registerNoteAttachment(orgId: string, object: { contentHash: string; byteSize: number; mediaType: string; storageKey: string }): Promise<NoteAttachmentRow>;
  linkNoteAttachment(orgId: string, userId: string, link: { blockId: string; contentHash: string; fileName?: string | null }): Promise<void>;
  unlinkNoteAttachment(orgId: string, userId: string, blockId: string, contentHash: string): Promise<number>;
  listNoteAttachments(orgId: string, userId: string, blockId: string): Promise<NoteAttachmentUseRow[]>;
  countNoteAttachmentUses(orgId: string, contentHash: string): Promise<number>;
  listUnreferencedNoteAttachments(orgId: string, olderThanMs: number, limit?: number): Promise<NoteAttachmentRow[]>;
}
interface NotesMutationContext {
  orgId: string;
  userId: string;
  store: NotesStore;
}

const notesMutationContext = new AsyncLocalStorage<NotesMutationContext>();
const rootStore = (): NotesStore => memoryEngine.store as unknown as NotesStore;
const store = (): NotesStore => notesMutationContext.getStore()?.store ?? rootStore();

/**
 * Enter the one transaction that owns a complete Notes mutation.
 *
 * Nested writers such as comments and gesture primitives reuse the active
 * transaction rather than opening a second pooled connection. Test stores that
 * predate this contract still run, but production must provide the transaction
 * primitive and is intentionally failed closed when it does not.
 */
async function withNotesMutation<T>(
  orgId: string,
  userId: string,
  fn: () => Promise<T>,
): Promise<T> {
  const active = notesMutationContext.getStore();
  if (active) {
    if (active.orgId !== orgId || active.userId !== userId) {
      throw new Error("A nested Notes mutation cannot change its organization or user scope.");
    }
    return fn();
  }
  const base = rootStore();
  if (typeof base.withNoteMutation !== "function") {
    // Small in-memory test stores are updated alongside this contract. A real
    // store without atomic Notes support must never silently fall back.
    if (process.env.NODE_ENV !== "test") {
      throw new Error("The Notes store does not support atomic mutations.");
    }
    return fn();
  }
  return base.withNoteMutation(orgId, userId, async (queries) => {
    const locked = queries as unknown as NotesStore;
    return notesMutationContext.run({ orgId, userId, store: locked }, fn);
  });
}

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
  /**
   * ADR-029 E6 — the operations that landed as a CONFLICT rather than as a write.
   *
   * A fenced write is accepted (B2 keeps the sentence rather than destroying it)
   * but its fields did not replace the ones the block already held. Without this
   * channel the only signal is a `conflicts` marker on the stored block, which
   * `accepted` does not mention — so a caller is told its change landed while the
   * text on screen is unchanged. That is E6's own named failure, and it is why a
   * `locked` refusal was unreachable on this side.
   */
  fenced?: Array<{ idempotencyKey: string; itemId: string; reason: BlockFence }>;
}

function canonicalJson(value: unknown): string {
  if (value === null) return "null";
  if (typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number") return Number.isFinite(value) ? JSON.stringify(value) : JSON.stringify(String(value));
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (typeof value === "object") {
    const object = value as Record<string, unknown>;
    return `{${Object.keys(object).sort().filter((key) => object[key] !== undefined).map((key) => (
      `${JSON.stringify(key)}:${canonicalJson(object[key])}`
    )).join(",")}}`;
  }
  return JSON.stringify(String(value));
}

function digestParts(...parts: readonly string[]): string {
  const hash = createHash("sha256");
  for (const part of parts) {
    hash.update(String(Buffer.byteLength(part, "utf8")));
    hash.update(":");
    hash.update(part);
  }
  return hash.digest("hex");
}

function pushReceiptKey(idempotencyKey: string): string {
  return `notes:push:v1:${digestParts(idempotencyKey)}`;
}

function pushFingerprint(operation: NotePushOperation): string {
  return digestParts(canonicalJson({
    itemId: operation.itemId,
    kind: operation.kind,
    at: operation.at,
    payload: operation.payload,
  }));
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

function plainRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null
    ? value as Record<string, unknown>
    : null;
}

function isHlc(value: unknown): value is Hlc {
  const h = plainRecord(value) as unknown as Hlc | null;
  return !!h
    && Number.isSafeInteger(h.physical) && h.physical >= 0
    && Number.isSafeInteger(h.logical) && h.logical >= 0
    && safeWireToken(h.deviceId, 128);
}

function laterClock(left: Hlc | null, right: Hlc): Hlc {
  if (!left || right.physical > left.physical
    || (right.physical === left.physical && right.logical > left.logical)) return right;
  return left;
}

/** Find the newest clock already persisted, including stamps written before migration 060. */
function latestStoredClock(value: unknown): Hlc | null {
  const pending: unknown[] = [value];
  const seen = new Set<object>();
  let latest: Hlc | null = null;
  while (pending.length > 0) {
    const candidate = pending.pop();
    if (!candidate || typeof candidate !== "object" || seen.has(candidate)) continue;
    seen.add(candidate);
    if (isHlc(candidate)) latest = laterClock(latest, candidate);
    if (Array.isArray(candidate)) pending.push(...candidate);
    else pending.push(...Object.values(candidate as Record<string, unknown>));
  }
  return latest;
}

async function absorbStoredNoteClocks(
  orgId: string,
  userId: string,
  rows?: readonly NoteBlockRow[],
): Promise<readonly NoteBlockRow[]> {
  const stored = rows ?? await store().listAllNoteBlocks(orgId, userId);
  let latest: Hlc | null = null;
  for (const row of stored) {
    const candidate = latestStoredClock(row.payload);
    if (candidate) latest = laterClock(latest, candidate);
  }
  if (latest) await store().observeNoteHostClock(orgId, userId, latest);
  return stored;
}

function safeWireToken(value: unknown, max: number): value is string {
  return typeof value === "string"
    && value.length > 0
    && value.length <= max
    && !/[\u0000-\u001f\u007f]/u.test(value)
    && value !== "__proto__"
    && value !== "prototype"
    && value !== "constructor";
}

function safeMapKey(value: string): boolean {
  return safeWireToken(value, 256);
}

function nullPrototypeMap(value: Record<string, unknown>): Record<string, unknown> {
  const next = Object.create(null) as Record<string, unknown>;
  for (const [key, entry] of Object.entries(value)) {
    next[key] = Array.isArray(entry)
      ? entry.map((item) => (plainRecord(item) ? nullPrototypeMap(item as Record<string, unknown>) : item))
      : plainRecord(entry)
        ? nullPrototypeMap(entry as Record<string, unknown>)
        : entry;
  }
  return next;
}

export type NotePushOperationParseResult =
  | { ok: true; value: NotePushOperation }
  | { ok: false; idempotencyKey: string; reason: string };

/** Strictly validate the legacy device-outbox wire envelope. */
export function parseNotePushOperation(value: unknown): NotePushOperationParseResult {
  const raw = plainRecord(value);
  if (!raw) {
    return { ok: false, idempotencyKey: "unknown", reason: "A Notes operation must be an object." };
  }
  const key = typeof raw.idempotencyKey === "string" ? raw.idempotencyKey : "unknown";
  if (!safeWireToken(raw.idempotencyKey, 512)) {
    return { ok: false, idempotencyKey: key, reason: "The operation has an invalid idempotency key." };
  }
  if (!safeWireToken(raw.itemId, 256)) {
    return { ok: false, idempotencyKey: key, reason: "The operation has an invalid block id." };
  }
  if (raw.kind !== "create" && raw.kind !== "update" && raw.kind !== "delete" && raw.kind !== "source_action") {
    return { ok: false, idempotencyKey: key, reason: "The operation has an unsupported kind." };
  }
  if (!isHlc(raw.at)) {
    return { ok: false, idempotencyKey: key, reason: "The operation has an invalid clock stamp." };
  }
  const rawPayload = plainRecord(raw.payload);
  if (!rawPayload) {
    return { ok: false, idempotencyKey: key, reason: "The operation carried no usable block." };
  }
  const payload = nullPrototypeMap(rawPayload);
  for (const mapField of ["props", "comments"] as const) {
    const map = payload[mapField];
    if (map === undefined) continue;
    const mapRecord = plainRecord(map);
    if (!mapRecord) {
      return { ok: false, idempotencyKey: key, reason: `${mapField} must be an object map.` };
    }
    for (const mapKey of Object.keys(mapRecord)) {
      if (!safeMapKey(mapKey)) {
        return { ok: false, idempotencyKey: key, reason: `${mapField} contains a reserved or invalid key.` };
      }
    }
    payload[mapField] = nullPrototypeMap(mapRecord);
  }
  if (payload.parentId !== undefined && payload.parentId !== null && !safeWireToken(payload.parentId, 256)) {
    return { ok: false, idempotencyKey: key, reason: "The operation has an invalid parent block id." };
  }
  if (payload.rank !== undefined && (typeof payload.rank !== "string" || payload.rank.length > 512)) {
    return { ok: false, idempotencyKey: key, reason: "The operation has an invalid rank." };
  }
  if (payload.leaseEpoch !== undefined
    && (!Number.isSafeInteger(payload.leaseEpoch) || (payload.leaseEpoch as number) < 1)) {
    return { ok: false, idempotencyKey: key, reason: "The operation has an invalid lease epoch." };
  }
  if (payload.restore !== undefined && payload.restore !== true) {
    return { ok: false, idempotencyKey: key, reason: "A restore marker must be true." };
  }
  if (payload.field !== undefined || payload.keep !== undefined) {
    const field = payload.field;
    const validField = field === "text" || field === "deleted"
      || (typeof field === "string" && field.startsWith("comment:") && safeMapKey(field.slice(8)));
    if (!validField || (payload.keep !== "ours" && payload.keep !== "theirs")) {
      return { ok: false, idempotencyKey: key, reason: "The operation has an invalid conflict resolution." };
    }
  }
  const invalid = validatePatch(payload, raw.itemId);
  if (invalid) return { ok: false, idempotencyKey: key, reason: invalid };
  return {
    ok: true,
    value: {
      idempotencyKey: raw.idempotencyKey,
      itemId: raw.itemId,
      kind: raw.kind,
      at: { physical: raw.at.physical, logical: raw.at.logical, deviceId: raw.at.deviceId },
      payload,
    },
  };
}

function blockOf(row: NoteBlockRow): NoteBlock {
  return row.payload as unknown as NoteBlock;
}

const stampedWith = <T>(value: T, at: Hlc): Stamped<T> => ({ value, at });

/**
 * ADR-029 E3 — stamp the property values a patch mentions, keeping the rest.
 *
 * Only the keys present are re-stamped. A key the patch did not mention keeps
 * its existing stamp, for the same reason `incomingBlock` leaves unmentioned
 * fields alone: an operation that set one cell must not also win the ones it was
 * not about.
 */
function stampedProps(
  existing: NoteBlock["props"],
  patch: Record<string, unknown>,
  at: Hlc,
): NonNullable<NoteBlock["props"]> {
  const next = Object.assign(
    Object.create(null) as NonNullable<NoteBlock["props"]>,
    existing ?? {},
  );
  for (const [key, value] of Object.entries(patch)) {
    next[key] = stampedWith(value as NotePropertyValue, at);
  }
  return next;
}

/**
 * ADR-029 F3 — stamp the comments a patch mentions, keeping the rest.
 *
 * The same per-key rule `stampedProps` follows, and for the same reason: a push
 * that added one remark must not win every other remark the pushing device
 * happened to be holding a stale copy of.
 *
 * The stamps are the SERVER's, taken from the operation, not the client's. A
 * comment arriving with a hand-written future stamp would win every merge on
 * every device forever, and there is nothing in a comment worth trusting a
 * client's clock for — the operation already carries the one stamp D11 orders
 * everything else by.
 */
function stampedComments(
  existing: NoteBlock["comments"],
  patch: Record<string, unknown>,
  at: Hlc,
): NonNullable<NoteBlock["comments"]> {
  const next = Object.assign(
    Object.create(null) as NonNullable<NoteBlock["comments"]>,
    existing ?? {},
  );
  for (const [key, raw] of Object.entries(patch)) {
    if (!raw || typeof raw !== "object") continue;
    const incoming = raw as Partial<NoteComment> & { body?: { value?: unknown } };
    const before = next[key];
    next[key] = {
      id: key,
      body: stampedWith(boundCommentBody((incoming.body as { value?: unknown } | undefined)?.value), at),
      author: boundCommentAuthor(incoming.author ?? before?.author),
      // The earliest creation survives, which is `mergeCreation`'s rule: a
      // comment is written once, so a later stamp for it is a re-derivation.
      createdAt: before?.createdAt ?? at,
      resolved: stampedWith(
        (incoming.resolved as { value?: unknown } | undefined)?.value === true,
        at,
      ),
      ...((incoming as { deletedAt?: unknown }).deletedAt || before?.deletedAt
        ? { deletedAt: at }
        : {}),
    };
  }
  return next;
}

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
    // Advance only through the last row actually delivered. The SQL read is
    // bounded; jumping to MAX(revision) here would strand every row beyond that
    // page because the next pull would ask strictly after an unseen revision.
    cursor: rows.at(-1)?.revision
      ?? (since && /^\d+$/.test(since) ? since : await store().latestNoteRevision(orgId, userId)),
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

export interface NoteTrashEntryDto {
  id: string;
  kind: string;
  title: string;
  descendants: number;
  deletedAt: Hlc;
  line: string;
}

/** Authenticated trash projection over the complete tombstone corpus. */
export async function listTrash(
  orgId: string,
  userId: string,
): Promise<NoteTrashEntryDto[]> {
  return listTrashEntries(await listAllBlocks(orgId, userId)).map((entry) => {
    const title = pageTitleOrDefault(entry.block);
    return {
      id: entry.block.id,
      kind: entry.block.kind.value,
      title,
      descendants: entry.descendants,
      deletedAt: entry.deletedAt,
      line: describeTrashEntry(entry, title),
    };
  });
}

export interface OrphanedNoteThreadDto {
  blockId: string;
  text: string;
  comments: Array<{
    id: string;
    body: string;
    author: string;
    resolved: boolean;
    createdAtMs: number;
  }>;
}

/** C5 — complete deleted-block comment projection; no bounded pull derivation. */
export async function listOrphanedCommentThreads(
  orgId: string,
  userId: string,
): Promise<OrphanedNoteThreadDto[]> {
  return orphanedComments(await listAllBlocks(orgId, userId), isLiveBlock).map((entry) => ({
    blockId: entry.block.id,
    text: entry.block.text.value,
    comments: entry.comments.map((comment) => ({
      id: comment.id,
      body: comment.body.value,
      author: comment.author,
      resolved: comment.resolved.value === true,
      createdAtMs: comment.createdAt.physical,
    })),
  }));
}

export async function getBlock(orgId: string, userId: string, id: string): Promise<NoteBlock | null> {
  const row = await store().getNoteBlock(orgId, userId, id);
  return row ? blockOf(row) : null;
}

/** Who owns a block and how widely it is shared, without reading its text (A4). */
export async function findBlockOwner(orgId: string, id: string): Promise<NoteBlockOwnerRow | null> {
  return store().findNoteBlockInOrg(orgId, id);
}

/* -------------------------------------------------- Part E: pages and views */

/**
 * ADR-029 E4 — the sidebar, from the projection rather than from the corpus.
 *
 * This is the read the dashboard opens with, and the reason migration 053
 * exists: answering it from `notes_blocks` means parsing every paragraph
 * somebody has ever typed to find the forty rows that are pages.
 */
export async function listPages(
  orgId: string,
  userId: string,
  opts: { favouritesOnly?: boolean; limit?: number } = {},
): Promise<NotePageMetaRow[]> {
  return store().listNotePageMeta(orgId, userId, {
    kinds: ["page", DATABASE_BLOCK_KIND],
    ...(opts.favouritesOnly ? { favouritesOnly: true } : {}),
    ...(opts.limit ? { limit: opts.limit } : {}),
  });
}

/** E3's picker: every database a row could be added to, with its columns. */
export async function listDatabases(orgId: string, userId: string): Promise<NotePageMetaRow[]> {
  return store().listNotePageMeta(orgId, userId, { kinds: [DATABASE_BLOCK_KIND] });
}

/** E4's favourites section. Any block, not only a page — people pin lines too. */
export async function listFavourites(orgId: string, userId: string): Promise<NotePageMetaRow[]> {
  return store().listNotePageMeta(orgId, userId, { favouritesOnly: true });
}

/**
 * One page and the blocks under it, in document order.
 *
 * Bounded, and the bound is reported. Q3 makes the argument for the agent's
 * context and it applies to an HTTP response for the same reason: a page is
 * unbounded, so "return the page" has no upper limit and the caller finds out
 * by timing out.
 */
export async function readPage(
  orgId: string,
  userId: string,
  pageId: string,
  limit = 1000,
): Promise<{
  page: NoteBlock;
  blocks: NoteBlock[];
  truncated: boolean;
  exportFormats: NoteExportFormat[];
} | null> {
  const page = await getBlock(orgId, userId, pageId);
  if (!page || !isLiveBlock(page)) return null;
  const rows = await store().listNoteChildBlocks(orgId, userId, pageId, limit + 1);
  const blocks = rows.map(blockOf).filter(isLiveBlock);
  return {
    page,
    blocks: blocks.slice(0, limit),
    truncated: blocks.length > limit,
    // F1 — the menu is told what this block can honestly be written as, rather
    // than deciding for itself. A surface that guessed would eventually offer
    // "Export as CSV" on a page of paragraphs, which has no honest answer.
    exportFormats: exportFormatsFor(page),
  };
}

export interface DatabaseViewResult {
  projection: DatabaseProjection;
  /**
   * Every view this database has, not just the projected one.
   *
   * The projection carries the view it ran; a surface offering a tab strip needs
   * the others, and asking it to fetch each one to discover its name would make
   * opening a database cost one request per view.
   */
  views: Array<{ id: string; name: string; kind: string }>;
  /** How many live rows the database has, against how many this read looked at. */
  rowsInDatabase: number;
  rowsRead: number;
  /** F1 — what a download menu may offer for this block, decided by core. */
  exportFormats: NoteExportFormat[];
}

/**
 * E3 — a database, projected through one of its views.
 *
 * **The projection is `projectDatabase`, in core.** Filters, sorts and grouping
 * are not re-expressed in SQL here: a second implementation of the view language
 * would drift from the one the desktop runs, and the symptom is the same board
 * showing different cards on two screens with nothing to say which is right.
 * What the database does instead is bound and pre-order the read.
 *
 * The bound is reported rather than hidden. A view whose filter would have
 * matched a row past the cap does not show it, and a caller that is not told how
 * many rows it actually read has no way to know that happened.
 */
export async function readDatabaseView(
  orgId: string,
  userId: string,
  databaseId: string,
  opts: { viewId?: string; limit?: number } = {},
): Promise<DatabaseViewResult | null> {
  const block = await getBlock(orgId, userId, databaseId);
  if (!block || !isLiveBlock(block)) return null;

  const database: NoteDatabase = readDatabase(block);
  const view = database.views.find((candidate) => candidate.id === opts.viewId) ?? database.views[0];
  // The first sort key orders the SQL read, so the bounded window is the window
  // the view would have wanted rather than an arbitrary one.
  const primary = view?.sort?.[0];

  const rows = await store().listNoteDatabaseRows(orgId, userId, databaseId, {
    ...(primary ? { orderBy: primary.property, descending: primary.direction === "desc" } : {}),
    ...(opts.limit ? { limit: opts.limit } : {}),
  });
  const rowBlocks = rows.map(blockOf).filter(isLiveBlock);
  const projection = projectDatabase([block, ...rowBlocks], databaseId, opts.viewId);
  if (!projection) return null;

  return {
    projection,
    views: database.views.map((candidate) => ({ id: candidate.id, name: candidate.name, kind: candidate.kind })),
    rowsInDatabase: await store().countNoteDatabaseRows(orgId, userId, databaseId),
    rowsRead: rowBlocks.length,
    exportFormats: exportFormatsFor(block),
  };
}

/** F2 — authenticated server equivalent of Core's local rollup-target picker. */
export async function readRollupTargetProperties(
  orgId: string,
  userId: string,
  databaseId: string,
  relationPropertyId: string,
): Promise<RollupTargetPropertiesResult> {
  return rollupTargetPropertiesFromBlocks(
    await listAllBlocks(orgId, userId),
    databaseId,
    relationPropertyId,
  );
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
    // Document order, denormalised in the same statement as the payload it comes
    // from (053). A page read that had to re-sort in Node could not also be
    // bounded: the first 200 rows by write order are not the first 200 rows of
    // the document.
    rank: block.rank?.value ?? FIRST_RANK,
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
  // References are extracted from the prose AND the property values (ADR-029
  // E3/E5); the search TEXT stays the prose alone. A relation cell is referring
  // content, so indexing only `text` for links would answer "what links here"
  // correctly for a link typed in a sentence and silently miss the identical
  // link stored in a column — the split A2 exists to prevent. Its option ids and
  // person handles are not prose, though, and folding them into the searchable
  // text would make the client's `searchNotes` and this disagree about what a
  // text match is.
  const referring = blockReferenceText(block);
  if (!isLiveBlock(block)) {
    await store().replaceNoteRefs(orgId, userId, block.id, []);
    await store().deleteNoteIndexEntry(orgId, userId, block.id);
    // Part E's projections retract with everything else. A tombstoned page that
    // stayed in `notes_page_meta` would be a sidebar row that opens nothing —
    // C5 says a deleted target renders as a tombstone where it is REFERENCED,
    // not that it keeps a place in the navigation of the person who deleted it.
    await store().replaceNoteRowValues(orgId, userId, block.id, null, []);
    await store().deleteNotePageMeta(orgId, userId, block.id);
    return;
  }
  await projectPartE(orgId, userId, block);

  const perTarget = new Map<string, Omit<NoteRefRow, "fromBlockId"> & { fragmentSet: Set<string> }>();
  for (const ref of extractWorkspaceRefs(referring)) {
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
 * A sidebar row is a line, not a document.
 *
 * The title is bounded here rather than trusted because this projection exists
 * to be read WITHOUT the payload — a page called by its whole first paragraph
 * would put the cost back that the table removed, in the one query that is run
 * on every open.
 */
const MAX_PROJECTED_TITLE = 200;

/**
 * ADR-029 Part E — project one block into the two queryable tables (053).
 *
 * Which blocks get a `notes_page_meta` row is a decision, not a filter that grew:
 * a page, a database, or anything somebody pinned. Every block would duplicate
 * `notes_index` and pay a projection on every paragraph keystroke to answer a
 * question only ever asked about pages; only pages would lose E4's favourites,
 * which are explicitly not restricted to pages.
 *
 * A block that STOPS qualifying — un-pinned, or turned back into a paragraph —
 * has its row removed rather than left behind. A projection that only grows is
 * how a sidebar starts listing things that are not there, which is the same
 * defect an add-only reference index has.
 */
async function projectPartE(orgId: string, userId: string, block: NoteBlock): Promise<void> {
  const kind = block.kind?.value ?? "paragraph";
  const favourite = block.favourite?.value === true;
  const navigable = kind === "page" || kind === DATABASE_BLOCK_KIND || favourite;

  if (navigable) {
    await store().upsertNotePageMeta(orgId, userId, {
      blockId: block.id,
      parentId: block.parentId?.value ?? null,
      kind,
      rank: block.rank?.value ?? FIRST_RANK,
      title: (block.text?.value ?? "").trim().slice(0, MAX_PROJECTED_TITLE),
      icon: block.icon?.value ?? null,
      cover: block.cover?.value ?? null,
      favourite,
      // E3's schema and views ride on the database block itself. Copied into the
      // projection so listing "every database I could add a row to" does not mean
      // reading every page; the block stays the record either version disagrees
      // with, because only one of them is ever written by a merge.
      schema: kind === DATABASE_BLOCK_KIND ? [...(block.schema?.value ?? [])] : null,
      views: kind === DATABASE_BLOCK_KIND ? [...(block.views?.value ?? [])] : null,
    });
  } else {
    await store().deleteNotePageMeta(orgId, userId, block.id);
  }

  await store().replaceNoteRowValues(
    orgId, userId, block.id, block.parentId?.value ?? null,
    Object.entries(block.props ?? {}).map(([propertyId, stamped]) =>
      projectCell(propertyId, stamped?.value ?? null)),
  );
}

/**
 * One cell, projected by the SHAPE of its value rather than its declared type.
 *
 * The type lives on the database block, and a projection that had to read
 * another row to know how to write this one would be wrong for exactly as long
 * as the two were out of step — which is every moment between adding a column
 * and its rows catching up. The shape is enough for the comparison the scalar
 * columns are for, and `value_json` carries the exact value for everything else.
 *
 * A list gets a joined `value_text` and no scalar, because there is no scalar
 * column that is honest about a multi-select. Rendering always reads the json.
 */
function projectCell(propertyId: string, value: NotePropertyValue): NoteRowValueInput {
  const cell: NoteRowValueInput = {
    propertyId, value, text: null, number: null, bool: null, date: null,
  };
  if (value === null || value === undefined) return cell;
  if (typeof value === "number") return { ...cell, number: value, text: String(value) };
  if (typeof value === "boolean") return { ...cell, bool: value, text: String(value) };
  if (Array.isArray(value)) return { ...cell, text: value.join(", ").slice(0, MAX_META_TEXT) };
  const text = String(value).slice(0, MAX_META_TEXT);
  // The day, never an instant — `datePropertyDay` is the same function the view
  // language groups a calendar by, so a filter and a projection cannot disagree
  // about which day a due date falls on.
  return { ...cell, text, date: datePropertyDay(value) };
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
  input: {
    kind?: NoteBlockKind;
    text?: string;
    parentId?: string | null;
    level?: number;
    visibility?: string;
    /**
     * ADR-029 E6 — the fields a created block may arrive WITH.
     *
     * Without this the server's create could express `kind` and `parentId` and
     * nothing else, so a database row created through the workspace verbs
     * appeared with every column empty and a page arrived without its icon —
     * verbatim the outcome E6 says it closes. The values are stamped by the
     * same `incomingBlock` a pushed operation goes through and validated by the
     * same `validatePatch`, so create and update cannot drift apart.
     */
    fields?: Readonly<Record<string, unknown>>;
  },
  nowMs: number,
): Promise<NoteBlock> {
  return withNotesMutation(orgId, userId, async () => {
    const kind = input.kind ?? "paragraph";
    if (!NOTE_BLOCK_KINDS.includes(kind)) throw new Error(`"${kind}" is not a block kind`);
    const text = input.text ?? "";
    if (text.length > MAX_BLOCK_TEXT) throw new Error(`A block holds at most ${MAX_BLOCK_TEXT} characters`);

    const rows = await absorbStoredNoteClocks(orgId, userId);
    const at = await store().nextNoteHostClock(orgId, userId, "server", nowMs, 1);
    const parentId = input.parentId ?? null;
    const siblings = rows
      .filter((r) => !r.deletedAtHlc && r.parentId === parentId)
      .map(blockOf);
    const last = siblings.map((b) => b.rank?.value).filter((r): r is string => typeof r === "string").sort().at(-1);

    const patch: Record<string, unknown> = {
      ...(input.fields ?? {}),
      kind,
      text,
      parentId,
      rank: last ? rankBetween(last, null) : FIRST_RANK,
      ...(input.level !== undefined ? { level: input.level } : {}),
    };
    // The same bounds a pushed operation gets. A create is not a privileged path:
    // an icon or a schema that arrives here reaches every viewer of the page.
    const invalid = validatePatch(patch);
    if (invalid) throw new Error(invalid);

    const block = incomingBlock(
      null,
      {
        idempotencyKey: "",
        itemId: `blk_${nowMs.toString(36)}${randomUUID().slice(0, 8)}_server`,
        kind: "create",
        at,
        payload: patch,
      },
      patch,
    );
    return persistBlock(orgId, userId, block, input.visibility);
  });
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
  return withNotesMutation(orgId, userId, () => pushOperationsLocked(orgId, userId, operations));
}

async function pushOperationsLocked(
  orgId: string,
  userId: string,
  operations: readonly NotePushOperation[],
): Promise<PushOutcome> {
  const outcome: PushOutcome = { accepted: [], rejected: [] };

  for (const op of operations) {
    const receiptKey = pushReceiptKey(op.idempotencyKey);
    const fingerprint = pushFingerprint(op);
    const receipt = await store().getNoteOperationReceipt(orgId, userId, receiptKey);
    if (receipt) {
      if (receipt.fingerprint && receipt.fingerprint !== fingerprint) {
        outcome.rejected.push({
          idempotencyKey: op.idempotencyKey,
          reason: "This idempotency key was already used for a different Notes operation.",
        });
        continue;
      }
      // Report a byte-identical redelivery as accepted: from the client's side
      // it did land, and there is no second effect to apply.
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

    const invalid = validatePatch(patch, op.itemId);
    if (invalid) {
      outcome.rejected.push({ idempotencyKey: op.idempotencyKey, reason: invalid });
      continue;
    }

    await store().observeNoteHostClock(orgId, userId, op.at);
    const existingRow = await store().getNoteBlock(orgId, userId, op.itemId);
    const existing = existingRow ? blockOf(existingRow) : null;

    const merged = existing
      ? await mergeIncoming(orgId, userId, existing, op, patch)
      : { block: incomingBlock(null, op, patch) };

    await persistBlock(orgId, userId, merged.block, existingRow?.visibility);
    await store().recordNoteOperationApplied(
      orgId, userId, receiptKey, op.itemId, fingerprint,
    );
    outcome.accepted.push(op.idempotencyKey);
    if (merged.penalty) {
      (outcome.fenced ??= []).push({
        idempotencyKey: op.idempotencyKey,
        itemId: op.itemId,
        reason: merged.penalty,
      });
    }
  }
  return outcome;
}

function validatePatch(patch: Record<string, unknown>, itemId?: unknown): string | null {
  if (itemId !== undefined && patch.parentId === itemId) return "A block cannot be its own parent.";
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
  // ADR-029 F3 — comments reach an agent's context (C4) and every viewer of a
  // shared page, so the count and the length are bounded on this side too. The
  // client bounds the body it writes; a push is not the client.
  if (patch.comments !== undefined) {
    if (!patch.comments || typeof patch.comments !== "object" || Array.isArray(patch.comments)) {
      return "Comments are a map keyed by comment id.";
    }
    const entries = Object.entries(patch.comments as Record<string, unknown>);
    if (entries.length > MAX_COMMENTS_PER_PUSH) {
      return `One operation carries at most ${MAX_COMMENTS_PER_PUSH} comments; this one had ${entries.length}.`;
    }
    for (const [commentId, raw] of entries) {
      if (!safeMapKey(commentId)) return "A comment id is reserved or invalid.";
      const body = (raw as { body?: { value?: unknown } } | null)?.body?.value;
      if (typeof body === "string" && body.length > MAX_COMMENT_LENGTH) {
        return `A comment holds at most ${MAX_COMMENT_LENGTH} characters; this one had ${body.length}.`;
      }
    }
  }
  if (patch.props && typeof patch.props === "object" && !Array.isArray(patch.props)) {
    for (const propertyId of Object.keys(patch.props as Record<string, unknown>)) {
      if (!safeMapKey(propertyId)) return "A property id is reserved or invalid.";
    }
  }
  // ADR-029 E3 — the database fields, bounded by the SAME function the client
  // uses. A schema is the header row every viewer of a shared database sees, so
  // the limit on what one push can make everyone receive belongs on this side.
  return validateDatabaseFields(patch);
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
): Promise<{ block: NoteBlock; penalty?: BlockFence }> {
  // A conflict resolution is not a field write: it picks one of two kept
  // versions. Applying it as a patch would merge the choice against the
  // conflict it was resolving and leave the marker in place.
  if (typeof patch.field === "string" && (patch.keep === "ours" || patch.keep === "theirs")) {
    return { block: resolveBlockConflict(existing, patch.field, patch.keep, op.at) ?? existing };
  }

  const incoming = incomingBlock(existing, op, patch);
  const { lease, dbNowMs } = await store().readNoteBlockLease(orgId, userId, op.itemId);
  const claimed = typeof patch.leaseEpoch === "number" ? patch.leaseEpoch : undefined;
  const fence = fenceBlockWrite(
    lease ? toLease(lease) : undefined,
    { deviceId: op.at.deviceId, ...(claimed === undefined ? {} : { epoch: claimed }) },
    dbNowMs,
  );
  const penalty = penaltyOf(fence);
  return {
    block: mergeNoteBlock(existing, incoming, penalty),
    ...(penalty ? { penalty } : {}),
  };
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
    // ADR-029 F3 — the server records a creation for a block it has never seen,
    // and `mergeNoteBlock` keeps the EARLIEST of the two. So a client that
    // recorded its own creation keeps it, and a block whose create was shed from
    // an offline outbox still gets one rather than an empty "Created" column.
    createdAt: at,
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
    // ADR-029 F3 — a page marked as a template. One stamped boolean, because a
    // template is a page and marking is the whole difference.
    ...(typeof patch.template === "boolean" ? { template: stampedWith(patch.template, at) } : {}),
    // F3 — comments, stamped per key and merged onto what the block already has,
    // for the reason `props` is: a push carrying one remark must not overwrite
    // the thread it happened to be holding a stale copy of.
    ...(patch.comments && typeof patch.comments === "object" && !Array.isArray(patch.comments)
      ? { comments: stampedComments(base.comments, patch.comments as Record<string, unknown>, at) }
      : {}),
    // ADR-029 E3 — a row's property values, stamped PER KEY and merged onto what
    // the block already has. Replacing the map wholesale would make an operation
    // that set one cell also win every other cell the pushing device happened to
    // be holding a stale copy of — the field-level rule D4 exists to avoid, lost
    // one level down.
    ...(patch.props && typeof patch.props === "object" && !Array.isArray(patch.props)
      ? { props: stampedProps(base.props, patch.props as Record<string, unknown>, at) }
      : {}),
    ...(Array.isArray(patch.schema)
      ? { schema: stampedWith(patch.schema as readonly NotePropertyDef[], at) }
      : {}),
    ...(Array.isArray(patch.views)
      ? { views: stampedWith(patch.views as readonly NoteDatabaseView[], at) }
      : {}),
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
  return withNotesMutation(orgId, userId, async () => {
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
  });
}

/** Q1's "renewed while typing". The epoch does not move — see `blockLease.ts`. */
export async function renewLease(
  orgId: string,
  userId: string,
  blockId: string,
  claim: LeaseClaim,
): Promise<LeaseOutcome> {
  return withNotesMutation(orgId, userId, async () => {
    const { lease, dbNowMs } = await store().readNoteBlockLease(orgId, userId, blockId);
    const outcome = renewBlockLease(lease ? toLease(lease) : undefined, claim, dbNowMs);
    if (outcome.ok) await store().upsertNoteBlockLease(orgId, userId, toRow(outcome.lease));
    return outcome;
  });
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
  return withNotesMutation(orgId, userId, async () => {
    const { lease, dbNowMs } = await store().readNoteBlockLease(orgId, userId, blockId);
    const outcome = releaseBlockLease(lease ? toLease(lease) : undefined, claim, dbNowMs);
    if (outcome.ok) await store().upsertNoteBlockLease(orgId, userId, toRow(outcome.lease));
    return outcome;
  });
}

/* ------------------------------------------------ ADR-038: shared mutation */

function emptyMutationSync(): NotesMutationSyncReport {
  return {
    accepted: [...EMPTY_NOTES_MUTATION_SYNC.accepted],
    rejected: [...EMPTY_NOTES_MUTATION_SYNC.rejected],
    fenced: [...EMPTY_NOTES_MUTATION_SYNC.fenced],
  };
}

function mutationSync(outcome: PushOutcome): NotesMutationSyncReport {
  return {
    accepted: [...outcome.accepted],
    rejected: [...outcome.rejected],
    fenced: (outcome.fenced ?? []).map((entry) => ({
      idempotencyKey: entry.idempotencyKey,
      itemId: entry.itemId,
      reason: entry.reason,
    })),
  };
}

function mutationSuccess(
  request: NotesMutationRequest,
  result: unknown,
  sync: NotesMutationSyncReport = emptyMutationSync(),
): NotesMutationResponse {
  return {
    version: NOTES_EDITING_CONTRACT_VERSION,
    requestId: request.requestId,
    operation: request.operation.type,
    ok: true,
    result,
    sync,
    history: REMOTE_NOTES_HISTORY_STATE,
  };
}

function mutationFailure(
  request: NotesMutationRequest,
  error: NotesMutationError,
  sync: NotesMutationSyncReport = emptyMutationSync(),
): NotesMutationResponse {
  return {
    version: NOTES_EDITING_CONTRACT_VERSION,
    requestId: request.requestId,
    operation: request.operation.type,
    ok: false,
    error,
    sync,
    history: REMOTE_NOTES_HISTORY_STATE,
  };
}

function mutationLimitFailure(
  request: NotesMutationRequest,
  operations: number,
): NotesMutationResponse {
  return mutationFailure(request, {
    code: "limit_exceeded",
    detail: `A Notes mutation may affect at most ${MAX_GENERATED_MUTATION_OPERATIONS} blocks; this would affect ${operations}.`,
    retryable: false,
  });
}

function planFailure(
  request: NotesMutationRequest,
  failure: { reason: string; detail: string },
): NotesMutationResponse {
  return mutationFailure(request, {
    code: failure.reason === "not_found" ? "not_found" : "refused",
    detail: failure.detail,
    retryable: false,
  });
}

const MAX_GENERATED_MUTATION_OPERATIONS = 200;

/** Stable across retries, domain-separated, and scoped by the receipt table. */
function mutationMarker(request: NotesMutationRequest): string {
  return `notes:mutation:v1:${digestParts(request.deviceId, request.requestId)}`;
}

function primitiveKey(request: NotesMutationRequest, index: number): string {
  return `notes:mutation-primitive:v1:${digestParts(
    request.deviceId, request.requestId, String(index),
  )}`;
}

function mutationFingerprint(request: NotesMutationRequest): string {
  return digestParts(canonicalJson(request));
}

function deterministicMutationId(
  prefix: "blk" | "cmt",
  request: NotesMutationRequest,
  source: string,
  index: number,
): string {
  const digest = createHash("sha256")
    .update(`${request.requestId}\0${request.deviceId}\0${source}\0${index}`)
    .digest("hex")
    .slice(0, 20);
  const device = request.deviceId.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 40) || "remote";
  return `${prefix}_${digest}_${device}`;
}

function operationBlockId(operation: NotesMutationOperation): string | null {
  switch (operation.type) {
    case "block.create": return operation.input.blockId ?? null;
    case "block.update":
    case "block.delete":
    case "block.restore":
    case "block.move":
    case "gesture.split":
    case "gesture.merge":
    case "gesture.duplicate":
    case "gesture.indent":
    case "gesture.outdent":
    case "gesture.move":
    case "lease.acquire":
    case "lease.renew":
    case "lease.release":
    case "comment.add":
    case "comment.edit":
    case "comment.resolve":
    case "comment.delete":
    case "conflict.resolve":
    case "attachment.upload-bytes": return operation.blockId;
    case "template.instantiate": return operation.templateId;
    case "database.row.create": return operation.databaseId;
    case "database.row.set":
    case "database.row.delete": return operation.rowId;
    case "database.property.add":
    case "database.property.update":
    case "database.property.delete":
    case "database.property.reorder":
    case "database.view.save":
    case "database.view.delete": return operation.databaseId;
    case "history.state":
    case "history.undo":
    case "history.redo": return operation.pageId ?? null;
  }
}

function pushOperation(
  request: NotesMutationRequest,
  index: number,
  itemId: string,
  kind: NotePushOperation["kind"],
  payload: Record<string, unknown>,
): NotePushOperation {
  return {
    idempotencyKey: primitiveKey(request, index),
    itemId,
    kind,
    at: {
      physical: Date.now(),
      logical: index,
      deviceId: request.deviceId,
    },
    payload,
  };
}

function pushOperationAt(
  request: NotesMutationRequest,
  base: Hlc,
  index: number,
  itemId: string,
  kind: NotePushOperation["kind"],
  payload: Record<string, unknown>,
): NotePushOperation {
  const operation = pushOperation(request, index, itemId, kind, payload);
  operation.at.physical = base.physical;
  operation.at.logical = base.logical + index;
  return operation;
}

class AtomicNotesMutationRejection extends Error {
  public constructor(public readonly outcome: PushOutcome) {
    super("The Notes mutation contained a refused primitive operation.");
    this.name = "AtomicNotesMutationRejection";
  }
}

class NotesMutationLimitError extends Error {
  public constructor(public readonly operations: number) {
    super(`A Notes mutation may generate at most ${MAX_GENERATED_MUTATION_OPERATIONS} operations; this generated ${operations}.`);
    this.name = "NotesMutationLimitError";
  }
}

async function pushMutationOperations(
  orgId: string,
  userId: string,
  request: NotesMutationRequest,
  operations: readonly NotePushOperation[],
): Promise<NotesMutationSyncReport> {
  if (operations.length > MAX_GENERATED_MUTATION_OPERATIONS) {
    throw new NotesMutationLimitError(operations.length);
  }
  const outcome = await pushOperationsLocked(orgId, userId, operations);
  if (outcome.rejected.length > 0) throw new AtomicNotesMutationRejection(outcome);
  return mutationSync(outcome);
}

function rejectedMutation(
  request: NotesMutationRequest,
  sync: NotesMutationSyncReport,
): NotesMutationResponse | null {
  if (sync.rejected.length === 0) return null;
  return mutationFailure(request, {
    code: "sync_rejected",
    detail: sync.rejected.map((entry) => entry.reason).join("; "),
    retryable: false,
  }, sync);
}

function gestureOf(operation: NotesMutationOperation): NoteGesture | null {
  switch (operation.type) {
    case "gesture.split":
      return { type: "split", blockId: operation.blockId, caret: operation.caret };
    case "gesture.merge": return { type: "merge", blockId: operation.blockId };
    case "gesture.duplicate": return { type: "duplicate", blockId: operation.blockId };
    case "gesture.indent": return { type: "indent", blockId: operation.blockId };
    case "gesture.outdent": return { type: "outdent", blockId: operation.blockId };
    case "gesture.move":
      return { type: "move", blockId: operation.blockId, direction: operation.direction };
    default: return null;
  }
}

function leaseEpochOf(operation: NotesMutationOperation): number | undefined {
  switch (operation.type) {
    case "block.update":
    case "gesture.split":
    case "gesture.merge":
    case "database.row.set":
    case "database.property.add":
    case "database.property.update":
    case "database.property.delete":
    case "database.property.reorder":
    case "database.view.save":
    case "database.view.delete": return operation.leaseEpoch;
    default: return undefined;
  }
}

function operationsForGesturePlan(
  request: NotesMutationRequest,
  plan: NoteGesturePlan,
  base: Hlc,
  leasedBlockId: string,
): NotePushOperation[] {
  if (!plan.ok) return [];
  const out: NotePushOperation[] = [];
  const leaseEpoch = leaseEpochOf(request.operation);
  for (const step of plan.steps) {
    if (step.type === "create") {
      const { id, parentId, rank, ...fields } = step.block;
      out.push(pushOperationAt(request, base, out.length, id, "create", {
        ...fields,
        parentId,
        rank,
      }));
      continue;
    }
    if (step.type === "update") {
      out.push(pushOperationAt(request, base, out.length, step.blockId, "update", {
        ...step.patch,
        ...(leaseEpoch !== undefined && step.blockId === leasedBlockId ? { leaseEpoch } : {}),
      }));
      continue;
    }
    if (step.type === "move") {
      out.push(pushOperationAt(request, base, out.length, step.blockId, "update", {
        parentId: step.parentId,
        rank: step.rank,
      }));
      continue;
    }
    for (const blockId of step.subtreeIds) {
      out.push(pushOperationAt(request, base, out.length, blockId, "delete", {}));
    }
  }
  return out;
}

async function applyGestureMutation(
  orgId: string,
  userId: string,
  request: NotesMutationRequest,
  base: Hlc,
): Promise<NotesMutationResponse> {
  const gesture = gestureOf(request.operation);
  if (!gesture) return mutationFailure(request, {
    code: "invalid_request", detail: "This is not a Notes gesture.", retryable: false,
  });
  const blocks = await listAllBlocks(orgId, userId);
  const plan = planNoteGesture(blocks, gesture, {
    mintId: (source, index) => deterministicMutationId("blk", request, source, index),
  });
  if (!plan.ok) return planFailure(request, plan.result);
  const operations = operationsForGesturePlan(request, plan, base, gesture.blockId);
  const sync = await pushMutationOperations(orgId, userId, request, operations);
  return rejectedMutation(request, sync) ?? mutationSuccess(request, plan.result, sync);
}

async function deleteMutationSubtree(
  orgId: string,
  userId: string,
  request: NotesMutationRequest,
  blockId: string,
  base: Hlc,
): Promise<NotesMutationResponse> {
  const blocks = await listAllBlocks(orgId, userId);
  const ids = subtreeBlockIds(blocks, blockId);
  if (ids.length === 0) return mutationFailure(request, {
    code: "not_found", detail: `No block ${blockId}.`, retryable: false,
  });
  if (ids.length > MAX_GENERATED_MUTATION_OPERATIONS) return mutationLimitFailure(request, ids.length);
  const operations = ids.map((id, index) =>
    pushOperationAt(request, base, index, id, "delete", {}));
  const sync = await pushMutationOperations(orgId, userId, request, operations);
  return rejectedMutation(request, sync) ?? mutationSuccess(request, { removedIds: ids }, sync);
}

async function restoreMutationSubtree(
  orgId: string,
  userId: string,
  request: NotesMutationRequest,
  blockId: string,
  base: Hlc,
): Promise<NotesMutationResponse> {
  const blocks = await listAllBlocks(orgId, userId);
  const ids = deletedSubtreeIds(blocks, blockId);
  if (ids.length === 0) return mutationFailure(request, {
    code: "not_found", detail: `No deleted block ${blockId}.`, retryable: false,
  });
  if (ids.length > MAX_GENERATED_MUTATION_OPERATIONS) return mutationLimitFailure(request, ids.length);
  const operations = ids.map((id, index) =>
    pushOperationAt(request, base, index, id, "update", { restore: true }));
  const sync = await pushMutationOperations(orgId, userId, request, operations);
  return rejectedMutation(request, sync) ?? mutationSuccess(request, { restoredIds: ids }, sync);
}

async function instantiateTemplateMutation(
  orgId: string,
  userId: string,
  request: NotesMutationRequest,
  base: Hlc,
): Promise<NotesMutationResponse> {
  if (request.operation.type !== "template.instantiate") {
    return mutationFailure(request, {
      code: "invalid_request", detail: "This is not a template mutation.", retryable: false,
    });
  }
  const operation = request.operation;
  const blocks = await listAllBlocks(orgId, userId);
  const template = blocks.find((block) => block.id === operation.templateId);
  if (!template || !isTemplate(template)) return mutationFailure(request, {
    code: "not_found", detail: `No template ${operation.templateId}.`, retryable: false,
  });
  const plan = planNoteSubtreeCopy(
    blocks,
    operation.templateId,
    { parentId: operation.parentId },
    { mintId: (source, index) => deterministicMutationId("blk", request, source, index) },
  );
  if (!plan.ok) return planFailure(request, plan.result);
  const operations = operationsForGesturePlan(request, plan, base, operation.templateId);
  if (operations.length > MAX_GENERATED_MUTATION_OPERATIONS) {
    return mutationLimitFailure(request, operations.length);
  }
  const sync = await pushMutationOperations(orgId, userId, request, operations);
  const refused = rejectedMutation(request, sync);
  if (refused) return refused;

  const byId = new Map(blocks.map((block) => [block.id, block] as const));
  let rewritten = 0;
  for (const originalId of plan.idMap.keys()) {
    const original = byId.get(originalId);
    if (original && remapNoteRefs(original.text.value, plan.idMap) !== original.text.value) {
      rewritten += 1;
    }
  }
  const result = {
    ok: true,
    pageId: plan.result.createdId ?? null,
    blocks: plan.idMap.size,
    rewritten,
  };
  return mutationSuccess(request, {
    ...result,
    line: describeInstantiation(result),
  }, sync);
}

async function resolveConflictMutation(
  orgId: string,
  userId: string,
  request: NotesMutationRequest,
  base: Hlc,
): Promise<NotesMutationResponse> {
  if (request.operation.type !== "conflict.resolve") {
    return mutationFailure(request, {
      code: "invalid_request", detail: "This is not a conflict resolution.", retryable: false,
    });
  }
  const operation = request.operation;
  const block = await getBlock(orgId, userId, operation.blockId);
  if (!block) return mutationFailure(request, {
    code: "not_found", detail: `No block ${operation.blockId}.`, retryable: false,
  });
  if (!block.conflicts || !Object.hasOwn(block.conflicts, operation.field)) return mutationFailure(request, {
    code: "refused",
    detail: `Block ${operation.blockId} has no unresolved ${operation.field} conflict.`,
    retryable: false,
  });
  const conflict = block.conflicts[operation.field]!;
  const sameClock = (left: Hlc, right: Hlc): boolean => (
    left.physical === right.physical
    && left.logical === right.logical
    && left.deviceId === right.deviceId
  );
  if (!sameClock(conflict.oursAt, operation.expected.oursAt)
    || !sameClock(conflict.theirsAt, operation.expected.theirsAt)) {
    return mutationFailure(request, {
      code: "stale_conflict",
      detail: "This conflict changed after it was shown. Refresh it before choosing a version.",
      retryable: false,
    });
  }
  const sync = await pushMutationOperations(orgId, userId, request, [
    pushOperationAt(request, base, 0, operation.blockId, "update", {
      field: operation.field,
      keep: operation.keep,
    }),
  ]);
  const refused = rejectedMutation(request, sync);
  if (refused) return refused;
  return mutationSuccess(request, {
    block: await getBlock(orgId, userId, operation.blockId),
  }, sync);
}

async function applyDatabasePlan<T>(
  orgId: string,
  userId: string,
  request: NotesMutationRequest,
  databaseId: string,
  plan: DatabaseMutationPlan<T>,
  base: Hlc,
): Promise<NotesMutationResponse> {
  if (!plan.ok) return planFailure(request, plan);
  const leaseEpoch = leaseEpochOf(request.operation);
  const sync = await pushMutationOperations(orgId, userId, request, [
    pushOperationAt(request, base, 0, databaseId, "update", {
      ...plan.patch,
      ...(leaseEpoch === undefined ? {} : { leaseEpoch }),
    }),
  ]);
  const refused = rejectedMutation(request, sync);
  if (refused) return refused;
  return mutationSuccess(request, {
    value: plan.value,
    block: await getBlock(orgId, userId, databaseId),
  }, sync);
}

async function applyCommentMutation(
  orgId: string,
  userId: string,
  request: NotesMutationRequest,
  base: Hlc,
): Promise<NotesMutationResponse> {
  const operation = request.operation;
  if (!operation.type.startsWith("comment.")) {
    return mutationFailure(request, {
      code: "invalid_request", detail: "This is not a comment mutation.", retryable: false,
    });
  }
  const key = primitiveKey(request, 0);
  let outcome: CommentWriteOutcome;
  switch (operation.type) {
    case "comment.add":
      {
        const commentId = operation.commentId
          ?? deterministicMutationId("cmt", request, operation.blockId, 0);
        const block = await getBlock(orgId, userId, operation.blockId);
        if (block?.comments?.[commentId]) {
          return mutationFailure(request, {
            code: "refused", detail: `Comment id ${commentId} already exists.`, retryable: false,
          });
        }
        outcome = await addComment(orgId, userId, operation.blockId, {
        body: operation.body,
        ...(operation.author ? { author: operation.author } : {}),
        id: commentId,
        idempotencyKey: key,
      }, base);
      }
      break;
    case "comment.edit":
      outcome = await editComment(
        orgId, userId, operation.blockId, operation.commentId, operation.body, base, key,
      );
      break;
    case "comment.resolve":
      outcome = await setCommentResolved(
        orgId, userId, operation.blockId, operation.commentId, operation.resolved, base, key,
      );
      break;
    case "comment.delete":
      outcome = await removeComment(
        orgId, userId, operation.blockId, operation.commentId, base, key,
      );
      break;
    default:
      return mutationFailure(request, {
        code: "invalid_request", detail: "This is not a comment mutation.", retryable: false,
      });
  }
  if (!outcome.ok) {
    const sync = outcome.sync ? mutationSync(outcome.sync) : emptyMutationSync();
    return mutationFailure(request, {
      code: outcome.reason === "refused" ? "sync_rejected" : "not_found",
      detail: outcome.detail ?? (outcome.reason === "no_block" ? "No such block." : "No such comment."),
      retryable: false,
    }, sync);
  }
  return mutationSuccess(request, {
    comment: outcome.comment,
    blockDeleted: outcome.blockDeleted,
  }, mutationSync(outcome.sync));
}

async function applyContentMutation(
  orgId: string,
  userId: string,
  request: NotesMutationRequest,
  base: Hlc,
): Promise<NotesMutationResponse> {
  const operation = request.operation;
  if (operation.type.startsWith("gesture.")) {
    return applyGestureMutation(orgId, userId, request, base);
  }
  if (operation.type.startsWith("comment.")) {
    return applyCommentMutation(orgId, userId, request, base);
  }
  if (operation.type === "template.instantiate") {
    return instantiateTemplateMutation(orgId, userId, request, base);
  }
  if (operation.type === "conflict.resolve") {
    return resolveConflictMutation(orgId, userId, request, base);
  }

  switch (operation.type) {
    case "block.create": {
      const blocks = await listAllBlocks(orgId, userId);
      const id = operation.input.blockId
        ?? deterministicMutationId("blk", request, "create", 0);
      if (blocks.some((block) => block.id === id)) {
        return mutationFailure(request, {
          code: "refused", detail: `Block id ${id} already exists.`, retryable: false,
        });
      }
      const placed = resolveNoteMutationPosition(blocks, operation.input);
      if (!placed.ok) return mutationFailure(request, {
        code: "refused", detail: placed.detail, retryable: false,
      });
      const { blockId: _blockId, parentId: _parentId, after: _after, before: _before, ...fields } = operation.input;
      const schema = fields.kind === DATABASE_BLOCK_KIND ? defaultDatabaseSchema() : undefined;
      const views = schema ? defaultDatabaseViews(schema) : undefined;
      const sync = await pushMutationOperations(orgId, userId, request, [
        pushOperationAt(request, base, 0, id, "create", {
          ...fields,
          ...(schema ? { schema } : {}),
          ...(views ? { views } : {}),
          parentId: placed.parentId,
          rank: placed.rank,
        }),
      ]);
      const refused = rejectedMutation(request, sync);
      if (refused) return refused;
      return mutationSuccess(request, { block: await getBlock(orgId, userId, id) }, sync);
    }
    case "block.update": {
      const existing = await getBlock(orgId, userId, operation.blockId);
      if (!existing) return mutationFailure(request, {
        code: "not_found", detail: `No block ${operation.blockId}.`, retryable: false,
      });
      const schema = operation.patch.kind === DATABASE_BLOCK_KIND && !existing.schema
        ? defaultDatabaseSchema()
        : undefined;
      const views = schema && !existing.views ? defaultDatabaseViews(schema) : undefined;
      const sync = await pushMutationOperations(orgId, userId, request, [
        pushOperationAt(request, base, 0, operation.blockId, "update", {
          ...operation.patch,
          ...(schema ? { schema } : {}),
          ...(views ? { views } : {}),
          ...(operation.leaseEpoch === undefined ? {} : { leaseEpoch: operation.leaseEpoch }),
        }),
      ]);
      const refused = rejectedMutation(request, sync);
      if (refused) return refused;
      return mutationSuccess(request, {
        block: await getBlock(orgId, userId, operation.blockId),
      }, sync);
    }
    case "block.delete":
      return deleteMutationSubtree(orgId, userId, request, operation.blockId, base);
    case "block.restore":
      return restoreMutationSubtree(orgId, userId, request, operation.blockId, base);
    case "block.move": {
      const blocks = await listAllBlocks(orgId, userId);
      const placed = resolveNoteMutationPosition(blocks, operation.to, operation.blockId);
      if (!placed.ok) return mutationFailure(request, {
        code: placed.detail.startsWith("No block") ? "not_found" : "refused",
        detail: placed.detail,
        retryable: false,
      });
      const sync = await pushMutationOperations(orgId, userId, request, [
        pushOperationAt(request, base, 0, operation.blockId, "update", {
          parentId: placed.parentId,
          rank: placed.rank,
        }),
      ]);
      const refused = rejectedMutation(request, sync);
      if (refused) return refused;
      return mutationSuccess(request, {
        block: await getBlock(orgId, userId, operation.blockId),
      }, sync);
    }
    case "database.row.create": {
      const database = await getBlock(orgId, userId, operation.databaseId);
      const planned = planCreateDatabaseRow(database, operation.databaseId, {
        ...(operation.title !== undefined ? { title: operation.title } : {}),
        ...(operation.values ? { values: operation.values } : {}),
      });
      if (!planned.ok) return planFailure(request, planned);
      const blocks = await listAllBlocks(orgId, userId);
      const rowId = operation.rowId
        ?? deterministicMutationId("blk", request, operation.databaseId, 0);
      if (blocks.some((block) => block.id === rowId)) {
        return mutationFailure(request, {
          code: "refused", detail: `Block id ${rowId} already exists.`, retryable: false,
        });
      }
      const placed = resolveNoteMutationPosition(blocks, {
        parentId: operation.databaseId,
        ...(operation.after ? { after: operation.after } : {}),
        ...(operation.before ? { before: operation.before } : {}),
      });
      if (!placed.ok) return mutationFailure(request, {
        code: "refused", detail: placed.detail, retryable: false,
      });
      const sync = await pushMutationOperations(orgId, userId, request, [
        pushOperationAt(request, base, 0, rowId, "create", {
          ...planned.value,
          parentId: placed.parentId,
          rank: placed.rank,
        }),
      ]);
      const refused = rejectedMutation(request, sync);
      if (refused) return refused;
      return mutationSuccess(request, { row: await getBlock(orgId, userId, rowId) }, sync);
    }
    case "database.row.set": {
      const row = await getBlock(orgId, userId, operation.rowId);
      if (!row || !row.parentId.value) return mutationFailure(request, {
        code: "not_found", detail: `No database row ${operation.rowId}.`, retryable: false,
      });
      const databaseId = row.parentId.value;
      const database = await getBlock(orgId, userId, databaseId);
      const planned = planSetDatabaseRowValue(
        database, databaseId, row, operation.propertyId, operation.value,
      );
      if (!planned.ok) return planFailure(request, planned);
      const sync = await pushMutationOperations(orgId, userId, request, [
        pushOperationAt(request, base, 0, operation.rowId, "update", {
          ...planned.patch,
          ...(operation.leaseEpoch === undefined ? {} : { leaseEpoch: operation.leaseEpoch }),
        }),
      ]);
      const refused = rejectedMutation(request, sync);
      if (refused) return refused;
      return mutationSuccess(request, { row: await getBlock(orgId, userId, operation.rowId) }, sync);
    }
    case "database.row.delete":
      return deleteMutationSubtree(orgId, userId, request, operation.rowId, base);
    case "database.property.add":
      return applyDatabasePlan(
        orgId, userId, request, operation.databaseId,
        planAddDatabaseProperty(
          await getBlock(orgId, userId, operation.databaseId),
          operation.databaseId,
          operation.property,
        ),
        base,
      );
    case "database.property.update":
      return applyDatabasePlan(
        orgId, userId, request, operation.databaseId,
        planUpdateDatabaseProperty(
          await getBlock(orgId, userId, operation.databaseId),
          operation.databaseId,
          operation.propertyId,
          operation.patch,
        ),
        base,
      );
    case "database.property.delete":
      return applyDatabasePlan(
        orgId, userId, request, operation.databaseId,
        planDeleteDatabaseProperty(
          await getBlock(orgId, userId, operation.databaseId),
          operation.databaseId,
          operation.propertyId,
        ),
        base,
      );
    case "database.property.reorder":
      return applyDatabasePlan(
        orgId, userId, request, operation.databaseId,
        planReorderDatabaseProperties(
          await getBlock(orgId, userId, operation.databaseId),
          operation.databaseId,
          operation.order,
        ),
        base,
      );
    case "database.view.save":
      return applyDatabasePlan(
        orgId, userId, request, operation.databaseId,
        planSaveDatabaseView(
          await getBlock(orgId, userId, operation.databaseId),
          operation.databaseId,
          operation.view,
        ),
        base,
      );
    case "database.view.delete":
      return applyDatabasePlan(
        orgId, userId, request, operation.databaseId,
        planDeleteDatabaseView(
          await getBlock(orgId, userId, operation.databaseId),
          operation.databaseId,
          operation.viewId,
        ),
        base,
      );
    default:
      return mutationFailure(request, {
        code: "invalid_request", detail: `Unsupported mutation ${operation.type}.`, retryable: false,
      });
  }
}

function leaseMutationFailure(
  request: NotesMutationRequest,
  outcome: Exclude<LeaseOutcome, { ok: true }>,
): NotesMutationResponse {
  return mutationFailure(request, {
    code: "locked",
    detail: outcome.detail,
    retryable: outcome.reason === "held_by_another" || outcome.reason === "lease_expired",
  });
}

async function applyLeaseMutation(
  orgId: string,
  userId: string,
  request: NotesMutationRequest,
): Promise<NotesMutationResponse> {
  const operation = request.operation;
  const blockId = operationBlockId(operation);
  const block = blockId ? await getBlock(orgId, userId, blockId) : null;
  if (!block || !isLiveBlock(block)) {
    return mutationFailure(request, {
      code: "not_found", detail: `No block ${blockId ?? "requested"}.`, retryable: false,
    });
  }
  if (operation.type === "lease.acquire") {
    const outcome = await acquireLease(orgId, userId, operation.blockId, {
      deviceId: request.deviceId,
      ...(operation.holder ? { holder: operation.holder } : {}),
    });
    return outcome.ok ? mutationSuccess(request, { lease: outcome.lease }) : leaseMutationFailure(request, outcome);
  }
  if (operation.type === "lease.renew") {
    const outcome = await renewLease(orgId, userId, operation.blockId, {
      deviceId: request.deviceId,
      epoch: operation.epoch,
    });
    return outcome.ok ? mutationSuccess(request, { lease: outcome.lease }) : leaseMutationFailure(request, outcome);
  }
  if (operation.type === "lease.release") {
    const outcome = await releaseLease(orgId, userId, operation.blockId, {
      deviceId: request.deviceId,
      epoch: operation.epoch,
    });
    return outcome.ok ? mutationSuccess(request, { lease: outcome.lease }) : leaseMutationFailure(request, outcome);
  }
  return mutationFailure(request, {
    code: "invalid_request", detail: "This is not a lease mutation.", retryable: false,
  });
}

/**
 * Execute the one browser/host Notes mutation contract.
 *
 * The authenticated route supplies `(orgId,userId)`; neither value exists in
 * the request body, so a renderer cannot select another person's partition.
 * Existing `/push` remains the device-sync transport and this function composes
 * it for higher-level editor intentions.
 */
export async function mutateNotes(
  orgId: string,
  userId: string,
  request: NotesMutationRequest,
  nowMs: number,
): Promise<NotesMutationResponse> {
  try {
    return await withNotesMutation(orgId, userId, () => mutateNotesLocked(orgId, userId, request, nowMs));
  } catch (error) {
    if (error instanceof AtomicNotesMutationRejection) {
      const sync = mutationSync(error.outcome);
      return mutationFailure(request, {
        code: "sync_rejected",
        detail: sync.rejected.map((entry) => entry.reason).join("; "),
        retryable: false,
      }, sync);
    }
    if (error instanceof NotesMutationLimitError) {
      return mutationLimitFailure(request, error.operations);
    }
    throw error;
  }
}

async function mutateNotesLocked(
  orgId: string,
  userId: string,
  request: NotesMutationRequest,
  nowMs: number,
): Promise<NotesMutationResponse> {
  const operation = request.operation;
  if (operation.type === "history.state") {
    return mutationSuccess(request, { history: REMOTE_NOTES_HISTORY_STATE });
  }
  if (operation.type === "history.undo" || operation.type === "history.redo") {
    return mutationFailure(request, {
      code: "unsupported_capability",
      capability: "remote_history",
      detail: REMOTE_NOTES_HISTORY_STATE.detail,
      retryable: false,
    });
  }
  if (operation.type === "attachment.upload-bytes") {
    return mutationFailure(request, {
      code: "unsupported_capability",
      capability: "attachment_bytes",
      detail: "Attachment bytes require the host's upload transport; the JSON Notes mutation endpoint accepts metadata only.",
      retryable: false,
    });
  }

  const marker = mutationMarker(request);
  const fingerprint = mutationFingerprint(request);
  const receipt = await store().getNoteOperationReceipt(orgId, userId, marker);
  if (receipt) {
    if (receipt.fingerprint && receipt.fingerprint !== fingerprint) {
      return mutationFailure(request, {
        code: "idempotency_conflict",
        detail: "This request id was already used for a different Notes mutation.",
        retryable: false,
      });
    }
    if (receipt.response) return receipt.response as unknown as NotesMutationResponse;
    // Receipts written before ADR-038 did not retain a response. Preserve their
    // no-double-apply guarantee while requiring a refresh for the missing value.
    return mutationSuccess(request, {
      replayed: true,
      refreshRequired: true,
      detail: "This request was already applied; refresh the affected block for the merged server value.",
    }, { accepted: [marker], rejected: [], fenced: [] });
  }

  if (!operation.type.startsWith("lease.")) await absorbStoredNoteClocks(orgId, userId);
  const hostedClock = operation.type.startsWith("lease.")
    ? null
    : await store().nextNoteHostClock(
      orgId, userId, request.deviceId, nowMs, MAX_GENERATED_MUTATION_OPERATIONS,
    );
  const response = operation.type.startsWith("lease.")
    ? await applyLeaseMutation(orgId, userId, request)
    : await applyContentMutation(orgId, userId, request, hostedClock!);
  // Successful and deterministic terminal outcomes replay byte-for-byte. A
  // retryable refusal is deliberately not consumed: the condition may clear.
  if (response.ok || !response.error.retryable) {
    await store().recordNoteOperationApplied(
      orgId,
      userId,
      marker,
      operationBlockId(operation) ?? marker,
      fingerprint,
      response as unknown as Record<string, unknown>,
    );
  }
  return response;
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

/* ------------------------------------------------------------- F3: export */

/**
 * How many synced sources one export may look up the owner of.
 *
 * A4 needs one `findNoteBlockInOrg` per mirror pointing outside this corpus, and
 * that is a query per block in the worst case. The bound is generous for a
 * document and small enough that a page built out of mirrors cannot turn one
 * download into a query storm; past it the remaining mirrors get the same answer
 * a mirror of an unknown block gets, which is a sentence rather than a title.
 */
const MAX_EXPORT_VISIBILITY_CHECKS = 64;

export type NoteExportOutcome =
  | { ok: true; file: NoteExport }
  | { ok: false; reason: "not_found" }
  /** F1 — the refusal NAMES what this block can be written as, so a menu can stop offering the rest. */
  | { ok: false; reason: "wrong_format"; formats: NoteExportFormat[] };

/**
 * A4 over an export — who may see the blocks this document mirrors.
 *
 * A synced block whose source is not in this person's own corpus is the one
 * place an export can reach across the `(org_id, user_id)` partition, and the
 * three answers are different sentences: a source they own is rendered, a source
 * somebody else keeps private is *"a block you do not have access to"*, and a
 * source nothing in the org has ever had is *"not on this device"*.
 *
 * **The owner lookup deliberately does not read the block.**
 * `findNoteBlockInOrg` projects the owner and the visibility and excludes
 * `payload_json` for exactly this reason — deciding whether you may see
 * something must not require having read it.
 *
 * A shared source belonging to somebody else reads as absent rather than as its
 * words, because widening the export's read to another partition is the query
 * A4 refuses. That is a smaller document than it could be and never a leak.
 */
async function exportVisibility(
  orgId: string,
  userId: string,
  blocks: readonly NoteBlock[],
  rootId: string,
): Promise<(ref: { mode: string; kind: string; id: string }) => boolean> {
  const mine = new Set(blocks.map((block) => block.id));
  const byId = new Map(blocks.map((block) => [block.id, block] as const));
  const denied = new Set<string>();

  let checked = 0;
  for (const id of subtreeBlockIds(blocks, rootId)) {
    const block = byId.get(id);
    if (!block || !isSyncedBlock(block)) continue;
    const sourceId = syncedSourceId(block);
    if (!sourceId || mine.has(sourceId)) continue;
    if (checked >= MAX_EXPORT_VISIBILITY_CHECKS) break;
    checked += 1;
    const owner = await findBlockOwner(orgId, sourceId);
    if (owner && owner.userId !== userId && owner.visibility === "private") denied.add(sourceId);
  }
  return (ref) => !denied.has(ref.id);
}

/**
 * ADR-029 F3 — one block, as a file, through core's writers.
 *
 * Nothing here formats anything. `exportNote` is the door that decides a page
 * goes to Markdown and a database goes to CSV, and a second decision made on
 * this side would eventually offer CSV for a page — F1's defect, which is an
 * offer the product cannot honour.
 *
 * **The corpus, not the page.** The read is every block this person owns rather
 * than the subtree, because three of the things a document contains live outside
 * it: a table's rows are grandchildren rather than children, a synced block's
 * source is anywhere, and a rollup reads rows of another database entirely. A
 * subtree read would produce a file that is missing exactly the parts a person
 * would check first. It is the same read `rebuildDerived` and `createBlock`
 * already do, and it is paid once per download rather than once per page open.
 *
 * **The output is what is bounded, and the bound is REPORTED.** `truncated` and
 * the omissions travel with the file so the caller can say a prefix is a prefix;
 * Markdown carries the same sentences inside the document, where the person who
 * opens the backup a year from now is the one who needs them.
 */
export async function exportBlock(
  orgId: string,
  userId: string,
  blockId: string,
  format: NoteExportFormat,
  opts: { viewId?: string; maxBlocks?: number; maxChars?: number; nowMs?: number } = {},
): Promise<NoteExportOutcome> {
  // Tombstones included: a mirror of a deleted block has to say WHEN it went
  // (C5), and it can only do that if the tombstone is in the corpus. The walk
  // itself only ever visits live blocks.
  const blocks = await listAllBlocks(orgId, userId);
  const block = blocks.find((candidate) => candidate.id === blockId);
  if (!block || !isLiveBlock(block)) return { ok: false, reason: "not_found" };

  const formats = exportFormatsFor(block);
  if (!formats.includes(format)) return { ok: false, reason: "wrong_format", formats };

  const file = exportNote(blocks, blockId, format, {
    canSee: await exportVisibility(orgId, userId, blocks, blockId),
    nowMs: opts.nowMs ?? Date.now(),
    maxBlocks: Math.min(opts.maxBlocks ?? MAX_EXPORT_BLOCKS, MAX_EXPORT_BLOCKS),
    maxChars: Math.min(opts.maxChars ?? MAX_EXPORT_CHARS, MAX_EXPORT_CHARS),
    ...(opts.viewId ? { viewId: opts.viewId } : {}),
  });
  return file ? { ok: true, file } : { ok: false, reason: "not_found" };
}

/* ----------------------------------------------------------- F3: comments */

export interface NoteCommentThread {
  blockId: string;
  /** Oldest first, tombstoned remarks dropped — core's order, so every surface reads one thread. */
  comments: NoteComment[];
  /** C5 — the block is gone and the remarks are not. Said, rather than 404'd away. */
  blockDeleted: boolean;
  blockDeletedAt?: string;
}

export type CommentWriteOutcome =
  | { ok: true; comment: NoteComment; blockDeleted: boolean; sync: PushOutcome }
  | { ok: false; reason: "no_block" | "no_comment" | "refused"; detail?: string; sync?: PushOutcome };

/**
 * A block's thread, scoped to the partition every other read uses.
 *
 * `(org_id, user_id, id)` and nothing wider, so a comment can never be readable
 * by somebody who could not read the block it is on — the scoping IS the
 * permission check, which is why there is no second one to forget.
 *
 * A tombstoned block still answers (C5): deleting the target of a link never
 * deletes the link, and a 404 here would make a remark somebody wrote
 * unreachable because the line it was about went away.
 */
export async function readCommentThread(
  orgId: string,
  userId: string,
  blockId: string,
): Promise<NoteCommentThread | null> {
  const block = await getBlock(orgId, userId, blockId);
  if (!block) return null;
  return {
    blockId,
    comments: blockComments(block),
    blockDeleted: !isLiveBlock(block),
    ...(block.deletedAt ? { blockDeletedAt: new Date(block.deletedAt.physical).toISOString() } : {}),
  };
}

/**
 * Write one comment — through `pushOperations`, never around it.
 *
 * **This is the same push path a block edit takes**, and that is the whole
 * design rather than a convenience. B3 says notes reuse one sync stack; a
 * comment endpoint that wrote the block row directly would be a second writer
 * with its own idea of merging, and the first thing it would get wrong is the
 * per-key rule — a remark added here would take every remark the server happened
 * to hold, on a record two devices are both editing.
 *
 * Only the CHANGED comment travels in the payload, exactly as the desktop's
 * outbox sends it, so `stampedComments` and `mergeComments` behave identically
 * whichever surface the remark came from.
 *
 * **The lease is not consulted, and it does not have to be.** Core's client-side
 * writer says why: refusing a remark because somebody is editing the line is
 * refusing the one thing you most want to do while they work on it. Going
 * through the push path means the fence still runs — and it applies to `text`
 * alone, which a comment operation never carries, so a held lock costs this
 * nothing.
 */
async function pushComment(
  orgId: string,
  userId: string,
  blockId: string,
  commentId: string,
  change: (existing: NoteComment | undefined, at: Hlc) => NoteComment | null,
  clock: number | Hlc,
  idempotencyKey?: string,
): Promise<CommentWriteOutcome> {
  return withNotesMutation(orgId, userId, async () => {
    const block = await getBlock(orgId, userId, blockId);
    if (!block) return { ok: false, reason: "no_block" };

    if (typeof clock === "number") await absorbStoredNoteClocks(orgId, userId);
    const at = typeof clock === "number"
      ? await store().nextNoteHostClock(orgId, userId, "server", clock, 1)
      : clock;
    const next = change(block.comments?.[commentId], at);
    if (!next) return { ok: false, reason: "no_comment" };

    const outcome = await pushOperationsLocked(orgId, userId, [{
      idempotencyKey: idempotencyKey ?? `${blockId}:comment:${commentId}:${at.physical}.${at.logical}`,
      itemId: blockId,
      kind: "update",
      at,
      payload: { comments: { [commentId]: next } },
    }]);
    const refusal = outcome.rejected[0];
    if (refusal) return { ok: false, reason: "refused", detail: refusal.reason, sync: outcome };

    const after = await getBlock(orgId, userId, blockId);
    return {
      ok: true,
      // The MERGED comment, not the one that was sent: the server decides what the
      // thread now says, and a surface echoing its own write would show a remark
      // that a concurrent resolve had already changed.
      comment: after?.comments?.[commentId] ?? next,
      blockDeleted: !!after && !isLiveBlock(after),
      sync: outcome,
    };
  });
}

/**
 * F3 — a remark on a block, including one that has been deleted.
 *
 * Commenting on a tombstone is allowed on purpose. C5 keeps the link when the
 * target goes, and "why did this go?" is a question people ask about a block
 * precisely after it disappears; `blockEditedAt` excludes comments, so leaving
 * one cannot resurrect what somebody else deleted.
 */
export async function addComment(
  orgId: string,
  userId: string,
  blockId: string,
  input: { body: string; author?: string; id?: string; idempotencyKey?: string },
  clock: number | Hlc,
): Promise<CommentWriteOutcome> {
  const id = input.id ?? newCommentId("server", typeof clock === "number" ? clock : clock.physical);
  return pushComment(orgId, userId, blockId, id, (_existing, at) => ({
    id,
    body: { value: boundCommentBody(input.body), at },
    author: boundCommentAuthor(input.author),
    createdAt: at,
    resolved: { value: false, at },
  }), clock, input.idempotencyKey);
}

/** F3's "resolved and unresolved", as a stamped field that merges like any other. */
export async function setCommentResolved(
  orgId: string,
  userId: string,
  blockId: string,
  commentId: string,
  resolved: boolean,
  clock: number | Hlc,
  idempotencyKey?: string,
): Promise<CommentWriteOutcome> {
  return pushComment(orgId, userId, blockId, commentId, (existing, at) => (
    // A retracted remark is not re-openable: the tombstone is the author taking
    // it back, and answering "no such comment" leads somewhere, where silently
    // resolving a comment nobody can see does not.
    existing && !existing.deletedAt ? { ...existing, resolved: { value: resolved, at } } : null
  ), clock, idempotencyKey);
}

/** Edit a remark's body through the same per-comment merge as add/resolve. */
async function editComment(
  orgId: string,
  userId: string,
  blockId: string,
  commentId: string,
  body: string,
  clock: number | Hlc,
  idempotencyKey?: string,
): Promise<CommentWriteOutcome> {
  return pushComment(orgId, userId, blockId, commentId, (existing, at) => (
    existing && !existing.deletedAt
      ? { ...existing, body: { value: boundCommentBody(body), at } }
      : null
  ), clock, idempotencyKey);
}

/** Retract a remark with a tombstone so a stale edit cannot revive it. */
async function removeComment(
  orgId: string,
  userId: string,
  blockId: string,
  commentId: string,
  clock: number | Hlc,
  idempotencyKey?: string,
): Promise<CommentWriteOutcome> {
  return pushComment(orgId, userId, blockId, commentId, (existing, at) => (
    existing ? { ...existing, deletedAt: at } : null
  ), clock, idempotencyKey);
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
