/**
 * ADR-027 D1 (P9-2) — cognitive-debt mechanisms.
 *
 * The counter-intuitive claim these defend: asking more often produces LESS
 * oversight, not more. Past a threshold each prompt is worth less attention
 * than the last, so batching reversible work is a safety measure rather than a
 * convenience — and burying an irreversible action inside such a batch is the
 * one thing that must never happen.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  groupIntoDecisions,
  confirmationStyleFor,
  describeOversight,
  CONFIRMATION_STYLES,
  type ProposedAction,
} from '../debt/decisionGating.js';

const act = (id: string, over: Partial<ProposedAction> = {}): ProposedAction => ({
  id, description: `do ${id}`, reversible: true, ...over,
});

test('reversible work in one unit batches into a single decision', () => {
  const decisions = groupIntoDecisions([
    act('a', { unit: 'auth' }), act('b', { unit: 'auth' }), act('c', { unit: 'auth' }),
  ]);
  assert.equal(decisions.length, 1);
  assert.equal(decisions[0]!.actions.length, 3);
  assert.equal(decisions[0]!.consequential, false);
});

test('separate units stay separate decisions', () => {
  const decisions = groupIntoDecisions([act('a', { unit: 'auth' }), act('b', { unit: 'ui' })]);
  assert.equal(decisions.length, 2);
});

test('an irreversible action is NEVER batched with reversible work', () => {
  // Burying it inside a batch of safe edits is how a human approves it without
  // seeing it — worse than not asking, because it manufactures a record of
  // consent that did not happen.
  const decisions = groupIntoDecisions([
    act('edit1', { unit: 'auth' }),
    act('delete', { unit: 'auth', reversible: false }),
    act('edit2', { unit: 'auth' }),
  ]);
  const risky = decisions.filter((d) => d.consequential);
  assert.equal(risky.length, 1);
  assert.deepEqual(risky[0]!.actions.map((a) => a.id), ['delete']);
  assert.ok(!decisions.some((d) => !d.consequential && d.actions.some((a) => a.id === 'delete')));
});

test('an outward-facing action is consequential even when reversible', () => {
  // Gating is on consequence, not on whether an undo exists locally: a sent
  // message is out in the world regardless.
  const decisions = groupIntoDecisions([act('post', { reversible: true, outward: true })]);
  assert.equal(decisions[0]!.consequential, true);
});

test('gating is on irreversibility, not on event type', () => {
  // A permission model that prompts for shell commands but not for equivalent
  // state changes through an editor is a superstition about mechanism.
  const viaShell = act('rm', { reversible: false, description: 'run rm -rf' });
  const viaEditor = act('wipe', { reversible: false, description: 'empty the file in the editor' });
  const decisions = groupIntoDecisions([viaShell, viaEditor]);
  assert.equal(decisions.filter((d) => d.consequential).length, 2, 'both gate identically');
});

test('reversible batches merge toward the decision budget', () => {
  const actions = Array.from({ length: 20 }, (_, i) => act(`a${i}`, { unit: `unit${i}` }));
  const decisions = groupIntoDecisions(actions, { targetDecisions: 5 });
  assert.ok(decisions.length <= 5, `expected ≤5, got ${decisions.length}`);
  const total = decisions.reduce((sum, d) => sum + d.actions.length, 0);
  assert.equal(total, 20, 'merging must not lose an action');
});

test('consequential decisions are never merged away to hit the budget', () => {
  // The budget guides routine work; it is not a licence to hide risk.
  const actions = [
    ...Array.from({ length: 5 }, (_, i) => act(`r${i}`, { unit: `u${i}` })),
    ...Array.from({ length: 4 }, (_, i) => act(`x${i}`, { reversible: false })),
  ];
  const decisions = groupIntoDecisions(actions, { targetDecisions: 2 });
  assert.equal(decisions.filter((d) => d.consequential).length, 4, 'all four still asked about');
});

test('consecutive high-stakes prompts differ in presentation', () => {
  // Identical dialogs are optimised for habituation. A user who has clicked the
  // same button forty times is not reading the forty-first.
  const seen = [0, 1, 2, 3].map(confirmationStyleFor);
  assert.equal(new Set(seen).size, CONFIRMATION_STYLES.length, 'the cycle covers every style');
  for (let i = 1; i < seen.length; i++) {
    assert.notEqual(seen[i], seen[i - 1], 'no two in a row are the same');
  }
});

test('style selection is deterministic, not random', () => {
  // A session must be reproducible: randomness makes "which dialog did they
  // see?" unanswerable after the fact.
  assert.equal(confirmationStyleFor(7), confirmationStyleFor(7));
  assert.equal(confirmationStyleFor(0), confirmationStyleFor(CONFIRMATION_STYLES.length));
  assert.equal(confirmationStyleFor(-1), confirmationStyleFor(1), 'negatives do not throw');
});

test('oversight is reported as a balance, not a backlog', () => {
  // D1 rejects a "what you have not reviewed" feed outright. A number the user
  // is scolded with gets dismissed, and a dismissed number measures nothing.
  const text = describeOversight({ decisionsTaken: 8, confirmed: 2, batchedActions: 31 })!;
  assert.match(text, /8 decision/);
  assert.match(text, /2 irreversible, confirmed by you/);
  assert.match(text, /31 reversible change\(s\) batched/);
  assert.doesNotMatch(text, /unreviewed|not reviewed|should|warning/i);
});

test('nothing to report produces no message', () => {
  assert.equal(describeOversight({ decisionsTaken: 0, confirmed: 0, batchedActions: 0 }), null);
});

test('every action ends up in exactly one decision', () => {
  const actions = [
    act('a', { unit: 'x' }), act('b', { unit: 'y' }),
    act('c', { reversible: false }), act('d', { outward: true }),
  ];
  const decisions = groupIntoDecisions(actions);
  const ids = decisions.flatMap((d) => d.actions.map((a) => a.id)).sort();
  assert.deepEqual(ids, ['a', 'b', 'c', 'd']);
});

test('an empty proposal produces no decisions', () => {
  assert.deepEqual(groupIntoDecisions([]), []);
});
