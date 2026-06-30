/** HONK-L5 (verify-loop nudge) + L6 (router tier bias) for local models. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { biasTierForLocalModel, routeTask } from '../orchestration/router.js';
import { buildVerificationNudge } from '../agent/verificationGate.js';

// ---- L6: router tier bias ----

test('biasTierForLocalModel demotes a low-confidence detached worker to a bounded inline task', () => {
  assert.equal(biasTierForLocalModel('spawn-worker', 0.75), 'spawn-inline', 'weak long-running cue → inline');
  assert.equal(biasTierForLocalModel('spawn-worker', 0.9), 'spawn-worker', 'a STRONG worker cue is respected');
  // Already-bounded tiers pass through untouched.
  assert.equal(biasTierForLocalModel('answer-direct', 0.5), 'answer-direct');
  assert.equal(biasTierForLocalModel('direct-tool', 0.5), 'direct-tool');
  assert.equal(biasTierForLocalModel('spawn-inline', 0.5), 'spawn-inline');
});

test('routeTask applies the local bias only when localModel is set', async () => {
  const task = 'in the background, keep refactoring the module until tests pass';
  const strong = await routeTask({ task, skipMemory: true });
  assert.equal(strong.tier, 'spawn-worker', 'default keeps the worker tier');
  assert.equal(strong.recommendedTool, 'spawn_worker_thread');

  const local = await routeTask({ task, skipMemory: true, localModel: true });
  assert.equal(local.tier, 'spawn-inline', 'local model is steered to a bounded inline task');
  assert.equal(local.recommendedTool, null, 'worker tool dropped on demotion');
  assert.match(local.reason, /local-model: bounded inline task/);
});

// ---- L5: verify-loop nudge escalation ----

test('buildVerificationNudge stays a gentle reminder by default, becomes a hard directive for local models', () => {
  const normal = buildVerificationNudge();
  assert.match(normal, /verification guardrail tripped/i);
  assert.doesNotMatch(normal, /REQUIRED, not optional/);

  const local = buildVerificationNudge({ local: true });
  assert.match(local, /REQUIRED, not optional/);
  assert.match(local, /NEXT action this turn MUST be/);
  assert.match(local, /if it fails, fix the cause and run it again/i);
});
