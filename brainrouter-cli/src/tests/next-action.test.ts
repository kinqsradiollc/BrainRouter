import test from 'node:test';
import assert from 'node:assert/strict';
import {
  shouldSkipPlanner,
  buildNextActionMessages,
  parseNextActionPlan,
  planWantsFanOut,
  nextActionDirective,
} from '../prompt/nextAction.js';

test('NEXT-ACTION shouldSkipPlanner skips trivial/social prompts, runs on real tasks', () => {
  for (const p of ['hi', 'thanks', 'ok', 'yes', 'cool', 'sounds good', 'what?']) {
    assert.equal(shouldSkipPlanner(p), true, `should skip: "${p}"`);
  }
  for (const p of [
    'who has the best cli?',
    'compare our memory vs agentmem vs tencent',
    'what are the pros and cons of brainrouter against those in the peer set',
    'refactor the recall pipeline to add a graph stage',
  ]) {
    assert.equal(shouldSkipPlanner(p), false, `should plan: "${p}"`);
  }
});

test('NEXT-ACTION buildNextActionMessages produces a system+user pair stating the four strategies', () => {
  const msgs = buildNextActionMessages('compare A vs B vs C', 'workspace has repos/');
  assert.equal(msgs.length, 2);
  assert.equal(msgs[0].role, 'system');
  for (const s of ['answer-direct', 'investigate', 'fan-out', 'workflow']) assert.match(msgs[0].content, new RegExp(s));
  assert.match(msgs[1].content, /compare A vs B vs C/);
  assert.match(msgs[1].content, /repos\//); // context threaded in
});

test('NEXT-ACTION parseNextActionPlan tolerates prose-wrapped/fenced JSON and validates strategy', () => {
  const fenced = 'Sure!\n```json\n{"strategy":"fan-out","reasoning":"3 independent repos","subtasks":["read repos/projectA","read repos/projectB","read repos/projectC"]}\n```';
  const plan = parseNextActionPlan(fenced);
  assert.ok(plan);
  assert.equal(plan!.strategy, 'fan-out');
  assert.equal(plan!.subtasks.length, 3);
  // Invalid / missing strategy → null (caller fails open).
  assert.equal(parseNextActionPlan('{"strategy":"banana"}'), null);
  assert.equal(parseNextActionPlan('no json here'), null);
  assert.equal(parseNextActionPlan(''), null);
  assert.equal(parseNextActionPlan(undefined), null);
});

test('NEXT-ACTION planWantsFanOut only for fan-out/workflow with ≥2 subtasks', () => {
  assert.equal(planWantsFanOut({ strategy: 'fan-out', reasoning: '', subtasks: ['a', 'b', 'c'] }), true);
  assert.equal(planWantsFanOut({ strategy: 'workflow', reasoning: '', subtasks: ['a', 'b'] }), true);
  assert.equal(planWantsFanOut({ strategy: 'fan-out', reasoning: '', subtasks: ['only one'] }), false);
  assert.equal(planWantsFanOut({ strategy: 'investigate', reasoning: '', subtasks: [] }), false);
  assert.equal(planWantsFanOut({ strategy: 'answer-direct', reasoning: '', subtasks: [] }), false);
});

test('NEXT-ACTION nextActionDirective: decisive per strategy; empty for answer-direct', () => {
  assert.equal(nextActionDirective({ strategy: 'answer-direct', reasoning: 'trivial', subtasks: [] }), '');

  const investigate = nextActionDirective({ strategy: 'investigate', reasoning: 'needs files', subtasks: [] });
  assert.match(investigate, /FIRST action MUST be tool calls/);
  assert.match(investigate, /do NOT answer from memory/i);

  const fanOut = nextActionDirective({
    strategy: 'fan-out',
    reasoning: '3 repos',
    subtasks: ['inspect repos/projectA', 'inspect repos/projectB', 'inspect repos/projectC'],
  });
  assert.match(fanOut, /Next-action plan \(decided\): fan-out/);
  assert.match(fanOut, /spawn_agents/);
  assert.match(fanOut, /repos\/projectA/);
  assert.match(fanOut, /do not ask the user/i);
  assert.match(fanOut, /Do NOT answer single-threaded/);
});
