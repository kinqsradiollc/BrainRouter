import test from 'node:test';
import assert from 'node:assert/strict';
import { buildWorkflowRunKickoff, parseTemplateArgs, renderPhaseTimelineLines } from '../cli/commands/workflowLaunch/index.js';
import type { WorkflowRun } from '@kinqs/brainrouter-core/workflow';

// ── buildWorkflowRunKickoff ──────────────────────────────────────────────────

test('WF-LAUNCH buildWorkflowRunKickoff: valid template → run_workflow kickoff prompt', () => {
  const r = buildWorkflowRunKickoff('compare', { targets: ['A', 'B'] }, 'run-a1b2c3');
  assert.equal(r.ok, true);
  if (r.ok) {
    assert.match(r.prompt, /run_workflow/);
    assert.match(r.prompt, /template="compare"/);
    assert.match(r.prompt, /"targets":\["A","B"\]/);
    assert.match(r.prompt, /slug="run-a1b2c3"/);
    assert.deepEqual(r.toolArgs, {
      template: 'compare',
      templateArgs: { targets: ['A', 'B'] },
      slug: 'run-a1b2c3',
    });
  }
});

test('WF-LAUNCH buildWorkflowRunKickoff: empty template → usage error (lists templates)', () => {
  const r = buildWorkflowRunKickoff('', {}, 'run-a1b2c3');
  assert.equal(r.ok, false);
  if (!r.ok) {
    assert.match(r.error, /Usage/);
    assert.match(r.error, /compare/);
  }
});

test('WF-LAUNCH buildWorkflowRunKickoff: invalid args → template error, no launch', () => {
  const r = buildWorkflowRunKickoff('compare', { targets: ['only-one'] }, 'run-a1b2c3'); // needs ≥2
  assert.equal(r.ok, false);
  if (!r.ok) assert.match(r.error, /targets/);
});

test('WF-LAUNCH buildWorkflowRunKickoff: oversized template fan-out is rejected before launch', () => {
  const r = buildWorkflowRunKickoff(
    'compare',
    { targets: Array.from({ length: 17 }, (_, index) => `target-${index}`) },
    'run-a1b2c3',
  );
  assert.equal(r.ok, false);
  if (!r.ok) assert.match(r.error, /16-child limit/i);
});

test('WF-LAUNCH buildWorkflowRunKickoff: malformed or oversized slug fails before launch', () => {
  for (const slug of ['Uppercase', 'run_with_underscore', `run-${'a'.repeat(45)}`]) {
    const r = buildWorkflowRunKickoff('compare', { targets: ['A', 'B'] }, slug);
    assert.equal(r.ok, false, `slug ${slug} must be rejected`);
  }
});

// ── parseTemplateArgs ────────────────────────────────────────────────────────

test('WF-LAUNCH parseTemplateArgs: JSON blob, key=val pairs, comma lists, empty', () => {
  assert.deepEqual(parseTemplateArgs('{"targets":["a","b"]}'), { targets: ['a', 'b'] });
  assert.deepEqual(parseTemplateArgs('question=Is_X_fast'), { question: 'Is_X_fast' });
  assert.deepEqual(parseTemplateArgs('paths=src/a,src/b focus=security'), { paths: ['src/a', 'src/b'], focus: 'security' });
  assert.deepEqual(parseTemplateArgs(''), {});
  assert.deepEqual(parseTemplateArgs('{bad json'), {}); // tolerant
});

// ── renderPhaseTimelineLines ─────────────────────────────────────────────────

const phaseRun = (): WorkflowRun => ({
  slug: 'w',
  kind: 'workflow',
  status: 'running',
  sessionKey: null,
  pid: 1,
  startedAt: '2026-06-02T00:00:00.000Z',
  updatedAt: '2026-06-02T00:02:00.000Z',
  steps: [],
  currentStepId: null,
  phases: [
    { id: 'review', title: 'Review', status: 'completed', childIds: ['c1', 'c2'], startedAt: '2026-06-02T00:00:00.000Z', endedAt: '2026-06-02T00:01:00.000Z' },
    { id: 'synth', title: 'Synthesize', status: 'running', childIds: [], startedAt: '2026-06-02T00:01:00.000Z' },
  ],
});

test('WF-LAUNCH renderPhaseTimelineLines: phase-aware run → header + per-phase lines', () => {
  const lines = renderPhaseTimelineLines(phaseRun());
  assert.equal(lines.length, 3); // header + 2 phases
  assert.match(lines[0], /phases:/);
  assert.match(lines[0], /1\/2/); // 1 of 2 done
  assert.match(lines[1], /Review/);
  assert.match(lines[1], /2 agents/); // childIds count surfaced
  assert.match(lines[2], /Synthesize/);
});

test('WF-LAUNCH renderPhaseTimelineLines: step-only run → [] (falls back to step view)', () => {
  const stepRun = { ...phaseRun(), phases: undefined } as WorkflowRun;
  assert.deepEqual(renderPhaseTimelineLines(stepRun), []);
});
