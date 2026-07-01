-- ADR-007 Phase 2 — full Postgres schema for the brain's memory store.
--
-- Mirrors SqliteMemoryStore's schema 1:1 so the PostgresMemoryStore adapter can
-- run the same queries with the same semantics. Fidelity choices:
--   * Timestamps stay `text` (ISO-8601 strings) — the store compares them as
--     strings (e.g. `recorded_at > $1`), so text preserves exact behaviour.
--   * `*_json` columns stay `text` — the store serializes/parses JSON in app code.
--   * Booleans stay `integer` (0/1) and scores stay `double precision`, matching
--     the SQLite column affinities the adapter reads back.
--   * FTS5 virtual tables (cognitive_fts, source_chunks_fts) are replaced by a
--     generated `content_tsv tsvector` column + GIN index on the base table — the
--     idiomatic Postgres full-text index, kept in sync automatically (no triggers).
--   * `cognitive_vec` is NOT created here: its dimension is embedder-dependent, so
--     the adapter creates `cognitive_vec (record_id, embedding vector(N))` at
--     runtime in initVec(N), mirroring SqliteMemoryStore's lazy vec0 creation.
-- The 001 `memory_records` placeholder is vestigial (superseded by these tables).

-- ── Embedding metadata ──
CREATE TABLE IF NOT EXISTS embedding_meta (
  id          integer PRIMARY KEY CHECK (id = 1),
  dimensions  integer NOT NULL,
  created_at  text NOT NULL
);

-- ── Sensory stream ──
CREATE TABLE IF NOT EXISTS sensory_stream (
  record_id    text PRIMARY KEY,
  user_id      text NOT NULL,
  session_key  text NOT NULL,
  session_id   text DEFAULT '',
  role         text NOT NULL DEFAULT '',
  message_text text NOT NULL,
  recorded_at  text DEFAULT '',
  timestamp    bigint DEFAULT 0,
  skill_tag    text DEFAULT '',
  extracted_at text DEFAULT NULL
);
CREATE INDEX IF NOT EXISTS idx_sensory_user_session ON sensory_stream(user_id, session_key);
CREATE INDEX IF NOT EXISTS idx_sensory_recorded ON sensory_stream(recorded_at);
CREATE INDEX IF NOT EXISTS idx_sensory_extracted ON sensory_stream(user_id, session_key, extracted_at);

-- ── Users ──
CREATE TABLE IF NOT EXISTS users (
  user_id       text PRIMARY KEY,
  api_key       text NOT NULL UNIQUE,
  password_hash text DEFAULT NULL,
  display_name  text DEFAULT '',
  email         text DEFAULT '',
  is_admin      integer DEFAULT 0,
  status        text DEFAULT 'active',
  created_at    text NOT NULL
);

-- ── Active sessions (federation) ──
CREATE TABLE IF NOT EXISTS active_sessions (
  session_key       text NOT NULL,
  user_id           text NOT NULL,
  client_kind       text NOT NULL DEFAULT 'http-unknown',
  workspace_root    text DEFAULT '',
  started_at        text NOT NULL,
  last_heartbeat_at text NOT NULL,
  metadata_json     text DEFAULT '{}',
  usage_json        text DEFAULT NULL,
  PRIMARY KEY (session_key, user_id)
);
CREATE INDEX IF NOT EXISTS idx_active_sessions_user_heartbeat ON active_sessions(user_id, last_heartbeat_at DESC);

-- ── Session inbox (federation) ──
CREATE TABLE IF NOT EXISTS session_inbox (
  id               text PRIMARY KEY,
  user_id          text NOT NULL,
  from_session_key text NOT NULL,
  to_session_key   text NOT NULL,
  kind             text NOT NULL,
  payload_json     text NOT NULL DEFAULT '{}',
  created_at       text NOT NULL,
  delivered_at     text DEFAULT NULL
);
CREATE INDEX IF NOT EXISTS idx_session_inbox_recipient ON session_inbox(user_id, to_session_key, created_at);
CREATE INDEX IF NOT EXISTS idx_session_inbox_delivered ON session_inbox(delivered_at);

-- ── Pending delegations (federation) ──
CREATE TABLE IF NOT EXISTS pending_delegations (
  id               text PRIMARY KEY,
  user_id          text NOT NULL,
  from_session_key text NOT NULL,
  to_agent_kind    text NOT NULL,
  to_session_key   text DEFAULT NULL,
  packet_json      text NOT NULL DEFAULT '{}',
  status           text NOT NULL DEFAULT 'pending',
  created_at       text NOT NULL,
  updated_at       text NOT NULL,
  claimed_at       text DEFAULT NULL
);
CREATE INDEX IF NOT EXISTS idx_pending_delegations_claimable ON pending_delegations(user_id, to_agent_kind, status, created_at);

-- ── Memory jobs (brain queue) ──
CREATE TABLE IF NOT EXISTS memory_jobs (
  id            text PRIMARY KEY,
  kind          text NOT NULL,
  status        text NOT NULL DEFAULT 'pending',
  priority      integer NOT NULL DEFAULT 50,
  attempts      integer NOT NULL DEFAULT 0,
  max_attempts  integer NOT NULL DEFAULT 3,
  run_after     text NOT NULL,
  locked_at     text,
  parent_job_id text,
  input_json    text NOT NULL DEFAULT '{}',
  output_json   text,
  error         text,
  created_at    text NOT NULL,
  updated_at    text NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_memory_jobs_eligible ON memory_jobs(status, priority DESC, run_after) WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS idx_memory_jobs_running ON memory_jobs(locked_at) WHERE locked_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_memory_jobs_kind ON memory_jobs(kind, updated_at);

-- ── Cognitive records ──
CREATE TABLE IF NOT EXISTS cognitive_records (
  record_id           text PRIMARY KEY,
  user_id             text NOT NULL,
  session_key         text DEFAULT '',
  session_id          text DEFAULT '',
  content             text NOT NULL,
  type                text DEFAULT '',
  priority            integer DEFAULT 50,
  scene_name          text DEFAULT '',
  skill_tag           text DEFAULT '',
  half_life_days      integer,
  superseded_by       text,
  invalid_at          text DEFAULT NULL,
  timestamp_str       text DEFAULT '',
  timestamp_start     text DEFAULT '',
  timestamp_end       text DEFAULT '',
  created_time        text DEFAULT '',
  updated_time        text DEFAULT '',
  metadata_json       text DEFAULT '{}',
  citation_count      integer DEFAULT 0,
  last_cited_at       text,
  never_cited_count   integer DEFAULT 0,
  archived            integer DEFAULT 0,
  confidence          double precision DEFAULT 0.65,
  status              text DEFAULT 'active',
  source_kind         text DEFAULT '',
  verification_status text DEFAULT '',
  repo_paths_json     text DEFAULT '[]',
  file_paths_json     text DEFAULT '[]',
  commands_json       text DEFAULT '[]',
  workspace_tag       text,
  project_tag         text,
  -- FTS5 cognitive_fts → generated tsvector + GIN (idiomatic Postgres full-text).
  content_tsv         tsvector GENERATED ALWAYS AS (to_tsvector('english', content)) STORED
);
CREATE INDEX IF NOT EXISTS idx_cognitive_workspace_tag ON cognitive_records(user_id, workspace_tag);
CREATE INDEX IF NOT EXISTS idx_cognitive_project_tag ON cognitive_records(user_id, project_tag);
CREATE INDEX IF NOT EXISTS idx_cognitive_user_type ON cognitive_records(user_id, type);
CREATE INDEX IF NOT EXISTS idx_cognitive_user_session ON cognitive_records(user_id, session_key);
CREATE INDEX IF NOT EXISTS idx_cognitive_content_tsv ON cognitive_records USING GIN (content_tsv);

-- ── Memory evidence ──
CREATE TABLE IF NOT EXISTS memory_evidence (
  id            text PRIMARY KEY,
  user_id       text NOT NULL,
  record_id     text NOT NULL,
  kind          text NOT NULL,
  ref           text NOT NULL,
  excerpt       text DEFAULT '',
  observed_at   text NOT NULL,
  metadata_json text DEFAULT '{}'
);
CREATE INDEX IF NOT EXISTS idx_memory_evidence_record ON memory_evidence(user_id, record_id);

-- ── Memory operations (audit log) ──
CREATE TABLE IF NOT EXISTS memory_operations (
  id            text PRIMARY KEY,
  user_id       text NOT NULL,
  record_id     text DEFAULT NULL,
  operation     text NOT NULL,
  actor         text DEFAULT '',
  session_key   text DEFAULT '',
  reason        text DEFAULT '',
  created_at    text NOT NULL,
  metadata_json text DEFAULT '{}'
);
CREATE INDEX IF NOT EXISTS idx_memory_operations_user_time ON memory_operations(user_id, created_at DESC, id ASC);

-- ── Memory file index ──
CREATE TABLE IF NOT EXISTS memory_file_index (
  id           text PRIMARY KEY,
  user_id      text NOT NULL,
  record_id    text NOT NULL,
  file_path    text NOT NULL,
  symbol       text DEFAULT '',
  created_time text NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_memory_file_index_path ON memory_file_index(user_id, file_path, created_time DESC);
CREATE INDEX IF NOT EXISTS idx_memory_file_index_record ON memory_file_index(user_id, record_id);

-- ── Contradictions ──
CREATE TABLE IF NOT EXISTS contradictions (
  id           text PRIMARY KEY,
  user_id      text NOT NULL,
  record_id_a  text NOT NULL,
  record_id_b  text NOT NULL,
  reason       text,
  confidence   double precision,
  status       text DEFAULT 'pending',
  created_time text DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_contradictions_user ON contradictions(user_id, status);

-- ── Skill extraction hints ──
CREATE TABLE IF NOT EXISTS skill_extraction_hints (
  skill_name    text PRIMARY KEY,
  hints         text NOT NULL,
  source_file   text DEFAULT '',
  registered_at text DEFAULT ''
);

-- ── Skill activations ──
CREATE TABLE IF NOT EXISTS skill_activations (
  user_id         text NOT NULL,
  skill_name      text NOT NULL,
  potential       double precision DEFAULT 0.0,
  last_decay_time text NOT NULL,
  PRIMARY KEY (user_id, skill_name)
);

-- ── Contextual focus scenes ──
CREATE TABLE IF NOT EXISTS contextual_focus (
  id               text PRIMARY KEY,
  user_id          text NOT NULL,
  scene_name       text NOT NULL,
  summary_md       text NOT NULL,
  heat_score       double precision DEFAULT 100.0,
  last_active_time text DEFAULT '',
  created_time     text DEFAULT '',
  updated_time     text DEFAULT '',
  UNIQUE (user_id, scene_name)
);
CREATE INDEX IF NOT EXISTS idx_focus_user_heat ON contextual_focus(user_id, heat_score DESC);

-- ── Core identity ──
CREATE TABLE IF NOT EXISTS core_identity (
  user_id                       text PRIMARY KEY,
  persona_md                    text NOT NULL,
  cognitive_count_at_generation integer DEFAULT 0,
  created_time                  text DEFAULT '',
  updated_time                  text DEFAULT ''
);

-- ── Scheduler state ──
CREATE TABLE IF NOT EXISTS scheduler_state (
  user_id                            text PRIMARY KEY,
  cognitive_count_since_last_focus    integer DEFAULT 0,
  cognitive_count_since_last_identity integer DEFAULT 0,
  total_cognitive_count               integer DEFAULT 0,
  extraction_errors                   integer DEFAULT 0,
  last_error_message                  text DEFAULT NULL,
  last_error_at                       text DEFAULT NULL
);

-- ── GraphRAG nodes ──
CREATE TABLE IF NOT EXISTS graph_nodes (
  id               text PRIMARY KEY,
  user_id          text NOT NULL,
  entity           text NOT NULL,
  entity_type      text NOT NULL,
  skill_tag        text DEFAULT '',
  confidence       double precision DEFAULT 1.0,
  source_record_id text,
  created_time     text DEFAULT '',
  UNIQUE (user_id, entity)
);
CREATE INDEX IF NOT EXISTS idx_graph_nodes_user ON graph_nodes(user_id);

-- ── GraphRAG edges ──
CREATE TABLE IF NOT EXISTS graph_edges (
  id               text PRIMARY KEY,
  user_id          text NOT NULL,
  from_node_id     text NOT NULL,
  to_node_id       text NOT NULL,
  relation         text NOT NULL,
  skill_tag        text DEFAULT '',
  confidence       double precision DEFAULT 1.0,
  source_record_id text,
  created_time     text DEFAULT '',
  UNIQUE (user_id, from_node_id, to_node_id, relation)
);
CREATE INDEX IF NOT EXISTS idx_graph_edges_from ON graph_edges(from_node_id);
CREATE INDEX IF NOT EXISTS idx_graph_edges_to ON graph_edges(to_node_id);

-- ── Dendritic spines (cognitive connections) ──
CREATE TABLE IF NOT EXISTS cognitive_connections (
  user_id           text NOT NULL,
  source_id         text NOT NULL,
  target_id         text NOT NULL,
  weight            double precision DEFAULT 0.5,
  last_activated_at text DEFAULT '',
  PRIMARY KEY (user_id, source_id, target_id),
  FOREIGN KEY (source_id) REFERENCES cognitive_records(record_id) ON DELETE CASCADE,
  FOREIGN KEY (target_id) REFERENCES cognitive_records(record_id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_cognitive_conn_user_src ON cognitive_connections(user_id, source_id);
CREATE INDEX IF NOT EXISTS idx_cognitive_conn_user_tgt ON cognitive_connections(user_id, target_id);

-- ── Source documents ──
CREATE TABLE IF NOT EXISTS source_documents (
  id               text PRIMARY KEY,
  user_id          text NOT NULL,
  workspace_tag    text DEFAULT NULL,
  kind             text NOT NULL,
  uri              text DEFAULT NULL,
  hash             text NOT NULL,
  title            text NOT NULL DEFAULT '',
  created_at       text NOT NULL,
  metadata_json    text NOT NULL DEFAULT '{}',
  stale            integer NOT NULL DEFAULT 0,
  commit_count_90d integer DEFAULT NULL,
  last_commit_date text DEFAULT NULL
);
CREATE INDEX IF NOT EXISTS idx_source_docs_user_hash ON source_documents(user_id, hash);
CREATE INDEX IF NOT EXISTS idx_source_docs_user_created ON source_documents(user_id, created_at);

-- ── Source chunks ──
CREATE TABLE IF NOT EXISTS source_chunks (
  id            text PRIMARY KEY,
  document_id   text NOT NULL,
  user_id       text DEFAULT NULL,
  workspace_tag text DEFAULT NULL,
  ordinal       integer NOT NULL,
  content       text NOT NULL,
  token_count   integer NOT NULL DEFAULT 0,
  file_path     text DEFAULT NULL,
  symbol        text DEFAULT NULL,
  start_line    integer DEFAULT NULL,
  end_line      integer DEFAULT NULL,
  hash          text NOT NULL,
  -- source_chunks_fts → generated tsvector over content + symbol.
  content_tsv   tsvector GENERATED ALWAYS AS (to_tsvector('english', content || ' ' || coalesce(symbol, ''))) STORED,
  FOREIGN KEY (document_id) REFERENCES source_documents(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_source_chunks_doc ON source_chunks(document_id, ordinal);
CREATE INDEX IF NOT EXISTS idx_source_chunks_content_tsv ON source_chunks USING GIN (content_tsv);

-- ── Code symbol edges ──
CREATE TABLE IF NOT EXISTS code_symbol_edges (
  document_id   text NOT NULL,
  from_chunk_id text NOT NULL,
  to_chunk_id   text NOT NULL,
  kind          text NOT NULL DEFAULT 'calls',
  PRIMARY KEY (from_chunk_id, to_chunk_id, kind),
  FOREIGN KEY (from_chunk_id) REFERENCES source_chunks(id) ON DELETE CASCADE,
  FOREIGN KEY (to_chunk_id) REFERENCES source_chunks(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_code_edges_from ON code_symbol_edges(from_chunk_id);
CREATE INDEX IF NOT EXISTS idx_code_edges_to ON code_symbol_edges(to_chunk_id);

-- ── Cognitive ↔ source links (provenance) ──
CREATE TABLE IF NOT EXISTS cognitive_source_links (
  user_id       text NOT NULL,
  workspace_tag text DEFAULT NULL,
  record_id     text NOT NULL,
  chunk_id      text NOT NULL,
  created_at    text NOT NULL,
  PRIMARY KEY (record_id, chunk_id),
  FOREIGN KEY (chunk_id) REFERENCES source_chunks(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_cog_source_links_record ON cognitive_source_links(record_id);

-- ── Blackboard (staged candidates) ──
CREATE TABLE IF NOT EXISTS memory_blackboard_items (
  id                  text PRIMARY KEY,
  user_id             text NOT NULL,
  workspace_tag       text DEFAULT NULL,
  source_chunk_id     text DEFAULT NULL,
  candidate_json      text NOT NULL,
  score               double precision NOT NULL DEFAULT 0,
  status              text NOT NULL DEFAULT 'pending',
  conflict_ids_json   text NOT NULL DEFAULT '[]',
  created_at          text NOT NULL,
  committed_record_id text DEFAULT NULL
);
CREATE INDEX IF NOT EXISTS idx_blackboard_user_status ON memory_blackboard_items(user_id, status);

-- ── Memory tree (hierarchical summaries) ──
CREATE TABLE IF NOT EXISTS memory_tree_nodes (
  id                    text PRIMARY KEY,
  user_id               text NOT NULL,
  workspace_tag         text DEFAULT NULL,
  kind                  text NOT NULL,
  parent_id             text DEFAULT NULL,
  level                 integer NOT NULL DEFAULT 0,
  summary_md            text NOT NULL DEFAULT '',
  source_chunk_ids_json text NOT NULL DEFAULT '[]',
  sealed_at             text DEFAULT NULL,
  heat_score            double precision NOT NULL DEFAULT 0,
  created_at            text NOT NULL,
  scene_key             text DEFAULT NULL
);
CREATE INDEX IF NOT EXISTS idx_tree_user_kind ON memory_tree_nodes(user_id, kind, parent_id);
CREATE INDEX IF NOT EXISTS idx_tree_parent ON memory_tree_nodes(parent_id);

-- ── Vault export ledger ──
CREATE TABLE IF NOT EXISTS vault_exports (
  user_id       text NOT NULL,
  workspace_tag text DEFAULT NULL,
  path          text NOT NULL,
  hash          text NOT NULL,
  kind          text NOT NULL,
  ref_id        text NOT NULL,
  exported_at   text NOT NULL,
  PRIMARY KEY (user_id, path)
);

-- ── Compression cache (CCR) ──
CREATE TABLE IF NOT EXISTS ccr_entries (
  hash                  text NOT NULL,
  user_id               text NOT NULL,
  original_content      text NOT NULL,
  compressed_content    text,
  original_tokens       integer,
  compressed_tokens     integer,
  original_item_count   integer,
  compressed_item_count integer,
  tool_name             text,
  query_context         text,
  compression_strategy  text,
  created_at            double precision NOT NULL,
  ttl                   integer NOT NULL,
  retrieval_count       integer NOT NULL DEFAULT 0,
  last_accessed         double precision,
  PRIMARY KEY (hash, user_id)
);
CREATE INDEX IF NOT EXISTS idx_ccr_expiry ON ccr_entries(created_at);
CREATE INDEX IF NOT EXISTS idx_ccr_user ON ccr_entries(user_id);
