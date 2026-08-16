-- ADR-029 Part D — the Notes durable store.
--
-- D1: scoped (org_id, user_id, id) with a visibility column, matching the
-- planner and meetings. A note is PERSONAL and cross-project; ADR-028 D9
-- recorded getting exactly this wrong once by scoping the planner per
-- repository, which made the same record invisible from a second checkout of
-- the same work. Sharing widens `visibility`; it never moves the row.
--
-- D2 names three tables and the relationship between them, which is the part
-- that has to be enforced rather than intended:
--
--   notes_blocks  — the content. The only source of truth.
--   notes_refs    — the references found IN that content (A2).
--   notes_index   — the derived search/backlink projection.
--
-- A2's rule is that the reference lives in the referring content and backlinks
-- are computed, so BOTH derived tables are caches: dropping them and rebuilding
-- from notes_blocks alone must produce the same answer. If it does not, the
-- cache was the source of truth and A2 was not implemented.
--
-- Block payloads are jsonb for the same reason planner items are (051): D4
-- resolves last-writer-wins PER FIELD, so every mutable field carries its own
-- HLC stamp, and modelling a stamp column beside every value column would be
-- worse in every way than storing the shape the merge functions already speak.
--
-- Deletion is a tombstone, never a DELETE (C5). A later edit arriving from a
-- device that was offline must be able to resurrect the block as conflicted;
-- removing the row would make that edit look like a creation and the deletion
-- would silently un-happen. It is also what keeps a reference to a deleted
-- block renderable as "(deleted 4 Aug)" instead of as a hole in the document.

CREATE TABLE IF NOT EXISTS notes_blocks (
  org_id        text        NOT NULL,
  user_id       text        NOT NULL,
  id            text        NOT NULL,

  -- B4: a page is a block that has children, so nesting is one recursion over
  -- this column and there is no page table to keep in step with this one.
  -- Denormalised out of the payload because the sidebar tree reads it on every
  -- open, and jsonb extraction per row is the wrong shape for that query.
  parent_id     text,
  kind          text        NOT NULL,

  -- D1. 'private' is the default because a personal note that arrives shared by
  -- omission is a leak nobody chose.
  visibility    text        NOT NULL DEFAULT 'private',

  -- The full stamped block: parentId/rank/kind/text/level/checked, each with its
  -- own HLC, plus any unresolved conflicts.
  payload_json  jsonb       NOT NULL,

  -- The tombstone's stamp, flattened so "is this live" is an index predicate.
  deleted_at_hlc text,

  -- Server-side ordering for `changed-since` pulls (D11). Distinct from the
  -- HLC: this is OUR clock, monotonic per row-write, and it is what a client
  -- cursor points at. A timestamp cursor would silently skip whichever of two
  -- rows written in the same millisecond sorted second.
  revision      bigserial   NOT NULL,

  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),

  PRIMARY KEY (org_id, user_id, id),
  CONSTRAINT notes_blocks_visibility_check CHECK (visibility IN ('private', 'team', 'org'))
);

-- The pull query: everything for this user changed after the client's cursor.
CREATE INDEX IF NOT EXISTS notes_blocks_changed_idx
  ON notes_blocks (org_id, user_id, revision);

-- The sidebar tree, which is read on every notes open.
CREATE INDEX IF NOT EXISTS notes_blocks_tree_idx
  ON notes_blocks (org_id, user_id, parent_id)
  WHERE deleted_at_hlc IS NULL;

-- A4's resolve path for a block owned by someone else in the same org: the
-- lookup has to be by (org_id, id) so the answer can be "denied" rather than
-- "no longer exists", and without this index that lookup is a full scan.
CREATE INDEX IF NOT EXISTS notes_blocks_org_lookup_idx
  ON notes_blocks (org_id, id);

-- A2 — the references a block currently makes. DERIVED from the block's text
-- and rewritten whenever that text changes; never written by a second writer,
-- because a link stored on both ends is how one migration later the surviving
-- half becomes a lie.
--
-- The row is keyed by the FRAGMENT-INSENSITIVE target key: a note citing
-- `parser.ts#L59` and one citing `#L12` both link to the same file, and
-- splitting them by line number answers a question nobody asked. The specific
-- positions ride along in `fragments` so nothing is lost by not keying on them.
CREATE TABLE IF NOT EXISTS notes_refs (
  org_id        text        NOT NULL,
  user_id       text        NOT NULL,
  from_block_id text        NOT NULL,
  target_key    text        NOT NULL,

  -- Split out so "everything this note links to in Track" is an index scan
  -- rather than a LIKE over a URI.
  target_mode   text        NOT NULL,
  target_kind   text        NOT NULL,
  target_id     text        NOT NULL,

  fragments     text[]      NOT NULL DEFAULT '{}',
  -- How many times this block cites this target. A count, not a list of
  -- offsets: the offsets move with every keystroke and nothing reads them.
  cite_count    integer     NOT NULL DEFAULT 1,
  updated_at    timestamptz NOT NULL DEFAULT now(),

  PRIMARY KEY (org_id, user_id, from_block_id, target_key),
  -- Blocks are tombstoned rather than deleted, so this cascade almost never
  -- fires. It exists for the path that DOES remove rows — a retention sweep —
  -- because a derived row outliving its content is a backlink to a block that
  -- is not there.
  FOREIGN KEY (org_id, user_id, from_block_id)
    REFERENCES notes_blocks (org_id, user_id, id) ON DELETE CASCADE
);

-- "What links here", the query A2 replaces the stored back-edge with. Keyed by
-- org rather than by user so a shared note's backlinks are reachable; the
-- visibility filter lives in the query, which joins notes_blocks.
CREATE INDEX IF NOT EXISTS notes_refs_target_idx
  ON notes_refs (org_id, target_key);

-- B5 — search covers content AND references, and says which half it matched.
--
-- `content_text` is the prose with the URIs REMOVED. Searching the raw text
-- technically finds `BR-114` because the URI contains it, and it also makes
-- every block holding any planner link a hit for "planner" — reporting a block
-- whose only connection to the query is a machine-generated identifier as
-- though a person had written the word.
--
-- The vector is a GENERATED column so the index cannot drift from the text it
-- indexes: there is no code path that can update one without the other. The
-- regconfig is spelled explicitly because `to_tsvector(text)` depends on a
-- session setting and is therefore not immutable enough to generate from.
CREATE TABLE IF NOT EXISTS notes_index (
  org_id       text        NOT NULL,
  user_id      text        NOT NULL,
  block_id     text        NOT NULL,

  content_text text        NOT NULL,
  ref_keys     text[]      NOT NULL DEFAULT '{}',
  search_vector tsvector
    GENERATED ALWAYS AS (to_tsvector('english'::regconfig, content_text)) STORED,

  rebuilt_at   timestamptz NOT NULL DEFAULT now(),

  PRIMARY KEY (org_id, user_id, block_id),
  FOREIGN KEY (org_id, user_id, block_id)
    REFERENCES notes_blocks (org_id, user_id, id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS notes_index_search_idx
  ON notes_index USING gin (search_vector);

CREATE INDEX IF NOT EXISTS notes_index_refs_idx
  ON notes_index USING gin (ref_keys);

-- B2 / Q1 — a block lock is a LEASE WITH A FENCING EPOCH, not a flag.
--
-- It lives on the SERVER because that is the only place two devices can see the
-- same lock; a lease held in a local file coordinates nothing. It lives BESIDE
-- the block rather than on it because a lease is coordination, not content:
-- merged by last-writer-wins it would hand the lock to whichever device has the
-- faster clock regardless of who was refused it, which is the failure it exists
-- to prevent, inverted.
--
-- The epoch is what makes reclaiming an expired lease safe. Migration 048 was
-- written after the un-fenced version of this went wrong one layer down — a
-- worker held a lease, a sweeper released it, a second worker claimed the job,
-- and the first wrote its stale result over the new run. Its comment states the
-- rule this table implements for blocks: a lease without a fencing token is not
-- a lock.
--
-- Expiry is compared against the DATABASE clock, never a caller's. `expires_at`
-- is written by whichever API process granted the lease, and ADR-027 D12 moved
-- job lease expiry onto the database clock precisely because clock skew between
-- Node processes translated directly into stolen leases.
CREATE TABLE IF NOT EXISTS notes_block_leases (
  org_id     text        NOT NULL,
  user_id    text        NOT NULL,
  block_id   text        NOT NULL,

  device_id  text        NOT NULL,
  -- The attribution line B2 requires ("Being edited on …"). Optional: a generic
  -- phrase is better than refusing the lease for want of a nickname.
  holder     text,

  -- Bumped by every ACQUISITION and by nothing else — not by a renewal, which
  -- would fence the holder's own queued writes, and not by a release, because
  -- an edit already authored under this epoch is legitimate and must still land.
  epoch      bigint      NOT NULL DEFAULT 0,
  expires_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),

  PRIMARY KEY (org_id, user_id, block_id)
);

-- The sweep that keeps expired records from accumulating. Records outlive their
-- term on purpose: dropping one on expiry resets the count, and the next
-- acquisition would mint epoch 1 again — matching the epoch a sleeping device
-- is still carrying. A fencing token that can be reset is not a fencing token.
CREATE INDEX IF NOT EXISTS notes_block_leases_expiry_idx
  ON notes_block_leases (org_id, expires_at);

-- Applied operation keys, so a redelivered push is a no-op rather than a
-- double-apply (ADR-027 D12). Tenant-scoped: migration 049 fixed exactly this
-- shape being cross-tenant, where one org's key suppressed another's operation.
CREATE TABLE IF NOT EXISTS notes_applied_operations (
  org_id          text        NOT NULL,
  user_id         text        NOT NULL,
  idempotency_key text        NOT NULL,
  block_id        text        NOT NULL,
  applied_at      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (org_id, user_id, idempotency_key)
);

-- D3 — attachments are content-addressed and stored ONCE.
--
-- An image pasted into three notes is one object with three references;
-- otherwise a workspace's storage grows with how often people paste rather than
-- with what they have. The identity IS the hash, so there is nothing to
-- de-duplicate later: the second paste of the same bytes collides on the
-- primary key and becomes another reference.
--
-- The object is org-scoped rather than user-scoped so the sharing case
-- de-duplicates too. That is not an access path: `notes_attachment_refs` is
-- user-scoped, so knowing an object exists requires already holding a block
-- that references it, and the register call writes unconditionally rather than
-- answering "does this hash exist" — an existence oracle over content hashes is
-- exactly how a "did you upload THIS file" probe would work.
CREATE TABLE IF NOT EXISTS notes_attachments (
  org_id       text        NOT NULL,
  content_hash text        NOT NULL,
  byte_size    bigint      NOT NULL,
  media_type   text        NOT NULL,
  -- Where the bytes live. The row is the registry; it is deliberately not the
  -- blob, so object storage can move without a schema change.
  storage_key  text        NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),

  PRIMARY KEY (org_id, content_hash),
  CONSTRAINT notes_attachments_hash_check CHECK (content_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT notes_attachments_size_check CHECK (byte_size >= 0)
);

-- The three references to the one object. Usage is counted from these rows
-- rather than kept as a column on the object: a stored refcount is a second
-- source of truth that drifts, and it drifts toward deleting bytes someone is
-- still looking at.
CREATE TABLE IF NOT EXISTS notes_attachment_refs (
  org_id       text        NOT NULL,
  user_id      text        NOT NULL,
  block_id     text        NOT NULL,
  content_hash text        NOT NULL,
  -- The name at THIS use site. The same bytes are legitimately "logo.png" in
  -- one note and "screenshot-3.png" in another, and the object cannot hold both.
  file_name    text,
  created_at   timestamptz NOT NULL DEFAULT now(),

  PRIMARY KEY (org_id, user_id, block_id, content_hash),
  FOREIGN KEY (org_id, user_id, block_id)
    REFERENCES notes_blocks (org_id, user_id, id) ON DELETE CASCADE,
  -- RESTRICT, not CASCADE: an object may not be removed while a block still
  -- points at it. C5's rule for links applies to bytes as well — deleting the
  -- target of a reference must never happen behind the reference's back.
  FOREIGN KEY (org_id, content_hash)
    REFERENCES notes_attachments (org_id, content_hash) ON DELETE RESTRICT
);

CREATE INDEX IF NOT EXISTS notes_attachment_refs_object_idx
  ON notes_attachment_refs (org_id, content_hash);
