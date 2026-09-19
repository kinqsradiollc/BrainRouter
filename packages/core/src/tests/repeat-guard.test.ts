import test from 'node:test';
import assert from 'node:assert/strict';
import { isSequenceGuardExempt, DEFAULT_SEQUENCE_GUARD_EXEMPT, buildSequenceSignature } from '../agent/guards/repeatGuard.js';

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

/* ---------- the window is measured in batches, not calls ---------- */

import {
  REPEAT_GUARD_WINDOW_BATCHES, countRepeatsInWindow, pruneRepeatWindow,
  type RepeatWindowEntry,
} from '../agent/guards/repeatGuard.js';

/** Replay the guard exactly as the turn loop drives it. */
function replay(batches: string[][], limit = 3): { trippedOn: string | null; calls: number } {
  const window: RepeatWindowEntry[] = [];
  let batch = 0;
  let calls = 0;
  for (const names of batches) {
    batch += 1;
    for (const signature of names) {
      calls += 1;
      if (countRepeatsInWindow(window, signature) >= limit) return { trippedOn: signature, calls };
      window.push({ signature, batch });
      pruneRepeatWindow(window, batch);
    }
  }
  return { trippedOn: null, calls };
}

test('a wide parallel batch no longer evicts the evidence of its own repeat', () => {
  // The live failure: the same three files re-read forever, each batch padded
  // with other calls so the old 12-CALL window rolled the repeats out.
  const spin = [
    ['read_file:AGENT.md', 'read_file:README.md', 'read_file:docs/architecture.md'],
    ['glob_files:a', 'glob_files:b', 'glob_files:c', 'glob_files:d', 'glob_files:e'],
    ['read_file:AGENT.md', 'read_file:README.md', 'read_file:package.json', 'read_file:docs/architecture.md'],
    ['glob_files:f', 'glob_files:g', 'glob_files:h', 'glob_files:i', 'glob_files:j'],
    ['read_file:AGENT.md', 'read_file:README.md', 'read_file:docs/architecture.md'],
    ['read_file:AGENT.md', 'read_file:README.md'],
  ];
  assert.equal(replay(spin).trippedOn, 'read_file:AGENT.md', 'the third identical read is caught');

  // The old behaviour, for contrast: a 12-ENTRY ring drops the first AGENT.md
  // after two padded batches, so the count never reaches the limit.
  const ring: string[] = [];
  let tripped = false;
  for (const names of spin) {
    for (const signature of names) {
      if (ring.filter((s) => s === signature).length >= 3) tripped = true;
      ring.push(signature);
      if (ring.length > 12) ring.shift();
    }
  }
  assert.equal(tripped, false, 'this is the bug the batch window fixes');
});

test('a genuine revisit outside the window is still free work, not a loop', () => {
  const batches: string[][] = [['read_file:a.ts']];
  for (let i = 0; i < REPEAT_GUARD_WINDOW_BATCHES; i += 1) batches.push([`edit_file:file${i}.ts`]);
  batches.push(['read_file:a.ts'], ['read_file:a.ts']);
  assert.equal(replay(batches).trippedOn, null, 'coming back to a file later is normal');
});

test('pruning keeps the window bounded and never drops the current batch', () => {
  const window: RepeatWindowEntry[] = [];
  for (let batch = 1; batch <= 50; batch += 1) {
    for (let i = 0; i < 7; i += 1) window.push({ signature: `t${i}`, batch });
    pruneRepeatWindow(window, batch);
    assert.ok(window.length <= 7 * (REPEAT_GUARD_WINDOW_BATCHES + 1), `bounded at batch ${batch}`);
    assert.equal(window.filter((e) => e.batch === batch).length, 7, 'the current batch survives');
  }
});
