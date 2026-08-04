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
  describeSyncRewrite,
  selectMergeableLayer,
  planMergeCascade,
  describeMergeCascade,
  staleAfterMerge,
  mergeStackThrough,
  MERGE_TIMEOUT_MS,
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

/* --------------------------------------------------- merge, as a cascade */

test('merging a middle layer lands EVERYTHING beneath it — the cascade is returned', () => {
  // `gh stack merge #3` is not "merge #3". It is "merge #1, #2 and #3". A
  // confirmation that says the former has not obtained consent for the latter.
  const layers = [
    layer({ number: 1, position: 1 }),
    layer({ number: 2, position: 2 }),
    layer({ number: 3, position: 3 }),
  ];
  const c = planMergeCascade(layers, 3);
  assert.equal(c.allowed, true);
  assert.deepEqual(c.landing.map((l) => l.number), [1, 2, 3]);
});

test('the cascade description names every pull request that lands', () => {
  const layers = [layer({ number: 9, position: 1 }), layer({ number: 12, position: 2 })];
  const text = describeMergeCascade(planMergeCascade(layers, 12));
  assert.match(text, /#9/);
  assert.match(text, /#12/);
  assert.match(text, /one operation/);
});

test('already-merged layers are excluded from the cascade', () => {
  const layers = [
    layer({ number: 1, position: 1, merged: true }),
    layer({ number: 2, position: 2 }),
  ];
  assert.deepEqual(planMergeCascade(layers, 2).landing.map((l) => l.number), [2]);
});

test('one unready layer anywhere in the cascade blocks the whole merge', () => {
  // All-or-nothing: there is no partial outcome where the ready ones land.
  const layers = [
    layer({ number: 1, position: 1, checksPassed: false }),
    layer({ number: 2, position: 2 }),
  ];
  const c = planMergeCascade(layers, 2);
  assert.equal(c.allowed, false);
  assert.equal(c.waiting, true);
  assert.match(c.reason!, /#1 \(checks not passed\)/);
  assert.match(c.reason!, /all-or-nothing/);
});

test('a queued layer in the cascade is waiting, not refused', () => {
  const layers = [layer({ number: 1, position: 1, inMergeQueue: true })];
  const c = planMergeCascade(layers, 1);
  assert.equal(c.waiting, true);
  assert.match(c.reason!, /merge queue/);
});

test('an unknown or already-merged target is refused distinctly', () => {
  const layers = [layer({ number: 1, position: 1, merged: true })];
  assert.match(planMergeCascade(layers, 99).reason!, /not part of this stack/);
  assert.match(planMergeCascade(layers, 1).reason!, /already merged/);
});

test('merging uses `gh stack merge` — not `gh pr merge`', async () => {
  // `gh pr merge` does not retarget the layers above as part of landing.
  const e = exec(0);
  const r = await mergeStackThrough(runner(e), [layer({ number: 41, position: 1 })], 41);
  assert.equal(r.merged, true);
  assert.deepEqual(r.landed, [41]);
  assert.deepEqual(e.calls[0], ['stack', 'merge', '41']);
});

test('layers left above a partial merge are reported, not silently left', () => {
  // A later `submit` on a stale branch pushes commits that already merged.
  const layers = [
    layer({ number: 1, position: 1 }),
    layer({ number: 2, position: 2 }),
    layer({ number: 3, position: 3 }),
  ];
  assert.deepEqual(staleAfterMerge(layers, [1, 2]).map((l) => l.number), [3]);
});

test('a retryable failure is PENDING — a slow merge may still have landed', async () => {
  // Stack merges take 90s+. Reporting failure invites a retry against a
  // partially-applied merge, which is the worst available outcome.
  const r = await mergeStackThrough(runner(exec(8)), [layer({ number: 41, position: 1 })], 41);
  assert.equal(r.merged, false);
  assert.equal(r.pending, true);
  assert.match(r.reason!, /may still have landed/);
});

test('the merge timeout is generous enough for a real stack merge', () => {
  assert.ok(MERGE_TIMEOUT_MS >= 90_000, 'a 90s merge must not time out');
});

test('an unmergeable stack never runs the command', async () => {
  const e = exec(0);
  await mergeStackThrough(runner(e), [layer({ number: 41, position: 1, checksPassed: false })], 41);
  assert.equal(e.calls.length, 0);
});

/* ------------------------------------------------------- sync disclosure */

test('sync preserves author dates, so review comments stay legible', async () => {
  const e = exec(0);
  await syncStack(runner(e));
  assert.ok(e.calls[0]!.includes('--committer-date-is-author-date'));
});

test('the sync confirmation names every branch whose history is rewritten', () => {
  // Consent to "sync the stack" is not consent to rewrite six branches you had
  // forgotten were in it.
  const text = describeSyncRewrite([layer({ number: 4, position: 2 }), layer({ number: 7, position: 3 })]);
  assert.match(text, /#4/);
  assert.match(text, /#7/);
  assert.match(describeSyncRewrite([]), /No branch history/);
});
