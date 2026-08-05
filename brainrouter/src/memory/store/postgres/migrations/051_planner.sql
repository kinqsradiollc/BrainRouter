-- ADR-028 Part D — the planner's durable store.
--
-- Scoped (org_id, user_id, id) per D9. The planner is PERSONAL: unlike Track,
-- which is org-collaborative, one person's day is not another's, so user_id is
-- part of the key rather than an author column. Cross-user reads are impossible
-- by construction rather than by a filter someone might forget.
--
-- Every mutable field carries its own HLC stamp (D3/D4). That is why the item
-- payload is jsonb rather than columns: field-level last-writer-wins needs a
-- stamp PER FIELD, and modelling forty stamped columns to get there would be
-- worse in every way than storing the shape the merge functions already speak.
--
-- Deletion is a tombstone, never a DELETE. A later edit arriving from another
-- device must be able to resurrect the row as conflicted; removing it would
-- make that edit look like a creation and the deletion would silently un-happen.

CREATE TABLE IF NOT EXISTS planner_items (
  org_id        text        NOT NULL,
  user_id       text        NOT NULL,
  id            text        NOT NULL,

  -- 'owned' items are created here and can conflict; 'mirrored' ones project a
  -- truth that lives elsewhere and are re-read rather than merged (D1).
  origin        text        NOT NULL,
  source        text,

  -- The full stamped item: title/notes/dueDate/priority/completed, each with
  -- its own HLC, plus any unresolved conflicts.
  payload_json  jsonb       NOT NULL,

  -- Denormalised from the payload so the common reads (today, overdue) are
  -- index scans instead of jsonb extraction on every row.
  due_date      date,
  completed     boolean     NOT NULL DEFAULT false,
  deleted_at_hlc text,

  -- Server-side ordering for `changed-since` pulls (D11). Distinct from the
  -- HLC: this is OUR clock, monotonic per row-write, and it is what a client
  -- cursor points at.
  revision      bigserial   NOT NULL,

  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),

  PRIMARY KEY (org_id, user_id, id),
  CONSTRAINT planner_items_origin_check CHECK (origin IN ('owned', 'mirrored'))
);

-- The pull query: everything for this user changed after the client's cursor.
CREATE INDEX IF NOT EXISTS planner_items_changed_idx
  ON planner_items (org_id, user_id, revision);

-- Today/overdue, the one read that happens on every planner open.
CREATE INDEX IF NOT EXISTS planner_items_due_idx
  ON planner_items (org_id, user_id, due_date)
  WHERE completed = false AND deleted_at_hlc IS NULL;

CREATE TABLE IF NOT EXISTS planner_blocks (
  org_id         text        NOT NULL,
  user_id        text        NOT NULL,
  id             text        NOT NULL,
  item_id        text        NOT NULL,

  -- Null for an unscheduled block. A today-list entry is a real plan (D5) —
  -- forcing everything onto a clock is how planners get abandoned.
  scheduled_for  timestamptz,
  estimate_minutes integer   NOT NULL,
  actual_minutes integer,
  carried_over   integer     NOT NULL DEFAULT 0,
  completed_at   timestamptz,

  revision       bigserial   NOT NULL,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),

  PRIMARY KEY (org_id, user_id, id),
  CONSTRAINT planner_blocks_estimate_check CHECK (estimate_minutes > 0)
);

CREATE INDEX IF NOT EXISTS planner_blocks_changed_idx
  ON planner_blocks (org_id, user_id, revision);

CREATE INDEX IF NOT EXISTS planner_blocks_day_idx
  ON planner_blocks (org_id, user_id, scheduled_for);

-- Applied operation keys, so a redelivered push is a no-op rather than a
-- double-apply (ADR-027 D12). Keyed by tenant as well as by key — migration 049
-- fixed exactly this shape being cross-tenant, and repeating that mistake in a
-- new table would be careless.
CREATE TABLE IF NOT EXISTS planner_applied_operations (
  org_id          text        NOT NULL,
  user_id         text        NOT NULL,
  idempotency_key text        NOT NULL,
  item_id         text        NOT NULL,
  applied_at      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (org_id, user_id, idempotency_key)
);

-- Retention (D8 → ADR-027 D11): completed items keep detail for 90 days. This
-- index makes the compaction sweep cheap rather than a full scan.
CREATE INDEX IF NOT EXISTS planner_items_retention_idx
  ON planner_items (org_id, user_id, updated_at)
  WHERE completed = true;
