import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildTemplatePlan, WORKFLOW_TEMPLATES } from '../orchestration/workflowTemplates.js';
import { normalizePhasePlan } from '../orchestration/phasePlan.js';
import { runWorkflow } from '../orchestration/workflowTool.js';
import type { PhaseRunner } from '../orchestration/phaseOrchestrator.js';
import { readRun } from '../state/workflowRun.js';

function tmpWs(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'brainrouter-wftpl-'));
}
const ctx = (workspaceRoot: string) => ({ workspaceRoot, parentSessionKey: 'tpl' }) as any;
const fakeRunner: PhaseRunner = async (agents, phase) =>
  agents.map((a, i) => ({ id: `${phase.id}-${i}`, role: a.role ?? 'worker', status: 'completed', finalOutput: `R-${phase.id}` }));

/** A template plan must always pass the real validator. */
function assertValid(name: string, args: unknown) {
  const built = buildTemplatePlan(name, args);
  assert.deepEqual(built.errors, [], `${name} should build cleanly`);
  assert.ok(built.plan, `${name} should produce a plan`);
  const norm = normalizePhasePlan(built.plan);
  assert.deepEqual(norm.errors, [], `${name} plan should validate`);
  return built.plan!;
}

test('WF-TEMPLATES compare: analyze-each → recommend, 2 phases, validates', () => {
  const plan = assertValid('compare', { targets: ['Postgres', 'SQLite', 'DuckDB'], goal: 'pick a store' });
  assert.equal(plan.phases.length, 2);
  assert.equal(plan.phases[0].fanOut?.over.length, 3);
  assert.deepEqual(plan.phases[1].inputFrom, ['analyze']);
  assert.match(plan.phases[0].fanOut!.agent.prompt, /\{\{target\}\}/);
});

test('WF-TEMPLATES compare: needs ≥2 targets', () => {
  assert.equal(buildTemplatePlan('compare', { targets: ['only-one'] }).plan, null);
  assert.match(buildTemplatePlan('compare', {}).errors[0], /targets/);
});

test('WF-TEMPLATES review-wide: review-each → summarize, review-merge synthesis', () => {
  const plan = assertValid('review-wide', { paths: ['src/a.ts', 'src/b.ts'], focus: 'security' });
  assert.equal(plan.phases[0].fanOut?.over.length, 2);
  assert.equal(plan.phases[0].synthesize, 'review-merge');
  assert.match(plan.phases[0].fanOut!.agent.prompt, /security/);
});

test('WF-TEMPLATES review-wide: needs ≥1 path', () => {
  assert.equal(buildTemplatePlan('review-wide', { paths: [] }).plan, null);
});

test('WF-TEMPLATES research: default angles when none given; requires a question', () => {
  const plan = assertValid('research', { question: 'Is X faster than Y?' });
  assert.equal(plan.phases[0].fanOut!.over.length, 3); // default angles
  const custom = assertValid('research', { question: 'Q', angles: ['perf', 'cost'] });
  assert.equal(custom.phases[0].fanOut!.over.length, 2);
  assert.equal(buildTemplatePlan('research', {}).plan, null); // missing question
});

test('WF-TEMPLATES unknown template name → error listing known templates', () => {
  const r = buildTemplatePlan('nope', {});
  assert.equal(r.plan, null);
  assert.match(r.errors[0], /unknown template/);
  for (const t of WORKFLOW_TEMPLATES) assert.match(r.errors[0], new RegExp(t));
});

test('WF-TEMPLATES run_workflow executes a template end-to-end', async () => {
  const ws = tmpWs();
  const raw = await runWorkflow(
    { template: 'compare', templateArgs: { targets: ['A', 'B'] } },
    ctx(ws),
    { dispatch: async () => '{}', runner: fakeRunner },
  );
  const out = JSON.parse(raw);
  assert.equal(out.ok, true);
  assert.equal(out.status, 'completed');
  assert.equal(out.phases.length, 2);
  const run = readRun(ws, out.slug)!;
  assert.equal(run.phases?.length, 2);
  assert.equal(run.phases?.every((p) => p.status === 'completed'), true);
});

test('WF-TEMPLATES run_workflow with a bad template → ok:false, no run started', async () => {
  const ws = tmpWs();
  const raw = await runWorkflow({ template: 'compare', templateArgs: { targets: [] } }, ctx(ws), { dispatch: async () => '{}', runner: fakeRunner });
  const out = JSON.parse(raw);
  assert.equal(out.ok, false);
  assert.match(out.error, /template "compare" failed/);
});

test('WF-TEMPLATES run_workflow with neither plan nor template → invalid plan', async () => {
  const ws = tmpWs();
  const raw = await runWorkflow({}, ctx(ws), { dispatch: async () => '{}', runner: fakeRunner });
  assert.equal(JSON.parse(raw).ok, false);
});
