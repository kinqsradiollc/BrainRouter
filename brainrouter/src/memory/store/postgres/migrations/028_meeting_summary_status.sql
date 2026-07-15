-- ADR-018 M2 — decouple the SUMMARY lifecycle from the import lifecycle so
-- summarization runs as a refresh-safe background job with its own status. The
-- existing `status` column stays the import lifecycle ('imported'/'recorded');
-- these track the notes generation independently. DEFAULT 'ready' back-fills
-- every existing meeting (their summaries are already written).
ALTER TABLE meetings ADD COLUMN IF NOT EXISTS summary_status TEXT NOT NULL DEFAULT 'ready';
ALTER TABLE meetings ADD COLUMN IF NOT EXISTS summary_error TEXT;
ALTER TABLE meetings ADD COLUMN IF NOT EXISTS summary_updated_at TIMESTAMPTZ;
