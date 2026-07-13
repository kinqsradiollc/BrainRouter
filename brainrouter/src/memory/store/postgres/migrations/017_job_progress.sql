-- 017_job_progress.sql — append-only review/job activity timeline for dashboard polling.
ALTER TABLE memory_jobs ADD COLUMN IF NOT EXISTS progress_json text NOT NULL DEFAULT '[]';
