import test from 'node:test';
import assert from 'node:assert/strict';
import { isModelNotFoundError, nextFallbackModel, shouldFallbackModel } from '../provider/modelFallback.js';

test('PARITY-E3 isModelNotFoundError: matches model-not-found shapes', () => {
  assert.equal(isModelNotFoundError('The model `gpt-9` does not exist'), true);
  assert.equal(isModelNotFoundError('model_not_found'), true);
  assert.equal(isModelNotFoundError('Unknown model: foo'), true);
  assert.equal(isModelNotFoundError('invalid model'), true);
  assert.equal(isModelNotFoundError('404 - model not available'), true);
  assert.equal(isModelNotFoundError('model gpt-x is not available'), true);
});

test('PARITY-E3 isModelNotFoundError: ignores transient/other errors', () => {
  assert.equal(isModelNotFoundError('429 rate limit exceeded'), false);
  assert.equal(isModelNotFoundError('ECONNRESET socket hang up'), false);
  assert.equal(isModelNotFoundError('401 invalid api key'), false);
  assert.equal(isModelNotFoundError('context length exceeded'), false);
  assert.equal(isModelNotFoundError('404 not found'), false); // 404 without "model" → not a model error
});

test('PARITY-E3 shouldFallbackModel: fallback set, differs, not yet tried', () => {
  assert.equal(shouldFallbackModel('gpt-9', 'gpt-4o', false), true);
  assert.equal(shouldFallbackModel('gpt-9', 'gpt-4o', true), false); // already tried → no loop
  assert.equal(shouldFallbackModel('gpt-4o', 'gpt-4o', false), false); // same model
  assert.equal(shouldFallbackModel('gpt-9', '', false), false); // no fallback configured
  assert.equal(shouldFallbackModel('gpt-9', null, false), false);
  assert.equal(shouldFallbackModel('gpt-9', '  ', false), false); // blank
});

test('CC-CONFIG-A2 nextFallbackModel: walks the chain in order, skipping current + tried', () => {
  // First candidate (chain order preserved).
  assert.equal(nextFallbackModel('primary', ['a', 'b', 'c'], new Set(['primary'])), 'a');
  // 'a' already tried → next is 'b'.
  assert.equal(nextFallbackModel('primary', ['a', 'b', 'c'], new Set(['primary', 'a'])), 'b');
  // a + b tried → 'c'.
  assert.equal(nextFallbackModel('primary', ['a', 'b', 'c'], new Set(['primary', 'a', 'b'])), 'c');
  // Whole chain exhausted → null.
  assert.equal(nextFallbackModel('primary', ['a', 'b', 'c'], new Set(['primary', 'a', 'b', 'c'])), null);
});

test('CC-CONFIG-A2 nextFallbackModel: never returns the current model, blanks, or empties', () => {
  assert.equal(nextFallbackModel('a', ['a', 'b'], new Set()), 'b'); // skips current 'a'
  assert.equal(nextFallbackModel('x', ['  ', '', 'y'], new Set()), 'y'); // trims + skips blanks
  assert.equal(nextFallbackModel('x', [], new Set()), null); // empty chain
  assert.equal(nextFallbackModel('x', undefined, new Set()), null); // absent chain
});
