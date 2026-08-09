/** ADR-032 D1 — renderer form lifecycle stays explicit and provenance-free. */
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  humanCorrectionDraftState,
  HUMAN_CORRECTION_LIMITS,
  type HumanCorrectionDraft,
} from './humanCorrectionDraft.js';

const valid: HumanCorrectionDraft = {
  statement: 'Run the focused tenant test before reporting this change complete.',
  falsifier: 'The test does not exercise the changed tenant boundary.',
  expectation: 'Tenant regressions are caught before handoff.',
};

test('the explicit form trims and emits only correction, falsifier, and expectation', () => {
  const state = humanCorrectionDraftState({
    statement: `  ${valid.statement}  `,
    falsifier: ` ${valid.falsifier} `,
    expectation: ` ${valid.expectation} `,
  });
  assert.equal(state.ready, true);
  assert.deepEqual(state.fields, valid);
  assert.deepEqual(Object.keys(state.fields).sort(), ['expectation', 'falsifier', 'statement']);
});

test('blank and oversized drafts remain unavailable', () => {
  assert.equal(humanCorrectionDraftState({ ...valid, falsifier: '   ' }).ready, false);
  const oversized = humanCorrectionDraftState({
    ...valid,
    statement: 'x'.repeat(HUMAN_CORRECTION_LIMITS.statement + 1),
  });
  assert.equal(oversized.ready, false);
  assert.match(oversized.error ?? '', /statement must be at most 400 characters/);
});
