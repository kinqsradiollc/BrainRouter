import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizePhasePlan, type PhaseAgentSpec, type WorkflowPhase } from '../orchestration/phasePlan.js';
import {
  executePhasePlan,
  type PhaseRunner,
  type PhaseChildResult,
} from '../orchestration/phaseOrchestrator.js';

/** A fake runner: records (phaseId, agents) per call and returns canned results. */
function recordingRunner(
  results: Record<string, (agents: PhaseAgentSpec[]) => PhaseChildResult[]>,
  calls: Array<{ phase: string; agents: PhaseAgentSpec[] }> = [],
): { runner: PhaseRunner; calls: typeof calls } {
  const runner: PhaseRunner = async (agents, phase: WorkflowPhase) => {
    calls.push({ phase: phase.id, agents });
    const make = results[phase.id];
    if (make) return make(agents);
    return agents.map((a, i) => ({
      id: `${phase.id}-${i}`,
      role: a.role ?? 'worker',
      status: 'completed',
      finalOutput: `out:${a.label ?? a.prompt}`,
    }));
  };
  return { runner, calls };
}

const ok = (id: string, role: string, finalOutput: string): PhaseChildResult => ({
  id,
  role,
  status: 'completed',
  finalOutput,
});

test('executePhasePlan: barrier + {{input}} injection — phase 2 sees phase 1 output, runs after it', async () => {
  const { plan } = normalizePhasePlan({
    phases: [
      {
        id: 'review',
        fanOut: { over: ['repoA', 'repoB'], agent: { role: 'reviewer', prompt: 'Review {{target}}.' } },
        // 'none' → output is the children's raw outputs concatenated (predictable for assertion)
      },
      {
        id: 'synth',
        agents: [{ role: 'architect', prompt: 'Synthesize: {{input}}' }],
        inputFrom: ['review'],
        dependsOn: ['review'],
      },
    ],
  });
  assert.ok(plan);

  const { runner, calls } = recordingRunner({
    review: () => [ok('r0', 'reviewer', 'FINDING-A'), ok('r1', 'reviewer', 'FINDING-B')],
  });
  const result = await executePhasePlan(plan!, runner);

  // Barrier: review fully ran before synth.
  assert.deepEqual(calls.map((c) => c.phase), ['review', 'synth']);
  // Input injection: synth's agent prompt contains phase-1 outputs.
  const synthCall = calls.find((c) => c.phase === 'synth')!;
  assert.equal(synthCall.agents[0].prompt, 'Synthesize: FINDING-A\n\n---\n\nFINDING-B');
  assert.equal(result.status, 'completed');
  assert.equal(result.phases.length, 2);
});

test('executePhasePlan: fan-out expands one agent per target with {{target}} substituted', async () => {
  const { plan } = normalizePhasePlan({
    phases: [
      { id: 'p', fanOut: { over: ['x', 'y', 'z'], agent: { role: 'reviewer', prompt: 'do {{target}}' } } },
    ],
  });
  const { runner, calls } = recordingRunner({});
  await executePhasePlan(plan!, runner);
  const prompts = calls[0].agents.map((a) => a.prompt);
  assert.deepEqual(prompts, ['do x', 'do y', 'do z']);
});

test('executePhasePlan: honors dependsOn ordering regardless of declaration order', async () => {
  const { plan } = normalizePhasePlan({
    phases: [
      { id: 'c', agents: [{ prompt: 'c' }], dependsOn: ['b'] },
      { id: 'a', agents: [{ prompt: 'a' }] },
      { id: 'b', agents: [{ prompt: 'b' }], dependsOn: ['a'] },
    ],
  });
  const { runner, calls } = recordingRunner({});
  await executePhasePlan(plan!, runner);
  assert.deepEqual(calls.map((c) => c.phase), ['a', 'b', 'c']);
});

test('executePhasePlan: continue-on-failure — partial phase does not abort the run', async () => {
  const { plan } = normalizePhasePlan({
    phases: [
      { id: 'p1', agents: [{ prompt: 'a' }, { prompt: 'b' }] },
      { id: 'p2', agents: [{ prompt: 'c' }] },
    ],
  });
  const { runner } = recordingRunner({
    p1: () => [ok('a', 'worker', 'good'), { id: 'b', role: 'worker', status: 'failed', error: 'boom' }],
  });
  const result = await executePhasePlan(plan!, runner);
  assert.equal(result.phases[0].status, 'partial');
  assert.equal(result.phases[1].status, 'completed'); // p2 still ran
  assert.equal(result.status, 'partial');
});

test('executePhasePlan: all-failed phase is failed; plan status is failed', async () => {
  const { plan } = normalizePhasePlan({ phases: [{ id: 'p', agents: [{ prompt: 'a' }] }] });
  const { runner } = recordingRunner({
    p: () => [{ id: 'a', role: 'worker', status: 'failed', error: 'x' }],
  });
  const result = await executePhasePlan(plan!, runner);
  assert.equal(result.phases[0].status, 'failed');
  assert.equal(result.status, 'failed');
});

test('executePhasePlan: a runner that throws fails the phase but the run continues', async () => {
  const { plan } = normalizePhasePlan({
    phases: [
      { id: 'boom', agents: [{ prompt: 'a' }, { prompt: 'b' }] },
      { id: 'after', agents: [{ prompt: 'c' }] },
    ],
  });
  const runner: PhaseRunner = async (_agents, phase) => {
    if (phase.id === 'boom') throw new Error('spawn slot limit reached');
    return [ok('c', 'worker', 'ran')];
  };
  const result = await executePhasePlan(plan!, runner);
  assert.equal(result.phases[0].status, 'failed');
  assert.equal(result.phases[0].children.every((c) => c.error === 'spawn slot limit reached'), true);
  assert.equal(result.phases[1].status, 'completed'); // independent later phase still ran
  assert.equal(result.status, 'failed');
});

test('executePhasePlan: synthesize "none" concatenates raw outputs; "role-rollup" renders a roll-up', async () => {
  const none = normalizePhasePlan({ phases: [{ id: 'p', agents: [{ prompt: 'a' }, { prompt: 'b' }] }] }).plan!;
  const r1 = await executePhasePlan(none, recordingRunner({
    p: () => [ok('a', 'worker', 'OUT1'), ok('b', 'worker', 'OUT2')],
  }).runner);
  assert.equal(r1.phases[0].output, 'OUT1\n\n---\n\nOUT2');
  assert.equal(r1.phases[0].rollup, undefined);

  const roll = normalizePhasePlan({
    phases: [{ id: 'p', synthesize: 'role-rollup', agents: [{ role: 'reviewer', prompt: 'a' }] }],
  }).plan!;
  const r2 = await executePhasePlan(roll, recordingRunner({
    p: () => [ok('a', 'reviewer', 'a finding')],
  }).runner);
  assert.ok(r2.phases[0].rollup, 'rollup present when synthesizing');
  assert.equal(r2.phases[0].rollup!.total, 1);
  assert.match(r2.phases[0].output, /reviewer/); // renderSynthesis groups by role
});

test('executePhasePlan: fires onPhaseStart/onPhaseComplete hooks per phase in order', async () => {
  const { plan } = normalizePhasePlan({
    phases: [
      { id: 'one', agents: [{ prompt: 'a' }] },
      { id: 'two', agents: [{ prompt: 'b' }], dependsOn: ['one'] },
    ],
  });
  const starts: string[] = [];
  const completes: string[] = [];
  await executePhasePlan(plan!, recordingRunner({}).runner, {
    onPhaseStart: (phase, i, total) => {
      starts.push(`${phase.id}:${i}/${total}`);
    },
    onPhaseComplete: (exec) => {
      completes.push(`${exec.id}:${exec.status}`);
    },
  });
  assert.deepEqual(starts, ['one:0/2', 'two:1/2']);
  assert.deepEqual(completes, ['one:completed', 'two:completed']);
});

// MAS-READMANIFEST (B2/C3) — files a phase's children read are forwarded to the
// next phase's prompts so it reads deltas, not the whole tree cold.
import { renderReadManifest } from '../orchestration/phaseOrchestrator.js';

test('renderReadManifest: empty → empty; populated → an attributed block', () => {
  assert.equal(renderReadManifest(new Map()), '');
  const out = renderReadManifest(new Map([['src/x.ts', new Set(['plan(architect)'])]]));
  assert.match(out, /Files already mapped by prior phases/);
  assert.match(out, /src\/x\.ts — read by plan\(architect\)/);
});

test('executePhasePlan forwards a read-manifest into the next phase prompt', async () => {
  const plan = normalizePhasePlan({
    phases: [
      { id: 'plan', title: 'Plan', agents: [{ role: 'architect', prompt: 'design it' }] },
      { id: 'impl', title: 'Impl', agents: [{ role: 'worker', prompt: 'build it', access: 'write' }], dependsOn: ['plan'] },
    ],
  }).plan!;
  const { runner, calls } = recordingRunner({
    plan: () => [{ id: 'plan-0', role: 'architect', status: 'completed', finalOutput: 'plan', filesRead: ['src/a.ts', 'src/b.ts'] }],
  });
  await executePhasePlan(plan, runner);

  const planPrompt = calls.find((c) => c.phase === 'plan')!.agents[0].prompt;
  assert.doesNotMatch(planPrompt, /Files already mapped/, 'first phase has no prior reads');

  const implPrompt = calls.find((c) => c.phase === 'impl')!.agents[0].prompt;
  assert.match(implPrompt, /Files already mapped by prior phases/);
  assert.match(implPrompt, /src\/a\.ts — read by plan\(architect\)/);
  assert.match(implPrompt, /src\/b\.ts/);
});

test('WS6: executePhasePlan halts on an aborted signal — no further phases dispatched', async () => {
  const { plan } = normalizePhasePlan({
    phases: [
      { id: 'p1', agents: [{ role: 'worker', prompt: 'do p1' }] },
      { id: 'p2', agents: [{ role: 'worker', prompt: 'do p2' }], dependsOn: ['p1'] },
    ],
  });
  assert.ok(plan);
  const ac = new AbortController();
  ac.abort(); // a user Stop before the run dispatches anything
  const { runner, calls } = recordingRunner({});
  const result = await executePhasePlan(plan!, runner, { signal: ac.signal });
  assert.equal(calls.length, 0, 'no phase is dispatched once the signal is aborted');
  assert.equal(result.status, 'failed', 'an interrupted run is not reported as completed');
});

test('WS6: executePhasePlan runs normally when the signal is not aborted', async () => {
  const { plan } = normalizePhasePlan({ phases: [{ id: 'p1', agents: [{ role: 'worker', prompt: 'do p1' }] }] });
  assert.ok(plan);
  const ac = new AbortController(); // never aborted
  const { runner, calls } = recordingRunner({});
  const result = await executePhasePlan(plan!, runner, { signal: ac.signal });
  assert.equal(calls.length, 1, 'phase dispatched normally with a live signal');
  assert.equal(result.status, 'completed');
});
