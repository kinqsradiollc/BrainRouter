#!/usr/bin/env node
/**
 * ADR-038 hosted Notes mutations against the real PostgreSQL transaction path.
 *
 * Run against an isolated migrated database:
 *   BRAINROUTER_DATABASE_URL=postgres://... node scripts/notes-mutation-e2e.mjs
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';

import { memoryEngine } from '../dist/memory/engine.js';
import * as notes from '../dist/memory/notes/backend.js';

const ORG = `adr038-notes-${Date.now()}`;
const USER = 'notes-e2e-user';
const databaseUrl = new URL(process.env.BRAINROUTER_DATABASE_URL ?? 'postgres://postgres@localhost:5432/brainrouter');
const databaseName = decodeURIComponent(databaseUrl.pathname.replace(/^\//, ''));
const databaseUser = decodeURIComponent(databaseUrl.username || 'postgres');
const databasePassword = decodeURIComponent(databaseUrl.password || '');
const postgresContainer = process.env.BRAINROUTER_POSTGRES_CONTAINER ?? 'brainrouter-postgres';

if (!/^[A-Za-z0-9_-]+$/.test(databaseName) || !/^[A-Za-z0-9_-]+$/.test(databaseUser)) {
  throw new Error('The E2E database and user names must contain only letters, numbers, underscores or hyphens.');
}

function psql(sql) {
  return execFileSync('docker', [
    'exec', ...(databasePassword ? ['-e', `PGPASSWORD=${databasePassword}`] : []),
    postgresContainer, 'psql', '-U', databaseUser, '-d', databaseName,
    '-v', 'ON_ERROR_STOP=1', '-tAc', sql,
  ], { encoding: 'utf8' }).trim();
}

function request(requestId, deviceId, operation) {
  return { version: 1, requestId, deviceId, operation };
}

async function mutate(requestId, deviceId, operation, nowMs = Date.now()) {
  return notes.mutateNotes(ORG, USER, request(requestId, deviceId, operation), nowMs);
}

async function purge() {
  const tables = [
    'notes_attachment_refs', 'notes_row_values', 'notes_refs', 'notes_index',
    'notes_page_meta', 'notes_block_leases', 'notes_applied_operations',
    'notes_blocks', 'notes_attachments', 'notes_host_clocks',
  ];
  for (const table of tables) {
    try {
      psql(`delete from ${table} where org_id = '${ORG}'`);
    } catch { /* migration may not have created an optional table */ }
  }
}

let failures = 0;
async function check(name, fn) {
  try {
    await fn();
    console.log(`  ok  ${name}`);
  } catch (error) {
    failures += 1;
    console.log(`  FAIL ${name}\n       ${error instanceof Error ? error.message : String(error)}`);
  }
}

console.log('ADR-038 · hosted Notes mutations against the real database\n');
await memoryEngine.ready;
await purge();

await check('a successful mutation replays the exact stored response', async () => {
  const input = request('create-main', 'device-a', {
    type: 'block.create',
    input: { blockId: 'block-main', text: 'Alpha beta', kind: 'paragraph' },
  });
  const first = await notes.mutateNotes(ORG, USER, input, 10_000);
  const replay = await notes.mutateNotes(ORG, USER, input, 10_000);
  assert.equal(first.ok, true);
  assert.deepEqual(replay, first);

  const reused = await mutate('create-main', 'device-a', {
    type: 'block.create', input: { blockId: 'other-block', text: 'Different request' },
  }, 10_001);
  assert.equal(reused.ok, false);
  assert.equal(reused.error.code, 'idempotency_conflict');
  assert.equal(await notes.getBlock(ORG, USER, 'other-block'), null);
});

await check('a failed second split write rolls back the first write and every receipt', async () => {
  psql(`
    CREATE OR REPLACE FUNCTION adr038_fail_note_insert() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      RAISE EXCEPTION 'ADR038 forced second primitive failure';
    END $$;
    CREATE TRIGGER adr038_fail_note_insert
      BEFORE INSERT ON notes_blocks
      FOR EACH ROW EXECUTE FUNCTION adr038_fail_note_insert();
  `);
  let failed = false;
  try {
    await mutate('split-must-rollback', 'device-a', {
      type: 'gesture.split', blockId: 'block-main', caret: 5,
    }, 11_000);
  } catch (error) {
    failed = /forced second primitive failure/i.test(String(error));
  } finally {
    psql('DROP TRIGGER IF EXISTS adr038_fail_note_insert ON notes_blocks; DROP FUNCTION IF EXISTS adr038_fail_note_insert();');
  }
  assert.equal(failed, true, 'the injected database failure reached the caller');
  const block = await notes.getBlock(ORG, USER, 'block-main');
  assert.equal(block.text.value, 'Alpha beta', 'the first split update rolled back');
  assert.equal(Number(psql(`select count(*) from notes_blocks where org_id='${ORG}' and user_id='${USER}'`)), 1);
  assert.equal(Number(psql(`select count(*) from notes_applied_operations where org_id='${ORG}' and user_id='${USER}' and idempotency_key like 'notes:mutation-primitive:%'`)), 0,
    'the failed split left no primitive receipt');
});

await check('two simultaneous lease requests produce one owner and one visible refusal', async () => {
  const [a, b] = await Promise.all([
    mutate('lease-a', 'device-a', { type: 'lease.acquire', blockId: 'block-main', holder: 'Device A' }, 12_000),
    mutate('lease-b', 'device-b', { type: 'lease.acquire', blockId: 'block-main', holder: 'Device B' }, 12_000),
  ]);
  assert.equal([a, b].filter((result) => result.ok).length, 1);
  assert.equal([a, b].filter((result) => !result.ok && result.error.code === 'locked').length, 1);
  const live = await notes.readLease(ORG, USER, 'block-main');
  assert.ok(live.lease);
  assert.ok(live.lease.deviceId === 'device-a' || live.lease.deviceId === 'device-b');
  const released = await mutate('lease-release', live.lease.deviceId, {
    type: 'lease.release', blockId: 'block-main', epoch: live.lease.epoch,
  }, 12_001);
  assert.equal(released.ok, true);
});

await check('database-backed hosted clocks remain monotonic when wall time moves backwards', async () => {
  const first = await mutate('clock-forward', 'device-clock', {
    type: 'block.update', blockId: 'block-main', patch: { text: 'Forward' },
  }, 50_000);
  const firstBlock = await notes.getBlock(ORG, USER, 'block-main');
  const firstClock = firstBlock.text.at;
  const second = await mutate('clock-backward', 'device-clock', {
    type: 'block.update', blockId: 'block-main', patch: { text: 'Backward wall' },
  }, 1_000);
  const secondClock = (await notes.getBlock(ORG, USER, 'block-main')).text.at;
  assert.equal(first.ok, true);
  assert.equal(second.ok, true);
  assert.equal(secondClock.physical, firstClock.physical);
  assert.ok(secondClock.logical > firstClock.logical);
  const durable = psql(`select physical || ':' || logical from notes_host_clocks where org_id='${ORG}' and user_id='${USER}'`);
  assert.equal(durable, `${secondClock.physical}:${secondClock.logical + 199}`,
    'the database retains the reserved clock frontier beyond the returned stamp');
});

await purge();
await memoryEngine.close();
console.log(`\n${failures === 0 ? 'PASS' : `FAIL — ${failures} failing`}`);
process.exit(failures === 0 ? 0 : 1);
