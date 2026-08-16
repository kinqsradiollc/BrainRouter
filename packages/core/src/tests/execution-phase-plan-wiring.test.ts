/**
 * ADR-040 A40-7 — the phase-plan runtime is WIRED to the canonical map.
 *
 * The adapter's own test proves the mapping; this proves the wiring: a real
 * `runWorkflow` invocation composes the canonical emitter into its live hooks,
 * so a phase-plan run leaves a durable execution-map record behind — and does
 * so STRICTLY best-effort, so a durable-store failure drops the mirror, never
 * the run it was only describing.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runWorkflow } from '../workflow/template/workflowTool.js';
import type { PhaseRunner } from '../orchestration/workflow/phaseOrchestrator.js';
import { readDurableRunSafe, readDurableRunResumeState } from '../orchestration/execution/runStore.js';

function tmpWs(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'brainrouter-a40wire-'));
}
const ctx = (workspaceRoot: string) => ({ workspaceRoot, parentSessionKey: 'sess-wire' }) as any;

// A linear two-phase plan, the shape `/build` runs.
const PLAN = {
  title: 'Wire Check',
  phases: [
    { id: 'plan', agents: [{ role: 'architect', prompt: 'plan it' }] },
    { id: 'build', agents: [{ role: 'worker', prompt: 'build it' }], dependsOn: ['plan'] },
  ],
};
const SLUG = 'wire-check';

const okRunner: PhaseRunner = async (agents, phase) =>
  agents.map((a, i) => ({ id: `${phase.id}-${i}`, role: a.role ?? 'worker', status: 'completed', finalOutput: `done:${phase.id}` }));

test('A40-7 wiring — a completed phase-plan run is mirrored into the durable execution map', async () => {
  const ws = tmpWs();
  const out = JSON.parse(await runWorkflow({ plan: PLAN }, ctx(ws), { dispatch: async () => '{}', runner: okRunner }));
  assert.equal(out.ok, true);
  assert.equal(out.slug, SLUG);

  // The canonical durable run exists, and its terminal status is the honest
  // projection of the phase-plan result — succeeded, not merely "it ran".
  const safe = readDurableRunSafe(ws, SLUG)!;
  assert.ok(safe, 'a durable run was recorded for the phase-plan run');
  assert.equal(safe.status, 'succeeded');
  assert.equal(safe.executionId, SLUG);
  assert.ok(safe.endedAt, 'finish() stamped a terminal time');

  // running + (start,complete)×2 phases + finish = 6 persisted emissions. This
  // count is what fails if the per-phase hook composition is ever dropped: a
  // bare construct+finish would persist only 2.
  const resume = readDurableRunResumeState(ws, SLUG)!;
  assert.deepEqual(resume.resumeState, { lastSequence: 6 });
});

test('A40-7 wiring — a durable-store collision drops the mirror, never the run', async () => {
  const ws = tmpWs();
  // Pre-occupy the run's exclusive-create target so startDurableRun throws.
  const runDir = path.join(ws, '.brainrouter', 'runs', SLUG);
  fs.mkdirSync(runDir, { recursive: true });
  const squatted = JSON.stringify({ squatter: true });
  fs.writeFileSync(path.join(runDir, 'safe.json'), squatted);

  const out = JSON.parse(await runWorkflow({ plan: PLAN }, ctx(ws), { dispatch: async () => '{}', runner: okRunner }));
  // The run still completes: canonical construction threw and was swallowed.
  assert.equal(out.ok, true);
  assert.equal(out.status, 'completed');
  // And it did not clobber the pre-existing file — it truly bailed, rather than
  // catching the throw only after a partial write.
  assert.equal(fs.readFileSync(path.join(runDir, 'safe.json'), 'utf8'), squatted);
});
