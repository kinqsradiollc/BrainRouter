/**
 * ADR-052 P1a — streamWithContinuation drives a streamed response across a
 * retryable mid-stream cut (partial replayed as a prefill), and never turns a
 * fatal/non-retryable failure or a user abort into a silent truncation.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { streamWithContinuation, buildContinuationMessages } from '../agent/transport/streamContinuation.js';
import type { StreamChunk } from '../agent/transport/providerStream.js';

const done = (content: string): StreamChunk => ({ type: 'done', result: { content } as any });
const text = (delta: string): StreamChunk => ({ type: 'text', delta });

class CutError extends Error { constructor() { super('ECONNRESET'); } }

test('buildContinuationMessages appends the partial as an assistant prefill (empty ⇒ unchanged)', () => {
  const msgs = [{ role: 'user', content: 'hi' }];
  assert.deepEqual(buildContinuationMessages(msgs, 'partial…'), [{ role: 'user', content: 'hi' }, { role: 'assistant', content: 'partial…' }]);
  assert.deepEqual(buildContinuationMessages(msgs, ''), msgs);
});

test('a retryable mid-stream cut is continued; the final content is the full stitched text', async () => {
  const deltas: string[] = [];
  let attempt = 0;
  const seeds: (string | null)[] = [];
  const result = await streamWithContinuation({
    run: (seed) => {
      seeds.push(seed);
      attempt += 1;
      return (async function* () {
        if (attempt === 1) { yield text('Hello, '); yield text('wor'); throw new CutError(); }
        yield text('ld!'); yield done('ld!'); // continuation stream returns only its own content
      })();
    },
    isRetryable: (e) => e instanceof CutError,
    onText: (d) => deltas.push(d),
  });
  assert.equal(result.result.content, 'Hello, world!', 'content is stitched across the cut');
  assert.deepEqual(deltas, ['Hello, ', 'wor', 'ld!'], 'each delta is delivered once, in order');
  assert.deepEqual(seeds, [null, 'Hello, wor'], 'the retry continues from the partial text');
});

test('a NON-retryable cut is rethrown (never a silent truncation)', async () => {
  await assert.rejects(
    streamWithContinuation({
      run: () => (async function* () { yield text('partial'); throw new Error('fatal: bad request'); })(),
      isRetryable: () => false,
    }),
    /fatal: bad request/,
  );
});

test('a cut before any text arrived is rethrown (nothing to continue from)', async () => {
  await assert.rejects(
    streamWithContinuation({
      run: () => (async function* () { throw new CutError(); })(),
      isRetryable: (e) => e instanceof CutError,
    }),
    /ECONNRESET/,
  );
});

test('the continuation budget is bounded — a stream that keeps cutting eventually fails', async () => {
  let attempt = 0;
  await assert.rejects(
    streamWithContinuation({
      maxContinuations: 2,
      run: () => (async function* () { attempt += 1; yield text(`x${attempt}`); throw new CutError(); })(),
      isRetryable: (e) => e instanceof CutError,
    }),
    /ECONNRESET/,
  );
  assert.equal(attempt, 3, 'the first attempt + 2 continuations, then it gives up');
});

test('a clean single stream returns its result unchanged', async () => {
  const result = await streamWithContinuation({
    run: () => (async function* () { yield text('all good'); yield done('all good'); })(),
    isRetryable: () => false,
  });
  assert.equal(result.result.content, 'all good');
});
