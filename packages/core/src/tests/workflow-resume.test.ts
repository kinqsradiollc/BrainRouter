import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runWorkflow, resumeWorkflow } from '../workflow/template/workflowTool.js';
import { executePhasePlan, type PhaseRunner } from '../orchestration/phaseOrchestrator.js';
import { normalizePhasePlan } from '../orchestration/phasePlan.js';
import { ensurePhaseRun, advanceRunPhase, readRun } from '../workflow/run/workflowRun.js';

function tmpWs(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'brainrouter-wfresume-'));
}
const ctx = (workspaceRoot: string) => ({ workspaceRoot, parentSessionKey: 'resume' }) as any;

const PLAN = {
  title: 'resumable',
  phases: [
    { id: 'a', agents: [{ role: 'worker', prompt: 'do A' }] },
    { id: 'b', agents: [{ role: 'worker', prompt: 'use {{input}}' }], inputFrom: ['a'], dependsOn: ['a'] },
  ],
};

/** Records which phases the runner actually executes (+ the agents it saw). */
function recorder() {
  const calls: Array<{ phase: string; prompts: string[] }> = [];
  const runner: PhaseRunner = async (agents, phase) => {
    calls.push({ phase: phase.id, prompts: agents.map((x) => x.prompt) });
    return agents.map((x, i) => ({ id: `${phase.id}-${i}`, role: x.role ?? 'worker', status: 'completed', finalOutput: `R-${phase.id}` }));
  };
  return { runner, calls };
}

// ── engine-level resume (executePhasePlan) ───────────────────────────────────

test('WF-RESUME engine: skips completed phases, pre-seeds their output for {{input}}', async () => {
  const { plan } = normalizePhasePlan(PLAN);
  const { runner, calls } = recorder();
  const exec = await executePhasePlan(plan!, runner, {}, {
    completed: new Set(['a']),
    priorOutputs: new Map([['a', 'OUTPUT-A']]),
  });
  // phase a skipped (not run); only b executed.
  assert.deepEqual(calls.map((c) => c.phase), ['b']);
  // b's agent saw a's persisted output as {{input}}.
  assert.equal(calls[0].prompts[0], 'use OUTPUT-A');
  // a is still reported as completed in the execution.
  assert.equal(exec.phases.find((p) => p.id === 'a')?.status, 'completed');
  assert.equal(exec.status, 'completed');
});

// ── resumeWorkflow (reads the durable ledger) ─────────────────────────────────

test('WF-RESUME resumeWorkflow: re-runs only the interrupted phase, feeds prior output', async () => {
  const ws = tmpWs();
  // Seed a run as if phase a finished and phase b was interrupted by a crash.
  ensurePhaseRun(ws, 'r', [{ id: 'a', title: 'a' }, { id: 'b', title: 'b' }], {
    kind: 'workflow',
    planJson: JSON.stringify(PLAN),
  });
  advanceRunPhase(ws, 'r', 'a', 'completed', { childIds: ['c1'], aggregatedOutputRef: 'OUTPUT-A' });
  advanceRunPhase(ws, 'r', 'b', 'interrupted');

  const { runner, calls } = recorder();
  const out = JSON.parse(await resumeWorkflow('r', ctx(ws), { dispatch: async () => '{}', runner }));

  assert.equal(out.ok, true);
  assert.equal(out.resumed, true);
  assert.deepEqual(out.skipped, ['a']);
  assert.deepEqual(calls.map((c) => c.phase), ['b']); // only b re-ran
  assert.equal(calls[0].prompts[0], 'use OUTPUT-A'); // a's persisted output fed in
  const run = readRun(ws, 'r')!;
  assert.equal(run.status, 'completed');
});

test('WF-RESUME resumeWorkflow: errors on unknown run / missing plan', async () => {
  const ws = tmpWs();
  assert.equal(JSON.parse(await resumeWorkflow('nope', ctx(ws), { dispatch: async () => '{}' })).ok, false);
  // run with no planJson (e.g. created before WF-RESUME)
  ensurePhaseRun(ws, 'noplan', [{ id: 'a', title: 'a' }], { kind: 'workflow' });
  const out = JSON.parse(await resumeWorkflow('noplan', ctx(ws), { dispatch: async () => '{}' }));
  assert.equal(out.ok, false);
  assert.match(out.error, /no persisted plan/);
});

test('WF-RESUME resumeWorkflow: nothing to resume when all phases already completed', async () => {
  const ws = tmpWs();
  ensurePhaseRun(ws, 'done', [{ id: 'a', title: 'a' }], { kind: 'workflow', planJson: JSON.stringify({ phases: [{ id: 'a', agents: [{ prompt: 'x' }] }] }) });
  advanceRunPhase(ws, 'done', 'a', 'completed');
  const out = JSON.parse(await resumeWorkflow('done', ctx(ws), { dispatch: async () => '{}' }));
  assert.equal(out.ok, true);
  assert.equal(out.resumed, false);
});

test('WF-RESUME run_workflow({resume}) routes to resumeWorkflow', async () => {
  const ws = tmpWs();
  ensurePhaseRun(ws, 'route', [{ id: 'a', title: 'a' }, { id: 'b', title: 'b' }], { kind: 'workflow', planJson: JSON.stringify(PLAN) });
  advanceRunPhase(ws, 'route', 'a', 'completed', { aggregatedOutputRef: 'OA' });
  advanceRunPhase(ws, 'route', 'b', 'interrupted');
  const { runner } = recorder();
  const out = JSON.parse(await runWorkflow({ resume: 'route' }, ctx(ws), { dispatch: async () => '{}', runner }));
  assert.equal(out.ok, true);
  assert.equal(out.resumed, true);
});
