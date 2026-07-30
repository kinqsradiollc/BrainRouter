-- 032_asset_inventories — durable per-repository inventory header required by
-- the CVE contract. Components remain normalized in asset_components; this row
-- makes last-scan/component-count freshness inspectable without a full count.

CREATE TABLE IF NOT EXISTS asset_inventories (
  org_id          TEXT NOT NULL,
  repo            TEXT NOT NULL,
  last_scan_id    TEXT NOT NULL,
  component_count INTEGER NOT NULL DEFAULT 0,
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (org_id, repo)
);

CREATE INDEX IF NOT EXISTS idx_asset_inventories_updated
  ON asset_inventories (org_id, updated_at DESC);
