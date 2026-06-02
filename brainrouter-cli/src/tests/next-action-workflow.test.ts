import test from 'node:test';
import assert from 'node:assert/strict';
import { parseNextActionPlan, nextActionDirective } from '../prompt/nextAction.js';

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

test('WF-PLANNER: directive tells the model to fire ONE run_workflow with the prepared plan', () => {
  const plan = parseNextActionPlan(JSON.stringify({ strategy: 'workflow', reasoning: 'r', subtasks: ['a', 'b'], phasePlan: VALID_PHASE_PLAN }))!;
  const d = nextActionDirective(plan);
  assert.match(d, /run_workflow/);
  assert.match(d, /"phases"/); // the plan JSON is embedded
  assert.doesNotMatch(d, /spawn_agents/); // not the manual fan-out path
});

test('WF-PLANNER: workflow WITHOUT a prepared plan falls back to the manual fan-out directive', () => {
  const plan = parseNextActionPlan(JSON.stringify({ strategy: 'workflow', reasoning: 'r', subtasks: ['a', 'b', 'c'] }))!;
  assert.equal(plan.phasePlan, undefined);
  const d = nextActionDirective(plan);
  assert.match(d, /spawn_agents|task_agent/);
});
