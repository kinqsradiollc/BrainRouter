import test from 'node:test';
import assert from 'node:assert/strict';
import { StreamStalledError, readWithStallWatchdog } from '../agent/transport/streamStall.js';
import { isRetryableServerError } from '../storage/checkpointStore.js';
import { classifyRouterFailure } from '../provider/routing/policy.js';

// A stream that goes silent must end the call, not the session. The request
// timeout is cleared at the 200; only the watchdog bounds the body read.

function readerOf(chunks: Array<string | 'HANG'>): { reader: { read(): Promise<{ value?: string; done: boolean }>; cancel(): Promise<void> }; cancelled: () => boolean } {
  let i = 0;
  let cancelled = false;
  return {
    reader: {
      read: () => {
        const next = chunks[i++];
        if (next === undefined) return Promise.resolve({ done: true });
        if (next === 'HANG') return new Promise(() => { /* never resolves */ });
        return Promise.resolve({ value: next, done: false });
      },
      cancel: async () => { cancelled = true; },
    },
    cancelled: () => cancelled,
  };
}

test('a healthy stream is read through untouched', async () => {
  const { reader } = readerOf(['a', 'b']);
  assert.deepEqual(await readWithStallWatchdog(reader, 200, 'test'), { value: 'a', done: false });
  assert.deepEqual(await readWithStallWatchdog(reader, 200, 'test'), { value: 'b', done: false });
  assert.deepEqual(await readWithStallWatchdog(reader, 200, 'test'), { done: true });
});

test('silence past the budget rejects with a stalled error, cancels the reader, and reads as retryable everywhere', async () => {
  const { reader, cancelled } = readerOf(['a', 'HANG']);
  await readWithStallWatchdog(reader, 100, 'matilda.maincode.com');
  const started = Date.now();
  await assert.rejects(() => readWithStallWatchdog(reader, 100, 'matilda.maincode.com'), (e: unknown) => {
    assert.ok(e instanceof StreamStalledError);
    assert.match((e as Error).message, /stalled: no data from matilda\.maincode\.com for 0s/);
    return true;
  });
  assert.ok(Date.now() - started < 2_000, 'the stall is detected promptly');
  assert.equal(cancelled(), true, 'the reader is cancelled so the connection is released');
  const err = new StreamStalledError(60_000, 'x');
  assert.equal(isRetryableServerError(err), true, 'the resilient call wrapper reconnects');
  assert.equal(classifyRouterFailure(err).kind, 'provider_retryable', 'the router treats it as a transient provider failure');
});

test('a non-positive budget disables the watchdog', async () => {
  const { reader } = readerOf(['a']);
  assert.deepEqual(await readWithStallWatchdog(reader, 0, 'test'), { value: 'a', done: false });
});
