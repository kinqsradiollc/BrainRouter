import test from 'node:test';
import assert from 'node:assert/strict';
import { shouldAutoExtractSkill, buildSessionSummary } from '../runtime/autoSkill.js';

test('MEM-33b shouldAutoExtractSkill: needs enabled + enough tool calls + a substantive answer', () => {
  const big = 'x'.repeat(60);
  assert.equal(shouldAutoExtractSkill({ enabled: true, toolCalls: 4, answerLength: big.length }), true);
  assert.equal(shouldAutoExtractSkill({ enabled: false, toolCalls: 4, answerLength: big.length }), false); // off
  assert.equal(shouldAutoExtractSkill({ enabled: true, toolCalls: 1, answerLength: big.length }), false); // too few steps
  assert.equal(shouldAutoExtractSkill({ enabled: true, toolCalls: 4, answerLength: 10 }), false); // trivial answer
  assert.equal(shouldAutoExtractSkill({ enabled: true, toolCalls: 2, answerLength: big.length, minToolCalls: 2 }), true); // override
});

test('MEM-33b buildSessionSummary: compact task + tool count + outcome (bounded)', () => {
  const s = buildSessionSummary('  Fix   the flaky test ', 'Found a race and added a barrier; 100 runs green.', 5);
  assert.match(s, /Task: Fix the flaky test/);
  assert.match(s, /Tool calls: 5/);
  assert.match(s, /Outcome: Found a race/);
  // bounded
  const long = buildSessionSummary('p'.repeat(900), 'a'.repeat(3000), 9);
  assert.ok(long.length < 2200);
});
