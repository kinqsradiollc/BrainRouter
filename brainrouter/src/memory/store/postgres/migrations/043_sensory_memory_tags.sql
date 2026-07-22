-- Preserve reviewed workspace memory tags across deferred cognitive extraction.
ALTER TABLE sensory_stream
  ADD COLUMN IF NOT EXISTS memory_tags_json text NOT NULL DEFAULT '[]';
