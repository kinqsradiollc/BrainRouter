/**
 * ADR-052 P4.5 — the curated picker overlay reorders (pin → declared order →
 * rest), labels, and never invents a model the endpoint didn't return.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { applyModelPickerOverlay } from '../cli/wizard/modelPickerOverlay.js';

const live = ['gpt-5', 'gpt-5-mini', 'o3', 'deepseek-chat', 'haiku-4.5'];

test('an empty overlay is a no-op: every model, label = id, original order', () => {
  assert.deepEqual(applyModelPickerOverlay(live, []), live.map((id) => ({ id, label: id })));
});

test('pinned float to the top, then the declared order, then the rest', () => {
  const out = applyModelPickerOverlay(live, [
    { id: 'o3', label: 'Reasoning (o3)' },
    { id: 'haiku-4.5', pinned: true },
    { id: 'gpt-5', label: 'Flagship' },
  ]);
  assert.deepEqual(out.map((r) => r.id), ['haiku-4.5', 'o3', 'gpt-5', 'gpt-5-mini', 'deepseek-chat']);
  assert.equal(out.find((r) => r.id === 'o3')!.label, 'Reasoning (o3)');
  assert.equal(out.find((r) => r.id === 'gpt-5')!.label, 'Flagship');
  assert.equal(out.find((r) => r.id === 'gpt-5-mini')!.label, 'gpt-5-mini', 'unmentioned rows keep id as label');
});

test('an overlay id the endpoint did not return is dropped (endpoint is the source of truth)', () => {
  const out = applyModelPickerOverlay(live, [{ id: 'ghost-model', pinned: true, label: 'Nope' }]);
  assert.ok(!out.some((r) => r.id === 'ghost-model'), 'a non-existent model is not shown');
  assert.deepEqual(out.map((r) => r.id), live, 'the live list is otherwise unchanged');
});

test('a duplicate overlay entry is de-duplicated', () => {
  const out = applyModelPickerOverlay(live, [{ id: 'o3', pinned: true }, { id: 'o3' }]);
  assert.equal(out.filter((r) => r.id === 'o3').length, 1);
});
