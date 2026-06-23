-- ADR-007 / MEM-17 — restore the deterministic "most recent" tiebreak.
--
-- SQLite's getTreeNodeIdByChunkId ordered by `created_at DESC, rowid DESC`. The
-- Postgres port dropped the rowid tiebreak, so when two covering tree nodes
-- share a (millisecond-resolution) created_at the result fell back to arbitrary
-- heap order — intermittently returning the OLDER node instead of the newest.
--
-- A stable, monotonic identity column is the faithful analogue of SQLite's
-- implicit rowid: it is assigned in insertion order and — unlike `ctid` — does
-- NOT change when a row is updated (e.g. on seal or heat-score change), so it is
-- safe to order recency by. Appends never write `seq` explicitly, so GENERATED
-- ALWAYS is the correct, tamper-proof choice.
ALTER TABLE memory_tree_nodes
  ADD COLUMN IF NOT EXISTS seq bigint GENERATED ALWAYS AS IDENTITY;
