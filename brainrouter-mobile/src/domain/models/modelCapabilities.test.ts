import { test } from 'node:test';
import assert from 'node:assert/strict';
import { modelCapabilities, isNonChatModel, capabilityBadges } from './modelCapabilities.js';

test('isNonChatModel: embeddings / rerank / audio-codec ids are non-chat', () => {
  for (const id of ['text-embedding-3-large', 'nomic-embed-text', 'bge-reranker', 'whisper-large-v3']) {
    assert.equal(isNonChatModel(id), true, id);
  }
  for (const id of ['gpt-5.3-codex', 'claude-opus-4-8', 'qwen3-coder-32b']) {
    assert.equal(isNonChatModel(id), false, id);
  }
});

test('modelCapabilities: whisper is audio-only (no chat/tools)', () => {
  const c = modelCapabilities('whisper-large-v3');
  assert.deepEqual(
    { text: c.text, audio: c.audio, toolUse: c.toolUse, reasoning: c.reasoning },
    { text: false, audio: true, toolUse: false, reasoning: false },
  );
});

test('modelCapabilities: embedding model has no chat capability', () => {
  const c = modelCapabilities('text-embedding-nomic-embed-text-v1.5');
  assert.equal(c.text, false);
  assert.equal(c.toolUse, false);
});

test('modelCapabilities: a codex model is reasoning + tool-use', () => {
  const c = modelCapabilities('gpt-5.3-codex');
  assert.equal(c.reasoning, true);
  assert.equal(c.toolUse, true);
  assert.equal(c.text, true);
});

test('modelCapabilities: opus is vision + premium + large context', () => {
  const c = modelCapabilities('claude-opus-4-8');
  assert.equal(c.vision, true);
  assert.equal(c.contextK, 200);
  assert.equal(c.costNote, 'premium');
});

test('modelCapabilities: a local qwen is low-cost text+tools', () => {
  const c = modelCapabilities('qwen3-coder-32b');
  assert.equal(c.text, true);
  assert.equal(c.toolUse, true);
  assert.equal(c.costNote, 'local / low cost');
});

test('modelCapabilities: unknown id falls back to plain text + tool-use chat', () => {
  const c = modelCapabilities('some-unknown-model-v9');
  assert.deepEqual(
    { text: c.text, toolUse: c.toolUse, reasoning: c.reasoning, vision: c.vision, audio: c.audio },
    { text: true, toolUse: true, reasoning: false, vision: false, audio: false },
  );
});

test('capabilityBadges: renders the set flags in a stable order', () => {
  const badges = capabilityBadges(modelCapabilities('gpt-5.3-codex'));
  const keys = badges.map((b) => b.key);
  assert.ok(keys.includes('reasoning'));
  assert.ok(keys.includes('tools'));
  // reasoning sorts before tools/ctx/cost
  assert.ok(keys.indexOf('reasoning') < keys.indexOf('tools'));
});
