import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  chunkIntoWaves,
  workflowSlug,
  defaultPhaseRunner,
  runWorkflow,
  type OrchestrationDispatch,
} from '../workflow/workflowTool.js';
import type { PhaseRunner } from '../orchestration/phaseOrchestrator.js';
import { readRun } from '../workflow/workflowRun.js';

function tmpWs(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'brainrouter-wftool-'));
}
const ctx = (workspaceRoot: string) => ({ workspaceRoot, parentSessionKey: 'test-parent' }) as any;

const PLAN = {
  title: 'Compare and recommend',
  phases: [
    { id: 'review', fanOut: { over: ['a', 'b'], agent: { role: 'reviewer', prompt: 'Review {{target}}' } } },
    { id: 'synth', agents: [{ role: 'architect', prompt: 'Recommend from {{input}}' }], inputFrom: ['review'], dependsOn: ['review'] },
  ],
};

// ── chunkIntoWaves / workflowSlug (pure) ─────────────────────────────────────

test('WF-TOOL chunkIntoWaves splits into ≤cap waves', () => {
  assert.deepEqual(chunkIntoWaves([1, 2, 3, 4, 5], 2), [[1, 2], [3, 4], [5]]);
  assert.deepEqual(chunkIntoWaves([1, 2], 5), [[1, 2]]);
  assert.deepEqual(chunkIntoWaves([], 3), []);
  assert.deepEqual(chunkIntoWaves([1, 2, 3], 0), [[1], [2], [3]]); // cap floored to 1
});

test('WF-TOOL workflowSlug derives a filesystem-safe slug', () => {
  assert.equal(workflowSlug({ slug: 'My Run!' }, { phases: [] }), 'my-run');
  assert.equal(workflowSlug({}, { title: 'Compare A vs B', phases: [] }), 'compare-a-vs-b');
  assert.equal(workflowSlug({}, { phases: [] }), 'workflow');
});

// ── defaultPhaseRunner wiring (fake dispatch) ────────────────────────────────

test('WF-TOOL defaultPhaseRunner spawns per wave and maps wait results', async () => {
  const calls: string[] = [];
  const dispatch: OrchestrationDispatch = async (name, args: any) => {
    calls.push(name);
    if (name === 'spawn_agents') {
      return JSON.stringify({ agents: args.agents.map((_: unknown, i: number) => ({ id: `${calls.length}-c${i}` })) });
    }
    if (name === 'wait_agents') {
      return JSON.stringify({
        agents: args.ids.map((id: string) => ({ id, role: 'reviewer', status: 'completed', finalOutput: `out:${id}` })),
      });
    }
    return '{}';
  };
  const runner = defaultPhaseRunner(ctx('/tmp/none'), dispatch, 2);
  const agents = Array.from({ length: 5 }, (_, i) => ({ prompt: `p${i}`, access: 'read' as const }));
  const results = await runner(agents, { id: 'p', title: 'P' } as any);

  // 5 agents, cap 2 → 3 spawn waves (2+2+1), each followed by a wait
  assert.equal(calls.filter((c) => c === 'spawn_agents').length, 3);
  assert.equal(calls.filter((c) => c === 'wait_agents').length, 3);
  assert.equal(results.length, 5);
  assert.equal(results.every((r) => r.status === 'completed'), true);
});

test('WF-TOOL defaultPhaseRunner records failed children when spawn returns no id', async () => {
  const dispatch: OrchestrationDispatch = async (name) => (name === 'spawn_agents' ? JSON.stringify({ agents: [] }) : '{}');
  const runner = defaultPhaseRunner(ctx('/tmp/none'), dispatch, 4);
  const results = await runner([{ prompt: 'x' }, { prompt: 'y' }], { id: 'p', title: 'P' } as any);
  assert.equal(results.length, 2);
  assert.equal(results.every((r) => r.status === 'failed'), true);
});

// ── runWorkflow handler (fake runner + real persistence) ─────────────────────

test('WF-TOOL runWorkflow executes a plan, persists phases, returns a summary', async () => {
  const ws = tmpWs();
  const fakeRunner: PhaseRunner = async (agents, phase) =>
    agents.map((a, i) => ({ id: `${phase.id}-${i}`, role: a.role ?? 'worker', status: 'completed', finalOutput: `done:${a.prompt}` }));

  const raw = await runWorkflow({ plan: PLAN }, ctx(ws), { dispatch: async () => '{}', runner: fakeRunner });
  const out = JSON.parse(raw);

  assert.equal(out.ok, true);
  assert.equal(out.slug, 'compare-and-recommend');
  assert.equal(out.status, 'completed');
  assert.equal(out.phases.length, 2);
  assert.equal(out.phases[0].children, 2); // fan-out over [a,b]

  // Persisted + crash-safe: run.json reflects both phases completed.
  const run = readRun(ws, 'compare-and-recommend')!;
  assert.ok(run);
  assert.equal(run.status, 'completed');
  assert.equal(run.phases?.length, 2);
  assert.equal(run.phases?.every((p) => p.status === 'completed'), true);
  // phase 1's child ids were recorded
  assert.equal(run.phases?.find((p) => p.id === 'review')?.childIds.length, 2);
});

test('WF-TOOL runWorkflow rejects an invalid plan without starting a run', async () => {
  const ws = tmpWs();
  const raw = await runWorkflow({ plan: { phases: [] } }, ctx(ws), { dispatch: async () => '{}' });
  const out = JSON.parse(raw);
  assert.equal(out.ok, false);
  assert.match(out.error, /invalid/i);
  assert.ok(Array.isArray(out.details));
});

test('WF-TOOL runWorkflow injects prior-phase synthesis as {{input}} (via fake runner capture)', async () => {
  const ws = tmpWs();
  const seen: Record<string, string> = {};
  const fakeRunner: PhaseRunner = async (agents, phase) => {
    seen[phase.id] = agents[0].prompt;
    return agents.map((a, i) => ({ id: `${phase.id}-${i}`, role: a.role ?? 'worker', status: 'completed', finalOutput: `R-${phase.id}` }));
  };
  await runWorkflow({ plan: PLAN }, ctx(ws), { dispatch: async () => '{}', runner: fakeRunner });
  // synth phase (synthesize:none on review → raw outputs concatenated) sees review's outputs
  assert.match(seen['synth'], /R-review/);
});
