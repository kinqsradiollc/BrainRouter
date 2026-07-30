import test from 'node:test';
import assert from 'node:assert/strict';
import { buildRepairPlan, repairUntilGreen } from '../orchestration/workflow/buildLoop.js';
import type { PhasePlanExecution } from '../orchestration/workflow/phaseOrchestrator.js';

/** A minimal build execution whose Verify phase carries `verifyOutput`. */
function exec(verifyOutput: string): PhasePlanExecution {
  return {
    status: 'completed',
    phases: [
      { id: 'plan', title: 'Plan', status: 'completed', children: [], output: 'planned' },
      { id: 'implement', title: 'Implement', status: 'completed', children: [], output: 'did work' },
      { id: 'verify', title: 'Verify', status: 'completed', children: [], output: verifyOutput },
      { id: 'review', title: 'Review', status: 'completed', children: [], output: 'looks ok' },
    ],
  } as unknown as PhasePlanExecution;
}
const verifyOf = (e: PhasePlanExecution) => e.phases.find((p) => p.id === 'verify')!.output;

test('BUILD-LOOP P5 repairUntilGreen: disabled (maxRepairs=0) never retries, even when red', async () => {
  let calls = 0;
  const res = await repairUntilGreen(exec('2 tests failed. Verdict: FAIL'), 0, async () => { calls++; return exec('PASS'); });
  assert.equal(calls, 0, 'runPlan never invoked');
  assert.equal(res.attempts, 0);
  assert.equal(res.green, false);
});

test('BUILD-LOOP P5 repairUntilGreen: already green → no repair', async () => {
  let calls = 0;
  const res = await repairUntilGreen(exec('All tests passed. Verdict: PASS'), 3, async () => { calls++; return exec('PASS'); });
  assert.equal(calls, 0);
  assert.equal(res.attempts, 0);
  assert.equal(res.green, true);
});

test('BUILD-LOOP P5 repairUntilGreen: red → green stops on the first green repair', async () => {
  const res = await repairUntilGreen(exec('1 failed. Verdict: FAIL'), 3, async () => exec('All passed. Verdict: PASS'));
  assert.equal(res.attempts, 1, 'one repair sufficed');
  assert.equal(res.green, true);
  assert.match(verifyOf(res.execution), /PASS/, 'execution carries the repaired (green) verify output');
});

test('BUILD-LOOP P5 repairUntilGreen: persistently red exhausts the budget, then gives up', async () => {
  let calls = 0;
  const res = await repairUntilGreen(exec('FAIL'), 2, async () => { calls++; return exec('still broken. Verdict: FAIL'); });
  assert.equal(calls, 2, 'tried exactly maxRepairs times');
  assert.equal(res.attempts, 2);
  assert.equal(res.green, false, 'still red → caller preserves the patch');
});

test('BUILD-LOOP P5 buildRepairPlan: valid implement→verify→review, failure fed to the worker', () => {
  const plan = buildRepairPlan('TypeError: x is not a function (foo.ts:3)', 2);
  assert.deepEqual(plan.phases.map((p) => p.id), ['implement', 'verify', 'review']);
  assert.equal(plan.phases[0].agents?.[0].role, 'worker');
  assert.equal(plan.phases[0].agents?.[0].access, 'write');
  assert.match(plan.phases[0].agents![0].prompt, /TypeError: x is not a function \(foo\.ts:3\)/);
  assert.match(plan.phases[0].agents![0].prompt, /attempt 2/);
  assert.deepEqual(plan.phases[1].dependsOn, ['implement']);
  assert.equal(plan.phases[1].agents?.[0].access, 'shell');
});
