import test from 'node:test';
import assert from 'node:assert/strict';
import { buildNextActionMessages, parseNextActionPlan, nextActionDirective } from '@kinqs/brainrouter-core/prompt';

const VALID_PHASE_PLAN = {
  title: 'compare',
  phases: [
    { id: 'analyze', fanOut: { over: ['a', 'b'], agent: { role: 'explorer', prompt: 'Analyze {{target}}' } } },
    { id: 'rec', agents: [{ role: 'architect', prompt: 'Recommend from {{input}}' }], inputFrom: ['analyze'], dependsOn: ['analyze'] },
  ],
};

test('WF-PLANNER: parse attaches a VALID phasePlan for a workflow strategy', () => {
  const reply = JSON.stringify({ strategy: 'workflow', reasoning: 'compare then recommend', subtasks: ['a', 'b', 'rec'], phasePlan: VALID_PHASE_PLAN });
  const plan = parseNextActionPlan(reply)!;
  assert.equal(plan.strategy, 'workflow');
  assert.ok(plan.phasePlan, 'phasePlan attached');
  assert.equal(plan.phasePlan!.phases.length, 2);
});

test('WF-PLANNER: an INVALID phasePlan is dropped (fall back to subtasks)', () => {
  const reply = JSON.stringify({ strategy: 'workflow', reasoning: 'x', subtasks: ['a', 'b'], phasePlan: { phases: [] } });
  const plan = parseNextActionPlan(reply)!;
  assert.equal(plan.phasePlan, undefined);
  assert.equal(plan.subtasks.length, 2);
});

test('WF-PLANNER: phasePlan only attaches for workflow (not fan-out)', () => {
  const reply = JSON.stringify({ strategy: 'fan-out', reasoning: 'x', subtasks: ['a', 'b'], phasePlan: VALID_PHASE_PLAN });
  const plan = parseNextActionPlan(reply)!;
  assert.equal(plan.phasePlan, undefined);
});

test('WF-PLANNER: new planner requests recommend phases without asking for an executable payload', () => {
  const [system] = buildNextActionMessages('compare these systems, then recommend one');
  assert.match(system.content, /recommendation only/i);
  assert.doesNotMatch(system.content, /run_workflow|phasePlan|"phases"/);
});

test('WF-PLANNER: directive recommends an explicit user launch and never renders the legacy prepared plan', () => {
  const plan = parseNextActionPlan(JSON.stringify({ strategy: 'workflow', reasoning: 'r', subtasks: ['a', 'b'], phasePlan: VALID_PHASE_PLAN }))!;
  const d = nextActionDirective(plan);
  assert.match(d, /Next-action plan \(recommended\): workflow/);
  assert.match(d, /explicit user launch/i);
  assert.match(d, /`\/workflow run <template> \[jsonArgs\]`/);
  assert.match(d, /Desktop production launch is unavailable/);
  assert.match(d, /Test run is preview-only/);
  assert.doesNotMatch(d, /run_workflow|"phases"|phasePlan/);
  assert.doesNotMatch(d, /FIRST action MUST|```(?:json)?/i);
  assert.doesNotMatch(d, /spawn_agents/);
});

test('WF-PLANNER: workflow WITHOUT a prepared plan is also only an explicit-launch recommendation', () => {
  const plan = parseNextActionPlan(JSON.stringify({ strategy: 'workflow', reasoning: 'r', subtasks: ['a', 'b', 'c'] }))!;
  assert.equal(plan.phasePlan, undefined);
  const d = nextActionDirective(plan);
  assert.match(d, /`\/workflow run <template> \[jsonArgs\]`/);
  assert.doesNotMatch(d, /run_workflow|spawn_agents|task_agent|"phases"|FIRST action MUST/i);
});
