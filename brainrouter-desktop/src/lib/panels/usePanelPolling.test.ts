/**
 * DESK-PERF — proves an interval tick cannot pile a second bridge request onto
 * a refresh that is still running; the next tick is allowed after it settles.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createSingleFlightPoller } from './usePanelPolling.js';

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((complete) => { resolve = complete; });
  return { promise, resolve };
}

test('starts only one refresh while the previous panel poll is unresolved', async () => {
  const pending = deferred();
  let calls = 0;
  const poller = createSingleFlightPoller(async () => {
    calls += 1;
    await pending.promise;
  });

  const first = poller.run();
  assert.equal(await poller.run(), false, 'A live poll must suppress an overlapping refresh.');
  assert.equal(calls, 1, 'Only the first call reaches the refresh function.');

  pending.resolve();
  assert.equal(await first, true, 'The initial refresh completes normally.');
  assert.equal(await poller.run(), true, 'The next refresh starts after the prior one settles.');
  assert.equal(calls, 2, 'The settled poller accepts the next interval tick.');
});
