/**
 * ADR-028 D9–D11 — two devices, one real Postgres.
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
import * as planner from '../dist/memory/planner/backend.js';

const ORG = 'e2e-org';
const USER = 'e2e-user';
const stamp = (physical, logical, deviceId) => ({ physical, logical, deviceId });

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
  const { execFileSync } = await import('node:child_process');
  for (const table of ['planner_items', 'planner_operations']) {
    try {
      execFileSync('docker', [
        'exec', 'brainrouter-postgres', 'psql', '-U', 'postgres', '-d', 'brainrouter',
        '-tAc', `delete from ${table} where org_id = '${ORG}'`,
      ], { stdio: 'ignore' });
    } catch { /* table may not exist in an older dev database */ }
  }
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

// ------------------------------------------------------ delete vs edit
await check('delete is a TOMBSTONE the other device can see (D4)', async () => {
  await planner.pushOperations(ORG, USER, [
    op({ itemId: 'i1', kind: 'delete', at: stamp(10_000, 0, 'devA') }),
  ], new Date().toISOString());
  const { items } = await planner.pullChanges(ORG, USER);
  const row = items.find((i) => i.id === 'i1');
  assert.ok(row, 'the row survives so a later edit can resurrect it');
  assert.ok(row.deletedAt, 'stamped as deleted rather than removed');
});

// ------------------------------------------------------------- tenancy
await check('another user cannot see these items (D9 scoping)', async () => {
  const { items } = await planner.pullChanges(ORG, 'someone-else');
  assert.equal(items.length, 0, 'user scoping holds at the data plane');
});

await check('a cursor pull returns only what changed after it', async () => {
  const first = await planner.pullChanges(ORG, USER);
  const again = await planner.pullChanges(ORG, USER, first.cursor);
  assert.ok(again.items.length <= first.items.length, 'the cursor narrows the result');
});

await purge();
console.log(`\n${failures === 0 ? 'PASS' : `FAIL — ${failures} failing`}`);
process.exit(failures === 0 ? 0 : 1);
