import test from 'node:test';
import assert from 'node:assert/strict';
import {
  resolveToolBudget,
  isBudgetCheckpoint,
  buildBudgetCheckpoint,
  buildBudgetCeilingMessage,
  MAX_BUDGET_EXTENSIONS,
} from '../agent/turnBudget.js';

test('resolveToolBudget: window floors at 5, hard ceiling is a bounded multiple', () => {
  assert.deepEqual(resolveToolBudget(250), { window: 250, hardCeiling: 250 * (MAX_BUDGET_EXTENSIONS + 1) });
  assert.deepEqual(resolveToolBudget(150), { window: 150, hardCeiling: 150 * (MAX_BUDGET_EXTENSIONS + 1) });
  // Tiny / zero caps still make progress (floor 5).
  assert.deepEqual(resolveToolBudget(1), { window: 5, hardCeiling: 30 });
  assert.deepEqual(resolveToolBudget(0), { window: 5, hardCeiling: 30 });
});

test('isBudgetCheckpoint: fires once per window boundary, never before, never past the extension cap', () => {
  const w = 5;
  // Not on iteration 1..5 (no full window completed at the top of those iterations).
  for (let lc = 1; lc <= 5; lc++) assert.equal(isBudgetCheckpoint(lc, w, 0), false, `lc=${lc}`);
  // Fires at the start of iteration 6 (5 completed), 11 (10), 16, 21, 26.
  for (const lc of [6, 11, 16, 21, 26]) assert.equal(isBudgetCheckpoint(lc, w, 0), true, `lc=${lc}`);
  // NOT on the in-between iterations.
  for (const lc of [7, 8, 12, 17, 23]) assert.equal(isBudgetCheckpoint(lc, w, 0), false, `lc=${lc}`);
  // Once the extension cap is reached, no more checkpoints (hard ceiling takes over).
  assert.equal(isBudgetCheckpoint(6, w, MAX_BUDGET_EXTENSIONS), false);
});

test('buildBudgetCheckpoint: hands the continue/stop decision to the model with the counts', () => {
  const msg = buildBudgetCheckpoint(250, 1250);
  assert.match(msg, /250 tool calls/);
  assert.match(msg, /1250 more tool calls/);
  assert.match(msg, /COMPLETE final answer/);
  assert.match(msg, /keep going/);
  assert.match(msg, /your call/i);
});

test('buildBudgetCeilingMessage: names the ceiling and stays greppable as a budget stop', () => {
  const msg = buildBudgetCeilingMessage(1500);
  assert.match(msg, /1500/);
  assert.match(msg, /tool-call budget/);
  assert.match(msg, /\/continue/);
});
