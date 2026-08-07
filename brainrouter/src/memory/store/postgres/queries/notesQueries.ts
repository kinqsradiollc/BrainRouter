/**
 * Notes persistence (migration 052).
 *
 * ADR-029 D1: keyed by `(org_id, user_id, id)`. A note is personal, so the user
 * is part of the KEY rather than an author column — cross-user reads are
 * impossible by construction rather than by a WHERE clause somebody might
 * forget. The one deliberate exception is `findNoteBlockInOrg`, which exists so
 * A4 can answer "an item you do not have access to" instead of "no longer
 * exists"; it returns the owner and visibility and never the content.
 *
 * The block payload is jsonb because D4 resolves last-writer-wins per FIELD, so
 * each field carries its own HLC stamp and the merge functions in core already
 * speak the object shape.
 *
 * `notes_refs` and `notes_index` are DERIVED (A2). Nothing here writes them from
 * anything but a block's own current text, and `clearNoteDerived` exists so the
 * rebuild-equals-incremental property is testable rather than asserted.
 */
import type { Executor } from "./executor.js";

export interface NoteBlockRow {
  id: string;
  parentId: string | null;
  kind: string;
  visibility: string;
  payload: Record<string, unknown>;
  deletedAtHlc: string | null;
  revision: string;
  updatedAt: string;
}

/** What A4 needs to decide denied-versus-gone, and nothing more. */
export interface NoteBlockOwnerRow {
  id: string;
  userId: string;
  visibility: string;
  deletedAtHlc: string | null;
}

export interface NoteRefRow {
  fromBlockId: string;
  targetKey: string;
  targetMode: string;
  targetKind: string;
  targetId: string;
  fragments: string[];
  citeCount: number;
}

export interface NoteBacklinkRow extends NoteRefRow {
  /** The owner of the referring block, so a shared backlink can be attributed. */
  userId: string;
}

export interface NoteSearchRow {
  blockId: string;
  matchedText: boolean;
  matchedReference: boolean;
  rank: number;
  payload: Record<string, unknown>;
}

export interface NoteBlockLeaseRow {
  blockId: string;
  deviceId: string;
  holder: string | null;
  epoch: number;
  expiresAtMs: number;
}

export interface NoteAttachmentRow {
  contentHash: string;
  byteSize: number;
  mediaType: string;
  storageKey: string;
  createdAt: string;
}

export interface NoteAttachmentUseRow extends NoteAttachmentRow {
  blockId: string;
  fileName: string | null;
}

function toBlockRow(r: Record<string, unknown>): NoteBlockRow {
  return {
    id: String(r.id),
    parentId: r.parent_id == null ? null : String(r.parent_id),
    kind: String(r.kind),
    visibility: String(r.visibility),
    payload: (r.payload_json ?? {}) as Record<string, unknown>,
    deletedAtHlc: r.deleted_at_hlc == null ? null : String(r.deleted_at_hlc),
    revision: String(r.revision),
    updatedAt: new Date(String(r.updated_at)).toISOString(),
  };
}

/**
 * The server's own clock, read from the DATABASE rather than the API process.
 *
 * Lease expiry is decided with this. ADR-027 D12 moved job lease expiry onto the
 * database clock after skew between Node processes translated directly into
 * stolen leases; a block lease granted by one pod and checked by another has the
 * same exposure.
 */
export async function databaseNowMs(exec: Executor): Promise<number> {
  const row = await exec.one<Record<string, unknown>>(
    `SELECT (EXTRACT(EPOCH FROM now()) * 1000)::bigint AS now_ms`,
  );
  return Number(row?.now_ms ?? Date.now());
}

/* -------------------------------------------------------------------- blocks */

/**
 * Changes since a client cursor.
 *
 * The cursor is a revision, not a timestamp: two rows written in the same
 * millisecond are indistinguishable by time, so a client resuming on a timestamp
 * boundary silently skips whichever sorted second.
 */
export async function listNoteBlocksSince(
  exec: Executor,
  orgId: string,
  userId: string,
  since?: string,
): Promise<NoteBlockRow[]> {
  const cursor = since && /^\d+$/.test(since) ? since : "0";
  const rows = await exec.rows<Record<string, unknown>>(
    `SELECT id, parent_id, kind, visibility, payload_json, deleted_at_hlc, revision, updated_at
       FROM notes_blocks
      WHERE org_id = $1 AND user_id = $2 AND revision > $3
      ORDER BY revision ASC
      LIMIT 1000`,
    [orgId, userId, cursor],
  );
  return rows.map(toBlockRow);
}

/** Every block this user owns, tombstones included — the rebuild's only input. */
export async function listAllNoteBlocks(
  exec: Executor,
  orgId: string,
  userId: string,
): Promise<NoteBlockRow[]> {
  const rows = await exec.rows<Record<string, unknown>>(
    `SELECT id, parent_id, kind, visibility, payload_json, deleted_at_hlc, revision, updated_at
       FROM notes_blocks
      WHERE org_id = $1 AND user_id = $2
      ORDER BY revision ASC`,
    [orgId, userId],
  );
  return rows.map(toBlockRow);
}

export async function getNoteBlock(
  exec: Executor,
  orgId: string,
  userId: string,
  id: string,
): Promise<NoteBlockRow | null> {
  const row = await exec.one<Record<string, unknown>>(
    `SELECT id, parent_id, kind, visibility, payload_json, deleted_at_hlc, revision, updated_at
       FROM notes_blocks
      WHERE org_id = $1 AND user_id = $2 AND id = $3`,
    [orgId, userId, id],
  );
  return row ? toBlockRow(row) : null;
}

/**
 * Who owns a block in this org, without reading it.
 *
 * A4: a reference to something you cannot see must render as "an item you do not
 * have access to" rather than as its title (which leaks it) or as nothing (which
 * makes the document look different to different people with no indication why).
 * Deciding that needs the owner and the visibility; it must not need the text,
 * so the projection deliberately excludes `payload_json`.
 */
export async function findNoteBlockInOrg(
  exec: Executor,
  orgId: string,
  id: string,
): Promise<NoteBlockOwnerRow | null> {
  const row = await exec.one<Record<string, unknown>>(
    `SELECT id, user_id, visibility, deleted_at_hlc
       FROM notes_blocks WHERE org_id = $1 AND id = $2 LIMIT 1`,
    [orgId, id],
  );
  return row
    ? {
        id: String(row.id),
        userId: String(row.user_id),
        visibility: String(row.visibility),
        deletedAtHlc: row.deleted_at_hlc == null ? null : String(row.deleted_at_hlc),
      }
    : null;
}

/**
 * Insert or replace a block.
 *
 * `revision` is bumped explicitly from `nextval` on update: without it the row
 * keeps the revision it was created with, and every device except the writer
 * stays stale forever because their `changed-since` pull never sees it.
 */
export async function upsertNoteBlock(
  exec: Executor,
  orgId: string,
  userId: string,
  block: {
    id: string;
    parentId: string | null;
    kind: string;
    visibility?: string;
    payload: Record<string, unknown>;
    deletedAtHlc?: string | null;
  },
): Promise<NoteBlockRow> {
  const row = await exec.one<Record<string, unknown>>(
    `INSERT INTO notes_blocks
       (org_id, user_id, id, parent_id, kind, visibility, payload_json, deleted_at_hlc, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, now())
     ON CONFLICT (org_id, user_id, id) DO UPDATE SET
       parent_id      = EXCLUDED.parent_id,
       kind           = EXCLUDED.kind,
       visibility     = EXCLUDED.visibility,
       payload_json   = EXCLUDED.payload_json,
       deleted_at_hlc = EXCLUDED.deleted_at_hlc,
       revision       = nextval(pg_get_serial_sequence('notes_blocks', 'revision')),
       updated_at     = now()
     RETURNING id, parent_id, kind, visibility, payload_json, deleted_at_hlc, revision, updated_at`,
    [
      orgId, userId, block.id, block.parentId, block.kind,
      block.visibility ?? "private",
      JSON.stringify(block.payload),
      block.deletedAtHlc ?? null,
    ],
  );
  return toBlockRow(row!);
}

/** Widen or narrow who can see a block. D1: sharing changes this, never the row's owner. */
export async function setNoteBlockVisibility(
  exec: Executor,
  orgId: string,
  userId: string,
  id: string,
  visibility: string,
): Promise<number> {
  return exec.run(
    `UPDATE notes_blocks
        SET visibility = $4,
            revision   = nextval(pg_get_serial_sequence('notes_blocks', 'revision')),
            updated_at = now()
      WHERE org_id = $1 AND user_id = $2 AND id = $3`,
    [orgId, userId, id, visibility],
  );
}

export async function latestNoteRevision(
  exec: Executor,
  orgId: string,
  userId: string,
): Promise<string> {
  const row = await exec.one<Record<string, unknown>>(
    `SELECT COALESCE(MAX(revision), 0) AS cursor
       FROM notes_blocks WHERE org_id = $1 AND user_id = $2`,
    [orgId, userId],
  );
  return String(row?.cursor ?? "0");
}

/* --------------------------------------------------------------- idempotency */

export async function wasNoteOperationApplied(
  exec: Executor,
  orgId: string,
  userId: string,
  key: string,
): Promise<boolean> {
  const row = await exec.one<Record<string, unknown>>(
    `SELECT 1 AS present FROM notes_applied_operations
      WHERE org_id = $1 AND user_id = $2 AND idempotency_key = $3`,
    [orgId, userId, key],
  );
  return row !== null;
}

export async function recordNoteOperationApplied(
  exec: Executor,
  orgId: string,
  userId: string,
  key: string,
  blockId: string,
): Promise<void> {
  await exec.run(
    `INSERT INTO notes_applied_operations (org_id, user_id, idempotency_key, block_id)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (org_id, user_id, idempotency_key) DO NOTHING`,
    [orgId, userId, key, blockId],
  );
}

/* ---------------------------------------------------------- derived: refs */

/**
 * Replace one block's reference edges.
 *
 * Retract-then-add inside one transaction, never add-only: a reference REMOVED
 * from a block has to disappear from the target's backlinks, and an index that
 * only ever grows is how "what links here" starts listing notes that stopped
 * mentioning you.
 */
export async function replaceNoteRefs(
  exec: Executor,
  orgId: string,
  userId: string,
  blockId: string,
  refs: readonly Omit<NoteRefRow, "fromBlockId">[],
): Promise<void> {
  await exec.tx(async (client) => {
    await client.query(
      `DELETE FROM notes_refs WHERE org_id = $1 AND user_id = $2 AND from_block_id = $3`,
      [orgId, userId, blockId],
    );
    for (const ref of refs) {
      await client.query(
        `INSERT INTO notes_refs
           (org_id, user_id, from_block_id, target_key, target_mode, target_kind, target_id,
            fragments, cite_count, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, now())
         ON CONFLICT (org_id, user_id, from_block_id, target_key) DO UPDATE SET
           fragments = EXCLUDED.fragments, cite_count = EXCLUDED.cite_count, updated_at = now()`,
        [
          orgId, userId, blockId, ref.targetKey, ref.targetMode, ref.targetKind,
          ref.targetId, ref.fragments, ref.citeCount,
        ],
      );
    }
  });
}

export async function listNoteRefsFrom(
  exec: Executor,
  orgId: string,
  userId: string,
  blockId: string,
): Promise<NoteRefRow[]> {
  const rows = await exec.rows<Record<string, unknown>>(
    `SELECT from_block_id, target_key, target_mode, target_kind, target_id, fragments, cite_count
       FROM notes_refs
      WHERE org_id = $1 AND user_id = $2 AND from_block_id = $3
      ORDER BY target_key ASC`,
    [orgId, userId, blockId],
  );
  return rows.map(toRefRow);
}

function toRefRow(r: Record<string, unknown>): NoteRefRow {
  return {
    fromBlockId: String(r.from_block_id),
    targetKey: String(r.target_key),
    targetMode: String(r.target_mode),
    targetKind: String(r.target_kind),
    targetId: String(r.target_id),
    fragments: Array.isArray(r.fragments) ? r.fragments.map(String) : [],
    citeCount: Number(r.cite_count ?? 1),
  };
}

/**
 * What links here — over the corpus the viewer may actually see.
 *
 * The viewer's own blocks, plus blocks shared into the org. Computing backlinks
 * over a wider corpus would answer the question with the existence of notes the
 * asker cannot open, which is A4's leak by aggregation: no title is disclosed,
 * but the count is.
 */
export async function listNoteBacklinks(
  exec: Executor,
  orgId: string,
  viewerUserId: string,
  targetKey: string,
  limit = 200,
): Promise<NoteBacklinkRow[]> {
  const rows = await exec.rows<Record<string, unknown>>(
    `SELECT r.from_block_id, r.user_id, r.target_key, r.target_mode, r.target_kind,
            r.target_id, r.fragments, r.cite_count
       FROM notes_refs r
       JOIN notes_blocks b
         ON b.org_id = r.org_id AND b.user_id = r.user_id AND b.id = r.from_block_id
      WHERE r.org_id = $1
        AND r.target_key = $2
        AND b.deleted_at_hlc IS NULL
        AND (r.user_id = $3 OR b.visibility <> 'private')
      ORDER BY r.from_block_id ASC
      LIMIT $4`,
    [orgId, targetKey, viewerUserId, limit],
  );
  return rows.map((r) => ({ ...toRefRow(r), userId: String(r.user_id) }));
}

/* ---------------------------------------------------------- derived: index */

export async function upsertNoteIndex(
  exec: Executor,
  orgId: string,
  userId: string,
  blockId: string,
  entry: { contentText: string; refKeys: readonly string[] },
): Promise<void> {
  await exec.run(
    `INSERT INTO notes_index (org_id, user_id, block_id, content_text, ref_keys, rebuilt_at)
     VALUES ($1, $2, $3, $4, $5, now())
     ON CONFLICT (org_id, user_id, block_id) DO UPDATE SET
       content_text = EXCLUDED.content_text,
       ref_keys     = EXCLUDED.ref_keys,
       rebuilt_at   = now()`,
    [orgId, userId, blockId, entry.contentText, entry.refKeys],
  );
}

export async function deleteNoteIndexEntry(
  exec: Executor,
  orgId: string,
  userId: string,
  blockId: string,
): Promise<void> {
  await exec.run(
    `DELETE FROM notes_index WHERE org_id = $1 AND user_id = $2 AND block_id = $3`,
    [orgId, userId, blockId],
  );
}

/**
 * Drop every derived row for one person's notes.
 *
 * A2 requires the derived tables to be rebuildable from content alone; that is
 * only testable if there is a way to throw them away. This is it.
 */
export async function clearNoteDerived(
  exec: Executor,
  orgId: string,
  userId: string,
): Promise<void> {
  await exec.tx(async (client) => {
    await client.query(`DELETE FROM notes_refs WHERE org_id = $1 AND user_id = $2`, [orgId, userId]);
    await client.query(`DELETE FROM notes_index WHERE org_id = $1 AND user_id = $2`, [orgId, userId]);
  });
}

/** Every index row, for comparing a rebuild against what incremental writes produced. */
export async function listNoteIndexEntries(
  exec: Executor,
  orgId: string,
  userId: string,
): Promise<Array<{ blockId: string; contentText: string; refKeys: string[] }>> {
  const rows = await exec.rows<Record<string, unknown>>(
    `SELECT block_id, content_text, ref_keys FROM notes_index
      WHERE org_id = $1 AND user_id = $2 ORDER BY block_id ASC`,
    [orgId, userId],
  );
  return rows.map((r) => ({
    blockId: String(r.block_id),
    contentText: String(r.content_text),
    refKeys: Array.isArray(r.ref_keys) ? r.ref_keys.map(String) : [],
  }));
}

/**
 * B5 — one query over both halves, reporting which half matched.
 *
 * A result that matched only a link is a different answer from one that matched
 * a sentence, so the two predicates are evaluated separately and both flags come
 * back. Collapsing them is how a search stops being trusted: every block holding
 * any planner link would become a hit for the word "planner".
 */
export async function searchNoteIndex(
  exec: Executor,
  orgId: string,
  userId: string,
  query: string,
  limit = 50,
): Promise<NoteSearchRow[]> {
  const rows = await exec.rows<Record<string, unknown>>(
    `WITH q AS (SELECT websearch_to_tsquery('english'::regconfig, $3) AS tsq)
     SELECT i.block_id,
            (i.search_vector @@ q.tsq) AS matched_text,
            EXISTS (SELECT 1 FROM unnest(i.ref_keys) k WHERE k ILIKE $4) AS matched_reference,
            ts_rank(i.search_vector, q.tsq) AS rank,
            b.payload_json
       FROM notes_index i
       CROSS JOIN q
       JOIN notes_blocks b
         ON b.org_id = i.org_id AND b.user_id = i.user_id AND b.id = i.block_id
      WHERE i.org_id = $1 AND i.user_id = $2
        AND b.deleted_at_hlc IS NULL
        AND ((i.search_vector @@ q.tsq)
             OR EXISTS (SELECT 1 FROM unnest(i.ref_keys) k WHERE k ILIKE $4))
      ORDER BY rank DESC, i.block_id ASC
      LIMIT $5`,
    [orgId, userId, query, `%${query}%`, limit],
  );
  return rows.map((r) => ({
    blockId: String(r.block_id),
    matchedText: r.matched_text === true,
    matchedReference: r.matched_reference === true,
    rank: Number(r.rank ?? 0),
    payload: (r.payload_json ?? {}) as Record<string, unknown>,
  }));
}

/* -------------------------------------------------------------------- leases */

/**
 * The lease and the DATABASE's clock, in one round trip.
 *
 * Both are needed together: liveness is `expires_at > now()` and the `now()` has
 * to be the database's, not the caller's. Reading them separately would leave a
 * window in which the two disagree — which is precisely the skew ADR-027 D12
 * removed from job leases.
 *
 * The `LEFT JOIN` against a one-row source means the query answers even when
 * there is no lease, so "no lock" and "could not read the clock" stay distinct.
 */
export async function readNoteBlockLease(
  exec: Executor,
  orgId: string,
  userId: string,
  blockId: string,
): Promise<{ lease: NoteBlockLeaseRow | null; dbNowMs: number }> {
  const row = await exec.one<Record<string, unknown>>(
    `SELECT l.block_id, l.device_id, l.holder, l.epoch,
            (EXTRACT(EPOCH FROM l.expires_at) * 1000)::bigint AS expires_at_ms,
            (EXTRACT(EPOCH FROM now()) * 1000)::bigint AS now_ms
       FROM (SELECT 1) AS anchor
       LEFT JOIN notes_block_leases l
         ON l.org_id = $1 AND l.user_id = $2 AND l.block_id = $3`,
    [orgId, userId, blockId],
  );
  const dbNowMs = Number(row?.now_ms ?? Date.now());
  if (!row || row.device_id == null) return { lease: null, dbNowMs };
  return {
    lease: {
      blockId: String(row.block_id),
      deviceId: String(row.device_id),
      holder: row.holder == null ? null : String(row.holder),
      epoch: Number(row.epoch ?? 0),
      expiresAtMs: Number(row.expires_at_ms ?? 0),
    },
    dbNowMs,
  };
}

export async function upsertNoteBlockLease(
  exec: Executor,
  orgId: string,
  userId: string,
  lease: NoteBlockLeaseRow,
): Promise<void> {
  await exec.run(
    `INSERT INTO notes_block_leases
       (org_id, user_id, block_id, device_id, holder, epoch, expires_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, to_timestamp($7::bigint / 1000.0), now())
     ON CONFLICT (org_id, user_id, block_id) DO UPDATE SET
       device_id  = EXCLUDED.device_id,
       holder     = EXCLUDED.holder,
       epoch      = EXCLUDED.epoch,
       expires_at = EXCLUDED.expires_at,
       updated_at = now()`,
    [orgId, userId, lease.blockId, lease.deviceId, lease.holder, lease.epoch, lease.expiresAtMs],
  );
}

/**
 * Forget leases old enough that nothing can still contradict them.
 *
 * The epoch has to outlive the lease — dropping a record on expiry resets the
 * count and the next acquisition mints epoch 1 again, matching the epoch a
 * sleeping device is still carrying. The safe bound is the outbox's: an
 * operation older than the queue keeps has already been shed and can never be
 * flushed, so no write carrying that epoch exists any more.
 */
export async function sweepNoteBlockLeases(
  exec: Executor,
  orgId: string,
  maxAgeMs: number,
): Promise<number> {
  return exec.run(
    `DELETE FROM notes_block_leases
      WHERE org_id = $1
        AND expires_at < now() - make_interval(secs => $2::double precision)`,
    [orgId, Math.max(0, Math.floor(maxAgeMs / 1000))],
  );
}

/* --------------------------------------------------------------- attachments */

/**
 * D3 — register the object. The hash IS the identity, so a second paste of the
 * same bytes collides and becomes a no-op rather than a second object.
 *
 * Writes unconditionally instead of checking first: a "does this hash exist"
 * read would be an existence oracle over content, which is how a "did you upload
 * THIS file" probe works.
 */
export async function registerNoteAttachment(
  exec: Executor,
  orgId: string,
  object: { contentHash: string; byteSize: number; mediaType: string; storageKey: string },
): Promise<NoteAttachmentRow> {
  const row = await exec.one<Record<string, unknown>>(
    `INSERT INTO notes_attachments (org_id, content_hash, byte_size, media_type, storage_key)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (org_id, content_hash) DO UPDATE SET media_type = notes_attachments.media_type
     RETURNING content_hash, byte_size, media_type, storage_key, created_at`,
    [orgId, object.contentHash, object.byteSize, object.mediaType, object.storageKey],
  );
  return toAttachmentRow(row!);
}

function toAttachmentRow(r: Record<string, unknown>): NoteAttachmentRow {
  return {
    contentHash: String(r.content_hash),
    byteSize: Number(r.byte_size),
    mediaType: String(r.media_type),
    storageKey: String(r.storage_key),
    createdAt: new Date(String(r.created_at)).toISOString(),
  };
}

export async function linkNoteAttachment(
  exec: Executor,
  orgId: string,
  userId: string,
  link: { blockId: string; contentHash: string; fileName?: string | null },
): Promise<void> {
  await exec.run(
    `INSERT INTO notes_attachment_refs (org_id, user_id, block_id, content_hash, file_name)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (org_id, user_id, block_id, content_hash) DO UPDATE SET file_name = EXCLUDED.file_name`,
    [orgId, userId, link.blockId, link.contentHash, link.fileName ?? null],
  );
}

export async function unlinkNoteAttachment(
  exec: Executor,
  orgId: string,
  userId: string,
  blockId: string,
  contentHash: string,
): Promise<number> {
  return exec.run(
    `DELETE FROM notes_attachment_refs
      WHERE org_id = $1 AND user_id = $2 AND block_id = $3 AND content_hash = $4`,
    [orgId, userId, blockId, contentHash],
  );
}

export async function listNoteAttachments(
  exec: Executor,
  orgId: string,
  userId: string,
  blockId: string,
): Promise<NoteAttachmentUseRow[]> {
  const rows = await exec.rows<Record<string, unknown>>(
    `SELECT r.block_id, r.file_name, a.content_hash, a.byte_size, a.media_type, a.storage_key, a.created_at
       FROM notes_attachment_refs r
       JOIN notes_attachments a ON a.org_id = r.org_id AND a.content_hash = r.content_hash
      WHERE r.org_id = $1 AND r.user_id = $2 AND r.block_id = $3
      ORDER BY a.content_hash ASC`,
    [orgId, userId, blockId],
  );
  return rows.map((r) => ({
    ...toAttachmentRow(r),
    blockId: String(r.block_id),
    fileName: r.file_name == null ? null : String(r.file_name),
  }));
}

/**
 * How many blocks point at one object, counted from the reference rows.
 *
 * Not a column on the object: a stored refcount is a second source of truth that
 * drifts, and it drifts toward deleting bytes someone is still looking at.
 */
export async function countNoteAttachmentUses(
  exec: Executor,
  orgId: string,
  contentHash: string,
): Promise<number> {
  const row = await exec.one<Record<string, unknown>>(
    `SELECT count(*)::int AS uses FROM notes_attachment_refs
      WHERE org_id = $1 AND content_hash = $2`,
    [orgId, contentHash],
  );
  return Number(row?.uses ?? 0);
}

/** Objects nothing references any more — the input to a byte-level sweep. */
export async function listUnreferencedNoteAttachments(
  exec: Executor,
  orgId: string,
  olderThanMs: number,
  limit = 500,
): Promise<NoteAttachmentRow[]> {
  const rows = await exec.rows<Record<string, unknown>>(
    `SELECT a.content_hash, a.byte_size, a.media_type, a.storage_key, a.created_at
       FROM notes_attachments a
      WHERE a.org_id = $1
        AND a.created_at < now() - make_interval(secs => $2::double precision)
        AND NOT EXISTS (
          SELECT 1 FROM notes_attachment_refs r
           WHERE r.org_id = a.org_id AND r.content_hash = a.content_hash)
      ORDER BY a.created_at ASC
      LIMIT $3`,
    [orgId, Math.max(0, Math.floor(olderThanMs / 1000)), limit],
  );
  return rows.map(toAttachmentRow);
}
