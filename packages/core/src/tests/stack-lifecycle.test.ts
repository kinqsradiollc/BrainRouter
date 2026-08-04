/**
 * ADR-028 A4/A5 — sync and merge.
 *
 * Two properties carry the whole feature:
 *
 *  - A conflict during sync is a HUMAN state, not a retryable failure. Pinned
 *    because the natural agent response to "command failed" is to run it again,
 *    and running it again on a mid-rebase tree is how work gets lost.
 *  - Merging is bottom-up, always. Pinned because the failure is invisible: the
 *    commits land, so it looks like it worked, and what is lost is the review
 *    record on the layers below.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  syncStack,
  selectMergeableLayer,
  validateMergeTarget,
  mergeBottomLayer,
  type LayerState,
} from '../review/stackLifecycle.js';
import { StackRunner, type StackExec } from '../review/stackRunner.js';
import type { StackCapability } from '../review/stackCapability.js';

const AVAILABLE: StackCapability = { available: true, extensionInstalled: true };

function exec(codes: number[] | number): StackExec & { calls: string[][] } {
  const queue = Array.isArray(codes) ? [...codes] : [codes];
  const calls: string[][] = [];
  const fn = (async (args: readonly string[]) => {
    calls.push([...args]);
    return { exitCode: queue.length > 1 ? queue.shift()! : queue[0]!, stdout: '', stderr: '' };
  }) as StackExec & { calls: string[][] };
  fn.calls = calls;
  return fn;
}

const runner = (e: StackExec) => new StackRunner({ exec: e, capability: AVAILABLE });

function layer(over: Partial<LayerState> & { number: number; position: number }): LayerState {
  return { merged: false, checksPassed: true, approved: true, ...over };
}

/* -------------------------------------------------------------------- sync */

test('a clean sync succeeds and needs nobody', async () => {
  const r = await syncStack(runner(exec(0)));
  assert.equal(r.synced, true);
  assert.equal(r.needsHuman, false);
});

test('a conflict is a HUMAN state, and the message says how to get out', async () => {
  // The critical distinction. "Failed, try again" on a mid-rebase tree is how
  // the original work becomes hard to recover.
  const r = await syncStack(runner(exec(3)));
  assert.equal(r.synced, false);
  assert.equal(r.needsHuman, true);
  assert.match(r.reason!, /rebase --continue/);
  assert.match(r.reason!, /rebase --abort/);
});

test('an in-progress rebase is treated the same as a conflict', async () => {
  const r = await syncStack(runner(exec(7)));
  assert.equal(r.needsHuman, true);
});

test('recovery-needed tells the human to LOOK before changing anything', async () => {
  const r = await syncStack(runner(exec(10)));
  assert.equal(r.needsHuman, true);
  assert.match(r.reason!, /gh stack view/);
});

test('an ordinary failure is not escalated to needing a human', async () => {
  // Over-escalating trains people to ignore the signal.
  const r = await syncStack(runner(exec(1)));
  assert.equal(r.synced, false);
  assert.equal(r.needsHuman, false);
});

/* ------------------------------------------------------------------- merge */

test('the bottom unmerged layer is the one that may merge', () => {
  const d = selectMergeableLayer([
    layer({ number: 3, position: 3 }),
    layer({ number: 1, position: 1 }),
    layer({ number: 2, position: 2 }),
  ]);
  assert.equal(d.allowed, true);
  assert.equal((d as { layer: LayerState }).layer.number, 1);
});

test('already-merged layers are skipped, and the next one is chosen', () => {
  const d = selectMergeableLayer([
    layer({ number: 1, position: 1, merged: true }),
    layer({ number: 2, position: 2 }),
  ]);
  assert.equal((d as { layer: LayerState }).layer.number, 2);
});

test('a queued layer is WAITING, not refused', () => {
  // A caller that reads this as failure reports a problem for something
  // proceeding normally — and an agent that reads it as failure forces it.
  const d = selectMergeableLayer([layer({ number: 1, position: 1, inMergeQueue: true })]);
  assert.equal(d.allowed, false);
  assert.equal((d as { waiting: boolean }).waiting, true);
  assert.match((d as { reason: string }).reason, /merge queue/);
});

test('failing checks on the bottom layer block the whole stack, and say so', () => {
  const d = selectMergeableLayer([
    layer({ number: 1, position: 1, checksPassed: false }),
    layer({ number: 2, position: 2 }),
  ]);
  assert.equal(d.allowed, false);
  assert.match((d as { reason: string }).reason, /nothing above it can merge/);
});

test('an unapproved bottom layer waits', () => {
  const d = selectMergeableLayer([layer({ number: 1, position: 1, approved: false })]);
  assert.equal((d as { waiting: boolean }).waiting, true);
});

test('a fully merged stack is done, not waiting', () => {
  const d = selectMergeableLayer([layer({ number: 1, position: 1, merged: true })]);
  assert.equal(d.allowed, false);
  assert.equal((d as { waiting: boolean }).waiting, false);
});

test('merging a MIDDLE layer is refused, and the reason names what is lost', () => {
  // The invisible failure: the commits land, so it looks like it worked. What
  // is lost is the review record on the layers below.
  const layers = [layer({ number: 1, position: 1 }), layer({ number: 2, position: 2 })];
  const v = validateMergeTarget(layers, 2);
  assert.equal(v.allowed, false);
  assert.match(v.reason!, /#1/);
  assert.match(v.reason!, /bottom-up/);
  assert.match(v.reason!, /review record/);
});

test('the bottom layer passes target validation', () => {
  const layers = [layer({ number: 1, position: 1 }), layer({ number: 2, position: 2 })];
  assert.equal(validateMergeTarget(layers, 1).allowed, true);
});

test('a layer whose predecessors all merged may go, even mid-stack', () => {
  const layers = [
    layer({ number: 1, position: 1, merged: true }),
    layer({ number: 2, position: 2 }),
  ];
  assert.equal(validateMergeTarget(layers, 2).allowed, true);
});

test('an unknown or already-merged target is refused distinctly', () => {
  const layers = [layer({ number: 1, position: 1, merged: true })];
  assert.match(validateMergeTarget(layers, 99).reason!, /not part of this stack/);
  assert.match(validateMergeTarget(layers, 1).reason!, /already merged/);
});

test('merging uses `gh stack merge` — not `gh pr merge`', async () => {
  // `gh pr merge` does not retarget the layers above as part of landing.
  const e = exec(0);
  const r = await mergeBottomLayer(runner(e), [layer({ number: 41, position: 1 })]);
  assert.equal(r.merged, true);
  assert.deepEqual(e.calls[0], ['stack', 'merge', '41']);
});

test('a locked stack is a race we lost, reported as retryable', async () => {
  const r = await mergeBottomLayer(runner(exec(8)), [layer({ number: 41, position: 1 })]);
  assert.equal(r.merged, false);
  assert.equal(r.queued, true);
  assert.match(r.reason!, /try again/);
});

test('an unmergeable stack never runs the command', async () => {
  const e = exec(0);
  await mergeBottomLayer(runner(e), [layer({ number: 41, position: 1, checksPassed: false })]);
  assert.equal(e.calls.length, 0);
});
