-- Progressive meeting transcripts. New meetings write segments immediately;
-- legacy transcript_text rows are lazily and idempotently backfilled on first read.
CREATE TABLE IF NOT EXISTS meeting_transcript_segments (
  meeting_id TEXT NOT NULL REFERENCES meetings (id) ON DELETE CASCADE,
  ordinal INTEGER NOT NULL,
  at_label TEXT NOT NULL DEFAULT '',
  speaker TEXT NOT NULL DEFAULT '',
  text TEXT NOT NULL,
  PRIMARY KEY (meeting_id, ordinal)
);

CREATE INDEX IF NOT EXISTS idx_meeting_transcript_segments_page
  ON meeting_transcript_segments (meeting_id, ordinal);
