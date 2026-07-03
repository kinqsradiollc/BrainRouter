import test from 'node:test';
import assert from 'node:assert/strict';
import {
  shouldNudgeTaskTracking,
  buildTaskTrackingNudge,
  TASK_NUDGE_TOOLCALL_THRESHOLD,
} from '../agent/guards/taskTrackingNudge.js';

test('shouldNudgeTaskTracking: multi-step + no plan + not yet nudged → true', () => {
  assert.equal(shouldNudgeTaskTracking({
    toolCallsThisTurn: TASK_NUDGE_TOOLCALL_THRESHOLD,
    planItemCount: 0,
    alreadyNudged: false,
    silent: false,
  }), true);
});

test('shouldNudgeTaskTracking: suppressed when a plan already exists', () => {
  assert.equal(shouldNudgeTaskTracking({ toolCallsThisTurn: 10, planItemCount: 3, alreadyNudged: false, silent: false }), false);
});

test('shouldNudgeTaskTracking: suppressed once already nudged this session', () => {
  assert.equal(shouldNudgeTaskTracking({ toolCallsThisTurn: 10, planItemCount: 0, alreadyNudged: true, silent: false }), false);
});

test('shouldNudgeTaskTracking: suppressed below the multi-step threshold', () => {
  assert.equal(shouldNudgeTaskTracking({ toolCallsThisTurn: TASK_NUDGE_TOOLCALL_THRESHOLD - 1, planItemCount: 0, alreadyNudged: false, silent: false }), false);
});

test('shouldNudgeTaskTracking: child agents (silent) never get the harness nudge', () => {
  assert.equal(shouldNudgeTaskTracking({ toolCallsThisTurn: 20, planItemCount: 0, alreadyNudged: false, silent: true }), false);
});

test('buildTaskTrackingNudge: names update_plan and the one-in_progress rule', () => {
  const m = buildTaskTrackingNudge(7);
  assert.match(m, /7 tool calls/);
  assert.match(m, /update_plan/);
  assert.match(m, /in_progress/);
  assert.match(m, /one-time reminder/);
});
