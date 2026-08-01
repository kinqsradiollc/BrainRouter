/**
 * ADR-027 D2 (P3-2) — compensation ordering and the non-compensable pivot.
 *
 * The asymmetry these tests defend: a plan that sends an email then fails
 * writing a file cannot be undone. The same plan with the write first fails
 * harmlessly and retries. Nothing about the work changed — only the order.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  orderPlan,
  compensationOrder,
  pivotConfirmation,
  PlanOrderError,
  type PlanStep,
} from '../graph/compensation.js';

const step = (id: string, compensable: boolean, dependsOn?: string[]): PlanStep => ({
  id,
  description: `${id} (${compensable ? 'reversible' : 'IRREVERSIBLE'})`,
  compensable,
  ...(dependsOn ? { dependsOn } : {}),
});

test('reversible work is scheduled before irreversible work', () => {
  const plan = orderPlan([step('send-email', false), step('write-file', true)]);
  assert.deepEqual(plan.steps.map((s) => s.id), ['write-file', 'send-email']);
  assert.equal(plan.pivotIndex, 1);
  assert.equal(plan.pivot?.id, 'send-email');
});

test('dependencies win over the ordering preference', () => {
  // Correctness first: an irreversible step a later step needs must still run
  // first. The rule is "as late as dependencies allow", not "always last".
  const plan = orderPlan([
    step('cleanup', true, ['publish']),
    step('publish', false),
  ]);
  assert.deepEqual(plan.steps.map((s) => s.id), ['publish', 'cleanup']);
  assert.equal(plan.pivotIndex, 0, 'the pivot is immediate here, and that is honest');
});

test('the pivot splits reversible from unrecoverable', () => {
  const plan = orderPlan([
    step('a', true), step('b', true), step('c', false), step('d', false),
  ]);
  assert.deepEqual(plan.beforePivot.map((s) => s.id), ['a', 'b']);
  assert.deepEqual(plan.afterPivot.map((s) => s.id), ['c', 'd']);
});

test('a fully reversible plan has no pivot', () => {
  const plan = orderPlan([step('a', true), step('b', true)]);
  assert.equal(plan.pivotIndex, -1);
  assert.equal(plan.pivot, undefined);
  assert.deepEqual(plan.beforePivot.map((s) => s.id), ['a', 'b']);
  assert.deepEqual(plan.afterPivot, []);
});

test('ordering is deterministic for the same plan', () => {
  const steps = [step('z', true), step('a', true), step('m', true)];
  const first = orderPlan(steps).steps.map((s) => s.id);
  const second = orderPlan([...steps].reverse()).steps.map((s) => s.id);
  assert.deepEqual(first, ['a', 'm', 'z']);
  assert.deepEqual(first, second, 'a plan that reshuffles cannot be checkpointed against');
});

test('a dependency cycle throws rather than dropping an edge', () => {
  // A plan that silently ignores an ordering constraint is worse than one that
  // refuses to run — the constraint existed for a reason.
  assert.throws(
    () => orderPlan([step('a', true, ['b']), step('b', true, ['a'])]),
    (error: Error) => {
      assert.ok(error instanceof PlanOrderError);
      assert.match(error.message, /cycle/);
      return true;
    },
  );
});

test('an unknown dependency throws', () => {
  assert.throws(() => orderPlan([step('a', true, ['ghost'])]), /unknown step "ghost"/);
});

test('a duplicate step id throws', () => {
  assert.throws(() => orderPlan([step('a', true), step('a', false)]), /Duplicate step id/);
});

test('compensation unwinds in reverse, skipping the failed step', () => {
  const plan = orderPlan([step('a', true), step('b', true), step('c', true)]);
  const undo = compensationOrder(plan, 2);
  // Reverse because a later step may depend on an earlier one's effect; undoing
  // the earlier first can leave the later compensation nothing to act on.
  assert.deepEqual(undo.map((s) => s.id), ['b', 'a']);
});

test('the failed step is never compensated — its effect is unknown', () => {
  // Whether it landed is precisely what failing leaves undetermined, so the
  // caller reconciles by idempotency key rather than assuming either way.
  const plan = orderPlan([step('a', true), step('b', true)]);
  assert.deepEqual(compensationOrder(plan, 1).map((s) => s.id), ['a']);
  assert.deepEqual(compensationOrder(plan, 0), [], 'failing first compensates nothing');
});

test('non-compensable steps are excluded from the unwind', () => {
  const plan = orderPlan([step('reversible', true), step('sent', false), step('after', false)]);
  // Plan order: reversible, sent, after. Failing at index 2 can only undo the
  // first — "sent" is what non-compensable means.
  assert.deepEqual(compensationOrder(plan, 2).map((s) => s.id), ['reversible']);
});

test('an out-of-range failure index throws rather than silently unwinding all', () => {
  const plan = orderPlan([step('a', true)]);
  assert.throws(() => compensationOrder(plan, 5), PlanOrderError);
  assert.throws(() => compensationOrder(plan, -1), PlanOrderError);
});

test('confirmation is requested only when something is irreversible', () => {
  // Confirming at every step is the notification fatigue ADR-027 §1 warns
  // produces rubber-stamping. A reversible plan buys nothing by interrupting.
  assert.equal(pivotConfirmation(orderPlan([step('a', true)])), null);

  const confirm = pivotConfirmation(orderPlan([step('a', true), step('publish', false)]));
  assert.ok(confirm);
  assert.match(confirm.message, /CANNOT be undone/);
  assert.match(confirm.message, /1 reversible step/);
  assert.deepEqual(confirm.steps.map((s) => s.id), ['publish']);
});

test('the confirmation summarises rather than listing everything', () => {
  const irreversible = ['p1', 'p2', 'p3', 'p4', 'p5'].map((id) => step(id, false));
  const confirm = pivotConfirmation(orderPlan(irreversible));
  assert.ok(confirm);
  assert.match(confirm.message, /and 2 more/);
  assert.equal(confirm.steps.length, 5, 'the full set is still available to the caller');
});
