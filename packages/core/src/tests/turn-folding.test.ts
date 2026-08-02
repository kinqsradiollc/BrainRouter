/**
 * ADR-027 D5 (P4-2) — which turns stay rendered.
 *
 * The rule worth defending is the reference rescue. A visible reply citing a
 * folded question reads as a non-sequitur, and the reader cannot tell whether
 * they missed something or the agent lost the plot. A naive "keep the last N"
 * gets this wrong, and short sessions never trip it — so it is tested directly.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { planFolding, describeFolding, type FoldableTurn } from '../session/turnFolding.js';

const turn = (id: string, weight: number, extra: Partial<FoldableTurn> = {}): FoldableTurn =>
  ({ id, weight, ...extra });

const many = (count: number, weight = 10): FoldableTurn[] =>
  Array.from({ length: count }, (_, i) => turn(`t${i}`, weight));

test('a session inside budget folds nothing', () => {
  const plan = planFolding(many(3), { maxWeight: 1_000 });
  assert.deepEqual(plan.folded, []);
  assert.equal(plan.renderedWeight, 30);
  assert.equal(describeFolding(plan), null, 'no banner when nothing is hidden');
});

test('folding takes the oldest first and stops as soon as it fits', () => {
  // Cheapest correct answer, and it keeps the plan stable as the session grows.
  const plan = planFolding(many(10), { maxWeight: 50, keepRecent: 0 });
  assert.deepEqual(plan.folded, ['t0', 't1', 't2', 't3', 't4']);
  assert.equal(plan.renderedWeight, 50);
  assert.equal(plan.foldedWeight, 50);
});

test('the most recent turns survive regardless of weight', () => {
  // A single enormous latest turn folding itself would hide the one turn the
  // user is certainly looking at.
  const turns = [turn('old', 10), turn('huge', 10_000)];
  const plan = planFolding(turns, { maxWeight: 5, keepRecent: 1 });
  assert.ok(plan.expanded.includes('huge'));
  assert.deepEqual(plan.folded, ['old']);
});

test('a pinned turn is never folded, however old', () => {
  const turns = [turn('t0', 10, { pinned: true }), ...many(9).map((t, i) => turn(`p${i}`, 10))];
  const plan = planFolding(turns, { maxWeight: 20, keepRecent: 1 });
  assert.ok(plan.expanded.includes('t0'), 'the user said to keep it');
});

test('a folded turn referenced by a visible one is rescued', () => {
  // The failure a naive "keep the last N" produces: a visible reply citing a
  // question that is no longer on screen.
  const turns = [
    turn('question', 10),
    ...many(8).map((_, i) => turn(`filler${i}`, 10)),
    turn('answer', 10, { references: ['question'] }),
  ];
  const plan = planFolding(turns, { maxWeight: 30, keepRecent: 1 });
  assert.ok(plan.expanded.includes('answer'));
  assert.ok(plan.expanded.includes('question'), 'the reply would otherwise be a non-sequitur');
});

test('rescue runs to a fixed point through chained references', () => {
  // Rescuing a turn can surface ITS references; one round would leave a
  // rescued turn citing something still folded.
  const turns = [
    turn('a', 10),
    turn('b', 10, { references: ['a'] }),
    ...many(8).map((_, i) => turn(`filler${i}`, 10)),
    turn('c', 10, { references: ['b'] }),
  ];
  const plan = planFolding(turns, { maxWeight: 20, keepRecent: 1 });
  for (const id of ['a', 'b', 'c']) {
    assert.ok(plan.expanded.includes(id), `${id} must survive the chain`);
  }
});

test('a reference from a FOLDED turn does not rescue anything', () => {
  // Only what is on screen can produce a dangling citation.
  const turns = [
    turn('target', 10),
    turn('citer', 10, { references: ['target'] }),
    ...many(8).map((_, i) => turn(`filler${i}`, 10)),
  ];
  const plan = planFolding(turns, { maxWeight: 30, keepRecent: 1 });
  assert.ok(plan.folded.includes('citer'));
  assert.ok(plan.folded.includes('target'), 'nothing visible cites it');
});

test('a dangling reference is ignored rather than throwing', () => {
  // A turn citing something deleted or from another session must not break
  // rendering — the transcript still has to draw.
  const turns = [...many(9), turn('last', 10, { references: ['does-not-exist'] })];
  assert.doesNotThrow(() => planFolding(turns, { maxWeight: 20, keepRecent: 1 }));
});

test('rescue may push the rendered weight back over budget, and that is correct', () => {
  // Correctness beats the budget: a coherent transcript over a fast one.
  const turns = [
    turn('cited', 100),
    ...many(5).map((_, i) => turn(`f${i}`, 10)),
    turn('citer', 10, { references: ['cited'] }),
  ];
  const plan = planFolding(turns, { maxWeight: 20, keepRecent: 1 });
  assert.ok(plan.expanded.includes('cited'));
  assert.ok(plan.renderedWeight > 20);
});

test('the plan is stable as the session grows', () => {
  // A scrollback that rearranges itself while being read is worse than a slow
  // one, so an appended turn must not reshuffle what is already folded.
  const base = many(10);
  const before = planFolding(base, { maxWeight: 50, keepRecent: 2 });
  const after = planFolding([...base, turn('new', 10)], { maxWeight: 50, keepRecent: 2 });
  for (const id of before.folded) {
    assert.ok(after.folded.includes(id), `${id} must stay folded`);
  }
});

test('every turn lands in exactly one bucket', () => {
  const turns = many(12);
  const plan = planFolding(turns, { maxWeight: 40, keepRecent: 2 });
  assert.deepEqual(
    [...plan.expanded, ...plan.folded].sort(),
    turns.map((t) => t.id).sort(),
  );
  assert.equal(plan.renderedWeight + plan.foldedWeight, 120);
});

test('an empty session plans nothing', () => {
  const plan = planFolding([], { maxWeight: 10 });
  assert.deepEqual(plan.expanded, []);
  assert.deepEqual(plan.folded, []);
  assert.equal(describeFolding(plan), null);
});
