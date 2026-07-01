-- HONK-H3.3 — store-and-serve the fleet queue snapshot for the dashboard console.
--
-- The fleet runs CLIENT-side (the durable queue lives in ~/.brainrouter/fleet on
-- the host running `brainrouter fleet drain`). A deployed/remote brain can't read
-- those files, so the client PUSHES a snapshot (the same shape `summarizeFleet()`
-- returns) and the dashboard fetches it back. One row per (tenant, host) so a user
-- with several fleet hosts sees each. Snapshot kept as JSON text — the brain never
-- needs to interpret it, only relay it.
CREATE TABLE IF NOT EXISTS fleet_snapshots (
  user_id       text NOT NULL,
  host          text NOT NULL,
  snapshot_json text NOT NULL,
  job_count     integer NOT NULL DEFAULT 0,
  updated_at    text NOT NULL,
  PRIMARY KEY (user_id, host)
);
CREATE INDEX IF NOT EXISTS idx_fleet_user_updated ON fleet_snapshots(user_id, updated_at DESC);
