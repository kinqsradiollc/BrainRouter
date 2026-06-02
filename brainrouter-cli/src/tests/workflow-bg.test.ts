import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runWorkflow } from '../orchestration/workflowTool.js';
import type { PhaseRunner } from '../orchestration/phaseOrchestrator.js';
import { ensurePhaseRun, advanceRunPhase, readRun } from '../state/workflowRun.js';
import { collectRunningTasks } from '../runtime/backgroundTasks.js';

function tmpWs(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'brainrouter-wfbg-'));
}
const ctx = (workspaceRoot: string) => ({ workspaceRoot, parentSessionKey: 'bg' }) as any;
const tick = () => new Promise((resolve) => setTimeout(resolve, 50));

const PLAN = {
  title: 'bg run',
  phases: [
    { id: 'p1', agents: [{ role: 'worker', prompt: 'a' }] },
    { id: 'p2', agents: [{ role: 'worker', prompt: 'b' }], dependsOn: ['p1'] },
  ],
};
const fastRunner: PhaseRunner = async (agents, phase) =>
  agents.map((a, i) => ({ id: `${phase.id}-${i}`, role: a.role ?? 'worker', status: 'completed', finalOutput: 'ok' }));

test('WF-BG run_workflow background returns immediately, then completes detached', async () => {
  const ws = tmpWs();
  const raw = await runWorkflow({ plan: PLAN, background: true }, ctx(ws), { dispatch: async () => '{}', runner: fastRunner });
  const out = JSON.parse(raw);
  // Returns right away, before phases finish.
  assert.equal(out.ok, true);
  assert.equal(out.background, true);
  assert.equal(out.status, 'running');
  // The run is seeded + visible immediately.
  assert.ok(readRun(ws, out.slug), 'run ledger seeded synchronously');

  // The detached execution finishes on its own.
  await tick();
  const run = readRun(ws, out.slug)!;
  assert.equal(run.status, 'completed');
  assert.equal(run.phases?.every((p) => p.status === 'completed'), true);
});

test('WF-BG background failure marks the run failed (does not throw to the caller)', async () => {
  const ws = tmpWs();
  const throwingRunner: PhaseRunner = async () => {
    throw new Error('boom');
  };
  const raw = await runWorkflow({ plan: PLAN, background: true }, ctx(ws), { dispatch: async () => '{}', runner: throwingRunner });
  assert.equal(JSON.parse(raw).ok, true); // caller still gets a clean start ack
  await tick();
  // A runner that throws fails each phase; the run reflects failed/completed-with-failure, never running forever.
  const run = readRun(ws, JSON.parse(raw).slug)!;
  assert.notEqual(run.status, 'running');
});

test('WF-BG background panel surfaces phase progress in the label', async () => {
  const ws = tmpWs();
  ensurePhaseRun(ws, 'wf-panel', [{ id: 'a', title: 'A' }, { id: 'b', title: 'B' }], { kind: 'workflow', pid: process.pid });
  advanceRunPhase(ws, 'wf-panel', 'a', 'completed');
  advanceRunPhase(ws, 'wf-panel', 'b', 'running');

  const tasks = collectRunningTasks(ws);
  const wf = tasks.find((t) => t.kind === 'workflow' && t.id === 'wf-panel');
  assert.ok(wf, 'workflow run shows in the background panel');
  assert.match(wf!.label, /phase 1\/2/);
});
