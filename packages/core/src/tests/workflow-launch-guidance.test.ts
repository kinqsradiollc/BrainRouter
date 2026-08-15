import test from 'node:test';
import assert from 'node:assert/strict';
import { HELP_CATEGORIES } from '../command/catalog.js';
import { buildGoalKickoffPrompt } from '../goal/prompt/goalKickoff.js';
import { buildFanOutHint, detectBreadthIntent } from '../prompt/planning/breadthHint.js';
import { buildSystemPrompt } from '../prompt/systemPrompt.js';

const goal = {
  text: 'Ship the workflow runtime safely.',
  setAt: '2026-08-13T00:00:00.000Z',
  status: 'active' as const,
  budget: { maxIterations: 10, iterationsUsed: 0 },
  startedAt: '2026-08-13T00:00:00.000Z',
  updatedAt: '2026-08-13T00:00:00.000Z',
};

test('fan-out guidance recommends explicit CLI workflow launch instead of self-authorizing', () => {
  const hint = buildFanOutHint('audit every module', detectBreadthIntent('audit every module'));
  assert.match(hint, /`\/build <task>`/);
  assert.match(hint, /`\/workflow run <template> \[jsonArgs\]`/);
  assert.match(hint, /cannot authorize workflow execution/);
  assert.doesNotMatch(hint, /use `run_workflow`/);
});

test('goal kickoff says the goal cannot authorize workflow execution', () => {
  const prompt = buildGoalKickoffPrompt(goal, 'start');
  assert.match(prompt, /active goal and this kickoff prompt cannot authorize workflow execution/);
  assert.match(prompt, /never call `run_workflow` or `run_workflow_graph` on that basis/);
  assert.match(prompt, /`\/build <task>`/);
  assert.match(prompt, /`\/workflow run <template> \[jsonArgs\]`/);
});

test('system guidance binds workflow authority to the live host and states Desktop status', () => {
  const prompt = buildSystemPrompt({ workspaceRoot: '/repo', launchCwd: '/repo', sessionKey: 's1' });
  assert.match(prompt, /Workflow execution is host-authorized, not model-authorized/);
  assert.match(prompt, /unexpired, single-use execution intent/);
  assert.match(prompt, /exact workspace, session, user, turn, tool, and normalized arguments/);
  assert.match(prompt, /active goal, a planner\/router recommendation.*cannot mint that authority/);
  assert.match(prompt, /Desktop production launch is unavailable/);
});

test('shared help catalog documents the explicit /workflow run authority path', () => {
  const workflowHelp = HELP_CATEGORIES.find((category) => category.key === 'workflow');
  const launch = workflowHelp?.entries.find((entry) => entry.cmd === '/workflow run <template> [jsonArgs]');
  assert.ok(launch);
  assert.match(launch.desc, /Explicitly authorize and launch/);
});
