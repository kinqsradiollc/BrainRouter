/**
 * ADR-028 A7 — plan phases are the stack.
 *
 * The properties worth pinning are all about REFUSING. Turning a chain into a
 * stack is the easy half; the half that decides whether the feature is useful
 * is declining to stack independent work, and declining to ask again once
 * someone has said no.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  proposeStackFromPlan,
  mayProposeStack,
  type PlanPhaseLike,
} from '../review/planToStack.js';

function phase(id: string, title: string, dependsOn: string[] = []): PlanPhaseLike {
  return { id, title, status: 'pending', dependsOn };
}

const CHAIN = [
  phase('a', 'Add the schema'),
  phase('b', 'Read it in the API', ['a']),
  phase('c', 'Show it in the UI', ['b']),
];

test('a chain of phases maps to a stack of the same shape', () => {
  const p = proposeStackFromPlan(CHAIN);
  assert.equal(p.stackable, true);
  const layers = (p as unknown as { layers: Array<{ phaseId: string; position: number }> }).layers;
  assert.deepEqual(layers.map((l) => l.phaseId), ['a', 'b', 'c']);
  assert.deepEqual(layers.map((l) => l.position), [1, 2, 3]);
});

test('each layer records the phase directly beneath it', () => {
  // This is what A7 requires the PR body to state in prose. Losing it here
  // means inferring it later from a finished diff, which is a guess.
  const p = proposeStackFromPlan(CHAIN) as unknown as { layers: Array<{ dependsOnPhaseId?: string }> };
  assert.equal(p.layers[0]!.dependsOnPhaseId, undefined, 'the bottom layer targets trunk');
  assert.equal(p.layers[1]!.dependsOnPhaseId, 'a');
  assert.equal(p.layers[2]!.dependsOnPhaseId, 'b');
});

test('phases given in scrambled order still linearise correctly', () => {
  const p = proposeStackFromPlan([CHAIN[2]!, CHAIN[0]!, CHAIN[1]!]) as unknown as {
    layers: Array<{ phaseId: string }>;
  };
  assert.deepEqual(p.layers.map((l) => l.phaseId), ['a', 'b', 'c']);
});

test('INDEPENDENT phases are refused — a stack would invent an order', () => {
  // The most important refusal. Two phases that depend on nothing are parallel
  // work; putting one behind the other blocks it for a reason no reviewer can
  // act on.
  const p = proposeStackFromPlan([phase('a', 'Fix the logger'), phase('b', 'Fix the parser')]);
  assert.equal(p.stackable, false);
  assert.match((p as unknown as { reason: string }).reason, /independent work/);
});

test('a fan-out is refused, and names both branches', () => {
  const p = proposeStackFromPlan([
    phase('a', 'Add the schema'),
    phase('b', 'API reader', ['a']),
    phase('c', 'CLI reader', ['a']),
  ]);
  assert.equal(p.stackable, false);
  assert.match((p as unknown as { reason: string }).reason, /"API reader" and "CLI reader"/);
  assert.match((p as unknown as { reason: string }).reason, /parallel/);
});

test('a fan-in is refused — a layer has exactly one layer beneath it', () => {
  const p = proposeStackFromPlan([
    phase('a', 'Schema'),
    phase('b', 'API', ['a']),
    phase('c', 'Docs', ['a', 'b']),
  ]);
  assert.equal(p.stackable, false);
  assert.match((p as unknown as { reason: string }).reason, /more than one phase/);
});

test('a dependency cycle is reported rather than looping', () => {
  const p = proposeStackFromPlan([phase('a', 'A', ['b']), phase('b', 'B', ['a'])]);
  assert.equal(p.stackable, false);
  assert.match((p as unknown as { reason: string }).reason, /cycle/);
});

test('a single phase is one pull request, not a stack of one', () => {
  assert.equal(proposeStackFromPlan([phase('a', 'A')]).stackable, false);
});

test('skipped phases are excluded from the chain', () => {
  const p = proposeStackFromPlan([
    phase('a', 'Schema'),
    { ...phase('b', 'Abandoned', ['a']), status: 'skipped' },
    phase('c', 'API', ['a']),
  ]) as unknown as { stackable: boolean; layers: Array<{ phaseId: string }> };
  assert.equal(p.stackable, true, 'dropping the skipped phase leaves a valid chain');
  assert.deepEqual(p.layers.map((l) => l.phaseId), ['a', 'c']);
});

test('dependencies on phases outside the set carry no ordering here', () => {
  // A phase depending on something already merged still counts as a root.
  const p = proposeStackFromPlan([
    phase('a', 'Schema', ['already-merged']),
    phase('b', 'API', ['a']),
  ]);
  assert.equal(p.stackable, true);
});

test('a plan deeper than the cap is refused, with the follow-on suggested', () => {
  const deep = Array.from({ length: 7 }, (_, i) =>
    phase(`p${i}`, `Phase ${i}`, i === 0 ? [] : [`p${i - 1}`]),
  );
  const p = proposeStackFromPlan(deep);
  assert.equal(p.stackable, false);
  assert.match((p as unknown as { reason: string }).reason, /becomes a queue/);
  assert.match((p as unknown as { reason: string }).reason, /follow/);
});

/* ----------------------------------------------------- auto-proposal gate */

const OPEN = { proposedFor: new Set<string>(), declined: false };

test('a proposal fires once per change and not again', () => {
  assert.equal(mayProposeStack(OPEN, 'c1', { shouldStack: true }).propose, true);
  const after = { proposedFor: new Set(['c1']), declined: false };
  assert.equal(mayProposeStack(after, 'c1', { shouldStack: true }).propose, false);
});

test('one decline silences proposals for the session, not just for that change', () => {
  // A person who declines has told us how they work; asking again about a
  // different change ignores that. Acceptance falls ~30% per notification, so
  // the reflex being trained here is the thing that matters.
  const declined = { proposedFor: new Set<string>(), declined: true };
  const r = mayProposeStack(declined, 'a-different-change', { shouldStack: true });
  assert.equal(r.propose, false);
  assert.match(r.reason!, /declined/);
});

test('an indivisible or small change never triggers a proposal', () => {
  assert.equal(mayProposeStack(OPEN, 'c2', { shouldStack: false }).propose, false);
});
