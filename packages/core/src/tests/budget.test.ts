import test from 'node:test';
import assert from 'node:assert/strict';
import {
  BudgetExceededError,
  enforceTaskBudget,
  taskUsageTokens,
  taskUsageUsd,
} from '../provider/budget.js';
import { resolveCliKnobs } from '../config/config.js';

test('task budget defaults are uncapped', () => {
  const knobs = resolveCliKnobs({ activeServer: '', servers: {}, cli: {} }).budget;
  assert.deepEqual(knobs, { maxPerTaskUSD: 0, maxPerTaskTokens: 0 });
  assert.doesNotThrow(() => {
    enforceTaskBudget({
      caps: knobs,
      modelId: 'gpt-5',
      usage: { promptTokens: 1_000_000, completionTokens: 1_000_000 },
    });
  });
});

test('task budget enforces token caps at the cap', () => {
  assert.throws(
    () => enforceTaskBudget({
      caps: { maxPerTaskUSD: 0, maxPerTaskTokens: 12 },
      modelId: 'gpt-5',
      usage: { promptTokens: 10, completionTokens: 2 },
    }),
    (err) => err instanceof BudgetExceededError && err.budget.classification === 'budget_exceeded' && err.budget.spentTokens === 12,
  );
});

test('task budget estimates USD from shipped model pricing', () => {
  const usd = taskUsageUsd('gpt-5', { promptTokens: 1_000_000, completionTokens: 1_000_000 });
  assert.equal(usd > 0, true);
  assert.equal(taskUsageTokens({ promptTokens: 10.8, completionTokens: 5.2 }), 16);
});
