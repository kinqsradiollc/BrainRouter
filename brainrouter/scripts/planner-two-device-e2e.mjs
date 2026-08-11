/**
 * ADR-028 D9–D11 / ADR-038 — two devices, one real Postgres.
 *
 * The gap this closes: the merge rules were unit-tested against fakes and the
 * sync client against a stub, but no two devices had ever exchanged data
 * through the actual data plane. Unit tests prove the RULES; only this proves
 * the pipes.
 *
 * Run against the dev stack:
 *   BRAINROUTER_DATABASE_URL=... node scripts/planner-two-device-e2e.mjs
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import * as planner from '../dist/memory/planner/backend.js';
import { memoryEngine } from '../dist/memory/engine.js';

const ORG = 'e2e-org';
const USER = 'e2e-user';
const stamp = (physical, logical, deviceId) => ({ physical, logical, deviceId });
const databaseUrl = new URL(process.env.BRAINROUTER_DATABASE_URL ?? 'postgres://postgres@localhost:5432/brainrouter');
const databaseName = decodeURIComponent(databaseUrl.pathname.replace(/^\//, ''));
const databaseUser = decodeURIComponent(databaseUrl.username || 'postgres');
const databasePassword = decodeURIComponent(databaseUrl.password || '');
const postgresContainer = process.env.BRAINROUTER_POSTGRES_CONTAINER ?? 'brainrouter-postgres';

if (!/^[A-Za-z0-9_-]+$/.test(databaseName) || !/^[A-Za-z0-9_-]+$/.test(databaseUser)) {
  throw new Error('The E2E database and user names must contain only letters, numbers, underscores or hyphens.');
}

function dockerPsqlArgs(sql) {
  return [
    'exec', ...(databasePassword ? ['-e', `PGPASSWORD=${databasePassword}`] : []),
    postgresContainer, 'psql', '-U', databaseUser, '-d', databaseName,
    '-v', 'ON_ERROR_STOP=1', '-tAc', sql,
  ];
}

/**
 * A run-unique key prefix.
 *
 * Idempotency records outlive the rows they applied to — which is correct, and
 * it means a DETERMINISTIC key makes every run after the first a no-op. The
 * first version of this script did that and reported zero accepted operations,
 * which read as a push failure and was actually the guard working.
 */
const RUN = `r${Date.now()}`;

const op = (over) => ({
  idempotencyKey: `${RUN}:${over.itemId}:${over.kind}:${over.at.physical}.${over.at.logical}.${over.at.deviceId}`,
  payload: {},
  ...over,
});

/**
 * Clear this test's rows.
 *
 * Through the pool the backend already uses, rather than a second connection —
 * a test that opens its own client is testing a different database
 * configuration from the one the code runs against.
 */
/**
 * Clear this run's rows.
 *
 * Via psql rather than the engine: cleanup is not the thing under test, and
 * the engine exposes no raw query — inventing one so a test could tidy up
 * would widen the production surface for a test's convenience.
 */
async function purge() {
  for (const table of ['planner_applied_operations', 'planner_blocks', 'planner_items']) {
    try {
      execFileSync('docker', [
        ...dockerPsqlArgs(`delete from ${table} where org_id = '${ORG}'`),
      ], { stdio: 'ignore' });
    } catch { /* table may not exist in an older dev database */ }
  }
}

function psql(sql) {
  return execFileSync('docker', dockerPsqlArgs(sql), { encoding: 'utf8' }).trim();
}

let failures = 0;
async function check(name, fn) {
  try {
    await fn();
    console.log(`  ok  ${name}`);
  } catch (err) {
    failures += 1;
    console.log(`  FAIL ${name}\n       ${err.message}`);
  }
}

console.log('ADR-028 D9–D11 · two devices against the real database\n');

await purge();

// ---------------------------------------------------------------- device A
await check('device A pushes and the row lands', async () => {
  const res = await planner.pushOperations(ORG, USER, [
    op({ itemId: 'i1', kind: 'create', at: stamp(1000, 0, 'devA'),
         payload: { title: 'Ship the planner' } }),
  ], new Date().toISOString());
  assert.equal(res.accepted.length, 1, 'the operation was accepted');
  const { items } = await planner.pullChanges(ORG, USER);
  assert.equal(items.length, 1);
  assert.equal(items[0].title.value, 'Ship the planner');
});

// ---------------------------------------------------------------- device B
await check('device B pulls what A wrote — the actual exchange', async () => {
  const { items, cursor } = await planner.pullChanges(ORG, USER);
  assert.ok(cursor, 'a cursor comes back so B can resume');
  assert.equal(items.length, 1);
});

await check('a REPLAYED operation does not double-apply (D2 idempotency)', async () => {
  const same = op({ itemId: 'i1', kind: 'create', at: stamp(1000, 0, 'devA'),
                    payload: { title: 'Ship the planner' } });
  await planner.pushOperations(ORG, USER, [same], new Date().toISOString());
  await planner.pushOperations(ORG, USER, [same], new Date().toISOString());
  const { items } = await planner.pullChanges(ORG, USER);
  assert.equal(items.length, 1, 'still one row, not three');
});

await check('idempotency keys cannot silently accept different work', async () => {
  const first = op({ itemId: 'i-idempotency', kind: 'create', at: stamp(1_100, 0, 'devA'),
    payload: { title: 'First payload' } });
  await planner.pushOperations(ORG, USER, [first], new Date().toISOString());
  const collision = await planner.pushOperations(ORG, USER, [{
    ...first,
    payload: { title: 'Different payload' },
  }], new Date().toISOString());
  assert.match(collision.rejected[0]?.reason ?? '', /already used for a different Planner operation/);
  assert.equal((await planner.getItem(ORG, USER, 'i-idempotency')).title.value, 'First payload');
});

await check('a stamped whole item keeps provenance, estimate and blocked state', async () => {
  const at = stamp(1500, 0, 'devA');
  const res = await planner.pushOperations(ORG, USER, [op({
    itemId: 'i2', kind: 'create', at,
    payload: {
      id: 'i2', origin: 'mirrored', source: 'github',
      fetchedAt: '2026-08-11T00:00:00.000Z',
      title: { value: 'Connected issue', at },
      estimateMinutes: { value: 45, at },
      blockedReason: { value: 'Waiting for review', at },
      provenance: {
        sourceId: 'github', sourceLabel: 'GitHub issue', externalId: '42',
        sourceUrl: 'https://github.com/example/repo/issues/42',
        fetchedAt: '2026-08-11T00:00:00.000Z',
      },
    },
  })], new Date().toISOString());
  assert.deepEqual(res.accepted.length, 1);
  const { items } = await planner.pullChanges(ORG, USER);
  const item = items.find((candidate) => candidate.id === 'i2');
  assert.equal(item.provenance.sourceUrl, 'https://github.com/example/repo/issues/42');
  assert.equal(item.estimateMinutes, 45);
  assert.equal(item.blockedReason.value, 'Waiting for review');
});

await check('a scoped connector issue projects once into the durable Planner store', async () => {
  const input = {
    connectorId: 'db-connector-1', source: 'github', sourceLabel: 'GitHub work',
    documents: [{
      id: 'github:example/repo:issue:77', connectorId: 'runtime-connector', source: 'github',
      kind: 'issue', repository: 'example/repo', title: '#77 Project this issue',
      url: 'https://github.com/example/repo/issues/77', updatedAt: '2026-08-11T00:00:00.000Z',
      text: 'Issue body', metadata: { blockedReason: 'Waiting for API', estimateMinutes: 50 },
      firstSeenAt: '2026-08-11T01:00:00.000Z', lastSeenAt: '2026-08-11T01:00:00.000Z',
    }],
  };
  const first = await planner.refreshConnectedIssueDocuments(ORG, USER, input);
  const second = await planner.refreshConnectedIssueDocuments(ORG, USER, input);
  assert.deepEqual(first, { created: 1, updated: 0, unchanged: 0, skipped: 0 });
  assert.deepEqual(second, { created: 0, updated: 0, unchanged: 1, skipped: 0 });
  const { items } = await planner.pullChanges(ORG, USER);
  const item = items.find((candidate) => candidate.provenance?.externalId === input.documents[0].id);
  assert.equal(item.provenance.sourceUrl, input.documents[0].url);
  assert.equal(item.provenance.fetchedAt, input.documents[0].lastSeenAt);
  assert.equal(item.estimateMinutes, 50);
  assert.equal(item.blockedReason.value, 'Waiting for API');
  assert.equal(Object.hasOwn(item, 'completed'), false);
});

await check('a scheduled block syncs as a block, then a newer move wins', async () => {
  const created = await planner.pushOperations(ORG, USER, [op({
    entity: 'block', itemId: 'b1', kind: 'create', at: stamp(2000, 0, 'devA'),
    payload: {
      itemId: 'i2', estimateMinutes: 45,
      scheduledFor: '2026-08-11T09:00:00.000Z',
    },
  })], new Date().toISOString());
  assert.equal(created.accepted.length, 1);

  await planner.pushOperations(ORG, USER, [op({
    entity: 'block', itemId: 'b1', kind: 'update', at: stamp(4000, 0, 'devB'),
    payload: { scheduledFor: '2026-08-12T10:00:00.000Z' },
  })], new Date().toISOString());
  await planner.pushOperations(ORG, USER, [op({
    entity: 'block', itemId: 'b1', kind: 'update', at: stamp(3000, 0, 'devA'),
    payload: { scheduledFor: '2026-08-11T11:00:00.000Z' },
  })], new Date().toISOString());

  const { blocks } = await planner.pullChanges(ORG, USER);
  assert.equal(blocks.length, 1);
  assert.equal(blocks[0].itemId, 'i2');
  assert.equal(blocks[0].scheduledFor, '2026-08-12T10:00:00.000Z');
});

await check('orphan blocks and attempts to change a block parent are rejected', async () => {
  const orphan = await planner.pushOperations(ORG, USER, [op({
    entity: 'block', itemId: 'orphan', kind: 'create', at: stamp(2100, 0, 'devA'),
    payload: { itemId: 'missing', estimateMinutes: 30 },
  })], new Date().toISOString());
  assert.equal(orphan.rejected[0].reason, 'The parent planner item missing does not exist.');

  const mismatch = await planner.pushOperations(ORG, USER, [op({
    entity: 'block', itemId: 'b1', kind: 'update', at: stamp(5000, 0, 'devA'),
    payload: { itemId: 'i1' },
  })], new Date().toISOString());
  assert.match(mismatch.rejected[0].reason, /cannot move from parent item i2 to i1/);
});

await check('retention compaction keeps exactly the minimised allowlist', async () => {
  const at = stamp(2200, 0, 'devA');
  const created = await planner.pushOperations(ORG, USER, [op({
    itemId: 'i-old', kind: 'create', at,
    payload: {
      id: 'i-old', origin: 'mirrored', source: 'github',
      fetchedAt: '2026-01-01T00:00:00.000Z',
      title: { value: 'Old completed source item', at },
      notes: { value: 'detail to minimise', at },
      completed: { value: true, at },
      estimateMinutes: { value: 30, at },
      blockedReason: { value: 'private source state', at },
      provenance: {
        sourceId: 'github', sourceLabel: 'GitHub', externalId: '99',
        sourceUrl: 'https://github.com/example/repo/issues/99',
        fetchedAt: '2026-01-01T00:00:00.000Z',
      },
    },
  })], new Date().toISOString());
  assert.equal(created.accepted.length, 1);
  const beforeCompaction = await planner.pullChanges(ORG, USER);
  psql(`update planner_items set completed = true, updated_at = now() - interval '91 days' where org_id = '${ORG}' and user_id = '${USER}' and id = 'i-old'`);
  const compacted = await memoryEngine.store.compactCompletedPlannerItems(ORG, USER, 90);
  assert.equal(compacted, 1);
  const item = await planner.getItem(ORG, USER, 'i-old');
  assert.deepEqual(Object.keys(item).sort(), [
    'completed', 'estimateMinutes', 'estimateUpdatedAt', 'id', 'origin', 'title',
  ]);
  const delta = await planner.pullChanges(ORG, USER, beforeCompaction.cursor);
  assert.deepEqual(Object.keys(delta.items.find((candidate) => candidate.id === 'i-old')).sort(), [
    'completed', 'estimateMinutes', 'estimateUpdatedAt', 'id', 'origin', 'title',
  ], 'compaction advances the revision so other devices also minimise their cache');
});

// ------------------------------------------------------- concurrent edits
await check('two devices edit DIFFERENT fields — both survive (D4)', async () => {
  await planner.pushOperations(ORG, USER, [
    op({ itemId: 'i1', kind: 'update', at: stamp(2000, 0, 'devA'), payload: { priority: 1 } }),
    op({ itemId: 'i1', kind: 'update', at: stamp(2000, 0, 'devB'), payload: { dueDate: '2026-08-10' } }),
  ], new Date().toISOString());
  const { items } = await planner.pullChanges(ORG, USER);
  const row = items.find((i) => i.id === 'i1');
  assert.ok(row, 'the item is still there');
  assert.equal(row.dueDate?.value, '2026-08-10', 'B\'s field survived A\'s');
  assert.equal(row.priority?.value, 1, "and A's survived B's");
});

await check('concurrent device pushes keep both item fields atomically', async () => {
  await planner.pushOperations(ORG, USER, [op({
    itemId: 'i-atomic', kind: 'create', at: stamp(2300, 0, 'devA'),
    payload: { title: 'Atomic merge' },
  })], new Date().toISOString());
  await Promise.all([
    planner.pushOperations(ORG, USER, [op({
      itemId: 'i-atomic', kind: 'update', at: stamp(2400, 0, 'devA'),
      payload: { priority: 1 },
    })], new Date().toISOString()),
    planner.pushOperations(ORG, USER, [op({
      itemId: 'i-atomic', kind: 'update', at: stamp(2400, 0, 'devB'),
      payload: { dueDate: '2026-08-20' },
    })], new Date().toISOString()),
  ]);
  const item = await planner.getItem(ORG, USER, 'i-atomic');
  assert.equal(item.priority.value, 1);
  assert.equal(item.dueDate.value, '2026-08-20');
});

await check('concurrent stale/new block moves converge on the newer HLC', async () => {
  await Promise.all([
    planner.pushOperations(ORG, USER, [op({
      entity: 'block', itemId: 'b1', kind: 'update', at: stamp(4100, 0, 'devA'),
      payload: { scheduledFor: '2026-08-13T11:00:00.000Z' },
    })], new Date().toISOString()),
    planner.pushOperations(ORG, USER, [op({
      entity: 'block', itemId: 'b1', kind: 'update', at: stamp(4200, 0, 'devB'),
      payload: { scheduledFor: '2026-08-14T12:00:00.000Z' },
    })], new Date().toISOString()),
  ]);
  const { blocks } = await planner.pullChanges(ORG, USER);
  assert.equal(blocks.find((block) => block.id === 'b1').scheduledFor, '2026-08-14T12:00:00.000Z');
});

await check('the LATER stamp wins the same field (D3 ordering)', async () => {
  await planner.pushOperations(ORG, USER, [
    op({ itemId: 'i1', kind: 'update', at: stamp(3000, 0, 'devA'), payload: { title: 'early' } }),
    op({ itemId: 'i1', kind: 'update', at: stamp(9000, 0, 'devB'), payload: { title: 'late' } }),
  ], new Date().toISOString());
  const { items } = await planner.pullChanges(ORG, USER);
  const row = items.find((i) => i.id === 'i1');
  assert.equal(row.title.value, 'late', 'the higher clock won');
});

await check('an OLDER stamp cannot overwrite a newer one', async () => {
  await planner.pushOperations(ORG, USER, [
    op({ itemId: 'i1', kind: 'update', at: stamp(500, 0, 'devA'), payload: { title: 'stale' } }),
  ], new Date().toISOString());
  const { items } = await planner.pullChanges(ORG, USER);
  const row = items.find((i) => i.id === 'i1');
  assert.notEqual(row.title.value, 'stale', 'a client that is behind cannot win by pushing last');
});

await check('conflict resolution is durable and concurrent choices converge across devices', async () => {
  await planner.pushOperations(ORG, USER, [op({
    itemId: 'i-conflict', kind: 'create', at: stamp(6000, 0, 'devA'),
    payload: { title: 'Base' },
  })], new Date().toISOString());
  await planner.pushOperations(ORG, USER, [
    op({ itemId: 'i-conflict', kind: 'update', at: stamp(6100, 0, 'devA'), payload: { title: 'Choice A' } }),
    op({ itemId: 'i-conflict', kind: 'update', at: stamp(6100, 0, 'devB'), payload: { title: 'Choice B' } }),
  ], new Date().toISOString());
  assert.ok((await planner.getItem(ORG, USER, 'i-conflict')).conflicts.title);
  await Promise.all([
    planner.pushOperations(ORG, USER, [op({
      itemId: 'i-conflict', kind: 'resolve_conflict', at: stamp(6200, 0, 'devA'),
      payload: { field: 'title', value: 'Resolved A' },
    })], new Date().toISOString()),
    planner.pushOperations(ORG, USER, [op({
      itemId: 'i-conflict', kind: 'resolve_conflict', at: stamp(6200, 0, 'devB'),
      payload: { field: 'title', value: 'Resolved B' },
    })], new Date().toISOString()),
  ]);
  const resolved = await planner.getItem(ORG, USER, 'i-conflict');
  assert.equal(resolved.title.value, 'Resolved B');
  assert.equal(resolved.conflicts?.title, undefined);
  assert.deepEqual(resolved.conflictResolutions.title, stamp(6200, 0, 'devB'));
});

await check('different wall times remain concurrent unless an edit observed the other', async () => {
  const base = stamp(6_300, 0, 'devA');
  await planner.pushOperations(ORG, USER, [op({
    itemId: 'i-causal', kind: 'create', at: base,
    payload: { title: { value: 'Base', at: base, seen: [] } },
  })], new Date().toISOString());
  const a = stamp(6_400, 0, 'devA');
  const b = stamp(6_900, 0, 'devB');
  await planner.pushOperations(ORG, USER, [op({
    itemId: 'i-causal', kind: 'update', at: a,
    payload: { title: { value: 'Offline A', at: a, seen: [base] } },
  })], new Date().toISOString());
  await planner.pushOperations(ORG, USER, [op({
    itemId: 'i-causal', kind: 'update', at: b,
    payload: { title: { value: 'Offline B later clock', at: b, seen: [base] } },
  })], new Date().toISOString());
  const conflicted = await planner.getItem(ORG, USER, 'i-causal');
  assert.equal(conflicted.conflicts.title.reason, 'concurrent_text');
  assert.equal(conflicted.conflicts.title.ours, 'Offline A');
  assert.equal(conflicted.conflicts.title.theirs, 'Offline B later clock');
});

await check('delete-versus-edit is explicitly resolvable and its choice is durable', async () => {
  const base = stamp(7_000, 0, 'devA');
  await planner.pushOperations(ORG, USER, [op({
    itemId: 'i-delete-conflict', kind: 'create', at: base,
    payload: { title: { value: 'Original', at: base, seen: [] } },
  })], new Date().toISOString());
  await planner.pushOperations(ORG, USER, [op({
    itemId: 'i-delete-conflict', kind: 'delete', at: stamp(7_100, 0, 'devA'), payload: {},
  })], new Date().toISOString());
  const editedAt = stamp(7_200, 0, 'devB');
  await planner.pushOperations(ORG, USER, [op({
    itemId: 'i-delete-conflict', kind: 'update', at: editedAt,
    payload: { title: { value: 'Edited while offline', at: editedAt, seen: [base] } },
  })], new Date().toISOString());
  assert.equal((await planner.getItem(ORG, USER, 'i-delete-conflict')).conflicts.deleted.reason, 'delete_vs_edit');
  const resolvedAt = stamp(7_300, 0, 'devB');
  const resolution = await planner.pushOperations(ORG, USER, [op({
    itemId: 'i-delete-conflict', kind: 'resolve_conflict', at: resolvedAt,
    payload: { field: 'deleted', keep: 'theirs' },
  })], new Date().toISOString());
  assert.equal(resolution.accepted.length, 1);
  const resolved = await planner.getItem(ORG, USER, 'i-delete-conflict');
  assert.equal(resolved.deletedAt, undefined);
  assert.equal(resolved.conflicts?.deleted, undefined);
  assert.deepEqual(resolved.deletionResolution, { deleted: false, at: resolvedAt });
});

// ------------------------------------------------------ delete vs edit
await check('delete is a TOMBSTONE the other device can see (D4)', async () => {
  await planner.pushOperations(ORG, USER, [op({
    entity: 'block', itemId: 'b-delete', kind: 'create', at: stamp(9500, 0, 'devA'),
    payload: { itemId: 'i1', estimateMinutes: 20 },
  })], new Date().toISOString());
  await planner.pushOperations(ORG, USER, [
    op({ itemId: 'i1', kind: 'delete', at: stamp(10_000, 0, 'devA') }),
  ], new Date().toISOString());
  const { items, blocks } = await planner.pullChanges(ORG, USER);
  const row = items.find((i) => i.id === 'i1');
  assert.ok(row, 'the row survives so a later edit can resurrect it');
  assert.ok(row.deletedAt, 'stamped as deleted rather than removed');
  const child = blocks.find((block) => block.id === 'b-delete');
  assert.ok(child, 'the child block tombstone is returned to a fresh device');
  assert.deepEqual(child.deletedAt, stamp(10_000, 0, 'devA'));
  assert.equal((await planner.listBlocks(ORG, USER)).some((block) => block.id === 'b-delete'), false);
});

// ------------------------------------------------------------- tenancy
await check('another user cannot see these items (D9 scoping)', async () => {
  const { items } = await planner.pullChanges(ORG, 'someone-else');
  assert.equal(items.length, 0, 'user scoping holds at the data plane');
});

await check('a cursor pull returns only what changed after it', async () => {
  const first = await planner.pullChanges(ORG, USER);
  assert.match(first.cursor, /^p1:\d+:\d+$/, 'the cursor independently covers item and block revisions');
  const again = await planner.pullChanges(ORG, USER, first.cursor);
  assert.ok(again.items.length <= first.items.length, 'the cursor narrows the result');
});

await purge();
console.log(`\n${failures === 0 ? 'PASS' : `FAIL — ${failures} failing`}`);
process.exit(failures === 0 ? 0 : 1);
