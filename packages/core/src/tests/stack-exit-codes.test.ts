/**
 * ADR-028 A3 — exit codes are the contract.
 *
 * The cases that matter are the ones where collapsing codes into "it failed"
 * causes a *different action* to be taken: retrying a repository that has the
 * feature switched off, or issuing a second stack command on a working tree
 * that already holds a half-finished rebase.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  classifyStackExit,
  blocksFurtherMutation,
  KNOWN_STACK_EXIT_CODES,
} from '../review/stackExitCodes.js';

test('exit 0 is the only ok outcome', () => {
  assert.equal(classifyStackExit(0).ok, true);
  for (const code of KNOWN_STACK_EXIT_CODES.filter((c) => c !== 0)) {
    assert.equal(classifyStackExit(code).ok, false, `exit ${code}`);
  }
});

test('feature-disabled marks the repository unavailable, not merely failed', () => {
  // A1: where stacks are off, the actions are HIDDEN. Reporting this as an
  // ordinary error makes the agent retry, and a retry loop against a repository
  // setting reads as a defect in us.
  const out = classifyStackExit(9);
  assert.equal(out.kind, 'feature_disabled');
  assert.equal(out.unavailable, true);
  assert.equal(out.retryable, false);
  assert.equal(blocksFurtherMutation(out), true);
});

test('conflict and rebase-in-progress halt further stack commands', () => {
  // The working tree holds a half-finished operation. A second stack command
  // does not fail cleanly — it compounds the state.
  for (const code of [3, 7]) {
    const out = classifyStackExit(code);
    assert.equal(out.halts, true, `exit ${code} must halt`);
    assert.equal(out.retryable, false, `exit ${code} must not invite a retry`);
    assert.equal(blocksFurtherMutation(out), true);
    assert.match(out.guidance, /finish|resolve|abort/i);
  }
});

test('recovery-needed refuses all further mutation and says work can be lost', () => {
  // The one where guessing destroys committed work.
  const out = classifyStackExit(10);
  assert.equal(out.kind, 'recovery_needed');
  assert.equal(out.halts, true);
  assert.equal(blocksFurtherMutation(out), true);
  assert.match(out.guidance, /lose committed work|RECOVERY IS REQUIRED/);
});

test('not-in-a-stack is an ordinary state, not a failure to escalate', () => {
  // Most pull requests are not stacked. Treating this as an error would make
  // every ordinary PR look broken.
  const out = classifyStackExit(2);
  assert.equal(out.kind, 'not_in_stack');
  assert.equal(out.halts, false);
  assert.equal(out.unavailable, false);
  assert.equal(blocksFurtherMutation(out), false);
});

test('only transient classes invite a retry', () => {
  // An API blip and a lock are worth one retry. Bad arguments and a disabled
  // feature are not — retrying those is a loop that never converges.
  assert.equal(classifyStackExit(4).retryable, true, 'api failure');
  assert.equal(classifyStackExit(8).retryable, true, 'stack locked');
  for (const code of [1, 2, 3, 5, 6, 7, 9, 10]) {
    assert.equal(classifyStackExit(code).retryable, false, `exit ${code}`);
  }
});

test('an UNRECOGNISED code halts rather than being assumed safe', () => {
  // The extension is in preview and may add codes. Assuming an unknown failure
  // is safe to continue through is the assumption that turns a new error class
  // into data loss. Erring toward stopping costs a manual retry.
  for (const code of [11, 42, 128, -1]) {
    const out = classifyStackExit(code);
    assert.equal(out.kind, 'unknown_code', `exit ${code}`);
    assert.equal(out.halts, true, `exit ${code} must halt`);
    assert.equal(blocksFurtherMutation(out), true);
    assert.match(out.guidance, /preview/);
  }
});

test('every FAILURE carries guidance — none is a bare code', () => {
  // A failure classification with no "what now" loses the same information the
  // raw exit code did. Success is exempt: there is nothing to do next.
  for (const code of [...KNOWN_STACK_EXIT_CODES, 99]) {
    const out = classifyStackExit(code);
    assert.equal(out.exitCode, code);
    if (out.ok) continue;
    assert.ok(out.guidance.trim().length > 20, `exit ${code} needs real guidance`);
  }
});

test('the ten documented codes are all classified', () => {
  // If GitHub documents a code we do not map, it silently becomes unknown_code
  // and halts — safe, but it means we stopped reading the reference.
  for (const code of [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10]) {
    assert.notEqual(classifyStackExit(code).kind, 'unknown_code', `exit ${code} is documented`);
  }
});
