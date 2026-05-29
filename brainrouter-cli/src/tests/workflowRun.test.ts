import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createWorkflow } from '../state/workflowArtifacts.js';
import {
  stepTemplateForKind,
  computeRunStatus,
  applyStepTransition,
  summarizeRun,
  stepGlyph,
  formatRunGlyphs,
  formatDuration,
  staleRunSlugs,
  ensureRun,
  advanceRunStep,
  readRun,
  listRuns,
  reconcileStaleRuns,
  type WorkflowRunStep,
} from '../state/workflowRun.js';

function tmpWs(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'brainrouter-wfrun-'));
}
function steps(...specs: Array<[string, WorkflowRunStep['status']]>): WorkflowRunStep[] {
  return specs.map(([id, status]) => ({ id, title: id, status }));
}

// ── Pure model ──────────────────────────────────────────────────────────────

test('PARITY-W1 stepTemplateForKind: known kinds + default', () => {
  assert.equal(stepTemplateForKind('review').length, 7);
  assert.equal(stepTemplateForKind('simplify').length, 3);
  assert.equal(stepTemplateForKind('feature-dev').length, 5);
  assert.deepEqual(stepTemplateForKind('whatever'), [{ id: 'execute', title: 'Execute' }]);
});

test('PARITY-W1 computeRunStatus: failed > completed > running', () => {
  assert.equal(computeRunStatus(steps(['a', 'done'], ['b', 'failed'])), 'failed');
  assert.equal(computeRunStatus(steps(['a', 'done'], ['b', 'skipped'])), 'completed');
  assert.equal(computeRunStatus(steps(['a', 'done'], ['b', 'pending'])), 'running');
  assert.equal(computeRunStatus([]), 'running'); // empty never auto-completes
});

test('PARITY-W1 applyStepTransition: updates known step + stamps times', () => {
  const base = steps(['a', 'pending'], ['b', 'pending']);
  const running = applyStepTransition(base, 'a', 'running', '2026-01-01T00:00:00Z');
  assert.equal(running[0].status, 'running');
  assert.equal(running[0].startedAt, '2026-01-01T00:00:00Z');
  assert.equal(running[0].endedAt, undefined);
  const done = applyStepTransition(running, 'a', 'done', '2026-01-01T00:05:00Z', 'shipped');
  assert.equal(done[0].status, 'done');
  assert.equal(done[0].startedAt, '2026-01-01T00:00:00Z'); // preserved
  assert.equal(done[0].endedAt, '2026-01-01T00:05:00Z');
  assert.equal(done[0].note, 'shipped');
});

test('PARITY-W1 applyStepTransition: appends unknown step id', () => {
  const out = applyStepTransition(steps(['a', 'done']), 'extra', 'running', '2026-01-01T00:00:00Z');
  assert.equal(out.length, 2);
  assert.equal(out[1].id, 'extra');
  assert.equal(out[1].status, 'running');
});

test('PARITY-W1 summarizeRun + staleRunSlugs', () => {
  const run = {
    slug: 's', kind: 'review', status: 'running' as const, sessionKey: null, pid: 1,
    startedAt: 'x', updatedAt: 'x', currentStepId: 'b',
    steps: steps(['a', 'done'], ['b', 'running'], ['c', 'pending']),
  };
  assert.deepEqual(summarizeRun(run), { done: 1, total: 3, current: 'b' });
  assert.deepEqual(
    staleRunSlugs([run, { ...run, slug: 'alive', pid: 42 }], (pid) => pid === 42),
    ['s'],
  );
});

test('PARITY-W2 stepGlyph + formatRunGlyphs + formatDuration (pure viewer helpers)', () => {
  assert.equal(stepGlyph('done'), '✓');
  assert.equal(stepGlyph('running'), '▶');
  assert.equal(stepGlyph('failed'), '✗');
  assert.equal(stepGlyph('skipped'), '⊘');
  assert.equal(stepGlyph('pending'), '·');
  const run = {
    slug: 's', kind: 'simplify', status: 'running' as const, sessionKey: null, pid: 1,
    startedAt: 'x', updatedAt: 'x', currentStepId: null,
    steps: steps(['a', 'done'], ['b', 'running'], ['c', 'pending']),
  };
  assert.equal(formatRunGlyphs(run), '✓▶·');
  assert.equal(formatDuration('2026-01-01T00:00:00Z', '2026-01-01T00:00:45Z'), '45s');
  assert.equal(formatDuration('2026-01-01T00:00:00Z', '2026-01-01T00:02:05Z'), '2m 5s');
  assert.equal(formatDuration('2026-01-01T00:00:00Z', '2026-01-01T03:05:00Z'), '3h 5m');
  assert.equal(formatDuration(undefined, 'x'), '—');
});

// ── File-backed store ─────────────────────────────────────────────────────────

test('PARITY-W1 ensureRun: lazy + idempotent, seeds kind template', () => {
  const ws = tmpWs();
  const { slug } = createWorkflow(ws, { title: 'Review the diff', kind: 'review' });
  assert.equal(readRun(ws, slug), null); // not created until reported
  const run = ensureRun(ws, slug, { now: '2026-01-01T00:00:00Z' });
  assert.equal(run.steps.length, 7);
  assert.ok(run.steps.every((s) => s.status === 'pending'));
  assert.equal(run.status, 'running');
  const again = ensureRun(ws, slug, { now: '2026-02-02T00:00:00Z' });
  assert.equal(again.startedAt, '2026-01-01T00:00:00Z'); // idempotent
});

test('PARITY-W1 advanceRunStep: lazy-inits, transitions, completes', () => {
  const ws = tmpWs();
  const { slug } = createWorkflow(ws, { title: 'Tidy up', kind: 'simplify' });
  advanceRunStep(ws, slug, 'map', 'running'); // creates the run
  let run = readRun(ws, slug)!;
  assert.equal(run.currentStepId, 'map');
  assert.equal(run.status, 'running');
  for (const id of ['map', 'rank', 'apply']) advanceRunStep(ws, slug, id, 'done');
  run = readRun(ws, slug)!;
  assert.equal(run.status, 'completed');
  assert.ok(run.steps.every((s) => s.status === 'done'));
});

test('PARITY-W1 reconcileStaleRuns: dead-pid running → interrupted; alive untouched', () => {
  const ws = tmpWs();
  const dead = createWorkflow(ws, { title: 'Crashed run', kind: 'review' }).slug;
  const alive = createWorkflow(ws, { title: 'Live run', kind: 'review' }).slug;
  advanceRunStep(ws, dead, 'triage', 'running', { pid: 111 });
  advanceRunStep(ws, alive, 'triage', 'running', { pid: 222 });
  const n = reconcileStaleRuns(ws, 222); // pid 222 is "this process"
  assert.equal(n, 1);
  assert.equal(readRun(ws, dead)!.status, 'interrupted');
  assert.equal(readRun(ws, alive)!.status, 'running');
  assert.equal(listRuns(ws).length, 2);
});
