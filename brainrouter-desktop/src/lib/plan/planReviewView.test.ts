import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  diffPlanSnapshots, isEmptyDiff, planHistoryRows, latestDecision,
  planApprovalState, approvalLabel, type PlanDecisionView,
} from './planReviewView.js';
import type { PlanItem } from '../../types.js';

const item = (step: string, status: PlanItem['status'] = 'pending'): PlanItem => ({ step, status });

function decision(over: Partial<PlanDecisionView>): PlanDecisionView {
  return {
    id: 'pdec_0', verdict: 'approved', planSnapshot: [], createdAt: '2026-06-18T00:00:00.000Z',
    ...over,
  };
}

test('diffPlanSnapshots reports added / removed / status-changed by step text', () => {
  const before = [item('a', 'completed'), item('b', 'pending'), item('c')];
  const after = [item('a', 'completed'), item('b', 'in_progress'), item('d')];
  const d = diffPlanSnapshots(before, after);
  assert.deepEqual(d.added, ['d']);
  assert.deepEqual(d.removed, ['c']);
  assert.deepEqual(d.changed, [{ step: 'b', from: 'pending', to: 'in_progress' }]);
});

test('isEmptyDiff is true only when nothing changed', () => {
  assert.equal(isEmptyDiff(diffPlanSnapshots([item('a')], [item('a')])), true);
  assert.equal(isEmptyDiff(diffPlanSnapshots([item('a')], [item('a', 'completed')])), false);
});

test('planHistoryRows is newest-first and annotates the diff from the previous snapshot', () => {
  const decisions = [
    decision({ id: 'pdec_1', planSnapshot: [item('a')], createdAt: '2026-06-18T00:00:00.000Z' }),
    decision({ id: 'pdec_2', verdict: 'changes-requested', feedback: 'split step a', planSnapshot: [item('a'), item('b')], createdAt: '2026-06-18T01:00:00.000Z' }),
  ];
  const rows = planHistoryRows(decisions);
  assert.equal(rows[0].id, 'pdec_2');          // newest first
  assert.equal(rows[1].id, 'pdec_1');
  assert.deepEqual(rows[0].diffFromPrev?.added, ['b']); // pdec_2 added step b
  assert.equal(rows[1].diffFromPrev, undefined);        // first decision has no prior
});

test('latestDecision returns the chronologically last decision (or null)', () => {
  assert.equal(latestDecision([]), null);
  const decisions = [decision({ id: 'old' }), decision({ id: 'new' })];
  assert.equal(latestDecision(decisions)?.id, 'new');
});

test('planApprovalState: none when no plan or no decisions', () => {
  assert.deepEqual(planApprovalState(null, []), { kind: 'none' });
  assert.deepEqual(planApprovalState({ items: [item('a')] }, []), { kind: 'none' });
  assert.deepEqual(planApprovalState({ items: [] }, [decision({})]), { kind: 'none' });
});

test('planApprovalState: approved when the live plan matches the last-approved snapshot', () => {
  const plan = { items: [item('a'), item('b', 'completed')] };
  const decisions = [decision({ id: 'pdec_ok', verdict: 'approved', planSnapshot: [item('a'), item('b', 'completed')] })];
  assert.deepEqual(planApprovalState(plan, decisions), { kind: 'approved', decisionId: 'pdec_ok' });
});

test('planApprovalState: changed-since-approval when the plan moved on after an approval', () => {
  const plan = { items: [item('a'), item('b'), item('c')] };
  const decisions = [decision({ id: 'pdec_ok', verdict: 'approved', planSnapshot: [item('a'), item('b')] })];
  assert.deepEqual(planApprovalState(plan, decisions), { kind: 'changed-since-approval', decisionId: 'pdec_ok' });
});

test('planApprovalState: changes-requested surfaces the latest feedback', () => {
  const plan = { items: [item('a')] };
  const decisions = [
    decision({ id: 'pdec_ok', verdict: 'approved', planSnapshot: [item('a')] }),
    decision({ id: 'pdec_cr', verdict: 'changes-requested', feedback: 'add error handling', planSnapshot: [item('a')] }),
  ];
  assert.deepEqual(planApprovalState(plan, decisions), { kind: 'changes-requested', feedback: 'add error handling' });
});

test('approvalLabel maps each state to a banner string', () => {
  assert.equal(approvalLabel({ kind: 'approved', decisionId: 'x' }), 'Plan approved');
  assert.equal(approvalLabel({ kind: 'changes-requested' }), 'Changes requested');
  assert.equal(approvalLabel({ kind: 'changed-since-approval', decisionId: 'x' }), 'Changed since approval');
  assert.equal(approvalLabel({ kind: 'none' }), 'Not reviewed');
});
