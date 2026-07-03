import test from 'node:test';
import assert from 'node:assert/strict';
import { isSequenceGuardExempt, DEFAULT_SEQUENCE_GUARD_EXEMPT, buildSequenceSignature } from '../agent/turn/repeatGuard.js';

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

// --- buildSequenceSignature: the args-aware fix for the read→edit→test sweep ---

test('buildSequenceSignature: a read→edit→test sweep over DIFFERENT files does NOT collide', () => {
  const fileA = buildSequenceSignature([
    { name: 'read_file', args: '{"path":"src/a.ts"}' },
    { name: 'edit_file', args: '{"path":"src/a.ts","find":"x","replace":"y"}' },
    { name: 'run_command', args: '{"cmd":"npm test"}' },
  ]);
  const fileB = buildSequenceSignature([
    { name: 'read_file', args: '{"path":"src/b.ts"}' },
    { name: 'edit_file', args: '{"path":"src/b.ts","find":"x","replace":"y"}' },
    { name: 'run_command', args: '{"cmd":"npm test"}' },
  ]);
  // Same tool NAMES, different file args → different signatures → never counted
  // as a repeat. (The old name-only signature collapsed these into one loop.)
  assert.notEqual(fileA, fileB);
});

test('buildSequenceSignature: re-reading 9 DIFFERENT files yields 9 distinct signatures', () => {
  const sigs = new Set(
    Array.from({ length: 9 }, (_v, i) =>
      buildSequenceSignature([{ name: 'read_file', args: `{"path":"f${i}.ts"}` }]),
    ),
  );
  assert.equal(sigs.size, 9, 'each distinct file must hash to its own signature');
});

test('buildSequenceSignature: an IDENTICAL batch still collides (real loop preserved)', () => {
  const a = buildSequenceSignature([{ name: 'read_file', args: '{"path":"a.ts"}' }]);
  const b = buildSequenceSignature([{ name: 'read_file', args: '{"path":"a.ts"}' }]);
  assert.equal(a, b, 're-issuing the exact same call must still produce the same signature');
});

test('buildSequenceSignature: argument key ORDER does not change the signature', () => {
  const a = buildSequenceSignature([{ name: 'grep_search', args: '{"query":"x","path":"src"}' }]);
  const b = buildSequenceSignature([{ name: 'grep_search', args: '{"path":"src","query":"x"}' }]);
  assert.equal(a, b, 'stable digest must ignore JSON key ordering');
});

test('buildSequenceSignature: parsed object, raw JSON string, and undefined/malformed are handled', () => {
  assert.equal(
    buildSequenceSignature([{ name: 'read_file', args: { path: 'a' } }]),
    buildSequenceSignature([{ name: 'read_file', args: '{"path":"a"}' }]),
    'a pre-parsed object and the equivalent raw JSON string digest identically',
  );
  // must not throw on undefined args or non-JSON argument text
  assert.doesNotThrow(() =>
    buildSequenceSignature([
      { name: 'noop', args: undefined },
      { name: 'weird', args: 'not json at all' },
    ]),
  );
});
