import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildNextActionMessages,
  nextActionDirective,
  planWantsFanOut,
} from '../prompt/planning/nextAction.js';

test('NEXT-ACTION durable strategies recommend trusted CLI launch and state the Desktop boundary', () => {
  const plannerPrompt = buildNextActionMessages('compare the options, then implement the winner', undefined, 'always')[0].content;
  assert.match(plannerPrompt, /recommendation only/i);
  assert.doesNotMatch(plannerPrompt, /run_workflow|phasePlan|"phases"/);

  const build = nextActionDirective({
    strategy: 'build',
    reasoning: 'implementation needs verification',
    subtasks: ['implement the selected option'],
  });
  assert.match(build, /`\/build <task>`/);
  assert.match(build, /Desktop production launch is unavailable/);
  assert.match(build, /Test run is preview-only/);
  assert.doesNotMatch(build, /run_workflow|"(?:template|templateArgs|phases)"|FIRST action MUST|```(?:json)?/i);

  const workflow = nextActionDirective({
    strategy: 'workflow',
    reasoning: 'later phases depend on earlier results',
    subtasks: ['compare options', 'implement the winner'],
    phasePlan: {
      title: 'legacy plan that must not be rendered',
      phases: [{
        id: 'legacy',
        title: 'legacy',
        agents: [{ role: 'worker', prompt: 'do not render this payload' }],
      }],
    },
  });
  assert.match(workflow, /`\/workflow run <template> \[jsonArgs\]`/);
  assert.match(workflow, /Desktop production launch is unavailable/);
  assert.match(workflow, /Test run is preview-only/);
  assert.doesNotMatch(workflow, /run_workflow|"phases"|phasePlan|FIRST action MUST|```(?:json)?/i);
  assert.equal(planWantsFanOut({ strategy: 'workflow', reasoning: '', subtasks: ['a', 'b'] }), false);
});

test('NEXT-ACTION investigate and fan-out directives remain actionable', () => {
  const investigate = nextActionDirective({ strategy: 'investigate', reasoning: 'needs files', subtasks: [] });
  assert.match(investigate, /FIRST action MUST be tool calls/);

  const fanOutPlan = { strategy: 'fan-out' as const, reasoning: 'independent work', subtasks: ['a', 'b', 'c'] };
  const fanOut = nextActionDirective(fanOutPlan);
  assert.match(fanOut, /spawn_agents/);
  assert.match(fanOut, /wait_agents/);
  assert.equal(planWantsFanOut(fanOutPlan), true);
});
