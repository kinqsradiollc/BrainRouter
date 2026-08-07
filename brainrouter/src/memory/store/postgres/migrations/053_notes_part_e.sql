-- ADR-029 Part E — the projections Part E's surfaces read.
--
-- 052 already stores every field this migration is about. A block's icon, its
-- cover, its title, a database's property definitions, its stored views and a
-- row's property values all live inside `notes_blocks.payload_json`, because D4
-- merges per FIELD and the merge functions speak the stamped object shape. That
-- was the right call and this migration does not revisit it.
--
-- What 052 does NOT give Part E is a way to ASK anything about them. Every
-- question the new surfaces need — "what pages do I have", "what are this
-- database's columns", "which rows have status = blocked, sorted by due date" —
-- is today a full read of one person's entire corpus followed by a JSON walk in
-- Node. That is survivable on a desktop holding its own cache and wrong for the
-- dashboard, which Q5 says must resolve server-side and has no local store to
-- resolve against. A page list that costs the whole corpus is a page list nobody
-- puts in a sidebar.
--
-- So both tables here are DERIVED, in exactly the sense `notes_index` is (A2):
--
--   * they are written only by the one function that re-derives a block after it
--     is persisted, never by a second writer and never by a client push;
--   * `clearNoteDerived` drops them and `rebuildDerived` recomputes them from
--     `notes_blocks` alone;
--   * if a rebuild ever changes an answer, the cache had become the source of
--     truth and A2 was not implemented.
--
-- That status is the whole reason this is not "one table per Part E noun". A
-- `notes_properties` table that a client could write would be a second store for
-- a database's schema, and E3's entire argument is that a database must not
-- become a second store — a row IS a page, so sync, merge, references and
-- permissions apply to it for free. A schema stored twice would need a rule for
-- which copy wins, and the first concurrent edit would find out that nobody
-- wrote one.
--
-- Tenancy is unchanged: `(org_id, user_id, …)`, matching 052 and D1. No new
-- shape, because a second shape is how a scoping bug gets written twice.

-- Document order, as a column.
--
-- 052 denormalised `parent_id` out of the payload because the tree is read on
-- every open; the sibling ORDER was left inside, and that is the half that makes
-- "the blocks of this page, in the order they appear" impossible to ask for. A
-- page read could only fetch children in write order and re-sort them in Node,
-- which is wrong the moment it is also bounded: the first 200 rows by revision
-- are not the first 200 rows of the document.
--
-- The payload stays authoritative. This column is written from `rank.value` by
-- the same upsert that writes the payload, in the same statement, so there is no
-- window in which the two disagree — the same relationship `parent_id` and
-- `kind` already have.
ALTER TABLE notes_blocks ADD COLUMN IF NOT EXISTS rank text NOT NULL DEFAULT '';

-- Backfill from the payload the column was extracted from. Rows written before
-- this migration have their rank in jsonb and nowhere else; leaving them at ''
-- would sort every existing block ahead of every new one.
UPDATE notes_blocks
   SET rank = COALESCE(payload_json -> 'rank' ->> 'value', '')
 WHERE rank = '';

-- Document order for one parent. Separate from `notes_blocks_tree_idx` rather
-- than replacing it: that index serves "does this parent have children", which
-- does not want to walk them in order.
CREATE INDEX IF NOT EXISTS notes_blocks_order_idx
  ON notes_blocks (org_id, user_id, parent_id, rank)
  WHERE deleted_at_hlc IS NULL;

-- E4's Pages row, as something a sidebar can query.
--
-- One row per block a NAVIGATOR needs to see: a page, a database, or anything
-- someone pinned. Not one row per block — that would duplicate `notes_index` and
-- pay the cost of a projection on every paragraph keystroke to answer a question
-- only about pages.
--
-- `title` is the block's own text (B4/E4: a page's title IS its text field, and
-- a second `title` column beside it would be E2's mistake in miniature). It is
-- stored here trimmed and truncated because a sidebar row is a line, not a
-- document, and pulling a 100k-character payload to render 40 characters is the
-- cost this table exists to remove.
CREATE TABLE IF NOT EXISTS notes_page_meta (
  org_id      text        NOT NULL,
  user_id     text        NOT NULL,
  block_id    text        NOT NULL,

  -- B4: nesting is one recursion over the parent, so the tree is this column
  -- and nothing else. Denormalised from the payload for the same reason
  -- `notes_blocks.parent_id` is.
  parent_id   text,
  kind        text        NOT NULL,
  rank        text        NOT NULL,

  title       text        NOT NULL DEFAULT '',
  icon        text,
  cover       text,
  favourite   boolean     NOT NULL DEFAULT false,

  -- E3 — a database block's property definitions and its stored projections.
  -- jsonb rather than a `notes_properties` table for the reason in the header:
  -- the block is the record, and a second table holding the same schema would be
  -- a copy with no rule for which one wins.
  schema_json jsonb,
  views_json  jsonb,

  rebuilt_at  timestamptz NOT NULL DEFAULT now(),

  PRIMARY KEY (org_id, user_id, block_id),
  FOREIGN KEY (org_id, user_id, block_id)
    REFERENCES notes_blocks (org_id, user_id, id) ON DELETE CASCADE
);

-- The sidebar tree, read on every open of a notes surface.
CREATE INDEX IF NOT EXISTS notes_page_meta_tree_idx
  ON notes_page_meta (org_id, user_id, parent_id, rank);

-- "Pinned", which E4 lists as its own section of the sidebar. Partial, because
-- the answer is a handful of rows out of however many pages someone has.
CREATE INDEX IF NOT EXISTS notes_page_meta_favourite_idx
  ON notes_page_meta (org_id, user_id)
  WHERE favourite;

-- "Every database I could add a row to" — the picker E3 needs, without reading
-- every page to find out which ones have a schema.
CREATE INDEX IF NOT EXISTS notes_page_meta_kind_idx
  ON notes_page_meta (org_id, user_id, kind);

-- E3's property VALUES, one row per cell, so a view is a query.
--
-- Per (block, property) rather than one row per block with a jsonb map, because
-- filtering and sorting a view is per COLUMN: `status = blocked ORDER BY due`
-- over a jsonb blob is a scan and a parse per row, which is the shape this table
-- exists to replace. It is also the same granularity the merge already uses —
-- `props` is stamped per key (D4's per-field rule one level down) — so the
-- projection matches the unit of concurrency instead of inventing a coarser one.
--
-- The value is stored FOUR ways on purpose:
--
--   `value_json` is the exact value, and it is the only one that is authoritative
--     for rendering. A multi-select is a list and there is no scalar column that
--     is honest about a list.
--   `value_text`, `value_number`, `value_bool`, `value_date` are the comparable
--     projections a filter and a sort need, populated by the SHAPE of the value
--     rather than by the property's declared type. The type lives on the
--     database block, and a projection that had to read another row to know how
--     to write this one would be wrong for exactly as long as the two were out
--     of step — which is every moment between adding a column and the rows
--     catching up.
--
-- A cleared cell is a row with every projection NULL, not a missing row. A
-- missing row and an empty value are different answers to "is this filter
-- satisfied", and `is_empty` in the view language needs to distinguish them.
CREATE TABLE IF NOT EXISTS notes_row_values (
  org_id       text        NOT NULL,
  user_id      text        NOT NULL,
  block_id     text        NOT NULL,
  property_id  text        NOT NULL,

  -- The row's parent. For a database row that IS the database (E3: a database's
  -- children are its rows), but this column does not claim so: the function that
  -- writes it holds one block and cannot see its parent's kind. The query joins
  -- `notes_blocks` to confirm, which is the only place the claim is checkable.
  parent_id    text,

  value_json   jsonb       NOT NULL,
  value_text   text,
  value_number double precision,
  value_bool   boolean,
  value_date   date,

  rebuilt_at   timestamptz NOT NULL DEFAULT now(),

  PRIMARY KEY (org_id, user_id, block_id, property_id),
  FOREIGN KEY (org_id, user_id, block_id)
    REFERENCES notes_blocks (org_id, user_id, id) ON DELETE CASCADE
);

-- The view query: one database's rows, one column at a time.
CREATE INDEX IF NOT EXISTS notes_row_values_column_idx
  ON notes_row_values (org_id, user_id, parent_id, property_id);
