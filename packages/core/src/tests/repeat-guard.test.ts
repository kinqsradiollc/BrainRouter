import test from 'node:test';
import assert from 'node:assert/strict';
import { isSequenceGuardExempt, DEFAULT_SEQUENCE_GUARD_EXEMPT } from '../agent/repeatGuard.js';

const EXEMPT = new Set(DEFAULT_SEQUENCE_GUARD_EXEMPT);

test('isSequenceGuardExempt: a pure write_file sequence is exempt (10 different files ≠ a loop)', () => {
  assert.equal(isSequenceGuardExempt(['write_file'], EXEMPT), true);
  assert.equal(isSequenceGuardExempt(['edit_file'], EXEMPT), true);
  assert.equal(isSequenceGuardExempt(['write_file', 'edit_file', 'apply_patch'], EXEMPT), true);
});

test('isSequenceGuardExempt: a sequence with any non-exempt tool still guards', () => {
  assert.equal(isSequenceGuardExempt(['run_command'], EXEMPT), false);
  assert.equal(isSequenceGuardExempt(['read_file'], EXEMPT), false);
  // mixed: one read among writes → NOT exempt (could be a read/grep thrash pattern)
  assert.equal(isSequenceGuardExempt(['write_file', 'read_file'], EXEMPT), false);
});

test('isSequenceGuardExempt: empty sequence is not exempt (nothing to skip)', () => {
  assert.equal(isSequenceGuardExempt([], EXEMPT), false);
});

test('isSequenceGuardExempt: respects a custom exempt set', () => {
  assert.equal(isSequenceGuardExempt(['run_command'], new Set(['run_command'])), true);
  assert.equal(isSequenceGuardExempt(['write_file'], new Set(['run_command'])), false);
});
