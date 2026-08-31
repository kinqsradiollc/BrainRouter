import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  blockGoal,
  clearGoal,
  completeGoal,
  setGoal,
} from '../goal/store/goalStore.js';
import { normalizeTurnCompletionAnswer } from '../agent/runtime/completionPhase.js';

function withWorkspace(run: (workspaceRoot: string) => void): void {
  const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'brainrouter-completion-phase-'));
  try {
    run(workspaceRoot);
  } finally {
    fs.rmSync(workspaceRoot, { recursive: true, force: true });
  }
}

test('completion phase preserves a non-empty model answer', () => {
  const result = normalizeTurnCompletionAnswer({
    answer: 'Finished with evidence.',
    exitedCleanly: true,
    maxLoops: 30,
    toolCallCount: 2,
    workspaceRoot: '/unused',
  });

  assert.deepEqual(result, {
    answer: 'Finished with evidence.',
    hitLoopLimit: false,
  });
});

test('completion phase reports the bounded-loop ceiling', () => {
  const result = normalizeTurnCompletionAnswer({
    answer: 'Partial response',
    exitedCleanly: false,
    maxLoops: 30,
    toolCallCount: 30,
    workspaceRoot: '/unused',
  });

  assert.equal(result.hitLoopLimit, true);
  assert.match(result.answer, /hard tool-call budget ceiling \(30\)/);
  // ADR-052 D1c — the work done before the budget was hit is PRESERVED and
  // marked partial, not discarded for a bare ceiling notice.
  assert.match(result.answer, /Partial response/, 'the actual work is kept');
  assert.match(result.answer, /⚠️ PARTIAL/, 'and flagged partial');
});

test('a budget-hit turn with no answer falls back to just the ceiling notice', () => {
  const result = normalizeTurnCompletionAnswer({
    answer: '   ',
    exitedCleanly: false,
    maxLoops: 12,
    toolCallCount: 12,
    workspaceRoot: '/unused',
  });
  assert.equal(result.hitLoopLimit, true);
  assert.match(result.answer, /hard tool-call budget ceiling \(12\)/);
  assert.ok(!result.answer.includes('⚠️ PARTIAL'), 'no partial banner when there is no work to preserve');
});

test('completion phase surfaces recorded goal completion proof', () => {
  withWorkspace((workspaceRoot) => {
    const sessionKey = 'completion-proof';
    setGoal(workspaceRoot, 'Finish the change', sessionKey);
    completeGoal(workspaceRoot, sessionKey, 'Focused fixtures passed.');

    const result = normalizeTurnCompletionAnswer({
      answer: '',
      exitedCleanly: true,
      maxLoops: 30,
      goalTransition: 'complete',
      toolCallCount: 1,
      workspaceRoot,
      sessionKey,
    });

    assert.equal(result.hitLoopLimit, false);
    assert.match(result.answer, /^Goal completed after 1 tool call,/);
    assert.match(result.answer, /Recorded proof:\nFocused fixtures passed\./);
    clearGoal(workspaceRoot, sessionKey);
  });
});

test('completion phase surfaces recorded goal blockage reason', () => {
  withWorkspace((workspaceRoot) => {
    const sessionKey = 'completion-blocked';
    setGoal(workspaceRoot, 'Finish the change', sessionKey);
    blockGoal(workspaceRoot, sessionKey, 'Required authority is missing.');

    const result = normalizeTurnCompletionAnswer({
      answer: '   ',
      exitedCleanly: true,
      maxLoops: 30,
      goalTransition: 'blocked',
      toolCallCount: 2,
      workspaceRoot,
      sessionKey,
    });

    assert.match(result.answer, /^Goal blocked after 2 tool calls,/);
    assert.match(result.answer, /Recorded reason:\nRequired authority is missing\./);
    clearGoal(workspaceRoot, sessionKey);
  });
});

test('completion phase distinguishes empty answers with and without tool work', () => {
  const afterTools = normalizeTurnCompletionAnswer({
    answer: '',
    exitedCleanly: true,
    maxLoops: 30,
    toolCallCount: 3,
    workspaceRoot: '/unused',
  });
  const withoutTools = normalizeTurnCompletionAnswer({
    answer: '',
    exitedCleanly: true,
    maxLoops: 30,
    toolCallCount: 0,
    workspaceRoot: '/unused',
  });

  assert.equal(
    afterTools.answer,
    'Tool calls completed (3) and the model returned no additional commentary.',
  );
  assert.equal(withoutTools.answer, 'The model returned an empty response.');
});
