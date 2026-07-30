import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  computePhaseRunStatus,
  applyPhaseTransition,
  interruptInFlightPhases,
  phaseRunGlyph,
  summarizePhases,
  ensurePhaseRun,
  advanceRunPhase,
  readRun,
  reconcileStaleRuns,
  type WorkflowRunPhase,
  type WorkflowRun,
} from '../workflow/run/workflowRun.js';

function tmpWs(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'brainrouter-wfphase-'));
}
function phases(...specs: Array<[string, WorkflowRunPhase['status']]>): WorkflowRunPhase[] {
  return specs.map(([id, status]) => ({ id, title: id, status, childIds: [] }));
}
const NOW = '2026-06-02T00:00:00.000Z';

// ── Pure model ────────────────────────────────────────────────────────────

test('WF-PERSIST computePhaseRunStatus: running > interrupted > failed > completed', () => {
  assert.equal(computePhaseRunStatus([]), 'running'); // empty never auto-completes
  assert.equal(computePhaseRunStatus(phases(['a', 'completed'], ['b', 'running'])), 'running');
  assert.equal(computePhaseRunStatus(phases(['a', 'completed'], ['b', 'pending'])), 'running');
  assert.equal(computePhaseRunStatus(phases(['a', 'completed'], ['b', 'interrupted'])), 'interrupted');
  assert.equal(computePhaseRunStatus(phases(['a', 'completed'], ['b', 'failed'])), 'failed');
  // interrupted outranks failed when both terminal
  assert.equal(computePhaseRunStatus(phases(['a', 'failed'], ['b', 'interrupted'])), 'interrupted');
  // partial counts as a clean finish at run level
  assert.equal(computePhaseRunStatus(phases(['a', 'completed'], ['b', 'partial'])), 'completed');
});

test('WF-PERSIST applyPhaseTransition: stamps timestamps, merges childIds + ref', () => {
  let p = phases(['review', 'pending']);
  p = applyPhaseTransition(p, 'review', 'running', NOW);
  assert.equal(p[0].status, 'running');
  assert.equal(p[0].startedAt, NOW);
  assert.equal(p[0].endedAt, undefined);

  const later = '2026-06-02T00:05:00.000Z';
  p = applyPhaseTransition(p, 'review', 'completed', later, {
    childIds: ['c1', 'c2'],
    aggregatedOutputRef: 'working:ref-123',
  });
  assert.equal(p[0].status, 'completed');
  assert.equal(p[0].startedAt, NOW); // preserved
  assert.equal(p[0].endedAt, later);
  assert.deepEqual(p[0].childIds, ['c1', 'c2']);
  assert.equal(p[0].aggregatedOutputRef, 'working:ref-123');
});

test('WF-PERSIST applyPhaseTransition: appends an unknown phase id', () => {
  const p = applyPhaseTransition([], 'surprise', 'running', NOW);
  assert.equal(p.length, 1);
  assert.equal(p[0].id, 'surprise');
  assert.equal(p[0].title, 'surprise');
  assert.equal(p[0].status, 'running');
});

test('WF-PERSIST interruptInFlightPhases: flips pending/running, leaves terminal alone', () => {
  const p = interruptInFlightPhases(
    phases(['a', 'completed'], ['b', 'running'], ['c', 'pending'], ['d', 'failed']),
    NOW,
  );
  assert.deepEqual(p.map((x) => x.status), ['completed', 'interrupted', 'interrupted', 'failed']);
  assert.equal(p[1].endedAt, NOW);
});

test('WF-PERSIST phaseRunGlyph + summarizePhases', () => {
  assert.equal(phaseRunGlyph('completed'), '✓');
  assert.equal(phaseRunGlyph('partial'), '◑');
  assert.equal(phaseRunGlyph('interrupted'), '⚠');
  const run = { phases: phases(['a', 'completed'], ['b', 'running'], ['c', 'pending']) } as WorkflowRun;
  assert.deepEqual(summarizePhases(run), { done: 1, total: 3, current: 'b' });
});

// ── File-backed ─────────────────────────────────────────────────────────────

test('WF-PERSIST ensurePhaseRun seeds pending phases and is idempotent', () => {
  const ws = tmpWs();
  const run = ensurePhaseRun(ws, 'wf1', [{ id: 'review', title: 'Review' }, { id: 'synth', title: 'Synthesize' }], {
    kind: 'workflow',
    pid: process.pid,
  });
  assert.equal(run.status, 'running');
  assert.equal(run.phases?.length, 2);
  assert.equal(run.phases?.every((p) => p.status === 'pending'), true);
  // idempotent: a second call returns the same (doesn't reset)
  const again = ensurePhaseRun(ws, 'wf1', [{ id: 'review', title: 'Review' }], { kind: 'workflow' });
  assert.equal(again.phases?.length, 2);
});

test('WF-PERSIST advanceRunPhase updates a phase + persists to disk', () => {
  const ws = tmpWs();
  ensurePhaseRun(ws, 'wf2', [{ id: 'p1', title: 'One' }, { id: 'p2', title: 'Two' }], { kind: 'workflow', pid: process.pid });
  advanceRunPhase(ws, 'wf2', 'p1', 'running');
  let run = readRun(ws, 'wf2')!;
  assert.equal(run.status, 'running');
  assert.equal(run.phases?.find((p) => p.id === 'p1')?.status, 'running');

  advanceRunPhase(ws, 'wf2', 'p1', 'completed', { childIds: ['child-a', 'child-b'], aggregatedOutputRef: 'ref:1' });
  advanceRunPhase(ws, 'wf2', 'p2', 'completed');
  run = readRun(ws, 'wf2')!;
  assert.equal(run.status, 'completed'); // all phases terminal & none failed
  const p1 = run.phases!.find((p) => p.id === 'p1')!;
  assert.deepEqual(p1.childIds, ['child-a', 'child-b']);
  assert.equal(p1.aggregatedOutputRef, 'ref:1');
});

test('WF-PERSIST reconcileStaleRuns interrupts a dead run AND its in-flight phase', () => {
  const ws = tmpWs();
  // pid that is not us → counts as dead under reconcile(currentPid=process.pid)
  ensurePhaseRun(ws, 'wf3', [{ id: 'a', title: 'A' }, { id: 'b', title: 'B' }], { kind: 'workflow', pid: 999_999 });
  advanceRunPhase(ws, 'wf3', 'a', 'completed');
  advanceRunPhase(ws, 'wf3', 'b', 'running'); // in-flight when the process "died"

  const reconciled = reconcileStaleRuns(ws, process.pid);
  assert.equal(reconciled, 1);
  const run = readRun(ws, 'wf3')!;
  assert.equal(run.status, 'interrupted');
  assert.equal(run.phases?.find((p) => p.id === 'a')?.status, 'completed'); // done phase preserved
  assert.equal(run.phases?.find((p) => p.id === 'b')?.status, 'interrupted'); // in-flight flipped
});
