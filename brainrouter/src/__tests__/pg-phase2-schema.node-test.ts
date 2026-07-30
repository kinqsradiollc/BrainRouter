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

test('provider-model catalog migration preserves org ownership and metadata-only usage', () => {
  const migs = loadMigrations(migrationsDir);
  const schema = migs.find((m) => m.id === '020_provider_models')?.sql;
  assert.ok(schema, '020_provider_models is present');

  assert.match(schema, /CREATE TABLE IF NOT EXISTS provider_models\b/);
  assert.match(schema, /UNIQUE \(org_id, public_model_id\)/);
  assert.match(schema, /FOREIGN KEY \(provider_config_id, org_id\)/);
  assert.match(schema, /CREATE UNIQUE INDEX IF NOT EXISTS uq_provider_models_default/);
  assert.match(schema, /allowed_efforts_json\s+text NOT NULL DEFAULT '\[\]'/);
  assert.match(schema, /effort_wire_map_json\s+text NOT NULL DEFAULT '\{\}'/);
  assert.match(schema, /capability_source\s+text NOT NULL/);

  assert.match(schema, /CREATE TABLE IF NOT EXISTS model_usage_events\b/);
  assert.match(schema, /public_model_id\s+text NOT NULL/);
  assert.match(schema, /selected_effort\s+text/);
  assert.match(schema, /upstream_route\s+text/);
  assert.doesNotMatch(schema, /\b(prompt|response|input_text|output_text|content)\s+text/i);
});

test('model-gateway service principals are persisted without credential material', () => {
  const migs = loadMigrations(migrationsDir);
  const schema = migs.find((m) => m.id === '021_model_gateway_service_principals')?.sql;
  assert.ok(schema, '021_model_gateway_service_principals is present');
  assert.match(schema, /CREATE TABLE IF NOT EXISTS model_gateway_service_principals\b/);
  assert.match(schema, /org_id\s+text NOT NULL REFERENCES organizations/);
  assert.match(schema, /scopes_json\s+text NOT NULL/);
  assert.doesNotMatch(schema, /\b(secret|token|api_key|credential)_?(?:hash|ciphertext)?\s+text/i);
});

test('remote access identity migration is tenant-scoped and metadata-only', () => {
  const migs = loadMigrations(migrationsDir);
  const schema = migs.find((m) => m.id === '022_remote_access_identity')?.sql;
  assert.ok(schema, '022_remote_access_identity is present');

  for (const table of [
    'remote_devices',
    'auth_device_sessions',
    'remote_access_grants',
    'remote_access_audit',
  ]) {
    assert.match(schema, new RegExp(`CREATE TABLE IF NOT EXISTS ${table}\\b`));
  }

  assert.match(schema, /FOREIGN KEY \(org_id, user_id\)\s+REFERENCES org_members\(org_id, user_id\)/);
  assert.match(schema, /token_hash\s+text NOT NULL UNIQUE/);
  assert.match(schema, /reuse_detected_at\s+timestamptz/);
  assert.match(schema, /WHERE revoked_at IS NULL/);
  assert.match(schema, /FOREIGN KEY \(device_id, org_id, user_id\)\s+REFERENCES remote_devices/);
  assert.match(schema, /FOREIGN KEY \(parent_session_id, org_id, user_id\)\s+REFERENCES auth_device_sessions/);
  assert.match(schema, /scopes_json::jsonb <@ '\["monitor", "control", "approve"\]'::jsonb/);

  const devices = schema.match(/CREATE TABLE IF NOT EXISTS remote_devices \(([\s\S]*?)\n\);/)?.[1];
  assert.ok(devices, 'remote_devices table body is present');
  assert.match(devices, /installation_id\s+text NOT NULL/);
  assert.match(devices, /public_key_fingerprint\s+text NOT NULL/);
  assert.doesNotMatch(devices, /\b(workspace_session|active_session|session_key)\b/i);

  const audit = schema.match(/CREATE TABLE IF NOT EXISTS remote_access_audit \(([\s\S]*?)\n\);/)?.[1];
  assert.ok(audit, 'remote_access_audit table body is present');
  assert.match(audit, /event_type\s+text NOT NULL/);
  assert.match(audit, /request_id\s+text/);
  assert.match(audit, /FOREIGN KEY \(actor_device_id, org_id, user_id\)/);
  assert.match(audit, /FOREIGN KEY \(grant_id, org_id, user_id\)/);
  assert.doesNotMatch(
    audit,
    /^\s*(?:terminal|payload|content|token|credential|password|prompt|response|ip|workspace)[a-z0-9_]*\s+/im,
  );
  assert.doesNotMatch(audit, /\b(metadata|details)_json\b/i);
});

test('remote control-plane credentials are hash-only, scoped, expiring, and single-use', () => {
  const migs = loadMigrations(migrationsDir);
  const schema = migs.find((m) => m.id === '024_remote_control_plane')?.sql;
  assert.ok(schema, '024_remote_control_plane is present');
  assert.match(schema, /CREATE TABLE IF NOT EXISTS remote_enrollment_challenges\b/);
  assert.match(schema, /CREATE TABLE IF NOT EXISTS remote_relay_tickets\b/);
  assert.match(schema, /challenge_hash\s+text NOT NULL UNIQUE/);
  assert.match(schema, /token_hash\s+text NOT NULL UNIQUE/);
  assert.match(schema, /consumed_at\s+timestamptz/);
  assert.match(schema, /audience\s+text NOT NULL DEFAULT 'remote-relay'/);
  assert.match(schema, /expires_at >= created_at \+ interval '30 seconds'/);
  assert.match(schema, /expires_at <= created_at \+ interval '60 seconds'/);
  assert.match(schema, /FOREIGN KEY \(org_id, user_id\)\s+REFERENCES org_members/);
  assert.match(schema, /FOREIGN KEY \(presenting_device_id, org_id, user_id\)\s+REFERENCES remote_devices/);
  assert.match(schema, /FOREIGN KEY \(grant_id, org_id, user_id\)\s+REFERENCES remote_access_grants/);

  const tickets = schema.match(/CREATE TABLE IF NOT EXISTS remote_relay_tickets \(([\s\S]*?)\n\);/)?.[1];
  assert.ok(tickets, 'remote_relay_tickets table body is present');
  assert.doesNotMatch(tickets, /^\s*(?:token|credential|password|jwt|api_key)\s+/im);
  assert.doesNotMatch(
    tickets,
    /^\s*(?:terminal|payload|content|prompt|response|ip|workspace|relay_endpoint)[a-z0-9_]*\s+/im,
  );
});
