/**
 * ADR-028 S2-1 — the gh stack runner.
 *
 * The behaviour worth pinning is the latch: once a halting outcome is seen,
 * further MUTATION is refused until a human clears it. Without that, each
 * command decides independently and the second one lands on a half-finished
 * working tree.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  StackRunner,
  StackUnavailableError,
  StackHaltedError,
  stackActionsAvailable,
  type StackExec,
} from '../review/stackRunner.js';
import type { StackCapability } from '../review/stackCapability.js';

const AVAILABLE: StackCapability = {
  available: true, ghVersion: 'gh 2.91.0', gitVersion: 'git 2.39.5', extensionInstalled: true,
};
const MISSING: StackCapability = {
  available: false, reason: 'The gh-stack extension is not installed.', remediable: true,
};

function exec(codes: number[] | number): StackExec & { calls: string[][] } {
  const queue = Array.isArray(codes) ? [...codes] : [codes];
  const calls: string[][] = [];
  const fn = (async (args: readonly string[]) => {
    calls.push([...args]);
    const exitCode = queue.length > 1 ? queue.shift()! : queue[0]!;
    return { exitCode, stdout: 'out', stderr: '' };
  }) as StackExec & { calls: string[][] };
  fn.calls = calls;
  return fn;
}

function runner(e: StackExec, capability = AVAILABLE): StackRunner {
  return new StackRunner({ exec: e, capability });
}

test('an unavailable capability is refused WITHOUT attempting the command', async () => {
  // Attempting would produce a failure that can never clear, and the agent
  // would retry it.
  const e = exec(0);
  const r = runner(e, MISSING);
  await assert.rejects(() => r.run(['view']), StackUnavailableError);
  assert.equal(e.calls.length, 0, 'nothing should be executed');
});

test('a successful command returns an ok outcome and the argv', async () => {
  const e = exec(0);
  const result = await runner(e).run(['view']);
  assert.equal(result.outcome.ok, true);
  assert.deepEqual(result.command, ['stack', 'view']);
  assert.deepEqual(e.calls[0], ['stack', 'view']);
});

test('ordinary failure is RETURNED, not thrown', async () => {
  // "The command failed" is information the caller needs, not an exception.
  const result = await runner(exec(1)).run(['submit']);
  assert.equal(result.outcome.ok, false);
  assert.equal(result.outcome.kind, 'generic_error');
});

test('a rebase conflict LATCHES and blocks the next mutation', async () => {
  // The whole point. A second stack command on a conflicted tree compounds it.
  const r = runner(exec([3, 0]));
  const first = await r.run(['sync']);
  assert.equal(first.outcome.kind, 'rebase_conflict');
  assert.ok(r.haltedBy);
  await assert.rejects(() => r.run(['submit']), StackHaltedError);
});

test('recovery-needed latches too — the case where guessing loses work', async () => {
  const r = runner(exec([10, 0]));
  await r.run(['rebase']);
  assert.equal(r.haltedBy?.kind, 'recovery_needed');
  await assert.rejects(() => r.run(['add']), StackHaltedError);
});

test('READ-ONLY commands still work while mutation is halted', async () => {
  // You must be able to LOOK at the stack that is stuck. Blocking reads would
  // hide the state the human needs to fix it.
  const r = runner(exec([3, 0]));
  await r.run(['sync']);
  assert.ok(r.haltedBy);
  const view = await r.run(['view']);
  assert.equal(view.outcome.ok, true);
});

test('the latch clears only explicitly', async () => {
  // Nothing clears it automatically: the resolution happens outside this
  // process and we cannot observe that it was done correctly.
  const r = runner(exec([3, 0, 0]));
  await r.run(['sync']);
  await assert.rejects(() => r.run(['submit']), StackHaltedError);
  r.clearHalt();
  assert.equal(r.haltedBy, null);
  const after = await r.run(['submit']);
  assert.equal(after.outcome.ok, true);
});

test('feature-disabled does NOT latch — it is a repository setting, not a stuck tree', async () => {
  // Latching it would be wrong: nothing is half-finished, the feature is simply
  // off. It is handled by hiding the actions (A1), not by halting.
  const r = runner(exec([9, 0]));
  const out = await r.run(['view']);
  assert.equal(out.outcome.kind, 'feature_disabled');
  assert.equal(r.haltedBy, null);
});

test('an unknown exit code latches, because we cannot know it is safe', async () => {
  const r = runner(exec([77, 0]));
  await r.run(['submit']);
  assert.equal(r.haltedBy?.kind, 'unknown_code');
  await assert.rejects(() => r.run(['push']), StackHaltedError);
});

test('availability for OFFERING an action accounts for both causes', async () => {
  // Asking before offering is how the action stays hidden rather than visible
  // and failing.
  const clean = runner(exec(0));
  assert.equal(stackActionsAvailable(clean, AVAILABLE), true);
  assert.equal(stackActionsAvailable(clean, MISSING), false);

  const stuck = runner(exec([3, 0]));
  await stuck.run(['sync']);
  assert.equal(stackActionsAvailable(stuck, AVAILABLE), false);
});
