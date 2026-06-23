-- REMOTE-BRAIN Phase 3 (ADR-005) — store-and-serve a client-built Atlas graph.
--
-- A remote/cloud brain can't build an Atlas (that scans the client filesystem),
-- but it CAN hold one: the client builds locally and uploads, then any client
-- (or the dashboard) fetches it back. One row per (tenant, workspace); the graph
-- is kept as JSON text (same on-the-wire shape the CLI writes to atlas-graph.json).
CREATE TABLE IF NOT EXISTS atlas_graphs (
  user_id       text NOT NULL,
  workspace_tag text NOT NULL,
  graph_json    text NOT NULL,
  node_count    integer NOT NULL DEFAULT 0,
  updated_at    text NOT NULL,
  PRIMARY KEY (user_id, workspace_tag)
);
CREATE INDEX IF NOT EXISTS idx_atlas_user_updated ON atlas_graphs(user_id, updated_at DESC);
