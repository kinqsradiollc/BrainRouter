import test from 'node:test';
import assert from 'node:assert/strict';
import { buildWorkflowRunKickoff, parseTemplateArgs, renderPhaseTimelineLines } from '../cli/commands/workflowLaunch.js';
import type { WorkflowRun } from '../state/workflowRun.js';

// ── buildWorkflowRunKickoff ──────────────────────────────────────────────────

test('WF-LAUNCH buildWorkflowRunKickoff: valid template → run_workflow kickoff prompt', () => {
  const r = buildWorkflowRunKickoff('compare', { targets: ['A', 'B'] });
  assert.equal(r.ok, true);
  if (r.ok) {
    assert.match(r.prompt, /run_workflow/);
    assert.match(r.prompt, /template="compare"/);
    assert.match(r.prompt, /"targets":\["A","B"\]/);
  }
});

test('WF-LAUNCH buildWorkflowRunKickoff: empty template → usage error (lists templates)', () => {
  const r = buildWorkflowRunKickoff('', {});
  assert.equal(r.ok, false);
  if (!r.ok) {
    assert.match(r.error, /Usage/);
    assert.match(r.error, /compare/);
  }
});

test('WF-LAUNCH buildWorkflowRunKickoff: invalid args → template error, no launch', () => {
  const r = buildWorkflowRunKickoff('compare', { targets: ['only-one'] }); // needs ≥2
  assert.equal(r.ok, false);
  if (!r.ok) assert.match(r.error, /targets/);
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
