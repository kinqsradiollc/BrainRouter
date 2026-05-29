import test from 'node:test';
import assert from 'node:assert/strict';
import { isModelNotFoundError, shouldFallbackModel } from '../runtime/modelFallback.js';

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
