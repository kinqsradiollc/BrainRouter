import { test } from 'node:test';
import assert from 'node:assert/strict';
import { modelFamily } from './modelFamily.js';

test('modelFamily: detects the major brand families from a model id', () => {
  assert.equal(modelFamily('claude-opus-4-8'), 'claude');
  assert.equal(modelFamily('gpt-5.3-codex'), 'openai');
  assert.equal(modelFamily('gemini-2.5-pro'), 'gemini');
  assert.equal(modelFamily('deepseek-reasoner'), 'deepseek');
  assert.equal(modelFamily('z-ai/glm-4.6'), 'chatglm');
  assert.equal(modelFamily('qwen3-30b-a3b'), 'qwen');
  assert.equal(modelFamily('grok-4'), 'grok');
});

test('modelFamily: a vendor-prefixed id still matches the bare family', () => {
  assert.equal(modelFamily('openai/gpt-oss-20b'), 'openai');
});

test('modelFamily: an unrecognized id returns null', () => {
  assert.equal(modelFamily('some-random-model-v9'), null);
});
