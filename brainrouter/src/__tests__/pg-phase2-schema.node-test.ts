import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { loadMigrations } from '../memory/store/postgres/migrate.js';

// The compiled test sits at dist/__tests__/; the migrations are copied to
// dist/memory/store/postgres/migrations by the build's copy-migrations step.
const migrationsDir = fileURLToPath(new URL('../memory/store/postgres/migrations', import.meta.url));

test('pg migrations load in order, with the full Phase 2 schema present', () => {
  const migs = loadMigrations(migrationsDir);
  assert.ok(migs.length >= 2, 'at least 001_init + 002_schema are present');
  assert.equal(migs[0].id, '001_init');
  assert.equal(migs[1].id, '002_schema');
  for (const m of migs) assert.ok(m.sql.trim().length > 0, `${m.id} is non-empty`);

  const schema = migs.find((m) => m.id === '002_schema')!.sql;
  // Core tables the recall + capture path depends on.
  for (const table of [
    'cognitive_records', 'sensory_stream', 'memory_jobs', 'memory_evidence',
    'source_chunks', 'memory_tree_nodes', 'ccr_entries', 'graph_nodes',
  ]) {
    assert.ok(new RegExp(`CREATE TABLE IF NOT EXISTS ${table}\\b`).test(schema), `002 creates ${table}`);
  }
  // FTS5 → Postgres tsvector + GIN.
  assert.match(schema, /content_tsv\s+tsvector GENERATED ALWAYS/);
  assert.match(schema, /USING GIN \(content_tsv\)/);
  // cognitive_vec is created at runtime (embedder-dependent dim), NOT in the migration.
  assert.ok(!/CREATE TABLE[^;]*cognitive_vec/.test(schema), 'cognitive_vec is deferred to initVec');
});
