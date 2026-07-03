import test from 'node:test';
import assert from 'node:assert/strict';
import { createWorkflowService, WorkflowService } from '../workflow/template/service.js';
import {
  stepTemplateForKind, computeRunStatus, applyStepTransition, stepGlyph, formatRunGlyphs,
  formatDuration, summarizeRun, staleRunSlugs, type WorkflowRun, type WorkflowRunStep,
} from '../workflow/run/workflowRun.js';
import { buildTemplatePlan } from '../workflow/template/workflowTemplates.js';

test('WorkflowService is a stateless facade — delegates to the workflow run-model', () => {
  const svc = createWorkflowService();
  assert.ok(svc instanceof WorkflowService);

  assert.deepEqual(svc.stepTemplate('build'), stepTemplateForKind('build'));

  const steps: WorkflowRunStep[] = [
    { id: 's1', title: 'Step 1', status: 'pending' },
    { id: 's2', title: 'Step 2', status: 'pending' },
  ];
  const now = '2020-01-01T00:00:00.000Z';
  const after = svc.applyStepTransition(steps, 's1', 'done', now);
  assert.equal(after[0].status, 'done');
  assert.deepEqual(after, applyStepTransition(steps, 's1', 'done', now));

  assert.equal(svc.computeRunStatus(after), computeRunStatus(after));
  assert.equal(svc.stepGlyph('done'), stepGlyph('done'));
  assert.equal(svc.formatDuration(now, '2020-01-01T00:00:05.000Z'), formatDuration(now, '2020-01-01T00:00:05.000Z'));

  const run: WorkflowRun = {
    slug: 'r1', kind: 'build', status: 'running', sessionKey: null, pid: process.pid,
    startedAt: now, updatedAt: now, steps: after, currentStepId: 's2',
  };
  assert.deepEqual(svc.summarizeRun(run), summarizeRun(run));
  assert.equal(svc.formatGlyphs(run), formatRunGlyphs(run));
  assert.deepEqual(svc.staleRunSlugs([run], () => true), staleRunSlugs([run], () => true));

  // buildTemplatePlan: prove identical behaviour whether it returns or throws.
  const call = (fn: () => unknown): string => {
    try { return 'OK:' + JSON.stringify(fn()); } catch (e) { return 'THREW:' + (e as Error).message; }
  };
  assert.equal(call(() => svc.buildTemplatePlan('build', {})), call(() => buildTemplatePlan('build', {})));
});
