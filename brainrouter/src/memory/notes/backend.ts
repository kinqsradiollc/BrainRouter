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
import { randomUUID } from "node:crypto";
import { memoryEngine } from "../engine.js";
import {
  acquireBlockLease, blockComments, blockReferences, blockReferenceText, boundCommentAuthor,
  boundCommentBody, contentWithoutRefs, DATABASE_BLOCK_KIND,
  datePropertyDay, exportFormatsFor, exportNote, fenceBlockWrite,
  FIRST_RANK, isLiveBlock, isSyncedBlock, MAX_COMMENT_LENGTH, MAX_EXPORT_BLOCKS, MAX_EXPORT_CHARS,
  MAX_HEADING_LEVEL, mergeNoteBlock, newCommentId, NOTE_BLOCK_KINDS,
  projectDatabase, rankBetween, readDatabase, releaseBlockLease,
  renewBlockLease, resolveBlockConflict, subtreeBlockIds, syncedSourceId, validateDatabaseFields,
  BLOCK_LEASE_MS,
  type BlockFence, type BlockLease, type BlockWritePath, type DatabaseProjection, type Hlc,
  type LeaseClaim, type LeaseOutcome, type NoteComment, type NoteDatabase, type NoteDatabaseView,
  type NoteBlock, type NoteBlockKind, type NoteExport, type NoteExportFormat,
  type NotePropertyDef, type NotePropertyValue, type Stamped,
} from "@kinqs/brainrouter-core/notes";
import {
  extractWorkspaceRefs, parseWorkspaceRef, workspaceRefKey,
} from "@kinqs/brainrouter-core/workspace/references";
import type {
  NoteAttachmentRow, NoteAttachmentUseRow, NoteBacklinkRow, NoteBlockLeaseRow,
  NoteBlockOwnerRow, NoteBlockRow, NotePageMetaRow, NoteRefRow, NoteRowValueInput,
  NoteSearchRow,
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
  wasNoteOperationApplied(orgId: string, userId: string, key: string): Promise<boolean>;
  recordNoteOperationApplied(orgId: string, userId: string, key: string, blockId: string): Promise<void>;
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
  const next: NonNullable<NoteBlock["props"]> = { ...(existing ?? {}) };
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
  const next: NonNullable<NoteBlock["comments"]> = { ...(existing ?? {}) };
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
    for (const [, raw] of entries) {
      const body = (raw as { body?: { value?: unknown } } | null)?.body?.value;
      if (typeof body === "string" && body.length > MAX_COMMENT_LENGTH) {
        return `A comment holds at most ${MAX_COMMENT_LENGTH} characters; this one had ${body.length}.`;
      }
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
  | { ok: true; comment: NoteComment; blockDeleted: boolean }
  | { ok: false; reason: "no_block" | "no_comment" | "refused"; detail?: string };

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
  nowMs: number,
): Promise<CommentWriteOutcome> {
  const block = await getBlock(orgId, userId, blockId);
  if (!block) return { ok: false, reason: "no_block" };

  const at = serverClock(nowMs);
  const next = change(block.comments?.[commentId], at);
  if (!next) return { ok: false, reason: "no_comment" };

  const outcome = await pushOperations(orgId, userId, [{
    idempotencyKey: `${blockId}:comment:${commentId}:${at.physical}.${at.logical}`,
    itemId: blockId,
    kind: "update",
    at,
    payload: { comments: { [commentId]: next } },
  }]);
  const refusal = outcome.rejected[0];
  if (refusal) return { ok: false, reason: "refused", detail: refusal.reason };

  const after = await getBlock(orgId, userId, blockId);
  return {
    ok: true,
    // The MERGED comment, not the one that was sent: the server decides what the
    // thread now says, and a surface echoing its own write would show a remark
    // that a concurrent resolve had already changed.
    comment: after?.comments?.[commentId] ?? next,
    blockDeleted: !!after && !isLiveBlock(after),
  };
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
  input: { body: string; author?: string },
  nowMs: number,
): Promise<CommentWriteOutcome> {
  const id = newCommentId("server", nowMs);
  return pushComment(orgId, userId, blockId, id, (_existing, at) => ({
    id,
    body: { value: boundCommentBody(input.body), at },
    author: boundCommentAuthor(input.author),
    createdAt: at,
    resolved: { value: false, at },
  }), nowMs);
}

/** F3's "resolved and unresolved", as a stamped field that merges like any other. */
export async function setCommentResolved(
  orgId: string,
  userId: string,
  blockId: string,
  commentId: string,
  resolved: boolean,
  nowMs: number,
): Promise<CommentWriteOutcome> {
  return pushComment(orgId, userId, blockId, commentId, (existing, at) => (
    // A retracted remark is not re-openable: the tombstone is the author taking
    // it back, and answering "no such comment" leads somewhere, where silently
    // resolving a comment nobody can see does not.
    existing && !existing.deletedAt ? { ...existing, resolved: { value: resolved, at } } : null
  ), nowMs);
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
