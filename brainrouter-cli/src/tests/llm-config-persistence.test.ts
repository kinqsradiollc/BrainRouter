/**
 * Regression coverage for the strict base-LLM editor commit boundary.
 * Failed writes must leave both present and absent optional config states exact,
 * so callers can safely defer live Agent updates and success output.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import type { Config, LLMConfig } from '@kinqs/brainrouter-core/config';
import { persistLlmConfig } from '../cli/commands/config/llmPersistence.js';

const replacement: LLMConfig = {
  provider: 'openai',
  apiKey: 'replacement-secret',
  model: 'replacement-model',
  endpoint: 'https://replacement.example.com/v1',
};

test('LLM editor persistence restores the exact previous config when the strict write fails', () => {
  const previous: LLMConfig = {
    provider: 'local',
    apiKey: 'previous-secret',
    model: 'previous-model',
    endpoint: 'http://127.0.0.1:1234/v1',
  };
  const config: Config = { activeServer: '', servers: {}, llm: previous };
  let writerSawReplacement = false;

  assert.throws(() => persistLlmConfig(config, replacement, (candidate) => {
    writerSawReplacement = candidate.llm === replacement;
    throw new Error('config write denied');
  }), /config write denied/);

  assert.equal(writerSawReplacement, true, 'the strict writer receives the replacement config');
  assert.strictEqual(config.llm, previous, 'rollback restores the exact previous LLM record');
});

test('LLM editor persistence restores an absent optional field and commits before callers continue', () => {
  const config: Config = { activeServer: '', servers: {} };
  const events: string[] = [];

  assert.throws(() => persistLlmConfig(config, replacement, () => {
    events.push('persist');
    throw new Error('disk full');
  }), /disk full/);
  assert.equal(Object.prototype.hasOwnProperty.call(config, 'llm'), false);

  persistLlmConfig(config, replacement, (candidate) => {
    assert.strictEqual(candidate.llm, replacement);
    events.push('persist-success');
  });
  events.push('caller-live-update');

  assert.deepEqual(events, ['persist', 'persist-success', 'caller-live-update']);
  assert.strictEqual(config.llm, replacement);
});
