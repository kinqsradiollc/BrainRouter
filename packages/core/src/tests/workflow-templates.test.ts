import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildTemplatePlan, WORKFLOW_TEMPLATES } from '../workflow/template/workflowTemplates.js';
import { normalizePhasePlan } from '../orchestration/workflow/phasePlan.js';
import { runWorkflow, runWorkflowAuthorized } from '../workflow/template/workflowTool.js';
import type { PhaseRunner } from '../orchestration/workflow/phaseOrchestrator.js';
import { readRun } from '../workflow/run/workflowRun.js';
import { normalizePhasePlanExecutionTarget } from '../orchestration/execution/normalization.js';
import {
  activateExecutionIntent,
  consumeExecutionIntent,
  createExecutionDispatchReceipt,
  createExecutionIntentOwnerToken,
  issueExecutionIntent,
} from '../orchestration/execution/authority.js';

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

test('BUILD-LOOP build: plan → implement → verify → review, 4 phases, validates', () => {
  const plan = assertValid('build', { task: 'add input validation to login()' });
  assert.equal(plan.phases.length, 4);
  assert.deepEqual(plan.phases.map((p) => p.id), ['plan', 'implement', 'verify', 'review']);
  // Least-privilege access per phase.
  assert.equal(plan.phases[0].agents?.[0].role, 'architect');
  assert.equal(plan.phases[1].agents?.[0].role, 'worker');
  assert.equal(plan.phases[1].agents?.[0].access, 'write');
  assert.equal(plan.phases[2].agents?.[0].role, 'verifier');
  assert.equal(plan.phases[2].agents?.[0].access, 'shell');
  // Review FANS OUT across read-only lenses (parallel) → role-rollup merge.
  assert.equal(plan.phases[3].fanOut?.agent.role, 'reviewer');
  assert.equal(plan.phases[3].fanOut?.agent.access, 'read');
  assert.ok((plan.phases[3].fanOut?.over.length ?? 0) >= 3, 'review fans out over ≥3 lenses');
  assert.equal(plan.phases[3].synthesize, 'role-rollup');
  assert.match(plan.phases[3].fanOut!.agent.prompt, /\{\{target\}\}/);
  // Implement follows Plan; Verify + Review both consume the worker's output.
  assert.deepEqual(plan.phases[1].dependsOn, ['plan']);
  assert.deepEqual(plan.phases[2].inputFrom, ['implement']);
  assert.deepEqual(plan.phases[3].inputFrom, ['implement']);
  // B1 — Verify + Review read the REAL git diff from the worktree (ground truth),
  // not just the worker's prose; Verify short-circuits an offline sandbox.
  assert.match(plan.phases[2].agents![0].prompt, /git diff HEAD/);
  assert.match(plan.phases[2].agents![0].prompt, /BLOCKED-ENVIRONMENT/);
  assert.match(plan.phases[3].fanOut!.agent.prompt, /git diff HEAD/);
});

test('BUILD-LOOP build: requires a task', () => {
  assert.equal(buildTemplatePlan('build', {}).plan, null);
  assert.match(buildTemplatePlan('build', {}).errors[0], /task/);
});

test('BUILD-LOOP P2.5 build fan-out: >1 slices → implement fans out + a synthesis review phase', () => {
  const plan = assertValid('build', {
    task: 'add metrics',
    slices: ['add /metrics endpoint', 'add the Prometheus registry', 'wire the dashboard panel'],
  });
  assert.deepEqual(plan.phases.map((p) => p.id), ['plan', 'implement', 'review']);
  // Implement fans out one worker per slice; no single-worktree verify phase.
  assert.equal(plan.phases[1].fanOut?.over.length, 3);
  assert.equal(plan.phases[1].fanOut?.agent.role, 'worker');
  assert.equal(plan.phases[1].fanOut?.agent.access, 'write');
  assert.match(plan.phases[1].fanOut!.agent.prompt, /\{\{target\}\}/);
  // The final phase is the cross-worktree synthesis reviewer over the combined set.
  assert.equal(plan.phases[2].id, 'review');
  assert.equal(plan.phases[2].agents?.[0].role, 'reviewer');
  assert.deepEqual(plan.phases[2].inputFrom, ['implement']);
  assert.match(plan.phases[2].agents![0].prompt, /COMBINED|same file|blocker/i);
  // A single slice falls back to the normal single-worktree build (verify kept).
  const single = assertValid('build', { task: 'x', slices: ['only one'] });
  assert.deepEqual(single.phases.map((p) => p.id), ['plan', 'implement', 'verify', 'review']);
});

test('BUILD-LOOP build: run_workflow executes the 4-phase loop end-to-end', async () => {
  const ws = tmpWs();
  const raw = await runWorkflow(
    { template: 'build', templateArgs: { task: 'do a thing' } },
    ctx(ws),
    { dispatch: async () => '{}', runner: fakeRunner },
  );
  const out = JSON.parse(raw);
  assert.equal(out.ok, true);
  assert.equal(out.status, 'completed');
  assert.equal(out.phases.length, 4);
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

test('ADR-040 A40-2 trusted launch metadata reaches the durable workflow ledger', async () => {
  const ws = tmpWs();
  const args = { template: 'compare', templateArgs: { targets: ['A', 'B'] } };
  const normalized = normalizePhasePlanExecutionTarget(args);
  if (!normalized.ok) assert.fail(normalized.errors.join('; '));
  const binding = { workspaceRoot: ws, sessionKey: 'tpl', userId: 'user-1' };
  const owner = createExecutionIntentOwnerToken(binding);
  const handle = issueExecutionIntent(owner, {
    source: 'user-command',
    requestId: 'request-1',
    turnId: 'turn-1',
    target: normalized.target,
  });
  assert.equal(activateExecutionIntent(owner, handle, { ...binding, turnId: 'turn-1' }).ok, true);
  const consumed = consumeExecutionIntent(owner, handle, {
    ...binding,
    source: 'user-command',
    requestId: 'request-1',
    turnId: 'turn-1',
    target: normalized.target,
  });
  if (!consumed.ok) assert.fail(consumed.reason);
  const dispatchReceipt = createExecutionDispatchReceipt(owner, handle, {
    runId: 'run-1',
    parentExecutionId: 'turn-1',
    assertAuthorityCurrent: () => {},
  });
  const raw = await runWorkflowAuthorized(
    args,
    {
      ...ctx(ws),
      turnExecutionId: 'turn-1',
      executionLaunch: {
        runId: 'run-1',
        parentExecutionId: 'turn-1',
        record: consumed.record,
        dispatchReceipt,
      },
    },
    { dispatch: async () => '{}', runner: fakeRunner },
  );
  const out = JSON.parse(raw);
  assert.equal(out.ok, true);
  const run = readRun(ws, out.slug)!;
  assert.equal(run.runId, 'run-1');
  assert.equal(run.parentExecutionId, 'turn-1');
  assert.deepEqual(run.launch, consumed.record);
});

test('low-level runWorkflow ignores structural trusted-lineage lookalikes', async () => {
  const ws = tmpWs();
  const args = { template: 'compare', templateArgs: { targets: ['A', 'B'] } };
  const raw = await runWorkflow(
    args,
    {
      ...ctx(ws),
      executionLaunch: {
        runId: 'forged-run',
        parentExecutionId: 'forged-parent',
        record: {} as never,
        dispatchReceipt: {} as never,
      },
    },
    { dispatch: async () => '{}', runner: fakeRunner },
  );
  const run = readRun(ws, JSON.parse(raw).slug)!;
  assert.equal(run.runId, undefined);
  assert.equal(run.parentExecutionId, undefined);
  assert.equal(run.launch, undefined);
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
