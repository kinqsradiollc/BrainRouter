/**
 * ADR-040 A40-2 — the Core goal supervisor.
 *
 * The supervisor records the CONTENT-FREE continuation reason between turns, so
 * the CLI and Desktop show one continuation history instead of each inventing
 * its own. These pin the reason-code mapping (both hosts derive the same code
 * from the same decision) and the bounded, goal-scoped ledger.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  goalContinuationReasonCode,
  recordGoalContinuation,
  readGoalContinuationLedger,
  goalContinuationHistory,
  GOAL_SUPERVISOR_MAX_RECORDS,
} from '../goal/supervisor/goalSupervisor.js';

function tmpWs(): string { return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'br-goalsup-'))); }

test('the reason code is a content-free derivation of the shared decision', () => {
  // Mutation-proof: change any arm and one of these mismatches.
  assert.equal(goalContinuationReasonCode({ kind: 'continue', corrective: false, nextIteration: 1 }), 'progress');
  assert.equal(goalContinuationReasonCode({ kind: 'continue', corrective: true, nextIteration: 1 }), 'corrective-retry');
  assert.equal(goalContinuationReasonCode({ kind: 'halt-prose' }), 'prose-halt');
  assert.equal(goalContinuationReasonCode({ kind: 'usage-limited', reason: 'Token budget reached: 10 of 10 used.' }), 'token-budget');
  assert.equal(goalContinuationReasonCode({ kind: 'usage-limited', reason: 'Iteration budget exhausted (5/5).' }), 'iteration-budget');
  assert.equal(goalContinuationReasonCode({ kind: 'stop' }), 'stopped');
});

test('the supervisor records each turn under its goal instance, and reads it back in order', () => {
  const ws = tmpWs();
  const goalId = 'sess:2026-08-16T00:00:00.000Z';
  recordGoalContinuation(ws, 'sess', { goalId, decision: { kind: 'continue', corrective: false, nextIteration: 1 }, at: '2026-08-16T00:00:01.000Z' });
  recordGoalContinuation(ws, 'sess', { goalId, decision: { kind: 'continue', corrective: true, nextIteration: 2 }, at: '2026-08-16T00:00:02.000Z' });
  recordGoalContinuation(ws, 'sess', { goalId, decision: { kind: 'halt-prose' }, at: '2026-08-16T00:00:03.000Z' });
  const ledger = readGoalContinuationLedger(ws, 'sess');
  assert.deepEqual(ledger.map((r) => r.reasonCode), ['progress', 'corrective-retry', 'prose-halt']);
});

test('the history is scoped to one goal instance — a new goal starts a fresh sequence', () => {
  const ws = tmpWs();
  recordGoalContinuation(ws, 'sess', { goalId: 'sess:g1', decision: { kind: 'continue', corrective: false, nextIteration: 1 }, at: 'a' });
  recordGoalContinuation(ws, 'sess', { goalId: 'sess:g2', decision: { kind: 'stop' }, at: 'b' });
  assert.equal(goalContinuationHistory(ws, 'sess', 'sess:g1').length, 1);
  assert.equal(goalContinuationHistory(ws, 'sess', 'sess:g2').length, 1);
  assert.deepEqual(goalContinuationHistory(ws, 'sess', 'sess:g1').map((r) => r.reasonCode), ['progress']);
});

test('the ledger is bounded — it never grows into a transcript', () => {
  const ws = tmpWs();
  for (let i = 0; i < GOAL_SUPERVISOR_MAX_RECORDS + 40; i += 1) {
    recordGoalContinuation(ws, 'sess', { goalId: 'sess:g', decision: { kind: 'continue', corrective: false, nextIteration: i }, at: String(i) });
  }
  assert.equal(readGoalContinuationLedger(ws, 'sess').length, GOAL_SUPERVISOR_MAX_RECORDS);
});

test('a missing ledger reads as empty, never throws', () => {
  assert.deepEqual(readGoalContinuationLedger(tmpWs(), 'never-written'), []);
});
