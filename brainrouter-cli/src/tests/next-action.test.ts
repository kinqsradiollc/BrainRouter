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

test('BUILD-LOOP P3 buildNextActionMessages offers "build" only when the knob is on, scaled by mode', () => {
  // off (default) → four strategies, no "build".
  const off = buildNextActionMessages('add a retry flag to the http client', undefined, 'off');
  assert.doesNotMatch(off[0].content, /"build"/);
  for (const s of ['answer-direct', 'investigate', 'fan-out', 'workflow']) assert.match(off[0].content, new RegExp(s));
  // default arg behaves like off (keeps the legacy four-strategy prompt).
  assert.doesNotMatch(buildNextActionMessages('x y z task here')[0].content, /"build"/);
  // escalate → "build" offered, reserved for MULTIPLE-file / feature-scale work.
  const esc = buildNextActionMessages('implement OAuth across the auth module', undefined, 'escalate');
  assert.match(esc[0].content, /"build"/);
  assert.match(esc[0].content, /MULTIPLE files/);
  assert.match(esc[0].content, /single-file edit stays "investigate"/);
  // always → "build" offered for ANY code change.
  const always = buildNextActionMessages('rename one variable', undefined, 'always');
  assert.match(always[0].content, /"build"/);
  assert.match(always[0].content, /ANYTHING in this workspace/);
});

test('BUILD-LOOP P3 parseNextActionPlan honors "build" only when enabled; downgrades to investigate when off', () => {
  const json = '{"strategy":"build","reasoning":"multi-file feature","subtasks":["add a /metrics endpoint with tests"]}';
  // enabled → build survives, task carried in subtasks[0].
  const enabled = parseNextActionPlan(json, { buildLoop: 'escalate' });
  assert.ok(enabled);
  assert.equal(enabled!.strategy, 'build');
  assert.equal(enabled!.subtasks[0], 'add a /metrics endpoint with tests');
  assert.equal(parseNextActionPlan(json, { buildLoop: 'always' })!.strategy, 'build');
  // off / default → defense-in-depth downgrade to a single-thread investigate,
  // and the build task must NOT leak into investigate's subtasks (contract:
  // answer-direct/investigate carry none).
  const downgraded = parseNextActionPlan(json, { buildLoop: 'off' });
  assert.equal(downgraded!.strategy, 'investigate');
  assert.deepEqual(downgraded!.subtasks, []);
  assert.deepEqual(parseNextActionPlan(json)!.subtasks, []);
  // The contract also holds for a directly-emitted investigate with stray subtasks.
  assert.deepEqual(
    parseNextActionPlan('{"strategy":"investigate","reasoning":"x","subtasks":["stray"]}')!.subtasks,
    [],
  );
});

test('BUILD-LOOP P3 nextActionDirective: "build" fires one run_workflow build call; never arms fan-out', () => {
  const withTask = nextActionDirective({
    strategy: 'build',
    reasoning: 'feature spans multiple files',
    subtasks: ['add a /metrics endpoint with tests'],
  });
  assert.match(withTask, /Next-action plan \(decided\): build/);
  assert.match(withTask, /SINGLE `run_workflow` call/);
  assert.match(withTask, /"template":"build"/);
  assert.match(withTask, /add a \/metrics endpoint with tests/);
  assert.match(withTask, /do NOT hand-edit files directly/);
  // No subtasks → directive still emits a build call with a placeholder + fill instruction.
  const noTask = nextActionDirective({ strategy: 'build', reasoning: 'implement it', subtasks: [] });
  assert.match(noTask, /"template":"build"/);
  assert.match(noTask, /Replace the `task` placeholder/);
  // "build" is a single workflow run, not a manual fan-out.
  assert.equal(planWantsFanOut({ strategy: 'build', reasoning: '', subtasks: ['one task'] }), false);
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
