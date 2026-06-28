// Unit tests for the composer's session-control labels + option sets (Model /
// Mode / Effort) — the pure layer behind the now-interactive pills.
import test from 'node:test';
import assert from 'node:assert/strict';
import { modeLabel, modelLabel, modelOptions, normalizeModels, MODE_OPTIONS, EFFORT_OPTIONS } from './sessionControls.js';

test('normalizeModels handles the host string-array shape AND the {id,label} shape', () => {
  assert.deepEqual(normalizeModels(['Qwen3.5-9B-Q4_K_M.gguf']), [{ id: 'Qwen3.5-9B-Q4_K_M.gguf', label: 'Qwen3.5-9B' }]);
  assert.deepEqual(normalizeModels([{ id: 'claude-opus-4-8', label: 'Claude Opus 4.8' }]), [{ id: 'claude-opus-4-8', label: 'Claude Opus 4.8' }]);
  assert.deepEqual(normalizeModels([{ id: 'x' }]), [{ id: 'x', label: 'x' }]); // label backfilled
  assert.deepEqual(normalizeModels(undefined), []);
});

test('modeLabel maps executionMode + reviewPolicy to the desktop labels', () => {
  assert.equal(modeLabel('planning', 'request'), 'Plan');
  assert.equal(modeLabel('fast', 'proceed'), 'Auto');
  assert.equal(modeLabel('fast', 'request'), 'Accept edits');
  assert.equal(modeLabel(undefined, undefined), 'Accept edits'); // safe default
});

test('modelLabel cleans a local gguf id down to the model name', () => {
  assert.equal(modelLabel('Qwen3.5-9B-Q4_K_M.gguf'), 'Qwen3.5-9B');
});

test('modelLabel prettifies a claude id and handles empty', () => {
  assert.equal(modelLabel('claude-opus-4-8'), 'Opus 4.8');
  assert.equal(modelLabel(undefined), '—');
  assert.equal(modelLabel(''), '—');
});

test('modelOptions surfaces the current LOCAL model when list-models omits it (Qwen)', () => {
  assert.deepEqual(modelOptions([], 'Qwen3.5-9B-Q4_K_M.gguf'), [{ id: 'Qwen3.5-9B-Q4_K_M.gguf', label: 'Qwen3.5-9B' }]);
});

test('modelOptions returns the list unchanged when the current model is present or missing', () => {
  const list = [{ id: 'claude-opus-4-8', label: 'Claude Opus 4.8' }];
  assert.equal(modelOptions(list, 'claude-opus-4-8'), list);
  assert.equal(modelOptions(list, undefined), list);
});

test('MODE_OPTIONS are the three real modes with correct exec/review combos', () => {
  assert.deepEqual(
    MODE_OPTIONS.map((m) => [m.key, m.executionMode, m.reviewPolicy]),
    [
      ['plan', 'planning', 'request'],
      ['auto', 'fast', 'proceed'],
      ['accept', 'fast', 'request'],
    ],
  );
});

test('EFFORT_OPTIONS are the four host effort levels', () => {
  assert.deepEqual(EFFORT_OPTIONS.map((e) => e.key), ['low', 'medium', 'high', 'xhigh']);
});
