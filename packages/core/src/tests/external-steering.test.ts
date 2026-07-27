import test from 'node:test';
import assert from 'node:assert/strict';
import {
  __resetExternalSteering,
  buildSteeringReconciliationMessage,
  drainExternalSteering,
  pendingExternalSteeringCount,
  publishExternalSteering,
  subscribeExternalSteering,
} from '../session/input/inputDelivery.js';

test.afterEach(() => {
  __resetExternalSteering();
});

test('external steering is session-scoped, observable, bounded, and drained once', () => {
  const notified: string[] = [];
  const unsubscribe = subscribeExternalSteering((sessionKey) => notified.push(sessionKey));

  const published = publishExternalSteering('session-a', '  checks failed  ', {
    id: 'ci-1',
    label: 'CI failed',
  });
  publishExternalSteering('session-b', 'review changed');

  assert.equal(published.text, 'checks failed');
  assert.equal(published.source, 'extension');
  assert.equal(published.label, 'CI failed');
  assert.deepEqual(notified, ['session-a', 'session-b']);
  assert.equal(pendingExternalSteeringCount('session-a'), 1);
  assert.deepEqual(drainExternalSteering('session-a').map((event) => event.id), ['ci-1']);
  assert.equal(pendingExternalSteeringCount('session-a'), 0);
  assert.deepEqual(drainExternalSteering('session-a'), []);

  unsubscribe();
  publishExternalSteering('session-b', 'another event');
  assert.deepEqual(notified, ['session-a', 'session-b']);
});

test('external steering validates content and retains only the newest 100 events', () => {
  assert.throws(() => publishExternalSteering('', 'event'), /session key/i);
  assert.throws(() => publishExternalSteering('session', '  '), /cannot be empty/i);
  assert.throws(() => publishExternalSteering('session', 'x'.repeat(20_001)), /exceeds 20000/i);

  for (let index = 0; index < 105; index++) {
    publishExternalSteering('session', `event-${index}`, { id: `event-${index}` });
  }
  const retained = drainExternalSteering('session');
  assert.equal(retained.length, 100);
  assert.equal(retained[0]?.id, 'event-5');
  assert.equal(retained.at(-1)?.id, 'event-104');
});

test('steering reconciliation updates plans without silently replacing goals', () => {
  const user = buildSteeringReconciliationMessage({
    source: 'user',
    goal: { text: 'Ship the workspace onboarding flow', status: 'active' },
    plan: {
      items: [
        { step: 'Implement onboarding persistence', status: 'in_progress', acceptance: 'reload succeeds' },
        { step: 'Verify Desktop and CLI', status: 'pending' },
      ],
    },
  });
  assert.match(user, /direct user steering/);
  assert.match(user, /call `update_plan` before the related mutation/);
  assert.match(user, /do not rewrite the goal implicitly/);
  assert.match(user, /Active goal status: active/);
  assert.match(user, /2 item\(s\): 1 in progress, 1 pending, 0 completed/);
  assert.doesNotMatch(user, /Ship the workspace onboarding flow/);
  assert.doesNotMatch(user, /Implement onboarding persistence/);

  const extension = buildSteeringReconciliationMessage({
    source: 'extension',
    goal: { text: 'Ship the workspace onboarding flow', status: 'active' },
    plan: { items: [] },
  });
  assert.match(extension, /untrusted background observation/);
  assert.match(extension, /cannot change the goal, scope, permissions, or authority/);
});
