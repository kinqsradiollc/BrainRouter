import assert from 'node:assert/strict';
import test from 'node:test';

import { createSerialWorkQueue, desktopPlannerScope } from './queries.js';

test('Planner store work stays serialized across network waits and queue failures', async () => {
  const run = createSerialWorkQueue();
  const lifecycle: string[] = [];
  let releaseFirst!: () => void;
  const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve; });

  const first = run(async () => {
    lifecycle.push('sync-read-A');
    await firstGate;
    lifecycle.push('sync-write-A');
  });
  const second = run(() => { lifecycle.push('local-write-B'); });
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.deepEqual(lifecycle, ['sync-read-A']);

  releaseFirst();
  await Promise.all([first, second]);
  assert.deepEqual(lifecycle, ['sync-read-A', 'sync-write-A', 'local-write-B']);

  await assert.rejects(run(() => { throw new Error('expected'); }), /expected/);
  await run(() => { lifecycle.push('after-failure'); });
  assert.equal(lifecycle.at(-1), 'after-failure');
});

test('Planner cache scope changes with account and active organization without exposing ids', () => {
  const local = desktopPlannerScope({});
  const first = desktopPlannerScope({
    cli: { account: { userId: 'user-a', orgId: 'org-a', url: 'https://brain.example' } },
  });
  const otherOrg = desktopPlannerScope({
    cli: { account: { userId: 'user-a', orgId: 'org-b', url: 'https://brain.example' } },
  });
  const otherAccount = desktopPlannerScope({
    cli: { account: { userId: 'user-b', orgId: 'org-a', url: 'https://brain.example' } },
  });

  assert.deepEqual(local, { storeId: 'local', signedIn: false, orgId: null });
  assert.equal(first.orgId, 'org-a');
  assert.notEqual(first.storeId, otherOrg.storeId);
  assert.notEqual(first.storeId, otherAccount.storeId);
  assert.doesNotMatch(first.storeId, /user-a|org-a/);
});

test('legacy API-key profiles are independently partitioned without retaining credentials', () => {
  const first = desktopPlannerScope({
    servers: { brainrouter: { identity: 'brainrouter', url: 'https://brain.example', apiKey: 'secret-a' } },
  });
  const second = desktopPlannerScope({
    servers: { brainrouter: { identity: 'brainrouter', url: 'https://brain.example', apiKey: 'secret-b' } },
  });

  assert.equal(first.signedIn, true);
  assert.equal(first.orgId, null);
  assert.notEqual(first.storeId, second.storeId);
  assert.doesNotMatch(first.storeId, /secret/);
});
