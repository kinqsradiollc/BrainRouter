-- ADR-027 D11 / P1-6 — retention and compaction, rung one of the growth ladder.
--
-- Owner decision: append-forever data keeps 90 days of DETAIL, after which it is
-- summarized into compact records and the raw rows are dropped.
--
-- `model_usage_events` is the clearest case: one row per model request, forever.
-- It is already metadata-only (no prompts, no responses, no tool payloads), and
-- everything the dashboard actually asks of it beyond the recent window is an
-- aggregate — requests, tokens, and cost per org per model per day. This table
-- is that aggregate, so the raw rows become droppable without losing a reported
-- number.
--
-- Deliberately NOT rolled up here:
--   - `review_findings` / `review_finding_events` back mean-time-to-remediate
--     and contributor history, which are per-finding and not reconstructable
--     from a daily sum.
--   - `memory_jobs` rows themselves cannot be deleted at all:
--     `repository_assurance_runs.job_id` references them ON DELETE RESTRICT.
--     Their `progress_json` timelines are compacted in place instead, which is
--     where the bytes actually are.

CREATE TABLE IF NOT EXISTS model_usage_daily (
  day                   date NOT NULL,
  org_id                text NOT NULL REFERENCES organizations(org_id) ON DELETE CASCADE,
  public_model_id       text NOT NULL,
  requests              bigint NOT NULL DEFAULT 0,
  input_tokens          bigint NOT NULL DEFAULT 0,
  output_tokens         bigint NOT NULL DEFAULT 0,
  cached_input_tokens   bigint NOT NULL DEFAULT 0,
  total_tokens          bigint NOT NULL DEFAULT 0,
  cost_microusd         bigint NOT NULL DEFAULT 0,
  PRIMARY KEY (day, org_id, public_model_id)
);

CREATE INDEX IF NOT EXISTS idx_model_usage_daily_org_day
  ON model_usage_daily (org_id, day DESC);

-- The rollup reads by age, so the scan that finds expired rows must be indexed
-- or retention degrades exactly as the table it is meant to bound grows.
CREATE INDEX IF NOT EXISTS idx_model_usage_events_created_at
  ON model_usage_events (created_at);

-- Job-progress compaction scans terminal rows by age for the same reason.
CREATE INDEX IF NOT EXISTS idx_memory_jobs_terminal_updated
  ON memory_jobs (updated_at)
  WHERE status IN ('done', 'failed', 'cancelled');
