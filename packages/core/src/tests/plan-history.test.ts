import test from 'node:test';
import assert from 'node:assert/strict';
import {
  recordPlanDecision,
  readPlanHistory,
  linkPlanDecision,
  diffSnapshots,
  planStepSignature,
} from '../task/planHistoryStore.js';
import type { PlanItem } from '../task/taskStore.js';
import { withTempWorkspace } from './_helpers.js';

const plan = (steps: Array<[string, PlanItem['status']]>): PlanItem[] =>
  steps.map(([step, status]) => ({ step, status }));

test('planHistory: record approve + request-changes, append order, snapshot frozen', () => {
  withTempWorkspace((ws) => {
    const sk = 'sess:p';
    const p1 = plan([['design', 'completed'], ['build', 'in_progress']]);
    const d1 = recordPlanDecision(ws, sk, { verdict: 'approved', planSnapshot: p1, explanation: 'v1' });
    assert.match(d1.id, /^pdec_[0-9a-f]{8}$/);
    assert.equal(d1.verdict, 'approved');
    assert.equal(d1.planSnapshot.length, 2);
    assert.equal(d1.feedback, undefined);
    assert.deepEqual(d1.linkedMemoryIds, []);

    // mutating the source array after recording must not change the snapshot
    p1.push({ step: 'ship', status: 'pending' });
    assert.equal(readPlanHistory(ws, sk)[0].planSnapshot.length, 2);

    const d2 = recordPlanDecision(ws, sk, { verdict: 'changes-requested', feedback: 'split build into 2', planSnapshot: plan([['design', 'completed']]) });
    assert.equal(d2.feedback, 'split build into 2');

    const hist = readPlanHistory(ws, sk);
    assert.deepEqual(hist.map((d) => d.verdict), ['approved', 'changes-requested']); // append order
  });
});

test('planHistory: session + workspace isolation', () => {
  withTempWorkspace((ws) => {
    recordPlanDecision(ws, 'sess:a', { verdict: 'approved', planSnapshot: plan([['x', 'pending']]) });
    assert.equal(readPlanHistory(ws, 'sess:a').length, 1);
    assert.equal(readPlanHistory(ws, 'sess:b').length, 0); // other session independent
  });
});

test('planHistory: linkPlanDecision pushes a unique memory id; persists', () => {
  withTempWorkspace((ws) => {
    const sk = 'sess:m';
    const d = recordPlanDecision(ws, sk, { verdict: 'approved', planSnapshot: plan([['a', 'pending']]) });
    linkPlanDecision(ws, sk, d.id, 'mem_1');
    linkPlanDecision(ws, sk, d.id, 'mem_1'); // dupe ignored
    linkPlanDecision(ws, sk, d.id, 'mem_2');
    assert.deepEqual(readPlanHistory(ws, sk)[0].linkedMemoryIds, ['mem_1', 'mem_2']);
    assert.equal(linkPlanDecision(ws, sk, 'pdec_missing', 'm'), undefined);
  });
});

test('diffSnapshots: added / removed / status-changed by step', () => {
  const before = plan([['a', 'pending'], ['b', 'in_progress'], ['c', 'pending']]);
  const after = plan([['a', 'completed'], ['c', 'pending'], ['d', 'pending']]);
  const diff = diffSnapshots(before, after);
  assert.deepEqual(diff.added, ['d']);
  assert.deepEqual(diff.removed, ['b']);
  assert.deepEqual(diff.changed, [{ step: 'a', from: 'pending', to: 'completed' }]);
  // identical snapshots → empty diff
  assert.deepEqual(diffSnapshots(before, before), { added: [], removed: [], changed: [] });
});

test('planHistory: actor defaults to user; auto recorded explicitly', () => {
  withTempWorkspace((ws) => {
    const sk = 'sess:actor';
    const d1 = recordPlanDecision(ws, sk, { verdict: 'approved', planSnapshot: plan([['a', 'pending']]) });
    assert.equal(d1.actor, 'user', 'no actor passed → user');
    const d2 = recordPlanDecision(ws, sk, { verdict: 'approved', actor: 'auto', planSnapshot: plan([['b', 'pending']]) });
    assert.equal(d2.actor, 'auto');
    const hist = readPlanHistory(ws, sk);
    assert.deepEqual(hist.map((d) => d.actor), ['user', 'auto']);
  });
});

test('planStepSignature: order- and status-insensitive; sensitive to step set', () => {
  // same steps, different order + different statuses → SAME signature (no new version)
  assert.equal(
    planStepSignature(plan([['build', 'in_progress'], ['design', 'completed']])),
    planStepSignature(plan([['design', 'pending'], ['build', 'pending']])),
  );
  // adding a step → different signature (a new version)
  assert.notEqual(
    planStepSignature(plan([['design', 'pending']])),
    planStepSignature(plan([['design', 'pending'], ['build', 'pending']])),
  );
  // rewording a step → different signature
  assert.notEqual(
    planStepSignature(plan([['design the api', 'pending']])),
    planStepSignature(plan([['design the schema', 'pending']])),
  );
});
