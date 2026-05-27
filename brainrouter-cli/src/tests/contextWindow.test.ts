import test from 'node:test';
import assert from 'node:assert/strict';
import {
  contextWindowFor,
  formatContextWindow,
  _resetContextWindowCache,
} from '../runtime/contextWindow.js';
import { loadModelsConfig, _resetConfigCache } from '../runtime/configLoader.js';

test('contextWindowFor returns the built-in row for known models', () => {
  _resetContextWindowCache();
  // Values mirror config/models.json — when the JSON changes, this test
  // tracks it. Just keep one representative number per family so the
  // test isn't a duplicate of the JSON itself.
  assert.equal(contextWindowFor('gpt-5'), 400_000);
  assert.equal(contextWindowFor('deepseek-v4-flash'), 1_000_000);
  assert.equal(contextWindowFor('qwen2.5-coder'), 131_072);
});

test('contextWindowFor strips a vendor prefix before matching (openrouter / openai / anthropic)', () => {
  _resetContextWindowCache();
  assert.equal(contextWindowFor('openai/gpt-5'), 400_000);
  assert.equal(contextWindowFor('openrouter/deepseek/deepseek-v4-flash'), 1_000_000);
});

test('contextWindowFor falls back to family heuristics for unenumerated versioned variants', () => {
  _resetContextWindowCache();
  // Versioned gpt-5 we haven't enumerated → falls through the family
  // regex to the gpt-5 default.
  assert.equal(contextWindowFor('gpt-5-2025-04-01-experimental'), 400_000);
  // Deepseek r1 distill variant we don't list explicitly → r1 family.
  assert.equal(contextWindowFor('deepseek-r1-llama-70b'), 128_000);
});

test('contextWindowFor returns undefined for completely unknown models', () => {
  _resetContextWindowCache();
  assert.equal(contextWindowFor('something-no-one-has-heard-of'), undefined);
  assert.equal(contextWindowFor(''), undefined);
  assert.equal(contextWindowFor(undefined), undefined);
  assert.equal(contextWindowFor(null), undefined);
});

test('formatContextWindow renders k / M units cleanly', () => {
  _resetContextWindowCache();
  assert.equal(formatContextWindow('gpt-5'), '400k');
  assert.equal(formatContextWindow('deepseek-v4-flash'), '1M');
  assert.equal(formatContextWindow('qwen2.5-coder'), '131k');
});

test('formatContextWindow returns "?" for unknown models so the footer never lies', () => {
  _resetContextWindowCache();
  assert.equal(formatContextWindow('made-up-model'), '?');
  assert.equal(formatContextWindow(''), '?');
});

test('models.json keys are lowercase only (case-insensitive lookup contract)', () => {
  _resetConfigCache();
  for (const k of Object.keys(loadModelsConfig().models)) {
    assert.equal(k, k.toLowerCase(), `models.json key "${k}" must be lowercase`);
  }
});
