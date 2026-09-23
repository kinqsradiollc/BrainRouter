/**
 * ADR-045 M4 — the client honors a gateway-advertised context window.
 *
 * M3 publishes `context_window` on each `/v1/models` row when an org caps the
 * window. This proves the client half: the advertised value is captured and
 * `contextWindowFor` CLAMPS a model to it (the cap only ever tightens), while a
 * plain endpoint that omits the field changes nothing.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  extractAdvertisedContext,
  setManagedModelContext,
  lookupManagedModelContext,
  clearManagedModelContextForTests,
} from '../provider/managedModelContext.js';
import { contextWindowFor } from '../context/contextWindow.js';
import { setCliKnobOverride, _resetCliKnobsCache } from '../config/config.js';

test.afterEach(() => { clearManagedModelContextForTests(); _resetCliKnobsCache(); });

test('extractAdvertisedContext keeps only rows with a positive context_window', () => {
  const out = extractAdvertisedContext([
    { id: 'gpt-5', context_window: 200_000 },
    { id: 'plain', object: 'model' },          // no field → skipped (plain endpoint)
    { id: 'bad', context_window: 0 },           // non-positive → skipped
    { id: 'frac', context_window: 32_000.9 },   // floored
    { context_window: 100 },                    // no id → skipped
  ]);
  assert.deepEqual(out, [
    { id: 'gpt-5', contextWindow: 200_000 },
    { id: 'frac', contextWindow: 32_000 },
  ]);
  assert.deepEqual(extractAdvertisedContext('not an array' as never), []);
});

test('lookupManagedModelContext matches exact + vendor-prefix-stripped, case-insensitively', () => {
  setManagedModelContext([{ id: 'GPT-5', contextWindow: 64_000 }]);
  assert.equal(lookupManagedModelContext('gpt-5'), 64_000);
  assert.equal(lookupManagedModelContext('brainrouter/gpt-5'), 64_000, 'vendor prefix stripped');
  assert.equal(lookupManagedModelContext('unknown'), undefined);
});

test('contextWindowFor clamps a base window to the advertised cap (cap only tightens)', () => {
  // Base from cli.contextWindows = 200k; the gateway caps this model to 32k.
  setCliKnobOverride({ contextWindows: { 'managed-model': 200_000 } });
  setManagedModelContext([{ id: 'managed-model', contextWindow: 32_000 }]);
  assert.equal(contextWindowFor('managed-model'), 32_000, 'min(base, cap)');
});

test('a cap LARGER than the base does not raise the window', () => {
  setCliKnobOverride({ contextWindows: { 'small-model': 16_000 } });
  setManagedModelContext([{ id: 'small-model', contextWindow: 1_000_000 }]);
  assert.equal(contextWindowFor('small-model'), 16_000, 'the smaller base wins');
});

test('with no local base, the advertised cap IS the window (managed model carries none)', () => {
  setManagedModelContext([{ id: 'zzz-managed-only', contextWindow: 48_000 }]);
  assert.equal(contextWindowFor('zzz-managed-only'), 48_000);
});

test('no advertised cap leaves the base window unchanged (byte-neutral)', () => {
  setCliKnobOverride({ contextWindows: { 'zzz-plain': 111_111 } });
  assert.equal(contextWindowFor('zzz-plain'), 111_111);
});
