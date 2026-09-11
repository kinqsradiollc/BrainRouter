/**
 * ADR-056 D-B5 — the live-variants desktop model: cycling wraps both ways, the
 * cycler drives the wrapper we just made (else the newest), a wrapper reads as
 * "original" or "variant k of N", and the form gates only on the count.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { stepVariantIndex, activeWrapper, cyclerLabel, variantFormError, describeVariantCount, type LiveVariantScanEntry } from './liveVariants.js';

const A: LiveVariantScanEntry = { id: 'hero-1', action: 'bolder', count: 4, active: 1 };
const B: LiveVariantScanEntry = { id: 'cta-2', action: 'quieter', count: 3, active: 0 };

test('B5 stepVariantIndex wraps forward and back within the child count', () => {
  assert.equal(stepVariantIndex(0, 4, 1), 1);
  assert.equal(stepVariantIndex(3, 4, 1), 0);
  assert.equal(stepVariantIndex(0, 4, -1), 3);
  assert.equal(stepVariantIndex(2, 4, -1), 1);
  assert.equal(stepVariantIndex(0, 0, 1), 0); // nothing to cycle
});

test('B5 activeWrapper prefers the created session, falls back to the newest, and is null when empty', () => {
  assert.equal(activeWrapper([A, B], 'cta-2'), B);
  assert.equal(activeWrapper([A, B], 'gone'), B, 'a stale preferred id falls back to the newest wrapper');
  assert.equal(activeWrapper([A, B], null), B);
  assert.equal(activeWrapper([], 'hero-1'), null);
});

test('B5 cyclerLabel names the original and each variant, with the action when it is not the generic one', () => {
  assert.equal(cyclerLabel({ ...A, active: 0 }), 'original · bolder');
  assert.equal(cyclerLabel({ ...A, active: 2 }), 'variant 2 of 3 · bolder');
  assert.equal(cyclerLabel({ id: 'x', action: 'variant', count: 3, active: 1 }), 'variant 1 of 2');
});

test('B5 the form gates only on the count; an empty action is allowed (it defaults)', () => {
  assert.equal(variantFormError(3), '');
  assert.equal(variantFormError(1), '');
  assert.equal(variantFormError(6), '');
  assert.match(variantFormError(0), /between 1 and 6/);
  assert.match(variantFormError(7), /between 1 and 6/);
  assert.equal(describeVariantCount(3), '3 variants');
  assert.equal(describeVariantCount(1), '1 variant');
});
